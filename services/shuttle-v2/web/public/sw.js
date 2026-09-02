// Minimal, deliberately boring service worker.
//
// Its ONE job is an offline shell: open the app in a tunnel or dead spot and
// you get the last-seen UI instead of a browser error page. It must never make
// a rider see stale content when online, and it must never pin an old bundle
// after a deploy — a misbehaving SW is the classic way a web app bricks itself.
// So: network-first for everything, cache only same-origin GETs that succeeded,
// and take over immediately on update.
const CACHE = "shuttle-shell-v1";

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Live data is never cached: a stale bus position is worse than none.
  if (url.pathname.startsWith("/api/")) return;
  // Nor the operator dashboard: it is a numbers page opened to see NOW, and
  // it is not part of the rider shell this cache exists to keep installable.
  if (url.pathname === "/stats" || url.pathname === "/stats.html") return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(
          (hit) => hit || (e.request.mode === "navigate" ? caches.match("/") : undefined),
        ),
      ),
  );
});
