"use client";

import {
  createApiClient,
  type MarketVolatilityOutput,
  type VolatilitySeries,
} from "@darkfactory/api";
import { Button, KpiCard, KpiRow, Panel, StatusBadge } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { utcClock } from "../status-time.ts";
import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import {
  isSpxQuoteStale,
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
  value === null ? "no reading" : value.toFixed(digits);

const signed = (value: number | null): string =>
  value === null
    ? "no prior value"
    : `${value > 0 ? "+" : ""}${value.toFixed(2)}`;

// A unit joins a number only: "4.20%" and "×1.50", never "no reading%".
const percent = (value: number | null): string =>
  value === null ? fixed(value) : `${fixed(value)}%`;
const signedPercent = (value: number | null): string =>
  value === null ? signed(value) : `${signed(value)}%`;
const times = (value: number | null): string =>
  value === null ? fixed(value) : `×${fixed(value)}`;

/**
 * The error that ibkr-monitor reported for one source (`Cboe`, `S&P 500`), without the label.
 * `sourceErrors` entries are display texts that start with the source label; null when the source
 * reported no error.
 */
export const sourceErrorFor = (
  sourceErrors: readonly string[],
  label: string
): string | null => {
  const prefix = `${label}:`;
  const entry = sourceErrors.find((error) => error.startsWith(prefix));
  if (entry === undefined) return null;
  return (
    entry.slice(prefix.length).trim() || "error text not reported by source"
  );
};

const formatQuoteLabel = (
  quoteTime: string | null,
  sessionDate: string | null,
  nowMs: number
): string => {
  const session = sessionDate === null ? "" : ` · session ${sessionDate}`;
  if (quoteTime === null) return `Quote time not reported${session}`;
  const quoteMs = Date.parse(quoteTime);
  if (!Number.isFinite(quoteMs)) return `Quote time unreadable${session}`;
  const mins = Math.max(0, Math.floor((nowMs - quoteMs) / 60_000));
  let age: string;
  if (mins < 1) age = "<1m ago";
  else if (mins < 60) age = `${mins}m ago`;
  else if (mins < 48 * 60) age = `${Math.floor(mins / 60)}h ago`;
  else age = `${Math.floor(mins / (24 * 60))}d ago`;
  const formatted = new Date(quoteMs).toLocaleString("en-US", {
    dateStyle: "short",
    timeStyle: "short",
  });
  return `Quote ${formatted} (${age})${session}`;
};

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

// A null series has two causes that the response tells apart: Cboe reported an error, or the
// response has no reading and no error. The API sends no last-reading time per series.
const SeriesCard = ({
  label,
  receivedAt,
  series,
  sourceError,
}: Readonly<{
  label: string;
  /** When the response arrived (epoch milliseconds). */
  receivedAt: number;
  series: VolatilitySeries | null;
  /** The Cboe entry of `sourceErrors` without its label, or null. */
  sourceError: string | null;
}>) =>
  series === null ? (
    <KpiCard
      data-series={label}
      hint={
        sourceError === null
          ? `No reading in the response of ${utcClock(receivedAt)}`
          : `Not received from Cboe: ${sourceError}`
      }
      label={label}
      value={sourceError === null ? "No reading" : "Not received"}
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
  // `receivedAt`: epoch milliseconds, set when the response arrives.
  | Readonly<{
      type: "ready";
      data: MarketVolatilityOutput;
      receivedAt: number;
    }>;

export interface MarketContextWorkspaceProps {
  readonly gateway?: MarketContextGateway;
  /** Clock seam for quote age and staleness checks; defaults to the system clock. */
  readonly now?: () => Date;
  /** Called with whether a load is in flight, so the page header can hold Refresh. */
  readonly onBusyChange?: (busy: boolean) => void;
  /** Called with the load state, for the page header chip. */
  readonly onStatusChange?: (status: MarketSourceStatus) => void;
  /** Each new value reloads now (the page header Refresh). */
  readonly refreshSignal?: number;
}

export const MarketContextWorkspace = ({
  gateway: supplied,
  now = () => new Date(),
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
      if (request === latest.current)
        setState({ data, receivedAt: Date.now(), type: "ready" });
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
  const nowMs = now().getTime();
  const status: MarketSourceStatus =
    state.type === "ready"
      ? volatilitySourceStatus(state.data, nowMs)
      : state.type;
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

  const { data, receivedAt } = state;
  const cboeError = sourceErrorFor(data.sourceErrors, "Cboe");
  const spxError = sourceErrorFor(data.sourceErrors, "S&P 500");
  const series = { receivedAt, sourceError: cboeError };
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
        <SeriesCard {...series} label="VIX" series={data.vix} />
        <SeriesCard {...series} label="VIXEQ" series={data.vixeq} />
        <SeriesCard {...series} label="VIXEQ − VIX" series={data.spread} />
        <SeriesCard {...series} label="VVIX" series={data.vvix} />
      </KpiRow>
      <Panel headingId="mc-move" title="S&amp;P 500 move today">
        {data.spx === null ? (
          <p className="text-muted-foreground text-sm" data-spx-missing="">
            {spxError === null
              ? `S&P 500 quote: no reading in the response of ${utcClock(receivedAt)}`
              : `S&P 500 quote not received: ${spxError} · response of ${utcClock(receivedAt)}`}
            {" · refreshes every minute"}
          </p>
        ) : (
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
            data-spx=""
          >
            <span className="font-semibold tabular-nums">
              {fixed(data.spx.price)} ({signedPercent(data.spx.movePct)})
            </span>
            <span className="text-muted-foreground">
              {data.spx.sessionOpen ? "Session open" : "Session closed"}
            </span>
            <span
              className="text-muted-foreground tabular-nums"
              data-spx-quote-time=""
            >
              {formatQuoteLabel(
                data.spx.quoteTime,
                data.spx.sessionDate,
                nowMs
              )}
            </span>
            {isSpxQuoteStale(data.spx, nowMs) ? (
              <StatusBadge data-spx-stale="" status="warning">
                Stale quote
              </StatusBadge>
            ) : null}
            {data.implied === null ? null : (
              <>
                <span className="text-muted-foreground tabular-nums">
                  VIX-implied move {percent(data.implied.impliedPct)} · actual{" "}
                  {times(data.implied.multiple)}
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
