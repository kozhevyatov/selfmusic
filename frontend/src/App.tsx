import type { ReactNode } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useQuery } from "@/lib/query";
import { Navigate, Routes, useLocation } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { DialogHost } from "@/components/DialogHost";
import { LogoBadge } from "@/components/Logo";
import SetupPage from "@/pages/SetupPage";
import WelcomePage from "@/pages/WelcomePage";
import SharePage from "@/pages/SharePage";
import SharesPage from "@/pages/SharesPage";
import LoginPage from "@/pages/LoginPage";
import RegisterPage from "@/pages/RegisterPage";
import HomePage from "@/pages/HomePage";
import SearchPage from "@/pages/SearchPage";
import LibraryPage from "@/pages/LibraryPage";
import AlbumsPage from "@/pages/AlbumsPage";
import AlbumPage from "@/pages/AlbumPage";
import ArtistsPage from "@/pages/ArtistsPage";
import ArtistPage from "@/pages/ArtistPage";
import PlaylistsPage from "@/pages/PlaylistsPage";
import PlaylistPage from "@/pages/PlaylistPage";
import FavoritesPage from "@/pages/FavoritesPage";
import FoldersPage from "@/pages/FoldersPage";
import FolderPage from "@/pages/FolderPage";
import MixesPage from "@/pages/MixesPage";
import BooksPage from "@/pages/BooksPage";
import BookPage from "@/pages/BookPage";
import MixPage from "@/pages/MixPage";
import OfflinePage from "@/pages/OfflinePage";
import { useOffline } from "@/lib/network";
import UploadPage from "@/pages/UploadPage";
import ProfilePage from "@/pages/ProfilePage";
import AdminPage from "@/pages/AdminPage";

function Splash({ error }: { error?: string }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-5 p-6 text-center">
      <LogoBadge size="lg" className={error ? "" : "animate-pulse"} />
      {error && <p className="max-w-sm text-muted">{error}</p>}
    </div>
  );
}

const PUBLIC = ["/setup", "/welcome", "/login", "/register"];

function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user?.is_admin ? <>{children}</> : <Navigate to="/" />;
}

export default function App() {
  const { ready, user } = useAuth();
  const { pathname } = useLocation();
  const status = useQuery(["setup-status"], api.setup.status, { staleTime: 5 * 60_000 });
  const offline = useOffline();

  // Публичная страница ссылки — без входа и без проверки настройки
  if (pathname.startsWith("/s/")) return <Routes routes={[{ path: "/s/:token", element: <SharePage /> }]} />;

  if (status.isLoading || !ready) return <Splash />;
  // без связи, но вход уже был — открываем приложение со скачанной музыкой
  const offlineMode = offline && Boolean(user);
  if (status.error && !offlineMode) return <Splash error="Не удалось связаться с сервером. Проверьте, что контейнер запущен." />;

  const setupDone = offlineMode ? true : status.data?.setup_complete;
  if (!setupDone && pathname !== "/setup") return <Navigate to="/setup" />;

  if (PUBLIC.includes(pathname)) {
    return (
      <>
        <Routes
          routes={[
            { path: "/setup", element: setupDone ? <Navigate to={user ? "/welcome" : "/"} /> : <SetupPage /> },
            { path: "/welcome", element: user?.is_admin ? <WelcomePage /> : <Navigate to="/" /> },
            { path: "/login", element: <LoginPage /> },
            { path: "/register", element: <RegisterPage /> },
          ]}
        />
        <DialogHost />
      </>
    );
  }

  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(pathname)}`} />;

  // Оболочка (меню, плеер) не пересоздаётся при переходах — меняется только страница
  return (
    <Layout>
      <Routes
        routes={[
          { path: "/", element: <HomePage /> },
          { path: "/search", element: <SearchPage /> },
          { path: "/library", element: <LibraryPage /> },
          { path: "/albums", element: <AlbumsPage /> },
          { path: "/albums/:id", element: <AlbumPage /> },
          { path: "/artists", element: <ArtistsPage /> },
          { path: "/artists/:id", element: <ArtistPage /> },
          { path: "/playlists", element: <PlaylistsPage /> },
          { path: "/playlists/:id", element: <PlaylistPage /> },
          { path: "/favorites", element: <FavoritesPage /> },
          { path: "/mixes", element: <MixesPage /> },
          { path: "/books", element: <BooksPage /> },
          { path: "/books/:id", element: <BookPage /> },
          { path: "/mixes/:key", element: <MixPage /> },
          { path: "/folders", element: <FoldersPage /> },
          { path: "/folders/:id", element: <FolderPage /> },
          { path: "/upload", element: <UploadPage /> },
          { path: "/shares", element: <SharesPage /> },
          { path: "/offline", element: <OfflinePage /> },
          { path: "/profile", element: <ProfilePage /> },
          { path: "/admin", element: <AdminOnly><AdminPage /></AdminOnly> },
          { path: "*", element: <Navigate to="/" /> },
        ]}
      />
      <DialogHost />
    </Layout>
  );
}
