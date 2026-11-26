// What: Pure view model for the /flow page (flow.snapshot): freshness rows, confluence tones,
// order-flow, book, options and GEX metrics, top option prints, events, and the per-minute
// delta/CVD chart geometry with unsampled minutes as gaps. Research only: a description of
// recent flow, never an instruction to trade.
// Used by: apps/web/src/components/portal/flow-workspace.tsx.
// See: packages/api/src/contracts/flow.ts; docs/vertex-rebuild/flow-pipeline.md.
import {
  classifyConnectivityMessage,
  FLOW_INSTRUMENTS,
  type FlowSnapshot,
} from "@darkfactory/api";

import { statusTime } from "../../components/status-time.ts";

import {
  enumLabel,
  formatAge,
  formatCount,
  formatDuration,
  formatMoney,
  formatNyDateTime,
  formatNyTime,
  formatPrice,
  formatRatio,
  formatShare,
  formatSigned,
  formatSignedPrice,
  formatSignedRatio,
} from "./format.ts";

export type { FlowSnapshot } from "@darkfactory/api";
export type FlowSymbol = FlowSnapshot["symbol"];
export type FlowFreshness = FlowSnapshot["freshness"][number];
export type FlowSource = FlowFreshness["source"];
export type FlowFreshnessState = FlowFreshness["state"];
export type FlowMinute = FlowSnapshot["minutes"][number];
export type FlowOrderFlow = FlowSnapshot["orderFlow"];
export type FlowBook = NonNullable<FlowOrderFlow["book"]>;
export type FlowOptionsFlow = FlowSnapshot["optionsFlow"];
export type FlowOptionPrint = FlowOptionsFlow["topPrints"][number];
export type FlowGex = NonNullable<FlowSnapshot["gex"]>;
export type FlowEvent = FlowSnapshot["events"][number];
export type FlowConfluence = FlowSnapshot["confluence"];
export type FlowConfluenceSummary = FlowConfluence["summary"];
export type FlowVote = FlowConfluence["factors"][number]["vote"];
export type FlowDirection = FlowEvent["direction"];

export type Tone = "destructive" | "info" | "neutral" | "success" | "warning";

export type Metric = Readonly<{ label: string; value: string; title?: string }>;

export const FLOW_VIEW_SYMBOLS: readonly FlowSymbol[] = Object.freeze([
  "SPY",
  "QQQ",
  "ES",
  "NQ",
]);
export const FLOW_WINDOW_MINUTES = Object.freeze([
  15, 30, 60, 120, 240, 390,
] as const);
export type FlowWindowMinutes = (typeof FLOW_WINDOW_MINUTES)[number];
export const FLOW_DEFAULT_WINDOW: FlowWindowMinutes = 120;

/** What the page asks flow.snapshot for: one symbol and one of the window choices. */
export type FlowRequest = Readonly<{
  symbol: FlowSymbol;
  minutes: FlowWindowMinutes;
}>;
export const FLOW_REFRESH_MS = 60_000;

export const FLOW_DISCLAIMER =
  "A description of recent flow, not a trade signal. Nothing on this page places, changes or cancels orders.";

/** "60 min" … "390 min (full session)" for the window select. */
export const windowLabel = (minutes: FlowWindowMinutes): string => {
  if (minutes === 390) return "390 min (full session)";
  return `${minutes} min`;
};

// --- Freshness -------------------------------------------------------------------------------

const SOURCE_ORDER: readonly FlowSource[] = [
  "ticks",
  "depth",
  "options",
  "gex",
];

const SOURCE_LABELS: Readonly<Record<FlowSource, string>> = {
  depth: "Order book",
  gex: "GEX",
  options: "Options flow",
  ticks: "Ticks",
};

export const FRESHNESS_TONE: Readonly<Record<FlowFreshnessState, Tone>> = {
  closed: "info",
  fresh: "success",
  never: "neutral",
  stale: "warning",
};

export type FreshnessRow = Readonly<{
  source: FlowSource;
  label: string;
  state: FlowFreshnessState;
  tone: Tone;
  age: string;
  lastOk: string;
  lastStatus: string;
  message: string | null;
}>;

export const freshnessRows = (
  freshness: readonly FlowFreshness[]
): readonly FreshnessRow[] =>
  [...freshness]
    .sort(
      (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
    )
    .map((row) => ({
      age:
        row.ageSeconds === null
          ? "never collected"
          : `${formatAge(row.ageSeconds)} ago`,
      label: SOURCE_LABELS[row.source],
      lastOk: row.lastOkAt === null ? "never" : formatNyDateTime(row.lastOkAt),
      lastStatus: row.lastStatus ?? "no samples yet",
      message: row.message,
      source: row.source,
      state: row.state,
      tone: FRESHNESS_TONE[row.state],
    }));

/** True when no source has ever stored data for this symbol. */
export const neverCollected = (freshness: readonly FlowFreshness[]): boolean =>
  freshness.every((row) => row.state === "never");

export type FailingFreshnessSource = Readonly<{
  authFailed: boolean;
  label: string;
  message: string;
  source: FlowSource;
}>;

/** Sources whose newest collector attempt failed (`lastStatus === "unavailable"`), even if closed/fresh. */
export const failingFreshnessSources = (
  freshness: readonly FlowFreshness[]
): readonly FailingFreshnessSource[] =>
  freshnessRows(freshness)
    .filter((row) => row.lastStatus === "unavailable")
    .map((row) => {
      const message =
        row.message ??
        "Collector recorded no error message; check the collector log or /connections";
      return {
        authFailed:
          classifyConnectivityMessage(message).category === "auth_failed",
        label: row.label,
        message,
        source: row.source,
      };
    });

// --- Confluence ------------------------------------------------------------------------------

export const SUMMARY_TONE: Readonly<Record<FlowConfluenceSummary, Tone>> = {
  agree_bearish: "destructive",
  agree_bullish: "success",
  disagree: "warning",
  insufficient: "info",
  neutral: "neutral",
};

export const VOTE_TONE: Readonly<Partial<Record<FlowVote, Tone>>> = {
  bearish: "destructive",
  bullish: "success",
  context: "neutral",
  neutral: "neutral",
  no_data: "info",
};

/** The badge tone of a vote; a vote this page version has no tone for is shown as info. */
export const voteTone = (vote: string): Tone =>
  (Object.hasOwn(VOTE_TONE, vote)
    ? (VOTE_TONE as Partial<Record<string, Tone>>)[vote]
    : undefined) ?? "info";

export const VOTE_LABELS: Readonly<Partial<Record<FlowVote, string>>> = {
  bearish: "bearish",
  bullish: "bullish",
  context: "context",
  neutral: "neutral",
  no_data: "no data",
};

const DIRECTION_TONE: Readonly<Record<FlowDirection, Tone>> = {
  bearish: "destructive",
  bullish: "success",
  neutral: "neutral",
};

// --- Order flow and book ---------------------------------------------------------------------

/** "37m 20s of 2h (31%)"; "no window yet" for an empty window. */
export const coverageText = (
  coveredSeconds: number,
  windowSeconds: number
): string => {
  if (windowSeconds <= 0) return "no window yet";
  const share = Math.round((coveredSeconds / windowSeconds) * 100);
  return `${formatDuration(coveredSeconds)} of ${formatDuration(windowSeconds)} (${share}%)`;
};

export const orderFlowMetrics = (
  orderFlow: FlowOrderFlow,
  symbol: FlowSymbol
): readonly Metric[] => [
  { label: "Delta", value: formatSigned(orderFlow.delta) },
  {
    label: "Delta ratio",
    value: formatSignedRatio(orderFlow.deltaRatio, "no trades in window"),
  },
  { label: "Volume", value: formatCount(orderFlow.volume) },
  { label: "VWAP", value: formatPrice(orderFlow.vwap, "no trades in window") },
  {
    label: "Last price",
    value: formatPrice(orderFlow.lastPrice, "no trades in window"),
  },
  { label: "Large prints", value: String(orderFlow.largePrints) },
  ...(FLOW_INSTRUMENTS[symbol].offExchange
    ? [
        {
          label: "Off-exchange share",
          value: formatShare(orderFlow.offExchangeShare, "no trades in window"),
        },
      ]
    : []),
  {
    label: "Tape coverage",
    value: coverageText(orderFlow.coveredSeconds, orderFlow.windowSeconds),
  },
];

/** "+0.24 (bid-heavy)"; within ±0.1 is balanced. */
export const pressureText = (pressure: number | null): string => {
  if (pressure === null) return "no book data";
  let side = "balanced";
  if (pressure > 0.1) side = "bid-heavy";
  else if (pressure < -0.1) side = "ask-heavy";
  return `${formatSignedRatio(pressure)} (${side})`;
};

export const bookMetrics = (book: FlowBook): readonly Metric[] => [
  {
    label: "Best bid",
    value: `${formatPrice(book.bestBid, "no bid")} × ${formatCount(book.bidSize)}`,
  },
  {
    label: "Best ask",
    value: `${formatPrice(book.bestAsk, "no ask")} × ${formatCount(book.askSize)}`,
  },
  { label: "Pressure", value: pressureText(book.pressure) },
  { label: "Levels", value: String(book.levels) },
  { label: "Book as of", value: formatNyTime(book.at) },
];

// --- Options flow ----------------------------------------------------------------------------

export const optionsMetrics = (options: FlowOptionsFlow): readonly Metric[] => [
  { label: "Prints", value: String(options.trades) },
  { label: "Call premium", value: formatMoney(options.callPremium) },
  { label: "Put premium", value: formatMoney(options.putPremium) },
  {
    label: "Put/call premium",
    value: formatRatio(options.putCallPremiumRatio, "no call premium"),
  },
  { label: "Bullish premium", value: formatMoney(options.bullishPremium) },
  { label: "Bearish premium", value: formatMoney(options.bearishPremium) },
  { label: "Ask-side premium", value: formatMoney(options.askSidePremium) },
  { label: "Bid-side premium", value: formatMoney(options.bidSidePremium) },
  {
    label: "Sweeps",
    value: `${options.sweeps} · ${formatMoney(options.sweepPremium)}`,
  },
  {
    label: "Blocks",
    value: `${options.blocks} · ${formatMoney(options.blockPremium)}`,
  },
  { label: "Unusual", value: String(options.unusual) },
  { label: "Vol > OI", value: String(options.volumeOverOi) },
  {
    label: "OTM share",
    value: formatShare(options.otmPremiumShare, "no option premium"),
  },
  {
    label: "0DTE share",
    value: formatShare(options.zeroDtePremiumShare, "no option premium"),
  },
  {
    label: "Opening share",
    // Null with premium: every print reported open interest 0, so no Opening flag can be read.
    value: formatShare(
      options.openingPremiumShare,
      options.callPremium + options.putPremium > 0
        ? "no Opening flag: every print reports open interest 0"
        : "no option premium"
    ),
  },
];

const SIDE_LABELS: Readonly<Partial<Record<FlowOptionPrint["side"], string>>> =
  {
    above_ask: "Above ask",
    ask: "At ask",
    below_bid: "Below bid",
    bid: "At bid",
    mid: "Mid",
    not_classified: "not classified",
  };

const SIDE_TITLES: Readonly<Partial<Record<string, string>>> = {
  not_classified:
    "QuantData sent no side code for this print, or a code that this version does not map",
};

export type OptionPrintRow = Readonly<{
  key: string;
  time: string;
  contract: string;
  right: "C" | "P";
  strike: string;
  expiry: string;
  size: string;
  price: string;
  premium: string;
  side: string;
  /** Cause of a side without a direction; null when the side label needs none. */
  sideTitle: string | null;
  sentiment: FlowOptionPrint["sentiment"];
  tone: Tone;
  kind: FlowOptionPrint["consolidation"];
  flags: readonly string[];
}>;

export const optionPrintRows = (
  prints: readonly FlowOptionPrint[]
): readonly OptionPrintRow[] =>
  prints.map((print, index) => ({
    contract: print.contract,
    expiry: print.expiry,
    flags: [
      ...(print.moneyness === "not_reported"
        ? []
        : [print.moneyness.toUpperCase()]),
      ...(print.goldenSweep ? ["golden sweep"] : []),
      ...(print.unusual ? ["unusual"] : []),
      ...(print.volumeOverOi ? ["vol>OI"] : []),
      ...(print.opening ? ["opening"] : []),
    ],
    key: `${print.at}-${print.contract}-${index}`,
    kind: print.consolidation,
    premium: formatMoney(print.premium),
    price: formatPrice(print.price, "price not sent"),
    right: print.right === "call" ? "C" : "P",
    sentiment: print.sentiment,
    side: enumLabel(SIDE_LABELS, print.side),
    sideTitle:
      (Object.hasOwn(SIDE_TITLES, print.side)
        ? SIDE_TITLES[print.side]
        : undefined) ?? null,
    size: formatCount(print.size),
    strike: formatPrice(print.strike),
    time: formatNyTime(print.at),
    tone: DIRECTION_TONE[print.sentiment],
  }));

// --- GEX -------------------------------------------------------------------------------------

// `zero` has no producer on the flow page (a stored row is positive or negative), so it has no
// label here and shows the enumLabel text.
const GEX_REGIME_LABELS: Readonly<Partial<Record<FlowGex["regime"], string>>> =
  {
    negative: "Negative gamma (moves can extend)",
    no_data: "no GEX estimate",
    positive: "Positive gamma (moves tend to damp)",
  };

const IV_REGIME_LABELS: Readonly<Partial<Record<FlowGex["ivRegime"], string>>> =
  {
    contango: "Contango (back IV above front)",
    flat: "Flat",
    inverted: "Inverted (front IV above back)",
    no_term_data: "no front-back IV pair",
  };

const LEVEL_KEYS = [
  "flip",
  "callWall",
  "putWall",
  "maxPain",
  "kingNode",
] as const;
type LevelKey = (typeof LEVEL_KEYS)[number];
const LEVEL_LABELS: Readonly<Record<LevelKey, string>> = {
  callWall: "Call wall",
  flip: "Gamma flip",
  kingNode: "King node",
  maxPain: "Max pain",
  putWall: "Put wall",
};

export type GexLevelRow = Readonly<{
  key: LevelKey;
  label: string;
  symbolPrice: string;
  underlyingPrice: string;
}>;

/** Each level in the symbol's own price and in the options underlying (SPX for ES). */
export const gexLevelRows = (gex: FlowGex): readonly GexLevelRow[] =>
  LEVEL_KEYS.map((key) => ({
    key,
    label: LEVEL_LABELS[key],
    symbolPrice: formatPrice(
      gex.symbolLevels?.[key] ?? null,
      gex.symbolLevels === null ? "basis not computed" : "no level"
    ),
    underlyingPrice: formatPrice(gex.levels[key], "no level"),
  }));

const regimeTitle = (gex: FlowGex, at: string): string | undefined =>
  gex.regime === "no_data"
    ? `The stored GEX row of ${at} has no positive or negative regime`
    : undefined;

const ivRegimeTitle = (gex: FlowGex, at: string): string | undefined =>
  gex.ivRegime === "no_term_data"
    ? `The ${at} GEX sample has no separate front and back expiry: no expiry 1 or more days out had an ATM IV, or the front expiry was also the first one 25+ days out, or it was the last one with an ATM IV. Front and back IV are not stored`
    : undefined;

const titled = (metric: Metric, title: string | undefined): Metric =>
  title === undefined ? metric : { ...metric, title };

export const gexMetrics = (
  gex: FlowGex,
  now: Date = new Date()
): readonly Metric[] => {
  const at = statusTime(gex.at, now);
  return [
    titled(
      { label: "Regime", value: enumLabel(GEX_REGIME_LABELS, gex.regime) },
      regimeTitle(gex, at)
    ),
    { label: "Total GEX", value: formatMoney(gex.totalGex, "not computed") },
    { label: "Net DEX", value: formatMoney(gex.netDex, "not computed") },
    {
      label: "0DTE share",
      value: formatShare(
        gex.zeroDteShare,
        "no flow share (no flow premium, or the flow request failed)"
      ),
    },
    titled(
      {
        label: "IV regime",
        value: enumLabel(IV_REGIME_LABELS, gex.ivRegime),
      },
      ivRegimeTitle(gex, at)
    ),
    {
      label: `${gex.ticker} spot`,
      value: formatPrice(gex.spot, "spot not received"),
    },
    { label: "GEX as of", value: formatNyTime(gex.at) },
  ];
};

/** How the symbol's price relates to the options underlying. */
export const basisNote = (
  symbol: FlowSymbol,
  gex: FlowGex,
  now: Date = new Date()
): string => {
  if (gex.ticker === symbol)
    return `Levels come from ${gex.ticker} options, already in ${symbol} price.`;
  if (gex.basis === null)
    return `Levels come from ${gex.ticker} options and are shown in ${gex.ticker} price only: the ${symbol} − ${gex.ticker} basis was not computed for the ${statusTime(gex.at, now)} GEX sample (no ${symbol} price or no ${gex.ticker} spot in that collector run) · the next GEX sample computes it again`;
  return `Levels come from ${gex.ticker} options, shifted into ${symbol} price by the ${symbol} − ${gex.ticker} basis of ${formatSignedPrice(gex.basis)}.`;
};

// --- Events ----------------------------------------------------------------------------------

const EVENT_KIND_LABELS: Readonly<Record<FlowEvent["kind"], string>> = {
  absorption: "Absorption",
  exhaustion: "Exhaustion",
  large_print: "Large print",
  off_exchange_print: "Off-exchange print",
  option_block: "Option block",
  option_golden_sweep: "Golden sweep",
  option_print: "Option print",
  option_sweep: "Option sweep",
  stacked_imbalance: "Stacked imbalance",
};

export type EventRow = Readonly<{
  key: string;
  time: string;
  kind: string;
  direction: FlowDirection;
  tone: Tone;
  detail: string;
}>;

export const eventRows = (events: readonly FlowEvent[]): readonly EventRow[] =>
  events.map((event, index) => ({
    detail: event.detail,
    direction: event.direction,
    key: `${event.at}-${event.kind}-${index}`,
    kind: EVENT_KIND_LABELS[event.kind],
    time: formatNyTime(event.at),
    tone: DIRECTION_TONE[event.direction],
  }));

// --- Per-minute chart ------------------------------------------------------------------------

export const CHART_SLOT_WIDTH = 4;
export const CHART_HEIGHT = 96;
const CHART_PAD = 4;
const MINUTE_MS = 60_000;

export type ChartBar = Readonly<{
  minute: string;
  x: number;
  y: number;
  width: number;
  height: number;
  positive: boolean;
}>;

export type ChartGap = Readonly<{ x: number; width: number }>;

export type FlowChart = Readonly<{
  width: number;
  height: number;
  slots: number;
  covered: number;
  zeroY: number;
  cvdZeroY: number;
  bars: readonly ChartBar[];
  gaps: readonly ChartGap[];
  /** Polyline point lists, one per run of sampled minutes. */
  cvdSegments: readonly string[];
  maxAbsDelta: number;
  lastCvd: number;
  startLabel: string;
  endLabel: string;
}>;

type Slot = Readonly<{ minute: FlowMinute | null; index: number }>;

const slotsFor = (
  minutes: readonly FlowMinute[],
  first: number,
  count: number
): readonly Slot[] => {
  const byIndex = new Map<number, FlowMinute>();
  for (const minute of minutes) {
    const index = Math.floor(Date.parse(minute.minute) / MINUTE_MS) - first;
    if (index >= 0 && index < count && minute.coveredSeconds > 0)
      byIndex.set(index, minute);
  }
  return Array.from({ length: count }, (_, index) => ({
    index,
    minute: byIndex.get(index) ?? null,
  }));
};

/**
 * Delta bars and a CVD line on one per-minute axis from windowStart to windowEnd. Minutes the
 * sampler did not see (missing or coveredSeconds 0) draw no bar, break the CVD line and are
 * shaded as gaps. Null when the window has no sampled minute.
 */
export const buildFlowChart = (
  snapshot: Pick<FlowSnapshot, "minutes" | "windowEnd" | "windowStart">
): FlowChart | null => {
  const first = Math.floor(Date.parse(snapshot.windowStart) / MINUTE_MS);
  const last = Math.floor(Date.parse(snapshot.windowEnd) / MINUTE_MS);
  const count = Math.max(1, last - first + 1);
  const slots = slotsFor(snapshot.minutes, first, count);
  const sampled = slots.flatMap((slot) =>
    slot.minute === null ? [] : [slot.minute]
  );
  const lastSampled = sampled.at(-1);
  if (lastSampled === undefined) return null;

  const height = CHART_HEIGHT;
  const zeroY = height / 2;
  const maxAbsDelta = Math.max(1, ...sampled.map((row) => Math.abs(row.delta)));
  const scale = (zeroY - CHART_PAD) / maxAbsDelta;
  const cvdValues = sampled.map((row) => row.cvd);
  const cvdMax = Math.max(0, ...cvdValues);
  const cvdMin = Math.min(0, ...cvdValues);
  const span = cvdMax - cvdMin || 1;
  const cvdY = (value: number): number =>
    CHART_PAD + ((cvdMax - value) / span) * (height - 2 * CHART_PAD);

  const bars: ChartBar[] = [];
  const gaps: ChartGap[] = [];
  // Runs of sampled minutes: each becomes one CVD polyline, so a gap breaks the line.
  const runs: { x: number; cvd: number }[][] = [];
  let run: { x: number; cvd: number }[] = [];
  let gapStart: number | null = null;
  const closeGap = (end: number) => {
    if (gapStart === null) return;
    gaps.push({
      width: (end - gapStart) * CHART_SLOT_WIDTH,
      x: gapStart * CHART_SLOT_WIDTH,
    });
    gapStart = null;
  };
  for (const { index, minute } of slots) {
    if (minute === null) {
      gapStart ??= index;
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    closeGap(index);
    const barHeight = Math.abs(minute.delta) * scale;
    const positive = minute.delta >= 0;
    bars.push({
      height: barHeight,
      minute: minute.minute,
      positive,
      width: CHART_SLOT_WIDTH - 1,
      x: index * CHART_SLOT_WIDTH + 0.5,
      y: positive ? zeroY - barHeight : zeroY,
    });
    run.push({
      cvd: minute.cvd,
      x: index * CHART_SLOT_WIDTH + CHART_SLOT_WIDTH / 2,
    });
  }
  closeGap(count);
  if (run.length > 0) runs.push(run);

  const point = (x: number, value: number): string =>
    `${x.toFixed(1)},${cvdY(value).toFixed(1)}`;
  const cvdSegments = runs.map((points) =>
    points
      .flatMap(({ cvd, x }) =>
        // A lone sampled minute still shows as a short tick.
        points.length === 1
          ? [point(x - 1.5, cvd), point(x + 1.5, cvd)]
          : [point(x, cvd)]
      )
      .join(" ")
  );
  return {
    bars,
    covered: sampled.length,
    cvdSegments,
    cvdZeroY: cvdY(0),
    endLabel: formatNyTime(snapshot.windowEnd),
    gaps,
    height,
    lastCvd: lastSampled.cvd,
    maxAbsDelta,
    slots: count,
    startLabel: formatNyTime(snapshot.windowStart),
    width: count * CHART_SLOT_WIDTH,
    zeroY,
  };
};

/** The badge of the short-term factors block: counts, never a trade signal. */
export const shortTermBadge = (
  confluence: FlowSnapshot["confluence"]
): string => {
  const { bearish, bullish, known } = confluence;
  if (known === 0) return "No short-term factor has data yet";
  if (bullish === 0 && bearish === 0)
    return `${known} short-term factors neutral`;
  if (bullish > bearish)
    return `${bullish} of ${known} short-term factors bullish`;
  if (bearish > bullish)
    return `${bearish} of ${known} short-term factors bearish`;
  return `Short-term factors split: ${bullish} bullish, ${bearish} bearish of ${known}`;
};

/** What the collector does not read for a symbol, or null when it reads trades and option prints. */
export const notCollectedLine = (symbol: FlowSymbol): string | null => {
  const { sources } = FLOW_INSTRUMENTS[symbol];
  if (sources.includes("ticks")) return null;
  const holders = Object.values(FLOW_INSTRUMENTS)
    .filter((instrument) => instrument.sources.includes("ticks"))
    .map((instrument) => instrument.symbol)
    .sort();
  const names = `${holders.slice(0, -1).join(", ")} and ${holders.at(-1)}`;
  return `Not collected for ${symbol}: trades. The IBKR budget goes to ${names}.`;
};
