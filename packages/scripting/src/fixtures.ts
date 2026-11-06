// Test fixtures: a tiny hand-checkable series and a longer deterministic wave.

import type { ScriptBar } from "./index.ts";

const START_MS = Date.UTC(2026, 0, 5, 14, 30);
const MINUTE_MS = 60_000;

// close: 10 11 12 11 13 14 13 15 16 15; high = close + 1; low = close - 1.
export const SMALL_CLOSES = [10, 11, 12, 11, 13, 14, 13, 15, 16, 15] as const;
const SMALL_VOLUMES = [
  100, 200, 150, 300, 250, 100, 200, 400, 300, 100,
] as const;

export const SMALL_BARS: readonly ScriptBar[] = SMALL_CLOSES.map(
  (close, i) => ({
    close,
    high: close + 1,
    low: close - 1,
    open: close - 0.5,
    timestamp: START_MS + i * MINUTE_MS,
    volume: SMALL_VOLUMES[i] ?? 0,
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
