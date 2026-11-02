"use client";

import { CandleCanvas } from "./renderer-host.tsx";
import { createKLineRenderer } from "./kline-adapter.ts";
import type { ChartMarker, ChartStudies, DisplayCandle } from "./types.ts";
import "./charts.css";

// Lazy-loaded entry for the /charts page: KLineCharts candles with built-in studies and markers.
export type MarketBarsChartProps = Readonly<{
  candles: readonly DisplayCandle[];
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
  label,
  pricePrecision,
  studies,
  markers,
}: MarketBarsChartProps) => {
  if (typeof window === "undefined")
    return <p className="vx-chart-note">The chart requires a browser.</p>;
  return (
    <CandleCanvas
      captions={MARKET_CHART_CAPTIONS}
      factory={createKLineRenderer}
      label={label}
      markers={markers}
      pricePrecision={pricePrecision}
      studies={studies}
      values={candles}
      volumePrecision={0}
    />
  );
};
