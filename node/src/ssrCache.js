/**
 * ssrCache.js — Parsing du cache SSR de la page listing Steam Community Market
 *
 * La page listing (https://steamcommunity.com/market/listings/753/HASH) est
 * rendue côté serveur (SSR React). Quand le rendu réussit, elle embarque un
 * cache React Query déshydraté dans :
 *
 *   window.SSR.renderContext = JSON.parse("<json>")
 *
 * Structure du renderContext :
 *   {
 *     localizationSettings: {...},
 *     queryData: "<json>",   // double-encodé : string contenant le cache
 *     cookiePrefs: {...},
 *     manifest: {...}
 *   }
 *
 * et queryData = { mutations: [], queries: [{ queryKey, queryHash, state: { data, ... } }, ...] }
 *
 * Deux requêtes du cache contiennent les MÊMES données que les endpoints :
 *   - ['market', 'orderbook', 753, hash]
 *       → identique à /market/orderbook :
 *         { amtMaxBuyOrder, amtMinSellOrder, eCurrency, cBuyOrders, cSellOrders,
 *           rgCompactBuyOrders, rgCompactSellOrders }  (prix en CENTIMES)
 *   - ['market', 'pricehistory', 753, hash]
 *       → identique à /market/pricehistory :
 *         { ecurrency, prices: [{ time (unix sec), price_median, purchases }] }
 *
 * AVANTAGE : 1 requête page listing remplace 3 appels endpoints
 * (priceoverview + orderbook + pricehistory) → ~75 % de requêtes Steam en
 * moins par carte, donc moins de pression sur le rate limiting.
 *
 * LIMITE (mesurée empiriquement, sept. 2026) : pour les items à fort volume
 * de ventes (ex: cartes de jeux populaires), le chargement SSR échoue
 * ("Failed to load item description") et Steam sert une coquille VIDE :
 * ni cache embarqué, ni texte d'ordres. Les endpoints restent donc
 * indispensables en fallback (voir getListingPageData / market.js).
 *
 * Ce module est 100% pur (aucun import, aucun effet de bord) pour rester
 * testable isolément (node --test, scripts ad hoc).
 */

// ═══════════════════════════════════════════════════════════════
// Utilitaires prix (partagés avec market.js)
// ═══════════════════════════════════════════════════════════════

/**
 * Parse un prix Steam au format EUR (ex: "0,29€", "1 649,53€", "1.649,53€").
 * Retourne un float en EUR, ou null si le parsing échoue.
 */
export function parseSteamPriceEur(priceStr) {
    if (!priceStr) return null;
    let s = priceStr.replace(/[^\d.,]/g, ''); // Garder chiffres, points, virgules
    if (s.includes('.') && s.includes(',')) {
        // Les deux présents : point = milliers, virgule = décimal
        s = s.replace(/\./g, '').replace(',', '.');
    } else if (s.includes(',')) {
        // Seulement virgule : décimal
        s = s.replace(',', '.');
    }
    const val = parseFloat(s);
    return isNaN(val) ? null : val;
}

/**
 * Calcule la médiane d'un tableau de valeurs.
 */
export function median(values) {
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════
// Texte visible de la page listing (complément du cache SSR)
// ═══════════════════════════════════════════════════════════════

/**
 * Parse le texte visible de la page listing (SSR) pour les sell/buy orders.
 *
 * La page contient des spans avec des classes dynamiques (React) affichant:
 *   - "10 à vendre à partir de €0,97" (FR) / "10 for sale starting at €0.97" (EN)
 *   - "7 demandes d'achat à €0,09 ou moins" (FR) / "7 buy orders at €0.09 or lower" (EN)
 *
 * Le symbole € peut être avant ("€0,97") ou après ("0,97 €") le montant.
 * Les prix en $ (cookie sans préférence EUR) ne sont PAS parsés : la fonction
 * retourne null et l'appelant retombe sur les endpoints (évite d'écrire un
 * prix USD dans une colonne EUR).
 *
 * @param {string} html - HTML brut de la page listing
 * @returns {object|null} - { sellQty, sellPriceEur, buyQty, buyPriceEur } ou null
 */
export function parseListingText(html) {
    if (!html) return null;

    // Strip HTML tags pour obtenir du texte brut
    const text = html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#8364;/g, '€')
        .replace(/&euro;/g, '€')
        .replace(/&#x27;|&apos;/g, "'")
        .replace(/&#8239;/g, ' ') // espace fine insécable (séparateur de milliers Steam)
        .replace(/\s+/g, ' ');

    // Motif de prix : "0,97", "1 875,99", "1,875.99", "1875,99" — sans
    // absorber la quantité suivante ("0,97 7" → "0,97"). L'alternative avec
    // séparateurs de milliers exige au moins un groupe de 3 chiffres,
    // sinon un prix non groupé comme "1875,99" serait tronqué en "187".
    const PRICE = String.raw`\d{1,3}(?:[\s.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;

    // Sell orders : "10 à vendre à partir de €0,97" ou "10 à vendre à partir de 0,97 €"
    // (quantité en groupe 1 ; prix en groupe 2 si € avant, groupe 3 si € après)
    // - lookbehind (?<![\d.,]) : la quantité ne peut pas démarrer au milieu
    //   d'un prix (ex: le "97" de "0,97")
    const sellMatch = text.match(new RegExp(`(?<![\\d.,])(\\d[\\d\\s]*)\\s+(?:à vendre|for sale)[^€]*?(?:€\\s?(${PRICE})|(${PRICE})\\s?€)`, 'i'));

    // Buy orders : "7 demandes d'achat à €0,09 ou moins" ou "7 buy orders at €0.09 or lower"
    const buyMatch = text.match(new RegExp(`(?<![\\d.,])(\\d[\\d\\s]*)\\s+(?:demandes d'achat|buy orders)[^€]*?(?:€\\s?(${PRICE})|(${PRICE})\\s?€)`, 'i'));

    const sellQty = sellMatch ? parseInt(sellMatch[1].replace(/\s/g, ''), 10) : null;
    const sellPriceEur = sellMatch ? parseSteamPriceEur(sellMatch[2] ?? sellMatch[3]) : null;
    const buyQty = buyMatch ? parseInt(buyMatch[1].replace(/\s/g, ''), 10) : null;
    const buyPriceEur = buyMatch ? parseSteamPriceEur(buyMatch[2] ?? buyMatch[3]) : null;

    if (sellQty === null && buyQty === null) return null;

    return { sellQty, sellPriceEur, buyQty, buyPriceEur };
}

// ═══════════════════════════════════════════════════════════════
// Cache SSR (React Query déshydraté)
// ═══════════════════════════════════════════════════════════════

/**
 * Lit un littéral de string JSON à partir de sa quote d'ouverture.
 * Gère les échappements backslash (\" etc.).
 * @param {string} html - texte source
 * @param {number} start - index de la quote ouvrante (html[start] === '"')
 * @returns {string|null} - le littéral complet (avec quotes) ou null
 */
function readJsonStringLiteral(html, start) {
    if (html[start] !== '"') return null;
    let i = start + 1;
    while (i < html.length) {
        const c = html[i];
        if (c === '\\') { i += 2; continue; } // caractère échappé
        if (c === '"') return html.slice(start, i + 1);
        i++;
    }
    return null;
}

/**
 * Extrait la liste des queries du cache SSR embarqué dans la page listing.
 *
 * @param {string} html - HTML brut de la page
 * @returns {Array|null} - le tableau queries du cache React Query, ou null
 *   (page sans renderContext, structure inattendue, JSON invalide)
 */
export function parseSSRQueries(html) {
    try {
        const marker = 'window.SSR.renderContext';
        const ctxIdx = html.indexOf(marker);
        if (ctxIdx === -1) return null;

        const parseIdx = html.indexOf('JSON.parse(', ctxIdx);
        if (parseIdx === -1) return null;

        const quoteIdx = html.indexOf('"', parseIdx + 'JSON.parse('.length);
        if (quoteIdx === -1) return null;

        const literal = readJsonStringLiteral(html, quoteIdx);
        if (!literal) return null;

        // 1er décodage : JSON.parse renvoie une STRING (l'argument était
        // lui-même une string JSON) ; 2e décodage pour obtenir l'objet
        // renderContext { localizationSettings, queryData, ... }
        const ctx = JSON.parse(JSON.parse(literal));
        if (!ctx || typeof ctx.queryData !== 'string') return null;

        // 3e décodage : queryData est lui-même une string JSON
        const qdata = JSON.parse(ctx.queryData);
        if (!qdata || !Array.isArray(qdata.queries)) return null;

        return qdata.queries;
    } catch {
        return null;
    }
}

/**
 * Cherche une requête du cache SSR par son préfixe de queryKey.
 * Les queryKeys marché sont de la forme ['market', <name>, 753, <hash>].
 *
 * @param {Array} queries - tableau renvoyé par parseSSRQueries
 * @param {string} name - 'orderbook' | 'pricehistory' | 'description'
 * @returns {object|null} - le state.data de la requête, ou null
 */
export function findMarketQuery(queries, name) {
    if (!Array.isArray(queries)) return null;
    for (const q of queries) {
        const qk = q?.queryKey;
        if (Array.isArray(qk) && qk[0] === 'market' && qk[1] === name) {
            return q?.state?.data ?? null;
        }
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════
// Conversion des données SSR vers les formats du projet
// ═══════════════════════════════════════════════════════════════

/**
 * Normalise un orderbook SSR (payload market.orderbook du cache) en
 * informations exploitables.
 *
 * - Les PRIX ne sont exploitables en EUR que si eCurrency === 3
 *   (sinon prix à null — l'appelant retombe sur les endpoints).
 * - Les QUANTITÉS (sellQty, buyOrderQty, totaux) sont indépendantes de la
 *   devise et toujours exploitées.
 *
 * @param {object|null} orderbook - data de la requête market.orderbook
 * @returns {object|null} - { currency, pricesEur, sellPriceEur, sellQty,
 *   buyOrderEur, buyOrderQty, totalBuyOrders, totalSellOrders } ou null
 */
export function extractOrderbookInfo(orderbook) {
    if (!orderbook || typeof orderbook !== 'object') return null;

    const currency = Number(orderbook.eCurrency) || null;
    const pricesEur = currency === 3; // 3 = EUR (eCurrencyCode Steam)

    const compactSells = Array.isArray(orderbook.rgCompactSellOrders)
        ? orderbook.rgCompactSellOrders
        : [];

    return {
        currency,
        pricesEur,
        // Prix en centimes → EUR (uniquement si la devise est l'EUR)
        sellPriceEur: pricesEur && orderbook.amtMinSellOrder > 0 ? orderbook.amtMinSellOrder / 100 : null,
        sellQty: compactSells.length >= 2 ? compactSells[1] : null,
        buyOrderEur: pricesEur && orderbook.amtMaxBuyOrder > 0 ? orderbook.amtMaxBuyOrder / 100 : null,
        buyOrderQty: typeof orderbook.cBuyOrders === 'number' ? orderbook.cBuyOrders : null,
        totalBuyOrders: orderbook.cBuyOrders || 0,
        totalSellOrders: orderbook.cSellOrders || 0,
    };
}

/**
 * Convertit l'historique des ventes du cache SSR (market.pricehistory) en
 * "vente récente" — même sémantique que getRecentSale (market.js), qui
 * interroge l'endpoint /market/pricehistory.
 *
 * Format SSR :  { ecurrency, prices: [{ time (unix sec), price_median, purchases }] }
 * (l'endpoint renvoie ["Sep 19 2024 01: +0", prix, volume] — mêmes données,
 *  format différent)
 *
 * ATTENTION : contrairement à getRecentSale (toujours currency=3), la devise
 * du cache SSR suit le cookie de la requête. L'appelant DOIT vérifier
 * ecurrency === 3 avant d'utiliser les prix comme EUR.
 *
 * @param {object|null} pricehistory - data de la requête market.pricehistory
 * @param {number} days - fenêtre en jours (défaut: 7)
 * @returns {object|null} - { price, date, volume, salesCount, totalVolume,
 *   medianPrice, ecurrency } ou null si aucune vente dans la fenêtre
 */
export function recentSaleFromSSR(pricehistory, days = 7) {
    if (!pricehistory || !Array.isArray(pricehistory.prices)) return null;

    const ecurrency = Number(pricehistory.ecurrency) || null;
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const recentSales = [];

    for (const entry of pricehistory.prices) {
        const ts = Number(entry.time) * 1000; // secondes unix → ms
        if (ts > 0 && ts >= cutoff) {
            recentSales.push({
                date: ts,
                price: Number(entry.price_median),
                volume: parseInt(entry.purchases) || 1,
            });
        }
    }

    if (recentSales.length === 0) {
        return null; // Pas de vente dans la fenêtre
    }

    // Dernière vente (la plus récente)
    const lastSale = recentSales.reduce((latest, current) =>
        current.date > latest.date ? current : latest
    );

    const totalVolume = recentSales.reduce((sum, s) => sum + s.volume, 0);

    // Prix médian des ventes sur la fenêtre (pondéré par volume)
    const allPrices = [];
    for (const s of recentSales) {
        for (let i = 0; i < s.volume; i++) allPrices.push(s.price);
    }
    const medianPrice = median(allPrices);

    return {
        price: lastSale.price,
        date: lastSale.date,
        volume: lastSale.volume,
        salesCount: recentSales.length,
        totalVolume,
        medianPrice,
        ecurrency,
    };
}
