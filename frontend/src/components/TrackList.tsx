import { Fragment, memo, useMemo } from "react";
import type { Track } from "@/lib/api";
import { setFavorite } from "@/lib/actions";
import { formatTime } from "@/lib/format";
import { player, usePlayer } from "@/lib/player";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Cover } from "./Cover";
import { HeartFill, PauseFill, PlayFill } from "./icon";
import { Heart } from "./icons";
import { TrackMenuButton } from "./TrackMenu";

function Equalizer() {
  return (
    <span className="flex h-4 items-end justify-center gap-[3px]" aria-hidden="true">
      {[0, 0.25, 0.5].map((d) => (
        <span key={d} className="eq-bar block h-full w-[3px] rounded-sm bg-accent" style={{ animationDelay: `${-d}s` }} />
      ))}
    </span>
  );
}

type RowProps = {
  track: Track;
  index: number;
  number: number | string;
  active: boolean;
  playing: boolean;
  showAlbum: boolean;
  showCover: boolean;
  canEdit?: boolean;
  onPlay: (i: number) => void;
  onRemove?: (t: Track) => void;
};

const Row = memo(function Row({ track, index, number, active, playing, showAlbum, showCover, canEdit, onPlay, onRemove }: RowProps) {
  const coarse = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  return (
    <div
      role="listitem"
      onClick={() => coarse && onPlay(index)}
      onDoubleClick={() => onPlay(index)}
      className={cn(
        "group grid items-center gap-3 rounded-xl px-2 py-2 select-none sm:gap-4 sm:px-3",
        showAlbum
          ? "grid-cols-[2rem_minmax(0,1fr)_auto] md:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_auto]"
          : "grid-cols-[2rem_minmax(0,1fr)_auto] sm:grid-cols-[2.5rem_minmax(0,1fr)_auto]",
        active ? "bg-surface-2/80" : "hover:bg-surface-2/60",
      )}
    >
      <div className="relative flex h-10 items-center justify-center">
        {showCover ? (
          <div className="relative size-10">
            <Cover src={track.cover} seed={track.album + track.album_artist} size={96} rounded="rounded-md" />
            <button
              aria-label={active && playing ? "Пауза" : `Слушать «${track.title}»`}
              onClick={(e) => {
                e.stopPropagation();
                if (active) player.toggle();
                else onPlay(index);
              }}
              className={cn(
                "absolute inset-0 flex items-center justify-center rounded-md bg-black/45 text-white transition",
                active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
            >
              {active && playing ? <PauseFill className="size-4" /> : <PlayFill className="size-4" />}
            </button>
          </div>
        ) : (
          <>
            <span className={cn("num text-[15px] text-faint group-hover:invisible", active && "invisible")}>{number}</span>
            {active && playing && (
              <span className="absolute inset-0 flex items-center justify-center group-hover:invisible">
                <Equalizer />
              </span>
            )}
            <button
              aria-label={active && playing ? "Пауза" : `Слушать «${track.title}»`}
              onClick={(e) => {
                e.stopPropagation();
                if (active) player.toggle();
                else onPlay(index);
              }}
              className={cn(
                "absolute inset-0 flex items-center justify-center text-fg opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                active && !playing && "opacity-100 text-accent-ink",
              )}
            >
              {active && playing ? <PauseFill className="size-4" /> : <PlayFill className="size-4" />}
            </button>
          </>
        )}
      </div>

      <div className="min-w-0">
        <div className={cn("truncate text-[15px] font-semibold", active && "text-accent-ink")}>{track.title}</div>
        <div className="truncate text-[13px] text-muted">
          {track.artist_id ? (
            <Link
              to={`/artists/${track.artist_id}`}
              onClick={(e) => e.stopPropagation()}
              className="hover:text-fg hover:underline"
            >
              {track.artist}
            </Link>
          ) : (
            track.artist
          )}
          <span className="hidden sm:inline"> · {track.quality}</span>
        </div>
      </div>

      {showAlbum && (
        <div className="hidden min-w-0 md:block">
          <Link
            to={`/albums/${track.album_id}`}
            onClick={(e) => e.stopPropagation()}
            className="block truncate text-sm text-muted hover:text-fg hover:underline"
          >
            {track.album}
          </Link>
        </div>
      )}

      <div className="flex items-center gap-1 sm:gap-2">
        <button
          aria-label={track.starred ? "Убрать из избранного" : "В избранное"}
          aria-pressed={track.starred}
          onClick={(e) => {
            e.stopPropagation();
            setFavorite("track", track.id, !track.starred);
          }}
          className={cn(
            "hidden size-9 items-center justify-center rounded-full transition sm:flex",
            track.starred ? "text-accent-ink" : "text-faint opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100",
          )}
        >
          {track.starred ? <HeartFill className="size-[18px]" /> : <Heart className="size-[18px]" />}
        </button>
        <span className="num hidden w-11 text-right text-sm text-muted sm:block">{formatTime(track.duration)}</span>
        <TrackMenuButton track={track} canEdit={canEdit} onRemoveFromPlaylist={onRemove ? () => onRemove(track) : undefined} />
      </div>
    </div>
  );
});

/** Список треков. Двойной клик (или касание на телефоне) — играть список с этого трека. */
export function TrackList({
  tracks,
  showAlbum = false,
  showCover = false,
  numbers = "index",
  discs = false,
  canEdit,
  onRemove,
  className,
}: {
  tracks: Track[];
  showAlbum?: boolean;
  showCover?: boolean;
  numbers?: "index" | "track";
  discs?: boolean;
  canEdit?: boolean;
  onRemove?: (t: Track) => void;
  className?: string;
}) {
  const currentId = usePlayer((s) => s.queue[s.index]?.id ?? null);
  const playing = usePlayer((s) => s.playing || s.loading);
  const onPlay = useMemo(() => (i: number) => player.play(tracks, i), [tracks]);
  const multiDisc = discs && new Set(tracks.map((t) => t.disc_no ?? 1)).size > 1;

  return (
    <div role="list" aria-label="Треки" className={cn("flex flex-col", className)}>
      {tracks.map((t, i) => {
        const showDisc = multiDisc && (i === 0 || (tracks[i - 1].disc_no ?? 1) !== (t.disc_no ?? 1));
        const key = t.entry_id ? `e${t.entry_id}` : `${t.id}-${i}`;
        return (
          <Fragment key={key}>
            {showDisc && (
              <div role="presentation" className="label-caps px-3 pt-5 pb-2">
                Диск {t.disc_no ?? 1}
              </div>
            )}
            <Row
              track={t}
              index={i}
              number={numbers === "track" ? (t.track_no ?? i + 1) : i + 1}
              active={t.id === currentId}
              playing={playing}
              showAlbum={showAlbum}
              showCover={showCover}
              canEdit={canEdit}
              onPlay={onPlay}
              onRemove={onRemove}
            />
          </Fragment>
        );
      })}
    </div>
  );
}
