/* WordSwap service worker.
 * Network-first for the page + config (so updates show immediately when online),
 * cache-first for the rest of the app shell (fast + offline). */
var CACHE = 'wordswap-v7';
var ASSETS = ['./', './index.html', './words.js', './config.js', './manifest.json', './icon.svg'];

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
