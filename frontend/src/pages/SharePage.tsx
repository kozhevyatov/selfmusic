import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Ambient } from "@/components/Ambient";
import { Cover } from "@/components/Cover";
import { NextFill, PauseFill, PlayFill, PrevFill } from "@/components/icon";
import { ChevronRight, Download, Folder, ListMusic, Lock, LoaderCircle, Shuffle, TriangleAlert } from "@/components/icons";
import { BalalaikaMark } from "@/components/Logo";
import { Button, buttonClass } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, api, type PublicShare, type PublicTrack } from "@/lib/api";
import { usePalette } from "@/lib/colors";
import { formatDuration, formatSize, formatTime, tracksLabel } from "@/lib/format";
import { useParams } from "@/lib/router";
import { cn, shuffled } from "@/lib/utils";

type Opened = Extract<PublicShare, { locked: false }>;

/** Плеер страницы ссылки — свой, независимый от плеера приложения. */
function useSharePlayer(token: string, tracks: PublicTrack[]) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<PublicTrack[]>(tracks);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const counted = useRef<number | null>(null);
  const cur = index >= 0 ? queue[index] : null;

  useEffect(() => setQueue(tracks), [tracks]);

  useEffect(() => {
    const a = new Audio();
    a.preload = "metadata";
    audio.current = a;
    const on = (ev: string, fn: () => void) => a.addEventListener(ev, fn);
    on("play", () => setPlaying(true));
    on("pause", () => setPlaying(false));
    on("timeupdate", () => setTime(a.currentTime));
    // у перекодированного на лету потока длина неизвестна (Infinity) — остаётся длительность из тегов
    on("durationchange", () => isFinite(a.duration) && a.duration > 0 && setDuration(a.duration));
    return () => {
      a.pause();
      a.removeAttribute("src");
      a.load();
    };
  }, []);

  const playAt = useCallback(
    (i: number, list?: PublicTrack[]) => {
      const q = list ?? queue;
      const t = q[i];
      const a = audio.current;
      if (!t || !a) return;
      if (list) setQueue(list);
      setIndex(i);
      setTime(0);
      setDuration(t.duration);
      counted.current = null;
      a.src = `/api/s/${token}/stream/${t.id}`;
      a.play().catch(() => setPlaying(false));
    },
    [queue, token],
  );

  // Следующий трек по окончании, учёт прослушиваний (после 30 секунд)
  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    const ended = () => index < queue.length - 1 && playAt(index + 1);
    a.addEventListener("ended", ended);
    return () => a.removeEventListener("ended", ended);
  }, [index, queue, playAt]);

  useEffect(() => {
    if (cur && time > 30 && counted.current !== cur.id) {
      counted.current = cur.id;
      api.publicShare.play(token, cur.id).catch(() => {});
    }
  }, [time, cur, token]);

  // Экран блокировки и наушники
  useEffect(() => {
    if (!cur || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cur.title,
      artist: cur.artist,
      album: cur.album,
      artwork: cur.cover ? [{ src: `${cur.cover}?size=512`, sizes: "512x512", type: "image/webp" }] : [],
    });
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => audio.current?.play());
    ms.setActionHandler("pause", () => audio.current?.pause());
    ms.setActionHandler("previoustrack", () => index > 0 && playAt(index - 1));
    ms.setActionHandler("nexttrack", () => index < queue.length - 1 && playAt(index + 1));
  }, [cur, index, queue, playAt]);

  return {
    cur,
    index,
    queue,
    playing,
    time,
    duration,
    playAt,
    toggle: () => {
      const a = audio.current;
      if (!a) return;
      if (index < 0) playAt(0);
      else if (a.paused) a.play().catch(() => {});
      else a.pause();
    },
    prev: () => {
      const a = audio.current;
      if (a && a.currentTime > 4) a.currentTime = 0;
      else if (index > 0) playAt(index - 1);
    },
    next: () => index < queue.length - 1 && playAt(index + 1),
    seek: (t: number) => {
      if (audio.current) audio.current.currentTime = t;
      setTime(t);
    },
  };
}

function Shell({ children, colors }: { children: ReactNode; colors?: [string, string] }) {
  return (
    <div className="relative isolate min-h-svh">
      <div className="fixed inset-0 -z-10">
        <Ambient colors={colors} intensity={2} />
      </div>
      {children}
    </div>
  );
}

function Brand({ name }: { name: string }) {
  return (
    <a href="/" className="inline-flex items-center gap-2.5 text-sm font-bold text-muted hover:text-fg">
      <span className="inline-flex size-7 items-center justify-center rounded-[8px] bg-accent text-accent-fg">
        <BalalaikaMark className="size-[18px]" />
      </span>
      {name}
    </a>
  );
}

function Locked({ token, info, onOpen }: { token: string; info: Extract<PublicShare, { locked: true }>; onOpen: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.publicShare.unlock(token, pw);
      onOpen();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <div className="flex min-h-svh flex-col items-center justify-center gap-8 px-4 py-10">
        <Brand name={info.site_name} />
        <form onSubmit={submit} className="glass flex w-full max-w-sm flex-col gap-5 rounded-[28px] border p-7 shadow-2xl shadow-black/20">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-fg">
            <Lock className="size-7" />
          </span>
          <div>
            <h1 className="title-display text-2xl">Ссылка с паролем</h1>
            <p className="mt-2 text-sm text-muted">
              {info.owner} поделился с вами: {info.kind_label.toLowerCase()}. Введите пароль, чтобы открыть.
            </p>
          </div>
          <Input autoFocus type="password" aria-label="Пароль" placeholder="Пароль" value={pw} onChange={(e) => setPw(e.target.value)} />
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          <Button type="submit" size="lg" disabled={!pw || busy}>
            {busy && <LoaderCircle className="size-4 animate-spin" />} Открыть
          </Button>
        </form>
      </div>
    </Shell>
  );
}

type Group = { key: string; title: string; subtitle: string; cover: string | null; tracks: PublicTrack[] };

/** Ссылка на папку — группы по подпапкам; остальное — по альбомам. */
function groupTracks(data: Opened): Group[] {
  const map = new Map<string, Group>();
  for (const t of data.tracks) {
    const byFolder = data.kind === "folder" && t.folder !== null;
    const key = byFolder ? `f:${t.folder}` : `a:${t.album_id}`;
    let g = map.get(key);
    if (!g) {
      let title: string;
      let subtitle: string;
      if (byFolder) {
        const parts = (t.folder ?? "").split("/").filter(Boolean);
        title = parts.length ? parts[parts.length - 1] : "Файлы в корне папки";
        subtitle = parts.slice(0, -1).join(" / ");
      } else {
        title = t.album || "Без альбома";
        subtitle = t.artist;
      }
      g = { key, title, subtitle, cover: t.cover, tracks: [] };
      map.set(key, g);
    }
    if (!g.cover && t.cover) g.cover = t.cover;
    g.tracks.push(t);
  }
  return [...map.values()];
}

function TrackRow({
  t,
  n,
  active,
  playing,
  showCover,
  showAlbum,
  download,
  onClick,
}: {
  t: PublicTrack;
  n: number;
  active: boolean;
  playing: boolean;
  showCover: boolean;
  showAlbum: boolean;
  download?: () => void;
  onClick: () => void;
}) {
  return (
    <div
      role="listitem"
      onClick={onClick}
      className={cn(
        "group grid cursor-pointer grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-2 py-2 sm:gap-4",
        active ? "bg-surface-2/80" : "hover:bg-surface-2/60",
      )}
    >
      {showCover ? (
        <Cover src={t.cover} seed={t.album} size={96} rounded="rounded-md" className="size-10" />
      ) : (
        <span className={cn("num text-center text-[15px]", active ? "text-accent-ink" : "text-faint")}>
          {active && playing ? <PauseFill className="mx-auto size-4" /> : n}
        </span>
      )}
      <div className="min-w-0">
        <div className={cn("truncate text-[15px] font-semibold", active && "text-accent-ink")}>{t.title}</div>
        <div className="truncate text-[13px] text-muted">
          {t.artist}
          {showAlbum ? ` · ${t.album}` : ""}
          <span className="hidden sm:inline"> · {t.quality}</span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <span className="num w-11 text-right text-sm text-muted">{formatTime(t.duration)}</span>
        {download && (
          <button
            aria-label={`Скачать «${t.title}»`}
            onClick={(e) => {
              e.stopPropagation();
              download();
            }}
            className="flex size-9 items-center justify-center rounded-full text-faint hover:bg-surface-3 hover:text-fg"
          >
            <Download className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function ShareView({ token, data }: { token: string; data: Opened }) {
  const p = useSharePlayer(token, data.tracks);
  const palette = usePalette(data.cover ? `${data.cover}?size=96` : null, data.title);
  const multiAlbum = new Set(data.tracks.map((t) => t.album_id)).size > 1;
  const groups = useMemo(() => groupTracks(data), [data]);
  const [grouped, setGrouped] = useState(true);
  // немного групп — раскрываем сразу; много — показываем списком папок/альбомов
  const [open, setOpen] = useState<Set<string>>(() => new Set(groups.length <= 4 ? groups.map((g) => g.key) : []));
  const toggleGroup = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  useEffect(() => {
    document.title = `${data.title} · ${data.site_name}`;
  }, [data.title, data.site_name]);

  const download = (url: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Shell colors={palette}>
      <div className="mx-auto flex max-w-4xl flex-col gap-7 px-4 pt-6 pb-40 sm:px-8 sm:pt-10">
        <Brand name={data.site_name} />

        <header className="flex flex-col items-center gap-6 text-center sm:flex-row sm:items-end sm:text-left">
          <div className="w-56 shrink-0 sm:w-60">
            <Cover src={data.cover} seed={data.title} size={600} rounded="rounded-2xl" className="shadow-[0_24px_60px_rgba(0,0,0,0.45)]" />
          </div>
          <div className="min-w-0">
            <div className="label-caps">
              {data.kind_label} · поделился {data.owner}
            </div>
            <h1 className="title-display mt-2 text-[34px] break-words sm:text-5xl">{data.title}</h1>
            {data.subtitle && data.subtitle !== data.kind_label && <p className="mt-2 text-[15px] font-semibold text-muted">{data.subtitle}</p>}
            <p className="mt-2 text-sm text-faint">
              {tracksLabel(data.tracks.length)}, {formatDuration(data.duration)}
              {data.size ? ` · ${formatSize(data.size)}` : ""}
              {data.expires_at ? ` · доступно до ${new Date(data.expires_at).toLocaleDateString("ru-RU")}` : ""}
            </p>
          </div>
        </header>

        {data.description && <p className="glass rounded-2xl border p-4 leading-relaxed whitespace-pre-line">{data.description}</p>}

        <div className="flex flex-wrap items-center gap-3">
          <button
            aria-label={p.playing ? "Пауза" : "Слушать"}
            onClick={p.toggle}
            disabled={!data.tracks.length}
            className="flex size-16 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg shadow-xl shadow-black/25 transition hover:scale-105 disabled:opacity-40"
          >
            {p.playing ? <PauseFill className="size-7" /> : <PlayFill className="ml-1 size-7" />}
          </button>
          <button
            aria-label="Перемешать"
            onClick={() => p.playAt(0, shuffled(data.tracks))}
            className="flex size-12 shrink-0 items-center justify-center rounded-full border hover:bg-surface-2"
          >
            <Shuffle className="size-5" />
          </button>
          {data.allow_download && (
            <button onClick={() => download(`/api/s/${token}/zip`)} className={buttonClass("secondary", "md", "h-12")}>
              <Download className="size-[18px]" /> Скачать всё (ZIP)
            </button>
          )}
          {!data.allow_download && <span className="text-[13px] text-faint">Можно только слушать</span>}
        </div>

        {groups.length > 1 && (
          <div role="radiogroup" aria-label="Вид" className="flex w-max gap-1 rounded-full bg-surface-2 p-1">
            {[
              { v: true, label: data.kind === "folder" ? "По папкам" : "По альбомам", icon: <Folder className="size-4" /> },
              { v: false, label: "Все треки", icon: <ListMusic className="size-4" /> },
            ].map((o) => (
              <button
                key={String(o.v)}
                role="radio"
                aria-checked={grouped === o.v}
                onClick={() => setGrouped(o.v)}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px] font-bold transition",
                  grouped === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg",
                )}
              >
                {o.icon} {o.label}
              </button>
            ))}
          </div>
        )}

        {data.tracks.length === 0 ? (
          <p className="py-10 text-center text-muted">Здесь пока пусто.</p>
        ) : grouped && groups.length > 1 ? (
          <div className="-mx-2 flex flex-col gap-2">
            {groups.map((g) => {
              const isOpen = open.has(g.key);
              const playingHere = p.cur != null && g.tracks.some((t) => t.id === p.cur!.id);
              return (
                <section key={g.key} className={cn("rounded-2xl transition", isOpen && "glass border")}>
                  <div
                    className="group flex cursor-pointer items-center gap-3 rounded-2xl p-2 hover:bg-surface-2/60"
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={isOpen}
                  >
                    <ChevronRight className={cn("size-4 shrink-0 text-faint transition-transform", isOpen && "rotate-90")} />
                    <Cover src={g.cover} seed={g.title} size={120} rounded="rounded-xl" className="size-14 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className={cn("truncate text-[15px] font-bold", playingHere && "text-accent-ink")}>{g.title}</div>
                      {g.subtitle && <div className="truncate text-[13px] text-muted">{g.subtitle}</div>}
                      <div className="text-[12px] text-faint">
                        {tracksLabel(g.tracks.length)} · {formatDuration(g.tracks.reduce((a, t) => a + t.duration, 0))}
                      </div>
                    </div>
                    <button
                      aria-label={`Слушать «${g.title}»`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (playingHere) p.toggle();
                        else p.playAt(0, g.tracks);
                      }}
                      className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg shadow-lg shadow-black/20 transition hover:scale-105"
                    >
                      {playingHere && p.playing ? <PauseFill className="size-5" /> : <PlayFill className="ml-0.5 size-5" />}
                    </button>
                  </div>
                  {isOpen && (
                    <div role="list" className="flex flex-col px-1 pb-2">
                      {g.tracks.map((t, i) => (
                        <TrackRow
                          key={`${t.id}-${i}`}
                          t={t}
                          n={t.track_no ?? i + 1}
                          active={p.cur?.id === t.id}
                          playing={p.playing}
                          showCover={false}
                          showAlbum={false}
                          download={data.allow_download ? () => download(`/api/s/${token}/download/${t.id}`) : undefined}
                          onClick={() => (p.cur?.id === t.id ? p.toggle() : p.playAt(i, g.tracks))}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <div role="list" className="-mx-2 flex flex-col">
            {data.tracks.map((t, i) => (
              <TrackRow
                key={`${t.id}-${i}`}
                t={t}
                n={t.track_no ?? i + 1}
                active={p.cur?.id === t.id}
                playing={p.playing}
                showCover={multiAlbum}
                showAlbum={multiAlbum}
                download={data.allow_download ? () => download(`/api/s/${token}/download/${t.id}`) : undefined}
                onClick={() => (p.cur?.id === t.id ? p.toggle() : p.playAt(i, data.tracks))}
              />
            ))}
          </div>
        )}
      </div>

      {p.cur && (
        <div className="glass fixed inset-x-2 bottom-[max(0.5rem,var(--sab))] z-40 mx-auto max-w-4xl rounded-2xl border p-3 shadow-2xl shadow-black/30 sm:inset-x-6">
          <div className="flex items-center gap-3">
            <Cover src={p.cur.cover} seed={p.cur.album} size={96} rounded="rounded-lg" className="size-12 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold">{p.cur.title}</div>
              <div className="truncate text-xs text-muted">{p.cur.artist}</div>
            </div>
            <button aria-label="Предыдущий" onClick={p.prev} className="flex size-10 items-center justify-center rounded-full">
              <PrevFill className="size-5" />
            </button>
            <button aria-label={p.playing ? "Пауза" : "Играть"} onClick={p.toggle} className="flex size-11 items-center justify-center rounded-full bg-fg text-bg">
              {p.playing ? <PauseFill className="size-5" /> : <PlayFill className="ml-0.5 size-5" />}
            </button>
            <button aria-label="Следующий" onClick={p.next} className="flex size-10 items-center justify-center rounded-full">
              <NextFill className="size-5" />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <span className="num w-10 text-right text-xs text-faint">{formatTime(p.time)}</span>
            <input
              type="range"
              aria-label="Перемотка"
              min={0}
              max={p.duration || 1}
              step={0.1}
              value={Math.min(p.time, p.duration || 1)}
              onChange={(e) => p.seek(Number(e.target.value))}
              className="range flex-1"
              style={{ ["--fill" as string]: `${p.duration ? (p.time / p.duration) * 100 : 0}%`, ["--range-color" as string]: "var(--accent)" }}
            />
            <span className="num w-10 text-xs text-faint">{formatTime(p.duration)}</span>
          </div>
        </div>
      )}
    </Shell>
  );
}

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<{ data?: PublicShare; error?: string; status?: number }>({});
  const load = useCallback(() => {
    api.publicShare
      .open(token)
      .then((data) => setState({ data }))
      .catch((err) => setState({ error: (err as Error).message, status: err instanceof ApiError ? err.status : 0 }));
  }, [token]);

  useEffect(load, [load]);

  // Свой манифест: «На экран Домой» откроет именно эту ссылку
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const prev = link?.href;
    if (link) link.href = `/api/s/${token}/manifest.json`;
    return () => {
      if (link && prev) link.href = prev;
    };
  }, [token]);

  if (state.error)
    return (
      <Shell>
        <div className="flex min-h-svh flex-col items-center justify-center gap-5 px-6 text-center">
          <span className="flex size-16 items-center justify-center rounded-3xl bg-surface-2 text-danger">
            <TriangleAlert className="size-8" />
          </span>
          <h1 className="title-display text-2xl">{state.status === 410 ? "Ссылка больше не действует" : "Ссылка не найдена"}</h1>
          <p className="max-w-sm text-muted">{state.error}. Попросите отправителя прислать новую.</p>
        </div>
      </Shell>
    );
  if (!state.data)
    return (
      <Shell>
        <div className="flex min-h-svh items-center justify-center">
          <LoaderCircle className="size-7 animate-spin text-faint" />
        </div>
      </Shell>
    );
  if (state.data.locked) return <Locked token={token} info={state.data} onOpen={load} />;
  return <ShareView token={token} data={state.data} />;
}
