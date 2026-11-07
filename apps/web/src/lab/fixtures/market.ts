// What: Deterministic fake market data for the UI lab: OHLCV bars, order flow (trade prints,
// quotes, an L2 depth snapshot and a depth ENTITLEMENT failure), an options analytics snapshot
// and an empty JEV verdict. Every venue is a made-up LAB-* code.
// Used by: apps/web/src/lab/entries/markets.tsx and other lab entries that chart prices.
import type {
  JevVerdictOutput,
  MarketBar,
  MarketBarSize,
  MarketBarsInput,
  MarketBarsOutput,
  MarketDepthInput,
  MarketDepthLevel,
  MarketDepthOutput,
  MarketQuoteTick,
  MarketSecType,
  MarketTicksInput,
  MarketTicksOutput,
  MarketTradeTick,
  OptionsAnalyticsOutput,
} from "@darkfactory/api";
import { defined } from "../../features/order-flow/defined.ts";
import {
  createSeededRandom,
  LAB_NOW,
  LAB_NOW_ISO,
  labBasePrice,
  labDaysAgo,
  labMinutesAgo,
  roundTo,
} from "./core.ts";

const BAR_SECONDS: Readonly<Record<MarketBarSize, number>> = Object.freeze({
  "1 day": 86_400,
  "1 hour": 3600,
  "1 min": 60,
  "5 mins": 300,
  "15 mins": 900,
  "30 mins": 1800,
});

/** Bar open times (seconds) ending at LAB_NOW; daily bars skip Saturdays and Sundays. */
const labBarTimes = (count: number, barSize: MarketBarSize): number[] => {
  const step = BAR_SECONDS[barSize];
  const times: number[] = [];
  let time = Math.floor(LAB_NOW.getTime() / 1000 / step) * step;
  while (times.length < count) {
    const weekday = new Date(time * 1000).getUTCDay();
    if (barSize !== "1 day" || (weekday !== 0 && weekday !== 6))
      times.unshift(time);
    time -= step;
  }
  return times;
};

/** `count` bars ending at LAB_NOW: a seeded random walk around the symbol's base price. */
export const labBars = (
  symbol: string,
  count = 250,
  barSize: MarketBarSize = "1 day"
): MarketBar[] => {
  const random = createSeededRandom(`bars:${symbol}:${barSize}`);
  const base = labBasePrice(symbol);
  let close = base * 0.82;
  return labBarTimes(count, barSize).map((t) => {
    const open = close;
    const drift = (base - open) / base / 40;
    close = Math.max(1, open * (1 + drift + (random() - 0.48) * 0.03));
    const high = Math.max(open, close) * (1 + random() * 0.012);
    const low = Math.min(open, close) * (1 - random() * 0.012);
    return {
      c: roundTo(close),
      h: roundTo(high),
      l: roundTo(low),
      o: roundTo(open),
      t,
      v: Math.round(2_000_000 + random() * 8_000_000),
    };
  });
};

const MAX_BARS = 400;

/** A marketData.bars response for any input, so every symbol and interval renders. */
export const labBarsOutput = (input: MarketBarsInput): MarketBarsOutput => {
  const symbol = input.symbol.trim().toUpperCase();
  const barSize = input.barSize ?? "1 day";
  const bars = labBars(symbol, barSize === "1 day" ? 250 : MAX_BARS, barSize);
  const secType = input.secType ?? "STK";
  return {
    asOf: LAB_NOW_ISO,
    bars,
    cache: { ageSeconds: 12, hit: true, stale: false, ttlSeconds: 300 },
    contract: {
      conId: 100_000 + (symbol.charCodeAt(0) % 90) * 1000,
      currency: input.currency ?? "USD",
      exchange: input.exchange ?? "SMART",
      lastTradeDateOrContractMonth: null,
      localSymbol: symbol,
      longName: `${symbol} Demo Listing (fake data)`,
      matches: 1,
      multiplier: null,
      secType,
      timeZoneId: "US/Eastern",
    },
    count: bars.length,
    fetchedAt: LAB_NOW_ISO,
    receivedAt: LAB_NOW_ISO,
    request: {
      barSize,
      contractMonth: input.contractMonth ?? null,
      currency: input.currency ?? "USD",
      duration: input.duration ?? "1 Y",
      exchange: input.exchange ?? "SMART",
      secType,
      symbol,
      useRTH: input.useRTH ?? true,
      whatToShow:
        secType === "CASH" ? "MIDPOINT" : (input.whatToShow ?? "TRADES"),
    },
    source: "ibkr-gateway",
  };
};

const EXPIRY_DAYS = [7, 14, 30, 60, 90, 180] as const;
const SKEW_DELTAS = [-40, -25, -10, 10, 25, 40] as const;
const MONEYNESS = [0.9, 0.95, 1, 1.05, 1.1] as const;

/** An optionsAnalytics.snapshot response with every section "ok". */
export const labOptionsAnalytics = (
  symbol: string,
  flowHours = 24
): OptionsAnalyticsOutput => {
  const random = createSeededRandom(`options:${symbol}`);
  const spot = labBasePrice(symbol);
  const baseIv = 0.18 + random() * 0.25;
  const expiries = EXPIRY_DAYS.map((dte) => ({
    dte,
    expiry: labDaysAgo(-dte),
  }));
  const strikeStep = spot > 200 ? 10 : spot > 50 ? 5 : 1;
  const atm = Math.round(spot / strikeStep) * strikeStep;
  const strikes = Array.from({ length: 11 }, (_, index) => {
    const strike = atm + (index - 5) * strikeStep;
    const distance = Math.abs(index - 5);
    const callOpenInterest = Math.round((6 - distance) * 1800 + random() * 900);
    const putOpenInterest = Math.round((6 - distance) * 1600 + random() * 900);
    return {
      callOpenInterest,
      gex: roundTo((callOpenInterest - putOpenInterest) * spot * 0.8, 0),
      putOpenInterest,
      strike,
    };
  });
  // Eight trades spread over the three nearest expiries.
  const near = expiries.slice(0, 3);
  const events = [...near, ...near, ...near.slice(0, 2)].map(
    ({ expiry }, index) => {
      const right = index % 3 === 0 ? ("put" as const) : ("call" as const);
      const strike = atm + ((index % 5) - 2) * strikeStep;
      return {
        contract: `${symbol} ${expiry} ${strike}${right === "call" ? "C" : "P"}`,
        expiry,
        flowType: index % 2 === 0 ? "sweep" : "block",
        premium: roundTo(50_000 + random() * 450_000, 0),
        right,
        sentiment:
          right === "call" ? ("bullish" as const) : ("bearish" as const),
        size: Math.round(50 + random() * 950),
        strike,
        time: labMinutesAgo(index * 47 + 5),
        unusual: index % 4 === 0,
      };
    }
  );
  const callPremium = events
    .filter((event) => event.right === "call")
    .reduce((sum, event) => sum + event.premium, 0);
  const putPremium = events
    .filter((event) => event.right === "put")
    .reduce((sum, event) => sum + event.premium, 0);
  return {
    exposure: {
      gexExpiry: labDaysAgo(-EXPIRY_DAYS[0]),
      maxPain: atm,
      message: null,
      status: "ok",
      strikes,
      totalGex: strikes.reduce((sum, row) => sum + row.gex, 0),
    },
    flow: {
      buckets: Array.from({ length: 6 }, (_, index) => {
        const call = roundTo(100_000 + random() * 400_000, 0);
        const put = roundTo(80_000 + random() * 300_000, 0);
        return {
          callPremium: call,
          netPremium: call - put,
          putPremium: put,
          start: labMinutesAgo((6 - index) * 60),
          trades: Math.round(10 + random() * 90),
        };
      }),
      callPremium,
      events,
      hours: flowHours,
      message: null,
      putPremium,
      status: "ok",
    },
    notes: ["UI lab: fake options data for layout review."],
    rateLimited: false,
    receivedAt: LAB_NOW_ISO,
    retryAfterSeconds: null,
    source: "quantdata",
    spot,
    symbol,
    volatility: {
      message: null,
      skew: expiries.slice(0, 3).flatMap(({ expiry }) =>
        SKEW_DELTAS.map((target) => ({
          delta: target,
          expiry,
          iv: roundTo(baseIv + (target < 0 ? -target : target / 2) / 400, 4),
          target,
        }))
      ),
      status: "ok",
      surface: {
        moneyness: [...MONEYNESS],
        rows: expiries.map(({ expiry, dte }) => ({
          dte,
          expiry,
          ivs: MONEYNESS.map((m) =>
            roundTo(baseIv + Math.abs(1 - m) * 0.6 + dte / 3000, 4)
          ),
        })),
      },
      termStructure: expiries.map(({ expiry, dte }) => ({
        atmIv: roundTo(baseIv + dte / 2000, 4),
        dte,
        expiry,
      })),
    },
  };
};

/** No cached JEV verdict for the symbol: the panel shows its empty state; Ask JEV is refused. */
export const labJevVerdict = (symbol: string): JevVerdictOutput => ({
  configured: true,
  lastFailure: null,
  minIntervalSeconds: 1800,
  nextRefreshAt: null,
  notes: [],
  refreshed: false,
  staleAfterSeconds: 3600,
  state: "none",
  symbol: symbol.trim().toUpperCase(),
  throttled: false,
  verdict: null,
});

// ---------------------------------------------------------------------------
// Order flow (marketData.ticks / marketData.depth). Fictional prints on made-up LAB-* venues.

const ORDER_FLOW_WINDOW_SECONDS = 240;
/** The first prints come before the first quote, so the tick rule and "unsigned" show too. */
const PRINTS_BEFORE_FIRST_QUOTE = 6;

const labTickSize = (secType: MarketSecType): number =>
  secType === "STK" ? 0.01 : 0.25;

const labOnTick = (value: number, tick: number): number =>
  roundTo(Math.round(value / tick) * tick, 2);

const labContract = (
  symbol: string,
  secType: MarketSecType,
  exchange: string,
  currency: string
): MarketBarsOutput["contract"] => ({
  conId: 100_000 + (symbol.charCodeAt(0) % 90) * 1000,
  currency,
  exchange,
  lastTradeDateOrContractMonth: null,
  localSymbol: symbol,
  longName: `${symbol} Demo Listing (fake data)`,
  matches: 1,
  multiplier: secType === "STK" ? null : "50",
  secType,
  timeZoneId: "US/Eastern",
});

/** One fictional print: 45% lift the ask, 40% hit the bid, 15% at the midpoint (tick rule). */
const labPrint = (
  random: () => number,
  at: Readonly<{
    lot: number;
    mid: number;
    secType: MarketSecType;
    t: number;
    tick: number;
  }>
): MarketTradeTick => {
  const pick = random();
  const offset = pick < 0.45 ? at.tick : pick < 0.85 ? -at.tick : 0;
  const venue = pick < 0.5 ? "LAB-A" : "LAB-B";
  return {
    c: pick > 0.97 ? "LAB-COND" : null,
    p: labOnTick(at.mid + offset, at.tick),
    s: Math.ceil(random() * 9) * at.lot,
    t: at.t,
    x: at.secType === "STK" ? venue : null,
  };
};

/** `count` fictional prints over the four minutes before 15:59 ET, a quote every fourth print. */
const labTape = (
  symbol: string,
  secType: MarketSecType,
  count: number
): { trades: MarketTradeTick[]; quotes: MarketQuoteTick[] } => {
  const random = createSeededRandom(`ticks:${symbol}:${secType}`);
  const tick = labTickSize(secType);
  const lot = secType === "STK" ? 100 : 1;
  const start =
    Math.floor(LAB_NOW.getTime() / 1000) - 60 - ORDER_FLOW_WINDOW_SECONDS;
  let mid = labOnTick(labBasePrice(symbol), tick);
  const trades: MarketTradeTick[] = [];
  const quotes: MarketQuoteTick[] = [];
  for (let index = 0; index < count; index += 1) {
    const t = start + Math.floor((index * ORDER_FLOW_WINDOW_SECONDS) / count);
    if (index % 4 === 0) {
      const step = random();
      if (step < 0.35) mid = labOnTick(mid - tick, tick);
      else if (step > 0.62) mid = labOnTick(mid + tick, tick);
      if (index >= PRINTS_BEFORE_FIRST_QUOTE)
        quotes.push({
          ap: labOnTick(mid + tick, tick),
          as: Math.ceil(random() * 20),
          bp: labOnTick(mid - tick, tick),
          bs: Math.ceil(random() * 20),
          t,
        });
    }
    trades.push(labPrint(random, { lot, mid, secType, t, tick }));
  }
  return { quotes, trades };
};

/** A marketData.ticks response with fictional prints and quotes for any instrument. */
export const labTicksOutput = (input: MarketTicksInput): MarketTicksOutput => {
  const symbol = input.symbol.trim().toUpperCase();
  const secType = input.secType ?? "STK";
  const exchange = input.exchange ?? "SMART";
  const currency = input.currency ?? "USD";
  const count = input.count ?? 500;
  const { quotes, trades } = labTape(symbol, secType, count);
  const last = defined(trades.at(-1), "lab trade");
  return {
    asOf: new Date(last.t * 1000).toISOString(),
    cache: { ageSeconds: 8, hit: true, stale: false, ttlSeconds: 30 },
    contract: labContract(symbol, secType, exchange, currency),
    fetchedAt: LAB_NOW_ISO,
    minTick: labTickSize(secType),
    quotes: input.quotes === false ? [] : quotes,
    receivedAt: LAB_NOW_ISO,
    request: {
      contractMonth: input.contractMonth ?? null,
      count,
      currency,
      exchange,
      quotes: input.quotes ?? true,
      secType,
      symbol,
      useRTH: input.useRTH ?? false,
    },
    source: "ibkr-gateway",
    trades,
  };
};

/** A fictional one-shot L2 book; SMART (stocks) spreads it across made-up LAB-* venues. */
export const labDepthOutput = (input: MarketDepthInput): MarketDepthOutput => {
  const symbol = input.symbol.trim().toUpperCase();
  const secType = input.secType ?? "STK";
  const exchange = input.exchange ?? "SMART";
  const currency = input.currency ?? "USD";
  const rows = input.rows ?? 10;
  const smartDepth = secType === "STK";
  const random = createSeededRandom(`depth:${symbol}:${secType}`);
  const tick = labTickSize(secType);
  // The book sits around the last fictional quote, so it lines up with the tape.
  const lastQuote = defined(
    labTape(symbol, secType, 500).quotes.at(-1),
    "lab quote"
  );
  const mid = labOnTick((lastQuote.bp + lastQuote.ap) / 2, tick);
  const venues = ["LAB-A", "LAB-B", "LAB-C"];
  const side = (direction: 1 | -1): MarketDepthLevel[] =>
    Array.from({ length: rows }, (_, index) => ({
      price: labOnTick(mid + direction * (index + 1) * tick, tick),
      size: Math.ceil(random() * (6 + index * 2)),
      venue: smartDepth
        ? defined(venues[index % venues.length], "lab venue")
        : null,
    }));
  return {
    asks: side(1),
    bids: side(-1),
    cache: { ageSeconds: 3, hit: false, stale: false, ttlSeconds: 15 },
    contract: labContract(symbol, secType, exchange, currency),
    fetchedAt: LAB_NOW_ISO,
    minTick: labTickSize(secType),
    receivedAt: LAB_NOW_ISO,
    request: {
      contractMonth: input.contractMonth ?? null,
      currency,
      exchange,
      rows,
      secType,
      smartDepth,
      symbol,
    },
    sizeMultiplier: smartDepth ? 100 : 1,
    source: "ibkr-gateway",
    updates: rows * 6,
    venues: smartDepth
      ? { depth: ["LAB-A", "LAB-B"], missing: ["LAB-D"], top: ["LAB-C"] }
      : null,
  };
};

/** The oRPC ENTITLEMENT failure the depth route returns when the account has no L2 for a venue. */
export const labDepthEntitlementError = (): Error =>
  Object.assign(
    new Error("IBKR market data permissions missing for this request"),
    { code: "ENTITLEMENT", status: 502 }
  );
