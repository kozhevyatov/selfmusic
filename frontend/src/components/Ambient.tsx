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
      <div
        className="animate-drift-a absolute -top-[22%] -right-[12%] h-[70%] w-[55%] min-w-[420px] blur-[90px] transition-[background] duration-1000"
        style={{
          background: a,
          opacity: `calc(var(--blob-opacity) * ${intensity})`,
          borderRadius: "42% 58% 63% 37% / 41% 44% 56% 59%",
        }}
      />
      <div
        className="animate-drift-b absolute -bottom-[25%] left-[8%] h-[62%] w-[50%] min-w-[380px] blur-[110px] transition-[background] duration-1000"
        style={{
          background: b,
          opacity: `calc(var(--blob-opacity) * ${intensity * 0.8})`,
          borderRadius: "61% 39% 45% 55% / 52% 61% 39% 48%",
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
