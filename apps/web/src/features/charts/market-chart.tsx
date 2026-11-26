"use client";

import { ChartWorkstation } from "./chart-workstation.tsx";
import { createKLineRenderer } from "./kline-adapter.ts";
import type {
  ChartMarker,
  ChartStudies,
  DisplayCandle,
  ExpectedMoveCone,
  GammaLevelsOverlay,
  SeriesPane,
} from "./types.ts";

// Lazy-loaded entry for the /charts page: KLineCharts workstation with chart types,
// drawings, data window, object tree and PNG screenshot.
export type MarketBarsChartProps = Readonly<{
  candles: readonly DisplayCandle[];
  symbol: string;
  label: string;
  pricePrecision: number;
  studies: ChartStudies;
  markers: readonly ChartMarker[];
  expectedMove?: ExpectedMoveCone | null;
  gammaLevels?: GammaLevelsOverlay | null;
  seriesPane?: SeriesPane | null;
}>;

export const MARKET_CHART_CAPTIONS = Object.freeze({
  // Only the next step: the host writes "Chart renderer failed to <stage>: <error> · <time>".
  error: "reload the page to retry",
  loading: "Loading chart renderer.",
  ready: "Display values are approximate.",
});

export const MarketBarsChart = ({
  candles,
  symbol,
  label,
  pricePrecision,
  studies,
  markers,
  expectedMove,
  gammaLevels,
  seriesPane,
}: MarketBarsChartProps) => {
  if (typeof window === "undefined")
    return (
      <p className="my-3 text-muted-foreground text-sm leading-[1.6] [overflow-wrap:anywhere]">
        The chart requires a browser.
      </p>
    );
  return (
    <ChartWorkstation
      candles={candles}
      captions={MARKET_CHART_CAPTIONS}
      expectedMove={expectedMove ?? null}
      factory={createKLineRenderer}
      gammaLevels={gammaLevels ?? null}
      label={label}
      markers={markers}
      pricePrecision={pricePrecision}
      seriesPane={seriesPane ?? null}
      studies={studies}
      symbol={symbol}
    />
  );
};
