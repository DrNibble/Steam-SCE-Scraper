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
│       ├── sce.js         # Scraping Steam Card Exchange (prix, stock, credits)
│       ├── market.js       # Prix marché Steam (orderbook, pricehistory, buy orders)
│       ├── marketQueue.js # Worker temps réel (token bucket, file prioritaire, stale-while-revalidate)
│       ├── analyze.js     # Analyse des badges (completion, couts, cartes cheres)
│       ├── sync.js        # Orchestration (workflow, queue, concurrence)
│       └── index.js       # Point d'entree (CLI)
├── php/                   # Frontend PHP (rapport HTML)
│   ├── config.php         # Configuration (chemin DB, trade partner)
│   ├── db.php             # Connexion SQLite (lecture seule)
│   ├── index.php          # Page du rapport
│   └── style.css          # Styles (theme Steam)
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
2. Si la BD est remplie : passe directement en mode surveillance
3. En mode surveillance : lance `syncSteamInventoryHistory` toutes les 10 minutes en boucle (les badges differes par le bot SCE sont retentes a chaque cycle)

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

- Parcourt **toutes les pages de badges** du profil (`?p=1`, `?p=2`, ...) : le nombre de pages est detecte automatiquement (liens de pagination + "Showing X-Y of Z badges")
- Pour chaque appid : `fetchSteamData` (cartes du set + inventaire) puis `fetchSCEFresh` (sce_stock, sce_price, sce_worth, sce_quick_trade, cartes possedees / manquantes / doublons)
- Les prix USD des cartes sont extraits de la gamepage SCE (section "Trading Cards" uniquement) : stockes dans `sce_market_price_usd`, convertis en EUR et stockes dans `steam_market_price_eur`
- S'execute en **4 taches paralleles** si le `waitTime` SCE est < 1 minute, sinon sequentiellement (1 tache)

Si le bot SCE est sature (`waitTime` > 1 min ET `pendingOffers` > 10), `fetchSCEFresh` retourne null : le badge est differe (meta `sceDeferredAppids`) et retente au prochain cycle de 10 minutes du daemon.

### Phase 2 - Prix marche (`fetchMarketPricesV2`)

Executee **apres** la phase 1, uniquement sur les appids mis a jour avec succes en DB (`dbReadyAppids`) - les appids deferes par le bot SCE n'y passent qu'apres un cycle de retry reussi -, sequentiellement (appid par appid) :

1. `fetchMarketPricesV2` (market.js) affine `steam_market_price_eur` avec le prix reel du marche (derniere vente < 7j, sinon buy order) - la valeur EUR posee par la phase 1 est preservee si le marche n'a pas de prix
2. `analyzeBadgeStatus` recalcule les indicateurs de completion

## Worker de marché temps réel

Le projet intègre un worker de marché qui récupère les prix Steam Community en quasi temps réel, sans le délai fixe de 3s par carte. Il utilise un **token bucket adaptatif** (~100 req/min) avec une **file d'attente prioritaire** et le pattern **stale-while-revalidate**.

### Architecture

- **Token bucket** : 1 requête toutes les 600ms (au lieu de 3s fixe), bursts de 5 requêtes autorisés
- **Backoff adaptatif** : cooldown 30s sur 429 (rate limit Steam), puis récupération progressive
- **File prioritaire** : les cartes visibles/trade récent passent en premier
- **Stale-while-revalidate** : le front lit le cache instantanément, le worker refresh en arrière-plan
- **Optimisation** : 1 req par carte en moyenne (pricehistory suffit si vente récente, orderbook sinon)

### Niveaux de priorité

| Priorité | Quand | Délai typique |
|----------|-------|---------------|
| 100 | Carte affichée dans le front PHP | 1-2s |
| 80 | Trade récent détecté (`syncSteamInventoryHistory`) | 2-5s |
| 60 | Badge complétable (cartes manquantes) | 5-10s |
| 30 | Prix daté (> 30 min) | 10-30s |
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

Retourne le prix en cache immédiatement. Si le prix est stale (> 30 min), la carte est enfilée en priorité max pour refresh.

### Forcer le refresh d'une carte

```bash
npm run -- --market refresh 616580-Servie
```

Enfile la carte en priorité max (100). Le worker la traitera sous peu (si un worker tourne).

### Enfiler les cartes stale

```bash
npm run -- --market enqueue
```

Parcourt la base et enfile toutes les cartes dont le prix date de plus de 30 minutes.

### Stats de la queue

```bash
npm run -- --market stats
```

### Intégration avec le mode daemon

Le mode `npm run sync` démarre automatiquement le worker de marché en arrière-plan. Dans la boucle de surveillance :
1. `syncSteamInventoryHistory` détecte les trades récents toutes les 10 min
2. Les jeux avec trades sont re-scannés (`processQueue` avec délai réduit à 500ms)
3. Les cartes stale sont enfilées pour le worker de fond
4. Le worker refresh les prix en continu avec le token bucket

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
| `cards` | Cartes individuelles par jeu (nom, hash, qty, inventaire, stock SCE, prix gamepage SCE USD, prix marché: vente, buy order, volume 7j) |
| `badge_appids` | AppIDs decouverts sur la page badges (cache de decouverte) |
| `market_queue` | File d'attente du worker de marché (appid, hash, priorité, statut, timestamps) |

### Logique de prix marché

Pour chaque carte, le worker récupère 3 endpoints et stocke :

| Champ | Source | Description |
|-------|--------|-------------|
| `steam_market_sell_price_eur` | priceoverview | Prix de vente le plus bas (EUR) |
| `steam_market_sell_qty` | orderbook | Quantité au prix de vente le plus bas |
| `steam_market_buy_order_eur` | orderbook | Demande d'achat la plus haute (EUR, convertie depuis USD) |
| `steam_market_sales_7d` | pricehistory | Volume de vente cumulé sur 7 jours |
| `steam_market_price_eur` | résolu | Dernier prix de vente si < 7j, sinon buy order. Peuple initialement par la conversion EUR du prix gamepage SCE (phase 1), puis affine par le marche |
| `sce_market_price_usd` | gamepage SCE | Prix USD de la carte sur la gamepage SCE (section "Trading Cards") |

Conversions EUR : le buy order de l'orderbook est en USD - le taux effectif est calcule a partir du ratio `prix_vente_EUR / prix_vente_USD` (priceoverview / orderbook), fallback a 0.92. Les prix de la gamepage SCE sont convertis avec le taux BCE (frankfurter.app, cache 24h, surcharge `SCE_USD_TO_EUR`, fallback 0.92).

## Workflow

1. Le scraper Node.js recupere les donnees Steam (badges toutes pages, inventaire, historique) et SCE (prix, stock, prix gamepage USD)
2. Les donnees sont stockees dans SQLite (phase 1 : inventaire SCE, phase 2 : prix marche)
3. Le worker de marché récupère les prix en quasi temps réel (token bucket, file prioritaire)
4. Le front-end PHP lit SQLite et genere le rapport HTML (cartes cheres, completables, depot)

## Commandes disponibles

| Commande | Description |
|----------|-------------|
| `npm run sync` | Mode daemon (scan + surveillance + worker marché) |
| `npm run login` | Authentification Steam (mot de passe ou QR code) |
| `npm run login:qr` | Authentification Steam via QR code |
| `npm run login:password` | Authentification Steam via mot de passe |
| `npm run sync:badges` | Force le scan complet de tous les badges (toutes les pages, 2 phases) |
| `npm run sync:gamecards <appid>` | Scanne un appid specifique |
| `npm run sync:history` | Synchronise l'historique des trades |
| `npm run init-db` | Initialise la base SQLite |
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
