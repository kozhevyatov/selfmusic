import { useEffect, useMemo, useRef, useState } from "react";
import { api, coverUrl } from "@/lib/api";
import { setFavorite } from "@/lib/actions";
import { usePalette } from "@/lib/colors";
import { formatTime } from "@/lib/format";
import { parseLyrics } from "@/lib/lyrics";
import { player, useCurrentTrack, usePlayer } from "@/lib/player";
import { Link } from "@/lib/router";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Ambient } from "./Ambient";
import { Cover } from "./Cover";
import { HeartFill, NextFill, PauseFill, PlayFill, PrevFill } from "./icon";
import {
  ChevronDown,
  GripVertical,
  Heart,
  ListMusic,
  LoaderCircle,
  Radio,
  Repeat,
  Repeat1,
  Shuffle,
  SlidersHorizontal,
  TextQuote,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "./icons";
import { EqualizerDialog } from "./SoundSettings";
import { TrackMenuButton } from "./TrackMenu";

// ---------- общие элементы управления ----------

export function Seekbar({ className, big = false }: { className?: string; big?: boolean }) {
  const time = usePlayer((s) => s.time);
  const duration = usePlayer((s) => s.duration || s.queue[s.index]?.duration || 0);
  const [drag, setDrag] = useState<number | null>(null);
  const value = drag ?? time;
  const pct = duration ? (value / duration) * 100 : 0;
  return (
    <div className={cn("flex w-full items-center gap-3", className)}>
      <span className={cn("num w-10 text-right text-xs text-faint", big && "text-[13px]")}>{formatTime(value)}</span>
      <input
        type="range"
        aria-label="Перемотка"
        min={0}
        max={duration || 1}
        step={0.1}
        value={Math.min(value, duration || 1)}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => {
          if (drag !== null) player.seek(drag);
          setDrag(null);
        }}
        onKeyUp={() => {
          if (drag !== null) player.seek(drag);
          setDrag(null);
        }}
        className={cn("range flex-1", big && "always")}
        style={{ ["--fill" as string]: `${pct}%`, ["--range-color" as string]: big ? "var(--fg)" : "var(--accent)" }}
      />
      <span className={cn("num w-10 text-xs text-faint", big && "text-[13px]")}>{formatTime(duration)}</span>
    </div>
  );
}

export function PlayButton({ size = "md", className }: { size?: "sm" | "md" | "lg" | "xl"; className?: string }) {
  const playing = usePlayer((s) => s.playing);
  const loading = usePlayer((s) => s.loading);
  const dims = { sm: "size-10", md: "size-12", lg: "size-16", xl: "size-20" }[size];
  const icon = { sm: "size-4", md: "size-5", lg: "size-7", xl: "size-8" }[size];
  return (
    <button
      aria-label={playing ? "Пауза" : "Играть"}
      onClick={() => player.toggle()}
      className={cn("flex shrink-0 items-center justify-center rounded-full transition active:scale-95", dims, className)}
    >
      {loading && playing ? (
        <LoaderCircle className={cn(icon, "animate-spin")} />
      ) : playing ? (
        <PauseFill className={icon} />
      ) : (
        <PlayFill className={cn(icon, "ml-0.5")} />
      )}
    </button>
  );
}

function ShuffleButton({ className }: { className?: string }) {
  const on = usePlayer((s) => s.shuffle);
  return (
    <button
      aria-label="Перемешать"
      aria-pressed={on}
      onClick={() => player.toggleShuffle()}
      className={cn("relative flex size-10 items-center justify-center rounded-full transition hover:text-fg", on ? "text-accent-ink" : "text-muted", className)}
    >
      <Shuffle className="size-[19px]" />
      {on && <span className="absolute bottom-1 size-1 rounded-full bg-accent" />}
    </button>
  );
}

function RepeatButton({ className }: { className?: string }) {
  const mode = usePlayer((s) => s.repeat);
  const label = mode === "off" ? "Повтор выключен" : mode === "all" ? "Повтор очереди" : "Повтор трека";
  return (
    <button
      aria-label={label}
      title={label}
      onClick={() => player.cycleRepeat()}
      className={cn(
        "relative flex size-10 items-center justify-center rounded-full transition hover:text-fg",
        mode === "off" ? "text-muted" : "text-accent-ink",
        className,
      )}
    >
      {mode === "one" ? <Repeat1 className="size-[19px]" /> : <Repeat className="size-[19px]" />}
      {mode !== "off" && <span className="absolute bottom-1 size-1 rounded-full bg-accent" />}
    </button>
  );
}

export function Transport({ big = false }: { big?: boolean }) {
  return (
    <div className={cn("flex items-center", big ? "w-full justify-between" : "gap-2")}>
      <ShuffleButton className={big ? "size-12" : ""} />
      <button
        aria-label="Предыдущий"
        onClick={() => player.prev()}
        className={cn("flex items-center justify-center rounded-full text-fg transition active:scale-95", big ? "size-14" : "size-10")}
      >
        <PrevFill className={big ? "size-8" : "size-5"} />
      </button>
      <PlayButton
        size={big ? "xl" : "md"}
        className={big ? "bg-accent text-accent-fg shadow-xl shadow-black/30" : "bg-fg text-bg hover:scale-105"}
      />
      <button
        aria-label="Следующий"
        onClick={() => player.next()}
        className={cn("flex items-center justify-center rounded-full text-fg transition active:scale-95", big ? "size-14" : "size-10")}
      >
        <NextFill className={big ? "size-8" : "size-5"} />
      </button>
      <RepeatButton className={big ? "size-12" : ""} />
    </div>
  );
}

function Volume() {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const v = muted ? 0 : volume;
  return (
    <div className="flex items-center gap-1">
      <button
        aria-label={muted ? "Включить звук" : "Выключить звук"}
        onClick={() => player.toggleMute()}
        className="flex size-10 items-center justify-center rounded-full text-muted hover:text-fg"
      >
        {v === 0 ? <VolumeX className="size-[19px]" /> : v < 0.5 ? <Volume1 className="size-[19px]" /> : <Volume2 className="size-[19px]" />}
      </button>
      <input
        type="range"
        aria-label="Громкость"
        min={0}
        max={1}
        step={0.01}
        value={v}
        onChange={(e) => player.setVolume(Number(e.target.value))}
        className="range w-24"
        style={{ ["--fill" as string]: `${v * 100}%` }}
      />
    </div>
  );
}

function FavButton({ className }: { className?: string }) {
  const track = useCurrentTrack();
  if (!track) return null;
  return (
    <button
      aria-label={track.starred ? "Убрать из избранного" : "В избранное"}
      aria-pressed={track.starred}
      onClick={() => setFavorite("track", track.id, !track.starred)}
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-full transition",
        track.starred ? "text-accent-ink" : "text-muted hover:text-fg",
        className,
      )}
    >
      {track.starred ? <HeartFill className="size-5" /> : <Heart className="size-5" />}
    </button>
  );
}

// ---------- нижняя панель (компьютер) ----------

export function PlayerBar({ onExpand }: { onExpand: () => void }) {
  const track = useCurrentTrack();
  if (!track) return null;
  return (
    <div className="glass fixed inset-x-0 bottom-0 z-40 hidden border-t lg:block">
      <div className="grid h-[88px] grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)] items-center gap-6 px-5">
        <div className="flex min-w-0 items-center gap-3.5">
          <button aria-label="Открыть плеер" onClick={onExpand} className="size-14 shrink-0 transition hover:scale-[1.03]">
            <Cover src={track.cover} seed={track.album + track.album_artist} size={128} rounded="rounded-lg" />
          </button>
          <div className="min-w-0">
            <button onClick={onExpand} className="block max-w-full truncate text-left text-[15px] font-bold hover:underline">
              {track.title}
            </button>
            <div className="truncate text-[13px] text-muted">
              {track.artist_id ? (
                <Link to={`/artists/${track.artist_id}`} className="hover:text-fg hover:underline">
                  {track.artist}
                </Link>
              ) : (
                track.artist
              )}
            </div>
          </div>
          <FavButton />
        </div>
        <div className="flex flex-col items-center gap-1">
          <Transport />
          <Seekbar className="max-w-[620px]" />
        </div>
        <div className="flex items-center justify-end gap-1">
          <span className="mr-2 hidden xl:inline-flex">
            <span className="rounded-md border border-line px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-muted">{track.quality}</span>
          </span>
          <button aria-label="Очередь и текст" onClick={onExpand} className="flex size-10 items-center justify-center rounded-full text-muted hover:text-fg">
            <ListMusic className="size-[19px]" />
          </button>
          <Volume />
        </div>
      </div>
    </div>
  );
}

// ---------- мини-плеер (телефон) ----------

export function MiniPlayer({ onExpand }: { onExpand: () => void }) {
  const track = useCurrentTrack();
  const progress = usePlayer((s) => (s.duration ? s.time / s.duration : 0));
  if (!track) return null;
  return (
    <div className="fixed inset-x-2 bottom-[calc(76px+env(safe-area-inset-bottom))] z-40 lg:hidden">
      <div
        role="button"
        tabIndex={0}
        aria-label="Открыть плеер"
        onClick={onExpand}
        onKeyDown={(e) => e.key === "Enter" && onExpand()}
        className="glass relative flex items-center gap-3 overflow-hidden rounded-2xl border p-2 shadow-xl shadow-black/25"
      >
        <Cover src={track.cover} seed={track.album + track.album_artist} size={96} rounded="rounded-lg" className="size-11 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{track.title}</div>
          <div className="truncate text-xs text-muted">{track.artist}</div>
        </div>
        <span onClick={(e) => e.stopPropagation()} className="flex items-center">
          <FavButton className="size-11" />
          <PlayButton size="sm" className="size-11 text-fg" />
        </span>
        <div className="absolute inset-x-3 bottom-0 h-[2px] bg-surface-3">
          <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

// ---------- очередь ----------

function QueueList() {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const upcoming = queue.slice(index + 1);
  const radio = usePlayer((s) => s.radio);
  return (
    <div className="flex flex-col gap-1">
      {radio && (
        <div className="mx-1 mb-1 flex items-center gap-3 rounded-2xl bg-white/10 px-3 py-2.5">
          <Radio className="size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold tracking-[0.08em] uppercase opacity-70">Радио</div>
            <div className="truncate text-sm font-bold">{radio.label}</div>
          </div>
          <button onClick={() => player.stopRadio()} className="rounded-full px-3 py-1.5 text-[13px] font-bold opacity-80 hover:bg-white/10 hover:opacity-100">
            Выключить
          </button>
        </div>
      )}
      <div className="flex items-baseline justify-between px-2 pt-1 pb-2">
        <h3 className="text-[15px] font-extrabold">Далее · {upcoming.length}</h3>
        {upcoming.length > 0 && (
          <button onClick={() => player.clearUpcoming()} className="text-[13px] font-bold text-muted hover:text-fg">
            Очистить
          </button>
        )}
      </div>
      {upcoming.length === 0 && (
        <p className="px-2 py-6 text-center text-sm text-muted">{radio ? "Подбираю похожие…" : "После этого трека очередь закончится"}</p>
      )}
      {upcoming.slice(0, 300).map((t, k) => {
        const i = index + 1 + k;
        return (
          <div
            key={`${t.id}-${i}`}
            draggable
            onDragStart={() => setDragFrom(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragFrom !== null && dragFrom !== i) player.move(dragFrom, i);
              setDragFrom(null);
            }}
            className={cn("group flex items-center gap-3 rounded-xl p-1.5 hover:bg-white/5", dragFrom === i && "opacity-40")}
          >
            <button onClick={() => player.jumpTo(i)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Играть «${t.title}»`}>
              <Cover src={t.cover} seed={t.album + t.album_artist} size={96} rounded="rounded-md" className="size-11 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold">{t.title}</span>
                <span className="block truncate text-[13px] opacity-70">{t.artist}</span>
              </span>
            </button>
            <span className="num text-[13px] opacity-60">{formatTime(t.duration)}</span>
            <button
              aria-label="Убрать из очереди"
              onClick={() => player.removeAt(i)}
              className="flex size-8 items-center justify-center rounded-full opacity-50 hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-70"
            >
              <X className="size-4" />
            </button>
            <GripVertical className="hidden size-4 cursor-grab opacity-40 sm:block" />
          </div>
        );
      })}
    </div>
  );
}

function Lyrics({ trackId }: { trackId: number }) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  const time = usePlayer((s) => s.time);
  const box = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(0);
  useEffect(() => {
    let alive = true;
    setText(undefined);
    api.library
      .lyrics(trackId)
      .then((r) => alive && setText(r.lyrics))
      .catch(() => alive && setText(null));
    return () => {
      alive = false;
    };
  }, [trackId]);
  const parsed = useMemo(() => (text ? parseLyrics(text) : null), [text]);
  const activeIdx =
    parsed?.synced ? parsed.lines.reduce((acc, l, i) => (l.at !== null && l.at <= time + 0.15 ? i : acc), -1) : -1;

  // текущая строка — в центре (если пользователь сам не листает последние 4 секунды)
  useEffect(() => {
    if (activeIdx < 0 || Date.now() - userScrolled.current < 4000) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-line="${activeIdx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx]);

  if (text === undefined) return <p className="py-10 text-center text-sm opacity-70">Загрузка…</p>;
  if (!text || !parsed)
    return (
      <p className="px-4 py-10 text-center text-sm leading-relaxed opacity-70">
        Текста нет. Его можно добавить в редакторе тегов или положить рядом с файлом .lrc с тем же именем — тогда строки
        будут подсвечиваться в такт.
      </p>
    );
  return (
    <div
      ref={box}
      onWheel={() => (userScrolled.current = Date.now())}
      onTouchMove={() => (userScrolled.current = Date.now())}
      className="flex flex-col gap-3 px-2 py-[30%]"
    >
      {parsed.lines.map((l, i) => (
        <p
          key={i}
          data-line={i}
          onClick={() => {
            if (l.at === null) return;
            userScrolled.current = 0;
            player.seek(l.at);
          }}
          className={cn(
            "origin-left text-xl leading-snug font-extrabold transition-all duration-300 sm:text-2xl",
            parsed.synced
              ? i === activeIdx
                ? "scale-[1.03] opacity-100"
                : i < activeIdx
                  ? "opacity-30"
                  : "opacity-45"
              : "opacity-90",
            l.at !== null && "cursor-pointer hover:opacity-80",
          )}
        >
          {l.text || "♪"}
        </p>
      ))}
    </div>
  );
}

// ---------- полноэкранный плеер ----------

export function NowPlaying({ open, onClose }: { open: boolean; onClose: () => void }) {
  const track = useCurrentTrack();
  const [tab, setTab] = useState<"queue" | "lyrics">("queue");
  const [panelOpen, setPanelOpen] = useState(false);
  const [eqOpen, setEqOpen] = useState(false);
  const palette = usePalette(coverUrl(track?.cover, 96), track ? track.album + track.album_artist : "x");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  useEffect(() => {
    const onErr = (e: Event) => toast.error(`Не удалось воспроизвести «${(e as CustomEvent).detail ?? "трек"}»`);
    window.addEventListener("sm:player-error", onErr);
    return () => window.removeEventListener("sm:player-error", onErr);
  }, []);

  if (!open || !track) return null;

  const panel = (
    <section
      aria-label="Очередь и текст"
      className="flex min-h-0 flex-1 flex-col gap-3 rounded-3xl border border-white/10 bg-black/25 p-3 backdrop-blur-xl lg:max-h-[640px] lg:p-4"
    >
      <div role="tablist" className="flex gap-1 rounded-full bg-white/8 p-1">
        {(
          [
            ["queue", "Очередь", ListMusic],
            ["lyrics", "Текст", TextQuote],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "flex h-10 flex-1 items-center justify-center gap-2 rounded-full text-sm font-bold transition",
              tab === id ? "bg-white text-[#0d0d0f]" : "text-white/75 hover:text-white",
            )}
          >
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === "queue" ? <QueueList /> : <Lyrics trackId={track.id} />}</div>
    </section>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Сейчас играет"
      className="animate-sheet-up fixed inset-0 z-[70] isolate flex flex-col overflow-hidden text-white"
      style={{ background: `color-mix(in srgb, ${palette[0]} 22%, #0b0a0c)` }}
    >
      <Ambient colors={palette} intensity={2.4} />
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-black/10 via-black/25 to-black/60" />

      <header className="flex items-center justify-between gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-2 sm:px-8">
        <button aria-label="Свернуть" onClick={onClose} className="flex size-11 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
          <ChevronDown />
        </button>
        <div className="min-w-0 text-center">
          <div className="text-[11px] font-bold tracking-[0.1em] text-white/70 uppercase">Из альбома</div>
          <Link to={`/albums/${track.album_id}`} onClick={onClose} className="block truncate text-sm font-bold hover:underline">
            {track.album}
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <button
            aria-label="Эквалайзер"
            onClick={() => setEqOpen(true)}
            className="flex size-11 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
          >
            <SlidersHorizontal className="size-5" />
          </button>
          <TrackMenuButton
            track={track}
            className="flex size-11 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          />
        </div>
      </header>
      <EqualizerDialog open={eqOpen} onClose={() => setEqOpen(false)} />

      <div className="flex min-h-0 flex-1 flex-col gap-6 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-10 lg:flex-row lg:items-stretch lg:gap-12 lg:px-14 lg:pb-10">
        <div className={cn("flex min-h-0 flex-1 flex-col justify-center gap-6 lg:max-w-[560px]", panelOpen && "hidden lg:flex")}>
          <div className="mx-auto w-full max-w-[min(520px,46svh)]">
            <Cover
              src={track.cover}
              seed={track.album + track.album_artist}
              size={900}
              rounded="rounded-[22px]"
              className="shadow-[0_40px_80px_rgba(0,0,0,0.5)]"
            />
          </div>
          <div className="mx-auto flex w-full max-w-[520px] flex-col gap-5">
            <div className="flex items-end justify-between gap-4">
              <div className="min-w-0">
                <h2 className="title-display truncate text-2xl sm:text-[32px]">{track.title}</h2>
                {track.artist_id ? (
                  <Link to={`/artists/${track.artist_id}`} onClick={onClose} className="mt-1.5 block truncate text-[17px] text-white/75 hover:text-white">
                    {track.artist}
                  </Link>
                ) : (
                  <div className="mt-1.5 truncate text-[17px] text-white/75">{track.artist}</div>
                )}
              </div>
              <FavButton className="size-12 text-white [&_svg]:size-6" />
            </div>
            <div className="[--accent:#fff] [--faint:rgb(255_255_255/0.7)] [--fg:#fff] [--surface-3:rgb(255_255_255/0.18)]">
              <Seekbar big />
              <div className="mt-1 flex justify-center">
                <span className="rounded-md border border-white/25 px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-white/80">{track.quality}</span>
              </div>
            </div>
            <div className="[--accent-ink:#fff] [--fg:#fff] [--muted:rgb(255_255_255/0.75)]">
              <Transport big />
            </div>
            <div className="flex justify-center gap-2 lg:hidden">
              <button
                onClick={() => {
                  setTab("queue");
                  setPanelOpen(true);
                }}
                className="flex h-10 items-center gap-2 rounded-full bg-white/10 px-4 text-sm font-bold"
              >
                <ListMusic className="size-4" /> Очередь
              </button>
              <button
                onClick={() => {
                  setTab("lyrics");
                  setPanelOpen(true);
                }}
                className="flex h-10 items-center gap-2 rounded-full bg-white/10 px-4 text-sm font-bold"
              >
                <TextQuote className="size-4" /> Текст
              </button>
            </div>
          </div>
        </div>
        <div className={cn("min-h-0 flex-1 flex-col lg:flex lg:max-w-[520px] lg:justify-center", panelOpen ? "flex" : "hidden")}>
          <button onClick={() => setPanelOpen(false)} className="mb-3 flex h-10 items-center gap-2 self-start rounded-full bg-white/10 px-4 text-sm font-bold lg:hidden">
            <ChevronDown className="size-4" /> К обложке
          </button>
          {panel}
        </div>
      </div>
    </div>
  );
}
