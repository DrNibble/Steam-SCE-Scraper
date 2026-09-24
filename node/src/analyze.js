import { getGame, getCards, upsertGame, upsertCards, getMeta } from './db.js';
import { isSteamEvent, ES_log } from './utils.js';

/**
 * Analyse les donnees Steam et SCE pour determiner l etat de completion d un badge.
 * Port de analyzeBadgeStatus du script original.
 * @param {string} appid - L ID de l application
 * @returns {Object|null} L objet badge complete
 */
export function analyzeBadgeStatus(appid) {
    const gameRow = getGame(appid);
    if (!gameRow || gameRow.disabled) return null;

    const dbCards = getCards(appid);
    if (!dbCards || dbCards.length === 0) return null;

    // Convertit les rows DB en objets cartes
    // Inclut TOUS les champs prix marche Steam pour que upsertCards les preservent
    // (analyzeBadgeStatus est appele APRES fetchMarketPricesV2 en phase 2 :
    //  sans ces champs, upsertCards DELETE/re-INSERT et perd les valeurs)
    const cards = dbCards.map(c => ({
        name: c.name,
        qty: c.qty,
        index: c.card_index,
        inv: JSON.parse(c.inv_json || '[]'),
        hash: c.hash,
        'sce stock': c.sce_stock,
        'sce worth': c.sce_worth,
        'sce price': c.sce_price,
        'sce marketPriceUSD': c.sce_market_price_usd,
        'sce quick-trade': c.sce_quick_trade,
        steamMarketPriceEur: c.steam_market_price_eur,
        steamMarketLastSalePriceEur: c.steam_market_last_sale_price_eur,
        steamMarketSales7d: c.steam_market_sales_7d,
        steamMarketFetchedAt: c.steam_market_fetched_at,
        steamMarketSellPriceEur: c.steam_market_sell_price_eur,
        steamMarketSellQty: c.steam_market_sell_qty,
        steamMarketBuyOrderEur: c.steam_market_buy_order_eur,
        steamMarketBuyOrderQty: c.steam_market_buy_order_qty,
    }));

    // --- 1. CALCULS PREALABLES ---
    let maxPrice = 0;
    let expensiveCardName = '';
    let expensiveIsOwned = false;
    let totalAvailableFromBot = 0;
    let missingCount = 0;
    let totalCostSCE = 0;
    let allMissingAreAvailable = true;
    let totalOwnedQty = 0;

    cards.forEach(card => {
        let myQty = (card.inv ? card.inv.length : 0);
        card.qty = myQty;
        totalOwnedQty += myQty;

        // Prix marche Steam en EUR (uniquement si ventes recentes dans les 7 derniers jours)
        const sales7d = parseInt(card.steamMarketSales7d) || 0;
        const marketPrice = (sales7d > 0 && card.steamMarketPriceEur !== null)
            ? parseFloat(card.steamMarketPriceEur) || 0
            : 0;
        if (marketPrice > maxPrice) {
            maxPrice = marketPrice;
            expensiveCardName = card.name;
            expensiveIsOwned = (myQty > 0);
        }

        const stock = parseInt(card['sce stock']) || 0;
        if (stock > 1) {
            totalAvailableFromBot += (stock - 1);
        }

        if (myQty === 0) {
            missingCount++;
            if (stock > 1) {
                totalCostSCE += (parseInt(card['sce price']) || 0);
            } else {
                allMissingAreAvailable = false;
            }
        }
    });

    const currentCredit = parseInt(getMeta('scecredit', '0'), 10) || 0;

    const expensiveThreshold = 0.14;
    const isTooExpensive = (maxPrice > expensiveThreshold && !expensiveIsOwned);

    const expensiveInfo = maxPrice > expensiveThreshold
        ? { cardname: expensiveCardName, marketeurprice: maxPrice, isOwned: expensiveIsOwned }
        : null;

    // --- 2. DEFINITION DES INDICATEURS ---
    const setCardsTotal = gameRow.set_cards || 0;
    const isCompletableViaTrade = (totalOwnedQty >= setCardsTotal);

    let isCompletableViaSCE = (missingCount > 0) && allMissingAreAvailable && (totalCostSCE <= currentCredit);
    let isCompletableViaSCEdoublon = (missingCount > 0) && (totalAvailableFromBot >= missingCount) && (totalCostSCE <= currentCredit);
    let isCompletableViaSCEwobudget = (missingCount > 0) && allMissingAreAvailable;

    // --- 3. APPLICATION DU BLOCAGE ---
    if (isTooExpensive) {
        isCompletableViaSCE = false;
        isCompletableViaSCEwobudget = false;
        isCompletableViaSCEdoublon = false;
    }

    // --- 4. MISE A JOUR DE L OBJET ---
    const gameData = {
        ...gameRow,
        totalOwnedQty: totalOwnedQty,
        isCompletableViaTrade: isCompletableViaTrade,
        isCompletableViaSCE: isCompletableViaSCE,
        isCompletableviaSCEwobudget: isCompletableViaSCEwobudget,
        isCompletableviaSCEdoublon: isCompletableViaSCEdoublon,
        hasExpensiveCard: expensiveInfo,
        totalCostSCE: totalCostSCE,
        missingCount: missingCount,
    };

    // Sauvegarde en DB
    upsertGame(appid, gameData);

    // Met a jour les cartes avec qty recalcule
    upsertCards(appid, cards.map(c => ({
        ...c,
        qty: c.qty,
    })));

    ES_log(`[analyzeBadgeStatus] ${appid}: owned=${totalOwnedQty}/${setCardsTotal}, missing=${missingCount}, cost=${totalCostSCE}c`);

    return gameData;
}
