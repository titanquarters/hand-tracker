/**
 * Caches the hand tracker's app shell so it opens instantly and keeps working
 * offline.
 *
 * The Skeleton Mirror is deliberately NOT cached. It is a separate installation
 * app whose code changes often and whose skeleton model is a 13 MB download,
 * and a stale copy of it is far worse than a slow one -- a cached build will
 * happily keep showing an old skeleton long after a new one has shipped, with
 * nothing on screen to say so.
 */
const CACHE = 'hand-skeleton-v2';

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/skeleton.js',
  './js/smoothing.js',
  './js/drawing.js',
  './js/hand3d.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];

/** Paths this worker must never serve from cache. */
const NEVER_CACHE = [
  '/mirror.html',
  '/js/mirror/',
  '/css/mirror.css',
  '/lib/',
  '/art/',
  '/vendor/',
];

const bypass = (url) => NEVER_CACHE.some((p) => url.pathname.includes(p));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // One missing file must not fail the whole install.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // Let the mirror app go straight to the network, every time.
  if (bypass(url)) return;

  // Network first, cache as fallback, so an update lands without a hard reload.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
  );
});
