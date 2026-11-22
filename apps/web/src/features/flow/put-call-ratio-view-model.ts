// What: pure view-model of the Put/call ratio panel of /flow (flow.putCallRatio,
// flow-put-call-ratio.v1): the symbols that have the panel, the title, header, totals, extremes,
// counts, days summary and rule texts, the geometry of the intraday session charts (stepped
// running premium & volume ratios with 1.00 parity line, y-axis ticks, unread shade, and
// underlying price) and the multi-day charts (daily session premium & volume ratios with 1.00
// parity line, incomplete-session bands, point markers, and underlying price), plus legends and
// ARIA text alternatives.
// Research only: the ratios describe stored option prints, never a trade signal.
// Used by: apps/web/src/components/portal/flow-put-call-ratio-panel.tsx,
// apps/web/src/components/portal/flow-workspace.tsx.
// See: docs/vertex-rebuild/flow-pipeline.md ("Put/call ratio (SPY, ES)").
import {
  FLOW_INSTRUMENTS,
  FLOW_PUT_CALL_RATIO_SYMBOLS,
  type FlowPutCallRatio,
  type FlowPutCallRatioInput,
  type FlowPutCallRatioMinute,
  type FlowPutCallRatioRules,
  type FlowPutCallRatioSymbol,
} from "@darkfactory/api";

import {
  formatCount,
  formatMoney,
  formatPrice,
  formatRatio,
} from "./format.ts";
import type { FlowSymbol } from "./view-model.ts";

/** What the page asks flow.putCallRatio for: one symbol with stored option prints. */
export type PutCallRatioRequest = FlowPutCallRatioInput;

export type PutCallRatioView = "session" | "days";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const etClock = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: "America/New_York",
});
const shortDate = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** "10:42 ET": New York wall time without seconds. */
const etTime = (ms: number): string => `${etClock.format(new Date(ms))} ET`;

/** "2026-11-20" → "Nov 20". */
export const formatSessionShortDate = (session: string): string =>
  shortDate.format(new Date(`${session}T12:00:00.000Z`));

/** The symbol when the panel exists for it (stored option prints), else null. */
export const putCallRatioSymbolOf = (
  symbol: FlowSymbol
): FlowPutCallRatioSymbol | null =>
  FLOW_PUT_CALL_RATIO_SYMBOLS.find((candidate) => candidate === symbol) ?? null;

/** "Put/call ratio · SPY options" or "Put/call ratio · SPX options (ES)". */
export const putCallRatioTitle = (symbol: FlowPutCallRatioSymbol): string => {
  const ticker = FLOW_INSTRUMENTS[symbol].optionsTicker;
  return ticker === symbol
    ? `Put/call ratio · ${ticker} options`
    : `Put/call ratio · ${ticker} options (${symbol})`;
};

export const PUT_CALL_RATIO_LOADING = "Loading put/call ratio…";
export const PUT_CALL_RATIO_NO_POINTS =
  "No regular-session option print stored for this session.";
export const PUT_CALL_RATIO_NO_DAYS =
  "No regular-session option print stored in the last 14 days.";
export const PUT_CALL_RATIO_NO_CALLS_SESSION =
  "No put/call ratio: no call prints in this session.";
export const PUT_CALL_RATIO_NO_CALLS_DAYS =
  "No put/call ratio: no call prints in the stored sessions.";

/** Empty state when no option print is stored for the symbol in the retention window. */
export const putCallRatioEmptyLine = (symbol: FlowPutCallRatioSymbol): string =>
  `No option prints stored for ${symbol} in the last 14 days.`;

/** The error line of a failed call; the next refresh retries it. */
export const putCallRatioFailureLine = (
  failure: Readonly<{ code: string; message: string; failedAt: number }>,
  refreshMs: number
): string =>
  `Put/call ratio not loaded: ${failure.code}: ${failure.message} · retrying with the next refresh at ${etTime(failure.failedAt + refreshMs)}`;

const OPTIONS_STATE_WORDS: Readonly<
  Record<FlowPutCallRatio["options"]["state"], string>
> = {
  closed: "closed",
  fresh: "fresh",
  never: "never collected",
  stale: "stale",
};

/**
 * "Session 2026-11-20 · as of 15:58 ET · 5 stored days · options fresh", plus the incomplete
 * sentence when an open gap overlaps the newest session.
 */
export const putCallRatioHeaderLine = (response: FlowPutCallRatio): string => {
  const asOf =
    response.storedUntil === null
      ? "no regular-session print"
      : `as of ${etTime(Date.parse(response.storedUntil))}`;
  const daysText =
    response.days.length === 1
      ? "1 stored session"
      : `${whole.format(response.days.length)} stored sessions`;
  const parts = [
    `Session ${response.session ?? "none"}`,
    asOf,
    daysText,
    `options ${OPTIONS_STATE_WORDS[response.options.state]}`,
  ];
  if (response.unread !== null)
    parts.push(
      `Incomplete: prints of ${etClock.format(new Date(response.unread.from))}–${etTime(Date.parse(response.unread.to))} not read yet; earlier parts of the line can still change.`
    );
  return parts.join(" · ");
};

/** Session totals: premium P/C with put/call dollars, and volume P/C with put/call contracts. */
export const putCallRatioTotalsLine = (response: FlowPutCallRatio): string => {
  const {
    callPremium,
    callVolume,
    premiumRatio,
    putPremium,
    putVolume,
    volumeRatio,
  } = response.totals;
  return `Premium P/C ${formatRatio(premiumRatio, "no calls")} (puts ${formatMoney(putPremium)} / calls ${formatMoney(callPremium)}) · volume P/C ${formatRatio(volumeRatio, "no calls")} (puts ${formatCount(putVolume)} / calls ${formatCount(callVolume)})`;
};

const extremeText = (entry: FlowPutCallRatioMinute): string =>
  `${formatRatio(entry.ratio)} at ${etTime(Date.parse(entry.minute))}`;

/** Session intraday range of the running premium and volume ratios. */
export const putCallRatioExtremesLine = (
  response: FlowPutCallRatio
): string => {
  const { premiumHigh, premiumLow, volumeHigh, volumeLow } = response.totals;
  const premium =
    premiumLow === null || premiumHigh === null
      ? "premium no ratio"
      : `premium ${extremeText(premiumLow)} to ${extremeText(premiumHigh)}`;
  const volume =
    volumeLow === null || volumeHigh === null
      ? "volume no ratio"
      : `volume ${extremeText(volumeLow)} to ${extremeText(volumeHigh)}`;
  return `Session range · ${premium} · ${volume}`;
};

/** "3,100 prints (1,400 puts, 1,700 calls)". */
export const putCallRatioCountsLine = (response: FlowPutCallRatio): string => {
  const { callPrints, prints, putPrints } = response.totals;
  return `${whole.format(prints)} prints (${whole.format(putPrints)} puts, ${whole.format(callPrints)} calls)`;
};

/** Summary line for the multi-day view. */
export const putCallRatioDaysSummaryLine = (
  response: FlowPutCallRatio
): string => {
  const { days } = response;
  const first = days[0];
  const latest = days.at(-1);
  if (first === undefined || latest === undefined)
    return PUT_CALL_RATIO_NO_DAYS;
  const span =
    days.length === 1
      ? `1 session (${first.session})`
      : `${whole.format(days.length)} sessions (${first.session} to ${latest.session})`;
  const incomplete = days.filter((day) => day.incomplete).length;
  const parts = [
    span,
    `latest premium P/C ${formatRatio(latest.premiumRatio, "no calls")}`,
    `latest volume P/C ${formatRatio(latest.volumeRatio, "no calls")}`,
  ];
  if (incomplete > 0)
    parts.push(
      incomplete === 1
        ? "1 session incomplete (open collector gap)"
        : `${whole.format(incomplete)} sessions incomplete (open collector gaps)`
    );
  return parts.join(" · ");
};

/** The rules and data limits in plain words, built from response.rules. */
export const putCallRatioRuleText = (rules: FlowPutCallRatioRules): string =>
  `Gross put divided by call over stored option prints of $${whole.format(rules.minPremiumUsd)} or more (09:30–16:15 ET, all aggressor sides, retained ${rules.retentionDays} days). Parity is ${rules.parity.toFixed(2)}: above ${rules.parity.toFixed(2)} means more put than call. Net drift stores signed values and is not used. Research only, not a trade signal. ${rules.version}.`;

/** "SPY price", or "SPX index price" for ES (the stored underlying price is the SPX index). */
export const putCallRatioPriceName = (response: FlowPutCallRatio): string =>
  `${response.ticker}${response.symbol === "ES" ? " index" : ""} price`;

/** Text alternative for the session ratio chart. */
export const sessionRatioAriaLabel = (response: FlowPutCallRatio): string =>
  `Put/call ratio over session ${response.session ?? "none"}: ${putCallRatioTotalsLine(response)}. ${putCallRatioExtremesLine(response)}.`;

/** Text alternative for the multi-day ratio chart. */
export const daysRatioAriaLabel = (response: FlowPutCallRatio): string =>
  `Put/call ratio over stored days: ${putCallRatioDaysSummaryLine(response)}.`;

// --- Charts ----------------------------------------------------------------------------------

/** Space above and below the lines, in chart units. */
export const PUT_CALL_RATIO_CHART_PAD = 6;

export type RatioTick = Readonly<{ value: number; y: number; label: string }>;

export type PutCallSessionChart = Readonly<{
  width: number;
  height: number;
  /** Stepped paths over the session; null when that series has no non-null point. */
  premiumPath: string | null;
  volumePath: string | null;
  parityY: number;
  /** 3 to 5 ticks, highest first. */
  ticks: readonly RatioTick[];
  /** Open gaps inside the drawn time span; null without one. */
  unread: Readonly<{ x: number; width: number }> | null;
  startLabel: string;
  endLabel: string;
}>;

export type PutCallPriceChart = Readonly<{
  width: number;
  height: number;
  /** Null when no point/day has a price. */
  path: string | null;
  /** Point markers for the days price subplot (empty for session stepped line). */
  markers: readonly Readonly<{ x: number; y: number; label: string }>[];
  lowLabel: string;
  highLabel: string;
}>;

export type PutCallDayMarker = Readonly<{
  session: string;
  x: number;
  y: number;
  ratio: number;
  incomplete: boolean;
}>;

export type PutCallDaysChart = Readonly<{
  width: number;
  height: number;
  /** Polyline path across non-null days; null if fewer than two consecutive non-null days exist. */
  premiumPath: string | null;
  volumePath: string | null;
  premiumMarkers: readonly PutCallDayMarker[];
  volumeMarkers: readonly PutCallDayMarker[];
  incompleteBands: readonly Readonly<{
    session: string;
    x: number;
    width: number;
  }>[];
  parityY: number;
  ticks: readonly RatioTick[];
  axisLabels: readonly Readonly<{
    session: string;
    label: string;
    x: number;
  }>[];
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
  const end = Math.max(Date.parse(newest), start) + MINUTE_MS;
  return {
    end,
    start,
    x: (ms: number): number =>
      ((Math.min(Math.max(ms, start), end) - start) / (end - start)) * width,
  };
};

const STEP_MULTIPLES = [1, 2, 2.5, 5] as const;
/** Minimum step so two-decimal tick labels (formatRatio) are always distinct. */
const MIN_RATIO_STEP = 0.05;

/**
 * A non-negative nice scale holding `low`, `high` and `parity` (1.00): smallest step >= 0.05
 * of {1, 2, 2.5, 5} × 10ⁿ giving 3 to 5 ticks, with bottom >= 0.
 */
export const ratioNiceScale = (
  low: number,
  high: number,
  parity = 1
): Readonly<{ min: number; max: number; step: number }> => {
  const min = Math.max(0, Math.min(parity, low));
  const rawMax = Math.max(parity, high);
  const max = rawMax === min ? min + 1 : rawMax;
  const span = max - min;
  let exponent = Math.max(-2, Math.floor(Math.log10(span / 4)) - 1);
  for (;;) {
    for (const multiple of STEP_MULTIPLES) {
      const step = multiple * 10 ** exponent;
      if (step < MIN_RATIO_STEP) continue;
      const bottom = Math.max(0, Math.floor(min / step) * step);
      const top = Math.max(Math.ceil(max / step) * step, bottom + 2 * step);
      if (Math.round((top - bottom) / step) <= 4)
        return { max: top, min: bottom, step };
    }
    exponent += 1;
  }
};

const buildTicks = (
  scale: Readonly<{ min: number; max: number; step: number }>,
  y: (value: number) => number
): RatioTick[] => {
  const ticks: RatioTick[] = [];
  for (
    let index = Math.round((scale.max - scale.min) / scale.step);
    index >= 0;
    index -= 1
  ) {
    const value = Number((scale.min + index * scale.step).toPrecision(12));
    ticks.push({ label: formatRatio(value), value, y: y(value) });
  }
  return ticks;
};

const steppedRatioPath = (
  points: FlowPutCallRatio["points"],
  pick: (point: FlowPutCallRatio["points"][number]) => number | null,
  x: (ms: number) => number,
  y: (value: number) => number,
  end: number
): string | null => {
  const commands: string[] = [];
  let started = false;
  for (const point of points) {
    const value = pick(point);
    if (value === null) continue;
    const px = x(Date.parse(point.minute));
    const py = y(value);
    if (started) {
      commands.push(`H${px}`, `V${py}`);
    } else {
      commands.push(`M${px} ${py}`);
      started = true;
    }
  }
  if (!started) return null;
  commands.push(`H${x(end)}`);
  return commands.join(" ");
};

/**
 * Geometry of the intraday session put/call ratio chart, or null when the response has no point
 * or no non-null ratio in the session.
 */
export const buildSessionRatioChart = (
  response: FlowPutCallRatio,
  width: number,
  height: number
): PutCallSessionChart | null => {
  const { points, rules, session, unread } = response;
  const newest = points.at(-1);
  if (session === null || newest === undefined) return null;
  const values: number[] = [];
  for (const point of points) {
    if (point.premiumRatio !== null) values.push(point.premiumRatio);
    if (point.volumeRatio !== null) values.push(point.volumeRatio);
  }
  if (values.length === 0) return null;

  const axis = timeAxis(session, newest.minute, width);
  const scale = ratioNiceScale(
    Math.min(...values),
    Math.max(...values),
    rules.parity
  );
  const usable = height - 2 * PUT_CALL_RATIO_CHART_PAD;
  const y = (value: number): number =>
    PUT_CALL_RATIO_CHART_PAD +
    ((scale.max - value) / (scale.max - scale.min)) * usable;

  const shade = ((): PutCallSessionChart["unread"] => {
    if (unread === null) return null;
    const from = axis.x(Date.parse(unread.from));
    const to = axis.x(Date.parse(unread.to));
    return to > from ? { width: to - from, x: from } : null;
  })();

  return {
    endLabel: etTime(axis.end),
    height,
    parityY: y(rules.parity),
    premiumPath: steppedRatioPath(
      points,
      (point) => point.premiumRatio,
      axis.x,
      y,
      axis.end
    ),
    startLabel: etTime(axis.start),
    ticks: buildTicks(scale, y),
    unread: shade,
    volumePath: steppedRatioPath(
      points,
      (point) => point.volumeRatio,
      axis.x,
      y,
      axis.end
    ),
    width,
  };
};

/** Underlying price stepped line on the session time axis. */
export const buildSessionPriceChart = (
  response: FlowPutCallRatio,
  width: number,
  height: number
): PutCallPriceChart | null => {
  const { points, session } = response;
  const newest = points.at(-1);
  if (session === null || newest === undefined) return null;
  const priced = points.flatMap((point) =>
    point.price === null ? [] : [{ minute: point.minute, price: point.price }]
  );
  if (priced.length === 0)
    return {
      height,
      highLabel: "",
      lowLabel: "",
      markers: [],
      path: null,
      width,
    };
  const axis = timeAxis(session, newest.minute, width);
  const low = Math.min(...priced.map((point) => point.price));
  const high = Math.max(...priced.map((point) => point.price));
  const usable = height - 2 * PUT_CALL_RATIO_CHART_PAD;
  const y = (price: number): number =>
    high === low
      ? height / 2
      : PUT_CALL_RATIO_CHART_PAD + ((high - price) / (high - low)) * usable;
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
    markers: [],
    path: commands.join(" "),
    width,
  };
};

/** Builds a polyline over evenly-spaced days, breaking across null days; null if no segment exists. */
const polylineAcrossDays = (
  days: FlowPutCallRatio["days"],
  pick: (day: FlowPutCallRatio["days"][number]) => number | null,
  xAt: (index: number) => number,
  y: (value: number) => number
): string | null => {
  const segments: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 2) segments.push(run.join(" "));
    run = [];
  };
  for (const [index, day] of days.entries()) {
    const value = pick(day);
    if (value === null) {
      flush();
      continue;
    }
    const cmd = run.length === 0 ? "M" : "L";
    run.push(`${cmd}${xAt(index)} ${y(value)}`);
  }
  flush();
  return segments.length === 0 ? null : segments.join(" ");
};

const dayAxisLabels = (
  days: FlowPutCallRatio["days"],
  xAt: (index: number) => number
): PutCallDaysChart["axisLabels"] => {
  const middle = Math.floor((days.length - 1) / 2);
  const keep = new Set<number>([0, middle, days.length - 1]);
  return days.flatMap((day, index) =>
    keep.has(index)
      ? [
          {
            label: formatSessionShortDate(day.session),
            session: day.session,
            x: xAt(index),
          },
        ]
      : []
  );
};

/**
 * Geometry of the multi-day put/call ratio chart, or null when no day has a non-null ratio.
 * Days are centered in equal slots across `width`, so 1 day renders a centered marker and N days
 * render connected lines with markers and optional incomplete-session bands.
 */
export const buildDaysRatioChart = (
  response: FlowPutCallRatio,
  width: number,
  height: number
): PutCallDaysChart | null => {
  const { days, rules } = response;
  if (days.length === 0) return null;
  const values: number[] = [];
  for (const day of days) {
    if (day.premiumRatio !== null) values.push(day.premiumRatio);
    if (day.volumeRatio !== null) values.push(day.volumeRatio);
  }
  if (values.length === 0) return null;

  const slotWidth = width / days.length;
  const xAt = (index: number): number => (index + 0.5) * slotWidth;
  const scale = ratioNiceScale(
    Math.min(...values),
    Math.max(...values),
    rules.parity
  );
  const usable = height - 2 * PUT_CALL_RATIO_CHART_PAD;
  const y = (value: number): number =>
    PUT_CALL_RATIO_CHART_PAD +
    ((scale.max - value) / (scale.max - scale.min)) * usable;

  const premiumMarkers: PutCallDayMarker[] = [];
  const volumeMarkers: PutCallDayMarker[] = [];
  const incompleteBands: Array<{ session: string; x: number; width: number }> =
    [];

  days.forEach((day, index) => {
    const x = xAt(index);
    if (day.premiumRatio !== null)
      premiumMarkers.push({
        incomplete: day.incomplete,
        ratio: day.premiumRatio,
        session: day.session,
        x,
        y: y(day.premiumRatio),
      });
    if (day.volumeRatio !== null)
      volumeMarkers.push({
        incomplete: day.incomplete,
        ratio: day.volumeRatio,
        session: day.session,
        x,
        y: y(day.volumeRatio),
      });
    if (day.incomplete)
      incompleteBands.push({
        session: day.session,
        width: slotWidth,
        x: index * slotWidth,
      });
  });

  return {
    axisLabels: dayAxisLabels(days, xAt),
    height,
    incompleteBands,
    parityY: y(rules.parity),
    premiumMarkers,
    premiumPath: polylineAcrossDays(days, (day) => day.premiumRatio, xAt, y),
    ticks: buildTicks(scale, y),
    volumeMarkers,
    volumePath: polylineAcrossDays(days, (day) => day.volumeRatio, xAt, y),
    width,
  };
};

/** Underlying last-print price across stored days on the same slot axis as buildDaysRatioChart. */
export const buildDaysPriceChart = (
  response: FlowPutCallRatio,
  width: number,
  height: number
): PutCallPriceChart | null => {
  const { days } = response;
  if (days.length === 0) return null;
  const priced = days.flatMap((day, index) =>
    day.price === null
      ? []
      : [{ index, price: day.price, session: day.session }]
  );
  if (priced.length === 0)
    return {
      height,
      highLabel: "",
      lowLabel: "",
      markers: [],
      path: null,
      width,
    };
  const slotWidth = width / days.length;
  const xAt = (index: number): number => (index + 0.5) * slotWidth;
  const low = Math.min(...priced.map((entry) => entry.price));
  const high = Math.max(...priced.map((entry) => entry.price));
  const usable = height - 2 * PUT_CALL_RATIO_CHART_PAD;
  const y = (price: number): number =>
    high === low
      ? height / 2
      : PUT_CALL_RATIO_CHART_PAD + ((high - price) / (high - low)) * usable;
  return {
    height,
    highLabel: formatPrice(high),
    lowLabel: formatPrice(low),
    markers: priced.map((entry) => ({
      label: `${entry.session}: ${formatPrice(entry.price)}`,
      x: xAt(entry.index),
      y: y(entry.price),
    })),
    path: polylineAcrossDays(days, (day) => day.price, xAt, y),
    width,
  };
};

/** Text alternative for the session or days price chart. */
export const putCallRatioPriceAriaLabel = (
  response: FlowPutCallRatio,
  chart: PutCallPriceChart,
  view: PutCallRatioView
): string => {
  const name = putCallRatioPriceName(response);
  const scope =
    view === "session"
      ? `session ${response.session ?? "none"}`
      : "stored days";
  return chart.path === null && chart.markers.length === 0
    ? `${name}, ${scope}: no price`
    : `${name}, ${scope}: low ${chart.lowLabel}, high ${chart.highLabel}`;
};

export type PutCallRatioLegendEntry = Readonly<{
  key: "premium" | "volume" | "parity" | "unread";
  text: string;
}>;

/** Legend entries: premium line, volume line, parity line, and gap shade only when drawn. */
export const putCallRatioLegend = (
  hasShade: boolean,
  view: PutCallRatioView
): readonly PutCallRatioLegendEntry[] => [
  { key: "premium", text: "Premium P/C ratio" },
  { key: "volume", text: "Volume P/C ratio" },
  { key: "parity", text: "1.00 parity (equal put and call)" },
  ...(hasShade
    ? [
        {
          key: "unread" as const,
          text:
            view === "session"
              ? "Not read yet (open collector gap)"
              : "Incomplete session (open collector gap)",
        },
      ]
    : []),
];
