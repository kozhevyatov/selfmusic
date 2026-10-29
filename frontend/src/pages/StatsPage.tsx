import { useState, type ReactNode } from "react";
import { AlbumCard, CardGrid } from "@/components/Cards";
import { Avatar, Cover } from "@/components/Cover";
import { PlayFill } from "@/components/icon";
import { CalendarDays, ChartColumn, Clock, Flame, Repeat, Sparkles, Trophy, Users } from "@/components/icons";
import { PageHeader, Section } from "@/components/Section";
import { Empty, ErrorBox, PageLoader } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/switch";
import { WrappedStory } from "@/components/WrappedStory";
import { playArtist } from "@/lib/actions";
import { api, type StatsPeriod, type StatsResult } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { player } from "@/lib/player";
import { useQuery } from "@/lib/query";
import { Link, setSearchParam, useSearchParams } from "@/lib/router";
import {
  dayLabel,
  delta,
  hoursLabel,
  listenerPersona,
  MONTHS_SHORT,
  moodOf,
  nf,
  periodTitle,
  playsLabel,
  WEEKDAYS_SHORT,
} from "@/lib/stats";
import { cn, plural } from "@/lib/utils";

function Panel({ title, icon, children, className }: { title?: string; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("glass flex min-w-0 flex-col gap-4 rounded-3xl border p-5 sm:p-6", className)}>
      {title && (
        <h2 className="flex items-center gap-2 text-[17px] font-extrabold">
          {icon && <span className="text-accent-ink [&>svg]:size-[18px]">{icon}</span>}
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

function Tile({ value, label, change }: { value: string; label: string; change?: number | null }) {
  return (
    <div className="glass flex min-w-0 flex-col gap-1 rounded-2xl border px-4 py-3.5">
      <div className="num truncate font-display text-2xl font-semibold tracking-tight sm:text-[28px]">{value}</div>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted">
        {label}
        {change != null && change !== 0 && (
          <span className={cn("num font-bold", change > 0 ? "text-success" : "text-faint")}>
            {change > 0 ? "+" : ""}
            {change}%
          </span>
        )}
      </div>
    </div>
  );
}

/** Столбики: шкала по месяцам/дням, часы, дни недели. */
function Bars({
  values,
  labels,
  titles,
  highlight,
  height = "h-36",
  every = 1,
}: {
  values: number[];
  labels: string[];
  titles: string[];
  highlight?: number;
  height?: string;
  every?: number;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex flex-col gap-2">
      <div className={cn("flex items-end gap-[3px] sm:gap-1", height)}>
        {values.map((v, i) => (
          <div key={i} title={titles[i]} className="group relative flex h-full min-w-0 flex-1 items-end">
            <div
              className={cn(
                "w-full rounded-t-[4px] rounded-b-[2px] transition-[height] duration-500",
                v === 0 ? "bg-surface-3/70" : i === highlight ? "bg-accent" : "bg-accent/45 group-hover:bg-accent/70",
              )}
              style={{ height: `${v ? Math.max(4, (v / max) * 100) : 2}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-[3px] sm:gap-1">
        {labels.map((l, i) => (
          <div key={i} className="num min-w-0 flex-1 text-center text-[11px] text-faint">
            {i % every === 0 ? l : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function Timeline({ data }: { data: StatsResult }) {
  const values = data.timeline.map((t) => t.seconds);
  const peak = values.indexOf(Math.max(...values));
  let labels: string[];
  let titles: string[];
  if (data.scale === "month") {
    labels = data.timeline.map((t) => MONTHS_SHORT[Number(t.key.slice(5, 7)) - 1]);
    titles = data.timeline.map((t, i) => `${MONTHS_SHORT[i]}: ${hoursLabel(t.seconds)}`);
  } else if (data.scale === "day") {
    labels = data.timeline.map((t) => (data.timeline.length <= 7 ? WEEKDAYS_SHORT[(new Date(t.key + "T12:00").getDay() + 6) % 7] : String(Number(t.key.slice(8)))));
    titles = data.timeline.map((t) => `${dayLabel(t.key)}: ${hoursLabel(t.seconds)}`);
  } else {
    labels = data.timeline.map((t) => t.key);
    titles = data.timeline.map((t) => `${t.key}: ${hoursLabel(t.seconds)}`);
  }
  return (
    <Panel title="Сколько слушал" icon={<ChartColumn />}>
      <Bars values={values} labels={labels} titles={titles} highlight={peak} every={data.timeline.length > 14 ? 5 : 1} />
      {values[peak] > 0 && (
        <p className="text-[13px] text-muted">
          Пик —{" "}
          <b className="text-fg">
            {data.scale === "month" ? MONTHS_SHORT[peak] : data.scale === "day" ? dayLabel(data.timeline[peak].key) : data.timeline[peak].key}
          </b>
          , {hoursLabel(values[peak])} музыки
        </p>
      )}
    </Panel>
  );
}

function TopArtists({ data }: { data: StatsResult }) {
  const [first, ...rest] = data.top_artists;
  if (!first) return null;
  const max = first.plays;
  return (
    <Panel title="Исполнители" icon={<Trophy />}>
      <Link to={`/artists/${first.id}`} className="group relative flex items-center gap-4 overflow-hidden rounded-2xl bg-surface-2/70 p-3 pr-4">
        <div className="w-20 shrink-0 sm:w-28">
          {first.cover ? (
            <Cover src={first.cover} seed={first.name} size={300} rounded="rounded-full" />
          ) : (
            <Avatar name={first.name} className="aspect-square size-full font-display text-3xl" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="label-caps text-accent-ink">№1 {periodTitle(data.kind, data.year)}</div>
          <div className="title-display mt-1 line-clamp-2 text-2xl break-words sm:text-3xl">{first.name}</div>
          <div className="mt-1 text-[13px] text-muted">
            {playsLabel(first.plays)} · {hoursLabel(first.seconds)}
          </div>
        </div>
        <button
          aria-label={`Слушать ${first.name}`}
          onClick={(e) => {
            e.preventDefault();
            playArtist(first.id, true);
          }}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg shadow-lg transition hover:scale-105 sm:size-12"
        >
          <PlayFill className="size-5" />
        </button>
      </Link>
      <ol className="flex flex-col">
        {rest.map((a, i) => (
          <li key={a.id}>
            <Link to={`/artists/${a.id}`} className="flex items-center gap-3 rounded-xl px-1.5 py-1.5 hover:bg-surface-2/60">
              <span className="num w-5 shrink-0 text-right text-sm font-bold text-faint">{i + 2}</span>
              <span className="size-10 shrink-0">
                {a.cover ? <Cover src={a.cover} seed={a.name} size={120} rounded="rounded-full" /> : <Avatar name={a.name} className="size-10" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold">{a.name}</span>
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <span className="block h-full rounded-full bg-accent/70" style={{ width: `${(a.plays / max) * 100}%` }} />
                </span>
              </span>
              <span className="num w-12 shrink-0 text-right text-[13px] text-muted">{nf(a.plays)}</span>
            </Link>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function TopTracks({ data }: { data: StatsResult }) {
  if (!data.top_tracks.length) return null;
  return (
    <Panel title="Треки" icon={<Repeat />}>
      <ol className="flex flex-col">
        {data.top_tracks.map((t, i) => (
          <li key={t.id}>
            <button
              onClick={() => player.play(data.top_tracks, i)}
              className="group flex w-full items-center gap-3 rounded-xl px-1.5 py-1.5 text-left hover:bg-surface-2/60"
            >
              <span className={cn("num w-5 shrink-0 text-right text-sm font-bold", i === 0 ? "text-accent-ink" : "text-faint")}>{i + 1}</span>
              <span className="relative size-11 shrink-0">
                <Cover src={t.cover} seed={t.album + t.album_artist} size={120} rounded="rounded-lg" />
                <span className="absolute inset-0 hidden items-center justify-center rounded-lg bg-black/45 text-white group-hover:flex">
                  <PlayFill className="size-4" />
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold">{t.title}</span>
                <span className="block truncate text-[13px] text-muted">{t.artist}</span>
              </span>
              <span className="num shrink-0 text-[13px] text-muted">
                {nf(t.plays)} <span className="text-faint">×</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function Genres({ data }: { data: StatsResult }) {
  if (!data.genres.length) return null;
  const max = data.genres[0].plays;
  return (
    <Panel title="Жанры" icon={<Sparkles />}>
      <div className="flex flex-col gap-2.5">
        {data.genres.map((g, i) => (
          <div key={g.name} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3 text-[14px]">
              <span className={cn("truncate font-semibold", i === 0 && "text-accent-ink")}>{g.name}</span>
              <span className="num shrink-0 text-[13px] text-muted">{Math.round(g.share * 100)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-3">
              <div className={cn("h-full rounded-full", i === 0 ? "bg-accent" : "bg-accent/50")} style={{ width: `${(g.plays / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Rhythm({ data }: { data: StatsResult }) {
  const persona = listenerPersona(data.hours);
  const wdMax = data.weekdays.indexOf(Math.max(...data.weekdays));
  return (
    <Panel title="Когда слушаешь" icon={<Clock />}>
      {persona && (
        <div>
          <div className="title-display text-2xl">{persona.title}</div>
          <p className="mt-1 text-[14px] text-muted">
            {persona.text} Чаще всего музыка звучит около <b className="text-fg">{persona.peak}:00</b>.
          </p>
        </div>
      )}
      <Bars
        values={data.hours}
        labels={data.hours.map((_, h) => String(h))}
        titles={data.hours.map((v, h) => `${h}:00–${h}:59 · ${hoursLabel(v)}`)}
        highlight={persona?.peak}
        height="h-24"
        every={3}
      />
      <div className="pt-1">
        <div className="mb-2 text-[13px] text-muted">По дням недели</div>
        <Bars
          values={data.weekdays}
          labels={WEEKDAYS_SHORT}
          titles={data.weekdays.map((v, i) => `${WEEKDAYS_SHORT[i]} · ${hoursLabel(v)}`)}
          highlight={wdMax}
          height="h-16"
        />
      </div>
    </Panel>
  );
}

function SoundMap({ data }: { data: StatsResult }) {
  const s = data.sound;
  if (!s) return null;
  const mood = moodOf(s);
  const pos = (e: number, v: number) => ({ left: `${Math.min(96, Math.max(4, e * 100))}%`, bottom: `${Math.min(96, Math.max(4, v * 100))}%` });
  return (
    <Panel title="Звучание" icon={<Flame />}>
      <div>
        <div className="title-display text-2xl">{mood.title}</div>
        <p className="mt-1 text-[14px] text-muted">
          {mood.text} Твоя музыка {mood.compare}
          {s.bpm ? `, средний темп — ${s.bpm} уд/мин` : ""}.
        </p>
      </div>
      <div className="flex items-stretch gap-2">
        <div className="flex w-4 items-center justify-center">
          <span className="-rotate-90 text-[11px] whitespace-nowrap text-faint">грустно → радостно</span>
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="relative aspect-[16/10] overflow-hidden rounded-2xl border bg-surface-2/60">
            <div className="absolute inset-0 bg-[linear-gradient(to_right,transparent_49.5%,var(--color-line)_49.5%,var(--color-line)_50.5%,transparent_50.5%),linear-gradient(to_top,transparent_49.5%,var(--color-line)_49.5%,var(--color-line)_50.5%,transparent_50.5%)]" />
            <span className="absolute top-2 left-3 text-[11px] text-faint">спокойно и светло</span>
            <span className="absolute top-2 right-3 text-[11px] text-faint">драйв</span>
            <span className="absolute bottom-2 left-3 text-[11px] text-faint">меланхолия</span>
            <span className="absolute right-3 bottom-2 text-[11px] text-faint">напор</span>
            <span
              title="Вся библиотека в среднем"
              className="absolute size-4 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-dashed border-muted"
              style={pos(s.library_energy, s.library_valence)}
            />
            <span className="absolute -translate-x-1/2 translate-y-1/2" style={pos(s.energy, s.valence)} title="Ты">
              <span className="absolute inset-0 animate-ping rounded-full bg-accent/40" />
              <span className="relative block size-4 rounded-full bg-accent shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-accent)_30%,transparent)]" />
            </span>
          </div>
          <div className="text-center text-[11px] text-faint">спокойно → энергично</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-[12px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-accent" /> ты
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full border border-dashed border-muted" /> вся библиотека
        </span>
      </div>
    </Panel>
  );
}

function Highlights({ data }: { data: StatsResult }) {
  const h = data.highlights;
  const items: { icon: ReactNode; title: string; text: ReactNode; onClick?: () => void }[] = [];
  if (h.streak > 1)
    items.push({
      icon: <Flame />,
      title: `${h.streak} ${plural(h.streak, "день", "дня", "дней")} подряд`,
      text: <>самая длинная серия без перерыва{h.streak_end ? `, до ${dayLabel(h.streak_end)}` : ""}</>,
    });
  if (h.top_day)
    items.push({
      icon: <CalendarDays />,
      title: dayLabel(h.top_day.date),
      text: (
        <>
          самый музыкальный день — {hoursLabel(h.top_day.seconds)}, {playsLabel(h.top_day.plays)}
        </>
      ),
    });
  if (h.repeat)
    items.push({
      icon: <Repeat />,
      title: `«${h.repeat.track.title}»`,
      text: (
        <>
          на повторе: {h.repeat.count} раз за {dayLabel(h.repeat.date)}
        </>
      ),
      onClick: () => player.play([h.repeat!.track]),
    });
  if (data.totals.new_artists > 0)
    items.push({
      icon: <Sparkles />,
      title: `${nf(data.totals.new_artists)} ${plural(data.totals.new_artists, "открытие", "открытия", "открытий")}`,
      text: <>исполнители, которых ты раньше не слушал</>,
    });
  if (h.first && data.kind === "year")
    items.push({
      icon: <PlayFill />,
      title: `«${h.first.track.title}»`,
      text: <>первый трек {data.year ?? ""} года — {h.first.track.artist}</>,
      onClick: () => player.play([h.first!.track]),
    });
  if (!items.length) return null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((it, i) => {
        const Tag = it.onClick ? "button" : "div";
        return (
          <Tag
            key={i}
            onClick={it.onClick}
            className={cn("glass flex min-w-0 items-start gap-3 rounded-2xl border p-4 text-left", it.onClick && "transition hover:bg-surface-2/60")}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent-ink [&>svg]:size-5">{it.icon}</span>
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-bold">{it.title}</span>
              <span className="block text-[13px] text-muted">{it.text}</span>
            </span>
          </Tag>
        );
      })}
    </div>
  );
}

function UsersBoard({ data }: { data: StatsResult }) {
  if (!data.users?.length) return null;
  const max = data.users[0].seconds || 1;
  return (
    <Panel title="Слушатели сервера" icon={<Users />}>
      {data.users.map((u) => (
        <div key={u.id} className="flex items-center gap-3">
          <Avatar name={u.name} src={u.avatar} className="size-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex justify-between gap-3 text-[14px]">
              <span className="truncate font-semibold">{u.name}</span>
              <span className="num shrink-0 text-muted">{hoursLabel(u.seconds)}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent/70" style={{ width: `${(u.seconds / max) * 100}%` }} />
            </div>
          </div>
        </div>
      ))}
    </Panel>
  );
}

function WrappedHero({ data, onOpen }: { data: StatsResult; onOpen: () => void }) {
  const covers = data.top_artists.filter((a) => a.cover).slice(0, 4);
  const year = data.year ?? new Date().getFullYear();
  return (
    <div className="relative isolate overflow-hidden rounded-3xl border bg-[#140d1f] p-6 text-white sm:p-8">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(70% 90% at 0% 0%, #ff6b3d 0%, transparent 60%), radial-gradient(60% 80% at 100% 100%, #7b3dff 0%, transparent 65%), radial-gradient(50% 60% at 80% 10%, #ff3d8b 0%, transparent 60%)",
          opacity: 0.85,
        }}
      />
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-[13px] font-bold tracking-[0.18em] text-white/75 uppercase">Твой год в музыке</div>
          <div className="mt-1 font-display text-6xl leading-none font-semibold tracking-[-0.04em] sm:text-7xl">Итоги {year}</div>
          <p className="mt-3 max-w-md text-[15px] text-white/85">
            {hoursLabel(data.totals.seconds)} музыки, {nf(data.totals.artists)}{" "}
            {plural(data.totals.artists, "исполнитель", "исполнителя", "исполнителей")} и{" "}
            {data.top_artists[0] ? `главный голос года — ${data.top_artists[0].name}` : "много открытий"}.
          </p>
          <button
            onClick={onOpen}
            className="mt-5 flex h-12 items-center gap-2 rounded-full bg-white px-6 text-[15px] font-extrabold text-black shadow-xl transition hover:scale-[1.03]"
          >
            <PlayFill className="size-4" /> Смотреть итоги
          </button>
        </div>
        {covers.length > 0 && (
          <div className="flex shrink-0 -space-x-6 self-start sm:self-auto">
            {covers.map((a, i) => (
              <div
                key={a.id}
                className="w-20 rounded-full ring-4 ring-[#140d1f]/60 sm:w-28"
                style={{ transform: `rotate(${(i - 1.5) * 6}deg)`, zIndex: covers.length - i }}
              >
                <Cover src={a.cover} seed={a.name} size={240} rounded="rounded-full" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const currentYear = () => new Date().getFullYear();
/** Годы для выбора: текущий (даже если в нём ещё ничего не слушали) и все, где есть история. */
function yearChips(d: StatsResult): number[] {
  return [...new Set([currentYear(), ...d.years, ...(d.year ? [d.year] : [])])].sort((a, b) => b - a);
}

const PERIODS: { value: StatsPeriod; label: string }[] = [
  { value: "week", label: "Неделя" },
  { value: "month", label: "Месяц" },
  { value: "year", label: "Год" },
  { value: "all", label: "Всё время" },
];

export default function StatsPage() {
  const { user } = useAuth();
  const params = useSearchParams();
  const period = (params.get("period") as StatsPeriod) || "year";
  const year = params.get("year") ? Number(params.get("year")) : null;
  const scope = user?.is_admin && params.get("scope") === "server" ? "server" : "me";
  const q = useQuery(["stats", period, year, scope], () => api.library.stats({ period, year, scope }), { staleTime: 60_000 });
  const [story, setStory] = useState(false);
  const d = q.data;

  const prev = d?.previous;
  const empty = d && d.totals.plays === 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Статистика" subtitle={d ? `${periodTitle(d.kind, d.year)}${scope === "server" ? " · весь сервер" : ""}` : undefined} />

      <div className="flex flex-wrap items-center gap-3">
        <div className="scrollbar-none -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <Segmented<StatsPeriod>
            label="Период"
            value={period}
            onChange={(p) => {
              setSearchParam("year", null);
              setSearchParam("period", p);
            }}
            className="w-max flex-nowrap"
            options={PERIODS}
          />
        </div>
        {period === "year" && d && yearChips(d).length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {yearChips(d).map((y) => {
              const active = d.year === y;
              return (
                <button
                  key={y}
                  onClick={() => setSearchParam("year", y === currentYear() ? null : String(y))}
                  className={cn(
                    "num h-9 rounded-full border px-3.5 text-[13px] font-bold transition",
                    active ? "border-transparent bg-accent text-accent-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {y}
                </button>
              );
            })}
          </div>
        )}
        {user?.is_admin && (
          <Segmented<"me" | "server">
            label="Чья статистика"
            value={scope}
            onChange={(s) => setSearchParam("scope", s === "server" ? "server" : null)}
            className="flex-nowrap sm:ml-auto"
            options={[
              { value: "me", label: "Моя" },
              { value: "server", label: "Весь сервер" },
            ]}
          />
        )}
      </div>

      {q.isLoading ? (
        <PageLoader />
      ) : q.error || !d ? (
        <ErrorBox error={q.error} />
      ) : empty ? (
        <Empty
          icon={<ChartColumn />}
          title="Пока нечего считать"
          text="Статистика появится, когда ты послушаешь музыку: трек засчитывается после половины или 4 минут."
        />
      ) : (
        <>
          {d.kind === "year" && scope === "me" && d.totals.plays >= 10 && <WrappedHero data={d} onOpen={() => setStory(true)} />}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1">
            <Tile value={hoursLabel(d.totals.seconds)} label="музыки" change={delta(d.totals.seconds, prev?.seconds)} />
            <Tile value={nf(d.totals.plays)} label={plural(d.totals.plays, "прослушивание", "прослушивания", "прослушиваний")} change={delta(d.totals.plays, prev?.plays)} />
            <Tile value={nf(d.totals.artists)} label={plural(d.totals.artists, "исполнитель", "исполнителя", "исполнителей")} />
            <Tile value={nf(d.totals.tracks)} label={plural(d.totals.tracks, "трек", "трека", "треков")} />
            <Tile value={nf(d.totals.days)} label={plural(d.totals.days, "день с музыкой", "дня с музыкой", "дней с музыкой")} />
          </div>

          <Highlights data={d} />

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <TopArtists data={d} />
            <TopTracks data={d} />
          </div>

          {d.top_albums.length > 0 && (
            <Section title="Альбомы">
              <CardGrid row>
                {d.top_albums.map((a) => (
                  <AlbumCard key={a.id} album={a} subtitle={`${a.artist} · ${nf(a.plays)} ×`} />
                ))}
              </CardGrid>
            </Section>
          )}

          <Timeline data={d} />

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
            <Rhythm data={d} />
            <Genres data={d} />
            {d.sound ? <SoundMap data={d} /> : <UsersBoard data={d} />}
          </div>
          {d.sound && <UsersBoard data={d} />}

          <p className="text-center text-[12px] text-faint">
            Трек засчитывается, если дослушан до половины или до 4 минут. Время — сумма длительностей засчитанных треков.
          </p>
        </>
      )}

      {story && d && <WrappedStory data={d} onClose={() => setStory(false)} />}
    </div>
  );
}
