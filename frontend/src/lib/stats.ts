import type { StatsResult } from "./api";
import { plural } from "./utils";

export const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
export const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export const WEEKDAYS_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
export const WEEKDAYS_ACC = ["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];

export const nf = (n: number) => Math.round(n).toLocaleString("ru-RU");

export function minutes(seconds: number) {
  return Math.round(seconds / 60);
}

/** «128 ч» для больших величин, «42 мин» для малых. */
export function hoursLabel(seconds: number) {
  const m = minutes(seconds);
  if (m < 120) return `${nf(m)} мин`;
  return `${nf(Math.round(m / 60))} ч`;
}

export function playsLabel(n: number) {
  return `${nf(n)} ${plural(n, "прослушивание", "прослушивания", "прослушиваний")}`;
}

export function dayLabel(iso: string) {
  const d = new Date(iso + (iso.length === 10 ? "T12:00:00" : ""));
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
}

/** Изменение к прошлому периоду, %. null — сравнивать не с чем. */
export function delta(cur: number, prev: number | undefined | null) {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

/** Кто ты по времени прослушивания. */
export function listenerPersona(hours: number[]) {
  const sum = (from: number, to: number) => hours.slice(from, to).reduce((a, b) => a + b, 0);
  const parts = [
    { key: "night", value: sum(0, 5) + hours[23], title: "Ночная сова", text: "Больше всего музыки — после полуночи, когда весь дом спит." },
    { key: "morning", value: sum(5, 11), title: "Жаворонок", text: "Ты включаешь музыку с самого утра — день начинается со звука." },
    { key: "day", value: sum(11, 17), title: "Дневной слушатель", text: "Музыка сопровождает тебя в разгар дня — за работой и в дороге." },
    { key: "evening", value: sum(17, 23), title: "Вечерний меломан", text: "Главное время для музыки — вечер, после всех дел." },
  ];
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return null;
  const best = parts.sort((a, b) => b.value - a.value)[0];
  const peak = hours.indexOf(Math.max(...hours));
  return { ...best, share: best.value / total, peak };
}

/** Настроение по средним energy/valence (шкалы 0..1, как в анализе для подборок). */
export function moodOf(sound: NonNullable<StatsResult["sound"]>) {
  const e = sound.energy;
  const v = sound.valence;
  const de = e - sound.library_energy;
  const dv = v - sound.library_valence;
  let title: string;
  let text: string;
  if (e >= 0.55 && v >= 0.5) {
    title = "Драйв и солнце";
    text = "Энергичная и светлая музыка — тебе явно нравится, когда всё звучит в полную силу.";
  } else if (e >= 0.55) {
    title = "Напор";
    text = "Мощно, плотно, с характером — громкие гитары и тяжёлый ритм тебе по душе.";
  } else if (v >= 0.5) {
    title = "Тёплое спокойствие";
    text = "Мягкая, светлая музыка без лишней суеты — звук для хорошего настроения.";
  } else {
    title = "Меланхолия";
    text = "Задумчивая, атмосферная музыка — больше про чувства, чем про танцпол.";
  }
  const cmp: string[] = [];
  if (Math.abs(de) >= 0.04) cmp.push(de > 0 ? "энергичнее" : "спокойнее");
  if (Math.abs(dv) >= 0.04) cmp.push(dv > 0 ? "светлее" : "мрачнее");
  return { title, text, compare: cmp.length ? `${cmp.join(" и ")}, чем библиотека в среднем` : "в балансе со всей библиотекой" };
}

export function periodTitle(kind: StatsResult["kind"], year: number | null) {
  if (kind === "week") return "за неделю";
  if (kind === "month") return "за 30 дней";
  if (kind === "year") return `за ${year ?? new Date().getFullYear()} год`;
  return "за всё время";
}
