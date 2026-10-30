import { DownloadButton } from "@/components/DownloadButton";
import { useState } from "react";
import { PlayFill } from "@/components/icon";
import { Ellipsis, Globe, Link as LinkIcon, ListEnd, ListMusic, LogOut, Pencil, Shuffle, Sparkles, Trash, Users } from "@/components/icons";
import { Avatar } from "@/components/Cover";
import { MembersDialog } from "@/components/MembersDialog";
import { SmartPlaylistEditor } from "@/components/SmartPlaylistEditor";
import { useCanShare } from "@/lib/auth";
import { TrackList } from "@/components/TrackList";
import { Empty, ErrorBox, PageLoader } from "@/components/ui/misc";
import { Menu } from "@/components/ui/menu";
import { api, coverUrl, type Track } from "@/lib/api";
import { queueTracks } from "@/lib/actions";
import { usePalette } from "@/lib/colors";
import { dialogs } from "@/lib/dialogs";
import { formatDuration, tracksLabel } from "@/lib/format";
import { player } from "@/lib/player";
import { invalidate, setQueryData, useQuery } from "@/lib/query";
import { Link, navigate, useParams } from "@/lib/router";
import { toast } from "@/lib/toast";
import { PlaylistCover, PlaylistForm } from "./PlaylistsPage";

export default function PlaylistPage() {
  const { id } = useParams<{ id: string }>();
  const plId = Number(id);
  const q = useQuery(["playlist", plId], () => api.playlists.get(plId));
  const [editing, setEditing] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const pl = q.data;
  const palette = usePalette(coverUrl(pl?.covers[0], 96), pl?.name ?? "");
  const canShare = useCanShare();

  if (q.isLoading) return <PageLoader />;
  if (q.error || !pl) return <ErrorBox error={q.error} />;

  const removeEntry = async (t: Track) => {
    if (!t.entry_id) return;
    setQueryData(["playlist", plId], (old: typeof pl | undefined) =>
      old ? { ...old, tracks: old.tracks.filter((x) => x.entry_id !== t.entry_id), track_count: old.track_count - 1 } : old,
    );
    try {
      await api.playlists.removeEntry(plId, t.entry_id);
      invalidate(["playlists"]);
    } catch (err) {
      toast.error((err as Error).message);
      invalidate(["playlist", plId]);
    }
  };

  const remove = async () => {
    const ok = await dialogs.confirm({ title: "Удалить плейлист?", text: `«${pl.name}» будет удалён. Сами треки останутся.`, action: "Удалить", danger: true });
    if (!ok) return;
    try {
      await api.playlists.remove(plId);
      invalidate(["playlists"]);
      navigate("/playlists", { replace: true });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <header className="relative -mx-4 -mt-5 overflow-hidden px-4 pt-8 pb-4 sm:-mx-6 sm:px-6 lg:-mx-10 lg:-mt-8 lg:px-10 lg:pt-14">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 opacity-60"
          style={{ background: `radial-gradient(120% 90% at 20% 0%, color-mix(in srgb, ${palette[0]} 45%, transparent), transparent 70%)` }}
        />
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:gap-8">
          <div className="mx-auto w-52 shrink-0 sm:mx-0 sm:w-60">
            <PlaylistCover pl={pl} className="shadow-[0_24px_60px_rgba(0,0,0,0.45)]" />
          </div>
          <div className="min-w-0">
            <div className="label-caps flex items-center gap-2">
              {pl.smart ? <Sparkles className="size-3.5" /> : pl.members.length ? <Users className="size-3.5" /> : pl.is_public && <Globe className="size-3.5" />}{" "}
              {pl.smart ? "Умный плейлист · обновляется сам" : pl.members.length ? "Совместный плейлист" : pl.is_public ? "Общий плейлист" : "Плейлист"}
            </div>
            <h1 className="title-display mt-2 text-4xl break-words sm:text-6xl">{pl.name}</h1>
            {pl.comment && <p className="mt-3 max-w-2xl text-muted">{pl.comment}</p>}
            <p className="mt-3 text-[15px] text-muted">
              <span className="font-bold text-fg">{pl.owner.name}</span> · {tracksLabel(pl.track_count)}, {formatDuration(pl.duration)}
            </p>
            {pl.members.length > 0 && (
              <div className="mt-3 flex items-center gap-2">
                <div className="flex -space-x-2">
                  {[pl.owner, ...pl.members].slice(0, 6).map((m) => (
                    <Avatar key={m.id} name={m.name} src={m.avatar} className="size-8 text-xs ring-2 ring-bg" />
                  ))}
                </div>
                <span className="text-sm text-muted">{[pl.owner, ...pl.members].map((m) => m.name).join(", ")}</span>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <button
          aria-label="Слушать плейлист"
          disabled={!pl.tracks.length}
          onClick={() => player.play(pl.tracks, 0, { shuffle: false })}
          className="flex size-16 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg shadow-xl shadow-black/25 transition hover:scale-105 disabled:opacity-40"
        >
          <PlayFill className="ml-1 size-7" />
        </button>
        <button
          aria-label="Перемешать"
          disabled={!pl.tracks.length}
          onClick={() => player.play(pl.tracks, 0, { shuffle: true })}
          className="flex size-12 shrink-0 items-center justify-center rounded-full border hover:bg-surface-2 disabled:opacity-40"
        >
          <Shuffle className="size-5" />
        </button>
        <DownloadButton
          kind="playlist"
          id={pl.id}
          title={pl.name}
          subtitle={`${pl.tracks.length} тр.`}
          cover={pl.covers[0] ?? null}
          link={`/playlists/${pl.id}`}
          tracks={pl.tracks}
        />
        <Menu
          label="Действия с плейлистом"
          items={[
            { label: "Добавить в очередь", icon: <ListEnd />, onSelect: () => queueTracks(pl.tracks, false), disabled: !pl.tracks.length },
            ...(canShare
              ? [{ label: "Поделиться ссылкой", icon: <LinkIcon />, onSelect: () => dialogs.share({ kind: "playlist", item_id: pl.id, label: pl.name }) }]
              : []),
            ...(pl.is_owner && pl.smart ? [{ label: "Изменить правила", icon: <Sparkles />, onSelect: () => setRulesOpen(true) }] : []),
            ...(pl.is_owner && !pl.smart ? [{ label: "Соавторы…", icon: <Users />, onSelect: () => setMembersOpen(true) }] : []),
            ...(!pl.is_owner && pl.members.length
              ? [
                  {
                    label: "Выйти из плейлиста",
                    icon: <LogOut />,
                    onSelect: async () => {
                      await api.playlists.leave(pl.id);
                      invalidate(["playlists"]);
                      navigate("/playlists", { replace: true });
                    },
                  },
                ]
              : []),
            ...(pl.is_owner
              ? [
                  { label: "Название и доступ", icon: <Pencil />, onSelect: () => setEditing(true) },
                  { separator: true as const },
                  { label: "Удалить плейлист", icon: <Trash />, danger: true, onSelect: remove },
                ]
              : []),
          ]}
          trigger={(p) => (
            <button {...p} aria-label="Ещё" className="flex size-12 shrink-0 items-center justify-center rounded-full border hover:bg-surface-2">
              <Ellipsis className="size-5" />
            </button>
          )}
        />
      </div>

      {pl.tracks.length === 0 ? (
        <Empty
          icon={pl.smart ? <Sparkles /> : <ListMusic />}
          title={pl.smart ? "Под условия пока ничего не подходит" : "В плейлисте пусто"}
          text={pl.smart ? "Измените правила — или плейлист наполнится сам, когда появится подходящая музыка." : "Добавляйте треки через меню «…» у трека или альбома."}
          action={
            <Link to="/albums" className="font-bold text-accent-ink hover:underline">
              К альбомам
            </Link>
          }
        />
      ) : (
        <TrackList tracks={pl.tracks} showCover showAlbum selectable onRemove={pl.can_edit ? removeEntry : undefined} className="-mx-2 sm:-mx-3" />
      )}
      {pl.is_owner && <PlaylistForm open={editing} onClose={() => setEditing(false)} initial={pl} />}
      {pl.is_owner && pl.smart && <SmartPlaylistEditor open={rulesOpen} onClose={() => setRulesOpen(false)} playlist={pl} />}
      {pl.is_owner && !pl.smart && <MembersDialog open={membersOpen} onClose={() => setMembersOpen(false)} playlist={pl} />}
    </div>
  );
}
