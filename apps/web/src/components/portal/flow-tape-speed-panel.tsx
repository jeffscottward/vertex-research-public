// What: the Tape speed panel of /flow (flow.tapeSpeed): trades per second and contracts per second
// of the ES or NQ tape as bars on one time axis, a tick at the busiest second of each bar, shades
// for time without counts, a diamond mark on each bar with a burst second, and the burst table.
// It has its own loading and failure state, so a fault of its call changes no other panel.
// Research only: a bar and a burst describe how fast the tape traded, never a trade signal.
// Used by: apps/web/src/components/portal/flow-workspace.tsx.
// See: apps/web/src/features/flow/tape-speed-view-model.ts; docs/vertex-rebuild/flow-pipeline.md.
"use client";

import type { FlowTapeSpeed } from "@darkfactory/api";
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

import type { FlowControlFailure } from "../../features/flow/control-view-model.ts";
import {
  buildTapeSpeedChart,
  burstCountLine,
  burstRows,
  evaluatedSentence,
  ruleSentence,
  TAPE_SPEED_BURST_HEADERS,
  TAPE_SPEED_EMPTY,
  TAPE_SPEED_LOADING,
  type TapeSpeedBar,
  type TapeSpeedChart,
  type TapeSpeedShade,
  tapeFaultLine,
  tapeLine,
  tapeSpeedAriaLabel,
  tapeSpeedCaption,
  tapeSpeedLegend,
  tapeSpeedTitle,
  tapeSymbolOf,
} from "../../features/flow/tape-speed-view-model.ts";
import type { FlowSymbol } from "../../features/flow/view-model.ts";
import { loadFailedLabel } from "../status-time.ts";

/** A failed flow.tapeSpeed call: the error code and message, and when it failed. */
export type FlowTapeSpeedFailure = FlowControlFailure &
  Readonly<{ failedAt: number }>;

const SHADE_FILL: Readonly<Record<TapeSpeedShade["state"], string>> = {
  after_stored: "currentColor",
  no_data: "currentColor",
  not_recorded: "var(--color-warning)",
};
const SHADE_OPACITY: Readonly<Record<TapeSpeedShade["state"], number>> = {
  after_stored: 0.03,
  no_data: 0.06,
  not_recorded: 0.22,
};

const SpeedChart = ({
  bars,
  chart,
  fill,
  label,
  series,
}: Readonly<{
  bars: readonly TapeSpeedBar[];
  chart: TapeSpeedChart;
  fill: string;
  label: string;
  series: "trades" | "contracts";
}>) => (
  <svg
    aria-label={label}
    className="h-24 w-full"
    data-flow-tape-chart={series}
    preserveAspectRatio="none"
    role="img"
    viewBox={`0 0 ${chart.width} ${chart.height}`}
    width="100%"
  >
    {chart.shades.map((shade) => (
      <rect
        data-flow-tape-shade={shade.state}
        fill={SHADE_FILL[shade.state]}
        fillOpacity={SHADE_OPACITY[shade.state]}
        height={chart.height}
        key={shade.x}
        width={shade.width}
        x={shade.x}
        y={0}
      />
    ))}
    {bars.map((bar) => (
      <g key={bar.start}>
        <rect
          data-flow-tape-bar={bar.partial ? "partial" : "full"}
          fill={fill}
          fillOpacity={bar.partial ? 0.45 : 0.9}
          height={bar.height}
          width={bar.width}
          x={bar.x}
          y={bar.y}
        />
        <line
          data-flow-tape-tick=""
          stroke="currentColor"
          strokeOpacity={0.7}
          vectorEffect="non-scaling-stroke"
          x1={bar.x}
          x2={bar.x + bar.width}
          y1={bar.tickY}
          y2={bar.tickY}
        />
      </g>
    ))}
  </svg>
);

const TapeSpeedDocument = ({
  document,
}: Readonly<{ document: FlowTapeSpeed }>) => {
  const chart = buildTapeSpeedChart(document);
  const fault = tapeFaultLine(document);
  const legend = tapeSpeedLegend(chart);
  const evaluated = evaluatedSentence(document);
  const rows = burstRows(document);
  const count = burstCountLine(document);
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm" data-flow-tape-line="">
        {tapeLine(document)}
      </p>
      {fault === null ? null : (
        <p
          className="flex flex-wrap items-center gap-2 text-sm"
          data-flow-tape-fault=""
          role="alert"
        >
          <StatusBadge status="warning">Write fault</StatusBadge>
          <span>{fault}</span>
        </p>
      )}
      <figure className="space-y-2">
        <h3 className="font-medium text-sm">Trades per second</h3>
        <div
          aria-hidden="true"
          className="relative h-3 w-full"
          data-flow-tape-marks=""
        >
          {chart.marks.map((mark) => (
            <span
              className="absolute top-0.5 block size-2 -translate-x-1/2 rotate-45 bg-primary"
              data-flow-tape-mark=""
              key={mark.start}
              style={{ left: `${mark.leftPercent}%` }}
            />
          ))}
        </div>
        <SpeedChart
          bars={chart.trades}
          chart={chart}
          fill="var(--color-info)"
          label={tapeSpeedAriaLabel(chart, "trades")}
          series="trades"
        />
        <h3 className="font-medium text-sm">Contracts per second</h3>
        <SpeedChart
          bars={chart.contracts}
          chart={chart}
          fill="currentColor"
          label={tapeSpeedAriaLabel(chart, "contracts")}
          series="contracts"
        />
        <div className="flex justify-between text-muted-foreground text-xs">
          <span>{chart.startLabel}</span>
          <span>{chart.endLabel}</span>
        </div>
        <figcaption className="text-muted-foreground text-xs">
          {tapeSpeedCaption(chart)}
        </figcaption>
      </figure>
      {chart.counted > 0 ? null : (
        <p className="text-sm" data-flow-tape-empty="" role="status">
          {TAPE_SPEED_EMPTY}
        </p>
      )}
      {legend.length === 0 ? null : (
        <ul className="space-y-1 text-muted-foreground text-xs">
          {legend.map((entry) => (
            <li
              className="flex items-start gap-2"
              data-flow-tape-legend={entry.state}
              key={entry.state}
            >
              <span
                aria-hidden="true"
                className="mt-0.5 block size-3 shrink-0 rounded-sm border border-border"
                style={{
                  backgroundColor: SHADE_FILL[entry.state],
                  opacity: SHADE_OPACITY[entry.state] * 3,
                }}
              />
              <span>{entry.text}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm" data-flow-tape-rule="">
        {ruleSentence(document.rules)}
      </p>
      {evaluated === null ? null : (
        <p
          className="text-muted-foreground text-xs"
          data-flow-tape-evaluated=""
        >
          {evaluated}
        </p>
      )}
      {rows.length === 0 ? null : (
        <Table
          className="text-sm"
          containerClassName="max-h-72 max-w-full overflow-auto"
          containerProps={{
            "aria-label": "Bursts, oldest first",
            role: "region",
            tabIndex: 0,
          }}
        >
          <TableCaption className="sr-only">
            Bursts of {document.symbol} in this window, oldest first
          </TableCaption>
          <TableHeader>
            <TableRow>
              {TAPE_SPEED_BURST_HEADERS.map((header, index) => (
                <TableHead
                  className={index === 0 ? undefined : "text-right"}
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
              <TableRow data-flow-tape-burst="" key={row.key}>
                <TableCell className="tabular-nums">{row.time}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.seconds}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.peakTrades}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.contracts}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.baseline}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.multiple}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {count === null ? null : (
        <p className="text-muted-foreground text-xs" data-flow-tape-count="">
          {count}
        </p>
      )}
    </div>
  );
};

/**
 * Three states: loading (no document and no failure), failed (the error line; the last document
 * stays below it when one exists) and document.
 */
export const FlowTapeSpeedPanel = ({
  symbol,
  document,
  failure,
  refreshMs,
}: Readonly<{
  /** The symbol that the page shows; the panel shows the future of its index group. */
  symbol: FlowSymbol;
  document: FlowTapeSpeed | null;
  failure: FlowTapeSpeedFailure | null;
  refreshMs: number;
}>) => {
  const state = ((): "failed" | "document" | "loading" => {
    if (failure !== null) return "failed";
    return document === null ? "loading" : "document";
  })();
  return (
    <Panel title={tapeSpeedTitle(symbol)}>
      <div
        // Without a document the panel keeps the height of the two charts, so the answer does
        // not push the panels below it far down.
        className={document === null ? "min-h-80 space-y-4" : "space-y-4"}
        data-flow-tape-speed={tapeSymbolOf(symbol)}
        data-flow-tape-state={state}
      >
        {failure === null ? null : (
          <p className="text-sm" data-flow-tape-error="" role="alert">
            {`${loadFailedLabel(failure.failedAt)} · Tape speed not loaded: ${failure.code}: ${failure.message} · retrying every ${Math.round(refreshMs / 1000)} s`}
          </p>
        )}
        {state === "loading" ? (
          <p className="text-muted-foreground text-sm" role="status">
            {TAPE_SPEED_LOADING}
          </p>
        ) : null}
        {document === null ? null : <TapeSpeedDocument document={document} />}
      </div>
    </Panel>
  );
};
