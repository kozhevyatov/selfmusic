import { ArtistCard, AlbumCard, CardGrid } from "@/components/Cards";
import { Cover } from "@/components/Cover";
import { PlayFill } from "@/components/icon";
import { Dices, Folder, FolderPlus, Upload } from "@/components/icons";
import { Section } from "@/components/Section";
import { buttonClass } from "@/components/ui/button";
import { Empty, ErrorBox, PageLoader, Progress } from "@/components/ui/misc";
import { api, type Album } from "@/lib/api";
import { playAlbum, playRandom } from "@/lib/actions";
import { useAuth } from "@/lib/auth";
import { formatDuration, greeting } from "@/lib/format";
import { player, useCurrentTrack, usePlayer } from "@/lib/player";
import { useQuery } from "@/lib/query";
import { Link } from "@/lib/router";
import { countLabel } from "@/lib/utils";

function SuggestCard({ album }: { album: Album }) {
  return (
    <div className="glass flex flex-wrap items-center gap-6 rounded-3xl border p-5 sm:flex-nowrap sm:p-6">
      <Link to={`/albums/${album.id}`} className="w-28 shrink-0 sm:w-44">
        <Cover src={album.cover} seed={album.name + album.artist} size={400} rounded="rounded-2xl" className="shadow-xl shadow-black/30" />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="label-caps text-accent-ink">Послушать сегодня</div>
        <Link to={`/albums/${album.id}`} className="title-display truncate text-2xl hover:underline sm:text-4xl">
          {album.name}
        </Link>
        <div className="truncate text-muted">{[album.artist, album.year, album.quality].filter(Boolean).join(" · ")}</div>
      </div>
      <button onClick={() => playAlbum(album.id)} className={buttonClass("primary", "lg", "w-full sm:w-auto")}>
        <PlayFill className="size-4" /> Слушать
      </button>
    </div>
  );
}

function ContinueCard({ fallback }: { fallback?: Album }) {
  const track = useCurrentTrack();
  const index = usePlayer((s) => s.index);
  const total = usePlayer((s) => s.queue.length);
  const progress = usePlayer((s) => (s.duration ? s.time / s.duration : 0));
  const playing = usePlayer((s) => s.playing);
  if (!track) return fallback ? <SuggestCard album={fallback} /> : null;
  return (
    <div className="glass flex flex-wrap items-center gap-6 rounded-3xl border p-5 sm:flex-nowrap sm:p-6">
      <Link to={`/albums/${track.album_id}`} className="w-28 shrink-0 sm:w-44">
        <Cover src={track.cover} seed={track.album + track.album_artist} size={400} rounded="rounded-2xl" className="shadow-xl shadow-black/30" />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="label-caps text-accent-ink">{playing ? "Сейчас играет" : "Продолжить слушать"}</div>
        <h2 className="title-display truncate text-2xl sm:text-4xl">{track.album || track.title}</h2>
        <div className="truncate text-muted">
          {track.album_artist || track.artist}
          {track.year ? ` · ${track.year}` : ""} · {track.title}
        </div>
        <Progress value={progress * 100} className="max-w-md" />
        <div className="flex flex-wrap gap-3 pt-1 text-[13px] text-faint">
          Трек {index + 1} из {total}
        </div>
      </div>
      {!playing && (
        <button onClick={() => player.resume()} className={buttonClass("primary", "lg", "w-full sm:w-auto")}>
          <PlayFill className="size-4" /> Продолжить
        </button>
      )}
    </div>
  );
}

export default function HomePage() {
  const { user } = useAuth();
  const home = useQuery(["home"], api.library.home, { staleTime: 60_000 });
  const libs = useQuery(["libraries"], api.library.libraries, { staleTime: 60_000 });
  const name = user?.display_name || user?.username;

  if (home.isLoading) return <PageLoader />;
  if (home.error) return <ErrorBox error={home.error} />;
  const d = home.data!;

  if (!d.stats.tracks) {
    return (
      <Empty
        icon={<FolderPlus />}
        title="Медиатека пока пуста"
        text={
          user?.is_admin
            ? "Добавьте папки с музыкой в управлении — сервер их просканирует."
            : libs.data?.length
              ? "Папки сканируются, загляните через минуту."
              : "Администратор ещё не открыл вам ни одной папки с музыкой."
        }
        action={
          user?.is_admin ? (
            <Link to="/admin?tab=libraries" className={buttonClass("primary")}>
              Добавить папку
            </Link>
          ) : user?.upload_mode !== "none" ? (
            <Link to="/upload" className={buttonClass("primary")}>
              <Upload className="size-4" /> Загрузить музыку
            </Link>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="title-display text-3xl sm:text-[40px]">
          {greeting()}
          {name ? `, ${name}` : ""}
        </h1>
        <button onClick={() => playRandom()} className={buttonClass("secondary", "md")}>
          <Dices className="size-[18px]" /> Случайный микс
        </button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <ContinueCard fallback={d.random_albums[0]} />
        <div className="glass flex flex-col gap-4 rounded-3xl border p-6">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[17px] font-extrabold">Твоя медиатека</h2>
            <Link to="/folders" className="text-[13px] font-bold text-muted hover:text-fg">
              Все папки
            </Link>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              [d.stats.tracks, "треков"],
              [d.stats.albums, "альбомов"],
              [d.stats.artists, "артистов"],
            ].map(([n, l]) => (
              <div key={l} className="rounded-2xl bg-surface-2/70 px-2 py-3">
                <div className="num font-display text-xl font-semibold">{Number(n).toLocaleString("ru-RU")}</div>
                <div className="text-xs text-faint">{l}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            {(libs.data ?? []).slice(0, 4).map((l) => (
              <Link key={l.id} to={`/albums?library=${l.id}`} className="flex items-center gap-3 rounded-xl p-1.5 hover:bg-surface-2/60">
                <span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-accent-ink">
                  <Folder className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{l.name}</span>
                  <span className="block text-[13px] text-faint">{countLabel(l.album_count, "альбом", "альбома", "альбомов")}</span>
                </span>
              </Link>
            ))}
          </div>
          <div className="mt-auto text-[13px] text-faint">Всего {formatDuration(d.stats.duration)} музыки</div>
        </div>
      </div>

      {d.recent_albums.length > 0 && (
        <Section title="Недавно добавлено" link="/albums?sort=newest">
          <CardGrid row>
            {d.recent_albums.slice(0, 12).map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </CardGrid>
        </Section>
      )}

      {d.recently_played.length > 0 && (
        <Section title="Недавно слушал" link="/albums?sort=recent">
          <CardGrid row>
            {d.recently_played.map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </CardGrid>
        </Section>
      )}

      {d.frequent_artists.length > 0 && (
        <Section title={d.recently_played.length ? "Часто слушаешь" : "Исполнители"} link="/artists">
          <CardGrid row artists>
            {d.frequent_artists.slice(0, 8).map((a) => (
              <ArtistCard key={a.id} artist={a} />
            ))}
          </CardGrid>
        </Section>
      )}

      {d.random_albums.length > 0 && (
        <Section title="Наугад из коллекции" link="/albums?sort=random" linkLabel="Ещё">
          <CardGrid row>
            {d.random_albums.map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </CardGrid>
        </Section>
      )}
    </div>
  );
}
