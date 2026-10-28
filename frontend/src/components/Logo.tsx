import { cn } from "@/lib/utils";

/** Знак SelfMusic: силуэт балалайки. */
export function BalalaikaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      {/* Балалайка под 45°, выровнена по центру знака */}
      <g transform="translate(0.92 -0.92) rotate(45 12 12)">
        <path d="M11.1 11Q12 9.9 12.9 11L17.3 19.6Q18 21 16.5 21.3Q12 22.3 7.5 21.3Q6 21 6.7 19.6Z" />
        <rect x="10.9" y="2.8" width="2.2" height="8.6" rx=".6" />
        <rect x="10.2" y="1.1" width="3.6" height="3.6" rx="1.1" />
      </g>
    </svg>
  );
}

export function LogoBadge({ className, size = "md" }: { className?: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-accent text-accent-fg",
        size === "sm" && "size-8 rounded-[9px]",
        size === "md" && "size-9 rounded-[10px]",
        size === "lg" && "size-14 rounded-[16px]",
        className,
      )}
    >
      <BalalaikaMark className={size === "lg" ? "size-9" : size === "sm" ? "size-5" : "size-[22px]"} />
    </span>
  );
}

export function Brand({ name = "SelfMusic", className }: { name?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-3", className)}>
      <LogoBadge />
      <span className="font-display text-lg font-semibold tracking-[-0.03em]">{name}</span>
    </span>
  );
}
