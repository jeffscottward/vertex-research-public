// What: Off-exchange (dark pool) print levels panel on /flow (flow.offExchangeLevels,
// flow-off-exchange-levels.v1): price & VWAP chart with clustered FINRA TRF horizontal print
// levels, right-rail notional bars, individual print dots, sampled off-exchange volume share
// sub-panel, interactive level table + print inspector, and FINRA weekly OTC context strip.
// It has its own loading and failure state, so a fault of its call changes no other panel.
// Research only: describes stored FINRA TRF prints and lagged FINRA weekly OTC reports; never a
// trade signal or order input.
// Used by: apps/web/src/components/portal/flow-workspace.tsx.
// See: apps/web/src/features/flow/off-exchange-levels-view-model.ts;
// docs/vertex-rebuild/designs/vertex-viz-offexchange-levels/design.md.
"use client";

import type {
  FlowDirection,
  FlowOffExchangeLevels,
  FlowOffExchangeRange,
  FlowOffExchangeSymbol,
} from "@darkfactory/api";
import {
  Button,
  Panel,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import { type KeyboardEvent, useRef, useState } from "react";
import {
  buildOffExchangeFinraSummary,
  buildOffExchangeLevelRows,
  buildOffExchangePlot,
  type FlowOffExchangeLevelsFailure,
  nextOffExchangeLevelIndex,
  OFF_EXCHANGE_CHART,
  OFF_EXCHANGE_LOADING,
  OFF_EXCHANGE_NO_FINRA,
  OFF_EXCHANGE_RANGE_OPTIONS,
  type OffExchangeFinraSummary,
  type OffExchangeLevelRowView,
  type OffExchangePlot,
  offExchangeAriaLabel,
  offExchangeEmptyLine,
  offExchangeFailureLine,
  offExchangeHeaderLine,
  offExchangeOmittedLine,
  offExchangeRuleText,
  offExchangeTitle,
  offExchangeTotalsLine,
} from "../../features/flow/off-exchange-levels-view-model.ts";

export type FlowOffExchangeLevelsPanelProps = Readonly<{
  symbol: FlowOffExchangeSymbol;
  range: FlowOffExchangeRange;
  document: FlowOffExchangeLevels | null;
  failure: FlowOffExchangeLevelsFailure | null;
  pending: boolean;
  refreshMs: number;
  onRangeChange: (next: FlowOffExchangeRange) => void;
  onRetry: () => void;
}>;

const DIRECTION_STROKE: Readonly<Record<FlowDirection, string>> = {
  bearish: "var(--color-destructive)",
  bullish: "var(--color-success)",
  neutral: "var(--color-warning)",
};

const DIRECTION_DASH: Readonly<Record<FlowDirection, string | undefined>> = {
  bearish: "8 4",
  bullish: undefined,
  neutral: "3 3",
};

const DIRECTION_TEXT_CLASS: Readonly<Record<FlowDirection, string>> = {
  bearish: "text-destructive",
  bullish: "text-success",
  neutral: "text-muted-foreground",
};

const DIRECTION_BADGE: Readonly<Record<FlowDirection, string>> = {
  bearish: "Sell-skewed",
  bullish: "Buy-skewed",
  neutral: "Mixed",
};

const RangeSelector = ({
  range,
  onRangeChange,
}: Readonly<{
  range: FlowOffExchangeRange;
  onRangeChange: (next: FlowOffExchangeRange) => void;
}>) => (
  <fieldset className="inline-flex gap-1 rounded-md border border-border p-0.5">
    <legend className="sr-only">Off-exchange levels window</legend>
    {OFF_EXCHANGE_RANGE_OPTIONS.map((option) => (
      <Button
        aria-pressed={option.value === range}
        data-flow-off-exchange-range={option.value}
        key={option.value}
        onClick={() => {
          if (option.value !== range) onRangeChange(option.value);
        }}
        size="sm"
        type="button"
        variant={option.value === range ? "secondary" : "ghost"}
      >
        {option.label}
      </Button>
    ))}
  </fieldset>
);

const ChartLegend = () => (
  <ul
    aria-label="Off-exchange chart legend"
    className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground text-xs"
  >
    <li className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-0.5 w-4 bg-foreground"
      />
      Price
    </li>
    <li className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block w-4 border-info border-t-2 border-dashed"
      />
      VWAP
    </li>
    <li className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="inline-block h-0.5 w-4 bg-success" />
      Buy-skewed level
    </li>
    <li className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block w-4 border-destructive border-t-2 border-dashed"
      />
      Sell-skewed level
    </li>
    <li className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block w-4 border-warning border-t-2 border-dotted"
      />
      Mixed level / Spot
    </li>
    <li className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-3 rounded-xs bg-info/55"
      />
      Sampled TRF %
    </li>
  </ul>
);

const OffExchangeChartSvg = ({
  plot,
  response,
  selectedIndex,
}: Readonly<{
  plot: OffExchangePlot;
  response: FlowOffExchangeLevels;
  selectedIndex: number | null;
}>) => {
  const {
    plotBottom,
    plotLeft,
    plotRight,
    plotTop,
    priceHeight,
    railLeft,
    shareBottom,
    shareHeight,
    shareTop,
    width,
  } = OFF_EXCHANGE_CHART;

  return (
    <figure className="space-y-2">
      <ChartLegend />
      <div className="space-y-1 overflow-x-auto rounded-md border border-border bg-card/40 p-2">
        <svg
          aria-label={offExchangeAriaLabel(response)}
          className="block h-auto w-full min-w-[600px] text-foreground"
          data-flow-off-exchange-chart=""
          role="img"
          viewBox={`0 0 ${width} ${priceHeight}`}
        >
          {plot.priceGridTicks.map((tick) => (
            <g key={tick.price}>
              <line
                stroke="var(--color-border)"
                strokeOpacity={0.6}
                strokeWidth={1}
                x1={plotLeft}
                x2={plotRight}
                y1={tick.y}
                y2={tick.y}
              />
              <text
                dominantBaseline="middle"
                fill="var(--color-muted-foreground)"
                fontSize={11}
                textAnchor="end"
                x={plotLeft - 8}
                y={tick.y}
              >
                {tick.label}
              </text>
            </g>
          ))}

          {/* Session dividers */}
          {plot.sessionDividers.map((divider) => (
            <line
              key={divider.session}
              stroke="var(--color-border)"
              strokeDasharray="3 4"
              strokeOpacity={0.85}
              strokeWidth={1}
              x1={divider.x}
              x2={divider.x}
              y1={plotTop}
              y2={plotBottom}
            />
          ))}

          {/* Horizontal off-exchange print levels + right-rail notional profile */}
          {plot.levelLines.map((level) => {
            const active = selectedIndex === level.index;
            const dimmed = selectedIndex !== null && !active;
            const color = DIRECTION_STROKE[level.dominantDirection];
            return (
              <g
                data-flow-off-exchange-line={String(level.rank)}
                key={level.rank}
                opacity={dimmed ? 0.35 : 1}
              >
                <title>{level.ariaLabel}</title>
                <rect
                  fillOpacity={active ? 0.2 : 0.08}
                  height={level.bandHeight}
                  width={plotRight - level.startX}
                  x={level.startX}
                  y={level.bandTopY}
                />
                <line
                  stroke={color}
                  strokeDasharray={DIRECTION_DASH[level.dominantDirection]}
                  strokeWidth={
                    active ? level.strokeWidth + 1.2 : level.strokeWidth
                  }
                  x1={level.startX}
                  x2={level.endX}
                  y1={level.y}
                  y2={level.y}
                />
                <rect
                  fill={color}
                  fillOpacity={active ? 0.9 : 0.65}
                  height={Math.max(6, Math.min(12, level.bandHeight))}
                  rx={2}
                  width={level.railBarWidth}
                  x={railLeft}
                  y={level.y - Math.max(3, Math.min(6, level.bandHeight / 2))}
                />
                {level.showRailLabel || active ? (
                  <text
                    dominantBaseline="middle"
                    fill={
                      active ? "currentColor" : "var(--color-muted-foreground)"
                    }
                    fontSize={10}
                    fontWeight={active ? 600 : 400}
                    x={railLeft + 4}
                    y={level.y - 8}
                  >
                    {level.railLabel}
                  </text>
                ) : null}
              </g>
            );
          })}

          {/* VWAP segments */}
          {plot.vwapSegments.map((points, idx) => (
            <polyline
              fill="none"
              key={`vwap-${idx}`}
              points={points}
              stroke="var(--color-info)"
              strokeDasharray="5 3"
              strokeOpacity={0.8}
              strokeWidth={1.5}
            />
          ))}

          {/* Price segments */}
          {plot.priceSegments.map((points, idx) => (
            <polyline
              fill="none"
              key={`price-${idx}`}
              points={points}
              stroke="currentColor"
              strokeLinejoin="round"
              strokeWidth={2}
            />
          ))}

          {/* Latest spot reference line */}
          {plot.spotLine === null ? null : (
            <g data-flow-off-exchange-spot="">
              <line
                stroke="var(--color-warning)"
                strokeDasharray="2 3"
                strokeWidth={1.5}
                x1={plotLeft}
                x2={plotRight}
                y1={plot.spotLine.y}
                y2={plot.spotLine.y}
              />
              <text
                dominantBaseline="middle"
                fill="var(--color-warning)"
                fontSize={10}
                fontWeight={600}
                x={plotLeft + 6}
                y={Math.max(plotTop + 10, plot.spotLine.y - 6)}
              >
                {plot.spotLine.label}
              </text>
            </g>
          )}

          {/* Individual FINRA TRF print dots */}
          {plot.printDots.map((dot) => {
            const active =
              selectedIndex !== null && dot.levelIndex === selectedIndex;
            const dimmed =
              selectedIndex !== null && dot.levelIndex !== selectedIndex;
            return (
              <circle
                cx={dot.x}
                cy={dot.y}
                data-flow-off-exchange-dot={dot.key}
                fill={DIRECTION_STROKE[dot.direction]}
                fillOpacity={dimmed ? 0.25 : 0.85}
                key={dot.key}
                r={active ? dot.radius + 1.5 : dot.radius}
                stroke="var(--color-background)"
                strokeWidth={1.2}
              >
                <title>{dot.ariaLabel}</title>
              </circle>
            );
          })}

          {/* Right rail header */}
          <text
            fill="var(--color-muted-foreground)"
            fontSize={10}
            x={railLeft}
            y={plotTop}
          >
            Notional profile
          </text>

          {/* X-axis ticks */}
          {plot.timeTicks.map((tick) => (
            <text
              fill="var(--color-muted-foreground)"
              fontSize={10}
              key={`${tick.label}-${tick.x}`}
              textAnchor="middle"
              x={tick.x}
              y={plotBottom + 16}
            >
              {tick.label}
            </text>
          ))}
        </svg>

        {/* Off-exchange volume share sub-panel */}
        <svg
          aria-label="Sampled FINRA TRF share of minute volume"
          className="block h-auto w-full min-w-[600px] text-foreground"
          data-flow-off-exchange-share-chart=""
          role="img"
          viewBox={`0 0 ${width} ${shareHeight}`}
        >
          <line
            stroke="var(--color-border)"
            x1={plotLeft}
            x2={plotRight}
            y1={shareTop}
            y2={shareTop}
          />
          <line
            stroke="var(--color-border)"
            strokeDasharray="2 3"
            strokeWidth={1}
            x1={plotLeft}
            x2={plotRight}
            y1={plot.shareMidY}
            y2={plot.shareMidY}
          />
          <line
            stroke="var(--color-border)"
            strokeWidth={1}
            x1={plotLeft}
            x2={plotRight}
            y1={shareBottom}
            y2={shareBottom}
          />
          {plot.sessionDividers.map((divider) => (
            <line
              key={`share-${divider.session}`}
              stroke="var(--color-border)"
              strokeDasharray="3 4"
              strokeOpacity={0.85}
              strokeWidth={1}
              x1={divider.x}
              x2={divider.x}
              y1={shareTop}
              y2={shareBottom}
            />
          ))}
          <text
            dominantBaseline="middle"
            fill="var(--color-muted-foreground)"
            fontSize={10}
            textAnchor="end"
            x={plotLeft - 8}
            y={shareTop + 4}
          >
            TRF 100%
          </text>
          <text
            dominantBaseline="middle"
            fill="var(--color-muted-foreground)"
            fontSize={10}
            textAnchor="end"
            x={plotLeft - 8}
            y={plot.shareMidY}
          >
            50%
          </text>
          {plot.shareBars.map((bar) => (
            <rect
              fill="var(--color-info)"
              fillOpacity={0.55}
              height={bar.height}
              key={bar.key}
              rx={1}
              width={bar.width}
              x={bar.x}
              y={bar.y}
            >
              <title>{`TRF share ${Math.round(bar.share * 100)}%`}</title>
            </rect>
          ))}
        </svg>
      </div>
    </figure>
  );
};

const LevelInspector = ({
  row,
  onClose,
}: Readonly<{
  row: OffExchangeLevelRowView;
  onClose: () => void;
}>) => (
  <div
    className="space-y-3 rounded-md border border-border bg-muted/30 p-3 text-sm"
    data-flow-off-exchange-inspector=""
  >
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="space-y-0.5">
        <p className="font-medium">
          Level #{row.rank} · {row.price} ({row.bandRange}) ·{" "}
          <span className={DIRECTION_TEXT_CLASS[row.dominantDirection]}>
            {DIRECTION_BADGE[row.dominantDirection]}
          </span>
        </p>
        <p className="text-muted-foreground text-xs">
          {row.notional} · {row.shares} shares · {row.prints} prints ·{" "}
          {row.sideMix} · vs spot {row.spotDelta} · {row.firstAt} to{" "}
          {row.lastAt}
        </p>
      </div>
      <Button
        data-flow-off-exchange-inspector-close=""
        onClick={onClose}
        size="sm"
        type="button"
        variant="ghost"
      >
        Clear selection
      </Button>
    </div>
    {row.levelPrints.length === 0 ? (
      <p className="text-muted-foreground text-xs">
        Individual prints for this band were outside the newest print cap; band
        totals still include all prints in range.
      </p>
    ) : (
      <ul className="grid gap-1.5 text-xs sm:grid-cols-2">
        {row.levelPrints.map((print) => (
          <li
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/70 bg-background/60 px-2.5 py-1.5"
            key={print.key}
          >
            <span className="font-mono text-muted-foreground">
              {print.time}
            </span>
            <span className="font-medium">
              {print.shares} @ {print.price} ({print.notional})
            </span>
            <span className={DIRECTION_TEXT_CLASS[print.direction]}>
              {print.direction}
            </span>
          </li>
        ))}
      </ul>
    )}
  </div>
);

const LevelTable = ({
  rows,
  selectedIndex,
  onSelect,
}: Readonly<{
  rows: readonly OffExchangeLevelRowView[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
}>) => {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    idx: number
  ) => {
    const next = nextOffExchangeLevelIndex(event.key, idx, rows.length);
    if (next === undefined) return;
    event.preventDefault();
    onSelect(next);
    if (next !== null) buttonRefs.current[next]?.focus();
  };

  return (
    <TableScroll label="Off-exchange print levels">
      <Table className="text-sm" data-flow-off-exchange-table="">
        <TableCaption className="sr-only">
          Top off-exchange print levels ranked by notional
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Rank</TableHead>
            <TableHead scope="col">Level (band)</TableHead>
            <TableHead className="text-right" scope="col">
              Notional
            </TableHead>
            <TableHead className="text-right" scope="col">
              Shares
            </TableHead>
            <TableHead className="text-right" scope="col">
              Prints
            </TableHead>
            <TableHead scope="col">Bias / mix</TableHead>
            <TableHead className="text-right" scope="col">
              vs Spot
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const active = selectedIndex === row.index;
            return (
              <TableRow
                className={active ? "bg-muted/50" : undefined}
                data-flow-off-exchange-row={String(row.rank)}
                key={row.rank}
              >
                <TableCell className="font-mono text-xs">#{row.rank}</TableCell>
                <TableHead className="h-auto whitespace-normal" scope="row">
                  <button
                    aria-pressed={active}
                    className="inline-flex min-h-11 items-center gap-1.5 text-left font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                    data-flow-off-exchange-level={String(row.rank)}
                    onClick={() => onSelect(active ? null : row.index)}
                    onKeyDown={(event) => handleKeyDown(event, row.index)}
                    ref={(el) => {
                      buttonRefs.current[row.index] = el;
                    }}
                    type="button"
                  >
                    <span>{row.price}</span>
                    <span className="font-normal text-muted-foreground text-xs">
                      ({row.bandRange})
                    </span>
                  </button>
                </TableHead>
                <TableCell className="text-right font-mono">
                  {row.notional}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {row.shares}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {row.prints}
                </TableCell>
                <TableCell>
                  <span
                    className={`font-medium ${DIRECTION_TEXT_CLASS[row.dominantDirection]}`}
                  >
                    {DIRECTION_BADGE[row.dominantDirection]}
                  </span>
                  <span className="ml-1.5 text-muted-foreground text-xs">
                    ({row.sideMix})
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {row.spotDelta}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableScroll>
  );
};

const FinraContextStrip = ({
  summary,
}: Readonly<{ summary: OffExchangeFinraSummary | null }>) => (
  <div
    className="rounded-md border border-border bg-muted/20 p-3"
    data-flow-off-exchange-finra=""
  >
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <h3 className="font-medium text-sm">
          FINRA weekly OTC context (public lagged report)
        </h3>
        {summary === null ? (
          <p className="text-muted-foreground text-xs">
            {OFF_EXCHANGE_NO_FINRA}
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            Week of {summary.latestWeekStart}: {summary.totalShares}{" "}
            off-exchange shares · ATS (dark pools) {summary.atsShares} (
            {summary.atsShare}) · Non-ATS OTC {summary.nonAtsShares} · Avg ATS
            trade {summary.avgAtsTradeSize}
            {summary.latestLastUpdated === null
              ? ""
              : ` · Updated ${summary.latestLastUpdated}`}
          </p>
        )}
      </div>
      {summary === null ? null : (
        <svg
          aria-label={`FINRA weekly OTC shares across ${summary.bars.length} stored weeks`}
          className="h-16 w-full max-w-80 shrink-0 text-foreground"
          role="img"
          viewBox="0 0 320 62"
        >
          {summary.bars.map((bar) => (
            <g key={bar.weekStart}>
              <title>
                {`Week of ${bar.weekStart}: total ${bar.totalShares}, ATS ${bar.atsShares} (${bar.atsShare}), Non-ATS ${bar.nonAtsShares}`}
              </title>
              <rect
                fill="var(--color-muted-foreground)"
                fillOpacity={0.35}
                height={bar.nonAtsHeight}
                rx={1}
                width={bar.width}
                x={bar.x}
                y={bar.nonAtsY}
              />
              <rect
                fill="var(--color-info)"
                fillOpacity={0.8}
                height={bar.atsHeight}
                rx={1}
                width={bar.width}
                x={bar.x}
                y={bar.atsY}
              />
              <text
                fill="var(--color-muted-foreground)"
                fontSize={9}
                textAnchor="middle"
                x={bar.x + bar.width / 2}
                y={58}
              >
                {bar.shortWeek}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  </div>
);

const OffExchangeResponse = ({
  response,
}: Readonly<{ response: FlowOffExchangeLevels }>) => {
  const [selection, setSelection] = useState<Readonly<{
    range: FlowOffExchangeRange;
    index: number;
  }> | null>(null);

  const activeIndex =
    selection !== null &&
    selection.range === response.range &&
    selection.index < response.levels.length
      ? selection.index
      : null;

  const plot = buildOffExchangePlot(response);
  const rows = buildOffExchangeLevelRows(response);
  const finra = buildOffExchangeFinraSummary(response);
  const omitted = offExchangeOmittedLine(response);
  const selectedRow =
    activeIndex === null
      ? null
      : (rows[activeIndex] as OffExchangeLevelRowView);

  const handleSelect = (nextIndex: number | null) => {
    setSelection(
      nextIndex === null ? null : { index: nextIndex, range: response.range }
    );
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-muted-foreground text-xs">
        <p data-flow-off-exchange-header="">
          {offExchangeHeaderLine(response)}
        </p>
        <p data-flow-off-exchange-totals="">
          {offExchangeTotalsLine(response)}
        </p>
        {omitted === null ? null : (
          <p data-flow-off-exchange-omitted="">{omitted}</p>
        )}
      </div>

      {plot === null ? (
        <p
          className="text-muted-foreground text-sm"
          data-flow-off-exchange-empty=""
        >
          {offExchangeEmptyLine(response)}
        </p>
      ) : (
        <OffExchangeChartSvg
          plot={plot}
          response={response}
          selectedIndex={activeIndex}
        />
      )}

      {rows.length === 0 ? (
        plot === null ? null : (
          <p
            className="text-muted-foreground text-sm"
            data-flow-off-exchange-no-prints=""
          >
            {offExchangeEmptyLine(response)}
          </p>
        )
      ) : (
        <div className="space-y-3">
          <LevelTable
            onSelect={handleSelect}
            rows={rows}
            selectedIndex={activeIndex}
          />
          {selectedRow === null ? null : (
            <LevelInspector
              onClose={() => handleSelect(null)}
              row={selectedRow}
            />
          )}
        </div>
      )}

      <FinraContextStrip summary={finra} />

      <p className="text-muted-foreground text-xs">
        {offExchangeRuleText(response)}
      </p>
    </div>
  );
};

export const FlowOffExchangeLevelsPanel = ({
  symbol,
  range,
  document,
  failure,
  pending,
  refreshMs,
  onRangeChange,
  onRetry,
}: FlowOffExchangeLevelsPanelProps) => (
  <Panel data-flow-off-exchange-panel="" title={offExchangeTitle(symbol)}>
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <RangeSelector onRangeChange={onRangeChange} range={range} />
        <div className="flex items-center gap-2">
          {pending ? (
            <span
              aria-live="polite"
              className="text-muted-foreground text-xs"
              data-flow-off-exchange-pending=""
              role="status"
            >
              Updating…
            </span>
          ) : null}
          {failure === null ? null : (
            <Button
              data-flow-off-exchange-retry=""
              onClick={onRetry}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          )}
        </div>
      </div>

      {failure === null ? null : (
        <p
          className="text-destructive text-sm"
          data-flow-off-exchange-error=""
          role="alert"
        >
          {offExchangeFailureLine(failure, document, refreshMs)}
        </p>
      )}

      {document === null ? (
        failure === null ? (
          <p
            className="text-muted-foreground text-sm"
            data-flow-off-exchange-loading=""
          >
            {OFF_EXCHANGE_LOADING}
          </p>
        ) : null
      ) : (
        <OffExchangeResponse response={document} />
      )}
    </div>
  </Panel>
);
