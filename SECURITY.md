# APK PROTECTION — SECURITY DOCS

## Protection layers (sabse strong upar)

| # | Layer | Kahan | Default |
|---|-------|-------|---------|
| 1 | **Encrypted HTML bins (assets)** — popup (zayro.bin) + loading (loading.bin) AES-256-CBC + PBKDF2 per-build key se encrypted, APK ke assets me | apkbuilder + MainActivity | ✅ ON |
| 2 | **Remote HTML (fallback)** — asset missing/corrupt ho to server se encrypted fetch (utils/appcontent.js) | MainActivity + appcontent.js | ✅ ON |
| 3 | **R8 aggressive obfuscation** — repackageclasses 'o', overload, log removal | proguard-rules.pro | ✅ ON |
| 4 | **XOR-masked strings** — server URL / path / password / cert hash DEX me plaintext nahi | apkbuilder build-time patch | ✅ ON |
| 5 | **Signature verification** — galat certificate pe app BLOCK (tamper screen) | SecurityManager | ✅ protectedRelease |
| 6 | **Asset integrity manifest** — har asset ka SHA-256, modify detect | apkbuilder + SecurityManager | ✅ ON |
| 7 | **Anti-debug (Java)** — Debug.isDebuggerConnected / waitingForDebugger | SecurityManager | ✅ protectedRelease |
| 8 | **Environment risk score** — root/frida/xposed/test-keys (0-100) | SecurityManager | ✅ protectedRelease |
| 9 | **Firebase rules lock** — hacker config change nahi kar sakta | database.rules.json | ✅ ON |

> NOTE: 360 Jiagu / Frezrik DEX packers aur native security module
> (libnativesecurity.so) completely removed hain — app ab pure Java hai.

## Authentication security

The web authentication system is separate from APK protection and is hardened
as follows:

- Passwords are bcrypt hashes only. New passwords use a configurable work
factor with a minimum of 10 and default of 12. Startup migration hashes
recoverable legacy plaintext values and wipes the compatibility
`plain_password` column; login never reads that column. Production startup also
requires a valid bcrypt `ADMIN_PASSWORD_HASH`.
- Password registration still collects an email as an account identifier, but
email verification is disabled. New password accounts are immediately usable;
there is no verification email, forgot-password email, reset-token, or resend
flow.
- Sessions use the SQLite store in `utils/session-store.js`, with absolute and
idle expiry. In production cookies are Secure, HttpOnly, SameSite=Lax and use
the `__Host-` prefix. Authentication regenerates the session ID and logout
destroys the server-side record.
- Login attempts are independently limited by IP and normalized account
identifier. Missing accounts still receive a dummy bcrypt comparison and
failure messages do not reveal account state.
- Google OAuth requires a session-bound state and Google `email_verified`.
Telegram WebApp authentication requires configured, fresh, signed Telegram
data; unsigned fallback parsing is disabled.
- Session secrets, provider client secrets, Telegram tokens, service-account
keys, and other operational credentials are server-only. Admin settings uses a
whitelist, treats the Telegram bot token as write-only, and returns only a
configured/not-configured flag.

Deployment variables and operational steps are in `SETUP.md` and `.env.example`.
Rotate credentials that were ever committed before deploying.

### Existing APK compatibility

This authentication change is additive for existing orders. It does not alter
order rows, design rows, Firebase paths, APK files, or the runtime content
contract. Older Java APKs continue to fetch encrypted content from the public
`/api/app-content/<firebase_path>` and `/api/app-content/<firebase_path>/loading`
endpoints using their existing fixed-password fallback. Do not require a web
session on those legacy runtime routes.

## Security states

- `SECURITY_OK` → normal
- `SECURITY_WARNING` (risk 21-50) → root/frida signals — app chalti hai (false positive avoid)
- `SECURITY_FAILED` (risk 51+ ya signature mismatch) → remote content BLOCK + "Security Verification Failed" screen

**Sirf signature mismatch hard-fail hai.** Root users block nahi hote (business).

## Build variants

```
./gradlew assembleDebug             → developer (koi protection nahi)
./gradlew assembleRelease           → R8 + shrink (standard)
./gradlew assembleProtectedRelease  → MAXIMUM (default pipeline yahi use karta hai)
```

Pipeline env:
- `APK_BUILD_VARIANT=protectedRelease` (default) / `release` / `debug`
- Koi native/NDK flag nahi — app pure Java hai

## Build ke baad automatic verification

Har build me `security-report.txt` banta hai (builds/ folder me):
- APK SHA-256 + Certificate SHA-256
- signed / debuggable / sensitive-plaintext / source-maps checks
- protectedRelease me koi critical fail → BUILD FAILED

## Assets policy (assets-config.json)

- **PLAIN (PUBLIC)**: .mp3 .png .ttf .otf etc. — WebView/MediaPlayer seedha load karte hain, encrypt karte hi sounds/images toot jate
- **PROTECTED**: HTML .bin files (zayro.bin / loading.bin — encrypted, per-build PBKDF2 key, XOR-masked Java me)
- **SENSITIVE**: Firebase details kabhi APK me plaintext nahi — HTML injectParams ke baad encrypt hota hai

## Limits (sach)

- Koi bhi protection "unkillable" nahi hai — ye reverse-engineering ka COST badhata hai
- MP3/PNG plain hi rehte hain (functional requirement)
- Sabse valuable cheez (design + links + logic) server-side hai — APK untrusted client hai

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Build fail "SECURITY VERIFICATION FAILED" | security-report.txt dekho — signed/plaintext check |
| App "Security Verification Failed" aaye | APK modified/resigned hai — original APK install karo |
| protectedRelease build fail hota hai | `APK_BUILD_VARIANT=release` fallback |
| Popup blank / decrypt fail | zayro.bin build me copy hui? builds/<id>/project assets check karo |
| Login cookie missing behind Nginx | Set `TRUST_PROXY_HOPS=1`, forward `X-Forwarded-Proto`, and serve HTTPS |
| Password login/registration unavailable | Check `SESSION_SECRET`, `ADMIN_PASSWORD_HASH`, Node dependencies, and PM2 logs |
