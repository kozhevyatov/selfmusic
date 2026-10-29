import { useSyncExternalStore } from "react";
import { sendNative } from "./native";

export type ThemeMode = "dark" | "light" | "system";
export type Accent = "coral" | "violet" | "lime" | "teal";
/** Анимация фона: smooth — плавно (греет слабые ноутбуки), eco — экономно, off — без анимации */
export type Motion = "smooth" | "eco" | "off";

export const ACCENTS: { id: Accent; label: string; color: string }[] = [
  { id: "coral", label: "Коралл", color: "#FF6A3D" },
  { id: "violet", label: "Фиалка", color: "#8F7BFF" },
  { id: "lime", label: "Лайм", color: "#C8F03C" },
  { id: "teal", label: "Бирюза", color: "#3DD6C1" },
];

function load<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}

let state = {
  mode: load<ThemeMode>("sm-theme", "dark"),
  accent: load<Accent>("sm-accent", "coral"),
  motion: load<Motion>("sm-motion", "eco"),
};
const listeners = new Set<() => void>();
const media = window.matchMedia("(prefers-color-scheme: dark)");

function apply() {
  const dark = state.mode === "system" ? media.matches : state.mode === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.dataset.accent = state.accent;
  root.dataset.motion = state.motion;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0d0d0f" : "#f6f4f0");
  // Android-приложению: цвет полос под статус-баром и навигацией
  sendNative("theme", { dark, background: dark ? "#0d0d0f" : "#f6f4f0" });
}

media.addEventListener("change", () => state.mode === "system" && apply());
apply();

function save() {
  try {
    localStorage.setItem("sm-theme", state.mode);
    localStorage.setItem("sm-accent", state.accent);
    localStorage.setItem("sm-motion", state.motion);
  } catch {
    /* приватный режим */
  }
  apply();
  listeners.forEach((l) => l());
}

export function setThemeMode(mode: ThemeMode) {
  state = { ...state, mode };
  save();
}

export function setMotion(motion: Motion) {
  state = { ...state, motion };
  save();
}

export function setAccent(accent: Accent) {
  state = { ...state, accent };
  save();
}

export function isDark() {
  return document.documentElement.classList.contains("dark");
}

export function useTheme() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => state,
  );
}
