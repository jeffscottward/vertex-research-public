// Pure geometry, validation, and KLineCharts figure builder for the per-expiry ±1σ expected
// move cone overlay (vxExpectedMoveCone). Zero circular imports: callers supply bar spacing.
// Display only: never a trade signal or order input.

import {
  EXPECTED_MOVE_BASES,
  type ExpectedMoveBasis,
  type OptionsExpectedMoveOutput,
} from "@darkfactory/api";

import type { ChartPalette, ExpectedMoveCone } from "./types.ts";

const DAY_MS = 86_400_000;
const SPACING_BARS = 20;

/**
 * Typical bar spacing: the lower median gap of the last 20 bars, so one weekend or holiday gap
 * does not distort forward projections. Fewer than two bars fall back to one day.
 */
export const barSpacing = (timestamps: readonly number[]): number => {
  const gaps: number[] = [];
  let prior: number | null = null;
  for (const timestamp of timestamps.slice(-(SPACING_BARS + 1))) {
    if (prior !== null) gaps.push(timestamp - prior);
    prior = timestamp;
  }
  const middle = Math.floor((gaps.length - 1) / 2);
  return gaps
    .sort((left, right) => left - right)
    .slice(middle, middle + 1)
    .reduce((_, gap) => gap, DAY_MS);
};

export const EXPECTED_MOVE_GROUP_ID = "vx_expected_move" as const;
export const EXPECTED_MOVE_OVERLAY = "vxExpectedMoveCone" as const;
export const MIN_EXPECTED_MOVE_CONE_BARS = 4;
export const MAX_EXPECTED_MOVE_CONE_BARS = 24;
export const CONE_CURVE_STEPS = 12;

export type ExpectedMoveHorizonScale = "exact" | "expanded" | "compressed";

export type ExpectedMoveTarget = Readonly<{
  anchorIndex: number;
  targetIndex: number;
  span: number;
  horizonScale: ExpectedMoveHorizonScale;
}>;

export type OverlayCoordinate = Readonly<{ x: number; y: number }>;
export type OverlayBounding = Readonly<{ width: number; height: number }>;

export type ExpectedMoveOverlayData = Readonly<{
  background: string;
  expiryLabel: string;
  foreground: string;
  grid: string;
  hasStraddle: boolean;
  lowerLabel: string;
  stroke: string;
  fill: string;
  upperLabel: string;
}>;

export type ExpectedMoveFigure = Readonly<{
  type: "polygon" | "line" | "text";
  attrs: Record<string, unknown>;
  styles: Record<string, unknown>;
  ignoreEvent: true;
}>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isFinitePositive = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const isFiniteNonNegative = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;

const isExpectedMoveBasis = (value: string): value is ExpectedMoveBasis =>
  (EXPECTED_MOVE_BASES as readonly string[]).includes(value);

/** Runtime guard for an ExpectedMoveCone passed to the chart renderer. */
export const validExpectedMoveCone = (cone: ExpectedMoveCone): boolean => {
  const validMeta =
    ISO_DATE.test(cone.expiry) &&
    Number.isSafeInteger(cone.expiryCloseMs) &&
    cone.expiryCloseMs > 0 &&
    Number.isSafeInteger(cone.dte) &&
    cone.dte >= 0 &&
    isExpectedMoveBasis(cone.basis);
  if (!validMeta) return false;

  const validBands =
    isFinitePositive(cone.spot) &&
    isFinitePositive(cone.expectedMove) &&
    isFinitePositive(cone.expectedMovePct) &&
    isFinitePositive(cone.upperBand) &&
    isFiniteNonNegative(cone.lowerBand) &&
    cone.lowerBand <= cone.spot &&
    cone.spot <= cone.upperBand;
  if (!validBands) return false;

  if (
    cone.straddlePrice === null &&
    cone.straddleUpper === null &&
    cone.straddleLower === null
  )
    return true;
  if (
    cone.straddlePrice === null ||
    cone.straddleUpper === null ||
    cone.straddleLower === null
  )
    return false;
  return (
    isFinitePositive(cone.straddlePrice) &&
    isFinitePositive(cone.straddleUpper) &&
    isFiniteNonNegative(cone.straddleLower) &&
    cone.straddleLower <= cone.spot &&
    cone.spot <= cone.straddleUpper
  );
};

/** Value equality check for two ExpectedMoveCone objects so identical re-renders avoid redraws. */
export const sameExpectedMoveCone = (
  left: ExpectedMoveCone | null,
  right: ExpectedMoveCone | null
): boolean => {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.expiry === right.expiry &&
    left.expiryCloseMs === right.expiryCloseMs &&
    left.dte === right.dte &&
    left.spot === right.spot &&
    left.upperBand === right.upperBand &&
    left.lowerBand === right.lowerBand &&
    left.straddleUpper === right.straddleUpper &&
    left.straddleLower === right.straddleLower &&
    left.expectedMove === right.expectedMove &&
    left.expectedMovePct === right.expectedMovePct &&
    left.straddlePrice === right.straddlePrice &&
    left.basis === right.basis
  );
};

/** Maps an API expected-move payload to the renderer's ExpectedMoveCone, or null when unavailable. */
export const toExpectedMoveCone = (
  output: OptionsExpectedMoveOutput | null
): ExpectedMoveCone | null => {
  if (output === null || output.band === null || output.spot === null)
    return null;
  const { band, dte, expiry, spot } = output;
  return {
    basis: band.basis,
    dte,
    expectedMove: band.expectedMove,
    expectedMovePct: band.expectedMovePct,
    expiry,
    expiryCloseMs: band.expiryCloseMs,
    lowerBand: band.lowerBand,
    spot,
    straddleLower: band.straddleLower,
    straddlePrice: band.straddlePrice,
    straddleUpper: band.straddleUpper,
    upperBand: band.upperBand,
  };
};

/**
 * Computes the anchor (last candle) and forward target bar index for an expiry timestamp.
 * Returns null when there are no candles, spacing is non-positive, or the expiry is not after
 * the last candle. Horizontal span is bounded to [MIN_EXPECTED_MOVE_CONE_BARS, MAX_EXPECTED_MOVE_CONE_BARS].
 */
export const expectedMoveTargetIndex = (
  timestamps: readonly number[],
  expiryCloseMs: number,
  spacingMs: number
): ExpectedMoveTarget | null => {
  const lastTimestamp = timestamps.at(-1);
  if (
    lastTimestamp === undefined ||
    !isFinitePositive(spacingMs) ||
    !Number.isFinite(expiryCloseMs) ||
    expiryCloseMs <= lastTimestamp
  )
    return null;
  const anchorIndex = timestamps.length - 1;
  const rawSteps = Math.max(
    1,
    Math.round((expiryCloseMs - lastTimestamp) / spacingMs)
  );
  const span = Math.min(
    MAX_EXPECTED_MOVE_CONE_BARS,
    Math.max(MIN_EXPECTED_MOVE_CONE_BARS, rawSteps)
  );
  const horizonScale: ExpectedMoveHorizonScale =
    rawSteps > MAX_EXPECTED_MOVE_CONE_BARS
      ? "compressed"
      : rawSteps < MIN_EXPECTED_MOVE_CONE_BARS
        ? "expanded"
        : "exact";
  return {
    anchorIndex,
    horizonScale,
    span,
    targetIndex: anchorIndex + span,
  };
};

/** Applies an opacity channel to oklch, hex, rgb/rgba, or generic CSS color tokens for Canvas 2D. */
export const withAlpha = (color: string, alpha: number): string => {
  const trimmed = color.trim();
  const clamped = Math.min(1, Math.max(0, alpha));
  const oklch = /^oklch\(([^/)]+)(?:\/[^)]+)?\)$/i.exec(trimmed);
  if (oklch !== null && oklch[1] !== undefined)
    return `oklch(${oklch[1].trim()} / ${clamped})`;
  const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed);
  if (
    hex3 !== null &&
    hex3[1] !== undefined &&
    hex3[2] !== undefined &&
    hex3[3] !== undefined
  ) {
    const r = Number.parseInt(hex3[1] + hex3[1], 16);
    const g = Number.parseInt(hex3[2] + hex3[2], 16);
    const b = Number.parseInt(hex3[3] + hex3[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${clamped})`;
  }
  const hex6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(trimmed);
  if (
    hex6 !== null &&
    hex6[1] !== undefined &&
    hex6[2] !== undefined &&
    hex6[3] !== undefined
  ) {
    const r = Number.parseInt(hex6[1], 16);
    const g = Number.parseInt(hex6[2], 16);
    const b = Number.parseInt(hex6[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${clamped})`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/i.exec(trimmed);
  if (rgb !== null) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${clamped})`;
  return `color-mix(in srgb, ${trimmed} ${Math.round(clamped * 100)}%, transparent)`;
};

/** Builds the palette-aware extendData payload attached to the vxExpectedMoveCone overlay. */
export const expectedMoveOverlayData = (
  cone: ExpectedMoveCone,
  palette: ChartPalette,
  pricePrecision: number
): ExpectedMoveOverlayData => {
  const stroke = palette.warning ?? palette.accent;
  return {
    background: palette.background,
    expiryLabel: `${cone.expiry.slice(5)} (${cone.dte}d)`,
    fill: withAlpha(stroke, 0.16),
    foreground: palette.foreground,
    grid: palette.grid,
    hasStraddle: cone.straddlePrice !== null,
    lowerLabel: `-1σ $${cone.lowerBand.toFixed(pricePrecision)}`,
    stroke,
    upperLabel: `+1σ $${cone.upperBand.toFixed(pricePrecision)}`,
  };
};

const isOverlayData = (value: unknown): value is ExpectedMoveOverlayData => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["background"] === "string" &&
    typeof candidate["expiryLabel"] === "string" &&
    typeof candidate["fill"] === "string" &&
    typeof candidate["foreground"] === "string" &&
    typeof candidate["grid"] === "string" &&
    typeof candidate["hasStraddle"] === "boolean" &&
    typeof candidate["lowerLabel"] === "string" &&
    typeof candidate["stroke"] === "string" &&
    typeof candidate["upperLabel"] === "string"
  );
};

const finiteCoord = (
  coord: OverlayCoordinate | undefined
): coord is OverlayCoordinate =>
  coord !== undefined && Number.isFinite(coord.x) && Number.isFinite(coord.y);

const LABEL_EDGE_MARGIN = 20;

const clampLabelY = (
  y: number,
  label: string,
  bounding: OverlayBounding | undefined
): Readonly<{ y: number; text: string }> => {
  if (bounding === undefined) return { text: label, y };
  if (y < LABEL_EDGE_MARGIN)
    return { text: `↑ ${label}`, y: LABEL_EDGE_MARGIN };
  if (y > bounding.height - LABEL_EDGE_MARGIN)
    return { text: `↓ ${label}`, y: bounding.height - LABEL_EDGE_MARGIN };
  return { text: label, y };
};

/**
 * Generates KLineCharts overlay figures for the √t expected-move cone from 5 points:
 * [apex(anchor, spot), upper(target, +1σ), lower(target, -1σ), straddleUp, straddleDown].
 */
export const expectedMoveConeFigures = (
  coordinates: readonly OverlayCoordinate[],
  data: unknown,
  bounding?: OverlayBounding
): readonly ExpectedMoveFigure[] => {
  const [apex, upper, lower, straddleUp, straddleDown] = coordinates;
  const ready =
    finiteCoord(apex) &&
    finiteCoord(upper) &&
    finiteCoord(lower) &&
    finiteCoord(straddleUp) &&
    finiteCoord(straddleDown) &&
    isOverlayData(data);
  if (!ready) return [];

  const upperCurve: OverlayCoordinate[] = [];
  const lowerCurve: OverlayCoordinate[] = [];
  for (let step = 0; step <= CONE_CURVE_STEPS; step += 1) {
    const u = step / CONE_CURVE_STEPS;
    const sqrtU = Math.sqrt(u);
    const x = apex.x + u * (upper.x - apex.x);
    upperCurve.push({ x, y: apex.y + sqrtU * (upper.y - apex.y) });
    lowerCurve.push({ x, y: apex.y + sqrtU * (lower.y - apex.y) });
  }
  const polygonCoords = [...upperCurve, ...lowerCurve.slice().reverse()];

  const figures: ExpectedMoveFigure[] = [
    {
      attrs: { coordinates: polygonCoords },
      ignoreEvent: true,
      styles: { color: data.fill, style: "fill" },
      type: "polygon",
    },
    {
      attrs: { coordinates: upperCurve },
      ignoreEvent: true,
      styles: {
        color: data.stroke,
        dashedValue: [5, 4],
        size: 1.5,
        style: "dashed",
      },
      type: "line",
    },
    {
      attrs: { coordinates: lowerCurve },
      ignoreEvent: true,
      styles: {
        color: data.stroke,
        dashedValue: [5, 4],
        size: 1.5,
        style: "dashed",
      },
      type: "line",
    },
    {
      attrs: { coordinates: [apex, { x: upper.x, y: apex.y }] },
      ignoreEvent: true,
      styles: {
        color: data.grid,
        dashedValue: [2, 3],
        size: 1,
        style: "dashed",
      },
      type: "line",
    },
    {
      attrs: { coordinates: [upper, lower] },
      ignoreEvent: true,
      styles: {
        color: data.grid,
        dashedValue: [2, 3],
        size: 1,
        style: "dashed",
      },
      type: "line",
    },
  ];

  if (data.hasStraddle) {
    figures.push(
      {
        attrs: {
          coordinates: [
            { x: upper.x - 6, y: straddleUp.y },
            { x: upper.x + 6, y: straddleUp.y },
          ],
        },
        ignoreEvent: true,
        styles: { color: data.foreground, size: 1.5, style: "solid" },
        type: "line",
      },
      {
        attrs: {
          coordinates: [
            { x: upper.x - 6, y: straddleDown.y },
            { x: upper.x + 6, y: straddleDown.y },
          ],
        },
        ignoreEvent: true,
        styles: { color: data.foreground, size: 1.5, style: "solid" },
        type: "line",
      }
    );
  }

  // Hide labels if the expiry target is panned outside the horizontal viewport.
  const targetVisibleX =
    bounding === undefined || (upper.x >= 0 && upper.x <= bounding.width);
  if (targetVisibleX) {
    const nearRightEdge =
      bounding !== undefined && upper.x > bounding.width - 64;
    const pillAlign = nearRightEdge ? "right" : "center";
    const pillX = nearRightEdge ? upper.x - 4 : upper.x;
    const upperPill = clampLabelY(upper.y - 4, data.upperLabel, bounding);
    const lowerPill = clampLabelY(lower.y + 4, data.lowerLabel, bounding);
    const pillStyle = {
      backgroundColor: data.background,
      borderColor: data.stroke,
      borderRadius: 3,
      borderSize: 1,
      color: data.foreground,
      paddingBottom: 2,
      paddingLeft: 4,
      paddingRight: 4,
      paddingTop: 2,
      size: 11,
      style: "stroke_fill",
    };
    figures.push(
      {
        attrs: {
          align: pillAlign,
          baseline: "bottom",
          text: upperPill.text,
          x: pillX,
          y: upperPill.y,
        },
        ignoreEvent: true,
        styles: pillStyle,
        type: "text",
      },
      {
        attrs: {
          align: pillAlign,
          baseline: "top",
          text: lowerPill.text,
          x: pillX,
          y: lowerPill.y,
        },
        ignoreEvent: true,
        styles: pillStyle,
        type: "text",
      },
      {
        attrs: {
          align: pillAlign,
          baseline: "middle",
          text: data.expiryLabel,
          x: pillX,
          y: apex.y,
        },
        ignoreEvent: true,
        styles: {
          ...pillStyle,
          borderColor: data.grid,
          size: 10,
        },
        type: "text",
      }
    );
    if (data.hasStraddle) {
      const tickStyle = {
        backgroundColor: "transparent",
        borderColor: "transparent",
        borderRadius: 0,
        borderSize: 0,
        color: data.foreground,
        paddingBottom: 0,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        size: 9,
        style: "fill",
      };
      const tickAlign = nearRightEdge ? "right" : "left";
      const tickX = nearRightEdge ? upper.x - 8 : upper.x + 8;
      figures.push(
        {
          attrs: {
            align: tickAlign,
            baseline: "middle",
            text: "BE+",
            x: tickX,
            y: straddleUp.y,
          },
          ignoreEvent: true,
          styles: tickStyle,
          type: "text",
        },
        {
          attrs: {
            align: tickAlign,
            baseline: "middle",
            text: "BE-",
            x: tickX,
            y: straddleDown.y,
          },
          ignoreEvent: true,
          styles: tickStyle,
          type: "text",
        }
      );
    }
  }

  return figures;
};
