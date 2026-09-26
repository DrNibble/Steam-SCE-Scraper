# Steam-SCE Scraper

Conversion en Node.js du script Tampermonkey "Steam-Gamecards-SCE" avec base de donnees SQLite et front-end PHP pour l'affichage du rapport.

## Architecture

```
steam-sce/
├── node/                  # Backend Node.js (scraper)
│   ├── .env.example       # Configuration (cookies, chemin DB)
│   ├── package.json
│   └── src/
│       ├── db.js          # Couche SQLite (schema, CRUD, migrations)
│       ├── utils.js       # Utilitaires (HTTP, clean, isSteamEvent, etc.)
│       ├── steam.js       # Scraping Steam (badges, inventaire, historique trades + marché)
│       ├── sce.js         # Scraping Steam Card Exchange (prix, stock, credits, refresh periodique)
│       ├── market.js       # Prix marché Steam (page listing + cache SSR, orderbook, pricehistory, buy orders)
│       ├── ssrCache.js     # Parsing du cache SSR React Query de la page listing (helpers purs)
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
- **STEAM_PROFILE_PATHS** : Liste de profile links Steam séparés par des virgules (`my`, `profiles/<SteamID64>`, ou `id/<vanity>`). Le premier est le profil principal (auth, trade offers). Tous les profils sont scannés pour les badges et l'inventaire. Chaque appid et carte reçoit un champ `owner` listant les profils qui les possèdent.
  - Exemple : `STEAM_PROFILE_PATHS=my,profiles/76561198028880269,id/Dr_Nibble`
  - Multi-compte : voir [Support multi-comptes](#support-multi-comptes)
- **STEAM_PROFILE_PATH** : (obsolète) Chemin d'un seul profil Steam. Utilisez `STEAM_PROFILE_PATHS` pour le multi-compte.
- **SCE_USD_TO_EUR** (optionnel) : Taux de change USD->EUR fixe pour la conversion des prix de la gamepage SCE (par defaut : taux BCE via frankfurter.app, mis en cache 24h, fallback 0.92)
- **EVENT_APP_IDS** : AppIDs des evenements Steam (Sales, Awards, etc.), separes par des virgules (ex: `335590,866860,1797760`). Utilises par `isSteamEvent()` pour classer les badges d'evenements. A completer au fil des nouveaux evenements Steam.

### 3. Initialisation de la base

```bash
npm run init-db
```

La base est initialisée automatiquement au chargement du module `db.js`. Les migrations (`ALTER TABLE`) s'exécutent au démarrage pour ajouter les colonnes manquantes aux bases existantes (voir [Migrations](#migrations)).

## Utilisation

### Lancer le mode daemon (defaut)

```bash
npm run sync
```

Ce mode :
1. Si la BD est vide : lance le scan complet (badges toutes pages + cartes + SCE, voir [Synchronisation en 2 phases](#synchronisation-des-badges-2-phases))
2. Si la BD est remplie : passe directement en mode surveillance
3. En mode surveillance : lance **4 taches paralleles** (voir [Taches paralleles du daemon](#taches-paralleles-du-daemon))

### Scanner un appid specifique

```bash
npm run sync:gamecards 485450
```

### Synchroniser l'historique des trades et du marche

```bash
npm run sync:history
```

Synchronise a la fois l'historique des trades (`/inventoryhistory/`) et l'historique des transactions du marche (`/market/myhistory/render/`).

### Synchroniser une seule fois (sans boucle)

```bash
npm run -- --sync-once
```

Synchronise une fois l'historique des trades et du marche (sans boucle de surveillance).

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
- Le hash stocké en DB est le `market_hash_name` brut renvoyé par l'API Steam `ajaxgetbadgeinfo` (ex: `664320-Loki (Trading Card)`) — aucun nettoyage n'est appliqué (voir [Format du hash](#format-du-hash))
- Les prix USD des cartes sont extraits de la gamepage SCE (section "Trading Cards" uniquement) : stockes dans `sce_market_price_usd`, convertis en EUR et stockes dans `steam_market_price_eur`
- `fetchSCEFresh` préserve tous les champs de prix marché existants en DB lors de l'appel à `upsertCards` (les champs sont explicitement passés depuis `dbCard`, en plus du mécanisme de fallback `existingPrices`)
- S'execute en **4 taches paralleles** si le `waitTime` SCE est < 1 minute, sinon sequentiellement (1 tache)

Si le bot SCE est sature (`waitTime` > 1 min ET `pendingOffers` > 10), `fetchSCEFresh` retourne null : le badge est differe (meta `sceDeferredAppids`) et retente au prochain cycle de 5 minutes du daemon.

### Phase 2 - Prix marche (`fetchMarketPricesV2`)

Executee **apres** la phase 1, uniquement sur les appids mis a jour avec succes en DB (`dbReadyAppids`) - les appids deferes par le bot SCE n'y passent qu'apres un cycle de retry reussi -, sequentiellement (appid par appid) :

1. `fetchMarketPricesV2` (market.js) affine `steam_market_price_eur` avec le prix reel du marche (derniere vente < 7j, sinon buy order) - la valeur EUR posee par la phase 1 est preservee si le marche n'a pas de prix. Les prix (`priceEur` et `lastSalePriceEur`) sont **arrondis à 2 décimales** (format #,##) avant écriture en DB. **Limite 24h** : une carte dont le prix a ete fetche il y a moins de 24h (`cards.steam_market_fetched_at`) est ignoree, aucune requete n'est faite (voir [Limite 24h des prix marche](#limite-24h-des-prix-marche))
2. `analyzeBadgeStatus` recalcule les indicateurs de completion. Tous les champs de prix marché sont explicitement passés à `upsertCards` (y compris `steamMarketLastSalePriceEur`, `steamMarketFetchedAt`, `steamMarketSellPriceEur`, `steamMarketSellQty`, `steamMarketBuyOrderEur`, `steamMarketBuyOrderQty`) pour éviter toute perte de données lors du cycle DELETE/INSERT de `upsertCards`

## Format du hash

Le hash stocké dans la colonne `cards.hash` est le `market_hash_name` brut tel que renvoyé par l'API Steam `ajaxgetbadgeinfo` (endpoint `ajaxgetbadgeinfo/:appid`). Aucun nettoyage n'est appliqué : le suffixe "(Trading Card)" est conservé.

Exemples :
- `664320-Loki (Trading Card)`
- `485450-Spikes (Trading Card)`

Ce format correspond exactement au `market_hash_name` attendu par les endpoints du Steam Community Market (`priceoverview`, `pricehistory`, `orderbook`, listing page). Le matching d'inventaire dans `fillInventoryData` utilise également le `market_hash_name` brut pour correspondre au hash en DB.

Le matching SCE dans `fetchSCEFresh` utilise `clean(dbCard.name, true)` (le nom de la carte, pas le hash) pour la correspondance avec l'inventaire SCE — il n'est donc pas affecté par le format du hash.

## Migrations

La fonction `initDB()` de `db.js` exécute automatiquement des migrations `ALTER TABLE` au démarrage pour ajouter les colonnes manquantes aux bases existantes. Chaque migration est wrappée dans un `try/catch` (silencieux si la colonne existe déjà).

| Migration | Table | Description |
|-----------|-------|-------------|
| `steam_market_price_eur REAL` | cards | Prix marché EUR (résolu) |
| `steam_market_last_sale_price_eur REAL` | cards | Dernier prix de vente (7j) |
| `steam_market_sales_7d INTEGER` | cards | Volume de vente 7j |
| `steam_market_fetched_at INTEGER` | cards | Date du dernier fetch marché |
| `badge_crafted INTEGER` | games | Statut badge crafté (NULL/0/1) |
| `badge_crafted_fetched_at INTEGER` | games | Date du dernier check badge |
| `sce_quick_trade TEXT` | cards | Lien de trade rapide SCE |
| `steam_market_sell_price_eur REAL` | cards | Prix de vente le plus bas (EUR) |
| `steam_market_sell_qty INTEGER` | cards | Volume de vente total |
| `steam_market_buy_order_eur REAL` | cards | Demande d'achat la plus haute (EUR) |
| `steam_market_buy_order_qty INTEGER` | cards | Nombre de demandes d'achat |
| `owner TEXT` | games | Profils qui possèdent ce jeu (séparés par virgules) |
| `owner TEXT` | cards | Profils qui possèdent cette carte (séparés par virgules) |

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
| `market/myhistory/render` (`syncSteamMarketHistory`) | aucun | - |

**Invalidation** : des qu un nouveau trade ou une transaction de marche est detecte (`syncSteamInventoryHistory` ou `syncSteamMarketHistory`), le cache inventaire est invalide et les jeux concernes sont re-scannes en force (`forceSteam: true`), donc la fraicheur des donnees apres un trade ou une vente marche est preservee.

**Bypass** : les commandes manuelles contournent ces TTL - `npm run sync:badges`, `npm run sync:gamecards <appid>`, `npm run -- --scan-all` et `npm run -- --refetch-cards` passent `forceSteam: true`. Le scan complet automatique du daemon (15 min) utilise les TTL : en pratique les donnees Steam sont re-fetchees toutes les 30 min et les pages de badges toutes les heures. Toutefois, le daemon active l'option `refetchCrafted` qui bypass specifiquement le skip de `badge_crafted = 1` : les badges deja craftes sont re-verifies a chaque scan complet (la page gamecards est re-fetchee), contrairement au comportement par defaut qui les skippe (un badge crafte ne disparait pas).

## Historique des transactions du marché (`syncSteamMarketHistory`)

Steam sépare l'historique des trades (`/inventoryhistory/`) et l'historique des transactions du marché (`/market/myhistory/render/`). La fonction `syncSteamMarketHistory` complète `syncSteamInventoryHistory` en détectant les ventes et achats de cartes sur le Community Market.

### Endpoint

```
GET https://steamcommunity.com/market/myhistory/render/?query=&start=0&count=500&norender=1
```

- `norender=1` retourne du JSON (pas de HTML rendu)
- `count` max 500, pagination par offset (`start` incrémenté de 500)
- Nécessite les cookies Steam (session authentifiée)

### Structure de la réponse JSON

La réponse contient 4 objets liés :

| Objet | Clé | Champs clés |
|-------|-----|------------|
| `events` | tableau | `listingid`, `purchaseid`, `event_type` (3=vente, 4=achat), `time_event` (Unix s), `time_event_fraction` |
| `listings` | `listingid` | `publisher_fee_app` (appid du jeu), `asset` ({appid, contextid, id}) |
| `purchases` | `listingid_purchaseid` | `asset` ({appid, classid, instanceid}), `paid_amount`, `paid_fee`, `time_sold` |
| `assets` | `appid[contextid][assetid]` | `name`, `market_hash_name`, `type`, `tags` |

### Résolution de l'appid

L'appid du jeu est résolu en cascade :

1. `listings[listingid].publisher_fee_app` (le plus fiable pour les cartes)
2. `asset.market_fee_app` si présent
3. Préfixe numérique du `market_hash_name` (ex: `1021770-Card Name` → `1021770`)
4. Si seul 753 (Steam) est résolu, la transaction est ignorée

### Curseur séparé

`syncSteamMarketHistory` utilise un curseur dédié (`lastmarkettrade` dans la table `meta`) pour éviter les conflits avec `lasttrade` utilisé par `syncSteamInventoryHistory`. Les deux fonctions sont appelées à chaque cycle de 5 minutes et leurs appids sont fusionnés :

```js
const tradeUpdated = await syncSteamInventoryHistory(pl);
const marketUpdated = await syncSteamMarketHistory(pl);
const updatedAppIds = [...new Set([...(tradeUpdated || []), ...(marketUpdated || [])])];
```

Comme pour `syncSteamInventoryHistory`, les nouvelles transactions détectées invalident le cache inventaire et déclenchent un re-scan ciblé des jeux concernés.

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

### Taches paralleles du daemon

Le mode `npm run sync` démarre automatiquement le worker de marché en arrière-plan, le serveur API, puis lance **4 tâches parallèles** après le sync initial (DB remplie et stabilisée) :

| Tâche | Fréquence | Action |
|-------|-----------|--------|
| **Task 1 — SCE credit/waittime** | 2 min | `resetCreditFlag()` + `fetchSCEGlobalInfo()` : rafraîchit le crédit, les offres en attente et le wait time SCE. La restriction waittime existante (`isSCEBusy` dans `fetchSCEFresh`) est respectée par les autres tâches |
| **Task 2 — Prix marché** | 1 heure | `fetchMarketPricesV2` sur les appids en DB où `total_owned_qty > 0` + `analyzeBadgeStatus`. Respecte le rate-limit (délai 500ms, garde-fou 24h via `isMarketPriceFresh`). Enfile aussi les cartes stale pour le worker de fond |
| **Task 3 — Trade history** | 5 min | `syncSteamInventoryHistory` → `syncSteamMarketHistory` → si des trades sont détectés, `fetchSteamData` (force) sur les appids affectés. Signale ces appids à la Task 4 via une variable partagée |
| **Task 4 — Scan SCE** | 15 min ou immédiat | `fetchSCEFresh` sur les appids en DB. Scan complet toutes les 15 min, ou **immédiat** sur les appids signalés par la Task 3 (nouveaux trades). Parallelisation : 4 tâches si `waitTime < 1 min`, sinon séquentiel. `analyzeBadgeStatus` après chaque appid |

**Communication Task 3 → Task 4** : la variable partagée `tradeUpdatedAppIds` permet à la Task 3 de signaler les appids affectés par des trades. La Task 4 les consomme et lance `fetchSCEFresh` immédiatement dessus, sans attendre le prochain cycle de 15 min.

Le worker de marché continue de tourner en arrière-plan avec son token bucket adaptatif, dans la limite d'un fetch par carte et par 24h. La Task 2 enfile les cartes stale (> 24h) pour ce worker.

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
| `meta` | Cles-valeurs globales (scecredit, scePendingOffers, sceWaitTime, lasttrade, lastmarkettrade, sceDeferredAppids, usdToEur, usdToEurFetchedAt) |
| `games` | Un jeu par appid (gamename, disabled, fetched_at, set_cards, badge_crafted, indicateurs de completion) |
| `cards` | Cartes individuelles par jeu (nom, hash, qty, inventaire, stock SCE, prix gamepage SCE USD, prix marché: vente + volume, buy order + volume, volume 7j, dernière vente 7j) |
| `badge_appids` | AppIDs decouverts sur la page badges (cache de decouverte) |
| `market_queue` | File d'attente du worker de marché (appid, hash, priorité, statut, timestamps) |

### Format du hash (`cards.hash`)

Le hash est le `market_hash_name` brut renvoyé par l'API Steam `ajaxgetbadgeinfo`, sans aucun nettoyage. Le suffixe "(Trading Card)" est conservé :

- Exemple : `664320-Loki (Trading Card)`
- Ce format correspond exactement au `market_hash_name` attendu par les endpoints du Steam Community Market
- Le matching d'inventaire (`fillInventoryData`) compare le `market_hash_name` brut des items d'inventaire au hash en DB
- Le matching SCE (`fetchSCEFresh`) utilise `clean(dbCard.name, true)` (le nom, pas le hash) — non affecté

### Préservation des prix marché (`upsertCards`)

La fonction `upsertCards` fait un DELETE + INSERT des cartes à chaque appel. Pour éviter de perdre les prix marché (écrits par `updateCardMarketPrices` en Phase 2), deux mécanismes de préservation sont en place :

1. **`existingPrices` (fallback DB)** : avant le DELETE, les prix marché existants sont lus depuis la DB et stockés dans une map `hash → {price, lastSalePrice, sales, fetchedAt, sellPriceEur, sellQty, buyOrderEur, buyOrderQty}`. Si un champ n'est pas fourni dans l'objet carte, la valeur existante en DB est utilisée.

2. **Passage explicite (défensif)** : `analyzeBadgeStatus` et `fetchSCEFresh` passent explicitement tous les champs de prix marché dans les objets carte lus depuis la DB (`steamMarketPriceEur`, `steamMarketLastSalePriceEur`, `steamMarketSales7d`, `steamMarketFetchedAt`, `steamMarketSellPriceEur`, `steamMarketSellQty`, `steamMarketBuyOrderEur`, `steamMarketBuyOrderQty`). Cela garantit la préservation même si le mécanisme de fallback échoue.

Les colonnes sell/buy order (`steam_market_sell_price_eur`, `steam_market_sell_qty`, `steam_market_buy_order_eur`, `steam_market_buy_order_qty`) sont incluses dans l'INSERT de `upsertCards` et préservées via `existingPrices`. Des migrations `ALTER TABLE` les ajoutent automatiquement aux bases existantes (voir [Migrations](#migrations)).

### Arrondi des prix marché

Les prix marché (`priceEur` et `lastSalePriceEur`) sont arrondis à 2 décimales (format #,##) dans `fetchMarketPricesV2` avant écriture dans le `priceMap` passé à `updateCardMarketPrices`. Le debug log affiche également la valeur arrondie.

### Logique de prix marché

Pour chaque carte, la source primaire est la **page listing Steam** (1 requête), puis les endpoints en fallback selon les données manquantes. Le worker stocke :

| Champ | Source | Description |
|-------|--------|-------------|
| `steam_market_sell_price_eur` | listing page (texte / cache SSR) / priceoverview | Prix de vente le plus bas (EUR). Priorité à la listing page (EUR direct), fallback priceoverview |
| `steam_market_sell_qty` | listing page / cache SSR orderbook / orderbook | Volume de vente total (listing page) ou quantité au prix le plus bas (orderbook) |
| `steam_market_buy_order_eur` | listing page (texte / cache SSR) / orderbook | Demande d'achat la plus haute (EUR). Priorité à la listing page (EUR direct), fallback orderbook (USD converti) |
| `steam_market_buy_order_qty` | listing page / cache SSR orderbook | Nombre de demandes d'achat (volume total) |
| `steam_market_sales_7d` | cache SSR pricehistory / pricehistory | Volume de vente cumulé sur 7 jours |
| `steam_market_last_sale_price_eur` | cache SSR pricehistory / pricehistory | Prix de la dernière vente dans les 7 jours (NULL si pas de vente). Arrondi à 2 décimales |
| `steam_market_price_eur` | résolu | Dernier prix de vente si < 7j, sinon buy order. Arrondi à 2 décimales. Peuple initialement par la conversion EUR du prix gamepage SCE (phase 1), puis affine par le marché |
| `sce_market_price_usd` | gamepage SCE | Prix USD de la carte sur la gamepage SCE (section "Trading Cards") |

Conversions EUR : le buy order de l'orderbook est en USD - le taux effectif est calculé à partir du ratio `prix_vente_EUR / prix_vente_USD` (priceoverview / orderbook), fallback à 0.92. Les prix de la listing page sont en EUR directement (pas de conversion nécessaire). Les prix de la gamepage SCE sont convertis avec le taux BCE (frankfurter.app, cache 24h, surcharge `SCE_USD_TO_EUR`, fallback 0.92).

#### Page listing Steam (`getListingPageData`, module `ssrCache.js`)

La page listing (`https://steamcommunity.com/market/listings/753/<hash>`) est la source primaire du worker : **1 requête remplace jusqu'à 3 appels endpoints**. Elle fournit deux choses :

**1. Cache SSR (primaire)** : quand le rendu côté serveur réussit, la page embarque un cache React Query déshydraté (`window.SSR.renderContext`) contenant les réponses des endpoints `/market/orderbook` (buy/sell orders + profondeur) et `/market/pricehistory` (historique complet des ventes) — voir `ssrCache.js`.

**2. Texte visible (complément/fallback)** : volumes et prix en EUR directement, sans conversion USD → EUR :

- **Ventes** : volume total (ex: "10 à vendre à partir de €0,97") → `steam_market_sell_qty` = 10, `steam_market_sell_price_eur` = 0.97
- **Achats** : volume total (ex: "7 demandes d'achat à €0,09 ou moins") → `steam_market_buy_order_qty` = 7, `steam_market_buy_order_eur` = 0.09

**Règles de fallback** :

- Les prix du cache SSR ne sont utilisés en EUR que si la devise est l'EUR (`eCurrency`/`ecurrency` === 3) ; sinon les endpoints prennent le relais (les quantités restent exploitées, elles sont indépendantes de la devise)
- Cache SSR `pricehistory` présent sans vente dans les 7 jours = donnée autoritaire → aucun appel endpoint
- ⚠ **Le cache SSR est absent pour les items à fort volume de ventes** (Steam sert une page coquille "Failed to load item description") : les endpoints restent alors indispensables en fallback
- Le parsing du texte utilise regex sur le texte débarrassé des tags HTML (les classes CSS Steam sont dynamiques). Gère le français et l'anglais, le symbole € avant ou après le montant

Les helpers de parsing du cache SSR sont regroupés dans `node/src/ssrCache.js` (module 100% pur, sans dépendance) et testables isolément avec `node test-ssrCache.mjs`.

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
    "owner": "my,profiles/76561198028880269",
    "cards": [
      {
        "name": "Card Name",
        "qty": 1,
        "hash": "485450-Card Name (Trading Card)",
        "sce stock": 3,
        "sce worth": 1,
        "sce price": 1,
        "sce marketPriceUSD": 0.05,
        "sce quick-trade": "https://...",
        "steamMarketPriceEur": 0.06,
        "steamMarketLastSalePriceEur": 0.06,
        "steamMarketSales7d": 17,
        "steamMarketFetchedAt": 1790249510124,
        "owner": "my,profiles/76561198028880269"
      }
    ]
  }
}
```

### Securite

Le serveur est bind sur `127.0.0.1` par defaut : les donnees ne sont pas exposees sur le reseau. Les en-tetes CORS (`Access-Control-Allow-Origin: *`) permettent au script Tampermonkey de faire des requetes depuis les pages Steam.

## Support multi-comptes

Le scraper supporte la gestion de **plusieurs comptes Steam** en parallèle. Chaque profil défini dans `STEAM_PROFILE_PATHS` est scanné pour ses badges et son inventaire.

### Configuration

Dans `.env`, renseignez la variable `STEAM_PROFILE_PATHS` avec les profile links séparés par des virgules :

```bash
# Exemple : 3 comptes Steam
STEAM_PROFILE_PATHS=my,profiles/76561198028880269,id/Dr_Nibble
```

- Le **premier profil** est le profil principal : il est utilisé pour l'authentification, les trade offers et les commandes manuelles.
- **Tous les profils** sont scannés pour les badges (pages `/badges`) et l'inventaire (contexte 753_6).
- L'authentification Steam (`STEAM_COOKIE`) doit correspondre au premier profil.

### Champ `owner`

Chaque appid (jeu) et chaque carte reçoit un champ `owner` en DB (colonnes `games.owner` et `cards.owner`) qui liste les profils possédant l'élément, séparés par des virgules :

```
appid.owner = "my,profiles/76561198028880269"
cards.name.owner = "my,profiles/76561198028880269"
```

- **Pour les jeux** : `owner` est rempli lors du scan des badges (`parseBadgePage`). Si un profil a un badge pour un appid, son profile link est ajouté.
- **Pour les cartes** : `owner` est rempli lors du scan de l'inventaire (`fillInventoryData`). Si un profil a l'item dans son inventaire, son profile link est ajouté.
- Les owners sont **accumulés sans doublons** via la fonction `addOwner()` (voir `utils.js`).
- L'API REST expose `owner` dans les endpoints `/api/games`, `/api/games/:appid` et `/api/data`.

### Accumulation de l'inventaire

L'inventaire des cartes est **accumulé** à travers les profils : chaque item dans `card.inv` porte un champ `profile` identifiant son propriétaire. La quantité (`qty`) reflète le total tous profils confondus.

Lors d'un re-scan d'un profil, les items de ce profil sont d'abord retirés (pour éviter les doublons) puis ré-ajoutés avec les données fraîches.

### Comportement multi-profils

| Fonctionnalité | Comportement |
|---------------|-------------|
| Scan des badges (`syncBadgesWorkflow`) | Scanne toutes les pages de badges de chaque profil, déduplique les appids |
| `processQueue` | Appelle `fetchSteamData` pour chaque profil (accumule `inv` + `owner`) |
| Trade history (`syncSteamInventoryHistory`) | Synchronise pour chaque profil |
| Re-scan après trade | Re-fetch Steam pour chaque profil (`force: true`) |
| Daemon (4 tâches parallèles) | Task 3 itère sur tous les profils pour la trade history |
| SCE (`fetchSCEFresh`) | Profil-agnostique, appelé une seule fois par appid |
| Prix marché (`fetchMarketPricesV2`) | Profil-agnostique, appelé une seule fois par appid |

## Workflow

1. Le scraper Node.js recupere les donnees Steam (badges toutes pages, inventaire, historique trades + marche) et SCE (prix, stock, prix gamepage USD)
2. Les donnees sont stockees dans SQLite (phase 1 : inventaire SCE, phase 2 : prix marche)
3. Apres le sync initial, **4 tâches parallèles** tournent en continu (voir [Tâches parallèles du daemon](#tâches-parallèles-du-daemon)) :
   - Task 1 : refresh SCE credit/waittime (2 min)
   - Task 2 : prix marché sur appids avec `totalOwnedQty > 0` (1 h)
   - Task 3 : trade history + re-scan Steam si trades (5 min)
   - Task 4 : scan SCE complet ou ciblé (15 min ou immédiat)
4. Le worker de marche recupere les prix en arriere-plan (token bucket, file prioritaire, au plus 1 fetch par carte et par 24h)
5. Le serveur API expose les donnees en lecture seule pour le script Tampermonkey
6. Le front-end PHP lit SQLite et genere le rapport HTML (cartes cheres, completables, depot)

## Commandes disponibles

| Commande | Description |
|----------|-------------|
| `npm run sync` | Mode daemon : scan complet si BD vide, puis 4 tâches parallèles (SCE credit 2 min, prix marché 1 h, trade history 5 min, scan SCE 15 min) |
| `npm run login` | Authentification Steam (mot de passe ou QR code) |
| `npm run login:qr` | Authentification Steam via QR code |
| `npm run login:password` | Authentification Steam via mot de passe |
| `npm run sync:badges` | Force le scan complet de tous les badges (toutes les pages, 2 phases) |
| `npm run sync:gamecards <appid>` | Scanne un appid specifique |
| `npm run sync:history` | Synchronise l'historique des trades et du marché |
| `npm run init-db` | Initialise la base SQLite |
| `npm run api` | Démarre le serveur API REST (lecture seule de la DB) |
| `npm run market` | Démarre le worker de marché temps réel |
| `npm run -- --market stats` | Stats de la queue de marché |
| `npm run -- --market price <hash>` | Prix en cache d'une carte |
| `npm run -- --market refresh <hash>` | Force le refresh d'une carte |
| `npm run -- --market enqueue` | Enfiler les cartes stale pour refresh |
| `npm run -- --sync-once` | Synchronise une fois l'historique des trades et du marché (sans boucle) |
| `npm run -- --purge` | Purge le cache complet |
| `npm run -- --scan-all` | Re-scanne tous les badges connus |
| `npm run -- --refetch-cards` | Re-fetch les cartes Steam (sans SCE) |
| `npm run -- --status` | Affiche le statut des badges en DB |
| `npm run -- --db` | Resume de la base (summary, games, game, cards, badges, meta, query) |
