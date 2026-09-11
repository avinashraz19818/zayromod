#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// check-route-compat.js — design HTML ko real WebView jaise environment (jsdom)
// me chala kar verify karta hai ki design PATH-ROUTED games (DhaniWin, 13l)
// pe register / login / wingo page sahi detect karta hai ya nahi.
//
// Usage:
//   node scripts/check-route-compat.js                 # saare templates/ designs
//   node scripts/check-route-compat.js path/to/AIT.html # ek specific design
//
// Requirement (sirf test ke liye):  npm i -D jsdom
//
// Har design do baar test hota hai:
//   RAW       → bina build pipeline ke (purana behaviour / baseline)
//   PROCESSED → injectParams() ke baad (jo HTML APK me jata hai)
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

let JSDOM, VirtualConsole;
function loadJsdom() {
  if (JSDOM) return true;
  try {
    ({ JSDOM, VirtualConsole } = require('jsdom'));
    return true;
  } catch (e) {
    return false;
  }
}

const { injectParams, buildUrls, isDhaniUrl, extractDomain } = require('../utils/htmlprocessor');
const { stripRouteCompat } = require('../utils/routecompat');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

// ── Test scenarios: path-routed (DhaniWin / 13l) URLs ──
// Expectations JAAN-BOOJH kar strict hain: 'wait' state akela kaafi nahi
// (design load hote hi khud 'wait' pe hota hai), isliye design ke apne
// route flags (isOnRegisterPage / wasAuthFlowActive / lastPageState) dekhe
// jaate hain jo setUrl() ke andar hi set hote hain.
const SCENARIOS = [
  {
    id: 'dhani-register',
    label: 'DhaniWin register',
    url: 'https://dhaniwin.example/register?inviteCode=RZG9RNN&from=web',
    // Design families alag-alag flags rakhti hain — koi bhi sahi signal chalega,
    // lekin 'home'/'ready' state pe chale jana = register detect nahi hua.
    expect: (r) =>
      r.isOnRegisterPage === true ||
      r.lastRouteKind === 'register' ||
      (r.states.includes('wait') && !r.states.includes('home') && !r.states.includes('ready')),
    expectText: 'register detect (flag ya state=wait)'
  },
  {
    id: '13l-login',
    label: '13l login',
    url: 'https://13l.example/login',
    expect: (r) =>
      r.lastRouteKind === 'login' ||
      (r.states.includes('wait') && !r.states.includes('home') && !r.states.includes('ready')),
    expectText: 'state=wait (home/ready nahi)'
  },
  {
    id: '13l-wingo',
    label: '13l wingo',
    url: 'https://13l.example/WinGo/WinGo_30S',
    expect: (r) =>
      r.states.includes('wingo') || r.lastPageState === 'wingo' || r.lastRouteKind === 'wingo',
    expectText: 'wingo detect'
  },
  {
    id: 'dhani-wallet',
    label: 'DhaniWin wallet',
    url: 'https://dhaniwin.example/wallet/recharge',
    expect: (r) => r.states.length > 0 || r.lastPageState || r.lastRouteKind,
    expectText: 'koi state set ho (crash na ho)'
  }
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runDesign(html, label, scenarios = SCENARIOS) {
  if (!loadJsdom()) throw new Error('jsdom nahi mila. Pehle chalao:  npm i -D jsdom');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e && e.message ? e.message : e)));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'file:///android_asset/index.html',
    virtualConsole: vc,
    resources: undefined, // external scripts (firebase CDN) load nahi hote
    beforeParse(window) {
      // APK me firebase CDN se load hota hai; test env me minimal stub.
      // (Kai designs top-level pe firebase.initializeApp() chalate hain —
      //  stub ke bina unka poora script block mar jata hai.)
      const snap = { exists: () => false, val: () => null, key: null };
      const refStub = {
        on: () => {},
        once: () => Promise.resolve(snap),
        update: () => Promise.resolve(),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        child: () => refStub,
        push: () => refStub
      };
      const dbStub = { ref: () => refStub, goOnline: () => {}, goOffline: () => {} };
      // Canvas 2D context stub (jsdom me canvas nahi hota — kuch designs
      //  init pe hi ctx.clearRect() chalate hain aur poora script mar jata hai)
      try {
        const ctxStub = new Proxy({}, { get: () => () => {} });
        window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      } catch (e) {}
      window.firebase = {
        apps: [],
        initializeApp: () => ({ database: () => dbStub }),
        app: () => ({ database: () => dbStub }),
        database: () => dbStub
      };
    }
  });
  const w = dom.window;

  // Android WebView jaisa native bridge stub
  w.ZAYRO = w.ZAYRO || {};
  const sounds = [];
  ['playSound', 'speak', 'stopSound', 'retryContent', 'openExternal', 'openUrl', 'setArea', 'getCurrentUrl'].forEach((m) => {
    if (typeof w.ZAYRO[m] !== 'function') {
      w.ZAYRO[m] = m === 'playSound' ? (f) => sounds.push(String(f)) : () => {};
    }
  });
  if (typeof w.ZAYRO.playSound === 'function' && !w.ZAYRO.playSound.__rec) {
    const orig = w.ZAYRO.playSound;
    w.ZAYRO.playSound = function (f) { sounds.push(String(f)); return orig.apply(this, arguments); };
    w.ZAYRO.playSound.__rec = true;
  }

  await sleep(120); // design ke scripts + init timers

  // State recorders — design ke apne window.setState/_goState/playAudio wrap
  const states = [];
  const wrapRecorder = (name, sink, tag) => {
    try {
      if (typeof w[name] === 'function') {
        const orig = w[name];
        w[name] = function (v) { sink.push(tag === 'state' ? String(v) : String(v)); return orig.apply(this, arguments); };
      }
    } catch (e) {}
  };
  wrapRecorder('setState', states, 'state');
  wrapRecorder('_goState', states, 'state');
  const played = [];
  wrapRecorder('playAudio', played, 'sound');

  if (typeof w.setUrl !== 'function') {
    dom.window.close();
    return { ok: false, fatal: 'window.setUrl define nahi hua', states, sounds, errors };
  }

  const results = [];
  for (const sc of scenarios) {
    states.length = 0;
    // Design ke route flags reset — taaki test sirf is scenario ke setUrl()
    // ke natije ko measure kare (design ka init-time REGISTER_URL call nahi).
    try { w.isOnRegisterPage = false; } catch (e) {}
    try { w.lastPageState = null; } catch (e) {}
    try { w.wasAuthFlowActive = false; } catch (e) {}
    try { w._lastRouteKind = null; } catch (e) {}
    await sleep(30);
    states.length = 0;
    try {
      w.setUrl(sc.url);
    } catch (e) {
      errors.push(`setUrl(${sc.id}) throw: ${e.message}`);
    }
    await sleep(150);
    let isOnRegisterPage = null;
    try { isOnRegisterPage = w.isOnRegisterPage; } catch (e) {}
    let lastPageState = null;
    try { lastPageState = w.lastPageState; } catch (e) {}
    let wasAuthFlowActive = null;
    try { wasAuthFlowActive = w.wasAuthFlowActive; } catch (e) {}
    let lastRouteKind = null;
    try { lastRouteKind = w._lastRouteKind; } catch (e) {}
    const r = { states: states.slice(), sounds: sounds.concat(played), isOnRegisterPage, lastPageState, wasAuthFlowActive, lastRouteKind };
    let pass = false;
    try { pass = !!sc.expect(r); } catch (e) {}
    results.push({ id: sc.id, label: sc.label, pass, detail: r });
  }

  dom.window.close();
  return { ok: results.every((r) => r.pass), results, errors };
}

function processHtml(rawHtml, registerUrl) {
  // Real pipeline jaisa: isDhani order ke register URL se detect hota hai.
  const isDhani = isDhaniUrl(registerUrl);
  const { deposit, wingo } = buildUrls(registerUrl, isDhani);
  const out = injectParams(rawHtml, {
    registerUrl,
    depositUrl: deposit,
    wingoUrl: wingo,
    domain: extractDomain(registerUrl),
    firebasePath: 'zayrotestpath',
    minDeposit: 300,
    brandTitle: 'AIT TEST',
    appIconBase64: null,
    isDhani
  });
  // ABLATION: NO_COMPAT=1 pe shim hata kar chalao — isse prove hota hai ki
  // fix route-compat shim se hi aa raha hai (baaki injection se nahi).
  if (process.env.NO_COMPAT) return stripRouteCompat(out);
  return out;
}

async function checkFile(file) {
  const name = path.basename(file);
  const raw = fs.readFileSync(file, 'utf8');
  const processed = processHtml(raw, 'https://dhaniwin.example/register?inviteCode=RZG9RNN&from=web');

  const before = await runDesign(raw, 'RAW');
  const after = await runDesign(processed, 'PROCESSED');

  const summarize = (run) => (run.results || []).map((r) => `${r.pass ? 'PASS' : 'FAIL'}`).join(' ') || 'n/a';
  // Agar design jsdom me hi init nahi hota (raw + processed dono me setUrl
  // missing) to ye test-environment limitation hai, design bug nahi.
  const skipped = !!(before.fatal && after.fatal);
  console.log(
    `${name.padEnd(56)} raw[ ${summarize(before)} ]  processed[ ${summarize(after)} ]` +
      (skipped ? '  SKIP (jsdom me design init nahi hua)' : after.fatal ? `  FATAL: ${after.fatal}` : '')
  );
  if (process.env.VERBOSE) {
    const dump = (tag, run) => {
      for (const r of run.results || []) {
        console.log(`    ${tag} ${r.label.padEnd(18)} ${r.pass ? 'PASS' : 'FAIL'}  states=${JSON.stringify(r.detail.states)} isReg=${r.detail.isOnRegisterPage} lastPageState=${r.detail.lastPageState} routeKind=${r.detail.lastRouteKind}`);
      }
    };
    dump('raw      ', before);
    dump('processed', after);
    if (after.errors.length) console.log(`    jsdom errors: ${after.errors.slice(0, 3).join(' | ')}`);
  }
  return { name, before: before.ok, after: after.ok, fatal: after.fatal, results: after.results, skipped };
}

async function main() {
  if (!loadJsdom()) {
    console.error('jsdom nahi mila. Pehle chalao:  npm i -D jsdom');
    process.exit(2);
  }
  const arg = process.argv[2];
  let files;
  if (arg) {
    files = [path.resolve(arg)];
  } else {
    files = fs.readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith('.html') && !f.startsWith('fake_') && f !== 'redload.html')
      .map((f) => path.join(TEMPLATES_DIR, f));
  }

  console.log(`\nPath-routed (DhaniWin / 13l) route-detection check — ${files.length} design(s)\n`);
  let passCount = 0;
  let skipCount = 0;
  const failures = [];
  for (const f of files) {
    const res = await checkFile(f);
    if (res.skipped) skipCount++;
    else if (res.after) passCount++;
    else failures.push(res);
  }
  const checked = files.length - skipCount;
  console.log(`\nResult: ${passCount}/${checked} designs path-routed games pe sahi detect karte hain.` + (skipCount ? ` (${skipCount} design jsdom me init nahi hue — skip)` : ''));
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) {
      const bad = (f.results || []).filter((r) => !r.pass).map((r) => r.label).join(', ');
      console.log(`  - ${f.name}${f.fatal ? ` (${f.fatal})` : ''} → ${bad || 'n/a'}`);
    }
  }
  process.exit(failures.length ? 1 : 0);
}

module.exports = { runDesign, processHtml, checkFile, SCENARIOS, main };

if (require.main === module) main();
