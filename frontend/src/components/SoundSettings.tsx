import { useRef, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EQ_BANDS, EQ_PRESETS, isIOS, setAudioSettings, useAudioSettings } from "@/lib/audio";
import { cn } from "@/lib/utils";
import { Info } from "./icons";

const MAX_DB = 12;

function bandLabel(f: number) {
  return f >= 1000 ? `${f / 1000}k` : String(f);
}

/** Вертикальный ползунок полосы эквалайзера: тянуть мышью/пальцем, стрелки на клавиатуре */
function BandSlider({ value, onChange, label, disabled }: { value: number; onChange: (v: number) => void; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const fromPointer = (e: RPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const k = 1 - (e.clientY - r.top) / r.height; // 0 снизу … 1 сверху
    const v = Math.round((k * 2 - 1) * MAX_DB * 2) / 2;
    onChange(Math.max(-MAX_DB, Math.min(MAX_DB, v)));
  };
  const pct = ((value + MAX_DB) / (MAX_DB * 2)) * 100;
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="num h-4 text-[11px] font-bold text-muted">{value > 0 ? `+${value}` : value}</span>
      <div
        ref={ref}
        role="slider"
        aria-label={`${label} Гц`}
        aria-valuemin={-MAX_DB}
        aria-valuemax={MAX_DB}
        aria-valuenow={value}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => !disabled && e.buttons && fromPointer(e)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowUp" || e.key === "ArrowRight") onChange(Math.min(MAX_DB, value + 1));
          if (e.key === "ArrowDown" || e.key === "ArrowLeft") onChange(Math.max(-MAX_DB, value - 1));
          if (e.key === "Home" || e.key === "0") onChange(0);
        }}
        onDoubleClick={() => !disabled && onChange(0)}
        className={cn("relative h-44 w-7 cursor-ns-resize touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent", disabled && "cursor-default opacity-40")}
      >
        <div className="absolute inset-y-0 left-1/2 w-1.5 -translate-x-1/2 rounded-full bg-surface-3" />
        <div className="absolute top-1/2 left-1/2 h-px w-4 -translate-x-1/2 bg-line" />
        <div
          className="absolute left-1/2 w-1.5 -translate-x-1/2 rounded-full bg-accent"
          style={value >= 0 ? { bottom: "50%", height: `${pct - 50}%` } : { top: "50%", height: `${50 - pct}%` }}
        />
        <div
          className="absolute left-1/2 size-5 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-accent bg-surface shadow"
          style={{ bottom: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] font-semibold text-faint">{label}</span>
    </div>
  );
}

export function EqualizerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useAudioSettings();
  const setGain = (i: number, v: number) => {
    const gains = s.eq.gains.slice();
    gains[i] = v;
    setAudioSettings({ eq: { ...s.eq, gains, preset: "custom" } });
  };
  return (
    <Dialog open={open} onClose={onClose} title="Эквалайзер" description="Настройки сохраняются на этом устройстве." wide>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-3 text-[15px] font-bold">
            <Switch label="Эквалайзер включён" checked={s.eq.enabled} onChange={(v) => setAudioSettings({ eq: { ...s.eq, enabled: v } })} />
            {s.eq.enabled ? "Включён" : "Выключен"}
          </label>
          <div className="w-56">
            <Select
              aria-label="Пресет"
              value={s.eq.preset}
              disabled={!s.eq.enabled}
              onChange={(e) => {
                const p = EQ_PRESETS.find((x) => x.id === e.target.value);
                if (p) setAudioSettings({ eq: { ...s.eq, preset: p.id, gains: p.gains.slice() } });
              }}
            >
              {EQ_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              {s.eq.preset === "custom" && <option value="custom">Свой</option>}
            </Select>
          </div>
        </div>
        <div className="scrollbar-none -mx-2 flex justify-between gap-1 overflow-x-auto px-2 pb-1">
          {EQ_BANDS.map((f, i) => (
            <BandSlider key={f} label={bandLabel(f)} value={s.eq.gains[i] ?? 0} disabled={!s.eq.enabled} onChange={(v) => setGain(i, v)} />
          ))}
        </div>
        <p className="text-[13px] text-faint">Двойной щелчок по полосе — сбросить в ноль. Громкость сама уменьшается, чтобы подъём полос не давал искажений.</p>
        {isIOS && <IosNote />}
      </div>
    </Dialog>
  );
}

function IosNote() {
  return (
    <div className="flex gap-2.5 rounded-xl bg-surface-2/70 p-3 text-[13px] text-muted">
      <Info className="mt-0.5 size-4 shrink-0 text-accent-ink" />
      <span>
        На iPhone эквалайзер, кроссфейд и усиление работают через звуковой движок браузера. Если музыка останавливается при
        погашенном экране — выключите их.
      </span>
    </div>
  );
}

/** Блок «Звук» в профиле */
export function SoundSettingsCard({ onOpenEq }: { onOpenEq: () => void }) {
  const s = useAudioSettings();
  const preset = s.eq.preset === "custom" ? "свой" : (EQ_PRESETS.find((p) => p.id === s.eq.preset)?.label ?? "").toLowerCase();
  return (
    <div className="flex flex-col divide-y divide-line">
      <Row
        title="Выравнивание громкости"
        text="Тихие и громкие треки звучат одинаково. По тегам ReplayGain, а если их нет — по анализу звука."
        control={<Switch label="Выравнивание громкости" checked={s.normalize} onChange={(v) => setAudioSettings({ normalize: v })} />}
      >
        {s.normalize && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <div className="w-64">
              <Select aria-label="Режим выравнивания" value={s.normalizeMode} onChange={(e) => setAudioSettings({ normalizeMode: e.target.value as "track" | "album" })}>
                <option value="track">Каждый трек одинаково</option>
                <option value="album">По альбому (сохраняет разницу)</option>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-muted">
              Усиление
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={s.preamp}
                onChange={(e) => setAudioSettings({ preamp: Number(e.target.value) })}
                className="w-32 accent-[var(--accent)]"
              />
              <span className="num w-12 text-fg">+{s.preamp} дБ</span>
            </label>
          </div>
        )}
      </Row>
      <Row
        title="Кроссфейд"
        text="Конец трека плавно перетекает в начало следующего."
        control={
          <div className="w-36">
            <Select aria-label="Кроссфейд" value={s.crossfade} onChange={(e) => setAudioSettings({ crossfade: Number(e.target.value) })}>
              <option value={0}>Выключен</option>
              {[2, 3, 4, 6, 8, 10, 12].map((n) => (
                <option key={n} value={n}>
                  {n} сек
                </option>
              ))}
            </Select>
          </div>
        }
      >
        {s.crossfade > 0 && (
          <label className="mt-3 flex items-center gap-3 text-sm text-muted">
            <Switch label="Не смешивать внутри альбома" checked={s.crossfadeSkipAlbum} onChange={(v) => setAudioSettings({ crossfadeSkipAlbum: v })} />
            Не смешивать треки одного альбома, идущие по порядку (концерты, миксы)
          </label>
        )}
      </Row>
      <Row
        title="Без пауз между треками"
        text="Следующий трек заранее загружается и начинается сразу — концертные альбомы звучат слитно."
        control={<Switch label="Без пауз между треками" checked={s.gapless} onChange={(v) => setAudioSettings({ gapless: v })} />}
      />
      <Row
        title="Эквалайзер"
        text={s.eq.enabled ? `Включён · ${preset}` : "Выключен"}
        control={
          <button onClick={onOpenEq} className="h-10 rounded-full bg-surface-2 px-4 text-[13px] font-bold hover:bg-surface-3">
            Настроить
          </button>
        }
      />
      {isIOS && (s.eq.enabled || s.crossfade > 0 || s.normalize) && (
        <div className="pt-4">
          <IosNote />
        </div>
      )}
    </div>
  );
}

function Row({ title, text, control, children }: { title: string; text: string; control: ReactNode; children?: ReactNode }) {
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-[15px] font-bold">{title}</div>
          <p className="mt-0.5 text-[13px] text-muted">{text}</p>
        </div>
        <div className="shrink-0">{control}</div>
      </div>
      {children}
    </div>
  );
}
