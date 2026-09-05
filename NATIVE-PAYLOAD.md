# NATIVE .so POPUP PROTECTION (ZPAY01)

Popup HTML ka build-time snapshot **authenticated-encrypted container** me pack
hota hai aur **`libnativesecurity.so` ke andar embed** hota hai. Runtime par
native C++ code verify + decrypt karke WebView ko deta hai — **bina disk par
likhe**, same base URL / bridges / assets ke saath. Old APK ka behavior
reference hai: koi feature remove/rename/redesign nahi hua.

> **Honest claim (padhna zaroori):** ye protection reverse-engineering ka COST
> bahut badhata hai, lekin **"100% impossible to extract" ka daava NAHI** karta.
> Runtime key APK me hi recoverable hai (details neeche: Limitations). Koi bhi
> client-side protection determined attacker ko hamesha ke liye nahi rok sakta.

---

## 1. Architecture (end-to-end)

```
BUILD TIME (server, utils/native-payload.js + apkbuilder.js)
  processedPopup.html (params injected, audio gate — pehle jaisa)
        │  per-build password (existing kid flow) + random pepper (16 B)
        ▼
  ZPAY01 container = PBKDF2-SHA256(100k) → AES-256-CTR + HMAC-SHA256 (EtM)
        │  popup_payload.h (generated — SIRF builds/<id>/project/... me)
        ▼
  libnativesecurity.so ── .so me ciphertext + obfuscated pepper
  APK assets me: loading.bin / mp3 / png (pehle jaisa) — popup HTML/.bin KABHI NAHI

RUNTIME (device)
  launch → intro.mp3 (Java, pehle jaisa) → loading WebView (loading.bin, pehle jaisa)
        → popup:  ① NativePayload.getPopupHtml()  [native decrypt, memory-only]
                   ② null/fail → existing remote fetch (/api/app-content/...) — UNCHANGED
                   ③ dono fail → existing error screen + RETRY — UNCHANGED
        → WebView: loadDataWithBaseURL("file:///android_asset/", html, …) — SAME CALL
           (relative png/mp3 paths plain assets se resolve — kuch nahi toota)
```

### Crypto design (XOR-masking NAHI hai)

| Item | Choice |
|---|---|
| Container | `ZPAY01` v1: magic + iters + salt(16) + iv(16) + ctLen + ct + tag(32) |
| Key derivation | PBKDF2-HMAC-SHA256, 100k iterations, 64-byte output |
| Encryption | AES-256-CTR, random IV per build |
| Authentication | HMAC-SHA256 Encrypt-then-MAC, independent key, constant-time verify — **pehle verify, tabhi decrypt** |
| Password split | DEX-side per-build password (XOR-masked, existing pattern) + native-side pepper (obfuscated header me). `pwFull = password + "|zpay1|" + pepperHex`. Poora key kahin ek jagah plaintext nahi. |

C++ me SHA-256 / AES-256 / HMAC / PBKDF2 self-contained hain (koi OpenSSL/NDK
dependency nahi) — wahi `.cpp` files host test me compile karke Node ke
`crypto` ke against verify hoti hain (FIPS-197, RFC 4231, RFC vectors + live
round-trip).

### Fallback matrix (app kabhi crash nahi hota)

| Haalat | Natija |
|---|---|
| Normal build + NDK | Native snapshot load (~instant, offline bhi chalta hai) |
| `.so` missing / load fail | Remote fetch (purana behavior) |
| Payload tamper / galat key | MAC fail → null → remote fetch |
| Template/seedha Gradle build (empty placeholder) | Remote fetch (purana behavior) |
| NDK missing (build server par) | Build succeed, `.so` skip, warning log, runtime remote |
| `APK_POPUP_SOURCE=remote` | Order flip: remote pehle, native offline fallback |
| Signature tamper | Existing `SECURITY_FAILED` screen (native se pehle gate — unchanged) |

---

## 2. Files (kya add / kya modify hua)

**Naye (additive):**
- `utils/native-payload.js` — container encrypt, header generator, NDK detect, APK verifier
- `android-project/app/src/main/cpp/crypto/{sha256,aes,payload_crypto}.{h,cpp}` — native crypto
- `android-project/app/src/main/cpp/native-payload.cpp` — JNI bridge
- `android-project/app/src/main/cpp/payload/popup_payload.h` — **placeholder (empty)** — real header sirf build copy me
- `android-project/app/src/main/java/com/zayro/wingsyttt/NativePayload.java` — safe wrapper (null-safe, no-log, wipe)
- `tests/native-payload/{harness.cpp,run-tests.js}` — host verification suite
- `NATIVE-PAYLOAD.md` (ye file), `VERIFICATION-REPORT.md`

**Modify (surgical, existing behavior preserved):**
- `MainActivity.java` — `NATIVE_PAYLOAD_FIRST` flag + 2 chhote try/catch blocks (native attempt; remote code untouched)
- `proguard-rules.pro` — `NativePayload` keep rule (JNI names safe)
- `CMakeLists.txt` — naye sources add (existing file untouched)
- `apkbuilder.js` — payload gen + header write + auto `-PenableNativeSecurity` (NDK ho to) + extended verification
- `assets-config.json` — comment update (doc-only file)
- **Delete:** `android-project/app/src/main/assets/wingss.bin` — stale, koi code reference nahi karta tha (build pehle se `*.bin` wipe karta hai; sirf `loading.bin` embed hota hai)

**Bilkul untouched:** remote content server (`appcontent.js`, `/api/app-content/*` routes),
`encrypt.js` (CBC remote format), loading flow, intro/audio/TTS, bridges, SecurityManager,
signing/ABI/variants, Flutter builder, Telegram bot, database.

---

## 3. Build commands

```bash
# 0) Pre-check (bina Android SDK ke bhi chalta hai) — 29 checks
node tests/native-payload/run-tests.js

# 1) Normal pipeline build (default: native-first popup)
#    .env: APK_BUILD_VARIANT=protectedRelease (default), NDK install hona chahiye
#    ($ANDROID_HOME/ndk/<ver>/ — sdkmanager "ndk;25.2.9519653" ya similar)
pm2 start server.js --name apkbuilder   # ya existing flow se order build karo
# → security-report.txt me "native" section check karo

# 2) Purana order chahiye (remote pehle, native sirf offline fallback)
APK_POPUP_SOURCE=remote  # .env ya environment me set karke build karo

# 3) NDK ke bina build (graceful): .so skip + warning, runtime remote fallback.
#    Koi flag nahi chahiye — auto-detect hota hai.

# 4) Seedha Gradle (template, bina pipeline): placeholder empty → remote flow
cd android-project && ./gradlew assembleProtectedRelease -PenableNativeSecurity
```

### NDK install (build server par, ek baar)

```bash
sdkmanager --sdk_root=$ANDROID_HOME "ndk;25.2.9519653" "cmake;3.22.1"
```

---

## 4. Verification (har build me automatic)

`security-report.txt` me naya `native` section (report-only — kabhi build fail nahi karta):

- `plainPopupHtmlInAssets` — false hona chahiye
- `popupBinsInAssets` — `[]` hona chahiye (`wingss/zayro/popup*.bin` leak nahi)
- `loadingBinsInAssets` — `loading.bin` present (existing splash intact)
- `webviewAssetsIntact` — loading + intro.mp3 + icon + digits sab present
- `nativeSoPresent` + `payloadMagicInSo` — `.so` packaged aur ZPAY01 magic andar

Manual spot-check:

```bash
unzip -l app.apk | grep -Ei "assets/.*html|popup|wingss|zayro\.bin"   # kuch popup nahi
unzip -l app.apk | grep "libnativesecurity"                          # .so entries
unzip -p app.apk lib/arm64-v8a/libnativesecurity.so | grep -c "ZPAY01" # ≥1
```

---

## 5. Limitations (clearly documented — koi absolute guarantee nahi)

1. **Runtime key APK me recoverable hai.** DEX-side password (XOR-masked + R8 +
   optional Frezrik/360 packing) aur `.so`-side pepper (obfuscated) dono APK me
   hain. Determined attacker dono extract karke offline decrypt kar sakta hai.
   Ye design extraction ko *mehnga + time-consuming* banata hai (DEX + native
   reverse + format analysis), *impossible* nahi.
2. **Memory me plaintext** WebView ko dete waqt momentarily rehta hai (wiped
   ASAP, disk par kabhi nahi). Rooted device par memory dump se nikal sakta hai.
3. **Remote-update tradeoff:** default `native-first` me design/server edits
   turant reflect nahi honge — naya build chahiye. Turant-update chahiye to
   `APK_POPUP_SOURCE=remote` use karo (tab native snapshot offline fallback hai).
4. **Per-build uniqueness** existing kid/password flow par depend karti hai;
   fixed-password fallback builds me password shared rehta hai (pehle jaisa).
5. `.so` stripping/packing (Frezrik) DEX par focus karta hai; native code R8 se
   cover nahi hota — `-fvisibility=hidden` + `JNIEXPORT`-only symbols use hote hain.

---

## 6. Rollback (agar kabhi zaroorat pade)

- `APK_POPUP_SOURCE=remote` → runtime behavior 100% purana (remote-first), native sirf offline backup.
- NDK uninstall / native code revert → placeholder + remote flow = purana APK jaisa.
- Koi database migration nahi hui, koi API contract change nahi hua — server pura backward compatible hai.
