import { useEffect, useRef, useState, type FormEvent } from "react";
import { AndroidAppAdminCard } from "@/components/AndroidApp";
import { AvatarCropper } from "@/components/AvatarCropper";
import { Avatar } from "@/components/Cover";
import { FolderBrowser } from "@/components/FolderBrowser";
import { FolderRulesTree } from "@/components/FolderRulesTree";
import {
  Folder,
  FolderPlus,
  FolderTree,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  Lock,
  Pencil,
  RefreshCw,
  ScanSearch,
  Trash,
  TriangleAlert,
  UserPlus,
} from "@/components/icons";
import { PageHeader } from "@/components/Section";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Badge, Card, ErrorBox, PageLoader, Progress } from "@/components/ui/misc";
import { Segmented, Switch } from "@/components/ui/switch";
import { api, updateCurrentUser, type AdminLibrary, type AdminUser, type DuplicatesResult, type UploadMode } from "@/lib/api";
import { Link } from "@/lib/router";
import { useAuth } from "@/lib/auth";
import { dialogs } from "@/lib/dialogs";
import { formatDate, formatDuration, formatSize } from "@/lib/format";
import { invalidate, useQuery } from "@/lib/query";
import { setSearchParam, useSearchParams } from "@/lib/router";
import { toast } from "@/lib/toast";
import { cn, countLabel } from "@/lib/utils";

type Tab = "users" | "libraries" | "duplicates" | "general";

// ---------------- общие ----------------

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);

/** Анализ звука для подборок: включение, часы работы, прогресс. */
function AnalysisCard() {
  const q = useQuery(["admin", "analysis"], api.admin.analysis, { refetchInterval: 3000, staleTime: 0 });
  const a = q.data;
  if (!a) return null;
  const set = async (patch: { enabled?: boolean; start?: string; end?: string }) => {
    try {
      await api.admin.updateAnalysis(patch);
      invalidate(["admin", "analysis"]);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const pct = a.total ? Math.round(((a.analyzed + a.failed) / a.total) * 100) : 0;
  const left = Math.max(0, a.total - a.analyzed - a.failed);
  const allDay = a.start === a.end;
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-[16px] font-extrabold">Анализ звука для подборок</div>
          <p className="mt-1 text-sm text-muted">
            Сервер один раз «прослушивает» каждый трек: темп, энергия, лад. Работает с самым низким приоритетом и только в
            выбранные часы, чтобы не мешать.
          </p>
        </div>
        <Switch label="Анализ звука" checked={a.enabled} onChange={(v) => set({ enabled: v })} />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted">Работать с</span>
        <div className="w-28">
          <Select aria-label="Начало" value={a.start} onChange={(e) => set({ start: e.target.value })} disabled={!a.enabled}>
            {HOURS.map((h) => (
              <option key={h}>{h}</option>
            ))}
          </Select>
        </div>
        <span className="text-muted">до</span>
        <div className="w-28">
          <Select aria-label="Конец" value={a.end} onChange={(e) => set({ end: e.target.value })} disabled={!a.enabled}>
            {HOURS.map((h) => (
              <option key={h}>{h}</option>
            ))}
          </Select>
        </div>
        {allDay && <span className="text-faint">— круглосуточно</span>}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span>
            Проанализировано <b>{a.analyzed.toLocaleString("ru-RU")}</b> из {a.total.toLocaleString("ru-RU")}
            {a.failed > 0 && <span className="text-faint"> · не удалось: {a.failed}</span>}
          </span>
          <span className="text-faint">{pct}%</span>
        </div>
        <Progress value={pct} />
        <div className="truncate text-[13px] text-faint">
          {a.running ? `Сейчас: ${a.current ?? "…"}` : left > 0 ? a.paused_reason || "Ожидает" : "Все треки проанализированы"}
        </div>
      </div>
      {left > 0 && (
        <div className="flex flex-wrap gap-2">
          {a.forced ? (
            <Button variant="secondary" onClick={() => api.admin.stopAnalysis().then(() => invalidate(["admin", "analysis"]))}>
              Вернуться к расписанию
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={() =>
                api.admin.runAnalysis().then(() => {
                  invalidate(["admin", "analysis"]);
                  toast.success("Анализ запущен — до конца очереди, с низким приоритетом");
                })
              }
            >
              Анализировать сейчас
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function GeneralTab() {
  const s = useQuery(["admin", "settings"], api.admin.settings);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (s.data) {
      setName(s.data.site_name);
      setUrl(s.data.public_url);
    }
  }, [s.data]);
  if (!s.data) return <PageLoader />;
  const update = async (patch: Parameters<typeof api.admin.updateSettings>[0], msg = "Сохранено") => {
    try {
      await api.admin.updateSettings(patch);
      invalidate(["admin", "settings"], ["settings"]);
      toast.success(msg);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <div className="grid max-w-3xl gap-5">
      <AndroidAppAdminCard />
      <Card className="flex flex-col gap-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            update({ site_name: name });
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <div className="min-w-60 flex-1">
            <Field id="site" label="Название сервиса">
              <Input id="site" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" variant="secondary">
            Сохранить
          </Button>
        </form>
      </Card>
      <Card className="flex flex-col gap-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            update({ public_url: url });
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <div className="min-w-60 flex-1">
            <Field id="public-url" label="Внешний адрес сервиса" hint="С него строятся общие ссылки, например https://music.nskarl.ru. Пусто — адрес, с которого вы открыли сайт.">
              <Input id="public-url" type="url" placeholder={window.location.origin} value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" variant="secondary">
            Сохранить
          </Button>
        </form>
      </Card>
      <Card className="flex items-start justify-between gap-6">
        <div>
          <div className="text-[16px] font-extrabold">Свободная регистрация</div>
          <p className="mt-1 text-sm text-muted">
            {s.data.registration_mode === "open"
              ? "Любой, у кого есть ссылка, может создать аккаунт. Новым пользователям открываются папки с пометкой «для всех»."
              : "Регистрация закрыта. Новых пользователей добавляет администратор."}
          </p>
        </div>
        <Switch
          label="Свободная регистрация"
          checked={s.data.registration_mode === "open"}
          onChange={(v) => update({ registration_mode: v ? "open" : "closed" }, v ? "Регистрация открыта" : "Регистрация закрыта")}
        />
      </Card>
      <Card className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-[16px] font-extrabold">Автоматическое сканирование</div>
          <p className="mt-1 text-sm text-muted">Как часто проверять папки на новые и изменённые файлы.</p>
        </div>
        <div className="w-56">
          <Select aria-label="Интервал сканирования" value={s.data.scan_interval} onChange={(e) => update({ scan_interval: Number(e.target.value) })}>
            <option value={0}>Выключено</option>
            <option value={15}>Каждые 15 минут</option>
            <option value={60}>Каждый час</option>
            <option value={360}>Каждые 6 часов</option>
            <option value={1440}>Раз в сутки</option>
          </Select>
        </div>
      </Card>
      <AnalysisCard />
    </div>
  );
}

// ---------------- папки ----------------

function ScanBar() {
  const scan = useQuery(["admin", "scan"], api.admin.scanStatus, { refetchInterval: 2000, staleTime: 0 });
  const [wasRunning, setWasRunning] = useState(false);
  const s = scan.data;
  useEffect(() => {
    if (!s) return;
    if (wasRunning && !s.running) invalidate(["admin", "libraries"], ["home"], ["albums"], ["libraries"]);
    setWasRunning(s.running);
  }, [s?.running]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  return (
    <Card className="flex flex-wrap items-center gap-4">
      <ScanSearch className={cn("size-6", s.running ? "animate-pulse text-accent-ink" : "text-faint")} />
      <div className="min-w-0 flex-1">
        {s.running ? (
          <>
            <div className="font-bold">
              {s.phase} · «{s.library_name}»
            </div>
            <div className="text-sm text-muted">
              Проверено файлов: {s.checked}, обновлено: {s.changed}
            </div>
          </>
        ) : (
          <>
            <div className="font-bold">Сканирование не идёт</div>
            <div className="text-sm text-muted">
              {s.last_result
                ? `Последнее: ${formatDate(s.finished_at)} · добавлено ${s.last_result.added}, обновлено ${s.last_result.updated}, удалено ${s.last_result.removed}${s.last_result.errors ? `, ошибок ${s.last_result.errors}` : ""}`
                : "Ещё не запускалось"}
            </div>
          </>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={s.running} onClick={() => api.admin.scan().then(() => scan.refetch())}>
          <RefreshCw className="size-4" /> Найти новое
        </Button>
        <Button variant="ghost" size="sm" disabled={s.running} onClick={() => api.admin.scan(undefined, true).then(() => scan.refetch())}>
          Полное пересканирование
        </Button>
      </div>
    </Card>
  );
}

function LibraryDialog({ open, onClose, lib }: { open: boolean; onClose: () => void; lib?: AdminLibrary }) {
  const [path, setPath] = useState(lib?.path ?? "");
  const [name, setName] = useState(lib?.name ?? "");
  const [def, setDef] = useState(lib?.default_access ?? true);
  const [kind, setKind] = useState<"music" | "audiobooks">(lib?.kind ?? "music");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setPath(lib?.path ?? "");
      setName(lib?.name ?? "");
      setDef(lib?.default_access ?? true);
      setKind(lib?.kind ?? "music");
    }
  }, [open, lib]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (lib) await api.admin.updateLibrary(lib.id, { name, path, default_access: def, kind });
      else await api.admin.createLibrary({ name: name.trim() || path.split("/").pop() || "Музыка", path, default_access: def, kind });
      invalidate(["admin"], ["libraries"]);
      toast.success(lib ? "Папка обновлена" : "Папка добавлена — идёт сканирование");
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={lib ? "Папка с музыкой" : "Добавить папку"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" form="lib-form" disabled={!path || busy}>
            {busy && <LoaderCircle className="size-4 animate-spin" />} {lib ? "Сохранить" : "Добавить"}
          </Button>
        </>
      }
    >
      <form id="lib-form" onSubmit={submit} className="grid gap-5">
        {!lib?.owner && (
          <FolderBrowser
            value={path}
            onChange={(p, n) => {
              setPath(p);
              if (!name || !lib) setName(n);
            }}
          />
        )}
        <Field id="lib-name" label="Название в приложении">
          <Input id="lib-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-bold">Что в папке</span>
          <Segmented<"music" | "audiobooks">
            label="Что в папке"
            value={kind}
            onChange={setKind}
            className="max-w-md"
            options={[
              { value: "music", label: "Музыка" },
              { value: "audiobooks", label: "Аудиокниги" },
            ]}
          />
          <span className="text-[13px] text-muted">
            {kind === "audiobooks"
              ? "Отдельный раздел «Аудиокниги»: книга — это папка (Автор / Серия / Книга), место прослушивания запоминается. В альбомы, подборки и радио не попадает."
              : "Альбомы, исполнители, подборки, радио."}
            {lib && kind !== lib.kind && " Папка будет пересканирована целиком."}
          </span>
        </div>
        {!lib?.owner && (
          <div className="flex items-start justify-between gap-4 rounded-2xl border p-4">
            <span>
              <span className="block font-bold">Открыта для всех</span>
              <span className="text-sm text-muted">Новые пользователи (и все существующие при добавлении) получат доступ на чтение.</span>
            </span>
            <Switch checked={def} onChange={setDef} label="Открыта для всех" />
          </div>
        )}
      </form>
    </Dialog>
  );
}

function LibrariesTab() {
  const libs = useQuery(["admin", "libraries"], api.admin.libraries);
  const [editing, setEditing] = useState<AdminLibrary | null>(null);
  const [adding, setAdding] = useState(false);
  const [treeOpen, setTreeOpen] = useState<Set<number>>(new Set());
  if (libs.isLoading) return <PageLoader />;
  if (libs.error) return <ErrorBox error={libs.error} />;
  const shared = libs.data!.filter((l) => !l.owner);
  const personal = libs.data!.filter((l) => l.owner);

  const patch = async (l: AdminLibrary, data: Parameters<typeof api.admin.updateLibrary>[1]) => {
    try {
      await api.admin.updateLibrary(l.id, data);
      invalidate(["admin"], ["libraries"], ["home"]);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const remove = async (l: AdminLibrary) => {
    const ok = await dialogs.confirm({
      title: `Убрать папку «${l.name}»?`,
      text: "Музыка исчезнет из медиатеки (вместе с историей и избранным по ней). Файлы на диске останутся нетронутыми.",
      action: "Убрать",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.admin.deleteLibrary(l.id);
      invalidate(["admin"], ["libraries"], ["home"], ["albums"]);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const card = (l: AdminLibrary) => (
    <Card key={l.id} className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-2xl bg-surface-2", l.enabled ? "text-accent-ink" : "text-faint")}>
          <Folder className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[17px] font-extrabold">{l.name}</span>
            {l.kind === "audiobooks" && <Badge className="border-accent/40 text-accent-ink">аудиокниги</Badge>}
            {!l.enabled && <Badge>выключена</Badge>}
            {l.owner && <Badge>личная · {l.owner.name}</Badge>}
            {l.writable ? <Badge className="border-success/40 text-success">чтение и запись</Badge> : <Badge>только чтение</Badge>}
            {l.excluded_count > 0 && <Badge>исключено подпапок: {l.excluded_count}</Badge>}
          </div>
          <div className="truncate text-[13px] text-faint">{l.path}</div>
          <div className="mt-1.5 text-sm text-muted">
            {l.kind === "audiobooks"
              ? countLabel(l.album_count, "книга", "книги", "книг")
              : countLabel(l.album_count, "альбом", "альбома", "альбомов")}{" "}
            · {countLabel(l.track_count, l.kind === "audiobooks" ? "файл" : "трек", l.kind === "audiobooks" ? "файла" : "трека", l.kind === "audiobooks" ? "файлов" : "треков")} ·{" "}
            {formatDuration(l.total_duration)} · {formatSize(l.total_size)}
          </div>
          <div className="text-[13px] text-faint">
            Сканирование: {formatDate(l.last_scan_at)} · доступ у {countLabel(l.user_count, "пользователя", "пользователей", "пользователей")}
          </div>
          {!l.exists && (
            <div className="mt-2 flex items-center gap-2 text-sm font-semibold text-danger">
              <TriangleAlert className="size-4" /> Папка недоступна внутри контейнера — проверьте volumes
            </div>
          )}
          {l.last_scan_error && l.exists && <div className="mt-2 text-sm font-semibold text-danger">{l.last_scan_error}</div>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t pt-4">
        <label className="flex items-center gap-2.5 text-sm font-semibold">
          <Switch checked={l.enabled} onChange={(v) => patch(l, { enabled: v })} label="Включена" /> Включена
        </label>
        {!l.owner && (
          <label className="flex items-center gap-2.5 text-sm font-semibold">
            <Switch checked={l.default_access} onChange={(v) => patch(l, { default_access: v })} label="Для новых пользователей" /> Для новых пользователей
          </label>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {l.exists && (
            <Button
              variant={treeOpen.has(l.id) ? "secondary" : "ghost"}
              size="sm"
              aria-expanded={treeOpen.has(l.id)}
              onClick={() =>
                setTreeOpen((s) => {
                  const n = new Set(s);
                  if (n.has(l.id)) n.delete(l.id);
                  else n.add(l.id);
                  return n;
                })
              }
            >
              <FolderTree className="size-4" /> Подпапки
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Сканировать" title="Сканировать" onClick={() => api.admin.scan(l.id).then(() => invalidate(["admin", "scan"]))}>
            <RefreshCw className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Изменить" title="Изменить" onClick={() => setEditing(l)}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Убрать папку" title="Убрать" onClick={() => remove(l)}>
            <Trash className="size-4" />
          </Button>
        </div>
      </div>
      {treeOpen.has(l.id) && <FolderRulesTree libId={l.id} />}
    </Card>
  );

  return (
    <div className="grid gap-5">
      <ScanBar />
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-extrabold">Общие папки</h2>
        <Button onClick={() => setAdding(true)}>
          <FolderPlus className="size-4" /> Добавить папку
        </Button>
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-2">{shared.map(card)}</div>
      {personal.length > 0 && (
        <>
          <h2 className="mt-2 text-lg font-extrabold">Личные папки пользователей</h2>
          <div className="grid items-start gap-4 xl:grid-cols-2">{personal.map(card)}</div>
        </>
      )}
      <LibraryDialog open={adding} onClose={() => setAdding(false)} />
      <LibraryDialog open={editing !== null} onClose={() => setEditing(null)} lib={editing ?? undefined} />
    </div>
  );
}

// ---------------- пользователи ----------------

const MODES: { value: UploadMode; label: string }[] = [
  { value: "none", label: "Нельзя" },
  { value: "own", label: "В свою папку" },
  { value: "libraries", label: "В общие папки" },
];

function UserDetail({ user, libs, me }: { user: AdminUser; libs: AdminLibrary[]; me: number }) {
  const [quota, setQuota] = useState(String(user.upload_quota_mb || ""));
  const [maxFiles, setMaxFiles] = useState(String(user.upload_max_files || ""));
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  useEffect(() => {
    setQuota(String(user.upload_quota_mb || ""));
    setMaxFiles(String(user.upload_max_files || ""));
  }, [user.id, user.upload_quota_mb, user.upload_max_files]);

  const update = async (data: Parameters<typeof api.admin.updateUser>[1]) => {
    try {
      await api.admin.updateUser(user.id, data);
      invalidate(["admin", "users"]);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const access = new Map(user.access.map((a) => [a.library_id, a.can_write]));
  const setAccess = async (libId: number, read: boolean, write: boolean) => {
    const next = new Map(access);
    if (!read) next.delete(libId);
    else next.set(libId, write);
    try {
      await api.admin.setAccess(
        user.id,
        [...next].map(([library_id, can_write]) => ({ library_id, can_write })),
      );
      invalidate(["admin"]);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const shared = libs.filter((l) => !l.owner || l.owner.id !== user.id);
  const personal = libs.find((l) => l.owner?.id === user.id && l.kind === "music");
  const openCount = user.is_admin ? libs.filter((l) => !l.owner).length : shared.filter((l) => access.has(l.id)).length;

  return (
    <Card className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" onClick={() => setEditOpen(true)} aria-label="Изменить профиль" className="rounded-full transition hover:opacity-85">
          <Avatar name={user.display_name || user.username} src={user.avatar} className="size-14 text-xl" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-extrabold">{user.display_name || user.username}</h2>
          <div className="truncate text-sm text-muted">
            {user.username} · {user.email} · вход {formatDate(user.last_seen_at)}
          </div>
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="size-4" /> Изменить
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setPwOpen(true)}>
            <KeyRound className="size-4" /> Пароль
          </Button>
          {user.id !== me && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Удалить пользователя"
              onClick={async () => {
                const ok = await dialogs.confirm({
                  title: `Удалить ${user.username}?`,
                  text: "Удалятся его плейлисты, избранное, история и личная папка в медиатеке (файлы на диске останутся).",
                  action: "Удалить",
                  danger: true,
                });
                if (ok) api.admin.deleteUser(user.id).then(() => invalidate(["admin"])).catch((e) => toast.error((e as Error).message));
              }}
            >
              <Trash className="size-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-2xl bg-surface-2/60 p-4">
          <span>
            <span className="block font-bold">Администратор</span>
            <span className="text-[13px] text-muted">Видит все общие папки, управляет сервером</span>
          </span>
          <Switch label="Администратор" checked={user.is_admin} disabled={user.id === me} onChange={(v) => update({ is_admin: v })} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-2xl bg-surface-2/60 p-4">
          <span>
            <span className="block font-bold">Активен</span>
            <span className="text-[13px] text-muted">Отключённый не сможет войти</span>
          </span>
          <Switch label="Активен" checked={user.is_active} disabled={user.id === me} onChange={(v) => update({ is_active: v })} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-2xl bg-surface-2/60 p-4 sm:col-span-2">
          <span>
            <span className="block font-bold">Может делиться ссылками</span>
            <span className="text-[13px] text-muted">
              Публичные ссылки на альбомы, папки, плейлисты и треки — только из доступных ему папок. Если выключить, его ссылки перестанут открываться.
            </span>
          </span>
          <Switch label="Может делиться ссылками" checked={user.is_admin || user.can_share} disabled={user.is_admin} onChange={(v) => update({ can_share: v })} />
        </label>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[17px] font-extrabold">Папки</h3>
          <span className="text-[13px] text-muted">
            Открыто {openCount} из {libs.filter((l) => !l.owner).length}
          </span>
        </div>
        {user.is_admin && <div className="rounded-xl bg-surface-2/60 px-4 py-3 text-sm text-muted">Администратор всегда видит общие папки и может писать в них.</div>}
        <div className="flex flex-col">
          <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] gap-3 px-1 pb-2 text-[12px] font-bold tracking-wide text-faint uppercase">
            <span>Папка</span>
            <span className="text-center">Чтение</span>
            <span className="text-center">Запись</span>
          </div>
          {shared.map((l) => {
            const read = user.is_admin ? !l.owner || access.has(l.id) : access.has(l.id);
            const write = user.is_admin ? !l.owner || Boolean(access.get(l.id)) : Boolean(access.get(l.id));
            return (
              <div key={l.id} className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-center gap-3 border-t px-1 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 truncate font-bold">
                    <Folder className={cn("size-4 shrink-0", read ? "text-accent-ink" : "text-faint")} />
                    <span className="truncate">{l.name}</span>
                    {l.owner && <Badge>личная · {l.owner.name}</Badge>}
                  </div>
                  <div className="truncate text-[12px] text-faint">
                    {l.path}
                    {!l.writable && " · на диске только чтение"}
                  </div>
                </div>
                <div className="flex justify-center">
                  <Switch
                    label={`Чтение: ${l.name}`}
                    checked={read}
                    disabled={user.is_admin && !l.owner}
                    onChange={(v) => setAccess(l.id, v, v && Boolean(access.get(l.id)))}
                  />
                </div>
                <div className="flex justify-center" title={!l.writable ? "Папка смонтирована только для чтения" : undefined}>
                  <Switch
                    label={`Запись: ${l.name}`}
                    checked={write && l.writable}
                    disabled={(user.is_admin && !l.owner) || !l.writable || !read}
                    onChange={(v) => setAccess(l.id, true, v)}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-[13px] leading-relaxed text-faint">
          Закрытая папка пропадает у пользователя из поиска, подборок и Subsonic-приложений. Плейлисты не удаляются: при повторном открытии треки
          вернутся. Запись нужна для загрузки в общую папку и редактирования тегов.
        </p>
      </section>

      {!user.is_admin && (
        <section className="flex flex-col gap-4 border-t pt-6">
          <h3 className="text-[17px] font-extrabold">Загрузка музыки</h3>
          <Segmented label="Режим загрузки" value={user.upload_mode} onChange={(v) => update({ upload_mode: v })} options={MODES} />
          {user.upload_mode !== "none" && (
            <>
              <p className="text-[13px] leading-relaxed text-muted">
                {user.upload_mode === "own"
                  ? "Пользователь загружает в личную папку — её видит только он (и те, кому вы откроете её выше)."
                  : "Пользователь загружает в личную папку и в общие папки, где у него включена «Запись»."}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  update({ upload_quota_mb: Number(quota) || 0, upload_max_files: Number(maxFiles) || 0 }).then(() => toast.success("Лимиты сохранены"));
                }}
                className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
              >
                <Field id="quota" label="Лимит объёма, МБ" hint="Пусто или 0 — без лимита">
                  <Input id="quota" inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value.replace(/\D/g, ""))} placeholder="Без лимита" />
                </Field>
                <Field id="maxfiles" label="Лимит файлов" hint="Пусто или 0 — без лимита">
                  <Input id="maxfiles" inputMode="numeric" value={maxFiles} onChange={(e) => setMaxFiles(e.target.value.replace(/\D/g, ""))} placeholder="Без лимита" />
                </Field>
                <Button type="submit" variant="secondary">
                  Сохранить
                </Button>
              </form>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">Загружено</span>
                    <span className="font-bold">
                      {formatSize(user.upload_used.bytes)}
                      {user.upload_quota_mb ? ` из ${formatSize(user.upload_quota_mb * 1024 * 1024)}` : ""}
                    </span>
                  </div>
                  {user.upload_quota_mb > 0 && <Progress value={(user.upload_used.bytes / (user.upload_quota_mb * 1024 * 1024)) * 100} />}
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">Файлов</span>
                    <span className="font-bold">
                      {user.upload_used.files}
                      {user.upload_max_files ? ` из ${user.upload_max_files}` : ""}
                    </span>
                  </div>
                  {user.upload_max_files > 0 && <Progress value={(user.upload_used.files / user.upload_max_files) * 100} />}
                </div>
              </div>
              {personal && <p className="text-[13px] text-faint">Личная папка: {personal.path}</p>}
            </>
          )}
        </section>
      )}

      <Dialog
        open={pwOpen}
        onClose={() => setPwOpen(false)}
        title={`Новый пароль для ${user.username}`}
        description="Пользователь выйдет на всех устройствах"
        footer={
          <Button
            type="submit"
            form="reset-form"
            disabled={pw.length < 8}
          >
            Сменить пароль
          </Button>
        }
      >
        <form
          id="reset-form"
          onSubmit={(e) => {
            e.preventDefault();
            api.admin
              .resetPassword(user.id, pw)
              .then(() => {
                toast.success("Пароль изменён");
                setPw("");
                setPwOpen(false);
              })
              .catch((err) => toast.error((err as Error).message));
          }}
        >
          <Field id="reset-pw" label="Пароль" hint="Минимум 8 символов">
            <Input id="reset-pw" type="text" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
        </form>
      </Dialog>
      <EditUserDialog open={editOpen} onClose={() => setEditOpen(false)} user={user} isMe={user.id === me} />
    </Card>
  );
}

/** Имя, логин, email и аватарка пользователя — для администратора. */
function EditUserDialog({ open, onClose, user, isMe }: { open: boolean; onClose: () => void; user: AdminUser; isMe: boolean }) {
  const [form, setForm] = useState({ display_name: user.display_name, username: user.username, email: user.email });
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setForm({ display_name: user.display_name, username: user.username, email: user.email });
  }, [open, user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const done = (u: AdminUser) => {
    invalidate(["admin"], ["playlists"]);
    if (isMe) updateCurrentUser(u);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      done(await api.admin.updateUser(user.id, form));
      toast.success("Сохранено");
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const loginChanged = form.username !== user.username;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Профиль пользователя"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" form="edit-user" disabled={busy}>
            {busy && <LoaderCircle className="size-4 animate-spin" />} Сохранить
          </Button>
        </>
      }
    >
      <form id="edit-user" onSubmit={submit} className="grid gap-5">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={form.display_name || form.username} src={user.avatar} className="size-20 text-3xl" />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
              <ImageIcon className="size-4" /> {user.avatar ? "Заменить фото" : "Загрузить фото"}
            </Button>
            {user.avatar && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  try {
                    done(await api.admin.deleteUserAvatar(user.id));
                  } catch (err) {
                    toast.error((err as Error).message);
                  }
                }}
              >
                <Trash className="size-4" /> Удалить
              </Button>
            )}
          </div>
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) setFile(f);
            }}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="eu-name" label="Имя">
            <Input id="eu-name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
          </Field>
          <Field
            id="eu-login"
            label="Логин"
            hint={loginChanged ? "Для входа и в Subsonic-приложениях нужно будет указать новый логин" : "Латиница, цифры, точка, дефис"}
          >
            <Input
              id="eu-login"
              required
              pattern="[a-zA-Z0-9_.\-]{3,64}"
              autoCapitalize="none"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value.trim() })}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field id="eu-email" label="Email">
              <Input id="eu-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
          </div>
        </div>
      </form>
      <AvatarCropper
        file={file}
        onCancel={() => setFile(null)}
        onDone={async (blob) => {
          try {
            done(await api.admin.uploadUserAvatar(user.id, blob));
            setFile(null);
            toast.success("Аватарка обновлена");
          } catch (err) {
            toast.error((err as Error).message);
          }
        }}
      />
    </Dialog>
  );
}

function CreateUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const empty = { username: "", display_name: "", email: "", password: "", is_admin: false, upload_mode: "none" as UploadMode, upload_quota_mb: 0, upload_max_files: 0, can_share: false };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setForm(empty);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const u = await api.admin.createUser(form);
      invalidate(["admin"]);
      toast.success(`Пользователь ${u.username} создан`);
      onCreated(u.id);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Новый пользователь"
      description="Папки с пометкой «для новых пользователей» откроются автоматически"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" form="new-user" disabled={busy}>
            {busy && <LoaderCircle className="size-4 animate-spin" />} Создать
          </Button>
        </>
      }
    >
      <form id="new-user" onSubmit={submit} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="nu-login" label="Логин">
            <Input id="nu-login" required pattern="[a-zA-Z0-9_.\-]{3,64}" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </Field>
          <Field id="nu-name" label="Имя">
            <Input id="nu-name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
          </Field>
        </div>
        <Field id="nu-email" label="Email">
          <Input id="nu-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field id="nu-pw" label="Пароль" hint="Минимум 8 символов, пользователь сможет сменить его в профиле">
          <Input id="nu-pw" required minLength={8} autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field id="nu-mode" label="Загрузка музыки">
          <Select id="nu-mode" value={form.upload_mode} onChange={(e) => setForm({ ...form, upload_mode: e.target.value as UploadMode })}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center justify-between gap-3 rounded-2xl border p-4">
          <span className="font-bold">Может делиться ссылками</span>
          <Switch label="Может делиться ссылками" checked={form.can_share} onChange={(v) => setForm({ ...form, can_share: v })} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-2xl border p-4">
          <span className="font-bold">Администратор</span>
          <Switch label="Администратор" checked={form.is_admin} onChange={(v) => setForm({ ...form, is_admin: v })} />
        </label>
      </form>
    </Dialog>
  );
}

function UsersTab() {
  const { user: me } = useAuth();
  const users = useQuery(["admin", "users"], api.admin.users);
  const libs = useQuery(["admin", "libraries"], api.admin.libraries);
  const settings = useQuery(["admin", "settings"], api.admin.settings);
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  if (users.isLoading || libs.isLoading) return <PageLoader />;
  if (users.error) return <ErrorBox error={users.error} />;
  const list = users.data!;
  const current = list.find((u) => u.id === selected) ?? list.find((u) => u.id !== me?.id) ?? list[0];

  return (
    <div className="grid gap-5">
      <Card className="flex flex-wrap items-center gap-4">
        <div className="min-w-60 flex-1">
          <div className="text-[16px] font-extrabold">Свободная регистрация</div>
          <div className="text-sm text-muted">
            {settings.data?.registration_mode === "open" ? "Любой может создать аккаунт по ссылке." : "Закрыта. Новых пользователей добавляете вы."}
          </div>
        </div>
        <Switch
          label="Свободная регистрация"
          checked={settings.data?.registration_mode === "open"}
          onChange={(v) =>
            api.admin
              .updateSettings({ registration_mode: v ? "open" : "closed" })
              .then(() => invalidate(["admin", "settings"], ["settings"]))
              .catch((e) => toast.error((e as Error).message))
          }
        />
        <Button variant="secondary" onClick={() => setCreating(true)}>
          <UserPlus className="size-4" /> Добавить
        </Button>
      </Card>
      <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="flex flex-col gap-0.5 p-2 sm:p-2">
          {list.map((u) => (
            <button
              key={u.id}
              onClick={() => setSelected(u.id)}
              aria-pressed={current?.id === u.id}
              className={cn("flex items-center gap-3 rounded-2xl p-3 text-left transition", current?.id === u.id ? "bg-surface-2" : "hover:bg-surface-2/60")}
            >
              <Avatar name={u.display_name || u.username} src={u.avatar} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate font-bold">
                  {u.display_name || u.username}
                  {!u.is_active && <Lock className="size-3.5 text-faint" />}
                </span>
                <span className="block truncate text-[13px] text-muted">{u.username}</span>
              </span>
              <span className={cn("text-[12px] font-bold", u.is_admin ? "text-accent-ink" : "text-faint")}>
                {u.is_admin ? "Админ" : u.upload_mode !== "none" ? "Загрузка" : u.can_share ? "Ссылки" : "Слушатель"}
              </span>
            </button>
          ))}
        </Card>
        {current && <UserDetail user={current} libs={libs.data ?? []} me={me?.id ?? 0} />}
      </div>
      <CreateUserDialog open={creating} onClose={() => setCreating(false)} onCreated={setSelected} />
    </div>
  );
}

// ---------------- дубликаты ----------------

function DuplicatesTab() {
  const [strict, setStrict] = useState(true);
  const q = useQuery(["admin", "duplicates", strict], () => api.admin.duplicates(strict), { staleTime: 0 });
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => setPicked(new Set()), [strict]);

  const data: DuplicatesResult | undefined = q.data;
  const toggle = (id: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const pickAllWorse = () => {
    const n = new Set<number>();
    data?.groups.forEach((g) => g.tracks.forEach((t) => !t.best && t.can_delete && n.add(t.id)));
    setPicked(n);
  };
  const pickedSize = data?.groups.flatMap((g) => g.tracks).filter((t) => picked.has(t.id)).reduce((a, t) => a + t.size, 0) ?? 0;

  const remove = async () => {
    const ok = await dialogs.confirm({
      title: `Удалить ${countLabel(picked.size, "файл", "файла", "файлов")}?`,
      text: `Файлы будут удалены с диска (${formatSize(pickedSize)}). Это нельзя отменить.`,
      action: "Удалить",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    let failed = 0;
    for (const id of picked) {
      try {
        await api.uploads.deleteTrack(id);
      } catch {
        failed++;
      }
    }
    setBusy(false);
    setPicked(new Set());
    if (failed) toast.error(`Не удалось удалить ${countLabel(failed, "файл", "файла", "файлов")}`);
    else toast.success("Удалено");
    invalidate(["admin", "duplicates"], ["home"], ["albums"]);
  };

  const ignore = async (key: string) => {
    await api.admin.ignoreDuplicate(key);
    invalidate(["admin", "duplicates"]);
  };

  return (
    <div className="flex flex-col gap-5">
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-extrabold">Поиск дубликатов</h2>
            <p className="text-sm text-muted">
              Одинаковые артист и название трека. Лучшая копия (без потерь, выше битрейт) отмечена — её стоит оставить.
            </p>
          </div>
          <Segmented<"strict" | "loose">
            label="Режим"
            value={strict ? "strict" : "loose"}
            onChange={(v) => setStrict(v === "strict")}
            options={[
              { value: "strict", label: "Строго" },
              { value: "loose", label: "Мягко" },
            ]}
          />
        </div>
        <p className="text-[13px] text-faint">
          «Строго» — длительность совпадает до 3 секунд. «Мягко» — найдёт и разные версии (live, ремастер), проверяйте внимательнее.
        </p>
        {data && data.count > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm">
              {countLabel(data.count, "группа", "группы", "групп")} · можно освободить до <b>{formatSize(data.reclaimable)}</b>
            </span>
            <Button variant="secondary" size="sm" onClick={pickAllWorse}>
              Отметить все худшие копии
            </Button>
            {picked.size > 0 && (
              <Button variant="danger" size="sm" onClick={remove} disabled={busy}>
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Trash className="size-4" />}
                Удалить {picked.size} ({formatSize(pickedSize)})
              </Button>
            )}
          </div>
        )}
      </Card>

      {q.isLoading ? (
        <PageLoader />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : !data?.groups.length ? (
        <Card className="p-8 text-center text-muted">Дубликатов не найдено 🎉</Card>
      ) : (
        data.groups.map((g) => (
          <Card key={g.key} className="flex flex-col gap-1 p-4">
            <div className="flex items-start justify-between gap-3 px-1 pb-2">
              <div className="min-w-0">
                <div className="truncate font-bold">{g.title}</div>
                <div className="truncate text-sm text-muted">{g.artist}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => ignore(g.key)}>
                Не дубликат
              </Button>
            </div>
            {g.tracks.map((t) => (
              <label
                key={t.id}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-2 py-2",
                  t.can_delete ? "cursor-pointer hover:bg-surface-2/60" : "opacity-80",
                  picked.has(t.id) && "bg-danger/10",
                )}
              >
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-[var(--color-danger)]"
                  disabled={!t.can_delete}
                  checked={picked.has(t.id)}
                  onChange={() => toggle(t.id)}
                  aria-label="Удалить эту копию"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-[14px]">
                    <b>{t.quality}</b>
                    <span className="text-faint">{formatDuration(t.duration)} · {formatSize(t.size)}</span>
                    {t.best && <Badge>лучшая</Badge>}
                    {!t.can_delete && <span className="text-[12px] text-faint">папка только для чтения</span>}
                  </span>
                  <span className="block truncate text-[12px] text-faint" title={t.path}>
                    <Link to={`/albums/${t.album_id}`} className="hover:underline">
                      {t.album}
                    </Link>{" "}
                    · {t.library} · {t.path}
                  </span>
                </span>
              </label>
            ))}
          </Card>
        ))
      )}
    </div>
  );
}

export default function AdminPage() {
  const params = useSearchParams();
  const tab = (params.get("tab") as Tab) || "users";
  return (
    <div className="flex flex-col gap-7">
      <PageHeader title="Управление" />
      <div className="scrollbar-none -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <Segmented<Tab>
        label="Раздел"
        value={tab}
        onChange={(t) => setSearchParam("tab", t)}
        className="w-max min-w-full flex-nowrap sm:max-w-xl sm:min-w-0"
        options={[
          { value: "users", label: "Пользователи" },
          { value: "libraries", label: "Папки" },
          { value: "duplicates", label: "Дубликаты" },
          { value: "general", label: "Общие" },
        ]}
      />
      </div>
      {tab === "users" && <UsersTab />}
      {tab === "libraries" && <LibrariesTab />}
      {tab === "duplicates" && <DuplicatesTab />}
      {tab === "general" && <GeneralTab />}
    </div>
  );
}
