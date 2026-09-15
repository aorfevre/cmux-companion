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

function notificationDestination(value) {
  if (typeof value === 'string' && (/^\/orchestration\?goal=[A-Za-z0-9_-]{1,100}$/.test(value) || ['/settings#updates', '/settings#notifications'].includes(value))) return value;
  return '/orchestration';
}
self.addEventListener('push', event => {
  let payload;
  try { payload = event.data?.json(); } catch { /* Malformed pushes still show safe, fixed copy. */ }
  const text = (value, fallback, limit) => typeof value === 'string' && value.length <= limit ? value.replace(/[\p{C}]/gu, '') : fallback;
  const title = text(payload?.title, 'Companion notification', 160);
  const body = text(payload?.body, 'Open Companion to see the latest status.', 200);
  const tag = typeof payload?.tag === 'string' && /^companion-[a-f0-9]{32}$/.test(payload.tag) ? payload.tag : 'companion-notification';
  event.waitUntil(self.registration.showNotification(title, { body, tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: notificationDestination(payload?.url) } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(notificationDestination(event.notification.data?.url), self.location.origin).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try { const navigated = await client.navigate(url); if (navigated) { await navigated.focus(); return; } } catch { /* Fall back to a fresh same-origin window. */ }
    }
    await self.clients.openWindow(url);
  })());
});
