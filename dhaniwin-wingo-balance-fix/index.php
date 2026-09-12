<?php
/**
 * Dhani.win front controller (round 7)
 * -----------------------------------
 * Serves index.html, and - only when that document is an OLD build without the
 * WebView token handoff - injects /dh-handoff.js before the app boots.
 *
 * Why: the browser showed the member's Wingo balance but the APK showed Rs 0.00.
 * Inside a WebView the game page is often a stale/cached document or a mirror
 * domain's document; that document never hands `ar_g_token` to the game, so the
 * game asked the API as an anonymous visitor. index.php is the SPA fallback
 * (.htaccess: RewriteRule ^ index.php) and is always no-store, so this is the one
 * place the fix can not be cached away.
 *
 * X-Dhaniwin-Handoff header tells admin/wingo-check.php (and devtools) what happened:
 *   inline   - index.html already carries the handoff block
 *   injected - old index.html detected, /dh-handoff.js injected
 *   missing  - /dh-handoff.js not uploaded (put it next to index.html)
 */
$root = __DIR__;
$indexFile = $root . '/index.html';

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache, no-store, must-revalidate');
header('Pragma: no-cache');
header('Expires: 0');

if (!is_file($indexFile)) {
    http_response_code(404);
    echo 'index.html not found';
    exit;
}

$html = (string) file_get_contents($indexFile);
$mode = 'inline';

if (strpos($html, '__DH_HANDOFF__') === false) {
    if (is_file($root . '/dh-handoff.js')) {
        $tag = "<script src=\"/dh-handoff.js?v=7\"></script>\n    ";
        $done = false;
        foreach (array('<script type="module"', '<script type=module', '</head>') as $needle) {
            $pos = stripos($html, $needle);
            if ($pos !== false) {
                $html = substr($html, 0, $pos) . $tag . substr($html, $pos);
                $done = true;
                break;
            }
        }
        $mode = $done ? 'injected' : 'missing';
    } else {
        $mode = 'missing';
    }
}

header('X-Dhaniwin-Handoff: ' . $mode);
echo $html;
