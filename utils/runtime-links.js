'use strict';

const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_FIREBASE_DATABASE_URL = 'https://zayrodev-195f3-default-rtdb.firebaseio.com';

// ───────────────────────────────────────────────────────────────────────────
// FIREBASE SERVICE ACCOUNT AUTH (hack lock)
//
// Firebase rules ab /config ki write sirf authenticated requests ko allow
// karti hai ("auth != null"). Isliye server ab Google service account se
// OAuth access token banata hai aur har Firebase request me use lagata hai.
//
// Setup: Firebase Console → Project settings → Service accounts →
//   "Generate new private key" → JSON download karo → VPS pe rakho.
// .env me:
//   GOOGLE_APPLICATION_CREDENTIALS=/root/apkbuilder/firebase-service-account.json
//
// Service account na ho to bhi app chalta hai — sirf admin link change
// fail hoga (rules usse block karti hain), jo ki theek hai kyunki wahi
// hacker ka darwaza tha.
// ───────────────────────────────────────────────────────────────────────────
let _saCache = null, _saLoaded = false;
function loadServiceAccount() {
  // CRITICAL FIX: fail ko hamesha cache nahi karte — agar pehli baar file
  // nahi thi/corrupt thi to har call pe dobara try hota hai. (Pehle null
  // cache ho jata tha aur file banane ke baad bhi token kabhi nahi banta
  // tha — har Firebase write 401 deta tha.)
  if (_saLoaded && _saCache) return _saCache;
  _saLoaded = true;
  try {
    const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT;
    const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (filePath && fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && parsed.client_email && parsed.private_key) _saCache = parsed;
    } else if (inline) {
      const parsed = JSON.parse(inline);
      if (parsed && parsed.client_email && parsed.private_key) _saCache = parsed;
    }
  } catch (e) {
    console.error('[fb-sa] service account load fail:', e.message);
  }
  return _saCache;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let _tokenCache = null, _tokenExp = 0;
let _tokenPromise = null; // single-flight: ek saath sirf EK token exchange
async function getFirebaseAccessToken() {
  if (_tokenCache && Date.now() < _tokenExp - 60000) return _tokenCache;
  if (_tokenPromise) return _tokenPromise;
  _tokenPromise = _doTokenExchange();
  try { return await _tokenPromise; } finally { _tokenPromise = null; }
}
async function _doTokenExchange() {
  // BULLETPROOF: service account file corrupt ho, network down ho, ya kuch
  // bhi fail ho — hamesha null return hota hai. Firebase request phir bina
  // token ke chalti hai (rules na lagi ho to sab waise hi chalta hai).
  try {
    const sa = loadServiceAccount();
    if (!sa || !sa.client_email || !sa.private_key) return null;
    const now = Date.now();
    if (_tokenCache && now < _tokenExp - 60000) return _tokenCache;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.database',
      aud: 'https://oauth2.googleapis.com/token',
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 3600
    }));
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(header + '.' + payload);
    const sig = b64url(sign.sign(sa.private_key));
    const assertion = header + '.' + payload + '.' + sig;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      }).toString(),
      signal: AbortSignal.timeout(15_000)
    });
    const j = await res.json();
    if (j && j.access_token) {
      _tokenCache = j.access_token;
      _tokenExp = now + ((j.expires_in || 3600) * 1000);
      console.log('[fb-token] access token mila —', j.access_token.slice(0, 12) + '...');
      return _tokenCache;
    }
    console.error('[fb-token] exchange FAIL:', JSON.stringify(j).slice(0, 250));
    return null;
  } catch (e) {
    // token exchange fail — token ke bina aage badho (request khud chalti hai)
    console.error('[fb-token] exchange ERROR:', e.message);
    return null;
  }
}

function normalizeHttpUrl(value) {
  const raw = String(value || '').trim();
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// or https:// URLs are allowed');
  }
  return parsed.toString();
}

function replaceUrlDomain(currentRegisterUrl, newDomainUrl) {
  const current = new URL(normalizeHttpUrl(currentRegisterUrl));
  const replacement = new URL(normalizeHttpUrl(newDomainUrl));
  current.protocol = replacement.protocol;
  current.host = replacement.host;
  return current.toString();
}

function normalizeFirebasePath(value) {
  const path = String(value || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(path)) {
    throw new Error('Invalid Firebase config path');
  }
  return path;
}

function normalizeFirebaseUserKey(value) {
  const key = String(value || '').trim();
  if (!/^[a-zA-Z0-9_+@-]{1,80}$/.test(key)) {
    throw new Error('User key may contain only letters, numbers, +, -, _ or @');
  }
  return key;
}

function firebaseEndpoint(parts) {
  const databaseUrl = String(process.env.FIREBASE_DATABASE_URL || DEFAULT_FIREBASE_DATABASE_URL).replace(/\/$/, '');
  const auth = String(process.env.FIREBASE_DATABASE_AUTH || '').trim();
  const path = parts.map(part => encodeURIComponent(part)).join('/');
  return `${databaseUrl}/${path}.json${auth ? `?auth=${encodeURIComponent(auth)}` : ''}`;
}

async function firebaseRequest(parts, method = 'GET', body) {
  // Token SIRF writes ke liye — GET (admin users list / watchdog reads)
  // public rules se bina token ke turant chalti hai. Isse pehle har read
  // token exchange ka wait karta tha (slow "Loading Firebase...").
  const needsAuth = method === 'PATCH' || method === 'PUT';
  let token = null;
  if (needsAuth) {
    try { token = await getFirebaseAccessToken(); }
    catch (e) { token = null; }
  }

  const doFetch = async (tok) => {
    let url = firebaseEndpoint(parts);
    if (tok) url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(tok);
    return fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
  };

  let response = await doFetch(token);

  // ── 401 RETRY: token kharab/expired nikla to cache clear karke naya
  // token le kar EK baar retry — admin link change kabhi silently fail
  // na ho.
  if (needsAuth && response.status === 401) {
    console.error('[fb-request] 401 — token cache clear, naya token leke retry...');
    _tokenCache = null; _tokenExp = 0; _tokenPromise = null;
    try { token = await getFirebaseAccessToken(); } catch (e) { token = null; }
    if (token) response = await doFetch(token);
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    console.error(`[fb-request] ${method} ${parts.join('/')} → HTTP ${response.status}${detail ? ' ' + detail : ''}`);
    throw new Error(`Firebase request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function updateFirebaseLinks(firebasePath, links) {
  const safePath = normalizeFirebasePath(firebasePath);
  await firebaseRequest([safePath, 'config'], 'PATCH', {
    registerUrl: normalizeHttpUrl(links.registerUrl),
    depositUrl: normalizeHttpUrl(links.depositUrl),
    wingoUrl: normalizeHttpUrl(links.wingoUrl),
    linkUpdatedAt: Date.now()
  });
  return true;
}

async function getFirebaseControl(firebasePath) {
  const safePath = normalizeFirebasePath(firebasePath);
  const [config, users] = await Promise.all([
    firebaseRequest([safePath, 'config']),
    firebaseRequest([safePath, 'users'])
  ]);
  return {
    config: config && typeof config === 'object' ? config : {},
    users: users && typeof users === 'object' ? users : {}
  };
}

async function updateFirebaseControl(firebasePath, values) {
  const safePath = normalizeFirebasePath(firebasePath);
  const patch = {};
  if (values.minDeposit !== undefined) {
    const amount = Number(values.minDeposit);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid minimum deposit');
    patch.minDeposit = Math.round(amount);
  }
  if (values.depositCondition !== undefined) patch.depositCondition = !!values.depositCondition;
  if (values.registerCondition !== undefined) patch.registerCondition = !!values.registerCondition;
  if (!Object.keys(patch).length) throw new Error('No Firebase config values provided');
  await firebaseRequest([safePath, 'config'], 'PATCH', patch);
  return patch;
}

async function addFirebaseUser(firebasePath, userKey) {
  const safePath = normalizeFirebasePath(firebasePath);
  const safeKey = normalizeFirebaseUserKey(userKey);
  const value = { registered: true, addedByAdmin: true, timestamp: Date.now() };
  await firebaseRequest([safePath, 'users', safeKey], 'PUT', value);
  return { key: safeKey, value };
}

async function removeFirebaseUser(firebasePath, userKey) {
  const safePath = normalizeFirebasePath(firebasePath);
  const safeKey = normalizeFirebaseUserKey(userKey);
  await firebaseRequest([safePath, 'users', safeKey], 'DELETE');
  return safeKey;
}

module.exports = {
  normalizeHttpUrl,
  replaceUrlDomain,
  normalizeFirebasePath,
  normalizeFirebaseUserKey,
  updateFirebaseLinks,
  getFirebaseControl,
  updateFirebaseControl,
  addFirebaseUser,
  removeFirebaseUser,
  firebaseRequest
};