#!/usr/bin/env node
'use strict';

/**
 * set-admin-password.js — Admin login recovery / diagnostic tool
 *
 * Kyun: pm2 agar /root se server start kare to .env silently skip ho sakta hai,
 * jisse ADMIN_USERNAME/ADMIN_PASSWORD load nahi hote aur panel login toot jaata
 * hai. Ye tool DB me ek asli admin user upsert kar deta hai (bcrypt hash +
 * plain_password), taaki env toot bhi jaye to DB-branch se login chal jaye.
 *
 * Usage:
 *   # 1) Sirf diagnostic (kuch nahi badalta) — .env mila? admin creds set hain?
 *   #    DB me admin user hai?
 *   node scripts/set-admin-password.js
 *
 *   # 2) Admin password set/upsert (argv se):
 *   node scripts/set-admin-password.js 'NewStrongPass' [username]
 *   #    username default 'admin' (ya .env ka ADMIN_USERNAME).
 *
 *   # 3) Password ko argv me na dena ho (shell history me na aaye):
 *   #    env se —
 *   ADMIN_NEW_PASSWORD='NewStrongPass' node scripts/set-admin-password.js --from-env [username]
 *   #    ya interactive prompt se —
 *   node scripts/set-admin-password.js --prompt [username]
 *
 * Note: password hamesha 8+ chars ka hona chahiye.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

// dotenv ko explicit path se load karo (pm2/cwd issue se bachne ke liye).
let dotenvResult = { error: new Error('dotenv not loaded') };
try {
  dotenvResult = require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: ENV_PATH });
} catch (e) {
  dotenvResult = { error: e };
}

const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
const db = require(path.join(ROOT, 'database', 'db'));

const ENV_ADMIN_USER = (process.env.ADMIN_USERNAME || 'admin').trim();

function diagnostic() {
  console.log('═══ set-admin-password • DIAGNOSTIC ═══');

  const envExists = fs.existsSync(ENV_PATH);
  console.log('  .env path        :', ENV_PATH);
  console.log('  .env file exists :', envExists ? 'YES' : 'NO');
  console.log('  .env loaded      :', dotenvResult.error ? `NO (${dotenvResult.error.code || dotenvResult.error.message})` : 'YES');
  console.log('  ADMIN_USERNAME   :', process.env.ADMIN_USERNAME ? process.env.ADMIN_USERNAME : 'NOT SET (default "admin")');
  console.log('  ADMIN_PASSWORD   :', process.env.ADMIN_PASSWORD ? 'set' : 'NOT SET (default "admin123")'); // value KABHI print nahi
  console.log('  PORT             :', process.env.PORT || 'NOT SET (default 3000)');

  try {
    const admins = db.prepare(
      "SELECT id, username, email, (password IS NOT NULL AND password != '') AS has_hash FROM users WHERE LOWER(username)=? OR LOWER(username)='admin'"
    ).all(ENV_ADMIN_USER.toLowerCase());
    if (admins.length) {
      console.log('  DB admin user(s) :');
      for (const a of admins) {
        console.log(`     - id=${a.id} username=${a.username} email=${a.email} bcrypt_hash=${a.has_hash ? 'yes' : 'no'}`);
      }
    } else {
      console.log('  DB admin user(s) : NONE (koi "admin" ya ADMIN_USERNAME wala DB user nahi)');
    }
  } catch (e) {
    console.log('  DB check error   :', e.message);
  }
  console.log('');
  console.log('  Kuch badalne ke liye: node scripts/set-admin-password.js \'NewPass\' [username]');
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      const stdout = process.stdout;
      rl._writeToOutput = function (str) {
        // Prompt text dikhao, lekin typed password ke chars mask karo.
        if (str.includes(question)) stdout.write(str);
        else stdout.write('*');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) stdout_newline();
      resolve(answer);
    });
  });
}

function stdout_newline() { process.stdout.write('\n'); }

async function resolvePassword(args) {
  // --from-env => ADMIN_NEW_PASSWORD env se
  if (args.includes('--from-env')) {
    const p = process.env.ADMIN_NEW_PASSWORD;
    if (!p) {
      console.error('❌ --from-env diya par ADMIN_NEW_PASSWORD env set nahi hai.');
      process.exit(1);
    }
    return p;
  }
  // --prompt => interactive
  if (args.includes('--prompt')) {
    const p = await ask('New admin password (8+ chars): ', { hidden: true });
    return p;
  }
  // warna pehla positional arg
  return args[0];
}

function resolveUsername(args) {
  // positional args me se flags hata do; password ke baad wala username hota hai.
  const positionals = args.filter(a => !a.startsWith('--'));
  const usesFlagPassword = args.includes('--from-env') || args.includes('--prompt');
  // flag-password mode me positional[0] = username; warna positional[1] = username.
  const uname = usesFlagPassword ? positionals[0] : positionals[1];
  return (uname && uname.trim()) || ENV_ADMIN_USER || 'admin';
}

function upsertAdmin(username, password) {
  const uname = String(username).trim();
  const hash = bcrypt.hashSync(password, 10);
  const email = `${uname.toLowerCase()}@admin.local`;

  const existing = db.prepare('SELECT id, email FROM users WHERE LOWER(username)=?').get(uname.toLowerCase());
  if (existing) {
    db.prepare('UPDATE users SET password=?, plain_password=? WHERE id=?').run(hash, password, existing.id);
    console.log(`✅ Admin user UPDATE ho gaya (id=${existing.id}, username=${uname}).`);
  } else {
    // email unique hai — clash avoid karne ke liye zaroorat pade to suffix.
    let finalEmail = email;
    let n = 1;
    while (db.prepare('SELECT 1 FROM users WHERE email=?').get(finalEmail)) {
      finalEmail = `${uname.toLowerCase()}+${n++}@admin.local`;
    }
    const info = db.prepare(
      'INSERT INTO users(username, email, password, plain_password, coins) VALUES(?,?,?,?,0)'
    ).run(uname, finalEmail, hash, password);
    console.log(`✅ Admin user CREATE ho gaya (id=${info.lastInsertRowid}, username=${uname}, email=${finalEmail}).`);
  }
  console.log('   Ab panel me is username + password se login karein.');
  console.log('   (env toot bhi jaye to DB-branch se login chalega.)');
}

(async () => {
  const args = process.argv.slice(2);
  const positionals = args.filter(a => !a.startsWith('--'));

  // Bina kisi argument/flag => sirf diagnostic, kuch nahi badalta.
  if (!positionals.length && !args.includes('--from-env') && !args.includes('--prompt')) {
    diagnostic();
    process.exit(0);
  }

  const password = await resolvePassword(args);
  if (!password || String(password).length < 8) {
    console.error('❌ Password kam se kam 8 characters ka hona chahiye.');
    process.exit(1);
  }
  const username = resolveUsername(args);

  console.log('═══ set-admin-password • UPSERT ═══');
  console.log('  username :', username);
  console.log('  password : (set — value print nahi ki)');
  upsertAdmin(username, password);
  process.exit(0);
})().catch((e) => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
