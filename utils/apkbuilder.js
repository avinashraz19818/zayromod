const fs = require('fs');
const path = require('path');
const { execFileSync, fork } = require('child_process');
const sharp = require('sharp');
const { encryptHtmlToBin, encryptAsset, generateBuildPassword, generateNativeLib, getKeystoreCertHash } = require('./encrypt');
const { extractDomain, buildUrls, injectParams, injectThemeCss } = require('./htmlprocessor');

const BUILDS_DIR        = path.join(__dirname, '..', 'builds');
const TEMPLATE_PROJECT  = path.join(__dirname, '..', 'android-project');
const TEMPLATES_DIR     = path.join(__dirname, '..', 'templates');
const UPLOADS_DIR       = path.join(__dirname, '..', 'uploads');
const ANDROID_HOME      = '/opt/android-sdk';

// ── Generate package name from app name ──
function makePackageName(appName, counter) {
  let clean = appName.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 8) || 'app';
  // Package name cannot start with a digit — prefix with 'a' if it does
  if (/^[0-9]/.test(clean)) clean = 'a' + clean.substring(0, 7);
  return `com.zayro.${clean}${counter}`;
}

// ── Resize icon to required Android sizes ──
async function resizeIcon(inputBuffer) {
  const sizes = { 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96, 'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192 };
  const result = {};
  for (const [dir, size] of Object.entries(sizes)) {
    result[dir] = await sharp(inputBuffer).resize(size, size).png().toBuffer();
  }
  return result;
}

function findReferencedMp3Assets(...htmlValues) {
  const refs = new Set();
  const re = /["']([^"']+\.mp3)["']/gi;
  for (const html of htmlValues) {
    if (!html) continue;
    let match;
    while ((match = re.exec(html))) refs.add(path.basename(match[1]));
  }
  return refs;
}

function isVirtualOrAliasedMp3(name) {
  const n = String(name || '').toLowerCase();
  // big/small result sounds are intentionally spoken by Android TTS, not MP3.
  // loginw.mp3 is intentionally routed to bypass.mp3 in MainActivity.
  return n === 'big.mp3' || n === 'small.mp3' || n === 'loginw.mp3';
}

function logMissingReferencedMp3Assets(htmlValues, assetsDir, log) {
  const missing = [];
  for (const name of findReferencedMp3Assets(...htmlValues)) {
    if (isVirtualOrAliasedMp3(name)) continue;
    if (!fs.existsSync(path.join(assetsDir, name))) missing.push(name);
  }
  if (missing.length) {
    log(`WARNING: Missing MP3 asset(s): ${missing.join(', ')}. Related sounds will not play in the APK.`);
  }
}

// ── APK build implementation ──
// This implementation intentionally runs inside apkbuilder-worker.js. It uses
// synchronous filesystem/Gradle commands, which are safe in the isolated
// worker process and can no longer freeze the web server or Telegram polling.
async function buildApkInWorker(order, design, buildId, logCallback) {
  const log = (msg) => { logCallback && logCallback(msg); };
  const buildDir = path.join(BUILDS_DIR, buildId);
  fs.mkdirSync(buildDir, { recursive: true });

  try {
    log('Reading design HTML files...');

    // Use fake HTML if this is a fake build and design has fake_popup_html_file
    const isFakeBuild = !!(order.is_fake);
    const popupHtmlFileName = (isFakeBuild && design.fake_popup_html_file)
      ? design.fake_popup_html_file
      : design.popup_html_file;
    const popupHtmlPath = path.join(TEMPLATES_DIR, popupHtmlFileName);
    const db = require('../database/db');
    const loadingHtmlFileName = db.prepare('SELECT value FROM settings WHERE key=?').get('loading_html_file')?.value || 'loading.html';
    const loadingHtmlPath = path.join(TEMPLATES_DIR, loadingHtmlFileName);

    if (!fs.existsSync(popupHtmlPath))   throw new Error(`Popup HTML not found: ${design.popup_html_file}`);
    if (!fs.existsSync(loadingHtmlPath)) throw new Error(`Loading HTML not found: ${loadingHtmlFileName}. Upload it from admin Settings.`);

    const popupHtml   = fs.readFileSync(popupHtmlPath,   'utf8');
    const loadingHtml = fs.readFileSync(loadingHtmlPath, 'utf8');

    // ── Prepare icon ──
    let appIconBase64 = null;
    let iconBuffer    = null;
    if (order.icon_file) {
      const iconPath = path.join(UPLOADS_DIR, order.icon_file);
      if (fs.existsSync(iconPath)) {
        iconBuffer    = fs.readFileSync(iconPath);
        appIconBase64 = iconBuffer.toString('base64');
      }
    }

    const isDhani = design.java_type === 'dhani' || design.java_type === 'premium' || design.category === 'dhani';
    const { deposit: depositUrl, wingo: wingoUrl } = buildUrls(order.register_url, isDhani);
    const domain = extractDomain(order.register_url);
    // This path is embedded once and remains stable. URL values under
    // <firebasePath>/config can then change without rebuilding the APK.
    const firebasePath = order.firebase_path
      || `zayro${domain.replace(/[^a-z0-9]/gi, '').substring(0, 10)}`;
    const params = {
      registerUrl: order.register_url, depositUrl, wingoUrl, domain, firebasePath,
      minDeposit: order.min_deposit, brandTitle: order.brand_title,
      appIconBase64, isDhani
    };

    log('Injecting parameters into HTML...');
    const processedPopup   = injectThemeCss(injectParams(popupHtml, params), order.theme_color);
    const processedLoading = injectThemeCss(injectParams(loadingHtml, params), order.theme_color);

    // ── HARDENING: per-build unique key ──
    // Every APK gets its own random password. It protects both the HTML blobs
    // (PBKDF2) and every other asset (AES-256-GCM). The key is embedded XOR-
    // masked in the native library, never as a plain string.
    const buildPassword = generateBuildPassword();

    log('Encrypting HTML to .bin files...');
    const zayrobin      = path.join(buildDir, 'zayro.bin');
    const loadingBinName = isDhani ? 'lodale.bin' : 'loading.bin';
    const loadingbin    = path.join(buildDir, loadingBinName);
    await encryptHtmlToBin(processedPopup,   zayrobin, buildPassword);
    await encryptHtmlToBin(processedLoading, loadingbin, buildPassword);
    log('Bin files created.');

    // ── Check template project exists ──
    if (!fs.existsSync(TEMPLATE_PROJECT))
      throw new Error('Android project not found at android-project/. Upload via SCP.');

    // ── Copy template project ──
    log('Extracting base APK...');
    const projectDir = path.join(buildDir, 'project');
    execFileSync('cp', ['-r', TEMPLATE_PROJECT, projectDir], { stdio: 'pipe' });
    fs.chmodSync(path.join(projectDir, 'gradlew'), 0o755);
    fs.writeFileSync(path.join(projectDir, 'local.properties'), `sdk.dir=${ANDROID_HOME}\n`);

    // ── Patch strings.xml — app name ──
    const stringsPath = path.join(projectDir, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
    if (fs.existsSync(stringsPath)) {
      let s = fs.readFileSync(stringsPath, 'utf8');
      s = s.replace(/<string name="app_name"[^>]*>[^<]*<\/string>/, `<string name="app_name" translatable="false">${order.app_name}</string>`);
      fs.writeFileSync(stringsPath, s, 'utf8');
    }

    // ── Patch build.gradle — applicationId ──
    const gradlePath = path.join(projectDir, 'app', 'build.gradle');
    if (fs.existsSync(gradlePath)) {
      let g = fs.readFileSync(gradlePath, 'utf8');
      g = g.replace(/applicationId\s+"[^"]*"/, `applicationId "${order.package_name}"`);
      fs.writeFileSync(gradlePath, g, 'utf8');
    }

    // ── Copy assets (all encrypted with the per-build key) ──
    log('Replacing assets (encrypted)...');
    const assetsDir = path.join(projectDir, 'app', 'src', 'main', 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    // Wipe stale template .bin blobs — they were encrypted with an old fixed
    // key and would fail to decrypt against the per-build key at runtime.
    for (const f of fs.readdirSync(assetsDir)) {
      if (f.toLowerCase().endsWith('.bin')) {
        try { fs.unlinkSync(path.join(assetsDir, f)); } catch (_) {}
      }
    }
    fs.copyFileSync(zayrobin,   path.join(assetsDir, 'zayro.bin'));
    fs.copyFileSync(loadingbin, path.join(assetsDir, loadingBinName));
    // MainActivity always opens loading.bin (and some designs expect lodale.bin).
    // Write the same per-build encrypted blob under both names so the loading
    // screen decrypts correctly for zayro AND dhani builds.
    if (isDhani) fs.copyFileSync(loadingbin, path.join(assetsDir, 'loading.bin'));

    const sharedAssetsDir = path.join(TEMPLATES_DIR, 'assets');
    if (fs.existsSync(sharedAssetsDir)) {
      for (const f of fs.readdirSync(sharedAssetsDir)) {
        const src = path.join(sharedAssetsDir, f);
        if (fs.statSync(src).isFile())
          fs.copyFileSync(src, path.join(assetsDir, f));
      }
    }
    logMissingReferencedMp3Assets([processedPopup, processedLoading], assetsDir, log);

    // ── App icon replacement ──
    if (iconBuffer) {
      log('Resizing and replacing app icons...');
      const iconSizes = await resizeIcon(iconBuffer);
      for (const [dir, buf] of Object.entries(iconSizes)) {
        const iconDir = path.join(projectDir, 'app', 'src', 'main', 'res', dir);
        fs.mkdirSync(iconDir, { recursive: true });
        fs.writeFileSync(path.join(iconDir, 'ic_launcher.png'),       buf);
        fs.writeFileSync(path.join(iconDir, 'ic_launcher_round.png'), buf);
      }
      fs.writeFileSync(path.join(assetsDir, 'my_icon.png'), iconBuffer);
    }

    // Encrypt every non-.bin asset inside the project assets dir in place.
    // The .bin files are already encrypted (PBKDF2 layout) — the app's legacy
    // decryptor reads them straight from assets.
    for (const f of fs.readdirSync(assetsDir)) {
      const assetPath = path.join(assetsDir, f);
      if (!fs.statSync(assetPath).isFile()) continue;
      if (f.toLowerCase().endsWith('.bin')) continue;
      fs.writeFileSync(assetPath, encryptAsset(fs.readFileSync(assetPath), buildPassword));
    }
    log('All assets encrypted.');

    // ── HARDENING: per-build native library (key + integrity hash) ──
    // Burn the build-unique key and the expected signing-cert SHA-256 into the
    // native lib. If keytool is unavailable the cert hash is omitted and the
    // runtime integrity check is skipped (build never fails because of it).
    const keystorePath = path.join(__dirname, '..', 'keystore', 'release.keystore');
    const certHashHex = fs.existsSync(keystorePath)
      ? getKeystoreCertHash(keystorePath, 'zayro@123')
      : null;
    const nativeSrc = generateNativeLib({ password: buildPassword, certHashHex });
    const nativeLibPath = path.join(projectDir, 'app', 'src', 'main', 'cpp', 'native-lib.cpp');
    fs.mkdirSync(path.dirname(nativeLibPath), { recursive: true });
    fs.writeFileSync(nativeLibPath, nativeSrc, 'utf8');
    log(certHashHex ? 'Native hardening + integrity check embedded.' : 'Native hardening embedded (integrity check skipped — keytool unavailable).');

    // ── Gradle build ──
    log('Compiling APK package...');
    const buildEnv = {
      ...process.env,
      ANDROID_HOME,
      ANDROID_SDK_ROOT: ANDROID_HOME,
      PATH: `${process.env.PATH}:${ANDROID_HOME}/build-tools/34.0.0:${ANDROID_HOME}/platform-tools`
    };
    execFileSync('./gradlew', ['assembleRelease', '--no-daemon'], {
      stdio: 'pipe', cwd: projectDir, env: buildEnv, timeout: 360000
    });

    // ── Find output APK ──
    const releaseDir = path.join(projectDir, 'app', 'build', 'outputs', 'apk', 'release');
    const apkFiles   = fs.readdirSync(releaseDir).filter(f => f.endsWith('.apk'));
    if (!apkFiles.length) throw new Error('Gradle build succeeded but no APK found in output.');
    const builtApk = path.join(releaseDir, apkFiles[0]);

    // ── Sign APK ──
    log('Signing with keystore...');
    const signedApk    = path.join(buildDir, `${order.app_name.replace(/\s+/g, '_')}.apk`);

    if (fs.existsSync(keystorePath)) {
      const alignedApk = path.join(buildDir, `${buildId}_aligned.apk`);
      execFileSync('zipalign', ['-f', '4', builtApk, alignedApk], { stdio: 'pipe' });
      execFileSync('apksigner', [
        'sign',
        '--ks', keystorePath,
        '--ks-pass', 'pass:zayro@123',
        '--key-pass', 'pass:zayro@123',
        '--out', signedApk,
        alignedApk
      ], { stdio: 'pipe' });
      fs.unlinkSync(alignedApk);
      log('APK signed successfully.');
    } else {
      fs.copyFileSync(builtApk, signedApk);
      log('WARNING: No keystore. APK is unsigned.');
    }

    // ── Cleanup ──
    fs.rmSync(projectDir, { recursive: true, force: true });
    if (fs.existsSync(zayrobin))   fs.unlinkSync(zayrobin);
    if (fs.existsSync(loadingbin)) fs.unlinkSync(loadingbin);

    log('Build complete!');
    return { success: true, apkFile: path.basename(signedApk), apkPath: signedApk };

  } catch (err) {
    log(`ERROR: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Parent-process build queue ──
// Gradle is CPU/RAM intensive, so builds stay serialized as before. The key
// difference is that the blocking work now happens in a child process while
// the main Node.js event loop remains free to answer Telegram updates and HTTP.
const BUILD_WORKER_PATH = path.join(__dirname, 'apkbuilder-worker.js');
const BUILD_WORKER_TIMEOUT_MS = Math.max(
  60_000,
  parseInt(process.env.APK_BUILD_TIMEOUT_MS || '600000', 10) || 600_000
);
const pendingBuilds = [];
let buildRunning = false;

function appendOutput(current, chunk) {
  const MAX_OUTPUT = 16 * 1024;
  const combined = current + chunk.toString();
  return combined.length > MAX_OUTPUT ? combined.slice(-MAX_OUTPUT) : combined;
}

function runBuildWorker(order, design, buildId, logCallback) {
  return new Promise((resolve, reject) => {
    const child = fork(BUILD_WORKER_PATH, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, APK_BUILDER_WORKER: '1' }
    });

    let settled = false;
    let output = '';

    child.stdout?.on('data', chunk => { output = appendOutput(output, chunk); });
    child.stderr?.on('data', chunk => { output = appendOutput(output, chunk); });

    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      const forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      forceKillTimer.unref?.();
      finish(new Error(`APK build timed out after ${Math.round(BUILD_WORKER_TIMEOUT_MS / 60000)} minutes`));
    }, BUILD_WORKER_TIMEOUT_MS);
    timeout.unref?.();

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    }

    child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'log') {
        try { logCallback?.(message.message); }
        catch (error) { console.error('Build log callback error:', error.message); }
        return;
      }
      if (message.type === 'result') {
        finish(null, message.result);
      } else if (message.type === 'error') {
        finish(new Error(message.error || 'Unknown APK build worker error'));
      }
    });

    child.once('error', error => finish(error));
    child.once('exit', (code, signal) => {
      if (settled) return;
      const detail = output.trim();
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      finish(new Error(`APK build worker exited with ${reason}${detail ? `: ${detail}` : ''}`));
    });

    child.send({ type: 'build', order, design, buildId }, error => {
      if (error) finish(error);
    });
  });
}

function processBuildQueue() {
  if (buildRunning || pendingBuilds.length === 0) return;
  buildRunning = true;
  const job = pendingBuilds.shift();

  runBuildWorker(job.order, job.design, job.buildId, job.logCallback)
    .then(job.resolve, job.reject)
    .finally(() => {
      buildRunning = false;
      // Let the completed order enqueue its fake APK before the next normal
      // build starts, so real/fake pairs stay together.
      setImmediate(processBuildQueue);
    });
}

function buildApk(order, design, buildId, logCallback) {
  return new Promise((resolve, reject) => {
    const job = { order, design, buildId, logCallback, resolve, reject };
    if (order?.is_fake) pendingBuilds.unshift(job);
    else pendingBuilds.push(job);
    processBuildQueue();
  });
}

module.exports = { buildApk, buildApkInWorker, makePackageName };