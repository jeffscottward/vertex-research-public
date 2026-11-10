import { type BacktestResult, runOptionsBacktest } from "@darkfactory/academy";
import { describe, expect, it } from "vitest";

import {
  ACADEMY_EXIT_REASONS,
  academyEngineResult,
} from "./academy-engine-result.ts";
import { barsInPositionOf, summarize } from "./instant-backtest-engine.ts";

const DAY_MS = 86_400_000;
const SIZE = 260;

const columns = () => {
  const c = Float64Array.from(
    { length: SIZE },
    (_, index) => 100 + index * 0.05 + 8 * Math.sin(index / 9)
  );
  const t = Float64Array.from(
    { length: SIZE },
    (_, index) => Date.UTC(2024, 0, 1) + index * DAY_MS
  );
  return { c, h: c, l: c, o: c, t };
};

const trade = (
  overrides: Partial<BacktestResult["trades"][number]>
): BacktestResult["trades"][number] => ({
  costs: 2,
  entryNet: -400,
  entryT: "2024-01-03",
  exitT: "2024-01-05",
  exitValue: -100,
  legs: ["Short 1 100 put 2024-02-02"],
  pnl: 298,
  reason: "profit-target",
  role: "position",
  spotEntry: 100,
  spotExit: 101,
  units: 1,
  ...overrides,
});

describe("academyEngineResult", () => {
  it("maps a real Academy run to unit equity, trades and recomputed statistics", () => {
    const bars = columns();
    const capital = 100_000;
    const result = runOptionsBacktest({
      bars: { c: bars.c, t: bars.t },
      capital,
      rules: {},
      structure: "pmcc",
    });
    const mapped = academyEngineResult(result, bars, capital);
    if (mapped === null) throw new Error("expected an engine result");
    expect(mapped.equity).toHaveLength(SIZE);
    // The Academy engine starts at bar 20: the warm-up bars hold the capital.
    expect(Array.from(mapped.equity.slice(0, 20))).toEqual(
      new Array(20).fill(1)
    );
    expect(mapped.equity[20]).toBeCloseTo(
      (result.equity[0]?.equity as number) / capital,
      12
    );
    expect(mapped.equity.at(-1)).toBeCloseTo(
      result.stats.finalEquity / capital,
      12
    );
    expect(mapped.trades).toHaveLength(result.trades.length);
    expect(mapped.trades.length).toBeGreaterThan(3);
    for (const [index, source] of result.trades.entries()) {
      const got = mapped.trades[index];
      expect(got).toMatchObject({
        entryPrice: source.spotEntry,
        exitPrice: source.spotExit,
        exitReason: ACADEMY_EXIT_REASONS[source.reason],
        pnl: source.pnl / capital,
        units: source.units / capital,
      });
      expect(
        new Date(bars.t[got?.entryIndex as number] as number).toISOString()
      ).toContain(source.entryT);
      expect(
        new Date(bars.t[got?.exitIndex as number] as number).toISOString()
      ).toContain(source.exitT);
    }
    expect(mapped.stats).toEqual(
      summarize(
        bars,
        mapped.equity,
        mapped.trades,
        barsInPositionOf(mapped.trades)
      )
    );
    expect(mapped.stats.bars).toBe(SIZE);
    expect(mapped.stats.totalReturn).toBeCloseTo(result.stats.totalReturn, 12);
    // The mapped series starts at the capital (warm-up bars), the Academy one after the entry costs
    // of bar 20, so the mapped drawdown is at least as deep.
    expect(mapped.stats.maxDrawdown).toBeLessThanOrEqual(
      result.stats.maxDrawdown
    );
  });

  it("maps every exit reason and takes the return over the absolute entry cash", () => {
    const bars = columns();
    const equity = [
      { equity: 1000, t: "2024-09-15" },
      { equity: 1100, t: "2024-09-16" },
    ];
    const mapped = academyEngineResult(
      {
        equity,
        trades: [
          trade({}),
          trade({ entryNet: 500, pnl: -250, reason: "stop" }),
          trade({ reason: "exit-dte" }),
          trade({ reason: "expiry" }),
          trade({ reason: "core-roll" }),
          trade({ entryNet: 0, reason: "end" }),
        ],
      },
      bars,
      1000
    );
    expect(mapped?.trades.map((item) => item.exitReason)).toEqual([
      "target",
      "stop",
      "signal",
      "signal",
      "signal",
      "end",
    ]);
    expect(mapped?.trades.map((item) => item.netReturn)).toEqual([
      298 / 400,
      -0.5,
      298 / 400,
      298 / 400,
      298 / 400,
      0,
    ]);
    expect(mapped?.trades[0]).toMatchObject({ entryIndex: 2, exitIndex: 4 });
    expect(mapped?.equity.at(-1)).toBe(1.1);
    expect(mapped?.equity.at(-3)).toBe(1);
  });

  it("returns null for an equity at or below zero or not a number", () => {
    const bars = columns();
    for (const value of [0, -5, Number.NaN])
      expect(
        academyEngineResult(
          { equity: [{ equity: value, t: "2024-09-16" }], trades: [] },
          bars,
          1000
        )
      ).toBeNull();
  });
});
