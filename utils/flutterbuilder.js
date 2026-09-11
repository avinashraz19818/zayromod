'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// flutterbuilder.js — FLUTTER CLIENT APK BUILDER (advanced security engine)
//
// apkbuilder.js (Java) ka Flutter counterpart — SAME result contract follow
// karta hai: { success, apkFile, apkPath } | { success:false, error }.
// Worker (apkbuilder-worker.js) engine ke hisaab se yahan dispatch karta hai.
//
// JAVA builder se differences:
//   • Template: flutter-project/ (Dart + Kotlin + C++) — gradle project nahi
//   • Per-build UNIQUE password (build_keys table) — FIXED_PASSWORD nahi
//   • Password 3 fragments me split: Dart (D1) + native C++ (R1) + cert-derived (C3)
//   • Flutter release: --obfuscate --split-debug-info (Dart AOT symbols strip)
//   • Frezrik/360 Jiagu SKIP — wo DEX packers hain; Dart logic libapp.so
//     (native machine code) me hota hai, DEX me nahi. Wrapper R8 + native
//     checks + obfuscation hi yahan protection hai.
// ═════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const { encryptHtmlToBin, generateBuildPassword } = require('./encrypt');
const { applyFontStyle } = require('./fontstyles');

const BUILDS_DIR       = path.join(__dirname, '..', 'builds');
const TEMPLATE_PROJECT = path.join(__dirname, '..', 'flutter-project');
const TEMPLATES_DIR    = path.join(__dirname, '..', 'templates');
const UPLOADS_DIR      = path.join(__dirname, '..', 'uploads');
const ANDROID_HOME     = process.env.ANDROID_HOME || '/opt/android-sdk';
const FLUTTER_BIN      = process.env.FLUTTER_BIN || 'flutter';
const KEYSTORE_PASSWORD = String(process.env.KEYSTORE_PASSWORD || '');
const KEYSTORE_ALIAS    = String(process.env.KEYSTORE_ALIAS || 'zayro');

const KEY_XOR = 0x5A;

// ── Icon resize (apkbuilder jaisa) ──
async function resizeIcon(inputBuffer) {
  const sizes = { 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96, 'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192 };
  const result = {};
  for (const [dir, size] of Object.entries(sizes)) {
    result[dir] = await sharp(inputBuffer).resize(size, size).png().toBuffer();
  }
  return result;
}

function maskX(s) {
  return Array.from(Buffer.from(String(s), 'utf8')).map(b => (b ^ KEY_XOR) & 0xFF);
}
function dartByteList(arr) { return `[${arr.join(', ')}]`; }
function cByteArray(arr) { return '{ ' + arr.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ') + ' }'; }

function dartEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/[\r\n]+/g, ' ');
}

// ── Server leaf cert ka SHA-256 (TLS pinning — build time pe fetch) ──
function fetchCertPinSha256(serverBase) {
  try {
    const u = new URL(serverBase);
    if (u.protocol !== 'https:') return null;
    return new Promise((resolve) => {
      const sock = tls.connect({
        host: u.hostname, port: 443, servername: u.hostname,
        rejectUnauthorized: false, timeout: 8000
      }, () => {
        try {
          const cert = sock.getPeerCertificate();
          sock.end();
          if (cert && cert.raw) {
            resolve(crypto.createHash('sha256').update(cert.raw).digest('hex'));
            return;
          }
        } catch (_) { try { sock.end(); } catch (__) {} }
        resolve(null);
      });
      sock.on('error', () => resolve(null));
      sock.on('timeout', () => { try { sock.destroy(); } catch (_) {} resolve(null); });
    });
  } catch (_) { return Promise.resolve(null); }
}

// ── PER-BUILD KEY SPLIT — 3 fragments ──
//   P  = asli 56-byte password (build_keys me base64 store; server encrypt ke liye)
//   D1 = P ^ R1 ^ C3        → Dart build_config me
//   R1 = random             → native C++ array me (XOR 0x5A at rest)
//   C3 = sha512(certSha256Hex + buildSalt)[0..55]  → RUNTIME pe banta hai
//      (cert sirf tab milega jab APK original signature se signed ho)
// Galat signature / missing shard → P galat → decrypt fail. Kahin bhi poora
// P ek jagah nahi hai (na Dart me, na native me, na string table me).
function splitBuildKey(passwordBase64, certSha256Hex, log) {
  const P  = Buffer.from(passwordBase64, 'base64');            // 56 bytes
  const R1 = crypto.randomBytes(56);
  const buildSalt = crypto.randomBytes(32).toString('hex');
  const C3full = crypto.createHash('sha512').update(String(certSha256Hex || '') + buildSalt).digest();
  const D1 = Buffer.alloc(56);
  for (let i = 0; i < 56; i++) D1[i] = P[i] ^ R1[i] ^ C3full[i];
  if (!certSha256Hex) log('WARNING: cert SHA-256 nahi mila — C3 fragment weak salt pe banega. Keystore check karo.');
  return {
    d1Bytes: Array.from(D1),
    r1Masked: Array.from(R1).map(b => (b ^ KEY_XOR) & 0xFF),
    buildSalt
  };
}

// ── Main build (worker me chalta hai) ──
async function buildFlutterApkInWorker(order, design, buildId, logCallback) {
  const log = (msg) => { logCallback && logCallback(msg); };
  const buildDir = path.join(BUILDS_DIR, buildId);
  fs.mkdirSync(buildDir, { recursive: true });
  let projectDir = null;

  try {
    log('Flutter build started...');

    // ── Pre-checks ──
    if (!fs.existsSync(TEMPLATE_PROJECT))
      throw new Error('flutter-project/ template repo me nahi mila. Repoupload check karo.');
    try { execFileSync(FLUTTER_BIN, ['--version'], { stdio: 'pipe', timeout: 60000 }); }
    catch (e) {
      throw new Error(`Flutter SDK nahi mila (${FLUTTER_BIN}). VPS pe Flutter install karo — FLUTTER-SETUP.md dekho ya FLUTTER_BIN env set karo.`);
    }

    // ── PER-BUILD KEY ──
    const keyPasswordB64 = generateBuildPassword();
    const keyId = crypto.randomBytes(12).toString('hex'); // 24 hex chars
    log(`Per-build key generated (kid=${keyId.substring(0, 6)}...).`);

    // ── Keystore cert hash (C3 + signature check dono ke liye) ──
    const keystorePath = path.join(__dirname, '..', 'keystore', 'release.keystore');
    let certSha256Hex = '';
    if (fs.existsSync(keystorePath)) {
      try {
        const kt = execFileSync('keytool', ['-list', '-v', '-keystore', keystorePath, '-storepass', KEYSTORE_PASSWORD], { stdio: 'pipe', encoding: 'utf8' });
        const m = kt.match(/SHA256:\s*([0-9A-Fa-f:]+)/);
        if (m) certSha256Hex = m[1].replace(/:/g, '').toLowerCase();
      } catch (e) { certSha256Hex = ''; }
      // Keystore HAI par hash nahi mila = env problem (keytool missing/java
      // PATH). Aage chalne se signature check + C3 dono weak ho jayenge —
      // silent weak build se behtar hai build FAIL hona (saaf error ke saath).
      if (!certSha256Hex)
        throw new Error('keystore/release.keystore mila par cert SHA-256 nahi nikla — keytool/java PATH check karo (apt install openjdk-17-jdk).');
    } else {
      log('WARNING: keystore/release.keystore NAHI hai — APK unsigned rahegi aur signature check disabled hoga. Production me ye mat chhodo.');
    }

    const frag = splitBuildKey(keyPasswordB64, certSha256Hex, log);

    // ── Key DB me save (history — purane APKs chalte rahte hain) ──
    const contentPath = String(order.firebase_path || '').trim();
    if (!contentPath) throw new Error('order.firebase_path missing — content path ke bina Flutter build nahi ban sakta.');
    {
      const db = require('../database/db');
      db.prepare('INSERT INTO build_keys (order_id, firebase_path, key_id, key_secret, engine, active) VALUES (?,?,?,?,?,1)')
        .run(order.id, contentPath, keyId, keyPasswordB64, 'flutter');
      log('Key saved to build_keys (history preserved).');
    }

    // ── TLS pin (server leaf cert) ──
    const serverBase = String(process.env.BASE_URL || 'https://devlopedwithzayro.site').replace(/\/+$/, '');
    const certPin = await fetchCertPinSha256(serverBase);
    if (certPin) log('TLS cert pin embed hoga: ' + certPin.substring(0, 16) + '...');
    else log('WARNING: TLS pin fetch nahi hua — pinning disabled is build me.');

    // ── Template copy ──
    projectDir = path.join(buildDir, 'fproject');
    execFileSync('cp', ['-r', TEMPLATE_PROJECT, projectDir], { stdio: 'pipe' });

    // Flutter platform scaffold regenerate (gradlew/wrapper binaries jo git
    // me nahi hote). `flutter create` missing files bharta hai.
    const projName = 'zayro_client';
    log('Flutter scaffold prepare ho raha hai...');
    try {
      execFileSync(FLUTTER_BIN, ['create', '--platforms', 'android', '--project-name', projName, '--org', 'com.zayro', '.'],
        { cwd: projectDir, stdio: 'pipe', timeout: 240000,
          env: { ...process.env, ANDROID_HOME, ANDROID_SDK_ROOT: ANDROID_HOME } });
    } catch (e) {
      log('flutter create warning: ' + String(e.message || e).slice(-300) + ' — template android/ use hoga.');
    }
    // Newer Flutter create KTS build files banata hai — humari template GROOVY
    // hai. Dono mix hue to Gradle "multiple build files" dega. create ke gradle
    // build files + stale generated kotlin package hatao (humari template files
    // overlay me aayengi; wrapper binaries create ke hi rehte hain).
    for (const f of [
      'android/settings.gradle.kts', 'android/build.gradle.kts',
      'android/app/build.gradle.kts', 'android/settings.gradle',
      'android/build.gradle', 'android/app/build.gradle',
      'android/gradle.properties', 'android/app/src/main/AndroidManifest.xml'
    ]) { try { fs.unlinkSync(path.join(projectDir, f)); } catch (_) {} }
    try { fs.rmSync(path.join(projectDir, 'android', 'app', 'src', 'main', 'kotlin'), { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.join(projectDir, 'test'), { recursive: true, force: true }); } catch (_) {}
    // Overlay: template ke android/lib files WAPAS copy (flutter create ne
    // kuch default daal diye hon to humari secured files upar se).
    execFileSync('cp', ['-r', path.join(TEMPLATE_PROJECT, 'lib'), path.join(TEMPLATE_PROJECT, 'android'), path.join(TEMPLATE_PROJECT, 'pubspec.yaml'), projectDir + '/'], { stdio: 'pipe' });

    const params = {
      appName: String(order.app_name || 'App'),
      brandTitle: (order.brand_title || '').trim() || String(order.app_name || 'App'),
      minDeposit: parseInt(order.min_deposit, 10) || 300,
      registerUrl: String(order.register_url || ''),
      themeColor: String(order.theme_color || '').trim() || '#ff1e1e',
      designKey: String(design.native_key || '').trim() || 'default'
    };

    // ── Patch build_config.dart ──
    log('Patching build_config.dart (key fragments + masked URLs)...');
    const cfgPath = path.join(projectDir, 'lib', 'config', 'build_config.dart');
    let cfg = fs.readFileSync(cfgPath, 'utf8');
    const reps = [
      ['static const List<int> _serverUrlM = [0, 0];',
       `static const List<int> _serverUrlM = ${dartByteList(maskX(serverBase))};`],
      ['static const List<int> _contentPathM = [0, 0];',
       `static const List<int> _contentPathM = ${dartByteList(maskX(contentPath))};`],
      ['static const List<int> _fallbackGameUrlM = [0, 0];',
       `static const List<int> _fallbackGameUrlM = ${dartByteList(maskX(params.registerUrl))};`],
      ['static const List<int> _keyFragDart = [0];',
       `static const List<int> _keyFragDart = ${dartByteList(frag.d1Bytes)};`],
      ["static const String _keySalt = '@KEY_SALT@';",
       `static const String _keySalt = '${frag.buildSalt}';`],
      ["static const String _keyId = '@KEY_ID@';",
       `static const String _keyId = '${keyId}';`],
      ['static const List<String> certPins = [];',
       `static const List<String> certPins = [${certPin ? `'${certPin}'` : ''}];`],
      ["static const String snapshotAppName = 'App';",
       `static const String snapshotAppName = '${dartEscape(params.appName)}';`],
      ["static const String snapshotBrandTitle = 'APP';",
       `static const String snapshotBrandTitle = '${dartEscape(params.brandTitle)}';`],
      ['static const int snapshotMinDeposit = 300;',
       `static const int snapshotMinDeposit = ${params.minDeposit};`],
      ["static const String snapshotPrimary = '#ff1e1e';",
       `static const String snapshotPrimary = '${dartEscape(params.themeColor)}';`],
      ["static const String snapshotDesignKey = 'default';",
       `static const String snapshotDesignKey = '${dartEscape(params.designKey)}';`]
    ];
    for (const [from, to] of reps) {
      if (!cfg.includes(from)) throw new Error('build_config.dart patch token missing: ' + from.slice(0, 48));
      cfg = cfg.replace(from, to);
    }
    fs.writeFileSync(cfgPath, cfg, 'utf8');

    // ── Patch android/app/build.gradle — applicationId ──
    const gradlePath = path.join(projectDir, 'android', 'app', 'build.gradle');
    if (fs.existsSync(gradlePath)) {
      let g = fs.readFileSync(gradlePath, 'utf8');
      g = g.replace(/applicationId\s+"[^"]*"/, `applicationId "${order.package_name}"`);
      fs.writeFileSync(gradlePath, g, 'utf8');
    }

    // ── Patch AndroidManifest label (styled app name) ──
    const manifestPath = path.join(projectDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    if (fs.existsSync(manifestPath)) {
      let m = fs.readFileSync(manifestPath, 'utf8');
      const styled = applyFontStyle(params.appName, order.app_name_style || 'normal')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      m = m.replace(/android:label="[^"]*"/, `android:label="${styled}"`);
      fs.writeFileSync(manifestPath, m, 'utf8');
    }

    // ── Patch SecurityBridge.kt — expected cert SHA-256 (XOR masked) ──
    const secKtPath = path.join(projectDir, 'android', 'app', 'src', 'main', 'kotlin', 'com', 'zayro', 'client', 'SecurityBridge.kt');
    if (!fs.existsSync(secKtPath)) throw new Error('SecurityBridge.kt template me nahi mila — flutter-project corrupt hai.');
    {
      let k = fs.readFileSync(secKtPath, 'utf8');
      const token = 'private val EXPECTED_CERT_SHA256_M = byteArrayOf(0, 0)';
      if (!k.includes(token)) throw new Error('SecurityBridge.kt patch token missing — template badal gaya hai, flutterbuilder sync karo.');
      k = k.replace(token,
        `private val EXPECTED_CERT_SHA256_M = byteArrayOf(${maskX(certSha256Hex || '').map(b => b > 127 ? `${b - 256}.toByte()` : `${b}.toByte()`).join(', ')})`);
      fs.writeFileSync(secKtPath, k, 'utf8');
    }

    // ── Patch native_core.cpp — R1 key shard (XOR masked at rest) ──
    // Ye patch MISS hua to shard empty rahega → app block/brick. Isliye
    // token verify FAIL = build FAIL (silent broken APK kabhi ship nahi hoga).
    const cppPath = path.join(projectDir, 'android', 'app', 'src', 'main', 'cpp', 'native_core.cpp');
    if (!fs.existsSync(cppPath)) throw new Error('native_core.cpp template me nahi mila — flutter-project corrupt hai.');
    {
      let c = fs.readFileSync(cppPath, 'utf8');
      const token = 'static const unsigned char KEY_SHARD_M[] = { 0x00 };';
      if (!c.includes(token)) throw new Error('native_core.cpp patch token missing — template badal gaya hai, flutterbuilder sync karo.');
      c = c.replace(token, `static const unsigned char KEY_SHARD_M[] = ${cByteArray(frag.r1Masked)};`);
      if (c.includes('KEY_SHARD_M[] = { 0x00 }')) throw new Error('native_core.cpp shard patch verify fail.');
      fs.writeFileSync(cppPath, c, 'utf8');
    }

    // ── Assets: shared media copy (MP3/PNG/fonts) ──
    log('Copying media assets...');
    const mediaDir = path.join(projectDir, 'assets', 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const sharedAssetsDir = path.join(TEMPLATES_DIR, 'assets');
    if (fs.existsSync(sharedAssetsDir)) {
      for (const f of fs.readdirSync(sharedAssetsDir)) {
        const src = path.join(sharedAssetsDir, f);
        if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(mediaDir, f));
      }
    }

    // ── Icons ──
    if (order.icon_file) {
      const iconPath = path.join(UPLOADS_DIR, order.icon_file);
      if (fs.existsSync(iconPath)) {
        log('Resizing and replacing app icons...');
        const iconBuffer = fs.readFileSync(iconPath);
        const iconSizes = await resizeIcon(iconBuffer);
        for (const [dir, buf] of Object.entries(iconSizes)) {
          const iconDir = path.join(projectDir, 'android', 'app', 'src', 'main', 'res', dir);
          fs.mkdirSync(iconDir, { recursive: true });
          fs.writeFileSync(path.join(iconDir, 'ic_launcher.png'), buf);
        }
        fs.writeFileSync(path.join(mediaDir, 'my_icon.png'), iconBuffer);
      }
    }

    // ── integrity.json (runtime asset tamper check) ──
    {
      const entries = {};
      for (const f of fs.readdirSync(mediaDir)) {
        const ap = path.join(mediaDir, f);
        if (fs.statSync(ap).isFile())
          entries['media/' + f] = crypto.createHash('sha256').update(fs.readFileSync(ap)).digest('hex');
      }
      fs.writeFileSync(path.join(projectDir, 'assets', 'integrity.json'),
        JSON.stringify({ version: 1, generatedAt: Date.now(), assets: entries }, null, 1));
    }

    // ── build env ──
    const buildEnv = {
      ...process.env,
      ANDROID_HOME,
      ANDROID_SDK_ROOT: ANDROID_HOME,
      PATH: `${process.env.PATH}:${ANDROID_HOME}/build-tools/34.0.0:${ANDROID_HOME}/platform-tools`
    };

    // ── pub get ──
    log('flutter pub get...');
    try {
      execFileSync(FLUTTER_BIN, ['pub', 'get'], { cwd: projectDir, stdio: 'pipe', timeout: 300000, env: buildEnv });
    } catch (e) {
      throw new Error('flutter pub get FAIL: ' + String(e.stdout || '') + String(e.stderr || '').slice(-800));
    }

    // ── flutter build apk (release + obfuscate) ──
    const sdiDir = path.join(buildDir, 'symbols'); // split-debug-info — SERVER pe hi rakho, APK/repo me nahi
    const buildArgs = ['build', 'apk', '--release', '--obfuscate', `--split-debug-info=${sdiDir}`];
    log('Compiling Flutter APK (release + obfuscate)... 2-5 min lag sakte hain.');
    const runFlutter = (args) => {
      try {
        const r = execFileSync(FLUTTER_BIN, args, {
          stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
          cwd: projectDir, env: buildEnv, timeout: 900000
        });
        return { ok: true, out: String(r) };
      } catch (e) {
        return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') + String(e.message || '') };
      }
    };
    let fr = runFlutter(buildArgs);
    if (!fr.ok) {
      log('Obfuscated build FAILED — plain release fallback try...');
      fr = runFlutter(['build', 'apk', '--release']);
      if (!fr.ok) throw new Error('flutter build apk fail: ' + fr.out.slice(-2000));
      log('Plain release build OK (obfuscation skip hui).');
    } else {
      log('Flutter build OK (obfuscated).');
    }

    const builtApk = path.join(projectDir, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');
    if (!fs.existsSync(builtApk)) throw new Error('No APK found after flutter build (build/app/outputs/flutter-apk khali).');
    log('APK mila: app-release.apk (' + Math.round(fs.statSync(builtApk).size / 1024 / 102.4) / 10 + ' MB)');

    // ── Sign (zipalign + apksigner) — Java builder jaisa ──
    const apkBase = String(order.app_name || 'App')
      .replace(/[\/\\:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'App';
    let signedApk = path.join(buildDir, `${apkBase}.apk`);
    let apkCounter = 2;
    while (fs.existsSync(signedApk) && apkCounter < 50) {
      signedApk = path.join(buildDir, `${apkBase}_${apkCounter++}.apk`);
    }

    if (fs.existsSync(keystorePath)) {
      log('Signing with keystore...');
      // Explicit build-tools path — PATH pe depend nahi karte (systemd/pm2
      // service ke paas .bashrc wala PATH nahi hota)
      const btDir = path.join(ANDROID_HOME, 'build-tools', '34.0.0');
      const zipalignBin = fs.existsSync(path.join(btDir, 'zipalign')) ? path.join(btDir, 'zipalign') : 'zipalign';
      const apksignerBin = fs.existsSync(path.join(btDir, 'apksigner')) ? path.join(btDir, 'apksigner') : 'apksigner';
      const alignedApk = path.join(buildDir, `${buildId}_aligned.apk`);
      execFileSync(zipalignBin, ['-f', '4', builtApk, alignedApk], { stdio: 'pipe', env: buildEnv });
      execFileSync(apksignerBin, [
        'sign',
        '--ks', keystorePath,
        '--ks-pass', `pass:${KEYSTORE_PASSWORD}`,
        '--key-pass', `pass:${KEYSTORE_PASSWORD}`,
        '--v1-signing-enabled', 'true',
        '--v2-signing-enabled', 'true',
        '--v3-signing-enabled', 'true',
        '--v4-signing-enabled', 'false',
        '--out', signedApk,
        alignedApk
      ], { stdio: 'pipe', env: buildEnv });
      fs.unlinkSync(alignedApk);
      log('APK signed successfully.');
    } else {
      fs.copyFileSync(builtApk, signedApk);
      log('WARNING: No keystore — APK UNSIGNED hai.');
    }

    // ── Security report ──
    {
      const report = { engine: 'flutter', appName: order.appName || order.app_name, keyId, pinning: !!certPin };
      const fails = [], warnings = [];
      try { report.apkSha256 = crypto.createHash('sha256').update(fs.readFileSync(signedApk)).digest('hex'); } catch (e) {}
      report.certSha256 = certSha256Hex || 'unknown';
      try {
        const aps = path.join(ANDROID_HOME, 'build-tools', '34.0.0', 'apksigner');
        execFileSync(fs.existsSync(aps) ? aps : 'apksigner', ['verify', '--print-certs', signedApk], { stdio: 'pipe', env: buildEnv });
        report.signed = true;
      } catch (e) { report.signed = false; fails.push('APK signed nahi hai'); }
      try {
        const listing = execFileSync('unzip', ['-l', signedApk], { stdio: 'pipe', encoding: 'utf8', env: buildEnv });
        report.plaintextHtmlJsInApk = /\.(html)\s*$/m.test(listing);
        if (report.plaintextHtmlJsInApk) warnings.push('HTML plaintext mila APK me');
        report.hasLibapp = /libapp\.so/.test(listing);
        if (!report.hasLibapp) warnings.push('libapp.so nahi mila?');
      } catch (e) { warnings.push('unzip listing check skip'); }
      report.status = fails.length ? 'FAIL' : 'PASS';
      report.fails = fails; report.warnings = warnings;
      try { fs.writeFileSync(path.join(buildDir, 'security-report.txt'), JSON.stringify(report, null, 2) + '\n'); } catch (e) {}
      log(`Security report: ${report.status}${fails.length ? ' — ' + fails.join('; ') : ''}`);
    }

    // ── Cleanup (project + symbols server pe hi rahenge — repo me nahi jate) ──
    fs.rmSync(projectDir, { recursive: true, force: true });
    projectDir = null;

    log('Flutter build complete!');
    return { success: true, apkFile: path.basename(signedApk), apkPath: signedApk };

  } catch (err) {
    if (projectDir) { try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) {} }
    log(`ERROR: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { buildFlutterApkInWorker };
