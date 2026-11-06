"use client";

import { ChartWorkstation } from "./chart-workstation.tsx";
import { createKLineRenderer } from "./kline-adapter.ts";
import type { ChartMarker, ChartStudies, DisplayCandle } from "./types.ts";
import "./charts.css";

// Lazy-loaded entry for the /charts page: KLineCharts workstation with chart types,
// drawings, data window, object tree and PNG screenshot.
export type MarketBarsChartProps = Readonly<{
  candles: readonly DisplayCandle[];
  symbol: string;
  label: string;
  pricePrecision: number;
  studies: ChartStudies;
  markers: readonly ChartMarker[];
}>;

const MARKET_CHART_CAPTIONS = Object.freeze({
  ready: "Display values are approximate.",
  loading: "Loading chart renderer.",
  error: "Chart renderer unavailable.",
});

export const MarketBarsChart = ({
  candles,
  symbol,
  label,
  pricePrecision,
  studies,
  markers,
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
      factory={createKLineRenderer}
      label={label}
      markers={markers}
      pricePrecision={pricePrecision}
      studies={studies}
      symbol={symbol}
    />
  );
};
