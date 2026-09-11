'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// routecompat.js — UNIVERSAL ROUTE COMPAT (DhaniWin / 13l / path-routed games)
//
// PROBLEM
//   Zayro (hash-routed) games:      https://x.com/#/register?invitationCode=AB
//   DhaniWin / 13l (path-routed):   https://dhaniwin.cc/register?inviteCode=AB
//                                   https://13l.co/WinGo/WinGo_30S
//
//   Zyadatar design HTMLs route aise detect karte hain:
//       var hash = url.split('#')[1] || '';
//       isOnRegisterPage = hash.indexOf('/register') >= 0;
//   Path-routed site pe hash HAMESHA khali rehta hai — isliye panel kabhi
//   register / login / wingo state me nahi jata (register sound nahi bajta,
//   login monitor start nahi hota, wingo prediction nahi dikhta).
//
//   Purana fix htmlprocessor.js ke 4 narrow regex tha jo sirf 2 purane
//   minified patterns se match karte the — naya upload kiya hua design
//   (jaise AIT) unme fit nahi hota, isliye DhaniWin/13l pe toot jata tha.
//
// FIX (template-agnostic)
//   Build time pe har design ke <head> me ek chhota shim inject hota hai jo:
//     1. kisi bhi path-routed URL ko uske hash-routed equivalent me badalta
//        hai  ( /register?inviteCode=AB  →  /#/register?inviteCode=AB )
//     2. window.setUrl (+ common aliases) ko automatically wrap karta hai —
//        design baad me jo bhi implementation assign kare, wo wrapped hi
//        milegi (Object.defineProperty setter interception)
//     3. game iframe ko watch karke route change design ko report karta hai
//        (jin designs me apna poller nahi hota unke liye fallback)
//
//   Hash-routed designs pe ye no-op hai: '#/' wale URL waise hi pass hote
//   hain, isliye purane builds ka behaviour bilkul nahi badalta.
// ─────────────────────────────────────────────────────────────────────────────

const SHIM_MARKER = 'ZAYRO UNIVERSAL ROUTE COMPAT';

// Browser me chalne wala shim. Sirf ES5 — purane Android WebView ke liye.
// NOTE: yehi source Node-side tests me bhi execute hota hai, isliye jo logic
// test hota hai wahi ship hota hai.
const ROUTE_COMPAT_SOURCE = [
  '(function(){',
  '  if(window.__zayroRouteCompat) return;',
  "  var ALIASES=['setUrl','setRoute','updateRoute','setCurrentUrl','setCurrentRoute','reportUrl'];",
  "  var URL_KEYS=['url','href','currentUrl','currentURL','routeUrl','path'];",
  '  var SPLIT=/^([a-zA-Z][a-zA-Z0-9+.\\-]*:\\/\\/[^\\/?#]*)(\\/[^?#]*)?(\\?[^#]*)?(#[\\s\\S]*)?$/;',
  '',
  '  /* path-routed URL → hash-routed equivalent (hash-routed URL untouched) */',
  '  function normalizeRoute(raw){',
  '    try{',
  "      var s=String(raw==null?'':raw).trim();",
  '      if(!s) return raw;',
  '      var m=SPLIT.exec(s);',
  '      if(!m) return raw;',
  '      var origin=m[1]||"",path=m[2]||"",query=m[3]||"",hash=m[4]||"";',
  "      if(hash && hash.charAt(1)==='/') return raw;   /* already #/… */",
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
  '  /* Design baad me window.setUrl assign karta hai — setter interception se',
  '     har implementation (assignment ho ya top-level function declaration)',
  '     automatically wrap ho jati hai. */',
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
  '  /* ── iframe route watcher (fallback for designs without their own poller) ── */',
  '  var lastPushed="";',
  '  function frameEl(){',
  '    try{',
  '      if(window.gameFrame&&window.gameFrame.tagName==="IFRAME") return window.gameFrame;',
  "      var ids=[window.__zayroFrameId,'target-game-frame','gameIframe','gameFrame'];",
  '      for(var i=0;i<ids.length;i++){ if(!ids[i]) continue; var el=document.getElementById(ids[i]); if(el) return el; }',
  "      return document.querySelector('iframe');",
  '    }catch(e){ return null; }',
  '  }',
  '  function push(url,source){',
  '    if(!url) return;',
  '    var n=normalizeRoute(url);',
  '    if(!n||n===lastPushed) return;',
  '    if(typeof window.setUrl!=="function") return;',
  '    lastPushed=n;',
  '    try{ window.setUrl(n,{source:source||"zayro-route-compat"}); }catch(e){}',
  '  }',
  '  function readFrame(){',
  '    try{',
  '      var gf=frameEl(); if(!gf) return;',
  '      var w=gf.contentWindow; if(!w) return;',
  '      var href="";',
  '      try{ href=w.location.href||""; }catch(e){ return; }',
  '      if(href && href!=="about:blank") push(href,"frame-watch");',
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
  '  /* ── STUCK-REGISTER WATCHDOG ──',
  '     DhaniWin/13l pe iframe ka route cross-origin read fail ho sakta hai;',
  '     design tab bhi register card ("wait") me atka rehta hai HALAANKI user',
  '     logged-in home pe hai (balance aa chuka hai). Balance dikha + design',
  '     abhi bhi register state me => synthetic HOME route push karo. */',
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
  '      var base="";',
  '      try{',
  '        var m=String(typeof REGISTER_URL!=="undefined"?REGISTER_URL:"").match(/^https?:\\/\\/[^\\/?#]+/i);',
  '        if(m) base=m[0];',
  '      }catch(e){}',
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

  const script = `<script>\n/* ${SHIM_MARKER} — build-time auto-inject (DhaniWin / 13l path-routed support) */\n${ROUTE_COMPAT_SOURCE}\n</script>`;

  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + script);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => m + script);
  return script + html;
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
    document: { getElementById: () => null },
    setInterval: () => 0,
    setTimeout: (fn) => 0,
    Object,
    Array,
    String,
    Number,
    RegExp
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

/**
 * Injected shim ko wapas hata do — sirf tests (ablation) ke liye, taaki ye
 * prove ho sake ki fix shim se hi aa raha hai.
 */
function stripRouteCompat(html) {
  if (!html) return html;
  return html.replace(/<script>\s*\/\* ZAYRO UNIVERSAL ROUTE COMPAT[\s\S]*?<\/script>/, '');
}

module.exports = { injectRouteCompat, stripRouteCompat, normalizeRoute, ROUTE_COMPAT_SOURCE, SHIM_MARKER };
