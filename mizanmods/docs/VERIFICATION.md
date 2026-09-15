# Verification record

Date: 2026-09-15 (UTC). This record distinguishes executed checks from uncompleted release gates.

## Executed checks

| Check | Result |
|---|---|
| Node dependency installation | PASS, Node 22.22.3, locked npm install |
| Node API/core tests | PASS, 7 tests |
| Browser interactions at 1440, 768 and 390 pixels | PASS, 3 Playwright tests using Chromium |
| JavaScript syntax checks | PASS for source/public/scripts |
| Dependency security audit | PASS, zero reported vulnerabilities after update |
| Independent SQLite persistence and second-database isolation | PASS |
| Token authentication, malformed bodies, validation, queue limits | PASS |
| API download guards | PASS for unavailable/missing output; successful response tested with explicitly synthetic test bytes, not an APK |
| Serialized worker queue and missing-toolchain failure | PASS; two jobs drain serially, errors are recorded, temporary work is removed |
| Restart recovery and bounded logs | PASS |
| Artifact expiration | PASS |
| Template generation and escaped welcome content | PASS |
| Browser popup open/dismiss | PASS at all three tested sizes |
| Dashboard unlock, navigation, environment checks, build submission, failed status, retry configuration | PASS |
| Browser page/console errors during final tests | None observed |
| Horizontal overflow at tested viewport widths | None observed |
| Existing project tracked files modified | None |

The clean export setup test, source-isolation scan and final re-run results are recorded below after execution. Screenshots and runtime test data remain ignored, not included as client source.

## Build and provisioning blockers

- `npm run doctor`: missing Java, Android platform 35, zipalign, apksigner, aapt, signing key and signing passwords.
- Actual generated project's `./gradlew :app:assembleRelease --no-daemon`: **failed before compilation**, because `JAVA_HOME` is unset and `java` is unavailable.
- Official Android SDK download connection failed with TLS connection errors. OS package repository connections also failed.
- Standard Playwright CDN download failed. Browser testing was recovered with an npm-distributed Chromium binary and its bundled runtime libraries, used only in ignored test tooling.
- No signed APK generated; signature validation against an actual APK, install/run, Android WebView/device behavior and second release build remain **NOT VERIFIED**.
- No physical device/emulator/ADB available for installation testing.
- No Firebase project created or connection tested. Current implementation deliberately uses independent local SQLite instead; cloud Firebase is an undelivered requirement.
- No separate GitHub repository created/pushed: this session permits work only on its assigned branch. No repository URL is claimed. A fresh GitHub clone cannot be tested before publication; a fresh source-export extraction is a different test, not a clone.

## Bugs/issues found and addressed

1. Dependency audit initially reported two high-severity issues involving the rate limiter/IP handling dependency. Updated the pinned rate limiter; final audit is clean.
2. Popup dismissal used a form submit inside a sandboxed preview; submission was blocked. Replaced it with explicit JavaScript dialog close/fallback and retested desktop/tablet/mobile.
3. Java readiness originally checked only executable presence. It now checks the reported major version and requires 17+.
4. Tablet preview was initially hidden by a breakpoint. It is now visible and interaction-tested at tablet width.
5. Small phone preview typography wrapped too aggressively. Added narrow-screen typography/spacing rules.
6. Reference pipeline risks were not carried forward: unsigned-success fallback, ambiguous artifact selection, in-memory-only pending queue and killing only the immediate worker were replaced with mandatory signing, exact output selection, durable queue and process-group termination.

## Required production acceptance

On a provisioned, isolated build host: run doctor; build a release; validate signature/package/version; download and hash the real APK; install/launch on API 23 and 35; open/dismiss popup; rotate/relaunch offline; review logcat; perform a second build with incremented versionCode and update-install it. Verify success/download UI against those actual artifacts. Publish only the clean source export, then clone the new repository and repeat setup/tests. Do not label this delivery production-ready until those gates pass.

## Final isolated setup and handoff checks

- Exported the allowlisted source to a new directory without parent files or Git history.
- Fresh extraction: `npm ci` **PASS**, 7 Node tests **PASS**, `npm audit` **0 vulnerabilities**.
- Started the extracted backend on a separate port with a newly generated token and its own new runtime database: **PASS**.
- Re-ran all 3 browser tests against that extracted backend: **PASS** (1440/768/390px). Stopped the verification server afterward.
- Targeted source scan for reference brand/personal/package/domain identifiers, Firebase database host patterns, API-key patterns and private-key headers: **0 matches** in deliverable source.
- Source archive check: **no actual `.env`, signing key, APK, SQLite database, runtime directory, node_modules or Git history**.
- Existing tracked-file diff against the original checkout: **empty**. New work is confined to the standalone project directory.
- Final original-workspace Node/browser re-run: **7 + 3 passed**; source syntax checks passed and dependency audit remained clean.

The export is self-contained but is **not** a new GitHub repository or a fresh GitHub clone. Actual Android release/device acceptance remains blocked as described above.
- Final actual Gradle attempt was repeated with freshly generated version 1.0.1 / versionCode 2: again exited 1 before compilation because Java was unavailable. No APK was substituted or marked successful.
