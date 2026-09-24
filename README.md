# Steam-SCE Scraper

Conversion en Node.js du script Tampermonkey "Steam-Gamecards-SCE" avec base de donnees SQLite et front-end PHP pour l'affichage du rapport.

## Architecture

```
steam-sce/
├── node/                  # Backend Node.js (scraper)
│   ├── .env.example       # Configuration (cookies, chemin DB)
│   ├── package.json
│   └── src/
│       ├── db.js          # Couche SQLite (schema, CRUD)
│       ├── utils.js       # Utilitaires (HTTP, clean, isSteamEvent, etc.)
│       ├── steam.js       # Scraping Steam (badges, inventaire, historique trades)
│       ├── sce.js         # Scraping Steam Card Exchange (prix, stock, credits, refresh periodique)
│       ├── market.js       # Prix marché Steam (orderbook, pricehistory, listing page, buy orders)
│       ├── marketQueue.js # Worker temps réel (token bucket, file prioritaire, stale-while-revalidate)
│       ├── analyze.js     # Analyse des badges (completion, couts, cartes cheres)
│       ├── api.js        # Serveur API REST (lecture seule de la DB)
│       ├── sync.js        # Orchestration (workflow, queue, concurrence)
│       └── index.js       # Point d'entree (CLI)
├── php/                   # Frontend PHP (rapport HTML)
│   ├── config.php         # Configuration (chemin DB, trade partner)
│   ├── db.php             # Connexion SQLite (lecture seule)
│   ├── index.php          # Page du rapport
│   └── style.css          # Styles (theme Steam)
├── tampermonkey/          # Script Tampermonkey (UI Steam + fetch SCE fallback)
│   └── Steam-Gamecards-SCE-based-on-trade-history-5.2.user.js
├── data/                  # Base SQLite (generee automatiquement)
└── README.md
```

## Pre-requis

- **Node.js** >= 22.5 (utilise `fetch` natif et `node:sqlite`)
- **PHP** >= 8.0 avec extension SQLite3
- **npm** pour installer les dependances

## Installation

### 1. Backend Node.js

```bash
cd steam-sce/node
cp .env.example .env
npm install
```

### 2. Configuration des cookies

Editez le fichier `.env` et renseignez vos cookies de session :

- **STEAM_COOKIE** : Cookie de session Steam (format header complet, ex: `steamLoginSecure=...; sessionid=...`)
  - DevTools > Application > Cookies > steamcommunity.com
- **SCE_COOKIE** : Cookie de session SCE (format header complet, ex: `PHPSESSID=...; cookie_consent=1`)
  - DevTools > Application > Cookies > steamcardexchange.net
- **STEAM_PROFILE_PATH** : Chemin du profil Steam (`my`, `profiles/<SteamID64>`, ou `id/<vanity>`)
- **SCE_USD_TO_EUR** (optionnel) : Taux de change USD->EUR fixe pour la conversion des prix de la gamepage SCE (par defaut : taux BCE via frankfurter.app, mis en cache 24h, fallback 0.92)
- **EVENT_APP_IDS** : AppIDs des evenements Steam (Sales, Awards, etc.), separes par des virgules (ex: `335590,866860,1797760`). Utilises par `isSteamEvent()` pour classer les badges d'evenements. A completer au fil des nouveaux evenements Steam.

### 3. Initialisation de la base

```bash
npm run init-db
```

## Utilisation

### Lancer le mode daemon (defaut)

```bash
npm run sync
```

Ce mode :
1. Si la BD est vide : lance le scan complet (badges toutes pages + cartes + SCE, voir [Synchronisation en 2 phases](#synchronisation-des-badges-2-phases))
2. Si la BD est remplie : passe directement en mode surveillance (un scan complet part dès le premier cycle)
3. En mode surveillance :
   - `syncSteamInventoryHistory` toutes les **5 minutes** (les badges differes par le bot SCE sont retentes a chaque cycle, avec re-scan cible des jeux touches par des trades)
   - scan complet des badges (toutes les pages, phases 1 + 2, comme `npm run sync:badges`) toutes les **15 minutes** - le re-scan cible est skippe sur ces cycles car le scan complet couvre deja ces appids. Lors de ce scan, l'option `refetchCrafted` est activee : les badges deja craftes (`badge_crafted = 1`) sont re-verifies systematiquement (voir [Caches anti rate-limit](#caches-anti-rate-limit-steam))

### Scanner un appid specifique

```bash
npm run sync:gamecards 485450
```

### Synchroniser uniquement l'historique des trades

```bash
npm run sync:history
```

### Synchroniser une seule fois (sans boucle)

```bash
npm run -- --sync-once
```

### Re-scanner tous les badges connus

```bash
npm run -- --scan-all
```

### Voir le statut des badges en base

```bash
npm run -- --status
```

### Purger le cache

```bash
npm run -- --purge
```

## Synchronisation des badges (2 phases)

Le scan des badges (`npm run sync:badges`, scan initial du daemon) fonctionne en 2 phases. Les re-scans (`--scan-all`) retraitent les appids deja connus via le meme pipeline.

### Phase 1 - Inventaire SCE (`fetchSCEInventory`)

- Parcourt **toutes les pages de badges** du profil (`?p=1`, `?p=2`, ...) : le nombre de pages est detecte automatiquement (liens de pagination + "Showing X-Y of Z badges"). Le resultat est mis en cache 1h (voir [Caches anti rate-limit](#caches-anti-rate-limit-steam))
- Pour chaque appid : `fetchSteamData` (cartes du set + inventaire, reutilise la DB si fetchee il y a moins de 30 min) puis `fetchSCEFresh` (sce_stock, sce_price, sce_worth, sce_quick_trade, cartes possedees / manquantes / doublons)
- Les prix USD des cartes sont extraits de la gamepage SCE (section "Trading Cards" uniquement) : stockes dans `sce_market_price_usd`, convertis en EUR et stockes dans `steam_market_price_eur`
- S'execute en **4 taches paralleles** si le `waitTime` SCE est < 1 minute, sinon sequentiellement (1 tache)

Si le bot SCE est sature (`waitTime` > 1 min ET `pendingOffers` > 10), `fetchSCEFresh` retourne null : le badge est differe (meta `sceDeferredAppids`) et retente au prochain cycle de 5 minutes du daemon.

### Phase 2 - Prix marche (`fetchMarketPricesV2`)

Executee **apres** la phase 1, uniquement sur les appids mis a jour avec succes en DB (`dbReadyAppids`) - les appids deferes par le bot SCE n'y passent qu'apres un cycle de retry reussi -, sequentiellement (appid par appid) :

1. `fetchMarketPricesV2` (market.js) affine `steam_market_price_eur` avec le prix reel du marche (derniere vente < 7j, sinon buy order) - la valeur EUR posee par la phase 1 est preservee si le marche n'a pas de prix. **Limite 24h** : une carte dont le prix a ete fetche il y a moins de 24h (`cards.steam_market_fetched_at`) est ignoree, aucune requete n'est faite (voir [Limite 24h des prix marche](#limite-24h-des-prix-marche))
2. `analyzeBadgeStatus` recalcule les indicateurs de completion

## Limite 24h des prix marche

Un prix marche n'est **jamais re-fetché avant 24h** (`MARKET_PRICE_REFRESH_MS` dans market.js), quel que soit le chemin :

- `fetchMarketPricesV2` (phase 2 des scans) ignore les cartes fraiches (< 24h)
- le worker marketQueue passe `STALE_MS` a 24h et sort les cartes fraiches de la file **avant** meme de consommer un token du rate-limiter
- une carte fraiche enfilee (trade recent, front PHP, `--market refresh`) est marquee done sans aucune requete reseau

Si vous voulez changer cette fenetre (12h, 48h...), modifiez uniquement la constante `MARKET_PRICE_REFRESH_MS` exportee par `market.js`.

## Caches anti rate-limit (Steam)

Tous les appels vers steamcommunity.com sont mis en cache (constantes `STEAM_CACHE_TTL` dans steam.js) pour rester sous le rate limit (~100 req/min) :

| Endpoint | Cache | TTL |
|----------|-------|-----|
| Pages `/badges?p=N` (liste d appids, `getAllPagesAppids`) | memoire, par profil | 1h |
| `ajaxgetbadgeinfo` (cartes du set, `fetchSteamData`) | DB (`games.fetched_at`) | 30 min |
| Page `gamecards` (`fetchBadgeCrafted`, statut badge crafte) | DB (`badge_crafted` + `badge_crafted_fetched_at`) | `= 1` : skip par defaut, mais re-checke par le daemon `npm run sync` via `refetchCrafted` ou par `force` (trade / commandes manuelles) ; `= 0` : 30 min ; NULL : check systematique |
| Inventaire `753_6` (`fetchInventory`) | memoire, partage entre taches du cycle (singleflight) | 5 min |
| Prix marche (priceoverview, orderbook, pricehistory) | DB (`cards.steam_market_fetched_at`) | 24h (voir [Limite 24h](#limite-24h-des-prix-marche)) |
| `inventoryhistory` (`syncSteamInventoryHistory`) | aucun | - |

**Invalidation** : des qu un nouveau trade est detecte (`syncSteamInventoryHistory`), le cache inventaire est invalide et les jeux concernes sont re-scannes en force (`forceSteam: true`), donc la fraicheur des donnees apres un trade est preservee.

**Bypass** : les commandes manuelles contournent ces TTL - `npm run sync:badges`, `npm run sync:gamecards <appid>`, `npm run -- --scan-all` et `npm run -- --refetch-cards` passent `forceSteam: true`. Le scan complet automatique du daemon (15 min) utilise les TTL : en pratique les donnees Steam sont re-fetchees toutes les 30 min et les pages de badges toutes les heures. Toutefois, le daemon active l'option `refetchCrafted` qui bypass specifiquement le skip de `badge_crafted = 1` : les badges deja craftes sont re-verifies a chaque scan complet (la page gamecards est re-fetchee), contrairement au comportement par defaut qui les skippe (un badge crafte ne disparait pas).

## Worker de marché temps réel

Le projet intègre un worker de marché qui récupère les prix Steam Community, sans le délai fixe de 3s par carte. Il utilise un **token bucket adaptatif** (~100 req/min) avec une **file d'attente prioritaire** et le pattern **stale-while-revalidate**. Dans la limite d'un fetch par carte et par 24h (voir [Limite 24h des prix marche](#limite-24h-des-prix-marche)).

### Architecture

- **Token bucket** : 1 requête toutes les 600ms (au lieu de 3s fixe), bursts de 5 requêtes autorisés
- **Backoff adaptatif** : cooldown 30s sur 429 (rate limit Steam), puis récupération progressive
- **File prioritaire** : les cartes visibles/trade récent passent en premier
- **Stale-while-revalidate** : le front lit le cache instantanément, le worker refresh en arrière-plan (au plus tôt 24h après le dernier fetch, voir [Limite 24h](#limite-24h-des-prix-marche))
- **Optimisation** : 1 req par carte en moyenne (pricehistory suffit si vente récente, orderbook sinon)

### Niveaux de priorité

| Priorité | Quand | Délai typique |
|----------|-------|---------------|
| 100 | Carte affichée dans le front PHP | 1-2s (si > 24h) |
| 80 | Trade récent détecté (`syncSteamInventoryHistory`) | 2-5s (si > 24h) |
| 60 | Badge complétable (cartes manquantes) | 5-10s (si > 24h) |
| 30 | Prix daté (> 24h) | 10-30s |
| 10 | Reste du cache | fond |

### Démarrer le worker standalone

```bash
npm run market
```

Le worker enfile toutes les cartes connues au démarrage (priorité basse) et les traite en continu. Stats affichées toutes les 30s.

### Voir les prix en cache (stale-while-revalidate)

```bash
npm run -- --market price 616580-Servie
```

Retourne le prix en cache immédiatement. Si le prix est stale (> 24h), la carte est enfilée en priorité max pour refresh. Une carte fraîche (< 24h) n'est jamais re-fetchée (limite globale).

### Forcer le refresh d'une carte

```bash
npm run -- --market refresh 616580-Servie
```

Enfile la carte en priorité max (100). Le worker la traitera sous peu (si un worker tourne) - sauf si son prix a été fetché il y a moins de 24h : la limite 24h est globale et ce forcage ne la contourne pas.

### Enfiler les cartes stale

```bash
npm run -- --market enqueue
```

Parcourt la base et enfile toutes les cartes dont le prix date de plus de 24 heures (les cartes fraîches déjà en file sont sorties sans requête).

### Stats de la queue

```bash
npm run -- --market stats
```

### Intégration avec le mode daemon

Le mode `npm run sync` démarre automatiquement le worker de marché en arrière-plan. Dans la boucle de surveillance :
1. `syncSteamInventoryHistory` détecte les trades récents toutes les 5 min
2. Les jeux avec trades sont re-scannés (`processQueue` avec délai réduit à 500ms) hors cycles de scan complet
3. Un scan complet des badges (toutes les pages, 2 phases) tourne toutes les 15 min
4. Les cartes stale (> 24h) sont enfilées pour le worker de fond
5. Le worker refresh les prix en continu avec le token bucket, dans la limite d'un fetch par 24h et par carte

### Lancer le front-end PHP

Depuis le dossier `php/`, lancez le serveur interne PHP :

```bash
cd steam-sce/php
php -S localhost:8080
```

Puis ouvrez http://localhost:8080 dans votre navigateur.

### Sections du rapport

- **Cartes de Valeur** : cartes possedees de plus de 0,14 EUR au marche
- **Completables via SCE** : badges completables avec le credit disponible
- **A deposer au Bot** : cartes a envoyer au bot SCE contre des credits
- **Badges Trade-In Desactive** : jeux dont le trade-in SCE est coupe (repliable)

### Logique de depot ("A deposer au Bot")

Une carte est deposable au bot uniquement si :

- **aucune vente** dans les 7 derniers jours (une carte qui se vend encore vaut plus au marche Steam qu'en credits bot)
- prix marche verifie < 0,09 EUR, avec donnees fraiches (< 24h)
- stock du bot < 8

Les jeux dont le badge est deja genere sur id/Dr_Nibble (`badge_crafted`) apparaissent en premier. La colonne "Cartes (Inventaire)" affiche toutes les cartes possedees du jeu : les non-deposables en grise avec la raison (`vente < 7j`, `prix trop eleve`, `donnees marche obsoletes`, `prix non verifie`, `bot plein`). Le bouton d'envoi automatique ne transmet que les assetIds des cartes deposables.

## Base de donnees SQLite

La base `data/es_cache.sqlite` contient 5 tables :

| Table | Description |
|-------|-------------|
| `meta` | Cles-valeurs globales (scecredit, scePendingOffers, sceWaitTime, lasttrade, sceDeferredAppids, usdToEur, usdToEurFetchedAt) |
| `games` | Un jeu par appid (gamename, disabled, fetched_at, set_cards, badge_crafted, indicateurs de completion) |
| `cards` | Cartes individuelles par jeu (nom, hash, qty, inventaire, stock SCE, prix gamepage SCE USD, prix marché: vente + volume, buy order + volume, volume 7j, dernière vente 7j) |
| `badge_appids` | AppIDs decouverts sur la page badges (cache de decouverte) |
| `market_queue` | File d'attente du worker de marché (appid, hash, priorité, statut, timestamps) |

### Logique de prix marché

Pour chaque carte, le worker récupère 4 sources et stocke :

| Champ | Source | Description |
|-------|--------|-------------|
| `steam_market_sell_price_eur` | listing page / priceoverview | Prix de vente le plus bas (EUR). Priorité à la listing page (EUR direct), fallback priceoverview |
| `steam_market_sell_qty` | listing page / orderbook | Volume de vente total (listing page) ou quantité au prix le plus bas (orderbook) |
| `steam_market_buy_order_eur` | listing page / orderbook | Demande d'achat la plus haute (EUR). Priorité à la listing page (EUR direct), fallback orderbook (USD converti) |
| `steam_market_buy_order_qty` | listing page | Nombre de demandes d'achat (volume total) |
| `steam_market_sales_7d` | pricehistory | Volume de vente cumulé sur 7 jours |
| `steam_market_last_sale_price_eur` | pricehistory | Prix de la dernière vente dans les 7 jours (NULL si pas de vente) |
| `steam_market_price_eur` | résolu | Dernier prix de vente si < 7j, sinon buy order. Peuple initialement par la conversion EUR du prix gamepage SCE (phase 1), puis affine par le marché |
| `sce_market_price_usd` | gamepage SCE | Prix USD de la carte sur la gamepage SCE (section "Trading Cards") |

Conversions EUR : le buy order de l'orderbook est en USD - le taux effectif est calculé à partir du ratio `prix_vente_EUR / prix_vente_USD` (priceoverview / orderbook), fallback à 0.92. Les prix de la listing page sont en EUR directement (pas de conversion nécessaire). Les prix de la gamepage SCE sont convertis avec le taux BCE (frankfurter.app, cache 24h, surcharge `SCE_USD_TO_EUR`, fallback 0.92).

#### Page listing Steam (`getListingPageInfo`)

La page listing (`https://steamcommunity.com/market/listings/753/<hash>`) est parsée pour extraire les volumes et prix en EUR directement, sans conversion USD → EUR :

- **Ventes** : volume total (ex: "10 à vendre à partir de €0,97") → `steam_market_sell_qty` = 10, `steam_market_sell_price_eur` = 0.97
- **Achats** : volume total (ex: "7 demandes d'achat à €0,09 ou moins") → `steam_market_buy_order_qty` = 7, `steam_market_buy_order_eur` = 0.09

Les valeurs de la listing page remplacent celles de l'orderbook (USD → EUR) quand elles sont disponibles, car plus précises (prix EUR natifs). Le parsing utilise regex sur le texte débarrassé des tags HTML (les classes CSS Steam sont dynamiques). Gère le français et l'anglais.

## Script Tampermonkey

Le script Tampermonkey (`tampermonkey/Steam-Gamecards-SCE-based-on-trade-history-5.2.user.js`) s'exécute sur les pages Steam (badges, gamecards, inventaire). Il affiche les statuts SCE (complétables, cartes de valeur, quick-trade) directement dans l'UI Steam.

### Mode API (prioritaire)
Quand le backend Node.js est disponible (`http://127.0.0.1:3001`), le script récupère les données depuis l'API REST. C'est le mode par défaut — les données sont fraîches et complètes.

### Mode fallback SCE (fetch direct)
Quand l'API est indisponible, le script bascule en mode fetch SCE direct :

- **Page `/gamecards/:appid`** : fetch SCE en arrière-plan (gamepage + inventaire), analyse des indicateurs de completion, affichage des quick-trade buttons. Bouton "Rafraîchir SCE" pour un refresh manuel.
- **Page `/badges`** : affichage du cache local, récupération des infos globales SCE (crédit, file d'attente, wait time).
- **Détection de login** : si la session SCE est expirée ("Please login"), un warning est affiché en console. L'utilisateur doit être connecté à steamcardexchange.net dans le même navigateur.

### Fonctions portées du backend
- `fetchSCEGlobalInfo()` — crédit, offres en attente, wait time (page profile SCE)
- `fetchSCEInventory(appid)` — stock, worth, price, quick-trade links (page inventory SCE)
- `fetchSCEGamePage(appid)` — prix USD + détection trade-in disabled (gamepage SCE)
- `fetchSCEFresh(appid)` — combine tout, fusion non-destructive (préserve le cache si SCE ne retourne pas une carte)
- `analyzeBadgeStatus(appid)` — calcule isCompletableViaSCE, hasExpensiveCard, etc. Priorise `steamMarketPriceEur` sur le prix SCE converti. Non-destructif : ne modifie que les champs calculés.

Utilise `DOMParser` (natif navigateur) au lieu de Cheerio, et `GM.xmlHttpRequest` pour les requêtes cross-origin (cookies navigateur automatiques).

## Rafraîchissement périodique SCE

Le module `sce.js` lance automatiquement un intervalle de 10 minutes qui rafraîchit les infos globales SCE (crédit, pending offers, wait time) via `_fetchSCEGlobalInfoInner()`, **uniquement si `waitTime < 1 minute`** (bot non saturé). Si le bot est saturé (`waitTime >= 1`), le refresh est ignoré pour ne pas surcharger la file d'attente.

L'intervalle est démarré après le premier appel réussi à `fetchSCEGlobalInfo()` et est idempotent (un seul timer actif). Le verrou `_globalInfoPromise` empêche les appels concurrents.

## Serveur API REST

Le module `api.js` expose les donnees de la base SQLite via une API HTTP REST en lecture seule. Il utilise le module `http` natif de Node (aucune dependance supplementaire).

### Demarrage

```bash
npm run api
```

Le serveur demarre sur `http://127.0.0.1:3001` par defaut. Modifiez les variables d'environnement `API_HOST` et `API_PORT` dans `.env` pour changer l'hote et le port.

Le serveur API est aussi demarre automatiquement par le mode daemon (`npm run sync`) en arriere-plan, en meme temps que le worker de marche.

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/data` | Dump complet (jeux + cartes + meta) au format `win.ES.DATA` pour le script Tampermonkey |
| `GET /api/games` | Liste de tous les jeux (resume, sans les cartes) |
| `GET /api/games/:appid` | Un jeu detaille avec ses cartes |
| `GET /api/meta` | Toutes les cles-valeurs de la table `meta` |
| `GET /api/badges` | Tous les `badge_appids` |
| `GET /api/status` | Resume de la base (comptages, scecredit, lasttrade) |

### Format des donnees

L'endpoint `/api/data` retourne un objet JSON plat compatible avec le script Tampermonkey :

```json
{
  "scecredit": 12,
  "scePendingOffers": 0,
  "sceWaitTime": 0,
  "lasttrade": 123456789,
  "485450": {
    "appid": "485450",
    "gamename": "SEUM",
    "setCards": 5,
    "fetchedAt": 123456789,
    "badgeCrafted": false,
    "isCompletableViaSCE": true,
    "totalCostSCE": 3,
    "missingCount": 2,
    "cards": [
      {
        "name": "Card Name",
        "qty": 1,
        "hash": "485450-Card Name",
        "sce stock": 3,
        "sce worth": 1,
        "sce price": 1,
        "sce marketPriceUSD": 0.05,
        "sce quick-trade": "https://..."
      }
    ]
  }
}
```

### Securite

Le serveur est bind sur `127.0.0.1` par defaut : les donnees ne sont pas exposees sur le reseau. Les en-tetes CORS (`Access-Control-Allow-Origin: *`) permettent au script Tampermonkey de faire des requetes depuis les pages Steam.

## Workflow

1. Le scraper Node.js recupere les donnees Steam (badges toutes pages, inventaire, historique) et SCE (prix, stock, prix gamepage USD)
2. Les donnees sont stockees dans SQLite (phase 1 : inventaire SCE, phase 2 : prix marche)
3. Le worker de marche recupere les prix (token bucket, file prioritaire, au plus 1 fetch par carte et par 24h)
4. Le serveur API expose les donnees en lecture seule pour le script Tampermonkey
5. Le front-end PHP lit SQLite et genere le rapport HTML (cartes cheres, completables, depot)

## Commandes disponibles

| Commande | Description |
|----------|-------------|
| `npm run sync` | Mode daemon (tradehistory 5 min, scan complet 15 min, worker marché) |
| `npm run login` | Authentification Steam (mot de passe ou QR code) |
| `npm run login:qr` | Authentification Steam via QR code |
| `npm run login:password` | Authentification Steam via mot de passe |
| `npm run sync:badges` | Force le scan complet de tous les badges (toutes les pages, 2 phases) |
| `npm run sync:gamecards <appid>` | Scanne un appid specifique |
| `npm run sync:history` | Synchronise l'historique des trades |
| `npm run init-db` | Initialise la base SQLite |
| `npm run api` | Démarre le serveur API REST (lecture seule de la DB) |
| `npm run market` | Démarre le worker de marché temps réel |
| `npm run -- --market stats` | Stats de la queue de marché |
| `npm run -- --market price <hash>` | Prix en cache d'une carte |
| `npm run -- --market refresh <hash>` | Force le refresh d'une carte |
| `npm run -- --market enqueue` | Enfiler les cartes stale pour refresh |
| `npm run -- --sync-once` | Synchronise une fois l'historique (sans boucle) |
| `npm run -- --purge` | Purge le cache complet |
| `npm run -- --scan-all` | Re-scanne tous les badges connus |
| `npm run -- --refetch-cards` | Re-fetch les cartes Steam (sans SCE) |
| `npm run -- --status` | Affiche le statut des badges en DB |
| `npm run -- --db` | Resume de la base (summary, games, game, cards, badges, meta, query) |
