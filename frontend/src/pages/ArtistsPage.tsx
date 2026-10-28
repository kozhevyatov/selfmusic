import { useEffect, useState } from "react";
import { ArtistCard, CardGrid } from "@/components/Cards";
import { MicVocal, Search } from "@/components/icons";
import { PageHeader } from "@/components/Section";
import { Empty, ErrorBox, PageLoader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { useQuery } from "@/lib/query";
import { countLabel } from "@/lib/utils";

export default function ArtistsPage() {
  const [q, setQ] = useState("");
  const [deb, setDeb] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDeb(q.trim()), 200);
    return () => window.clearTimeout(t);
  }, [q]);
  const artists = useQuery(["artists", deb], () => api.library.artists({ q: deb }));
  const [limit, setLimit] = useState(120);
  const list = artists.data ?? [];

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="Исполнители"
        subtitle={artists.data ? countLabel(list.length, "исполнитель", "исполнителя", "исполнителей") : " "}
        actions={
          <div className="relative w-full sm:w-72">
            <Search className="absolute top-1/2 left-4 size-4 -translate-y-1/2 text-faint" />
            <input
              type="search"
              aria-label="Найти исполнителя"
              placeholder="Найти исполнителя"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-11 w-full rounded-full border bg-surface pr-4 pl-11 text-[15px] outline-none focus:border-accent"
            />
          </div>
        }
      />
      {artists.isLoading && <PageLoader />}
      <ErrorBox error={artists.error} />
      {artists.data && list.length === 0 && <Empty icon={<MicVocal />} title="Никого не нашлось" />}
      <CardGrid artists>
        {list.slice(0, limit).map((a) => (
          <ArtistCard key={a.id} artist={a} />
        ))}
      </CardGrid>
      {list.length > limit && (
        <div className="flex justify-center">
          <button onClick={() => setLimit((l) => l + 240)} className="h-11 rounded-full bg-surface-2 px-6 text-sm font-bold hover:bg-surface-3">
            Показать ещё
          </button>
        </div>
      )}
    </div>
  );
}
