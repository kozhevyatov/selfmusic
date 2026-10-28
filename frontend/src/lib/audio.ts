/**
 * Настройки звука (на этом устройстве) и звуковой граф Web Audio:
 *   дека A ─┐
 *            ├─ громкость деки (выравнивание × кроссфейд) ─ эквалайзер (10 полос) ─ предусиление ─ лимитер ─ выход
 *   дека B ─┘
 * Граф включается, только если нужен (эквалайзер, выравнивание с усилением или кроссфейд):
 * без него звук идёт напрямую из <audio> — так надёжнее в фоне на iPhone.
 */
import { useSyncExternalStore } from "react";

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const EQ_PRESETS: { id: string; label: string; gains: number[] }[] = [
  { id: "flat", label: "Ровно", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: "bass", label: "Больше баса", gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: "treble", label: "Больше высоких", gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  { id: "vocal", label: "Вокал", gains: [-2, -2, -1, 0, 2, 4, 4, 3, 1, 0] },
  { id: "rock", label: "Рок", gains: [5, 4, 2, 0, -1, -1, 1, 3, 4, 5] },
  { id: "pop", label: "Поп", gains: [-1, 1, 3, 4, 3, 1, 0, 1, 2, 2] },
  { id: "jazz", label: "Джаз", gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { id: "classical", label: "Классика", gains: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  { id: "electronic", label: "Электроника", gains: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5] },
  { id: "loudness", label: "Тихое прослушивание", gains: [6, 4, 2, 0, -1, -1, 0, 2, 4, 5] },
  { id: "headphones", label: "Наушники", gains: [3, 2, 0, -1, -1, 0, 1, 2, 3, 2] },
  { id: "small", label: "Маленькие колонки", gains: [-4, -2, 2, 3, 2, 1, 1, 2, 3, 2] },
];

export type AudioSettings = {
  /** Выравнивание громкости */
  normalize: boolean;
  /** track — каждый трек одинаково громко; album — сохраняет разницу внутри альбома */
  normalizeMode: "track" | "album";
  /** Предусиление при выравнивании, дБ (выравнивание делает музыку тише — можно добавить) */
  preamp: number;
  /** Кроссфейд, секунд (0 — выключен) */
  crossfade: number;
  /** Не смешивать соседние треки одного альбома (концерты, миксы, сюиты) */
  crossfadeSkipAlbum: boolean;
  /** Следующий трек начинается без паузы */
  gapless: boolean;
  eq: { enabled: boolean; preset: string; gains: number[] };
};

const DEFAULTS: AudioSettings = {
  normalize: false,
  normalizeMode: "track",
  preamp: 4,
  crossfade: 0,
  crossfadeSkipAlbum: true,
  gapless: true,
  eq: { enabled: false, preset: "flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
};

const KEY = "sm-audio";
const listeners = new Set<() => void>();

function load(): AudioSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const s = JSON.parse(raw) as Partial<AudioSettings>;
    return { ...DEFAULTS, ...s, eq: { ...DEFAULTS.eq, ...(s.eq ?? {}) } };
  } catch {
    return DEFAULTS;
  }
}

let settings: AudioSettings = load();

export function getAudioSettings() {
  return settings;
}

export function setAudioSettings(patch: Partial<AudioSettings>) {
  settings = { ...settings, ...patch, eq: { ...settings.eq, ...(patch.eq ?? {}) } };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* приватный режим */
  }
  listeners.forEach((l) => l());
}

export function onAudioSettings(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useAudioSettings(): AudioSettings {
  return useSyncExternalStore(onAudioSettings, getAudioSettings);
}

export const isIOS =
  typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Нужен ли звуковой граф при текущих настройках */
export function needsGraph(s = settings) {
  return s.eq.enabled || s.normalize || s.crossfade > 0;
}

// ---------------- граф ----------------

type Graph = {
  ctx: AudioContext;
  deckGains: GainNode[];
  filters: BiquadFilterNode[];
  pre: GainNode;
};

let graph: Graph | null = null;

export function hasGraph() {
  return graph !== null;
}

/** Подключить деки к графу. Вызывать по нажатию пользователя (иначе браузер не даст запустить звук). */
export function ensureGraph(decks: HTMLAudioElement[]): boolean {
  if (graph) {
    if (graph.ctx.state === "suspended") void graph.ctx.resume();
    return true;
  }
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return false;
  try {
    const ctx = new AC({ latencyHint: "playback" });
    const filters = EQ_BANDS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
      b.frequency.value = f;
      b.Q.value = 1.1;
      b.gain.value = 0;
      return b;
    });
    const pre = ctx.createGain();
    // мягкий лимитер: усиление и эквалайзер не должны давать хрип на пиках
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 1;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    const bus = ctx.createGain();
    const deckGains = decks.map((el) => {
      const src = ctx.createMediaElementSource(el);
      const g = ctx.createGain();
      src.connect(g).connect(bus);
      return g;
    });
    let node: AudioNode = bus;
    for (const f of filters) node = node.connect(f);
    node.connect(pre).connect(limiter).connect(ctx.destination);
    graph = { ctx, deckGains, filters, pre };
    applyEq();
    void ctx.resume();
    return true;
  } catch (err) {
    console.warn("Web Audio недоступен", err);
    return false;
  }
}

export function resumeGraph() {
  if (graph && graph.ctx.state !== "running") void graph.ctx.resume();
}

export function applyEq() {
  if (!graph) return;
  const { eq } = settings;
  const gains = eq.enabled ? eq.gains : EQ_BANDS.map(() => 0);
  const t = graph.ctx.currentTime;
  graph.filters.forEach((f, i) => f.gain.setTargetAtTime(gains[i] ?? 0, t, 0.05));
  // запас по громкости, чтобы подъём полос не уходил в лимитер
  const maxBoost = Math.max(0, ...gains);
  graph.pre.gain.setTargetAtTime(Math.pow(10, -maxBoost / 2 / 20), t, 0.05);
}

/** Громкость деки (линейная), с плавностью ramp секунд */
export function setDeckGain(deck: number, value: number, ramp = 0.04) {
  if (!graph) return;
  const g = graph.deckGains[deck].gain;
  const t = graph.ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(Math.max(0, value), t + Math.max(0.01, ramp));
}

onAudioSettings(applyEq);

/** Множитель выравнивания громкости для трека */
export function normalizeGain(track: { gain?: number | null; album_gain?: number | null } | null | undefined, s = settings) {
  if (!s.normalize || !track) return 1;
  // громкость неизвестна (ещё не проанализирован) — считаем типичным современным треком (−8 дБ)
  const db = (s.normalizeMode === "album" && track.album_gain != null ? track.album_gain : track.gain) ?? -8;
  return Math.pow(10, Math.max(-24, Math.min(12, db + s.preamp)) / 20);
}
