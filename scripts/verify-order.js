#!/usr/bin/env node
'use strict';

/**
 * verify-order.js — CLI se check karo ki kisi order ki jo APK server pe padi
 * hai wo ABHI ke design/template se bani hai ya purane se.
 *
 * Usage:
 *   node scripts/verify-order.js 414
 *   node scripts/verify-order.js 414 fake
 *   node scripts/verify-order.js 414 fs12        (extra fake site id 12)
 *
 * Output: verdict up-to-date / stale / apk-missing + template file + hashes.
 * Naye builds me marker hota hai (exact proof). Purane APKs ke liye content
 * similarity estimate dikhata hai (@see utils/buildstore.js).
 */

const db = require('../database/db');
const { findOrderApk, readApkPopupHtml, readBuildMeta, buildVerifyReport, extractLinksFromHtml } = require('../utils/buildstore');
const { renderContentHtml } = require('../utils/appcontent');

function countApkNameOwners(fileName) {
  try {
    const row = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE apk_file = ? OR fake_apk_file = ?) +
        (SELECT COUNT(*) FROM order_fake_sites WHERE apk_file = ?) AS c
    `).get(fileName, fileName, fileName);
    return row ? row.c : 0;
  } catch (_) {
    return 1;
  }
}

(async () => {
  const [orderIdArg, variantArg = 'real'] = process.argv.slice(2);
  const orderId = parseInt(orderIdArg, 10);
  if (!orderId) {
    console.log('Usage: node scripts/verify-order.js <orderId> [real|fake|fs<id>]');
    process.exit(1);
  }
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) {
    console.error('Order not found:', orderId);
    process.exit(1);
  }

  let fileName;
  let pathKey;
  if (variantArg === 'fake') {
    fileName = order.fake_apk_file;
    pathKey = order.fake_firebase_path;
  } else if (/^fs\d+$/.test(variantArg)) {
    const site = db.prepare('SELECT * FROM order_fake_sites WHERE id=? AND order_id=?').get(parseInt(variantArg.slice(2), 10), orderId);
    if (!site) { console.error('Fake site not found'); process.exit(1); }
    fileName = site.apk_file;
    pathKey = site.firebase_path;
  } else {
    fileName = order.apk_file;
    pathKey = order.firebase_path;
  }
  if (!fileName) {
    console.error(`${variantArg} APK abhi tak build nahi hua (fileName null)`);
    process.exit(1);
  }

  const apkInfo = findOrderApk(orderId, fileName, { allowGlobal: countApkNameOwners(fileName) <= 1 });
  let apkMeta = null;
  let apkHtml = null;
  if (apkInfo) {
    const inside = readApkPopupHtml(apkInfo.path, db, orderId, pathKey);
    if (inside) { apkHtml = inside.html; apkMeta = readBuildMeta(inside.html); }
  }
  let currentMeta = null;
  let currentHtml = null;
  let currentLinks = null;
  if (pathKey) {
    const rendered = renderContentHtml(pathKey, 'popup');
    if (rendered) {
      currentMeta = rendered.meta;
      currentHtml = rendered.html;
      if (rendered.params) {
        currentLinks = {
          registerUrl: rendered.params.registerUrl || null,
          depositUrl: rendered.params.depositUrl || null,
          wingoUrl: rendered.params.wingoUrl || null,
          firebasePath: rendered.params.firebasePath || pathKey || null
        };
      }
    }
  }

  const report = buildVerifyReport({
    apkInfo, apkMeta, currentMeta, apkHtml, currentHtml,
    apkLinks: apkHtml ? extractLinksFromHtml(apkHtml) : null,
    currentLinks,
    liveLink: Number(order.live_link_enabled) === 1,
    fields: { orderId, variant: variantArg, appName: order.app_name, status: order.status, firebasePath: pathKey }
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.match === false ? 2 : 0);
})().catch(err => {
  console.error('verify-order failed:', err.message);
  process.exit(1);
});
