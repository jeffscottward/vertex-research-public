// What: the Big futures trades bubbles panel on /flow (flow.tradeBubbles, flow-trade-bubbles.v1):
// 1-minute ES/NQ price candles and VWAP with area-proportional buy/sell deep-trade bubbles from
// stored flow_large_trades, instant side & size-multiple filters, keyboard & pointer bubble
// inspection, summary stats, and a top-prints table.
// It has its own loading and failure state, so a fault of its call changes no other panel.
// Research only: describes recorded CME futures prices and deep prints; never a trade signal.
// Used by: apps/web/src/components/portal/flow-workspace.tsx.
// See: apps/web/src/features/flow/trade-bubbles-view-model.ts;
// docs/vertex-rebuild/designs/vertex-viz-trade-bubbles/design.md.
"use client";

import type { FlowGex, FlowTradeBubbles } from "@darkfactory/api";
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
  type MouseEvent as ReactMouseEvent,
  useId,
  useMemo,
  useState,
} from "react";

import type { FlowControlFailure } from "../../features/flow/control-view-model.ts";
import { formatCount, formatNyDateTime } from "../../features/flow/format.ts";
import {
  buildFlowPriceOverlayLevels,
  type SvgGammaLevelLine,
} from "../../features/flow/gamma-levels-view-model.ts";
import { tapeSymbolOf } from "../../features/flow/tape-speed-view-model.ts";
import {
  buildTradeBubblesPlot,
  describeTradeBubble,
  filterTradeBubbles,
  moveBubbleSelection,
  summarizeTradeBubbles,
  TRADE_BUBBLES_EMPTY,
  TRADE_BUBBLES_LOADING,
  TRADE_BUBBLES_SIDE_FILTERS,
  TRADE_BUBBLES_SIZE_FILTERS,
  TRADE_BUBBLES_TABLE_HEADERS,
  type TradeBubblePlotPoint,
  type TradeBubblesPlot,
  type TradeBubblesSideFilter,
  type TradeBubblesSizeFilter,
  type TradeBubbleTableRow,
  tradeBubblesCaptureBadge,
  tradeBubblesRuleLine,
  tradeBubblesTableRows,
  tradeBubblesTapeBadge,
  tradeBubblesTitle,
} from "../../features/flow/trade-bubbles-view-model.ts";
import type { FlowSymbol } from "../../features/flow/view-model.ts";
import { loadFailedLabel } from "../status-time.ts";
import {
  FlowGammaLevelsStrip,
  SvgGammaLevelLines,
} from "./flow-gamma-levels-chart.tsx";

export type FlowTradeBubblesFailure = FlowControlFailure &
  Readonly<{ failedAt: number }>;
export type FlowTradeBubblesPanelProps = Readonly<{
  document: FlowTradeBubbles | null;
  failure: FlowTradeBubblesFailure | null;
  gex?: FlowGex | null;
  refreshMs: number;
  symbol: FlowSymbol;
}>;

const SIDE_FILTER_LABEL: Readonly<Record<TradeBubblesSideFilter, string>> = {
  all: "All sides",
  buy: "Buy",
  sell: "Sell",
};

const SIZE_FILTER_LABEL: Readonly<Record<TradeBubblesSizeFilter, string>> = {
  "2x": "≥ 2×",
  "3x": "≥ 3×",
  all: "All deep",
};

const FILTER_BUTTON_BASE =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const filterButtonClass = (active: boolean): string =>
  active
    ? `${FILTER_BUTTON_BASE} border-foreground bg-foreground text-background`
    : `${FILTER_BUTTON_BASE} border-border bg-background text-foreground hover:bg-muted`;

const toneTextClass = (
  tone: "destructive" | "info" | "neutral" | "success" | "warning"
): string => {
  if (tone === "success") return "text-success";
  if (tone === "destructive") return "text-destructive";
  return "text-foreground";
};

const BubbleChartSvg = ({
  gammaLines,
  onKeyDown,
  onSelect,
  plot,
  selectedPoint,
  symbol,
  titleId,
}: Readonly<{
  gammaLines: readonly SvgGammaLevelLine[];
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onSelect: (key: string) => void;
  plot: TradeBubblesPlot;
  selectedPoint: TradeBubblePlotPoint | null;
  symbol: string;
  titleId: string;
}>) => {
  const selectedKey = selectedPoint?.key ?? null;
  const activeIndex =
    selectedKey === null ? -1 : plot.chronologicalKeys.indexOf(selectedKey);

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // Click events dispatched inside this container originate from a DOM Element.
    const target = event.target as Element;
    const key = target
      .closest("[data-flow-trade-bubble-key]")
      ?.getAttribute("data-flow-trade-bubble-key");
    if (key) onSelect(key);
  };

  return (
    <div
      aria-describedby={titleId}
      aria-label={`Inspect ${symbol} deep futures trade bubbles with Left, Right, Home, End, or Escape`}
      aria-valuemax={plot.chronologicalKeys.length}
      aria-valuemin={0}
      aria-valuenow={activeIndex + 1}
      aria-valuetext={
        selectedPoint === null ? "No print selected" : selectedPoint.label
      }
      className="overflow-x-auto rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-flow-trade-bubbles-interactive=""
      onClick={handleClick}
      onKeyDown={onKeyDown}
      role="slider"
      tabIndex={0}
    >
      <svg
        aria-hidden="true"
        className="block h-auto w-full min-w-[320px] select-none text-foreground"
        data-flow-trade-bubbles-svg=""
        viewBox={`0 0 ${plot.width} ${plot.height}`}
      >
        {/* Horizontal price gridlines & labels */}
        {plot.priceTicks.map((tick, idx) => (
          <g key={`price-${idx}`}>
            <line
              stroke="var(--color-border)"
              strokeDasharray="3 3"
              strokeOpacity={0.75}
              x1={plot.chartX}
              x2={plot.chartX + plot.chartWidth}
              y1={tick.pos}
              y2={tick.pos}
            />
            <text
              fill="currentColor"
              fillOpacity={0.72}
              fontSize={10}
              textAnchor="end"
              x={plot.chartX - 8}
              y={tick.pos + 3}
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* Vertical time gridlines & labels */}
        {plot.timeTicks.map((tick, idx) => (
          <g key={`time-${idx}`}>
            <line
              stroke="var(--color-border)"
              strokeOpacity={0.4}
              x1={tick.pos}
              x2={tick.pos}
              y1={plot.chartY}
              y2={plot.chartY + plot.chartHeight}
            />
            <text
              fill="currentColor"
              fillOpacity={0.72}
              fontSize={10}
              textAnchor={tick.anchor}
              x={tick.pos}
              y={plot.chartY + plot.chartHeight + 18}
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* Dealer gamma level lines, under the candles and the price lines */}
        <SvgGammaLevelLines
          chartWidth={plot.chartWidth}
          chartX={plot.chartX}
          layer="lines"
          lines={gammaLines}
        />

        {/* 1-minute OHLC candles */}
        {plot.candles.map((candle) => {
          const stroke =
            candle.direction === "up"
              ? "var(--color-success)"
              : candle.direction === "down"
                ? "var(--color-destructive)"
                : "var(--color-muted-foreground)";
          return (
            <g
              data-flow-trade-bubbles-candle={candle.direction}
              key={candle.key}
            >
              <line
                stroke={stroke}
                strokeOpacity={0.55}
                strokeWidth={1}
                x1={candle.wickX}
                x2={candle.wickX}
                y1={candle.wickY1}
                y2={candle.wickY2}
              />
              <rect
                fill={candle.direction === "up" ? "none" : stroke}
                fillOpacity={candle.direction === "flat" ? 0.6 : 0.38}
                height={candle.bodyHeight}
                stroke={stroke}
                strokeOpacity={0.85}
                strokeWidth={1}
                width={candle.bodyWidth}
                x={candle.bodyX}
                y={candle.bodyY}
              >
                <title>{candle.label}</title>
              </rect>
            </g>
          );
        })}

        {/* Close price line (subtle continuity) */}
        {plot.closeLinePoints === null ? null : (
          <polyline
            data-flow-trade-bubbles-close=""
            fill="none"
            points={plot.closeLinePoints}
            stroke="currentColor"
            strokeLinejoin="round"
            strokeOpacity={0.5}
            strokeWidth={1.25}
          />
        )}

        {/* VWAP line */}
        {plot.vwapLinePoints === null ? null : (
          <polyline
            data-flow-trade-bubbles-vwap=""
            fill="none"
            points={plot.vwapLinePoints}
            stroke="var(--color-info)"
            strokeDasharray="4 3"
            strokeLinejoin="round"
            strokeOpacity={0.85}
            strokeWidth={1.5}
          />
        )}

        {/* Gamma level labels at the left edge, over the oldest candles */}
        <SvgGammaLevelLines
          chartWidth={plot.chartWidth}
          chartX={plot.chartX}
          layer="labels"
          lines={gammaLines}
        />

        {/* Selected crosshair */}
        {selectedPoint === null ? null : (
          <g data-flow-trade-bubbles-crosshair="">
            <line
              stroke="currentColor"
              strokeDasharray="3 2"
              strokeOpacity={0.55}
              x1={selectedPoint.cx}
              x2={selectedPoint.cx}
              y1={plot.chartY}
              y2={plot.chartY + plot.chartHeight}
            />
            <line
              stroke="currentColor"
              strokeDasharray="3 2"
              strokeOpacity={0.4}
              x1={plot.chartX}
              x2={plot.chartX + plot.chartWidth}
              y1={selectedPoint.cy}
              y2={selectedPoint.cy}
            />
          </g>
        )}

        {/* Big futures trade bubbles (largest painted first so smaller bubbles stay accessible) */}
        {plot.bubbles.map((point) => {
          const isBuy = point.bubble.side === "buy";
          const color = isBuy
            ? "var(--color-success)"
            : "var(--color-destructive)";
          const selected = point.key === selectedKey;
          return (
            <g
              className="cursor-pointer"
              data-flow-trade-bubble={point.bubble.side}
              data-flow-trade-bubble-key={point.key}
              data-selected={selected ? "true" : undefined}
              key={point.key}
            >
              <circle
                cx={point.cx}
                cy={point.cy}
                fill={color}
                fillOpacity={selected ? 0.45 : 0.28}
                r={point.r}
                stroke={color}
                strokeDasharray={isBuy ? undefined : "4 2"}
                strokeWidth={selected ? 2.5 : 1.75}
              >
                <title>{point.label}</title>
              </circle>
              {selected ? (
                <circle
                  cx={point.cx}
                  cy={point.cy}
                  fill="none"
                  r={point.r + 3.5}
                  stroke="currentColor"
                  strokeWidth={1.5}
                />
              ) : null}
              {point.showSizeLabel ? (
                <text
                  fill="currentColor"
                  fontSize={9.5}
                  fontWeight={600}
                  pointerEvents="none"
                  textAnchor="middle"
                  x={point.cx}
                  y={point.cy + 3.2}
                >
                  {Math.round(point.bubble.size)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
};

const PrintsTable = ({
  onSelect,
  rows,
  selectedKey,
  symbol,
}: Readonly<{
  onSelect: (key: string) => void;
  rows: readonly TradeBubbleTableRow[];
  selectedKey: string | null;
  symbol: string;
}>) => {
  if (rows.length === 0) return null;
  return (
    <Table
      className="text-sm"
      containerClassName="max-h-72 max-w-full overflow-auto"
      containerProps={{
        "aria-label": `Largest deep futures prints for ${symbol}`,
        role: "region",
        tabIndex: 0,
      }}
    >
      <TableCaption className="sr-only">
        Largest deep futures trades of {symbol} in this window
      </TableCaption>
      <TableHeader>
        <TableRow>
          {TRADE_BUBBLES_TABLE_HEADERS.map((header, index) => (
            <TableHead
              className={index >= 2 && index <= 4 ? "text-right" : undefined}
              key={header}
              scope="col"
            >
              {header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const selected = row.key === selectedKey;
          return (
            <TableRow
              className={selected ? "bg-muted/70" : "hover:bg-muted/40"}
              key={row.key}
            >
              <TableCell className="p-0">
                <button
                  aria-pressed={selected}
                  className="inline-flex min-h-11 w-full items-center px-3 text-left font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-flow-trade-bubble-row={row.side}
                  onClick={() => onSelect(row.key)}
                  type="button"
                >
                  {row.timeLabel}
                </button>
              </TableCell>
              <TableCell>
                <StatusBadge
                  status={row.side === "buy" ? "success" : "destructive"}
                >
                  {row.sideLabel}
                </StatusBadge>
              </TableCell>
              <TableCell className="text-right font-mono">
                {row.contractsLabel}
              </TableCell>
              <TableCell className="text-right font-mono text-muted-foreground">
                {row.multipleLabel}
              </TableCell>
              <TableCell className="text-right font-mono">
                {row.priceLabel}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {row.signingLabel}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {row.captureLabel}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};

const TradeBubblesDocument = ({
  document,
  gex,
}: Readonly<{ document: FlowTradeBubbles; gex: FlowGex | null }>) => {
  const titleId = useId();
  const [sideFilter, setSideFilter] = useState<TradeBubblesSideFilter>("all");
  const [sizeFilter, setSizeFilter] = useState<TradeBubblesSizeFilter>("all");
  const [showGammaLevels, setShowGammaLevels] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const filteredBubbles = useMemo(
    () => filterTradeBubbles(document.bubbles, sideFilter, sizeFilter),
    [document, sideFilter, sizeFilter]
  );

  const plot = useMemo(
    () => buildTradeBubblesPlot(document, filteredBubbles),
    [document, filteredBubbles]
  );

  const gammaOverlay = useMemo(
    () =>
      plot === null
        ? null
        : buildFlowPriceOverlayLevels({
            chartHeight: plot.chartHeight,
            chartY: plot.chartY,
            gex,
            priceMax: plot.priceMax,
            priceMin: plot.priceMin,
            referencePrice: document.candles.at(-1)?.close ?? null,
            symbol: document.symbol,
          }),
    [document, gex, plot]
  );

  const filtersActive = sideFilter !== "all" || sizeFilter !== "all";
  const summary = useMemo(
    () => summarizeTradeBubbles(document, filteredBubbles, filtersActive),
    [document, filteredBubbles, filtersActive]
  );

  const tableRows = useMemo(
    () => tradeBubblesTableRows(filteredBubbles),
    [filteredBubbles]
  );

  const selectedPoint: TradeBubblePlotPoint | null =
    plot?.bubbles.find((point) => point.key === selectedKey) ?? null;
  const activeKey = selectedPoint?.key ?? null;
  const selectedBubble = selectedPoint?.bubble ?? null;

  const tapeBadge = tradeBubblesTapeBadge(document.tape);
  const captureBadge = tradeBubblesCaptureBadge(document.captureMode);

  const handleChartKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    chronologicalKeys: readonly string[]
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setSelectedKey(null);
      return;
    }
    const direction =
      event.key === "ArrowRight"
        ? "next"
        : event.key === "ArrowLeft"
          ? "prev"
          : event.key === "Home"
            ? "first"
            : event.key === "End"
              ? "last"
              : null;
    if (direction === null) return;
    event.preventDefault();
    setSelectedKey(
      moveBubbleSelection(chronologicalKeys, activeKey, direction)
    );
  };

  return (
    <div className="space-y-4">
      {/* Status badges & filter toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={tapeBadge.tone}>{tapeBadge.label}</StatusBadge>
          <StatusBadge status={captureBadge.tone}>
            {captureBadge.label}
          </StatusBadge>
          <span className="text-muted-foreground text-xs">
            Window end: {formatNyDateTime(document.windowEnd)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            aria-label="Filter bubbles by trade side"
            className="flex flex-wrap items-center gap-1"
            role="group"
          >
            {TRADE_BUBBLES_SIDE_FILTERS.map((option) => (
              <button
                aria-pressed={sideFilter === option}
                className={filterButtonClass(sideFilter === option)}
                data-flow-trade-bubbles-side={option}
                key={option}
                onClick={() => setSideFilter(option)}
                type="button"
              >
                {SIDE_FILTER_LABEL[option]}
              </button>
            ))}
          </div>
          <div
            aria-label="Filter bubbles by size multiple"
            className="flex flex-wrap items-center gap-1"
            role="group"
          >
            {TRADE_BUBBLES_SIZE_FILTERS.map((option) => (
              <button
                aria-pressed={sizeFilter === option}
                className={filterButtonClass(sizeFilter === option)}
                data-flow-trade-bubbles-size={option}
                key={option}
                onClick={() => setSizeFilter(option)}
                type="button"
              >
                {SIZE_FILTER_LABEL[option]}
              </button>
            ))}
          </div>
          {gammaOverlay === null ? null : (
            <button
              aria-pressed={showGammaLevels}
              className={filterButtonClass(showGammaLevels)}
              data-flow-trade-bubbles-gamma-toggle=""
              onClick={() => setShowGammaLevels((prev) => !prev)}
              type="button"
            >
              Gamma levels
            </button>
          )}
        </div>
      </div>

      {/* Summary stat strip */}
      <dl
        className="grid grid-cols-2 gap-3 rounded-md border border-border bg-muted/20 p-3 sm:grid-cols-4"
        data-flow-trade-bubbles-summary=""
      >
        <div>
          <dt className="text-muted-foreground text-xs">Shown prints</dt>
          <dd className="font-medium font-mono text-sm">
            {summary.shownLabel}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">
            Buy / Sell contracts
          </dt>
          <dd className="font-medium font-mono text-sm">
            <span className="text-success">{summary.buyContracts}</span>
            {" / "}
            <span className="text-destructive">{summary.sellContracts}</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Net deep contracts</dt>
          <dd
            className={`font-medium font-mono text-sm ${toneTextClass(summary.netTone)}`}
          >
            {summary.netContracts}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Largest print</dt>
          <dd className="font-medium font-mono text-sm">
            {summary.largestPrint}
          </dd>
        </div>
      </dl>

      {document.totals.truncated ? (
        <p
          className="text-muted-foreground text-xs"
          data-flow-trade-bubbles-truncated=""
        >
          {filtersActive
            ? `Showing filtered prints from the largest ${formatCount(document.totals.shownTrades)} of ${formatCount(document.totals.totalTrades)} stored deep trades in this window (filtered totals cover only the returned top ${formatCount(document.totals.shownTrades)} prints).`
            : `Showing the largest ${formatCount(document.totals.shownTrades)} of ${formatCount(document.totals.totalTrades)} stored deep trades in this window (totals cover all stored prints).`}
        </p>
      ) : null}

      {/* Chart or empty state */}
      {plot === null ? (
        <p
          className="rounded-md border border-border border-dashed p-4 text-muted-foreground text-sm"
          data-flow-trade-bubbles-empty=""
        >
          {TRADE_BUBBLES_EMPTY}
        </p>
      ) : (
        <figure className="space-y-2">
          <figcaption
            className="sr-only"
            data-flow-trade-bubbles-caption=""
            id={titleId}
          >
            {`${document.symbol} 1-minute price chart with ${plot.bubbles.length} deep futures trade bubbles. Use Left and Right arrow keys to step through prints.`}
          </figcaption>
          <BubbleChartSvg
            gammaLines={
              showGammaLevels ? (gammaOverlay?.visibleLines ?? []) : []
            }
            onKeyDown={(event) =>
              handleChartKeyDown(event, plot.chronologicalKeys)
            }
            onSelect={setSelectedKey}
            plot={plot}
            selectedPoint={selectedPoint}
            symbol={document.symbol}
            titleId={titleId}
          />
          {showGammaLevels && gammaOverlay !== null ? (
            <FlowGammaLevelsStrip levels={gammaOverlay} />
          ) : null}

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground text-xs">
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-3 rounded-full border-2 border-success bg-success/30"
              />
              Buy bubble (solid ring)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-3 rounded-full border-2 border-destructive border-dashed bg-destructive/30"
              />
              Sell bubble (dashed ring)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block w-4 border-info border-t-2 border-dashed"
              />
              1m VWAP
            </span>
            <span>Area ∝ contracts</span>
          </div>

          {/* Pinned bubble inspector */}
          <div
            aria-live="polite"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs"
            data-flow-trade-bubbles-inspector=""
          >
            {selectedBubble === null ? (
              <span className="text-muted-foreground">
                {filteredBubbles.length === 0
                  ? "No deep prints match the active filters in this window."
                  : "Click any bubble or table row, or focus the chart and press Left/Right arrow keys to inspect a print."}
              </span>
            ) : (
              <>
                <span className="font-mono text-foreground">
                  {describeTradeBubble(selectedBubble)}
                </span>
                <button
                  className="min-h-11 rounded border border-border px-2.5 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-flow-trade-bubbles-clear=""
                  onClick={() => setSelectedKey(null)}
                  type="button"
                >
                  Clear selection
                </button>
              </>
            )}
          </div>
        </figure>
      )}

      {/* Top deep prints table */}
      <PrintsTable
        onSelect={setSelectedKey}
        rows={tableRows}
        selectedKey={activeKey}
        symbol={document.symbol}
      />
    </div>
  );
};

export const FlowTradeBubblesPanel = ({
  document,
  failure,
  gex = null,
  refreshMs,
  symbol,
}: FlowTradeBubblesPanelProps) => {
  const futureSymbol = tapeSymbolOf(symbol);
  const title = tradeBubblesTitle(symbol, futureSymbol);
  const activeDocument =
    document !== null && document.symbol === futureSymbol ? document : null;

  return (
    <Panel
      data-flow-trade-bubbles=""
      description={
        activeDocument === null
          ? `Deep futures trades on the ${futureSymbol} 1-minute price chart (stored IBKR streamed tape).`
          : tradeBubblesRuleLine(activeDocument)
      }
      title={title}
    >
      {failure === null ? null : (
        <p
          className="mb-3 text-sm"
          data-flow-trade-bubbles-error=""
          role="alert"
        >
          {activeDocument === null
            ? `${loadFailedLabel(failure.failedAt)} · Big futures trades not loaded: ${failure.message} · retrying every ${Math.round(refreshMs / 1000)} s`
            : `${loadFailedLabel(failure.failedAt)} · Refresh failed: ${failure.message} · showing data as of ${formatNyDateTime(activeDocument.windowEnd)} · retrying every ${Math.round(refreshMs / 1000)} s`}
        </p>
      )}

      {activeDocument === null ? (
        failure === null ? (
          <p
            className="text-muted-foreground text-sm"
            data-flow-trade-bubbles-loading=""
          >
            {TRADE_BUBBLES_LOADING}
          </p>
        ) : null
      ) : (
        <TradeBubblesDocument
          document={activeDocument}
          gex={symbol === futureSymbol ? gex : null}
          key={activeDocument.symbol}
        />
      )}
    </Panel>
  );
};
