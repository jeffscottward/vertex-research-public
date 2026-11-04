import type { BasketValuationOutput } from "@darkfactory/api";

type Point = BasketValuationOutput["points"][number];

const WIDTH = 640;
const HEIGHT = 240;
const PAD = 8;

// Builds SVG path data; a null value ends the current segment so stale dates show as gaps.
export const linePath = (
  values: readonly (number | null)[],
  min: number,
  max: number
): string => {
  const span = max - min || 1;
  const step = values.length > 1 ? (WIDTH - PAD * 2) / (values.length - 1) : 0;
  let path = "";
  let open = false;
  for (const [index, value] of values.entries()) {
    if (value === null) {
      open = false;
      continue;
    }
    const x = PAD + index * step;
    const y = PAD + (1 - (value - min) / span) * (HEIGHT - PAD * 2);
    path += `${open ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
    open = true;
  }
  return path.trim();
};

export const BasketChart = ({
  points,
  symbol,
  benchmarkSymbol,
}: {
  readonly points: readonly Point[];
  readonly symbol: string;
  readonly benchmarkSymbol: string;
}) => {
  const values = points.flatMap((point) =>
    [point.value, point.benchmark].filter((value) => value !== null)
  );
  if (values.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No index history yet. Daily closes are not available for every member.
      </p>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  // values is non-empty, so points has at least one entry.
  const first = (points[0] as Point).date;
  const last = (points.at(-1) as Point).date;
  return (
    <figure className="space-y-2">
      <svg
        aria-label={`${symbol} index versus ${benchmarkSymbol}, ${first} to ${last}`}
        className="h-60 w-full"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        <path
          className="stroke-muted-foreground"
          d={linePath(
            points.map((point) => point.benchmark),
            min,
            max
          )}
          fill="none"
          strokeDasharray="4 3"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
        <path
          className="stroke-primary"
          d={linePath(
            points.map((point) => point.value),
            min,
            max
          )}
          fill="none"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="flex flex-wrap justify-between gap-2 text-muted-foreground text-xs">
        <span>
          <span className="font-medium text-primary">— {symbol}</span>
          {"  "}
          <span>- - {benchmarkSymbol} (same base)</span>
        </span>
        <span className="font-mono">
          {first} → {last} · range {min.toFixed(1)}–{max.toFixed(1)}
        </span>
      </figcaption>
    </figure>
  );
};
