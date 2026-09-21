import * as cheerio from 'cheerio';
import { httpGet, clean, isSteamEvent, ES_log, SCE_COOKIE, getSteamCookie } from './utils.js';
import { getGame, upsertGame, upsertCards, getCards, setMeta, getMeta } from './db.js';
import { getSCECookieViaSteamOpenID } from './auth.js';

// Cookie SCE mutable: charge depuis DB meta d'abord, puis .env en fallback
let _sceCookieStr = getMeta('sceCookie', '') || SCE_COOKIE || '';
let creditFetched = false;
let _sceRetryDone = false;
let _globalInfoPromise = null;

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
        ES_log(`[fetchSCEGlobalInfo] Titre de la page: ${pageTitle}`);

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
            ES_log(`[fetchSCEGlobalInfo] Cookie SCE present (${getSCECookie().substring(0, 30)}...)`);
        } else {
            ES_log('[fetchSCEGlobalInfo] ATTENTION: SCE_COOKIE non defini dans .env');
            ES_log('[fetchSCEGlobalInfo] Recuperez le PHPSESSID depuis votre navigateur:');
            ES_log('[fetchSCEGlobalInfo]   DevTools > Application > Cookies > steamcardexchange.net > PHPSESSID');
        }

        // --- Recuperation Credit ---
        let rawCreditText = '';
        const creditEl = $('.inventory-user-credits .number');
        if (creditEl.length > 0) {
            rawCreditText = creditEl.text();
        } else {
            const desktopCreditEl = $('nav .hidden.lg\\:block button div.ml-auto');
            rawCreditText = desktopCreditEl.length > 0 ? desktopCreditEl.text() : '';
        }
        const sceCredit = parseInt(rawCreditText.replace(/\D/g, ''), 10) || 0;
        setMeta('scecredit', String(sceCredit));

        // --- Recuperation Offres en Attente ---
        let pendingOffers = 0;
        let waitTime = 0;
        let foundStatus = false;

        const infoSpans = $('div.bg-gray-light span, div.bg-gray-lighter span');
        infoSpans.each((_, span) => {
            const text = $(span).text();
            if (text.includes('offers pending')) {
                const pendingMatch = text.match(/(\d+)\s+offers\s+pending/i);
                pendingOffers = pendingMatch ? parseInt(pendingMatch[1], 10) : 0;

                const waitMatch = text.match(/wait\s+time\s+is\s+([\d.]+)\s+minutes/i);
                waitTime = waitMatch ? parseFloat(waitMatch[1]) : 0;

                foundStatus = true;
                return false; // break
            }
        });

        if (!foundStatus) {
            console.warn('[SCE] Impossible de localiser les stats du bot dans le HTML.');
        }

        setMeta('scePendingOffers', String(pendingOffers));
        setMeta('sceWaitTime', String(waitTime));

        creditFetched = true;
        ES_log(`[fetchSCEGlobalInfo] Credit: ${sceCredit} | Queue: ${pendingOffers} offres.`);
    } catch (e) {
        console.warn('[fetchSCEGlobalInfo] Erreur:', e);
    }
}

/**
 * Verifie si le trade-in SCE est desactive pour un appid
 * (remplace l'ancienne fonction fetchSCEMarketPrices qui recuperait aussi les prix USD)
 */
async function checkSCEDisabled(appid) {
    const html = await httpGet(`https://www.steamcardexchange.net/index.php?gamepage-appid-${appid}/`, { cookies: getSCECookie() });

    if (!html || html.includes('Trade-in disabled')) {
        return true;
    }

    const $ = cheerio.load(html);
    const tradingCardsHeader = $('#series-1-cards').closest('div.bg-gray-dark');
    if (tradingCardsHeader.length === 0) {
        return true;
    }

    return false;
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

    // Recupere le jeu existant
    const existingGame = getGame(appid);
    if (!existingGame) {
        ES_log(`[fetchSCEFresh] Appid ${appid} non trouve en DB. Lancez d abord fetchSteamData.`);
        return null;
    }

    if (existingGame.disabled) return null;

    // 1. Verifier si le trade-in est desactive sur SCE
    const sceDisabled = await checkSCEDisabled(appid);
    if (sceDisabled) {
        ES_log(`[fetchSCEFresh] Trade-in desactive pour ${appid}.`);
        upsertGame(appid, { ...existingGame, disabled: true });
        return null;
    }

    // 2. Inventaire SCE
    const inventoryMap = await fetchSCEInventory(appid);

    // 3. Fusion dans les cartes (les prix marche Steam sont recuperes separement via fetchSteamMarketPrices)
    const dbCards = getCards(appid);
    const cards = dbCards.map(dbCard => {
        const inv = JSON.parse(dbCard.inv_json || '[]');
        const normName = clean(dbCard.name, true);
        const invData = inventoryMap[normName] || {};

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
            'sce marketPriceUSD': 0, // Deprecated: prix maintenant recuperes via Steam Market
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
