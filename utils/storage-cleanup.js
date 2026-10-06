'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// storage-cleanup.js — server disk saaf karo (SAFE, verify-first)
//
// Kya-kya saaf hota hai:
//   1) builds/ me ORPHAN folders        — jinke order DB me hi nahi hain
//   2) builds/ me leftover `project/`   — build ke baad delete na hua gradle copy
//   3) builds/ me *.idsig               — v4 signature off hai, ye bekaar hain
//   4) builds/ me PURANI APKs           — per order sirf aaj wali (DB referenced)
//                                         APK rakho, baaki duplicate/stale folders
//                                         hata do (default ON)
//   5) builds/ me purane orders ki APKs — apk_retention_days (default 60) se
//                                         purane orders ke artifacts (default OFF,
//                                         admin enable kare tabhi)
//   6) uploads/ me unreferenced files   — kisi design/order/settings/pwa/coin
//                                         request me use nahi ho rahi
//   7) templates/ me unreferenced files — kisi design/settings me use nahi ho rahi
//   8) backups/ me purane DB backups    — sirf latest N rakho
//   9) legacy junk                      — *.before-*, *.backup.*, dead DB shm/wal
//
// Sab kuch DEFAULT DRY-RUN hai. mode:'run' bhejo tabhi delete hota hai.
// Har run ka report return hota hai (kya delete hua / kitna space bacha),
// aur delete hone wali list DB me build log ki tarah kahin nahi — CLI pe
// print hoti hai + backups/cleanup-reports/ me JSON save hoti hai.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { BUILDS_DIR, parseBuildDirName, listBuildDirs } = require('./buildstore');

const ROOT_DIR = path.join(__dirname, '..');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const TEMPLATES_DIR = path.join(ROOT_DIR, 'templates');
const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');
const REPORTS_DIR = path.join(BACKUPS_DIR, 'cleanup-reports');
const DAY_MS = 24 * 60 * 60 * 1000;

function dirSize(dirPath) {
  let total = 0;
  const stack = [dirPath];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try { total += fs.statSync(full).size; } catch (_) {}
      }
    }
  }
  return total;
}

function removeItem(target) {
  try {
    const stat = fs.lstatSync(target);
    const size = stat.isDirectory() ? dirSize(target) : stat.size;
    fs.rmSync(target, { recursive: true, force: true });
    return size;
  } catch (_) {
    return 0;
  }
}

function mb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

// ── DB references ──
function collectReferences(db) {
  const uploads = new Set();
  const templates = new Set();
  const add = (set, value) => { if (value && String(value).trim()) set.add(String(value).trim()); };

  try {
    for (const row of db.prepare('SELECT popup_html_file a, fake_popup_html_file b, preview_image c, preview_video d FROM designs').all()) {
      add(templates, row.a); add(templates, row.b);
      add(uploads, row.c); add(uploads, row.d);
    }
  } catch (_) {}
  try {
    for (const row of db.prepare('SELECT file_name FROM design_preview_images').all()) add(uploads, row.file_name);
  } catch (_) {}
  try {
    for (const row of db.prepare("SELECT icon_file FROM orders WHERE icon_file IS NOT NULL AND icon_file <> ''").all()) add(uploads, row.icon_file);
  } catch (_) {}
  try {
    for (const row of db.prepare("SELECT value FROM settings WHERE key IN ('upi_qr_image','loading_html_file')").all()) {
      add(uploads, row.value); add(templates, row.value);
    }
  } catch (_) {}
  try {
    for (const row of db.prepare("SELECT icon_file FROM pwa_apps WHERE icon_file IS NOT NULL AND icon_file <> ''").all()) add(uploads, row.icon_file);
  } catch (_) {}
  try {
    for (const row of db.prepare("SELECT screenshot_file FROM coin_requests WHERE screenshot_file IS NOT NULL AND screenshot_file <> ''").all()) add(uploads, row.screenshot_file);
  } catch (_) {}
  try {
    for (const row of db.prepare("SELECT image_url FROM popup_announcements WHERE image_url IS NOT NULL AND image_url <> ''").all()) add(uploads, row.image_url);
  } catch (_) {}

  // Order ka current APK artifacts (kis folder me kya referenced hai)
  const orderArtifacts = new Map(); // orderId -> Set(fileNames)
  const addArtifact = (orderId, fileName) => {
    if (!orderId || !fileName) return;
    const key = parseInt(orderId, 10);
    if (!orderArtifacts.has(key)) orderArtifacts.set(key, new Set());
    orderArtifacts.get(key).add(String(fileName).trim());
  };
  const orderIds = new Set();
  try {
    for (const row of db.prepare('SELECT id, apk_file, fake_apk_file, created_at, status FROM orders').all()) {
      orderIds.add(parseInt(row.id, 10));
      addArtifact(row.id, row.apk_file);
      addArtifact(row.id, row.fake_apk_file);
    }
  } catch (_) {}
  try {
    for (const row of db.prepare('SELECT order_id, apk_file FROM order_fake_sites').all()) addArtifact(row.order_id, row.apk_file);
  } catch (_) {}

  return { uploads, templates, orderArtifacts, orderIds };
}

function isLegacyJunkFile(fullPath) {
  const name = path.basename(String(fullPath || ''));
  if (/\.(before-[a-z0-9.-]+|backup\.[0-9-]+)$/i.test(name)) return true;   // index.html.backup.2026...
  if (/\.before-firebase\.\d+$/.test(name)) return true;                     // runtime-links.js.before-firebase.1788...
  if (/\.db(-shm|-wal)$/i.test(name)) {
    // Sirf tab junk jab uska asli DB file usi folder me na ho — LIVE DB ke
    // -wal/-shm ko CHHEDNA data loss hai (isliye folder-wise check).
    const dbName = name.replace(/-shm$|-wal$/i, '');
    return !fs.existsSync(path.join(path.dirname(fullPath), dbName));
  }
  return false;
}

// ── MAIN: scan + (optional) cleanup ──
function scanStorage(db, opts = {}) {
  const refs = collectReferences(db);
  const apkRetentionDays = Math.max(0, parseInt(opts.apkRetentionDays || '0', 10) || 0);
  const keepRecentBackups = Math.max(1, parseInt(opts.keepRecentBackups || '5', 10) || 5);
  const now = Date.now();

  const result = {
    scannedAt: now,
    totals: {},
    buildDirs: { orphans: [], leftoverProjects: [], idsig: [], staleDuplicates: [], oldApks: [] },
    uploads: { orphans: [] },
    templates: { orphans: [] },
    backups: { old: [] },
    legacyJunk: [],
    plan: { files: 0, dirs: 0, bytes: 0 }
  };

  // ── builds/ ──
  // Pehle poora inventory (per order), phir classification — taaki "active"
  // folder galti se duplicate na samjha jaye.
  const inventory = [];        // { dirName, orderId, ts, files, apkFiles, hasReferenced, size, mtime, hasProject }
  let buildCount = 0;
  try {
    for (const dirName of fs.readdirSync(BUILDS_DIR)) {
      const full = path.join(BUILDS_DIR, dirName);
      let stat;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      if (!stat.isDirectory()) continue;
      buildCount++;
      const info = parseBuildDirName(dirName);
      const files = (() => { try { return fs.readdirSync(full); } catch (_) { return []; } })();
      const apkFiles = files.filter(f => f.toLowerCase().endsWith('.apk'));
      const referenced = info ? (refs.orderArtifacts.get(info.orderId) || new Set()) : new Set();
      inventory.push({
        dirName,
        orderId: info ? info.orderId : null,
        ts: info ? info.ts : stat.mtimeMs,
        files,
        apkFiles,
        hasReferenced: apkFiles.some(f => referenced.has(f)),
        hasProject: files.includes('project'),
        size: dirSize(full),
        mtime: stat.mtimeMs
      });
    }
  } catch (_) {}

  // Per-order: kitne folders me DB-referenced APK mili
  const referencedFoldersByOrder = new Map();
  for (const item of inventory) {
    if (item.orderId === null || !item.hasReferenced) continue;
    referencedFoldersByOrder.set(item.orderId, (referencedFoldersByOrder.get(item.orderId) || 0) + 1);
  }

  for (const item of inventory) {
    const isKnownOrder = item.orderId !== null && refs.orderIds.has(item.orderId);

    // 1) orphan folder — order DB me hi nahi
    if (!isKnownOrder) {
      result.buildDirs.orphans.push({ dir: item.dirName, size: item.size, files: item.files.length });
      continue;
    }

    // 2) leftover project dir (build fail/interrupt ke baad bacha gradle copy)
    if (item.hasProject) {
      result.buildDirs.leftoverProjects.push({ dir: item.dirName, size: dirSize(path.join(BUILDS_DIR, item.dirName, 'project')) });
    }

    // 3) .idsig (v4 signing off — bekaar)
    for (const f of item.files) {
      if (f.toLowerCase().endsWith('.idsig')) {
        result.buildDirs.idsig.push({ dir: item.dirName, file: f, size: (() => { try { return fs.statSync(path.join(BUILDS_DIR, item.dirName, f)).size; } catch (_) { return 0; } })() });
      }
    }

    // 4) stale/duplicate folder — is order ka koi DB-referenced APK is folder
    //    me nahi hai, AUR isi order ke kisi doosre folder me referenced APK
    //    maujood hai (warna ye hi active folder ho sakta tha — chhodo mat).
    if (item.apkFiles.length && !item.hasReferenced && (referencedFoldersByOrder.get(item.orderId) || 0) > 0) {
      result.buildDirs.staleDuplicates.push({ dir: item.dirName, size: item.size, files: item.apkFiles });
      continue;
    }

    // 5) purane orders ki APKs (retention — default OFF, admin enable kare)
    if (apkRetentionDays > 0 && item.hasReferenced) {
      const ageDays = Math.floor((now - item.mtime) / DAY_MS);
      if (ageDays > apkRetentionDays) {
        result.buildDirs.oldApks.push({ dir: item.dirName, size: item.size, ageDays, deletion_note: 'is order ka download link band ho jayega' });
      }
    }
  }

  // ── uploads/ + templates/ orphans ──
  const scanDir = (dir, refSet, bucket, skipDirs = []) => {
    try {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(full); } catch (_) { continue; }
        if (stat.isDirectory()) {
          if (!skipDirs.includes(name)) bucket.push({ name, size: dirSize(full), dir: true });
          continue;
        }
        if (!refSet.has(name)) bucket.push({ name, size: stat.size, dir: false });
      }
    } catch (_) {}
  };
  scanDir(UPLOADS_DIR, refs.uploads, result.uploads.orphans);
  scanDir(TEMPLATES_DIR, refs.templates, result.templates.orphans, ['assets']);

  // ── backups/ purane DB backups ──
  try {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => /^apkbuilder_.*\.db$/.test(f))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs, size: fs.statSync(path.join(BACKUPS_DIR, f)).size }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of files.slice(keepRecentBackups)) result.backups.old.push(old);
  } catch (_) {}

  // ── legacy junk (project root + utils + public/admin + database) ──
  const junkScan = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'builds' || entry.name === 'uploads' || entry.name === 'templates') continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (isLegacyJunkFile(full)) {
          result.legacyJunk.push({ file: path.relative(ROOT_DIR, full), size: (() => { try { return fs.statSync(full).size; } catch (_) { return 0; } })() });
        }
      }
    }
  };
  junkScan(ROOT_DIR);
  junkScan(path.join(ROOT_DIR, 'database'));
  junkScan(path.join(ROOT_DIR, 'utils'));
  junkScan(path.join(ROOT_DIR, 'public', 'admin'));

  // ── plan total ──
  // NOTE: plan me SIRF wahi cheezein ginti hain jo is run me sach me delete
  // hongi. Jo items option ke bina skip ho rahe hain (jaise templates orphan
  // jab tak --templates na do) wo alag `potential` me dikhte hain — taaki
  // "reclaimable 40MB" dekh kar admin confuse na ho jab actions 0 hon.
  const templateChoice = opts.includeOrphanTemplates === true || opts.includeOrphanTemplates === '1';
  const add = (bytes, files = 0, dirs = 0) => {
    result.plan.bytes += bytes; result.plan.files += files; result.plan.dirs += dirs;
  };
  for (const item of result.buildDirs.orphans) add(item.size, 0, 1);
  for (const item of result.buildDirs.leftoverProjects) add(item.size, 0, 0);
  for (const item of result.buildDirs.idsig) add(item.size, 1, 0);
  for (const item of result.buildDirs.staleDuplicates) add(item.size, 0, 1);
  for (const item of result.buildDirs.oldApks) add(item.size, 0, 1);
  for (const item of result.uploads.orphans) add(item.size, item.dir ? 0 : 1, item.dir ? 1 : 0);
  if (templateChoice) {
    for (const item of result.templates.orphans) add(item.size, item.dir ? 0 : 1, item.dir ? 1 : 0);
  } else {
    result.plan.skippedTemplates = result.templates.orphans.length;
    result.plan.skippedTemplatesBytes = result.templates.orphans.reduce((sum, i) => sum + (i.size || 0), 0);
  }
  if (apkRetentionDays <= 0) result.plan.oldApkRetentionOff = true;
  for (const item of result.backups.old) add(item.size, 1, 0);
  for (const item of result.legacyJunk) add(item.size, 1, 0);

  result.totals = {
    buildDirs: buildCount,
    buildsSizeMb: mb(dirSize(BUILDS_DIR)),
    uploadsSizeMb: mb(dirSize(UPLOADS_DIR)),
    templatesSizeMb: mb(dirSize(TEMPLATES_DIR)),
    reclaimableMb: mb(result.plan.bytes),
    planFiles: result.plan.files,
    planDirs: result.plan.dirs
  };
  return result;
}

function cleanupStorage(db, opts = {}) {
  const dryRun = String(opts.mode || 'dry') !== 'run';
  const apkRetentionDays = Math.max(0, parseInt(opts.apkRetentionDays || '0', 10) || 0);
  const scan = scanStorage(db, opts);
  const actions = [];
  let freed = 0;

  const doRemoveDir = (dirName, reason) => {
    const full = path.join(BUILDS_DIR, dirName);
    if (dryRun) { actions.push({ action: 'would-delete-dir', target: `builds/${dirName}`, reason }); return; }
    const size = removeItem(full);
    if (size) { freed += size; actions.push({ action: 'deleted-dir', target: `builds/${dirName}`, reason, bytes: size }); }
  };

  for (const item of scan.buildDirs.orphans) doRemoveDir(item.dir, 'orphan build (order DB me nahi)');
  for (const item of scan.buildDirs.staleDuplicates) doRemoveDir(item.dir, 'duplicate/stale build folder (DB referenced APK is folder me nahi)');
  for (const item of scan.buildDirs.oldApks) doRemoveDir(item.dir, `retention ${apkRetentionDays}d (purane order ki APK)`);

  // leftover project/ dirs
  for (const item of scan.buildDirs.leftoverProjects) {
    const full = path.join(BUILDS_DIR, item.dir, 'project');
    if (dryRun) { actions.push({ action: 'would-delete-dir', target: `builds/${item.dir}/project`, reason: 'leftover gradle project copy' }); continue; }
    const size = removeItem(full);
    if (size) { freed += size; actions.push({ action: 'deleted-dir', target: `builds/${item.dir}/project`, reason: 'leftover gradle project copy', bytes: size }); }
  }

  // idsig files
  for (const item of scan.buildDirs.idsig) {
    const full = path.join(BUILDS_DIR, item.dir, item.file);
    if (dryRun) { actions.push({ action: 'would-delete-file', target: `builds/${item.dir}/${item.file}`, reason: 'v4 signature (.idsig) unused' }); continue; }
    const size = removeItem(full);
    if (size) { freed += size; actions.push({ action: 'deleted-file', target: `builds/${item.dir}/${item.file}`, reason: 'v4 signature (.idsig) unused', bytes: size }); }
  }

  // uploads/templates orphans
  const doRemoveFile = (dir, item, reason) => {
    const full = path.join(dir, item.name);
    if (dryRun) { actions.push({ action: item.dir ? 'would-delete-dir' : 'would-delete-file', target: path.relative(ROOT_DIR, full), reason }); return; }
    const size = removeItem(full);
    if (size) { freed += size; actions.push({ action: item.dir ? 'deleted-dir' : 'deleted-file', target: path.relative(ROOT_DIR, full), reason, bytes: size }); }
  };
  for (const item of scan.uploads.orphans) doRemoveFile(UPLOADS_DIR, item, 'unreferenced upload');
  const includeTemplates = opts.includeOrphanTemplates === true;
  if (includeTemplates) for (const item of scan.templates.orphans) doRemoveFile(TEMPLATES_DIR, item, 'unreferenced template');

  // old db backups
  for (const item of scan.backups.old) {
    const full = path.join(BACKUPS_DIR, item.name);
    if (dryRun) { actions.push({ action: 'would-delete-file', target: `backups/${item.name}`, reason: 'purana DB backup' }); continue; }
    const size = removeItem(full);
    if (size) { freed += size; actions.push({ action: 'deleted-file', target: `backups/${item.name}`, reason: 'purana DB backup', bytes: size }); }
  }

  // legacy junk
  for (const item of scan.legacyJunk) {
    const full = path.join(ROOT_DIR, item.file);
    if (dryRun) { actions.push({ action: 'would-delete-file', target: item.file, reason: 'legacy junk/backup file' }); continue; }
    const size = removeItem(full);
    if (size) { freed += size; actions.push({ action: 'deleted-file', target: item.file, reason: 'legacy junk/backup file', bytes: size }); }
  }

  const report = {
    mode: dryRun ? 'dry' : 'run',
    at: new Date().toISOString(),
    apkRetentionDays,
    includeOrphanTemplates: includeTemplates,
    scanned: scan.totals,
    plannedBytes: scan.plan.bytes,
    freedBytes: dryRun ? 0 : freed,
    freedMb: mb(dryRun ? 0 : freed),
    actions
  };

  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    if (!dryRun) {
      fs.writeFileSync(path.join(REPORTS_DIR, `cleanup-${report.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2));
    }
  } catch (_) {}

  return report;
}

// ── Ek order ke purane build folders hatao (rebuild ke baad) ──
// keepDirs: jo folders bilkul nahi hatane (naya build + protected fake)
function pruneOrderBuildDirs(orderId, keepDirs = [], protectFiles = []) {
  const keep = new Set(keepDirs.filter(Boolean));
  const protect = new Set(protectFiles.filter(Boolean));
  const removed = [];
  for (const dir of listBuildDirs(orderId)) {
    if (keep.has(dir.name)) continue;
    let files = [];
    try { files = fs.readdirSync(dir.path); } catch (_) { continue; }
    if (protect.size && files.some(f => protect.has(f))) continue;
    const size = removeItem(dir.path);
    if (size) removed.push({ dir: dir.name, bytes: size });
  }
  return removed;
}

module.exports = {
  scanStorage,
  cleanupStorage,
  pruneOrderBuildDirs,
  collectReferences,
  dirSize,
  mb
};
