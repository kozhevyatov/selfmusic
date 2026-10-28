import type { ComponentType } from "react";
import type { MixCard } from "@/lib/api";
import { playTracksOf } from "@/lib/mixActions";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import type { IconProps } from "./icon";
import { PlayFill } from "./icon";
import {
  Bed,
  CalendarDays,
  CloudRain,
  Flower,
  History,
  Leaf,
  Moon,
  Smile,
  Snowflake,
  Sparkles,
  Sun,
  Sunrise,
  Sunset,
  Target,
  Zap,
} from "./icons";

const ICONS: Record<string, ComponentType<IconProps>> = {
  sunrise: Sunrise,
  sun: Sun,
  sunset: Sunset,
  moon: Moon,
  zap: Zap,
  smile: Smile,
  leaf: Leaf,
  "cloud-rain": CloudRain,
  target: Target,
  bed: Bed,
  snowflake: Snowflake,
  flower: Flower,
  history: History,
  calendar: CalendarDays,
};

/** Обложка подборки: градиент её цветов, мягкие «капли», большая иконка и название. */
export function MixCover({ mix, size = "md", className }: { mix: Pick<MixCard, "title" | "icon" | "colors">; size?: "md" | "lg"; className?: string }) {
  const Icon = ICONS[mix.icon] ?? Sparkles;
  const [a, b] = mix.colors;
  return (
    <div
      className={cn("relative isolate aspect-square w-full overflow-hidden rounded-2xl shadow-lg shadow-black/25", className)}
      style={{ background: `linear-gradient(140deg, ${a}, ${b})` }}
    >
      <div
        aria-hidden="true"
        className="absolute -top-1/4 -right-1/4 -z-10 size-3/4 rounded-full opacity-60"
        style={{ background: a, filter: "blur(40px)" }}
      />
      <div
        aria-hidden="true"
        className="absolute -bottom-1/3 -left-1/4 -z-10 size-3/4 rounded-full opacity-50"
        style={{ background: b, filter: "blur(40px) brightness(0.7)" }}
      />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/45 via-black/5 to-transparent" />
      <Icon
        strokeWidth={1.6}
        className={cn("absolute text-white/90 drop-shadow", size === "lg" ? "top-6 left-6 size-14" : "top-4 left-4 size-9")}
      />
      <div
        className={cn(
          "absolute right-0 bottom-0 left-0 font-display font-semibold tracking-[-0.03em] text-white drop-shadow-md",
          "break-words hyphens-auto",
          size === "lg" ? "p-6 text-[32px] leading-[1.05]" : "p-4 text-[22px] leading-tight",
        )}
      >
        {mix.title}
      </div>
    </div>
  );
}

export function MixTile({ mix }: { mix: MixCard }) {
  return (
    <Link to={`/mixes/${mix.key}`} className="group flex min-w-0 flex-col gap-2.5">
      <div className="relative">
        <MixCover mix={mix} className="transition group-hover:brightness-110" />
        {mix.current && (
          <span className="absolute top-3 right-3 rounded-full bg-black/35 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur">
            Сейчас
          </span>
        )}
        <button
          aria-label={`Слушать «${mix.title}»`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void playTracksOf(mix.key);
          }}
          className="absolute right-3 bottom-3 flex size-12 translate-y-2 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-xl shadow-black/40 transition group-hover:translate-y-0 group-hover:opacity-100 hover:scale-105 focus-visible:translate-y-0 focus-visible:opacity-100"
        >
          <PlayFill className="ml-0.5 size-5" />
        </button>
      </div>
      <div className="min-w-0 px-0.5">
        <div className="truncate text-[13px] text-muted">{mix.subtitle}</div>
      </div>
    </Link>
  );
}
