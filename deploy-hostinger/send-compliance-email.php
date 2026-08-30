<?php
declare(strict_types=1);

// Computes the "Under-wagered this week" report (same rule as the
// Commissioner tab's own card in index.html: flags anyone whose total
// points wagered across this week's games is under half the balance they
// had starting this week) and emails it as a CSV to the commissioner.
//
// Meant to run on a schedule (a Hostinger cron job), NOT to be linked from
// the site. See the "Scheduling the weekly email" section in this folder's
// README.md for how to set that up -- Hostinger's cron can't be configured
// from here, so that step is on you (one-time).
//
// This duplicates pool.html's compliance-report logic in PHP, since a cron
// job has no browser to run the real JS in. If you ever change how that
// report works in pool.html (halfPointsReport(), isWeekVisible(),
// startOfWeekBalance(), etc.), update the matching logic below too --
// nothing keeps these two in sync automatically.

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "config.php is missing -- copy config.php.example to config.php first.\n");
    exit(1);
}
require $configPath;

// Change this if the report should go somewhere else. Kept as a constant
// (rather than a config.php setting) since this script has exactly one job.
const COMPLIANCE_EMAIL_TO = 'amiceli81@gmail.com';

// Running this over plain HTTP (instead of Hostinger's cron calling it
// directly as a CLI script) is supported, but only with this secret in the
// query string -- unlike SAVE_KEY, this one is never embedded in any page a
// visitor can view, so guessing it isn't realistic. Generate your own with:
//   php -r "echo bin2hex(random_bytes(24)), PHP_EOL;"
// and set it here AND in the cron job's URL as ?secret=...
const CRON_HTTP_SECRET = 'REPLACE_WITH_YOUR_OWN_RANDOM_SECRET_IF_USING_URL_CRON';

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

function csvField($v): string {
    $s = (string)$v;
    return preg_match('/[",\n]/', $s) ? '"' . str_replace('"', '""', $s) . '"' : $s;
}

// ---------- ported compliance-report logic (mirrors pool.html) ----------

function tuesdayWindowStart(DateTimeImmutable $d): DateTimeImmutable {
    // Football weeks run Tuesday-through-Monday, reckoned in America/New_York
    // (this script always runs on the server, so there's one canonical
    // timezone here -- pool.html's own JS instead uses each viewer's own
    // browser timezone, which is the best a client-side app can do).
    $day = (int)$d->format('w'); // 0=Sun..6=Sat
    $diff = ($day - 2 + 7) % 7;
    return $d->setTime(0, 0, 0)->modify("-{$diff} days");
}

function gameResult(array $g): ?array {
    if (($g['status'] ?? '') !== 'final' || $g['finalHome'] === null || $g['finalAway'] === null) return null;
    $favMargin = $g['favorite'] === 'away' ? ($g['finalAway'] - $g['finalHome']) : ($g['finalHome'] - $g['finalAway']);
    if ($favMargin > $g['spread']) $atsSide = $g['favorite'];
    elseif ($favMargin < $g['spread']) $atsSide = $g['favorite'] === 'home' ? 'away' : 'home';
    else $atsSide = 'push';
    $total = $g['finalHome'] + $g['finalAway'];
    if ($total > $g['total']) $ouSide = 'over';
    elseif ($total < $g['total']) $ouSide = 'under';
    else $ouSide = 'push';
    return ['atsSide' => $atsSide, 'ouSide' => $ouSide];
}

function wagerResult(array $w, ?array $g): string {
    if ($g === null) return 'pending';
    $gr = gameResult($g);
    if ($gr === null) return 'pending';
    $side = $w['type'] === 'ATS' ? $gr['atsSide'] : $gr['ouSide'];
    if ($side === 'push') return 'push';
    return $w['pick'] === $side ? 'win' : 'loss';
}

function weekKey(string $sport, string $week): string { return $sport . '|' . $week; }

function currentWeekWindowForSport(array $games, string $sport, DateTimeImmutable $now): ?array {
    $withKickoff = array_values(array_filter($games, fn($g) => $g['sport'] === $sport && $g['kickoff']));
    if (!$withKickoff) return null;
    $nowStart = tuesdayWindowStart($now);
    $nowEnd = $nowStart->modify('+7 days');
    foreach ($withKickoff as $g) {
        $kt = new DateTimeImmutable($g['kickoff']);
        if ($kt >= $nowStart && $kt < $nowEnd) return ['start' => $nowStart, 'end' => $nowEnd];
    }
    $past = array_values(array_filter($withKickoff, fn($g) => new DateTimeImmutable($g['kickoff']) < $nowStart));
    if (!$past) return null;
    usort($past, fn($a, $b) => new DateTimeImmutable($b['kickoff']) <=> new DateTimeImmutable($a['kickoff']));
    $s2 = tuesdayWindowStart(new DateTimeImmutable($past[0]['kickoff']));
    return ['start' => $s2, 'end' => $s2->modify('+7 days')];
}

function isWeekVisible(array $games, array $weekVisibility, string $sport, string $week, DateTimeImmutable $now): bool {
    $key = weekKey($sport, $week);
    if (array_key_exists($key, $weekVisibility)) return (bool)$weekVisibility[$key];
    $win = currentWeekWindowForSport($games, $sport, $now);
    if ($win === null) return false;
    foreach ($games as $g) {
        if ($g['sport'] !== $sport || $g['week'] !== $week || !$g['kickoff']) continue;
        $kt = new DateTimeImmutable($g['kickoff']);
        if ($kt >= $win['start'] && $kt < $win['end']) return true;
    }
    return false;
}

function displayNameFor(array $players, string $key): string {
    foreach ($players as $p) if ($p['username'] === $key) return $p['teamName'];
    return $key;
}

function main(): void {
    $tz = new DateTimeZone('America/New_York');
    $now = new DateTimeImmutable('now', $tz);

    $row = db()->query('SELECT data FROM pool_state WHERE id = 1')->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        fwrite(STDERR, "pool_state has no row with id=1.\n");
        exit(1);
    }
    $data = json_decode($row['data'], true);
    $games = $data['games'] ?? [];
    $wagers = $data['wagers'] ?? [];
    $players = $data['players'] ?? [];
    $adjustments = $data['adjustments'] ?? [];
    $weekVisibility = $data['weekVisibility'] ?? [];
    $startingBalance = (float)($data['startingBalance'] ?? 1000);
    $poolName = (string)($data['poolName'] ?? 'The Westerly Points League');

    $gamesById = [];
    foreach ($games as $g) $gamesById[$g['id']] = $g;

    $currentWeekGames = array_values(array_filter($games, function ($g) use ($games, $weekVisibility, $now) {
        return $g['kickoff'] && isWeekVisible($games, $weekVisibility, $g['sport'], $g['week'], $now);
    }));

    $labels = [];
    foreach ($currentWeekGames as $g) $labels[$g['sport'] . ' — ' . $g['week']] = true;
    ksort($labels);
    $label = implode(' / ', array_keys($labels));

    $gameIds = [];
    foreach ($currentWeekGames as $g) $gameIds[$g['id']] = true;
    $weekStart = null;
    $earliest = null;
    foreach ($currentWeekGames as $g) {
        if (!$g['kickoff']) continue;
        $kt = new DateTimeImmutable($g['kickoff']);
        if ($earliest === null || $kt < $earliest) $earliest = $kt;
    }
    if ($earliest !== null) $weekStart = tuesdayWindowStart($earliest);

    $rosterUsernames = [];
    foreach ($players as $p) $rosterUsernames[$p['username']] = true;
    foreach ($wagers as $w) $rosterUsernames[$w['player']] = true;
    $rosterUsernames = array_keys($rosterUsernames);

    $rows = [];
    foreach ($rosterUsernames as $name) {
        $net = 0;
        foreach ($wagers as $w) {
            if ($w['player'] !== $name || isset($gameIds[$w['gameId']])) continue;
            $g = $gamesById[$w['gameId']] ?? null;
            $r = wagerResult($w, $g);
            if ($r === 'win') $net += $w['points'];
            elseif ($r === 'loss') $net -= $w['points'];
        }
        $adj = 0;
        foreach ($adjustments as $a) {
            if ($a['player'] !== $name) continue;
            if ($weekStart !== null && ($a['ts'] / 1000) >= $weekStart->getTimestamp()) continue;
            $adj += $a['amount'];
        }
        $balance = $startingBalance + $net + $adj;

        $wagered = 0;
        $wagerCount = 0;
        foreach ($wagers as $w) {
            if ($w['player'] === $name && isset($gameIds[$w['gameId']])) {
                $wagered += $w['points'];
                $wagerCount++;
            }
        }
        $required = $balance / 2;
        if ($wagered < $required) {
            $rows[] = [
                'team' => displayNameFor($players, $name),
                'balance' => $balance,
                'required' => $required,
                'wagered' => $wagered,
                'wagerCount' => $wagerCount,
                'shortBy' => max(0, $required - $wagered),
            ];
        }
    }
    usort($rows, fn($a, $b) => $b['shortBy'] <=> $a['shortBy']);

    $lines = [];
    $lines[] = 'Week,' . csvField($label);
    $lines[] = implode(',', array_map('csvField', ['Team', 'Week-start balance', 'Half', 'Wagered', '# Wagers', 'Short By']));
    foreach ($rows as $r) {
        $lines[] = implode(',', array_map('csvField', [
            $r['team'], $r['balance'], round($r['required'], 1), $r['wagered'], $r['wagerCount'], round($r['shortBy'], 1),
        ]));
    }
    $csv = implode("\r\n", $lines) . "\r\n";

    $stamp = $now->format('Y-m-d');
    $subject = $poolName . ' — Under-wagered this week (' . ($label !== '' ? $label : 'no current week') . ')';
    $body = $rows
        ? "Attached: this week's under-wagered report (" . count($rows) . " player" . (count($rows) === 1 ? '' : 's') . " short).\n"
        : "Nobody is under-wagered this week -- everyone has wagered at least half their starting balance.\n";
    $body .= "\nGenerated " . $now->format('Y-m-d g:i A T') . ".\n";

    $boundary = bin2hex(random_bytes(16));
    $headers = "From: no-reply@" . (php_sapi_name() === 'cli' ? ($_SERVER['SERVER_NAME'] ?? 'localhost') : ($_SERVER['HTTP_HOST'] ?? 'localhost')) . "\r\n"
        . "MIME-Version: 1.0\r\n"
        . "Content-Type: multipart/mixed; boundary=\"{$boundary}\"\r\n";
    $message = "--{$boundary}\r\n"
        . "Content-Type: text/plain; charset=utf-8\r\n\r\n"
        . $body . "\r\n"
        . "--{$boundary}\r\n"
        . "Content-Type: text/csv; name=\"under-wagered-{$stamp}.csv\"\r\n"
        . "Content-Disposition: attachment; filename=\"under-wagered-{$stamp}.csv\"\r\n"
        . "Content-Transfer-Encoding: base64\r\n\r\n"
        . chunk_split(base64_encode($csv))
        . "--{$boundary}--\r\n";

    $sent = mail(COMPLIANCE_EMAIL_TO, $subject, $message, $headers);
    echo $sent
        ? "Sent under-wagered report to " . COMPLIANCE_EMAIL_TO . " (" . count($rows) . " flagged).\n"
        : "mail() reported failure -- check your host's mail configuration.\n";
}

main();
