# MizanMod — full platform staging port

This directory ports the complete reference platform's server, administrative workflows, client catalog, orders, credits, announcements, HTML upload, runtime content, Firebase controls and Java Android build/template architecture. It is **not the previous minimal offline studio** and it does **not share its database schema**.

**Status: staging source, not approved for a live cutover.** Seven automated tests pass (including many API/auth/CRUD assertions) and npm audit reports zero vulnerabilities. Real Firebase integration, live Telegram polling/delivery, the full Android template's signed APK build, device launch and complete UI regression tests have not yet been performed. A successful APK from the earlier minimal shell does not validate this platform.

## What stays independent

- No copied user accounts, orders, database backups, signing keys. Rebranded HTML templates and the PNG/font/audio asset pack are included at the client's explicit request; see docs/ASSETS.md.
- Fresh `database/mizanmod.db` on first start. Do not point it at the minimal studio's SQLite file.
- Dedicated session secret, bcrypt admin password and content-encryption password.
- Explicit new Firebase project/service account; no discovery of shared root credentials or hardcoded cloud account defaults.
- Existing **new Mizan-owned keystore** can be preserved at its private external path; do not regenerate it.
- MizanMod brand and fresh navy/amber theme/icon. Full layouts and interactions are inherited; this is not a wholly new UI redesign.
- All 69 HTML templates from the available source are included with new text branding and blank Firebase account fields. The old encrypted loading blob is excluded: builds generate a new one using the new content secret. See docs/TEMPLATES.md.

## Access model

Admin: `https://admin.mizammod.site/admin` with a separate username and bcrypt-password login. This replaces the minimal studio's admin-token login, not the signing key.

Client: `https://app.mizammod.site` opened by `@MizanModBuilder_bot`. Password registration/login, Google OAuth, client Telegram-ID reassignment and browser one-click login routes are removed. Fresh Telegram initData signatures are validated server-side (five-minute age window); duplicate fields and unapproved IDs are rejected. Sessions are host-only, secure and SameSite=None in production for embedded Telegram clients. Third-party-cookie behavior still needs real Telegram desktop/mobile testing. The signed session protects API access; browser/UA detection alone is not security.

`TELEGRAM_ALLOWED_IDS` is a comma-separated numeric allowlist. Empty denies every client; set `*` explicitly only if all authenticated Telegram users should register. `TELEGRAM_APPROVER_IDS` separately controls bot credit-approval callbacks. A notification chat ID is not authorization.

## Prerequisites

Node 22.13+, JDK 17, Android SDK 35 / build tools 35.0.0, Gradle 8.13 wrapper. On Linux install `build-essential python3` if the native SQLite prebuilt download is unavailable. When Node's headers already exist under `/usr`, a local build can use `npm_config_nodedir=/usr npm ci`; do not disable TLS verification.

```sh
npm ci
npm test
npm audit
cp .env.example .env
# Fill private values in .env, never in chat or Git.
npm start
```

Do not run these commands over the live minimal studio folder. Stage in a new directory and use port 3100; the existing live service remains on 3000 until acceptance and cutover.

## Environment

See `.env.example`. Required production credentials: `SESSION_SECRET` (32+ random chars), `ADMIN_PASSWORD_HASH` (bcrypt cost 10+, recommend 12), `CONTENT_ENCRYPTION_PASSWORD` (32+ random chars). Signing requires `KEYSTORE_PATH`, `KEYSTORE_ALIAS`, `KEYSTORE_PASSWORD`, `KEY_PASSWORD`. Keep passwords outside command arguments; the builder references environment variables for signing/keytool.

Firebase requires `FIREBASE_PROJECT_ID`, `FIREBASE_DATABASE_URL`, `FIREBASE_WEB_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`. The service account project ID must match the configured project. A new cloud project is **not provisioned by this source archive**. Firebase rules are deny-by-default; new runtime templates use the application-server bridge. Existing legacy designs with custom direct Firebase listeners must be reviewed/ported, not connected to a previous account or worked around by making the database public.

`BOT_POLLING_ENABLED=false` is the staging default. Set it to true only after adding the new bot token and ensuring no other process is polling that bot. Configure BotFather only after the client HTTPS route is switched and validated. Bots/Telegram are remote dependencies; a unit test is not proof of real delivery.

## Functional differences and remaining acceptance

- Compatible variant fields, orders, pricing and admin workflows are retained; 69 rebranded template files are now included by explicit request.
- A neutral loading HTML is supplied. The catalog starts empty: no test users/designs/order seeds.
- The requested original audio/font/image assets are bundled. Asset reuse is not a claim that all spoken/visual content has been rebranded; review the media before client release.
- The unavailable alternative compiler and unused packer utilities are excluded. The active Java pipeline is retained.
- A new compatibility adapter bridges existing bot workflows to the maintained v2 Telegram library; live polling, callbacks and file delivery need validation.
- Bot callback approval requires an explicit operator allowlist. No guaranteed-malware-safety claims or instructions to bypass device scanning are presented.
- The reference's in-memory build queue is retained in this full port. Do not restart during compilation; persist/recover jobs before scaling it as a service.
- Do not reuse the minimal studio systemd writable-path settings unchanged: this platform writes `database/`, `builds/`, `templates/`, `uploads/`, `backups/` and potentially the Android template within its own staging root. A separate deployment unit is required.

## Migration

Read `docs/MIGRATION.md`. Do not delete or overwrite the running minimal studio, its runtime directory, secret files or generated signing key. No automatic live deployment or Git push accompanies this source handoff.

## Guided configuration for the existing Mizan VPS

After extracting into the NEW full-platform staging directory, install dependencies as its non-root owner. Reuse only the signing values from the earlier Mizan-owned installation:

```sh
npm run setup:private -- --signing-env=/opt/mizanmods/.env
```

This creates new session/content secrets and a bcrypt admin login. It copies only `KEYSTORE_PATH`, `KEYSTORE_ALIAS`, `KEYSTORE_PASSWORD`, `KEY_PASSWORD`; it does not copy the old admin token, Firebase settings or database. It never rewrites key bytes and refuses to overwrite an existing `.env`. Read `secrets/admin-access.txt` privately to obtain the new admin password. Do not paste it in chat or put it in a public web directory.

Set the NEW Firebase account values, new bot token and Telegram allowlist in the new `.env`. Then:

```sh
npm run doctor
npm run doctor:live
```

The first command checks local configuration/tooling/key access without contacting cloud services. The second requires all local checks to pass and explicitly verifies Telegram `getMe` and Firebase write/read/delete under a unique `mizanmod_setup_check` child. It does not verify actual Android compilation or real Telegram client sessions. No arbitrary prior project/root data is deleted.

After local and live checks pass, stage the admin panel, upload a compatible client-owned design, configure credits/user access and build a full-template APK. Verify signing, install/launch, runtime config and download before switching the production proxy. A generic arbitrary HTML page is not guaranteed to implement the platform's expected JavaScript/runtime hooks.
