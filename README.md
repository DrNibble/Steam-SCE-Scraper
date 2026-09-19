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
1. Si la BD est vide : lance le scan complet (badges + cartes + SCE)
2. Si la BD est remplie : passe directement en mode surveillance
3. En mode surveillance : lance `syncSteamInventoryHistory` toutes les 10 minutes en boucle

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

## Base de donnees SQLite

La base `data/es_cache.sqlite` contient 5 tables :

| Table | Description |
|-------|-------------|
| `meta` | Cles-valeurs globales (scecredit, scePendingOffers, sceWaitTime, lasttrade) |
| `games` | Un jeu par appid (gamename, disabled, fetched_at, set_cards, indicateurs de completion) |
| `cards` | Cartes individuelles par jeu (nom, hash, qty, inventaire, stock SCE, prix marché: vente, buy order, volume 7j) |
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
| `steam_market_price_eur` | résolu | Dernier prix de vente si < 7j, sinon buy order |

Conversion EUR : le buy order de l'orderbook est en USD. Le taux de change effectif est calculé à partir du ratio `prix_vente_EUR / prix_vente_USD` (priceoverview / orderbook). Fallback à 0.92 si indisponible.

## Corrections de bugs du script original

- `qty: (card.owned || 0, 10)` toujours egal a 10 -> corrige en `qty: card.owned || 0`
- `let inventoryCache = null` dans `syncSteamInventoryHistory` masquait la variable externe -> supprime
- `isCompletableviaSCEnobudget` reference mais inexistant -> utilise `isCompletableviaSCEwobudget`

## Workflow

1. Le scraper Node.js recupere les donnees Steam (badges, inventaire, historique) et SCE (prix, stock)
2. Les donnees sont stockees dans SQLite
3. Le worker de marché récupère les prix en quasi temps réel (token bucket, file prioritaire)
4. Le front-end PHP lit SQLite et genere le rapport HTML (cartes cheres, completables, depot)

## Commandes disponibles

| Commande | Description |
|----------|-------------|
| `npm run sync` | Mode daemon (scan + surveillance + worker marché) |
| `npm run login` | Authentification Steam (mot de passe ou QR code) |
| `npm run login:qr` | Authentification Steam via QR code |
| `npm run login:password` | Authentification Steam via mot de passe |
| `npm run sync:badges` | Force le scan complet de tous les badges |
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
