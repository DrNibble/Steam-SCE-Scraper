import { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } from 'steam-session';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import * as cheerio from 'cheerio';
import { ES_log, setSteamProfilePath, extractSteamIdFromCookies } from './utils.js';

/**
 * Extrait le SteamID depuis un JWT access token
 * Le JWT contient le SteamID dans le claim "sub"
 * @param {string} token - JWT access token
 * @returns {string|null}
 */
function extractSteamIdFromToken(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        // base64url decode du payload (2eme partie du JWT)
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        return payload.sub || null;
    } catch (e) {
        return null;
    }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const TOKEN_FILE = path.resolve(__dirname, '..', process.env.TOKEN_FILE || '../data/steam_refresh_token.txt');

/**
 * Prompt texte simple via stdin (sans readline)
 */
function prompt(question) {
    return new Promise(resolve => {
        process.stdout.write(question);
        let input = '';
        process.stdin.resume();
        process.stdin.setRawMode(false);
        process.stdin.setEncoding('utf8');
        const onData = (data) => {
            const newlineIdx = data.search(/[\r\n]/);
            if (newlineIdx !== -1) {
                // Add any content before the newline (handles line-buffered input)
                input += data.substring(0, newlineIdx);
                process.stdin.removeListener('data', onData);
                process.stdin.pause();
                resolve(input);
            } else {
                input += data;
            }
        };
        process.stdin.on('data', onData);
    });
}

/**
 * Prompt pour mot de passe avec masquage par etoiles
 */
function promptPassword(question) {
    return new Promise(resolve => {
        process.stdout.write(question);
        let password = '';
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        const onData = (ch) => {
            switch (ch) {
                case '\r':
                case '\n':
                    stdin.setRawMode(false);
                    stdin.removeListener('data', onData);
                    stdin.pause();
                    process.stdout.write('\n');
                    resolve(password);
                    break;
                case '\u0003': // Ctrl+C
                    process.stdout.write('\n');
                    process.exit(0);
                    break;
                case '\u007f':
                case '\b':
                    if (password.length > 0) {
                        password = password.slice(0, -1);
                        process.stdout.write('\b \b');
                    }
                    break;
                default:
                    if (ch >= ' ') {
                        password += ch;
                        process.stdout.write('*');
                    }
                    break;
            }
        };
        stdin.on('data', onData);
    });
}

/**
 * Sauvegarde le refresh token dans un fichier pour les futures executions
 */
function saveRefreshToken(token) {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token, 'utf8');
    console.log(`[Auth] Refresh token sauvegarde dans ${TOKEN_FILE}`);
}

/**
 * Charge le refresh token depuis le fichier
 */
function loadRefreshToken() {
    if (fs.existsSync(TOKEN_FILE)) {
        const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        if (token.length > 0) return token;
    }
    return null;
}

/**
 * Nettoie les cookies en gardant uniquement ceux pour un domaine specifique.
 * getWebCookies() retourne des cookies pour plusieurs domaines (login.steampowered.com,
 * steamcommunity.com, etc.). On ne garde que ceux du domaine demande pour eviter
 * d'envoyer des cookies invalides a steamcommunity.com.
 */
function cleanCookiesForDomain(cookies, targetDomain) {
    const map = new Map();
    for (const c of cookies) {
        const cLower = c.toLowerCase();
        // Accepte domain=steamcommunity.com ET domain=.steamcommunity.com
        if (!cLower.includes(`domain=${targetDomain}`) && !cLower.includes(`domain=.${targetDomain}`)) continue;

        const pair = c.split(';')[0].trim();
        if (!pair) continue;
        const eqIdx = pair.indexOf('=');
        if (eqIdx < 0) continue;
        const name = pair.substring(0, eqIdx);
        const value = pair.substring(eqIdx + 1);
        if (name === 'steamRefresh_steam') continue;
        map.set(name, value);
    }
    return Array.from(map.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

/**
 * Obtient les cookies Steam a partir d'une session authentifiee (ou avec refresh token).
 *
 * Strategie:
 * 1. getWebCookies() - recommandee pour WebBrowser (finalizelogin + transfer URLs)
 * 2. MobileApp + refreshAccessToken() + construction manuelle (fallback)
 *    refreshAccessToken() ne fonctionne que pour MobileApp depuis le 2025-04-30.
 * 3. Construction manuelle a partir de l'access token de la session (last resort)
 *
 * @param {LoginSession} session - Session steam-session avec refreshToken defini
 * @returns {Promise<{cookieStr: string, steamId: string}>}
 */
async function buildCookiesFromSession(session) {
    // Methode 1: getWebCookies() - utilise le refresh token comme nonce via finalizelogin
    // getWebCookies() retourne des cookies pour plusieurs domaines. On filtre uniquement
    // ceux pour steamcommunity.com pour eviter d'envoyer des cookies d'autres domaines.
    try {
        const rawCookies = await session.getWebCookies();
        const cookieStr = cleanCookiesForDomain(rawCookies, 'steamcommunity.com');

        if (cookieStr) {
            const steamId = extractSteamIdFromCookies(cookieStr)
                || session.steamID?.toString()
                || extractSteamIdFromToken(session.refreshToken);
            if (steamId) {
                setSteamProfilePath(`profiles/${steamId}`);
                return { cookieStr, steamId };
            }
        }
        console.warn('[Auth] getWebCookies() a retourne des cookies vides ou sans SteamID pour steamcommunity.com.');
    } catch (e) {
        console.warn(`[Auth] getWebCookies() a echoue: ${e.message}`);
    }

    // Methode 2 (fallback): MobileApp + refreshAccessToken() + construction manuelle
    // refreshAccessToken() ne fonctionne que pour MobileApp depuis le 2025-04-30.
    // ATTENTION: ne fonctionne que si le refresh token a ete emis pour MobileApp.
    // Pour un token WebBrowser, le setter refusera l'affectation (audience mismatch).
    if (session.refreshToken) {
        try {
            const mobileSession = new LoginSession(EAuthTokenPlatformType.MobileApp);
            mobileSession.refreshToken = session.refreshToken;
            await mobileSession.refreshAccessToken();

            const accessToken = mobileSession.accessToken;
            const steamId = mobileSession.steamID?.toString()
                || extractSteamIdFromToken(session.refreshToken);

            if (accessToken && steamId) {
                const sessionId = randomUUID().replace(/-/g, '');
                const cookieStr = `steamLoginSecure=${steamId}||${accessToken}; sessionid=${sessionId}`;
                setSteamProfilePath(`profiles/${steamId}`);
                console.log('[Auth] Fallback: cookies construits via MobileApp + refreshAccessToken().');
                return { cookieStr, steamId };
            }
        } catch (e) {
            console.warn(`[Auth] Fallback MobileApp ignore: ${e.message}`);
        }
    }

    // Methode 3 (last resort): construction manuelle a partir de l'access token de la session
    const accessToken = session.accessToken;
    const steamId = session.steamID?.toString()
        || extractSteamIdFromToken(accessToken || session.refreshToken);

    if (!accessToken) {
        throw new Error('Impossible d\'obtenir les cookies: toutes les methodes ont echoue');
    }
    if (!steamId) {
        throw new Error('SteamID null - impossible de construire le cookie');
    }

    const sessionId = randomUUID().replace(/-/g, '');
    const cookieStr = `steamLoginSecure=${steamId}||${accessToken}; sessionid=${sessionId}`;
    setSteamProfilePath(`profiles/${steamId}`);
    console.log('[Auth] Last resort: cookies construits manuellement.');
    return { cookieStr, steamId };
}

/**
 * Recupere les cookies Steam en utilisant un refresh token existant
 * Utilise getWebCookies() qui emploie le refresh token comme nonce
 * via l'endpoint finalizelogin de Steam pour obtenir des cookies frais.
 * Le refresh token doit correspondre au platform type (WebBrowser ici).
 */
async function getCookiesWithToken(refreshToken) {
    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
    session.refreshToken = refreshToken;

    try {
        const { cookieStr, steamId } = await buildCookiesFromSession(session);

        console.log(`[Auth] SteamID: ${steamId}`);
        console.log(`[Auth] Profil defini: profiles/${steamId}`);
        console.log('[Auth] Cookies obtenus via refresh token (getWebCookies).');
        return cookieStr;
    } catch (err) {
        console.warn(`[Auth] Le refresh token n'est plus valide: ${err.message}`);
        return null;
    }
}

/**
 * Authentification interactive avec nom d'utilisateur et mot de passe
 */
async function loginWithCredentials() {
    const accountName = await prompt('Nom d\'utilisateur Steam: ');
    const password = await promptPassword('Mot de passe: ');

    // Debug: verifier que les champs ne sont pas vides
    if (!accountName || !password) {
        console.error('[Auth] Erreur: nom d\'utilisateur ou mot de passe vide.');
        process.exit(1);
    }
    console.log(`[Auth] Utilisateur saisi: ${accountName} (${accountName.length} caracteres)`);

    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);

    // Helper: attend l'evenement authenticated (avec timeout)
    const waitForAuthenticated = () => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Timeout: aucune confirmation recue dans les 2 minutes'));
        }, 120000);

        session.on('authenticated', () => {
            clearTimeout(timeout);
            resolve();
        });

        session.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });

    let startResult;
    try {
        startResult = await session.startWithCredentials({
            accountName,
            password,
        });
    } catch (err) {
        console.error(`[Auth] Erreur de connexion: ${err.message}`);
        process.exit(1);
    }

    if (startResult.actionRequired) {
        const guardTypes = startResult.validActions.map(a => a.type);

        if (guardTypes.includes(EAuthSessionGuardType.DeviceConfirmation)) {
            console.log('\n[Auth] Une demande de confirmation a ete envoyee sur votre app mobile Steam.');
            console.log('[Auth] Veuillez approuver la connexion sur votre telephone...');
            await waitForAuthenticated();

        } else if (guardTypes.includes(EAuthSessionGuardType.DeviceCode)) {
            const code = await prompt('Code Steam Guard (TOTP): ');
            await session.submitSteamGuardCode(code);
            await waitForAuthenticated();

        } else if (guardTypes.includes(EAuthSessionGuardType.EmailCode)) {
            const emailDomain = startResult.validActions.find(a => a.type === EAuthSessionGuardType.EmailCode)?.detail || '';
            console.log(`[Auth] Un code a ete envoye par email (${emailDomain}).`);
            const code = await prompt('Code Steam Guard (email): ');
            await session.submitSteamGuardCode(code);
            await waitForAuthenticated();

        } else if (guardTypes.includes(EAuthSessionGuardType.EmailConfirmation)) {
            console.log('[Auth] Un email de confirmation a ete envoye. Veuillez l\'accepter...');
            await waitForAuthenticated();
        }
    } else {
        await waitForAuthenticated();
    }

    // Obtenir les cookies via getWebCookies() (methode recommandee par steam-session)
    // getWebCookies() utilise le refresh token comme nonce pour obtenir des cookies frais
    // via l'endpoint finalizelogin de Steam.
    if (session.refreshToken) {
        saveRefreshToken(session.refreshToken);
    }

    const { cookieStr, steamId } = await buildCookiesFromSession(session);

    console.log(`[Auth] SteamID: ${steamId}`);
    console.log(`[Auth] Profil defini: profiles/${steamId}`);

    console.log('[Auth] Connexion reussie.');
    return cookieStr;
}

/**
 * Authentification via QR code
 */
async function loginWithQR() {
    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);

    const startResult = await session.startWithQR();

    if (!startResult.qrChallengeUrl) {
        console.error('[Auth] Impossible de generer le QR code.');
        process.exit(1);
    }

    console.log('\n========================================');
    console.log('  SCANNER CE QR CODE AVEC L\'APP STEAM');
    console.log('========================================\n');
    console.log('URL du QR code:');
    console.log(startResult.qrChallengeUrl);
    console.log('\nEn attente de la confirmation sur l\'app mobile Steam...');

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Timeout: aucune confirmation recue dans les 2 minutes'));
        }, 120000);

        session.on('authenticated', () => {
            clearTimeout(timeout);
            resolve();
        });

        session.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });

    // Obtenir les cookies via getWebCookies() (methode recommandee par steam-session)
    if (session.refreshToken) {
        saveRefreshToken(session.refreshToken);
    }

    const { cookieStr, steamId } = await buildCookiesFromSession(session);

    console.log(`[Auth] SteamID: ${steamId}`);
    console.log(`[Auth] Profil defini: profiles/${steamId}`);

    console.log('[Auth] Connexion reussie via QR code.');
    return cookieStr;
}

/**
 * Methode principale: recupere les cookies Steam
 * @param {string} method - 'token' | 'password' | 'qr' | 'auto' (default)
 * @returns {Promise<string>} Cookie string pour les requetes HTTP
 */
export async function getSteamCookies(method = 'auto') {
    if (method === 'auto' || method === 'token') {
        const token = loadRefreshToken();
        if (token) {
            console.log('[Auth] Refresh token trouve, tentative de connexion...');
            const cookies = await getCookiesWithToken(token);
            if (cookies) return cookies;
            console.log('[Auth] Refresh token expire, nouveau login necessaire.');
        }
    }

    if (method === 'token') {
        console.error('[Auth] Aucun refresh token valide trouve.');
        process.exit(1);
    }

    if (method === 'qr') {
        return await loginWithQR();
    }

    if (method === 'password') {
        return await loginWithCredentials();
    }

    // auto: proposer le choix
    console.log('\n=== Authentification Steam ===\n');
    const choice = await prompt('Choisissez une methode de connexion:\n  1. Nom d\'utilisateur + mot de passe\n  2. QR code (app mobile Steam)\n\nChoix (1 ou 2): ');

    if (choice.trim() === '2') {
        return await loginWithQR();
    } else {
        return await loginWithCredentials();
    }
}

export function closeAuth() {
    process.stdin.setRawMode(false);
    process.stdin.pause();
}

/**
 * Cookie jar simple pour suivre les cookies a travers les redirections OpenID.
 * Gere les cookies par domaine (steamcommunity.com, steamcardexchange.net).
 */
class SimpleCookieJar {
    constructor() {
        this.domains = new Map();
    }

    getDomain(url) {
        try {
            return new URL(url).hostname.toLowerCase();
        } catch {
            return '';
        }
    }

    setCookieString(cookieStr, domain) {
        if (!this.domains.has(domain)) this.domains.set(domain, new Map());
        const jar = this.domains.get(domain);
        for (const pair of cookieStr.split(';')) {
            const eq = pair.indexOf('=');
            if (eq >= 0) {
                jar.set(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim());
            }
        }
    }

    captureSetCookies(resp, domain) {
        let setCookies = [];
        if (typeof resp.headers.getSetCookie === 'function') {
            setCookies = resp.headers.getSetCookie();
        } else {
            const raw = resp.headers.get('set-cookie');
            if (raw) setCookies = [raw];
        }
        if (setCookies.length === 0) return;
        if (!this.domains.has(domain)) this.domains.set(domain, new Map());
        const jar = this.domains.get(domain);
        for (const sc of setCookies) {
            const m = sc.match(/^([^=]+)=([^;]+)/);
            if (m) jar.set(m[1].trim(), m[2].trim());
        }
    }

    getCookies(domain) {
        const jar = this.domains.get(domain);
        if (!jar || jar.size === 0) return '';
        return Array.from(jar.entries()).map(([n, v]) => `${n}=${v}`).join('; ');
    }
}

/**
 * Verifie si un status HTTP est une redirection.
 */
function isRedirect(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Suit une redirection 302/301 manuellement, en envoyant les cookies du bon domaine.
 * Retourne la nouvelle URL et la reponse fetch.
 */
async function followRedirect(resp, url, jar, UA) {
    // Capture les cookies de la reponse de redirection actuelle (302)
    jar.captureSetCookies(resp, jar.getDomain(url));

    const location = resp.headers.get('location');
    if (!location) return { url, resp };
    const nextUrl = new URL(location, url).href;
    const domain = jar.getDomain(nextUrl);
    const currentDomain = jar.getDomain(url);
    const isCrossSite = domain !== currentDomain;
    // Headers navigateur complets pour toutes les requetes GET (y compris redirections).
    // Sans ces headers, Steam peut detecter un client non-navigateur et creer une session invalide.
    const nextResp = await fetch(nextUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        headers: {
            'User-Agent': UA,
            'Cookie': jar.getCookies(domain),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': isCrossSite ? 'cross-site' : 'same-origin',
            'Upgrade-Insecure-Requests': '1',
            'Referer': url,
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        },
    });
    jar.captureSetCookies(nextResp, domain);
    return { url: nextUrl, resp: nextResp };
}

/**
 * Recupere le PHPSESSID de Steam Card Exchange en effectuant un login OpenID
 * via Steam, en utilisant les cookies Steam deja obtenus.
 *
 * Flux:
 * 1. GET SCE login → 302 vers Steam OpenID
 * 2. Suivi des redirections Steam (avec cookies Steam)
 * 3. Si page d'approbation OpenID (200 + form) → POST du formulaire
 * 4. Redirection retour vers SCE → PHPSESSID defini
 *
 * @param {string} steamCookieStr - Cookie string Steam (steamLoginSecure=...; sessionid=...)
 * @returns {Promise<string|null>} Cookie string PHPSESSID ou null si echec
 */
export async function getSCECookieViaSteamOpenID(steamCookieStr) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const jar = new SimpleCookieJar();

    // Initialise avec les cookies Steam
    jar.setCookieString(steamCookieStr, 'steamcommunity.com');

    console.log('[SCE-Auth] Login OpenID SCE via Steam...');

    try {
        // Etape 1: GET page de login SCE → redirection vers Steam OpenID
        let url = 'https://www.steamcardexchange.net/index.php?login';
        let resp = await fetch(url, {
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
            headers: {
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Upgrade-Insecure-Requests': '1',
                'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
            },
        });
        jar.captureSetCookies(resp, jar.getDomain(url));

        // Suit les redirections a travers Steam
        for (let i = 0; i < 15; i++) {
            // Cas 1: Redirection (302/301/303/307/308)
            if (isRedirect(resp.status)) {
                console.log(`[SCE-Auth] Redirection ${resp.status}: ${url.substring(0, 80)}...`);
                const result = await followRedirect(resp, url, jar, UA);
                url = result.url;
                resp = result.resp;

                // Si on est revenu sur SCE, c'est le callback OpenID
                const domain = jar.getDomain(url);
                if (domain === 'www.steamcardexchange.net') {
                    console.log('[SCE-Auth] Callback OpenID recu sur SCE.');
                    // Suit les redirections SCE finales
                    for (let j = 0; j < 5 && isRedirect(resp.status); j++) {
                        const r = await followRedirect(resp, url, jar, UA);
                        url = r.url;
                        resp = r.resp;
                    }
                    const phpsessid = jar.getCookies('www.steamcardexchange.net');
                    if (phpsessid && phpsessid.includes('PHPSESSID')) {
                        console.log('[SCE-Auth] PHPSESSID obtenu avec succes.');
                        return phpsessid;
                    }
                    console.warn('[SCE-Auth] PHPSESSID non trouve dans les cookies SCE.');
                    return null;
                }
                continue;
            }

            // Cas 2: Page HTML (200) - probablement le formulaire d'approbation OpenID
            if (resp.status === 200) {
                const html = await resp.text();
                console.log(`[SCE-Auth] Page 200 recue: ${url.substring(0, 120)}... (${html.length} bytes)`);

                // Cherche un formulaire avec des parametres OpenID
                // Steam peut ne pas avoir method/action sur la balise form
                const $ = cheerio.load(html);

                let formAction = null;
                let formInputs = {};

                $('form').each((_, form) => {
                    if (formAction) return;
                    const $form = $(form);
                    const action = $form.attr('action') || '';

                    // Collecte tous les inputs du formulaire
                    const inputs = {};
                    $form.find('input').each((_, input) => {
                        const name = $(input).attr('name');
                        const value = $(input).attr('value') || '';
                        if (name) inputs[name] = value;
                    });

                    // Inclut le bouton submit s'il a un name/value
                    $form.find('button[type="submit"], button:not([type]), input[type="submit"]').each((_, btn) => {
                        const name = $(btn).attr('name');
                        const value = $(btn).attr('value');
                        if (name && value) inputs[name] = value;
                    });

                    // Verifie que c'est bien un formulaire OpenID
                    if (Object.keys(inputs).some(k => k.startsWith('openid.'))) {
                        formAction = action;
                        formInputs = inputs;
                    }
                });

                if (!formAction) {
                    // Pas de formulaire OpenID: verifie si c'est une page de connexion Steam
                    if (html.includes('Sign In') && (html.includes('steamLogin') || html.includes('loginForm'))) {
                        console.warn('[SCE-Auth] Session Steam expiree - impossible de se connecter a SCE automatiquement.');
                        console.warn('[SCE-Auth] Relancez: npm run login');
                        return null;
                    }
                    console.warn('[SCE-Auth] Page inattendue recue (pas de formulaire OpenID).');
                    console.warn(`[SCE-Auth] URL: ${url}`);
                    return null;
                }

                // Resout l'URL d'action
                let postUrl;
                if (!formAction || formAction === '') {
                    postUrl = url;
                } else if (formAction.startsWith('/')) {
                    postUrl = 'https://steamcommunity.com' + formAction;
                } else if (formAction.startsWith('http')) {
                    postUrl = formAction;
                } else {
                    postUrl = new URL(formAction, url).href;
                }

                console.log(`[SCE-Auth] Formulaire OpenID trouve: ${Object.keys(formInputs).length} champs`);

                // Soumet le formulaire (POST) avec multipart/form-data car le formulaire a enctype="multipart/form-data".
                // C'etait la cause de l'erreur "Invalid Params": le code envoyait en application/x-www-form-urlencoded
                // mais Steam attend du multipart/form-data (comme un vrai navigateur ferait avec cet enctype).
                const formData = new FormData();
                for (const [key, value] of Object.entries(formInputs)) {
                    formData.append(key, value);
                }
                // NOTE: donotcache n'est PAS ajoute aux champs du formulaire.
                resp = await fetch(postUrl, {
                    method: 'POST',
                    redirect: 'manual',
                    signal: AbortSignal.timeout(15000),
                    headers: {
                        'User-Agent': UA,
                        'Cookie': jar.getCookies(jar.getDomain(postUrl)),
                        'Referer': url,
                        'Origin': 'https://steamcommunity.com',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'same-origin',
                        'Sec-Fetch-User': '?1',
                        'Upgrade-Insecure-Requests': '1',
                        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                        'sec-ch-ua-mobile': '?0',
                        'sec-ch-ua-platform': '"Windows"',
                    },
                    body: formData,
                });
                jar.captureSetCookies(resp, jar.getDomain(postUrl));
                url = postUrl;

                // Si le POST retourne un 200 (pas un 302), verifie s'il y a une redirection JavaScript
                if (resp.status === 200) {
                    const postHtml = await resp.text();

                    // Cherche une redirection JavaScript vers SCE
                    const jsRedirect = postHtml.match(/window\.location\s*=\s*["']([^"']+)["']/i)
                        || postHtml.match(/window\.location\.href\s*=\s*["']([^"']+)["']/i)
                        || postHtml.match(/location\.replace\s*\(["']([^"']+)["']\)/i)
                        || postHtml.match(/window\.open\s*\(["']([^"']+)["']/i);
                    if (jsRedirect) {
                        const redirectUrl = jsRedirect[1];
                        console.log(`[SCE-Auth] Redirection JavaScript trouvee: ${redirectUrl.substring(0, 80)}...`);
                        const fullUrl = redirectUrl.startsWith('http')
                            ? redirectUrl
                            : new URL(redirectUrl, url).href;
                        const redirDomain = jar.getDomain(fullUrl);
                        resp = await fetch(fullUrl, {
                            redirect: 'manual',
                            signal: AbortSignal.timeout(15000),
                            headers: {
                                'User-Agent': UA,
                                'Cookie': jar.getCookies(redirDomain),
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                'Accept-Language': 'en-US,en;q=0.9',
                                'Sec-Fetch-Dest': 'document',
                                'Sec-Fetch-Mode': 'navigate',
                                'Sec-Fetch-Site': 'cross-site',
                                'Upgrade-Insecure-Requests': '1',
                                'Referer': url,
                                'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                                'sec-ch-ua-mobile': '?0',
                                'sec-ch-ua-platform': '"Windows"',
                            },
                        });
                        jar.captureSetCookies(resp, redirDomain);
                        url = fullUrl;
                        continue; // Suit la redirection
                    }

                    // Cherche un meta refresh
                    const metaRefresh = postHtml.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["']\d+;\s*url=([^"']+)['"]/i);
                    if (metaRefresh) {
                        const redirectUrl = metaRefresh[1];
                        console.log(`[SCE-Auth] Meta refresh trouve: ${redirectUrl.substring(0, 80)}...`);
                        const fullUrl = redirectUrl.startsWith('http')
                            ? redirectUrl
                            : new URL(redirectUrl, url).href;
                        const redirDomain = jar.getDomain(fullUrl);
                        resp = await fetch(fullUrl, {
                            redirect: 'manual',
                            signal: AbortSignal.timeout(15000),
                            headers: {
                                'User-Agent': UA,
                                'Cookie': jar.getCookies(redirDomain),
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                'Accept-Language': 'en-US,en;q=0.9',
                                'Sec-Fetch-Dest': 'document',
                                'Sec-Fetch-Mode': 'navigate',
                                'Sec-Fetch-Site': 'cross-site',
                                'Upgrade-Insecure-Requests': '1',
                                'Referer': url,
                                'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                                'sec-ch-ua-mobile': '?0',
                                'sec-ch-ua-platform': '"Windows"',
                            },
                        });
                        jar.captureSetCookies(resp, redirDomain);
                        url = fullUrl;
                        continue; // Suit la redirection
                    }

                    // Pas de redirection trouvee - le POST a echoue
                    console.warn('[SCE-Auth] Le POST n a pas genere de redirection.');
                    try {
                        const $err = cheerio.load(postHtml);
                        const errText = $err('.error_ctn').text().trim()
                            || $err('#errorText').text().trim()
                            || $err('#error_msg').text().trim()
                            || $err('.fatalerror').text().trim()
                            || $err('body').text().replace(/\s+/g, ' ').trim().substring(0, 300);
                        console.warn('[SCE-Auth] Message d erreur Steam:', errText);
                    } catch(e) {
                        console.warn('[SCE-Auth] Impossible de parser la page d erreur.');
                    }
                    return null;
                }

                // La reponse devrait etre une 302 vers SCE
                // Continue la boucle pour suivre cette redirection
                continue;
            }

            console.warn(`[SCE-Auth] Statut inattendu: ${resp.status} pour ${url}`);
            return null;
        }

        console.warn('[SCE-Auth] Trop de redirections dans le flux OpenID.');
        return null;
    } catch (e) {
        console.warn(`[SCE-Auth] Erreur lors du login OpenID: ${e.message}`);
        return null;
    }
}
