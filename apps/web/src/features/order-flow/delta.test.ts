import { describe, expect, it } from "vitest";

import { buildDeltaSeries } from "./delta.ts";
import type { SignedTrade, TradeSide } from "@darkfactory/api";

const signed = (t: number, size: number, side: TradeSide): SignedTrade => ({
  ask: null,
  bid: null,
  conditions: null,
  method: side === "unknown" ? "none" : "tick",
  price: 10,
  side,
  size,
  t,
  venue: null,
});

describe("buildDeltaSeries", () => {
  it("computes delta per bucket and the cumulative volume delta", () => {
    const series = buildDeltaSeries(
      [
        signed(1000, 100, "buy"),
        signed(1003, 40, "sell"),
        signed(1011, 90, "sell"),
        signed(1012, 5, "unknown"),
        signed(1035, 10, "buy"),
      ],
      10
    );
    expect(series).not.toBeNull();
    if (series === null) return;
    expect(
      series.buckets.map(({ start, delta, cvd, volume }) => ({
        cvd,
        delta,
        start,
        volume,
      }))
    ).toEqual([
      { cvd: 60, delta: 60, start: 1000, volume: 140 },
      { cvd: -30, delta: -90, start: 1010, volume: 95 },
      // Empty bucket: CVD stays flat.
      { cvd: -30, delta: 0, start: 1020, volume: 0 },
      { cvd: -20, delta: 10, start: 1030, volume: 10 },
    ]);
    expect(series.cvd).toBe(-20);
    expect(series.maxAbsDelta).toBe(90);
    expect(series.points.map((point) => point.cvd)).toEqual([
      100, 60, -30, -30, -20,
    ]);
    expect(series.minCvd).toBe(-30);
    expect(series.maxCvd).toBe(100);
  });

  it("uses the automatic bucket size by default and sorts prints by time", () => {
    const series = buildDeltaSeries([
      signed(1090, 1, "sell"),
      signed(1000, 3, "buy"),
    ]);
    expect(series?.bucketSeconds).toBe(5);
    expect(series?.buckets).toHaveLength(19);
    expect(series?.points).toEqual([
      { cvd: 3, t: 1000 },
      { cvd: 2, t: 1090 },
    ]);
  });

  it("returns null without prints", () => {
    expect(buildDeltaSeries([])).toBeNull();
  });
});
