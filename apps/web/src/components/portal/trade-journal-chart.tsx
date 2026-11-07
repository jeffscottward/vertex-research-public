// What: cumulative realized P&L line (inline SVG) for the Trade Journal.
// See: trade-journal-model.ts (cumulativeRealized, lineGeometry).
import { cn } from "@darkfactory/ui";

import {
  formatSignedMoney,
  type JournalPoint,
  lineGeometry,
  pnlTextClass,
} from "./trade-journal-model.ts";

const WIDTH = 600;
const HEIGHT = 160;

export const CumulativeRealizedChart = ({
  points,
}: Readonly<{ points: readonly JournalPoint[] }>) => {
  if (points.length === 0)
    return (
      <p className="text-muted-foreground text-sm" data-chart="empty">
        No realized P&L in this execution window yet.
      </p>
    );
  const { path, zeroY } = lineGeometry(points, WIDTH, HEIGHT);
  // Non-empty here, so the last point exists.
  const ending = (points.at(-1) as JournalPoint).value;
  return (
    <figure className="space-y-2" data-chart="cumulative-realized">
      <svg
        aria-label={`Cumulative realized P&L: ${formatSignedMoney(ending)} after ${points.length} closing fill${points.length === 1 ? "" : "s"}`}
        className={cn("h-40 w-full", pnlTextClass(ending))}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        <line
          className="text-muted-foreground"
          data-line="zero"
          stroke="currentColor"
          strokeDasharray="4 4"
          strokeOpacity={0.5}
          vectorEffect="non-scaling-stroke"
          x1={0}
          x2={WIDTH}
          y1={zeroY}
          y2={zeroY}
        />
        <path
          d={path}
          data-line="realized"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="text-muted-foreground text-xs">
        Running total of realized P&L after each closing fill, oldest first.
        Ending at{" "}
        <span className={cn("tabular-nums", pnlTextClass(ending))}>
          {formatSignedMoney(ending)}
        </span>
        .
      </figcaption>
    </figure>
  );
};
