// What: /flow page body: the control panel of the selected symbol's index group (flow.control), the
// tape speed panel of that group's future (flow.tapeSpeed, loaded in its own call), the hedging
// pressure panel of SPY or ES (flow.hedgingPressure, loaded in its own call; not for QQQ and NQ), then
// one symbol's order flow, options flow, GEX levels, events and short-term factors from
// flow.snapshot, with per-source freshness and an "as of" stamp. Symbol select (SPY, QQQ, ES, NQ),
// window select, auto refresh every 60 s and manual refresh. Research only: nothing here places,
// changes or cancels orders, and a state describes recent flow, never a trade signal.
// Used by: apps/web/src/app/(portal)/flow/page.tsx, apps/web/src/lab/entries/research.tsx.
// See: apps/web/src/features/flow/view-model.ts; docs/vertex-rebuild/flow-pipeline.md.
"use client";

import {
  type ApiClient,
  createApiClient,
  type FlowControl,
  type FlowControlInput,
  type FlowHedgingPressure,
  type FlowLiquidityHeatmap,
  type FlowLiveDomStreamEvent,
  type FlowOffExchangeLevels,
  type FlowOffExchangeRange,
  type FlowOptionBubbles,
  type FlowOptionBubblesMinPremiumUsd,
  type FlowPutCallRatio,
  type FlowSnapshot,
  type FlowStrikeHeatmap,
  type FlowStrikeHeatmapBucketMinutes,
  type FlowTapeSpeed,
  type FlowTradeBubbles,
  OPTION_BUBBLES_RULES,
  STRIKE_HEATMAP_RULES,
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
  type FlowControlFailure,
  groupOfSymbol,
} from "../../features/flow/control-view-model.ts";
import {
  enumLabel,
  formatCount,
  formatNyDateTime,
  formatNyTime,
  formatSigned,
} from "../../features/flow/format.ts";
import {
  type HedgingPressureRequest,
  hedgingSymbolOf,
} from "../../features/flow/hedging-pressure-view-model.ts";
import {
  heatmapSymbolOf,
  type LiquidityHeatmapRequest,
} from "../../features/flow/liquidity-heatmap-view-model.ts";
import type { LiveDomStreamRequest } from "../../features/flow/live-dom-view-model.ts";
import {
  type FlowOffExchangeLevelsFailure,
  OFF_EXCHANGE_DEFAULT_RANGE,
  type OffExchangeLevelsRequest,
  offExchangeSymbolOf,
} from "../../features/flow/off-exchange-levels-view-model.ts";
import {
  type FlowOptionBubblesFailure,
  type OptionBubblesRequest,
  optionBubblesSymbolOf,
} from "../../features/flow/option-bubbles-view-model.ts";
import {
  type PutCallRatioRequest,
  putCallRatioSymbolOf,
} from "../../features/flow/put-call-ratio-view-model.ts";
import {
  type FlowStrikeHeatmapFailure,
  type StrikeHeatmapRequest,
  strikeHeatmapSymbolOf,
} from "../../features/flow/strike-heatmap-view-model.ts";
import {
  type TapeSpeedRequest,
  tapeSymbolOf,
} from "../../features/flow/tape-speed-view-model.ts";
import type { TradeBubblesRequest } from "../../features/flow/trade-bubbles-view-model.ts";
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
  failingFreshnessSources,
  freshnessRows,
  gexLevelRows,
  gexMetrics,
  type Metric,
  neverCollected,
  notCollectedLine,
  optionPrintRows,
  optionsMetrics,
  orderFlowMetrics,
  SUMMARY_TONE,
  shortTermBadge,
  VOTE_LABELS,
  voteTone,
  windowLabel,
} from "../../features/flow/view-model.ts";
import { flowWallDriftView } from "../../features/flow/wall-drift-view-model.ts";
import { loadFailedLabel } from "../status-time.ts";
import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import { FLOW_SELECT_CLASS, FlowControlPanel } from "./flow-control-panel.tsx";
import {
  type FlowHedgingPressureFailure,
  FlowHedgingPressurePanel,
} from "./flow-hedging-pressure-panel.tsx";
import {
  type FlowLiquidityHeatmapFailure,
  FlowLiquidityHeatmapPanel,
} from "./flow-liquidity-heatmap-panel.tsx";
import { FlowLiveDomPanel } from "./flow-live-dom-panel.tsx";
import { FlowOffExchangeLevelsPanel } from "./flow-off-exchange-levels-panel.tsx";
import { FlowOptionBubblesPanel } from "./flow-option-bubbles-panel.tsx";
import {
  type FlowPutCallRatioFailure,
  FlowPutCallRatioPanel,
} from "./flow-put-call-ratio-panel.tsx";
import { FlowStrikeHeatmapPanel } from "./flow-strike-heatmap-panel.tsx";
import {
  type FlowTapeSpeedFailure,
  FlowTapeSpeedPanel,
} from "./flow-tape-speed-panel.tsx";
import {
  type FlowTradeBubblesFailure,
  FlowTradeBubblesPanel,
} from "./flow-trade-bubbles-panel.tsx";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";
import { WallDriftBadge } from "./wall-drift-badge.tsx";

export interface FlowGateway {
  readonly control: (input: FlowControlInput) => Promise<FlowControl>;
  readonly hedgingPressure: (
    input: HedgingPressureRequest
  ) => Promise<FlowHedgingPressure>;
  readonly liquidityHeatmap: (
    input: LiquidityHeatmapRequest
  ) => Promise<FlowLiquidityHeatmap>;
  readonly liveDomStream: (
    input: LiveDomStreamRequest,
    options?: Readonly<{ signal?: AbortSignal }>
  ) => Promise<AsyncIterable<FlowLiveDomStreamEvent>>;
  readonly offExchangeLevels: (
    input: OffExchangeLevelsRequest
  ) => Promise<FlowOffExchangeLevels>;
  readonly optionBubbles: (
    input: OptionBubblesRequest
  ) => Promise<FlowOptionBubbles>;
  readonly putCallRatio: (
    input: PutCallRatioRequest
  ) => Promise<FlowPutCallRatio>;
  readonly snapshot: (input: FlowRequest) => Promise<FlowSnapshot>;
  readonly strikeHeatmap: (
    input: StrikeHeatmapRequest
  ) => Promise<FlowStrikeHeatmap>;
  readonly tapeSpeed: (input: TapeSpeedRequest) => Promise<FlowTapeSpeed>;
  readonly tradeBubbles: (
    input: TradeBubblesRequest
  ) => Promise<FlowTradeBubbles>;
}

export const createBrowserFlowGateway = (): FlowGateway => {
  let client: ApiClient | undefined;
  const api = (): ApiClient => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client;
  };
  return Object.freeze({
    control: (input: FlowControlInput) => api().flow.control(input),
    hedgingPressure: (input: HedgingPressureRequest) =>
      api().flow.hedgingPressure(input),
    liquidityHeatmap: (input: LiquidityHeatmapRequest) =>
      api().flow.liquidityHeatmap(input),
    liveDomStream: (
      input: LiveDomStreamRequest,
      options?: Readonly<{ signal?: AbortSignal }>
    ) => api().flow.liveDomStream(input, options),
    offExchangeLevels: (input: OffExchangeLevelsRequest) =>
      api().flow.offExchangeLevels(input),
    optionBubbles: (input: OptionBubblesRequest) =>
      api().flow.optionBubbles(input),
    putCallRatio: (input: PutCallRatioRequest) =>
      api().flow.putCallRatio(input),
    snapshot: (input: FlowRequest) => api().flow.snapshot(input),
    strikeHeatmap: (input: StrikeHeatmapRequest) =>
      api().flow.strikeHeatmap(input),
    tapeSpeed: (input: TapeSpeedRequest) => api().flow.tapeSpeed(input),
    tradeBubbles: (input: TradeBubblesRequest) =>
      api().flow.tradeBubbles(input),
  });
};

const BUY_FILL = "var(--color-success)";
const SELL_FILL = "var(--color-destructive)";

type Failure =
  | Readonly<{ kind: "forbidden" }>
  | Readonly<{ kind: "error"; message: string; failedAt: number }>;

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
        <dd className="font-medium text-sm tabular-nums" title={metric.title}>
          {metric.value}
        </dd>
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

const FreshnessPanel = ({ snapshot }: Readonly<{ snapshot: FlowSnapshot }>) => {
  const failing = failingFreshnessSources(snapshot.freshness);
  const authFailing = failing.filter((row) => row.authFailed);
  const allFresh = snapshot.freshness.every(
    (row) =>
      row.state !== "stale" &&
      row.state !== "never" &&
      row.lastStatus !== "unavailable"
  );
  const [manualOpen, setManualOpen] = useState(false);
  const open = !allFresh || manualOpen;
  return (
    <Panel
      description={
        <span data-flow-as-of="">
          As of{" "}
          <time dateTime={snapshot.windowEnd}>
            {formatNyDateTime(snapshot.windowEnd)}
          </time>
          {" · window "}
          {formatNyTime(snapshot.windowStart)}–
          {formatNyTime(snapshot.windowEnd)}
          {" · generated "}
          <time dateTime={snapshot.generatedAt}>
            {formatNyDateTime(snapshot.generatedAt)}
          </time>
        </span>
      }
      title="Data freshness"
    >
      {failing.length > 0 ? (
        <div
          className="mb-3 space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
          data-flow-auth-alert={authFailing.length > 0 ? "" : undefined}
          data-flow-source-alert=""
          role="alert"
        >
          <p className="font-medium text-destructive">
            {authFailing.length > 0
              ? "Feed authentication failed — owner credential rotation required (never auto-rotated)."
              : "One or more flow sources failed on the latest sample."}
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            {failing.map((row) => (
              <li key={row.source}>
                <span className="font-medium">{row.label}</span>: {row.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {neverCollected(snapshot.freshness) ? (
        <p className="mb-3 text-sm" data-flow-never="" role="note">
          Nothing has been collected for {snapshot.symbol} yet. The flow
          collector fills this page while it runs during market hours.
        </p>
      ) : null}
      {allFresh ? (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <p className="text-sm" data-flow-all-fresh="">
            All sources fresh as of {formatNyTime(snapshot.windowEnd)}
          </p>
          <Button
            aria-expanded={open}
            onClick={() => setManualOpen((value) => !value)}
            size="sm"
            variant="outline"
          >
            {open ? "Hide sources" : "Show sources"}
          </Button>
        </div>
      ) : null}
      {open ? (
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
      ) : null}
    </Panel>
  );
};

const ConfluencePanel = ({
  confluence,
}: Readonly<{ confluence: FlowSnapshot["confluence"] }>) => (
  <Panel
    description={<span role="note">{FLOW_DISCLAIMER}</span>}
    title="Short-term factors (last 15 to 30 min)"
  >
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <StatusBadge
        data-flow-confluence={confluence.summary}
        status={SUMMARY_TONE[confluence.summary]}
      >
        {shortTermBadge(confluence)}
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
            <StatusBadge status={voteTone(factor.vote)}>
              {enumLabel(VOTE_LABELS, factor.vote)}
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
      {chart.slots} minutes with tape; shaded minutes have none.
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
            No minute with tape in this window yet. SPY ticks are sampled every
            few minutes; ES and NQ ticks are streamed.
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
                    <TableHead
                      className="h-auto whitespace-normal font-mono text-xs"
                      scope="row"
                    >
                      {row.expiry} {row.strike}
                      {row.right}
                      <span className="block text-muted-foreground">
                        {row.contract}
                      </span>
                    </TableHead>
                    <TableCell className="text-right">{row.size}</TableCell>
                    <TableCell className="text-right">{row.price}</TableCell>
                    <TableCell className="text-right">{row.premium}</TableCell>
                    <TableCell title={row.sideTitle ?? undefined}>
                      {row.side}
                    </TableCell>
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
                <TableHead className="h-auto whitespace-normal" scope="row">
                  {row.label}
                </TableHead>
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
        <p className="text-muted-foreground text-sm" data-flow-gex-source="">
          Source: QuantData open interest and IV, an estimate. Every expiry is
          priced with the front expiry&apos;s time, so these levels can differ
          from the daily OpenBB gamma flip.
        </p>
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
    <ConfluencePanel confluence={snapshot.confluence} />
    <OrderFlowPanel snapshot={snapshot} />
    <OptionsFlowPanel snapshot={snapshot} />
    <GexPanel snapshot={snapshot} />
    <EventsPanel snapshot={snapshot} />
    <FreshnessPanel snapshot={snapshot} />
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
  const [control, setControl] = useState<FlowControl | null>(null);
  const [controlFailure, setControlFailure] =
    useState<FlowControlFailure | null>(null);
  const [tapeSpeed, setTapeSpeed] = useState<FlowTapeSpeed | null>(null);
  const [tapeSpeedFailure, setTapeSpeedFailure] =
    useState<FlowTapeSpeedFailure | null>(null);
  const [tradeBubbles, setTradeBubbles] = useState<FlowTradeBubbles | null>(
    null
  );
  const [tradeBubblesFailure, setTradeBubblesFailure] =
    useState<FlowTradeBubblesFailure | null>(null);
  const [liquidityHeatmap, setLiquidityHeatmap] =
    useState<FlowLiquidityHeatmap | null>(null);
  const [liquidityHeatmapFailure, setLiquidityHeatmapFailure] =
    useState<FlowLiquidityHeatmapFailure | null>(null);
  const [hedging, setHedging] = useState<FlowHedgingPressure | null>(null);
  const [hedgingFailure, setHedgingFailure] =
    useState<FlowHedgingPressureFailure | null>(null);
  const [putCallRatio, setPutCallRatio] = useState<FlowPutCallRatio | null>(
    null
  );
  const [putCallRatioFailure, setPutCallRatioFailure] =
    useState<FlowPutCallRatioFailure | null>(null);
  const [heatmapBucketMinutes, setHeatmapBucketMinutes] =
    useState<FlowStrikeHeatmapBucketMinutes>(
      STRIKE_HEATMAP_RULES.defaultBucketMinutes
    );
  const [strikeHeatmap, setStrikeHeatmap] = useState<FlowStrikeHeatmap | null>(
    null
  );
  const [strikeHeatmapFailure, setStrikeHeatmapFailure] =
    useState<FlowStrikeHeatmapFailure | null>(null);
  const [strikeHeatmapPending, setStrikeHeatmapPending] = useState(false);
  const [bubblesMinPremiumUsd, setBubblesMinPremiumUsd] =
    useState<FlowOptionBubblesMinPremiumUsd>(
      OPTION_BUBBLES_RULES.defaultMinPremiumUsd
    );
  const [optionBubbles, setOptionBubbles] = useState<FlowOptionBubbles | null>(
    null
  );
  const [optionBubblesFailure, setOptionBubblesFailure] =
    useState<FlowOptionBubblesFailure | null>(null);
  const [optionBubblesPending, setOptionBubblesPending] = useState(false);
  const [offExchangeRange, setOffExchangeRange] =
    useState<FlowOffExchangeRange>(OFF_EXCHANGE_DEFAULT_RANGE);
  const [offExchangeLevels, setOffExchangeLevels] =
    useState<FlowOffExchangeLevels | null>(null);
  const [offExchangeFailure, setOffExchangeFailure] =
    useState<FlowOffExchangeLevelsFailure | null>(null);
  const [offExchangePending, setOffExchangePending] = useState(false);
  const [loadedAt, setLoadedAt] = useState(() => new Date());
  const [pending, setPending] = useState(true);
  // Only the newest request may update the page, so a slow SPY answer never lands on ES.
  const latest = useRef(0);
  // Dedicated sequence counter and bucket ref for flow.strikeHeatmap so bucket changes and Retry
  // refetch only the heatmap without resetting the 60 s refresh timer or refetching other panels.
  const heatmapBucketRef = useRef<FlowStrikeHeatmapBucketMinutes>(
    STRIKE_HEATMAP_RULES.defaultBucketMinutes
  );
  const heatmapLatest = useRef(0);
  // Dedicated sequence counter and floor ref for flow.optionBubbles so floor changes and Retry
  // refetch only the bubbles panel without resetting the 60 s refresh timer or refetching other panels.
  const bubblesMinPremiumRef = useRef<FlowOptionBubblesMinPremiumUsd>(
    OPTION_BUBBLES_RULES.defaultMinPremiumUsd
  );
  const bubblesLatest = useRef(0);
  // Dedicated sequence counter and range ref for flow.offExchangeLevels (SPY only).
  const offExchangeRangeRef = useRef<FlowOffExchangeRange>(
    OFF_EXCHANGE_DEFAULT_RANGE
  );
  const offExchangeLatest = useRef(0);
  // A forbidden tape speed answer holds the access screen until a tape speed answer that is not
  // forbidden arrives, also when the snapshot of a later load answers first.
  const tapeForbidden = useRef(false);
  const tradeBubblesForbidden = useRef(false);
  const heatmapForbidden = useRef(false);
  // The same hold for a forbidden hedging pressure answer, set and cleared by hedging answers only.
  const hedgingForbidden = useRef(false);
  // The same hold for a forbidden put/call ratio answer, set and cleared by put/call answers only.
  const putCallForbidden = useRef(false);
  // The same hold for a forbidden strike heatmap answer, set and cleared by strike heatmap answers only.
  const strikeHeatmapForbidden = useRef(false);
  // The same hold for a forbidden option bubbles answer, set and cleared by option bubbles answers only.
  const optionBubblesForbidden = useRef(false);
  // The same hold for a forbidden off-exchange levels answer, set and cleared by off-exchange answers only.
  const offExchangeForbidden = useRef(false);

  const loadStrikeHeatmap = useCallback(
    (
      targetSymbol: FlowSymbol,
      targetBucketMinutes: FlowStrikeHeatmapBucketMinutes
    ) => {
      heatmapLatest.current += 1;
      const heatmapRequest = heatmapLatest.current;
      const targetHeatmapSymbol = strikeHeatmapSymbolOf(targetSymbol);
      if (targetHeatmapSymbol === null) {
        strikeHeatmapForbidden.current = false;
        setStrikeHeatmap(null);
        setStrikeHeatmapFailure(null);
        setStrikeHeatmapPending(false);
        return;
      }
      setStrikeHeatmapPending(true);
      void gateway
        .strikeHeatmap({
          bucketMinutes: targetBucketMinutes,
          symbol: targetHeatmapSymbol,
        })
        .then(
          (response) => {
            if (heatmapRequest !== heatmapLatest.current) return;
            strikeHeatmapForbidden.current = false;
            setStrikeHeatmap(response);
            setStrikeHeatmapFailure(null);
            setStrikeHeatmapPending(false);
          },
          (reason: unknown) => {
            if (heatmapRequest !== heatmapLatest.current) return;
            setStrikeHeatmapPending(false);
            const described = describePortfolioMonitorFailure(reason);
            strikeHeatmapForbidden.current = described.kind === "forbidden";
            if (described.kind === "forbidden")
              setFailure({ kind: "forbidden" });
            else
              setStrikeHeatmapFailure({
                code: described.code,
                failedAt: Date.now(),
                message: described.message,
              });
          }
        );
    },
    [gateway]
  );

  const loadOptionBubbles = useCallback(
    (
      targetSymbol: FlowSymbol,
      targetMinPremiumUsd: FlowOptionBubblesMinPremiumUsd
    ) => {
      bubblesLatest.current += 1;
      const bubblesRequest = bubblesLatest.current;
      const targetBubblesSymbol = optionBubblesSymbolOf(targetSymbol);
      if (targetBubblesSymbol === null) {
        optionBubblesForbidden.current = false;
        setOptionBubbles(null);
        setOptionBubblesFailure(null);
        setOptionBubblesPending(false);
        return;
      }
      setOptionBubblesPending(true);
      void gateway
        .optionBubbles({
          minPremiumUsd: targetMinPremiumUsd,
          symbol: targetBubblesSymbol,
        })
        .then(
          (response) => {
            if (bubblesRequest !== bubblesLatest.current) return;
            optionBubblesForbidden.current = false;
            setOptionBubbles(response);
            setOptionBubblesFailure(null);
            setOptionBubblesPending(false);
          },
          (reason: unknown) => {
            if (bubblesRequest !== bubblesLatest.current) return;
            setOptionBubblesPending(false);
            const described = describePortfolioMonitorFailure(reason);
            optionBubblesForbidden.current = described.kind === "forbidden";
            if (described.kind === "forbidden")
              setFailure({ kind: "forbidden" });
            else
              setOptionBubblesFailure({
                code: described.code,
                failedAt: Date.now(),
                message: described.message,
              });
          }
        );
    },
    [gateway]
  );

  const loadOffExchangeLevels = useCallback(
    (targetSymbol: FlowSymbol, targetRange: FlowOffExchangeRange) => {
      offExchangeLatest.current += 1;
      const offExchangeRequest = offExchangeLatest.current;
      const targetOffExchangeSymbol = offExchangeSymbolOf(targetSymbol);
      if (targetOffExchangeSymbol === null) {
        offExchangeForbidden.current = false;
        setOffExchangeLevels(null);
        setOffExchangeFailure(null);
        setOffExchangePending(false);
        return;
      }
      setOffExchangePending(true);
      void gateway
        .offExchangeLevels({
          range: targetRange,
          symbol: targetOffExchangeSymbol,
        })
        .then(
          (response) => {
            if (offExchangeRequest !== offExchangeLatest.current) return;
            offExchangeForbidden.current = false;
            setOffExchangeLevels(response);
            setOffExchangeFailure(null);
            setOffExchangePending(false);
          },
          (reason: unknown) => {
            if (offExchangeRequest !== offExchangeLatest.current) return;
            setOffExchangePending(false);
            const described = describePortfolioMonitorFailure(reason);
            offExchangeForbidden.current = described.kind === "forbidden";
            if (described.kind === "forbidden")
              setFailure({ kind: "forbidden" });
            else
              setOffExchangeFailure({
                code: described.code,
                failedAt: Date.now(),
                message: described.message,
              });
          }
        );
    },
    [gateway]
  );

  const load = useCallback(async () => {
    latest.current += 1;
    const request = latest.current;
    setPending(true);
    // Tape speed has its own call and is not awaited with the other two: a slow or failed answer
    // changes only its panel. Only the newest request may update it. A forbidden answer is the
    // one exception: it shows the access screen, also when the snapshot answers after it.
    void gateway.tapeSpeed({ minutes, symbol: tapeSymbolOf(symbol) }).then(
      (document) => {
        if (request !== latest.current) return;
        tapeForbidden.current = false;
        setTapeSpeed(document);
        setTapeSpeedFailure(null);
      },
      (reason: unknown) => {
        if (request !== latest.current) return;
        const described = describePortfolioMonitorFailure(reason);
        // Any other answer of the newest request ends the hold of an earlier forbidden answer.
        tapeForbidden.current = described.kind === "forbidden";
        if (described.kind === "forbidden") setFailure({ kind: "forbidden" });
        else
          setTapeSpeedFailure({
            code: described.code,
            failedAt: Date.now(),
            message: described.message,
          });
      }
    );
    void gateway.tradeBubbles({ minutes, symbol: tapeSymbolOf(symbol) }).then(
      (document) => {
        if (request !== latest.current) return;
        tradeBubblesForbidden.current = false;
        setTradeBubbles(document);
        setTradeBubblesFailure(null);
      },
      (reason: unknown) => {
        if (request !== latest.current) return;
        const described = describePortfolioMonitorFailure(reason);
        tradeBubblesForbidden.current = described.kind === "forbidden";
        if (described.kind === "forbidden") setFailure({ kind: "forbidden" });
        else
          setTradeBubblesFailure({
            code: described.code,
            failedAt: Date.now(),
            message: described.message,
          });
      }
    );
    void gateway
      .liquidityHeatmap({ minutes, symbol: heatmapSymbolOf(symbol) })
      .then(
        (document) => {
          if (request !== latest.current) return;
          heatmapForbidden.current = false;
          setLiquidityHeatmap(document);
          setLiquidityHeatmapFailure(null);
        },
        (reason: unknown) => {
          if (request !== latest.current) return;
          const described = describePortfolioMonitorFailure(reason);
          heatmapForbidden.current = described.kind === "forbidden";
          if (described.kind === "forbidden") setFailure({ kind: "forbidden" });
          else
            setLiquidityHeatmapFailure({
              code: described.code,
              failedAt: Date.now(),
              message: described.message,
            });
        }
      );
    // Hedging pressure follows the same rules in its own call. QQQ and NQ have no option prints:
    // no call and no panel.
    const hedgingSymbol = hedgingSymbolOf(symbol);
    if (hedgingSymbol === null) {
      hedgingForbidden.current = false;
      setHedging(null);
      setHedgingFailure(null);
    } else
      void gateway.hedgingPressure({ symbol: hedgingSymbol }).then(
        (response) => {
          if (request !== latest.current) return;
          hedgingForbidden.current = false;
          setHedging(response);
          setHedgingFailure(null);
        },
        (reason: unknown) => {
          if (request !== latest.current) return;
          const described = describePortfolioMonitorFailure(reason);
          hedgingForbidden.current = described.kind === "forbidden";
          if (described.kind === "forbidden") setFailure({ kind: "forbidden" });
          else
            setHedgingFailure({
              code: described.code,
              failedAt: Date.now(),
              message: described.message,
            });
        }
      );
    // Put/call ratio follows the same rules in its own call (SPY and ES only).
    const putCallSymbol = putCallRatioSymbolOf(symbol);
    if (putCallSymbol === null) {
      putCallForbidden.current = false;
      setPutCallRatio(null);
      setPutCallRatioFailure(null);
    } else
      void gateway.putCallRatio({ symbol: putCallSymbol }).then(
        (response) => {
          if (request !== latest.current) return;
          putCallForbidden.current = false;
          setPutCallRatio(response);
          setPutCallRatioFailure(null);
        },
        (reason: unknown) => {
          if (request !== latest.current) return;
          const described = describePortfolioMonitorFailure(reason);
          putCallForbidden.current = described.kind === "forbidden";
          if (described.kind === "forbidden") setFailure({ kind: "forbidden" });
          else
            setPutCallRatioFailure({
              code: described.code,
              failedAt: Date.now(),
              message: described.message,
            });
        }
      );
    // Strike heatmap follows the same rules in its own call (SPY and ES only).
    loadStrikeHeatmap(symbol, heatmapBucketRef.current);
    // Option print bubbles follow the same rules in their own call (SPY and ES only).
    loadOptionBubbles(symbol, bubblesMinPremiumRef.current);
    // Off-exchange print levels follow the same rules in their own call (SPY only).
    loadOffExchangeLevels(symbol, offExchangeRangeRef.current);
    const [snapshotResult, controlResult] = await Promise.allSettled([
      gateway.snapshot({ minutes, symbol }),
      gateway.control({ group: groupOfSymbol(symbol) }),
    ]);
    if (request !== latest.current) return;
    setLoadedAt(new Date());
    if (snapshotResult.status === "fulfilled") {
      setSnapshot(snapshotResult.value);
      setFailure(null);
    } else {
      const described = describePortfolioMonitorFailure(snapshotResult.reason);
      setFailure(
        described.kind === "forbidden"
          ? { kind: "forbidden" }
          : {
              failedAt: Date.now(),
              kind: "error",
              message: `${described.code}: ${described.message}`,
            }
      );
    }
    if (controlResult.status === "fulfilled") {
      setControl(controlResult.value);
      setControlFailure(null);
    } else {
      const described = describePortfolioMonitorFailure(controlResult.reason);
      if (described.kind === "forbidden") setFailure({ kind: "forbidden" });
      else
        setControlFailure({ code: described.code, message: described.message });
    }
    // A forbidden tape speed, trade bubbles, liquidity heatmap, hedging pressure, put/call ratio, strike heatmap, option bubbles or off-exchange levels answer stays in force.
    if (
      tapeForbidden.current ||
      tradeBubblesForbidden.current ||
      heatmapForbidden.current ||
      hedgingForbidden.current ||
      putCallForbidden.current ||
      strikeHeatmapForbidden.current ||
      optionBubblesForbidden.current ||
      offExchangeForbidden.current
    )
      setFailure({ kind: "forbidden" });
    setPending(false);
  }, [
    gateway,
    loadOffExchangeLevels,
    loadOptionBubbles,
    loadStrikeHeatmap,
    minutes,
    symbol,
  ]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => {
      window.clearInterval(timer);
      latest.current += 1;
      heatmapLatest.current += 1;
      bubblesLatest.current += 1;
      offExchangeLatest.current += 1;
    };
  }, [load, refreshMs]);

  const handleHeatmapBucketChange = useCallback(
    (next: FlowStrikeHeatmapBucketMinutes) => {
      heatmapBucketRef.current = next;
      setHeatmapBucketMinutes(next);
      loadStrikeHeatmap(symbol, next);
    },
    [loadStrikeHeatmap, symbol]
  );

  const handleHeatmapRetry = useCallback(() => {
    loadStrikeHeatmap(symbol, heatmapBucketRef.current);
  }, [loadStrikeHeatmap, symbol]);

  const handleBubblesMinPremiumChange = useCallback(
    (next: FlowOptionBubblesMinPremiumUsd) => {
      bubblesMinPremiumRef.current = next;
      setBubblesMinPremiumUsd(next);
      loadOptionBubbles(symbol, next);
    },
    [loadOptionBubbles, symbol]
  );

  const handleBubblesRetry = useCallback(() => {
    loadOptionBubbles(symbol, bubblesMinPremiumRef.current);
  }, [loadOptionBubbles, symbol]);

  const handleOffExchangeRangeChange = useCallback(
    (next: FlowOffExchangeRange) => {
      offExchangeRangeRef.current = next;
      setOffExchangeRange(next);
      loadOffExchangeLevels(symbol, next);
    },
    [loadOffExchangeLevels, symbol]
  );

  const handleOffExchangeRetry = useCallback(() => {
    loadOffExchangeLevels(symbol, offExchangeRangeRef.current);
  }, [loadOffExchangeLevels, symbol]);

  if (failure?.kind === "forbidden")
    return <OperatorAccessRequired feature="flow" />;
  const notCollected = notCollectedLine(symbol);

  const hedgingSymbol = hedgingSymbolOf(symbol);
  const putCallSymbol = putCallRatioSymbolOf(symbol);
  const heatmapSymbol = strikeHeatmapSymbolOf(symbol);
  const bubblesSymbol = optionBubblesSymbolOf(symbol);
  const offExchangeSymbol = offExchangeSymbolOf(symbol);

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
                  // Hedging pressure, put/call ratio, and strike heatmap show the symbol itself.
                  setHedging(null);
                  setHedgingFailure(null);
                  setPutCallRatio(null);
                  setPutCallRatioFailure(null);
                  heatmapLatest.current += 1;
                  setStrikeHeatmap(null);
                  setStrikeHeatmapFailure(null);
                  bubblesLatest.current += 1;
                  setOptionBubbles(null);
                  setOptionBubblesFailure(null);
                  offExchangeLatest.current += 1;
                  setOffExchangeLevels(null);
                  setOffExchangeFailure(null);
                  // The control panel and the tape speed panel show the group's future.
                  if (groupOfSymbol(option) !== groupOfSymbol(symbol)) {
                    setControl(null);
                    setControlFailure(null);
                    setTapeSpeed(null);
                    setTapeSpeedFailure(null);
                    setLiquidityHeatmap(null);
                    setLiquidityHeatmapFailure(null);
                  }
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
            className={FLOW_SELECT_CLASS}
            data-flow-window=""
            onChange={(event) => {
              setSnapshot(null);
              setTapeSpeed(null);
              setTapeSpeedFailure(null);
              setLiquidityHeatmap(null);
              setLiquidityHeatmapFailure(null);
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
            ? `${loadFailedLabel(failure.failedAt)} · Flow snapshot not loaded: ${failure.message} · retrying every ${Math.round(refreshMs / 1000)} s`
            : `${loadFailedLabel(failure.failedAt)} · Refresh failed: ${failure.message} · showing the snapshot as of ${formatNyDateTime(snapshot.windowEnd)} · retrying every ${Math.round(refreshMs / 1000)} s`}
        </p>
      )}
      <WallDriftBadge
        heading="h2"
        view={flowWallDriftView(
          snapshot,
          failure?.kind === "error" ? failure.message : null,
          control === null
            ? controlFailure === null
              ? { kind: "loading" }
              : {
                  kind: "failed",
                  message: `${controlFailure.code}: ${controlFailure.message}`,
                }
            : { control, kind: "ready" },
          loadedAt
        )}
      />
      <FlowControlPanel
        control={control}
        failure={controlFailure}
        now={loadedAt}
        refreshMs={refreshMs}
      />
      {notCollected === null ? null : (
        <p className="text-muted-foreground text-sm" data-flow-not-collected="">
          {notCollected}
        </p>
      )}
      <FlowTapeSpeedPanel
        document={tapeSpeed}
        failure={tapeSpeedFailure}
        refreshMs={refreshMs}
        symbol={symbol}
      />
      <FlowLiveDomPanel gateway={gateway} symbol={symbol} />
      <FlowTradeBubblesPanel
        document={tradeBubbles}
        failure={tradeBubblesFailure}
        refreshMs={refreshMs}
        symbol={symbol}
      />
      <FlowLiquidityHeatmapPanel
        document={liquidityHeatmap}
        failure={liquidityHeatmapFailure}
        refreshMs={refreshMs}
        symbol={symbol}
      />
      {hedgingSymbol === null ? null : (
        <FlowHedgingPressurePanel
          document={hedging}
          failure={hedgingFailure}
          refreshMs={refreshMs}
          symbol={hedgingSymbol}
        />
      )}
      {putCallSymbol === null ? null : (
        <FlowPutCallRatioPanel
          document={putCallRatio}
          failure={putCallRatioFailure}
          refreshMs={refreshMs}
          symbol={putCallSymbol}
        />
      )}
      {bubblesSymbol === null ? null : (
        <FlowOptionBubblesPanel
          document={
            optionBubbles?.symbol === bubblesSymbol ? optionBubbles : null
          }
          failure={optionBubblesFailure}
          minPremiumUsd={bubblesMinPremiumUsd}
          onMinPremiumChange={handleBubblesMinPremiumChange}
          onRetry={handleBubblesRetry}
          pending={optionBubblesPending}
          refreshMs={refreshMs}
          symbol={bubblesSymbol}
        />
      )}
      {heatmapSymbol === null ? null : (
        <FlowStrikeHeatmapPanel
          bucketMinutes={heatmapBucketMinutes}
          document={
            strikeHeatmap?.symbol === heatmapSymbol ? strikeHeatmap : null
          }
          failure={strikeHeatmapFailure}
          onBucketMinutesChange={handleHeatmapBucketChange}
          onRetry={handleHeatmapRetry}
          pending={strikeHeatmapPending}
          refreshMs={refreshMs}
          symbol={heatmapSymbol}
        />
      )}
      {offExchangeSymbol === null ? null : (
        <FlowOffExchangeLevelsPanel
          document={
            offExchangeLevels?.symbol === offExchangeSymbol
              ? offExchangeLevels
              : null
          }
          failure={offExchangeFailure}
          onRangeChange={handleOffExchangeRangeChange}
          onRetry={handleOffExchangeRetry}
          pending={offExchangePending}
          range={offExchangeRange}
          refreshMs={refreshMs}
          symbol={offExchangeSymbol}
        />
      )}
      {snapshot === null ? null : <SnapshotView snapshot={snapshot} />}
      <p className="text-muted-foreground text-xs">
        Read-only research view. ES and NQ live DOM streams from active CME L2
        depth and tape (recorded fallback when offline), while historical depth
        is recorded (5 s streamed, 1 min sampled fallback); SPY depth and SPY
        ticks are sampled, so their totals cover only the seconds shown above.
      </p>
    </div>
  );
};
