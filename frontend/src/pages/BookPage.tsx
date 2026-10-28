import { useState } from "react";
import { Cover } from "@/components/Cover";
import { DownloadButton } from "@/components/DownloadButton";
import { PlayFill } from "@/components/icon";
import { Bookmark, CircleCheck, Ellipsis, RotateCcw, Trash } from "@/components/icons";
import { Menu } from "@/components/ui/menu";
import { ErrorBox, PageLoader } from "@/components/ui/misc";
import { api, coverUrl } from "@/lib/api";
import { leftLabel, playBook, seqLabel } from "@/lib/books";
import { usePalette } from "@/lib/colors";
import { formatDuration, formatTime } from "@/lib/format";
import { player, usePlayer } from "@/lib/player";
import { invalidate, useQuery } from "@/lib/query";
import { Link, useParams } from "@/lib/router";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export default function BookPage() {
  const { id } = useParams<{ id: string }>();
  const bookId = Number(id);
  const q = useQuery(["book", bookId], () => api.books.get(bookId));
  const b = q.data;
  const palette = usePalette(coverUrl(b?.cover, 96), b?.title ?? "");
  const playingBook = usePlayer((s) => s.book?.id ?? null);
  const time = usePlayer((s) => s.time);
  const curTrack = usePlayer((s) => s.queue[s.index]?.id ?? null);
  const [moreDesc, setMoreDesc] = useState(false);

  if (q.isLoading) return <PageLoader />;
  if (q.error || !b) return <ErrorBox error={q.error} />;

  const isPlaying = playingBook === b.id;
  const p = b.progress;
  // текущая глава: у играющей книги — по плееру, иначе — по сохранённому месту
  const curIdx = (() => {
    const track = isPlaying ? curTrack : p?.track_id;
    const pos = isPlaying ? time : (p?.position ?? 0);
    let found = -1;
    b.chapters.forEach((c, i) => {
      if (c.track_id === track && c.start <= pos + 0.5) found = i;
    });
    return found;
  })();
  const started = Boolean(p && !p.finished && p.progress > 0);
  const refresh = () => invalidate(["book", bookId], ["books"]);

  return (
    <div className="flex flex-col gap-8">
      <header className="relative -mx-4 -mt-5 overflow-hidden px-4 pt-8 pb-2 sm:-mx-6 sm:px-6 lg:-mx-10 lg:-mt-8 lg:px-10 lg:pt-12">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 opacity-50"
          style={{ background: `radial-gradient(110% 90% at 10% 0%, color-mix(in srgb, ${palette[0]} 50%, transparent), transparent 70%)` }}
        />
        <div className="flex flex-col items-center gap-6 text-center sm:flex-row sm:items-end sm:text-left">
          <div className="w-52 shrink-0 sm:w-60">
            <Cover src={b.cover} seed={b.title + b.author} size={600} className="shadow-[0_24px_60px_rgba(0,0,0,0.45)]" />
          </div>
          <div className="min-w-0">
            <div className="label-caps">
              Аудиокнига
              {b.series && (
                <>
                  {" · "}
                  <Link to={`/books?series=${encodeURIComponent(b.series)}`} className="hover:underline">
                    {b.series} {seqLabel(b.series_seq)}
                  </Link>
                </>
              )}
            </div>
            <h1 className="title-display mt-2 text-3xl break-words sm:text-5xl">{b.title}</h1>
            {b.subtitle && <p className="mt-1 text-lg text-muted">{b.subtitle}</p>}
            <p className="mt-3 text-[15px]">
              <Link to={`/books?author=${encodeURIComponent(b.author)}`} className="font-bold hover:underline">
                {b.author}
              </Link>
              {b.narrator && <span className="text-muted"> · читает {b.narrator}</span>}
            </p>
            <p className="mt-1 text-sm text-faint">
              {[b.year, formatDuration(b.duration), `${b.chapters.length} ${b.chapters.length === 1 ? "глава" : b.chapters.length < 5 ? "главы" : "глав"}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
      </header>

      {p && !p.finished && (
        <div className="flex max-w-xl flex-col gap-1.5">
          <div className="h-2 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, p.progress * 100)}%` }} />
          </div>
          <div className="text-[13px] text-muted">
            Прослушано {Math.round(p.progress * 100)}% · осталось {leftLabel(b.duration * (1 - p.progress))}
            {p.speed !== 1 && ` (на скорости ${p.speed}× — ${leftLabel((b.duration * (1 - p.progress)) / p.speed)})`}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => (isPlaying ? player.toggle() : playBook(b))}
          className="flex h-14 items-center gap-2.5 rounded-full bg-accent px-7 text-[16px] font-extrabold text-accent-fg shadow-xl shadow-black/25 transition hover:scale-[1.03]"
        >
          <PlayFill className="size-5" />
          {isPlaying ? "Играет" : started ? `Продолжить${curIdx >= 0 ? ` · ${b.chapters[curIdx]?.title ?? ""}` : ""}` : p?.finished ? "Слушать снова" : "Слушать"}
        </button>
        {started && (
          <button
            onClick={() => playBook(b, { chapter: 0 })}
            className="flex h-12 items-center gap-2 rounded-full border px-4 text-[14px] font-bold text-muted hover:bg-surface-2 hover:text-fg"
          >
            <RotateCcw className="size-4" /> С начала
          </button>
        )}
        <DownloadButton kind="book" id={b.id} title={b.title} subtitle={b.author} cover={b.cover} link={`/books/${b.id}`} tracks={b.tracks} />
        <Menu
          label="Ещё"
          items={[
            p?.finished
              ? {
                  label: "Отметить как непрослушанную",
                  icon: <RotateCcw />,
                  onSelect: () => api.books.finished(b.id, false).then(refresh),
                }
              : {
                  label: "Отметить как прослушанную",
                  icon: <CircleCheck />,
                  onSelect: () => api.books.finished(b.id, true).then(refresh),
                },
          ]}
          trigger={(t) => (
            <button {...t} aria-label="Ещё" className="flex size-12 items-center justify-center rounded-full border text-muted hover:bg-surface-2 hover:text-fg">
              <Ellipsis className="size-5" />
            </button>
          )}
        />
      </div>

      {b.description && (
        <section className="max-w-3xl">
          <p className={cn("text-[15px] leading-relaxed whitespace-pre-line text-muted", !moreDesc && "line-clamp-4")}>{b.description}</p>
          {b.description.length > 300 && (
            <button onClick={() => setMoreDesc((v) => !v)} className="mt-1 text-sm font-bold text-accent-ink hover:underline">
              {moreDesc ? "Свернуть" : "Читать полностью"}
            </button>
          )}
        </section>
      )}

      {b.bookmarks.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="label-caps px-1">Закладки</h2>
          {b.bookmarks.map((m) => {
            const ch = b.chapters.filter((c) => c.track_id === m.track_id && c.start <= m.position).pop();
            return (
              <div key={m.id} className="flex items-center gap-3 rounded-xl p-2 hover:bg-surface-2/60">
                <Bookmark className="size-5 shrink-0 text-accent-ink" />
                <button onClick={() => playBook(b, { trackId: m.track_id, position: m.position })} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[15px] font-semibold">{m.comment || ch?.title || "Закладка"}</span>
                  <span className="block text-[13px] text-faint">
                    {ch?.title} · {formatTime(m.position - (ch?.start ?? 0))}
                  </span>
                </button>
                <button
                  aria-label="Удалить закладку"
                  onClick={() =>
                    api.books
                      .deleteBookmark(m.id)
                      .then(refresh)
                      .catch((e) => toast.error((e as Error).message))
                  }
                  className="flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-danger"
                >
                  <Trash className="size-4" />
                </button>
              </div>
            );
          })}
        </section>
      )}

      <section className="flex flex-col">
        <h2 className="label-caps px-1 pb-2">Главы</h2>
        {b.chapters.map((c, i) => {
          const active = i === curIdx;
          return (
            <button
              key={i}
              onClick={() => (isPlaying ? player.jumpToChapter(i) : playBook(b, { chapter: i }))}
              className={cn("flex items-center gap-4 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-2/60", active && "bg-surface-2")}
            >
              <span className={cn("num w-7 shrink-0 text-right text-sm", active ? "text-accent-ink" : "text-faint")}>{i + 1}</span>
              <span className={cn("min-w-0 flex-1 truncate text-[15px] font-semibold", active && "text-accent-ink")}>{c.title}</span>
              <span className="num text-[13px] text-faint">{formatTime(c.end - c.start)}</span>
            </button>
          );
        })}
      </section>
    </div>
  );
}
