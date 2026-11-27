"use client";

import {
  type ApiClient,
  createApiClient,
  type MarketRegimeOutput,
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
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildRegimeRowViews,
  type RegimePillarCellView,
  regimeSourceStatus,
  summaryBadgeFor,
} from "../../features/market-regime/view-model.ts";
import { utcClock } from "../status-time.ts";
import { TickerLink } from "../ticker-link.tsx";
import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import type { MarketSourceStatus } from "./market-source-status.ts";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

// Unified market regime section (card vertex-regime-view, marketRegime.get): joins trend
// (50/200d SMA), Breadth-90, dealer gamma, credit (HY OAS), and volatility (level + term
// structure) for QQQ, SPY, IWM and DIA. Research context only; never authorizes a trade.

export interface MarketRegimeGateway {
  readonly get: () => Promise<MarketRegimeOutput>;
}

const createBrowserMarketRegimeGateway = (): MarketRegimeGateway => {
  let client: ApiClient | undefined;
  return Object.freeze({
    get: () => {
      client ??= createApiClient({ baseUrl: window.location.origin });
      return client.marketRegime.get({});
    },
  });
};

export const MARKET_REGIME_REFRESH_MS = 60_000;

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{
      type: "ready";
      data: MarketRegimeOutput;
      refreshError?: string;
    }>;

export interface MarketRegimeSectionProps {
  readonly gateway?: MarketRegimeGateway;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onStatusChange?: (status: MarketSourceStatus) => void;
  readonly refreshSignal?: number;
}

const PillarCell = ({
  cell,
  pillar,
}: Readonly<{ cell: RegimePillarCellView; pillar: string }>) => (
  <TableCell
    className="align-top"
    data-pillar-source={cell.source}
    data-regime-pillar={pillar}
    data-regime-stale={cell.stale ? "true" : "false"}
    title={cell.detail}
  >
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge plain status={cell.badge.tone}>
          {cell.badge.label}
        </StatusBadge>
        {cell.stale ? (
          <StatusBadge data-pillar-stale="true" plain status="warning">
            Stale
          </StatusBadge>
        ) : null}
      </div>
      <div className="font-medium text-foreground text-sm tabular-nums">
        {cell.primary}
      </div>
      <div className="text-muted-foreground text-xs tabular-nums">
        {cell.secondary}
      </div>
      <div className="text-[11px] text-muted-foreground tabular-nums">
        {cell.asOf ?? "no as-of"}
        {cell.ageLabel === null ? "" : ` (${cell.ageLabel})`} ·{" "}
        {cell.scopeLabel} · {cell.sourceLabel}
      </div>
      <div
        className="text-[11px] text-muted-foreground"
        data-pillar-detail="true"
      >
        {cell.detail}
      </div>
    </div>
  </TableCell>
);

export const MarketRegimeSection = ({
  gateway: supplied,
  onBusyChange,
  onStatusChange,
  refreshSignal = 0,
}: MarketRegimeSectionProps) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserMarketRegimeGateway()
  );
  const [state, setState] = useState<State>({ type: "loading" });
  const [busy, setBusy] = useState(true);
  const latest = useRef(0);

  const load = useCallback(async () => {
    latest.current += 1;
    const request = latest.current;
    setBusy(true);
    try {
      const data = await gateway.get();
      if (request === latest.current) {
        setState({ data, type: "ready" });
      }
    } catch (error) {
      if (request !== latest.current) return;
      const failure = describePortfolioMonitorFailure(error);
      if (failure.kind === "forbidden") {
        setState({ type: "forbidden" });
      } else {
        const message = `${failure.code}: ${failure.message}`;
        setState((previous) =>
          previous.type === "ready"
            ? { ...previous, refreshError: message }
            : { message, type: "error" }
        );
      }
    } finally {
      if (request === latest.current) setBusy(false);
    }
  }, [gateway]);

  useEffect(() => {
    void refreshSignal;
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, MARKET_REGIME_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, refreshSignal]);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (onStatusChange === undefined) return;
    if (state.type === "ready") {
      onStatusChange(
        state.refreshError === undefined
          ? regimeSourceStatus(state.data)
          : "error"
      );
      return;
    }
    onStatusChange(state.type);
  }, [onStatusChange, state]);

  if (state.type === "loading") {
    return (
      <Panel
        aria-busy="true"
        data-regime-state="loading"
        description="Joining trend, Breadth-90, dealer gamma, credit and volatility for QQQ, SPY, IWM and DIA."
        title="Market regime"
      >
        <p className="text-muted-foreground text-sm" role="status">
          Loading market regime…
        </p>
      </Panel>
    );
  }

  if (state.type === "forbidden") {
    return (
      <div data-regime-state="forbidden">
        <OperatorAccessRequired feature="market-context" />
      </div>
    );
  }

  if (state.type === "error") {
    return (
      <Panel
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge plain status="destructive">
              Error
            </StatusBadge>
            <Button
              className="min-h-11"
              disabled={busy}
              onClick={() => void load()}
              variant="secondary"
            >
              <RotateCcw aria-hidden="true" className="size-4" />
              Retry
            </Button>
          </div>
        }
        data-regime-state="error"
        description="Unified regime view across QQQ, SPY, IWM and DIA."
        title="Market regime"
      >
        <p className="text-destructive text-sm" role="alert">
          {state.message}
        </p>
      </Panel>
    );
  }

  const { data, refreshError } = state;
  const overallBadge = summaryBadgeFor(data.overall.summary);
  const rows = buildRegimeRowViews(data);
  const mixedEntries = rows.filter((row) => row.mixedDrivers.length > 0);

  return (
    <Panel
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            data-regime-summary={data.overall.summary}
            plain
            status={overallBadge.tone}
          >
            {overallBadge.label}
          </StatusBadge>
          {data.overall.stalePillarCount > 0 ? (
            <StatusBadge data-regime-stale-banner="true" plain status="warning">
              Stale inputs ({data.overall.stalePillarCount})
            </StatusBadge>
          ) : null}
        </div>
      }
      data-regime-stale={data.overall.stalePillarCount > 0 ? "true" : "false"}
      data-regime-state="ready"
      description={`Trend (50/200d SMA), Breadth-90, dealer gamma, credit (HY OAS) and volatility across QQQ, SPY, IWM and DIA. Updated ${utcClock(new Date(data.generatedAt))}.`}
      title="Market regime"
    >
      <div className="space-y-4">
        {refreshError === undefined ? null : (
          <p
            className="rounded-md border border-destructive-border bg-destructive-subtle px-3 py-2 text-destructive text-xs"
            role="alert"
          >
            Last refresh failed ({refreshError}). Showing previous snapshot.
          </p>
        )}

        <TableScroll label="Market regime by index ETF" minWidth="52rem">
          <Table>
            <TableCaption className="sr-only">
              Market regime by index ETF with value, as-of timestamp, source and
              staleness state.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">ETF</TableHead>
                <TableHead scope="col">Regime</TableHead>
                <TableHead scope="col">Trend (50/200d)</TableHead>
                <TableHead scope="col">Breadth-90</TableHead>
                <TableHead scope="col">Dealer gamma</TableHead>
                <TableHead scope="col">Credit (HY OAS)</TableHead>
                <TableHead scope="col">Volatility</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  data-regime-etf={row.symbol}
                  data-regime-row-stale={row.hasStaleInputs ? "true" : "false"}
                  key={row.symbol}
                >
                  <TableHead
                    className="h-auto whitespace-normal align-top font-semibold"
                    scope="row"
                  >
                    <TickerLink symbol={row.symbol} />
                  </TableHead>
                  <TableCell className="align-top">
                    <div className="space-y-1">
                      <StatusBadge plain status={row.summary.tone}>
                        {row.summary.label}
                      </StatusBadge>
                      {row.hasStaleInputs ? (
                        <div className="text-muted-foreground text-xs">
                          Includes stale input
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                  <PillarCell cell={row.trend} pillar="trend" />
                  <PillarCell cell={row.breadth90} pillar="breadth90" />
                  <PillarCell cell={row.dealerGamma} pillar="dealerGamma" />
                  <PillarCell cell={row.credit} pillar="credit" />
                  <PillarCell cell={row.volatility} pillar="volatility" />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>

        {mixedEntries.length > 0 ? (
          <div
            className="space-y-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
            data-regime-mixed-drivers="true"
          >
            <p className="font-medium text-foreground">Mixed-state drivers</p>
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
              {mixedEntries.map((row) => (
                <li key={row.symbol}>
                  <span className="font-medium text-foreground">
                    {row.symbol}:
                  </span>{" "}
                  {row.mixedDrivers.join("; ")}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-muted-foreground text-xs">{data.researchOnlyNote}</p>
      </div>
    </Panel>
  );
};
