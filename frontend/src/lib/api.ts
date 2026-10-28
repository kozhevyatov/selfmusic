/**
 * Клиент API.
 * access-токен живёт в памяти, refresh — в httpOnly-cookie (веб); для потока и обложек
 * сервер ставит отдельную media-cookie, поэтому <audio> и <img> работают без заголовков.
 * При 401 клиент один раз обновляет токен и повторяет запрос.
 */

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
  upload_mode: UploadMode;
  upload_quota_mb: number;
  upload_max_files: number;
  can_share: boolean;
  created_at: string;
  last_seen_at: string | null;
};

export type TokenResponse = { access_token: string; refresh_token: string; token_type: string; user: User };

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
  starred: boolean;
  can_delete?: boolean;
  entry_id?: number;
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
};

export type Artist = { id: number; name: string; album_count: number; cover: string | null; starred: boolean };

export type ArtistDetail = Artist & {
  albums: Album[];
  appears_on: Album[];
  top_tracks: Track[];
  track_count: number;
};

export type Home = {
  recent_albums: Album[];
  recently_played: Album[];
  random_albums: Album[];
  frequent_artists: Artist[];
  stats: { tracks: number; albums: number; artists: number; duration: number };
};

export type MyLibrary = {
  id: number;
  name: string;
  path: string | null;
  track_count: number;
  album_count: number;
  total_duration: number;
  total_size: number;
  last_scan_at: string | null;
};

export type Playlist = {
  id: number;
  name: string;
  comment: string;
  is_public: boolean;
  owner: { id: number; name: string };
  is_owner: boolean;
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

export type AdminLibrary = {
  id: number;
  name: string;
  path: string;
  enabled: boolean;
  default_access: boolean;
  owner: { id: number; name: string } | null;
  writable: boolean;
  track_count: number;
  album_count: number;
  total_size: number;
  total_duration: number;
  last_scan_at: string | null;
  last_scan_error: string | null;
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
  targets: { id: number; name: string; personal: boolean }[];
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
  max_views?: number | null;
  enabled?: boolean;
};

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

export function setSession(data: TokenResponse | null) {
  accessToken = data?.access_token ?? null;
  listeners.forEach((fn) => fn(data?.user ?? null));
}

export function updateCurrentUser(user: User) {
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
  const res = await fetch(path, { ...init, headers, credentials: "include" });
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

export async function refreshSession(): Promise<TokenResponse | null> {
  if (!refreshPromise) {
    refreshPromise = raw<TokenResponse>("/api/auth/refresh", { method: "POST", body: "{}" })
      .then((data) => {
        setSession(data);
        return data;
      })
      .catch(() => {
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
  },

  settings: {
    get: () => request<PublicSettings>("/api/settings"),
  },

  me: {
    update: (data: Partial<Pick<User, "display_name" | "email" | "stream_quality">>) =>
      request<User>("/api/me", { method: "PATCH", body: json(data) }),
    changePassword: (current_password: string, new_password: string) =>
      request<TokenResponse>("/api/me/password", { method: "POST", body: json({ current_password, new_password }) }),
    appPassword: () => request<{ username: string; password: string | null }>("/api/me/app-password"),
    regenerateAppPassword: () => request<{ username: string; password: string }>("/api/me/app-password", { method: "POST" }),
    removeAppPassword: () => request<{ username: string; password: null }>("/api/me/app-password", { method: "DELETE" }),
  },

  library: {
    home: () => request<Home>("/api/home"),
    libraries: () => request<MyLibrary[]>("/api/libraries"),
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
    create: (data: { name: string; comment?: string; is_public?: boolean; track_ids?: number[] }) =>
      request<Playlist>("/api/playlists", { method: "POST", body: json(data) }),
    update: (id: number, data: { name?: string; comment?: string; is_public?: boolean }) =>
      request<Playlist>(`/api/playlists/${id}`, { method: "PATCH", body: json(data) }),
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
    updateUser: (id: number, data: Partial<Omit<User, "id" | "created_at" | "last_seen_at" | "stream_quality">>) =>
      request<AdminUser>(`/api/admin/users/${id}`, { method: "PATCH", body: json(data) }),
    setAccess: (id: number, access: { library_id: number; can_write: boolean }[]) =>
      request<AdminUser>(`/api/admin/users/${id}/access`, { method: "PUT", body: json({ access }) }),
    resetPassword: (id: number, password: string) =>
      request<{ ok: true }>(`/api/admin/users/${id}/password`, { method: "POST", body: json({ password }) }),
    deleteUser: (id: number) => request<{ ok: true }>(`/api/admin/users/${id}`, { method: "DELETE" }),
    libraries: () => request<AdminLibrary[]>("/api/admin/libraries"),
    createLibrary: (data: { name: string; path: string; default_access: boolean }) =>
      request<AdminLibrary>("/api/admin/libraries", { method: "POST", body: json(data) }),
    updateLibrary: (id: number, data: Partial<Pick<AdminLibrary, "name" | "path" | "enabled" | "default_access">>) =>
      request<AdminLibrary>(`/api/admin/libraries/${id}`, { method: "PATCH", body: json(data) }),
    deleteLibrary: (id: number) => request<{ ok: true }>(`/api/admin/libraries/${id}`, { method: "DELETE" }),
    browse: (path = "") => request<FsListing>(`/api/admin/fs${qs({ path })}`),
    scanStatus: () => request<ScanStatus>("/api/admin/scan"),
    scan: (library_id?: number, full = false) =>
      request<ScanStatus & { started: boolean }>("/api/admin/scan", { method: "POST", body: json({ library_id, full }) }),
  },
};
