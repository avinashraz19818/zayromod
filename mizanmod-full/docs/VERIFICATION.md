# Staging verification

## Executed locally

- Source syntax check: all standalone JS files parsed with Node.
- Dependency install: initial native SQLite prebuilt/header downloads failed TLS/network access. Successfully compiled SQLite using locally installed Node headers (`npm rebuild better-sqlite3 --build-from-source --nodedir=/usr/local`). TLS validation was not disabled.
- Updated maintained packages, including the Telegram v2 compatibility boundary: final `npm audit --omit=dev` reports zero vulnerabilities.
- Four tests PASS: isolated server bootstrap with fresh SQLite, empty users/designs, admin login, authenticated design upload/list/delete, client registration via signed synthetic Telegram initData, wrong/expired/unapproved authentication, client/admin separation, client order isolation, disabled password/Google/browser-link auth routes, HTML server-bridge injection and encryption round-trip. Telegram adapter method mapping is mocked; it makes no real bot request.
- No previous database, credentials, APKs, encrypted blobs were imported. Rebranded HTML templates are now included. The requested reusable media asset pack is now included; SHA-256 parity is recorded in assets-manifest.json.

## Not yet verified

Actual bot polling/upload delivery, real Telegram mobile/desktop embedded cookies, cloud Firebase project/rules/connection, full browser UI regression and signed full-template Android APK/device behavior. The earlier minimal builder's VPS success does not cover this platform. Do not present this staging port as a complete production-tested clone.

## Fresh archive setup

Extracted the source ZIP to a clean independent directory, installed dependencies using local Node headers (`npm_config_nodedir=/usr/local npm ci`), and reran all four tests: PASS. Audit in the fresh extraction: zero vulnerabilities. The local-header workaround is environment-specific and does not disable TLS. This checks fresh archive setup, not a GitHub clone or the remote VPS deployment.

## Media/configuration follow-up

Initially included 38 original PNG/font/audio files by explicit request and verified byte parity against a SHA-256 manifest. The prior encrypted loading design remains excluded. Added guided private setup with an exclusive-write policy and a test proving that only four signing settings are reused, key bytes are unchanged, old Firebase/admin-token values are not copied, and private file permissions are 0600. That revision: six tests passed; dependency audit: zero vulnerabilities. Doctor live checks are supplied but have not been run against a real client bot/Firebase account here.

## Full-template revision

Latest scope includes 69 HTML templates and 37 original media files plus a new MizanMod default icon. Seven tests pass. Inline template scripts parse successfully, including processed scripts; the runtime bootstrap was moved ahead of original listeners and now survives templates declaring `var rtdb=null`. Text/credential scanning excludes image data-URI payloads to avoid mistaking random base64 bytes for account identifiers. Old account data, database files and compiled artifacts remain excluded.

## Telegram polling diagnostic patch

The VPS passed the original seven tests and live Telegram/Firebase checks, but `/start` delivery is still unverified. The adapter now explicitly subscribes to message/callback updates, uses a 10-second poll timeout and passes the requested HTTP timeout to the v2 client. Retry errors are rate-limited and redacted; `/start` logs only approved/private booleans, not account IDs or message contents. v2 `errorCode` is preserved instead of being mislabeled as a network failure. A new isolated mock test passes for polling options, dispatch, retry throttling and redaction. This patch has not yet been verified against live VPS polling; the precise original silence cause remains unconfirmed.
