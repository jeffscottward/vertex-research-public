import { describe, expect, it } from "vitest";
import {
  GREEK_HEATMAP_METRICS,
  GREEK_HEATMAP_STATUSES,
  GreekHeatmapInputSchema,
  type GreekHeatmapMetricData,
  type GreekHeatmapOutput,
  GreekHeatmapOutputSchema,
  optionsAnalyticsContract,
} from "./contracts/options-analytics.ts";

const okMetric: GreekHeatmapMetricData = {
  expiryTotals: [1_200_000, -400_000],
  grandTotal: 800_000,
  marks: {
    callWall: 105,
    flip: 101.25,
    kingStrike: 105,
    putWall: 95,
  },
  message: null,
  rows: [
    { strike: 105, total: 1_500_000, values: [1_500_000, null] },
    { strike: 95, total: -700_000, values: [-300_000, -400_000] },
  ],
  status: "ok",
};

const sampleOutput: GreekHeatmapOutput = {
  expiries: [
    { dte: 1, expiry: "2026-10-23" },
    { dte: 29, expiry: "2026-11-20" },
  ],
  message: null,
  metrics: {
    charm: { ...okMetric, marks: { ...okMetric.marks, flip: null } },
    dex: { ...okMetric, marks: { ...okMetric.marks, flip: null } },
    gex: okMetric,
    vex: { ...okMetric, marks: { ...okMetric.marks, flip: null } },
    volumeGex: okMetric,
  },
  notes: [
    "Research view only. Estimates use QuantData IV and per-expiry OI/volume.",
  ],
  rateLimited: false,
  receivedAt: "2026-10-22T15:00:00.000Z",
  retryAfterSeconds: null,
  source: "quantdata",
  spot: 100.5,
  status: "ok",
  symbol: "SPY",
};

describe("optionsAnalytics.greekHeatmap contract", () => {
  it("exposes GET /options-analytics/greek-heatmap with operationId", () => {
    const meta = optionsAnalyticsContract.greekHeatmap["~orpc"];
    expect(meta.route?.method).toBe("GET");
    expect(meta.route?.path).toBe("/options-analytics/greek-heatmap");
    expect(meta.route?.operationId).toBe("optionsAnalytics.greekHeatmap");
  });

  it("lists all five tabs and three statuses", () => {
    expect(GREEK_HEATMAP_METRICS).toEqual([
      "gex",
      "vex",
      "charm",
      "dex",
      "volumeGex",
    ]);
    expect(GREEK_HEATMAP_STATUSES).toEqual(["ok", "empty", "failed"]);
  });

  it("normalizes valid symbols and rejects malformed or extra input fields", () => {
    expect(GreekHeatmapInputSchema.parse({ symbol: " spy " })).toEqual({
      symbol: "SPY",
    });
    expect(GreekHeatmapInputSchema.parse({ symbol: "brk.b" })).toEqual({
      symbol: "BRK.B",
    });
    for (const invalid of [
      {},
      { symbol: "" },
      { symbol: "123" },
      { extra: true, symbol: "SPY" },
    ]) {
      expect(GreekHeatmapInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts a complete heatmap output and rejects invalid shapes", () => {
    expect(GreekHeatmapOutputSchema.parse(sampleOutput)).toEqual(sampleOutput);
    expect(
      GreekHeatmapOutputSchema.safeParse({
        ...sampleOutput,
        expiries: [{ dte: -1, expiry: "2026-10-23" }],
      }).success
    ).toBe(false);
    expect(
      GreekHeatmapOutputSchema.safeParse({
        ...sampleOutput,
        expiries: [{ dte: 1, expiry: "not-a-date" }],
      }).success
    ).toBe(false);
    expect(
      GreekHeatmapOutputSchema.safeParse({
        ...sampleOutput,
        metrics: { ...sampleOutput.metrics, extra: okMetric },
      }).success
    ).toBe(false);
    expect(
      GreekHeatmapOutputSchema.safeParse({
        ...sampleOutput,
        spot: Number.POSITIVE_INFINITY,
      }).success
    ).toBe(false);
  });
});
