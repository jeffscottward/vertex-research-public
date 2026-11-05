import type { DisplayCandle } from "./types.ts";

// Chart workstation model: chart types, drawing tools and saved drawings.
// Display only. Nothing here is a trading input.

export const CHART_TYPES = Object.freeze([
  { id: "candles", label: "Candles" },
  { id: "hollow", label: "Hollow candles" },
  { id: "heikin-ashi", label: "Heikin Ashi" },
  { id: "ohlc", label: "OHLC bars" },
  { id: "area", label: "Area" },
] as const);
export type ChartType = (typeof CHART_TYPES)[number]["id"];
export const isChartType = (value: unknown): value is ChartType =>
  CHART_TYPES.some((type) => type.id === value);

export const DRAWING_TOOLS = Object.freeze([
  { id: "trend", label: "Trend line", steps: 2 },
  { id: "level", label: "Horizontal level", steps: 1 },
  { id: "rectangle", label: "Rectangle", steps: 2 },
  { id: "fib", label: "Fibonacci retracement", steps: 2 },
  { id: "text", label: "Text note", steps: 1 },
] as const);
export type DrawingTool = (typeof DRAWING_TOOLS)[number]["id"];
export const isDrawingTool = (value: unknown): value is DrawingTool =>
  DRAWING_TOOLS.some((tool) => tool.id === value);
export const drawingToolLabel = (tool: DrawingTool): string =>
  DRAWING_TOOLS.find((entry) => entry.id === tool)?.label ?? tool;

export type DrawingPoint = Readonly<{ timestamp: number; value: number }>;
export type Drawing = Readonly<{
  id: string;
  tool: DrawingTool;
  points: readonly DrawingPoint[];
  text: string;
}>;

const MAX_DRAWINGS = 200;
const MAX_TEXT = 80;

const validPoint = (point: unknown): point is DrawingPoint => {
  if (typeof point !== "object" || point === null) return false;
  const { timestamp, value } = point as Record<string, unknown>;
  return (
    typeof timestamp === "number" &&
    Number.isSafeInteger(timestamp) &&
    Math.abs(timestamp) <= 8_640_000_000_000_000 &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= 1_000_000_000_000
  );
};

export const validDrawing = (value: unknown): value is Drawing => {
  if (typeof value !== "object" || value === null) return false;
  const { id, tool, points, text } = value as Record<string, unknown>;
  if (!isDrawingTool(tool)) return false;
  const steps = DRAWING_TOOLS.find((entry) => entry.id === tool)?.steps;
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 160 &&
    typeof text === "string" &&
    text.length <= MAX_TEXT &&
    Array.isArray(points) &&
    points.length === steps &&
    points.every(validPoint)
  );
};

// Parse stored JSON. Invalid entries are dropped; never throws.
export const parseDrawings = (raw: string | null): readonly Drawing[] => {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validDrawing).slice(0, MAX_DRAWINGS);
  } catch {
    return [];
  }
};

export const drawingsStorageKey = (symbol: string): string =>
  `vx.charts.drawings.${symbol.trim().toUpperCase()}`;

// Replace an existing drawing by id, or append a new one (bounded).
export const upsertDrawing = (
  drawings: readonly Drawing[],
  next: Drawing
): readonly Drawing[] => {
  if (!validDrawing(next)) return drawings;
  const index = drawings.findIndex((drawing) => drawing.id === next.id);
  if (index >= 0)
    return drawings.map((drawing, at) => (at === index ? next : drawing));
  return [...drawings, next].slice(-MAX_DRAWINGS);
};

// Short object-tree description of a drawing.
export const describeDrawing = (
  drawing: Drawing,
  precision: number
): string => {
  const prices = drawing.points.map((point) => point.value.toFixed(precision));
  const base = `${drawingToolLabel(drawing.tool)} ${prices.join(" → ")}`;
  return drawing.text === "" ? base : `${base} “${drawing.text}”`;
};

// Heikin Ashi bars from ordinary bars. The first bar seeds open from (O+C)/2.
export const heikinAshi = (
  candles: readonly DisplayCandle[]
): readonly DisplayCandle[] => {
  const out: DisplayCandle[] = [];
  for (const bar of candles) {
    const close = (bar.open + bar.high + bar.low + bar.close) / 4;
    const before = out.at(-1);
    const open =
      before === undefined
        ? (bar.open + bar.close) / 2
        : (before.open + before.close) / 2;
    out.push({
      close,
      high: Math.max(bar.high, open, close),
      id: bar.id,
      low: Math.min(bar.low, open, close),
      open,
      timestamp: bar.timestamp,
      volume: bar.volume,
    });
  }
  return out;
};

export const displayValues = (
  candles: readonly DisplayCandle[],
  type: ChartType
): readonly DisplayCandle[] =>
  type === "heikin-ashi" ? heikinAshi(candles) : candles;

export type DataWindowRow = Readonly<{ label: string; value: string }>;

// Data window rows for the bar under the crosshair (or the latest bar).
export const dataWindowRows = (
  bar: DisplayCandle | undefined,
  previousClose: number | undefined,
  precision: number
): readonly DataWindowRow[] => {
  if (bar === undefined) return [];
  const rows: DataWindowRow[] = [
    { label: "Time (UTC)", value: new Date(bar.timestamp).toISOString() },
    { label: "Open", value: bar.open.toFixed(precision) },
    { label: "High", value: bar.high.toFixed(precision) },
    { label: "Low", value: bar.low.toFixed(precision) },
    { label: "Close", value: bar.close.toFixed(precision) },
    { label: "Volume", value: bar.volume.toLocaleString("en-US") },
  ];
  if (previousClose !== undefined && previousClose !== 0) {
    const change = bar.close - previousClose;
    const percent = (change / previousClose) * 100;
    rows.push({
      label: "Change",
      value: `${change >= 0 ? "+" : ""}${change.toFixed(precision)} (${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%)`,
    });
  }
  return rows;
};

export const screenshotFileName = (label: string, at: Date): string => {
  const safe = label
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `vertex-${safe === "" ? "chart" : safe}-${stamp}.png`;
};
