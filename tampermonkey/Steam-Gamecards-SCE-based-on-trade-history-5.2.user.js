// ==UserScript==
// @name         Steam-Gamecards-SCE based on API
// @namespace    http://tampermonkey.net/
// @version      0.5
// @description  Scrap complet Steam & SCE avec cache persistant, workers et API REST
// @author       DrNibble
// @match        https://steamcommunity.com/profiles/*/badges*
// @match        https://steamcommunity.com/my/badges*
// @match        https://steamcommunity.com/profiles/*/gamecards*
// @match        https://steamcommunity.com/my/gamecards*
// @match        https://steamcommunity.com/profiles/*/inventory*
// @match        https://steamcommunity.com/my/inventory*
// @match        https://steamcommunity.com/market/search*
// @match        https://steamcommunity.com/market/listings/753/*

// @grant        GM.xmlHttpRequest
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        unsafeWindow
// @connect      www.steamcardexchange.net
// @connect      steamcardexchange.net
// @connect      localhost
// @connect      127.0.0.1
// @connect      steamcommunity.com
// ==/UserScript==


(function() {
    'use strict';

    let profileLink = "my"
   // let mySteamID = profileLink;
    // Variable de cache persistante hors de la fonction
    let inventoryCache = null;

    const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const ES_log = (...args) => console.log("%c[DEBUG]", "color: #11ad11; font-weight: bold;", ...args);

    // --- CONFIG API REST ---
    // Le serveur API tourne sur le backend Node.js (npm run api ou integre au daemon npm run sync)
    // Modifiez API_BASE_URL si votre serveur tourne sur un autre hote/port
    const API_BASE_URL = 'http://127.0.0.1';
    const API_BASE_PORT = '3001';
    const WEB_BASE_PORT = '8080';

    // Initialisation de la structure de données
    win.ES = win.ES || {};
    win.ES.DATA = { scecredit: 0 };
    win.ES.CONCURRENCY_LIMIT = 4;
    win.ES.API_BASE_URL = API_BASE_URL + ':' + API_BASE_PORT;

    // --- UTILS ---
    win.ES.http = async function(url) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: "GET",
                url: url,
                onload: (res) => resolve(res.responseText),
                onerror: (err) => reject(err)
            });
        });
    };

    // --- API REST CLIENT ---
    // Recupere les donnees depuis le serveur API du backend Node.js.
    // Le serveur lit la base SQLite et retourne les donnees au format win.ES.DATA.
    win.ES.apiGet = async function(endpoint) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: "GET",
                url: `${API_BASE_URL}:${API_BASE_PORT}${endpoint}`,
                headers: { 'Accept': 'application/json' },
                timeout: 10000,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        try { resolve(JSON.parse(res.responseText)); }
                        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
                    } else {
                        reject(new Error(`API ${res.status}: ${res.responseText}`));
                    }
                },
                onerror: (err) => reject(err),
                ontimeout: () => reject(new Error('API timeout'))
            });
        });
    };

    // Fetch le dump complet depuis l'API (/api/data) et remplace win.ES.DATA.
    // Retourne true si le fetch a reussi, false sinon (fallback sur le cache local).
    win.ES.fetchAPIData = async function() {
        try {
            ES_log("[fetchAPIData] Recuperation des donnees depuis l'API...");
            const apiData = await win.ES.apiGet('/api/data');
            if (apiData && typeof apiData === 'object') {
                // L'API est la source de verite: on remplace les donnees locales
                // en preservant uniquement la structure de base
                win.ES.DATA = Object.assign({ scecredit: 0 }, apiData);
                const gameCount = Object.keys(apiData).filter(k => !isNaN(k)).length;
                ES_log(`[fetchAPIData] OK: ${gameCount} jeux charges depuis l'API.`);
                return true;
            }
        } catch (e) {
            ES_log(`[fetchAPIData] Echec API (${e.message}), fallback sur le cache local.`);
        }
        return false;
    };

    // Fetch un seul jeu depuis l'API (/api/games/:appid) avec ses cartes.
    win.ES.fetchAPIGame = async function(appid) {
        try {
            const game = await win.ES.apiGet(`/api/games/${appid}`);
            if (game && game.appid) {
                win.ES.DATA[appid] = Object.assign({}, win.ES.DATA[appid] || {}, game);
                ES_log(`[fetchAPIGame] OK: ${appid} charge depuis l'API.`);
                return game;
            }
        } catch (e) {
            ES_log(`[fetchAPIGame] Echec pour ${appid} (${e.message}).`);
        }
        return null;
    };

    win.ES.saveToCache = async function(appid = null) {
        // On écrit directement l'objet mémoire dans le stockage
        await GM.setValue("ES_DATA_CACHE", JSON.stringify(win.ES.DATA));

        if (appid) {
            ES_log(`[saveToCache] Appid ${appid} injecté en mémoire et synchronisé.`);
        } else {
            ES_log("[saveToCache] Cache global sauvegardé.");
        }
    };

    win.ES.loadFromCache = async function() {
        const raw = await GM.getValue("ES_DATA_CACHE", null);
        if (raw) {
            const parsed = JSON.parse(raw);
            // Fusion intelligente pour garder les fonctions si elles existent
            win.ES.DATA = Object.assign(win.ES.DATA, parsed);
        }
        return win.ES.DATA;
    };

    // --- NETTOYAGE NOMS ---
    win.ES.clean = function(str, fullNormalize = false) {
        if (!str) return "";
        let cleaned = str.toLowerCase().replace(/[\n\t\r]/g, "").replace(/\s{2,}/g, " ").trim();
        if (fullNormalize) {
            return cleaned
                .replace(/^badge\s+/i, "")
                .replace(/\(trading card\)$/i, "")
                .replace(/['":!?,.()]/g, "")
                .replace(/\s+/g, ' ')
                .trim();
        }
        return cleaned;
    };

    /////////////////////////////////////////////////////////////////////////////////////////////
    ///////////////////////////////// SCE FETCH //////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////////////////////////

    // --- HTTP WRAPPER pour SCE (GM.xmlHttpRequest avec cookies navigateur) ---
    win.ES.sceHttpGet = async function(url) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: "GET",
                url: url,
                timeout: 15000,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        resolve(res.responseText);
                    } else {
                        reject(new Error(`SCE HTTP ${res.status} pour ${url}`));
                    }
                },
                onerror: (err) => reject(err),
                ontimeout: () => reject(new Error('SCE timeout'))
            });
        });
    };

    // --- FETCH SCE GLOBAL INFO (credit, pending offers, wait time) ---
    win.ES._creditFetched = false;
    win.ES.fetchSCEGlobalInfo = async function() {
        if (win.ES._creditFetched) return;

        try {
            ES_log("[fetchSCEGlobalInfo] Récupération profil SCE...");
            const profileHtml = await win.ES.sceHttpGet("https://www.steamcardexchange.net/index.php?profile");

            // Detection du mur de connexion
            if (profileHtml.includes('Please login to see your profile')) {
                console.warn("[SCE] Session SCE expirée ou non connecté. Connectez-vous sur steamcardexchange.net dans ce navigateur.");
                win.ES.DATA.scecredit = 0;
                win.ES.DATA.scePendingOffers = 0;
                win.ES.DATA.sceWaitTime = 0;
                win.ES._creditFetched = true;
                return;
            }

            const doc = new DOMParser().parseFromString(profileHtml, "text/html");

            // --- Credit ---
            let rawCreditText = "";
            const creditEl = doc.querySelector('.inventory-user-credits .number');
            if (creditEl) {
                rawCreditText = creditEl.textContent;
            } else {
                const desktopCreditEl = doc.querySelector('nav .hidden.lg\\:block button div.ml-auto');
                if (desktopCreditEl) rawCreditText = desktopCreditEl.textContent;
            }
            // Fallback: chercher un element contenant un nombre + "credit"
            if (!rawCreditText) {
                doc.querySelectorAll('nav span, nav button, nav div').forEach(el => {
                    const text = el.textContent.trim();
                    if (/^\d+\s*c$/i.test(text) || /^\d+\s*credits?$/i.test(text) || /^credits?:\s*\d+$/i.test(text)) {
                        rawCreditText = text;
                    }
                });
            }
            win.ES.DATA.scecredit = parseInt(rawCreditText.replace(/\D/g, ""), 10) || 0;

            // --- Pending offers + wait time ---
            let pendingOffers = 0;
            let waitTime = 0;
            let foundStatus = false;

            const infoSpans = doc.querySelectorAll('div.bg-gray-light span, div.bg-gray-lighter span');
            for (const span of infoSpans) {
                const text = span.textContent;
                if (text.includes('offers pending')) {
                    const pendingMatch = text.match(/(\d+)\s+offers\s+pending/i);
                    pendingOffers = pendingMatch ? parseInt(pendingMatch[1], 10) : 0;
                    const waitMatch = text.match(/wait\s+time\s+is\s+([\d.]+)\s+minutes/i);
                    waitTime = waitMatch ? parseFloat(waitMatch[1]) : 0;
                    foundStatus = true;
                    break;
                }
            }

            // Fallback: page inventory
            if (!foundStatus) {
                try {
                    const invHtml = await win.ES.sceHttpGet("https://www.steamcardexchange.net/index.php?inventory");
                    const invDoc = new DOMParser().parseFromString(invHtml, "text/html");
                    invDoc.querySelectorAll('span').forEach(span => {
                        const text = span.textContent;
                        if (text.includes('offers pending')) {
                            const pendingMatch = text.match(/(\d+)\s+offers\s+pending/i);
                            pendingOffers = pendingMatch ? parseInt(pendingMatch[1], 10) : 0;
                            const waitMatch = text.match(/wait\s+time\s+is\s+([\d.]+)\s+minutes/i);
                            waitTime = waitMatch ? parseFloat(waitMatch[1]) : 0;
                            foundStatus = true;
                        }
                    });
                } catch (e) {
                    ES_log(`[fetchSCEGlobalInfo] Erreur page inventory: ${e.message}`);
                }
            }

            win.ES.DATA.scePendingOffers = pendingOffers;
            win.ES.DATA.sceWaitTime = waitTime;
            win.ES._creditFetched = true;
            ES_log(`[fetchSCEGlobalInfo] Crédit: ${win.ES.DATA.scecredit} | File: ${pendingOffers} offres | WaitTime: ${waitTime} min.`);
        } catch (e) {
            console.warn("[fetchSCEGlobalInfo] Erreur:", e);
            win.ES._creditFetched = true; // Evite les retries en boucle
        }
    };

    // --- FETCH SCE GAME PAGE (prix USD + check trade-in disabled) ---
    // Retourne { html, tradeInDisabled } ou null si page login/erreur
    win.ES.fetchSCEGamePage = async function(appid) {
        const html = await win.ES.sceHttpGet(`https://www.steamcardexchange.net/index.php?gamepage-appid-${appid}/`);
        if (!html) return null;
        // Detection page login
        if (html.includes('Please login')) return null;
        // Detection trade-in disabled
        if (html.includes('Trade-in disabled')) return { html: null, tradeInDisabled: true };
        // Verification: la section Trading Cards doit exister
        const doc = new DOMParser().parseFromString(html, "text/html");
        const sectionHeader = doc.querySelector('#series-1-cards')?.closest('div.bg-gray-dark');
        if (!sectionHeader) return null; // Page invalide ou structure inattendue
        return { html, tradeInDisabled: false };
    };

    // --- PARSE SCE GAME PRICES (USD) depuis le HTML de la gamepage ---
    win.ES.parseSCEGamePrices = function(html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const priceMap = {};
        const sectionHeader = doc.querySelector('#series-1-cards')?.closest('div.bg-gray-dark');
        if (!sectionHeader) return priceMap;
        const grid = sectionHeader.nextElementSibling;
        if (!grid || !grid.classList.contains('grid')) return priceMap;

        grid.querySelectorAll('div.flex.flex-col').forEach(block => {
            const nameEl = block.querySelector('div.text-sm.text-center.break-words');
            const priceLink = block.querySelector('a.btn-primary');
            if (!nameEl || !priceLink) return;
            const match = priceLink.textContent.match(/Price:\s*\$([\d.,]+)/i);
            if (!match) return;
            const price = parseFloat(match[1].replace(/,/g, ''));
            if (!isNaN(price)) {
                priceMap[win.ES.clean(nameEl.textContent.trim(), true)] = price;
            }
        });
        return priceMap;
    };

    // --- FETCH SCE INVENTORY (stock, worth, price, quick-trade) ---
    // Retourne null si page login/erreur, sinon un Map des cartes
    win.ES.fetchSCEInventory = async function(appid) {
        const html = await win.ES.sceHttpGet(`https://www.steamcardexchange.net/index.php?inventorygame-appid-${appid}`);
        if (!html || html.includes('Please login')) return null;
        const doc = new DOMParser().parseFromString(html, "text/html");
        const inventoryMap = {};

        doc.querySelectorAll('div.flex.flex-col.items-center.p-5').forEach(block => {
            const nameEl = block.querySelector('div.text-sm.break-words');
            if (!nameEl) return;
            const name = nameEl.textContent.trim();

            // Stock
            let stock = 0;
            block.querySelectorAll('div').forEach(div => {
                if (div.textContent.includes('Stock:')) {
                    const match = div.textContent.match(/Stock:\s*(\d+)/i);
                    if (match) stock = parseInt(match[1], 10);
                }
            });

            // Worth & Price
            let worth = 0;
            let price = 0;
            block.querySelectorAll('div.mt-auto.text-sm > div').forEach(line => {
                const text = line.textContent.toLowerCase();
                const valueSpan = line.querySelector('span.font-open-sans');
                if (!valueSpan) return;
                const val = parseInt(valueSpan.textContent, 10) || 0;
                if (text.includes('worth')) worth = val;
                if (text.includes('price')) price = val;
            });

            let tradeLink = block.querySelector('a.btn-primary')?.href || '';
            if (tradeLink && !tradeLink.startsWith('http')) {
                tradeLink = 'https://www.steamcardexchange.net' + (tradeLink.startsWith('/') ? '' : '/') + tradeLink;
            }

            inventoryMap[win.ES.clean(name, true)] = { stock, worth, price, quickTrade: tradeLink, originalName: name };
        });

        ES_log(`[fetchSCEInventory] ${Object.keys(inventoryMap).length} cartes trouvées pour appid ${appid}.`);
        return inventoryMap; // Peut être vide si la page n'a pas de cartes, mais c'est valide
    };

    // --- FETCH SCE FRESH (combine tout: global info + game page + inventory) ---
    win.ES.fetchSCEFresh = async function(appid) {
        if (win.ES.isSteamEvent(appid)) return null;

        ES_log(`[fetchSCEFresh] START ${appid}`);

        // Init structure si inexistante
        if (!win.ES.DATA[appid]) {
            win.ES.DATA[appid] = { appid: appid, cards: [] };
        }

        if (win.ES.DATA[appid].disabled) return null;

        // 1. Infos globales (credit, pending offers)
        await win.ES.fetchSCEGlobalInfo();

        // 2. Game page (prix USD + check trade-in disabled)
        const gamePageResult = await win.ES.fetchSCEGamePage(appid);
        if (!gamePageResult) {
            ES_log(`[fetchSCEFresh] Page SCE invalide ou login requis pour ${appid}. Conservation du cache.`);
            return null; // Ne modifie pas disabled, ne merge pas
        }
        if (gamePageResult.tradeInDisabled) {
            ES_log(`[fetchSCEFresh] Trade-in désactivé pour ${appid}.`);
            win.ES.DATA[appid].disabled = true;
            return null;
        }
        const marketPrices = win.ES.parseSCEGamePrices(gamePageResult.html);
        ES_log(`[fetchSCEFresh] ${Object.keys(marketPrices).length} prix USD extraits de la gamepage.`);

        // 3. Inventaire SCE (stock, worth, price, quick-trade)
        const inventoryMap = await win.ES.fetchSCEInventory(appid);
        if (inventoryMap === null) {
            ES_log(`[fetchSCEFresh] Page inventory SCE invalide ou login requis pour ${appid}. Fusion des prix uniquement.`);
        }

        // 4. Fusion dans les cartes existantes (non-destructif: préserve les valeurs si SCE ne retourne pas une carte)
        const data = win.ES.DATA[appid];

        // FALLBACK: Si aucune carte n'existe (appid absent de l'API), on crée les cartes
        // à partir des données SCE (inventory map + market prices).
        if (data && (!data.cards || data.cards.length === 0)) {
            const allNames = new Set([
                ...Object.keys(marketPrices),
                ...(inventoryMap ? Object.keys(inventoryMap) : [])
            ]);
            if (allNames.size > 0) {
                ES_log(`[fetchSCEFresh] Appid ${appid} absent de l'API — création de ${allNames.size} carte(s) depuis SCE.`);
                data.cards = [...allNames].map((normName, i) => {
                    // Retrouver le nom original depuis l'inventory map (non normalisé)
                    let originalName = normName;
                    if (inventoryMap) {
                        const invEntry = Object.entries(inventoryMap).find(([k]) => k === normName);
                        if (invEntry) originalName = invEntry[1].originalName || normName;
                    }
                    const inv = inventoryMap && inventoryMap[normName];
                    return {
                        name: originalName,
                        qty: 0,
                        index: i,
                        inv: [],
                        hash: `${appid}-${originalName}`,
                        iconUrl: '',
                        artUrl: '',
                        "sce stock": inv ? inv.stock : 0,
                        "sce worth": inv ? inv.worth : 0,
                        "sce price": inv ? inv.price : 0,
                        "sce marketPriceUSD": marketPrices[normName] || 0,
                        steamMarketPriceEur: marketPrices[normName] ? Math.round(marketPrices[normName] * 0.92 * 100) / 100 : null,
                        steamMarketSales7d: null,
                        steamMarketSellPriceEur: null,
                        steamMarketSellQty: null,
                        steamMarketBuyOrderEur: null,
                        steamMarketBuyOrderQty: null,
                        "sce quick-trade": inv ? (inv.quickTrade || "") : ""
                    };
                });
            }
        }

        if (data && data.cards && data.cards.length > 0) {
            data.cards = data.cards.map(card => {
                const normName = win.ES.clean(card.name, true);
                const hasInv = inventoryMap && Object.prototype.hasOwnProperty.call(inventoryMap, normName);
                const hasMarket = Object.prototype.hasOwnProperty.call(marketPrices, normName);
                const inv = hasInv ? inventoryMap[normName] : null;

                return {
                    ...card,
                    "sce stock": hasInv ? inv.stock : (card["sce stock"] ?? 0),
                    "sce worth": hasInv ? inv.worth : (card["sce worth"] ?? 0),
                    "sce price": hasInv ? inv.price : (card["sce price"] ?? 0),
                    "sce marketPriceUSD": hasMarket ? marketPrices[normName] : (card["sce marketPriceUSD"] ?? 0),
                    "sce quick-trade": hasInv ? (inv.quickTrade || "") : (card["sce quick-trade"] ?? "")
                };
            });
        }

        data.disabled = false;
        data.fetchedAt = Date.now();

        ES_log(`[fetchSCEFresh] Appid ${appid} enrichi et fusionné avec succès.`);
        return data;
    };

    // --- ANALYZE BADGE STATUS (non-destructif: préserve les champs existants) ---
    win.ES.analyzeBadgeStatus = function(appid) {
        const data = win.ES.DATA[appid];
        if (!data || data.disabled || !data.cards || data.cards.length === 0) return null;

        const setCardsTotal = parseInt(data.setCards, 10) || 0;
        if (setCardsTotal <= 0) return data; // Garde-fou: ne pas calculer sans setCards

        let maxPrice = 0;
        let expensiveCardName = "";
        let expensiveIsOwned = false;
        let totalAvailableFromBot = 0;
        let missingCount = 0;
        let totalCostSCE = 0;
        let allMissingAreAvailable = true;
        let totalOwnedQty = 0;

        data.cards.forEach(card => {
            let myQty = (card.inv ? card.inv.length : 0);
            card.qty = myQty;
            totalOwnedQty += myQty;

            // Prix: prioriser steamMarketPriceEur (si ventes 7j), sinon fallback SCE USD * 0.92
            const sales7d = parseInt(card.steamMarketSales7d) || 0;
            const steamPriceEur = (sales7d > 0 && card.steamMarketPriceEur != null)
                ? parseFloat(card.steamMarketPriceEur) || 0
                : 0;
            const priceUSD = parseFloat(card["sce marketPriceUSD"]) || 0;
            const priceEUR = steamPriceEur > 0
                ? steamPriceEur
                : (priceUSD > 0 ? Math.round(priceUSD * 0.92 * 100) / 100 : 0);
            if (priceEUR > maxPrice) {
                maxPrice = priceEUR;
                expensiveCardName = card.name;
                expensiveIsOwned = (myQty > 0);
            }

            const stock = parseInt(card["sce stock"]) || 0;
            if (stock > 1) totalAvailableFromBot += (stock - 1);

            if (myQty === 0) {
                missingCount++;
                if (stock > 1) {
                    totalCostSCE += (parseInt(card["sce price"]) || 0);
                } else {
                    allMissingAreAvailable = false;
                }
            }
        });

        const currentCredit = win.ES.DATA.scecredit || 0;
        const expensiveThreshold = 0.14;
        const isTooExpensive = (maxPrice > expensiveThreshold && !expensiveIsOwned);
        const expensiveInfo = maxPrice > expensiveThreshold
            ? { cardname: expensiveCardName, marketeurprice: maxPrice, isOwned: expensiveIsOwned }
            : null;

        const isCompletableViaTrade = (totalOwnedQty >= setCardsTotal);
        let isCompletableViaSCE = (missingCount > 0) && allMissingAreAvailable && (totalCostSCE <= currentCredit);
        let isCompletableviaSCEdoublon = (missingCount > 0) && (totalAvailableFromBot >= missingCount) && (totalCostSCE <= currentCredit);
        let isCompletableviaSCEwobudget = (missingCount > 0) && allMissingAreAvailable;

        if (isTooExpensive) {
            isCompletableViaSCE = false;
            isCompletableviaSCEwobudget = false;
            isCompletableviaSCEdoublon = false;
        }

        // Mise à jour non-destructive: on ne touche qu'aux champs calculés
        data.totalOwnedQty = totalOwnedQty;
        data.isCompletableViaTrade = isCompletableViaTrade;
        data.isCompletableViaSCE = isCompletableViaSCE;
        data.isCompletableviaSCEwobudget = isCompletableviaSCEwobudget;
        data.isCompletableviaSCEdoublon = isCompletableviaSCEdoublon;
        // hasExpensiveCard: seulement si on a un prix, sinon on conserve la valeur existante
        if (maxPrice > 0) {
            data.hasExpensiveCard = expensiveInfo;
        }
        data.totalCostSCE = totalCostSCE;
        data.missingCount = missingCount;

        ES_log(`[analyzeBadgeStatus] ${appid}: owned=${totalOwnedQty}/${setCardsTotal}, missing=${missingCount}, cost=${totalCostSCE}c`);
        return data;
    };

    /**
 * Vérifie si un badge appartient à la catégorie "Événements Steam"
 * (Soldes, Steam Awards, etc.)
 * @param {string} appId - L'ID de l'application
 * @param {string} gameName - Le nom du jeu/badge
 * @returns {boolean} - true si c'est un événement à exclure
 */
    win.ES.isSteamEvent = function(appId, gameName) {
        // Liste des AppIDs d'événements Steam (convertis en Set pour la performance)
        const eventAppIds = new Set([
            '335590', '365960', '425280', '483980', '566020',
            '639900', '762800', '876740', '991980', '1096040',
            '1263330', '1343890', '1493030', '1658760', '1790600',
            '1926100', '2243720', '2459330', '2640160', '2861690',
            '3344600', '3558940','866860','1083560','1442870','3558940','1195670'
        ]);

        // 1. Vérification par ID (conversion en string forcée pour correspondre au Set)
        if (eventAppIds.has(String(appId))) {
            return true;
        }

        // 2. Vérification par mots-clés dans le nom (RegExp regroupée)
        // Inclut: Sale 20xx, Soldes, Steam Awards, Holiday Sale
        const eventPattern = /Sale 20\d{2}|Soldes d'été|Soldes d'hiver|Les Steam Awards|Holiday Sale/i;

        if (gameName && eventPattern.test(gameName)) {
            return true;
        }

        return false;
    };

    /**
     * RÉCUPÉRATION DES APPIDS ET GAMENAMES SUR LA PAGE DES BADGES
     */
    function getPageAppids() {
        const rows = document.querySelectorAll('.badge_row');
ES_log("[getPageAppids] Entrée fonction");
        return Array.from(rows).map(row => {
            const link = row.querySelector('.badge_row_overlay');
            const titleEl = row.querySelector('.badge_title');

            if (link && titleEl) {
                const match = link.href.match(/\/gamecards\/(\d+)/);
                if (match) {
                    const appId = match[1];

                    // --- FILTRAGE ---
                    let gameName = titleEl.innerText
                    .replace(/Voir les détails/gi, '')
                    .replace(/Badge de collectionneur/gi, '')
                    .trim();

                    // On ignore si :
                    // 1. L'AppID est dans la liste des événements
                    // 2. Le nom contient des mots-clés de "Fête" ou "Soldes"
                    const isEvent = win.ES.isSteamEvent(appId, gameName);

                    // Remplissage ou mise à jour de ES.DATA
                    if (!win.ES.DATA[appId]) {
                        win.ES.DATA[appId] = {};
                    }

                    if (isEvent) {
                        win.ES.DATA[appId].disabled = true;
                        win.ES.DATA[appId].appid = appId;
                        win.ES.DATA[appId].gamename = gameName;
                        return null;
                    }

                    win.ES.DATA[appId].appid = appId;
                    win.ES.DATA[appId].gamename = gameName;
                    ES_log("[getPageAppids] appid: ",appId," gamename: ",gameName);

                    return {
                        appid: appId,
                        gamename: gameName
                    };
                }
            }
            return null;
        }).filter(item => item !== null);
    }

    // --- UI UPDATE ---
    win.ES.updateBadgeUI = function() {
        const badgeRows = document.querySelectorAll('.badge_row');

        badgeRows.forEach(row => {
            const cardLink = row.querySelector('a[href*="/gamecards/"]');
            if (!cardLink) return;

            const match = cardLink.href.match(/\/gamecards\/(\d+)/);
            if (!match) return;

            const currentAppid = match[1];
            const data = win.ES.DATA[currentAppid];

            if (!data || typeof data === 'undefined') {
                return;
            }

            // --- GESTION DU CONTENEUR ---
            let statusContainer = row.querySelector('.es-status-container');
            if (!statusContainer) {
                statusContainer = document.createElement('div');
                statusContainer.className = 'es-status-container';
                statusContainer.style.cssText = 'margin-top: 10px; font-size: 11px; font-weight: bold; display: flex; flex-direction: column; gap: 4px;';

                const target = row.querySelector('.badge_row_inner_qty') || row.querySelector('.badge_title');
                if (target) target.appendChild(statusContainer);
            }
            statusContainer.innerHTML = ''; // Reset
            win.ES.renderStatusLabels(currentAppid, statusContainer);
        });
    };

    // --- RENDU DES LABELS (réutilisable) ---
    // Affiche les labels de statut pour un appid donné dans le conteneur fourni.
    // Utilisé par updateBadgeUI (page /badges) et renderGamecardStatus (page /gamecards).
    win.ES.renderStatusLabels = function(appid, statusContainer) {
        const data = win.ES.DATA[appid];
        if (!data || typeof data === 'undefined') return;

        // 1. VERT : Steam Trade (Doublons physiques déjà présents sur Steam)
        if (data.isCompletableViaTrade) {
            createStatusLabel(statusContainer, '#a3d200', '✔ Prêt : Craft possible via échange');
        }

        // 2. BLEU : SCE Status (Crédits suffisants)
        if (data.isCompletableViaSCE) {
            const label = createStatusLabel(statusContainer, '#66c0f4', `🔹 Achetable via SCE (Coût: ${data.totalCostSCE}c)`);
            label.style.cursor = "pointer";
            label.onclick = (e) => {
                e.stopPropagation();
                window.open(`https://www.steamcardexchange.net/index.php?inventorygame-appid-${appid}`, '_blank');
            };
        }

        // 3. MAUVE : SCE Doublon (Le bot a le stock ET tu as assez de crédits/matière)
        // On ne l'affiche que si on n'a pas déjà le badge "Steam Trade" pour éviter le doublon visuel
        if (data.isCompletableviaSCEdoublon && !data.isCompletableViaTrade) {
            createStatusLabel(statusContainer, '#a55eea', `♻ Échangeable : Stock Bot OK + Crédits OK`);
        }

        // 4. GRIS / ROUGE : SCE WO Budget (Potentiel technique sans condition de crédit)
        // Affiché seulement si on n'a pas assez de crédits (sinon le label BLEU suffit)
        if (data.isCompletableviaSCEwobudget && !data.isCompletableViaSCE && !data.isCompletableviaSCEdoublon) {
            const creditManquant = data.totalCostSCE - (win.ES.DATA.scecredit || 0);
            createStatusLabel(statusContainer, '#95a5a6', `ℹ Dispo chez SCE (Manque ${creditManquant}c)`);
        }

        // 5. ORANGE : Carte de valeur (Attention / Investissement)
        if (data.hasExpensiveCard) {
            const info = data.hasExpensiveCard;
            const ownedText = info.isOwned ? " (Possédée 💰)" : " (Manquante 💸)";
            // Vert si possédée, Orange si elle bloque le badge
            const color = info.isOwned ? '#a3d200' : '#e67e22';

            // Prix: prioriser marketeurprice (API), sinon fallback sur sce marketPriceUSD
            let displayPrice = info.marketeurprice;
            if (displayPrice == null) {
                const card = data.cards && data.cards.find(c => c.name && c.name.trim().toLowerCase() === info.cardname.trim().toLowerCase());
                const priceUSD = card ? parseFloat(card["sce marketPriceUSD"]) || 0 : 0;
                if (priceUSD > 0) {
                    displayPrice = Math.round(priceUSD * 0.92 * 100) / 100;
                }
            }

            createStatusLabel(statusContainer, color, `💎 ${info.cardname} (${displayPrice != null ? displayPrice.toFixed(2) + '€' : 'N/A'})${ownedText}`);
        }
    };

    // --- RENDU DES LABELS SUR LA PAGE GAMECARDS ---
    // Crée un conteneur de statut sur la page /gamecards/:appid et affiche les labels.
    win.ES.renderGamecardStatus = function(appId) {
        const data = win.ES.DATA[appId];
        if (!data || typeof data === 'undefined') {
            ES_log(`[renderGamecardStatus] Pas de données pour ${appId}`);
            return;
        }

        // Cherche un conteneur existant ou en crée un nouveau
        let statusContainer = document.querySelector('.es-gamecard-status');
        if (!statusContainer) {
            statusContainer = document.createElement('div');
            statusContainer.className = 'es-gamecard-status es-status-container';
            statusContainer.style.cssText = 'margin: 10px 0; font-size: 11px; font-weight: bold; display: flex; flex-direction: column; gap: 4px;';

            // Insère le conteneur avant la grille de cartes
            const target = document.querySelector('.badge_detail_card_set')
                || document.querySelector('.badge_cards')
                || document.querySelector('.badge_title')
                || document.querySelector('.maincontent');
            if (target) {
                target.parentNode.insertBefore(statusContainer, target);
            } else {
                // Fallback: ajouter au début du contenu principal
                const main = document.querySelector('.responsive_page_template_content');
                if (main) main.prepend(statusContainer);
            }
        }
        statusContainer.innerHTML = ''; // Reset

        win.ES.renderStatusLabels(appId, statusContainer);
        ES_log(`[renderGamecardStatus] Labels rendus pour ${appId}`);
    };

    function createStatusLabel(container, color, text) {
        const div = document.createElement('div');
        div.style.cssText = `
        color: ${color};
        padding: 4px 8px;
        border-left: 4px solid ${color};
        margin-bottom: 2px;
        background: rgba(0,0,0,0.3);
        border-radius: 0 4px 4px 0;
        width: fit-content;
        white-space: nowrap;
    `;
        div.innerText = text;
        container.appendChild(div);
        return div; // On retourne l'élément pour pouvoir y ajouter des events (onclick)
    }

    /**
     * Formate les infos marché pour l'affichage.
     * @param {object} info - { sellQty, sellPriceEur, buyQty, buyPriceEur }
     * @returns {string} - ex: "sell: 10 @ 0.97€ | buy: 7 @ 0.09€"
     */
    win.ES.formatMarketInfo = function(info) {
        if (!info) return '';
        const parts = [];
        if (info.sellQty != null && info.sellPriceEur != null) {
            parts.push(`sell: ${info.sellQty} @ ${info.sellPriceEur}€`);
        }
        if (info.buyQty != null && info.buyPriceEur != null) {
            parts.push(`buy: ${info.buyQty} @ ${info.buyPriceEur}€`);
        }
        return parts.join(' | ');
    };

    win.ES.injectQuickTradeButtons = function(appId) {
        const gameData = win.ES.DATA[appId];
        if (!gameData || !gameData.cards) return;

        // Utilise .game_card_ctn (ou .game_card_ctn.with_zoom pour les cartes possédées)
        const gridCards = document.querySelectorAll(".game_card_ctn");

        gridCards.forEach((block) => {
            // .badge_card_set_title est un sibling de .game_card_ctn (tous deux enfants de .badge_card_set_card)
            const titleEl = block.parentElement.querySelector(".badge_card_set_title");
            if (!titleEl) return;

            titleEl.style.display = "flex";
            titleEl.style.flexDirection = "row";
            titleEl.style.alignItems = "center";
            titleEl.style.width = "100%";

            let rawName = "";
            Array.from(titleEl.childNodes).forEach(node => {
                if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== "") {
                    rawName += node.textContent.trim();
                    node.textContent = "";
                }
            });

            let nameSpan = titleEl.querySelector(".es-card-name");
            if (!nameSpan && rawName !== "") {
                nameSpan = document.createElement('span');
                nameSpan.className = "es-card-name";
                nameSpan.style.cssText = "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
                nameSpan.innerText = rawName;
                titleEl.prepend(nameSpan);
            }

            const cleanName = rawName.toLowerCase();
            const cardInfo = gameData.cards.find(c => c.name.trim().toLowerCase() === cleanName);

            if (cardInfo && !titleEl.querySelector(".es-stock-display")) {
                const stock = cardInfo["sce stock"] || 0;
                const stockSpan = document.createElement('span');
                stockSpan.className = "es-stock-display";

                // 1. Appliquer le style de base d'abord
                stockSpan.style.cssText = `
                color: #57cbde !important;
                font-weight: bold;
                font-size: 11px;
                margin-left: auto;
                margin-right: 5px;
                white-space: nowrap;
            `;

                // 2. Ajouter les propriétés de clic si nécessaire
                if (stock > 1) {
                    const quickTradeUrl = cardInfo["sce quick-trade"];
                    if (quickTradeUrl) {
                        stockSpan.style.cursor = "pointer";
                        stockSpan.style.textDecoration = "underline";
                        stockSpan.title = "Lancer Quick-Trade sur SCE";

                        stockSpan.onclick = (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            window.open(quickTradeUrl, '_blank');
                        };
                    }
                }

                stockSpan.innerText = `(${stock})`;

                const steamQty = titleEl.querySelector(".badge_card_set_text_qty");
                if (steamQty) {
                    titleEl.insertBefore(stockSpan, steamQty);
                    steamQty.style.float = "none";
                    steamQty.style.display = "inline-block";
                } else {
                    titleEl.appendChild(stockSpan);
                }
            }

            const clearDiv = titleEl.querySelector('div[style*="clear"]');
            if (clearDiv && clearDiv.parentNode) clearDiv.parentNode.removeChild(clearDiv);

            // --- MARKET INFO dans .game_card_ctn (API uniquement, pas de fallback fetch listing) ---
            if (cardInfo) {
                let marketDiv = block.querySelector(".es-market-info");
                if (!marketDiv) {
                    marketDiv = document.createElement('div');
                    marketDiv.className = "es-market-info";
                    marketDiv.style.cssText = `
                        position: absolute;
                        bottom: 4px;
                        left: 4px;
                        right: 4px;
                        font-size: 10px;
                        font-weight: bold;
                        color: rgb(87, 203, 222) !important;
                        background: rgba(0,0,0,0.7);
                        padding: 2px 4px;
                        border-radius: 2px;
                        pointer-events: none;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                    `;
                    block.style.position = "relative";
                    block.appendChild(marketDiv);
                }
                marketDiv.innerText = "⏳ market...";

                // Données API en priorité; fallback sur sce marketPriceUSD si API indisponible ou vide
                // (recalculé à chaque passage pour mettre à jour l'affichage une fois les données chargées)
                const apiInfo = {};
                if (cardInfo.steamMarketSellQty != null) apiInfo.sellQty = cardInfo.steamMarketSellQty;
                if (cardInfo.steamMarketSellPriceEur != null) apiInfo.sellPriceEur = cardInfo.steamMarketSellPriceEur;
                if (cardInfo.steamMarketBuyOrderQty != null) apiInfo.buyQty = cardInfo.steamMarketBuyOrderQty;
                if (cardInfo.steamMarketBuyOrderEur != null) apiInfo.buyPriceEur = cardInfo.steamMarketBuyOrderEur;

                const hasApiData = Object.keys(apiInfo).length >= 2;
                if (hasApiData) {
                    const txt = win.ES.formatMarketInfo(apiInfo);
                    const sceWorth = cardInfo["sce worth"] ?? 0;
                    marketDiv.innerText = txt ? `${txt} (${sceWorth}c)` : "market N/A";
                } else {
                    // Fallback: prix marché SCE (USD → EUR * 0.92)
                    const priceUSD = parseFloat(cardInfo["sce marketPriceUSD"]) || 0;
                    if (priceUSD > 0) {
                        const priceEUR = Math.round(priceUSD * 0.92 * 100) / 100;
                        const sceWorth = cardInfo["sce worth"] ?? 0;
                        marketDiv.innerText = `SCE: ${priceEUR}€ (${sceWorth}c)`;
                    } else {
                        marketDiv.innerText = "market N/A";
                    }
                }
            }
        });

        // --- 2. GESTION DU BOUTON (LISTE DU BAS) ---
        // On cible les lignes détaillées des cartes manquantes
        const detailBlocks = document.querySelectorAll(".badge_card_to_collect");

        detailBlocks.forEach((block) => {
            const titleEl = block.querySelector(".badge_card_set_title");
            if (!titleEl) return;

            const cardName = titleEl.textContent.trim().toLowerCase();
            const cardInfo = gameData.cards.find(c => c.name.trim().toLowerCase() === cardName);

            if (cardInfo) {
                const stock = cardInfo["sce stock"] || 0;
                const price = cardInfo["sce price"] || 0;
                const urlTrade = cardInfo["sce quick-trade"];
                const linksContainer = block.querySelector(".badge_card_to_collect_links");

                if (linksContainer && !linksContainer.querySelector(".es-quicktrade-btn")) {
                    if (stock > 1 && urlTrade) {
                        const qtLink = document.createElement('a');
                        qtLink.className = "btn_grey_grey btn_medium es-quicktrade-btn";
                        qtLink.href = urlTrade;
                        qtLink.target = "_blank";
                        qtLink.style.cssText = "border: 1px solid #57cbde !important; margin-right: 5px;";
                        qtLink.innerHTML = `<span style="color: #57cbde;">QuickTrade (${price}c)</span>`;

                        // Placé à côté de "Visiter le forum"
                        linksContainer.prepend(qtLink);
                    }
                }
            }
        });
    };










    //////////////////////////////// UI /////////////////////////////
    win.ES.initButtons = function() {
        // Cible la zone des contrôles sur la page des badges
        const target = document.querySelector(".badges_header_controls") ||
              document.querySelector(".badge_details_set_favorite") ||
              document.querySelector(".rightbox");

        if (!target || document.getElementById("es-purge-btn")) return;

        // --- 1. BOUTON PURGE ---
        const purgeBtn = document.createElement("a");
        purgeBtn.id = "es-purge-btn";
        purgeBtn.href = "javascript:void(0);";
        purgeBtn.className = "btn_grey_black btn_small_thin";
        purgeBtn.style.margin = "5px";
        purgeBtn.style.display = "inline-block";
        purgeBtn.innerHTML = "<span>🗑 Purger le Cache ES</span>";

        purgeBtn.onclick = async () => {
            if (confirm("Voulez-vous vraiment vider tout le cache local (ES_DATA_CACHE) ?")) {
                // On réinitialise en gardant la structure de base
                win.ES.DATA = { scecredit: 0 };
                await GM.setValue("ES_DATA_CACHE", JSON.stringify(win.ES.DATA));
                alert("Cache ES_DATA_CACHE vidé ! Rechargement de la page...");
                location.reload();
            }
        };

        // --- 2. BOUTON RAPPORT (front-end PHP localhost:8080) ---
        const reportBtn = document.createElement("a");
        reportBtn.id = "es-report-btn";
        reportBtn.href = API_BASE_URL + ':' + WEB_BASE_PORT; //"http://localhost:8080";
        reportBtn.target = "_blank";
        reportBtn.className = "btn_grey_black btn_small_thin";
        reportBtn.style.margin = "5px";
        reportBtn.style.display = "inline-block";
        reportBtn.innerHTML = "<span style='color: #a3d200;'>📊 Rapport SCE</span>";

        // Ajout des deux boutons à la zone cible
        target.prepend(reportBtn);
        target.prepend(purgeBtn);

        // --- 3. BOUTON RAFRAÎCHIR SCE (sur page gamecards) ---
        if (window.location.href.includes('/gamecards/')) {
            const appIdMatch = window.location.href.match(/gamecards\/(\d+)/);
            if (appIdMatch) {
                const refreshBtn = document.createElement("a");
                refreshBtn.id = "es-refresh-sce-btn";
                refreshBtn.href = "javascript:void(0);";
                refreshBtn.className = "btn_grey_black btn_small_thin";
                refreshBtn.style.margin = "5px";
                refreshBtn.style.display = "inline-block";
                refreshBtn.innerHTML = "<span style='color: #57cbde;'>🔄 Rafraîchir SCE</span>";

                refreshBtn.onclick = async () => {
                    refreshBtn.innerHTML = "<span style='color: #57cbde;'>⏳ SCE...</span>";
                    const appId = appIdMatch[1];
                    try {
                        win.ES._creditFetched = false; // Force refresh global info
                        await win.ES.fetchSCEFresh(appId);
                        if (win.ES.analyzeBadgeStatus) {
                            win.ES.analyzeBadgeStatus(appId);
                        }
                        await win.ES.saveToCache(appId);
                        if (win.ES.injectQuickTradeButtons) {
                            win.ES.injectQuickTradeButtons(appId);
                            win.ES.renderGamecardStatus(appId);
                        }
                        refreshBtn.innerHTML = "<span style='color: #a3d200;'>✅ SCE mis à jour</span>";
                        setTimeout(() => {
                            refreshBtn.innerHTML = "<span style='color: #57cbde;'>🔄 Rafraîchir SCE</span>";
                        }, 3000);
                    } catch (e) {
                        console.warn('[Refresh SCE] Erreur:', e);
                        refreshBtn.innerHTML = "<span style='color: #ff9d00;'>❌ Erreur SCE</span>";
                        setTimeout(() => {
                            refreshBtn.innerHTML = "<span style='color: #57cbde;'>🔄 Rafraîchir SCE</span>";
                        }, 3000);
                    }
                };
                target.prepend(refreshBtn);
            }
        }
    };

    /**
     * PAGE RECHERCHE MARCHÉ (/market/search)
     * Ajoute la valeur "sce worth" dans le span "Quantité à vendre : N" de chaque
     * résultat, uniquement si le bot SCE a plus d'1 exemplaire ("sce stock" > 1).
     * Les classes CSS Steam sont générées (instables) : on repère le span par son
     * texte et la carte via le lien /market/listings/753/<appid>-<nom>.
     */

    // Cache en mémoire des prix fallback (market_hash_name -> { price, volume, source } | null)
    win.ES._priceFallbackCache = win.ES._priceFallbackCache || new Map();
    // Set des market_hash_name en cours de fetch fallback
    win.ES._priceFallbackPending = win.ES._priceFallbackPending || new Set();

    // Fallback : fetch le prix directement depuis l'endpoint Steam priceoverview.
    // Retourne { sellPriceEur, medianPriceEur, volume } ou null.
    win.ES.fetchSteamPriceOverview = async function(marketHashName) {
        const url = `https://steamcommunity.com/market/priceoverview/?appid=753&market_hash_name=${encodeURIComponent(marketHashName)}&currency=3&l=english`;
        return new Promise((resolve) => {
            GM.xmlHttpRequest({
                method: "GET",
                url: url,
                timeout: 10000,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        try {
                            const data = JSON.parse(res.responseText);
                            if (data.success) {
                                const parsePrice = (str) => {
                                    if (!str) return null;
                                    // Steam retourne les prix au format FR: "1,98€" ou EN: "€1.98"
                                    // On extrait le nombre et on gère les deux formats
                                    const m = str.match(/[\d.,]+/);
                                    if (!m) return null;
                                    let numStr = m[0];
                                    if (numStr.includes(',') && numStr.includes('.')) {
                                        // Format mixte: "1,234.56" → on garde le point comme séparateur décimal
                                        numStr = numStr.replace(/,/g, '');
                                    } else if (numStr.includes(',')) {
                                    // Format FR: "1,98" → virgule = séparateur décimal
                                        numStr = numStr.replace(',', '.');
                                    }
                                    return parseFloat(numStr);
                                };
                                resolve({
                                    sellPriceEur: parsePrice(data.lowest_price),
                                    medianPriceEur: parsePrice(data.median_price),
                                    volume: parseInt(data.volume) || 0,
                                });
                                return;
                            }
                        } catch (e) { /* JSON parse error */ }
                    }
                    resolve(null);
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
            });
        });
    };

    // Récupère le prix fallback depuis le cache, ou déclenche un fetch asynchrone.
    // Retourne immédiatement la valeur cachée (ou null si pas encore disponible).
    // Si un fetch est déclenché, il appellera onFetchComplete() quand terminé.
    win.ES.getPriceFallback = function(marketHashName, onFetchComplete) {
        const cache = win.ES._priceFallbackCache;
        const pending = win.ES._priceFallbackPending;

        // Déjà en cache
        if (cache.has(marketHashName)) {
            return cache.get(marketHashName);
        }

        // Fetch déjà en cours
        if (pending.has(marketHashName)) {
            return null;
        }

        // Déclencher le fetch
        pending.add(marketHashName);
        win.ES.fetchSteamPriceOverview(marketHashName).then(result => {
            pending.delete(marketHashName);
            cache.set(marketHashName, result); // result peut être null (cache négatif)
            if (onFetchComplete) onFetchComplete();
        }).catch(() => {
            pending.delete(marketHashName);
            cache.set(marketHashName, null);
            if (onFetchComplete) onFetchComplete();
        });

        return null;
    };

    win.ES.renderMarketSearchSCE = function() {
        // Index des cartes : "appid|nom normalisé" -> carte
        const index = new Map();
        for (const [appid, game] of Object.entries(win.ES.DATA)) {
            if (isNaN(appid) || !game || !Array.isArray(game.cards)) continue;
            for (const c of game.cards) {
                if (c && c.name) index.set(`${appid}|${win.ES.clean(c.name, true)}`, c);
            }
        }

        const links = document.querySelectorAll('a[href*="/market/listings/753/"]');
        links.forEach(a => {
            const m = a.getAttribute('href').match(/\/market\/listings\/753\/([^?#]+)/);
            if (!m) return;
            let hash;
            try { hash = decodeURIComponent(m[1]); } catch { hash = m[1]; }
            const dash = hash.indexOf('-');
            if (dash <= 0) return;
            const appid = hash.slice(0, dash);
            const name = hash.slice(dash + 1).replace(/\s*\(trading card\)\s*$/i, '');
            const card = index.get(`${appid}|${win.ES.clean(name, true)}`);

            // Span "Quantité à vendre : N" (FR) / "Quantity: N" (EN)
            const qtySpan = [...a.querySelectorAll('span')].find(sp =>
                /^(Quantit[ée] à vendre|Quantity)/i.test(sp.textContent.trim()) &&
                sp.children.length >= 1 && sp.firstElementChild.tagName === 'SPAN');
            if (!qtySpan) return;

            // Span "À partir de X,XX €" (FR) / "Starting at: $X.XX" (EN)
            const priceSpan = [...a.querySelectorAll('span')].find(sp =>
                /^(À partir de|Starting at|From)/i.test(sp.textContent.trim()));

            const stock = card ? (parseInt(card["sce stock"], 10) || 0) : 0;
            if (!card || stock <= 1) return;

            // --- Modification du prix : dernier prix vendu dans les 7 jours ---
            if (priceSpan) {
                const existingPrice = priceSpan.querySelector('.es-sce-price');
                if (existingPrice && existingPrice.dataset.hash === hash) {
                    // Déjà traité
                } else {
                    if (existingPrice) existingPrice.remove();

                    const sales7d = parseInt(card.steamMarketSales7d) || 0;
                    const lastSalePriceEur = card.steamMarketLastSalePriceEur != null
                        ? parseFloat(card.steamMarketLastSalePriceEur)
                        : null;
                    const marketPriceEur = card.steamMarketPriceEur != null
                        ? parseFloat(card.steamMarketPriceEur)
                        : null;

                    // Prix retenu : dernier prix vendu (priorité lastSale, puis marketPrice si ventes 7j)
                    let displayPrice = null;
                    let priceSource = '';
                    if (lastSalePriceEur != null && lastSalePriceEur > 0) {
                        displayPrice = lastSalePriceEur;
                        priceSource = sales7d > 0 ? `${sales7d} ventes 7j` : 'dernière vente';
                    } else if (sales7d > 0 && marketPriceEur != null && marketPriceEur > 0) {
                        displayPrice = marketPriceEur;
                        priceSource = `${sales7d} ventes 7j`;
                    }

                    // FALLBACK : si aucune donnée de prix dans l'API, fetch via Steam priceoverview
                    if (displayPrice == null) {
                        const marketHashName = `${appid}-${name}`;
                        const fallback = win.ES.getPriceFallback(marketHashName, () => {
                            // Re-render après la complétion du fetch asynchrone
                            win.ES.renderMarketSearchSCE();
                        });
                        if (fallback && fallback.medianPriceEur != null && fallback.medianPriceEur > 0) {
                            displayPrice = fallback.medianPriceEur;
                            priceSource = fallback.volume > 0 ? `prix médian (${fallback.volume} ventes)` : 'prix médian';
                        }
                    }

                    if (displayPrice != null) {
                        const priceText = displayPrice.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                        const priceEl = document.createElement('span');
                        priceEl.className = 'es-sce-price';
                        priceEl.dataset.hash = hash;
                        priceEl.style.cssText = 'color:#8ed6fb;font-weight:bold;';
                        priceEl.textContent = `${priceText} €`;
                        priceEl.title = `Dernier prix vendu (${priceSource})`;
                        // Remplacer le contenu du span de prix par le dernier prix vendu
                        priceSpan.textContent = '';
                        priceSpan.appendChild(priceEl);
                    }
                }
            }

            // --- Ajout info SCE (worth + stock) ---
            // Déjà traité pour cette carte : rien à faire (le DOM React peut être recyclé)
            const existing = qtySpan.querySelector('.es-sce-worth');
            if (existing && existing.dataset.hash === hash) return;
            if (existing) existing.remove();

            const worth = card["sce worth"] ?? 0;
            const el = document.createElement('span');
            el.className = 'es-sce-worth';
            el.dataset.hash = hash;
            el.style.cssText = 'color:#57cbde;font-weight:bold;margin-left:6px;white-space:nowrap;';
            el.textContent = `· SCE ${worth}c (${stock})`;
            el.title = `SCE : ${stock} en stock, valeur ${worth} crédits`;
            const quickTradeUrl = card["sce quick-trade"];
            if (quickTradeUrl) {
                el.style.cursor = 'pointer';
                el.style.textDecoration = 'underline';
                el.title += ' — clic : Quick-Trade SCE';
                el.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.open(quickTradeUrl, '_blank');
                };
            }
            qtySpan.appendChild(el);
        });
    };

    /**
     * PAGE LISTING INDIVIDUEL (/market/listings/753/<appid>-<name>)
     * Modifie le prix Steam "starting at" par le dernier prix vendu 7j.
     * Ajoute les infos SCE (worth, stock, quick-trade) à côté du prix.
     */
    win.ES.renderMarketListingSCE = function() {
        // Extraire appid et nom depuis l'URL
        const m = window.location.pathname.match(/\/market\/listings\/753\/([^?#]+)/);
        if (!m) return;
        let hash;
        try { hash = decodeURIComponent(m[1]); } catch { hash = m[1]; }
        const dash = hash.indexOf('-');
        if (dash <= 0) return;
        const appid = hash.slice(0, dash);
        const name = hash.slice(dash + 1).replace(/\s*\(trading card\)\s*$/i, '');

        // Index pour retrouver la carte
        const normName = win.ES.clean(name, true);
        const game = win.ES.DATA[appid];
        const card = game && game.cards
            ? game.cards.find(c => win.ES.clean(c.name, true) === normName)
            : null;

        const stock = card ? (parseInt(card["sce stock"], 10) || 0) : 0;
        if (!card || stock <= 1) return;

        // --- Trouver le span de prix "starting at" sur la page listing ---
        // Structure: <span class="E-F5JVsCXEo- IokSIloSPlA-"><span>9</span> for sale starting at <span class="IokSIloSPlA-" style="--text-color:var(--color-text-body-title)">R$ 11,12</span></span>
        // En FR: "À partir de 1,98 €" peut être dans un span séparé ou inline
        const allSpans = document.querySelectorAll('span');
        let priceContainer = null; // span parent contenant "starting at" / "À partir de"
        let priceValueSpan = null;  // span contenant la valeur du prix

        for (const sp of allSpans) {
            const text = sp.textContent.trim();
            // Page listing: "X for sale starting at PRICE"
            // Page search: "À partir de X,XX €" ou "Starting at: $X.XX"
            if (/starting at/i.test(text) || /^À partir de/i.test(text) || /^Starting at/i.test(text)) {
                priceContainer = sp;
                // Chercher le span enfant contenant le prix (devise ou nombre)
                for (const child of sp.querySelectorAll('span')) {
                    if (/[€$£]|\d[,.]\d{2}/.test(child.textContent)) {
                        priceValueSpan = child;
                        break;
                    }
                }
                // Si pas de span enfant, le texte entier est le prix
                if (!priceValueSpan && /\d[,.]\d{2}/.test(text)) {
                    priceValueSpan = sp;
                }
                break;
            }
        }

        if (!priceValueSpan) return;

        // --- Modification du prix : dernier prix vendu dans les 7 jours ---
        const existingPrice = priceValueSpan.querySelector('.es-sce-price');
        if (existingPrice && existingPrice.dataset.hash === hash) {
            // Déjà traité
        } else {
            if (existingPrice) existingPrice.remove();

            const sales7d = parseInt(card.steamMarketSales7d) || 0;
            const lastSalePriceEur = card.steamMarketLastSalePriceEur != null
                ? parseFloat(card.steamMarketLastSalePriceEur)
                : null;
            const marketPriceEur = card.steamMarketPriceEur != null
                ? parseFloat(card.steamMarketPriceEur)
                : null;

            let displayPrice = null;
            let priceSource = '';
            if (lastSalePriceEur != null && lastSalePriceEur > 0) {
                displayPrice = lastSalePriceEur;
                priceSource = sales7d > 0 ? `${sales7d} ventes 7j` : 'dernière vente';
            } else if (sales7d > 0 && marketPriceEur != null && marketPriceEur > 0) {
                displayPrice = marketPriceEur;
                priceSource = `${sales7d} ventes 7j`;
            }

            // FALLBACK : si aucune donnée de prix dans l'API, fetch via Steam priceoverview
            if (displayPrice == null) {
                const fallback = win.ES.getPriceFallback(hash, () => {
                    win.ES.renderMarketListingSCE();
                });
                if (fallback && fallback.medianPriceEur != null && fallback.medianPriceEur > 0) {
                    displayPrice = fallback.medianPriceEur;
                    priceSource = fallback.volume > 0 ? `prix médian (${fallback.volume} ventes)` : 'prix médian';
                }
            }

            if (displayPrice != null) {
                const priceText = displayPrice.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const priceEl = document.createElement('span');
                priceEl.className = 'es-sce-price';
                priceEl.dataset.hash = hash;
                priceEl.style.cssText = 'color:#8ed6fb;font-weight:bold;';
                priceEl.textContent = `${priceText} €`;
                priceEl.title = `Dernier prix vendu (${priceSource})`;
                priceValueSpan.textContent = '';
                priceValueSpan.appendChild(priceEl);
            }
        }

        // --- Ajout info SCE (worth + stock) à côté du prix ---
        if (priceContainer) {
            const existingSCE = priceContainer.querySelector('.es-sce-worth');
            if (!existingSCE || existingSCE.dataset.hash !== hash) {
                if (existingSCE) existingSCE.remove();
                const worth = card["sce worth"] ?? 0;
                const el = document.createElement('span');
                el.className = 'es-sce-worth';
                el.dataset.hash = hash;
                el.style.cssText = 'color:#57cbde;font-weight:bold;margin-left:8px;white-space:nowrap;';
                el.textContent = `· SCE ${worth}c (${stock})`;
                el.title = `SCE : ${stock} en stock, valeur ${worth} crédits`;
                const quickTradeUrl = card["sce quick-trade"];
                if (quickTradeUrl) {
                    el.style.cursor = 'pointer';
                    el.style.textDecoration = 'underline';
                    el.title += ' — clic : Quick-Trade SCE';
                    el.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        window.open(quickTradeUrl, '_blank');
                    };
                }
                priceContainer.appendChild(el);
            }
        }
    };

    // Observer pour la page listing (React re-render le prix)
    win.ES.watchMarketListing = function() {
        let timer = null;
        const run = () => { timer = null; win.ES.renderMarketListingSCE(); };
        run();
        new MutationObserver(() => {
            if (!timer) timer = setTimeout(run, 500);
        }).observe(document.body, { childList: true, subtree: true });
    };

    // Les résultats sont rendus par React (pagination/filtres sans rechargement) :
    // on ré-applique le rendu à chaque mutation du DOM (debounce).
    // FALLBACK: détecte les appids manquants de l'API et fetch SCE en arrière-plan.
    win.ES.watchMarketSearch = function() {
        let timer = null;
        const fetchedFallback = new Set(); // appids déjà fetchés en fallback

        const collectMissingAppids = () => {
            const links = document.querySelectorAll('a[href*="/market/listings/753/"]');
            const missing = new Set();
            links.forEach(a => {
                const m = a.getAttribute('href').match(/\/market\/listings\/753\/([^?#]+)/);
                if (!m) return;
                const hash = (() => { try { return decodeURIComponent(m[1]); } catch { return m[1]; } })();
                const dash = hash.indexOf('-');
                if (dash <= 0) return;
                const appid = hash.slice(0, dash);
                if (fetchedFallback.has(appid)) return;
                const game = win.ES.DATA[appid];
                if (!game || !game.cards || game.cards.length === 0) {
                    missing.add(appid);
                }
            });
            return [...missing];
        };

        const runFallback = async () => {
            const missing = collectMissingAppids();
            if (missing.length === 0) return;
            ES_log(`[watchMarketSearch] ${missing.length} appid(s) absent(s) de l'API — fallback SCE.`);
            for (const appid of missing) {
                fetchedFallback.add(appid); // marquer comme en cours
                try {
                    ES_log(`[watchMarketSearch] Fallback fetchSCEFresh pour appid ${appid}...`);
                    await win.ES.fetchSCEFresh(appid);
                    await win.ES.saveToCache(appid);
                    win.ES.renderMarketSearchSCE(); // re-render après chaque fetch
                    ES_log(`[watchMarketSearch] Appid ${appid} fetché via SCE fallback.`);
                } catch (e) {
                    console.warn(`[watchMarketSearch] Erreur fallback SCE pour ${appid}:`, e);
                }
            }
        };

        const run = () => { timer = null; win.ES.renderMarketSearchSCE(); runFallback(); };
        run();
        new MutationObserver(() => {
            if (!timer) timer = setTimeout(run, 300);
        }).observe(document.body, { childList: true, subtree: true });
    };

    /**
     * WORKFLOW PRINCIPAL
     */
    async function mainWorkflow() {
        const currentUrl = window.location.href;

        // 1. Initialiser les boutons
        win.ES.initButtons();

        // 2. Chargement du cache local
        await win.ES.loadFromCache();

        // 3. Tentative de recuperation des donnees depuis l'API REST du backend Node.js.
        //    L'API est la source de verite: si elle est disponible, les donnees
        //    remplacent le cache local. Sinon, le cache local est utilise tel quel.
        const apiAvailable = await win.ES.fetchAPIData();

        // --- CAS 0: PAGE RECHERCHE MARCHÉ (API si dispo, sinon cache local) ---
        if (currentUrl.includes('/market/search')) {
            ES_log(`[Workflow] Page recherche marché (${apiAvailable ? 'API' : 'cache local'}).`);
            win.ES.watchMarketSearch();
            return;
        }

        // --- CAS 0b: PAGE LISTING INDIVIDUEL MARCHÉ ---
        if (currentUrl.includes('/market/listings/753/')) {
            ES_log(`[Workflow] Page listing marché (${apiAvailable ? 'API' : 'cache local'}).`);
            // Fallback: si l'appid n'est pas dans l'API, fetch SCE
            const listingMatch = currentUrl.match(/\/market\/listings\/753\/(\d+)-/);
            if (listingMatch) {
                const listingAppid = listingMatch[1];
                const game = win.ES.DATA[listingAppid];
                if (!game || !game.cards || game.cards.length === 0) {
                    ES_log(`[Workflow] Appid ${listingAppid} absent de l'API — fallback SCE.`);
                    try {
                        await win.ES.fetchSCEFresh(listingAppid);
                        await win.ES.saveToCache(listingAppid);
                    } catch (e) {
                        console.warn(`[Workflow] Erreur fallback SCE pour ${listingAppid}:`, e);
                    }
                }
            }
            win.ES.watchMarketListing();
            return;
        }

        if (apiAvailable) {
            // --- MODE API: les donnees viennent du backend, pas besoin de scraper ---

            // --- CAS A: PAGE INDIVIDUELLE (GAMECARDS) ---
            if (currentUrl.includes('/gamecards/')) {
                const appIdMatch = currentUrl.match(/gamecards\/(\d+)/);
                if (appIdMatch) {
                    const appId = appIdMatch[1];
                    ES_log(`[Workflow-API] Mode API pour l'AppID : ${appId}`);

                    // On a deja les donnees via fetchAPIData, mais on peut rafraichir ce jeu precis
                    // win.ES.fetchAPIGame(appId); // optionnel: refresh ciblé

                    if (win.ES.injectQuickTradeButtons) {
                        setTimeout(() => {
                            win.ES.injectQuickTradeButtons(appId);
                            win.ES.renderGamecardStatus(appId);
                        }, 500);
                    }
                    return;
                }
            }

            // --- CAS B: PAGE DES BADGES ---
            if (currentUrl.includes('/badges')) {
                // On recupere les appids visibles sur la page
                const itemsOnPage = getPageAppids();
                const appidsOnPage = itemsOnPage.map(i => i.appid);

                // Mise a jour du statut SCE dans l'UI
                const xpBlock = document.querySelector("#responsive_page_template_content > div > div.maincontent > div.profile_xp_block");
                if (xpBlock) {
                    if (!document.getElementById('es-status-text')) {
                        const statusContainer = document.createElement('div');
                        statusContainer.style.cssText = "font-size: 11px; color: #8ed6fb; margin-top: 10px; border-top: 1px solid #333; padding-top: 5px;";
                        statusContainer.innerHTML = `
                <span style="color: #57cbde; font-weight: bold;">Crédit SCE : </span>
                <span id="es-status-text">Initialisation...</span>
                <br>
                <span style="color: #57cbde; font-weight: bold;">File d'attente : </span>
                <span id="es-status-queue">--</span>
                <span style="color: #57cbde; font-weight: bold; margin-left: 10px;">Wait Time : </span>
                <span id="es-status-waittime">--</span>
            `;
                        xpBlock.appendChild(statusContainer);
                    }
                }

                const statusEl = document.getElementById('es-status-text');
                const updateStatus = (txt) => {
                    if (statusEl) {
                        const credit = win.ES.DATA.scecredit !== undefined ? `${win.ES.DATA.scecredit}c` : '--';
                        statusEl.innerHTML = `<span style="color:#fff">${credit}</span> ${txt}`;
                    }
                    const queueEl = document.getElementById('es-status-queue');
                    if (queueEl) {
                        const pending = win.ES.DATA.scePendingOffers !== undefined ? win.ES.DATA.scePendingOffers : '--';
                        queueEl.innerHTML = `<span style="color:#fff">${pending}</span> offre(s)`;
                    }
                    const waitEl = document.getElementById('es-status-waittime');
                    if (waitEl) {
                        const wait = win.ES.DATA.sceWaitTime !== undefined ? `${win.ES.DATA.sceWaitTime} min` : '--';
                        waitEl.innerHTML = `<span style="color:#fff">${wait}</span>`;
                    }
                };

                updateStatus("✅ Données chargées depuis l'API");

                // Mise a jour de l'UI pour chaque badge visible
                // En mode API, les donnees viennent du backend (source de verite):
                // on ne recalcule pas analyzeBadgeStatus (qui pourrait ecraser les champs DB)
                appidsOnPage.forEach(id => {
                    win.ES.updateBadgeUI(id);
                });

                // Sauvegarde du cache local (pour le fallback hors ligne)
                await win.ES.saveToCache();
            }
            return;
        }

        // --- MODE FALLBACK: API indisponible, utilisation du fetch SCE direct ---
        ES_log('[Workflow] API indisponible, mode fetch SCE direct (fallback).');

        // --- CAS A: PAGE INDIVIDUELLE (GAMECARDS) ---
        if (currentUrl.includes('/gamecards/')) {
            const appIdMatch = currentUrl.match(/gamecards\/(\d+)/);
            if (appIdMatch) {
                const appId = appIdMatch[1];
                ES_log(`[Workflow-SCE] Mode fetch SCE pour l'AppID : ${appId}`);

                // Afficher le cache immédiatement
                if (win.ES.injectQuickTradeButtons) {
                    win.ES.injectQuickTradeButtons(appId);
                    win.ES.renderGamecardStatus(appId);
                }

                // Fetch SCE en arrière-plan
                try {
                    await win.ES.fetchSCEFresh(appId);
                    if (win.ES.analyzeBadgeStatus) {
                        win.ES.analyzeBadgeStatus(appId);
                    }
                    await win.ES.saveToCache(appId);

                    // Re-render avec les nouvelles données
                    if (win.ES.injectQuickTradeButtons) {
                        win.ES.injectQuickTradeButtons(appId);
                        win.ES.renderGamecardStatus(appId);
                    }
                    ES_log(`[Workflow-SCE] AppID ${appId} mis à jour via SCE.`);
                } catch (e) {
                    console.warn(`[Workflow-SCE] Erreur fetch SCE pour ${appId}:`, e);
                }
                return;
            }
        }

        // --- CAS B: PAGE DES BADGES ---
        if (currentUrl.includes('/badges')) {
            const itemsOnPage = getPageAppids();
            const appidsOnPage = itemsOnPage.map(i => i.appid);

            // --- UI: statut SCE ---
            const xpBlock = document.querySelector("#responsive_page_template_content > div > div.maincontent > div.profile_xp_block");
            if (xpBlock && !document.getElementById('es-status-text')) {
                const statusContainer = document.createElement('div');
                statusContainer.style.cssText = "font-size: 11px; color: #8ed6fb; margin-top: 10px; border-top: 1px solid #333; padding-top: 5px;";
                statusContainer.innerHTML = `
            <span style="color: #57cbde; font-weight: bold;">Crédit SCE : </span>
            <span id="es-status-text">Initialisation...</span>
            <br>
            <span style="color: #57cbde; font-weight: bold;">File d'attente : </span>
            <span id="es-status-queue">--</span>
            <span style="color: #57cbde; font-weight: bold; margin-left: 10px;">Wait Time : </span>
            <span id="es-status-waittime">--</span>
        `;
                xpBlock.appendChild(statusContainer);
            }

            const statusEl = document.getElementById('es-status-text');
            const updateStatus = (txt) => {
                if (statusEl) {
                    const credit = win.ES.DATA.scecredit !== undefined ? `${win.ES.DATA.scecredit}c` : '--';
                    statusEl.innerHTML = `<span style="color:#fff">${credit}</span> ${txt}`;
                }
                const queueEl = document.getElementById('es-status-queue');
                if (queueEl) {
                    const pending = win.ES.DATA.scePendingOffers !== undefined ? win.ES.DATA.scePendingOffers : '--';
                    queueEl.innerHTML = `<span style="color:#fff">${pending}</span> offre(s)`;
                }
                const waitEl = document.getElementById('es-status-waittime');
                if (waitEl) {
                    const wait = win.ES.DATA.sceWaitTime !== undefined ? `${win.ES.DATA.sceWaitTime} min` : '--';
                    waitEl.innerHTML = `<span style="color:#fff">${wait}</span>`;
                }
            };

            // 1. Afficher le cache immédiatement
            appidsOnPage.forEach(id => {
                if (win.ES.analyzeBadgeStatus) win.ES.analyzeBadgeStatus(id);
                win.ES.updateBadgeUI(id);
            });
            updateStatus("⚡ Cache local (SCE fetch en cours...)");

            // 2. Fetch infos globales SCE (credit, pending offers)
            try {
                await win.ES.fetchSCEGlobalInfo();
                updateStatus("🔄 Récupération SCE...");
            } catch (e) {
                console.warn('[Workflow-SCE] Erreur fetch global info:', e);
            }

            // 3. Sauvegarder le cache
            await win.ES.saveToCache();
        }
    }

    // À ajouter dans ton UserScript global (qui a accès aux pages Steam)
    if (window.location.href.includes('tradeoffer/new')) {
        const gameToFilter = decodeURIComponent(window.location.hash.substring(1));
        if (gameToFilter && gameToFilter.length > 1) {
            ES_log("[tradeoffer/new] Tentative de filtrage pour : " + gameToFilter);

            // Attente de 5 secondes comme demandé
            setTimeout(() => {
                const searchBox = document.getElementById('filter_control');
                if (searchBox) {
                    searchBox.value = gameToFilter;
                    // Déclenche l'événement de recherche pour que Steam affiche les cartes
                    searchBox.dispatchEvent(new Event('keyup'));
                    searchBox.dispatchEvent(new Event('change'));
                    ES_log("[tradeoffer/new] Filtre appliqué !");
                }
            }, 6000);
        }
    }
    // Lancement automatique
    mainWorkflow();

})();
