// What: pure data model, coincident-level grouping, non-overlapping label placement,
// and KLineCharts 9.8.12 custom overlay figure generator (`vxGammaLevels`) for drawing gamma flip,
// call wall, put wall, max pain, and king node as horizontal lines on price charts.
// Display only: research context, never an order or risk input.
// Used by: features/charts/kline-adapter.ts, features/charts/chart-workstation.tsx,
// components/portal/gamma-levels-bar.tsx, components/portal/use-gamma-levels.ts,
// features/flow/gamma-levels-view-model.ts.

import {
  FLOW_INSTRUMENTS,
  type FlowGex,
  type OptionsAnalyticsOutput,
} from "@darkfactory/api";
import {
  chartFontFamily,
  isCompactPlotWidth,
  legendClearancePx,
} from "./chart-legend-layout.ts";
import type { ChartPalette, GammaLevelsOverlay } from "./types.ts";

export type { GammaLevelsOverlay } from "./types.ts";

export const GAMMA_LEVELS_OVERLAY = "vxGammaLevels" as const;
export const GAMMA_LEVELS_GROUP_ID = "vx-gamma-levels" as const;
export const GAMMA_LEVEL_KINDS = [
  "flip",
  "callWall",
  "putWall",
  "maxPain",
  "kingNode",
] as const;

export type GammaLevelKind = (typeof GAMMA_LEVEL_KINDS)[number];

export type GammaLevelMeta = Readonly<{
  kind: GammaLevelKind;
  label: string;
  shortLabel: string;
  glyph: string;
  strokeStyle: "solid" | "dashed";
  dashedValue: readonly number[];
  svgDashArray: string | undefined;
  strokeWidth: number;
  meaning: string;
}>;

export const GAMMA_LEVEL_META: Readonly<
  Record<GammaLevelKind, GammaLevelMeta>
> = Object.freeze({
  callWall: {
    dashedValue: [],
    glyph: "▲",
    kind: "callWall",
    label: "Call wall",
    meaning: "Strike with the largest positive estimated net GEX",
    shortLabel: "Call wall",
    strokeStyle: "solid",
    strokeWidth: 1.75,
    svgDashArray: undefined,
  },
  flip: {
    dashedValue: [8, 4],
    glyph: "⇄",
    kind: "flip",
    label: "Gamma flip",
    meaning: "Estimated spot where dealer net GEX crosses zero",
    shortLabel: "Flip",
    strokeStyle: "dashed",
    strokeWidth: 1.75,
    svgDashArray: "8 4",
  },
  kingNode: {
    dashedValue: [10, 3, 2, 3],
    glyph: "★",
    kind: "kingNode",
    label: "King node",
    meaning: "Strike with the largest absolute estimated net GEX",
    shortLabel: "King",
    strokeStyle: "dashed",
    strokeWidth: 2.25,
    svgDashArray: "10 3 2 3",
  },
  maxPain: {
    dashedValue: [2, 4],
    glyph: "◎",
    kind: "maxPain",
    label: "Max pain",
    meaning: "Strike minimizing aggregate open-interest holder payout",
    shortLabel: "Max pain",
    strokeStyle: "dashed",
    strokeWidth: 1.5,
    svgDashArray: "2 4",
  },
  putWall: {
    dashedValue: [],
    glyph: "▼",
    kind: "putWall",
    label: "Put wall",
    meaning: "Strike with the most negative estimated net GEX",
    shortLabel: "Put wall",
    strokeStyle: "solid",
    strokeWidth: 1.75,
    svgDashArray: undefined,
  },
});

export type GammaLevelEntry = Readonly<{
  kind: GammaLevelKind;
  price: number;
  label: string;
  shortLabel: string;
  glyph: string;
  distancePct: number | null;
  coincidentWith: readonly GammaLevelKind[];
}>;

export type GammaLevelGroup = Readonly<{
  key: string;
  price: number;
  kinds: readonly GammaLevelKind[];
  primaryKind: GammaLevelKind;
  hasKingNode: boolean;
  glyphs: string;
  shortLabel: string;
  pillText: string;
}>;

const COINCIDENT_EPSILON = 1e-6;
const PILL_MIN_GAP_PX = 20;
const PILL_HALF_HEIGHT_PX = 9;
const ABOVE_PILL_CLEARANCE_PX = 28;
const PILL_PADDING_Y_PX = 12;
const PILL_EDGE_X_PX = 8;
const positiveFiniteOrNull = (
  value: number | null | undefined
): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;

const finiteOrNull = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Builds a chart overlay from `optionsAnalytics.snapshot`; returns null when no level exists. */
export const gammaLevelsFromOptionsAnalytics = (
  output: OptionsAnalyticsOutput
): GammaLevelsOverlay | null => {
  const flip = positiveFiniteOrNull(output.context.levels.flip);
  const callWall = positiveFiniteOrNull(output.context.levels.callWall);
  const putWall = positiveFiniteOrNull(output.context.levels.putWall);
  const maxPain = positiveFiniteOrNull(output.exposure.maxPain);
  const kingNode = positiveFiniteOrNull(output.context.levels.kingNode);
  if (
    flip === null &&
    callWall === null &&
    putWall === null &&
    maxPain === null &&
    kingNode === null
  )
    return null;
  return {
    asOf: output.receivedAt,
    basis: 0,
    callWall,
    flip,
    kingNode,
    maxPain,
    putWall,
    regime: output.context.regime,
    source: "optionsAnalytics",
    spot: positiveFiniteOrNull(output.spot),
    symbol: output.symbol,
    underlyingTicker: output.symbol,
  };
};

/**
 * Builds a chart overlay from `flow.snapshot`'s stored `flow_gex` row.
 * - When `symbol === gex.ticker` (e.g. `"SPY"` on SPY or `"SPX"` on ES Option Bubbles), uses
 *   unshifted `gex.levels` directly in the options underlying's coordinate space (`basis: 0`).
 * - When `symbol !== gex.ticker` (e.g. `"ES"` futures with `"SPX"` GEX), uses basis-shifted
 *   `gex.symbolLevels` and never plots unshifted index levels when `basis` is missing.
 */
export const gammaLevelsFromFlowGex = (
  symbol: string,
  gex: FlowGex | null
): GammaLevelsOverlay | null => {
  if (gex === null) return null;
  const directTicker = gex.ticker === symbol;
  if (!directTicker) {
    const instrument = Object.hasOwn(FLOW_INSTRUMENTS, symbol)
      ? FLOW_INSTRUMENTS[symbol as keyof typeof FLOW_INSTRUMENTS]
      : undefined;
    if (instrument === undefined || instrument.optionsTicker !== gex.ticker)
      return null;
  }
  const active = directTicker ? gex.levels : gex.symbolLevels;
  if (active === null) return null;
  const flip = positiveFiniteOrNull(active.flip);
  const callWall = positiveFiniteOrNull(active.callWall);
  const putWall = positiveFiniteOrNull(active.putWall);
  const maxPain = positiveFiniteOrNull(active.maxPain);
  const kingNode = positiveFiniteOrNull(active.kingNode);
  if (
    flip === null &&
    callWall === null &&
    putWall === null &&
    maxPain === null &&
    kingNode === null
  )
    return null;
  const rawSpot = positiveFiniteOrNull(gex.spot);
  const basis = directTicker ? 0 : finiteOrNull(gex.basis);
  const spot =
    rawSpot === null
      ? null
      : directTicker
        ? rawSpot
        : basis === null
          ? null
          : positiveFiniteOrNull(rawSpot + basis);
  return {
    asOf: gex.at,
    basis,
    callWall,
    flip,
    kingNode,
    maxPain,
    putWall,
    regime: gex.regime,
    source: "flowGex",
    spot,
    symbol,
    underlyingTicker: gex.ticker,
  };
};

/** Validates a gamma-levels overlay before passing it to the chart renderer. */
export const validGammaLevelsOverlay = (
  overlay: GammaLevelsOverlay
): boolean => {
  if (overlay.symbol.trim() === "") return false;
  if (
    overlay.spot !== null &&
    (!Number.isFinite(overlay.spot) || overlay.spot <= 0)
  )
    return false;
  if (overlay.basis !== null && !Number.isFinite(overlay.basis)) return false;
  let present = 0;
  for (const kind of GAMMA_LEVEL_KINDS) {
    const value = overlay[kind];
    if (value === null) continue;
    if (!Number.isFinite(value) || value <= 0) return false;
    present += 1;
  }
  return present > 0;
};

/** Value equality used by the KLineCharts adapter to avoid redundant overlay redraws. */
export const sameGammaLevelsOverlay = (
  a: GammaLevelsOverlay | null,
  b: GammaLevelsOverlay | null
): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.source === b.source &&
    a.symbol === b.symbol &&
    a.underlyingTicker === b.underlyingTicker &&
    a.asOf === b.asOf &&
    a.spot === b.spot &&
    a.basis === b.basis &&
    a.regime === b.regime &&
    a.flip === b.flip &&
    a.callWall === b.callWall &&
    a.putWall === b.putWall &&
    a.maxPain === b.maxPain &&
    a.kingNode === b.kingNode);

/** Non-null gamma levels in canonical display order with relative distance and coincidences. */
export const extractGammaLevelEntries = (
  overlay: GammaLevelsOverlay,
  referencePrice: number | null = overlay.spot
): readonly GammaLevelEntry[] => {
  const ref = positiveFiniteOrNull(referencePrice);
  const present = GAMMA_LEVEL_KINDS.flatMap((kind) => {
    const price = overlay[kind];
    return price === null ? [] : [{ kind, price }];
  });
  return present.map(({ kind, price }) => {
    const meta = GAMMA_LEVEL_META[kind];
    const coincidentWith = present
      .filter(
        (other) =>
          other.kind !== kind &&
          Math.abs(other.price - price) <= COINCIDENT_EPSILON
      )
      .map((other) => other.kind);
    return {
      coincidentWith,
      distancePct: ref === null ? null : ((price - ref) / ref) * 100,
      glyph: meta.glyph,
      kind,
      label: meta.label,
      price,
      shortLabel: meta.shortLabel,
    };
  });
};

// Priority order for choosing the line's primary visual style when two levels share a strike.
const PRIMARY_RANK: Readonly<Record<GammaLevelKind, number>> = {
  callWall: 0,
  flip: 2,
  kingNode: 3,
  maxPain: 4,
  putWall: 1,
};

/**
 * Merges levels that sit at the exact same price (for example, King node coinciding with
 * Call wall or Put wall) into one plotted horizontal line with a combined label pill.
 */
export const groupCoincidentGammaLevels = (
  overlay: GammaLevelsOverlay,
  pricePrecision = 2
): readonly GammaLevelGroup[] => {
  const groups: {
    price: number;
    primary: GammaLevelKind;
    kinds: GammaLevelKind[];
  }[] = [];
  for (const kind of GAMMA_LEVEL_KINDS) {
    const price = overlay[kind];
    if (price === null || !Number.isFinite(price) || price <= 0) continue;
    const match = groups.find(
      (group) => Math.abs(group.price - price) <= COINCIDENT_EPSILON
    );
    if (match === undefined) {
      groups.push({ kinds: [kind], price, primary: kind });
    } else {
      match.kinds.push(kind);
      if (PRIMARY_RANK[kind] < PRIMARY_RANK[match.primary])
        match.primary = kind;
    }
  }
  groups.sort((a, b) => b.price - a.price);
  return groups.map(({ price, primary, kinds }) => {
    const ordered = [...kinds].sort(
      (a, b) => PRIMARY_RANK[a] - PRIMARY_RANK[b]
    );
    const glyphs = ordered.map((kind) => GAMMA_LEVEL_META[kind].glyph).join("");
    const shortLabel = ordered
      .map((kind) => GAMMA_LEVEL_META[kind].shortLabel)
      .join(" · ");
    const formatted = price.toFixed(pricePrecision);
    return {
      glyphs,
      hasKingNode: ordered.includes("kingNode"),
      key: ordered.join("+"),
      kinds: ordered,
      pillText: `${glyphs} ${shortLabel} ${formatted}`,
      price,
      primaryKind: primary,
      shortLabel,
    };
  });
};

/** Short Object Tree description for ChartWorkstation. */
export const gammaLevelsObjectLabel = (overlay: GammaLevelsOverlay): string =>
  `Gamma levels (${extractGammaLevelEntries(overlay).length})`;

export type LabelPlacementInput = Readonly<{
  id: string;
  idealY: number;
}>;

/**
 * Resolves vertical overlaps among level pills while staying within `[minY, maxY]`.
 * Deterministic: sorts by `idealY` ascending, enforces `minGap` downward then upward, and clamps.
 */
export const resolveGammaLabelY = (
  items: readonly LabelPlacementInput[],
  minY: number,
  maxY: number,
  minGap: number = PILL_MIN_GAP_PX
): Readonly<Record<string, number>> => {
  if (items.length === 0) return {};
  const lo = Math.min(minY, maxY);
  const hi = Math.max(minY, maxY);
  const sorted = [...items].sort((a, b) => a.idealY - b.idealY);
  const rows: { id: string; y: number }[] = [];
  let previousY: number | null = null;
  for (const item of sorted) {
    let y = Math.max(lo, Math.min(hi, item.idealY));
    if (previousY !== null && y - previousY < minGap) y = previousY + minGap;
    rows.push({ id: item.id, y });
    previousY = y;
  }
  if (previousY !== null && previousY > hi) {
    let nextY = hi;
    let isLast = true;
    for (const row of [...rows].reverse()) {
      row.y = isLast ? hi : Math.min(row.y, nextY - minGap);
      nextY = row.y;
      isLast = false;
    }
  }
  const placed: Record<string, number> = {};
  for (const row of rows) placed[row.id] = Math.max(lo, Math.min(hi, row.y));
  return placed;
};

// --- KLineCharts 9.8.12 custom overlay (`vxGammaLevels`) ----------------------------------------

export type OverlayCoordinate = Readonly<{ x: number; y: number }>;
export type OverlayBounding = Readonly<{ width: number; height: number }>;

export type GammaLevelsFigure =
  | Readonly<{
      type: "line";
      attrs: Readonly<{ coordinates: readonly OverlayCoordinate[] }>;
      styles: Readonly<{
        style: "solid" | "dashed";
        color: string;
        size: number;
        dashedValue?: readonly number[];
      }>;
      ignoreEvent: true;
    }>
  | Readonly<{
      type: "text";
      attrs: Readonly<{
        x: number;
        y: number;
        text: string;
        align: "left" | "center" | "right";
        baseline: "top" | "middle" | "bottom";
      }>;
      styles: Readonly<{
        style: "stroke_fill";
        color: string;
        backgroundColor: string;
        borderColor: string;
        borderSize: number;
        borderRadius: number;
        family: string;
        size: number;
        paddingLeft: number;
        paddingRight: number;
        paddingTop: number;
        paddingBottom: number;
      }>;
      ignoreEvent: true;
    }>;

export type GammaLevelLineSpec = Readonly<{
  key: string;
  pillText: string;
  shortLabel: string;
  glyphs: string;
  priceText: string;
  color: string;
  accentColor: string;
  hasKingNode: boolean;
  isMergedWithKing: boolean;
  strokeStyle: "solid" | "dashed";
  dashedValue: readonly number[];
  strokeWidth: number;
}>;

export type GammaLevelsOverlayData = Readonly<{
  lines: readonly GammaLevelLineSpec[];
  foreground: string;
  background: string;
  fontFamily: string;
  grid: string;
  kingColor: string;
}>;

const paletteColorFor = (
  kind: GammaLevelKind,
  palette: ChartPalette
): string => {
  if (kind === "callWall") return palette.success ?? palette.rising;
  if (kind === "putWall") return palette.destructive ?? palette.falling;
  if (kind === "flip") return palette.warning ?? palette.accent;
  if (kind === "maxPain") return palette.info ?? palette.foreground;
  return palette.king ?? palette.accent;
};

/** Builds the render payload attached to `vxGammaLevels` via `overlay.extendData`. */
export const gammaLevelsOverlayData = (
  overlay: GammaLevelsOverlay,
  palette: ChartPalette,
  pricePrecision: number
): GammaLevelsOverlayData => {
  const groups = groupCoincidentGammaLevels(overlay, pricePrecision);
  const kingColor = paletteColorFor("kingNode", palette);
  return {
    background: palette.background,
    fontFamily: chartFontFamily(palette),
    foreground: palette.foreground,
    grid: palette.grid,
    kingColor,
    lines: groups.map((group) => {
      const meta = GAMMA_LEVEL_META[group.primaryKind];
      return {
        accentColor: kingColor,
        color: paletteColorFor(group.primaryKind, palette),
        dashedValue: meta.dashedValue,
        glyphs: group.glyphs,
        hasKingNode: group.hasKingNode,
        isMergedWithKing: group.hasKingNode && group.kinds.length > 1,
        key: group.key,
        pillText: group.pillText,
        priceText: group.price.toFixed(pricePrecision),
        shortLabel: group.shortLabel,
        strokeStyle: meta.strokeStyle,
        strokeWidth: group.hasKingNode
          ? Math.max(meta.strokeWidth, 2.25)
          : meta.strokeWidth,
      };
    }),
  };
};

const isOverlayData = (value: unknown): value is GammaLevelsOverlayData => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate["lines"]) &&
    typeof candidate["foreground"] === "string" &&
    typeof candidate["background"] === "string" &&
    typeof candidate["fontFamily"] === "string" &&
    typeof candidate["grid"] === "string" &&
    typeof candidate["kingColor"] === "string"
  );
};

const finiteY = (
  coordinate: OverlayCoordinate | undefined
): coordinate is OverlayCoordinate =>
  coordinate !== undefined && Number.isFinite(coordinate.y);

const pillStyle = (
  background: string,
  foreground: string,
  borderColor: string,
  size: number,
  family: string
) => ({
  backgroundColor: background,
  borderColor,
  borderRadius: 3,
  borderSize: 1,
  color: foreground,
  family,
  paddingBottom: 2,
  paddingLeft: 5,
  paddingRight: 5,
  paddingTop: 2,
  size,
  style: "stroke_fill" as const,
});

/** The level line, its king accent, the pill and, when the pill moved off the line, a leader. */
const levelFigures = (
  spec: GammaLevelLineSpec,
  y: number,
  labelY: number,
  width: number,
  narrow: boolean,
  data: GammaLevelsOverlayData
): readonly GammaLevelsFigure[] => {
  const across = [
    { x: 0, y },
    { x: width, y },
  ];
  const figures: GammaLevelsFigure[] = [
    {
      attrs: { coordinates: across },
      ignoreEvent: true,
      styles:
        spec.strokeStyle === "dashed"
          ? {
              color: spec.color,
              dashedValue: spec.dashedValue,
              size: spec.strokeWidth,
              style: "dashed",
            }
          : {
              color: spec.color,
              size: spec.strokeWidth,
              style: "solid",
            },
      type: "line",
    },
  ];
  if (spec.isMergedWithKing) {
    figures.push({
      attrs: { coordinates: across },
      ignoreEvent: true,
      styles: {
        color: spec.accentColor,
        dashedValue: [4, 14],
        size: 2.5,
        style: "dashed",
      },
      type: "line",
    });
  }
  if (Math.abs(labelY - y) > 2) {
    figures.push({
      attrs: {
        coordinates: [
          { x: 0, y },
          { x: PILL_EDGE_X_PX, y: labelY },
        ],
      },
      ignoreEvent: true,
      styles: { color: spec.color, size: 1, style: "solid" },
      type: "line",
    });
  }
  figures.push({
    attrs: {
      align: "left",
      baseline: "middle",
      text: narrow ? `${spec.glyphs} ${spec.priceText}` : spec.pillText,
      x: PILL_EDGE_X_PX,
      y: labelY,
    },
    ignoreEvent: true,
    styles: pillStyle(
      data.background,
      data.foreground,
      spec.hasKingNode ? data.kingColor : spec.color,
      11,
      data.fontFamily
    ),
    type: "text",
  });
  return figures;
};

/** One summary pill per side for the levels above and below the visible price range. */
const edgeSummaryFigures = (
  above: readonly GammaLevelLineSpec[],
  below: readonly GammaLevelLineSpec[],
  width: number,
  height: number,
  narrow: boolean,
  aboveY: number,
  data: GammaLevelsOverlayData
): readonly GammaLevelsFigure[] => {
  const edgeX = Math.max(8, width - 6);
  const summary = (
    items: readonly GammaLevelLineSpec[],
    direction: "↑ Above" | "↓ Below"
  ): string => {
    const full = `${direction}: ${items
      .map((line) => `${line.glyphs} ${line.shortLabel} ${line.priceText}`)
      .join(" · ")}`;
    if (items.length > 1 && (narrow || full.length * 6.4 + 18 > width - 12)) {
      const first = items[0] as GammaLevelLineSpec;
      return `${direction}: ${items.length} (${first.glyphs} ${first.priceText}…)`;
    }
    return full;
  };
  const figures: GammaLevelsFigure[] = [];
  if (above.length > 0) {
    figures.push({
      attrs: {
        align: "right",
        baseline: "top",
        text: summary(above, "↑ Above"),
        x: edgeX,
        y: aboveY,
      },
      ignoreEvent: true,
      styles: pillStyle(
        data.background,
        data.foreground,
        data.grid,
        10,
        data.fontFamily
      ),
      type: "text",
    });
  }
  if (below.length > 0) {
    figures.push({
      attrs: {
        align: "right",
        baseline: "bottom",
        text: summary(below, "↓ Below"),
        x: edgeX,
        y: Math.max(14, height - 4),
      },
      ignoreEvent: true,
      styles: pillStyle(
        data.background,
        data.foreground,
        data.grid,
        10,
        data.fontFamily
      ),
      type: "text",
    });
  }
  return figures;
};

/**
 * Generates KLineCharts overlay figures for horizontal gamma levels.
 * `coordinates[i]` maps 1:1 to `data.lines[i]`. In-bounds lines draw full-width with
 * de-overlapped pills at the left edge, over the oldest bars, so the newest candles stay
 * visible; a pane narrower than 420 px gets the short pill (glyphs and price). Out-of-bounds
 * levels summarize at the top/bottom edges.
 */
export const gammaLevelsFigures = (
  coordinates: readonly OverlayCoordinate[],
  data: unknown,
  bounding?: OverlayBounding
): readonly GammaLevelsFigure[] => {
  if (!isOverlayData(data) || data.lines.length === 0) return [];
  const width = positiveFiniteOrNull(bounding?.width) ?? 600;
  const height = positiveFiniteOrNull(bounding?.height) ?? 360;

  const visible: { spec: GammaLevelLineSpec; y: number }[] = [];
  const above: GammaLevelLineSpec[] = [];
  const below: GammaLevelLineSpec[] = [];

  for (let i = 0; i < data.lines.length; i += 1) {
    const spec = data.lines[i];
    const coord = coordinates[i];
    if (spec === undefined || !finiteY(coord)) continue;
    if (coord.y < 0) above.push(spec);
    else if (coord.y > height) below.push(spec);
    else visible.push({ spec, y: coord.y });
  }

  const narrow = width < 420;
  const bottomReserve =
    below.length > 0
      ? height - PILL_PADDING_Y_PX - 20
      : height - PILL_PADDING_Y_PX;
  // Place the top-right "↑ Above" summary below the price + overlay legend on every pane width
  // so it never overlaps the legend rows. Visible pills (baseline "middle", ~18 px tall) start
  // cleanly below the legend or below the "↑ Above" pill.
  const legendTop = legendClearancePx(isCompactPlotWidth(width), 1);
  const aboveY = Math.min(legendTop, Math.max(4, height - 36));
  const minPillTop =
    above.length > 0
      ? aboveY + ABOVE_PILL_CLEARANCE_PX
      : legendTop + PILL_HALF_HEIGHT_PX;
  const topReserve = Math.max(
    PILL_PADDING_Y_PX,
    Math.min(minPillTop, bottomReserve - (visible.length - 1) * PILL_MIN_GAP_PX)
  );
  const placedY = resolveGammaLabelY(
    visible.map((entry) => ({ id: entry.spec.key, idealY: entry.y })),
    topReserve,
    Math.max(topReserve, bottomReserve),
    PILL_MIN_GAP_PX
  );

  return [
    ...visible.flatMap(({ spec, y }) =>
      levelFigures(spec, y, placedY[spec.key] as number, width, narrow, data)
    ),
    ...edgeSummaryFigures(above, below, width, height, narrow, aboveY, data),
  ];
};
