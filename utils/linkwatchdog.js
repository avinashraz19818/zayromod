'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// linkwatchdog.js — FIREBASE SELF-HEAL (hacker ka automatic jawab)
//
// Server har 45 second me apne DB ke saare done orders ke firebase paths
// check karta hai:
//   - config.registerUrl / depositUrl / wingoUrl me hacker ke domains
//     (goavideo etc.) dikhe → DB wali original value wapas likh deta hai
//   - registerCondition / depositCondition false ho → dono TRUE kar deta hai
//   - minDeposit 99999 jaisa sabotage dikhe → 300 kar deta hai
//
// DB hi source of truth hai (admin ka link change DB bhi update karta hai),
// isliye ye kabhi legitimate change ko nahi rokta. Hacker ne kuch badla to
// maximum 45 second me khud wapas theek ho jayega.
//
// Rules deploy hone ke baad ye extra safety layer ban jata hai (hacker waise
// hi nahi likh payega).
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../database/db');
const { getFirebaseControl, updateFirebaseLinks, updateFirebaseControl, normalizeHttpUrl, firebaseRequest } = require('./runtime-links');

const BAD_MARKERS = ['goavideo', 'watchglb']; // hacker ke domains — naya mile to add karo
const WATCH_INTERVAL_MS = 45_000;

// In paths ke original codes humare paas nahi the (Asad/other sellers ke ya
// deleted orders) — hacker inhe baar-baar use kar raha tha. Ye ab BANNED
// hain: Firebase se DELETE kar diye gaye, aur agar dobara kahin aayein to
// watchdog khud delete kar dega.
const BANNED_PATHS = [
  'Asadzrodx',
  'asadzrodx',
  'zayroapex6clubsumit3',
  'zayroasaam',
  'zayronexustashansam',
  'zayronexustashsam'
];

function looksBad(url) {
  if (!url) return true;
  const u = String(url).toLowerCase();
  return BAD_MARKERS.some(m => u.includes(m));
}

function deriveFakeUrls(registerUrl) {
  const reg = String(registerUrl || '').trim();
  const baseMatch = reg.match(/^(https?:\/\/[^/]+)/);
  const base = baseMatch ? baseMatch[1] : reg.split('#')[0].replace(/\/+$/, '');
  // Dhani-style (inviteCode query, no hash) ya standard (#/register)
  if (reg.includes('inviteCode') && !reg.includes('#/')) {
    return {
      registerUrl: reg,
      depositUrl: base + '/wallet/recharge',
      wingoUrl: base + '/WinGo/WinGo_30S'
    };
  }
  return {
    registerUrl: reg,
    depositUrl: base + '/#/wallet/Recharge',
    wingoUrl: base + '/#/saasLottery/WinGo?gameCode=WinGo_30S&lottery=WinGo'
  };
}

async function healPath(path, expected) {
  if (!path || !expected || !expected.registerUrl) return null;
  try {
    const state = await getFirebaseControl(path);
    const cfg = state.config || {};
    const reg = cfg.registerUrl || cfg.regLink || cfg.register_Url || '';
    let heal = false;
    let reason = '';

    // 1) Hacker ka link
    if (looksBad(reg) || looksBad(cfg.depositUrl) || looksBad(cfg.wingoUrl)) {
      heal = true;
      reason = 'hacked-link(' + String(reg).slice(0, 50) + ')';
    } else {
      // 2) DB se mismatch (koi aur badal gaya)
      try {
        const regNorm = normalizeHttpUrl(reg);
        const dbNorm = normalizeHttpUrl(expected.registerUrl);
        if (reg && regNorm !== dbNorm) {
          heal = true;
          reason = 'mismatch(' + String(reg).slice(0, 50) + ')';
        }
      } catch (e) { /* invalid URL — neeche */ }
    }

    if (heal) {
      await updateFirebaseLinks(path, expected);
      return { path, reason };
    }

    // 3) Conditions sabotage
    if (cfg.registerCondition === false || cfg.depositCondition === false) {
      await updateFirebaseControl(path, { registerCondition: true, depositCondition: true });
      return { path, reason: 'conditions-off' };
    }

    // 4) minDeposit sabotage (99999 etc.)
    if (cfg.minDeposit !== undefined && Number(cfg.minDeposit) >= 99999) {
      await updateFirebaseControl(path, { minDeposit: 300 });
      return { path, reason: 'minDeposit-sabotage' };
    }
  } catch (e) {
    // network/4xx — ignore, agle cycle me
  }
  return null;
}

async function runWatchdogCycle() {
  let orders = [];
  try {
    orders = db.prepare(`
      SELECT id, firebase_path, register_url, deposit_url, wingo_url,
             fake_firebase_path, fake_register_url
      FROM orders WHERE status = 'done'
    `).all();
  } catch (e) {
    return;
  }

  // ── BANNED PATHS: agar dobara aayein to DELETE (hacker ke purane tools) ──
  for (const bp of BANNED_PATHS) {
    try {
      await firebaseRequest([bp], 'DELETE');
    } catch (e) { /* path hai hi nahi to bhi theek */ }
  }

  let healed = 0;
  for (const o of orders) {
    // REAL path
    if (o.firebase_path && o.register_url) {
      const r = await healPath(o.firebase_path, {
        registerUrl: o.register_url,
        depositUrl: o.deposit_url,
        wingoUrl: o.wingo_url
      });
      if (r) {
        healed++;
        console.log(`[watchdog] healed ${r.path} — ${r.reason}`);
      }
    }
    // FAKE path
    if (o.fake_firebase_path && o.fake_register_url) {
      const f = deriveFakeUrls(o.fake_register_url);
      const r = await healPath(o.fake_firebase_path, f);
      if (r) {
        healed++;
        console.log(`[watchdog] healed ${r.path} (fake) — ${r.reason}`);
      }
    }
  }
  if (healed > 0) console.log(`[watchdog] cycle done — ${healed} path(s) wapas theek kiye.`);
}

function startWatchdog() {
  // Pehli cycle 10 sec BAAD (server startup ke saath race na ho — admin
  // panel ki Firebase reads pehle turant chalti hain).
  setTimeout(() => { runWatchdogCycle(); }, 10000).unref?.();
  const timer = setInterval(runWatchdogCycle, WATCH_INTERVAL_MS);
  timer.unref?.();
  console.log('[watchdog] Firebase self-heal started (45s cycle, first run in 10s).');
  return timer;
}

module.exports = { startWatchdog, runWatchdogCycle };
