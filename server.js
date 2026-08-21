require('dotenv').config();
const { rateLimit } = require('express-rate-limit');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const https = require('https');

const db = require('./database/db');
const { buildApk, makePackageName } = require('./utils/apkbuilder');
const { initBot, sendCoinRequest, sendApkReady } = require('./utils/telegram');
const { injectParams: injectHtmlParams } = require('./utils/htmlprocessor');
const { buildAppContent } = require('./utils/appcontent');
const { applyFontStyle, isValidStyle, FONT_STYLES } = require('./utils/fontstyles');
const {
  normalizeHttpUrl,
  replaceUrlDomain,
  updateFirebaseLinks,
  getFirebaseControl,
  updateFirebaseControl,
  addFirebaseUser,
  removeFirebaseUser
} = require('./utils/runtime-links');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Dirs ──
['builds','uploads','templates/assets','base-apks','keystore','backups'].forEach(d => {
  fs.mkdirSync(path.join(__dirname, d), { recursive: true });
});

function createDatabaseBackup(reason = 'manual') {
  const backupDir = path.join(__dirname, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `apkbuilder_${reason}_${stamp}.db`;
  const dest = path.join(backupDir, file);
  try { db.pragma('wal_checkpoint(FULL)'); } catch (_) {}
  fs.copyFileSync(path.join(__dirname, 'database', 'apkbuilder.db'), dest);
  const keep = Math.max(1, parseInt(db.prepare('SELECT value FROM settings WHERE key=?').get('backup_keep_count')?.value || '10', 10) || 10);
  const files = fs.readdirSync(backupDir)
    .filter(f => /^apkbuilder_.*\.db$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of files.slice(keep)) {
    try { fs.unlinkSync(path.join(backupDir, old.f)); } catch (_) {}
  }
  return { file, path: dest, size: fs.statSync(dest).size, created_at: new Date().toISOString() };
}

try { createDatabaseBackup('startup'); } catch (error) { console.error('Startup backup failed:', error.message); }

// ── Middleware ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// ── SECURITY: /builds aur /uploads ka PUBLIC static access HATA diya ──
// Pehle koi bhi /uploads/<file> ya /builds/<folder>/<apk> direct URL se
// khol sakta tha (APKs tak public thin!). Ab files sirf authenticated
// route /api/files/:name se milti hain (neeche) — bina login ke 401.
// APK download pehle se hi requireAuth route se hota hai (res.download).
app.use((req, res, next) => {
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'zayro_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ── SECURE FILE SERVING ──
// Uploads ab /api/files/:name se milti hain — sirf LOGGED-IN user (ya
// admin) ko. Bina login ke direct URL se QR / design photos / APK kuch
// nahi khulta (401). Browser me <img>/<video> same-origin cookie bhejta
// hai isliye logged-in page pe sab normal render hota hai.
const FILE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf', '.ico': 'image/x-icon',
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2'
};
app.get('/api/files/:name', (req, res) => {
  const isAuth = req.session && (req.session.userId !== undefined || req.session.isAdmin);
  if (!isAuth) return res.status(401).send('Login required');
  const safe = path.basename(String(req.params.name || ''));
  if (!safe || safe === '.' || safe === '..' || /[\u0000-\u001f]/.test(safe)) {
    return res.status(400).send('Bad filename');
  }
  const full = path.join(__dirname, 'uploads', safe);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return res.status(404).send('Not found');
  }
  const ext = path.extname(safe).toLowerCase();
  res.set('Content-Type', FILE_MIME[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=3600');
  // sendFile Range requests bhi sambhalta hai (video seek)
  res.sendFile(full, err => { if (err && !res.headersSent) res.status(404).end(); });
});

// ── Multer configs ──
const iconUpload    = multer({ dest: path.join(__dirname, 'uploads'), limits: { fileSize: 5   * 1024 * 1024 } });
const adminUpload   = multer({ dest: path.join(__dirname, 'uploads'), limits: { fileSize: 50  * 1024 * 1024 } });
const projectUpload = multer({ dest: path.join(__dirname, 'uploads'), limits: { fileSize: 200 * 1024 * 1024 } });

// ── Init Telegram ──
const tgSettings = db.prepare('SELECT value FROM settings WHERE key=?');
const tgToken = tgSettings.get('telegram_bot_token')?.value || process.env.TELEGRAM_BOT_TOKEN;
if (tgToken) initBot(tgToken, db);
else initBot(null, db); // pass db even when no token so callbacks work once token added later

// ── Firebase link watchdog (hacker self-heal — har 45s) ──
// Hacker ne koi panel ka link badla to server DB wali original value
// maximum 45 second me khud wapas likh deta hai.
try {
  require('./utils/linkwatchdog').startWatchdog();
} catch (e) {
  console.error('[watchdog] start failed:', e.message);
}

// ── Auth middleware ──
function requireAuth(req, res, next) {
  if (req.session.userId !== undefined) return next();
  res.status(401).json({ error: 'Login required' });
}
function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(403).json({ error: 'Admin only' });
}

// ═══════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════
const getClientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, handler: (req, res) => { const ip = getClientIp(req); db.prepare('INSERT OR IGNORE INTO blocked_ips(ip) VALUES(?)').run(ip); res.status(429).json({ error: 'Too many registration attempts. This IP has been blocked.' }); } });

app.use('/api/register', (req, res, next) => { const ip = getClientIp(req); const blocked = db.prepare('SELECT 1 FROM blocked_ips WHERE ip=?').get(ip); if (blocked) return res.status(403).json({ error: 'Registration blocked from this IP.' }); next(); });
app.post('/api/register', registerLimiter, async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.json({ error: 'All fields required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const stmt = db.prepare('INSERT INTO users(username,email,password,plain_password) VALUES(?,?,?,?)');
    const result = stmt.run(username.trim().toLowerCase(), email.trim().toLowerCase(), hash, password);
    req.session.userId = result.lastInsertRowid;
    req.session.username = username;
    res.json({ success: true });
  } catch (e) {
    res.json({ error: 'Username or email already exists' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ error: 'Fields required' });

  // Admin check
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  if (username === adminUser && password === adminPass) {
    req.session.isAdmin = true;
    req.session.userId = 0;
    req.session.username = 'admin';
    return res.json({ success: true, isAdmin: true });
  }

  const user = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(username.toLowerCase(), username.toLowerCase());
  if (!user) return res.json({ error: 'User not found' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.json({ error: 'Wrong password' });
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ success: true, isAdmin: false });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// GOOGLE OAuth LOGIN — "Continue with Google"
// ═══════════════════════════════════════════
// Koi naya npm package nahi chahiye — native https se token exchange + user
// info fetch hota hai. .env me bas ye bharna hai:
//   GOOGLE_CLIENT_ID=...
//   GOOGLE_CLIENT_SECRET=...
//   GOOGLE_REDIRECT_URI=https://yourdomain.com/auth/google/callback
//     (khali chhoda to BASE_URL se khud ban jata hai)
// Google Cloud Console ke OAuth client me EXACTLY wahi redirect URI
// authorized hona chahiye.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI
  || (process.env.BASE_URL ? process.env.BASE_URL.replace(/\/+$/, '') + '/auth/google/callback' : '');

function googleAuthEnabled() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);
}

function httpsPostForm(url, params) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(params).toString();
    const u = new URL(url);
    const rq = https.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('bad json: ' + body.slice(0, 200))); }
      });
    });
    rq.on('error', reject);
    rq.write(data);
    rq.end();
  });
}

function httpsGetJson(url, accessToken) {
  return new Promise((resolve, reject) => {
    https.get(new URL(url), { headers: { Authorization: 'Bearer ' + accessToken } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('bad json')); }
      });
    }).on('error', reject);
  });
}

// Step 1: user ko Google ke consent screen pe bhejo
app.get('/auth/google', (req, res) => {
  if (!googleAuthEnabled()) return res.redirect('/?google=disabled');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleState = state;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

// Step 2: Google wapas code bhejta hai → login ya account create
app.get('/auth/google/callback', async (req, res) => {
  const fail = (msg) => {
    if (msg) console.error('Google auth error:', msg);
    return res.redirect('/?google=error');
  };
  if (!googleAuthEnabled()) return fail('not configured');
  const { code, state, error } = req.query;
  if (error) return fail('google returned: ' + error);
  if (!code) return fail('no code');
  if (!state || state !== req.session.googleState) return fail('state mismatch');
  delete req.session.googleState;

  try {
    // 1) code → access token
    const tokenRes = await httpsPostForm('https://oauth2.googleapis.com/token', {
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code'
    });
    if (!tokenRes || !tokenRes.access_token) return fail('token exchange failed: ' + JSON.stringify(tokenRes).slice(0, 150));

    // 2) access token → user info (google id, name, email)
    const info = await httpsGetJson('https://www.googleapis.com/oauth2/v3/userinfo', tokenRes.access_token);
    if (!info || !info.email) return fail('userinfo failed');
    const googleId = String(info.sub || '');
    const email = String(info.email).trim().toLowerCase();
    const name = String(info.name || '').trim();

    // 3) Existing user? google_id → email → naya banao
    let user = googleId ? db.prepare('SELECT * FROM users WHERE google_id=?').get(googleId) : null;
    if (!user) user = db.prepare('SELECT * FROM users WHERE email=?').get(email);

    if (!user) {
      // Naya account — username Google ke naam se, conflict par email prefix
      let base = name.toLowerCase().replace(/[^a-z0-9._]/g, '').substring(0, 15);
      if (!base) base = email.split('@')[0].replace(/[^a-z0-9._]/g, '').substring(0, 15);
      let username = base || 'user';
      let n = 1;
      while (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) {
        username = base + n++;
      }
      // Google users ka password hota nahi — random hash (kabhi use nahi hoga)
      const randomHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
      const ins = db.prepare('INSERT INTO users(username,email,password,plain_password,google_id) VALUES(?,?,?,?,?)');
      const r = ins.run(username, email, randomHash, '', googleId || null);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    } else if (googleId && !user.google_id) {
      // Email se pehle se account hai → usko Google se link kar do
      db.prepare('UPDATE users SET google_id=? WHERE id=?').run(googleId, user.id);
      user.google_id = googleId;
    }

    // 4) Session set — bilkul /api/login jaisa
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = false;
    res.redirect('/?google=1');
  } catch (e) {
    return fail(e.message);
  }
});

app.get('/api/me', requireAuth, (req, res) => {
  if (req.session.isAdmin) return res.json({ isAdmin: true, username: 'admin' });
  const user = db.prepare('SELECT id,username,email,coins,telegram_id FROM users WHERE id=?').get(req.session.userId);
  res.json({ ...user, isAdmin: false });
});

app.post('/api/me/telegram', requireAuth, (req, res) => {
  if (req.session.isAdmin) return res.json({ success: true });
  const { telegram_id } = req.body;
  if (!telegram_id) return res.json({ error: 'telegram_id required' });
  db.prepare('UPDATE users SET telegram_id=? WHERE id=?').run(String(telegram_id), req.session.userId);
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// DESIGN ROUTES
// ═══════════════════════════════════════════

const designPreviewImagesStmt = db.prepare(`
  SELECT file_name FROM design_preview_images
  WHERE design_id=? ORDER BY sort_order ASC, id ASC
`);

function normalizeDesignCategory(value, design = {}) {
  const category = String(value || '').trim().toLowerCase();
  if (category === 'dhani') return 'dhani';
  const legacyType = String(design.java_type || '').trim().toLowerCase();
  if (legacyType === 'dhani' || legacyType === 'premium' || /dhani/i.test(design.name || '')) return 'dhani';
  // Old "normal" and "java" categories are both the common Zayro Java.
  return 'zayro';
}

function withPreviewImages(design) {
  if (!design) return design;
  return {
    ...design,
    category: normalizeDesignCategory(design.category, design),
    preview_images: designPreviewImagesStmt.all(design.id).map(row => row.file_name)
  };
}

// ═══════════════════════════════════════════
// REMOTE APP CONTENT — APK runtime pe yahan se encrypted HTML fetch karta
// hai (popup + loading). APK me koi design HTML / Firebase detail nahi hoti.
// Response encrypted .bin hai (fixed password), transport HTTPS — isliye
// public route hai.
// ═══════════════════════════════════════════
app.get('/api/app-content/:path', async (req, res) => {
  try {
    const buf = await buildAppContent(req.params.path, 'popup');
    if (!buf) return res.status(404).send('not found');
    res.set('Content-Type', 'application/octet-stream');
    // NO CACHE — design edit karte hi sab apps ko turant naya content
    // milna chahiye. Pehle 'public, max-age=3600' tha — Cloudflare/phone
    // 1 ghanta purana content serve karte the, isi se design edit ke baad
    // bhi OLD design dikhta tha.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.send(buf);
  } catch (e) {
    res.status(500).send('error');
  }
});

app.get('/api/app-content/:path/loading', async (req, res) => {
  try {
    const buf = await buildAppContent(req.params.path, 'loading');
    if (!buf) return res.status(404).send('not found');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.send(buf);
  } catch (e) {
    res.status(500).send('error');
  }
});

app.get('/api/designs', (req, res) => {
  const designs = db.prepare(`
    SELECT id,name,description,price_coins,original_price_coins,fake_price_coins,
           category,preview_image,preview_video
    FROM designs WHERE active=1 ORDER BY id DESC
  `).all().map(withPreviewImages);
  res.json(designs);
});

app.get('/api/designs/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM designs WHERE id=? AND active=1').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(withPreviewImages(d));
});

// App name font styles — live preview ke liye (user + admin form dono use
// karte hain). Text transform karke styled sample return karta hai.
app.get('/api/font-styles', (req, res) => {
  const text = String(req.query.text || '').slice(0, 40) || 'Aa 123';
  res.json(FONT_STYLES.map(s => ({
    key: s.key,
    label: s.label,
    sample: applyFontStyle(text, s.key)
  })));
});

// ═══════════════════════════════════════════
// ORDER / BUILD ROUTES
// ═══════════════════════════════════════════

// Counter for package name uniqueness
let _pkgCounter = db.prepare('SELECT MAX(id) as m FROM orders').get()?.m || 0;

function calculateCouponDiscount(code, subtotal) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) return { code: '', discount: 0 };
  const c = db.prepare('SELECT * FROM coupons WHERE UPPER(code)=? AND active=1').get(clean);
  if (!c) throw new Error('Invalid coupon code');
  if (c.expires_at && new Date(c.expires_at).getTime() < Date.now()) throw new Error('Coupon expired');
  if (c.max_uses > 0 && c.used_count >= c.max_uses) throw new Error('Coupon usage limit reached');
  let discount = c.type === 'percent'
    ? Math.floor((subtotal * Math.max(0, c.value)) / 100)
    : Math.max(0, parseInt(c.value, 10) || 0);
  discount = Math.min(subtotal, discount);
  return { code: c.code, discount, coupon: c };
}

app.post('/api/coupons/validate', requireAuth, (req, res) => {
  try {
    const subtotal = Math.max(0, parseInt(req.body.subtotal, 10) || 0);
    const result = calculateCouponDiscount(req.body.code, subtotal);
    res.json({ success: true, code: result.code, discount: result.discount, total: Math.max(0, subtotal - result.discount) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/order', requireAuth, iconUpload.single('icon'), async (req, res) => {
  const { design_id, app_name, register_url, min_deposit, brand_title, fake_addon, fake_register_url } = req.body;
  if (!design_id || !app_name || !register_url) return res.json({ error: 'Missing required fields' });
  const appNameStyle = isValidStyle(req.body.app_name_style) ? req.body.app_name_style : 'normal';

  let cleanRegisterUrl;
  let cleanFakeRegisterUrl = null;
  try {
    cleanRegisterUrl = normalizeHttpUrl(register_url);
    if (fake_register_url) cleanFakeRegisterUrl = normalizeHttpUrl(fake_register_url);
  } catch (error) {
    return res.json({ error: error.message || 'Enter a valid http(s) register URL' });
  }

  const design = db.prepare('SELECT * FROM designs WHERE id=? AND active=1').get(design_id);
  if (!design) return res.json({ error: 'Design not found' });
  const isDhaniDesign = design.category === 'dhani' || design.java_type === 'dhani' || design.java_type === 'premium';

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found. Please login again.' });

  const fakeAddonEnabled = fake_addon === 'true' || fake_addon === true;
  const fakePrice = design.fake_price_coins > 0 ? design.fake_price_coins : parseInt(db.prepare('SELECT value FROM settings WHERE key=?').get('addon_fake_price')?.value || '5');
  const subtotalCoins = design.price_coins + (fakeAddonEnabled ? fakePrice : 0);
  let couponResult = { code: '', discount: 0 };
  try {
    couponResult = calculateCouponDiscount(req.body.coupon_code, subtotalCoins);
  } catch (error) {
    return res.json({ error: error.message });
  }
  const totalCoins = Math.max(0, subtotalCoins - couponResult.discount);

  if (fakeAddonEnabled && !cleanFakeRegisterUrl) return res.json({ error: 'Fake site register URL required' });
  if (user.coins < totalCoins) return res.json({ error: `Not enough coins. Need ${totalCoins}, have ${user.coins}` });

  const { buildUrls, extractDomain } = require('./utils/htmlprocessor');
  const { deposit: depositUrl, wingo: wingoUrl } = buildUrls(cleanRegisterUrl, isDhaniDesign);
  const domain = extractDomain(cleanRegisterUrl);

  _pkgCounter++;
  const packageName = makePackageName(app_name, _pkgCounter);
  const iconFile = req.file ? path.basename(req.file.path) : null;

  // Pehle order INSERT karo (temp path ke saath) — orderId ke baad UNIQUE
  // firebase path set hota hai. Same domain ke do orders ka path same
  // nahi ho sakta — warna dono apps ka content ek hi jagah se serve hota
  // hai (galat naam/content dikhne lagta hai).
  const tempPath = `zayro${domain.replace(/[^a-z0-9]/gi, '').substring(0, 10)}`;
  const orderResult = db.prepare(`
    INSERT INTO orders(user_id,design_id,app_name,package_name,register_url,deposit_url,wingo_url,domain,firebase_path,min_deposit,brand_title,icon_file,fake_register_url,fake_firebase_path,live_link_enabled,app_name_style,status,coins_spent,design_variant,coupon_code,discount_coins)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,'building',?,?,?,?)
  `).run(user.id, design_id, app_name.trim(), packageName, cleanRegisterUrl, depositUrl, wingoUrl, domain, tempPath, parseInt(min_deposit)||300, brand_title?.trim()||app_name.trim(), iconFile, fakeAddonEnabled ? cleanFakeRegisterUrl : null, null, appNameStyle, totalCoins, 'real', couponResult.code, couponResult.discount);
  const orderId = orderResult.lastInsertRowid;

  // UNIQUE paths (order id ke saath) — collisions impossible
  const firebasePath = `zayro${domain.replace(/[^a-z0-9]/gi, '').substring(0, 8)}${orderId}`;
  let fakeFirebasePath = null;
  if (fakeAddonEnabled && cleanFakeRegisterUrl) {
    const fakeDomain = extractDomain(cleanFakeRegisterUrl);
    fakeFirebasePath = `zayrof${fakeDomain.replace(/[^a-z0-9]/gi, '').substring(0, 8)}${orderId}`;
  }
  db.prepare('UPDATE orders SET firebase_path=?, fake_firebase_path=? WHERE id=?')
    .run(firebasePath, fakeFirebasePath, orderId);

  try {
    await updateFirebaseLinks(firebasePath, {
      registerUrl: cleanRegisterUrl,
      depositUrl,
      wingoUrl
    });
    if (fakeAddonEnabled && cleanFakeRegisterUrl) {
      const fakeUrls = buildUrls(cleanFakeRegisterUrl, isDhaniDesign);
      await updateFirebaseLinks(fakeFirebasePath, {
        registerUrl: cleanFakeRegisterUrl,
        depositUrl: fakeUrls.deposit,
        wingoUrl: fakeUrls.wingo
      });
    }
  } catch (error) {
    // Firebase fail — order row hatao, coins NAHI kate
    db.prepare('DELETE FROM orders WHERE id=?').run(orderId);
    return res.json({ error: `${error.message}. APK was not started and no coins were deducted.` });
  }

  db.prepare('UPDATE users SET coins = coins - ? WHERE id=?').run(totalCoins, user.id);
  if (couponResult.code && couponResult.discount > 0) {
    db.prepare('UPDATE coupons SET used_count=used_count+1 WHERE id=?').run(couponResult.coupon.id);
  }

  const buildId = `build_${orderId}_${Date.now()}`;

  res.json({ success: true, orderId, buildId, message: 'Build started' });

  // ── Build in background ──
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  const logs = [];
  const logPush = (msg) => { logs.push(msg); db.prepare('UPDATE orders SET build_log=? WHERE id=?').run(logs.join('\n'), orderId); };

  buildApk(order, design, buildId, logPush).then(async result => {
    if (result.success) {
      db.prepare('UPDATE orders SET apk_file=? WHERE id=?').run(result.apkFile, orderId);

      let fakeResult = null;
      // ── Fake APK build if addon enabled ──
      if (fakeAddonEnabled && cleanFakeRegisterUrl) {
        logPush('\n--- Building Fake APK (Fake 1) ---');
        const fakeOrder = makeFakeOrder(order, cleanFakeRegisterUrl,
          order.fake_firebase_path
            || `zayrof${extractDomain(cleanFakeRegisterUrl).replace(/[^a-z0-9]/gi,'').substring(0,8)}`,
          1, design);
        const fakeBuildId = buildId + '_fake';
        fakeResult = await buildApk(fakeOrder, design, fakeBuildId, logPush);
        if (fakeResult.success) {
          db.prepare('UPDATE orders SET fake_apk_file=? WHERE id=?').run(fakeResult.apkFile, orderId);
          logPush('Fake 1 APK ready!');
        } else {
          logPush('Fake 1 APK build failed: ' + fakeResult.error);
        }
      }

      db.prepare('UPDATE orders SET status=? WHERE id=?').run('done', orderId);
      // Send APK files via Telegram (instant)
      const apkPaths = [result.apkPath];
      if (fakeResult?.success) apkPaths.push(fakeResult.apkPath);
      sendApkReady(user, db.prepare('SELECT * FROM orders WHERE id=?').get(orderId), apkPaths, []).catch(() => {});
    } else {
      db.prepare('UPDATE orders SET status=? WHERE id=?').run('failed', orderId);
      db.prepare('UPDATE users SET coins = coins + ? WHERE id=?').run(totalCoins, user.id);
      if (couponResult.code && couponResult.discount > 0) db.prepare('UPDATE coupons SET used_count=MAX(0,used_count-1) WHERE id=?').run(couponResult.coupon.id);
    }
  }).catch(err => {
    db.prepare('UPDATE orders SET status=?,build_log=? WHERE id=?').run('failed', err.message, orderId);
    db.prepare('UPDATE users SET coins = coins + ? WHERE id=?').run(totalCoins, user.id);
    if (couponResult.code && couponResult.discount > 0) db.prepare('UPDATE coupons SET used_count=MAX(0,used_count-1) WHERE id=?').run(couponResult.coupon.id);
  });
});

app.get('/api/orders', requireAuth, (req, res) => {
  const orders = db.prepare(`
    SELECT o.id,o.app_name,o.package_name,o.status,o.apk_file,o.fake_apk_file,o.coins_spent,o.created_at,
           CASE WHEN o.live_link_enabled=1 THEN 1 ELSE 0 END AS live_link_enabled,
           d.name as design_name
    FROM orders o JOIN designs d ON o.design_id=d.id
    WHERE o.user_id=? ORDER BY o.id DESC
  `).all(req.session.userId);
  res.json(orders);
});

app.get('/api/orders/:id/status', requireAuth, (req, res) => {
  const o = db.prepare('SELECT id,status,apk_file,fake_apk_file,build_log FROM orders WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json(o);
});

function getDownloadableOrder(req) {
  // Normal users can download only their own APKs. Admin dashboard buttons use
  // the same download endpoints, so admin sessions must be allowed to fetch any
  // order by id; otherwise the route used to return the misleading "APK not ready".
  if (req.session.isAdmin) {
    return db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  }
  return db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
}

function findBuiltApk(fileName) {
  if (!fileName) return null;
  const safeFileName = path.basename(fileName);
  const buildsDir = path.join(__dirname, 'builds');
  if (!fs.existsSync(buildsDir)) return null;

  // Sabse NAYA build folder pehle check hota hai — same naam ki purani
  // APKs (purane orders/rebuilds ki) galti se serve na ho jayein.
  // Pehle readdir ke order pe bharosa tha — usme purana folder pehle aa
  // jata tha to download/Telegram purani APK de deta tha.
  const dirs = fs.readdirSync(buildsDir).filter(d => {
    try { return fs.statSync(path.join(buildsDir, d)).isDirectory(); } catch (_) { return false; }
  });
  const dirTs = d => {
    const m = String(d).match(/(\d{13})/g);
    if (m && m.length) return parseInt(m[m.length - 1], 10);
    try { return fs.statSync(path.join(buildsDir, d)).mtimeMs; } catch (_) { return 0; }
  };
  dirs.sort((a, b) => dirTs(b) - dirTs(a));
  for (const dir of dirs) {
    const apkPath = path.join(buildsDir, dir, safeFileName);
    if (fs.existsSync(apkPath)) return apkPath;
  }
  return null;
}

app.get('/api/orders/:id/download', requireAuth, (req, res) => {
  const o = getDownloadableOrder(req);
  // If apk_file is already written, the real APK is ready even while an optional
  // Fake APK is still building. Do not block real downloads on status === 'done'.
  if (!o || !o.apk_file) return res.status(404).json({ error: 'APK not ready' });
  const apkPath = findBuiltApk(o.apk_file);
  if (!apkPath) return res.status(404).json({ error: 'File not found' });
  res.download(apkPath, path.basename(o.apk_file));
});

app.get('/api/orders/:id/download-fake', requireAuth, (req, res) => {
  const o = getDownloadableOrder(req);
  if (!o || !o.fake_apk_file) return res.status(404).json({ error: 'Fake APK not ready' });
  const apkPath = findBuiltApk(o.fake_apk_file);
  if (!apkPath) return res.status(404).json({ error: 'File not found' });
  res.download(apkPath, path.basename(o.fake_apk_file));
});

function isDhaniOrder(order) {
  return order.design_category === 'dhani'
    || order.design_java_type === 'dhani'
    || order.design_java_type === 'premium';
}

// ── Fake site APK helpers (primary fake + multiple extra fake sites) ──
// Fake APK ke liye order object banata hai: apna register link, apna
// firebase path, apna NAAM ("Fake 1", "Fake 2"...) + unique package name
// (har fake site side-by-side install ho sake, sab alag dikhein).
function makeFakeOrder(order, registerUrl, firebasePath, fakeNumber, design) {
  const { buildUrls, extractDomain } = require('./utils/htmlprocessor');
  const isDhani = isDhaniOrder({ ...order, design_category: design?.category, design_java_type: design?.java_type });
  const urls = buildUrls(registerUrl, isDhani);
  const pkgBase = String(order.package_name || 'com.zayro.app').split('.').pop() || 'app';
  return {
    ...order,
    is_fake: true,
    app_name: order.app_name + ' Fake ' + fakeNumber,
    package_name: 'com.zayrof.' + pkgBase + 'f' + fakeNumber,
    register_url: registerUrl,
    deposit_url: urls.deposit,
    wingo_url: urls.wingo,
    domain: extractDomain(registerUrl),
    firebase_path: firebasePath
  };
}

// Fake numbering: primary fake (orders.fake_register_url) = Fake 1,
// extra sites (order_fake_sites, sort_order se) = Fake 2, 3, 4...
function getFakeNumber(order, siteId) {
  const sites = getOrderFakeSites(order.id);
  const hasPrimary = !!(order.fake_register_url && String(order.fake_register_url) !== '');
  const idx = sites.findIndex(s => s.id === siteId);
  return (hasPrimary ? 2 : 1) + (idx >= 0 ? idx : sites.length);
}

// Ek fake site row ke liye Firebase path banata hai (unique per site id)
function makeFakeSitePath(registerUrl, siteId) {
  const { extractDomain } = require('./utils/htmlprocessor');
  return `zayrof${extractDomain(registerUrl).replace(/[^a-z0-9]/gi, '').substring(0, 8)}s${siteId}`;
}

// Ek fake site (order_fake_sites row) ka APK build karta hai.
// Firebase links pehle likhta hai, phir build — success/fail row me update.
async function buildFakeSiteApk(order, design, site, buildIdSuffix, logPush) {
  const { buildUrls } = require('./utils/htmlprocessor');
  const isDhani = isDhaniOrder({ ...order, design_category: design.category, design_java_type: design.java_type });
  const urls = buildUrls(site.register_url, isDhani);
  try {
    await updateFirebaseLinks(site.firebase_path, {
      registerUrl: site.register_url,
      depositUrl: urls.deposit,
      wingoUrl: urls.wingo
    });
  } catch (error) {
    db.prepare('UPDATE order_fake_sites SET status=? WHERE id=?').run('failed', site.id);
    logPush(`Fake site #${site.id} Firebase write fail: ${error.message}`);
    return null;
  }
  db.prepare('UPDATE order_fake_sites SET status=? WHERE id=?').run('building', site.id);
  const fakeNumber = getFakeNumber(order, site.id);
  logPush(`\n--- Building Fake Site APK #${site.id} (Fake ${fakeNumber} — ${site.register_url}) ---`);
  const fakeOrder = makeFakeOrder(order, site.register_url, site.firebase_path, fakeNumber, design);
  const result = await buildApk(fakeOrder, design, buildIdSuffix, logPush);
  if (result.success) {
    db.prepare('UPDATE order_fake_sites SET apk_file=?, status=? WHERE id=?').run(result.apkFile, 'done', site.id);
    logPush(`Fake ${fakeNumber} APK ready!`);
    return result;
  }
  db.prepare('UPDATE order_fake_sites SET status=? WHERE id=?').run('failed', site.id);
  logPush(`Fake ${fakeNumber} build failed: ${result.error || 'Build failed'}`);
  return null;
}

// Firebase live-link update. New APKs read URL fields from the same
// <firebase_path>/config node that already controls deposit/register conditions,
// so the APK never depends on this builder server while running.
app.post('/api/orders/:id/change-domain', requireAuth, async (req, res) => {
  if (!req.body.new_register_url) return res.json({ error: 'New URL required' });

  const changeType = req.body.change_type === 'invite' ? 'invite' : 'domain';
  const order = db.prepare(`
    SELECT o.*,d.category AS design_category,d.java_type AS design_java_type
    FROM orders o JOIN designs d ON d.id=o.design_id
    WHERE o.id=? AND o.user_id=?
  `).get(req.params.id, req.session.userId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'done') return res.json({ error: 'Order must be completed first' });

  let newRegisterUrl;
  try {
    newRegisterUrl = changeType === 'domain'
      ? replaceUrlDomain(order.register_url, req.body.new_register_url)
      : normalizeHttpUrl(req.body.new_register_url);
  } catch (error) {
    return res.json({ error: error.message || 'Enter a valid http(s) URL' });
  }

  const priceKey = changeType === 'domain' ? 'domain_change_price' : 'invite_code_change_price';
  const price = parseInt(db.prepare('SELECT value FROM settings WHERE key=?').get(priceKey)?.value || '10');
  const countField = changeType === 'domain' ? 'domain_change_count' : 'invite_code_change_count';
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.json({ error: 'User not found' });

  const { buildUrls, extractDomain } = require('./utils/htmlprocessor');
  const { deposit: depositUrl, wingo: wingoUrl } = buildUrls(newRegisterUrl, isDhaniOrder(order));
  const domain = extractDomain(newRegisterUrl);
  const newLinks = { registerUrl: newRegisterUrl, depositUrl, wingoUrl };
  const oldLinks = {
    registerUrl: order.register_url,
    depositUrl: order.deposit_url,
    wingoUrl: order.wingo_url
  };

  const chargeUser = () => {
    const charged = db.prepare('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?')
      .run(price, user.id, price);
    if (!charged.changes) throw new Error(`Not enough coins. Need ${price}, have ${user.coins}`);
  };
  const refundUser = () => db.prepare('UPDATE users SET coins=coins+? WHERE id=?').run(price, user.id);

  try {
    chargeUser();
  } catch (error) {
    return res.json({ error: error.message });
  }

  try {
    await updateFirebaseLinks(order.firebase_path, newLinks);
  } catch (error) {
    refundUser();
    return res.json({ error: `${error.message}. Coins were refunded.` });
  }

  // Modern APK: Firebase has the new links; only mirror them in SQLite for the
  // dashboard. The APK file, status and installed app remain untouched.
  if (order.live_link_enabled === 1) {
    try {
      db.prepare(`
        UPDATE orders SET register_url=?,deposit_url=?,wingo_url=?,domain=?,
          build_log=?,${countField}=COALESCE(${countField},0)+1
        WHERE id=?
      `).run(
        newRegisterUrl, depositUrl, wingoUrl, domain,
        `Firebase ${changeType} link updated at ${new Date().toISOString()}`,
        order.id
      );
    } catch (error) {
      refundUser();
      try { await updateFirebaseLinks(order.firebase_path, oldLinks); } catch (_) {}
      return res.json({ error: `${error.message}. Coins were refunded.` });
    }

    return res.json({
      success: true,
      mode: 'instant',
      orderId: order.id,
      changeType,
      message: changeType === 'domain'
        ? 'Firebase domain updated. Invitation code was kept unchanged.'
        : 'Firebase register URL and invitation code updated.'
    });
  }

  // APKs built before this injected Firebase listener need one final upgrade.
  // Afterwards every update uses Firebase only and is instant.
  const buildId = `build_${order.id}_firebase_${Date.now()}`;
  try {
    db.prepare(`
      UPDATE orders SET register_url=?,deposit_url=?,wingo_url=?,domain=?,
        live_link_enabled=1,status='building',apk_file=NULL,build_log=?,
        ${countField}=COALESCE(${countField},0)+1
      WHERE id=?
    `).run(
      newRegisterUrl, depositUrl, wingoUrl, domain,
      `One-time Firebase ${changeType} link upgrade started...`, order.id
    );
  } catch (error) {
    refundUser();
    try { await updateFirebaseLinks(order.firebase_path, oldLinks); } catch (_) {}
    return res.json({ error: `${error.message}. Coins were refunded.` });
  }

  const updatedOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  const design = db.prepare('SELECT * FROM designs WHERE id=?').get(order.design_id);

  const restoreOldOrder = async errorMessage => {
    let firebaseRestoreError = '';
    try { await updateFirebaseLinks(order.firebase_path, oldLinks); }
    catch (error) { firebaseRestoreError = `; Firebase restore failed: ${error.message}`; }
    db.transaction(() => {
      refundUser();
      db.prepare(`
        UPDATE orders SET register_url=?,deposit_url=?,wingo_url=?,domain=?,
          live_link_enabled=0,status='done',apk_file=?,build_log=?,
          domain_change_count=?,invite_code_change_count=?
        WHERE id=?
      `).run(
        order.register_url, order.deposit_url, order.wingo_url, order.domain,
        order.apk_file, `Live-link upgrade failed: ${errorMessage}${firebaseRestoreError}`,
        order.domain_change_count || 0, order.invite_code_change_count || 0, order.id
      );
    })();
  };

  if (!design) {
    await restoreOldOrder('design not found');
    return res.json({ error: 'Design not found; coins were refunded' });
  }

  res.json({
    success: true,
    mode: 'upgrade',
    orderId: order.id,
    buildId,
    changeType,
    message: 'This old APK needs one final Firebase upgrade. Future link changes will be instant.'
  });

  const logs = [`One-time Firebase ${changeType} link upgrade started...`];
  const logPush = message => {
    logs.push(message);
    db.prepare('UPDATE orders SET build_log=? WHERE id=?').run(logs.join('\n'), order.id);
  };

  buildApk(updatedOrder, design, buildId, logPush).then(async result => {
    if (result.success) {
      db.prepare('UPDATE orders SET apk_file=?,status=?,build_log=? WHERE id=?')
        .run(result.apkFile, 'done', logs.concat('Firebase live-link upgrade complete!').join('\n'), order.id);
      // Purane build folders clear — abhi wala naya folder (buildId) aur
      // fake APK wala folder protect karte hain.
      deleteAllOrderBuildFolders(order, logPush, order.fake_apk_file ? [order.fake_apk_file] : [], buildId);
      sendApkReady(user, db.prepare('SELECT * FROM orders WHERE id=?').get(order.id), [result.apkPath], []).catch(() => {});
    } else {
      await restoreOldOrder(result.error || 'Build failed');
    }
  }).catch(error => restoreOldOrder(error.message));
});

// ═══════════════════════════════════════════
// COIN ROUTES
// ═══════════════════════════════════════════

app.get('/api/settings/payment', (req, res) => {
  const s = db.prepare('SELECT key,value FROM settings WHERE key IN (?,?,?,?,?,?)').all('upi_qr_image','upi_id','coin_rate','addon_fake_price','domain_change_price','invite_code_change_price');
  const result = {};
  s.forEach(r => result[r.key] = r.value);
  res.json(result);
});

app.post('/api/coins/request', requireAuth, iconUpload.single('screenshot'), async (req, res) => {
  if (req.session.isAdmin) return res.json({ error: 'Admin cannot submit coin requests' });
  const { coins, utr } = req.body;
  if (!coins || !utr) return res.json({ error: 'Coins and UTR required' });

  const rate   = parseFloat(db.prepare('SELECT value FROM settings WHERE key=?').get('coin_rate')?.value || '1');
  const amount = parseFloat(coins) * rate;

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.json({ error: 'User not found' });

  const screenshotFile = req.file ? path.basename(req.file.path) : '';
  const result = db.prepare(
    'INSERT INTO coin_requests(user_id,coins_requested,amount_paid,utr,screenshot_file) VALUES(?,?,?,?,?)'
  ).run(user.id, parseInt(coins), amount, utr.trim(), screenshotFile);

  const requestRow = db.prepare('SELECT * FROM coin_requests WHERE id=?').get(result.lastInsertRowid);
  const adminId    = db.prepare('SELECT value FROM settings WHERE key=?').get('telegram_admin_id')?.value
                     || process.env.TELEGRAM_ADMIN_CHAT_ID;
  const screenshotPath = screenshotFile ? path.join(__dirname, 'uploads', screenshotFile) : null;
  try {
    const msgId = await sendCoinRequest(adminId, user, requestRow, screenshotPath);
    if (msgId) db.prepare('UPDATE coin_requests SET telegram_msg_id=? WHERE id=?').run(msgId, requestRow.id);
  } catch(e) { /* Telegram not configured */ }

  res.json({ success: true, message: 'Request sent. Admin will approve soon.' });
});

// ═══════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════

// Designs CRUD
app.get('/api/admin/designs', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM designs ORDER BY id DESC').all().map(withPreviewImages));
});

app.post('/api/admin/designs', requireAdmin, adminUpload.fields([
  { name: 'preview_image', maxCount: 1 },
  { name: 'preview_video', maxCount: 1 },
  { name: 'preview_images', maxCount: 12 },
  { name: 'popup_html', maxCount: 1 },
  { name: 'fake_popup_html', maxCount: 1 }
]), async (req, res) => {
  const { name, description, price_coins } = req.body;
  if (!name || !price_coins) return res.json({ error: 'Name and price required' });
  const category = normalizeDesignCategory(req.body.category);
  const legacyJavaType = category === 'dhani' ? 'dhani' : 'normal';
  const original_price_coins = parseInt(req.body.original_price_coins || 0);
  const fake_price_coins = parseInt(req.body.fake_price_coins || 5);

  const templatesDir = path.join(__dirname, 'templates');
  let popupHtmlFile = req.body.popup_html_file || '';
  let fakePopupHtmlFile = '';

  if (req.files?.popup_html?.[0]) {
    const f = req.files.popup_html[0];
    const uniqueName = `${Date.now()}_${f.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const dest = path.join(templatesDir, uniqueName);
    fs.renameSync(f.path, dest);
    popupHtmlFile = uniqueName;
  }

  if (req.files?.fake_popup_html?.[0]) {
    const f = req.files.fake_popup_html[0];
    const uniqueName = `fake_${Date.now()}_${f.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const dest = path.join(templatesDir, uniqueName);
    fs.renameSync(f.path, dest);
    fakePopupHtmlFile = uniqueName;
  }

  let previewImage = '', previewVideo = '';
  if (req.files?.preview_image?.[0]) previewImage = path.basename(req.files.preview_image[0].path);
  if (req.files?.preview_video?.[0]) previewVideo = path.basename(req.files.preview_video[0].path);

  if (!popupHtmlFile) return res.json({ error: 'Popup HTML file required' });

  const designResult = db.prepare(`INSERT INTO designs(name,description,price_coins,original_price_coins,fake_price_coins,type,java_type,category,variant,popup_html_file,fake_popup_html_file,preview_image,preview_video)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(name, description||'', parseInt(price_coins), original_price_coins, fake_price_coins, 'normal', legacyJavaType, category, 'real', popupHtmlFile, fakePopupHtmlFile, previewImage, previewVideo);

  const galleryFiles = req.files?.preview_images || [];
  if (galleryFiles.length) {
    const insertPreview = db.prepare('INSERT INTO design_preview_images(design_id,file_name,sort_order) VALUES(?,?,?)');
    db.transaction(files => {
      files.forEach((file, index) => insertPreview.run(
        designResult.lastInsertRowid,
        path.basename(file.path),
        index
      ));
    })(galleryFiles);
  }

  res.json({ success: true, id: designResult.lastInsertRowid });
});

app.patch('/api/admin/designs/:id', requireAdmin, adminUpload.fields([
  { name: 'preview_image',    maxCount: 1 },
  { name: 'preview_video',    maxCount: 1 },
  { name: 'preview_images',   maxCount: 12 },
  { name: 'popup_html',       maxCount: 1 },
  { name: 'fake_popup_html',  maxCount: 1 }
]), (req, res) => {
  const templatesDir = path.join(__dirname, 'templates');
  const uploadsDir = path.join(__dirname, 'uploads');
  const { name, description, price_coins, original_price_coins, fake_price_coins, active, category } = req.body;

  // Get current design to know old file names
  const currentDesign = db.prepare('SELECT * FROM designs WHERE id=?').get(req.params.id);
  if (!currentDesign) return res.status(404).json({ error: 'Design not found' });
  const currentPreviewImages = designPreviewImagesStmt.all(req.params.id);
  const newGalleryFiles = req.files?.preview_images || [];

  const fields = [];
  const vals   = [];

  if (name             !== undefined) { fields.push('name=?');                   vals.push(name); }
  if (description      !== undefined) { fields.push('description=?');            vals.push(description); }
  if (price_coins      !== undefined) { fields.push('price_coins=?');            vals.push(parseInt(price_coins) || 0); }
  if (original_price_coins !== undefined) { fields.push('original_price_coins=?'); vals.push(parseInt(original_price_coins) || 0); }
  if (fake_price_coins !== undefined) { fields.push('fake_price_coins=?');       vals.push(parseInt(fake_price_coins) || 5); }
  if (active           !== undefined) { fields.push('active=?');                 vals.push(active === '1' || active === 1 || active === true ? 1 : 0); }
  if (category         !== undefined) {
    const normalizedCategory = normalizeDesignCategory(category, currentDesign);
    fields.push('category=?', 'type=?', 'java_type=?', 'variant=?');
    vals.push(normalizedCategory, 'normal', normalizedCategory === 'dhani' ? 'dhani' : 'normal', 'real');
  }

  // Track old files to delete after successful update
  const oldFilesToDelete = [];

  // handle file uploads — keep old file if no new one uploaded
  if (req.files?.popup_html?.[0]) {
    const f = req.files.popup_html[0];
    const uniqueName = `${Date.now()}_${f.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    fs.renameSync(f.path, path.join(templatesDir, uniqueName));
    fields.push('popup_html_file=?'); vals.push(uniqueName);
    // Mark old file for deletion (agar koi aur design/share use nahi kar raha)
    if (currentDesign.popup_html_file && !fileStillReferenced(currentDesign.popup_html_file, 'templates', currentDesign.id)) {
      oldFilesToDelete.push(path.join(templatesDir, currentDesign.popup_html_file));
    }
  }
  if (req.files?.fake_popup_html?.[0]) {
    const f = req.files.fake_popup_html[0];
    const uniqueName = `fake_${Date.now()}_${f.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    fs.renameSync(f.path, path.join(templatesDir, uniqueName));
    fields.push('fake_popup_html_file=?'); vals.push(uniqueName);
    if (currentDesign.fake_popup_html_file && !fileStillReferenced(currentDesign.fake_popup_html_file, 'templates', currentDesign.id)) {
      oldFilesToDelete.push(path.join(templatesDir, currentDesign.fake_popup_html_file));
    }
  }
  if (req.files?.preview_image?.[0]) {
    fields.push('preview_image=?');
    const newFileName = path.basename(req.files.preview_image[0].path);
    vals.push(newFileName);
    if (currentDesign.preview_image && !fileStillReferenced(currentDesign.preview_image, 'uploads', currentDesign.id)) {
      oldFilesToDelete.push(path.join(uploadsDir, currentDesign.preview_image));
    }
  }
  if (req.files?.preview_video?.[0]) {
    fields.push('preview_video=?');
    const newFileName = path.basename(req.files.preview_video[0].path);
    vals.push(newFileName);
    if (currentDesign.preview_video && !fileStillReferenced(currentDesign.preview_video, 'uploads', currentDesign.id)) {
      oldFilesToDelete.push(path.join(uploadsDir, currentDesign.preview_video));
    }
  }

  if (newGalleryFiles.length) {
    for (const row of currentPreviewImages) {
      // A legacy cover may also appear in the gallery. Keep it if the cover is
      // not being replaced, otherwise the design card would lose its image.
      if (row.file_name !== currentDesign.preview_image || req.files?.preview_image?.[0]) {
        if (!fileStillReferenced(row.file_name, 'uploads', currentDesign.id)) {
          oldFilesToDelete.push(path.join(uploadsDir, row.file_name));
        }
      }
    }
  }

  if (!fields.length && !newGalleryFiles.length) return res.json({ error: 'Nothing to update' });

  db.transaction(() => {
    if (fields.length) {
      db.prepare(`UPDATE designs SET ${fields.join(',')} WHERE id=?`).run(...vals, req.params.id);
    }
    if (newGalleryFiles.length) {
      db.prepare('DELETE FROM design_preview_images WHERE design_id=?').run(req.params.id);
      const insertPreview = db.prepare('INSERT INTO design_preview_images(design_id,file_name,sort_order) VALUES(?,?,?)');
      newGalleryFiles.forEach((file, index) => insertPreview.run(
        req.params.id,
        path.basename(file.path),
        index
      ));
    }
  })();

  // Delete old files after successful database update
  for (const filePath of oldFilesToDelete) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.error('Failed to delete old file:', filePath, e);
    }
  }

  res.json({ success: true });
});

app.delete('/api/admin/designs/:id', requireAdmin, (req, res) => {
  try {
    const design = withPreviewImages(db.prepare('SELECT * FROM designs WHERE id=?').get(req.params.id));
    if (!design) return res.status(404).json({ error: 'Design not found' });

    // Is design ke orders ke build folders/icon cleanup ke liye pehle
    // orders collect karo (rows delete hone ke baad nahi milenge)
    const designOrders = db.prepare('SELECT * FROM orders WHERE design_id=?').all(req.params.id);

    db.prepare('DELETE FROM orders WHERE design_id=?').run(req.params.id);
    db.prepare('DELETE FROM designs WHERE id=?').run(req.params.id);

    // Saare orders ke build folders + icons saaf karo
    for (const o of designOrders) {
      deleteOrderBuildFolders(o);
      deleteOrderIconIfUnused(o);
    }
    cleanupOrphanBuildFolders();

    // Design ke saare files delete karo — HTML (templates/), photo/video/
    // gallery (uploads/). Agar koi AUR design/order/setting file use kar
    // raha hai to use chhoda jata hai (shared files safe).
    const seen = new Set();
    const filesToDelete = [];
    const pushFile = (name, dir) => {
      if (!name) return;
      const key = dir + '/' + name;
      if (seen.has(key)) return;
      seen.add(key);
      filesToDelete.push({ name, dir });
    };
    pushFile(design.popup_html_file, 'templates');
    pushFile(design.fake_popup_html_file, 'templates');
    pushFile(design.preview_image, 'uploads');
    pushFile(design.preview_video, 'uploads');
    for (const fileName of (design?.preview_images || [])) pushFile(fileName, 'uploads');

    for (const { name, dir } of filesToDelete) {
      if (fileStillReferenced(name, dir, design.id)) continue;
      try {
        const filePath = path.join(__dirname, dir, name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (error) {
        console.error('Failed to delete design file:', name, error.message);
      }
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Content Links — har APK ka remote HTML URL (admin manage karta hai) ──
app.get('/api/admin/content-links', requireAdmin, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT o.id, o.app_name, o.firebase_path, o.fake_firebase_path, o.status,
             o.live_link_enabled, o.register_url, o.fake_register_url, u.username
      FROM orders o LEFT JOIN users u ON u.id = o.user_id
      ORDER BY o.id DESC LIMIT 500
    `).all();
    const base = String(process.env.BASE_URL || '').replace(/\/+$/, '');
    res.json(orders.map(o => ({
      id: o.id,
      app_name: o.app_name,
      username: o.username || '-',
      status: o.status,
      live_link_enabled: o.live_link_enabled,
      path: o.firebase_path || '',
      fake_path: o.fake_firebase_path || '',
      popup_url: o.firebase_path && base ? `${base}/api/app-content/${o.firebase_path}` : null,
      loading_url: o.firebase_path && base ? `${base}/api/app-content/${o.firebase_path}/loading` : null,
      fake_popup_url: o.fake_firebase_path && base ? `${base}/api/app-content/${o.fake_firebase_path}` : null,
      register_url: o.register_url,
      fake_register_url: o.fake_register_url
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FIREBASE SELF-TEST — server ka apna token kaam karta hai ya nahi ──
app.get('/api/admin/firebase/selftest', async (req, res) => {
  const secret = process.env.RESTORE_SECRET || '';
  const isAdmin = req.session && req.session.isAdmin;
  const hdrOk = secret.length > 0 && String(req.headers['x-restore-secret'] || '') === secret;
  if (!isAdmin && !hdrOk) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { getFirebaseAccessToken } = require('./utils/runtime-links');
    const token = await getFirebaseAccessToken();
    const dbUrl = String(process.env.FIREBASE_DATABASE_URL || 'https://zayrodev-195f3-default-rtdb.firebaseio.com').replace(/\/+$/, '');
    if (!token) return res.json({ ok: false, step: 'token', msg: 'Token nahi bana — SA file/env check karo' });
    // probe write (harmless) — server ke token se
    const u = `${dbUrl}/zayrobdgwinabiz/config.json?access_token=${encodeURIComponent(token)}`;
    const r = await fetch(u, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ probeServer: Date.now() }),
      signal: AbortSignal.timeout(15000)
    });
    const txt = await r.text();
    res.json({ ok: r.status === 200, step: 'write', status: r.status, detail: txt.slice(0, 120) });
  } catch (e) {
    res.json({ ok: false, step: 'error', msg: e.message });
  }
});

// ── FIREBASE RESTORE LINK — rules lage hain, isliye server ke token se ──
// Admin session YA x-restore-secret header (scripts/automation ke liye).
// .env me: RESTORE_SECRET=koi_bhi_random_value
app.post('/api/admin/firebase/restore-link', async (req, res) => {
  const secret = process.env.RESTORE_SECRET || '';
  const isAdmin = req.session && req.session.isAdmin;
  const hdrOk = secret.length > 0 && String(req.headers['x-restore-secret'] || '') === secret;
  if (!isAdmin && !hdrOk) return res.status(403).json({ error: 'Forbidden — admin login ya RESTORE_SECRET header chahiye' });
  const p = String(req.body.path || '').trim();
  const registerUrl = String(req.body.registerUrl || '').trim();
  const depositUrl = String(req.body.depositUrl || '').trim();
  const wingoUrl = String(req.body.wingoUrl || '').trim();
  if (!p || !registerUrl || !depositUrl || !wingoUrl) return res.json({ error: 'path, registerUrl, depositUrl, wingoUrl required' });
  try {
    const { updateFirebaseLinks, normalizeFirebasePath, normalizeHttpUrl } = require('./utils/runtime-links');
    await updateFirebaseLinks(normalizeFirebasePath(p), {
      registerUrl: normalizeHttpUrl(registerUrl),
      depositUrl: normalizeHttpUrl(depositUrl),
      wingoUrl: normalizeHttpUrl(wingoUrl)
    });
    res.json({ success: true, path: p });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Users
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id,username,email,coins,plain_password,telegram_id,created_at FROM users ORDER BY id DESC').all());
});

// ── TELEGRAM ID TRANSFER ──
// Admin kisi bhi user ka telegram_id change kar sakta hai — uske baad
// saare bot messages (APK ready, coin approvals, sab notifications) naye
// Telegram ID pe jayenge. Orders/coins user account (id) ke saath hi
// rehte hain, sirf delivery address badalta hai.
app.post('/api/admin/users/:id/telegram', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id,username,telegram_id FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.json({ error: 'User not found' });
  const newId = String(req.body.telegram_id || '').trim();
  if (newId !== '' && !/^[0-9]{5,15}$/.test(newId)) {
    return res.json({ error: 'Telegram ID sirf numbers me ho sakta hai (5-15 digits)' });
  }
  if (newId === String(user.telegram_id || '')) {
    return res.json({ error: 'Yahi purana ID hai — koi change nahi hua' });
  }
  if (newId !== '') {
    const clash = db.prepare('SELECT id,username FROM users WHERE telegram_id=? AND id<>?').get(newId, user.id);
    if (clash) {
      return res.json({ error: `Ye ID pehle se "${clash.username}" (id ${clash.id}) ke saath judi hai — pehle us user se ID hatao` });
    }
  }
  db.prepare('UPDATE users SET telegram_id=? WHERE id=?').run(newId === '' ? null : newId, user.id);
  res.json({ success: true, userId: user.id, username: user.username, oldId: user.telegram_id || null, newId: newId === '' ? null : newId });
});

app.post('/api/admin/users/:id/coins', requireAdmin, (req, res) => {
  const { amount, action } = req.body;
  if (!amount || !action) return res.json({ error: 'Amount and action required' });
  if (action === 'add') db.prepare('UPDATE users SET coins = coins + ? WHERE id=?').run(parseInt(amount), req.params.id);
  else if (action === 'set') db.prepare('UPDATE users SET coins=? WHERE id=?').run(parseInt(amount), req.params.id);
  else if (action === 'subtract') db.prepare('UPDATE users SET coins = MAX(0, coins - ?) WHERE id=?').run(parseInt(amount), req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  // User ke saare orders ke build folders/icon cleanup ke liye pehle
  // collect karo (rows delete hone ke baad nahi milenge)
  const userOrders = db.prepare('SELECT * FROM orders WHERE user_id=?').all(id);
  db.prepare('DELETE FROM coin_requests WHERE user_id=?').run(id);
  db.prepare('DELETE FROM orders WHERE user_id=?').run(id);
  const info = db.prepare('DELETE FROM users WHERE id=?').run(id);
  if (!info.changes) return res.json({ error: 'User not found' });
  for (const o of userOrders) {
    deleteOrderBuildFolders(o);
    deleteOrderIconIfUnused(o);
  }
  cleanupOrphanBuildFolders();
  res.json({ success: true });
});

// Coin requests
app.get('/api/admin/coin-requests', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT cr.*,u.username,u.email FROM coin_requests cr
    JOIN users u ON cr.user_id=u.id
    ORDER BY cr.id DESC
  `).all();
  res.json(rows);
});

app.post('/api/admin/coin-requests/:id/approve', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM coin_requests WHERE id=?').get(req.params.id);
  if (!row) return res.json({ error: 'Not found' });
  if (row.status !== 'pending') return res.json({ error: 'Already processed' });
  db.prepare('UPDATE coin_requests SET status=?,approved_by=? WHERE id=?').run('approved', 'admin', row.id);
  db.prepare('UPDATE users SET coins = coins + ? WHERE id=?').run(row.coins_requested, row.user_id);
  res.json({ success: true });
});

app.post('/api/admin/coin-requests/:id/reject', requireAdmin, (req, res) => {
  db.prepare('UPDATE coin_requests SET status=?,approved_by=? WHERE id=?').run('rejected', 'admin', req.params.id);
  res.json({ success: true });
});

// All orders with filters, search, pagination
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const {
    status,           // all, completed, failed, pending, building
    search,           // search by order ID, username, user ID, design name
    sort = 'desc',    // desc (newest first), asc (oldest first)
    page = 1,
    limit = 20
  } = req.query;

  let where = 'WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    if (status === 'completed') {
      where += ' AND o.status = ?';
      params.push('done');
    } else if (status === 'failed') {
      where += ' AND o.status = ?';
      params.push('failed');
    } else if (status === 'pending') {
      where += ' AND o.status = ?';
      params.push('pending');
    } else if (status === 'building') {
      where += ' AND o.status = ?';
      params.push('building');
    }
  }

  if (search) {
    where += ` AND (o.id LIKE ? OR u.username LIKE ? OR u.id LIKE ? OR d.name LIKE ?)`;
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm, searchTerm);
  }

  const orderBy = sort === 'asc' ? 'ASC' : 'DESC';
  const offset = (parseInt(page) - 1) * parseInt(limit);

  // Get total count
  const totalCount = db.prepare(`
    SELECT COUNT(*) as count FROM orders o
    JOIN users u ON o.user_id=u.id
    JOIN designs d ON o.design_id=d.id
    ${where}
  `).get(...params).count;

  // Get orders
  const rows = db.prepare(`
    SELECT o.*,u.username,d.name as design_name,d.category FROM orders o
    JOIN users u ON o.user_id=u.id
    JOIN designs d ON o.design_id=d.id
    ${where}
    ORDER BY o.id ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({
    orders: rows,
    pagination: {
      total: totalCount,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(totalCount / parseInt(limit))
    }
  });
});

// ── Helpers: remove order build folders completely ──
// Delete karte waqt sirf .apk file nahi — pura build folder hatate hain,
// taaki .idsig files aur khali folders bhi na bachhein.

// Order ke SAARE build folders (build_<id>_*) — rebuild/new-build se
// pehle ya delete pe. protectNames wale file names ka folder chhoda
// jata hai (e.g. fake APK jo rebuild nahi ho raha), exceptDir kabhi
// delete nahi hota (e.g. abhi wala naya build).
function deleteAllOrderBuildFolders(order, logFn, protectNames, exceptDir) {
  const buildsDir = path.join(__dirname, 'builds');
  if (!fs.existsSync(buildsDir)) return 0;
  const prefix = `build_${order.id}_`;
  const protect = new Set((protectNames || []).filter(Boolean));
  let removed = 0;
  for (const dir of fs.readdirSync(buildsDir)) {
    if (!dir.startsWith(prefix)) continue;
    if (exceptDir && dir === exceptDir) continue;
    const dirPath = path.join(buildsDir, dir);
    if (protect.size) {
      try {
        if (fs.readdirSync(dirPath).some(f => protect.has(f))) continue;
      } catch (_) {}
    }
    try { fs.rmSync(dirPath, { recursive: true, force: true }); removed++; } catch (_) {}
  }
  if (logFn && removed) logFn(`Old build folders cleared (${removed}).`);
  return removed;
}

function deleteOrderBuildFolders(order) {
  deleteAllOrderBuildFolders(order);
}

// Purane deletes se bache hue folders (sirf .idsig wale ya bilkul khali)
// bhi saaf kar dete hain.
function cleanupOrphanBuildFolders() {
  const buildsDir = path.join(__dirname, 'builds');
  if (!fs.existsSync(buildsDir)) return;
  for (const dir of fs.readdirSync(buildsDir)) {
    const dirPath = path.join(buildsDir, dir);
    let stat;
    try { stat = fs.statSync(dirPath); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(dirPath); } catch (_) { continue; }
    const junkOnly = files.every(f => f.toLowerCase().endsWith('.idsig'));
    if (files.length === 0 || junkOnly) {
      try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

// Kya ye file kisi AUR design/order/setting se abhi bhi use ho rahi hai?
// Shared files ko galti se delete nahi karte.
function fileStillReferenced(fileName, dir, ignoreDesignId) {
  try {
    if (dir === 'templates') {
      if (db.prepare('SELECT 1 FROM designs WHERE id<>? AND (popup_html_file=? OR fake_popup_html_file=?)')
        .get(ignoreDesignId, fileName, fileName)) return true;
      const s = db.prepare('SELECT value FROM settings WHERE key=?').get('loading_html_file');
      if (s && s.value === fileName) return true;
    } else {
      if (db.prepare('SELECT 1 FROM designs WHERE id<>? AND (preview_image=? OR preview_video=?)')
        .get(ignoreDesignId, fileName, fileName)) return true;
      if (db.prepare('SELECT 1 FROM design_preview_images WHERE file_name=? AND design_id<>?')
        .get(fileName, ignoreDesignId)) return true;
      if (db.prepare('SELECT 1 FROM orders WHERE icon_file=?').get(fileName)) return true;
    }
  } catch (_) {}
  return false;
}

// Order delete hone par uski uploaded icon file bhi saaf karo — par sirf
// agar koi AUR order usi icon ko use nahi kar raha.
function deleteOrderIconIfUnused(order) {
  const f = order?.icon_file;
  if (!f) return;
  try {
    if (db.prepare('SELECT 1 FROM orders WHERE icon_file=? AND id<>?').get(f, order.id)) return;
    const p = path.join(__dirname, 'uploads', f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
}

// Delete single order
app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Pura build folder + bache hue junk folders + icon delete karo
    deleteOrderBuildFolders(order);
    deleteOrderIconIfUnused(order);
    cleanupOrphanBuildFolders();

    // Delete order
    db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bulk delete orders
app.delete('/api/admin/orders', requireAdmin, (req, res) => {
  const { ids } = req.body; // array of order IDs
  if (!Array.isArray(ids) || !ids.length) return res.json({ error: 'No IDs provided' });

  try {
    // Pura build folder + icon delete karo har order ke liye
    for (const id of ids) {
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      if (order) {
        deleteOrderBuildFolders(order);
        deleteOrderIconIfUnused(order);
      }
    }
    cleanupOrphanBuildFolders();

    // Delete orders
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM orders WHERE id IN (${placeholders})`).run(...ids);
    res.json({ success: true, deleted: ids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// User-wise orders
app.get('/api/admin/users/:id/orders', requireAdmin, (req, res) => {
  const userId = req.params.id;
  const user = db.prepare('SELECT id,username,email,coins,plain_password,created_at FROM users WHERE id=?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const orders = db.prepare(`
    SELECT o.*,d.name as design_name,d.category FROM orders o
    JOIN designs d ON o.design_id=d.id
    WHERE o.user_id=? ORDER BY o.id DESC
  `).all(userId);

  // Har order ke extra fake sites bhi bhejo (multiple fake APKs)
  for (const o of orders) {
    o.fake_sites = getOrderFakeSites(o.id).map(s => ({ ...s, fake_number: getFakeNumber(o, s.id) }));
    o.fake_sites_count = o.fake_sites.length;
  }

  const stats = {
    total: orders.length,
    completed: orders.filter(o => o.status === 'done').length,
    failed: orders.filter(o => o.status === 'failed').length,
    pending: orders.filter(o => o.status === 'pending').length,
    building: orders.filter(o => o.status === 'building').length
  };

  res.json({ user, orders, stats });
});

function getOrderFirebaseTarget(order, variant = 'real') {
  const { buildUrls, extractDomain } = require('./utils/htmlprocessor');
  const v = String(variant || 'real');
  if (v === 'fake') {
    if (!order.fake_register_url) throw new Error('This order has no Fake APK');
    const domain = extractDomain(order.fake_register_url);
    const firebasePath = order.fake_firebase_path
      || `zayrof${domain.replace(/[^a-z0-9]/gi, '').substring(0, 8)}`;
    return {
      variant: 'fake',
      fakeNumber: 1,
      firebasePath,
      registerUrl: order.fake_register_url,
      urls: buildUrls(order.fake_register_url, isDhaniOrder(order))
    };
  }
  // Extra fake site: variant = 'fs<siteId>' (Fake 2, 3, ...)
  if (/^fs\d+$/.test(v)) {
    const fsid = parseInt(v.slice(2), 10);
    const site = db.prepare('SELECT * FROM order_fake_sites WHERE id=? AND order_id=?').get(fsid, order.id);
    if (!site) throw new Error('Fake site not found');
    return {
      variant: v,
      fakeNumber: getFakeNumber(order, fsid),
      fakeSiteId: fsid,
      firebasePath: site.firebase_path,
      registerUrl: site.register_url,
      urls: buildUrls(site.register_url, isDhaniOrder(order))
    };
  }
  return {
    variant: 'real',
    firebasePath: order.firebase_path,
    registerUrl: order.register_url,
    urls: { deposit: order.deposit_url, wingo: order.wingo_url }
  };
}

function getAdminOrder(orderId) {
  return db.prepare(`
    SELECT o.*,u.username,d.name AS design_name,
      d.category AS design_category,d.java_type AS design_java_type
    FROM orders o JOIN users u ON u.id=o.user_id JOIN designs d ON d.id=o.design_id
    WHERE o.id=?
  `).get(orderId);
}

function rebuildOrderInBackground(orderId, rebuildFake = true) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  const design = order ? db.prepare('SELECT * FROM designs WHERE id=?').get(order.design_id) : null;
  const user = order ? db.prepare('SELECT * FROM users WHERE id=?').get(order.user_id) : null;
  if (!order || !design || !user) throw new Error('Order, design or user not found');
  const buildId = `build_${order.id}_rebuild_${Date.now()}`;
  const logs = ['Admin one-click rebuild started...'];
  const logPush = msg => { logs.push(msg); db.prepare('UPDATE orders SET build_log=? WHERE id=?').run(logs.join('\n'), order.id); };
  db.prepare("UPDATE orders SET status='building',apk_file=NULL,fake_apk_file=CASE WHEN fake_register_url IS NOT NULL AND fake_register_url<>'' THEN NULL ELSE fake_apk_file END,build_log=? WHERE id=?")
    .run(logs.join('\n'), order.id);

  // Har rebuild se pehle is order ke PURANE build folders saaf karo —
  // warna har rebuild naya folder banata hai aur purane pade rehte hain
  // (build_<id>_rebuild_<ts> ka dher lag jata hai). Fake APK rebuild nahi
  // ho raha ho to uske folder ko protect karte hain.
  const fakeProtected = order.fake_apk_file && !(order.fake_register_url && String(order.fake_register_url) !== '');
  deleteAllOrderBuildFolders(order, logPush, fakeProtected ? [order.fake_apk_file] : []);

  // ── PATH COLLISION FIX ──
  // Purane orders (domain se path bane the) me same domain ke do orders
  // ka firebase_path SAME ho sakta hai — phir dono apps ka content ek hi
  // jagah se serve hota hai (galat naam/content). Rebuild pe unique path
  // (orderId ke saath) + Firebase config likh dete hain.
  (async () => {
    const { buildUrls, extractDomain } = require('./utils/htmlprocessor');
    if (order.firebase_path) {
      const clash = db.prepare('SELECT id FROM orders WHERE firebase_path=? AND id<>? LIMIT 1')
        .get(order.firebase_path, order.id);
      if (clash) {
        const np = `zayro${String(order.domain || '').replace(/[^a-z0-9]/gi, '').substring(0, 8)}${order.id}`;
        logPush(`Firebase path clash mila (order ${clash.id} ke saath) — unique path: ${np}`);
        order.firebase_path = np;
        db.prepare('UPDATE orders SET firebase_path=? WHERE id=?').run(np, order.id);
        try {
          await updateFirebaseLinks(np, { registerUrl: order.register_url, depositUrl: order.deposit_url, wingoUrl: order.wingo_url });
        } catch (e) { logPush('Path fix Firebase write fail: ' + e.message); }
      }
    }
    if (order.fake_firebase_path && order.fake_register_url) {
      const clash = db.prepare('SELECT id FROM orders WHERE fake_firebase_path=? AND id<>? LIMIT 1')
        .get(order.fake_firebase_path, order.id);
      if (clash) {
        const np = `zayrof${String(extractDomain(order.fake_register_url)).replace(/[^a-z0-9]/gi, '').substring(0, 8)}${order.id}`;
        logPush(`Fake path clash mila (order ${clash.id} ke saath) — unique path: ${np}`);
        order.fake_firebase_path = np;
        db.prepare('UPDATE orders SET fake_firebase_path=? WHERE id=?').run(np, order.id);
        const fu = buildUrls(order.fake_register_url, isDhaniOrder({ ...order, design_category: design.category, design_java_type: design.java_type }));
        try {
          await updateFirebaseLinks(np, { registerUrl: order.fake_register_url, depositUrl: fu.deposit, wingoUrl: fu.wingo });
        } catch (e) { logPush('Fake path fix Firebase write fail: ' + e.message); }
      }
    }
    return buildApk(order, design, buildId, logPush);
  })().then(async result => {
    if (!result.success) {
      db.prepare('UPDATE orders SET status=?,build_log=? WHERE id=?').run('failed', logs.concat('Rebuild failed: ' + (result.error || 'Build failed')).join('\n'), order.id);
      return;
    }
    db.prepare('UPDATE orders SET apk_file=? WHERE id=?').run(result.apkFile, order.id);
    const apkPaths = [result.apkPath];
    let fakeResult = null;
    if (rebuildFake && order.fake_register_url) {
      const { extractDomain } = require('./utils/htmlprocessor');
      logPush('\n--- Rebuilding Fake APK (Fake 1) ---');
      const fakeOrder = makeFakeOrder(order, order.fake_register_url,
        order.fake_firebase_path || `zayrof${extractDomain(order.fake_register_url).replace(/[^a-z0-9]/gi,'').substring(0,8)}`,
        1, design);
      fakeResult = await buildApk(fakeOrder, design, buildId + '_fake', logPush);
      if (fakeResult.success) {
        db.prepare('UPDATE orders SET fake_apk_file=? WHERE id=?').run(fakeResult.apkFile, order.id);
        apkPaths.push(fakeResult.apkPath);
      } else {
        logPush('Fake 1 APK rebuild failed: ' + (fakeResult.error || 'Build failed'));
      }
    }
    // ── EXTRA FAKE SITES bhi rebuild karo (har site ka apna APK) ──
    for (const site of getOrderFakeSites(order.id)) {
      const fr = await buildFakeSiteApk(order, design, site, buildId + '_fakeS' + site.id, logPush);
      if (fr) apkPaths.push(fr.apkPath);
    }
    db.prepare('UPDATE orders SET status=?,build_log=? WHERE id=?').run('done', logs.concat('Admin rebuild complete!').join('\n'), order.id);
    sendApkReady(user, db.prepare('SELECT * FROM orders WHERE id=?').get(order.id), apkPaths, []).catch(() => {});
  }).catch(error => {
    db.prepare('UPDATE orders SET status=?,build_log=? WHERE id=?').run('failed', logs.concat('Rebuild crashed: ' + error.message).join('\n'), order.id);
  });
  return { buildId };
}

app.post('/api/admin/orders/:id/rebuild', requireAdmin, (req, res) => {
  try {
    const result = rebuildOrderInBackground(req.params.id, req.body.rebuild_fake !== false);
    res.json({ success: true, message: 'Rebuild started', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── FAKE SITES (multiple) management ──
// Order me jitne chahe utne extra fake sites — har ek ka apna APK + link.

function getOrderFakeSites(orderId) {
  return db.prepare('SELECT * FROM order_fake_sites WHERE order_id=? ORDER BY sort_order ASC, id ASC').all(orderId);
}

app.get('/api/admin/orders/:id/fake-sites', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(getOrderFakeSites(req.params.id).map(s => ({
    ...s,
    fake_number: getFakeNumber(order, s.id)
  })));
});

// Naye fake sites add karo + har ek ka APK build (background me)
app.post('/api/admin/orders/:id/fake-sites', requireAdmin, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const design = db.prepare('SELECT * FROM designs WHERE id=?').get(order.design_id);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(order.user_id);

  let urls = [];
  try {
    if (req.body.register_urls) {
      const arr = typeof req.body.register_urls === 'string' ? JSON.parse(req.body.register_urls) : req.body.register_urls;
      if (!Array.isArray(arr)) throw new Error('register_urls array hona chahiye');
      urls = arr.map(u => normalizeHttpUrl(String(u || '').trim()));
    } else if (req.body.register_url) {
      urls = [normalizeHttpUrl(String(req.body.register_url).trim())];
    }
    if (!urls.length) throw new Error('Kam se kam ek fake site URL do');
    if (urls.length > 10) throw new Error('Max 10 fake sites ek baar me add kar sakte ho');
  } catch (error) {
    return res.json({ error: error.message || 'Valid http(s) URL do' });
  }

  const inserted = [];
  for (const url of urls) {
    const fsid = db.prepare('INSERT INTO order_fake_sites(order_id, register_url, status) VALUES(?,?,?)')
      .run(order.id, url, 'pending').lastInsertRowid;
    const fspath = makeFakeSitePath(url, fsid);
    db.prepare('UPDATE order_fake_sites SET firebase_path=?, sort_order=? WHERE id=?').run(fspath, fsid, fsid);
    inserted.push(db.prepare('SELECT * FROM order_fake_sites WHERE id=?').get(fsid));
  }

  res.json({ success: true, added: inserted.length, sites: inserted, message: 'Fake sites added — builds started' });

  // Background: har site ka APK banao (sequentially)
  const buildId = `build_${order.id}_fakesites_${Date.now()}`;
  const logs = [];
  const logPush = msg => { logs.push(msg); db.prepare('UPDATE orders SET build_log=? WHERE id=?').run(logs.join('\n'), order.id); };
  (async () => {
    logPush(`Fake sites build started (${inserted.length} site)...`);
    const apkPaths = [];
    for (const site of inserted) {
      const fr = await buildFakeSiteApk(order, design, site, buildId + '_fakeS' + site.id, logPush);
      if (fr) apkPaths.push(fr.apkPath);
    }
    logPush('Fake sites build done.');
    if (apkPaths.length) sendApkReady(user, order, apkPaths, []).catch(() => {});
  })().catch(error => {
    db.prepare('UPDATE orders SET build_log=? WHERE id=?').run(logs.concat('Fake sites build crashed: ' + error.message).join('\n'), order.id);
  });
});

// Ek fake site delete karo (APK folder + file bhi)
app.delete('/api/admin/orders/:id/fake-sites/:fsid', requireAdmin, (req, res) => {
  const site = db.prepare('SELECT * FROM order_fake_sites WHERE id=? AND order_id=?').get(req.params.fsid, req.params.id);
  if (!site) return res.status(404).json({ error: 'Fake site not found' });

  // Is site ke APK wale build folders delete karo (apk_file se match)
  if (site.apk_file) {
    const buildsDir = path.join(__dirname, 'builds');
    if (fs.existsSync(buildsDir)) {
      for (const dir of fs.readdirSync(buildsDir)) {
        const dirPath = path.join(buildsDir, dir);
        try {
          if (fs.statSync(dirPath).isDirectory() && fs.readdirSync(dirPath).includes(site.apk_file)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    }
  }
  db.prepare('DELETE FROM order_fake_sites WHERE id=?').run(site.id);
  res.json({ success: true });
});

// Fake site APK download (admin)
app.get('/api/admin/orders/:id/fake-sites/:fsid/download', requireAdmin, (req, res) => {
  const site = db.prepare('SELECT * FROM order_fake_sites WHERE id=? AND order_id=?').get(req.params.fsid, req.params.id);
  if (!site || !site.apk_file) return res.status(404).json({ error: 'Fake site APK not ready' });
  const apkPath = findBuiltApk(site.apk_file);
  if (!apkPath) return res.status(404).json({ error: 'File not found' });
  res.download(apkPath, path.basename(site.apk_file));
});

// ── ADMIN: Create order for ANY user from scratch (FREE — 0 coins) ──
// Admin panel me user select karke direct order banaya ja sakta hai, bina
// user ke koi request kiye. Isme user ke coins NAHI katte (free admin order).
app.post('/api/admin/orders/create', requireAdmin, iconUpload.single('icon'), async (req, res) => {
  const { user_id, design_id, app_name, register_url, min_deposit, brand_title, fake_addon, fake_register_url } = req.body;
  if (!user_id || !design_id || !app_name || !register_url) return res.json({ error: 'Missing required fields (user, design, app name, register URL)' });
  const appNameStyle = isValidStyle(req.body.app_name_style) ? req.body.app_name_style : 'normal';

  let cleanRegisterUrl;
  let cleanFakeRegisterUrl = null;
  let extraFakeUrls = [];
  try {
    cleanRegisterUrl = normalizeHttpUrl(register_url);
    if (fake_register_url) cleanFakeRegisterUrl = normalizeHttpUrl(fake_register_url);
    // Extra fake sites — JSON array (jitne chahe utne, max 10)
    if (req.body.fake_sites) {
      const arr = typeof req.body.fake_sites === 'string' ? JSON.parse(req.body.fake_sites) : req.body.fake_sites;
      if (!Array.isArray(arr)) throw new Error('fake_sites array hona chahiye');
      extraFakeUrls = arr.map(u => normalizeHttpUrl(String(u || '').trim())).filter(u => u);
      if (extraFakeUrls.length > 10) throw new Error('Max 10 extra fake sites allowed');
    }
  } catch (error) {
    return res.json({ error: error.message || 'Enter a valid http(s) register URL' });
  }

  const design = db.prepare('SELECT * FROM designs WHERE id=? AND active=1').get(design_id);
  if (!design) return res.json({ error: 'Design not found' });
  const isDhaniDesign = design.category === 'dhani' || design.java_type === 'dhani' || design.java_type === 'premium';

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(user_id);
  if (!user) return res.json({ error: 'User not found' });

  const fakeAddonEnabled = fake_addon === 'true' || fake_addon === true;
  if (fakeAddonEnabled && !cleanFakeRegisterUrl) return res.json({ error: 'Fake site register URL required' });

  const { buildUrls, extractDomain } = require('./utils/htmlprocessor');
  const { deposit: depositUrl, wingo: wingoUrl } = buildUrls(cleanRegisterUrl, isDhaniDesign);
  const domain = extractDomain(cleanRegisterUrl);

  _pkgCounter++;
  const packageName = makePackageName(app_name, _pkgCounter);
  const iconFile = req.file ? path.basename(req.file.path) : null;

  // FREE order — coins_spent = 0, koi deduction nahi. Temp path ke saath
  // INSERT, phir orderId wala UNIQUE path set hota hai.
  const tempPath = `zayro${domain.replace(/[^a-z0-9]/gi, '').substring(0, 10)}`;
  const orderResult = db.prepare(`
    INSERT INTO orders(user_id,design_id,app_name,package_name,register_url,deposit_url,wingo_url,domain,firebase_path,min_deposit,brand_title,icon_file,fake_register_url,fake_firebase_path,live_link_enabled,app_name_style,status,coins_spent,design_variant,coupon_code,discount_coins)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,'building',0,'real','',0)
  `).run(user.id, design_id, app_name.trim(), packageName, cleanRegisterUrl, depositUrl, wingoUrl, domain, tempPath, parseInt(min_deposit) || 300, brand_title?.trim() || app_name.trim(), iconFile, fakeAddonEnabled ? cleanFakeRegisterUrl : null, null, appNameStyle);

  const orderId = orderResult.lastInsertRowid;

  // UNIQUE paths (order id ke saath) — same domain ke do orders clash
  // nahi karenge, har app ko apna content milega
  const firebasePath = `zayro${domain.replace(/[^a-z0-9]/gi, '').substring(0, 8)}${orderId}`;
  let fakeFirebasePath = null;
  if (fakeAddonEnabled && cleanFakeRegisterUrl) {
    const fakeDomain = extractDomain(cleanFakeRegisterUrl);
    fakeFirebasePath = `zayrof${fakeDomain.replace(/[^a-z0-9]/gi, '').substring(0, 8)}${orderId}`;
  }
  db.prepare('UPDATE orders SET firebase_path=?, fake_firebase_path=? WHERE id=?')
    .run(firebasePath, fakeFirebasePath, orderId);

  try {
    await updateFirebaseLinks(firebasePath, { registerUrl: cleanRegisterUrl, depositUrl, wingoUrl });
    if (fakeAddonEnabled && cleanFakeRegisterUrl) {
      const fakeUrls = buildUrls(cleanFakeRegisterUrl, isDhaniDesign);
      await updateFirebaseLinks(fakeFirebasePath, {
        registerUrl: cleanFakeRegisterUrl,
        depositUrl: fakeUrls.deposit,
        wingoUrl: fakeUrls.wingo
      });
    }
  } catch (error) {
    db.prepare('DELETE FROM orders WHERE id=?').run(orderId);
    return res.json({ error: `${error.message}. Order not created.` });
  }

  const buildId = `build_${orderId}_${Date.now()}`;

  res.json({ success: true, orderId, buildId, message: 'FREE order created — build started' });

  // ── Build in background (same pipeline as user orders) ──
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  const logs = [];
  const logPush = (msg) => { logs.push(msg); db.prepare('UPDATE orders SET build_log=? WHERE id=?').run(logs.join('\n'), orderId); };

  buildApk(order, design, buildId, logPush).then(async result => {
    if (result.success) {
      db.prepare('UPDATE orders SET apk_file=? WHERE id=?').run(result.apkFile, orderId);

      let fakeResult = null;
      if (fakeAddonEnabled && cleanFakeRegisterUrl) {
        logPush('\n--- Building Fake APK ---');
        const fakeOrder = {
          ...order,
          is_fake: true,
          app_name: order.app_name + ' Fake',
          package_name: 'com.zayrof.' + packageName.split('.').pop(),
          register_url: cleanFakeRegisterUrl,
          deposit_url: buildUrls(cleanFakeRegisterUrl, isDhaniDesign).deposit,
          wingo_url: buildUrls(cleanFakeRegisterUrl, isDhaniDesign).wingo,
          domain: extractDomain(cleanFakeRegisterUrl),
          firebase_path: order.fake_firebase_path
            || `zayrof${extractDomain(cleanFakeRegisterUrl).replace(/[^a-z0-9]/gi, '').substring(0, 8)}`
        };
        fakeResult = await buildApk(fakeOrder, design, buildId + '_fake', logPush);
        if (fakeResult.success) {
          db.prepare('UPDATE orders SET fake_apk_file=? WHERE id=?').run(fakeResult.apkFile, orderId);
          logPush('Fake APK ready!');
        } else {
          logPush('Fake APK build failed: ' + fakeResult.error);
        }
      }

      // ── MULTIPLE EXTRA FAKE SITES — har site ka apna APK ──
      const apkPaths = [result.apkPath];
      for (let i = 0; i < extraFakeUrls.length; i++) {
        const url = extraFakeUrls[i];
        const insertFs = db.prepare('INSERT INTO order_fake_sites(order_id, register_url, status, sort_order) VALUES(?,?,?,?)');
        const fsid = insertFs.run(orderId, url, 'building', i).lastInsertRowid;
        const fspath = makeFakeSitePath(url, fsid);
        db.prepare('UPDATE order_fake_sites SET firebase_path=?, deposit_url=?, wingo_url=?, domain=? WHERE id=?')
          .run(fspath, buildUrls(url, isDhaniDesign).deposit, buildUrls(url, isDhaniDesign).wingo, extractDomain(url), fsid);
        const site = db.prepare('SELECT * FROM order_fake_sites WHERE id=?').get(fsid);
        const fr = await buildFakeSiteApk(order, design, site, buildId + '_fakeS' + fsid, logPush);
        if (fr) apkPaths.push(fr.apkPath);
      }

      db.prepare('UPDATE orders SET status=? WHERE id=?').run('done', orderId);
      // Send APK files via Telegram (instant)
      if (fakeResult?.success) apkPaths.push(fakeResult.apkPath);
      sendApkReady(user, db.prepare('SELECT * FROM orders WHERE id=?').get(orderId), apkPaths, []).catch(() => {});
    } else {
      db.prepare('UPDATE orders SET status=? WHERE id=?').run('failed', orderId);
    }
  }).catch(err => {
    db.prepare('UPDATE orders SET status=?,build_log=? WHERE id=?').run('failed', err.message, orderId);
  });
});


// Complete Firebase manager for each APK from Admin > Users > APKs.
// variant: 'real' | 'fake' (Fake 1) | 'fs<id>' (Fake 2, 3, ...)
app.get('/api/admin/orders/:id/firebase', requireAdmin, async (req, res) => {
  const order = getAdminOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const rawVariant = String(req.query.variant || 'real');
    const variant = rawVariant === 'fake' || /^fs\d+$/.test(rawVariant) ? rawVariant : 'real';
    const target = getOrderFirebaseTarget(order, variant);
    const state = await getFirebaseControl(target.firebasePath);
    const users = Object.entries(state.users).map(([key, value]) => ({ key, value }));
    users.sort((a, b) => a.key.localeCompare(b.key));
    // Fake variants list — UI me "Fake 1", "Fake 2"... dikhane ke liye
    const fake_sites = getOrderFakeSites(order.id).map(s => ({
      id: s.id,
      fake_number: getFakeNumber(order, s.id),
      register_url: s.register_url,
      firebase_path: s.firebase_path
    }));
    res.json({
      order: {
        id: order.id,
        app_name: order.app_name,
        username: order.username,
        design_name: order.design_name,
        has_fake: !!order.fake_register_url,
        fake_sites,
        live_link_enabled: order.live_link_enabled === 1
      },
      variant: target.variant,
      fake_number: target.fakeNumber || null,
      firebase_path: target.firebasePath,
      register_url: target.registerUrl,
      config: {
        minDeposit: state.config.minDeposit ?? order.min_deposit,
        depositCondition: state.config.depositCondition ?? true,
        registerCondition: state.config.registerCondition ?? true,
        registerUrl: state.config.registerUrl || '',
        depositUrl: state.config.depositUrl || '',
        wingoUrl: state.config.wingoUrl || ''
      },
      users
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.patch('/api/admin/orders/:id/firebase/link', requireAdmin, async (req, res) => {
  const order = getAdminOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const rawVariant = String(req.body.variant || 'real');
  const variant = rawVariant === 'fake' || /^fs\d+$/.test(rawVariant) ? rawVariant : 'real';
  const changeType = req.body.change_type === 'invite' ? 'invite' : 'domain';
  try {
    const target = getOrderFirebaseTarget(order, variant);
    const registerUrl = changeType === 'domain'
      ? replaceUrlDomain(target.registerUrl, req.body.new_register_url)
      : normalizeHttpUrl(req.body.new_register_url);
    const { buildUrls, extractDomain } = require('./utils/htmlprocessor');
    const urls = buildUrls(registerUrl, isDhaniOrder(order));
    await updateFirebaseLinks(target.firebasePath, {
      registerUrl,
      depositUrl: urls.deposit,
      wingoUrl: urls.wingo
    });
    if (target.fakeSiteId) {
      // Extra fake site — uski row update karo (path wahi rehta hai)
      db.prepare('UPDATE order_fake_sites SET register_url=?,deposit_url=?,wingo_url=?,domain=? WHERE id=?')
        .run(registerUrl, urls.deposit, urls.wingo, extractDomain(registerUrl), target.fakeSiteId);
    } else if (variant === 'fake') {
      db.prepare('UPDATE orders SET fake_register_url=?,fake_firebase_path=? WHERE id=?')
        .run(registerUrl, target.firebasePath, order.id);
    } else {
      db.prepare('UPDATE orders SET register_url=?,deposit_url=?,wingo_url=?,domain=? WHERE id=?')
        .run(registerUrl, urls.deposit, urls.wingo, extractDomain(registerUrl), order.id);
    }
    res.json({ success: true, register_url: registerUrl, change_type: changeType });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/admin/orders/:id/firebase/config', requireAdmin, async (req, res) => {
  const order = getAdminOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const rawVariant = String(req.body.variant || 'real');
    const target = getOrderFirebaseTarget(order, rawVariant === 'fake' || /^fs\d+$/.test(rawVariant) ? rawVariant : 'real');
    const values = {
      minDeposit: req.body.min_deposit,
      depositCondition: req.body.deposit_condition === true || req.body.deposit_condition === 'true',
      registerCondition: req.body.register_condition === true || req.body.register_condition === 'true'
    };
    const updated = await updateFirebaseControl(target.firebasePath, values);
    if (target.variant === 'real' && updated.minDeposit !== undefined) {
      db.prepare('UPDATE orders SET min_deposit=? WHERE id=?').run(updated.minDeposit, order.id);
    }
    res.json({ success: true, config: updated });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/orders/:id/firebase/users', requireAdmin, async (req, res) => {
  const order = getAdminOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const rawVariant = String(req.body.variant || 'real');
    const target = getOrderFirebaseTarget(order, rawVariant === 'fake' || /^fs\d+$/.test(rawVariant) ? rawVariant : 'real');
    const user = await addFirebaseUser(target.firebasePath, req.body.user_key);
    res.json({ success: true, user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/orders/:id/firebase/users/:userKey', requireAdmin, async (req, res) => {
  const order = getAdminOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const rawVariant = String(req.query.variant || 'real');
    const target = getOrderFirebaseTarget(order, rawVariant === 'fake' || /^fs\d+$/.test(rawVariant) ? rawVariant : 'real');
    const removed = await removeFirebaseUser(target.firebasePath, req.params.userKey);
    res.json({ success: true, removed });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get all users with order counts
app.get('/api/admin/users/stats', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id,u.username,u.email,u.coins,u.created_at,
      COUNT(o.id) as total_orders,
      SUM(CASE WHEN o.status='done' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN o.status='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN o.status='pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN o.status='building' THEN 1 ELSE 0 END) as building
    FROM users u
    LEFT JOIN orders o ON u.id=o.user_id
    GROUP BY u.id
    ORDER BY u.id DESC
  `).all();
  res.json(users);
});

// Coupons
app.get('/api/admin/coupons', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM coupons ORDER BY id DESC').all());
});

app.post('/api/admin/coupons', requireAdmin, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const type = req.body.type === 'percent' ? 'percent' : 'fixed';
  const value = Math.max(0, parseInt(req.body.value, 10) || 0);
  const maxUses = Math.max(0, parseInt(req.body.max_uses, 10) || 0);
  const expiresAt = String(req.body.expires_at || '').trim() || null;
  if (!code) return res.status(400).json({ error: 'Coupon code required' });
  if (!value) return res.status(400).json({ error: 'Coupon value required' });
  try {
    const result = db.prepare('INSERT INTO coupons(code,type,value,max_uses,expires_at,active) VALUES(?,?,?,?,?,1)')
      .run(code, type, value, maxUses, expiresAt);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    res.status(400).json({ error: 'Coupon code already exists' });
  }
});

app.patch('/api/admin/coupons/:id', requireAdmin, (req, res) => {
  const active = req.body.active === true || req.body.active === '1' || req.body.active === 1 ? 1 : 0;
  const info = db.prepare('UPDATE coupons SET active=? WHERE id=?').run(active, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Coupon not found' });
  res.json({ success: true });
});

app.delete('/api/admin/coupons/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM coupons WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Backups
app.get('/api/admin/backups', requireAdmin, (req, res) => {
  const backupDir = path.join(__dirname, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backups = fs.readdirSync(backupDir)
    .filter(f => /^apkbuilder_.*\.db$/.test(f))
    .map(f => {
      const st = fs.statSync(path.join(backupDir, f));
      return { file: f, size: st.size, created_at: st.mtime };
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(backups);
});

app.post('/api/admin/backups', requireAdmin, (req, res) => {
  try { res.json({ success: true, backup: createDatabaseBackup('manual') }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/backups/:file/download', requireAdmin, (req, res) => {
  const file = path.basename(req.params.file);
  const p = path.join(__dirname, 'backups', file);
  if (!/^apkbuilder_.*\.db$/.test(file) || !fs.existsSync(p)) return res.status(404).json({ error: 'Backup not found' });
  res.download(p, file);
});

// Settings
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const result = {};
  rows.forEach(r => result[r.key] = r.value);
  res.json(result);
});

app.post('/api/admin/settings', requireAdmin, adminUpload.fields([
  { name: 'upi_qr_image', maxCount: 1 },
  { name: 'loading_html', maxCount: 1 }
]), (req, res) => {
  const allowed = ['upi_id','coin_rate','site_name','telegram_bot_token','telegram_admin_id','addon_fake_price','domain_change_price','invite_code_change_price','backup_keep_count'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, req.body[key]);
    }
  }
  if (req.files?.upi_qr_image?.[0]) {
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('upi_qr_image', path.basename(req.files.upi_qr_image[0].path));
  }
  if (req.files?.loading_html?.[0]) {
    const f = req.files.loading_html[0];
    const dest = path.join(__dirname, 'templates', f.originalname);
    fs.renameSync(f.path, dest);
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('loading_html_file', f.originalname);
  }
  const newToken = req.body.telegram_bot_token;
  if (newToken !== undefined) initBot(newToken, db);
  res.json({ success: true });
});

// Base APK upload (legacy)
app.post('/api/admin/upload-base-apk', requireAdmin, adminUpload.single('apk'), (req, res) => {
  if (!req.file) return res.json({ error: 'No file' });
  const { type } = req.body;
  const name = type === 'dhani' ? 'base_dhani.apk' : 'base_normal.apk';
  const dest = path.join(__dirname, 'base-apks', name);
  fs.renameSync(req.file.path, dest);
  res.json({ success: true, name });
});

app.get('/api/admin/base-apks/status', requireAdmin, (req, res) => {
  res.json({
    normal: fs.existsSync(path.join(__dirname, 'base-apks', 'base_normal.apk')),
    dhani:  fs.existsSync(path.join(__dirname, 'base-apks', 'base_dhani.apk'))
  });
});

// ── Android Project ZIP upload ──
app.post('/api/admin/upload-android-project', requireAdmin, projectUpload.single('zip'), (req, res) => {
  if (!req.file) return res.json({ error: 'No file uploaded' });
  const { execSync } = require('child_process');
  const dest   = path.join(__dirname, 'android-project');
  const tmpDir = path.join(__dirname, '_zip_tmp_' + Date.now());
  try {
    fs.rmSync(dest,   { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`unzip -o "${req.file.path}" -d "${tmpDir}"`, { stdio: 'pipe' });
    // If ZIP has a single top-level folder, use its contents
    const entries = fs.readdirSync(tmpDir);
    const src = (entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory())
      ? path.join(tmpDir, entries[0])
      : tmpDir;
    execSync(`cp -r "${src}" "${dest}"`, { stdio: 'pipe' });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.unlinkSync(req.file.path);
    // Auto-generate gradlew if not present
    if (!fs.existsSync(path.join(dest, 'gradlew'))) {
      execSync('gradle wrapper --gradle-version 8.6', { cwd: dest, stdio: 'pipe' });
      execSync(`chmod +x "${path.join(dest, 'gradlew')}"`, { stdio: 'pipe' });
    }
    res.json({ success: true });
  } catch(e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/android-project/status', requireAdmin, (req, res) => {
  const exists = fs.existsSync(path.join(__dirname, 'android-project', 'gradlew'));
  res.json({ uploaded: exists });
});

// ── Serve frontend pages ──
app.get('/admin*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`APK Builder running on port ${PORT}`);
});