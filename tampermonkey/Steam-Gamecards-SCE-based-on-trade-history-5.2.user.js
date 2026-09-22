// ==UserScript==
// @name         Steam-Gamecards-SCE based on API
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Scrap complet Steam & SCE avec cache persistant, workers et API REST
// @author       DrNibble
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
            if (clearDiv && clearDiv.parentNode) clearDiv.parentNode.removeChild(clearDiv);
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
