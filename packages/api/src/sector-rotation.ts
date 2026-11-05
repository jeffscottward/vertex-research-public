import type {
  SectorRotationLatest,
  SectorRotationParams,
  SectorRotationPoint,
  SectorRotationQuadrant,
  SectorRotationTimeframe,
} from "./contracts/sector-rotation.ts";

// Sector rotation math (pure; no network, no orders). Our own documented formula, not the
// proprietary JdK RS-Ratio / RS-Momentum algorithm:
//
//   rs_t       = 100 × close_t ÷ benchmarkClose_t                 (dates where both closed)
//   smooth_t   = EMA(rs, rsSmoothing)_t                           (EMA seeded with the first value)
//   ratio_t    = 100 × smooth_t ÷ SMA(smooth, trendWindow)_t      (above 100 = stronger than its trend)
//   roc_t      = 100 × ratio_t ÷ ratio_{t − momentumLag}          (rate of change of the ratio)
//   momentum_t = EMA(roc, momentumSmoothing)_t                    (above 100 = ratio rising)
//
// The first `warmupPeriods(params)` aligned periods are dropped so EMA seeding and the trend
// window do not bias the output. Weekly series use the last close of each ISO week (Monday
// start); the current, partial week uses its latest close.
//
// Quadrants: ratio ≥ 100 and momentum ≥ 100 → leading; ratio ≥ 100 and momentum < 100 →
// weakening; ratio < 100 and momentum < 100 → lagging; ratio < 100 and momentum ≥ 100 → improving.

export type ClosePoint = Readonly<{ date: string; close: number }>;

export const SECTOR_ROTATION_PARAMS: Readonly<
  Record<SectorRotationTimeframe, SectorRotationParams>
> = {
  daily: {
    momentumLag: 10,
    momentumSmoothing: 5,
    rsSmoothing: 10,
    trendWindow: 50,
  },
  weekly: {
    momentumLag: 4,
    momentumSmoothing: 3,
    rsSmoothing: 4,
    trendWindow: 26,
  },
};

/** Aligned periods dropped before the first output point. */
export const warmupPeriods = (params: SectorRotationParams): number =>
  params.rsSmoothing +
  params.trendWindow +
  params.momentumLag +
  params.momentumSmoothing;

export const quadrantOf = (
  ratio: number,
  momentum: number
): SectorRotationQuadrant => {
  if (ratio >= 100) return momentum >= 100 ? "leading" : "weakening";
  return momentum >= 100 ? "improving" : "lagging";
};

/** Exponential moving average, alpha = 2 ÷ (span + 1), seeded with the first value. */
export const ema = (values: readonly number[], span: number): number[] => {
  const alpha = 2 / (span + 1);
  const out: number[] = [];
  let previous: number | undefined;
  for (const value of values) {
    previous =
      previous === undefined ? value : alpha * value + (1 - alpha) * previous;
    out.push(previous);
  }
  return out;
};

/** Trailing simple moving average; null until `window` values exist. */
export const sma = (
  values: readonly number[],
  window: number
): (number | null)[] => {
  const out: (number | null)[] = [];
  let sum = 0;
  values.forEach((value, index) => {
    sum += value;
    if (index >= window) sum -= values[index - window] as number;
    out.push(index >= window - 1 ? sum / window : null);
  });
  return out;
};

const isUsable = (point: ClosePoint): boolean =>
  Number.isFinite(point.close) && point.close > 0;

/** Monday (UTC) of the ISO week that holds `date` (YYYY-MM-DD). */
export const isoWeekStart = (date: string): string => {
  const day = new Date(`${date}T00:00:00Z`);
  const offset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  return day.toISOString().slice(0, 10);
};

/** Last close of each ISO week, dated on that close. Input must be sorted by date. */
export const toWeekly = (closes: readonly ClosePoint[]): ClosePoint[] => {
  const out: ClosePoint[] = [];
  let week: string | undefined;
  for (const point of closes) {
    const start = isoWeekStart(point.date);
    if (start === week) out[out.length - 1] = point;
    else out.push(point);
    week = start;
  }
  return out;
};

/**
 * True when the ISO week of `date` has ended as of `asOf`: `asOf` is in a later week, or `asOf` is
 * a Friday. Stored weekly points must be final, so the current, partial week is never stored.
 */
export const isWeekComplete = (date: string, asOf: string): boolean =>
  isoWeekStart(date) < isoWeekStart(asOf) ||
  new Date(`${asOf}T00:00:00Z`).getUTCDay() === 5;

/** Dates where both series have a usable close, sorted, as `{ date, rs }`. */
export const alignRelativeStrength = (
  closes: readonly ClosePoint[],
  benchmark: readonly ClosePoint[]
): { date: string; rs: number }[] => {
  const base = new Map<string, number>();
  for (const point of benchmark)
    if (isUsable(point)) base.set(point.date, point.close);
  const out: { date: string; rs: number }[] = [];
  for (const point of closes) {
    const reference = base.get(point.date);
    if (reference !== undefined && isUsable(point))
      out.push({ date: point.date, rs: (100 * point.close) / reference });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
};

/** Ratio and momentum per aligned period after the warm-up. Inputs must be sorted by date. */
export const computeRotationPoints = (
  closes: readonly ClosePoint[],
  benchmark: readonly ClosePoint[],
  params: SectorRotationParams
): SectorRotationPoint[] => {
  const aligned = alignRelativeStrength(closes, benchmark);
  const smooth = ema(
    aligned.map((point) => point.rs),
    params.rsSmoothing
  );
  const trend = sma(smooth, params.trendWindow);
  const ratios = smooth.map((value, index) => {
    const reference = trend[index];
    return reference === null || reference === undefined
      ? null
      : (100 * value) / reference;
  });
  const firstRoc = params.trendWindow - 1 + params.momentumLag;
  const rocs: number[] = [];
  for (let index = firstRoc; index < ratios.length; index += 1)
    rocs.push(
      (100 * (ratios[index] as number)) /
        (ratios[index - params.momentumLag] as number)
    );
  const momentum = ema(rocs, params.momentumSmoothing);
  const warmup = warmupPeriods(params);
  const out: SectorRotationPoint[] = [];
  aligned.forEach((point, index) => {
    if (index < warmup) return;
    // After the warm-up both the ratio and the smoothed rate of change exist.
    const ratio = ratios[index] as number;
    const value = momentum[index - firstRoc] as number;
    out.push({
      date: point.date,
      momentum: value,
      quadrant: quadrantOf(ratio, value),
      ratio,
    });
  });
  return out;
};

/** Daily or weekly points, trimmed to dates on or after `fromDate`. */
export const computeTimeframePoints = (
  closes: readonly ClosePoint[],
  benchmark: readonly ClosePoint[],
  timeframe: SectorRotationTimeframe,
  fromDate: string
): SectorRotationPoint[] => {
  const params = SECTOR_ROTATION_PARAMS[timeframe];
  const points =
    timeframe === "weekly"
      ? computeRotationPoints(toWeekly(closes), toWeekly(benchmark), params)
      : computeRotationPoints(closes, benchmark, params);
  return points.filter((point) => point.date >= fromDate);
};

/** The newest point with its current quadrant streak; null for an empty series. */
export const latestOf = (
  points: readonly SectorRotationPoint[]
): SectorRotationLatest | null => {
  const last = points.at(-1);
  if (last === undefined) return null;
  let since = last.date;
  let periods = 1;
  for (const point of points.slice(0, -1).reverse()) {
    if (point.quadrant !== last.quadrant) break;
    since = point.date;
    periods += 1;
  }
  return { ...last, periods, since };
};

export type QuadrantChange = Readonly<{
  date: string;
  from: SectorRotationQuadrant;
  to: SectorRotationQuadrant;
}>;

/** Every quadrant change in date order. */
export const quadrantChanges = (
  points: readonly SectorRotationPoint[]
): QuadrantChange[] => {
  const out: QuadrantChange[] = [];
  let previous: SectorRotationPoint | undefined;
  for (const point of points) {
    if (previous !== undefined && previous.quadrant !== point.quadrant)
      out.push({
        date: point.date,
        from: previous.quadrant,
        to: point.quadrant,
      });
    previous = point;
  }
  return out;
};

/** Calendar date `days` before `date` (YYYY-MM-DD). */
export const daysBefore = (date: string, days: number): string => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
};
