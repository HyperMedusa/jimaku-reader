const CACHE_VERSION = 'jimaku-v1';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/engine.js',
  './js/sources.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// install: precache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// activate: delete old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// fetch: ネット優先（最新を表示し、成功したらキャッシュ更新）、
// 圏外・失敗時はキャッシュにフォールバック。クロスオリジンは素通し。
self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (!request.url.startsWith(self.location.origin)) return;
  if (request.method !== 'GET') return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // navigation リクエストが失敗したら index.html のキャッシュを返す
        if (request.mode === 'navigate') {
          const index = await caches.match('./index.html');
          if (index) return index;
        }
        return Response.error();
      })
  );
});
