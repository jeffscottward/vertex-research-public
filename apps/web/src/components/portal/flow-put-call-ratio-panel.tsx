// What: the Put/call ratio panel of /flow (flow.putCallRatio): gross put/call premium and volume
// ratios of stored SPY or SPX option prints as stepped lines over the newest session (09:30 to
// 16:15 ET) and as a daily line across stored sessions (up to 14 days), with a 1.00 parity line,
// open collector gap shades, and the underlying price on the same axis.
// It has its own loading and failure state, so a fault of its call changes no other panel.
// Research only: the ratios describe stored option prints, never a trade signal.
// Used by: apps/web/src/components/portal/flow-workspace.tsx.
// See: apps/web/src/features/flow/put-call-ratio-view-model.ts; docs/vertex-rebuild/flow-pipeline.md.
"use client";

import type {
  FlowPutCallRatio,
  FlowPutCallRatioSymbol,
} from "@darkfactory/api";
import {
  Button,
  Panel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { useState } from "react";

import type { FlowControlFailure } from "../../features/flow/control-view-model.ts";
import {
  formatCount,
  formatMoney,
  formatRatio,
} from "../../features/flow/format.ts";
import {
  buildDaysPriceChart,
  buildDaysRatioChart,
  buildSessionPriceChart,
  buildSessionRatioChart,
  daysRatioAriaLabel,
  formatSessionShortDate,
  PUT_CALL_RATIO_LOADING,
  PUT_CALL_RATIO_NO_CALLS_DAYS,
  PUT_CALL_RATIO_NO_CALLS_SESSION,
  PUT_CALL_RATIO_NO_DAYS,
  PUT_CALL_RATIO_NO_POINTS,
  type PutCallPriceChart,
  type PutCallRatioLegendEntry,
  type PutCallRatioView,
  putCallRatioCountsLine,
  putCallRatioDaysSummaryLine,
  putCallRatioEmptyLine,
  putCallRatioExtremesLine,
  putCallRatioFailureLine,
  putCallRatioHeaderLine,
  putCallRatioLegend,
  putCallRatioPriceAriaLabel,
  putCallRatioPriceName,
  putCallRatioRuleText,
  putCallRatioTitle,
  putCallRatioTotalsLine,
  sessionRatioAriaLabel,
} from "../../features/flow/put-call-ratio-view-model.ts";

/** A failed flow.putCallRatio call: the error code and message, and when it failed. */
export type FlowPutCallRatioFailure = FlowControlFailure &
  Readonly<{ failedAt: number }>;

/** Chart units; the SVGs stretch to the width of the panel. */
const CHART_WIDTH = 1000;
const LINE_HEIGHT = 128;
const PRICE_HEIGHT = 64;
const UNREAD_OPACITY = 0.1;

/** How each line is drawn: dash pattern and token color distinguish series without relying on color alone. */
const LINE_STYLE: Readonly<
  Record<
    Exclude<PutCallRatioLegendEntry["key"], "unread">,
    Readonly<{
      stroke: string;
      width: number;
      dash: string | undefined;
      opacity: number;
    }>
  >
> = {
  parity: {
    dash: "2 3",
    opacity: 0.45,
    stroke: "currentColor",
    width: 1,
  },
  premium: {
    dash: undefined,
    opacity: 1,
    stroke: "currentColor",
    width: 2,
  },
  volume: {
    dash: "6 3",
    opacity: 1,
    stroke: "var(--color-info)",
    width: 1.75,
  },
};

const LegendSample = ({
  entry,
}: Readonly<{ entry: PutCallRatioLegendEntry }>) => {
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
        strokeOpacity={style.opacity}
        strokeWidth={style.width}
        x1="0"
        x2="24"
        y1="6"
        y2="6"
      />
    </svg>
  );
};

const PriceSubplot = ({
  chart,
  response,
  view,
}: Readonly<{
  chart: PutCallPriceChart;
  response: FlowPutCallRatio;
  view: PutCallRatioView;
}>) => (
  <>
    <h3 className="font-medium text-sm">{putCallRatioPriceName(response)}</h3>
    <div className="flex gap-2">
      <div
        aria-hidden="true"
        className="flex h-16 w-14 shrink-0 flex-col justify-between text-right text-muted-foreground text-xs tabular-nums"
      >
        <span data-flow-pcr-price-high="">{chart.highLabel}</span>
        <span data-flow-pcr-price-low="">{chart.lowLabel}</span>
      </div>
      <svg
        aria-label={putCallRatioPriceAriaLabel(response, chart, view)}
        className="h-16 w-full min-w-0"
        data-flow-pcr-chart="price"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        width="100%"
      >
        {chart.path === null ? null : (
          <path
            d={chart.path}
            data-flow-pcr-line="price"
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.7}
            strokeWidth={1.25}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {chart.markers.map((marker) => (
          <line
            data-flow-pcr-price-marker=""
            key={marker.label}
            stroke="currentColor"
            strokeLinecap="round"
            strokeOpacity={0.85}
            strokeWidth={5}
            vectorEffect="non-scaling-stroke"
            x1={marker.x}
            x2={marker.x}
            y1={marker.y}
            y2={marker.y}
          />
        ))}
      </svg>
    </div>
  </>
);

const SessionView = ({
  response,
}: Readonly<{ response: FlowPutCallRatio }>) => {
  const chart = buildSessionRatioChart(response, CHART_WIDTH, LINE_HEIGHT);
  const price = buildSessionPriceChart(response, CHART_WIDTH, PRICE_HEIGHT);
  return (
    <div className="space-y-4" data-flow-pcr-view="session">
      {chart === null || price === null ? (
        <p className="text-sm" data-flow-pcr-no-points="" role="status">
          {response.points.length === 0
            ? PUT_CALL_RATIO_NO_POINTS
            : PUT_CALL_RATIO_NO_CALLS_SESSION}
        </p>
      ) : (
        <figure className="space-y-2">
          <h3 className="font-medium text-sm">
            Running session put/call ratio (premium and volume)
          </h3>
          <div className="flex gap-2">
            <div
              aria-hidden="true"
              className="relative h-32 w-14 shrink-0 text-right text-muted-foreground text-xs tabular-nums"
            >
              {chart.ticks.map((tick) => (
                <span
                  className="absolute right-0 -translate-y-1/2"
                  data-flow-pcr-tick=""
                  key={tick.value}
                  style={{ top: `${(tick.y / chart.height) * 100}%` }}
                >
                  {tick.label}
                </span>
              ))}
            </div>
            <svg
              aria-label={sessionRatioAriaLabel(response)}
              className="h-32 w-full min-w-0"
              data-flow-pcr-chart="session"
              preserveAspectRatio="none"
              role="img"
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              width="100%"
            >
              {chart.unread === null ? null : (
                <rect
                  data-flow-pcr-unread=""
                  fill="currentColor"
                  fillOpacity={UNREAD_OPACITY}
                  height={chart.height}
                  width={chart.unread.width}
                  x={chart.unread.x}
                  y={0}
                />
              )}
              <line
                data-flow-pcr-parity=""
                stroke={LINE_STYLE.parity.stroke}
                strokeDasharray={LINE_STYLE.parity.dash}
                strokeOpacity={LINE_STYLE.parity.opacity}
                strokeWidth={LINE_STYLE.parity.width}
                vectorEffect="non-scaling-stroke"
                x1={0}
                x2={chart.width}
                y1={chart.parityY}
                y2={chart.parityY}
              />
              {chart.volumePath === null ? null : (
                <path
                  d={chart.volumePath}
                  data-flow-pcr-line="volume"
                  fill="none"
                  stroke={LINE_STYLE.volume.stroke}
                  strokeDasharray={LINE_STYLE.volume.dash}
                  strokeWidth={LINE_STYLE.volume.width}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {chart.premiumPath === null ? null : (
                <path
                  d={chart.premiumPath}
                  data-flow-pcr-line="premium"
                  fill="none"
                  stroke={LINE_STYLE.premium.stroke}
                  strokeWidth={LINE_STYLE.premium.width}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
          </div>
          <PriceSubplot chart={price} response={response} view="session" />
          <div className="flex justify-between pl-16 text-muted-foreground text-xs">
            <span>{chart.startLabel}</span>
            <span>{chart.endLabel}</span>
          </div>
          <figcaption>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
              {putCallRatioLegend(chart.unread !== null, "session").map(
                (entry) => (
                  <li
                    className="flex items-center gap-2"
                    data-flow-pcr-legend={entry.key}
                    key={entry.key}
                  >
                    <LegendSample entry={entry} />
                    <span>{entry.text}</span>
                  </li>
                )
              )}
            </ul>
          </figcaption>
        </figure>
      )}
      <div className="space-y-1 text-sm tabular-nums">
        <p data-flow-pcr-totals="">{putCallRatioTotalsLine(response)}</p>
        <p data-flow-pcr-extremes="">{putCallRatioExtremesLine(response)}</p>
        <p className="text-muted-foreground" data-flow-pcr-counts="">
          {putCallRatioCountsLine(response)}
        </p>
      </div>
    </div>
  );
};

const DaysView = ({ response }: Readonly<{ response: FlowPutCallRatio }>) => {
  const chart = buildDaysRatioChart(response, CHART_WIDTH, LINE_HEIGHT);
  const price = buildDaysPriceChart(response, CHART_WIDTH, PRICE_HEIGHT);
  return (
    <div className="space-y-4" data-flow-pcr-view="days">
      {chart === null || price === null ? (
        <p className="text-sm" data-flow-pcr-no-days="" role="status">
          {response.days.length === 0
            ? PUT_CALL_RATIO_NO_DAYS
            : PUT_CALL_RATIO_NO_CALLS_DAYS}
        </p>
      ) : (
        <figure className="space-y-2">
          <h3 className="font-medium text-sm">
            Daily session put/call ratio (premium and volume)
          </h3>
          <div className="flex gap-2">
            <div
              aria-hidden="true"
              className="relative h-32 w-14 shrink-0 text-right text-muted-foreground text-xs tabular-nums"
            >
              {chart.ticks.map((tick) => (
                <span
                  className="absolute right-0 -translate-y-1/2"
                  data-flow-pcr-tick=""
                  key={tick.value}
                  style={{ top: `${(tick.y / chart.height) * 100}%` }}
                >
                  {tick.label}
                </span>
              ))}
            </div>
            <svg
              aria-label={daysRatioAriaLabel(response)}
              className="h-32 w-full min-w-0"
              data-flow-pcr-chart="days"
              preserveAspectRatio="none"
              role="img"
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              width="100%"
            >
              {chart.incompleteBands.map((band) => (
                <rect
                  data-flow-pcr-incomplete={band.session}
                  fill="currentColor"
                  fillOpacity={UNREAD_OPACITY}
                  height={chart.height}
                  key={band.session}
                  width={band.width}
                  x={band.x}
                  y={0}
                />
              ))}
              <line
                data-flow-pcr-parity=""
                stroke={LINE_STYLE.parity.stroke}
                strokeDasharray={LINE_STYLE.parity.dash}
                strokeOpacity={LINE_STYLE.parity.opacity}
                strokeWidth={LINE_STYLE.parity.width}
                vectorEffect="non-scaling-stroke"
                x1={0}
                x2={chart.width}
                y1={chart.parityY}
                y2={chart.parityY}
              />
              {chart.volumePath === null ? null : (
                <path
                  d={chart.volumePath}
                  data-flow-pcr-line="volume"
                  fill="none"
                  stroke={LINE_STYLE.volume.stroke}
                  strokeDasharray={LINE_STYLE.volume.dash}
                  strokeWidth={LINE_STYLE.volume.width}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {chart.premiumPath === null ? null : (
                <path
                  d={chart.premiumPath}
                  data-flow-pcr-line="premium"
                  fill="none"
                  stroke={LINE_STYLE.premium.stroke}
                  strokeWidth={LINE_STYLE.premium.width}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {chart.volumeMarkers.map((marker) => (
                <line
                  data-flow-pcr-marker="volume"
                  key={`v-${marker.session}`}
                  stroke={LINE_STYLE.volume.stroke}
                  strokeLinecap="square"
                  strokeWidth={6}
                  vectorEffect="non-scaling-stroke"
                  x1={marker.x}
                  x2={marker.x}
                  y1={marker.y}
                  y2={marker.y}
                />
              ))}
              {chart.premiumMarkers.map((marker) => (
                <line
                  data-flow-pcr-marker="premium"
                  key={`p-${marker.session}`}
                  stroke={LINE_STYLE.premium.stroke}
                  strokeLinecap="round"
                  strokeWidth={7}
                  vectorEffect="non-scaling-stroke"
                  x1={marker.x}
                  x2={marker.x}
                  y1={marker.y}
                  y2={marker.y}
                />
              ))}
            </svg>
          </div>
          <PriceSubplot chart={price} response={response} view="days" />
          <div className="relative ml-16 h-4 text-muted-foreground text-xs">
            {chart.axisLabels.map((entry) => {
              const pct = (entry.x / chart.width) * 100;
              return (
                <span
                  className="absolute whitespace-nowrap"
                  data-flow-pcr-day-label={entry.session}
                  key={entry.session}
                  style={{
                    left: `${pct}%`,
                    transform: `translateX(-${pct}%)`,
                  }}
                >
                  {entry.label}
                </span>
              );
            })}
          </div>
          <figcaption>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
              {putCallRatioLegend(chart.incompleteBands.length > 0, "days").map(
                (entry) => (
                  <li
                    className="flex items-center gap-2"
                    data-flow-pcr-legend={entry.key}
                    key={entry.key}
                  >
                    <LegendSample entry={entry} />
                    <span>{entry.text}</span>
                  </li>
                )
              )}
            </ul>
          </figcaption>
        </figure>
      )}
      <p className="text-sm tabular-nums" data-flow-pcr-days-summary="">
        {putCallRatioDaysSummaryLine(response)}
      </p>
      {response.days.length === 0 ? null : (
        <div className="overflow-x-auto">
          <Table data-flow-pcr-days-table="">
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead className="text-right">Premium P/C</TableHead>
                <TableHead className="text-right">Volume P/C</TableHead>
                <TableHead className="text-right">Puts / Calls ($)</TableHead>
                <TableHead className="text-right">Puts / Calls (vol)</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...response.days].reverse().map((day) => (
                <TableRow key={day.session}>
                  <TableCell className="whitespace-nowrap font-medium">
                    {formatSessionShortDate(day.session)} ({day.session})
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatRatio(day.premiumRatio, "no calls")}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatRatio(day.volumeRatio, "no calls")}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {formatMoney(day.putPremium)} /{" "}
                    {formatMoney(day.callPremium)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {formatCount(day.putVolume)} / {formatCount(day.callVolume)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-xs">
                    {day.incomplete ? "Incomplete" : "Stored"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};

const PutCallRatioResponse = ({
  response,
  symbol,
}: Readonly<{
  response: FlowPutCallRatio;
  symbol: FlowPutCallRatioSymbol;
}>) => {
  const [view, setView] = useState<PutCallRatioView>("session");
  if (response.session === null)
    return (
      <p className="text-sm" data-flow-pcr-empty="" role="status">
        {putCallRatioEmptyLine(symbol)}
      </p>
    );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm" data-flow-pcr-header="">
          {putCallRatioHeaderLine(response)}
        </p>
        <fieldset className="inline-flex gap-1 rounded-md border border-border p-0.5">
          <legend className="sr-only">Put/call ratio view</legend>
          <Button
            aria-pressed={view === "session"}
            data-flow-pcr-tab="session"
            onClick={() => setView("session")}
            size="sm"
            variant={view === "session" ? "secondary" : "ghost"}
          >
            Session
          </Button>
          <Button
            aria-pressed={view === "days"}
            data-flow-pcr-tab="days"
            onClick={() => setView("days")}
            size="sm"
            variant={view === "days" ? "secondary" : "ghost"}
          >
            {`Days (${response.days.length})`}
          </Button>
        </fieldset>
      </div>
      {view === "session" ? (
        <SessionView response={response} />
      ) : (
        <DaysView response={response} />
      )}
      <p className="text-muted-foreground text-xs" data-flow-pcr-rule="">
        {putCallRatioRuleText(response.rules)}
      </p>
    </div>
  );
};

/**
 * Three states: loading (no response and no failure), failed (the error line; the last response
 * stays below it when one exists) and response.
 */
export const FlowPutCallRatioPanel = ({
  symbol,
  document,
  failure,
  refreshMs,
}: Readonly<{
  symbol: FlowPutCallRatioSymbol;
  document: FlowPutCallRatio | null;
  failure: FlowPutCallRatioFailure | null;
  refreshMs: number;
}>) => {
  const state = ((): "failed" | "response" | "loading" => {
    if (failure !== null) return "failed";
    return document === null ? "loading" : "response";
  })();
  return (
    <Panel title={putCallRatioTitle(symbol)}>
      <div
        className={document === null ? "min-h-72 space-y-4" : "space-y-4"}
        data-flow-pcr={symbol}
        data-flow-pcr-state={state}
      >
        {failure === null ? null : (
          <p className="text-sm" data-flow-pcr-error="" role="alert">
            {putCallRatioFailureLine(failure, refreshMs)}
          </p>
        )}
        {state === "loading" ? (
          <p className="text-muted-foreground text-sm" role="status">
            {PUT_CALL_RATIO_LOADING}
          </p>
        ) : null}
        {document === null ? null : (
          <PutCallRatioResponse response={document} symbol={symbol} />
        )}
      </div>
    </Panel>
  );
};
