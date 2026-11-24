// What: Option print bubbles panel on /flow (flow.optionBubbles, flow-option-bubbles.v1):
// intraday underlying price path with big option prints overlaid as proportional bubbles
// (size = sqrt premium, colour = call/put + C/P glyph, side = filled ask / hollow bid / dashed mid),
// minimum premium floor selector, client-side right and side filters, open collector gap shading,
// keyboard navigation, pinned bubble inspector strip, and synced accessible top-prints table.
// Research only: option print bubbles describe stored trades, never a trade signal.
// Used by: apps/web/src/components/portal/flow-workspace.tsx.
// See: apps/web/src/features/flow/option-bubbles-view-model.ts;
// docs/vertex-rebuild/designs/vertex-viz-option-bubbles/design.md.
"use client";

import type {
  FlowOptionBubbles,
  FlowOptionBubblesItem,
  FlowOptionBubblesMinPremiumUsd,
  FlowOptionBubblesSymbol,
} from "@darkfactory/api";
import {
  Button,
  Panel,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";

import {
  formatCount,
  formatEtSeconds,
  formatMoney,
  formatPrice,
} from "../../features/flow/format.ts";
import {
  buildOptionBubblesPlot,
  describeSelectedBubble,
  filterOptionBubbles,
  type FlowOptionBubblesFailure,
  formatThresholdLabel,
  nextBubbleKeyTarget,
  OPTION_BUBBLES_CONSOLIDATION_LABELS,
  OPTION_BUBBLES_LOADING,
  OPTION_BUBBLES_MIN_PREMIUM_OPTIONS,
  OPTION_BUBBLES_SIDE_LABELS,
  type OptionBubblesPlot,
  type OptionBubblesPlotBubble,
  type OptionBubblesRightFilter,
  type OptionBubblesSideFilter,
  optionBubblesChartAriaLabel,
  optionBubblesDisclosureLine,
  optionBubblesEmptyLine,
  optionBubblesFailureLine,
  optionBubblesHeaderLine,
  optionBubblesNoMatchesLine,
  optionBubblesRuleText,
  optionBubblesTitle,
  sortOptionBubblesForTable,
  optionBubblesTotalsLine,
} from "../../features/flow/option-bubbles-view-model.ts";

export type FlowOptionBubblesPanelProps = Readonly<{
  symbol: FlowOptionBubblesSymbol;
  minPremiumUsd: FlowOptionBubblesMinPremiumUsd;
  document: FlowOptionBubbles | null;
  failure: FlowOptionBubblesFailure | null;
  pending: boolean;
  refreshMs: number;
  onMinPremiumChange: (next: FlowOptionBubblesMinPremiumUsd) => void;
  onRetry: () => void;
}>;

const TABLE_COLLAPSED_LIMIT = 12;

const RIGHT_FILTER_OPTIONS: readonly Readonly<{
  value: OptionBubblesRightFilter;
  label: string;
}>[] = [
  { label: "All", value: "all" },
  { label: "Calls", value: "call" },
  { label: "Puts", value: "put" },
];

const SIDE_FILTER_OPTIONS: readonly Readonly<{
  value: OptionBubblesSideFilter;
  label: string;
}>[] = [
  { label: "All sides", value: "all" },
  { label: "Ask-side", value: "ask" },
  { label: "Bid-side", value: "bid" },
];

const ThresholdSelector = ({
  minPremiumUsd,
  onMinPremiumChange,
}: Readonly<{
  minPremiumUsd: FlowOptionBubblesMinPremiumUsd;
  onMinPremiumChange: (next: FlowOptionBubblesMinPremiumUsd) => void;
}>) => (
  <fieldset className="inline-flex flex-wrap gap-1 rounded-md border border-border p-0.5">
    <legend className="sr-only">Minimum print premium floor</legend>
    {OPTION_BUBBLES_MIN_PREMIUM_OPTIONS.map((option) => (
      <Button
        aria-pressed={option === minPremiumUsd}
        data-flow-option-bubbles-floor={String(option)}
        key={option}
        onClick={() => {
          if (option !== minPremiumUsd) onMinPremiumChange(option);
        }}
        size="sm"
        variant={option === minPremiumUsd ? "secondary" : "ghost"}
      >
        {formatThresholdLabel(option)}
      </Button>
    ))}
  </fieldset>
);

const BubblesLegend = ({ plot }: Readonly<{ plot: OptionBubblesPlot }>) => (
  <ul
    aria-label="Option print bubbles legend"
    className="flex flex-wrap items-center gap-x-4 gap-y-2 text-muted-foreground text-xs"
    data-flow-option-bubbles-legend=""
  >
    <li className="inline-flex items-center gap-1.5">
      <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
        <circle
          cx="7"
          cy="7"
          fill="var(--color-success)"
          fillOpacity={0.74}
          r="5.5"
          stroke="var(--color-success)"
          strokeWidth="1.5"
        />
      </svg>
      <span>Call (C)</span>
    </li>
    <li className="inline-flex items-center gap-1.5">
      <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
        <circle
          cx="7"
          cy="7"
          fill="var(--color-destructive)"
          fillOpacity={0.74}
          r="5.5"
          stroke="var(--color-destructive)"
          strokeWidth="1.5"
        />
      </svg>
      <span>Put (P)</span>
    </li>
    <li className="inline-flex items-center gap-1.5">
      <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
        <circle
          cx="7"
          cy="7"
          fill="currentColor"
          fillOpacity={0.72}
          r="5.5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
      <span>Ask / Above ask</span>
    </li>
    <li className="inline-flex items-center gap-1.5">
      <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
        <circle
          cx="7"
          cy="7"
          fill="currentColor"
          fillOpacity={0.14}
          r="5"
          stroke="currentColor"
          strokeWidth="2.2"
        />
      </svg>
      <span>Bid / Below bid</span>
    </li>
    <li className="inline-flex items-center gap-1.5">
      <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
        <circle
          cx="7"
          cy="7"
          fill="currentColor"
          fillOpacity={0.18}
          r="5"
          stroke="currentColor"
          strokeDasharray="3 2"
          strokeWidth="1.6"
        />
      </svg>
      <span>Mid / Side not classified</span>
    </li>
    <li className="inline-flex items-center gap-1.5">
      <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
        <circle
          cx="8"
          cy="8"
          fill="none"
          r="7"
          stroke="currentColor"
          strokeOpacity={0.5}
          strokeWidth="1.2"
        />
        <circle cx="8" cy="8" fill="currentColor" fillOpacity={0.72} r="4.5" />
      </svg>
      <span>Above ask / Golden sweep</span>
    </li>
    <li className="inline-flex items-center gap-2">
      <span>Size</span>
      {plot.sizeLegend.map((stop) => {
        const displayR = Math.max(3.5, Math.min(9, stop.r * 0.42));
        const box = Math.ceil(displayR * 2 + 2);
        const center = box / 2;
        return (
          <span
            className="inline-flex items-center gap-1 tabular-nums"
            key={stop.premium}
          >
            <svg
              aria-hidden="true"
              height={box}
              viewBox={`0 0 ${box} ${box}`}
              width={box}
            >
              <circle
                cx={center}
                cy={center}
                fill="none"
                r={displayR}
                stroke="currentColor"
                strokeOpacity={0.75}
                strokeWidth="1.2"
              />
            </svg>
            <span>{stop.label}</span>
          </span>
        );
      })}
    </li>
    {plot.gapRects.length === 0 ? null : (
      <li className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block size-3 rounded-xs border border-border bg-current opacity-15"
        />
        <span>Unread collector gap</span>
      </li>
    )}
  </ul>
);

const BubbleShape = ({
  item,
  selected,
  registerRef,
  onSelect,
  onKeyDown,
}: Readonly<{
  item: OptionBubblesPlotBubble;
  selected: boolean;
  registerRef: (id: string, node: SVGGElement | null) => void;
  onSelect: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<SVGGElement>, id: string) => void;
}>) => {
  const color =
    item.bubble.right === "call"
      ? "var(--color-success)"
      : "var(--color-destructive)";
  const fillOpacity =
    item.sideStyle === "filled"
      ? 0.72
      : item.sideStyle === "hollow"
        ? 0.14
        : 0.2;
  const strokeWidth =
    item.sideStyle === "hollow"
      ? 2.25
      : item.sideStyle === "dashed"
        ? 1.75
        : 1.5;
  const strokeDasharray = item.sideStyle === "dashed" ? "3 2" : undefined;

  return (
    <g
      aria-label={item.ariaLabel}
      aria-pressed={selected}
      className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      data-flow-option-bubble={item.bubble.id}
      data-flow-option-bubble-right={item.bubble.right}
      data-flow-option-bubble-side={item.sideStyle}
      onClick={() => onSelect(item.bubble.id)}
      onKeyDown={(event) => onKeyDown(event, item.bubble.id)}
      ref={(node) => registerRef(item.bubble.id, node)}
      role="button"
      tabIndex={0}
    >
      <title>{item.ariaLabel}</title>
      {item.halo ? (
        <circle
          cx={item.cx}
          cy={item.cy}
          fill="none"
          r={item.r + 3.5}
          stroke={color}
          strokeOpacity={0.45}
          strokeWidth={1.3}
        />
      ) : null}
      {selected ? (
        <circle
          cx={item.cx}
          cy={item.cy}
          data-flow-option-bubble-ring=""
          fill="none"
          r={item.r + 4.5}
          stroke="var(--color-warning)"
          strokeWidth={2}
        />
      ) : null}
      <circle
        cx={item.cx}
        cy={item.cy}
        fill={color}
        fillOpacity={fillOpacity}
        r={item.r}
        stroke={color}
        strokeDasharray={strokeDasharray}
        strokeWidth={strokeWidth}
      />
      {item.glyph === null ? null : (
        <text
          dominantBaseline="central"
          fill={
            item.sideStyle === "filled"
              ? "var(--color-background)"
              : "currentColor"
          }
          fontSize={item.r >= 15 ? 11 : 9}
          fontWeight={700}
          pointerEvents="none"
          textAnchor="middle"
          x={item.cx}
          y={item.cy}
        >
          {item.glyph}
        </text>
      )}
    </g>
  );
};

const BubbleInspector = ({
  bubble,
  ticker,
  onClear,
}: Readonly<{
  bubble: FlowOptionBubblesItem | null;
  ticker: string;
  onClear: () => void;
}>) => {
  const readout =
    bubble === null ? null : describeSelectedBubble(bubble, ticker);
  return (
    <div aria-live="polite">
      {readout === null ? null : (
        <div
          className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs"
          data-flow-option-bubbles-inspector=""
        >
          <div className="space-y-1">
            <p className="font-medium font-mono text-foreground">
              {readout.headline}
            </p>
            <p className="text-foreground tabular-nums">
              {readout.executionLine}
            </p>
            <p className="text-muted-foreground tabular-nums">
              {readout.contextLine}
            </p>
            {readout.flags.length === 0 ? null : (
              <p className="text-muted-foreground">
                Flags: {readout.flags.join(" · ")}
              </p>
            )}
          </div>
          <Button
            data-flow-option-bubbles-clear=""
            onClick={onClear}
            size="sm"
            variant="ghost"
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
};

const BubblesSvgChart = ({
  plot,
  response,
  selectedId,
  onToggleSelect,
  onFocusSelect,
  onClear,
}: Readonly<{
  plot: OptionBubblesPlot;
  response: FlowOptionBubbles;
  selectedId: string | null;
  onToggleSelect: (id: string) => void;
  onFocusSelect: (id: string) => void;
  onClear: () => void;
}>) => {
  const bubbleRefs = useRef<Map<string, SVGGElement>>(new Map());

  const registerRef = (id: string, node: SVGGElement | null): void => {
    if (node === null) bubbleRefs.current.delete(id);
    else bubbleRefs.current.set(id, node);
  };

  const handleBubbleKeyDown = (
    event: KeyboardEvent<SVGGElement>,
    bubbleId: string
  ): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggleSelect(bubbleId);
      return;
    }
    const ids = plot.chronologicalBubbles.map((item) => item.bubble.id);
    const target = nextBubbleKeyTarget(ids, bubbleId, event.key);
    if (target === "clear") {
      event.preventDefault();
      onClear();
    } else if (target !== undefined) {
      event.preventDefault();
      onFocusSelect(target);
      bubbleRefs.current.get(target)?.focus();
    }
  };

  return (
    <figure className="space-y-2">
      <div className="w-full overflow-x-auto rounded-md border border-border bg-background">
        <svg
          aria-label={optionBubblesChartAriaLabel(
            response,
            plot.chronologicalBubbles.length
          )}
          className="block h-auto w-full min-w-[320px]"
          data-flow-option-bubbles-chart=""
          role="group"
          viewBox={`0 0 ${plot.width} ${plot.height}`}
        >
          {/* Horizontal price gridlines and Y-axis ticks */}
          {plot.priceTicks.map((tick) => (
            <g key={tick.label}>
              <line
                stroke="currentColor"
                strokeDasharray="2 3"
                strokeOpacity={0.14}
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
                x={plot.chartX - 8}
                y={tick.y}
              >
                {tick.label}
              </text>
            </g>
          ))}

          {/* Open collector gap shading */}
          {plot.gapRects.map((gap) => (
            <rect
              data-flow-option-bubbles-gap=""
              fill="currentColor"
              fillOpacity={0.08}
              height={plot.chartHeight}
              key={`${gap.startLabel}-${gap.endLabel}-${gap.x}`}
              stroke="currentColor"
              strokeDasharray="3 3"
              strokeOpacity={0.22}
              width={gap.width}
              x={gap.x}
              y={plot.chartY}
            >
              <title>{`Unread collector gap ${gap.startLabel}–${gap.endLabel} ET`}</title>
            </rect>
          ))}

          {/* Latest spot reference line */}
          {plot.latestSpot === null ? null : (
            <g data-flow-option-bubbles-spot="">
              <line
                stroke="var(--color-warning)"
                strokeDasharray="4 4"
                strokeOpacity={0.65}
                strokeWidth={1.2}
                x1={plot.chartX}
                x2={plot.chartX + plot.chartWidth}
                y1={plot.latestSpot.y}
                y2={plot.latestSpot.y}
              />
              <text
                dominantBaseline="auto"
                fill="var(--color-warning)"
                fontSize={10}
                fontWeight={600}
                textAnchor="end"
                x={plot.chartX + plot.chartWidth - 4}
                y={Math.max(plot.chartY + 11, plot.latestSpot.y - 4)}
              >
                {`${response.ticker} ${plot.latestSpot.label}`}
              </text>
            </g>
          )}

          {/* Intraday underlying price line */}
          {plot.priceSegments.map((points, index) => (
            <polyline
              data-flow-option-bubbles-price=""
              fill="none"
              key={`seg-${index}`}
              points={points}
              stroke="currentColor"
              strokeLinejoin="round"
              strokeOpacity={0.85}
              strokeWidth={1.75}
            />
          ))}
          {plot.priceDots.map((dot, index) => (
            <circle
              cx={dot.x}
              cy={dot.y}
              data-flow-option-bubbles-price-dot=""
              fill="currentColor"
              fillOpacity={0.85}
              key={`dot-${index}`}
              r={2}
            />
          ))}

          {/* Big option print bubbles (largest drawn first so smaller stay clickable) */}
          {plot.drawBubbles.map((item) => (
            <BubbleShape
              item={item}
              key={item.bubble.id}
              onKeyDown={handleBubbleKeyDown}
              onSelect={onToggleSelect}
              registerRef={registerRef}
              selected={item.bubble.id === selectedId}
            />
          ))}

          {/* Bottom X-axis time ticks */}
          {plot.timeTicks.map((tick, index) => (
            <text
              dominantBaseline="hanging"
              fill="currentColor"
              fillOpacity={0.72}
              fontSize={10}
              key={`${tick.label}-${tick.x}`}
              textAnchor={
                index === plot.timeTicks.length - 1 ? "end" : "middle"
              }
              x={tick.x}
              y={plot.chartY + plot.chartHeight + 10}
            >
              {tick.label}
            </text>
          ))}
        </svg>
      </div>
    </figure>
  );
};

const TopPrintsTable = ({
  bubbles,
  ticker,
  selectedId,
  showAll,
  onSelect,
  onToggleShowAll,
}: Readonly<{
  bubbles: readonly FlowOptionBubblesItem[];
  ticker: string;
  selectedId: string | null;
  showAll: boolean;
  onSelect: (id: string) => void;
  onToggleShowAll: () => void;
}>) => {
  if (bubbles.length === 0) return null;
  const visible = showAll ? bubbles : bubbles.slice(0, TABLE_COLLAPSED_LIMIT);
  return (
    <div className="space-y-2" data-flow-option-bubbles-table="">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-sm">
          Largest matching prints ({bubbles.length})
        </h3>
        {bubbles.length > TABLE_COLLAPSED_LIMIT ? (
          <Button
            data-flow-option-bubbles-toggle-rows=""
            onClick={onToggleShowAll}
            size="sm"
            variant="ghost"
          >
            {showAll
              ? `Show top ${TABLE_COLLAPSED_LIMIT}`
              : `Show all ${bubbles.length} prints`}
          </Button>
        ) : null}
      </div>
      <TableScroll label="Big option prints table">
        <Table className="text-xs">
          <TableCaption className="sr-only">
            Big option prints matching the active floor and filters
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Time</TableHead>
              <TableHead scope="col">Contract</TableHead>
              <TableHead className="text-right" scope="col">
                Premium
              </TableHead>
              <TableHead className="text-right" scope="col">
                Size
              </TableHead>
              <TableHead scope="col">Side</TableHead>
              <TableHead scope="col">Flow</TableHead>
              <TableHead className="text-right" scope="col">
                {ticker} price
              </TableHead>
              <TableHead scope="col">Type</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((bubble) => {
              const selected = bubble.id === selectedId;
              const tone =
                bubble.directionalSign > 0
                  ? "success"
                  : bubble.directionalSign < 0
                    ? "destructive"
                    : "neutral";
              const signText =
                bubble.directionalSign > 0
                  ? "Bullish"
                  : bubble.directionalSign < 0
                    ? "Bearish"
                    : "Unsigned";
              return (
                <TableRow
                  className={selected ? "bg-muted/60" : undefined}
                  data-flow-option-bubble-row={bubble.id}
                  key={bubble.id}
                >
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatEtSeconds(bubble.at)}
                  </TableCell>
                  <TableHead
                    className="h-auto whitespace-normal font-mono"
                    scope="row"
                  >
                    <button
                      aria-pressed={selected}
                      className="min-h-11 text-left underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      onClick={() => onSelect(bubble.id)}
                      type="button"
                    >
                      {bubble.contract}
                    </button>
                  </TableHead>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatMoney(bubble.premium)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(bubble.size)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {OPTION_BUBBLES_SIDE_LABELS[bubble.side]}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={tone}>{signText}</StatusBadge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {bubble.underlyingPrice === null
                      ? "Price not reported"
                      : formatPrice(bubble.underlyingPrice)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {OPTION_BUBBLES_CONSOLIDATION_LABELS[bubble.consolidation]}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableScroll>
    </div>
  );
};

export const FlowOptionBubblesPanel = ({
  symbol,
  minPremiumUsd,
  document,
  failure,
  pending,
  refreshMs,
  onMinPremiumChange,
  onRetry,
}: FlowOptionBubblesPanelProps) => {
  const [rightFilter, setRightFilter] =
    useState<OptionBubblesRightFilter>("all");
  const [sideFilter, setSideFilter] = useState<OptionBubblesSideFilter>("all");
  const [selectedState, setSelectedState] = useState<
    Readonly<{ scope: string; id: string | null }>
  >({ id: null, scope: "" });
  const [showAllRows, setShowAllRows] = useState(false);

  const scopeKey =
    document === null
      ? ""
      : `${document.symbol}:${document.session ?? ""}:${document.minPremiumUsd}:${rightFilter}:${sideFilter}`;

  const tableBubbles = useMemo(
    () =>
      document === null
        ? []
        : sortOptionBubblesForTable(
            filterOptionBubbles(document.bubbles, rightFilter, sideFilter)
          ),
    [document, rightFilter, sideFilter]
  );

  const plot = useMemo(
    () =>
      document === null
        ? null
        : buildOptionBubblesPlot(document, rightFilter, sideFilter),
    [document, rightFilter, sideFilter]
  );

  const activeSelectedId =
    selectedState.scope === scopeKey ? selectedState.id : null;
  const selectedBubble =
    activeSelectedId === null
      ? null
      : (tableBubbles.find((item) => item.id === activeSelectedId) ?? null);

  const handleToggleSelectBubble = (id: string): void => {
    setSelectedState((prev) => ({
      id: prev.scope === scopeKey && prev.id === id ? null : id,
      scope: scopeKey,
    }));
  };

  const handleFocusSelectBubble = (id: string): void => {
    setSelectedState({ id, scope: scopeKey });
  };

  const handleClearSelection = (): void => {
    setSelectedState({ id: null, scope: scopeKey });
  };
  const disclosure =
    document === null ? null : optionBubblesDisclosureLine(document);

  return (
    <Panel
      actions={
        <ThresholdSelector
          minPremiumUsd={minPremiumUsd}
          onMinPremiumChange={onMinPremiumChange}
        />
      }
      data-flow-option-bubbles={symbol}
      data-flow-option-bubbles-state={
        document === null
          ? failure === null
            ? "loading"
            : "failed"
          : "response"
      }
      description={
        document === null
          ? "Intraday underlying price path with big stored option prints overlaid as bubbles."
          : optionBubblesHeaderLine(document)
      }
      title={optionBubblesTitle(symbol)}
    >
      <div className="space-y-4">
        {failure === null ? null : (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
            data-flow-option-bubbles-error=""
            role="alert"
          >
            <span>
              {optionBubblesFailureLine(
                failure,
                refreshMs,
                document?.minPremiumUsd ?? null,
                minPremiumUsd
              )}
            </span>
            <Button
              data-flow-option-bubbles-retry=""
              onClick={onRetry}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        )}

        {document === null ? (
          pending ? (
            <p
              aria-busy="true"
              className="text-muted-foreground text-sm"
              data-flow-option-bubbles-loading=""
            >
              {OPTION_BUBBLES_LOADING}
            </p>
          ) : null
        ) : document.session === null ? (
          <p
            className="text-muted-foreground text-sm"
            data-flow-option-bubbles-empty=""
          >
            {optionBubblesEmptyLine(symbol)}
          </p>
        ) : (
          <>
            {/* Client-side right and side filters */}
            <div className="flex flex-wrap items-center gap-3">
              <fieldset className="inline-flex gap-1 rounded-md border border-border p-0.5">
                <legend className="sr-only">Filter bubbles by right</legend>
                {RIGHT_FILTER_OPTIONS.map((option) => (
                  <Button
                    aria-pressed={option.value === rightFilter}
                    data-flow-option-bubbles-right-filter={option.value}
                    key={option.value}
                    onClick={() => setRightFilter(option.value)}
                    size="sm"
                    variant={
                      option.value === rightFilter ? "secondary" : "ghost"
                    }
                  >
                    {option.label}
                  </Button>
                ))}
              </fieldset>
              <fieldset className="inline-flex gap-1 rounded-md border border-border p-0.5">
                <legend className="sr-only">
                  Filter bubbles by aggressor side
                </legend>
                {SIDE_FILTER_OPTIONS.map((option) => (
                  <Button
                    aria-pressed={option.value === sideFilter}
                    data-flow-option-bubbles-side-filter={option.value}
                    key={option.value}
                    onClick={() => setSideFilter(option.value)}
                    size="sm"
                    variant={
                      option.value === sideFilter ? "secondary" : "ghost"
                    }
                  >
                    {option.label}
                  </Button>
                ))}
              </fieldset>
            </div>

            {plot === null ? (
              tableBubbles.length === 0 ? (
                <p
                  className="text-muted-foreground text-sm"
                  data-flow-option-bubbles-no-matches=""
                >
                  {optionBubblesNoMatchesLine(
                    document.minPremiumUsd,
                    rightFilter,
                    sideFilter
                  )}
                </p>
              ) : (
                <p
                  className="text-muted-foreground text-sm"
                  data-flow-option-bubbles-unplotted-only=""
                >
                  No intraday underlying price coordinates stored for these
                  prints. Inspect matching prints in the table below.
                </p>
              )
            ) : (
              <>
                <BubblesLegend plot={plot} />
                <BubblesSvgChart
                  onClear={handleClearSelection}
                  onFocusSelect={handleFocusSelectBubble}
                  onToggleSelect={handleToggleSelectBubble}
                  plot={plot}
                  response={document}
                  selectedId={activeSelectedId}
                />
                {tableBubbles.length === 0 ? (
                  <p
                    className="text-muted-foreground text-sm"
                    data-flow-option-bubbles-no-matches=""
                  >
                    {optionBubblesNoMatchesLine(
                      document.minPremiumUsd,
                      rightFilter,
                      sideFilter
                    )}
                  </p>
                ) : null}
              </>
            )}
            <BubbleInspector
              bubble={selectedBubble}
              onClear={handleClearSelection}
              ticker={document.ticker}
            />
            <TopPrintsTable
              bubbles={tableBubbles}
              onSelect={handleToggleSelectBubble}
              onToggleShowAll={() => setShowAllRows((prev) => !prev)}
              selectedId={activeSelectedId}
              showAll={showAllRows}
              ticker={document.ticker}
            />

            <p
              className="text-muted-foreground text-xs tabular-nums"
              data-flow-option-bubbles-totals=""
            >
              {optionBubblesTotalsLine(document)}
            </p>
            {disclosure === null ? null : (
              <p
                className="text-muted-foreground text-xs"
                data-flow-option-bubbles-disclosure=""
              >
                {disclosure}
              </p>
            )}
            <p
              className="text-muted-foreground text-xs"
              data-flow-option-bubbles-rules=""
            >
              {optionBubblesRuleText(document.rules)}
            </p>
          </>
        )}
      </div>
    </Panel>
  );
};
