/**
 * test-ssrCache.mjs — Tests des helpers purs de ssrCache.js
 *
 * Auto-contenu : les fixtures sont générées inline (format identique aux
 * vraies pages listing Steam capturées en sept. 2026 — structure
 * window.SSR.renderContext double-encodée + texte SSR).
 *
 * Usage: node test-ssrCache.mjs
 */
import {
    parseSteamPriceEur,
    median,
    parseListingText,
    parseSSRQueries,
    findMarketQuery,
    extractOrderbookInfo,
    recentSaleFromSSR,
} from './src/ssrCache.js';

let passed = 0, failed = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  OK  ${label}`); }
    else { failed++; console.log(`  FAIL ${label}\n       attendu: ${JSON.stringify(expected)}\n       obtenu : ${JSON.stringify(actual)}`); }
}

// ═══════════════════════════════════════════════════════════════
// Fixtures : reproduction du format réel des pages listing Steam
// ═══════════════════════════════════════════════════════════════

/**
 * Construit une page listing avec cache SSR, au format réel observé :
 *   window.SSR.renderContext=JSON.parse("<ctx json double-échappé>")
 * où ctx = { localizationSettings, queryData: "<json double-échappé>", ... }
 * et queryData = { mutations: [], queries: [...] }
 */
function buildSSRPage(queries) {
    const ctx = {
        localizationSettings: { languages: [{ strLanguage: 'french', eSource: 4, strISOCode: 'fr' }] },
        queryData: JSON.stringify({ mutations: [], queries }),
        cookiePrefs: {},
        manifest: {},
    };
    // Double encodage comme Steam : JSON.parse(<string>) où <string>
    // décodé une fois donne le JSON de ctx
    const literal = JSON.stringify(JSON.stringify(ctx));
    return `<!DOCTYPE html><html><body><script>window.SSR={};window.SSR.loaderData=[];window.SSR.renderContext=JSON.parse(${literal});</script></body></html>`;
}

/** Page coquille (SSR échoué — items à fort volume), format réel observé. */
function buildShellPage() {
    const loader = JSON.stringify([
        JSON.stringify({ steamid: '0', bInsideModal: false, header: {} }),
        JSON.stringify({ backgroundAppID: 753, filterConfig: {}, marketEligibility: { bEligible: true }, loadID: 0.1 }),
        'true',
        JSON.stringify({ success: false, debug: 'Failed to load item description' }),
    ]);
    return `<!DOCTYPE html><html><body><script>window.SSR={};window.SSR.loaderData = ${loader};</script></body></html>`;
}

// Query orderbook au format réel (prix en CENTIMES, eCurrency)
const obQuery = (hash) => ({
    queryKey: ['market', 'orderbook', 753, hash],
    queryHash: '["market","orderbook",753,"' + hash + '"]',
    state: {
        data: {
            amtMaxBuyOrder: 95, amtMinSellOrder: 187599, eCurrency: 1,
            cBuyOrders: 50, cSellOrders: 1,
            rgCompactBuyOrders: [95, 1, 93, 1, 85, 1],
            rgCompactSellOrders: [187599, 1],
        },
        dataUpdateCount: 1, dataUpdatedAt: 1790259497989,
        error: null, fetchStatus: 'idle', isInvalidated: false, status: 'success',
    },
});

// Query pricehistory au format réel (time unix sec, price_median, purchases)
const histQuery = (hash, prices) => ({
    queryKey: ['market', 'pricehistory', 753, hash],
    queryHash: '["market","pricehistory",753,"' + hash + '"]',
    state: {
        data: { ecurrency: 1, prices },
        dataUpdateCount: 1, dataUpdatedAt: 1790259497981,
        error: null, fetchStatus: 'idle', isInvalidated: false, status: 'success',
    },
});

const nowSec = Math.floor(Date.now() / 1000);
const DAY = 86400;
// Carte active : ventes tous les jours (33 purchases sur 7j, comme la vraie capture Isolation)
const activePrices = [];
for (let d = 6; d >= 0; d--) {
    for (const [h, p, n] of [[1, 0.36, 1], [8, 0.35, 2], [16, 0.34, 2]]) {
        activePrices.push({ time: nowSec - d * DAY - h * 3600, price_median: p, purchases: n });
    }
}
activePrices.push({ time: nowSec - 400 * DAY, price_median: 0.5, purchases: 1 }); // vieux point hors fenêtre
// Carte illiquide : dernière vente en déc. 2021 (comme la vraie capture Servie)
const stalePrices = [
    { time: 1565481600, price_median: 0.23, purchases: 1 },
    { time: 1638316800, price_median: 5.37, purchases: 1 },
];

const serviePage = buildSSRPage([obQuery('616580-Servie'), histQuery('616580-Servie', stalePrices)]);
const isolationPage = buildSSRPage([obQuery('1040420-Isolation'), histQuery('1040420-Isolation', activePrices)]);
const shellPage = buildShellPage();

// ── parseSteamPriceEur ─────────────────────────────────────────
console.log('\n[parseSteamPriceEur]');
check('0,29€', parseSteamPriceEur('0,29€'), 0.29);
check('1 649,53€', parseSteamPriceEur('1 649,53€'), 1649.53);
check('1.649,53€', parseSteamPriceEur('1.649,53€'), 1649.53);
check('€0.97', parseSteamPriceEur('€0.97'), 0.97);
check('vide', parseSteamPriceEur(''), null);

// ── median ────────────────────────────────────────────────────
console.log('\n[median]');
check('[1,2,3]', median([1, 2, 3]), 2);
check('[1,2,3,4]', median([1, 2, 3, 4]), 2.5);

// ── parseSSRQueries + findMarketQuery (page avec cache SSR) ────
console.log('\n[parseSSRQueries — page avec cache SSR]');
const servieQueries = parseSSRQueries(serviePage);
check('queries trouvées (array)', Array.isArray(servieQueries), true);

const servieOb = findMarketQuery(servieQueries, 'orderbook');
check('orderbook présent', !!servieOb, true);
check('orderbook amtMaxBuyOrder', servieOb?.amtMaxBuyOrder, 95);
check('orderbook amtMinSellOrder', servieOb?.amtMinSellOrder, 187599);
check('orderbook cBuyOrders', servieOb?.cBuyOrders, 50);
check('orderbook cSellOrders', servieOb?.cSellOrders, 1);

const servieHist = findMarketQuery(servieQueries, 'pricehistory');
check('pricehistory présent', !!servieHist, true);
check('pricehistory nb points', servieHist?.prices?.length, 2);
check('pricehistory ecurrency', servieHist?.ecurrency, 1);

// ── extractOrderbookInfo ───────────────────────────────────────
console.log('\n[extractOrderbookInfo]');
const obInfo = extractOrderbookInfo(servieOb);
check('USD: pricesEur=false', obInfo.pricesEur, false);
check('USD: sellPriceEur null', obInfo.sellPriceEur, null);
check('USD: buyOrderEur null', obInfo.buyOrderEur, null);
check('USD: sellQty', obInfo.sellQty, 1);
check('USD: buyOrderQty', obInfo.buyOrderQty, 50);

const obEur = extractOrderbookInfo({ ...servieOb, eCurrency: 3 });
check('EUR: sellPriceEur', obEur.sellPriceEur, 1875.99);
check('EUR: buyOrderEur', obEur.buyOrderEur, 0.95);
check('EUR: pricesEur', obEur.pricesEur, true);

// ── recentSaleFromSSR ──────────────────────────────────────────
console.log('\n[recentSaleFromSSR]');
const servieSale = recentSaleFromSSR(servieHist, 7);
check('illiquide: null (aucune vente < 7j)', servieSale, null);

const isolationQueries = parseSSRQueries(isolationPage);
const isolationHist = findMarketQuery(isolationQueries, 'pricehistory');
const isoSale = recentSaleFromSSR(isolationHist, 7);
check('active: vente récente présente', isoSale !== null, true);
check('active: volume 7j', isoSale?.totalVolume, 35); // 7 jours × 5 purchases (1+2+2)
check('active: ecurrency', isoSale?.ecurrency, 1);
check('active: prix numérique', typeof isoSale?.price, 'number');
check('active: date = point le plus récent', isoSale?.date, (nowSec - 3600) * 1000);

// ── Page coquille (SSR absent) ─────────────────────────────────
console.log('\n[page coquille — SSR absent]');
const shellQueries = parseSSRQueries(shellPage);
const shellOb = shellQueries ? findMarketQuery(shellQueries, 'orderbook') : null;
const shellHist = shellQueries ? findMarketQuery(shellQueries, 'pricehistory') : null;
check('pas d\'orderbook SSR', shellOb, null);
check('pas de pricehistory SSR', shellHist, null);
check('pas de texte', parseListingText(shellPage), null);

// HTML sans renderContext du tout
check('page sans script SSR', parseSSRQueries('<html><body>rien</body></html>'), null);

// ── parseListingText ───────────────────────────────────────────
console.log('\n[parseListingText]');
const mk = (sell, buy) => `<div>${sell} ${buy}</div>`;

check('€ avant',
    parseListingText(mk('<span>10</span> à vendre à partir de <span>€0,97</span>', '<span>7</span> demandes d\'achat à <span>€0,09</span> ou moins')),
    { sellQty: 10, sellPriceEur: 0.97, buyQty: 7, buyPriceEur: 0.09 });

check('€ après',
    parseListingText(mk('<span>10</span> à vendre à partir de <span>0,97 €</span>', '<span>7</span> demandes d\'achat à <span>0,09 €</span> ou moins')),
    { sellQty: 10, sellPriceEur: 0.97, buyQty: 7, buyPriceEur: 0.09 });

check('entité &#x27; (apostrophe)',
    parseListingText(mk('<span>1</span> à vendre à partir de <span>€1 875,99</span>', '<span>50</span> demandes d&#x27;achat à <span>€0,95</span> ou moins')),
    { sellQty: 1, sellPriceEur: 1875.99, buyQty: 50, buyPriceEur: 0.95 });

check('version EN',
    parseListingText(mk('<span>10</span> for sale starting at <span>€0.97</span>', '<span>7</span> buy orders at <span>€0.09</span> or lower')),
    { sellQty: 10, sellPriceEur: 0.97, buyQty: 7, buyPriceEur: 0.09 });

// Prix à 4 chiffres sans séparateur de milliers (regression PRICE)
check('prix non groupé € avant (€1875,99)',
    parseListingText(mk('<span>1</span> à vendre à partir de <span>€1875,99</span>', '<span>50</span> demandes d\'achat à <span>€0,95</span> ou moins')),
    { sellQty: 1, sellPriceEur: 1875.99, buyQty: 50, buyPriceEur: 0.95 });

check('prix non groupé € après (1875,99 €)',
    parseListingText(mk('<span>1</span> à vendre à partir de <span>1875,99 €</span>', '<span>50</span> demandes d\'achat à <span>0,95 €</span> ou moins')),
    { sellQty: 1, sellPriceEur: 1875.99, buyQty: 50, buyPriceEur: 0.95 });

// La quantité suivant le prix ne doit pas être absorbée
check('prix suivi d\'une quantité (€0,97 7 demandes...)',
    parseListingText(mk('<span>10</span> à vendre à partir de <span>€0,97</span>', '<span>7</span> demandes d\'achat à <span>€0,09</span> ou moins')),
    { sellQty: 10, sellPriceEur: 0.97, buyQty: 7, buyPriceEur: 0.09 });

// Page en USD : les prix ne doivent PAS être parsés (sécurité devise)
check('page USD → texte null (prix non parsés)',
    parseListingText(mk('<span>1</span> à vendre à partir de <span>$1,875.99</span>', '<span>50</span> demandes d\'achat à <span>$0.95</span> ou moins')),
    null);

// Quantité avec séparateur de milliers
check('quantité 1 649',
    parseListingText(mk('<span>1 649</span> à vendre à partir de <span>€0,97</span>', '<span>7</span> demandes d\'achat à <span>€0,09</span> ou moins')),
    { sellQty: 1649, sellPriceEur: 0.97, buyQty: 7, buyPriceEur: 0.09 });

// ── Résumé ─────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}\n${passed} OK, ${failed} ÉCHEC(S)\n`);
process.exit(failed > 0 ? 1 : 0);
