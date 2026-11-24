// What: pure rules for the ES/NQ big futures trade bubbles chart (flow-trade-bubbles.v1):
// sanitizes stored 1-minute OHLC/VWAP bars and stored deep futures trades (flow_large_trades),
// computes full-window buy/sell totals, p95 sizing reference, capture mode, size multiples,
// largest-print selection, and deterministic top-size truncation with chronological ordering.
// Used by: packages/api/src/server/flow-trade-bubbles.ts.
// Research only: describes recorded CME futures prices and deep prints; never a trade signal.

import {
  FLOW_TRADE_BUBBLES_MAX_BUBBLES,
  FLOW_TRADE_BUBBLES_MAX_CANDLES,
  FLOW_TRADE_BUBBLES_RULES_VERSION,
  FLOW_TRADE_BUBBLES_VERSION,
  type FlowFreshness,
  type FlowTapeSymbol,
  type FlowTradeBubble,
  type FlowTradeBubbles,
  type FlowTradeBubblesCandle,
  type FlowTradeBubblesCaptureMode,
  type FlowTradeBubblesPriceRange,
} from "./contracts/flow.ts";
import { FLOW_INSTRUMENTS } from "./flow-features.ts";

/** Retention of flow_large_trades and flow_minutes in Postgres (docs/vertex-rebuild/flow-pipeline.md). */
export const FLOW_TRADE_BUBBLES_RETENTION_DAYS = 730;

export type StoredTradeCandleInput = Readonly<{
  minute: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  vwap: number;
  volume: number;
  coveredSeconds: number;
}>;

export type StoredTradeBubbleInput = Readonly<{
  second: Date;
  seq: number;
  side: "buy" | "sell";
  size: number;
  price: number;
  limitSize: number;
  signing: "quote" | "tick";
  capture: "sampled" | "streamed";
}>;

export type BuildFlowTradeBubblesInput = Readonly<{
  symbol: FlowTapeSymbol;
  minutes: number;
  windowStart: Date;
  windowEnd: Date;
  tape: FlowFreshness;
  minuteBars: readonly StoredTradeCandleInput[];
  largeTrades: readonly StoredTradeBubbleInput[];
}>;

const isPositiveFinite = (value: number): boolean =>
  Number.isFinite(value) && value > 0;
const compareChrono = (a: FlowTradeBubble, b: FlowTradeBubble): number => {
  const timeDiff = Date.parse(a.second) - Date.parse(b.second);
  if (timeDiff !== 0) return timeDiff;
  return a.seq - b.seq;
};

/** Descending by size, breaking ties by newest timestamp then highest seq. */
const compareBySizeDesc = (a: FlowTradeBubble, b: FlowTradeBubble): number => {
  if (b.size !== a.size) return b.size - a.size;
  const timeDiff = Date.parse(b.second) - Date.parse(a.second);
  if (timeDiff !== 0) return timeDiff;
  return b.seq - a.seq;
};

const nearestRankP95 = (sizes: readonly number[]): number | null => {
  const sorted = [...sizes].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[rank] ?? null;
};

const classifyCaptureMode = (
  trades: readonly FlowTradeBubble[]
): FlowTradeBubblesCaptureMode => {
  let hasStreamed = false;
  let hasSampled = false;
  for (const trade of trades) {
    if (trade.capture === "streamed") hasStreamed = true;
    else hasSampled = true;
  }
  if (hasStreamed && hasSampled) return "mixed";
  if (hasStreamed) return "streamed";
  if (hasSampled) return "sampled";
  return "none";
};

const sanitizeCandles = (
  bars: readonly StoredTradeCandleInput[],
  startMs: number,
  endMs: number
): FlowTradeBubblesCandle[] => {
  const valid: Array<{ ms: number; candle: FlowTradeBubblesCandle }> = [];
  for (const bar of bars) {
    const ms = bar.minute.getTime();
    if (!Number.isFinite(ms) || ms < startMs || ms >= endMs) continue;
    if (
      !(
        isPositiveFinite(bar.open) &&
        isPositiveFinite(bar.high) &&
        isPositiveFinite(bar.low) &&
        isPositiveFinite(bar.close) &&
        isPositiveFinite(bar.vwap)
      )
    )
      continue;
    const high = Math.max(bar.open, bar.high, bar.low, bar.close);
    const low = Math.min(bar.open, bar.high, bar.low, bar.close);
    const coveredSeconds = Math.min(
      60,
      Math.max(0, Math.round(bar.coveredSeconds))
    );
    const volume =
      Number.isFinite(bar.volume) && bar.volume > 0 ? bar.volume : 0;
    valid.push({
      candle: {
        close: bar.close,
        coveredSeconds,
        high,
        low,
        minute: new Date(ms).toISOString(),
        open: bar.open,
        volume,
        vwap: bar.vwap,
      },
      ms,
    });
  }
  valid.sort((a, b) => a.ms - b.ms);
  const trimmed =
    valid.length > FLOW_TRADE_BUBBLES_MAX_CANDLES
      ? valid.slice(valid.length - FLOW_TRADE_BUBBLES_MAX_CANDLES)
      : valid;
  return trimmed.map((entry) => entry.candle);
};

const sanitizeBubbles = (
  trades: readonly StoredTradeBubbleInput[],
  startMs: number,
  endMs: number
): FlowTradeBubble[] => {
  const valid: FlowTradeBubble[] = [];
  for (const trade of trades) {
    const ms = trade.second.getTime();
    if (!Number.isFinite(ms) || ms < startMs || ms >= endMs) continue;
    if (
      !(
        isPositiveFinite(trade.price) &&
        isPositiveFinite(trade.size) &&
        isPositiveFinite(trade.limitSize)
      )
    )
      continue;
    valid.push({
      capture: trade.capture,
      limitSize: trade.limitSize,
      price: trade.price,
      second: new Date(ms).toISOString(),
      seq: Math.max(0, Math.trunc(trade.seq)),
      side: trade.side,
      signing: trade.signing,
      size: trade.size,
      sizeMultiple: Math.max(
        0.01,
        Math.round((trade.size / trade.limitSize) * 100) / 100
      ),
    });
  }
  valid.sort(compareChrono);
  return valid;
};

const computePriceRange = (
  candles: readonly FlowTradeBubblesCandle[],
  bubbles: readonly FlowTradeBubble[]
): FlowTradeBubblesPriceRange | null => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    if (candle.low < min) min = candle.low;
    if (candle.high > max) max = candle.high;
  }
  for (const bubble of bubbles) {
    if (bubble.price < min) min = bubble.price;
    if (bubble.price > max) max = bubble.price;
  }
  if (!(Number.isFinite(min) && Number.isFinite(max))) return null;
  return { max, min };
};

/** Pure deterministic assembly of flow-trade-bubbles.v1 for one ES or NQ window. */
export const buildFlowTradeBubbles = (
  input: BuildFlowTradeBubblesInput
): FlowTradeBubbles => {
  const instrument = FLOW_INSTRUMENTS[input.symbol];
  const deepTradeLimit = instrument.deepTradeLimit as number;
  const deepTradeLimitMeasuredOn =
    instrument.deepTradeLimitMeasuredOn as string;
  const startMs = input.windowStart.getTime();
  const endMs = input.windowEnd.getTime();

  const candles = sanitizeCandles(input.minuteBars, startMs, endMs);
  const allBubbles = sanitizeBubbles(input.largeTrades, startMs, endMs);

  let buyTrades = 0;
  let sellTrades = 0;
  let buyVolume = 0;
  let sellVolume = 0;
  const sizes: number[] = [];

  for (const bubble of allBubbles) {
    sizes.push(bubble.size);
    if (bubble.side === "buy") {
      buyTrades += 1;
      buyVolume += bubble.size;
    } else {
      sellTrades += 1;
      sellVolume += bubble.size;
    }
  }

  const bySizeDesc = [...allBubbles].sort(compareBySizeDesc);
  const largestBubble = bySizeDesc[0] ?? null;
  const truncated = allBubbles.length > FLOW_TRADE_BUBBLES_MAX_BUBBLES;
  const bubbles = truncated
    ? bySizeDesc.slice(0, FLOW_TRADE_BUBBLES_MAX_BUBBLES).sort(compareChrono)
    : allBubbles;

  return {
    bubbles,
    candles,
    captureMode: classifyCaptureMode(allBubbles),
    minutes: input.minutes,
    priceRange: computePriceRange(candles, bubbles),
    rules: {
      deepTradeLimit,
      deepTradeLimitMeasuredOn,
      maxBubbles: FLOW_TRADE_BUBBLES_MAX_BUBBLES,
      retentionDays: FLOW_TRADE_BUBBLES_RETENTION_DAYS,
      version: FLOW_TRADE_BUBBLES_RULES_VERSION,
    },
    schemaVersion: FLOW_TRADE_BUBBLES_VERSION,
    symbol: input.symbol,
    tape: input.tape,
    tickSize: instrument.minTick,
    totals: {
      buyTrades,
      buyVolume,
      largestBubble,
      maxSize: largestBubble?.size ?? null,
      netVolume: buyVolume - sellVolume,
      p95Size: nearestRankP95(sizes),
      sellTrades,
      sellVolume,
      shownTrades: bubbles.length,
      totalTrades: allBubbles.length,
      truncated,
    },
    windowEnd: input.windowEnd.toISOString(),
    windowStart: input.windowStart.toISOString(),
  };
};
