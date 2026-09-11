'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// route-compat regression tests
//
//   node --test test/
//
// Ye tests us bug ko lock karte hain jisme naya upload kiya hua design
// (jaise AIT) DhaniWin / 13l jaise PATH-ROUTED games pe kaam nahi karta tha:
// design route sirf location.hash se padhta hai, aur path-routed site pe hash
// hamesha khali rehta hai.
// ─────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { normalizeRoute, injectRouteCompat, stripRouteCompat, SHIM_MARKER } = require('../utils/routecompat');
const { isDhaniUrl, buildUrls, injectParams } = require('../utils/htmlprocessor');

const harness = require('../scripts/check-route-compat');

let haveJsdom = false;
try { require('jsdom'); haveJsdom = true; } catch (_) {}
const skipJsdom = haveJsdom ? false : 'jsdom install nahi hai (npm i -D jsdom)';

const FIXTURE = path.join(__dirname, 'fixtures', 'ait-like-design.html');
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

const DHANI_REGISTER = 'https://dhaniwin.example/register?inviteCode=RZG9RNN&from=web';
const THIRTEENL_WINGO = 'https://13l.example/WinGo/WinGo_30S';
const HASH_REGISTER = 'https://www.ts777.co/#/register?invitationCode=123';
const HASH_WINGO = 'https://bdgwin12.com/#/saasLottery/WinGo?gameCode=WinGo_30S&lottery=WinGo';

// ── 1. URL normalization (shipped shim ka hi logic, vm me chalaya hua) ──
test('normalizeRoute: path-routed (DhaniWin/13l) URLs hash-routed ban jaate hain', () => {
  assert.strictEqual(
    normalizeRoute('https://dhaniwin.example/register?inviteCode=RZG9RNN&from=web'),
    'https://dhaniwin.example/#/register?inviteCode=RZG9RNN&from=web'
  );
  assert.strictEqual(normalizeRoute('https://13l.example/login'), 'https://13l.example/#/login');
  assert.strictEqual(
    normalizeRoute(THIRTEENL_WINGO),
    'https://13l.example/#/saasLottery/WinGo?gameCode=WinGo_30S&lottery=WinGo'
  );
  assert.strictEqual(normalizeRoute('https://13l.example/wallet/recharge'), 'https://13l.example/#/wallet/Recharge');
  assert.strictEqual(normalizeRoute('https://13l.example/'), 'https://13l.example/#/home');
});

test('normalizeRoute: hash-routed (normal Zayro) URLs bilkul untouched rehte hain', () => {
  assert.strictEqual(normalizeRoute(HASH_REGISTER), HASH_REGISTER);
  assert.strictEqual(normalizeRoute(HASH_WINGO), HASH_WINGO);
  assert.strictEqual(normalizeRoute('about:blank'), 'about:blank');
  assert.strictEqual(normalizeRoute(''), '');
});

// ── 2. DhaniWin / 13l URL shape detection ──
test('isDhaniUrl + buildUrls: 13l aur DhaniWin path-routed maane jaate hain', () => {
  assert.strictEqual(isDhaniUrl('https://13l.example'), true);
  assert.strictEqual(isDhaniUrl('https://13l.example/login'), true);
  assert.strictEqual(isDhaniUrl('https://dhaniwin.example/register?inviteCode=AB'), true);

  const urls = buildUrls('https://13l.example/register?inviteCode=AB', isDhaniUrl('https://13l.example/register?inviteCode=AB'));
  assert.strictEqual(urls.deposit, 'https://13l.example/wallet/recharge');
  assert.strictEqual(urls.wingo, 'https://13l.example/WinGo/WinGo_30S');
});

test('isDhaniUrl: hash-routed site ko galti se dhani na maane', () => {
  assert.strictEqual(isDhaniUrl(HASH_REGISTER), false);
  const urls = buildUrls(HASH_REGISTER, false);
  assert.strictEqual(urls.deposit, 'https://www.ts777.co/#/wallet/Recharge');
});

// ── 3. Shim injection ──
test('injectParams har design me route-compat shim inject karta hai (idempotent)', () => {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  const once = injectParams(raw, {
    registerUrl: DHANI_REGISTER,
    depositUrl: 'https://dhaniwin.example/wallet/recharge',
    wingoUrl: THIRTEENL_WINGO,
    domain: 'dhaniwin.example',
    firebasePath: 'zayrotestpath',
    minDeposit: 300,
    brandTitle: 'AIT',
    appIconBase64: null,
    isDhani: true
  });
  assert.ok(once.includes(SHIM_MARKER), 'shim inject hona chahiye');
  assert.strictEqual(injectRouteCompat(once), once, 'double inject nahi hona chahiye');
  assert.ok(stripRouteCompat(once).indexOf(SHIM_MARKER) === -1, 'strip ablation ke liye kaam kare');
});

// ── 4. End-to-end (jsdom): naya design DhaniWin / 13l pe kaam kare ──
const PATH_SCENARIOS = [
  {
    id: 'register', label: 'DhaniWin register', url: DHANI_REGISTER,
    expect: (r) => r.isOnRegisterPage === true || r.lastRouteKind === 'register' ||
      (r.states.includes('wait') && !r.states.includes('home') && !r.states.includes('ready'))
  },
  {
    id: 'login', label: '13l login', url: 'https://13l.example/login',
    expect: (r) => r.lastRouteKind === 'login' ||
      (r.states.includes('wait') && !r.states.includes('home') && !r.states.includes('ready'))
  },
  {
    id: 'wingo', label: '13l wingo', url: THIRTEENL_WINGO,
    expect: (r) => r.states.includes('wingo') || r.lastPageState === 'wingo' || r.lastRouteKind === 'wingo'
  }
];

const HASH_SCENARIOS = [
  {
    id: 'register', label: 'Zayro register', url: HASH_REGISTER,
    expect: (r) => r.isOnRegisterPage === true || r.lastRouteKind === 'register' || r.states.includes('wait')
  },
  {
    id: 'wingo', label: 'Zayro wingo', url: HASH_WINGO,
    expect: (r) => r.states.includes('wingo') || r.lastPageState === 'wingo' || r.lastRouteKind === 'wingo'
  }
];

function describe(run) {
  return (run.results || []).map((r) => `${r.label}=${r.pass ? 'PASS' : 'FAIL'}`).join(' ');
}

test('AIT-jaisa naya design: DhaniWin / 13l path-routed pages detect karta hai', { skip: skipJsdom }, async () => {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  const processed = harness.processHtml(raw, DHANI_REGISTER);
  const run = await harness.runDesign(processed, 'processed', PATH_SCENARIOS);
  assert.ok(run.results.every((r) => r.pass), `processed design fail hua → ${describe(run)}`);
});

test('shim ke bina wahi design DhaniWin / 13l pe fail karta hai (regression guard)', { skip: skipJsdom }, async () => {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  const noShim = stripRouteCompat(harness.processHtml(raw, DHANI_REGISTER));
  const run = await harness.runDesign(noShim, 'no-shim', PATH_SCENARIOS);
  const failed = run.results.filter((r) => !r.pass);
  assert.ok(failed.length > 0, 'shim hataane par design ko fail hona chahiye — warna test kuch check nahi kar raha');
});

test('hash-routed (normal) games pe shim se koi regression nahi', { skip: skipJsdom }, async () => {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  const processed = harness.processHtml(raw, HASH_REGISTER);
  const run = await harness.runDesign(processed, 'processed-hash', HASH_SCENARIOS);
  assert.ok(run.results.every((r) => r.pass), `hash-routed regression → ${describe(run)}`);
});

test('repo ka real design (red_core) DhaniWin / 13l pe detect karta hai', { skip: skipJsdom }, async () => {
  const file = path.join(TEMPLATES_DIR, '1788587624534_red_core.html');
  if (!fs.existsSync(file)) return; // templates optional hain (fresh checkout)
  const processed = harness.processHtml(fs.readFileSync(file, 'utf8'), DHANI_REGISTER);
  const run = await harness.runDesign(processed, 'red_core', PATH_SCENARIOS);
  assert.ok(run.results.every((r) => r.pass), `red_core fail hua → ${describe(run)}`);
});
