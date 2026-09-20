# Authentication Security Review — zayromod / APK Builder

**Review date:** 2026-09-03
**Scope:** `server.js`, `database/db.js`, `utils/session-store.js`, `utils/telegram.js`, both web frontends, deployment configuration and authentication-related data flows.

## Executive summary

The authentication implementation has been hardened in the repository. Password
registration uses bcrypt without an email-verification gate, public forgot/reset
email workflows are disabled, login is limited independently by IP and account
identifier, sessions are server-side and bounded, and provider/API credentials
are kept server-side.

Before deployment, operators must rotate any credentials that were ever in the
repository or its database backups. A code fix cannot make an already-copied
credential secret again.

### Existing APK compatibility

The authentication migration is additive for existing orders: it adds auth
metadata to `users` and a separate `sessions` table; it does not rewrite orders,
designs, Firebase paths, APK files, or their runtime content. Legacy Java APKs
continue using the public encrypted `/api/app-content/<firebase_path>` and
`/loading` endpoints, which remain unauthenticated and retain the fixed-password
fallback for old builds. Existing order paths were exercised against the
hardened server after the dependency/runtime fix and returned valid content.

## Acceptance criteria status

| Requirement | Status | Implementation |
|---|---|---|
| Passwords are strong hashes only | **Implemented** | New passwords use bcrypt with configurable work factor, minimum 10 and default 12. Legacy plaintext values are hashed during the SQLite startup migration where possible and `plain_password` is cleared. Login never compares the plaintext column. |
| Sessions expire and logout invalidates | **Implemented** | SQLite session store; absolute lifetime and idle timeout; Secure/HttpOnly/SameSite cookies in production; `__Host-` cookie name; session ID regeneration after every successful authentication; logout destroys the server record. |
| Email verification | **Intentionally disabled** | Password registrations use the email only as an account identifier and are immediately usable. No verification email, token, handoff, or resend endpoint is active. Google `email_verified` and Telegram signature checks remain provider-authentication controls. |
| Password reset | **Intentionally disabled** | No public forgot-password endpoint, email, reset token, or reset UI is active. Password changes must be performed through the operator's existing controlled procedure. |
| Login rate limiting | **Implemented** | Express rate limits are applied by client IP and by normalized account identifier. Failed login responses are generic and missing users still incur a bcrypt dummy comparison. |
| Secrets server-only | **Implemented** | Session secret, admin hash, Google client secret, Telegram bot token, and service-account credentials are read only by server code. Admin settings returns a configured boolean for the Telegram token, never its value; rotation input is write-only. |
| Google/Telegram preserved | **Implemented** | Google OAuth state is session-bound and Google email plus subject are required; Telegram WebApp data requires a configured bot token, fresh `auth_date`, and timing-safe HMAC comparison. Both paths regenerate the session and create only hashed placeholder passwords. |
| Deployment documentation | **Implemented** | `.env.example`, `SETUP.md`, and this document describe required values, bcrypt admin hash generation, HTTPS, trusted proxy configuration and token rotation. |

## Detailed controls

### Password storage and migration

- `bcryptjs` is used for user passwords and provider-only placeholder values.
- New password registrations use `BCRYPT_ROUNDS` (default 12; clamped to at
least 10). There is no email-delivery prerequisite.
- `database/db.js` scans legacy rows once at startup. A non-bcrypt `password` or
`plain_password` value is converted to a bcrypt hash; if no recoverable
password exists, a random hash is stored so the account fails closed until an
operator changes the credential. Every migrated `plain_password` value is
erased.
- The legacy `plain_password` column is retained only so old SQLite databases
can be migrated without a destructive schema rebuild. It has a blank default,
is never selected for an API response, and is never used for authentication.
- Existing valid bcrypt hashes with an older work factor are upgraded after a
successful login while the password is present only in process memory.
- Admin authentication accepts only `ADMIN_PASSWORD_HASH`; production startup
fails if it is missing, malformed, or weak. There is no default admin password
and no database/plaintext admin-password fallback.

### Session security

- `utils/session-store.js` replaces `MemoryStore` with a SQLite-backed store
that persists only serialized session state and an expiry timestamp.
- `SESSION_TTL_MINUTES` defaults to 480 minutes and
`SESSION_IDLE_TIMEOUT_MINUTES` defaults to 30 minutes. Both are enforced by the
server, not only by the browser cookie.
- Production cookies are `Secure`, `HttpOnly`, `SameSite=Lax`, path `/`, and
named `__Host-zayro.sid`. Development uses a non-Secure cookie and an ephemeral
random secret, so development sessions disappear on restart.
- `TRUST_PROXY_HOPS` must describe only infrastructure controlled by the
operator. It must not be set to a permissive value on a directly exposed
server.
- Successful password, admin, Google and Telegram authentication calls
`req.session.regenerate()` before saving identity state.
- Logout destroys the record and clears the cookie. The `users.session_version`
field remains available for controlled operator-side credential changes; old
sessions are rejected and destroyed on their next request when the version is
changed, including sessions created before this hardening if they do not contain
the current version metadata.

### Disabled email workflows

- Public email verification, resend-verification, forgot-password, and
password-reset routes and UI have been removed.
- Legacy token columns remain in SQLite only to avoid a destructive schema
migration. Startup cleanup clears any old verification/reset hashes and marks
password accounts usable immediately.
- No email-delivery secret or raw email token is read, generated, logged, or
returned by the active authentication code.

### Login and provider authentication

- `/api/login` and `/api/admin/login` use generic failure text and non-success
HTTP status codes.
- A missing user still receives a dummy bcrypt comparison, reducing timing
and account-existence signals.
- The IP limiter and account-key limiter are separate limiter instances, so an
attacker cannot bypass one by changing the other key.
- Google OAuth uses a random session-bound state, requires a verified Google
email and subject, links the provider identity server-side, and never sends the
client secret or access token to the browser.
- Telegram WebApp authentication fails closed when no bot token is configured;
there is no unsigned-data fallback. Browser links are short-lived, signed with
the bot token, validated for format/freshness, and compared timing-safely.

### Secret and response review

- `GET /api/admin/settings` uses a public-settings whitelist and returns only
`telegram_bot_token_configured: true|false` for the bot secret. Legacy
credential-shaped settings are erased during migration.
- The admin Telegram token field starts empty and accepts a value only for
server-side rotation; leaving it empty keeps the existing token.
- User/admin list responses no longer include `plain_password`.
- No session secret, OAuth client secret, bot token, service-account
credential, or legacy email-token value is returned in a frontend JSON response.
- Firebase access-token logging was removed; provider credential error output
is not returned to clients.

## Verification performed

- JavaScript syntax checks pass for `server.js`, `database/db.js`,
`utils/session-store.js`, `utils/telegram.js`, `utils/runtime-links.js`,
and the extracted inline frontend scripts.
- `express-rate-limit` accepts the separate account-key limiter configuration.
- `bcryptjs` accepts the dummy hash and the detector recognizes valid `$2a`,
`$2b`, and `$2y` formats.
- SQLite schema/data inspection was performed with Python's standard
`sqlite3` module; the native dependency is pinned to the Node 20-compatible
release in `package-lock.json`.
- Existing order runtime paths were exercised through the hardened server;
legacy popup and loading content returned successfully without a web session.

## Required deployment actions

1. Generate a unique `SESSION_SECRET` of at least 32 characters.
2. Generate a bcrypt admin hash and set `ADMIN_PASSWORD_HASH`; do not set or
invent a default password.
3. Set `BASE_URL` as the canonical HTTPS origin in production.
4. Set `TRUST_PROXY_HOPS` to the exact number of trusted proxies. With one
Nginx proxy, use `1` and forward `X-Forwarded-Proto` and
`X-Forwarded-For`; use `0` for direct HTTPS.
5. Revoke and replace every Telegram, Google, Firebase, signing, and restore
credential that was ever committed or included in a database backup. Keep
service-account JSON outside the repository.
6. Purge old secrets and database backups from Git history and access-controlled
artifact storage after rotation.
7. Deploy the Firebase deny-by-default rules separately and review them before
publishing; this authentication change does not replace Firebase authorization.

## Residual risks

- Rate-limit counters use the default in-process store. Use a shared rate-limit
store if deploying multiple workers/containers.
- Because no public password-reset flow exists, operators must maintain a
controlled process for changing a user's password without storing plaintext
credentials.
- A valid authenticated user can request files by filename through the existing
file route; filenames should remain unpredictable and authorization should be
made object-specific if sensitive files are added later.
