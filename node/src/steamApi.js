/**
 * steamApi.js — Client Steam Web API officiel avec rate limiting
 *
 * Implémente les endpoints officiels de la Steam Web API:
 *   - IEconService/GetTradeHistory/v1  — historique des trades
 *   - ISteamEconomy/GetAssetPrices/v1  — prix des assets d'une app economy
 *   - IInventoryService/GetInventory/v1 — inventaire d'un utilisateur
 *
 * Authentification:
 *   - Clé API Steam (STEAM_API_KEY) obtenue sur https://steamcommunity.com/dev/apikey
 *   - GetTradeHistory et GetAssetPrices fonctionnent avec la clé utilisateur
 *   - GetInventory nécessite une clé publisher Steamworks (Economy permissions)
 *     → fallback automatique vers l'endpoint communautaire (steamLoginSecure cookies)
 *
 * Rate limiting:
 *   - 1 requête/seconde (1000ms minimum entre chaque requête)
 *   - 100 000 requêtes/jour (compteur journalier, réinitialisé à minuit UTC)
 *   - Le débit de 1 req/s est le plus restrictif (86 400 req/jour max théorique),
 *     mais on garde aussi la limite journalière de 100 000 par sécurité.
 *
 * Intégration:
 *   - Utilise httpGet depuis utils.js pour les requêtes HTTP
 *   - Utilise getSteamCookie() pour le fallback communautaire de GetInventory
 *   - Peut être utilisé par steam.js, market.js, marketQueue.js
 */

import { httpGet, httpGetJSON, getSteamCookie, getSteamProfilePath, extractSteamIdFromCookies, ES_log } from './utils.js';
import * as cheerio from 'cheerio';

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

// Clé API: variable d environnement ou fetch automatique depuis steamcommunity.com/dev/apikey
let _steamApiKey = process.env.STEAM_API_KEY || '';
let _apiKeyFetched = false;

const STEAM_API_BASE = 'https://api.steampowered.com';
const STEAM_PARTNER_API_BASE = 'https://partner.steam-api.com';
const STEAM_COMMUNITY_BASE = 'https://steamcommunity.com';

/**
 * Récupère la clé API Steam depuis la page /dev/apikey en utilisant les cookies Steam.
 *
 * Quand l utilisateur est authentifié (cookies steamLoginSecure valides), la page
 * https://steamcommunity.com/dev/apikey affiche la clé directement dans le HTML.
 * La structure est:
 *   <div id="bodyContents_ex">
 *     <h2>Your Steam Web API Key</h2>
 *     <p>Key: XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX</p>
 *   </div>
 *
 * Si l utilisateur n a pas encore de clé, la page affiche un formulaire d enregistrement.
 * Dans ce cas, on ne peut pas créer la clé automatiquement (il faut accepter les ToU).
 *
 * @returns {Promise<string|null>} La clé API ou null si indisponible
 */
export async function fetchApiKeyFromSteam() {
    const cookie = getSteamCookie();
    if (!cookie) {
        ES_log('[SteamApi] fetchApiKeyFromSteam: pas de cookie Steam configure.');
        return null;
    }

    ES_log('[SteamApi] Recuperation automatique de la cle API depuis /dev/apikey...');

    try {
        const html = await httpGet('https://steamcommunity.com/dev/apikey', {
            cookies: cookie,
            accept: 'text/html',
            retries: 2,
        });

        // Vérifier qu on n a pas été redirigé vers la page de login
        if (html.includes('Sign In') && html.includes('steamLogin') && !html.includes('bodyContents_ex')) {
            ES_log('[SteamApi] fetchApiKeyFromSteam: cookies invalides (page de login).');
            return null;
        }

        // Parser le HTML avec cheerio
        const $ = cheerio.load(html);

        // La clé est dans #bodyContents_ex > p, format: "Key: XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        // On cherche aussi dans tout le HTML une clé de 32 caractères hexadécimaux
        const bodyContents = $('#bodyContents_ex');
        if (bodyContents.length > 0) {
            const h2Text = bodyContents.find('h2').text().trim();
            if (h2Text.includes('Your Steam Web API Key')) {
                // La clé est dans le <p> suivant le <h2>
                const pText = bodyContents.find('p').text().trim();
                // Format: "Key: XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                const keyMatch = pText.match(/Key:\s*([A-F0-9]{32})/i);
                if (keyMatch) {
                    _steamApiKey = keyMatch[1];
                    _apiKeyFetched = true;
                    ES_log(`[SteamApi] Cle API recuperee automatiquement (${_steamApiKey.substring(0, 8)}...).`);
                    return _steamApiKey;
                }
                // Fallback: chercher 32 caractères hex dans tout le bodyContents
                const anyKeyMatch = pText.match(/([A-F0-9]{32})/i);
                if (anyKeyMatch) {
                    _steamApiKey = anyKeyMatch[1];
                    _apiKeyFetched = true;
                    ES_log(`[SteamApi] Cle API recuperee (fallback regex, ${_steamApiKey.substring(0, 8)}...).`);
                    return _steamApiKey;
                }
            }
        }

        // Dernier fallback: chercher une clé de 32 hex dans tout le HTML
        // (la structure de la page peut varier selon les mises à jour Steam)
        const globalMatch = html.match(/\b([A-F0-9]{32})\b/);
        if (globalMatch) {
            _steamApiKey = globalMatch[1];
            _apiKeyFetched = true;
            ES_log(`[SteamApi] Cle API recuperee (scan global HTML, ${_steamApiKey.substring(0, 8)}...).`);
            return _steamApiKey;
        }

        // Si on arrive ici, l utilisateur n a probablement pas de clé enregistrée
        ES_log('[SteamApi] fetchApiKeyFromSteam: aucune cle trouvee sur la page. L utilisateur doit en creer une sur https://steamcommunity.com/dev/apikey');
        return null;
    } catch (err) {
        ES_log(`[SteamApi] fetchApiKeyFromSteam: erreur: ${err.message}`);
        return null;
    }
}

/**
 * Retourne la clé API Steam courante.
 *
 * Ordre de résolution:
 *   1. Variable d environnement STEAM_API_KEY (si définie)
 *   2. Clé récupérée automatiquement via fetchApiKeyFromSteam() (si déjà fetchée)
 *   3. null (doit appeler fetchApiKeyFromSteam() pour tenter le fetch)
 *
 * @returns {string|null}
 */
function getSteamApiKey() {
    return _steamApiKey || null;
}

/**
 * Initialise la clé API Steam.
 *
 * Si STEAM_API_KEY est défini dans .env, l utilise directement.
 * Sinon, tente de récupérer la clé depuis steamcommunity.com/dev/apikey
 * en utilisant les cookies Steam de l utilisateur authentifié.
 *
 * À appeler après l authentification Steam (auth.js).
 *
 * @returns {Promise<string|null>} La clé API ou null si indisponible
 */
export async function initSteamApiKey() {
    if (process.env.STEAM_API_KEY) {
        _steamApiKey = process.env.STEAM_API_KEY;
        _apiKeyFetched = true;
        ES_log('[SteamApi] STEAM_API_KEY trouvee dans .env.');
        return _steamApiKey;
    }

    if (_apiKeyFetched) {
        return _steamApiKey || null;
    }

    // Tenter le fetch automatique
    const key = await fetchApiKeyFromSteam();
    _apiKeyFetched = true;
    if (key) {
        ES_log('[SteamApi] Cle API initialisee via fetch automatique.');
    } else {
        ES_log('[SteamApi] Aucune cle API disponible. Les endpoints officiels seront desactives (fallback vers les endpoints communautaires).');
    }
    return key;
}

// Rate limit: 1 requête/seconde et 100 000 requêtes/jour
const RATE_LIMIT_MIN_INTERVAL_MS = 1000;  // 1 req/s
const RATE_LIMIT_DAILY_MAX = 100000;      // 100 000 req/jour

// ═══════════════════════════════════════════════════════════════
// Rate limiter global
// ═══════════════════════════════════════════════════════════════

class SteamRateLimiter {
    constructor() {
        this.minIntervalMs = RATE_LIMIT_MIN_INTERVAL_MS;
        this.dailyMax = RATE_LIMIT_DAILY_MAX;
        this.lastRequestTime = 0;
        this.dailyCount = 0;
        this.dailyResetDate = this._todayUTC();
        this.queue = Promise.resolve();
    }

    /**
     * Retourne la date du jour au format YYYY-MM-DD (UTC)
     */
    _todayUTC() {
        return new Date().toISOString().slice(0, 10);
    }

    /**
     * Vérifie et réinitialise le compteur journalier si on a changé de jour.
     */
    _checkDailyReset() {
        const today = this._todayUTC();
        if (today !== this.dailyResetDate) {
            this.dailyResetDate = today;
            this.dailyCount = 0;
            ES_log(`[SteamRateLimiter] Nouveau jour UTC (${today}), compteur journalier réinitialisé.`);
        }
    }

    /**
     * Vérifie si on a encore des requêtes disponibles aujourd'hui.
     */
    get remainingToday() {
        this._checkDailyReset();
        return Math.max(0, this.dailyMax - this.dailyCount);
    }

    /**
     * Retourne les statistiques du rate limiter.
     */
    getStats() {
        this._checkDailyReset();
        return {
            dailyCount: this.dailyCount,
            dailyMax: this.dailyMax,
            remainingToday: this.remainingToday,
            minIntervalMs: this.minIntervalMs,
            resetDate: this.dailyResetDate,
        };
    }

    /**
     * Attend que le rate limit autorise une nouvelle requête.
     * Utilise une file d'attente (promise chaining) pour garantir
     * l'espacement minimum entre les requêtes, même en parallèle.
     */
    async _acquire() {
        this._checkDailyReset();

        if (this.dailyCount >= this.dailyMax) {
            throw new Error(
                `[SteamRateLimiter] Limite journalière atteinte (${this.dailyMax} requêtes/jour). ` +
                `Réessayez après minuit UTC.`
            );
        }

        // File d'attente: chaque requête attend que la précédente soit espacée
        const prev = this.queue;
        let resolveQueue;
        this.queue = new Promise(r => { resolveQueue = r; });

        await prev;

        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        const wait = Math.max(0, this.minIntervalMs - elapsed);
        if (wait > 0) {
            await new Promise(r => setTimeout(r, wait));
        }

        this.lastRequestTime = Date.now();
        this.dailyCount++;

        resolveQueue();
    }
}

const rateLimiter = new SteamRateLimiter();

/**
 * Retourne les statistiques du rate limiter (pour monitoring/debug).
 */
export function getRateLimiterStats() {
    return rateLimiter.getStats();
}

// ═══════════════════════════════════════════════════════════════
// Client Steam Web API
// ═══════════════════════════════════════════════════════════════

/**
 * Vérifie que la clé API Steam est disponible (env ou fetch automatique).
 * @returns {boolean}
 */
export function hasSteamApiKey() {
    return !!getSteamApiKey();
}

/**
 * Effectue une requête vers la Steam Web API officielle.
 *
 * Construit l'URL: {base}/{interface}/{method}/{version}/?key=...&format=json&{params}
 * Passe par le rate limiter (1 req/s, 100 000/jour).
 *
 * @param {string} interfaceName - Ex: "IEconService", "ISteamEconomy", "IInventoryService"
 * @param {string} methodName - Ex: "GetTradeHistory", "GetAssetPrices", "GetInventory"
 * @param {string|number} version - Ex: 1 ou "v1"
 * @param {object} params - Paramètres supplémentaires de la requête
 * @param {object} options - Options: { usePartnerBase?: boolean, retries?: number }
 * @returns {Promise<object>} La réponse JSON parsée
 */
export async function steamApiFetch(interfaceName, methodName, version = 1, params = {}, options = {}) {
    const apiKey = getSteamApiKey();
    if (!apiKey) {
        throw new Error(
            `[SteamApi] Aucune cle API Steam disponible. ` +
            `Definissez STEAM_API_KEY dans .env ou assurez-vous d etre authentifie ` +
            `(la cle sera recuperee automatiquement depuis https://steamcommunity.com/dev/apikey)`
        );
    }

    // Le rate limiter espacent les requêtes
    await rateLimiter._acquire();

    const base = options.usePartnerBase ? STEAM_PARTNER_API_BASE : STEAM_API_BASE;
    const versionStr = String(version).startsWith('v') ? version : `v${version}`;

    const url = new URL(`${base}/${interfaceName}/${methodName}/${versionStr}/`);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('format', 'json');
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
            url.searchParams.set(key, String(value));
        }
    }

    const finalUrl = url.toString();
    ES_log(`[SteamApi] GET ${interfaceName}/${methodName}/${versionStr} (req #${rateLimiter.dailyCount}/${rateLimiter.dailyMax} aujourd'hui)`);

    let text;
    try {
        text = await httpGet(finalUrl, {
            accept: 'application/json',
            retries: options.retries ?? 3,
            extraHeaders: { 'Referer': 'https://steamcommunity.com/' },
        });
    } catch (err) {
        // Redacter la cle API dans les messages d erreur pour eviter toute fuite
        const redacted = err.message.replace(/key=[A-F0-9]{32}/gi, 'key=***');
        throw new Error(redacted);
    }

    // Vérifier qu'on a du JSON valide
    if (text.trim().startsWith('<')) {
        // Redacter la cle dans l URL
        const safeUrl = finalUrl.replace(/key=[A-F0-9]{32}/gi, 'key=***');
        throw new Error(`[SteamApi] Réponse HTML reçue au lieu de JSON pour ${safeUrl}`);
    }

    const data = JSON.parse(text);

    // La plupart des endpoints Steam retournent { response: { ... } }
    return data;
}

// ═══════════════════════════════════════════════════════════════
// GetTradeHistory — IEconService/GetTradeHistory/v1
// ═══════════════════════════════════════════════════════════════

/**
 * Récupère l'historique des trades du compte associé à la clé API.
 *
 * Endpoint officiel: GET https://api.steampowered.com/IEconService/GetTradeHistory/v1/
 * Documentation: https://partner.steamgames.com/doc/webapi/ieconservice
 *
 * Remplace le scraping HTML de syncSteamInventoryHistory() dans steam.js.
 * L'API retourne des données structurées JSON au lieu de HTML à parser.
 *
 * @param {object} options - Options de pagination
 * @param {number} options.max_trades - Nombre de trades à retourner (max 500 sans descriptions, 100 avec)
 * @param {number} [options.start_after_time] - Timestamp du dernier trade de la page précédente
 * @param {string} [options.start_after_tradeid] - Trade ID du dernier trade de la page précédente
 * @param {boolean} [options.navigating_back] - Naviguer vers l'arrière (true) ou vers l'avant (false)
 * @param {boolean} [options.get_descriptions] - Inclure les descriptions des items (défaut: true)
 * @param {string} [options.language] - Langue des descriptions (défaut: "english")
 * @param {boolean} [options.include_failed] - Inclure les trades échoués (défaut: true)
 * @param {boolean} [options.include_total] - Inclure le nombre total de trades (défaut: false)
 * @returns {Promise<object>} - { response: { trades, descriptions?, total_trades?, more? } }
 */
export async function getTradeHistory(options = {}) {
    const params = {
        max_trades: options.max_trades ?? 100,
        get_descriptions: options.get_descriptions !== false ? 1 : 0,
        language: options.language ?? 'english',
        include_failed: options.include_failed !== false ? 1 : 0,
        include_total: options.include_total ? 1 : 0,
    };

    // Parametres de pagination: seulement si fournis
    if (options.start_after_time !== undefined && options.start_after_time !== null) {
        params.start_after_time = options.start_after_time;
    }
    if (options.start_after_tradeid !== undefined && options.start_after_tradeid !== null && options.start_after_tradeid !== '') {
        params.start_after_tradeid = options.start_after_tradeid;
    }
    if (options.navigating_back !== undefined) {
        params.navigating_back = options.navigating_back ? 1 : 0;
    }

    ES_log(`[SteamApi] getTradeHistory(max_trades=${params.max_trades})`);

    return steamApiFetch('IEconService', 'GetTradeHistory', 1, params);
}

// ═══════════════════════════════════════════════════════════════
// GetAssetPrices — ISteamEconomy/GetAssetPrices/v1
// ═══════════════════════════════════════════════════════════════

/**
 * Récupère les prix des assets d'une application Steam Economy.
 *
 * Endpoint officiel: GET https://api.steampowered.com/ISteamEconomy/GetAssetPrices/v1/
 * Documentation: https://partner.steamgames.com/doc/webapi/isteameconomy
 *
 * Note: L'appid doit être une "steam economy app" (ex: 440 pour TF2, 570 pour Dota 2).
 * Pour les cartes Steam Community (appid 753), cet endpoint peut ne pas retourner
 * de données utiles car 753 n'est pas une steam economy app traditionnelle.
 * Dans ce cas, le projet utilise déjà les endpoints communautaires (priceoverview, etc.).
 *
 * @param {number} appid - L'ID de l'application (doit être une steam economy app)
 * @param {object} [options]
 * @param {string} [options.currency] - Code devise (ex: "EUR")
 * @param {string} [options.language] - Langue (ex: "english")
 * @returns {Promise<object>} - { result: { success, assets, prices? } }
 */
export async function getAssetPrices(appid, options = {}) {
    const params = {
        appid: appid,
        currency: options.currency,
        language: options.language ?? 'english',
    };

    ES_log(`[SteamApi] getAssetPrices(appid=${appid})`);

    return steamApiFetch('ISteamEconomy', 'GetAssetPrices', 1, params);
}

// ═══════════════════════════════════════════════════════════════
// GetInventory — IInventoryService/GetInventory/v1
// ═══════════════════════════════════════════════════════════════

/**
 * Récupère l'inventaire d'un utilisateur via l'API officielle.
 *
 * Endpoint officiel: GET https://partner.steam-api.com/IInventoryService/GetInventory/v1/
 * Documentation: https://partner.steamgames.com/doc/webapi/IInventoryService
 *
 * ATTENTION: Cet endpoint nécessite une clé publisher Steamworks (Economy permissions),
 * PAS la clé utilisateur de steamcommunity.com/dev/apikey.
 * Si la clé est une clé utilisateur, l'API retournera une erreur 403/Access Denied.
 * Dans ce cas, on fallback automatiquement vers l'endpoint communautaire.
 *
 * @param {string} steamid - SteamID64 de l'utilisateur
 * @param {number} appid - ID de l'application
 * @param {object} [options]
 * @param {boolean} [options.fallbackToCommunity] - Fallback vers l'endpoint communautaire (défaut: true)
 * @returns {Promise<object|null>} - Inventaire au format { assets, descriptions } ou null
 */
export async function getInventory(steamid, appid, options = {}) {
    const fallbackToCommunity = options.fallbackToCommunity !== false;
    const contextid = options.contextid ?? 6; // 6 = Steam Community items par défaut

    // Essayer l'API officielle d'abord
    try {
        const params = {
            appid: appid,
            steamid: steamid,
        };

        ES_log(`[SteamApi] getInventory(steamid=${steamid}, appid=${appid})`);

        const result = await steamApiFetch('IInventoryService', 'GetInventory', 1, params, {
            usePartnerBase: true,
            retries: 1, // Moins de retries pour le fallback rapide
        });

        if (result && result.response && result.response.assets) {
            ES_log(`[SteamApi] getInventory: ${result.response.assets.length} assets récupérés via API officielle.`);
            return {
                assets: result.response.assets,
                descriptions: result.response.descriptions || [],
                source: 'official_api',
            };
        }

        ES_log(`[SteamApi] getInventory: réponse vide de l'API officielle.`);
    } catch (err) {
        ES_log(`[SteamApi] getInventory: échec API officielle: ${err.message}`);

        // Détecter les erreurs indiquant que la clé n'est pas publisher
        if (err.message.includes('403') || err.message.includes('Access Denied') || err.message.includes('Access is denied')) {
            ES_log(`[SteamApi] getInventory: clé utilisateur détectée (pas publisher). Fallback vers l'endpoint communautaire.`);
        } else if (!fallbackToCommunity) {
            throw err;
        }
    }

    // Fallback: endpoint communautaire (requiert steamLoginSecure cookies)
    if (fallbackToCommunity) {
        ES_log(`[SteamApi] getInventory: fallback vers l'endpoint communautaire.`);
        return getInventoryCommunity(steamid, appid, contextid);
    }

    return null;
}

/**
 * Récupère l'inventaire via l'endpoint communautaire non officiel.
 * URL: https://steamcommunity.com/inventory/{steamid}/{appid}/{contextid}
 * Requiert les cookies steamLoginSecure.
 *
 * @param {string} steamid - SteamID64
 * @param {number} appid - ID de l'application
 * @param {number} contextid - Context ID (6 pour Steam Community)
 * @returns {Promise<object|null>}
 */
async function getInventoryCommunity(steamid, appid, contextid) {
    const cookie = getSteamCookie();
    if (!cookie) {
        console.error('[SteamApi] getInventoryCommunity: pas de cookie Steam configuré.');
        return null;
    }

    const STEAM_AJAX_HEADERS = {
        'Referer': 'https://steamcommunity.com/',
        'X-Requested-With': 'XMLHttpRequest',
    };

    let allAssets = [];
    let allDescriptions = [];
    let nextStart = null;
    let hasMore = true;

    while (hasMore) {
        let url = `${STEAM_COMMUNITY_BASE}/inventory/${steamid}/${appid}/${contextid}/?l=english&count=2000`;
        if (nextStart) {
            url += `&start_assetid=${nextStart}`;
        }

        try {
            const data = await httpGetJSON(url, {
                cookies: cookie,
                extraHeaders: STEAM_AJAX_HEADERS,
            });

            if (data && data.success && data.assets) {
                allAssets = allAssets.concat(data.assets);
                if (data.descriptions) {
                    allDescriptions = allDescriptions.concat(data.descriptions);
                }

                if (data.more_assets === true && data.last_assetid) {
                    nextStart = data.last_assetid;
                } else {
                    hasMore = false;
                }
            } else {
                hasMore = false;
            }
        } catch (err) {
            console.error(`[SteamApi] getInventoryCommunity: erreur: ${err.message}`);
            hasMore = false;
        }
    }

    if (allAssets.length > 0) {
        ES_log(`[SteamApi] getInventoryCommunity: ${allAssets.length} assets récupérés.`);
        return {
            assets: allAssets,
            descriptions: allDescriptions,
            source: 'community_endpoint',
        };
    }

    console.error('[SteamApi] getInventoryCommunity: impossible de charger l\'inventaire.');
    return null;
}

// ═══════════════════════════════════════════════════════════════
// Helper: extraire le SteamID depuis les cookies
// ═══════════════════════════════════════════════════════════════

/**
 * Retourne le SteamID64 associé à la session Steam actuelle.
 * Utilise d'abord la clé API si disponible, puis les cookies.
 * @returns {string|null}
 */
export function getCurrentSteamId() {
    const cookie = getSteamCookie();
    if (cookie) {
        const steamId = extractSteamIdFromCookies(cookie);
        if (steamId) return steamId;
    }
    return null;
}

// Export du rate limiter pour usage externe (monitoring)
export { rateLimiter, SteamRateLimiter };
