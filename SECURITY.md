# APK PROTECTION — SECURITY DOCS

## Protection layers (sabse strong upar)

| # | Layer | Kahan | Default |
|---|-------|-------|---------|
| 1 | **Remote HTML** — popup design + Firebase details APK me hota hi nahi (server se encrypted fetch) | MainActivity + appcontent.js | ✅ ON |
| 2 | **Frezrik DEX packing** — pura DEX AES-encrypted, decompile pe sirf shell | apkbuilder + /opt/frezrik | ✅ ON |
| 3 | **R8 aggressive obfuscation** — repackageclasses 'o', overload, log removal | proguard-rules.pro | ✅ ON |
| 4 | **XOR-masked strings** — server URL / path / password / cert hash DEX me plaintext nahi | apkbuilder build-time patch | ✅ ON |
| 5 | **Signature verification** — galat certificate pe app BLOCK (tamper screen) | SecurityManager | ✅ protectedRelease |
| 6 | **Asset integrity manifest** — har asset ka SHA-256, modify detect | apkbuilder + SecurityManager | ✅ ON |
| 7 | **Anti-debug** — TracerPid + Debug.isDebuggerConnected (+ native agar enable) | SecurityManager | ✅ protectedRelease |
| 8 | **Environment risk score** — root/frida/xposed/test-keys (0-100) | SecurityManager | ✅ protectedRelease |
| 9 | **Native security module** — C++ checks (optional) | cpp/ | ⏸ -PenableNativeSecurity |
| 10 | **Firebase rules lock** — hacker config change nahi kar sakta | database.rules.json | ✅ ON |

## Authentication security

The web authentication system is separate from APK protection and is hardened
as follows:

- Passwords are bcrypt hashes only. New and reset passwords use a configurable
work factor with a minimum of 10 and default of 12. Startup migration hashes
recoverable legacy plaintext values and wipes the compatibility
`plain_password` column; login never reads that column. Production startup also
requires a valid bcrypt `ADMIN_PASSWORD_HASH`.
- Password registrations remain locked until email verification. Verification
and reset values are 32-byte random, SHA-256 hashed at rest, expiring, and
single-use. The raw value is not returned by an API response; email action URLs
are consumed by server routes and immediately redirected to a clean URL.
- Forgot-password and resend-verification responses are generic. Resetting a
password increments a per-user session version and invalidates older sessions.
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
- Session secrets, provider client secrets, Telegram tokens, email credentials,
service-account keys, and reset/verification values are server-only. Admin
settings uses a whitelist, treats the Telegram bot token as write-only, and
returns only a configured/not-configured flag.

Deployment variables and operational steps are in `SETUP.md` and `.env.example`.
Rotate credentials that were ever committed before deploying.

### Existing APK compatibility

This authentication change is additive for existing orders. It does not alter
order rows, design rows, Firebase paths, APK files, or the runtime content
contract. Older Java APKs continue to fetch encrypted content from the public
`/api/app-content/<firebase_path>` and `/loading` endpoints using their existing
fixed-password fallback. Do not require a web session on those legacy runtime
routes.

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
./gradlew assembleProtectedRelease -PenableNativeSecurity   → + native module
```

Pipeline env:
- `APK_BUILD_VARIANT=protectedRelease` (default) / `release` / `debug`
- `APK_NATIVE_SECURITY=1` → native module compile (NDK chahiye)

## Build ke baad automatic verification

Har build me `security-report.txt` banta hai (builds/ folder me):
- APK SHA-256 + Certificate SHA-256
- signed / debuggable / sensitive-plaintext / source-maps checks
- protectedRelease me koi critical fail → BUILD FAILED

## Assets policy (assets-config.json)

- **PLAIN (PUBLIC)**: .mp3 .png .ttf .otf etc. — WebView/MediaPlayer seedha load karte hain, encrypt karte hi sounds/images toot jate
- **PROTECTED**: HTML .bin files (encrypted, fixed PBKDF2 key, XOR-masked Java me)
- **SENSITIVE**: APK me rakho hi mat — remote content use karo (popup already remote)

## Limits (sach)

- Koi bhi protection "unkillable" nahi hai — ye reverse-engineering ka COST badhata hai
- Frezrik Android 5.0+ tested; koi device crash kare to `FREZRIK_ENABLED=false`
- MP3/PNG plain hi rehte hain (functional requirement)
- Sabse valuable cheez (design + links + logic) server-side hai — APK untrusted client hai

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Build fail "SECURITY VERIFICATION FAILED" | security-report.txt dekho — signed/plaintext check |
| App "Security Verification Failed" aaye | APK modified/resigned hai — original APK install karo |
| protectedRelease build fail hota hai | `APK_BUILD_VARIANT=release` fallback |
| Native enable ke baad build fail | NDK install karo (sdkmanager 'ndk;25.x') |
| Frezrik crash | `.env` me `FREZRIK_ENABLED=false` + rebuild |
| Login cookie missing behind Nginx | Set `TRUST_PROXY_HOPS=1`, forward `X-Forwarded-Proto`, and serve HTTPS |
| Password registration unavailable | Configure `BASE_URL`, `RESEND_API_KEY`, and `EMAIL_FROM` |
