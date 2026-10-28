/**
 * Цвета обложки для фона плеера и шапки альбома: берём уменьшенную копию
 * и выбираем два «живых» цвета — самый насыщенный и средний.
 */
import { useEffect, useState } from "react";
import { hueOf } from "./utils";

export type Palette = [string, string];

const cache = new Map<string, Palette>();

function toHex(r: number, g: number, b: number) {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

function hsl(r: number, g: number, b: number) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  return { s, l };
}

export function fallbackPalette(seed: string): Palette {
  const h = hueOf(seed);
  return [`hsl(${h} 70% 55%)`, `hsl(${(h + 70) % 360} 65% 45%)`];
}

export function extractPalette(url: string): Promise<Palette> {
  const hit = cache.get(url);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "use-credentials";
    img.decoding = "async";
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no ctx");
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        let best = { score: -1, c: [0, 0, 0] };
        let second = { score: -1, c: [0, 0, 0] };
        let sum = [0, 0, 0];
        for (let i = 0; i < data.length; i += 4) {
          const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
          sum = [sum[0] + r, sum[1] + g, sum[2] + b];
          const { s, l } = hsl(r, g, b);
          const score = s * (1 - Math.abs(l - 0.55) * 1.6);
          if (score > best.score) {
            second = best;
            best = { score, c: [r, g, b] };
          } else if (score > second.score && Math.abs(r - best.c[0]) + Math.abs(g - best.c[1]) + Math.abs(b - best.c[2]) > 90) {
            second = { score, c: [r, g, b] };
          }
        }
        const n = data.length / 4;
        const avg = [sum[0] / n, sum[1] / n, sum[2] / n];
        const a = best.score > 0.12 ? best.c : avg;
        const b = second.score > 0.12 ? second.c : avg;
        const palette: Palette = [toHex(a[0], a[1], a[2]), toHex(b[0], b[1], b[2])];
        cache.set(url, palette);
        resolve(palette);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = reject;
    img.src = url;
  });
}

export function usePalette(url: string | null | undefined, seed: string): Palette {
  const [palette, setPalette] = useState<Palette>(() => (url && cache.get(url)) || fallbackPalette(seed));
  useEffect(() => {
    let alive = true;
    if (!url) {
      setPalette(fallbackPalette(seed));
      return;
    }
    extractPalette(url)
      .then((p) => alive && setPalette(p))
      .catch(() => alive && setPalette(fallbackPalette(seed)));
    return () => {
      alive = false;
    };
  }, [url, seed]);
  return palette;
}
