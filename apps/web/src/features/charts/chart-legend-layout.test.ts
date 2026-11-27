import { describe, expect, it } from "vitest";
import {
  COMPACT_CANDLE_TOOLTIP,
  COMPACT_CHART_WIDTH_PX,
  candlePaneGap,
  chartFontFamily,
  chartLegendStyles,
  DEFAULT_CHART_FONT_FAMILY,
  isCompactChartWidth,
  legendClearancePx,
  subPaneGap,
  WIDE_CANDLE_TOOLTIP,
} from "./chart-legend-layout.ts";

describe("chart-legend-layout", () => {
  it("detects narrow chart containers while treating unmeasured widths as wide", () => {
    expect(isCompactChartWidth(309)).toBe(true);
    expect(isCompactChartWidth(COMPACT_CHART_WIDTH_PX - 1)).toBe(true);
    expect(isCompactChartWidth(COMPACT_CHART_WIDTH_PX)).toBe(false);
    expect(isCompactChartWidth(800)).toBe(false);
    expect(isCompactChartWidth(0)).toBe(false);
    expect(isCompactChartWidth(-10)).toBe(false);
    expect(isCompactChartWidth(Number.NaN)).toBe(false);
  });

  it("resolves a sans-serif font family with a Public Sans fallback", () => {
    expect(chartFontFamily({})).toBe(DEFAULT_CHART_FONT_FAMILY);
    expect(chartFontFamily({ fontFamily: "   " })).toBe(
      DEFAULT_CHART_FONT_FAMILY
    );
    expect(chartFontFamily({ fontFamily: ' "Public Sans", sans-serif ' })).toBe(
      '"Public Sans", sans-serif'
    );
  });

  it("computes legend clearance and bounded pane gaps for candle and sub-panes", () => {
    expect(legendClearancePx(true)).toBe(54);
    expect(legendClearancePx(true, 0)).toBe(40);
    expect(legendClearancePx(false, 1)).toBe(48);
    expect(legendClearancePx(false, -3)).toBe(30);

    const compactOne = candlePaneGap(true, 1);
    expect(compactOne.top).toBeGreaterThan(0.3);
    expect(compactOne.top).toBeLessThan(0.4);
    expect(compactOne.bottom).toBe(0.08);

    const wideZero = candlePaneGap(false, 0);
    expect(wideZero.top).toBe(0.2);

    const clampedMany = candlePaneGap(true, 20);
    expect(clampedMany.top).toBe(0.55);

    expect(subPaneGap(true)).toEqual({ bottom: 0.08, top: 0.5 });
    expect(subPaneGap(false)).toEqual({ bottom: 0.08, top: 0.36 });
  });

  it("builds compact narrow-pane tooltip styles and wide default styles", () => {
    const palette = {
      falling: "#9ca3af",
      fontFamily: '"Public Sans", sans-serif',
    };
    const compact = chartLegendStyles(palette, true, "No volume");
    expect(compact.fontFamily).toBe('"Public Sans", sans-serif');
    expect(compact.candleTooltip.custom).toBe(COMPACT_CANDLE_TOOLTIP);
    expect(compact.candleTooltip.defaultValue).toBe("No volume");
    expect(compact.candleTooltip.text.size).toBe(10);
    expect(compact.candleTooltip.text.family).toBe('"Public Sans", sans-serif');
    expect(compact.indicatorTooltip.showParams).toBe(false);
    expect(compact.indicatorTooltip.text.size).toBe(10);

    const wide = chartLegendStyles(palette, false, "No volume");
    expect(wide.candleTooltip.custom).toBe(WIDE_CANDLE_TOOLTIP);
    expect(wide.candleTooltip.text.size).toBe(12);
    expect(wide.indicatorTooltip.showParams).toBe(true);
    expect(wide.indicatorTooltip.text.size).toBe(12);
  });
});
