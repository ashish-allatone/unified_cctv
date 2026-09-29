// Field app service worker: caches the shell so the app opens offline; API calls always go to the network.
const SHELL = "uvp-field-v1";
const FILES = ["/m/", "/m/index.html", "/m/app.js", "/m/styles.css", "/m/manifest.json", "/m/icon.svg"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/media/") || u.pathname.startsWith("/archive/")) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
