'use strict';

const DEFAULT_FIREBASE_DATABASE_URL = 'https://zayrodev-195f3-default-rtdb.firebaseio.com';

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
  const response = await fetch(firebaseEndpoint(parts), {
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