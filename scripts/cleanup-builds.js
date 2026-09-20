#!/usr/bin/env node
'use strict';

/**
 * cleanup-builds.js
 * ─────────────────────────────────────────────────────────────────────────
 * Builds folder ki safai:
 *   - Database (orders table) me jo apk_file / fake_apk_file names hain,
 *     un wale build folders RAKHTA hai.
 *   - Baaki sab folders DELETE karta hai (purane orders ke, sirf .idsig
 *     bache hue, ya test builds).
 *
 * Usage:
 *   node scripts/cleanup-builds.js            → real delete
 *   node scripts/cleanup-builds.js --dry-run  → sirf list dikhata hai
 *
 * VPS pe ye app ke folder (cd /var/www/apkbuilder) se chalana hai.
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..');
const BUILDS_DIR = path.join(ROOT, 'builds');
const DB_PATH = path.join(ROOT, 'database', 'apkbuilder.db');

function loadValidApkNames() {
  // DB ho to orders se valid APK names nikalte hain.
  // Native module (better-sqlite3) kisi system pe load hone me crash kar
  // sakta hai, isliye DB read ek CHILD process me karte hain — pehle
  // better-sqlite3 try, phir python3 fallback. Dono fail → warn mode.
  const names = new Set();
  const { execFileSync } = require('child_process');
  let source = null;

  if (fs.existsSync(DB_PATH)) {
    // 1) better-sqlite3 via child node
    try {
      const childJs = [
        "const Database = require(" + JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3')) + ");",
        "const db = new Database(" + JSON.stringify(DB_PATH) + ", { readonly: true });",
        "for (const r of db.prepare('SELECT apk_file, fake_apk_file FROM orders').all()) {",
        "  if (r.apk_file) console.log('A:' + r.apk_file);",
        "  if (r.fake_apk_file) console.log('A:' + r.fake_apk_file);",
        "}",
        "db.close();",
      ].join('\n');
      const out = execFileSync(process.execPath, ['-e', childJs], { encoding: 'utf8', timeout: 20000 });
      for (const line of out.split('\n')) {
        if (line.startsWith('A:')) names.add(line.slice(2).trim());
      }
      source = 'better-sqlite3';
    } catch (e) {
      // child crash hua — python3 try karo
    }

    // 2) python3 fallback
    if (source === null) {
      try {
        const py = [
          'import sqlite3',
          'db = sqlite3.connect(' + JSON.stringify(DB_PATH) + ')',
          'cur = db.cursor()',
          "cur.execute('SELECT apk_file, fake_apk_file FROM orders')",
          'for r in cur.fetchall():',
          '    for v in r:',
          '        if v: print(v)',
        ].join('\n');
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8', timeout: 20000 });
        for (const line of out.split('\n')) {
          const v = line.trim();
          if (v) names.add(v);
        }
        source = 'python3';
      } catch (e) {
        // dono fail
      }
    }
  }

  if (source) {
    console.log(`[info] Database se ${names.size} valid APK names mile (${source}).`);
  } else {
    console.log('[warn] Database read nahi ho paya — sirf khali/idsig-only folders saaf honge.');
  }
  return names;
}

function main() {
  if (!fs.existsSync(BUILDS_DIR)) {
    console.log('[info] builds/ folder nahi mila.');
    return;
  }

  const valid = loadValidApkNames();
  const dbOk = valid.size > 0;
  if (!dbOk) {
    console.log('[warn] Valid list khali hai — SAFE MODE: sirf khali/idsig-only folders saaf honge, APK wale folders ko haath nahi lagayenge.');
  }

  let kept = 0, removed = 0;
  const removeList = [];
  const keepList = [];

  for (const dir of fs.readdirSync(BUILDS_DIR)) {
    const dirPath = path.join(BUILDS_DIR, dir);
    let stat;
    try { stat = fs.statSync(dirPath); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;

    let files = [];
    try { files = fs.readdirSync(dirPath); } catch (_) { continue; }

    const apks = files.filter(f => f.toLowerCase().endsWith('.apk'));
    const hasValid = apks.some(f => valid.has(f));

    if (hasValid) {
      keepList.push(dir);
      kept++;
    } else if (dbOk) {
      // DB mila hai aur ye folder kisi order me nahi — delete
      removeList.push(dirPath);
    } else {
      // SAFE MODE: sirf khali ya idsig-only folders delete karo
      const junkOnly = files.every(f => f.toLowerCase().endsWith('.idsig'));
      if (files.length === 0 || junkOnly) {
        removeList.push(dirPath);
      } else {
        keepList.push(dir + '  [safe-mode: APK hai, chhoda]');
        kept++;
      }
    }
  }

  console.log(`\nKEEP (${keepList.length}) — orders me hain:`);
  keepList.forEach(d => console.log('   ✅', d));

  console.log(`\nDELETE (${removeList.length}) — kisi order me nahi:`);
  removeList.forEach(d => console.log('   ❌', path.basename(d)));

  if (DRY_RUN) {
    console.log(`\n[DRY-RUN] Total delete hone wale folders: ${removeList.length}. (koi delete nahi hua — --dry-run)`);
    return;
  }

  for (const p of removeList) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
      console.log('   deleted:', path.basename(p));
    } catch (e) {
      console.log('   FAILED:', path.basename(p), '-', e.message);
    }
  }
  console.log(`\n[done] ${removed} folders delete, ${kept} folders rakh diye.`);
}

main();
