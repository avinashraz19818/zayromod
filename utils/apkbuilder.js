const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sharp = require('sharp');
const { encryptHtmlToBin } = require('./encrypt');
const { extractDomain, buildUrls, injectParams } = require('./htmlprocessor');

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

// ── Main APK build function ──
async function buildApk(order, design, buildId, logCallback) {
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

    const { deposit: depositUrl, wingo: wingoUrl } = buildUrls(order.register_url);
    const domain      = extractDomain(order.register_url);
    const firebasePath = `zayro${domain.replace(/[^a-z0-9]/gi, '').substring(0, 10)}`;

    const isDhani = design.java_type === 'dhani' || design.java_type === 'premium' || design.category === 'dhani';
    const params = {
      registerUrl: order.register_url, depositUrl, wingoUrl, domain, firebasePath,
      minDeposit: order.min_deposit, brandTitle: order.brand_title,
      appIconBase64, isDhani
    };

    log('Injecting parameters into HTML...');
    const processedPopup   = injectParams(popupHtml,   params);
    const processedLoading = injectParams(loadingHtml, params);

    log('Encrypting HTML to .bin files...');
    const zayrobin      = path.join(buildDir, 'zayro.bin');
    const loadingBinName = isDhani ? 'lodale.bin' : 'loading.bin';
    const loadingbin    = path.join(buildDir, loadingBinName);
    await encryptHtmlToBin(processedPopup,   zayrobin);
    await encryptHtmlToBin(processedLoading, loadingbin);
    log('Bin files created.');

    // ── Check template project exists ──
    if (!fs.existsSync(TEMPLATE_PROJECT))
      throw new Error('Android project not found at android-project/. Upload via SCP.');

    // ── Copy template project ──
    log('Extracting base APK...');
    const projectDir = path.join(buildDir, 'project');
    execSync(`cp -r "${TEMPLATE_PROJECT}" "${projectDir}"`, { stdio: 'pipe' });
    execSync(`chmod +x "${projectDir}/gradlew"`,            { stdio: 'pipe' });
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

    // ── Copy assets ──
    log('Replacing assets...');
    const assetsDir = path.join(projectDir, 'app', 'src', 'main', 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.copyFileSync(zayrobin,   path.join(assetsDir, 'zayro.bin'));
    fs.copyFileSync(loadingbin, path.join(assetsDir, loadingBinName));

    const sharedAssetsDir = path.join(TEMPLATES_DIR, 'assets');
    if (fs.existsSync(sharedAssetsDir)) {
      for (const f of fs.readdirSync(sharedAssetsDir))
        fs.copyFileSync(path.join(sharedAssetsDir, f), path.join(assetsDir, f));
    }

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

    // ── Gradle build ──
    log('Compiling APK package...');
    const buildEnv = {
      ...process.env,
      ANDROID_HOME,
      ANDROID_SDK_ROOT: ANDROID_HOME,
      PATH: `${process.env.PATH}:${ANDROID_HOME}/build-tools/34.0.0:${ANDROID_HOME}/platform-tools`
    };
    execSync('./gradlew assembleRelease --no-daemon', {
      stdio: 'pipe', cwd: projectDir, env: buildEnv, timeout: 360000
    });

    // ── Find output APK ──
    const releaseDir = path.join(projectDir, 'app', 'build', 'outputs', 'apk', 'release');
    const apkFiles   = fs.readdirSync(releaseDir).filter(f => f.endsWith('.apk'));
    if (!apkFiles.length) throw new Error('Gradle build succeeded but no APK found in output.');
    const builtApk = path.join(releaseDir, apkFiles[0]);

    // ── Sign APK ──
    log('Signing with keystore...');
    const keystorePath = path.join(__dirname, '..', 'keystore', 'release.keystore');
    const signedApk    = path.join(buildDir, `${order.app_name.replace(/\s+/g, '_')}.apk`);

    if (fs.existsSync(keystorePath)) {
      const alignedApk = path.join(buildDir, `${buildId}_aligned.apk`);
      execSync(`zipalign -f 4 "${builtApk}" "${alignedApk}"`, { stdio: 'pipe' });
      execSync(
        `apksigner sign --ks "${keystorePath}" --ks-pass pass:zayro@123 --key-pass pass:zayro@123 --out "${signedApk}" "${alignedApk}"`,
        { stdio: 'pipe' }
      );
      fs.unlinkSync(alignedApk);
      log('APK signed successfully.');
    } else {
      fs.copyFileSync(builtApk, signedApk);
      log('WARNING: No keystore. APK is unsigned.');
    }

    // ── Cleanup ──
    execSync(`rm -rf "${projectDir}"`, { stdio: 'pipe' });
    if (fs.existsSync(zayrobin))   fs.unlinkSync(zayrobin);
    if (fs.existsSync(loadingbin)) fs.unlinkSync(loadingbin);

    log('Build complete!');
    return { success: true, apkFile: path.basename(signedApk), apkPath: signedApk };

  } catch (err) {
    log(`ERROR: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { buildApk, makePackageName };
