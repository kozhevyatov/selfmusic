import { useEffect, useState } from "react";
import { AlbumCard, ArtistCard, CardGrid } from "@/components/Cards";
import { Search, X } from "@/components/icons";
import { Section } from "@/components/Section";
import { TrackList } from "@/components/TrackList";
import { Empty, PageLoader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { playRandom } from "@/lib/actions";
import { useQuery } from "@/lib/query";
import { setSearchParam, useSearchParams } from "@/lib/router";
import { hueOf } from "@/lib/utils";

function Genres() {
  const genres = useQuery(["genres"], api.library.genres, { staleTime: 300_000 });
  if (!genres.data?.length) return null;
  return (
    <Section title="Жанры">
      <div className="grid grid-cols-2 gap-3 sm:[grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
        {genres.data.map((g) => {
          const h = hueOf(g.name);
          return (
            <button
              key={g.name}
              onClick={() => playRandom(g.name)}
              className="group relative h-24 overflow-hidden rounded-2xl p-4 text-left text-white transition hover:scale-[1.02]"
              style={{ background: `linear-gradient(135deg, hsl(${h} 60% 42%), hsl(${(h + 40) % 360} 65% 28%))` }}
              aria-label={`Слушать жанр ${g.name}`}
            >
              <span className="relative z-10 block text-[17px] font-extrabold">{g.name}</span>
              <span className="relative z-10 text-xs text-white/75">{g.album_count} альб. · {g.track_count} тр.</span>
              <span
                className="absolute -right-6 -bottom-8 size-24 rounded-full opacity-60 blur-xl transition group-hover:opacity-90"
                style={{ background: `hsl(${(h + 80) % 360} 80% 60%)` }}
              />
            </button>
          );
        })}
      </div>
    </Section>
  );
}

export default function SearchPage() {
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [debounced, setDebounced] = useState(q.trim());

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebounced(q.trim());
      setSearchParam("q", q.trim() || null);
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const res = useQuery(["search", debounced], () => api.library.search(debounced), { enabled: debounced.length > 0 });
  const d = res.data;
  const nothing = d && !d.artists.length && !d.albums.length && !d.tracks.length;

  return (
    <div className="flex flex-col gap-8">
      <div className="relative">
        <Search className="absolute top-1/2 left-5 size-5 -translate-y-1/2 text-faint" />
        <input
          autoFocus
          type="search"
          aria-label="Поиск"
          placeholder="Исполнители, альбомы, треки"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="glass h-14 w-full rounded-full border pr-12 pl-14 text-[17px] font-semibold outline-none placeholder:text-faint focus:border-accent"
        />
        {q && (
          <button
            aria-label="Очистить"
            onClick={() => setQ("")}
            className="absolute top-1/2 right-3 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-surface-2"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {!debounced && <Genres />}
      {debounced && res.isLoading && <PageLoader />}
      {nothing && <Empty icon={<Search />} title="Ничего не нашлось" text={`По запросу «${debounced}» нет ни исполнителей, ни альбомов, ни треков.`} />}
      {d && debounced && (
        <>
          {d.tracks.length > 0 && (
            <Section title="Треки">
              <TrackList tracks={d.tracks.slice(0, 20)} showCover showAlbum />
            </Section>
          )}
          {d.artists.length > 0 && (
            <Section title="Исполнители">
              <CardGrid artists>
                {d.artists.map((a) => (
                  <ArtistCard key={a.id} artist={a} />
                ))}
              </CardGrid>
            </Section>
          )}
          {d.albums.length > 0 && (
            <Section title="Альбомы">
              <CardGrid>
                {d.albums.map((a) => (
                  <AlbumCard key={a.id} album={a} />
                ))}
              </CardGrid>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
