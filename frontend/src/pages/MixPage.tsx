import { DownloadButton } from "@/components/DownloadButton";
import { useState } from "react";
import { PlayFill } from "@/components/icon";
import { Link as LinkIcon, ListPlus, RefreshCw, Shuffle } from "@/components/icons";
import { MixCover } from "@/components/MixCover";
import { TrackList } from "@/components/TrackList";
import { Empty, ErrorBox, PageLoader } from "@/components/ui/misc";
import { api, type MixDetail, type Track } from "@/lib/api";
import { useCanShare } from "@/lib/auth";
import { dialogs } from "@/lib/dialogs";
import { formatDuration, tracksLabel } from "@/lib/format";
import { player } from "@/lib/player";
import { invalidate, setQueryData, useQuery } from "@/lib/query";
import { navigate, useParams } from "@/lib/router";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export default function MixPage() {
  const { key } = useParams<{ key: string }>();
  const q = useQuery(["mix", key], () => api.library.mix(key));
  const canShare = useCanShare();
  const [busy, setBusy] = useState(false);
  const m = q.data;

  if (q.isLoading) return <PageLoader />;
  if (q.error || !m) return <ErrorBox error={q.error} />;

  const refresh = async () => {
    setBusy(true);
    try {
      const fresh = await api.library.refreshMix(m.key);
      setQueryData<MixDetail>(["mix", key], () => fresh);
      invalidate(["mixes"]);
      toast.success("Подборка собрана заново");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hide = async (t: Track) => {
    setQueryData<MixDetail>(["mix", key], (old) => old && { ...old, tracks: old.tracks.filter((x) => x.id !== t.id) });
    try {
      await api.library.hideFromMix(m.key, t.id);
      invalidate(["mixes"]);
      toast.success(`«${t.title}» больше не попадёт в «${m.title}»`);
    } catch (err) {
      toast.error((err as Error).message);
      void q.refetch();
    }
  };

  const save = async () => {
    try {
      const pl = await api.library.saveMix(m.key);
      invalidate(["playlists"]);
      toast.success(`Сохранено: «${pl.name}»`);
      navigate(`/playlists/${pl.id}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const duration = m.tracks.reduce((s, t) => s + (t.duration || 0), 0);

  return (
    <div className="flex flex-col gap-8">
      <header className="relative -mx-4 -mt-5 overflow-hidden px-4 pt-8 pb-2 sm:-mx-6 sm:px-6 lg:-mx-10 lg:-mt-8 lg:px-10 lg:pt-12">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 opacity-50"
          style={{ background: `radial-gradient(110% 90% at 10% 0%, color-mix(in srgb, ${m.colors[0]} 55%, transparent), transparent 70%)` }}
        />
        <div className="flex flex-col items-center gap-6 text-center sm:flex-row sm:items-end sm:text-left">
          <div className="w-52 shrink-0 sm:w-60">
            <MixCover mix={m} size="lg" className="shadow-[0_24px_60px_rgba(0,0,0,0.45)]" />
          </div>
          <div className="min-w-0">
            <div className="label-caps">Подборка{m.current ? " · сейчас" : ""}</div>
            <h1 className="title-display mt-2 text-4xl break-words sm:text-6xl">{m.title}</h1>
            <p className="mt-3 text-muted">{m.subtitle}</p>
            <p className="mt-1 text-sm text-faint">
              {tracksLabel(m.tracks.length)} · {formatDuration(duration)} · обновляется каждый день
            </p>
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <button
          aria-label="Слушать"
          disabled={!m.tracks.length}
          onClick={() => player.play(m.tracks, 0, { shuffle: false })}
          className="flex size-16 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg shadow-xl shadow-black/25 transition hover:scale-105 disabled:opacity-50"
        >
          <PlayFill className="ml-1 size-7" />
        </button>
        <button
          aria-label="Перемешать"
          disabled={!m.tracks.length}
          onClick={() => player.play(m.tracks, 0, { shuffle: true })}
          className="flex size-12 shrink-0 items-center justify-center rounded-full border text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          <Shuffle className="size-5" />
        </button>
        <button
          onClick={refresh}
          disabled={busy}
          className="flex h-12 items-center gap-2 rounded-full border px-4 text-[14px] font-bold text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          <RefreshCw className={cn("size-4", busy && "animate-spin")} /> Обновить
        </button>
        <DownloadButton
          kind="mix"
          id={m.key}
          title={m.title}
          subtitle="Подборка дня"
          cover={m.covers[0] ?? null}
          link={`/mixes/${m.key}`}
          tracks={m.tracks}
        />
        <button
          onClick={save}
          disabled={!m.tracks.length}
          className="flex h-12 items-center gap-2 rounded-full border px-4 text-[14px] font-bold text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          <ListPlus className="size-4" /> В плейлист
        </button>
        {canShare && m.tracks.length > 0 && (
          <button
            onClick={() => dialogs.share({ kind: "tracks", track_ids: m.tracks.map((t) => t.id), label: `Подборка «${m.title}»` })}
            className="flex h-12 items-center gap-2 rounded-full border px-4 text-[14px] font-bold text-muted transition hover:bg-surface-2 hover:text-fg"
          >
            <LinkIcon className="size-4" /> Поделиться
          </button>
        )}
      </div>

      {m.tracks.length > 0 ? (
        <TrackList
          tracks={m.tracks}
          showAlbum
          showCover
          selectable
          onRemove={hide}
          removeLabel="Не подходит для подборки"
          className="-mx-2 sm:-mx-3"
        />
      ) : (
        <Empty
          title="Пока пусто"
          text="Для этой подборки не нашлось подходящих треков. Загляните завтра — или добавьте музыки."
        />
      )}
    </div>
  );
}
