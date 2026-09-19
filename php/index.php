<?php

require_once __DIR__ . '/db.php';

$db = openDB();

// --- Recuperation des donnees globales ---
$currentCredit = (int)getMeta($db, 'scecredit', '0');
$pendingOffers = (int)getMeta($db, 'scePendingOffers', '0');
$waitTime = (float)getMeta($db, 'sceWaitTime', '0');
$lastTrade = (int)getMeta($db, 'lasttrade', '0');
$creditRemaining = 100 - $currentCredit;

// --- Recuperation des jeux ---
$allGames = getAllGames($db);
$games = getAllGamesWithCards($db);

// --- 1. FILTRE: CARTES CHERES ---
$expensiveList = [];
foreach ($allGames as $g) {
    if ($g['has_expensive_card_json']) {
        $exp = json_decode($g['has_expensive_card_json'], true);
        if ($exp && !empty($exp['isOwned'])) {
            // Pre-fetch asset ID
            $cards = getCardsForGame($db, $g['appid']);
            $assetId = null;
            foreach ($cards as $c) {
                if ($c['name'] === $exp['cardname'] && !empty($c['inv'])) {
                    $assetId = $c['inv'][0]['id'] ?? null;
                    break;
                }
            }
            $exp['_assetId'] = $assetId;
            $g['_expensive'] = $exp;
            $expensiveList[] = $g;
        }
    }
}
usort($expensiveList, function($a, $b) {
    $pa = (float)($a['_expensive']['marketeurprice'] ?? 0);
    $pb = (float)($b['_expensive']['marketeurprice'] ?? 0);
    return $pb <=> $pa;
});

// --- 2. FILTRE: COMPLETABLES VIA SCE ---
$completableSceList = [];
foreach ($games as $g) {
    if (!$g['is_completable_via_sce'] && !$g['is_completable_via_sce_doublon']) continue;

    $cards = getCardsForGame($db, $g['appid']);
    $setCardsTotal = (int)($g['set_cards'] ?? 0);
    $currentTotalOwned = (int)($g['total_owned_qty'] ?? 0);
    $gap = max(0, $setCardsTotal - $currentTotalOwned);

    $availableOnSce = array_filter($cards, function($c) use ($g) {
        $hashAppId = $c['hash'] ? explode('-', $c['hash'])[0] : null;
        return $hashAppId === (string)$g['appid'] && (int)($c['sce_stock'] ?? 0) > 1;
    });

    usort($availableOnSce, function($a, $b) {
        return ((int)($a['sce_price'] ?? 0)) <=> ((int)($b['sce_price'] ?? 0));
    });

    $tempCredit = $currentCredit;
    $cardsToBuy = [];
    $totalCost = 0;

    foreach ($availableOnSce as $card) {
        $botStockAvailable = (int)($card['sce_stock'] ?? 0) - 1;
        while ($botStockAvailable >= 1 && count($cardsToBuy) < $gap && $tempCredit >= (int)($card['sce_price'] ?? 0)) {
            $cardsToBuy[] = $card;
            $totalCost += (int)($card['sce_price'] ?? 0);
            $tempCredit -= (int)($card['sce_price'] ?? 0);
            $botStockAvailable--;
        }
    }

    if (count($cardsToBuy) > 0) {
        $completableSceList[] = [
            'name' => $g['gamename'],
            'appid' => $g['appid'],
            'ownedTotal' => $currentTotalOwned,
            'setCards' => $setCardsTotal,
            'gap' => $gap,
            'collectable' => $cardsToBuy,
            'totalCost' => $totalCost,
        ];
    }
}

// --- 3. FILTRE: DEPOT ---
$depositList = [];
$runningTotal = 0;
foreach ($games as $g) {
    $isCompletable = $g['is_completable_via_sce'] || $g['is_completable_via_sce_wobudget'] ||
                    $g['is_completable_via_sce_doublon'] || $g['is_completable_via_trade'];
    if ($isCompletable || $g['disabled'] || $g['has_expensive_card_json']) continue;

    $cards = getCardsForGame($db, $g['appid']);
    $toGive = array_filter($cards, function($c) use ($g) {
        $hashAppId = $c['hash'] ? explode('-', $c['hash'])[0] : null;
        // Utiliser le prix marche Steam en EUR (uniquement si ventes recentes et prix connu)
        if (!hasRecentSales($c)) return false;
        $marketPrice = (float)($c['steam_market_price_eur'] ?? 0);
        return $hashAppId === (string)$g['appid'] &&
               (int)($c['qty'] ?? 0) > 0 &&
               (int)($c['sce_stock'] ?? 0) < 8 &&
               $marketPrice < 0.09;
    });

    $worth = 0;
    foreach ($toGive as $c) {
        $cardValue = (int)($c['sce_worth'] ?? 0);
        $quantity = (int)($c['qty'] ?? 0);
        $worth += ($cardValue * $quantity);
    }

    $assetIds = [];
    foreach ($toGive as $c) {
        if (!empty($c['inv'])) {
            foreach ($c['inv'] as $item) {
                if (!empty($item['id'])) $assetIds[] = $item['id'];
            }
        }
    }
    $assetIdsStr = implode(',', $assetIds);

    if ($worth > 0 && $assetIdsStr !== '') {
        $depositList[] = [
            'name' => $g['gamename'],
            'appid' => $g['appid'],
            'cards' => array_values($toGive),
            'assetIds' => $assetIdsStr,
            'totalWorth' => $worth,
        ];
    }
}

usort($depositList, function($a, $b) {
    return $a['totalWorth'] <=> $b['totalWorth'];
});

$filteredDeposit = [];
foreach ($depositList as $g) {
    if ($runningTotal + $g['totalWorth'] <= $creditRemaining) {
        $runningTotal += $g['totalWorth'];
        $filteredDeposit[] = $g;
    }
}
$depositList = $filteredDeposit;

// --- 4. FILTRE: BADGES DISABLES ---
$disabledTradeInList = [];
foreach ($allGames as $g) {
    if (!$g['disabled']) continue;
    $cards = getCardsForGame($db, $g['appid']);
    $fullCards = array_filter($cards, function($c) {
        return (int)($c['sce_stock'] ?? 0) >= 8;
    });
    $disabledTradeInList[] = [
        'name' => $g['gamename'] ?? 'Jeu Inconnu (' . $g['appid'] . ')',
        'appid' => $g['appid'],
        'fullCards' => array_values($fullCards),
    ];
}
usort($disabledTradeInList, function($a, $b) {
    return strcmp($a['name'] ?? '', $b['name'] ?? '');
});

// Ferme la DB - toutes les donnees sont en memoire
$db->close();

// --- Compteur de cartes pour regrouper ---
function countCards(array $arr): array {
    $result = [];
    foreach ($arr as $card) {
        $name = $card['name'] ?? '';
        if (!isset($result[$name])) {
            $result[$name] = ['data' => $card, 'count' => 0];
        }
        $result[$name]['count']++;
    }
    return $result;
}

$profileLink = STEAM_PROFILE_PATH;
?>
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rapport d'Optimisation SCE</title>
    <link rel="stylesheet" href="style.css">
    <script>
    function autoSend(ids) {
        if(!ids) return;
        var formattedIds = ids.toString().replace(/,/g, ';');
        var baseUrl = "https://steamcommunity.com/tradeoffer/new/?partner=<?= e(TRADE_PARTNER) ?>&token=<?= e(TRADE_TOKEN) ?>";
        var finalUrl = baseUrl + "&source=SCEBot&you=" + formattedIds + "&them=";
        window.open(finalUrl, '_blank');
    }
    </script>
</head>
<body>
    <div class="header">
        <h1>Rapport d'Optimisation SCE</h1>
        <div class="credit-badge"><?= fmt($currentCredit) ?> credits</div>
    </div>

    <div class="status-bar">
        <?php if ($pendingOffers > 0): ?>
            <span class="status-item">File d'attente: <?= fmt($pendingOffers) ?> offres</span>
        <?php endif; ?>
        <?php if ($waitTime > 0): ?>
            <span class="status-item">Temps d'attente: <?= $waitTime ?> min</span>
        <?php endif; ?>
        <?php if ($lastTrade > 0): ?>
            <span class="status-item">Dernier trade: <?= date('d/m/Y H:i', (int)($lastTrade / 1000)) ?></span>
        <?php endif; ?>
        <span class="status-item">Jeux en base: <?= count($allGames) ?></span>
    </div>

    <!-- Section: Cartes de Valeur -->
    <section>
        <h2>Cartes de Valeur (&gt; 0,14€ Market)</h2>
        <?php if (empty($expensiveList)): ?>
            <p class="empty">Aucune carte de valeur trouvee.</p>
        <?php else: ?>
        <table>
            <thead>
                <tr><th>Jeu</th><th>Carte</th><th>Prix Market</th></tr>
            </thead>
            <tbody>
                <?php foreach ($expensiveList as $g):
                    $exp = $g['_expensive'];
                    $assetId = $exp['_assetId'] ?? null;
                ?>
                <tr>
                    <td>
                        <a href="https://steamcommunity.com/<?= e($profileLink) ?>/gamecards/<?= e($g['appid']) ?>/" target="_blank" class="game-link">
                            <?= e($g['gamename']) ?>
                        </a>
                    </td>
                    <td>
                        <?php if ($assetId): ?>
                            <a href="https://steamcommunity.com/<?= e($profileLink) ?>/inventory/#753_6_<?= e($assetId) ?>" target="_blank" class="inv-link">
                                <?= e($exp['cardname']) ?>
                            </a>
                        <?php else: ?>
                            <?= e($exp['cardname']) ?>
                        <?php endif; ?>
                    </td>
                    <td class="price"><?= fmtEur($exp['marketeurprice']) ?></td>
                </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
        <?php endif; ?>
    </section>

    <!-- Section: Completables via SCE -->
    <section>
        <h2>Completables via SCE (Budgetise: <?= fmt($currentCredit) ?>c dispo)</h2>
        <?php if (empty($completableSceList)): ?>
            <p class="empty">Aucun badge completable actuellement.</p>
        <?php else: ?>
        <table>
            <thead>
                <tr><th>Jeu</th><th>Besoin / Cout</th><th>Cartes achetables (Stock &gt; 1)</th></tr>
            </thead>
            <tbody>
                <?php foreach ($completableSceList as $g): ?>
                <tr>
                    <td>
                        <a href="https://steamcommunity.com/<?= e($profileLink) ?>/gamecards/<?= e($g['appid']) ?>/" target="_blank" class="game-link">
                            <?= e($g['name']) ?>
                        </a>
                        <br><small>Possedees: <?= fmt($g['ownedTotal']) ?> / <?= fmt($g['setCards']) ?></small>
                    </td>
                    <td>
                        <b class="price">Encore <?= fmt($g['gap']) ?> a prendre</b><br>
                        <span class="price">Cout : -<?= fmt($g['totalCost']) ?>c</span>
                    </td>
                    <td>
                        <?php foreach (countCards($g['collectable']) as $itemName => $item):
                            $c = $item['data'];
                            $isNew = ((int)($c['qty'] ?? 0)) === 0;
                            $color = $isNew ? '#a3d200' : '#8f98a0';
                        ?>
                            <a href="<?= e($c['sce_quick_trade'] ?? '') ?>" target="_blank" class="btn-link"
                               style="border-color: <?= e($color) ?>; color: <?= e($color) ?>;">
                                <?= $isNew ? 'NOUV' : '+' ?> <?= e($itemName) ?>
                                <?= $item['count'] > 1 ? '<b>(x' . fmt($item['count']) . ')</b>' : '' ?>
                                [<?= fmt($c['sce_price']) ?>c]
                                <?php if (hasRecentSales($c)): ?>
                                    <small style="color:#8f98a0;"> (<?= fmtEur($c['steam_market_price_eur']) ?>)</small>
                                <?php endif; ?>
                            </a>
                        <?php endforeach; ?>
                    </td>
                </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
        <?php endif; ?>
    </section>

    <!-- Section: A deposer au Bot -->
    <section>
        <h2>A deposer au Bot (Max +<?= fmt($creditRemaining) ?>c)</h2>
        <?php if (empty($depositList)): ?>
            <p class="empty">Aucune carte a deposer.</p>
        <?php else: ?>
        <table>
            <thead>
                <tr><th>Jeu</th><th>Cartes (Inventaire)</th><th>Action Automatique</th></tr>
            </thead>
            <tbody>
                <?php foreach ($depositList as $g):
                    $isBotFull = $pendingOffers > 50;
                    $btnStyle = $isBotFull
                        ? 'background:#444;color:#888;cursor:not-allowed;border:1px solid #555;'
                        : 'background:#2e4b73;color:#fff;cursor:pointer;border:1px solid #446899;';
                    $btnDisabled = $isBotFull ? 'disabled' : '';
                    $cardCount = count($g['cards']);
                    $btnText = $isBotFull
                        ? 'Bot Surchargé (' . fmt($pendingOffers) . ')'
                        : 'Envoyer (' . fmt($cardCount) . ' carte' . ($cardCount > 1 ? 's' : '') . ')';
                ?>
                <tr>
                    <td>
                        <a href="https://steamcommunity.com/<?= e($profileLink) ?>/gamecards/<?= e($g['appid']) ?>/" target="_blank" class="game-link">
                            <?= e($g['name']) ?>
                        </a>
                    </td>
                    <td>
                        <?php foreach ($g['cards'] as $c):
                            $firstId = !empty($c['inv']) ? ($c['inv'][0]['id'] ?? '') : '';
                        ?>
                            <small>
                                <a href="https://steamcommunity.com/<?= e($profileLink) ?>/inventory/#753_6_<?= e($firstId) ?>" target="_blank" class="inv-link">
                                    <?= e($c['name']) ?>
                                </a>
                                <?php if (hasRecentSales($c)): ?>
                                    <span style="color:#8f98a0;"> (<?= fmtEur($c['steam_market_price_eur']) ?>)</span>
                                <?php endif; ?>
                            </small>
                        <?php endforeach; ?>
                    </td>
                    <td>
                        <button class="btn-send" onclick="autoSend('<?= e($g['assetIds']) ?>')"
                            <?= $btnDisabled ?>
                            style="<?= e($btnStyle) ?>">
                            <?= $btnText ?>
                        </button>
                    </td>
                </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
        <?php endif; ?>
    </section>

    <!-- Section: Badges desactives -->
    <?php if (!empty($disabledTradeInList)): ?>
    <section class="section-disabled">
        <h2>Badges Trade-In Desactive</h2>
        <table>
            <thead>
                <tr><th>Jeu</th><th>Cartes en stock complet (Stock &ge; 8)</th></tr>
            </thead>
            <tbody>
                <?php foreach ($disabledTradeInList as $g): ?>
                <tr>
                    <td>
                        <a href="https://steamcommunity.com/<?= e($profileLink) ?>/gamecards/<?= e($g['appid']) ?>/" target="_blank" class="game-link">
                            <?= e($g['name']) ?>
                        </a>
                    </td>
                    <td>
                        <?php foreach ($g['fullCards'] as $c): ?>
                            <small><?= e($c['name']) ?> (stock: <?= fmt($c['sce_stock']) ?>)</small>
                        <?php endforeach; ?>
                    </td>
                </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
    </section>
    <?php endif; ?>

    <footer>
        <p>Genere le <?= date('d/m/Y H:i:s') ?> | Steam-SCE Scraper v1.0</p>
    </footer>
</body>
</html>
