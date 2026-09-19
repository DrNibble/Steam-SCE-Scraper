import * as cheerio from 'cheerio';
import { httpGet, httpGetJSON, clean, isSteamEvent, sleep, parseSteamDateToMs, getSteamCookie, getSteamProfilePath, extractSessionIdFromCookies, INVENTORY_PAGE_DELAY, ES_log } from './utils.js';
import { upsertBadgeAppid, upsertGame, upsertCards, getMeta, setMeta, getGame, getBadgeAppid, getCards, updateCardMarketPrices } from './db.js';

// Cookie Steam dynamique (recupere via auth.js ou .env)
function steamCookie() { return getSteamCookie(); }
function profilePath() { return getSteamProfilePath(); }

// Headers communs pour les requetes AJAX steamcommunity.com
const STEAM_AJAX_HEADERS = {
    'Referer': 'https://steamcommunity.com/',
    'X-Requested-With': 'XMLHttpRequest',
};

/**
 * Recupere les appids et noms de jeux depuis la page des badges
 * @param {string} profileLink - "my" ou SteamID64
 * @returns {Promise<Array>} Tableau d'objets {appid, gamename}
 */
export async function getPageAppids(profileLink = null) {
    const pl = profileLink || profilePath();
    const url = `https://steamcommunity.com/${pl}/badges`;
    const html = await httpGet(url, { cookies: steamCookie(), extraHeaders: { 'Referer': 'https://steamcommunity.com/' } });

    // Debug: detecter si on est sur une page de login
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1] : '(inconnu)';
    ES_log(`[getPageAppids] Titre de la page: ${pageTitle}`);

    if (html.includes('login') && html.includes('steamLogin')) {
        console.error('[getPageAppids] Page de login detectee - les cookies Steam sont invalides.');
    }

    // Debug: verifier la presence de badge_row
    const badgeCount = (html.match(/badge_row/g) || []).length;
    ES_log(`[getPageAppids] ${badgeCount} elements badge_row trouves dans le HTML.`);

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
 * Recupere les donnees d'inventaire Steam de maniere paginee
 * @param {string} profileLink - "my" ou SteamID64
 * @returns {Promise<Object>} {rgInventory, rgDescriptions}
 */
let inventoryCache = null;

export async function fetchInventory(profileLink = null) {
    const pl = profileLink || profilePath();
    if (inventoryCache) return inventoryCache;

    let allInventory = {};
    let allDescriptions = {};
    let nextStart = 0;
    let hasMore = true;

    ES_log('[fetchInventory] Debut de la recuperation complete...');

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

/**
 * Recupere les donnees Steam pour un badge (cartes du set)
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
 */
export async function syncSteamInventoryHistory(profileLink = null) {
    const pl = profileLink || profilePath();
    let startTime = null;
    const originalStopTimestamp = parseInt(getMeta('lasttrade', '0'), 10) || 0;
    let stopTimestamp = originalStopTimestamp;
    const updatedAppIds = new Set(); // Appids dont lasttrade a ete modifie

    ES_log(`[syncSteamInventoryHistory] Point d arret: ${stopTimestamp} (${new Date(stopTimestamp).toLocaleString()})`);

    let pageCount = 0;
    const MAX_PAGES = 50; // Securite anti-ban

    while (pageCount < MAX_PAGES) {
        // Inclure le sessionid dans l'URL pour la protection CSRF de Steam
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

            // Detection: Steam renvoie du HTML si les cookies sont invalides
            if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
                console.error('[syncSteamInventoryHistory] Steam a renvoyé du HTML au lieu du JSON.');
                console.error('Cela signifie que les cookies Steam sont invalides ou expires.');
                console.error('Supprimez data/steam_refresh_token.txt et relancez pour vous re-authentifier.');
                // Debug: afficher le titre de la page pour identifier le probleme
                const titleMatch = text.match(/<title>(.*?)<\/title>/i);
                if (titleMatch) console.error(`[syncSteamInventoryHistory] Titre de la page: ${titleMatch[1]}`);
                console.error(`[syncSteamInventoryHistory] URL: ${fetchUrl}`);
                console.error(`[syncSteamInventoryHistory] Cookie (30 chars): ${(steamCookie() || '').substring(0, 30)}...`);
                break;
            }

            const data = JSON.parse(text);

            if (!data.success || !data.html) {
                ES_log('[syncSteamInventoryHistory] Erreur ou fin de l historique.');
                break;
            }

            const $ = cheerio.load(data.html);
            const rows = $('.tradehistoryrow');

            const descriptions = (data.descriptions && data.descriptions['753']) ? data.descriptions['753'] : {};

            if (rows.length === 0) {
                ES_log('[syncSteamInventoryHistory] Fin de l historique (aucune ligne).');
                break;
            }

            ES_log(`[syncSteamInventoryHistory] ${rows.length} trades sur la page ${pageCount + 1}.`);

            let shouldStop = false;
            let newTradeCount = 0;

            rows.each((_, row) => {
                const $row = $(row);
                const dateStr = ($row.find('.tradehistory_date').text() || '').replace(/\t|\n/g, ' ').trim();
                const timestamp = parseSteamDateToMs(dateStr);

                if (stopTimestamp > 0 && timestamp <= stopTimestamp) {
                    ES_log(`[syncSteamInventoryHistory] ARRET: trade du ${dateStr} deja traite (ts=${timestamp} <= stop=${stopTimestamp}).`);
                    shouldStop = true;
                    return false; // break each
                }

                // Trade nouveau: on le logue systematiquement
                const eventDesc = ($row.find('.tradehistory_event_description').text() || '').replace(/\t|\n/g, ' ').trim();
                ES_log(`[syncSteamInventoryHistory] Trade du ${dateStr}: ${eventDesc}`);
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
                            gameName = (itemData.type || '').replace(/^(carte à échanger de|trading card from)\s+/i, '').trim();
                        }

                        if (rowAppIds.has(appid) || isSteamEvent(appid, gameName)) return;
                        rowAppIds.add(appid);

                        // Enregistre le badge appid si nouveau
                        upsertBadgeAppid(appid, gameName, false);

                        // Met a jour lasttrade systematiquement pour les trades nouveaux
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
                            ES_log(`[syncSteamInventoryHistory] -> ${gameName} (${appid}) lasttrade mis a jour`);
                        }
                    }
                });
            });

            ES_log(`[syncSteamInventoryHistory] ${newTradeCount} nouveau(x) trade(s) traite(s) sur cette page.`);

            // Mise a jour du curseur global (premiere page uniquement)
            if (!startTime) {
                const firstRow = $(rows[0]);
                const latestDate = (firstRow.find('.tradehistory_date').text() || '').replace(/\t|\n/g, ' ').trim();
                if (latestDate) {
                    const ts = parseSteamDateToMs(latestDate);
                    if (ts > 0) {
                        setMeta('lasttrade', String(ts));
                        ES_log(`[syncSteamInventoryHistory] Curseur lasttrade mis a jour: ${ts} (${new Date(ts).toLocaleString()})`);
                    }
                }
            }

            if (shouldStop || !data.cursor || !data.cursor.time) {
                ES_log(`[syncSteamInventoryHistory] Synchronisation terminee. ${updatedAppIds.size} jeu(x) a re-scanner.`);
                break;
            }

            startTime = data.cursor.time;
            pageCount++;
            await sleep(500); // Anti-rate-limit
        } catch (e) {
            console.error('[syncSteamInventoryHistory] Erreur:', e);
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


