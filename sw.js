const CACHE = 'ke-site-v8';
const ASSETS = [
  './',
  './index.html',
  './app.js?v=20260620-lookup-mode-2',
  './all.json',
  './data/reverse.json',
  './ke-snippets.js?v=20260620-lookup-mode-2',
  './manifest.webmanifest',
  // Monaco minimal (for online page)
  'https://unpkg.com/monaco-editor@0.52.0/min/vs/loader.js',
  'https://unpkg.com/monaco-editor@0.52.0/min/vs/base/worker/workerMain.js',
  // Dictionary buckets
  './data/ke-a.json','./data/ke-b.json','./data/ke-c.json','./data/ke-d.json','./data/ke-e.json','./data/ke-f.json','./data/ke-g.json','./data/ke-h.json','./data/ke-i.json','./data/ke-j.json','./data/ke-k.json','./data/ke-l.json','./data/ke-m.json','./data/ke-n.json','./data/ke-o.json','./data/ke-p.json','./data/ke-r.json','./data/ke-s.json','./data/ke-t.json','./data/ke-u.json','./data/ke-v.json','./data/ke-z.json'
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
      || url.pathname.endsWith('/ke-snippets.js')
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
