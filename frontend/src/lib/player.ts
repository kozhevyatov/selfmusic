/**
 * Плеер: две «деки» <audio> (для кроссфейда и переходов без пауз), очередь, перемешивание,
 * повтор, «Радио» (бесконечное продолжение похожими), выравнивание громкости, эквалайзер,
 * Media Session (экран блокировки и наушники), сохранение очереди и учёт прослушиваний.
 */
import { useSyncExternalStore } from "react";
import { api, coverUrl, streamUrl, type Track } from "./api";
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
import { shuffled } from "./utils";

export type Repeat = "off" | "all" | "one";

export type RadioSeed = { track_id?: number; artist_id?: number; label: string };

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
  private decks: HTMLAudioElement[] = [makeDeck(), makeDeck()];
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
    };
    this.decks.forEach((d, i) => this.bind(d, i));
    this.bindMediaSession();
    onAudioSettings(() => {
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
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
    if (persist) this.persist();
  }

  private persist() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const { queue, index, time, volume, shuffle, repeat, order, radio } = this.state;
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
            order: order?.slice(start, start + 1000) ?? null,
          }),
        );
      } catch {
        /* переполнение или приватный режим */
      }
    }, 400);
  }

  current(): Track | null {
    return this.state.queue[this.state.index] ?? null;
  }

  // ---------- звук ----------

  /** Подключить граф (если нужен) — вызывается из действий пользователя */
  private engage() {
    if (needsGraph() && !hasGraph()) {
      ensureGraph(this.decks);
      this.applyVolume(0);
      this.applyVolume(1);
    }
    resumeGraph();
  }

  private applyVolume(deck: number) {
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
    el.src = track ? streamUrl(track.id) : "";
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
      ms.setActionHandler("seekbackward", (d) => this.seek(this.audio.currentTime - (d.seekOffset ?? 10)));
      ms.setActionHandler("seekforward", (d) => this.seek(this.audio.currentTime + (d.seekOffset ?? 10)));
    } catch {
      /* не поддерживается */
    }
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
    if (s.crossfade <= 0) return 0;
    if (s.crossfadeSkipAlbum && cur.album_id === nxt.album_id) {
      const sameDisc = (cur.disc_no ?? 1) === (nxt.disc_no ?? 1);
      if (sameDisc && (nxt.track_no ?? 0) === (cur.track_no ?? 0) + 1) return 0; // альбом по порядку — не смешиваем
    }
    return s.crossfade;
  }

  /** Следим за концом трека: заранее грузим следующий, запускаем кроссфейд или переход без паузы */
  private watchEnd(a: HTMLAudioElement) {
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

  private load(index: number, autoplay: boolean) {
    const track = this.state.queue[index];
    if (!track) return;
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
    this.set({
      queue,
      order: null,
      shuffle: false,
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
    this.set({ queue, order, shuffle, radio: null });
    this.deckIndex[this.active] = null;
    this.load(index, true);
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
    this.engage();
    if (!this.audio.src || this.audio.error) {
      // Источник не загрузился (например, очередь восстановлена до входа) — грузим заново с того же места
      const at = this.state.time;
      this.deckIndex[this.active] = null;
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
    this.cancelTransition();
    this.audio.pause();
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
    this.wantPlay = false;
    this.cancelTransition();
    this.stopDeck(0);
    this.stopDeck(1);
    this.active = 0;
    this.set({ queue: [], index: 0, playing: false, time: 0, duration: 0, order: null, radio: null });
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
