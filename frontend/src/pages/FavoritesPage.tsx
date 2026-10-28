import { useState } from "react";
import { AlbumCard, ArtistCard, CardGrid } from "@/components/Cards";
import { PlayFill } from "@/components/icon";
import { Heart } from "@/components/icons";
import { PageHeader } from "@/components/Section";
import { TrackList } from "@/components/TrackList";
import { Button } from "@/components/ui/button";
import { Empty, ErrorBox, PageLoader } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { player } from "@/lib/player";
import { useQuery } from "@/lib/query";

type Tab = "tracks" | "albums" | "artists";

export default function FavoritesPage() {
  const fav = useQuery(["favorites"], api.favorites.list);
  const [tab, setTab] = useState<Tab>("tracks");
  const d = fav.data;
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="Избранное"
        actions={
          tab === "tracks" && d?.tracks.length ? (
            <Button onClick={() => player.play(d.tracks, 0, { shuffle: false })}>
              <PlayFill className="size-4" /> Слушать
            </Button>
          ) : undefined
        }
      />
      <Segmented
        label="Раздел избранного"
        value={tab}
        onChange={setTab}
        className="w-full max-w-md"
        options={[
          { value: "tracks", label: `Треки${d ? ` · ${d.tracks.length}` : ""}` },
          { value: "albums", label: `Альбомы${d ? ` · ${d.albums.length}` : ""}` },
          { value: "artists", label: `Артисты${d ? ` · ${d.artists.length}` : ""}` },
        ]}
      />
      {fav.isLoading && <PageLoader />}
      <ErrorBox error={fav.error} />
      {d && tab === "tracks" &&
        (d.tracks.length ? (
          <TrackList tracks={d.tracks} showCover showAlbum selectable className="-mx-2 sm:-mx-3" />
        ) : (
          <Empty icon={<Heart />} title="Пока пусто" text="Нажмите на сердечко у трека — он появится здесь." />
        ))}
      {d && tab === "albums" &&
        (d.albums.length ? (
          <CardGrid>
            {d.albums.map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </CardGrid>
        ) : (
          <Empty icon={<Heart />} title="Нет избранных альбомов" />
        ))}
      {d && tab === "artists" &&
        (d.artists.length ? (
          <CardGrid artists>
            {d.artists.map((a) => (
              <ArtistCard key={a.id} artist={a} />
            ))}
          </CardGrid>
        ) : (
          <Empty icon={<Heart />} title="Нет избранных исполнителей" />
        ))}
    </div>
  );
}
