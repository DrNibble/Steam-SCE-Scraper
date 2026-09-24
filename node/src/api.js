/**
 * api.js - Serveur HTTP REST exposant les donnees de la base SQLite
 *
 * Utilise le module http natif de Node (aucune dependance supplementaire).
 * Lis directement dans la DB via db.js (getDB) - lecture seule.
 *
 * Endpoints:
 *   GET  /api/data          - Dump complet (jeux + cartes + meta) au format win.ES.DATA
 *   GET  /api/games          - Liste de tous les jeux (resume, sans les cartes)
 *   GET  /api/games/:appid   - Un jeu avec ses cartes detaillees
 *   GET  /api/meta            - Toutes les cles-valeurs de la table meta
 *   GET  /api/badges          - Tous les badge_appids
 *   GET  /api/status          - Resume de la base (comptages, scecredit, lasttrade)
 *   OPTIONS *                 - Pre-flight CORS
 *
 * Retourne les donnees au format attendu par le script Tampermonkey:
 *   - Jeux en camelCase (setCards, fetchedAt, isCompletableViaSCE, etc.)
 *   - Cartes avec cles SCE en espaces ("sce stock", "sce worth", etc.)
 *   - Meta directe (scecredit, scePendingOffers, etc.)
 *
 * Securite: bind 127.0.0.1 par defaut (n'expose pas les donnees sur le reseau).
 */
import http from 'http';
import { getDB, getGame, getCards, getAllGames, getAllBadgeAppids, countGames, getMeta } from './db.js';

const DEFAULT_HOST = process.env.API_HOST || '127.0.0.1';
const DEFAULT_PORT = parseInt(process.env.API_PORT || '3001', 10);

// --- Helpers: conversion DB (snake_case) -> Tampermonkey (camelCase + espaces) ---

function gameRowToApi(row) {
    if (!row) return null;
    let hasExpensiveCard = null;
    if (row.has_expensive_card_json) {
        try { hasExpensiveCard = JSON.parse(row.has_expensive_card_json); } catch { /* ignore */ }
    }
    return {
        appid: row.appid,
        gamename: row.gamename,
        disabled: row.disabled === 1,
        fetchedAt: row.fetched_at,
        lasttrade: row.lasttrade,
        setCards: row.set_cards,
        totalOwnedQty: row.total_owned_qty,
        isCompletableViaTrade: row.is_completable_via_trade === 1,
        isCompletableViaSCE: row.is_completable_via_sce === 1,
        isCompletableviaSCEwobudget: row.is_completable_via_sce_wobudget === 1,
        isCompletableviaSCEdoublon: row.is_completable_via_sce_doublon === 1,
        hasExpensiveCard,
        totalCostSCE: row.total_cost_sce,
        missingCount: row.missing_count,
        badgeCrafted: row.badge_crafted ?? null,
        badgeCraftedFetchedAt: row.badge_crafted_fetched_at ?? null,
    };
}

function cardRowToApi(row) {
    if (!row) return null;
    let inv = [];
    if (row.inv_json) {
        try { inv = JSON.parse(row.inv_json); } catch { /* ignore */ }
    }
    return {
        name: row.name,
        qty: row.qty || 0,
        index: row.card_index,
        inv,
        // Nettoyage du suffixe " (Trading Card)" uniquement a l'affichage
        // (le hash en DB reste brut, avec le suffixe, pour les appels API Steam Market)
        hash: row.hash ? row.hash.replace(/\s*\(trading card\)\s*/gi, '').trim() : null,
        iconUrl: row.icon_url,
        artUrl: row.art_url,
        'sce stock': row.sce_stock || 0,
        'sce worth': row.sce_worth || 0,
        'sce price': row.sce_price || 0,
        'sce marketPriceUSD': row.sce_market_price_usd || 0,
        'sce quick-trade': row.sce_quick_trade || '',
        steamMarketPriceEur: row.steam_market_price_eur ?? null,
        steamMarketLastSalePriceEur: row.steam_market_last_sale_price_eur ?? null,
        steamMarketSales7d: row.steam_market_sales_7d || 0,
        steamMarketFetchedAt: row.steam_market_fetched_at ?? null,
        steamMarketSellPriceEur: row.steam_market_sell_price_eur ?? null,
        steamMarketSellQty: row.steam_market_sell_qty ?? null,
        steamMarketBuyOrderEur: row.steam_market_buy_order_eur ?? null,
        steamMarketBuyOrderQty: row.steam_market_buy_order_qty ?? null,
    };
}

function gameWithCardsToApi(row) {
    const game = gameRowToApi(row);
    if (!game) return null;
    const cards = getCards(row.appid).map(cardRowToApi);
    return { ...game, cards };
}

// --- Endpoints ---

function buildFullData() {
    const db = getDB();
    const data = {};

    // Meta
    const metaRows = db.prepare('SELECT key, value FROM meta').all();
    for (const { key, value } of metaRows) {
        // Conversion numerique pour les cles connues
        if (['scecredit', 'scePendingOffers'].includes(key)) {
            data[key] = parseInt(value, 10) || 0;
        } else if (['sceWaitTime', 'usdToEur'].includes(key)) {
            data[key] = parseFloat(value) || 0;
        } else if (['lasttrade', 'usdToEurFetchedAt'].includes(key)) {
            data[key] = parseInt(value, 10) || 0;
        } else if (key === 'sceDeferredAppids') {
            try { data[key] = JSON.parse(value); } catch { data[key] = []; }
        } else {
            data[key] = value;
        }
    }

    // Jeux + cartes
    const games = getAllGames();
    for (const game of games) {
        const apiGame = gameWithCardsToApi(game);
        if (apiGame) {
            data[game.appid] = apiGame;
        }
    }

    return data;
}

function getStatus() {
    const db = getDB();
    const gameCount = countGames();
    const cardCount = db.prepare('SELECT COUNT(*) as count FROM cards').get().count;
    const badgeCount = db.prepare('SELECT COUNT(*) as count FROM badge_appids').get().count;
    const disabledCount = db.prepare('SELECT COUNT(*) as count FROM games WHERE disabled = 1').get().count;
    const craftedCount = db.prepare('SELECT COUNT(*) as count FROM games WHERE badge_crafted = 1').get().count;

    return {
        games: gameCount,
        cards: cardCount,
        badges: badgeCount,
        disabledGames: disabledCount,
        craftedBadges: craftedCount,
        scecredit: parseInt(getMeta('scecredit', '0'), 10) || 0,
        scePendingOffers: parseInt(getMeta('scePendingOffers', '0'), 10) || 0,
        sceWaitTime: parseFloat(getMeta('sceWaitTime', '0')) || 0,
        lasttrade: parseInt(getMeta('lasttrade', '0'), 10) || 0,
    };
}

function getAllMeta() {
    const db = getDB();
    const rows = db.prepare('SELECT key, value FROM meta').all();
    const meta = {};
    for (const { key, value } of rows) {
        meta[key] = value;
    }
    return meta;
}

// --- Serveur HTTP ---

let serverInstance = null;

export function startApiServer(options = {}) {
    const host = options.host || DEFAULT_HOST;
    const port = options.port || DEFAULT_PORT;

    // Idempotent: si le serveur tourne deja, on ne le relance pas
    if (serverInstance) {
        console.log(`[API] Serveur deja en cours sur http://${host}:${port}`);
        return serverInstance;
    }

    const server = http.createServer(async (req, res) => {
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        // Pre-flight
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        const url = new URL(req.url, `http://${host}`);
        const path = url.pathname;

        try {
            // --- Routing ---
            let payload;

            if (path === '/api/data') {
                payload = buildFullData();
            } else if (path === '/api/games') {
                payload = getAllGames().map(gameRowToApi).filter(Boolean);
            } else if (path.startsWith('/api/games/')) {
                const appid = path.replace('/api/games/', '');
                const game = getGame(appid);
                if (!game) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Game not found' }));
                    return;
                }
                payload = gameWithCardsToApi(game);
            } else if (path === '/api/meta') {
                payload = getAllMeta();
            } else if (path === '/api/badges') {
                payload = getAllBadgeAppids();
            } else if (path === '/api/status') {
                payload = getStatus();
            } else if (path === '/' || path === '/api') {
                payload = {
                    name: 'Steam-SCE API',
                    endpoints: [
                        '/api/data - Dump complet (format win.ES.DATA)',
                        '/api/games - Liste des jeux (resume)',
                        '/api/games/:appid - Jeu detaille avec cartes',
                        '/api/meta - Cles-valeurs meta',
                        '/api/badges - Badge appids',
                        '/api/status - Resume de la base',
                    ],
                };
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(payload));
        } catch (err) {
            console.error(`[API] Erreur sur ${path}:`, err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error', detail: err.message }));
        }
    });

    server.listen(port, host, () => {
        console.log(`[API] Serveur demarre sur http://${host}:${port}`);
        console.log(`[API] Endpoints: /api/data, /api/games, /api/games/:appid, /api/meta, /api/badges, /api/status`);
    });

    // Gestion EADDRINUSE: si le port est deja pris (ex: npm run api tourne deja
    // et npm run sync tente de demarrer un second serveur), on loggue sans crasher
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`[API] Port ${port} deja utilise - le serveur API tourne deja. Skipping.`);
            serverInstance = null;
        } else {
            console.error(`[API] Erreur serveur:`, err.message);
        }
    });

    serverInstance = server;
    return server;
}

export function stopApiServer() {
    if (serverInstance) {
        serverInstance.close();
        serverInstance = null;
        console.log('[API] Serveur arrete.');
    }
}

// --- Lancement standalone (npm run api) ---
// On check process.argv pour eviter de demarrer le serveur quand api.js
// est importe par un autre module (ex: sync.js)
const isMainModule = process.argv[1] && process.argv[1].endsWith('api.js');
if (isMainModule) {
    startApiServer();
}
