"use client";

// What: accessible, token-styled SVG rendering for horizontal gamma levels (gamma flip, call wall,
// put wall, max pain, king node) on /flow price charts:
// - `<SvgGammaLevelLines />`: reusable SVG `<g>` overlay drawn inside any /flow price-chart SVG.
// - `<FlowGammaLevelsStrip />`: strip under an intraday price chart: when the GEX estimate was
//   stored, the levels in range (as text for screen readers) and the levels above/below the
//   chart's Y-axis zoom, so intraday candles/bubbles are never compressed.
// - `<FlowGammaLevelsChart />`: full GEX-levels-on-price chart rendered inside `GexPanel` for all
//   /flow symbols (SPY, QQQ, ES, NQ).
// Display only: research context, never a trade signal or order input.
// Used by: components/portal/flow-workspace.tsx,
// components/portal/flow-trade-bubbles-panel.tsx,
// components/portal/flow-option-bubbles-panel.tsx.

import type { FlowSnapshot } from "@darkfactory/api";

import {
  GAMMA_LEVEL_KINDS,
  GAMMA_LEVEL_META,
  type GammaLevelKind,
} from "../../features/charts/gamma-levels-overlay.ts";
import { formatPrice } from "../../features/flow/format.ts";
import {
  buildFlowGexPriceChart,
  FLOW_GAMMA_COLOR_VAR,
  type FlowPriceOverlayLevels,
  type OffScaleGammaLevel,
  type SvgGammaLevelLine,
} from "../../features/flow/gamma-levels-view-model.ts";

/**
 * Draws horizontal gamma level lines and non-overlapping pill badges inside an SVG. The pills
 * sit at the left edge: the newest price and its label are at the right. A chart with candles
 * draws the `lines` layer under them and the `labels` layer over them, so a candle never hides a
 * label and the labels cover only the oldest candles.
 */
export const SvgGammaLevelLines = ({
  lines,
  chartX,
  chartWidth,
  layer = "all",
}: Readonly<{
  lines: readonly SvgGammaLevelLine[];
  chartX: number;
  chartWidth: number;
  layer?: "all" | "lines" | "labels";
}>) => {
  if (lines.length === 0) return null;
  const x2 = chartX + chartWidth;
  const pillX = chartX + 4;
  return (
    <g data-flow-gamma-lines={layer}>
      {lines.map((line) => {
        const maxPillWidth = Math.max(40, chartWidth - 8);
        const pillWidth = Math.min(
          maxPillWidth,
          Math.max(76, Math.ceil(line.pillText.length * 6.2 + 12))
        );
        const shifted = Math.abs(line.labelY - line.y) > 2;
        return (
          <g data-flow-gamma-line={line.key} key={line.key}>
            {layer === "labels" ? null : (
              <>
                <line
                  stroke={line.color}
                  strokeDasharray={line.dashArray}
                  strokeOpacity={0.92}
                  strokeWidth={line.strokeWidth}
                  x1={chartX}
                  x2={x2}
                  y1={line.y}
                  y2={line.y}
                />
                {line.isMergedWithKing ? (
                  <line
                    stroke={line.accentColor}
                    strokeDasharray="4 14"
                    strokeOpacity={0.95}
                    strokeWidth={2.5}
                    x1={chartX}
                    x2={x2}
                    y1={line.y}
                    y2={line.y}
                  />
                ) : null}
              </>
            )}
            {layer === "lines" ? null : (
              <>
                {shifted ? (
                  <line
                    stroke={line.color}
                    strokeOpacity={0.7}
                    strokeWidth={1}
                    x1={pillX + pillWidth}
                    x2={Math.min(x2, pillX + pillWidth + 8)}
                    y1={line.labelY}
                    y2={line.y}
                  />
                ) : null}
                <rect
                  fill="var(--background)"
                  fillOpacity={0.92}
                  height={16}
                  rx={3}
                  stroke={line.hasKingNode ? line.accentColor : line.color}
                  strokeWidth={1}
                  width={pillWidth}
                  x={pillX}
                  y={line.labelY - 8}
                />
                <text
                  className="fill-foreground font-mono text-[10px]"
                  dominantBaseline="middle"
                  textAnchor="start"
                  x={pillX + 5}
                  y={line.labelY}
                >
                  {line.pillText}
                </text>
              </>
            )}
          </g>
        );
      })}
    </g>
  );
};

const InlineStrokeSwatch = ({
  color,
  dashArray,
  strokeWidth,
}: Readonly<{
  color: string;
  dashArray: string | undefined;
  strokeWidth: number;
}>) => (
  <svg aria-hidden="true" className="h-2.5 w-4 shrink-0" viewBox="0 0 16 10">
    <line
      stroke={color}
      strokeDasharray={dashArray}
      strokeWidth={strokeWidth}
      x1={0}
      x2={16}
      y1={5}
      y2={5}
    />
  </svg>
);

const OffScaleList = ({
  items,
  label,
}: Readonly<{ items: readonly OffScaleGammaLevel[]; label: string }>) =>
  items.length === 0 ? null : (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-foreground">{label}</span>
      {items.map((item) => (
        <span
          className="inline-flex items-center gap-1 font-mono tabular-nums"
          key={item.key}
        >
          <InlineStrokeSwatch
            color={item.color}
            dashArray={item.dashArray}
            strokeWidth={item.strokeWidth}
          />
          <span>
            {item.glyphs} {item.shortLabel} {item.priceText}
            {item.distanceText === null ? "" : ` (${item.distanceText})`}
          </span>
        </span>
      ))}
    </span>
  );

/**
 * Strip under an intraday /flow price chart with gamma levels: when the estimate was stored, the
 * drawn levels as text for screen readers (the Trade Bubbles SVG is hidden from them), and the
 * levels above or below the chart's Y-axis zoom.
 */
export const FlowGammaLevelsStrip = ({
  levels,
}: Readonly<{ levels: FlowPriceOverlayLevels }>) => (
  <div
    className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-muted-foreground text-xs"
    data-flow-gamma-strip=""
  >
    <span data-flow-gamma-as-of="">
      Gamma levels: GEX estimate as of {levels.asOfText}
    </span>
    {levels.visibleLines.length === 0 ? null : (
      <span className="sr-only" data-flow-gamma-in-range="">
        In range: {levels.visibleLines.map((line) => line.pillText).join(", ")}
      </span>
    )}
    <OffScaleList items={levels.offScaleAbove} label="↑ Above range:" />
    <OffScaleList items={levels.offScaleBelow} label="↓ Below range:" />
  </div>
);

const LegendSwatch = ({ kind }: Readonly<{ kind: GammaLevelKind }>) => {
  const meta = GAMMA_LEVEL_META[kind];
  return (
    <InlineStrokeSwatch
      color={FLOW_GAMMA_COLOR_VAR[kind]}
      dashArray={meta.svgDashArray}
      strokeWidth={meta.strokeWidth}
    />
  );
};

/** Full price-and-gamma-levels SVG chart inside `GexPanel` on /flow. */
export const FlowGammaLevelsChart = ({
  snapshot,
}: Readonly<{ snapshot: FlowSnapshot }>) => {
  const chart = buildFlowGexPriceChart(snapshot);
  if (chart === null) return null;
  const byKind = new Map(
    chart.entries.map((entry) => [entry.kind, entry] as const)
  );
  return (
    <figure className="space-y-2.5" data-flow-gex-price-chart="">
      <figcaption className="text-muted-foreground text-xs">
        {chart.hasMinuteSeries
          ? `${chart.symbol} intraday close and VWAP with estimated gamma flip, call/put walls, max pain, and king node.`
          : `${chart.symbol} reference spot with estimated gamma flip, call/put walls, max pain, and king node (no intraday tape closes in this window yet).`}
      </figcaption>
      <div className="overflow-x-auto">
        <svg
          aria-label={chart.ariaLabel}
          className="aspect-[3/1] w-full min-w-[480px] select-none"
          data-flow-gex-svg=""
          role="img"
          viewBox={`0 0 ${chart.width} ${chart.height}`}
        >
          {chart.priceTicks.map((tick) => (
            <g key={tick.pos}>
              <line
                stroke="var(--border)"
                strokeOpacity={0.5}
                x1={chart.chartX}
                x2={chart.chartX + chart.chartWidth}
                y1={tick.pos}
                y2={tick.pos}
              />
              <text
                className="fill-muted-foreground font-mono text-[10px]"
                dominantBaseline="middle"
                textAnchor="end"
                x={chart.chartX - 6}
                y={tick.pos}
              >
                {tick.label}
              </text>
            </g>
          ))}
          <SvgGammaLevelLines
            chartWidth={chart.chartWidth}
            chartX={chart.chartX}
            lines={chart.lines}
          />
          {chart.vwapSegments.map((points) => (
            <polyline
              data-flow-gex-vwap=""
              fill="none"
              key={points}
              points={points}
              stroke="var(--muted-foreground)"
              strokeDasharray="3 3"
              strokeWidth={1.25}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {chart.priceSegments.map((points) => (
            <polyline
              data-flow-gex-price-line=""
              fill="none"
              key={points}
              points={points}
              stroke="var(--foreground)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {chart.spotX !== null &&
          chart.spotY !== null &&
          chart.spotLabel !== null ? (
            <g data-flow-gex-spot="">
              {chart.hasMinuteSeries ? null : (
                <line
                  stroke="var(--foreground)"
                  strokeDasharray="4 3"
                  strokeOpacity={0.75}
                  strokeWidth={1.5}
                  x1={chart.chartX}
                  x2={chart.chartX + chart.chartWidth}
                  y1={chart.spotY}
                  y2={chart.spotY}
                />
              )}
              <circle
                cx={chart.spotX}
                cy={chart.spotY}
                fill="var(--foreground)"
                r={3}
              />
              {/* Above the dot, so the label does not print over the price line. */}
              <text
                className="fill-foreground font-mono text-[10px]"
                dominantBaseline="middle"
                textAnchor={
                  chart.spotX > chart.chartX + chart.chartWidth * 0.65
                    ? "end"
                    : "start"
                }
                x={
                  chart.spotX > chart.chartX + chart.chartWidth * 0.65
                    ? chart.spotX - 7
                    : chart.spotX + 7
                }
                y={Math.max(chart.chartY + 6, chart.spotY - 9)}
              >
                {chart.spotLabel}
              </text>
            </g>
          ) : null}
          {chart.timeTicks.map((tick) => (
            <text
              className="fill-muted-foreground font-mono text-[10px]"
              key={tick.pos}
              textAnchor={tick.anchor}
              x={tick.pos}
              y={chart.height - 6}
            >
              {tick.label}
            </text>
          ))}
        </svg>
      </div>
      <ul
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
        data-flow-gex-legend=""
      >
        {GAMMA_LEVEL_KINDS.map((kind) => {
          const meta = GAMMA_LEVEL_META[kind];
          const entry = byKind.get(kind);
          return (
            <li className="inline-flex items-center gap-1.5" key={kind}>
              <LegendSwatch kind={kind} />
              <span className="text-muted-foreground">
                <span aria-hidden="true" className="mr-0.5">
                  {meta.glyph}
                </span>
                {meta.label}:
              </span>
              <span className="font-mono text-foreground tabular-nums">
                {entry === undefined
                  ? "not computed"
                  : formatPrice(entry.price)}
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
};
