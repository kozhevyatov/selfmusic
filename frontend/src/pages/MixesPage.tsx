import { CardGrid } from "@/components/Cards";
import { PlayFill } from "@/components/icon";
import { Info, Shuffle } from "@/components/icons";
import { MixCover, MixTile } from "@/components/MixCover";
import { PageHeader, Section } from "@/components/Section";
import { ErrorBox, PageLoader } from "@/components/ui/misc";
import { api, type MixCard } from "@/lib/api";
import { formatDuration, tracksLabel } from "@/lib/format";
import { playTracksOf } from "@/lib/mixActions";
import { useQuery } from "@/lib/query";
import { Link } from "@/lib/router";

/** Большая карточка «Сейчас»: подборка под текущее время суток. */
export function NowMixHero({ mix, season }: { mix: MixCard; season?: MixCard | null }) {
  return (
    <div className="glass relative flex flex-col gap-5 overflow-hidden rounded-3xl border p-5 sm:flex-row sm:items-center sm:p-6">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 opacity-30"
        style={{ background: `radial-gradient(90% 120% at 0% 0%, ${mix.colors[0]}, transparent 70%)` }}
      />
      <Link to={`/mixes/${mix.key}`} className="w-28 shrink-0 sm:w-44">
        <MixCover mix={mix} />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <div className="label-caps">Сейчас звучит лучше всего</div>
          <Link to={`/mixes/${mix.key}`} className="title-display mt-1 block text-3xl hover:underline sm:text-4xl">
            {mix.title} подборка
          </Link>
          <p className="mt-1.5 text-sm text-muted">
            {mix.subtitle} · {tracksLabel(mix.track_count)} · {formatDuration(mix.duration)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => playTracksOf(mix.key)}
            className="flex h-12 items-center gap-2 rounded-full bg-accent px-6 font-bold text-accent-fg shadow-lg shadow-black/25 transition hover:scale-[1.03]"
          >
            <PlayFill className="size-5" /> Слушать
          </button>
          <button
            aria-label="Перемешать"
            onClick={() => playTracksOf(mix.key, true)}
            className="flex size-12 items-center justify-center rounded-full border text-muted transition hover:bg-surface-2 hover:text-fg"
          >
            <Shuffle className="size-5" />
          </button>
          {season && (
            <Link
              to={`/mixes/${season.key}`}
              className="flex h-12 items-center gap-2.5 rounded-full border pr-4 pl-1.5 text-sm font-bold text-muted transition hover:bg-surface-2 hover:text-fg"
            >
              <span
                className="size-9 rounded-full"
                style={{ background: `linear-gradient(140deg, ${season.colors[0]}, ${season.colors[1]})` }}
              />
              {season.title}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MixesPage() {
  const q = useQuery(["mixes"], api.library.mixes, { staleTime: 5 * 60_000 });
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const d = q.data;
  return (
    <div className="flex flex-col gap-9">
      <PageHeader title="Подборки" subtitle="Собираются каждый день из вашей музыки — под время суток, настроение и сезон" />
      {!d.analysis_ready && (
        <div className="flex gap-3 rounded-2xl border bg-surface-2/50 p-4 text-sm text-muted">
          <Info className="mt-0.5 size-4 shrink-0 text-accent-ink" />
          <span>
            Пока подборки собраны по жанрам. Сервер «прослушивает» треки в фоне (по умолчанию ночью) — после этого
            настроение и время суток будут угадываться точнее.
          </span>
        </div>
      )}
      {d.now && <NowMixHero mix={d.now} season={d.season} />}
      {d.groups.map((g) => (
        <Section key={g.key} title={g.title}>
          <CardGrid row>
            {g.items.map((m) => (
              <MixTile key={m.key} mix={m} />
            ))}
          </CardGrid>
        </Section>
      ))}
    </div>
  );
}
