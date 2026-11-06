// What: Deterministic fake market data for the UI lab: OHLCV bars, an options analytics snapshot
// and an empty JEV verdict.
// Used by: apps/web/src/lab/entries/markets.tsx and other lab entries that chart prices.
import type {
  JevVerdictOutput,
  MarketBar,
  MarketBarSize,
  MarketBarsInput,
  MarketBarsOutput,
  OptionsAnalyticsOutput,
} from "@darkfactory/api";

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
      whatToShow: input.whatToShow ?? "TRADES",
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
