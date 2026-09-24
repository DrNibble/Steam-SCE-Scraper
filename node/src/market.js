/**
 * market.js — Extension du scraping Steam Market
 *
 * Ajoute la récupération des buy orders et de l'historique des ventes
 * pour implémenter la logique :
 *   - Si vente dans les 7 derniers jours → dernier prix de vente
 *   - Sinon → buy order le plus haut
 *
 * Sources utilisées (dans l'ordre, avec fallback) :
 *   0. Page listing (/market/listings/753/HASH) — cache SSR embarqué
 *      contenant les mêmes données que /market/orderbook ET
 *      /market/pricehistory (voir ssrCache.js). 1 requête remplace 3.
 *      ⚠ Le cache SSR est ABSENT pour les items à fort volume (page
 *      coquille) → les endpoints restent indispensables en fallback.
 *   1. /market/priceoverview — prix de vente EUR, prix médian, volume (pas d'auth)
 *   2. /market/orderbook  — buy/sell orders, quantités (pas d'auth requise, mais cookies envoyés)
 *   3. /market/pricehistory — historique des ventes, volume 7j, prix médian 7j (requiert steamLoginSecure)
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
 *   - Page listing d'abord (cache SSR = orderbook + pricehistory en 1 requête)
 *   - Endpoints uniquement en fallback pour les données manquantes
 *   - Le délai fixe est remplacé par le token bucket de marketQueue.js
 *   - Backoff exponentiel sur 429 (déjà géré par httpGet)
 *   - Pas de parallélisme
 */

import { httpGet, httpGetJSON, sleep, getSteamCookie, ES_log } from './utils.js';
import { getCards, updateCardMarketPrices } from './db.js';
import {
    parseSteamPriceEur,
    median,
    parseListingText,
    parseSSRQueries,
    findMarketQuery,
    extractOrderbookInfo,
    recentSaleFromSSR,
} from './ssrCache.js';

const STEAM_AJAX_HEADERS = {
    'Referer': 'https://steamcommunity.com/',
    'X-Requested-With': 'XMLHttpRequest',
};

const MARKET_APPID = 753; // Toujours 753 pour les cartes Steam Community

// (parseSteamPriceEur et median sont importés depuis ssrCache.js)

// ═══════════════════════════════════════════════════════════════
// 1) Price Overview — prix de vente EUR, prix médian, volume (pas d'auth)
// ═══════════════════════════════════════════════════════════════

/**
 * Récupère le prix de vente actuel et le prix médian depuis priceoverview.
 *
 * L'endpoint /market/priceoverview ne nécessite pas d'authentification
 * et retourne les prix dans la devise demandée (currency=3 = EUR).
 *
 * @param {string} marketHashName - Le market_hash_name (ex: "1040420-Isolation")
 * @returns {Promise<object|null>} - { sellPriceEur, medianPriceEur, totalVolume } ou null
 */
export async function getPriceOverview(marketHashName) {
    const url = `https://steamcommunity.com/market/priceoverview/?appid=${MARKET_APPID}&market_hash_name=${encodeURIComponent(marketHashName)}&currency=3&l=english`;

    try {
        const text = await httpGet(url, {
            cookies: getSteamCookie(),
            accept: 'application/json',
            retries: 3,
            extraHeaders: { ...STEAM_AJAX_HEADERS },
        });

        if (text.trim().startsWith('<')) {
           // ES_log(`[getPriceOverview] HTML reçu pour ${marketHashName}`);
            return null;
        }

        const data = JSON.parse(text);
        if (!data.success) {
           // ES_log(`[getPriceOverview] success=false pour ${marketHashName}`);
            return null;
        }

        return {
            sellPriceEur: parseSteamPriceEur(data.lowest_price),
            medianPriceEur: parseSteamPriceEur(data.median_price),
            totalVolume: parseInt(data.volume) || 0,
        };
    } catch (err) {
        if (err.message && err.message.includes('429')) {
            throw err;
        }
        ES_log(`[getPriceOverview] Erreur pour ${marketHashName}: ${err.message}`);
        return null;
    }
}


// ═══════════════════════════════════════════════════════════════
// 2) Orderbook — buy orders (endpoint utilisé par la page Steam)
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
           // ES_log(`[getOrderbook] HTML reçu au lieu de JSON pour ${marketHashName}`);
            return null;
        }

        const outer = JSON.parse(text);

        // Steam a deux enveloppes possibles :
        // 1. { success: true, data: {...} }
        // 2. { data: { success: true, data: {...} } }
        const payload = (outer.success !== undefined) ? outer : outer.data;
        if (!payload || payload.success !== true) {
           // ES_log(`[getOrderbook] success=false pour ${marketHashName}`);
            return null;
        }

        const data = payload.data;
        if (!data) return null;

        // amtMaxBuyOrder = prix en centimes (USD)
        const highestBuyOrderCents = data.amtMaxBuyOrder || 0;
        const lowestSellOrderCents = data.amtMinSellOrder || 0;

        // Quantité au prix de vente le plus bas (rgCompactSellOrders = [prix1, qté1, prix2, qté2, ...])
        const compactSells = data.rgCompactSellOrders || [];
        const sellQtyAtLowest = compactSells.length >= 2 ? compactSells[1] : 0;

        // Convertir en EUR (approximatif — pour un prix exact, utiliser pricehistory avec currency=3)
        // Ici on garde le prix USD car orderbook est toujours en eCurrency=1
        // La conversion EUR sera faite par pricehistory si disponible
        return {
            highestBuyOrder: highestBuyOrderCents > 0 ? highestBuyOrderCents / 100 : null,
            highestBuyOrderCents,
            lowestSellOrder: lowestSellOrderCents > 0 ? lowestSellOrderCents / 100 : null,
            sellQtyAtLowest,               // Quantité au prix de vente le plus bas
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
// 2b) Listing page — cache SSR (orderbook + pricehistory) + texte visible
// ═══════════════════════════════════════════════════════════════

/**
 * Récupère les données de marché depuis la page listing Steam (1 requête).
 *
 * La page listing embarque — quand le SSR réussit — un cache React Query
 * contenant les réponses des endpoints /market/orderbook et
 * /market/pricehistory (voir ssrCache.js). Le texte visible
 * ("X à vendre à partir de €Y", "Z demandes d'achat à €W") sert de
 * complément / fallback.
 *
 * IMPORTANT : le cache SSR n'est PAS toujours présent. Pour les items à
 * fort volume de ventes, Steam sert une coquille vide ("Failed to load
 * item description") : orderbook/pricehistory/text valent alors null et
 * les endpoints restent nécessaires en fallback.
 *
 * @param {string} marketHashName - Le market_hash_name (ex: "585360-Gregory (Trading Card)")
 * @returns {Promise<object|null>} - { orderbook, pricehistory, text, ssrAvailable } ou null
 *   - orderbook: data market.orderbook du cache SSR (prix en centimes) ou null
 *   - pricehistory: data market.pricehistory du cache SSR ou null
 *   - text: { sellQty, sellPriceEur, buyQty, buyPriceEur } ou null
 *   - ssrAvailable: true si au moins un des caches SSR était présent
 */
export async function getListingPageData(marketHashName) {
    const url = `https://steamcommunity.com/market/listings/${MARKET_APPID}/${encodeURIComponent(marketHashName)}`;

    try {
        const html = await httpGet(url, {
            cookies: getSteamCookie(),
            accept: 'text/html',
            retries: 3,
            extraHeaders: {
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            },
        });

        // 1. Cache SSR (primaire) : orderbook + pricehistory embarqués
        const queries = parseSSRQueries(html);
        const orderbook = queries ? findMarketQuery(queries, 'orderbook') : null;
        const pricehistory = queries ? findMarketQuery(queries, 'pricehistory') : null;

        // 2. Texte visible (complément / fallback)
        const text = parseListingText(html);

        const ssrAvailable = !!(orderbook || pricehistory);
        ES_log(`[getListingPageData] ${marketHashName} → SSR: ${ssrAvailable ? 'oui' : 'non'} (orderbook: ${orderbook ? 'oui' : 'non'}, pricehistory: ${pricehistory ? 'oui' : 'non'}) | texte: ${text ? 'oui' : 'non'}`);

        return { orderbook, pricehistory, text, ssrAvailable };
    } catch (err) {
        if (err.message && err.message.includes('429')) {
            throw err;
        }
        ES_log(`[getListingPageData] Erreur pour ${marketHashName}: ${err.message}`);
        return null;
    }
}

/**
 * Récupère les informations de vente et d'achat depuis la page listing Steam.
 *
 * @deprecated Utiliser getListingPageData (cache SSR + texte, 1 requête pour tout).
 * @param {string} marketHashName - Le market_hash_name (ex: "585360-Gregory (Trading Card)")
 * @returns {Promise<object|null>} - { sellQty, sellPriceEur, buyQty, buyPriceEur } ou null
 */
export async function getListingPageInfo(marketHashName) {
    const data = await getListingPageData(marketHashName);
    return data ? data.text : null;
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
 * @returns {Promise<object|null>} - { price, date, volume, salesCount, totalVolume, medianPrice } ou null
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
            //ES_log(`[getRecentSale] HTML reçu (cookies invalides?) pour ${marketHashName}`);
            return null;
        }

        const data = JSON.parse(text);

        if (!data.success) {
           // ES_log(`[getRecentSale] success=false pour ${marketHashName}`);
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

        // Prix médian des ventes sur 7 jours (pondéré par volume)
        // Chaque point de vente est répété selon son volume pour le calcul
        const allPrices = [];
        for (const s of recentSales) {
            for (let i = 0; i < s.volume; i++) allPrices.push(s.price);
        }
        const medianPrice = median(allPrices);

        return {
            price: lastSale.price,       // Prix en EUR (currency=3)
            date: lastSale.date,          // Timestamp ms
            volume: lastSale.volume,      // Volume de ce point
            salesCount: recentSales.length, // Nombre de points de vente dans la période
            totalVolume,                  // Volume total dans les 7 jours
            medianPrice,                  // Prix médian pondéré sur 7 jours (EUR)
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
 *   - Sinon → buy order le plus haut (EUR direct si possible)
 *
 * Stratégie anti rate-limit (SSR first, endpoints en fallback) :
 *   1. Page listing (1 requête) : cache SSR = orderbook + pricehistory
 *      complets + texte visible (sell/buy orders en EUR direct)
 *   2. Endpoint /market/pricehistory UNIQUEMENT si le cache SSR
 *      pricehistory est absent (ou dans une devise non-EUR)
 *   3. Endpoint /market/orderbook UNIQUEMENT si ni le texte ni le cache
 *      SSR n'ont fourni de buy order
 *
 * Règles importantes :
 *   - Cache SSR pricehistory PRÉSENT sans vente dans la fenêtre = donnée
 *     autoritaire → PAS d'appel endpoint (ça ne servirait à rien)
 *   - Les prix du cache SSR ne sont utilisés en EUR que si la devise
 *     est l'EUR (ecurrency/eCurrency === 3) ; sinon fallback endpoint
 *   - Les quantités du cache SSR sont indépendantes de la devise
 *
 * @param {object} card - Objet carte depuis la DB (doit avoir .hash)
 * @param {number} days - Fenêtre en jours (défaut: 7)
 * @returns {Promise<object>} - { priceEur, sales7d, lastSalePriceEur, source, reason, ... }
 */
export async function resolveCardPrice(card, days = 7) {
    const marketHashName = card.hash;
    if (!marketHashName) {
        return { priceEur: null, sales7d: 0, lastSalePriceEur: null, source: 'no_hash', reason: 'Pas de hash' };
    }

    // Étape 1 : page listing (1 requête) — cache SSR + texte visible
    const listingData = await getListingPageData(marketHashName);
    const text = listingData?.text ?? null;
    const ssrOrderbook = extractOrderbookInfo(listingData?.orderbook ?? null);
    const ssrHistory = listingData?.pricehistory ?? null;

    // Sell/buy orders : texte d'abord (EUR direct), puis cache SSR
    let sellPriceEur = text?.sellPriceEur ?? null;
    let sellQty = text?.sellQty ?? null;
    let buyOrderEur = text?.buyPriceEur ?? null;
    let buyOrderQty = text?.buyQty ?? null;

    if (ssrOrderbook) {
        if (sellPriceEur === null && ssrOrderbook.sellPriceEur !== null) sellPriceEur = ssrOrderbook.sellPriceEur;
        if (sellQty === null && ssrOrderbook.sellQty !== null) sellQty = ssrOrderbook.sellQty;
        if (buyOrderEur === null && ssrOrderbook.buyOrderEur !== null) buyOrderEur = ssrOrderbook.buyOrderEur;
        if (buyOrderQty === null && ssrOrderbook.buyOrderQty !== null) buyOrderQty = ssrOrderbook.buyOrderQty;
    }

    // Étape 2 : historique des ventes — cache SSR autoritaire, sinon endpoint
    let recentSale = null;
    let ssrVolumeOnly = 0; // volume 7j si SSR présent mais devise inattendue
    let needHistoryEndpoint = false;

    if (ssrHistory) {
        const ssrSale = recentSaleFromSSR(ssrHistory, days);
        if (!ssrSale) {
            // Aucune vente dans la fenêtre : le cache SSR était présent,
            // c'est autoritaire → PAS d'appel endpoint
        } else if (ssrSale.ecurrency === 3) {
            recentSale = ssrSale;
        } else {
            //ES_log(`[resolveCardPrice] pricehistory SSR devise=${ssrSale.ecurrency} (3=EUR attendu) pour ${marketHashName} : prix ignorés, fallback endpoint`);
            ssrVolumeOnly = ssrSale.totalVolume || 0;
            needHistoryEndpoint = true;
        }
    } else {
        needHistoryEndpoint = true;
    }

    if (needHistoryEndpoint) {
        const epSale = await getRecentSale(marketHashName, days);
        if (epSale) {
            recentSale = epSale;
        } else if (ssrVolumeOnly > 0) {
            // Endpoint échoué : on garde au moins le volume SSR (prix inconnu)
            recentSale = { price: null, date: null, volume: 0, salesCount: 0, totalVolume: ssrVolumeOnly, medianPrice: null };
        }
    }

    const sales7d = recentSale ? (recentSale.totalVolume || 0) : 0;
    const lastSalePriceEur = recentSale?.price ?? null;

    if (recentSale && lastSalePriceEur !== null) {
        // Vente trouvée dans la fenêtre → dernier prix de vente
        return {
            priceEur: recentSale.price,
            sales7d,
            lastSalePriceEur,
            sellPriceEur,
            sellQty,
            buyOrderEur,
            buyOrderQty,
            source: 'last_sale',
            reason: `Vente dans les ${days} derniers jours${listingData?.ssrAvailable ? ' (cache SSR)' : ''}`,
            saleDate: recentSale.date,
        };
    }

    // Pas de vente exploitable dans la fenêtre → buy order le plus haut
    if (buyOrderEur !== null) {
        return {
            priceEur: buyOrderEur,
            sales7d,
            lastSalePriceEur,
            sellPriceEur,
            sellQty,
            buyOrderEur,
            buyOrderQty,
            source: 'highest_buy_order',
            reason: `Aucune vente dans les ${days} derniers jours`,
        };
    }

    // Fallback : endpoint orderbook (USD → EUR approximatif) si la page
    // listing n'a rien donné (ni texte, ni cache SSR utilisable)
    const orderbook = await getOrderbook(marketHashName);

    if (orderbook && orderbook.highestBuyOrder) {
        const USD_TO_EUR = 0.92;
        const priceEur = Math.round(orderbook.highestBuyOrder * USD_TO_EUR * 100) / 100;

        return {
            priceEur,
            sales7d,
            lastSalePriceEur,
            sellPriceEur,
            sellQty,
            buyOrderEur: priceEur,
            buyOrderQty: buyOrderQty ?? orderbook.totalBuyOrders ?? null,
            source: 'highest_buy_order',
            reason: 'Aucune vente dans les 7 derniers jours (orderbook fallback)',
            buyOrderUsd: orderbook.highestBuyOrder,
            totalBuyOrders: orderbook.totalBuyOrders,
        };
    }

    // Ni vente ni buy order
    return {
        priceEur: null,
        sales7d,
        lastSalePriceEur,
        sellPriceEur,
        sellQty,
        buyOrderEur,
        buyOrderQty,
        source: 'no_data',
        reason: 'Aucune vente et aucun buy order',
    };
}


// ═══════════════════════════════════════════════════════════════
// 4) Fonction principale : fetch tous les prix pour un appid
// ═══════════════════════════════════════════════════════════════

// Délai minimum entre deux fetchs de prix marché pour une même carte.
// fetchMarketPricesV2 ne re-fetch une carte que si son dernier fetch
// (cards.steam_market_fetched_at, en ms) date de plus de 24 heures.
export const MARKET_PRICE_REFRESH_MS = 24 * 60 * 60 * 1000; // 24 heures

/**
 * Une carte est "fraîche" si son prix marché a été récupéré il y a moins de
 * MARKET_PRICE_REFRESH_MS (24h). Les cartes fraîches sont ignorées par
 * fetchMarketPricesV2 ; la même limite est aussi appliquée au worker
 * marketQueue (garde-fou dans processCard / dequeue).
 */
export function isMarketPriceFresh(card) {
    const fetchedAt = Number(card?.steam_market_fetched_at ?? 0);
    return fetchedAt > 0 && Date.now() - fetchedAt < MARKET_PRICE_REFRESH_MS;
}

/**
 * Récupère les prix du marché Steam pour toutes les cartes d'un jeu.
 *
 * Logique :
 *   1. Pour chaque carte, vérifier pricehistory (ventes des 7 derniers jours)
 *   2. Si vente → utiliser le dernier prix de vente (EUR)
 *   3. Sinon → utiliser le buy order le plus haut (orderbook)
 *   4. Les cartes dont le prix a été fetché il y a moins de 24h sont ignorées
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
    let skippedFresh = 0;

    for (const card of cards) {
        if (!card.hash) continue;

        // Prix marché déjà récupéré il y a moins de 24h : pas de re-fetch
        if (isMarketPriceFresh(card)) {
            skippedFresh++;
            continue;
        }

       // ES_log(`[fetchMarketPricesV2] Carte: ${card.name || card.hash}`);

        try {
            const result = await resolveCardPrice(card, 7);

            priceMap.set(card.hash, {
                priceEur: result.priceEur !== null && result.priceEur !== undefined
                    ? Math.round(result.priceEur * 100) / 100 : null,
                sales7d: result.sales7d || 0,
                lastSalePriceEur: result.lastSalePriceEur !== null && result.lastSalePriceEur !== undefined
                    ? Math.round(result.lastSalePriceEur * 100) / 100 : null,
                sellPriceEur: result.sellPriceEur !== null && result.sellPriceEur !== undefined
                    ? Math.round(result.sellPriceEur * 100) / 100 : null,
                sellQty: result.sellQty ?? null,
                buyOrderEur: result.buyOrderEur !== null && result.buyOrderEur !== undefined
                    ? Math.round(result.buyOrderEur * 100) / 100 : null,
                buyOrderQty: result.buyOrderQty ?? null,
            });

            ES_log(`[fetchMarketPricesV2] → ${result.source}: ${
                result.priceEur !== null ? (Math.round(result.priceEur * 100) / 100) + '€' : 'N/A'
            } (${result.reason})`);
        } catch (err) {
            ES_log(`[fetchMarketPricesV2] Erreur pour ${card.hash}: ${err.message}`);
            priceMap.set(card.hash, { priceEur: null, sales7d: 0, sellPriceEur: null, sellQty: null, buyOrderEur: null, buyOrderQty: null });
        }

        // Délai anti-rate-limit entre les cartes
        await sleep(delayMs);
    }

    // Rien à mettre à jour : toutes les cartes étaient fraîches (< 24h)
    if (priceMap.size === 0) {
        ES_log(`[fetchMarketPricesV2] Appid ${appid}: ${skippedFresh}/${cards.length} cartes fraîches (< 24h), aucune mise à jour.`);
        return priceMap;
    }

    // Mettre à jour la DB en une seule transaction
    updateCardMarketPrices(appid, priceMap);

    ES_log(`[fetchMarketPricesV2] Terminé pour appid ${appid} (${priceMap.size} cartes mises à jour, ${skippedFresh} ignorées < 24h).`);

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
