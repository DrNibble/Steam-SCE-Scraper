<?php

/**
 * Configuration de la connexion SQLite
 */

// Chemin vers la base SQLite (relative au dossier php/)
define('DB_PATH', __DIR__ . '/../data/es_cache.sqlite');

// Partenaire et token pour les trade offers
define('TRADE_PARTNER', '83905207');
define('TRADE_TOKEN', 'tEx7-bXd');

// Profil Steam
define('STEAM_PROFILE_PATH', 'my');

// Fonction d'echappement HTML
function e($value) {
    return htmlspecialchars($value ?? '', ENT_QUOTES, 'UTF-8');
}

// Fonction pour formater un nombre
function fmt($n) {
    return number_format((float)$n, 0, ',', ' ');
}

// Fonction pour formater un prix en EUR
function fmtEur($n) {
    return number_format((float)$n, 2, ',', ' ') . ' €';
}

// Verifie si une carte a eu au moins 1 vente dans les 7 derniers jours
// et que les donnees de prix sont fraiches (moins de 24h)
function hasRecentSales(array $card): bool {
    $price = $card['steam_market_price_eur'] ?? null;
    $sales = (int)($card['steam_market_sales_7d'] ?? 0);
    $fetchedAt = (int)($card['steam_market_fetched_at'] ?? 0);
    // Les donnees sont considerees comme fraiches si recuperees dans les dernieres 24h
    $fresh = $fetchedAt > 0 && $fetchedAt >= ((time() * 1000) - 24 * 60 * 60 * 1000);
    return $sales > 0 && $price !== null && $price !== '' && $fresh;
}
