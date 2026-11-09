// What: Shared scene vocabulary. Panel, series, marker, bar and surface types that every scene builder
// returns, the data-table type, and small numeric helpers for domains and grids. The options scenes
// (scenes.ts) and the quant scenes (quant/) both build on this file.
import type { ParamValues } from "./position.ts";

export type Point = readonly [number, number];

export type Series = Readonly<{
  element: string;
  label: string;
  points: readonly Point[];
  dashed?: boolean;
  width?: number;
  /** Fill to y = 0 split by sign: green above, red below. */
  signFill?: boolean;
  /** Fill to y = 0 in the series color. */
  fill?: boolean;
  /** Draw only up to this x (time-revealed series). */
  revealTo?: number;
}>;

export type Marker = Readonly<{
  element: string;
  label: string;
  kind: "vline" | "hline" | "dot" | "band";
  x?: number;
  y?: number;
  x2?: number;
}>;

export type Bar = Readonly<{
  element: string;
  x: number;
  y: number;
  width: number;
  /** Fill in the element color instead of green above zero and red below. */
  tone?: boolean;
}>;

export type Surface = Readonly<{
  element: string;
  xs: readonly number[];
  ys: readonly number[];
  /** z[yIndex][xIndex] */
  z: readonly (readonly number[])[];
  xLabel: string;
  yLabel: string;
  zLabel: string;
  /** Highlighted y slice (current time). */
  sliceY?: number;
  /** Legend under the surface; defaults to the P&L reading (green = profit, red = loss). */
  legend?: string;
}>;

export type Panel = Readonly<{
  id: string;
  title: string;
  xLabel: string;
  yLabel: string;
  xDomain: readonly [number, number];
  yDomain: readonly [number, number];
  series: readonly Series[];
  markers: readonly Marker[];
  bars: readonly Bar[];
  surface?: Surface;
  /** Elements this panel draws; the panel shows once any of them is revealed. */
  elements: readonly string[];
  xFormat: "price" | "day" | "pct" | "count" | "num";
  yFormat: "usd" | "pct" | "price" | "num";
}>;

export type SceneData = Readonly<{
  panels: readonly Panel[];
  /** Horizon of the time scrubber in its own units. */
  horizon: number;
  timeLabel: string;
  timeUnit: "days" | "trades" | "pct";
  /** Current time position in scrubber units. */
  now: number;
  layout: "stack" | "grid";
}>;

/** Inputs every scene builder receives: param values, time fraction t in [0, 1], 3D azimuth. */
export type SceneCtx = Readonly<{
  values: ParamValues;
  t: number;
  azimuth: number;
}>;

export type DataTable = Readonly<{
  id: string;
  title: string;
  columns: readonly string[];
  rows: readonly (readonly string[])[];
  note?: string;
}>;

/** Element at an index the caller guarantees is in range (negative counts from the end). */
export const nth = <T>(values: readonly T[], index: number): T =>
  values.at(index) as T;

export const clamp01 = (value: number): number =>
  Math.min(Math.max(value, 0), 1);

export const span = (
  values: readonly number[],
  pad = 0.08
): [number, number] => {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return [-1, 1];
  let low = Math.min(...finite);
  let high = Math.max(...finite);
  if (high - low < 1e-9) {
    low -= 1;
    high += 1;
  }
  const margin = (high - low) * pad;
  return [low - margin, high + margin];
};

export const withZero = (domain: [number, number]): [number, number] => [
  Math.min(domain[0], 0),
  Math.max(domain[1], 0),
];

export const grid = (low: number, high: number, count: number): number[] =>
  Array.from(
    { length: count },
    (_, index) => low + ((high - low) * index) / (count - 1)
  );
