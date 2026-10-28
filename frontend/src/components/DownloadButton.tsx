import type { Track } from "@/lib/api";
import { downloadCollection, offlineSupported, removeCollection, useCollectionStatus, type CollectionKind } from "@/lib/offline";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { CircleCheck, Download, LoaderCircle } from "./icons";
import { Menu } from "./ui/menu";

/** «Скачать для офлайна» — для альбома, плейлиста, подборки */
export function DownloadButton({
  kind,
  id,
  title,
  subtitle,
  cover,
  link,
  tracks,
  className,
}: {
  kind: CollectionKind;
  id: string | number;
  title: string;
  subtitle: string;
  cover: string | null;
  link: string;
  tracks: Track[];
  className?: string;
}) {
  const key = `${kind}-${id}`;
  const { saved, complete, progress } = useCollectionStatus(key);
  if (!offlineSupported || !tracks.length) return null;

  const start = () => {
    void downloadCollection({ key, kind, title, subtitle, cover, link }, tracks);
    toast.info(`Скачиваю «${title}» — можно продолжать слушать`);
  };
  const base = cn(
    "flex h-12 items-center gap-2 rounded-full border px-4 text-[14px] font-bold transition hover:bg-surface-2",
    className,
  );

  if (progress) {
    const pct = Math.round((progress.done / Math.max(1, progress.total)) * 100);
    return (
      <button onClick={() => removeCollection(key)} className={cn(base, "text-muted")} title="Нажмите, чтобы отменить">
        <LoaderCircle className="size-4 animate-spin" />
        {progress.done} из {progress.total} · {pct}%
      </button>
    );
  }
  if (saved) {
    return (
      <Menu
        label="Скачано"
        items={[
          ...(complete ? [] : [{ label: "Докачать", icon: <Download />, onSelect: start }]),
          { label: "Обновить по текущему списку треков", icon: <Download />, onSelect: start },
          { separator: true },
          {
            label: "Удалить с устройства",
            danger: true,
            onSelect: async () => {
              await removeCollection(key);
              toast.success("Удалено с устройства");
            },
          },
        ]}
        trigger={(p) => (
          <button {...p} className={cn(base, complete ? "text-accent-ink" : "text-muted")}>
            <CircleCheck className="size-4" /> {complete ? "Скачано" : "Скачано частично"}
          </button>
        )}
      />
    );
  }
  return (
    <button onClick={start} className={cn(base, "text-muted hover:text-fg")}>
      <Download className="size-4" /> Скачать
    </button>
  );
}
