import { sleep, isSteamEvent, ES_log, getSteamProfilePath, setSteamCookie, getSteamCookie, httpGet } from './utils.js';
import { getPageAppids, fetchSteamData, syncSteamInventoryHistory, fetchSteamMarketPrices } from './steam.js';
import { fetchSCEFresh, resetCreditFlag } from './sce.js';
import { analyzeBadgeStatus } from './analyze.js';
import { getAllBadgeAppids, getIncompleteBadgeAppids, getGame, purgeCache, getMeta, setMeta, isDBEmpty, countGames } from './db.js';
import { getSteamCookies } from './auth.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Traite une liste d'appids sequentiellement (1 a la fois).
 * @param {Array} appids - Tableau d'appids a traiter
 * @param {string} profileLink
 */
export async function processQueue(appids, profileLink = null) {
    const pl = profileLink || getSteamProfilePath();

    for (const appid of appids) {
        try {
            if (isSteamEvent(appid)) continue;

            ES_log(`Traitement de ${appid}...`);

            // 1. Scrap Steam (cartes + inventaire)
            await fetchSteamData(appid, pl);

            // 2. Scrap SCE (stock + worth + price + quick-trade)
            await fetchSCEFresh(appid);

            // 3. Prix marche Steam Community (priceoverview -> EUR + ventes 7j)
            await fetchSteamMarketPrices(appid);

            // 4. Analyse
            analyzeBadgeStatus(appid);

            // Petit delai entre chaque appid pour eviter le rate-limit
            await sleep(500);

        } catch (e) {
            console.error(`Erreur sur ${appid}:`, e);
        }
    }

    ES_log('[processQueue] Scan termine.');
}

/**
 * Workflow principal - mode daemon
 *
 * - Si la BD est vide : lance le scan complet (processQueue) pour remplir
 *   toutes les donnees (badges, cartes, SCE)
 * - Sinon : lance uniquement syncSteamInventoryHistory en boucle
 *   toutes les 10 minutes
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

    // --- CAS 1: BD VIDE -> SCAN COMPLET ---
    if (isDBEmpty()) {
        console.log('Base de donnees vide. Lancement du scan complet...');

        // 1. Synchroniser l historique des trades en premier
        console.log('1. Synchronisation de l historique des trades...');
        await syncSteamInventoryHistory(pl);

        // 2. Recuperer les appids de la page badges
        console.log('2. Recuperation des appids depuis la page badges...');
        const pageAppids = await getPageAppids(pl);
        console.log(`   ${pageAppids.length} badges trouves.`);

        // 3. Lancer le scan complet via processQueue
        const appidsToScan = pageAppids
            .filter(item => !isSteamEvent(item.appid))
            .map(item => item.appid);

        console.log(`3. Scan complet de ${appidsToScan.length} badges...`);
        await processQueue(appidsToScan, pl);
        console.log('4. Scan complet termine.');

        // 5. Analyser tous les badges
        console.log('5. Analyse des badges...');
        pageAppids.forEach(item => {
            if (!isSteamEvent(item.appid)) {
                analyzeBadgeStatus(item.appid);
            }
        });

        console.log(`\nBase remplie avec ${countGames()} jeux. Passage en mode surveillance.`);
    } else {
        console.log(`Base deja remplie (${countGames()} jeux). Passage en mode surveillance.`);
    }

    // --- CAS 2: BOUCLE DE SURVEILLANCE (toutes les 10 minutes) ---
    console.log(`\n=== Mode surveillance (toutes les ${POLL_INTERVAL_MS / 1000 / 60} min) ===\n`);

    let cycle = 0;
    while (true) {
        cycle++;
        const now = new Date().toLocaleTimeString();
        console.log(`\n--- Cycle ${cycle} [${now}] ---`);

        try {
            const updatedAppIds = await syncSteamInventoryHistory(pl);
            
            // Si des trades nouveaux ont ete detectes, re-fetcher les cartes des jeux concernes
            if (updatedAppIds && updatedAppIds.length > 0) {
                console.log(`[Workflow] ${updatedAppIds.length} jeu(x) avec nouveau trade. Re-scan des cartes...`);
                await processQueue(updatedAppIds, pl);
                console.log(`[Workflow] Re-scan termine pour ${updatedAppIds.length} jeu(x).`);
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

    // Force le refresh
    await processQueue([appid], pl);

    console.log('\n=== Workflow termine ===\n');
}

/**
 * Purge complete du cache
 */
export async function purgeAllCache() {
    purgeCache();
    resetCreditFlag();
    console.log('Cache purge avec succes.');
}
