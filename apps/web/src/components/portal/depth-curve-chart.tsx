"use client";

// What: cumulative bid/ask order-book depth curve SVG (chart F3) rendered from a DepthLadder.
// Uses semantic CSS tokens so dark, light and every portal palette stay high-contrast, and pairs
// color with stroke pattern (solid bids vs dashed asks) and text labels. Read-only research view.
// Used by: components/portal/order-flow-views.tsx.
import {
  buildDepthCurve,
  type DepthCurveLevel,
} from "../../features/order-flow/depth-curve.ts";
import type { DepthLadder } from "../../features/order-flow/depth-ladder.ts";

const BID_COLOR = "var(--color-success)";
const ASK_COLOR = "var(--color-destructive)";
const LABEL_EDGE_PAD = 44;

export interface DepthCurveChartProps {
  readonly digits: number;
  readonly ladder: DepthLadder;
  readonly minTick: number | null;
  readonly symbol: string;
  readonly unit: "shares" | "contracts";
}

const touchTitle = (
  sideLabel: "Best bid" | "Best ask",
  point: DepthCurveLevel,
  digits: number,
  unit: "shares" | "contracts"
): string => {
  const venueSuffix =
    point.venues.length === 0 ? "" : ` (${point.venues.join(", ")})`;
  const sizeText = point.size.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
  return `${sideLabel} ${point.price.toFixed(digits)}: ${sizeText} ${unit}${venueSuffix}`;
};

export const DepthCurveChart = ({
  digits,
  ladder,
  minTick,
  symbol,
  unit,
}: DepthCurveChartProps) => {
  const curve = buildDepthCurve(ladder, { digits, minTick, symbol, unit });
  if (curve === null) return null;

  const plotHeight = curve.plotBottom - curve.plotTop;
  const midLabelX =
    curve.midMarker === null
      ? null
      : Math.min(
          Math.max(curve.midMarker.x, curve.plotLeft + LABEL_EDGE_PAD),
          curve.plotRight - LABEL_EDGE_PAD
        );

  return (
    <figure className="min-w-0 space-y-2" data-depth-curve="">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <figcaption className="font-medium text-foreground text-xs">
          Cumulative depth ({unit})
        </figcaption>
        <ul
          aria-label="Depth curve legend"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs"
        >
          <li className="flex items-center gap-1.5">
            <svg
              aria-hidden="true"
              className="shrink-0"
              height="12"
              viewBox="0 0 20 12"
              width="20"
            >
              <rect
                fill={BID_COLOR}
                fillOpacity={0.18}
                height="6"
                width="20"
                x="0"
                y="6"
              />
              <line
                stroke={BID_COLOR}
                strokeWidth="2"
                x1="0"
                x2="20"
                y1="6"
                y2="6"
              />
            </svg>
            <span>Bids</span>
          </li>
          <li className="flex items-center gap-1.5">
            <svg
              aria-hidden="true"
              className="shrink-0"
              height="12"
              viewBox="0 0 20 12"
              width="20"
            >
              <rect
                fill={ASK_COLOR}
                fillOpacity={0.18}
                height="6"
                width="20"
                x="0"
                y="6"
              />
              <line
                stroke={ASK_COLOR}
                strokeDasharray="5 2.5"
                strokeWidth="2"
                x1="0"
                x2="20"
                y1="6"
                y2="6"
              />
            </svg>
            <span>Asks</span>
          </li>
          {curve.midMarker === null ? null : (
            <li className="flex items-center gap-1.5">
              <svg
                aria-hidden="true"
                className="shrink-0"
                height="12"
                viewBox="0 0 16 12"
                width="16"
              >
                <line
                  stroke="currentColor"
                  strokeDasharray="3 3"
                  strokeOpacity={0.6}
                  strokeWidth="1.5"
                  x1="0"
                  x2="16"
                  y1="6"
                  y2="6"
                />
              </svg>
              <span className="font-mono tabular-nums">
                {curve.midMarker.label}
              </span>
            </li>
          )}
        </ul>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-background/60 p-2">
        <svg
          aria-label={curve.ariaLabel}
          className="block h-auto w-full"
          data-depth-curve-svg=""
          role="img"
          viewBox={`0 0 ${curve.width} ${curve.height}`}
        >
          {curve.yTicks.map((tick) => (
            <g key={tick.value}>
              <line
                stroke="currentColor"
                strokeOpacity={tick.value === 0 ? 0.28 : 0.14}
                strokeWidth={1}
                x1={curve.plotLeft}
                x2={curve.plotRight}
                y1={tick.pos}
                y2={tick.pos}
              />
              <text
                className="fill-muted-foreground font-mono text-[11px]"
                dominantBaseline="middle"
                textAnchor="end"
                x={curve.plotLeft - 8}
                y={tick.pos}
              >
                {tick.label}
              </text>
            </g>
          ))}

          {curve.spreadBand === null ? null : (
            <rect
              data-depth-spread=""
              fill="currentColor"
              fillOpacity={0.06}
              height={plotHeight}
              width={curve.spreadBand.width}
              x={curve.spreadBand.x}
              y={curve.plotTop}
            />
          )}

          {curve.bidLinePath === "" ? null : (
            <>
              <path
                d={curve.bidAreaPath}
                data-depth-series="bid-area"
                fill={BID_COLOR}
                fillOpacity={0.18}
              />
              <path
                d={curve.bidLinePath}
                data-depth-series="bid-line"
                fill="none"
                stroke={BID_COLOR}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}

          {curve.askLinePath === "" ? null : (
            <>
              <path
                d={curve.askAreaPath}
                data-depth-series="ask-area"
                fill={ASK_COLOR}
                fillOpacity={0.18}
              />
              <path
                d={curve.askLinePath}
                data-depth-series="ask-line"
                fill="none"
                stroke={ASK_COLOR}
                strokeDasharray="6 3"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}

          {curve.midMarker === null || midLabelX === null ? null : (
            <g data-depth-mid={curve.midMarker.state}>
              <line
                stroke="currentColor"
                strokeDasharray="3 3"
                strokeOpacity={0.5}
                strokeWidth={1}
                x1={curve.midMarker.x}
                x2={curve.midMarker.x}
                y1={curve.plotTop}
                y2={curve.plotBottom}
              />
              <text
                className="fill-foreground font-mono text-[11px]"
                textAnchor="middle"
                x={midLabelX}
                y={curve.plotTop - 8}
              >
                {curve.midMarker.label}
              </text>
            </g>
          )}

          {curve.bestBidPoint === null ? null : (
            <circle
              cx={curve.bestBidPoint.x}
              cy={curve.bestBidPoint.y}
              data-depth-touch="bid"
              fill={BID_COLOR}
              r={3.5}
            >
              <title>
                {touchTitle("Best bid", curve.bestBidPoint, digits, unit)}
              </title>
            </circle>
          )}

          {curve.bestAskPoint === null ? null : (
            <circle
              cx={curve.bestAskPoint.x}
              cy={curve.bestAskPoint.y}
              data-depth-touch="ask"
              fill={ASK_COLOR}
              r={3.5}
            >
              <title>
                {touchTitle("Best ask", curve.bestAskPoint, digits, unit)}
              </title>
            </circle>
          )}

          {curve.xTicks.map((tick) => (
            <g key={tick.label}>
              <line
                stroke="currentColor"
                strokeOpacity={0.25}
                strokeWidth={1}
                x1={tick.pos}
                x2={tick.pos}
                y1={curve.plotBottom}
                y2={curve.plotBottom + 4}
              />
              <text
                className="fill-muted-foreground font-mono text-[11px]"
                textAnchor="middle"
                x={tick.pos}
                y={curve.plotBottom + 18}
              >
                {tick.label}
              </text>
            </g>
          ))}
        </svg>
      </div>

      {curve.bidSharePct === null || curve.askSharePct === null ? (
        <p className="text-muted-foreground text-xs" data-depth-zero-size="">
          Resting size is 0 {unit} across all returned levels.
        </p>
      ) : (
        <div className="space-y-1" data-depth-balance="">
          <div className="flex items-center justify-between text-muted-foreground text-xs tabular-nums">
            <span>Bid share {curve.bidSharePct}%</span>
            <span>Ask share {curve.askSharePct}%</span>
          </div>
          <div
            aria-hidden="true"
            className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <span
              style={{
                backgroundColor: BID_COLOR,
                opacity: 0.75,
                width: `${curve.bidSharePct}%`,
              }}
            />
            <span
              style={{
                backgroundColor: ASK_COLOR,
                opacity: 0.75,
                width: `${curve.askSharePct}%`,
              }}
            />
          </div>
        </div>
      )}
    </figure>
  );
};
