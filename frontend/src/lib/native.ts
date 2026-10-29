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

export type Insets = { top: number; bottom: number };

export type NativeInfo = {
  platform: string;
  appVersion: string;
  refreshToken?: string | null;
  insets?: Insets; // отступы системных панелей: WebView в приложении — на весь экран
  offline?: boolean; // приложение умеет скачивать музыку само (с версии 1.1)
};

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
  | { type: "session"; tracks: unknown[]; index: number; time: number; duration: number; playing: boolean }
  | { type: "insets"; top: number; bottom: number }
  // скачанное в приложении: индекс целиком (когда меняется) и ход загрузок (часто)
  | { type: "offline"; index: unknown; free: number }
  | { type: "offline-progress"; progress: Record<string, unknown> };

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
  applyInsets(nativeInfo?.insets);
  onNative((e) => {
    if (e.type === "insets") applyInsets(e);
  });
}

function applyInsets(i?: Insets) {
  if (!i) return;
  const st = document.documentElement.style;
  st.setProperty("--native-sat", `${Math.max(0, i.top)}px`);
  st.setProperty("--native-sab", `${Math.max(0, i.bottom)}px`);
}
