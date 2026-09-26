import * as cheerio from 'cheerio';
import { httpGet, httpGetJSON, clean, isSteamEvent, sleep, parseSteamDateToMs, getSteamCookie, getSteamProfilePath, extractSessionIdFromCookies, INVENTORY_PAGE_DELAY, ES_log } from './utils.js';
import { upsertBadgeAppid, upsertGame, upsertCards, getMeta, setMeta, getGame, getBadgeAppid, getCards, updateCardMarketPrices, setGameBadgeCrafted, addOwnerToGame, addOwnerToCard } from './db.js';

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
 * @param {string} profileLink - profile link utilise pour le scan (pour le tagging owner)
 * @returns {Array} Tableau d'objets {appid, gamename}
 */
function parseBadgePage(html, profileLink = null) {
    // Debug: detecter si on est sur une page de login
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1] : '(inconnu)';
    //ES_log(`[parseBadgePage] Titre de la page: ${pageTitle}`);

    if (html.includes('login') && html.includes('steamLogin')) {
        console.error('[parseBadgePage] Page de login detectee - les cookies Steam sont invalides.');
    }

    // Debug: verifier la presence de badge_row
    const badgeCount = (html.match(/badge_row/g) || []).length;
    //ES_log(`[parseBadgePage] ${badgeCount} elements badge_row trouves dans le HTML.`);

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

            // Tag owner: ce profil possede ce badge (appid)
            if (profileLink) {
                addOwnerToGame(appId, profileLink);
            }

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

// ═════════════════════════════════════════════════════════════
// Caches anti rate-limit (endpoints Steam)
// ═════════════════════════════════════════════════════════════
/**
 * TTL des caches Steam. Objectif : minimiser les requetes vers
 * steamcommunity.com (rate limit ~100/min) sans casser la fraicheur :
 * - un trade detecte (syncSteamInventoryHistory) invalide le cache
 *   inventaire et force un re-scan cible des jeux concernes
 * - les commandes manuelles (sync:badges, sync:gamecards, --scan-all,
 *   --refetch-cards) bypassent ces TTL via l option force
 * - les prix marche ont leur propre limite 24h (MARKET_PRICE_REFRESH_MS,
 *   voir market.js)
 */
export const STEAM_CACHE_TTL = {
    // Pages /badges?p=N (liste d appids + gamenames) : stable, peu de nouveaux jeux
    BADGE_PAGES_MS: 60 * 60 * 1000,        // 1 heure
    // ajaxgetbadgeinfo (cartes du set + qty possedees) : rafraichi par les
    // scans complets et les rescans forces apres trade
    STEAM_DATA_MS: 30 * 60 * 1000,         // 30 minutes
    // Re-check du statut badge_crafted = 0 (badge pas encore genere).
    // Un badge_crafted = 1 n est pas re-checke par les scans automatiques
    // (un badge crafte ne disparait pas) SAUF si refetchCrafted = true
    // (option passee par le daemon npm run sync) ; les rescans forces
    // post-trade et les commandes manuelles le re-checkent quand meme (force: true).
    BADGE_CRAFTED_FALSE_MS: 30 * 60 * 1000, // 30 minutes
    // Inventaire 753_6 (fillInventoryData) : partage par toutes les taches
    // d un meme cycle + invalide des qu un nouveau trade est detecte
    INVENTORY_MS: 5 * 60 * 1000,           // 5 minutes
};

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
    return parseBadgePage(html, pl);
}

/**
 * Scanne TOUTES les pages de badges (p=1..N) et retourne les appids dedupliques.
 * Le nombre de pages est detecte depuis la pagination de la page 1
 * (liens ?p=N ou texte "Showing 1-150 of 246 badges").
 * Resultat mis en cache 1h (STEAM_CACHE_TTL.BADGE_PAGES_MS) : le scan
 * complet daemon (15 min) reutilise la liste au lieu de re-fetcher toutes
 * les pages de badges a chaque cycle.
 * @param {string} profileLink - "my" ou SteamID64
 * @param {Object} options - { force: true } pour bypasser le cache
 * @returns {Promise<Array>} Tableau d'objets {appid, gamename}
 */
let badgePagesCache = null; // { profileLink, appids, fetchedAt }

export function invalidateBadgePagesCache() {
    badgePagesCache = null;
}

export async function getAllPagesAppids(profileLink = null, options = {}) {
    const pl = profileLink || profilePath();
    const { force = false } = options;

    if (!force && badgePagesCache && badgePagesCache.profileLink === pl
        && Date.now() - badgePagesCache.fetchedAt < STEAM_CACHE_TTL.BADGE_PAGES_MS) {
        ES_log(`[getAllPagesAppids] Cache liste appids (< ${STEAM_CACHE_TTL.BADGE_PAGES_MS / 60000} min), ${badgePagesCache.appids.length} badges reutilises.`);
        return badgePagesCache.appids;
    }

    const all = [];
    const seen = new Set();

    const fetchPage = (page) => httpGet(
        `https://steamcommunity.com/${pl}/badges?p=${page}`,
        { cookies: steamCookie(), extraHeaders: { 'Referer': 'https://steamcommunity.com/' } }
    );

    // Page 1: detecte la pagination
    const firstHtml = await fetchPage(1);
    const maxPage = detectMaxBadgePage(firstHtml);
    //ES_log(`[getAllPagesAppids] ${maxPage} page(s) de badges detectee(s).`);

    let html = firstHtml;
    for (let page = 1; page <= maxPage; page++) {
        if (page > 1) {
            html = await fetchPage(page);
            await sleep(500); // Anti-rate-limit entre les pages
        }

        const results = parseBadgePage(html, pl);
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

    badgePagesCache = { profileLink: pl, appids: all, fetchedAt: Date.now() };
    return all;
}

/**
 * Recupere les donnees d'inventaire Steam de maniere paginee
 * @param {string} profileLink - "my" ou SteamID64
 * @returns {Promise<Object>} {rgInventory, rgDescriptions}
 */
let inventoryCache = null; // { profileLink, data: {rgInventory, rgDescriptions}, fetchedAt }
let inventoryFetchPromise = null;

/** Invalide le cache inventaire (nouveau trade ou purge manuelle). */
export function invalidateInventoryCache() {
    //ES_log('[fetchInventory] Cache inventaire invalide.');
    inventoryCache = null;
}

export async function fetchInventory(profileLink = null) {
    const pl = profileLink || profilePath();

    // Cache TTL: l inventaire est partage par toutes les taches du cycle.
    // Un trade detecte par syncSteamInventoryHistory invalide ce cache.
    if (inventoryCache && inventoryCache.profileLink === pl
        && Date.now() - inventoryCache.fetchedAt < STEAM_CACHE_TTL.INVENTORY_MS) {
        return inventoryCache.data;
    }
    inventoryCache = null; // expire

    // Une seule requete d'inventaire a la fois: les workers paralleles de
    // processQueue partagent le meme resultat (evite N fetchs simultanes
    // de l'inventaire quand fetchSCEInventory tourne en 4 taches)
    if (inventoryFetchPromise) return inventoryFetchPromise;

    inventoryFetchPromise = _fetchInventory(pl)
        .finally(() => { inventoryFetchPromise = null; });
    return inventoryFetchPromise;
}

async function _fetchInventory(pl) {
    let allInventory = {};
    let allDescriptions = {};
    let nextStart = 0;
    let hasMore = true;

    //ES_log('[fetchInventory] Debut de la recuperation complete...');

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
        inventoryCache = { profileLink: pl, data: { rgInventory: allInventory, rgDescriptions: allDescriptions }, fetchedAt: Date.now() };
        return inventoryCache.data;
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
        // Multi-compte: on NE reset plus inv a [], on accumule les asset IDs
        // de plusieurs profils. On retire d abord les items du profil actuel
        // pour eviter les doublons (refresh du meme profil).
        cards.forEach(card => {
            if (!card.inv) card.inv = [];
            // Retire les items deja associes a ce profil (refresh)
            card.inv = card.inv.filter(i => i.profile !== pl);
        });

        const invData = await fetchInventory(pl);
        if (!invData) return cards;

        const { rgInventory, rgDescriptions } = invData;

        //ES_log('[fillInventoryData] Utilisation du cache inventaire...');

        for (const itemId of Object.keys(rgInventory)) {
            const item = rgInventory[itemId];
            const descKey = `${item.classid}_${item.instanceid}`;
            const desc = rgDescriptions[descKey];

            if (desc && desc.tags && desc.tags.some(t => t.internal_name === 'item_class_2')) {
                const appidTag = desc.tags.find(t => t.category === 'Game');
                const itemAppId = desc.market_fee_app || (appidTag ? appidTag.internal_name.replace('app_', '') : null);

                if (itemAppId && desc.market_hash_name) {
                    // Ne pas nettoyer le market_hash_name : on le stocke tel quel
                    // pour correspondre au hash en DB (format market_hash_name complet)
                    const card = cards.find(c => c.hash === desc.market_hash_name);
                    if (card) {
                        if (!card.inv.some(i => i.id === item.id)) {
                            card.inv.push({ id: item.id, pos: item.pos, profile: pl });
                        }
                    }
                }
            }
        }

        // Mise a jour de qty (total toutes profils confondus)
        cards.forEach(c => { c.qty = c.inv.length; });

        // Tag owner: les cartes avec des items de ce profil sont possedees par ce profil
        cards.forEach(card => {
            if (card.inv.some(i => i.profile === pl) && card.hash) {
                card.owner = card.owner || '';
                // On utilisera addOwnerToCard en DB (plus sur pour COALESCE)
                const owners = card.owner.split(',').map(s => s.trim()).filter(Boolean);
                if (!owners.includes(pl)) {
                    owners.push(pl);
                    card.owner = owners.join(',');
                }
            }
        });

        const ownedCount = cards.reduce((acc, c) => acc + c.inv.length, 0);
        //ES_log(`[fillInventoryData] Termine. ${ownedCount} cartes identifiees.`);

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
 * - Badge crafte : la page contient "badge_info_unlocked" (badge obtenu + date de deblocage)
 *   et/ou "badge_icon" (image du badge crafte, ex: "Level 2, 200 XP")
 * - Badge non crafte : la page contient "badge_empty_circle" (ex: "Niveau 0 - X cartes collectees sur Y")
 *
 * Cache anti rate-limit (DB, colonnes badge_crafted / badge_crafted_fetched_at) :
 * - badge_crafted = 1 : pas re-checke par les scans automatiques SAUF si
 *   refetchCrafted = true (option passee par le daemon npm run sync pour
 *   re-verifier periodicement les badges deja craftes) ; re-checke si force
 *   (rescan post-trade, commandes manuelles)
 * - badge_crafted = 0 verifie il y a moins de BADGE_CRAFTED_FALSE_MS : skip
 * - NULL (jamais verifie) ou resultat indetermine : pas de cache
 * - { force: true } bypass ces regles
 * - { refetchCrafted: true } bypass uniquement le skip de badge_crafted = 1
 * Le resultat (true/false) est ecrit en DB par setGameBadgeCrafted.
 *
 * @param {string} appid
 * @param {string|null} profileLink - optionnel: autre profil a verifier (defaut: compte principal)
 * @param {Object} options - { force: true } pour bypasser le cache,
 *   { refetchCrafted: true } pour re-fetcher meme si badge_crafted = 1
 * @returns {Promise<boolean|null>} true = deja genere, false = pas encore, null = indetermine (erreur)
 */
export async function fetchBadgeCrafted(appid, profileLink = null, options = {}) {
    const pl = profileLink || BADGE_PROFILE_PATH;
    if (isSteamEvent(appid)) return null;
    const { force = false, refetchCrafted = false } = options;

    // Cache DB : evite de re-fetch la page gamecards a chaque scan complet
    const existing = getGame(appid);
    const crafted = existing?.badge_crafted ?? null;
    if (!force) {
        if (crafted === 1 && !refetchCrafted) {
           // ES_log(`[fetchBadgeCrafted] ${appid}: badge crafte (cache DB), pas de re-check.`);
            return true;
        }
        const checkedAt = Number(existing?.badge_crafted_fetched_at ?? 0);
        if (crafted === 0 && checkedAt > 0
            && Date.now() - checkedAt < STEAM_CACHE_TTL.BADGE_CRAFTED_FALSE_MS) {
            //ES_log(`[fetchBadgeCrafted] ${appid}: badge non crafte verifie recemment, pas de re-check.`);
            return false;
        }
    }

    const url = `https://steamcommunity.com/${pl}/gamecards/${appid}`;
    try {
        const html = await httpGet(url, { cookies: steamCookie(), retries: 2 });
        if (!html) return null;
        // Garde-fou : si le compte n a aucune carte pour ce jeu, Steam redirige vers
        // la page /badges (remplie de badges crafte -> faux positif). On verifie donc
        // que la page recue est bien une page gamecards avant d appliquer les marqueurs.
        if (!html.includes('badge_gamecard_page')) return null;
        // Badge crafte : la page montre le badge obtenu (image + date de deblocage).
        // On teste ces marqueurs AVANT le cercle vide car un badge de niveau partiel
        // affiche a la fois le badge crafte et le cercle vide du niveau suivant.
        let result = null;
        if (html.includes('badge_info_unlocked') || html.includes('badge_icon')) result = true;
        // Badge non crafte : cercle vide (ex: "Niveau 0 - X cartes collectees sur Y")
        else if (html.includes('badge_empty_circle')) result = false;

        // Seuls les resultats deterministes sont caches en DB (jamais les erreurs)
        if (result !== null) setGameBadgeCrafted(appid, result);
        return result;
    } catch (e) {
        //ES_log(`[fetchBadgeCrafted] Erreur pour ${appid}: ${e.message}`);
        return null;
    }
}

/**
 * Recupere les donnees Steam pour un badge (cartes du set) + statut badge crafte
 *
 * Cache anti rate-limit : si games.fetched_at date de moins de
 * STEAM_CACHE_TTL.STEAM_DATA_MS et que les cartes existent en DB, les
 * donnees DB sont reutilisees sans requete vers ajaxgetbadgeinfo (les
 * rescans forces apres trade passent { force: true } pour bypasser).
 *
 * @param {string} appid
 * @param {string} profileLink
 * @param {Object} options - { force: true } pour bypasser le cache TTL,
 *   { retries: 3 } nombre de tentatives,
 *   { refetchCrafted: true } pour re-fetcher le statut badge_crafted = 1
 */
export async function fetchSteamData(appid, profileLink = null, options = {}) {
    const pl = profileLink || profilePath();
    if (isSteamEvent(appid)) return null;
    const { force = false, retries = 3, refetchCrafted = false } = options;

    // Cache TTL : donnees Steam deja recuperees recemment -> reutilisation DB
    // fetchBadgeCrafted garde son propre cache DB (badge_crafted), on le
    // laisse s evaluer meme sur un cache-hit pour respecter son TTL
    if (!force) {
        const existingGame = getGame(appid);
        if (existingGame?.fetched_at
            && Date.now() - existingGame.fetched_at < STEAM_CACHE_TTL.STEAM_DATA_MS
            && (getCards(appid) || []).length > 0) {
            ES_log(`[fetchSteamData] ${appid}: donnees Steam fraiches (< ${STEAM_CACHE_TTL.STEAM_DATA_MS / 60000} min), reutilisees sans requete.`);

            // Le cache porte sur les donnees du set (noms, hashes, icons) qui sont
            // stables, mais l inventaire peut avoir change (cartes vendues sur le
            // marche, echangees). On rafraichit l inventaire meme sur cache-hit pour
            // que inv_json et totalOwnedQty restent a jour. fetchInventory a son
            // propre cache (5 min) donc aucune requete HTTP superflue la plupart du temps.
            const dbCards = getCards(appid);
            const cards = dbCards.map(c => ({
                name: c.name,
                qty: c.qty,
                index: c.card_index,
                inv: JSON.parse(c.inv_json || '[]'),
                hash: c.hash,
                iconUrl: c.icon_url,
                artUrl: c.art_url,
                owner: c.owner || '',
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
            await fillInventoryData(cards, pl);
            upsertCards(appid, cards);

            await fetchBadgeCrafted(appid, null, { force, refetchCrafted });
            return { ...existingGame, cards };
        }
    }

    const url = `https://steamcommunity.com/${pl}/ajaxgetbadgeinfo/${appid}`;
   // ES_log(`[fetchSteamData] entree fonction ${appid}`);

    try {
        const text = await httpGet(url, { cookies: steamCookie(), retries, accept: 'application/json', extraHeaders: STEAM_AJAX_HEADERS });
        const data = JSON.parse(text);

        if (data.eresult !== 1 || !data.badgedata) return null;

        // Initialisation des cartes - hash = market_hash_name brut (sans nettoyage)
        const cards = data.badgedata.rgCards.map((card, index) => {
            return {
                name: card.name,
                qty: card.owned || 0,  // Fix: le script original avait un bug (card.owned || 0, 10) qui donnait toujours 10
                index: index,
                inv: [],
                hash: card.markethash,
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
        // fetchBadgeCrafted ecrit lui-meme le resultat en DB (cache badge_crafted)
        // et herite du mode force de fetchSteamData
        await fetchBadgeCrafted(appid, null, { force, refetchCrafted });

        return { ...gameData, cards };
    } catch (error) {
        if (retries > 0) {
            await sleep(3000);
            return await fetchSteamData(appid, profileLink, { force, retries: retries - 1, refetchCrafted });
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
    // Overlap de 10 min : Steam peut mettre du temps a afficher un trade dans
    // l historique. Sans overlap, un trade accepte a T mais visible seulement a
    // T+5min serait saute si le curseur a deja avance. On re-traite les 10
    // dernieres minutes pour rattraper les trades retardes.
    const OVERLAP_MS = 10 * 60 * 1000;
    let stopTimestamp = Math.max(0, originalStopTimestamp - OVERLAP_MS);
    const updatedAppIds = new Set(); // Appids dont lasttrade a ete modifie

    ES_log(`[syncSteamInventoryHistory] Point d arret: ${originalStopTimestamp} (${new Date(originalStopTimestamp).toLocaleString()}) + overlap 10 min → ${stopTimestamp} (${new Date(stopTimestamp).toLocaleString()})`);

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

           // ES_log(`[syncSteamInventoryHistory] ${rows.length} trades sur la page ${pageCount + 1}.`);

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
                       // ES_log(`[syncSteamInventoryHistory] Curseur lasttrade mis a jour: ${ts} (${new Date(ts).toLocaleString()})`);
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

    // Nouveaux trades detectes : le cache inventaire est obsolete, on
    // l invalide pour que le re-scan force recupere les assetIds a jour
    if (updatedAppIds.size > 0) {
        invalidateInventoryCache();
    }
    return Array.from(updatedAppIds);
}

// --- STEAM COMMUNITY MARKET HISTORY ---

/**
 * Synchronise l historique des transactions du Marche Communautaire Steam
 * pour detecter les ventes/achats de cartes et mettre a jour les lasttrade.
 * Utilise l endpoint /market/myhistory/render/ qui renvoie du JSON structure
 * (events, listings, purchases, assets) - pas de parsing HTML necessaire.
 *
 * Met a jour les lasttrade dans la base, comme syncSteamInventoryHistory,
 * mais avec un curseur separe (lastmarkettrade) pour eviter les conflits.
 */
export async function syncSteamMarketHistory(profileLink = null) {
    const originalStopTimestamp = parseInt(getMeta('lastmarkettrade', '0'), 10) || 0;
    // Overlap de 10 min : meme rationale que syncSteamInventoryHistory
    const OVERLAP_MS = 10 * 60 * 1000;
    const stopTimestamp = Math.max(0, originalStopTimestamp - OVERLAP_MS);
    const updatedAppIds = new Set();

    ES_log(`[syncSteamMarketHistory] Point d arret: ${originalStopTimestamp} (${new Date(originalStopTimestamp).toLocaleString()}) + overlap 10 min → ${stopTimestamp} (${new Date(stopTimestamp).toLocaleString()})`);

    let start = 0;
    const COUNT = 500; // Taille de page maximale
    const MAX_PAGES = 50; // Securite anti-ban

    for (let page = 0; page < MAX_PAGES; page++) {
        const sessionId = extractSessionIdFromCookies(steamCookie());
        const baseUrl = sessionId
            ? `https://steamcommunity.com/market/myhistory/render/?query=&start=${start}&count=${COUNT}&norender=1&sessionid=${sessionId}`
            : `https://steamcommunity.com/market/myhistory/render/?query=&start=${start}&count=${COUNT}&norender=1`;

        try {
            const text = await httpGet(baseUrl, {
                cookies: steamCookie(),
                accept: 'application/json',
                extraHeaders: {
                    ...STEAM_AJAX_HEADERS,
                    'Referer': 'https://steamcommunity.com/market/myhistory',
                },
            });

            // Detection: Steam renvoie du HTML si les cookies sont invalides
            if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
                console.error('[syncSteamMarketHistory] Steam a renvoyé du HTML au lieu du JSON.');
                console.error('Cela signifie que les cookies Steam sont invalides ou expires.');
                console.error('Supprimez data/steam_refresh_token.txt et relancez pour vous re-authentifier.');
                const titleMatch = text.match(/<title>(.*?)<\/title>/i);
                if (titleMatch) console.error(`[syncSteamMarketHistory] Titre de la page: ${titleMatch[1]}`);
                console.error(`[syncSteamMarketHistory] URL: ${baseUrl}`);
                console.error(`[syncSteamMarketHistory] Cookie (30 chars): ${(steamCookie() || '').substring(0, 30)}...`);
                break;
            }

            const data = JSON.parse(text);

            if (!data.success) {
                ES_log('[syncSteamMarketHistory] Erreur ou fin de l historique.');
                break;
            }

            const events = data.events || [];
            if (events.length === 0) {
                ES_log('[syncSteamMarketHistory] Fin de l historique (aucun evenement).');
                break;
            }

            //ES_log(`[syncSteamMarketHistory] ${events.length} evenement(s) sur la page ${page + 1}.`);

            // Trier par time_event decroissant pour traiter les plus recentes en premier
            const sortedEvents = [...events].sort((a, b) => b.time_event - a.time_event);

            let shouldStop = false;
            let newCount = 0;

            for (const event of sortedEvents) {
                // time_event en secondes + fraction pour la precision sub-seconde
                const timestamp = event.time_event * 1000 + Math.floor((event.time_event_fraction || 0) / 1e6);

                if (stopTimestamp > 0 && timestamp <= stopTimestamp) {
                    ES_log(`[syncSteamMarketHistory] ARRET: evenement du ${new Date(timestamp).toLocaleString()} deja traite (ts=${timestamp} <= stop=${stopTimestamp}).`);
                    shouldStop = true;
                    break;
                }

                const eventType = event.event_type === 3 ? 'vente' : (event.event_type === 4 ? 'achat' : `type ${event.event_type}`);
                ES_log(`[syncSteamMarketHistory] Transaction du ${new Date(timestamp).toLocaleString()}: ${eventType}`);
                newCount++;

                // Resoudre l appid du jeu via le listing
                const listing = data.listings ? data.listings[event.listingid] : null;
                if (!listing) continue;

                // 1. publisher_fee_app (le plus fiable pour les cartes)
                let appid = listing.publisher_fee_app;

                // 2. Fallback: asset.market_fee_app si present
                if (!appid && listing.asset && listing.asset.market_fee_app) {
                    appid = listing.asset.market_fee_app;
                }

                // 3. Fallback: extraire le prefixe numerique du market_hash_name
                if (!appid || appid === 753) {
                    const assetId = listing.asset && listing.asset.id;
                    const assetAppid = listing.asset && String(listing.asset.appid);
                    const assetContextid = listing.asset && String(listing.asset.contextid);
                    if (assetId && assetAppid && data.assets && data.assets[assetAppid] && data.assets[assetAppid][assetContextid]) {
                        const assetData = data.assets[assetAppid][assetContextid][assetId];
                        if (assetData && assetData.market_hash_name) {
                            const prefixMatch = assetData.market_hash_name.match(/^(\d+)-/);
                            if (prefixMatch) {
                                appid = parseInt(prefixMatch[1], 10);
                            }
                        }
                    }
                }

                // Ne pas traiter si on n a resolu qu appid 753 (Steam) sans jeu precis
                if (!appid || appid === 753) {
                    ES_log(`[syncSteamMarketHistory] Appid non resolu (753/Steam), transaction ignoree.`);
                    continue;
                }

                appid = String(appid);

                // Recuperer le nom du jeu depuis les assets
                let gameName = '';
                const assetId = listing.asset && listing.asset.id;
                const assetAppid = listing.asset && String(listing.asset.appid);
                const assetContextid = listing.asset && String(listing.asset.contextid);
                if (assetId && assetAppid && assetContextid && data.assets && data.assets[assetAppid] && data.assets[assetAppid][assetContextid]) {
                    const assetData = data.assets[assetAppid][assetContextid][assetId];
                    if (assetData) {
                        let gameTag = (assetData.tags || []).find(t => t.category === 'Game' || t.category_name === 'Jeu');
                        if (gameTag) {
                            gameName = gameTag.name;
                        } else {
                            gameName = (assetData.type || '').replace(/^(carte à échanger de|trading card from)\s+/i, '').trim();
                        }
                    }
                }

                if (isSteamEvent(appid, gameName)) continue;

                // Enregistrer le badge appid si nouveau
                upsertBadgeAppid(appid, gameName, false);

                // Mettre a jour lasttrade
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
                    ES_log(`[syncSteamMarketHistory] -> ${gameName} (${appid}) lasttrade mis a jour`);
                }
            }

            ES_log(`[syncSteamMarketHistory] ${newCount} nouvelle(s) transaction(s) traitee(s) sur cette page.`);

            // Mise a jour du curseur global (premiere page uniquement, evenement le plus recent)
            if (start === 0 && sortedEvents.length > 0) {
                const latestTs = sortedEvents[0].time_event * 1000 + Math.floor((sortedEvents[0].time_event_fraction || 0) / 1e6);
                if (latestTs > 0) {
                    setMeta('lastmarkettrade', String(latestTs));
                   // ES_log(`[syncSteamMarketHistory] Curseur lastmarkettrade mis a jour: ${latestTs} (${new Date(latestTs).toLocaleString()})`);
                }
            }

            if (shouldStop || start + COUNT >= (data.total_count || 0)) {
                ES_log(`[syncSteamMarketHistory] Synchronisation terminee. ${updatedAppIds.size} jeu(x) a re-scanner.`);
                break;
            }

            start += COUNT;
            await sleep(500); // Anti-rate-limit
        } catch (e) {
            console.error('[syncSteamMarketHistory] Erreur:', e);
            break;
        }
    }

    // Nouvelles transactions detectees : le cache inventaire est obsolete
    if (updatedAppIds.size > 0) {
        invalidateInventoryCache();
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

        // Le hash en DB est le market_hash_name complet (ex: "1021770-jiao (Trading Card)")
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


