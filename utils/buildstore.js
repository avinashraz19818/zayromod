'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// buildstore.js — APK artifacts ka SAHI owner (order) dhundo + content verify
//
// PROBLEM (jise ye file fix karti hai):
//   APK ka naam app name se banta hai (e.g. "MAAN_WIN_ADMIN_TOOL.apk"). Do
//   orders ka app name same ho to dono ka file naam BILKUL same hota tha, aur
//   purana download lookup poore builds/ folder me sirf NAAM se dhundta tha —
//   isliye order A ka download order B (ya isi order ke purane rebuild) ki APK
//   serve kar deta tha. User ko lagta tha "template change nahi ho raha, purana
//   hi aa raha hai" — asal me galat order ki APK mil rahi thi.
//
// FIX: har lookup pehle usi order ke build folders (build_<orderId>_*) me
//   hoti hai, newest-first. Global (poore builds/) fallback sirf tab jab file
//   naam DB me unique ho (server bhejta hai allowGlobal:true) — warna galat
//   APK kabhi serve nahi hogi.
//
// Isi file me build-time "content fingerprint" ka helper bhi hai: har APK ke
// encrypted HTML me ek chhota marker (template file + uska SHA-256) chala
// jata hai, jisse admin panel kabhi bhi VERIFY kar sakta hai ki jo APK pada
// hai wo ABHI ke design/template se bana hai ya purana hai.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { MARKER, FIXED_PASSWORD, decryptHtmlFromBin } = require('./encrypt');

const BUILDS_DIR = path.join(__dirname, '..', 'builds');

// ── Build folder naming: build_<orderId>_<ts>[_rebuild_<ts>][_fake][_fakeS<n>] ──
function parseBuildDirName(dirName) {
  const m = String(dirName || '').match(/^build_(\d+)_/);
  if (!m) return null;
  const orderId = parseInt(m[1], 10);
  const stamps = String(dirName).match(/\d{13}/g);
  const ts = stamps && stamps.length ? parseInt(stamps[stamps.length - 1], 10) : 0;
  return {
    orderId,
    ts,
    isFake: /_fake$/i.test(dirName) || /_fakeS\d+$/i.test(dirName),
    fakeSiteId: (String(dirName).match(/_fakeS(\d+)$/i) || [])[1] || null
  };
}

function listBuildDirs(orderId) {
  if (!fs.existsSync(BUILDS_DIR)) return [];
  const prefix = `build_${parseInt(orderId, 10)}_`;
  const out = [];
  for (const name of fs.readdirSync(BUILDS_DIR)) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(BUILDS_DIR, name);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    const info = parseBuildDirName(name) || { orderId: parseInt(orderId, 10), ts: 0 };
    out.push({ name, path: full, ts: info.ts || stat.mtimeMs, isFake: info.isFake, fakeSiteId: info.fakeSiteId });
  }
  // Sabse NAYA build folder pehle (purani APK galti se serve na ho)
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

// Global (poore builds/) search — sirf tab use karo jab file naam unique ho.
function findApkGlobally(fileName) {
  if (!fileName || !fs.existsSync(BUILDS_DIR)) return null;
  const safe = path.basename(String(fileName));
  const dirs = [];
  for (const name of fs.readdirSync(BUILDS_DIR)) {
    const full = path.join(BUILDS_DIR, name);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    const info = parseBuildDirName(name);
    dirs.push({ name, path: full, ts: (info && info.ts) || stat.mtimeMs });
  }
  dirs.sort((a, b) => b.ts - a.ts);
  for (const dir of dirs) {
    const apkPath = path.join(dir.path, safe);
    if (fs.existsSync(apkPath)) return { path: apkPath, dir: dir.name, scoped: false };
  }
  return null;
}

// Order-scoped lookup — DEFAULT. Same order ke folders me sabse nayi APK.
function findOrderApk(orderId, fileName, opts = {}) {
  if (!fileName) return null;
  const safe = path.basename(String(fileName));
  for (const dir of listBuildDirs(orderId)) {
    const apkPath = path.join(dir.path, safe);
    if (fs.existsSync(apkPath)) return { path: apkPath, dir: dir.name, scoped: true };
  }
  if (opts.allowGlobal) return findApkGlobally(safe);
  return null;
}

// ── Build marker (encrypted HTML ke andar, sirf admin verification ke liye) ──
// HTML comment isliye ki rendering bilkul change na ho. DOCTYPE ke baad/`<head>`
// ke andar daala jata hai — pehle daalne se document quirks mode me ja sakta hai.
const BUILD_MARKER_RE = /<!--\s*zayro-build\s+(\{[\s\S]*?\})\s*-->/i;

function tagRenderedHtml(html, meta) {
  if (!html || !meta) return html;
  if (BUILD_MARKER_RE.test(html)) return html;
  let payload;
  try { payload = JSON.stringify(meta).replace(/--/g, '- -'); } catch (_) { return html; }
  const tag = `<!--zayro-build ${payload}-->`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, m => m + tag);
  const doc = html.match(/^\s*<!doctype[^>]*>/i);
  if (doc) return html.replace(doc[0], doc[0] + tag);
  return tag + html;
}

function readBuildMeta(html) {
  if (!html) return null;
  const m = String(html).match(BUILD_MARKER_RE);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function fileSha256(filePath) {
  try { return sha256Hex(fs.readFileSync(filePath)); } catch (_) { return null; }
}

// ── APK se asset nikalo (assets/zayro.bin etc.) ──
function readApkAsset(apkPath, assetName) {
  try {
    return execFileSync('unzip', ['-p', apkPath, assetName], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch (_) {
    return null;
  }
}

function listApkBinAssets(apkPath) {
  try {
    const listing = execFileSync('unzip', ['-l', apkPath], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    return listing.split('\n')
      .map(line => (line.match(/(assets\/[^\s]+\.bin)\s*$/) || [])[1])
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

// ── Per-build password candidates (naya per-build key, warna legacy fixed) ──
function candidatePasswords(db, orderId, firebasePath) {
  const out = [];
  try {
    const rows = db.prepare(`
      SELECT key_secret, engine, firebase_path FROM build_keys
      WHERE order_id=? ORDER BY id DESC
    `).all(orderId);
    const wanted = String(firebasePath || '');
    // Pehle wahi path jiske liye ye APK bana tha, phir order ke baaki keys
    const sorted = rows.slice().sort((a, b) => {
      const aw = String(a.firebase_path) === wanted ? 0 : 1;
      const bw = String(b.firebase_path) === wanted ? 0 : 1;
      return aw - bw;
    });
    for (const row of sorted) {
      if (!row.key_secret) continue;
      if (row.engine === 'java') out.push(String(row.key_secret));
      else out.push(Buffer.from(String(row.key_secret), 'base64'));
    }
  } catch (_) {}
  out.push(FIXED_PASSWORD);
  return out;
}

function decryptWithCandidates(buffer, passwords) {
  for (const pw of passwords) {
    try {
      const html = decryptHtmlFromBin(buffer, pw);
      if (html && html.length > 50) return { html, password: pw };
    } catch (_) { /* agli key try karo */ }
  }
  return null;
}

// APK ke andar ka popup HTML (decrypted) — verification/forensics ke liye.
function readApkPopupHtml(apkPath, db, orderId, firebasePath) {
  const candidates = listApkBinAssets(apkPath);
  const preferred = ['assets/zayro.bin', 'assets/wingss.bin'].filter(n => candidates.includes(n));
  const others = candidates.filter(n => !preferred.includes(n) && !/loading|lodale/i.test(n));
  const passwords = candidatePasswords(db, orderId, firebasePath);
  for (const asset of preferred.concat(others)) {
    const buf = readApkAsset(apkPath, asset);
    if (!buf || buf.indexOf(MARKER) < 0) continue;
    const dec = decryptWithCandidates(buf, passwords);
    if (dec) return { html: dec.html, asset, ...dec };
  }
  return null;
}

// ── Purane (marker-less) APKs ke liye similarity estimate ──
// Marker sirf naye builds me hota hai. Legacy APK ka decrypted HTML aur
// abhi ka rendered HTML ka shingle-Jaccard nikaal ke batate hain ki content
// same design ka lagta hai ya purana/different hai. (Estimate — exact proof
// ke liye rebuild karo, jon marker daal dega.)
function htmlSimilarity(a, b) {
  // Token-set Jaccard: positions pe depend nahi karta (injected marker/URL se
  // poori string shift ho jati hai, isliye shingle-based compare galat 0 de
  // raha tha). Token = 6+ chars ke identifiers/class-name/CSS words.
  const tokens = s => {
    const out = new Set();
    const text = String(s || '');
    const re = /[A-Za-z_][A-Za-z0-9_-]{5,}/g;
    let m;
    while ((m = re.exec(text)) && out.size < 60000) out.add(m[0].toLowerCase());
    return out;
  };
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return { ratio: null, verdict: 'unknown' };
  let inter = 0;
  for (const item of A) if (B.has(item)) inter++;
  const union = A.size + B.size - inter;
  const ratio = union ? inter / union : null;
  const verdict = ratio === null ? 'unknown' : ratio >= 0.97 ? 'same' : ratio >= 0.8 ? 'mostly-same' : 'different';
  return { ratio: ratio === null ? null : Math.round(ratio * 1000) / 1000, verdict, samples: { apk: A.size, current: B.size } };
}

// ── Verification report: "jo APK pada hai, wo ABHI ke design se bana hai?" ──
// ── LINK EXTRACTION ──
// APK ke andar (ya live-render) se wo links nikaalo jinhe admin "links change"
// ke baad verify karna chahta hai: register / deposit / wingo + firebase path.
// Kabhi kabhi template me sirf gameFrame.src hota hai — usse bhi uthate hain.
function extractLinksFromHtml(html) {
  const out = { registerUrl: null, depositUrl: null, wingoUrl: null, firebasePath: null };
  if (!html || typeof html !== 'string') return out;
  const pick = re => {
    const m = html.match(re);
    return m ? String(m[1]).trim() : null;
  };
  out.registerUrl = pick(/var\s+REGISTER_URL\s*=\s*["']([^"']+)["']/i);
  if (!out.registerUrl) {
    out.registerUrl = pick(/<iframe\b[^>]*\bid=["'](?:target-game-frame|gameIframe)["'][^>]*\bsrc=["']([^"']+)["']/i)
      || pick(/\b(?:gameFrame|gameIframe)\.src\s*=\s*["']([^"']+)["']/i);
  }
  out.depositUrl = pick(/var\s+DEPOSIT_URL\s*=\s*["']([^"']+)["']/i);
  out.wingoUrl = pick(/var\s+WINGO_URL\s*=\s*["']([^"']+)["']/i);
  out.firebasePath = pick(/rtdb\.ref\(\s*["']([a-zA-Z0-9_]+)\/(?:config|users)/i);
  return out;
}

function sameUrl(a, b) {
  const norm = u => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function buildVerifyReport({ apkInfo, apkMeta, currentMeta, apkHtml = null, currentHtml = null, apkLinks = null, currentLinks = null, liveLink = false, fields = {} }) {
  const report = {
    ...fields,
    apkFound: !!apkInfo,
    apkPath: apkInfo ? apkInfo.path : null,
    apkBuildDir: apkInfo ? apkInfo.dir : null,
    apkScoped: apkInfo ? apkInfo.scoped === true : false,
    apkTemplateFile: apkMeta ? apkMeta.t : null,
    apkTemplateHash: apkMeta ? apkMeta.h : null,
    apkBuildId: apkMeta ? apkMeta.b : null,
    apkBuiltAt: apkMeta ? apkMeta.ts || null : null,
    currentTemplateFile: currentMeta ? currentMeta.t : null,
    currentTemplateHash: currentMeta ? currentMeta.h : null,
    match: null,
    verdict: 'unknown'
  };

  // ── LINKS CHECK (register/deposit/wingo/firebase path) ──
  // Note: live_link_enabled=1 wale APKs links runtime pe Firebase config se
  // lete hain — unme APK ke andar purane links hona normal hai (rebuild ki
  // zaroorat nahi). Isliye report us case me reason bhi batati hai.
  if (apkLinks && currentLinks) {
    const keys = ['registerUrl', 'depositUrl', 'wingoUrl', 'firebasePath'];
    const changed = keys.filter(k => apkLinks[k] && currentLinks[k] && !sameUrl(apkLinks[k], currentLinks[k]));
    const known = keys.filter(k => apkLinks[k] && currentLinks[k]);
    report.links = {
      apk: apkLinks,
      current: currentLinks,
      checked: known,
      changed,
      liveLink: !!liveLink,
      equal: known.length ? changed.length === 0 : null
    };
    if (changed.length && !liveLink) report.links.note = 'APK me purane links hain (' + changed.join(', ') + ') — rebuild ya link-resync karo.';
    else if (changed.length) report.links.note = 'APK me purane links hain, lekin ye APK live-link mode me hai (Firebase config se update hote hain) — rebuild ki zaroorat nahi.';
  }

  if (!apkInfo) {
    report.verdict = 'apk-missing';
    report.message = 'APK file builds/ folder me nahi mili (delete ho gayi ya rebuild pending hai).';
    return report;
  }
  if (!apkMeta) {
    // Legacy APK (marker ke bina) — content similarity se estimate karo
    if (apkHtml && currentHtml) {
      const sim = htmlSimilarity(apkHtml, currentHtml);
      report.similarity = sim;
      const linkMismatch = !!(report.links && report.links.changed && report.links.changed.length && !liveLink);
      if (sim.verdict === 'same' && !linkMismatch) {
        report.match = true;
        report.verdict = 'up-to-date-estimated';
        report.message = `APK purane format ka hai (marker nahi), lekin content ${Math.round((sim.ratio || 0) * 100)}% match karta hai — design wahi lagta hai. Pakka proof ke liye rebuild karo.`;
      } else if (sim.verdict === 'same' && linkMismatch) {
        report.match = false;
        report.verdict = 'stale';
        report.message = `Design wahi hai lekin APK me purane links hain (${report.links.changed.join(', ')}). Link-resync ya rebuild karo.`;
      } else {
        report.match = false;
        report.verdict = sim.verdict === 'unknown' ? 'apk-unreadable' : 'stale';
        report.message = sim.verdict === 'unknown'
          ? 'APK ka content decrypt nahi ho paya (purana legacy key ya corrupt file). Rebuild karo.'
          : `APK purane design ka lagta hai (content match sirf ${Math.round((sim.ratio || 0) * 100)}%). Rebuild karo.`;
      }
      return report;
    }
    report.verdict = 'apk-unreadable';
    report.message = 'APK ka content decrypt nahi ho paya (purana legacy key ya corrupt file). Rebuild karke dobara check karo.';
    return report;
  }
  if (!currentMeta) {
    report.verdict = 'template-missing';
    report.message = 'Design ka naya content render nahi ho paya (template file missing).';
    return report;
  }
  const templateMatch = apkMeta.h === currentMeta.h && apkMeta.t === currentMeta.t;
  const linkMismatch = !!(report.links && report.links.changed && report.links.changed.length && !liveLink);
  report.match = templateMatch && !linkMismatch;
  report.verdict = report.match ? 'up-to-date' : 'stale';
  report.message = !templateMatch
    ? `APK PURANE template se bana hai (APK: ${apkMeta.t || '?'} → ab: ${currentMeta.t || '?'}). Rebuild karo.`
    : linkMismatch
      ? `Template wahi hai, lekin APK me purane links hain (${report.links.changed.join(', ')}). Rebuild karo.`
      : `APK abhi ke template (${currentMeta.t}) se bana hua hai — koi rebuild zaroori nahi.`;
  return report;
}

module.exports = {
  BUILDS_DIR,
  parseBuildDirName,
  listBuildDirs,
  findOrderApk,
  findApkGlobally,
  tagRenderedHtml,
  readBuildMeta,
  BUILD_MARKER_RE,
  sha256Hex,
  fileSha256,
  readApkAsset,
  listApkBinAssets,
  candidatePasswords,
  readApkPopupHtml,
  buildVerifyReport,
  htmlSimilarity,
  extractLinksFromHtml
};
