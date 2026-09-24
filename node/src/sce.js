import * as cheerio from 'cheerio';
import { httpGet, clean, isSteamEvent, ES_log, SCE_COOKIE, getSteamCookie } from './utils.js';
import { getGame, upsertGame, upsertCards, getCards, setMeta, getMeta } from './db.js';
import { getSCECookieViaSteamOpenID } from './auth.js';

// Cookie SCE mutable: charge depuis DB meta d'abord, puis .env en fallback
let _sceCookieStr = getMeta('sceCookie', '') || SCE_COOKIE || '';
let creditFetched = false;
let _sceRetryDone = false;
let _globalInfoPromise = null;
let _globalInfoInterval = null;
const GLOBAL_INFO_REFRESH_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Demarre un intervalle qui rafraichit les infos globales SCE (credit,
 * pending offers, wait time) toutes les 10 minutes, uniquement si le
 * waitTime actuel est inferieur a 1 minute (bot non sature).
 * Idempotent: ne cree pas un second intervalle si deja actif.
 */
function _startGlobalInfoInterval() {
    if (_globalInfoInterval) return;

    _globalInfoInterval = setInterval(async () => {
        const waitTime = parseFloat(getMeta('sceWaitTime', '0')) || 0;
        if (waitTime >= 1) {
            ES_log(`[fetchSCEGlobalInfo] Skip refresh: waitTime=${waitTime} min (>= 1 min).`);
            return;
        }

        // Evite les appels concurrents
        if (_globalInfoPromise) return;

        ES_log('[fetchSCEGlobalInfo] Refresh periodique (waitTime < 1 min)...');
        creditFetched = false; // Force le re-fetch
        _globalInfoPromise = (async () => {
            try {
                await _fetchSCEGlobalInfoInner();
            } finally {
                _globalInfoPromise = null;
            }
        })();
    }, GLOBAL_INFO_REFRESH_MS);

    ES_log(`[fetchSCEGlobalInfo] Intervalle de rafraichissement demarre (toutes les ${GLOBAL_INFO_REFRESH_MS / 60000} min).`);
}

/**
 * Retourne le cookie SCE courant.
 */
function getSCECookie() { return _sceCookieStr; }

/**
 * Tente d'obtenir un cookie SCE valide:
 * 1. Si cookie existant → test sur la page profile
 * 2. Si invalide → login OpenID via Steam
 * 3. Sauvegarde le nouveau cookie en DB (meta)
 */
async function ensureSCECookie() {
    // Si on a deja un cookie, on le teste
    if (_sceCookieStr) {
        return; // Le test se fera dans fetchSCEGlobalInfo
    }

    // Pas de cookie: login OpenID automatique via Steam
    const steamCookie = getSteamCookie();
    if (!steamCookie) {
        console.warn('[SCE] Pas de cookie Steam disponible pour le login OpenID SCE.');
        console.warn('[SCE] Lancez d abord: npm run login');
        return;
    }

    console.log('[SCE] Pas de cookie SCE - tentative de login OpenID automatique...');
    const newCookie = await getSCECookieViaSteamOpenID(steamCookie);
    if (newCookie) {
        _sceCookieStr = newCookie;
        setMeta('sceCookie', newCookie);
        console.log('[SCE] Cookie SCE sauvegarde en DB.');
    } else {
        console.warn('[SCE] Login OpenID automatique echoue.');
        console.warn('[SCE] Recuperez le PHPSESSID manuellement:');
        console.warn('[SCE]   DevTools > Application > Cookies > steamcardexchange.net > PHPSESSID');
        console.warn('[SCE]   .env: SCE_COOKIE=PHPSESSID=<valeur>');
    }
}

/**
 * Recupere le credit SCE et les offres en attente depuis la page profile
 * (peuple la meta 'sceWaitTime' utilisee pour la parallelisation de fetchSCEInventory)
 */
export async function fetchSCEGlobalInfo() {
    if (creditFetched) return;

    // Verrou: evite les appels concurrents (workers multiples)
    if (_globalInfoPromise) return _globalInfoPromise;
    _globalInfoPromise = (async () => {
        try {
            await _fetchSCEGlobalInfoInner();
            // Demarre le rafraichissement periodique (toutes les 10 min) si pas deja actif
            _startGlobalInfoInterval();
        } finally {
            _globalInfoPromise = null;
        }
    })();
    return _globalInfoPromise;
}

async function _fetchSCEGlobalInfoInner() {
    if (creditFetched) return;

    try {
        // S'assure qu'on a un cookie SCE (login OpenID si necessaire)
        await ensureSCECookie();

        let profileHtml = await httpGet('https://www.steamcardexchange.net/index.php?profile', { cookies: getSCECookie() });
        let $ = cheerio.load(profileHtml);

        // Debug: verifier si on est sur une page de connexion
        const titleMatch = profileHtml.match(/<title>(.*?)<\/title>/i);
        const pageTitle = titleMatch ? titleMatch[1].trim() : '(inconnu)';
        //ES_log(`[fetchSCEGlobalInfo] Titre de la page: ${pageTitle}`);

        // Detection du mur de connexion: SCE affiche "Please login" si le PHPSESSID est expire
        if (profileHtml.includes('Please login to see your profile')) {
            console.warn('[SCE] Session SCE expiree (PHPSESSID invalide).');
            
            // Tentative de re-login OpenID via Steam (une seule fois)
            const steamCookie = getSteamCookie();
            if (steamCookie && !_sceRetryDone) {
                _sceRetryDone = true;
                console.log('[SCE] Tentative de re-login OpenID automatique...');
                _sceCookieStr = ''; // Invalide l'ancien cookie
                setMeta('sceCookie', '');
                const newCookie = await getSCECookieViaSteamOpenID(steamCookie);
                if (newCookie) {
                    _sceCookieStr = newCookie;
                    setMeta('sceCookie', newCookie);
                    console.log('[SCE] Nouveau cookie SCE obtenu, retry...');
                    // Re-fetch le profile avec le nouveau cookie
                    const retryHtml = await httpGet('https://www.steamcardexchange.net/index.php?profile', { cookies: getSCECookie() });
                    if (!retryHtml.includes('Please login to see your profile')) {
                        // Succes! Continue avec le nouveau HTML
                        profileHtml = retryHtml;
                        $ = cheerio.load(profileHtml);
                        // Continue vers l'extraction du credit plus bas
                    } else {
                        console.warn('[SCE] Le nouveau cookie SCE est egalement invalide.');
                        setMeta('scecredit', '0');
                        setMeta('scePendingOffers', '0');
                        setMeta('sceWaitTime', '0');
                        creditFetched = true;
                        return;
                    }
                } else {
                    console.warn('[SCE] Re-login OpenID echoue.');
                    console.warn('[SCE] Recuperez le PHPSESSID manuellement:');
                    console.warn('[SCE]   DevTools > Application > Cookies > steamcardexchange.net > PHPSESSID');
                    console.warn('[SCE]   .env: SCE_COOKIE=PHPSESSID=<valeur>');
                    setMeta('scecredit', '0');
                    setMeta('scePendingOffers', '0');
                    setMeta('sceWaitTime', '0');
                    creditFetched = true;
                    return;
                }
            } else {
                setMeta('scecredit', '0');
                setMeta('scePendingOffers', '0');
                setMeta('sceWaitTime', '0');
                creditFetched = true;
                return;
            }
        }

        if (getSCECookie()) {
           // ES_log(`[fetchSCEGlobalInfo] Cookie SCE present (${getSCECookie().substring(0, 30)}...)`);
        } else {
            ES_log('[fetchSCEGlobalInfo] ATTENTION: SCE_COOKIE non defini dans .env');
            ES_log('[fetchSCEGlobalInfo] Recuperez le PHPSESSID depuis votre navigateur:');
            ES_log('[fetchSCEGlobalInfo]   DevTools > Application > Cookies > steamcardexchange.net > PHPSESSID');
        }

        // --- Recuperation Credit ---
        // Le site SCE a ete refait (Tailwind CSS, v=2025-08-18).
        // On essaie plusieurs selecteurs pour retrouver le credit affiche.
        let rawCreditText = '';

        // Strategie 1: ancien selecteur (peut encore fonctionner sur certains profils)
        const creditEl = $('.inventory-user-credits .number');
        if (creditEl.length > 0) {
            rawCreditText = creditEl.text();
            //ES_log(`[fetchSCEGlobalInfo] Credit trouve via .inventory-user-credits .number: "${rawCreditText}"`);
        }

        // Strategie 2: nav bar desktop (ancien selecteur)
        if (!rawCreditText) {
            const desktopCreditEl = $('nav .hidden.lg\\:block button div.ml-auto');
            if (desktopCreditEl.length > 0) {
                rawCreditText = desktopCreditEl.text();
               // ES_log(`[fetchSCEGlobalInfo] Credit trouve via nav button div.ml-auto: "${rawCreditText}"`);
            }
        }

        // Strategie 3: chercher un element contenant un nombre + "credit" dans le nav
        if (!rawCreditText) {
            $('nav span, nav button, nav div').each((_, el) => {
                const text = $(el).text().trim();
                if (/^\d+\s*c$/i.test(text) || /^\d+\s*credits?$/i.test(text) || /^credits?:\s*\d+$/i.test(text)) {
                    rawCreditText = text;
                   // ES_log(`[fetchSCEGlobalInfo] Credit trouve via text search nav: "${rawCreditText}"`);
                    return false;
                }
            });
        }

        // Strategie 4: chercher dans le contenu du profil
        if (!rawCreditText) {
            $('main span, main div, main button').each((_, el) => {
                const text = $(el).text().trim();
                if (/^\d+\s*c$/i.test(text) || /^\d+\s*credits?$/i.test(text) || /^credits?:\s*\d+$/i.test(text)) {
                    if (!/max/i.test(text)) {
                        rawCreditText = text;
                       // ES_log(`[fetchSCEGlobalInfo] Credit trouve via text search main: "${rawCreditText}"`);
                        return false;
                    }
                }
            });
        }

        if (!rawCreditText) {
           // ES_log('[fetchSCEGlobalInfo] ATTENTION: impossible de trouver le credit dans le HTML du profil.');
            const mainContent = $('main').text().trim().substring(0, 500);
           // ES_log(`[fetchSCEGlobalInfo] Contenu de <main>: ${mainContent}`);
        }

        const sceCredit = parseInt(rawCreditText.replace(/\D/g, ''), 10) || 0;
        setMeta('scecredit', String(sceCredit));

        // --- Recuperation Offres en Attente + Wait Time ---
        // Ces infos sont affichees sur la page INVENTORY du SCE:
        // <span>There are currently 0 offers pending. The average process time is 8 seconds.
        // The estimated wait time is 0 minutes.</span>
        let pendingOffers = 0;
        let waitTime = 0;
        let foundStatus = false;

        // Strategie 1: chercher dans le profil d'abord
        const infoSpans = $('div.bg-gray-light span, div.bg-gray-lighter span');
        infoSpans.each((_, span) => {
            const text = $(span).text();
            if (text.includes('offers pending')) {
                const pendingMatch = text.match(/(\d+)\s+offers\s+pending/i);
                pendingOffers = pendingMatch ? parseInt(pendingMatch[1], 10) : 0;

                const waitMatch = text.match(/wait\s+time\s+is\s+([\d.]+)\s+minutes/i);
                waitTime = waitMatch ? parseFloat(waitMatch[1]) : 0;

                foundStatus = true;
                return false;
            }
        });

        // Strategie 2: si non trouve dans le profil, on fetch la page inventory
        // qui contient systematiquement le statut du bot
        if (!foundStatus) {
            try {
                const inventoryHtml = await httpGet('https://www.steamcardexchange.net/index.php?inventory', { cookies: getSCECookie() });
                const $inv = cheerio.load(inventoryHtml);

                $inv('span').each((_, span) => {
                    const text = $inv(span).text();
                    if (text.includes('offers pending')) {
                        const pendingMatch = text.match(/(\d+)\s+offers\s+pending/i);
                        pendingOffers = pendingMatch ? parseInt(pendingMatch[1], 10) : 0;

                        const waitMatch = text.match(/wait\s+time\s+is\s+([\d.]+)\s+minutes/i);
                        waitTime = waitMatch ? parseFloat(waitMatch[1]) : 0;

                        foundStatus = true;
                        return false;
                    }
                });

                if (foundStatus) {
                   // ES_log('[fetchSCEGlobalInfo] Statut du bot recupere depuis la page inventory.');
                }
            } catch (invErr) {
               // ES_log(`[fetchSCEGlobalInfo] Erreur lors du fetch de la page inventory: ${invErr.message}`);
            }
        }

        if (!foundStatus) {
           // console.warn('[SCE] Impossible de localiser les stats du bot (offers pending / wait time).');
        }

        setMeta('scePendingOffers', String(pendingOffers));
        setMeta('sceWaitTime', String(waitTime));

        creditFetched = true;
        ES_log(`[fetchSCEGlobalInfo] Credit: ${sceCredit} | Queue: ${pendingOffers} offres | WaitTime: ${waitTime} min.`);
    } catch (e) {
        console.warn('[fetchSCEGlobalInfo] Erreur:', e);
    }
}

/**
 * Recupere le HTML de la gamepage SCE pour un appid.
 * Retourne null si la page est invalide ou si le trade-in est desactive.
 * (Remplace l'ancienne fonction checkSCEDisabled: la page recuperee est
 * aussi utilisee pour extraire les prix USD des cartes.)
 */
async function fetchSCEGamePage(appid) {
    const html = await httpGet(`https://www.steamcardexchange.net/index.php?gamepage-appid-${appid}/`, { cookies: getSCECookie() });

    if (!html || html.includes('Trade-in disabled')) {
        return null;
    }

    const $ = cheerio.load(html);
    const tradingCardsHeader = $('#series-1-cards').closest('div.bg-gray-dark');
    if (tradingCardsHeader.length === 0) {
        return null;
    }

    return html;
}

/**
 * Parse les prix USD des cartes depuis le HTML d'une gamepage SCE.
 * Seule la section "Trading Cards" (#series-1-cards) est prise en compte
 * (pas les foils, backgrounds ni emojis).
 * Chaque bloc carte contient:
 *   <div class="text-sm text-center break-words">Undead Boss</div>
 *   <a href="https://steamcommunity.com/market/listings/753/..." class="mt-auto btn-primary">Price: $0.38</a>
 * @param {string} html - HTML de la gamepage (index.php?gamepage-appid-N)
 * @returns {Object} Map nom nettoye -> prix USD (float)
 */
export function parseSCEGamePrices(html) {
    const $ = cheerio.load(html);
    const priceMap = {};

    // En-tete de la section "Trading Cards" (#series-1-cards)
    const sectionHeader = $('#series-1-cards').closest('div.bg-gray-dark');
    if (sectionHeader.length === 0) return priceMap;

    // La grille des cartes suit l'en-tete de section
    const grid = sectionHeader.next('div.grid');
    if (grid.length === 0) return priceMap;

    grid.find('div.flex.flex-col').each((_, block) => {
        const $block = $(block);
        const nameEl = $block.find('div.text-sm.text-center.break-words');
        const priceLink = $block.find('a.btn-primary');
        if (nameEl.length === 0 || priceLink.length === 0) return;

        const match = priceLink.text().match(/Price:\s*\$([\d.,]+)/i);
        if (!match) return;

        const price = parseFloat(match[1].replace(/,/g, ''));
        if (isNaN(price)) return;

        priceMap[clean(nameEl.text().trim(), true)] = price;
    });

    return priceMap;
}

// Taux de conversion USD -> EUR par defaut (fallback si l'API est injoignable
// et aucun taux en cache). Surchargeable via SCE_USD_TO_EUR dans .env.
const DEFAULT_USD_TO_EUR = 0.92;
let _usdToEurPromise = null;

/**
 * Retourne le taux de conversion USD -> EUR.
 * Priorite: override manuel via SCE_USD_TO_EUR (env), puis taux de l'API
 * Frankfurter (BCE) mis en cache 24h en meta 'usdToEur', puis dernier taux
 * en cache, sinon DEFAULT_USD_TO_EUR.
 * @returns {Promise<number>}
 */
export async function getUSDtoEUR() {
    // Override manuel via .env (valeur invalide ignoree)
    const envRate = parseFloat(process.env.SCE_USD_TO_EUR || '');
    if (envRate > 0) return envRate;

    const cached = parseFloat(getMeta('usdToEur', '0')) || 0;
    const fetchedAt = parseInt(getMeta('usdToEurFetchedAt', '0'), 10) || 0;
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Cache valide moins de 24h
    if (cached > 0 && (Date.now() - fetchedAt) < DAY_MS) return cached;

    // Une seule requete a la fois (workers paralleles)
    if (_usdToEurPromise) return _usdToEurPromise;

    _usdToEurPromise = (async () => {
        try {
            const text = await httpGet('https://api.frankfurter.app/latest?from=USD&to=EUR');
            const data = JSON.parse(text);
            const rate = data && data.rates ? parseFloat(data.rates.EUR) : NaN;
            if (rate > 0) {
                setMeta('usdToEur', String(rate));
                setMeta('usdToEurFetchedAt', String(Date.now()));
                return rate;
            }
        } catch (e) {
            ES_log(`[getUSDtoEUR] Erreur recuperation taux USD/EUR: ${e.message}`);
        }
        if (cached > 0) {
            ES_log(`[getUSDtoEUR] API injoignable, utilisation du taux en cache: ${cached}`);
            return cached;
        }
        ES_log(`[getUSDtoEUR] Fallback sur le taux par defaut: ${DEFAULT_USD_TO_EUR}`);
        return DEFAULT_USD_TO_EUR;
    })().finally(() => { _usdToEurPromise = null; });

    return _usdToEurPromise;
}

/**
 * Indique si la file d'attente du bot SCE est saturee:
 * waitTime > 1 minute ET plus de 10 offres en attente.
 * (Metas 'sceWaitTime' / 'scePendingOffers' peuplees par fetchSCEGlobalInfo)
 */
export function isSCEBusy() {
    const waitTime = parseFloat(getMeta('sceWaitTime', '0')) || 0;
    const pendingOffers = parseInt(getMeta('scePendingOffers', '0'), 10) || 0;
    return (waitTime > 1) && (pendingOffers > 10);
}

/**
 * Recupere l inventaire SCE (stock) pour un appid
 */
async function fetchSCEInventory(appid) {
    const html = await httpGet(`https://www.steamcardexchange.net/index.php?inventorygame-appid-${appid}`, { cookies: getSCECookie() });
    const $ = cheerio.load(html);
    const inventoryMap = {};

    $('div.flex.flex-col.items-center.p-5').each((_, block) => {
        const $block = $(block);
        const nameEl = $block.find('div.text-sm.break-words');
        if (nameEl.length === 0) return;

        const name = nameEl.text().trim();

        // Stock
        let stock = 0;
        $block.find('div').each((_, div) => {
            const divText = $(div).text();
            if (divText.includes('Stock:')) {
                const match = divText.match(/Stock:\s*(\d+)/i);
                if (match) stock = parseInt(match[1], 10);
            }
        });

        // Worth & Price
        let worth = 0;
        let price = 0;
        $block.find('div.mt-auto.text-sm > div').each((_, line) => {
            const lineText = $(line).text().toLowerCase();
            const valueSpan = $(line).find('span.font-open-sans');
            if (valueSpan.length === 0) return;
            const val = parseInt(valueSpan.text(), 10) || 0;
            if (lineText.includes('worth')) worth = val;
            if (lineText.includes('price')) price = val;
        });

        let tradeLink = $block.find('a.btn-primary').attr('href') || '';
        // Normalise en URL absolue si relative
        if (tradeLink && !tradeLink.startsWith('http')) {
            tradeLink = 'https://www.steamcardexchange.net' + (tradeLink.startsWith('/') ? '' : '/') + tradeLink;
        }

        inventoryMap[clean(name, true)] = {
            stock: stock,
            worth: worth,
            price: price,
            quickTrade: tradeLink
        };
    });

    ES_log(`[fetchSCEInventory] ${Object.keys(inventoryMap).length} cartes trouvees pour appid ${appid}.`);

    return inventoryMap;
}

/**
 * Scrap complet SCE pour un appid: prix marche, inventaire, fusion dans les cartes
 */
export async function fetchSCEFresh(appid) {
    if (isSteamEvent(appid)) return null;

    ES_log(`[fetchSCEFresh] START ${appid}`);

    // Recupere les infos globales (credit, pending offers)
    await fetchSCEGlobalInfo();

    // File d'attente SCE saturee (waitTime > 1 min et plus de 10 offres en
    // attente): on ne scrape pas maintenant, l'appid sera retente au prochain
    // sync (cycle de surveillance du daemon, toutes les 10 minutes)
    if (isSCEBusy()) {
        ES_log(`[fetchSCEFresh] File SCE saturee (waitTime > 1 min, pendingOffers > 10) - appid ${appid} differe au prochain sync.`);
        return null;
    }

    // Recupere le jeu existant
    const existingGame = getGame(appid);
    if (!existingGame) {
        ES_log(`[fetchSCEFresh] Appid ${appid} non trouve en DB. Lancez d abord fetchSteamData.`);
        return null;
    }

    if (existingGame.disabled) return null;

    // 1. Recuperer la gamepage SCE (verifie au passage si le trade-in est
    //    desactive) et en extraire les prix USD des cartes
    //    (section "Trading Cards" #series-1-cards uniquement)
    const gamePageHtml = await fetchSCEGamePage(appid);
    if (!gamePageHtml) {
        ES_log(`[fetchSCEFresh] Trade-in desactive pour ${appid}.`);
        upsertGame(appid, { ...existingGame, disabled: true });
        return null;
    }
    const gamePriceMap = parseSCEGamePrices(gamePageHtml);
    ES_log(`[fetchSCEFresh] ${Object.keys(gamePriceMap).length} prix USD extraits de la gamepage.`);

    // 2. Inventaire SCE
    const inventoryMap = await fetchSCEInventory(appid);

    // 3. Taux USD -> EUR pour stocker le prix SCE converti en euros
    const usdToEur = await getUSDtoEUR();

    // 4. Fusion dans les cartes (les prix marche Steam sont affines ensuite
    //    par fetchMarketPricesV2, phase 2)
    const dbCards = getCards(appid);
    const cards = dbCards.map(dbCard => {
        const inv = JSON.parse(dbCard.inv_json || '[]');
        const normName = clean(dbCard.name, true);
        const invData = inventoryMap[normName] || {};
        // Prix USD de la gamepage SCE (section Trading Cards)
        const priceUSD = gamePriceMap[normName] || 0;

        return {
            name: dbCard.name,
            qty: dbCard.qty,
            index: dbCard.card_index,
            inv: inv,
            hash: dbCard.hash,
            iconUrl: dbCard.icon_url,
            artUrl: dbCard.art_url,
            'sce stock': invData.stock || 0,
            'sce worth': invData.worth || 0,
            'sce price': invData.price || 0,
            'sce marketPriceUSD': priceUSD,
            // Prix SCE converti en EUR, stocke dans steam_market_price_eur
            // (null si pas de prix -> conserve la valeur existante en DB)
            steamMarketPriceEur: priceUSD > 0 ? Math.round(priceUSD * usdToEur * 100) / 100 : null,
            // Preserver les prix marche Steam existants (mis a jour par fetchMarketPricesV2)
            steamMarketLastSalePriceEur: dbCard.steam_market_last_sale_price_eur,
            steamMarketSales7d: dbCard.steam_market_sales_7d,
            steamMarketFetchedAt: dbCard.steam_market_fetched_at,
            steamMarketSellPriceEur: dbCard.steam_market_sell_price_eur,
            steamMarketSellQty: dbCard.steam_market_sell_qty,
            steamMarketBuyOrderEur: dbCard.steam_market_buy_order_eur,
            steamMarketBuyOrderQty: dbCard.steam_market_buy_order_qty,
            'sce quick-trade': invData.quickTrade || ''
        };
    });

    // Sauvegarde les cartes enrichies
    upsertCards(appid, cards);

    // Met a jour le jeu
    upsertGame(appid, {
        ...existingGame,
        disabled: false,
        fetchedAt: Date.now(),
    });

    ES_log(`[fetchSCEFresh] Appid ${appid} enrichi et fusionne avec succes.`);

    return { ...existingGame, cards };
}

/**
 * Reset le flag creditFetched (pour forcer une re-recuperation)
 */
export function resetCreditFlag() {
    creditFetched = false;
}
