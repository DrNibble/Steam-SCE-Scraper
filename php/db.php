<?php

require_once __DIR__ . '/config.php';

/**
 * Ouvre une connexion SQLite en lecture seule
 */
function openDB(): SQLite3 {
    if (!file_exists(DB_PATH)) {
        http_response_code(500);
        die('Base de donnees introuvable. Lancez d abord le scraper Node.js (npm run sync).');
    }
    $db = new SQLite3(DB_PATH, SQLITE3_OPEN_READONLY);
    $db->enableExceptions(true);
    return $db;
}

/**
 * Recupere une meta value
 */
function getMeta(SQLite3 $db, string $key, $default = null) {
    $stmt = $db->prepare('SELECT value FROM meta WHERE key = ?');
    $stmt->bindValue(1, $key, SQLITE3_TEXT);
    $result = $stmt->execute();
    $row = $result->fetchArray(SQLITE3_ASSOC);
    return $row ? $row['value'] : $default;
}

/**
 * Recupere tous les jeux avec leurs cartes
 */
function getAllGamesWithCards(SQLite3 $db): array {
    $result = $db->query('SELECT * FROM games WHERE disabled = 0 ORDER BY appid');
    $games = [];
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
        $games[] = $row;
    }
    return $games;
}

/**
 * Recupere tous les jeux (y compris desactives)
 */
function getAllGames(SQLite3 $db): array {
    $result = $db->query('SELECT * FROM games ORDER BY appid');
    $games = [];
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
        $games[] = $row;
    }
    return $games;
}

/**
 * Nettoie le suffixe " (Trading Card)" du hash pour l'affichage
 * (le hash en DB reste brut avec le suffixe, pour les appels API Steam Market)
 */
function cleanHash(?string $hash): ?string {
    if ($hash === null) return null;
    return preg_replace('/\s*\(trading card\)\s*/i', '', $hash);
}

/**
 * Recupere les cartes d un jeu
 */
function getCardsForGame(SQLite3 $db, string $appid): array {
    $stmt = $db->prepare('SELECT * FROM cards WHERE appid = ? ORDER BY card_index');
    $stmt->bindValue(1, $appid, SQLITE3_TEXT);
    $result = $stmt->execute();
    $cards = [];
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
        $row['inv'] = json_decode($row['inv_json'] ?? '[]', true);
        $row['hash'] = cleanHash($row['hash'] ?? null);
        $cards[] = $row;
    }
    return $cards;
}
