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
  // Nor the About page: it is standalone prose served no-store, read once and
  // left, so there is nothing for the shell cache to buy by holding a copy.
  if (
    url.pathname === "/stats" || url.pathname === "/stats.html"
    || url.pathname === "/about" || url.pathname === "/about.html"
  ) return;

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

// Tapping a notification opens the app rather than nothing.
//
// A notification shown through the registration (`showNotification`) has no
// page behind it — that is the point, it survives a backgrounded tab — so the
// click has to be handled HERE. Focus a window that is already open, otherwise
// open one. Both stop-arrival alerts and the leave-now reminder come through
// this path, and neither is any use if the rider has to go and find the app by
// hand while the bus pulls in.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        for (const c of list) {
          if ("focus" in c) return c.focus();
        }
        return self.clients.openWindow ? self.clients.openWindow("/") : undefined;
      })
      .catch(() => {}),
  );
});
