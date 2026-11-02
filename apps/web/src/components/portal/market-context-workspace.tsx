"use client";

import {
  createApiClient,
  type MarketVolatilityOutput,
  type VolatilitySeries,
} from "@darkfactory/api";
import { Button, StatCard, StatusBadge } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { OperatorAccessRequired } from "./agent-ops-client.tsx";
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
    <StatCard data-series={label} label={label} value="Unknown" />
  ) : (
    <StatCard
      data-series={label}
      label={label}
      description={`1d ${signed(series.change1d)} · 1y percentile ${fixed(series.pct1y, 0)} · as of ${series.asOf}${series.stale ? " · stale" : ""}`}
      value={fixed(series.value)}
    />
  );

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: MarketVolatilityOutput }>;

export const MarketContextWorkspace = ({
  gateway: supplied,
}: Readonly<{ gateway?: MarketContextGateway }>) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserMarketContextGateway()
  );
  const [state, setState] = useState<State>({ type: "loading" });
  const load = useCallback(async () => {
    try {
      const data = await gateway.volatility();
      return setState({ type: "ready", data });
    } catch (error) {
      const failure = describePortfolioMonitorFailure(error);
      return setState(
        failure.kind === "forbidden"
          ? { type: "forbidden" }
          : { type: "error", message: `${failure.code}: ${failure.message}` }
      );
    }
  }, [gateway]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(
      () => void load(),
      MARKET_CONTEXT_REFRESH_MS
    );
    return () => window.clearInterval(timer);
  }, [load]);

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
        <Button onClick={() => void load()} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Retry now
        </Button>
      </div>
    );

  const { data } = state;
  return (
    <div className="space-y-6" data-market-state="ready">
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
      <section aria-labelledby="mc-vol" className="space-y-3">
        <h2 className="font-heading font-semibold text-lg" id="mc-vol">
          Volatility
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SeriesCard label="VIX" series={data.vix} />
          <SeriesCard label="VIXEQ" series={data.vixeq} />
          <SeriesCard label="VIXEQ − VIX" series={data.spread} />
          <SeriesCard label="VVIX" series={data.vvix} />
        </div>
      </section>
      <section aria-labelledby="mc-move" className="space-y-3">
        <h2 className="font-heading font-semibold text-lg" id="mc-move">
          S&amp;P 500 move today
        </h2>
        {data.spx === null ? (
          <p className="text-muted-foreground text-sm">
            S&amp;P 500 quote unknown.
          </p>
        ) : (
          <div
            className="flex flex-wrap items-center gap-3 text-sm"
            data-spx=""
          >
            <span className="tabular-nums">
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
      </section>
    </div>
  );
};
