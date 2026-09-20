#!/usr/bin/env node
'use strict';

/**
 * diag-firebase-auth.js — Service account token vs Firebase rules ka test.
 *
 * Ye batata hai ki 401 kyun aa raha hai:
 *   A) Token ban raha hai ya nahi
 *   B) Token ke SAATH Firebase write chalti hai ya nahi
 *   C) Bina token ke (baseline — 401 hona chahiye agar rules lagi hain)
 *   D) auth.uid kya hai (Firebase rules simulator se pata nahi chalta,
 *      par read test + write test se andaza mil jata hai)
 *
 * Usage (VPS, project folder se):
 *   node scripts/diag-firebase-auth.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
try { require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') }); } catch (e) {}
const DB_URL = (process.env.FIREBASE_DATABASE_URL || 'https://zayrodev-195f3-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const SA_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/root/apkbuilder/firebase-service-account.json';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getToken() {
  if (!fs.existsSync(SA_FILE)) { console.log('❌ SA file nahi mili:', SA_FILE); return null; }
  let sa;
  try { sa = JSON.parse(fs.readFileSync(SA_FILE, 'utf8')); }
  catch (e) { console.log('❌ SA file corrupt JSON:', e.message); return null; }
  console.log('✅ SA file OK — client_email:', sa.client_email);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + payload);
  const sig = b64url(sign.sign(sa.private_key));
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: header + '.' + payload + '.' + sig }).toString()
    });
    const j = await res.json();
    if (j && j.access_token) {
      console.log('✅ TOKEN MILA —', j.access_token.slice(0, 15) + '...', '| scope:', j.scope || '(no scope)');
      return j.access_token;
    }
    console.log('❌ TOKEN EXCHANGE FAIL:', JSON.stringify(j).slice(0, 250));
    return null;
  } catch (e) {
    console.log('❌ TOKEN EXCHANGE ERROR:', e.message);
    return null;
  }
}

async function main() {
  console.log('═══ FIREBASE AUTH DIAGNOSTIC ═══\n');
  const token = await getToken();
  if (!token) { console.log('\n➡️ Token nahi ban raha — upar ka error dekh kar fix karo.'); return; }

  // A) Bina token — config write (rules lagi ho to 401 hona chahiye)
  let unauth = await fetch(DB_URL + '/arena_diag.json', { method: 'PUT', body: JSON.stringify({ config: { x: 1 } }) });
  console.log('\n[A] Bina token, root write     → HTTP', unauth.status, '(rules lagi ho to 401/403)');
  try { await fetch(DB_URL + '/arena_diag.json', { method: 'DELETE' }); } catch (e) {}

  // B) Token ke saath — config write on own panel (harmless probe field)
  let authed = await fetch(DB_URL + '/zayrobdgwinabiz/config.json?access_token=' + encodeURIComponent(token), {
    method: 'PATCH', body: JSON.stringify({ probeAuth: Date.now() })
  });
  let authedText = await authed.text();
  console.log('[B] TOKEN ke saath config write → HTTP', authed.status, authedText.slice(0, 120));

  // C) Token ke saath — read
  let read = await fetch(DB_URL + '/zayrobdgwinabiz/config.json?access_token=' + encodeURIComponent(token));
  console.log('[C] TOKEN ke saath read        → HTTP', read.status);

  console.log('\n═══ RESULT INTERPRETATION ═══');
  if (authed.status === 200) {
    console.log('✅✅ TOKEN + RULES SAB SAHI HAI!');
    console.log('   → Matlb server/hunt script ki 401 ka karan token nahi — code path me');
    console.log('     kuch aur hai. Mujhe batana, main turant debug karunga.');
  } else if (authed.status === 401) {
    console.log('❌ TOKEN SAHI PAR FIREBASE 401 DE RAHA HAI — rules service-account ko');
    console.log('   accept nahi kar rahi. Iska fix: rules me auth.uid (client_email) se');
    console.log('   allow karna — main turant nayi rules file bana dunga. Muje ye output');
    console.log('   paste kar dena.');
  }
}

main().catch(e => console.log('ERROR:', e.message));
