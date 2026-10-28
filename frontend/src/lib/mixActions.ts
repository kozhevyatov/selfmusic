import { api } from "./api";
import { player } from "./player";
import { toast } from "./toast";

/** Включить подборку целиком (с плитки, с главной). */
export async function playTracksOf(key: string, shuffle = false) {
  try {
    const mix = await api.library.mix(key);
    if (!mix.tracks.length) return toast.error("В подборке пока нет треков");
    player.play(mix.tracks, 0, { shuffle });
  } catch (err) {
    toast.error((err as Error).message);
  }
}
