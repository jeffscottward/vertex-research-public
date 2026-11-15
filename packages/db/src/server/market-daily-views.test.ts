import { describe, expect, it } from "vitest";

import type { MarketDailyColumns } from "./market-daily-series.ts";
import {
  createMarketDailyViews,
  marketDailyBars,
  marketDailyCloses,
  marketDailyTotalReturn,
  TOTAL_RETURN_SUFFIX,
} from "./market-daily-views.ts";

const spy: MarketDailyColumns = {
  adjClose: [90, 91, null, 93, 94, 95, 96],
  close: [100, 101, 102, 0, -1, 105, 106],
  dates: [
    "2024-01-02",
    "2024-01-03",
    "2024-01-04",
    "2024-01-05",
    "2024-01-08",
    "2024-01-09",
    "2024-01-10",
  ],
  high: [101, 102, 103, 1, 1, 106, null],
  low: [99, 100, 101, 1, 1, 104, 105],
  open: [100.5, null, 102, 1, 1, 105, 106],
};

const vix: MarketDailyColumns = {
  adjClose: [null, null],
  close: [13.5, 14.25],
  dates: ["2024-01-02", "2024-01-03"],
  high: [null, null],
  low: [null, null],
  open: [null, null],
};

describe("marketDailyBars", () => {
  it("keeps rows with close > 0 and every bar column present (data.load_bars)", () => {
    expect(marketDailyBars(spy)).toEqual({
      adjClose: [90, 95],
      close: [100, 105],
      dates: ["2024-01-02", "2024-01-09"],
      high: [101, 106],
      low: [99, 104],
      open: [100.5, 105],
    });
  });

  it("has no bars for a close-only index", () => {
    expect(marketDailyBars(vix).dates).toEqual([]);
  });
});

describe("marketDailyCloses", () => {
  it("maps every stored row's date to its close (data.load_series)", () => {
    expect([...marketDailyCloses(spy).values()]).toEqual([
      100, 101, 102, 0, -1, 105, 106,
    ]);
    expect(marketDailyCloses(vix)).toEqual(
      new Map([
        ["2024-01-02", 13.5],
        ["2024-01-03", 14.25],
      ])
    );
  });
});

describe("marketDailyTotalReturn", () => {
  it("maps the bar dates to the adjusted close", () => {
    expect(marketDailyTotalReturn(spy)).toEqual(
      new Map([
        ["2024-01-02", 90],
        ["2024-01-09", 95],
      ])
    );
  });
});

describe("createMarketDailyViews", () => {
  const views = createMarketDailyViews(
    new Map([
      ["SPY", spy],
      ["VIX", vix],
    ])
  );

  it("reads bars and closes of loaded series and undefined otherwise", () => {
    expect(views.barsOf("SPY")?.dates).toEqual(["2024-01-02", "2024-01-09"]);
    expect(views.closes("VIX")?.get("2024-01-03")).toBe(14.25);
    expect(views.barsOf("QQQ")).toBeUndefined();
    expect(views.closes("QQQ")).toBeUndefined();
  });

  it("resolves plain ids to closes and <ETF>:TR to the adjusted close of the bars", () => {
    expect(TOTAL_RETURN_SUFFIX).toBe(":TR");
    expect(views.series("SPY")?.size).toBe(7);
    expect(views.series("SPY:TR")).toEqual(
      new Map([
        ["2024-01-02", 90],
        ["2024-01-09", 95],
      ])
    );
    expect(views.series("QQQ:TR")).toBeUndefined();
    expect(views.series("QQQ")).toBeUndefined();
  });
});
