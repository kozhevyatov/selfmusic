/**
 * Нативный плеер приложения: плейлист expo-audio (Media3/ExoPlayer под капотом).
 *
 * Очередь целиком лежит в нативном плейлисте, поэтому переход к следующему треку,
 * кнопки «назад/вперёд» на экране блокировки и в наушниках работают, даже когда
 * приложение свёрнуто и страница во WebView «спит».
 *
 * Сам, без страницы, плеер ещё:
 *  • засчитывает прослушивания (как сайт: после половины трека или 4 минут);
 *  • сохраняет место в аудиокниге на сервере;
 *  • останавливает музыку по таймеру сна.
 */
import { createAudioPlaylist, setAudioModeAsync } from "expo-audio";
import { apiCall, mediaUrl } from "./session";

export type Item = {
  id: number;
  title: string;
  artist: string;
  album: string;
  cover: string | null;
  duration: number;
  gain: number;
  book: number | null;
  track: unknown; // трек целиком, как его прислал сайт, — вернуть после перезапуска страницы
};

export type PlayerEvent =
  | { type: "status"; index: number; id: number | null; time: number; duration: number; playing: boolean; buffering: boolean }
  | { type: "track"; index: number; id: number | null; duration: number }
  | { type: "ended" }
  | { type: "error"; message: string; id: number | null }
  | { type: "sleep-done" }
  | { type: "session"; tracks: unknown[]; index: number; time: number; duration: number; playing: boolean };

type Listener = (e: PlayerEvent) => void;

// API плейлиста expo-audio (SDK 58): add/insert/remove/clear/next/previous/skipTo/play/pause/seekTo,
// currentIndex, loop, volume, playbackRate, события trackChanged и playlistStatusUpdate.
type Playlist = any; // eslint-disable-line @typescript-eslint/no-explicit-any

class NativePlayer {
  private pl: Playlist | null = null;
  private items: Item[] = [];
  private index = 0;
  private volume = 1;
  private rate = 1;
  private repeat: "off" | "all" | "one" = "off";
  private listeners = new Set<Listener>();
  private status = { time: 0, duration: 0, playing: false, buffering: false };
  private lockScreen = false;
  // пока плейлист перестраивается, промежуточные «трек сменился» игнорируем — ждём нужный номер
  private pending: number | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  // учёт прослушиваний
  private playKey = "";
  private scrobbled = new Set<string>();
  // аудиокнига
  private lastBookSave = 0;
  // таймер сна
  private sleepUntil: number | null = null;
  private sleepEndOfTrack = false;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(e: PlayerEvent) {
    this.listeners.forEach((fn) => {
      try {
        fn(e);
      } catch {
        /* слушатель упал — плеер продолжает */
      }
    });
  }

  private async ensure(): Promise<Playlist> {
    if (this.pl) return this.pl;
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "doNotMix",
    } as never);
    const pl = createAudioPlaylist({ sources: [], loop: "none", updateInterval: 500 } as never) as Playlist;
    pl.addListener?.("trackChanged", (e: { currentIndex: number; previousIndex?: number }) => this.onTrack(e.currentIndex));
    pl.addListener?.("playlistStatusUpdate", (st: Record<string, unknown>) => this.onStatus(st));
    this.pl = pl;
    return pl;
  }

  private source(it: Item) {
    return { uri: mediaUrl(`/api/stream/${it.id}`) };
  }

  private meta(it: Item) {
    return {
      title: it.title,
      artist: it.artist,
      albumTitle: it.album,
      artworkUrl: it.cover ? mediaUrl(it.cover.replace(/size=\d+/, "size=512")) : undefined,
    };
  }

  private expect(index: number) {
    this.pending = index;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => (this.pending = null), 3000);
  }

  private current(): Item | null {
    return this.items[this.index] ?? null;
  }

  private applyVolume() {
    const it = this.current();
    if (this.pl) this.pl.volume = Math.max(0, Math.min(1, this.volume * (it?.gain ?? 1)));
  }

  private showOnLockScreen() {
    const it = this.current();
    if (!this.pl || !it) return;
    try {
      if (!this.lockScreen) {
        this.pl.setActiveForLockScreen(true, this.meta(it), {
          showNextTrack: true,
          showPreviousTrack: true,
          showSeekForward: it.book !== null,
          showSeekBackward: it.book !== null,
        });
        this.lockScreen = true;
      } else this.pl.updateLockScreenMetadata?.(this.meta(it));
    } catch {
      /* старое API — без карточки на экране блокировки */
    }
  }

  // ---------------- команды от страницы ----------------

  async load(items: Item[], index: number, autoplay: boolean, position: number) {
    const pl = await this.ensure();
    this.saveBook(true);
    this.items = items;
    this.index = Math.max(0, Math.min(index, items.length - 1));
    this.expect(this.index);
    pl.pause?.();
    pl.clear();
    for (const it of items) pl.add(this.source(it));
    pl.skipTo(this.index);
    this.applyLoop();
    this.applyVolume();
    this.applyRate();
    this.startTrack();
    if (position > 0) await this.seekSafe(position);
    if (autoplay) pl.play();
    this.showOnLockScreen();
    this.emit({ type: "track", index: this.index, id: this.current()?.id ?? null, duration: this.current()?.duration ?? 0 });
  }

  async skip(index: number, autoplay: boolean, position: number) {
    const pl = await this.ensure();
    if (!this.items[index]) return;
    this.saveBook(true);
    this.expect(index);
    if (index !== this.index || (pl.currentIndex ?? this.index) !== index) pl.skipTo(index);
    this.index = index;
    this.applyVolume();
    this.startTrack();
    await this.seekSafe(position);
    if (autoplay) pl.play();
    this.showOnLockScreen();
  }

  /** Очередь изменилась: правим плейлист вокруг текущего трека, не прерывая его. */
  async queue(items: Item[], index: number) {
    const pl = await this.ensure();
    const cur = this.current();
    if (!cur || items[index]?.id !== cur.id) {
      // текущий трек убрали или сменили — проще загрузить заново с того же места
      return this.load(items, index, this.status.playing, 0);
    }
    this.expect(index);
    const oldAfter = this.items.slice(this.index + 1);
    const newAfter = items.slice(index + 1);
    let keep = 0;
    while (keep < oldAfter.length && keep < newAfter.length && oldAfter[keep].id === newAfter[keep].id) keep++;
    // после текущего: убираем расходящийся хвост и добавляем новый (с конца — индексы не съезжают)
    for (let i = this.items.length - 1; i > this.index + keep; i--) pl.remove(i);
    for (const it of newAfter.slice(keep)) pl.add(this.source(it));
    // до текущего: общий «хвост» оставляем, остальное перестраиваем
    const oldBefore = this.items.slice(0, this.index);
    const newBefore = items.slice(0, index);
    let tail = 0;
    while (
      tail < oldBefore.length &&
      tail < newBefore.length &&
      oldBefore[oldBefore.length - 1 - tail].id === newBefore[newBefore.length - 1 - tail].id
    )
      tail++;
    const removeCount = oldBefore.length - tail;
    for (let i = removeCount - 1; i >= 0; i--) pl.remove(i);
    newBefore.slice(0, newBefore.length - tail).forEach((it, i) => pl.insert(this.source(it), i));
    this.items = items;
    this.index = index;
  }

  async play() {
    const pl = await this.ensure();
    pl.play();
    this.showOnLockScreen();
  }

  pause() {
    this.pl?.pause();
    this.saveBook(true);
  }

  async seek(position: number) {
    await this.seekSafe(position);
  }

  private async seekSafe(position: number) {
    try {
      await this.pl?.seekTo(Math.max(0, position));
      this.status.time = position;
    } catch {
      /* трек ещё не загрузился */
    }
  }

  setRate(rate: number) {
    this.rate = rate;
    this.applyRate();
  }

  private applyRate() {
    if (!this.pl) return;
    try {
      if (this.pl.setPlaybackRate) this.pl.setPlaybackRate(this.rate);
      else this.pl.playbackRate = this.rate;
    } catch {
      /* скорость не поддерживается */
    }
  }

  setVolume(v: number) {
    this.volume = v;
    this.applyVolume();
  }

  setRepeat(mode: "off" | "all" | "one") {
    this.repeat = mode;
    this.applyLoop();
  }

  private applyLoop() {
    if (this.pl) this.pl.loop = this.repeat === "one" ? "single" : this.repeat === "all" ? "all" : "none";
  }

  stop() {
    this.saveBook(true);
    this.pl?.pause();
    this.pl?.clear();
    try {
      this.pl?.clearLockScreenControls?.();
    } catch {
      /* нет такого метода */
    }
    this.lockScreen = false;
    this.items = [];
    this.index = 0;
  }

  /** until — время (мс), endOfTrack — в конце трека; оба пустые — выключить. */
  setSleep(until: number | null, endOfTrack: boolean) {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.sleepUntil = until;
    this.sleepEndOfTrack = endOfTrack;
    if (until) this.sleepTimer = setTimeout(() => this.sleepNow(), Math.max(0, until - Date.now()));
  }

  private sleepNow() {
    this.sleepUntil = null;
    this.sleepEndOfTrack = false;
    this.sleepTimer = null;
    this.pause();
    this.emit({ type: "sleep-done" });
  }

  /** Страница перезапустилась — что сейчас в плеере */
  session() {
    if (!this.items.length) return;
    this.emit({
      type: "session",
      tracks: this.items.map((i) => i.track),
      index: this.index,
      time: this.status.time,
      duration: this.status.duration,
      playing: this.status.playing,
    });
  }

  // ---------------- события плеера ----------------

  private onTrack(index: number) {
    if (this.pending !== null) {
      if (index === this.pending) this.pending = null; // плеер встал на нужный трек
      return;
    }
    if (index === this.index || !this.items[index]) return;
    this.saveBook(true);
    this.index = index;
    this.status.time = 0;
    this.applyVolume();
    this.startTrack();
    this.showOnLockScreen();
    const it = this.current();
    this.emit({ type: "track", index, id: it?.id ?? null, duration: it?.duration ?? 0 });
  }

  private onStatus(st: Record<string, unknown>) {
    const pl = this.pl;
    const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);
    const idx = num(st.currentIndex, num(pl?.currentIndex, this.index));
    if (this.pending !== null) {
      if (idx === this.pending) this.pending = null;
      else return; // плейлист ещё перестраивается — состояние не показываем
    }
    if (idx !== this.index) this.onTrack(idx);
    const it = this.current();
    const time = num(st.currentTime, num(pl?.currentTime, this.status.time));
    const duration = num(st.duration, num(pl?.duration, it?.duration ?? 0)) || (it?.duration ?? 0);
    const playing = Boolean(st.playing ?? pl?.playing);
    const buffering = Boolean(st.isBuffering);
    const wasPlaying = this.status.playing;
    this.status = { time, duration, playing, buffering };
    this.emit({ type: "status", index: this.index, id: it?.id ?? null, time, duration, playing, buffering });

    if (st.error) this.emit({ type: "error", message: String(st.error), id: it?.id ?? null });
    // очередь доиграла до конца
    if (wasPlaying && !playing && this.index === this.items.length - 1 && duration > 0 && time >= duration - 1 && this.repeat === "off")
      this.emit({ type: "ended" });
    if (playing) {
      this.maybeScrobble(time, duration);
      this.saveBook(false);
    } else if (wasPlaying) this.saveBook(true);
    // таймер сна «до конца трека»
    if (this.sleepEndOfTrack && playing && duration > 0 && time >= duration - 0.6) this.sleepNow();
  }

  private startTrack() {
    this.playKey = `${this.current()?.id}:${Date.now()}`;
  }

  private maybeScrobble(time: number, duration: number) {
    const it = this.current();
    if (!it || it.book !== null || this.scrobbled.has(this.playKey)) return;
    const d = duration || it.duration;
    if (time >= Math.min(240, Math.max(20, d * 0.5))) {
      this.scrobbled.add(this.playKey);
      void apiCall("/api/plays", "POST", { track_id: it.id });
    }
  }

  private saveBook(force: boolean) {
    const it = this.current();
    if (!it || it.book === null) return;
    if (!force && Date.now() - this.lastBookSave < 30_000) return;
    this.lastBookSave = Date.now();
    void apiCall(`/api/books/${it.book}/progress`, "PUT", { track_id: it.id, position: this.status.time, speed: this.rate });
  }
}

export const player = new NativePlayer();
