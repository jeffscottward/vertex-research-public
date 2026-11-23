// What: the Bookmap-style liquidity heatmap panel of /flow (flow.liquidityHeatmap): recorded CME
// L2 resting depth over time behind the price line, large futures trade dots, right-edge current
// DOM bars, hover/keyboard column inspection, persistent resting walls, and recent large prints.
// It has its own loading and failure state, so a fault of its call changes no other panel.
// Research only: resting depth and trade dots describe the book and tape, never a trade signal.
// Used by: apps/web/src/components/portal/flow-workspace.tsx.
// See: apps/web/src/features/flow/liquidity-heatmap-view-model.ts;
// docs/vertex-rebuild/designs/vertex-viz-liquidity-heatmap/design.md.
"use client";

import type { FlowLiquidityHeatmap } from "@darkfactory/api";
import {
  Panel,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import {
  type KeyboardEvent,
  type PointerEvent,
  useId,
  useMemo,
  useState,
} from "react";

import type { FlowControlFailure } from "../../features/flow/control-view-model.ts";
import {
  buildLiquidityHeatmapPlot,
  type ColumnInspection,
  captureBadge,
  columnCenterX,
  columnIndexFromRatio,
  depthStatusLine,
  HEAT_TIER_STOPS,
  HEAT_TIER_STYLE,
  heatmapAriaLabel,
  heatmapRuleLine,
  heatmapSymbolOf,
  inspectColumnSummary,
  LIQUIDITY_HEATMAP_EMPTY,
  LIQUIDITY_HEATMAP_LOADING,
  LIQUIDITY_HEATMAP_TRADE_HEADERS,
  LIQUIDITY_HEATMAP_WALL_HEADERS,
  type LiquidityHeatmapPlot,
  type LiquidityTradeRow,
  type LiquidityWallRow,
  liquidityHeatmapTitle,
  tradeRows,
  wallRows,
} from "../../features/flow/liquidity-heatmap-view-model.ts";
import type { FlowSymbol } from "../../features/flow/view-model.ts";
import { loadFailedLabel } from "../status-time.ts";

/** A failed flow.liquidityHeatmap call: error code, message, and timestamp. */
export type FlowLiquidityHeatmapFailure = FlowControlFailure &
  Readonly<{ failedAt: number }>;

const nextKeyIndex = (
  key: string,
  current: number,
  columnCount: number
): number | "clear" | null => {
  if (key === "ArrowLeft") return Math.max(0, current - 1);
  if (key === "ArrowRight") return Math.min(columnCount - 1, current + 1);
  if (key === "Home") return 0;
  if (key === "End") return columnCount - 1;
  if (key === "Escape") return "clear";
  return null;
};

const HeatmapLegend = () => (
  <div
    className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground text-xs"
    data-flow-heatmap-legend=""
  >
    <div className="flex flex-wrap items-center gap-1.5">
      <span>Depth</span>
      {HEAT_TIER_STOPS.map((stop) => (
        <span className="inline-flex items-center gap-1" key={stop.tier}>
          <span
            aria-hidden="true"
            className="inline-block size-3 rounded-xs border border-border"
            style={{ backgroundColor: stop.fill, opacity: stop.opacity }}
          />
          <span>{stop.label}</span>
        </span>
      ))}
    </div>
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden="true"
        className="inline-block size-2.5 rounded-full"
        style={{ backgroundColor: "var(--color-success)" }}
      />
      <span>Buy print</span>
    </span>
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden="true"
        className="inline-block size-2.5 rounded-full"
        style={{ backgroundColor: "var(--color-destructive)" }}
      />
      <span>Sell print</span>
    </span>
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden="true"
        className="inline-block size-3 rounded-xs border border-border bg-current opacity-15"
      />
      <span>No-data gap</span>
    </span>
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden="true"
        className="inline-block h-2 w-3 rounded-xs"
        style={{ backgroundColor: "var(--color-info)" }}
      />
      <span>Bid DOM</span>
    </span>
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden="true"
        className="inline-block h-2 w-3 rounded-xs"
        style={{ backgroundColor: "var(--color-warning)" }}
      />
      <span>Ask DOM</span>
    </span>
  </div>
);

const InspectionStrip = ({
  inspection,
}: Readonly<{ inspection: ColumnInspection | null }>) => {
  if (inspection === null) return null;
  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs tabular-nums"
      data-flow-heatmap-inspect=""
    >
      <span className="font-medium text-foreground">
        {inspection.timeLabel}
      </span>
      <span className="text-muted-foreground">{inspection.captureLabel}</span>
      <span>
        Mid{" "}
        <strong className="font-medium text-foreground">
          {inspection.midLabel}
        </strong>
      </span>
      <span>
        Bid{" "}
        <strong className="font-medium text-foreground">
          {inspection.bestBidLabel}
        </strong>
      </span>
      <span>
        Ask{" "}
        <strong className="font-medium text-foreground">
          {inspection.bestAskLabel}
        </strong>
      </span>
      <span>
        Spread{" "}
        <strong className="font-medium text-foreground">
          {inspection.spreadLabel}
        </strong>
      </span>
      <span>
        Top wall{" "}
        <strong className="font-medium text-foreground">
          {inspection.topLevelLabel}
        </strong>
      </span>
    </div>
  );
};

const HeatmapSvg = ({
  inspectIndex,
  onPointerMove,
  plot,
}: Readonly<{
  inspectIndex: number | null;
  onPointerMove: (event: PointerEvent<SVGSVGElement>) => void;
  plot: LiquidityHeatmapPlot;
}>) => {
  const crosshairX =
    inspectIndex === null || plot.columnCount === 0
      ? null
      : columnCenterX(plot, inspectIndex);

  return (
    <svg
      aria-hidden="true"
      className="block h-auto w-full min-w-[540px] select-none"
      data-flow-heatmap-svg=""
      onPointerMove={onPointerMove}
      viewBox={`0 0 ${plot.width} ${plot.height}`}
    >
      {/* Chart plot frame */}
      <rect
        fill="none"
        height={plot.chartHeight}
        stroke="currentColor"
        strokeOpacity={0.14}
        width={plot.chartWidth}
        x={plot.chartX}
        y={plot.chartY}
      />

      {/* Horizontal price gridlines */}
      {plot.priceTicks.map((tick) => (
        <g key={tick.price}>
          <line
            stroke="currentColor"
            strokeDasharray="2 3"
            strokeOpacity={0.12}
            x1={plot.chartX}
            x2={plot.chartX + plot.chartWidth}
            y1={tick.y}
            y2={tick.y}
          />
          <text
            dominantBaseline="middle"
            fill="currentColor"
            fillOpacity={0.72}
            fontSize={10}
            textAnchor="end"
            x={plot.chartX - 6}
            y={tick.y}
          >
            {tick.label}
          </text>
        </g>
      ))}

      {/* No-data gap shading */}
      {plot.gapRects.map((gap) => (
        <rect
          data-flow-heatmap-gap=""
          fill="currentColor"
          fillOpacity={0.07}
          height={plot.chartHeight}
          key={`${gap.startIndex}-${gap.endIndex}`}
          width={gap.width}
          x={gap.x}
          y={plot.chartY}
        />
      ))}

      {/* Resting liquidity cells */}
      {plot.cells.map((cell) => {
        const stop = HEAT_TIER_STYLE[cell.tier];
        return (
          <rect
            data-flow-heatmap-cell={cell.tier}
            fill={stop.fill}
            fillOpacity={stop.opacity}
            height={cell.height}
            key={cell.key}
            width={cell.width}
            x={cell.x}
            y={cell.y}
          />
        );
      })}

      {/* Subtle best bid / best ask overlays */}
      {plot.bestBidSegments.map((points, idx) => (
        <polyline
          data-flow-heatmap-bbo="bid"
          fill="none"
          key={`bid-${idx}`}
          points={points}
          stroke="var(--color-info)"
          strokeOpacity={0.5}
          strokeWidth={1}
        />
      ))}
      {plot.bestAskSegments.map((points, idx) => (
        <polyline
          data-flow-heatmap-bbo="ask"
          fill="none"
          key={`ask-${idx}`}
          points={points}
          stroke="var(--color-warning)"
          strokeOpacity={0.5}
          strokeWidth={1}
        />
      ))}

      {/* Mid-price line */}
      {plot.midSegments.map((points, idx) => (
        <polyline
          data-flow-heatmap-mid=""
          fill="none"
          key={`mid-${idx}`}
          points={points}
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth={1.75}
        />
      ))}
      {plot.midDots.map((dot, idx) => (
        <circle
          cx={dot.x}
          cy={dot.y}
          data-flow-heatmap-mid-dot=""
          fill="currentColor"
          key={`mid-dot-${idx}`}
          r={2}
        />
      ))}

      {/* Large-trade dots */}
      {plot.tradeDots.map((dot) => (
        <circle
          cx={dot.cx}
          cy={dot.cy}
          data-flow-heatmap-trade={dot.side}
          fill={
            dot.side === "buy"
              ? "var(--color-success)"
              : "var(--color-destructive)"
          }
          fillOpacity={0.82}
          key={dot.key}
          r={dot.r}
          stroke="var(--color-background)"
          strokeWidth={1}
        >
          <title>{dot.label}</title>
        </circle>
      ))}

      {/* Right-edge current DOM bars */}
      <text
        fill="currentColor"
        fillOpacity={0.65}
        fontSize={9}
        textAnchor="start"
        x={plot.domX}
        y={plot.chartY - 3}
      >
        DOM
      </text>
      {plot.domBars.map((bar) => (
        <rect
          data-flow-heatmap-dom={bar.side}
          fill={
            bar.side === "bid" ? "var(--color-info)" : "var(--color-warning)"
          }
          fillOpacity={0.78}
          height={bar.height}
          key={bar.key}
          width={bar.width}
          x={bar.x}
          y={bar.y}
        />
      ))}

      {/* Inspection crosshair */}
      {crosshairX === null ? null : (
        <line
          data-flow-heatmap-crosshair=""
          stroke="currentColor"
          strokeDasharray="3 2"
          strokeOpacity={0.55}
          x1={crosshairX}
          x2={crosshairX}
          y1={plot.chartY}
          y2={plot.chartY + plot.chartHeight}
        />
      )}

      {/* Time axis ticks */}
      {plot.timeTicks.map((tick, idx) => (
        <text
          fill="currentColor"
          fillOpacity={0.72}
          fontSize={10}
          key={`${tick.label}-${idx}`}
          textAnchor="middle"
          x={tick.x}
          y={plot.chartY + plot.chartHeight + 16}
        >
          {tick.label}
        </text>
      ))}
    </svg>
  );
};

const WallsTable = ({
  rows,
  symbol,
}: Readonly<{ rows: readonly LiquidityWallRow[]; symbol: string }>) => {
  if (rows.length === 0) return null;
  return (
    <Table
      className="text-sm"
      containerClassName="max-h-64 max-w-full overflow-auto"
      containerProps={{
        "aria-label": `Persistent resting walls for ${symbol}`,
        role: "region",
        tabIndex: 0,
      }}
    >
      <TableCaption className="sr-only">
        Persistent resting liquidity walls of {symbol} in this window
      </TableCaption>
      <TableHeader>
        <TableRow>
          {LIQUIDITY_HEATMAP_WALL_HEADERS.map((header, index) => (
            <TableHead
              className={index >= 2 ? "text-right" : undefined}
              key={header}
              scope="col"
            >
              {header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow data-flow-heatmap-wall-row="" key={row.key}>
            <TableCell className="tabular-nums">{row.price}</TableCell>
            <TableCell>{row.side}</TableCell>
            <TableCell className="text-right tabular-nums">
              {row.size}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.persistence}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const TradesTable = ({
  rows,
  symbol,
}: Readonly<{ rows: readonly LiquidityTradeRow[]; symbol: string }>) => {
  if (rows.length === 0) return null;
  return (
    <Table
      className="text-sm"
      containerClassName="max-h-64 max-w-full overflow-auto"
      containerProps={{
        "aria-label": `Recent large futures prints for ${symbol}`,
        role: "region",
        tabIndex: 0,
      }}
    >
      <TableCaption className="sr-only">
        Recent large futures prints of {symbol} in this window, newest first
      </TableCaption>
      <TableHeader>
        <TableRow>
          {LIQUIDITY_HEATMAP_TRADE_HEADERS.map((header, index) => (
            <TableHead
              className={index === 2 || index === 3 ? "text-right" : undefined}
              key={header}
              scope="col"
            >
              {header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow data-flow-heatmap-trade-row="" key={row.key}>
            <TableCell className="tabular-nums">{row.time}</TableCell>
            <TableCell>{row.side}</TableCell>
            <TableCell className="text-right tabular-nums">
              {row.price}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.size}
            </TableCell>
            <TableCell>{row.signing}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const HeatmapDocument = ({
  document,
}: Readonly<{ document: FlowLiquidityHeatmap }>) => {
  const captionId = useId();
  const plot = useMemo(() => buildLiquidityHeatmapPlot(document), [document]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const badge = captureBadge(document.capture);
  const walls = useMemo(() => wallRows(document), [document]);
  const trades = useMemo(() => tradeRows(document), [document]);
  const activeIndex =
    selectedIndex !== null && selectedIndex < plot.columnCount
      ? selectedIndex
      : plot.defaultInspectIndex;
  const inspection =
    activeIndex === null ? null : inspectColumnSummary(document, activeIndex);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (plot.columnCount === 0) return;
    const base = activeIndex ?? 0;
    const next = nextKeyIndex(event.key, base, plot.columnCount);
    if (next === null) return;
    event.preventDefault();
    setSelectedIndex(next === "clear" ? null : next);
  };

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || plot.columnCount === 0) return;
    const leftRatio = plot.chartX / plot.width;
    const spanRatio = plot.chartWidth / plot.width;
    const relX = (event.clientX - rect.left) / rect.width;
    const chartRatio = (relX - leftRatio) / spanRatio;
    setSelectedIndex(columnIndexFromRatio(plot.columnCount, chartRatio));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={badge.tone}>{badge.label}</StatusBadge>
        <p className="text-muted-foreground" data-flow-heatmap-status="">
          {depthStatusLine(document)}
        </p>
      </div>

      {document.totals.recordedColumns === 0 ? (
        <p className="text-sm" data-flow-heatmap-empty="" role="status">
          {LIQUIDITY_HEATMAP_EMPTY}
        </p>
      ) : (
        <figure className="space-y-2">
          <figcaption
            className="sr-only"
            data-flow-heatmap-caption=""
            id={captionId}
          >
            {heatmapAriaLabel(document)}
          </figcaption>
          <HeatmapLegend />
          <div
            aria-describedby={captionId}
            aria-label={`Inspect ${document.symbol} liquidity heatmap columns with Left, Right, Home, End, or Escape`}
            aria-valuemax={plot.columnCount}
            aria-valuemin={1}
            aria-valuenow={(activeIndex ?? 0) + 1}
            aria-valuetext={
              inspection === null
                ? undefined
                : `${inspection.timeLabel}, ${inspection.captureLabel}, mid ${inspection.midLabel}, top wall ${inspection.topLevelLabel}`
            }
            className="overflow-x-auto rounded-md border border-border bg-card p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-flow-heatmap-interactive=""
            onKeyDown={handleKeyDown}
            onPointerLeave={() => setSelectedIndex(null)}
            role="slider"
            tabIndex={0}
          >
            <HeatmapSvg
              inspectIndex={activeIndex}
              onPointerMove={handlePointerMove}
              plot={plot}
            />
          </div>
          <InspectionStrip inspection={inspection} />
        </figure>
      )}

      <p className="text-muted-foreground text-xs" data-flow-heatmap-rule="">
        {heatmapRuleLine(document)}
      </p>

      {walls.length > 0 || trades.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <WallsTable rows={walls} symbol={document.symbol} />
          <TradesTable rows={trades} symbol={document.symbol} />
        </div>
      ) : null}
    </div>
  );
};

/**
 * Three states: loading (no document and no failure), failed (error alert; last document stays
 * below when present), and document.
 */
export const FlowLiquidityHeatmapPanel = ({
  document,
  failure,
  refreshMs,
  symbol,
}: Readonly<{
  document: FlowLiquidityHeatmap | null;
  failure: FlowLiquidityHeatmapFailure | null;
  refreshMs: number;
  symbol: FlowSymbol;
}>) => {
  const state = ((): "failed" | "document" | "loading" => {
    if (failure !== null) return "failed";
    return document === null ? "loading" : "document";
  })();

  return (
    <Panel title={liquidityHeatmapTitle(symbol)}>
      <div
        className={document === null ? "min-h-96 space-y-4" : "space-y-4"}
        data-flow-heatmap={heatmapSymbolOf(symbol)}
        data-flow-heatmap-state={state}
      >
        {failure === null ? null : (
          <p className="text-sm" data-flow-heatmap-error="" role="alert">
            {`${loadFailedLabel(failure.failedAt)} · Liquidity heatmap not loaded: ${failure.code}: ${failure.message} · retrying every ${Math.round(refreshMs / 1000)} s`}
          </p>
        )}
        {state === "loading" ? (
          <p className="text-muted-foreground text-sm" role="status">
            {LIQUIDITY_HEATMAP_LOADING}
          </p>
        ) : null}
        {document === null ? null : <HeatmapDocument document={document} />}
      </div>
    </Panel>
  );
};
