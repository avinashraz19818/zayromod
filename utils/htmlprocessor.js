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
})();
</script>`;
  if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `${liveLinksScript}</body>`);
  else html += liveLinksScript;

  return html;
}

module.exports = { extractDomain, isDhaniUrl, buildUrls, injectParams };
