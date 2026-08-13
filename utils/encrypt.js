const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MARKER = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE]);
const PASSWORD = 'zayroavi@132';

async function encryptHtmlToBin(htmlContent, outputPath) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);

  const keyBuf = await new Promise((resolve, reject) => {
    crypto.pbkdf2(PASSWORD, salt, 100000, 32, 'sha256', (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });

  const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, iv);
  const htmlBuf = Buffer.from(htmlContent, 'utf8');
  const encrypted = Buffer.concat([cipher.update(htmlBuf), cipher.final()]);

  // padding 64 bytes at end (matches Java decoder: bd.length-64)
  const padding = crypto.randomBytes(64);

  const out = Buffer.concat([MARKER, salt, iv, encrypted, padding]);
  fs.writeFileSync(outputPath, out);
  return outputPath;
}

async function encryptHtmlFileToBin(htmlFilePath, outputPath) {
  const html = fs.readFileSync(htmlFilePath, 'utf8');
  return encryptHtmlToBin(html, outputPath);
}

module.exports = { encryptHtmlToBin, encryptHtmlFileToBin };
