// DhaniWin WebView / APK token handoff  (v7, standalone copy)
// -------------------------------------------------------------
// Same logic as the inline block in index.html. index.php injects THIS file when the
// index.html on disk is an old build (stale document = Wingo showed Rs 0.00 only in
// the APK). Harmless if index.html already ran its own copy: the guard below stops it.
// Read-only for money: it only moves the member's own bearer token where the game
// looks for it (localStorage / cookies / window.name) and adds the Authorization
// header on same-origin API calls when the app did not.
if (!window.__DH_HANDOFF__) {

        // DHANIWIN WEBVIEW HANDOFF v6 -------------------------------------------------
        // The game (Wingo) authenticates with its own token key `ar_g_token`, which the
        // app only ever fills in when the game is opened through /ThirdGame/GetGameUrl
        // and the SPA route path runs. Inside a WebView/APK that link is often opened in
        // a fresh window or an iframe: no `ar_g_token`, and cookies (SameSite) are
        // frequently dropped -> the game asked the API as an anonymous visitor and the
        // balance card showed Rs 0.00 while the site itself was logged in.
        // This block hands the member's own token over to the game before the app boots,
        // using channels that always work in a WebView: URL, localStorage, window.name.
        // It never trusts an identity id - only a real bearer token.
        (function () {
            var GK = 'ar_g_token', AK = 'ar_token', JUNK = JUNKMAP();
            function JUNKMAP() {
                var m = {}, list = ['', 'null', 'undefined', 'false', '0', '[object object]', '""', "''", '{}', '[]'];
                for (var i = 0; i < list.length; i++) { m[list[i]] = 1; }
                return m;
            }
            function clean(v) {
                if (v === null || v === undefined) { return ''; }
                v = String(v).trim();
                v = v.replace(/^(?:Bearer|Token)\s+/i, '');
                v = v.replace(/^["']+/, '').replace(/["']+$/, '').trim();
                if (v.length < 6 || JUNK[v.toLowerCase()]) { return ''; }
                return v;
            }
            function wrap(v) { return JSON.stringify({ value: v, expires: -1 }); }
            function parse(raw) {
                if (!raw) { return ''; }
                try {
                    var o = JSON.parse(raw);
                    if (o && typeof o === 'object' && ('value' in o)) {
                        if (o.expires !== -1 && o.expires < Date.now()) { return ''; }
                        return clean(o.value);
                    }
                } catch (e) {}
                return clean(raw);
            }
            function peek(k) {
                var v = '';
                try { v = parse(localStorage.getItem(k)); } catch (e) {}
                if (!v) { try { v = parse(sessionStorage.getItem(k)); } catch (e) {} }
                if (!v) { try { var m = /(?:^|; )dh_tok=([^;]+)/.exec(document.cookie || ''); v = m ? clean(decodeURIComponent(m[1])) : ''; } catch (e) {} }
                if (!v) { try { var n = /(?:^|&|\?)dhT=([^&]+)/.exec(window.name || ''); v = n ? clean(decodeURIComponent(n[1])) : ''; } catch (e) {} }
                return v;
            }
            function keep(k, v, raw) {
                try { localStorage.setItem(k, raw ? v : wrap(v)); } catch (e) {}
                if (!raw) { try { sessionStorage.setItem(k, wrap(v)); } catch (e) {} }
            }
            function q(name) {
                try {
                    var m = new RegExp('[?&#]' + name + '=([^&#]*)', 'i').exec(location.href);
                    return m ? clean(decodeURIComponent(m[1].replace(/\+/g, ' '))) : '';
                } catch (e) { return ''; }
            }
            function authHash() {
                try {
                    var h = String(location.hash || ''), i = h.indexOf('auth=');
                    if (i < 0) { return ''; }
                    var j = JSON.parse(atob(h.substring(i + 5).split('&')[0]));
                    return clean(j && (j.token || j.Token));
                } catch (e) { return ''; }
            }

            var tok = q('Token') || q('token') || authHash() || peek(GK) || peek(AK);
            window.__DH_HANDOFF__ = { v: 6, tok: tok ? 1 : 0 };
            if (tok) {
                keep(GK, tok, false);
                try { if (!clean(localStorage.getItem(AK))) { keep(AK, tok, true); } } catch (e) {}
                var ck = '; path=/; max-age=2592000; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
                try { document.cookie = GK + '=' + encodeURIComponent(tok) + ck; } catch (e) {}
                // readable sibling cookie: survives builds that wipe/mask the httpOnly one
                try { document.cookie = 'dh_tok=' + encodeURIComponent(tok) + ck; } catch (e) {}
                try {
                    var nm = String(window.name || '').replace(/&?dhT=[^&]*/g, '');
                    window.name = (nm ? nm + '&' : '') + 'dhT=' + encodeURIComponent(tok);
                } catch (e) {}
            }
            function current() { return tok || peek(GK) || peek(AK) || ''; }

            function isLocalApi(u) {
                var s = String(u || '');
                if (!s || /^data:/i.test(s)) { return false; }
                if (/^https?:/i.test(s)) {
                    var o = s.replace(/^(https?:\/\/[^\/?#]*).*$/i, '$1');
                    if (o && o !== location.origin) { return false; }
                }
                return /(^|[\/.])(webapi|api)[\/?]|lottery|thirdgame|getbalance|getuserinfo|bet|record/i.test(s);
            }

            try {
                var oo = XMLHttpRequest.prototype.open;
                var or = XMLHttpRequest.prototype.setRequestHeader;
                var os = XMLHttpRequest.prototype.send;
                XMLHttpRequest.prototype.open = function (m, u) {
                    try { this.__dhu = isLocalApi(u) ? 1 : 0; this.__dhset = 0; } catch (e) {}
                    return oo.apply(this, arguments);
                };
                XMLHttpRequest.prototype.setRequestHeader = function (n, v) {
                    try {
                        if (this.__dhu && String(n).toLowerCase() === 'authorization') {
                            this.__dhset = 1;
                            var t = current();
                            if (t && !clean(v)) { return or.call(this, n, 'Bearer ' + t); }
                        }
                    } catch (e) {}
                    return or.apply(this, arguments);
                };
                XMLHttpRequest.prototype.send = function () {
                    try {
                        if (this.__dhu && !this.__dhset) {
                            var t = current();
                            if (t) { or.call(this, 'Authorization', 'Bearer ' + t); }
                        }
                    } catch (e) {}
                    return os.apply(this, arguments);
                };
            } catch (e) {}

            try {
                if (window.fetch) {
                    var of = window.fetch;
                    window.fetch = function (input, init) {
                        try {
                            var u = (typeof input === 'string') ? input : (input && input.url) || '';
                            var t = current();
                            if (t && isLocalApi(u)) {
                                init = init || {};
                                var h = init.headers, done = false, k;
                                if (window.Headers && h instanceof Headers) {
                                    if (!clean(h.get('Authorization'))) { h.set('Authorization', 'Bearer ' + t); }
                                    done = true;
                                } else if (Object.prototype.toString.call(h) === '[object Array]') {
                                    for (var i = 0; i < h.length; i++) {
                                        if (String(h[i][0]).toLowerCase() === 'authorization' && clean(h[i][1])) { done = true; }
                                    }
                                    if (!done) { h.push(['Authorization', 'Bearer ' + t]); }
                                    done = true;
                                } else {
                                    h = h || {};
                                    for (k in h) { if (String(k).toLowerCase() === 'authorization' && clean(h[k])) { done = true; } }
                                    if (!done) { h.Authorization = 'Bearer ' + t; }
                                    init.headers = h;
                                }
                            }
                        } catch (e) {}
                        return of.call(this, input, init);
                    };
                }
            } catch (e) {}
        })();
}
