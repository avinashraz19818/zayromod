// Dhani.win service worker - patched (round 7)
// ---------------------------------------------------------------
// The stock version answered ANY dotless SPA path (e.g. /Wingo_1M) with the
// offline "shell" page from sw-page.js as soon as the network response was not
// HTTP-OK. That shell iframes a *landing/mirror domain*, so inside an APK the
// Wingo screen could end up running on a different origin - where the member's
// token, cookies and localStorage of the main domain do not exist. Result: the
// site header showed the balance, the game card showed Rs 0.00, and no patch of
// index.html could change anything.
//
// Patched behaviour: the network always wins while it answers at all (even on a
// 404/500). The mirror shell is used only when the fetch genuinely throws, i.e.
// the domain is really unreachable - so domain failover stays intact.
// The stale 'online-page' cache is dropped on activate so an already-installed
// shell can not keep being served after this update.

importScripts('./sw-utils.js', './sw-domain.js', './sw-page.js');

self.addEventListener('message', function (event) {});

self.addEventListener('install', function (event) {
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil((async function () {
        try { await caches.delete('online-page'); } catch (e) {}
        try { await caches.delete('sw-page.html'); } catch (e) {}
    })());
});

self.addEventListener('error', function (event) {
    console.error('[SW] error:', event.message, event.filename, event.lineno);
});

self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET') return;

    var url;
    try { url = new URL(request.url); } catch (e) { return; }
    if (url.origin !== self.location.origin) return;

    var p = url.pathname;
    if (p.indexOf('/api') !== -1 || p.indexOf('/webapi') !== -1 || p.indexOf('.') !== -1) return;
    if (['', '/undefined', '/null', '/[object Object]'].indexOf(p) !== -1) return;

    event.respondWith((async function () {
        try {
            var networkResponse = await fetch(request);
            // patched: whatever the origin answers, that answer is the page.
            return networkResponse;
        } catch (error) {
            var online = !(self.navigator && self.navigator.onLine === false);
            if (!online) {
                return new Response('<h1>navigator is offLine,Please check the device network</h1>', {
                    status: 503,
                    headers: { 'Content-Type': 'text/html' }
                });
            }
            try {
                var cache = await caches.open('online-page');
                var shell = createDynamicOnlinePage(buildStringMap());
                try { await cache.put('sw-page.html', shell.clone()); } catch (e) {}
                return shell;
            } catch (e2) {
                console.error('[SW] shell unavailable:', e2);
                return new Response('unavailable', { status: 503 });
            }
        }
    })());
});
