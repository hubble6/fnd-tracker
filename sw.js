// FND Tracker — Service Worker v4 (offline-first)
// Caches the full app shell including app.js and CDN scripts.

const CACHE = 'fnd-drive-v4';

const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=DM+Mono:wght@400;500&display=swap',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
];

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
      .then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept Google Drive API or auth calls — they need real network
  if (['googleapis.com','accounts.google.com','googleusercontent.com'].some(h=>url.hostname.includes(h))) return;

  if (e.request.method !== 'GET') return;

  // Cache-first for everything else (app shell, fonts, CDN scripts)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(r => {
        if (r?.status===200 && r.type!=='opaque') {
          caches.open(CACHE).then(c=>c.put(e.request, r.clone()));
        }
        return r;
      });
    })
  );
});
