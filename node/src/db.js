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
    badge_crafted_owner            TEXT,             -- profile link du compte qui a crafte le badge (multi-compte)
    fetched_at_by_profile          TEXT,             -- JSON: { "my": ts, "profiles/123": ts } timestamp du dernier fetch Steam par profil
    lasttrade_by_profile           TEXT,             -- JSON: { "my": ts, "profiles/123": ts } timestamp du dernier trade par profil
    badge_crafted_by_profile       TEXT,             -- JSON: { "my": 1, "profiles/123": 0 } statut badge crafte par profil
    badge_crafted_fetched_at_by_profile TEXT,       -- JSON: { "my": ts } date du check badge par profil
    missing_count_by_profile       TEXT,             -- JSON: { "my": 3, "profiles/123": 5 } cartes manquantes par profil
    is_completable_via_trade_by_profile TEXT,       -- JSON: { "my": 1, "profiles/123": 0 } completitude via trade par profil
    is_completable_via_sce_by_profile  TEXT,        -- JSON: { "my": 1, "profiles/123": 0 } completitude via SCE par profil
    is_completable_via_sce_doublon_by_profile TEXT, -- JSON: { "my": 1, "profiles/123": 0 } completitude via SCE doublon par profil
    is_completable_via_sce_wobudget_by_profile TEXT,-- JSON: { "my": 1, "profiles/123": 0 } completitude via SCE sans budget par profil
    total_cost_sce_by_profile      TEXT,             -- JSON: { "my": 100, "profiles/123": 200 } cout SCE par profil
    has_expensive_card_by_profile  TEXT,             -- JSON: { "my": {...}, "profiles/123": null } carte chere par profil
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
        // Multi-compte: profile link du compte qui a crafte le badge
        'ALTER TABLE games ADD COLUMN badge_crafted_owner TEXT',
        // Multi-compte: variables par profil (JSON)
        'ALTER TABLE games ADD COLUMN fetched_at_by_profile TEXT',
        'ALTER TABLE games ADD COLUMN lasttrade_by_profile TEXT',
        'ALTER TABLE games ADD COLUMN badge_crafted_by_profile TEXT',
        'ALTER TABLE games ADD COLUMN badge_crafted_fetched_at_by_profile TEXT',
        'ALTER TABLE games ADD COLUMN missing_count_by_profile TEXT',
        'ALTER TABLE games ADD COLUMN is_completable_via_trade_by_profile TEXT',
        'ALTER TABLE games ADD COLUMN is_completable_via_sce_by_profile TEXT',
        'ALTER TABLE games ADD COLUMN is_completable_via_sce_doublon_by_profile TEXT',
        'ALTER TABLE games ADD COLUMN is_completable_via_sce_wobudget_by_profile TEXT',
        'ALTER TABLE games ADD COLUMN total_cost_sce_by_profile TEXT',
        'ALTER TABLE games ADD COLUMN has_expensive_card_by_profile TEXT',
        // Lien de trade rapide SCE (href du bouton btn-primary sur la page inventory)
        'ALTER TABLE cards ADD COLUMN sce_quick_trade TEXT',
        // Sell/buy order columns (deja dans CREATE TABLE mais absentes des anciennes bases)
        'ALTER TABLE cards ADD COLUMN steam_market_sell_price_eur REAL',
        'ALTER TABLE cards ADD COLUMN steam_market_sell_qty INTEGER',
        'ALTER TABLE cards ADD COLUMN steam_market_buy_order_eur REAL',
        'ALTER TABLE cards ADD COLUMN steam_market_buy_order_qty INTEGER',
        // Multi-compte: colonne owner pour tracker quels profils possedent chaque jeu
        'ALTER TABLE games ADD COLUMN owner TEXT',
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
 * + le profile link du compte qui a crafte le badge (multi-compte).
 * (badge_crafted_fetched_at sert de cache anti rate-limit pour
 * fetchBadgeCrafted : un badge_crafted = 1 n est pas re-checke par les
 * scans automatiques, seulement via force)
 * @param {string} appid
 * @param {boolean} crafted - true si le badge a ete crafte par le profil
 * @param {string|null} [owner] - profile link du compte qui a crafte le badge
 */
export function setGameBadgeCrafted(appid, crafted, owner = null) {
    const craftedVal = crafted ? 1 : 0;
    const now = Date.now();
    db.prepare('UPDATE games SET badge_crafted = ?, badge_crafted_fetched_at = ?, badge_crafted_owner = ? WHERE appid = ?')
        .run(craftedVal, now, owner, String(appid));
    // Multi-compte: met a jour aussi les champs par profil
    if (owner) {
        updateGameProfileFields(appid, owner, {
            badge_crafted_by_profile: craftedVal,
            badge_crafted_fetched_at_by_profile: now,
        });
    }
}

// --- PER-PROFILE HELPERS (multi-compte) ---

/**
 * Sanitize un profile link pour usage comme cle meta.
 * "profiles/76561198028880269" -> "profiles_76561198028880269"
 */
function profileMetaKey(profile) {
    return profile.replace(/[/\\]/g, '_');
}

/**
 * Recupere une valeur meta pour un profil specifique.
 * Fallback sur la cle globale si la cle profil n existe pas (migration).
 * @param {string} key - cle meta de base (ex: "lasttrade")
 * @param {string} profile - profile link
 * @param {string} defaultValue - valeur par defaut si non trouve
 * @returns {string}
 */
export function getMetaProfile(key, profile, defaultValue = null) {
    const profileKey = `${key}_${profileMetaKey(profile)}`;
    const profileValue = getMeta(profileKey, null);
    if (profileValue !== null) return profileValue;
    // Fallback: cle globale (backward compat)
    return getMeta(key, defaultValue);
}

/**
 * Definit une valeur meta pour un profil specifique.
 * @param {string} key - cle meta de base (ex: "lasttrade")
 * @param {string} profile - profile link
 * @param {string} value - valeur a stocker
 */
export function setMetaProfile(key, profile, value) {
    const profileKey = `${key}_${profileMetaKey(profile)}`;
    setMeta(profileKey, value);
}

// Liste des colonnes par profil valides (anti-injection SQL)
const VALID_PROFILE_COLUMNS = new Set([
    'fetched_at_by_profile',
    'lasttrade_by_profile',
    'badge_crafted_by_profile',
    'badge_crafted_fetched_at_by_profile',
    'missing_count_by_profile',
    'is_completable_via_trade_by_profile',
    'is_completable_via_sce_by_profile',
    'is_completable_via_sce_doublon_by_profile',
    'is_completable_via_sce_wobudget_by_profile',
    'total_cost_sce_by_profile',
    'has_expensive_card_by_profile',
]);

/**
 * Met a jour plusieurs champs JSON par profil en une seule operation.
 * Lit les valeurs JSON existantes, ajoute/met a jour le profil donne,
 * et ecrit le tout en DB.
 * @param {string} appid
 * @param {string} profile - profile link
 * @param {Object} fields - { column: value, ... } (colonnes par profil)
 */
export function updateGameProfileFields(appid, profile, fields) {
    const columns = Object.keys(fields);
    for (const col of columns) {
        if (!VALID_PROFILE_COLUMNS.has(col)) {
            throw new Error(`updateGameProfileFields: colonne invalide: ${col}`);
        }
    }
    const selectCols = columns.join(', ');
    const row = db.prepare(`SELECT ${selectCols} FROM games WHERE appid = ?`).get(String(appid));
    if (!row) return;
    const setClauses = [];
    const values = [];
    for (const col of columns) {
        let data = {};
        try { data = JSON.parse(row[col] || '{}'); } catch { /* ignore */ }
        data[profile] = fields[col];
        setClauses.push(`${col} = ?`);
        values.push(JSON.stringify(data));
    }
    values.push(String(appid));
    db.prepare(`UPDATE games SET ${setClauses.join(', ')} WHERE appid = ?`).run(...values);
}

/**
 * Ecrit directement l objet JSON complet pour une colonne par profil
 * (utilise par analyzeBadgeStatus qui calcule tous les profils a la fois).
 * @param {string} appid
 * @param {Object} fields - { column: fullJSONObject, ... }
 */
export function setGameProfileJSON(appid, fields) {
    const columns = Object.keys(fields);
    const setClauses = [];
    const values = [];
    for (const col of columns) {
        if (!VALID_PROFILE_COLUMNS.has(col)) {
            throw new Error(`setGameProfileJSON: colonne invalide: ${col}`);
        }
        setClauses.push(`${col} = ?`);
        values.push(JSON.stringify(fields[col]));
    }
    values.push(String(appid));
    db.prepare(`UPDATE games SET ${setClauses.join(', ')} WHERE appid = ?`).run(...values);
}

// --- OWNER helpers (multi-compte) ---

import { addOwner, removeOwner, getSteamProfilePaths } from './utils.js';

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
    const existingRows = db.prepare('SELECT hash, steam_market_price_eur, steam_market_last_sale_price_eur, steam_market_sales_7d, steam_market_fetched_at, steam_market_sell_price_eur, steam_market_sell_qty, steam_market_buy_order_eur, steam_market_buy_order_qty, qty_by_profile FROM cards WHERE appid = ?').all(String(appid));
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
                qtyByProfile: row.qty_by_profile,
            };
        }
    }

    const stmt = db.prepare(`
        INSERT INTO cards (appid, name, card_index, qty, hash, icon_url, art_url, inv_json,
            sce_stock, sce_worth, sce_price, sce_market_price_usd,
            steam_market_price_eur, steam_market_last_sale_price_eur, steam_market_sales_7d, steam_market_fetched_at,
            steam_market_sell_price_eur, steam_market_sell_qty, steam_market_buy_order_eur, steam_market_buy_order_qty,
            sce_quick_trade, qty_by_profile)
        VALUES (@appid, @name, @card_index, @qty, @hash, @icon_url, @art_url, @inv_json,
            @sce_stock, @sce_worth, @sce_price, @sce_market_price_usd,
            @steam_market_price_eur, @steam_market_last_sale_price_eur, @steam_market_sales_7d, @steam_market_fetched_at,
            @steam_market_sell_price_eur, @steam_market_sell_qty, @steam_market_buy_order_eur, @steam_market_buy_order_qty,
            @sce_quick_trade, @qty_by_profile)
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

/**
 * Migration unique: backfill les champs par profil pour les donnees existantes.
 * Assigne les valeurs globales (fetched_at, lasttrade, badge_crafted, etc.)
 * au profil principal. Reconstruit qty_by_profile a partir de inv_json.
 * Suivie par la cle meta 'profileMigrationDone'.
 */
export function migrateProfileData() {
    if (getMeta('profileMigrationDone', '0') === '1') return;

    const primaryProfile = getSteamProfilePaths()[0] || 'my';
    let gamesMigrated = 0;
    let cardsMigrated = 0;

    const tx = db.transaction(() => {
        // 1. Backfill games: champs par profil depuis les colonnes globales
        const games = db.prepare(
            'SELECT appid, fetched_at, lasttrade, badge_crafted, badge_crafted_fetched_at, badge_crafted_owner,\n' +
            '       fetched_at_by_profile, lasttrade_by_profile, badge_crafted_by_profile, badge_crafted_fetched_at_by_profile\n' +
            'FROM games'
        ).all();

        for (const g of games) {
            const updates = {};

            // fetched_at_by_profile: vide -> assigner au profil principal
            if (g.fetched_at) {
                let data = {};
                try { data = JSON.parse(g.fetched_at_by_profile || '{}'); } catch { /* ignore */ }
                if (!data[primaryProfile]) {
                    data[primaryProfile] = g.fetched_at;
                    updates.fetched_at_by_profile = JSON.stringify(data);
                }
            }

            // lasttrade_by_profile
            if (g.lasttrade) {
                let data = {};
                try { data = JSON.parse(g.lasttrade_by_profile || '{}'); } catch { /* ignore */ }
                if (!data[primaryProfile]) {
                    data[primaryProfile] = g.lasttrade;
                    updates.lasttrade_by_profile = JSON.stringify(data);
                }
            }

            // badge_crafted_by_profile (0 ou 1, pas NULL)
            if (g.badge_crafted !== null) {
                let data = {};
                try { data = JSON.parse(g.badge_crafted_by_profile || '{}'); } catch { /* ignore */ }
                if (!Object.prototype.hasOwnProperty.call(data, primaryProfile)) {
                    data[primaryProfile] = g.badge_crafted;
                    updates.badge_crafted_by_profile = JSON.stringify(data);
                }
            }

            // badge_crafted_fetched_at_by_profile
            if (g.badge_crafted_fetched_at) {
                let data = {};
                try { data = JSON.parse(g.badge_crafted_fetched_at_by_profile || '{}'); } catch { /* ignore */ }
                if (!data[primaryProfile]) {
                    data[primaryProfile] = g.badge_crafted_fetched_at;
                    updates.badge_crafted_fetched_at_by_profile = JSON.stringify(data);
                }
            }

            // badge_crafted_owner: NULL alors que badge_crafted = 1
            if (g.badge_crafted === 1 && !g.badge_crafted_owner) {
                updates.badge_crafted_owner = primaryProfile;
            }

            if (Object.keys(updates).length > 0) {
                const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
                const values = [...Object.values(updates), String(g.appid)];
                db.prepare(`UPDATE games SET ${setClauses} WHERE appid = ?`).run(...values);
                gamesMigrated++;
            }
        }

        // 2. Backfill cards: ajouter profile aux items inv, reconstruire qty_by_profile
        const cards = db.prepare('SELECT id, inv_json, qty_by_profile FROM cards').all();

        for (const c of cards) {
            let inv = [];
            try { inv = JSON.parse(c.inv_json || '[]'); } catch { /* ignore */ }

            let changed = false;

            // Ajouter profile aux items qui n en ont pas
            for (const item of inv) {
                if (!item.profile) {
                    item.profile = primaryProfile;
                    changed = true;
                }
            }

            // Reconstruire qty_by_profile si vide
            let qtyByProfile = {};
            try { qtyByProfile = JSON.parse(c.qty_by_profile || '{}'); } catch { /* ignore */ }
            if (Object.keys(qtyByProfile).length === 0 && inv.length > 0) {
                for (const item of inv) {
                    const p = item.profile || primaryProfile;
                    qtyByProfile[p] = (qtyByProfile[p] || 0) + 1;
                }
                changed = true;
            }

            if (changed) {
                db.prepare('UPDATE cards SET inv_json = ?, qty_by_profile = ? WHERE id = ?')
                    .run(JSON.stringify(inv), JSON.stringify(qtyByProfile), c.id);
                cardsMigrated++;
            }
        }
    });

    tx();
    setMeta('profileMigrationDone', '1');
    console.log(`[DB] Migration multi-compte: ${gamesMigrated} jeu(x), ${cardsMigrated} carte(s) migre(s) vers le profil "${primaryProfile}".`);
}

export function purgeCache() {
    db.prepare('DELETE FROM games').run();
    db.prepare('DELETE FROM cards').run();
    db.prepare('DELETE FROM badge_appids').run();
    db.prepare('DELETE FROM meta').run();
    setMeta('scecredit', '0');
    // La migration multi-compte devra etre refaites apres purge
    setMeta('profileMigrationDone', '0');
    console.log('[DB] Cache purge.');
}

// Initialise automatiquement au chargement du module
initDB();
migrateProfileData();

export default db;
