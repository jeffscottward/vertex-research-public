import { describe, expect, it } from "vitest";

import {
  priceVerticalFromModel,
  priceVerticalFromQuotes,
  verticalPayoff,
  type VerticalLegQuote,
} from "./vertical-spread.ts";

// Consult 2026-11-19, section 3: QQQ 2027-01-15 puts at the 2026-11-19 close (Yahoo quotes,
// QuantData IV and delta). The vegas are fixture values whose difference is the consult's +0.20.
const long640: VerticalLegQuote = {
  ask: 26.6,
  bid: 26.23,
  greeks: { delta: -0.42, gamma: 0.0042, theta: -0.21, vega: 1.0 },
  iv: 0.309,
  strike: 640,
};
const short595: VerticalLegQuote = {
  ask: 13.48,
  bid: 13.23,
  greeks: { delta: -0.24, gamma: 0.0031, theta: -0.17, vega: 0.8 },
  iv: 0.35,
  strike: 595,
};

describe("verticalPayoff", () => {
  it("prices a bear put debit spread", () => {
    const payoff = verticalPayoff("put", 640, 595, 13.06);
    expect(payoff.structure).toBe("putDebitVertical");
    expect(payoff.width).toBe(45);
    expect(payoff.maxLoss).toBe(13.06);
    expect(payoff.maxGain).toBeCloseTo(31.94, 10);
    expect(payoff.breakeven).toBeCloseTo(626.94, 10);
  });

  it("prices a bull put credit spread", () => {
    const payoff = verticalPayoff("put", 595, 640, -13.06);
    expect(payoff.structure).toBe("putCreditVertical");
    expect(payoff.maxGain).toBeCloseTo(13.06, 10);
    expect(payoff.maxLoss).toBeCloseTo(31.94, 10);
    expect(payoff.breakeven).toBeCloseTo(626.94, 10);
  });

  it("prices call debit and call credit spreads", () => {
    const debit = verticalPayoff("call", 100, 110, 4);
    expect(debit).toEqual({
      breakeven: 104,
      maxGain: 6,
      maxLoss: 4,
      structure: "callDebitVertical",
      width: 10,
    });
    const credit = verticalPayoff("call", 110, 100, -4);
    expect(credit).toEqual({
      breakeven: 104,
      maxGain: 4,
      maxLoss: 6,
      structure: "callCreditVertical",
      width: 10,
    });
  });

  it("refuses equal strikes, a net outside the width and non-finite input", () => {
    expect(() => verticalPayoff("put", 600, 600, 1)).toThrow(
      "The two strikes must differ"
    );
    expect(() => verticalPayoff("put", 640, 595, 46)).toThrow(
      "A debit spread costs less than its width"
    );
    expect(() => verticalPayoff("put", 640, 595, -1)).toThrow(
      "A debit spread (long leg nearer the money) needs a net debit above 0"
    );
    expect(() => verticalPayoff("put", 595, 640, 1)).toThrow(
      "A credit spread (short leg nearer the money) needs a net credit above 0"
    );
    expect(() => verticalPayoff("put", 595, 640, -46)).toThrow(
      "A credit spread takes in less than its width"
    );
    expect(() => verticalPayoff("put", Number.NaN, 640, 1)).toThrow(
      "longStrike must be a finite number above 0"
    );
    expect(() => verticalPayoff("put", 640, 0, 1)).toThrow(
      "shortStrike must be a finite number above 0"
    );
    expect(() => verticalPayoff("put", 640, 595, Number.NaN)).toThrow(
      "net must be a finite number"
    );
  });
});

describe("priceVerticalFromQuotes", () => {
  it("reproduces the consult's QQQ 640/595 spread at the mids and at the worse sides", () => {
    const priced = priceVerticalFromQuotes("put", long640, short595);
    expect(priced.structure).toBe("putDebitVertical");
    expect(priced.width).toBe(45);
    expect(priced.netMid).toBeCloseTo(13.06, 2);
    expect(priced.netWorst).toBeCloseTo(13.37, 2);
    expect(priced.maxLossPerContract).toBeCloseTo(1306, 0);
    expect(priced.maxLossWorstPerContract).toBeCloseTo(1337, 0);
    expect(priced.maxGainPerContract).toBeCloseTo(3194, 0);
    expect(priced.breakeven).toBeCloseTo(626.94, 2);
    expect(priced.netPctWidth).toBeCloseTo(29.0, 1);
    expect(priced.rewardToRisk).toBeCloseTo(2.45, 2);
    expect(priced.greeks?.vega).toBeCloseTo(0.2, 10);
    expect(priced.greeks?.delta).toBeCloseTo(-0.18, 10);
    expect(priced.greeks?.gamma).toBeCloseTo(0.0011, 10);
    expect(priced.greeks?.theta).toBeCloseTo(-0.04, 10);
    expect(priced.legs).toEqual([
      { ...long640, mid: 26.415, side: "long" },
      { ...short595, mid: 13.355, side: "short" },
    ]);
  });

  it("gives a credit spread its worse fill and null Greeks when a leg has none", () => {
    const priced = priceVerticalFromQuotes(
      "put",
      { ...short595, greeks: null },
      long640
    );
    expect(priced.structure).toBe("putCreditVertical");
    expect(priced.netMid).toBeCloseTo(-13.06, 2);
    // Sell the 640 at its bid, buy the 595 at its ask: credit 12.75.
    expect(priced.netWorst).toBeCloseTo(-12.75, 2);
    expect(priced.maxLossPerContract).toBeCloseTo(3194, 0);
    expect(priced.maxLossWorstPerContract).toBeCloseTo(3225, 0);
    expect(priced.greeks).toBeNull();
  });

  it("refuses crossed or negative quotes", () => {
    expect(() =>
      priceVerticalFromQuotes("put", { ...long640, bid: 27 }, short595)
    ).toThrow("640 put: bid must not be above ask");
    expect(() =>
      priceVerticalFromQuotes("put", long640, { ...short595, bid: -1 })
    ).toThrow("595 put: bid and ask must be finite numbers, 0 or above");
  });

  it("prices the mid of wide quotes whose worse-side net crosses 0 or the width", () => {
    const leg = (
      strike: number,
      bid: number,
      ask: number
    ): VerticalLegQuote => ({
      ask,
      bid,
      greeks: null,
      iv: null,
      strike,
    });
    const credit = priceVerticalFromQuotes(
      "put",
      leg(95, 0, 0.05),
      leg(100, 0, 0.1)
    );
    expect(credit.structure).toBe("putCreditVertical");
    expect(credit.netMid).toBeCloseTo(-0.025, 10);
    expect(credit.netWorst).toBeCloseTo(0.05, 10);
    expect(credit.maxLossWorstPerContract).toBeCloseTo(505, 8);
    const debit = priceVerticalFromQuotes(
      "put",
      leg(105, 4, 6),
      leg(100, 0, 0.2)
    );
    expect(debit.netMid).toBeCloseTo(4.9, 10);
    expect(debit.maxLossWorstPerContract).toBeCloseTo(600, 8);
    expect(debit.maxLossPerContract).toBeCloseTo(490, 8);
  });
});

describe("priceVerticalFromModel", () => {
  // Consult cross-check 2: VXN 33.12 (2026-11-18), rate 4.00 %, QQQ 645.04, 57 days: 12.76.
  const consult = {
    days: 57,
    ivIndex: { id: "VXN", level: 33.12 },
    rate: 0.04,
    spot: 645.04,
    symbol: "QQQ",
  };

  it("reproduces the consult's model value within 5 %", () => {
    const priced = priceVerticalFromModel("put", 640, 595, consult);
    expect(priced.structure).toBe("putDebitVertical");
    expect(Math.abs(priced.netMid / 12.76 - 1)).toBeLessThan(0.05);
    expect(priced.netMid).toBeCloseTo(12.758, 3);
    expect(priced.legs[0].delta).toBeCloseTo(-0.433, 3);
    expect(priced.legs[1].delta).toBeCloseTo(-0.244, 3);
    expect(priced.legs[0].iv).toBeCloseTo(0.303, 3);
    expect(priced.legs[1].iv).toBeCloseTo(0.3492, 4);
    expect(priced.atmIv).toBeCloseTo(0.9 * 0.3312, 10);
    expect(priced.dividendYield).toBe(0.007);
    expect(priced.skew).toBe(-0.25);
    // Model costs: half-spread 1.5 % of each leg's mid on both sides.
    expect(priced.netWorst).toBeGreaterThan(priced.netMid);
    expect(priced.maxLossPerContract).toBeCloseTo(priced.netMid * 100, 8);
    expect(priced.greeks.vega).toBeGreaterThan(0);
    expect(priced.netPctWidth).toBeCloseTo((priced.netMid / 45) * 100, 10);
  });

  it("uses no dividend yield where the model has none and refuses a bad horizon", () => {
    const gld = priceVerticalFromModel("call", 300, 320, {
      days: 30,
      ivIndex: { id: "GVZ", level: 20 },
      rate: 0.04,
      spot: 305,
      symbol: "GLD",
    });
    expect(gld.dividendYield).toBe(0);
    expect(gld.structure).toBe("callDebitVertical");
    expect(() =>
      priceVerticalFromModel("put", 640, 595, { ...consult, days: 0 })
    ).toThrow("days must be a finite number above 0");
    expect(() =>
      priceVerticalFromModel("put", 640, 595, { ...consult, symbol: "AAPL" })
    ).toThrow("No skew model for AAPL");
    expect(() =>
      priceVerticalFromModel("put", 640, 595, { ...consult, spot: -1 })
    ).toThrow("spot and strikes must be finite numbers above 0");
  });
});
