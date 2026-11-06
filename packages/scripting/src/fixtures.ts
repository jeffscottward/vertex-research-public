// Test fixtures: a tiny hand-checkable series and a longer deterministic wave.

import type { ScriptBar } from "./index.ts";

const START_MS = Date.UTC(2026, 0, 5, 14, 30);
const MINUTE_MS = 60_000;

// close: 10 11 12 11 13 14 13 15 16 15; high = close + 1; low = close - 1.
// [close, volume] per bar.
const SMALL_ROWS = [
  [10, 100],
  [11, 200],
  [12, 150],
  [11, 300],
  [13, 250],
  [14, 100],
  [13, 200],
  [15, 400],
  [16, 300],
  [15, 100],
] as const;

export const SMALL_CLOSES: readonly number[] = SMALL_ROWS.map(
  ([close]) => close
);

export const SMALL_BARS: readonly ScriptBar[] = SMALL_ROWS.map(
  ([close, volume], i) => ({
    close,
    high: close + 1,
    low: close - 1,
    open: close - 0.5,
    timestamp: START_MS + i * MINUTE_MS,
    volume,
  })
);

export const waveBars = (count: number): ScriptBar[] =>
  Array.from({ length: count }, (_, i) => {
    const close = 100 + 10 * Math.sin(i / 9) + 3 * Math.sin(i / 2.3) + i * 0.02;
    return {
      close,
      high: close + 1 + (i % 3) * 0.3,
      low: close - 1 - (i % 2) * 0.4,
      open: close - 0.4 * Math.cos(i),
      timestamp: START_MS + i * MINUTE_MS,
      volume: 1000 + ((i * 37) % 500),
    };
  });
