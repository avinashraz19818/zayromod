# Authentication Security Review — zayromod / APK Builder

**Review date:** 2026-09-03
**Scope:** `server.js`, `database/db.js`, `utils/email.js`, `utils/session-store.js`, `utils/telegram.js`, both web frontends, deployment configuration and authentication-related data flows.

## Executive summary

The authentication implementation has been hardened in the repository. Password
registration now requires email verification, password-reset and verification
credentials are one-time expiring random tokens hashed in SQLite, login is
limited independently by IP and account identifier, sessions are server-side
and bounded, and provider/API credentials are kept server-side.

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
| Email verification | **Implemented** | Password registrations are locked until verified. Tokens use 32 random bytes, SHA-256 hashes at rest, expiry, conditional single-use update, and resend invalidation. Provider identities are trusted only after verified Google identity or valid Telegram authentication. |
| Password reset | **Implemented** | Generic forgot-password response; random hashed expiring one-time token; server-side token handoff into an HttpOnly session; clean redirect before frontend load; password change clears the token, marks email ownership verified, and increments `session_version`. |
| Login rate limiting | **Implemented** | Express rate limits are applied by client IP and by normalized account identifier. Failed login responses are generic and missing users still incur a bcrypt dummy comparison. |
| Secrets server-only | **Implemented** | Session secret, admin hash, Google client secret, Telegram bot token, Resend key and service-account credentials are read only by server code. Admin settings returns a configured boolean for the Telegram token, never its value; rotation input is write-only. |
| Google/Telegram preserved | **Implemented** | Google OAuth state is session-bound and Google email plus subject are required; Telegram WebApp data requires a configured bot token, fresh `auth_date`, and timing-safe HMAC comparison. Both paths regenerate the session and create only hashed placeholder passwords. |
| Deployment documentation | **Implemented** | `.env.example`, `SETUP.md`, and this document describe required values, bcrypt admin hash generation, HTTPS, trusted proxy configuration, email delivery and token rotation. |

## Detailed controls

### Password storage and migration

- `bcryptjs` is used for user passwords and provider-only placeholder values.
- New registrations and password resets use `BCRYPT_ROUNDS` (default 12; clamped
to at least 10).
- `database/db.js` scans legacy rows once at startup. A non-bcrypt `password` or
`plain_password` value is converted to a bcrypt hash; if no recoverable
password exists, a random hash is stored so the account fails closed until a
reset. Every migrated `plain_password` value is erased.
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
- Logout destroys the record and clears the cookie. Reset/change operations
increment `users.session_version`; old sessions are rejected and destroyed on
their next request, including sessions created before this hardening if they do
not contain the current version metadata.

### Verification and reset tokens

- Tokens are generated with `crypto.randomBytes(32)` and are never stored raw.
- SQLite stores only SHA-256 token hashes and millisecond expiry timestamps.
- Updates include the expected hash and expiry predicate, preventing a token
from being consumed twice in a race.
- Verification and reset links are handled by server routes and then redirected
to a clean frontend URL. Raw values are not returned by registration, forgot,
verification, reset, `/api/me`, or settings responses, and are not placed in
frontend JavaScript state.
- Forgot-password and resend-verification responses have the same message for
known, unknown, invalid, and already-complete accounts.
- `Referrer-Policy: no-referrer` is applied globally to reduce accidental token
forwarding from action URLs.

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
- No session secret, OAuth client secret, Resend credential, bot token, service
account credential, or raw reset/verification value is returned in a frontend
JSON response.
- Firebase access-token logging was removed; provider credential error output
is not returned to clients.

## Verification performed

- JavaScript syntax checks pass for `server.js`, `database/db.js`,
`utils/email.js`, `utils/session-store.js`, `utils/telegram.js`,
`utils/runtime-links.js`, and the two extracted inline frontend scripts.
- `express-rate-limit` accepts the separate account-key limiter configuration.
- `bcryptjs` accepts the dummy hash and the detector recognizes valid `$2a`,
`$2b`, and `$2y` formats.
- SQLite schema/data inspection should be performed with Python's standard
`sqlite3` module in this environment. Loading `better-sqlite3` directly was
observed to segfault in the supplied sandbox, so no destructive Node runtime
migration test is claimed here.

## Required deployment actions

1. Generate a unique `SESSION_SECRET` of at least 32 characters.
2. Generate a bcrypt admin hash and set `ADMIN_PASSWORD_HASH`; do not set or
invent a default password.
3. Configure `BASE_URL` as the canonical HTTPS origin,
`RESEND_API_KEY`, and `EMAIL_FROM` before enabling password registration.
4. Set `TRUST_PROXY_HOPS` to the exact number of trusted proxies. With one
Nginx proxy, use `1` and forward `X-Forwarded-Proto` and
`X-Forwarded-For`; use `0` for direct HTTPS.
5. Revoke and replace every Telegram, Google, Firebase, SMTP/Resend, signing,
and restore credential that was ever committed or included in a database
backup. Keep service-account JSON outside the repository.
6. Purge old secrets and database backups from Git history and access-controlled
artifact storage after rotation.
7. Deploy the Firebase deny-by-default rules separately and review them before
publishing; this authentication change does not replace Firebase authorization.

## Residual risks

- Rate-limit counters use the default in-process store. Use a shared rate-limit
store if deploying multiple workers/containers.
- Email action URLs necessarily contain a bearer value while traveling from the
mail client to the server. They are short-lived, single-use, HTTPS-only in
production, immediately redirected, and never exposed in API JSON. Protect
mailboxes and reverse-proxy access logs.
- Existing accounts without an email verification timestamp must use the
resend-verification or password-reset flow before password login is allowed.
- A valid authenticated user can request files by filename through the existing
file route; filenames should remain unpredictable and authorization should be
made object-specific if sensitive files are added later.
