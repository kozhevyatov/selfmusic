import { isNative } from "@/lib/native";
import { BookOpen, ChartColumn, ChevronRight, CircleCheck, Disc3, Folder, Heart, Link as LinkIcon, ListMusic, MicVocal, Sparkles, Upload } from "@/components/icons";
import { booksAvailable } from "@/components/LibraryScope";
import { PageHeader } from "@/components/Section";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useQuery } from "@/lib/query";
import { Link } from "@/lib/router";

/** Медиатека на телефоне: вход в разделы, которые на компьютере лежат в боковом меню. */
export default function LibraryPage() {
  const { user } = useAuth();
  const libs = useQuery(["libraries"], api.library.libraries, { staleTime: 300_000 });
  const items = [
    ...(booksAvailable(libs.data) ? [{ to: "/books", label: "Аудиокниги", icon: BookOpen }] : []),
    { to: "/mixes", label: "Подборки", icon: Sparkles },
    { to: "/albums", label: "Альбомы", icon: Disc3 },
    { to: "/artists", label: "Исполнители", icon: MicVocal },
    { to: "/favorites", label: "Избранное", icon: Heart },
    { to: "/stats", label: "Статистика и итоги", icon: ChartColumn },
    { to: "/playlists", label: "Плейлисты", icon: ListMusic },
    { to: "/folders", label: "Папки", icon: Folder },
    ...(isNative ? [] : [{ to: "/offline", label: "Скачанное", icon: CircleCheck }]),
    ...(user?.is_admin || user?.can_share ? [{ to: "/shares", label: "Общие ссылки", icon: LinkIcon }] : []),
    ...(user?.is_admin || user?.upload_mode !== "none" ? [{ to: "/upload", label: "Загрузить музыку", icon: Upload }] : []),
  ];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Медиатека" />
      <div className="glass flex flex-col overflow-hidden rounded-3xl border">
        {items.map(({ to, label, icon: Icon }) => (
          <Link key={to} to={to} className="flex items-center gap-4 border-b px-5 py-4 last:border-b-0 hover:bg-surface-2/60">
            <Icon className="size-6 text-accent-ink" />
            <span className="flex-1 text-[17px] font-bold">{label}</span>
            <ChevronRight className="size-5 text-faint" />
          </Link>
        ))}
      </div>
    </div>
  );
}
