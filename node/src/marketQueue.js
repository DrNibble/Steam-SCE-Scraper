/**
 * marketQueue.js — Worker de marché temps réel avec token bucket adaptatif
 *
 * Architecture :
 *   - File d'attente prioritaire dans SQLite (table market_queue)
 *   - Token bucket : rafale de 5 requêtes, puis 1 req/600ms (≈100 req/min)
 *   - Backoff adaptatif sur 429 : cooldown 30s, débit réduit
 *   - Stale-while-revalidate : le front lit le cache, le worker refresh en arrière-plan
 *   - Priorités : les cartes visibles/actives passent en premier
 *
 * Intégration dans Steam-SCE-Scraper :
 *   - Importe depuis utils.js : httpGet, sleep, getSteamCookie, ES_log
 *   - Importe depuis db.js : getDB, updateCardMarketPrice
 *   - Utilise market.js : getOrderbook, getRecentSale
 *
 * Usage dans sync.js ou index.js :
 *
 *   import { startMarketWorker, enqueueMarketRefresh, enqueueGameCards } from './marketQueue.js';
 *
 *   // Démarrer le worker (tourne en arrière-plan)
 *   startMarketWorker();
 *
 *   // Quand syncSteamInventoryHistory détecte un trade sur un appid :
 *   enqueueGameCards(appid, 80);  // priorité 80
 *
 *   // Quand le front PHP demande une carte :
 *   enqueueMarketRefresh(appid, hash, 100);  // priorité max
 *
 *   // Le worker traite la queue en continu avec token bucket
 *
 * Taux de requête :
 *   - Normal : 1 req / 600ms = 100 req/min (sous la limite Steam ~120/min)
 *   - Après 429 : 1 req / 5s pendant 60s, puis retour progressif au normal
 *   - Bursts autorisés : 5 requêtes rapides, puis refill
 *
 * Pour 100 cartes : ~60s au lieu de 300s (avec délai fixe 3s)
 * Les cartes prioritaires sont refresh en 1-2s
 */

import { getDB } from './db.js';
import { sleep, ES_log } from './utils.js';
import { getOrderbook, getRecentSale, getPriceOverview } from './market.js';

// ═══════════════════════════════════════════════════════════════
// Configuration du token bucket
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
    // Token bucket normal
    BUCKET_CAPACITY: 5,        // max 5 requêtes en rafale
    REFILL_INTERVAL_MS: 600,    // 1 token toutes les 600ms = ~100 req/min

    // Cooldown après 429
    COOLDOWN_MS: 30000,         // 30s de pause après un 429
    COOLDOWN_REFILL_MS: 5000,   // pendant cooldown : 1 req / 5s
    RECOVERY_MS: 60000,         // 60s en mode récupération après cooldown

    // Stale-while-revalidate
    FRESH_MS: 5 * 60 * 1000,    // 5 min : prix "frais"
    STALE_MS: 30 * 60 * 1000,   // 30 min : prix "stale" mais utilisable

    // Queue
    MAX_RETRIES: 3,
    POLL_INTERVAL_MS: 200,      // check la queue toutes les 200ms
};

// Niveaux de priorité
const PRIORITY = {
    VISIBLE: 100,     // cartes affichées dans le front PHP maintenant
    TRADE_RECENT: 80, // cartes d'appids avec trade récent (syncSteamInventoryHistory)
    COMPLETABLE: 60,  // cartes manquantes pour badges complétables
    OLD_PRICE: 30,    // cartes avec prix daté (> 30 min)
    BACKGROUND: 10,   // reste du cache
};


// ═══════════════════════════════════════════════════════════════
// Table market_queue
// ═══════════════════════════════════════════════════════════════

const SCHEMA = `
CREATE TABLE IF NOT EXISTS market_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    appid       TEXT NOT NULL,
    hash        TEXT NOT NULL,
    priority    INTEGER DEFAULT 10,
    status      TEXT DEFAULT 'pending',  -- pending, processing, done, error
    attempts    INTEGER DEFAULT 0,
    error       TEXT,
    enqueued_at INTEGER,
    processed_at INTEGER,
    UNIQUE(appid, hash)
);
`;

let _tableInitialized = false;

/**
 * Initialise la table market_queue si pas déjà fait.
 * Idempotent — appelée par chaque fonction publique.
 */
function ensureQueueTable() {
    if (_tableInitialized) return;
    const db = getDB();
    db.exec(SCHEMA);
    _tableInitialized = true;
}

/**
 * Ajoute les colonnes de marché à la table cards si elles n'existent pas.
 * Idempotent — les ALTER TABLE qui échouent (colonne existe déjà) sont ignorés.
 */
function migrateCardsTable() {
    const db = getDB();
    const newColumns = [
        'steam_market_sell_price_eur REAL',     // Prix de vente le plus bas (EUR)
        'steam_market_sell_qty INTEGER',        // Quantité au prix de vente le plus bas
        'steam_market_buy_order_eur REAL',      // Demande d'achat la plus haute (EUR)
    ];
    for (const col of newColumns) {
        const colName = col.split(' ')[0];
        try {
            db.exec(`ALTER TABLE cards ADD COLUMN ${col}`);
            ES_log(`[MarketQueue] Colonne ${colName} ajoutée à la table cards`);
        } catch (e) {
            // Colonne existe déjà
        }
    }
}

/**
 * Remet les jobs 'processing' en 'pending' au démarrage.
 * À appeler quand le worker démarre pour récupérer d'un crash.
 */
function resetStaleProcessing() {
    const db = getDB();
    const result = db.prepare("UPDATE market_queue SET status = 'pending' WHERE status = 'processing'").run();
    if (result.changes > 0) {
        ES_log(`[MarketQueue] ${result.changes} job(s) 'processing' remis en 'pending'`);
    }
}

// ═══════════════════════════════════════════════════════════════
// Token bucket adaptatif
// ═══════════════════════════════════════════════════════════════

class TokenBucket {
    constructor() {
        this.tokens = CONFIG.BUCKET_CAPACITY;
        this.capacity = CONFIG.BUCKET_CAPACITY;
        this.refillInterval = CONFIG.REFILL_INTERVAL_MS;
        this.lastRefill = Date.now();
        this.cooldownUntil = 0;
        this.recoveryUntil = 0;
    }

    /**
     * Tente de prendre un token. Attend s'il n'y en a pas.
     * Retourne true si un token a été pris, false si en cooldown.
     */
    async take() {
        const now = Date.now();

        // En cooldown (après 429) ?
        if (now < this.cooldownUntil) {
            const remaining = this.cooldownUntil - now;
            ES_log(`[TokenBucket] Cooldown 429 — attente ${Math.ceil(remaining / 1000)}s`);
            await sleep(remaining);
            this.cooldownUntil = 0;
            this.recoveryUntil = now + CONFIG.RECOVERY_MS;
            this.tokens = 1; // 1 seul token pour reprendre doucement
            this.lastRefill = now;
            return true;
        }

        // Refill
        const elapsed = now - this.lastRefill;
        // En mode récupération : débit réduit
        const effectiveInterval = (now < this.recoveryUntil)
            ? CONFIG.COOLDOWN_REFILL_MS
            : this.refillInterval;

        const refilled = Math.floor(elapsed / effectiveInterval);
        if (refilled > 0) {
            this.tokens = Math.min(this.capacity, this.tokens + refilled);
            this.lastRefill = now;
        }

        // Pas de token ? Attendre le prochain refill
        if (this.tokens <= 0) {
            await sleep(effectiveInterval);
            this.tokens = 1;
            this.lastRefill = Date.now();
        }

        this.tokens--;
        return true;
    }

    /**
     * Signale un 429 — déclenche le cooldown
     */
    hitRateLimit() {
        this.cooldownUntil = Date.now() + CONFIG.COOLDOWN_MS;
        this.tokens = 0;
        ES_log(`[TokenBucket] Rate limit détecté — cooldown ${CONFIG.COOLDOWN_MS / 1000}s`);
    }

    /**
     * Signale un succès — récupération progressive
     */
    success() {
        // Si on était en récupération et ça marche, on accélère
        if (Date.now() > this.recoveryUntil) {
            this.recoveryUntil = 0;
        }
    }
}


// ═══════════════════════════════════════════════════════════════
// Queue manager
// ═══════════════════════════════════════════════════════════════

const bucket = new TokenBucket();
let workerRunning = false;

/**
 * Enqueue une carte pour refresh.
 * Si elle est déjà dans la queue, met à jour la priorité (max des deux).
 *
 * @param {string} appid
 * @param {string} hash - market_hash_name
 * @param {number} priority - voir PRIORITY
 */
export function enqueueMarketRefresh(appid, hash, priority = PRIORITY.BACKGROUND) {
    ensureQueueTable();
    const db = getDB();
    db.prepare(`
        INSERT INTO market_queue (appid, hash, priority, status, attempts, enqueued_at)
        VALUES (?, ?, ?, 'pending', 0, ?)
        ON CONFLICT(appid, hash) DO UPDATE SET
            priority = MAX(excluded.priority, market_queue.priority),
            status = 'pending',
            enqueued_at = ?
    `).run(String(appid), hash, priority, Date.now(), Date.now());
}

/**
 * Enqueue toutes les cartes d'un jeu avec une priorité donnée.
 *
 * @param {string} appid
 * @param {number} priority
 */
export function enqueueGameCards(appid, priority = PRIORITY.TRADE_RECENT) {
    ensureQueueTable();
    const db = getDB();
    const cards = db.prepare('SELECT hash FROM cards WHERE appid = ? AND hash IS NOT NULL').all(String(appid));
    for (const card of cards) {
        enqueueMarketRefresh(appid, card.hash, priority);
    }
    ES_log(`[MarketQueue] ${cards.length} cartes enfilées pour appid ${appid} (priorité ${priority})`);
    return cards.length;
}

/**
 * Enqueue les cartes dont le prix est stale (stale-while-revalidate).
 * À appeler périodiquement pour rafraîchir le cache.
 *
 * @param {number} staleAfterMs - âge max avant refresh (défaut 30 min)
 */
export function enqueueStaleCards(staleAfterMs = CONFIG.STALE_MS) {
    ensureQueueTable();
    const db = getDB();
    const cutoff = Date.now() - staleAfterMs;
    const cards = db.prepare(`
        SELECT appid, hash FROM cards
        WHERE hash IS NOT NULL
          AND (steam_market_fetched_at IS NULL OR steam_market_fetched_at < ?)
        ORDER BY steam_market_fetched_at ASC NULLS FIRST
        LIMIT 200
    `).all(cutoff);

    for (const card of cards) {
        enqueueMarketRefresh(card.appid, card.hash, PRIORITY.OLD_PRICE);
    }

    if (cards.length > 0) {
        ES_log(`[MarketQueue] ${cards.length} cartes stale enfilées`);
    }
    return cards.length;
}

/**
 * Récupère la prochaine carte à traiter (plus haute priorité, plus ancienne).
 */
function dequeueNext() {
    const db = getDB();
    return db.prepare(`
        SELECT * FROM market_queue
        WHERE status = 'pending'
        ORDER BY priority DESC, enqueued_at ASC
        LIMIT 1
    `).get();
}


// ═══════════════════════════════════════════════════════════════
// Traitement d'une carte
// ═══════════════════════════════════════════════════════════════

/**
 * Traite une carte : récupère le prix depuis Steam et met à jour la DB.
 *
 * Stratégie pour minimiser les requêtes :
 *   1. pricehistory (1 req) → si vente dans 7j → prix de vente (pas besoin d'orderbook)
 *   2. Si pas de vente → orderbook (1 req) → buy order le plus haut
 *   3. Si pricehistory échoue (cookies invalides) → orderbook seulement
 *
 * Donc : 1 req par carte en moyenne (pricehistory suffit si vente récente),
 *        2 req max si pas de vente.
 */
async function processCard(item) {
    const db = getDB();

    // Marquer comme processing
    db.prepare('UPDATE market_queue SET status = ?, attempts = attempts + 1 WHERE id = ?')
        .run('processing', item.id);

    try {
        const marketHashName = item.hash;

        // Variables à stocker
        let sellPriceEur = null;      // Prix de vente le plus bas (EUR)
        let sellQty = null;          // Quantité au prix de vente le plus bas
        let buyOrderEur = null;      // Demande d'achat la plus haute (EUR)
        let sales7d = 0;              // Volume de vente cumulé sur 7 jours
        let priceEur = null;         // Dernier prix vendu si <7j, sinon buy order

        // Étape 1 : priceoverview — prix de vente EUR (pas d'auth)
        const pov = await getPriceOverview(marketHashName);
        if (pov) {
            sellPriceEur = pov.sellPriceEur;
        }

        // Étape 2 : orderbook — buy order, quantités (pas d'auth, USD)
        const orderbook = await getOrderbook(marketHashName);
        if (orderbook) {
            sellQty = orderbook.sellQtyAtLowest || 0;

            // Convertir le buy order USD → EUR en utilisant le ratio du prix de vente
            if (orderbook.highestBuyOrder) {
                if (sellPriceEur && orderbook.lowestSellOrder) {
                    // Ratio : sellPriceEur / sellPriceUsd = taux de change effectif
                    const exchangeRate = sellPriceEur / orderbook.lowestSellOrder;
                    buyOrderEur = Math.round(orderbook.highestBuyOrder * exchangeRate * 100) / 100;
                } else {
                    // Fallback : taux fixe
                    const USD_TO_EUR = 0.92;
                    buyOrderEur = Math.round(orderbook.highestBuyOrder * USD_TO_EUR * 100) / 100;
                }
            }
        }

        // Étape 3 : pricehistory — volume 7j, dernier prix de vente (auth requise)
        const recentSale = await getRecentSale(marketHashName, 7);
        if (recentSale) {
            sales7d = recentSale.totalVolume || 0;
            // Dernier prix de vente si vente < 7j
            priceEur = recentSale.price;
        }

        // Si pas de vente récente, le prix résolu est le buy order
        if (priceEur === null) {
            priceEur = buyOrderEur;
        }

        ES_log(`[processCard] ${marketHashName} → sell:${sellPriceEur !== null ? sellPriceEur + '€' : 'N/A'} x${sellQty || 0} | buy:${buyOrderEur !== null ? buyOrderEur + '€' : 'N/A'} | 7j:${sales7d} ventes | resolved:${priceEur !== null ? priceEur + '€' : 'N/A'}`);

        // Mettre à jour la DB
        db.prepare(`
            UPDATE cards
            SET steam_market_price_eur = ?,
                steam_market_sales_7d = ?,
                steam_market_sell_price_eur = ?,
                steam_market_sell_qty = ?,
                steam_market_buy_order_eur = ?,
                steam_market_fetched_at = ?
            WHERE appid = ? AND hash = ?
        `).run(
            priceEur,
            sales7d,
            sellPriceEur,
            sellQty,
            buyOrderEur,
            Date.now(),
            String(item.appid),
            marketHashName
        );

        // Marquer comme done
        db.prepare('UPDATE market_queue SET status = ?, processed_at = ? WHERE id = ?')
            .run('done', Date.now(), item.id);

        bucket.success();
        return { success: true, priceEur, sellPriceEur, buyOrderEur, sales7d };

    } catch (err) {
        // Si 429, le token bucket va gérer le cooldown
        if (err.message.includes('429')) {
            bucket.hitRateLimit();
        }

        ES_log(`[processCard] Erreur ${item.hash}: ${err.message}`);

        db.prepare('UPDATE market_queue SET status = ?, error = ? WHERE id = ?')
            .run(item.attempts >= CONFIG.MAX_RETRIES ? 'error' : 'pending', err.message.substring(0, 200), item.id);

        return { success: false, error: err.message };
    }
}


// ═══════════════════════════════════════════════════════════════
// Worker principal
// ═══════════════════════════════════════════════════════════════

/**
 * Démarre le worker de marché en arrière-plan.
 * Traite la queue en continu avec token bucket adaptatif.
 *
 * @param {object} options - { onCardProcessed?: (result) => void }
 * @returns {object} - { stop: () => void, stats: () => object }
 */
export function startMarketWorker(options = {}) {
    if (workerRunning) {
        ES_log('[MarketQueue] Worker déjà en cours');
        return { stop: () => {}, stats: () => ({}) };
    }

    ensureQueueTable();
    migrateCardsTable();
    resetStaleProcessing();
    workerRunning = true;

    let processed = 0;
    let errors = 0;
    let rateLimited = 0;

    (async () => {
        ES_log('[MarketQueue] Worker démarré');

        while (workerRunning) {
            try {
                const next = dequeueNext();

                if (!next) {
                    // Queue vide : attendre
                    await sleep(CONFIG.POLL_INTERVAL_MS);
                    continue;
                }

                // Attendre un token (token bucket)
                await bucket.take();

                // Traiter la carte
                const result = await processCard(next);
                processed++;

                if (!result.success) {
                    errors++;
                    if (result.error && result.error.includes('429')) {
                        rateLimited++;
                    }
                }

                // Callback optionnel
                if (options.onCardProcessed) {
                    options.onCardProcessed({ ...next, ...result, processed, errors });
                }

                // Log périodique
                if (processed % 10 === 0) {
                    ES_log(`[MarketQueue] ${processed} traitées, ${errors} erreurs, ${rateLimited} rate-limited`);
                }

            } catch (err) {
                ES_log(`[MarketQueue] Erreur worker: ${err.message}`);
                await sleep(1000);
            }
        }

        ES_log('[MarketQueue] Worker arrêté');
    })();

    return {
        stop() {
            workerRunning = false;
        },
        stats() {
            return { processed, errors, rateLimited, running: workerRunning };
        },
    };
}


// ═══════════════════════════════════════════════════════════════
// API pour le front PHP / sync.js
// ═══════════════════════════════════════════════════════════════

/**
 * Récupère le prix d'une carte depuis le cache, et enfile un refresh si stale.
 * Pattern stale-while-revalidate.
 *
 * À appeler depuis le front PHP (via un endpoint) ou depuis sync.js.
 *
 * @param {string} appid
 * @param {string} hash
 * @returns {object} - { priceEur, sales7d, fetchedAt, stale, refreshing }
 */
export function getCardPriceCached(appid, hash) {
    ensureQueueTable();
    const db = getDB();
    const card = db.prepare(`
        SELECT steam_market_price_eur, steam_market_sales_7d, steam_market_fetched_at
        FROM cards
        WHERE appid = ? AND hash = ?
    `).get(String(appid), hash);

    if (!card) {
        return { priceEur: null, sales7d: 0, fetchedAt: null, stale: true, refreshing: false };
    }

    const now = Date.now();
    const fetchedAt = card.steam_market_fetched_at || 0;
    const age = now - fetchedAt;

    const isFresh = age < CONFIG.FRESH_MS;
    const isStale = age > CONFIG.STALE_MS;

    // Si stale, enfile un refresh en haute priorité
    if (isStale || fetchedAt === 0) {
        enqueueMarketRefresh(appid, hash, PRIORITY.VISIBLE);
    }

    return {
        priceEur: card.steam_market_price_eur,
        sales7d: card.steam_market_sales_7d || 0,
        fetchedAt: fetchedAt || null,
        ageSeconds: Math.floor(age / 1000),
        stale: isStale,
        refreshing: isStale || fetchedAt === 0,
    };
}

/**
 * Stats de la queue (pour monitoring).
 */
export function getQueueStats() {
    ensureQueueTable();
    const db = getDB();
    try {
        const pending = db.prepare("SELECT COUNT(*) as c FROM market_queue WHERE status = 'pending'").get().c;
        const processing = db.prepare("SELECT COUNT(*) as c FROM market_queue WHERE status = 'processing'").get().c;
        const done = db.prepare("SELECT COUNT(*) as c FROM market_queue WHERE status = 'done'").get().c;
        const error = db.prepare("SELECT COUNT(*) as c FROM market_queue WHERE status = 'error'").get().c;
        return { pending, processing, done, error, total: pending + processing + done + error };
    } catch {
        return { pending: 0, processing: 0, done: 0, error: 0, total: 0 };
    }
}

// Export des priorités pour usage externe
export { PRIORITY, CONFIG };
