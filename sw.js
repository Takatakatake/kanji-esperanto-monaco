const CACHE = 'ke-site-v33';
const APP_VERSION = '20260621-dictionary-refresh-20';
const DICTIONARY_VERSION = 'pejvo-piv-20260620-r14';
const DICTIONARY_BUCKETS = ['a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','r','s','t','u','v','z'];
const versioned = (url, version) => `${url}?v=${encodeURIComponent(version)}`;
const ASSETS = [
  './',
  './index.html',
  versioned('./app.js', APP_VERSION),
  // all.json is a build artifact only — the app loads per-letter buckets + reverse.json,
  // never all.json (see app.js "No global fallback") — so it is NOT precached (~3 MB saved).
  versioned('./data/reverse.json', DICTIONARY_VERSION),
  './manifest.webmanifest',
  // Monaco minimal (for online page)
  'https://unpkg.com/monaco-editor@0.52.0/min/vs/loader.js',
  'https://unpkg.com/monaco-editor@0.52.0/min/vs/base/worker/workerMain.js',
  ...DICTIONARY_BUCKETS.map(letter => versioned(`./data/ke-${letter}.json`, DICTIONARY_VERSION))
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async (asset) => {
      try {
        await cache.add(asset);
      } catch {
        // External CDN assets may be temporarily unavailable; keep local PWA install working.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const url = new URL(req.url);
    const networkFirst = req.mode === 'navigate'
      || url.pathname.endsWith('/index.html')
      || url.pathname.endsWith('/app.js')
      || url.pathname.endsWith('/sw.js');
    if (networkFirst) {
      try {
        const res = await fetch(req);
        if (req.method === 'GET' && res.status === 200) cache.put(req, res.clone());
        return res;
      } catch {
        if (cached) return cached;
        return new Response('Offline', { status: 503 });
      }
    }
    if (cached) return cached;
    try {
      const res = await fetch(req);
      // Cache GET only
      if (req.method === 'GET' && (res.status === 200 || res.type === 'opaque')) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      return cached || new Response('Offline', { status: 503 });
    }
  })());
});
