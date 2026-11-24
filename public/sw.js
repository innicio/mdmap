const CACHE_NAME = 'mdmap-pwa-v8';

// Solo assets públicos y estáticos (nunca '/', '/index.html' ni '/images/')
const PRECACHE_ASSETS = [
  '/login.html',
  '/manifest.json',
  '/assets/mdmap-vendor.js',
  '/assets/katex/katex.min.css',
  '/assets/katex/katex.min.js',
  '/assets/codemirror.css',
  '/assets/codemirror.js',
  '/assets/markdown.js',
  '/assets/continuelist.js',
  '/assets/placeholder.js',
  '/api/pwa-icon?size=192',
  '/api/pwa-icon?size=512'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Ignorar orígenes externos, llamadas a /api/ (salvo icono PWA) e imágenes privadas
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/pwa-icon') return;
  if (url.pathname.startsWith('/images/')) return;

  // 1. Entrada principal ('/' o '/index.html'): siempre red, sin caché
  if (url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then((res) => {
          if (res.redirected && new URL(res.url).pathname === '/login.html') {
            return Response.redirect('/login.html', 302);
          }
          if (res.status === 401 || res.status === 403) {
            return Response.redirect('/login.html', 302);
          }
          return res;
        })
        .catch(() => Response.redirect('/login.html', 302))
    );
    return;
  }

  // 2. Assets estáticos (/assets/, fuentes KaTeX e icono): Cache-First
  if (url.pathname.startsWith('/assets/') || url.pathname === '/api/pwa-icon') {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
          }
          return res;
        }).catch(() => Response.error());
      })
    );
    return;
  }

  // 3. Resto de públicos (/login.html, /manifest.json): Network-First con respaldo en caché
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((c) => c || Response.error()))
  );
});