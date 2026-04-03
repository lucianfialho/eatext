// Cue — Service Worker
// Cache-first strategy for static assets, no Workbox.

const CACHE_NAME = 'cue-v1';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// --- Install: precache all static assets ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

// --- Activate: delete stale caches ---
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// --- Fetch: cache-first for same-origin, network-first for esm.sh CDN ---
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // esm.sh CDN: try cache first, fall back to network and cache result
  if (url.hostname === 'esm.sh') {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      })
    );
    return;
  }

  // Same-origin: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) => cached || fetch(event.request)
      )
    );
  }
});
