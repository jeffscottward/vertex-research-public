// What: Deterministic fake market data for the UI lab: OHLCV bars, order flow (trade prints,
// quotes, an L2 depth snapshot and a depth ENTITLEMENT failure), an options analytics snapshot
// and an empty JEV verdict. Every venue is a made-up LAB-* code.
// Used by: apps/web/src/lab/entries/markets.tsx and other lab entries that chart prices.
import {
  type FlowEventsInput,
  type FlowEventsOutput,
  type FlowSnapshotEvent,
  type JevVerdictOutput,
  type MarketBar,
  type MarketBarSize,
  type MarketBarsInput,
  type MarketBarsOutput,
  type MarketDepthInput,
  type MarketDepthLevel,
  type MarketDepthOutput,
  type MarketQuoteTick,
  type MarketSecType,
  type MarketTicksInput,
  type MarketTicksOutput,
  type MarketTradeTick,
  OPENBB_IV_PERCENTILE_MIN_SESSIONS,
  OPENBB_IV_PERCENTILE_SESSIONS,
  OPENBB_VOL_INDEX_PROXY,
  type OpenbbIvHistoryHorizon,
  type OpenbbIvHistoryOutput,
  type OpenbbIvHistoryPoint,
  type OptionsAnalyticsOutput,
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
      whatToShow: input.whatToShow ?? "TRADES",
    },
    source: "ibkr-gateway",
  };
};

const EXPIRY_DAYS = [7, 14, 30, 60, 90, 180] as const;
const SKEW_DELTAS = [-40, -25, -10, 10, 25, 40] as const;
const MONEYNESS = [0.9, 0.95, 1, 1.05, 1.1] as const;

/** A fictional GEX context strip: every factor with fixed caveat text. */
const labGexContext = (
  spot: number,
  atm: number,
  strikeStep: number,
  iv: number
): OptionsAnalyticsOutput["context"] => {
  const dailyMove = (spot * iv) / Math.sqrt(252);
  const moves = (level: number) => roundTo((level - spot) / dailyMove, 2);
  const factor = (
    key: OptionsAnalyticsOutput["context"]["factors"][number]["key"],
    label: string,
    value: string,
    tone: "neutral" | "caution" | "alert" = "neutral"
  ) => ({
    detail: `UI lab: fake ${label.toLowerCase()} context.`,
    key,
    label,
    tone,
    value,
  });
  return {
    dealerSignAssumption: "dealers long calls, short puts",
    expiry: {
      monthlyOpexDays: 9,
      nextExpiry: labDaysAgo(-EXPIRY_DAYS[0]),
      nextExpiryDte: EXPIRY_DAYS[0],
      nextMonthlyOpex: labDaysAgo(-9),
    },
    factors: [
      factor(
        "dealerSign",
        "Dealer sign",
        "Assumed: long calls, short puts",
        "caution"
      ),
      factor(
        "regime",
        "Regime (estimate)",
        "Positive GEX, not a range promise"
      ),
      factor(
        "freshness",
        "Freshness",
        "OI prior session · newest trade 5 min ago",
        "caution"
      ),
      factor("expiryMix", "Expiry mix", `Next expiry in ${EXPIRY_DAYS[0]}d`),
      factor(
        "levels",
        "Spot vs levels",
        "flip -1.2 day-moves · call wall +0.8 day-moves",
        "caution"
      ),
      factor("flow", "Flow (who is paying)", "Bulls +$420K net"),
      factor("dex", "Dealer delta (DEX)", "+$12.4M"),
      factor("charm", "Charm · Midday", "-$310K/day, hedge buying"),
      factor("vanna", "Vanna", "+$95K per IV pt, hedge selling"),
      factor(
        "ivRegime",
        "IV regime",
        "Not computed: no expiry after the front",
        "alert"
      ),
      factor("events", "Events", "Monthly OpEx in 9d"),
    ],
    flow: {
      bearishPremium: 300_000,
      bias: "bullish",
      bullishPremium: 720_000,
      newestTradeAt: labMinutesAgo(5),
      weekShare: 0.6,
      zeroDteShare: 0,
    },
    greeks: { netCharm: -310_000, netDex: 12_400_000, netVanna: 95_000 },
    iv: { backIv: null, frontIv: roundTo(iv, 4), regime: "no_term_data" },
    levels: {
      callWall: atm + strikeStep,
      callWallMoves: moves(atm + strikeStep),
      dailyMove: roundTo(dailyMove, 2),
      flip: atm - strikeStep,
      flipMoves: moves(atm - strikeStep),
      putWall: atm - 2 * strikeStep,
      putWallMoves: moves(atm - 2 * strikeStep),
    },
    regime: "positive",
    session: "midday",
  };
};

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
  // Holder payout at each strike (the server formula, MOCK data); the smallest is max pain.
  const payoutAt = (price: number): number =>
    strikes.reduce(
      (sum, row) =>
        sum +
        Math.max(0, price - row.strike) * row.callOpenInterest * 100 +
        Math.max(0, row.strike - price) * row.putOpenInterest * 100,
      0
    );
  const profileRows = strikes.map((row) => {
    const at = events.filter((event) => event.strike === row.strike);
    const sum = (pick: (event: (typeof events)[number]) => number): number =>
      at.reduce((total, event) => total + pick(event), 0);
    return {
      bearishPremium: sum((event) =>
        event.sentiment === "bearish" ? event.premium : 0
      ),
      bullishPremium: sum((event) =>
        event.sentiment === "bullish" ? event.premium : 0
      ),
      callOpenInterest: row.callOpenInterest,
      callVolume: sum((event) => (event.right === "call" ? event.size : 0)),
      holderPayout: payoutAt(row.strike),
      putOpenInterest: row.putOpenInterest,
      putVolume: sum((event) => (event.right === "put" ? event.size : 0)),
      strike: row.strike,
      trades: at.length,
    };
  });
  const painRow = profileRows.reduce((best, row) =>
    row.holderPayout < best.holderPayout ? row : best
  );
  return {
    context: labGexContext(spot, atm, strikeStep, baseIv),
    exposure: {
      gexExpiry: labDaysAgo(-EXPIRY_DAYS[0]),
      maxPain: painRow.strike,
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
    strikeProfiles: {
      flow: {
        complete: true,
        // Event i trades i x 47 + 5 minutes ago: the first is the newest.
        newestTradeAt: labMinutesAgo(5),
        offLadderTrades: 0,
        oldestTradeAt: labMinutesAgo((events.length - 1) * 47 + 5),
        source: "quantdata_page",
        trades: events.length,
      },
      strikes: profileRows,
    },
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

/** Fictional stored IBKR flow_events (stacked imbalances and absorption) inside the requested range. */
export const labFlowEventsOutput = (
  input: FlowEventsInput
): FlowEventsOutput => {
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  const span = Math.max(0, toMs - fromMs);
  const base = labBasePrice(input.symbol);
  const at = (fraction: number) =>
    new Date(fromMs + Math.round(span * fraction)).toISOString();
  const candidates: FlowSnapshotEvent[] = [
    {
      at: at(0.82),
      detail: "1 stacked buy imbalance (≥3:1 on ≥3 levels)",
      direction: "bullish",
      kind: "stacked_imbalance",
      premium: null,
      price: roundTo(base * 0.994),
      size: null,
    },
    {
      at: at(0.88),
      detail: "Buying absorbed: delta +420 of 760",
      direction: "bearish",
      kind: "absorption",
      premium: null,
      price: roundTo(base * 1.005),
      size: 760,
    },
    {
      at: at(0.93),
      detail: "1 stacked sell imbalance (≥3:1 on ≥3 levels)",
      direction: "bearish",
      kind: "stacked_imbalance",
      premium: null,
      price: roundTo(base * 1.002),
      size: null,
    },
    {
      at: at(0.97),
      detail: "Selling absorbed: delta −380 of 690",
      direction: "bullish",
      kind: "absorption",
      premium: null,
      price: roundTo(base * 0.996),
      size: 690,
    },
  ];
  const filtered =
    input.kinds === undefined
      ? candidates
      : candidates.filter((event) => input.kinds?.includes(event.kind));
  return {
    events: filtered,
    from: input.from,
    schemaVersion: "flow-events.v1",
    symbol: input.symbol,
    to: input.to,
    truncated: false,
  };
};

const LAB_CORE7_PROXY: Readonly<
  Record<
    string,
    (typeof OPENBB_VOL_INDEX_PROXY)[keyof typeof OPENBB_VOL_INDEX_PROXY]
  >
> = OPENBB_VOL_INDEX_PROXY;

const labTradingDates = (count: number): string[] => {
  const dates: string[] = [];
  let cursor = new Date(LAB_NOW);
  while (dates.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return dates.reverse();
};

/** Deterministic rolling 252-session IV rank / percentile history for the UI lab. */
export const labIvHistory = (
  rawSymbol: string,
  sessions: OpenbbIvHistoryHorizon = 252
): OpenbbIvHistoryOutput => {
  const symbol = rawSymbol.trim().toUpperCase();
  const proxyIndex = LAB_CORE7_PROXY[symbol] ?? null;
  if (proxyIndex === null) {
    return {
      asOf: null,
      basis: null,
      latest: null,
      minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
      own: {
        asOf: null,
        ivPercentile: null,
        ivRank: null,
        latestValue: null,
        minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
        reason: "No ATM IV sessions stored",
        sessions: 0,
        windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
      },
      points: [],
      proxy: null,
      proxyIndex: null,
      reason: `No Cboe volatility-index proxy for ${symbol}; own ATM IV: No ATM IV sessions stored`,
      requestedSessions: sessions,
      symbol,
      unit: null,
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    };
  }

  const maxHorizon = 504;
  const totalDays = maxHorizon + OPENBB_IV_PERCENTILE_SESSIONS - 1;
  const dates = labTradingDates(totalDays);
  const next = createSeededRandom(`iv-history:${symbol}`);
  const base = 17 + (symbol.charCodeAt(0) % 7);
  const values: number[] = [];
  for (let i = 0; i < totalDays; i += 1) {
    const cycle =
      Math.sin((i / 48) * Math.PI) * 6.5 + Math.cos((i / 19) * Math.PI) * 2.5;
    const shock = i % 97 === 71 ? 8 : 0;
    const noise = (next() - 0.5) * 1.4;
    values.push(roundTo(Math.max(10.5, base + cycle + shock + noise), 2));
  }

  const allPoints: OpenbbIvHistoryPoint[] = [];
  for (let end = OPENBB_IV_PERCENTILE_SESSIONS - 1; end < totalDays; end += 1) {
    const start = end - OPENBB_IV_PERCENTILE_SESSIONS + 1;
    const latest = defined(values[end], "iv");
    let below = 0;
    let low52w = latest;
    let high52w = latest;
    for (let j = start; j <= end; j += 1) {
      const value = defined(values[j], "iv");
      if (value < latest) below += 1;
      if (value < low52w) low52w = value;
      if (value > high52w) high52w = value;
    }
    const ivPercentile = roundTo(
      (100 * below) / (OPENBB_IV_PERCENTILE_SESSIONS - 1),
      2
    );
    const span = high52w - low52w;
    const ivRank = roundTo(
      Math.min(100, Math.max(0, ((latest - low52w) / span) * 100)),
      2
    );
    allPoints.push({
      date: defined(dates[end], "date"),
      high52w,
      iv: latest,
      ivPercentile,
      ivRank,
      low52w,
    });
  }

  const points = allPoints.slice(-sessions);
  const latestPoint = defined(points.at(-1), "latest");
  return {
    asOf: latestPoint.date,
    basis: "vol_index_proxy",
    latest: latestPoint,
    minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
    own: {
      asOf: latestPoint.date,
      ivPercentile: null,
      ivRank: null,
      latestValue: roundTo(latestPoint.iv / 100, 4),
      minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
      reason: "Needs 252 sessions with ATM IV (12 stored)",
      sessions: 12,
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    },
    points,
    proxy: {
      asOf: latestPoint.date,
      index: proxyIndex,
      ivPercentile: latestPoint.ivPercentile,
      ivRank: latestPoint.ivRank,
      latestValue: latestPoint.iv,
      minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
      reason: null,
      sessions: OPENBB_IV_PERCENTILE_SESSIONS,
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    },
    proxyIndex,
    reason: null,
    requestedSessions: sessions,
    symbol,
    unit: "vol_points",
    windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
  };
};
