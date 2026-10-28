import { useEffect, useState, type FormEvent } from "react";
import { api, type Share, type ShareOptions, type ShareTarget } from "@/lib/api";
import { dialogs } from "@/lib/dialogs";
import { invalidate } from "@/lib/query";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Check, Copy, Download, ExternalLink, Folder, Link as LinkIcon, LoaderCircle, Lock } from "./icons";
import { PlayFill } from "./icon";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field, Input, Select, Textarea } from "./ui/input";
import { Switch } from "./ui/switch";

type Expiry = "never" | "1" | "7" | "30" | "custom";

function toLocalDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function copyText(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success("Ссылка скопирована"))
    .catch(() => toast.error("Не удалось скопировать"));
}

function ShareResult({ share }: { share: Share }) {
  const [copied, setCopied] = useState(false);
  const canNative = typeof navigator.share === "function";
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3 rounded-2xl border border-success/30 bg-success/10 p-4 text-sm font-semibold">
        <Check className="size-5 text-success" /> Ссылка готова — её можно отправить кому угодно
      </div>
      <div className="flex items-center gap-1 rounded-2xl border bg-surface-2/60 p-1.5 pl-4">
        <code className="min-w-0 flex-1 truncate font-mono text-[14px]">{share.url}</code>
        <Button
          size="sm"
          onClick={() => {
            copyText(share.url);
            setCopied(true);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? "Скопировано" : "Копировать"}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2 text-[13px] text-muted">
        <span className="rounded-full bg-surface-2 px-3 py-1">{share.allow_download ? "Можно скачать" : "Только слушать"}</span>
        {share.has_password && <span className="rounded-full bg-surface-2 px-3 py-1">С паролем</span>}
        <span className="rounded-full bg-surface-2 px-3 py-1">
          {share.expires_at ? `До ${new Date(share.expires_at).toLocaleDateString("ru-RU")}` : "Бессрочно"}
        </span>
        {share.max_views && <span className="rounded-full bg-surface-2 px-3 py-1">Открытий: до {share.max_views}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {canNative && (
          <Button variant="secondary" onClick={() => navigator.share({ title: share.title || share.target_title, url: share.url }).catch(() => {})}>
            <LinkIcon className="size-4" /> Отправить…
          </Button>
        )}
        <a href={share.url} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center gap-2 rounded-full px-5 text-sm font-bold hover:bg-surface-2">
          <ExternalLink className="size-4" /> Открыть
        </a>
      </div>
    </div>
  );
}

export function ShareDialog({ target, share }: { target?: ShareTarget; share?: Share }) {
  const editing = Boolean(share);
  const [title, setTitle] = useState(share?.title ?? "");
  const [description, setDescription] = useState(share?.description ?? "");
  const [usePassword, setUsePassword] = useState(share?.has_password ?? false);
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState<Expiry>(share?.expires_at ? "custom" : "7");
  const [date, setDate] = useState(share?.expires_at ? toLocalDate(share.expires_at) : toLocalDate(new Date(Date.now() + 30 * 864e5).toISOString()));
  const [download, setDownload] = useState(share?.allow_download ?? false);
  const [limit, setLimit] = useState(share?.max_views ? String(share.max_views) : "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Share | null>(null);

  // Папка: можно выбрать подпапку
  const [folder, setFolder] = useState(target?.kind === "folder" ? target.folder : "");
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (target?.kind !== "folder") return;
    let alive = true;
    api.shares
      .dirs(target.library_id, folder)
      .then((d) => {
        if (!alive) return;
        setDirs(d.dirs);
        setCount(d.track_count);
      })
      .catch(() => alive && setDirs([]));
    return () => {
      alive = false;
    };
  }, [target, folder]);

  const expiresAt = (): string | null => {
    if (expiry === "never") return null;
    if (expiry === "custom") return new Date(`${date}T23:59:59`).toISOString();
    return new Date(Date.now() + Number(expiry) * 864e5).toISOString();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (usePassword && !editing && password.length < 4) return toast.error("Пароль — минимум 4 символа");
    setBusy(true);
    try {
      const exp = expiresAt();
      const opts: ShareOptions = {
        title: title.trim(),
        description: description.trim(),
        allow_download: download,
        max_views: limit ? Number(limit) : editing ? 0 : null,
      };
      if (editing) {
        if (!usePassword) opts.password = share!.has_password ? "" : null;
        else if (password) opts.password = password;
        if (exp) opts.expires_at = exp;
        else opts.clear_expiry = true;
        await api.shares.update(share!.id, opts);
        toast.success("Ссылка обновлена");
        invalidate(["shares"]);
        dialogs.closeQuiet();
      } else {
        const t = target!.kind === "folder" ? { ...target!, folder } : target!;
        const created = await api.shares.create(t, { ...opts, password: usePassword ? password : null, expires_at: exp });
        invalidate(["shares"]);
        setResult(created);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const label = share ? share.title || share.target_title : target?.label ?? "";

  return (
    <Dialog
      open
      onClose={dialogs.close}
      title={result ? "Ссылка создана" : editing ? "Настройки ссылки" : "Поделиться"}
      description={result ? undefined : label}
      footer={
        result ? (
          <Button onClick={dialogs.closeQuiet}>Готово</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={dialogs.close}>
              Отмена
            </Button>
            <Button type="submit" form="share-form" disabled={busy}>
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <LinkIcon className="size-4" />} {editing ? "Сохранить" : "Создать ссылку"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ShareResult share={result} />
      ) : (
        <form id="share-form" onSubmit={submit} className="grid gap-5">
          {target?.kind === "folder" && (
            <div className="overflow-hidden rounded-2xl border">
              <div className="flex items-center gap-2 border-b bg-surface-2/60 px-4 py-2.5 text-sm">
                <Folder className="size-4 text-accent-ink" />
                <span className="min-w-0 flex-1 truncate font-bold">
                  {target.label}
                  {folder ? ` / ${folder}` : ""}
                </span>
                {folder && (
                  <button type="button" onClick={() => setFolder(folder.split("/").slice(0, -1).join("/"))} className="text-[13px] font-bold text-muted hover:text-fg">
                    Выше
                  </button>
                )}
              </div>
              <div className="max-h-40 overflow-y-auto p-1.5">
                {dirs === null && <p className="px-3 py-2 text-sm text-faint">Загрузка…</p>}
                {dirs?.length === 0 && <p className="px-3 py-2 text-sm text-faint">Подпапок нет</p>}
                {dirs?.map((d) => (
                  <button
                    type="button"
                    key={d}
                    onClick={() => setFolder(folder ? `${folder}/${d}` : d)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm font-semibold hover:bg-surface-2"
                  >
                    <Folder className="size-4 text-faint" /> {d}
                  </button>
                ))}
              </div>
              <div className="border-t px-4 py-2 text-[13px] text-muted">
                Поделиться {folder ? "этой подпапкой" : "всей папкой"} · треков: {count ?? "…"}. Новые файлы тоже будут видны по ссылке.
              </div>
            </div>
          )}

          <div role="radiogroup" aria-label="Режим" className="grid grid-cols-2 gap-3">
            {[
              { v: false, icon: <PlayFill className="size-4" />, t: "Только слушать", d: "Поток MP3 192, без скачивания" },
              { v: true, icon: <Download className="size-4" />, t: "Слушать и скачивать", d: "Оригинальные файлы и ZIP-архив" },
            ].map((o) => (
              <button
                type="button"
                key={String(o.v)}
                role="radio"
                aria-checked={download === o.v}
                onClick={() => setDownload(o.v)}
                className={cn(
                  "flex flex-col items-start gap-1.5 rounded-2xl border-2 p-3.5 text-left transition",
                  download === o.v ? "border-accent bg-accent/8" : "border-line hover:border-accent/40",
                )}
              >
                <span className={cn("flex size-8 items-center justify-center rounded-lg", download === o.v ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted")}>
                  {o.icon}
                </span>
                <span className="text-[15px] font-extrabold">{o.t}</span>
                <span className="text-[12px] leading-snug text-muted">{o.d}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="sh-exp" label="Срок действия">
              <Select id="sh-exp" value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
                <option value="1">1 день</option>
                <option value="7">7 дней</option>
                <option value="30">30 дней</option>
                <option value="custom">До даты…</option>
                <option value="never">Бессрочно</option>
              </Select>
            </Field>
            {expiry === "custom" ? (
              <Field id="sh-date" label="Действует до">
                <Input id="sh-date" type="date" value={date} min={toLocalDate(new Date().toISOString())} onChange={(e) => setDate(e.target.value)} />
              </Field>
            ) : (
              <Field id="sh-limit" label="Лимит открытий" hint="Пусто — без лимита">
                <Input id="sh-limit" inputMode="numeric" placeholder="Без лимита" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))} />
              </Field>
            )}
          </div>
          {expiry === "custom" && (
            <Field id="sh-limit2" label="Лимит открытий" hint="Пусто — без лимита">
              <Input id="sh-limit2" inputMode="numeric" placeholder="Без лимита" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))} />
            </Field>
          )}

          <div className="flex flex-col gap-3 rounded-2xl border p-4">
            <label className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-2.5 font-bold">
                <Lock className="size-4 text-muted" /> Пароль
              </span>
              <Switch label="Пароль" checked={usePassword} onChange={setUsePassword} />
            </label>
            {usePassword && (
              <Input
                aria-label="Пароль ссылки"
                type="text"
                autoComplete="off"
                placeholder={editing && share?.has_password ? "Оставьте пустым, чтобы не менять" : "Минимум 4 символа"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </div>

          <Field id="sh-title" label="Название на странице" hint="Необязательно — по умолчанию название альбома или папки">
            <Input id="sh-title" value={title} placeholder={share?.target_title ?? target?.label} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field id="sh-desc" label="Сообщение получателю">
            <Textarea id="sh-desc" rows={2} className="min-h-0" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </form>
      )}
    </Dialog>
  );
}
