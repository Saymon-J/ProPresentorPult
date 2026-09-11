// Кэш оболочки пульта, чтобы открывался мгновенно и работал офлайн-каркас.
const SHELL = new Set(['/', '/index.html', '/style.css', '/app.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png']);
const CACHE = 'pult-v4';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('pult-v1').then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== 'pult-v1').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // /pp/* всегда мимо кэша — живое состояние ProPresenter
  if (url.pathname.startsWith('/pp/')) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
