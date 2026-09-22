import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

export const ES_log = (...args) => console.log('%c[DEBUG]', 'color: #11ad11; font-weight: bold;', ...args);

export const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || '4', 10);
export const INVENTORY_PAGE_DELAY = parseInt(process.env.INVENTORY_PAGE_DELAY || '800', 10);

export const STEAM_PROFILE_PATH = process.env.STEAM_PROFILE_PATH || 'my';

// AppIDs d'evenements Steam (Sales, Awards, etc.) - a definir dans .env, separes par des virgules
export const EVENT_APP_IDS = new Set(
    (process.env.EVENT_APP_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
);
export const SCE_COOKIE = process.env.SCE_COOKIE || '';
export const TRADE_PARTNER = process.env.TRADE_PARTNER || '83905207';
export const TRADE_TOKEN = process.env.TRADE_TOKEN || 'tEx7-bXd';

// Cookie Steam dynamique: sera defini par auth.js au demarrage
// Si STEAM_COOKIE est defini dans .env, on l'utilise directement
let _steamCookie = process.env.STEAM_COOKIE || '';
export function getSteamCookie() { return _steamCookie; }
export function setSteamCookie(cookie) { _steamCookie = cookie; }

// Profile path dynamique: 'my' par defaut, mais sera defini sur 'profiles/SteamID' apres auth
let _steamProfilePath = process.env.STEAM_PROFILE_PATH || 'my';
export function getSteamProfilePath() { return _steamProfilePath; }
export function setSteamProfilePath(path) { _steamProfilePath = path; }

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Extrait le SteamID depuis la chaine de cookies Steam
 * Le cookie steamRefresh_steam ou steamLoginSecure contient le SteamID au debut:
 * steamRefresh_steam=76561198306463046%7C%7C... ou steamLoginSecure=76561198306463046||...
 * @param {string} cookieStr
 * @returns {string|null}
 */
export function extractSteamIdFromCookies(cookieStr) {
    if (!cookieStr) return null;
    const match = cookieStr.match(/(?:steamRefresh_steam|steamLoginSecure)=(\d+)(?:%7C%7C|\|\|)/);
    return match ? match[1] : null;
}

/**
 * Extrait la valeur du sessionid depuis la chaine de cookies
 * @param {string} cookieStr
 * @returns {string|null}
 */
export function extractSessionIdFromCookies(cookieStr) {
    if (!cookieStr) return null;
    const match = cookieStr.match(/sessionid=([^;]+)/);
    return match ? match[1] : null;
}

/**
 * Redacte la cle API dans une URL ou un message d erreur pour eviter toute fuite.
 * @param {string} str - URL ou message contenant potentiellement key=...
 * @returns {string}
 */
export function redactSensitiveUrl(str) {
    return String(str).replace(/([?&]key=)[^&\s]+/gi, '$1***');
}

/**
 * Effectue une requete HTTP avec gestion des cookies et retries
 * Utilise redirect: 'follow' — les cookies sont envoyes via le header Cookie.
 * Pour eviter les problemes de cookies perdus sur redirect, le profil
 * est defini directement sur profiles/SteamID (pas de redirect /my/).
 */
export async function httpGet(url, { cookies = '', retries = 3, accept = 'text/html', extraHeaders = {} } = {}) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': accept,
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        ...extraHeaders,
    };
    if (cookies) {
        headers['Cookie'] = cookies;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, { headers, redirect: 'follow' });

            if (!response.ok) {
                if (attempt < retries && [429, 500, 502, 503].includes(response.status)) {
                    // 429 = rate limit Steam: backoff long (30s, 60s, 120s)
                    // 500/502/503 = erreur serveur: backoff court (3s, 6s, 9s)
                    const backoff = response.status === 429
                        ? 30000 * Math.pow(2, attempt)
                        : 3000 * (attempt + 1);
                    if (response.status === 429) {
                        console.warn(`[httpGet] Rate limit 429 - attente ${backoff / 1000}s avant retry...`);
                    }
                    await sleep(backoff);
                    continue;
                }
                throw new Error(`HTTP ${response.status} pour ${redactSensitiveUrl(url)}`);
            }
            const text = await response.text();
            // Debug: si la reponse est du HTML et qu'on attendait du JSON, log le debut
            if (accept.includes('application/json') && (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html'))) {
                console.error(`[httpGet] HTML recu au lieu de JSON pour ${redactSensitiveUrl(url)}`);
                // Affiche TOUS les noms de cookies envoyes
                const cookieNames = (cookies || '').split(';').map(c => c.split('=')[0].trim()).filter(Boolean);
                console.error(`[httpGet] Cookies envoyes (${cookieNames.length}): ${cookieNames.join(', ')}`);
                console.error(`[httpGet] Status: ${response.status}, URL finale: ${redactSensitiveUrl(response.url)}`);
                // Affiche le debut du HTML pour identifier la page (login, erreur, etc.)
                const titleMatch = text.match(/<title>(.*?)<\/title>/i);
                if (titleMatch) console.error(`[httpGet] Titre de la page: ${titleMatch[1]}`);
            }
            return text;
        } catch (err) {
            if (attempt < retries) {
                await sleep(3000);
                continue;
            }
            throw err;
        }
    }
}

/**
 * Effectue une requete HTTP qui retourne du JSON
 */
export async function httpGetJSON(url, { cookies = '', retries = 3, extraHeaders = {} } = {}) {
    const text = await httpGet(url, { cookies, retries, accept: 'application/json', extraHeaders });
    return JSON.parse(text);
}

/**
 * Nettoie et normalise une chaine (nom de jeu, carte ou ID)
 * @param {string} str - La chaine a nettoyer
 * @param {boolean} fullNormalize - Si vrai, applique la mise en minuscule et retrait ponctuation
 */
export function clean(str, fullNormalize = false) {
    if (!str) return '';
    let cleaned = str.toLowerCase().replace(/[\n\t\r]/g, '').replace(/\s{2,}/g, ' ').trim();
    if (fullNormalize) {
        return cleaned
            .replace(/^badge\s+/i, '')
            .replace(/\(trading card\)$/i, '')
            .replace(/['":!?,.()]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }
    return cleaned;
}

const EVENT_PATTERN = /Sale 20\d{2}|Soldes d'été|Soldes d'hiver|Les Steam Awards|Holiday Sale/i;

/**
 * Verifie si un badge appartient a la categorie "Evenements Steam"
 */
export function isSteamEvent(appId, gameName) {
    if (EVENT_APP_IDS.has(String(appId))) return true;
    if (gameName && EVENT_PATTERN.test(gameName)) return true;
    return false;
}

/**
 * Parse une date Steam francaise en timestamp
 */
export function parseSteamDateToMs(dateStr) {
    if (!dateStr) return 0;
    let f = dateStr.toLowerCase();
    const months = {
        'janv.': 'Jan', 'févr.': 'Feb', 'mars': 'Mar', 'avr.': 'Apr',
        'mai': 'May', 'juin': 'Jun', 'juil.': 'Jul', 'août': 'Aug',
        'sept.': 'Sep', 'oct.': 'Oct', 'nov.': 'Nov', 'déc.': 'Dec'
    };
    for (const [fr, en] of Object.entries(months)) {
        f = f.replace(fr, en);
    }
    f = f.replace(/h/g, ':');
    const timestamp = new Date(f).getTime();
    return isNaN(timestamp) ? 0 : timestamp;
}
