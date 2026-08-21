/* WordSwap service worker.
 * Network-first for the page + config (so updates show immediately when online),
 * cache-first for the rest of the app shell (fast + offline). */
var CACHE = 'wordswap-v21';
var ASSETS = ['./', './index.html', './words.js', './config.js', './manifest.json',
  './logo.webp', './icon192.png', './icon512.png', './icon1024.png', './appletouchicon.png', './iconmaskable512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  // Only same-origin traffic belongs to this cache. Cross-origin calls (the game
  // server, Supabase) must go straight to the network: the fallbacks below answer
  // a failed request with index.html, which would hand the caller a forged 200
  // and make a dead server look healthy.
  try { if (new URL(e.request.url).origin !== self.location.origin) return; } catch (err) { return; }
  var isNav = e.request.mode === 'navigate' || e.request.destination === 'document';
  var isConfig = /config\.js(\?|$)/.test(e.request.url);

  if (isNav || isConfig) {
    // network-first: always try to get the latest, fall back to cache offline
    e.respondWith(
      fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { try { c.put(e.request, copy); } catch (err) {} });
        return res;
      }).catch(function () {
        return caches.match(e.request).then(function (h) { return h || caches.match('./index.html'); });
      })
    );
    return;
  }

  // cache-first for everything else (words.js, icons, etc.)
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { try { c.put(e.request, copy); } catch (err) {} });
        return res;
      }).catch(function () { return caches.match('./index.html'); });
    })
  );
});

// ---------- Push notifications ----------
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { body: e.data && e.data.text() }; }
  var title = data.title || 'WordSwap';
  var opts = { body: data.body || '', icon: './icon192.png', badge: './icon192.png', vibrate: [40, 30, 40], data: { url: data.url || './' } };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
