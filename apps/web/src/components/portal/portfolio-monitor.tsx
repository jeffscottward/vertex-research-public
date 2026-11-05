"use client";

import type {
  PortfolioMonitorMessage,
  PortfolioMonitorOutput,
  PortfolioMonitorPosition,
} from "@darkfactory/api";
import { Button, Skeleton, StatusBadge, cn } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import {
  AllocationChart,
  PnlChart,
  StopLadders,
} from "./portfolio-monitor-charts.tsx";
import {
  createBrowserPortfolioMonitorGateway,
  describePortfolioMonitorFailure,
  type PortfolioMonitorFailure,
  type PortfolioMonitorGateway,
} from "./portfolio-monitor-client.ts";
import { usePositionActions } from "./position-actions.tsx";
import { useStoredState } from "./portfolio-monitor-controls.tsx";
import type { VertexOrdersGateway } from "./vertex-orders-client.ts";
import {
  PNL_TONE_CLASS,
  REFRESH_INTERVALS,
  accountLabel,
  ageSeconds,
  clock,
  completedToday,
  isGatewayLive,
  isOptionPosition,
  monitorHealth,
  normalizeInterval,
  summaryStats,
  type Health,
  type MonitorSection,
} from "./portfolio-monitor-model.ts";
import {
  ExecutionsTable,
  OrdersTable,
  PositionsPanel,
  type RoundHandleFlags,
  roundHandleFlags,
} from "./portfolio-monitor-tables.tsx";

export const INTERVAL_STORAGE_KEY = "vertex.monitor.interval.v1";
const ORDER_ACTIONS_NOTICE =
  "Close, Buy and Sell open a confirm dialog. Nothing is sent until you confirm there.";
export const READ_ONLY_NOTICE =
  "Read-only view of IBKR. Orders cannot be placed, changed or cancelled here.";

export interface PortfolioMonitorProps {
  readonly gateway?: PortfolioMonitorGateway;
  // false: the server has no portfolio service address; no request is sent.
  readonly configured?: boolean;
  // Heading text; the Portfolio tab names its source.
  readonly title?: string;
  // The page owns the tab strip (portfolio-tabs.tsx) and picks the one section shown here.
  readonly section: MonitorSection;
  // Owner order buttons (Close / Buy / Sell) per position; absent => read-only table.
  readonly ordersGateway?: VertexOrdersGateway;
}

type PositionActionCell = (
  position: PortfolioMonitorPosition,
  positions: readonly PortfolioMonitorPosition[]
) => ReactNode;

const NOT_CONFIGURED_FAILURE: PortfolioMonitorFailure = Object.freeze({
  kind: "not-configured",
  code: "NOT_CONFIGURED",
  message: "VERTEX_PORTFOLIO_URL is not set on this server",
});

// Polling cannot fix these, so the feed stops until the operator retries.
const TERMINAL_FAILURES: Readonly<Partial<Record<string, true>>> = {
  forbidden: true,
  "not-configured": true,
  unauthorized: true,
};

type Feed = Readonly<{
  snapshot: PortfolioMonitorOutput | null;
  failure: PortfolioMonitorFailure | null;
  fetchedAt: number | null;
}>;

// Polls the snapshot. A failed request keeps the last good snapshot and records the failure.
// A terminal failure stops the polling; "Retry now" starts it again. `notConfigured` is the
// failure shown when `enabled` is false (it names the server setting that is missing).
export const useSnapshotFeed = (
  gateway: PortfolioMonitorGateway,
  intervalS: number,
  reloadKey: number,
  enabled: boolean,
  notConfigured: PortfolioMonitorFailure = NOT_CONFIGURED_FAILURE
): Feed => {
  const [feed, setFeed] = useState<Feed>({
    snapshot: null,
    failure: enabled ? null : notConfigured,
    fetchedAt: null,
  });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let busy = false;
    // After a terminal failure (401/403/not configured) neither the timer nor
    // a return to the tab sends another request; only "Retry now" does.
    let stopped = false;
    let timer: number | undefined;
    const load = async (): Promise<void> => {
      if (busy || stopped) return;
      busy = true;
      try {
        const snapshot = await gateway.snapshot();
        if (alive) setFeed({ snapshot, failure: null, fetchedAt: Date.now() });
      } catch (error) {
        const failure = describePortfolioMonitorFailure(error);
        if (TERMINAL_FAILURES[failure.kind]) {
          stopped = true;
          window.clearInterval(timer);
        }
        if (alive) setFeed((current) => ({ ...current, failure }));
      }
      busy = false;
    };
    void load();
    timer = window.setInterval(() => void load(), intervalS * 1000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
      return;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.clearInterval(timer);
      return document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, gateway, intervalS, reloadKey]);
  return feed;
};

const ROUND_HANDLE_INTERVAL_MS = 60_000;

type RoundHandleFeed = Readonly<{
  flags: RoundHandleFlags | null;
  failed: boolean;
}>;

// Polls the round-number check once a minute while Orders & stops is open, when the source has it.
const useRoundHandles = (
  gateway: PortfolioMonitorGateway,
  enabled: boolean
): RoundHandleFeed => {
  const [feed, setFeed] = useState<RoundHandleFeed>({
    flags: null,
    failed: false,
  });
  const read = gateway.roundHandles;
  useEffect(() => {
    if (!enabled || read === undefined) return;
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const check = await read();
        if (alive)
          setFeed({ flags: roundHandleFlags(check.flags), failed: false });
      } catch {
        if (alive) setFeed({ flags: null, failed: true });
      }
    };
    void load();
    const timer = window.setInterval(
      () => void load(),
      ROUND_HANDLE_INTERVAL_MS
    );
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [enabled, read]);
  return feed;
};

// One-second clock for the "N s ago" text and the stale rule.
export const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
};

const StatSub = ({ text }: { readonly text: string }) => (
  <dd className="text-muted-foreground text-xs tabular-nums">{text}</dd>
);

const SummaryGrid = ({
  snapshot,
}: {
  readonly snapshot: PortfolioMonitorOutput;
}) => (
  <dl
    aria-label="Account summary"
    className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
  >
    {summaryStats(snapshot).map((stat) => {
      return (
        <div
          className="min-w-0 rounded-md border border-border bg-surface p-3"
          data-stat={stat.key}
          key={stat.key}
        >
          <dt className="text-muted-foreground text-xs">{stat.label}</dt>
          <dd
            className={cn(
              "mt-0.5 truncate font-semibold text-lg tabular-nums",
              PNL_TONE_CLASS[stat.tone]
            )}
          >
            {stat.value}
          </dd>
          {stat.sub === null ? null : <StatSub text={stat.sub} />}
        </div>
      );
    })}
  </dl>
);

const MessageList = ({
  messages,
}: {
  readonly messages: readonly PortfolioMonitorMessage[];
}) => {
  if (messages.length === 0) return null;
  return (
    <details
      className="rounded-md border border-border px-3 text-muted-foreground text-xs"
      data-api-messages="true"
    >
      <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        API messages ({messages.length})
      </summary>
      <ul className="space-y-1 pb-3 tabular-nums">
        {messages.map((message, index) => {
          return (
            <li key={`${message.at}-${index}`}>
              {`${clock(message.at)} [${message.code}] ${message.message}`}
            </li>
          );
        })}
      </ul>
    </details>
  );
};

export const Banner = ({
  age,
  failure,
  fetchedAt,
  health,
  snapshot,
}: {
  readonly age: number | null;
  readonly failure: PortfolioMonitorFailure | null;
  readonly fetchedAt: number | null;
  readonly health: Health;
  readonly snapshot: PortfolioMonitorOutput;
}) => {
  if (failure !== null) {
    return (
      <p
        className="rounded-md border border-destructive-border bg-destructive-subtle px-3 py-2 text-destructive text-sm"
        data-banner="failure"
        role="alert"
      >
        {`Cannot load a new snapshot (${failure.code}: ${failure.message}). Values below are from the last successful update at ${clock(fetchedAt)}.`}
      </p>
    );
  }
  if (health.key === "live") return null;
  const detail =
    health.key === "stale"
      ? age === null
        ? "The IBKR data time is unknown."
        : `The IBKR data is ${Math.round(age)} s old.`
      : `IBKR gateway: ${snapshot.status.gateway}.`;
  const lastError =
    snapshot.status.lastError === null ? "" : ` ${snapshot.status.lastError}`;
  return (
    <p
      className="rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning-foreground"
      data-banner={health.key}
      role="status"
    >
      {`${detail}${lastError} Values may be out of date.`}
    </p>
  );
};

const LoadingState = () => (
  <div
    aria-busy="true"
    className="space-y-3"
    data-monitor-state="loading"
    role="status"
  >
    <span className="sr-only">Loading IBKR snapshot</span>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {Array.from({ length: 12 }, (_, index) => (
        <Skeleton className="h-[4.5rem]" key={index} />
      ))}
    </div>
    <Skeleton className="h-64" />
  </div>
);

export const FailureState = ({
  failure,
  onRetry,
}: {
  readonly failure: PortfolioMonitorFailure;
  readonly onRetry: () => void;
}) => {
  const notConfigured = failure.kind === "not-configured";
  return (
    <div
      className="space-y-2 rounded-md border border-border p-4"
      data-monitor-state={failure.kind}
      role={notConfigured ? "status" : "alert"}
    >
      <p className="font-medium text-sm">
        {notConfigured
          ? "IBKR monitor not configured"
          : "Cannot load the IBKR snapshot"}
      </p>
      <p className="text-muted-foreground text-sm">
        {notConfigured
          ? "This server has no address for the IBKR portfolio service, so there is no account data to show."
          : "The server or the IBKR portfolio service did not answer. No account values are shown because none were loaded."}
      </p>
      <p
        className="text-muted-foreground text-xs"
        data-failure-code={failure.code}
      >
        {`${failure.code}: ${failure.message}`}
      </p>
      <Button onClick={onRetry} size="compact" variant="secondary">
        <RotateCcw aria-hidden="true" className="size-4" />
        Retry now
      </Button>
    </div>
  );
};

export const ForbiddenState = () => (
  <div className="space-y-2" data-monitor-state="forbidden">
    <OperatorAccessRequired feature="ibkr-monitor" />
  </div>
);

const SectionBody = ({
  actions,
  handles,
  nowMs,
  section,
  snapshot,
}: {
  readonly actions?: PositionActionCell | undefined;
  readonly handles: RoundHandleFeed;
  readonly nowMs: number;
  readonly section: MonitorSection;
  readonly snapshot: PortfolioMonitorOutput;
}) => {
  const live = isGatewayLive(snapshot);
  switch (section) {
    case "orders-stops": {
      return (
        <div className="space-y-8">
          {handles.failed ? (
            <p
              className="text-muted-foreground text-xs"
              data-round-handle-state="unavailable"
            >
              Round-number check unavailable. Order prices are not flagged.
            </p>
          ) : null}
          <OrdersTable
            empty="No open orders."
            handles={handles.flags ?? undefined}
            live={live}
            orders={snapshot.orders}
            title="Open orders"
            titleId="pm-open-orders-title"
          />
          <StopLadders
            live={live}
            orders={snapshot.orders}
            positions={snapshot.positions}
          />
          <ExecutionsTable executions={snapshot.executions} live={live} />
          <OrdersTable
            completed
            empty="No completed or cancelled orders today."
            live={live}
            orders={completedToday(snapshot.completed, new Date(nowMs))}
            title="Completed / cancelled today"
            titleId="pm-completed-title"
          />
        </div>
      );
    }
    case "pnl": {
      return <PnlChart positions={snapshot.positions} />;
    }
    case "allocation": {
      return (
        <AllocationChart
          nlv={snapshot.summary.netLiquidation}
          positions={snapshot.positions}
        />
      );
    }
    case "options": {
      return (
        <PositionsPanel
          empty="No option positions."
          live={live}
          actions={actions}
          positions={snapshot.positions.filter(isOptionPosition)}
          title="Option positions"
        />
      );
    }
    default: {
      return (
        <PositionsPanel
          actions={actions}
          live={live}
          positions={snapshot.positions}
        />
      );
    }
  }
};

const MonitorBody = ({
  actions,
  handles,
  nowMs,
  section,
  snapshot,
}: {
  readonly actions?: PositionActionCell | undefined;
  readonly handles: RoundHandleFeed;
  readonly nowMs: number;
  readonly section: MonitorSection;
  readonly snapshot: PortfolioMonitorOutput;
}) => (
  <div className="space-y-6">
    <SummaryGrid snapshot={snapshot} />
    <SectionBody
      actions={actions}
      handles={handles}
      nowMs={nowMs}
      section={section}
      snapshot={snapshot}
    />
    <MessageList messages={snapshot.messages} />
  </div>
);

const AccountBadge = ({ mode }: { readonly mode: string }) => (
  <StatusBadge
    data-account-mode={mode}
    status={mode === "live" ? "info" : "neutral"}
  >
    {accountLabel(mode)}
  </StatusBadge>
);

// Read-only IBKR monitor. It polls portfolioMonitor.snapshot and never sends anything to IBKR.
export const PortfolioMonitor = ({
  gateway: suppliedGateway,
  configured = true,
  title = "IBKR monitor",
  section,
  ordersGateway,
}: PortfolioMonitorProps) => {
  const orderActions = usePositionActions(ordersGateway);
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserPortfolioMonitorGateway()
  );
  const [intervalS, setIntervalS] = useStoredState(
    INTERVAL_STORAGE_KEY,
    normalizeInterval
  );
  const [reloadKey, setReloadKey] = useState(0);
  const { failure, fetchedAt, snapshot } = useSnapshotFeed(
    gateway,
    intervalS,
    reloadKey,
    configured
  );
  const handles = useRoundHandles(
    gateway,
    configured && section === "orders-stops"
  );
  const nowMs = useNow();
  const health = monitorHealth({
    snapshot,
    failureKind: failure?.kind ?? null,
    nowMs,
    intervalS,
  });
  const age =
    snapshot === null ? null : ageSeconds(snapshot.status.dataAsOf, nowMs);
  const freshness = `Data as of ${clock(snapshot?.status.dataAsOf)}${age === null ? "" : ` (${Math.round(age)} s ago)`} · fetched ${clock(fetchedAt)}`;
  const retry = () => setReloadKey((key) => key + 1);

  const body =
    failure?.kind === "forbidden" ? (
      <ForbiddenState />
    ) : snapshot === null ? (
      failure === null ? (
        <LoadingState />
      ) : (
        <FailureState failure={failure} onRetry={retry} />
      )
    ) : (
      <>
        <Banner
          age={age}
          failure={failure}
          fetchedAt={fetchedAt}
          health={health}
          snapshot={snapshot}
        />
        <MonitorBody
          actions={orderActions?.cell}
          handles={handles}
          nowMs={nowMs}
          section={section}
          snapshot={snapshot}
        />
      </>
    );

  return (
    <section
      aria-labelledby="pm-title"
      className="space-y-4"
      data-portfolio-monitor="true"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="font-heading font-semibold text-lg" id="pm-title">
            {title}
          </h2>
          <p
            className="text-muted-foreground text-xs tabular-nums"
            data-freshness="true"
          >
            {freshness}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge data-health={health.key} status={health.tone}>
            {health.label}
          </StatusBadge>
          {snapshot === null ? null : (
            <AccountBadge mode={snapshot.account.mode} />
          )}
          <label
            className="text-muted-foreground text-xs"
            htmlFor="pm-interval"
          >
            Refresh
          </label>
          <select
            className="min-h-11 rounded-md border border-border-strong bg-surface px-2 text-foreground text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            id="pm-interval"
            onChange={(event) =>
              setIntervalS(normalizeInterval(Number(event.target.value)))
            }
            value={intervalS}
          >
            {REFRESH_INTERVALS.map((seconds) => {
              return (
                <option key={seconds} value={seconds}>
                  {`every ${seconds} s`}
                </option>
              );
            })}
          </select>
        </div>
      </header>
      <p className="text-muted-foreground text-xs" role="note">
        {orderActions === null ? READ_ONLY_NOTICE : ORDER_ACTIONS_NOTICE}
      </p>
      {body}
      {orderActions?.dialog}
    </section>
  );
};
