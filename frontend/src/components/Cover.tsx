import { useState } from "react";
import { coverUrl } from "@/lib/api";
import { cn, hueOf } from "@/lib/utils";
import { Disc3 } from "./icons";

/** Обложка с заглушкой: если картинки нет, рисуем мягкий градиент из «капель» по названию. */
export function Cover({
  src,
  seed,
  size = 400,
  className,
  rounded = "rounded-xl",
  alt = "",
}: {
  src: string | null | undefined;
  seed: string;
  size?: number;
  className?: string;
  rounded?: string;
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = coverUrl(src, size);
  const h = hueOf(seed);
  return (
    <div className={cn("relative aspect-square overflow-hidden bg-surface-2", rounded, className)}>
      {url && !failed ? (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background: `radial-gradient(circle at 25% 25%, hsl(${h} 75% 60% / 0.95), transparent 55%), radial-gradient(circle at 80% 85%, hsl(${(h + 60) % 360} 70% 50% / 0.9), transparent 60%), hsl(${h} 30% 16%)`,
          }}
        >
          <Disc3 className="absolute right-[12%] bottom-[12%] size-[22%] text-white/45" strokeWidth={1.6} />
        </div>
      )}
    </div>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const h = hueOf(name);
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-full font-extrabold text-[#0d0d0f]", className)}
      style={{ background: `hsl(${h} 70% 72%)` }}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
