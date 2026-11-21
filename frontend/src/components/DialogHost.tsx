import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, type AlbumTags, type TagFields, type Track, type TrackTags } from "@/lib/api";
import { dialogs, useDialogState } from "@/lib/dialogs";
import { player } from "@/lib/player";
import { invalidate, useQuery } from "@/lib/query";
import { navigate } from "@/lib/router";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Cover } from "./Cover";
import { AlbumMetaDialog, ArtistMetaDialog } from "./MetaDialogs";
import { ShareDialog } from "./ShareDialog";
import { Check, Image as ImageIcon, LoaderCircle, Plus, TriangleAlert } from "./icons";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field, Input, Textarea } from "./ui/input";
import { Spinner } from "./ui/misc";

function PlaylistPicker({ tracks }: { tracks: Track[] }) {
  const playlists = useQuery(["playlists"], api.playlists.list);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const mine = (playlists.data ?? []).filter((p) => p.can_edit); // свои и совместные; умные собираются сами
  const ids = tracks.map((t) => t.id);

  const add = async (id: number, title: string) => {
    setBusy(id);
    try {
      const r = await api.playlists.addTracks(id, ids);
      toast.success(`Добавлено в «${title}»: ${r.added}`);
      invalidate(["playlists"], ["playlist", id]);
      dialogs.closeQuiet();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy("new");
    try {
      const pl = await api.playlists.create({ name: name.trim(), track_ids: ids });
      toast.success(`Плейлист «${pl.name}» создан`);
      invalidate(["playlists"]);
      dialogs.closeQuiet();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onClose={dialogs.close}
      title="Добавить в плейлист"
      description={tracks.length === 1 ? `«${tracks[0].title}»` : `${tracks.length} треков`}
    >
      <form onSubmit={create} className="mb-4 flex gap-2">
        <Input placeholder="Новый плейлист" value={name} onChange={(e) => setName(e.target.value)} aria-label="Название нового плейлиста" />
        <Button type="submit" disabled={!name.trim() || busy !== null} className="h-11">
          {busy === "new" ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />} Создать
        </Button>
      </form>
      {playlists.isLoading && <Spinner />}
      <div className="flex flex-col gap-1">
        {mine.map((pl) => (
          <button
            key={pl.id}
            onClick={() => add(pl.id, pl.name)}
            disabled={busy !== null}
            className="flex items-center gap-3 rounded-xl p-2 text-left hover:bg-surface-2 disabled:opacity-60"
          >
            <Cover src={pl.covers[0]} seed={pl.name} size={96} rounded="rounded-lg" className="size-11 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold">{pl.name}</span>
              <span className="text-[13px] text-muted">{pl.track_count} тр.</span>
            </span>
            {busy === pl.id && <LoaderCircle className="size-4 animate-spin" />}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

const FIELDS: { key: keyof TagFields; label: string; short?: boolean }[] = [
  { key: "title", label: "Название" },
  { key: "artist", label: "Исполнитель" },
  { key: "album", label: "Альбом" },
  { key: "album_artist", label: "Исполнитель альбома" },
  { key: "track", label: "№ трека", short: true },
  { key: "disc", label: "Диск", short: true },
  { key: "year", label: "Год", short: true },
  { key: "genre", label: "Жанр" },
];

function ReadOnlyNote({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <div className="mb-4 flex gap-3 rounded-2xl border border-danger/30 bg-danger/10 p-3.5 text-sm">
      <TriangleAlert className="size-5 shrink-0 text-danger" />
      <span>Только просмотр: {reason}.</span>
    </div>
  );
}

function TagEditor({ trackId }: { trackId: number }) {
  const [data, setData] = useState<TrackTags | null>(null);
  const [form, setForm] = useState<TagFields | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.tags
      .track(trackId)
      .then((d) => {
        setData(d);
        setForm(d.tags);
      })
      .catch((err) => {
        toast.error((err as Error).message);
        dialogs.closeQuiet();
      });
  }, [trackId]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!data || !form) return;
    const changes: Partial<TagFields> = {};
    (Object.keys(form) as (keyof TagFields)[]).forEach((k) => {
      if (form[k] !== data.tags[k]) changes[k] = form[k].trim();
    });
    if (!Object.keys(changes).length) return dialogs.closeQuiet();
    setBusy(true);
    try {
      const r = await api.tags.saveTrack(trackId, changes);
      toast.success("Теги сохранены");
      player.patchTrack(trackId, {
        title: form.title || undefined,
        artist: form.artist || undefined,
        album: form.album || undefined,
      });
      invalidate(["album"], ["albums"], ["home"], ["artist"], ["artists"], ["playlist"], ["favorites"], ["search"]);
      dialogs.closeQuiet();
      if (r.album_id && window.location.pathname.startsWith("/albums/") && !window.location.pathname.endsWith(`/${r.album_id}`))
        navigate(`/albums/${r.album_id}`, { replace: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={dialogs.close}
      title="Теги трека"
      description={data ? `${data.file}` : "Загрузка…"}
      wide
      footer={
        data && (
          <>
            <Button variant="ghost" onClick={dialogs.close}>
              Отмена
            </Button>
            <Button type="submit" form="tag-form" disabled={!data.editable || busy}>
              {busy && <LoaderCircle className="size-4 animate-spin" />} Сохранить в файл
            </Button>
          </>
        )
      }
    >
      {!form || !data ? (
        <Spinner />
      ) : (
        <form id="tag-form" onSubmit={save}>
          <ReadOnlyNote reason={data.reason} />
          <fieldset disabled={!data.editable} className="grid grid-cols-2 gap-4 sm:grid-cols-6">
            {FIELDS.map((f) => (
              <div key={f.key} className={f.short ? "col-span-1 sm:col-span-2" : "col-span-2 sm:col-span-3"}>
                <Field id={`tag-${f.key}`} label={f.label}>
                  <Input
                    id={`tag-${f.key}`}
                    value={form[f.key]}
                    inputMode={f.short ? "numeric" : undefined}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  />
                </Field>
              </div>
            ))}
            <div className="col-span-2 sm:col-span-6">
              <Field id="tag-lyrics" label="Текст песни" hint="Можно вставить и синхронный текст в формате LRC: [мм:сс.сс] строка">
                <Textarea id="tag-lyrics" rows={6} value={form.lyrics} onChange={(e) => setForm({ ...form, lyrics: e.target.value })} />
              </Field>
            </div>
          </fieldset>
        </form>
      )}
    </Dialog>
  );
}

type AlbumForm = { album: string; album_artist: string; artist: string; year: string; genre: string };

function AlbumTagEditor({ albumId }: { albumId: number }) {
  const [data, setData] = useState<AlbumTags | null>(null);
  const [form, setForm] = useState<AlbumForm | null>(null);
  const [rows, setRows] = useState<Record<number, { title: string; track: string; disc: string; artist: string }>>({});
  const [cover, setCover] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const album = useQuery(["album", albumId], () => api.library.album(albumId));

  useEffect(() => {
    api.tags
      .album(albumId)
      .then((d) => {
        setData(d);
        setForm({
          album: d.album ?? "",
          album_artist: d.album_artist ?? "",
          artist: d.artist ?? "",
          year: d.year ?? "",
          genre: d.genre ?? "",
        });
        setRows(
          Object.fromEntries(
            d.tracks.map((t) => [t.id, { title: t.tags.title, track: t.tags.track, disc: t.tags.disc, artist: t.tags.artist }]),
          ),
        );
      })
      .catch((err) => {
        toast.error((err as Error).message);
        dialogs.closeQuiet();
      });
  }, [albumId]);

  const mixed = (key: keyof AlbumForm) => data && data[key] === null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!data || !form) return;
    const common: Partial<AlbumForm> = {};
    (Object.keys(form) as (keyof AlbumForm)[]).forEach((k) => {
      const orig = data[k];
      // Поле с разными значениями трогаем, только если его заполнили
      if (orig === null ? form[k].trim() !== "" : form[k] !== orig) common[k] = form[k].trim();
    });
    const tracks: Record<number, Partial<TagFields>> = {};
    data.tracks.forEach((t) => {
      const r = rows[t.id];
      const ch: Partial<TagFields> = {};
      if (r.title !== t.tags.title) ch.title = r.title.trim();
      if (r.track !== t.tags.track) ch.track = r.track.trim();
      if (r.disc !== t.tags.disc) ch.disc = r.disc.trim();
      if (r.artist !== t.tags.artist && common.artist === undefined) ch.artist = r.artist.trim();
      if (Object.keys(ch).length) tracks[t.id] = ch;
    });
    if (!Object.keys(common).length && !Object.keys(tracks).length && !cover) return dialogs.closeQuiet();
    setBusy(true);
    try {
      let target = albumId;
      if (cover) await api.tags.setCover(albumId, cover);
      if (Object.keys(common).length || Object.keys(tracks).length) {
        const r = await api.tags.saveAlbum(albumId, { ...common, tracks });
        target = r.album_id;
        if (r.errors.length) toast.error(`Не все файлы сохранены: ${r.errors[0]}`);
      }
      toast.success("Альбом обновлён");
      invalidate(["album"], ["albums"], ["home"], ["artist"], ["artists"], ["playlist"], ["playlists"], ["favorites"]);
      dialogs.closeQuiet();
      if (target !== albumId) navigate(`/albums/${target}`, { replace: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const previewUrl = useMemo(() => (cover ? URL.createObjectURL(cover) : null), [cover]);
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  return (
    <Dialog
      open
      onClose={dialogs.close}
      title="Редактировать альбом"
      description="Изменения записываются прямо в файлы"
      wide
      footer={
        data && (
          <>
            <Button variant="ghost" onClick={dialogs.close}>
              Отмена
            </Button>
            <Button type="submit" form="album-form" disabled={!data.editable || busy}>
              {busy && <LoaderCircle className="size-4 animate-spin" />} Сохранить
            </Button>
          </>
        )
      }
    >
      {!data || !form ? (
        <Spinner />
      ) : (
        <form id="album-form" onSubmit={save} className="flex flex-col gap-6">
          <ReadOnlyNote reason={data.editable ? null : data.reason} />
          <fieldset disabled={!data.editable} className="flex flex-col gap-6">
            <div className="flex flex-col gap-5 sm:flex-row">
              <div className="flex shrink-0 flex-col items-center gap-2">
                <div className="w-36">
                  {previewUrl ? (
                    <img src={previewUrl} alt="" className="aspect-square w-full rounded-xl object-cover" />
                  ) : (
                    <Cover src={album.data?.cover} seed={(form.album || "") + form.album_artist} size={300} />
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => setCover(e.target.files?.[0] ?? null)}
                />
                <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
                  <ImageIcon className="size-4" /> {cover ? "Другая картинка" : "Сменить обложку"}
                </Button>
              </div>
              <div className="grid flex-1 grid-cols-2 gap-4">
                {(
                  [
                    ["album", "Альбом", 2],
                    ["album_artist", "Исполнитель альбома", 2],
                    ["artist", "Исполнитель всех треков", 2],
                    ["year", "Год", 1],
                    ["genre", "Жанр", 1],
                  ] as const
                ).map(([key, label, span]) => (
                  <div key={key} className={span === 2 ? "col-span-2" : ""}>
                    <Field id={`al-${key}`} label={label}>
                      <Input
                        id={`al-${key}`}
                        value={form[key]}
                        placeholder={mixed(key) ? "Разные значения" : ""}
                        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                      />
                    </Field>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="label-caps mb-2">Треки</div>
              <div className="flex flex-col gap-2">
                {data.tracks.map((t) => {
                  const r = rows[t.id];
                  return (
                    <div key={t.id} className="grid grid-cols-[3.2rem_3.2rem_minmax(0,1fr)] gap-2 sm:grid-cols-[3.5rem_3.5rem_minmax(0,1.3fr)_minmax(0,1fr)]">
                      <Input aria-label="Диск" placeholder="Диск" value={r.disc} onChange={(e) => setRows({ ...rows, [t.id]: { ...r, disc: e.target.value } })} className="px-2 text-center" />
                      <Input aria-label="Номер" placeholder="№" value={r.track} onChange={(e) => setRows({ ...rows, [t.id]: { ...r, track: e.target.value } })} className="px-2 text-center" />
                      <Input aria-label="Название" value={r.title} onChange={(e) => setRows({ ...rows, [t.id]: { ...r, title: e.target.value } })} />
                      <Input
                        aria-label="Исполнитель"
                        value={r.artist}
                        onChange={(e) => setRows({ ...rows, [t.id]: { ...r, artist: e.target.value } })}
                        className="hidden sm:block"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </fieldset>
        </form>
      )}
    </Dialog>
  );
}

function Confirm({ title, text, action, danger, resolve }: { title: string; text: string; action: string; danger?: boolean; resolve: (ok: boolean) => void }) {
  const done = (ok: boolean) => {
    resolve(ok);
    dialogs.closeQuiet();
  };
  return (
    <Dialog
      open
      onClose={() => done(false)}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={() => done(false)}>
            Отмена
          </Button>
          <Button data-autofocus variant={danger ? "danger" : "primary"} onClick={() => done(true)}>
            <Check className={cn("size-4", danger && "hidden")} /> {action}
          </Button>
        </>
      }
    >
      <p className="text-muted">{text}</p>
    </Dialog>
  );
}

export function DialogHost() {
  const state = useDialogState();
  switch (state.kind) {
    case "playlist":
      return <PlaylistPicker tracks={state.tracks} />;
    case "tags":
      return <TagEditor trackId={state.trackId} />;
    case "album-tags":
      return <AlbumTagEditor albumId={state.albumId} />;
    case "album-meta":
      return <AlbumMetaDialog albumId={state.albumId} />;
    case "artist-meta":
      return <ArtistMetaDialog artistId={state.artistId} />;
    case "confirm":
      return <Confirm {...state} />;
    case "share":
      return <ShareDialog target={state.target} share={state.share} />;
    default:
      return null;
  }
}
