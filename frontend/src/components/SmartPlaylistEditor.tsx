import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Segmented } from "@/components/ui/switch";
import { api, type Playlist, type SmartRule, type SmartRules, type Track } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { invalidate } from "@/lib/query";
import { navigate } from "@/lib/router";
import { toast } from "@/lib/toast";
import { Cover } from "./Cover";
import { LoaderCircle, Plus, Sparkles, X } from "./icons";

type Kind = "text" | "number" | "date" | "bool";

const FIELDS: { id: string; label: string; kind: Kind; hint?: string }[] = [
  { id: "genre", label: "Жанр", kind: "text" },
  { id: "artist", label: "Исполнитель", kind: "text" },
  { id: "album", label: "Альбом", kind: "text" },
  { id: "title", label: "Название", kind: "text" },
  { id: "format", label: "Формат файла", kind: "text", hint: "flac, mp3…" },
  { id: "path", label: "Путь к файлу", kind: "text" },
  { id: "year", label: "Год", kind: "number" },
  { id: "rating", label: "Оценка", kind: "number", hint: "0–5" },
  { id: "plays", label: "Сколько раз слушал", kind: "number" },
  { id: "duration", label: "Длительность, сек", kind: "number" },
  { id: "bitrate", label: "Битрейт, кбит/с", kind: "number" },
  { id: "bpm", label: "Темп, BPM", kind: "number", hint: "по анализу звука" },
  { id: "energy", label: "Энергия, %", kind: "number", hint: "0 — спокойно, 100 — мощно" },
  { id: "mood", label: "Настроение, %", kind: "number", hint: "0 — грустно, 100 — радостно" },
  { id: "added", label: "Добавлен в медиатеку", kind: "date" },
  { id: "last_played", label: "Последний раз слушал", kind: "date" },
  { id: "starred", label: "В избранном", kind: "bool" },
  { id: "lossless", label: "Без потерь (FLAC и т. п.)", kind: "bool" },
];

const OPS: Record<Kind, { id: string; label: string }[]> = {
  text: [
    { id: "contains", label: "содержит" },
    { id: "not_contains", label: "не содержит" },
    { id: "is", label: "равно" },
    { id: "is_not", label: "не равно" },
    { id: "starts", label: "начинается с" },
  ],
  number: [
    { id: "gte", label: "не меньше" },
    { id: "lte", label: "не больше" },
    { id: "eq", label: "равно" },
    { id: "ne", label: "не равно" },
    { id: "between", label: "от … до" },
  ],
  date: [
    { id: "in_last", label: "за последние N дней" },
    { id: "not_in_last", label: "не за последние N дней" },
    { id: "never", label: "никогда" },
  ],
  bool: [
    { id: "is_true", label: "да" },
    { id: "is_false", label: "нет" },
  ],
};

const SORTS = [
  { id: "random", label: "Случайно" },
  { id: "added", label: "Сначала новые в медиатеке" },
  { id: "played", label: "Недавно слушал" },
  { id: "plays", label: "Чаще всего слушал" },
  { id: "rating", label: "По оценке" },
  { id: "year", label: "По году (новые раньше)" },
  { id: "artist", label: "По исполнителю" },
  { id: "title", label: "По названию" },
  { id: "energy", label: "По энергии" },
];

/** Готовые примеры — чтобы не начинать с чистого листа */
const PRESETS: { label: string; name: string; rules: SmartRules }[] = [
  {
    label: "Забытые любимые",
    name: "Забытые любимые",
    rules: { match: "all", sort: "random", limit: 100, rules: [{ field: "starred", op: "is_true", value: null }, { field: "last_played", op: "not_in_last", value: 60 }] },
  },
  {
    label: "Лучшее (оценка 4+)",
    name: "Лучшее",
    rules: { match: "all", sort: "rating", limit: 200, rules: [{ field: "rating", op: "gte", value: 4 }] },
  },
  {
    label: "Новинки за месяц",
    name: "Новое за месяц",
    rules: { match: "all", sort: "added", limit: 100, rules: [{ field: "added", op: "in_last", value: 30 }] },
  },
  {
    label: "Ни разу не слушал",
    name: "Ещё не слушал",
    rules: { match: "all", sort: "random", limit: 100, rules: [{ field: "plays", op: "eq", value: 0 }] },
  },
  {
    label: "Рок 80-х",
    name: "Рок 80-х",
    rules: { match: "all", sort: "random", limit: 100, rules: [{ field: "genre", op: "contains", value: "rock" }, { field: "year", op: "between", value: [1980, 1989] }] },
  },
  {
    label: "Hi-Res и без потерь",
    name: "Без потерь",
    rules: { match: "all", sort: "random", limit: 200, rules: [{ field: "lossless", op: "is_true", value: null }] },
  },
];

const EMPTY: SmartRules = { match: "all", sort: "random", limit: 100, rules: [{ field: "genre", op: "contains", value: "" }] };

function kindOf(field: string): Kind {
  return FIELDS.find((f) => f.id === field)?.kind ?? "text";
}

function defaultValue(kind: Kind, op: string): SmartRule["value"] {
  if (kind === "bool" || op === "never") return null;
  if (op === "between") return [0, 0];
  if (kind === "date") return 30;
  if (kind === "number") return 0;
  return "";
}

function RuleRow({ rule, onChange, onRemove }: { rule: SmartRule; onChange: (r: SmartRule) => void; onRemove?: () => void }) {
  const kind = kindOf(rule.field);
  const field = FIELDS.find((f) => f.id === rule.field);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface-2/60 p-2.5">
      <div className="w-full sm:w-52">
        <Select
          aria-label="Поле"
          value={rule.field}
          onChange={(e) => {
            const k = kindOf(e.target.value);
            const op = OPS[k][0].id;
            onChange({ field: e.target.value, op, value: defaultValue(k, op) });
          }}
        >
          {FIELDS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-44">
        <Select aria-label="Условие" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value, value: defaultValue(kind, e.target.value) })}>
          {OPS[kind].map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      {kind === "text" && (
        <div className="min-w-40 flex-1">
          <Input aria-label="Значение" placeholder={field?.hint ?? "текст"} value={String(rule.value ?? "")} onChange={(e) => onChange({ ...rule, value: e.target.value })} />
        </div>
      )}
      {(kind === "number" || kind === "date") && rule.op !== "never" && rule.op !== "between" && (
        <div className="w-32">
          <Input
            aria-label="Значение"
            type="number"
            placeholder={field?.hint}
            value={String(rule.value ?? 0)}
            onChange={(e) => onChange({ ...rule, value: Number(e.target.value) })}
          />
        </div>
      )}
      {rule.op === "between" && (
        <div className="flex items-center gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="w-28">
              <Input
                aria-label={i ? "до" : "от"}
                type="number"
                value={String((rule.value as number[])?.[i] ?? 0)}
                onChange={(e) => {
                  const v = [...((rule.value as number[]) ?? [0, 0])];
                  v[i] = Number(e.target.value);
                  onChange({ ...rule, value: v });
                }}
              />
            </div>
          ))}
        </div>
      )}
      {kind === "date" && rule.op !== "never" && <span className="text-sm text-muted">дн.</span>}
      {onRemove && (
        <button type="button" aria-label="Убрать условие" onClick={onRemove} className="ml-auto flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-3 hover:text-fg">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

export function SmartPlaylistEditor({ open, onClose, playlist }: { open: boolean; onClose: () => void; playlist?: Playlist }) {
  const [name, setName] = useState("");
  const [rules, setRules] = useState<SmartRules>(EMPTY);
  const [preview, setPreview] = useState<{ count: number; duration: number; tracks: Track[] } | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(playlist?.name ?? "");
    setRules(playlist?.rules ?? EMPTY);
  }, [open, playlist]);

  // живой предпросмотр
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      api.playlists
        .preview(rules)
        .then((r) => {
          setPreview(r);
          setPreviewErr(null);
        })
        .catch((e) => setPreviewErr((e as Error).message));
    }, 350);
    return () => window.clearTimeout(t);
  }, [rules, open]);

  const setRule = (i: number, r: SmartRule) => setRules({ ...rules, rules: rules.rules.map((x, j) => (j === i ? r : x)) });

  const save = async () => {
    setBusy(true);
    try {
      if (playlist) {
        await api.playlists.update(playlist.id, { name: name.trim(), rules });
        invalidate(["playlists"], ["playlist", playlist.id]);
        onClose();
      } else {
        const pl = await api.playlists.create({ name: name.trim(), rules });
        invalidate(["playlists"]);
        onClose();
        navigate(`/playlists/${pl.id}`);
      }
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
      title={playlist ? "Правила умного плейлиста" : "Умный плейлист"}
      description="Треки подбираются по условиям и обновляются сами: добавили музыку, поставили оценку, послушали — состав меняется."
      footer={
        <>
          <span className="mr-auto self-center text-sm text-muted">
            {previewErr ? <span className="text-danger">{previewErr}</span> : preview ? `${preview.count} тр. · ${formatDuration(preview.duration)}` : "Считаю…"}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={save} disabled={!name.trim() || busy || !rules.rules.length}>
            {busy && <LoaderCircle className="size-4 animate-spin" />} {playlist ? "Сохранить" : "Создать"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {!playlist && (
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setRules(p.rules);
                  if (!name.trim()) setName(p.name);
                }}
                className="flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3.5 text-[13px] font-bold hover:bg-surface-3"
              >
                <Sparkles className="size-3.5 text-accent-ink" /> {p.label}
              </button>
            ))}
          </div>
        )}
        <Field id="smart-name" label="Название">
          <Input id="smart-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, «Рок 80-х»" />
        </Field>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-bold">Треки, у которых выполняются</span>
          <Segmented<"all" | "any">
            label="Совпадение"
            value={rules.match}
            onChange={(m) => setRules({ ...rules, match: m })}
            options={[
              { value: "all", label: "все условия" },
              { value: "any", label: "любое из условий" },
            ]}
          />
        </div>
        <div className="flex flex-col gap-2">
          {rules.rules.map((r, i) => (
            <RuleRow
              key={i}
              rule={r}
              onChange={(nr) => setRule(i, nr)}
              onRemove={rules.rules.length > 1 ? () => setRules({ ...rules, rules: rules.rules.filter((_, j) => j !== i) }) : undefined}
            />
          ))}
          {rules.rules.length < 20 && (
            <button
              type="button"
              onClick={() => setRules({ ...rules, rules: [...rules.rules, { field: "year", op: "gte", value: 2000 }] })}
              className="flex h-10 items-center gap-2 self-start rounded-full px-3 text-sm font-bold text-accent-ink hover:bg-surface-2"
            >
              <Plus className="size-4" /> Добавить условие
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted">Порядок</span>
          <div className="w-60">
            <Select aria-label="Порядок" value={rules.sort} onChange={(e) => setRules({ ...rules, sort: e.target.value })}>
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          <span className="text-muted">не больше</span>
          <div className="w-24">
            <Input
              aria-label="Не больше треков"
              type="number"
              min={1}
              max={1000}
              value={rules.limit}
              onChange={(e) => setRules({ ...rules, limit: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })}
            />
          </div>
          <span className="text-muted">треков</span>
        </div>
        {preview && preview.tracks.length > 0 && (
          <div className="flex flex-col gap-1 rounded-2xl border p-2">
            <div className="label-caps px-2 pt-1 pb-1">Сейчас попадают</div>
            {preview.tracks.slice(0, 8).map((t) => (
              <div key={t.id} className="flex items-center gap-3 rounded-lg px-2 py-1">
                <Cover src={t.cover} seed={t.album} size={64} rounded="rounded-md" className="size-8 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  <b>{t.title}</b> <span className="text-muted">· {t.artist}</span>
                </span>
                <span className="text-xs text-faint">{t.year ?? ""}</span>
              </div>
            ))}
            {preview.count > 8 && <div className="px-2 pb-1 text-xs text-faint">и ещё {preview.count - 8}</div>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
