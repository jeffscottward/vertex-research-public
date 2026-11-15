// What: market sessions per flow source, and the pure assembly of flow.snapshot from stored rows:
// window summaries, per-source freshness and the confluence reading (agree/disagree). Research
// only; a confluence reading describes recent flow and is never an instruction to trade.
import {
  FLOW_SNAPSHOT_MAX_EVENTS,
  FLOW_SNAPSHOT_MAX_PRINTS,
  FLOW_SNAPSHOT_VERSION,
  FLOW_SOURCES,
  type FlowConfluence,
  type FlowFactor,
  type FlowFreshness,
  type FlowSampleStatus,
  type FlowSnapshot,
  type FlowSource,
  type FlowSymbol,
  type FlowVote,
} from "../contracts/flow.ts";
import type { GexContext } from "../contracts/options-analytics.ts";
import {
  FLOW_INSTRUMENTS,
  type FlowBookRow,
  type FlowEventRow,
  type FlowMinuteRow,
} from "../flow-features.ts";
import type { FlowOptionPrintRow } from "../flow-options.ts";
import { marketSession, newYorkParts } from "./gex-context.ts";

/** Is this source's market open now (New York wall time; holidays are not modelled)? */
export const flowSessionOpen = (
  source: FlowSource,
  symbol: FlowSymbol,
  now: Date
): boolean => {
  const parts = newYorkParts(now);
  const day = parts["weekday"];
  const minutes = Number(parts["hour"]) * 60 + Number(parts["minute"]);
  if (source === "options" || source === "gex")
    return (
      day !== "Sat" &&
      day !== "Sun" &&
      minutes >= 9 * 60 + 30 &&
      minutes < 16 * 60 + 15
    );
  if (symbol === "SPY") return marketSession(now) !== "closed";
  // CME Globex equity futures: Sunday 18:00 to Friday 17:00, daily break 17:00-18:00.
  if (day === "Sat") return false;
  if (day === "Sun") return minutes >= 18 * 60;
  if (day === "Fri") return minutes < 17 * 60;
  return minutes < 17 * 60 || minutes >= 18 * 60;
};

/** Seconds after which a source's newest data counts as stale while its market is open. */
export const FLOW_STALE_SECONDS: Readonly<Record<FlowSource, number>> = {
  depth: 180,
  gex: 1800,
  options: 300,
  ticks: 600,
};

export type FlowSampleRow = Readonly<{
  symbol: FlowSymbol;
  source: FlowSource;
  at: Date;
  status: FlowSampleStatus;
  message: string | null;
  items: number;
}>;

export type FlowGexRow = Readonly<{
  symbol: FlowSymbol;
  at: Date;
  ticker: "SPY" | "SPX";
  spot: number | null;
  basis: number | null;
  regime: GexContext["regime"];
  totalGex: number | null;
  flip: number | null;
  callWall: number | null;
  putWall: number | null;
  maxPain: number | null;
  netDex: number | null;
  zeroDteShare: number | null;
  ivRegime: GexContext["iv"]["regime"];
}>;

export type FlowSnapshotRows = Readonly<{
  symbol: FlowSymbol;
  now: Date;
  windowStart: Date;
  windowEnd: Date;
  minutes: readonly FlowMinuteRow[];
  books: readonly FlowBookRow[];
  prints: readonly FlowOptionPrintRow[];
  events: readonly FlowEventRow[];
  gex: FlowGexRow | null;
  /** Newest sample of any status, per source. */
  latest: readonly FlowSampleRow[];
  /** Newest ok sample, per source. */
  latestOk: readonly FlowSampleRow[];
}>;

const iso = (date: Date): string => date.toISOString();
const ratio = (part: number, total: number): number | null =>
  total > 0 ? part / total : null;
const sumOf = <T>(items: readonly T[], pick: (item: T) => number): number =>
  items.reduce((total, item) => total + pick(item), 0);

const freshnessState = (
  age: number | null,
  sessionOpen: boolean,
  source: FlowSource
): FlowFreshness["state"] => {
  if (age === null) return "never";
  if (!sessionOpen) return "closed";
  return age > FLOW_STALE_SECONDS[source] ? "stale" : "fresh";
};

export const buildFreshness = (rows: FlowSnapshotRows): FlowFreshness[] =>
  FLOW_SOURCES.map((source) => {
    const ok = rows.latestOk.find((sample) => sample.source === source);
    const last = rows.latest.find((sample) => sample.source === source);
    const sessionOpen = flowSessionOpen(source, rows.symbol, rows.now);
    const age = ok
      ? Math.max(0, Math.round((rows.now.getTime() - ok.at.getTime()) / 1000))
      : null;
    return {
      ageSeconds: age,
      lastOkAt: ok ? iso(ok.at) : null,
      lastStatus: last?.status ?? null,
      message: last?.message ?? null,
      sessionOpen,
      source,
      state: freshnessState(age, sessionOpen, source),
    };
  });

export const vote = (value: number | null, threshold: number): FlowVote => {
  if (value === null) return "unknown";
  if (value >= threshold) return "bullish";
  if (value <= -threshold) return "bearish";
  return "neutral";
};

export const pct = (value: number | null): string => {
  if (value === null) return "n/a";
  return `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`;
};

const SUMMARY_LABELS: Readonly<Record<FlowConfluence["summary"], string>> = {
  agree_bearish: "Flows agree: bearish",
  agree_bullish: "Flows agree: bullish",
  disagree: "Flows disagree",
  insufficient: "Not enough fresh data",
  neutral: "No clear direction",
};

export const confluenceSummary = (
  bullish: number,
  bearish: number,
  known: number
): FlowConfluence["summary"] => {
  if (known < 2) return "insufficient";
  if (bullish > 0 && bearish > 0) return "disagree";
  if (bullish >= 2) return "agree_bullish";
  if (bearish >= 2) return "agree_bearish";
  return "neutral";
};

const gexFactorValue = (
  gex: FlowGexRow | null,
  usable: boolean,
  lastPrice: number | null
): string => {
  if (!usable || gex === null || gex.regime === "unknown") return "n/a";
  const flip =
    gex.flip === null || gex.basis === null ? null : gex.flip + gex.basis;
  if (flip === null || lastPrice === null) return `${gex.regime} gamma`;
  const side = lastPrice >= flip ? "above" : "below";
  return `${gex.regime} gamma, price ${side} flip ${flip.toFixed(2)}`;
};

export type ConfluenceInput = Readonly<{
  deltaRatio: number | null;
  pressure: number | null;
  premiumBias: number | null;
  gex: FlowGexRow | null;
  lastPrice: number | null;
  usable: Readonly<Record<FlowSource, boolean>>;
}>;

export const buildConfluence = (input: ConfluenceInput): FlowConfluence => {
  const { usable } = input;
  const deltaRatio = usable.ticks ? input.deltaRatio : null;
  const pressure = usable.depth ? input.pressure : null;
  const premiumBias = usable.options ? input.premiumBias : null;
  const directional: FlowFactor[] = [
    {
      detail:
        "Signed volume (buys − sells) ÷ volume over the last 15 sampled minutes; ±10% or more counts.",
      key: "order_flow",
      label: "Order flow (delta)",
      value: pct(deltaRatio),
      vote: vote(deltaRatio, 0.1),
    },
    {
      detail:
        "Resting bid size vs ask size in the newest book snapshot (top 10 rows); ±20% or more counts. Resting size can be pulled.",
      key: "book",
      label: "Book pressure",
      value: pct(pressure),
      vote: vote(pressure, 0.2),
    },
    {
      detail:
        "QuantData bullish minus bearish premium over the last 30 minutes, as a share of both; ±15% or more counts.",
      key: "options_flow",
      label: "Options flow",
      value: pct(premiumBias),
      vote: vote(premiumBias, 0.15),
    },
  ];
  const gexFactor: FlowFactor = {
    detail:
      "Context, not a vote: positive gamma tends to damp moves, negative gamma to extend them. Estimate; assumes dealers long calls, short puts.",
    key: "gex",
    label: "GEX regime",
    value: gexFactorValue(input.gex, usable.gex, input.lastPrice),
    vote: "unknown",
  };
  const count = (pick: (factor: FlowFactor) => boolean): number =>
    directional.filter(pick).length;
  const bullish = count((factor) => factor.vote === "bullish");
  const bearish = count((factor) => factor.vote === "bearish");
  const known = count((factor) => factor.vote !== "unknown");
  const summary = confluenceSummary(bullish, bearish, known);
  return {
    bearish,
    bullish,
    factors: [...directional, gexFactor],
    known,
    label: SUMMARY_LABELS[summary],
    summary,
  };
};

const minuteKey = (date: Date): number => Math.floor(date.getTime() / 60_000);
const byTime =
  <T>(pick: (item: T) => Date) =>
  (a: T, b: T) =>
    pick(a).getTime() - pick(b).getTime();

interface OptionMinute {
  trades: number;
  callPremium: number;
  putPremium: number;
  bullishPremium: number;
  bearishPremium: number;
}

const optionMinutes = (
  prints: readonly FlowOptionPrintRow[]
): Map<number, OptionMinute> => {
  const buckets = new Map<number, OptionMinute>();
  for (const print of prints) {
    const key = minuteKey(print.tradedAt);
    const bucket = buckets.get(key) ?? {
      bearishPremium: 0,
      bullishPremium: 0,
      callPremium: 0,
      putPremium: 0,
      trades: 0,
    };
    bucket.trades += 1;
    if (print.right === "call") bucket.callPremium += print.premium;
    else bucket.putPremium += print.premium;
    if (print.sentiment === "bullish") bucket.bullishPremium += print.premium;
    if (print.sentiment === "bearish") bucket.bearishPremium += print.premium;
    buckets.set(key, bucket);
  }
  return buckets;
};

/** Underlying minutes and option minutes on one time axis, with CVD over the window. */
export const buildMinuteRows = (
  minutes: readonly FlowMinuteRow[],
  prints: readonly FlowOptionPrintRow[],
  books: readonly FlowBookRow[]
): FlowSnapshot["minutes"] => {
  const tradeByMinute = new Map(
    minutes.map((row) => [minuteKey(row.minute), row])
  );
  const bookByMinute = new Map(books.map((book) => [minuteKey(book.at), book]));
  const optionByMinute = optionMinutes(prints);
  const keys = [
    ...new Set([...tradeByMinute.keys(), ...optionByMinute.keys()]),
  ].sort((a, b) => a - b);
  let cvd = 0;
  return keys.map((key) => {
    const trade = tradeByMinute.get(key);
    const option = optionByMinute.get(key);
    cvd += trade?.delta ?? 0;
    return {
      bearishPremium: option?.bearishPremium ?? 0,
      bookPressure: bookByMinute.get(key)?.pressure ?? null,
      bullishPremium: option?.bullishPremium ?? 0,
      buyVolume: trade?.buyVolume ?? 0,
      callPremium: option?.callPremium ?? 0,
      close: trade?.close ?? null,
      coveredSeconds: trade?.coveredSeconds ?? 0,
      cvd,
      delta: trade?.delta ?? 0,
      minute: new Date(key * 60_000).toISOString(),
      optionTrades: option?.trades ?? 0,
      putPremium: option?.putPremium ?? 0,
      sellVolume: trade?.sellVolume ?? 0,
      trades: trade?.trades ?? 0,
      volume: trade?.volume ?? 0,
      vwap: trade?.vwap ?? null,
    };
  });
};

const premiumWhere = (
  prints: readonly FlowOptionPrintRow[],
  keep: (print: FlowOptionPrintRow) => boolean
): number => sumOf(prints.filter(keep), (print) => print.premium);

const printView = (
  print: FlowOptionPrintRow
): FlowSnapshot["optionsFlow"]["topPrints"][number] => ({
  at: iso(print.tradedAt),
  consolidation: print.consolidation,
  contract: `${print.ticker} ${print.expiry} ${print.strike}${print.right === "call" ? "C" : "P"}`,
  expiry: print.expiry,
  goldenSweep: print.goldenSweep,
  moneyness: print.moneyness,
  opening: print.opening,
  premium: print.premium,
  price: print.price,
  right: print.right,
  sentiment: print.sentiment,
  side: print.side,
  size: print.size,
  strike: print.strike,
  unusual: print.unusual,
  volumeOverOi: print.volumeOverOi,
});

/** Options flow of the window: premium by right, sentiment, aggressor side and print type. */
export const buildOptionsSummary = (
  ticker: FlowSnapshot["optionsFlow"]["ticker"],
  prints: readonly FlowOptionPrintRow[]
): FlowSnapshot["optionsFlow"] => {
  const where = (keep: (print: FlowOptionPrintRow) => boolean) =>
    premiumWhere(prints, keep);
  const countWhere = (keep: (print: FlowOptionPrintRow) => boolean) =>
    prints.filter(keep).length;
  const call = where((print) => print.right === "call");
  const put = where((print) => print.right === "put");
  const total = call + put;
  return {
    askSidePremium: where(
      (print) => print.side === "ask" || print.side === "above_ask"
    ),
    bearishPremium: where((print) => print.sentiment === "bearish"),
    bidSidePremium: where(
      (print) => print.side === "bid" || print.side === "below_bid"
    ),
    blockPremium: where((print) => print.consolidation === "block"),
    blocks: countWhere((print) => print.consolidation === "block"),
    bullishPremium: where((print) => print.sentiment === "bullish"),
    callPremium: call,
    openingPremiumShare: ratio(
      where((print) => print.opening),
      total
    ),
    otmPremiumShare: ratio(
      where((print) => print.moneyness === "otm"),
      total
    ),
    putCallPremiumRatio: ratio(put, call),
    putPremium: put,
    sweepPremium: where((print) => print.consolidation === "sweep"),
    sweeps: countWhere((print) => print.consolidation === "sweep"),
    ticker,
    topPrints: [...prints]
      .sort((a, b) => b.premium - a.premium)
      .slice(0, FLOW_SNAPSHOT_MAX_PRINTS)
      .map(printView),
    trades: prints.length,
    unusual: countWhere((print) => print.unusual),
    volumeOverOi: countWhere((print) => print.volumeOverOi),
    zeroDtePremiumShare: ratio(
      where((print) => print.dte !== null && print.dte < 1),
      total
    ),
  };
};

const shift = (value: number | null, basis: number): number | null =>
  value === null ? null : value + basis;

export const buildGexView = (gex: FlowGexRow | null): FlowSnapshot["gex"] => {
  if (gex === null) return null;
  const { basis } = gex;
  return {
    at: iso(gex.at),
    basis,
    ivRegime: gex.ivRegime,
    levels: {
      callWall: gex.callWall,
      flip: gex.flip,
      maxPain: gex.maxPain,
      putWall: gex.putWall,
    },
    netDex: gex.netDex,
    regime: gex.regime,
    spot: gex.spot,
    symbolLevels:
      basis === null
        ? null
        : {
            callWall: shift(gex.callWall, basis),
            flip: shift(gex.flip, basis),
            maxPain: shift(gex.maxPain, basis),
            putWall: shift(gex.putWall, basis),
          },
    ticker: gex.ticker,
    totalGex: gex.totalGex,
    zeroDteShare: gex.zeroDteShare,
  };
};

const bookView = (
  book: FlowBookRow | null
): FlowSnapshot["orderFlow"]["book"] =>
  book === null
    ? null
    : {
        askSize: book.askSize,
        at: iso(book.at),
        bestAsk: book.bestAsk,
        bestBid: book.bestBid,
        bidSize: book.bidSize,
        levels: book.levels,
        pressure: book.pressure,
      };

const buildOrderFlow = (
  rows: FlowSnapshotRows,
  minutes: readonly FlowMinuteRow[],
  book: FlowBookRow | null
): FlowSnapshot["orderFlow"] => {
  const volume = sumOf(minutes, (row) => row.volume);
  const delta = sumOf(minutes, (row) => row.delta);
  const offExchange = sumOf(minutes, (row) => row.offExchangeVolume);
  return {
    book: bookView(book),
    coveredSeconds: sumOf(minutes, (row) => row.coveredSeconds),
    delta,
    deltaRatio: ratio(delta, volume),
    largePrints: sumOf(minutes, (row) => row.largePrints),
    lastPrice: minutes.at(-1)?.close ?? null,
    offExchangeShare: rows.symbol === "SPY" ? ratio(offExchange, volume) : null,
    volume,
    vwap: ratio(
      sumOf(minutes, (row) => row.vwap * row.volume),
      volume
    ),
    windowSeconds: Math.round(
      (rows.windowEnd.getTime() - rows.windowStart.getTime()) / 1000
    ),
  };
};

const eventView = (event: FlowEventRow): FlowSnapshot["events"][number] => ({
  at: iso(event.at),
  detail: event.detail.slice(0, 200),
  direction: event.direction,
  kind: event.kind,
  premium: event.premium,
  price: event.price,
  size: event.size,
});

const recentInputs = (
  rows: FlowSnapshotRows,
  minutes: readonly FlowMinuteRow[]
): Readonly<{ deltaRatio: number | null; premiumBias: number | null }> => {
  const end = rows.windowEnd.getTime();
  const recent = minutes.filter(
    (row) => row.minute.getTime() >= end - 15 * 60_000
  );
  const prints = rows.prints.filter(
    (print) => print.tradedAt.getTime() >= end - 30 * 60_000
  );
  const bull = premiumWhere(prints, (print) => print.sentiment === "bullish");
  const bear = premiumWhere(prints, (print) => print.sentiment === "bearish");
  return {
    deltaRatio: ratio(
      sumOf(recent, (row) => row.delta),
      sumOf(recent, (row) => row.volume)
    ),
    premiumBias: ratio(bull - bear, bull + bear),
  };
};

const flowNotes = (symbol: FlowSymbol): string[] => [
  "Ticks are sampled (up to 1000 prints per symbol about every 4 minutes); coveredSeconds says how much of each minute was seen.",
  "Trade side: quote rule, then tick rule. Options side and sentiment come from QuantData.",
  symbol === "ES"
    ? "ES options context uses SPX options; SPX levels are shifted by the ES − SPX basis."
    : "SPY book is IEX depth plus top of book from other venues (no paid venue books).",
  "GEX is an estimate (dealers assumed long calls, short puts). Research only; not a trade signal.",
];

export const buildFlowSnapshot = (rows: FlowSnapshotRows): FlowSnapshot => {
  const freshness = buildFreshness(rows);
  const minutes = [...rows.minutes].sort(byTime((row) => row.minute));
  const books = [...rows.books].sort(byTime((row) => row.at));
  const book = books.at(-1) ?? null;
  const orderFlow = buildOrderFlow(rows, minutes, book);
  const usable = Object.fromEntries(
    freshness.map((entry) => [
      entry.source,
      entry.state === "fresh" || entry.state === "closed",
    ])
  ) as Record<FlowSource, boolean>;
  return {
    confluence: buildConfluence({
      ...recentInputs(rows, minutes),
      gex: rows.gex,
      lastPrice: orderFlow.lastPrice,
      pressure: book?.pressure ?? null,
      usable,
    }),
    events: [...rows.events]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, FLOW_SNAPSHOT_MAX_EVENTS)
      .map(eventView),
    freshness,
    generatedAt: iso(rows.now),
    gex: buildGexView(rows.gex),
    minutes: buildMinuteRows(minutes, rows.prints, books),
    notes: flowNotes(rows.symbol),
    optionsFlow: buildOptionsSummary(
      FLOW_INSTRUMENTS[rows.symbol].optionsTicker,
      rows.prints
    ),
    orderFlow,
    schemaVersion: FLOW_SNAPSHOT_VERSION,
    symbol: rows.symbol,
    windowEnd: iso(rows.windowEnd),
    windowStart: iso(rows.windowStart),
  };
};
