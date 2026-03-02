const CACHE = 'diii-v1';
const APP_SHELL_FILES = [
  '/',
  '/index.html',
  '/style.css',
  '/diii.js',
  '/manifest.webmanifest',
  '/icons/logo.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL_FILES)));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
