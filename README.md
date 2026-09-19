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

- **Node.js** >= 18 (utilise `fetch` natif)
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

### Lancer le front-end PHP

Depuis le dossier `php/`, lancez le serveur interne PHP :

```bash
cd steam-sce/php
php -S localhost:8080
```

Puis ouvrez http://localhost:8080 dans votre navigateur.

## Base de donnees SQLite

La base `data/es_cache.sqlite` contient 4 tables :

| Table | Description |
|-------|-------------|
| `meta` | Cles-valeurs globales (scecredit, scePendingOffers, sceWaitTime, lasttrade) |
| `games` | Un jeu par appid (gamename, disabled, fetched_at, set_cards, indicateurs de completion) |
| `cards` | Cartes individuelles par jeu (nom, hash, qty, inventaire, stock SCE, prix) |
| `badge_appids` | AppIDs decouverts sur la page badges (cache de decouverte) |

## Corrections de bugs du script original

- `qty: (card.owned || 0, 10)` toujours egal a 10 -> corrige en `qty: card.owned || 0`
- `let inventoryCache = null` dans `syncSteamInventoryHistory` masquait la variable externe -> supprime
- `isCompletableviaSCEnobudget` reference mais inexistant -> utilise `isCompletableviaSCEwobudget`

## Workflow

1. Le scraper Node.js recupere les donnees Steam (badges, inventaire, historique) et SCE (prix, stock)
2. Les donnees sont stockees dans SQLite
3. Le front-end PHP lit SQLite et genere le rapport HTML (cartes cheres, completables, depot)
