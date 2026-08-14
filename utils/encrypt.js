const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// APK HARDENING — ENCRYPTION LAYER
//
// Every build gets a UNIQUE random password (32 hex chars). It is used for:
//   1. HTML popup/loading blobs → AES-256-CBC via PBKDF2 (existing .bin format,
//      read by the app's legacy decryptor — unchanged byte layout)
//   2. Every other asset (png / mp3 / fonts / icon) → AES-256-GCM with
//      key = SHA-256(password) (new unified format read by CryptoUtil)
// The password is burned into the native library at build time, XOR-masked so
// it never appears as a plain string in the .so. Each APK therefore has its
// own key — dumping one APK reveals nothing reusable on another.
// ─────────────────────────────────────────────────────────────────────────────

const MARKER = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE]);

// GCM asset blob layout: [magic 8][nonce 12][tag 16][ciphertext]
const ASSET_MAGIC    = Buffer.from('ZAYROA01', 'ascii');
const ASSET_NONCE_LEN = 12;
const ASSET_TAG_LEN   = 16;

// ── Per-build password ──
function generateBuildPassword() {
  return crypto.randomBytes(16).toString('hex'); // 32 hex chars
}

function assetKey(password) {
  return crypto.createHash('sha256').update(String(password), 'utf8').digest();
}

// ── HTML → .bin (legacy layout, per-build password) ──
async function encryptHtmlToBin(htmlContent, outputPath, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);

  const keyBuf = await new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 100000, 32, 'sha256', (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });

  const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, iv);
  const htmlBuf = Buffer.from(htmlContent, 'utf8');
  const encrypted = Buffer.concat([cipher.update(htmlBuf), cipher.final()]);

  // 64 bytes padding at end (matches Java decoder: bd.length-64)
  const padding = crypto.randomBytes(64);

  const out = Buffer.concat([MARKER, salt, iv, encrypted, padding]);
  fs.writeFileSync(outputPath, out);
  return outputPath;
}

async function encryptHtmlFileToBin(htmlFilePath, outputPath, password) {
  const html = fs.readFileSync(htmlFilePath, 'utf8');
  return encryptHtmlToBin(html, outputPath, password);
}

// ── Generic asset → AES-256-GCM blob ──
function encryptAsset(buf, password) {
  const nonce = crypto.randomBytes(ASSET_NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', assetKey(password), nonce);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ASSET_MAGIC, nonce, tag, enc]);
}

function encryptAssetFile(srcPath, destPath, password) {
  const buf = fs.readFileSync(srcPath);
  fs.writeFileSync(destPath, encryptAsset(buf, password));
}

// Decrypt-side mirror of CryptoUtil.decryptAsset() (used by tests)
function decryptAsset(blob, password) {
  if (!Buffer.isBuffer(blob)) blob = Buffer.from(blob);
  if (blob.length < ASSET_MAGIC.length + ASSET_NONCE_LEN + ASSET_TAG_LEN) throw new Error('blob too short');
  if (!blob.slice(0, 8).equals(ASSET_MAGIC)) throw new Error('bad magic');
  const nonce = blob.slice(8, 8 + ASSET_NONCE_LEN);
  const tag = blob.slice(8 + ASSET_NONCE_LEN, 8 + ASSET_NONCE_LEN + ASSET_TAG_LEN);
  const enc = blob.slice(8 + ASSET_NONCE_LEN + ASSET_TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', assetKey(password), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

// ── XOR mask helpers (so the key never lives in the binary as plaintext) ──
function xorMask(data) {
  const mask = crypto.randomBytes(data.length);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i];
  return { mask, masked };
}

const toCArray = (buf) => `{${Array.from(buf).join(',')}}`;

// ── Generate the per-build native-lib.cpp ──
// The password + expected signing-cert hash are embedded XOR-masked. The
// binary contains only two random-looking byte arrays per secret; the real
// values are reconstructed at runtime inside the .so.
function generateNativeLib({ password, certHashHex }) {
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new Error('generateNativeLib: invalid password');
  }

  const pw = xorMask(Buffer.from(password, 'utf8'));
  const cert = xorMask(Buffer.from(certHashHex || '', 'hex'));

  return `/*
 * Generated per-build by utils/encrypt.js — do not edit.
 * Contains the build-unique XOR-masked decrypt key and the expected signing
 * certificate hash. No plaintext secrets are stored in this binary.
 */
#include <jni.h>
#include <string>

static const int gPwLen = ${pw.masked.length};
static const int gCertLen = ${cert.masked.length};
static const unsigned char gPwMask[${pw.mask.length}] = ${toCArray(pw.mask)};
static const unsigned char gPwData[${pw.masked.length}] = ${toCArray(pw.masked)};
static const unsigned char gCertMask[${cert.mask.length}] = ${toCArray(cert.mask)};
static const unsigned char gCertData[${cert.masked.length}] = ${toCArray(cert.masked)};

// Recover the build password at runtime (never stored in plaintext).
static void zayroRecoverPassword(char* out, int maxLen) {
    int len = gPwLen < (maxLen - 1) ? gPwLen : (maxLen - 1);
    for (int i = 0; i < len; i++) out[i] = (char)(gPwMask[i] ^ gPwData[i]);
    out[len] = '\\0';
}

// Recover the expected signing-certificate SHA-256 at runtime.
static void zayroRecoverCertHash(unsigned char* out, int maxLen) {
    int len = gCertLen < maxLen ? gCertLen : maxLen;
    for (int i = 0; i < len; i++) out[i] = (unsigned char)(gCertMask[i] ^ gCertData[i]);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_zayro_wingsyttt_SecurityUtil_getDecryptKey(JNIEnv* env, jobject) {
    char key[96];
    zayroRecoverPassword(key, sizeof(key));
    return env->NewStringUTF(key);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zayro_wingsyttt_SecurityUtil_getCertHash(JNIEnv* env, jobject) {
    jbyte out[64];
    int len = gCertLen;
    if (len <= 0) return env->NewByteArray(0);
    if (len > 64) len = 64;
    zayroRecoverCertHash((unsigned char*)out, len);
    jbyteArray result = env->NewByteArray(len);
    env->SetByteArrayRegion(result, 0, len, out);
    return result;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zayro_wingsyttt_SecurityUtil_getMarker(JNIEnv* env, jobject) {
    jbyte marker[] = {(jbyte)0xDE, (jbyte)0xAD, (jbyte)0xBE, (jbyte)0xEF,
                      (jbyte)0xCA, (jbyte)0xFE, (jbyte)0xBA, (jbyte)0xBE};
    jbyteArray result = env->NewByteArray(8);
    env->SetByteArrayRegion(result, 0, 8, marker);
    return result;
}
`;
}

// ── Extract expected signing-cert SHA-256 from the keystore ──
// Uses keytool (ships with the JDK that Gradle already needs). Returns null
// when unavailable so a build never fails because of the integrity check.
function getKeystoreCertHash(keystorePath, storePass) {
  try {
    const { execFileSync } = require('child_process');

    const runKeytool = (extraArgs) => execFileSync('keytool', [
      '-list', '-v',
      '-keystore', keystorePath,
      '-storepass', storePass,
      ...extraArgs
    ], { stdio: 'pipe', encoding: 'utf8' });

    let out;
    try {
      out = runKeytool([]);                    // modern JDK auto-detects type
    } catch (e) {
      out = runKeytool(['-storetype', 'JKS']); // legacy fallback
    }

    const m = out.match(/SHA256:\s*([0-9A-Fa-f:]+)/);
    if (!m) return null;
    const hex = m[1].replace(/:/g, '').toLowerCase();
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  generateBuildPassword,
  encryptHtmlToBin,
  encryptHtmlFileToBin,
  encryptAsset,
  encryptAssetFile,
  decryptAsset,
  generateNativeLib,
  getKeystoreCertHash
};
