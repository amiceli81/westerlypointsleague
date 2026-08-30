<?php
declare(strict_types=1);

// Backend for index.html's fetch()-based save/load, replacing the Claude
// Artifact publish/read capability this app originally ran on. The entire
// pool state (games, wagers, players, announcements, adjustments, week
// visibility, rules text, settings) is stored as a single JSON blob, same
// shape as the state-data script tag index.html embeds -- this endpoint
// just serves and replaces that blob.

header('Content-Type: application/json');

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    http_response_code(500);
    echo json_encode(['error' => 'not_configured', 'message' => 'config.php is missing -- copy config.php.example to config.php and fill in your database credentials.']);
    exit;
}
require $configPath;

function db(): PDO {
    global $DB_HOST, $DB_NAME, $DB_USER, $DB_PASS;
    static $pdo = null;
    if ($pdo === null) {
        $pdo = new PDO(
            "mysql:host={$DB_HOST};dbname={$DB_NAME};charset=utf8mb4",
            $DB_USER,
            $DB_PASS,
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]
        );
    }
    return $pdo;
}

$action = isset($_GET['action']) ? (string)$_GET['action'] : '';
$method = $_SERVER['REQUEST_METHOD'];

try {
    if ($action === 'state' && $method === 'GET') {
        $stmt = db()->query('SELECT version, data FROM pool_state WHERE id = 1');
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            http_response_code(500);
            echo json_encode(['error' => 'no_state', 'message' => 'pool_state has no row with id=1 -- did you run schema.sql?']);
            exit;
        }
        echo json_encode([
            'version' => (int)$row['version'],
            'data' => json_decode($row['data']),
        ]);
        exit;
    }

    if ($action === 'notify' && $method === 'POST') {
        // Generic "send one email" endpoint -- used so far for telling a
        // player the commissioner voided one of their picks. Doesn't touch
        // pool_state at all: the client already has the target email from
        // the state it loaded, so there's nothing to look up server-side.
        $raw = file_get_contents('php://input');
        $body = json_decode($raw, true);
        if (!is_array($body)) {
            http_response_code(400);
            echo json_encode(['error' => 'bad_request']);
            exit;
        }
        $providedKey = isset($body['key']) ? (string)$body['key'] : '';
        if (!hash_equals($SAVE_KEY, $providedKey)) {
            http_response_code(403);
            echo json_encode(['error' => 'forbidden']);
            exit;
        }
        $email = trim((string)($body['email'] ?? ''));
        $subject = trim((string)($body['subject'] ?? ''));
        $message = (string)($body['message'] ?? '');
        if ($email === '' || $subject === '' || $message === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            http_response_code(400);
            echo json_encode(['error' => 'bad_request']);
            exit;
        }
        $fromHost = $_SERVER['HTTP_HOST'] ?? 'localhost';
        $headers = "From: no-reply@{$fromHost}\r\nContent-Type: text/plain; charset=utf-8";
        @mail($email, $subject, $message, $headers);
        // Always the same response regardless of whether mail() actually
        // succeeded -- delivery failures shouldn't block the commissioner's
        // action (the pick is still voided either way), and there's nothing
        // useful the client could do differently on a send failure.
        echo json_encode(['ok' => true]);
        exit;
    }

    if ($action === 'request-reset' && $method === 'POST') {
        $raw = file_get_contents('php://input');
        $body = json_decode($raw, true);
        if (!is_array($body)) {
            http_response_code(400);
            echo json_encode(['error' => 'bad_request']);
            exit;
        }
        $providedKey = isset($body['key']) ? (string)$body['key'] : '';
        if (!hash_equals($SAVE_KEY, $providedKey)) {
            http_response_code(403);
            echo json_encode(['error' => 'forbidden']);
            exit;
        }
        $username = strtolower(trim((string)($body['username'] ?? '')));
        $email = strtolower(trim((string)($body['email'] ?? '')));

        $pdo = db();
        $pdo->beginTransaction();
        $stmt = $pdo->prepare('SELECT version, data FROM pool_state WHERE id = 1 FOR UPDATE');
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            $pdo->rollBack();
            http_response_code(500);
            echo json_encode(['error' => 'no_state']);
            exit;
        }
        $data = json_decode($row['data'], true);

        $matchedPlayer = null;
        foreach ($data['players'] as &$p) {
            if (($p['username'] ?? '') === $username && $email !== '' && strtolower(trim((string)($p['email'] ?? ''))) === $email) {
                $matchedPlayer =& $p;
                break;
            }
        }
        unset($p);

        if ($matchedPlayer !== null) {
            // A short numeric code emailed to the address on file -- only
            // someone with access to that inbox can complete the reset from
            // here, unlike the old version which just trusted whatever
            // email the requester typed in.
            $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
            $matchedPlayer['resetCodeHash'] = hash('sha256', $code);
            $matchedPlayer['resetCodeExpiresAt'] = gmdate('c', time() + 30 * 60);

            $newVersion = (int)$row['version'] + 1;
            $upd = $pdo->prepare('UPDATE pool_state SET version = ?, data = ? WHERE id = 1');
            $upd->execute([$newVersion, json_encode($data)]);

            $poolName = (string)($data['poolName'] ?? 'The Westerly Points League');
            $subject = $poolName . ' password reset code';
            $bodyText = "Your password reset code is: {$code}\n\nThis code expires in 30 minutes. If you didn't request a password reset, you can ignore this email.";
            $fromHost = $_SERVER['HTTP_HOST'] ?? 'localhost';
            $headers = "From: no-reply@{$fromHost}\r\nContent-Type: text/plain; charset=utf-8";
            @mail($matchedPlayer['email'], $subject, $bodyText, $headers);
        }

        $pdo->commit();
        // Same response either way -- doesn't reveal whether that
        // username/email combination actually matched an account.
        echo json_encode(['ok' => true]);
        exit;
    }

    if ($action === 'complete-reset' && $method === 'POST') {
        $raw = file_get_contents('php://input');
        $body = json_decode($raw, true);
        if (!is_array($body)) {
            http_response_code(400);
            echo json_encode(['error' => 'bad_request']);
            exit;
        }
        $providedKey = isset($body['key']) ? (string)$body['key'] : '';
        if (!hash_equals($SAVE_KEY, $providedKey)) {
            http_response_code(403);
            echo json_encode(['error' => 'forbidden']);
            exit;
        }
        $username = strtolower(trim((string)($body['username'] ?? '')));
        $code = trim((string)($body['code'] ?? ''));
        $salt = (string)($body['salt'] ?? '');
        $passwordHash = (string)($body['passwordHash'] ?? '');
        if ($username === '' || $code === '' || $salt === '' || $passwordHash === '') {
            http_response_code(400);
            echo json_encode(['error' => 'bad_request']);
            exit;
        }

        $pdo = db();
        $pdo->beginTransaction();
        $stmt = $pdo->prepare('SELECT version, data FROM pool_state WHERE id = 1 FOR UPDATE');
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            $pdo->rollBack();
            http_response_code(500);
            echo json_encode(['error' => 'no_state']);
            exit;
        }
        $data = json_decode($row['data'], true);

        $matchedPlayer = null;
        foreach ($data['players'] as &$p) {
            if (($p['username'] ?? '') === $username) {
                $matchedPlayer =& $p;
                break;
            }
        }
        unset($p);

        // The code -- not the username/email guess this replaced -- is what
        // actually authorizes the change, so this is the one place that
        // matters for keeping someone else's account safe from a teammate
        // who merely knows (or guesses) their username and email.
        $valid = $matchedPlayer !== null
            && !empty($matchedPlayer['resetCodeHash'])
            && !empty($matchedPlayer['resetCodeExpiresAt'])
            && hash_equals((string)$matchedPlayer['resetCodeHash'], hash('sha256', $code))
            && strtotime((string)$matchedPlayer['resetCodeExpiresAt']) >= time();

        if (!$valid) {
            $pdo->rollBack();
            http_response_code(400);
            echo json_encode(['error' => 'invalid_code']);
            exit;
        }

        $matchedPlayer['salt'] = $salt;
        $matchedPlayer['passwordHash'] = $passwordHash;
        unset($matchedPlayer['resetCodeHash']);
        unset($matchedPlayer['resetCodeExpiresAt']);

        $newVersion = (int)$row['version'] + 1;
        $upd = $pdo->prepare('UPDATE pool_state SET version = ?, data = ? WHERE id = 1');
        $upd->execute([$newVersion, json_encode($data)]);
        $pdo->commit();

        echo json_encode(['version' => $newVersion, 'data' => json_decode(json_encode($data))]);
        exit;
    }

    if ($action === 'save' && $method === 'POST') {
        $raw = file_get_contents('php://input');
        $body = json_decode($raw, true);
        if (!is_array($body) || !array_key_exists('version', $body) || !array_key_exists('data', $body) || !is_int($body['version'])) {
            http_response_code(400);
            echo json_encode(['error' => 'bad_request']);
            exit;
        }

        $providedKey = isset($body['key']) ? (string)$body['key'] : '';
        if (!hash_equals($SAVE_KEY, $providedKey)) {
            http_response_code(403);
            echo json_encode(['error' => 'forbidden']);
            exit;
        }

        $dataJson = json_encode($body['data']);
        if ($dataJson === false) {
            http_response_code(400);
            echo json_encode(['error' => 'bad_data']);
            exit;
        }

        $pdo = db();
        $pdo->beginTransaction();
        // FOR UPDATE takes a row lock for the duration of this transaction,
        // so two saves arriving at nearly the same moment are serialized by
        // the database rather than racing each other -- the version check
        // below is what tells the SECOND one it lost the race.
        $stmt = $pdo->prepare('SELECT version, data FROM pool_state WHERE id = 1 FOR UPDATE');
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            $pdo->rollBack();
            http_response_code(500);
            echo json_encode(['error' => 'no_state']);
            exit;
        }

        if ((int)$row['version'] !== $body['version']) {
            // Someone else saved since this client last loaded. Hand back
            // the current version/data so the client can adopt it, same as
            // the Claude Artifact's own conflict handling -- never
            // overwrite a newer save with a stale one.
            $pdo->rollBack();
            http_response_code(409);
            echo json_encode([
                'error' => 'conflict',
                'version' => (int)$row['version'],
                'data' => json_decode($row['data']),
            ]);
            exit;
        }

        $newVersion = (int)$row['version'] + 1;
        $upd = $pdo->prepare('UPDATE pool_state SET version = ?, data = ? WHERE id = 1');
        $upd->execute([$newVersion, $dataJson]);
        $pdo->commit();

        echo json_encode(['version' => $newVersion]);
        exit;
    }

    http_response_code(404);
    echo json_encode(['error' => 'not_found']);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['error' => 'server_error']);
}
