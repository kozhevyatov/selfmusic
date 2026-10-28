import { useEffect, useState } from "react";
import { Cover } from "@/components/Cover";
import { PlayFill } from "@/components/icon";
import { CloudUpload, Download, Info, LoaderCircle, Shuffle, Trash } from "@/components/icons";
import { PageHeader } from "@/components/Section";
import { Empty } from "@/components/ui/misc";
import { Select } from "@/components/ui/input";
import { dialogs } from "@/lib/dialogs";
import { formatSize } from "@/lib/format";
import { useOffline } from "@/lib/network";
import {
  getOfflineQuality,
  offlineSize,
  offlineSupported,
  offlineTracksOf,
  removeAll,
  removeCollection,
  setOfflineQuality,
  storageEstimate,
  useOfflineState,
  type OfflineCollection,
  type OfflineQuality,
} from "@/lib/offline";
import { player } from "@/lib/player";
import { Link } from "@/lib/router";
import { toast } from "@/lib/toast";

const KIND: Record<OfflineCollection["kind"], string> = {
  album: "Альбом",
  playlist: "Плейлист",
  mix: "Подборка",
  folder: "Папка",
  tracks: "Треки",
  book: "Аудиокнига",
};

function Row({ c }: { c: OfflineCollection }) {
  const s = useOfflineState();
  const offline = useOffline();
  const tracks = offlineTracksOf(c);
  const progress = s.progress[c.key];
  const size = c.track_ids.reduce((sum, id) => sum + (s.index.tracks[id]?.size ?? 0), 0);
  return (
    <div className="glass flex items-center gap-4 rounded-2xl border p-3">
      <Cover src={c.cover} seed={c.title} size={128} rounded="rounded-xl" className="size-16 shrink-0" />
      <div className="min-w-0 flex-1">
        {offline ? (
          <div className="truncate text-[15px] font-extrabold">{c.title}</div>
        ) : (
          <Link to={c.link} className="block truncate text-[15px] font-extrabold hover:underline">
            {c.title}
          </Link>
        )}
        <div className="truncate text-[13px] text-muted">
          {KIND[c.kind]}
          {c.subtitle ? ` · ${c.subtitle}` : ""}
        </div>
        <div className="mt-0.5 text-[12px] text-faint">
          {progress ? (
            <span className="flex items-center gap-1.5">
              <LoaderCircle className="size-3 animate-spin" /> Скачивается {progress.done} из {progress.total}
              {progress.failed ? ` · ошибок: ${progress.failed}` : ""}
            </span>
          ) : (
            <>
              {tracks.length} из {c.track_ids.length} тр. · {formatSize(size)}
            </>
          )}
        </div>
      </div>
      <button
        aria-label={`Слушать «${c.title}»`}
        disabled={!tracks.length}
        onClick={() => player.play(tracks, 0, { shuffle: false })}
        className="flex size-11 items-center justify-center rounded-full bg-accent text-accent-fg disabled:opacity-40"
      >
        <PlayFill className="ml-0.5 size-5" />
      </button>
      <button
        aria-label="Перемешать"
        disabled={!tracks.length}
        onClick={() => player.play(tracks, 0, { shuffle: true })}
        className="hidden size-11 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg sm:flex"
      >
        <Shuffle className="size-5" />
      </button>
      <button
        aria-label="Удалить с устройства"
        onClick={async () => {
          await removeCollection(c.key);
          toast.success("Удалено с устройства");
        }}
        className="flex size-11 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-danger"
      >
        <Trash className="size-5" />
      </button>
    </div>
  );
}

export default function OfflinePage() {
  const s = useOfflineState();
  const offline = useOffline();
  const [quality, setQuality] = useState<OfflineQuality>(getOfflineQuality());
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    void storageEstimate().then(setEst);
  }, [s.index]);

  if (!offlineSupported)
    return <Empty icon={<Download />} title="Не поддерживается" text="Этот браузер не умеет хранить музыку офлайн. Откройте сайт по https." />;

  const all = Object.values(s.index.tracks).map((t) => t.track);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Скачанное"
        subtitle={offline ? "Нет связи с сервером — играет то, что сохранено на этом устройстве" : "Музыка, сохранённая на этом устройстве — играет и без интернета"}
      />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
        <span>
          Занято <b>{formatSize(offlineSize())}</b>
          {est && est.quota > 0 && <span className="text-faint"> · свободно для приложения ≈ {formatSize(Math.max(0, est.quota - est.usage))}</span>}
        </span>
        <label className="flex items-center gap-2 text-muted">
          Качество новых загрузок
          <div className="w-64">
            <Select
              aria-label="Качество загрузок"
              value={quality}
              onChange={(e) => {
                const q = e.target.value as OfflineQuality;
                setQuality(q);
                setOfflineQuality(q);
              }}
            >
              <option value="128">MP3 128 — экономно</option>
              <option value="192">MP3 192 — оптимально</option>
              <option value="320">MP3 320 — высокое</option>
              <option value="original">Оригинал (FLAC — много места)</option>
            </Select>
          </div>
        </label>
        {all.length > 0 && (
          <button
            onClick={() => player.play(all, 0, { shuffle: true })}
            className="flex h-10 items-center gap-2 rounded-full bg-surface-2 px-4 font-bold hover:bg-surface-3"
          >
            <Shuffle className="size-4" /> Всё вперемешку
          </button>
        )}
      </div>

      {s.ready && s.index.collections.length === 0 && (
        <Empty
          icon={<CloudUpload />}
          title="Пока ничего не скачано"
          text="Откройте альбом, плейлист или подборку и нажмите «Скачать» — музыка будет играть даже в самолёте."
        />
      )}
      <div className="flex flex-col gap-2.5">
        {s.index.collections.map((c) => (
          <Row key={c.key} c={c} />
        ))}
      </div>

      <div className="flex gap-2.5 rounded-2xl bg-surface-2/50 p-4 text-[13px] text-muted">
        <Info className="mt-0.5 size-4 shrink-0 text-accent-ink" />
        <span>
          Скачанное хранится в этом браузере (или в установленном приложении). На iPhone приложение нужно установить на экран
          «Домой» — иначе iOS может очистить хранилище, если вы долго не открываете сайт.
        </span>
      </div>
      {s.index.collections.length > 0 && (
        <button
          onClick={async () => {
            const ok = await dialogs.confirm({ title: "Удалить всё скачанное?", text: "Музыка останется на сервере.", action: "Удалить", danger: true });
            if (ok) await removeAll();
          }}
          className="self-start text-sm font-bold text-muted hover:text-danger"
        >
          Удалить всё скачанное
        </button>
      )}
    </div>
  );
}
