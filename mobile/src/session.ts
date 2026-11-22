/**
 * Сервер и вход: адрес, токены (в зашифрованном хранилище: Keystore на Android, Keychain на iOS), запросы к API.
 *
 * refresh — для входа сайта во WebView и для получения access-токена приложению;
 * media — долгий токен только для потока и обложек (?mt=…): системный плеер и экран
 * блокировки сами скачивают файлы и не умеют подставлять заголовки авторизации.
 */
import * as SecureStore from "expo-secure-store";

export type Session = { server: string; refresh: string; media: string | null; username: string };

const KEY = "selfmusic.session";
const LAST = "selfmusic.last"; // последний сервер и логин — подставить после выхода

let current: Session | null = null;
let access: { token: string; until: number } | null = null;

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    current = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    current = null;
  }
  return current;
}

export function getSession() {
  return current;
}

export async function saveSession(s: Session | null) {
  current = s;
  access = null;
  if (s) {
    await SecureStore.setItemAsync(KEY, JSON.stringify(s));
    await SecureStore.setItemAsync(LAST, JSON.stringify({ server: s.server, username: s.username }));
  } else {
    await SecureStore.deleteItemAsync(KEY);
  }
}

/** Сайт во WebView обновил токены — сохраняем (так приложение всегда в той же сессии). */
export async function updateTokens(refresh: string, media: string | null, username?: string) {
  if (!current) return;
  await saveSession({ ...current, refresh, media: media ?? current.media, username: username ?? current.username });
}

export async function lastLogin(): Promise<{ server: string; username: string } | null> {
  try {
    const raw = await SecureStore.getItemAsync(LAST);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------------- сервер ----------------

function withTimeout(ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function getJson(url: string, init: RequestInit = {}, ms = 10000): Promise<{ status: number; data: any }> {
  const to = withTimeout(ms);
  try {
    const res = await fetch(url, { ...init, signal: to.signal });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* не JSON */
    }
    return { status: res.status, data };
  } finally {
    to.done();
  }
}

/** «music.example.ru», «192.168.1.10:1332», «https://…/» → варианты адреса для проверки */
function candidates(input: string): string[] {
  let s = input.trim().replace(/\/+$/, "");
  if (!s) return [];
  if (/^https?:\/\//i.test(s)) return [s];
  // локальный адрес с портом — скорее всего http; домен — https
  const local = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(s) || /^[\w-]+(\.local)?(:\d+)?$/i.test(s) || /:\d+$/.test(s);
  return local ? [`http://${s}`, `https://${s}`] : [`https://${s}`, `http://${s}`];
}

/** Найти сервер SelfMusic по введённому адресу. */
export async function findServer(input: string): Promise<string> {
  const list = candidates(input);
  if (!list.length) throw new Error("Укажите адрес сервера");
  let lastError = "Сервер не отвечает";
  for (const base of list) {
    try {
      const r = await getJson(`${base}/api/health`, {}, 8000);
      if (r.status === 200 && r.data?.status === "ok") return base;
      lastError = r.status === 200 ? "По этому адресу не SelfMusic" : `Сервер ответил ошибкой ${r.status}`;
    } catch {
      /* пробуем следующий вариант */
    }
  }
  throw new Error(lastError);
}

export async function login(server: string, loginValue: string, password: string): Promise<Session> {
  const r = await getJson(`${server}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: loginValue.trim(), password, remember: true }),
  });
  if (r.status !== 200) throw new Error(r.data?.detail || (r.status === 429 ? "Слишком много попыток, подождите" : "Не удалось войти"));
  const s: Session = { server, refresh: r.data.refresh_token, media: r.data.media_token ?? null, username: r.data.user?.username ?? loginValue };
  await saveSession(s);
  access = { token: r.data.access_token, until: Date.now() + 10 * 60_000 };
  return s;
}

let refreshing: Promise<string | null> | null = null;

/** Access-токен для запросов самого приложения (учёт прослушиваний, прогресс книг). */
async function accessToken(force = false): Promise<string | null> {
  if (!current) return null;
  if (!force && access && access.until > Date.now()) return access.token;
  if (!refreshing) {
    refreshing = (async () => {
      const s = current;
      if (!s) return null;
      try {
        const r = await getJson(`${s.server}/api/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: s.refresh }),
        });
        if (r.status !== 200) return null;
        access = { token: r.data.access_token, until: Date.now() + 10 * 60_000 };
        await updateTokens(r.data.refresh_token, r.data.media_token ?? null);
        return access.token;
      } catch {
        return null; // нет сети — попробуем позже
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/** Запрос к API от имени пользователя (с обновлением токена при 401). null — сервер недоступен. */
export async function apiSend(path: string, method: string, body?: unknown): Promise<number | null> {
  const s = current;
  if (!s) return null;
  let status: number | null = null;
  for (const force of [false, true]) {
    const token = await accessToken(force);
    if (!token) return status;
    try {
      const r = await getJson(`${s.server}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      status = r.status;
      if (r.status !== 401) return r.status;
    } catch {
      return null;
    }
  }
  return status;
}

export async function apiCall(path: string, method: string, body?: unknown): Promise<boolean> {
  const status = await apiSend(path, method, body);
  return status !== null && status < 400;
}

/** Адрес потока/обложки для системного плеера: полный, с media-токеном. */
export function mediaUrl(path: string): string {
  const s = current;
  if (!s) return path;
  const url = path.startsWith("http") ? path : `${s.server}${path}`;
  if (!s.media) return url;
  return `${url}${url.includes("?") ? "&" : "?"}mt=${encodeURIComponent(s.media)}`;
}
