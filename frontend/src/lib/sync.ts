/**
 * Синхронизация «где я остановился» между устройствами.
 *
 * Плеер записывает на сервер очередь, текущий трек, позицию и играет ли сейчас
 * (при смене трека, паузе/старте, перемотке и раз в 15 с во время игры).
 * Другие устройства проверяют это, когда вкладку открывают/возвращаются к ней,
 * а во время игры — раз в 30 с:
 *  • здесь ничего не играет → тихо подхватываем трек и позицию (звук включит пользователь);
 *  • здесь играет, а музыку включили на другом устройстве → ставим здесь паузу
 *    и предлагаем «Слушать здесь».
 * Та же запись используется Subsonic savePlayQueue/getPlayQueue.
 */
import { useSyncExternalStore } from "react";
import { api, type RemoteQueue, type Track } from "./api";
import { isOffline } from "./network";
import { player } from "./player";
import { toast } from "./toast";

type Remote = Extract<RemoteQueue, { empty: false }>;

const DEVICE_KEY = "sm-device";
const PUSH_EVERY = 15_000;
const POLL_PLAYING = 30_000;

export const deviceId: string = (() => {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "tmp-" + Math.random().toString(36).slice(2, 10);
  }
})();

export function deviceName(): string {
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const dev = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || touchMac
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : "компьютер";
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
  if (standalone) return `${dev} · приложение`;
  const br = /Edg\//.test(ua) ? "Edge" : /YaBrowser/.test(ua) ? "Яндекс Браузер" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return br ? `${dev} · ${br}` : dev;
}

// ---------- предложение «Слушать здесь» ----------

export type SyncOffer = { device: string; track: Track; tracks: Track[]; index: number; position: number; at: number };
let offer: SyncOffer | null = null;
const offerListeners = new Set<() => void>();
function setOffer(o: SyncOffer | null) {
  offer = o;
  offerListeners.forEach((l) => l());
}
export function useSyncOffer() {
  return useSyncExternalStore(
    (cb) => {
      offerListeners.add(cb);
      return () => offerListeners.delete(cb);
    },
    () => offer,
  );
}
export function dismissOffer() {
  setOffer(null);
}
/** «Слушать здесь»: вызывается по нажатию — звук можно включать. */
export function acceptOffer() {
  const o = offer;
  if (!o) return;
  setOffer(null);
  // время идёт и пока висела плашка, если там играло
  const pos = o.position + (Date.now() - o.at) / 1000;
  player.adoptQueue(o.tracks, o.index, Math.min(pos, (o.track.duration || pos + 3) - 3), true);
}

// ---------- запись ----------

let ready = false; // пока не сверились с сервером, ничего не пишем (иначе затрём свежее старым)
let lastHandled = 0; // changed_at (мс) последней записи, которую мы уже видели или сделали сами
let lastSig = "";
let lastPushAt = 0;
let lastTime = 0;
let lastTick = Date.now();
let suppressPush = false;
let pushTimer = 0;

/** Изменения плеера, вызванные синхронизацией, не записываем обратно (события audio приходят асинхронно). */
let quietTimer = 0;
function quiet(ms = 2000) {
  suppressPush = true;
  window.clearTimeout(quietTimer);
  quietTimer = window.setTimeout(() => (suppressPush = false), ms);
}

function snapshot() {
  const s = player.getState();
  if (s.book || !s.queue.length) return null;
  const cur = s.queue[s.index];
  if (!cur) return null;
  const start = Math.max(0, s.index - 200);
  return {
    track_ids: s.queue.slice(start, start + 1000).map((t) => t.id),
    current_id: cur.id,
    position: Math.max(0, Math.round(s.time * 10) / 10),
    playing: s.playing,
    device_id: deviceId,
    device_name: deviceName(),
  };
}

async function push(keepalive = false) {
  window.clearTimeout(pushTimer);
  if (!ready || isOffline()) return;
  const data = snapshot();
  if (!data) return;
  lastPushAt = Date.now();
  try {
    const r = await api.library.saveQueue(data, keepalive);
    lastHandled = Math.max(lastHandled, Date.parse(r.changed_at));
  } catch {
    /* офлайн или сеть — запишем в следующий раз */
  }
}

function schedulePush(delay = 800) {
  window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => void push(), delay);
}

function onPlayerChange() {
  const s = player.getState();
  const cur = s.queue[s.index];
  const sig = `${cur?.id ?? 0}|${s.playing}|${s.queue.length}|${s.queue[0]?.id ?? 0}|${s.book ? 1 : 0}`;
  const now = Date.now();
  // перемотка: время ушло не туда, куда должно было за прошедшее время
  const expected = lastTime + (s.playing ? (now - lastTick) / 1000 : 0);
  const seeked = Math.abs(s.time - expected) > 4 && cur?.id === Number(lastSig.split("|")[0]);
  lastTime = s.time;
  lastTick = now;
  if (suppressPush) {
    lastSig = sig;
    return;
  }
  if (sig !== lastSig || seeked) {
    lastSig = sig;
    schedulePush();
  } else if (s.playing && now - lastPushAt > PUSH_EVERY) {
    schedulePush(0);
  }
}

// ---------- чтение ----------

let pulling = false;
let lastPull = 0;

async function pull() {
  if (pulling || isOffline()) return;
  pulling = true;
  lastPull = Date.now();
  try {
    const r = await api.library.remoteQueue();
    if (r.empty) return;
    const changed = Date.parse(r.changed_at);
    if (r.device_id === deviceId) {
      lastHandled = Math.max(lastHandled, changed);
      return;
    }
    if (changed <= lastHandled) return;
    lastHandled = changed;
    await handleRemote(r);
  } catch {
    /* нет сети — не страшно */
  } finally {
    pulling = false;
    ready = true;
  }
}

async function handleRemote(r: Remote) {
  const s = player.getState();
  if (s.book) return; // слушаем книгу — у книг своя синхронизация прогресса
  const elapsed = r.playing ? Math.max(0, (Date.parse(r.server_time) - Date.parse(r.changed_at)) / 1000) : 0;
  const position = r.position + elapsed;
  const cur = s.queue[s.index];

  if (s.playing) {
    if (!r.playing) return; // там поставили на паузу — здесь продолжаем
    // музыку включили на другом устройстве: здесь — пауза, чтобы не играло два сразу
    quiet();
    player.pause();
    const full = await api.library.remoteQueue(true).catch(() => null);
    const tracks = full && !full.empty ? (full.tracks ?? []) : [];
    const index = tracks.findIndex((t) => t.id === r.current_id);
    if (index >= 0) setOffer({ device: r.device_name, track: tracks[index], tracks, index, position, at: Date.now() });
    toast.info(`Музыка продолжилась на устройстве «${r.device_name}»`);
    return;
  }

  // здесь тихо: подхватываем, если отличается
  if (cur && cur.id === r.current_id && Math.abs(s.time - position) < 3) return;
  const full = await api.library.remoteQueue(true).catch(() => null);
  if (!full || full.empty || !full.tracks?.length) return;
  const index = full.tracks.findIndex((t) => t.id === r.current_id);
  if (index < 0) return;
  if (player.getState().playing) return; // пока грузили — пользователь уже включил что-то своё
  quiet();
  player.adoptQueue(full.tracks, index, Math.min(position, (full.tracks[index].duration || position + 3) - 3), false);
  setOffer(null);
  if (cur?.id !== r.current_id)
    toast.info(`Продолжение с устройства «${r.device_name}»: «${full.tracks[index].title}»`);
}

// ---------- запуск ----------

let started = false;

/** Запустить синхронизацию (после входа). Возвращает функцию остановки. */
export function startSync(): () => void {
  if (started) return () => {};
  started = true;
  const s = player.getState();
  const cur = s.queue[s.index];
  lastSig = `${cur?.id ?? 0}|${s.playing}|${s.queue.length}|${s.queue[0]?.id ?? 0}|${s.book ? 1 : 0}`;
  lastTime = s.time;
  const unsub = player.subscribe(onPlayerChange);
  void pull();

  const onVisible = () => {
    if (document.visibilityState === "visible") {
      if (Date.now() - lastPull > 4000) void pull();
    } else if (player.getState().playing || Date.now() - lastPushAt > 2000) {
      void push(true); // уходим со вкладки/закрываем — сохранить точную позицию
    }
  };
  const onFocus = () => Date.now() - lastPull > 4000 && void pull();
  const onHide = () => void push(true);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onFocus);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("online", onFocus);
  const poll = window.setInterval(() => {
    // в фоне браузер может реже вызывать таймер — не страшно
    if (player.getState().playing) void pull();
  }, POLL_PLAYING);

  return () => {
    started = false;
    unsub();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("online", onFocus);
    window.clearInterval(poll);
    window.clearTimeout(pushTimer);
  };
}
