/**
 * Проверка новой версии после деплоя.
 *
 * Открытая вкладка (и особенно приложение на экране «Домой» в iPhone) держит старый код,
 * пока его не перезагрузить. При возврате в приложение сверяем адрес главного скрипта
 * в свежем index.html с текущим: если сборка другая — перезагружаемся, когда ничего не играет,
 * иначе показываем «Обновить».
 */
import { useSyncExternalStore } from "react";
import { isOffline } from "./network";
import { player } from "./player";

const CHECK_EVERY = 5 * 60_000;

function currentBuild(): string | null {
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return s ? new URL(s.src, location.href).pathname : null;
}

let available = false;
const listeners = new Set<() => void>();
function setAvailable(v: boolean) {
  available = v;
  listeners.forEach((l) => l());
}
export function useUpdateAvailable() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => available,
  );
}

export function applyUpdate() {
  location.reload();
}

let lastCheck = 0;
async function check() {
  const mine = currentBuild();
  if (!mine || isOffline() || available) return; // в режиме разработки скрипта /assets/ нет
  lastCheck = Date.now();
  try {
    const html = await (await fetch("/", { cache: "no-store", headers: { Accept: "text/html" } })).text();
    const m = /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+)"/.exec(html);
    if (!m) return;
    const fresh = new URL(m[1], location.href).pathname;
    if (fresh === mine) return;
    const s = player.getState();
    // ничего не играет и пользователь только вернулся — тихо перезагружаемся
    if (!s.playing && document.visibilityState === "visible") location.reload();
    else setAvailable(true);
  } catch {
    /* сеть — проверим позже */
  }
}

export function startUpdateChecks(): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible" && Date.now() - lastCheck > 30_000) void check();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  const timer = window.setInterval(() => void check(), CHECK_EVERY);
  // когда музыка встала на паузу, а обновление ждёт — можно применить
  const unsub = player.subscribe(() => {
    if (available && !player.getState().playing && document.visibilityState === "hidden") location.reload();
  });
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    window.clearInterval(timer);
    unsub();
  };
}
