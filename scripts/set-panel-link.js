#!/usr/bin/env node
'use strict';

/**
 * set-panel-link.js — kisi bhi panel ka Firebase link TERMINAL se badlo
 * (admin panel ke bina — service account token server ke through lagta hai)
 *
 * Usage (VPS, project folder se):
 *   node scripts/set-panel-link.js <firebase_path> <pura_register_url>
 *
 * Example:
 *   node scripts/set-panel-link.js zayroyaarwinapp "https://yaarwin.app/#/register?invitationCode=1234567890"
 *
 * Ye khud deposit/wingo URLs derive karta hai (dhani pattern bhi sambhalta
 * hai) aur server ke /api/admin/firebase/restore-link endpoint se PATCH
 * karta hai. RESTORE_SECRET .env me hona chahiye.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') }); } catch (e) {}

const [pathArg, urlArg] = process.argv.slice(2);
const SECRET = process.env.RESTORE_SECRET || '';
const PORT = process.env.PORT || '3000';

if (!pathArg || !urlArg) {
  console.log('Usage: node scripts/set-panel-link.js <firebase_path> <pura_register_url>');
  console.log('Example: node scripts/set-panel-link.js zayroyaarwinapp "https://yaarwin.app/#/register?invitationCode=1234567890"');
  process.exit(1);
}

function derive(reg) {
  const m = String(reg).match(/^(https?:\/\/[^/]+)/);
  const base = m ? m[1] : String(reg).split('#')[0].replace(/\/+$/, '');
  // Dhani-style: inviteCode query + no hash
  if (/invitecode=/i.test(reg) && !reg.includes('#/')) {
    return { dep: base + '/wallet/recharge', wingo: base + '/WinGo/WinGo_30S' };
  }
  return { dep: base + '/#/wallet/Recharge', wingo: base + '/#/saasLottery/WinGo?gameCode=WinGo_30S&lottery=WinGo' };
}

(async () => {
  const urls = derive(urlArg);
  console.log('═ SET PANEL LINK ═');
  console.log('  path    :', pathArg);
  console.log('  register:', urlArg);
  console.log('  deposit :', urls.dep);
  console.log('  wingo   :', urls.wingo);
  console.log('');

  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/admin/firebase/restore-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-restore-secret': SECRET },
      body: JSON.stringify({ path: pathArg, registerUrl: urlArg, depositUrl: urls.dep, wingoUrl: urls.wingo }),
      signal: AbortSignal.timeout(30000)
    });
    const j = await res.json().catch(() => ({}));
    if (j && j.success) {
      console.log(`✅ LINK SET HO GAYA — ${pathArg}`);
      console.log('   Apps refresh hote hi naya link load karenge.');
    } else {
      console.log(`❌ FAIL (HTTP ${res.status}):`, JSON.stringify(j).slice(0, 300));
      console.log('');
      console.log('── Debug ke liye chalao:');
      console.log('   pm2 logs apkbuilder --lines 20 --nostream');
    }
  } catch (e) {
    console.log('❌ Server tak request nahi pahunchi:', e.message);
    console.log('   → Server chala hai? pm2 status');
    console.log('   → RESTORE_SECRET .env me hai? grep RESTORE_SECRET .env');
  }
})();
