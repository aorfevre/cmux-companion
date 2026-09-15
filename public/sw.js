// The production build replaces this marker with a digest of its client assets.
// Development must never persist unversioned Vite modules between checkouts.
const BUILD_ID = "__CMUX_BUILD_ID__";
const BUILD_ASSETS = [];
const CACHE_PREFIX = "cmux-companion-";
const CACHE = `${CACHE_PREFIX}${BUILD_ID}`;
const PRODUCTION = !BUILD_ID.startsWith("__");
const APP_SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    if (PRODUCTION) await (await caches.open(CACHE)).addAll([...APP_SHELL, ...BUILD_ASSETS]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && (!PRODUCTION || key !== CACHE)).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (!PRODUCTION || request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;
  const key = request.mode === "navigate" ? "/" : request;
  // Network-first also updates unversioned icons/manifests. The browser's HTTP
  // cache still handles immutable assets; CacheStorage supplies offline reads.
  const response = (async () => {
    const cache = await caches.open(CACHE).catch(() => null);
    try {
      const fresh = await fetch(request);
      if (fresh.ok && cache) await cache.put(key, fresh.clone()).catch(() => {});
      return fresh;
    } catch {
      return (await cache?.match(key)) || Response.error();
    }
  })();
  event.respondWith(response);
  event.waitUntil(response.then(() => {}, () => {}));
});
