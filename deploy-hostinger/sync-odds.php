<?php
declare(strict_types=1);

// Pulls fresh NFL/NCAAF spreads & totals for games that haven't kicked off
// yet, and final scores for games that have finished, straight from
// SportsGameOdds (api.sportsgameodds.com) -- called from Hostinger's OWN
// server. Unlike the Claude Artifact's scheduled sync (which runs inside a
// Claude-hosted environment whose network egress can block outbound calls
// to third-party APIs), this script makes its own outbound HTTP request
// directly from Hostinger, so that restriction doesn't apply here.
//
// Ports sync/sync.py's merge logic to PHP (see that script's docstring for
// the full design rationale) so this can run as a plain Hostinger cron job
// with no Python runtime and no browser involved. Only ADDS new games or
// UPDATES lines on games that are still open and haven't kicked off yet;
// NEVER touches a game that's already locked (kickoff has passed) or
// already final, and never touches wagers, player accounts, announcements,
// rules text, or anything else in pool_state. If you ever change the
// merge/settle rules in sync/sync.py, update the matching logic below too
// -- nothing keeps these two in sync automatically.
//
// One-time setup: see the "Scheduling the odds sync" section in this
// folder's README.md.

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "config.php is missing -- copy config.php.example to config.php first.\n");
    exit(1);
}
require $configPath;

if (!isset($SPORTSGAMEODDS_API_KEY) || $SPORTSGAMEODDS_API_KEY === '' || $SPORTSGAMEODDS_API_KEY === 'REPLACE_WITH_YOUR_SPORTSGAMEODDS_API_KEY') {
    fwrite(STDERR, "SPORTSGAMEODDS_API_KEY is not set in config.php -- add it and try again.\n");
    exit(1);
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

// ---------- SportsGameOdds fetch ----------

const ODD_HOME_SPREAD = 'points-home-game-sp-home';
const ODD_AWAY_SPREAD = 'points-away-game-sp-away';
const ODD_TOTAL_OVER = 'points-all-game-ou-over';
const ODD_TOTAL_UNDER = 'points-all-game-ou-under';

function fetchEvents(string $leagueId, array $extraParams): array {
    global $SPORTSGAMEODDS_API_KEY;
    $params = array_merge(['apiKey' => $SPORTSGAMEODDS_API_KEY, 'leagueID' => $leagueId, 'limit' => '100'], $extraParams);
    $url = 'https://api.sportsgameodds.com/v2/events?' . http_build_query($params);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
    ]);
    $body = curl_exec($ch);
    $err = curl_error($ch);
    curl_close($ch);
    if ($body === false) {
        fwrite(STDERR, "Fetch failed for {$leagueId}: {$err}\n");
        return [];
    }
    $decoded = json_decode($body, true);
    if (!is_array($decoded)) {
        fwrite(STDERR, "Fetch for {$leagueId} returned non-JSON.\n");
        return [];
    }
    if (($decoded['success'] ?? null) === false) {
        fwrite(STDERR, "Fetch for {$leagueId} returned an API error: " . json_encode($decoded['error'] ?? $decoded) . "\n");
        return [];
    }
    $data = $decoded['data'] ?? null;
    if (!is_array($data)) {
        fwrite(STDERR, "Fetch for {$leagueId} response did not include a 'data' list.\n");
        return [];
    }
    return $data;
}

// ---------- ported merge logic (mirrors sync/sync.py) ----------

// Both the "School Mascot" form AND the bare school name are listed for each
// program -- SportsGameOdds' teams.*.names.long field is inconsistent about
// including the mascot, and this is an exact-match set (not a substring
// check) so a bare name like "Arkansas" can be whitelisted without also
// matching an unrelated team whose name merely contains that substring.
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

function teamName($teamObj): ?string {
    if (!is_array($teamObj)) return null;
    $names = $teamObj['names'] ?? [];
    return $names['long'] ?? $names['medium'] ?? $names['short'] ?? ($teamObj['teamID'] ?? null);
}

function oddNum($oddObj, array $keys): ?float {
    if (!is_array($oddObj)) return null;
    foreach ($keys as $key) {
        if (!array_key_exists($key, $oddObj) || $oddObj[$key] === null) continue;
        if (is_numeric($oddObj[$key])) return (float)$oddObj[$key];
    }
    return null;
}

function normalizeEvent(array $event, string $sportLabel): ?array {
    $teams = $event['teams'] ?? [];
    $homeName = teamName($teams['home'] ?? null);
    $awayName = teamName($teams['away'] ?? null);
    if (!$homeName || !$awayName) return null;

    $status = $event['status'] ?? [];
    $kickoff = $status['startsAt'] ?? null;
    if (!$kickoff) return null;

    $odds = $event['odds'] ?? [];
    $homeSpread = oddNum($odds[ODD_HOME_SPREAD] ?? null, ['bookSpread', 'fairSpread']);
    if ($homeSpread === null) {
        // The two sides of a spread market mirror each other, so the away
        // side's line is an equally valid source if the home entry is absent.
        $awaySpread = oddNum($odds[ODD_AWAY_SPREAD] ?? null, ['bookSpread', 'fairSpread']);
        $homeSpread = $awaySpread !== null ? -$awaySpread : null;
    }
    $total = oddNum($odds[ODD_TOTAL_OVER] ?? null, ['bookOverUnder', 'fairOverUnder']);
    if ($total === null) {
        $total = oddNum($odds[ODD_TOTAL_UNDER] ?? null, ['bookOverUnder', 'fairOverUnder']);
    }
    if ($homeSpread === null || $total === null) return null;

    return [
        'extId' => $event['eventID'] ?? null,
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

function extractFinalScores(array $event): ?array {
    // SportsGameOdds has no separate top-level "final score" field -- once a
    // game ends, the realized value of each graded odd is written into that
    // odd's own "score" field. The two point-spread odds happen to be scoped
    // to exactly one team each, so their "score" values ARE that team's
    // final points.
    $odds = $event['odds'] ?? [];
    $homeScore = oddNum($odds[ODD_HOME_SPREAD] ?? null, ['score']);
    $awayScore = oddNum($odds[ODD_AWAY_SPREAD] ?? null, ['score']);
    if ($homeScore === null || $awayScore === null) return null;
    return [(int)$homeScore, (int)$awayScore];
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
    // is a substring of (or equal to) the other's -- catching the common
    // "School" vs "School Mascot" naming inconsistency SportsGameOdds itself
    // exhibits, as well as mismatches between different sync runs/ID schemes
    // for the same real event.
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

function mergeScores(array &$games, array $scoreEvents): array {
    // Settles any OPEN game whose SportsGameOdds event now reports
    // status.completed=true, by writing status="final" and the two final
    // scores. Never touches a game already marked final, never adds games,
    // and never touches wagers -- those settle themselves automatically in
    // the page the moment gameResult()/wagerResult() see status="final".
    $byExt = [];
    foreach ($games as $i => $g) {
        if (!empty($g['extId'])) $byExt[$g['extId']] = $i;
    }
    $settled = [];
    foreach ($scoreEvents as $ev) {
        $status = $ev['status'] ?? [];
        if (empty($status['completed'])) continue;
        $extId = $ev['eventID'] ?? null;
        $idx = ($extId !== null && isset($byExt[$extId])) ? $byExt[$extId] : null;
        if ($idx === null) {
            // Fuzzy fallback, same reasoning as mergeGames()'s own: a game
            // added back when this pool synced from a DIFFERENT odds
            // provider (this project's sync script used to run against The
            // Odds API, api.the-odds-api.com, before switching to
            // SportsGameOdds) carries that other provider's ID as its
            // extId -- it will never match a real SportsGameOdds eventID no
            // matter how the lookback window is sized. Match by team name +
            // kickoff date instead so it can still be found and settled.
            $teams = $ev['teams'] ?? [];
            $evAsGame = [
                'sport' => $ev['sport'] ?? null,
                'kickoff' => $status['startsAt'] ?? null,
                'home' => teamName($teams['home'] ?? null),
                'away' => teamName($teams['away'] ?? null),
            ];
            foreach ($games as $i => $g) {
                if (($g['status'] ?? '') === 'final') continue;
                if (sameMatchup($g, $evAsGame)) { $idx = $i; break; }
            }
        }
        if ($idx === null || ($games[$idx]['status'] ?? '') === 'final') continue;
        $scores = extractFinalScores($ev);
        if ($scores === null) continue;
        [$homeScore, $awayScore] = $scores;
        $games[$idx]['status'] = 'final';
        $games[$idx]['finalHome'] = $homeScore;
        $games[$idx]['finalAway'] = $awayScore;
        // Adopt the event's real extId too, so future runs match it directly.
        if ($extId !== null) $games[$idx]['extId'] = $extId;
        $settled[] = sprintf('%s %s @ %s (%d-%d)', $games[$idx]['sport'] ?? '', $games[$idx]['away'] ?? '', $games[$idx]['home'] ?? '', $awayScore, $homeScore);
    }
    return $settled;
}

function loadGamesReadOnly(PDO $pdo): array {
    $row = $pdo->query('SELECT data FROM pool_state WHERE id = 1')->fetch(PDO::FETCH_ASSOC);
    if (!$row) return [];
    $data = json_decode($row['data'], true);
    return $data['games'] ?? [];
}

function earliestStuckKickoff(array $games): ?DateTimeImmutable {
    // The oldest kickoff, among games still sitting as non-final on our own
    // board, that's already in the past -- i.e. a game that SHOULD have
    // settled by now but hasn't. Used to size the scores lookback window so
    // a sync gap of any length (the cron job down for a week, say) can't
    // permanently strand a game as unsettled by aging it out of a fixed
    // rolling window.
    $now = new DateTimeImmutable('now');
    $earliest = null;
    foreach ($games as $g) {
        if (($g['status'] ?? '') === 'final' || empty($g['kickoff'])) continue;
        try {
            $kt = new DateTimeImmutable($g['kickoff']);
        } catch (Throwable $e) {
            continue;
        }
        if ($kt >= $now) continue;
        if ($earliest === null || $kt < $earliest) $earliest = $kt;
    }
    return $earliest;
}

function main(): void {
    // Opened here (a plain read, no lock yet) so the scores lookback window
    // below can size itself off our own board's data. Reused later for the
    // actual write -- opening the connection early doesn't hold anything
    // open; only the FOR UPDATE transaction near the bottom does that, and
    // it still only wraps the short, in-memory-only save step.
    $pdo = db();
    $earlyGames = loadGamesReadOnly($pdo);
    $stuckSince = earliestStuckKickoff($earlyGames);

    // All network calls happen BEFORE the database transaction below, so a
    // slow or failing SportsGameOdds request never holds a row lock open
    // and blocks a player's pick or signup from saving in the meantime.
    $normalized = [];
    $rawCount = 0;
    foreach (['NFL', 'NCAAF'] as $sport) {
        $events = fetchEvents($sport, ['oddsAvailable' => 'true', 'started' => 'false']);
        $rawCount += count($events);
        foreach ($events as $e) {
            if ($sport === 'NCAAF') {
                $homeN = teamName($e['teams']['home'] ?? null);
                $awayN = teamName($e['teams']['away'] ?? null);
                if (!isNcaafTopProgram($homeN) && !isNcaafTopProgram($awayN)) continue;
            }
            $n = normalizeEvent($e, $sport);
            if ($n) $normalized[] = $n;
        }
    }
    echo "Fetched {$rawCount} raw odds events, " . count($normalized) . " normalized after filtering.\n";

    // Normally just a 3-day rolling window (plenty for a job that runs every
    // couple of hours). But if some non-final game on our own board already
    // kicked off earlier than that, widen the window back to just before
    // that game's kickoff instead -- otherwise a sync gap (the cron job
    // down for a few days, say) could let a stuck game age out of a fixed
    // window and never settle. Capped at 30 days back so one bad/garbage
    // kickoff timestamp can't blow up the query.
    $defaultLookback = (new DateTimeImmutable('now'))->modify('-3 days');
    $maxLookback = (new DateTimeImmutable('now'))->modify('-30 days');
    if ($stuckSince !== null && $stuckSince->modify('-1 day') < $defaultLookback) {
        $lookbackStart = $stuckSince->modify('-1 day');
        if ($lookbackStart < $maxLookback) $lookbackStart = $maxLookback;
    } else {
        $lookbackStart = $defaultLookback;
    }
    $scoresStartsAfter = $lookbackStart->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');

    $scoreEvents = [];
    foreach (['NFL', 'NCAAF'] as $sport) {
        $events = fetchEvents($sport, ['ended' => 'true', 'startsAfter' => $scoresStartsAfter]);
        foreach ($events as $e) {
            $e['sport'] = $sport; // used by mergeScores()'s fuzzy fallback
            $scoreEvents[] = $e;
        }
    }
    echo "Fetched " . count($scoreEvents) . " candidate ended events for settlement (lookback since {$scoresStartsAfter}).\n";

    // Read-only diagnostic: pass ?debugExtId=... (or --debug-ext-id=... on
    // the CLI) to see exactly what SportsGameOdds reported for one specific
    // game's extId, without touching the database at all. Handy for "why
    // didn't game X settle" questions.
    $debugExtId = null;
    if (PHP_SAPI === 'cli') {
        foreach ($GLOBALS['argv'] as $arg) {
            if (str_starts_with($arg, '--debug-ext-id=')) $debugExtId = substr($arg, strlen('--debug-ext-id='));
        }
    } else {
        $debugExtId = isset($_GET['debugExtId']) ? (string)$_GET['debugExtId'] : null;
    }
    if ($debugExtId !== null && $debugExtId !== '') {
        $found = null;
        foreach ($scoreEvents as $ev) {
            if (($ev['eventID'] ?? null) === $debugExtId) { $found = $ev; break; }
        }
        if ($found === null) {
            echo "DEBUG: extId {$debugExtId} was NOT among the " . count($scoreEvents) . " ended events SportsGameOdds returned for this run (lookback since {$scoresStartsAfter}).\n";
            echo "DEBUG: either this game kicked off before that lookback start, or SportsGameOdds hasn't marked it ended yet.\n";

            // Also try the same team+date fuzzy match mergeScores() itself
            // falls back to -- catches the case where this extId is stale
            // (e.g. left over from the old Odds API this project used
            // before switching to SportsGameOdds) and the real game is
            // among the fetched events under a DIFFERENT eventID.
            $boardGame = null;
            foreach ($earlyGames as $g) {
                if (($g['extId'] ?? null) === $debugExtId) { $boardGame = $g; break; }
            }
            if ($boardGame === null) {
                echo "DEBUG: (couldn't even find a game with that extId on the board itself to compare against.)\n";
            } else {
                $fuzzyMatch = null;
                foreach ($scoreEvents as $ev) {
                    $teams = $ev['teams'] ?? [];
                    $evAsGame = [
                        'sport' => $ev['sport'] ?? null,
                        'kickoff' => ($ev['status'] ?? [])['startsAt'] ?? null,
                        'home' => teamName($teams['home'] ?? null),
                        'away' => teamName($teams['away'] ?? null),
                    ];
                    if (sameMatchup($boardGame, $evAsGame)) { $fuzzyMatch = $ev; break; }
                }
                if ($fuzzyMatch === null) {
                    echo "DEBUG: no team+date fuzzy match either -- \"" . ($boardGame['away'] ?? '?') . " @ " . ($boardGame['home'] ?? '?') . "\" (kickoff {$boardGame['kickoff']}) genuinely isn't among the {$boardGame['sport']} ended events this run.\n";
                } else {
                    echo "DEBUG: FOUND a team+date fuzzy match under a DIFFERENT eventID -- \"" . ($boardGame['away'] ?? '?') . " @ " . ($boardGame['home'] ?? '?') . "\" matches this ended event:\n";
                    echo json_encode($fuzzyMatch, JSON_PRETTY_PRINT) . "\n";
                    echo "DEBUG: this confirms extId {$debugExtId} on the board is stale/foreign -- a normal (non-debug) run's mergeScores() fuzzy fallback will settle this using eventID " . ($fuzzyMatch['eventID'] ?? '?') . " instead.\n";
                }
            }
        } else {
            echo "DEBUG: found extId {$debugExtId} in the ended events:\n";
            echo json_encode($found, JSON_PRETTY_PRINT) . "\n";
            $completed = ($found['status']['completed'] ?? null) === true;
            echo "DEBUG: status.completed = " . ($completed ? 'true' : 'false (not settled yet by SportsGameOdds)') . "\n";
            if ($completed) {
                $scores = extractFinalScores($found);
                echo "DEBUG: extractFinalScores() = " . ($scores === null ? 'null (missing/unparseable score field on the odds object)' : json_encode($scores)) . "\n";
            }
        }
        echo "DEBUG: no database changes made -- exiting before the save step.\n";
        return;
    }

    try {
        $pdo->beginTransaction();
        // FOR UPDATE takes a row lock for the duration of this (short,
        // in-memory-only) transaction, same as api.php's own save action.
        $stmt = $pdo->prepare('SELECT version, data FROM pool_state WHERE id = 1 FOR UPDATE');
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            $pdo->rollBack();
            fwrite(STDERR, "pool_state has no row with id=1 -- did you run schema.sql?\n");
            exit(1);
        }
        $data = json_decode($row['data'], true);
        $games = $data['games'] ?? [];

        [$added, $updated] = mergeGames($games, $normalized);
        echo "Games added: {$added}, updated: {$updated}\n";

        $settled = mergeScores($games, $scoreEvents);
        echo "Games settled: " . count($settled) . "\n";
        foreach ($settled as $line) echo "  {$line}\n";

        if ($added === 0 && $updated === 0 && count($settled) === 0) {
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

try {
    main();
} catch (Throwable $e) {
    fwrite(STDERR, "sync-odds.php failed: " . $e->getMessage() . "\n");
    exit(1);
}
