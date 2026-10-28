import { Folder, FolderPlus, Lock } from "@/components/icons";
import { PageHeader } from "@/components/Section";
import { buttonClass } from "@/components/ui/button";
import { Empty, ErrorBox, PageLoader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatDuration, formatSize } from "@/lib/format";
import { useQuery } from "@/lib/query";
import { Link } from "@/lib/router";
import { countLabel } from "@/lib/utils";

export default function FoldersPage() {
  const { user } = useAuth();
  const libs = useQuery(["libraries"], api.library.libraries);
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="Папки"
        subtitle="Папки с музыкой, которые вам открыты"
        actions={
          user?.is_admin && (
            <Link to="/admin?tab=libraries" className={buttonClass("secondary")}>
              <FolderPlus className="size-[18px]" /> Управлять
            </Link>
          )
        }
      />
      {libs.isLoading && <PageLoader />}
      <ErrorBox error={libs.error} />
      {libs.data?.length === 0 && (
        <Empty icon={<Lock />} title="Нет доступных папок" text="Попросите администратора открыть вам папку с музыкой." />
      )}
      <div className="grid gap-4 sm:[grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
        {libs.data?.map((l) => (
          <Link key={l.id} to={`/albums?library=${l.id}`} className="glass flex gap-4 rounded-3xl border p-5 transition hover:border-accent/40">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-surface-2 text-accent-ink">
              <Folder className="size-7" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[17px] font-extrabold">{l.name}</div>
              {l.path && <div className="truncate text-[13px] text-faint">{l.path}</div>}
              <div className="mt-2 text-sm text-muted">
                {countLabel(l.album_count, "альбом", "альбома", "альбомов")} · {countLabel(l.track_count, "трек", "трека", "треков")}
              </div>
              <div className="text-[13px] text-faint">
                {formatDuration(l.total_duration)} · {formatSize(l.total_size)} · обновлено {formatDate(l.last_scan_at)}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
