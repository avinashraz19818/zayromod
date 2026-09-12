<?php
/**
 * Wingo / APK checker (read-only)
 * -------------------------------
 * Finds out WHY Wingo shows Rs 0.00 inside an APK while the browser is fine.
 * It changes nothing (no money, no settings) - it only reports what the game can
 * see in the exact window it is opened from.
 *
 * Use (no devtools needed):
 *   1) APK builder me link temporarily daalo:  https://YOUR-DOMAIN/admin/wingo-check.php
 *   2) Page khud tests chalata hai aur REPORT deta hai -> screenshot bhejo
 *   3) APK me normal site link wapas daal do. Chahe to ye file delete kar do.
 *
 * Privacy: token masked (first 6 chars), no phone/password/DB output.
 */

require_once __DIR__ . '/../api/_bootstrap.php';

function wck_e($v)
{
    return htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
}

function wck_mask($token)
{
    $token = (string) $token;
    if ($token === '') {
        return '(none)';
    }
    return substr($token, 0, 6) . '...' . strlen($token) . ' chars';
}

$tokenSeen = function_exists('api_request_token') ? api_request_token() : '';

$chan = array();
if ((string) ($_SERVER['HTTP_AUTHORIZATION'] ?? '') !== '') {
    $chan[] = 'Authorization header';
}
foreach (array('Token' => 'query ?Token=', 'token' => 'query ?token=') as $k => $label) {
    if (trim((string) ($_GET[$k] ?? '')) !== '') {
        $chan[] = $label;
    }
}
foreach (array('ar_g_token' => 'cookie ar_g_token', 'dh_tok' => 'cookie dh_tok', 'ar_token' => 'cookie ar_token') as $k => $label) {
    if (trim((string) ($_COOKIE[$k] ?? '')) !== '') {
        $chan[] = $label;
    }
}

$user = array('id' => 0, 'user_id' => 0);
if (function_exists('api_primary_user')) {
    $u = api_primary_user();
    if (is_array($u)) {
        $user = $u + $user;
    }
}
$bal = array('game' => 0.0, 'wallet' => 0.0);
if (!empty($user['id']) && function_exists('api_user_balances')) {
    $b = api_user_balances($user);
    if (is_array($b)) {
        $bal = $b + $bal;
    }
}
$shown = function_exists('api_wingo_shown_balance') ? api_wingo_shown_balance($bal) : $bal['game'];

$host = (string) ($_SERVER['HTTP_HOST'] ?? '');
$canon = function_exists('api_setting') ? (string) api_setting('site_url', '') : '';
if ($canon === '' && function_exists('api_request_origin')) {
    $canon = api_request_origin();
}
$canonHost = (string) (parse_url($canon, PHP_URL_HOST) ?: '');
$share = function_exists('api_setting') ? (string) api_setting('share_domain', '') : '';

$docRoot = (string) realpath(dirname(__DIR__));
$idx = $docRoot . '/index.html';
$idxHtml = is_file($idx) ? (string) file_get_contents($idx) : '';
$idxHasHandoff = strpos($idxHtml, '__DH_HANDOFF__') !== false;
$idxMtime = is_file($idx) ? date('Y-m-d H:i', (int) filemtime($idx)) : 'missing';
$hasJs = is_file($docRoot . '/dh-handoff.js');
$idxPhp = $docRoot . '/index.php';
$hasIndexPhp = is_file($idxPhp) && strpos((string) file_get_contents($idxPhp), 'X-Dhaniwin-Handoff') !== false;
$swFile = $docRoot . '/ar-sw.js';
$swPatched = is_file($swFile) && strpos((string) file_get_contents($swFile), 'round 7') !== false;

$settings = array(
    'wingo_balance_mode' => function_exists('api_setting') ? api_setting('wingo_balance_mode', 'game') : '?',
    'wingo_webview_handoff' => function_exists('api_wingo_webview_handoff') ? (api_wingo_webview_handoff() ? '1 (on)' : '0 (off)') : '?',
    'wingo_instant_settle' => function_exists('api_lottery_instant_settle') ? (api_lottery_instant_settle() ? '1 (on)' : '0 (off)') : '?',
    'wingo_bet_time_offset_seconds' => function_exists('api_setting') ? api_setting('wingo_bet_time_offset_seconds', '-60') : '?',
    'balance_debug' => function_exists('api_setting') ? api_setting('balance_debug', '0') : '?',
);
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wingo / APK checker</title>
<style>
  body { margin: 0; padding: 14px; background: #0d1020; color: #eef1ff; font: 15px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 19px; margin: 4px 0 10px; }
  h2 { font-size: 13px; margin: 16px 0 4px; color: #9fb2ff; text-transform: uppercase; letter-spacing: .06em; }
  .row { display: flex; gap: 10px; justify-content: space-between; border-bottom: 1px solid #1e2340; padding: 6px 0; }
  .row b { font-weight: 600; color: #c8d2ff; flex: 0 0 44%; }
  .row span { text-align: right; word-break: break-all; }
  .good { color: #35d07f; } .bad { color: #ff6b81; } .warn { color: #ffc94d; }
  pre { background: #070a17; border: 1px solid #23284a; border-radius: 10px; padding: 10px; white-space: pre-wrap; word-break: break-all; font-size: 11px; }
  .verdict { border: 1px solid #ffc94d; border-radius: 10px; padding: 10px 12px; margin: 14px 0; }
  .verdict li { margin: 6px 0; }
  a.btn, button.btn { display: inline-block; margin: 6px 8px 0 0; padding: 10px 14px; border-radius: 999px; border: 0; background: #3a5cff; color: #fff; font-weight: 700; text-decoration: none; }
  .muted { color: #8b93b8; font-size: 12px; }
</style>
</head>
<body>
<h1>Wingo / APK checker <span class="muted">v7 - read only</span></h1>
<div class="muted">Ye page sirf batata hai game ko is window me kya dikh raha hai. Kuch badalta nahi hai.</div>

<h2>1. Document / origin</h2>
<div class="row"><b>This host</b><span><?= wck_e($host ?: '(cli)') ?></span></div>
<div class="row"><b>Site canonical host</b><span class="<?= ($canonHost !== '' && $host !== '' && strpos($host, $canonHost) === false) ? 'bad' : 'good' ?>"><?= wck_e($canonHost !== '' ? $canonHost : '(setting nahi)') ?><?= $share !== '' ? ' | share_domain: ' . wck_e($share) : '' ?></span></div>
<div class="row"><b>Opened inside iframe/shell?</b><span id="fr">checking...</span></div>
<div class="row"><b>Sec-Fetch-Dest / Site</b><span><?= wck_e(($_SERVER['HTTP_SEC_FETCH_DEST'] ?? '-') . ' / ' . ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '-')) ?></span></div>
<div class="row"><b>Referer</b><span><?= wck_e($_SERVER['HTTP_REFERER'] ?? '(none)') ?></span></div>

<h2>2. Deployed files (is doc-root par)</h2>
<div class="row"><b>index.html handoff block</b><span class="<?= $idxHasHandoff ? 'good' : 'bad' ?>"><?= $idxHasHandoff ? 'YES (v6+ inline)' : 'NO - purana build' ?></span></div>
<div class="row"><b>index.html modified</b><span><?= wck_e($idxMtime) ?></span></div>
<div class="row"><b>dh-handoff.js present</b><span class="<?= $hasJs ? 'good' : 'warn' ?>"><?= $hasJs ? 'YES' : 'NO (inject nahi hoga)' ?></span></div>
<div class="row"><b>index.php injects it</b><span class="<?= $hasIndexPhp ? 'good' : 'warn' ?>"><?= $hasIndexPhp ? 'YES' : 'NO (zip ka index.php bhi daalo)' ?></span></div>
<div class="row"><b>ar-sw.js patched</b><span class="<?= $swPatched ? 'good' : 'warn' ?>"><?= $swPatched ? 'YES' : 'NO - SW purana shell de sakta hai' ?></span></div>
<div class="row"><b>Handoff mode (this load)</b><span id="mode">checking...</span></div>

<h2>3. Token jo game bhej raha hai</h2>
<div class="row"><b>Token seen by server</b><span class="<?= $tokenSeen !== '' ? 'good' : 'bad' ?>"><?= wck_e(wck_mask($tokenSeen)) ?></span></div>
<div class="row"><b>Kahan se aaya</b><span><?php if ($chan) { echo wck_e(implode(', ', $chan)); } else { echo '<span class="bad">kuch nahi (header/query/cookie sab khali)</span>'; } ?></span></div>
<div class="row"><b>Member resolved</b><span class="<?= !empty($user['id']) ? 'good' : 'bad' ?>">id <?= wck_e(!empty($user['id']) ? $user['id'] : '0 (anonymous)') ?><?= !empty($user['user_id']) ? ' / ' . wck_e($user['user_id']) : '' ?></span></div>
<div class="row"><b>Balance (game / wallet)</b><span>Rs <?= wck_e(number_format((float) $bal['game'], 2)) ?> / Rs <?= wck_e(number_format((float) $bal['wallet'], 2)) ?></span></div>
<div class="row"><b>Game card ko dikhega</b><span class="good">Rs <?= wck_e(number_format((float) $shown, 2)) ?></span></div>

<h2>4. Settings</h2>
<?php foreach ($settings as $k => $v): ?>
<div class="row"><b><?= wck_e($k) ?></b><span><?= wck_e($v) ?></span></div>
<?php endforeach; ?>

<h2>5. WebView checks (is window me)</h2>
<div id="jschecks"><div class="row"><b>running...</b><span>-</span></div></div>

<h2>6. Live game API test</h2>
<div id="apitest" class="muted">chalu ho raha hai...</div>

<div class="verdict"><b>NEXT STEP</b><ul id="verdict"><li>checks complete ho rahe hain...</li></ul></div>

<h2>7. REPORT (screenshot ya copy karke bhejein)</h2>
<textarea id="report" readonly style="width:99%;height:200px;background:#070a17;color:#c8d2ff;border:1px solid #23284a;border-radius:10px;padding:10px;font-size:11px"></textarea>
<a class="btn" href="/Wingo">Wingo kholo (same window)</a>
<a class="btn" href="/">Home</a>
<button class="btn" id="copy">Copy report</button>
<div class="muted" style="margin-top:10px">Tip: APK me link badal kar ye page kholna hi sabse accurate test hai, kyunki wahi WebView environment check hota hai.</div>

<script>
(function () {
  var rep = [];
  function esc(s) { return String(s).replace(/[<>&]/g, ''); }
  function line(k, v, s) { rep.push(k + ': ' + String(v).replace(/<[^>]*>/g, '')); return '<div class="row"><b>' + k + '</b><span class="' + (s || '') + '">' + v + '</span></div>'; }
  var html = '';
  var hand = null;
  try { hand = window.__DH_HANDOFF__ || null; } catch (e) {}

  html += line('handoff script', hand ? ('loaded (v' + hand.v + '), tokenFound=' + hand.tok)
      : 'ABSENT - index.html/index.php update is WebView tak nahi pahuncha', hand ? (hand.tok ? 'good' : 'warn') : 'bad');

  try {
    localStorage.setItem('dh_probe', '1');
    var ok = localStorage.getItem('dh_probe') === '1';
    localStorage.removeItem('dh_probe');
    html += line('localStorage', ok ? 'works' : 'reads back empty', ok ? 'good' : 'bad');
  } catch (e) { html += line('localStorage', 'THROWS - ' + esc(e.message), 'bad'); }
  try {
    sessionStorage.setItem('dh_probe', '1');
    html += line('sessionStorage', 'works', 'good');
  } catch (e) { html += line('sessionStorage', 'THROWS - ' + esc(e.message), 'warn'); }
  try {
    document.cookie = 'dh_probe=1; path=/; SameSite=Lax';
    var cok = document.cookie.indexOf('dh_probe=1') !== -1;
    html += line('cookies', cok ? 'allowed in this WebView' : 'BLOCKED (WebView cookie setting off)', cok ? 'good' : 'bad');
  } catch (e) { html += line('cookies', 'THROWS - ' + esc(e.message), 'bad'); }

  var g = '';
  try {
    var raw = localStorage.getItem('ar_g_token');
    if (raw) { try { g = JSON.parse(raw).value || ''; } catch (e2) { g = raw; } }
  } catch (e) {}
  var a = '';
  try { a = localStorage.getItem('ar_token') || ''; } catch (e) {}
  html += line('ar_g_token (game token)', g ? 'present (' + esc(String(g).slice(0, 6)) + '...)' : 'EMPTY', g ? 'good' : 'bad');
  html += line('ar_token (app login)', a ? 'present - app logged in here' : 'EMPTY - is window me app logged in nahi', a ? 'good' : 'bad');
  var framed = false;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  html += line('iframe / SW shell', framed ? 'YES - page iframe me khul raha hai' : 'no (top window)', framed ? 'bad' : 'good');
  document.getElementById('fr').innerHTML = framed ? '<span class="bad">YES - iframe/shell</span>' : '<span class="good">no, top window</span>';
  document.getElementById('jschecks').innerHTML = html;

  fetch('/', { cache: 'no-store' }).then(function (r) {
    var m = r.headers.get('X-Dhaniwin-Handoff') || 'none (index.html directly served)';
    document.getElementById('mode').innerHTML = '<span class="' + (m.indexOf('inline') === 0 || m.indexOf('injected') === 0 ? 'good' : 'bad') + '">' + esc(m) + '</span>';
    rep.push('X-Dhaniwin-Handoff: ' + m);
  }).catch(function (e) { document.getElementById('mode').textContent = 'fetch failed: ' + e.message; });

  function call(path, tok) {
    var h = { 'Content-Type': 'application/json' };
    if (tok) { h.Authorization = 'Bearer ' + tok; }
    return fetch(path, { method: 'POST', headers: h, body: '{}' })
      .then(function (r) { return r.text().then(function (t) { return { status: r.status, body: t }; }); })
      .catch(function (e) { return { status: 'ERR', body: String(e) }; });
  }
  function parse(o) {
    try {
      var j = JSON.parse(o.body);
      var d = j.data || {};
      var b = (d.balance !== undefined) ? d.balance : d.amount;
      return 'code=' + j.code + ' balance=' + b + ' wallet=' + d.walletBalance;
    } catch (e) { return o.status + ' ' + String(o.body).slice(0, 110); }
  }
  Promise.all([
    call('/api/Lottery/GetBalance', g || ''),
    call('/api/Lottery/GetBalance?Token=' + encodeURIComponent(a || g || ''), '')
  ]).then(function (res) {
    var out = '';
    out += '<div class="row"><b>ar_g_token se (game jaisa)</b><span>' + esc(parse(res[0])) + '</span></div>';
    out += '<div class="row"><b>app ke ar_token se (?Token=)</b><span>' + esc(parse(res[1])) + '</span></div>';
    out += '<pre>raw: ' + esc(String(res[0].body).slice(0, 380)) + '</pre>';
    document.getElementById('apitest').innerHTML = out;
    rep.push('API via ar_g_token -> ' + parse(res[0]));
    rep.push('API via app token   -> ' + parse(res[1]));
    finish(res);
  });

  function finish(res) {
    function balOf(o) { try { var j = JSON.parse(o.body); return (j.data.balance !== undefined) ? j.data.balance : j.data.amount; } catch (e) { return null; } }
    var viaG = balOf(res[0]), viaA = balOf(res[1]);
    var v = [];
    if (!hand) {
      v.push('<b>Update APK tak nahi pahuncha.</b> public_html me index.html, index.php, dh-handoff.js, ar-sw.js extract karo (Overwrite ON), app ko force-stop karke dobara kholo.');
    } else if (hand.tok === 0) {
      v.push('Handoff chala par is window me koi token nahi mila = <b>is WebView me user logged in nahi hai</b> (ya game mirror domain par khula hai). "This host" vs "Site canonical host" alag ho to APK ka link main domain par rakho.');
    } else if (String(viaA) !== String(viaG) && viaA) {
      v.push('Aapka token (ar_token) balance de raha hai, par game ka ar_g_token nahi - matlab game ko handoff me token nahi mila. Game ko APK me site ke andar se hi kholo (direct mirror/vendor URL se nahi).');
    } else if (!viaG && !viaA) {
      v.push('API khud 0 de raha hai - token expire ho gaya ya balance sach me 0. Site me logout -> login karke dobara test karo.');
    } else {
      v.push('API theek balance de raha hai (' + esc(String(viaG)) + '). Agar tab bhi card 0 dikhaye to game ki JS purani hai: app ka WebView cache clear karo, ya admin tool me wingo_balance_mode = total karke dekho.');
    }
    if (framed) v.push('<b>IFrame/SW shell detect hua</b> - ar-sw.js ka round-7 patch zaroori hai, warna game page mirror domain par khulta rahega aur balance 0 rahega.');
    document.getElementById('verdict').innerHTML = '<li>' + v.join('</li><li>') + '</li>';
    rep.unshift('verdict: ' + v.join(' | ').replace(/<[^>]*>/g, ''));
    rep.unshift('host: ' + location.host, 'ua: ' + navigator.userAgent.slice(0, 130));
    rep.unshift('handoff: ' + (hand ? ('v' + hand.v + ' tok=' + hand.tok) : 'absent'),
      'ar_token: ' + (a ? 'yes' : 'no'), 'ar_g_token: ' + (g ? 'yes' : 'no'), 'framed: ' + (framed ? 'yes' : 'no'));
    document.getElementById('report').value = '=== WINGO APK CHECK ' + Date.now() + ' ===\n' + rep.join('\n');
  }

  document.getElementById('copy').onclick = function () {
    var el = document.getElementById('report');
    el.removeAttribute('readonly'); el.select();
    try { document.execCommand('copy'); this.textContent = 'Copied'; } catch (e) { this.textContent = 'Select + copy'; }
    el.setAttribute('readonly', 'readonly');
  };
})();
</script>
</body>
</html>
