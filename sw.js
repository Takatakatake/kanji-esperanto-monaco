const CACHE = 'ke-site-v6';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './all.json',
  './ke-snippets.js',
  './manifest.webmanifest',
  // Monaco minimal (for online page)
  'https://unpkg.com/monaco-editor@0.52.0/min/vs/loader.js',
  'https://unpkg.com/monaco-editor@0.52.0/min/vs/base/worker/workerMain.js',
  // CodeMirror (ESM)
  'https://esm.sh/@codemirror/state@6.4.1',
  'https://esm.sh/@codemirror/view@6.34.1',
  'https://esm.sh/@codemirror/commands@6.5.0',
  'https://esm.sh/@codemirror/autocomplete@6.13.3',
  'https://esm.sh/@codemirror/view@6.34.1/style.css',
  // CM app
  './cm/index.html',
  './cm/app.js',
  // Dictionary buckets
  './data/ke-a.json','./data/ke-b.json','./data/ke-c.json','./data/ke-d.json','./data/ke-e.json','./data/ke-f.json','./data/ke-g.json','./data/ke-h.json','./data/ke-i.json','./data/ke-j.json','./data/ke-k.json','./data/ke-l.json','./data/ke-m.json','./data/ke-n.json','./data/ke-o.json','./data/ke-p.json','./data/ke-r.json','./data/ke-s.json','./data/ke-t.json','./data/ke-u.json','./data/ke-v.json','./data/ke-z.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
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
