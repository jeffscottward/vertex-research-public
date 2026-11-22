// What: pure view-model of the Hedging pressure panel of /flow (flow.hedgingPressure,
// flow-hedging-pressure.v1): the symbols that have the panel, the title, the header, totals,
// counts and rule texts, the geometry of the two charts (stepped net, call and put lines with a
// zero line, y-axis ticks and the unread shade; the underlying price) and the text alternatives.
// The component draws what these functions return.
// Research only: the line is an estimate of dealer hedging, never a trade signal.
// Used by: apps/web/src/components/portal/flow-hedging-pressure-panel.tsx,
// apps/web/src/components/portal/flow-workspace.tsx.
// See: docs/vertex-rebuild/flow-pipeline.md ("Hedging pressure (SPY, ES)").
import {
  FLOW_HEDGING_SYMBOLS,
  FLOW_INSTRUMENTS,
  type FlowHedgingMinute,
  type FlowHedgingPressure,
  type FlowHedgingPressureInput,
  type FlowHedgingPressureRules,
  type FlowHedgingSymbol,
} from "@darkfactory/api";

import { formatMoney, formatPrice, formatSignedMoney } from "./format.ts";
import type { FlowSymbol } from "./view-model.ts";

/** What the page asks flow.hedgingPressure for: one symbol with stored option prints. */
export type HedgingPressureRequest = FlowHedgingPressureInput;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const etClock = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: "America/New_York",
});

/** "10:42 ET": New York wall time without seconds. */
const etTime = (ms: number): string => `${etClock.format(new Date(ms))} ET`;

/** The symbol when the panel exists for it (stored option prints), else null. */
export const hedgingSymbolOf = (symbol: FlowSymbol): FlowHedgingSymbol | null =>
  FLOW_HEDGING_SYMBOLS.find((candidate) => candidate === symbol) ?? null;

/** "Hedging pressure · SPY options" or "Hedging pressure · SPX options (ES)". */
export const hedgingTitle = (symbol: FlowHedgingSymbol): string => {
  const ticker = FLOW_INSTRUMENTS[symbol].optionsTicker;
  return ticker === symbol
    ? `Hedging pressure · ${ticker} options`
    : `Hedging pressure · ${ticker} options (${symbol})`;
};

export const HEDGING_LOADING = "Loading hedging pressure…";
export const HEDGING_NO_POINTS = "No counted print in this session.";

/** The line of a response without a stored print. */
export const hedgingEmptyLine = (symbol: FlowHedgingSymbol): string =>
  `No option prints stored for ${symbol} in the last 14 days.`;

/** The error line of a failed call; the next refresh retries it. */
export const hedgingFailureLine = (
  failure: Readonly<{ code: string; message: string; failedAt: number }>,
  refreshMs: number
): string =>
  `Hedging pressure not loaded: ${failure.code}: ${failure.message} · retrying with the next refresh at ${etTime(failure.failedAt + refreshMs)}`;

const OPTIONS_STATE_WORDS: Readonly<
  Record<FlowHedgingPressure["options"]["state"], string>
> = {
  closed: "closed",
  fresh: "fresh",
  never: "never collected",
  stale: "stale",
};

/**
 * "Session 2026-11-20 · as of 15:58 ET · options fresh", plus the read cap note when the response
 * is truncated and the incomplete sentence when an open gap lies inside the session.
 */
export const hedgingHeaderLine = (response: FlowHedgingPressure): string => {
  const asOf =
    response.storedUntil === null
      ? "no counted print"
      : `as of ${etTime(Date.parse(response.storedUntil))}`;
  const parts = [
    `Session ${response.session ?? "none"}`,
    asOf,
    `options ${OPTIONS_STATE_WORDS[response.options.state]}`,
  ];
  if (response.truncated)
    parts.push(
      response.storedUntil === null
        ? "read cap reached, later prints not read"
        : `read cap reached, prints after ${etTime(Date.parse(response.storedUntil))} not counted`
    );
  if (response.unread !== null)
    parts.push(
      `Incomplete: prints of ${etClock.format(new Date(response.unread.from))}–${etTime(Date.parse(response.unread.to))} not read yet; earlier parts of the line can still change.`
    );
  return parts.join(" · ");
};

/** "Net +$1.2B · calls +$2B · puts −$800M · gross $5.1B". */
export const hedgingTotalsLine = (response: FlowHedgingPressure): string => {
  const { calls, gross, net, puts } = response.totals;
  return `Net ${formatSignedMoney(net)} · calls ${formatSignedMoney(calls)} · puts ${formatSignedMoney(puts)} · gross ${formatMoney(gross)}`;
};

const minuteText = (minute: FlowHedgingMinute): string =>
  `${formatSignedMoney(minute.minuteNet)} at ${etTime(Date.parse(minute.minute))}`;

/** "Largest rise +$310M at 10:42 ET · largest fall −$450M at 15:58 ET". */
export const hedgingLargestLine = (response: FlowHedgingPressure): string => {
  const { largestFall, largestRise } = response.totals;
  return [
    largestRise === null
      ? "No rising minute"
      : `Largest rise ${minuteText(largestRise)}`,
    largestFall === null
      ? "no falling minute"
      : `largest fall ${minuteText(largestFall)}`,
  ].join(" · ");
};

/** "3,100 prints · 2,800 signed · 300 not signed (mid or no side) · 12 not priced · 40 IV adjusted". */
export const hedgingCountsLine = (response: FlowHedgingPressure): string => {
  const { ivAdjusted, notPriced, notSigned, prints, signed } = response.totals;
  return `${whole.format(prints)} prints · ${whole.format(signed)} signed · ${whole.format(notSigned)} not signed (mid or no side) · ${whole.format(notPriced)} not priced · ${whole.format(ivAdjusted)} IV adjusted`;
};

/** 0.04 → "4%", 0.015 → "1.5%". */
const percent = (fraction: number): string =>
  `${Number((fraction * 100).toFixed(4))}%`;

/** The assumptions of the line in plain words, with the numbers and the version of the rules. */
export const hedgingRuleText = (rules: FlowHedgingPressureRules): string =>
  `Estimate. Each print is signed by its aggressor side, assuming the dealer took the other side; mid prints and prints without a side are not counted. Delta is Black-Scholes at the print time (rate ${percent(rules.rate)}, yield ${percent(rules.dividendYield)}) from the print's IV (${percent(rules.volFallback)} when the stored IV is below 1%); it is not updated as price moves. Only prints with premium of $10,000 or more are stored; prints before 09:30 ET are not counted. Research only, not a trade signal. ${rules.version}.`;

/** The text alternative of the hedging pressure chart. */
export const hedgingAriaLabel = (response: FlowHedgingPressure): string =>
  `Hedging pressure, session ${response.session ?? "none"}: ${hedgingTotalsLine(response)}. ${hedgingLargestLine(response)}.`;

// --- Charts ----------------------------------------------------------------------------------

/** Space above and below the lines, in chart units. */
export const HEDGING_CHART_PAD = 4;

export type HedgingTick = Readonly<{ value: number; y: number; label: string }>;

export type HedgingChart = Readonly<{
  width: number;
  height: number;
  /** Stepped paths: one level per point, from 09:30 at 0 to the end of the newest minute. */
  net: string;
  calls: string;
  puts: string;
  zeroY: number;
  /** 3 to 5 ticks, highest first. */
  ticks: readonly HedgingTick[];
  /** The open gaps inside the drawn time span; null without one. */
  unread: Readonly<{ x: number; width: number }> | null;
  startLabel: string;
  endLabel: string;
}>;

/** 09:30 New York of a session date (YYYY-MM-DD), in daylight or standard time. */
const sessionOpenMs = (session: string): number => {
  const daylight = Date.parse(`${session}T13:30:00.000Z`);
  return etClock.format(new Date(daylight)) === "09:30"
    ? daylight
    : daylight + HOUR_MS;
};

/** The time axis: 09:30 of the session to the end of the newest point's minute. */
const timeAxis = (session: string, newest: string, width: number) => {
  const start = sessionOpenMs(session);
  // A point is never before 09:30 (the service counts session prints only); the end is still
  // kept after the start, so the scale never divides by 0.
  const end = Math.max(Date.parse(newest), start) + MINUTE_MS;
  return {
    end,
    start,
    x: (ms: number): number =>
      ((Math.min(Math.max(ms, start), end) - start) / (end - start)) * width,
  };
};

const STEP_MULTIPLES = [1, 2, 2.5, 5] as const;

/**
 * A nice scale that holds `low` and `high` (0 is always inside): the smallest step of
 * {1, 2, 2.5, 5} × 10ⁿ that gives at most 5 ticks. Such a step gives at least 3, because the
 * next smaller step gave more than 4 intervals and the steps grow by at most 2.5 times.
 */
export const niceScale = (
  low: number,
  high: number
): Readonly<{ min: number; max: number; step: number }> => {
  const min = Math.min(0, low);
  // All values 0: a scale of one unit above 0.
  const max = Math.max(0, high) === min ? min + 1 : Math.max(0, high);
  const span = max - min;
  let exponent = Math.floor(Math.log10(span / 4)) - 1;
  for (;;) {
    for (const multiple of STEP_MULTIPLES) {
      const step = multiple * 10 ** exponent;
      const bottom = Math.floor(min / step) * step;
      const top = Math.max(Math.ceil(max / step) * step, bottom + 2 * step);
      if (Math.round((top - bottom) / step) <= 4)
        return { max: top, min: bottom, step };
    }
    exponent += 1;
  }
};

const steppedPath = (
  points: FlowHedgingPressure["points"],
  value: (point: FlowHedgingPressure["points"][number]) => number,
  x: (ms: number) => number,
  y: (value: number) => number,
  start: number,
  end: number
): string => {
  const commands = [`M${x(start)} ${y(0)}`];
  for (const point of points)
    commands.push(`H${x(Date.parse(point.minute))}`, `V${y(value(point))}`);
  commands.push(`H${x(end)}`);
  return commands.join(" ");
};

/**
 * The geometry of the hedging pressure chart, or null when the response has no point. One y
 * scale for the net, call and put lines with 0 inside; each line steps at the start of a minute
 * with a counted print.
 */
export const buildHedgingChart = (
  response: FlowHedgingPressure,
  width: number,
  height: number
): HedgingChart | null => {
  const { points, session, unread } = response;
  const newest = points.at(-1);
  if (session === null || newest === undefined) return null;
  const axis = timeAxis(session, newest.minute, width);
  const values = points.flatMap((point) => [
    point.net,
    point.calls,
    point.puts,
  ]);
  const scale = niceScale(Math.min(...values), Math.max(...values));
  const usable = height - 2 * HEDGING_CHART_PAD;
  const y = (value: number): number =>
    HEDGING_CHART_PAD +
    ((scale.max - value) / (scale.max - scale.min)) * usable;
  const ticks: HedgingTick[] = [];
  for (
    let index = Math.round((scale.max - scale.min) / scale.step);
    index >= 0;
    index -= 1
  ) {
    // Rounded to the step's precision, so 0.1 + 0.2 shows as 0.3.
    const value = Number((scale.min + index * scale.step).toPrecision(12));
    ticks.push({ label: formatSignedMoney(value), value, y: y(value) });
  }
  const path = (
    pick: (point: FlowHedgingPressure["points"][number]) => number
  ) => steppedPath(points, pick, axis.x, y, axis.start, axis.end);
  const shade = ((): HedgingChart["unread"] => {
    if (unread === null) return null;
    const from = axis.x(Date.parse(unread.from));
    const to = axis.x(Date.parse(unread.to));
    return to > from ? { width: to - from, x: from } : null;
  })();
  return {
    calls: path((point) => point.calls),
    endLabel: etTime(axis.end),
    height,
    net: path((point) => point.net),
    puts: path((point) => point.puts),
    startLabel: etTime(axis.start),
    ticks,
    unread: shade,
    width,
    zeroY: y(0),
  };
};

export type HedgingPriceChart = Readonly<{
  width: number;
  height: number;
  /** Null when no point has a price. */
  path: string | null;
  lowLabel: string;
  highLabel: string;
}>;

/** The underlying price per point on the time axis of the hedging chart, as a stepped line. */
export const buildPriceChart = (
  response: FlowHedgingPressure,
  width: number,
  height: number
): HedgingPriceChart | null => {
  const { points, session } = response;
  const newest = points.at(-1);
  if (session === null || newest === undefined) return null;
  const priced = points.flatMap((point) =>
    point.price === null ? [] : [{ minute: point.minute, price: point.price }]
  );
  if (priced.length === 0)
    return { height, highLabel: "", lowLabel: "", path: null, width };
  const axis = timeAxis(session, newest.minute, width);
  const low = Math.min(...priced.map((point) => point.price));
  const high = Math.max(...priced.map((point) => point.price));
  const usable = height - 2 * HEDGING_CHART_PAD;
  const y = (price: number): number =>
    high === low
      ? height / 2
      : HEDGING_CHART_PAD + ((high - price) / (high - low)) * usable;
  const commands = priced.map((point, index) =>
    index === 0
      ? `M${axis.x(Date.parse(point.minute))} ${y(point.price)}`
      : `H${axis.x(Date.parse(point.minute))} V${y(point.price)}`
  );
  commands.push(`H${axis.x(axis.end)}`);
  return {
    height,
    highLabel: formatPrice(high),
    lowLabel: formatPrice(low),
    path: commands.join(" "),
    width,
  };
};

/** "SPY price", or "SPX index price" for ES (the stored underlying price is the SPX index). */
export const hedgingPriceName = (response: FlowHedgingPressure): string =>
  `${response.ticker}${response.symbol === "ES" ? " index" : ""} price`;

/** The text alternative of the price chart. */
export const hedgingPriceAriaLabel = (
  response: FlowHedgingPressure,
  chart: HedgingPriceChart
): string => {
  const name = hedgingPriceName(response);
  return chart.path === null
    ? `${name}, session ${response.session}: no price`
    : `${name}, session ${response.session}: low ${chart.lowLabel}, high ${chart.highLabel}`;
};

export type HedgingLegendEntry = Readonly<{
  key: "net" | "calls" | "puts" | "unread";
  text: string;
}>;

/** One entry per line, and the gap shade when the chart draws one. */
export const hedgingLegend = (
  chart: Pick<HedgingChart, "unread">
): readonly HedgingLegendEntry[] => [
  { key: "net", text: "Net (calls and puts)" },
  { key: "calls", text: "Calls" },
  { key: "puts", text: "Puts" },
  ...(chart.unread === null
    ? []
    : [{ key: "unread" as const, text: "Not read yet (open collector gap)" }]),
];
