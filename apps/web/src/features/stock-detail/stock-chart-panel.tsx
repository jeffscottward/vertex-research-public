"use client";

import type { MarketBarsOutput, OptionsChainExpiry } from "@darkfactory/api";
import { Panel } from "@darkfactory/ui";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import {
  ExpectedMoveBar,
  type ExpectedMoveLoadState,
} from "../../components/portal/expected-move-bar.tsx";
import {
  describeMarketDataFailure,
  type MarketDataFailure,
  type MarketDataGateway,
} from "../../components/portal/market-data-client.ts";
import {
  type ChartIndicatorKey,
  DEFAULT_CHART_INDICATORS,
  studiesFor,
} from "../charts/chart-indicators.ts";
import {
  aggregateCandles,
  type ChartInterval,
  INTERVAL_BARS,
} from "../charts/chart-intervals.ts";
import { ChartToolbar } from "../charts/chart-toolbar.tsx";
import {
  barSpacing,
  expectedMoveTargetIndex,
  toExpectedMoveCone,
} from "../charts/expected-move-overlay.ts";
import { barsToDisplayCandles } from "../charts/market-bars.ts";
import { ChartRendererBoundary } from "../charts/renderer-host.tsx";
import type { ChartMarker } from "../charts/types.ts";

// Symbol price chart for /stock/<SYMBOL>: IBKR bars for the selected interval with the reference signal chart
// controls (interval, Overlay, Study, Volume). Loads on mount; no input is needed.

// KLineCharts needs a browser: load it lazily, only after bars arrive (same as /charts).
const LazyMarketBarsChart = lazy(async () => ({
  default: (await import("../charts/market-chart.tsx")).MarketBarsChart,
}));

const NO_MARKERS: readonly ChartMarker[] = Object.freeze([]);

type BarsState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; data: MarketBarsOutput }>
  | Readonly<{ type: "error"; failure: MarketDataFailure }>;

export type StockExpectedMoveProps = Readonly<{
  state: ExpectedMoveLoadState;
  expiries: readonly OptionsChainExpiry[];
  selectedExpiry: string | null;
  onExpiry: (expiry: string) => void;
  onRetry: () => void;
}>;

export type StockChartPanelProps = Readonly<{
  symbol: string;
  interval: ChartInterval;
  onInterval: (interval: ChartInterval) => void;
  marketData: MarketDataGateway;
  expectedMove: StockExpectedMoveProps;
}>;

export const StockChartPanel = ({
  symbol,
  interval,
  onInterval,
  marketData,
  expectedMove,
}: StockChartPanelProps) => {
  const [bars, setBars] = useState<BarsState>({ type: "loading" });
  const [indicators, setIndicators] = useState<readonly ChartIndicatorKey[]>(
    DEFAULT_CHART_INDICATORS
  );
  const [volume, setVolume] = useState(true);
  const [showExpectedMove, setShowExpectedMove] = useState(true);
  const request = INTERVAL_BARS[interval];

  useEffect(() => {
    let active = true;
    setBars({ type: "loading" });
    marketData
      .bars({
        barSize: request.barSize,
        currency: "USD",
        duration: request.duration,
        exchange: "SMART",
        secType: "STK",
        // The bars request writes share classes with a dot (BF.B); tickers may use a dash (BF-B).
        symbol: symbol.replaceAll("-", "."),
        useRTH: true,
        whatToShow: "TRADES",
      })
      .then(
        (data) => {
          if (active) setBars({ data, type: "ready" });
        },
        (error: unknown) => {
          if (active)
            setBars({
              failure: describeMarketDataFailure(error),
              type: "error",
            });
        }
      );
    return () => {
      active = false;
    };
  }, [marketData, request, symbol]);

  const candles = useMemo(() => {
    if (bars.type !== "ready") return [];
    const daily = barsToDisplayCandles(bars.data.bars).candles;
    return request.aggregate === null
      ? daily
      : aggregateCandles(daily, request.aggregate);
  }, [bars, request]);
  const studies = useMemo(
    () => studiesFor(volume, indicators),
    [volume, indicators]
  );
  const expectedMoveCone = useMemo(
    () =>
      showExpectedMove && expectedMove.state.type === "ready"
        ? toExpectedMoveCone(expectedMove.state.data)
        : null,
    [showExpectedMove, expectedMove.state]
  );
  const horizonScale = useMemo(() => {
    if (expectedMoveCone === null) return null;
    const timestamps = candles.map((bar) => bar.timestamp);
    return (
      expectedMoveTargetIndex(
        timestamps,
        expectedMoveCone.expiryCloseMs,
        barSpacing(timestamps)
      )?.horizonScale ?? null
    );
  }, [expectedMoveCone, candles]);

  return (
    <Panel
      data-stock-chart={symbol}
      description={
        request.aggregate === null
          ? "IBKR bars, regular trading hours."
          : `IBKR daily bars merged into ${request.aggregate}ly candles (up to one year).`
      }
      title={`${symbol} price · ${interval}`}
    >
      <div className="space-y-3">
        <ChartToolbar
          indicators={indicators}
          interval={interval}
          onIndicators={setIndicators}
          onInterval={onInterval}
          onVolume={setVolume}
          volume={volume}
        >
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 text-sm">
            <input
              checked={showExpectedMove}
              className="size-4"
              data-expected-move-toggle=""
              onChange={(event) => setShowExpectedMove(event.target.checked)}
              type="checkbox"
            />
            Expected move
          </label>
        </ChartToolbar>
        <ExpectedMoveBar
          enabled={showExpectedMove}
          errorRole="status"
          expiries={expectedMove.expiries}
          horizonScale={horizonScale}
          onExpiry={expectedMove.onExpiry}
          onRetry={expectedMove.onRetry}
          priceDigits={2}
          selectedExpiry={expectedMove.selectedExpiry}
          state={expectedMove.state}
        />
        {bars.type === "loading" ? (
          <p
            aria-busy="true"
            className="flex h-72 items-center justify-center text-muted-foreground text-sm"
          >
            Loading {symbol} {interval} bars…
          </p>
        ) : bars.type === "error" ? (
          <div
            className="space-y-1 rounded-md border border-border p-4"
            data-error-code={bars.failure.code}
            role="alert"
          >
            <p className="font-mono text-sm">{bars.failure.code}</p>
            <p className="text-sm">{bars.failure.message}</p>
          </div>
        ) : candles.length === 0 ? (
          <p className="text-muted-foreground text-sm" role="status">
            No bars returned for {symbol}.
          </p>
        ) : (
          <ChartRendererBoundary>
            <Suspense
              fallback={
                <p className="text-muted-foreground text-xs">Loading chart…</p>
              }
            >
              <LazyMarketBarsChart
                candles={candles}
                expectedMove={expectedMoveCone}
                label={`${symbol} ${interval} price chart`}
                markers={NO_MARKERS}
                pricePrecision={2}
                studies={studies}
                symbol={symbol}
              />
            </Suspense>
          </ChartRendererBoundary>
        )}
      </div>
    </Panel>
  );
};
