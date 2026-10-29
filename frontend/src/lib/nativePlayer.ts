/**
 * Звук в Android-приложении: вместо двух <audio> — нативный плеер (expo-audio, плейлист).
 *
 * NativeDeck повторяет нужную плееру часть HTMLAudioElement (play/pause/currentTime/события),
 * поэтому логика очереди, книг, радио и повтора в player.ts общая для сайта и приложения.
 * Отличие одно: переходом к следующему треку управляет сам нативный плеер — он работает,
 * даже когда приложение свёрнуто и страница «спит». Сайт узнаёт о смене трека событием.
 */
import type { Track } from "./api";
import { normalizeGain } from "./audio";
import { sendNative, type NativeItem, type NativeStatus } from "./native";

/** Активная «дека»: команды уходят в нативный плеер, состояние приходит от него. */
export class NativeDeck extends EventTarget {
  src = "";
  preload = "metadata";
  preservesPitch = true;
  readonly readyState = 4;
  readonly error = null;
  volume = 1;
  private _time = 0;
  private _duration = 0;
  private _playing = false;
  private _buffering = false;
  private _rate = 1;
  private _at = performance.now();
  private _metaSent = false;

  get currentTime() {
    if (!this._playing || this._buffering) return this._time;
    const t = this._time + ((performance.now() - this._at) / 1000) * this._rate;
    return this._duration ? Math.min(t, this._duration) : t;
  }
  set currentTime(t: number) {
    this._time = t;
    this._at = performance.now();
    sendNative("seek", { position: t });
  }
  get duration() {
    return this._duration || NaN;
  }
  get paused() {
    return !this._playing;
  }
  get playbackRate() {
    return this._rate;
  }
  set playbackRate(r: number) {
    if (r === this._rate) return;
    this._rate = r;
    sendNative("rate", { rate: r });
  }

  play(): Promise<void> {
    sendNative("play");
    return Promise.resolve();
  }
  pause() {
    sendNative("pause");
  }
  load() {}
  removeAttribute() {}

  /** Новый трек загружен в нативный плеер: сбросить время и снова сообщить «метаданные готовы». */
  newTrack(duration: number) {
    this._time = 0;
    this._at = performance.now();
    this._duration = duration;
    this._metaSent = false;
    if (duration > 0) this.meta();
  }

  private meta() {
    if (this._metaSent) return;
    this._metaSent = true;
    this.dispatchEvent(new Event("durationchange"));
    this.dispatchEvent(new Event("loadedmetadata"));
  }

  /** Состояние от нативного плеера → события, как у <audio> */
  apply(st: NativeStatus) {
    const wasPlaying = this._playing;
    this._time = st.time;
    this._at = performance.now();
    if (st.duration > 0 && st.duration !== this._duration) {
      this._duration = st.duration;
      this.dispatchEvent(new Event("durationchange"));
    }
    if (st.duration > 0) this.meta();
    if (st.buffering !== this._buffering) {
      this._buffering = st.buffering;
      this.dispatchEvent(new Event(st.buffering ? "waiting" : "canplay"));
    }
    if (st.playing !== wasPlaying) {
      this._playing = st.playing;
      if (st.playing) {
        this.dispatchEvent(new Event("play"));
        this.dispatchEvent(new Event("playing"));
      } else this.dispatchEvent(new Event("pause"));
    }
    this.dispatchEvent(new Event("timeupdate"));
  }
}

/** Вторая «дека» (для кроссфейда в браузере) в приложении не нужна — ничего не делает. */
export class InertDeck extends EventTarget {
  src = "";
  preload = "metadata";
  preservesPitch = true;
  readonly readyState = 0;
  readonly error = null;
  readonly paused = true;
  readonly duration = NaN;
  currentTime = 0;
  volume = 1;
  playbackRate = 1;
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause() {}
  load() {}
  removeAttribute() {}
}

function item(t: Track, book: number | null): NativeItem & { track: Track } {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    cover: t.cover,
    duration: t.duration,
    gain: Math.min(1, normalizeGain(t)),
    book,
    track: t, // целиком — чтобы после перезапуска страницы восстановить очередь из приложения
  };
}

/** Что уже отправлено в нативный плеер — чтобы не перезагружать очередь без нужды. */
export class NativeEngine {
  loaded = false;
  private ids = "";

  private key(tracks: Track[]) {
    return tracks.map((t) => t.id).join(",");
  }

  /** Загрузить очередь и начать с index (с позиции position). */
  load(tracks: Track[], index: number, autoplay: boolean, position = 0, book: number | null = null) {
    this.ids = this.key(tracks);
    this.loaded = true;
    sendNative("load", { items: tracks.map((t) => item(t, book)), index, autoplay, position });
  }

  /** Перейти к треку очереди: если очередь та же — без её пересылки. */
  goto(tracks: Track[], index: number, autoplay: boolean, position = 0, book: number | null = null) {
    if (this.loaded && this.key(tracks) === this.ids) sendNative("skip", { index, autoplay, position });
    else this.load(tracks, index, autoplay, position, book);
  }

  /** Очередь изменилась (добавили, убрали, переставили) — текущий трек не прерывается. */
  update(tracks: Track[], index: number, book: number | null = null, force = false) {
    if (!this.loaded) return;
    const k = this.key(tracks);
    if (!force && k === this.ids) return;
    this.ids = k;
    sendNative("queue", { items: tracks.map((t) => item(t, book)), index });
  }

  /** Очередь, которую прислало приложение (страницу перезапустили, а музыка играла). */
  adopt(tracks: Track[]) {
    this.ids = this.key(tracks);
    this.loaded = true;
  }

  stop() {
    this.loaded = false;
    this.ids = "";
    sendNative("stop");
  }
}
