'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// native-payload.js — POPUP HTML → NATIVE .so PROTECTED PAYLOAD (build time)
//
// Ye module popup HTML ko authenticated-encryption container me pack karta hai
// aur us container ko native C++ library me embed karne ke liye ek generated
// header (popup_payload.h) banata hai. Runtime par native code payload ko
// verify + decrypt karke WebView ko deta hai — bina disk par likhe.
//
// Container format "ZPAY01" (version 1):
//   magic[8]      = 'Z','P','A','Y','0','1',0x00,0x01   (aakhri byte = version)
//   iterations u32 LE                                (PBKDF2 rounds, 100000)
//   salt[16]       (random per build)
//   iv[16]         (AES-CTR initial counter, random per build)
//   ctLen u32 LE   (ciphertext length)
//   ciphertext[ctLen]  = AES-256-CTR(encKey, iv, utf8Html)
//   tag[32]        = HMAC-SHA256(macKey, magic||iters||salt||iv||ctLen||ct)
//
// Keys:
//   pwFull = perBuildPassword + "|zpay1|" + pepperHex
//   dk     = PBKDF2-HMAC-SHA256(pwFull, salt, iterations, 64)
//   encKey = dk[0:32], macKey = dk[32:64]
//
// perBuildPassword DEX me XOR-masked constant se aata hai (existing pattern),
// pepperHex sirf generated native header me (obfuscated) hota hai — poora key
// kahin ek jagah plaintext nahi milta. Dono APK me recoverable hain (yeh
// documented limitation hai — NATIVE-PAYLOAD.md dekho), lekin extraction ke
// liye DEX + .so dono reverse karne padte hain aur crypto format samajhna
// padta hai.
//
// SECURITY NOTE: AES-256-CTR + HMAC-SHA256 (Encrypt-then-MAC, independent keys,
// constant-time tag verify) ek standard authenticated-encryption construction
// hai (AES-GCM ka equivalent secure design). Sirf XOR masking NAHI hai.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PAYLOAD_MAGIC = Buffer.from([0x5a, 0x50, 0x41, 0x59, 0x30, 0x31, 0x00, 0x01]); // "ZPAY01\0\1"
const PAYLOAD_VERSION = 1;
const PBKDF2_ITERATIONS = 100000;
const SALT_LEN = 16;
const IV_LEN = 16;
const TAG_LEN = 32;
const PW_PEPPER_SEP = '|zpay1|';
const HEADER_MIN_LEN = 8 + 4 + SALT_LEN + IV_LEN + 4; // magic+iters+salt+iv+ctLen

function deriveKeys(pwFull, salt, iterations) {
  const dk = crypto.pbkdf2Sync(String(pwFull), salt, iterations, 64, 'sha256');
  return { encKey: dk.slice(0, 32), macKey: dk.slice(32, 64) };
}

// ── Build a v1 container from popup HTML ─────────────────────────────────────
function encryptPopupPayload(html, password, pepperHex) {
  const plain = Buffer.from(String(html || ''), 'utf8');
  if (plain.length < 16) throw new Error('native-payload: HTML too short, refusing to pack');
  if (!password || String(password).length < 4) throw new Error('native-payload: password missing');
  if (!/^[0-9a-f]{32}$/i.test(String(pepperHex || ''))) throw new Error('native-payload: pepperHex invalid');

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const pwFull = String(password) + PW_PEPPER_SEP + String(pepperHex).toLowerCase();
  const { encKey, macKey } = deriveKeys(pwFull, salt, PBKDF2_ITERATIONS);

  const cipher = crypto.createCipheriv('aes-256-ctr', encKey, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);

  const itersBuf = Buffer.alloc(4); itersBuf.writeUInt32LE(PBKDF2_ITERATIONS, 0);
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(ct.length, 0);
  const header = Buffer.concat([PAYLOAD_MAGIC, itersBuf, salt, iv, lenBuf, ct]);
  const tag = crypto.createHmac('sha256', macKey).update(header).digest();
  return Buffer.concat([header, tag]);
}

function generatePepperHex() {
  return crypto.randomBytes(16).toString('hex');
}

// ── Container sanity parser (verification / diagnostics — NO decrypt) ───────
function parsePayloadHeader(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < HEADER_MIN_LEN + TAG_LEN) return { ok: false, reason: 'too short' };
  if (!b.slice(0, 8).equals(PAYLOAD_MAGIC)) return { ok: false, reason: 'bad magic' };
  const iterations = b.readUInt32LE(8);
  const ctLen = b.readUInt32LE(8 + 4 + SALT_LEN + IV_LEN);
  if (iterations < 10000 || iterations > 2000000) return { ok: false, reason: 'bad iterations' };
  if (ctLen > 8 * 1024 * 1024) return { ok: false, reason: 'ct too large' };
  if (b.length !== HEADER_MIN_LEN + ctLen + TAG_LEN) return { ok: false, reason: 'length mismatch' };
  return { ok: true, version: PAYLOAD_VERSION, iterations, ctLen, totalLen: b.length };
}

// ── Generated C++ header (sirf build copy me likha jata hai) ────────────────
// Pepper obfuscation: per-build random rotation + random XOR mask. Ye cost
// badhata hai (plain pepper .so me nahi dikhta); unbreakable hone ka daava
// NAHI hai — limitations NATIVE-PAYLOAD.md me documented hain.
function cByteArrayLines(buf, perLine = 16, indent = '    ') {
  const parts = [];
  for (let i = 0; i < buf.length; i += perLine) {
    const slice = buf.slice(i, i + perLine);
    parts.push(indent + Array.from(slice).map(x => '0x' + x.toString(16).padStart(2, '0')).join(', ') + ',');
  }
  return parts.join('\n');
}

function buildPayloadHeader(payloadBuf, pepperHex, buildId) {
  const pepper = Buffer.from(String(pepperHex).toLowerCase(), 'hex'); // 16 bytes
  const rot = crypto.randomInt(0, 16);
  const mask = crypto.randomBytes(16);
  const rotated = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) rotated[i] = pepper[(i + rot) % 16];
  const masked = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) masked[i] = rotated[i] ^ mask[i];
  const tag = crypto.randomBytes(8).toString('hex');

  return [
    '// ─────────────────────────────────────────────────────────────',
    '// AUTO-GENERATED at build time — DO NOT EDIT, DO NOT COMMIT.',
    `// build: ${String(buildId || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_')}  tag: ${tag}`,
    '// Ye header sirf build copy (builds/<id>/project/...) me likha jata hai,',
    '// repository template me placeholder (empty) rehta hai.',
    '// ─────────────────────────────────────────────────────────────',
    '#pragma once',
    '',
    '#include <stddef.h>',
    '',
    `static const unsigned long long ZPAY_BUILD_TAG = 0x${tag}ULL;`,
    `static const unsigned long ZPAY_PAYLOAD_LEN = ${payloadBuf.length}UL;`,
    'static const unsigned char ZPAY_PAYLOAD[] = {',
    cByteArrayLines(payloadBuf),
    '};',
    '',
    'static const unsigned int ZPAY_PEPPER_ROT = ' + rot + ';',
    'static const unsigned char ZPAY_PEPPER_M[16] = {',
    cByteArrayLines(masked, 16),
    '};',
    'static const unsigned char ZPAY_PEPPER_MASK[16] = {',
    cByteArrayLines(mask, 16),
    '};',
    ''
  ].join('\n');
}

// ── One-shot: HTML + password → { payloadBuf, pepperHex, headerCode } ────────
function buildNativePayload(html, password, buildId) {
  const pepperHex = generatePepperHex();
  const payloadBuf = encryptPopupPayload(html, password, pepperHex);
  const parsed = parsePayloadHeader(payloadBuf);
  if (!parsed.ok) throw new Error('native-payload: self-check failed (' + parsed.reason + ')');
  const headerCode = buildPayloadHeader(payloadBuf, pepperHex, buildId);
  return { payloadBuf, pepperHex, headerCode, ctLen: parsed.ctLen };
}

// ── NDK / CMake availability (graceful-skip decision ke liye) ────────────────
function hasNdkToolchain(androidHome) {
  try {
    const home = String(androidHome || process.env.ANDROID_HOME || '/opt/android-sdk');
    if (!fs.existsSync(home)) return { ok: false, reason: 'ANDROID_HOME missing: ' + home };
    const entries = fs.readdirSync(home);
    // layout: $ANDROID_HOME/ndk/<version>/  (sdkmanager default) ya ndk-bundle
    let ndkFound = false;
    try {
      const ndkRoot = path.join(home, 'ndk');
      if (fs.existsSync(ndkRoot) && fs.readdirSync(ndkRoot).length > 0) ndkFound = true;
      if (fs.existsSync(path.join(home, 'ndk-bundle'))) ndkFound = true;
      if (entries.some(e => /^ndk-\d/i.test(e))) ndkFound = true;
    } catch (_) {}
    if (!ndkFound) return { ok: false, reason: 'NDK not installed under ' + home };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

// ── Built-APK verification helpers ───────────────────────────────────────────
function checkApkEntriesForHtmlLeak(listing) {
  const lines = String(listing || '').split('\n');
  const names = lines.map(l => {
    const m = l.match(/\s(\S+)\s*$/);
    return m ? m[1] : '';
  }).filter(Boolean);
  const lower = names.map(n => n.toLowerCase());
  const hasPlainHtml = lower.some(n => n === 'assets/popup.html' || n === 'assets/wingss.html' ||
    /^assets\/.*\.html$/.test(n));
  const popupBins = names.filter(n => /^assets\/(wingss\.bin|zayro\.bin|popup.*\.bin)$/i.test(n));
  const loadingBins = names.filter(n => /^assets\/(loading\.bin|lodale\.bin)$/i.test(n));
  const hasIntro = lower.includes('assets/intro.mp3');
  const hasIcon = lower.includes('assets/my_icon.png');
  const hasDigits = lower.includes('assets/0.png');
  const nativeSos = names.filter(n => /^lib\/.+\/libnativesecurity\.so$/i.test(n));
  return {
    entryCount: names.length,
    hasPlainHtml, popupBins, loadingBins, hasIntro, hasIcon, hasDigits, nativeSos
  };
}

// Extract first matching .so from APK and check for payload magic bytes.
function soContainsPayloadMagic(apkPath, soEntry) {
  try {
    const out = execFileSync('unzip', ['-p', apkPath, soEntry], {
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024
    });
    const buf = Buffer.isBuffer(out) ? out : Buffer.from(out);
    return buf.indexOf(PAYLOAD_MAGIC) >= 0;
  } catch (_) {
    return false;
  }
}

// Full native-payload verification → findings object (report-only, kabhi throw nahi).
function verifyNativePayloadInApk(apkPath, opts = {}) {
  const findings = {
    checked: false, apkExists: false,
    hasPlainHtml: null, popupBins: [], loadingBins: [],
    webviewAssetsIntact: null, nativeSoPresent: false, nativeSoEntries: [],
    payloadMagicInSo: null, notes: []
  };
  try {
    if (!apkPath || !fs.existsSync(apkPath)) { findings.notes.push('APK not found for verify'); return findings; }
    findings.apkExists = true;
    let listing = '';
    try {
      listing = execFileSync('unzip', ['-l', apkPath], { stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      findings.notes.push('unzip -l failed: ' + String(e.message || e).slice(0, 120));
      return findings;
    }
    const c = checkApkEntriesForHtmlLeak(listing);
    findings.hasPlainHtml = c.hasPlainHtml;
    findings.popupBins = c.popupBins;
    findings.loadingBins = c.loadingBins;
    findings.webviewAssetsIntact = c.loadingBins.length > 0 && c.hasIntro && c.hasIcon && c.hasDigits;
    findings.nativeSoEntries = c.nativeSos;
    findings.nativeSoPresent = c.nativeSos.length > 0;
    if (findings.nativeSoPresent) {
      findings.payloadMagicInSo = soContainsPayloadMagic(apkPath, c.nativeSos[0]);
    }
    if (opts.expectNative && !findings.nativeSoPresent) findings.notes.push('expected native .so, not packaged');
    if (opts.expectPayload && findings.payloadMagicInSo === false) findings.notes.push('expected payload magic in .so, not found');
    findings.checked = true;
  } catch (e) {
    findings.notes.push('verify exception: ' + String(e.message || e).slice(0, 160));
  }
  return findings;
}

module.exports = {
  PAYLOAD_MAGIC,
  PAYLOAD_VERSION,
  PBKDF2_ITERATIONS,
  encryptPopupPayload,
  generatePepperHex,
  parsePayloadHeader,
  buildPayloadHeader,
  buildNativePayload,
  hasNdkToolchain,
  checkApkEntriesForHtmlLeak,
  soContainsPayloadMagic,
  verifyNativePayloadInApk
};
