'use strict';

const fs = require('fs');
const path = require('path');
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
let _saCache = null;
function loadServiceAccount() {
  try {
    if (_saCache && _saCache.client_email && _saCache.private_key) return _saCache;
    const candidates = [
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
      process.env.FIREBASE_SERVICE_ACCOUNT,
      path.join(__dirname, '..', 'firebase-service-account.json'),
      '/root/apkbuilder/firebase-service-account.json',
      '/root/firebase-service-account.json'
    ].filter(Boolean);

    let parsed = null;
    for (const filePath of candidates) {
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          parsed = JSON.parse(content);
          if (parsed && parsed.client_email && parsed.private_key) {
            _saCache = parsed;
            console.log('[fb-sa] service account loaded from:', filePath);
            return parsed;
          }
        } catch (_) {}
      }
    }

    const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (inline) {
      parsed = JSON.parse(inline);
      if (parsed && parsed.client_email && parsed.private_key) {
        _saCache = parsed;
        console.log('[fb-sa] service account loaded from inline JSON');
        return parsed;
      }
    }

    console.warn('[fb-sa] service account file NAHI mila');
    return null;
  } catch (e) {
    console.error('[fb-sa] service account load fail:', e.message);
    return null;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Keep one short-lived server-only OAuth token and share an in-flight
// exchange. The previous version checked undeclared cache variables, so every
// authenticated Firebase operation silently fell back to an unauthenticated
// request and was rejected by the database rules.
let _tokenCache = null;
let _tokenExp = 0;
let _tokenPromise = null;

function clearFirebaseToken() {
  _tokenCache = null;
  _tokenExp = 0;
}

async function getFirebaseAccessToken() {
  if (_tokenCache && Date.now() < _tokenExp - 60_000) return _tokenCache;
  if (_tokenPromise) return _tokenPromise;

  _tokenPromise = _doTokenExchange();
  try {
    return await _tokenPromise;
  } finally {
    _tokenPromise = null;
  }
}

async function _doTokenExchange() {
  try {
    const sa = loadServiceAccount();
    if (!sa || !sa.client_email || !sa.private_key) return null;
    const now = Date.now();
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
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
      // Access tokens are server-only; never log even a prefix or provider
      // response containing credential material.
      const lifetime = Math.max(60_000, Number(j.expires_in || 3600) * 1000);
      _tokenCache = j.access_token;
      _tokenExp = Date.now() + lifetime;
      return _tokenCache;
    }
    console.error('[fb-token] exchange failed with status', res.status);
    return null;
  } catch (e) {
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
  const path = parts.map(part => encodeURIComponent(part)).join('/');
  // LEGACY AUTH HATA DIYA — purana FIREBASE_DATABASE_AUTH secret Firebase
  // reset ke baad revoked ho chuka tha. Server ab sirf access_token
  // (service account OAuth) use karta hai; purana ?auth= param saath me
  // hone par Firebase 401 "Unauthorized request" deta tha.
  return `${databaseUrl}/${path}.json`;
}

async function firebaseRequest(parts, method = 'GET', body) {
  // Public reads stay fast. If a protected node rejects the unauthenticated
  // read, retry once with the server-only service-account token. Writes use
  // the token from the start. This supports both the legacy public config
  // node and the locked users node without weakening Firebase rules.
  const needsAuth = method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  let token = null;
  if (needsAuth) {
    try { token = await getFirebaseAccessToken(); }
    catch (e) { token = null; }
  }

  const doFetch = async (tok) => {
    let url = firebaseEndpoint(parts);
    const headers = { 'Content-Type': 'application/json' };
    if (tok) {
      headers['Authorization'] = `Bearer ${tok}`;
      url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(tok);
    }
    return fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
  };

  let response = await doFetch(token);

  // A public config can return 200 while /users is protected. Retry any 401
  // once with a fresh OAuth token so the manager works when the service
  // account is configured, without adding auth parameters to public links.
  if (response.status === 401) {
    console.error(`[fb-request] ${method} ${parts.join('/')} → HTTP 401; retrying with service-account token`);
    clearFirebaseToken();
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
  const results = await Promise.allSettled([
    firebaseRequest([safePath, 'config']),
    firebaseRequest([safePath, 'users'])
  ]);

  // Config is required to manage an APK. Keep the existing hard failure for
  // that node, but do not discard a valid config just because a deployment's
  // rules protect /users. The admin UI can then show the real path/config and
  // an actionable users-permission warning instead of spinning forever.
  if (results[0].status === 'rejected') throw results[0].reason;
  const usersFailure = results[1].status === 'rejected' ? results[1].reason : null;

  return {
    config: results[0].value && typeof results[0].value === 'object' ? results[0].value : {},
    users: results[1].status === 'fulfilled' && results[1].value && typeof results[1].value === 'object'
      ? results[1].value
      : {},
    usersError: usersFailure ? String(usersFailure.message || 'Firebase users could not be read') : null
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

async function addFirebaseUser(firebasePath, userKey, options = {}) {
  const safePath = normalizeFirebasePath(firebasePath);
  const safeKey = normalizeFirebaseUserKey(userKey);
  const value = {
    registered: true,
    isDemo: true,
    addedByUser: options.addedByUser !== undefined ? !!options.addedByUser : false,
    addedByAdmin: options.addedByAdmin !== undefined ? !!options.addedByAdmin : !options.addedByUser,
    timestamp: Date.now()
  };
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
  firebaseRequest,
  getFirebaseAccessToken
};