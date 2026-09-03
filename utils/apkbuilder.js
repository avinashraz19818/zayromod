const fs = require('fs');
const path = require('path');
const { execFileSync, fork } = require('child_process');
const sharp = require('sharp');
const { encryptHtmlToBin, FIXED_PASSWORD, generateBuildPassword } = require('./encrypt');
const crypto = require('crypto');
const { extractDomain, buildUrls, injectParams, isDhaniUrl } = require('./htmlprocessor');
const { applyFontStyle } = require('./fontstyles');

const BUILDS_DIR        = path.join(__dirname, '..', 'builds');
const TEMPLATE_PROJECT  = path.join(__dirname, '..', 'android-project');
const TEMPLATES_DIR     = path.join(__dirname, '..', 'templates');
const UPLOADS_DIR       = path.join(__dirname, '..', 'uploads');
const ANDROID_HOME      = process.env.ANDROID_HOME || '/opt/android-sdk';
const KEYSTORE_PASSWORD = String(process.env.KEYSTORE_PASSWORD || '');
const KEYSTORE_ALIAS    = String(process.env.KEYSTORE_ALIAS || 'zayro');

// ── Generate package name from app name ──
function makePackageName(appName, counter = 1) {
  const prefixes = ['com.app', 'com.client', 'com.service', 'com.pro', 'com.hub', 'com.portal', 'com.net', 'com.cloud'];
  const pfx = prefixes[Math.abs(counter || 0) % prefixes.length];
  let clean = String(appName || '').toLowerCase()
    .replace(/admin|panel|hack|mod|cheat|root|inject|trojan|fake/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 10) || 'client';
  if (/^[0-9]/.test(clean)) clean = 'app' + clean.substring(0, 7);
  return `${pfx}.${clean}${counter}`;
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

// ── Loading HTML intro cleanup ──
// Intro ab Java (MainActivity) se bajta hai — app khulte hi turant. Loading
// HTML ke andar koi audio logic nahi hona chahiye, warna double sound hota
// hai. Purane templates me jo INTRO SOUND snippet hai, use build time pe
// strip kar dete hain (idempotent).
function stripIntroSnippet(html) {
  if (!html) return html;
  // Intro ab JAVA se bajta hai — loading HTML me intro ka KOI bhi trigger
  // nahi hona chahiye (double sound ka sabse bada karan). Har type ka
  // intro trigger yahan strip hota hai:
  //   1. INTRO SOUND comment wala snippet (purane templates)
  //   2. koi bhi script jisme intro.mp3 play hota hai (ZAYRO.playSound ya
  //      new Audio) — chahe comment ho ya na ho
  //   3. <audio autoplay src="intro.mp3"> tags
  // Loading page ki apni (clock/progress wali) script safe rehti hai.
  let out = html
    .replace(/<script>\s*\/\*[\s\S]*?INTRO SOUND[\s\S]*?<\/script>/gi, '')
    .replace(/<script>((?!<\/script>)[\s\S])*?(?:ZAYRO\.playSound\s*\(\s*['"]intro\.mp3['"]|new Audio\s*\(\s*['"]intro\.mp3['"])((?!<\/script>)[\s\S])*?<\/script>/gi, '')
    .replace(/<audio[^>]*intro\.mp3[^>]*>/gi, '');
  return out;
}

// ── Loading HTML se Firebase details strip ──
// Loading.bin APK me embedded hota hai — usme Firebase SDK scripts /
// liveLinks script (API key, database URL, path) NAHI hona chahiye warna
// decrypt karne wale ko Firebase details mil jaati hain. Loading page ko
// inki zaroorat hai bhi nahi (wo sirf splash hai).
function stripFirebaseLiveScript(html) {
  if (!html) return html;
  return html
    .replace(/<script[^>]*src=["'][^"']*firebase-app-compat[^"']*["'][^>]*><\/script>/gi, '')
    .replace(/<script[^>]*src=["'][^"']*firebase-database-compat[^"']*["'][^>]*><\/script>/gi, '')
    .replace(/<script>\s*\(function\(\)\{\s*var livePath=[\s\S]*?<\/script>/gi, '');
}

function ensureAudioGate(html) {
  if (!html) return html;
  // Purana gate version strip karo (purane build se nikla template ho to)
  html = html.replace(/<script>[\s\S]*?ZAYRO AUDIO GATE[\s\S]*?<\/script>/gi, '');

  // Template ke firebase users path ka pata lagao (instant warning cache
  // ke liye). Pattern: rtdb.ref("xyz/users/"+phone) ya rtdb.ref('xyz/users/')
  let usersBase = '';
  const m = html.match(/rtdb\.ref\s*\(\s*["']([^"']*?)users\/[^"']*["']/i);
  if (m && m[1]) usersBase = m[1] + 'users';

  const snippet = [
    '<script>',
    '/* ZAYRO AUDIO GATE V6 — auto-injected at build time (template-agnostic) */',
    '(function(){',
    '  var __g={on:false, played:false, regOn:false, regAt:0, homeTicks:0, noFormTicks:0, homeForced:false};',
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
    '  /* ── DEPOSIT FLASH FIX ──',
    '     Bina login ke (login gate pass hone se pehle) template kabhi bhi',
    '     deposit/low screen nahi dikhayega — register page khulte waqt',
    '     deposit ka jhalak nahi aayega. Login ke baad sab normal. */',
    '  try{',
    '    if(typeof _goState==="function"){',
    '      var __gs=_goState;',
    '      window._goState=function(n){',
    '        /* low sirf tabhi block: logged-in nahi AUR home abhi settle',
    '           nahi hua (register page aane se pehle ka flash). Jis game',
    '           ke home pe balance section hi nahi hota, usme home stable',
    '           hote hi low/deposit allow — balance nahi dikha = 0. */',
    '        if(n==="low" && !__g.on && __g.homeTicks<4) return;',
    '        return __gs.apply(this,arguments);',
    '      };',
    '    }',
    '  }catch(e){}',
    '  /* Kuch templates setBalance me direct curState="low" karte hain',
    '     (bypass karke) — unhe bhi login se pehle rok do. */',
    '  try{',
    '    if(typeof setBalance==="function"){',
    '      var __sbl=setBalance;',
    '      window.setBalance=function(bal){',
    '        if(!__g.on && __g.homeTicks<4){',
    '          try{',
    '            if(typeof lastBalance!=="undefined") window.lastBalance=parseFloat(bal)||0;',
    '            if(typeof updateUI==="function") updateUI();',
    '          }catch(e){}',
    '          return;',
    '        }',
    '        return __sbl.apply(this,arguments);',
    '      };',
    '    }',
    '  }catch(e){}',
    '  /* ── INSTANT REGISTER WARNING ──',
    '     Firebase users list app khulte hi cache ho jati hai. Number type',
    '     karte hi warning TURANT dikhti hai (network wait nahi). */',
    '  var __umap=null, __uloaded=false;',
    '  function __loadUsers(){',
    '    try{',
    '      if(!__uloaded&&typeof rtdb==="object"&&rtdb&&rtdb.ref){',
    '        __uloaded=true;',
    '        rtdb.ref("' + usersBase + '").once("value").then(function(snap){',
    '          __umap={};',
    '          snap.forEach(function(ch){ __umap[ch.key]=true; });',
    '        }).catch(function(){ __umap={}; });',
    '      }',
    '    }catch(e){ __uloaded=true; }',
    '  }',
    '  __loadUsers();',
    '  try{',
    '    if(typeof checkAndWarn==="function"){',
    '      var __cw=checkAndWarn;',
    '      window.checkAndWarn=function(phone){',
    '        var p=String(phone||"").replace(/[^0-9]/g,"");',
    '        if(__umap!==null && p.length>=10){',
    '          /* instant — bina network wait ke */',
    '          if(__umap[p]===true){ try{hideWarnOverlay();}catch(e){} }',
    '          else { try{showWarnOverlay();}catch(e){} }',
    '          return;',
    '        }',
    '        __loadUsers();',
    '        try{ return __cw.apply(this,arguments); }catch(e){}',
    '      };',
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
        '      var isReg=hash.indexOf("register")>=0||href.indexOf("register")>=0||hash.indexOf("invitationcode")>=0||hash.indexOf("invitecode")>=0||href.indexOf("invitecode")>=0||href.indexOf("inviteCode")>=0;',
    '      var isLogin=hash.indexOf("login")>=0||href.indexOf("login")>=0;',
    '      /* ── CONTENT CHECK: kya page pe visible login/register form hai ── */',
    '      var hasForm=false;',
    '      try{',
    '        var ins=doc.querySelectorAll("input[type=tel],input[type=password],input[type=number],input[type=text],input[placeholder*=phone],input[placeholder*=Phone],input[placeholder*=mobile],input[placeholder*=Mobile],input[placeholder*=otp],input[placeholder*=OTP],input[placeholder*=code],input[name*=phone],input[name*=mobile],input[name*=user]");',
    '        for(var i=0;i<ins.length;i++){ var el=ins[i]; if(el.offsetWidth>0&&el.offsetHeight>0){ hasForm=true; break; } }',
    '      }catch(e){}',
    '      var loggedNow=__loggedIn(doc,win);',
    '      /* ── STUCK-REGISTER-URL FIX ──',
    '         Kuch games login ke baad bhi URL register wala hi rakhti hain.',
    '         Agar URL register/login hai PAR page pe form nahi hai to:',
    '         - logged-in signals hain → asal me HOME hai (turant)',
    '         - logged-in nahi hai → 6 tick (~5s) ki grace, phir HOME maano',
    '           (register page pe bina form ke itni der ka matlab home hi hai) */',
    '      var looksHome=false;',
    '      if((isReg||isLogin) && !hasForm){',
    '        if(loggedNow){ looksHome=true; }',
    '        else { __g.noFormTicks++; if(__g.noFormTicks>=6){ looksHome=true; } }',
    '      } else { __g.noFormTicks=0; }',
    '      var authMode=(isReg||isLogin) && !looksHome;',
    '      /* ── REGISTER PAGE ENTRY → register UI + 1 sec me register.mp3 ── */',
    '      if(authMode && isReg){',
    '        if(!__g.regOn){',
    '          __g.regOn=true;',
    '          var now=Date.now();',
    '          if(now - __g.regAt > 5000){ setTimeout(__playReg,1000); }',
    '          /* register page pe UI seedha auth/wait pe le jao — koi deposit',
    '             jhalak nahi */',
    '          try{ if(typeof _goState==="function" && window.curState!=="wait") _goState("wait"); }catch(e){}',
    '        }',
    '      } else { __g.regOn=false; }',
    '      /* ── HOME / AUTH SETTLE counters ── */',
    '      if(authMode){ __g.homeTicks=0; __g.homeForced=false; }',
    '      else { __g.homeTicks++; }',
    '      /* ── HOME MODE (user ka rule) ──',
    '         HOME khula hai:',
    '           - login/balance detect hua  → OPEN WINGO (setState home;',
    '             template khud route karega: balance>=min to home/wingo)',
    '           - balance detect NAHI hua  → home settle (4 tick ~3.2s) pe',
    '             DEPOSIT popup (_goState low) */',
    '      if(!authMode){',
    '        if(loggedNow){',
    '          if(!__g.on){',
    '            __g.on=true;',
    '            if(!__g.played){',
    '              __g.played=true;',
    '              try{ if(__origZ) __origZ.apply(window.ZAYRO,["successful.mp3"]); }catch(e){}',
    '            }',
    '          }',
    '          /* stuck-URL wale games me template ka setUrl kabhi nahi',
    '             chalta — yahan hum khud home pe le jaate hain */',
    '          if(window.curState==="wait" && !__g.homeForced){',
    '            __g.homeForced=true;',
    '            try{',
    '              if(typeof setState==="function"){ setState("home"); }',
    '              else if(typeof _goState==="function"){ _goState("home"); }',
    '            }catch(e){}',
    '          }',
    '        } else {',
    '          /* login nahi + balance nahi → settle hote hi DEPOSIT */',
    '          if(__g.homeTicks>=4 && window.curState==="wait" && !__g.homeForced){',
    '            __g.homeForced=true;',
    '            try{ if(typeof _goState==="function") _goState("low"); }catch(e){}',
    '          }',
    '        }',
    '      }',
    '      return;',
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
    log('Build started (' + (process.env.APK_BUILD_VARIANT || 'protectedRelease') + ')...');
    log('Reading design HTML files...');

    // Use fake HTML if this is a fake build and design has fake_popup_html_file
    const isFakeBuild = !!(order.is_fake || order.design_variant === 'fake');
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

    const isDhani = design.java_type === 'dhani' || design.java_type === 'premium' || design.category === 'dhani' || isDhaniUrl(order.register_url);
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
    const processedLoading = stripFirebaseLiveScript(stripIntroSnippet(injectParams(loadingHtml, params)));

    // ── PER-BUILD UNIQUE ENCRYPTION PASSWORD (Java engine) ──
    // Har APK build ki apni alag key: random password + kid. kid PATH ke
    // suffix (~<kid>) me DEX me jata hai — MainActivity source me koi nayi
    // line nahi chahiye. Template me FW placeholder na mile (purana/ustom
    // template) to automatic FIXED_PASSWORD fallback — purane builds jaisa
    // hi behaviour, koi regression nahi.
    let perBuildKid = '';
    let contentPassword = FIXED_PASSWORD;
    {
      const tplMain = path.join(TEMPLATE_PROJECT, 'app', 'src', 'main', 'java', 'com', 'zayro', 'wingsyttt', 'MainActivity.java');
      const tplSrc = fs.existsSync(tplMain) ? fs.readFileSync(tplMain, 'utf8') : '';
      if (tplSrc.includes('FW_PASSWORD_M = new byte[]{ 0, 0 }')) {
        perBuildKid = crypto.randomBytes(12).toString('hex');
        contentPassword = generateBuildPassword(); // base64 ASCII string
        log('Applying hardening profile...');
      } else {
        log('Applying standard profile...');
      }
    }

    // ── HTML encryption — per-build password (ya fixed fallback) ──
    // Baaki saare assets (PNG/MP3/fonts/icon) APK me PLAIN rehte hain.
    log('Encrypting HTML to .bin files...');
    const zayrobin      = path.join(buildDir, 'zayro.bin');
    const loadingBinName = isDhani ? 'lodale.bin' : 'loading.bin';
    const loadingbin    = path.join(buildDir, loadingBinName);
    await encryptHtmlToBin(processedPopup,   zayrobin, contentPassword);
    await encryptHtmlToBin(processedLoading, loadingbin, contentPassword);
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

    // ── Keystore (cert hash + signing dono yahi se) ──
    const keystorePath = path.join(__dirname, '..', 'keystore', 'release.keystore');
    // Production cert SHA-256 (security signature check ke liye)
    let certSha256Hex = '';
    if (fs.existsSync(keystorePath)) {
      try {
        const kt = execFileSync('keytool', ['-list', '-v', '-keystore', keystorePath, '-storepass', KEYSTORE_PASSWORD], { stdio: 'pipe', encoding: 'utf8' });
        const m = kt.match(/SHA256:\s*([0-9A-Fa-f:]+)/);
        if (m) certSha256Hex = m[1].replace(/:/g, '').toLowerCase();
      } catch (e) { certSha256Hex = ''; }
    }

    // ── Build variant — protectedRelease DEFAULT (fallback release) ──
    const buildVariantRaw = String(process.env.APK_BUILD_VARIANT || 'protectedRelease').trim();
    const buildVariant = /^[a-zA-Z0-9]+$/.test(buildVariantRaw) ? buildVariantRaw : 'release';
    const gradleTask = 'assemble' + buildVariant.charAt(0).toUpperCase() + buildVariant.slice(1);

    // ── Patch MainActivity.java — XOR-masked constants (remote HTML) ──
    // Server URL / content path / decrypt password DEX me plaintext NAHI
    // hote — XOR-mask hoke byte arrays me bhar diye jaate hain (0x5A key).
    // APK me koi Firebase detail nahi hoti. 360 Jiagu laga ho to DEX
    // encrypted hota hai — decompiler ko kuch nahi milta.
    const mainJavaPath = path.join(projectDir, 'app', 'src', 'main', 'java', 'com', 'zayro', 'wingsyttt', 'MainActivity.java');
    if (fs.existsSync(mainJavaPath)) {
      let j = fs.readFileSync(mainJavaPath, 'utf8');
      const serverBase = String(process.env.BASE_URL || 'https://devlopedwithzayro.site').replace(/\/+$/, '');
      const contentPath = String(order.firebase_path || '').trim();
      // kid ko PATH suffix (~kid) me laatkar bhejo — server isi se pehchan ke
      // is build ki apni key se encrypt karega. Purane APK (suffix ke bina)
      // FIXED_PASSWORD pe hi rehte hain — zero regression.
      const apkPath = perBuildKid ? (contentPath + '~' + perBuildKid) : contentPath;
      const XOR_KEY = 0x5A;
      const maskArr = (s) => 'new byte[]{ ' + Array.from(Buffer.from(String(s), 'utf8'))
        .map(b => `(byte)${(b ^ XOR_KEY) & 0xFF}`).join(', ') + ' }';
      j = j.replace('private static final byte[] APP_SERVER_URL_M = new byte[]{ 0, 0 };',
        `private static final byte[] APP_SERVER_URL_M = ${maskArr(serverBase)};`);
      j = j.replace('private static final byte[] APP_PATH_M = new byte[]{ 0, 0 };',
        `private static final byte[] APP_PATH_M = ${maskArr(apkPath)};`);
      j = j.replace('private static final byte[] FW_PASSWORD_M = new byte[]{ 0, 0 };',
        `private static final byte[] FW_PASSWORD_M = ${maskArr(contentPassword)};`);
      // SecurityManager constants (SecurityManager.java me patch hote hain)
      const secPath = path.join(path.dirname(mainJavaPath), 'SecurityManager.java');
      if (fs.existsSync(secPath)) {
        let s = fs.readFileSync(secPath, 'utf8');
        s = s.replace('private static final byte[] EXPECTED_CERT_SHA256_M = new byte[]{ 0, 0 };',
          `private static final byte[] EXPECTED_CERT_SHA256_M = ${certSha256Hex ? maskArr(certSha256Hex) : 'new byte[]{ 0, 0 }'};`);
        s = s.replace('private static final byte[] IS_PROTECTED_M = new byte[]{ 0 };',
          `private static final byte[] IS_PROTECTED_M = ${maskArr(buildVariant === 'protectedRelease' ? '1' : '0')};`);
        fs.writeFileSync(secPath, s, 'utf8');
      }
      fs.writeFileSync(mainJavaPath, j, 'utf8');

      // ── Per-build key record — server runtime encryption ke liye ──
      // key_secret plaintext base64 string (server ko runtime encrypt karna
      // hota hai isliye reversible), key_hash bcrypt (audit/verify ke liye).
      if (perBuildKid) {
        try {
          const bcrypt = require('bcryptjs');
          try {
            db.exec(`CREATE TABLE IF NOT EXISTS build_keys (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              order_id INTEGER NOT NULL,
              firebase_path TEXT NOT NULL,
              key_id TEXT UNIQUE NOT NULL,
              key_secret TEXT NOT NULL,
              active INTEGER NOT NULL DEFAULT 1,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
          } catch (_) {}
          try { db.exec("ALTER TABLE build_keys ADD COLUMN key_hash TEXT"); } catch (_) {}
          try { db.exec("ALTER TABLE build_keys ADD COLUMN engine TEXT NOT NULL DEFAULT 'flutter'"); } catch (_) {}
          db.prepare("INSERT INTO build_keys (order_id, firebase_path, key_id, key_secret, key_hash, engine) VALUES (?,?,?,?,?,'java')")
            .run(order.id, contentPath, perBuildKid, contentPassword, bcrypt.hashSync(contentPassword, 8));
          log('Hardening profile applied.');
        } catch (e) { log('NOTE: profile cache skipped — ' + String(e.message || e)); }
      }
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
    // POPUP HTML ab APK me embed NAHI hota — app runtime pe server se
    // encrypted HTML fetch karta hai (utils/appcontent.js). Isliye sirf
    // loading.bin embed hota hai (instant splash ke liye).
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

    // Sab assets PLAIN rehte hain (PNG/MP3/fonts/icon) — koi encryption nahi.
    // Sirf HTML .bin files encrypted hain (upar kiye hue). Purana simple style.
    log('Assets plain (sirf HTML .bin encrypted).');

    // ── INTEGRITY MANIFEST — har packaged asset ka SHA-256 ──
    // Runtime pe SecurityManager.verifyAssetIntegrity() in hashes ko check
    // karta hai — koi asset modify ho to detect hota hai. integrity.json
    // me sirf hashes hain, koi secret nahi.
    log('Generating integrity manifest...');
    {
      const crypto = require('crypto');
      const entries = {};
      for (const f of fs.readdirSync(assetsDir)) {
        const ap = path.join(assetsDir, f);
        if (!fs.statSync(ap).isFile()) continue;
        if (f === 'integrity.json') continue;
        entries[f] = crypto.createHash('sha256').update(fs.readFileSync(ap)).digest('hex');
      }
      fs.writeFileSync(path.join(assetsDir, 'integrity.json'),
        JSON.stringify({ version: 1, generatedAt: Date.now(), assets: entries }, null, 1));
    }

    // ── keystore upar define ho chuka (cert hash + signing dono ke liye) ──

    // ── Gradle build ──
    const buildEnv = {
      ...process.env,
      ANDROID_HOME,
      ANDROID_SDK_ROOT: ANDROID_HOME,
      PATH: `${process.env.PATH}:${ANDROID_HOME}/build-tools/34.0.0:${ANDROID_HOME}/platform-tools`
    };

    // STALE CACHE FIX: template me purana .gradle/app-build hota hai —
    // use hatao taaki Gradle clean build kare (isi se 'No APK found after
    // Gradle' aa raha tha — gradle up-to-date samajh kar output skip kar
    // deta tha).
    log('Cleaning stale gradle cache...');
    try { fs.rmSync(path.join(projectDir, '.gradle'), { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(path.join(projectDir, 'app', 'build'), { recursive: true, force: true }); } catch (e) {}

    const gradleArgs = [gradleTask, '--no-daemon', '--rerun-tasks'];
    if (process.env.APK_NATIVE_SECURITY === '1') gradleArgs.push('-PenableNativeSecurity');
    log(`Compiling APK package (${buildVariant})...`);
    let gradleError = null;
    let gradleOut = '';
    let usedVariant = buildVariant;
    const runGradle = (args) => {
      try {
        const r = execFileSync('./gradlew', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 16 * 1024 * 1024,
          cwd: projectDir, env: buildEnv, timeout: 480000
        });
        return { ok: true, out: String(r) };
      } catch (e) {
        return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') + String(e.message || '') };
      }
    };
    let g1 = runGradle(gradleArgs);
    gradleOut = g1.out;
    if (!g1.ok) {
      gradleError = new Error(g1.out.slice(-1500));
      if (buildVariant !== 'release') {
        log('Gradle ' + buildVariant + ' FAILED — release fallback try karte hain...');
        let g2 = runGradle(['assembleRelease', '--no-daemon', '--rerun-tasks']);
        gradleOut = g2.out;
        if (g2.ok) {
          usedVariant = 'release';
          log('Release fallback build OK.');
        } else {
          throw new Error('Gradle fail (' + buildVariant + ' + release fallback): ' + g2.out.slice(-2000));
        }
      } else {
        throw new Error('Gradle fail (release): ' + g1.out.slice(-2000));
      }
    } else {
      log('Gradle build OK.');
    }

    // ── Find output APK (poore project me kisi bhi .apk ko dhundo) ──
    const findApks = (dir) => {
      const out = [];
      if (!fs.existsSync(dir)) return out;
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        try {
          if (fs.statSync(fp).isDirectory()) out.push(...findApks(fp));
          else if (f.toLowerCase().endsWith('.apk')) out.push(fp);
        } catch (e) {}
      }
      return out;
    };
    // NOTE: release buildType me signingConfig NAHI hai — Gradle
    // 'app-release-unsigned.apk' deta hai (server khud apksigner se sign
    // karta hai, packers se pehle bhi). Isliye 'unsigned' APKs ko bhi
    // candidate maano — pehle wala filter unhe chhod raha tha, isi se
    // 'No APK found after Gradle' aata tha (BUILD SUCCESSFUL ke baad bhi).
    const apkCandidates = findApks(path.join(projectDir, 'app', 'build', 'outputs'))
      .filter(f => !f.toLowerCase().includes('unaligned'));
    // priority: signed > app-*.apk (signed name) > unsigned > koi bhi
    let builtApk = apkCandidates.find(f => f.toLowerCase().includes('signed'))
      || apkCandidates.find(f => /app-.*\.apk$/i.test(f) && !f.toLowerCase().includes('unsigned'))
      || apkCandidates.find(f => f.toLowerCase().includes('unsigned'))
      || apkCandidates[0];
    if (!builtApk) {
      const gmsg = gradleError ? String(gradleError.message).slice(0, 800) : 'unknown';
      const tail = gradleOut ? gradleOut.slice(-1500) : '(no gradle output)';
      const outs = findApks(path.join(projectDir, 'app', 'build', 'outputs'))
        .map(f => path.relative(projectDir, f)).join(', ') || '(outputs tree khali)';
      throw new Error('No APK found after Gradle. ' + gmsg + ' || outputs me mile: ' + outs + ' || gradle tail: ' + tail);
    }
    log('APK mila: ' + path.basename(builtApk));

    // ── PRE-SIGN — packers ko SIGNED input chahiye (Gradle unsigned deta
    // hai, isi se Frezrik 'packed output missing' de raha tha) ──
    let preSignedApk = builtApk;
    let preSignedOk = false;
    if (fs.existsSync(keystorePath)) {
      try {
        const preAligned = path.join(buildDir, `${buildId}_pre_aligned.apk`);
        preSignedApk = path.join(buildDir, `${buildId}_pre_signed.apk`);
        execFileSync('zipalign', ['-f', '4', builtApk, preAligned], { stdio: 'pipe' });
        execFileSync('apksigner', [
          'sign',
          '--ks', keystorePath,
          '--ks-pass', `pass:${KEYSTORE_PASSWORD}`,
          '--key-pass', `pass:${KEYSTORE_PASSWORD}`,
          '--v1-signing-enabled', 'true',
          '--v2-signing-enabled', 'true',
          '--v3-signing-enabled', 'true',
          '--v4-signing-enabled', 'false',
          '--out', preSignedApk,
          preAligned
        ], { stdio: 'pipe' });
        fs.unlinkSync(preAligned);
        preSignedOk = fs.existsSync(preSignedApk);
        if (preSignedOk) log('Pre-signed APK ready (packer input).');
      } catch (e) {
        preSignedApk = builtApk; preSignedOk = false;
      }
    }

    // ── FREZRIK JIAGU (open-source DEX packer — DEFAULT, no account) ──
    // Frezrik/Jiagu: app ka DEX AES-encrypt hoke shell dex ke andar chhup
    // jata hai. Decompile karne pe sirf shell dikhta hai — asli code kuch
    // nahi. Koi login nahi chahiye. pack.jar output/unsigned.apk banata
    // hai (khud sign fail ho jaye to bhi packed file aa jati hai) — phir
    // hum apne zipalign+apksigner se sign karte hain.
    let apkToSign = builtApk;
    let jiaguUsed = false;
    let frezrikUsed = false;
    if (process.env.FREZRIK_ENABLED !== 'false') {
      const frezrikJar = process.env.FREZRIK_JAR || '/opt/frezrik/pack.jar';
      if (fs.existsSync(frezrikJar) && fs.existsSync(keystorePath)) {
        let fzOut = '';
        try {
          log('Frezrik Jiagu: packing (DEX encrypt)...');
          // ── STALE WORKDIR FIX (permanent) ──
          // pack.jar apna kaam jar ke paas wale SHARED 'output/' folder me
          // karta hai (unzip/manifest/res/classes wahan bante hain). Agar
          // wahan purane build ka data bacha ho to naya APK purane
          // manifest + resources.arsc + assets ke saath MIX ho jata hai —
          // isi se naye APKs me '6CLUB ADMIN PANEL' label / purana package
          // / purana icon aa raha tha. Har build se pehle ye folder puri
          // tarah delete karo (manually rm karne ki zaroorat nahi).
          const fzSharedOut = path.join(path.dirname(frezrikJar), 'output');
          if (fs.existsSync(fzSharedOut)) {
            fs.rmSync(fzSharedOut, { recursive: true, force: true });
            log('Frezrik stale workdir cleared.');
          }
          // pack.jar apna final output cwd ke 'output/' folder me likhta
          // hai — wo folder KHUD NAHI banata (FileNotFoundException:
          // output/unsigned.apk). Isi se 'packed output missing' aa raha
          // tha. Folder pehle se bana do, phir run karo.
          const outDir = path.join(buildDir, 'output');
          fs.mkdirSync(outDir, { recursive: true });
          fzOut = String(execFileSync('java', [
            '-jar', frezrikJar,
            '-apk', preSignedApk,
            '-key', keystorePath,
            '-kp', KEYSTORE_PASSWORD,
            '-alias', process.env.FREZRIK_ALIAS || KEYSTORE_ALIAS,
            '-ap', KEYSTORE_PASSWORD
          ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: buildDir, timeout: 600000 }) || '');
          let packed = null;
          // Final output cwd/output me aata hai; fallback: pack.jar ke
          // paas waala output folder bhi check karo (kuch versions waha
          // intermediates likhte hain).
          const candidates = [outDir, path.join(path.dirname(frezrikJar), 'output')];
          for (const dir of candidates) {
            if (!packed && fs.existsSync(dir)) {
              const files = fs.readdirSync(dir).filter(f => f.endsWith('.apk'));
              const signed = files.find(f => f.endsWith('_signed.apk'));
              const unsigned = files.find(f => f === 'unsigned.apk');
              if (signed) packed = path.join(dir, signed);
              else if (unsigned) packed = path.join(dir, unsigned);
            }
          }
          if (packed && fs.existsSync(packed) && fs.statSync(packed).size > 1000) {
            // ── SAFETY NET: packed APK ka package sahi hona chahiye ──
            // Agar kahin se phir stale data ghus gaya to packed APK ka
            // package order ke package se MATCH nahi karega — tab packed
            // discard karke normal signing pe fallback hota hai (user ko
            // kabhi purana label/icon wala APK nahi milega).
            let packedOk = true;
            const wantPkg = String(order.package_name || '').trim();
            const aaptPath = path.join(ANDROID_HOME, 'build-tools', '34.0.0', 'aapt');
            if (wantPkg && fs.existsSync(aaptPath)) {
              try {
                const badging = execFileSync(aaptPath, ['dump', 'badging', packed],
                  { stdio: 'pipe', encoding: 'utf8', timeout: 60000 });
                const pm = badging.match(/package: name='([^']+)'/);
                if (pm && pm[1] !== wantPkg) {
                  packedOk = false;
                  log(`Frezrik verify FAIL: packed package '${pm[1]}' != expected '${wantPkg}' — packed discard.`);
                }
              } catch (e) {
                // aapt verify skip — clean ke baad risk minimal hai
              }
            }
            if (!packedOk) {
              const err = new Error(`stale package in packed output (expected ${wantPkg})`);
              err.fzOut = fzOut;
              throw err;
            }
            apkToSign = packed;
            frezrikUsed = true;
            if (path.basename(packed) === 'unsigned.apk') {
              log('Frezrik Jiagu: packed (unsigned) — apksigner se sign karenge...');
            } else {
              log('Frezrik Jiagu: packed — ab signing...');
            }
          } else {
            const err = new Error('packed output missing');
            err.fzOut = fzOut;
            throw err;
          }
        } catch (e) {
          apkToSign = preSignedOk ? preSignedApk : builtApk;
          const errDetail = (e && (e.fzOut || e.stderr || e.stdout)) ? String(e.fzOut || e.stderr || e.stdout).slice(-600) : '';
          log(`Frezrik Jiagu FAILED (${e.message})${errDetail ? ' | pack.jar output: ' + errDetail : ''} — fallback.`);
        }
      } else if (process.env.FREZRIK_ENABLED === 'true') {
        log(`Frezrik Jiagu: ENABLED par pack.jar/keystore nahi mila (${frezrikJar}). Normal build.`);
      }
    }

    // ── 360 JIAGU HARDENING (optional — JIAGU_ENABLED=true) ──
    // DEX encrypted + anti-tamper + string encryption. Jar + account chahiye
    // (jiagu.360.cn se download, .env me JIAGU_EMAIL/JIAGU_PASS/JIAGU_JAR).
    // 360 output khud signed hota hai (imported keystore se) — phir se sign
    // NAHI karte, warna protection toot jati hai. Jiagu fail ho to normal
    // signing fallback chal jata hai.
    if (process.env.JIAGU_ENABLED === 'true' && !frezrikUsed) {
      const jiaguJar = process.env.JIAGU_JAR || '/opt/jiagu/jiagu.jar';
      if (fs.existsSync(jiaguJar)) {
        try {
          log('360 Jiagu: hardening in progress...');
          const jiaguOut = path.join(buildDir, `${buildId}_jiagu_protected.apk`);
          const jiaguScript = path.join(__dirname, '..', 'scripts', 'jiagu-protect.sh');
          execFileSync('bash', [jiaguScript, jiaguJar, builtApk, jiaguOut, keystorePath, KEYSTORE_PASSWORD, KEYSTORE_ALIAS, KEYSTORE_PASSWORD], {
            stdio: 'pipe',
            timeout: 900000,
            env: {
              ...process.env,
              JIAGU_USER: process.env.JIAGU_EMAIL || process.env.JIAGU_USER || '',
              JIAGU_PASS: process.env.JIAGU_PASS || ''
            }
          });
          if (fs.existsSync(jiaguOut) && fs.statSync(jiaguOut).size > 1000) {
            apkToSign = jiaguOut;
            jiaguUsed = true;
            log('360 Jiagu: protected + signed.');
          } else {
            throw new Error('jiagu output missing');
          }
        } catch (e) {
          log(`360 Jiagu FAILED (${e.message}) — normal signing fallback.`);
        }
      } else {
        log(`360 Jiagu: JIAGU_ENABLED=true par jar nahi mila (${jiaguJar}). Normal build.`);
      }
    }

    // ── Sign APK ──
    // File name = app name (spaces/path-hostile chars -> _). Fake APKs ke
    // naam me "Fake 1", "Fake 2"... number hota hai — isliye HAR fake APK
    // ka filename UNIQUE hota hai (pehle sab "XYZ_Fake.apk" the, isi se
    // dono fake sites ka download ek hi APK de deta tha).
    const apkBase = String(order.app_name || 'App')
      .replace(/[\/\\:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'App';
    let signedApk = path.join(buildDir, `${apkBase}.apk`);
    // Double safety: same naam ki koi purani file folder me ho to number
    // laga do (kabhi collide nahi hona chahiye).
    let apkCounter = 2;
    while (fs.existsSync(signedApk) && apkCounter < 50) {
      signedApk = path.join(buildDir, `${apkBase}_${apkCounter++}.apk`);
    }

    if (jiaguUsed) {
      // 360 ne khud sign kar diya — wahi final hai
      fs.copyFileSync(apkToSign, signedApk);
      log('APK ready (360 protected).');
    } else if (preSignedOk && apkToSign === preSignedApk) {
      // Pre-signed already hai (packer fallback path) — wahi final
      fs.copyFileSync(preSignedApk, signedApk);
      log('APK ready (pre-signed).');
    } else if (fs.existsSync(keystorePath)) {
      log('Signing with keystore...');
      const alignedApk = path.join(buildDir, `${buildId}_aligned.apk`);
      // apkToSign = packed (Frezrik) ya plain builtApk — jo bhi ho, wahi sign
      execFileSync('zipalign', ['-f', '4', apkToSign, alignedApk], { stdio: 'pipe' });
      execFileSync('apksigner', [
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
      ], { stdio: 'pipe' });
      fs.unlinkSync(alignedApk);
      log('APK signed successfully.');
    } else {
      fs.copyFileSync(preSignedOk ? preSignedApk : builtApk, signedApk);
      log('WARNING: No keystore. APK is unsigned.');
    }

    // ── SECURITY REPORT + FINAL VERIFICATION ──
    // Build ke baad automatic checks + security-report.txt (buildDir me).
    // Critical fail → build FAIL (protectedRelease me).
    {
      const crypto = require('crypto');
      const report = { variant: buildVariant, appName: order.app_name, versionCode: 1, versionName: '1.0' };
      const fails = [];
      const warnings = [];

      // APK hash
      try { report.apkSha256 = crypto.createHash('sha256').update(fs.readFileSync(signedApk)).digest('hex'); } catch (e) {}
      report.certSha256 = certSha256Hex || 'unknown';

      // Signed?
      let signedOk = false;
      try {
        const aps = path.join(ANDROID_HOME, 'build-tools', '34.0.0', 'apksigner');
        if (fs.existsSync(aps)) execFileSync(aps, ['verify', '--print-certs', signedApk], { stdio: 'pipe' });
        else execFileSync('apksigner', ['verify', '--print-certs', signedApk], { stdio: 'pipe', env: buildEnv });
        signedOk = true;
      } catch (e) { signedOk = false; }
      report.signed = signedOk;
      if (!signedOk) fails.push('APK signed nahi hai');

      // Debuggable? (aapt badging)
      let debuggable = null;
      try {
        const aapt = path.join(ANDROID_HOME, 'build-tools', '34.0.0', 'aapt');
        const badging = execFileSync(aapt, ['dump', 'badging', signedApk], { stdio: 'pipe', encoding: 'utf8' });
        debuggable = badging.includes('application-debuggable');
        report.debuggable = debuggable;
        if (debuggable && buildVariant !== 'debug') fails.push('Release APK debuggable hai');
      } catch (e) { warnings.push('aapt unavailable — debuggable check skip'); }

      // Sensitive plaintext / source maps APK me?
      let sensitivePlain = false, hasSourceMaps = false;
      try {
        const listing = execFileSync('unzip', ['-l', signedApk], { stdio: 'pipe', encoding: 'utf8', env: buildEnv });
        if (/\.(html|js)\s*$/m.test(listing)) sensitivePlain = true;
        if (/\.map\s*$/m.test(listing)) hasSourceMaps = true;
      } catch (e) { warnings.push('unzip listing check skip'); }
      report.sensitivePlaintextInApk = sensitivePlain;
      report.sourceMapsInApk = hasSourceMaps;
      if (sensitivePlain && buildVariant === 'protectedRelease') fails.push('Sensitive plaintext (html/js) APK me hai');
      if (hasSourceMaps) fails.push('Source maps APK me hain');

      report.status = fails.length ? 'FAIL' : 'PASS';
      report.fails = fails; report.warnings = warnings;
      try {
        fs.writeFileSync(path.join(buildDir, 'security-report.txt'),
          JSON.stringify(report, null, 2) + '\n');
      } catch (e) {}
      log(`Security report: ${report.status}${fails.length ? ' — ' + fails.join('; ') : ''}${warnings.length ? ' | warn: ' + warnings.join('; ') : ''}`);
      // NOTE: verification sirf REPORT karta hai — kabhi build fail nahi
      // karta (tool-path issues se builds na rukein). Report buildDir me
      // security-report.txt hoti hai.
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

module.exports = { buildApk, buildApkInWorker, makePackageName, ensureAudioGate, normalizeRegisterDelay, stripIntroSnippet, stripFirebaseLiveScript };