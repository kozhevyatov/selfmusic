import type { ReactNode } from "react";
import type { Album, Artist } from "@/lib/api";
import { playAlbum, playArtist } from "@/lib/actions";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Avatar, Cover } from "./Cover";
import { PlayFill } from "./icon";

function PlayOverlay({ onPlay, label }: { onPlay: () => void; label: string }) {
  return (
    <button
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPlay();
      }}
      className={cn(
        "absolute right-3 bottom-3 flex size-12 translate-y-2 items-center justify-center rounded-full bg-accent text-accent-fg opacity-0 shadow-xl shadow-black/40 transition",
        "group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 hover:scale-105",
      )}
    >
      <PlayFill className="ml-0.5 size-5" />
    </button>
  );
}

export function AlbumCard({ album, subtitle }: { album: Album; subtitle?: string }) {
  return (
    <Link to={`/albums/${album.id}`} className="group flex min-w-0 flex-col gap-2.5">
      <div className="relative">
        <Cover src={album.cover} seed={album.name + album.artist} size={400} className="shadow-lg shadow-black/20 transition group-hover:brightness-105" />
        <PlayOverlay label={`Слушать «${album.name}»`} onPlay={() => playAlbum(album.id)} />
      </div>
      <div className="min-w-0 px-0.5">
        <div className="truncate text-[15px] font-bold">{album.name}</div>
        <div className="truncate text-[13px] text-muted">{subtitle ?? [album.artist, album.year].filter(Boolean).join(" · ")}</div>
      </div>
    </Link>
  );
}

export function ArtistCard({ artist }: { artist: Artist }) {
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
        <PlayOverlay label={`Слушать ${artist.name}`} onPlay={() => playArtist(artist.id, true)} />
      </div>
      <div className="w-full min-w-0">
        <div className="truncate text-[15px] font-bold">{artist.name}</div>
        <div className="text-[13px] text-muted">Исполнитель</div>
      </div>
    </Link>
  );
}

/** Сетка карточек; на телефоне можно сделать горизонтальной лентой (row). */
export function CardGrid({ children, row = false, artists = false }: { children: ReactNode; row?: boolean; artists?: boolean }) {
  if (row)
    return (
      <div className="scrollbar-none -mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-1 sm:-mx-0 sm:grid sm:overflow-visible sm:px-0 sm:[grid-template-columns:repeat(auto-fill,minmax(168px,1fr))] sm:gap-6">
        {Array.isArray(children)
          ? children.map((c, i) => (
              <div key={i} className={cn("shrink-0 snap-start sm:w-auto", artists ? "w-32" : "w-40")}>
                {c}
              </div>
            ))
          : children}
      </div>
    );
  return (
    <div
      className={cn(
        "grid gap-x-4 gap-y-6 sm:gap-x-6",
        artists
          ? "grid-cols-3 sm:[grid-template-columns:repeat(auto-fill,minmax(140px,1fr))]"
          : "grid-cols-2 sm:[grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]",
      )}
    >
      {children}
    </div>
  );
}
