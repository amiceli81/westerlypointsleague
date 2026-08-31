<?php
declare(strict_types=1);

// Pulls fresh NFL/NCAAF spreads & totals for games that haven't kicked off
// yet, straight from SharpAPI (api.sharpapi.io) -- called from Hostinger's
// OWN server, so the Claude Artifact's own network egress restrictions
// (which can block outbound calls to third-party APIs from that side) don't
// apply here.
//
// This does NOT settle games automatically. SharpAPI's only source of final
// scores (its "Game State" endpoints) is Enterprise-tier only and is
// documented as live-game-state data, not a durable final-result record --
// too shaky a foundation to build automatic settlement on. Games are
// settled manually instead, via the Commissioner tab's existing "Settle"
// form in pool.html (enter the final score, click Settle) -- this was a
// deliberate choice, not a missing feature.
//
// Only ever ADDS new games or UPDATES lines on games that are still open
// and haven't kicked off yet; NEVER touches a game that's already locked
// (kickoff passed) or already final, and never touches wagers, player
// accounts, announcements, rules text, or anything else in pool_state.
//
// One-time setup: see the "Scheduling the odds sync" section in this
// folder's README.md.

// STDERR isn't reliably defined outside a genuine CLI process -- some
// hosts' cron wrappers invoke a script through something other than a
// plain `php` CLI call, where fwrite(STDERR, ...) itself throws
// "Undefined constant STDERR" and masks whatever error it was trying to
// report. This never touches STDERR: it prints to stdout (captured by the
// run-log wrapper below when called from inside main()) and, for the two
// fatal checks below that happen before that wrapper starts, also writes
// straight to the log file itself so a cron-only failure is never silent.
function fatalLog(string $msg): void {
    echo $msg . "\n";
    @file_put_contents(__DIR__ . '/sync-odds-run.log', '[' . gmdate('Y-m-d H:i:s') . ' UTC] ' . $msg . "\n", FILE_APPEND | LOCK_EX);
    exit(1);
}

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    fatalLog('config.php is missing -- copy config.php.example to config.php first.');
}
require $configPath;

if (!isset($SHARPAPI_KEY) || $SHARPAPI_KEY === '' || $SHARPAPI_KEY === 'REPLACE_WITH_YOUR_SHARPAPI_KEY') {
    fatalLog('SHARPAPI_KEY is not set in config.php -- add it and try again.');
}

// Same HTTP-cron guard pattern as send-compliance-email.php: running this
// over plain HTTP is supported, but only with this secret in the query
// string. Direct CLI execution (Hostinger's cron calling this script
// itself) needs no secret. Generate your own with:
//   php -r "echo bin2hex(random_bytes(24)), PHP_EOL;"
const CRON_HTTP_SECRET = 'b6aadf609ee78771e325d5f0f713351ad72bc554936631eb';

if (PHP_SAPI !== 'cli') {
    $provided = isset($_GET['secret']) ? (string)$_GET['secret'] : '';
    if (CRON_HTTP_SECRET === 'REPLACE_WITH_YOUR_OWN_RANDOM_SECRET_IF_USING_URL_CRON' || !hash_equals(CRON_HTTP_SECRET, $provided)) {
        http_response_code(403);
        echo "forbidden\n";
        exit(1);
    }
    header('Content-Type: text/plain');
}

function db(): PDO {
    global $DB_HOST, $DB_NAME, $DB_USER, $DB_PASS;
    return new PDO(
        "mysql:host={$DB_HOST};dbname={$DB_NAME};charset=utf8mb4",
        $DB_USER,
        $DB_PASS,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
}

// ---------- SharpAPI fetch ----------

// Free tier only includes DraftKings + FanDuel -- DraftKings picked as the
// one consistent book the app displays a single line from (matches how the
// old SportsGameOdds integration always showed one line per game, not a
// book-by-book comparison).
const SHARPAPI_SPORTSBOOK = 'draftkings';

function fetchSharpOdds(string $league): array {
    // league is SharpAPI's lowercase league id ('nfl' or 'ncaaf').
    global $SHARPAPI_KEY;
    $allRows = [];
    $offset = 0;
    for ($page = 0; $page < 20; $page++) { // safety cap against a pagination loop bug
        $params = [
            'sport' => 'football',
            'league' => $league,
            'market' => 'point_spread,total_points',
            'sportsbook' => SHARPAPI_SPORTSBOOK,
            'limit' => '500',
            'offset' => (string)$offset,
        ];
        $url = 'https://api.sharpapi.io/api/v1/odds?' . http_build_query($params);
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_HTTPHEADER => ['X-API-Key: ' . $SHARPAPI_KEY, 'Accept: application/json'],
        ]);
        $body = curl_exec($ch);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false) {
            echo "Fetch failed for {$league}: {$err}\n";
            break;
        }
        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            echo "Fetch for {$league} returned non-JSON.\n";
            break;
        }
        if (isset($decoded['error'])) {
            echo "Fetch for {$league} returned an API error: " . json_encode($decoded['error']) . "\n";
            break;
        }
        $data = $decoded['data'] ?? null;
        if (!is_array($data)) {
            echo "Fetch for {$league} response did not include a 'data' list.\n";
            break;
        }
        $allRows = array_merge($allRows, $data);
        $pagination = $decoded['pagination'] ?? [];
        if (empty($pagination['has_more'])) break;
        $next = $pagination['next_offset'] ?? null;
        if ($next === null) break;
        $offset = (int)$next;
    }
    return $allRows;
}

// ---------- ported merge logic (mirrors sync/sync.py's odds-only half) ----------

// Both the "School Mascot" form AND the bare school name are listed for each
// program -- team-name fields are inconsistent about including the mascot
// across sources, and this is an exact-match set (not a substring check) so
// a bare name like "Arkansas" can be whitelisted without also matching an
// unrelated team whose name merely contains that substring.
$NCAAF_TOP_PROGRAMS = array_fill_keys([
    "Georgia Bulldogs","Georgia","Texas Longhorns","Texas","Ohio State Buckeyes","Ohio State",
    "Michigan Wolverines","Michigan","Alabama Crimson Tide","Alabama","LSU Tigers","LSU",
    "Oregon Ducks","Oregon","Penn State Nittany Lions","Penn State",
    "Notre Dame Fighting Irish","Notre Dame","Clemson Tigers","Clemson",
    "Florida State Seminoles","Florida State","Miami Hurricanes","Miami","Miami (FL)",
    "Texas A&M Aggies","Texas A&M","Oklahoma Sooners","Oklahoma","Tennessee Volunteers","Tennessee",
    "USC Trojans","USC","Washington Huskies","Washington","Wisconsin Badgers","Wisconsin",
    "Iowa Hawkeyes","Iowa","Utah Utes","Utah",
    "Kansas State Wildcats","Kansas State","Baylor Bears","Baylor","TCU Horned Frogs","TCU",
    "Ole Miss Rebels","Ole Miss","Auburn Tigers","Auburn","South Carolina Gamecocks","South Carolina",
    "Missouri Tigers","Missouri","North Carolina Tar Heels","North Carolina",
    "NC State Wolfpack","NC State","NC State Wolfpack Football","North Carolina State",
    "Virginia Tech Hokies","Virginia Tech","Louisville Cardinals","Louisville",
    "Pittsburgh Panthers","Pittsburgh","Pitt","Michigan State Spartans","Michigan State",
    "Nebraska Cornhuskers","Nebraska","Illinois Fighting Illini","Illinois",
    "Minnesota Golden Gophers","Minnesota","Arizona State Sun Devils","Arizona State",
    "Arizona Wildcats","Arizona","UCLA Bruins","UCLA","Colorado Buffaloes","Colorado",
    "BYU Cougars","BYU","Oklahoma State Cowboys","Oklahoma State",
    "Texas Tech Red Raiders","Texas Tech","West Virginia Mountaineers","West Virginia",
    "Kansas Jayhawks","Kansas","Cincinnati Bearcats","Cincinnati","Houston Cougars","Houston",
    "UCF Knights","UCF","Duke Blue Devils","Duke","Georgia Tech Yellow Jackets","Georgia Tech",
    "Vanderbilt Commodores","Vanderbilt","Kentucky Wildcats","Kentucky",
    "Arkansas Razorbacks","Arkansas","Mississippi State Bulldogs","Mississippi State",
    "Rutgers Scarlet Knights","Rutgers","Maryland Terrapins","Maryland",
    "Indiana Hoosiers","Indiana","Purdue Boilermakers","Purdue","Northwestern Wildcats","Northwestern",
    "Boston College Eagles","Boston College","Wake Forest Demon Deacons","Wake Forest",
    "Syracuse Orange","Syracuse","Stanford Cardinal","Stanford",
    "California Golden Bears","California","Cal","SMU Mustangs","SMU",
], true);

function isNcaafTopProgram(?string $name): bool {
    global $NCAAF_TOP_PROGRAMS;
    return $name !== null && isset($NCAAF_TOP_PROGRAMS[$name]);
}

function groupOddsRowsByEvent(array $rows): array {
    // SharpAPI's /odds returns one row per (event, market, selection) --
    // e.g. 4 rows for one game (point_spread home, point_spread away,
    // total_points over, total_points under). Group back into one entry
    // per event before extracting the actual spread/total numbers.
    $byEvent = [];
    foreach ($rows as $r) {
        $eid = $r['event_id'] ?? null;
        if ($eid === null) continue;
        $byEvent[$eid][] = $r;
    }
    return $byEvent;
}

function normalizeSharpEvent(string $eventId, array $rows, string $sportLabel): ?array {
    $homeName = null;
    $awayName = null;
    $kickoff = null;
    $homeSpread = null;
    $total = null;
    foreach ($rows as $r) {
        if ($homeName === null) $homeName = $r['home_team'] ?? null;
        if ($awayName === null) $awayName = $r['away_team'] ?? null;
        if ($kickoff === null) $kickoff = $r['event_start_time'] ?? null;
        $marketType = $r['market_type'] ?? null;
        $selectionType = $r['selection_type'] ?? null;
        $line = $r['line'] ?? null;
        if ($line === null) continue;
        if ($marketType === 'point_spread' && $selectionType === 'home') {
            $homeSpread = (float)$line;
        } elseif ($marketType === 'point_spread' && $selectionType === 'away' && $homeSpread === null) {
            // Mirror fallback if the home-side row is missing for some
            // reason -- the two sides of a spread market mirror each other.
            $homeSpread = -(float)$line;
        }
        if ($marketType === 'total_points' && ($selectionType === 'over' || $selectionType === 'under')) {
            $total = (float)$line;
        }
    }
    if (!$homeName || !$awayName || !$kickoff || $homeSpread === null || $total === null) return null;

    return [
        'extId' => $eventId,
        'sport' => $sportLabel,
        'week' => null, // filled in by assignWeekNumbers(), once per sport
        'away' => $awayName,
        'home' => $homeName,
        'favorite' => $homeSpread < 0 ? 'home' : 'away',
        'spread' => abs($homeSpread),
        'total' => $total,
        'kickoff' => $kickoff,
    ];
}

function weekTuesdayStart(DateTimeImmutable $d): DateTimeImmutable {
    // Football weeks run Tuesday-through-Monday, bucketed by US Eastern
    // calendar day so a Sunday/Monday night kickoff (already past midnight
    // UTC) doesn't get shuffled into the following week.
    $ny = $d->setTimezone(new DateTimeZone('America/New_York'))->setTime(0, 0, 0);
    $dow = (int)$ny->format('N'); // 1=Mon..7=Sun
    $diff = ($dow - 2 + 7) % 7; // days back to the most recent Tuesday
    return $ny->modify("-{$diff} days");
}

function assignWeekNumbers(array &$games, string $sportLabel): void {
    // Numbers a sport's weeks sequentially ("Week 1", "Week 2", ...) anchored
    // to the earliest kickoff across every game of that sport currently
    // known, not to the calendar -- so numbering stays stable across runs
    // regardless of when the real season happens to start.
    $indices = [];
    foreach ($games as $i => $g) {
        if (($g['sport'] ?? null) === $sportLabel && !empty($g['kickoff'])) $indices[] = $i;
    }
    if (!$indices) return;
    $weekStarts = [];
    $anchor = null;
    foreach ($indices as $i) {
        $ws = weekTuesdayStart(new DateTimeImmutable($games[$i]['kickoff']));
        $weekStarts[$i] = $ws;
        if ($anchor === null || $ws < $anchor) $anchor = $ws;
    }
    foreach ($indices as $i) {
        $days = ($weekStarts[$i]->getTimestamp() - $anchor->getTimestamp()) / 86400;
        $n = (int)round($days / 7) + 1;
        $games[$i]['week'] = "Week {$n}";
    }
}

function isLocked(array $g): bool {
    if (($g['status'] ?? '') === 'final') return true;
    if (!empty($g['kickoff'])) {
        $kt = new DateTimeImmutable($g['kickoff']);
        return (new DateTimeImmutable('now')) >= $kt;
    }
    return false;
}

function normName(?string $name): string {
    return preg_replace('/[^a-z0-9]/', '', strtolower($name ?? ''));
}

function sameMatchup(array $a, array $b): bool {
    // Two games are the "same" real-world matchup if they're the same
    // sport, kicked off on the same calendar day, and each side's team name
    // is a substring of (or equal to) the other's -- catches team-name
    // formatting differences and ID-scheme mismatches between sync runs.
    if (($a['sport'] ?? null) !== ($b['sport'] ?? null)) return false;
    $ak = $a['kickoff'] ?? null;
    $bk = $b['kickoff'] ?? null;
    if (!$ak || !$bk || substr($ak, 0, 10) !== substr($bk, 0, 10)) return false;
    $ah = normName($a['home'] ?? null);
    $aa = normName($a['away'] ?? null);
    $bh = normName($b['home'] ?? null);
    $ba = normName($b['away'] ?? null);
    $homeMatch = $ah !== '' && $bh !== '' && (strpos($bh, $ah) !== false || strpos($ah, $bh) !== false);
    $awayMatch = $aa !== '' && $ba !== '' && (strpos($ba, $aa) !== false || strpos($aa, $ba) !== false);
    return $homeMatch && $awayMatch;
}

function findExistingMatchIndex(array $existingGames, array $byExt, array $f): ?int {
    // Exact extId match first; falls back to a fuzzy team+date match so a
    // fetch that happens to carry a different extId for a game already on
    // the board updates that row instead of creating a duplicate listing of
    // the same real-world game.
    if (isset($byExt[$f['extId']])) return $byExt[$f['extId']];
    foreach ($existingGames as $i => $g) {
        if (sameMatchup($g, $f)) return $i;
    }
    return null;
}

function mergeGames(array &$games, array $fetched): array {
    $byExt = [];
    foreach ($games as $i => $g) {
        if (!empty($g['extId'])) $byExt[$g['extId']] = $i;
    }
    $nextOrder = -1;
    foreach ($games as $g) { $nextOrder = max($nextOrder, (int)($g['order'] ?? 0)); }
    $nextOrder++;
    $added = 0;
    $updated = 0;
    foreach ($fetched as $f) {
        $idx = findExistingMatchIndex($games, $byExt, $f);
        if ($idx === null) {
            $f['id'] = 'sync-' . $f['extId'];
            $f['status'] = 'open';
            $f['finalHome'] = null;
            $f['finalAway'] = null;
            $f['order'] = $nextOrder++;
            $games[] = $f;
            $byExt[$f['extId']] = count($games) - 1;
            $added++;
        } elseif (!isLocked($games[$idx])) {
            $games[$idx]['extId'] = $f['extId'];
            $byExt[$f['extId']] = $idx;
            $games[$idx]['favorite'] = $f['favorite'];
            $games[$idx]['spread'] = $f['spread'];
            $games[$idx]['total'] = $f['total'];
            $games[$idx]['kickoff'] = $f['kickoff'];
            $games[$idx]['away'] = $f['away'];
            $games[$idx]['home'] = $f['home'];
            $updated++;
        }
    }
    $sports = [];
    foreach ($games as $g) { if (!empty($g['sport'])) $sports[$g['sport']] = true; }
    foreach (array_keys($sports) as $sport) assignWeekNumbers($games, $sport);
    return [$added, $updated];
}

function main(): void {
    $normalized = [];
    $rawCount = 0;
    foreach (['nfl', 'ncaaf'] as $league) {
        $sportLabel = strtoupper($league); // 'NFL' / 'NCAAF' -- matches pool.html's sport labels
        $rows = fetchSharpOdds($league);
        $rawCount += count($rows);
        $byEvent = groupOddsRowsByEvent($rows);
        foreach ($byEvent as $eventId => $eventRows) {
            if ($sportLabel === 'NCAAF') {
                $homeN = $eventRows[0]['home_team'] ?? null;
                $awayN = $eventRows[0]['away_team'] ?? null;
                if (!isNcaafTopProgram($homeN) && !isNcaafTopProgram($awayN)) continue;
            }
            $n = normalizeSharpEvent((string)$eventId, $eventRows, $sportLabel);
            if ($n) $normalized[] = $n;
        }
    }
    echo "Fetched {$rawCount} raw odds rows, " . count($normalized) . " normalized events after filtering.\n";

    $pdo = db();
    try {
        $pdo->beginTransaction();
        // FOR UPDATE takes a row lock for the duration of this (short,
        // in-memory-only) transaction, same as api.php's own save action.
        $stmt = $pdo->prepare('SELECT version, data FROM pool_state WHERE id = 1 FOR UPDATE');
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            $pdo->rollBack();
            echo "pool_state has no row with id=1 -- did you run schema.sql?\n";
            exit(1);
        }
        $data = json_decode($row['data'], true);
        $games = $data['games'] ?? [];

        [$added, $updated] = mergeGames($games, $normalized);
        echo "Games added: {$added}, updated: {$updated}\n";

        if ($added === 0 && $updated === 0) {
            $pdo->rollBack();
            echo "No changes -- nothing to save.\n";
            return;
        }

        $data['games'] = $games;
        $newVersion = (int)$row['version'] + 1;
        $upd = $pdo->prepare('UPDATE pool_state SET version = ?, data = ? WHERE id = 1');
        $upd->execute([$newVersion, json_encode($data)]);
        $pdo->commit();
        echo "Saved as version {$newVersion}.\n";
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

// Every run's output also gets appended to a log file sitting right next
// to this script (blocked from direct HTTP access by .htaccess, same as
// config.php) -- so "did the cron job actually run" is always answerable
// by just opening this file in File Manager, without needing SSH access or
// having to get a shell redirect's home-directory path exactly right in
// the cron command itself.
$failed = false;
$failMessage = '';
ob_start();
try {
    main();
} catch (Throwable $e) {
    $failed = true;
    $failMessage = $e->getMessage();
    echo "FAILED: {$failMessage}\n";
}
$output = ob_get_clean();
echo $output;
$logLine = '[' . gmdate('Y-m-d H:i:s') . ' UTC] ' . str_replace("\n", "\n  ", rtrim($output)) . "\n";
@file_put_contents(__DIR__ . '/sync-odds-run.log', $logLine, FILE_APPEND | LOCK_EX);
if ($failed) {
    // Already captured above (both echoed and written to the log file) --
    // no separate STDERR write here, since that constant isn't reliably
    // defined outside a genuine CLI process (see the fatalLog() note near
    // the top of this file).
    exit(1);
}
