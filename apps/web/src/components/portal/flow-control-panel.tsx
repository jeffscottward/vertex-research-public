// What: the /flow control panel: who is in control of the selected symbol's index group
// (flow.control): the options, futures and agreement lines, the age notice, the study and
// cross-check lines, the event and levels lines, net drift (ticker and expiry selects, metrics,
// chart), the deep trades of the future (limit, coverage, sum, chart, list, absorption marks),
// freshness and notes.
// Research only: a state describes recent flow, never a trade signal.
// Used by: apps/web/src/components/portal/flow-workspace.tsx.
// See: apps/web/src/features/flow/control-view-model.ts; docs/vertex-rebuild/flow-pipeline.md.
"use client";

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
import { useEffect, useState } from "react";

import {
  absorptionMarks,
  buildDeepTradesChart,
  buildNetDriftChart,
  CONTROL_STATE_LABELS,
  controlAgeNotice,
  controlFreshnessRows,
  type ControlLine,
  controlLines,
  controlTitle,
  crossCheckLine,
  deepTradeRows,
  deepTradesAuditLine,
  deepTradesCoverageLine,
  deepTradesLimitLine,
  deepTradesMoreLine,
  deepTradesSum,
  type FlowControl,
  type FlowControlFailure,
  levelsLine,
  NET_DRIFT_VIEWS,
  type NetDriftView,
  netDriftSummary,
  sessionEventLine,
  studyLine,
} from "../../features/flow/control-view-model.ts";
import {
  enumLabel,
  formatMoney,
  formatNyTime,
} from "../../features/flow/format.ts";

/** 44 px high native select (shared by the /flow selects). */
export const FLOW_SELECT_CLASS =
  "h-11 rounded-md border border-border bg-background px-2 text-sm";

/** Line styles of the net drift chart; the dashes keep the lines apart without colour. */
const LEGEND: readonly Readonly<{
  label: string;
  stroke: string;
  dash: string | undefined;
}>[] = [
  { dash: undefined, label: "Call", stroke: "var(--color-success)" },
  { dash: "6 3", label: "Put", stroke: "var(--color-destructive)" },
  {
    dash: "2 2",
    label: "Call minus put",
    stroke: "var(--color-foreground)",
  },
];

const NetDriftBlock = ({ control }: Readonly<{ control: FlowControl }>) => {
  const primary =
    control.netDrift.find((entry) => entry.role === "primary")?.ticker ?? "";
  const [ticker, setTicker] = useState(primary);
  const [view, setView] = useState<NetDriftView>("total");
  // A new group starts again on its primary ticker and all expiries.
  useEffect(() => {
    setTicker(primary);
    setView("total");
  }, [primary]);
  const series =
    control.netDrift.find((entry) => entry.ticker === ticker) ??
    control.netDrift[0];
  if (series === undefined) return null;
  const chart = buildNetDriftChart(series, view);
  const total =
    view === "total"
      ? series.totals.total
      : view === "zero_dte"
        ? series.totals.zeroDte
        : series.totals.longer;
  return (
    <div className="space-y-3" data-flow-net-drift={series.ticker}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="block text-muted-foreground text-xs">Ticker</span>
          <select
            className={FLOW_SELECT_CLASS}
            data-flow-net-drift-ticker=""
            onChange={(event) => setTicker(event.target.value)}
            value={series.ticker}
          >
            {control.netDrift.map((entry) => (
              <option key={entry.ticker} value={entry.ticker}>
                {entry.ticker}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-muted-foreground text-xs">Expiries</span>
          <select
            className={FLOW_SELECT_CLASS}
            data-flow-net-drift-view=""
            onChange={(event) => {
              const next = NET_DRIFT_VIEWS.find(
                (entry) => entry.view === event.target.value
              );
              if (next !== undefined) setView(next.view);
            }}
            value={view}
          >
            {NET_DRIFT_VIEWS.map((entry) => (
              <option key={entry.view} value={entry.view}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {netDriftSummary(series, view).map((metric) => (
          <div
            className="min-w-0"
            data-metric={metric.label}
            key={metric.label}
          >
            <dt className="text-muted-foreground text-xs">{metric.label}</dt>
            <dd className="font-medium text-sm tabular-nums">{metric.value}</dd>
          </div>
        ))}
      </dl>
      <svg
        aria-label={
          total === null
            ? `Net drift of ${series.ticker}: call, put and call minus put, no bucket yet`
            : `Net drift of ${series.ticker}: call ${formatMoney(total.netCallPremiumUsd)}, put ${formatMoney(total.netPutPremiumUsd)}, call minus put ${formatMoney(total.callMinusPutUsd)}`
        }
        className="h-24 w-full"
        data-flow-net-drift-chart=""
        preserveAspectRatio="none"
        role="img"
        viewBox="0 0 320 96"
        width="100%"
      >
        <line
          stroke="currentColor"
          strokeOpacity={0.3}
          x1={0}
          x2={320}
          y1={chart.zeroY}
          y2={chart.zeroY}
        />
        <polyline
          data-flow-net-drift-line="call"
          fill="none"
          points={chart.call}
          stroke="var(--color-success)"
        />
        <polyline
          data-flow-net-drift-line="put"
          fill="none"
          points={chart.put}
          stroke="var(--color-destructive)"
          strokeDasharray="6 3"
        />
        <polyline
          data-flow-net-drift-line="difference"
          fill="none"
          points={chart.difference}
          stroke="var(--color-foreground)"
          strokeDasharray="2 2"
        />
      </svg>
      <ul
        className="flex flex-wrap gap-4 text-muted-foreground text-xs"
        data-flow-net-drift-legend=""
      >
        {LEGEND.map((entry) => (
          <li className="flex items-center gap-1" key={entry.label}>
            <svg aria-hidden="true" height="8" viewBox="0 0 24 8" width="24">
              <line
                stroke={entry.stroke}
                strokeDasharray={entry.dash}
                x1={0}
                x2={24}
                y1={4}
                y2={4}
              />
            </svg>
            {entry.label}
          </li>
        ))}
      </ul>
    </div>
  );
};

const LINE_TITLE: Readonly<Record<ControlLine["key"], string>> = {
  agreement: "Agreement",
  futures: "Futures",
  options: "Options",
};

const DeepTradesBlock = ({ control }: Readonly<{ control: FlowControl }>) => {
  const deep = control.deepTrades;
  const streamed = deep.capture === "streamed";
  const limit = deepTradesLimitLine(deep);
  const audit = deepTradesAuditLine(deep);
  const sum = deepTradesSum(deep);
  const chart = buildDeepTradesChart(deep);
  const rows = deepTradeRows(deep);
  const more = deepTradesMoreLine(deep);
  const marks = absorptionMarks(deep);
  return (
    <section className="min-w-0 space-y-3" data-flow-deep-trades={deep.symbol}>
      <h3 className="font-medium text-sm">Deep trades: {deep.symbol}</h3>
      {limit === null ? null : <p className="text-sm">{limit}</p>}
      <p className="text-muted-foreground text-sm" data-flow-deep-coverage="">
        {deepTradesCoverageLine(deep)}
      </p>
      {audit === null ? null : (
        <p className="text-muted-foreground text-sm" data-flow-deep-audit="">
          {audit}
        </p>
      )}
      <dl>
        <div className="min-w-0" data-metric={sum.label}>
          <dt className="text-muted-foreground text-xs">{sum.label}</dt>
          <dd className="font-medium text-sm tabular-nums">{sum.value}</dd>
        </div>
      </dl>
      <svg
        aria-label={
          streamed
            ? `Sum of deep trades: ${sum.value}`
            : `Sum of sampled deep trades: ${sum.value}`
        }
        className="h-24 w-full"
        data-flow-deep-chart=""
        preserveAspectRatio="none"
        role="img"
        viewBox="0 0 320 96"
        width="100%"
      >
        <line
          stroke="currentColor"
          strokeOpacity={0.3}
          x1={0}
          x2={320}
          y1={chart.zeroY}
          y2={chart.zeroY}
        />
        {chart.segments.map((points) => (
          <polyline
            fill="none"
            key={points}
            points={points}
            stroke="currentColor"
          />
        ))}
      </svg>
      {rows.length === 0 ? (
        <p className="text-sm" data-flow-deep-empty="" role="status">
          {streamed
            ? "No deep trade on the streamed tape since 09:30 ET."
            : "No deep trade in the sampled tape since 09:30 ET."}
        </p>
      ) : (
        <Table
          className="text-sm"
          containerClassName="max-h-72 max-w-full overflow-auto"
          containerProps={{
            "aria-label": "Deep trades, newest first",
            role: "region",
            tabIndex: 0,
          }}
        >
          <TableCaption className="sr-only">
            Deep trades of {deep.symbol}, newest first
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Time</TableHead>
              <TableHead scope="col">Side</TableHead>
              <TableHead className="text-right" scope="col">
                Size
              </TableHead>
              <TableHead className="text-right" scope="col">
                Price
              </TableHead>
              <TableHead scope="col">Rule</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow data-flow-deep-trade="" key={row.key}>
                <TableCell className="tabular-nums">{row.time}</TableCell>
                <TableCell>
                  <StatusBadge status={row.tone}>{row.side}</StatusBadge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.size}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.price}
                </TableCell>
                <TableCell>{row.signing}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {more === null ? null : (
        <p className="text-muted-foreground text-xs">{more}</p>
      )}
      {marks.length === 0 ? null : (
        <ul className="space-y-1 text-sm">
          {marks.map((mark) => (
            <li data-flow-absorption="" key={mark.key}>
              {mark.time}: {mark.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const ControlDocument = ({
  control,
  now,
  refreshMs,
}: Readonly<{ control: FlowControl; now: Date; refreshMs: number }>) => {
  const notice = controlAgeNotice(control, now, refreshMs);
  const event = sessionEventLine(control);
  const levels = levelsLine(control);
  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {controlLines(control, now, refreshMs).map((line) => (
          <li
            className="flex flex-wrap items-baseline gap-2"
            data-flow-control-side={line.key}
            key={line.key}
          >
            <span className="w-20 font-medium text-sm">
              {LINE_TITLE[line.key]}
            </span>
            <StatusBadge
              data-flow-control-state={line.state}
              plain
              status={line.tone}
            >
              {enumLabel(CONTROL_STATE_LABELS, line.state)}
            </StatusBadge>
            <span className="text-sm">{line.text}</span>
            {[line.since, line.ratio, line.asOf]
              .filter((part) => part !== null)
              .map((part) => (
                <span className="text-muted-foreground text-xs" key={part}>
                  {part}
                </span>
              ))}
          </li>
        ))}
      </ul>
      {event === null ? null : (
        <p className="font-medium text-sm" data-flow-session-event="">
          {event}
        </p>
      )}
      {levels === null ? null : (
        <p className="text-sm" data-flow-levels="">
          {levels}
        </p>
      )}
      {notice === null ? null : (
        <p className="text-sm" data-flow-control-age="" role="status">
          {notice}
        </p>
      )}
      <p className="text-sm" data-flow-control-study="">
        {studyLine(control)}
      </p>
      <p className="text-muted-foreground text-sm" data-flow-control-cross="">
        {crossCheckLine(control)}
      </p>
      <NetDriftBlock control={control} />
      <DeepTradesBlock control={control} />
      <ul className="space-y-1">
        {controlFreshnessRows(control).map((row) => (
          <li className="flex items-center gap-2" key={row.key}>
            <StatusBadge plain status={row.tone}>
              {row.text}
            </StatusBadge>
          </li>
        ))}
      </ul>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground text-xs">
        {control.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
};

export const FlowControlPanel = ({
  control,
  failure,
  now,
  refreshMs,
}: Readonly<{
  control: FlowControl | null;
  failure: FlowControlFailure | null;
  now: Date;
  refreshMs: number;
}>) => (
  <Panel
    data-flow-control=""
    title={control === null ? "Who is in control" : controlTitle(control)}
  >
    {control === null ? (
      <p className="text-sm" data-flow-control-empty="" role="status">
        {failure === null
          ? "Loading the control document"
          : `Control document failed to load (${failure.code}: ${failure.message}). The next automatic refresh retries.`}
      </p>
    ) : (
      <>
        {failure === null ? null : (
          <p className="text-sm" data-flow-control-error="" role="alert">
            Refresh failed ({failure.code}: {failure.message}). Showing the
            document of {formatNyTime(control.generatedAt)}.
          </p>
        )}
        <ControlDocument control={control} now={now} refreshMs={refreshMs} />
      </>
    )}
  </Panel>
);
