import { useState } from "react";
import { AuthShell, Stepper } from "@/components/AuthShell";
import { FolderBrowser } from "@/components/FolderBrowser";
import { CircleCheck, Folder, LoaderCircle, Plus, Smartphone, Trash } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/query";
import { Link } from "@/lib/router";
import { toast } from "@/lib/toast";
import { countLabel } from "@/lib/utils";
import { SETUP_STEPS } from "./SetupPage";

/** Шаги 3–4 установки: папки с музыкой и первое сканирование. */
export default function WelcomePage() {
  const [step, setStep] = useState<2 | 3>(2);
  const libs = useQuery(["admin", "libraries"], api.admin.libraries);
  const scan = useQuery(["admin", "scan"], api.admin.scanStatus, { refetchInterval: 1500, staleTime: 0 });
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!path) return;
    setBusy(true);
    try {
      await api.admin.createLibrary({ name: name.trim() || path.split("/").pop() || "Музыка", path, default_access: open });
      setPath("");
      setName("");
      invalidate(["admin"]);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await api.admin.deleteLibrary(id);
      invalidate(["admin"]);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  if (step === 3) {
    const s = scan.data;
    const total = (libs.data ?? []).reduce((a, l) => a + l.track_count, 0);
    return (
      <AuthShell wide top={<Stepper steps={SETUP_STEPS} current={3} />} title="Всё готово" subtitle="Медиатека сканируется в фоне — можно сразу начинать слушать.">
        <div className="grid gap-5">
          <div className="rounded-2xl border bg-surface p-5">
            {s?.running ? (
              <>
                <div className="mb-3 flex items-center gap-3 font-bold">
                  <LoaderCircle className="size-5 animate-spin text-accent-ink" /> Сканирую «{s.library_name}» · проверено файлов: {s.checked}
                </div>
                <Progress value={100} className="animate-pulse" />
              </>
            ) : (
              <div className="flex items-center gap-3 font-bold">
                <CircleCheck className="size-5 text-success" /> Найдено {countLabel(total, "трек", "трека", "треков")}
              </div>
            )}
          </div>
          <div className="flex gap-4 rounded-2xl border bg-surface p-5">
            <Smartphone className="size-6 shrink-0 text-accent-ink" />
            <p className="text-sm leading-relaxed text-muted">
              Для телефона подойдут готовые Subsonic-приложения — Symfonium, Tempo, Amperfy, play:Sub. Адрес сервера и пароль для
              приложений — в профиле.
            </p>
          </div>
          <div className="flex justify-end border-t pt-6">
            <Link to="/" className="inline-flex h-12 items-center rounded-full bg-accent px-7 font-bold text-accent-fg">
              Открыть медиатеку
            </Link>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      wide
      top={<Stepper steps={SETUP_STEPS} current={2} />}
      title="Папки с музыкой"
      subtitle="Можно добавить несколько. Каждой папке потом можно отдельно открыть или закрыть доступ для пользователей."
    >
      <div className="grid gap-6">
        {(libs.data ?? []).length > 0 && (
          <div className="grid gap-2">
            {libs.data!.map((l) => (
              <div key={l.id} className="flex items-center gap-3 rounded-2xl border bg-surface p-3">
                <span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-accent-ink">
                  <Folder className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-bold">{l.name}</div>
                  <div className="truncate text-[13px] text-faint">{l.path}</div>
                </div>
                <Button variant="ghost" size="icon-sm" aria-label={`Убрать ${l.name}`} onClick={() => remove(l.id)}>
                  <Trash className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <FolderBrowser
          value={path}
          onChange={(p, n) => {
            setPath(p);
            setName(n);
          }}
        />
        {path && (
          <div className="grid gap-4 rounded-2xl border bg-surface p-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field id="lib-name" label="Название папки в приложении">
              <Input id="lib-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button onClick={add} disabled={busy}>
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />} Добавить
            </Button>
            <label className="flex items-center gap-3 text-sm text-muted sm:col-span-2">
              <Switch checked={open} onChange={setOpen} label="Открыта для всех пользователей" />
              Открыта для всех пользователей (для чтения)
            </label>
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-3 border-t pt-6">
          <Button variant="ghost" onClick={() => setStep(3)}>
            Пропустить
          </Button>
          <Button size="lg" disabled={!libs.data?.length} onClick={() => setStep(3)}>
            Далее
          </Button>
        </div>
      </div>
    </AuthShell>
  );
}
