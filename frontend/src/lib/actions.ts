import { api, type Track } from "./api";
import { player } from "./player";
import { invalidate, patchEverywhere } from "./query";
import { toast } from "./toast";

type Kind = "track" | "album" | "artist";

function isKind(o: Record<string, unknown>, kind: Kind) {
  if (kind === "track") return "album_id" in o && "title" in o;
  if (kind === "album") return "track_count" in o && "name" in o && !("title" in o);
  return "album_count" in o && !("track_count" in o);
}

/** Обойти закэшированные ответы и поменять флаг starred у нужного объекта. */
function patchStar(kind: Kind, id: number, starred: boolean) {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = walk(x);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      let next: Record<string, unknown> | null = null;
      if (o.id === id && "starred" in o && isKind(o, kind) && o.starred !== starred) next = { ...o, starred };
      for (const [k, val] of Object.entries(o)) {
        if (val && typeof val === "object") {
          const w = walk(val);
          if (w !== val) {
            next = next ?? { ...o };
            next[k] = w;
          }
        }
      }
      return next ?? v;
    }
    return v;
  };
  patchEverywhere(walk);
}

export async function setFavorite(kind: Kind, id: number, starred: boolean) {
  patchStar(kind, id, starred);
  if (kind === "track") player.patchTrack(id, { starred });
  try {
    await api.favorites.set(kind, id, starred);
    invalidate(["favorites"]);
  } catch (err) {
    patchStar(kind, id, !starred);
    if (kind === "track") player.patchTrack(id, { starred: !starred });
    toast.error((err as Error).message);
  }
}

export async function playAlbum(id: number, shuffle = false) {
  try {
    const album = await api.library.album(id);
    player.play(album.tracks, 0, { shuffle });
  } catch (err) {
    toast.error((err as Error).message);
  }
}

export async function playArtist(id: number, shuffle = false) {
  try {
    const tracks = await api.library.artistTracks(id);
    player.play(tracks, 0, { shuffle });
  } catch (err) {
    toast.error((err as Error).message);
  }
}

export async function playPlaylist(id: number, shuffle = false) {
  try {
    const pl = await api.playlists.get(id);
    player.play(pl.tracks, 0, { shuffle });
  } catch (err) {
    toast.error((err as Error).message);
  }
}

export function queueTracks(tracks: Track[], next: boolean) {
  if (next) player.playNext(tracks);
  else player.enqueue(tracks);
  toast.success(next ? "Сыграет следующим" : tracks.length > 1 ? `В очереди: +${tracks.length}` : "Добавлено в очередь");
}

export async function playRandom(genre?: string) {
  try {
    const tracks = await api.library.randomTracks({ limit: 100, genre });
    if (!tracks.length) return toast.info("Пока нечего играть");
    player.play(tracks, 0, { shuffle: false });
  } catch (err) {
    toast.error((err as Error).message);
  }
}


/** «Радио»: начать с трека (или исполнителя) и бесконечно продолжать похожими */
export async function startRadio(seed: { track?: Track; artist_id?: number; label: string }) {
  try {
    await player.startRadio(seed);
    toast.success(`Радио: ${seed.label}`);
  } catch (err) {
    toast.error((err as Error).message);
  }
}
