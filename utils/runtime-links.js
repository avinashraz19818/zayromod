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
  if (_saLoaded) return _saCache;
  _saLoaded = true;
  try {
    const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT;
    const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (filePath && fs.existsSync(filePath)) _saCache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    else if (inline) _saCache = JSON.parse(inline);
    else _saCache = null;
  } catch (e) { _saCache = null; }
  return _saCache;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let _tokenCache = null, _tokenExp = 0;
async function getFirebaseAccessToken() {
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
    return _tokenCache;
  }
  return null;
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
  let url = firebaseEndpoint(parts);
  const token = await getFirebaseAccessToken();
  if (token) url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
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
  removeFirebaseUser
};