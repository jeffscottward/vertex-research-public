import type {
  OpenbbIvHistoryHorizon,
  OpenbbIvHistoryOutput,
  OpenbbIvHistoryPoint,
} from "@darkfactory/api";

import {
  formatNumber,
  formatPercent,
} from "../../features/openbb/view-model.ts";

// Pure view-model for O20 IV rank / percentile history chart (IvRankHistoryPanel).
// Transforms openbb.ivHistory payloads into SVG geometry, regime classification, UTC-safe axis
// ticks, accessible descriptions, and recent/milestone table rows. Research only; no orders.

export const IV_HISTORY_HORIZON_LABELS: Readonly<
  Record<OpenbbIvHistoryHorizon, string>
> = {
  63: "3M",
  126: "6M",
  252: "1Y",
  504: "2Y",
};

export const IV_CHART_WIDTH = 1000;
export const IV_CHART_HEIGHT = 240;
const PAD_LEFT = 44;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 30;
const PLOT_LEFT = PAD_LEFT;
const PLOT_RIGHT = IV_CHART_WIDTH - PAD_RIGHT;
const PLOT_TOP = PAD_TOP;
const PLOT_BOTTOM = IV_CHART_HEIGHT - PAD_BOTTOM;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;
const MAX_X_TICKS = 5;
const RECENT_TABLE_ROWS = 10;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export type IvRegimeKind = "high" | "low" | "mid";

export type IvRegime = Readonly<{
  kind: IvRegimeKind;
  label: string;
}>;

export type IvChartDot = Readonly<{
  date: string;
  value: number;
  x: number;
  y: number;
}>;

export type IvChartTick = Readonly<{
  label: string;
  x: number;
}>;

export type IvChartYTicks = Readonly<{
  label: string;
  value: number;
  y: number;
}>;

export type IvRankChartView = Readonly<{
  highBand: Readonly<{ height: number; y: number }>;
  latestPercentileDot: IvChartDot | null;
  latestRankDot: IvChartDot | null;
  lowBand: Readonly<{ height: number; y: number }>;
  midlineY: number;
  partialNotice: string | null;
  percentilePolyline: string;
  plotBottom: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotWidth: number;
  rankIsolatedDots: readonly IvChartDot[];
  rankSegments: readonly string[];
  singlePointNote: string | null;
  xTicks: readonly IvChartTick[];
  yTicks: readonly IvChartYTicks[];
}>;
export type IvHistoryTableRow = Readonly<{
  date: string;
  ivPercentileText: string;
  ivRankText: string;
  ivText: string;
  note: string;
  range52wText: string;
}>;

const roundCoord = (value: number): number => Math.round(value * 10) / 10;

const yForScore = (score: number): number =>
  roundCoord(
    PLOT_BOTTOM - (Math.min(100, Math.max(0, score)) / 100) * PLOT_HEIGHT
  );
const xForIndex = (index: number, count: number): number =>
  count <= 1
    ? roundCoord(PLOT_LEFT + PLOT_WIDTH / 2)
    : roundCoord(PLOT_LEFT + (index / (count - 1)) * PLOT_WIDTH);

/** Classifies a rolling IV point into High (≥ 80), Low (≤ 20), or Mid (20–80) using IVR ?? IVP. */
export const classifyIvRegime = (
  point: Pick<OpenbbIvHistoryPoint, "ivRank" | "ivPercentile">
): IvRegime => {
  const metric = point.ivRank ?? point.ivPercentile;
  if (metric >= 80) return { kind: "high", label: "High IV (≥ 80)" };
  if (metric <= 20) return { kind: "low", label: "Low IV (≤ 20)" };
  return { kind: "mid", label: "Mid range (20–80)" };
};

/** Formats a raw IV observation according to the payload's explicit unit (`decimal` vs `vol_points`). */
export const formatIvValue = (
  value: number,
  unit: OpenbbIvHistoryOutput["unit"]
): string =>
  unit === "decimal" ? formatPercent(value, 1) : formatNumber(value, 1);

/** Formats an IVR/IVP 0..100 score; flat-range null IVR states its reason cleanly. */
export const formatIvScore = (value: number | null): string =>
  value === null ? "Flat range" : value.toFixed(1);

/** Formats a YYYY-MM-DD date without local timezone drift: `MMM DD` for 3M/6M, `MMM YY` for 1Y/2Y. */
export const formatUtcTickDate = (
  isoDate: string,
  horizon: OpenbbIvHistoryHorizon
): string => {
  const parts = isoDate.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const monthName = MONTHS[month - 1];
  if (
    monthName === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31
  ) {
    return isoDate;
  }
  if (horizon === 63 || horizon === 126) {
    return `${monthName} ${String(day).padStart(2, "0")}`;
  }
  return `${monthName} ${String(year % 100).padStart(2, "0")}`;
};

/** Concise badge label for the selected IV basis. */
export const basisBadgeText = (data: OpenbbIvHistoryOutput): string => {
  if (data.basis === "own_atm_iv") return "Own 30d ATM IV";
  if (data.basis === "vol_index_proxy" && data.proxyIndex !== null) {
    return `Proxy: ${data.proxyIndex}`;
  }
  return "No 1y basis";
};

/** Plain-English provenance note for the selected basis (never blends own IV with a vol index). */
export const basisCaveatText = (data: OpenbbIvHistoryOutput): string | null => {
  if (data.basis === "vol_index_proxy" && data.proxyIndex !== null) {
    return `Showing Cboe ${data.proxyIndex} volatility index proxy (vol points) because own 30d ATM IV has ${data.own.sessions} of ${data.own.minSessions} stored sessions. Own ATM IV and index closes are never mixed.`;
  }
  if (data.basis === "own_atm_iv") {
    return "Showing own 30d ATM IV (decimal) from openbb_option_iv_daily over a rolling 252-session window.";
  }
  return null;
};

const buildXTicks = (
  points: readonly OpenbbIvHistoryPoint[],
  horizon: OpenbbIvHistoryHorizon
): IvChartTick[] => {
  const count = points.length;
  if (count === 0) return [];
  if (count === 1) {
    const only = points[0] as OpenbbIvHistoryPoint;
    return [
      {
        label: formatUtcTickDate(only.date, horizon),
        x: xForIndex(0, 1),
      },
    ];
  }
  const tickCount = Math.min(MAX_X_TICKS, count);
  return Array.from({ length: tickCount }, (_, i) => {
    const idx = Math.round((i * (count - 1)) / (tickCount - 1));
    const point = points[idx] as OpenbbIvHistoryPoint;
    return {
      label: formatUtcTickDate(point.date, horizon),
      x: xForIndex(idx, count),
    };
  });
};

const Y_TICK_VALUES = [100, 80, 50, 20, 0] as const;

/** Builds SVG polyline segments, regime bands, ticks, and notices for a ready IV history payload. */
export const buildIvRankChart = (
  data: OpenbbIvHistoryOutput
): IvRankChartView => {
  const { points, requestedSessions } = data;
  const count = points.length;
  const highY = yForScore(100);
  const highBottomY = yForScore(80);
  const lowTopY = yForScore(20);
  const lowBottomY = yForScore(0);

  const percentileCoords: string[] = [];
  const rankSegments: string[] = [];
  const rankIsolatedDots: IvChartDot[] = [];
  let currentSegment: IvChartDot[] = [];

  const flushSegment = () => {
    if (currentSegment.length === 1) {
      rankIsolatedDots.push(currentSegment[0] as IvChartDot);
    } else if (currentSegment.length > 1) {
      rankSegments.push(
        currentSegment.map((pt) => `${pt.x},${pt.y}`).join(" ")
      );
    }
    currentSegment = [];
  };

  let latestRankDot: IvChartDot | null = null;
  let latestPercentileDot: IvChartDot | null = null;

  for (let i = 0; i < count; i += 1) {
    const point = points[i] as OpenbbIvHistoryPoint;
    const x = xForIndex(i, count);
    const pctY = yForScore(point.ivPercentile);
    percentileCoords.push(`${x},${pctY}`);
    if (i === count - 1) {
      latestPercentileDot = {
        date: point.date,
        value: point.ivPercentile,
        x,
        y: pctY,
      };
    }
    if (point.ivRank === null) {
      flushSegment();
    } else {
      const rankDot: IvChartDot = {
        date: point.date,
        value: point.ivRank,
        x,
        y: yForScore(point.ivRank),
      };
      currentSegment.push(rankDot);
      if (i === count - 1) {
        latestRankDot = rankDot;
      }
    }
  }
  flushSegment();

  const partialNotice =
    count > 0 && count < requestedSessions
      ? `Showing ${count} of ${requestedSessions} requested sessions`
      : null;

  return {
    highBand: { height: roundCoord(highBottomY - highY), y: highY },
    latestPercentileDot,
    latestRankDot,
    lowBand: { height: roundCoord(lowBottomY - lowTopY), y: lowTopY },
    midlineY: yForScore(50),
    partialNotice,
    percentilePolyline: count > 1 ? percentileCoords.join(" ") : "",
    plotBottom: PLOT_BOTTOM,
    plotLeft: PLOT_LEFT,
    plotRight: PLOT_RIGHT,
    plotTop: PLOT_TOP,
    plotWidth: PLOT_WIDTH,
    rankIsolatedDots,
    rankSegments,
    singlePointNote: count === 1 ? "1 rolling session available" : null,
    xTicks: buildXTicks(points, requestedSessions),
    yTicks: Y_TICK_VALUES.map((value) => ({
      label: String(value),
      value,
      y: yForScore(value),
    })),
  };
};

/** Builds a descriptive aria-label for the SVG chart summarizing latest standing and regime. */
export const ivHistoryAriaLabel = (data: OpenbbIvHistoryOutput): string => {
  const horizonLabel = IV_HISTORY_HORIZON_LABELS[data.requestedSessions];
  const basisLabel = basisBadgeText(data);
  if (data.latest === null) {
    return `${data.symbol} IV rank and percentile history (${horizonLabel}): not enough history`;
  }
  const regime = classifyIvRegime(data.latest);
  return `${data.symbol} IV rank and percentile history (${horizonLabel}, ${basisLabel}, ${data.points.length} sessions). Latest ${data.latest.date}: IV Rank ${formatIvScore(data.latest.ivRank)}, IV Percentile ${formatIvScore(data.latest.ivPercentile)}, ${regime.label}.`;
};

const addMilestone = (
  tags: Map<string, string[]>,
  date: string,
  label: string
): void => {
  const list = tags.get(date);
  if (list === undefined) {
    tags.set(date, [label]);
  } else {
    list.push(label);
  }
};

const findHorizonMilestones = (points: readonly OpenbbIvHistoryPoint[]) => {
  let highIvp = points[0] as OpenbbIvHistoryPoint;
  let lowIvp = points[0] as OpenbbIvHistoryPoint;
  let highIvr: OpenbbIvHistoryPoint | null = null;
  let lowIvr: OpenbbIvHistoryPoint | null = null;

  for (const point of points) {
    if (point.ivPercentile > highIvp.ivPercentile) highIvp = point;
    if (point.ivPercentile < lowIvp.ivPercentile) lowIvp = point;
    if (point.ivRank === null) continue;
    if (highIvr === null || point.ivRank > (highIvr.ivRank as number)) {
      highIvr = point;
    }
    if (lowIvr === null || point.ivRank < (lowIvr.ivRank as number)) {
      lowIvr = point;
    }
  }

  const tags = new Map<string, string[]>();
  if (highIvr !== null) addMilestone(tags, highIvr.date, "High IVR");
  if (lowIvr !== null) addMilestone(tags, lowIvr.date, "Low IVR");
  addMilestone(tags, highIvp.date, "High IVP");
  addMilestone(tags, lowIvp.date, "Low IVP");

  return { candidates: [highIvr, lowIvr, highIvp, lowIvp], tags };
};

/**
 * Returns the newest up to 10 sessions (newest first) plus any distinct horizon high/low IVR or
 * IVP milestone sessions outside that window, for the accessible detail table.
 */
export const buildIvHistoryTableRows = (
  data: OpenbbIvHistoryOutput
): IvHistoryTableRow[] => {
  const { points, unit } = data;
  if (points.length === 0) return [];

  const { candidates, tags: milestoneTags } = findHorizonMilestones(points);
  const recent = points.slice(-RECENT_TABLE_ROWS).reverse();
  const included = new Set(recent.map((point) => point.date));

  const extraMilestones: OpenbbIvHistoryPoint[] = [];
  for (const candidate of candidates) {
    if (candidate !== null && !included.has(candidate.date)) {
      included.add(candidate.date);
      extraMilestones.push(candidate);
    }
  }
  extraMilestones.sort((a, b) => b.date.localeCompare(a.date));
  return [...recent, ...extraMilestones].map((point) => ({
    date: point.date,
    ivPercentileText: formatIvScore(point.ivPercentile),
    ivRankText: formatIvScore(point.ivRank),
    ivText: formatIvValue(point.iv, unit),
    note: (milestoneTags.get(point.date) ?? []).join(", "),
    range52wText: `${formatIvValue(point.low52w, unit)} – ${formatIvValue(point.high52w, unit)}`,
  }));
};
