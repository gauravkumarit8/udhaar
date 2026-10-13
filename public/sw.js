const CACHE_NAME = "udhaar-v2";
const STATIC_ASSETS = [
  "/",
  "/login",
  "/dashboard",
  "/loans/new",
  "/manifest.json",
  "/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Anything that isn't a plain page/asset load is left to the network.
function isCacheable(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  // Authenticated JSON must never be cached: it would survive a logout and be
  // served to whoever picks the device up next (and it goes stale instantly).
  if (url.pathname.startsWith("/api/")) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  if (!isCacheable(event.request)) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Only cache successful, cacheable responses - caching a 401/500 page
        // meant the user kept seeing the error after they'd logged back in.
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Bump this whenever the caching strategy changes so old caches are dropped.
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
