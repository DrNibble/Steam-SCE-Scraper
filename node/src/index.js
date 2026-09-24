import { mainWorkflow, mainWorkflowGamecards, purgeAllCache, processQueue } from './sync.js';
import { getAllBadgeAppids, getGame, isDBEmpty, countGames, getAllGames, getCards, getDB, getMeta } from './db.js';
import { STEAM_PROFILE_PATH, setSteamCookie, getSteamCookie, getSteamProfilePath } from './utils.js';
import { getSteamCookies } from './auth.js';
import { fetchMarketPricesV2, fetchSingleCardPrice } from './market.js';
import { startMarketWorker, enqueueGameCards, enqueueMarketRefresh, enqueueStaleCards, getQueueStats, getCardPriceCached, PRIORITY } from './marketQueue.js';
import { startApiServer } from './api.js';

const args = process.argv.slice(2);

async function main() {
    const command = args[0] || 'sync';

    switch (command) {
        case 'sync':
        case '--daemon':
        case 'daemon':
            // Mode daemon: scan complet si BD vide, puis boucle syncSteamInventoryHistory toutes les 10 min
            await mainWorkflow();
            break;

        case '--login':
        case 'login':
            // Authentification Steam standalone (sauvegarde le refresh token)
            {
                const method = args[1] || 'auto'; // auto, password, qr
                console.log('Authentification Steam...');
                const cookies = await getSteamCookies(method);
                setSteamCookie(cookies);
                console.log('\nAuthentification reussie. Le refresh token est sauvegarde.');
                console.log('Vous pouvez maintenant lancer: npm run sync');
            }
            break;

        case '--sync-once':
        case 'sync-once':
            // Synchronise une seule fois l'historique des trades (sans boucle)
            {
                // Authentification necessaire pour Steam
                if (!getSteamCookie()) {
                    const cookies = await getSteamCookies(process.env.STEAM_AUTH_METHOD || 'auto');
                    setSteamCookie(cookies);
                }
                const { syncSteamInventoryHistory, syncSteamMarketHistory } = await import('./steam.js');
                console.log('Synchronisation unique de l historique...');
                await syncSteamInventoryHistory(getSteamProfilePath());
                await syncSteamMarketHistory(getSteamProfilePath());
                console.log('Termine.');
            }
            break;

        case '--badges':
        case 'badges':
            // Force le scan complet de TOUTES les pages de badges (p=1..N):
            //   Phase 1: fetchSteamData + fetchSCEFresh / fetchSCEInventory
            //            (4 taches paralleles si waitTime SCE < 1 min)
            //   Phase 2: fetchMarketPricesV2 (sequentiel) une fois tous les
            //            badges a jour en DB
            {
                const { syncBadgesWorkflow } = await import('./sync.js');

                // Authentification necessaire pour Steam
                if (!getSteamCookie()) {
                    const cookies = await getSteamCookies(process.env.STEAM_AUTH_METHOD || 'auto');
                    setSteamCookie(cookies);
                }

                // Commande manuelle : bypass du cache TTL Steam
                await syncBadgesWorkflow(getSteamProfilePath(), { forceSteam: true });
                console.log('Termine.');
            }
            break;

        case '--gamecards':
        case 'gamecards': {
            const appid = args[1];
            if (!appid) {
                console.error('Usage: npm run sync:gamecards <appid>');
                process.exit(1);
            }
            // Authentification necessaire pour Steam
            if (!getSteamCookie()) {
                const cookies = await getSteamCookies(process.env.STEAM_AUTH_METHOD || 'auto');
                setSteamCookie(cookies);
            }
            await mainWorkflowGamecards(appid, getSteamProfilePath());
            break;
        }

        case '--history':
        case 'history':
            {
                const { syncSteamInventoryHistory, syncSteamMarketHistory } = await import('./steam.js');
                // Authentification necessaire pour Steam
                if (!getSteamCookie()) {
                    const cookies = await getSteamCookies(process.env.STEAM_AUTH_METHOD || 'auto');
                    setSteamCookie(cookies);
                }
                await syncSteamInventoryHistory(getSteamProfilePath());
                await syncSteamMarketHistory(getSteamProfilePath());
                console.log('Historique synchronise.');
            }
            break;

        case '--purge':
        case 'purge':
            await purgeAllCache();
            break;

        case '--scan-all':
        case 'scan-all': {
            // Authentification necessaire pour Steam
            if (!getSteamCookie()) {
                const cookies = await getSteamCookies(process.env.STEAM_AUTH_METHOD || 'auto');
                setSteamCookie(cookies);
            }
            const badges = getAllBadgeAppids();
            const appids = badges.filter(b => !b.disabled).map(b => b.appid);
            console.log(`Scan de ${appids.length} badges...`);
            // Commande manuelle : bypass du cache TTL Steam
            await processQueue(appids, getSteamProfilePath(), { forceSteam: true });
            break;
        }

        case '--refetch-cards':
        case 'refetch-cards': {
            // Re-fetch UNIQUEMENT les donnees Steam (cartes + inventaire) sans SCE
            const { fetchSteamData: refetchSteamData } = await import('./steam.js');
            const { isSteamEvent: isEvent, ES_log: ESLOG, sleep: SLEEP2 } = await import('./utils.js');

            // Authentification necessaire
            if (!getSteamCookie()) {
                const cookies = await getSteamCookies(process.env.STEAM_AUTH_METHOD || 'auto');
                setSteamCookie(cookies);
            }
            const pl = getSteamProfilePath();

            // Recupere tous les badges non-desactives
            const allBadges = getAllBadgeAppids();
            const appids = allBadges.filter(b => !b.disabled).map(b => b.appid);
            console.log(`Re-fetch des cartes Steam pour ${appids.length} badges...`);
            console.log(`(Contourne SCE - plus rapide qu'un scan complet)`);

            for (const appid of appids) {
                if (isEvent(appid)) continue;
                try {
                    ESLOG(`Re-fetch ${appid}...`);
                    // Commande manuelle : bypass du cache TTL Steam
                    await refetchSteamData(appid, pl, { force: true });
                    await SLEEP2(500);
                } catch (e) {
                    console.error(`Erreur sur ${appid}:`, e.message);
                }
            }

            console.log(`\nRe-fetch termine. Verifiez avec: npm run -- --db summary`);
            break;
        }

        case '--status':
        case 'status': {
            const games = getAllBadgeAppids();
            console.log(`\n=== Status (${games.length} badges en DB, ${countGames()} jeux) ===\n`);
            for (const g of games) {
                const game = getGame(g.appid);
                const status = game
                    ? `disabled=${game.disabled} cards=${game.set_cards || 0} fetched=${game.fetched_at ? new Date(game.fetched_at).toLocaleString() : 'never'}`
                    : 'non scanne';
                console.log(`  ${g.appid}: ${g.gamename} [${status}]`);
            }
            break;
        }

        case '--db':
        case 'db': {
            const sub = args[1] || 'summary';
            const rawDb = getDB();

            const tableCount = (table) => rawDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;

            switch (sub) {
                case 'summary': {
                    const gameCount = countGames();
                    const cardCount = tableCount('cards');
                    const badgeCount = tableCount('badge_appids');
                    const metaCount = tableCount('meta');

                    console.log('\n=== Resume de la base de donnees ===\n');
                    console.log(`  jeux        : ${gameCount}`);
                    console.log(`  cartes      : ${cardCount}`);
                    console.log(`  badges      : ${badgeCount}`);
                    console.log(`  meta        : ${metaCount}`);

                    // Stats SCE
                    const credit = getMeta('scecredit', '0');
                    const pending = getMeta('scePendingOffers', '0');
                    const waitTime = getMeta('sceWaitTime', '0');
                    console.log(`\n  SCE credit  : ${credit}`);
                    console.log(`  SCE pending : ${pending} offres`);
                    console.log(`  SCE wait     : ${waitTime} min`);

                    // Jeux completables
                    const completable = rawDb.prepare('SELECT COUNT(*) as c FROM games WHERE is_completable_via_sce = 1').get().c;
                    const completableWo = rawDb.prepare('SELECT COUNT(*) as c FROM games WHERE is_completable_via_sce_wobudget = 1').get().c;
                    const doublon = rawDb.prepare('SELECT COUNT(*) as c FROM games WHERE is_completable_via_sce_doublon = 1').get().c;
                    const disabled = rawDb.prepare('SELECT COUNT(*) as c FROM games WHERE disabled = 1').get().c;
                    console.log(`\n  Completables via SCE    : ${completable}`);
                    console.log(`  Completables (wobudget) : ${completableWo}`);
                    console.log(`  Completables (doublon)  : ${doublon}`);
                    console.log(`  Desactives             : ${disabled}`);
                    break;
                }

                case 'games': {
                    const games = getAllGames();
                    console.log(`\n=== ${games.length} jeux en base ===\n`);
                    console.log('appid      set  owned  missing  cost   complet  status     fetched');
                    console.log('---------- ---  -----  -------  -----  -------  ---------- -------');
                    for (const g of games) {
                        const complet = [g.is_completable_via_trade ? 'T' : '-',
                                          g.is_completable_via_sce ? 'S' : '-',
                                          g.is_completable_via_sce_wobudget ? 'W' : '-',
                                          g.is_completable_via_sce_doublon ? 'D' : '-'].join('');
                        const fetched = g.fetched_at ? new Date(g.fetched_at).toLocaleDateString('fr-FR') : 'never';
                        console.log(`${g.appid.padEnd(10)} ${String(g.set_cards || 0).padStart(3)}  ${String(g.total_owned_qty).padStart(5)}  ${String(g.missing_count).padStart(7)}  ${String(g.total_cost_sce).padStart(5)}  ${complet.padEnd(7)}  ${g.disabled ? 'DISABLED' : 'active'.padEnd(8)} ${fetched}`);
                    }
                    break;
                }

                case 'game': {
                    const appid = args[2];
                    if (!appid) {
                        console.error('Usage: npm run -- --db game <appid>');
                        process.exit(1);
                    }
                    const game = getGame(appid);
                    if (!game) {
                        console.error(`Aucun jeu trouve avec appid ${appid}`);
                        process.exit(1);
                    }
                    console.log(`\n=== ${game.gamename || appid} (appid: ${appid}) ===\n`);
                    for (const [key, val] of Object.entries(game)) {
                        let display = val;
                        if (key === 'fetched_at' && val) display = new Date(val).toLocaleString('fr-FR');
                        if (key === 'lasttrade' && val) display = new Date(val).toLocaleString('fr-FR');
                        if (key === 'has_expensive_card_json' && val) display = val.substring(0, 80) + (val.length > 80 ? '...' : '');
                        console.log(`  ${key.padEnd(35)} : ${display}`);
                    }

                    // Cartes du jeu
                    const cards = getCards(appid);
                    if (cards.length > 0) {
                        console.log(`\n  --- ${cards.length} cartes ---`);
                        console.log('  #   nom                          qty  sell€   x?  buy€    7j  median€  resolved€');
                        console.log('  --- ---------------------------- --- ------ --- ------ --- ------- ---------');
                        for (const c of cards) {
                            const sellStr = c.steam_market_sell_price_eur !== null ? c.steam_market_sell_price_eur.toFixed(2) + '€' : 'N/A';
                            const buyStr = c.steam_market_buy_order_eur !== null ? c.steam_market_buy_order_eur.toFixed(2) + '€' : 'N/A';
                            const medStr = c.steam_market_median_price_eur !== null ? c.steam_market_median_price_eur.toFixed(2) + '€' : 'N/A';
                            const resStr = c.steam_market_price_eur !== null ? c.steam_market_price_eur.toFixed(2) + '€' : 'N/A';
                            console.log(`  ${String(c.card_index ?? '?').padStart(3)} ${(c.name || '').substring(0, 28).padEnd(28)} ${String(c.qty).padStart(3)}  ${sellStr.padStart(6)} ${String(c.steam_market_sell_qty || 0).padStart(3)}  ${buyStr.padStart(6)} ${String(c.steam_market_sales_7d || 0).padStart(3)}  ${medStr.padStart(7)}  ${resStr.padStart(9)}`);
                        }
                    }
                    break;
                }

                case 'cards': {
                    const appid = args[2];
                    if (!appid) {
                        console.error('Usage: npm run -- --db cards <appid>');
                        process.exit(1);
                    }
                    const cards = getCards(appid);
                    if (cards.length === 0) {
                        console.log(`Aucune carte trouvee pour appid ${appid}`);
                        break;
                    }
                    console.log(`\n=== ${cards.length} cartes pour appid ${appid} ===\n`);
                    for (const c of cards) {
                        const priceStr = c.steam_market_price_eur !== null ? c.steam_market_price_eur.toFixed(2) + '€' : 'N/A';
                        const sellStr = c.steam_market_sell_price_eur !== null ? c.steam_market_sell_price_eur.toFixed(2) + '€' : 'N/A';
                        const buyStr = c.steam_market_buy_order_eur !== null ? c.steam_market_buy_order_eur.toFixed(2) + '€' : 'N/A';
                        console.log(`  [${c.card_index ?? '?'}] ${c.name || '(sans nom)'}`);
                        console.log(`      qty=${c.qty}  stock=${c.sce_stock}  worth=${c.sce_worth}  price=${c.sce_price}`);
                        console.log(`      market: sell=${sellStr} x${c.steam_market_sell_qty || 0}  buy=${buyStr}  7j=${c.steam_market_sales_7d || 0} ventes  resolved=${priceStr}`);
                        if (c.inv_json && c.inv_json !== '[]') {
                            const inv = JSON.parse(c.inv_json);
                            console.log(`      inventaire: ${inv.length} entrees`);
                        }
                        if (c.sce_quick_trade) console.log(`      quick-trade: ${c.sce_quick_trade.substring(0, 60)}...`);
                        console.log('');
                    }
                    break;
                }

                case 'badges': {
                    const badges = getAllBadgeAppids();
                    console.log(`\n=== ${badges.length} badges en base ===\n`);
                    console.log('appid      gamename                              disabled');
                    console.log('---------- ------------------------------------- --------');
                    for (const b of badges) {
                        console.log(`${b.appid.padEnd(10)} ${(b.gamename || '').substring(0, 37).padEnd(37)} ${b.disabled ? 'oui' : 'non'}`);
                    }
                    break;
                }

                case 'meta': {
                    const rows = rawDb.prepare('SELECT * FROM meta ORDER BY key').all();
                    console.log(`\n=== ${rows.length} entrees meta ===\n`);
                    for (const r of rows) {
                        console.log(`  ${r.key.padEnd(25)} : ${r.value}`);
                    }
                    break;
                }

                case 'query': {
                    // Execution d'une requete SQL brute (lecture seule)
                    const sql = args[2];
                    if (!sql) {
                        console.error('Usage: npm run -- --db query "SELECT ..."');
                        process.exit(1);
                    }
                    if (!sql.trim().toUpperCase().startsWith('SELECT')) {
                        console.error('Erreur: seules les requetes SELECT sont autorisees.');
                        process.exit(1);
                    }
                    const rows = rawDb.prepare(sql).all();
                    console.log(`\n=== ${rows.length} resultat(s) ===\n`);
                    if (rows.length === 0) { console.log('(vide)'); break; }
                    const cols = Object.keys(rows[0]);
                    console.log(cols.join('  |  '));
                    console.log(cols.map(() => '---').join('  |  '));
                    for (const r of rows) {
                        console.log(cols.map(c => String(r[c] ?? '')).join('  |  '));
                    }
                    break;
                }

                default:
                    console.error(`Sous-commande inconnue: ${sub}`);
                    console.error('Sous-commandes disponibles: summary, games, game <appid>, cards <appid>, badges, meta, query "SQL"');
                    process.exit(1);
            }
            break;
        }

        case '--market':
        case 'market': {
            // Worker de marché temps réel standalone
            //   npm run market              — démarre le worker
            //   npm run -- --market stats   — stats de la queue
            //   npm run -- --market price <hash>  — prix en cache d'une carte
            //   npm run -- --market refresh <hash>  — force le refresh d'une carte
            const sub = args[1] || 'start';
            switch (sub) {
                case 'start': {
                    console.log('[Market] Démarrage du worker de marché temps réel...');
                    const worker = startMarketWorker();
                    
                    // Enfiler toutes les cartes connues au démarrage (priorité basse)
                    const games = getAllBadgeAppids();
                    const activeGames = games.filter(g => !g.disabled);
                    console.log(`[Market] Enfilage de ${activeGames.length} jeux...`);
                    for (const g of activeGames) {
                        enqueueGameCards(g.appid, PRIORITY.BACKGROUND);
                    }
                    
                    // Stats toutes les 30s
                    setInterval(() => {
                        const stats = getQueueStats();
                        const wStats = worker.stats();
                        console.log(`[Market] Queue: ${stats.pending} pending, ${stats.done} done, ${stats.error} errors | Worker: ${wStats.processed} total, ${wStats.rateLimited} rate-limited`);
                    }, 30000);
                    
                    // Garder le process en vie
                    console.log('[Market] Worker en cours. Ctrl+C pour arrêter.');
                    break;
                }
                case 'stats': {
                    const stats = getQueueStats();
                    console.log('\n=== Stats de la queue de marché ===\n');
                    console.log(`  En attente  : ${stats.pending}`);
                    console.log(`  En cours    : ${stats.processing}`);
                    console.log(`  Traités     : ${stats.done}`);
                    console.log(`  Erreurs     : ${stats.error}`);
                    console.log(`  Total       : ${stats.total}`);
                    break;
                }
                case 'price': {
                    const hash = args[2];
                    if (!hash) {
                        console.error('Usage: npm run -- --market price <market_hash_name>');
                        console.error('Ex: npm run -- --market price 616580-Servie');
                        process.exit(1);
                    }
                    // Chercher l'appid depuis le hash
                    const db = getDB();
                    const card = db.prepare('SELECT appid, hash FROM cards WHERE hash = ?').get(hash);
                    if (!card) {
                        console.error(`Carte non trouvée: ${hash}`);
                        process.exit(1);
                    }
                    const result = getCardPriceCached(card.appid, hash);
                    console.log('\n' + '═'.repeat(60));
                    console.log(`  Carte: ${hash}`);
                    console.log('═'.repeat(60));
                    console.log(`  Prix     : ${result.priceEur !== null ? result.priceEur + '€' : 'N/A'}`);
                    console.log(`  Ventes 7j: ${result.sales7d}`);
                    console.log(`  Mis à jour: ${result.fetchedAt ? new Date(result.fetchedAt).toLocaleString('fr-FR') + ` (${result.ageSeconds}s)` : 'jamais'}`);
                    console.log(`  Stale    : ${result.stale ? 'oui (refresh en cours)' : 'non'}`);
                    console.log('═'.repeat(60));
                    break;
                }
                case 'refresh': {
                    const hash = args[2];
                    if (!hash) {
                        console.error('Usage: npm run -- --market refresh <market_hash_name>');
                        process.exit(1);
                    }
                    const db = getDB();
                    const card = db.prepare('SELECT appid, hash FROM cards WHERE hash = ?').get(hash);
                    if (!card) {
                        console.error(`Carte non trouvée: ${hash}`);
                        process.exit(1);
                    }
                    enqueueMarketRefresh(card.appid, hash, PRIORITY.VISIBLE);
                    console.log(`[Market] ${hash} enfilée en priorité max. Le worker la traitera sous peu.`);
                    break;
                }
                case 'enqueue': {
                    // Enfiler toutes les cartes stale
                    const count = enqueueStaleCards();
                    console.log(`[Market] ${count} cartes stale enfilées.`);
                    break;
                }
                default:
                    console.error(`Sous-commande inconnue: ${sub}`);
                    console.error('Sous-commandes: start, stats, price <hash>, refresh <hash>, enqueue');
                    process.exit(1);
            }
            break;
        }

        case '--api':
        case 'api':
            // Serveur API standalone (lecture seule de la DB)
            console.log('[API] Démarrage du serveur API...');
            startApiServer();
            console.log('[API] Serveur en cours. Ctrl+C pour arrêter.');
            break;

        case '--help':
        case 'help':
        default:
            console.log(`
Steam-SCE Scraper - Commandes disponibles:

  npm run sync            Mode daemon: scan complet si BD vide, puis boucle syncHistory toutes les 10 min
  npm run login           Authentification Steam interactive (mot de passe ou QR code)
  npm run login:qr        Authentification Steam via QR code uniquement
  npm run login:password  Authentification Steam via mot de passe uniquement
  npm run sync:badges     Force le scan complet de tous les badges
  npm run sync:gamecards <appid>  Scanne un appid specifique
  npm run sync:history    Synchronise une fois l historique des trades
  npm run init-db         Initialise la base SQLite
  npm run api             Démarre le serveur API REST (lecture seule de la DB)
  npm run market           Démarre le worker de marché temps réel (token bucket adaptatif)
  npm run -- --market stats   Stats de la queue de marché
  npm run -- --market price <hash>   Prix en cache d'une carte (stale-while-revalidate)
  npm run -- --market refresh <hash>  Force le refresh d'une carte
  npm run -- --market enqueue  Enfiler les cartes stale pour refresh
  npm run -- --sync-once  Synchronise une seule fois l historique (sans boucle)
  npm run -- --purge      Purge le cache complet
  npm run -- --scan-all   Re-scanne tous les badges connus
  npm run -- --refetch-cards  Re-fetch les cartes Steam (sans SCE) pour tous les badges
  npm run -- --status     Affiche le status des badges en DB
  npm run -- --db        Affiche un resume de la base (summary, games, game <appid>, cards <appid>, badges, meta, query "SQL")
            `);
            break;
    }

    // Ne pas appeler process.exit(0) pour le mode daemon, le worker de marché (start)
    // et le serveur API (ils gardent le process en vie)
    if (command !== 'sync' && command !== '--daemon' && command !== 'daemon'
        && command !== '--api' && command !== 'api') {
        // --market start garde le process en vie, mais --market stats/price/refresh/enqueue doivent quitter
        if (command === '--market' || command === 'market') {
            if (args[1] !== 'start' && args[1] !== undefined) {
                process.exit(0);
            }
            // --market (sans sous-commande) équivaut à --market start → ne pas quitter
        } else {
            process.exit(0);
        }
    }
}

main().catch(err => {
    console.error('Erreur fatale:', err);
    process.exit(1);
});
