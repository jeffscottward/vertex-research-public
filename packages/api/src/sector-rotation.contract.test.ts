import { describe, expect, it } from "vitest";

import { appContract } from "./contract.ts";
import {
  SECTOR_ROTATION_MAX_CUSTOM_SYMBOLS,
  SECTOR_ROTATION_SECTORS,
  SectorRotationCollectInputSchema,
  SectorRotationCollectOutputSchema,
  SectorRotationMapInputSchema,
  SectorRotationMapOutputSchema,
  SectorRotationSnapshotInputSchema,
} from "./contracts/sector-rotation.ts";

describe("sectorRotation contract", () => {
  it("is registered with three procedures", () => {
    expect(Object.keys(appContract.sectorRotation).sort()).toEqual([
      "collect",
      "map",
      "snapshot",
    ]);
  });

  it("lists the 11 Select Sector SPDR ETFs once each", () => {
    const symbols = SECTOR_ROTATION_SECTORS.map((sector) => sector.symbol);
    expect(symbols).toHaveLength(11);
    expect(new Set(symbols).size).toBe(11);
  });

  it("defaults the map to weekly sectors against SPY", () => {
    expect(SectorRotationMapInputSchema.parse({})).toEqual({
      benchmark: "SPY",
      timeframe: "weekly",
      universe: { kind: "sectors" },
    });
  });

  it("normalizes and de-duplicates a custom list", () => {
    expect(
      SectorRotationMapInputSchema.parse({
        benchmark: " qqq ",
        timeframe: "daily",
        universe: { kind: "custom", symbols: ["nvda", " NVDA", "brk.b"] },
      })
    ).toEqual({
      benchmark: "QQQ",
      timeframe: "daily",
      universe: { kind: "custom", symbols: ["NVDA", "BRK.B"] },
    });
  });

  it("rejects bad custom lists and unknown keys", () => {
    const tooMany = Array.from(
      { length: SECTOR_ROTATION_MAX_CUSTOM_SYMBOLS + 1 },
      (_, index) => `A${index}`
    );
    for (const input of [
      { universe: { kind: "custom", symbols: [] } },
      { universe: { kind: "custom", symbols: tooMany } },
      { universe: { kind: "custom", symbols: ["$BAD"] } },
      { universe: { kind: "sectors", symbols: ["XLK"] } },
      { timeframe: "monthly" },
      { extra: true },
    ])
      expect(SectorRotationMapInputSchema.safeParse(input).success).toBe(false);
  });

  it("defaults collect to a real run and the snapshot to daily", () => {
    expect(SectorRotationCollectInputSchema.parse({})).toEqual({
      dryRun: false,
    });
    expect(SectorRotationSnapshotInputSchema.parse({})).toEqual({
      timeframe: "daily",
    });
  });

  it("accepts a map output and rejects non-finite values", () => {
    const output = {
      asOf: "2026-10-30",
      benchmark: "SPY",
      errors: [{ reason: "no bars", symbol: "ZZZZ" }],
      generatedAt: "2026-10-30T21:00:00.000Z",
      params: {
        momentumLag: 4,
        momentumSmoothing: 3,
        rsSmoothing: 4,
        trendWindow: 26,
      },
      series: [
        {
          latest: {
            date: "2026-10-30",
            momentum: 100.4,
            periods: 3,
            quadrant: "leading",
            ratio: 101.2,
            since: "2026-10-16",
          },
          name: "Technology",
          points: [
            {
              date: "2026-10-30",
              momentum: 100.4,
              quadrant: "leading",
              ratio: 101.2,
            },
          ],
          symbol: "XLK",
        },
      ],
      source: "stored",
      timeframe: "weekly",
      universe: "sectors",
    };
    expect(SectorRotationMapOutputSchema.parse(output)).toEqual(output);
    const broken = {
      ...output,
      series: output.series.map((series) => ({
        ...series,
        points: [{ ...series.points[0], ratio: Number.POSITIVE_INFINITY }],
      })),
    };
    expect(SectorRotationMapOutputSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a collect output with dry-run alerts", () => {
    const output = {
      alerts: [
        {
          date: "2026-10-30",
          delivery: "dry-run",
          from: "improving",
          line: "Sector rotation: XLK (Technology) entered Leading on 2026-10-30. Research only.",
          name: "Technology",
          symbol: "XLK",
          to: "leading",
        },
      ],
      asOf: "2026-10-30",
      dryRun: true,
      fetchErrors: [],
      stored: { daily: 0, weekly: 0 },
      transitions: [],
    };
    expect(SectorRotationCollectOutputSchema.parse(output)).toEqual(output);
  });
});
