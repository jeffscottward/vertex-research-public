// What: market sessions per flow source, and the pure assembly of flow.snapshot from stored rows:
// window summaries, per-source freshness and the confluence reading (agree/disagree). Research
// only; a confluence reading describes recent flow and is never an instruction to trade.
import {
  FLOW_MONEYNESS,
  FLOW_OPTION_SIDES,
  FLOW_SNAPSHOT_MAX_EVENTS,
  FLOW_SNAPSHOT_MAX_PRINTS,
  FLOW_SNAPSHOT_SOURCES,
  FLOW_SNAPSHOT_VERSION,
  FLOW_SOURCE_METADATA,
  type FlowConfluence,
  type FlowFactor,
  type FlowFreshness,
  type FlowIndexOptionTicker,
  type FlowOptionPrintSymbol,
  type FlowSampleStatus,
  type FlowSnapshot,
  type FlowSnapshotSource,
  type FlowSource,
  type FlowSymbol,
  type FlowVote,
} from "../contracts/flow.ts";
import { IV_TERM_REGIMES } from "../contracts/options-analytics.ts";
import {
  FLOW_INSTRUMENTS,
  FLOW_OPTION_STREAMS,
  type FlowBookRow,
  type FlowEventRow,
  type FlowInstrument,
  type FlowMinuteRow,
  isFlowSymbol,
} from "../flow-features.ts";
import {
  type FlowOptionPrintRow,
  oiFlags,
  oiFlagsKnown,
} from "../flow-options.ts";
import { newYorkClock } from "../signal-alerts.ts";
import { marketSession, newYorkParts } from "./gex-context.ts";

/** Is this source's market open now (New York wall time; holidays are not modelled)? */
export const flowSessionOpen = (
  source: FlowSource,
  symbol: FlowOptionPrintSymbol,
  now: Date
): boolean => {
  const parts = newYorkParts(now);
  const day = parts["weekday"];
  const minutes = Number(parts["hour"]) * 60 + Number(parts["minute"]);
  // Market premium keeps its own live window and gap fill (flow-market-premium-collect.ts).
  if (source === "market_premium") return true;
  if (source === "net_drift")
    return (
      day !== "Sat" &&
      day !== "Sun" &&
      minutes >= 9 * 60 + 30 &&
      minutes < 16 * 60 + 20
    );
  if (source === "options")
    return (
      day !== "Sat" &&
      day !== "Sun" &&
      minutes >= 9 * 60 + 30 &&
      minutes < FLOW_OPTION_STREAMS[symbol].closeMinuteEt
    );
  if (source === "gex")
    return (
      day !== "Sat" &&
      day !== "Sun" &&
      minutes >= 9 * 60 + 30 &&
      minutes < 16 * 60 + 15
    );
  if (!isFlowSymbol(symbol)) return false;
  if (FLOW_INSTRUMENTS[symbol].session === "stock")
    return marketSession(now) !== "closed";
  // CME Globex equity futures: Sunday 18:00 to Friday 17:00, daily break 17:00-18:00.
  if (day === "Sat") return false;
  if (day === "Sun") return minutes >= 18 * 60;
  if (day === "Fri") return minutes < 17 * 60;
  return minutes < 17 * 60 || minutes >= 18 * 60;
};

/** Seconds after which a source's newest data counts as stale while its market is open. */
export const FLOW_STALE_SECONDS: Readonly<Record<FlowSource, number>> = {
  depth: FLOW_SOURCE_METADATA.depth.maxAgeSeconds,
  gex: FLOW_SOURCE_METADATA.gex.maxAgeSeconds,
  market_premium: FLOW_SOURCE_METADATA.market_premium.maxAgeSeconds,
  net_drift: FLOW_SOURCE_METADATA.net_drift.maxAgeSeconds,
  options: FLOW_SOURCE_METADATA.options.maxAgeSeconds,
  ticks: FLOW_SOURCE_METADATA.ticks.maxAgeSeconds,
};
/**
 * Stale limit of the streamed tape: the collector reads it every minute, so three missed reads
 * count as stale. FLOW_STALE_SECONDS.ticks stays the limit of the sampled ticks.
 */
export const FLOW_TAPE_STALE_SECONDS = 180;

/** The stale limit of one source of one symbol: the tape limit for streamed ticks. */
export const flowStaleSeconds = (
  source: FlowSource,
  symbol: FlowOptionPrintSymbol
): number =>
  source === "ticks" &&
  isFlowSymbol(symbol) &&
  FLOW_INSTRUMENTS[symbol].ticks === "stream"
    ? FLOW_TAPE_STALE_SECONDS
    : FLOW_STALE_SECONDS[source];

/** New York wall time of a date as HH:MM. */
export const flowClockText = (date: Date): string => {
  const { minute } = newYorkClock(date);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
};

/**
 * The New York date of the newest session at or before now (YYYY-MM-DD): Friday on Saturday and
 * Sunday, and the previous weekday before 09:30 on a weekday.
 */
export const flowSessionDate = (now: Date): string => {
  const parts = newYorkParts(now);
  const weekday = parts["weekday"];
  const minutes = Number(parts["hour"]) * 60 + Number(parts["minute"]);
  // Before 09:30 on a weekday today's session has not started: use the previous weekday.
  const beforeOpen = minutes < 9 * 60 + 30;
  const back = ((): number => {
    if (weekday === "Sat") return 1;
    if (weekday === "Sun") return 2;
    if (!beforeOpen) return 0;
    return weekday === "Mon" ? 3 : 1;
  })();
  const day = new Date(
    Date.UTC(
      Number(parts["year"]),
      Number(parts["month"]) - 1,
      Number(parts["day"]) - back
    )
  );
  return day.toISOString().slice(0, 10);
};

export type FlowSampleRow = Readonly<{
  symbol: FlowOptionPrintSymbol;
  source: FlowSource;
  at: Date;
  status: FlowSampleStatus;
  message: string | null;
  items: number;
}>;

export type FlowGexRow = Readonly<{
  symbol: FlowSymbol;
  at: Date;
  ticker: FlowIndexOptionTicker;
  spot: number | null;
  basis: number | null;
  // The stored words of `flow_gex.regime` and `flow_gex.iv_regime`: a row can hold a word
  // that is not a contract value (`unknown`), so the read mapping below decides.
  regime: string;
  totalGex: number | null;
  flip: number | null;
  callWall: number | null;
  putWall: number | null;
  maxPain: number | null;
  kingNode: number | null;
  netDex: number | null;
  zeroDteShare: number | null;
  ivRegime: string;
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
  staleSeconds: number
): FlowFreshness["state"] => {
  if (age === null) return "never";
  if (!sessionOpen) return "closed";
  return age > staleSeconds ? "stale" : "fresh";
};

/** The freshness row of one source of the symbol, from the newest samples. */
export const buildSourceFreshness = (
  rows: Readonly<{
    latest: readonly FlowSampleRow[];
    latestOk: readonly FlowSampleRow[];
    now: Date;
    symbol: FlowOptionPrintSymbol;
  }>,
  source: FlowSnapshotSource
): FlowFreshness => {
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
    state: freshnessState(
      age,
      sessionOpen,
      flowStaleSeconds(source, rows.symbol)
    ),
  };
};

export const buildFreshness = (rows: FlowSnapshotRows): FlowFreshness[] =>
  FLOW_SNAPSHOT_SOURCES.filter((source) =>
    FLOW_INSTRUMENTS[rows.symbol].sources.includes(source)
  ).map((source) => buildSourceFreshness(rows, source));

// Read direction of the stored words, the one place: a stored value that is not a
// contract value becomes the contract's named fallback. The collector keeps writing
// `unknown` (flow-options.ts, flow-collect.ts), so a rollback reads every row.
const contractValue = <T extends string>(
  values: readonly T[],
  stored: string,
  fallback: T
): T => values.find((value) => value === stored) ?? fallback;

// A stored GEX row always has a sign (the collector stores no row without one); any other
// word is read as no estimate.
const gexRegime = (stored: string): "positive" | "negative" | "no_data" =>
  stored === "positive" || stored === "negative" ? stored : "no_data";

// `HH:MM UTC`; a time that is not on the UTC day of `now` gets its date in front.
const utcTime = (time: Date, now: Date): string => {
  const text = time.toISOString();
  const clock = `${text.slice(11, 16)} UTC`;
  return text.slice(0, 10) === now.toISOString().slice(0, 10)
    ? clock
    : `${text.slice(0, 10)} ${clock}`;
};

export const vote = (value: number | null, threshold: number): FlowVote => {
  if (value === null) return "no_data";
  if (value >= threshold) return "bullish";
  if (value <= -threshold) return "bearish";
  return "neutral";
};

export const pct = (value: number): string =>
  `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`;

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

export type ConfluenceInput = Readonly<{
  symbol: FlowSymbol;
  now: Date;
  deltaRatio: number | null;
  pressure: number | null;
  premiumBias: number | null;
  gex: FlowGexRow | null;
  lastPrice: number | null;
  usable: Readonly<Record<FlowSnapshotSource, boolean>>;
  freshness: readonly FlowFreshness[];
}>;

const gexFactorValue = (input: ConfluenceInput): string => {
  const { gex } = input;
  if (!input.freshness.some((entry) => entry.source === "gex"))
    return `Not collected for ${input.symbol}`;
  if (gex === null) return "No GEX stored yet";
  const regime = gexRegime(gex.regime);
  if (regime === "no_data") return "Not computed: no GEX estimate";
  if (!input.usable.gex)
    return `Stale since ${utcTime(gex.at, input.now)}; last: ${regime} gamma`;
  const flip =
    gex.flip === null || gex.basis === null ? null : gex.flip + gex.basis;
  if (flip === null || input.lastPrice === null) return `${regime} gamma`;
  const side = input.lastPrice >= flip ? "above" : "below";
  return `${regime} gamma, price ${side} flip ${flip.toFixed(2)}`;
};

type VotingSource = Extract<FlowSnapshotSource, "ticks" | "depth" | "options">;

// The source is usable and still gives no number: what its window lacks.
const NO_INPUT: Readonly<Record<VotingSource, string>> = {
  depth: "No vote: no book sizes in newest snapshot",
  options: "No vote: no signed premium in last 30 min",
  ticks: "No vote: no trades in last 15 min",
};

const NO_VOTE_DETAIL =
  " The freshness table shows the last collector message; the next collector run retries.";

// The `value` text of a factor without a number: the state of its source.
const noVoteValue = (source: VotingSource, input: ConfluenceInput): string => {
  const entry = input.freshness.find((item) => item.source === source);
  if (entry === undefined) return `No vote: not collected for ${input.symbol}`;
  if (input.usable[source]) return NO_INPUT[source];
  // A source that is not usable and has a good sample is stale (never: no good sample).
  if (entry.lastOkAt === null) return "No vote: never collected";
  const lastGood = utcTime(new Date(entry.lastOkAt), input.now);
  return entry.lastStatus === "unavailable"
    ? `No vote: source failed; last good ${lastGood}`
    : `No vote: sample stale; last good ${lastGood}`;
};

const votingFactor = (
  input: ConfluenceInput,
  factor: Pick<FlowFactor, "detail" | "key" | "label">,
  source: VotingSource,
  value: number | null,
  threshold: number
): FlowFactor =>
  value === null
    ? {
        ...factor,
        detail: `${factor.detail}${NO_VOTE_DETAIL}`,
        value: noVoteValue(source, input),
        vote: "no_data",
      }
    : { ...factor, value: pct(value), vote: vote(value, threshold) };

export const buildConfluence = (input: ConfluenceInput): FlowConfluence => {
  const { usable } = input;
  const deltaRatio = usable.ticks ? input.deltaRatio : null;
  const pressure = usable.depth ? input.pressure : null;
  const premiumBias = usable.options ? input.premiumBias : null;
  const directional: FlowFactor[] = [
    votingFactor(
      input,
      {
        detail:
          "Signed volume (buys − sells) ÷ volume over the stored minutes of the last 15 min; ±10% or more counts.",
        key: "order_flow",
        label: "Order flow (delta)",
      },
      "ticks",
      deltaRatio,
      0.1
    ),
    votingFactor(
      input,
      {
        detail:
          "Resting bid size vs ask size in the newest book snapshot (top 10 rows); ±20% or more counts. Resting size can be pulled.",
        key: "book",
        label: "Book pressure",
      },
      "depth",
      pressure,
      0.2
    ),
    votingFactor(
      input,
      {
        detail:
          "QuantData bullish minus bearish premium over the last 30 minutes, as a share of both; ±15% or more counts.",
        key: "options_flow",
        label: "Options flow",
      },
      "options",
      premiumBias,
      0.15
    ),
  ];
  const gexFactor: FlowFactor = {
    detail:
      "Context, not a vote: positive gamma tends to damp moves, negative gamma to extend them. Estimate; assumes dealers long calls, short puts.",
    key: "gex",
    label: "GEX regime",
    value: gexFactorValue(input),
    vote: "context",
  };
  const count = (pick: (factor: FlowFactor) => boolean): number =>
    directional.filter(pick).length;
  const bullish = count((factor) => factor.vote === "bullish");
  const bearish = count((factor) => factor.vote === "bearish");
  const known = count(
    (factor) =>
      factor.vote === "bullish" ||
      factor.vote === "bearish" ||
      factor.vote === "neutral"
  );
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
  bearishPremium: number;
  bullishPremium: number;
  callPremium: number;
  putPremium: number;
  trades: number;
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

export const printView = (
  print: FlowOptionPrintRow
): FlowSnapshot["optionsFlow"]["topPrints"][number] => ({
  at: iso(print.tradedAt),
  consolidation: print.consolidation,
  contract: `${print.ticker} ${print.expiry} ${print.strike}${print.right === "call" ? "C" : "P"}`,
  expiry: print.expiry,
  goldenSweep: print.goldenSweep,
  moneyness: contractValue(FLOW_MONEYNESS, print.moneyness, "not_reported"),
  premium: print.premium,
  price: print.price,
  right: print.right,
  sentiment: print.sentiment,
  side: contractValue(FLOW_OPTION_SIDES, print.side, "not_classified"),
  size: print.size,
  strike: print.strike,
  unusual: print.unusual,
  ...oiFlags(print),
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
    // Share of the premium whose Opening flag is known (open interest not 0); null without any.
    openingPremiumShare: ratio(
      where((print) => oiFlags(print).opening),
      where(oiFlagsKnown)
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
    volumeOverOi: countWhere((print) => oiFlags(print).volumeOverOi),
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
    ivRegime: contractValue(IV_TERM_REGIMES, gex.ivRegime, "no_term_data"),
    levels: {
      callWall: gex.callWall,
      flip: gex.flip,
      kingNode: gex.kingNode,
      maxPain: gex.maxPain,
      putWall: gex.putWall,
    },
    netDex: gex.netDex,
    regime: gexRegime(gex.regime),
    spot: gex.spot,
    symbolLevels:
      basis === null
        ? null
        : {
            callWall: shift(gex.callWall, basis),
            flip: shift(gex.flip, basis),
            kingNode: shift(gex.kingNode, basis),
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
    offExchangeShare: FLOW_INSTRUMENTS[rows.symbol].offExchange
      ? ratio(offExchange, volume)
      : null,
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

export const eventView = (
  event: FlowEventRow
): FlowSnapshot["events"][number] => ({
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

/** How the prints of the symbol are read: streamed tape or sampled ticks. */
const tickNote = (instrument: FlowInstrument): string =>
  instrument.ticks === "stream"
    ? "Ticks come from the streamed tape: coveredSeconds says how much of each minute the stream covered. Coverage means that the stream was live; it is not checked against a second source."
    : "Ticks are sampled (up to 1000 prints about every 6 minutes); coveredSeconds says how much of each minute was seen.";

const flowNotes = (symbol: FlowSymbol): string[] => {
  const instrument = FLOW_INSTRUMENTS[symbol];
  const tape =
    instrument.ticks === "none"
      ? [
          `Trades are not collected for ${symbol}; this view shows depth, options flow and GEX.`,
        ]
      : [
          tickNote(instrument),
          "Trade side: quote rule, then tick rule. Options side and sentiment come from QuantData.",
        ];
  return [
    ...tape,
    instrument.note,
    "GEX is an estimate (dealers assumed long calls, short puts). Research only; not a trade signal.",
  ];
};

export const buildFlowSnapshot = (rows: FlowSnapshotRows): FlowSnapshot => {
  const freshness = buildFreshness(rows);
  const minutes = [...rows.minutes].sort(byTime((row) => row.minute));
  const books = [...rows.books].sort(byTime((row) => row.at));
  const book = books.at(-1) ?? null;
  const orderFlow = buildOrderFlow(rows, minutes, book);
  // A source without a freshness row (not collected for this symbol) has no usable data.
  const usableOf = (source: FlowSnapshotSource): boolean =>
    freshness.some(
      (entry) =>
        entry.source === source &&
        (entry.state === "fresh" || entry.state === "closed")
    );
  const usable: Readonly<Record<FlowSnapshotSource, boolean>> = {
    depth: usableOf("depth"),
    gex: usableOf("gex"),
    options: usableOf("options"),
    ticks: usableOf("ticks"),
  };
  return {
    confluence: buildConfluence({
      ...recentInputs(rows, minutes),
      freshness,
      gex: rows.gex,
      lastPrice: orderFlow.lastPrice,
      now: rows.now,
      pressure: book?.pressure ?? null,
      symbol: rows.symbol,
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
