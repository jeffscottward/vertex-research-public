import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHART_INDICATORS,
  formatBigNumber,
  indicatorSummary,
  OVERLAY_OPTIONS,
  STUDY_OPTIONS,
  studiesFor,
  toggleIndicator,
} from "./chart-indicators.ts";

describe("chart indicators", () => {
  it("offers the CHARAN overlay and study menus", () => {
    expect(OVERLAY_OPTIONS.map((option) => option.key)).toEqual([
      "MA",
      "EMA",
      "boll",
      "sar",
      "smma",
      "lwma",
    ]);
    expect(STUDY_OPTIONS.map((option) => option.key)).toEqual([
      "macd",
      "RSI",
      "KDJ",
      "OBV",
      "WR",
      "atr",
      "stoch",
      "adx",
      "rvol",
    ]);
  });

  it("converts selections into renderer studies", () => {
    expect(studiesFor(true, DEFAULT_CHART_INDICATORS)).toEqual({
      ema: [],
      extra: ["macd"],
      panes: [],
      sma: [20, 50],
      volume: true,
    });
    expect(studiesFor(false, ["EMA", "RSI", "boll", "WR"])).toEqual({
      ema: [20],
      extra: ["boll"],
      panes: ["RSI", "WR"],
      sma: [],
      volume: false,
    });
  });

  it("toggles in menu order and summarizes", () => {
    const next = toggleIndicator(["macd"], "MA");
    expect(next).toEqual(["MA", "macd"]);
    expect(toggleIndicator(next, "MA")).toEqual(["macd"]);
    expect(indicatorSummary(OVERLAY_OPTIONS, ["MA", "boll"])).toBe("MA, BB");
    expect(indicatorSummary(STUDY_OPTIONS, ["RSI", "macd"])).toBe("MACD, RSI");
    expect(indicatorSummary(OVERLAY_OPTIONS, ["RSI"])).toBe("None");
  });

  it("formats volumes as K, M and B", () => {
    expect(formatBigNumber(950)).toBe("950");
    expect(formatBigNumber("1500")).toBe("1.5K");
    expect(formatBigNumber(-2_500_000)).toBe("-2.5M");
    expect(formatBigNumber(3_200_000_000)).toBe("3.2B");
    expect(formatBigNumber("n/a")).toBe("n/a");
  });
});
