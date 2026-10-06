'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// retention-scheduler.js — roz ka automatic cleanup (Firebase + local disk)
//
//   • Firebase users TTL cleanup  → settings fb_retention_enabled=1 (default ON)
//   • Firebase purane paths        → fb_retention_auto_delete_paths=1 (default OFF)
//   • Local disk cleanup           → settings storage_cleanup_enabled=1 (default OFF)
//     (purane APK folders tabhi hate hain jab storage_apk_retention_days > 0)
//   • Purane DB backups            → hamesha (latest 5 rakhta hai)
//
// Report admin Telegram log channel me bhi jata hai. Scheduler fail ho to sirf
// log hota hai — server kabhi nahi girta.
// ─────────────────────────────────────────────────────────────────────────────

const { runRetention, getSettings } = require('./firebase-retention');
const { cleanupStorage } = require('./storage-cleanup');

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 15 * 60 * 1000;   // startup ke 15 min baad
const INTERVAL_MS = 24 * 60 * 60 * 1000;     // roz

function readSetting(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row && row.value !== undefined && row.value !== null ? row.value : fallback;
  } catch (_) {
    return fallback;
  }
}

function truthy(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

async function runDailyCleanup(db, opts = {}) {
  const summary = {
    at: new Date().toISOString(),
    firebase: null,
    local: null,
    errors: []
  };

  // ── 1) Firebase retention ──
  const fbSettings = getSettings(db);
  const fbEnabled = truthy(readSetting(db, 'fb_retention_enabled', String(fbSettings.enabled)));
  if (fbEnabled) {
    try {
      summary.firebase = await runRetention(db, {
        mode: 'run',
        usersTtl: true,
        paths: truthy(readSetting(db, 'fb_retention_auto_delete_paths', String(fbSettings.auto_delete_paths))),
        orphans: truthy(readSetting(db, 'fb_retention_clean_orphans', String(fbSettings.clean_orphans)))
      });
    } catch (e) {
      summary.errors.push('firebase: ' + e.message);
    }
  }

  // ── 2) Local storage cleanup ──
  const localEnabled = truthy(readSetting(db, 'storage_cleanup_enabled', '0'));
  const apkDays = parseInt(readSetting(db, 'storage_apk_retention_days', '0'), 10) || 0;
  if (localEnabled) {
    try {
      summary.local = cleanupStorage(db, {
        mode: 'run',
        apkRetentionDays: apkDays,
        keepRecentBackups: parseInt(readSetting(db, 'backup_keep_count', '5'), 10) || 5,
        includeOrphanTemplates: truthy(readSetting(db, 'storage_clean_orphan_templates', '0'))
      });
    } catch (e) {
      summary.errors.push('local: ' + e.message);
    }
  }

  // ── 3) Purane DB backups (hamesha — safe) ──
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'backups');
    const keep = Math.min(50, Math.max(1, parseInt(readSetting(db, 'backup_keep_count', '5'), 10) || 5));
    const files = fs.readdirSync(dir)
      .filter(f => /^apkbuilder_.*\.db$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, old.f)); } catch (_) {}
    }
  } catch (e) {
    summary.errors.push('db-backups: ' + e.message);
  }

  // ── 4) Report (console + Telegram log channel) ──
  const fb = summary.firebase;
  const localFreed = summary.local ? Number(summary.local.freedMb || 0) : 0;
  console.log(`[retention] daily run: firebase users deleted=${fb ? fb.usersTtl.entriesDeleted : 0}, paths deleted=${fb ? fb.paths.deleted.length : 0}, local freed=${localFreed}MB, errors=${summary.errors.length}`);
  try {
    opts.notify && opts.notify({
      firebase_users_deleted: fb ? fb.usersTtl.entriesDeleted : 0,
      firebase_paths_deleted: fb ? fb.paths.deleted.length : 0,
      local_freed_mb: localFreed,
      errors: summary.errors.length
    });
  } catch (_) {}

  return summary;
}

function startRetentionScheduler(db, opts = {}) {
  const first = setTimeout(() => { runDailyCleanup(db, opts).catch(() => {}); }, FIRST_RUN_DELAY_MS);
  first.unref?.();
  const timer = setInterval(() => { runDailyCleanup(db, opts).catch(() => {}); }, INTERVAL_MS);
  timer.unref?.();
  console.log('[retention] scheduler started (pehla run 15 min me, phir har 24 ghante).');
  return timer;
}

module.exports = { startRetentionScheduler, runDailyCleanup, DAY_MS };
