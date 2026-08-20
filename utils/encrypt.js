'use strict';

const crypto = require('crypto');
const fs = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
// HTML .bin ENCRYPTION — fixed key (no per-build native vault, no asset crypto)
//
// Sirf popup/loading HTML files (.bin) encrypted rehte hain. Baaki saare
// assets (PNG / MP3 / fonts / icon) APK me PLAIN hain — koi encrypt/decrypt
// nahi, jaise pehle chalta tha.
//
// Bin layout (MainActivity Java me isi ko decode karta hai):
//   MARKER(8 bytes) | salt(16) | iv(16) | AES-256-CBC(PKCS5) | padding(64)
// ─────────────────────────────────────────────────────────────────────────────

const MARKER = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE]);

// MainActivity.java me bhi YAHI password hardcoded hai — dono match hone
// chahiye.
const FIXED_PASSWORD = 'zayroavi@132';

async function encryptHtmlToBin(htmlContent, outputPath, password) {
  const pass = password || FIXED_PASSWORD;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);

  const keyBuf = await new Promise((resolve, reject) => {
    crypto.pbkdf2(pass, salt, 100000, 32, 'sha256', (err, key) => {
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

// ── Decrypt (diagnostic ke liye — server kya serve kar raha hai check) ──
function decryptHtmlFromBin(input, password = FIXED_PASSWORD) {
  const data = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  let mp = -1;
  for (let i = 0; i <= data.length - 8; i++) {
    let ok = true;
    for (let j = 0; j < 8; j++) if (data[i + j] !== MARKER[j]) { ok = false; break; }
    if (ok) { mp = i; break; }
  }
  if (mp < 0) throw new Error('no marker — encrypted bin nahi hai');
  const salt = data.slice(mp + 8, mp + 24);
  const iv = data.slice(mp + 24, mp + 40);
  const enc = data.slice(mp + 40, data.length - 64);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

module.exports = {
  MARKER,
  FIXED_PASSWORD,
  encryptHtmlToBin,
  encryptHtmlFileToBin,
  decryptHtmlFromBin
};
