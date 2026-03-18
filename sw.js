// FND Tracker — Service Worker v7 (serverless, offline-first)
const CACHE = 'fnd-offline-v7';

// Static app shell — all local, no CDN required
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './vendor/react.production.min.js',
  './vendor/react-dom.production.min.js',
  './vendor/babel.min.js',
];

// Cache Google Fonts if available (nice-to-have, not required)
const FONT_URL = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Only cache GET requests
  if (e.request.method !== 'GET') return;

  // Cache-first for app shell and vendor assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(r => {
        // Cache successful, non-opaque responses (skip cross-origin opaque)
        if (r?.status === 200 && r.type !== 'opaque') {
          caches.open(CACHE).then(c => c.put(e.request, r.clone()));
        }
        return r;
      }).catch(() => {
        // Network failed — serve cached index.html for navigation
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
