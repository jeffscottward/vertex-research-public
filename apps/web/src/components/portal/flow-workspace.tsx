// What: /flow page body: one symbol's order flow, options flow, GEX levels, events and confluence
// from flow.snapshot, with per-source freshness and an "as of" stamp. SPY/ES toggle, window
// select, auto refresh every 60 s and manual refresh. Research only: nothing here places,
// changes or cancels orders, and confluence describes recent flow, never a trade signal.
// Used by: apps/web/src/app/(portal)/flow/page.tsx, apps/web/src/lab/entries/research.tsx.
// See: apps/web/src/features/flow/view-model.ts; docs/vertex-rebuild/flow-pipeline.md.
"use client";

import {
  type ApiClient,
  createApiClient,
  type FlowSnapshot,
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
} from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  formatCount,
  formatNyDateTime,
  formatNyTime,
  formatSigned,
} from "../../features/flow/format.ts";
import {
  basisNote,
  bookMetrics,
  buildFlowChart,
  eventRows,
  FLOW_DEFAULT_WINDOW,
  FLOW_DISCLAIMER,
  FLOW_REFRESH_MS,
  FLOW_VIEW_SYMBOLS,
  FLOW_WINDOW_MINUTES,
  type FlowChart,
  type FlowRequest,
  type FlowSymbol,
  type FlowWindowMinutes,
  freshnessRows,
  gexLevelRows,
  gexMetrics,
  type Metric,
  neverCollected,
  optionPrintRows,
  optionsMetrics,
  orderFlowMetrics,
  SUMMARY_TONE,
  VOTE_TONE,
  windowLabel,
} from "../../features/flow/view-model.ts";
import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

export interface FlowGateway {
  readonly snapshot: (input: FlowRequest) => Promise<FlowSnapshot>;
}

export const createBrowserFlowGateway = (): FlowGateway => {
  let client: ApiClient | undefined;
  return Object.freeze({
    snapshot: (input: FlowRequest) => {
      client ??= createApiClient({ baseUrl: window.location.origin });
      return client.flow.snapshot(input);
    },
  });
};

const BUY_FILL = "var(--color-success)";
const SELL_FILL = "var(--color-destructive)";
const selectClass =
  "h-11 rounded-md border border-border bg-background px-2 text-sm";

type Failure =
  | Readonly<{ kind: "forbidden" }>
  | Readonly<{ kind: "error"; message: string }>;

const MetricGrid = ({
  metrics,
  name,
}: Readonly<{ metrics: readonly Metric[]; name: string }>) => (
  <dl
    className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4"
    data-flow-metrics={name}
  >
    {metrics.map((metric) => (
      <div className="min-w-0" data-metric={metric.label} key={metric.label}>
        <dt className="text-muted-foreground text-xs">{metric.label}</dt>
        <dd className="font-medium text-sm tabular-nums">{metric.value}</dd>
      </div>
    ))}
  </dl>
);

const Empty = ({
  children,
  name,
}: Readonly<{ children: string; name: string }>) => (
  <p className="text-muted-foreground text-sm" data-flow-empty={name}>
    {children}
  </p>
);

const FreshnessPanel = ({ snapshot }: Readonly<{ snapshot: FlowSnapshot }>) => (
  <Panel
    description={
      <span data-flow-as-of="">
        As of{" "}
        <time dateTime={snapshot.windowEnd}>
          {formatNyDateTime(snapshot.windowEnd)}
        </time>
        {" · window "}
        {formatNyTime(snapshot.windowStart)}–{formatNyTime(snapshot.windowEnd)}
        {" · generated "}
        <time dateTime={snapshot.generatedAt}>
          {formatNyDateTime(snapshot.generatedAt)}
        </time>
      </span>
    }
    title="Data freshness"
  >
    {neverCollected(snapshot.freshness) ? (
      <p className="mb-3 text-sm" data-flow-never="" role="note">
        Nothing has been collected for {snapshot.symbol} yet. The flow collector
        fills this page while it runs during market hours.
      </p>
    ) : null}
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {freshnessRows(snapshot.freshness).map((row) => (
        <li
          className="space-y-1 rounded-md border border-border p-3"
          data-flow-source={row.source}
          key={row.source}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-sm">{row.label}</span>
            <StatusBadge data-freshness={row.state} status={row.tone}>
              {row.state}
            </StatusBadge>
          </div>
          <p className="text-muted-foreground text-xs">
            Updated {row.age} · last stored {row.lastOk}
          </p>
          <p className="text-muted-foreground text-xs">
            Last sample: {row.lastStatus}
            {row.message === null ? null : ` — ${row.message}`}
          </p>
        </li>
      ))}
    </ul>
  </Panel>
);

const ConfluencePanel = ({
  confluence,
}: Readonly<{ confluence: FlowSnapshot["confluence"] }>) => (
  <Panel
    description={<span role="note">{FLOW_DISCLAIMER}</span>}
    title="Confluence"
  >
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <StatusBadge
        data-flow-confluence={confluence.summary}
        status={SUMMARY_TONE[confluence.summary]}
      >
        {confluence.label}
      </StatusBadge>
      <span className="text-muted-foreground text-xs">
        {confluence.bullish} bullish · {confluence.bearish} bearish of{" "}
        {confluence.known} directional factors with data
      </span>
    </div>
    {confluence.factors.length === 0 ? (
      <Empty name="factors">No factors yet.</Empty>
    ) : (
      <ul className="divide-y divide-border">
        {confluence.factors.map((factor) => (
          <li
            className="grid gap-1 py-2 sm:grid-cols-[10rem_8rem_6rem_1fr] sm:items-baseline sm:gap-3"
            data-flow-factor={factor.key}
            key={factor.key}
          >
            <span className="font-medium text-sm">{factor.label}</span>
            <span className="text-sm tabular-nums">{factor.value}</span>
            <StatusBadge status={VOTE_TONE[factor.vote]}>
              {factor.vote}
            </StatusBadge>
            <span className="text-muted-foreground text-xs">
              {factor.detail}
            </span>
          </li>
        ))}
      </ul>
    )}
  </Panel>
);

const MinuteChart = ({ chart }: Readonly<{ chart: FlowChart }>) => (
  <figure className="space-y-2" data-flow-chart="">
    <figcaption className="text-muted-foreground text-xs">
      Delta per minute (buy − sell) and cumulative delta. {chart.covered} of{" "}
      {chart.slots} minutes sampled; shaded minutes were not sampled.
    </figcaption>
    <svg
      aria-label={`Delta per minute from ${chart.startLabel} to ${chart.endLabel}, largest ${formatCount(chart.maxAbsDelta)}`}
      className="h-24 w-full"
      data-flow-delta-chart=""
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${chart.width} ${chart.height}`}
    >
      {chart.gaps.map((gap) => (
        <rect
          data-flow-gap=""
          fill="currentColor"
          fillOpacity={0.06}
          height={chart.height}
          key={gap.x}
          width={gap.width}
          x={gap.x}
          y={0}
        />
      ))}
      <line
        stroke="currentColor"
        strokeOpacity={0.3}
        x1={0}
        x2={chart.width}
        y1={chart.zeroY}
        y2={chart.zeroY}
      />
      {chart.bars.map((bar) => (
        <rect
          data-flow-bar={bar.positive ? "buy" : "sell"}
          fill={bar.positive ? BUY_FILL : SELL_FILL}
          height={bar.height}
          key={bar.minute}
          width={bar.width}
          x={bar.x}
          y={bar.y}
        />
      ))}
    </svg>
    <svg
      aria-label={`Cumulative delta ending at ${formatSigned(chart.lastCvd)}`}
      className="h-24 w-full text-primary"
      data-flow-cvd-chart=""
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${chart.width} ${chart.height}`}
    >
      <line
        stroke="currentColor"
        strokeDasharray="4 4"
        strokeOpacity={0.3}
        x1={0}
        x2={chart.width}
        y1={chart.cvdZeroY}
        y2={chart.cvdZeroY}
      />
      {chart.cvdSegments.map((points) => (
        <polyline
          data-flow-cvd-segment=""
          fill="none"
          key={points}
          points={points}
          stroke="currentColor"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
    <div className="flex justify-between text-muted-foreground text-xs">
      <span>{chart.startLabel}</span>
      <span>{chart.endLabel}</span>
    </div>
  </figure>
);

const OrderFlowPanel = ({ snapshot }: Readonly<{ snapshot: FlowSnapshot }>) => {
  const chart = buildFlowChart(snapshot);
  const { book } = snapshot.orderFlow;
  return (
    <Panel title={`Order flow (${snapshot.symbol})`}>
      <div className="space-y-5">
        <MetricGrid
          metrics={orderFlowMetrics(snapshot.orderFlow, snapshot.symbol)}
          name="order-flow"
        />
        {chart === null ? (
          <Empty name="minutes">
            No sampled minutes in this window yet. Ticks are sampled every few
            minutes while the market is open.
          </Empty>
        ) : (
          <MinuteChart chart={chart} />
        )}
        <div className="space-y-2">
          <h3 className="font-medium text-sm">Book</h3>
          {book === null ? (
            <Empty name="book">No order book snapshot in this window.</Empty>
          ) : (
            <MetricGrid metrics={bookMetrics(book)} name="book" />
          )}
        </div>
      </div>
    </Panel>
  );
};

const OptionsFlowPanel = ({
  snapshot,
}: Readonly<{ snapshot: FlowSnapshot }>) => {
  const options = snapshot.optionsFlow;
  const rows = optionPrintRows(options.topPrints);
  return (
    <Panel
      description={
        options.ticker === snapshot.symbol
          ? undefined
          : `${snapshot.symbol} options flow is read from ${options.ticker} options.`
      }
      title={`Options flow (${options.ticker})`}
    >
      {options.trades === 0 ? (
        <Empty name="options">No option prints in this window.</Empty>
      ) : (
        <div className="space-y-5">
          <MetricGrid metrics={optionsMetrics(options)} name="options" />
          {rows.length === 0 ? (
            <Empty name="prints">No top prints to show.</Empty>
          ) : (
            <Table
              className="min-w-[56rem] text-sm"
              containerProps={{
                "aria-label": "Top option prints (scrolls sideways)",
                role: "region",
                tabIndex: 0,
              }}
            >
              <TableCaption className="sr-only">
                Largest option prints by premium
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Time</TableHead>
                  <TableHead scope="col">Contract</TableHead>
                  <TableHead className="text-right" scope="col">
                    Size
                  </TableHead>
                  <TableHead className="text-right" scope="col">
                    Price
                  </TableHead>
                  <TableHead className="text-right" scope="col">
                    Premium
                  </TableHead>
                  <TableHead scope="col">Side</TableHead>
                  <TableHead scope="col">Sentiment</TableHead>
                  <TableHead scope="col">Type</TableHead>
                  <TableHead scope="col">Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow data-flow-print="" key={row.key}>
                    <TableCell>{row.time}</TableCell>
                    <TableHead className="font-mono text-xs" scope="row">
                      {row.expiry} {row.strike}
                      {row.right}
                      <span className="block text-muted-foreground">
                        {row.contract}
                      </span>
                    </TableHead>
                    <TableCell className="text-right">{row.size}</TableCell>
                    <TableCell className="text-right">{row.price}</TableCell>
                    <TableCell className="text-right">{row.premium}</TableCell>
                    <TableCell>{row.side}</TableCell>
                    <TableCell>
                      <StatusBadge status={row.tone}>
                        {row.sentiment}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>{row.kind}</TableCell>
                    <TableCell className="text-xs">
                      {row.flags.length === 0 ? "—" : row.flags.join(", ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </Panel>
  );
};

const GexPanel = ({ snapshot }: Readonly<{ snapshot: FlowSnapshot }>) => {
  const { gex, symbol } = snapshot;
  if (gex === null)
    return (
      <Panel title="GEX levels">
        <Empty name="gex">
          No GEX snapshot yet for this symbol. Levels appear after the collector
          stores one.
        </Empty>
      </Panel>
    );
  const showUnderlying = gex.ticker !== symbol;
  return (
    <Panel
      description={<span data-flow-basis="">{basisNote(symbol, gex)}</span>}
      title="GEX levels"
    >
      <div className="space-y-5">
        <MetricGrid metrics={gexMetrics(gex)} name="gex" />
        <Table className="text-sm">
          <TableCaption className="sr-only">GEX levels</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Level</TableHead>
              <TableHead className="text-right" scope="col">
                {symbol} price
              </TableHead>
              {showUnderlying ? (
                <TableHead className="text-right" scope="col">
                  {gex.ticker} price
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {gexLevelRows(gex).map((row) => (
              <TableRow data-flow-level={row.key} key={row.key}>
                <TableHead scope="row">{row.label}</TableHead>
                <TableCell className="text-right">{row.symbolPrice}</TableCell>
                {showUnderlying ? (
                  <TableCell className="text-right">
                    {row.underlyingPrice}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
};

const EventsPanel = ({ snapshot }: Readonly<{ snapshot: FlowSnapshot }>) => (
  <Panel title="Events">
    <div className="space-y-5">
      {snapshot.events.length === 0 ? (
        <Empty name="events">No events in this window.</Empty>
      ) : (
        <ol className="divide-y divide-border">
          {eventRows(snapshot.events).map((row) => (
            <li
              className="grid gap-1 py-2 sm:grid-cols-[7rem_10rem_6rem_1fr] sm:items-baseline sm:gap-3"
              data-flow-event=""
              key={row.key}
            >
              <span className="text-xs tabular-nums">{row.time}</span>
              <span className="font-medium text-sm">{row.kind}</span>
              <StatusBadge status={row.tone}>{row.direction}</StatusBadge>
              <span className="text-muted-foreground text-xs">
                {row.detail}
              </span>
            </li>
          ))}
        </ol>
      )}
      {snapshot.notes.length === 0 ? null : (
        <div className="space-y-1" data-flow-notes="">
          <h3 className="font-medium text-sm">Notes</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground text-xs">
            {snapshot.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  </Panel>
);

const SnapshotView = ({ snapshot }: Readonly<{ snapshot: FlowSnapshot }>) => (
  <div className="space-y-6" data-flow-snapshot={snapshot.symbol}>
    <FreshnessPanel snapshot={snapshot} />
    <ConfluencePanel confluence={snapshot.confluence} />
    <OrderFlowPanel snapshot={snapshot} />
    <OptionsFlowPanel snapshot={snapshot} />
    <GexPanel snapshot={snapshot} />
    <EventsPanel snapshot={snapshot} />
  </div>
);

export const FlowWorkspace = ({
  gateway: supplied,
  refreshMs = FLOW_REFRESH_MS,
}: Readonly<{ gateway?: FlowGateway; refreshMs?: number }>) => {
  const [gateway] = useState(() => supplied ?? createBrowserFlowGateway());
  const [symbol, setSymbol] = useState<FlowSymbol>("SPY");
  const [minutes, setMinutes] =
    useState<FlowWindowMinutes>(FLOW_DEFAULT_WINDOW);
  const [snapshot, setSnapshot] = useState<FlowSnapshot | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(true);
  // Only the newest request may update the page, so a slow SPY answer never lands on ES.
  const latest = useRef(0);

  const load = useCallback(async () => {
    latest.current += 1;
    const request = latest.current;
    setPending(true);
    try {
      const next = await gateway.snapshot({ minutes, symbol });
      if (request !== latest.current) return;
      setSnapshot(next);
      setFailure(null);
    } catch (error) {
      if (request !== latest.current) return;
      const described = describePortfolioMonitorFailure(error);
      setFailure(
        described.kind === "forbidden"
          ? { kind: "forbidden" }
          : {
              kind: "error",
              message: `${described.code}: ${described.message}`,
            }
      );
    } finally {
      if (request === latest.current) setPending(false);
    }
  }, [gateway, minutes, symbol]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => {
      window.clearInterval(timer);
      latest.current += 1;
    };
  }, [load, refreshMs]);

  if (failure?.kind === "forbidden")
    return <OperatorAccessRequired feature="flow" />;

  return (
    <div className="space-y-6" data-flow-state={pending ? "loading" : "idle"}>
      <div className="flex flex-wrap items-end gap-3" data-flow-controls="">
        <fieldset className="space-y-1">
          <legend className="text-muted-foreground text-xs">Symbol</legend>
          <div className="inline-flex gap-1 rounded-md border border-border p-0.5">
            {FLOW_VIEW_SYMBOLS.map((option) => (
              <Button
                aria-pressed={option === symbol}
                key={option}
                onClick={() => {
                  if (option === symbol) return;
                  setSnapshot(null);
                  setSymbol(option);
                }}
                size="sm"
                variant={option === symbol ? "secondary" : "ghost"}
              >
                {option}
              </Button>
            ))}
          </div>
        </fieldset>
        <label className="space-y-1">
          <span className="block text-muted-foreground text-xs">Window</span>
          <select
            className={selectClass}
            data-flow-window=""
            onChange={(event) => {
              setSnapshot(null);
              setMinutes(Number(event.target.value) as FlowWindowMinutes);
            }}
            value={minutes}
          >
            {FLOW_WINDOW_MINUTES.map((option) => (
              <option key={option} value={option}>
                {windowLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <Button
          data-flow-refresh=""
          disabled={pending}
          onClick={() => void load()}
          variant="outline"
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          Refresh
        </Button>
        <p
          aria-live="polite"
          className="min-h-11 content-center text-muted-foreground text-xs"
          role="status"
        >
          {pending
            ? "Loading flow…"
            : `Auto-refreshes every ${Math.round(refreshMs / 1000)} s.`}
        </p>
      </div>
      {failure === null ? null : (
        <p className="text-sm" data-flow-error="" role="alert">
          {snapshot === null
            ? `Flow snapshot unavailable. ${failure.message}`
            : `Refresh failed (${failure.message}). Showing the last snapshot, as of ${formatNyDateTime(snapshot.windowEnd)}.`}
        </p>
      )}
      {snapshot === null ? null : <SnapshotView snapshot={snapshot} />}
      <p className="text-muted-foreground text-xs">
        Read-only research view. Ticks and depth are sampled, so totals cover
        only the sampled seconds shown above.
      </p>
    </div>
  );
};
