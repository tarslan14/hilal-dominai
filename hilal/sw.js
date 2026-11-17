// Offline cache for the installed app. Bump the version to force every phone to refresh.
const CACHE = 'hilal-v10';
const FILES = ['./', 'index.html', 'three.min.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'fonts/cinzel-latin-700-normal.woff2', 'fonts/cinzel-latin-ext-700-normal.woff2', 'fonts/eb-garamond-latin-400-normal.woff2',
  'fonts/eb-garamond-latin-ext-400-normal.woff2', 'fonts/eb-garamond-latin-400-italic.woff2', 'fonts/eb-garamond-latin-600-normal.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Serve from cache at once, refresh the cache from the network in the background.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => hit);
    return hit || net;
  }));
});
