const fs = require('fs');
const path = require('path');
const { execFileSync, fork } = require('child_process');
const sharp = require('sharp');
const { encryptHtmlToBin, encryptAsset, generateBuildPassword, generateNativeLib, getKeystoreCertHash } = require('./encrypt');
const { extractDomain, buildUrls, injectParams } = require('./htmlprocessor');
const { applyFontStyle } = require('./fontstyles');

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

// ── Intro sound auto-injection ──
// Loading page (loading HTML) ko build time pe intro sound guarantee karte
// hain: agar loading HTML me pehle se intro/playSound logic nahi hai to hum
// khud snippet inject kar dete hain. Java side koi sound nahi bajata, isliye
// double play nahi hota. Agar file me pehle se intro logic hai to use waise
// hi chhod dete hain (MainActivity ka same-sound guard double play rokta hai).
function ensureIntroSnippet(html) {
  if (!html) return html;
  const hasIntro = /intro\.mp3/i.test(html) && /playSound/i.test(html);
  if (hasIntro) return html;
  const snippet = '\n<script>\n' +
    '/* AUTO-INJECTED by apkbuilder: intro sound on loading page */\n' +
    'try{\n' +
    "  if (window.ZAYRO && typeof window.ZAYRO.playSound === 'function') {\n" +
    "    window.ZAYRO.playSound('intro.mp3');\n" +
    '  } else {\n' +
    "    var _zayroIntroA=new Audio('intro.mp3');\n" +
    '    var _zayroIntroP=_zayroIntroA.play();\n' +
    '    if(_zayroIntroP&&_zayroIntroP.catch)_zayroIntroP.catch(function(){});\n' +
    '  }\n' +
    '}catch(e){}\n' +
    '</script>\n';
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, snippet + '</body>');
  return html + snippet;
}

// ── Audio gate v3 (template-agnostic, auto-injected at build time) ──
// Har design (purana/naya upload) ke popup HTML me ye snippet inject hota
// hai. Ye do kaam karta hai:
//
//  1) REGISTER AUDIO TIMING — gate khud register page ENTER hote hi 1 sec
//     me register.mp3 bajata hai (template ke 3-5 sec delay ki jagah).
//     Template ke delayed register calls 10 sec tak block rehte hain taaki
//     double play na ho. Agar gate ka iframe watch fail ho jaye to template
//     ka apna delay fallback ki tarah kaam karta hai.
//
//  2) HOME AUDIO LOGIN GATE — jab tak site ka REAL logged-in state confirm
//     nahi hota (localStorage token / balance elements / header me 10-digit
//     number), tab tak successful/lowbalance/deposit/low_deposit BLOCK
//     rehte hain. Confirm hote hi gate khud successful.mp3 ek baar bajata
//     hai — app restart ki zaroorat nahi.
function ensureAudioGate(html) {
  if (!html) return html;
  // Purana gate version strip karo (purane build se nikla template ho to)
  html = html.replace(/<script>[\s\S]*?ZAYRO AUDIO GATE[\s\S]*?<\/script>/gi, '');
  const snippet = [
    '<script>',
    '/* ZAYRO AUDIO GATE V3 — auto-injected at build time (template-agnostic) */',
    '(function(){',
    '  var __g={on:false, played:false, regOn:false, regAt:0};',
    '  function __blocked(f){',
    '    var n=String(f||"").toLowerCase();',
    '    return n.indexOf("successful")>=0||n.indexOf("lowbalance")>=0||n.indexOf("low_deposit")>=0||n.indexOf("deposit")>=0;',
    '  }',
    '  function __ok(f){',
    '    var n=String(f||"").toLowerCase();',
    '    if(n.indexOf("register")>=0){',
    '      /* Gate khud register timing handle karta hai — template ka delayed',
    '         call duplicate hota hai to 10 sec window me block */',
    '      var now=Date.now();',
    '      if(now - __g.regAt < 10000) return false;',
    '      return true;',
    '    }',
    '    return !__blocked(f) || __g.on;',
    '  }',
    '  var __origZ=null;',
    '  try{',
    '    if(window.ZAYRO&&typeof window.ZAYRO.playSound==="function"){',
    '      __origZ=window.ZAYRO.playSound;',
    '      window.ZAYRO.playSound=function(f){ if(!__ok(f))return; return __origZ.apply(window.ZAYRO,arguments); };',
    '    }',
    '  }catch(e){}',
    '  try{',
    '    if(typeof playAudio==="function"){',
    '      var __op=playAudio;',
    '      window.playAudio=function(f){ if(!__ok(f))return; return __op.apply(this,arguments); };',
    '    }',
    '  }catch(e){}',
    '  function __playReg(){',
    '    try{ if(__origZ){ __g.regAt=Date.now(); __origZ.apply(window.ZAYRO,["register.mp3"]); } }catch(e){}',
    '  }',
    '  var __sel=[".amount .a1 .a",".gameHeader__C-balance",".Wallet__C-balance-l1",".walletInfo__C-balance",".headerInfo__C-right",".header__money",".header-money",".top-bar__balance",".userInfo__C-balance",".balance-amount",".my-amount",".balance",".wallet-amount"];',
    '  function __hasDigits(t){ return /[0-9]/.test(String(t||"")); }',
    '  function __loggedIn(doc,win){',
    '    // 1) localStorage me token/auth/user keys (sabse strong signal)',
    '    try{',
    '      var ls=win.localStorage;',
    '      if(ls&&ls.length){',
    '        for(var i=0;i<ls.length;i++){',
    '          var k=""; try{k=ls.key(i);}catch(e){}',
    '          if(/token|auth|user|login|account|session|member/i.test(k)) return true;',
    '        }',
    '      }',
    '    }catch(e){}',
    '    // 2) balance elements — site ye sirf logged-in user ko dikhati hai',
    '    try{',
    '      for(var j=0;j<__sel.length;j++){',
    '        var el=doc.querySelector(__sel[j]);',
    '        if(el){',
    '          var t=(el.innerText||el.textContent||el.getAttribute("data-amount")||el.getAttribute("data-balance")||"");',
    '          if(__hasDigits(t)) return true;',
    '        }',
    '      }',
    '    }catch(e){}',
    '    // 3) user-info/header me 10-digit phone number',
    '    try{',
    '      var h=doc.querySelector(".userInfo, .user-info, .headerInfo, [class*=user-info], [class*=userInfo], [class*=avatar], .my__info");',
    '      if(h){ var ht=(h.innerText||h.textContent||""); if(/\b[6-9][0-9]{9}\b/.test(ht)) return true; }',
    '    }catch(e){}',
    '    return false;',
    '  }',
    '  setInterval(function(){',
    '    try{',
    '      var fr=document.getElementById("target-game-frame");',
    '      if(!fr){var fs=document.getElementsByTagName("iframe"); if(fs.length)fr=fs[0];}',
    '      if(!fr||!fr.contentWindow) return;',
    '      var win=fr.contentWindow, doc=null;',
    '      try{ doc=fr.contentDocument||win.document; }catch(e){ return; }',
    '      if(!doc) return;',
    '      var href="";',
    '      try{ href=win.location.href; }catch(e){ return; }',
    '      if(!href||href==="about:blank") return;',
    '      var hash=(href.split("#")[1]||"").toLowerCase();',
    '      var isReg=hash.indexOf("register")>=0||href.indexOf("register")>=0||hash.indexOf("invitationcode")>=0||hash.indexOf("invitecode")>=0;',
    '      var isLogin=hash.indexOf("login")>=0||href.indexOf("login")>=0;',
    '      /* ── REGISTER PAGE ENTRY → 1 sec me register.mp3 ── */',
    '      if(isReg && !__g.regOn){',
    '        __g.regOn=true;',
    '        var now=Date.now();',
    '        if(now - __g.regAt > 5000){ setTimeout(__playReg,1000); }',
    '      }',
    '      if(!isReg) __g.regOn=false;',
    '      /* ── LOGIN GATE ── */',
    '      var isAuth=isReg||isLogin;',
    '      if(isAuth) return;',
    '      if(__loggedIn(doc,win)){',
    '        if(!__g.on){',
    '          __g.on=true;',
    '          if(!__g.played){',
    '            __g.played=true;',
    '            try{ if(__origZ) __origZ.apply(window.ZAYRO,["successful.mp3"]); }catch(e){}',
    '          }',
    '        }',
    '      }',
    '    }catch(e){}',
    '  },800);',
    '})();',
    '</script>',
    ''
  ].join('\n');
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, snippet + '</body>');
  return html + snippet;
}

// ── Register delay normalizer (future templates ke liye bhi) ──
// Naye upload hone wale templates me bhi register.mp3 ka 3-5 sec delay ho
// sakta hai. Build time pe hi har pattern ko 1000ms kar dete hain, taaki
// admin ko har naye design ke liye khud patch na karna pade. (Gate v3 khud
// bhi 1 sec pe register.mp3 bajata hai; ye fallback path ke liye hai.)
function normalizeRegisterDelay(html) {
  if (!html) return html;
  // ; } ke beech space/newline kuch bhi ho — \s* sab cover karta hai
  return html.replace(/(playAudio\(['"]register\.mp3['"]\);\s*\},)\s*(?:5000|3000)\s*\);/g, '$1 1000);');
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
    const processedPopup   = normalizeRegisterDelay(ensureAudioGate(injectParams(popupHtml, params)));
    const processedLoading = ensureIntroSnippet(injectParams(loadingHtml, params));

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

    // ── Patch strings.xml — app name (font style ke saath) ──
    // Sirf launcher label (phone ke home screen wala naam) styled hota hai.
    // App ke ANDAR wala HTML/templates isse bilkul untouched rehta hai.
    const stringsPath = path.join(projectDir, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
    if (fs.existsSync(stringsPath)) {
      let s = fs.readFileSync(stringsPath, 'utf8');
      const rawName = String(order.app_name || 'App');
      const styledName = applyFontStyle(rawName, order.app_name_style || 'normal');
      const xmlEsc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      s = s.replace(/<string name="app_name"[^>]*>[^<]*<\/string>/, `<string name="app_name" translatable="false">${xmlEsc(styledName)}</string>`);
      fs.writeFileSync(stringsPath, s, 'utf8');
    }

    // ── Patch build.gradle — applicationId ──
    const gradlePath = path.join(projectDir, 'app', 'build.gradle');
    if (fs.existsSync(gradlePath)) {
      let g = fs.readFileSync(gradlePath, 'utf8');
      g = g.replace(/applicationId\s+"[^"]*"/, `applicationId "${order.package_name}"`);
      fs.writeFileSync(gradlePath, g, 'utf8');
    }

    // ── Copy assets (PNGs/fonts encrypted per-build, MP3s stay plain) ──
    log('Replacing assets (encrypted, MP3s plain)...');
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

    // Encrypt every non-.bin asset inside the project assets dir in place,
    // EXCEPT MP3s. MP3s stay PLAIN inside the APK so MediaPlayer plays them
    // straight from assets with zero encrypt/decrypt handling. (.bin files
    // are already encrypted with the PBKDF2 layout — the app's legacy
    // decryptor reads them directly.)
    for (const f of fs.readdirSync(assetsDir)) {
      const assetPath = path.join(assetsDir, f);
      if (!fs.statSync(assetPath).isFile()) continue;
      const lower = f.toLowerCase();
      if (lower.endsWith('.bin') || lower.endsWith('.mp3')) continue;
      fs.writeFileSync(assetPath, encryptAsset(fs.readFileSync(assetPath), buildPassword));
    }
    log('Assets encrypted (MP3s left plain).');

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