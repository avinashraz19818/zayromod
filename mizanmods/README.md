# MizanMods

An independent, single-operator Android build studio. Fresh sage/ivory dashboard, offline welcome screen and popup, private SQLite build history, serial worker queue and signed release downloads.

**Delivery status:** the API, database, queue failure/recovery path, frontend and browser popup are tested. A signed Android APK has **not** been produced or device-tested in the delivery environment: Java, Android SDK and a signing key were unavailable, and SDK download access failed. This is an implementation handoff, **not a production certification**. See [verification](docs/VERIFICATION.md).

## Independence and scope

This directory is the complete project root: it can be extracted and run without any parent repository files. No existing client account, database, credential, logo, uploaded content, API integration, Telegram bot, payments or runtime Firebase bridge is used. The only vendored build tooling is the standard Gradle wrapper; template generation, child-worker isolation, serialized compilation, alignment and signing follow the reference pipeline's build-only architecture.

MizanMods intentionally uses a fresh **local SQLite database**, not Firebase. There is no Firebase project to connect, deploy or bill. A new cloud Firebase project has **not** been provisioned. If cloud identity or synchronization is a contractual requirement, it remains additional work requiring a client-owned cloud project and deployment access; see [backend setup](docs/BACKEND.md).

Supported: app name, explicit package ID, version name/code, welcome copy, accent color, bundled fresh HTML/CSS/JS/SVG, queue/status, failure logs, retry configuration, verified-download gate and artifact retention. The Android app is offline-only. Arbitrary HTML uploads, remote site overlays, custom icon upload, notifications, multi-user accounts and multiple concurrent compilers are not implemented. Edit the trusted bundled template/assets to customize content. Do not embed secrets in APK assets: they are deliberately not encrypted and are not a secure storage mechanism.

## Requirements

- Linux, Node.js **22.13+** (tested 22.22.3; built-in `node:sqlite` emits an experimental warning).
- JDK **17** recommended; Gradle **8.13** wrapper and Android Gradle plugin **8.12.0**.
- Android SDK: `platforms;android-35`, `build-tools;35.0.0`, `platform-tools`.
- At least 4 GB RAM and 10 GB available disk recommended; one compiler runs at a time.
- Network access on the build host to Google's Android/Maven repositories, Maven Central and Gradle distributions. The generated app has no internet permission.
- A **new MizanMods signing key**, owned and backed up by the client.

## Start the studio

```sh
cd MizanMods                     # or this standalone project directory
npm ci
cp .env.example .env
openssl rand -hex 32             # put a newly generated value in ADMIN_TOKEN
# Edit .env: set ADMIN_TOKEN; never commit this file.
npm test
npm start
```

Open port 3000. The server binds `0.0.0.0`; all browser API calls are relative, so preview/reverse-proxy hosts work. Click **Create Android build** to unlock with your own token. The token is kept only in page memory and must be entered again on reload. Obtain it from your local `.env` or deployment secret manager, never from another client. Do not send secrets through chat.

The studio can start before Android tooling exists. **Environment** lists missing prerequisites; build requests fail clearly rather than serving a dummy or unsigned APK.

## Install Android tooling and create a signing key

Install JDK 17 using your OS package manager. Download the official Android command-line tools and extract under `$ANDROID_HOME/cmdline-tools/latest`. Then:

```sh
export ANDROID_HOME=/opt/android-sdk
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
sdkmanager --licenses
sdkmanager 'platforms;android-35' 'build-tools;35.0.0' 'platform-tools'
mkdir -p secrets
chmod 700 secrets
keytool -genkeypair -keystore secrets/mizanmods-release.jks \
  -alias mizanmods -keyalg RSA -keysize 3072 -validity 10000
# Answer prompts with the new client's information and a new strong password.
chmod 600 secrets/mizanmods-release.jks
```

Set `KEYSTORE_PATH` to the **absolute** path of this file. Set `KEYSTORE_PASSWORD` and `KEY_PASSWORD` from your new key (PKCS12 keys normally use the same password), and `KEYSTORE_ALIAS=mizanmods`. Back up the signing key separately: losing it prevents compatible app updates. Never use the same key as another client. `KEYSTORE_PATH` must be outside `runtime/`, because runtime cleanup is disposable.

```sh
npm run doctor
npm start
```

No silent debug/unsigned fallback exists. A missing or invalid signing key is a build failure. Signing passwords are passed to `apksigner` through environment variable references, not command-line plaintext.

## Environment variables

| Variable | Required | Default / purpose |
|---|---|---|
| `ADMIN_TOKEN` | Yes | New random token, minimum 32 characters; 64 hex recommended |
| `PORT` | No | `3000` |
| `DATA_DIR` | No | `./runtime`, relative to project root; use a dedicated absolute path in deployment |
| `ANDROID_HOME` | To build | Android SDK root |
| `BUILD_TOOLS_VERSION` | No | `35.0.0`, tools used for signing/verification; Gradle compiles with 35.0.0 |
| `BUILD_TIMEOUT_MS` | No | `900000`; entire worker deadline, maximum 3600000 |
| `MAX_QUEUE` | No | `10`, including the active build |
| `RETENTION_DAYS` | No | `7`, retained APK lifetime |
| `KEYSTORE_PATH` | To build | Absolute path to new private release keystore |
| `KEYSTORE_ALIAS` | To build | `mizanmods` |
| `KEYSTORE_PASSWORD` | To build | Fresh secret, no default |
| `KEY_PASSWORD` | To build | Fresh secret, no default |

## Build and download

1. Unlock the dashboard with the installation's token.
2. Configure app name, unique package (e.g. `com.mizanmods.app`), version, welcome text and accent.
3. Preview the offline screen and open/close its welcome popup.
4. Select **Create Android build**. Progress reflects pipeline stages, not estimated elapsed time.
5. Open build details for logs. On success, download the signed APK and record its SHA-256.
6. Increase `versionCode` for an update; retain the same package and signing key.

API equivalent (token loaded into your local shell):

```sh
curl -X POST http://127.0.0.1:3000/api/builds \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"appName":"MizanMods","packageName":"com.mizanmods.app","versionCode":1,"versionName":"1.0.0"}'
# Use the returned id:
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:3000/api/builds/BUILD_ID
curl -f -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:3000/api/builds/BUILD_ID/download -o MizanMods.apk
```

The `127.0.0.1` examples are CLI requests on the server, not browser-facing URLs. For remote access use your new deployment's HTTPS origin.

Build sequence: persisted queue → detached Node worker → validated template generation → `:app:assembleRelease` → exact unsigned-output path → zipalign → apksigner → signature/alignment/package/version/non-debuggable verification → SHA-256 → ready. Each worker gets a UUID directory; compilation happens outside the API process. On timeout the entire process group is killed. Queued requests survive restart; interrupted builds fail with a retry message. Temporary projects are removed, and expired artifacts are removed hourly and on startup. The most recent 100 metadata records are displayed; older metadata remains in SQLite for operations/auditing.

## Verification commands

```sh
npm test
npm audit
npx playwright install --with-deps chromium
# Start server in another terminal using a TEST installation with NO signing key.
npm run test:browser
# Browser tests intentionally assert the missing-toolchain failure path and create test history.
# TEST_BASE_URL changes the test target; CHROMIUM_EXECUTABLE selects an installed Chromium.
```

After an actual successful release build:

```sh
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --verbose MizanMods.apk
adb devices
adb install -r MizanMods.apk
adb shell am start -n com.mizanmods.app/com.mizanmods.shell.MainActivity
adb logcat -c
# Open the popup, dismiss it, rotate the screen and relaunch offline.
adb logcat -d -s AndroidRuntime chromium
```

Test API 23 and API 35 devices/emulators, including edge-to-edge insets and Android System WebView compatibility. A browser test is not a replacement for these device checks.

## Structure

```text
MizanMods/
├── src/                    # config, validation, SQLite, queue, builder, worker, API
├── public/                 # new dashboard, popup and original vector mark
├── android-template/       # clean Java shell and standard Gradle wrapper
├── tests/                  # Node API/core tests and Playwright interactions
├── scripts/                # doctor and source-only export
├── docs/                   # architecture, backend, deployment, verification
├── playwright.config.js
├── package.json / package-lock.json
├── .env.example / .gitignore
└── runtime/                # ignored local DB, Gradle cache, jobs and APK artifacts
```

## Standalone handoff / GitHub

```sh
npm run export
# Source-only package: runtime/MizanMods-source.tar.gz
```

Export excludes `.git`, actual environment files, keys, runtime data, dependencies and build outputs. It contains no parent project and no parent Git history. This handoff was staged as a separate directory in the working checkout; no separate GitHub repository has been created or pushed. This workspace session is restricted to its assigned branch. Publish the **exported source only** in a new private client-owned repository through an authorized GitHub workflow; do not fork/import the reference repository's history or push its root. After publication perform the fresh GitHub clone test and the remaining release/device checks in [verification](docs/VERIFICATION.md).

Deployment and operational constraints: [DEPLOYMENT.md](docs/DEPLOYMENT.md).
