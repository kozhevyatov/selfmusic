import { CardGrid, PlayOverlay } from "@/components/Cards";
import { Avatar, Cover } from "@/components/Cover";
import { Section } from "@/components/Section";
import { playArtist } from "@/lib/actions";
import type { FavoriteArtist } from "@/lib/api";
import { Link } from "@/lib/router";
import { formatDuration } from "@/lib/format";
import { nf } from "@/lib/stats";
import { cn, plural } from "@/lib/utils";

function FavoriteArtistCard({ artist, rank }: { artist: FavoriteArtist; rank: number }) {
  return (
    <Link to={`/artists/${artist.id}`} className="group flex min-w-0 flex-col items-center gap-3 text-center">
      <div className="relative w-full">
        {artist.cover ? (
          <Cover src={artist.cover} seed={artist.name} size={400} rounded="rounded-full" className="shadow-lg shadow-black/20" />
        ) : (
          <div className="flex aspect-square w-full items-center justify-center">
            <Avatar name={artist.name} className="size-full font-display text-4xl" />
          </div>
        )}
        <span
          className={cn(
            "num absolute top-0 left-0 flex size-8 items-center justify-center rounded-full text-[13px] font-extrabold shadow-md ring-2 ring-bg",
            rank === 1 ? "bg-accent text-accent-fg" : "bg-surface-3 text-fg",
          )}
        >
          {rank}
        </span>
        <PlayOverlay label={`Слушать ${artist.name}`} onPlay={() => playArtist(artist.id, true)} />
      </div>
      <div className="w-full min-w-0">
        <div className="truncate text-[15px] font-bold">{artist.name}</div>
        <div className="text-[13px] font-semibold text-muted">{formatDuration(artist.seconds)}</div>
        <div className="text-[12px] text-faint">
          {nf(artist.plays)} {plural(artist.plays, "прослушивание", "прослушивания", "прослушиваний")}
        </div>
      </div>
    </Link>
  );
}

/** Блок на главной: самые слушаемые исполнители пользователя. */
export function FavoriteArtists({ artists }: { artists: FavoriteArtist[] }) {
  if (!artists.length) return null;
  return (
    <Section title="Любимые исполнители" link="/stats" linkLabel="Вся статистика">
      <CardGrid row artists>
        {artists.slice(0, 8).map((a, i) => (
          <FavoriteArtistCard key={a.id} artist={a} rank={i + 1} />
        ))}
      </CardGrid>
    </Section>
  );
}
