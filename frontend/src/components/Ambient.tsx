import { cn } from "@/lib/utils";

/**
 * Аморфный фон: две размытые «капли» и тонкие звуковые волны.
 * Очень низкая непрозрачность — фон оживляет экран, но не мешает читать.
 */
export function Ambient({
  colors,
  intensity = 1,
  className,
  waves = true,
}: {
  colors?: [string, string];
  intensity?: number;
  className?: string;
  waves?: boolean;
}) {
  const [a, b] = colors ?? ["var(--accent)", "#6b5bff"];
  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden", className)}>
      {/* «Капли» — радиальные градиенты, а не размытие фильтром: выглядят так же, но видеокарте почти ничего не стоят */}
      <div
        className="animate-drift-a absolute -top-[40%] -right-[25%] h-[110%] w-[85%] min-w-[640px] will-change-transform"
        style={{
          background: `radial-gradient(closest-side, ${a}, color-mix(in srgb, ${a} 45%, transparent) 45%, transparent)`,
          opacity: `calc(var(--blob-opacity) * ${intensity})`,
        }}
      />
      <div
        className="animate-drift-b absolute -bottom-[45%] -left-[8%] h-[105%] w-[80%] min-w-[600px] will-change-transform"
        style={{
          background: `radial-gradient(closest-side, ${b}, color-mix(in srgb, ${b} 45%, transparent) 45%, transparent)`,
          opacity: `calc(var(--blob-opacity) * ${intensity * 0.8})`,
        }}
      />
      {waves && (
        <div className="absolute inset-x-0 top-[30%] h-60 overflow-hidden" style={{ opacity: 0.09 * intensity }}>
          <svg
            className="animate-wave h-full w-[200%]"
            viewBox="0 0 2880 240"
            preserveAspectRatio="none"
            fill="none"
            stroke={a}
            strokeWidth="1.5"
          >
            {[0, 1].map((k) => (
              <g key={k} transform={`translate(${k * 1440} 0)`}>
                <path d="M0 120 C 160 40, 320 200, 480 120 S 800 40, 960 120 S 1280 200, 1440 120" />
                <path d="M0 140 C 180 70, 300 210, 500 130 S 820 60, 980 140 S 1300 190, 1440 140" />
                <path d="M0 100 C 140 30, 340 180, 460 110 S 780 30, 940 100 S 1260 210, 1440 100" />
              </g>
            ))}
          </svg>
        </div>
      )}
    </div>
  );
}
