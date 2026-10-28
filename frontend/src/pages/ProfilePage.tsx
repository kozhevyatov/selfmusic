import { useEffect, useRef, useState, type FormEvent } from "react";
import { AvatarCropper } from "@/components/AvatarCropper";
import { EqualizerDialog, SoundSettingsCard } from "@/components/SoundSettings";
import { Avatar } from "@/components/Cover";
import { Check, Copy, Eye, EyeOff, Image as ImageIcon, KeyRound, LoaderCircle, LogOut, Monitor, Moon, RefreshCw, Smartphone, Sun, Trash } from "@/components/icons";
import { PageHeader } from "@/components/Section";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/switch";
import { api, setSession, updateCurrentUser, type Quality } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dialogs } from "@/lib/dialogs";
import { navigate } from "@/lib/router";
import { ACCENTS, setAccent, setMotion, setThemeMode, useTheme, type Motion, type ThemeMode } from "@/lib/theme";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

function CopyField({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Не удалось скопировать");
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-bold text-muted">{label}</span>
      <div className="flex items-center gap-1 rounded-xl border bg-surface pl-3.5">
        <code className="min-w-0 flex-1 truncate py-2.5 font-mono text-[14px]">{shown ? value : "•".repeat(Math.min(16, value.length))}</code>
        {secret && (
          <button aria-label={shown ? "Скрыть" : "Показать"} onClick={() => setShown(!shown)} className="flex size-10 items-center justify-center text-muted hover:text-fg">
            {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        )}
        <button aria-label={`Скопировать: ${label}`} onClick={copy} className="flex size-10 items-center justify-center text-muted hover:text-fg">
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  );
}

function AppAccess() {
  const [data, setData] = useState<{ username: string; password: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.me.appPassword().then(setData).catch(() => setData(null));
  }, []);
  const regenerate = async () => {
    if (
      data?.password &&
      !(await dialogs.confirm({
        title: "Создать новый пароль?",
        text: "Старый пароль перестанет работать во всех приложениях — их нужно будет перенастроить.",
        action: "Создать",
      }))
    )
      return;
    setBusy(true);
    try {
      setData(await api.me.regenerateAppPassword());
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const server = window.location.origin;
  return (
    <Card className="flex flex-col gap-5">
      <div className="flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-accent text-accent-fg">
          <Smartphone className="size-6" />
        </span>
        <div>
          <h2 className="text-lg font-extrabold">Приложения на телефоне и компьютере</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Сервер совместим с Subsonic/OpenSubsonic. Подойдут <b>Symfonium</b>, <b>Tempo</b>, <b>DSub</b> (Android), <b>Amperfy</b>,{" "}
            <b>play:Sub</b>, <b>Substreamer</b> (iPhone), <b>Feishin</b> (компьютер). В приложении выберите тип сервера Subsonic/Navidrome и
            введите данные ниже.
          </p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <CopyField label="Адрес сервера" value={server} />
        <CopyField label="Логин" value={data?.username ?? "…"} />
      </div>
      {data?.password ? (
        <CopyField label="Пароль для приложений" value={data.password} secret />
      ) : (
        <p className="rounded-2xl bg-surface-2/70 p-4 text-sm leading-relaxed text-muted">
          Отдельный пароль для приложений ещё не создан. Он нужен, потому что протокол Subsonic требует хранить пароль в обратимом виде — ваш основной
          пароль так не хранится.
        </p>
      )}
      <div>
        <Button variant={data?.password ? "secondary" : "primary"} onClick={regenerate} disabled={busy}>
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : data?.password ? <RefreshCw className="size-4" /> : <KeyRound className="size-4" />}
          {data?.password ? "Создать новый пароль" : "Создать пароль для приложений"}
        </Button>
      </div>
    </Card>
  );
}

function AvatarCard() {
  const { user } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  if (!user) return null;
  const name = user.display_name || user.username;
  const remove = async () => {
    try {
      updateCurrentUser(await api.me.deleteAvatar());
      toast.success("Аватарка удалена");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <Card className="flex flex-wrap items-center gap-5">
      <Avatar name={name} src={user.avatar} className="size-24 text-4xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <h2 className="text-lg font-extrabold">Аватарка</h2>
          <p className="text-sm text-muted">JPG, PNG или WebP. Обрежем в квадрат — выберите нужную часть.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => input.current?.click()}>
            <ImageIcon className="size-4" /> {user.avatar ? "Заменить" : "Загрузить фото"}
          </Button>
          {user.avatar && (
            <Button variant="ghost" onClick={remove}>
              <Trash className="size-4" /> Удалить
            </Button>
          )}
        </div>
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
      <AvatarCropper
        file={file}
        onCancel={() => setFile(null)}
        onDone={async (blob) => {
          updateCurrentUser(await api.me.uploadAvatar(blob));
          setFile(null);
          toast.success("Аватарка обновлена");
        }}
      />
    </Card>
  );
}

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const theme = useTheme();
  const [form, setForm] = useState({ display_name: user?.display_name ?? "", email: user?.email ?? "" });
  const [pw, setPw] = useState({ current: "", next: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [eqOpen, setEqOpen] = useState(false);

  if (!user) return null;

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("profile");
    try {
      updateCurrentUser(await api.me.update(form));
      toast.success("Сохранено");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const setQuality = async (q: Quality) => {
    try {
      updateCurrentUser(await api.me.update({ stream_quality: q }));
      toast.success(q === "original" ? "Музыка будет играть в исходном качестве" : `Поток: MP3 ${q} кбит/с`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("password");
    try {
      setSession(await api.me.changePassword(pw.current, pw.next));
      setPw({ current: "", next: "" });
      toast.success("Пароль изменён. На других устройствах нужно войти заново.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="Профиль" subtitle={`${user.username}${user.is_admin ? " · администратор" : ""}`} />

      <AvatarCard />

      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-extrabold">Звук</h2>
          <p className="text-sm text-muted">Для этого устройства: на телефоне и компьютере можно настроить по-разному.</p>
        </div>
        <SoundSettingsCard onOpenEq={() => setEqOpen(true)} />
        <EqualizerDialog open={eqOpen} onClose={() => setEqOpen(false)} />
      </Card>

      <Card className="flex flex-col gap-5">
        <h2 className="text-lg font-extrabold">Оформление</h2>
        <Segmented<ThemeMode>
          label="Тема"
          value={theme.mode}
          onChange={setThemeMode}
          className="max-w-md"
          options={[
            { value: "dark", label: "Тёмная" },
            { value: "light", label: "Светлая" },
            { value: "system", label: "Как в системе" },
          ]}
        />
        <div className="flex flex-wrap items-center gap-3">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              onClick={() => setAccent(a.id)}
              aria-pressed={theme.accent === a.id}
              className={cn(
                "flex h-11 items-center gap-2.5 rounded-full border-2 pr-4 pl-1.5 text-sm font-bold transition",
                theme.accent === a.id ? "border-fg" : "border-transparent bg-surface-2 hover:bg-surface-3",
              )}
            >
              <span className="size-7 rounded-full" style={{ background: a.color }} />
              {a.label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-[15px] font-bold">Анимация фона</div>
          <Segmented<Motion>
            label="Анимация фона"
            value={theme.motion}
            onChange={setMotion}
            className="max-w-md"
            options={[
              { value: "smooth", label: "Плавная" },
              { value: "eco", label: "Экономная" },
              { value: "off", label: "Без анимации" },
            ]}
          />
          <p className="text-[13px] text-muted">
            {theme.motion === "smooth"
              ? "60 кадров в секунду — красиво, но на ноутбуке греет видеокарту и тратит батарею."
              : theme.motion === "eco"
                ? "Фон сдвигается раз в секунду — движение медленное, на глаз почти так же, а нагрузка в 10 раз меньше."
                : "Фон неподвижен."}
          </p>
        </div>
        <div className="flex gap-2 text-faint">
          <Moon className="size-4" />
          <Sun className="size-4" />
          <Monitor className="size-4" />
          <span className="text-xs">Тема и цвет сохраняются на этом устройстве.</span>
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-extrabold">Качество потока в браузере</h2>
          <p className="mt-1 text-sm text-muted">Если слушаете не из дома, уменьшите битрейт — сервер перекодирует на лету. Форматы, которые браузер не умеет играть, всегда перекодируются.</p>
        </div>
        <Select aria-label="Качество потока" value={user.stream_quality} onChange={(e) => setQuality(e.target.value as Quality)} className="max-w-sm">
          <option value="original">Оригинал (без потерь, если файл FLAC)</option>
          <option value="320">MP3 320 кбит/с</option>
          <option value="192">MP3 192 кбит/с</option>
          <option value="128">MP3 128 кбит/с — экономия трафика</option>
        </Select>
      </Card>

      <AppAccess />

      <Card>
        <form onSubmit={saveProfile} className="grid gap-5">
          <h2 className="text-lg font-extrabold">Данные</h2>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="p-name" label="Имя">
              <Input id="p-name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
            </Field>
            <Field id="p-email" label="Email">
              <Input id="p-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
          </div>
          <div>
            <Button type="submit" disabled={busy === "profile"}>
              {busy === "profile" && <LoaderCircle className="size-4 animate-spin" />} Сохранить
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <form onSubmit={changePassword} className="grid gap-5">
          <h2 className="text-lg font-extrabold">Пароль</h2>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="p-cur" label="Текущий пароль">
              <Input id="p-cur" type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            </Field>
            <Field id="p-new" label="Новый пароль" hint="Минимум 8 символов">
              <Input id="p-new" type="password" autoComplete="new-password" required minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy === "password"}>
              {busy === "password" && <LoaderCircle className="size-4 animate-spin" />} Сменить пароль
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                await api.auth.logoutAll().catch(() => {});
                await logout();
                navigate("/login");
              }}
            >
              <LogOut className="size-4" /> Выйти на всех устройствах
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
