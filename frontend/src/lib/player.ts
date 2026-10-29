/**
 * Плеер: две «деки» <audio> (для кроссфейда и переходов без пауз), очередь, перемешивание,
 * повтор, «Радио» (бесконечное продолжение похожими), выравнивание громкости, эквалайзер,
 * Media Session (экран блокировки и наушники), сохранение очереди и учёт прослушиваний.
 */
import { useSyncExternalStore } from "react";
import { api, coverUrl, streamUrl, type Track } from "./api";
import { isTrackOffline } from "./offline";
import {
  ensureGraph,
  getAudioSettings,
  hasGraph,
  needsGraph,
  normalizeGain,
  onAudioSettings,
  resumeGraph,
  setDeckGain,
} from "./audio";
import { isNative, onNative, sendNative, type NativeEvent } from "./native";
import { InertDeck, NativeDeck, NativeEngine } from "./nativePlayer";
import { shuffled } from "./utils";

export type Repeat = "off" | "all" | "one";

export type RadioSeed = { track_id?: number; artist_id?: number; label: string };

export type BookChapter = { index: number; track_id: number; title: string; start: number; end: number; book_start: number };
/** Режим аудиокниги: главы, скорость, место сохраняется на сервере */
export type BookMode = { id: number; title: string; author: string; cover: string | null; chapters: BookChapter[]; duration: number };
/** Таймер сна: до времени (мс) или до конца главы/трека */
export type SleepTimer = { until: number | null; endOfChapter: boolean } | null;

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
  /** Включено «Радио»: очередь сама продолжается похожими треками */
  radio: RadioSeed | null;
  book: BookMode | null;
  speed: number;
  sleep: SleepTimer;
};

const STORAGE = "sm-player";
const PRELOAD_AHEAD = 25; // сек до конца — начинаем загружать следующий трек

function loadSaved(): Partial<PlayerState> {
  try {
    const raw = localStorage.getItem(STORAGE);
    return raw ? (JSON.parse(raw) as Partial<PlayerState>) : {};
  } catch {
    return {};
  }
}

function makeDeck() {
  const a = new Audio();
  a.preload = "metadata";
  return a;
}

class Player {
  /** Внутри Android-приложения звук играет нативный плеер (см. nativePlayer.ts) */
  private native = isNative;
  private engine = new NativeEngine();
  private decks: HTMLAudioElement[] = isNative
    ? [new NativeDeck() as unknown as HTMLAudioElement, new InertDeck() as unknown as HTMLAudioElement]
    : [makeDeck(), makeDeck()];
  private active = 0;
  /** Какой трек (позиция очереди) загружен на деке */
  private deckIndex: (number | null)[] = [null, null];
  private deckTrackId: (number | null)[] = [null, null];
  /** Множитель кроссфейда для деки 0..1 */
  private fade = [1, 0];
  private fadeTimers: number[] = [0, 0];
  private transition: { from: number; timer: number } | null = null;
  private state: PlayerState;
  private listeners = new Set<() => void>();
  private scrobbled = new Set<string>();
  private playStartedFor = "";
  private errors = 0;
  private saveTimer = 0;
  private radioLoading = false;
  /** Пользователь хочет, чтобы играло (а не просто восстановлена очередь) */
  private wantPlay = false;

  constructor() {
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
      radio: saved.radio ?? null,
      book: saved.book ?? null,
      speed: saved.book ? (saved.speed ?? 1) : 1,
      sleep: null,
    };
    this.decks.forEach((d, i) => this.bind(d, i));
    if (this.native) {
      onNative((e) => this.onNativeEvent(e));
      sendNative("hello"); // если в приложении уже что-то играет — оно пришлёт свою очередь
    } else this.bindMediaSession();
    // закрывают вкладку / сворачивают приложение — точную позицию сохраняем сразу
    window.addEventListener("pagehide", () => this.writeStorage());
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && this.writeStorage());
    onAudioSettings(() => {
      if (this.native) {
        // выравнивание громкости — множитель у каждого трека в нативной очереди
        this.engine.update(this.state.queue, this.state.index, this.state.book?.id ?? null, true);
        return;
      }
      // включили эквалайзер/выравнивание/кроссфейд — подключаем граф (настройку меняют нажатием, так что можно)
      if (needsGraph() && !hasGraph() && this.current()) ensureGraph(this.decks);
      this.applyVolume(0);
      this.applyVolume(1);
    });
    const cur = this.current();
    if (cur) {
      // Восстанавливаем трек без автозапуска — пользователь нажмёт «Играть»
      this.setDeckSource(this.active, this.state.index);
      const resumeAt = this.state.time;
      this.audio.addEventListener(
        "loadedmetadata",
        () => {
          if (resumeAt > 0 && resumeAt < this.audio.duration - 2) this.audio.currentTime = resumeAt;
        },
        { once: true },
      );
      this.applyVolume(this.active);
      this.updateMediaSession();
    }
  }

  private get audio() {
    return this.decks[this.active];
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
    const prev = this.state;
    this.state = { ...this.state, ...patch };
    if (this.native) {
      if (patch.repeat !== undefined && patch.repeat !== prev.repeat) sendNative("repeat", { mode: patch.repeat });
      // очередь поменялась (добавили, убрали, переставили, радио дописало) — сообщим приложению
      if (patch.queue !== undefined && patch.queue !== prev.queue) queueMicrotask(() => this.engine.update(this.state.queue, this.state.index, this.state.book?.id ?? null));
    }
    this.listeners.forEach((l) => l());
    if (persist) this.persist();
  }

  /** Сохранение в localStorage не чаще раза в секунду: время обновляется 4 раза в секунду,
   *  и «откладывать до тишины» значило бы не сохранять позицию, пока играет музыка. */
  private persist() {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      this.writeStorage();
    }, 1000);
  }

  private writeStorage() {
    const { queue, index, time, volume, shuffle, repeat, order, radio, book, speed } = this.state;
    try {
      // Очередь может быть длинной — храним не больше 1000 треков вокруг текущего
      const start = Math.max(0, index - 200);
      const slice = queue.slice(start, start + 1000);
      localStorage.setItem(
        STORAGE,
        JSON.stringify({
          queue: slice,
          index: index - start,
          time,
          volume,
          shuffle,
          repeat,
          radio,
          book,
          speed,
          order: order?.slice(start, start + 1000) ?? null,
        }),
      );
    } catch {
      /* переполнение или приватный режим */
    }
  }

  current(): Track | null {
    return this.state.queue[this.state.index] ?? null;
  }

  // ---------- звук ----------

  /** Подключить граф (если нужен) — вызывается из действий пользователя */
  private engage() {
    if (this.native) return; // эквалайзер и кроссфейд — только в браузере
    if (needsGraph() && !hasGraph()) {
      ensureGraph(this.decks);
      this.applyVolume(0);
      this.applyVolume(1);
    }
    resumeGraph();
  }

  private applyVolume(deck: number) {
    if (this.native) {
      // выравнивание громкости приложение применяет само (множитель у трека); здесь — общая громкость
      if (deck === 0) sendNative("volume", { volume: this.state.muted ? 0 : this.state.volume });
      return;
    }
    const el = this.decks[deck];
    const idx = this.deckIndex[deck];
    const track = idx !== null ? this.state.queue[idx] : null;
    const norm = normalizeGain(track);
    const master = this.state.muted ? 0 : this.state.volume;
    if (hasGraph()) {
      el.volume = master;
      setDeckGain(deck, norm * this.fade[deck]);
    } else {
      // без графа можно только приглушить (усилить <audio> не умеет)
      el.volume = Math.max(0, Math.min(1, master * Math.min(1, norm) * this.fade[deck]));
    }
  }

  /** Плавно изменить множитель деки от текущего до target за secs секунд */
  private rampFade(deck: number, target: number, secs: number) {
    window.clearInterval(this.fadeTimers[deck]);
    if (secs <= 0) {
      this.fade[deck] = target;
      this.applyVolume(deck);
      return;
    }
    if (hasGraph()) {
      // в графе — точная автоматизация громкости
      const idx = this.deckIndex[deck];
      const norm = normalizeGain(idx !== null ? this.state.queue[idx] : null);
      this.fade[deck] = target;
      setDeckGain(deck, norm * target, secs);
      return;
    }
    const start = this.fade[deck];
    const t0 = performance.now();
    this.fadeTimers[deck] = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / (secs * 1000));
      // «равная мощность»: звук не проседает в середине перехода
      this.fade[deck] = target > start ? Math.sin((k * Math.PI) / 2) * (target - start) + start : start - Math.sin((k * Math.PI) / 2) * (start - target);
      this.applyVolume(deck);
      if (k >= 1) window.clearInterval(this.fadeTimers[deck]);
    }, 40);
  }

  private setDeckSource(deck: number, index: number) {
    const track = this.state.queue[index];
    const el = this.decks[deck];
    this.deckIndex[deck] = index;
    this.deckTrackId[deck] = track?.id ?? null;
    // ?dl=1 — трек скачан: service worker отдаст его из хранилища. Остальные потоки он не трогает вовсе:
    // Safari (iPhone) при проходе через service worker теряет Range и начинает трек заново.
    el.src = track ? streamUrl(track.id) + (isTrackOffline(track.id) ? "?dl=1" : "") : "";
  }

  private stopDeck(deck: number) {
    window.clearInterval(this.fadeTimers[deck]);
    const el = this.decks[deck];
    el.pause();
    el.removeAttribute("src");
    el.load();
    this.deckIndex[deck] = null;
    this.deckTrackId[deck] = null;
    this.fade[deck] = 0;
  }

  // ---------- события <audio> ----------

  private bind(a: HTMLAudioElement, deck: number) {
    const isActive = () => deck === this.active;
    a.addEventListener("play", () => isActive() && this.set({ playing: true }, false));
    a.addEventListener("pause", () => isActive() && !this.transition && this.set({ playing: false }));
    a.addEventListener("waiting", () => isActive() && this.set({ loading: true }, false));
    a.addEventListener("playing", () => {
      if (!isActive()) return;
      this.errors = 0;
      this.set({ loading: false, playing: true }, false);
    });
    a.addEventListener("canplay", () => isActive() && this.set({ loading: false }, false));
    a.addEventListener("durationchange", () => {
      if (!isActive()) return;
      const cur = this.current();
      const d = isFinite(a.duration) ? a.duration : (cur?.duration ?? 0);
      this.set({ duration: d }, false);
    });
    let lastTick = 0;
    a.addEventListener("timeupdate", () => {
      if (!isActive()) return;
      this.watchEnd(a);
      const now = performance.now();
      if (now - lastTick < 250) return;
      lastTick = now;
      this.set({ time: a.currentTime });
      this.maybeScrobble();
      this.checkSleep();
      this.maybeSyncBook();
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
    a.addEventListener("ended", () => isActive() && !this.transition && this.onEnded());
    a.addEventListener("error", () => {
      if (!isActive() || !a.src || !this.current() || !this.wantPlay) return;
      this.errors++;
      this.set({ loading: false, playing: false }, false);
      window.dispatchEvent(new CustomEvent("sm:player-error", { detail: this.current()?.title }));
      if (this.errors < Math.min(5, this.state.queue.length)) window.setTimeout(() => this.next(true), 800);
    });
  }

  private bindMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => this.resume());
    ms.setActionHandler("pause", () => this.pause());
    ms.setActionHandler("previoustrack", () => this.prev());
    ms.setActionHandler("nexttrack", () => this.next());
    try {
      ms.setActionHandler("seekto", (d) => d.seekTime !== undefined && this.seek(d.seekTime));
      // в книге — привычные −15 / +30 секунд
      ms.setActionHandler("seekbackward", (d) => this.skip(-(d.seekOffset ?? (this.state.book ? 15 : 10))));
      ms.setActionHandler("seekforward", (d) => this.skip(d.seekOffset ?? (this.state.book ? 30 : 10)));
    } catch {
      /* не поддерживается */
    }
  }

  // ---------- Android-приложение ----------

  private onNativeEvent(e: NativeEvent) {
    const deck = this.decks[0] as unknown as NativeDeck;
    switch (e.type) {
      case "status": {
        // нативный плеер сам перешёл к другому треку (конец трека, кнопка в наушниках, экран блокировки)
        if (e.index !== this.state.index && this.state.queue[e.index]?.id === e.id) this.onNativeTrack(e.index, e.duration);
        deck.apply(e);
        break;
      }
      case "track":
        if (e.index !== this.state.index && this.state.queue[e.index]?.id === e.id) this.onNativeTrack(e.index, e.duration);
        break;
      case "ended":
        this.wantPlay = false;
        this.set({ playing: false });
        break;
      case "sleep-done":
        this.set({ sleep: null });
        break;
      case "error":
        window.dispatchEvent(new CustomEvent("sm:player-error", { detail: this.state.queue.find((t) => t.id === e.id)?.title }));
        break;
      case "session": {
        // страницу перезапустили (обновление сайта), а музыка в приложении продолжала играть
        const tracks = e.tracks as Track[];
        if (!tracks.length) break;
        this.engine.adopt(tracks);
        this.deckIndex[0] = e.index;
        this.deckTrackId[0] = tracks[e.index]?.id ?? null;
        deck.newTrack(e.duration);
        this.set({ queue: tracks, index: e.index, time: e.time, duration: e.duration || tracks[e.index]?.duration || 0, order: null });
        deck.apply({ index: e.index, id: tracks[e.index]?.id ?? null, time: e.time, duration: e.duration, playing: e.playing, buffering: false });
        this.wantPlay = e.playing;
        if (e.playing) this.startTracking();
        this.updateMediaSession();
        break;
      }
    }
  }

  private onNativeTrack(index: number, duration: number) {
    const track = this.state.queue[index];
    this.deckIndex[0] = index;
    this.deckTrackId[0] = track?.id ?? null;
    (this.decks[0] as unknown as NativeDeck).newTrack(duration || track?.duration || 0);
    this.set({ index, time: 0, duration: duration || track?.duration || 0 });
    this.startTracking();
    this.updateMediaSession();
    this.maybeExtendRadio();
  }

  // ---------- переходы между треками ----------

  private nextIndex(): number | null {
    const { index, queue, repeat } = this.state;
    if (repeat === "one") return null;
    if (index < queue.length - 1) return index + 1;
    if (repeat === "all" && queue.length > 1) return 0;
    return null;
  }

  /** Сколько секунд смешивать текущий и следующий (0 — без кроссфейда) */
  private crossfadeFor(cur: Track, nxt: Track): number {
    const s = getAudioSettings();
    if (s.crossfade <= 0 || this.state.book) return 0; // книги не смешиваем
    if (s.crossfadeSkipAlbum && cur.album_id === nxt.album_id) {
      const sameDisc = (cur.disc_no ?? 1) === (nxt.disc_no ?? 1);
      if (sameDisc && (nxt.track_no ?? 0) === (cur.track_no ?? 0) + 1) return 0; // альбом по порядку — не смешиваем
    }
    return s.crossfade;
  }

  /** Следим за концом трека: заранее грузим следующий, запускаем кроссфейд или переход без паузы */
  private watchEnd(a: HTMLAudioElement) {
    if (this.native) return; // следующий трек включает нативный плеер
    if (this.transition || a.paused || !isFinite(a.duration) || a.duration < 5) return;
    const ni = this.nextIndex();
    if (ni === null) return;
    const cur = this.current();
    const nxt = this.state.queue[ni];
    if (!cur || !nxt) return;
    const rem = a.duration - a.currentTime;
    const cf = Math.min(this.crossfadeFor(cur, nxt), a.duration / 3);
    // «Без пауз»: следующий трек заранее загружен на второй деке, и по окончании текущего
    // переключение занимает ~10 мс (замерено) — на слух слитно. Без этого — обычная загрузка.
    if ((cf > 0 || getAudioSettings().gapless) && rem < cf + PRELOAD_AHEAD) this.preload(ni);
    if (cf > 0 && rem <= cf) this.beginTransition(ni, rem);
  }

  private preload(index: number) {
    const sb = 1 - this.active;
    if (this.deckIndex[sb] === index && this.deckTrackId[sb] === this.state.queue[index]?.id) return;
    window.clearInterval(this.fadeTimers[sb]);
    this.decks[sb].pause();
    this.setDeckSource(sb, index);
    this.decks[sb].preload = "auto";
    this.fade[sb] = 0;
    this.applyVolume(sb);
    this.decks[sb].load();
  }

  private beginTransition(index: number, secs: number) {
    const from = this.active;
    const to = 1 - from;
    if (this.deckIndex[to] !== index || this.deckTrackId[to] !== this.state.queue[index]?.id) this.preload(index);
    const toEl = this.decks[to];
    try {
      if (toEl.currentTime > 0) toEl.currentTime = 0;
    } catch {
      /* ещё не загрузился */
    }
    this.active = to;
    const track = this.state.queue[index];
    this.set({ index, time: 0, duration: track.duration, loading: toEl.readyState < 3 });
    this.startTracking();
    this.updateMediaSession();
    this.wantPlay = true;
    this.fade[to] = secs > 0 ? 0 : 1;
    this.applyVolume(to);
    this.applyRate();
    toEl.play().catch(() => this.set({ playing: false, loading: false }, false));
    if (secs > 0) {
      this.rampFade(to, 1, secs);
      this.rampFade(from, 0, secs);
      const timer = window.setTimeout(() => {
        this.stopDeck(from);
        this.transition = null;
      }, secs * 1000 + 150);
      this.transition = { from, timer };
    } else {
      this.stopDeck(from);
    }
    this.maybeExtendRadio();
  }

  private cancelTransition() {
    if (this.transition) {
      window.clearTimeout(this.transition.timer);
      this.stopDeck(this.transition.from);
      this.transition = null;
    }
  }

  private maybeScrobble() {
    if (this.native) return; // прослушивания засчитывает приложение (и в фоне тоже)
    const cur = this.current();
    if (!cur || this.state.book) return;
    const key = `${this.playStartedFor}`;
    if (!key || this.scrobbled.has(key)) return;
    const d = this.state.duration || cur.duration;
    if (this.audio.currentTime >= Math.min(240, Math.max(20, d * 0.5))) {
      this.scrobbled.add(key);
      api.library.recordPlay(cur.id).catch(() => {});
    }
  }

  private onEnded() {
    if (this.state.sleep?.endOfChapter) {
      this.sleepNow();
      this.set({ playing: false });
      return;
    }
    if (this.state.repeat === "one") {
      this.audio.currentTime = 0;
      this.startTracking();
      this.audio.play().catch(() => {});
      return;
    }
    const ni = this.nextIndex();
    if (ni !== null) this.load(ni, true);
    else if (this.state.repeat === "all" && this.state.queue.length) {
      this.deckIndex[this.active] = null; // очередь из одного трека — начать его заново
      this.load(0, true);
    } else this.set({ playing: false, time: 0 });
  }

  private startTracking() {
    this.playStartedFor = `${this.current()?.id}:${Date.now()}`;
  }

  private load(index: number, autoplay: boolean, position = 0) {
    const track = this.state.queue[index];
    if (!track) return;
    if (this.native) {
      this.deckIndex[0] = index;
      this.deckTrackId[0] = track.id;
      (this.decks[0] as unknown as NativeDeck).newTrack(0);
      this.engine.goto(this.state.queue, index, autoplay, position, this.state.book?.id ?? null);
      this.set({ index, time: position, duration: track.duration, loading: autoplay });
      this.startTracking();
      this.updateMediaSession();
      this.wantPlay = autoplay;
      this.maybeExtendRadio();
      return;
    }
    this.cancelTransition();
    const sb = 1 - this.active;
    if (this.deckIndex[sb] === index && this.deckTrackId[sb] === track.id) {
      // следующий уже загружен на второй деке — переключаемся на неё без ожидания
      this.stopDeck(this.active);
      this.active = sb;
      try {
        this.audio.currentTime = 0;
      } catch {
        /* ещё не загрузился */
      }
    } else {
      this.stopDeck(sb);
      this.setDeckSource(this.active, index);
    }
    this.fade[this.active] = 1;
    this.applyVolume(this.active);
    this.applyRate();
    this.set({ index, time: 0, duration: track.duration, loading: autoplay });
    this.startTracking();
    this.updateMediaSession();
    this.wantPlay = autoplay;
    if (autoplay) {
      this.audio.play().catch(() => this.set({ playing: false, loading: false }, false));
    }
    this.maybeExtendRadio();
  }

  private updateMediaSession() {
    const t = this.current();
    if (t && this.native) {
      document.title = `${t.title} · ${t.artist}`; // экран блокировки — у приложения
      return;
    }
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

  // ---------- аудиокниги ----------

  private pausedAt = 0;
  private lastBookSync = 0;

  private applyRate() {
    for (const d of this.decks) {
      d.playbackRate = this.state.speed;
      try {
        d.preservesPitch = true; // голос не становится «мультяшным»
      } catch {
        /* старые браузеры */
      }
    }
  }

  /** Включить книгу с сохранённого места (или с главы chapterIndex) */
  playBook(book: BookMode, tracks: Track[], opts: { trackId?: number; position?: number; speed?: number } = {}) {
    if (!tracks.length) return;
    this.engage();
    this.syncBook(true);
    const index = Math.max(0, opts.trackId ? tracks.findIndex((t) => t.id === opts.trackId) : 0);
    this.stopDeck(1 - this.active);
    this.set({ queue: tracks, order: null, shuffle: false, radio: null, book, speed: opts.speed ?? 1, repeat: "off" });
    this.deckIndex[this.active] = null;
    const at = opts.position ?? 0;
    if (this.native) return this.load(index, true, at > 1 ? Math.max(0, at - 2) : 0);
    this.load(index, true);
    if (at > 1) this.audio.addEventListener("loadedmetadata", () => this.seek(Math.max(0, at - 2)), { once: true });
  }

  setSpeed(speed: number) {
    this.set({ speed: Math.max(0.5, Math.min(3, Math.round(speed * 100) / 100)) });
    this.applyRate();
    this.syncBook(true);
  }

  /** Перемотка на секунды (−15 / +30). В книге из многих файлов — с переходом между главами. */
  skip(seconds: number) {
    const a = this.audio;
    const target = a.currentTime + seconds;
    const d = this.state.duration || a.duration || 0;
    if (target < 0 && this.state.index > 0 && this.state.book) {
      const prev = this.state.queue[this.state.index - 1];
      this.load(this.state.index - 1, !a.paused);
      this.audio.addEventListener("loadedmetadata", () => this.seek(Math.max(0, (prev.duration || 0) + target)), { once: true });
      return;
    }
    if (d && target > d - 0.5 && this.state.index < this.state.queue.length - 1) {
      this.load(this.state.index + 1, !a.paused);
      return;
    }
    this.seek(Math.max(0, target));
  }

  /** Номер текущей главы (с учётом глав внутри одного файла) */
  chapterIndex(): number {
    const { book, index, time } = this.state;
    const cur = this.current();
    if (!book || !cur) return -1;
    let found = -1;
    book.chapters.forEach((c, i) => {
      if (c.track_id === cur.id && c.start <= time + 0.5) found = i;
    });
    return found >= 0 ? found : index;
  }

  jumpToChapter(i: number) {
    const ch = this.state.book?.chapters[i];
    if (!ch) return;
    this.engage();
    const ti = this.state.queue.findIndex((t) => t.id === ch.track_id);
    if (ti < 0) return;
    if (ti === this.state.index) {
      this.seek(ch.start);
      if (this.audio.paused) this.resume();
    } else {
      this.load(ti, true);
      if (ch.start > 0) this.audio.addEventListener("loadedmetadata", () => this.seek(ch.start), { once: true });
    }
  }

  /** Предыдущая глава (или начало текущей, если прошло больше 4 секунд) */
  prevChapter() {
    const i = this.chapterIndex();
    const ch = this.state.book?.chapters[i];
    if (ch && this.audio.currentTime - ch.start > 4) return this.seek(ch.start);
    if (i > 0) this.jumpToChapter(i - 1);
    else this.seek(0);
  }

  nextChapter() {
    const i = this.chapterIndex();
    if (this.state.book && i < this.state.book.chapters.length - 1) this.jumpToChapter(i + 1);
  }

  /** Как в BookPlayer: после паузы чуть отматываем назад, чтобы вспомнить, на чём остановились */
  private autoRewind() {
    if (!this.state.book || !this.pausedAt) return;
    const paused = (Date.now() - this.pausedAt) / 1000;
    this.pausedAt = 0;
    const back = paused < 10 ? 0 : paused < 60 ? 3 : paused < 600 ? 10 : paused < 3600 ? 20 : 30;
    if (back) this.seek(Math.max(0, this.audio.currentTime - back));
  }

  private maybeSyncBook() {
    if (this.state.book && Date.now() - this.lastBookSync > 15000) this.syncBook(false);
  }

  /** Сохранить место в книге на сервере (и локально — если нет связи, отправим позже) */
  private syncBook(force: boolean) {
    const { book } = this.state;
    const cur = this.current();
    if (!book || !cur) return;
    if (!force && Date.now() - this.lastBookSync < 15000) return;
    this.lastBookSync = Date.now();
    const body = { track_id: cur.id, position: this.audio.currentTime || this.state.time, speed: this.state.speed };
    try {
      localStorage.setItem(`sm-book-${book.id}`, JSON.stringify({ ...body, at: Date.now() }));
    } catch {
      /* приватный режим */
    }
    api.books.progress(book.id, body).catch(() => {});
  }

  // ---------- таймер сна ----------

  /** minutes — через сколько остановить; "chapter" — в конце главы/трека; null — выключить */
  setSleep(value: number | "chapter" | null) {
    if (this.native) {
      // в фоне страница «спит» — таймер ведёт приложение
      sendNative("sleep", value === null ? { until: null, endOfTrack: false } : value === "chapter" ? { until: null, endOfTrack: true } : { until: Date.now() + value * 60_000, endOfTrack: false });
    }
    if (value === null) return this.set({ sleep: null });
    if (value === "chapter") return this.set({ sleep: { until: null, endOfChapter: true } });
    this.set({ sleep: { until: Date.now() + value * 60_000, endOfChapter: false } });
  }

  private sleepChapter = -2;

  private checkSleep() {
    const { sleep } = this.state;
    if (!sleep || this.native) return;
    const a = this.audio;
    if (sleep.until) {
      const left = (sleep.until - Date.now()) / 1000;
      // последние 10 секунд — плавно тише
      if (left <= 10 && left > 0) {
        this.fade[this.active] = Math.max(0, left / 10);
        this.applyVolume(this.active);
      }
      if (left <= 0) this.sleepNow();
      return;
    }
    if (sleep.endOfChapter) {
      const ci = this.chapterIndex();
      if (this.sleepChapter === -2) this.sleepChapter = ci;
      const ch = this.state.book?.chapters[ci];
      const end = ch && ch.end > ch.start && this.state.book && this.state.book.chapters.filter((c) => c.track_id === ch.track_id).length > 1 ? ch.end : a.duration;
      if (ci !== this.sleepChapter || (isFinite(end) && a.currentTime >= end - 0.4)) this.sleepNow();
    }
  }

  private sleepNow() {
    this.sleepChapter = -2;
    this.set({ sleep: null });
    this.pause();
    this.fade[this.active] = 1;
    this.applyVolume(this.active);
  }

  // ---------- радио ----------

  /** Включить «Радио»: похожие на трек (он играет первым) или на исполнителя. */
  async startRadio(seed: { track?: Track; artist_id?: number; label: string }) {
    this.engage();
    const res = await api.library.radio({
      track_id: seed.track?.id,
      artist_id: seed.artist_id,
      count: 30,
    });
    const queue = seed.track ? [seed.track, ...res.tracks] : res.tracks;
    if (!queue.length) throw new Error("Не нашлось похожих треков");
    this.syncBook(true);
    this.set({
      queue,
      order: null,
      shuffle: false,
      book: null,
      speed: 1,
      radio: { track_id: seed.track?.id, artist_id: seed.artist_id, label: seed.label },
    });
    this.load(0, true);
  }

  stopRadio() {
    this.set({ radio: null });
  }

  /** Радио: когда до конца очереди осталось 3 трека — дозапрашиваем похожие на текущий */
  private maybeExtendRadio() {
    const { radio, index, queue } = this.state;
    if (!radio || this.radioLoading || index < queue.length - 3) return;
    const cur = this.current();
    this.radioLoading = true;
    api.library
      .radio({
        track_id: cur?.id ?? radio.track_id,
        artist_id: cur ? undefined : radio.artist_id,
        exclude: queue.slice(-1000).map((t) => t.id),
        count: 25,
      })
      .then((res) => {
        if (!this.state.radio || !res.tracks.length) return;
        this.set({ queue: [...this.state.queue, ...res.tracks] });
      })
      .catch(() => {})
      .finally(() => {
        this.radioLoading = false;
      });
  }

  // ---------- действия ----------

  /** Начать играть список с позиции start. */
  play(tracks: Track[], start = 0, opts: { shuffle?: boolean } = {}) {
    if (!tracks.length) return;
    this.engage();
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
    // новая очередь — позиции на деках больше не совпадают
    this.stopDeck(1 - this.active);
    this.syncBook(true);
    this.set({ queue, order, shuffle, radio: null, book: null, speed: 1 });
    this.deckIndex[this.active] = null;
    this.load(index, true);
  }

  /** Подхватить очередь с другого устройства: трек index с позиции time.
   *  autoplay — только по нажатию пользователя (иначе браузер не даст включить звук). */
  adoptQueue(tracks: Track[], index: number, time: number, autoplay: boolean) {
    if (!tracks[index]) return;
    if (autoplay) this.engage();
    this.stopDeck(1 - this.active);
    this.syncBook(true);
    this.set({ queue: tracks, order: null, shuffle: false, radio: null, book: null, speed: 1 });
    this.deckIndex[this.active] = null;
    if (this.native) {
      this.load(index, autoplay, time > 1 ? time : 0);
      if (time > 1) this.set({ time });
      return;
    }
    this.load(index, autoplay);
    if (time > 1) {
      const a = this.audio;
      const apply = () => {
        if (time < a.duration - 2) a.currentTime = time;
      };
      if (a.readyState >= 1) apply();
      else a.addEventListener("loadedmetadata", apply, { once: true });
      this.set({ time });
    }
  }

  playNext(tracks: Track[]) {
    if (!this.state.queue.length) return this.play(tracks);
    const q = this.state.queue.slice();
    q.splice(this.state.index + 1, 0, ...tracks);
    this.invalidateStandby();
    this.set({ queue: q, order: null });
  }

  enqueue(tracks: Track[]) {
    if (!this.state.queue.length) return this.play(tracks);
    this.set({ queue: [...this.state.queue, ...tracks], order: null });
  }

  /** Очередь изменилась перед текущим следующим — подгруженный «следующий» может быть уже не тем */
  private invalidateStandby() {
    if (this.transition) return;
    const sb = 1 - this.active;
    if (this.deckIndex[sb] !== null) this.stopDeck(sb);
  }

  toggle() {
    if (this.audio.paused) this.resume();
    else this.pause();
  }

  resume() {
    if (!this.current()) return;
    if (this.native && !this.engine.loaded) {
      // очередь восстановлена из памяти страницы, а в нативный плеер ещё не отправлена
      this.wantPlay = true;
      this.load(this.state.index, true, this.state.time > 1 ? this.state.time : 0);
      return;
    }
    this.engage();
    if (!this.audio.src || this.audio.error) {
      // Источник не загрузился (например, очередь восстановлена до входа) — грузим заново с того же места
      const at = this.state.time;
      this.deckIndex[this.active] = null;
      this.load(this.state.index, true);
      if (at > 0) this.audio.addEventListener("loadedmetadata", () => this.seek(at), { once: true });
    } else {
      if (!this.playStartedFor) this.startTracking();
      this.autoRewind();
      this.wantPlay = true;
      this.audio.play().catch(() => {});
    }
  }

  pause() {
    this.wantPlay = false;
    this.cancelTransition();
    this.audio.pause();
    this.pausedAt = Date.now();
    this.syncBook(true);
  }

  next(auto = false) {
    if (!auto) this.engage();
    const { index, queue, repeat } = this.state;
    if (index < queue.length - 1) this.load(index + 1, true);
    else if (repeat === "all" || !auto) {
      if (queue.length) this.load(0, repeat === "all" || !auto);
    }
  }

  prev() {
    this.engage();
    if (this.audio.currentTime > 4) {
      this.seek(0);
      return;
    }
    const { index, queue } = this.state;
    if (index > 0) this.load(index - 1, true);
    else if (queue.length) this.seek(0);
  }

  jumpTo(index: number) {
    this.engage();
    this.load(index, true);
  }

  seek(seconds: number) {
    this.cancelTransition();
    const d = this.state.duration || this.audio.duration || 0;
    const t = Math.max(0, Math.min(seconds, d ? d - 0.25 : seconds));
    this.audio.currentTime = t;
    this.set({ time: t });
  }

  setVolume(v: number) {
    const volume = Math.max(0, Math.min(1, v));
    this.set({ volume, muted: false });
    this.applyVolume(0);
    this.applyVolume(1);
  }

  toggleMute() {
    this.set({ muted: !this.state.muted });
    this.applyVolume(0);
    this.applyVolume(1);
  }

  toggleShuffle() {
    const { queue, index, shuffle, order } = this.state;
    const cur = queue[index];
    this.invalidateStandby();
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
    this.deckIndex[this.active] = this.state.index;
  }

  cycleRepeat() {
    const next: Repeat = this.state.repeat === "off" ? "all" : this.state.repeat === "all" ? "one" : "off";
    this.set({ repeat: next });
  }

  removeAt(i: number) {
    const { queue, index } = this.state;
    this.invalidateStandby();
    if (i === index) {
      const q = queue.filter((_, j) => j !== i);
      this.set({ queue: q, order: null });
      if (q.length) {
        this.deckIndex[this.active] = null;
        this.load(Math.min(i, q.length - 1), !this.audio.paused);
      } else this.reset();
      return;
    }
    const newIndex = i < index ? index - 1 : index;
    this.set({ queue: queue.filter((_, j) => j !== i), index: newIndex, order: null });
    this.deckIndex[this.active] = newIndex;
  }

  move(from: number, to: number) {
    const q = this.state.queue.slice();
    const [item] = q.splice(from, 1);
    q.splice(to, 0, item);
    let index = this.state.index;
    if (from === index) index = to;
    else if (from < index && to >= index) index--;
    else if (from > index && to <= index) index++;
    this.invalidateStandby();
    this.set({ queue: q, index, order: null });
    this.deckIndex[this.active] = index;
  }

  clearUpcoming() {
    this.invalidateStandby();
    this.set({ queue: this.state.queue.slice(0, this.state.index + 1), order: null, radio: null });
  }

  /** Обновить данные трека в очереди (например, после правки тегов или «избранного»). */
  patchTrack(id: number, patch: Partial<Track>) {
    if (!this.state.queue.some((t) => t.id === id)) return;
    this.set({ queue: this.state.queue.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
    if (this.current()?.id === id) this.updateMediaSession();
  }

  reset() {
    if (this.native) this.engine.stop();
    this.wantPlay = false;
    this.cancelTransition();
    this.stopDeck(0);
    this.stopDeck(1);
    this.active = 0;
    this.set({ queue: [], index: 0, playing: false, time: 0, duration: 0, order: null, radio: null, book: null, speed: 1, sleep: null });
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
