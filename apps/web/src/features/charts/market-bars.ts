import {
  marketDurationAllowed,
  type MarketBar,
  type MarketBarSize,
} from "@darkfactory/api";
import type { ChartMarker, DisplayCandle } from "./types.ts";
import type { ChartType } from "./workstation.ts";

// Matches the KLine adapter validator cap (validDisplayCandles).
export const DISPLAY_CANDLE_LIMIT = 4096;

export const BAR_SECONDS: Readonly<Record<MarketBarSize, number>> =
  Object.freeze({
    "1 min": 60,
    "5 mins": 300,
    "15 mins": 900,
    "30 mins": 1800,
    "1 hour": 3600,
    "1 day": 86_400,
  });

const DURATION_CHOICES = [
  "1 D",
  "2 D",
  "1 W",
  "2 W",
  "1 M",
  "3 M",
  "6 M",
  "1 Y",
] as const;

// Daily bars start at one week; shorter daily windows return too few bars to read.
export const durationOptionsFor = (barSize: MarketBarSize): string[] => {
  return DURATION_CHOICES.filter(
    (duration) =>
      marketDurationAllowed(barSize, duration) &&
      !(barSize === "1 day" && duration.endsWith(" D"))
  );
};

export const coerceDuration = (
  barSize: MarketBarSize,
  duration: string
): string => {
  const options = durationOptionsFor(barSize);
  return options.includes(duration) ? duration : (options.at(-1) ?? duration);
};

export type DisplayCandleResult = Readonly<{
  candles: DisplayCandle[];
  // Older bars left out to respect the renderer cap.
  dropped: number;
  // Bars with non-finite or negative values, or a repeated/non-increasing time.
  skipped: number;
}>;

const MAX_DISPLAY_VALUE = 1_000_000_000_000;

// t (epoch seconds) -> ms; null volume -> 0; high/low widened to contain open and close.
export const barsToDisplayCandles = (
  bars: readonly MarketBar[],
  limit = DISPLAY_CANDLE_LIMIT
): DisplayCandleResult => {
  const candles: DisplayCandle[] = [];
  let skipped = 0;
  for (const bar of bars) {
    const volume = bar.v ?? 0;
    const values = [bar.o, bar.h, bar.l, bar.c, volume];
    const previous = candles.at(-1);
    if (
      !(
        Number.isSafeInteger(bar.t) &&
        values.every(
          (value) =>
            Number.isFinite(value) && value >= 0 && value <= MAX_DISPLAY_VALUE
        )
      ) ||
      (previous !== undefined && previous.timestamp >= bar.t * 1000)
    ) {
      skipped += 1;
      continue;
    }
    candles.push({
      id: String(bar.t),
      timestamp: bar.t * 1000,
      open: bar.o,
      high: Math.max(bar.h, bar.o, bar.c),
      low: Math.min(bar.l, bar.o, bar.c),
      close: bar.c,
      volume,
    });
  }
  const dropped = Math.max(0, candles.length - limit);
  return {
    candles: dropped > 0 ? candles.slice(dropped) : candles,
    dropped,
    skipped,
  };
};

export type TradeLike = Readonly<{
  entry_t: string;
  exit_t: string;
  side: "long" | "short";
  entry_px: number;
  exit_px: number;
  symbol?: string | undefined;
}>;

export type TradeMarkerResult = Readonly<{
  markers: ChartMarker[];
  // Entry/exit points placed on the chart vs. points outside the loaded bars.
  shown: number;
  outside: number;
  // Trades skipped because they name a different symbol.
  otherSymbol: number;
}>;

const tradeTimeMs = (value: string): number => {
  return Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value
  );
};

// Last candle whose start is at or before ms, or -1.
const candleIndexAt = (
  candles: readonly DisplayCandle[],
  ms: number
): number => {
  let low = 0;
  let high = candles.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candle = candles[middle];
    if (candle !== undefined && candle.timestamp <= ms) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
};

// Trades whose symbol is absent are assumed to be for the loaded instrument.
export const tradeMarkers = (
  trades: readonly TradeLike[],
  candles: readonly DisplayCandle[],
  barSeconds: number,
  symbols: readonly string[] = []
): TradeMarkerResult => {
  const accepted = new Set(symbols.map((symbol) => symbol.toUpperCase()));
  const markers: ChartMarker[] = [];
  let outside = 0;
  let otherSymbol = 0;
  const lastCandle = candles.at(-1);
  const end =
    lastCandle === undefined
      ? Number.NEGATIVE_INFINITY
      : lastCandle.timestamp + barSeconds * 1000;
  const place = (id: string, time: string, value: number, text: string) => {
    const ms = tradeTimeMs(time);
    const candle =
      Number.isFinite(ms) && ms < end
        ? candles[candleIndexAt(candles, ms)]
        : undefined;
    if (candle === undefined || !Number.isFinite(value) || value < 0) {
      outside += 1;
      return;
    }
    markers.push({
      id,
      timestamp: candle.timestamp,
      value,
      text,
    });
  };
  for (const [index, trade] of trades.entries()) {
    if (
      trade.symbol !== undefined &&
      accepted.size > 0 &&
      !accepted.has(trade.symbol.toUpperCase())
    ) {
      otherSymbol += 1;
      continue;
    }
    place(
      `trade-${index}-entry`,
      trade.entry_t,
      trade.entry_px,
      trade.side === "long" ? "Long" : "Short"
    );
    place(`trade-${index}-exit`, trade.exit_t, trade.exit_px, "Exit");
  }
  return { markers, shown: markers.length, outside, otherSymbol };
};

// Heikin Ashi bars from ordinary bars. The first bar seeds open from (O+C)/2.
export const heikinAshi = (
  candles: readonly DisplayCandle[]
): readonly DisplayCandle[] => {
  const out: DisplayCandle[] = [];
  for (const bar of candles) {
    const close = (bar.open + bar.high + bar.low + bar.close) / 4;
    const before = out.at(-1);
    const open =
      before === undefined
        ? (bar.open + bar.close) / 2
        : (before.open + before.close) / 2;
    out.push({
      close,
      high: Math.max(bar.high, open, close),
      id: bar.id,
      low: Math.min(bar.low, open, close),
      open,
      timestamp: bar.timestamp,
      volume: bar.volume,
    });
  }
  return out;
};

export const displayValues = (
  candles: readonly DisplayCandle[],
  type: ChartType
): readonly DisplayCandle[] =>
  type === "heikin-ashi" ? heikinAshi(candles) : candles;

export type DataWindowRow = Readonly<{ label: string; value: string }>;

// Data window rows for the bar under the crosshair (or the latest bar).
export const dataWindowRows = (
  bar: DisplayCandle | undefined,
  previousClose: number | undefined,
  precision: number
): readonly DataWindowRow[] => {
  if (bar === undefined) return [];
  const rows: DataWindowRow[] = [
    { label: "Time (UTC)", value: new Date(bar.timestamp).toISOString() },
    { label: "Open", value: bar.open.toFixed(precision) },
    { label: "High", value: bar.high.toFixed(precision) },
    { label: "Low", value: bar.low.toFixed(precision) },
    { label: "Close", value: bar.close.toFixed(precision) },
    { label: "Volume", value: bar.volume.toLocaleString("en-US") },
  ];
  if (previousClose !== undefined && previousClose !== 0) {
    const change = bar.close - previousClose;
    const percent = (change / previousClose) * 100;
    rows.push({
      label: "Change",
      value: `${change >= 0 ? "+" : ""}${change.toFixed(precision)} (${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%)`,
    });
  }
  return rows;
};
