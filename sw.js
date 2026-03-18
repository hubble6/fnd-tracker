// FND Tracker — Service Worker v3 (Drive edition)
// Caches the app shell for offline loading.
// Drive API calls are never cached — they go through Google's own caching.

const CACHE = 'fnd-drive-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=DM+Mono:wght@400;500&display=swap',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Pass through Google, CDN, and font requests
  if (['googleapis.com','gstatic.com','googleusercontent.com','accounts.google.com',
       'unpkg.com','fonts.googleapis.com','fonts.gstatic.com'].some(h=>url.hostname.includes(h))) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const net = fetch(e.request).then(r => {
        if (r?.status===200 && r.type!=='opaque') {
          caches.open(CACHE).then(c=>c.put(e.request, r.clone()));
        }
        return r;
      });
      return cached || net;
    })
  );
});
