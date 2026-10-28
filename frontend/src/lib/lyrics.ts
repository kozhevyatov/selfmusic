/** Тексты песен: обычные и синхронные (LRC). */

export type LyricLine = { at: number | null; text: string };

/** Разбор LRC: несколько меток на строку, [offset:±мс], пословные метки <мм:сс.xx> убираем */
export function parseLyrics(text: string): { lines: LyricLine[]; synced: boolean } {
  let offset = 0;
  const timed: LyricLine[] = [];
  const plain: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
    if (off) {
      offset = Number(off[1]) / 1000;
      continue;
    }
    if (/^\s*\[(ar|ti|al|au|by|length|re|ve|#):/i.test(raw)) continue; // служебные теги LRC
    const stamps: number[] = [];
    let rest = raw;
    let m: RegExpExecArray | null;
    const re = /^\s*\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;
    while ((m = re.exec(rest))) {
      stamps.push(Number(m[1]) * 60 + Number(m[2].replace(":", ".")));
      rest = rest.slice(m[0].length);
    }
    const clean = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "").trim();
    if (stamps.length) stamps.forEach((at) => timed.push({ at, text: clean }));
    else plain.push({ at: null, text: clean });
  }
  if (timed.length) {
    timed.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    // [offset] в LRC положительный — текст раньше
    return { lines: timed.map((l) => ({ ...l, at: Math.max(0, (l.at ?? 0) - offset) })), synced: true };
  }
  return { lines: plain, synced: false };
}
