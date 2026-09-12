# APK PROTECTION — SECURITY DOCS

## Protection layers (sabse strong upar)

| # | Layer | Kahan | Default |
|---|-------|-------|---------|
| 1 | **Encrypted HTML in assets** — popup + loading HTML `.bin` me AES-256-CBC (per-build key), APK me plaintext HTML nahi | assets/zayro.bin + MainActivity | ✅ ON |
| 2 | **R8 aggressive obfuscation** — repackageclasses 'o', overload, log removal | proguard-rules.pro | ✅ ON |
| 3 | **XOR-masked strings** — decrypt password / cert hash DEX me plaintext nahi (0x5A mask) | apkbuilder build-time patch | ✅ ON |
| 4 | **Signature verification** — galat certificate pe app BLOCK (tamper screen) | SecurityManager | ✅ protectedRelease |
| 5 | **Asset integrity manifest** — har asset ka SHA-256, modify detect | apkbuilder + SecurityManager | ✅ ON |
| 6 | **Anti-debug** — Debug.isDebuggerConnected + waitingForDebugger | SecurityManager | ✅ protectedRelease |
| 7 | **Environment risk score** — root/xposed/test-keys (0-100) | SecurityManager | ✅ protectedRelease |
| 8 | **Firebase rules lock** — hacker config change nahi kar sakta | database.rules.json | ✅ ON |

Hata diye gaye layers (user request): 360 Jiagu + Frezrik DEX packers aur
`libnativesecurity.so` content vault (popup HTML ko `lib/<abi>/*.so` me chhupane
wala system). Ab APK me koi extra native `.so` nahi aur build pipeline me koi
packer step nahi.

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
- `SECURITY_FAILED` (risk 51+ ya signature mismatch) → content BLOCK + "Security Verification Failed" screen

**Sirf signature mismatch hard-fail hai.** Root users block nahi hote (business).

## Build variants

```
./gradlew assembleDebug             → developer (koi minify nahi)
./gradlew assembleRelease           → R8 + shrink (standard)
./gradlew assembleProtectedRelease  → R8 aggressive + extra rules (default pipeline)
```

Pipeline env:
- `APK_BUILD_VARIANT=protectedRelease` (default) / `release` / `debug`
- Koi NDK/native module nahi — build me `externalNativeBuild` configured nahi hai.

## Build ke baad automatic verification

Har build me `security-report.txt` banta hai (builds/ folder me):
- APK SHA-256 + Certificate SHA-256
- signed / debuggable / sensitive-plaintext / source-maps checks
- protectedRelease me koi critical fail → BUILD FAILED

## Assets policy (assets-config.json)

- **PLAIN (PUBLIC)**: .mp3 .png .ttf .otf etc. — WebView/MediaPlayer seedha load karte hain, encrypt karte hi sounds/images toot jate
- **ENCRYPTED**: popup = `assets/zayro.bin`, splash = `assets/loading.bin` (dhani ke liye `lodale.bin` alias bhi) — AES-256-CBC + PBKDF2, per-build key DEX me XOR-masked
- **NAHI**: koi .html/.js plaintext asset nahi, koi `lib/<abi>/libnativesecurity.so` vault nahi

## Limits (sach)

- Koi bhi protection "unkillable" nahi hai — ye reverse-engineering ka COST badhata hai
- Packer (360/Frezrik) hatane se DEX plain hai: decompiler Java logic padh sakta hai,
  par popup HTML phir bhi encrypted .bin hi rahega (per-build key ke bina decode nahi)
- MP3/PNG plain hi rehte hain (functional requirement)
- Popup APK ke andar hai: HTML badalne ke liye APK dobara build karna padega
  (remote-fetch system se wo live update ho jata tha)

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Build fail "SECURITY VERIFICATION FAILED" | security-report.txt dekho — signed/plaintext check |
| App "Security Verification Failed" aaye | APK modified/resigned hai — original APK install karo |
| protectedRelease build fail hota hai | `APK_BUILD_VARIANT=release` fallback |
| Login cookie missing behind Nginx | Set `TRUST_PROXY_HOPS=1`, forward `X-Forwarded-Proto`, and serve HTTPS |
| Password login/registration unavailable | Check `SESSION_SECRET`, `ADMIN_PASSWORD_HASH`, Node dependencies, and PM2 logs |
