const fs = require('fs');

/**
 * Extract domain from register URL
 * e.g. https://www.ts777.co/#/register?invitationCode=123  → ts777.co
 */
function extractDomain(registerUrl) {
  try {
    const u = new URL(registerUrl);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return registerUrl.split('/')[2]?.replace(/^www\./, '') || '';
  }
}

/**
 * Build deposit/wingo URLs from register URL by replacing the hash path
 */
function buildUrls(registerUrl, isDhani = false) {
  let base;
  try {
    base = new URL(registerUrl).origin;
  } catch {
    base = registerUrl.split('#')[0].replace(/\/$/, '');
  }
  if (isDhani) {
    return {
      deposit: base + '/wallet/recharge',
      wingo: base + '/WinGo/WinGo_30S'
    };
  }
  return {
    deposit: base + '/#/wallet/Recharge',
    wingo: base + '/#/saasLottery/WinGo?gameCode=WinGo_30S&lottery=WinGo'
  };
}

/**
 * Inject all user params into HTML template
 * Handles both normal (zayro/wings) and dhani type HTMLs
 */
function sanitizeThemeColor(value) {
  const color = String(value || '').trim();
  if (!color || color.toLowerCase() === 'default') return '';
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : '';
}

function hexToRgb(hex) {
  const clean = sanitizeThemeColor(hex).slice(1);
  if (!clean) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

function injectThemeCss(htmlContent, themeColor) {
  const color = sanitizeThemeColor(themeColor);
  if (!color) return htmlContent;
  const rgb = hexToRgb(color);
  const rgbText = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
  const css = `<style id="zayro-theme-customizer">
:root{
  --zayro-theme:${color};--zayro-theme-rgb:${rgbText};
  --primary:${color}!important;--accent:${color}!important;--hot:${color}!important;--red:${color}!important;
  --red-main:${color}!important;--red-light:${color}!important;--crimson:${color}!important;--cyan:${color}!important;
  --neon:${color}!important;--a:${color}!important;--blue:${color}!important;--lime:${color}!important;
  --red-glow:rgba(${rgbText},.48)!important;--neon-glow:rgba(${rgbText},.55)!important;
  --grad-red:linear-gradient(135deg,${color},rgba(${rgbText},.72))!important;
  --grad-cyan:linear-gradient(135deg,${color},rgba(${rgbText},.72))!important;
  --grad-crimson:linear-gradient(135deg,${color},rgba(${rgbText},.72))!important;
}
#zayro-theme-preview-ribbon{position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:5px 9px;border-radius:999px;background:rgba(0,0,0,.55);color:${color};border:1px solid rgba(${rgbText},.55);font:700 10px/1 sans-serif;letter-spacing:.5px;pointer-events:none}
button,.btn,[class*="btn"],.card,.panel,[class*="panel"],[class*="card"],#miniBtn,#panel{border-color:rgba(${rgbText},.55)!important;box-shadow:0 0 18px rgba(${rgbText},.28)!important}
[class*="title"],[class*="brand"],[class*="live"],[class*="status"],.wo-head-title,.brand-name{color:${color}!important;text-shadow:0 0 12px rgba(${rgbText},.45)!important}
svg,path{stroke-color:${color}}
</style>`;
  let html = htmlContent;
  if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `${css}</head>`);
  else html = css + html;
  return html;
}

function injectParams(htmlContent, params) {
  const {
    registerUrl,
    depositUrl,
    wingoUrl,
    domain,
    firebasePath,
    minDeposit,
    brandTitle,
    appIconBase64,
    isDhani
  } = params;

  let html = htmlContent;

  // ── NORMALIZE GAME FRAME ──
  // Most uploaded designs already contain target-game-frame. A few (notably
  // Golden variants) navigate through a native bridge that is not available in
  // every Android template. Inject the same iframe contract automatically so
  // all designs use one reliable navigation/state pipeline.
  const hadGameFrame = /<iframe\b[^>]*\bid=["'](?:target-game-frame|gameIframe)["']/i.test(html);
  if (!hadGameFrame) {
    const frameCss = '<style id="zayro-auto-frame-style">#target-game-frame{position:fixed;inset:0;width:100%;height:100%;border:0;background:#000;z-index:0}</style>';
    const frameHtml = '<iframe id="target-game-frame" src="about:blank" allow="autoplay" title="Game"></iframe>';
    if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `${frameCss}</head>`);
    else html = frameCss + html;
    if (/<body\b[^>]*>/i.test(html)) html = html.replace(/<body\b[^>]*>/i, match => match + frameHtml);
    else html = frameHtml + html;
  }

  // ── REGISTER URL ──
  // Matches: REGISTER_URL="...", href="...", gameFrame.src="..."
  html = html.replace(
    /(var\s+REGISTER_URL\s*=\s*["'])([^"']+)(["'])/g,
    '$1$3'
  );
  // Cold-start assignments in templates sometimes contain a second hardcoded
  // register URL. Route every quoted http(s) cold-start URL through the same
  // live link so database updates also affect initial app loading.
  html = html.replace(
    /((?:gameFrame|gameIframe)\.src\s*=\s*["'])https?:\/\/[^"']+(["'])/g,
    '$1about:blank$2'
  );
  // Some Dhani templates put the initial URL directly on the iframe element.
  html = html.replace(
    /(<iframe\b[^>]*\bid=["'](?:target-game-frame|gameIframe)["'][^>]*\bsrc=["'])https?:\/\/[^"']+(["'])/gi,
    '$1about:blank$2'
  );

  // ── DEPOSIT URL ──
  html = html.replace(
    /(var\s+DEPOSIT_URL\s*=\s*["'])([^"']+)(["'])/g,
    '$1$3'
  );

  // ── WINGO URL ──
  html = html.replace(
    /(var\s+WINGO_URL\s*=\s*["'])([^"']+)(["'])/g,
    '$1$3'
  );

  // ── FIREBASE DB PATH (e.g. "zayroliveharsh", "zayrowingsbittu") ──
  // Extract current path prefix from HTML first
  const pathMatch = html.match(/rtdb\.ref\(["']([a-zA-Z0-9_]+)\/(config|users)/);
  const oldPrefix = pathMatch ? pathMatch[1] : null;

  if (oldPrefix && oldPrefix !== firebasePath) {
    // Replace only in rtdb.ref("oldPrefix/...") contexts
    // Match: rtdb.ref("oldPrefix/config") and rtdb.ref("oldPrefix/users/...)
    const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedOld = escapeRegex(oldPrefix);

    // Pattern: rtdb.ref("oldPrefix/
    html = html.replace(
      new RegExp(`(rtdb\\.ref\\(["'])${escapedOld}(\\/(?:config|users))`, 'g'),
      `$1${firebasePath}$2`
    );
  }

  // ── MIN DEPOSIT ──
  html = html.replace(
    /(var\s+(?:fbMinDeposit|minDeposit)\s*=\s*)(\d+)/g,
    `$1${minDeposit}`
  );
  // rechargeAmt span default content
  html = html.replace(
    /(<span\s+id=["']rechargeAmt["'][^>]*>)[^<]*/g,
    `$1&#8377;${minDeposit}`
  );

  // ── BRAND TITLE (popup card header) ──
  // Matches class="brand-name", class="card-title-line1", wo-head-title, etc.
  const brandSelectors = [
    /(<div[^>]+class=["'][^"']*brand-name[^"']*["'][^>]*>)[^<]*/g,
    /(<div[^>]+class=["'][^"']*card-title-line1[^"']*["'][^>]*>)[^<]*/g,
    /(<div[^>]+class=["'][^"']*wo-head-title[^"']*["'][^>]*>)[^<]*/g,
    /(<div[^>]+class=["'][^"']*wo-title["'][^>]*>)[^<]*/g,
    /(<title>)[^<]*/g
  ];
  brandSelectors.forEach(rx => {
    html = html.replace(rx, `$1${brandTitle}`);
  });

  // ── APP ICON (my_icon.png → base64 data URI embedded) ──
  if (appIconBase64) {
    // Replace src="my_icon.png" in both miniBtn img and anywhere
    html = html.replace(
      /src=["']my_icon\.png["']/g,
      `src="data:image/png;base64,${appIconBase64}"`
    );
  }

  // ── FIREBASE PLACEHOLDER FIX ──
  // Several uploaded designs contain Sketchware's unresolved secret marker.
  // Without a real web API key their original condition listener never starts,
  // so panel states/minimum-deposit changes cannot arrive from Firebase.
  html = html.replace(
    /@secret:GOOGLE_API_KEY/g,
    'AIzaSyDja5Gx4v4sMbx4BM2_od9_bLkdxdEY4do'
  );

  // ── FIREBASE LIVE LINKS ──
  // URLs are intentionally NOT stored in the APK or localStorage. The app
  // waits for <firebasePath>/config and always uses those Firebase values.
  let firebaseSdkScripts = '';
  if (!/firebase-app-compat\.js/i.test(html)) {
    firebaseSdkScripts += '<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>';
  }
  if (!/firebase-database-compat\.js/i.test(html)) {
    firebaseSdkScripts += '<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js"></script>';
  }
  const liveLinksScript = `${firebaseSdkScripts}<script>
(function(){
  var livePath=${JSON.stringify(firebasePath)};
  var autoFrameInjected=${hadGameFrame ? 'false' : 'true'};
  var gameFrame=window.gameFrame||document.getElementById('target-game-frame')||document.getElementById('gameIframe');
  if(gameFrame)window.gameFrame=gameFrame;
  var firebaseConfig={
    apiKey:'AIzaSyDja5Gx4v4sMbx4BM2_od9_bLkdxdEY4do',
    authDomain:'zayrodev-195f3.firebaseapp.com',
    projectId:'zayrodev-195f3',
    storageBucket:'zayrodev-195f3.firebasestorage.app',
    messagingSenderId:'357941061158',
    appId:'1:357941061158:web:12882185e2fa7f4f5328e7',
    databaseURL:'https://zayrodev-195f3-default-rtdb.firebaseio.com'
  };
  function valid(u){return typeof u==='string' && /^https?:\\/\\//i.test(u);}
  var firstFirebaseLinkLoad=true;
  function applyLinks(data){
    if(!data||typeof data!=='object')return;
    var previousRegister=REGISTER_URL;
    var nextRegister=data.registerUrl||data.register_url;
    var nextDeposit=data.depositUrl||data.deposit_url;
    var nextWingo=data.wingoUrl||data.wingo_url;
    if(!valid(nextRegister)||!valid(nextDeposit)||!valid(nextWingo))return;
    REGISTER_URL=nextRegister;
    DEPOSIT_URL=nextDeposit;
    WINGO_URL=nextWingo;
    if(typeof gameFrame!=='undefined'&&gameFrame){
      try{
        var current=gameFrame.src||'';
        // Assigning an empty src in a file:// WebView resolves to
        // file:///android_asset/, not about:blank. Always navigate once when
        // Firebase supplies the first valid link so LOCKED need not be tapped.
        if(firstFirebaseLinkLoad||!current||current==='about:blank'||current===previousRegister){
          gameFrame.src=REGISTER_URL;
        }
      }catch(e){}
    }
    if(firstFirebaseLinkLoad&&typeof window.setUrl==='function'){
      try{window.setUrl(REGISTER_URL);}catch(e){}
    }
    firstFirebaseLinkLoad=false;
  }
  // Designs without their own iframe used native openUrl/navigate methods.
  // Normalize navTo so their buttons also navigate the injected game frame.
  if(autoFrameInjected&&gameFrame){
    window.navTo=function(url){
      if(!valid(url))return;
      gameFrame.src=url;
      if(typeof window.setUrl==='function')try{window.setUrl(url);}catch(e){}
      if(typeof window.reportArea==='function')try{window.reportArea();}catch(e){}
    };
  }
  // Track auth routes outside the cross-origin iframe. Balance callbacks can
  // arrive while Register/Login is open; they must not switch the panel to
  // LOW/RECHARGE until the user actually leaves the auth page.
  window.__zayroAuthRoute=false;
  if(typeof window.setUrl==='function'&&!window.setUrl.__zayroWrapped){
    var originalSetUrl=window.setUrl;
    var wrappedSetUrl=function(url){
      var lower=(url||'').toString().toLowerCase();
      window.__zayroAuthRoute=lower.indexOf('/register')>=0||lower.indexOf('invitationcode')>=0||lower.indexOf('invitecode')>=0||lower.indexOf('/login')>=0;
      var result=originalSetUrl.apply(this,arguments);
      if(window.__zayroAuthRoute&&typeof window.setState==='function'){
        try{window.setState('wait');}catch(e){}
      }
      return result;
    };
    wrappedSetUrl.__zayroWrapped=true;
    window.setUrl=wrappedSetUrl;
  }
  if(typeof window.setBalance==='function'&&!window.setBalance.__zayroWrapped){
    var originalSetBalance=window.setBalance;
    var wrappedSetBalance=function(balance){
      if(window.__zayroAuthRoute){
        if(typeof window.setState==='function')try{window.setState('wait');}catch(e){}
        return;
      }
      return originalSetBalance.apply(this,arguments);
    };
    wrappedSetBalance.__zayroWrapped=true;
    window.setBalance=wrappedSetBalance;
  }
  if(gameFrame&&!gameFrame.__zayroLoadReporter){
    gameFrame.__zayroLoadReporter=true;
    gameFrame.addEventListener('load',function(){
      try{if(typeof window.setUrl==='function')window.setUrl(gameFrame.src||'');}catch(e){}
    });
  }
  var attempts=0,connected=false;
  function connect(){
    if(connected)return;
    try{
      if((typeof rtdb==='undefined'||!rtdb)&&typeof firebase!=='undefined'){
        var app=firebase.apps&&firebase.apps.length?firebase.app():firebase.initializeApp(firebaseConfig);
        rtdb=app.database?app.database():firebase.database();
      }
      if(typeof rtdb!=='undefined'&&rtdb&&typeof rtdb.ref==='function'){
        connected=true;
        rtdb.ref(livePath+'/config').on('value',function(snap){
          if(snap&&snap.exists())applyLinks(snap.val());
        });
        return;
      }
    }catch(e){}
    if(++attempts<120)setTimeout(connect,250);
  }
  connect();
})();
</script>`;
  if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `${liveLinksScript}</body>`);
  else html += liveLinksScript;

  return html;
}

module.exports = { extractDomain, buildUrls, injectParams, injectThemeCss, sanitizeThemeColor };