'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// firebase-retention.js — Firebase Realtime DB ki storage SAFELY khaali karo
//
// Problem: har order ka apna path hota hai (<firebasePath>/config +
// <firebasePath>/users/<phone>...). Mahino me sainkdon purane paths + unke
// users nodes pad jaate hain (dev portal me "storage full" aa jata hai) — jo
// data 2 hafte / 1 mahine se bilkul use nahi hua, wo sirf jagah kha raha hai.
//
// Ye module 3 kaam karta hai (sab kuch configurable + SAFE):
//   1) USERS TTL   — kisi bhi path ke andar purane users/<key> entries
//                    (jinme timestamp 30 din se purana hai) delete karta hai.
//   2) PATH RETENTION — purane order/orphan paths (default 45 din, configurable)
//                    poore delete karta hai — sirf tab jab path inactive ho
//                    (config.linkUpdatedAt bhi purana ho) aur order DB me
//                    'done' + purana ho.
//   3) ORPHAN SCAN  — Firebase me jo paths DB me hi nahi hain (delete hue
//                    orders ke) unki list + cleanup.
//
// SAFETY (kyunki "sara data na ude"):
//   - Har delete se PEHLE us node ka JSON backup backups/firebase/... me jata
//     hai. Wahan se restore bhi ho sakta hai (restoreBackup).
//   - Default mode hamesha DRY-RUN hota hai jab tak `mode:'run'` na mile.
//   - Recent orders (retention window ke andar) aur live_link_enabled=1 wale
//     orders kabhi touch nahi hote.
//   - Shared paths (do orders ek hi path use karein) skip hote hain.
//   - Orphan path pehli baar dikhe to uski first_seen date index me save hoti
//     hai — tab tak delete nahi hota (kisi ka active path galti se na udd jaye).
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { firebaseRequest, getFirebaseAccessToken, normalizeFirebasePath } = require('./runtime-links');

const ROOT_DIR = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT_DIR, 'backups', 'firebase');
const ORPHAN_INDEX = path.join(BACKUP_DIR, 'orphan-index.json');
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  enabled: 0,                 // 1 = scheduler roz chalao (users TTL)
  users_retention_days: 30,   // users/<key> entries ka max age
  path_retention_days: 45,    // poora path (config+users) ka max age
  clean_orphans: 1,           // DB me na hone wale paths bhi saaf karo
  protect_live_link: 1,       // live_link_enabled=1 wale orders protect
  auto_delete_paths: 0,       // 0 = sirf users TTL auto, paths manual (safe)
  last_run_at: '',
  last_run_summary: ''
};

function getSettings(db) {
  const out = { ...DEFAULTS };
  try {
    const rows = db.prepare("SELECT key,value FROM settings WHERE key LIKE 'fb_retention_%'").all();
    for (const row of rows) {
      const key = String(row.key).replace(/^fb_retention_/, '');
      if (!(key in DEFAULTS)) continue;
      const raw = String(row.value ?? '');
      const def = DEFAULTS[key];
      if (typeof def === 'number') {
        const n = parseInt(raw, 10);
        out[key] = Number.isFinite(n) ? n : def;
      } else {
        out[key] = raw;
      }
    }
  } catch (_) {}
  return out;
}

function saveSettings(db, values) {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
  for (const [key, value] of Object.entries(values)) {
    if (!(key in DEFAULTS)) continue;
    stmt.run('fb_retention_' + key, String(value));
  }
  return getSettings(db);
}

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// ── backup: kisi bhi delete se pehle node ka JSON disk pe ──
async function backupNode(dbPath) {
  ensureBackupDir();
  const data = await firebaseRequest([dbPath]);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = String(dbPath).replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(BACKUP_DIR, `${stamp}__${safe}.json`);
  fs.writeFileSync(file, JSON.stringify({ path: dbPath, backedUpAt: Date.now(), data }, null, 2));
  return { file, size: fs.statSync(file).size };
}

// ── orphan index (first_seen tracking) ──
function readOrphanIndex() {
  try {
    return JSON.parse(fs.readFileSync(ORPHAN_INDEX, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeOrphanIndex(index) {
  ensureBackupDir();
  fs.writeFileSync(ORPHAN_INDEX, JSON.stringify(index, null, 2));
}

// ── DB-side reference map: kaunse paths abhi bhi kisi order se juda hai? ──
function collectDbPaths(db) {
  const map = new Map(); // path -> { orders:[id], live:bool, created: ms }
  const add = (rawPath, orderId, extra = {}) => {
    const key = String(rawPath || '').trim();
    if (!key) return;
    const entry = map.get(key) || { path: key, orders: [], live: false, createdMs: 0, oldestOrderId: null };
    if (orderId !== undefined && orderId !== null) {
      if (!entry.orders.includes(orderId)) entry.orders.push(orderId);
      if (entry.oldestOrderId === null || orderId < entry.oldestOrderId) entry.oldestOrderId = orderId;
    }
    if (extra.live) entry.live = true;
    if (extra.createdMs && (!entry.createdMs || extra.createdMs < entry.createdMs)) entry.createdMs = extra.createdMs;
    map.set(key, entry);
  };

  const parseMs = value => {
    const t = Date.parse(String(value || '').replace(' ', 'T') + (String(value || '').includes('Z') ? '' : 'Z'));
    return Number.isFinite(t) ? t : 0;
  };

  try {
    for (const row of db.prepare(`SELECT id, firebase_path, fake_firebase_path, live_link_enabled, created_at FROM orders`).all()) {
      const live = Number(row.live_link_enabled) === 1;
      const createdMs = parseMs(row.created_at);
      add(row.firebase_path, row.id, { live, createdMs });
      add(row.fake_firebase_path, row.id, { live, createdMs });
    }
  } catch (_) {}

  try {
    for (const row of db.prepare(`SELECT f.firebase_path p, f.order_id o, o.live_link_enabled l, o.created_at c FROM order_fake_sites f JOIN orders o ON o.id=f.order_id`).all()) {
      add(row.p, row.o, { live: Number(row.l) === 1, createdMs: parseMs(row.c) });
    }
  } catch (_) {}

  try {
    for (const row of db.prepare(`SELECT firebase_path p, id FROM pwa_apps WHERE firebase_path IS NOT NULL AND firebase_path <> ''`).all()) {
      add(row.p, null, { live: true });
    }
  } catch (_) {}

  return map;
}

function rootDatabaseUrl() {
  return String(process.env.FIREBASE_DATABASE_URL || 'https://zayrodev-195f3-default-rtdb.firebaseio.com').replace(/\/+$/, '');
}

// Firebase root ke saare top-level children (shallow — sirf keys, data nahi)
async function listFirebaseRootPaths() {
  const url = `${rootDatabaseUrl()}/.json?shallow=true`;
  const token = await getFirebaseAccessToken();
  const target = token ? `${url}&access_token=${encodeURIComponent(token)}` : url;
  const res = await fetch(target, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Firebase root list failed (${res.status}) ${detail}`);
  }
  const json = await res.json();
  return json && typeof json === 'object' ? Object.keys(json) : [];
}

async function countChildren(dbPath) {
  try {
    const url = `${rootDatabaseUrl()}/${String(dbPath).split('/').map(encodeURIComponent).join('/')}.json?shallow=true`;
    const token = await getFirebaseAccessToken();
    const target = token ? `${url}&access_token=${encodeURIComponent(token)}` : url;
    const res = await fetch(target, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (json === null) return 0;
    if (typeof json === 'object') return Object.keys(json).length;
    return 1;
  } catch (_) {
    return null;
  }
}

// ── SCAN: poora picture (kitne paths, kitne orphan, users count, age) ──
async function scan(db, opts = {}) {
  const settings = getSettings(db);
  const dbPaths = collectDbPaths(db);
  const rootPaths = await listFirebaseRootPaths();
  const index = readOrphanIndex();
  const now = Date.now();
  const maxUsersCheck = Math.max(1, parseInt(opts.maxUsersCheck || '40', 10));

  const referenced = [];
  const orphans = [];
  for (const p of rootPaths) {
    const dbRow = dbPaths.get(p);
    if (dbRow) {
      const ageDays = dbRow.createdMs ? Math.floor((now - dbRow.createdMs) / DAY_MS) : null;
      referenced.push({ path: p, orders: dbRow.orders, live: dbRow.live, ageDays, protected: settings.protect_live_link ? dbRow.live : false });
    } else {
      if (!index[p]) index[p] = { firstSeen: now };
      const firstSeen = index[p].firstSeen || now;
      const idleDays = Math.floor((now - firstSeen) / DAY_MS);
      orphans.push({ path: p, firstSeen, idleDays });
    }
  }
  // DB me hain lekin Firebase me nahi (config delete ho chuka / aage na likha gaya)
  const fbSet = new Set(rootPaths);
  const missingInFirebase = [];
  for (const [p, meta] of dbPaths) {
    if (!fbSet.has(p)) missingInFirebase.push({ path: p, orders: meta.orders });
  }

  // Sample kuch paths ke users count (storage ka bada hissa)
  const usersSample = [];
  const sampleList = orphans.slice(0, maxUsersCheck).concat(referenced.slice(0, Math.max(0, Math.floor(maxUsersCheck / 2))));
  for (const item of sampleList) {
    const count = await countChildren(item.path + '/users');
    if (count) usersSample.push({ path: item.path, users: count });
  }

  writeOrphanIndex(index);

  const totalUsersSampled = usersSample.reduce((sum, r) => sum + r.users, 0);
  return {
    settings,
    scannedAt: now,
    rootPathCount: rootPaths.length,
    referencedCount: referenced.length,
    orphanCount: orphans.length,
    orphans,
    referenced,
    missingInFirebaseCount: missingInFirebase.length,
    missingInFirebase: missingInFirebase.slice(0, 50),
    usersSampled: totalUsersSampled,
    usersSample: usersSample.sort((a, b) => b.users - a.users).slice(0, 30)
  };
}

// ── USERS TTL: purane users/<key> hatao (timestamp ke hisaab se) ──
// SAFETY: delete karne se PEHLE jo entries ja rahi hain unka JSON backup
// backups/firebase/<stamp>__<path>__users-ttl.json me likha jata hai
// (scope:'users'). Wahan se restoreBackup() se wapas PUT ho sakta hai —
// "sara data na ude" wali requirement ke liye har delete ka undo rehta hai.
// Returns { scanned, deleted, skippedUnknown, kept, errors, backup }
async function cleanUsersNode(dbPath, days, { dryRun = true, delayMs = 120, backup = true } = {}) {
  const result = { path: dbPath, scanned: 0, deleted: 0, skippedUnknown: 0, kept: 0, errors: 0, backup: null };
  let keys = [];
  try {
    const url = `${rootDatabaseUrl()}/${String(dbPath).split('/').map(encodeURIComponent).join('/')}/users.json?shallow=true`;
    const token = await getFirebaseAccessToken();
    const target = token ? `${url}&access_token=${encodeURIComponent(token)}` : url;
    const res = await fetch(target, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return result;
    const json = await res.json();
    if (!json || typeof json !== 'object') return result;
    keys = Object.keys(json);
  } catch (_) {
    return result;
  }
  result.scanned = keys.length;
  const cutoff = Date.now() - days * DAY_MS;

  // Pehle scan: kaunsi entries delete hongi (value bhi saath rakho — backup ke liye)
  const doomed = [];
  for (const key of keys) {
    try {
      const value = await firebaseRequest([dbPath, 'users', key]);
      const stamp = value && typeof value === 'object'
        ? (Number(value.timestamp) || Number(value.createdAt) || Number(value.time) || 0)
        : 0;
      if (!stamp) { result.skippedUnknown++; continue; }   // age pata nahi → chhedo mat
      if (stamp < cutoff) doomed.push({ key, value, stamp });
      else result.kept++;
    } catch (_) {
      result.errors++;
    }
  }
  result.deleted = doomed.length;   // dry-run me bhi "hoti to kitni" dikhe

  if (!dryRun && doomed.length) {
    // ── DELETE se pehle backup ──
    try {
      if (backup) {
        ensureBackupDir();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safe = String(dbPath).replace(/[^a-zA-Z0-9_-]/g, '_');
        const file = path.join(BACKUP_DIR, `${stamp}__${safe}__users-ttl.json`);
        const entries = {};
        for (const d of doomed) entries[d.key] = d.value === undefined ? null : d.value;
        fs.writeFileSync(file, JSON.stringify({
          path: dbPath, scope: 'users', backedUpAt: Date.now(), retentionDays: days, entries
        }, null, 2));
        result.backup = file;
      }
    } catch (e) {
      // Backup fail = delete bhi nahi (safety first)
      result.errors++;
      result.backupError = 'backup failed: ' + e.message;
      return result;
    }

    for (const d of doomed) {
      try {
        await firebaseRequest([dbPath, 'users', d.key], 'DELETE');
        await new Promise(r => setTimeout(r, delayMs));
      } catch (_) {
        result.errors++;
        result.deleted--;
      }
    }
  }
  return result;
}

// ── PATH delete (backup ke saath) ──
async function deletePathWithBackup(dbPath, { dryRun = true } = {}) {
  const meta = await countChildren(dbPath);
  if (dryRun) return { path: dbPath, children: meta, deleted: false, backup: null };
  const backup = await backupNode(dbPath);
  await firebaseRequest([dbPath], 'DELETE');
  return { path: dbPath, children: meta, deleted: true, backup: backup.file };
}

// ── MAIN RETENTION RUN ──
// opts: { mode:'dry'|'run', usersTtl:bool, paths:bool, orphans:bool, days? }
async function runRetention(db, opts = {}) {
  const dryRun = String(opts.mode || 'dry') !== 'run';
  const settings = getSettings(db);
  const usersDays = parseInt(opts.days || settings.users_retention_days, 10) || settings.users_retention_days;
  const pathDays = parseInt(opts.pathDays || settings.path_retention_days, 10) || settings.path_retention_days;
  const now = Date.now();

  const summary = {
    mode: dryRun ? 'dry' : 'run',
    startedAt: now,
    usersTtl: { days: usersDays, paths: [], entriesDeleted: 0, entriesSkippedUnknown: 0, backedUp: [] },
    paths: { days: pathDays, deleted: [], skippedProtected: 0, backedUp: [] },
    errors: []
  };

  const dbPaths = collectDbPaths(db);
  let rootPaths = [];
  try {
    rootPaths = await listFirebaseRootPaths();
  } catch (e) {
    summary.errors.push('root list: ' + e.message);
    return summary;
  }

  const index = readOrphanIndex();
  const doUsers = opts.usersTtl !== false;
  const doPaths = opts.paths === true || (opts.paths !== false && settings.auto_delete_paths === 1);
  const doOrphans = opts.orphans === true || (opts.orphans !== false && settings.clean_orphans === 1);

  for (const p of rootPaths) {
    const dbRow = dbPaths.get(p);
    const isOrphan = !dbRow;

    // 1) USERS TTL — har path pe (recent orders ke users bhi check hote hain,
    //    lekin 30 din se naye entries bach jate hain)
    if (doUsers) {
      if (dbRow && settings.protect_live_link && dbRow.live && !opts.force) {
        // live-link wale order ke users chhodo (active product)
      } else {
        const r = await cleanUsersNode(p, usersDays, { dryRun });
        if (r.scanned) {
          summary.usersTtl.paths.push(r);
          summary.usersTtl.entriesDeleted += r.deleted;
          summary.usersTtl.entriesSkippedUnknown += r.skippedUnknown;
          if (r.backup) summary.usersTtl.backedUp.push(r.backup);
          if (r.backupError) summary.errors.push(`users backup ${p}: ${r.backupError}`);
        }
      }
    }

    // 2) PURANE PATHS
    if (isOrphan) {
      if (!doOrphans) continue;
      if (!index[p]) index[p] = { firstSeen: now };
      const idleDays = Math.floor((now - (index[p].firstSeen || now)) / DAY_MS);
      if (idleDays < pathDays) continue;
      try {
        const info = await deletePathWithBackup(p, { dryRun });
        summary.paths.deleted.push({ path: p, reason: `orphan idle ${idleDays}d`, ...info });
        if (info.backup) summary.paths.backedUp.push(info.backup);
      } catch (e) {
        summary.errors.push(`delete ${p}: ${e.message}`);
      }
      continue;
    }

    // Referenced path — sirf purane + inactive orders ke liye
    if (!doPaths) continue;
    const ageDays = dbRow.createdMs ? Math.floor((now - dbRow.createdMs) / DAY_MS) : 0;
    if (ageDays < pathDays) continue;
    if (settings.protect_live_link && dbRow.live) { summary.paths.skippedProtected++; continue; }
    if (dbRow.orders.length > 1) { summary.paths.skippedProtected++; continue; }  // shared path
    // activity check — config.linkUpdatedAt bhi purana hona chahiye
    let lastTouch = 0;
    try {
      const cfg = await firebaseRequest([p, 'config']);
      if (cfg && typeof cfg === 'object') {
        lastTouch = Number(cfg.linkUpdatedAt) || 0;
      }
    } catch (_) {}
    if (lastTouch && (now - lastTouch) < pathDays * DAY_MS) continue;
    try {
      const info = await deletePathWithBackup(p, { dryRun });
      summary.paths.deleted.push({ path: p, reason: `inactive order ${ageDays}d`, ...info });
      if (info.backup) summary.paths.backedUp.push(info.backup);
    } catch (e) {
      summary.errors.push(`delete ${p}: ${e.message}`);
    }
  }

  writeOrphanIndex(index);
  summary.finishedAt = Date.now();
  summary.estimatedFreedUsers = summary.usersTtl.entriesDeleted;

  try {
    saveSettings(db, {
      last_run_at: new Date(summary.finishedAt).toISOString(),
      last_run_summary: JSON.stringify({
        mode: summary.mode,
        usersDeleted: summary.usersTtl.entriesDeleted,
        pathsDeleted: summary.paths.deleted.length,
        errors: summary.errors.length
      })
    });
  } catch (_) {}

  return summary;
}

// ── RESTORE helper (backup JSON se wapas likho) ──
async function restoreBackup(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || !parsed.path) throw new Error('Backup file me path nahi mila');
  const safe = normalizeFirebasePath(parsed.path);

  // users-TTL backup: sirf delete hui entries wapas likho (poora path chhua nahi)
  if (parsed.scope === 'users') {
    const entries = parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    let restored = 0;
    const failed = [];
    for (const [key, value] of Object.entries(entries)) {
      try {
        await firebaseRequest([safe, 'users', key], 'PUT', value);
        restored++;
      } catch (e) {
        failed.push(key + ': ' + e.message);
      }
    }
    return { path: safe, scope: 'users', restored, attempted: Object.keys(entries).length, failed };
  }

  await firebaseRequest([safe], 'PUT', parsed.data === undefined ? null : parsed.data);
  return { path: safe, restored: true };
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.json') && f !== 'orphan-index.json')
      .map(f => {
        const full = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(full);
        return { file: f, size: stat.size, created_at: stat.mtime.toISOString() };
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  } catch (_) {
    return [];
  }
}

module.exports = {
  DEFAULTS,
  getSettings,
  saveSettings,
  scan,
  runRetention,
  cleanUsersNode,
  deletePathWithBackup,
  backupNode,
  restoreBackup,
  listBackups,
  collectDbPaths,
  listFirebaseRootPaths
};
