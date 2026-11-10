// What: turns one sample of signed IBKR prints into per-minute order-flow features and derived
// events (large prints, off-exchange prints, absorption, stacked imbalances, exhaustion), and one depth
// snapshot into book pressure. Pure; the collector (server/flow-collect.ts) stores the result.
// Doc: docs/vertex-rebuild/flow-pipeline.md.
import type {
  FlowDirection,
  FlowEventKind,
  FlowSymbol,
} from "./contracts/flow.ts";
import { findExhaustion } from "./flow-exhaustion.ts";
import type { SignedTrade } from "./flow-trade-signing.ts";

export type FlowInstrument = Readonly<{
  symbol: FlowSymbol;
  secType: "STK" | "CONTFUT";
  exchange?: "CME";
  optionsTicker: "SPY" | "SPX";
  /** Prints at or above this size are large prints (shares for SPY, contracts for ES). */
  largePrint: number;
  /** Options prints at or above this premium become events. */
  optionEventPremium: number;
}>;

export const FLOW_INSTRUMENTS: Readonly<Record<FlowSymbol, FlowInstrument>> = {
  ES: {
    exchange: "CME",
    largePrint: 50,
    optionEventPremium: 1_000_000,
    optionsTicker: "SPX",
    secType: "CONTFUT",
    symbol: "ES",
  },
  SPY: {
    largePrint: 10_000,
    optionEventPremium: 500_000,
    optionsTicker: "SPY",
    secType: "STK",
    symbol: "SPY",
  },
};

export type FlowMinuteRow = Readonly<{
  symbol: FlowSymbol;
  minute: Date;
  trades: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vwap: number;
  coveredSeconds: number;
  largePrints: number;
  largePrintVolume: number;
  offExchangeVolume: number;
  stackedBuy: number;
  stackedSell: number;
  absorption: "buy" | "sell" | null;
}>;

export type FlowEventRow = Readonly<{
  symbol: FlowSymbol;
  key: string;
  at: Date;
  kind: FlowEventKind;
  direction: FlowDirection;
  price: number | null;
  size: number | null;
  premium: number | null;
  detail: string;
  source: "ibkr" | "quantdata";
}>;

const IMBALANCE_RATIO = 3;
const STACK_LEVELS = 3;
const ABSORPTION_DELTA_RATIO = 0.4;
const ABSORPTION_MIN_TRADES = 30;

interface LevelCell {
  buy: number;
  sell: number;
}
interface Stacks {
  buy: number;
  sell: number;
}
type Absorption = "buy" | "sell" | null;

const sideDirection = (side: SignedTrade["side"]): FlowDirection => {
  if (side === "buy") return "bullish";
  if (side === "sell") return "bearish";
  return "neutral";
};

// Diagonal imbalance stacks on integer tick indexes: buy volume at level i against sell volume at
// i − 1 (buy side), sell volume at i against buy volume at i + 1 (sell side). A run of 3+
// adjacent imbalanced levels counts as one stack; a price gap breaks the run.
export const countStacks = (levels: ReadonlyMap<number, LevelCell>): Stacks => {
  const rows = [...levels.entries()].sort((a, b) => a[0] - b[0]);
  const stacks = { buy: 0, sell: 0 };
  for (const side of ["buy", "sell"] as const) {
    const step = side === "buy" ? -1 : 1;
    const opposite = side === "buy" ? "sell" : "buy";
    let run = 0;
    let previous = Number.NaN;
    for (const [index, cell] of rows) {
      const theirs = levels.get(index + step)?.[opposite] ?? 0;
      const hit =
        cell[side] > 0 && cell[side] >= IMBALANCE_RATIO * Math.max(theirs, 1);
      const adjacent = index === previous + 1;
      run = hit ? (adjacent ? run + 1 : 1) : 0;
      previous = index;
      if (run === STACK_LEVELS) stacks[side] += 1;
    }
  }
  return stacks;
};

/** Strong one-sided aggression (30+ trades, |delta| ≥ 40% of volume) that did not move price its way. */
export const absorptionOf = (
  trades: number,
  volume: number,
  delta: number,
  open: number,
  close: number
): Absorption => {
  if (trades < ABSORPTION_MIN_TRADES || volume <= 0) return null;
  if (Math.abs(delta) / volume < ABSORPTION_DELTA_RATIO) return null;
  if (delta > 0) return close <= open ? "buy" : null;
  return close >= open ? "sell" : null;
};

const venueLabel = (venue: string | null): string => {
  if (venue === "FINRA") return " off-exchange (FINRA TRF)";
  return venue ? ` on ${venue}` : "";
};

const printEvent = (symbol: FlowSymbol, trade: SignedTrade): FlowEventRow => ({
  at: new Date(trade.t * 1000),
  detail: `${trade.size} @ ${trade.price}${venueLabel(trade.venue)}, ${trade.side} (${trade.method} rule)`,
  direction: sideDirection(trade.side),
  key: `print:${trade.t}:${trade.price}:${trade.size}:${trade.venue ?? ""}`,
  kind: trade.venue === "FINRA" ? "off_exchange_print" : "large_print",
  premium: null,
  price: trade.price,
  size: trade.size,
  source: "ibkr",
  symbol,
});

interface MinuteTotals {
  buy: number;
  sell: number;
  volume: number;
  notional: number;
  large: number;
  largeVolume: number;
  offExchange: number;
  high: number;
  low: number;
  levels: Map<number, LevelCell>;
  prints: FlowEventRow[];
}

const totalMinute = (
  instrument: FlowInstrument,
  group: readonly SignedTrade[],
  minTick: number
): MinuteTotals => {
  const totals: MinuteTotals = {
    buy: 0,
    high: Number.NEGATIVE_INFINITY,
    large: 0,
    largeVolume: 0,
    levels: new Map(),
    low: Number.POSITIVE_INFINITY,
    notional: 0,
    offExchange: 0,
    prints: [],
    sell: 0,
    volume: 0,
  };
  for (const trade of group) {
    totals.volume += trade.size;
    totals.notional += trade.size * trade.price;
    totals.high = Math.max(totals.high, trade.price);
    totals.low = Math.min(totals.low, trade.price);
    if (trade.venue === "FINRA") totals.offExchange += trade.size;
    if (trade.side !== "unknown") {
      totals[trade.side] += trade.size;
      const index = Math.round(trade.price / minTick);
      const cell = totals.levels.get(index) ?? { buy: 0, sell: 0 };
      cell[trade.side] += trade.size;
      totals.levels.set(index, cell);
    }
    if (trade.size >= instrument.largePrint) {
      totals.large += 1;
      totals.largeVolume += trade.size;
      totals.prints.push(printEvent(instrument.symbol, trade));
    }
  }
  return totals;
};

const minuteEvents = (
  symbol: FlowSymbol,
  minute: number,
  close: number,
  totals: MinuteTotals,
  absorption: Absorption,
  stacks: Stacks
): FlowEventRow[] => {
  const at = new Date(minute * 1000);
  const delta = totals.buy - totals.sell;
  const events: FlowEventRow[] = [...totals.prints];
  if (absorption !== null)
    events.push({
      at,
      detail: `${absorption === "buy" ? "Buying" : "Selling"} absorbed: delta ${delta} of ${totals.volume}`,
      direction: absorption === "buy" ? "bearish" : "bullish",
      key: `absorption:${minute}`,
      kind: "absorption",
      premium: null,
      price: close,
      size: totals.volume,
      source: "ibkr",
      symbol,
    });
  for (const side of ["buy", "sell"] as const)
    if (stacks[side] > 0)
      events.push({
        at,
        detail: `${stacks[side]} stacked ${side} imbalance${stacks[side] > 1 ? "s" : ""} (≥${IMBALANCE_RATIO}:1 on ≥${STACK_LEVELS} levels)`,
        direction: side === "buy" ? "bullish" : "bearish",
        key: `stack:${side}:${minute}`,
        kind: "stacked_imbalance",
        premium: null,
        price: close,
        size: null,
        source: "ibkr",
        symbol,
      });
  return events;
};

export type MinuteFeatures = Readonly<{
  minutes: FlowMinuteRow[];
  events: FlowEventRow[];
}>;

const groupByMinute = (
  trades: readonly SignedTrade[]
): Map<number, SignedTrade[]> => {
  const groups = new Map<number, SignedTrade[]>();
  for (const trade of trades) {
    const minute = Math.floor(trade.t / 60) * 60;
    const group = groups.get(minute);
    if (group) group.push(trade);
    else groups.set(minute, [trade]);
  }
  return groups;
};

/**
 * Per-minute features of one tick sample. The sample covers [first print, last print]; each
 * minute records how many of its seconds lie inside that window (coveredSeconds), so a reader can
 * tell a quiet minute from an unsampled one.
 */
export const buildMinuteFeatures = (
  instrument: FlowInstrument,
  trades: readonly SignedTrade[],
  minTick: number
): MinuteFeatures => {
  const ordered = [...trades].sort((a, b) => a.t - b.t);
  const first = ordered[0]?.t ?? 0;
  const last = ordered.at(-1)?.t ?? 0;
  const minutes: FlowMinuteRow[] = [];
  const events: FlowEventRow[] = [];
  const { symbol } = instrument;
  for (const [minute, group] of groupByMinute(ordered)) {
    const totals = totalMinute(instrument, group, minTick);
    const open = (group[0] as SignedTrade).price;
    const close = (group.at(-1) as SignedTrade).price;
    const delta = totals.buy - totals.sell;
    const stacks = countStacks(totals.levels);
    const absorption = absorptionOf(
      group.length,
      totals.volume,
      delta,
      open,
      close
    );
    events.push(
      ...minuteEvents(symbol, minute, close, totals, absorption, stacks)
    );
    minutes.push({
      absorption,
      buyVolume: totals.buy,
      close,
      coveredSeconds: Math.min(minute + 60, last + 1) - Math.max(minute, first),
      delta,
      high: totals.high,
      largePrintVolume: totals.largeVolume,
      largePrints: totals.large,
      low: totals.low,
      minute: new Date(minute * 1000),
      offExchangeVolume: totals.offExchange,
      open,
      sellVolume: totals.sell,
      stackedBuy: stacks.buy,
      stackedSell: stacks.sell,
      symbol,
      trades: group.length,
      volume: totals.volume,
      vwap: totals.volume > 0 ? totals.notional / totals.volume : close,
    });
  }
  const closes = new Map(
    minutes.map((row) => [row.minute.getTime(), row.close])
  );
  for (const run of findExhaustion(ordered, 60))
    events.push({
      at: new Date(run.end * 1000),
      detail: `${run.direction === "up" ? "Higher highs" : "Lower lows"} on less fuel for ${run.buckets} min: volume ${run.firstVolume} → ${run.lastVolume}, delta ${run.firstDelta} → ${run.lastDelta}`,
      direction: run.direction === "up" ? "bearish" : "bullish",
      key: `exhaustion:${run.direction}:${run.end}`,
      kind: "exhaustion",
      premium: null,
      price: closes.get(run.end * 1000) ?? null,
      size: run.lastVolume,
      source: "ibkr",
      symbol,
    });
  return { events, minutes };
};

export type FlowBookRow = Readonly<{
  symbol: FlowSymbol;
  at: Date;
  bestBid: number | null;
  bestAsk: number | null;
  bidSize: number;
  askSize: number;
  pressure: number | null;
  levels: number;
}>;

type DepthLevel = Readonly<{ price: number; size: number }>;

/** Book pressure of one depth snapshot: (bid size − ask size) ÷ total, −1..1. */
export const buildBook = (
  symbol: FlowSymbol,
  at: Date,
  bids: readonly DepthLevel[],
  asks: readonly DepthLevel[],
  sizeMultiplier: number
): FlowBookRow => {
  const bidSize =
    bids.reduce((sum, level) => sum + level.size, 0) * sizeMultiplier;
  const askSize =
    asks.reduce((sum, level) => sum + level.size, 0) * sizeMultiplier;
  const total = bidSize + askSize;
  return {
    askSize,
    at,
    bestAsk:
      asks.length > 0 ? Math.min(...asks.map((level) => level.price)) : null,
    bestBid:
      bids.length > 0 ? Math.max(...bids.map((level) => level.price)) : null,
    bidSize,
    levels: bids.length + asks.length,
    pressure: total > 0 ? (bidSize - askSize) / total : null,
    symbol,
  };
};
