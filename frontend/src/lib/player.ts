/**
 * Плеер: одна <audio> на всё приложение, очередь, перемешивание, повтор,
 * Media Session (управление с экрана блокировки и наушников), сохранение очереди
 * между перезагрузками и учёт прослушиваний.
 */
import { useSyncExternalStore } from "react";
import { api, coverUrl, streamUrl, type Track } from "./api";
import { shuffled } from "./utils";

export type Repeat = "off" | "all" | "one";

export type PlayerState = {
  queue: Track[];
  index: number;
  playing: boolean;
  loading: boolean;
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: Repeat;
  /** id трека → номер в исходном порядке, чтобы выключение перемешивания вернуло порядок */
  order: number[] | null;
};

const STORAGE = "sm-player";

function loadSaved(): Partial<PlayerState> {
  try {
    const raw = localStorage.getItem(STORAGE);
    return raw ? (JSON.parse(raw) as Partial<PlayerState>) : {};
  } catch {
    return {};
  }
}

class Player {
  private audio: HTMLAudioElement;
  private state: PlayerState;
  private listeners = new Set<() => void>();
  private scrobbled = new Set<string>();
  private playStartedFor = "";
  private errors = 0;
  private saveTimer = 0;
  /** Пользователь хочет, чтобы играло (а не просто восстановлена очередь) */
  private wantPlay = false;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = "metadata";
    const saved = loadSaved();
    this.state = {
      queue: saved.queue ?? [],
      index: Math.min(saved.index ?? 0, Math.max(0, (saved.queue?.length ?? 1) - 1)),
      playing: false,
      loading: false,
      time: saved.time ?? 0,
      duration: 0,
      volume: saved.volume ?? 1,
      muted: false,
      shuffle: saved.shuffle ?? false,
      repeat: saved.repeat ?? "off",
      order: saved.order ?? null,
    };
    this.audio.volume = this.state.volume;
    this.bind();
    const cur = this.current();
    if (cur) {
      // Восстанавливаем трек без автозапуска — пользователь нажмёт «Играть»
      this.audio.src = streamUrl(cur.id);
      const resumeAt = this.state.time;
      this.audio.addEventListener(
        "loadedmetadata",
        () => {
          if (resumeAt > 0 && resumeAt < this.audio.duration - 2) this.audio.currentTime = resumeAt;
        },
        { once: true },
      );
      this.updateMediaSession();
    }
  }

  // ---------- подписка ----------

  getState = () => this.state;

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  private set(patch: Partial<PlayerState>, persist = true) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
    if (persist) this.persist();
  }

  private persist() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const { queue, index, time, volume, shuffle, repeat, order } = this.state;
      try {
        // Очередь может быть длинной — храним не больше 1000 треков вокруг текущего
        const start = Math.max(0, index - 200);
        const slice = queue.slice(start, start + 1000);
        localStorage.setItem(
          STORAGE,
          JSON.stringify({ queue: slice, index: index - start, time, volume, shuffle, repeat, order: order?.slice(start, start + 1000) ?? null }),
        );
      } catch {
        /* переполнение или приватный режим */
      }
    }, 400);
  }

  current(): Track | null {
    return this.state.queue[this.state.index] ?? null;
  }

  // ---------- события <audio> ----------

  private bind() {
    const a = this.audio;
    a.addEventListener("play", () => this.set({ playing: true }, false));
    a.addEventListener("pause", () => this.set({ playing: false }));
    a.addEventListener("waiting", () => this.set({ loading: true }, false));
    a.addEventListener("playing", () => {
      this.errors = 0;
      this.set({ loading: false, playing: true }, false);
    });
    a.addEventListener("canplay", () => this.set({ loading: false }, false));
    a.addEventListener("durationchange", () => {
      const cur = this.current();
      const d = isFinite(a.duration) ? a.duration : (cur?.duration ?? 0);
      this.set({ duration: d }, false);
    });
    let lastTick = 0;
    a.addEventListener("timeupdate", () => {
      const now = performance.now();
      if (now - lastTick < 250) return;
      lastTick = now;
      this.set({ time: a.currentTime });
      this.maybeScrobble();
      if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && this.state.duration) {
        try {
          navigator.mediaSession.setPositionState({
            duration: this.state.duration,
            position: Math.min(a.currentTime, this.state.duration),
            playbackRate: a.playbackRate,
          });
        } catch {
          /* некоторые браузеры капризничают */
        }
      }
    });
    a.addEventListener("ended", () => this.onEnded());
    a.addEventListener("error", () => {
      if (!a.src || !this.current() || !this.wantPlay) return;
      this.errors++;
      this.set({ loading: false, playing: false }, false);
      window.dispatchEvent(new CustomEvent("sm:player-error", { detail: this.current()?.title }));
      if (this.errors < Math.min(5, this.state.queue.length)) window.setTimeout(() => this.next(true), 800);
    });

    if ("mediaSession" in navigator) {
      const ms = navigator.mediaSession;
      ms.setActionHandler("play", () => this.resume());
      ms.setActionHandler("pause", () => this.pause());
      ms.setActionHandler("previoustrack", () => this.prev());
      ms.setActionHandler("nexttrack", () => this.next());
      try {
        ms.setActionHandler("seekto", (d) => d.seekTime !== undefined && this.seek(d.seekTime));
        ms.setActionHandler("seekbackward", (d) => this.seek(a.currentTime - (d.seekOffset ?? 10)));
        ms.setActionHandler("seekforward", (d) => this.seek(a.currentTime + (d.seekOffset ?? 10)));
      } catch {
        /* не поддерживается */
      }
    }
  }

  private maybeScrobble() {
    const cur = this.current();
    if (!cur) return;
    const key = `${this.playStartedFor}`;
    if (!key || this.scrobbled.has(key)) return;
    const d = this.state.duration || cur.duration;
    if (this.audio.currentTime >= Math.min(240, Math.max(20, d * 0.5))) {
      this.scrobbled.add(key);
      api.library.recordPlay(cur.id).catch(() => {});
    }
  }

  private onEnded() {
    if (this.state.repeat === "one") {
      this.audio.currentTime = 0;
      this.startTracking();
      this.audio.play().catch(() => {});
      return;
    }
    if (this.state.index < this.state.queue.length - 1) this.load(this.state.index + 1, true);
    else if (this.state.repeat === "all" && this.state.queue.length) this.load(0, true);
    else this.set({ playing: false, time: 0 });
  }

  private startTracking() {
    this.playStartedFor = `${this.current()?.id}:${Date.now()}`;
  }

  private load(index: number, autoplay: boolean) {
    const track = this.state.queue[index];
    if (!track) return;
    this.set({ index, time: 0, duration: track.duration, loading: autoplay });
    this.audio.src = streamUrl(track.id);
    this.startTracking();
    this.updateMediaSession();
    this.wantPlay = autoplay;
    if (autoplay) {
      this.audio.play().catch(() => this.set({ playing: false, loading: false }, false));
    }
  }

  private updateMediaSession() {
    const t = this.current();
    if (!t || !("mediaSession" in navigator)) return;
    const art = coverUrl(t.cover, 512);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album,
      artwork: art ? [{ src: art, sizes: "512x512", type: "image/webp" }] : [],
    });
    document.title = `${t.title} · ${t.artist}`;
  }

  // ---------- действия ----------

  /** Начать играть список с позиции start. */
  play(tracks: Track[], start = 0, opts: { shuffle?: boolean } = {}) {
    if (!tracks.length) return;
    const shuffle = opts.shuffle ?? this.state.shuffle;
    let queue = tracks;
    let order: number[] | null = null;
    let index = start;
    if (shuffle) {
      const first = tracks[start];
      const rest = shuffled(tracks.filter((_, i) => i !== start));
      queue = opts.shuffle && start === 0 && !this.state.shuffle ? shuffled(tracks) : [first, ...rest];
      order = queue.map((t) => tracks.indexOf(t));
      index = 0;
    }
    this.set({ queue, order, shuffle });
    this.load(index, true);
  }

  playNext(tracks: Track[]) {
    if (!this.state.queue.length) return this.play(tracks);
    const q = this.state.queue.slice();
    q.splice(this.state.index + 1, 0, ...tracks);
    this.set({ queue: q, order: null });
  }

  enqueue(tracks: Track[]) {
    if (!this.state.queue.length) return this.play(tracks);
    this.set({ queue: [...this.state.queue, ...tracks], order: null });
  }

  toggle() {
    if (this.audio.paused) this.resume();
    else this.pause();
  }

  resume() {
    if (!this.current()) return;
    if (!this.audio.src || this.audio.error) {
      // Источник не загрузился (например, очередь восстановлена до входа) — грузим заново с того же места
      const at = this.state.time;
      this.load(this.state.index, true);
      if (at > 0) this.audio.addEventListener("loadedmetadata", () => this.seek(at), { once: true });
    } else {
      if (!this.playStartedFor) this.startTracking();
      this.wantPlay = true;
      this.audio.play().catch(() => {});
    }
  }

  pause() {
    this.wantPlay = false;
    this.audio.pause();
  }

  next(auto = false) {
    const { index, queue, repeat } = this.state;
    if (index < queue.length - 1) this.load(index + 1, true);
    else if (repeat === "all" || !auto) {
      if (queue.length) this.load(0, repeat === "all" || !auto);
    }
  }

  prev() {
    if (this.audio.currentTime > 4) {
      this.seek(0);
      return;
    }
    const { index, queue } = this.state;
    if (index > 0) this.load(index - 1, true);
    else if (queue.length) this.seek(0);
  }

  jumpTo(index: number) {
    this.load(index, true);
  }

  seek(seconds: number) {
    const d = this.state.duration || this.audio.duration || 0;
    const t = Math.max(0, Math.min(seconds, d ? d - 0.25 : seconds));
    this.audio.currentTime = t;
    this.set({ time: t });
  }

  setVolume(v: number) {
    const volume = Math.max(0, Math.min(1, v));
    this.audio.volume = volume;
    this.audio.muted = false;
    this.set({ volume, muted: false });
  }

  toggleMute() {
    this.audio.muted = !this.audio.muted;
    this.set({ muted: this.audio.muted });
  }

  toggleShuffle() {
    const { queue, index, shuffle, order } = this.state;
    const cur = queue[index];
    if (!shuffle) {
      const rest = shuffled(queue.filter((_, i) => i !== index));
      const next = cur ? [cur, ...rest] : rest;
      this.set({ shuffle: true, queue: next, index: 0, order: next.map((t) => queue.indexOf(t)) });
    } else if (order && order.length === queue.length) {
      const restored: Track[] = new Array(queue.length);
      order.forEach((orig, i) => (restored[orig] = queue[i]));
      const clean = restored.filter(Boolean);
      this.set({ shuffle: false, queue: clean, index: Math.max(0, clean.indexOf(cur)), order: null });
    } else {
      this.set({ shuffle: false, order: null });
    }
  }

  cycleRepeat() {
    const next: Repeat = this.state.repeat === "off" ? "all" : this.state.repeat === "all" ? "one" : "off";
    this.set({ repeat: next });
  }

  removeAt(i: number) {
    const { queue, index } = this.state;
    if (i === index) {
      const q = queue.filter((_, j) => j !== i);
      this.set({ queue: q, order: null });
      if (q.length) this.load(Math.min(i, q.length - 1), !this.audio.paused);
      else this.reset();
      return;
    }
    this.set({ queue: queue.filter((_, j) => j !== i), index: i < index ? index - 1 : index, order: null });
  }

  move(from: number, to: number) {
    const q = this.state.queue.slice();
    const [item] = q.splice(from, 1);
    q.splice(to, 0, item);
    let index = this.state.index;
    if (from === index) index = to;
    else if (from < index && to >= index) index--;
    else if (from > index && to <= index) index++;
    this.set({ queue: q, index, order: null });
  }

  clearUpcoming() {
    this.set({ queue: this.state.queue.slice(0, this.state.index + 1), order: null });
  }

  /** Обновить данные трека в очереди (например, после правки тегов или «избранного»). */
  patchTrack(id: number, patch: Partial<Track>) {
    if (!this.state.queue.some((t) => t.id === id)) return;
    this.set({ queue: this.state.queue.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
    if (this.current()?.id === id) this.updateMediaSession();
  }

  reset() {
    this.wantPlay = false;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.set({ queue: [], index: 0, playing: false, time: 0, duration: 0, order: null });
    document.title = "SelfMusic";
  }
}

export const player = new Player();

export function usePlayer<T>(selector: (s: PlayerState) => T): T {
  return useSyncExternalStore(player.subscribe, () => selector(player.getState()));
}

export function useCurrentTrack(): Track | null {
  return usePlayer((s) => s.queue[s.index] ?? null);
}
