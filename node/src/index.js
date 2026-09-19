import { mainWorkflow, mainWorkflowGamecards, purgeAllCache, processQueue } from './sync.js';
import { getAllBadgeAppids, getGame, isDBEmpty, countGames, getAllGames, getCards, getDB, getMeta } from './db.js';
import { STEAM_PROFILE_PATH, setSteamCookie, getSteamCookie, getSteamProfilePath } from './utils.js';
import { getSteamCookies } from './auth.js';

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
                const { syncSteamInventoryHistory } = await import('./steam.js');
                console.log('Synchronisation unique de l historique...');
                await syncSteamInventoryHistory(getSteamProfilePath());
                console.log('Termine.');
            }
            break;

        case '--badges':
        case 'badges':
            // Force le scan complet meme si la BD n'est pas vide
            {
                const { getPageAppids } = await import('./steam.js');
                const { analyzeBadgeStatus } = await import('./analyze.js');
                const { isSteamEvent } = await import('./utils.js');

                // Authentification necessaire pour Steam
                if (!getSteamCookie()) {
                    const cookies = await getSteamCookies(process.env.STEAM_AUTH_METHOD || 'auto');
                    setSteamCookie(cookies);
                }

                console.log(`BD actuelle: ${countGames()} jeux.`);
                const pageAppids = await getPageAppids(getSteamProfilePath());
                const appids = pageAppids.filter(i => !isSteamEvent(i.appid)).map(i => i.appid);
                console.log(`Scan force de ${appids.length} badges...`);
                await processQueue(appids, getSteamProfilePath());
                pageAppids.forEach(item => {
                    if (!isSteamEvent(item.appid)) analyzeBadgeStatus(item.appid);
                });
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
                const { syncSteamInventoryHistory } = await import('./steam.js');
                // Authentification necessaire pour Steam
                if (!getSteamCookie()) {
                    const cookies = await getSteamCookies(process.env.STEAM_AUTH_METHOD || 'auto');
                    setSteamCookie(cookies);
                }
                await syncSteamInventoryHistory(getSteamProfilePath());
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
            await processQueue(appids, getSteamProfilePath());
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
                    await refetchSteamData(appid, pl);
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
                        console.log('  #   nom                          qty  stock  worth  price  market€  7j  quick-trade');
                        console.log('  --- ---------------------------- ---  -----  ------  -----  -------  --  ----------');
                        for (const c of cards) {
                            const priceStr = c.steam_market_price_eur !== null ? c.steam_market_price_eur.toFixed(2) + '€' : 'N/A';
                            console.log(`  ${String(c.card_index ?? '?').padStart(3)} ${(c.name || '').substring(0, 28).padEnd(28)} ${String(c.qty).padStart(3)}  ${String(c.sce_stock).padStart(5)}  ${String(c.sce_worth).padStart(6)}  ${String(c.sce_price).padStart(5)}  ${priceStr.padStart(7)}  ${String(c.steam_market_sales_7d).padStart(2)}  ${(c.sce_quick_trade ? 'oui' : 'non').padEnd(10)}`);
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
                        console.log(`  [${c.card_index ?? '?'}] ${c.name || '(sans nom)'}`);
                        console.log(`      qty=${c.qty}  stock=${c.sce_stock}  worth=${c.sce_worth}  price=${c.sce_price}  market=${priceStr}  ventes7j=${c.steam_market_sales_7d}`);
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
  npm run -- --sync-once  Synchronise une seule fois l historique (sans boucle)
  npm run -- --purge      Purge le cache complet
  npm run -- --scan-all   Re-scanne tous les badges connus
  npm run -- --refetch-cards  Re-fetch les cartes Steam (sans SCE) pour tous les badges
  npm run -- --status     Affiche le status des badges en DB
  npm run -- --db        Affiche un resume de la base (summary, games, game <appid>, cards <appid>, badges, meta, query "SQL")
            `);
            break;
    }

    // Ne pas appeler process.exit(0) pour le mode daemon (la boucle tourne)
    if (command !== 'sync' && command !== '--daemon' && command !== 'daemon') {
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Erreur fatale:', err);
    process.exit(1);
});
