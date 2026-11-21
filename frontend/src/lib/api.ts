/**
 * Клиент API.
 * access-токен живёт в памяти, refresh — в httpOnly-cookie (веб); для потока и обложек
 * сервер ставит отдельную media-cookie, поэтому <audio> и <img> работают без заголовков.
 * При 401 клиент один раз обновляет токен и повторяет запрос.
 */
import { isNative, nativeInfo, sendNative } from "./native";
import { setOffline, whenBackOnline } from "./network";

export type Quality = "original" | "320" | "192" | "128";
export type UploadMode = "none" | "own" | "libraries";

export type User = {
  id: number;
  username: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  is_active: boolean;
  stream_quality: Quality;
  library_scope: LibraryScope;
  upload_mode: UploadMode;
  upload_quota_mb: number;
  upload_max_files: number;
  can_share: boolean;
  /** адрес аватарки или null — тогда показываем букву */
  avatar: string | null;
  created_at: string;
  last_seen_at: string | null;
};

export type TokenResponse = { access_token: string; refresh_token: string; media_token?: string | null; token_type: string; user: User };

export type SetupStatus = {
  database_configured: boolean;
  database_from_env: boolean;
  setup_complete: boolean;
  setup_token_required: boolean;
};

export type RegistrationMode = "open" | "closed";
export type PublicSettings = { site_name: string; registration_mode: RegistrationMode };
export type AdminSettings = PublicSettings & { scan_interval: number; public_url: string };

export type DatabaseConfig = {
  type: "sqlite" | "mysql";
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
};

export type Track = {
  id: number;
  title: string;
  artist: string;
  artist_id: number | null;
  album: string;
  album_id: number;
  album_artist: string;
  album_artist_id: number | null;
  track_no: number | null;
  disc_no: number | null;
  year: number | null;
  genre: string;
  duration: number;
  bitrate: number;
  suffix: string;
  quality: string;
  size: number;
  cover: string | null;
  has_lyrics: boolean;
  /** громкость для выравнивания, дБ (ReplayGain или по анализу) */
  gain?: number | null;
  album_gain?: number | null;
  starred: boolean;
  can_delete?: boolean;
  entry_id?: number;
  /** кто добавил трек (в совместном плейлисте) */
  added_by?: UserBrief | null;
  played_at?: string;
};

export type Album = {
  id: number;
  name: string;
  artist: string;
  artist_id: number | null;
  year: number | null;
  genre: string;
  track_count: number;
  disc_count: number;
  duration: number;
  quality: string;
  size: number;
  cover: string | null;
  library_id: number;
  created_at: string;
  starred: boolean;
};

export type AlbumDetail = Album & {
  tracks: Track[];
  more_by_artist: Album[];
  library_name: string;
  can_edit: boolean;
  /** что нашлось в MusicBrainz; status — только для администратора */
  mb: { release_mbid: string | null; status: MetaStatus | null; cover_from_meta: boolean };
};

/** pending — ещё не проверяли; found — найдено само; manual — выбрано вручную; ignored — «не искать» */
export type MetaStatus = "pending" | "found" | "manual" | "notfound" | "error" | "ignored";

export type ArtistInfo = {
  mbid: string | null;
  name: string;
  disambiguation: string;
  country: string;
  life_span: string;
  genres: string;
  bio: string;
  bio_lang: string;
  bio_url: string;
  image_source: string;
};

export type AlbumMetaState = {
  status: MetaStatus;
  source: string;
  release_mbid: string | null;
  release_group_mbid: string | null;
  title: string;
  artist: string;
  year: number | null;
  genre: string;
  cover_from_meta: boolean;
  error: string | null;
  checked_at: string | null;
  query: { title: string; artist: string };
};

export type ReleaseCandidate = {
  id: string;
  title: string;
  artist: string;
  date: string;
  year: number | null;
  country: string;
  status: string;
  track_count: number;
  media: string;
  type: string;
  score: number;
  disambiguation: string;
  cover: string;
};

export type ArtistMetaState = {
  status: MetaStatus;
  source: string;
  mbid: string | null;
  info: ArtistInfo | null;
  image: string | null;
  error: string | null;
  checked_at: string | null;
  query: string;
};

export type ArtistCandidate = {
  id: string;
  name: string;
  sort_name: string;
  disambiguation: string;
  country: string;
  type: string;
  life_span: string;
  score: number;
  aliases: string[];
};

export type MetaAdminStatus = {
  running: boolean;
  current: string | null;
  done_session: number;
  last_error: string | null;
  paused_reason: string;
  enabled: boolean;
  covers: boolean;
  artists: boolean;
  fill: boolean;
  lang: string;
  acoustid_key: string;
  fpcalc: boolean;
  album_stats: { total: number; found: number; notfound: number; error: number; ignored: number; covers: number };
  artist_stats: { total: number; found: number; notfound: number; error: number; bios: number; photos: number };
  track_stats: { untagged: number; found: number; notfound: number };
};

export type MetaSettingsPatch = Partial<Pick<MetaAdminStatus, "enabled" | "covers" | "artists" | "fill" | "lang" | "acoustid_key">>;

export type Artist = { id: number; name: string; album_count: number; cover: string | null; starred: boolean };

export type RemoteQueue =
  | { empty: true; server_time: string }
  | {
      empty: false;
      server_time: string;
      rev: number;
      changed_at: string;
      started_at: string | null;
      device_id: string;
      device_name: string;
      playing: boolean;
      current_id: number;
      position: number;
      count: number;
      current?: Track;
      tracks?: Track[];
    };

export type AndroidApp = { available: false } | { available: true; version: string; size: number; uploaded_at: string };

export type FavoriteArtist = Artist & { plays: number; seconds: number };

export type StatsPeriod = "week" | "month" | "year" | "all";
export type StatsResult = {
  kind: StatsPeriod;
  year: number | null;
  scale: "day" | "month" | "year";
  years: number[];
  totals: { plays: number; seconds: number; tracks: number; artists: number; albums: number; days: number; new_artists: number };
  previous: { plays: number; seconds: number } | null;
  top_artists: FavoriteArtist[];
  top_tracks: (Track & { plays: number })[];
  top_albums: (Album & { plays: number })[];
  genres: { name: string; plays: number; share: number; seconds: number }[];
  timeline: { key: string; seconds: number }[];
  hours: number[];
  weekdays: number[];
  highlights: {
    streak: number;
    streak_end: string | null;
    top_day: { date: string; seconds: number; plays: number } | null;
    repeat: { date: string; count: number; track: Track } | null;
    first: { at: string; track: Track } | null;
  };
  sound: { energy: number; valence: number; bpm: number | null; coverage: number; library_energy: number; library_valence: number } | null;
  users: { id: number; name: string; avatar: string | null; plays: number; seconds: number }[] | null;
};

export type ArtistDetail = Artist & {
  albums: Album[];
  appears_on: Album[];
  top_tracks: Track[];
  track_count: number;
  info: ArtistInfo | null;
  meta_status: MetaStatus | null;
};

export type Home = {
  recent_albums: Album[];
  recently_played: Album[];
  random_albums: Album[];
  favorite_artists: FavoriteArtist[];
  stats: { tracks: number; albums: number; artists: number; duration: number };
};

export type LibraryScope = "all" | "shared" | "mine";

export type MyLibrary = {
  id: number;
  name: string;
  kind: "music" | "audiobooks";
  personal: boolean;
  path: string | null;
  track_count: number;
  album_count: number;
  total_duration: number;
  total_size: number;
  last_scan_at: string | null;
};

export type UserBrief = { id: number; name: string; avatar: string | null };
export type SmartRule = { field: string; op: string; value: string | number | number[] | null };
export type SmartRules = { match: "all" | "any"; rules: SmartRule[]; sort: string; limit: number };

export type Playlist = {
  id: number;
  name: string;
  comment: string;
  is_public: boolean;
  owner: UserBrief;
  is_owner: boolean;
  /** можно менять состав треков (владелец или соавтор; у умного — никто) */
  can_edit: boolean;
  smart: boolean;
  rules: SmartRules | null;
  members: UserBrief[];
  track_count: number;
  duration: number;
  covers: string[];
  created_at: string;
  updated_at: string;
};

export type PlaylistDetail = Playlist & { tracks: Track[] };

export type Genre = { name: string; track_count: number; album_count: number };

export type AdminUser = User & {
  access: { library_id: number; can_write: boolean }[];
  upload_used: { bytes: number; files: number };
  personal_library_id: number | null;
};

export type FolderNode = { name: string; path: string; included: boolean; rule: boolean | null; tracks: number; has_children: boolean };
export type FolderTree = { path: string; included: boolean; tracks_here: number; dirs: FolderNode[]; truncated: boolean; excluded_count: number };

export type AdminLibrary = {
  id: number;
  name: string;
  path: string;
  enabled: boolean;
  default_access: boolean;
  kind: "music" | "audiobooks";
  owner: { id: number; name: string } | null;
  writable: boolean;
  track_count: number;
  album_count: number;
  total_size: number;
  total_duration: number;
  last_scan_at: string | null;
  last_scan_error: string | null;
  excluded_count: number;
  exists: boolean;
  user_count: number;
};

export type ScanStatus = {
  running: boolean;
  library_id: number | null;
  library_name: string | null;
  phase: string;
  checked: number;
  changed: number;
  started_at: string | null;
  finished_at: string | null;
  last_result: { added: number; updated: number; removed: number; errors: number } | null;
};

export type FsListing = {
  root: string;
  root_exists: boolean;
  path: string;
  abs_path?: string;
  parent: string | null;
  dirs: string[];
  audio_files: number;
};

export type UploadInfo = {
  mode: UploadMode;
  limits: { bytes: number; files: number };
  used: { bytes: number; files: number };
  targets: { id: number; name: string; personal: boolean; kind?: "music" | "audiobooks" }[];
  personal_available: boolean;
};

export type MyUpload = {
  id: number;
  path: string;
  size: number;
  created_at: string;
  library: string;
  track_id: number | null;
  title: string | null;
  artist: string | null;
  album_id: number | null;
};

export type TagFields = {
  title: string;
  artist: string;
  album_artist: string;
  album: string;
  track: string;
  disc: string;
  year: string;
  genre: string;
  lyrics: string;
};

export type TrackTags = { tags: TagFields; editable: boolean; reason: string | null; file: string; suffix: string };

export type AlbumTags = {
  album: string | null;
  album_artist: string | null;
  artist: string | null;
  year: string | null;
  genre: string | null;
  tracks: { id: number; file: string; suffix: string; tags: TagFields; editable: boolean }[];
  editable: boolean;
  reason: string | null;
  has_cover: boolean;
};

export type ShareKind = "folder" | "album" | "artist" | "playlist" | "tracks";

export type ShareTarget =
  | { kind: "folder"; library_id: number; folder: string; label: string }
  | { kind: "album" | "artist" | "playlist"; item_id: number; label: string }
  | { kind: "tracks"; track_ids: number[]; label: string };

export type Share = {
  id: number;
  token: string;
  url: string;
  kind: ShareKind;
  kind_label: string;
  target_title: string;
  target_subtitle: string;
  title: string;
  description: string;
  has_password: boolean;
  expires_at: string | null;
  allow_download: boolean;
  quality: ShareQuality;
  max_views: number | null;
  views: number;
  plays: number;
  downloads: number;
  last_opened_at: string | null;
  enabled: boolean;
  state: "active" | "disabled" | "expired" | "exhausted";
  track_count: number;
  cover: string | null;
  owner: { id: number; name: string };
  created_at: string;
};

export type ShareOptions = {
  title?: string;
  description?: string;
  password?: string | null;
  expires_at?: string | null;
  clear_expiry?: boolean;
  allow_download?: boolean;
  quality?: ShareQuality;
  max_views?: number | null;
  enabled?: boolean;
};

export type ShareQuality = "original" | "320" | "192" | "128";

export type PublicTrack = {
  id: number;
  title: string;
  artist: string;
  album: string;
  album_id: number;
  track_no: number | null;
  disc_no: number | null;
  duration: number;
  quality: string;
  size: number | null;
  cover: string | null;
  has_lyrics: boolean;
  folder: string | null;
};

export type PublicShare =
  | { locked: true; kind: ShareKind; kind_label: string; owner: string; site_name: string }
  | {
      locked: false;
      kind: ShareKind;
      kind_label: string;
      owner: string;
      site_name: string;
      title: string;
      subtitle: string;
      description: string;
      allow_download: boolean;
      expires_at: string | null;
      cover: string | null;
      tracks: PublicTrack[];
      duration: number;
      size: number | null;
    };

export type MixCard = {
  key: string;
  group: "time" | "mood" | "season" | "personal";
  title: string;
  subtitle: string;
  icon: string;
  colors: [string, string];
  track_count: number;
  duration: number;
  covers: string[];
  current: boolean;
};
export type MixDetail = MixCard & { tracks: Track[] };
export type MixesOverview = {
  now: MixCard | null;
  season: MixCard | null;
  groups: { key: string; title: string; items: MixCard[] }[];
  analysis_ready: boolean;
};
export type DuplicateTrack = {
  id: number;
  title: string;
  path: string;
  library: string;
  album: string;
  album_id: number;
  quality: string;
  size: number;
  duration: number;
  best: boolean;
  can_delete: boolean;
};
export type DuplicatesResult = {
  count: number;
  reclaimable: number;
  groups: { key: string; title: string; artist: string; tracks: DuplicateTrack[] }[];
};

export type AnalysisStatus = {
  running: boolean;
  current: string | null;
  done_session: number;
  last_error: string | null;
  paused_reason: string;
  enabled: boolean;
  start: string;
  end: string;
  total: number;
  analyzed: number;
  failed: number;
  forced: boolean;
};

export type BookProgress = { track_id: number | null; position: number; progress: number; speed: number; finished: boolean; updated_at: string };
export type BookCard = {
  id: number;
  title: string;
  subtitle: string;
  author: string;
  narrator: string;
  series: string;
  series_seq: number | null;
  year: number | null;
  cover: string | null;
  duration: number;
  track_count: number;
  size: number;
  added_at: string;
  progress: BookProgress | null;
};
export type BookDetail = BookCard & {
  description: string;
  chapters: { index: number; track_id: number; title: string; start: number; end: number; book_start: number }[];
  tracks: Track[];
  bookmarks: { id: number; track_id: number; position: number; comment: string; created_at: string }[];
};
export type BooksHome = {
  total: number;
  continue: BookCard[];
  recent: BookCard[];
  series: { name: string; author: string; count: number; cover: string | null }[];
  authors: { name: string; count: number; cover: string | null }[];
};

export type FolderEntry = { name: string; path: string; track_count: number; covers: string[] };
export type FolderSearch = {
  folders: (FolderEntry & { parent: string })[];
  tracks: Track[];
  more_folders: boolean;
  more_tracks: boolean;
};
export type FolderView = {
  library: { id: number; name: string };
  path: string;
  name: string;
  crumbs: { name: string; path: string }[];
  folders: FolderEntry[];
  tracks: Track[];
  total_tracks: number;
  total_duration: number;
  total_size: number;
};

export type LibraryDirs = { library: { id: number; name: string }; path: string; dirs: string[]; track_count: number };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let accessToken: string | null = null;
let refreshPromise: Promise<TokenResponse | null> | null = null;
const listeners = new Set<(user: User | null) => void>();

export function onAuthChange(fn: (user: User | null) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const USER_KEY = "sm-user";

/** Последний вошедший пользователь — чтобы без связи открыть приложение со скачанной музыкой */
function rememberUser(user: User | null) {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* приватный режим */
  }
}

export function cachedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function setSession(data: TokenResponse | null) {
  accessToken = data?.access_token ?? null;
  if (isNative) {
    // Android-приложению — свежие токены (нативный плеер засчитывает прослушивания и берёт поток)
    // или сигнал «вышли из аккаунта» (приложение вернётся к своему экрану входа)
    if (data) sendNative("auth", { refresh_token: data.refresh_token, media_token: data.media_token ?? null, username: data.user.username });
    else sendNative("logout");
  }
  rememberUser(data?.user ?? null);
  listeners.forEach((fn) => fn(data?.user ?? null));
}

export function updateCurrentUser(user: User) {
  rememberUser(user);
  listeners.forEach((fn) => fn(user));
}

export function getAccessToken() {
  return accessToken;
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail.length) {
      const first = detail[0] as { msg?: string; loc?: unknown[] };
      const field = first.loc?.[first.loc.length - 1];
      return field ? `${String(field)}: ${first.msg}` : (first.msg ?? fallback);
    }
  }
  return fallback;
}

async function raw<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: "include" });
  } catch {
    setOffline(true);
    throw new ApiError(0, "Нет связи с сервером");
  }
  // 502–504 отдаёт обратный прокси, когда сам сервер недоступен
  if (res.status >= 502 && res.status <= 504) {
    setOffline(true);
    throw new ApiError(res.status, "Сервер недоступен");
  }
  setOffline(false);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiError(res.status, errorMessage(body, `Ошибка ${res.status}`));
  return body as T;
}

whenBackOnline(() => {
  if (!accessToken && cachedUser()) void refreshSession();
});

let nativeTokenUsed = false;

export async function refreshSession(): Promise<TokenResponse | null> {
  if (!refreshPromise) {
    // В приложении первый раз входим токеном, который дал его экран входа (у WebView ещё нет cookie)
    const nativeToken = isNative && !nativeTokenUsed ? nativeInfo?.refreshToken : null;
    if (nativeToken) nativeTokenUsed = true;
    refreshPromise = raw<TokenResponse>("/api/auth/refresh", { method: "POST", body: nativeToken ? JSON.stringify({ refresh_token: nativeToken }) : "{}" })
      .then((data) => {
        setSession(data);
        return data;
      })
      .catch((err) => {
        // нет связи — не выходим из аккаунта: открываем приложение со скачанной музыкой
        if (err instanceof ApiError && (err.status === 0 || err.status >= 502)) {
          const user = cachedUser();
          if (user) {
            listeners.forEach((fn) => fn(user));
            return null;
          }
        }
        setSession(null);
        return null;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await raw<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && !path.startsWith("/api/auth/")) {
      const refreshed = await refreshSession();
      if (refreshed) return raw<T>(path, init);
    }
    throw err;
  }
}

const json = (data: unknown) => JSON.stringify(data);

function qs(params: Record<string, unknown>) {
  const s = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  });
  const out = s.toString();
  return out ? `?${out}` : "";
}

function setupHeaders(token?: string): HeadersInit {
  return token ? { "X-Setup-Token": token } : {};
}

/** Загрузка файла с прогрессом (fetch не умеет прогресс отправки). */
export function uploadFile(
  form: FormData,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ path: string | null; track_id: number | null; skipped?: boolean }> {
  const send = () =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/uploads");
      xhr.withCredentials = true;
      if (accessToken) xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
      xhr.upload.onprogress = (e) => onProgress(e.loaded, e.total);
      xhr.onload = () => {
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = null;
        }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () => reject(new ApiError(0, "Нет связи с сервером"));
      xhr.onabort = () => reject(new ApiError(0, "Отменено"));
      signal?.addEventListener("abort", () => xhr.abort());
      xhr.send(form);
    });
  return send().then(async ({ status, body }) => {
    if (status === 401 && (await refreshSession())) {
      const retry = await send();
      status = retry.status;
      body = retry.body;
    }
    if (status === 413 && !body) throw new ApiError(413, "Файл слишком большой для прокси-сервера");
    if (status < 200 || status >= 300) throw new ApiError(status, errorMessage(body, `Ошибка ${status}`));
    return body as { path: string | null; track_id: number | null; skipped?: boolean };
  });
}

export const streamUrl = (id: number) => `/api/stream/${id}`;
export const downloadUrl = (id: number) => `/api/download/${id}`;
export const coverUrl = (url: string | null | undefined, size = 600) =>
  url ? `${url}${url.includes("?") ? "&" : "?"}size=${size}` : null;

export const api = {
  health: () => request<{ status: string; version: string }>("/api/health"),

  setup: {
    status: () => request<SetupStatus>("/api/setup/status"),
    testDb: (cfg: DatabaseConfig, token?: string) =>
      request<{ ok: true }>("/api/setup/test-db", { method: "POST", body: json(cfg), headers: setupHeaders(token) }),
    database: (cfg: DatabaseConfig, token?: string) =>
      request<{ ok: true }>("/api/setup/database", { method: "POST", body: json(cfg), headers: setupHeaders(token) }),
    admin: (
      data: { username: string; email: string; display_name: string; password: string; site_name: string; registration_mode: RegistrationMode },
      token?: string,
    ) => request<TokenResponse>("/api/setup/admin", { method: "POST", body: json(data), headers: setupHeaders(token) }),
  },

  auth: {
    login: (login: string, password: string, remember = true) =>
      request<TokenResponse>("/api/auth/login", { method: "POST", body: json({ login, password, remember }) }),
    register: (data: { username: string; email: string; display_name: string; password: string }) =>
      request<TokenResponse>("/api/auth/register", { method: "POST", body: json(data) }),
    logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    logoutAll: () => request<{ ok: true }>("/api/auth/logout-all", { method: "POST" }),
    androidApp: () => request<AndroidApp>("/api/app/info"),
  },

  settings: {
    get: () => request<PublicSettings>("/api/settings"),
  },

  me: {
    update: (data: Partial<Pick<User, "display_name" | "email" | "stream_quality" | "username" | "library_scope">>) =>
      request<User>("/api/me", { method: "PATCH", body: json(data) }),
    changePassword: (current_password: string, new_password: string) =>
      request<TokenResponse>("/api/me/password", { method: "POST", body: json({ current_password, new_password }) }),
    appPassword: () => request<{ username: string; password: string | null }>("/api/me/app-password"),
    regenerateAppPassword: () => request<{ username: string; password: string }>("/api/me/app-password", { method: "POST" }),
    uploadAvatar: (image: Blob) => {
      const form = new FormData();
      form.append("file", image, "avatar.jpg");
      return request<User>("/api/me/avatar", { method: "POST", body: form });
    },
    deleteAvatar: () => request<User>("/api/me/avatar", { method: "DELETE" }),
    removeAppPassword: () => request<{ username: string; password: null }>("/api/me/app-password", { method: "DELETE" }),
  },

  books: {
    home: () => request<BooksHome>("/api/books/home"),
    list: (p: { q?: string; sort?: string; filter?: string; series?: string; author?: string } = {}) =>
      request<BookCard[]>(`/api/books${qs(p)}`),
    get: (id: number) => request<BookDetail>(`/api/books/${id}`),
    progress: (id: number, body: { track_id: number; position: number; speed?: number; finished?: boolean }) =>
      request<BookProgress>(`/api/books/${id}/progress`, { method: "PUT", body: json(body) }),
    finished: (id: number, finished: boolean) =>
      request<{ progress: BookProgress | null }>(`/api/books/${id}/finished`, { method: "POST", body: json({ finished }) }),
    addBookmark: (id: number, body: { track_id: number; position: number; comment: string }) =>
      request<BookDetail["bookmarks"][number]>(`/api/books/${id}/bookmarks`, { method: "POST", body: json(body) }),
    deleteBookmark: (bookmarkId: number) => request<{ ok: true }>(`/api/bookmarks/${bookmarkId}`, { method: "DELETE" }),
  },

  library: {
    home: () => request<Home>("/api/home"),
    remoteQueue: (full = false) => request<RemoteQueue>(`/api/queue${qs({ full: full || undefined })}`),
    saveQueue: (
      data: {
        track_ids: number[];
        current_id: number | null;
        position: number;
        playing: boolean;
        device_id: string;
        device_name: string;
        started: boolean;
        since: string | null;
      },
      keepalive = false,
    ) =>
      request<{ superseded: boolean; rev?: number; started_at?: string | null; remote?: RemoteQueue }>("/api/queue", {
        method: "PUT",
        body: json(data),
        keepalive,
      }),
    stats: (p: { period: StatsPeriod; year?: number | null; scope?: "me" | "server" }) =>
      request<StatsResult>(`/api/stats${qs({ period: p.period, year: p.year ?? undefined, scope: p.scope ?? "me", tz: -new Date().getTimezoneOffset() })}`),
    libraries: () => request<MyLibrary[]>("/api/libraries"),
    radio: (body: { track_id?: number; artist_id?: number; exclude?: number[]; count?: number }) =>
      request<{ tracks: Track[] }>("/api/radio", { method: "POST", body: json(body) }),
    mixes: () => request<MixesOverview>("/api/mixes"),
    mix: (key: string) => request<MixDetail>(`/api/mixes/${key}`),
    refreshMix: (key: string) => request<MixDetail>(`/api/mixes/${key}/refresh`, { method: "POST" }),
    hideFromMix: (key: string, trackId: number) =>
      request<{ ok: true }>(`/api/mixes/${key}/hide`, { method: "POST", body: json({ track_id: trackId }) }),
    saveMix: (key: string, name = "") =>
      request<{ id: number; name: string }>(`/api/mixes/${key}/save`, { method: "POST", body: json({ name }) }),
    browse: (libraryId: number, path = "") => request<FolderView>(`/api/libraries/${libraryId}/browse${qs({ path })}`),
    folderSearch: (libraryId: number, q: string, path = "") =>
      request<FolderSearch>(`/api/libraries/${libraryId}/folder-search${qs({ q, path })}`),
    folderTracks: (libraryId: number, path = "") =>
      request<Track[]>(`/api/libraries/${libraryId}/folder-tracks${qs({ path })}`),
    albums: (p: { sort?: string; library?: number; genre?: string; q?: string; offset?: number; limit?: number } = {}) =>
      request<{ items: Album[]; total: number }>(`/api/albums${qs(p)}`),
    album: (id: number) => request<AlbumDetail>(`/api/albums/${id}`),
    artists: (p: { q?: string; library?: number } = {}) => request<Artist[]>(`/api/artists${qs(p)}`),
    artist: (id: number) => request<ArtistDetail>(`/api/artists/${id}`),
    artistTracks: (id: number) => request<Track[]>(`/api/artists/${id}/tracks`),
    search: (q: string) => request<{ artists: Artist[]; albums: Album[]; tracks: Track[] }>(`/api/search${qs({ q })}`),
    genres: () => request<Genre[]>("/api/genres"),
    randomTracks: (p: { limit?: number; genre?: string; library?: number } = {}) =>
      request<Track[]>(`/api/tracks/random${qs(p)}`),
    lyrics: (id: number) => request<{ lyrics: string | null }>(`/api/tracks/${id}/lyrics`),
    recordPlay: (track_id: number) => request<{ ok: true }>("/api/plays", { method: "POST", body: json({ track_id }) }),
    history: () => request<Track[]>("/api/history"),
  },

  favorites: {
    list: () => request<{ tracks: Track[]; albums: Album[]; artists: Artist[] }>("/api/favorites"),
    set: (kind: "track" | "album" | "artist", id: number, on: boolean) =>
      request<{ starred: boolean }>(`/api/favorites/${kind}/${id}`, { method: on ? "PUT" : "DELETE" }),
  },

  playlists: {
    list: () => request<Playlist[]>("/api/playlists"),
    get: (id: number) => request<PlaylistDetail>(`/api/playlists/${id}`),
    create: (data: { name: string; comment?: string; is_public?: boolean; track_ids?: number[]; rules?: SmartRules }) =>
      request<Playlist>("/api/playlists", { method: "POST", body: json(data) }),
    update: (id: number, data: { name?: string; comment?: string; is_public?: boolean; rules?: SmartRules }) =>
      request<Playlist>(`/api/playlists/${id}`, { method: "PATCH", body: json(data) }),
    preview: (rules: SmartRules) =>
      request<{ count: number; duration: number; tracks: Track[] }>("/api/playlists/preview", { method: "POST", body: json(rules) }),
    setMembers: (id: number, user_ids: number[]) =>
      request<Playlist>(`/api/playlists/${id}/members`, { method: "PUT", body: json({ user_ids }) }),
    leave: (id: number) => request<{ ok: true }>(`/api/playlists/${id}/leave`, { method: "POST" }),
    users: () => request<UserBrief[]>("/api/users/directory"),
    remove: (id: number) => request<{ ok: true }>(`/api/playlists/${id}`, { method: "DELETE" }),
    addTracks: (id: number, track_ids: number[]) =>
      request<{ added: number }>(`/api/playlists/${id}/tracks`, { method: "POST", body: json({ track_ids }) }),
    removeEntry: (id: number, entryId: number) =>
      request<{ ok: true }>(`/api/playlists/${id}/entries/${entryId}`, { method: "DELETE" }),
    reorder: (id: number, entry_ids: number[]) =>
      request<{ ok: true }>(`/api/playlists/${id}/order`, { method: "PUT", body: json({ entry_ids }) }),
  },

  shares: {
    list: (all = false) => request<Share[]>(`/api/shares${all ? "?all=true" : ""}`),
    create: (target: ShareTarget, opts: ShareOptions) => {
      const { label: _label, ...t } = target;
      void _label;
      return request<Share>("/api/shares", { method: "POST", body: json({ ...t, ...opts }) });
    },
    update: (id: number, opts: ShareOptions) => request<Share>(`/api/shares/${id}`, { method: "PATCH", body: json(opts) }),
    remove: (id: number) => request<{ ok: true }>(`/api/shares/${id}`, { method: "DELETE" }),
    dirs: (libraryId: number, path = "") => request<LibraryDirs>(`/api/libraries/${libraryId}/dirs${qs({ path })}`),
  },

  publicShare: {
    open: (token: string) => raw<PublicShare>(`/api/s/${token}`),
    unlock: (token: string, password: string) =>
      raw<{ ok: true }>(`/api/s/${token}/unlock`, { method: "POST", body: json({ password }) }),
    play: (token: string, track_id: number) =>
      raw<{ ok: true }>(`/api/s/${token}/play`, { method: "POST", body: json({ track_id }) }),
    lyrics: (token: string, id: number) => raw<{ lyrics: string | null }>(`/api/s/${token}/lyrics/${id}`),
  },

  uploads: {
    info: () => request<UploadInfo>("/api/uploads/info"),
    mine: () => request<MyUpload[]>("/api/uploads/mine"),
    deleteTrack: (id: number) => request<{ ok: true }>(`/api/tracks/${id}`, { method: "DELETE" }),
  },

  tags: {
    track: (id: number) => request<TrackTags>(`/api/tracks/${id}/tags`),
    saveTrack: (id: number, data: Partial<TagFields>) =>
      request<{ ok: true; track_id: number | null; album_id: number | null }>(`/api/tracks/${id}/tags`, {
        method: "PUT",
        body: json(data),
      }),
    album: (id: number) => request<AlbumTags>(`/api/albums/${id}/tags`),
    saveAlbum: (
      id: number,
      data: Partial<Pick<TagFields, "album" | "album_artist" | "artist" | "year" | "genre">> & {
        tracks?: Record<number, Partial<TagFields>>;
      },
    ) =>
      request<{ ok: boolean; errors: string[]; updated: number; album_id: number }>(`/api/albums/${id}/tags`, {
        method: "PUT",
        body: json(data),
      }),
    setCover: (id: number, file: Blob) => {
      const form = new FormData();
      form.append("file", file, "cover.jpg");
      return request<{ ok: true }>(`/api/albums/${id}/cover`, { method: "POST", body: form });
    },
  },

  /** Сведения из MusicBrainz: ручной выбор релиза и исполнителя (администратор) */
  meta: {
    album: (id: number) => request<AlbumMetaState>(`/api/albums/${id}/meta`),
    searchReleases: (id: number, q: string, artist: string) =>
      request<ReleaseCandidate[]>(`/api/albums/${id}/meta/search${qs({ q, artist })}`),
    chooseRelease: (id: number, data: { release?: string; auto?: boolean }) =>
      request<AlbumMetaState>(`/api/albums/${id}/meta`, { method: "POST", body: json(data) }),
    ignoreAlbum: (id: number) => request<AlbumMetaState>(`/api/albums/${id}/meta`, { method: "DELETE" }),
    artist: (id: number) => request<ArtistMetaState>(`/api/artists/${id}/meta`),
    searchArtists: (id: number, q: string) => request<ArtistCandidate[]>(`/api/artists/${id}/meta/search${qs({ q })}`),
    chooseArtist: (id: number, data: { artist?: string; auto?: boolean }) =>
      request<ArtistMetaState>(`/api/artists/${id}/meta`, { method: "POST", body: json(data) }),
    ignoreArtist: (id: number) => request<ArtistMetaState>(`/api/artists/${id}/meta`, { method: "DELETE" }),
  },

  admin: {
    settings: () => request<AdminSettings>("/api/admin/settings"),
    updateSettings: (data: Partial<AdminSettings>) =>
      request<AdminSettings>("/api/admin/settings", { method: "PATCH", body: json(data) }),
    users: () => request<AdminUser[]>("/api/admin/users"),
    createUser: (data: {
      username: string;
      email: string;
      display_name: string;
      password: string;
      is_admin: boolean;
      upload_mode: UploadMode;
      upload_quota_mb: number;
      upload_max_files: number;
      can_share: boolean;
    }) => request<AdminUser>("/api/admin/users", { method: "POST", body: json(data) }),
    uploadUserAvatar: (id: number, image: Blob) => {
      const form = new FormData();
      form.append("file", image, "avatar.jpg");
      return request<AdminUser>(`/api/admin/users/${id}/avatar`, { method: "POST", body: form });
    },
    deleteUserAvatar: (id: number) => request<AdminUser>(`/api/admin/users/${id}/avatar`, { method: "DELETE" }),
    updateUser: (id: number, data: Partial<Omit<User, "id" | "created_at" | "last_seen_at" | "stream_quality">>) =>
      request<AdminUser>(`/api/admin/users/${id}`, { method: "PATCH", body: json(data) }),
    setAccess: (id: number, access: { library_id: number; can_write: boolean }[]) =>
      request<AdminUser>(`/api/admin/users/${id}/access`, { method: "PUT", body: json({ access }) }),
    resetPassword: (id: number, password: string) =>
      request<{ ok: true }>(`/api/admin/users/${id}/password`, { method: "POST", body: json({ password }) }),
    deleteUser: (id: number) => request<{ ok: true }>(`/api/admin/users/${id}`, { method: "DELETE" }),
    libraries: () => request<AdminLibrary[]>("/api/admin/libraries"),
    analysis: () => request<AnalysisStatus>("/api/admin/analysis"),
    duplicates: (strict: boolean) => request<DuplicatesResult>(`/api/admin/duplicates${qs({ strict })}`),
    ignoreDuplicate: (key: string) => request<{ ok: true }>("/api/admin/duplicates/ignore", { method: "POST", body: json({ key }) }),
    updateAnalysis: (data: { enabled?: boolean; start?: string; end?: string }) =>
      request<AnalysisStatus>("/api/admin/analysis", { method: "PUT", body: json(data) }),
    runAnalysis: () => request<AnalysisStatus>("/api/admin/analysis/run", { method: "POST" }),
    stopAnalysis: () => request<AnalysisStatus>("/api/admin/analysis/stop", { method: "POST" }),
    meta: () => request<MetaAdminStatus>("/api/admin/meta"),
    updateMeta: (data: MetaSettingsPatch) => request<MetaAdminStatus>("/api/admin/meta", { method: "PUT", body: json(data) }),
    retryMeta: (everything = false) => request<MetaAdminStatus>("/api/admin/meta/retry", { method: "POST", body: json({ everything }) }),
    createLibrary: (data: { name: string; path: string; default_access: boolean; kind?: "music" | "audiobooks" }) =>
      request<AdminLibrary>("/api/admin/libraries", { method: "POST", body: json(data) }),
    updateLibrary: (id: number, data: Partial<Pick<AdminLibrary, "name" | "path" | "enabled" | "default_access" | "kind">>) =>
      request<AdminLibrary>(`/api/admin/libraries/${id}`, { method: "PATCH", body: json(data) }),
    libraryTree: (id: number, path = "") => request<FolderTree>(`/api/admin/libraries/${id}/tree${qs({ path })}`),
    setFolder: (id: number, path: string, include: boolean | null) =>
      request<{ ok: true; excluded_count: number }>(`/api/admin/libraries/${id}/folders`, { method: "PUT", body: json({ path, include }) }),
    uploadApp: (file: File, version: string) => {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("version", version);
      return request<AndroidApp>("/api/admin/app", { method: "POST", body: form });
    },
    fetchApp: (url: string, version: string) => request<AndroidApp>("/api/admin/app/url", { method: "POST", body: json({ url, version }) }),
    deleteApp: () => request<AndroidApp>("/api/admin/app", { method: "DELETE" }),
    deleteLibrary: (id: number) => request<{ ok: true }>(`/api/admin/libraries/${id}`, { method: "DELETE" }),
    browse: (path = "") => request<FsListing>(`/api/admin/fs${qs({ path })}`),
    scanStatus: () => request<ScanStatus>("/api/admin/scan"),
    scan: (library_id?: number, full = false) =>
      request<ScanStatus & { started: boolean }>("/api/admin/scan", { method: "POST", body: json({ library_id, full }) }),
  },
};
