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
