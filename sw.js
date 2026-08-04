/* Service worker — caches the app shell so it opens offline.
   Data itself lives in localStorage; this only caches the static files. */
const CACHE = 'rbm-v68';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Never cache the Apps Script sync calls or any cross-origin POST.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Stale-while-revalidate for same-origin app assets.
  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
