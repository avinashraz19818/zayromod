#!/usr/bin/env node
'use strict';

/**
 * cleanup-rebuild-folders.js
 * ─────────────────────────────────────────────────────────────────────────
 * Har order ke PURANE build folders saaf karta hai — sirf sabse NAYA
 * folder rakhta hai (real APK wala + fake APK wala). Rebuild se pehle
 * wale saare build_<id>_* folders isse hat jate hain.
 *
 * Naye code me rebuild ke time auto-clean ho jata hai — ye script sirf
 * PURANE accumulated folders ki ek-baar ki safai ke liye hai (chahe to
 * kabhi bhi chala sakte ho, safe hai).
 *
 * Usage (VPS, project folder se):
 *   node scripts/cleanup-rebuild-folders.js            → real delete
 *   node scripts/cleanup-rebuild-folders.js --dry-run  → sirf list dikhata hai
 *
 * ⚠️ Script chalate waqt koi build RUN na ho raha ho (status 'building'
 *    wale orders) — warna wo bhi saaf ho jayega.
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..');
const DB = require(path.join(ROOT, 'database', 'db'));
const buildsDir = path.join(ROOT, 'builds');

// ── Orders DB se (real + fake APK file names) ──
const orders = {};
for (const r of DB.prepare('SELECT id, apk_file, fake_apk_file, status FROM orders').all()) {
  orders[String(r.id)] = r;
}
// Extra fake sites ke APK bhi protect karo (multiple fake APKs)
const fakeSiteApks = {};
try {
  for (const r of DB.prepare('SELECT order_id, apk_file FROM order_fake_sites WHERE apk_file IS NOT NULL').all()) {
    (fakeSiteApks[String(r.order_id)] = fakeSiteApks[String(r.order_id)] || []).push(r.apk_file);
  }
} catch (e) {
  // order_fake_sites table abhi nahi hai (server restart nahi hua) — skip
}

// ── Folder ka timestamp: naam me aakhri 13-digit number, warna mtime ──
function dirTs(dir) {
  const m = dir.match(/(\d{13})/g);
  if (m && m.length) return parseInt(m[m.length - 1], 10);
  try { return fs.statSync(path.join(buildsDir, dir)).mtimeMs; } catch (_) { return 0; }
}

const dirs = fs.readdirSync(buildsDir).filter(d => {
  try { return fs.statSync(path.join(buildsDir, d)).isDirectory(); } catch (_) { return false; }
});

// build_<id>_ se group karo (order id wale + orphan)
const groups = {};
for (const d of dirs) {
  const m = d.match(/^build_(\d+)_/);
  const key = m ? m[1] : '__none__';
  (groups[key] = groups[key] || []).push(d);
}

let removed = 0;
let kept = 0;
const report = (d, action) => {
  if (action === 'keep') { kept++; return; }
  if (DRY_RUN) { console.log('[dry-run] DELETE ' + d); removed++; }
  else {
    try { fs.rmSync(path.join(buildsDir, d), { recursive: true, force: true }); console.log('DELETED ' + d); removed++; }
    catch (e) { console.error('FAIL ' + d + ' — ' + e.message); }
  }
};

for (const [key, list] of Object.entries(groups)) {
  const o = orders[key];
  // Orphan ya DB me nahi → sab delete
  if (!o) { list.forEach(d => report(d, 'delete')); continue; }

  const contains = (d, name) => {
    try { return fs.readdirSync(path.join(buildsDir, d)).includes(name); } catch (_) { return false; }
  };
  const sorted = [...list].sort((a, b) => dirTs(b) - dirTs(a)); // naya pehle
  const keep = new Set();

  // Sabse naya folder hamesha rakho (safety — abhi build chal raha ho
  // ya status building ho to wo safe rehta hai)
  if (sorted.length) keep.add(sorted[0]);
  // Real APK wala sabse naya folder
  if (o.apk_file) {
    const d = sorted.find(x => contains(x, o.apk_file));
    if (d) keep.add(d);
  }
  // Fake APK wala sabse naya folder
  if (o.fake_apk_file) {
    const d = sorted.find(x => contains(x, o.fake_apk_file));
    if (d) keep.add(d);
  }
  // Extra fake sites ke APK wale folders
  for (const apkName of (fakeSiteApks[key] || [])) {
    const d = sorted.find(x => contains(x, apkName));
    if (d) keep.add(d);
  }

  for (const d of list) {
    if (keep.has(d)) report(d, 'keep');
    else report(d, 'delete');
  }
}

console.log('');
console.log(DRY_RUN
  ? `═══ DRY-RUN: ${removed} folders delete honge, ${kept} rahenge ═══`
  : `✅ Done — ${removed} purane build folders delete, ${kept} rakhe gaye.`);
if (DRY_RUN) console.log('Sab sahi laga to bina --dry-run ke chalao.');
