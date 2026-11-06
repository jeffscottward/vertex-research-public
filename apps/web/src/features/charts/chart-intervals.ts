import type { MarketBarSize } from "@darkfactory/api";

import type { DisplayCandle } from "./types.ts";

// Chart interval picker (1m to 1M), shared by /charts and /stock/<symbol>. Each interval maps
// to one IBKR bars request; weekly and monthly candles are built from daily bars here, so
// they cover at most the one year of daily history the bars request allows.

export const CHART_INTERVALS = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "1D",
  "1W",
  "1M",
] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];
export const DEFAULT_CHART_INTERVAL: ChartInterval = "1D";

export type CandlePeriod = "week" | "month";

/** Length of a merged candle, for placing trade markers (a month is at most 31 days). */
export const CANDLE_PERIOD_SECONDS: Readonly<Record<CandlePeriod, number>> =
  Object.freeze({ month: 31 * 86_400, week: 7 * 86_400 });

export type IntervalBars = Readonly<{
  barSize: MarketBarSize;
  duration: string;
  aggregate: CandlePeriod | null;
}>;

export const INTERVAL_BARS: Readonly<Record<ChartInterval, IntervalBars>> =
  Object.freeze({
    "1m": { aggregate: null, barSize: "1 min", duration: "2 D" },
    "5m": { aggregate: null, barSize: "5 mins", duration: "1 W" },
    "15m": { aggregate: null, barSize: "15 mins", duration: "2 W" },
    "30m": { aggregate: null, barSize: "30 mins", duration: "1 M" },
    "1h": { aggregate: null, barSize: "1 hour", duration: "1 M" },
    "1D": { aggregate: null, barSize: "1 day", duration: "1 Y" },
    "1W": { aggregate: "week", barSize: "1 day", duration: "1 Y" },
    "1M": { aggregate: "month", barSize: "1 day", duration: "1 Y" },
  });

export const isChartInterval = (value: string): value is ChartInterval =>
  (CHART_INTERVALS as readonly string[]).includes(value);

/** Reads `?interval=` (case-sensitive: 1m is a minute, 1M a month); default 1D. */
export const parseIntervalParam = (search: string): ChartInterval => {
  const raw = new URLSearchParams(search).get("interval") ?? "";
  return isChartInterval(raw) ? raw : DEFAULT_CHART_INTERVAL;
};

/** The interval whose request matches a bar size and duration, or null. */
export const intervalForBars = (
  barSize: MarketBarSize,
  duration: string
): ChartInterval | null =>
  CHART_INTERVALS.find(
    (interval) =>
      INTERVAL_BARS[interval].aggregate === null &&
      INTERVAL_BARS[interval].barSize === barSize &&
      INTERVAL_BARS[interval].duration === duration
  ) ?? null;

// UTC Monday of the bar's ISO week, or the first day of its month.
const periodKey = (timestamp: number, period: CandlePeriod): string => {
  const date = new Date(timestamp);
  if (period === "month") return date.toISOString().slice(0, 7);
  const monday = new Date(
    timestamp - ((date.getUTCDay() + 6) % 7) * 86_400_000
  );
  return monday.toISOString().slice(0, 10);
};

/** Merges daily candles into weekly or monthly candles (first open, last close, sum volume). */
export const aggregateCandles = (
  candles: readonly DisplayCandle[],
  period: CandlePeriod
): DisplayCandle[] => {
  const merged: DisplayCandle[] = [];
  let currentKey = "";
  for (const candle of candles) {
    const key = periodKey(candle.timestamp, period);
    const previous = merged.at(-1);
    if (previous === undefined || key !== currentKey) {
      merged.push({ ...candle, id: `${period}-${key}` });
      currentKey = key;
      continue;
    }
    merged[merged.length - 1] = {
      ...previous,
      close: candle.close,
      high: Math.max(previous.high, candle.high),
      low: Math.min(previous.low, candle.low),
      volume: previous.volume + candle.volume,
    };
  }
  return merged;
};
