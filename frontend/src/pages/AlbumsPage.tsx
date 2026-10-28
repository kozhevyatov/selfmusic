import { useState } from "react";
import { AlbumCard, CardGrid } from "@/components/Cards";
import { Disc3 } from "@/components/icons";
import { PageHeader } from "@/components/Section";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Empty, ErrorBox, PageLoader, Spinner } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { useQuery } from "@/lib/query";
import { setSearchParam, useSearchParams } from "@/lib/router";
import { albumsLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const SORTS = [
  { value: "newest", label: "Недавно добавленные" },
  { value: "name", label: "По названию" },
  { value: "artist", label: "По исполнителю" },
  { value: "year", label: "По году" },
  { value: "recent", label: "Недавно слушал" },
  { value: "frequent", label: "Часто слушаю" },
  { value: "random", label: "Случайные" },
];

const PAGE = 60;

export default function AlbumsPage() {
  const params = useSearchParams();
  const sort = params.get("sort") ?? "newest";
  const library = params.get("library") ? Number(params.get("library")) : undefined;
  const genre = params.get("genre") ?? undefined;
  const [pages, setPages] = useState(1);
  const libs = useQuery(["libraries"], api.library.libraries, { staleTime: 60_000 });
  const albums = useQuery(["albums", sort, library ?? null, genre ?? null, pages], () =>
    api.library.albums({ sort, library, genre, limit: PAGE * pages }),
  );

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title={genre ?? "Альбомы"}
        subtitle={albums.data ? albumsLabel(albums.data.total) : " "}
        actions={
          <div className="w-60">
            <Select aria-label="Сортировка" value={sort} onChange={(e) => (setPages(1), setSearchParam("sort", e.target.value))}>
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
        }
      />
      {(libs.data?.length ?? 0) > 1 && (
        <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
          {[{ id: undefined as number | undefined, name: "Все папки" }, ...libs.data!.map((l) => ({ id: l.id as number | undefined, name: l.name }))].map((l) => (
            <button
              key={l.id ?? "all"}
              onClick={() => (setPages(1), setSearchParam("library", l.id ? String(l.id) : null))}
              className={cn(
                "h-9 shrink-0 rounded-full px-4 text-[13px] font-bold transition",
                library === l.id ? "bg-fg text-bg" : "bg-surface-2 text-fg hover:bg-surface-3",
              )}
            >
              {l.name}
            </button>
          ))}
        </div>
      )}
      {albums.isLoading && <PageLoader />}
      <ErrorBox error={albums.error} />
      {albums.data && albums.data.items.length === 0 && (
        <Empty icon={<Disc3 />} title="Альбомов нет" text={sort === "recent" || sort === "frequent" ? "Послушайте что-нибудь — и здесь появится история." : undefined} />
      )}
      {albums.data && (
        <CardGrid>
          {albums.data.items.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </CardGrid>
      )}
      {albums.data && albums.data.items.length < albums.data.total && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => setPages((p) => p + 1)} disabled={albums.isFetching}>
            {albums.isFetching && <Spinner className="size-4" />} Показать ещё
          </Button>
        </div>
      )}
    </div>
  );
}
