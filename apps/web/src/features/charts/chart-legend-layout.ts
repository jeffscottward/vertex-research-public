import type { ChartPalette } from "./types.ts";

// Responsive KLineCharts legend typography, compact narrow-pane labels and top-gap clearance.
// Keeps price, MA and MACD legends compact and separated from plotted data at 375 px without
// crowding wide viewports.

export const COMPACT_CHART_WIDTH_PX = 480;
export const DEFAULT_CHART_FONT_FAMILY =
  '"Public Sans", system-ui, -apple-system, sans-serif';

const COMPACT_ROW_PX = 14;
const WIDE_ROW_PX = 18;
const LEGEND_OFFSET_TOP_PX = 4;
const LEGEND_BREATHING_PX = 8;
const COMPACT_CANDLE_PANE_HEIGHT_PX = 229;
const WIDE_CANDLE_PANE_HEIGHT_PX = 300;
const PANE_GAP_BOTTOM = 0.08;
const MIN_CANDLE_TOP_GAP = 0.2;
const MAX_CANDLE_TOP_GAP = 0.55;

export type TooltipLegendEntry = Readonly<{
  title: string;
  value: string;
}>;

export type ChartLegendStyles = Readonly<{
  candleTooltip: Readonly<{
    custom: readonly TooltipLegendEntry[];
    defaultValue: string;
    offsetBottom: number;
    offsetLeft: number;
    offsetRight: number;
    offsetTop: number;
    text: Readonly<{
      color: string;
      family: string;
      marginBottom: number;
      marginLeft: number;
      marginRight: number;
      marginTop: number;
      size: number;
    }>;
  }>;
  fontFamily: string;
  indicatorTooltip: Readonly<{
    offsetBottom: number;
    offsetLeft: number;
    offsetRight: number;
    offsetTop: number;
    showName: boolean;
    showParams: boolean;
    text: Readonly<{
      color: string;
      family: string;
      marginBottom: number;
      marginLeft: number;
      marginRight: number;
      marginTop: number;
      size: number;
    }>;
  }>;
}>;

export type PaneGapSpec = Readonly<{
  bottom: number;
  top: number;
}>;

export const WIDE_CANDLE_TOOLTIP: readonly TooltipLegendEntry[] = Object.freeze(
  [
    { title: "time", value: "{time}" },
    { title: "open", value: "{open}" },
    { title: "high", value: "{high}" },
    { title: "low", value: "{low}" },
    { title: "close", value: "{close}" },
    { title: "volume", value: "{volume}" },
  ]
);

export const COMPACT_CANDLE_TOOLTIP: readonly TooltipLegendEntry[] =
  Object.freeze([
    { title: "O ", value: "{open}" },
    { title: "H ", value: "{high}" },
    { title: "L ", value: "{low}" },
    { title: "C ", value: "{close}" },
    { title: "V ", value: "{volume}" },
  ]);

/** True when the chart container is narrow (e.g. 375 px mobile viewport). Unmeasured 0 stays wide. */
export const isCompactChartWidth = (width: number): boolean =>
  Number.isFinite(width) && width > 0 && width < COMPACT_CHART_WIDTH_PX;

/** Resolved sans-serif font for canvas text so KLineCharts never falls back to serif on Linux. */
export const chartFontFamily = (
  palette: Pick<ChartPalette, "fontFamily">
): string => {
  const configured = palette.fontFamily?.trim();
  return configured ? configured : DEFAULT_CHART_FONT_FAMILY;
};

/** Pixel clearance from the top of the candle pane occupied by the candle and overlay legends. */
export const legendClearancePx = (
  compact: boolean,
  overlayCount = 1
): number => {
  const overlays = Math.max(0, Math.floor(overlayCount));
  const candleRows = compact ? 2 : 1;
  const rowPx = compact ? COMPACT_ROW_PX : WIDE_ROW_PX;
  return (
    LEGEND_OFFSET_TOP_PX + (candleRows + overlays) * rowPx + LEGEND_BREATHING_PX
  );
};

/**
 * Top and bottom Y-axis gap ratios for the main candle pane so plotted candles and MA lines stay
 * below the legend rows. Uses KLineCharts' range equation: y_max = (top / (1 + top + bottom)) * H.
 */
export const candlePaneGap = (
  compact: boolean,
  overlayCount: number
): PaneGapSpec => {
  const clearance = legendClearancePx(compact, overlayCount);
  const paneHeight = compact
    ? COMPACT_CANDLE_PANE_HEIGHT_PX
    : WIDE_CANDLE_PANE_HEIGHT_PX;
  const rawTop =
    (clearance / Math.max(1, paneHeight - clearance)) * (1 + PANE_GAP_BOTTOM);
  const top = Math.min(
    MAX_CANDLE_TOP_GAP,
    Math.max(MIN_CANDLE_TOP_GAP, Math.round(rawTop * 1000) / 1000)
  );
  return { bottom: PANE_GAP_BOTTOM, top };
};

/** Top and bottom Y-axis gap ratios for 96 px indicator panes (Volume, MACD, OI, scripts). */
export const subPaneGap = (compact: boolean): PaneGapSpec => ({
  bottom: PANE_GAP_BOTTOM,
  top: compact ? 0.5 : 0.36,
});
/** Tooltip and typography style fragment for KLineCharts init and narrow/wide resize switches. */
export const chartLegendStyles = (
  palette: Pick<ChartPalette, "falling" | "fontFamily">,
  compact: boolean,
  defaultValue: string
): ChartLegendStyles => {
  const fontFamily = chartFontFamily(palette);
  if (compact) {
    return {
      candleTooltip: {
        custom: COMPACT_CANDLE_TOOLTIP,
        defaultValue,
        offsetBottom: 2,
        offsetLeft: 4,
        offsetRight: 4,
        offsetTop: LEGEND_OFFSET_TOP_PX,
        text: {
          color: palette.falling,
          family: fontFamily,
          marginBottom: 2,
          marginLeft: 4,
          marginRight: 4,
          marginTop: 2,
          size: 10,
        },
      },
      fontFamily,
      indicatorTooltip: {
        offsetBottom: 2,
        offsetLeft: 4,
        offsetRight: 4,
        offsetTop: LEGEND_OFFSET_TOP_PX,
        showName: true,
        showParams: false,
        text: {
          color: palette.falling,
          family: fontFamily,
          marginBottom: 2,
          marginLeft: 3,
          marginRight: 4,
          marginTop: 2,
          size: 10,
        },
      },
    };
  }
  return {
    candleTooltip: {
      custom: WIDE_CANDLE_TOOLTIP,
      defaultValue,
      offsetBottom: 4,
      offsetLeft: 4,
      offsetRight: 4,
      offsetTop: LEGEND_OFFSET_TOP_PX,
      text: {
        color: palette.falling,
        family: fontFamily,
        marginBottom: 3,
        marginLeft: 8,
        marginRight: 8,
        marginTop: 3,
        size: 12,
      },
    },
    fontFamily,
    indicatorTooltip: {
      offsetBottom: 4,
      offsetLeft: 4,
      offsetRight: 4,
      offsetTop: LEGEND_OFFSET_TOP_PX,
      showName: true,
      showParams: true,
      text: {
        color: palette.falling,
        family: fontFamily,
        marginBottom: 3,
        marginLeft: 8,
        marginRight: 8,
        marginTop: 3,
        size: 12,
      },
    },
  };
};
