import { Cover } from "@/components/Cover";
import { PlayFill } from "@/components/icon";
import { Monitor, RefreshCw, Smartphone, X } from "@/components/icons";
import { applyUpdate, useUpdateAvailable } from "@/lib/updates";
import { usePlayer } from "@/lib/player";
import { acceptOffer, dismissOffer, useSyncOffer } from "@/lib/sync";
import { cn } from "@/lib/utils";

/** «Играет на iPhone — Слушать здесь»: когда музыку включили на другом устройстве. */
export function SyncOfferCard() {
  const offer = useSyncOffer();
  const hasTrack = usePlayer((s) => s.queue.length > 0);
  if (!offer) return null;
  return (
    <div
      role="status"
      className={cn(
        "glass animate-sheet-up fixed inset-x-2 z-40 flex items-center gap-3 rounded-2xl border p-2.5 pr-2 shadow-2xl shadow-black/40",
        "lg:inset-x-auto lg:right-6 lg:w-[460px]",
        hasTrack ? "bottom-[calc(148px+var(--sab))] lg:bottom-[112px]" : "bottom-[calc(80px+var(--sab))] lg:bottom-6",
      )}
    >
      <div className="relative size-12 shrink-0">
        <Cover src={offer.track.cover} seed={offer.track.album + offer.track.album_artist} size={120} rounded="rounded-xl" />
        <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full bg-accent text-accent-fg ring-2 ring-surface">
          {/iPhone|iPad|Android/.test(offer.device) ? <Smartphone className="size-3" /> : <Monitor className="size-3" />}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-bold text-accent-ink">Сейчас на {offer.device}</div>
        <div className="truncate text-[14px] font-semibold">{offer.track.title}</div>
        <div className="truncate text-[12px] text-muted">{offer.track.artist}</div>
      </div>
      <button
        onClick={acceptOffer}
        className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[13px] font-extrabold text-accent-fg transition hover:brightness-110"
      >
        <PlayFill className="size-3.5" /> Слушать здесь
      </button>
      <button aria-label="Скрыть" onClick={dismissOffer} className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
        <X className="size-4" />
      </button>
    </div>
  );
}

/** «Вышла новая версия» — когда сборку обновили, а здесь играет музыка. */
export function UpdateCard() {
  const available = useUpdateAvailable();
  if (!available) return null;
  return (
    <div
      role="status"
      className="glass animate-sheet-up fixed inset-x-2 top-[calc(var(--sat)+64px)] z-40 mx-auto flex max-w-md items-center gap-3 rounded-2xl border p-2.5 pl-4 shadow-2xl shadow-black/40 lg:top-4"
    >
      <RefreshCw className="size-5 shrink-0 text-accent-ink" />
      <div className="min-w-0 flex-1 text-[14px] font-semibold">Вышла новая версия SelfMusic</div>
      <button
        onClick={applyUpdate}
        className="h-9 shrink-0 rounded-full bg-accent px-4 text-[13px] font-extrabold text-accent-fg transition hover:brightness-110"
      >
        Обновить
      </button>
    </div>
  );
}
