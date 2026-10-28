import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

export function Section({
  title,
  link,
  linkLabel = "Показать все",
  children,
  className,
  action,
}: {
  title: string;
  link?: string;
  linkLabel?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-xl font-semibold tracking-[-0.02em] sm:text-[22px]">{title}</h2>
        {action}
        {link && (
          <Link to={link} className="text-sm font-bold whitespace-nowrap text-muted hover:text-fg">
            {linkLabel}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="title-display text-3xl sm:text-[40px]">{title}</h1>
        {subtitle && <p className="mt-2 text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
