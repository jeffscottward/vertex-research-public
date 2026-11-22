// What: pure view-model of the /flow control panel (flow.control): group of a symbol, title, the
// options, futures and agreement lines, the age notice, net drift metrics and chart, the
// cross-check and study sentences, the freshness rows and the deep trades block (streamed or
// sampled tape). The server sentences arrive as data.
// Research only: a state describes recent flow, never a trade signal.
// Used by: apps/web/src/components/portal/flow-control-panel.tsx.
// See: docs/vertex-rebuild/flow-pipeline.md.
import {
  FLOW_GROUPS,
  FLOW_INSTRUMENTS,
  type FlowControl,
  type FlowControlState,
  type FlowGroupId,
  type FlowNetDriftSeries,
} from "@darkfactory/api";

import {
  formatAge,
  formatEtSeconds,
  formatMoney,
  formatNyTime,
  UNREADABLE_TIME,
} from "./format.ts";
import {
  type FlowSymbol,
  FRESHNESS_TONE,
  type Metric,
  type Tone,
} from "./view-model.ts";

export type { FlowControl } from "@darkfactory/api";
export type FlowControlFailure = Readonly<{ code: string; message: string }>;
export type NetDriftView = "total" | "zero_dte" | "longer";

export const NET_DRIFT_VIEWS: readonly Readonly<{
  view: NetDriftView;
  label: string;
}>[] = Object.freeze([
  { label: "All expiries", view: "total" },
  { label: "Same day (0DTE)", view: "zero_dte" },
  { label: "Longer", view: "longer" },
]);

export const groupOfSymbol = (symbol: FlowSymbol): FlowGroupId =>
  FLOW_INSTRUMENTS[symbol].group;

export const controlTitle = (control: FlowControl): string =>
  `Who is in control: ${FLOW_GROUPS[control.group].label}`;

export const STATE_TONE: Readonly<Record<FlowControlState, Tone>> = {
  balanced: "neutral",
  buyers: "success",
  mixed: "warning",
  no_data: "info",
  sellers: "destructive",
};

export type ControlLine = Readonly<{
  key: "options" | "futures" | "agreement";
  state: string;
  tone: Tone;
  text: string;
  since: string | null;
  asOf: string | null;
  ratio: string | null;
}>;

/** "Data is <k> min old, refreshing" when the document is older than two refresh periods. */
export const controlAgeNotice = (
  control: FlowControl,
  now: Date,
  refreshMs: number
): string | null => {
  const age = now.getTime() - new Date(control.generatedAt).getTime();
  if (age <= 2 * refreshMs) return null;
  return `Data is ${Math.round(age / 60_000)} min old, refreshing`;
};

const asOfText = (asOf: string | null, now: Date): string | null => {
  if (asOf === null) return null;
  const at = new Date(asOf).getTime();
  // A timestamp that does not parse has no age.
  if (Number.isNaN(at)) return `as of ${UNREADABLE_TIME}`;
  return `as of ${formatNyTime(asOf)}, ${formatAge(Math.max(0, Math.round((now.getTime() - at) / 1000)))} ago`;
};

const sinceText = (since: string | null): string | null =>
  since === null ? null : `since ${formatNyTime(since)}`;

const ratioText = (
  side: Readonly<{ ratio: number | null; enterRatio: number }>
): string | null =>
  side.ratio === null
    ? null
    : `Ratio ${side.ratio.toFixed(2)} (enter ratio ${side.enterRatio.toFixed(2)})`;

/** Only an agreement has a side: green for buyers on both sides, red for sellers on both sides. */
const agreementTone = (agreement: FlowControl["agreement"]): Tone => {
  if (agreement.state === "diverge") return "warning";
  if (agreement.state !== "agree") return "info";
  if (agreement.direction === "bullish") return "success";
  return agreement.direction === "bearish" ? "destructive" : "info";
};

/** Three lines: options, futures, then the agreement of the two sides. */
export const controlLines = (
  control: FlowControl,
  now: Date,
  refreshMs: number
): readonly ControlLine[] => {
  const old = controlAgeNotice(control, now, refreshMs) !== null;
  const { agreement, futures, options, study } = control;
  return [
    {
      asOf: asOfText(options.asOf, now),
      key: "options",
      ratio: ratioText(options),
      since: sinceText(options.since),
      state: options.state,
      text:
        options.state === "no_data"
          ? `${options.label}: ${options.detail}`
          : options.label,
      tone: old ? "neutral" : STATE_TONE[options.state],
    },
    {
      asOf: asOfText(futures.asOf, now),
      key: "futures",
      ratio: ratioText(futures),
      since: sinceText(futures.since),
      state: futures.state,
      // The detail says why the side has no state, or which entry check holds the state back.
      text:
        futures.state === "no_data" || futures.hold !== null
          ? `${futures.label}; ${futures.detail}`
          : futures.label,
      tone: old ? "neutral" : STATE_TONE[futures.state],
    },
    {
      asOf: null,
      key: "agreement",
      ratio: null,
      since: sinceText(agreement.since),
      state: agreement.state,
      text: `${agreement.label}; ${agreement.detail} (${study.agreementDetail})`,
      tone: old ? "neutral" : agreementTone(agreement),
    },
  ];
};

const lineOf = (
  series: FlowNetDriftSeries,
  view: NetDriftView
): FlowNetDriftSeries["totals"]["total"] => {
  if (view === "total") return series.totals.total;
  return view === "zero_dte" ? series.totals.zeroDte : series.totals.longer;
};

export const netDriftSummary = (
  series: FlowNetDriftSeries,
  view: NetDriftView
): readonly Metric[] => {
  const totals = lineOf(series, view);
  const value = (pick: (line: NonNullable<typeof totals>) => number) =>
    totals === null ? "no bucket yet" : formatMoney(pick(totals));
  return [
    {
      label: "Net call premium",
      value: value((line) => line.netCallPremiumUsd),
    },
    { label: "Net put premium", value: value((line) => line.netPutPremiumUsd) },
    { label: "Call minus put", value: value((line) => line.callMinusPutUsd) },
    ...(view === "total"
      ? [
          {
            label: `Slope per minute (${series.slopeWindowMinutes} min)`,
            value: formatMoney(series.slopeUsdPerMinute, "too few buckets"),
          },
        ]
      : []),
    ...(series.partsDetail !== null && view !== "total"
      ? [{ label: "Expiry split", value: series.partsDetail }]
      : []),
  ];
};

export type NetDriftChart = Readonly<{
  width: 320;
  height: 96;
  call: string;
  put: string;
  difference: string;
  zeroY: number;
  min: number;
  max: number;
}>;

export const buildNetDriftChart = (
  series: FlowNetDriftSeries,
  view: NetDriftView
): NetDriftChart => {
  const lines = series.points.flatMap((point) => {
    const line =
      view === "total"
        ? point.total
        : view === "zero_dte"
          ? point.zeroDte
          : point.longer;
    return line === null
      ? []
      : [
          {
            call: line.netCallPremiumUsd,
            difference: line.netCallPremiumUsd - line.netPutPremiumUsd,
            put: line.netPutPremiumUsd,
          },
        ];
  });
  if (lines.length === 0)
    return {
      call: "",
      difference: "",
      height: 96,
      max: 0,
      min: 0,
      put: "",
      width: 320,
      zeroY: 48,
    };
  const values = lines.flatMap((line) => [
    line.call,
    line.put,
    line.difference,
  ]);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const y = (value: number) =>
    max === min ? 48 : 4 + ((max - value) / (max - min)) * 88;
  const x = (index: number) => (index / Math.max(1, lines.length - 1)) * 320;
  const path = (pick: (line: (typeof lines)[number]) => number) =>
    lines
      .map(
        (line, index) => `${x(index).toFixed(1)},${y(pick(line)).toFixed(1)}`
      )
      .join(" ");
  return {
    call: path((line) => line.call),
    difference: path((line) => line.difference),
    height: 96,
    max,
    min,
    put: path((line) => line.put),
    width: 320,
    zeroY: y(0),
  };
};

export const crossCheckLine = (control: FlowControl): string =>
  control.crossCheck.detail;

export const studyLine = (control: FlowControl): string => control.study.detail;

export const controlFreshnessRows = (
  control: FlowControl
): readonly Readonly<{ key: string; text: string; tone: Tone }>[] =>
  control.freshness.map((row) => {
    // The row of the futures tape has the source `ticks`; every other row is a net drift read.
    const name = `${row.instrument} ${row.source === "ticks" ? "tape" : "net drift"}`;
    return {
      key: `${row.instrument}:${row.source}`,
      text:
        row.lastOkAt === null
          ? `${name}: never collected`
          : `${name}: ${row.state}, last answer ${formatNyTime(row.lastOkAt)}`,
      tone: FRESHNESS_TONE[row.state],
    };
  });

type DeepTrades = FlowControl["deepTrades"];

const wholeNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const priceText = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});
const etMinutes = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: "America/New_York",
});

/** "A deep trade is one print of at least 40 contracts on ES." plus the signing rule; null without a limit. */
export const deepTradesLimitLine = (deep: DeepTrades): string | null => {
  if (deep.limitSize === null) return null;
  const limit = `A deep trade is one print of at least ${wholeNumber.format(deep.limitSize)} contracts on ${deep.symbol}.`;
  if (deep.signing === "tick") return `${limit} Sides come from the tick rule.`;
  if (deep.signing === "quote")
    return `${limit} Sides come from the quote rule.`;
  if (deep.trades.length === 0) return limit;
  const byTick = deep.trades.filter((trade) => trade.signing === "tick").length;
  return `${limit} Sides come from the quote rule where a quote was seen, else from the tick rule; the tick rule signed ${byTick} of the ${deep.trades.length} trades listed.`;
};

/**
 * How much of the trailing window the tape covers. A streamed tape states the share of covered
 * seconds; the freshness row says whether the stream is live now. A sampled tape also says that
 * every sum is a lower bound.
 */
export const deepTradesCoverageLine = (deep: DeepTrades): string => {
  const { coverage } = deep;
  if (deep.capture === "streamed")
    return coverage.share === null
      ? "Streamed tape: no covered second in this window yet."
      : `Streamed tape: ${Math.round(coverage.share * 100)}% of seconds covered in the last ${Math.round(coverage.windowSeconds / 60)} min (${wholeNumber.format(coverage.seenSeconds)} of ${wholeNumber.format(coverage.windowSeconds)} s); not checked against a second source.`;
  if (coverage.share === null)
    return "Tape seen: no sampled second in this window yet.";
  return `Tape seen: about ${Math.round(coverage.share * 100)}% of seconds in the last ${Math.round(coverage.windowSeconds / 60)} min (${wholeNumber.format(coverage.seenSeconds)} of ${wholeNumber.format(coverage.windowSeconds)} s). Busy periods are seen least: each fetch holds the newest 1000 prints, which span less time when trading is busy. The figure is approximate: it counts the first and last second of each sample, which deep-trade detection leaves out. Every sum is a lower bound.`;
};

const signedContracts = (value: number): string => {
  const magnitude = wholeNumber.format(Math.abs(value));
  return value > 0 ? `+${magnitude}` : value < 0 ? `−${magnitude}` : "0";
};

export const deepTradesSum = (deep: DeepTrades): Metric => ({
  label:
    deep.capture === "streamed"
      ? "Sum of deep trades since 09:30 ET (streamed tape)"
      : "Sum of sampled deep trades since 09:30 ET",
  value: `${signedContracts(deep.sums.netVolume)} contracts (buy ${wholeNumber.format(deep.sums.buyVolume)}, sell ${wholeNumber.format(deep.sums.sellVolume)})`,
});

export type DeepTradesChart = Readonly<{
  width: 320;
  height: 96;
  segments: readonly string[];
  zeroY: number;
  min: number;
  max: number;
}>;

const SESSION_LAST_MINUTE = 389;

/**
 * The running signed sum (buy minus sell) at each covered minute, placed by its minute after 09:30
 * ET; one segment per run of consecutive minutes, so a stretch without tape is a visible gap.
 */
export const buildDeepTradesChart = (deep: DeepTrades): DeepTradesChart => {
  if (deep.minutes.length === 0)
    return { height: 96, max: 0, min: 0, segments: [], width: 320, zeroY: 48 };
  let running = 0;
  const points = deep.minutes.map((entry) => {
    running += entry.buyVolume - entry.sellVolume;
    // "HH:MM" in New York; n = minutes after 09:30 ET.
    const clock = etMinutes.format(new Date(entry.minute));
    return {
      n: Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5)) - 570,
      value: running,
    };
  });
  const values = points.map((point) => point.value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const y = (value: number) =>
    max === min ? 48 : 4 + ((max - value) / (max - min)) * 88;
  const x = (n: number) => (n / SESSION_LAST_MINUTE) * 320;
  const runs: (typeof points)[] = [];
  let previousN = Number.NEGATIVE_INFINITY;
  let run: typeof points = [];
  for (const point of points) {
    if (point.n !== previousN + 1) {
      run = [];
      runs.push(run);
    }
    run.push(point);
    previousN = point.n;
  }
  const pair = (xValue: number, value: number) =>
    `${xValue.toFixed(1)},${y(value).toFixed(1)}`;
  // A run of one minute is drawn from x to x + 1 at its y.
  const segments = runs.map((entries) =>
    entries
      .flatMap((point) =>
        entries.length === 1
          ? [pair(x(point.n), point.value), pair(x(point.n) + 1, point.value)]
          : [pair(x(point.n), point.value)]
      )
      .join(" ")
  );
  return { height: 96, max, min, segments, width: 320, zeroY: y(0) };
};

export type DeepTradeRow = Readonly<{
  key: string;
  time: string;
  side: "Buy" | "Sell";
  tone: Tone;
  size: string;
  price: string;
  signing: "tick rule" | "quote rule";
}>;

export const deepTradeRows = (deep: DeepTrades): readonly DeepTradeRow[] =>
  deep.trades.map((trade, index) => ({
    key: `${trade.at}:${index}`,
    price: priceText.format(trade.price),
    side: trade.side === "buy" ? "Buy" : "Sell",
    signing: trade.signing === "tick" ? "tick rule" : "quote rule",
    size: wholeNumber.format(trade.size),
    time: formatEtSeconds(trade.at),
    tone: trade.side === "buy" ? STATE_TONE.buyers : STATE_TONE.sellers,
  }));

/** "Showing the newest 60 of 143 deep trades"; null when every trade is listed. */
export const deepTradesMoreLine = (deep: DeepTrades): string | null =>
  deep.totalTrades > deep.trades.length
    ? `Showing the newest ${deep.trades.length} of ${wholeNumber.format(deep.totalTrades)} deep trades`
    : null;

export const absorptionMarks = (
  deep: DeepTrades
): readonly Readonly<{ key: string; time: string; text: string }>[] =>
  deep.absorptions.map((mark, index) => ({
    key: `${mark.at}:${index}`,
    text:
      mark.price === null
        ? mark.detail
        : `${mark.detail} at ${priceText.format(mark.price)}`,
    time: `${etMinutes.format(new Date(mark.at))} ET`,
  }));

/** "FOMC meeting day." on an event day, else null. */
export const sessionEventLine = (control: FlowControl): string | null =>
  control.session.event === "fomc" ? "FOMC meeting day." : null;

/** The session levels from one-minute closes; a missing part reads "no value yet". */
export const levelsLine = (control: FlowControl): string | null => {
  const { levels } = control;
  if (levels === null) return null;
  const part = (value: number | null) =>
    value === null ? "no value yet" : priceText.format(value);
  return `${levels.ticker} session (from one-minute closes; on a half day this is not the official close): open ${part(levels.sessionOpen)}, high ${part(levels.sessionHigh)}, low ${part(levels.sessionLow)}, previous close ${part(levels.previousClose)}`;
};
