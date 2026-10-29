/* Service worker SelfMusic.
 * Нужен для установки на телефон (PWA) и быстрого запуска:
 * - оболочка (HTML) — сначала сеть, без сети — кэш;
 * - собранные файлы /assets/* и обложки — сначала кэш;
 * - API и аудиопоток не кэшируются (поток идёт с поддержкой перемотки напрямую);
 * - СКАЧАННОЕ (офлайн): треки и обложки из кэша sm-offline-v1 отдаются вместо сети,
 *   с поддержкой Range — без этого не работает перемотка, а Safari вообще не играет.
 */
const VERSION = "v3";
const OFFLINE = "sm-offline-v1";
const SHELL = `shell-${VERSION}`;
const STATIC = `static-${VERSION}`;
const COVERS = "covers-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.json", "/favicon.svg"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  const keep = [SHELL, STATIC, COVERS, OFFLINE]; // скачанное не удаляем при обновлении приложения
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

/** Скачанный трек из кэша; учитывает Range (перемотка) */
async function offlineAudio(request, id) {
  const cache = await caches.open(OFFLINE);
  const hit = await cache.match(`/__offline/audio/${id}`);
  if (!hit) return null;
  const range = request.headers.get("range");
  if (!range) return hit;
  const blob = await hit.blob();
  const size = blob.size;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = 0;
  let end = size - 1;
  if (m) {
    if (m[1] === "" && m[2] !== "") {
      start = Math.max(0, size - Number(m[2]));
    } else {
      start = Number(m[1] || 0);
      if (m[2] !== "") end = Math.min(Number(m[2]), size - 1);
    }
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": hit.headers.get("Content-Type") || "audio/mpeg",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

async function audio(request, id) {
  // Скачанный трек — из хранилища (с поддержкой Range); если его там уже нет — из сети
  const local = await offlineAudio(request, id);
  return local || fetch(new URL(`/api/stream/${id}`, location.origin), { credentials: "include", headers: rangeHeader(request) });
}

function rangeHeader(request) {
  const range = request.headers.get("range");
  return range ? { Range: range } : {};
}

async function cover(request) {
  // сначала обложки скачанного (они точно есть без сети), потом общий кэш обложек
  const offline = await (await caches.open(OFFLINE)).match(request);
  if (offline) return offline;
  try {
    return await cacheFirst(request, COVERS, 800);
  } catch {
    return Response.error();
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
  if (url.pathname.startsWith("/api/cover/") && url.searchParams.has("v")) return event.respondWith(cover(request));
  // Поток: перехватываем только скачанные треки (страница помечает их ?dl=1) — играем из хранилища,
  // и без сети, и экономя трафик. Обычный поток идёт мимо service worker: Safari на iPhone при проходе
  // через него теряет Range и через пару минут начинает трек заново.
  const stream = /^\/api\/stream\/(\d+)$/.exec(url.pathname);
  if (stream && url.searchParams.get("dl") === "1") return event.respondWith(audio(request, stream[1]));
});
