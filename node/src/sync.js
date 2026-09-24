import { sleep, isSteamEvent, ES_log, getSteamProfilePath, setSteamCookie, getSteamCookie, httpGet } from './utils.js';
import { getPageAppids, getAllPagesAppids, fetchSteamData, syncSteamInventoryHistory, invalidateBadgePagesCache, invalidateInventoryCache } from './steam.js';
import { fetchSCEFresh, fetchSCEGlobalInfo, isSCEBusy, resetCreditFlag } from './sce.js';
import { analyzeBadgeStatus } from './analyze.js';
import { getAllBadgeAppids, getIncompleteBadgeAppids, getGame, purgeCache, getMeta, setMeta, isDBEmpty, countGames } from './db.js';
import { getSteamCookies } from './auth.js';
import { fetchMarketPricesV2, fetchSingleCardPrice } from './market.js';
import { startMarketWorker, enqueueGameCards, enqueueStaleCards, getQueueStats, PRIORITY } from './marketQueue.js';
import { startApiServer } from './api.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000; // 1 jour
// Intervalle du mode surveillance : scan de l historique des trades (tradehistory)
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Intervalle du scan complet des badges (toutes les pages, phases 1 + 2)
// lance par le daemon `npm run sync` en mode surveillance
const FULL_BADGE_SCAN_INTERVAL_MS = 1 * MS_PER_DAY;

// Scan SCE: fetchSCEInventory s'execute en 4 taches paralleles si le waitTime
// SCE (minutes) est < 1, sinon de facon sequentielle
const SCE_PARALLEL_TASKS = 4;
const SCE_PARALLEL_WAITTIME_MAX = 1;

/**
 * Traite une liste d'appids (fetchSteamData + fetchSCEFresh par appid).
 * fetchSCEInventory s'execute en 4 taches paralleles si le waitTime SCE
 * est < 1 minute, sinon sequentiellement (1 tache a la fois).
 * Retourne les appids dont le scan a reussi (a jour en DB).
 * @param {Array} appids - Tableau d'appids a traiter
 * @param {string} profileLink
 * @param {Object} options - { market: false } pour differer fetchMarketPricesV2
 *   (utile pour lancer les prix marche en phase 2, apres que TOUS les badges
 *   soient a jour en DB via fetchSCEInventory) ; { forceSteam: true } pour
 *   bypasser le cache TTL de fetchSteamData (rescans apres trade, commandes
 *   manuelles) - par defaut false (scan complet daemon, TTL 30 min) ;
 *   { refetchCrafted: true } pour re-fetcher le statut badge_crafted = 1
 *   (daemon npm run sync)
 */
export async function processQueue(appids, profileLink = null, options = {}) {
    const { market = true, forceSteam = false, refetchCrafted = false } = options;
    const pl = profileLink || getSteamProfilePath();
    const dbReadyAppids = [];
    const deferredAppids = [];

    // Recupere le waitTime SCE AVANT la boucle. resetCreditFlag() force le
    // re-fetch du profile SCE (sinon, en daemon, le waitTime/pendingOffers du
    // cycle precedent serait reutilise via le flag creditFetched et les
    // badges differes ne seraient jamais re-evalues).
    // Ensuite fetchSCEGlobalInfo est mis en cache via ce meme flag: aucune
    // requete supplementaire lors du premier fetchSCEFresh, qui l'appelle aussi
    resetCreditFlag();
    await fetchSCEGlobalInfo();
    const waitTime = getSCEWaitTime();
    const parallel = (waitTime < SCE_PARALLEL_WAITTIME_MAX) ? SCE_PARALLEL_TASKS : 1;
    console.log(`[processQueue] waitTime SCE: ${waitTime} min -> ${parallel} tache(s) parallele(s) pour fetchSCEInventory sur ${appids.length} badges.`);

    let index = 0;
    async function worker() {
    while (true) {
        const i = index++;
        if (i >= appids.length) return;
        const appid = appids[i];
        try {
            if (isSteamEvent(appid)) continue;

            ES_log(`Traitement de ${appid}...`);

            // 1. Scrap Steam (cartes + inventaire) - le cache TTL 30 min
            // s'applique sauf forceSteam (rescans apres trade / commandes manuelles)
            await fetchSteamData(appid, pl, { force: forceSteam, refetchCrafted });

            // 2. Scrap SCE (stock + worth + price + quick-trade)
            await fetchSCEFresh(appid);

            // File SCE saturee (waitTime > 1 min et pendingOffers > 10):
            // l'appid est differe, il sera retente au prochain sync (5 min).
            // Pas d'analyse ni de prix marche pour lui ce cycle.
            if (isSCEBusy()) {
                deferredAppids.push(appid);
                continue;
            }

            // 3. Analyse
            analyzeBadgeStatus(appid);

            // Badge a jour en DB: eligible a la phase 2 (prix marche)
            dbReadyAppids.push(appid);

            // Petit delai entre chaque appid pour eviter le rate-limit
            await sleep(500);

        } catch (e) {
            console.error(`Erreur sur ${appid}:`, e);
        }
    }
    }

    await Promise.all(Array.from({ length: parallel }, () => worker()));

    // Appids differes (file SCE saturee): conserves en meta pour etre retentes
    // au prochain sync (cycle de surveillance toutes les 5 min). Ceux qui ont
    // reussi ce cycle (dbReadyAppids) sont retires de la liste.
    const prevDeferred = getDeferredSCEAppids().filter(a => !dbReadyAppids.includes(a));
    saveDeferredSCEAppids([...new Set([...prevDeferred, ...deferredAppids])]);
    if (deferredAppids.length > 0) {
        console.log(`[processQueue] ${deferredAppids.length} badge(s) differe(s): file SCE saturee (waitTime > 1 min, pendingOffers > 10). Nouvel essai au prochain sync.`);
    }

    // Prix marche Steam: phase sequentielle, uniquement APRES que tous les
    // badges soient a jour en DB via fetchSCEInventory. Les appids differes
    // (file SCE saturee) ou dont le scan a echoue sont exclus (dbReadyAppids).
    if (market) {
        await runMarketPhase(dbReadyAppids);
    }

    ES_log('[processQueue] Scan termine.');
    return dbReadyAppids;
}

/**
 * Retourne le waitTime SCE (variable waitTime dans sce.js, stockee en meta
 * 'sceWaitTime' par fetchSCEGlobalInfo, en minutes).
 * @returns {number}
 */
export function getSCEWaitTime() {
    return parseFloat(getMeta('sceWaitTime', '0')) || 0;
}

/** Cle meta pour la liste des appids differes (file SCE saturee). */
const DEFERRED_SCE_META_KEY = 'sceDeferredAppids';

/**
 * Retourne les appids differes car la file SCE etait saturee
 * (waitTime > 1 min et pendingOffers > 10). Ils sont retentes par le
 * daemon a chaque cycle de surveillance (toutes les 10 minutes).
 * @returns {Array<string>}
 */
export function getDeferredSCEAppids() {
    try {
        const v = JSON.parse(getMeta(DEFERRED_SCE_META_KEY, '[]'));
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

function saveDeferredSCEAppids(appids) {
    setMeta(DEFERRED_SCE_META_KEY, JSON.stringify([...new Set(appids)]));
}

/**
 * PHASE 2 du scan des badges: prix marche Steam (fetchMarketPricesV2) + analyse.
 *
 * Ne doit etre executee qu'une fois que TOUS les badges sont a jour en DB,
 * c'est-a-dire apres l'execution de fetchSCEInventory (via fetchSCEFresh) qui
 * peuple la DB (cartes possedees, manquantes, doublons, sce_stock,
 * sce_quick_trade, sce_worth, sce_price...).
 *
 * Parallelisme: aucun — fetchMarketPricesV2 s'execute sequentiellement
 * (c'est fetchSCEInventory, en phase 1, qui peut tourner en 4 taches
 * paralleles si le waitTime SCE est < 1 minute).
 *
 * @param {Array} appids - Tableau d'appids a traiter
 */
export async function runMarketPhase(appids) {
    console.log(`[runMarketPhase] ${appids.length} badges a traiter (sequentiel).`);

    for (const appid of appids) {
        try {
            await fetchMarketPricesV2(appid, 500);
            analyzeBadgeStatus(appid);
        } catch (e) {
            console.error(`[runMarketPhase] Erreur sur ${appid}:`, e);
        }
    }

    console.log('[runMarketPhase] Phase prix marche terminee.');
}

/**
 * Workflow complet du scan des badges (npm run sync:badges):
 *   1. Scan de TOUTES les pages de badges (p=1..N)
 *   2. Phase 1: fetchSteamData + fetchSCEFresh (fetchSCEInventory) pour chaque badge,
 *      en 4 taches paralleles si le waitTime SCE est < 1 minute
 *      -> peuple la DB (cartes possedees/manquantes/doublons, sce_stock,
 *         sce_quick_trade, sce_worth, sce_price...)
 *   3. Phase 2: fetchMarketPricesV2 pour TOUS les badges (sequentiel), uniquement
 *      une fois que tous les badges sont a jour en DB, puis analyse de chaque badge
 * @param {string} profileLink
 * @param {Object} options - { forceSteam: true } pour bypasser le cache TTL
 *   Steam (commande manuelle npm run sync:badges) ; { refetchCrafted: true }
 *   pour re-fetcher le statut badge_crafted = 1 (daemon npm run sync)
 */
export async function syncBadgesWorkflow(profileLink = null, options = {}) {
    const pl = profileLink || getSteamProfilePath();
    const { forceSteam = false, refetchCrafted = false } = options;
    const forceLabel = forceSteam ? ' (force, cache TTL bypass)' : ' (cache TTL actif)';
    console.log(`\n=== Workflow scan des badges (toutes les pages)${forceLabel} ===\n`);
    console.log(`BD actuelle: ${countGames()} jeux.`);

    // 1. Scan de toutes les pages de badges (p=1..N) - force bypass le
    // cache 1h de la liste d appids (commandes manuelles)
    const pageAppids = await getAllPagesAppids(pl, { force: forceSteam });
    const appids = pageAppids.filter(i => !isSteamEvent(i.appid)).map(i => i.appid);
    console.log(`${appids.length} badges a scanner (hors evenements Steam).`);

    // 2. Phase 1: Steam (cartes + inventaire) + SCE via fetchSCEInventory
    //    (4 taches paralleles si waitTime SCE < 1 min) - fetchMarketPricesV2
    //    est differe (options.market = false) -> seuls les badges dont
    //    fetchSteamData + fetchSCEFresh ont reussi (donc a jour en DB)
    //    passent en phase 2. forceSteam passe le cache TTL Steam au travers.
    console.log('\n--- Phase 1: Steam + SCE (fetchSCEInventory) ---');
    const dbReadyAppids = await processQueue(appids, pl, { market: false, forceSteam, refetchCrafted });

    const failed = appids.filter(a => !dbReadyAppids.includes(a));
    if (failed.length > 0) {
        console.warn(`[syncBadgesWorkflow] ATTENTION: ${failed.length} badge(s) non a jour en DB (echec ou file SCE saturee): ${failed.join(', ')}`);
        console.warn('[syncBadgesWorkflow] La phase prix marche ne sera executee que sur les badges a jour.');
        console.warn('[syncBadgesWorkflow] Les badges deferres (file SCE saturee) seront retentes au prochain sync (10 min).');
    }

    // 3. Phase 2: prix marche Steam, uniquement pour les badges a jour en DB
    console.log(`\n--- Phase 2: prix marche Steam (fetchMarketPricesV2) ---`);
    await runMarketPhase(dbReadyAppids);

    console.log(`\nTermine. BD: ${countGames()} jeux.`);
}

/**
 * Workflow principal - mode daemon
 *
 * - Si la BD est vide : lance le scan complet (processQueue) pour remplir
 *   toutes les donnees (badges, cartes, SCE)
 * - Sinon, boucle de surveillance :
 *   - toutes les 5 min (POLL_INTERVAL_MS) : scan tradehistory
 *     (syncSteamInventoryHistory) + re-scan cible des jeux touches
 *   - toutes les 15 min (FULL_BADGE_SCAN_INTERVAL_MS) : scan complet
 *     des badges (toutes les pages, phases 1 + 2, comme sync:badges)
 *   - phase 2 (fetchMarketPricesV2) : prix marché re-fetchés uniquement
 *     si le dernier fetch de la carte date de plus de 24h
 *
 * @param {string} profileLink
 */
export async function mainWorkflow(profileLink = null) {
    console.log('\n=== Demarrage du workflow ===\n');

    // --- 0. AUTHENTIFICATION STEAM ---
    // Si un cookie est deja defini dans .env (STEAM_COOKIE), on l'utilise directement
    // Sinon, on s'authentifie via steam-session (mot de passe ou QR code)
    if (!getSteamCookie()) {
        console.log('Authentification Steam requise...');
        const authMethod = process.env.STEAM_AUTH_METHOD || 'auto';
        const cookies = await getSteamCookies(authMethod);
        setSteamCookie(cookies);
        console.log('Authentification reussie.\n');
    } else {
        console.log('Cookie Steam trouve dans .env, utilisation directe.\n');
    }

    // IMPORTANT: on recupere le profile path APRES l'auth, car setSteamProfilePath()
    // est appele pendant l'authentification (loginWithCredentials / getCookiesWithToken)
    const pl = profileLink || getSteamProfilePath();
    console.log(`[Workflow] Profile path: ${pl}`);

    // Test: verifier que les cookies sont valides pour un endpoint authentifie
    // La page /badges est publique, donc on teste avec /inventoryhistory qui necessite une connexion
    try {
        const testUrl = `https://steamcommunity.com/${pl}/inventoryhistory/?ajax=1`;
        const testText = await httpGet(testUrl, {
            cookies: getSteamCookie(),
            accept: 'application/json',
            extraHeaders: { 'Referer': `https://steamcommunity.com/${pl}/inventoryhistory/`, 'X-Requested-With': 'XMLHttpRequest' },
            retries: 1,
        });
        if (testText.trim().startsWith('<!DOCTYPE') || testText.trim().startsWith('<html')) {
            const titleMatch = testText.match(/<title>(.*?)<\/title>/i);
            console.error('[Workflow] ATTENTION: Les cookies Steam ne sont pas valides pour inventoryhistory!');
            console.error(`[Workflow] Page recue: ${titleMatch ? titleMatch[1] : '(inconnu)'}`);
            console.error('[Workflow] Solutions possibles:');
            console.error('[Workflow]   1. Supprimez data/steam_refresh_token.txt et relancez');
            console.error('[Workflow]   2. Verifiez que steam-session est a jour: npm install');
            console.error('[Workflow]   3. Verifiez la version: npm ls steam-session');
        } else {
            console.log('[Workflow] Cookies verifies: OK (inventoryhistory accessible)');
        }
    } catch (e) {
        console.error(`[Workflow] Erreur lors du test des cookies: ${e.message}`);
    }

    // --- Démarrage du worker de marché temps réel ---
    // Token bucket adaptatif : ~100 req/min au lieu du délai fixe de 3s
    // Les cartes prioritaires sont traitées en 1-2s, le reste en fond
    console.log('[Workflow] Démarrage du worker de marché temps réel...');
    const marketWorker = startMarketWorker();
    console.log('[Workflow] Worker de marché démarré.\n');

    // --- Démarrage du serveur API (REST) ---
    // Expose les donnees de la DB en lecture seule (format win.ES.DATA)
    // pour le script Tampermonkey. Bind 127.0.0.1 par defaut.
    // Idempotent: ne crash pas si le serveur tourne deja.
    console.log('[Workflow] Démarrage du serveur API...');
    startApiServer();
    console.log('[Workflow] Serveur API démarré.\n');

    // Horloge du scan complet : 0 = scan complet des au premier cycle
    // (DB deja remplie au demarrage) ; mis a Date.now() apres le scan
    // initial (DB vide) pour ne pas le relancer tout de suite
    let lastFullBadgeScanAt = 0;

    // --- CAS 1: BD VIDE -> SCAN COMPLET ---
    if (isDBEmpty()) {
        console.log('Base de donnees vide. Lancement du scan complet...');

        // 1. Synchroniser l historique des trades en premier
        console.log('1. Synchronisation de l historique des trades...');
        await syncSteamInventoryHistory(pl);

        // 2. Recuperer les appids depuis TOUTES les pages de badges (p=1..N)
        console.log('2. Recuperation des appids depuis toutes les pages de badges...');
        const pageAppids = await getAllPagesAppids(pl);
        console.log(`   ${pageAppids.length} badges trouves.`);

        // 3. Lancer le scan complet via processQueue
        const appidsToScan = pageAppids
            .filter(item => !isSteamEvent(item.appid))
            .map(item => item.appid);

        console.log(`3. Scan complet de ${appidsToScan.length} badges...`);
        await processQueue(appidsToScan, pl, { refetchCrafted: true });
        console.log('4. Scan complet termine.');

        // 5. Analyser tous les badges
        console.log('5. Analyse des badges...');
        pageAppids.forEach(item => {
            if (!isSteamEvent(item.appid)) {
                analyzeBadgeStatus(item.appid);
            }
        });

        console.log(`\nBase remplie avec ${countGames()} jeux. Passage en mode surveillance.`);
        // Le scan complet vient d etre execute : le prochain part dans 15 min
        lastFullBadgeScanAt = Date.now();
    } else {
        console.log(`Base deja remplie (${countGames()} jeux). Passage en mode surveillance.`);
    }

    // --- CAS 2: BOUCLE DE SURVEILLANCE ---
    // - toutes les 5 min (POLL_INTERVAL_MS) : scan tradehistory + re-scan ciblé
    // - toutes les 15 min (FULL_BADGE_SCAN_INTERVAL_MS) : scan complet des badges
    //   (toutes les pages, phases 1 + 2, comme syncBadgesWorkflow)
    console.log(`\n=== Mode surveillance (tradehistory toutes les ${POLL_INTERVAL_MS / 60000} min, scan complet toutes les ${FULL_BADGE_SCAN_INTERVAL_MS / 60000} min) ===\n`);

    let cycle = 0;
    while (true) {
        cycle++;
        const now = new Date().toLocaleTimeString();
        console.log(`\n--- Cycle ${cycle} [${now}] ---`);

        try {
            const updatedAppIds = await syncSteamInventoryHistory(pl);

            // Badges differes au cycle precedent (file SCE saturee:
            // waitTime > 1 min et pendingOffers > 10): nouvel essai
            const deferredAppIds = getDeferredSCEAppids();
            if (deferredAppIds.length > 0) {
                console.log(`[Workflow] ${deferredAppIds.length} badge(s) differe(s) au cycle precedent (file SCE saturee). Nouvel essai...`);
            }

            // Scan complet des badges toutes les 15 minutes : il couvre
            // (via processQueue sur TOUS les appids) le re-scan des jeux
            // touches par des trades, on skip donc le re-scan cible sur
            // ces cycles-la.
            const fullScanDue = Date.now() - lastFullBadgeScanAt >= FULL_BADGE_SCAN_INTERVAL_MS;
            if (fullScanDue) {
                console.log(`[Workflow] Scan complet des badges (toutes les ${FULL_BADGE_SCAN_INTERVAL_MS / 60000} min)...`);
                await syncBadgesWorkflow(pl, { refetchCrafted: true });
                lastFullBadgeScanAt = Date.now();
                console.log(`[Workflow] Scan complet termine.`);
            } else {
                // Si des trades nouveaux ont ete detectes (ou des badges differes),
                // re-scan des jeux concernes (délai réduit à 500ms)
                const appIdsToRescan = [...new Set([...(updatedAppIds || []), ...deferredAppIds])];
                if (appIdsToRescan.length > 0) {
                    console.log(`[Workflow] ${appIdsToRescan.length} jeu(x) a re-scanner. Re-scan force...`);
                    // forceSteam: un trade vient d etre detecte, on bypass le
                    // cache TTL de fetchSteamData pour ces appids
                    await processQueue(appIdsToRescan, pl, { forceSteam: true });
                    console.log(`[Workflow] Re-scan termine pour ${appIdsToRescan.length} jeu(x).`);
                }
            }
            
            // Enfiler les cartes stale pour le worker de fond (stale-while-revalidate)
            enqueueStaleCards();
            
            // Stats du worker
            const stats = getQueueStats();
            if (stats.total > 0) {
                console.log(`[Worker] Queue: ${stats.pending} en attente, ${stats.done} traitées, ${stats.error} erreurs`);
            }
            
            console.log(`Cycle ${cycle} termine.`);
        } catch (e) {
            console.error(`Erreur lors du cycle ${cycle}:`, e.message);
        }

        console.log(`Prochaine synchronisation dans ${POLL_INTERVAL_MS / 1000 / 60} minutes...`);
        await sleep(POLL_INTERVAL_MS);
    }
}

/**
 * Workflow pour un appid specifique (page gamecards)
 */
export async function mainWorkflowGamecards(appid, profileLink = null) {
    const pl = profileLink || getSteamProfilePath();
    console.log(`\n=== Workflow Gamecards: ${appid} ===\n`);

    if (isSteamEvent(appid)) {
        console.log('Evenement Steam ignore.');
        return;
    }

    // Force le refresh (commande manuelle : bypass du cache TTL)
    await processQueue([appid], pl, { forceSteam: true });

    console.log('\n=== Workflow termine ===\n');
}

/**
 * Purge complete du cache (DB + caches memoire anti rate-limit)
 */
export async function purgeAllCache() {
    purgeCache();
    resetCreditFlag();
    invalidateBadgePagesCache();
    invalidateInventoryCache();
    console.log('Cache purge avec succes.');
}
