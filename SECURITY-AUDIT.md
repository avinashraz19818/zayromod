# Security Audit — zayromod / APK Builder

> ## ➕ ADDENDUM — Design Theft Fix (02 Sep 2026, evening)
> Operator report: designs stolen right after upload ("theme select karte hi
> response URL mil jata hai"). Two holes closed (details at the bottom):
> 1. `/api/designs/:id` was **public + `SELECT *`** — leaked design source
>    filenames (`popup_html_file`) to anyone.
> 2. `/api/app-content/:path` was **keyless + encrypted with a committed
>    public key** — the design's full HTML was downloadable and decryptable
>    by anyone with a path. **Now: per-order secret (random, XOR-masked into
>    the APK) + required `?k=` token + 120 req/min/IP rate limit.** Old
>    orders keep working (legacy mode); every NEW order is protected.
> See "Addendum details" at the end of this file.

**Date:** 2026-09-02 · **Scope:** full repo (server.js, utils/, scripts/, database/, android-project/, git history)
**Method:** the "5 Security Checks Before You Launch Your Vibe-Coded App" guide (Gitleaks-style secret scan, Bearer-style data-flow audit, production audit, deep logic audit, attacker-perspective review), applied manually against the codebase.

---

## 🔴 DO THIS NOW (manual steps I cannot do from here)

Secrets found **committed in git history**. Removing them from the latest commit is not enough — anyone with repo access (or any old clone) still has them. In priority order:

| # | Action | Why |
|---|--------|-----|
| 1 | **Firebase service account**: delete the key `5379a401…` (Firebase Console → Project settings → Service accounts → the `firebase-adminsdk-fbsvc@zayrodev-195f3` key), generate a new one, store it on the VPS **outside** the repo (e.g. `/root/firebase/`), point `GOOGLE_APPLICATION_CREDENTIALS` at it | Full admin access to your Firebase project was in the repo (`firebase-service-account.json`) |
| 2 | **Telegram bot token**: revoke via @BotFather (`/revoke`) and set the new token in the admin panel + `.env` | Bot token `8714157…` was stored in the committed DB (`settings.telegram_bot_token`) — anyone with it controls your bot, reads user chats/orders |
| 3 | **Signing keystore**: generate a NEW `release.keystore` with a new password (`keytool -genkeypair -v -keystore release.keystore -alias zayro -keyalg RSA -keysize 2048 -validity 10000`), set `KEYSTORE_PASSWORD` + `KEYSTORE_ALIAS` in `.env`. ⚠️ Existing users will need to install updates as a "new" app (signature change) — plan the rollout | `keystore/release.keystore` + password `zayro@123` were both committed — anyone can sign malicious updates that install over your APKs |
| 4 | **Admin password**: confirm `ADMIN_PASSWORD` in the VPS `.env` is strong and unique. There is **no default anymore** — if unset, env-admin login is disabled | Code previously fell back to `admin` / `admin123` |
| 5 | **Purge git history**: after rotating, rewrite history (e.g. `git filter-repo --path firebase-service-account.json --path keystore --path database/apkbuilder.db --invert-paths` or BFG) and force-push. Old clones still count as exposure | Rotation without history purge leaves the old values usable forever |
| 6 | **Deploy the tightened Firebase rules**: `firebase.rules.json` / `database.rules.json` in this repo are fixed, but rules only take effect after `bash scripts/deploy-rules.sh` (needs your Firebase CLI login). Review the diff first | The old rules made the whole RTDB world-readable/writable (see Check 5, finding 5.1) |
| 7 | **Restrict the Firebase Web API key**: Google Cloud Console → Credentials → the `AIzaSyDja5…` key → Application restrictions → Android app (package names of your builds); API restrictions → RTDB + Firebase Installations. `FIREBASE_WEB_API_KEY` in `.env` now controls the value in generated apps | Web API keys are public by design but *unrestricted* keys get abused (billing DoS) |
| 8 | **Users' exposed passwords**: the committed DB had 13 users' emails + plaintext passwords. Treat them as breached — if these accounts matter, force a password reset / notify users | Personal data left the repo boundary |
| 9 | If this repo was ever pushed to a remote (GitHub/GitLab), assume the secrets are crawled and rotate **first**, purge **second** | Bots scrape for Firebase keys within minutes |

---

## Check 1 — Secret Leak Prevention (Gitleaks-style)

**Scan:** every tracked file + git history grepped for keys, tokens, passwords, connection strings.

| Finding | Severity | Status |
|---|---|---|
| 1.1 `firebase-service-account.json` — real private key committed at repo root | **CRITICAL** | Untracked from git + `.gitignore`d. **Rotation required (action #1)** |
| 1.2 Telegram bot token in committed DB (`settings` table) | **CRITICAL** | DB untracked. **Revocation required (action #2)** |
| 1.3 `keystore/release.keystore` + hardcoded password `zayro@123` in `utils/apkbuilder.js` (5 call sites) | **CRITICAL** | Keystore untracked; password now read from `KEYSTORE_PASSWORD`/`KEYSTORE_ALIAS` env with legacy fallback + startup warning. **Rotation required (action #3)** |
| 1.4 Users table: `plain_password` column + it was used as a login fallback | **CRITICAL** | Fixed — see Check 2, finding 2.1 |
| 1.5 Content-encryption password `zayroavi@132` hardcoded in `utils/encrypt.js` (and baked into shipped APKs' Java decoder) | HIGH | Now from `CONTENT_ENCRYPTION_PASSWORD` env, legacy fallback kept (rotating breaks existing APKs — documented) |
| 1.6 Firebase Web API key hardcoded in `utils/htmlprocessor.js` | MEDIUM | Now from `FIREBASE_WEB_API_KEY` env with legacy fallback; restriction guide in action #7 |
| 1.7 Session secret fallback `'zayro_secret'`, file-token secret `'zayro-file-token-2026'` hardcoded | MEDIUM | Env vars preferred (`SESSION_SECRET`, `FILE_TOKEN_SECRET`); startup warning added when unset. If production ever ran without these set, **all sessions/tokens were forgeable → rotate `SESSION_SECRET` now** (this also logs out all users, which is what you want after a breach) |
| 1.8 Default admin credentials `admin` / `admin123` in code | **CRITICAL** | Fixed — no default; env-admin login disabled if `ADMIN_PASSWORD` unset |
| 1.9 `node_modules/` (7,694 files), `builds/` (APKs), `uploads/` (user screenshots), `backups/` (DB WALs — full DB contents!), `database/*.db` all committed | HIGH | All untracked, `.gitignore` hardened |
| 1.10 `.env` ignored ✓, `.env.example` has placeholders ✓ | PASS | — |

---

## Check 2 — Personal Data Flow Audit (Bearer-style)

**Data collected:** username, email, password, Telegram identity (id, name, username, photo), payment proof (UPI screenshots + UTR reference), IP addresses, order/app-asset data, and for each *generated panel*: end-user phone numbers written to Firebase RTDB.

| Finding | Severity | Status |
|---|---|---|
| 2.1 **Plaintext passwords stored** for every user (`users.plain_password`), and the login route accepted them as a fallback credential. All 13 real users affected; DB + WAL backups committed to git | **CRITICAL** | **Fixed:** register/TG-signup no longer write it; login fallback removed; one-time startup migration wipes the column (`[security] wiped 13 plaintext password(s)` verified in boot test); column kept only for schema compatibility. TG placeholder passwords are now bcrypt-hashed |
| 2.2 Committed DB + WAL/SHM backup files contained the above PII | HIGH | Untracked from git; `backups/` fully ignored. **History purge required (action #5)** |
| 2.3 Registration forwarded email + IP to the Telegram log channel | LOW | Email now masked (`***@domain`) — username + domain still visible for ops. IP retained (operator's own audit channel) |
| 2.4 Passwords hashed with bcrypt (cost 10) ✓; hashes not returned by any API ✓ | PASS | — |
| 2.5 Session cookie had no `httpOnly`/`sameSite`/`secure` flags | MEDIUM | **Fixed:** `httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE (default true)` |
| 2.6 Login responses distinguished "User not found" vs "Wrong password" → account enumeration | LOW | **Fixed:** single generic `Invalid username or password` |
| 2.7 RTDB `users/<phone>` nodes store end-user phone numbers with public read (product requirement) | MEDIUM (inherent) | Listing/scraping now blocked by rules (Check 5). Long-term fix (documented): per-device token or server-mediated registration so raw phone paths aren't publicly writable |

---

## Check 3 — Pre-Deploy Production Audit

| Check | Status |
|---|---|
| 3.1 Env vars: critical secrets now **fail closed** (admin login disabled without `ADMIN_PASSWORD`; Firebase features degrade gracefully without SA — same as before) | FIXED/OK |
| 3.2 Debug code: no `/test`/`/debug`/seed endpoints found; `console.log` handles contain no secrets (verified by scan); test credentials — none besides the removed admin default | OK |
| 3.3 Error handling: backups endpoint leaked `error.message` → now generic + server-side log; global error handler added — **no stack traces / paths / query details ever reach the client**; unknown `/api/*` routes return JSON 404 instead of the HTML SPA | FIXED |
| 3.4 Security headers: previously only `nosniff` + `Referrer-Policy`. Now also `X-Frame-Options: SAMEORIGIN`, **HSTS** (1 year, includeSubDomains), **CSP** (self + fonts + telegram-web-app + firebase endpoints; `object-src 'none'`, `frame-ancestors 'self'`), `Permissions-Policy`. `X-Powered-By` disabled | FIXED |
| 3.5 Rate limiting: register ✓ (5/15min + IP blocklist, pre-existing); **login ✗ → added 5 failures/min/IP, successes don't count**. Found & fixed a bug where failed logins returned HTTP 200, which would have made the limiter count nothing. Upload endpoints throttled implicitly by size caps (5/50/200MB). Note: `x-forwarded-for` was blindly trusted for the IP blocklist → **fixed** with `trust proxy 1` + `req.ip` (also fixes the register limiter keying every visitor on the proxy IP) | FIXED |
| 3.6 CORS: none configured (same-origin only) ✓ — correct for this app | PASS |
| 3.7 DB: SQLite local file, better-sqlite3 with **prepared statements everywhere** (verified — no string-built SQL found) | PASS |
| 3.8 File serving: `/api/files/:name` basename-sanitized ✓; public exposure limited to design preview media + token/ session holders ✓ (pre-existing fix, verified) | PASS |

---

## Check 4 — Deep Security Audit (auth / payments / input)

| Finding | Severity | Status |
|---|---|---|
| 4.1 **Privilege escalation via registration:** usernames weren't validated — registering as `admin` granted `isAdmin` at login (DB-user path). | **CRITICAL** | **Fixed:** reserved-name blocklist (`admin`, `root`, `moderator`, `support`, …) + username charset/length validation |
| 4.2 Order routes (`/api/orders/:id/*`) all scope by `user_id` ✓; admin routes behind `requireAdmin` ✓; `/api/admin/backups/:file` download basename-sanitized + regex ✓ | PASS (verified) |
| 4.3 Restore/selftest endpoints: header secret compared with `===` (timing-unsafe) | LOW | **Fixed:** `crypto.timingSafeEqual`; disabled entirely if `RESTORE_SECRET` unset |
| 4.4 Uploads accepted **any file type** (only size-limited) — an `.svg`/`.html` uploaded as an icon is served same-origin → stored XSS; malicious files could land in APK builds | HIGH | **Fixed:** extension whitelists per uploader (icons: png/jpg/webp/gif/pdf; admin: images/video/audio/fonts/html/apk/zip; project: zip only). SVG blocked everywhere |
| 4.5 Payments: coin top-ups are manual UPI-transfer + admin approval (no client-trusted amounts) ✓; coupon system has `max_uses`/`used_count`, decrements on build failure ✓; prices come from server-side DB (`designs.price_coins`), not client ✓ | PASS |
| 4.6 Sessions: server-side session store, 7-day expiry; logout destroys session ✓. No JWTs in play. Note: MemoryStore — for multi-process/cluster deployments add a shared store (single-process VPS is fine) | OK/NOTE |
| 4.7 Auth code paths reuse bcrypt compare with `.catch(()=>false)` ✓; Google OAuth + Telegram initData verify against bot token (signature check present) — **Telegram auth falls back to unverified mode if `botToken` is missing** (telegram.js `verifyTelegramWebAppData`): with the token now also in settings DB, keep it configured | NOTE |

---

## Check 5 — Attacker's Perspective Review

Attack paths tested against the code:

1. **ID manipulation** — changed `:id` on orders/downloads/status/demo-users: all `WHERE id=? AND user_id=?` (admin sessions exempt by design). ❌ blocked
2. **Login bypass** — every `/api/admin/*` behind `requireAdmin`; `/api/files` 401s without session/token (public = design previews only). ❌ blocked. ⚠️ *was* trivially owned via `admin/admin123` default + register-as-admin — both closed.
3. **Privilege escalation** — register-as-admin closed (4.1); admin determined server-side; no client-trusted role flags in session writes. ❌ blocked
4. **Abuse/rate limits** — signup spam: limiter + IP blocklist ✓; login brute force: now limited ✓; uploads: size caps + type filter ✓; **order/rebuild endpoints have no rate limit** — a user could queue many builds (CPU-heavy gradle builds = DoS-ish) → recommend a per-user concurrent-build check if abused (not enforced — business call).
5. **Content injection** — all SQL parameterized ✓; XSS: user-controlled fields are injected into generated APK HTML/`strings.xml` with escaping (`xmlEsc`, template escaping) — spot-checked ✓. Server-rendered frontend renders via text content, `escapeHtml` used in telegram.js ✓.
6. **Internal exposure** — ❌ **CRITICAL FOUND & FIXED in rules files**: `firebase.rules.json` had root `".read": true, ".write": true` → anyone could **read AND overwrite your entire Firebase RTDB** (every panel's config + users). Deployed `database.rules.json` allowed public list-read/write of `users` and public write of `$other`. **Fixed rules** (need deploy, action #6): root deny-all; `$panel/config` read-only public (apps need it); `$panel/users/$phone` read/write per-phone only (client feature preserved); everything else denied. Server admin writes unaffected (Admin SDK bypasses rules). `.git` over HTTP, `/env`, Swagger: none found. Health/startup banners leak nothing sensitive.
7. **Business logic** — coupon abuse: capped ✓; negative coin totals: `Math.max(0, …)` clamps ✓; domain-change counts enforced server-side ✓. **Referral/self-pay loop**: coin top-ups need manual admin approval of a UTR — keep verifying UTRs against your UPI statement, that's your anti-fraud control.

---

## What changed in this repo (files)

- `server.js` — trust proxy, security headers, CSP, session cookie hardening, login rate limit + real 401/400s, no default admin creds, registration validation + reserved names, plaintext password purge (insert path), timing-safe restore secret, upload whitelists, global error handler, API 404, generic errors
- `database/db.js` — startup migration wiping `users.plain_password`
- `utils/telegram.js` — TG users get bcrypt placeholder, no plaintext column
- `utils/apkbuilder.js` — keystore password/alias from env
- `utils/encrypt.js` — content encryption password from env
- `utils/htmlprocessor.js` — web API key from env
- `.gitignore` — secrets, DBs, backups, uploads, builds, node_modules, gradle cache
- `.env.example` — all new vars documented, no real defaults
- `firebase.rules.json`, `database.rules.json` — deny-by-default rules
- git index — removed `firebase-service-account.json`, `keystore/`, `database/*.db`, `backups/`, `uploads/`, `builds/`, `node_modules/`, `android-project/.gradle/` (files kept on disk)

## Residual risks / recommendations

1. **Rotate + purge** (top section) — code fixes don't un-leak history.
2. Panel `users/$phone` public read/write is a product dependency of the generated apps; migrate to server-mediated or token-authed writes when feasible.
3. Consider `helmet` if you want the header set maintained externally; current in-code headers match its defaults minus `HidingPoweredBy` (done) — no dependency added.
4. Add per-user build concurrency limits if builds get abused as a compute-DoS.
5. Re-run this audit (the guide's advice) after every major feature — new code = new attack surface.

---

## Addendum details — Design Theft Fix (02 Sep 2026)

### Leak chain (how designs were stolen)

```
thief → GET /api/designs/:id        (PUBLIC, SELECT *)
      ← { ..., popup_html_file: "1786…_red.html", ... }   ← source filename leak
thief → GET /api/app-content/<firebase_path>                (keyless, public)
      ← design .bin encrypted with the COMMITTED fixed key  ← decrypt & steal
```

### Fixes applied

| Layer | Before | After |
|---|---|---|
| `/api/designs/:id` | public `SELECT *` — leaked `popup_html_file`, `fake_popup_html_file` | whitelisted catalog fields only; source filenames admin-session only |
| `/api/app-content/:path` `(+ /loading)` | no auth, no rate limit | requires `?k=<content_token>` (timing-compared inside lookup); wrong/missing → **404** (path existence hidden); 120 req/min/IP |
| Content encryption | single FIXED key `zayroavi@132` (committed to git, in every APK) | **per-order random 32-hex `content_secret`** — server encrypts with it, build injects it XOR-masked (`FW_PASSWORD_M`) into that APK only |
| APK fetch | `…?t=<ts>` | `…?t=<ts>&k=<content_token>` (new `APP_TOKEN_M` masked constant) |
| Admin panel links | plain popup_url | now include `?k=` so admin testing still works |
| DB | — | `orders.content_secret`, `orders.content_token` (migration, safe on existing DB) |

### Compatibility (important)

- **Old shipped APKs keep working** — their orders have empty `content_token`,
  so the endpoint serves them in legacy mode (fixed key, no `k` required).
  Verified live: legacy path → 200, new-style path without `k` → 404,
  with `k` → 200 and the `.bin` decrypts **only** with that order's secret.
- **Designs already stolen stay stolen** — protection applies to orders
  created from now on. Re-upload a stolen design under a new name and use
  new orders; the old template file can be deleted from `templates/`.
- Residual reality: a determined attacker who pulls the mask/strings out of
  ONE APK can still decrypt THAT app's content (any client-side DRM limit).
  But drive-by "URL se download" theft is dead: the URL is useless without
  the per-order token, and the `.bin` is useless without that APK's key.

### Round 2 — Frontend Zero-Exposure (02 Sep 2026, night)

Operator demand: "frontend pe koi cheez na rahe, sab backend me ho." Applied:

| Surface | Before | After |
|---|---|---|
| `/api/designs` (guest) | full media list (gallery array + video tokens) | sirf storefront card: naam, price, **ek cover image** — gallery/video/tokens nahi |
| `/api/designs/:id` | public | **login zaroori** (401 for guests) — gallery + media tokens sirf logged-in users |
| `/api/app-content` legacy orders | koi bhi browser URL khol sakta tha | sirf APK ka apna `User-Agent: ZayroApp/*` chalega — **browser me URL paste karna = 404** (purane APKs me UA already hota hai, wo unaffected) |

Verified live: guest list minimal ✓ · guest detail 401 ✓ · logged-in full gallery ✓ ·
legacy content: browser-UA 404 / APK-UA 200 ✓

Note: storefront preview (cover images) khulna hi zaroori hai — bechne ke liye.
Jo cheez dikh rahi hai use koi screenshot kar sakta hai; iska solution watermark
hai (chaho to next step me daal dunga). Design ka HTML/source ab kisi bhi
frontend response me nahi jata — sirf backend → encrypted .bin → APK.
