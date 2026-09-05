# VERIFICATION REPORT — Native .so Popup Protection

Date: 2026-09-05 • Branch: `arena/01a06f5e-zayromod` • Suite: `node tests/native-payload/run-tests.js`

## Result: 29 passed, 0 failed ✅

```
A. Static regression checks (11)
  [PASS] node --check (native-payload.js, apkbuilder.js)
  [PASS] MainActivity anchors (patch targets + native calls + base URL)
  [PASS] MainActivity remote-flow code intact
  [PASS] MainActivity loading.bin flow intact
  [PASS] JNI names match (Java declarations ↔ C++ definitions)
  [PASS] JNIEXPORT on native fns (hidden-visibility safe)
  [PASS] ProGuard keep rule for NativePayload
  [PASS] stale popup bins removed from template assets
  [PASS] template webview assets intact (loading/mp3/png)
  [PASS] placeholder header empty (template builds → remote fallback)
  [PASS] CMakeLists lists all native sources

B. Host crypto selftest — SAME .cpp sources jo .so me jaate hain (2)
  [PASS] harness compiles against real crypto sources
  [PASS] vectors: SHA-256("abc")=FIPS180-4 ✓, AES-256=FIPS-197 C.3 ✓,
         AES-256-CTR round-trip ✓, HMAC-SHA256=RFC4231#1 ✓,
         PBKDF2-100k == Node crypto.pbkdf2Sync ✓, ct-compare ✓

C. Round-trip, real template HTML (3)
  [PASS] fixture: templates/crimson-protocol-v2.html (23872 chars)
  [PASS] container built (24074 bytes, ct 23994, iters 100000)
  [PASS] C++ decrypt == original HTML byte-for-byte

D. Tamper / wrong-key rejection (7)
  [PASS] flip ciphertext byte → reject   [PASS] flip tag byte → reject
  [PASS] flip magic byte → reject        [PASS] flip salt byte → reject
  [PASS] wrong dex password → reject     [PASS] wrong pepper → reject
  [PASS] truncated container → reject

E. Generated-header end-to-end (4)
  [PASS] header generated, no HTML plaintext inside
  [PASS] header compiles as C++ (same #include style as .so)
  [PASS] full chain: header pepper → pwFull → decrypt → byte-match
  [PASS] header wrong-password → reject

F. APK verifier on existing built APK, read-only (1)
  [PASS] fixture ADITI_NUMBER_PANNEL.apk: checked=true, plainHtml=false,
         popupBins=[], loadingBins=[assets/loading.bin], so=false (old APK),
         assetsIntact=true

G. apkbuilder patch simulation (1)
  [PASS] all build-time placeholders consumed (server/path/password/order)
```

## Requirement checklist (user ke 8 points, §2)

1. Build time encrypted payload — ✅ `buildNativePayload()` (AES-256-CTR + HMAC-SHA256 EtM, PBKDF2 100k)
2. Payload native `.so` me embed — ✅ generated `popup_payload.h` → `libnativesecurity.so`
3. HTML normal assets se remove — ✅ popup kabhi assets me nahi tha (remote tha); stale `wingss.bin` template se delete; verifier `popupBins==[]` assert karta hai
4. Runtime native decrypt — ✅ `nativeGetPopupHtml` (MAC-verify-then-decrypt)
5. WebView same functionality — ✅ same `loadDataWithBaseURL("file:///android_asset/", …)` call
6. Disk par plaintext nahi — ✅ memory-only + wipe; koi file write nahi
7. Asset paths intact — ✅ base URL same, png/mp3 plain same, `webviewAssetsIntact` check
8. Bridges/callbacks same — ✅ `ZAYRO`/`ZAYROUI`, TTS, MediaPlayer, WebChromeClient — untouched

## Behavior preservation (§3) — code-level evidence

- Intro/loading/popup open-close, UI/animations, API calls, result display, audio/TTS,
  buttons/links/navigation, Firebase flow, SecurityManager, build config — **koi line
  change nahi** (sirf 2 additive try/catch + 1 boolean flag `MainActivity.java` me).
- Remote content flow (`/api/app-content/*`, `encrypt.js` CBC format, retry + error
  screen) — **untouched**, fallback ke roop me maujood.
- `git diff --stat` me Java diff sirf `MainActivity.java` (+~45 additive lines),
  `NativePayload.java` (new), `proguard-rules.pro` (+3), baaki sab naye files.

## Leak audit (static, 2026-09-05) — koi plaintext secret APK me nahi

| Check | Result |
|---|---|
| Template Java/C++/XML me hardcoded secret/URL | ✅ PASS — sirf `{0,0}` placeholders, koi URL nahi |
| Generated `.so` header me HTML plaintext | ✅ PASS — ciphertext + masked pepper only (suite test E) |
| Build logs (`build_log`, panel-visible) me password/pepper | ✅ PASS — sirf sizes/paths log hote hain |
| Java `Log.*` (5 lines, generic tags) | ✅ PASS — koi secret nahi; R8 release me sab strip |
| Native logging | ✅ PASS — zero log calls |
| WebView remote-debugging | ✅ PASS — absent |
| `allowBackup=false`, release `debuggable=false` | ✅ PASS |
| `integrity.json` / `security-report.txt` | ✅ PASS — hashes only |
| JS bridge path traversal (`playSound`) | ✅ PASS — `basename()` sanitized |
| Per-build kid flow trigger | ✅ PASS — placeholder intact, naye builds unique password |

**Pre-existing findings (mere change se nahi, par note karo):**
1. **Firebase Web key + RTDB URL popup HTML me** (shared project) — decrypt par milegi. Firebase web keys public-by-design hain; asli raksha = rules. Recommendation: Firebase console me key par Android-app restriction lagao.
2. **`database.rules.json`: `users` read+write open, `$other.write` open** — app ka bina-auth flow is par chalta hai, isliye change nahi kiya (behavior tootega). `config`/`push` writes auth-locked hain ✅. Recommendation: `$other.write` review karo jab time mile.
3. **`FIXED_PASSWORD` repo me hai** (`utils/encrypt.js`, fallback key) — naye builds ise use nahi karte (per-build kid), par repo **private rakho**. Purane APKs dheere-dheere rebuild karwao.
4. **`usesCleartextTraffic` + WebView mixed-content/SSL-proceed** — game iframes ke liye functional requirement; accepted risk (unchanged).
5. **Key recoverable (by design)** — DEX password + `.so` pepper dono APK me; extraction mehnga hai, impossible nahi. Doc me declared hai.

## Kya is sandbox me NAHI ho saka (Android SDK absent)

- Real `./gradlew assembleProtectedRelease` + device/emulator run. Iski jagah:
  (a) wahi C++ sources host par compile + NIST/RFC vectors + live round-trip,
  (b) JNI-name/proguard/anchor static checks, (c) real-APK verifier fixture run,
  (d) patch simulation. Pehla pipeline build karne par `security-report.txt` ka
  `native` section (plainHtml=false, popupBins=[], so=true, magic=true) dekho —
  wahi on-device go/no-go signal hai. Koi doubt ho to `APK_POPUP_SOURCE=remote`
  par rollback ek env var hai.
