const CACHE_NAME = 'shiguang-pwa-v31';
const APP_SHELL = [
  '/',
  '/manifest.webmanifest?v=31',
  '/favicon.ico?v=31',
  '/logo.png?v=31',
  '/apple-touch-icon.png?v=31',
  '/pwa-192.png?v=31',
  '/pwa-512.png?v=31',
];
const CDN_HOSTS = ['cdn.tailwindcss.com'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 外部 CDN（如 Tailwind）走缓存优先，断网也能用
  if (CDN_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((response) => {
            if (response && response.ok) {
              const clone = response.clone();
              event.waitUntil(
                caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
              );
            }
            return response;
          })
          .catch(() => cached || Response.error());
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const responseClone = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone))
            );
          }
          return response;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) return cachedResponse;
          return caches.match('/');
        })
    );
    return;
  }

  const shouldCacheAsset =
    ['script', 'style', 'image', 'font', 'worker'].includes(request.destination) ||
    /\.[a-z0-9]+$/i.test(url.pathname);

  if (!shouldCacheAsset) return;

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(request).then((response) => {
        if (response && response.ok) {
          const responseClone = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone))
          );
        }
        return response;
      });
    })
  );
});
