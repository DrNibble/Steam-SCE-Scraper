import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DB_PATH = path.resolve(__dirname, '..', process.env.DATABASE_PATH || '../data/es_cache.sqlite');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Detecte le module SQLite disponible:
// - node:sqlite (Node 22.5+, module integre, pas de compilation native)
// - better-sqlite3 (fallback pour Node < 22.5)
let DatabaseImpl;
let usingNodeSQLite = false;
try {
    const sqliteModule = await import('node:sqlite');
    DatabaseImpl = sqliteModule.DatabaseSync;
    usingNodeSQLite = true;
} catch {
    const betterSqlite = await import('better-sqlite3');
    DatabaseImpl = betterSqlite.default;
}

const db = new DatabaseImpl(DB_PATH);
// node:sqlite utilise exec() pour les PRAGMA, better-sqlite3 utilise pragma()
if (usingNodeSQLite) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    // Polyfill: node:sqlite (DatabaseSync) n'a pas de methode transaction(),
    // contrairement a better-sqlite3. On ajoute un equivalent.
    // db.transaction(fn) retourne une fonction qui execute fn dans une transaction:
    // BEGIN -> fn() -> COMMIT (ou ROLLBACK si erreur).
    db.transaction = function(fn) {
        return function(...args) {
            db.exec('BEGIN TRANSACTION');
            try {
                const result = fn.apply(this, args);
                db.exec('COMMIT');
                return result;
            } catch (err) {
                try { db.exec('ROLLBACK'); } catch { /* ignore */ }
                throw err;
            }
        };
    };
} else {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS games (
    appid                          TEXT PRIMARY KEY,
    gamename                       TEXT,
    disabled                       INTEGER DEFAULT 0,
    fetched_at                     INTEGER,
    lasttrade                      INTEGER,
    set_cards                      INTEGER,
    total_owned_qty                INTEGER DEFAULT 0,
    is_completable_via_trade       INTEGER DEFAULT 0,
    is_completable_via_sce         INTEGER DEFAULT 0,
    is_completable_via_sce_wobudget INTEGER DEFAULT 0,
    is_completable_via_sce_doublon INTEGER DEFAULT 0,
    has_expensive_card_json        TEXT,
    total_cost_sce                 INTEGER DEFAULT 0,
    missing_count                  INTEGER DEFAULT 0,
    badge_crafted                  INTEGER,         -- NULL = pas encore verifie, 0 = pas de badge, 1 = badge deja genere
    badge_crafted_fetched_at       INTEGER,          -- date du dernier check gamecards (cache anti rate-limit)
    owner                          TEXT              -- liste des profile links possedant ce jeu (separes par des virgules)
);

CREATE TABLE IF NOT EXISTS cards (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    appid                     TEXT NOT NULL,
    name                      TEXT,
    card_index                INTEGER,
    qty                       INTEGER DEFAULT 0,
    hash                      TEXT,
    icon_url                  TEXT,
    art_url                   TEXT,
    inv_json                  TEXT,
    sce_stock                 INTEGER DEFAULT 0,
    sce_worth                 INTEGER DEFAULT 0,
    sce_price                 INTEGER DEFAULT 0,
    sce_market_price_usd      REAL DEFAULT 0,
    steam_market_price_eur    REAL,
    steam_market_last_sale_price_eur REAL,
    steam_market_sales_7d      INTEGER DEFAULT 0,
    steam_market_fetched_at    INTEGER,
    steam_market_sell_price_eur REAL,
    steam_market_sell_qty      INTEGER,
    steam_market_buy_order_eur REAL,
    steam_market_buy_order_qty INTEGER,
    sce_quick_trade            TEXT,             -- lien de trade rapide SCE (href du bouton btn-primary)
    owner                      TEXT,             -- liste des profile links possedant cette carte (separes par des virgules)
    qty_by_profile             TEXT,             -- JSON: { "profilelink1": 3, "profilelink2": 0 }
    UNIQUE(appid, hash),
    FOREIGN KEY(appid) REFERENCES games(appid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS badge_appids (
    appid     TEXT PRIMARY KEY,
    gamename  TEXT,
    disabled  INTEGER DEFAULT 0,
    fetched_at INTEGER
);
`;

export function initDB() {
    db.exec(SCHEMA);

    // --- Migrations: ajouter les colonnes si elles n'existent pas ---
    const migrations = [
        'ALTER TABLE cards ADD COLUMN steam_market_price_eur REAL',
        'ALTER TABLE cards ADD COLUMN steam_market_last_sale_price_eur REAL',
        'ALTER TABLE cards ADD COLUMN steam_market_sales_7d INTEGER DEFAULT 0',
        'ALTER TABLE cards ADD COLUMN steam_market_fetched_at INTEGER',
        // NULL par defaut : distingue "pas encore verifie" (NULL) de "verifie sans badge" (0)
        'ALTER TABLE games ADD COLUMN badge_crafted INTEGER',
        // Date du dernier check badge_crafted (cache anti rate-limit steam.js)
        'ALTER TABLE games ADD COLUMN badge_crafted_fetched_at INTEGER',
        // Lien de trade rapide SCE (href du bouton btn-primary sur la page inventory)
        'ALTER TABLE cards ADD COLUMN sce_quick_trade TEXT',
        // Sell/buy order columns (deja dans CREATE TABLE mais absentes des anciennes bases)
        'ALTER TABLE cards ADD COLUMN steam_market_sell_price_eur REAL',
        'ALTER TABLE cards ADD COLUMN steam_market_sell_qty INTEGER',
        'ALTER TABLE cards ADD COLUMN steam_market_buy_order_eur REAL',
        'ALTER TABLE cards ADD COLUMN steam_market_buy_order_qty INTEGER',
        // Multi-compte: colonne owner pour tracker quels profils possedent chaque jeu/carte
        'ALTER TABLE games ADD COLUMN owner TEXT',
        'ALTER TABLE cards ADD COLUMN owner TEXT',
        'ALTER TABLE cards ADD COLUMN qty_by_profile TEXT',
    ];
    for (const sql of migrations) {
        try { db.exec(sql); } catch { /* colonne deja presente */ }
    }

    const backend = usingNodeSQLite ? 'node:sqlite' : 'better-sqlite3';
    console.log(`[DB] Base initialisee: ${DB_PATH} (backend: ${backend})`);
    return db;
}

export function getDB() {
    return db;
}

// --- META helpers ---
export function getMeta(key, defaultValue = null) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
}

export function setMeta(key, value) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// --- GAME helpers ---
// Convertit une ligne DB (snake_case) ou un objet domaine (camelCase) en parametres DB normalises
function normalizeGameData(data) {
    return {
        gamename: data.gamename ?? null,
        disabled: data.disabled ? 1 : 0,
        fetched_at: data.fetchedAt ?? data.fetched_at ?? null,
        lasttrade: data.lasttrade ?? data.lasttrade ?? null,
        set_cards: data.setCards ?? data.set_cards ?? null,
        total_owned_qty: data.totalOwnedQty ?? data.total_owned_qty ?? 0,
        is_completable_via_trade: (data.isCompletableViaTrade ?? data.is_completable_via_trade) ? 1 : 0,
        is_completable_via_sce: (data.isCompletableViaSCE ?? data.is_completable_via_sce) ? 1 : 0,
        is_completable_via_sce_wobudget: (data.isCompletableviaSCEwobudget ?? data.is_completable_via_sce_wobudget) ? 1 : 0,
        is_completable_via_sce_doublon: (data.isCompletableviaSCEdoublon ?? data.is_completable_via_sce_doublon) ? 1 : 0,
        has_expensive_card_json: (() => {
            if (data.hasExpensiveCard) return JSON.stringify(data.hasExpensiveCard);
            if (data.has_expensive_card_json) return data.has_expensive_card_json;
            return null;
        })(),
        total_cost_sce: data.totalCostSCE ?? data.total_cost_sce ?? 0,
        missing_count: data.missingCount ?? data.missing_count ?? 0,
    };
}

export function upsertGame(appid, data) {
    const n = normalizeGameData(data);
    db.prepare(`
        INSERT INTO games (appid, gamename, disabled, fetched_at, lasttrade, set_cards, total_owned_qty,
            is_completable_via_trade, is_completable_via_sce, is_completable_via_sce_wobudget,
            is_completable_via_sce_doublon, has_expensive_card_json, total_cost_sce, missing_count)
        VALUES (@appid, @gamename, @disabled, @fetched_at, @lasttrade, @set_cards, @total_owned_qty,
            @is_completable_via_trade, @is_completable_via_sce, @is_completable_via_sce_wobudget,
            @is_completable_via_sce_doublon, @has_expensive_card_json, @total_cost_sce, @missing_count)
        ON CONFLICT(appid) DO UPDATE SET
            gamename=COALESCE(@gamename, gamename), disabled=@disabled, fetched_at=COALESCE(@fetched_at, fetched_at),
            lasttrade=COALESCE(@lasttrade, lasttrade), set_cards=COALESCE(@set_cards, set_cards),
            total_owned_qty=@total_owned_qty,
            is_completable_via_trade=@is_completable_via_trade,
            is_completable_via_sce=@is_completable_via_sce,
            is_completable_via_sce_wobudget=@is_completable_via_sce_wobudget,
            is_completable_via_sce_doublon=@is_completable_via_sce_doublon,
            has_expensive_card_json=@has_expensive_card_json,
            total_cost_sce=@total_cost_sce,
            missing_count=@missing_count
    `).run({
        appid: String(appid),
        ...n,
    });
}

export function getGame(appid) {
    return db.prepare('SELECT * FROM games WHERE appid = ?').get(String(appid));
}

export function getAllGames() {
    return db.prepare('SELECT * FROM games ORDER BY appid').all();
}

export function countGames() {
    return db.prepare('SELECT COUNT(*) as count FROM games').get().count;
}

export function isDBEmpty() {
    return countGames() === 0;
}

export function getGamesWithCards() {
    return db.prepare('SELECT * FROM games WHERE disabled = 0 ORDER BY appid').all();
}

/**
 * Met a jour le statut "badge deja genere" d un jeu + la date du check
 * (badge_crafted_fetched_at sert de cache anti rate-limit pour
 * fetchBadgeCrafted : un badge_crafted = 1 n est pas re-checke par les
 * scans automatiques, seulement via force)
 * @param {string} appid
 * @param {boolean} crafted - true si le badge a ete crafte par le profil
 */
export function setGameBadgeCrafted(appid, crafted) {
    db.prepare('UPDATE games SET badge_crafted = ?, badge_crafted_fetched_at = ? WHERE appid = ?')
        .run(crafted ? 1 : 0, Date.now(), String(appid));
}

// --- OWNER helpers (multi-compte) ---

import { addOwner, removeOwner } from './utils.js';

/**
 * Ajoute un profile link a la liste d owners d un jeu (appid).
 * Accumule sans doublons: "my" + "profiles/123" -> "my,profiles/123".
 * @param {string} appid
 * @param {string} owner - profile link a ajouter
 */
export function addOwnerToGame(appid, owner) {
    const row = db.prepare('SELECT owner FROM games WHERE appid = ?').get(String(appid));
    if (!row) return;
    const newOwner = addOwner(row.owner, owner);
    db.prepare('UPDATE games SET owner = ? WHERE appid = ?').run(newOwner, String(appid));
}

/**
 * Ajoute un profile link a la liste d owners d une carte.
 * @param {string} appid
 * @param {string} hash - market_hash_name de la carte
 * @param {string} owner - profile link a ajouter
 */
export function addOwnerToCard(appid, hash, owner) {
    const row = db.prepare('SELECT owner FROM cards WHERE appid = ? AND hash = ?').get(String(appid), hash);
    if (!row) return;
    const newOwner = addOwner(row.owner, owner);
    db.prepare('UPDATE cards SET owner = ? WHERE appid = ? AND hash = ?').run(newOwner, String(appid), hash);
}

/**
 * Retire un profile link de la liste d owners d un jeu.
 * @param {string} appid
 * @param {string} owner - profile link a retirer
 */
export function removeOwnerFromGame(appid, owner) {
    const row = db.prepare('SELECT owner FROM games WHERE appid = ?').get(String(appid));
    if (!row) return;
    const newOwner = removeOwner(row.owner, owner);
    db.prepare('UPDATE games SET owner = ? WHERE appid = ?').run(newOwner, String(appid));
}

/**
 * Retourne tous les jeux ou un profile link figure dans owner.
 * @param {string} owner - profile link a chercher
 * @returns {Array} - tableau de {appid, owner}
 */
export function getGamesWithOwner(owner) {
    return db.prepare("SELECT appid, owner FROM games WHERE owner IS NOT NULL AND owner != '' AND (',' || owner || ',') LIKE ?")
        .all(`%,${owner},%`);
}

// --- CARD helpers ---
export function upsertCards(appid, cards) {
    // Avant de supprimer/reinserer, on sauvegarde les prix marche Steam existants
    // et l owner (multi-compte) pour ne pas les perdre
    const existingData = {};
    const existingRows = db.prepare('SELECT hash, steam_market_price_eur, steam_market_last_sale_price_eur, steam_market_sales_7d, steam_market_fetched_at, steam_market_sell_price_eur, steam_market_sell_qty, steam_market_buy_order_eur, steam_market_buy_order_qty, owner, qty_by_profile FROM cards WHERE appid = ?').all(String(appid));
    for (const row of existingRows) {
        if (row.hash) {
            existingData[row.hash] = {
                price: row.steam_market_price_eur,
                lastSalePrice: row.steam_market_last_sale_price_eur,
                sales: row.steam_market_sales_7d,
                fetchedAt: row.steam_market_fetched_at,
                sellPriceEur: row.steam_market_sell_price_eur,
                sellQty: row.steam_market_sell_qty,
                buyOrderEur: row.steam_market_buy_order_eur,
                buyOrderQty: row.steam_market_buy_order_qty,
                owner: row.owner,
                qtyByProfile: row.qty_by_profile,
            };
        }
    }

    const stmt = db.prepare(`
        INSERT INTO cards (appid, name, card_index, qty, hash, icon_url, art_url, inv_json,
            sce_stock, sce_worth, sce_price, sce_market_price_usd,
            steam_market_price_eur, steam_market_last_sale_price_eur, steam_market_sales_7d, steam_market_fetched_at,
            steam_market_sell_price_eur, steam_market_sell_qty, steam_market_buy_order_eur, steam_market_buy_order_qty,
            sce_quick_trade, owner, qty_by_profile)
        VALUES (@appid, @name, @card_index, @qty, @hash, @icon_url, @art_url, @inv_json,
            @sce_stock, @sce_worth, @sce_price, @sce_market_price_usd,
            @steam_market_price_eur, @steam_market_last_sale_price_eur, @steam_market_sales_7d, @steam_market_fetched_at,
            @steam_market_sell_price_eur, @steam_market_sell_qty, @steam_market_buy_order_eur, @steam_market_buy_order_qty,
            @sce_quick_trade, @owner, @qty_by_profile)
        ON CONFLICT(appid, hash) DO UPDATE SET
            name=@name, card_index=@card_index, qty=@qty, icon_url=@icon_url, art_url=@art_url,
            inv_json=@inv_json, sce_stock=@sce_stock, sce_worth=@sce_worth, sce_price=@sce_price,
            sce_market_price_usd=@sce_market_price_usd,
            steam_market_price_eur=COALESCE(@steam_market_price_eur, steam_market_price_eur),
            steam_market_last_sale_price_eur=COALESCE(@steam_market_last_sale_price_eur, steam_market_last_sale_price_eur),
            steam_market_sales_7d=COALESCE(@steam_market_sales_7d, steam_market_sales_7d),
            steam_market_fetched_at=COALESCE(@steam_market_fetched_at, steam_market_fetched_at),
            steam_market_sell_price_eur=COALESCE(@steam_market_sell_price_eur, steam_market_sell_price_eur),
            steam_market_sell_qty=COALESCE(@steam_market_sell_qty, steam_market_sell_qty),
            steam_market_buy_order_eur=COALESCE(@steam_market_buy_order_eur, steam_market_buy_order_eur),
            steam_market_buy_order_qty=COALESCE(@steam_market_buy_order_qty, steam_market_buy_order_qty),
            sce_quick_trade=@sce_quick_trade,
            owner=@owner,
            qty_by_profile=@qty_by_profile
    `);

    const deleteStmt = db.prepare('DELETE FROM cards WHERE appid = ?');

    const transaction = db.transaction((appidStr, cardsArr) => {
        deleteStmt.run(appidStr);
        for (const card of cardsArr) {
            // Recupere les prix marche existants ou utilise ceux fournis dans l'objet carte
            const hash = card.hash || null;
            const existing = hash ? existingData[hash] : null;
            const cardPrice = card.steamMarketPriceEur ?? card.steam_market_price_eur ?? null;
            const cardLastSalePrice = card.steamMarketLastSalePriceEur ?? card.steam_market_last_sale_price_eur ?? null;
            const cardSales = card.steamMarketSales7d ?? card.steam_market_sales_7d ?? null;
            const cardFetchedAt = card.steamMarketFetchedAt ?? card.steam_market_fetched_at ?? null;
            const cardSellPrice = card.steamMarketSellPriceEur ?? card.steam_market_sell_price_eur ?? null;
            const cardSellQty = card.steamMarketSellQty ?? card.steam_market_sell_qty ?? null;
            const cardBuyOrderEur = card.steamMarketBuyOrderEur ?? card.steam_market_buy_order_eur ?? null;
            const cardBuyOrderQty = card.steamMarketBuyOrderQty ?? card.steam_market_buy_order_qty ?? null;

            stmt.run({
                appid: appidStr,
                name: card.name || null,
                card_index: card.index ?? null,
                qty: card.qty || 0,
                hash: hash,
                icon_url: card.iconUrl || null,
                art_url: card.artUrl || null,
                inv_json: card.inv ? JSON.stringify(card.inv) : '[]',
                sce_stock: card['sce stock'] || 0,
                sce_worth: card['sce worth'] || 0,
                sce_price: card['sce price'] || 0,
                sce_market_price_usd: card['sce marketPriceUSD'] || 0,
                // Preserve existing market prices if not provided in card object
                steam_market_price_eur: cardPrice ?? existing?.price ?? null,
                steam_market_last_sale_price_eur: cardLastSalePrice ?? existing?.lastSalePrice ?? null,
                steam_market_sales_7d: cardSales ?? existing?.sales ?? 0,
                steam_market_fetched_at: cardFetchedAt ?? existing?.fetchedAt ?? null,
                steam_market_sell_price_eur: cardSellPrice ?? existing?.sellPriceEur ?? null,
                steam_market_sell_qty: cardSellQty ?? existing?.sellQty ?? null,
                steam_market_buy_order_eur: cardBuyOrderEur ?? existing?.buyOrderEur ?? null,
                steam_market_buy_order_qty: cardBuyOrderQty ?? existing?.buyOrderQty ?? null,
                sce_quick_trade: card['sce quick-trade'] || null,
                owner: card.owner ?? existing?.owner ?? null,
                qty_by_profile: card.qtyByProfile ? JSON.stringify(card.qtyByProfile) : (existing?.qtyByProfile ?? null),
            });
        }
    });

    transaction(String(appid), cards);
}

export function getCards(appid) {
    return db.prepare('SELECT * FROM cards WHERE appid = ? ORDER BY card_index').all(String(appid));
}

// --- STEAM MARKET PRICE helpers ---
/**
 * Met a jour le prix marche Steam pour une carte donnee
 * @param {string} appid
 * @param {string} hash - market_hash_name de la carte (ex: "664320-Loki (Trading Card)")
 * @param {number|null} priceEur - prix en EUR (null si inconnu)
 * @param {number} sales7d - nombre de ventes dans les 7 derniers jours
 * @param {number|null} [lastSalePriceEur] - prix de la derniere vente dans les 7 jours (null si pas de vente)
 */
export function updateCardMarketPrice(appid, hash, priceEur, sales7d, lastSalePriceEur) {
    const hasLastSalePrice = lastSalePriceEur !== undefined;
    db.prepare(`
        UPDATE cards
        SET steam_market_price_eur = ?,
            steam_market_last_sale_price_eur = CASE WHEN ? THEN ? ELSE steam_market_last_sale_price_eur END,
            steam_market_sales_7d = ?,
            steam_market_fetched_at = ?
        WHERE appid = ? AND hash = ?
    `).run(
        priceEur !== null && priceEur !== undefined ? priceEur : null,
        hasLastSalePrice ? 1 : 0,
        hasLastSalePrice ? (lastSalePriceEur !== null ? lastSalePriceEur : null) : null,
        sales7d || 0,
        Date.now(),
        String(appid),
        hash
    );
}

/**
 * Met a jour les prix marche Steam pour toutes les cartes d'un jeu
 * @param {string} appid
 * @param {Map} priceMap - Map<hash, {priceEur, sales7d, lastSalePriceEur}>
 */
export function updateCardMarketPrices(appid, priceMap) {
    const stmt = db.prepare(`
        UPDATE cards
        SET steam_market_price_eur = ?,
            steam_market_last_sale_price_eur = CASE WHEN ? THEN ? ELSE steam_market_last_sale_price_eur END,
            steam_market_sales_7d = ?,
            steam_market_fetched_at = ?,
            steam_market_sell_price_eur = ?,
            steam_market_sell_qty = ?,
            steam_market_buy_order_eur = ?,
            steam_market_buy_order_qty = ?
        WHERE appid = ? AND hash = ?
    `);
    const transaction = db.transaction((appidStr, map) => {
        const now = Date.now();
        for (const [hash, data] of map) {
            const hasLastSalePrice = Object.prototype.hasOwnProperty.call(data, 'lastSalePriceEur');
            stmt.run(
                data.priceEur !== null && data.priceEur !== undefined ? data.priceEur : null,
                hasLastSalePrice ? 1 : 0,
                hasLastSalePrice ? (data.lastSalePriceEur !== null && data.lastSalePriceEur !== undefined ? data.lastSalePriceEur : null) : null,
                data.sales7d || 0,
                now,
                data.sellPriceEur ?? null,
                data.sellQty ?? null,
                data.buyOrderEur ?? null,
                data.buyOrderQty ?? null,
                appidStr,
                hash
            );
        }
    });
    transaction(String(appid), priceMap);
}

// --- BADGE APPIDS helpers ---
export function upsertBadgeAppid(appid, gamename, disabled = false) {
    db.prepare(`
        INSERT INTO badge_appids (appid, gamename, disabled)
        VALUES (?, ?, ?)
        ON CONFLICT(appid) DO UPDATE SET gamename=excluded.gamename, disabled=excluded.disabled
    `).run(String(appid), gamename || null, disabled ? 1 : 0);
}

export function getAllBadgeAppids() {
    return db.prepare('SELECT * FROM badge_appids ORDER BY appid').all();
}

export function getBadgeAppid(appid) {
    return db.prepare('SELECT * FROM badge_appids WHERE appid = ?').get(String(appid));
}

export function getIncompleteBadgeAppids() {
    return db.prepare(`
        SELECT ba.* FROM badge_appids ba
        LEFT JOIN games g ON ba.appid = g.appid
        WHERE ba.disabled = 0 AND (g.appid IS NULL OR g.fetched_at IS NULL OR g.set_cards IS NULL OR g.set_cards = 0)
    `).all();
}

export function purgeCache() {
    db.prepare('DELETE FROM games').run();
    db.prepare('DELETE FROM cards').run();
    db.prepare('DELETE FROM badge_appids').run();
    db.prepare('DELETE FROM meta').run();
    setMeta('scecredit', '0');
    console.log('[DB] Cache purge.');
}

// Initialise automatiquement au chargement du module
initDB();

export default db;
