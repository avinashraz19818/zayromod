#!/usr/bin/env node
'use strict';

/**
 * restore-firebase-links.js — Firebase me goavideo (hack) wale links wapas
 * original pe lao. Ye VPS pe chalana hai (wahan ka DB live hai, GitHub
 * snapshot se zyada orders ho sakte hain).
 *
 * Usage:
 *   node scripts/restore-firebase-links.js            → restore karta hai
 *   node scripts/restore-firebase-links.js --dry-run  → sirf dikhata hai
 *   node scripts/restore-firebase-links.js --clean-junk → goavideo wale
 *                                                        push/min-url junk
 *                                                        nodes bhi delete
 *
 * Kya karta hai:
 *   1. VPS DB (orders table) se har firebase_path + fake_firebase_path ka
 *      original register/deposit/wingo URL nikalta hai
 *   2. Firebase ka poora tree padhta hai, jahan bhi goavideo milta hai
 *      wahan DB wala original PATCH kar deta hai
 *   3. Jin panels ke orders DB me nahi mile (delete ho chuke / dusre
 *      sellers ke) unki list dikhata hai — unhe manually theek karna hoga
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DRY = process.argv.includes('--dry-run');
const CLEAN_JUNK = process.argv.includes('--clean-junk');
const FB_URL = (process.env.FIREBASE_DATABASE_URL || 'https://zayrodev-195f3-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const DB_PATH = path.join(__dirname, '..', 'database', 'apkbuilder.db');

// ── Service account token (rules lagi ho to config write isi se hoti hai) ──
const crypto = require('crypto');
let _tok = null, _tokExp = 0;
function b64url(b) { return Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
async function getToken() {
  try {
    const saFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/root/apkbuilder/firebase-service-account.json';
    if (!fs.existsSync(saFile)) return null;
    const sa = JSON.parse(fs.readFileSync(saFile, 'utf8'));
    const now = Date.now();
    if (_tok && now < _tokExp - 60000) return _tok;
    const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const p = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.database', aud: 'https://oauth2.googleapis.com/token', iat: Math.floor(now/1000), exp: Math.floor(now/1000)+3600 }));
    const s = crypto.createSign('RSA-SHA256'); s.update(h + '.' + p);
    const sig = b64url(s.sign(sa.private_key));
    const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: h + '.' + p + '.' + sig }).toString() });
    const j = await res.json();
    if (j && j.access_token) { _tok = j.access_token; _tokExp = now + ((j.expires_in || 3600) * 1000); return _tok; }
    return null;
  } catch (e) { return null; }
}

async function httpJson(method, urlPath, body) {
  let u = FB_URL + urlPath + '.json';
  let token = null;
  try { token = await getToken(); } catch (e) {}
  if (token) u += (u.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    };
    const req = https.request(u, opts, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve(b ? JSON.parse(b) : null); }
        catch (e) { reject(new Error('bad json: ' + b.slice(0, 150))); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function loadOrders() {
  const map = new Map(); // firebase_path(lower) -> {reg, dep, wingo, src}
  let Database;
  try { Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3')); }
  catch (e) { console.error('[error] better-sqlite3 nahi mila — project folder se chalao (cd ~/apkbuilder)'); process.exit(1); }
  const db = new Database(DB_PATH, { readonly: true });
  const cols = db.prepare('PRAGMA table_info(orders)').all().map(r => r.name);
  const sel = ['id', 'register_url', 'deposit_url', 'wingo_url', 'firebase_path',
    cols.includes('fake_register_url') ? 'fake_register_url' : 'NULL AS fake_register_url',
    cols.includes('fake_firebase_path') ? 'fake_firebase_path' : 'NULL AS fake_firebase_path'];
  const rows = db.prepare('SELECT ' + sel.join(',') + ' FROM orders').all();
  db.close();

  const norm = (base) => ({
    dep: base + '/#/wallet/Recharge',
    wingo: base + '/#/saasLottery/WinGo?gameCode=WinGo_30S&lottery=WinGo'
  });

  for (const r of rows) {
    if (r.firebase_path) map.set(String(r.firebase_path).toLowerCase().trim(),
      { reg: r.register_url, dep: r.deposit_url, wingo: r.wingo_url, src: `order#${r.id}` });
    if (r.fake_firebase_path && r.fake_register_url) {
      const m = String(r.fake_register_url).match(/^(https?:\/\/[^/]+)/);
      const base = m ? m[1] : String(r.fake_register_url).split('#')[0].replace(/\/+$/, '');
      const nu = norm(base);
      map.set(String(r.fake_firebase_path).toLowerCase().trim(),
        { reg: r.fake_register_url, dep: nu.dep, wingo: nu.wingo, src: `order#${r.id} (fake)` });
    }
  }
  return map;
}

function collectGoavideo(obj, pathP, out) {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) collectGoavideo(obj[k], pathP + '/' + k, out);
  } else if (typeof obj === 'string' && obj.toLowerCase().includes('goavideo')) {
    out.push(pathP);
  }
}

(async () => {
  const map = loadOrders();
  console.log(`[info] DB se ${map.size} path ka original link mila.\n`);

  const tree = await httpJson('GET', '/');
  const mentions = [];
  collectGoavideo(tree, '', mentions);
  console.log(`[info] Firebase me goavideo ${mentions.length} jagah hai.\n`);

  // Panel-wise group
  const panels = new Map(); // top -> {config: bool, junk: []}
  for (const p of mentions) {
    const parts = p.split('/').filter(Boolean);
    const top = parts[0];
    if (!panels.has(top)) panels.set(top, { config: false, junk: [] });
    if (parts[1] === 'config' && ['registerUrl', 'regLink', 'rechargeUrl', 'depositUrl', 'wingoUrl', 'register_Url'].includes(parts[2])) {
      panels.get(top).config = true;
    } else {
      panels.get(top).junk.push(p);
    }
  }

  let restored = 0, skipped = 0;
  const unknown = [];
  for (const [top, info] of panels) {
    const rec = map.get(top.toLowerCase());
    if (!rec) { unknown.push(top); continue; }
    const body = { registerUrl: rec.reg, depositUrl: rec.dep, wingoUrl: rec.wingo, linkUpdatedAt: Date.now() };
    if (DRY) {
      console.log(`[dry-run] WOULD restore ${top} → ${rec.reg.slice(0, 70)} (${rec.src})`);
      restored++;
    } else {
      try {
        await httpJson('PATCH', '/' + top + '/config', body);
        console.log(`✅ ${top} → ${rec.reg.slice(0, 70)} (${rec.src})`);
        restored++;
      } catch (e) {
        console.log(`❌ ${top}: ${e.message}`);
        skipped++;
      }
    }
    // Junk nodes bhi saaf karo
    for (const j of info.junk) {
      if (DRY) { console.log(`[dry-run] WOULD delete junk ${j}`); continue; }
      if (!CLEAN_JUNK) { console.log(`[skip] junk ${j} (--clean-junk se delete hoga)`); continue; }
      try { await httpJson('DELETE', '/' + j); console.log(`🧹 deleted ${j}`); }
      catch (e) { console.log(`❌ delete ${j}: ${e.message}`); }
    }
  }

  console.log(`\n[done] restored=${restored} fail=${skipped} unknown=${unknown.length}`);
  if (unknown.length) {
    console.log('\n⚠️  IN PANELS KE ORIGINALS DB ME NAHI MILE (deleted orders ya dusre sellers):');
    for (const u of unknown) console.log('   -', u);
    console.log('   → Inke original invite codes sirf unke owner ke paas hain.');
    console.log('     Aap inhe admin panel (Firebase Manager) se manually theek kar sakte ho,');
    console.log('     ya owner ko bol do. Goavideo hack hata kar domain-level restore chahiye to');
    console.log('     mujhe batana — main domain guess karke bhi set kar sakta hoon.');
  }
})();
