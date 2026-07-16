// Minimal SW: network-first, no external cache, no install hang.
// Bump CACHE so old v1 caches (that may have bad HTML) die.
const CACHE_NAME = "grok-remote-v3-local-only";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

// Network-only for app shell so we never serve stale broken HTML with unpkg.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
