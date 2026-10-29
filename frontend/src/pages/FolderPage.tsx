import { useEffect, useState } from "react";
import { Cover } from "@/components/Cover";
import { PlayFill } from "@/components/icon";
import { ChevronRight, Folder, Link as LinkIcon, Search, Shuffle, X } from "@/components/icons";
import { TrackList } from "@/components/TrackList";
import { Empty, ErrorBox, PageLoader } from "@/components/ui/misc";
import { api, type FolderEntry } from "@/lib/api";
import { useCanShare } from "@/lib/auth";
import { dialogs } from "@/lib/dialogs";
import { formatDuration, formatSize, tracksLabel } from "@/lib/format";
import { player } from "@/lib/player";
import { useQuery } from "@/lib/query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

function folderHref(libraryId: number, path: string) {
  return path ? `/folders/${libraryId}?path=${encodeURIComponent(path)}` : `/folders/${libraryId}`;
}

/** Слушать всю папку вместе с подпапками */
async function playFolder(libraryId: number, path: string, shuffle = false) {
  try {
    const tracks = await api.library.folderTracks(libraryId, path);
    if (!tracks.length) return toast.error("В папке нет треков");
    player.play(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : 0, { shuffle });
  } catch (err) {
    toast.error((err as Error).message);
  }
}

function FolderTile({ libraryId, f, sub }: { libraryId: number; f: FolderEntry; sub?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="group relative">
      <Link
        to={folderHref(libraryId, f.path)}
        className="glass flex items-center gap-3.5 rounded-2xl border p-2.5 pr-12 transition hover:border-accent/40 hover:bg-surface-2/60"
      >
        <span className="relative grid size-14 shrink-0 grid-cols-2 grid-rows-2 overflow-hidden rounded-xl bg-surface-2">
          {f.covers.length === 0 && (
            <span className="col-span-2 row-span-2 flex items-center justify-center text-accent-ink">
              <Folder className="size-7" />
            </span>
          )}
          {f.covers.length > 0 && f.covers.length < 4 && (
            <Cover src={f.covers[0]} seed={f.name} size={128} rounded="rounded-none" className="col-span-2 row-span-2 size-14" />
          )}
          {f.covers.length >= 4 &&
            f.covers.slice(0, 4).map((c, i) => <Cover key={i} src={c} seed={f.name} size={64} rounded="rounded-none" className="size-7" />)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-bold">{f.name}</span>
          <span className="block truncate text-[13px] text-faint" title={sub}>
            {sub ? `${sub} · ` : ""}
            {tracksLabel(f.track_count)}
          </span>
        </span>
      </Link>
      <button
        type="button"
        aria-label={`Слушать «${f.name}»`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await playFolder(libraryId, f.path);
          setBusy(false);
        }}
        className="absolute top-1/2 right-2.5 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-accent-fg opacity-0 shadow-lg transition group-hover:opacity-100 focus-visible:opacity-100 max-lg:opacity-100 max-lg:bg-surface-2 max-lg:text-fg max-lg:shadow-none"
      >
        <PlayFill className="ml-0.5 size-4" />
      </button>
    </div>
  );
}

/** Поиск по папке и всем её подпапкам. */
function FolderSearchResults({ libraryId, path, query }: { libraryId: number; path: string; query: string }) {
  const q = useQuery(["folder-search", libraryId, path, query], () => api.library.folderSearch(libraryId, query, path), { staleTime: 30_000 });
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const r = q.data;
  if (!r.folders.length && !r.tracks.length)
    return <Empty icon={<Search />} title="Ничего не нашлось" text={`В этой папке нет ничего похожего на «${query}».`} />;
  const base = path ? path + "/" : "";
  return (
    <div className="flex flex-col gap-7">
      {r.folders.length > 0 && (
        <section aria-label="Найденные папки" className="flex flex-col gap-2.5">
          <h2 className="label-caps px-1">Папки{r.more_folders ? " — первые 60" : ""}</h2>
          <div className="grid gap-2.5 sm:[grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
            {r.folders.map((f) => (
              <FolderTile
                key={f.path}
                libraryId={libraryId}
                f={f}
                sub={f.parent.startsWith(base) ? f.parent.slice(base.length) || undefined : f.parent || undefined}
              />
            ))}
          </div>
        </section>
      )}
      {r.tracks.length > 0 && (
        <section aria-label="Найденные треки" className="flex flex-col gap-2">
          <h2 className="label-caps px-1">Треки{r.more_tracks ? " — первые 100" : ""}</h2>
          <TrackList tracks={r.tracks} showAlbum selectable className="-mx-2 sm:-mx-3" />
        </section>
      )}
    </div>
  );
}

export default function FolderPage() {
  const { id } = useParams<{ id: string }>();
  const libraryId = Number(id);
  const path = useSearchParams().get("path") ?? "";
  const q = useQuery(["folder", libraryId, path], () => api.library.browse(libraryId, path));
  const canShare = useCanShare();
  const v = q.data;
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);
  useEffect(() => setSearch(""), [libraryId, path]);

  if (q.isLoading) return <PageLoader />;
  if (q.error || !v) return <ErrorBox error={q.error} />;

  const parentPath = v.crumbs.length > 1 ? v.crumbs[v.crumbs.length - 2].path : "";

  return (
    <div className="flex flex-col gap-7">
      <nav aria-label="Путь" className="flex min-w-0 flex-wrap items-center gap-1 text-[13px] font-semibold text-muted">
        <Link to="/folders" className="rounded px-1 hover:text-fg">
          Папки
        </Link>
        <ChevronRight className="size-3.5 text-faint" />
        <Link to={folderHref(libraryId, "")} className={cn("rounded px-1 hover:text-fg", !path && "text-fg")}>
          {v.library.name}
        </Link>
        {v.crumbs.map((c, i) => (
          <span key={c.path} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="size-3.5 shrink-0 text-faint" />
            <Link
              to={folderHref(libraryId, c.path)}
              className={cn("max-w-[14rem] truncate rounded px-1 hover:text-fg", i === v.crumbs.length - 1 && "text-fg")}
            >
              {c.name}
            </Link>
          </span>
        ))}
      </nav>

      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="label-caps">{path ? "Папка" : "Медиатека"}</div>
          <h1 className="title-display mt-1.5 text-3xl break-words sm:text-5xl">{v.name}</h1>
          <p className="mt-2 text-sm text-muted">
            {v.folders.length > 0 && `${v.folders.length} ${v.folders.length === 1 ? "папка" : v.folders.length < 5 ? "папки" : "папок"} · `}
            {tracksLabel(v.total_tracks)} · {formatDuration(v.total_duration)} · {formatSize(v.total_size)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            aria-label="Слушать всё"
            onClick={() => playFolder(libraryId, path)}
            className="flex size-14 items-center justify-center rounded-full bg-accent text-accent-fg shadow-xl shadow-black/25 transition hover:scale-105"
          >
            <PlayFill className="ml-1 size-6" />
          </button>
          <button
            aria-label="Перемешать"
            onClick={() => playFolder(libraryId, path, true)}
            className="flex size-12 items-center justify-center rounded-full border text-muted transition hover:bg-surface-2 hover:text-fg"
          >
            <Shuffle className="size-5" />
          </button>
          {canShare && (
            <button
              onClick={() => dialogs.share({ kind: "folder", library_id: libraryId, folder: path, label: v.name })}
              className="flex h-12 items-center gap-2 rounded-full border px-4 text-[14px] font-bold text-muted transition hover:bg-surface-2 hover:text-fg"
            >
              <LinkIcon className="size-4" /> Поделиться
            </button>
          )}
        </div>
      </header>

      {(v.total_tracks > 0 || search) && (
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-faint" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setSearch("")}
            placeholder={path ? `Искать в «${v.name}»` : "Искать в папках и треках"}
            aria-label="Поиск в папке"
            className="h-12 w-full rounded-full border bg-surface-2/60 pr-11 pl-11 text-[15px] outline-none placeholder:text-faint focus:border-accent/60 focus:bg-surface-2 [&::-webkit-search-cancel-button]:hidden"
          />
          {search && (
            <button
              aria-label="Очистить поиск"
              onClick={() => setSearch("")}
              className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-surface-3 hover:text-fg"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      )}

      {query.length >= 2 ? (
        <FolderSearchResults libraryId={libraryId} path={path} query={query} />
      ) : (
        <>
      {v.folders.length > 0 && (
        <section aria-label="Подпапки" className="grid gap-2.5 sm:[grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
          {path && (
            <Link
              to={folderHref(libraryId, parentPath)}
              className="flex items-center gap-3.5 rounded-2xl border border-dashed p-2.5 text-muted transition hover:bg-surface-2/60 hover:text-fg"
            >
              <span className="flex size-14 items-center justify-center rounded-xl bg-surface-2/60 text-xl font-bold">..</span>
              <span className="text-[15px] font-bold">Наверх</span>
            </Link>
          )}
          {v.folders.map((f) => (
            <FolderTile key={f.path} libraryId={libraryId} f={f} />
          ))}
        </section>
      )}

      {v.tracks.length > 0 && (
        <section aria-label="Треки" className="flex flex-col gap-2">
          {v.folders.length > 0 && <h2 className="label-caps px-1">Треки в этой папке</h2>}
          <TrackList tracks={v.tracks} showAlbum selectable className="-mx-2 sm:-mx-3" />
        </section>
      )}

      {v.folders.length === 0 && v.tracks.length === 0 && (
        <Empty icon={<Folder />} title="Здесь пока пусто" text="Музыка появится после сканирования папки." />
      )}
        </>
      )}
    </div>
  );
}
