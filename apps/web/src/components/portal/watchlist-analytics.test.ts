import { describe, expect, it } from "vitest";

import {
  annularSectorPath,
  buildSunburst,
  capSymbols,
  correlationFill,
  correlationMatrix,
  dailyCloses,
  dailyReturns,
  extentWithZero,
  formatPercent,
  linearScale,
  MIN_CORRELATION_OVERLAP,
  maxDrawdown,
  normalizeSymbol,
  pearson,
  runWithConcurrency,
  totalReturn,
  WATCHLIST_ANALYSIS_SYMBOL_CAP,
} from "./watchlist-analytics.ts";

const DAY = 86_400;
const closes = (...values: number[]) =>
  values.map((close, day) => ({ close, day }));

describe("symbols", () => {
  it("normalizes and caps symbols", () => {
    expect(normalizeSymbol(" bf-b ")).toBe("BF.B");
    expect(capSymbols(["A", "B", "A", "C"], 2)).toEqual(["A", "B"]);
    const many = Array.from({ length: 20 }, (_, i) => `S${i}`);
    expect(capSymbols(many)).toHaveLength(WATCHLIST_ANALYSIS_SYMBOL_CAP);
  });
});

describe("daily closes and returns", () => {
  it("keeps one positive close per UTC day, oldest first", () => {
    expect(
      dailyCloses([
        { c: 12, t: 2 * DAY + 3600 },
        { c: 10, t: DAY },
        { c: 11, t: DAY + 7200 },
        { c: 0, t: 3 * DAY },
        { c: -1, t: 4 * DAY },
        { c: Number.NaN, t: 5 * DAY },
        { c: 9, t: Number.POSITIVE_INFINITY },
      ])
    ).toEqual([
      { close: 11, day: 1 },
      { close: 12, day: 2 },
    ]);
  });

  it("computes close-to-close returns dated by the later close", () => {
    expect(dailyReturns([])).toEqual([]);
    const returns = dailyReturns(closes(100, 110, 99));
    expect(returns.map((r) => r.day)).toEqual([1, 2]);
    expect(returns[0]?.value).toBeCloseTo(0.1);
    expect(returns[1]?.value).toBeCloseTo(-0.1);
  });
});

describe("correlation", () => {
  it("returns Pearson r, or null for short or flat samples", () => {
    expect(pearson([1], [1])).toBeNull();
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull();
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
    expect(pearson([1, 2, 3, 4], [1, 3, 2, 4])).toBeCloseTo(0.8);
  });

  it("aligns series by day and needs the minimum overlap", () => {
    const a = {
      returns: [1, 2, 3, 4].map((value, day) => ({ day, value })),
      symbol: "A",
    };
    const b = {
      returns: [2, 4, 6, 99].map((value, day) => ({ day: day + 1, value })),
      symbol: "B",
    };
    const [rowA, rowB] = correlationMatrix([a, b], 3);
    expect(rowA?.symbol).toBe("A");
    expect(rowA?.cells.map((cell) => cell.column)).toEqual(["A", "B"]);
    // Shared days 1..3: A = 2,3,4 and B = 2,4,6.
    expect(rowA?.cells[1]).toMatchObject({ overlap: 3, row: "A" });
    expect(rowA?.cells[1]?.value).toBeCloseTo(1);
    expect(rowB?.cells[0]?.value).toBeCloseTo(1);
    expect(rowA?.cells[0]?.value).toBeCloseTo(1);
    const strict = correlationMatrix([a, b]);
    expect(strict[0]?.cells[1]).toEqual({
      column: "B",
      overlap: 3,
      row: "A",
      value: null,
    });
    expect(MIN_CORRELATION_OVERLAP).toBeGreaterThan(3);
  });

  it("fills heatmap cells by sign and strength", () => {
    expect(correlationFill(null)).toBe("transparent");
    expect(correlationFill(0.5)).toBe(
      "color-mix(in oklab, var(--color-info) 35%, transparent)"
    );
    expect(correlationFill(-1)).toBe(
      "color-mix(in oklab, var(--color-destructive) 70%, transparent)"
    );
  });
});

describe("return and drawdown", () => {
  it("measures total return and the deepest fall", () => {
    expect(totalReturn(closes(100))).toBeNull();
    expect(totalReturn(closes(100, 80, 125))).toBeCloseTo(0.25);
    expect(maxDrawdown(closes(100))).toBeNull();
    expect(maxDrawdown(closes(100, 110, 120))).toBe(0);
    expect(maxDrawdown(closes(100, 120, 90, 130, 117))).toBeCloseTo(-0.25);
  });

  it("formats percentages with a sign", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(0.1234)).toBe("+12.3%");
    expect(formatPercent(0.000_01)).toBe("0.0%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(-0.25, 0)).toBe("-25%");
  });
});

describe("sunburst", () => {
  it("groups gross market value by type then symbol and marks the watchlist", () => {
    const sunburst = buildSunburst(
      [
        { marketValue: 600, secType: "STK", symbol: "aaa" },
        { marketValue: -200, secType: "STK", symbol: "BBB" },
        { marketValue: 100, secType: "OPT", symbol: "AAA" },
        { marketValue: 100, secType: "OPT", symbol: "AAA" },
        { marketValue: -300, secType: "OPT", symbol: "CCC" },
        { marketValue: 200, secType: " ", symbol: " " },
        { marketValue: 200, secType: "FUT", symbol: "ZZZ" },
        { marketValue: null, secType: "STK", symbol: "NUL" },
        { marketValue: 0, secType: "STK", symbol: "ZERO" },
        { marketValue: Number.NaN, secType: "STK", symbol: "NAN" },
      ],
      new Set(["AAA", "ZZZ"])
    );
    expect(sunburst.total).toBe(1700);
    expect(sunburst.skipped).toBe(3);
    const summary = sunburst.arcs.map((arc) => [
      arc.ring,
      arc.key,
      arc.value,
      arc.onWatchlist,
      arc.short,
    ]);
    expect(summary).toEqual([
      ["symbol", "STK/AAA", 600, true, false],
      ["symbol", "STK/BBB", 200, false, true],
      ["secType", "STK", 800, true, false],
      ["symbol", "OPT/CCC", 300, false, true],
      ["symbol", "OPT/AAA", 200, true, false],
      ["secType", "OPT", 500, true, true],
      // Equal gross values sort by name.
      ["symbol", "FUT/ZZZ", 200, true, false],
      ["secType", "FUT", 200, true, false],
      ["symbol", "OTHER/—", 200, false, false],
      ["secType", "OTHER", 200, false, false],
    ]);
    const last = sunburst.arcs.at(-1);
    expect(last?.end).toBeCloseTo(Math.PI * 2);
    expect(sunburst.arcs[2]?.share).toBeCloseTo(800 / 1700);
    expect(sunburst.arcs[2]?.start).toBe(0);
  });

  it("is empty without positive or negative market values", () => {
    expect(
      buildSunburst(
        [{ marketValue: null, secType: "STK", symbol: "A" }],
        new Set()
      )
    ).toEqual({ arcs: [], skipped: 1, total: 0 });
  });

  it("draws annular sectors, splitting a whole turn in two", () => {
    expect(annularSectorPath(0, 0, 1, 2, 0, Math.PI / 2)).toBe(
      "M 0 -2 A 2 2 0 0 1 2 0 L 1 0 A 1 1 0 0 0 0 -1 Z"
    );
    expect(annularSectorPath(10, 10, 5, 10, 0, (3 * Math.PI) / 2)).toBe(
      "M 10 0 A 10 10 0 1 1 0 10 L 5 10 A 5 5 0 1 0 10 5 Z"
    );
    expect(annularSectorPath(0, 0, 1, 2, 0, Math.PI * 2)).toBe(
      "M 0 -2 A 2 2 0 0 1 0 2 L 0 1 A 1 1 0 0 0 0 -1 Z M 0 2 A 2 2 0 0 1 0 -2 L 0 -1 A 1 1 0 0 0 0 1 Z"
    );
  });
});

describe("scales", () => {
  it("includes zero in the extent and maps linearly", () => {
    expect(extentWithZero([0.2, 0.5])).toEqual([0, 0.5]);
    expect(extentWithZero([-0.3, -0.1])).toEqual([-0.3, 0]);
    const scale = linearScale(0, 10, 100, 200);
    expect(scale(5)).toBe(150);
    expect(linearScale(0, 0, 100, 200)(7)).toBe(150);
  });
});

describe("runWithConcurrency", () => {
  it("keeps at most `limit` tasks in flight and runs every item", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      // Yield a few microtasks so the other worker can start meanwhile.
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
      done.push(item);
      active -= 1;
    });
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("runs one at a time below a limit of one, and nothing for no items", async () => {
    const seen: string[] = [];
    await runWithConcurrency(["a", "b"], 0, async (item) => {
      seen.push(item);
    });
    expect(seen).toEqual(["a", "b"]);
    await runWithConcurrency([], 3, async () => {
      throw new Error("unreachable");
    });
  });
});
