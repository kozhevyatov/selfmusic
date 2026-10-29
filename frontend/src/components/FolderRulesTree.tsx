import { useState } from "react";
import { ChevronRight, Folder, LoaderCircle } from "@/components/icons";
import { Switch } from "@/components/ui/switch";
import { api, type FolderNode } from "@/lib/api";
import { dialogs } from "@/lib/dialogs";
import { invalidate, useQuery } from "@/lib/query";
import { toast } from "@/lib/toast";
import { cn, countLabel } from "@/lib/utils";

/** Обновить дерево и счётчики: сразу и после того, как пройдёт быстрый скан. */
function refresh(libId: number) {
  invalidate(["admin", "tree", libId], ["admin", "libraries"], ["admin", "scan"]);
  for (const ms of [2500, 7000, 15000]) setTimeout(() => invalidate(["admin", "tree", libId], ["admin", "libraries"]), ms);
  invalidate(["home"], ["albums"], ["artists"], ["libraries"]);
}

function Level({ libId, path, depth, parentIncluded }: { libId: number; path: string; depth: number; parentIncluded: boolean }) {
  const q = useQuery(["admin", "tree", libId, path], () => api.admin.libraryTree(libId, path), { staleTime: 0 });
  if (q.isLoading)
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-faint" style={{ paddingLeft: depth * 20 + 8 }}>
        <LoaderCircle className="size-4 animate-spin" /> Загрузка…
      </div>
    );
  if (q.error) return <div className="py-2 text-sm text-danger" style={{ paddingLeft: depth * 20 + 8 }}>{(q.error as Error).message}</div>;
  const d = q.data!;
  if (!d.dirs.length)
    return (
      <div className="py-1.5 text-[13px] text-faint" style={{ paddingLeft: depth * 20 + 36 }}>
        {depth === 0 ? "Подпапок нет — все файлы лежат прямо в папке." : "Подпапок нет"}
      </div>
    );
  return (
    <>
      {d.dirs.map((n) => (
        <Node key={n.path} libId={libId} node={n} depth={depth} parentIncluded={parentIncluded} />
      ))}
      {d.truncated && <div className="py-1 text-[12px] text-faint" style={{ paddingLeft: depth * 20 + 36 }}>Показаны первые 2000 папок</div>}
    </>
  );
}

function Node({ libId, node, depth, parentIncluded }: { libId: number; node: FolderNode; depth: number; parentIncluded: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggle = async (include: boolean) => {
    if (!include && node.tracks > 0) {
      const ok = await dialogs.confirm({
        title: `Исключить «${node.name}»?`,
        text: `${countLabel(node.tracks, "трек скроется", "трека скроются", "треков скроются")} из медиатеки, поиска, подборок и статистики. Файлы на диске останутся, история прослушиваний, оценки и плейлисты — тоже: включите папку обратно, и всё вернётся как было.`,
        action: "Исключить",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.admin.setFolder(libId, node.path, include);
      refresh(libId);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // «возвращена» — включена своим правилом внутри исключённой ветки
  const note = !node.included
    ? node.rule === false
      ? "исключена"
      : "исключена вместе с родительской"
    : node.rule === true && !parentIncluded
      ? "возвращена"
      : node.tracks
        ? countLabel(node.tracks, "трек", "трека", "треков")
        : "";

  return (
    <>
      <div
        className={cn("group flex min-h-11 items-center gap-2 rounded-xl pr-2 hover:bg-surface-2/60", !node.included && "text-faint")}
        style={{ paddingLeft: depth * 20 + 4 }}
      >
        <button
          type="button"
          aria-label={open ? "Свернуть" : "Развернуть"}
          aria-expanded={open}
          disabled={!node.has_children}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg disabled:invisible",
          )}
        >
          <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
        </button>
        <Folder className={cn("size-[18px] shrink-0", node.included ? "text-accent-ink" : "text-faint")} />
        <button
          type="button"
          onClick={() => node.has_children && setOpen((v) => !v)}
          className={cn("min-w-0 flex-1 truncate text-left text-[14px] font-semibold", !node.included && "line-through decoration-1")}
          title={node.path}
        >
          {node.name}
        </button>
        <span className={cn("hidden shrink-0 text-[12px] sm:inline", node.rule === true && !parentIncluded ? "text-accent-ink" : "text-faint")}>{note}</span>
        {busy ? (
          <LoaderCircle className="size-5 shrink-0 animate-spin text-muted" />
        ) : (
          <Switch checked={node.included} onChange={toggle} label={node.included ? `Исключить ${node.name}` : `Включить ${node.name}`} />
        )}
      </div>
      {open && <Level libId={libId} path={node.path} depth={depth + 1} parentIncluded={node.included} />}
    </>
  );
}

/** Дерево подпапок библиотеки с переключателями «в медиатеке / исключена». */
export function FolderRulesTree({ libId }: { libId: number }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border bg-surface-2/30 p-2">
      <p className="px-2 pt-1 text-[13px] text-muted">
        Выключенные папки не попадают в медиатеку; файлы на диске и история прослушиваний сохраняются. Внутри выключенной папки можно включить обратно отдельную
        подпапку. После изменения папка быстро пересканируется.
      </p>
      <div className="max-h-[440px] overflow-y-auto overscroll-contain">
        <Level libId={libId} path="" depth={0} parentIncluded />
      </div>
    </div>
  );
}
