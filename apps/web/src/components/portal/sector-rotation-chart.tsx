import type {
  SectorRotationPoint,
  SectorRotationQuadrant,
  SectorRotationSeries,
  SectorRotationTimeframe,
} from "@darkfactory/api";

// Sector rotation map: x = relative strength ratio, y = momentum, both centered on 100. Each
// series draws a tail (its last points up to the chosen date) and a head with its ticker.

export const CHART_SIZE = 600;
const PAD = 40;
const PLOT = CHART_SIZE - PAD * 2;
/** Smallest distance from 100 to the edge, so a flat map still has a visible scale. */
const MIN_HALF_SPAN = 0.5;
/** Share of each axis range added on both sides. */
const DOMAIN_PAD = 0.06;

export const QUADRANT_LABELS: Readonly<Record<SectorRotationQuadrant, string>> =
  {
    improving: "Improving",
    lagging: "Lagging",
    leading: "Leading",
    weakening: "Weakening",
  };

// Status tokens give one tint per quadrant in every theme; the text label always names it.
const QUADRANT_FILL: Readonly<Record<SectorRotationQuadrant, string>> = {
  improving: "fill-info-subtle",
  lagging: "fill-destructive-subtle",
  leading: "fill-success-subtle",
  weakening: "fill-warning-subtle",
};

export const QUADRANT_CHIP: Readonly<Record<SectorRotationQuadrant, string>> = {
  improving: "bg-info",
  lagging: "bg-destructive",
  leading: "bg-success",
  weakening: "bg-warning",
};

// Full class names so Tailwind finds them; the five chart colors repeat.
const SERIES_COLORS = [
  { fill: "fill-chart-1", stroke: "stroke-chart-1" },
  { fill: "fill-chart-2", stroke: "stroke-chart-2" },
  { fill: "fill-chart-3", stroke: "stroke-chart-3" },
  { fill: "fill-chart-4", stroke: "stroke-chart-4" },
  { fill: "fill-chart-5", stroke: "stroke-chart-5" },
] as const;

export type SeriesColor = (typeof SERIES_COLORS)[number];

/** Chart color classes of the series at this position. */
export const seriesColor = (index: number): SeriesColor =>
  SERIES_COLORS[index % SERIES_COLORS.length] ?? SERIES_COLORS[0];

export type ChartDomain = Readonly<{
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}>;

/**
 * Axis ranges that hold 100 and every point, with a small pad. The ranges follow the data on each
 * side of 100, so a map whose points sit mostly on one side still uses the plot area.
 */
export const chartDomain = (
  points: readonly Pick<SectorRotationPoint, "momentum" | "ratio">[]
): ChartDomain => {
  let xMin = 100 - MIN_HALF_SPAN;
  let xMax = 100 + MIN_HALF_SPAN;
  let yMin = 100 - MIN_HALF_SPAN;
  let yMax = 100 + MIN_HALF_SPAN;
  for (const point of points) {
    xMin = Math.min(xMin, point.ratio);
    xMax = Math.max(xMax, point.ratio);
    yMin = Math.min(yMin, point.momentum);
    yMax = Math.max(yMax, point.momentum);
  }
  const xPad = (xMax - xMin) * DOMAIN_PAD;
  const yPad = (yMax - yMin) * DOMAIN_PAD;
  return {
    xMax: xMax + xPad,
    xMin: xMin - xPad,
    yMax: yMax + yPad,
    yMin: yMin - yPad,
  };
};

/** SVG position of a ratio and momentum pair (y grows downward in SVG). */
export const projectPoint = (
  point: Pick<SectorRotationPoint, "momentum" | "ratio">,
  domain: ChartDomain
): Position => ({
  x: PAD + ((point.ratio - domain.xMin) / (domain.xMax - domain.xMin)) * PLOT,
  y:
    PAD +
    (1 - (point.momentum - domain.yMin) / (domain.yMax - domain.yMin)) * PLOT,
});

/** The last `length` points on or before `date` (all dates when `date` is null). */
export const tailPoints = <T extends Pick<SectorRotationPoint, "date">>(
  points: readonly T[],
  date: string | null,
  length: number
): readonly T[] => {
  const upTo =
    date === null ? points : points.filter((point) => point.date <= date);
  return upTo.slice(Math.max(0, upTo.length - length));
};

type Position = Readonly<{ x: number; y: number }>;

/** Consecutive pairs of tail positions, oldest first. */
export const tailSegments = (
  positions: readonly Position[]
): readonly Readonly<{ from: Position; to: Position }>[] => {
  const segments: Readonly<{ from: Position; to: Position }>[] = [];
  let previous: Position | undefined;
  for (const position of positions) {
    if (previous !== undefined) segments.push({ from: previous, to: position });
    previous = position;
  }
  return segments;
};

/** Older tail segments fade: the newest segment is opaque, the oldest near 0.2. */
export const segmentOpacity = (index: number, count: number): number =>
  0.2 + (0.8 * (index + 1)) / count;

export type ChartHighlight = string | null;

export interface SectorRotationChartProps {
  readonly benchmark: string;
  readonly date: string | null;
  readonly highlighted: ChartHighlight;
  readonly onHighlight: (symbol: ChartHighlight) => void;
  readonly series: readonly SectorRotationSeries[];
  readonly tailLength: number;
  readonly timeframe: SectorRotationTimeframe;
}

const QUADRANT_CORNERS: readonly Readonly<{
  quadrant: SectorRotationQuadrant;
  right: boolean;
  top: boolean;
}>[] = [
  { quadrant: "leading", right: true, top: true },
  { quadrant: "weakening", right: true, top: false },
  { quadrant: "lagging", right: false, top: false },
  { quadrant: "improving", right: false, top: true },
];

const formatValue = (value: number): string => value.toFixed(2);

export const SectorRotationChart = ({
  benchmark,
  date,
  highlighted,
  onHighlight,
  series,
  tailLength,
  timeframe,
}: SectorRotationChartProps) => {
  const domain = chartDomain(series.flatMap((entry) => entry.points));
  const center = projectPoint({ momentum: 100, ratio: 100 }, domain);
  const drawn = series.flatMap((entry, index) => {
    const tail = tailPoints(entry.points, date, tailLength);
    const head = tail.at(-1);
    return head === undefined
      ? []
      : [
          {
            color: seriesColor(index),
            entry,
            head,
            headPosition: projectPoint(head, domain),
            segments: tailSegments(
              tail.map((point) => projectPoint(point, domain))
            ),
          },
        ];
  });
  const active = drawn.find((item) => item.entry.symbol === highlighted);
  const unit = timeframe === "daily" ? "days" : "weeks";
  const summary = drawn
    .map(
      (item) =>
        `${item.entry.symbol} ${QUADRANT_LABELS[item.head.quadrant].toLowerCase()}`
    )
    .join(", ");
  return (
    <figure className="space-y-2">
      <div className="relative">
        <svg
          aria-label={`Sector rotation map against ${benchmark}, ${date ?? "latest"}: ${summary === "" ? "no points" : summary}.`}
          className="aspect-square h-auto w-full"
          role="img"
          viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`}
        >
          {QUADRANT_CORNERS.map(({ quadrant, right, top }) => (
            <g key={quadrant}>
              <rect
                className={QUADRANT_FILL[quadrant]}
                height={top ? center.y - PAD : PAD + PLOT - center.y}
                width={right ? PAD + PLOT - center.x : center.x - PAD}
                x={right ? center.x : PAD}
                y={top ? PAD : center.y}
              />
              <text
                className="fill-muted-foreground font-medium"
                fontSize={15}
                textAnchor={right ? "end" : "start"}
                x={right ? PAD + PLOT - 8 : PAD + 8}
                y={top ? PAD + 20 : PAD + PLOT - 10}
              >
                {QUADRANT_LABELS[quadrant]}
              </text>
            </g>
          ))}
          <line
            className="stroke-border-strong"
            strokeDasharray="4 4"
            x1={center.x}
            x2={center.x}
            y1={PAD}
            y2={PAD + PLOT}
          />
          <line
            className="stroke-border-strong"
            strokeDasharray="4 4"
            x1={PAD}
            x2={PAD + PLOT}
            y1={center.y}
            y2={center.y}
          />
          <g className="fill-muted-foreground" fontSize={13}>
            <text x={PAD} y={PAD + PLOT + 18}>
              {formatValue(domain.xMin)}
            </text>
            <text textAnchor="middle" x={center.x} y={PAD + PLOT + 18}>
              Ratio
            </text>
            <text textAnchor="end" x={PAD + PLOT} y={PAD + PLOT + 18}>
              {formatValue(domain.xMax)}
            </text>
            <text x={PAD} y={PAD - 10}>
              Momentum {formatValue(domain.yMax)}
            </text>
            <text x={PAD} y={PAD + PLOT + 34}>
              Momentum {formatValue(domain.yMin)}
            </text>
          </g>
          {drawn.map(({ color, entry, head, headPosition, segments }) => {
            const dimmed = highlighted !== null && highlighted !== entry.symbol;
            const strong = entry.symbol === highlighted;
            return (
              <g
                data-series={entry.symbol}
                key={entry.symbol}
                opacity={dimmed ? 0.25 : 1}
              >
                {segments.map(({ from, to }, index) => (
                  <line
                    className={color.stroke}
                    key={`${entry.symbol}-${index}`}
                    opacity={segmentOpacity(index, segments.length)}
                    strokeLinecap="round"
                    strokeWidth={strong ? 3.5 : 2}
                    x1={from.x}
                    x2={to.x}
                    y1={from.y}
                    y2={to.y}
                  />
                ))}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only hover; keyboard users highlight a series from its table row button. */}
                <circle
                  className={`${color.fill} stroke-background`}
                  cx={headPosition.x}
                  cy={headPosition.y}
                  data-head={entry.symbol}
                  onMouseEnter={() => onHighlight(entry.symbol)}
                  onMouseLeave={() => onHighlight(null)}
                  r={strong ? 9 : 7}
                  strokeWidth={2}
                >
                  <title>{`${entry.symbol} ${QUADRANT_LABELS[head.quadrant]} ${head.date}`}</title>
                </circle>
                <text
                  className="pointer-events-none fill-foreground font-semibold"
                  fontSize={14}
                  x={headPosition.x + 10}
                  y={headPosition.y - 10}
                >
                  {entry.symbol}
                </text>
              </g>
            );
          })}
        </svg>
        {active === undefined ? null : (
          <div
            className="pointer-events-none absolute z-10 max-w-56 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover px-2 py-1 text-popover-foreground text-xs shadow-sm"
            data-tooltip={active.entry.symbol}
            style={{
              left: `${(active.headPosition.x / CHART_SIZE) * 100}%`,
              top: `calc(${(active.headPosition.y / CHART_SIZE) * 100}% - 12px)`,
            }}
          >
            <p className="font-semibold">
              {active.entry.symbol}
              {active.entry.name === null ? "" : ` · ${active.entry.name}`}
            </p>
            <p>
              {QUADRANT_LABELS[active.head.quadrant]} · ratio{" "}
              {formatValue(active.head.ratio)} · momentum{" "}
              {formatValue(active.head.momentum)}
            </p>
            <p className="text-muted-foreground">{active.head.date}</p>
          </div>
        )}
      </div>
      <figcaption className="text-muted-foreground text-xs">
        Ratio (x) and momentum (y) of each symbol against {benchmark}, both
        centered on 100. Tails show up to {tailLength} {unit} to{" "}
        {date ?? "the latest date"}; older steps are lighter.
      </figcaption>
    </figure>
  );
};
