import { DownloadButton } from "@/components/DownloadButton";
import { AlbumCard, CardGrid } from "@/components/Cards";
import { Cover } from "@/components/Cover";
import { HeartFill, PlayFill } from "@/components/icon";
import { Download, Ellipsis, Heart, Link as LinkIcon, ListEnd, ListPlus, ListStart, Pencil, Shuffle } from "@/components/icons";
import { useCanShare } from "@/lib/auth";
import { Section } from "@/components/Section";
import { TrackList } from "@/components/TrackList";
import { Badge, ErrorBox, PageLoader } from "@/components/ui/misc";
import { Menu } from "@/components/ui/menu";
import { api, coverUrl, downloadUrl } from "@/lib/api";
import { queueTracks, setFavorite } from "@/lib/actions";
import { usePalette } from "@/lib/colors";
import { dialogs } from "@/lib/dialogs";
import { formatDuration, tracksLabel } from "@/lib/format";
import { player } from "@/lib/player";
import { useQuery } from "@/lib/query";
import { Link, useParams } from "@/lib/router";
import { cn } from "@/lib/utils";

export default function AlbumPage() {
  const { id } = useParams<{ id: string }>();
  const albumId = Number(id);
  const q = useQuery(["album", albumId], () => api.library.album(albumId));
  const a = q.data;
  const palette = usePalette(coverUrl(a?.cover, 96), a ? a.name + a.artist : "");
  const canShare = useCanShare();

  if (q.isLoading) return <PageLoader />;
  if (q.error || !a) return <ErrorBox error={q.error} />;

  return (
    <div className="flex flex-col gap-8">
      <header className="relative -mx-4 -mt-5 overflow-hidden px-4 pt-8 pb-6 sm:-mx-6 sm:px-6 lg:-mx-10 lg:-mt-8 lg:px-10 lg:pt-14">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 opacity-60"
          style={{ background: `radial-gradient(120% 90% at 20% 0%, color-mix(in srgb, ${palette[0]} 45%, transparent), transparent 70%)` }}
        />
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:gap-8">
          <div className="mx-auto w-56 shrink-0 sm:mx-0 sm:w-60 lg:w-64">
            <Cover src={a.cover} seed={a.name + a.artist} size={600} rounded="rounded-2xl" className="shadow-[0_24px_60px_rgba(0,0,0,0.45)]" />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <div className="label-caps">Альбом</div>
            <h1 className="title-display text-[34px] break-words sm:text-5xl lg:text-[64px]">{a.name}</h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-muted">
              {a.artist_id ? (
                <Link to={`/artists/${a.artist_id}`} className="font-extrabold text-fg hover:underline">
                  {a.artist}
                </Link>
              ) : (
                <span className="font-extrabold text-fg">{a.artist}</span>
              )}
              {a.year && <span>· {a.year}</span>}
              <span>
                · {tracksLabel(a.track_count)}, {formatDuration(a.duration)}
              </span>
              {a.genre && (
                <Link to={`/albums?genre=${encodeURIComponent(a.genre)}`} className="hover:text-fg">
                  · {a.genre}
                </Link>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <button
          aria-label="Слушать альбом"
          onClick={() => player.play(a.tracks, 0, { shuffle: false })}
          className="flex size-16 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg shadow-xl shadow-black/25 transition hover:scale-105 active:scale-95"
        >
          <PlayFill className="ml-1 size-7" />
        </button>
        <button
          aria-label="Перемешать"
          onClick={() => player.play(a.tracks, 0, { shuffle: true })}
          className="flex size-12 shrink-0 items-center justify-center rounded-full border text-fg hover:bg-surface-2"
        >
          <Shuffle className="size-5" />
        </button>
        <button
          aria-label={a.starred ? "Убрать из избранного" : "В избранное"}
          aria-pressed={a.starred}
          onClick={() => setFavorite("album", a.id, !a.starred)}
          className={cn("flex size-12 shrink-0 items-center justify-center rounded-full border hover:bg-surface-2", a.starred ? "text-accent-ink" : "text-fg")}
        >
          {a.starred ? <HeartFill className="size-5" /> : <Heart className="size-5" />}
        </button>
        <DownloadButton
          kind="album"
          id={a.id}
          title={a.name}
          subtitle={a.artist}
          cover={a.cover}
          link={`/albums/${a.id}`}
          tracks={a.tracks}
        />
        <button onClick={() => dialogs.addToPlaylist(a.tracks)} className="hidden h-12 items-center gap-2 rounded-full border px-5 text-sm font-bold hover:bg-surface-2 sm:flex">
          <ListPlus className="size-[18px]" /> В плейлист
        </button>
        {canShare && (
          <button
            onClick={() => dialogs.share({ kind: "album", item_id: a.id, label: `${a.artist} — ${a.name}` })}
            className="hidden h-12 items-center gap-2 rounded-full border px-5 text-sm font-bold hover:bg-surface-2 sm:flex"
          >
            <LinkIcon className="size-[18px]" /> Поделиться
          </button>
        )}
        {a.can_edit && (
          <button onClick={() => dialogs.editAlbum(a.id)} className="hidden h-12 items-center gap-2 rounded-full border px-5 text-sm font-bold hover:bg-surface-2 sm:flex">
            <Pencil className="size-[18px]" /> Теги
          </button>
        )}
        <Menu
          label="Действия с альбомом"
          items={[
            { label: "Играть следующим", icon: <ListStart />, onSelect: () => queueTracks(a.tracks, true) },
            { label: "Добавить в очередь", icon: <ListEnd />, onSelect: () => queueTracks(a.tracks, false) },
            { label: "В плейлист…", icon: <ListPlus />, onSelect: () => dialogs.addToPlaylist(a.tracks) },
            ...(canShare
              ? [{ label: "Поделиться ссылкой", icon: <LinkIcon />, onSelect: () => dialogs.share({ kind: "album", item_id: a.id, label: `${a.artist} — ${a.name}` }) }]
              : []),
            ...(a.can_edit ? [{ label: "Редактировать теги и обложку", icon: <Pencil />, onSelect: () => dialogs.editAlbum(a.id) }] : []),
            {
              label: "Скачать треки",
              icon: <Download />,
              onSelect: () =>
                a.tracks.forEach((t, i) =>
                  window.setTimeout(() => {
                    const link = document.createElement("a");
                    link.href = downloadUrl(t.id);
                    link.download = "";
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                  }, i * 400),
                ),
            },
          ]}
          trigger={(p) => (
            <button {...p} aria-label="Ещё" className="flex size-12 shrink-0 items-center justify-center rounded-full border hover:bg-surface-2">
              <Ellipsis className="size-5" />
            </button>
          )}
        />
        {a.quality && <Badge className="ml-auto hidden sm:inline-flex">{a.quality}</Badge>}
      </div>

      <TrackList tracks={a.tracks} numbers="track" discs canEdit={a.can_edit} selectable className="-mx-2 sm:-mx-3" />

      <p className="text-[13px] text-faint">
        Папка «{a.library_name}» · добавлен {new Date(a.created_at.endsWith("Z") ? a.created_at : a.created_at + "Z").toLocaleDateString("ru-RU")}
      </p>

      {a.more_by_artist.length > 0 && (
        <Section title={`Ещё от ${a.artist}`} link={a.artist_id ? `/artists/${a.artist_id}` : undefined}>
          <CardGrid row>
            {a.more_by_artist.map((x) => (
              <AlbumCard key={x.id} album={x} subtitle={x.year ? String(x.year) : x.artist} />
            ))}
          </CardGrid>
        </Section>
      )}
    </div>
  );
}
