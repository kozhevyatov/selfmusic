import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Avatar, Cover } from "@/components/Cover";
import { PlayFill } from "@/components/icon";
import { X } from "@/components/icons";
import { playArtist } from "@/lib/actions";
import { coverUrl, type StatsResult } from "@/lib/api";
import { usePalette } from "@/lib/colors";
import { player } from "@/lib/player";
import { dayLabel, delta, listenerPersona, minutes, moodOf, nf, playsLabel } from "@/lib/stats";
import { cn, plural } from "@/lib/utils";

const DURATION = 7000;

type Slide = { key: string; bg: string; node: ReactNode };

function Big({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("story-in font-display leading-[0.92] font-semibold tracking-[-0.045em]", className)}>{children}</div>;
}
function Kicker({ children }: { children: ReactNode }) {
  return <div className="story-in text-[13px] font-bold tracking-[0.18em] text-white/70 uppercase">{children}</div>;
}
function Text({ children, delay = 1 }: { children: ReactNode; delay?: number }) {
  return (
    <p className="story-in text-[17px] leading-snug text-white/85" style={{ animationDelay: `${delay * 120}ms` }}>
      {children}
    </p>
  );
}
function PlayBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      data-story-action
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="story-in flex h-12 w-max items-center gap-2 rounded-full bg-white px-6 text-[15px] font-extrabold text-black shadow-xl transition hover:scale-[1.03]"
      style={{ animationDelay: "480ms" }}
    >
      <PlayFill className="size-4" /> {label}
    </button>
  );
}

function grad(a: string, b: string, c = "#0d0b12") {
  return `radial-gradient(90% 70% at 10% 0%, ${a} 0%, transparent 65%), radial-gradient(80% 70% at 100% 100%, ${b} 0%, transparent 60%), ${c}`;
}

export function WrappedStory({ data, onClose }: { data: StatsResult; onClose: () => void }) {
  const year = data.year ?? new Date().getFullYear();
  const top = data.top_artists[0];
  const track = data.top_tracks[0];
  const artistPal = usePalette(coverUrl(top?.cover, 96), top?.name ?? "a");
  const trackPal = usePalette(coverUrl(track?.cover, 96), track?.title ?? "t");

  const slides = useMemo<Slide[]>(() => {
    const out: Slide[] = [];
    const t = data.totals;
    out.push({
      key: "intro",
      bg: grad("#ff6b3d", "#7b3dff", "#130d1c"),
      node: (
        <>
          <Kicker>SelfMusic · итоги</Kicker>
          <Big className="text-[clamp(96px,32vw,200px)]">{year}</Big>
          <Text>Твой год в музыке: кого слушал, что ставил на повтор и каким он был по звучанию.</Text>
          <Text delay={3}>
            <span className="text-[14px] text-white/60">Нажимай справа, чтобы листать →</span>
          </Text>
        </>
      ),
    });

    const mins = minutes(t.seconds);
    const ch = delta(t.seconds, data.previous?.seconds);
    out.push({
      key: "minutes",
      bg: grad("#ff3d8b", "#ffb03d", "#1a0b12"),
      node: (
        <>
          <Kicker>Ты слушал музыку</Kicker>
          <Big className="text-[clamp(72px,22vw,150px)]">{nf(mins)}</Big>
          <Big className="text-4xl">{plural(mins, "минуту", "минуты", "минут")}</Big>
          <Text>
            Это {nf(Math.round(t.seconds / 3600))} {plural(Math.round(t.seconds / 3600), "час", "часа", "часов")} — или{" "}
            {(t.seconds / 86400).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} суток без перерыва.
          </Text>
          <Text delay={2}>
            Музыка звучала {nf(t.days)} {plural(t.days, "день", "дня", "дней")} из {year % 4 === 0 ? 366 : 365}
            {ch != null && Math.abs(ch) >= 5 ? `, на ${Math.abs(ch)}% ${ch > 0 ? "больше" : "меньше"}, чем годом раньше` : ""}.
          </Text>
        </>
      ),
    });

    if (top) {
      const share = t.plays ? Math.round((top.plays / t.plays) * 100) : 0;
      out.push({
        key: "artist",
        bg: grad(artistPal[0], artistPal[1]),
        node: (
          <>
            <Kicker>Исполнитель года</Kicker>
            <div className="story-in w-[min(62vw,300px)]" style={{ animationDelay: "80ms" }}>
              {top.cover ? (
                <Cover src={top.cover} seed={top.name} size={600} rounded="rounded-full" className="shadow-[0_30px_80px_rgba(0,0,0,0.5)]" />
              ) : (
                <Avatar name={top.name} className="aspect-square size-full font-display text-6xl" />
              )}
            </div>
            <Big className="text-[clamp(44px,12vw,84px)]">{top.name}</Big>
            <Text>
              {playsLabel(top.plays)} и {nf(minutes(top.seconds))} {plural(minutes(top.seconds), "минута", "минуты", "минут")}
              {share >= 3 ? ` — ${share}% всего, что ты слушал` : ""}.
            </Text>
            <PlayBtn label="Слушать" onClick={() => playArtist(top.id, true)} />
          </>
        ),
      });
    }

    if (data.top_artists.length >= 3) {
      out.push({
        key: "artists",
        bg: grad("#3d7bff", "#3dffc8", "#0b1219"),
        node: (
          <>
            <Kicker>Твоя пятёрка</Kicker>
            <ol className="flex flex-col gap-3">
              {data.top_artists.slice(0, 5).map((a, i) => (
                <li key={a.id} className="story-in flex items-center gap-4" style={{ animationDelay: `${i * 110}ms` }}>
                  <span className="num w-8 font-display text-4xl font-semibold text-white/60">{i + 1}</span>
                  <span className="size-16 shrink-0">
                    {a.cover ? <Cover src={a.cover} seed={a.name} size={160} rounded="rounded-full" /> : <Avatar name={a.name} className="size-16 text-xl" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-2xl font-extrabold">{a.name}</span>
                    <span className="block text-[14px] text-white/70">{playsLabel(a.plays)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </>
        ),
      });
    }

    if (track) {
      out.push({
        key: "track",
        bg: grad(trackPal[0], trackPal[1]),
        node: (
          <>
            <Kicker>Трек года</Kicker>
            <div className="story-in w-[min(62vw,300px)]" style={{ animationDelay: "80ms" }}>
              <Cover src={track.cover} seed={track.album + track.album_artist} size={600} rounded="rounded-3xl" className="shadow-[0_30px_80px_rgba(0,0,0,0.5)]" />
            </div>
            <Big className="text-[clamp(40px,11vw,76px)]">{track.title}</Big>
            <Text>
              {track.artist} · ты включал его {nf(track.plays)} {plural(track.plays, "раз", "раза", "раз")}.
            </Text>
            <PlayBtn label="Включить" onClick={() => player.play(data.top_tracks, 0)} />
          </>
        ),
      });
    }

    if (data.top_tracks.length >= 3) {
      out.push({
        key: "tracks",
        bg: grad("#ff3d3d", "#7b3dff", "#170b14"),
        node: (
          <>
            <Kicker>Больше всего на повторе</Kicker>
            <ol className="flex flex-col gap-3">
              {data.top_tracks.slice(0, 5).map((tr, i) => (
                <li key={tr.id} className="story-in flex items-center gap-4" style={{ animationDelay: `${i * 110}ms` }}>
                  <span className="num w-8 font-display text-4xl font-semibold text-white/60">{i + 1}</span>
                  <span className="size-14 shrink-0">
                    <Cover src={tr.cover} seed={tr.album + tr.album_artist} size={140} rounded="rounded-xl" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xl font-extrabold">{tr.title}</span>
                    <span className="block truncate text-[14px] text-white/70">
                      {tr.artist} · {nf(tr.plays)}×
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            <PlayBtn label="Слушать топ треков" onClick={() => player.play(data.top_tracks, 0)} />
          </>
        ),
      });
    }

    if (data.genres.length) {
      const g = data.genres[0];
      out.push({
        key: "genres",
        bg: grad("#3dffa0", "#3d7bff", "#0a1512"),
        node: (
          <>
            <Kicker>Главный жанр</Kicker>
            <Big className="text-[clamp(52px,15vw,110px)]">{g.name}</Big>
            <Text>{Math.round(g.share * 100)}% всего, что ты слушал.</Text>
            <div className="flex flex-col gap-2.5 pt-2">
              {data.genres.slice(1, 5).map((x, i) => (
                <div key={x.name} className="story-in flex flex-col gap-1" style={{ animationDelay: `${300 + i * 100}ms` }}>
                  <div className="flex justify-between text-[15px] font-bold">
                    <span>{x.name}</span>
                    <span className="num text-white/70">{Math.round(x.share * 100)}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/15">
                    <div className="h-full rounded-full bg-white/85" style={{ width: `${(x.plays / g.plays) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </>
        ),
      });
    }

    const persona = listenerPersona(data.hours);
    if (persona) {
      out.push({
        key: "persona",
        bg: persona.key === "night" ? grad("#3d3dff", "#a03dff", "#06061a") : persona.key === "morning" ? grad("#ffd23d", "#ff8a3d", "#1a1206") : grad("#ff8a3d", "#ff3d8b", "#1a0b0b"),
        node: (
          <>
            <Kicker>Ты —</Kicker>
            <Big className="text-[clamp(52px,14vw,104px)]">{persona.title}</Big>
            <Text>{persona.text}</Text>
            <Text delay={2}>
              Пик — около <b>{persona.peak}:00</b>. {Math.round(persona.share * 100)}% музыки пришлось на это время суток.
            </Text>
            <div className="story-in flex h-24 items-end gap-1 pt-2" style={{ animationDelay: "360ms" }}>
              {data.hours.map((v, h) => (
                <div
                  key={h}
                  className={cn("flex-1 rounded-t-sm", h === persona.peak ? "bg-white" : "bg-white/35")}
                  style={{ height: `${Math.max(3, (v / Math.max(1, ...data.hours)) * 100)}%` }}
                />
              ))}
            </div>
          </>
        ),
      });
    }

    if (data.sound) {
      const m = moodOf(data.sound);
      out.push({
        key: "mood",
        bg: grad(data.sound.valence >= 0.5 ? "#ffcf3d" : "#3d8bff", data.sound.energy >= 0.55 ? "#ff3d3d" : "#3dd0ff", "#0d0d14"),
        node: (
          <>
            <Kicker>Звучание года</Kicker>
            <Big className="text-[clamp(52px,14vw,104px)]">{m.title}</Big>
            <Text>{m.text}</Text>
            <Text delay={2}>
              Твоя музыка {m.compare}
              {data.sound.bpm ? `, средний темп — ${data.sound.bpm} ударов в минуту` : ""}.
            </Text>
          </>
        ),
      });
    }

    const h = data.highlights;
    const facts: [string, string][] = [];
    if (h.streak > 1) facts.push([`${h.streak} ${plural(h.streak, "день", "дня", "дней")}`, "подряд с музыкой — самая длинная серия"]);
    if (h.top_day) facts.push([dayLabel(h.top_day.date), `самый музыкальный день: ${nf(minutes(h.top_day.seconds))} мин`]);
    if (h.repeat) facts.push([`${h.repeat.count} раз`, `«${h.repeat.track.title}» за один день — ${dayLabel(h.repeat.date)}`]);
    if (t.new_artists > 0) facts.push([nf(t.new_artists), `${plural(t.new_artists, "новый исполнитель", "новых исполнителя", "новых исполнителей")} в твоей жизни`]);
    if (facts.length) {
      out.push({
        key: "facts",
        bg: grad("#ff6b3d", "#3dffc8", "#120f0b"),
        node: (
          <>
            <Kicker>А ещё</Kicker>
            <div className="flex flex-col gap-5">
              {facts.map(([big, small], i) => (
                <div key={i} className="story-in" style={{ animationDelay: `${i * 140}ms` }}>
                  <div className="font-display text-5xl font-semibold tracking-[-0.04em]">{big}</div>
                  <div className="text-[16px] text-white/80">{small}</div>
                </div>
              ))}
            </div>
          </>
        ),
      });
    }

    out.push({
      key: "summary",
      bg: grad("#ff6b3d", "#7b3dff", "#100c16"),
      node: (
        <div className="story-in flex flex-col gap-5 rounded-3xl border border-white/15 bg-black/30 p-5 backdrop-blur-xl sm:p-7">
          <div className="flex items-end justify-between gap-3">
            <div className="font-display text-4xl font-semibold tracking-[-0.04em]">Итоги {year}</div>
            <div className="text-right text-[13px] text-white/70">SelfMusic</div>
          </div>
          {top?.cover && (
            <div className="flex -space-x-4">
              {data.top_artists.slice(0, 5).map((a) => (
                <div key={a.id} className="size-16 rounded-full ring-4 ring-black/40">
                  <Cover src={a.cover} seed={a.name} size={160} rounded="rounded-full" />
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-5">
            <div className="min-w-0">
              <div className="mb-1.5 text-[12px] font-bold tracking-[0.14em] text-white/60 uppercase">Исполнители</div>
              {data.top_artists.slice(0, 5).map((a, i) => (
                <div key={a.id} className="truncate text-[15px] font-bold">
                  <span className="num text-white/50">{i + 1}</span> {a.name}
                </div>
              ))}
            </div>
            <div className="min-w-0">
              <div className="mb-1.5 text-[12px] font-bold tracking-[0.14em] text-white/60 uppercase">Треки</div>
              {data.top_tracks.slice(0, 5).map((tr, i) => (
                <div key={tr.id} className="truncate text-[15px] font-bold">
                  <span className="num text-white/50">{i + 1}</span> {tr.title}
                </div>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-5">
            <div>
              <div className="text-[12px] font-bold tracking-[0.14em] text-white/60 uppercase">Минут</div>
              <div className="num font-display text-3xl font-semibold">{nf(minutes(t.seconds))}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-bold tracking-[0.14em] text-white/60 uppercase">Жанр</div>
              <div className="truncate font-display text-3xl font-semibold">{data.genres[0]?.name ?? "—"}</div>
            </div>
          </div>
          {data.top_tracks.length > 0 && <PlayBtn label="Слушать топ года" onClick={() => player.play(data.top_tracks, 0)} />}
        </div>
      ),
    });
    return out;
  }, [data, year, top, track, artistPal, trackPal]);

  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const paused = useRef(false);
  const last = useRef(performance.now());

  const go = useCallback(
    (d: number) => {
      setProgress(0);
      setIndex((i) => {
        const n = i + d;
        if (n >= slides.length) {
          onClose();
          return i;
        }
        return Math.max(0, n);
      });
    },
    [slides.length, onClose],
  );

  // таймер слайда; на последнем — стоим
  useEffect(() => {
    let raf = 0;
    last.current = performance.now();
    const tick = (now: number) => {
      const dt = now - last.current;
      last.current = now;
      if (!paused.current && index < slides.length - 1 && !document.hidden) {
        setProgress((p) => {
          const np = p + dt / DURATION;
          if (np >= 1) {
            queueMicrotask(() => go(1));
            return 1;
          }
          return np;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [index, slides.length, go]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, onClose]);

  const slide = slides[Math.min(index, slides.length - 1)];

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black text-white" role="dialog" aria-modal="true" aria-label={`Итоги ${year}`}>
      <div
        className="relative flex h-full w-full max-w-[520px] flex-col overflow-hidden transition-[background] duration-700 sm:my-6 sm:h-[calc(100%-3rem)] sm:max-h-[900px] sm:rounded-[28px]"
        style={{ background: slide.bg }}
        onPointerDown={() => (paused.current = true)}
        onPointerUp={() => (paused.current = false)}
        onPointerCancel={() => (paused.current = false)}
        onPointerLeave={() => (paused.current = false)}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-story-action]")) return;
          const rect = e.currentTarget.getBoundingClientRect();
          go(e.clientX - rect.left < rect.width * 0.3 ? -1 : 1);
        }}
      >
        <div className="flex gap-1 px-3 pt-[max(0.75rem,calc(var(--sat)+0.5rem))]">
          {slides.map((s, i) => (
            <div key={s.key} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/25">
              <div className="h-full bg-white" style={{ width: `${i < index ? 100 : i === index ? progress * 100 : 0}%` }} />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between px-4 pt-3">
          <span className="text-[13px] font-bold text-white/70">Итоги {year}</span>
          <button
            data-story-action
            aria-label="Закрыть"
            onClick={onClose}
            className="flex size-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
          >
            <X className="size-5" />
          </button>
        </div>
        <div key={slide.key} className="flex min-h-0 flex-1 flex-col justify-center gap-5 overflow-y-auto px-6 pb-[max(2rem,var(--sab))] sm:px-9">
          {slide.node}
        </div>
      </div>
    </div>
  );
}
