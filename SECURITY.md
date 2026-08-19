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
| 9 | **Native security module** — C++ checks (debugger/frida) | cpp/ (optional) | ⏸ -PenableNativeSecurity |
| 10 | **Firebase rules lock** — hacker config change nahi kar sakta | database.rules.json | ✅ ON |

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
