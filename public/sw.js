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

// ─── Web Push ────────────────────────────────────────────────────
// The server sends a JSON payload ({ title, body, type, loanId, ... }).
// Showing a notification is what the push service is paid for in attention:
// a push that displays nothing gets the subscription throttled by the browser.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || "Udhaar";
  const options = {
    body: payload.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // Same type for the same loan replaces the previous one instead of
    // stacking a dozen "payment recorded" cards.
    tag: payload.loanId ? `${payload.type || "udhaar"}:${payload.loanId}` : undefined,
    renotify: true,
    data: payload,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping a notification should land on the thing it is about.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const url = data.loanId ? `/loans/${data.loanId}` : "/activity";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          if ("focus" in client) {
            if ("navigate" in client) client.navigate(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      })
  );
});

// Bump this whenever the caching strategy changes so old caches are dropped.
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
