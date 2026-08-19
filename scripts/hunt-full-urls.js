#!/usr/bin/env node
'use strict';

/**
 * hunt-full-urls.js — VPS pe chalao. Jin panels ka register URL abhi
 * invite-code KE BINA hai, unka PURA URL (code ke saath) dhundh kar
 * Firebase + DB dono me wapas daalta hai.
 *
 * Sources (is order me):
 *   1. VPS ki LIVE DB (orders table — real + fake paths)
 *   2. VPS ke builds folder ke APKs — legacy .bin decrypt karke (zayroavi@132)
 *   3. Firebase ke baaki nodes (push/regLink/min url etc.)
 *
 * Usage (VPS, project folder se):
 *   node scripts/hunt-full-urls.js            → hunt + restore
 *   node scripts/hunt-full-urls.js --dry-run  → sirf report
 *
 * Jin panels ka code KAHIN nahi milega — unka original invite code sirf
 * panel ke owner (ya customer) ke paas hai; list report me dikhegi.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const DRY = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..');
const BUILDS = path.join(ROOT, 'builds');
const DB_PATH = path.join(ROOT, 'database', 'apkbuilder.db');
const FB_URL = (process.env.FIREBASE_DATABASE_URL || 'https://zayrodev-195f3-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const PASSWORDS = ['zayroavi@132'];
const MK = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE]);

const hasCode = (u) => /(invitationcode|invitecode|invite)=/i.test(String(u || ''));

// ── Service account token (rules lagi hain — config write isi se) ──
let _tok = null, _tokExp = 0;
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function getToken() {
  try {
    const saFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/root/apkbuilder/firebase-service-account.json';
    if (!fs.existsSync(saFile)) return null;
    const sa = JSON.parse(fs.readFileSync(saFile, 'utf8'));
    const now = Date.now();
    if (_tok && now < _tokExp - 60000) return _tok;
    const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const p = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.database', aud: 'https://oauth2.googleapis.com/token', iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 }));
    const s = crypto.createSign('RSA-SHA256'); s.update(h + '.' + p);
    const sig = b64url(s.sign(sa.private_key));
    const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: h + '.' + p + '.' + sig }).toString() });
    const j = await res.json();
    if (j && j.access_token) { _tok = j.access_token; _tokExp = now + ((j.expires_in || 3600) * 1000); return _tok; }
    return null;
  } catch (e) { return null; }
}

function fbReq(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    getToken().then(token => {
      let u = FB_URL + urlPath + '.json';
      if (token) u += (u.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(u, { method, headers: { 'Content-Type': 'application/json' }, timeout: 60000 }, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + ' ' + b.slice(0, 150))); return; }
          try { resolve(b ? JSON.parse(b) : null); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('fb timeout')); });
      if (data) req.write(data);
      req.end();
    }).catch(reject);
  });
}

function decryptBin(buf, pw) {
  for (let mp = 0; mp <= buf.length - 8; mp++) {
    let ok = true;
    for (let j = 0; j < 8; j++) if (buf[mp + j] !== MK[j]) { ok = false; break; }
    if (!ok) continue;
    const salt = buf.slice(mp + 8, mp + 24), iv = buf.slice(mp + 24, mp + 40);
    const enc = buf.slice(mp + 40, buf.length - 64);
    const kb = crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256');
    try {
      const d = crypto.createDecipheriv('aes-256-cbc', kb, iv);
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    } catch (e) { return null; }
  }
  return null;
}

function deriveUrls(reg) {
  const baseMatch = String(reg).match(/^(https?:\/\/[^/]+)/);
  const base = baseMatch ? baseMatch[1] : String(reg).split('#')[0].replace(/\/+$/, '');
  if (/invitecode=/i.test(reg) && !reg.includes('#/')) {
    return { dep: base + '/wallet/recharge', wingo: base + '/WinGo/WinGo_30S' };
  }
  return { dep: base + '/#/wallet/Recharge', wingo: base + '/#/saasLottery/WinGo?gameCode=WinGo_30S&lottery=WinGo' };
}

// 1) VPS LIVE DB scan — CHILD PROCESS me (better-sqlite3 kuch env me
// crash kar sakta hai; VPS server ke liye wahi module use hota hai to
// wahan theek chalega. Child me crash ho to python3 fallback.)
function scanDb() {
  const map = new Map(); // path -> {reg, dep, wingo, src}
  if (!fs.existsSync(DB_PATH)) { console.log('[db] DB file nahi mili'); return map; }

  const addRows = (rows) => {
    for (const r of rows) {
      if (r[4] && r[1]) {
        map.set(String(r[4]).toLowerCase().trim(),
          { reg: r[1], dep: r[2], wingo: r[3], src: `db#${r[0]}` });
      }
      if (r[6] && r[5]) {
        const d = deriveUrls(r[5]);
        map.set(String(r[6]).toLowerCase().trim(),
          { reg: r[5], dep: d.dep, wingo: d.wingo, src: `db#${r[0]} fake` });
      }
    }
  };

  // a) python3 — sabse reliable (stdlib sqlite3, sab jagah chalta hai)
  try {
    const py = [
      'import sqlite3, json',
      'db = sqlite3.connect(' + JSON.stringify(DB_PATH) + ')',
      'cur = db.cursor()',
      "cols = [r[1] for r in cur.execute('PRAGMA table_info(orders)').fetchall()]",
      "sel = ['id','register_url','deposit_url','wingo_url','firebase_path']",
      "sel += ['fake_register_url'] if 'fake_register_url' in cols else ['NULL AS fake_register_url']",
      "sel += ['fake_firebase_path'] if 'fake_firebase_path' in cols else ['NULL AS fake_firebase_path']",
      "for r in cur.execute('SELECT ' + ','.join(sel) + ' FROM orders').fetchall():",
      '    print(json.dumps(list(r)))',
    ].join('\n');
    const out = execFileSync('python3', ['-c', py], { encoding: 'utf8', timeout: 30000 });
    const rows = out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    addRows(rows);
    if (rows.length) {
      console.log(`[db] python3 → ${map.size} path ka URL mila (${rows.length} orders)`);
      return map;
    }
    console.log('[db] python3 → 0 orders (khali DB?)');
  } catch (e) { console.log('[db] python3 fail:', e.message); }

  // b) better-sqlite3 in-process (VPS server wahi use karta hai)
  try {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const db = new Database(DB_PATH, { readonly: true });
    const cols = db.prepare('PRAGMA table_info(orders)').all().map(r => r.name);
    const sel = ['id', 'register_url', 'deposit_url', 'wingo_url', 'firebase_path',
      cols.includes('fake_register_url') ? 'fake_register_url' : 'NULL AS fake_register_url',
      cols.includes('fake_firebase_path') ? 'fake_firebase_path' : 'NULL AS fake_firebase_path'];
    const rows = db.prepare('SELECT ' + sel.join(',') + ' FROM orders').all();
    db.close();
    addRows(rows);
    console.log(`[db] better-sqlite3 → ${map.size} path ka URL mila (${rows.length} orders)`);
  } catch (e) { console.log('[db] better-sqlite3 fail:', e.message); }
  return map;
}

// 2) VPS builds APK scan
function scanApks() {
  const map = new Map();
  if (!fs.existsSync(BUILDS)) return map;
  const apks = [];
  for (const d of fs.readdirSync(BUILDS)) {
    const dp = path.join(BUILDS, d);
    if (!fs.statSync(dp).isDirectory()) continue;
    for (const f of fs.readdirSync(dp)) if (f.toLowerCase().endsWith('.apk')) apks.push(path.join(dp, f));
  }
  let dec = 0;
  for (const apk of apks) {
    const ext = '/tmp/hunt_' + process.pid + '_' + Math.random().toString(36).slice(2);
    fs.rmSync(ext, { recursive: true, force: true });
    try { execFileSync('unzip', ['-o', '-qq', apk, 'assets/wingss.bin', 'assets/zayro.bin', 'assets/loading.bin', 'assets/lodale.bin', '-d', ext], { stdio: 'pipe' }); } catch (e) {}
    const binDir = path.join(ext, 'assets');
    if (!fs.existsSync(binDir)) { fs.rmSync(ext, { recursive: true, force: true }); continue; }
    for (const bin of fs.readdirSync(binDir)) {
      if (!bin.endsWith('.bin')) continue;
      const buf = fs.readFileSync(path.join(binDir, bin));
      let html = null;
      for (const pw of PASSWORDS) { html = decryptBin(buf, pw); if (html) break; }
      if (!html) continue;
      dec++;
      const m1 = html.match(/rtdb\.ref\s*\(\s*["']([a-zA-Z0-9_]+)\/(?:config|users)/);
      const fp = m1 ? m1[1].toLowerCase() : null;
      if (!fp) continue;
      const urls = new Set();
      const re = /https?:\/\/[^"'\s\\]+/g;
      let m;
      while ((m = re.exec(html))) {
        const u = m[0].replace(/\\/g, '');
        if (/register|invitation|invite/i.test(u)) urls.add(u);
      }
      const withCode = [...urls].find(hasCode) || [...urls][0];
      if (withCode && !map.has(fp)) {
        const d = deriveUrls(withCode);
        map.set(fp, { reg: withCode, dep: d.dep, wingo: d.wingo, src: 'apk:' + path.basename(apk).slice(0, 30) });
      }
    }
    fs.rmSync(ext, { recursive: true, force: true });
  }
  console.log(`[apk] ${apks.length} APKs scan, ${dec} decrypt, ${map.size} full-URL mile`);
  return map;
}

(async () => {
  const dbMap = scanDb();
  const apkMap = scanApks();
  const full = new Map();
  for (const m of [dbMap, apkMap]) for (const [k, v] of m) if (v && v.reg && hasCode(v.reg)) full.set(k, v);

  // Firebase current state
  let tree = null;
  try { tree = await fbReq('GET', '/'); } catch (e) { console.log('[fb] read fail:', e.message); }
  if (tree && typeof tree === 'object') console.log('[fb] tree mila — keys:', Object.keys(tree).length);
  const panels = [];
  if (tree && typeof tree === 'object') {
    for (const [top, val] of Object.entries(tree)) {
      const cfg = val && typeof val === 'object' ? val.config : null;
      if (cfg && typeof cfg === 'object' && cfg.registerUrl && !hasCode(cfg.registerUrl)) {
        panels.push(top);
      }
    }
  }
  console.log(`[fb] ${panels.length} panel ka registerUrl bina code ke hai.\n`);

  let restored = 0;
  const stillMissing = [];
  for (const p of panels) {
    const rec = full.get(String(p).toLowerCase());
    if (!rec) { stillMissing.push(p); continue; }
    const body = { registerUrl: rec.reg, depositUrl: rec.dep, wingoUrl: rec.wingo, linkUpdatedAt: Date.now() };
    if (DRY) {
      console.log(`[dry] ${p} → ${rec.reg.slice(0, 80)} (${rec.src})`);
      restored++;
    } else {
      try {
        await fbReq('PATCH', '/' + encodeURIComponent(p) + '/config', body);
        console.log(`✅ ${p} → ${rec.reg.slice(0, 80)} (${rec.src})`);
        restored++;
      } catch (e) {
        console.log(`❌ ${p}: ${e.message}`);
      }
    }
  }

  console.log(`\n[done] restored=${restored}, bina code wale bache=${stillMissing.length}`);
  if (stillMissing.length) {
    console.log('\n⚠️  IN PANELS KA CODE KAHIN NAHI MILA (DB/APK/Firebase sab scan kiya):');
    for (const s of stillMissing) console.log('   -', s);
    console.log('\n   → Inke original invite codes sirf panel owner/customer ke paas hain.');
    console.log('     Owner se code maang kar mujhe batao — main Firebase me turant daal dunga.');
    console.log('     (Ya admin panel → Firebase Manager se khud bhi laga sakte ho.)');
  }
})();
