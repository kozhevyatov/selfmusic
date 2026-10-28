import { useEffect, useState, type FormEvent } from "react";
import { Cover } from "@/components/Cover";
import { PlayFill } from "@/components/icon";
import { Globe, ListMusic, LoaderCircle, Plus, Sparkles, Users } from "@/components/icons";
import { SmartPlaylistEditor } from "@/components/SmartPlaylistEditor";
import { PageHeader } from "@/components/Section";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Empty, ErrorBox, PageLoader } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { api, type Playlist } from "@/lib/api";
import { playPlaylist } from "@/lib/actions";
import { formatDuration } from "@/lib/format";
import { invalidate, useQuery } from "@/lib/query";
import { Link, navigate, setSearchParam, useSearchParams } from "@/lib/router";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export function PlaylistCover({ pl, className }: { pl: Playlist; className?: string }) {
  if (pl.covers.length >= 4)
    return (
      <div className={cn("grid aspect-square grid-cols-2 overflow-hidden rounded-xl", className)}>
        {pl.covers.slice(0, 4).map((c) => (
          <Cover key={c} src={c} seed={c} size={200} rounded="rounded-none" />
        ))}
      </div>
    );
  return <Cover src={pl.covers[0]} seed={pl.name} size={400} className={className} />;
}

export function PlaylistForm({
  open,
  onClose,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Playlist;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [comment, setComment] = useState(initial?.comment ?? "");
  const [pub, setPub] = useState(initial?.is_public ?? false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setComment(initial?.comment ?? "");
      setPub(initial?.is_public ?? false);
    }
  }, [open, initial]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (initial) {
        await api.playlists.update(initial.id, { name: name.trim(), comment, is_public: pub });
        invalidate(["playlists"], ["playlist", initial.id]);
        onClose();
      } else {
        const pl = await api.playlists.create({ name: name.trim(), comment, is_public: pub });
        invalidate(["playlists"]);
        onClose();
        navigate(`/playlists/${pl.id}`);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? "Плейлист" : "Новый плейлист"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" form="pl-form" disabled={!name.trim() || busy}>
            {busy && <LoaderCircle className="size-4 animate-spin" />} {initial ? "Сохранить" : "Создать"}
          </Button>
        </>
      }
    >
      <form id="pl-form" onSubmit={submit} className="grid gap-5">
        <Field id="pl-name" label="Название">
          <Input id="pl-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="pl-comment" label="Описание">
          <Textarea id="pl-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <div className="flex items-start justify-between gap-4 rounded-2xl border p-4">
          <span>
            <span className="block font-bold">Общий плейлист</span>
            <span className="text-sm text-muted">Его увидят все пользователи сервера (треки — только из доступных им папок).</span>
          </span>
          <Switch checked={pub} onChange={setPub} label="Общий плейлист" />
        </div>
      </form>
    </Dialog>
  );
}

export default function PlaylistsPage() {
  const params = useSearchParams();
  const creating = params.get("new") === "1";
  const pls = useQuery(["playlists"], api.playlists.list);

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="Плейлисты"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setSearchParam("smart", "1")}>
              <Sparkles className="size-4" /> Умный плейлист
            </Button>
            <Button onClick={() => setSearchParam("new", "1")}>
              <Plus className="size-4" /> Новый плейлист
            </Button>
          </div>
        }
      />
      {pls.isLoading && <PageLoader />}
      <ErrorBox error={pls.error} />
      {pls.data?.length === 0 && (
        <Empty
          icon={<ListMusic />}
          title="Плейлистов пока нет"
          text="Создайте плейлист и добавляйте в него треки через меню «…» у любого трека или альбома."
        />
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:[grid-template-columns:repeat(auto-fill,minmax(180px,1fr))] sm:gap-x-6">
        {pls.data?.map((pl) => (
          <Link key={pl.id} to={`/playlists/${pl.id}`} className="group flex min-w-0 flex-col gap-2.5">
            <div className="relative">
              <PlaylistCover pl={pl} className="shadow-lg shadow-black/20" />
              <button
                aria-label={`Слушать «${pl.name}»`}
                onClick={(e) => {
                  e.preventDefault();
                  playPlaylist(pl.id);
                }}
                className="absolute right-3 bottom-3 flex size-12 translate-y-2 items-center justify-center rounded-full bg-accent text-accent-fg opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100 focus-visible:opacity-100"
              >
                <PlayFill className="ml-0.5 size-5" />
              </button>
            </div>
            <div className="min-w-0 px-0.5">
              <div className="flex items-center gap-1.5 truncate text-[15px] font-bold">
                {pl.smart ? (
                  <Sparkles className="size-3.5 shrink-0 text-accent-ink" />
                ) : pl.members.length ? (
                  <Users className="size-3.5 shrink-0 text-accent-ink" />
                ) : (
                  pl.is_public && <Globe className="size-3.5 shrink-0 text-accent-ink" />
                )}
                <span className="truncate">{pl.name}</span>
              </div>
              <div className="truncate text-[13px] text-muted">
                {pl.smart
                  ? `Умный · ${pl.track_count} тр.`
                  : pl.is_owner
                    ? `${pl.track_count} тр. · ${formatDuration(pl.duration)}${pl.members.length ? " · совместный" : ""}`
                    : `от ${pl.owner.name}${pl.members.length ? " · вы соавтор" : ""}`}
              </div>
            </div>
          </Link>
        ))}
      </div>
      <PlaylistForm open={creating} onClose={() => setSearchParam("new", null)} />
      <SmartPlaylistEditor open={params.get("smart") === "1"} onClose={() => setSearchParam("smart", null)} />
    </div>
  );
}
