# MizanMod Studio dark refresh

Charcoal/teal panel identity, desktop client rail, floating mobile navigation, searchable design library, new studio illustration, redesigned admin overview/login and quiet, reduced-motion-aware animations. All existing API endpoints, form IDs and actions are retained. The bot uses concise Studio messages and plain labels rather than boxed VIP marketing text; unsafe blanket antivirus/safety claims are removed. Telegram itself controls chat wallpaper/colors/animations; CSS cannot recolor the Telegram app.

## Published catalog

69 source HTML files comprise 68 design files and one loader. The publication manifest groups these into 43 entries: 36 primary designs (25 have paired alternates) and seven standalone API designs. File pairs use the available source design-file mapping when present, otherwise only a unique same-upload timestamp within 10 ms; ambiguous alternatives remain standalone rather than being guessed. Only filename relationships were used: no old user/account/order records, database files, prices, Firebase settings or credentials are imported.

New primary designs are active at **10 coins**; paired alternates and standalone API designs are **5 coins**. These rates and publication were explicitly selected by the requester. Matching existing filenames/content are skipped; existing prices, active status and uploaded designs remain unchanged. Equivalent primary/alternate bundles are skipped (not merely matching primary HTML). On an empty database, 31 entries cover all unique non-loading HTML content; 12 duplicate bundles are skipped. Your existing matching designs can reduce the newly inserted count further. Existing matching primary entries are not rewritten to attach alternates. No preview screenshots existed in this handoff; generic artwork is explicitly labeled, not passed off as a preview.

`node scripts/import-catalog.js` backs up the new installation's current SQLite database under `secrets/` using SQLite's backup API, refuses active/pending orders, and adds entries in one transaction. Re-running does not duplicate entries. The original source DB is not shipped or read on the VPS.

## Existing VPS update

Use the dedicated Studio update archive and its `apply-update.py`. Do not copy the full source ZIP over an existing installation. The updater checks checksums and refuses active/pending orders, stops only `mizanmod-full`, creates a private DB/file backup, installs only listed UI/bot/catalog files, imports the library and verifies local health. On failure it restores the backed-up files/database and previous service. `.env`, signing keys, Android SDK, systemd unit/drop-ins and Nginx configuration are never overwritten. Existing bot allowlist and polling policy remain unchanged. Keep a separate encrypted off-server backup as well.

After the update, run `node --env-file=.env scripts/configure-bot.js` as the service user to update bot display name, description, command menu and Open Studio button. Username/token remain unchanged. Use BotFather to change the bot avatar if desired; `public/mark.svg` is the web brand mark. Telegram controls native chat theme and message animations.

This UI/catalog refresh is not certification of full Android builds, all 68 design runtimes, payment behavior or device installation. Verify on the actual VPS and Telegram clients before selling builds.

## Local checks

`npm test` runs 12 tests. `python3 -m unittest discover -s tests -p test_studio_updater.py -v` runs the isolated updater safety tests. Optional browser regression: install Playwright in a separate testing environment, then run `node tests/browser/studio.cjs` with its module directory in `NODE_PATH` and an installed browser (or `CHROMIUM_EXECUTABLE`). This script mocks all APIs/Telegram data and writes screenshots to `SCREENSHOT_DIR` or the OS temp directory. It does not authenticate a real Telegram user or test payments/building.
