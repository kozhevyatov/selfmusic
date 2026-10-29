/**
 * Мост с Android-приложением SelfMusic (Expo, папка mobile/).
 *
 * Приложение показывает этот же сайт во WebView, а звук играет нативный плеер:
 * он продолжает очередь в фоне, показывает карточку на экране блокировки и слушается
 * кнопок наушников. Сайт здесь — пульт: отправляет очередь и команды, получает состояние.
 *
 * Приложение до загрузки страницы кладёт в window.__SELFMUSIC_NATIVE__ свои данные,
 * сообщения сайт → приложение идут через window.ReactNativeWebView.postMessage,
 * приложение → сайт — вызовом window.__selfmusicNative.onEvent(...).
 */

export type NativeInfo = { platform: string; appVersion: string; refreshToken?: string | null };

export type NativeItem = {
  id: number;
  title: string;
  artist: string;
  album: string;
  cover: string | null; // относительный адрес /api/cover/… — приложение допишет сервер и токен
  duration: number;
  gain: number; // множитель выравнивания громкости (≤ 1)
  book: number | null; // id книги — приложение само сохраняет прогресс на сервере
};

/** Состояние нативного плеера */
export type NativeStatus = {
  index: number;
  id: number | null;
  time: number;
  duration: number;
  playing: boolean;
  buffering: boolean;
};

export type NativeEvent =
  | ({ type: "status" } & NativeStatus)
  | { type: "track"; index: number; id: number | null; duration: number }
  | { type: "ended" }
  | { type: "error"; message: string; id: number | null }
  | { type: "sleep-done" }
  // ответ на hello: что сейчас в нативном плеере (страницу перезапустили, а музыка играет)
  | { type: "session"; tracks: unknown[]; index: number; time: number; duration: number; playing: boolean };

type Bridge = { postMessage(data: string): void };

declare global {
  interface Window {
    __SELFMUSIC_NATIVE__?: NativeInfo;
    ReactNativeWebView?: Bridge;
    __selfmusicNative?: { onEvent(e: NativeEvent): void };
  }
}

export const nativeInfo: NativeInfo | null =
  typeof window !== "undefined" && window.ReactNativeWebView && window.__SELFMUSIC_NATIVE__ ? window.__SELFMUSIC_NATIVE__ : null;

/** Открыто внутри Android-приложения */
export const isNative = nativeInfo !== null;

export function sendNative(type: string, payload: Record<string, unknown> = {}) {
  if (!isNative) return;
  try {
    window.ReactNativeWebView!.postMessage(JSON.stringify({ type, ...payload }));
  } catch {
    /* приложение закрывается */
  }
}

const handlers = new Set<(e: NativeEvent) => void>();

export function onNative(fn: (e: NativeEvent) => void) {
  handlers.add(fn);
  return () => {
    handlers.delete(fn);
  };
}

if (isNative) {
  window.__selfmusicNative = {
    onEvent(e) {
      handlers.forEach((fn) => {
        try {
          fn(e);
        } catch (err) {
          console.error(err);
        }
      });
    },
  };
  document.documentElement.dataset.native = "android";
}
