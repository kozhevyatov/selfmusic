/**
 * Скачанное в приложении: файлы треков и обложек в памяти телефона (папка приложения).
 *
 * Сайт во WebView присылает команды «скачать подборку / удалить / удалить всё» и получает индекс —
 * тот же формат, что у браузерной версии (frontend/src/lib/offline.ts), поэтому кнопки «Скачать»
 * и страница «Скачанное» на сайте работают и здесь. Плеер берёт скачанные треки из памяти —
 * и без сети, и экономя трафик.
 *
 * Папка: documents/offline/<сервер+логин>/
 *   index.json — подборки, данные треков, незаконченные загрузки
 *   audio/<id> — аудиофайл трека
 *   covers/<…>.jpg — обложки (для экрана блокировки и офлайн-экрана)
 *   plays.json — прослушивания без связи: отправим, когда сервер снова доступен
 */
import { Directory, File, Paths } from "expo-file-system";
import { apiSend, mediaUrl, type Session } from "./session";

export type TrackData = { id: number; title: string; artist: string; album: string; cover: string | null; duration: number; [k: string]: unknown };

export type Collection = {
  key: string;
  kind: string;
  title: string;
  subtitle: string;
  cover: string | null;
  link: string;
  track_ids: number[];
  saved_at: string;
};

type Saved = { track: TrackData; size: number; quality: string; gain: number };
type Job = { key: string; track: TrackData; quality: string; gain: number };
type Index = { collections: Collection[]; tracks: Record<string, Saved>; queue?: Job[] };
export type Progress = { done: number; total: number; failed: number; bytes: number };

export type OfflineEvent =
  | { type: "offline"; index: { collections: Collection[]; tracks: Record<string, Saved> }; free: number }
  | { type: "offline-progress"; progress: Record<string, Progress> };

const CONCURRENCY = 2;

function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Адрес обложки нужного размера (как coverUrl на сайте) */
export function coverPath(cover: string, size: number) {
  return /[?&]size=\d+/.test(cover) ? cover.replace(/size=\d+/, `size=${size}`) : `${cover}${cover.includes("?") ? "&" : "?"}size=${size}`;
}

class OfflineStore {
  private root: Directory | null = null;
  private index: Index = { collections: [], tracks: {} };
  private queue: Job[] = [];
  private progress: Record<string, Progress> = {};
  private active = 0;
  private inflight = new Map<number, Promise<void>>();
  private listeners = new Set<(e: OfflineEvent) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private plays: { track_id: number; played_at: string }[] = [];
  private flushing = false;

  on(fn: (e: OfflineEvent) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(e: OfflineEvent) {
    this.listeners.forEach((fn) => {
      try {
        fn(e);
      } catch {
        /* слушатель упал */
      }
    });
  }

  // ---------------- папка и индекс ----------------

  /** Открыть хранилище для сервера и пользователя (у каждого своё скачанное) */
  open(s: Session) {
    const dir = new Directory(Paths.document, "offline", hash(`${s.server}|${s.username.toLowerCase()}`));
    if (this.root?.uri === dir.uri) return;
    this.root = dir;
    this.queue = [];
    this.progress = {};
    this.index = { collections: [], tracks: {} };
    this.plays = [];
    try {
      for (const d of [dir, this.audioDir(), this.coverDir()]) if (!d.exists) d.create({ intermediates: true, idempotent: true });
      const f = new File(dir, "index.json");
      if (f.exists) this.index = JSON.parse(f.textSync()) as Index;
      const p = new File(dir, "plays.json");
      if (p.exists) this.plays = JSON.parse(p.textSync());
    } catch {
      /* битый индекс — начинаем с пустого */
    }
    this.index.collections ??= [];
    this.index.tracks ??= {};
    // треки, файлы которых пропали (почистили память), — убираем из индекса
    for (const id of Object.keys(this.index.tracks)) if (!this.audioFile(Number(id)).exists) delete this.index.tracks[id];
    // незаконченные загрузки — продолжаем
    const pending = this.index.queue ?? [];
    delete this.index.queue;
    for (const job of pending) this.enqueue(job);
    this.pump();
    this.changed();
  }

  private audioDir() {
    return new Directory(this.root!, "audio");
  }

  private coverDir() {
    return new Directory(this.root!, "covers");
  }

  private audioFile(id: number) {
    return new File(this.audioDir(), String(id));
  }

  private coverFile(cover: string) {
    return new File(this.coverDir(), `${hash(cover.replace(/[?&]size=\d+/, ""))}.jpg`);
  }

  private snapshot() {
    return { collections: this.index.collections, tracks: this.index.tracks };
  }

  private free() {
    try {
      return Paths.availableDiskSpace;
    } catch {
      return 0;
    }
  }

  /** Индекс изменился: сообщаем сайту и сохраняем (пачкой — при загрузке альбома меняется часто) */
  private changed() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.emit({ type: "offline", index: this.snapshot(), free: this.free() });
      this.save();
    }, 700);
  }

  private save() {
    if (!this.root) return;
    try {
      const data: Index = { ...this.snapshot(), queue: this.queue };
      new File(this.root, "index.json").write(JSON.stringify(data));
    } catch {
      /* нет места — индекс останется прежним */
    }
  }

  private tick() {
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.emit({ type: "offline-progress", progress: this.progress });
    }, 400);
  }

  state() {
    this.emit({ type: "offline", index: this.snapshot(), free: this.free() });
    this.emit({ type: "offline-progress", progress: this.progress });
  }

  // ---------------- для плеера ----------------

  audioUri(id: number): string | null {
    if (!this.root || !this.index.tracks[id]) return null;
    const f = this.audioFile(id);
    return f.exists ? f.uri : null;
  }

  coverUri(cover: string | null): string | null {
    if (!this.root || !cover) return null;
    const f = this.coverFile(cover);
    return f.exists ? f.uri : null;
  }

  collections() {
    return this.index.collections;
  }

  tracksOf(c: Collection): { track: TrackData; gain: number }[] {
    return c.track_ids.map((id) => this.index.tracks[id]).filter(Boolean).map((s) => ({ track: s.track, gain: s.gain }));
  }

  allTracks() {
    return Object.values(this.index.tracks).map((s) => ({ track: s.track, gain: s.gain }));
  }

  // ---------------- команды сайта ----------------

  download(c: Collection, tracks: TrackData[], quality: string, gains: Record<string, number> = {}) {
    if (!this.root || !tracks.length) return;
    this.index.collections = [{ ...c, track_ids: tracks.map((t) => t.id) }, ...this.index.collections.filter((x) => x.key !== c.key)];
    this.queue = this.queue.filter((j) => j.key !== c.key);
    this.progress[c.key] = { done: 0, total: tracks.length, failed: 0, bytes: 0 };
    for (const t of tracks) this.queue.push({ key: c.key, track: t, quality, gain: typeof gains[t.id] === "number" ? gains[t.id] : 1 });
    void this.fetchCover(c.cover);
    this.changed();
    this.tick();
    this.pump();
  }

  private enqueue(job: Job) {
    const p = (this.progress[job.key] ??= { done: 0, total: 0, failed: 0, bytes: 0 });
    p.total++;
    this.queue.push(job);
  }

  remove(key: string) {
    const col = this.index.collections.find((c) => c.key === key);
    this.queue = this.queue.filter((j) => j.key !== key);
    delete this.progress[key];
    if (!col) return;
    this.index.collections = this.index.collections.filter((c) => c.key !== key);
    this.cleanup(col.track_ids);
    this.changed();
    this.tick();
  }

  clear() {
    this.queue = [];
    this.progress = {};
    const ids = Object.keys(this.index.tracks).map(Number);
    this.index = { collections: [], tracks: {} };
    this.cleanup(ids);
    try {
      for (const f of this.coverDir().list()) f.delete();
    } catch {
      /* ничего */
    }
    this.changed();
    this.tick();
  }

  /** Удалить файлы треков, которых больше нет ни в одной подборке */
  private cleanup(ids: number[]) {
    const still = new Set(this.index.collections.flatMap((c) => c.track_ids));
    for (const id of ids) {
      if (still.has(id) || this.inflight.has(id)) continue;
      delete this.index.tracks[id];
      try {
        const f = this.audioFile(id);
        if (f.exists) f.delete();
      } catch {
        /* уже удалён */
      }
    }
  }

  // ---------------- загрузка ----------------

  private pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      this.run(job)
        .then(() => this.bump(job.key, 0, false))
        .catch(() => this.bump(job.key, 0, true))
        .finally(() => {
          this.active--;
          const p = this.progress[job.key];
          if (p && p.done >= p.total) {
            delete this.progress[job.key];
            this.tick();
          }
          // трек скачался, а подборку уже удалили — файл не нужен
          if (!this.index.collections.some((c) => c.track_ids.includes(job.track.id))) this.cleanup([job.track.id]);
          this.changed();
          this.pump();
        });
    }
  }

  private bump(key: string, bytes: number, failed: boolean | null) {
    const p = this.progress[key];
    if (!p) return;
    p.bytes += bytes;
    if (failed !== null) {
      p.done++;
      if (failed) p.failed++;
    }
    this.tick();
  }

  private async run(job: Job) {
    const id = job.track.id;
    if (this.index.tracks[id] && this.audioFile(id).exists) return;
    const running = this.inflight.get(id);
    if (running) return running;
    const work = (async () => {
      const file = this.audioFile(id);
      let last = 0;
      try {
        await File.downloadFileAsync(mediaUrl(`/api/stream/${id}?q=${job.quality}&offline=1`), file, {
          idempotent: true,
          onProgress: ({ bytesWritten }) => {
            this.bump(job.key, bytesWritten - last, null);
            last = bytesWritten;
          },
        });
        const size = file.size ?? 0;
        if (size < 1024) throw new Error("пустой файл");
        this.index.tracks[id] = { track: job.track, size, quality: job.quality, gain: job.gain };
      } catch (err) {
        try {
          if (file.exists) file.delete();
        } catch {
          /* ничего */
        }
        throw err;
      }
      await this.fetchCover(job.track.cover);
    })();
    this.inflight.set(id, work);
    try {
      await work;
    } finally {
      this.inflight.delete(id);
    }
  }

  private async fetchCover(cover: string | null) {
    if (!cover || !this.root) return;
    const f = this.coverFile(cover);
    if (f.exists) return;
    try {
      await File.downloadFileAsync(mediaUrl(coverPath(cover, 512)), f, { idempotent: true });
    } catch {
      /* без обложки тоже можно */
    }
  }

  // ---------------- прослушивания без связи ----------------

  /** Засчитать прослушивание; без связи — запомнить и отправить позже */
  async play(trackId: number) {
    const at = new Date().toISOString();
    const status = await apiSend("/api/plays", "POST", { track_id: trackId });
    if (status !== null) return void this.flushPlays();
    this.plays = [...this.plays, { track_id: trackId, played_at: at }].slice(-500);
    this.savePlays();
  }

  async flushPlays() {
    if (this.flushing || !this.plays.length) return;
    this.flushing = true;
    try {
      while (this.plays.length) {
        const status = await apiSend("/api/plays", "POST", this.plays[0]);
        if (status === null) break; // снова нет связи
        this.plays = this.plays.slice(1); // принято (или трек уже удалён с сервера)
      }
      this.savePlays();
    } finally {
      this.flushing = false;
    }
  }

  private savePlays() {
    if (!this.root) return;
    try {
      new File(this.root, "plays.json").write(JSON.stringify(this.plays));
    } catch {
      /* нет места */
    }
  }
}

export const offline = new OfflineStore();
