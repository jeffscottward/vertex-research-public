"use client";

import {
  createApiClient,
  type MarketVolatilityOutput,
  type VolatilitySeries,
} from "@darkfactory/api";
import { Button, KpiCard, KpiRow, Panel, StatusBadge } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import {
  type MarketSourceStatus,
  volatilitySourceStatus,
} from "./market-source-status.ts";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

// Market context (audit phase 5): public volatility read by ibkr-monitor through
// ibkrMonitor.volatility. Read-only; it shows numbers and never acts on them.

export interface MarketContextGateway {
  readonly volatility: () => Promise<MarketVolatilityOutput>;
}

export const createBrowserMarketContextGateway = (): MarketContextGateway => {
  let client: ReturnType<typeof createApiClient> | undefined;
  return Object.freeze({
    volatility: () => {
      client ??= createApiClient({ baseUrl: window.location.origin });
      return client.ibkrMonitor.volatility({});
    },
  });
};

export const MARKET_CONTEXT_REFRESH_MS = 60_000;

const fixed = (value: number | null, digits = 2): string =>
  value === null ? "—" : value.toFixed(digits);

const signed = (value: number | null): string =>
  value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`;

const BAND_LABEL = {
  normal: "Normal move",
  notable: "Notable move",
  review: "Review: large move",
} as const;
const BAND_TONE = {
  normal: "neutral",
  notable: "warning",
  review: "destructive",
} as const;

const SeriesCard = ({
  label,
  series,
}: Readonly<{ label: string; series: VolatilitySeries | null }>) =>
  series === null ? (
    <KpiCard
      data-series={label}
      hint="No reading"
      label={label}
      value="Unknown"
    />
  ) : (
    <KpiCard
      data-series={label}
      hint={`1d ${signed(series.change1d)} · 1y pct ${fixed(series.pct1y, 0)} · as of ${series.asOf}${series.stale ? " · stale" : ""}`}
      label={label}
      value={fixed(series.value)}
    />
  );

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: MarketVolatilityOutput }>;

export interface MarketContextWorkspaceProps {
  readonly gateway?: MarketContextGateway;
  /** Called with whether a load is in flight, so the page header can hold Refresh. */
  readonly onBusyChange?: (busy: boolean) => void;
  /** Called with the load state, for the page header chip. */
  readonly onStatusChange?: (status: MarketSourceStatus) => void;
  /** Each new value reloads now (the page header Refresh). */
  readonly refreshSignal?: number;
}

export const MarketContextWorkspace = ({
  gateway: supplied,
  onStatusChange,
  onBusyChange,
  refreshSignal = 0,
}: MarketContextWorkspaceProps) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserMarketContextGateway()
  );
  const [state, setState] = useState<State>({ type: "loading" });
  const [busy, setBusy] = useState(true);
  // Each load takes the next number; only the newest may write, so a slow older answer
  // (the timer, Refresh or Retry overlapping) never overwrites a newer one.
  const latest = useRef(0);
  const load = useCallback(async () => {
    latest.current += 1;
    const request = latest.current;
    setBusy(true);
    try {
      const data = await gateway.volatility();
      if (request === latest.current) setState({ data, type: "ready" });
    } catch (error) {
      if (request !== latest.current) return;
      const failure = describePortfolioMonitorFailure(error);
      setState(
        failure.kind === "forbidden"
          ? { type: "forbidden" }
          : { message: `${failure.code}: ${failure.message}`, type: "error" }
      );
    } finally {
      if (request === latest.current) setBusy(false);
    }
  }, [gateway]);
  useEffect(() => {
    // refreshSignal is a dependency only so the header Refresh reloads now and restarts the timer.
    void refreshSignal;
    void load();
    const timer = window.setInterval(
      () => void load(),
      MARKET_CONTEXT_REFRESH_MS
    );
    return () => {
      window.clearInterval(timer);
      // A Refresh restart or unmount drops the answer still in flight.
      latest.current += 1;
    };
  }, [load, refreshSignal]);
  const status: MarketSourceStatus =
    state.type === "ready" ? volatilitySourceStatus(state.data) : state.type;
  useEffect(() => onStatusChange?.(status), [onStatusChange, status]);
  useEffect(() => onBusyChange?.(busy), [onBusyChange, busy]);

  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="ibkr-monitor" />;
  if (state.type === "loading")
    return (
      <p
        aria-busy="true"
        className="text-muted-foreground text-sm"
        role="status"
      >
        Loading market context…
      </p>
    );
  if (state.type === "error")
    return (
      <div className="space-y-3" data-market-state="error">
        <p className="text-sm" role="alert">
          Market context unavailable. {state.message}
        </p>
        <Button disabled={busy} onClick={() => void load()} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Retry now
        </Button>
      </div>
    );

  const { data } = state;
  return (
    <div className="space-y-4" data-market-state="ready">
      <p className="text-muted-foreground text-xs" role="note">
        Public market data from ibkr-monitor (Cboe, Yahoo). Read-only; refreshes
        every minute.
      </p>
      {data.sourceErrors.length > 0 ? (
        <ul className="space-y-1 text-sm" data-source-errors="">
          {data.sourceErrors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      <KpiRow className="grid-cols-2" label="Volatility">
        <SeriesCard label="VIX" series={data.vix} />
        <SeriesCard label="VIXEQ" series={data.vixeq} />
        <SeriesCard label="VIXEQ − VIX" series={data.spread} />
        <SeriesCard label="VVIX" series={data.vvix} />
      </KpiRow>
      <Panel headingId="mc-move" title="S&amp;P 500 move today">
        {data.spx === null ? (
          <p className="text-muted-foreground text-sm">
            S&amp;P 500 quote unknown.
          </p>
        ) : (
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
            data-spx=""
          >
            <span className="font-semibold tabular-nums">
              {fixed(data.spx.price)} ({signed(data.spx.movePct)}%)
            </span>
            <span className="text-muted-foreground">
              {data.spx.sessionOpen ? "Session open" : "Session closed"}
            </span>
            {data.implied === null ? null : (
              <>
                <span className="text-muted-foreground tabular-nums">
                  VIX-implied move {fixed(data.implied.impliedPct)}% · actual ×
                  {fixed(data.implied.multiple)}
                </span>
                {data.implied.band === null ? null : (
                  <StatusBadge
                    data-band={data.implied.band}
                    status={BAND_TONE[data.implied.band]}
                  >
                    {BAND_LABEL[data.implied.band]}
                  </StatusBadge>
                )}
              </>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
};
