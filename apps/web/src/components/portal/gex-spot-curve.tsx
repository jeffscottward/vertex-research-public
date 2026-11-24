"use client";

import type { GexProfilePoint } from "@darkfactory/api";
import { useId } from "react";

// O10: GEX vs hypothetical spot curve with the zero-gamma crossing.
// Renders the +/-30% spot sweep (121 points) already computed by gex-context.ts,
// with a zero line, a spot marker, a zero-gamma (flip) marker, a visually hidden
// table of the same values, and a no-data state naming why. Research view only.

const WIDTH = 640;
const HEIGHT = 240;
const PAD_LEFT = 82;
const PAD_RIGHT = 18;
const PAD_TOP = 26;
const PAD_BOTTOM = 30;
const PLOT_LEFT = PAD_LEFT;
const PLOT_RIGHT = WIDTH - PAD_RIGHT;
const PLOT_TOP = PAD_TOP;
const PLOT_BOTTOM = HEIGHT - PAD_BOTTOM;
const PLOT_W = PLOT_RIGHT - PLOT_LEFT;
const PLOT_H = PLOT_BOTTOM - PLOT_TOP;
const LABEL_MARGIN = 52;
const MIN_TICK_GAP = 14;
const X_TICK_RATIOS = [0, 0.25, 0.5, 0.75, 1] as const;

export interface GexSpotCurveProps {
  readonly flip: number | null;
  readonly noDataReason?: string;
  readonly profile: readonly GexProfilePoint[];
  readonly spot: number | null;
}

const formatSpot = (value: number): string => `$${value.toFixed(2)}`;

const formatMoney = (value: number): string => {
  const abs = Math.abs(value);
  if (abs < 0.5) return "$0";
  const prefix = value < 0 ? "-$" : "$";
  if (abs >= 1e9) return `${prefix}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${prefix}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${prefix}${(abs / 1e3).toFixed(1)}K`;
  return `${prefix}${abs.toFixed(0)}`;
};

const clampLabelX = (x: number): number =>
  Math.min(Math.max(x, PLOT_LEFT + LABEL_MARGIN), PLOT_RIGHT - LABEL_MARGIN);

const interpolateGex = (
  profile: readonly GexProfilePoint[],
  target: number
): number => {
  const first = profile[0] as GexProfilePoint;
  let previous = first;
  let value = first.gex;
  for (const point of profile.slice(1)) {
    if (target >= previous.spot && target <= point.spot) {
      const span = point.spot - previous.spot;
      value =
        span > 0
          ? previous.gex +
            ((point.gex - previous.gex) * (target - previous.spot)) / span
          : previous.gex;
    }
    previous = point;
  }
  return value;
};

const defaultNoDataReason = (
  spot: number | null,
  pointCount: number
): string => {
  if (spot === null || spot <= 0)
    return "Not computed: no spot price was received from QuantData.";
  if (pointCount === 1)
    return "Not computed: at least two hypothetical spot points are required to draw the curve.";
  return "Not computed: GEX spot sweep needs a spot price, strike open interest and front ATM IV.";
};

const EmptyCurve = ({
  headingId,
  reason,
}: Readonly<{ headingId: string; reason: string }>) => (
  <section
    aria-labelledby={headingId}
    className="space-y-1.5 rounded-md border border-border bg-muted/20 p-3"
    data-gex-spot-curve=""
    data-gex-spot-curve-state="empty"
  >
    <h4 className="font-medium text-xs" id={headingId}>
      GEX vs hypothetical spot
    </h4>
    <p className="text-muted-foreground text-xs" role="status">
      {reason}
    </p>
  </section>
);

export const GexSpotCurve = ({
  profile,
  spot,
  flip,
  noDataReason,
}: GexSpotCurveProps) => {
  const id = useId();
  const headingId = `${id}-heading`;

  if (profile.length < 2) {
    return (
      <EmptyCurve
        headingId={headingId}
        reason={
          profile.length === 1
            ? defaultNoDataReason(spot, 1)
            : (noDataReason ?? defaultNoDataReason(spot, 0))
        }
      />
    );
  }

  const first = profile[0] as GexProfilePoint;
  const last = profile.at(-1) as GexProfilePoint;
  if (last.spot <= first.spot) {
    return (
      <EmptyCurve
        headingId={headingId}
        reason="Not computed: hypothetical spot sweep has zero price width."
      />
    );
  }

  const minSpot = first.spot;
  const maxSpot = last.spot;
  const spotSpan = maxSpot - minSpot;
  const gexValues = profile.map((point) => point.gex);
  const rawMin = Math.min(0, ...gexValues);
  const rawMax = Math.max(0, ...gexValues);
  const maxAbs = Math.max(Math.abs(rawMin), Math.abs(rawMax));
  const pad = maxAbs === 0 ? 1 : maxAbs * 0.08;
  const yMin = rawMin - pad;
  const yMax = rawMax + pad;
  const ySpan = yMax - yMin;

  const xOf = (price: number): number =>
    PLOT_LEFT + ((price - minSpot) / spotSpan) * PLOT_W;
  const yOf = (gex: number): number =>
    PLOT_TOP + (1 - (gex - yMin) / ySpan) * PLOT_H;

  const zeroY = yOf(0);
  const linePath = profile
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${xOf(point.spot).toFixed(1)},${yOf(point.gex).toFixed(1)}`
    )
    .join(" ");
  const areaPath = `${linePath} L${PLOT_RIGHT.toFixed(1)},${zeroY.toFixed(1)} L${PLOT_LEFT.toFixed(1)},${zeroY.toFixed(1)} Z`;

  const yTicks: {
    readonly id: "max" | "min" | "zero";
    readonly label: string;
    readonly y: number;
  }[] = [{ id: "zero", label: "$0", y: zeroY }];
  const maxY = yOf(rawMax);
  if (rawMax > 0 && zeroY - maxY >= MIN_TICK_GAP)
    yTicks.unshift({ id: "max", label: formatMoney(rawMax), y: maxY });
  const minY = yOf(rawMin);
  if (rawMin < 0 && minY - zeroY >= MIN_TICK_GAP)
    yTicks.push({ id: "min", label: formatMoney(rawMin), y: minY });

  const xTicks = X_TICK_RATIOS.map((ratio) => {
    const price = minSpot + spotSpan * ratio;
    return {
      anchor:
        ratio === 0
          ? ("start" as const)
          : ratio === 1
            ? ("end" as const)
            : ("middle" as const),
      label: formatSpot(price),
      ratio,
      x: xOf(price),
    };
  });

  const spotMarker =
    spot !== null && spot >= minSpot && spot <= maxSpot
      ? {
          spot,
          x: xOf(spot),
          y: yOf(interpolateGex(profile, spot)),
        }
      : null;

  const flipMarker =
    flip !== null && flip >= minSpot && flip <= maxSpot
      ? {
          flip,
          x: xOf(flip),
        }
      : null;

  const flipLabelY =
    zeroY > (PLOT_TOP + PLOT_BOTTOM) / 2 ? PLOT_TOP + 14 : PLOT_BOTTOM - 6;

  const summaryParts = [
    `Estimated net GEX vs hypothetical spot from ${formatSpot(minSpot)} to ${formatSpot(maxSpot)} (${profile.length} points).`,
    spot === null ? null : `Spot ${formatSpot(spot)}.`,
    flip === null
      ? "No zero-gamma crossing in sweep."
      : `Zero-gamma flip ${formatSpot(flip)}.`,
    `Range ${formatMoney(rawMin)} to ${formatMoney(rawMax)}.`,
  ].filter((part): part is string => part !== null);

  const posClipId = `${id}-pos`;
  const negClipId = `${id}-neg`;

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-2 rounded-md border border-border p-3"
      data-gex-spot-curve=""
      data-gex-spot-curve-state="ready"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="font-medium text-xs" id={headingId}>
          GEX vs hypothetical spot
        </h4>
        <p className="font-mono text-muted-foreground text-xs tabular-nums">
          {formatSpot(minSpot)} to {formatSpot(maxSpot)} ({profile.length}{" "}
          points)
        </p>
      </div>

      <ul
        aria-label="GEX spot curve legend"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground text-xs"
      >
        <li className="flex items-center gap-1.5">
          <svg
            aria-hidden="true"
            className="shrink-0"
            height="12"
            viewBox="0 0 20 12"
            width="20"
          >
            <line
              stroke="var(--primary)"
              strokeWidth="2.25"
              x1="0"
              x2="20"
              y1="6"
              y2="6"
            />
          </svg>
          <span>Est. net GEX</span>
        </li>
        <li className="flex items-center gap-1.5">
          <svg
            aria-hidden="true"
            className="shrink-0"
            height="12"
            viewBox="0 0 20 12"
            width="20"
          >
            <line
              stroke="var(--border-strong)"
              strokeDasharray="4 4"
              strokeWidth="1.25"
              x1="0"
              x2="20"
              y1="6"
              y2="6"
            />
          </svg>
          <span>Zero GEX ($0)</span>
        </li>
        {spot === null ? null : (
          <li className="flex items-center gap-1.5">
            <svg
              aria-hidden="true"
              className="shrink-0"
              height="12"
              viewBox="0 0 20 12"
              width="20"
            >
              <line
                stroke="var(--info)"
                strokeDasharray="5 3"
                strokeWidth="1.5"
                x1="0"
                x2="20"
                y1="6"
                y2="6"
              />
            </svg>
            <span className="font-mono tabular-nums">
              Spot {formatSpot(spot)}
              {spotMarker === null ? " (outside sweep)" : ""}
            </span>
          </li>
        )}
        <li className="flex items-center gap-1.5">
          <svg
            aria-hidden="true"
            className="shrink-0"
            height="12"
            viewBox="0 0 20 12"
            width="20"
          >
            <line
              stroke="var(--warning)"
              strokeDasharray="2 3"
              strokeWidth="1.5"
              x1="0"
              x2="20"
              y1="6"
              y2="6"
            />
            <circle
              cx="10"
              cy="6"
              fill="var(--background)"
              r="3"
              stroke="var(--warning)"
              strokeWidth="1.75"
            />
          </svg>
          <span className="font-mono tabular-nums">
            {flip === null
              ? "Zero-gamma flip: no zero crossing"
              : `Zero-gamma flip ${formatSpot(flip)}${flipMarker === null ? " (outside sweep)" : ""}`}
          </span>
        </li>
      </ul>

      <figure className="relative space-y-1">
        <svg
          aria-label={summaryParts.join(" ")}
          className="h-auto w-full"
          role="img"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        >
          <defs>
            <clipPath id={posClipId}>
              <rect
                height={Math.max(zeroY - PLOT_TOP, 0)}
                width={PLOT_W}
                x={PLOT_LEFT}
                y={PLOT_TOP}
              />
            </clipPath>
            <clipPath id={negClipId}>
              <rect
                height={Math.max(PLOT_BOTTOM - zeroY, 0)}
                width={PLOT_W}
                x={PLOT_LEFT}
                y={zeroY}
              />
            </clipPath>
          </defs>

          <rect
            fill="none"
            height={PLOT_H}
            stroke="var(--border)"
            strokeWidth={1}
            width={PLOT_W}
            x={PLOT_LEFT}
            y={PLOT_TOP}
          />

          <path
            clipPath={`url(#${posClipId})`}
            d={areaPath}
            data-gex-positive-area=""
            fill="var(--success)"
            fillOpacity={0.14}
          />
          <path
            clipPath={`url(#${negClipId})`}
            d={areaPath}
            data-gex-negative-area=""
            fill="var(--destructive)"
            fillOpacity={0.14}
          />

          <line
            data-gex-zero-line=""
            stroke="var(--border-strong)"
            strokeDasharray="4 4"
            strokeWidth={1.25}
            x1={PLOT_LEFT}
            x2={PLOT_RIGHT}
            y1={zeroY}
            y2={zeroY}
          />

          {yTicks.map((tick) => (
            <text
              className="fill-muted-foreground font-mono"
              dominantBaseline="middle"
              fontSize={11}
              key={tick.id}
              textAnchor="end"
              x={PLOT_LEFT - 6}
              y={tick.y}
            >
              {tick.label}
            </text>
          ))}

          {xTicks.map((tick) => (
            <text
              className="fill-muted-foreground font-mono"
              fontSize={11}
              key={tick.ratio}
              textAnchor={tick.anchor}
              x={tick.x}
              y={HEIGHT - 8}
            >
              {tick.label}
            </text>
          ))}

          <path
            d={linePath}
            data-gex-curve-line=""
            fill="none"
            stroke="var(--primary)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.25}
          />

          {spotMarker === null ? null : (
            <g data-gex-spot-marker="" data-spot={spotMarker.spot.toFixed(2)}>
              <line
                stroke="var(--info)"
                strokeDasharray="5 3"
                strokeWidth={1.5}
                x1={spotMarker.x}
                x2={spotMarker.x}
                y1={PLOT_TOP}
                y2={PLOT_BOTTOM}
              />
              <circle
                cx={spotMarker.x}
                cy={spotMarker.y}
                fill="var(--info)"
                r={4}
                stroke="var(--background)"
                strokeWidth={1.5}
              />
              <text
                className="font-mono"
                fill="var(--info-foreground)"
                fontSize={11}
                paintOrder="stroke"
                stroke="var(--background)"
                strokeLinejoin="round"
                strokeWidth={3}
                textAnchor="middle"
                x={clampLabelX(spotMarker.x)}
                y={15}
              >
                Spot {formatSpot(spotMarker.spot)}
              </text>
            </g>
          )}

          {flipMarker === null ? null : (
            <g data-flip={flipMarker.flip.toFixed(2)} data-gex-flip-marker="">
              <line
                stroke="var(--warning)"
                strokeDasharray="2 3"
                strokeWidth={1.5}
                x1={flipMarker.x}
                x2={flipMarker.x}
                y1={PLOT_TOP}
                y2={PLOT_BOTTOM}
              />
              <circle
                cx={flipMarker.x}
                cy={zeroY}
                fill="var(--background)"
                r={4.5}
                stroke="var(--warning)"
                strokeWidth={2.25}
              />
              <text
                className="font-mono"
                fill="var(--warning-foreground)"
                fontSize={11}
                paintOrder="stroke"
                stroke="var(--background)"
                strokeLinejoin="round"
                strokeWidth={3}
                textAnchor="middle"
                x={clampLabelX(flipMarker.x)}
                y={flipLabelY}
              >
                Flip {formatSpot(flipMarker.flip)}
              </text>
            </g>
          )}
        </svg>

        <table className="sr-only" data-gex-spot-curve-table="">
          <caption>GEX vs hypothetical spot</caption>
          <thead>
            <tr>
              <th scope="col">Hypothetical spot</th>
              <th scope="col">Estimated net GEX</th>
            </tr>
          </thead>
          <tbody>
            {profile.map((point, index) => (
              <tr key={`${point.spot}-${index}`}>
                <td>{formatSpot(point.spot)}</td>
                <td>{formatMoney(point.gex)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figure>

      <p className="text-muted-foreground text-xs">
        Fixed IV per strike and front-expiry time across a ±30% spot sweep
        (dealers long calls, short puts). Research view only.
      </p>
    </section>
  );
};
