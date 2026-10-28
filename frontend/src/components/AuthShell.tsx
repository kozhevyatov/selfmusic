import type { ReactNode } from "react";
import { Ambient } from "./Ambient";
import { Brand } from "./Logo";

/** Страницы входа, регистрации и установки: форма на стеклянной карточке поверх «капель». */
export function AuthShell({
  siteName,
  title,
  subtitle,
  children,
  wide = false,
  top,
}: {
  siteName?: string;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  top?: ReactNode;
}) {
  return (
    <div className="relative isolate flex min-h-svh flex-col items-center px-4 py-8 sm:py-12">
      <div className="fixed inset-0 -z-10">
        <Ambient intensity={1.3} />
      </div>
      <Brand name={siteName} />
      <div className={`glass mt-8 w-full rounded-[28px] border p-6 shadow-2xl shadow-black/20 sm:p-10 ${wide ? "max-w-[720px]" : "max-w-[460px]"}`}>
        {top}
        <h1 className="title-display text-[28px] sm:text-[32px]">{title}</h1>
        {subtitle && <p className="mt-2 leading-relaxed text-muted">{subtitle}</p>}
        <div className="mt-8">{children}</div>
      </div>
    </div>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol aria-label="Шаги установки" className="mb-8 grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((label, i) => (
        <li key={label} aria-current={i === current ? "step" : undefined} className="flex flex-col gap-2.5">
          <span className={`h-1 rounded-full ${i <= current ? "bg-accent" : "bg-surface-3"}`} />
          <span className={`text-[12px] font-bold sm:text-[13px] ${i === current ? "text-fg" : "text-faint"}`}>
            {i + 1}. {label}
          </span>
        </li>
      ))}
    </ol>
  );
}
