import { describe, expect, it, vi } from "vitest";

import { loadSectorQuadrants } from "./server/sector-quadrant-series.ts";
import {
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
} from "./strategy-dsl.ts";
import { SectorQuadrantDataError } from "./strategy-dsl-compile.ts";

const at = new Date("2026-11-02T00:00:00.000Z");
const firstBar = Date.parse("2026-03-02T00:00:00Z");

const filtered = StrategyDefinitionSchema.parse({
  ...STRATEGY_TEMPLATES.smaCross,
  filters: [
    { quadrants: ["leading"], sector: "XLK", type: "sectorQuadrant" },
    {
      quadrants: ["improving"],
      sector: "XLE",
      timeframe: "daily",
      type: "sectorQuadrant",
    },
  ],
});

const point = (symbol: string, date: string) => ({
  benchmark: "SPY",
  computedAt: at,
  date,
  momentum: 101,
  quadrant: "leading" as const,
  ratio: 101,
  symbol,
  timeframe: "weekly" as const,
});

describe("loadSectorQuadrants", () => {
  it("returns undefined for a definition without filters", async () => {
    const listPoints = vi.fn();
    const plain = StrategyDefinitionSchema.parse(STRATEGY_TEMPLATES.smaCross);
    expect(
      await loadSectorQuadrants({ listPoints }, plain, firstBar)
    ).toBeUndefined();
    expect(
      await loadSectorQuadrants(undefined, plain, firstBar)
    ).toBeUndefined();
    expect(listPoints).not.toHaveBeenCalled();
  });

  it("loads one series per filter from 31 days before the first bar", async () => {
    const listPoints = vi.fn(
      async ({ symbols }: { symbols?: readonly string[] }) => [
        point(symbols?.[0] ?? "", "2026-02-27"),
      ]
    );
    expect(
      await loadSectorQuadrants({ listPoints }, filtered, firstBar)
    ).toEqual({
      "XLE:daily": [{ date: "2026-02-27", quadrant: "leading" }],
      "XLK:weekly": [{ date: "2026-02-27", quadrant: "leading" }],
    });
    expect(listPoints).toHaveBeenNthCalledWith(1, {
      fromDate: "2026-01-30",
      symbols: ["XLK"],
      timeframe: "weekly",
    });
    expect(listPoints).toHaveBeenNthCalledWith(2, {
      fromDate: "2026-01-30",
      symbols: ["XLE"],
      timeframe: "daily",
    });
  });

  it("throws the typed error without a repository or without stored points", async () => {
    await expect(
      loadSectorQuadrants(undefined, filtered, firstBar)
    ).rejects.toThrow(new SectorQuadrantDataError("XLK", "weekly"));
    await expect(
      loadSectorQuadrants({ listPoints: async () => [] }, filtered, firstBar)
    ).rejects.toThrow("Sector quadrant data is not available for XLK (weekly)");
  });
});
