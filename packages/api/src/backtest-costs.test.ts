import { describe, expect, it } from "vitest";

import {
  affordableUnits,
  averageTrueRange,
  borrowFee,
  COST_PROFILE_PRESET_IDS,
  COST_PROFILE_PRESETS,
  type CostProfile,
  fillCosts,
  orderCharges,
  ZERO_COST_PROFILE,
} from "./backtest-costs.ts";
import { CostProfileSchema } from "./contracts/backtest-cost-profiles.ts";

const fixed = COST_PROFILE_PRESETS["ibkr-pro-fixed-us-stock"];
const tiered = COST_PROFILE_PRESETS["ibkr-pro-tiered-us-stock"];
const option = COST_PROFILE_PRESETS["ibkr-pro-us-option"];

describe("cost profile presets", () => {
  it("parse with the contract schema", () => {
    for (const id of COST_PROFILE_PRESET_IDS) {
      expect(CostProfileSchema.parse(COST_PROFILE_PRESETS[id])).toEqual(
        COST_PROFILE_PRESETS[id]
      );
    }
  });
});

describe("orderCharges", () => {
  // IBKR's own Fixed examples: 100 @ 25 = 1.00, 1,000 @ 25 = 5.00, 1,000 @ 0.25 = 2.50.
  it("reproduces the IBKR Pro Fixed stock examples", () => {
    expect(orderCharges(fixed, "buy", 100, 25).commission).toBe(1);
    expect(orderCharges(fixed, "buy", 1000, 25).commission).toBe(5);
    expect(orderCharges(fixed, "buy", 1000, 0.25).commission).toBeCloseTo(
      2.5,
      12
    );
  });

  it("charges the audit-trail fee on buys and adds the SEC fee on sells", () => {
    expect(orderCharges(fixed, "buy", 1000, 25).fees).toBeCloseTo(0.003, 12);
    // 1,000 x 0.000003 + 25,000 x 0.0000206 = 0.003 + 0.515.
    expect(orderCharges(fixed, "sell", 1000, 25).fees).toBeCloseTo(0.518, 12);
  });

  it("adds clearing and pass-through fees for Tiered", () => {
    const sell = orderCharges(tiered, "sell", 1000, 25);
    expect(sell.commission).toBeCloseTo(3.5, 12);
    // 1,000 x 0.000203 + 3.5 x 0.00074 + 25,000 x 0.0000206.
    expect(sell.fees).toBeCloseTo(0.203 + 0.002_59 + 0.515, 12);
    expect(orderCharges(tiered, "buy", 10, 25).commission).toBe(0.35);
  });

  // IBKR's option examples at <= 10,000 contracts per month.
  it("reproduces the IBKR Pro option examples by premium tier", () => {
    expect(orderCharges(option, "buy", 100, 2).commission).toBe(1);
    expect(orderCharges(option, "buy", 200, 5).commission).toBeCloseTo(1.3, 12);
    expect(orderCharges(option, "buy", 300, 0.075).commission).toBeCloseTo(
      1.5,
      12
    );
    expect(orderCharges(option, "buy", 500, 0.03).commission).toBeCloseTo(
      1.25,
      12
    );
  });

  it("charges option fees per contract", () => {
    expect(orderCharges(option, "buy", 200, 5).fees).toBeCloseTo(
      2 * 0.0253,
      12
    );
    expect(orderCharges(option, "sell", 200, 5).fees).toBeCloseTo(
      2 * 0.0253 + 1000 * 0.000_020_6,
      12
    );
  });

  it("applies percent commission and a money cap", () => {
    const profile: CostProfile = {
      ...ZERO_COST_PROFILE,
      commission: {
        ...ZERO_COST_PROFILE.commission,
        maxPerOrder: 20,
        percentOfValue: 0.1,
      },
    };
    expect(orderCharges(profile, "buy", 100, 50).commission).toBeCloseTo(5, 12);
    expect(orderCharges(profile, "buy", 1000, 50).commission).toBe(20);
  });

  it("charges nothing for an empty order", () => {
    expect(orderCharges(fixed, "buy", 0, 25)).toEqual({
      commission: 0,
      fees: 0,
    });
  });
});

describe("fillCosts", () => {
  const profile: CostProfile = {
    ...ZERO_COST_PROFILE,
    slippage: { bps: 5, kind: "bps" },
    spreadBps: 10,
  };

  it("adds half the spread and the slippage to a buy", () => {
    const buy = fillCosts(profile, "buy", 10, 100, Number.NaN);
    expect(buy.price).toBeCloseTo(100.1, 12);
    expect(buy.spread).toBeCloseTo(0.5, 12);
    expect(buy.slippage).toBeCloseTo(0.5, 12);
  });

  it("subtracts them from a sell", () => {
    expect(fillCosts(profile, "sell", 10, 100, Number.NaN).price).toBeCloseTo(
      99.9,
      12
    );
  });

  it("uses a fraction of the ATR", () => {
    const atrProfile: CostProfile = {
      ...ZERO_COST_PROFILE,
      slippage: { fraction: 0.5, kind: "atr", period: 3 },
    };
    const sell = fillCosts(atrProfile, "sell", 4, 50, 2);
    expect(sell.price).toBe(49);
    expect(sell.slippage).toBe(4);
    // No ATR yet: no slippage.
    expect(fillCosts(atrProfile, "buy", 4, 50, Number.NaN).price).toBe(50);
  });

  it("never sells below zero", () => {
    const atrProfile: CostProfile = {
      ...ZERO_COST_PROFILE,
      slippage: { fraction: 2, kind: "atr", period: 3 },
      spreadBps: 10_000,
    };
    const sell = fillCosts(atrProfile, "sell", 1, 1, 1);
    expect(sell.price).toBe(0);
    expect(sell.spread + sell.slippage).toBeCloseTo(1, 12);
  });
});

describe("affordableUnits", () => {
  it("leaves room for the minimum commission and fees", () => {
    // u x 10 + max(1, 0.005u) + 0.000003u = 1000, and 0.005u < 1.
    const units = affordableUnits(fixed, 1000, 10);
    expect(units).toBeCloseTo(999 / 10.000_003, 9);
    const charges = orderCharges(fixed, "buy", units, 10);
    expect(units * 10 + charges.commission + charges.fees).toBeLessThanOrEqual(
      1000
    );
  });

  it("trims a rounding overshoot so that the order never exceeds the cash", () => {
    // Found by search: the fixed point lands a rounding step above the cash for these inputs.
    const cash = 1295.919_999_999_978_5;
    const units = affordableUnits(tiered, cash, 17.77);
    const charges = orderCharges(tiered, "buy", units, 17.77);
    expect(
      units * 17.77 + charges.commission + charges.fees
    ).toBeLessThanOrEqual(cash);
  });

  it("sizes correctly when the per-share charge exceeds the price", () => {
    const heavy: CostProfile = {
      ...ZERO_COST_PROFILE,
      commission: { ...ZERO_COST_PROFILE.commission, perShare: 20 },
    };
    // u x 10 + 20u = 900.
    expect(affordableUnits(heavy, 900, 10)).toBeCloseTo(30, 9);
  });

  it("scales unit equity to money", () => {
    expect(affordableUnits(fixed, 1, 10, 1000)).toBeCloseTo(
      999 / 10.000_003 / 1000,
      12
    );
  });

  it("returns 0 when the minimum charge exceeds the cash", () => {
    const noCap: CostProfile = {
      ...fixed,
      commission: { ...fixed.commission, maxPercentOfValue: null },
    };
    expect(affordableUnits(noCap, 0.5, 10)).toBe(0);
    // With the 1% cap the order stays possible: the commission shrinks with the value.
    expect(affordableUnits(fixed, 0.5, 10)).toBeGreaterThan(0);
  });

  it("is exact without charges", () => {
    expect(affordableUnits(ZERO_COST_PROFILE, 0.99, 12.5)).toBe(0.99 / 12.5);
  });
});

describe("borrowFee and averageTrueRange", () => {
  it("charges the annual rate on actual/360 days", () => {
    expect(
      borrowFee({ ...ZERO_COST_PROFILE, borrowFeeAnnualPct: 3 }, -10_000, 30)
    ).toBeCloseTo(25, 12);
  });

  it("averages true ranges including gaps from the prior close", () => {
    const atr = averageTrueRange(
      Float64Array.of(11, 12, 15),
      Float64Array.of(9, 10, 13),
      Float64Array.of(10, 11, 14),
      2
    );
    // Ranges: 2, max(2, 2, 0) = 2, max(2, 4, 2) = 4.
    expect(Number.isNaN(atr[0])).toBe(true);
    expect(Array.from(atr.slice(1))).toEqual([2, 3]);
  });
});
