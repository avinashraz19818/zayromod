'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// routecompat.js — UNIVERSAL ROUTE COMPAT (DhaniWin / 13l / path-routed games)
//
// PROBLEM
//   Zayro (hash-routed) games:      https://x.com/#/register?invitationCode=AB
//   DhaniWin / 13l (path-routed):   https://dhaniwin.cc/register?inviteCode=AB
//
//   Zyadatar design HTMLs route location.hash se detect karte hain — path-routed
//   site pe hash hamesha khali, isliye panel register/login/wingo detect nahi
//   karta. Device pe iframe ka location.href cross-origin fail bhi ho sakta
//   hai jabki contentDocument (DOM) read ho jata hai.
//
// FIX (template-agnostic, build-time auto-inject — design files untouched)
//   1. path-routed URL → hash-routed equivalent normalize
//   2. window.setUrl / aliases ko defineProperty interception se wrap
//   3. iframe watch: location.href mile to wahi, warna DOM features se route
//      sniff (register/login/wingo/wallet/home) → design ko push
//   4. stuck-register watchdog: balance aaya + design register/wait me atka
//      ho to synthetic HOME push
// ─────────────────────────────────────────────────────────────────────────────

const SHIM_MARKER = 'ZAYRO UNIVERSAL ROUTE COMPAT';

// Browser me chalne wala shim (sirf ES5). Node-side tests isi source ko vm me
// chala kar verify karte hain — jo test hota hai wahi ship hota hai.
const ROUTE_COMPAT_SOURCE = [
  '(function(){',
  '  if(window.__zayroRouteCompat) return;',
  "  var ALIASES=['setUrl','setRoute','updateRoute','setCurrentUrl','setCurrentRoute','reportUrl'];",
  "  var URL_KEYS=['url','href','currentUrl','currentURL','routeUrl','path'];",
  '  var SPLIT=/^([a-zA-Z][a-zA-Z0-9+.\\-]*:\\/\\/[^\\/?#]*)(\\/[^?#]*)?(\\?[^#]*)?(#[\\s\\S]*)?$/;',
  '',
  '  function normalizeRoute(raw){',
  '    try{',
  "      var s=String(raw==null?'':raw).trim();",
  '      if(!s) return raw;',
  '      var m=SPLIT.exec(s);',
  '      if(!m) return raw;',
  '      var origin=m[1]||"",path=m[2]||"",query=m[3]||"",hash=m[4]||"";',
  "      if(hash && hash.charAt(1)==='/') return raw;",
  '      var low=(path+" "+query).toLowerCase();',
  '      var route;',
  '      if(/register|signup|sign-up|invitecode|invitationcode/.test(low)) route="/register";',
  '      else if(/login|signin|sign-in/.test(low)) route="/login";',
  '      else if(/saaslottery|wingo|lottery/.test(low)) route="/saasLottery/WinGo?gameCode=WinGo_30S&lottery=WinGo";',
  '      else if(/wallet|recharge|deposit|withdraw/.test(low)) route="/wallet/Recharge";',
  '      else if(path==="/"||path==="") route="/home";',
  '      else route=path;',
  '      return origin+"/#"+route+(query||"");',
  '    }catch(e){ return raw; }',
  '  }',
  '',
  '  function normalizeArg(value){',
  '    try{',
  '      if(typeof value==="string") return normalizeRoute(value);',
  '      if(value && typeof value==="object"){',
  '        var copy={},changed=false,k;',
  '        for(k in value){ if(Object.prototype.hasOwnProperty.call(value,k)) copy[k]=value[k]; }',
  '        for(var i=0;i<URL_KEYS.length;i++){',
  '          k=URL_KEYS[i];',
  '          if(typeof copy[k]==="string" && copy[k]){',
  '            var n=normalizeRoute(copy[k]);',
  '            if(n!==copy[k]){ copy[k]=n; changed=true; }',
  '          }',
  '        }',
  '        return changed?copy:value;',
  '      }',
  '    }catch(e){}',
  '    return value;',
  '  }',
  '',
  '  function wrap(fn){',
  '    if(typeof fn!=="function"||fn.__zayroRouteWrapped) return fn;',
  '    var wrapped=function(){',
  '      var args=Array.prototype.slice.call(arguments);',
  '      if(args.length) args[0]=normalizeArg(args[0]);',
  '      return fn.apply(this,args);',
  '    };',
  '    wrapped.__zayroRouteWrapped=true;',
  '    wrapped.__zayroOriginal=fn;',
  '    return wrapped;',
  '  }',
  '',
  '  for(var a=0;a<ALIASES.length;a++){',
  '    (function(name){',
  '      try{',
  '        var stored=(typeof window[name]==="function")?window[name]:undefined;',
  '        Object.defineProperty(window,name,{',
  '          configurable:true,',
  '          enumerable:true,',
  '          get:function(){ return stored; },',
  '          set:function(v){ stored=wrap(v); }',
  '        });',
  '        if(stored) window[name]=stored;',
  '      }catch(e){}',
  '    })(ALIASES[a]);',
  '  }',
  '',
  '  function frameEl(){',
  '    try{',
  '      if(window.gameFrame&&window.gameFrame.tagName==="IFRAME") return window.gameFrame;',
  "      var ids=[window.__zayroFrameId,'target-game-frame','gameIframe','gameFrame'];",
  '      for(var i=0;i<ids.length;i++){ if(!ids[i]) continue; var el=document.getElementById(ids[i]); if(el) return el; }',
  "      return document.querySelector('iframe');",
  '    }catch(e){ return null; }',
  '  }',
  '',
  '  var lastPushed="";',
  '  function push(url,source){',
  '    if(!url) return;',
  '    var n=normalizeRoute(url);',
  '    if(!n||n===lastPushed) return;',
  '    if(typeof window.setUrl!=="function") return;',
  '    lastPushed=n;',
  '    try{ window.setUrl(n,{source:source||"zayro-route-compat"}); }catch(e){}',
  '  }',
  '',
  '  /* DOM ROUTE SNIFFER — location.href fail ho to page ke DOM features se */',
  '  function sniffRoute(fDoc){',
  '    try{',
  '      if(!fDoc||!fDoc.body) return null;',
  '      var txt="";',
  '      try{ txt=(fDoc.body.innerText||fDoc.body.textContent||"").toLowerCase(); }catch(e){}',
  "      var hasPhone=!!fDoc.querySelector(\"[type='tel'],[placeholder*='hone' i],[placeholder*='obile' i]\");",
  "      var hasPwd=!!fDoc.querySelector(\"[type='password']\");",
  "      var hasBet=!!fDoc.querySelector(\"[class*='bet'],[class*='lottery'],[class*='period']\");",
  '      if(hasBet&&/wingo|win ?go/.test(txt)) return "wingo";',
  '      if(hasPhone&&!hasBet){',
  '        if(hasPwd&&/log ?in|sign ?in/.test(txt)) return "login";',
  '        return "register";',
  '      }',
  '      if(/recharge|withdraw/.test(txt)) return "wallet";',
  '      if(hasPwd) return "login";',
  '      if(/featured|top games|promo|home/.test(txt)) return "home";',
  '      return null;',
  '    }catch(e){ return null; }',
  '  }',
  '  function originOf(){',
  '    try{',
  '      var m=String(typeof REGISTER_URL!=="undefined"?REGISTER_URL:"").match(/^https?:\\/\\/[^\\/?#]+/i);',
  '      if(m) return m[0];',
  '    }catch(e){}',
  '    return "";',
  '  }',
  '  function readFrame(){',
  '    try{',
  '      var gf=frameEl(); if(!gf) return;',
  '      var w=gf.contentWindow;',
  '      var href="";',
  '      try{ if(w&&w.location&&w.location.href) href=w.location.href; }catch(e){}',
  '      if(/^https?:/i.test(href)){ push(href,"frame-watch"); return; }',
  '      var fDoc=null;',
  '      try{ fDoc=gf.contentDocument||(w&&w.document); }catch(e){}',
  '      var kind=sniffRoute(fDoc);',
  '      if(!kind) return;',
  '      var base=originOf();',
  '      push((base?base+"/#/":"/#/")+kind,"dom-sniff");',
  '    }catch(e){}',
  '  }',
  '  function hookFrame(){',
  '    var gf=frameEl();',
  '    if(!gf||gf.__zayroCompatHooked) return;',
  '    gf.__zayroCompatHooked=true;',
  '    try{',
  '      gf.addEventListener("load",function(){ setTimeout(readFrame,60); });',
  '    }catch(e){}',
  '  }',
  '  try{',
  '    setInterval(function(){ hookFrame(); readFrame(); },900);',
  '    hookFrame();',
  '  }catch(e){}',
  '',
  '  /* STUCK-REGISTER WATCHDOG — balance aaya + design register/wait me atka',
  '     ho to synthetic HOME push (fallback jab DOM sniff bhi na chale) */',
  '  var _balSeen=false,_wdFired=false;',
  '  (function(name){',
  '    try{',
  '      var stored=(typeof window[name]==="function")?window[name]:undefined;',
  '      Object.defineProperty(window,name,{',
  '        configurable:true,enumerable:true,',
  '        get:function(){ return stored; },',
  '        set:function(v){',
  '          if(typeof v==="function"&&!v.__zayroBalWrapped){',
  '            var orig=v;',
  '            v=function(arg){',
  '              try{',
  '                var raw=(arg&&typeof arg==="object")?(arg.balance!==undefined?arg.balance:arg.amount):arg;',
  '                var n=Number(String(raw).replace(/,/g,""));',
  '                if(isFinite(n)) _balSeen=true;',
  '              }catch(e){}',
  '              return orig.apply(this,arguments);',
  '            };',
  '            v.__zayroBalWrapped=true;',
  '          }',
  '          stored=v;',
  '        }',
  '      });',
  '      if(stored) window[name]=stored;',
  '    }catch(e){}',
  '  })("setBalance");',
  '  setInterval(function(){',
  '    try{',
  '      if(!_balSeen||_wdFired) return;',
  '      var stuck=(window.isOnRegisterPage===true)',
  '        ||window._lastRouteKind==="register"||window._lastRouteKind==="login"',
  '        ||window.lastPageState==="wait"||window.currentState==="wait";',
  '      if(!stuck) return;',
  '      _wdFired=true;',
  '      var base=originOf();',
  '      var home=base?base+"/#/home":"#/home";',
  '      if(typeof window.setUrl==="function") window.setUrl(home,{source:"zayro-stuck-watchdog"});',
  '    }catch(e){}',
  '  },1500);',
  '',
  '  window.__zayroRouteCompat={normalize:normalizeRoute,push:push,wrap:wrap};',
  '})();'
].join('\n');

/**
 * Design HTML me route-compat shim inject karo (idempotent).
 * <head> ki shuruaat me jata hai taaki design ke apne scripts se PEHLE
 * window.setUrl interception install ho jaye.
 */
function injectRouteCompat(html) {
  if (!html) return html;
  if (html.indexOf(SHIM_MARKER) >= 0) return html;
  // Design khud bol de ki route-compat nahi chahiye (jaise fake scan-mode builds)
  if (html.indexOf('ZAYRO-NO-ROUTE-COMPAT') >= 0) return html;

  const script = `<script>\n/* ${SHIM_MARKER} — build-time auto-inject (DhaniWin / 13l path-routed support) */\n${ROUTE_COMPAT_SOURCE}\n</script>`;

  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + script);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => m + script);
  return script + html;
}

/**
 * Injected shim ko wapas hata do — sirf tests (ablation) ke liye.
 */
function stripRouteCompat(html) {
  if (!html) return html;
  return html.replace(/<script>\s*\/\* ZAYRO UNIVERSAL ROUTE COMPAT[\s\S]*?<\/script>/, '');
}

/**
 * Node-side wahi normalization (reference/tests ke liye).
 * Browser shim ke source ko vm me chala kar nikali gayi hai — logic ek hi hai.
 */
function createNodeNormalizer() {
  const vm = require('vm');
  const sandboxWindow = {};
  const sandbox = {
    window: sandboxWindow,
    document: { getElementById: () => null, querySelector: () => null },
    setInterval: () => 0,
    setTimeout: () => 0,
    Object,
    Array,
    String,
    Number,
    RegExp,
    isFinite
  };
  sandboxWindow.window = sandboxWindow;
  vm.createContext(sandbox);
  vm.runInContext(ROUTE_COMPAT_SOURCE, sandbox, { filename: 'routecompat-shim.js' });
  return sandboxWindow.__zayroRouteCompat;
}

let cachedCompat = null;
function normalizeRoute(url) {
  if (!cachedCompat) cachedCompat = createNodeNormalizer();
  return cachedCompat.normalize(url);
}

module.exports = { injectRouteCompat, stripRouteCompat, normalizeRoute, ROUTE_COMPAT_SOURCE, SHIM_MARKER };
