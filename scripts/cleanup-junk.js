#!/usr/bin/env node
'use strict';

/**
 * cleanup-junk.js — server ki faltu files/disk usage saaf karo (SAFE)
 *
 * Default DRY-RUN hota hai (kuch delete nahi hota, sirf report).
 *
 * Usage (VPS pe project folder se):
 *   node scripts/cleanup-junk.js                     → dry-run report (disk)
 *   node scripts/cleanup-junk.js --run               → actually clean
 *   node scripts/cleanup-junk.js --run --apk-days=60 → 60 din se purane orders ki APKs bhi
 *   node scripts/cleanup-junk.js --run --templates   → unreferenced templates bhi delete
 *   node scripts/cleanup-junk.js --firebase          → Firebase users TTL dry-run
 *   node scripts/cleanup-junk.js --run --firebase    → Firebase cleanup bhi run
 *   node scripts/cleanup-junk.js --min-age-hours=0   → nayi files ko bhi consider karo
 *                                                       (default 24 = fresh uploads/builds safe)
 *
 * Kya saaf hota hai:
 *   builds/  → orphan folders (order DB me nahi), duplicate/stale rebuild folders,
 *              leftover `project/` gradle copies, *.idsig, (optional) purane APKs
 *   uploads/ → kisi design/order/settings/pwa/coin-request me use na ho rahi files
 *   backups/ → purane DB backups (latest 5 rehte hain)
 *   junk     → *.before-*, *.backup.*, orphan .db-shm/.db-wal (live DB ki
 *              wal ko ye script KABHI nahi chhoti — folder-wise check hota hai)
 *
 * NOTE: templates/ ke unreferenced files default me NAHI delete hote (design
 * assets ho sakte hain) — chaaho to `--templates` flag do.
 */

const path = require('path');
const { scanStorage, cleanupStorage } = require('../utils/storage-cleanup');
const db = require('../database/db');
const firebaseRetention = require('../utils/firebase-retention');

const args = process.argv.slice(2);
const hasFlag = name => args.some(a => a === name || a.startsWith(name + '='));
const getArg = (name, fallback) => {
  const hit = args.find(a => a.startsWith(name + '='));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const RUN = hasFlag('--run');
const APK_DAYS = Math.max(0, parseInt(getArg('--apk-days', '0'), 10) || 0);
const INCLUDE_TEMPLATES = hasFlag('--templates');
const DO_FIREBASE = hasFlag('--firebase');
// Default 24 ghante: itni nayi files/folders chhode jate hain (abhi ka upload
// ya chal raha build galti se na kat jaye).
const MIN_AGE_HOURS = Math.max(0, parseFloat(getArg('--min-age-hours', '24')) || 0);

function mb(bytes) { return Math.round((bytes / 1048576) * 10) / 10; }

async function main() {
  console.log('═'.repeat(64));
  console.log(RUN ? ' CLEANUP (LIVE RUN — files delete honge)' : ' CLEANUP (DRY-RUN — kuch delete nahi hoga)');
  console.log('═'.repeat(64));

  const scan = scanStorage(db, { apkRetentionDays: APK_DAYS, minOrphanAgeHours: MIN_AGE_HOURS });
  console.log(`\nDisk: builds=${scan.totals.buildsSizeMb}MB uploads=${scan.totals.uploadsSizeMb}MB templates=${scan.totals.templatesSizeMb}MB`);
  console.log(`Reclaimable (is run me): ${scan.totals.reclaimableMb} MB | files=${scan.totals.planFiles} dirs=${scan.totals.planDirs}`);
  console.log(`  orphan build dirs : ${scan.buildDirs.orphans.length}`);
  console.log(`  stale/dup dirs    : ${scan.buildDirs.staleDuplicates.length}`);
  console.log(`  leftover project/ : ${scan.buildDirs.leftoverProjects.length}`);
  console.log(`  .idsig files      : ${scan.buildDirs.idsig.length}`);
  console.log(`  old APK dirs      : ${scan.buildDirs.oldApks.length}${APK_DAYS ? '' : ' (--apk-days=0 → off)'}`);
  console.log(`  orphan uploads    : ${scan.uploads.orphans.length}`);
  console.log(`  orphan templates  : ${scan.templates.orphans.length}${INCLUDE_TEMPLATES ? '' : ' (khud ko safe — --templates se delete honge)'}`);
  console.log(`  old DB backups    : ${scan.backups.old.length}`);
  console.log(`  legacy junk files : ${scan.legacyJunk.length}`);
  const rs = scan.recentSkips || { uploads: [], templates: [], builds: [] };
  const recentTotal = rs.uploads.length + rs.templates.length + rs.builds.length;
  console.log(`  fresh (chhode)    : ${recentTotal}  [< ${MIN_AGE_HOURS}h — uploads ${rs.uploads.length}, templates ${rs.templates.length}, builds ${rs.builds.length}]`);

  const report = cleanupStorage(db, {
    mode: RUN ? 'run' : 'dry',
    apkRetentionDays: APK_DAYS,
    includeOrphanTemplates: INCLUDE_TEMPLATES,
    keepRecentBackups: 5,
    minOrphanAgeHours: MIN_AGE_HOURS
  });

  console.log(`\nActions: ${report.actions.length}${RUN ? ` | Freed: ${report.freedMb} MB` : ''}`);
  for (const action of report.actions.slice(0, 40)) {
    console.log(`  [${action.action}] ${action.target}  (${action.reason})`);
  }
  if (report.actions.length > 40) console.log(`  … +${report.actions.length - 40} more`);

  if (DO_FIREBASE) {
    console.log('\n' + '─'.repeat(64));
    console.log(RUN ? ' FIREBASE CLEANUP (LIVE)' : ' FIREBASE CLEANUP (DRY-RUN)');
    const summary = await firebaseRetention.runRetention(db, {
      mode: RUN ? 'run' : 'dry',
      usersTtl: true,
      paths: false,
      orphans: true
    });
    console.log(`  users entries deleted : ${summary.usersTtl.entriesDeleted} (unknown age skipped: ${summary.usersTtl.entriesSkippedUnknown})`);
    console.log(`  paths deleted         : ${summary.paths.deleted.length}`);
    for (const p of summary.paths.deleted.slice(0, 30)) console.log(`    - ${p.path} (${p.reason})`);
    if (summary.errors.length) {
      console.log('  errors:');
      for (const e of summary.errors.slice(0, 10)) console.log('    ! ' + e);
    }
  }

  if (!RUN) {
    console.log('\nYe dry-run tha. Delete karne ke liye: node scripts/cleanup-junk.js --run');
    if (MIN_AGE_HOURS > 0) console.log(`(Nayi files (<${MIN_AGE_HOURS}h) safe hain. Sab consider karna ho to --min-age-hours=0 do.)`);
  }
}

main().catch(err => {
  console.error('cleanup-junk failed:', err.message);
  process.exit(1);
});
