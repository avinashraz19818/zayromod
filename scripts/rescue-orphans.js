#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// rescue-orphans.js — mare hue (deleted/orphan) content-paths wale purane
// installed APKs ko zinda order se alias jodta hai.
//
//   node scripts/rescue-orphans.js
//
// Kaam: pm2 error-log se har "[content] ... MISS path=X" nikaalta hai, X ke
// base path (tilde se pehle) ko DB me dhoondhta hai; zinda order na mile to
// same-prefix ka sabse naya done order alias se jod deta hai. Isse purana
// installed APK bina reinstall ke wapas chalne lagta hai.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const db = require(path.join(__dirname, '..', 'database', 'db'));

const logFile = '/root/.pm2/logs/apkbuilder-error.log';
const txt = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
const paths = new Set();
for (const m of txt.matchAll(/\[content\] (?:popup|loading)[^\n]*?path=([a-zA-Z0-9_~.-]+)/g)) {
  if (/MISS/.test(m[0])) paths.add(m[1]);
}
console.log('log me marked paths mile:', paths.size);
if (!paths.size) console.log('(kuch nahi — MISS logs khali hain. Sab chal raha hai ya logs flush ho gaye.)');
let made = 0;
for (const raw of [...paths].sort()) {
  const p = raw.split('~')[0].toLowerCase();
  if (db.prepare('SELECT 1 FROM orders WHERE lower(firebase_path)=? OR lower(fake_firebase_path)=?').get(p, p)) {
    console.log('skip (zinda order hai):', p); continue;
  }
  if (db.prepare('SELECT 1 FROM content_path_aliases WHERE lower(path)=?').get(p)) {
    console.log('skip (alias pehle se):', p); continue;
  }
  const prefix = p.replace(/\d+$/, '');
  const cand = db.prepare(
    "SELECT id, app_name FROM orders WHERE status='done' AND (lower(firebase_path) LIKE ? OR lower(fake_firebase_path) LIKE ?) ORDER BY id DESC LIMIT 1"
  ).get(prefix + '%', prefix + '%');
  if (!cand) { console.log('!! candidate nahi mila:', p, '→ is client ko NAYA APK dena padega'); continue; }
  db.prepare('INSERT OR REPLACE INTO content_path_aliases(path, order_id) VALUES(?,?)').run(p, cand.id);
  console.log(`ALIAS: ${p} -> order #${cand.id} (${cand.app_name})`);
  made++;
}
console.log(made ? made + ' orphan rescue ho gaye. Phone pe APK khol ke test karo.' : 'koi naya alias nahi bana.');
