<?php
declare(strict_types=1);

// Lottery upstream result bridge (loads if present)
if (is_file(__DIR__ . '/_lottery_upstream.php')) {
    require_once __DIR__ . '/_lottery_upstream.php';
}

function api_config(): array
{
    static $config = null;
    if ($config === null) {
        $config = require __DIR__ . '/config.php';
        date_default_timezone_set($config['timezone'] ?? 'Asia/Kolkata');
    }
    return $config;
}
api_config(); // Initialize config and set timezone immediately on boot!

function api_storage_dir(): string
{
    $dir = __DIR__ . '/storage';
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }
    return $dir;
}

function api_now_ms(): int
{
    return (int) floor(microtime(true) * 1000);
}

function api_json_flags(): int
{
    $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
    if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) {
        $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
    }
    return $flags;
}

function api_headers(string $contentType = 'application/json; charset=utf-8'): void
{
    header('Content-Type: ' . $contentType);
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Headers: Authorization, Content-Type, Accept, X-Requested-With');
    header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
    header('Cache-Control: no-cache, no-store, must-revalidate');
}

function api_emit($payload, int $status = 200): void
{
    $payload = api_strip_stale_game_login_url($payload);
    http_response_code($status);
    api_headers();
    $bearer = (string) ($GLOBALS['api_issue_token'] ?? '');
    if ($bearer === '' && !empty($GLOBALS['api_user_matched_by_token'])) {
        $bearer = api_request_token();
    }
    if ($bearer !== '' && !headers_sent()) {
        header('Authorization: Bearer ' . $bearer);
        header('Access-Control-Expose-Headers: Authorization');
        // Hand the same member identity to the game page even when it is opened
        // directly (e.g. /Wingo_1M or a bookmarked link) instead of via Play.
        // Same-origin cookie: no JS/CORS changes needed.
        if (empty($_COOKIE['ar_g_token']) || (string) $_COOKIE['ar_g_token'] !== $bearer) {
            $secure = (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off')
                || strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
            setcookie('ar_g_token', $bearer, [
                'expires' => time() + 2592000,
                'path' => '/',
                'secure' => $secure,
                'httponly' => true,
                'samesite' => 'Lax',
            ]);
        }
    }
    echo json_encode($payload, api_json_flags());
    exit;
}

function api_success($data = null, array $extra = []): array
{
    if (is_array($data) && isset($data['token']) && is_string($data['token']) && $data['token'] !== '') {
        api_issue_bearer($data['token']);
    }
    return array_merge([
        'data' => $data,
        'code' => 0,
        'msg' => 'Succeed',
        'msgCode' => 0,
        'serverTime' => api_now_ms(),
    ], $extra);
}

function api_error(string $message, int $msgCode = 500, int $code = -1, $data = null): array
{
    return [
        'data' => $data,
        'code' => $code,
        'msg' => $message,
        'msgCode' => $msgCode,
        'serverTime' => api_now_ms(),
    ];
}

function api_normalize_endpoint(?string $path = null): string
{
    if ($path === null || $path === '') {
        $uri = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
        $path = preg_replace('#^/api/#i', '', (string) $uri);
    }
    $path = urldecode((string) $path);
    $path = str_replace('\\', '/', $path);
    $path = preg_replace('#^/?api/#i', '', $path);
    $path = preg_replace('/\?.*$/', '', $path);
    $path = preg_replace('/\.(php|html|json)$/i', '', $path);
    $path = trim($path, "/ \t\n\r\0\x0B");

    $parts = [];
    foreach (explode('/', $path) as $part) {
        if ($part === '' || $part === '.' || $part === '..') {
            continue;
        }
        $parts[] = $part;
    }
    return implode('/', $parts);
}

function api_request_input(): array
{
    $raw = file_get_contents('php://input') ?: '';
    $body = [];
    if ($raw !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
            $body = $decoded;
        } else {
            parse_str($raw, $parsed);
            if (is_array($parsed)) {
                $body = $parsed;
            }
        }
    }

    $query = $_GET;
    unset($query['path']);
    return [
        'query' => $query,
        'body' => $body,
        'raw' => $raw,
        'params' => array_merge($query, $body),
    ];
}

function api_param(array $input, string $key, $default = null)
{
    return $input['params'][$key] ?? $default;
}

function api_pdo(): ?PDO
{
    static $pdo = false;
    if ($pdo !== false) {
        return $pdo;
    }

    $GLOBALS['db_connection_error'] = '';
    $pdo = null;
    $config = api_config();
    $db = $config['db'] ?? [];
    $driver = strtolower((string) ($db['driver'] ?? 'auto'));
    $mysql = $db['mysql'] ?? [];
    $hasMysqlConfig = !empty($mysql['database']) && !empty($mysql['username']);

    if ($driver === 'mysql' || ($driver === 'auto' && $hasMysqlConfig)) {
        try {
            $dsn = sprintf(
                'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
                $mysql['host'] ?? 'localhost',
                $mysql['port'] ?? '3306',
                $mysql['database'] ?? ''
            );
            $pdo = new PDO($dsn, $mysql['username'] ?? '', $mysql['password'] ?? '', [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
        } catch (Throwable $e) {
            $GLOBALS['db_connection_error'] = $e->getMessage();
            if ($driver === 'mysql') {
                $pdo = null;
            }
        }
    }

    if (!$pdo) {
        try {
            $sqlitePath = $db['sqlite_path'] ?? (__DIR__ . '/storage/dhaniwin.sqlite');
            $sqliteDir = dirname($sqlitePath);
            if (!is_dir($sqliteDir)) {
                @mkdir($sqliteDir, 0775, true);
            }
            $pdo = new PDO('sqlite:' . $sqlitePath, null, null, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
        } catch (Throwable $e) {
            $pdo = null;
        }
    }

    if ($pdo instanceof PDO) {
        api_ensure_schema($pdo);
    }
    return $pdo;
}

function api_db_driver(?PDO $pdo = null): string
{
    $pdo = $pdo ?: api_pdo();
    if (!$pdo) {
        return 'none';
    }
    return (string) $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
}

function api_ensure_schema(PDO $pdo): void
{
    static $done = [];
    $key = spl_object_hash($pdo);
    if (isset($done[$key])) {
        return;
    }
    $done[$key] = true;

    $driver = api_db_driver($pdo);
    // Ensure essential admin & permission tables exist regardless of whether api_users existed
    try {
        if ($driver === 'mysql') {
            $pdo->exec("CREATE TABLE IF NOT EXISTS admin_roles (
                id INT AUTO_INCREMENT PRIMARY KEY,
                role_name VARCHAR(50) NOT NULL UNIQUE,
                role_label VARCHAR(100) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

            $pdo->exec("CREATE TABLE IF NOT EXISTS admin_permissions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                permission_key VARCHAR(50) NOT NULL UNIQUE,
                permission_label VARCHAR(100) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

            $pdo->exec("CREATE TABLE IF NOT EXISTS role_permissions (
                role_id INT NOT NULL,
                permission_id INT NOT NULL,
                PRIMARY KEY (role_id, permission_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

            $pdo->exec("CREATE TABLE IF NOT EXISTS admin_user_permissions (
                admin_id INT NOT NULL,
                permission_id INT NOT NULL,
                PRIMARY KEY (admin_id, permission_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

            $pdo->exec("CREATE TABLE IF NOT EXISTS admin_users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(120) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                role_id INT NOT NULL,
                email VARCHAR(190) NULL,
                status TINYINT(1) NOT NULL DEFAULT 1,
                remember_token VARCHAR(100) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

            // Seed default permissions if empty
            try {
                $cnt = (int)$pdo->query("SELECT COUNT(*) FROM admin_permissions")->fetchColumn();
                if ($cnt === 0) {
                    $perms = [
                        [1, 'dashboard', 'Access Dashboard'],
                        [2, 'user_management', 'Manage Users'],
                        [3, 'finance', 'Manage Deposits & Withdrawals'],
                        [4, 'support', 'Support Ticketing'],
                        [5, 'game_control', 'Control Games & Results'],
                        [6, 'agent_management', 'Manage Agents & Commissions'],
                        [7, 'reports', 'Generate Reports'],
                        [8, 'settings', 'Site Settings & Maintenance'],
                        [9, 'security', 'IP Block & Security Logs'],
                        [10, 'user_control', 'Targeted User Win-Rate Control']
                    ];
                    $stmtP = $pdo->prepare("INSERT IGNORE INTO admin_permissions (id, permission_key, permission_label) VALUES (?, ?, ?)");
                    foreach ($perms as $p) {
                        $stmtP->execute($p);
                    }
                }
            } catch (Throwable $e) {}
        } else {
            $pdo->exec("CREATE TABLE IF NOT EXISTS admin_user_permissions (
                admin_id INTEGER NOT NULL,
                permission_id INTEGER NOT NULL,
                PRIMARY KEY (admin_id, permission_id)
            )");
        }
    } catch (Throwable $e) {}

    // Check if base schema is already loaded
    try {
        $pdo->query("SELECT 1 FROM api_users LIMIT 1");
        return;
    } catch (Throwable $e) {
        // Base tables do not exist, proceed to create full tables below
    }

    $driver = api_db_driver($pdo);
    if ($driver === 'mysql') {
        $pdo->exec("CREATE TABLE IF NOT EXISTS api_responses (
            id INT AUTO_INCREMENT PRIMARY KEY,
            endpoint VARCHAR(190) NOT NULL UNIQUE,
            method VARCHAR(20) NOT NULL DEFAULT 'ALL',
            content LONGTEXT NOT NULL,
            content_type VARCHAR(80) NOT NULL DEFAULT 'application/json',
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            notes TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS api_users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id BIGINT NOT NULL UNIQUE,
            username VARCHAR(120) NOT NULL,
            nickname VARCHAR(120) NOT NULL,
            phone VARCHAR(60) NULL,
            wallet_balance DECIMAL(18,4) NOT NULL DEFAULT 0,
            game_balance DECIMAL(18,4) NOT NULL DEFAULT 4.45,
            can_bet TINYINT(1) NOT NULL DEFAULT 1,
            password VARCHAR(255) NULL,
            token VARCHAR(255) NULL,
            token_expire BIGINT NULL,
            referrer_id BIGINT NULL,
            status TINYINT(1) NOT NULL DEFAULT 1,
            vipLevel INT NOT NULL DEFAULT 0,
            raw_json LONGTEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS api_settings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            setting_key VARCHAR(160) NOT NULL UNIQUE,
            setting_value LONGTEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_audit (
            id INT AUTO_INCREMENT PRIMARY KEY,
            action VARCHAR(120) NOT NULL,
            target VARCHAR(190) NULL,
            payload LONGTEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS lottery_results (
            id INT AUTO_INCREMENT PRIMARY KEY,
            game_code VARCHAR(80) NOT NULL,
            lottery_code VARCHAR(80) NOT NULL,
            issue_number VARCHAR(80) NOT NULL,
            premium VARCHAR(255) NOT NULL,
            number_value VARCHAR(40) NULL,
            color VARCHAR(80) NULL,
            sum_value INT NULL,
            source VARCHAR(40) NOT NULL DEFAULT 'auto',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_lottery_result (game_code, issue_number)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS lottery_bets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_no VARCHAR(80) NOT NULL UNIQUE,
            user_id BIGINT NOT NULL,
            game_code VARCHAR(80) NOT NULL,
            lottery_code VARCHAR(80) NOT NULL,
            issue_number VARCHAR(80) NOT NULL,
            amount DECIMAL(18,4) NOT NULL DEFAULT 0,
            bet_multiple DECIMAL(18,4) NOT NULL DEFAULT 1,
            bet_count INT NOT NULL DEFAULT 1,
            stake_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
            bet_content LONGTEXT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'pending',
            result_premium VARCHAR(255) NULL,
            win_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
            profit_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
            settled_at TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_lottery_bets_game_issue (game_code, issue_number),
            INDEX idx_lottery_bets_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS payment_methods (
            id INT AUTO_INCREMENT PRIMARY KEY,
            method_name VARCHAR(120) NOT NULL,
            method_type VARCHAR(40) NOT NULL DEFAULT 'UPI',
            account_name VARCHAR(160) NULL,
            account_value VARCHAR(220) NULL,
            qr_text TEXT NULL,
            min_amount DECIMAL(18,4) NOT NULL DEFAULT 100,
            max_amount DECIMAL(18,4) NOT NULL DEFAULT 50000,
            sort_order INT NOT NULL DEFAULT 0,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS recharge_orders (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_no VARCHAR(80) NOT NULL UNIQUE,
            user_id BIGINT NOT NULL,
            method_id INT NULL,
            method_name VARCHAR(120) NULL,
            amount DECIMAL(18,4) NOT NULL DEFAULT 0,
            status VARCHAR(40) NOT NULL DEFAULT 'Pending',
            utr VARCHAR(120) NULL,
            raw_json LONGTEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS withdraw_orders (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_no VARCHAR(80) NOT NULL UNIQUE,
            user_id BIGINT NOT NULL,
            withdraw_type VARCHAR(80) NOT NULL DEFAULT 'UPI',
            amount DECIMAL(18,4) NOT NULL DEFAULT 0,
            status VARCHAR(40) NOT NULL DEFAULT 'Pending',
            account_json LONGTEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS wheel_spins (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id BIGINT NOT NULL,
            wheel_type VARCHAR(40) NOT NULL DEFAULT 'invited',
            reward_type INT NOT NULL DEFAULT 1,
            prize_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
            is_win TINYINT(1) NOT NULL DEFAULT 1,
            raw_json LONGTEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_wheel_spins_user (user_id),
            INDEX idx_wheel_spins_type (wheel_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS site_blocks (
            id INT AUTO_INCREMENT PRIMARY KEY,
            block_type VARCHAR(40) NOT NULL DEFAULT 'ip',
            block_value VARCHAR(190) NOT NULL,
            reason TEXT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_site_block (block_type, block_value)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS site_popups (
            id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(190) NOT NULL,
            content TEXT NULL,
            image_url TEXT NULL,
            jump_type INT NOT NULL DEFAULT 3,
            jump_link TEXT NULL,
            jump_page INT NOT NULL DEFAULT 12,
            frequency INT NOT NULL DEFAULT 3,
            sort_order INT NOT NULL DEFAULT 100,
            is_force TINYINT(1) NOT NULL DEFAULT 0,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_staff (
            id INT AUTO_INCREMENT PRIMARY KEY,
            staff_name VARCHAR(120) NOT NULL,
            staff_role VARCHAR(40) NOT NULL DEFAULT 'agent',
            phone VARCHAR(80) NULL,
            share_code VARCHAR(80) NULL,
            commission_rate DECIMAL(10,4) NOT NULL DEFAULT 0,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $stmt = $pdo->prepare("INSERT IGNORE INTO api_users (user_id, username, nickname, phone, wallet_balance, game_balance, can_bet) VALUES (132257, 'local_member', 'MemberNNGKLPHA', '919119098026', 0, 4.45, 1)");
        $stmt->execute();
        $stmt = $pdo->prepare("INSERT IGNORE INTO payment_methods (id, method_name, method_type, account_name, account_value, qr_text, min_amount, max_amount, sort_order, enabled) VALUES (400101, 'PhonePe', 'UPI', 'Dhani Win', 'rajputajay22266-1@oksbi', 'upi://pay?pa=rajputajay22266-1@oksbi&pn=Dhani%20Win&cu=INR', 100, 50000, 10, 1)");
        $stmt->execute();

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_roles (
            id INT AUTO_INCREMENT PRIMARY KEY,
            role_name VARCHAR(50) NOT NULL UNIQUE,
            role_label VARCHAR(100) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_permissions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            permission_key VARCHAR(50) NOT NULL UNIQUE,
            permission_label VARCHAR(100) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS role_permissions (
            role_id INT NOT NULL,
            permission_id INT NOT NULL,
            PRIMARY KEY (role_id, permission_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_user_permissions (
            admin_id INT NOT NULL,
            permission_id INT NOT NULL,
            PRIMARY KEY (admin_id, permission_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(120) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            role_id INT NOT NULL,
            email VARCHAR(190) NULL,
            status TINYINT(1) NOT NULL DEFAULT 1,
            remember_token VARCHAR(100) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_login_history (
            id INT AUTO_INCREMENT PRIMARY KEY,
            admin_id INT NOT NULL,
            ip_address VARCHAR(45) NOT NULL,
            user_agent TEXT NULL,
            status VARCHAR(20) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_activity_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            admin_id INT NOT NULL,
            action VARCHAR(120) NOT NULL,
            target VARCHAR(190) NULL,
            before_state LONGTEXT NULL,
            after_state LONGTEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS usdt_methods (
            id INT AUTO_INCREMENT PRIMARY KEY,
            wallet_name VARCHAR(100) NOT NULL,
            wallet_address VARCHAR(255) NOT NULL,
            network VARCHAR(50) NOT NULL DEFAULT 'TRC20',
            qr_text TEXT NULL,
            min_amount DECIMAL(18,4) NOT NULL DEFAULT 10,
            max_amount DECIMAL(18,4) NOT NULL DEFAULT 10000,
            sort_order INT NOT NULL DEFAULT 0,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS user_control (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id BIGINT NOT NULL UNIQUE,
            win_rate_percent INT NOT NULL DEFAULT 50,
            total_bets_checked INT NOT NULL DEFAULT 0,
            status TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS agent_commissions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id BIGINT NOT NULL,
            from_user_id BIGINT NOT NULL,
            bet_order_no VARCHAR(80) NOT NULL,
            commission_level INT NOT NULL,
            bet_amount DECIMAL(18,4) NOT NULL,
            commission_amount DECIMAL(18,4) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS wallet_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id BIGINT NOT NULL,
            type VARCHAR(50) NOT NULL,
            amount DECIMAL(18,4) NOT NULL,
            balance_before DECIMAL(18,4) NOT NULL,
            balance_after DECIMAL(18,4) NOT NULL,
            notes TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS result_queue (
            id INT AUTO_INCREMENT PRIMARY KEY,
            game_code VARCHAR(80) NOT NULL,
            issue_number VARCHAR(80) NOT NULL,
            premium VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_res_queue (game_code, issue_number)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS game_settings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            game_code VARCHAR(80) NOT NULL UNIQUE,
            house_edge_percent DECIMAL(5,2) NOT NULL DEFAULT 2.00,
            kill_switch TINYINT(1) NOT NULL DEFAULT 0,
            default_mode VARCHAR(20) NOT NULL DEFAULT 'auto_hedge',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS gift_codes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            code VARCHAR(80) NOT NULL UNIQUE,
            prize_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
            max_redeem INT NOT NULL DEFAULT 1,
            redeemed_count INT NOT NULL DEFAULT 0,
            expired_at TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS support_tickets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id BIGINT NOT NULL,
            title VARCHAR(255) NOT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'open',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS ticket_replies (
            id INT AUTO_INCREMENT PRIMARY KEY,
            ticket_id INT NOT NULL,
            sender_type VARCHAR(20) NOT NULL,
            sender_id BIGINT NOT NULL,
            message TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    } else {
        $pdo->exec("CREATE TABLE IF NOT EXISTS api_responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            endpoint TEXT NOT NULL UNIQUE,
            method TEXT NOT NULL DEFAULT 'ALL',
            content TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'application/json',
            enabled INTEGER NOT NULL DEFAULT 1,
            notes TEXT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS api_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            username TEXT NOT NULL,
            nickname TEXT NOT NULL,
            phone TEXT NULL,
            wallet_balance REAL NOT NULL DEFAULT 0,
            game_balance REAL NOT NULL DEFAULT 4.45,
            can_bet INTEGER NOT NULL DEFAULT 1,
            password TEXT NULL,
            token TEXT NULL,
            token_expire INTEGER NULL,
            referrer_id INTEGER NULL,
            status INTEGER NOT NULL DEFAULT 1,
            vipLevel INTEGER NOT NULL DEFAULT 0,
            raw_json TEXT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS api_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            setting_key TEXT NOT NULL UNIQUE,
            setting_value TEXT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            target TEXT NULL,
            payload TEXT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS lottery_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_code TEXT NOT NULL,
            lottery_code TEXT NOT NULL,
            issue_number TEXT NOT NULL,
            premium TEXT NOT NULL,
            number_value TEXT NULL,
            color TEXT NULL,
            sum_value INTEGER NULL,
            source TEXT NOT NULL DEFAULT 'auto',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(game_code, issue_number)
        )");

        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_lottery_results_game_issue ON lottery_results (game_code, issue_number)");

        $pdo->exec("CREATE TABLE IF NOT EXISTS lottery_bets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL,
            game_code TEXT NOT NULL,
            lottery_code TEXT NOT NULL,
            issue_number TEXT NOT NULL,
            amount REAL NOT NULL DEFAULT 0,
            bet_multiple REAL NOT NULL DEFAULT 1,
            bet_count INTEGER NOT NULL DEFAULT 1,
            stake_amount REAL NOT NULL DEFAULT 0,
            bet_content TEXT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            result_premium TEXT NULL,
            win_amount REAL NOT NULL DEFAULT 0,
            profit_amount REAL NOT NULL DEFAULT 0,
            settled_at TEXT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_lottery_bets_game_issue ON lottery_bets (game_code, issue_number)");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_lottery_bets_user ON lottery_bets (user_id)");

        $pdo->exec("CREATE TABLE IF NOT EXISTS payment_methods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            method_name TEXT NOT NULL,
            method_type TEXT NOT NULL DEFAULT 'UPI',
            account_name TEXT NULL,
            account_value TEXT NULL,
            qr_text TEXT NULL,
            min_amount REAL NOT NULL DEFAULT 100,
            max_amount REAL NOT NULL DEFAULT 50000,
            sort_order INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS recharge_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL,
            method_id INTEGER NULL,
            method_name TEXT NULL,
            amount REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'Pending',
            utr TEXT NULL,
            raw_json TEXT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS withdraw_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL,
            withdraw_type TEXT NOT NULL DEFAULT 'UPI',
            amount REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'Pending',
            account_json TEXT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS wheel_spins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            wheel_type TEXT NOT NULL DEFAULT 'invited',
            reward_type INTEGER NOT NULL DEFAULT 1,
            prize_amount REAL NOT NULL DEFAULT 0,
            is_win INTEGER NOT NULL DEFAULT 1,
            raw_json TEXT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_wheel_spins_user ON wheel_spins (user_id)");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_wheel_spins_type ON wheel_spins (wheel_type)");

        $pdo->exec("CREATE TABLE IF NOT EXISTS site_blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            block_type TEXT NOT NULL DEFAULT 'ip',
            block_value TEXT NOT NULL,
            reason TEXT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(block_type, block_value)
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS site_popups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NULL,
            image_url TEXT NULL,
            jump_type INTEGER NOT NULL DEFAULT 3,
            jump_link TEXT NULL,
            jump_page INTEGER NOT NULL DEFAULT 12,
            frequency INTEGER NOT NULL DEFAULT 3,
            sort_order INTEGER NOT NULL DEFAULT 100,
            is_force INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_staff (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            staff_name TEXT NOT NULL,
            staff_role TEXT NOT NULL DEFAULT 'agent',
            phone TEXT NULL,
            share_code TEXT NULL,
            commission_rate REAL NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $stmt = $pdo->prepare("INSERT OR IGNORE INTO api_users (user_id, username, nickname, phone, wallet_balance, game_balance, can_bet) VALUES (132257, 'local_member', 'MemberNNGKLPHA', '919119098026', 0, 4.45, 1)");
        $stmt->execute();
        $stmt = $pdo->prepare("INSERT OR IGNORE INTO payment_methods (id, method_name, method_type, account_name, account_value, qr_text, min_amount, max_amount, sort_order, enabled) VALUES (400101, 'PhonePe', 'UPI', 'Dhani Win', 'rajputajay22266-1@oksbi', 'upi://pay?pa=rajputajay22266-1@oksbi&pn=Dhani%20Win&cu=INR', 100, 50000, 10, 1)");
        $stmt->execute();

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role_name TEXT NOT NULL UNIQUE,
            role_label TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_permissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            permission_key TEXT NOT NULL UNIQUE,
            permission_label TEXT NOT NULL
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS role_permissions (
            role_id INTEGER NOT NULL,
            permission_id INTEGER NOT NULL,
            PRIMARY KEY (role_id, permission_id)
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_user_permissions (
            admin_id INTEGER NOT NULL,
            permission_id INTEGER NOT NULL,
            PRIMARY KEY (admin_id, permission_id)
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role_id INTEGER NOT NULL,
            email TEXT NULL,
            status INTEGER NOT NULL DEFAULT 1,
            remember_token TEXT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_login_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER NOT NULL,
            ip_address TEXT NOT NULL,
            user_agent TEXT NULL,
            status TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            target TEXT NULL,
            before_state TEXT NULL,
            after_state TEXT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS usdt_methods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wallet_name TEXT NOT NULL,
            wallet_address TEXT NOT NULL,
            network TEXT NOT NULL DEFAULT 'TRC20',
            qr_text TEXT NULL,
            min_amount REAL NOT NULL DEFAULT 10,
            max_amount REAL NOT NULL DEFAULT 10000,
            sort_order INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS user_control (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            win_rate_percent INTEGER NOT NULL DEFAULT 50,
            total_bets_checked INTEGER NOT NULL DEFAULT 0,
            status INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS agent_commissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            from_user_id INTEGER NOT NULL,
            bet_order_no TEXT NOT NULL,
            commission_level INTEGER NOT NULL,
            bet_amount REAL NOT NULL,
            commission_amount REAL NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS wallet_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            amount REAL NOT NULL,
            balance_before REAL NOT NULL,
            balance_after REAL NOT NULL,
            notes TEXT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS result_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_code TEXT NOT NULL,
            issue_number TEXT NOT NULL,
            premium TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(game_code, issue_number)
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS game_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_code TEXT NOT NULL UNIQUE,
            house_edge_percent REAL NOT NULL DEFAULT 2.00,
            kill_switch INTEGER NOT NULL DEFAULT 0,
            default_mode TEXT NOT NULL DEFAULT 'auto_hedge',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS gift_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            prize_amount REAL NOT NULL DEFAULT 0,
            max_redeem INTEGER NOT NULL DEFAULT 1,
            redeemed_count INTEGER NOT NULL DEFAULT 0,
            expired_at TEXT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS support_tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS ticket_replies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id INTEGER NOT NULL,
            sender_type TEXT NOT NULL,
            sender_id INTEGER NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");
    }

    api_set_default_settings($pdo);

    try {
        $stmt = $pdo->prepare("UPDATE api_settings SET setting_value = ? WHERE setting_key = 'share_domain' AND setting_value = 'https://dhaniwin7.com'");
        $stmt->execute(['https://dhaniwin.club9.eu.cc']);
    } catch (Throwable $e) {
    }

    // Alter table api_users to add password, token, token_expire columns if they don't exist
    try {
        $pdo->exec("ALTER TABLE api_users ADD COLUMN password VARCHAR(255) NULL");
    } catch (Throwable $e) {}
    try {
        $pdo->exec("ALTER TABLE api_users ADD COLUMN token VARCHAR(255) NULL");
    } catch (Throwable $e) {}
    try {
        $pdo->exec("ALTER TABLE api_users ADD COLUMN token_expire BIGINT NULL");
    } catch (Throwable $e) {}
    try {
        $pdo->exec("ALTER TABLE api_users ADD COLUMN referrer_id BIGINT NULL");
    } catch (Throwable $e) {}
    try {
        $pdo->exec("ALTER TABLE api_users ADD COLUMN status TINYINT(1) NOT NULL DEFAULT 1");
    } catch (Throwable $e) {}
    try {
        $pdo->exec("ALTER TABLE api_users ADD COLUMN vipLevel INT NOT NULL DEFAULT 0");
    } catch (Throwable $e) {}
    try {
        $pdo->exec("ALTER TABLE recharge_orders ADD COLUMN payment_type VARCHAR(20) NOT NULL DEFAULT 'UPI'");
    } catch (Throwable $e) {}
    try {
        $pdo->exec("ALTER TABLE recharge_orders ADD COLUMN screenshot_url VARCHAR(255) NULL");
    } catch (Throwable $e) {}
    try {
        $pdo->exec("ALTER TABLE withdraw_orders ADD COLUMN payment_type VARCHAR(20) NOT NULL DEFAULT 'UPI'");
    } catch (Throwable $e) {}
    try {
        $pdo->exec("ALTER TABLE withdraw_orders ADD COLUMN remarks VARCHAR(255) NULL");
    } catch (Throwable $e) {}

    // Update password for default member to be 'admin123' if it's currently empty
    try {
        $pdo->exec("UPDATE api_users SET password = 'admin123' WHERE user_id = 132257 AND (password IS NULL OR password = '')");
    } catch (Throwable $e) {}

    // Seed Roles
    $roles = [
        [1, 'super_admin', 'Super Admin'],
        [2, 'admin', 'Admin'],
        [3, 'finance_manager', 'Finance Manager'],
        [4, 'support_manager', 'Support Manager'],
        [5, 'game_manager', 'Game Manager'],
        [6, 'sub_admin', 'Sub Admin']
    ];
    foreach ($roles as $r) {
        try {
            $stmt = $pdo->prepare("INSERT " . ($driver === 'mysql' ? "IGNORE" : "OR IGNORE") . " INTO admin_roles (id, role_name, role_label) VALUES (?, ?, ?)");
            $stmt->execute($r);
        } catch (Throwable $e) {}
    }

    // Seed Permissions
    $perms = [
        [1, 'dashboard', 'Access Dashboard'],
        [2, 'user_management', 'Manage Users'],
        [3, 'finance', 'Manage Deposits & Withdrawals'],
        [4, 'support', 'Support Ticketing'],
        [5, 'game_control', 'Control Games & Results'],
        [6, 'agent_management', 'Manage Agents & Commissions'],
        [7, 'reports', 'Generate Reports'],
        [8, 'settings', 'Site Settings & Maintenance'],
        [9, 'security', 'IP Block & Security Logs'],
        [10, 'user_control', 'Targeted User Win-Rate Control']
    ];
    foreach ($perms as $p) {
        try {
            $stmt = $pdo->prepare("INSERT " . ($driver === 'mysql' ? "IGNORE" : "OR IGNORE") . " INTO admin_permissions (id, permission_key, permission_label) VALUES (?, ?, ?)");
            $stmt->execute($p);
        } catch (Throwable $e) {}
    }

    // Seed Role Permissions (pivoting all to super_admin role_id = 1)
    for ($i = 1; $i <= 10; $i++) {
        try {
            $stmt = $pdo->prepare("INSERT " . ($driver === 'mysql' ? "IGNORE" : "OR IGNORE") . " INTO role_permissions (role_id, permission_id) VALUES (1, ?)");
            $stmt->execute([$i]);
        } catch (Throwable $e) {}
    }

    // Seed default admin user
    try {
        $adminUser = $config['admin']['username'] ?? 'admin';
        $adminPass = $config['admin']['password'] ?? 'admin123';
        $passHash = password_hash($adminPass, PASSWORD_DEFAULT);
        
        $stmt = $pdo->prepare("SELECT id FROM admin_users WHERE username = ? LIMIT 1");
        $stmt->execute([$adminUser]);
        if (!$stmt->fetch()) {
            $stmt = $pdo->prepare("INSERT INTO admin_users (username, password_hash, role_id, email, status) VALUES (?, ?, 1, 'admin@dhani.win', 1)");
            $stmt->execute([$adminUser, $passHash]);
        }
    } catch (Throwable $e) {}

    @file_put_contents($marker, '1');
    $done[$key] = true;
}

function api_set_default_settings(PDO $pdo): void
{
    $defaults = [
        'site_status' => 'online',
        'login_enabled' => '1',
        'register_enabled' => '1',
        'bet_enabled' => '1',
        'recharge_enabled' => '1',
        'withdraw_enabled' => '1',
        'settlement_mode' => 'auto',
        'use_snapshot_history' => '0',
        'force_local_api' => '1',
        'block_enabled' => '1',
        'api_url' => '/api',
        'draw_url' => '/',
        'upi_display_name' => 'Dhani Win',
        'upi_id' => 'rajputajay22266-1@oksbi',
        'support_url' => '/workOrder',
        'amount_coding' => '4.11',
        'first_recharge_bonus_enabled' => '1',
        'first_recharge_bonus_percent' => '10',
        'first_recharge_bonus_max' => '500',
        'invited_wheel_enabled' => '1',
        'invited_wheel_spin_count' => '2',
        'invited_wheel_prizes' => '0.41,0.72,10,27,57,77,87,177,377,500',
        'recharge_wheel_enabled' => '1',
        'recharge_wheel_spin_count' => '1',
        'recharge_wheel_prizes' => '6,16,37,56,77,166,366,666,777,1666',
        'recharge_wheel_reward_up_amount' => '29999',
        'agent_rebate_enabled' => '1',
        'agent_commission_rate' => '0',
        'share_content' => 'Invite your friends to join Dhaniwin and unlock bonus #inviteLink#',
        'share_domain' => 'https://dhaniwin.club9.eu.cc',
        'invite_code' => 'Q8BRYAN',
        'popup_enabled' => '1',
        'home_popup_title' => 'free 500',
        'home_popup_image' => '/img/6006/other/111109657-38344-file_20260510111109590.webp',
        'default_wallet_balance' => '0',
        'default_game_balance' => '4.45',
        'wheel_allow_daily_extra_spin' => '1',
    ];
    $driver = api_db_driver($pdo);
    foreach ($defaults as $key => $value) {
        if ($driver === 'mysql') {
            $stmt = $pdo->prepare("INSERT IGNORE INTO api_settings (setting_key, setting_value) VALUES (?, ?)");
        } else {
            $stmt = $pdo->prepare("INSERT OR IGNORE INTO api_settings (setting_key, setting_value) VALUES (?, ?)");
        }
        $stmt->execute([$key, $value]);
    }
}

function api_audit(string $action, string $target = '', $payload = null): void
{
    $pdo = api_pdo();
    if (!$pdo) {
        return;
    }
    try {
        $stmt = $pdo->prepare("INSERT INTO admin_audit (action, target, payload) VALUES (?, ?, ?)");
        $stmt->execute([$action, $target, is_string($payload) ? $payload : json_encode($payload, api_json_flags())]);
    } catch (Throwable $e) {
    }
}

function api_setting(string $key, $default = '')
{
    $pdo = api_pdo();
    if (!$pdo) {
        return $default;
    }
    try {
        $stmt = $pdo->prepare("SELECT setting_value FROM api_settings WHERE setting_key = ? LIMIT 1");
        $stmt->execute([$key]);
        $value = $stmt->fetchColumn();
        return $value === false ? $default : $value;
    } catch (Throwable $e) {
        return $default;
    }
}

function api_setting_bool(string $key, bool $default = true): bool
{
    $value = api_setting($key, $default ? '1' : '0');
    if (is_bool($value)) {
        return $value;
    }
    return in_array(strtolower(trim((string) $value)), ['1', 'true', 'yes', 'on', 'enabled'], true);
}

function api_setting_float(string $key, float $default = 0.0): float
{
    $value = api_setting($key, (string) $default);
    return is_numeric($value) ? (float) $value : $default;
}

function api_lottery_success($data = null, array $extra = []): array
{
    return array_merge([
        'data' => $data,
        'code' => 0,
        'msg' => 'Succeed',
        'msgCode' => 0,
        'serviceTime' => api_now_ms(),
    ], $extra);
}

function api_json_value($value): string
{
    return json_encode($value, api_json_flags());
}

function api_csv_numbers(string $value, array $fallback): array
{
    $rows = [];
    foreach (explode(',', $value) as $part) {
        $part = trim($part);
        if ($part !== '' && is_numeric($part)) {
            $rows[] = (float) $part;
        }
    }
    return $rows ?: $fallback;
}

function api_client_ip(): string
{
    foreach (['HTTP_CLIENT_IP', 'HTTP_X_FORWARDED_FOR', 'HTTP_X_FORWARDED', 'HTTP_X_CLUSTER_CLIENT_IP', 'HTTP_FORWARDED_FOR', 'HTTP_FORWARDED', 'REMOTE_ADDR'] as $key) {
        if (array_key_exists($key, $_SERVER) === true) {
            foreach (explode(',', $_SERVER[$key]) as $ip) {
                $ip = trim($ip);
                if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false) {
                    return $ip;
                }
            }
        }
    }
    return $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
}

function api_request_block_row(): ?array
{
    $pdo = api_pdo();
    if (!$pdo || !api_setting_bool('block_enabled', true)) {
        return null;
    }
    $user = api_primary_user();
    $checks = [
        ['ip', api_client_ip()],
        ['user', (string) ($user['user_id'] ?? '')],
        ['phone', (string) ($user['phone'] ?? '')],
        ['all', '*'],
    ];
    try {
        $stmt = $pdo->prepare("SELECT * FROM site_blocks WHERE block_type = ? AND block_value = ? AND enabled = 1 LIMIT 1");
        foreach ($checks as $check) {
            if ($check[1] === '') {
                continue;
            }
            $stmt->execute([$check[0], $check[1]]);
            $row = $stmt->fetch();
            if ($row) {
                return $row;
            }
        }
    } catch (Throwable $e) {
    }
    return null;
}

function api_escape_control_chars_in_json_strings(string $raw): string
{
    $out = '';
    $inString = false;
    $escaped = false;
    $len = strlen($raw);

    for ($i = 0; $i < $len; $i++) {
        $ch = $raw[$i];
        $ord = ord($ch);

        if ($escaped) {
            $out .= $ch;
            $escaped = false;
            continue;
        }

        if ($inString && $ch === '\\') {
            $next = $i + 1 < $len ? $raw[$i + 1] : '';
            $afterNext = $i + 2 < $len ? $raw[$i + 2] : '';
            if ($next === ' ' && $afterNext === '"') {
                $out .= ' \\"';
                $i += 2;
                continue;
            }
            if (strpos('"\\/bfnrtu', $next) !== false) {
                $out .= $ch;
                $escaped = true;
                continue;
            }
            $out .= '\\\\';
            continue;
        }

        if ($ch === '"') {
            $inString = !$inString;
            $out .= $ch;
            continue;
        }

        if ($inString && $ord < 32) {
            if ($ch === "\n") {
                $out .= '\\n';
            } elseif ($ch === "\r") {
                $out .= '\\r';
            } elseif ($ch === "\t") {
                $out .= '\\t';
            } else {
                $out .= sprintf('\\u%04x', $ord);
            }
            continue;
        }

        $out .= $ch;
    }

    return $out;
}

function api_json_decode_lenient(string $raw): array
{
    $raw = preg_replace('/^\xEF\xBB\xBF/', '', trim($raw));
    $data = json_decode($raw, true);
    if (json_last_error() === JSON_ERROR_NONE) {
        return ['ok' => true, 'data' => $data, 'raw' => $raw, 'error' => null];
    }

    $fixed = api_escape_control_chars_in_json_strings($raw);
    $data = json_decode($fixed, true);
    if (json_last_error() === JSON_ERROR_NONE) {
        return ['ok' => true, 'data' => $data, 'raw' => $fixed, 'error' => null];
    }

    return ['ok' => false, 'data' => null, 'raw' => $fixed, 'error' => json_last_error_msg()];
}

function api_refresh_times(&$payload): void
{
    if (!is_array($payload)) {
        return;
    }
    foreach ($payload as $key => &$value) {
        if ($key === 'serverTime' || $key === 'serviceTime') {
            $value = api_now_ms();
        } elseif (is_array($value)) {
            api_refresh_times($value);
        }
    }
}

function api_snapshot_file(string $endpoint): ?string
{
    $endpoint = api_normalize_endpoint($endpoint);
    if ($endpoint === '' || strpos($endpoint, '_') === 0) {
        return null;
    }
    $root = realpath(__DIR__);
    $candidates = [
        __DIR__ . '/' . $endpoint . '.json',
        __DIR__ . '/' . $endpoint . '.html',
        __DIR__ . '/' . $endpoint . '.php',
    ];
    foreach ($candidates as $candidate) {
        if (!is_file($candidate)) {
            continue;
        }
        $real = realpath($candidate);
        if ($real && $root && strpos($real, $root) === 0) {
            return $real;
        }
    }
    return null;
}

function api_read_snapshot_payload(string $endpoint): ?array
{
    $file = api_snapshot_file($endpoint);
    if (!$file) {
        return null;
    }
    $raw = file_get_contents($file);
    if ($raw === false) {
        return null;
    }
    $decoded = api_json_decode_lenient($raw);
    if (!$decoded['ok']) {
        return null;
    }
    $payload = $decoded['data'];
    api_refresh_times($payload);
    return $payload;
}

function api_get_override(string $endpoint): ?array
{
    $endpoint = api_normalize_endpoint($endpoint);
    if (api_is_live_money_endpoint($endpoint)) {
        return null;
    }
    $pdo = api_pdo();
    if ($pdo) {
        try {
            $stmt = $pdo->prepare("SELECT * FROM api_responses WHERE endpoint = ? AND enabled = 1 LIMIT 1");
            $stmt->execute([$endpoint]);
            $row = $stmt->fetch();
            if ($row) {
                return $row;
            }
        } catch (Throwable $e) {
        }
    }

    $file = api_storage_dir() . '/api_overrides.json';
    if (!is_file($file)) {
        return null;
    }
    $decoded = api_json_decode_lenient((string) file_get_contents($file));
    $rows = $decoded['ok'] && is_array($decoded['data']) ? $decoded['data'] : [];
    return isset($rows[$endpoint]) && !empty($rows[$endpoint]['enabled']) ? $rows[$endpoint] : null;
}

function api_save_override(string $endpoint, string $content, string $notes = '', int $enabled = 1): void
{
    $endpoint = api_normalize_endpoint($endpoint);
    $pdo = api_pdo();
    if ($pdo) {
        $driver = api_db_driver($pdo);
        if ($driver === 'mysql') {
            $stmt = $pdo->prepare("INSERT INTO api_responses (endpoint, content, notes, enabled) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content), notes = VALUES(notes), enabled = VALUES(enabled), updated_at = CURRENT_TIMESTAMP");
            $stmt->execute([$endpoint, $content, $notes, $enabled]);
        } else {
            $exists = $pdo->prepare("SELECT id FROM api_responses WHERE endpoint = ? LIMIT 1");
            $exists->execute([$endpoint]);
            if ($exists->fetchColumn()) {
                $stmt = $pdo->prepare("UPDATE api_responses SET content = ?, notes = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE endpoint = ?");
                $stmt->execute([$content, $notes, $enabled, $endpoint]);
            } else {
                $stmt = $pdo->prepare("INSERT INTO api_responses (endpoint, content, notes, enabled, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)");
                $stmt->execute([$endpoint, $content, $notes, $enabled]);
            }
        }
        api_audit('save_override', $endpoint);
        return;
    }

    $file = api_storage_dir() . '/api_overrides.json';
    $rows = [];
    if (is_file($file)) {
        $decoded = api_json_decode_lenient((string) file_get_contents($file));
        $rows = $decoded['ok'] && is_array($decoded['data']) ? $decoded['data'] : [];
    }
    $rows[$endpoint] = [
        'endpoint' => $endpoint,
        'content' => $content,
        'content_type' => 'application/json',
        'enabled' => $enabled,
        'notes' => $notes,
        'updated_at' => date('c'),
    ];
    file_put_contents($file, json_encode($rows, api_json_flags() | JSON_PRETTY_PRINT));
}

function api_delete_override(string $endpoint): void
{
    $endpoint = api_normalize_endpoint($endpoint);
    $pdo = api_pdo();
    if ($pdo) {
        $stmt = $pdo->prepare("DELETE FROM api_responses WHERE endpoint = ?");
        $stmt->execute([$endpoint]);
        api_audit('delete_override', $endpoint);
        return;
    }
    $file = api_storage_dir() . '/api_overrides.json';
    if (!is_file($file)) {
        return;
    }
    $decoded = api_json_decode_lenient((string) file_get_contents($file));
    $rows = $decoded['ok'] && is_array($decoded['data']) ? $decoded['data'] : [];
    unset($rows[$endpoint]);
    file_put_contents($file, json_encode($rows, api_json_flags() | JSON_PRETTY_PRINT));
}

function api_list_overrides(): array
{
    $pdo = api_pdo();
    if ($pdo) {
        try {
            $rows = $pdo->query("SELECT endpoint, enabled, notes, updated_at FROM api_responses ORDER BY endpoint")->fetchAll();
            return is_array($rows) ? $rows : [];
        } catch (Throwable $e) {
        }
    }
    $file = api_storage_dir() . '/api_overrides.json';
    if (!is_file($file)) {
        return [];
    }
    $decoded = api_json_decode_lenient((string) file_get_contents($file));
    return $decoded['ok'] && is_array($decoded['data']) ? array_values($decoded['data']) : [];
}

function api_list_snapshot_endpoints(): array
{
    $endpoints = [];
    $root = realpath(__DIR__);
    if (!$root) {
        return [];
    }
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(__DIR__, FilesystemIterator::SKIP_DOTS));
    foreach ($iterator as $file) {
        if (!$file->isFile()) {
            continue;
        }
        $path = $file->getPathname();
        if (strpos($path, DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR) !== false) {
            continue;
        }
        $name = $file->getFilename();
        if (strpos($name, '_') === 0 || $name === 'config.php') {
            continue;
        }
        $ext = strtolower($file->getExtension());
        if (!in_array($ext, ['php', 'html', 'json'], true)) {
            continue;
        }
        $relative = str_replace('\\', '/', substr($path, strlen($root) + 1));
        $endpoints[] = api_normalize_endpoint($relative);
    }
    $endpoints = array_values(array_unique($endpoints));
    sort($endpoints, SORT_NATURAL | SORT_FLAG_CASE);
    return $endpoints;
}

/**
 * Live-money endpoints: these must ALWAYS be answered from the database for the
 * requesting member. Snapshot overrides (admin "API responses" cache) are static
 * JSON blobs and would show one frozen balance to every user — that is what made
 * the Wingo game show no/zero balance. Never let an override answer them.
 */
function api_is_live_money_endpoint(string $endpoint): bool
{
    $e = strtolower(trim($endpoint, "/ "));
    $live = [
        'lottery/getbalance',
        'lottery/getuserinfo',
        'lottery/getrecordpage',
        'lottery/getmyemerdlist',
        'lottery/getwinlossresult',
        'thirdgame/getargamebalance',
        'thirdgame/getargameandplatwallets',
        'thirdgame/recoversaasbalance',
        'thirdgame/transfer',
        'thirdgame/notifyargamerecover',
        'user/getuserinfo',
        'user/getuserfinanciallist',
        'recharge/getrechargebasicinfo',
        'withdraw/getwithdrawbasicinfo',
        'home/login',
        'home/register',
        'home/refresh',
        'home/refreshtoken',
        'home/autologin',
        'home/mobileautologin',
        'home/emailautologin',
        'thirdgame/getgameurl',
        'lottery/getwingoliveurl',
        'lottery/getuserinfo',
    ];
    return in_array($e, $live, true);
}

/**
 * Pulls a bearer token out of one header value.
 * "Bearer xxx" / "Token xxx" or a bare token value (no spaces) are accepted;
 * other schemes such as "Basic .." intentionally return '' so they can never be
 * mistaken for a member token.
 */
function api_bearer_from_header(string $value): string
{
    $value = trim($value);
    if ($value === '') {
        return '';
    }
    if (preg_match('/^(?:Bearer|Token)\s+([A-Za-z0-9._\-]{6,})$/i', $value, $m)) {
        return trim($m[1]);
    }
    if (strpos($value, ' ') === false && preg_match('/^[A-Za-z0-9._\-]{20,}$/', $value)) {
        return $value;
    }
    return '';
}

/**
 * Reads the member token from every place an app build may send it.
 * cPanel/Apache/LiteSpeed drop the Authorization header on some setups, which
 * silently made the API answer as the wrong (first) account -> balance looked
 * empty inside the game.
 */
function api_request_token(): string
{
    foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION', 'HTTP_X_AUTHORIZATION', 'HTTP_TOKEN'] as $key) {
        $token = api_bearer_from_header((string) ($_SERVER[$key] ?? ''));
        if ($token !== '') {
            return $token;
        }
    }
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $key => $value) {
            if (in_array(strtolower((string) $key), ['authorization', 'x-authorization', 'token'], true)) {
                $token = api_bearer_from_header((string) $value);
                if ($token !== '') {
                    return $token;
                }
            }
        }
    }
    $candidates = [
        $_GET['Token'] ?? '',
        $_GET['token'] ?? '',
        $_POST['token'] ?? '',
        $_REQUEST['token'] ?? '',
        $_REQUEST['Token'] ?? '',
        $_COOKIE['ar_g_token'] ?? '',
        $_COOKIE['ar_token'] ?? '',
        $_COOKIE['token'] ?? '',
    ];
    foreach ($candidates as $value) {
        $value = trim((string) $value);
        if ($value !== '' && !in_array(strtolower($value), ['null', 'undefined', 'false', '[object object]', '0', '""', "\'\'"], true)) {
            return $value;
        }
    }
    return '';
}

function api_guest_user(): array
{
    return [
        'id' => 0,
        'user_id' => 0,
        'username' => '',
        'nickname' => 'Guest',
        'phone' => '',
        'wallet_balance' => 0,
        'game_balance' => 0,
        'can_bet' => 0,
        'is_guest' => 1,
    ];
}

function api_user_balances(array $user): array
{
    $pdo = api_pdo();
    $game = (float) ($user['game_balance'] ?? 0);
    $wallet = (float) ($user['wallet_balance'] ?? 0);
    if ($pdo && !empty($user['id'])) {
        try {
            $stmt = $pdo->prepare("SELECT wallet_balance, game_balance FROM api_users WHERE id = ? LIMIT 1");
            $stmt->execute([(int) $user['id']]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row) {
                $wallet = (float) $row['wallet_balance'];
                $game = (float) $row['game_balance'];
            }
        } catch (Throwable $e) {
        }
    }
    return ['wallet' => $wallet, 'game' => $game];
}

function api_user_fresh(): array
{
    $user = api_member_user();
    $pdo = api_pdo();
    if (!$pdo || empty($user['id'])) {
        return $user;
    }
    try {
        $stmt = $pdo->prepare("SELECT * FROM api_users WHERE id = ? LIMIT 1");
        $stmt->execute([(int) $user['id']]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            $user = array_merge($user, $row);
        }
    } catch (Throwable $e) {
    }
    return $user;
}

/**
 * The API must hand the member token back in an `Authorization` response header:
 * the lottery/game SDK only ever learns its token from that header (it writes it
 * to localStorage as `ar_g_token`). Without it every /Lottery/* call was
 * anonymous -> the game showed the FIRST member's balance, not the real one.
 */
/**
 * Portable setting writer (MySQL + SQLite).
 */
function api_set_setting(string $key, string $value): bool
{
    $pdo = api_pdo();
    if (!$pdo) {
        return false;
    }
    try {
        $stmt = $pdo->prepare("UPDATE api_settings SET setting_value = ? WHERE setting_key = ?");
        $stmt->execute([$value, $key]);
        if ($stmt->rowCount() > 0) {
            return true;
        }
        $sql = api_db_driver($pdo) === 'mysql'
            ? "INSERT INTO api_settings (setting_key, setting_value) VALUES (?, ?)"
            : "INSERT OR IGNORE INTO api_settings (setting_key, setting_value) VALUES (?, ?)";
        $pdo->prepare($sql)->execute([$key, $value]);
        return true;
    } catch (Throwable $e) {
        return false;
    }
}

/**
 * Optional one-line audit trail so "why is the game anonymous" can be answered
 * from the admin page instead of guessing. Only writes when
 * api_settings.balance_debug = 1.
 */
function api_balance_debug(string $what): void
{
    if ((string) api_setting('balance_debug', '0') !== '1') {
        return;
    }
    $line = sprintf(
        "%s | %s %s | %s | auth=%s cookie=%s query=%s | ua=%s\n",
        date('Y-m-d H:i:s'),
        strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')),
        (string) ($_SERVER['REQUEST_URI'] ?? '-'),
        $what,
        !empty($_SERVER['HTTP_AUTHORIZATION']) || !empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION']) ? 'YES' : 'no',
        isset($_COOKIE['ar_g_token']) || isset($_COOKIE['ar_token']) ? 'YES' : 'no',
        $_GET ? implode(',', array_keys($_GET)) : '-',
        substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 60)
    );
    $file = api_storage_dir() . '/balance-debug.log';
    if (!is_dir(api_storage_dir())) {
        return;
    }
    if (is_file($file) && filesize($file) > 400000) {
        @file_put_contents($file, substr((string) file_get_contents($file), -120000));
    }
    @file_put_contents($file, $line, FILE_APPEND | LOCK_EX);
}

/**
 * 'game' (default) = Wingo shows the game wallet only.
 * 'total'          = Wingo shows game + main wallet.
 */
function api_wingo_shown_balance(array $bal): float
{
    $mode = strtolower((string) api_setting('wingo_balance_mode', 'game'));
    return $mode === 'total' ? (float) ($bal['game'] + $bal['wallet']) : (float) $bal['game'];
}

/**
 * When the member keeps money only in the main wallet the game legitimately
 * shows 0. Sites that want "no confusion" switch this on: on game entry the
 * whole main wallet is moved into the game wallet (same rules as the app's
 * Transfer button). Off by default.
 */
function api_wingo_maybe_auto_transfer(array $member): void
{
    if ((string) api_setting('wingo_auto_transfer', '0') !== '1') {
        return;
    }
    if (empty($member['id'])) {
        return;
    }
    $bal = api_user_balances($member);
    if ($bal['game'] >= 1.0 || $bal['wallet'] <= 0.0) {
        return;
    }
    $pdo = api_pdo();
    if (!$pdo) {
        return;
    }
    try {
        $stmt = $pdo->prepare("UPDATE api_users SET wallet_balance = wallet_balance - ?, game_balance = game_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND wallet_balance >= ?");
        $stmt->execute([$bal['wallet'], $bal['wallet'], (int) $member['id'], $bal['wallet']]);
        if ($stmt->rowCount() > 0) {
            api_audit('wingo_auto_transfer', (string) ($member['user_id'] ?? $member['id']), ['amount' => $bal['wallet']]);
        }
    } catch (Throwable $e) {
    }
}

function api_issue_bearer(string $token): void
{
    if ($token !== '') {
        $GLOBALS['api_issue_token'] = $token;
    }
}

/**
 * The app caches a game-entry URL (`ar_saas_lottery` / lotteryLoginUrl) that used
 * to embed the template vendor's own token. Empty it so the game always asks
 * /ThirdGame/GetGameUrl, which now answers per member.
 */
function api_strip_stale_game_login_url($payload, int $depth = 0)
{
    if (!is_array($payload) || $depth > 3) {
        return $payload;
    }
    foreach ($payload as $key => $value) {
        if (is_array($value)) {
            // big game/asset lists never hold a login url - skip them for speed
            if (count($value) > 200) {
                continue;
            }
            $payload[$key] = api_strip_stale_game_login_url($value, $depth + 1);
            continue;
        }
        $name = strtolower((string) $key);
        if (in_array($name, ['lotteryloginurl', 'sasslotteryurl', 'gameloginurl', 'lotteryurl'], true)
            && is_string($value) && $value !== '') {
            $payload[$key] = '';
        }
    }
    return $payload;
}

function api_request_origin(): string
{
    $setting = trim((string) api_setting('site_url', ''));
    if ($setting !== '') {
        return rtrim($setting, '/');
    }
    $proto = strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
    $https = $proto === 'https' || (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off');
    $host = (string) ($_SERVER['HTTP_X_FORWARDED_HOST'] ?? $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? 'localhost');
    $host = preg_replace('/[^A-Za-z0-9\.\-:]/', '', $host);
    return ($https ? 'https' : 'http') . '://' . $host;
}

/**
 * Strictly the logged-in member: never the "first row of api_users" demo
 * fallback, which is what made the Wingo screen show another account's money.
 */
function api_member_user(): array
{
    $user = api_primary_user();
    if (!empty($GLOBALS['api_user_matched_by_token'])) {
        return $user;
    }
    return api_guest_user();
}

function api_primary_user(): array
{
    static $currentUser = null;
    if ($currentUser !== null) {
        return $currentUser;
    }

    $token = api_request_token();
    $tokenSupplied = $token !== '';

    $pdo = api_pdo();
    if ($pdo && !empty($token)) {
        try {
            $stmt = $pdo->prepare("SELECT * FROM api_users WHERE token = ? LIMIT 1");
            $stmt->execute([$token]);
            $user = $stmt->fetch();
            if ($user) {
                $GLOBALS['api_user_matched_by_token'] = true;
                $currentUser = $user;
                return $user;
            }
        } catch (Throwable $e) {
        }
    }

    // A token was sent but it does not match any member: never fall back to
    // somebody else's account, otherwise the game shows a wrong/empty balance.
    if ($tokenSupplied) {
        $currentUser = api_guest_user();
        return $currentUser;
    }

    // No token at all -> legacy fallback (public routes/tests still work)
    if ($pdo) {
        try {
            $row = $pdo->query("SELECT * FROM api_users ORDER BY id LIMIT 1")->fetch();
            if ($row) {
                $currentUser = $row;
                return $row;
            }
        } catch (Throwable $e) {
        }
    }

    return [
        'id' => 1,
        'user_id' => 132257,
        'username' => 'local_member',
        'nickname' => 'MemberNNGKLPHA',
        'phone' => '919119098026',
        'wallet_balance' => 0,
        'game_balance' => 4.45,
        'can_bet' => 1,
    ];
}

// api_client_ip robust implementation is declared above

function api_user_register(array $input): array
{
    $pdo = api_pdo();
    if (!$pdo) {
        return api_error('Database not available', 500);
    }

    $username = trim((string) (api_param($input, 'username', api_param($input, 'userName', api_param($input, 'phone', '')))));
    $password = (string) api_param($input, 'password', '');
    $inviteCode = trim((string) api_param($input, 'inviteCode', ''));

    if ($username === '' || $password === '') {
        return api_error('Username and password are required', 400);
    }

    // Check if user already exists
    try {
        $stmt = $pdo->prepare("SELECT id FROM api_users WHERE username = ? OR phone = ? LIMIT 1");
        $stmt->execute([$username, $username]);
        if ($stmt->fetch()) {
            return api_error('User already registered', 409);
        }
    } catch (Throwable $e) {
    }

    // Generate unique user ID
    $userId = mt_rand(100000, 999999);
    for ($i = 0; $i < 10; $i++) {
        $stmt = $pdo->prepare("SELECT id FROM api_users WHERE user_id = ? LIMIT 1");
        $stmt->execute([$userId]);
        if (!$stmt->fetch()) {
            break;
        }
        $userId = mt_rand(100000, 999999);
    }

    // Resolve referrer_id from inviteCode
    $referrerId = null;
    if ($inviteCode !== '') {
        try {
            $stmt = $pdo->prepare("SELECT user_id FROM api_users WHERE user_id = ? OR username = ? LIMIT 1");
            $stmt->execute([$inviteCode, $inviteCode]);
            $referrer = $stmt->fetch();
            if ($referrer) {
                $referrerId = (int) $referrer['user_id'];
            }
        } catch (Throwable $e) {
        }
    }

    // Generate Nickname
    $nickname = 'Member' . strtoupper(substr(md5((string) $userId), 0, 8));
    $token = 'local_' . sha1((string) $username . microtime(true));
    $tokenExpire = api_now_ms() + 604800000;

    $ip = api_client_ip();
    $rawJson = json_encode([
        'register_ip' => $ip,
        'login_ips' => [$ip],
        'last_login_ip' => $ip
    ], JSON_UNESCAPED_SLASHES);

    try {
        $stmt = $pdo->prepare("INSERT INTO api_users (user_id, username, nickname, phone, wallet_balance, game_balance, can_bet, password, token, token_expire, referrer_id, raw_json) VALUES (?, ?, ?, ?, 0.0, 4.45, 1, ?, ?, ?, ?, ?)");
        $stmt->execute([$userId, $username, $nickname, $username, $password, $token, $tokenExpire, $referrerId, $rawJson]);
    } catch (Throwable $e) {
        return api_error('Registration failed: ' . $e->getMessage(), 500);
    }

    api_audit('user_register', (string) $userId, ['username' => $username]);

    return api_success([
        'tokenHeader' => 'Bearer',
        'token' => $token,
        'refreshToken' => 'refresh_' . sha1($username . 'refresh' . microtime(true)),
        'expireTime' => $tokenExpire,
        'canBet' => true,
        'userId' => $userId,
        'userName' => $username,
        'nickName' => $nickname,
        'packageTransferConfig' => null,
    ]);
}

function api_user_login(array $input): array
{
    $pdo = api_pdo();
    if (!$pdo) {
        return api_error('Database not available', 500);
    }

    $username = trim((string) (api_param($input, 'username', api_param($input, 'userName', api_param($input, 'phone', '')))));
    $password = (string) api_param($input, 'password', '');

    if ($username === '' || $password === '') {
        return api_error('Username and password are required', 400);
    }

    try {
        $stmt = $pdo->prepare("SELECT * FROM api_users WHERE username = ? OR phone = ? LIMIT 1");
        $stmt->execute([$username, $username]);
        $user = $stmt->fetch();
    } catch (Throwable $e) {
        return api_error('Database error: ' . $e->getMessage(), 500);
    }

    if (!$user) {
        return api_error('User not found. Please register.', 404);
    }

    if ((string) $user['password'] !== $password) {
        return api_error('Invalid password', 401);
    }

    $token = 'local_' . sha1((string) $username . microtime(true));
    $tokenExpire = api_now_ms() + 604800000;

    $ip = api_client_ip();
    $raw = [];
    if (!empty($user['raw_json'])) {
        $raw = json_decode($user['raw_json'], true) ?: [];
    }
    $raw['last_login_ip'] = $ip;
    if (!isset($raw['login_ips']) || !is_array($raw['login_ips'])) {
        $raw['login_ips'] = [];
    }
    if (!in_array($ip, $raw['login_ips'], true)) {
        $raw['login_ips'][] = $ip;
    }
    if (empty($raw['register_ip'])) {
        $raw['register_ip'] = $ip;
    }
    $rawJson = json_encode($raw, JSON_UNESCAPED_SLASHES);

    try {
        $stmt = $pdo->prepare("UPDATE api_users SET token = ?, token_expire = ?, raw_json = ? WHERE id = ?");
        $stmt->execute([$token, $tokenExpire, $rawJson, $user['id']]);
    } catch (Throwable $e) {
        return api_error('Login token update failed', 500);
    }

    api_audit('user_login', (string) $user['user_id'], ['username' => $username]);

    return api_success([
        'tokenHeader' => 'Bearer',
        'token' => $token,
        'refreshToken' => 'refresh_' . sha1($username . 'refresh' . microtime(true)),
        'expireTime' => $tokenExpire,
        'canBet' => (bool) $user['can_bet'],
        'userId' => (int) $user['user_id'],
        'userName' => (string) $username,
        'nickName' => (string) $user['nickname'],
        'packageTransferConfig' => null,
    ]);
}

function api_user_autologin(array $input): array
{
    $user = api_primary_user();
    $token = api_request_token();
    if ($token === '') {
        $token = (string) ($user['token'] ?? '');
    }

    $tokenExpire = isset($user['token_expire']) ? (int) $user['token_expire'] : (api_now_ms() + 604800000);

    return api_success([
        'tokenHeader' => 'Bearer',
        'token' => $token,
        'refreshToken' => 'refresh_' . sha1($user['username'] . 'refresh' . microtime(true)),
        'expireTime' => $tokenExpire,
        'canBet' => (bool) $user['can_bet'],
        'userId' => (int) $user['user_id'],
        'userName' => (string) $user['username'],
        'nickName' => (string) $user['nickname'],
        'packageTransferConfig' => null,
    ]);
}

function api_user_info_data(): array
{
    $user = api_primary_user();
    return [
        'userId' => (int) $user['user_id'],
        'nickName' => (string) $user['nickname'],
        'userPhoto' => '5',
        'userType' => 0,
        'lastLoginTime' => api_now_ms(),
        'isOpenVip' => true,
        'vipLevel' => 0,
        'rechargeLevel' => 2,
        'walletBalance' => (float) $user['wallet_balance'],
        'safeBoxAmount' => 0.0,
        'boolAttr' => 164865,
        'hasNoReadMessage' => false,
        'registerType' => 1,
        'verifyMethods' => [
            'email' => '',
            'phone' => (string) ($user['phone'] ?: '919119098026'),
            'google' => '0',
        ],
        'bindGoogleVerifyMethod' => 2,
        'lastLoginSysLanguage' => 'en',
        'inviteCode' => (string) $user['user_id'],
        'yesterdayRebateAmount' => 0.0,
        'userUnGrandMsgCount' => 0,
        'userUnreadInmailCount' => 1,
        'userUnreceiveInmailRewardCount' => 0,
        'canSetPassword' => false,
        'isShowL3ReceiveCommission' => false,
        'lossReliefConfigIds' => '',
        'hasReceivedOpenPushGuideReward' => false,
    ];
}

function api_token_data(array $input): array
{
    $params = $input['params'] ?? [];
    $user = api_primary_user();
    $account = $params['userName'] ?? $params['username'] ?? $params['phoneOrEmail'] ?? $params['phone'] ?? $params['email'] ?? $user['username'];
    return [
        'tokenHeader' => 'Bearer',
        'token' => 'local_' . sha1((string) $account . microtime(true)),
        'refreshToken' => 'refresh_' . sha1((string) $account . 'refresh' . microtime(true)),
        'expireTime' => api_now_ms() + 604800000,
        'canBet' => (bool) $user['can_bet'],
        'userId' => (int) $user['user_id'],
        'userName' => (string) $account,
        'nickName' => (string) $user['nickname'],
        'packageTransferConfig' => null,
    ];
}

function api_empty_page(array $input): array
{
    $pageNo = (int) ($input['params']['pageNo'] ?? 1);
    $pageSize = (int) ($input['params']['pageSize'] ?? 10);
    return [
        'list' => [],
        'pageNo' => max(1, $pageNo),
        'pageSize' => max(1, $pageSize),
        'totalPage' => 0,
        'totalCount' => 0,
    ];
}

function api_lottery_normalize_game_code(string $gameCode): string
{
    $gameCode = trim($gameCode);
    if ($gameCode === '') {
        return '';
    }
    $gameCode = str_replace(['-', ' '], '_', $gameCode);
    $gameCode = preg_replace('/_([0-9]+)Min$/i', '_$1M', $gameCode);
    $gameCode = preg_replace('/_([0-9]+)Minute$/i', '_$1M', $gameCode);
    $gameCode = preg_replace('/_([0-9]+)Minutes$/i', '_$1M', $gameCode);
    $gameCode = preg_replace('/_30Sec$/i', '_30S', $gameCode);
    $gameCode = preg_replace('/_30Second$/i', '_30S', $gameCode);
    $gameCode = preg_replace('/_30Seconds$/i', '_30S', $gameCode);
    if (stripos($gameCode, '5D_') === 0) {
        $gameCode = 'D5_' . substr($gameCode, 3);
    }
    if (stripos($gameCode, 'MotoRacing_') === 0) {
        $gameCode = 'MotoRace_' . substr($gameCode, strlen('MotoRacing_'));
    }
    if (strcasecmp($gameCode, 'WinGo') === 0) {
        return 'WinGo_30S';
    }
    if (strcasecmp($gameCode, 'K3') === 0) {
        return 'K3_1M';
    }
    if (strcasecmp($gameCode, 'D5') === 0 || strcasecmp($gameCode, '5D') === 0) {
        return 'D5_1M';
    }
    if (strcasecmp($gameCode, 'TrxWinGo') === 0) {
        return 'TrxWinGo_1M';
    }
    if (strcasecmp($gameCode, 'MotoRace') === 0 || strcasecmp($gameCode, 'MotoRacing') === 0) {
        return 'MotoRace_1M';
    }
    return $gameCode;
}

function api_lottery_interval_seconds(string $gameCode): int
{
    if (preg_match('/_30S$/i', $gameCode)) {
        return 30;
    }
    if (preg_match('/_(\d+)M$/i', $gameCode, $m)) {
        return max(1, (int) $m[1]) * 60;
    }
    return 60;
}

function api_lottery_code_from_game(string $gameCode): string
{
    if (stripos($gameCode, 'TrxWinGo') === 0) {
        return 'TrxWinGo';
    }
    if (stripos($gameCode, 'WinGo') === 0) {
        return 'WinGo';
    }
    if (stripos($gameCode, 'K3') === 0) {
        return 'K3';
    }
    if (stripos($gameCode, 'D5') === 0 || stripos($gameCode, '5D') === 0) {
        return 'D5';
    }
    if (stripos($gameCode, 'MotoRace') === 0 || stripos($gameCode, 'MotoRacing') === 0) {
        return 'MotoRace';
    }
    return 'WinGo';
}

function api_lottery_seed(string $seed): int
{
    return (int) sprintf('%u', crc32($seed));
}

function api_lottery_game_prefix(string $gameCode): string
{
    $map = [
        'WinGo_1M'     => '10001',
        'WinGo_3M'     => '10002',
        'WinGo_5M'     => '10003',
        'WinGo_10M'    => '10004',
        'WinGo_30S'    => '10005',
        'TrxWinGo_1M'  => '20001',
        'TrxWinGo_3M'  => '20002',
        'TrxWinGo_5M'  => '20003',
        'TrxWinGo_30S' => '20005',
        '5D_1M'        => '30001',
        '5D_3M'        => '30002',
        '5D_5M'        => '30003',
        '5D_10M'       => '30004',
        'K3_1M'        => '40001',
        'K3_3M'        => '40002',
        'K3_5M'        => '40003',
        'K3_10M'       => '40004',
        'MotoRace_1M'  => '50001',
    ];
    return $map[$gameCode] ?? '10001';
}

function api_lottery_calculate_issue(string $gameCode, int $timestamp): string
{
    $interval = api_lottery_interval_seconds($gameCode);
    $prefix = api_lottery_game_prefix($gameCode);
    $utcDayStart = strtotime(gmdate('Y-m-d 00:00:00', $timestamp) . ' UTC');
    $secondsSinceMidnight = $timestamp - $utcDayStart;
    $periodIndex = (int) floor($secondsSinceMidnight / $interval) + 1;
    $dateStr = gmdate('Ymd', $timestamp);

    return sprintf('%s%s%04d', $dateStr, $prefix, $periodIndex);
}

function api_lottery_issue_data(string $gameCode): array
{
    $gameCode = api_lottery_normalize_game_code($gameCode);
    if ($gameCode === '') {
        $gameCode = 'WinGo_30S';
    }
    $period = api_lottery_interval_seconds($gameCode);
    $now = api_now_ms();
    $periodMs = $period * 1000;
    $start = (int) (floor($now / $periodMs) * $periodMs);
    $end = $start + $periodMs;
    
    // Active running issue
    $issue = api_lottery_calculate_issue($gameCode, (int)($start / 1000));
    
    return [
        'startTime' => $start,
        'endTime' => $end,
        'issueNumber' => $issue,
        // Frontend multiplies this value by 60, so it must be minutes, not seconds.
        'intervalMinute' => $period / 60,
        'gameCode' => $gameCode,
        'current' => [
            'issueNumber' => $issue,
            'startTime' => $start,
            'endTime' => $end,
        ],
        'diif' => 0,
        'countdown' => max(0, (int) ceil(($end - $now) / 1000)),
    ];
}

function api_lottery_issue_payload(string $gameCode): array
{
    return [
        'code' => 0,
        'data' => api_lottery_issue_data($gameCode),
        'msg' => 'Succeed',
        'msgCode' => 0,
        'serverTime' => api_now_ms(),
    ];
}

function api_lottery_rates(string $gameCode): array
{
    $lotteryCode = api_lottery_code_from_game($gameCode);
    $rates = [];
    $id = 50;

    if ($lotteryCode === 'K3') {
        $sumRates = [3 => 207.36, 4 => 69.12, 5 => 34.56, 6 => 20.74, 7 => 13.83, 8 => 9.88, 9 => 8.30, 10 => 7.68, 11 => 7.68, 12 => 8.30, 13 => 9.88, 14 => 13.83, 15 => 20.74, 16 => 34.56, 17 => 69.12, 18 => 207.36];
        foreach ($sumRates as $bet => $rate) {
            $rates[] = ['playTypeId' => $id++, 'playType' => 'SumNum', 'playBet' => (string) $bet, 'state' => 1, 'playRate' => $rate];
        }
        foreach ([
            ['SumBigSmall', 'H', 2.00], ['SumBigSmall', 'L', 2.00], ['SumOddEven', 'O', 2.00], ['SumOddEven', 'E', 2.00],
            ['NumSame2', '2TD', 13.83], ['NumSame2Mult', '2TF', 69.12], ['NumSame3', '3TD', 207.36],
            ['NumSame3All', '3TT', 34.56], ['NumDiff3', '3BT', 34.56], ['NumNear3All', '3LT', 8.64], ['NumDiff2', '2BT', 6.91],
        ] as $row) {
            $rates[] = ['playTypeId' => $id++, 'playType' => $row[0], 'playBet' => $row[1], 'state' => 1, 'playRate' => $row[2]];
        }
    } elseif ($lotteryCode === 'D5') {
        foreach (['First', 'Second', 'Third', 'Fourth', 'Fifth'] as $name) {
            $rates[] = ['playTypeId' => $id++, 'playType' => $name . 'Num', 'playBet' => '0-9', 'state' => 1, 'playRate' => 9.00];
            $rates[] = ['playTypeId' => $id++, 'playType' => $name . 'BigSmall', 'playBet' => 'H', 'state' => 1, 'playRate' => 2.00];
            $rates[] = ['playTypeId' => $id++, 'playType' => $name . 'BigSmall', 'playBet' => 'L', 'state' => 1, 'playRate' => 2.00];
            $rates[] = ['playTypeId' => $id++, 'playType' => $name . 'OddEven', 'playBet' => 'O', 'state' => 1, 'playRate' => 2.00];
            $rates[] = ['playTypeId' => $id++, 'playType' => $name . 'OddEven', 'playBet' => 'E', 'state' => 1, 'playRate' => 2.00];
        }
        $rates[] = ['playTypeId' => $id++, 'playType' => 'SumBigSmall', 'playBet' => 'H', 'state' => 1, 'playRate' => 2.00];
        $rates[] = ['playTypeId' => $id++, 'playType' => 'SumBigSmall', 'playBet' => 'L', 'state' => 1, 'playRate' => 2.00];
        $rates[] = ['playTypeId' => $id++, 'playType' => 'SumOddEven', 'playBet' => 'O', 'state' => 1, 'playRate' => 2.00];
        $rates[] = ['playTypeId' => $id++, 'playType' => 'SumOddEven', 'playBet' => 'E', 'state' => 1, 'playRate' => 2.00];
    } elseif ($lotteryCode === 'MotoRace') {
        foreach (['First', 'Second', 'Third'] as $rank) {
            $rates[] = ['playTypeId' => $id++, 'playType' => $rank . 'Num', 'playBet' => '1-10', 'state' => 1, 'playRate' => 9.00];
            $rates[] = ['playTypeId' => $id++, 'playType' => $rank . 'BigSmall', 'playBet' => 'H', 'state' => 1, 'playRate' => 2.00];
            $rates[] = ['playTypeId' => $id++, 'playType' => $rank . 'BigSmall', 'playBet' => 'L', 'state' => 1, 'playRate' => 2.00];
            $rates[] = ['playTypeId' => $id++, 'playType' => $rank . 'OddEven', 'playBet' => 'O', 'state' => 1, 'playRate' => 2.00];
            $rates[] = ['playTypeId' => $id++, 'playType' => $rank . 'OddEven', 'playBet' => 'E', 'state' => 1, 'playRate' => 2.00];
        }
    } else {
        foreach ([
            ['Color', 'green', 1.80], ['Color', 'red', 1.80], ['Color', 'violet', 4.50],
            ['Num', '0-9', 8.20], ['BigSmall', 'big', 1.80], ['BigSmall', 'small', 1.80],
        ] as $row) {
            $rates[] = ['playTypeId' => $id++, 'playType' => $row[0], 'playBet' => $row[1], 'state' => 1, 'playRate' => $row[2]];
        }
    }

    return array_merge([
        'state' => api_setting_bool('bet_enabled', true) ? 1 : 0,
        'betScopes' => [1, 10, 100, 1000],
        'betMultiples' => [1, 5, 10, 20, 50, 100],
        'webSocketUrl' => 'wss://ws-pro.ar-lottery01.com',
        'gameCode' => $gameCode,
        'lotteryCode' => $lotteryCode,
        'rates' => $rates,
    ], api_lottery_issue_data($gameCode));
}

function api_lottery_default_premium(string $gameCode, string $issueNumber): string
{
    $lotteryCode = api_lottery_code_from_game($gameCode);
    $seed = api_lottery_seed($gameCode . ':' . $issueNumber);
    if ($lotteryCode === 'K3') {
        return (string) (($seed % 6) + 1) . (string) ((($seed >> 3) % 6) + 1) . (string) ((($seed >> 6) % 6) + 1);
    }
    if ($lotteryCode === 'D5') {
        $digits = [];
        for ($i = 0; $i < 5; $i++) {
            $digits[] = (string) (($seed >> ($i * 3)) % 10);
        }
        return implode('', $digits);
    }
    if ($lotteryCode === 'MotoRace') {
        $cars = range(1, 10);
        for ($i = 0; $i < count($cars); $i++) {
            $swap = ($seed + ($i * 7)) % count($cars);
            $tmp = $cars[$i];
            $cars[$i] = $cars[$swap];
            $cars[$swap] = $tmp;
        }
        return implode(',', $cars);
    }
    return (string) ($seed % 10);
}

function api_lottery_result_from_premium(string $gameCode, string $issueNumber, string $premium): array
{
    $lotteryCode = api_lottery_code_from_game($gameCode);
    if ($lotteryCode === 'K3') {
        preg_match_all('/[1-6]/', $premium, $m);
        $digits = array_slice($m[0], 0, 3);
        while (count($digits) < 3) {
            $digits[] = '1';
        }
        $sum = array_sum(array_map('intval', $digits));
        return [
            'game_code' => $gameCode,
            'lottery_code' => $lotteryCode,
            'issue_number' => $issueNumber,
            'premium' => implode('', $digits),
            'number_value' => '',
            'color' => '',
            'sum_value' => $sum,
        ];
    }
    if ($lotteryCode === 'D5') {
        preg_match_all('/[0-9]/', $premium, $m);
        $digits = array_slice($m[0], 0, 5);
        while (count($digits) < 5) {
            $digits[] = '0';
        }
        return [
            'game_code' => $gameCode,
            'lottery_code' => $lotteryCode,
            'issue_number' => $issueNumber,
            'premium' => implode('', $digits),
            'number_value' => '',
            'color' => '',
            'sum_value' => array_sum(array_map('intval', $digits)),
        ];
    }
    if ($lotteryCode === 'MotoRace') {
        preg_match_all('/\d+/', $premium, $m);
        $cars = array_slice($m[0], 0, 10);
        if (count($cars) < 10) {
            $cars = range(1, 10);
        }
        return [
            'game_code' => $gameCode,
            'lottery_code' => $lotteryCode,
            'issue_number' => $issueNumber,
            'premium' => implode(',', $cars),
            'number_value' => (string) $cars[0],
            'color' => '',
            'sum_value' => null,
        ];
    }

    preg_match('/\d/', $premium, $m);
    $number = isset($m[0]) ? (int) $m[0] : 0;
    $color = $number === 0 ? 'red,violet' : ($number === 5 ? 'green,violet' : ($number % 2 === 0 ? 'red' : 'green'));
    return [
        'game_code' => $gameCode,
        'lottery_code' => $lotteryCode,
        'issue_number' => $issueNumber,
        'premium' => (string) $number,
        'number_value' => (string) $number,
        'color' => $color,
        'sum_value' => 0,
    ];
}

function api_lottery_ensure_result(string $gameCode, string $issueNumber, string $premium = '', string $source = 'auto'): array
{
    $gameCode = api_lottery_normalize_game_code($gameCode);
    $pdo = api_pdo();
    
    // 1. Check if result ALREADY exists in database (e.g. from live sync, previous draw, or manual queue)
    if ($pdo && $premium === '') {
        try {
            $stmt = $pdo->prepare("SELECT * FROM lottery_results WHERE game_code = ? AND issue_number = ? LIMIT 1");
            $stmt->execute([$gameCode, $issueNumber]);
            $existing = $stmt->fetch();
            if ($existing) {
                return $existing;
            }
        } catch (Throwable $e) {}
    }

    // 2. Check Admin Manual Queue
    if ($premium === '' && $pdo) {
        try {
            $stmt = $pdo->prepare("SELECT premium FROM result_queue WHERE game_code = ? AND issue_number = ? LIMIT 1");
            $stmt->execute([$gameCode, $issueNumber]);
            $queued = $stmt->fetchColumn();
            if ($queued !== false) {
                $premium = (string)$queued;
                $source = 'manual_queue';
            }
        } catch (Throwable $e) {}
    }

    // 3. Check User Target Control
    if ($premium === '' && $pdo) {
        try {
            require_once __DIR__ . '/../admin/controllers/GameController.php';
            $controlled = GameController::processUserTargetControl($gameCode, $issueNumber);
            if ($controlled !== null) {
                $premium = $controlled;
                $source = 'user_control';
            }
        } catch (Throwable $e) {}
    }

    // 4. Check Auto Hedge Mode
    if ($premium === '' && $pdo) {
        $mode = strtolower((string)api_setting('settlement_mode', 'auto'));
        if ($mode === 'auto_hedge') {
            try {
                require_once __DIR__ . '/../admin/controllers/GameController.php';
                $premium = GameController::optimizeOutcome($gameCode, $issueNumber);
                $source = 'auto_hedge';
            } catch (Throwable $e) {}
        }
    }

    // 5. If upstream live URL is configured, try live fetch
    if ($premium === '' && function_exists('lottery_upstream_fetch_result')) {
        $liveResult = lottery_upstream_fetch_result($gameCode, $issueNumber);
        if ($liveResult !== null && isset($liveResult['premium'])) {
            $premium = (string)$liveResult['premium'];
            $source = 'upstream_live';
        }
    }

    // 6. Deterministic fallback calculation
    if ($premium === '') {
        $premium = api_lottery_default_premium($gameCode, $issueNumber);
    }
    
    $result = api_lottery_result_from_premium($gameCode, $issueNumber, $premium);
    $result['source'] = $source;

    if (!$pdo) {
        return $result;
    }

    // 7. Save to lottery_results table
    try {
        $stmt = $pdo->prepare("INSERT INTO lottery_results (game_code, lottery_code, issue_number, premium, number_value, color, sum_value, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");
        $stmt->execute([$gameCode, $result['lottery_code'], $issueNumber, $result['premium'], $result['number_value'], $result['color'], $result['sum_value'], $source]);
        $result['id'] = $pdo->lastInsertId();
    } catch (Throwable $e) {
        try {
            $stmt = $pdo->prepare("SELECT * FROM lottery_results WHERE game_code = ? AND issue_number = ? LIMIT 1");
            $stmt->execute([$gameCode, $issueNumber]);
            $existing = $stmt->fetch();
            if ($existing) {
                return $existing;
            }
        } catch (Throwable $e2) {}
    }
    return $result;
}

function api_draw_file_payload(string $lotteryCode, string $gameCode): ?array
{
    if (!api_setting_bool('use_snapshot_history', false)) {
        return null;
    }
    $path = dirname(__DIR__) . '/draw.ar-lottery01.com/' . $lotteryCode . '/' . $gameCode . '/GetHistoryIssuePage.json';
    if (!is_file($path)) {
        return null;
    }
    $decoded = api_json_decode_lenient((string) file_get_contents($path));
    if (!$decoded['ok']) {
        return null;
    }
    $payload = $decoded['data'];
    api_refresh_times($payload);
    return $payload;
}

function api_lottery_history_item(array $row): array
{
    $premium = (string) ($row['premium'] ?? '');
    $number = (string) ($row['number_value'] ?? '');
    $color = (string) ($row['color'] ?? '');
    $sum = isset($row['sum_value']) ? (int) $row['sum_value'] : 0;
    return [
        'issueNumber' => (string) $row['issue_number'],
        'issueNo' => (string) $row['issue_number'],
        'issue' => (string) $row['issue_number'],
        'number' => $number,
        'numberValue' => $number,
        'resultNumber' => $number,
        'color' => $color,
        'colour' => $color,
        'premium' => $premium,
        'result' => $premium,
        'openCode' => $premium,
        'sum' => $sum,
        'sumValue' => $sum,
        'source' => (string) ($row['source'] ?? 'auto'),
        'openTime' => api_now_ms(),
        'serviceTime' => api_now_ms(),
    ];
}

function api_lottery_history_payload(string $gameCode, array $input): array
{
    $gameCode = api_lottery_normalize_game_code($gameCode) ?: 'WinGo_30S';
    $lotteryCode = (string) ($input['params']['lotteryCode'] ?? api_lottery_code_from_game($gameCode));
    $static = api_draw_file_payload($lotteryCode, $gameCode);
    if ($static) {
        return $static;
    }

    $pageNo = max(1, (int) api_param($input, 'pageNo', api_param($input, 'page_no', 1)));
    $pageSize = max(1, min(100, (int) api_param($input, 'pageSize', api_param($input, 'page_size', 10))));

    $interval = api_lottery_interval_seconds($gameCode);
    $periodMs = $interval * 1000;
    $now = api_now_ms();
    $start = (int) (floor($now / $periodMs) * $periodMs);
    $end = $start + $periodMs;
    $secondsLeft = max(0, (int) ceil(($end - $now) / 1000));

    $offset = ($pageNo - 1) * $pageSize;
    $list = [];
    // History strictly starts 1 period behind active round ($i = 1 is the latest finished round)
    for ($i = 1; count($list) < $pageSize; $i++) {
        $drawTimeMs = $start - (($offset + $i) * $periodMs);
        $issueNumber = api_lottery_calculate_issue($gameCode, (int)($drawTimeMs / 1000));
        $row = api_lottery_ensure_result($gameCode, $issueNumber);
        $list[] = api_lottery_history_item($row);
    }

    return api_lottery_success([
        'list' => $list,
        'pageNo' => $pageNo,
        'pageSize' => $pageSize,
        'totalPage' => 50,
        'totalCount' => 50 * $pageSize,
    ]);
}

function api_lottery_game_list(): array
{
    $rows = [];
    $definitions = [
        ['WinGo_30S', 'WinGo 30sec', 44],
        ['WinGo_1M', 'WinGo 1 Min', 43],
        ['WinGo_3M', 'WinGo 3 Min', 42],
        ['WinGo_5M', 'WinGo 5 Min', 41],

        ['K3_1M', 'K3 1 Min', 34],
        ['K3_3M', 'K3 3 Min', 33],
        ['K3_5M', 'K3 5 Min', 32],
        ['K3_10M', 'K3 10 Min', 31],

        ['D5_1M', '5D 1 Min', 24],
        ['D5_3M', '5D 3 Min', 23],
        ['D5_5M', '5D 5 Min', 22],
        ['D5_10M', '5D 10 Min', 21],

        ['TrxWinGo_1M', 'TrxWinGo 1 Min', 14],
        ['TrxWinGo_3M', 'TrxWinGo 3 Min', 13],
        ['TrxWinGo_5M', 'TrxWinGo 5 Min', 12],
        ['TrxWinGo_10M', 'TrxWinGo 10 Min', 11],

        ['MotoRace_1M', 'Moto Racing 1 Min', 10],
        ['MotoRace_3M', 'Moto Racing 3 Min', 9],
        ['MotoRace_5M', 'Moto Racing 5 Min', 8],
        ['MotoRace_10M', 'Moto Racing 10 Min', 7],
    ];
    $maintenance = api_setting_bool('site_maintenance', false);
    foreach ($definitions as $row) {
        [$code, $name, $sort] = $row;
        $lottery = api_lottery_code_from_game($code);
        $intervalSeconds = api_lottery_interval_seconds($code);
        $rows[] = [
            'gameCode' => $code,
            'lotteryCode' => $lottery,
            'name' => $name,
            'gameName' => $name,
            'gameNameEn' => $name,
            'gameTypeName' => $lottery === 'D5' ? '5D' : $lottery,
            'status' => (api_setting_bool('bet_enabled', true) && !$maintenance) ? 1 : 0,
            'state' => (api_setting_bool('bet_enabled', true) && !$maintenance) ? 1 : 2,
            // Original API sends minutes here: 30 sec = 0.5, 1 min = 1, etc.
            'intervalMinute' => $intervalSeconds / 60,
            'sort' => $sort,
            'isGameMaintenance' => $maintenance,
            'isPlatMaintenance' => $maintenance,
        ];
    }
    return $rows;
}

function api_lottery_game_groups(): array
{
    $meta = [
        'WinGo' => ['gameType' => 100, 'gameTypeName' => 'WinGo', 'label' => 'WinGo', 'sort' => 1],
        'MotoRace' => ['gameType' => 105, 'gameTypeName' => 'MotoRace', 'label' => 'MotoRace', 'sort' => 2],
        'D5' => ['gameType' => 102, 'gameTypeName' => '5D', 'label' => '5D', 'sort' => 4],
        'K3' => ['gameType' => 101, 'gameTypeName' => 'K3', 'label' => 'K3', 'sort' => 5],
        'TrxWinGo' => ['gameType' => 103, 'gameTypeName' => 'TrxWinGo', 'label' => 'TrxWinGo', 'sort' => 6],
    ];
    $groups = [];
    foreach (api_lottery_game_list() as $game) {
        $lottery = (string) $game['lotteryCode'];
        $m = $meta[$lottery] ?? ['gameType' => 0, 'gameTypeName' => $lottery, 'label' => $lottery, 'sort' => 99];
        if (!isset($groups[$lottery])) {
            $groups[$lottery] = [
                'gameType' => $m['gameType'],
                'gameTypeName' => $m['gameTypeName'],
                'lotteryCode' => $lottery,
                'gameCode' => $lottery,
                'categoryCode' => $lottery,
                'categoryName' => $m['label'],
                'name' => $m['label'],
                'sort' => $m['sort'],
                'gameList' => [],
            ];
        }
        $groups[$lottery]['gameList'][] = $game;
    }
    foreach ($groups as &$group) {
        usort($group['gameList'], function ($a, $b) {
            return (int) $b['sort'] <=> (int) $a['sort'];
        });
    }
    unset($group);
    usort($groups, function ($a, $b) {
        return (int) $a['sort'] <=> (int) $b['sort'];
    });
    return array_values($groups);
}

function api_lottery_game_from_endpoint(string $endpoint, string $gameCode): string
{
    $gameCode = trim($gameCode);
    if ($gameCode !== '') {
        return api_lottery_normalize_game_code($gameCode);
    }
    $action = strtolower(basename($endpoint));
    if (strpos($action, 'trx') !== false) {
        return 'TrxWinGo_1M';
    }
    if (strpos($action, 'k3') !== false) {
        return 'K3_1M';
    }
    if (strpos($action, 'd5') !== false || strpos($action, '5d') !== false) {
        return 'D5_1M';
    }
    if (strpos($action, 'motoracing') !== false || strpos($action, 'motorace') !== false || strpos($action, 'moto') !== false) {
        return 'MotoRace_1M';
    }
    return 'WinGo_30S';
}

function api_lottery_game_from_input(array $input, string $endpoint = ''): string
{
    $explicit = (string) (api_param($input, 'gameCode', api_param($input, 'game_code', '')) ?: '');
    if ($explicit !== '') {
        return api_lottery_game_from_endpoint($endpoint, $explicit);
    }

    $endpointLower = strtolower($endpoint);
    $lottery = (string) (api_param($input, 'lotteryCode', api_param($input, 'lottery_code', api_param($input, 'categoryCode', ''))) ?: '');
    $lotteryLower = strtolower($lottery);
    if (strpos($endpointLower, 'trx') !== false || strpos($lotteryLower, 'trx') !== false) {
        $base = 'TrxWinGo';
    } elseif (strpos($endpointLower, 'k3') !== false || strpos($lotteryLower, 'k3') !== false) {
        $base = 'K3';
    } elseif (strpos($endpointLower, 'd5') !== false || strpos($endpointLower, '5d') !== false || strpos($lotteryLower, 'd5') !== false || strpos($lotteryLower, '5d') !== false) {
        $base = 'D5';
    } elseif (strpos($endpointLower, 'motoracing') !== false || strpos($endpointLower, 'motorace') !== false || strpos($endpointLower, 'moto') !== false || strpos($lotteryLower, 'motoracing') !== false || strpos($lotteryLower, 'motorace') !== false || strpos($lotteryLower, 'moto') !== false) {
        $base = 'MotoRace';
    } else {
        $base = 'WinGo';
    }

    $rawType = (string) (api_param($input, 'typeId', api_param($input, 'type_id', api_param($input, 'gameType', api_param($input, 'gameTypeId', '')))) ?: '');
    $type = strtoupper(trim($rawType));
    $interval = '1M';
    if ($type !== '') {
        if ($type === '4' || $type === '30' || $type === '30S') {
            $interval = '30S';
        } elseif ($type === '2' || $type === '3M') {
            $interval = '3M';
        } elseif ($type === '3' || $type === '5M') {
            $interval = '5M';
        } elseif ($type === '10' || $type === '10M') {
            $interval = '10M';
        } elseif ($type === '1' || $type === '1M') {
            $interval = '1M';
        }
    }
    if ($base !== 'WinGo' && $interval === '30S') {
        $interval = '1M';
    }
    return $base . '_' . $interval;
}

function api_lottery_normalize_bet_contents($betContent): array
{
    if (is_array($betContent)) {
        $items = [];
        foreach ($betContent as $value) {
            if (is_array($value)) {
                if (isset($value['betContent'])) {
                    $items = array_merge($items, api_lottery_normalize_bet_contents($value['betContent']));
                } else {
                    $items[] = api_json_value($value);
                }
            } else {
                $trimmed = trim((string) $value);
                if ($trimmed !== '') {
                    $items[] = $trimmed;
                }
            }
        }
        return $items;
    }
    $text = trim((string) $betContent);
    if ($text === '') {
        return [];
    }
    if ($text[0] === '[' || $text[0] === '{') {
        $decoded = json_decode($text, true);
        if (is_array($decoded)) {
            return api_lottery_normalize_bet_contents($decoded);
        }
    }
    return [$text];
}

function api_lottery_parse_content(string $content): array
{
    $parts = explode('_', $content);
    $type = trim((string) array_shift($parts));
    $bet = trim(implode('_', $parts));
    return [$type, $bet];
}

function api_lottery_selected_numbers(string $bet, int $min = 0, int $max = 9): array
{
    preg_match_all('/\d+/', $bet, $m);
    $numbers = [];
    foreach ($m[0] as $raw) {
        $n = (int) $raw;
        if ($n >= $min && $n <= $max) {
            $numbers[] = $n;
        }
    }
    return array_values(array_unique($numbers));
}

function api_lottery_content_rate(string $gameCode, string $content, array $result = []): float
{
    list($type, $bet) = api_lottery_parse_content($content);
    $lotteryCode = api_lottery_code_from_game($gameCode);
    $typeLower = strtolower($type);
    $betLower = strtolower($bet);
    $resultNumber = isset($result['number_value']) && $result['number_value'] !== '' ? (int)$result['number_value'] : -1;

    if ($lotteryCode === 'K3') {
        if ($typeLower === 'sumnum') {
            $rates = [3 => 207.36, 4 => 69.12, 5 => 34.56, 6 => 20.74, 7 => 13.83, 8 => 9.88, 9 => 8.30, 10 => 7.68, 11 => 7.68, 12 => 8.30, 13 => 9.88, 14 => 13.83, 15 => 20.74, 16 => 34.56, 17 => 69.12, 18 => 207.36];
            $sum = (int) $bet;
            return $rates[$sum] ?? 2.0;
        }
        if ($typeLower === 'numsame3') {
            return 207.36;
        }
        if ($typeLower === 'numsame3all' || $typeLower === 'numdiff3') {
            return 34.56;
        }
        if ($typeLower === 'numsame2mult') {
            return 69.12;
        }
        if ($typeLower === 'numsame2') {
            return 13.83;
        }
        if ($typeLower === 'numnear3all') {
            return 8.64;
        }
        if ($typeLower === 'numdiff2') {
            return 6.91;
        }
        return 2.0;
    }

    if ($lotteryCode === 'D5' || $lotteryCode === 'MotoRace') {
        return strpos($typeLower, 'num') !== false ? 9.0 : 2.0;
    }

    // WinGo & TrxWinGo
    if ($typeLower === 'num') {
        return 9.0;
    }
    if ($typeLower === 'color') {
        if ($betLower === 'violet') {
            return 4.5;
        }
        if (($betLower === 'red' && $resultNumber === 0) || ($betLower === 'green' && $resultNumber === 5)) {
            return 1.5;
        }
        return 2.0;
    }
    if ($typeLower === 'bigsmall' || $typeLower === 'oddeven') {
        return 2.0;
    }
    return 2.0;
}

function api_lottery_content_wins(string $gameCode, string $content, array $result): bool
{
    list($type, $bet) = api_lottery_parse_content($content);
    $lotteryCode = api_lottery_code_from_game($gameCode);
    $typeLower = strtolower($type);
    $betLower = strtolower($bet);

    if ($lotteryCode === 'K3') {
        preg_match_all('/[1-6]/', (string) $result['premium'], $m);
        $dice = array_slice(array_map('intval', $m[0]), 0, 3);
        $sum = array_sum($dice);
        $counts = array_count_values($dice);
        $nums = api_lottery_selected_numbers($bet, 1, 6);

        if ($typeLower === 'sumnum') {
            return $sum === (int) $bet;
        }
        if ($typeLower === 'sumbigsmall') {
            return in_array($betLower, ['h', 'big', 'high'], true) ? $sum >= 11 : $sum <= 10;
        }
        if ($typeLower === 'sumoddeven') {
            return in_array($betLower, ['o', 'odd'], true) ? $sum % 2 === 1 : $sum % 2 === 0;
        }
        if ($typeLower === 'numsame3all') {
            return count($counts) === 1;
        }
        if ($typeLower === 'numsame3') {
            return count($nums) > 0 && count($counts) === 1 && $dice[0] === $nums[0];
        }
        if ($typeLower === 'numsame2' || $typeLower === 'numsame2mult') {
            foreach ($nums as $n) {
                if (($counts[$n] ?? 0) >= 2) {
                    return true;
                }
            }
            return false;
        }
        if ($typeLower === 'numdiff3') {
            if (count($counts) !== 3) {
                return false;
            }
            if (count($nums) < 3) {
                return true;
            }
            foreach ($nums as $n) {
                if (!in_array($n, $dice, true)) {
                    return false;
                }
            }
            return true;
        }
        if ($typeLower === 'numnear3all') {
            sort($dice);
            return $dice[0] + 1 === $dice[1] && $dice[1] + 1 === $dice[2];
        }
        if ($typeLower === 'numdiff2') {
            if (count($nums) < 2) {
                return count($counts) >= 2;
            }
            return in_array($nums[0], $dice, true) && in_array($nums[1], $dice, true) && $nums[0] !== $nums[1];
        }
        return false;
    }

    if ($lotteryCode === 'D5') {
        preg_match_all('/\d/', (string) $result['premium'], $m);
        $digits = array_slice(array_map('intval', $m[0]), 0, 5);
        $positions = ['first' => 0, 'second' => 1, 'third' => 2, 'fourth' => 3, 'fifth' => 4];
        $sum = array_sum($digits);

        if ($typeLower === 'sumbigsmall') {
            return in_array($betLower, ['h', 'big', 'high'], true) ? $sum >= 23 : $sum <= 22;
        }
        if ($typeLower === 'sumoddeven') {
            return in_array($betLower, ['o', 'odd'], true) ? $sum % 2 === 1 : $sum % 2 === 0;
        }
        foreach ($positions as $prefix => $index) {
            if (strpos($typeLower, $prefix) === 0 && isset($digits[$index])) {
                $value = $digits[$index];
                if (strpos($typeLower, 'num') !== false) {
                    return $value === (int) $bet;
                }
                if (strpos($typeLower, 'bigsmall') !== false) {
                    return in_array($betLower, ['h', 'big', 'high'], true) ? $value >= 5 : $value <= 4;
                }
                if (strpos($typeLower, 'oddeven') !== false) {
                    return in_array($betLower, ['o', 'odd'], true) ? $value % 2 === 1 : $value % 2 === 0;
                }
            }
        }
        return false;
    }

    if ($lotteryCode === 'MotoRace') {
        $cars = api_lottery_selected_numbers((string) $result['premium'], 1, 10);
        $rank = 0;
        if (strpos($typeLower, 'second') === 0) {
            $rank = 1;
        } elseif (strpos($typeLower, 'third') === 0) {
            $rank = 2;
        }
        $value = $cars[$rank] ?? ($cars[0] ?? 1);
        if (strpos($typeLower, 'num') !== false || $typeLower === 'num') {
            return $value === (int) $bet;
        }
        if (strpos($typeLower, 'bigsmall') !== false || $typeLower === 'bigsmall') {
            return in_array($betLower, ['h', 'big', 'high'], true) ? $value >= 6 : $value <= 5;
        }
        if (strpos($typeLower, 'oddeven') !== false || $typeLower === 'oddeven') {
            return in_array($betLower, ['o', 'odd'], true) ? $value % 2 === 1 : $value % 2 === 0;
        }
        return false;
    }

    $number = (int) ($result['number_value'] ?? 0);
    if ($typeLower === 'num') {
        return $number === (int) $bet;
    }
    if ($typeLower === 'bigsmall') {
        return $betLower === 'big' || $betLower === 'h' ? $number >= 5 : $number <= 4;
    }
    if ($typeLower === 'color') {
        return strpos(',' . strtolower((string) $result['color']) . ',', ',' . $betLower . ',') !== false;
    }
    return false;
}

function api_lottery_current_balance(int $userDbId): float
{
    $pdo = api_pdo();
    if (!$pdo) {
        return (float) api_primary_user()['game_balance'];
    }
    $stmt = $pdo->prepare("SELECT game_balance FROM api_users WHERE id = ? LIMIT 1");
    $stmt->execute([$userDbId]);
    $value = $stmt->fetchColumn();
    return $value === false ? 0.0 : (float) $value;
}

function api_lottery_place_bet(string $endpoint, array $input): array
{
    $pdo = api_pdo();
    $user = api_user_fresh();
    if (empty($user['id'])) {
        return api_error('Please login again to place a bet', 143, 401);
    }
    $gameCode = api_lottery_game_from_input($input, $endpoint);
    $issue = (string) (api_param($input, 'issueNumber', '') ?: api_lottery_issue_data($gameCode)['issueNumber']);
    $gameCode = api_lottery_game_from_issue($issue) ?: $gameCode;
    $amount = max(0.0, (float) api_param($input, 'amount', api_param($input, 'betAmount', 0)));
    $multiple = max(1.0, (float) api_param($input, 'betMultiple', api_param($input, 'multiple', 1)));
    $contents = api_lottery_normalize_bet_contents(api_param($input, 'betContent', api_param($input, 'content', '')));
    if (!$contents) {
        $contents = ['Unknown'];
    }
    $stake = round($amount * $multiple * count($contents), 4);

    if (!api_setting_bool('bet_enabled', true) || empty($user['can_bet'])) {
        return api_error('Betting is disabled', 405, -1);
    }
    if ($amount <= 0 || $stake <= 0) {
        return api_error('Invalid bet amount', 401, -1);
    }
    if (!$pdo) {
        return api_error('Database is not available', 315, -1);
    }
    if ((float) $user['game_balance'] < $stake) {
        return api_error('Insufficient balance', 142, -1, ['balance' => (float) $user['game_balance']]);
    }

    $orderNo = 'LOT' . date('YmdHis') . mt_rand(1000, 9999);
    try {
        $pdo->beginTransaction();
        $stmt = $pdo->prepare("UPDATE api_users SET game_balance = game_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND game_balance >= ?");
        $stmt->execute([$stake, $user['id'], $stake]);
        if ($stmt->rowCount() < 1) {
            $pdo->rollBack();
            return api_error('Insufficient balance', 142, -1, ['balance' => api_lottery_current_balance((int) $user['id'])]);
        }
        $stmt = $pdo->prepare("INSERT INTO lottery_bets (order_no, user_id, game_code, lottery_code, issue_number, amount, bet_multiple, bet_count, stake_amount, bet_content, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)");
        $stmt->execute([$orderNo, $user['id'], $gameCode, api_lottery_code_from_game($gameCode), $issue, $amount, $multiple, count($contents), $stake, api_json_value($contents)]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        return api_error('Bet failed', 403, -1);
    }

    api_audit('lottery_bet', $orderNo, ['gameCode' => $gameCode, 'issueNumber' => $issue, 'stake' => $stake, 'content' => $contents]);
    return api_lottery_success([
        'orderNo' => $orderNo,
        'balance' => api_lottery_current_balance((int) $user['id']),
        'issueNumber' => $issue,
        'gameCode' => $gameCode,
        'amount' => $amount,
        'betMultiple' => $multiple,
        'betAmount' => $stake,
        'state' => 1,
    ]);
}

function api_lottery_game_from_issue(string $issueNumber): ?string
{
    if (strlen($issueNumber) < 13) {
        return null;
    }
    // Issue format: YYYYMMDD (8) + prefix (5) + period (4)
    $prefix = substr($issueNumber, 8, 5);
    $map = [
        '10001' => 'WinGo_1M',
        '10002' => 'WinGo_3M',
        '10003' => 'WinGo_5M',
        '10004' => 'WinGo_10M',
        '10005' => 'WinGo_30S',
        '20001' => 'TrxWinGo_1M',
        '20002' => 'TrxWinGo_3M',
        '20003' => 'TrxWinGo_5M',
        '20005' => 'TrxWinGo_30S',
        '30001' => '5D_1M',
        '30002' => '5D_3M',
        '30003' => '5D_5M',
        '30004' => '5D_10M',
        '40001' => 'K3_1M',
        '40002' => 'K3_3M',
        '40003' => 'K3_5M',
        '40004' => 'K3_10M',
        '50001' => 'MotoRace_1M',
    ];
    return $map[$prefix] ?? null;
}

function api_lottery_issue_closed(string $gameCode, string $issueNumber): bool
{
    if ($issueNumber === '') {
        return false;
    }
    $resolvedGame = api_lottery_game_from_issue($issueNumber) ?: api_lottery_normalize_game_code($gameCode) ?: 'WinGo_30S';
    $current = (string) api_lottery_issue_data($resolvedGame)['issueNumber'];
    return strcmp($issueNumber, $current) < 0;
}

function api_lottery_settle_bet(array $bet): array
{
    if (($bet['status'] ?? '') !== 'pending') {
        return $bet;
    }
    $pdo = api_pdo();
    if (!$pdo) {
        return $bet;
    }

    $gameCode = (string) $bet['game_code'];
    if (!api_lottery_issue_closed($gameCode, (string) $bet['issue_number'])) {
        $bet['status'] = 'pending';
        $bet['win_amount'] = (float) ($bet['win_amount'] ?? 0);
        $bet['profit_amount'] = 0.0;
        return $bet;
    }
    $result = api_lottery_ensure_result($gameCode, (string) $bet['issue_number']);
    $contents = api_lottery_normalize_bet_contents((string) ($bet['bet_content'] ?? ''));
    $mode = strtolower((string) api_setting('settlement_mode', 'auto'));
    $feeRate = (float) api_setting('lottery_fee_rate', '0.02');
    $winAmount = 0.0;
    $won = false;

    $amount = (float) $bet['amount'];
    $multiple = (float) $bet['bet_multiple'];
    $unitStake = $amount * $multiple;
    $unitFee = round($unitStake * $feeRate, 4);
    $unitReal = max(0.0, $unitStake - $unitFee);

    foreach ($contents as $content) {
        $wins = api_lottery_content_wins($gameCode, $content, $result);
        if ($mode === 'force_loss') {
            $wins = false;
        }
        if ($wins) {
            $won = true;
            $rate = api_lottery_content_rate($gameCode, $content, $result);
            $winAmount += round($unitReal * $rate, 4);
        }
    }

    if ($mode === 'force_win' && !$won) {
        $won = true;
        $winAmount = round($unitReal * api_lottery_content_rate($gameCode, $contents[0] ?? 'Num_0', $result), 4);
    }

    $winAmount = round($winAmount, 4);
    $stakeAmount = (float) $bet['stake_amount'];
    $profit = round($winAmount - $stakeAmount, 4);
    $status = $won ? 'won' : 'lost';

    try {
        $pdo->beginTransaction();
        if ($winAmount > 0) {
            $stmt = $pdo->prepare("UPDATE api_users SET game_balance = game_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
            $stmt->execute([$winAmount, $bet['user_id']]);
        }
        $stmt = $pdo->prepare("UPDATE lottery_bets SET status = ?, result_premium = ?, win_amount = ?, profit_amount = ?, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'");
        $stmt->execute([$status, $result['premium'], $winAmount, $profit, $bet['id']]);
        $pdo->commit();
        
        try {
            require_once __DIR__ . '/../admin/controllers/AgentController.php';
            AgentController::processBetCommissions((string)$bet['order_no']);
        } catch (Throwable $e) {}
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
    }

    $bet['status'] = $status;
    $bet['result_premium'] = $result['premium'];
    $bet['win_amount'] = $winAmount;
    $bet['profit_amount'] = $profit;
    return $bet;
}

function api_lottery_record_page(array $input): array
{
    $pdo = api_pdo();
    if (!$pdo) {
        return api_lottery_success(api_empty_page($input));
    }
    $user = api_primary_user();
    $gameCode = (string) (api_param($input, 'gameCode', api_param($input, 'game_code', '')) ?: '');
    $pageNo = max(1, (int) api_param($input, 'pageNo', 1));
    $pageSize = max(1, min(100, (int) api_param($input, 'pageSize', 10)));
    $offset = ($pageNo - 1) * $pageSize;
    $where = "WHERE user_id = ?";
    $args = [$user['id']];
    if ($gameCode !== '') {
        $where .= " AND game_code = ?";
        $args[] = $gameCode;
    }

    $total = 0;
    try {
        $stmt = $pdo->prepare("SELECT COUNT(*) FROM lottery_bets $where");
        $stmt->execute($args);
        $total = (int) $stmt->fetchColumn();
        $stmt = $pdo->prepare("SELECT * FROM lottery_bets $where ORDER BY id DESC LIMIT $pageSize OFFSET $offset");
        $stmt->execute($args);
        $rows = $stmt->fetchAll();
    } catch (Throwable $e) {
        $rows = [];
    }

    $feeRate = (float) api_setting('lottery_fee_rate', '0.02');
    $list = [];
    foreach ($rows as $row) {
        if (($row['status'] ?? '') === 'pending' && api_lottery_issue_closed((string) $row['game_code'], (string) $row['issue_number'])) {
            $row = api_lottery_settle_bet($row);
        }
        $contents = api_lottery_normalize_bet_contents((string) ($row['bet_content'] ?? ''));
        $firstContent = $contents[0] ?? '';
        $parsed = $firstContent !== '' ? api_lottery_parse_content($firstContent) : ['', ''];
        $statusText = (string) ($row['status'] ?? 'pending');
        $frontState = $statusText === 'pending' ? 2 : ($statusText === 'won' ? 1 : 0);
        $resultPremium = (string) ($row['result_premium'] ?? '');
        $resultNumber = '';
        if ($resultPremium !== '') {
            $resultRow = api_lottery_result_from_premium((string) $row['game_code'], (string) $row['issue_number'], $resultPremium);
            $resultNumber = (string) ($resultRow['number_value'] ?? '');
        }
        $stakeAmount = (float) $row['stake_amount'];
        $fee = round($stakeAmount * $feeRate, 4);
        $realAmount = max(0.0, round($stakeAmount - $fee, 4));
        $profitAmount = $statusText === 'pending' ? 0.0 : (float) $row['profit_amount'];
        $winLoseAmount = $statusText === 'pending' ? 0.0 : ($statusText === 'won' ? (float)$row['win_amount'] - $stakeAmount : -$stakeAmount);
        $createdMs = strtotime((string) $row['created_at']) ? strtotime((string) $row['created_at']) * 1000 : api_now_ms();
        $list[] = [
            'orderNo' => (string) $row['order_no'],
            'issueNumber' => (string) $row['issue_number'],
            'gameCode' => (string) $row['game_code'],
            'lotteryCode' => (string) $row['lottery_code'],
            'playType' => $parsed[0],
            'playBet' => $parsed[1],
            'betContent' => $firstContent,
            'betContentList' => $contents,
            'amount' => (float) $row['amount'],
            'betMultiple' => (float) $row['bet_multiple'],
            'betCount' => (int) $row['bet_count'],
            'betAmount' => $stakeAmount,
            'realAmount' => $realAmount,
            'fee' => $fee,
            'winAmount' => (float) $row['win_amount'],
            'profitAmount' => $profitAmount,
            'winLoseAmount' => $winLoseAmount,
            'status' => $statusText,
            'state' => $frontState,
            'isPending' => $frontState === 2,
            'number' => $resultNumber,
            'result' => $resultPremium,
            'result_premium' => $resultPremium,
            'betTime' => $createdMs,
            'createTime' => $createdMs,
            'createdTime' => (string) $row['created_at'],
        ];
    }

    return api_lottery_success([
        'list' => $list,
        'pageNo' => $pageNo,
        'pageSize' => $pageSize,
        'totalPage' => $pageSize > 0 ? (int) ceil($total / $pageSize) : 0,
        'totalCount' => $total,
    ]);
}

function api_lottery_win_loss_payload(array $input): array
{
    $pdo = api_pdo();
    if (!$pdo) {
        return api_lottery_success(['status' => false, 'winAmount' => 0.0]);
    }
    $user = api_primary_user();
    $orderNo = (string) api_param($input, 'orderNo', '');
    $issueNumber = (string) api_param($input, 'issueNumber', api_param($input, 'issue_number', ''));

    try {
        if ($orderNo !== '') {
            $stmt = $pdo->prepare("SELECT * FROM lottery_bets WHERE order_no = ? LIMIT 1");
            $stmt->execute([$orderNo]);
        } elseif ($issueNumber !== '') {
            $stmt = $pdo->prepare("SELECT * FROM lottery_bets WHERE user_id = ? AND issue_number = ? ORDER BY id DESC LIMIT 1");
            $stmt->execute([$user['id'], $issueNumber]);
        } else {
            $stmt = $pdo->prepare("SELECT * FROM lottery_bets WHERE user_id = ? ORDER BY id DESC LIMIT 1");
            $stmt->execute([$user['id']]);
        }
        $bet = $stmt->fetch();
    } catch (Throwable $e) {
        $bet = null;
    }

    if (!$bet) {
        return api_lottery_success(['status' => false, 'isPending' => false, 'state' => 'none', 'winAmount' => 0.0]);
    }

    if (($bet['status'] ?? '') === 'pending' && !api_lottery_issue_closed((string) $bet['game_code'], (string) $bet['issue_number'])) {
        return api_lottery_success([
            'status' => false,
            'isPending' => true,
            'state' => 'pending',
            'winAmount' => 0.0,
            'profitAmount' => 0.0,
            'orderNo' => (string) $bet['order_no'],
            'issueNumber' => (string) $bet['issue_number'],
            'result' => '',
            'balance' => api_lottery_current_balance((int) $bet['user_id']),
        ]);
    }

    $bet = api_lottery_settle_bet($bet);

    return api_lottery_success([
        'status' => ((string) $bet['status']) === 'won',
        'isPending' => ((string) $bet['status']) === 'pending',
        'state' => (string) $bet['status'],
        'winAmount' => (float) $bet['win_amount'],
        'profitAmount' => (float) $bet['profit_amount'],
        'orderNo' => (string) $bet['order_no'],
        'issueNumber' => (string) $bet['issue_number'],
        'result' => (string) ($bet['result_premium'] ?? ''),
        'balance' => api_lottery_current_balance((int) $bet['user_id']),
    ]);
}

function api_lottery_trend_statistics(string $gameCode, array $input): array
{
    $history = api_lottery_history_payload($gameCode, array_merge($input, ['params' => array_merge($input['params'] ?? [], ['pageSize' => 100])]));
    $list = $history['data']['list'] ?? [];
    $stats = [];
    for ($i = 0; $i <= 9; $i++) {
        $stats[(string) $i] = ['appear' => 0, 'missing' => 0, 'maxContinuous' => 0];
    }
    foreach ($list as $row) {
        $number = (string) ($row['number'] ?? '');
        if (isset($stats[$number])) {
            $stats[$number]['appear']++;
        }
    }
    return api_lottery_success(['list' => $list, 'statistics' => $stats]);
}

function api_lottery_dynamic(string $endpoint, array $input): ?array
{
    $action = strtolower(basename($endpoint));
    $gameCode = api_lottery_game_from_input($input, $endpoint);

    if ($action === 'getgameinfo') {
        return api_lottery_success(api_lottery_rates($gameCode));
    }
    if ($action === 'getbalance') {
        $user = api_user_fresh();
        $bal = api_user_balances($user);
        $currency = (string) (api_config()['site']['currency'] ?? 'INR');
        $shown = api_wingo_shown_balance($bal);
        if (empty($user['id'])) {
            api_balance_debug('Lottery/GetBalance -> no member resolved (showing 0)');
        }
        return api_lottery_success([
            'balance' => $shown,
            'amount' => $shown,
            'money' => $shown,
            'balanceMode' => strtolower((string) api_setting('wingo_balance_mode', 'game')),
            'gameBalance' => $bal['game'],
            'walletBalance' => $bal['wallet'],
            'totalBalance' => $bal['game'] + $bal['wallet'],
            'currency' => $currency,
            'tenantId' => (int) (api_config()['site']['tenant_id'] ?? 6006),
            'userId' => (int) ($user['user_id'] ?? 0),
            'isGuest' => !empty($user['is_guest']),
        ]);
    }
    if ($action === 'getuserinfo') {
        $member = api_user_fresh();
        api_wingo_maybe_auto_transfer($member);
        if (empty($member['id'])) {
            api_balance_debug('Lottery/GetUserInfo -> no member resolved');
        }
        $info = api_user_info_data();
        $info['userId'] = (int) ($member['user_id'] ?? 0);
        $info['nickName'] = (string) ($member['nickname'] ?? '');
        $info['inviteCode'] = (string) ($member['inviteCode'] ?? ($member['username'] ?? ''));
        $info['verifyMethods']['phone'] = (string) ($member['phone'] ?? '');
        $bal = api_user_balances($member);
        $currency = (string) (api_config()['site']['currency'] ?? 'INR');
        $info['amount'] = $bal['game'];
        $info['balance'] = $bal['game'];
        $info['gameBalance'] = $bal['game'];
        $info['walletBalance'] = $bal['wallet'];
        $info['totalBalance'] = $bal['game'] + $bal['wallet'];
        $info['currency'] = $currency;
        return api_lottery_success($info);
    }
    if ($action === 'getgamelist') {
        return api_success(api_lottery_game_groups());
    }
    if ($action === 'gethistoryissuepage') {
        return api_lottery_history_payload($gameCode, $input);
    }
    if ($action === 'getrecordpage') {
        return api_lottery_record_page($input);
    }
    if ($action === 'getbetlimit') {
        return api_lottery_success([
            ['playType' => 'Num', 'minAmount' => 1, 'maxAmount' => 100000, 'maxPayoutAmount' => 1000000, 'isSupportDoubleBet' => 1],
            ['playType' => 'Color', 'minAmount' => 1, 'maxAmount' => 100000, 'maxPayoutAmount' => 1000000, 'isSupportDoubleBet' => 1],
            ['playType' => 'BigSmall', 'minAmount' => 1, 'maxAmount' => 100000, 'maxPayoutAmount' => 1000000, 'isSupportDoubleBet' => 1],
        ]);
    }
    if ($action === 'getgameintroduce') {
        return api_lottery_success([
            'title' => 'Rules',
            'content' => 'Choose number, color, size, sum, dice or race rank before the countdown ends. Bets are deducted from game balance and settled from the latest result.',
        ]);
    }
    if ($action === 'gettrendstatistics') {
        return api_lottery_trend_statistics($gameCode, $input);
    }
    if ($action === 'getwinlossresult') {
        return api_lottery_win_loss_payload($input);
    }
    if ($action === 'getwingoliveurl') {
        return api_lottery_success(['url' => '', 'isOpen' => false]);
    }
    if ($action === 'getdragonlist') {
        return api_lottery_success([]);
    }
    if (preg_match('/(bet|betting)$/i', $action)) {
        return api_lottery_place_bet($endpoint, $input);
    }
    if (strpos($action, 'follow') !== false) {
        if ($action === 'getfollowrule') {
            return api_lottery_success(['minAmount' => 1, 'maxAmount' => 100000, 'maxIssueCount' => 1000]);
        }
        if ($action === 'getfollowrecord' || $action === 'addfollowrecord') {
            return api_lottery_success(['orderNo' => 'FOLLOW' . api_now_ms(), 'state' => 1]);
        }
        return api_lottery_success(api_empty_page($input));
    }
    return null;
}

function api_payment_methods(bool $onlyEnabled = true): array
{
    $pdo = api_pdo();
    if ($pdo) {
        try {
            $where = $onlyEnabled ? "WHERE enabled = 1" : "";
            $rows = $pdo->query("SELECT * FROM payment_methods $where ORDER BY sort_order DESC, id ASC")->fetchAll();
            if ($rows) {
                return $rows;
            }
        } catch (Throwable $e) {
        }
    }
    return [[
        'id' => 400101,
        'method_name' => (string) api_setting('upi_display_name', 'PhonePe'),
        'method_type' => 'UPI',
        'account_name' => (string) api_setting('upi_display_name', 'Dhani Win'),
        'account_value' => (string) api_setting('upi_id', 'rajputajay22266-1@oksbi'),
        'qr_text' => 'upi://pay?pa=' . rawurlencode((string) api_setting('upi_id', 'rajputajay22266-1@oksbi')) . '&pn=' . rawurlencode((string) api_setting('upi_display_name', 'Dhani Win')) . '&cu=INR',
        'min_amount' => 100,
        'max_amount' => 50000,
        'sort_order' => 10,
        'enabled' => 1,
    ]];
}

function api_recharge_quick_amounts(float $min, float $max): array
{
    $base = [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000, 30000, 50000, 100000];
    $rows = [];
    foreach ($base as $amount) {
        if ($amount >= $min && $amount <= $max) {
            $rows[] = ['rechargeAmount' => (float) $amount, 'giftAmount' => 0.0];
        }
    }
    if (!$rows) {
        $rows[] = ['rechargeAmount' => $min, 'giftAmount' => 0.0];
    }
    return $rows;
}


function api_recharge_front_type(string $methodType): string
{
    $type = trim($methodType);
    $upper = strtoupper($type);
    if ($upper === 'UPI' || $upper === 'LOCALUPI') {
        return 'LocalUPI';
    }
    if ($upper === 'BANK' || $upper === 'BANKCARD' || $upper === 'LOCALBANKCARD') {
        return 'LocalBankCard';
    }
    if ($upper === 'QR' || $upper === 'LOCALBANKQR') {
        return 'LocalBankQR';
    }
    if ($upper === 'EWALLET' || $upper === 'LOCALEWALLET') {
        return 'LocalEWallet';
    }
    return $type !== '' ? $type : 'LocalUPI';
}

function api_recharge_category_payload(): array
{
    $rows = [];
    foreach (api_payment_methods(true) as $method) {
        $min = (float) ($method['min_amount'] ?? 100);
        $max = (float) ($method['max_amount'] ?? 50000);
        $rows[] = [
            'id' => (int) $method['id'],
            'name' => (string) $method['method_name'],
            'rechargeType' => api_recharge_front_type((string) ($method['method_type'] ?? 'UPI')),
            'state' => !empty($method['enabled']) ? 1 : 0,
            'sort' => (int) ($method['sort_order'] ?? 0),
            'iconUrl' => '/assets/icons/icon-192.png',
            'selectedIconUrl' => '/assets/icons/icon-192.png',
            'rate' => 1.0,
            'minAmount' => $min,
            'maxAmount' => $max,
            'accountName' => (string) ($method['account_name'] ?? ''),
            'accountValue' => (string) ($method['account_value'] ?? ''),
            'qrText' => (string) ($method['qr_text'] ?? ''),
            'rechargeGiftRatio' => ['giftRatioType' => 3, 'scaleType' => 1, 'uniformRatioData' => null, 'intervalRatioList' => null],
            'quickConfigList' => api_recharge_quick_amounts($min, $max),
            'giftRatioType' => 0,
            'giftAmount' => 0.0,
            'isUsedArUpiRechargeAmount' => false,
        ];
    }
    return api_success($rows);
}

function api_recharge_basic_info_payload(): array
{
    $user = api_primary_user();
    return api_success([
        'gameSaasBalance' => (function () use ($user) {
            $bal = api_user_balances($user);
            $currency = (string) (api_config()['site']['currency'] ?? 'INR');
            $tenantId = (int) (api_config()['site']['tenant_id'] ?? 6006);
            $uid = (int) ($user['user_id'] ?? 0);
            return [
                ['vendorCode' => 'ARGame', 'balance' => $bal['game'], 'currency' => $currency, 'tenantId' => $tenantId, 'userId' => $uid],
                ['vendorCode' => 'PlatForm', 'balance' => $bal['wallet'], 'currency' => $currency, 'tenantId' => $tenantId, 'userId' => $uid],
            ];
        })(),
        'goodsList' => [],
        'advisementList' => [],
        'onGoingOrder' => null,
        'amountCoding' => api_setting_float('amount_coding', 4.11),
        'classicBonusDetails' => null,
    ]);
}


function api_recharge_order_file(): string
{
    return api_storage_dir() . '/recharge_orders.json';
}

function api_recharge_file_rows(): array
{
    $file = api_recharge_order_file();
    if (!is_file($file)) {
        return [];
    }
    $decoded = api_json_decode_lenient((string) file_get_contents($file));
    return $decoded['ok'] && is_array($decoded['data']) ? $decoded['data'] : [];
}

function api_recharge_file_save_rows(array $rows): void
{
    file_put_contents(api_recharge_order_file(), json_encode(array_values($rows), api_json_flags() | JSON_PRETTY_PRINT));
}

function api_recharge_file_add(array $row): void
{
    $rows = api_recharge_file_rows();
    $rows[] = $row;
    api_recharge_file_save_rows($rows);
}

function api_recharge_file_find(string $orderNo): ?array
{
    foreach (api_recharge_file_rows() as $row) {
        if ((string) ($row['order_no'] ?? '') === $orderNo) {
            return $row;
        }
    }
    return null;
}

function api_recharge_file_update(string $orderNo, array $changes): bool
{
    $rows = api_recharge_file_rows();
    $updated = false;
    foreach ($rows as &$row) {
        if ((string) ($row['order_no'] ?? '') === $orderNo) {
            foreach ($changes as $key => $value) {
                $row[$key] = $value;
            }
            $row['updated_at'] = date('Y-m-d H:i:s');
            $updated = true;
            break;
        }
    }
    unset($row);
    if ($updated) {
        api_recharge_file_save_rows($rows);
    }
    return $updated;
}

function api_recharge_to_pay_payload(array $input): array
{
    if (!api_setting_bool('recharge_enabled', true)) {
        return api_error('Recharge is disabled', 405, -1);
    }
    $pdo = api_pdo();
    $user = api_primary_user();
    $amount = (float) api_param($input, 'amount', api_param($input, 'rechargeAmount', 0));
    if ($amount <= 0) {
        return api_error('Invalid amount', 401, -1);
    }
    $methodId = (int) api_param($input, 'rechargeCategoryId', api_param($input, 'categoryId', api_param($input, 'payTypeId', 0)));
    $methods = api_payment_methods(true);
    $method = $methods[0];
    foreach ($methods as $row) {
        if ($methodId > 0 && (int) $row['id'] === $methodId) {
            $method = $row;
            break;
        }
    }
    if ($amount < (float) $method['min_amount'] || $amount > (float) $method['max_amount']) {
        return api_error('Amount outside payment method limit', 410, -1);
    }

    $orderNo = 'PAY' . date('YmdHis') . mt_rand(1000, 9999);
    $createTime = api_now_ms();
    $frontType = api_recharge_front_type((string) ($method['method_type'] ?? 'UPI'));
    $raw = [
        'request' => $input['params'] ?? [],
        'method' => [
            'id' => (int) $method['id'],
            'methodName' => (string) $method['method_name'],
            'methodType' => (string) $method['method_type'],
            'frontType' => $frontType,
            'accountName' => (string) ($method['account_name'] ?? ''),
            'accountValue' => (string) ($method['account_value'] ?? ''),
            'qrText' => (string) ($method['qr_text'] ?? ''),
        ],
        'createdAtMs' => $createTime,
    ];

    if ($pdo) {
        try {
            $stmt = $pdo->prepare("INSERT INTO recharge_orders (order_no, user_id, method_id, method_name, amount, status, raw_json, updated_at) VALUES (?, ?, ?, ?, ?, 'Pending', ?, CURRENT_TIMESTAMP)");
            $stmt->execute([$orderNo, $user['id'], $method['id'], $method['method_name'], $amount, api_json_value($raw)]);
        } catch (Throwable $e) {
        }
    } else {
        api_recharge_file_add([
            'id' => count(api_recharge_file_rows()) + 1,
            'order_no' => $orderNo,
            'user_id' => (int) ($user['id'] ?? 1),
            'method_id' => (int) $method['id'],
            'method_name' => (string) $method['method_name'],
            'amount' => $amount,
            'status' => 'Pending',
            'utr' => '',
            'raw_json' => api_json_value($raw),
            'created_at' => date('Y-m-d H:i:s'),
            'updated_at' => date('Y-m-d H:i:s'),
        ]);
    }
    api_audit('recharge_order', $orderNo, ['amount' => $amount, 'method' => $method['method_name']]);

    $detailPath = '/pay/?orderNo=' . rawurlencode($orderNo);
    $detailUrl = $detailPath;
    $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== '') {
        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $detailUrl = $scheme . '://' . $host . $detailPath;
    }

    // Do not expose orderNo as "orderNo" here; the existing SPA uses that field to
    // navigate in the same tab. redirectUrl opens the manual gateway in a new tab.
    return api_success([
        'merchantOrderNo' => $orderNo,
        'rechargeNumber' => $orderNo,
        'createTime' => $createTime,
        'redirectUrl' => $detailUrl,
        'scanCodePay' => false,
        'amount' => $amount,
        'originAmount' => $amount,
        'status' => 'Pending',
        'rechargeType' => $frontType,
        'rechargeChannelId' => (int) $method['id'],
        'rechargeChannelName' => (string) $method['method_name'],
        'methodName' => (string) $method['method_name'],
        'accountName' => (string) ($method['account_name'] ?? ''),
        'accountValue' => (string) ($method['account_value'] ?? ''),
        'qrText' => (string) ($method['qr_text'] ?? ''),
        'upiId' => (string) ($method['account_value'] ?? ''),
        'expireTime' => $createTime + 900000,
        'expiredTime' => $createTime + 900000,
    ]);
}

function api_recharge_order_detail_payload(array $input): array
{
    $pdo = api_pdo();
    $user = api_primary_user();
    $orderNo = (string) api_param($input, 'orderNo', api_param($input, 'rechargeNumber', ''));
    if ($orderNo === '') {
        return api_error('Order number is required', 401, -1);
    }

    $row = null;
    if ($pdo) {
        try {
            $stmt = $pdo->prepare("SELECT * FROM recharge_orders WHERE order_no = ? AND user_id = ? LIMIT 1");
            $stmt->execute([$orderNo, $user['id']]);
            $row = $stmt->fetch();
        } catch (Throwable $e) {
            $row = null;
        }
    }
    if (!$row) {
        $row = api_recharge_file_find($orderNo);
    }
    if (!$row) {
        return api_error('Recharge order not found', 404, -1);
    }

    $method = null;
    foreach (api_payment_methods(false) as $candidate) {
        if ((int) ($candidate['id'] ?? 0) === (int) ($row['method_id'] ?? 0)) {
            $method = $candidate;
            break;
        }
    }
    if (!$method) {
        $method = api_payment_methods(false)[0];
    }

    $created = strtotime((string) ($row['created_at'] ?? '')) ?: time();
    $createTime = (int) api_param($input, 'createTime', $created * 1000);
    $frontType = api_recharge_front_type((string) ($method['method_type'] ?? 'UPI'));
    $accountName = (string) ($method['account_name'] ?? api_setting('upi_display_name', 'Dhani Win'));
    $accountValue = (string) ($method['account_value'] ?? api_setting('upi_id', 'rajputajay22266-1@oksbi'));
    $qrText = (string) ($method['qr_text'] ?? '');

    $rechargeInfo = [
        'HolderName' => $accountName,
        'AccountNo' => $accountValue,
        'QRCodeURL' => $qrText,
        'QRText' => $qrText,
        'UsdtType' => '',
        'amount' => (float) $row['amount'],
        'orderNo' => (string) $row['order_no'],
        'createTime' => $createTime,
        'rechargeType' => $frontType,
    ];
    $customerInfo = [
        'holderName' => $accountName,
        'accountNo' => $accountValue,
        'amount' => (float) $row['amount'],
        'rechargeType' => $frontType,
    ];

    return api_success([
        'id' => (int) ($row['id'] ?? 0),
        'orderNo' => (string) $row['order_no'],
        'merchantOrderNo' => (string) $row['order_no'],
        'createTime' => $createTime,
        'amount' => (float) $row['amount'],
        'originAmount' => (float) $row['amount'],
        'expiredTime' => $created * 1000 + 900000,
        'status' => (string) $row['status'],
        'state' => (string) $row['status'],
        'rechargeType' => $frontType,
        'rechargeInfo' => api_json_value($rechargeInfo),
        'customerInfo' => api_json_value($customerInfo),
        'transactionId' => (string) ($row['utr'] ?? ''),
    ]);
}

function api_recharge_submit_certificate_payload(array $input): array
{
    $pdo = api_pdo();
    $user = api_primary_user();
    $orderNo = (string) api_param($input, 'orderNo', api_param($input, 'rechargeNumber', ''));
    $utr = trim((string) api_param($input, 'transactionId', api_param($input, 'utr', '')));
    if ($orderNo === '') {
        return api_error('Order number is required', 401, -1);
    }
    if ($utr === '') {
        return api_error('UTR number is required', 402, -1);
    }
    if ($pdo) {
        try {
            $stmt = $pdo->prepare("UPDATE recharge_orders SET utr = ?, status = 'PendingReview', updated_at = CURRENT_TIMESTAMP WHERE order_no = ? AND user_id = ?");
            $stmt->execute([$utr, $orderNo, $user['id']]);
        } catch (Throwable $e) {
            return api_error('Unable to submit UTR', 403, -1);
        }
    } else {
        api_recharge_file_update($orderNo, ['utr' => $utr, 'status' => 'PendingReview']);
    }
    api_audit('recharge_submit_utr', $orderNo, ['utr' => $utr]);
    return api_success(true);
}

function api_recharge_cancel_payload(array $input): array
{
    $pdo = api_pdo();
    $user = api_primary_user();
    $orderNo = (string) api_param($input, 'orderNo', api_param($input, 'rechargeNumber', ''));
    if ($orderNo === '') {
        return api_error('Order number is required', 401, -1);
    }
    if ($pdo) {
        try {
            $stmt = $pdo->prepare("UPDATE recharge_orders SET status = 'Cancel', updated_at = CURRENT_TIMESTAMP WHERE order_no = ? AND user_id = ? AND status IN ('Pending','PendingReview')");
            $stmt->execute([$orderNo, $user['id']]);
        } catch (Throwable $e) {
            return api_error('Unable to cancel order', 403, -1);
        }
    } else {
        api_recharge_file_update($orderNo, ['status' => 'Cancel']);
    }
    api_audit('recharge_cancel', $orderNo);
    return api_success(true);
}

function api_recharge_record_payload(array $input): array
{
    $pdo = api_pdo();
    $user = api_primary_user();
    $pageNo = max(1, (int) api_param($input, 'pageNo', 1));
    $pageSize = max(1, min(100, (int) api_param($input, 'pageSize', 10)));
    $offset = ($pageNo - 1) * $pageSize;
    if (!$pdo) {
        $rows = array_reverse(api_recharge_file_rows());
        $total = count($rows);
        $rows = array_slice($rows, $offset, $pageSize);
        $list = [];
        foreach ($rows as $row) {
            $time = strtotime((string) ($row['created_at'] ?? ''));
            $list[] = [
                'orderNo' => (string) ($row['order_no'] ?? ''),
                'amount' => (float) ($row['amount'] ?? 0),
                'status' => (string) ($row['status'] ?? 'Pending'),
                'state' => (string) ($row['status'] ?? 'Pending'),
                'rechargeType' => (string) ($row['method_name'] ?? 'UPI'),
                'utr' => (string) ($row['utr'] ?? ''),
                'createTime' => $time ? $time * 1000 : api_now_ms(),
            ];
        }
        return api_success([
            'list' => $list,
            'pageNo' => $pageNo,
            'pageSize' => $pageSize,
            'totalPage' => $pageSize > 0 ? (int) ceil($total / $pageSize) : 0,
            'totalCount' => $total,
        ]);
    }
    try {
        $stmt = $pdo->prepare("SELECT COUNT(*) FROM recharge_orders WHERE user_id = ?");
        $stmt->execute([$user['id']]);
        $total = (int) $stmt->fetchColumn();
        $stmt = $pdo->prepare("SELECT * FROM recharge_orders WHERE user_id = ? ORDER BY id DESC LIMIT $pageSize OFFSET $offset");
        $stmt->execute([$user['id']]);
        $rows = $stmt->fetchAll();
    } catch (Throwable $e) {
        $total = 0;
        $rows = [];
    }
    $list = [];
    foreach ($rows as $row) {
        $list[] = [
            'orderNo' => (string) $row['order_no'],
            'amount' => (float) $row['amount'],
            'status' => (string) $row['status'],
            'state' => (string) $row['status'],
            'rechargeType' => (string) ($row['method_name'] ?? 'UPI'),
            'utr' => (string) ($row['utr'] ?? ''),
            'createTime' => strtotime((string) $row['created_at']) ? strtotime((string) $row['created_at']) * 1000 : api_now_ms(),
        ];
    }
    return api_success([
        'list' => $list,
        'pageNo' => $pageNo,
        'pageSize' => $pageSize,
        'totalPage' => $pageSize > 0 ? (int) ceil($total / $pageSize) : 0,
        'totalCount' => $total,
    ]);
}

function api_withdraw_basic_info_payload(): array
{
    $user = api_primary_user();
    return api_success([
        'balance' => (float) $user['wallet_balance'],
        'realName' => '',
        'amountCoding' => api_setting_float('amount_coding', 4.11),
        'hasWithdrawPassword' => false,
        'withdrawCategoryList' => [
            ['id' => 400080, 'tenantId' => (int) (api_config()['site']['tenant_id'] ?? 6006), 'withdrawType' => 'UPI', 'name' => 'UPI', 'iconUrl' => '/assets/icons/icon-192.png', 'selectedIconUrl' => '/assets/icons/icon-192.png', 'userMaxBindCount' => 1, 'maxWithdrawTimes' => 5, 'minAmount' => 100.0, 'maxAmount' => 50000.0, 'feeAmountRangeMin' => 0.0, 'feeAmountRangeMax' => 0.0, 'feeType' => 0, 'feePercent' => 0.0, 'fee' => 0.0, 'allowStartTime' => '00:00', 'allowEndTime' => '23:59', 'sort' => 150, 'state' => api_setting_bool('withdraw_enabled', true) ? 1 : 0],
            ['id' => 400078, 'tenantId' => (int) (api_config()['site']['tenant_id'] ?? 6006), 'withdrawType' => 'BankCard', 'name' => 'BankCard', 'iconUrl' => '/assets/icons/icon-192.png', 'selectedIconUrl' => '/assets/icons/icon-192.png', 'userMaxBindCount' => 1, 'maxWithdrawTimes' => 5, 'minAmount' => 110.0, 'maxAmount' => 50000.0, 'feeAmountRangeMin' => 0.0, 'feeAmountRangeMax' => 0.0, 'feeType' => 0, 'feePercent' => 0.0, 'fee' => 0.0, 'allowStartTime' => '00:00', 'allowEndTime' => '23:59', 'sort' => 100, 'state' => api_setting_bool('withdraw_enabled', true) ? 1 : 0],
        ],
        'addWalletNeedEmailVerifyCode' => false,
        'addWalletNeedSmsVerifyCode' => true,
        'userTodayWithdrawFreeCount' => 0,
        'userTodayWithdrawAmount' => -1.0,
        'userTodayWithdrawCount' => -1,
        'isWithdrawAmountFixed' => false,
        'fixedWithdrawAmountList' => [],
        'isWithdrawAmountAllowInput' => false,
        'pendingCompensationAmount' => 0.0,
        'isNeedWithdrawPassword' => false,
    ]);
}

function api_withdraw_submit_payload(array $input): array
{
    if (!api_setting_bool('withdraw_enabled', true)) {
        return api_error('Withdraw is disabled', 405, -1);
    }
    $pdo = api_pdo();
    $user = api_primary_user();
    $amount = (float) api_param($input, 'amount', api_param($input, 'withdrawAmount', 0));
    if ($amount <= 0) {
        return api_error('Invalid amount', 401, -1);
    }
    if ((float) $user['wallet_balance'] < $amount) {
        return api_error('Insufficient balance', 142, -1, ['balance' => (float) $user['wallet_balance']]);
    }
    $orderNo = 'WD' . date('YmdHis') . mt_rand(1000, 9999);
    if ($pdo) {
        try {
            $pdo->beginTransaction();
            $stmt = $pdo->prepare("UPDATE api_users SET wallet_balance = wallet_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND wallet_balance >= ?");
            $stmt->execute([$amount, $user['id'], $amount]);
            if ($stmt->rowCount() < 1) {
                $pdo->rollBack();
                return api_error('Insufficient balance', 142, -1, ['balance' => (float) $user['wallet_balance']]);
            }
            $stmt = $pdo->prepare("INSERT INTO withdraw_orders (order_no, user_id, withdraw_type, amount, status, account_json, updated_at) VALUES (?, ?, ?, ?, 'Pending', ?, CURRENT_TIMESTAMP)");
            $stmt->execute([$orderNo, $user['id'], (string) api_param($input, 'withdrawType', 'UPI'), $amount, api_json_value($input['params'] ?? [])]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            return api_error('Withdraw failed', 403, -1);
        }
    }
    api_audit('withdraw_order', $orderNo, ['amount' => $amount]);
    return api_success(['orderNo' => $orderNo, 'amount' => $amount, 'status' => 'Pending']);
}

function api_withdraw_history_payload(array $input): array
{
    $pdo = api_pdo();
    if (!$pdo) {
        return api_success(api_empty_page($input));
    }
    $user = api_primary_user();
    $pageNo = max(1, (int) api_param($input, 'pageNo', 1));
    $pageSize = max(1, min(100, (int) api_param($input, 'pageSize', 10)));
    $offset = ($pageNo - 1) * $pageSize;
    try {
        $stmt = $pdo->prepare("SELECT COUNT(*) FROM withdraw_orders WHERE user_id = ?");
        $stmt->execute([$user['id']]);
        $total = (int) $stmt->fetchColumn();
        $stmt = $pdo->prepare("SELECT * FROM withdraw_orders WHERE user_id = ? ORDER BY id DESC LIMIT $pageSize OFFSET $offset");
        $stmt->execute([$user['id']]);
        $rows = $stmt->fetchAll();
    } catch (Throwable $e) {
        $total = 0;
        $rows = [];
    }
    $list = [];
    foreach ($rows as $row) {
        $list[] = [
            'orderNo' => (string) $row['order_no'],
            'amount' => (float) $row['amount'],
            'withdrawType' => (string) $row['withdraw_type'],
            'status' => (string) $row['status'],
            'state' => (string) $row['status'],
            'createTime' => strtotime((string) $row['created_at']) ? strtotime((string) $row['created_at']) * 1000 : api_now_ms(),
        ];
    }
    return api_success([
        'list' => $list,
        'pageNo' => $pageNo,
        'pageSize' => $pageSize,
        'totalPage' => $pageSize > 0 ? (int) ceil($total / $pageSize) : 0,
        'totalCount' => $total,
    ]);
}

function api_thirdgame_transfer_payload(array $input, bool $recover = false): array
{
    $pdo = api_pdo();
    $user = api_primary_user();
    if (!$pdo) {
        return api_success([
            'walletBalance' => (float) $user['wallet_balance'],
            'gameBalance' => (float) $user['game_balance'],
            'balance' => (float) $user['game_balance'],
        ]);
    }

    $amount = (float) api_param($input, 'amount', api_param($input, 'transferAmount', 0));
    $direction = strtolower((string) api_param($input, 'direction', api_param($input, 'transferType', '')));
    $toGame = !$recover;
    if (in_array($direction, ['recover', 'togamewallet', '2', 'out'], true)) {
        $toGame = false;
    }
    if (in_array($direction, ['togame', 'ingame', '1', 'in'], true)) {
        $toGame = true;
    }

    $wallet = (float) $user['wallet_balance'];
    $game = (float) $user['game_balance'];
    if ($amount <= 0) {
        $amount = $toGame ? $wallet : $game;
    }
    if ($amount <= 0) {
        return api_success(['walletBalance' => $wallet, 'gameBalance' => $game, 'balance' => $game, 'amount' => 0.0]);
    }
    if ($toGame && $wallet < $amount) {
        return api_error('Insufficient balance', 142, -1, ['walletBalance' => $wallet, 'gameBalance' => $game]);
    }
    if (!$toGame && $game < $amount) {
        return api_error('Insufficient balance', 142, -1, ['walletBalance' => $wallet, 'gameBalance' => $game]);
    }

    try {
        if ($toGame) {
            $stmt = $pdo->prepare("UPDATE api_users SET wallet_balance = wallet_balance - ?, game_balance = game_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND wallet_balance >= ?");
            $stmt->execute([$amount, $amount, $user['id'], $amount]);
        } else {
            $stmt = $pdo->prepare("UPDATE api_users SET game_balance = game_balance - ?, wallet_balance = wallet_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND game_balance >= ?");
            $stmt->execute([$amount, $amount, $user['id'], $amount]);
        }
    } catch (Throwable $e) {
        return api_error('Transfer failed', 403, -1);
    }

    $fresh = api_user_fresh();
    $after = api_user_balances($fresh);
    api_audit('thirdgame_transfer', $toGame ? 'wallet_to_game' : 'game_to_wallet', ['amount' => $amount]);
    return api_success([
        'walletBalance' => $after['wallet'],
        'gameBalance' => $after['game'],
        'balance' => $after['game'],
        'amount' => $amount,
    ]);
}

function api_home_popup_payload(): array
{
    $pdo = api_pdo();
    $rows = [];
    if ($pdo) {
        try {
            $rows = $pdo->query("SELECT * FROM site_popups WHERE enabled = 1 ORDER BY sort_order DESC, id DESC LIMIT 10")->fetchAll();
        } catch (Throwable $e) {
            $rows = [];
        }
    }
    if (!$rows && api_setting_bool('popup_enabled', true)) {
        $rows = [[
            'id' => 600056,
            'title' => api_setting('home_popup_title', 'free 500'),
            'content' => '',
            'image_url' => api_setting('home_popup_image', '/img/6006/other/111109657-38344-file_20260510111109590.webp'),
            'jump_type' => 3,
            'jump_link' => '',
            'jump_page' => 12,
            'frequency' => 3,
            'sort_order' => 998,
            'is_force' => 0,
        ]];
    }
    $data = [];
    foreach ($rows as $row) {
        $id = (int) ($row['id'] ?? 600056);
        $image = (string) ($row['image_url'] ?? '');
        $data[] = [
            'id' => $id,
            'title' => (string) ($row['title'] ?? ''),
            'content' => $row['content'] ?? null,
            'imageUrl' => $image,
            'sort' => (int) ($row['sort_order'] ?? 100),
            'isForcePopup' => !empty($row['is_force']),
            'commonPopupType' => 0,
            'popupInfo' => [
                'id' => $id,
                'cover' => $image,
                'title' => (string) ($row['title'] ?? ''),
                'isShowCountDown' => false,
                'isForcePopup' => !empty($row['is_force']),
                'jumpType' => (int) ($row['jump_type'] ?? 3),
                'jumpLink' => (string) ($row['jump_link'] ?? ''),
                'jumpPage' => (int) ($row['jump_page'] ?? 12),
                'frequency' => (int) ($row['frequency'] ?? 3),
                'sort' => (int) ($row['sort_order'] ?? 100),
                'customizePopupType' => 0,
                'jumpTypeText' => 'Page',
                'jumpPageText' => 'Invitation Wheel',
                'frequencyText' => 'Every login',
                'tag' => '',
            ],
        ];
    }
    return api_success($data);
}

function api_share_copy_payload(): array
{
    $user = api_primary_user();
    $inviteCode = (string) ($user['user_id'] ?? '132257');
    $domain = (string) api_setting('share_domain', 'https://dhaniwin.club9.eu.cc');
    if ($domain === 'https://dhaniwin7.com') {
        $domain = 'https://dhaniwin.club9.eu.cc';
    }
    $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== '' && strpos($host, 'localhost') === false && strpos($host, '127.0.0.1') === false) {
        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $domain = $scheme . '://' . $host;
    }
    $inviteLink = rtrim($domain, '/') . '/register?inviteCode=' . $inviteCode;
    $shareContent = (string) api_setting('share_content', '👉Invite your friends to join Dhaniwin and easily unlock free ₹500 bonus! 🔗 #inviteLink#');
    $shareContent = str_replace('#inviteLink#', $inviteLink, $shareContent);

    return api_success([
        'shareContent' => $shareContent,
        'inviteCode' => $inviteCode,
        'shareCode' => strtolower(substr(sha1($inviteCode), 0, 8)),
        'giftAmount' => api_setting_float('invite_gift_amount', 0.0),
        'officialUrl' => parse_url($domain, PHP_URL_HOST) ?: $domain,
        'shareDomain' => $domain,
        'inviteRewardUserCount' => 0,
        'inviteRewards' => null,
        'agentL6InviteTaskSwitch' => api_setting_bool('agent_l6_invite_task', false),
    ]);
}

function api_agent_promotion_payload(): array
{
    $user = api_primary_user();
    $inviteCode = (string) ($user['user_id'] ?? '132257');
    return api_success([
        'myInviteCode' => $inviteCode,
        'isOpenRedEnvelope' => api_setting_bool('agent_red_envelope', false),
        'firstChildCount' => 0,
        'childCount' => 0,
        'yesterdayTotalCommission' => 0.0,
        'yesterdayDirectSubRegisterCount' => 0,
        'yesterdayDirectSubRechargeCount' => 0,
        'yesterdayDirectSubFirstRechargeCount' => 0,
        'yesterdayDirectSubRechargeAmount' => 0.0,
        'yesterdayTeamRegisterCount' => 0,
        'yesterdayTeamRechargeCount' => 0,
        'yesterdayTeamFirstRechargeCount' => 0,
        'yesterdayTeamRechargeAmount' => 0.0,
        'totalCommission' => api_setting_float('agent_total_commission', 0.0),
        'weekTotalCommission' => api_setting_float('agent_week_commission', 0.0),
    ]);
}

function api_agent_rebate_rates_payload(): array
{
    $rates = [];
    for ($level = 0; $level <= 9; $level++) {
        $base = 0.5 + ($level * 0.08);
        $rateList = [];
        for ($h = 1; $h <= 6; $h++) {
            $rateList[] = ['hierarchy' => $h, 'rebateRate' => round($base / max(1, $h * $h), 8)];
        }
        $rates[] = ['rebateLv' => $level, 'type' => 3, 'rebateRateList' => $rateList];
    }
    return api_success([
        'electronicList' => $rates,
        'videoList' => $rates,
        'sportList' => $rates,
        'lotteryList' => $rates,
        'chessCardList' => $rates,
    ]);
}

function api_wheel_reward_list(string $wheelType): array
{
    $key = $wheelType === 'recharge' ? 'recharge_wheel_prizes' : 'invited_wheel_prizes';
    $prizes = api_csv_numbers((string) api_setting($key, ''), $wheelType === 'recharge' ? [6, 16, 37, 56, 77, 166, 366, 666] : [0.41, 0.72, 10, 27, 57, 77, 87, 177, 377, 500]);
    $rows = [];
    $id = 1;
    foreach ($prizes as $amount) {
        $rows[] = [
            'id' => $id++,
            'rewardType' => 1,
            'rewardAmount' => (float) $amount,
            'icon' => '/assets/icons/icon-192.png',
        ];
    }
    return $rows;
}

function api_wheel_spin_count(string $wheelType, int $userId): int
{
    $base = max(1, (int) api_setting($wheelType === 'recharge' ? 'recharge_wheel_spin_count' : 'invited_wheel_spin_count', '1'));
    $pdo = api_pdo();
    if (!$pdo) {
        return max(0, $base);
    }
    try {
        $stmt = $pdo->prepare("SELECT COUNT(*) FROM wheel_spins WHERE user_id = ? AND wheel_type = ? AND created_at >= ?");
        $stmt->execute([$userId, $wheelType, date('Y-m-d 00:00:00')]);
        $used = (int) $stmt->fetchColumn();
        return max(0, $base - $used);
    } catch (Throwable $e) {
        return max(0, $base);
    }
}

function api_invited_wheel_info_payload(): array
{
    $user = api_primary_user();
    $records = api_wheel_records('invited', 5);
    $display = api_csv_numbers((string) api_setting('invited_wheel_prizes', ''), [27, 77, 87, 377, 57, 500, 177]);
    return api_success([
        'isOpenInvitedWheel' => api_setting_bool('invited_wheel_enabled', true),
        'isCashToMainWallet' => true,
        'cashToMainWalletCodeWash' => 1,
        'isOpenDiskDisplay' => true,
        'isFirstInvitedWheel' => false,
        'userInvitedWheelCount' => api_wheel_spin_count('invited', (int) $user['id']),
        'userInvitedWheelAmount' => (float) $user['wallet_balance'],
        'invitedWheelTotalPrizeAmount' => api_setting_float('invited_wheel_total_prize', 500.0),
        'expiredTime' => api_now_ms() + 86400000,
        'diskDisplayAmount' => array_values($display),
        'noWinningRandomAmount' => [0.0, 10.0],
        'lastWheelRecordList' => $records,
    ]);
}

function api_recharge_wheel_info_payload(): array
{
    $user = api_primary_user();
    $rechargeAmount = 0.0;
    $pdo = api_pdo();
    if ($pdo) {
        try {
            $stmt = $pdo->prepare("SELECT COALESCE(SUM(amount),0) FROM recharge_orders WHERE user_id = ? AND LOWER(status) IN ('approved','success','completed','complete','paid')");
            $stmt->execute([$user['id']]);
            $rechargeAmount = (float) $stmt->fetchColumn();
        } catch (Throwable $e) {
        }
    }
    $rewardList = api_wheel_reward_list('recharge');
    $wheel = [
        'remainSpinCount' => api_wheel_spin_count('recharge', (int) $user['id']),
        'taskList' => [
            ['id' => 2, 'rechargeAmount' => 500.0, 'spinCount' => 1],
            ['id' => 3, 'rechargeAmount' => 3000.0, 'spinCount' => 1],
            ['id' => 12, 'rechargeAmount' => 5000.0, 'spinCount' => 1],
        ],
        'rewardList' => $rewardList,
    ];
    return api_success([
        'isOpen' => api_setting_bool('recharge_wheel_enabled', true),
        'currentValidDate' => null,
        'rechargeAmount' => $rechargeAmount,
        'rewardUpAmount' => api_setting_float('recharge_wheel_reward_up_amount', 29999.0),
        'silverWheelInfo' => $wheel,
        'goldWheelInfo' => $wheel,
        'diamondWheelInfo' => $wheel,
        'specialWheelInfo' => $wheel,
        'isSpecialWheelUnlock' => $rechargeAmount >= api_setting_float('special_wheel_unlock_amount', 300000.0),
        'specialWheelUnlockAmount' => api_setting_float('special_wheel_unlock_amount', 300000.0),
    ]);
}

function api_wheel_spin_payload(string $wheelType): array
{
    $enabledKey = $wheelType === 'recharge' ? 'recharge_wheel_enabled' : 'invited_wheel_enabled';
    if (!api_setting_bool($enabledKey, true)) {
        return api_error('Wheel is closed', 405, -1);
    }
    $pdo = api_pdo();
    $user = api_primary_user();
    $remaining = api_wheel_spin_count($wheelType, (int) $user['id']);
    if ($remaining <= 0 && api_setting_bool('wheel_allow_daily_extra_spin', true)) {
        $remaining = 1;
    }
    if ($remaining <= 0) {
        return api_error('No spin count', 15, -1);
    }
    $rewards = api_wheel_reward_list($wheelType);
    $index = api_lottery_seed($wheelType . api_now_ms() . mt_rand()) % max(1, count($rewards));
    $reward = $rewards[$index] ?? ['rewardAmount' => 0, 'rewardType' => 1];
    $amount = (float) $reward['rewardAmount'];
    $isWin = $amount > 0;
    if ($pdo) {
        try {
            $pdo->beginTransaction();
            $column = $wheelType === 'recharge' ? 'game_balance' : 'wallet_balance';
            if ($amount > 0) {
                $stmt = $pdo->prepare("UPDATE api_users SET $column = $column + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
                $stmt->execute([$amount, $user['id']]);
            }
            $stmt = $pdo->prepare("INSERT INTO wheel_spins (user_id, wheel_type, reward_type, prize_amount, is_win, raw_json) VALUES (?, ?, ?, ?, ?, ?)");
            $stmt->execute([$user['id'], $wheelType, (int) $reward['rewardType'], $amount, $isWin ? 1 : 0, api_json_value($reward)]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
        }
    }
    api_audit('wheel_spin', $wheelType, ['amount' => $amount, 'user' => $user['user_id']]);
    return api_success([
        'isFirstInvitedWheel' => false,
        'prizeAmount' => $amount,
        'rewardAmount' => $amount,
        'rewardType' => (int) $reward['rewardType'],
        'isWin' => $isWin,
        'firstInvitedWheelDatas' => null,
    ]);
}

function api_wheel_records(string $wheelType, int $limit = 20): array
{
    $pdo = api_pdo();
    if (!$pdo) {
        return [];
    }
    try {
        $stmt = $pdo->prepare("SELECT ws.*, u.nickname, u.user_id FROM wheel_spins ws LEFT JOIN api_users u ON u.id = ws.user_id WHERE ws.wheel_type = ? ORDER BY ws.id DESC LIMIT $limit");
        $stmt->execute([$wheelType]);
        $rows = $stmt->fetchAll();
    } catch (Throwable $e) {
        $rows = [];
    }
    $list = [];
    foreach ($rows as $row) {
        $time = strtotime((string) $row['created_at']);
        $list[] = [
            'userId' => (int) ($row['user_id'] ?? 0),
            'userName' => (string) ($row['nickname'] ?? 'Member'),
            'nickName' => (string) ($row['nickname'] ?? 'Member'),
            'invitedWheelAmount' => (float) ($row['prize_amount'] ?? 0),
            'prizeAmount' => (float) ($row['prize_amount'] ?? 0),
            'rewardType' => (int) ($row['reward_type'] ?? 1),
            'rewardAmount' => (float) ($row['prize_amount'] ?? 0),
            'createTime' => $time ? $time * 1000 : api_now_ms(),
        ];
    }
    return $list;
}

function api_wheel_record_page(string $wheelType, array $input): array
{
    $list = api_wheel_records($wheelType, max(10, (int) api_param($input, 'pageSize', 20)));
    if (strpos(strtolower((string) api_param($input, 'rawList', '')), 'true') !== false) {
        return api_success($list);
    }
    return api_success([
        'list' => $list,
        'pageNo' => max(1, (int) api_param($input, 'pageNo', 1)),
        'totalPage' => count($list) ? 1 : 0,
        'totalCount' => count($list),
    ]);
}

function api_user_financial_payload(array $input): array
{
    $user = api_primary_user();
    $list = [];
    foreach (api_recharge_record_payload($input)['data']['list'] ?? [] as $row) {
        $list[] = ['id' => $row['orderNo'], 'orderNo' => $row['orderNo'], 'vendorCode' => '', 'type' => 'Recharge', 'subType' => '', 'amount' => (float) $row['amount'], 'backAmount' => (float) $user['wallet_balance'], 'createTime' => $row['createTime'], 'remark' => $row['status']];
    }
    foreach (api_withdraw_history_payload($input)['data']['list'] ?? [] as $row) {
        $list[] = ['id' => $row['orderNo'], 'orderNo' => $row['orderNo'], 'vendorCode' => '', 'type' => 'Withdraw', 'subType' => '', 'amount' => -(float) $row['amount'], 'backAmount' => (float) $user['wallet_balance'], 'createTime' => $row['createTime'], 'remark' => $row['status']];
    }
    foreach (api_lottery_record_page($input)['data']['list'] ?? [] as $row) {
        $list[] = ['id' => $row['orderNo'], 'orderNo' => $row['orderNo'], 'vendorCode' => 'ARLottery', 'type' => 'Bet', 'subType' => $row['gameCode'], 'amount' => -(float) $row['betAmount'], 'backAmount' => (float) $user['game_balance'], 'createTime' => $row['createTime'], 'remark' => $row['status']];
    }
    usort($list, function ($a, $b) {
        return (int) $b['createTime'] <=> (int) $a['createTime'];
    });
    return api_success([
        'list' => array_slice($list, 0, max(10, (int) api_param($input, 'pageSize', 20))),
        'pageNo' => max(1, (int) api_param($input, 'pageNo', 1)),
        'totalPage' => count($list) ? 1 : 0,
        'totalCount' => count($list),
    ]);
}

function api_explicit_dynamic_response(string $endpoint, array $input): ?array
{
    $endpoint = api_normalize_endpoint($endpoint);
    $e = strtolower($endpoint);

    $blocked = api_request_block_row();
    if ($blocked) {
        return api_error('Account or IP is blocked: ' . (string) ($blocked['reason'] ?? ''), 116, -1);
    }

    if (strpos($e, 'lottery/') === 0) {
        return api_lottery_dynamic($endpoint, $input);
    }

    if ($e === 'home/register') {
        return api_user_register($input);
    }
    if ($e === 'home/login') {
        return api_user_login($input);
    }
    if (in_array($e, [
        'home/autologin', 'home/mobileautologin', 'home/emailautologin',
        'home/shortcodelogin', 'home/refreshtoken'
    ], true)) {
        return api_user_autologin($input);
    }

    if ($e === 'user/getuserinfo') {
        return api_success(api_user_info_data());
    }
    if ($e === 'home/checkcanbet') {
        return api_success((bool) api_primary_user()['can_bet']);
    }
    if ($e === 'home/loginoff') {
        return api_success(true);
    }
    if ($e === 'home/sendverifiycode') {
        return api_success(true);
    }
    if ($e === 'home/appshortcode') {
        return api_success(['shortCode' => '123456', 'expireTime' => api_now_ms() + 300000]);
    }
    if ($e === 'home/applaunch') {
        $apiUrl = api_setting_bool('force_local_api', true) ? '/api' : (string) api_setting('api_url', '/api');
        return api_success(['status' => 1, 'api' => $apiUrl]);
    }
    if ($e === 'home/getcommonpopup') {
        return api_home_popup_payload();
    }
    if ($e === 'thirdgame/getargamebalance') {
        $user = api_user_fresh();
        $bal = api_user_balances($user);
        $currency = (string) (api_config()['site']['currency'] ?? 'INR');
        return api_success([
            'arGameBalance' => $bal['game'],
            'balance' => $bal['game'],
            'gameBalance' => $bal['game'],
            'walletBalance' => $bal['wallet'],
            'currency' => $currency,
            'tenantId' => (int) (api_config()['site']['tenant_id'] ?? 6006),
            'userId' => (int) ($user['user_id'] ?? 0),
        ]);
    }
    if ($e === 'thirdgame/getargameandplatwallets') {
        $user = api_user_fresh();
        $bal = api_user_balances($user);
        $currency = (string) (api_config()['site']['currency'] ?? 'INR');
        $tenantId = (int) (api_config()['site']['tenant_id'] ?? 6006);
        $uid = (int) ($user['user_id'] ?? 0);
        return api_success([
            ['vendorCode' => 'ARGame', 'balance' => $bal['game'], 'currency' => $currency, 'tenantId' => $tenantId, 'userId' => $uid],
            ['vendorCode' => 'PlatForm', 'balance' => $bal['wallet'], 'currency' => $currency, 'tenantId' => $tenantId, 'userId' => $uid],
        ]);
    }
    if ($e === 'thirdgame/getgameurl') {
        $member = api_user_fresh();
        $token = (string) ($member['token'] ?? '');
        if (empty($member['id']) || $token === '') {
            return api_error('Please login again to open the game', 143, 401);
        }
        $gameCode = (string) api_param($input, 'gameCode', '');
        $vendor = (string) api_param($input, 'vendorCode', 'ARLottery');
        api_issue_bearer($token);
        return api_success([
            'url' => api_request_origin() . '/?Token=' . rawurlencode($token)
                . '&gameCode=' . rawurlencode($gameCode)
                . '&vendorCode=' . rawurlencode($vendor),
            'vendorCode' => $vendor,
            'gameCode' => $gameCode,
            'token' => $token,
            'isLogin' => true,
        ]);
    }
    if ($e === 'thirdgame/transfer') {
        return api_thirdgame_transfer_payload($input, false);
    }
    if ($e === 'thirdgame/recoversaasbalance') {
        return api_thirdgame_transfer_payload($input, true);
    }
    if ($e === 'thirdgame/notifyargamerecover') {
        $bal = api_user_balances(api_user_fresh());
        return api_success([
            'walletBalance' => $bal['wallet'],
            'gameBalance' => $bal['game'],
            'balance' => $bal['game'],
        ]);
    }
    if ($e === 'game/gethotgamelist') {
        $home = api_read_snapshot_payload('Home/GetHomeAllGameList');
        $data = $home['data']['hotGames'] ?? [];
        return api_success($data);
    }
    if ($e === 'game/getgamedrawtimelist') {
        return api_success(api_lottery_game_list());
    }
    if ($e === 'activity/getsharecopy') {
        return api_share_copy_payload();
    }
    if ($e === 'activity/getuserinvitedwheelinfo') {
        return api_invited_wheel_info_payload();
    }
    if ($e === 'activity/spininvitedwheel') {
        return api_wheel_spin_payload('invited');
    }
    if ($e === 'activity/getpageListinvitedwheelwithdrawrecord' || $e === 'activity/getpagelistinvitedwheelwithdrawrecord') {
        return api_wheel_record_page('invited', $input);
    }
    if ($e === 'activity/sumitinvitedwheelwithdraw' || $e === 'activity/submitinvitedwheelwithdraw') {
        return api_success(true);
    }
    if ($e === 'activity/getuserrechargewheelinfo') {
        return api_recharge_wheel_info_payload();
    }
    if ($e === 'activity/spinrechargewheel') {
        return api_wheel_spin_payload('recharge');
    }
    if ($e === 'activity/getpagelistrechargewheelspinrecord' || $e === 'activity/getpagelistrechargewheelrewardrecord') {
        return api_wheel_record_page('recharge', $input);
    }
    if ($e === 'activity/getlistrechargewheelrewardhistory') {
        return api_success(api_wheel_records('recharge', 100));
    }
    if ($e === 'agentrebate/getpromotiondata') {
        return api_agent_promotion_payload();
    }
    if ($e === 'agentrebate/getrebatelevelratelist') {
        return api_agent_rebate_rates_payload();
    }
    if (strpos($e, 'agentrebate/getpagelist') === 0 || $e === 'agentrebate/getcommissiondetail') {
        return api_success(api_empty_page($input));
    }
    if ($e === 'user/getuserfinanciallist') {
        return api_user_financial_payload($input);
    }
    if ($e === 'user/getuserorderlist' || $e === 'user/getusergamereportlist') {
        return api_lottery_record_page($input);
    }
    if ($e === 'recharge/getrechargebasicinfo') {
        return api_recharge_basic_info_payload();
    }
    if ($e === 'recharge/getrechargecategorylist') {
        return api_recharge_category_payload();
    }
    if (in_array($e, [
        'recharge/rechargetopay',
        'recharge/depositrecharge',
        'recharge/goodsdepositrecharge',
        'activity/rechargegiftopay',
        'activity/rechargegifttopay',
        'activity/rechargecardplantopay',
    ], true)) {
        return api_recharge_to_pay_payload($input);
    }
    if ($e === 'recharge/getlocalrechargeorderdetail') {
        return api_recharge_order_detail_payload($input);
    }
    if ($e === 'recharge/submitcertificate') {
        return api_recharge_submit_certificate_payload($input);
    }
    if ($e === 'recharge/cancellocalrecharge') {
        return api_recharge_cancel_payload($input);
    }
    if ($e === 'recharge/getrechargerecord' || $e === 'recharge/getrechargerecordpage') {
        return api_recharge_record_payload($input);
    }
    if ($e === 'withdraw/getwithdrawbasicinfo') {
        return api_withdraw_basic_info_payload();
    }
    if ($e === 'withdraw/getwithdrawhistory' || $e === 'withdraw/getwithdrawrecordpage') {
        return api_withdraw_history_payload($input);
    }
    if ($e === 'withdraw/sumitwithdraw' || $e === 'withdraw/submitwithdraw' || $e === 'withdraw/addwithdraworder') {
        return api_withdraw_submit_payload($input);
    }
    return null;
}

function api_fallback_response(string $endpoint, array $input): array
{
    $endpoint = api_normalize_endpoint($endpoint);
    $base = strtolower(basename($endpoint));

    if (preg_match('/(add|submit|sumit|receive|received|claim|update|delete|bind|set|mark|transfer|recover|spin|report|oneclick|use|stop|forget|send)/i', $base)) {
        return api_success(true);
    }
    if (preg_match('/(pagelist|recordpage|history|records|record|orderlist|financiallist|messagelist|inmaillist|couponlist|rewardlist|sublist|rankhistory)/i', $base)) {
        return api_success(api_empty_page($input));
    }
    if (preg_match('/^get.*list$/i', $base) || preg_match('/list$/i', $base)) {
        return api_success([]);
    }
    if (preg_match('/(basic|info|config|detail|rule|protocol|material|popup|message|captcha|rank)$/i', $base)) {
        return api_success(new stdClass());
    }
    return api_success(null);
}

function admin_has_permission(string $permissionKey): bool
{
    if (session_status() === PHP_SESSION_NONE) {
        @session_start();
    }
    $adminId = $_SESSION['admin_id'] ?? null;
    if (!$adminId) {
        return false;
    }
    $pdo = api_pdo();
    if (!$pdo) {
        return false;
    }
    try {
        $stmt = $pdo->prepare("SELECT id, role_id, status FROM admin_users WHERE id = ? LIMIT 1");
        $stmt->execute([$adminId]);
        $admin = $stmt->fetch();
        if (!$admin || (int)$admin['status'] !== 1) {
            return false;
        }
        $roleId = (int)$admin['role_id'];
        if ($roleId === 1) {
            return true;
        }

        // Check custom user-level permissions first
        try {
            $stmt = $pdo->prepare("
                SELECT COUNT(*) 
                FROM admin_user_permissions aup
                JOIN admin_permissions ap ON ap.id = aup.permission_id
                WHERE aup.admin_id = ? AND ap.permission_key = ?
            ");
            $stmt->execute([$adminId, $permissionKey]);
            if ((int)$stmt->fetchColumn() > 0) {
                return true;
            }
        } catch (Throwable $e) {}

        // Fallback to role_permissions
        try {
            $stmt = $pdo->prepare("
                SELECT COUNT(*) 
                FROM role_permissions rp
                JOIN admin_permissions ap ON ap.id = rp.permission_id
                WHERE rp.role_id = ? AND ap.permission_key = ?
            ");
            $stmt->execute([$roleId, $permissionKey]);
            return (int)$stmt->fetchColumn() > 0;
        } catch (Throwable $e) {}

        return false;
    } catch (Throwable $e) {
        return false;
    }
}

function admin_get_logged_in_user(): ?array
{
    if (session_status() === PHP_SESSION_NONE) {
        @session_start();
    }
    $adminId = $_SESSION['admin_id'] ?? null;
    if (!$adminId) {
        return null;
    }
    $pdo = api_pdo();
    if (!$pdo) {
        return null;
    }
    try {
        $stmt = $pdo->prepare("
            SELECT u.*, r.role_name, r.role_label 
            FROM admin_users u
            LEFT JOIN admin_roles r ON r.id = u.role_id
            WHERE u.id = ? LIMIT 1
        ");
        $stmt->execute([$adminId]);
        $user = $stmt->fetch();
        return $user ?: null;
    } catch (Throwable $e) {
        return null;
    }
}

