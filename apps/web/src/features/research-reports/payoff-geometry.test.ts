import { describe, expect, it } from "vitest";
import {
  type AvailablePayoff,
  type PayoffStrategy,
  prepareExpiryPayoff,
} from "./payoff.ts";
import { type ChartLine, payoffGeometry } from "./payoff-geometry.ts";

// Synthetic fixtures only.
const payoffOf = (strategy: PayoffStrategy, units = 1): AvailablePayoff => {
  const payoff = prepareExpiryPayoff(strategy, units);
  if (!payoff.available) throw new Error(payoff.reason);
  return payoff;
};
const call = (strike: number, premium: number): PayoffStrategy => ({
  assumedMultiplier: 100,
  kind: "long-call",
  legs: [{ multiplier: undefined, premium, side: "buy", strike, type: "call" }],
  multiplier: undefined,
});
const line = (number: number, payoff: AvailablePayoff): ChartLine => ({
  key: `line-${number}`,
  number,
  payoff,
});

describe("payoffGeometry", () => {
  it("draws each line through its exact knots inside the axis", () => {
    // Long call 100 at 5: -500 up to 100, then +100 per point: +1500 at 120.
    const geometry = payoffGeometry({
      lines: [line(1, payoffOf(call(100, 5)))],
      max: 120,
      min: 80,
      price: 110,
    });
    // y domain -500..1500 (nice): 1500 is y 0, -500 is y 100, 0 is y 75.
    expect(geometry.paths).toEqual([
      { badgeY: 0, d: "M0 100 L50 100 L100 0", key: "line-1", number: 1 },
    ]);
    expect(geometry.zeroY).toBe(75);
    expect(geometry.markerX).toBe(75);
    expect(geometry.xTicks).toEqual([
      { position: 0, value: 80 },
      { position: 25, value: 90 },
      { position: 50, value: 100 },
      { position: 75, value: 110 },
      { position: 100, value: 120 },
    ]);
    expect(geometry.yTicks.map((tick) => tick.value)).toEqual([
      -500, 0, 500, 1000, 1500,
    ]);
    expect(geometry.yTicks.map((tick) => tick.position)).toEqual([
      100, 75, 50, 25, 0,
    ]);
  });

  it("leaves out knots outside the axis and a knot on its edge", () => {
    const geometry = payoffGeometry({
      lines: [line(1, payoffOf(call(100, 5)))],
      max: 200,
      min: 100,
      price: null,
    });
    // Two points only: the knots 0 and 100 are not inside the axis.
    expect(geometry.paths[0]?.d).toMatch(/^M0 [\d.]+ L100 [\d.]+$/u);
    expect(geometry.markerX).toBeNull();
  });

  it("has no marker for a price outside the axis", () => {
    const input = {
      lines: [line(1, payoffOf(call(100, 5)))],
      max: 120,
      min: 80,
    };
    expect(payoffGeometry({ ...input, price: 79.5 }).markerX).toBeNull();
    expect(payoffGeometry({ ...input, price: 120.1 }).markerX).toBeNull();
    expect(payoffGeometry({ ...input, price: 80 }).markerX).toBe(0);
    expect(payoffGeometry({ ...input, price: 120 }).markerX).toBe(100);
  });

  it("keeps the number badges of lines that end together apart", () => {
    const stock = payoffOf({ basis: 100, kind: "stock" }, 100);
    const geometry = payoffGeometry({
      lines: [
        line(1, payoffOf(call(100, 5))),
        line(2, stock),
        line(3, payoffOf(call(100, 5))),
      ],
      max: 120,
      min: 80,
      price: null,
    });
    // Stock: -2000 at 80, +2000 at 120. Calls: +1500 at 120. Domain -2000..2000.
    expect(geometry.paths.map((path) => [path.number, path.badgeY])).toEqual([
      [1, 12.5],
      [2, 0],
      [3, 19.5],
    ]);
    expect(geometry.paths[1]?.d).toBe("M0 100 L100 0");
  });

  it("moves badges up when the stack would pass the bottom of the plot", () => {
    const flatAt = (value: number): AvailablePayoff => ({
      ...payoffOf({ basis: 100, kind: "stock" }, 1),
      at: () => value,
    });
    const geometry = payoffGeometry({
      lines: [
        line(1, flatAt(-100)),
        line(2, flatAt(100)),
        line(3, flatAt(-100)),
        line(4, flatAt(-90)),
      ],
      max: 120,
      min: 80,
      price: null,
    });
    // Ends: 100, 0, 100 and 95. Top to bottom they would be 0, 95, 102 and 109.
    expect(geometry.paths.map((path) => [path.number, path.badgeY])).toEqual([
      [1, 93],
      [2, 0],
      [3, 100],
      [4, 86],
    ]);
  });

  it("gives a flat line a y domain with a width", () => {
    const flat: AvailablePayoff = {
      ...payoffOf({ basis: 100, kind: "stock" }, 1),
      at: () => 0,
    };
    const geometry = payoffGeometry({
      lines: [line(1, flat)],
      max: 120,
      min: 80,
      price: 100,
    });
    expect(geometry.zeroY).toBe(50);
    expect(geometry.paths[0]?.d).toBe("M0 50 L100 50");
  });

  it("returns an empty chart without lines and skips points without a value", () => {
    const empty = payoffGeometry({ lines: [], max: 120, min: 80, price: null });
    expect(empty.paths).toEqual([]);
    expect(empty.zeroY).toBe(50);
    const noValue: AvailablePayoff = {
      ...payoffOf({ basis: 100, kind: "stock" }, 1),
      at: () => null,
    };
    const geometry = payoffGeometry({
      lines: [line(1, noValue)],
      max: 120,
      min: 80,
      price: null,
    });
    expect(geometry.paths).toEqual([
      { badgeY: 50, d: "", key: "line-1", number: 1 },
    ]);
  });
});
