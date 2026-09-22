// ==UserScript==
// @name         Steam-Gamecards-SCE based on trade history (utilisation ajax)
// @namespace    http://tampermonkey.net/
// @version      5.2
// @description  Scrap complet Steam & SCE avec cache persistant, workers et API REST
// @author       Gemini
// @match        https://steamcommunity.com/profiles/*/badges*
// @match        https://steamcommunity.com/my/badges*
// @match        https://steamcommunity.com/profiles/*/gamecards*
// @match        https://steamcommunity.com/my/gamecards*
// @match        https://steamcommunity.com/profiles/*/inventory*
// @match        https://steamcommunity.com/my/inventory*

// @grant        GM.xmlHttpRequest
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        unsafeWindow
// @connect      www.steamcardexchange.net
// @connect      localhost
// @connect      127.0.0.1
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
    const API_BASE_URL = 'http://127.0.0.1:3001';

    // Initialisation de la structure de données
    win.ES = win.ES || {};
    win.ES.DATA = { scecredit: 0 };
    win.ES.CONCURRENCY_LIMIT = 4;
    win.ES.API_BASE_URL = API_BASE_URL;

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
                url: `${API_BASE_URL}${endpoint}`,
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

/*    const normalize = (str) => {
        if (!str) return "";
        return str.toLowerCase().trim().replace(/['":]/g, '').replace(/\s+/g, ' ');
    };
*/
    /**
 * Nettoie et normalise n'importe quelle chaîne (Nom de jeu, de carte ou ID)
 * @param {string} str - La chaîne à nettoyer
 * @param {boolean} fullNormalize - Si vrai, applique la mise en minuscule et retrait ponctuation (pour SCE)
 */
    win.ES.clean = function(str, fullNormalize = false) {
        if (!str) return "";

        // Nettoyage de base (espaces et sauts de ligne)
        let cleaned = str.toLowerCase().replace(/[\n\t\r]/g, "").replace(/\s{2,}/g, " ").trim();

        if (fullNormalize) {
            return cleaned.toLowerCase()
                .replace(/^badge\s+/i, "") // Supprime "Badge " au début
                .replace(/\(trading card\)$/i, "") // Supprime "(Trading Card)" à la fin
                .replace(/['":!?,.()]/g, "") // Supprime la ponctuation
                .replace(/\s+/g, ' ') // Unifie les espaces restants
                .trim();
        }
        return cleaned;
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

    // --- SCRAP STEAM ---

    /**
 * Récupère et lie les IDs d'inventaire aux cartes fournies par correspondance de nom
 * @param {Array} cards - Le tableau d'objets cartes (ex: win.ES.DATA[appid].cards)
 * @param {String} profileLink - "my" ou ID Steam
 */
    win.ES.fillInventoryData = async function(cards, profileLink = "my") {
        try {
            // 1. RÉINITIALISATION SYSTÉMATIQUE
            cards.forEach(card => {card.inv = [];});

            // 2. Récupération paginée de l'inventaire
            if (!inventoryCache) {
                let allInventory = {};
                let allDescriptions = {};
                let nextStart = 0;
                let hasMore = true;

                ES_log("[fillInventoryData] Début de la récupération complète...");

                while (hasMore) {
                    const url = `https://steamcommunity.com/${profileLink}/inventory/json/753/6/?start=${nextStart}`;
                    const response = await fetch(url);

                    if (!response.ok) {
                        console.error(`[Inventory] Erreur Steam: ${response.status}`);
                        break;
                    }

                    const data = await response.json();

                    if (data && data.success) {
                        if (data.rgInventory) Object.assign(allInventory, data.rgInventory);
                        if (data.rgDescriptions) Object.assign(allDescriptions, data.rgDescriptions);

                        if (data.more === true && data.more_start) {
                            nextStart = data.more_start;
                            await new Promise(r => setTimeout(r, 800)); // Anti-rate-limit
                        } else {
                            hasMore = false;
                        }
                    } else {
                        hasMore = false;
                    }
                }

                if (Object.keys(allInventory).length > 0) {
                    inventoryCache = {
                        rgInventory: allInventory,
                        rgDescriptions: allDescriptions
                    };
                } else {
                    console.error("[Inventory] Impossible de charger l'inventaire.");
                    return cards;
                }
            }

            // 3. REMPLISSAGE PAR CORRESPONDANCE DE HASH (AppID + Nom)
            if (inventoryCache) {
                ES_log("[fillInventoryData] Utilisation du cache existant...");
                const { rgInventory, rgDescriptions } = inventoryCache;

                Object.keys(rgInventory).forEach(itemId => {
                    const item = rgInventory[itemId];
                    const descKey = `${item.classid}_${item.instanceid}`;
                    const desc = rgDescriptions[descKey];

                    // On vérifie si c'est une Trading Card (item_class_2)
                    if (desc && desc.tags && desc.tags.some(t => t.internal_name === "item_class_2")) {

                        // Récupération de l'AppID du jeu à partir des tags de la description
                        const appidTag = desc.tags.find(t => t.category === "Game");
                        const itemAppId = desc.market_fee_app || (appidTag ? appidTag.internal_name.replace('app_', '') : null);

                        if (itemAppId) {
                            // On utilise le market_hash_name pour le nettoyage
                            if (desc.market_hash_name) {
                                // Suppression du suffixe (Trading Card) dans le hash du marché
                                const cleanMarketHash = desc.market_hash_name
                                .replace(/\s*\(trading card\)\s*/gi, "")
                                .trim();

                                // RECHERCHE PAR HASH
                                // (Note : card.hash doit aussi avoir été nettoyé dans fetchSteamData)
                                const card = cards.find(c => c.hash === cleanMarketHash);

                                if (card) {
                                    if (!card.inv.some(i => i.id === item.id)) {
                                        card.inv.push({ id: item.id, pos: item.pos });
                                    }
                                }
                            }
                        }
                    }
                });
            }

            // 4. MISE À JOUR DE QTY APRÈS REMPLISSAGE
            // On s'assure que qty reflète le nombre d'éléments dans inv
            cards.forEach(c => { c.qty = c.inv.length; });

            const ownedCount = cards.reduce((acc, c) => acc + c.inv.length, 0);
            ES_log(`[fillInventoryData] Terminé. ${ownedCount} cartes identifiées sans ambiguïté.`);
            return cards;

        } catch (error) {
            console.error("Échec de fillInventoryData:", error);
            return cards;
        }
    };

    win.ES.fetchSteamData = async function(appid, profileLink = "my", retries = 3) {
        if (win.ES.isSteamEvent(appid)) return null;

        const url = `https://steamcommunity.com/${profileLink}/ajaxgetbadgeinfo/${appid}`;
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
ES_log("[fetchSteamData] entrée fonction",appid);
        try {
            const response = await fetch(url);
            if (!response.ok) {
                if (retries > 0 && [502, 429, 503].includes(response.status)) {
                    await sleep((4 - retries) * 2000);
                    return await win.ES.fetchSteamData(appid, profileLink, retries - 1);
                }
                throw new Error(`Erreur HTTP: ${response.status}`);
            }

            const data = await response.json();
            if (data.eresult !== 1 || !data.badgedata) return null;

            // 1. Initialisation des cartes avec nettoyage du HASH
            const cards = data.badgedata.rgCards.map((card, index) => {
                // On nettoie le market_hash_name fourni par Steam
                const cleanHash = card.markethash.replace(/\s*\(trading card\)\s*/gi, "").trim();

                return {
                    name: card.name,
                    qty: (card.owned || 0),
                    index: index,
                    inv: [],
                    hash: cleanHash, // Hash désormais "propre" (AppID-Nom)
                    iconUrl: card.imgurl,
                    artUrl: card.arturl
                };
            });

            // 2. Condition avant l'appel à fillInventoryData
            // On ne traite l'inventaire que si au moins une carte a une qty > 0
            const hasOwnedCards = cards.some(c => c.qty > 0);

            if (hasOwnedCards) {
                // Récupération et matching de l'inventaire
                await win.ES.fillInventoryData(cards);
            } else {
                ES_log(`[fetchSteamData] AppID ${appid}: Aucune carte possédée (qty=0), matching inventaire ignoré.`);
            }

            // 4. Stockage final
            win.ES.DATA[appid] = {
                ...(win.ES.DATA[appid] || {}),
                setCards: cards.length,
                cards: cards
            };

            return win.ES.DATA[appid];

        } catch (error) {
            if (retries > 0) {
                await sleep(3000);
                return await win.ES.fetchSteamData(appid, profileLink, retries - 1);
            }
            return null;
        }
    };

    /////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////SCE/////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////////////////////////

    // --- SCRAP SCE (Version synchronisée avec analyzeBadgeStatus) ---
    win.ES.fetchSCEFresh = async function(appid) {

        if (win.ES.isSteamEvent(appid)) return null;

        ES_log("fetchSCEFresh START", appid);

        // Initialisation de l'entrée dans le cache si inexistante
        if (!win.ES.DATA[appid]) {
            win.ES.DATA[appid] = { appid: appid, cards: [] };
        }

        if (win.ES.DATA[appid].disabled) return null;

        // --- 1. RÉCUPÉRATION DU CRÉDIT & DES OFFRES EN ATTENTE (Global) ---
        if (!win.ES._creditFetched) {
            try {
                // On utilise la page /index.php?profile car elle contient
                // à la fois le crédit et l'état précis de la file d'attente.
                const profileHtml = await win.ES.http("https://www.steamcardexchange.net/index.php?profile");
                const tempDoc = new DOMParser().parseFromString(profileHtml, "text/html");

                // --- RÉCUPÉRATION CRÉDIT ---
                let rawCreditText = "";
                const creditEl = tempDoc.querySelector('.inventory-user-credits .number');

                if (creditEl) {
                    rawCreditText = creditEl.textContent;
                } else {
                    // Fallback sur ton sélecteur desktop si besoin
                    const desktopCreditEl = tempDoc.querySelector("nav .hidden.lg\\:block button div.ml-auto");
                    rawCreditText = desktopCreditEl ? desktopCreditEl.textContent : "";
                }
                win.ES.DATA.scecredit = parseInt(rawCreditText.replace(/\D/g, ""), 10) || 0;

                // --- RÉCUPÉRATION OFFRES EN ATTENTE (PENDING OFFERS) ---
                // On cherche le texte "currently X offers pending" dans la zone de stats
                const infoSpans = tempDoc.querySelectorAll('div.bg-gray-light span, div.bg-gray-lighter span');
                let foundStatus = false;

                for (const span of infoSpans) {
                    const text = span.textContent;
                    if (text.includes("offers pending")) {
                        // Extraction du nombre d'offres
                        const pendingMatch = text.match(/(\d+)\s+offers\s+pending/i);
                        win.ES.DATA.scePendingOffers = pendingMatch ? parseInt(pendingMatch[1], 10) : 0;

                        // Extraction du temps d'attente
                        const waitMatch = text.match(/wait\s+time\s+is\s+([\d.]+)\s+minutes/i);
                        win.ES.DATA.sceWaitTime = waitMatch ? parseFloat(waitMatch[1]) : 0;

                        foundStatus = true;
                        break; // On a trouvé l'info, on arrête la boucle
                    }
                }

                if (!foundStatus) {
                    console.warn("[SCE] Impossible de localiser les stats du bot dans le HTML.");
                    win.ES.DATA.scePendingOffers = 0; // Valeur par défaut
                }

                win.ES._creditFetched = true;
                ES_log(`[fetchSCEFresh] Crédit: ${win.ES.DATA.scecredit} | File: ${win.ES.DATA.scePendingOffers} offres.`);

            } catch (e) {
                console.warn("[fetchSCEFresh] Erreur lors de la récupération des infos globales:", e);
            }
        }

        // --- 2. RÉCUPÉRATION DES PRIX DU MARCHÉ ($) ---
        const html1 = await win.ES.http(`https://www.steamcardexchange.net/index.php?gamepage-appid-${appid}/`);

        if (!html1 || html1.includes("Trade-in disabled")) {
            ES_log(`[fetchSCEFresh] Trade-in désactivé pour ${appid}.`);
            win.ES.DATA[appid].disabled = true;
            return null;
        }

        const tempDoc1 = new DOMParser().parseFromString(html1, "text/html");
        const marketPrices = {};
        const tradingCardsHeader = tempDoc1.querySelector("#series-1-cards")?.closest("div.bg-gray-dark");

        if (tradingCardsHeader) {
            const cardGrid = tradingCardsHeader.nextElementSibling;
            if (cardGrid && cardGrid.classList.contains("grid")) {
                const priceBlocks = cardGrid.querySelectorAll("div.flex.flex-col.items-center.p-5.bg-gray-light");
                priceBlocks.forEach(block => {
                    const nameEl = block.querySelector("div.text-sm.text-center.break-words");
                    const priceBtn = block.querySelector("a.btn-primary");
                    if (nameEl && priceBtn) {
                        const name = nameEl.textContent.trim();
                        const m = priceBtn.textContent.match(/\$([\d.]+)/);
                        // On utilise win.ES.clean(name, true) pour correspondre à l'analyseur
                        marketPrices[win.ES.clean(name, true)] = m ? parseFloat(m[1]) : 0;
                    }
                });
            }
        } else {
            win.ES.DATA[appid].disabled = true;
            return null;
        }

        // --- 3. RÉCUPÉRATION DE L'INVENTAIRE SCE (Crédits & Stock) ---
        const html2 = await win.ES.http(`https://www.steamcardexchange.net/index.php?inventorygame-appid-${appid}`);
        const tempDoc2 = new DOMParser().parseFromString(html2, "text/html");
        const inventoryMap = {};
        const cardBlocks = tempDoc2.querySelectorAll("div.flex.flex-col.items-center.p-5");

        cardBlocks.forEach(block => {
            const nameEl = block.querySelector("div.text-sm.break-words");
            if (!nameEl) return;
            const name = nameEl.textContent.trim();

            // Stock
            let stock = 0;
            const divs = block.querySelectorAll('div');
            for (const div of divs) {
                if (div.textContent.includes("Stock:")) {
                    const match = div.textContent.match(/Stock:\s*(\d+)/i);
                    if (match) stock = parseInt(match[1], 10);
                    break;
                }
            }

            // Worth & Price
            let worth = 0;
            let price = 0;
            const infoLines = block.querySelectorAll("div.mt-auto.text-sm > div");
            infoLines.forEach(line => {
                const text = line.textContent.toLowerCase();
                const valueSpan = line.querySelector("span.font-open-sans");
                if (!valueSpan) return;
                const val = parseInt(valueSpan.textContent, 10) || 0;
                if (text.includes("worth")) worth = val;
                if (text.includes("price")) price = val;
            });

            const tradeLink = block.querySelector("a.btn-primary")?.href || "";

            // On utilise win.ES.clean(name, true) pour correspondre à l'analyseur
            inventoryMap[win.ES.clean(name, true)] = {
                stock: stock,
                worth: worth,
                price: price,
                quickTrade: tradeLink
            };
        });

        // --- NOUVEAU : FUSION DYNAMIQUE DANS CARDS ---
        const data = win.ES.DATA[appid];
        if (data && data.cards) {
            data.cards = data.cards.map(card => {
                const normName = win.ES.clean(card.name, true);
                const inv = inventoryMap[normName] || {};
                const mPrice = marketPrices[normName] || 0;

                return {
                    ...card,
                    "sce stock": inv.stock || 0,
                    "sce worth": inv.worth || 0,
                    "sce price": inv.price || 0,
                    "sce marketPriceUSD": mPrice,
                    "sce quick-trade": inv.quickTrade || ""
                };
            });
        }

        // --- STOCKAGE DES VARIABLES ---
        data.disabled = false;
        data.fetchedAt = Date.now();

        ES_log("[fetchSCEFresh] Appid ", appid, " enrichi et fusionné avec succès :", data);

        // On retourne l'objet complet
        return data;
    };

    /**
 * Analyse les données Steam et SCE pour déterminer l'état de complétion d'un badge.
 * @param {Object} steam - Données issues de fetchSteamData
 * @param {Object} sce - Données issues de fetchSCEFresh
 * @param {String} appid - L'ID de l'application
 * @returns {Object} L'objet badge complet prêt pour le cache
 */
    win.ES.analyzeBadgeStatus = function(appid) {
        const data = win.ES.DATA[appid];

        if (!data || data.disabled || !data.cards || data.cards.length === 0) return null;

        // --- 1. CALCULS PRÉALABLES ---
        let maxPrice = 0;
        let expensiveCardName = "";
        let expensiveIsOwned = false;
        let totalAvailableFromBot = 0;
        let missingCount = 0;
        let totalCostSCE = 0;
        let allMissingAreAvailable = true;
        let totalOwnedQty = 0; // On va le recalculer proprement

        data.cards.forEach(card => {
            // SYNCHRONISATION : On utilise la longueur de l'inventaire filtré par Hash
            let myQty = (card.inv ? card.inv.length : 0);
            card.qty = myQty;
            totalOwnedQty += myQty;

            // Détection de la carte la plus chère
            const marketPrice = parseFloat(card["sce marketPriceUSD"]) || 0;
            if (marketPrice > maxPrice) {
                maxPrice = marketPrice;
                expensiveCardName = card.name;
                expensiveIsOwned = (myQty > 0);
            }

            // Stock bot utilisable (Règle SCE : stock > 1)
            const stock = parseInt(card["sce stock"]) || 0;
            if (stock > 1) {
                totalAvailableFromBot += (stock - 1);
            }

            // Analyse des manquantes
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

        // On ne bloque QUE si on ne possède pas déjà la carte chère
        const expensiveThreshold = 0.14;
        const isTooExpensive = (maxPrice > expensiveThreshold && !expensiveIsOwned);

        const expensiveInfo = maxPrice > expensiveThreshold
        ? { cardname: expensiveCardName, marketusdprice: maxPrice, isOwned: expensiveIsOwned }
        : null;

        // --- 2. DÉFINITION DES INDICATEURS ---

        // TRADE : Est-ce qu'on a assez de cartes au total (doublons inclus) pour finir le set ?
        const isCompletableViaTrade = (totalOwnedQty >= data.setCards);

        // SCE : Manquantes dispos + Budget crédits OK
        let isCompletableViaSCE = (missingCount > 0) && allMissingAreAvailable && (totalCostSCE <= currentCredit);
        let isCompletableviaSCEdoublon = (missingCount > 0) && (totalAvailableFromBot >= missingCount) && (totalCostSCE <= currentCredit);

        // SCE No Budget : Manquantes dispos peu importe le crédit
        let isCompletableviaSCEwobudget = (missingCount > 0) && allMissingAreAvailable;

        // --- 3. APPLICATION DU BLOCAGE (Si carte trop chère ET non possédée) ---
        if (isTooExpensive) {
            isCompletableViaSCE = false;
            isCompletableviaSCEwobudget = false;
            isCompletableviaSCEdoublon = false;
        }

        // --- 4. MISE À JOUR DE L'OBJET DATA ---
        data.totalOwnedQty = totalOwnedQty; // Pour debug
        data.isCompletableViaTrade = isCompletableViaTrade;
        data.isCompletableViaSCE = isCompletableViaSCE;
        data.isCompletableviaSCEwobudget = isCompletableviaSCEwobudget;
        data.isCompletableviaSCEdoublon = isCompletableviaSCEdoublon;
        data.hasExpensiveCard = expensiveInfo;
        data.totalCostSCE = totalCostSCE;
        data.missingCount = missingCount;

        return data;
    };

    // --- LOGIQUE TRADES & SYNC ---
    function parseSteamDateToMs(dateStr) {
        if (!dateStr) return 0;
        let f = dateStr.toLowerCase();
        const months = {
            "janv.": "Jan", "févr.": "Feb", "mars": "Mar", "avr.": "Apr",
            "mai": "May", "juin": "Jun", "juil.": "Jul", "août": "Aug",
            "sept.": "Sep", "oct.": "Oct", "nov.": "Nov", "déc.": "Dec"
        };
        Object.keys(months).forEach(m => f = f.replace(m, months[m]));
        f = f.replace(/h/g, ':');
        const timestamp = new Date(f).getTime();
        return isNaN(timestamp) ? 0 : timestamp;
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////syncSteamInventoryHistory////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    async function syncSteamInventoryHistory(startTime = null) {
        // 1. CONSTRUCTION DE L'URL (Format AJAX JSON)
        // On utilise start_time pour la pagination au lieu de l'URL brute
        const baseUrl = "https://steamcommunity.com/my/inventoryhistory/?ajax=1";
        const fetchUrl = startTime ? `${baseUrl}&start_time=${startTime}` : baseUrl;

        // INITIALISATION DU POINT D'ARRÊT
        if (win.ES._syncStopTimestamp === undefined) {
            win.ES._syncStopTimestamp = win.ES.DATA.lasttrade || 0;
            ES_log(`[syncSteamInventoryHistory] Point d'arrêt : ${win.ES._syncStopTimestamp} (${new Date(win.ES._syncStopTimestamp).toLocaleString()})`);
        }

        let shouldStopNextPage = false;

        try {
            const response = await fetch(fetchUrl);
            const data = await response.json(); // L'URL ajax=1 renvoie du JSON

            if (!data.success || !data.html) {
                ES_log("Erreur ou fin de l'historique.");
                return;
            }

            // Parser l'HTML contenu dans le JSON
            const doc = new DOMParser().parseFromString(data.html, "text/html");
            const rows = doc.querySelectorAll('.tradehistoryrow');

            // Accès facile aux descriptions d'objets (JSON)
            const descriptions = data.descriptions && data.descriptions["753"] ? data.descriptions["753"] : {};

            if (rows.length === 0) {
                ES_log("[syncSteamInventoryHistory] Fin de l'historique (aucune ligne trouvée).");
                return;
            }

            for (const row of rows) {
                const dateStr = row.querySelector('.tradehistory_date')?.innerText.replace(/\t|\n/g, ' ').trim();
                const timestamp = parseSteamDateToMs(dateStr);

                // Vérification du point d'arrêt
                if (win.ES._syncStopTimestamp > 0 && timestamp <= win.ES._syncStopTimestamp) {
                    ES_log(`[ES-DEBUG] ARRÊT : Le trade du ${dateStr} a déjà été traité.`);
                    shouldStopNextPage = true;
                    break;
                }

                // Extraction des items via classid et instanceid
                const items = row.querySelectorAll('.history_item');
                let rowAppIds = new Set();

                items.forEach(item => {
                    const classid = item.getAttribute('data-classid');
                    const instanceid = item.getAttribute('data-instanceid') || '0';
                    const key = `${classid}_${instanceid}`;

                    // On cherche les infos dans l'objet 'descriptions' du JSON
                    const itemData = descriptions[key];

                    if (itemData) {
                        const appid = `${itemData.market_fee_app}`;

                        // 1. On cherche d'abord dans les tags (méthode la plus précise)
                        let gameTag = (itemData.tags || []).find(t => t.category === "Game" || t.category_name === "Jeu");
                        let gameName = "";

                        if (gameTag) {
                            gameName = gameTag.name;
                        } else {
                            // 2. Fallback : On nettoie le champ 'type' si le tag est absent
                            gameName = (itemData.type || "")
                                .replace(/^(carte à échanger de|trading card from)\s+/i, '')
                                .trim();
                        }

                        if (rowAppIds.has(appid) || win.ES.isSteamEvent(appid, gameName)) return;
                        rowAppIds.add(appid);

                        if (!win.ES.DATA[appid]) win.ES.DATA[appid] = {};

                        if (!win.ES.DATA[appid].appid || !win.ES.DATA[appid].gamename) {
                            win.ES.DATA[appid].appid = appid;
                            win.ES.DATA[appid].gamename = gameName;
                        }

                        if ((win.ES.DATA[appid].fetchedAt || 0) < timestamp) {
                            win.ES.DATA[appid].lasttrade = timestamp;
                            let inventoryCache = null;
                            ES_log(`[Nouveau] ${gameName} (${dateStr})`);
                        }
                    }
                });
            }

            // MISE À JOUR DU CURSEUR GLOBAL (uniquement sur la première page)
            if (!startTime) {
                const latestDate = rows[0].querySelector('.tradehistory_date')?.innerText.replace(/\t|\n/g, ' ').trim();
                if (latestDate) {
                    win.ES.DATA.lasttrade = parseSteamDateToMs(latestDate);
                }
            }

            // NAVIGATION VIA LE CURSEUR JSON
            // Steam utilise 'cursor.time' pour la page suivante dans l'API AJAX
            if (data.cursor && data.cursor.time && !shouldStopNextPage) {
                // Sécurité anti-ban : limite de pages (optionnel)
                // Note: avec l'API AJAX, on boucle sur data.cursor.time
                await syncSteamInventoryHistory(data.cursor.time);
            } else {
                delete win.ES._syncStopTimestamp;
                ES_log("[syncSteamInventoryHistory] Synchronisation terminée avec succès.");
            }

        } catch (e) {
            delete win.ES._syncStopTimestamp;
            console.error("[ES-ERROR]", e);
        }
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

            // --- RENDU DES LABELS ---

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
                    window.open(`https://www.steamcardexchange.net/index.php?inventorygame-appid-${currentAppid}`, '_blank');
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
                createStatusLabel(statusContainer, color, `💎 ${info.cardname} ($${info.marketusdprice})${ownedText}`);
            }
        });
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

    win.ES.injectQuickTradeButtons = function(appId) {
        const gameData = win.ES.DATA[appId];
        if (!gameData || !gameData.cards) return;

        const gridCards = document.querySelectorAll(".badge_card_set_card");

        gridCards.forEach((block) => {
            const titleEl = block.querySelector(".badge_card_set_title");
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
            if (clearDiv) clearDiv.remove();
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
        reportBtn.href = "http://localhost:8080";
        reportBtn.target = "_blank";
        reportBtn.className = "btn_grey_black btn_small_thin";
        reportBtn.style.margin = "5px";
        reportBtn.style.display = "inline-block";
        reportBtn.innerHTML = "<span style='color: #a3d200;'>📊 Rapport SCE</span>";

        // Ajout des deux boutons à la zone cible
        target.prepend(reportBtn);
        target.prepend(purgeBtn);
    };

    win.ES.generateReport = function() {
        // 1. Extraction et nettoyage des données
        const rawData = win.ES.DATA;
        const data = Object.keys(rawData)
        .filter(key => !isNaN(key))
        .map(key => rawData[key]);

        const currentCredit = rawData.scecredit || 0;
        const creditRemaining = 100 - currentCredit;

        // --- FONCTION UTILITAIRE : Extraction AppID depuis le Hash ---
        // Exemple: "1900-LC | Infantry" -> "1900"
        const getAppIdFromHash = (hash) => {
            if (!hash) return null;
            return hash.split('-')[0];
        };

        // --- 1. FILTRE : CARTES CHÈRES ---
        const expensiveList = data
        .filter(g => g.hasExpensiveCard && g.hasExpensiveCard.isOwned)
        .sort((a, b) => (b.hasExpensiveCard.marketusdprice || 0) - (a.hasExpensiveCard.marketusdprice || 0));

        // --- 3. FILTRE : BADGES DISABLE TRADE-IN ---
        const disabledTradeInList = data
        .filter(g => g.disabled === true)
        .map(g => ({
            // On utilise une chaîne vide par défaut si gamename n'existe pas
            name: g.gamename || "Jeu Inconnu (" + g.appid + ")",
            appid: g.appid,
            fullCards: (g.cards || []).filter(c => (c["sce stock"] || 0) >= 8)
        }))
        // Tri sécurisé : on vérifie que 'a.name' et 'b.name' existent avant localeCompare
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

        // --- 2. FILTRE : COMPLÉTABLES (BASÉ SUR HASH) ---
        const completableSceList = data
        .filter(g => g.isCompletableViaSCE === true || g.isCompletableviaSCEdoublon === true)
        .map(g => {
            const setCardsTotal = g.setCards || 0;
            const currentTotalOwned = g.totalOwnedQty || 0;
            let gap = Math.max(0, setCardsTotal - currentTotalOwned);

            const availableOnSce = (g.cards || [])
            .filter(c => {
                // Vérification stricte : le hash doit commencer par l'appid du jeu
                return getAppIdFromHash(c.hash) === String(g.appid) && (c["sce stock"] || 0) > 1;
            })
            .sort((a, b) => (a["sce price"] || 0) - (b["sce price"] || 0));

            let tempCredit = currentCredit;
            let cardsToBuy = [];
            let totalCost = 0;

            for (const card of availableOnSce) {
                let botStockAvailable = (card["sce stock"] || 0) - 1;
                while (botStockAvailable >= 1 && cardsToBuy.length < gap && tempCredit >= (card["sce price"] || 0)) {
                    cardsToBuy.push(card);
                    totalCost += (card["sce price"] || 0);
                    tempCredit -= (card["sce price"] || 0);
                    botStockAvailable--;
                }
            }

            return {
                name: g.gamename,
                appid: g.appid,
                ownedTotal: currentTotalOwned,
                setCards: setCardsTotal,
                gap: gap,
                collectable: cardsToBuy,
                totalCost: totalCost
            };
        })
        .filter(g => g.collectable.length > 0);

        // --- 3. FILTRE : DÉPÔT (BASÉ SUR HASH) ---
        let runningTotal = 0;
        const depositList = data.filter(g => {
            // On ne dépose pas si le jeu est complétable ou désactivé
            const isCompletable = g.isCompletableViaSCE || g.isCompletableviaSCEnobudget ||
                  g.isCompletableviaSCEdoublon || g.isCompletableViaTrade;
            return !isCompletable && !g.disabled && !g.hasExpensiveCard;
        }).map(g => {
            const toGive = (g.cards || []).filter(c => {
                const isSameGame = getAppIdFromHash(c.hash) === String(g.appid);
                return isSameGame &&
                    (c.qty || 0) > 0 &&
                    (c["sce stock"] || 0) < 8 &&
                    (parseFloat(c["sce marketPriceUSD"]) || 0) < 0.09;
            });

            // CORRECTION ICI : On multiplie la valeur (worth) par la quantité possédée (qty)
            const worth = toGive.reduce((sum, c) => {
                const cardValue = parseInt(c["sce worth"]) || 0;
                const quantity = parseInt(c.qty) || 0;
                return sum + (cardValue * quantity);
            }, 0);

            const assetIds = toGive.flatMap(c => (c.inv || []).map(item => item.id)).filter(id => id).join(',');

            return {
                name: g.gamename,
                appid: g.appid,
                cards: toGive,
                assetIds: assetIds,
                totalWorth: worth
            };
        })
        .filter(g => g.totalWorth > 0 && g.assetIds !== "")
        .sort((a, b) => a.totalWorth - b.totalWorth)
        .filter(g => {
            // Vérification par rapport au crédit restant (limite des 100c du bot)
            if (runningTotal + g.totalWorth <= creditRemaining) {
                runningTotal += g.totalWorth;
                return true;
            }
            return false;
        });
        const countCards = (arr) => arr.reduce((acc, card) => {
            acc[card.name] = acc[card.name] || { data: card, count: 0 };
            acc[card.name].count++;
            return acc;
        }, {});

        // --- GÉNÉRATION DU CONTENU HTML ---
        let html = `
<!DOCTYPE html>
<html>
<head>
    <title>Rapport d'Optimisation SCE</title>
<style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #1b2838; color: #c7d5e0; padding: 20px; line-height: 1.4; }
    h1 { color: #66c0f4; border-bottom: 2px solid #2a475e; padding-bottom: 10px; display: flex; justify-content: space-between; }
    h2 { color: #ffffff; margin-top: 0; font-size: 1.2em; }
    section { background: #2a475e; padding: 15px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 4px 8px rgba(0,0,0,0.3); border: 1px solid #3d6b8a; }
    .section-warning { border: 1px solid #ff9d00; background: #3a2e1d; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; background: rgba(0,0,0,0.2); }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid #1b2838; }
    th { background: #171a21; color: #66c0f4; text-transform: uppercase; font-size: 0.8em; letter-spacing: 1px; }
    tr:hover { background: rgba(255,255,255,0.05); }
    .price { color: #a3d200; font-weight: bold; }
    .btn-link { color: #66c0f4; text-decoration: none; border: 1px solid #66c0f4; padding: 4px 10px; border-radius: 4px; font-size: 0.85em; transition: 0.2s; background: rgba(102, 192, 244, 0.1); }
    .btn-link:hover { background: #66c0f4; color: #1b2838; }
    .btn-send { background: #a3d200; color: #1b2838; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; font-weight: bold; transition: 0.2s; }
    .btn-send:hover { background: #fff; transform: scale(1.05); }
    .inv-link { color: #c7d5e0; text-decoration: none; border-bottom: 1px dashed #555; }
    small { color: #8f98a0; display: inline-block; margin: 2px; background: #171a21; padding: 3px 6px; border-radius: 3px; border: 1px solid #333; }
</style>
<script>
function autoSend(ids) {
    if(!ids) return;
    const formattedIds = ids.toString().replace(/,/g, ';');
    const baseUrl = "https://steamcommunity.com/tradeoffer/new/?partner=83905207&token=tEx7-bXd";
    const finalUrl = baseUrl + "&source=SCEBot&you=" + formattedIds + "&them=";
    window.open(finalUrl, '_blank');
}
</script>
</head>
<body>
    <h1>
        <span>📊 Rapport d'Optimisation SCE</span>
        <span style="color: #a3d200;">${currentCredit} credits</span>
    </h1>

<section>
    <h2>💎 Cartes de Valeur (> 0.14$ Market)</h2>
    <table>
        <thead><tr><th>Jeu</th><th>Carte</th><th>Prix Market</th></tr></thead>
        <tbody>
            ${expensiveList.map(g => {
                const assetId = (g.cards.find(c => c.name === g.hasExpensiveCard.cardname)?.inv[0]?.id);
                const nameHtml = assetId
                ? `<a href="https://steamcommunity.com/${profileLink}/inventory/#753_6_${assetId}" target="_blank" class="inv-link">${g.hasExpensiveCard.cardname}</a>`
                    : g.hasExpensiveCard.cardname;

                return `
                    <tr>
                        <td><a href="https://steamcommunity.com/my/gamecards/${g.appid}/" target="_blank" style="color:#66c0f4; text-decoration:none; font-weight:bold;">${g.gamename}</a></td>
                        <td>${nameHtml}</td>
                        <td class="price">${g.hasExpensiveCard.marketusdprice}$</td>
                    </tr>
                `;
            }).join('')}
        </tbody>
    </table>
</section>

<section>
    <h2>✅ Complétables via SCE (Budgetisé : ${currentCredit}c dispo)</h2>
    <table>
        <thead><tr><th>Jeu</th><th>Besoin / Coût</th><th>Cartes achetables (Stock > 1)</th></tr></thead>
        <tbody>
            ${completableSceList.map(g => {
                const expensiveStyle = g.isExpensive ? "background: rgba(255, 215, 0, 0.1); border-left: 4px solid #ffd700;" : "";
                return `
                <tr style="${expensiveStyle}">
                    <td>
                        <a href="https://steamcommunity.com/my/gamecards/${g.appid}/" target="_blank" style="color:#66c0f4; text-decoration:none; font-weight:bold;">
                            ${g.isExpensive ? '⭐ ' : ''}${g.name}
                        </a>
                        <br><small style="color:#8f98a0">Possédées: ${g.ownedTotal} / ${g.setCards}</small>
                        ${g.isExpensive ? '<br><b style="color:#ffd700; font-size:0.8em;">⚠️ CONTIENT CARTE DE VALEUR</b>' : ''}
                    </td>
                    <td>
                        <b style="color:#a3d200">Encore ${g.gap} à prendre</b><br>
                        <span class="price">Coût : -${g.totalCost}c</span>
                    </td>
                    <td>
                        ${Object.values(countCards(g.collectable)).map(item => {
                    const c = item.data;
                    const isNew = (c.qty || 0) === 0;
                    const color = isNew ? "#a3d200" : "#8f98a0";
                    return `
                                <a href="${c['sce quick-trade']}" target="_blank" class="btn-link"
                                   style="border-color: ${color}; color: ${color}; margin: 2px; display: inline-block;">
                                    ${isNew ? '🆕' : '➕'} ${c.name} ${item.count > 1 ? `<b>(x${item.count})</b>` : ''} [${c['sce price']}c]
                                </a>`;
                }).join(' ')}
                    </td>
                </tr>`;
            }).join('')}
        </tbody>
    </table>
</section>

<section>
    <h2>📤 À déposer au Bot (Max +${creditRemaining}c)</h2>
   <table>
            <thead><tr><th>Jeu</th><th>Cartes (Inventaire)</th><th>Action Automatique</th></tr></thead>
            <tbody>
                ${depositList.map(g => {
                    // 1. On récupère l'état du bot
                    const pendingOffers = win.ES.DATA.scePendingOffers || 0;
                    const isBotFull = pendingOffers > 50;

                    // 2. Calcul du nombre d'objets pour le texte
                    const totalPhysicalItems = g.cards.reduce((sum, c) => sum + (c.inv ? c.inv.length : 0), 0);

                    // 3. Définition du style et de l'état du bouton
                    // Si le bot est plein : gris et clics désactivés. Sinon : couleur normale.
                    const btnStyle = isBotFull
                    ? "background: #444; color: #888; cursor: not-allowed; border: 1px solid #555;"
                    : "background: #2e4b73; color: #fff; cursor: pointer; border: 1px solid #446899;";

                    const btnDisabled = isBotFull ? "disabled" : "";
                    const btnText = isBotFull
                    ? `⚠️ Bot Surchargé (${pendingOffers})` : `⚡ Envoyer (${g.cards.length} carte)`
                                  return `
                    <tr>
                        <td><a href="https://steamcommunity.com/my/gamecards/${g.appid}/" target="_blank" style="color:#66c0f4; text-decoration:none;">${g.name}</a></td>
                        <td>${g.cards.map(c => {
                                      const firstId = c.inv && c.inv.length > 0 ? c.inv[0].id : "";
                                      return `<small><a href="https://steamcommunity.com/${profileLink}/inventory/#753_6_${firstId}" target="_blank" class="inv-link">${c.name}</a></small>`;
                                  }).join('')}</td>
                        <td>
                            <button class="btn-send" onclick="autoSend('${g.assetIds}')"
                            ${btnDisabled}
                            style="${btnStyle} padding: 8px 12px; border-radius: 2px; width: 100%; font-weight: bold; transition: 0.2s;">
                    ${btnText}
                            </button>
                        </td>
                    </tr>
                `;}).join('')}
            </tbody>
        </table>
</section>
</body>
</html>`;

        const reportWin = window.open("", "_blank");
        reportWin.document.write(html);
        reportWin.document.close();
    };






    /**
     * GESTIONNAIRE DE TACHES SIMULTANÉES (Max 4)
     */
    async function processQueue(appids) {
        const queue = [...appids];

        const workerTask = async () => {
            while (queue.length > 0) {
                const appid = queue.shift();
                try {
                    // SÉCURITÉ : On initialise l'objet s'il n'existe pas,
                    // mais on ne l'écrase jamais s'il contient déjà des infos (comme lasttrade)
                    if (!win.ES.DATA[appid]) {
                        win.ES.DATA[appid] = {};
                    }

                    if (win.ES.isSteamEvent(appid)) return null;
                    ES_log(`[processQueue] Traitement de ${appid}...`);

                    // 1. Scrap Steam (Remplis les cartes et le nom)
                    // Note : Ta fonction fetchSteamData doit bien faire l'assignation win.ES.DATA[appid] = ...
                    await win.ES.fetchSteamData(appid);

                    // 2. Scrap SCE (Remplis les prix et stocks sur l'objet créé par Steam)
                    await win.ES.fetchSCEFresh(appid);

                    // 3. Analyse des opportunités (isCompletableViaSCE, etc.)
                    if (win.ES.analyzeBadgeStatus) {
                        win.ES.analyzeBadgeStatus(appid);
                    }

                    // 4. Sauvegarde physique du cache global
                    await win.ES.saveToCache(appid);

                    // 5. Mise à jour de l'affichage sur la ligne du badge
                    if (win.ES.updateBadgeUI) {
                        win.ES.updateBadgeUI(appid);
                    }

                } catch (e) {
                    console.error(`[Worker] Erreur critique sur ${appid}:`, e);
                }
            }
        };

        // Lancement des workers en parallèle
        const workers = Array(win.ES.CONCURRENCY_LIMIT || 4)
        .fill(null)
        .map(() => workerTask());

        await Promise.all(workers);
        ES_log("[processQueue] Scan terminé. Toutes les données sont synchronisées.");
    }

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
        //    Si l'API est disponible, on utilise ses donnees (plus fraiches que le cache local).
        //    En cas d'echec, on retombe sur le cache local et le scraping direct.
        const apiAvailable = await win.ES.fetchAPIData();

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

        // --- MODE FALLBACK: API indisponible, on utilise le scraping direct ---
        ES_log('[Workflow] API indisponible, mode scraping direct (fallback).');

        // --- CAS A: PAGE INDIVIDUELLE (GAMECARDS) ---
        if (currentUrl.includes('/gamecards/')) {
            const appIdMatch = currentUrl.match(/gamecards\/(\d+)/);
            if (appIdMatch) {
                const appId = appIdMatch[1];
                ES_log(`[Workflow] Mode Force Refresh pour l'AppID : ${appId}`);

                // On rafraîchit immédiatement les données Steam en lisant la page actuelle
                //await win.ES.fetchSteamData([appId]);
                await processQueue([appId]);

                // On analyse et on met à jour l'UI spécifique à cette page
                //win.ES.analyzeBadgeStatus(appId);
                if (win.ES.injectQuickTradeButtons) {
                    setTimeout(() => {
                        win.ES.injectQuickTradeButtons(appId);
                    }, 500);
                }
                // win.ES.updateBadgeUI(appId);

                return; // On s'arrête ici pour cette page
            }
        }

        // 1. Initialisation de la page
        if (currentUrl.includes('/badges')) {
            const itemsOnPage = getPageAppids(); // [{appid: "485450", name: "SEUM"}, ...]
            const appidsOnPage = itemsOnPage.map(i => i.appid);

            // --- INITIALISATION DE L'UI ---
            const xpBlock = document.querySelector("#responsive_page_template_content > div > div.maincontent > div.profile_xp_block");

            if (xpBlock) {
                // On vérifie s'il n'existe pas déjà pour éviter les doublons au refresh
                if (!document.getElementById('es-status-text')) {
                    const statusContainer = document.createElement('div');
                    statusContainer.style.cssText = "font-size: 11px; color: #8ed6fb; margin-top: 10px; border-top: 1px solid #333; padding-top: 5px;";

                    statusContainer.innerHTML = `
            <span style="color: #57cbde; font-weight: bold;">Crédit SCE : </span>
            <span id="es-status-text">Initialisation...</span>
        `;

                    // On l'ajoute à la fin du bloc XP (donc en bas)
                    xpBlock.appendChild(statusContainer);
                }
            }

            // Récupération de la référence après injection
            const statusEl = document.getElementById('es-status-text');
            const updateStatus = (txt) => {
                if (statusEl) {
                    // Optionnel : Ajoute le crédit SCE s'il est dispo
                    const credit = win.ES.DATA.scecredit !== undefined ? `${win.ES.DATA.scecredit}c` : '--';
                    statusEl.innerHTML = `<span style="color:#fff">${credit}</span> ${txt}`;
                }
            };

            const MS_PER_DAY = 24 * 60 * 60 * 1000;
            const now = Date.now();

            // --- LOGIQUE DE SYNCHRONISATION ET MISE À JOUR ---
            // 1. On synchronise d'abord les échanges (important pour détecter les nouveaux trades)
            updateStatus("🔍 Vérification des derniers échanges...");
            await syncSteamInventoryHistory();

            // 2. Synchronisation globale des données incomplètes (Cards manquantes)
            updateStatus("Checking global cache integrity...");
            const incompleteAppIds = Object.keys(win.ES.DATA).filter(id => {
                // On ne traite que les AppIDs numériques
                if (isNaN(id)) return false;

                const d = win.ES.DATA[id];
                const isEvent = win.ES.isSteamEvent(d.appid, d.gamename);

                // On cherche ceux qui ont été vus (fetchedAt) mais n'ont pas d'infos de cartes
                return !d || !d.fetchedAt || !d.cards || !Array.isArray(d.cards) || d.cards.length === 0 || (d.fetchedAt < d.lasttrade && !isEvent && !d.disabled);

                ES_log("[mainWorkflow Badge] a scanner: ",d.appid);
                //return hasNoCards;
            });

            /*            if (incompleteAppIds.length > 0) {
                ES_log(`[Workflow] ${incompleteAppIds.length} badges incomplets détectés dans le cache. Synchronisation...`);
                updateStatus(`🛠️ Réparation de ${incompleteAppIds.length} badges...`);
                // On traite ces IDs via la file d'attente
                //await processQueue(incompleteAppIds);
            }
*/
            // 2. On définit ce qui doit être rafraîchi (nouveaux badges, expiration 24h, ou après échange)
            const toRefresh = appidsOnPage.filter(id => {
                const d = win.ES.DATA[id];

                // Si pas de données ou pas de date de récupération -> À scanner
                //if (!d || !d.fetchedAt) return true;
                //return (d.lasttrade || 0) > d.fetchedAt;

                // Si données expirées (> 24h) -> À scanner
                const isExpired = (now - d.fetchedAt) > MS_PER_DAY;
                if (isExpired) return true;

                //ES_log("[mainWorkflow] Rien à rafraichir.");
                return false;
            });

            const combinedQueue = [...new Set([...toRefresh, ...incompleteAppIds])];

            if (combinedQueue.length > 0) {
                ES_log(`[mainWorkflow] ${combinedQueue.length} badges à mettre à jour.`);

                // Texte dynamique selon l'ampleur du scan
                const isFullScan = combinedQueue.length === appidsOnPage.length;
                updateStatus(isFullScan ? `🚀 Scan complet en cours de ${combinedQueue.length} badges...` : `🔄 Refresh de ${combinedQueue.length} badges...`);

                await processQueue(combinedQueue);

                updateStatus("✅ Mise à jour terminée.");
            } else {
                ES_log("[mainWorkflow] Tout est à jour.");
                updateStatus("✅ Cache à jour");
            }

            // 4. Dans tous les cas, on met à jour l'UI de la page avec les données (neuves ou du cache)
            appidsOnPage.forEach(id => {
                win.ES.analyzeBadgeStatus(id);
                win.ES.updateBadgeUI(id);
            });
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