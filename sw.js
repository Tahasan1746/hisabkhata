/* হিসাবখাতা service worker — offline app shell + cache of public libraries only.
 * Financial API responses (Supabase) are deliberately NOT cached: they never reach the cache. */
const CACHE = 'hisabkhata-v2';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './sync-core.js', './cloud.js',
  './config.js', './manifest.json', './icon.svg',
];
const PUBLIC_LIBS = /^(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Network first (so updates arrive), cache as the offline fallback. */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !PUBLIC_LIBS.test(url.host)) return;   // Supabase and all other origins: pass through, never cached

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') return cache.match('./index.html');
      return Response.error();
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('./index.html'));
});
