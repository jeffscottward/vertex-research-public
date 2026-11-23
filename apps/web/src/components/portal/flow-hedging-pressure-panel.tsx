// What: the Hedging pressure panel of /flow (flow.hedgingPressure): the running sum of the
// estimated dealer hedge notional of the session's SPY or SPX option prints as stepped net, call
// and put lines with a zero line and the unread gap shade, the underlying price on the same time
// axis, the totals, the counts and the rule text.
// It has its own loading and failure state, so a fault of its call changes no other panel.
// Research only: the line is an estimate of dealer hedging, never a trade signal.
// Used by: apps/web/src/components/portal/flow-workspace.tsx.
// See: apps/web/src/features/flow/hedging-pressure-view-model.ts; docs/vertex-rebuild/flow-pipeline.md.
"use client";

import type { FlowHedgingPressure, FlowHedgingSymbol } from "@darkfactory/api";
import { Panel } from "@darkfactory/ui";

import type { FlowControlFailure } from "../../features/flow/control-view-model.ts";
import {
  buildHedgingChart,
  buildPriceChart,
  HEDGING_LOADING,
  HEDGING_NO_POINTS,
  type HedgingLegendEntry,
  hedgingAriaLabel,
  hedgingCountsLine,
  hedgingEmptyLine,
  hedgingFailureLine,
  hedgingHeaderLine,
  hedgingLargestLine,
  hedgingLegend,
  hedgingPriceAriaLabel,
  hedgingPriceName,
  hedgingRuleText,
  hedgingTitle,
  hedgingTotalsLine,
} from "../../features/flow/hedging-pressure-view-model.ts";

/** A failed flow.hedgingPressure call: the error code and message, and when it failed. */
export type FlowHedgingPressureFailure = FlowControlFailure &
  Readonly<{ failedAt: number }>;

/** Chart units; the SVGs stretch to the width of the panel. */
const CHART_WIDTH = 1000;
const LINE_HEIGHT = 128;
const PRICE_HEIGHT = 64;

/** How each line is drawn: the dash pattern, not only the color, tells the lines apart. */
const LINE_STYLE: Readonly<
  Record<
    Exclude<HedgingLegendEntry["key"], "unread">,
    Readonly<{ stroke: string; width: number; dash: string | undefined }>
  >
> = {
  calls: { dash: "6 3", stroke: "var(--color-info)", width: 1.5 },
  net: { dash: undefined, stroke: "currentColor", width: 2 },
  puts: { dash: "1.5 3", stroke: "var(--color-warning)", width: 1.5 },
};
const UNREAD_OPACITY = 0.1;

const LegendSample = ({ entry }: Readonly<{ entry: HedgingLegendEntry }>) => {
  if (entry.key === "unread")
    return (
      <span
        aria-hidden="true"
        className="block h-3 w-6 shrink-0 rounded-sm border border-border bg-current"
        style={{ opacity: UNREAD_OPACITY * 3 }}
      />
    );
  const style = LINE_STYLE[entry.key];
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      height="12"
      viewBox="0 0 24 12"
      width="24"
    >
      <line
        stroke={style.stroke}
        strokeDasharray={style.dash}
        strokeWidth={style.width}
        x1="0"
        x2="24"
        y1="6"
        y2="6"
      />
    </svg>
  );
};

const HedgingResponse = ({
  response,
  symbol,
}: Readonly<{ response: FlowHedgingPressure; symbol: FlowHedgingSymbol }>) => {
  if (response.session === null)
    return (
      <p className="text-sm" data-flow-hedging-empty="" role="status">
        {hedgingEmptyLine(symbol)}
      </p>
    );
  const chart = buildHedgingChart(response, CHART_WIDTH, LINE_HEIGHT);
  const price = buildPriceChart(response, CHART_WIDTH, PRICE_HEIGHT);
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm" data-flow-hedging-header="">
        {hedgingHeaderLine(response)}
      </p>
      {chart === null || price === null ? (
        <p className="text-sm" data-flow-hedging-no-points="" role="status">
          {HEDGING_NO_POINTS}
        </p>
      ) : (
        <figure className="space-y-2">
          <h3 className="font-medium text-sm">
            Estimated dealer hedge notional (US dollars, running sum)
          </h3>
          <div className="flex gap-2">
            <div
              aria-hidden="true"
              className="relative h-32 w-14 shrink-0 text-right text-muted-foreground text-xs tabular-nums"
            >
              {chart.ticks.map((tick) => (
                <span
                  className="absolute right-0 -translate-y-1/2"
                  data-flow-hedging-tick=""
                  key={tick.value}
                  style={{ top: `${(tick.y / chart.height) * 100}%` }}
                >
                  {tick.label}
                </span>
              ))}
            </div>
            <svg
              aria-label={hedgingAriaLabel(response)}
              className="h-32 w-full min-w-0"
              data-flow-hedging-chart="pressure"
              preserveAspectRatio="none"
              role="img"
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              width="100%"
            >
              {chart.unread === null ? null : (
                <rect
                  data-flow-hedging-unread=""
                  fill="currentColor"
                  fillOpacity={UNREAD_OPACITY}
                  height={chart.height}
                  width={chart.unread.width}
                  x={chart.unread.x}
                  y={0}
                />
              )}
              <line
                data-flow-hedging-zero=""
                stroke="currentColor"
                strokeOpacity={0.35}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                x1={0}
                x2={chart.width}
                y1={chart.zeroY}
                y2={chart.zeroY}
              />
              {(["puts", "calls", "net"] as const).map((key) => (
                <path
                  d={chart[key]}
                  data-flow-hedging-line={key}
                  fill="none"
                  key={key}
                  stroke={LINE_STYLE[key].stroke}
                  strokeDasharray={LINE_STYLE[key].dash}
                  strokeWidth={LINE_STYLE[key].width}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          </div>
          <h3 className="font-medium text-sm">{hedgingPriceName(response)}</h3>
          <div className="flex gap-2">
            <div
              aria-hidden="true"
              className="flex h-16 w-14 shrink-0 flex-col justify-between text-right text-muted-foreground text-xs tabular-nums"
            >
              <span data-flow-hedging-price-high="">{price.highLabel}</span>
              <span data-flow-hedging-price-low="">{price.lowLabel}</span>
            </div>
            <svg
              aria-label={hedgingPriceAriaLabel(response, price)}
              className="h-16 w-full min-w-0"
              data-flow-hedging-chart="price"
              preserveAspectRatio="none"
              role="img"
              viewBox={`0 0 ${price.width} ${price.height}`}
              width="100%"
            >
              {price.path === null ? null : (
                <path
                  d={price.path}
                  data-flow-hedging-line="price"
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity={0.7}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
          </div>
          <div className="flex justify-between pl-16 text-muted-foreground text-xs">
            <span>{chart.startLabel}</span>
            <span>{chart.endLabel}</span>
          </div>
          <figcaption>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
              {hedgingLegend(chart).map((entry) => (
                <li
                  className="flex items-center gap-2"
                  data-flow-hedging-legend={entry.key}
                  key={entry.key}
                >
                  <LegendSample entry={entry} />
                  <span>{entry.text}</span>
                </li>
              ))}
            </ul>
          </figcaption>
        </figure>
      )}
      <div className="space-y-1 text-sm tabular-nums">
        <p data-flow-hedging-totals="">{hedgingTotalsLine(response)}</p>
        <p data-flow-hedging-largest="">{hedgingLargestLine(response)}</p>
        <p className="text-muted-foreground" data-flow-hedging-counts="">
          {hedgingCountsLine(response)}
        </p>
      </div>
      <p className="text-muted-foreground text-xs" data-flow-hedging-rule="">
        {hedgingRuleText(response.rules)}
      </p>
    </div>
  );
};

/**
 * Three states: loading (no response and no failure), failed (the error line; the last response
 * stays below it when one exists) and response.
 */
export const FlowHedgingPressurePanel = ({
  symbol,
  document,
  failure,
  refreshMs,
}: Readonly<{
  symbol: FlowHedgingSymbol;
  document: FlowHedgingPressure | null;
  failure: FlowHedgingPressureFailure | null;
  refreshMs: number;
}>) => {
  const state = ((): "failed" | "response" | "loading" => {
    if (failure !== null) return "failed";
    return document === null ? "loading" : "response";
  })();
  return (
    <Panel title={hedgingTitle(symbol)}>
      <div
        // Without a response the panel keeps the height of the two charts, so the answer does
        // not push the panels below it far down.
        className={document === null ? "min-h-72 space-y-4" : "space-y-4"}
        data-flow-hedging={symbol}
        data-flow-hedging-state={state}
      >
        {failure === null ? null : (
          <p className="text-sm" data-flow-hedging-error="" role="alert">
            {hedgingFailureLine(failure, refreshMs)}
          </p>
        )}
        {state === "loading" ? (
          <p className="text-muted-foreground text-sm" role="status">
            {HEDGING_LOADING}
          </p>
        ) : null}
        {document === null ? null : (
          <HedgingResponse response={document} symbol={symbol} />
        )}
      </div>
    </Panel>
  );
};
