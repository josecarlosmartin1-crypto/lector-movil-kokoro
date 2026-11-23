// sw.js - Service Worker para VoxEPUB Kokoro (V1.0)
const CACHE_NAME = 'voxepub-kokoro-v1.0';
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './main.js',
  './tts-manager.js',
  './tts-worker.js',
  './manifest.json',
  './icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
