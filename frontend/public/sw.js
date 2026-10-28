/* Service worker SelfMusic.
 * Нужен для установки на телефон (PWA) и быстрого запуска:
 * - оболочка (HTML) — сначала сеть, без сети — кэш;
 * - собранные файлы /assets/* и обложки — сначала кэш;
 * - API и аудиопоток не кэшируются (поток идёт с поддержкой перемотки напрямую).
 */
const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const STATIC = `static-${VERSION}`;
const COVERS = "covers-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.json", "/favicon.svg"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  const keep = [SHELL, STATIC, COVERS];
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function cacheFirst(request, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    if (max) trim(cache, max);
  }
  return response;
}

async function shell(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put("/", response.clone());
    return response;
  } catch {
    return (await cache.match("/")) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (request.mode === "navigate") return event.respondWith(shell(request));
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/"))
    return event.respondWith(cacheFirst(request, STATIC));
  // Обложки: в адресе есть ?v=<время изменения>, поэтому кэш безопасен
  if (url.pathname.startsWith("/api/cover/") && url.searchParams.has("v"))
    return event.respondWith(cacheFirst(request, COVERS, 800));
});
