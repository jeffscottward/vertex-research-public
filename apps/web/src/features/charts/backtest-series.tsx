"use client";

import { useMemo } from "react";
import { defineChart, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear, scaleUtc } from "d3-scale";
import "./charts.css";

// Backtest equity and drawdown lines on the same TanStack Charts 0.18.0 package family and
// compositional API as tanstack-adapter.ts (lineY over a UTC time scale). Display only; the
// exact values stay in the detail tables and the API payload.
const theme = {
  foreground: "var(--foreground)",
  muted: "var(--muted-foreground)",
  grid: "var(--border)",
  background: "var(--background)",
  palette: ["var(--foreground)", "var(--muted-foreground)", "var(--vx-gold)"],
};

export type BacktestSeriesPoint = Readonly<{ t: string; value: number }>;

const toMs = (value: string): number => {
  return Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value
  );
};

export const backtestSeriesRows = (points: readonly BacktestSeriesPoint[]) => {
  return points
    .map((point) => ({ time: new Date(toMs(point.t)), value: point.value }))
    .filter(
      (row) => Number.isFinite(row.time.getTime()) && Number.isFinite(row.value)
    );
};

export const createBacktestSeriesDefinition = (
  points: readonly BacktestSeriesPoint[],
  yLabel: string
) => {
  const rows = backtestSeriesRows(points);
  if (rows.length < 2)
    throw new TypeError("At least two finite points are required");
  return defineChart(
    {
      theme,
      marks: [
        lineY(rows, {
          x: "time",
          y: "value",
          stroke: "var(--foreground)",
          strokeWidth: 1.5,
        }),
      ],
      scales: {
        x: { scale: scaleUtc, axis: { label: "UTC" } },
        y: { scale: scaleLinear, grid: true, axis: { label: yLabel } },
      },
    },
    { keyboard: true, svgAnimation: false, tooltip: false }
  );
};

export type BacktestSeriesChartProps = Readonly<{
  points: readonly BacktestSeriesPoint[];
  label: string;
  yLabel: string;
  caption: string;
  height?: number;
}>;

const MountedSeries = ({
  points,
  label,
  yLabel,
  caption,
  height = 220,
}: BacktestSeriesChartProps) => {
  const definition = useMemo(
    () => createBacktestSeriesDefinition(points, yLabel),
    [points, yLabel]
  );
  return (
    <figure className="vx-chart-panel">
      <Chart
        definition={definition}
        ariaLabel={label}
        ariaDescription={`${label}. Exact values are in the tables below and in the API payload.`}
        height={height}
        className="vx-chart-tanstack"
      />
      <figcaption className="vx-chart-note">{caption}</figcaption>
    </figure>
  );
};

export const BacktestSeriesChart = (props: BacktestSeriesChartProps) => {
  if (typeof window === "undefined")
    return <p className="vx-chart-note">The chart requires a browser.</p>;
  if (backtestSeriesRows(props.points).length < 2)
    return <p className="vx-chart-note">Fewer than two points; no chart.</p>;
  return <MountedSeries {...props} />;
};
