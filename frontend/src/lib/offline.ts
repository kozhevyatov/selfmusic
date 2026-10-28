/**
 * Музыка офлайн: альбомы, плейлисты и подборки сохраняются в хранилище браузера (Cache Storage).
 * Service worker отдаёт сохранённые треки и обложки вместо сети — с поддержкой перемотки.
 *
 * В кэше «sm-offline-v1»:
 *   /__offline/audio/<id>   — аудиофайл трека
 *   /__offline/index.json   — что скачано: подборки и данные треков
 *   /api/cover/...          — обложки нужных размеров (по тем же адресам, что запрашивает интерфейс)
 */
import { useSyncExternalStore } from "react";
import { coverUrl, type Track } from "./api";

export const OFFLINE_CACHE = "sm-offline-v1";
const INDEX_URL = "/__offline/index.json";
const COVER_SIZES = [96, 128, 400, 512, 600, 900];

export type OfflineQuality = "original" | "320" | "192" | "128";
export type CollectionKind = "album" | "playlist" | "mix" | "folder" | "tracks";

export type OfflineCollection = {
  key: string; // album-12, playlist-3, mix-night
  kind: CollectionKind;
  title: string;
  subtitle: string;
  cover: string | null;
  link: string; // куда вести при нажатии, когда связь есть
  track_ids: number[];
  saved_at: string;
};

type OfflineTrack = { track: Track; size: number; quality: OfflineQuality };

type Index = { collections: OfflineCollection[]; tracks: Record<number, OfflineTrack> };

export type Progress = { done: number; total: number; failed: number; bytes: number };

type State = {
  ready: boolean;
  index: Index;
  progress: Record<string, Progress>; // по ключу подборки — пока качается
};

const supported = typeof window !== "undefined" && "caches" in window && "serviceWorker" in navigator;

let state: State = { ready: false, index: { collections: [], tracks: {} }, progress: {} };
const listeners = new Set<() => void>();

function emit(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useOfflineState(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => state,
  );
}

export const offlineSupported = supported;

// ---------------- индекс ----------------

async function cache() {
  return caches.open(OFFLINE_CACHE);
}

async function loadIndex() {
  if (!supported) return emit({ ready: true });
  try {
    const hit = await (await cache()).match(INDEX_URL);
    const index = hit ? ((await hit.json()) as Index) : { collections: [], tracks: {} };
    emit({ ready: true, index });
  } catch {
    emit({ ready: true });
  }
}

let saving = Promise.resolve();
function saveIndex(index: Index) {
  emit({ index });
  // записи по очереди, чтобы не перетереть свежий индекс старым
  saving = saving.then(async () => {
    await (await cache()).put(
      INDEX_URL,
      new Response(JSON.stringify(state.index), { headers: { "Content-Type": "application/json" } }),
    );
    navigator.serviceWorker?.controller?.postMessage({ type: "offline-updated" });
  });
  return saving;
}

void loadIndex();

export function isTrackOffline(id: number) {
  return Boolean(state.index.tracks[id]);
}

export function offlineTracksOf(c: OfflineCollection): Track[] {
  return c.track_ids.map((id) => state.index.tracks[id]?.track).filter(Boolean) as Track[];
}

export function offlineSize(): number {
  return Object.values(state.index.tracks).reduce((s, t) => s + (t.size || 0), 0);
}

// ---------------- качество ----------------

const QKEY = "sm-offline-quality";
export function getOfflineQuality(): OfflineQuality {
  try {
    return (localStorage.getItem(QKEY) as OfflineQuality) || "192";
  } catch {
    return "192";
  }
}
export function setOfflineQuality(q: OfflineQuality) {
  try {
    localStorage.setItem(QKEY, q);
  } catch {
    /* приватный режим */
  }
  listeners.forEach((l) => l());
}

// ---------------- загрузка ----------------

const queue: { key: string; track: Track }[] = [];
let active = 0;
const CONCURRENCY = 2;

async function requestPersistence() {
  try {
    // просим браузер не удалять скачанное при нехватке места
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* не поддерживается */
  }
}

async function fetchTrack(track: Track, quality: OfflineQuality, onBytes: (n: number) => void): Promise<number> {
  const res = await fetch(`/api/stream/${track.id}?q=${quality}&offline=1`, { credentials: "include", cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onBytes(value.length);
  }
  if (size < 1024) throw new Error("пустой файл");
  const type = res.headers.get("Content-Type") || "audio/mpeg";
  const blob = new Blob(chunks as BlobPart[], { type });
  await (await cache()).put(
    `/__offline/audio/${track.id}`,
    new Response(blob, { headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" } }),
  );
  return size;
}

async function fetchCovers(cover: string | null) {
  if (!cover) return;
  const c = await cache();
  await Promise.all(
    COVER_SIZES.map(async (s) => {
      const url = coverUrl(cover, s)!;
      if (await c.match(url)) return;
      try {
        const res = await fetch(url, { credentials: "include" });
        if (res.ok) await c.put(url, res);
      } catch {
        /* без обложки тоже можно */
      }
    }),
  );
}

function bump(key: string, patch: (p: Progress) => Partial<Progress>) {
  const cur = state.progress[key];
  if (!cur) return;
  emit({ progress: { ...state.progress, [key]: { ...cur, ...patch(cur) } } });
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    active++;
    const quality = getOfflineQuality();
    const already = state.index.tracks[job.track.id];
    const work = already
      ? Promise.resolve(already.size)
      : fetchTrack(job.track, quality, (n) => bump(job.key, (p) => ({ bytes: p.bytes + n }))).then(async (size) => {
          await fetchCovers(job.track.cover);
          await saveIndex({
            ...state.index,
            tracks: { ...state.index.tracks, [job.track.id]: { track: job.track, size, quality } },
          });
          return size;
        });
    work
      .then(() => bump(job.key, (p) => ({ done: p.done + 1 })))
      .catch(() => bump(job.key, (p) => ({ done: p.done + 1, failed: p.failed + 1 })))
      .finally(() => {
        active--;
        const p = state.progress[job.key];
        if (p && p.done >= p.total) {
          const { [job.key]: _, ...rest } = state.progress;
          emit({ progress: rest });
        }
        pump();
      });
  }
}

/** Скачать подборку (альбом, плейлист…). Уже скачанные треки не качаются повторно. */
export async function downloadCollection(c: Omit<OfflineCollection, "track_ids" | "saved_at">, tracks: Track[]) {
  if (!supported || !tracks.length) return;
  void requestPersistence();
  const existing = state.index.collections.filter((x) => x.key !== c.key);
  const col: OfflineCollection = { ...c, track_ids: tracks.map((t) => t.id), saved_at: new Date().toISOString() };
  await saveIndex({ ...state.index, collections: [col, ...existing] });
  await fetchCovers(c.cover);
  emit({ progress: { ...state.progress, [c.key]: { done: 0, total: tracks.length, failed: 0, bytes: 0 } } });
  for (const track of tracks) queue.push({ key: c.key, track });
  pump();
}

/** Удалить подборку; треки, которых нет в других подборках, тоже удаляются */
export async function removeCollection(key: string) {
  const col = state.index.collections.find((c) => c.key === key);
  if (!col) return;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].key === key) queue.splice(i, 1);
  const collections = state.index.collections.filter((c) => c.key !== key);
  const still = new Set(collections.flatMap((c) => c.track_ids));
  const tracks = { ...state.index.tracks };
  const c = await cache();
  for (const id of col.track_ids) {
    if (still.has(id)) continue;
    delete tracks[id];
    await c.delete(`/__offline/audio/${id}`);
  }
  const { [key]: _, ...progress } = state.progress;
  emit({ progress });
  await saveIndex({ collections, tracks });
}

export async function removeAll() {
  queue.length = 0;
  await caches.delete(OFFLINE_CACHE);
  emit({ index: { collections: [], tracks: {} }, progress: {} });
  navigator.serviceWorker?.controller?.postMessage({ type: "offline-updated" });
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}

/** Состояние скачивания конкретной подборки — для кнопки */
export function useCollectionStatus(key: string): { saved: boolean; complete: boolean; progress?: Progress } {
  const s = useOfflineState();
  const col = s.index.collections.find((c) => c.key === key);
  const progress = s.progress[key];
  const complete = Boolean(col && col.track_ids.every((id) => s.index.tracks[id]));
  return { saved: Boolean(col), complete, progress };
}
