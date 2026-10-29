import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { player, useCurrentTrack } from "@/lib/player";
import { useQuery } from "@/lib/query";
import { isActive, Link, navigate, useLocation } from "@/lib/router";
import { setThemeMode, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Ambient } from "./Ambient";
import { Avatar, Cover } from "./Cover";
import {
  BookOpen,
  CircleCheck,
  Disc3,
  WifiOff,
  Folder,
  Heart,
  House,
  Library,
  Link as LinkIcon,
  ListMusic,
  LogOut,
  MicVocal,
  Moon,
  Plus,
  Search,
  Settings,
  Shield,
  Sparkles,
  Sun,
  Upload,
  User,
  ChartColumn,
} from "./icons";
import { BalalaikaMark, Brand } from "./Logo";
import { MiniPlayer, NowPlaying, PlayerBar } from "./Player";
import { SyncOfferCard, UpdateCard } from "./SyncOffer";
import { startUpdateChecks } from "@/lib/updates";
import { startSync } from "@/lib/sync";
import OfflinePage from "@/pages/OfflinePage";
import { useOffline } from "@/lib/network";
import { Menu } from "./ui/menu";

const NAV = [
  { to: "/", label: "Главная", icon: House },
  { to: "/search", label: "Поиск", icon: Search },
  { to: "/mixes", label: "Подборки", icon: Sparkles },
  { to: "/albums", label: "Альбомы", icon: Disc3 },
  { to: "/artists", label: "Исполнители", icon: MicVocal },
  { to: "/playlists", label: "Плейлисты", icon: ListMusic },
  { to: "/favorites", label: "Избранное", icon: Heart },
  { to: "/stats", label: "Статистика", icon: ChartColumn },
  { to: "/folders", label: "Папки", icon: Folder },
  { to: "/offline", label: "Скачанное", icon: CircleCheck },
];

const TABS = [
  { to: "/", label: "Главная", icon: House },
  { to: "/search", label: "Поиск", icon: Search },
  { to: "/library", label: "Медиатека", icon: Library },
  { to: "/playlists", label: "Плейлисты", icon: ListMusic },
];

function UserMenu({ compact = false }: { compact?: boolean }) {
  const { user, logout } = useAuth();
  const theme = useTheme();
  if (!user) return null;
  const name = user.display_name || user.username;
  const dark = document.documentElement.classList.contains("dark");
  return (
    <Menu
      label="Меню пользователя"
      items={[
        { label: "Профиль и приложения", icon: <User />, onSelect: () => navigate("/profile") },
        ...(user.is_admin || user.upload_mode !== "none"
          ? [{ label: "Загрузить музыку", icon: <Upload />, onSelect: () => navigate("/upload") }]
          : []),
        ...(user.is_admin ? [{ label: "Управление", icon: <Shield />, onSelect: () => navigate("/admin") }] : []),
        {
          label: dark ? "Светлая тема" : "Тёмная тема",
          icon: dark ? <Sun /> : <Moon />,
          hint: theme.mode === "system" ? "авто" : undefined,
          onSelect: () => setThemeMode(dark ? "light" : "dark"),
        },
        { separator: true },
        { label: "Выйти", icon: <LogOut />, onSelect: () => logout().then(() => navigate("/login")) },
      ]}
      trigger={(p) => (
        <button
          {...p}
          aria-label="Меню пользователя"
          className={cn(
            "flex items-center gap-3 rounded-full transition hover:bg-surface-2",
            compact ? "p-0.5" : "w-full p-1.5 pr-3 text-left",
          )}
        >
          <Avatar name={name} src={user.avatar} className="size-9 text-sm" />
          {!compact && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold">{name}</span>
              <span className="block truncate text-xs text-faint">{user.is_admin ? "Администратор" : user.username}</span>
            </span>
          )}
          {!compact && <Settings className="size-4 text-faint" />}
        </button>
      )}
    />
  );
}

function Sidebar() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const playlists = useQuery(["playlists"], api.playlists.list, { staleTime: 60_000 });
  const settings = useQuery(["settings"], api.settings.get, { staleTime: 300_000 });
  const libs = useQuery(["libraries"], api.library.libraries, { staleTime: 300_000 });
  const hasBooks = Boolean(libs.data?.some((l) => l.kind === "audiobooks"));
  return (
    <aside className="hidden h-dvh w-[260px] shrink-0 flex-col gap-7 border-r px-4 pt-7 pb-[112px] lg:flex">
      <Link to="/" className="px-2">
        <Brand name={settings.data?.site_name} />
      </Link>
      <nav aria-label="Основная навигация" className="flex flex-col gap-0.5">
        {NAV.map(({ to, label, icon: Icon }) => {
          const active = isActive(pathname, to);
          return (
            <Link
              key={to}
              to={to}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3.5 rounded-xl px-3 py-2.5 text-[15px] font-bold transition",
                active ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg",
              )}
            >
              <Icon className={cn("size-5", active && "text-accent-ink")} />
              {label}
            </Link>
          );
        })}
        {hasBooks && (
          <Link
            to="/books"
            aria-current={isActive(pathname, "/books") ? "page" : undefined}
            className={cn(
              "flex items-center gap-3.5 rounded-xl px-3 py-2.5 text-[15px] font-bold transition",
              isActive(pathname, "/books") ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg",
            )}
          >
            <BookOpen className={cn("size-5", isActive(pathname, "/books") && "text-accent-ink")} />
            Аудиокниги
          </Link>
        )}
        {user && (user.is_admin || user.can_share) && (
          <Link
            to="/shares"
            aria-current={isActive(pathname, "/shares") ? "page" : undefined}
            className={cn(
              "flex items-center gap-3.5 rounded-xl px-3 py-2.5 text-[15px] font-bold transition",
              isActive(pathname, "/shares") ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg",
            )}
          >
            <LinkIcon className={cn("size-5", isActive(pathname, "/shares") && "text-accent-ink")} />
            Ссылки
          </Link>
        )}
        {user && (user.is_admin || user.upload_mode !== "none") && (
          <Link
            to="/upload"
            aria-current={isActive(pathname, "/upload") ? "page" : undefined}
            className={cn(
              "flex items-center gap-3.5 rounded-xl px-3 py-2.5 text-[15px] font-bold transition",
              isActive(pathname, "/upload") ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg",
            )}
          >
            <Upload className={cn("size-5", isActive(pathname, "/upload") && "text-accent-ink")} />
            Загрузка
          </Link>
        )}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between px-3">
          <span className="label-caps">Плейлисты</span>
          <Link
            to="/playlists?new=1"
            aria-label="Новый плейлист"
            className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
          >
            <Plus className="size-[18px]" />
          </Link>
        </div>
        <div className="scrollbar-none -mx-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto px-1">
          {playlists.data?.length === 0 && <p className="px-3 text-sm text-faint">Пока нет плейлистов</p>}
          {playlists.data?.map((pl) => (
            <Link
              key={pl.id}
              to={`/playlists/${pl.id}`}
              className={cn(
                "flex items-center gap-3 rounded-xl px-2.5 py-1.5 text-sm font-semibold transition",
                pathname === `/playlists/${pl.id}` ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
              )}
            >
              <Cover src={pl.covers[0]} seed={pl.name} size={96} rounded="rounded-md" className="size-8 shrink-0" />
              <span className="truncate">{pl.name}</span>
            </Link>
          ))}
        </div>
      </div>
      <UserMenu />
    </aside>
  );
}

function MobileHeader() {
  const settings = useQuery(["settings"], api.settings.get, { staleTime: 300_000 });
  return (
    <header className="glass sticky top-0 z-30 flex items-center justify-between gap-3 border-b px-4 pt-[max(0.6rem,env(safe-area-inset-top))] pb-2.5 lg:hidden">
      <Link to="/" className="flex items-center gap-2.5" aria-label="На главную">
        <span className="inline-flex size-8 items-center justify-center rounded-[9px] bg-accent text-accent-fg">
          <BalalaikaMark className="size-5" />
        </span>
        <span className="font-display text-[17px] font-semibold tracking-[-0.03em]">{settings.data?.site_name ?? "SelfMusic"}</span>
      </Link>
      <UserMenu compact />
    </header>
  );
}

function TabBar() {
  const { pathname } = useLocation();
  const libraryPaths = ["/library", "/stats", "/mixes", "/offline", "/books", "/albums", "/artists", "/favorites", "/folders", "/upload", "/shares"];
  return (
    <nav
      aria-label="Разделы"
      className="glass fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {TABS.map(({ to, label, icon: Icon }) => {
        const active = to === "/library" ? libraryPaths.some((p) => isActive(pathname, p)) : isActive(pathname, to);
        return (
          <Link
            key={to}
            to={to}
            aria-current={active ? "page" : undefined}
            className={cn("flex h-[66px] flex-col items-center justify-center gap-1 text-[11px] font-bold", active ? "text-fg" : "text-faint")}
          >
            <Icon className={cn("size-[22px]", active && "text-accent-ink")} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Без связи эти страницы работают (остальные заменяются «Скачанным») */
const OFFLINE_OK = ["/offline", "/profile"];

function OfflineBanner() {
  return (
    <div className="mb-5 flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm">
      <WifiOff className="size-5 shrink-0 text-accent-ink" />
      <span className="flex-1">Нет связи с сервером. Играет скачанная музыка, остальное появится, когда связь вернётся.</span>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const track = useCurrentTrack();
  const open = useCallback(() => setExpanded(true), []);
  const close = useCallback(() => setExpanded(false), []);
  const { pathname } = useLocation();
  const offline = useOffline();

  useEffect(() => setExpanded(false), [pathname]);
  useEffect(() => startSync(), []);
  useEffect(() => startUpdateChecks(), []);

  // Пробел — пауза/играть (если фокус не в поле ввода)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true], button, a, [role=button]")) return;
      if (e.code === "Space") {
        e.preventDefault();
        player.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative isolate flex h-dvh overflow-hidden">
      <div className="fixed inset-0 -z-10">
        <Ambient />
      </div>
      <Sidebar />
      <div id="app-scroll" className="flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-y-contain">
        <MobileHeader />
        <main
          className={cn(
            "mx-auto w-full max-w-[1500px] flex-1 px-4 pt-5 sm:px-6 lg:px-10 lg:pt-8",
            track ? "pb-[170px] lg:pb-[130px]" : "pb-[110px] lg:pb-12",
          )}
        >
          {offline && <OfflineBanner />}
          {offline && !OFFLINE_OK.some((p) => isActive(pathname, p)) ? <OfflinePage /> : children}
        </main>
      </div>
      <PlayerBar onExpand={open} />
      <MiniPlayer onExpand={open} />
      <TabBar />
      <SyncOfferCard />
      <UpdateCard />
      <NowPlaying open={expanded} onClose={close} />
    </div>
  );
}
