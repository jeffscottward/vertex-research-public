// What: pure view-model for the Greek exposure heatmap (strike x expiry) panel: tab
// metadata for GEX / VEX / charm / DEX / volume-GEX, diverging color-mix scale, mark
// placement (king, call/put wall, spot and gamma flip dividers), formatting and keyboard
// tab navigation. Pure functions, no React, no I/O.

import {
  GREEK_HEATMAP_METRICS,
  type GreekHeatmapMetric,
  type GreekHeatmapMetricData,
  type GreekHeatmapOutput,
} from "@darkfactory/api";

export type GreekHeatmapTabSpec = Readonly<{
  id: GreekHeatmapMetric;
  label: string;
  fullName: string;
  unitText: string;
  positiveWallLabel: string;
  negativeWallLabel: string;
  positiveBadge: string;
  negativeBadge: string;
}>;

const GREEK_HEATMAP_TAB_BY_ID: Readonly<
  Record<GreekHeatmapMetric, GreekHeatmapTabSpec>
> = {
  charm: {
    fullName: "Charm exposure",
    id: "charm",
    label: "Charm",
    negativeBadge: "Min charm",
    negativeWallLabel: "Most negative charm",
    positiveBadge: "Max charm",
    positiveWallLabel: "Largest positive charm",
    unitText:
      "Estimated dealer charm ($ delta per calendar day as time passes, OI-weighted).",
  },
  dex: {
    fullName: "Delta exposure (DEX)",
    id: "dex",
    label: "DEX",
    negativeBadge: "Min DEX",
    negativeWallLabel: "Most negative DEX",
    positiveBadge: "Max DEX",
    positiveWallLabel: "Largest positive DEX",
    unitText:
      "Net open-interest delta notional ($, holders' side: calls positive, puts negative).",
  },
  gex: {
    fullName: "Gamma exposure (GEX)",
    id: "gex",
    label: "GEX",
    negativeBadge: "Put wall",
    negativeWallLabel: "Put wall (most negative)",
    positiveBadge: "Call wall",
    positiveWallLabel: "Call wall (largest +GEX)",
    unitText:
      "Estimated dealer gamma ($ per 1% move, OI-weighted; dealers long calls, short puts).",
  },
  vex: {
    fullName: "Vanna exposure (VEX)",
    id: "vex",
    label: "VEX",
    negativeBadge: "Min VEX",
    negativeWallLabel: "Most negative VEX",
    positiveBadge: "Max VEX",
    positiveWallLabel: "Largest positive VEX",
    unitText:
      "Estimated dealer vanna ($ delta per +1 IV point, OI-weighted; dealers long calls, short puts).",
  },
  volumeGex: {
    fullName: "Volume-weighted GEX",
    id: "volumeGex",
    label: "Vol-GEX",
    negativeBadge: "Put wall",
    negativeWallLabel: "Vol put wall (most negative)",
    positiveBadge: "Call wall",
    positiveWallLabel: "Vol call wall (largest +GEX)",
    unitText:
      "Estimated gamma ($ per 1% move) weighted by today's session contract volume.",
  },
};

export const GREEK_HEATMAP_TABS: readonly GreekHeatmapTabSpec[] =
  GREEK_HEATMAP_METRICS.map((id) => GREEK_HEATMAP_TAB_BY_ID[id]);

const MINUS = "\u2212";

/** Formats a signed exposure value in compact US dollars (`+$4.2M`, `−$180K`, `$0`). */
export const formatExposure = (value: number | null): string => {
  if (value === null) return "";
  const abs = Math.abs(value);
  if (abs < 0.5) return "$0";
  const sign = value < 0 ? MINUS : "+";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

/** Full-precision tooltip value for one heatmap cell. */
export const formatExposureFull = (value: number): string => {
  const abs = Math.abs(value);
  const sign = value < 0 ? MINUS : value > 0 ? "+" : "";
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
};

export const formatStrike = (strike: number): string =>
  Number.isInteger(strike) ? String(strike) : strike.toFixed(2);

export const formatPrice = (price: number): string => `$${price.toFixed(2)}`;

export const formatExpiryShort = (expiry: string): string =>
  new Date(`${expiry}T12:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

export const formatDistancePct = (
  level: number,
  spot: number | null
): string | null => {
  if (spot === null || spot <= 0) return null;
  const pct = ((level - spot) / spot) * 100;
  if (Math.abs(pct) < 0.05) return "at spot";
  const sign = pct < 0 ? MINUS : "+";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
};

/**
 * Diverging semantic CSS background using theme tokens (`--color-success` /
 * `--color-destructive`) so contrast holds in light, dark and all ten palettes.
 */
export const cellBackground = (
  value: number | null,
  maxAbs: number
): string | undefined => {
  if (value === null || value === 0 || maxAbs <= 0) return undefined;
  const ratio = Math.min(1, Math.abs(value) / maxAbs);
  const mix = Math.round(8 + ratio ** 0.7 * 34);
  const token = value > 0 ? "var(--color-success)" : "var(--color-destructive)";
  return `color-mix(in oklab, ${token} ${mix}%, transparent)`;
};

export type LevelPosition = "at" | "below" | null;

export type HeatmapRowView = Readonly<{
  strike: number;
  values: readonly (number | null)[];
  total: number | null;
  isKing: boolean;
  isCallWall: boolean;
  isPutWall: boolean;
  spotPosition: LevelPosition;
  flipPosition: LevelPosition;
  barWidthPct: number;
}>;

export type HeatmapGridView = Readonly<{
  metric: GreekHeatmapMetricData;
  tab: GreekHeatmapTabSpec;
  rows: readonly HeatmapRowView[];
  maxAbsCell: number;
  flipLevel: number | null;
  flipLabel: string;
  flipIsReference: boolean;
  kingValue: number | null;
  callWallValue: number | null;
  putWallValue: number | null;
}>;

const levelPosition = (
  level: number | null,
  strike: number,
  nextStrike: number | undefined
): LevelPosition => {
  if (level === null) return null;
  if (Math.abs(level - strike) <= 1e-6) return "at";
  if (nextStrike !== undefined && strike > level && level > nextStrike)
    return "below";
  return null;
};

export const buildHeatmapGridView = (
  output: GreekHeatmapOutput,
  metricKey: GreekHeatmapMetric
): HeatmapGridView => {
  const metric = output.metrics[metricKey];
  const tab = GREEK_HEATMAP_TAB_BY_ID[metricKey];
  const maxAbsCell = Math.max(
    0,
    ...metric.rows.flatMap((row) =>
      row.values.map((value) => (value === null ? 0 : Math.abs(value)))
    )
  );
  const maxAbsTotal = Math.max(
    1,
    ...metric.rows.map((row) => (row.total === null ? 0 : Math.abs(row.total)))
  );
  const flipIsReference =
    metric.marks.flip === null && output.metrics.gex.marks.flip !== null;
  const flipLevel = metric.marks.flip ?? output.metrics.gex.marks.flip;
  const flipLabel =
    metricKey === "volumeGex" && !flipIsReference
      ? "Vol-GEX flip"
      : flipIsReference
        ? "GEX flip (ref.)"
        : "Gamma flip";

  const totalByStrike = new Map(
    metric.rows.map((row) => [row.strike, row.total] as const)
  );
  const rows: HeatmapRowView[] = metric.rows.map((row, index) => {
    const nextStrike = metric.rows[index + 1]?.strike;
    return {
      barWidthPct:
        row.total === null ? 0 : (Math.abs(row.total) / maxAbsTotal) * 100,
      flipPosition: levelPosition(flipLevel, row.strike, nextStrike),
      isCallWall: row.strike === metric.marks.callWall,
      isKing: row.strike === metric.marks.kingStrike,
      isPutWall: row.strike === metric.marks.putWall,
      spotPosition: levelPosition(output.spot, row.strike, nextStrike),
      strike: row.strike,
      total: row.total,
      values: row.values,
    };
  });

  return {
    callWallValue:
      metric.marks.callWall === null
        ? null
        : (totalByStrike.get(metric.marks.callWall) ?? null),
    flipIsReference,
    flipLabel,
    flipLevel,
    kingValue:
      metric.marks.kingStrike === null
        ? null
        : (totalByStrike.get(metric.marks.kingStrike) ?? null),
    maxAbsCell,
    metric,
    putWallValue:
      metric.marks.putWall === null
        ? null
        : (totalByStrike.get(metric.marks.putWall) ?? null),
    rows,
    tab,
  };
};

/** Keyboard navigation for WAI-ARIA tablists (Left/Right/Home/End). */
export const nextTabIndex = (
  current: number,
  key: string,
  count: number
): number | null => {
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
};
