#!/usr/bin/env node
'use strict';

/**
 * cleanup-orphan-files.js
 * ─────────────────────────────────────────────────────────────────────────
 * templates/ aur uploads/ me padi ORPHAN files ki safai (purane deletes se
 * bachi hui files jo ab kisi design/order/setting se referenced nahi hain).
 *
 * Safe: jo file abhi bhi DB me referenced hai wo kabhi delete nahi hoti.
 *
 * Usage (VPS, project folder se):
 *   node scripts/cleanup-orphan-files.js             → real delete
 *   node scripts/cleanup-orphan-files.js --dry-run   → sirf list dikhata hai
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..');
const DB = require(path.join(ROOT, 'database', 'db'));

// ── Referenced files collect karo ──
const templatesRefs = new Set();
const uploadsRefs = new Set();

for (const r of DB.prepare('SELECT popup_html_file, fake_popup_html_file, preview_image, preview_video FROM designs').all()) {
  if (r.popup_html_file) templatesRefs.add(r.popup_html_file);
  if (r.fake_popup_html_file) templatesRefs.add(r.fake_popup_html_file);
  if (r.preview_image) uploadsRefs.add(r.preview_image);
  if (r.preview_video) uploadsRefs.add(r.preview_video);
}
for (const r of DB.prepare('SELECT file_name FROM design_preview_images').all()) {
  if (r.file_name) uploadsRefs.add(r.file_name);
}
for (const r of DB.prepare('SELECT icon_file FROM orders').all()) {
  if (r.icon_file) uploadsRefs.add(r.icon_file);
}
// Settings me bhi file references ho sakte hain (loading_html_file,
// upi_qr_image, etc.) — saare settings values dono sets me add karo
// (jo filename nahi hai wo kisi file se match hi nahi karegi — harmless).
for (const r of DB.prepare('SELECT value FROM settings').all()) {
  if (r.value) { templatesRefs.add(r.value); uploadsRefs.add(r.value); }
}

// ── Scan + delete ──
function cleanDir(dirName, refs) {
  const dir = path.join(ROOT, dirName);
  if (!fs.existsSync(dir)) { console.log(`[${dirName}] dir nahi hai — skip`); return; }
  let kept = 0, removed = 0, errors = 0;
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    try {
      if (!fs.statSync(fp).isFile()) { kept++; continue; } // subdirs chhodo
    } catch (_) { continue; }
    if (refs.has(f)) { kept++; continue; }
    if (DRY_RUN) {
      console.log(`[${dirName}] ORPHAN (dry-run): ${f}`);
      removed++;
    } else {
      try {
        fs.unlinkSync(fp);
        console.log(`[${dirName}] DELETED: ${f}`);
        removed++;
      } catch (e) {
        console.error(`[${dirName}] FAIL: ${f} — ${e.message}`);
        errors++;
      }
    }
  }
  console.log(`[${dirName}] summary: ${kept} referenced (safe), ${removed} orphan ${DRY_RUN ? 'milgayi (dry-run)' : 'delete hui'}, ${errors} errors`);
}

console.log(DRY_RUN ? '═══ DRY-RUN (kuch delete nahi hoga) ═══' : '═══ ORPHAN FILE CLEANUP ═══');
cleanDir('templates', templatesRefs);
cleanDir('uploads', uploadsRefs);
console.log(DRY_RUN ? 'Sab sahi laga to bina --dry-run ke chalao.' : '✅ Done.');
