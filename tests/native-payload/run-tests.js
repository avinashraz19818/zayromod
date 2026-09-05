'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// run-tests.js — NATIVE .so PAYLOAD verification (bina Android SDK ke).
//
// Coverage:
//  A. Static regression checks (anchors, JNI names, keep rules, no stale bin)
//  B. Host crypto selftest (SHA-256 / AES-256 / HMAC / PBKDF2 vectors)
//  C. Node-encrypt → C++-decrypt round-trip (real template HTML)
//  D. Tamper / wrong-password / truncation rejection
//  E. Generated-header end-to-end (pepper rebuild + decrypt, same C++ code)
//  F. APK verifier (existing built APK fixture par read-only check)
//  G. apkbuilder patch simulation (placeholder consumption)
//
// Run: node tests/native-payload/run-tests.js
// Exit 0 = sab pass. Koi bhi fail → exit 1 + FAIL lines.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const CPP_DIR = path.join(REPO, 'android-project', 'app', 'src', 'main', 'cpp');
const JAVA_DIR = path.join(REPO, 'android-project', 'app', 'src', 'main', 'java', 'com', 'zayro', 'wingsyttt');
const ASSETS_DIR = path.join(REPO, 'android-project', 'app', 'src', 'main', 'assets');

const np = require(path.join(REPO, 'utils', 'native-payload'));

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  [PASS] ${name}`); }
function bad(name, detail) { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function section(t) { console.log(`\n== ${t} ==`); }

function tmpWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zpay-test-'));
}
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// ── A. Static checks ─────────────────────────────────────────────────────────
section('A. Static regression checks');

try {
  for (const f of ['utils/native-payload.js', 'utils/apkbuilder.js']) {
    sh('node', ['--check', path.join(REPO, f)]);
  }
  ok('node --check (native-payload.js, apkbuilder.js)');
} catch (e) { bad('node --check', String(e.message).slice(0, 200)); }

try {
  const main = fs.readFileSync(path.join(JAVA_DIR, 'MainActivity.java'), 'utf8');
  const anchors = [
    'private static final byte[] APP_SERVER_URL_M = new byte[]{ 0, 0 };',
    'private static final byte[] APP_PATH_M = new byte[]{ 0, 0 };',
    'private static final byte[] FW_PASSWORD_M = new byte[]{ 0, 0 };',
    'private static final boolean NATIVE_PAYLOAD_FIRST = true;',
    'NativePayload.getPopupHtml(PW)',
    'loadDataWithBaseURL("file:///android_asset/", html, "text/html", "UTF-8", null)',
  ];
  const missing = anchors.filter(a => !main.includes(a));
  if (missing.length) bad('MainActivity anchors', 'missing: ' + missing.join(' | ').slice(0, 300));
  else ok('MainActivity anchors (patch targets + native calls + base URL)');
  // Remote flow intact?
  const remoteBits = ['fetchAppContent()', 'AES/CBC/PKCS5Padding', 'PBKDF2WithHmacSHA256',
    'retryContent', 'Network Problem', '/api/app-content/'];
  const rMissing = remoteBits.filter(a => !main.includes(a));
  if (rMissing.length) bad('MainActivity remote-flow intact', 'missing: ' + rMissing.join(','));
  else ok('MainActivity remote-flow code intact');
  // Loading flow intact?
  if (main.includes('getAssets().open("loading.bin")')) ok('MainActivity loading.bin flow intact');
  else bad('MainActivity loading.bin flow intact');
} catch (e) { bad('MainActivity checks', String(e.message).slice(0, 160)); }

try {
  const nj = fs.readFileSync(path.join(JAVA_DIR, 'NativePayload.java'), 'utf8');
  const nc = fs.readFileSync(path.join(CPP_DIR, 'native-payload.cpp'), 'utf8');
  const need = ['nativeGetPopupHtml', 'nativePayloadInfo'];
  const jm = need.every(n => nj.includes('native ') && nj.includes(n));
  const cm = need.every(n => nc.includes('Java_com_zayro_wingsyttt_NativePayload_' + n));
  if (jm && cm) ok('JNI names match (Java declarations ↔ C++ definitions)');
  else bad('JNI names match', `java=${jm} cpp=${cm}`);
  if (nc.includes('JNIEXPORT') && (nc.match(/JNIEXPORT/g) || []).length >= 2) ok('JNIEXPORT on native fns (hidden-visibility safe)');
  else bad('JNIEXPORT on native fns');
} catch (e) { bad('JNI checks', String(e.message).slice(0, 160)); }

try {
  const pro = fs.readFileSync(path.join(REPO, 'android-project', 'app', 'proguard-rules.pro'), 'utf8');
  if (pro.includes('com.zayro.wingsyttt.NativePayload')) ok('ProGuard keep rule for NativePayload');
  else bad('ProGuard keep rule for NativePayload');
} catch (e) { bad('ProGuard check', String(e.message).slice(0, 160)); }

try {
  const stale = ['wingss.bin', 'zayro.bin'].filter(f => fs.existsSync(path.join(ASSETS_DIR, f)));
  if (stale.length) bad('stale popup bins removed from template assets', stale.join(','));
  else ok('stale popup bins removed from template assets');
  const keep = ['loading.bin', 'intro.mp3', 'my_icon.png', '0.png', 'register.mp3'];
  const gone = keep.filter(f => !fs.existsSync(path.join(ASSETS_DIR, f)));
  if (gone.length) bad('template webview assets intact', 'missing: ' + gone.join(','));
  else ok('template webview assets intact (loading/mp3/png)');
} catch (e) { bad('assets checks', String(e.message).slice(0, 160)); }

try {
  const ph = fs.readFileSync(path.join(CPP_DIR, 'payload', 'popup_payload.h'), 'utf8');
  if (ph.includes('ZPAY_PAYLOAD_LEN = 0') && ph.includes('PLACEHOLDER')) ok('placeholder header empty (template builds → remote fallback)');
  else bad('placeholder header empty');
  const cmake = fs.readFileSync(path.join(CPP_DIR, 'CMakeLists.txt'), 'utf8');
  const srcs = ['native-security.cpp', 'native-payload.cpp', 'crypto/sha256.cpp', 'crypto/aes.cpp', 'crypto/payload_crypto.cpp'];
  if (srcs.every(s => cmake.includes(s))) ok('CMakeLists lists all native sources');
  else bad('CMakeLists lists all native sources');
} catch (e) { bad('native file checks', String(e.message).slice(0, 160)); }

// ── B. Host crypto selftest ──────────────────────────────────────────────────
section('B. Host crypto selftest (same sources as .so)');
const work = tmpWorkdir();
const harnessSrc = path.join(__dirname, 'harness.cpp');
const harnessBin = path.join(work, 'harness');
try {
  sh('g++', ['-std=c++11', '-O2', '-Wall', '-I', CPP_DIR, harnessSrc,
    path.join(CPP_DIR, 'crypto', 'sha256.cpp'),
    path.join(CPP_DIR, 'crypto', 'aes.cpp'),
    path.join(CPP_DIR, 'crypto', 'payload_crypto.cpp'),
    '-o', harnessBin]);
  ok('harness compiles against real crypto sources');
} catch (e) { bad('harness compile', String(e.stdout || e.stderr || e.message).slice(0, 400)); }

try {
  const pbkdf2Hex = crypto.pbkdf2Sync('password', 'salt', 100000, 64, 'sha256').toString('hex');
  const out = sh(harnessBin, ['selftest', pbkdf2Hex], { timeout: 120000 });
  console.log(out.split('\n').map(l => '    ' + l).join('\n').trimEnd());
  if (out.includes('SELFTEST: ALL OK')) ok('vectors: SHA-256 + AES-256 + HMAC + PBKDF2 + ct-compare');
  else bad('vectors', out.slice(0, 300));
} catch (e) { bad('vectors', String(e.stdout || e.stderr || e.message).slice(0, 400)); }

// ── C. Round-trip with REAL template HTML ────────────────────────────────────
section('C. Node-encrypt → C++-decrypt round-trip (real HTML)');
let fixtureHtml = null, fixtureName = '';
try {
  const candidates = [
    'templates/crimson-protocol-v2.html',
    'templates/redload.html',
  ];
  for (const c of candidates) {
    const p = path.join(REPO, c);
    if (fs.existsSync(p)) { fixtureHtml = fs.readFileSync(p, 'utf8'); fixtureName = c; break; }
  }
  if (!fixtureHtml) throw new Error('no fixture HTML found');
  ok(`fixture: ${fixtureName} (${fixtureHtml.length} chars)`);
} catch (e) { bad('fixture load', String(e.message).slice(0, 160)); }

let built = null;
const dexPassword = crypto.randomBytes(56).toString('base64'); // per-build style
try {
  built = np.buildNativePayload(fixtureHtml, dexPassword, 'test_build_1');
  const parsed = np.parsePayloadHeader(built.payloadBuf);
  if (!parsed.ok) throw new Error('parse: ' + parsed.reason);
  ok(`container built (${built.payloadBuf.length} bytes, ct ${parsed.ctLen}, iters ${parsed.iterations})`);
} catch (e) { bad('container build', String(e.message).slice(0, 200)); }

try {
  const cPath = path.join(work, 'c.bin');
  const pwFull = dexPassword + '|zpay1|' + built.pepperHex;
  fs.writeFileSync(cPath, built.payloadBuf);
  fs.writeFileSync(path.join(work, 'pw.txt'), pwFull);
  const out = sh(harnessBin, ['decrypt', cPath, path.join(work, 'pw.txt'), path.join(work, 'out.html')], { timeout: 120000 });
  const back = fs.readFileSync(path.join(work, 'out.html'), 'utf8');
  if (back === fixtureHtml) ok('C++ decrypt matches original HTML byte-for-byte');
  else bad('C++ decrypt matches', `len ${back.length} vs ${fixtureHtml.length}. ${out.slice(0, 120)}`);
} catch (e) { bad('C++ decrypt', String(e.stdout || e.stderr || e.message).slice(0, 300)); }

// ── D. Tamper / wrong-key rejection ──────────────────────────────────────────
section('D. Tamper / wrong-password / truncation rejection');
function expectReject(name, mutateContainer, pwFullOverride) {
  try {
    const c = Buffer.from(built.payloadBuf);
    mutateContainer(c);
    const cPath = path.join(work, 't.bin');
    fs.writeFileSync(cPath, c);
    fs.writeFileSync(path.join(work, 'tpw.txt'), pwFullOverride || (dexPassword + '|zpay1|' + built.pepperHex));
    sh(harnessBin, ['decrypt', cPath, path.join(work, 'tpw.txt'), path.join(work, 'tout.html')], { timeout: 120000 });
    bad(name, 'ACCEPTED (should reject)');
  } catch (e) {
    const s = String(e.stdout || '') + String(e.stderr || '');
    if (/REJECTED|read fail/.test(s) || e.status === 1) ok(name);
    else bad(name, 'unexpected error: ' + (s || e.message).slice(0, 160));
  }
}
try {
  const ctOff = 8 + 4 + 16 + 16 + 4;
  expectReject('flip ciphertext byte → reject', c => { c[ctOff + 10] ^= 0x01; });
  expectReject('flip tag byte → reject', c => { c[c.length - 1] ^= 0x01; });
  expectReject('flip magic byte → reject', c => { c[0] ^= 0x01; });
  expectReject('flip salt byte → reject', c => { c[12] ^= 0x01; });
  expectReject('wrong dex password → reject', () => {}, 'WRONG-password-not-the-key|zpay1|' + built.pepperHex);
  expectReject('wrong pepper → reject', () => {}, dexPassword + '|zpay1|' + '00'.repeat(16));
  try {
    const c = Buffer.from(built.payloadBuf).slice(0, built.payloadBuf.length - 10);
    fs.writeFileSync(path.join(work, 'tr.bin'), c);
    fs.writeFileSync(path.join(work, 'trpw.txt'), dexPassword + '|zpay1|' + built.pepperHex);
    sh(harnessBin, ['decrypt', path.join(work, 'tr.bin'), path.join(work, 'trpw.txt'), path.join(work, 'trout.html')], { timeout: 60000 });
    bad('truncated container → reject', 'ACCEPTED (should reject)');
  } catch (e) { ok('truncated container → reject'); }
} catch (e) { bad('tamper suite', String(e.message).slice(0, 200)); }

// ── E. Generated-header end-to-end ───────────────────────────────────────────
section('E. Generated-header end-to-end (pepper + payload via C++)');
try {
  const genDir = path.join(work, 'gen');
  fs.mkdirSync(genDir, { recursive: true });
  fs.writeFileSync(path.join(genDir, 'popup_payload.h'), built.headerCode, 'utf8');
  if (!built.headerCode.includes('ZPAY_PAYLOAD[]') || !built.headerCode.includes('ZPAY_PEPPER_M')) {
    throw new Error('header missing arrays');
  }
  // Plaintext leak check: header me HTML plaintext nahi hona chahiye
  const probe = fixtureHtml.replace(/\s+/g, ' ').slice(0, 120);
  const snippet = probe.slice(Math.min(20, probe.length - 1), Math.min(70, probe.length)).trim();
  if (snippet.length > 20 && built.headerCode.includes(snippet)) throw new Error('HTML plaintext leak in header!');
  ok('header generated, no HTML plaintext inside');
  const h2 = path.join(work, 'harness2');
  sh('g++', ['-std=c++11', '-O2', '-Wall', '-I', CPP_DIR, '-I', genDir,
    '-DZPAY_TEST_HEADER="popup_payload.h"', harnessSrc,
    path.join(CPP_DIR, 'crypto', 'sha256.cpp'),
    path.join(CPP_DIR, 'crypto', 'aes.cpp'),
    path.join(CPP_DIR, 'crypto', 'payload_crypto.cpp'),
    '-o', h2]);
  ok('header compiles as C++ (same include style as .so)');
  fs.writeFileSync(path.join(work, 'expect.html'), fixtureHtml, 'utf8');
  const out = sh(h2, ['decrypt-header', dexPassword, path.join(work, 'expect.html')], { timeout: 120000 });
  if (/matches/.test(out)) ok('full chain: header pepper → pwFull → decrypt → byte-match');
  else bad('full chain', out.slice(0, 200));
  try {
    sh(h2, ['decrypt-header', 'wrong-password', path.join(work, 'expect.html')], { timeout: 120000 });
    bad('header wrong-password → reject', 'ACCEPTED (should reject)');
  } catch (e2) { ok('header wrong-password → reject'); }
} catch (e) { bad('header e2e', String(e.stdout || e.stderr || e.message).slice(0, 300)); }

// ── F. APK verifier vs existing fixture ──────────────────────────────────────
section('F. APK verifier (existing built APK, read-only)');
try {
  const buildsDir = path.join(REPO, 'builds');
  let apk = null;
  if (fs.existsSync(buildsDir)) {
    outer: for (const d of fs.readdirSync(buildsDir)) {
      const p = path.join(buildsDir, d);
      if (!fs.statSync(p).isDirectory()) continue;
      for (const f of fs.readdirSync(p)) {
        if (f.toLowerCase().endsWith('.apk') && !/pre_signed|pre_aligned|_aligned/i.test(f)) { apk = path.join(p, f); break outer; }
      }
    }
  }
  if (!apk) { console.log('  [SKIP] no built APK fixture found under builds/'); }
  else {
    const f = np.verifyNativePayloadInApk(apk, { expectNative: false, expectPayload: false });
    console.log(`  fixture: ${path.basename(apk)}`);
    console.log(`    checked=${f.checked} plainHtml=${f.hasPlainHtml} popupBins=${JSON.stringify(f.popupBins)} loadingBins=${JSON.stringify(f.loadingBins)} so=${f.nativeSoPresent} magic=${f.payloadMagicInSo} assetsIntact=${f.webviewAssetsIntact}`);
    if (f.checked && f.apkExists) ok('verifier runs on real APK (old APK: no .so expected, loading intact)');
    else bad('verifier runs on real APK', (f.notes || []).join('; ').slice(0, 200));
  }
} catch (e) { bad('APK verifier', String(e.message).slice(0, 200)); }

// ── G. apkbuilder patch simulation ───────────────────────────────────────────
section('G. apkbuilder patch simulation (placeholder consumption)');
try {
  const src = fs.readFileSync(path.join(JAVA_DIR, 'MainActivity.java'), 'utf8');
  const XOR_KEY = 0x5a;
  const maskArr = (s) => 'new byte[]{ ' + Array.from(Buffer.from(String(s), 'utf8'))
    .map(b => `(byte)${(b ^ XOR_KEY) & 0xFF}`).join(', ') + ' }';
  let j = src;
  j = j.replace('private static final byte[] APP_SERVER_URL_M = new byte[]{ 0, 0 };',
    `private static final byte[] APP_SERVER_URL_M = ${maskArr('https://example.test')};`);
  j = j.replace('private static final byte[] APP_PATH_M = new byte[]{ 0, 0 };',
    `private static final byte[] APP_PATH_M = ${maskArr('path123~abcdef0123456789abcd12')};`);
  j = j.replace('private static final byte[] FW_PASSWORD_M = new byte[]{ 0, 0 };',
    `private static final byte[] FW_PASSWORD_M = ${maskArr(dexPassword)};`);
  j = j.replace('private static final boolean NATIVE_PAYLOAD_FIRST = true;',
    `private static final boolean NATIVE_PAYLOAD_FIRST = true;`);
  const leftovers = (j.match(/new byte\[\]\{ 0, 0 \}/g) || []).length;
  if (leftovers === 0 && j.includes('NATIVE_PAYLOAD_FIRST = true')) ok('all build-time placeholders consumed (server/path/password/order)');
  else bad('placeholder consumption', `leftovers=${leftovers}`);
} catch (e) { bad('patch simulation', String(e.message).slice(0, 200)); }

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
