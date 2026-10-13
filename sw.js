// Offline support: network first (so updates arrive immediately), falling
// back to the cached copy when the network is unavailable.
const CACHE = 'ddr-tray-scanner-v3';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/parser.js', 'js/trays.js', 'js/store.js', 'js/sync.js', 'js/excel.js', 'js/defaults.js', 'js/load.js', 'vendor/xlsx-js-style.min.js', 'gsheet/Code.gs', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin) return; // never cache database traffic
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
