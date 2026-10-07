// service-worker.js — app shell caching for offline + installability
const CACHE_NAME = 'fitness-tracker-v3';
const PRECACHE_URLS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/seed.js',
  './js/timer.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './images/p2_1.png', './images/p2_2.png', './images/p2_3.png', './images/p2_4.png',
  './images/p3_1.png', './images/p3_2.png', './images/p3_3.png',
  './images/p4_1.png', './images/p4_2.png', './images/p4_3.png',
  './images/p5_1.png', './images/p5_2.png', './images/p5_3.png', './images/p5_4.png',
  './images/p6_1.png', './images/p6_2.png',
  './images/p7_1.png', './images/p7_2.png', './images/p7_3.png',
  './images/p8_1.png', './images/p8_2.png', './images/p8_3.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
