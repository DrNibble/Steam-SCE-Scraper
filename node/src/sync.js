import { sleep, isSteamEvent, ES_log, getSteamProfilePath, setSteamCookie, getSteamCookie, httpGet } from './utils.js';
import { getPageAppids, getAllPagesAppids, fetchSteamData, syncSteamInventoryHistory, syncSteamMarketHistory, invalidateBadgePagesCache, invalidateInventoryCache } from './steam.js';
import { fetchSCEFresh, fetchSCEGlobalInfo, isSCEBusy, resetCreditFlag } from './sce.js';
import { analyzeBadgeStatus } from './analyze.js';
import { getAllBadgeAppids, getIncompleteBadgeAppids, getGame, purgeCache, getMeta, setMeta, isDBEmpty, countGames, getAllGames } from './db.js';
import { getSteamCookies } from './auth.js';
import { fetchMarketPricesV2, fetchSingleCardPrice } from './market.js';
import { startMarketWorker, enqueueGameCards, enqueueStaleCards, getQueueStats, PRIORITY } from './marketQueue.js';
import { startApiServer } from './api.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000; // 1 jour
// Intervalle du mode surveillance : scan de l historique des trades (tradehistory)
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Intervalle du scan complet des badges (toutes les pages, phases 1 + 2)
// lance par le daemon `npm run sync` en mode surveillance
const FULL_BADGE_SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// Scan SCE: fetchSCEInventory s'execute en 4 taches paralleles si le waitTime
// SCE (minutes) est < 1, sinon de facon sequentielle
const SCE_PARALLEL_TASKS = 4;
const SCE_PARALLEL_WAITTIME_MAX = 1;

// Intervalles des 4 taches paralleles (mode surveillance post-sync initial)
const SCE_CREDIT_REFRESH_MS = 2 * 60 * 1000;       // Task 1: credit/waittime SCE
const MARKET_REFRESH_INTERVAL_MS = 60 * 60 * 1000;  // Task 2: prix marche (1h)
const TRADE_HISTORY_POLL_MS = 5 * 60 * 1000;        // Task 3: trade history (5 min)
const SCE_SCAN_INTERVAL_MS = 15 * 60 * 1000;        // Task 4: scan SCE complet (15 min)

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
 * Lance 4 taches paralleles apres le sync initial (DB remplie et stabilisee).
 *
 * Les 4 taches tournent en parallele via Promise.all (boucles infinies):
 *   1) Refresh SCE credit/waittime (fetchSCEGlobalInfo) toutes les 2 min
 *   2) fetchMarketPricesV2 sur appids avec totalOwnedQty > 0, toutes les heures
 *   3) syncSteamInventoryHistory + syncSteamMarketHistory + fetchSteamData
 *      sur appids affectes si trades detectes, toutes les 5 min
 *   4) fetchSCEFresh sur appids en DB, toutes les 15 min ou immediatement
 *      si la tache 3 a detecte des entrees (nouveaux trades)
 *
 * Communication tache 3 -> tache 4: variable partagee tradeUpdatedAppIds.
 * La tache 3 y ajoute les appids affectes par des trades; la tache 4 les
 * consomme et lance fetchSCEFresh immediatement dessus.
 *
 * @param {string} profileLink - Profile path Steam
 */
async function startParallelTasks(profileLink) {
    const pl = profileLink || getSteamProfilePath();

    // Variable partagee: appids affectes par des trades (tache 3 -> tache 4)
    let tradeUpdatedAppIds = [];

    // --- Task 1: Refresh SCE credit/waittime, toutes les 2 min ---
    // Recupere le credit, pending offers et wait time SCE. resetCreditFlag()
    // force le re-fetch (sinon le flag creditFetched reste true et les valeurs
    // du cycle precedent sont reutilisees). La restriction waittime existante
    // (isSCEBusy dans fetchSCEFresh) est respectee par les autres taches.
    async function task1_SCERefresh() {
        while (true) {
            try {
                resetCreditFlag();
                await fetchSCEGlobalInfo();
                const waitTime = getSCEWaitTime();
                ES_log(`[Task1-SCE] Credit/waittime refresh: waitTime=${waitTime} min.`);
            } catch (e) {
                console.error('[Task1-SCE] Erreur:', e.message);
            }
            await sleep(SCE_CREDIT_REFRESH_MS);
        }
    }

    // --- Task 2: fetchMarketPricesV2 sur appids avec totalOwnedQty > 0, toutes les heures ---
    // Respecte le rate-limit en place (delai 500ms entre cartes, garde-fou 24h
    // via isMarketPriceFresh dans fetchMarketPricesV2). Enfile aussi les cartes
    // stale pour le worker de fond (stale-while-revalidate).
    async function task2_MarketRefresh() {
        while (true) {
            try {
                const games = getAllGames();
                const appids = games
                    .filter(g => g.total_owned_qty > 0 && !g.disabled)
                    .map(g => g.appid);
                ES_log(`[Task2-Market] Refresh prix marche pour ${appids.length} jeu(x) (totalOwnedQty > 0).`);
                for (const appid of appids) {
                    try {
                        await fetchMarketPricesV2(appid, 500);
                        analyzeBadgeStatus(appid);
                    } catch (e) {
                        console.error(`[Task2-Market] Erreur sur ${appid}:`, e.message);
                    }
                }
                // Enfiler les cartes stale pour le worker de fond
                enqueueStaleCards();
                // Stats du worker
                const stats = getQueueStats();
                if (stats.total > 0) {
                    console.log(`[Worker] Queue: ${stats.pending} en attente, ${stats.done} traitees, ${stats.error} erreurs`);
                }
            } catch (e) {
                console.error('[Task2-Market] Erreur:', e.message);
            }
            await sleep(MARKET_REFRESH_INTERVAL_MS);
        }
    }

    // --- Task 3: Trade history sync + fetchSteamData si trades, toutes les 5 min ---
    // syncSteamInventoryHistory -> syncSteamMarketHistory -> si des trades sont
    // detectes (entrees retournees), fetchSteamData sur les appids affectes
    // (force: bypass du cache TTL Steam car un trade vient d etre detecte).
    // Signale a la tache 4 de lancer fetchSCEFresh immediatement sur ces appids.
    async function task3_TradeHistory() {
        while (true) {
            try {
                const tradeUpdated = await syncSteamInventoryHistory(pl);
                const marketUpdated = await syncSteamMarketHistory(pl);
                const updatedAppIds = [...new Set([...(tradeUpdated || []), ...(marketUpdated || [])])];

                if (updatedAppIds.length > 0) {
                    ES_log(`[Task3-Trade] ${updatedAppIds.length} jeu(x) affecte(s) par des trades. Re-scan Steam...`);
                    for (const appid of updatedAppIds) {
                        if (!isSteamEvent(appid)) {
                            try {
                                // force: bypass du cache TTL Steam (trade detecte)
                                await fetchSteamData(appid, pl, { force: true });
                            } catch (e) {
                                console.error(`[Task3-Trade] Erreur fetchSteamData sur ${appid}:`, e.message);
                            }
                        }
                    }
                    // Signaler a la tache 4 de lancer fetchSCEFresh immediatement
                    tradeUpdatedAppIds = [...new Set([...tradeUpdatedAppIds, ...updatedAppIds])];
                }
            } catch (e) {
                console.error('[Task3-Trade] Erreur:', e.message);
            }
            await sleep(TRADE_HISTORY_POLL_MS);
        }
    }

    // --- Task 4: fetchSCEFresh sur appids en DB, toutes les 15 min ou immediatement si tache 3 a des entrees ---
    // Si tradeUpdatedAppIds n est pas vide (tache 3 a detecte des trades),
    // lance fetchSCEFresh immediatement sur ces appids. Sinon, attend le
    // scan complet (toutes les 15 min) sur TOUS les appids en DB.
    // fetchSCEFresh respecte la restriction waittime existante (isSCEBusy).
    // Parallelisation: 4 taches si waitTime < 1 min, sinon sequentiel.
    async function task4_SCEScan() {
        let lastFullScanAt = Date.now(); // Evite un scan immediat apres le sync initial

        while (true) {
            const now = Date.now();
            const hasTradeEntries = tradeUpdatedAppIds.length > 0;
            const fullScanDue = now - lastFullScanAt >= SCE_SCAN_INTERVAL_MS;

            if (hasTradeEntries || fullScanDue) {
                try {
                    let appidsToScan;
                    if (hasTradeEntries) {
                        // Scan immediat sur les appids affectes par des trades
                        appidsToScan = [...tradeUpdatedAppIds];
                        tradeUpdatedAppIds = [];
                        ES_log(`[Task4-SCE] Scan immediat pour ${appidsToScan.length} appid(s) (trades detectes par tache 3).`);
                    } else {
                        // Scan complet: tous les appids en DB non desactives
                        const games = getAllGames();
                        appidsToScan = games.filter(g => !g.disabled).map(g => g.appid);
                        ES_log(`[Task4-SCE] Scan complet SCE pour ${appidsToScan.length} appids.`);
                        lastFullScanAt = now;
                    }

                    // Recupere le waitTime SCE pour la parallelisation
                    const waitTime = getSCEWaitTime();
                    const parallel = (waitTime < SCE_PARALLEL_WAITTIME_MAX) ? SCE_PARALLEL_TASKS : 1;
                    ES_log(`[Task4-SCE] waitTime SCE: ${waitTime} min -> ${parallel} tache(s) parallele(s).`);

                    let index = 0;
                    async function worker() {
                        while (true) {
                            const i = index++;
                            if (i >= appidsToScan.length) return;
                            const appid = appidsToScan[i];
                            try {
                                if (isSteamEvent(appid)) continue;
                                await fetchSCEFresh(appid);
                                analyzeBadgeStatus(appid);
                                await sleep(500); // Anti rate-limit entre appids
                            } catch (e) {
                                console.error(`[Task4-SCE] Erreur sur ${appid}:`, e.message);
                            }
                        }
                    }
                    await Promise.all(Array.from({ length: parallel }, () => worker()));
                } catch (e) {
                    console.error('[Task4-SCE] Erreur:', e.message);
                }
            }

            // Si on vient de traiter des trades, petit delai avant de rechecker;
            // sinon attendre 1 min avant de rechecker si le scan complet est du
            if (hasTradeEntries) {
                await sleep(1000);
            } else {
                await sleep(60 * 1000);
            }
        }
    }

    // Lancer les 4 taches en parallele
    console.log('\n=== Demarrage des 4 taches paralleles ===');
    console.log('  Task 1: Refresh SCE credit/waittime (toutes les 2 min)');
    console.log('  Task 2: fetchMarketPricesV2 sur appids avec totalOwnedQty > 0 (toutes les heures)');
    console.log('  Task 3: Trade history sync + fetchSteamData si trades (toutes les 5 min)');
    console.log('  Task 4: fetchSCEFresh sur appids en DB (toutes les 15 min ou immediatement si trades)');
    console.log('');

    await Promise.all([
        task1_SCERefresh(),
        task2_MarketRefresh(),
        task3_TradeHistory(),
        task4_SCEScan(),
    ]);
}

/**
 * Workflow principal - mode daemon
 *
 * - Si la BD est vide : lance le scan complet (processQueue) pour remplir
 *   toutes les donnees (badges, cartes, SCE)
 * - Sinon, lance les 4 taches paralleles (startParallelTasks):
 *   1) Refresh SCE credit/waittime (toutes les 2 min)
 *   2) fetchMarketPricesV2 sur appids avec totalOwnedQty > 0 (toutes les heures)
 *   3) syncSteamInventoryHistory + syncSteamMarketHistory + fetchSteamData
 *      si trades detectes (toutes les 5 min)
 *   4) fetchSCEFresh sur appids en DB (toutes les 15 min ou immediatement
 *      si la tache 3 a des entrees)
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

        // 1. Synchroniser l historique des trades et du marche en premier
        console.log('1. Synchronisation de l historique des trades et du marche...');
        await syncSteamInventoryHistory(pl);
        await syncSteamMarketHistory(pl);

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

    // --- CAS 2: 4 TACHES PARALLELES ---
    // Apres le sync initial (DB remplie et stabilisee), 4 taches independantes
    // tournent en parallele via startParallelTasks:
    //   1) Refresh SCE credit/waittime (toutes les 2 min)
    //   2) fetchMarketPricesV2 sur appids avec totalOwnedQty > 0 (toutes les heures)
    //   3) syncSteamInventoryHistory + syncSteamMarketHistory + fetchSteamData
    //      si trades detectes (toutes les 5 min)
    //   4) fetchSCEFresh sur appids en DB (toutes les 15 min ou immediatement
    //      si la tache 3 a des entrees)
    await startParallelTasks(pl);
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
