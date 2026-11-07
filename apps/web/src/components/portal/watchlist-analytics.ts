// What: pure math for the watchlist analysis tabs: daily closes and returns, Pearson correlation
// matrix, total return and max drawdown, the exposure sunburst (arcs and SVG paths), scatter
// scales and a bounded-concurrency runner for the per-symbol bars requests.
// Used by: watchlist-bars.tsx, watchlist-relationships.tsx, watchlist-exposure.tsx.

/** At most this many watchlist symbols get daily bars (one IBKR request each). */
export const WATCHLIST_ANALYSIS_SYMBOL_CAP = 12;
/** A correlation needs at least this many shared daily returns. */
export const MIN_CORRELATION_OVERLAP = 20;

const SECONDS_PER_DAY = 86_400;
const FULL_TURN = Math.PI * 2;

export type DailyClose = Readonly<{ day: number; close: number }>;
export type DailyReturn = Readonly<{ day: number; value: number }>;
type BarLike = Readonly<{ t: number; c: number }>;

/** Same symbol form for watchlist rows and positions: trimmed, upper case, BF-B as BF.B. */
export const normalizeSymbol = (symbol: string): string =>
  symbol.trim().toUpperCase().replaceAll("-", ".");

/** First `cap` distinct symbols, in list order. */
export const capSymbols = (
  symbols: readonly string[],
  cap = WATCHLIST_ANALYSIS_SYMBOL_CAP
): string[] => [...new Set(symbols)].slice(0, cap);

/**
 * One close per UTC day (bar time in epoch seconds), oldest first. A later bar of the same day
 * wins; closes that are not positive finite numbers are dropped.
 */
export const dailyCloses = (bars: readonly BarLike[]): DailyClose[] => {
  const byDay = new Map<number, number>();
  for (const bar of bars) {
    if (!(Number.isFinite(bar.c) && bar.c > 0 && Number.isFinite(bar.t)))
      continue;
    byDay.set(Math.floor(bar.t / SECONDS_PER_DAY), bar.c);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, close]) => ({ close, day }));
};

/** Close-to-close simple returns, dated by the later close. */
export const dailyReturns = (closes: readonly DailyClose[]): DailyReturn[] => {
  const returns: DailyReturn[] = [];
  let previous: DailyClose | undefined;
  for (const point of closes) {
    if (previous !== undefined)
      returns.push({ day: point.day, value: point.close / previous.close - 1 });
    previous = point;
  }
  return returns;
};

/** Pearson correlation of two equal-length samples; null below 2 points or with no variance. */
export const pearson = (
  xs: readonly number[],
  ys: readonly number[]
): number | null => {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i] as number;
    sumY += ys[i] as number;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - meanX;
    const dy = (ys[i] as number) - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
};

export type CorrelationCell = Readonly<{
  row: string;
  column: string;
  /** Null when the pair shares fewer than the minimum days or a series is flat. */
  value: number | null;
  /** Days on which both symbols have a return. */
  overlap: number;
}>;

export type ReturnSeries = Readonly<{
  symbol: string;
  returns: readonly DailyReturn[];
}>;

const correlate = (
  a: ReturnSeries,
  b: ReturnSeries,
  minOverlap: number
): CorrelationCell => {
  const other = new Map(b.returns.map((point) => [point.day, point.value]));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const point of a.returns) {
    const match = other.get(point.day);
    if (match === undefined) continue;
    xs.push(point.value);
    ys.push(match);
  }
  return {
    column: b.symbol,
    overlap: xs.length,
    row: a.symbol,
    value: xs.length >= minOverlap ? pearson(xs, ys) : null,
  };
};

export type CorrelationRow = Readonly<{
  symbol: string;
  cells: readonly CorrelationCell[];
}>;

/** Square matrix of pairwise correlations over the days both symbols traded. */
export const correlationMatrix = (
  series: readonly ReturnSeries[],
  minOverlap = MIN_CORRELATION_OVERLAP
): CorrelationRow[] =>
  series.map((row) => ({
    cells: series.map((column) => correlate(row, column, minOverlap)),
    symbol: row.symbol,
  }));

/** Last close over first close minus one; null with fewer than two closes. */
export const totalReturn = (closes: readonly DailyClose[]): number | null => {
  if (closes.length < 2) return null;
  const first = closes[0] as DailyClose;
  const last = closes.at(-1) as DailyClose;
  return last.close / first.close - 1;
};

/** Deepest peak-to-trough fall as a fraction (0 or negative); null with fewer than two closes. */
export const maxDrawdown = (closes: readonly DailyClose[]): number | null => {
  if (closes.length < 2) return null;
  let peak = 0;
  let worst = 0;
  for (const point of closes) {
    peak = Math.max(peak, point.close);
    worst = Math.min(worst, point.close / peak - 1);
  }
  return worst;
};

/** "+12.3%" style text for a fraction; "—" for null. */
export const formatPercent = (value: number | null, digits = 1): string => {
  if (value === null) return "—";
  const text = (value * 100).toFixed(digits);
  return value > 0 && Number(text) !== 0 ? `+${text}%` : `${text}%`;
};

/** Diverging heatmap fill: blue for positive, red for negative, stronger with |r|. */
export const correlationFill = (value: number | null): string => {
  if (value === null) return "transparent";
  const strength = Math.round(Math.abs(value) * 70);
  const token = value >= 0 ? "--color-info" : "--color-destructive";
  return `color-mix(in oklab, var(${token}) ${strength}%, transparent)`;
};

export type ExposurePosition = Readonly<{
  secType: string;
  symbol: string;
  marketValue: number | null;
}>;

export type SunburstArc = Readonly<{
  key: string;
  ring: "secType" | "symbol";
  label: string;
  secType: string;
  /** Gross (absolute) market value of the arc. */
  value: number;
  /** Share of the gross total, 0..1. */
  share: number;
  /** Angles in radians, clockwise from 12 o'clock. */
  start: number;
  end: number;
  /** Symbol ring: the symbol is on the watchlist. Type ring: any of its symbols is. */
  onWatchlist: boolean;
  /** Net market value below zero (a short position). */
  short: boolean;
}>;

export type Sunburst = Readonly<{
  /** Gross market value of every counted position. */
  total: number;
  arcs: readonly SunburstArc[];
  /** Positions left out because they have no (or a zero) market value. */
  skipped: number;
}>;

interface Bucket {
  gross: number;
  net: number;
}
interface TypeGroup {
  gross: number;
  symbols: Map<string, Bucket>;
}

const byGrossThenName = <T extends Readonly<{ gross: number }>>(
  [nameA, a]: readonly [string, T],
  [nameB, b]: readonly [string, T]
): number => b.gross - a.gross || nameA.localeCompare(nameB);

/**
 * Inner ring: security type; outer ring: symbol within it. Sizes use gross (absolute) market
 * value, so shorts take room too. Several rows of one symbol and type (e.g. options) are summed.
 */
export const buildSunburst = (
  positions: readonly ExposurePosition[],
  watchlist: ReadonlySet<string>
): Sunburst => {
  const groups = new Map<string, TypeGroup>();
  let skipped = 0;
  for (const position of positions) {
    const value = position.marketValue;
    if (value === null || !Number.isFinite(value) || value === 0) {
      skipped += 1;
      continue;
    }
    const secType = position.secType.trim().toUpperCase() || "OTHER";
    const symbol = normalizeSymbol(position.symbol) || "—";
    const group = groups.get(secType) ?? { gross: 0, symbols: new Map() };
    groups.set(secType, group);
    const bucket = group.symbols.get(symbol) ?? { gross: 0, net: 0 };
    group.symbols.set(symbol, bucket);
    bucket.gross += Math.abs(value);
    bucket.net += value;
    group.gross += Math.abs(value);
  }
  const total = [...groups.values()].reduce((sum, g) => sum + g.gross, 0);
  const arcs: SunburstArc[] = [];
  let angle = 0;
  for (const [secType, group] of [...groups.entries()].sort(byGrossThenName)) {
    const groupStart = angle;
    let onWatchlist = false;
    let net = 0;
    for (const [symbol, bucket] of [...group.symbols.entries()].sort(
      byGrossThenName
    )) {
      const start = angle;
      angle += (bucket.gross / total) * FULL_TURN;
      const listed = watchlist.has(symbol);
      onWatchlist ||= listed;
      net += bucket.net;
      arcs.push({
        end: angle,
        key: `${secType}/${symbol}`,
        label: symbol,
        onWatchlist: listed,
        ring: "symbol",
        secType,
        share: bucket.gross / total,
        short: bucket.net < 0,
        start,
        value: bucket.gross,
      });
    }
    arcs.push({
      end: angle,
      key: secType,
      label: secType,
      onWatchlist,
      ring: "secType",
      secType,
      share: group.gross / total,
      short: net < 0,
      start: groupStart,
      value: group.gross,
    });
  }
  return { arcs, skipped, total };
};

const coordinate = (value: number): string => String(Number(value.toFixed(2)));

const polar = (cx: number, cy: number, radius: number, angle: number) =>
  `${coordinate(cx + radius * Math.sin(angle))} ${coordinate(cy - radius * Math.cos(angle))}`;

/**
 * SVG path of an annular sector between two radii and two angles (radians, clockwise from
 * 12 o'clock). A whole turn is drawn as two halves, since one SVG arc cannot close on itself.
 */
export const annularSectorPath = (
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  start: number,
  end: number
): string => {
  const span = end - start;
  if (span >= FULL_TURN - 1e-9) {
    const middle = start + Math.PI;
    return `${annularSectorPath(cx, cy, inner, outer, start, middle)} ${annularSectorPath(cx, cy, inner, outer, middle, start + FULL_TURN)}`;
  }
  const large = span > Math.PI ? 1 : 0;
  return [
    `M ${polar(cx, cy, outer, start)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${polar(cx, cy, outer, end)}`,
    `L ${polar(cx, cy, inner, end)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${polar(cx, cy, inner, start)}`,
    "Z",
  ].join(" ");
};

/** [min, max] of the values and zero, so the zero line is always on the chart. */
export const extentWithZero = (
  values: readonly number[]
): readonly [number, number] => [
  Math.min(0, ...values),
  Math.max(0, ...values),
];

/** Linear map of [d0, d1] onto [r0, r1]; an empty domain maps to the middle of the range. */
export const linearScale =
  (d0: number, d1: number, r0: number, r1: number) =>
  (value: number): number =>
    d1 === d0 ? (r0 + r1) / 2 : r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);

/** Runs `task` over `items` with at most `limit` in flight; resolves when all are done. */
export const runWithConcurrency = async <T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> => {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await task(item);
    }
  };
  const workers = Math.min(Math.max(1, Math.floor(limit)), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
};
