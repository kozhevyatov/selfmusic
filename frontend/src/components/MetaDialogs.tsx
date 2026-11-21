import { useEffect, useState, type FormEvent } from "react";
import { Check, Disc3, ExternalLink, LoaderCircle, RefreshCw, Search, Trash } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import {
  api,
  type AlbumMetaState,
  type ArtistCandidate,
  type ArtistMetaState,
  type MetaStatus,
  type ReleaseCandidate,
} from "@/lib/api";
import { dialogs } from "@/lib/dialogs";
import { invalidate } from "@/lib/query";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const MB = "https://musicbrainz.org";

export const META_STATUS: Record<MetaStatus, string> = {
  pending: "ещё не проверялся",
  found: "найден автоматически",
  manual: "выбран вручную",
  notfound: "не найден",
  error: "ошибка при поиске",
  ignored: "поиск отключён",
};

const SOURCE: Record<string, string> = {
  tags: "по MBID из тегов",
  search: "по названию",
  acoustid: "по звуку (AcoustID)",
  album: "по найденному альбому",
  manual: "вручную",
};

function StatusLine({ status, source, error }: { status: MetaStatus; source: string; error: string | null }) {
  const ok = status === "found" || status === "manual";
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge className={cn(ok && "text-accent-ink")}>{META_STATUS[status]}</Badge>
      {ok && SOURCE[source] && <span className="text-muted">{SOURCE[source]}</span>}
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}

/** Ошибка сети — понятным текстом */
function fail(err: unknown) {
  toast.error((err as Error).message || "Не получилось");
}

// ---------------- альбом ----------------

function ReleaseRow({ r, current, busy, onPick }: { r: ReleaseCandidate; current: boolean; busy: boolean; onPick: () => void }) {
  const [img, setImg] = useState(true);
  return (
    <li className={cn("flex items-center gap-3 rounded-2xl p-2", current ? "bg-surface-2" : "hover:bg-surface-2")}>
      <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-3 text-faint">
        {img ? (
          <img src={r.cover} alt="" loading="lazy" className="size-full object-cover" onError={() => setImg(false)} />
        ) : (
          <Disc3 className="size-6" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-bold">
          {r.title}
          {r.disambiguation && <span className="font-normal text-muted"> ({r.disambiguation})</span>}
        </div>
        <div className="truncate text-[13px] text-muted">{r.artist}</div>
        <div className="truncate text-[12px] text-faint">
          {[r.date || "без даты", r.country, r.media, r.track_count ? `${r.track_count} тр.` : "", r.type, r.status === "Official" ? "" : r.status]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <a
        href={`${MB}/release/${r.id}`}
        target="_blank"
        rel="noreferrer"
        aria-label="Открыть в MusicBrainz"
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-3 hover:text-fg"
      >
        <ExternalLink className="size-4" />
      </a>
      <Button size="sm" variant={current ? "secondary" : "outline"} disabled={busy || current} onClick={onPick}>
        {current ? <Check className="size-4" /> : null}
        {current ? "Выбран" : "Выбрать"}
      </Button>
    </li>
  );
}

export function AlbumMetaDialog({ albumId }: { albumId: number }) {
  const [state, setState] = useState<AlbumMetaState | null>(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [link, setLink] = useState("");
  const [results, setResults] = useState<ReleaseCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);

  const search = async (t = title, a = artist) => {
    setSearching(true);
    try {
      setResults(await api.meta.searchReleases(albumId, t, a));
    } catch (err) {
      fail(err);
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    api.meta
      .album(albumId)
      .then((s) => {
        setState(s);
        setTitle(s.query.title);
        setArtist(s.query.artist === "Разные исполнители" ? "" : s.query.artist);
        search(s.query.title, s.query.artist === "Разные исполнители" ? "" : s.query.artist);
      })
      .catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumId]);

  const done = (s: AlbumMetaState, msg: string) => {
    setState(s);
    invalidate(["album", albumId], ["albums"], ["home"], ["artist"]);
    toast.success(msg);
  };
  const act = async (fn: () => Promise<AlbumMetaState>, msg: string) => {
    setBusy(true);
    try {
      done(await fn(), msg);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    search();
  };

  return (
    <Dialog
      open
      wide
      onClose={dialogs.close}
      title="Сведения из MusicBrainz"
      description="Релиз даёт обложку (если своей у альбома нет), год и жанр (если их нет в тегах). Файлы с музыкой не меняются."
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => act(() => api.meta.ignoreAlbum(albumId), "Поиск для альбома отключён")}>
            <Trash className="size-4" /> Не искать
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => act(() => api.meta.chooseRelease(albumId, { auto: true }), "Готово")}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Найти автоматически
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {state && (
          <div className="flex flex-col gap-1">
            <StatusLine status={state.status} source={state.source} error={state.error} />
            {state.release_mbid && (
              <a href={`${MB}/release/${state.release_mbid}`} target="_blank" rel="noreferrer" className="text-sm text-muted hover:text-fg hover:underline">
                {state.artist} — {state.title}
                {state.year ? `, ${state.year}` : ""}
                {state.genre ? ` · ${state.genre}` : ""}
                {state.cover_from_meta ? " · обложка из Cover Art Archive" : ""}
              </a>
            )}
          </div>
        )}
        <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input aria-label="Название" placeholder="Название альбома" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input aria-label="Исполнитель" placeholder="Исполнитель (необязательно)" value={artist} onChange={(e) => setArtist(e.target.value)} />
          <Button type="submit" variant="secondary" disabled={searching || !title.trim()}>
            {searching ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />} Найти
          </Button>
        </form>
        {results === null || searching ? (
          <div className="flex justify-center py-8 text-muted">
            <LoaderCircle className="size-6 animate-spin" />
          </div>
        ) : results.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Ничего не нашлось. Попробуйте изменить название или вставьте ссылку на релиз.</p>
        ) : (
          <ul className="-mx-2 flex flex-col gap-1">
            {results.map((r) => (
              <ReleaseRow
                key={r.id}
                r={r}
                busy={busy}
                current={state?.release_mbid === r.id && state.status !== "ignored"}
                onPick={() => act(() => api.meta.chooseRelease(albumId, { release: r.id }), "Релиз выбран")}
              />
            ))}
          </ul>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(() => api.meta.chooseRelease(albumId, { release: link.trim() }), "Релиз выбран").then(() => setLink(""));
          }}
          className="flex flex-wrap items-center gap-2 border-t pt-4"
        >
          <Input
            aria-label="Ссылка на релиз"
            className="min-w-60 flex-1"
            placeholder="https://musicbrainz.org/release/…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={busy || !link.trim()}>
            Применить ссылку
          </Button>
        </form>
      </div>
    </Dialog>
  );
}

// ---------------- исполнитель ----------------

export function ArtistMetaDialog({ artistId }: { artistId: number }) {
  const [state, setState] = useState<ArtistMetaState | null>(null);
  const [q, setQ] = useState("");
  const [link, setLink] = useState("");
  const [results, setResults] = useState<ArtistCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);

  const search = async (text = q) => {
    setSearching(true);
    try {
      setResults(await api.meta.searchArtists(artistId, text));
    } catch (err) {
      fail(err);
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    api.meta
      .artist(artistId)
      .then((s) => {
        setState(s);
        setQ(s.query);
        search(s.query);
      })
      .catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artistId]);

  const act = async (fn: () => Promise<ArtistMetaState>, msg: string) => {
    setBusy(true);
    try {
      setState(await fn());
      invalidate(["artist", artistId], ["artists"], ["home"]);
      toast.success(msg);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      wide
      onClose={dialogs.close}
      title="Исполнитель в MusicBrainz"
      description="По записи в MusicBrainz подтягиваются биография из Википедии и фото с Викисклада."
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => act(() => api.meta.ignoreArtist(artistId), "Поиск для исполнителя отключён")}>
            <Trash className="size-4" /> Не искать
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => act(() => api.meta.chooseArtist(artistId, { auto: true }), "Готово")}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Найти автоматически
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {state && (
          <div className="flex flex-col gap-1">
            <StatusLine status={state.status} source={state.source} error={state.error} />
            {state.mbid && state.info && (
              <a href={`${MB}/artist/${state.mbid}`} target="_blank" rel="noreferrer" className="text-sm text-muted hover:text-fg hover:underline">
                {state.info.name}
                {state.info.disambiguation ? ` (${state.info.disambiguation})` : ""}
                {state.info.bio ? " · есть биография" : " · без биографии"}
                {state.image ? " · есть фото" : ""}
              </a>
            )}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
          className="flex gap-2"
        >
          <Input aria-label="Имя" className="flex-1" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" variant="secondary" disabled={searching || !q.trim()}>
            {searching ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />} Найти
          </Button>
        </form>
        {results === null || searching ? (
          <div className="flex justify-center py-8 text-muted">
            <LoaderCircle className="size-6 animate-spin" />
          </div>
        ) : results.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Ничего не нашлось. Попробуйте другое написание или вставьте ссылку.</p>
        ) : (
          <ul className="-mx-2 flex flex-col gap-1">
            {results.map((r) => {
              const current = state?.mbid === r.id && state.status !== "ignored";
              return (
                <li key={r.id} className={cn("flex items-center gap-3 rounded-2xl p-2", current ? "bg-surface-2" : "hover:bg-surface-2")}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-bold">
                      {r.name}
                      {r.disambiguation && <span className="font-normal text-muted"> ({r.disambiguation})</span>}
                    </div>
                    <div className="truncate text-[12px] text-faint">
                      {[r.type, r.country, r.life_span, r.aliases.slice(0, 3).join(", ")].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <a
                    href={`${MB}/artist/${r.id}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Открыть в MusicBrainz"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-3 hover:text-fg"
                  >
                    <ExternalLink className="size-4" />
                  </a>
                  <Button
                    size="sm"
                    variant={current ? "secondary" : "outline"}
                    disabled={busy || current}
                    onClick={() => act(() => api.meta.chooseArtist(artistId, { artist: r.id }), "Исполнитель выбран")}
                  >
                    {current ? <Check className="size-4" /> : null}
                    {current ? "Выбран" : "Выбрать"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(() => api.meta.chooseArtist(artistId, { artist: link.trim() }), "Исполнитель выбран").then(() => setLink(""));
          }}
          className="flex flex-wrap items-center gap-2 border-t pt-4"
        >
          <Input
            aria-label="Ссылка на исполнителя"
            className="min-w-60 flex-1"
            placeholder="https://musicbrainz.org/artist/…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={busy || !link.trim()}>
            Применить ссылку
          </Button>
        </form>
      </div>
    </Dialog>
  );
}
