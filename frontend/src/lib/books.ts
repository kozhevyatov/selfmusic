import { api, type BookDetail } from "./api";
import { player } from "./player";
import { toast } from "./toast";

/** «осталось 3 ч 12 мин» */
export function leftLabel(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} ч ${m} мин`;
  if (m) return `${m} мин`;
  return `${s} с`;
}

export function seqLabel(seq: number | null) {
  if (seq == null) return "";
  return Number.isInteger(seq) ? `#${seq}` : `#${seq.toFixed(1)}`;
}

/** Место в книге: с сервера или локальное (если слушали без связи и оно новее) */
function resumePoint(book: BookDetail): { trackId?: number; position?: number; speed?: number } {
  let best = book.progress && !book.progress.finished
    ? { trackId: book.progress.track_id ?? undefined, position: book.progress.position, speed: book.progress.speed, at: Date.parse(book.progress.updated_at) }
    : null;
  try {
    const raw = localStorage.getItem(`sm-book-${book.id}`);
    if (raw) {
      const local = JSON.parse(raw) as { track_id: number; position: number; speed: number; at: number };
      if (!best || local.at > (best.at || 0) + 5000) best = { trackId: local.track_id, position: local.position, speed: local.speed, at: local.at };
    }
  } catch {
    /* нет локального места */
  }
  return best ? { trackId: best.trackId, position: best.position, speed: best.speed } : {};
}

export function playBook(book: BookDetail, from?: { chapter?: number; trackId?: number; position?: number }) {
  const resume = resumePoint(book);
  let opts = resume;
  if (from?.chapter !== undefined) {
    const ch = book.chapters[from.chapter];
    if (ch) opts = { trackId: ch.track_id, position: ch.start, speed: resume.speed };
  } else if (from?.trackId) {
    opts = { trackId: from.trackId, position: from.position ?? 0, speed: resume.speed };
  }
  player.playBook(
    { id: book.id, title: book.title, author: book.author, cover: book.cover, chapters: book.chapters, duration: book.duration },
    book.tracks,
    opts,
  );
}

export async function playBookById(id: number) {
  try {
    playBook(await api.books.get(id));
  } catch (err) {
    toast.error((err as Error).message);
  }
}
