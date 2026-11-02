import { describe, expect, it } from "vitest";

import {
  alignRatios,
  ComboInputError,
  type ComboSlotInput,
  combinePortfolio,
  pearson,
  seriesStats,
  verdictFor,
} from "./portfolio-combination.ts";

const DAY = 86_400_000;

const slot = (
  label: string,
  weight: number,
  ratios: readonly number[],
  initialCapital = 1000,
  offset = 0
): ComboSlotInput => ({
  equity: ratios.map((ratio, index) => ({
    equity: ratio * initialCapital,
    t: (index + offset) * DAY,
  })),
  initialCapital,
  label,
  weight,
});

// Two series whose per-step returns are exactly uncorrelated: A moves on even steps, B on odd ones,
// with alternating signs chosen so the cross products cancel.
const pattern = (moves: readonly number[]): number[] => {
  const out = [1];
  for (const move of moves) out.push((out.at(-1) as number) * (1 + move));
  return out;
};

describe("portfolio combination", () => {
  it("identical series: correlation 1, same drawdown, no diversification", () => {
    const series = [1, 1.2, 0.9, 1.1, 0.8, 1.3];
    const result = combinePortfolio(10_000, [
      slot("a", 0.5, series),
      slot("b", 0.5, series, 2000),
    ]);
    expect(result.correlation[0]?.[1]).toBeCloseTo(1, 12);
    // Combined = 10,000 x series: drawdown from 1.2 to 0.8 = 1/3.
    expect(result.stats.maxDrawdownPct).toBeCloseTo(1 / 3, 12);
    expect(result.diversification.weightedSlotDrawdownPct).toBeCloseTo(
      1 / 3,
      12
    );
    expect(result.diversification.diversified).toBe(false);
    expect(result.diversification.ratio).toBeCloseTo(1, 12);
    expect(result.drawdownOverlap[0]?.[1]).toBeCloseTo(3 / 6, 12);
    expect(result.jointDrawdownShare).toBeCloseTo(3 / 6, 12);
    expect(result.finalEquity).toBeCloseTo(13_000, 9);
  });

  it("uncorrelated series: correlation 0 and a smaller combined drawdown", () => {
    const a = pattern([0.1, 0, -0.1, 0, 0.1, 0, -0.1, 0]);
    const b = pattern([0, 0.1, 0, -0.1, 0, -0.1, 0, 0.1]);
    expect(pearson([1, -1, 1, -1], [1, 1, -1, -1])).toBe(0);
    const result = combinePortfolio(1000, [
      slot("a", 0.5, a),
      slot("b", 0.5, b),
    ]);
    expect(Math.abs(result.correlation[0]?.[1] as number)).toBeLessThan(0.2);
    // Known combined values: steps of 500 x ratio for each slot.
    const expected = a.map(
      (value, index) => 500 * value + 500 * (b[index] as number)
    );
    for (const [index, point] of result.points.entries())
      expect(point.equity).toBeCloseTo(expected[index] as number, 9);
    let peak = 0;
    let worst = 0;
    for (const value of expected) {
      peak = Math.max(peak, value);
      worst = Math.max(worst, (peak - value) / peak);
    }
    expect(result.stats.maxDrawdownPct).toBeCloseTo(worst, 12);
    expect(result.stats.maxDrawdownPct).toBeLessThanOrEqual(
      result.diversification.weightedSlotDrawdownPct + 1e-12
    );
    expect(result.diversification.diversified).toBe(true);
    expect(result.diversification.ratio as number).toBeGreaterThan(1);
  });

  it("combined equity reconciles with the deposit plus the sum of slot P&L", () => {
    const result = combinePortfolio(50_000, [
      slot("a", 0.3, [1, 1.1, 1.05, 1.2]),
      slot("b", 0.2, [1, 0.9, 0.95], 500, 2),
      slot("c", 0.1, [1, 1.5]),
    ]);
    expect(result.cash).toBeCloseTo(20_000, 9);
    const pnl = result.slots.reduce((sum, item) => sum + item.pnl, 0);
    expect(result.finalEquity).toBeCloseTo(50_000 + pnl, 9);
    expect(result.netProfit).toBeCloseTo(pnl, 9);
    expect(result.slots.map((item) => item.allocation)).toEqual([
      15_000, 10_000, 5000,
    ]);
  });

  it("aligns slots on the union of times, flat before the first point", () => {
    const { times, ratios } = alignRatios([
      slot("a", 0.5, [1, 2]),
      slot("b", 0.5, [1, 3], 1000, 1),
    ]);
    expect(times).toEqual([0, DAY, 2 * DAY]);
    expect(ratios).toEqual([
      [1, 2, 2],
      [1, 1, 3],
    ]);
  });

  it("rejects empty, overweight and too-short input", () => {
    expect(() => combinePortfolio(1, [])).toThrow(ComboInputError);
    expect(() =>
      combinePortfolio(1, [slot("a", 0.7, [1, 2]), slot("b", 0.7, [1, 2])])
    ).toThrow("more than 1");
    expect(() => combinePortfolio(1, [slot("a", 0.5, [1])])).toThrow(
      "fewer than 2"
    );
  });

  it("handles flat series and zero weights", () => {
    const result = combinePortfolio(100, [slot("a", 0, [1, 1, 1])]);
    expect(result.correlation[0]?.[0]).toBeNull();
    expect(result.diversification.ratio).toBeNull();
    expect(result.stats.sharpe).toBeNull();
    expect(result.slots[0]?.verdict).toBe("insufficient");
    expect(pearson([1], [1])).toBeNull();
  });

  it("series stats cover single points and non-positive values", () => {
    expect(seriesStats([0], [1])).toEqual({
      cagr: null,
      maxDrawdownPct: 0,
      sharpe: null,
      totalReturn: 0,
    });
    expect(seriesStats([0, DAY], [0, 1]).totalReturn).toBe(0);
    expect(seriesStats([0, 365.25 * DAY], [1, 2]).cagr).toBeCloseTo(1, 12);
    expect(seriesStats([0, DAY], [1, 0]).cagr).toBeNull();
    expect(seriesStats([0, DAY, 2 * DAY], [0, 0, 1]).maxDrawdownPct).toBe(0);
  });

  it("verdict thresholds", () => {
    const full = {
      cagr: 0.1,
      maxDrawdownPct: 0.1,
      sharpe: 1,
      totalReturn: 0.2,
    };
    expect(verdictFor(full, full, 5).verdict).toBe("insufficient");
    expect(verdictFor(full, { ...full, sharpe: 0.6 }, 20).verdict).toBe(
      "robust"
    );
    expect(verdictFor(full, { ...full, sharpe: 0.4 }, 20).reason).toContain(
      "Sharpe"
    );
    expect(verdictFor(full, { ...full, sharpe: null }, 20).verdict).toBe(
      "degrading"
    );
    expect(
      verdictFor(full, { ...full, maxDrawdownPct: 0.16 }, 20).reason
    ).toContain("drawdown");
    const weak = { ...full, sharpe: -0.2 };
    expect(verdictFor(weak, { ...weak, totalReturn: -0.01 }, 20).verdict).toBe(
      "degrading"
    );
    expect(verdictFor(weak, { ...weak, totalReturn: 0.01 }, 20).verdict).toBe(
      "robust"
    );
  });

  it("flags a slot whose recent window degrades", () => {
    const rising = Array.from(
      { length: 40 },
      (_, index) => 1 + index * 0.01 + (index % 2) * 0.002
    );
    const falling = [
      ...rising.slice(0, 30),
      ...Array.from({ length: 10 }, (_, index) => 1.29 - index * 0.03),
    ];
    const result = combinePortfolio(1000, [
      slot("steady", 0.5, rising),
      slot("fading", 0.5, falling),
    ]);
    expect(result.slots[0]?.verdict).toBe("robust");
    expect(result.slots[1]?.verdict).toBe("degrading");
  });

  it("leftover cash does not make identical runs look diversified", () => {
    const series = [1, 1.2, 0.9, 1.1, 0.8, 1.3];
    const result = combinePortfolio(10_000, [
      slot("a", 0.25, series),
      slot("b", 0.25, series),
    ]);
    expect(result.diversification.ratio).toBeCloseTo(1, 12);
    expect(result.diversification.combinedDrawdownPct).toBeCloseTo(1 / 3, 12);
    expect(result.diversification.diversified).toBe(false);
    // The total portfolio, cash included, falls less.
    expect(result.stats.maxDrawdownPct).toBeLessThan(1 / 3);
  });

  it("slot statistics use the run's own dates, not the shared axis", () => {
    const own = Array.from(
      { length: 40 },
      (_, index) => 1 + index * 0.01 + (index % 2) * 0.002
    );
    const alone = combinePortfolio(1000, [slot("e", 1, own)]).slots[0];
    const combined = combinePortfolio(1000, [
      slot("e", 0.5, own),
      slot("late", 0.5, own, 1000, 100),
    ]).slots[0];
    expect(combined?.full).toEqual(alone?.full);
    expect(combined?.recent).toEqual(alone?.recent);
    expect(combined?.verdict).toBe("robust");
  });

  it("pairwise measures use only the dates both runs cover", () => {
    const a = [1, 1.1, 1, 1.2, 1.1, 1.3];
    const late = combinePortfolio(1000, [
      slot("a", 0.5, a),
      slot("b", 0.5, a, 1000, 3),
    ]);
    // Shared dates are t = 3..5; b's own series there is a[0..2], not aligned with a[3..5].
    expect(late.correlation[0]?.[1]).toBeCloseTo(
      pearson([1.1 / 1.2 - 1, 1.3 / 1.1 - 1], [0.1, 1 / 1.1 - 1]) as number,
      12
    );
    const apart = combinePortfolio(1000, [
      slot("a", 0.5, [1, 0.9]),
      slot("b", 0.5, [1, 0.9], 1000, 5),
    ]);
    expect(apart.correlation[0]?.[1]).toBeNull();
    expect(apart.drawdownOverlap[0]?.[1]).toBe(0);
  });
});
