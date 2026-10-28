import { api, downloadUrl, type Track } from "@/lib/api";
import { queueTracks, setFavorite } from "@/lib/actions";
import { dialogs } from "@/lib/dialogs";
import { invalidate } from "@/lib/query";
import { navigate } from "@/lib/router";
import { toast } from "@/lib/toast";
import { player } from "@/lib/player";
import { Menu, type MenuItem } from "./ui/menu";
import {
  Disc3,
  Download,
  Ellipsis,
  Heart,
  ListEnd,
  ListPlus,
  ListStart,
  MicVocal,
  Pencil,
  Trash,
  X,
} from "./icons";

export function trackMenuItems(
  track: Track,
  opts: { onRemoveFromPlaylist?: () => void; canEdit?: boolean; hideAlbum?: boolean } = {},
): MenuItem[] {
  const items: MenuItem[] = [
    { label: "Играть следующим", icon: <ListStart />, onSelect: () => queueTracks([track], true) },
    { label: "Добавить в очередь", icon: <ListEnd />, onSelect: () => queueTracks([track], false) },
    { label: "В плейлист…", icon: <ListPlus />, onSelect: () => dialogs.addToPlaylist([track]) },
    {
      label: track.starred ? "Убрать из избранного" : "В избранное",
      icon: <Heart />,
      onSelect: () => setFavorite("track", track.id, !track.starred),
    },
    { separator: true },
  ];
  if (!opts.hideAlbum) items.push({ label: "Перейти к альбому", icon: <Disc3 />, onSelect: () => navigate(`/albums/${track.album_id}`) });
  if (track.artist_id)
    items.push({ label: "Перейти к исполнителю", icon: <MicVocal />, onSelect: () => navigate(`/artists/${track.artist_id}`) });
  items.push({
    label: "Скачать",
    icon: <Download />,
    onSelect: () => {
      const a = document.createElement("a");
      a.href = downloadUrl(track.id);
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
  });
  if (opts.canEdit || track.can_delete) items.push({ label: "Редактировать теги", icon: <Pencil />, onSelect: () => dialogs.editTags(track.id) });
  if (opts.onRemoveFromPlaylist) {
    items.push({ separator: true }, { label: "Убрать из плейлиста", icon: <X />, onSelect: opts.onRemoveFromPlaylist });
  }
  if (track.can_delete) {
    items.push(
      { separator: true },
      {
        label: "Удалить файл",
        icon: <Trash />,
        danger: true,
        onSelect: async () => {
          const ok = await dialogs.confirm({
            title: "Удалить трек?",
            text: `Файл «${track.title}» будет удалён с сервера. Отменить это нельзя.`,
            action: "Удалить",
            danger: true,
          });
          if (!ok) return;
          try {
            await api.uploads.deleteTrack(track.id);
            const idx = player.getState().queue.findIndex((t) => t.id === track.id);
            if (idx >= 0) player.removeAt(idx);
            toast.success("Трек удалён");
            invalidate(["album"], ["home"], ["albums"], ["uploads"], ["artist"], ["playlist"]);
          } catch (err) {
            toast.error((err as Error).message);
          }
        },
      },
    );
  }
  return items;
}

export function TrackMenuButton({
  track,
  className,
  ...opts
}: { track: Track; className?: string } & Parameters<typeof trackMenuItems>[1]) {
  return (
    <Menu
      label={`Действия: ${track.title}`}
      items={trackMenuItems(track, opts)}
      trigger={(p) => (
        <button
          {...p}
          aria-label="Ещё"
          className={
            className ??
            "flex size-9 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-fg"
          }
        >
          <Ellipsis className="size-5" />
        </button>
      )}
    />
  );
}
