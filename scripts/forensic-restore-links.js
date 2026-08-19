#!/usr/bin/env node
'use strict';

/**
 * forensic-restore-links.js — VPS ke builds folder ke APKs se ORIGINAL links khod
 * kar nikalta hai (legacy APKs me register URL embedded hota hai, fixed
 * password zayroavi@132 se decrypt hota hai) aur Firebase ke goavideo wale
 * panels ko wapas original pe le aata hai.
 *
 * Usage (VPS pe, project folder se):
 *   node scripts/forensic-restore-links.js             → scan + restore
 *   node scripts/forensic-restore-links.js --dry-run   → sirf report
 *
 * Kya karta hai:
 *   1. builds/ me har .apk ke assets (wingss.bin / zayro.bin / loading.bin /
 *      lodale.bin) nikal kar zayroavi@132 se decrypt karta hai
 *   2. HTML me se firebase path (rtdb.ref("xyz/...")) aur register/deposit/
 *      wingo URLs nikalta hai
 *   3. Firebase me jahan-jahan goavideo hai, agar uska original APK scan me
 *      mila to PATCH kar deta hai
 *   4. Jo phir bhi na mile unki list + unke APK file names report me
 *
 * Security-era APKs (per-build key wale) decrypt nahi honge — unka original
 * sirf owner ke paas hai.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const DRY = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..');
const BUILDS = path.join(ROOT, 'builds');
const FB_URL = (process.env.FIREBASE_DATABASE_URL || 'https://zayrodev-195f3-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const PASSWORDS = ['zayroavi@132']; // legacy fixed keys (aur ho to add karo)
const MK = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE]);

function decryptBin(buf, pw) {
  for (let mp = 0; mp <= buf.length - 8; mp++) {
    let ok = true;
    for (let j = 0; j < 8; j++) if (buf[mp + j] !== MK[j]) { ok = false; break; }
    if (!ok) continue;
    const salt = buf.slice(mp + 8, mp + 24);
    const iv = buf.slice(mp + 24, mp + 40);
    const enc = buf.slice(mp + 40, buf.length - 64);
    const kb = crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256');
    try {
      const d = crypto.createDecipheriv('aes-256-cbc', kb, iv);
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    } catch (e) { return null; }
  }
  return null;
}

function httpJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    const req = https.request(FB_URL + urlPath + '.json', opts, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(b ? JSON.parse(b) : null); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function collectGoavideo(obj, pathP, out) {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) collectGoavideo(obj[k], pathP + '/' + k, out);
  } else if (typeof obj === 'string' && obj.toLowerCase().includes('goavideo')) {
    out.push(pathP);
  }
}

function scanApks() {
  const map = new Map(); // fbPath → {reg, dep, wingo, apk}
  if (!fs.existsSync(BUILDS)) return map;
  const apks = [];
  for (const d of fs.readdirSync(BUILDS)) {
    const dp = path.join(BUILDS, d);
    if (!fs.statSync(dp).isDirectory()) continue;
    for (const f of fs.readdirSync(dp)) {
      if (f.toLowerCase().endsWith('.apk')) apks.push({ dir: d, file: f, p: path.join(dp, f) });
    }
  }
  console.log(`[info] Scanning ${apks.length} APKs...\n`);
  let scanned = 0, decrypted = 0;
  for (const a of apks) {
    scanned++;
    const ext = '/tmp/fr_extract_' + process.pid;
    fs.rmSync(ext, { recursive: true, force: true });
    try {
      // bin assets nikalo (ek baar per APK)
      execFileSync('unzip', ['-o', '-qq', a.p, 'assets/wingss.bin', 'assets/zayro.bin', 'assets/loading.bin', 'assets/lodale.bin', '-d', ext], { stdio: 'pipe' });
    } catch (e) { /* koi bin nahi */ }
    const binDir = path.join(ext, 'assets');
    if (!fs.existsSync(binDir)) { fs.rmSync(ext, { recursive: true, force: true }); continue; }
    for (const bin of fs.readdirSync(binDir)) {
      if (!bin.endsWith('.bin')) continue;
      const buf = fs.readFileSync(path.join(binDir, bin));
      let html = null;
      for (const pw of PASSWORDS) { html = decryptBin(buf, pw); if (html) break; }
      if (!html) continue;
      decrypted++;
      const m1 = html.match(/rtdb\.ref\s*\(\s*["']([a-zA-Z0-9_]+)\/(?:config|users)/);
      const fbPath = m1 ? m1[1] : null;
      if (!fbPath) continue;
      // register / deposit / wingo URLs
      const urls = new Set();
      const re = /https?:\/\/[^"'\s\\]+/g;
      let m;
      while ((m = re.exec(html))) {
        const u = m[0].replace(/\\/g, '');
        if (/register|invitation|invitecode|invite|wallet|recharge|saaslottery|wingo|lottery/i.test(u)) urls.add(u);
      }
      const reg = [...urls].find(u => /register|invitation|invite/i.test(u)) || null;
      const dep = [...urls].find(u => /wallet|recharge/i.test(u)) || null;
      const wingo = [...urls].find(u => /saaslottery|wingo|lottery/i.test(u)) || null;
      if (reg) {
        map.set(fbPath.toLowerCase(), { reg, dep, wingo, apk: a.file });
      }
    }
    fs.rmSync(ext, { recursive: true, force: true });
  }
  console.log(`[info] Scanned ${scanned} APKs, decrypt hue ${decrypted}, originals mile ${map.size} panels.\n`);
  return map;
}

(async () => {
  const map = scanApks();

  if (DRY) {
    console.log('═══ APK SE MILE ORIGINALS (firebase path → register URL) ═══');
    for (const [p, v] of map) console.log(`  ${p.padEnd(26)} → ${v.reg.slice(0, 75)}  [${v.apk}]`);
    console.log('');
  }

  const tree = await httpJson('GET', '/');
  const mentions = [];
  collectGoavideo(tree, '', mentions);
  const panels = new Set();
  for (const p of mentions) {
    const top = p.split('/').filter(Boolean)[0];
    panels.add(top);
  }
  console.log(`[info] Firebase me goavideo ${panels.size} panels me hai.\n`);

  let restored = 0;
  const stillUnknown = [];
  for (const top of panels) {
    const rec = map.get(top.toLowerCase());
    if (!rec) { stillUnknown.push(top); continue; }
    const body = { registerUrl: rec.reg, linkUpdatedAt: Date.now() };
    if (rec.dep) body.depositUrl = rec.dep;
    if (rec.wingo) body.wingoUrl = rec.wingo;
    if (DRY) {
      console.log(`[dry-run] WOULD restore ${top} → ${rec.reg.slice(0, 75)} (apk: ${rec.apk})`);
      restored++;
    } else {
      try {
        await httpJson('PATCH', '/' + top + '/config', body);
        console.log(`✅ ${top} → ${rec.reg.slice(0, 75)} (apk: ${rec.apk})`);
        restored++;
      } catch (e) {
        console.log(`❌ ${top}: ${e.message}`);
      }
    }
  }

  console.log(`\n[done] restored=${restored} unknown=${stillUnknown.length}`);
  if (stillUnknown.length) {
    console.log('\n⚠️  AB BHI UNKNOWN (na DB me, na legacy APK me mile):');
    for (const u of stillUnknown) console.log('   -', u);
    console.log('   → Ye ya to security-era APK wale hain (per-build key) ya dusre');
    console.log('     sellers ke. Inke original invite codes sirf owner ke paas hain.');
  }
})();
