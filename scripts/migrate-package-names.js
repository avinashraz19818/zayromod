#!/usr/bin/env node
'use strict';

/**
 * migrate-package-names.js — purane orders ke package name ko naye
 * `zayro.<name><counter>` format me badlo.
 *
 * ⚠️  IMPORTANT (padh lo pehle):
 *   - applicationId APK ke andar baked hota hai. DB me naam badalne se
 *     kuch nahi hota jab tak us order ko REBUILD na karo.
 *   - Rebuild ke baad naya applicationId aata hai ⇒ jo log purani app
 *     install kar chuke hain, unke phone pe purani app waisi hi rahegi aur
 *     nayi alag app ban kar install hogi (do icons). Agar ye nahi chahiye to
 *     purane orders ko chhodo — naye orders apne aap `zayro.*` pe banenge.
 *
 * Usage (VPS, project folder se):
 *   node scripts/migrate-package-names.js              # dry-run list
 *   node scripts/migrate-package-names.js --order=414  # sirf ek order dekhо
 *   node scripts/migrate-package-names.js --run        # DB me apply karo
 *   node scripts/migrate-package-names.js --run --pending-only
 *        (sirf wahi orders jinke APK abhi tak build nahi hue / rebuild pending)
 */

const db = require('../database/db');

const args = process.argv.slice(2);
const hasFlag = n => args.some(a => a === n || a.startsWith(n + '='));
const getArg = (n, d) => {
  const hit = args.find(a => a.startsWith(n + '='));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const RUN = hasFlag('--run');
const ONLY_ORDER = parseInt(getArg('--order', '0'), 10) || 0;
const PENDING_ONLY = hasFlag('--pending-only');

const PREFIX = String(process.env.PACKAGE_PREFIX || 'zayro').trim().toLowerCase().replace(/[^a-z0-9_]/g, '') || 'zayro';

function propose(base, orderId, taken) {
  const stem = String(base || 'app').replace(/^\.+|\.+$/g, '') || 'app';
  let candidate = `${PREFIX}.${stem}`;
  if (!taken.has(candidate)) return candidate;
  candidate = `${PREFIX}.${stem}${orderId}`;
  let i = 2;
  while (taken.has(candidate)) candidate = `${PREFIX}.${stem}${orderId}x${i++}`;
  return candidate;
}

function main() {
  let rows = db.prepare('SELECT id, app_name, package_name, status, apk_file, fake_apk_file FROM orders ORDER BY id').all();
  if (ONLY_ORDER) rows = rows.filter(r => r.id === ONLY_ORDER);
  if (PENDING_ONLY) rows = rows.filter(r => !r.apk_file);

  const already = new Set(rows.filter(r => String(r.package_name || '').startsWith(PREFIX + '.')).map(r => r.package_name));
  const taken = new Set(rows.map(r => String(r.package_name || '')).filter(Boolean));
  for (const r of rows) taken.delete(String(r.package_name || ''));

  const plan = [];
  for (const r of rows) {
    const current = String(r.package_name || '');
    if (current.startsWith(PREFIX + '.')) continue;                 // already naya format
    const base = current.includes('.') ? current.split('.').pop() : current;
    const next = propose(base || 'app', r.id, taken);
    taken.add(next);
    plan.push({ id: r.id, app: r.app_name, from: current, to: next, hasApk: !!r.apk_file, status: r.status });
  }

  console.log('═'.repeat(70));
  console.log(RUN ? ' MIGRATE PACKAGE NAMES (LIVE RUN)' : ' MIGRATE PACKAGE NAMES (DRY-RUN)');
  console.log('═'.repeat(70));
  console.log(`prefix=${PREFIX}.  total orders=${rows.length}  already new=${already.size}  to-change=${plan.length}\n`);
  for (const p of plan.slice(0, 60)) {
    console.log(`  #${String(p.id).padEnd(5)} ${String(p.from).padEnd(28)} → ${String(p.to).padEnd(28)} ${p.hasApk ? '(APK hai — rebuild ke baad hi asar hoga)' : '(abhi build pending)'}  ${p.app || ''}`);
  }
  if (plan.length > 60) console.log(`  … +${plan.length - 60} more`);

  if (!RUN) {
    console.log('\nYe dry-run tha. Apply karne ke liye:');
    console.log('  node scripts/migrate-package-names.js --run            # sabhi purane orders');
    console.log('  node scripts/migrate-package-names.js --run --pending-only  # sirf jinke APK nahi bane');
    console.log('\nYaad rakho: asar tabhi hoga jab us order ko REBUILD karo (applicationId APK ke andar hai).');
    return;
  }

  let changed = 0;
  const tx = db.transaction(() => {
    for (const p of plan) {
      db.prepare('UPDATE orders SET package_name=? WHERE id=?').run(p.to, p.id);
      changed++;
    }
  });
  tx();
  console.log(`\n✅ ${changed} order(s) ka package_name DB me update ho gaya.`);
  console.log('Ab jin orders ko naya package chahiye unhe REBUILD karo (admin → Orders → Rebuild).');
}

try { main(); } catch (e) {
  console.error('migrate-package-names failed:', e.message);
  process.exit(1);
}
