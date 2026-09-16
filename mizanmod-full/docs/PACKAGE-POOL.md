# Real APK package stock

Admin → **Package names** adds inventory without changing either panel HTML file. Paste one Android package name per line (up to 1,000 per batch). Bullets and “📦 Allocated Packages:” are accepted. FIFO follows pasted order, not numeric sorting. Invalid entries, duplicates and package names already present in orders are skipped and reported. No examples are seeded.

New real orders, including free admin orders and real+alternate orders, reserve the next available name in an immediate SQLite transaction with the order and coin charge. Alternate-only orders keep the previous generator. `apkbuilder.js` uses the saved order package as Gradle applicationId. Existing orders/rebuilds retain their saved name; failures, refunds and order deletion do not release a reservation. Only unused names can be removed.

When stock is empty, new real requests return HTTP 409 / PACKAGE_POOL_EMPTY before an order or coin charge. Add stock to resume. The bot alerts authorized package admins when empty, retries delivery failures, and suppresses repeat successful notifications until restock. Delivery is not exactly-once: a crash or partial recipient failure can repeat an alert.

## Telegram

1. Send `/myid` privately to the existing bot.
2. Save that numeric ID in web admin → Package names → Telegram package admins. Each recipient must first start the bot so it can send private messages.
3. Send `/packages` for stock and next names.
4. Send `/addpackages`, then paste the list in the next message within ten minutes; or put the list below `/addpackages` in the same message. `/cancelpackages` cancels entry.

These commands work when typed even without a command-menu refresh. Only explicitly authorized IDs in private chats can manage stock. Public client wildcard access does not grant inventory access. Before a web-admin setting is saved, IDs default to TELEGRAM_PACKAGE_ADMIN_IDS, then TELEGRAM_APPROVER_IDS, then TELEGRAM_ADMIN_CHAT_ID. Save an empty list to disable package bot access/alerts. Never use `*` for package admins.

## Narrow VPS update

Apply only to the existing classic MizanMod full installation at `/opt/mizanmod-full` with the `mizanmod-full` systemd service. Finish all pending/active builds first. Extract the dedicated Package-Pool ZIP outside the app, then run its `apply-package-pool.py` as root. No reinstall, npm installation, catalog import, key generation or panel replacement is needed. Android-tools systemd PATH fix remains unchanged.

The updater checks payload and existing backend hashes, refuses unexpected/customized backend files, stops the service, rechecks idle status, privately backs up code and SQLite, copies only seven allowlisted files, and checks health. An existing customized client HTML is deliberately neither shipped nor overwritten; the classic admin addon is injected into the HTTP response. No designs or credentials are shipped.

If failure occurs after installation starts, the service is left stopped for forward repair. **Do not restore an older database or old package-allocation code after orders have used stock**: that could reuse a package name. Preserve all reservation records, including failed/deleted orders. Backups contain private user/order data and must remain private.

Stock begins empty. Add your own approved names after installing. Package syntax validation cannot establish ownership or guarantee compatibility with independently installed apps.

## Verification limits

Automated tests cover SQLite FIFO/concurrency/rollback, permissions, alert epochs and actual HTTP real/both/alternate/admin order flows, including failed rebuild reuse and empty-stock accounting. HTTP tests use a deliberately failing stub builder and isolated temporary DB. They do not prove a production APK has compiled, signed, downloaded, installed or run on a device. After deployment, build one real APK and inspect its applicationId (Android `apkanalyzer manifest application-id` or `aapt dump badging`), compare with the reserved order/package row, and install/test it on a device. Verify private bot alert delivery and browser addon rendering on the live deployment separately.
