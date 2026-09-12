<?php
/**
 * DhaniWin — Balance Repair (browser tool, no terminal needed)
 * -------------------------------------------------------------
 * Open in browser:   https://YOUR-DOMAIN/admin/balance-fix.php
 * Login with the SAME admin panel account (or the admin username/password from
 * api/config.php / DHANI_ADMIN_USER + DHANI_ADMIN_PASS).
 *
 * It shows why the Wingo game balance was blank/0 and can switch off the stale
 * snapshot overrides directly from the browser. Also works from SSH/CLI:
 *   php admin/balance-fix.php
 */

require_once __DIR__ . '/../api/_bootstrap.php';

$isCli = PHP_SAPI === 'cli';
if (!$isCli) {
    if (session_status() === PHP_SESSION_NONE) {
        @session_start();
    }
    if (is_file(__DIR__ . '/controllers/AuthController.php')) {
        require_once __DIR__ . '/controllers/AuthController.php';
    }
}

function bfix_admin_object(): array
{
    $cfg = (array) api_config();
    $admin = $cfg['admin'] ?? [];
    return [
        (string) ($admin['username'] ?? 'admin'),
        (string) ($admin['password'] ?? ''),
    ];
}

function bfix_is_authed(): bool
{
    if ($GLOBALS['bfix_cli'] ?? false) {
        return true;
    }
    if (!empty($_SESSION['admin_logged_in'])) {
        return true;
    }
    if (class_exists('AuthController') && method_exists('AuthController', 'checkRememberMe')) {
        try {
            return (bool) AuthController::checkRememberMe();
        } catch (Throwable $e) {
            return false;
        }
    }
    return false;
}

$GLOBALS['bfix_cli'] = $isCli;

/** Endpoints that must never be answered from a static snapshot/override. */
function bfix_money_endpoints(): array
{
    return [
        'Lottery/GetBalance',
        'Lottery/GetUserInfo',
        'Lottery/GetRecordPage',
        'Lottery/GetMyEmerdList',
        'Lottery/GetWinLossResult',
        'ThirdGame/GetARGameBalance',
        'ThirdGame/GetARGameAndPlatWallets',
        'ThirdGame/RecoverSaasBalance',
        'ThirdGame/Transfer',
        'ThirdGame/NotifyARGameRecover',
        'User/GetUserInfo',
        'User/GetUserFinancialList',
        'Recharge/GetRechargeBasicInfo',
        'Withdraw/GetWithdrawBasicInfo',
        'Home/Login',
        'Home/Register',
        'Home/RefreshToken',
    ];
}

function bfix_override_rows(PDO $pdo): array
{
    $list = bfix_money_endpoints();
    $in = implode(',', array_fill(0, count($list), '?'));
    try {
        $stmt = $pdo->prepare("SELECT id, endpoint, enabled, updated_at, length(content) AS size FROM api_responses WHERE endpoint IN ($in) ORDER BY enabled DESC, endpoint");
        $stmt->execute($list);
        return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    } catch (Throwable $e) {
        return [];
    }
}

function bfix_repair(PDO $pdo): array
{
    $list = bfix_money_endpoints();
    $in = implode(',', array_fill(0, count($list), '?'));
    $report = ['db_rows' => 0, 'json_rows' => 0, 'notes' => []];
    try {
        $stmt = $pdo->prepare("UPDATE api_responses SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE endpoint IN ($in) AND enabled = 1");
        $stmt->execute($list);
        $report['db_rows'] = $stmt->rowCount();
    } catch (Throwable $e) {
        $report['notes'][] = 'api_responses update failed: ' . $e->getMessage();
    }

    $file = api_storage_dir() . '/api_overrides.json';
    if (is_file($file)) {
        $decoded = api_json_decode_lenient((string) file_get_contents($file));
        $rows = $decoded['ok'] && is_array($decoded['data']) ? $decoded['data'] : [];
        $changed = false;
        foreach (array_keys($rows) as $key) {
            if (api_is_live_money_endpoint((string) $key)) {
                $rows[$key]['enabled'] = 0;
                $changed = true;
                $report['json_rows']++;
            }
        }
        if ($changed) {
            @file_put_contents($file, json_encode($rows, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        }
    }
    return $report;
}

function bfix_members(PDO $pdo, int $limit = 15): array
{
    try {
        $stmt = $pdo->prepare(
            "SELECT id, user_id, username, nickname, wallet_balance, game_balance, can_bet,
                    CASE WHEN token IS NULL OR token = '' THEN 0 ELSE 1 END AS has_token, token_expire, updated_at
             FROM api_users ORDER BY id DESC LIMIT " . max(1, $limit)
        );
        $stmt->execute();
        return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    } catch (Throwable $e) {
        return [];
    }
}

function bfix_live_answers(): array
{
    $out = [];
    $pairs = [
        'Lottery/GetBalance' => ['lottery', 'Lottery/GetBalance'],
        'Lottery/GetUserInfo' => ['lottery', 'Lottery/GetUserInfo'],
        'ThirdGame/GetARGameBalance' => ['plain', 'ThirdGame/GetARGameBalance'],
        'ThirdGame/GetARGameAndPlatWallets' => ['plain', 'ThirdGame/GetARGameAndPlatWallets'],
    ];
    foreach ($pairs as $label => [$kind, $endpoint]) {
        try {
            if ($kind === 'lottery') {
                $payload = api_lottery_dynamic($endpoint, []);
            } else {
                $payload = api_explicit_dynamic_response($endpoint, []);
            }
            $out[$label] = $payload;
        } catch (Throwable $e) {
            $out[$label] = ['error' => $e->getMessage()];
        }
    }
    return $out;
}

function bfix_e($value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

/* ------------------------------------------------------------------ auth flow */
$notice = '';
if (!$isCli && !bfix_is_authed()) {
    $postedUser = trim((string) ($_POST['username'] ?? ''));
    $postedPass = (string) ($_POST['password'] ?? '');
    if ($postedUser !== '' || $postedPass !== '') {
        $done = false;
        if (class_exists('AuthController')) {
            try {
                $res = AuthController::login($postedUser, $postedPass, false);
                $done = !empty($res['success']);
                if (!$done) {
                    $notice = isset($res['message']) ? (string) $res['message'] : 'Login failed';
                }
            } catch (Throwable $e) {
                $notice = 'Admin table unavailable: ' . $e->getMessage();
            }
        }
        if (!$done) {
            [$cfgUser, $cfgPass] = bfix_admin_object();
            if ($cfgPass !== '' && hash_equals($cfgUser, $postedUser) && hash_equals($cfgPass, $postedPass)) {
                $_SESSION['admin_logged_in'] = true;
                $done = true;
            } elseif ($notice === '') {
                $notice = 'Wrong username or password';
            }
        }
    }
}

$authed = $isCli || bfix_is_authed();

/* ------------------------------------------------------------------ game entry */
function bfix_member_by_username(PDO $pdo, string $username): ?array
{
    try {
        $stmt = $pdo->prepare("SELECT * FROM api_users WHERE username = ? OR phone = ? OR nickname = ? LIMIT 1");
        $stmt->execute([$username, $username, $username]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    } catch (Throwable $e) {
        return null;
    }
}

/**
 * The game (lottery SDK) only ever stores the token it receives either from
 * ?Token= in the game-entry URL or from an `Authorization` response header.
 * This shows exactly what a member would be handed.
 */
function bfix_game_entry_report(PDO $pdo, string $username): array
{
    $out = ['queried' => $username, 'found' => false];
    $member = $username === '' ? null : bfix_member_by_username($pdo, $username);
    if (!$member && $username === '') {
        $member = bfix_members($pdo, 1)[0] ?? null;
    }
    if (!$member) {
        return $out;
    }
    $token = (string) ($member['token'] ?? '');
    $origin = api_request_origin();
    $out['found'] = true;
    $out['username'] = (string) $member['username'];
    $out['user_id'] = (int) $member['user_id'];
    $out['game_balance'] = (float) $member['game_balance'];
    $out['wallet_balance'] = (float) $member['wallet_balance'];
    $out['token_state'] = $token === '' ? 'MISSING' : ('ok (' . substr($token, 0, 10) . '...)');
    $out['game_url'] = $token === '' ? '' : $origin . '/?Token=' . $token . '&gameCode=WinGo_1M&vendorCode=ARLottery';
    $out['api_balance_for_that_token'] = null;
    if ($token !== '') {
        // answer as that member would, without touching the real request
        $stmt = $pdo->prepare("SELECT game_balance, wallet_balance FROM api_users WHERE token = ? LIMIT 1");
        $stmt->execute([$token]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $out['api_balance_for_that_token'] = $row ? (float) $row['game_balance'] : 'token matches no row';
    }
    return $out;
}

/* --------------------------------------------------------------------- actions */
$pdo = api_pdo();
$repairReport = null;
if ($authed && $pdo && strtolower((string) ($_POST['action'] ?? '')) === 'set') {
    $key = (string) ($_POST['key'] ?? '');
    $val = (string) ($_POST['value'] ?? '');
    $allowed = ['wingo_bet_time_offset_seconds' => ['-60', '-300', '0', '60'], 'wingo_balance_mode' => ['game', 'total'], 'wingo_auto_transfer' => ['0', '1'], 'balance_debug' => ['0', '1'], 'wingo_instant_settle' => ['0', '1'], 'settlement_mode' => ['auto', 'auto_hedge', 'force_win', 'force_loss']];
    if (isset($allowed[$key]) && in_array($val, $allowed[$key], true)) {
        $ok = api_set_setting($key, $val);
        $notice = $ok ? 'Saved: ' . $key . ' = ' . $val : 'Could not save ' . $key . ' (api_settings not writable?)';
    } else {
        $notice = 'Unknown setting';
    }
}

if ($authed && $pdo && strtolower((string) ($_POST['action'] ?? '')) === 'repair') {
    $repairReport = bfix_repair($pdo);
    $notice = sprintf(
        'Done — %d snapshot override(s) switched off%s.',
        $repairReport['db_rows'],
        $repairReport['json_rows'] ? ' and ' . $repairReport['json_rows'] . ' in api_overrides.json' : ''
    );
}

$wantJson = isset($_GET['format']) && strtolower((string) $_GET['format']) === 'json';

if ($pdo === null) {
    if ($wantJson) {
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'error' => 'database not reachable', 'detail' => $GLOBALS['db_connection_error'] ?? '']);
        exit;
    }
    echo '<meta charset="utf-8"><div style="font:14px/1.6 system-ui;margin:40px;padding:18px;border:1px solid #d33;color:#a11;border-radius:10px">
        Database is not reachable. Check <code>api/config.php</code> or the DHANI_DB_* env values. '
        . bfix_e($GLOBALS['db_connection_error'] ?? '') . '</div>';
    exit;
}

$rows = bfix_override_rows($pdo);
$members = bfix_members($pdo, $isCli ? 8 : 25);
$answers = $authed ? bfix_live_answers() : [];
$staleCount = 0;
foreach ($rows as $row) {
    if ((int) $row['enabled'] === 1) {
        $staleCount++;
    }
}

/* ------------------------------------------------------------------------ JSON */
if ($wantJson) {
    header('Content-Type: application/json; charset=utf-8');
    if (!$authed) {
        echo json_encode(['ok' => false, 'error' => 'unauthorized', 'hint' => 'login at /admin first, or pass admin username/password']);
        exit;
    }
    echo json_encode([
        'ok' => true,
        'db_driver' => api_db_driver($pdo),
        'frozen_overrides_on_money_endpoints' => $staleCount,
        'overrides' => $rows,
        'members' => $members,
        'live_api_answers' => $answers,
        'repair_report' => $repairReport,
    ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}

/* ------------------------------------------------------------------------- CLI */
if ($isCli) {
    echo "DhaniWin balance repair (CLI)\n";
    echo "DB driver: " . api_db_driver($pdo) . "\n";
    echo "Frozen overrides on money endpoints: " . $staleCount . "\n";
    foreach ($rows as $row) {
        echo sprintf("  %-40s %s\n", $row['endpoint'], (int) $row['enabled'] === 1 ? 'ENABLED' : 'disabled');
    }
    foreach ($answers as $label => $payload) {
        echo $label . ' -> ' . json_encode($payload['data'] ?? $payload, JSON_UNESCAPED_SLASHES) . "\n";
    }
    echo "\nRun with --repair to switch the overrides off.\n";
    if (in_array('--repair', $argv, true)) {
        $repairReport = bfix_repair($pdo);
        echo 'Repaired: ' . $repairReport['db_rows'] . " override row(s) disabled\n";
    }
    exit(0);
}

/* --------------------------------------------------------------------- HTML UI */
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>DhaniWin · Balance Repair</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px 60px; background:#0b1220; color:#e8eefc;
         font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 26px 0 10px; }
  .sub { color:#93a4c4; font-size:13px; margin-bottom:18px; }
  .card { background:#121c31; border:1px solid #22314f; border-radius:12px; padding:14px 16px; margin-bottom:14px; }
  .ok { color:#5be49b; } .warn { color:#ffcf5c; } .bad { color:#ff7b7b; }
  table { width:100%; border-collapse: collapse; font-size:13px; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid #1e2c49; }
  th { color:#93a4c4; font-weight:600; }
  code, pre { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre { background:#0a1120; border:1px solid #1e2c49; border-radius:10px; padding:12px; overflow:auto; font-size:12px; }
  a.button, button { display:inline-block; background:linear-gradient(180deg,#3b82f6,#2563eb); color:#fff; border:0;
        padding:10px 16px; border-radius:10px; font-size:14px; font-weight:600; cursor:pointer; text-decoration:none; }
  .ghost { background:#1b2740; border:1px solid #2b3c5f; color:#cfe0ff; font-weight:500; }
  input { background:#0a1120; border:1px solid #2b3c5f; color:#e8eefc; padding:10px 12px; border-radius:9px; width:100%; margin-bottom:10px; }
  .note { font-size:12px; color:#93a4c4; }
  .banner { border-left:3px solid #5be49b; padding-left:12px; }
</style>
</head>
<body>
<div class="wrap">

<?php if (!$authed): ?>
  <h1>DhaniWin · Balance Repair</h1>
  <div class="sub">Admin panel login required (same username/password you use at <code>/admin</code>).</div>
  <div class="card" style="max-width:380px">
    <?php if ($notice !== ''): ?><div class="bad" style="margin-bottom:10px"><?= bfix_e($notice) ?></div><?php endif; ?>
    <form method="post" action="">
      <input name="username" placeholder="Admin username" autocomplete="username" value="<?= bfix_e($_POST['username'] ?? '') ?>">
      <input name="password" type="password" placeholder="Admin password" autocomplete="current-password">
      <button type="submit">Open tool</button>
    </form>
  </div>
</div>
</body>
</html>
<?php
    exit;
endif; ?>
<h1>DhaniWin · Wingo Balance Repair</h1>
<div class="sub">
  DB: <code><?= bfix_e(api_db_driver($pdo)) ?></code>
  &nbsp;·&nbsp; Money endpoints frozen by snapshots:
  <?php if ($staleCount > 0): ?>
    <span class="bad"><?= (int) $staleCount ?></span>
  <?php else: ?>
    <span class="ok">0</span>
  <?php endif; ?>
  <span class="note">(the patched code already ignores them, this page can also switch them off in the DB)</span>
</div>

<?php if ($notice !== ''): ?>
  <div class="card banner ok"><?= bfix_e($notice) ?></div>
<?php endif; ?>

<h2>1 · One-click repair</h2>
<div class="card">
  <form method="post" action="" style="display:inline" onsubmit="return confirm('Switch off the frozen snapshot overrides for balance/wallet/login endpoints?');">
    <input type="hidden" name="action" value="repair">
    <button type="submit">Turn off frozen balance overrides</button>
  </form>
  &nbsp;<a class="button ghost" href="?format=json" target="_blank">Machine-readable report</a>
  <div class="note" style="margin-top:8px">
    Sirf <code>enabled</code> flag off hota hai — koi balance, user ya order data change nahi hota.
    Wingo game ka balance live DB se aane lagta hai.
  </div>
</div>

<h2>2 · What the app now receives (live, no cache)</h2>
<div class="card">
<?php foreach ($answers as $label => $payload): ?>
  <div style="margin-bottom:12px">
    <code><?= bfix_e($label) ?></code>
    <pre><?= bfix_e(json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) ?></pre>
  </div>
<?php endforeach; ?>
  <div class="note">
    <b>balance</b> = game wallet (Wingo screen me yahhi dikhta hai) · <b>walletBalance</b> = main wallet.
    If <code>balance</code> is 0 but the member has money in <code>walletBalance</code>, the member simply has
    not transferred it to the game wallet yet — or is logged in as another member (see section 3).
  </div>
</div>

<h2>3 · Members (balance + token state)</h2>
<div class="card">
  <table>
    <thead>
      <tr><th>#</th><th>username</th><th>game (Wingo)</th><th>wallet</th><th>can bet</th><th>token</th></tr>
    </thead>
    <tbody>
    <?php if (!$members): ?>
      <tr><td colspan="6" class="note">No members in <code>api_users</code> yet.</td></tr>
    <?php endif; ?>
    <?php foreach ($members as $m):
        $expired = ((int) $m['token_expire'] > 0 && (int) $m['token_expire'] < api_now_ms());
        $hasToken = (int) $m['has_token'] === 1;
    ?>
      <tr>
        <td><?= bfix_e($m['id']) ?></td>
        <td><code><?= bfix_e($m['username']) ?></code><div class="note"><?= bfix_e($m['nickname']) ?></div></td>
        <td>₹<?= number_format((float) $m['game_balance'], 2) ?></td>
        <td>₹<?= number_format((float) $m['wallet_balance'], 2) ?></td>
        <td><?= (int) $m['can_bet'] === 1 ? '<span class="ok">yes</span>' : '<span class="bad">no</span>' ?></td>
        <td>
          <?php if (!$hasToken): ?>
            <span class="bad">missing</span><div class="note">member must log in once (app) so a token is saved</div>
          <?php elseif ($expired): ?>
            <span class="warn">expired</span><div class="note">re-login fixes it</div>
          <?php else: ?>
            <span class="ok">ok</span>
          <?php endif; ?>
        </td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
</div>

<h2>4 · Snapshot overrides touching money/login endpoints</h2>
<div class="card">
  <?php if (!$rows): ?>
    <div class="ok">None — nothing is shadowing the live balance handlers.</div>
  <?php else: ?>
    <table>
      <thead><tr><th>endpoint</th><th>state</th><th>size</th><th>updated</th></tr></thead>
      <tbody>
      <?php foreach ($rows as $row): ?>
        <tr>
          <td><code><?= bfix_e($row['endpoint']) ?></code></td>
          <td><?= (int) $row['enabled'] === 1 ? '<span class="bad">ENABLED (frozen JSON)</span>' : '<span class="ok">disabled</span>' ?></td>
          <td><?= (int) $row['size'] ?> B</td>
          <td><?= bfix_e($row['updated_at']) ?></td>
        </tr>
      <?php endforeach; ?>
      </tbody>
    </table>
    <div class="note" style="margin-top:8px">
      Even while ENABLED, the patched <code>api/_bootstrap.php</code> refuses to serve these endpoints from overrides.
      Switching them off here keeps the admin panel honest too.
    </div>
  <?php endif; ?>
</div>

<h2>5 · Game entry token (bahar vs andar balance ka asli karan)</h2>
<div class="card">
  <form method="get" action="" style="display:flex;gap:8px;align-items:center;max-width:520px">
    <input style="margin:0;flex:1" name="member" placeholder="member username / phone (optional)" value="<?= bfix_e($_GET['member'] ?? '') ?>">
    <button type="submit" class="" style="background:#1b2740;border:1px solid #2b3c5f;color:#cfe0ff;font-weight:500">Check game entry</button>
  </form>
<?php
$gameReport = bfix_game_entry_report($pdo, trim((string) ($_GET['member'] ?? '')));
if (!$gameReport['found']): ?>
  <div class="note" style="margin-top:10px">Member not found.</div>
<?php else: ?>
  <table style="margin-top:12px">
    <tr><th>member</th><td><code><?= bfix_e($gameReport['username']) ?></code> · userId <?= (int) $gameReport['user_id'] ?></td></tr>
    <tr><th>game wallet (Wingo screen)</th><td>₹<?= number_format($gameReport['game_balance'], 2) ?></td></tr>
    <tr><th>main wallet (app header)</th><td>₹<?= number_format($gameReport['wallet_balance'], 2) ?></td></tr>
    <tr><th>token in DB</th><td>
      <?php if ($gameReport['token_state'] === 'MISSING'): ?>
        <span class="bad">MISSING</span> — is member ko app me ek baar logout/login karwana zaroori hai
      <?php else: ?>
        <span class="ok"><?= bfix_e($gameReport['token_state']) ?></span>
      <?php endif; ?>
    </td></tr>
    <tr><th>game entry URL</th><td><code style="font-size:11px;word-break:break-all"><?= bfix_e($gameReport['game_url'] ?: '(no token -> GetGameUrl will ask the member to log in)') ?></code></td></tr>
  </table>
  <div class="note" style="margin-top:10px">
    Game ka screen <code>?Token=</code> (ya <code>Authorization</code> response header) se hi member pehchanta hai.
    Pehle ye token template ke purane snapshot URL me embedded tha — isliye game me <b>dusre account</b> ka balance
    (aur app header me member ka) dikh raha tha. Ab <code>ThirdGame/GetGameUrl</code> har baar usi member ka live
    token deta hai, aur <code>lotteryLoginUrl</code> (stale cached URL) server ki taraf se blank kar di jati hai.
  </div>
<?php endif; ?>
</div>

<h2>6 · Game me kaunsa balance dikhe (site setting)</h2>
<div class="card">
  <table>
    <tr>
      <th style="width:46%">Wingo balance source</th>
      <td>
        current: <code><?= bfix_e((string) api_setting('wingo_balance_mode', 'game')) ?></code>
        <div class="note">game wallet = sirf wo paisa jo Wingo me transfer hai (platform ka normal rule).
        total = main wallet + game wallet, yaani app header wala number.</div>
      </td>
      <td style="white-space:nowrap">
        <form method="post" style="display:inline"><input type="hidden" name="action" value="set"><input type="hidden" name="key" value="wingo_balance_mode"><input type="hidden" name="value" value="game">
          <button type="submit" class="ghost">Use game wallet</button></form>
        <form method="post" style="display:inline"><input type="hidden" name="action" value="set"><input type="hidden" name="key" value="wingo_balance_mode"><input type="hidden" name="value" value="total">
          <button type="submit" class="ghost">Show total (wallet + game)</button></form>
      </td>
    </tr>
    <tr>
      <th>Auto-transfer on game entry</th>
      <td>current: <code><?= (string) api_setting('wingo_auto_transfer', '0') === '1' ? 'ON' : 'off' ?></code>
        <div class="note">ON karne se game kholte waqt poora main wallet game wallet me chala jaata hai
        (app ke Transfer button jaisa rule). Default off — paisa user ke bina action ke move na ho isliye.</div></td>
      <td style="white-space:nowrap">
        <form method="post" style="display:inline"><input type="hidden" name="action" value="set"><input type="hidden" name="key" value="wingo_auto_transfer"><input type="hidden" name="value" value="1">
          <button type="submit" class="ghost">Turn ON</button></form>
        <form method="post" style="display:inline"><input type="hidden" name="action" value="set"><input type="hidden" name="key" value="wingo_auto_transfer"><input type="hidden" name="value" value="0">
          <button type="submit" class="ghost">OFF</button></form>
      </td>
    </tr>
    <tr>
      <th>Instant settle (bet lagate hi win/loss)</th>
      <td>current: <code><?= (string) api_setting('wingo_instant_settle', '1') === '1' ? 'ON' : 'off' ?></code>
        <div class="note">ON = issue ka number bet lagte hi draw ho jaata hai aur bet turant settle
        (jeete to payout turant game wallet me). Draw engine wahi hai jo countdown ke end par karta
        tha — yani number same rahega, sirf pehle draw hota hai, aur lottery_results me save hone se
        history/chart/records match karte rehte hain. OFF = normal rule (countdown ke baad settle).</div></td>
      <td style="white-space:nowrap">
        <form method="post" style="display:inline"><input type="hidden" name="action" value="set"><input type="hidden" name="key" value="wingo_instant_settle"><input type="hidden" name="value" value="1">
          <button type="submit" class="ghost">Turn ON</button></form>
        <form method="post" style="display:inline"><input type="hidden" name="action" value="set"><input type="hidden" name="key" value="wingo_instant_settle"><input type="hidden" name="value" value="0">
          <button type="submit" class="ghost">OFF (settle after countdown)</button></form>
      </td>
    </tr>
    <tr>
      <th>Draw rule (settlement_mode)</th>
      <td>current: <code><?= bfix_e((string) api_setting('settlement_mode', 'auto')) ?></code>
        <div class="note">instant settle ke saath bhi yehi rule lagta hai: auto = normal draw,
        auto_hedge = house loss kam karo, force_win / force_loss = sab ko jeetwaao / haaraao
        (test ke liye; production me mat rakhiyega).</div></td>
      <td style="white-space:nowrap">
        <?php foreach (['auto', 'auto_hedge', 'force_win', 'force_loss'] as $mode): ?>
        <form method="post" style="display:inline"><input type="hidden" name="action" value="set"><input type="hidden" name="key" value="settlement_mode"><input type="hidden" name="value" value="<?= bfix_e($mode) ?>">
          <button type="submit" class="ghost"><?= bfix_e($mode) ?></button></form>
        <?php endforeach; ?>
      </td>
    </tr>
    <tr>
      <th>Bet time offset (My history ka time)</th>
      <td>current: <code><?= (int) api_setting('wingo_bet_time_offset_seconds', '-60') ?>s</code>
        <div class="note">Instant settle me bet, issue khatam hone se pehle lagti hai — isliye record ka
        time thoda aage lagta hai. Ye sirf <b>display</b> time khisakata hai (paisa/settle/issue number
        same rehte hain). <code>-60</code> = 1 minute peeche (default), <code>0</code> = asli time.</div></td>
      <td style="white-space:nowrap">
        <?php foreach ([['-60', '-1 min'], ['-300', '-5 min'], ['0', 'real time'], ['60', '+1 min']] as $opt): ?>
        <form method="post" style="display:inline"><input type="hidden" name="action" value="set"><input type="hidden" name="key" value="wingo_bet_time_offset_seconds"><input type="hidden" name="value" value="<?= bfix_e($opt[0]) ?>">
          <button type="submit" class="ghost"><?= bfix_e($opt[1]) ?></button></form>
        <?php endforeach; ?>
      </td>
    </tr>
    <tr>
      <th>Identity debug log</th>
      <td>current: <code><?= (string) api_setting('balance_debug', '0') === '1' ? 'ON' : 'off' ?></code>
        <div class="note">ON karke ek baar game kholo, neeche log me dikhega ki game ke request ke saath
        token aa raha hai ya nahi (auth / cookie / query). Kaam ke baad OFF kar dena.</div></td>
      <td style="white-space:nowrap">
        <form method="post" style="display:inline"><input type="hidden" name="action" value="set"><input type="hidden" name="key" value="balance_debug"><input type="hidden" name="value" value="1">
          <button type="submit" class="ghost">Turn ON</button></form>
        <form method="post" style="display:inline"><input type="hidden" name="action" value="set"><input type="hidden" name="key" value="balance_debug"><input type="hidden" name="value" value="0">
          <button type="submit" class="ghost">OFF</button></form>
      </td>
    </tr>
  </table>
</div>

<?php
$debugFile = api_storage_dir() . '/balance-debug.log';
if (is_file($debugFile)):
    $lines = array_slice(array_filter(explode("\n", (string) file_get_contents($debugFile))), -25);
?>
<h2>7 · Identity log (last <?= count($lines) ?> lines)</h2>
<div class="card"><pre><?= bfix_e(implode("\n", array_reverse($lines))) ?></pre>
  <div class="note">auth=YES matlab request me bearer token aaya. auth=no & cookie=no matlab game
  bina member ke khula — tab balance jaan-boojh ke 0 dikhaya jaata hai (kisi aur ka paisa dikhane se better).</div>
</div>
<?php endif; ?>

<h2>8 · After this, do this in the app</h2>
<div class="card note">
  1. Open the site → hard reload (Ctrl+F5 / on phone: clear the app webview cache once).<br>
  2. Log out and log in again inside the app (this re-saves the member token).<br>
  3. Open WinGo → the balance in the game header comes from <code>/Lottery/GetBalance</code>.<br>
  4. Cloudflare / LiteSpeed cache ON hai to <code>/api/*</code> ka cache purge kar dena.<br>
  5. Ye tool public URL hai — kaam ke baad <code>admin/balance-fix.php</code> delete kar dena (recommended).
</div>

<div class="note" style="margin-top:18px">
  Only these files were patched: <code>api/_bootstrap.php</code>, <code>_bootstrap.php</code>, <code>admin/balance-fix.php</code> (this tool).
  Your database, images and APK files were not touched.
</div>

</div>
</body>
</html>
