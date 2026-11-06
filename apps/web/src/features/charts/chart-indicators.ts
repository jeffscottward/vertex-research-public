import type { ChartStudies } from "./types.ts";
import {
  VERTEX_STUDIES,
  VERTEX_STUDY_IDS,
  type VertexStudyId,
} from "./vertex-studies.ts";

// Indicator menus for the symbol chart (ported from the CHARAN signal chart): price overlays
// (MA, EMA, BOLL, SAR, ...) and studies in panes below the price (MACD, RSI, KDJ, OBV, WR, ...).
// BOLL, SAR, MACD and the other Vertex studies use the Vertex indicator math; RSI, KDJ, OBV
// and WR are KLineCharts 9.8.12 built-ins. Display only: never trading inputs.

export const BUILTIN_PANE_IDS = ["RSI", "KDJ", "OBV", "WR"] as const;
export type BuiltinPaneId = (typeof BUILTIN_PANE_IDS)[number];

export type ChartIndicatorKey = "MA" | "EMA" | VertexStudyId | BuiltinPaneId;
export type ChartIndicatorOption = Readonly<{
  key: ChartIndicatorKey;
  label: string;
}>;

const vertexOption = (id: VertexStudyId): ChartIndicatorOption => ({
  key: id,
  label: VERTEX_STUDIES[id].label,
});

export const OVERLAY_OPTIONS: readonly ChartIndicatorOption[] = Object.freeze([
  { key: "MA", label: "MA 20, 50" },
  { key: "EMA", label: "EMA 20" },
  vertexOption("boll"),
  vertexOption("sar"),
  vertexOption("smma"),
  vertexOption("lwma"),
]);

export const STUDY_OPTIONS: readonly ChartIndicatorOption[] = Object.freeze([
  vertexOption("macd"),
  { key: "RSI", label: "RSI 14" },
  { key: "KDJ", label: "KDJ 9, 3, 3" },
  { key: "OBV", label: "OBV" },
  { key: "WR", label: "Williams %R 14" },
  vertexOption("atr"),
  vertexOption("stoch"),
  vertexOption("adx"),
  vertexOption("rvol"),
]);

/** CHARAN defaults: MA on the price, MACD below it. */
export const DEFAULT_CHART_INDICATORS: readonly ChartIndicatorKey[] =
  Object.freeze(["MA", "macd"]);

const isVertexKey = (key: ChartIndicatorKey): key is VertexStudyId =>
  (VERTEX_STUDY_IDS as readonly string[]).includes(key);

/** Converts the selected menu keys into renderer studies. */
export const studiesFor = (
  volume: boolean,
  selected: readonly ChartIndicatorKey[]
): ChartStudies => ({
  ema: selected.includes("EMA") ? [20] : [],
  extra: VERTEX_STUDY_IDS.filter((id) => selected.includes(id)),
  panes: BUILTIN_PANE_IDS.filter((id) => selected.includes(id)),
  sma: selected.includes("MA") ? [20, 50] : [],
  volume,
});

/** Toggles one key, keeping the selection in menu order. */
export const toggleIndicator = (
  selected: readonly ChartIndicatorKey[],
  key: ChartIndicatorKey
): ChartIndicatorKey[] => {
  const next = selected.includes(key)
    ? selected.filter((item) => item !== key)
    : [...selected, key];
  const order = [...OVERLAY_OPTIONS, ...STUDY_OPTIONS].map(
    (option) => option.key
  );
  return order.filter((item) => next.includes(item));
};

/** Short menu summary, e.g. "MA, BOLL" or "None". */
export const indicatorSummary = (
  options: readonly ChartIndicatorOption[],
  selected: readonly ChartIndicatorKey[]
): string => {
  const names = options
    .filter((option) => selected.includes(option.key))
    .map((option) =>
      isVertexKey(option.key)
        ? VERTEX_STUDIES[option.key].shortName
        : option.key
    );
  return names.length === 0 ? "None" : names.join(", ");
};

/** Axis and tooltip volume format: 1.2K, 3.4M, 5.6B. */
export const formatBigNumber = (value: string | number): string => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  const size = Math.abs(numeric);
  if (size >= 1_000_000_000) return `${(numeric / 1_000_000_000).toFixed(1)}B`;
  if (size >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M`;
  if (size >= 1000) return `${(numeric / 1000).toFixed(1)}K`;
  return numeric.toLocaleString("en-US");
};
