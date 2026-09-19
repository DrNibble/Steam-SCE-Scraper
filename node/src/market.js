/**
 * market.js — Extension du scraping Steam Market
 *
 * Ajoute la récupération des buy orders et de l'historique des ventes
 * pour implémenter la logique :
 *   - Si vente dans les 7 derniers jours → dernier prix de vente
 *   - Sinon → buy order le plus haut
 *
 * Endpoints utilisés :
 *   1. /market/orderbook  — buy/sell orders (pas d'auth requise, mais cookies envoyés)
 *   2. /market/pricehistory — historique des ventes (requiert steamLoginSecure)
 *
 * Ces endpoints ne sont pas officiels/documentés par Valve.
 * Ils sont utilisés par la page Steam Community Market actuelle (SSR/React).
 *
 * Intégration dans le projet Steam-SCE-Scraper :
 *   - Utilise httpGet, sleep, getSteamCookie depuis utils.js
 *   - Utilise getCards, updateCardMarketPrices depuis db.js
 *   - Le hash en DB est déjà le market_hash_name (ex: "616580-Servie")
 *
 * Anti rate-limit :
 *   - 1 requête par endpoint par carte, séquentiel
 *   - Le délai fixe est remplacé par le token bucket de marketQueue.js
 *   - Backoff exponentiel sur 429 (déjà géré par httpGet)
 *   - Pas de parallélisme
 */

import { httpGet, httpGetJSON, sleep, getSteamCookie, ES_log } from './utils.js';
import { getCards, updateCardMarketPrices } from './db.js';

const STEAM_AJAX_HEADERS = {
    'Referer': 'https://steamcommunity.com/',
    'X-Requested-With': 'XMLHttpRequest',
};

const MARKET_APPID = 753; // Toujours 753 pour les cartes Steam Community


// ═══════════════════════════════════════════════════════════════
// 1) Orderbook — buy orders (endpoint utilisé par la page Steam)
// ═══════════════════════════════════════════════════════════════

/**
 * Récupère le buy order le plus haut pour une carte.
 *
 * L'endpoint /market/orderbook est celui que la page Steam Community Market
 * actuelle (SSR/React) appelle en interne. Il ne nécessite pas d'authentification
 * mais fonctionne aussi avec les cookies Steam.
 *
 * @param {string} marketHashName - Le market_hash_name de la carte (ex: "616580-Servie")
 * @returns {Promise<object|null>} - { highestBuyOrder, lowestSellOrder, totalBuyOrders } ou null
 */
export async function getOrderbook(marketHashName) {
    const listingUrl = `https://steamcommunity.com/market/listings/${MARKET_APPID}/${encodeURIComponent(marketHashName)}`;

    // Construire l'URL avec les paramètres
    const params = new URLSearchParams({
        q: 'Load',
        qp: JSON.stringify([MARKET_APPID, marketHashName]),
        cc: 'FR',
        l: 'english',
        currency: '1', // orderbook retourne toujours eCurrency=1 (USD)
    });

    const url = `https://steamcommunity.com/market/orderbook?${params.toString()}`;

    try {
        const text = await httpGet(url, {
            cookies: getSteamCookie(),
            accept: 'application/json',
            retries: 3,
            extraHeaders: {
                ...STEAM_AJAX_HEADERS,
                'x-valve-request-type': 'queryAction',
                'Referer': listingUrl,
            },
        });

        // Vérifier qu'on a du JSON
        if (text.trim().startsWith('<')) {
            ES_log(`[getOrderbook] HTML reçu au lieu de JSON pour ${marketHashName}`);
            return null;
        }

        const outer = JSON.parse(text);

        // Steam a deux enveloppes possibles :
        // 1. { success: true, data: {...} }
        // 2. { data: { success: true, data: {...} } }
        const payload = (outer.success !== undefined) ? outer : outer.data;
        if (!payload || payload.success !== true) {
            ES_log(`[getOrderbook] success=false pour ${marketHashName}`);
            return null;
        }

        const data = payload.data;
        if (!data) return null;

        // amtMaxBuyOrder = prix en centimes (USD)
        const highestBuyOrderCents = data.amtMaxBuyOrder || 0;
        const lowestSellOrderCents = data.amtMinSellOrder || 0;

        // Convertir en EUR (approximatif — pour un prix exact, utiliser pricehistory avec currency=3)
        // Ici on garde le prix USD car orderbook est toujours en eCurrency=1
        // La conversion EUR sera faite par pricehistory si disponible
        return {
            highestBuyOrder: highestBuyOrderCents > 0 ? highestBuyOrderCents / 100 : null,
            highestBuyOrderCents,
            lowestSellOrder: lowestSellOrderCents > 0 ? lowestSellOrderCents / 100 : null,
            totalBuyOrders: data.cBuyOrders || 0,
            totalSellOrders: data.cSellOrders || 0,
            currency: 'USD', // orderbook est toujours en USD
        };
    } catch (err) {
        // Propager les 429 pour que le token bucket du worker puisse réagir
        if (err.message && err.message.includes('429')) {
            throw err;
        }
        ES_log(`[getOrderbook] Erreur pour ${marketHashName}: ${err.message}`);
        return null;
    }
}


// ═══════════════════════════════════════════════════════════════
// 2) Price history — historique des ventes (requiert auth)
// ═══════════════════════════════════════════════════════════════

/**
 * Parse une date au format Steam pricehistory : "Sep 19 2024 01: +0"
 * Retourne un timestamp en millisecondes (UTC)
 * (Repris de steam.js — parseMarketDate)
 */
function parseMarketDate(dateStr) {
    if (!dateStr) return 0;
    const match = dateStr.trim().match(/^(\w{3})\s+(\d+)\s+(\d+)\s+(\d+):?\s*([+-]?\d+)(?::(\d+))?/);
    if (!match) return 0;
    const months = {Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11};
    const m = months[match[1]];
    if (m === undefined) return 0;
    const year = parseInt(match[3]);
    const day = parseInt(match[2]);
    const hour = parseInt(match[4]);
    const tzOffsetHours = parseInt(match[5]) || 0;
    const tzOffsetMin = parseInt(match[6] || '0') || 0;
    const totalOffsetMin = tzOffsetHours * 60 + (tzOffsetHours >= 0 ? tzOffsetMin : -tzOffsetMin);
    return Date.UTC(year, m, day, hour) - totalOffsetMin * 60000;
}

/**
 * Récupère le dernier prix de vente dans les N derniers jours.
 *
 * L'endpoint /market/pricehistory nécessite le cookie steamLoginSecure.
 * Le projet Steam-SCE-Scraper le fournit déjà via STEAM_COOKIE dans .env.
 *
 * @param {string} marketHashName - Le market_hash_name (ex: "616580-Servie")
 * @param {number} days - Fenêtre en jours (défaut: 7)
 * @returns {Promise<object|null>} - { price, date, volume, salesCount } ou null
 */
export async function getRecentSale(marketHashName, days = 7) {
    const encodedName = encodeURIComponent(marketHashName);
    const url = `https://steamcommunity.com/market/pricehistory/?appid=${MARKET_APPID}&market_hash_name=${encodedName}&l=english&currency=3`;

    try {
        const text = await httpGet(url, {
            cookies: getSteamCookie(),
            accept: 'application/json',
            retries: 3,
            extraHeaders: {
                ...STEAM_AJAX_HEADERS,
                'Referer': `https://steamcommunity.com/market/listings/${MARKET_APPID}/${encodedName}`,
            },
        });

        // Vérifier qu'on a du JSON (Steam renvoie du HTML si cookies invalides)
        if (text.trim().startsWith('<')) {
            ES_log(`[getRecentSale] HTML reçu (cookies invalides?) pour ${marketHashName}`);
            return null;
        }

        const data = JSON.parse(text);

        if (!data.success) {
            ES_log(`[getRecentSale] success=false pour ${marketHashName}`);
            return null;
        }

        const prices = data.prices || [];
        if (prices.length === 0) {
            return null; // Pas d'historique du tout
        }

        // Filtrer les ventes dans les N derniers jours
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        const recentSales = [];

        for (const entry of prices) {
            // Format: ["Sep 19 2024 01: +0", 0.95, 1]  (date, prix, volume)
            const dateStr = entry[0];
            const price = parseFloat(entry[1]);
            const volume = parseInt(entry[2]) || 1;

            const ts = parseMarketDate(dateStr);
            if (ts >= cutoff && ts > 0) {
                recentSales.push({ date: ts, price, volume });
            }
        }

        if (recentSales.length === 0) {
            // Pas de vente dans les N derniers jours
            return null;
        }

        // Dernière vente (la plus récente)
        // ⚠ L'historique Steam est souvent agrégé en points prix/volume.
        // "Dernier prix de vente" = dernier point disponible dans les 7 jours,
        // pas forcément chaque transaction individuelle.
        const lastSale = recentSales.reduce((latest, current) =>
            current.date > latest.date ? current : latest
        );

        const totalVolume = recentSales.reduce((sum, s) => sum + s.volume, 0);

        return {
            price: lastSale.price,       // Prix en EUR (currency=3)
            date: lastSale.date,          // Timestamp ms
            volume: lastSale.volume,      // Volume de ce point
            salesCount: recentSales.length, // Nombre de points de vente dans la période
            totalVolume,                  // Volume total dans les 7 jours
        };
    } catch (err) {
        // Propager les 429 pour que le token bucket du worker puisse réagir
        if (err.message && err.message.includes('429')) {
            throw err;
        }
        ES_log(`[getRecentSale] Erreur pour ${marketHashName}: ${err.message}`);
        return null;
    }
}


// ═══════════════════════════════════════════════════════════════
// 3) Logique principale : résoudre le prix d'une carte
// ═══════════════════════════════════════════════════════════════

/**
 * Résout le prix d'une carte selon la logique :
 *   - Si vente dans les 7 derniers jours → dernier prix de vente (EUR)
 *   - Sinon → buy order le plus haut (converti en EUR approximatif)
 *
 * @param {object} card - Objet carte depuis la DB (doit avoir .hash)
 * @param {number} days - Fenêtre en jours (défaut: 7)
 * @returns {Promise<object>} - { priceEur, sales7d, source, reason }
 */
export async function resolveCardPrice(card, days = 7) {
    const marketHashName = card.hash;
    if (!marketHashName) {
        return { priceEur: null, sales7d: 0, source: 'no_hash', reason: 'Pas de hash' };
    }

    // Étape 1 : Vérifier l'historique des ventes (requiert auth)
    const recentSale = await getRecentSale(marketHashName, days);

    if (recentSale) {
        // Vente trouvée dans les 7 derniers jours → dernier prix de vente
        return {
            priceEur: recentSale.price,
            sales7d: recentSale.totalVolume || recentSale.salesCount,
            source: 'last_sale',
            reason: `Vente dans les ${days} derniers jours`,
            saleDate: recentSale.date,
        };
    }

    // Pas de vente dans les 7 derniers jours → buy order le plus haut
    const orderbook = await getOrderbook(marketHashName);

    if (orderbook && orderbook.highestBuyOrder) {
        // Le buy order est en USD (eCurrency=1), conversion approximative en EUR
        // Pour un prix exact en EUR, il faudrait un taux de change temps réel
        // Ici on utilise un taux fixe approximatif (à ajuster si besoin)
        const USD_TO_EUR = 0.92;
        const priceEur = Math.round(orderbook.highestBuyOrder * USD_TO_EUR * 100) / 100;

        return {
            priceEur,
            sales7d: 0,
            source: 'highest_buy_order',
            reason: 'Aucune vente dans les 7 derniers jours',
            buyOrderUsd: orderbook.highestBuyOrder,
            totalBuyOrders: orderbook.totalBuyOrders,
        };
    }

    // Ni vente ni buy order
    return {
        priceEur: null,
        sales7d: 0,
        source: 'no_data',
        reason: 'Aucune vente et aucun buy order',
    };
}


// ═══════════════════════════════════════════════════════════════
// 4) Fonction principale : fetch tous les prix pour un appid
// ═══════════════════════════════════════════════════════════════

/**
 * Récupère les prix du marché Steam pour toutes les cartes d'un jeu.
 *
 * Logique :
 *   1. Pour chaque carte, vérifier pricehistory (ventes des 7 derniers jours)
 *   2. Si vente → utiliser le dernier prix de vente (EUR)
 *   3. Sinon → utiliser le buy order le plus haut (orderbook)
 *
 * Remplace fetchSteamMarketPrices de steam.js par une version plus précise.
 *
 * @param {string} appid - L'appid du jeu
 * @param {number} delayMs - Délai entre les cartes en ms (défaut: 500, remplacé par token bucket si marketQueue est utilisé)
 */
export async function fetchMarketPricesV2(appid, delayMs = 500) {
    const cards = getCards(appid);
    if (!cards || cards.length === 0) {
        ES_log(`[fetchMarketPricesV2] Aucune carte trouvée pour appid ${appid}`);
        return;
    }

    ES_log(`[fetchMarketPricesV2] Traitement de ${cards.length} cartes (appid ${appid})...`);

    const priceMap = new Map();

    for (const card of cards) {
        if (!card.hash) continue;

        ES_log(`[fetchMarketPricesV2] Carte: ${card.name || card.hash}`);

        try {
            const result = await resolveCardPrice(card, 7);

            priceMap.set(card.hash, {
                priceEur: result.priceEur,
                sales7d: result.sales7d || 0,
            });

            ES_log(`[fetchMarketPricesV2] → ${result.source}: ${
                result.priceEur !== null ? result.priceEur + '€' : 'N/A'
            } (${result.reason})`);
        } catch (err) {
            ES_log(`[fetchMarketPricesV2] Erreur pour ${card.hash}: ${err.message}`);
            priceMap.set(card.hash, { priceEur: null, sales7d: 0 });
        }

        // Délai anti-rate-limit entre les cartes
        await sleep(delayMs);
    }

    // Mettre à jour la DB en une seule transaction
    updateCardMarketPrices(appid, priceMap);

    ES_log(`[fetchMarketPricesV2] Terminé pour appid ${appid} (${priceMap.size} cartes mises à jour).`);

    return priceMap;
}


// ═══════════════════════════════════════════════════════════════
// 5) Export d'une carte unique (pour test ou usage CLI)
// ═══════════════════════════════════════════════════════════════

/**
 * Récupère le prix d'une carte unique par son market_hash_name.
 *
 * @param {string} marketHashName - ex: "616580-Servie"
 * @returns {Promise<object>} - Résultat détaillé
 */
export async function fetchSingleCardPrice(marketHashName) {
    ES_log(`[fetchSingleCardPrice] ${marketHashName}`);

    const result = await resolveCardPrice({ hash: marketHashName }, 7);

    console.log('\n' + '═'.repeat(60));
    console.log(`  Carte: ${marketHashName}`);
    console.log('═'.repeat(60));
    console.log(`  Source: ${result.source}`);
    console.log(`  Raison: ${result.reason}`);
    console.log(`  Prix: ${result.priceEur !== null ? result.priceEur + '€' : 'N/A'}`);
    console.log(`  Ventes 7j: ${result.sales7d}`);
    if (result.buyOrderUsd) console.log(`  Buy order USD: $${result.buyOrderUsd}`);
    if (result.saleDate) console.log(`  Date vente: ${new Date(result.saleDate).toISOString()}`);
    console.log('═'.repeat(60));

    return result;
}
