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
async function check(fromReturn = false) {
  const mine = currentBuild();
  if (!mine || isOffline() || available) return; // в режиме разработки скрипта /assets/ нет
  lastCheck = Date.now();
  try {
    const html = await (await fetch("/", { cache: "no-store", headers: { Accept: "text/html" } })).text();
    const m = /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+)"/.exec(html);
    if (!m) return;
    const fresh = new URL(m[1], location.href).pathname;
    if (fresh === mine) return;
    // тихо перезагружаемся, только когда пользователь вернулся в приложение и ничего не играет;
    // проверка по таймеру лишь показывает «Обновить» (вдруг он сейчас что-то заполняет)
    if (fromReturn && !player.getState().playing) location.reload();
    else setAvailable(true);
  } catch {
    /* сеть — проверим позже */
  }
}

export function startUpdateChecks(): () => void {
  let hiddenAt = 0;
  const onVisible = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    // «вернулся в приложение» — только если его сворачивали надолго (а не закрыли окно выбора файла)
    const returned = hiddenAt > 0 && Date.now() - hiddenAt > 60_000;
    hiddenAt = 0;
    if (Date.now() - lastCheck > 30_000) void check(returned);
  };
  const onFocus = () => Date.now() - lastCheck > 30_000 && void check(false);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onFocus);
  const timer = window.setInterval(() => void check(), CHECK_EVERY);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onFocus);
    window.clearInterval(timer);
  };
}
