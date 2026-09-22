import * as cheerio from 'cheerio';
import { httpGet, httpGetJSON, clean, isSteamEvent, sleep, parseSteamDateToMs, getSteamCookie, getSteamProfilePath, extractSessionIdFromCookies, extractSteamIdFromCookies, INVENTORY_PAGE_DELAY, ES_log } from './utils.js';
import { upsertBadgeAppid, upsertGame, upsertCards, getMeta, setMeta, getGame, getBadgeAppid, getCards, updateCardMarketPrices, setGameBadgeCrafted } from './db.js';
import { hasSteamApiKey, hasPublisherApiKey, getInventory as apiGetInventory, getTradeHistory as apiGetTradeHistory, getCurrentSteamId } from './steamApi.js';

// Cookie Steam dynamique (recupere via auth.js ou .env)
function steamCookie() { return getSteamCookie(); }
function profilePath() { return getSteamProfilePath(); }

// Headers communs pour les requetes AJAX steamcommunity.com
const STEAM_AJAX_HEADERS = {
    'Referer': 'https://steamcommunity.com/',
    'X-Requested-With': 'XMLHttpRequest',
};

/**
 * Parse le HTML d'une page de badges et enregistre les appids en DB.
 * @param {string} html - HTML d'une page /badges (une seule page)
 * @returns {Array} Tableau d'objets {appid, gamename}
 */
function parseBadgePage(html) {
    // Debug: detecter si on est sur une page de login
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1] : '(inconnu)';
    ES_log(`[parseBadgePage] Titre de la page: ${pageTitle}`);

    if (html.includes('login') && html.includes('steamLogin')) {
        console.error('[parseBadgePage] Page de login detectee - les cookies Steam sont invalides.');
    }

    // Debug: verifier la presence de badge_row
    const badgeCount = (html.match(/badge_row/g) || []).length;
    ES_log(`[parseBadgePage] ${badgeCount} elements badge_row trouves dans le HTML.`);

    const $ = cheerio.load(html);

    const results = [];
    const rows = $('.badge_row');

    rows.each((_, row) => {
        const $row = $(row);
        const link = $row.find('.badge_row_overlay').attr('href') || '';
        const titleEl = $row.find('.badge_title');

        const match = link.match(/\/gamecards\/(\d+)/);
        if (match) {
            const appId = match[1];
            let gameName = titleEl.text()
                .replace(/Voir les détails/gi, '')
                .replace(/Badge de collectionneur/gi, '')
                .trim();

            const isEvent = isSteamEvent(appId, gameName);

            // Enregistre dans badge_appids
            upsertBadgeAppid(appId, gameName, isEvent);

            if (!isEvent) {
                results.push({ appid: appId, gamename: gameName });
                ES_log(`[getPageAppids] appid: ${appId} gamename: ${gameName}`);
            }
        }
    });

    return results;
}

/**
 * Detecte le nombre total de pages de badges depuis le HTML d'une page /badges.
 * - Sources: liens de pagination "?p=N" (.pagelink / .pagebtn)
 * - Fallback: texte "Showing 1-150 of 246 badges"
 * @param {string} html - HTML d'une page /badges
 * @returns {number} Nombre de pages (1 si pas de pagination)
 */
function detectMaxBadgePage(html) {
    let maxPage = 1;

    // 1. Liens de pagination ?p=N
    const pagingMatch = html.match(/<div class="profile_paging">[\s\S]*?<\/div>\s*<\/div>/);
    const pagingHtml = pagingMatch ? pagingMatch[0] : html;
    for (const m of pagingHtml.matchAll(/[?&]p=(\d+)/g)) {
        maxPage = Math.max(maxPage, parseInt(m[1], 10));
    }

    // 2. Complement: "Showing 1-150 of 246 badges" -> nombre de pages total
    //    (toujours pris en compte, meme si des liens ?p=N existent deja)
    const showMatch = pagingHtml.match(/Showing\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)\s+badges/i);
    if (showMatch) {
        const perPage = parseInt(showMatch[2], 10) - parseInt(showMatch[1], 10) + 1;
        const total = parseInt(showMatch[3], 10);
        if (perPage > 0 && total > 0) {
            maxPage = Math.max(maxPage, Math.ceil(total / perPage));
        }
    }

    return maxPage;
}

/**
 * Recupere les appids et noms de jeux depuis UNE page des badges
 * @param {string} profileLink - "my" ou SteamID64
 * @param {number} page - numero de page (p=1 par defaut)
 * @returns {Promise<Array>} Tableau d'objets {appid, gamename}
 */
export async function getPageAppids(profileLink = null, page = 1) {
    const pl = profileLink || profilePath();
    const url = `https://steamcommunity.com/${pl}/badges?p=${page}`;
    const html = await httpGet(url, { cookies: steamCookie(), extraHeaders: { 'Referer': 'https://steamcommunity.com/' } });
    return parseBadgePage(html);
}

/**
 * Scanne TOUTES les pages de badges (p=1..N) et retourne les appids dedupliques.
 * Le nombre de pages est detecte depuis la pagination de la page 1
 * (liens ?p=N ou texte "Showing 1-150 of 246 badges").
 * @param {string} profileLink - "my" ou SteamID64
 * @returns {Promise<Array>} Tableau d'objets {appid, gamename}
 */
export async function getAllPagesAppids(profileLink = null) {
    const pl = profileLink || profilePath();
    const all = [];
    const seen = new Set();

    const fetchPage = (page) => httpGet(
        `https://steamcommunity.com/${pl}/badges?p=${page}`,
        { cookies: steamCookie(), extraHeaders: { 'Referer': 'https://steamcommunity.com/' } }
    );

    // Page 1: detecte la pagination
    const firstHtml = await fetchPage(1);
    const maxPage = detectMaxBadgePage(firstHtml);
    ES_log(`[getAllPagesAppids] ${maxPage} page(s) de badges detectee(s).`);

    let html = firstHtml;
    for (let page = 1; page <= maxPage; page++) {
        if (page > 1) {
            html = await fetchPage(page);
            await sleep(500); // Anti-rate-limit entre les pages
        }

        const results = parseBadgePage(html);
        let newCount = 0;
        for (const item of results) {
            if (!seen.has(item.appid)) {
                seen.add(item.appid);
                all.push(item);
                newCount++;
            }
        }
        ES_log(`[getAllPagesAppids] Page ${page}/${maxPage}: ${results.length} badges dont ${newCount} nouveau(x).`);
    }

    return all;
}

/**
 * Recupere les donnees d'inventaire Steam de maniere paginee
 *
 * Strategie:
 *   1. Si STEAM_API_KEY est configuree: utilise IInventoryService/GetInventory (API officielle)
 *      - Note: GetInventory necessite une cle publisher Steamworks (Economy permissions).
 *        Si la cle est une cle utilisateur (steamcommunity.com/dev/apikey), l'API retournera
 *        une erreur 403 et on fallback automatiquement vers l'endpoint communautaire.
 *   2. Sinon (ou fallback): utilise l'endpoint communautaire steamcommunity.com/inventory/json/753/6/
 *      avec les cookies steamLoginSecure (comportement historique).
 *
 * @param {string} profileLink - "my" ou SteamID64
 * @returns {Promise<Object>} {rgInventory, rgDescriptions}
 */
let inventoryCache = null;
let inventoryFetchPromise = null;

export async function fetchInventory(profileLink = null) {
    if (inventoryCache) return inventoryCache;

    // Une seule requete d'inventaire a la fois: les workers paralleles de
    // processQueue partagent le meme resultat (evite N fetchs simultanes
    // de l'inventaire quand fetchSCEInventory tourne en 4 taches)
    if (inventoryFetchPromise) return inventoryFetchPromise;

    inventoryFetchPromise = _fetchInventory(profileLink || profilePath())
        .finally(() => { inventoryFetchPromise = null; });
    return inventoryFetchPromise;
}

async function _fetchInventory(pl) {
    let allInventory = {};
    let allDescriptions = {};
    let nextStart = 0;
    let hasMore = true;

    ES_log('[fetchInventory] Debut de la recuperation complete...');

    // --- Tentative via API officielle (IInventoryService/GetInventory) ---
    // GetInventory nécessite une clé publisher (Economy permissions).
    // Une clé utilisateur standard (steamcommunity.com/dev/apikey) retourne 403 Forbidden.
    // On ne tente l'API officielle que si une clé publisher est configurée.
    if (hasPublisherApiKey()) {
        const steamId = getCurrentSteamId() || (pl.startsWith('profiles/') ? pl.replace('profiles/', '') : null);
        if (steamId) {
            ES_log(`[fetchInventory] Tentative via API officielle (steamid=${steamId}, clé publisher)...`);
            try {
                const result = await apiGetInventory(steamId, 753, { contextid: 6, fallbackToCommunity: false });
                if (result && result.assets && result.assets.length > 0) {
                    // Convertir le format API (assets/descriptions arrays) au format communautaire (rgInventory/rgDescriptions dict)
                    const rgInventory = {};
                    const rgDescriptions = {};
                    for (const asset of result.assets) {
                        rgInventory[asset.assetid] = {
                            id: asset.assetid,
                            classid: asset.classid,
                            instanceid: asset.instanceid || '0',
                            pos: asset.position || 0,
                        };
                    }
                    for (const desc of result.descriptions) {
                        const key = `${desc.classid}_${desc.instanceid || '0'}`;
                        rgDescriptions[key] = desc;
                    }
                    inventoryCache = { rgInventory, rgDescriptions };
                    ES_log(`[fetchInventory] ${Object.keys(rgInventory).length} items recuperes via API officielle.`);
                    return inventoryCache;
                }
                ES_log('[fetchInventory] API officielle: aucun asset retourne, fallback vers endpoint communautaire.');
            } catch (err) {
                ES_log(`[fetchInventory] API officielle echouee: ${err.message}. Fallback vers endpoint communautaire.`);
            }
        } else {
            ES_log('[fetchInventory] STEAM_API_KEY configuree mais SteamID introuvable. Utilisation de l endpoint communautaire.');
        }
    } else {
        ES_log('[fetchInventory] Pas de STEAM_API_KEY, utilisation de l endpoint communautaire.');
    }

    // --- Fallback: endpoint communautaire steamcommunity.com/inventory/json/753/6/ ---
    while (hasMore) {
        const url = `https://steamcommunity.com/${pl}/inventory/json/753/6/?start=${nextStart}`;
        const data = await httpGetJSON(url, { cookies: steamCookie(), extraHeaders: STEAM_AJAX_HEADERS });

        if (data && data.success) {
            if (data.rgInventory) Object.assign(allInventory, data.rgInventory);
            if (data.rgDescriptions) Object.assign(allDescriptions, data.rgDescriptions);

            if (data.more === true && data.more_start) {
                nextStart = data.more_start;
                await sleep(INVENTORY_PAGE_DELAY);
            } else {
                hasMore = false;
            }
        } else {
            hasMore = false;
        }
    }

    if (Object.keys(allInventory).length > 0) {
        inventoryCache = { rgInventory: allInventory, rgDescriptions: allDescriptions };
        return inventoryCache;
    }

    console.error('[Inventory] Impossible de charger l inventaire.');
    return null;
}

/**
 * Lie les IDs d'inventaire aux cartes par correspondance de hash
 * @param {Array} cards - Tableau d objets cartes
 * @param {string} profileLink
 */
export async function fillInventoryData(cards, profileLink = null) {
    const pl = profileLink || profilePath();
    try {
        // Reinitialisation
        cards.forEach(card => { card.inv = []; });

        const invData = await fetchInventory(pl);
        if (!invData) return cards;

        const { rgInventory, rgDescriptions } = invData;

        ES_log('[fillInventoryData] Utilisation du cache inventaire...');

        for (const itemId of Object.keys(rgInventory)) {
            const item = rgInventory[itemId];
            const descKey = `${item.classid}_${item.instanceid}`;
            const desc = rgDescriptions[descKey];

            if (desc && desc.tags && desc.tags.some(t => t.internal_name === 'item_class_2')) {
                const appidTag = desc.tags.find(t => t.category === 'Game');
                const itemAppId = desc.market_fee_app || (appidTag ? appidTag.internal_name.replace('app_', '') : null);

                if (itemAppId && desc.market_hash_name) {
                    const cleanMarketHash = desc.market_hash_name
                        .replace(/\s*\(trading card\)\s*/gi, '')
                        .trim();

                    const card = cards.find(c => c.hash === cleanMarketHash);
                    if (card) {
                        if (!card.inv.some(i => i.id === item.id)) {
                            card.inv.push({ id: item.id, pos: item.pos });
                        }
                    }
                }
            }
        }

        // Mise a jour de qty
        cards.forEach(c => { c.qty = c.inv.length; });

        const ownedCount = cards.reduce((acc, c) => acc + c.inv.length, 0);
        ES_log(`[fillInventoryData] Termine. ${ownedCount} cartes identifiees.`);

        return cards;
    } catch (error) {
        console.error('Echec de fillInventoryData:', error);
        return cards;
    }
}

// Compte PRINCIPAL dont on verifie si le badge a deja ete genere (peu importe le niveau).
// Ce n est PAS le compte scrape (inventory/SCE) : le compte principal est identifie
// par son URL personnalisee (id/Dr_Nibble => SteamID64 76561198028880269).
// Surchargeable via la variable d environnement BADGE_PROFILE_PATH.
const BADGE_PROFILE_PATH = process.env.BADGE_PROFILE_PATH || 'id/Dr_Nibble';

/**
 * Verifie sur la page gamecards si le badge d un jeu a deja ete genere (crafte)
 * par le compte PRINCIPAL (BADGE_PROFILE_PATH), peu importe le niveau.
 *
 * Strategie de detection (avec garde-fou contre les faux positifs):
 *   1. On charge le HTML avec cheerio pour isoler la section du badge du compte principal
 *   2. Badge crafte: la section principale contient "badge_info_unlocked" (badge obtenu)
 *      ou "badge_icon" (image du badge crafte)
 *   3. Badge non crafte: "badge_empty_circle" (cercle vide, ex: "Niveau 0")
 *   4. On EXCLUT la section "badge_friends_have_earned" qui montre les badges
 *      des amis et peut contenir des marqueurs similaires (faux positifs)
 *   5. Garde-fou: si la page n est pas une page gamecards, retourne null
 *
 * @param {string} appid
 * @param {string|null} profileLink - optionnel: autre profil a verifier (defaut: compte principal)
 * @returns {Promise<boolean|null>} true = deja genere, false = pas encore, null = indetermine (erreur)
 */
export async function fetchBadgeCrafted(appid, profileLink = null) {
    const pl = profileLink || BADGE_PROFILE_PATH;
    if (isSteamEvent(appid)) return null;

    const url = `https://steamcommunity.com/${pl}/gamecards/${appid}`;
    try {
        const html = await httpGet(url, { cookies: steamCookie(), retries: 2 });
        if (!html) return null;

        // Garde-fou : si le compte n a aucune carte pour ce jeu, Steam redirige vers
        // la page /badges (remplie de badges crafte -> faux positif). On verifie donc
        // que la page recue est bien une page gamecards avant d appliquer les marqueurs.
        if (!html.includes('badge_gamecard_page')) return null;

        // Charger le HTML avec cheerio pour isoler les sections
        const $ = cheerio.load(html);

        // Supprimer la section "badge_friends_have_earned" du DOM avant detection.
        // Cette section liste les amis qui ont crafte le badge et peut contenir
        // des marqueurs similaires (badge_icon, etc.) qui provoquent des faux positifs.
        $('.badge_friends_have_earned').remove();
        $('.badge_detail_tasks').remove();

        // Extraire le texte de la page sans la section des amis
        const cleanHtml = $('body').html() || '';

        // Badge crafte : la page montre le badge obtenu (image + date de deblocage).
        // On teste ces marqueurs AVANT le cercle vide car un badge de niveau partiel
        // affiche a la fois le badge crafte et le cercle vide du niveau suivant.
        if (cleanHtml.includes('badge_info_unlocked') || cleanHtml.includes('badge_icon')) return true;

        // Badge non crafte : cercle vide (ex: "Niveau 0 - X cartes collectees sur Y")
        if (cleanHtml.includes('badge_empty_circle')) return false;

        return null;
    } catch (e) {
        ES_log(`[fetchBadgeCrafted] Erreur pour ${appid}: ${e.message}`);
        return null;
    }
}

/**
 * Recupere les donnees Steam pour un badge (cartes du set) + statut badge crafte
 * @param {string} appid
 * @param {string} profileLink
 * @param {number} retries
 */
export async function fetchSteamData(appid, profileLink = null, retries = 3) {
    const pl = profileLink || profilePath();
    if (isSteamEvent(appid)) return null;

    const url = `https://steamcommunity.com/${pl}/ajaxgetbadgeinfo/${appid}`;
    ES_log(`[fetchSteamData] entree fonction ${appid}`);

    try {
        const text = await httpGet(url, { cookies: steamCookie(), retries, accept: 'application/json', extraHeaders: STEAM_AJAX_HEADERS });
        const data = JSON.parse(text);

        if (data.eresult !== 1 || !data.badgedata) return null;

        // Initialisation des cartes avec nettoyage du hash
        const cards = data.badgedata.rgCards.map((card, index) => {
            const cleanHash = card.markethash.replace(/\s*\(trading card\)\s*/gi, '').trim();
            return {
                name: card.name,
                qty: card.owned || 0,  // Fix: le script original avait un bug (card.owned || 0, 10) qui donnait toujours 10
                index: index,
                inv: [],
                hash: cleanHash,
                iconUrl: card.imgurl,
                artUrl: card.arturl
            };
        });

        // On ne traite l'inventaire que si au moins une carte a une qty > 0
        const hasOwnedCards = cards.some(c => c.qty > 0);

        if (hasOwnedCards) {
            await fillInventoryData(cards, pl);
        } else {
            ES_log(`[fetchSteamData] AppID ${appid}: Aucune carte possedee (qty=0), matching inventaire ignore.`);
        }

        // Recupere les donnees existantes
        const existingGame = getGame(appid) || {};
        // Recupere le gamename depuis badge_appids si pas deja present
        const badgeAppid = getBadgeAppid(appid);
        const gameData = {
            ...existingGame,
            appid: String(appid),
            gamename: existingGame.gamename || (badgeAppid ? badgeAppid.gamename : null),
            setCards: cards.length,
            fetchedAt: Date.now(),
        };

        // Sauvegarde en DB
        upsertGame(appid, gameData);
        upsertCards(appid, cards);

        // Badge deja genere par le COMPTE PRINCIPAL ? (best-effort : on garde la valeur existante si indetermine)
        const badgeCrafted = await fetchBadgeCrafted(appid);
        if (badgeCrafted !== null) {
            setGameBadgeCrafted(appid, badgeCrafted);
        }

        return { ...gameData, cards };
    } catch (error) {
        if (retries > 0) {
            await sleep(3000);
            return await fetchSteamData(appid, profileLink, retries - 1);
        }
        return null;
    }
}

/**
 * Synchronise l historique des trades Steam pour detecter les nouveaux echanges
 * Met a jour les lasttrade dans la base
 *
 * Strategie:
 *   1. Si STEAM_API_KEY est configuree: utilise IEconService/GetTradeHistory (API officielle)
 *      - Retourne du JSON structure (pas de HTML a parser)
 *      - Rate limite par steamApi.js (1 req/s, 100 000/jour)
 *   2. Sinon: fallback vers le scraping HTML de /inventoryhistory (methode historique)
 *
 * @param {string} profileLink - "my" ou SteamID64
 * @returns {Promise<Array>} Tableau des appids dont lasttrade a ete modifie
 */
export async function syncSteamInventoryHistory(profileLink = null) {
    // --- Strategie 1: API officielle GetTradeHistory ---
    if (hasSteamApiKey()) {
        ES_log('[syncSteamInventoryHistory] Utilisation de l API officielle GetTradeHistory.');
        try {
            const result = await _syncTradeHistoryApi();
            if (result) return result;
            ES_log('[syncSteamInventoryHistory] API GetTradeHistory: aucun resultat, fallback vers le scraping HTML.');
        } catch (e) {
            ES_log(`[syncSteamInventoryHistory] API GetTradeHistory echouee: ${e.message}. Fallback vers le scraping HTML.`);
        }
    }

    // --- Strategie 2: Fallback scraping HTML ---
    return _syncTradeHistoryHtml(profileLink);
}

/**
 * Synchronise l historique des trades via l API officielle GetTradeHistory.
 * @returns {Promise<Array|null>} Tableau des appids mis a jour, ou null si erreur
 */
async function _syncTradeHistoryApi() {
    const originalStopTimestamp = parseInt(getMeta('lasttrade', '0'), 10) || 0;
    const stopTimestamp = originalStopTimestamp;
    const updatedAppIds = new Set();

    ES_log(`[_syncTradeHistoryApi] Point d arret: ${stopTimestamp} (${new Date(stopTimestamp).toLocaleString()})`);

    let startAfterTime = null;
    let startAfterTradeId = null;
    let hasMore = true;
    let pageCount = 0;
    const MAX_PAGES = 50;

    while (hasMore && pageCount < MAX_PAGES) {
        const tradeParams = {
            max_trades: 100,
            get_descriptions: true,
            include_failed: false,
            include_total: false,
            language: 'english',
        };

        // Ne pas envoyer start_after_time/tradeid sur la premiere page
        if (startAfterTime !== null) {
            tradeParams.start_after_time = startAfterTime;
            tradeParams.start_after_tradeid = startAfterTradeId;
            tradeParams.navigating_back = 0;
        }

        const result = await apiGetTradeHistory(tradeParams);

        const response = result.response;
        if (!response || !response.trades || response.trades.length === 0) {
            ES_log('[_syncTradeHistoryApi] Fin de l historique (aucun trade).');
            break;
        }

        // Construire un dictionnaire des descriptions (key: classid_instanceid)
        const descMap = {};
        if (response.descriptions) {
            for (const desc of response.descriptions) {
                const key = `${desc.classid}_${desc.instanceid || '0'}`;
                descMap[key] = desc;
            }
        }

        ES_log(`[_syncTradeHistoryApi] ${response.trades.length} trades sur la page ${pageCount + 1}.`);

        let shouldStop = false;
        let newTradeCount = 0;

        for (const trade of response.trades) {
            // Timestamp Unix en secondes -- plusieurs champs possibles selon la version API
            const tsSec = trade.time_init ?? trade.time_trade_start ?? trade.time_updated ?? trade.time_created ?? 0;
            const timestamp = tsSec * 1000;

            if (stopTimestamp > 0 && timestamp <= stopTimestamp) {
                ES_log(`[_syncTradeHistoryApi] ARRET: trade (ts=${timestamp} <= stop=${stopTimestamp}).`);
                shouldStop = true;
                break;
            }

            newTradeCount++;

            // Parcourir les assets recus et donnes
            const allAssets = [
                ...(trade.assets_received || []),
                ...(trade.assets_given || []),
            ];

            const rowAppIds = new Set();

            for (const asset of allAssets) {
                const key = `${asset.classid}_${asset.instanceid || '0'}`;
                const desc = descMap[key];
                if (!desc) continue;

                const appid = `${desc.market_fee_app || asset.appid}`;
                if (!appid || rowAppIds.has(appid) || isSteamEvent(appid)) continue;
                rowAppIds.add(appid);

                // Extraire le nom du jeu depuis les tags
                let gameName = '';
                const gameTag = (desc.tags || []).find(t => t.category === 'Game' || t.category_name === 'Jeu');
                if (gameTag) {
                    gameName = gameTag.name;
                } else {
                    gameName = (desc.type || '').replace(/^(carte a echanger de|trading card from)\s+/i, '').trim();
                }

                // Enregistre le badge appid si nouveau
                upsertBadgeAppid(appid, gameName, false);

                // Met a jour lasttrade
                const existingGame = getGame(appid);
                const prevLasttrade = existingGame?.lasttrade || 0;
                if (!prevLasttrade || prevLasttrade < timestamp) {
                    upsertGame(appid, {
                        ...(existingGame || {}),
                        appid: String(appid),
                        gamename: gameName,
                        lasttrade: timestamp,
                    });
                    updatedAppIds.add(String(appid));
                    ES_log(`[_syncTradeHistoryApi] -> ${gameName} (${appid}) lasttrade mis a jour`);
                }
            }
        }

        ES_log(`[_syncTradeHistoryApi] ${newTradeCount} nouveau(x) trade(s) traite(s) sur cette page.`);

        // Mettre a jour le curseur global (premiere page uniquement)
        if (pageCount === 0 && response.trades.length > 0) {
            const firstTrade = response.trades[0];
            const firstTsSec = firstTrade.time_init ?? firstTrade.time_trade_start ?? firstTrade.time_updated ?? firstTrade.time_created ?? 0;
            const latestTs = firstTsSec * 1000;
            if (latestTs > 0) {
                setMeta('lasttrade', String(latestTs));
                ES_log(`[_syncTradeHistoryApi] Curseur lasttrade mis a jour: ${latestTs} (${new Date(latestTs).toLocaleString()})`);
            }
        }

        if (shouldStop || !response.more) {
            ES_log(`[_syncTradeHistoryApi] Synchronisation terminee. ${updatedAppIds.size} jeu(x) a re-scanner.`);
            hasMore = false;
            break;
        }

        // Pagination: utiliser le dernier trade comme point de depart
        const lastTrade = response.trades[response.trades.length - 1];
        const lastTsSec = lastTrade.time_init ?? lastTrade.time_trade_start ?? lastTrade.time_updated ?? lastTrade.time_created ?? 0;
        const lastTradeId = lastTrade.tradeid || '';

        // Garde-fou: si le curseur n a pas change, on arrete pour eviter une boucle infinie
        if (startAfterTime !== null && startAfterTime === lastTsSec && startAfterTradeId === lastTradeId) {
            ES_log('[_syncTradeHistoryApi] Curseur inchange - arret pour eviter une boucle infinie.');
            break;
        }

        startAfterTime = lastTsSec;
        startAfterTradeId = lastTradeId;
        pageCount++;
    }

    return Array.from(updatedAppIds);
}

/**
 * Synchronise l historique des trades via le scraping HTML (methode historique).
 * @param {string} profileLink
 * @returns {Promise<Array>}
 */
async function _syncTradeHistoryHtml(profileLink = null) {
    const pl = profileLink || profilePath();
    let startTime = null;
    const originalStopTimestamp = parseInt(getMeta('lasttrade', '0'), 10) || 0;
    let stopTimestamp = originalStopTimestamp;
    const updatedAppIds = new Set();

    ES_log(`[_syncTradeHistoryHtml] Point d arret: ${stopTimestamp} (${new Date(stopTimestamp).toLocaleString()})`);

    let pageCount = 0;
    const MAX_PAGES = 50;

    while (pageCount < MAX_PAGES) {
        const sessionId = extractSessionIdFromCookies(steamCookie());
        const baseUrl = sessionId
            ? `https://steamcommunity.com/${pl}/inventoryhistory/?ajax=1&sessionid=${sessionId}`
            : `https://steamcommunity.com/${pl}/inventoryhistory/?ajax=1`;
        const fetchUrl = startTime ? `${baseUrl}&start_time=${startTime}` : baseUrl;

        try {
            const text = await httpGet(fetchUrl, {
                cookies: steamCookie(),
                accept: 'application/json, text/javascript, */*; q=0.01',
                extraHeaders: {
                    ...STEAM_AJAX_HEADERS,
                    'Referer': `https://steamcommunity.com/${pl}/inventoryhistory/`,
                },
            });

            if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
                console.error('[_syncTradeHistoryHtml] Steam a renvoye du HTML au lieu du JSON.');
                console.error('Cela signifie que les cookies Steam sont invalides ou expires.');
                console.error('Supprimez data/steam_refresh_token.txt et relancez pour vous re-authentifier.');
                const titleMatch = text.match(/<title>(.*?)<\/title>/i);
                if (titleMatch) console.error(`[_syncTradeHistoryHtml] Titre de la page: ${titleMatch[1]}`);
                break;
            }

            const data = JSON.parse(text);

            if (!data.success || !data.html) {
                ES_log('[_syncTradeHistoryHtml] Erreur ou fin de l historique.');
                break;
            }

            const $ = cheerio.load(data.html);
            const rows = $('.tradehistoryrow');
            const descriptions = (data.descriptions && data.descriptions['753']) ? data.descriptions['753'] : {};

            if (rows.length === 0) {
                ES_log('[_syncTradeHistoryHtml] Fin de l historique (aucune ligne).');
                break;
            }

            ES_log(`[_syncTradeHistoryHtml] ${rows.length} trades sur la page ${pageCount + 1}.`);

            let shouldStop = false;
            let newTradeCount = 0;

            rows.each((_, row) => {
                const $row = $(row);
                const dateStr = ($row.find('.tradehistory_date').text() || '').replace(/\t|\n/g, ' ').trim();
                const timestamp = parseSteamDateToMs(dateStr);

                if (stopTimestamp > 0 && timestamp <= stopTimestamp) {
                    ES_log(`[_syncTradeHistoryHtml] ARRET: trade du ${dateStr} deja traite (ts=${timestamp} <= stop=${stopTimestamp}).`);
                    shouldStop = true;
                    return false;
                }

                const eventDesc = ($row.find('.tradehistory_event_description').text() || '').replace(/\t|\n/g, ' ').trim();
                ES_log(`[_syncTradeHistoryHtml] Trade du ${dateStr}: ${eventDesc}`);
                newTradeCount++;

                const items = $row.find('.history_item');
                const rowAppIds = new Set();

                items.each((_, item) => {
                    const $item = $(item);
                    const classid = $item.attr('data-classid');
                    const instanceid = $item.attr('data-instanceid') || '0';
                    const key = `${classid}_${instanceid}`;

                    const itemData = descriptions[key];
                    if (itemData) {
                        const appid = `${itemData.market_fee_app}`;
                        let gameTag = (itemData.tags || []).find(t => t.category === 'Game' || t.category_name === 'Jeu');
                        let gameName = '';
                        if (gameTag) {
                            gameName = gameTag.name;
                        } else {
                            gameName = (itemData.type || '').replace(/^(carte a echanger de|trading card from)\s+/i, '').trim();
                        }

                        if (rowAppIds.has(appid) || isSteamEvent(appid, gameName)) return;
                        rowAppIds.add(appid);

                        upsertBadgeAppid(appid, gameName, false);

                        const existingGame = getGame(appid);
                        const prevLasttrade = existingGame?.lasttrade || 0;
                        if (!prevLasttrade || prevLasttrade < timestamp) {
                            upsertGame(appid, {
                                ...(existingGame || {}),
                                appid: String(appid),
                                gamename: gameName,
                                lasttrade: timestamp,
                            });
                            updatedAppIds.add(String(appid));
                            ES_log(`[_syncTradeHistoryHtml] -> ${gameName} (${appid}) lasttrade mis a jour`);
                        }
                    }
                });
            });

            ES_log(`[_syncTradeHistoryHtml] ${newTradeCount} nouveau(x) trade(s) traite(s) sur cette page.`);

            if (!startTime) {
                const firstRow = $(rows[0]);
                const latestDate = (firstRow.find('.tradehistory_date').text() || '').replace(/\t|\n/g, ' ').trim();
                if (latestDate) {
                    const ts = parseSteamDateToMs(latestDate);
                    if (ts > 0) {
                        setMeta('lasttrade', String(ts));
                        ES_log(`[_syncTradeHistoryHtml] Curseur lasttrade mis a jour: ${ts} (${new Date(ts).toLocaleString()})`);
                    }
                }
            }

            if (shouldStop || !data.cursor || !data.cursor.time) {
                ES_log(`[_syncTradeHistoryHtml] Synchronisation terminee. ${updatedAppIds.size} jeu(x) a re-scanner.`);
                break;
            }

            startTime = data.cursor.time;
            pageCount++;
            await sleep(500);
        } catch (e) {
            console.error('[_syncTradeHistoryHtml] Erreur:', e);
            break;
        }
    }

    return Array.from(updatedAppIds);
}

// --- STEAM COMMUNITY MARKET PRICE HISTORY ---

/**
 * Parse une date au format Steam pricehistory: "Sep 19 2024 01: +0"
 * Retourne un timestamp en millisecondes (UTC)
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
    // Convertir en UTC: soustraire l'offset timezone
    const totalOffsetMin = tzOffsetHours * 60 + (tzOffsetHours >= 0 ? tzOffsetMin : -tzOffsetMin);
    return Date.UTC(year, m, day, hour) - totalOffsetMin * 60000;
}

/**
 * Parse une chaine de prix formatee (ex: "0,03\u20ac", "€0.03", "1,234.56€")
 * Retourne un float ou null si le parsing echoue
 */
function parsePriceString(str) {
    if (!str) return null;
    // Supprimer les symboles monetaires et espaces
    let s = str.replace(/[€$\s]/g, '').trim();
    if (!s) return null;
    // Remplacer la virgule par un point (format europeen)
    s = s.replace(/,/g, '.');
    // Gerer les multiples points (separateurs de milliers)
    const parts = s.split('.');
    if (parts.length > 2) {
        s = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
    }
    const val = parseFloat(s);
    return isNaN(val) ? null : val;
}

/**
 * Recupere les prix du marche Steam Community pour toutes les cartes d'un jeu.
 * Utilise l'endpoint priceoverview avec httpGet (cookies Steam natifs).
 *
 * Strategie:
 *   1. priceoverview -> prix EUR (median_price ou lowest_price) + volume 24h
 *   2. median_price present = ventes dans les ~5 derniers jours (dans les 7j)
 *   3. volume > 0 = ventes dans les 24h (dans les 7j)
 *
 * Extrait:
 *   - steam_market_price_eur: prix de vente en EUR (ou null si inconnu)
 *   - steam_market_sales_7d: nombre de ventes dans les 7 derniers jours
 *
 * @param {string} appid
 */
export async function fetchSteamMarketPrices(appid) {
    const cards = getCards(appid);
    if (!cards || cards.length === 0) return;

    const steamCookieVal = steamCookie();

    ES_log(`[fetchSteamMarketPrices] Recuperation des prix pour ${cards.length} cartes (appid ${appid})...`);

    const priceMap = new Map();

    for (const card of cards) {
        if (!card.hash) continue;

        // Le hash en DB est deja au format market_hash_name (ex: 1021770-jiao)
        const marketHashName = card.hash;
        const encodedName = encodeURIComponent(marketHashName);

        let priceEur = null;
        let sales7d = 0;

        // --- priceoverview (leger, via httpGet avec cookies Steam) ---
        try {
            const overviewUrl = `https://steamcommunity.com/market/priceoverview/?appid=753&market_hash_name=${encodedName}&l=english&currency=3`;
            const overviewText = await httpGet(overviewUrl, {
                cookies: steamCookieVal,
                accept: 'application/json',
                extraHeaders: {
                    'Referer': 'https://steamcommunity.com/',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                retries: 2,
            });

            const overview = JSON.parse(overviewText);

            ES_log(`[fetchSteamMarketPrices] priceoverview ${card.name || card.hash}: success=${overview.success}, lowest=${overview.lowest_price || 'N/A'}, median=${overview.median_price || 'N/A'}, volume=${overview.volume || '0'}`);

            if (overview.success) {
                // median_price = prix median sur ~5 jours. Sa presence = ventes recentes.
                if (overview.median_price) {
                    priceEur = parsePriceString(overview.median_price);
                    const volume24h = parseInt(overview.volume) || 0;
                    // Au moins 1 vente dans les 7j (median_price implique des ventes recentes)
                    sales7d = Math.max(volume24h, 1);
                } else if (overview.lowest_price) {
                    // Pas de median_price (pas de ventes recentes), mais il y a des annonces
                    priceEur = parsePriceString(overview.lowest_price);
                    const volume24h = parseInt(overview.volume) || 0;
                    if (volume24h > 0) {
                        sales7d = volume24h;
                    }
                }
            }
        } catch (e) {
            ES_log(`[fetchSteamMarketPrices] priceoverview erreur pour ${card.name || card.hash}: ${e.message}`);
        }

        priceMap.set(card.hash, { priceEur, sales7d });
        ES_log(`[fetchSteamMarketPrices] ${card.name || card.hash}: ${priceEur !== null ? priceEur + '€' : 'N/A'}, ${sales7d} ventes 7j`);

        await sleep(2500); // Anti-rate-limit Steam (~24 req/min max)
    }

    // Met a jour la DB en une seule transaction
    updateCardMarketPrices(appid, priceMap);

    ES_log(`[fetchSteamMarketPrices] Termine pour appid ${appid} (${priceMap.size} cartes mises a jour).`);
}


