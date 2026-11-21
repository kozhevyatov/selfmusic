import { AlbumCard, CardGrid } from "@/components/Cards";
import { Avatar, Cover } from "@/components/Cover";
import { HeartFill, PlayFill } from "@/components/icon";
import { useState } from "react";
import { Disc3, ExternalLink, Heart, Link as LinkIcon, Radio, Shuffle } from "@/components/icons";
import { useAuth, useCanShare } from "@/lib/auth";
import { dialogs } from "@/lib/dialogs";
import { Section } from "@/components/Section";
import { TrackList } from "@/components/TrackList";
import { ErrorBox, PageLoader } from "@/components/ui/misc";
import { api, coverUrl, type ArtistInfo } from "@/lib/api";
import { playArtist, setFavorite, startRadio } from "@/lib/actions";
import { usePalette } from "@/lib/colors";
import { albumsLabel, tracksLabel } from "@/lib/format";
import { useQuery } from "@/lib/query";
import { useParams } from "@/lib/router";
import { cn } from "@/lib/utils";

const LANG_NAME: Record<string, string> = { ru: "русской", en: "английской", uk: "украинской", be: "белорусской", de: "немецкой", fr: "французской" };

/** «Об исполнителе»: биография из Википедии (свёрнута до нескольких строк), годы, страна, жанры. */
function About({ info }: { info: ArtistInfo }) {
  const [open, setOpen] = useState(false);
  const long = info.bio.length > 420;
  const facts = [info.life_span, info.country, info.genres].filter(Boolean);
  return (
    <Section title="Об исполнителе">
      <div className="flex max-w-3xl flex-col gap-3">
        {facts.length > 0 && <div className="text-sm text-muted">{facts.join(" · ")}</div>}
        {info.bio && (
          <div className="relative">
            <p className={cn("text-[15px] leading-relaxed whitespace-pre-line", !open && long && "line-clamp-5")}>{info.bio}</p>
            {long && (
              <button onClick={() => setOpen(!open)} className="mt-1 text-sm font-bold text-accent-ink hover:underline">
                {open ? "Свернуть" : "Читать дальше"}
              </button>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-faint">
          {info.bio_url && (
            <a href={info.bio_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg hover:underline">
              Википедия{LANG_NAME[info.bio_lang] && info.bio_lang !== "ru" ? ` (на ${LANG_NAME[info.bio_lang]})` : ""} <ExternalLink className="size-3" />
            </a>
          )}
          {info.mbid && (
            <a href={`https://musicbrainz.org/artist/${info.mbid}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg hover:underline">
              MusicBrainz <ExternalLink className="size-3" />
            </a>
          )}
          {info.image_source && (
            <a href={info.image_source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg hover:underline">
              Фото: Викисклад <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>
    </Section>
  );
}

export default function ArtistPage() {
  const { id } = useParams<{ id: string }>();
  const artistId = Number(id);
  const q = useQuery(["artist", artistId], () => api.library.artist(artistId));
  const a = q.data;
  const palette = usePalette(coverUrl(a?.cover, 96), a?.name ?? "");
  const canShare = useCanShare();
  const isAdmin = Boolean(useAuth().user?.is_admin);

  if (q.isLoading) return <PageLoader />;
  if (q.error || !a) return <ErrorBox error={q.error} />;

  return (
    <div className="flex flex-col gap-9">
      <header className="relative -mx-4 -mt-5 overflow-hidden px-4 pt-10 pb-4 sm:-mx-6 sm:px-6 lg:-mx-10 lg:-mt-8 lg:px-10 lg:pt-16">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 opacity-60"
          style={{ background: `radial-gradient(120% 90% at 15% 0%, color-mix(in srgb, ${palette[0]} 45%, transparent), transparent 70%)` }}
        />
        <div className="flex flex-col items-center gap-6 text-center sm:flex-row sm:items-end sm:text-left">
          <div className="w-44 shrink-0 sm:w-52">
            {a.cover ? (
              <Cover src={a.cover} seed={a.name} size={600} rounded="rounded-full" className="shadow-[0_24px_60px_rgba(0,0,0,0.45)]" />
            ) : (
              <Avatar name={a.name} className="size-44 font-display text-6xl sm:size-52" />
            )}
          </div>
          <div className="min-w-0">
            <div className="label-caps">Исполнитель</div>
            <h1 className="title-display mt-2 text-4xl break-words sm:text-6xl">{a.name}</h1>
            <p className="mt-3 text-muted">
              {albumsLabel(a.albums.length)} · {tracksLabel(a.track_count)}
              {a.info?.genres && <span className="hidden sm:inline"> · {a.info.genres}</span>}
            </p>
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <button
          aria-label="Слушать всё"
          onClick={() => playArtist(a.id)}
          className="flex size-16 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg shadow-xl shadow-black/25 transition hover:scale-105"
        >
          <PlayFill className="ml-1 size-7" />
        </button>
        <button aria-label="Перемешать" onClick={() => playArtist(a.id, true)} className="flex size-12 shrink-0 items-center justify-center rounded-full border hover:bg-surface-2">
          <Shuffle className="size-5" />
        </button>
        <button
          aria-label={a.starred ? "Убрать из избранного" : "В избранное"}
          aria-pressed={a.starred}
          onClick={() => setFavorite("artist", a.id, !a.starred)}
          className={cn("flex size-12 shrink-0 items-center justify-center rounded-full border hover:bg-surface-2", a.starred && "text-accent-ink")}
        >
          {a.starred ? <HeartFill className="size-5" /> : <Heart className="size-5" />}
        </button>
        <button
          onClick={() => startRadio({ artist_id: a.id, label: a.name })}
          className="flex h-12 items-center gap-2 rounded-full border px-5 text-sm font-bold hover:bg-surface-2"
        >
          <Radio className="size-[18px]" /> Радио
        </button>
        {canShare && (
          <button
            onClick={() => dialogs.share({ kind: "artist", item_id: a.id, label: a.name })}
            className="flex h-12 items-center gap-2 rounded-full border px-5 text-sm font-bold hover:bg-surface-2"
          >
            <LinkIcon className="size-[18px]" /> Поделиться
          </button>
        )}
        {isAdmin && (
          <button
            onClick={() => dialogs.artistMeta(a.id)}
            title="Исполнитель в MusicBrainz: биография и фото"
            className="flex h-12 items-center gap-2 rounded-full border px-5 text-sm font-bold text-muted hover:bg-surface-2 hover:text-fg"
          >
            <Disc3 className="size-[18px]" /> MusicBrainz
          </button>
        )}
      </div>

      {a.top_tracks.length > 0 && (
        <Section title="Популярные треки">
          <TrackList tracks={a.top_tracks} showCover showAlbum selectable className="-mx-2 sm:-mx-3" />
        </Section>
      )}
      {a.albums.length > 0 && (
        <Section title="Альбомы">
          <CardGrid>
            {a.albums.map((x) => (
              <AlbumCard key={x.id} album={x} subtitle={[x.year, `${x.track_count} тр.`].filter(Boolean).join(" · ")} />
            ))}
          </CardGrid>
        </Section>
      )}
      {a.appears_on.length > 0 && (
        <Section title="Участвует">
          <CardGrid row>
            {a.appears_on.map((x) => (
              <AlbumCard key={x.id} album={x} />
            ))}
          </CardGrid>
        </Section>
      )}
      {a.info && (a.info.bio || a.info.genres || a.info.life_span) && <About info={a.info} />}
    </div>
  );
}
