import { useRef, useState } from "react";
import { Download, LoaderCircle, Smartphone, Trash, Upload, X } from "@/components/icons";
import { Button, buttonClass } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card } from "@/components/ui/misc";
import { api, type AndroidApp } from "@/lib/api";
import { dialogs } from "@/lib/dialogs";
import { formatDate, formatSize } from "@/lib/format";
import { isNative } from "@/lib/native";
import { invalidate, useQuery } from "@/lib/query";
import { toast } from "@/lib/toast";

const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

function useApp() {
  return useQuery(["android-app"], api.auth.androidApp, { staleTime: 10 * 60_000 });
}

function label(a: Extract<AndroidApp, { available: true }>) {
  return [a.version && `версия ${a.version}`, formatSize(a.size)].filter(Boolean).join(" · ");
}

/** Для пользователей (в профиле): скачать приложение. В самом приложении не показываем. */
export function AndroidAppCard() {
  const q = useApp();
  const a = q.data;
  if (isNative || !a?.available) return null;
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-accent text-accent-fg">
          <Smartphone className="size-6" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-extrabold">Приложение для Android</h2>
          <p className="mt-1 text-sm text-muted">
            Музыка играет в фоне, на экране блокировки и слушается кнопок наушников. Интерфейс тот же, что здесь, и обновляется сам вместе с
            сервером. Для телефонов и планшетов.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <a href="/api/app/download" download className={buttonClass("primary")}>
          <Download className="size-4" /> Скачать APK
        </a>
        <span className="text-[13px] text-faint">{label(a)}</span>
      </div>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13px] text-muted">
        {!isAndroid && <li>Откройте эту страницу на телефоне или планшете и скачайте файл там.</li>}
        <li>Откройте скачанный файл и разрешите браузеру установку приложений, если Android спросит.</li>
        <li>
          При входе укажите адрес сервера <b className="text-fg">{location.host}</b>, свой логин и пароль.
        </li>
      </ol>
    </Card>
  );
}

const BANNER_KEY = "sm-android-banner";

/** Плашка на главной — только в браузере на Android, пока её не закрыли. */
export function AndroidAppBanner() {
  const q = useApp();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(BANNER_KEY) === "1";
    } catch {
      return false;
    }
  });
  const a = q.data;
  if (isNative || !isAndroid || hidden || !a?.available) return null;
  const close = () => {
    setHidden(true);
    try {
      localStorage.setItem(BANNER_KEY, "1");
    } catch {
      /* приватный режим */
    }
  };
  return (
    <div className="glass flex items-center gap-3 rounded-2xl border p-3 pr-2">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg">
        <Smartphone className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-bold">Есть приложение для Android</div>
        <div className="truncate text-[12px] text-muted">Музыка в фоне и на экране блокировки</div>
      </div>
      <a href="/api/app/download" download onClick={close} className={buttonClass("primary", "sm")}>
        Скачать
      </a>
      <button aria-label="Скрыть" onClick={close} className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2">
        <X className="size-4" />
      </button>
    </div>
  );
}

/** Для администратора: положить APK на сервер — файлом или ссылкой на сборку Expo. */
export function AndroidAppAdminCard() {
  const q = useApp();
  const a = q.data;
  const input = useRef<HTMLInputElement>(null);
  const [version, setVersion] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const done = (msg: string) => {
    invalidate(["android-app"]);
    setUrl("");
    toast.success(msg);
  };
  const upload = async (file: File) => {
    setBusy("file");
    try {
      await api.admin.uploadApp(file, version);
      done("Приложение загружено");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const fetchUrl = async () => {
    setBusy("url");
    try {
      await api.admin.fetchApp(url.trim(), version);
      done("Приложение скачано на сервер");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    const ok = await dialogs.confirm({
      title: "Убрать приложение?",
      text: "Ссылка на скачивание пропадёт у всех пользователей. Установленные приложения продолжат работать.",
      action: "Убрать",
      danger: true,
    });
    if (!ok) return;
    await api.admin.deleteApp();
    invalidate(["android-app"]);
  };

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-extrabold">Приложение для Android</h2>
        <p className="mt-1 text-sm text-muted">
          APK из сборки Expo. Пользователи скачают его в профиле, а в браузере на Android увидят плашку на главной.
        </p>
      </div>
      {a?.available ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface-2/60 p-3">
          <Smartphone className="size-5 text-accent-ink" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-bold">{label(a)}</div>
            <div className="text-faint">Загружено {formatDate(a.uploaded_at)}</div>
          </div>
          <a href="/api/app/download" download className={buttonClass("ghost", "sm")}>
            <Download className="size-4" /> Скачать
          </a>
          <Button variant="ghost" size="sm" onClick={remove} aria-label="Убрать приложение">
            <Trash className="size-4" />
          </Button>
        </div>
      ) : (
        <p className="text-sm text-faint">Пока не загружено.</p>
      )}
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <Field id="app-version" label="Версия" hint="Например, 1.0.0">
          <Input id="app-version" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" />
        </Field>
        <Field id="app-url" label="Ссылка на APK из Expo" hint="В сборке на expo.dev: Install → скопировать ссылку на .apk">
          <div className="flex gap-2">
            <Input id="app-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://expo.dev/artifacts/eas/….apk" />
            <Button onClick={fetchUrl} disabled={!url.trim() || busy !== null}>
              {busy === "url" ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
              Скачать
            </Button>
          </div>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => input.current?.click()} disabled={busy !== null}>
          {busy === "file" ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {a?.available ? "Заменить файлом" : "Загрузить файл .apk"}
        </Button>
        <input
          ref={input}
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
        />
      </div>
    </Card>
  );
}
