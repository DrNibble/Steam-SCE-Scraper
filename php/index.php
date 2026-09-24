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
            // Pre-fetch asset ID + ligne carte (pour prix derniere vente <7j)
            $cards = getCardsForGame($db, $g['appid']);
            $assetId = null;
            $cardRow = null;
            foreach ($cards as $c) {
                if ($c['name'] === $exp['cardname']) {
                    $cardRow = $c;
                    if (!empty($c['inv'])) {
                        $assetId = $c['inv'][0]['id'] ?? null;
                        break;
                    }
                }
            }
            $exp['_assetId'] = $assetId;
            $exp['_card'] = $cardRow;

            // Cartes sans vente < 7j : on n affiche pas la ligne
            if ($cardRow !== null && (int)($cardRow['steam_market_sales_7d'] ?? 0) === 0) {
                continue;
            }
            $g['_expensive'] = $exp;
            $expensiveList[] = $g;
        }
    }
}
usort($expensiveList, function($a, $b) {
    $pa = (float)($a['_expensive']['_card']['steam_market_price_eur'] ?? 0);
    $pb = (float)($b['_expensive']['_card']['steam_market_price_eur'] ?? 0);
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
            'badgeCrafted' => ($g['badge_crafted'] === null ? null : (int)$g['badge_crafted']),
        ];
    }
}

// Tri : badges deja generes en fin de liste, puis peu de cartes restantes d abord
usort($completableSceList, function($a, $b) {
    // NULL (non vérifié) est trie comme 0 : en tete avec les badges a generer
    if (($a['badgeCrafted'] ?? 0) !== ($b['badgeCrafted'] ?? 0)) {
        return ($a['badgeCrafted'] ?? 0) <=> ($b['badgeCrafted'] ?? 0);
    }
    return $a['gap'] <=> $b['gap'];
});

// --- 3. FILTRE: DEPOT ---
$depositList = [];
$runningTotal = 0;
foreach ($games as $g) {
    $isCompletable = $g['is_completable_via_sce'] || $g['is_completable_via_sce_wobudget'] ||
                    $g['is_completable_via_sce_doublon'] || $g['is_completable_via_trade'];
    if ($isCompletable || $g['disabled'] || $g['has_expensive_card_json']) continue;

    $cards = getCardsForGame($db, $g['appid']);

    // Toutes les cartes owned (par appid) sont affichees dans la colonne
    // "Cartes (Inventaire)"; seules celles depositables partent dans l'envoi
    // automatique (assetIds).
    $toGive = [];
    $allOwned = [];
    foreach ($cards as $c) {
        if ((int)($c['qty'] ?? 0) <= 0) continue;

        $hashAppId = $c['hash'] ? explode('-', $c['hash'])[0] : null;
        // Donnees marche Steam: fraicheur < 24h, ventes 7j, dernier prix connu
        $priceRaw = $c['steam_market_price_eur'] ?? null;
        $marketPrice = ($priceRaw === null || $priceRaw === '') ? null : (float)$priceRaw;
        $sales7d = (int)($c['steam_market_sales_7d'] ?? 0);
        $fetchedAt = (int)($c['steam_market_fetched_at'] ?? 0);
        $marketFresh = $fetchedAt > 0 && $fetchedAt >= ((time() * 1000) - 24 * 60 * 60 * 1000);
        $botFull = (int)($c['sce_stock'] ?? 0) >= 8;

        // Depot uniquement pour les cartes SANS vente dans les 7 derniers
        // jours (marche mort) et dont le prix marche est verifie < 0,09 EUR:
        // une carte vendue dans les 7 derniers jours se vend mieux au marche
        // Steam qu au bot (credits), donc hors depot.
        $hashOk = $hashAppId === (string)$g['appid'];
        if ($hashOk && !$botFull && $marketFresh && $marketPrice !== null && (($marketPrice > 0.09 && $sales7d === 0) || ($marketPrice < 0.09 && $sales7d > 0))) {
            $c['_depositable'] = true;
            $toGive[] = $c;
        } else {
            $c['_depositable'] = false;
            $c['_noDepositReason'] = $botFull
                ? 'bot plein'
                : (!$marketFresh
                    ? 'donneés marché obsolètes'
                    : ($sales7d > 0
                        ? 'vente récente'
                        : ($marketPrice === null
                            ? 'prix non vérifié'
                            : 'prix trop élevé')));
        }
        $allOwned[] = $c;
    }
    // Compteur de exemplaires possedes par carte (pour l affichage xN)
    foreach ($allOwned as &$c) {
        $c['_ownedQty'] = !empty($c['inv']) ? count($c['inv']) : (int)($c['qty'] ?? 0);
    }
    unset($c);

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
            'ownedTotal' => (int)($g['total_owned_qty'] ?? 0),
            'setCards' => (int)($g['set_cards'] ?? 0),
            'cards' => array_values($toGive),
            'allCards' => $allOwned,
            'assetIds' => $assetIdsStr,
            'totalWorth' => $worth,
            'badgeCrafted' => ($g['badge_crafted'] === null ? null : (int)$g['badge_crafted']),
        ];
    }
}

// Tri: badges deja presents sur id/Dr_Nibble en premier, puis worth croissant
usort($depositList, function($a, $b) {
    $ca = ($a['badgeCrafted'] === 1) ? 1 : 0;
    $cb = ($b['badgeCrafted'] === 1) ? 1 : 0;
    if ($ca !== $cb) return $cb <=> $ca; // badge deja present en premier
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
        <span class="status-item">File d'attente: <?= fmt($pendingOffers) ?> offre(s)</span>
        <span class="status-item">Temps d'attente: <?= $waitTime ?> min</span>
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
                <tr><th>Jeu</th><th>Carte</th><th>Dernière vente</th></tr>
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
                    <td class="price">
                        <?php
                        if (!empty($exp['_card']) && (int)($exp['_card']['steam_market_sales_7d'] ?? 0) > 0 && $exp['_card']['steam_market_price_eur'] !== null && $exp['_card']['steam_market_price_eur'] !== ''):
                            // Vente dans les 7 derniers jours: on affiche le dernier prix vendu
                            $cardRow = $exp['_card'];
                            $fetchedAt = (int)($cardRow['steam_market_fetched_at'] ?? 0);
                            $marketFresh = $fetchedAt > 0 && $fetchedAt >= ((time() * 1000) - 24 * 60 * 60 * 1000);
                        ?>
                            <?= fmtEur($cardRow['steam_market_price_eur']) ?>
                            <?php if (($cardRow['steam_market_last_sale_price_eur'] ?? null) !== null && ($cardRow['steam_market_last_sale_price_eur'] ?? '') !== ''): ?>
                                <br><small>Dernière vente 7j : <?= fmtEur($cardRow['steam_market_last_sale_price_eur']) ?></small>
                            <?php endif; ?>
                            <?php if (!$marketFresh): ?>
                                <br><small style="color:#ff9d00;">données obsolètes</small>
                            <?php endif; ?>
                        <?php elseif (!empty($exp['_card']) && (int)($exp['_card']['steam_market_sales_7d'] ?? 0) === 0): ?>
                            <span class="stale">Pas de vente < 7j</span>
                        <?php else: ?>
                            <span class="stale">Vente < 7j non confirmee</span>
                        <?php endif; ?>
                    </td>
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
                        <?php if ($g['badgeCrafted'] === 1): ?>
                            <br><small style="color:#ff9d00;">Badge deja genere</small>
                        <?php elseif ($g['badgeCrafted'] === null): ?>
                            <br><small style="color:#8f98a0;">Badge non verifie (lancer un scan)</small>
                        <?php endif; ?>
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
                                    <small style="color:#8f98a0;"> Vente < 7j : <?= fmtEur($c['steam_market_price_eur']) ?></small>
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
                    $cardCount = $g['assetIds'] !== '' ? count(array_filter(explode(',', $g['assetIds']))) : 0;
                    $btnText = $isBotFull
                        ? 'Bot Surchargé (' . fmt($pendingOffers) . ')'
                        : 'Envoyer (' . fmt($cardCount) . ' carte' . ($cardCount > 1 ? 's' : '') . ')';
                ?>
                <tr>
                    <td>
                        <a href="https://steamcommunity.com/<?= e($profileLink) ?>/gamecards/<?= e($g['appid']) ?>/" target="_blank" class="game-link">
                            <?= e($g['name']) ?>
                        </a>
                        <?php if ($g['badgeCrafted'] === 1): ?>
                            <br><small style="color:#ff9d00;">Badge deja genere</small>
                        <?php endif; ?>
                        <br><small>Possedees: <?= fmt($g['ownedTotal']) ?> / <?= fmt($g['setCards']) ?></small>
                    </td>
                    <td>
                        <?php foreach ($g['allCards'] as $c):
                            $firstId = !empty($c['inv']) ? ($c['inv'][0]['id'] ?? '') : '';
                        ?>
                            <?php if (!empty($c['_depositable'])): ?>
                                <small>
                                    <a href="https://steamcommunity.com/<?= e($profileLink) ?>/inventory/#753_6_<?= e($firstId) ?>" target="_blank" class="inv-link">
                                        <?= e($c['name']) ?>
                                    </a>
                                    <?php if ((int)($c['_ownedQty'] ?? 1) > 1): ?>
                                        <b style="color:#fff;">(x<?= fmt($c['_ownedQty']) ?>)</b>
                                    <?php endif; ?>
                                    <?php if (hasRecentSales($c)): ?>
                                        <span style="color:#8f98a0;"> (<?= fmtEur($c['steam_market_price_eur']) ?>)</span>
                                    <?php endif; ?>
                                </small>
                            <?php else: ?>
                                <small style="opacity:0.55;">
                                    <a href="https://steamcommunity.com/<?= e($profileLink) ?>/inventory/#753_6_<?= e($firstId) ?>" target="_blank" class="inv-link">
                                        <?= e($c['name']) ?>
                                    </a>
                                    <?php if ((int)($c['_ownedQty'] ?? 1) > 1): ?>
                                        <b>(x<?= fmt($c['_ownedQty']) ?>)</b>
                                    <?php endif; ?>
                                    <?php if (hasRecentSales($c)): ?>
                                        <span style="color:#8f98a0;"> (<?= fmtEur($c['steam_market_price_eur']) ?>)</span>
                                    <?php endif; ?>
                                    <span style="color:#8f98a0;">[hors depot: <?= e($c['_noDepositReason'] ?? '') ?>]</span>
                                </small>
                            <?php endif; ?>
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

    <!-- Section: Badges desactives (repliable) -->
    <?php if (!empty($disabledTradeInList)): ?>
    <details class="section section-disabled" close>
        <summary>
            <h2>Badges Trade-In Desactive</h2>
            <span class="summary-count"><?= fmt(count($disabledTradeInList)) ?> jeu<?= count($disabledTradeInList) > 1 ? 'x' : '' ?></span>
            <span class="summary-hint">(cliquer pour replier / deplier)</span>
        </summary>
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
    </details>
    <?php endif; ?>

    <footer>
        <p>Genere le <?= date('d/m/Y H:i:s') ?> | Steam-SCE Scraper v1.0</p>
    </footer>
</body>
</html>
