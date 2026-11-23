import { describe, expect, it } from "vitest";

import {
  foldHedgingPressure,
  HEDGING_PRESSURE_RULES,
  HEDGING_READ_CAP,
  type HedgingPrint,
  printDelta,
  printSign,
} from "./flow-hedging-pressure-rules.ts";
import { OPTIONS_CHAIN_RISK_FREE_RATE } from "./options-chain-merge.ts";
import { bsDelta, DIVIDEND_YIELD } from "./options-engine/pricing.ts";

// Friday 2026-11-20 10:00:00 New York.
const T0 = Date.parse("2026-11-20T15:00:00.000Z");

/** An at-the-money SPY call bought at the ask, 10 contracts, IV 20%, 30 days to expiry. */
const print = (overrides: Partial<HedgingPrint> = {}): HedgingPrint => ({
  dte: 30,
  iv: 20,
  right: "call",
  side: "ask",
  size: 10,
  strike: 660,
  tradedAt: new Date(T0),
  underlyingPrice: 660,
  ...overrides,
});
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
/** The delta of the rules for a print, computed directly with the model. */
const modelDelta = (value: HedgingPrint, sigma: number): number =>
  bsDelta(
    value.right,
    value.underlyingPrice ?? 0,
    value.strike,
    Math.max(value.dte ?? 0, 0) / 365,
    0.04,
    0.015,
    sigma
  );
const notionalOf = (value: HedgingPrint, sign: number): number =>
  sign *
  modelDelta(value, (value.iv ?? 0) / 100) *
  value.size *
  100 *
  (value.underlyingPrice ?? 0);

describe("HEDGING_PRESSURE_RULES", () => {
  it("is version 1 with the options chain rate, the SPY yield and a 20% fallback, frozen", () => {
    expect(HEDGING_PRESSURE_RULES).toEqual({
      dividendYield: 0.015,
      rate: 0.04,
      version: "hedging-pressure.v1",
      volFallback: 0.2,
    });
    expect(HEDGING_PRESSURE_RULES.rate).toBe(OPTIONS_CHAIN_RISK_FREE_RATE);
    expect(HEDGING_PRESSURE_RULES.dividendYield).toBe(
      DIVIDEND_YIELD.get("SPY")
    );
    expect(Object.isFrozen(HEDGING_PRESSURE_RULES)).toBe(true);
    expect(HEDGING_READ_CAP).toBe(200_000);
  });
});

describe("printSign", () => {
  it.each([
    ["above_ask", 1],
    ["ask", 1],
    ["mid", 0],
    ["bid", -1],
    ["below_bid", -1],
    ["unknown", 0],
  ] as const)("signs %s as %d", (side, sign) => {
    expect(printSign(side)).toBe(sign);
  });
});

describe("printDelta", () => {
  it("prices a print with its own IV in percent and the time in years", () => {
    const value = print();
    expect(printDelta(value)).toEqual({
      delta: modelDelta(value, 0.2),
      ivAdjusted: false,
    });
    const put = print({ right: "put" });
    const priced = printDelta(put);
    expect(priced?.delta).toBeLessThan(0);
    expect(priced?.delta).toBeCloseTo(modelDelta(put, 0.2), 12);
  });

  it.each([
    ["the vendor placeholder", 0.0477],
    ["0", 0],
  ])("uses the fallback volatility for an IV of %s", (_name, iv) => {
    // A deep in-the-money call: a delta near 1 with the fallback.
    const value = print({ iv, strike: 600 });
    const priced = printDelta(value);
    expect(priced).toEqual({
      delta: modelDelta(value, 0.2),
      ivAdjusted: true,
    });
    expect(priced?.delta).toBeGreaterThan(0.95);
  });

  it.each([
    ["an IV of NaN", { iv: Number.NaN }],
    ["an infinite IV", { iv: Number.POSITIVE_INFINITY }],
    ["no IV", { iv: null }],
    ["no days to expiry", { dte: null }],
    ["days to expiry of NaN", { dte: Number.NaN }],
    ["no underlying price", { underlyingPrice: null }],
    ["an underlying price of 0", { underlyingPrice: 0 }],
    ["a strike of 0", { strike: 0 }],
  ] as const)("gives null for %s", (_name, overrides) => {
    expect(printDelta(print(overrides))).toBeNull();
  });

  it("prices 0 and negative days to expiry at expiry (intrinsic delta)", () => {
    expect(printDelta(print({ dte: 0, strike: 650 }))).toEqual({
      delta: 1,
      ivAdjusted: false,
    });
    expect(printDelta(print({ dte: -0.5, strike: 650 }))).toEqual({
      delta: 1,
      ivAdjusted: false,
    });
    expect(printDelta(print({ dte: 0, right: "put", strike: 650 }))).toEqual({
      delta: 0,
      ivAdjusted: false,
    });
  });
});

describe("foldHedgingPressure", () => {
  it("gives zero totals, no points and no stored time for no prints", () => {
    expect(foldHedgingPressure([])).toEqual({
      points: [],
      storedUntil: null,
      totals: {
        calls: 0,
        gross: 0,
        ivAdjusted: 0,
        largestFall: null,
        largestRise: null,
        net: 0,
        notPriced: 0,
        notSigned: 0,
        prints: 0,
        puts: 0,
        signed: 0,
      },
    });
  });

  it.each([
    ["bought call", "ask", "call", 1],
    ["sold call", "bid", "call", -1],
    ["bought put", "above_ask", "put", -1],
    ["sold put", "below_bid", "put", 1],
  ] as const)(
    "signs a %s: dealer hedge %d",
    (_name, side, right, direction) => {
      const value = print({ right, side });
      const fold = foldHedgingPressure([value]);
      const sign = side === "ask" || side === "above_ask" ? 1 : -1;
      const notional = notionalOf(value, sign);
      expect(Math.sign(notional)).toBe(direction);
      expect(fold.totals.net).toBeCloseTo(notional, 6);
      expect(fold.totals.gross).toBeCloseTo(Math.abs(notional), 6);
      expect(right === "call" ? fold.totals.calls : fold.totals.puts).toBe(
        fold.totals.net
      );
      expect(right === "call" ? fold.totals.puts : fold.totals.calls).toBe(0);
    }
  );

  it("counts in the order of step 4: read, not signed, signed, not priced, IV adjusted", () => {
    const fold = foldHedgingPressure([
      print({ side: "mid" }),
      // Not signed wins over not priced.
      print({ iv: null, side: "unknown" }),
      print({ iv: null }),
      print({ dte: null, side: "bid" }),
      print({ side: "below_bid", underlyingPrice: 0 }),
      print({ iv: 0.0477 }),
      print({ iv: 0.0477, underlyingPrice: null }),
      print(),
    ]);
    expect(fold.totals).toMatchObject({
      ivAdjusted: 1,
      notPriced: 4,
      notSigned: 2,
      prints: 8,
      signed: 6,
    });
    expect(fold.points).toHaveLength(1);
    expect(fold.points[0]?.prints).toBe(2);
  });

  it("groups counted prints by minute with running sums at the end of each minute", () => {
    const call = print({ tradedAt: at(5) });
    const put = print({ right: "put", side: "bid", tradedAt: at(50) });
    const later = print({
      side: "bid",
      tradedAt: at(185),
      underlyingPrice: 661,
    });
    // Input out of order: the fold sorts by trade time.
    const fold = foldHedgingPressure([later, put, call]);
    const callNotional = notionalOf(call, 1);
    const putNotional = notionalOf(put, -1);
    const laterNotional = notionalOf(later, -1);
    expect(fold.points.map((point) => point.minute)).toEqual([
      "2026-11-20T15:00:00.000Z",
      "2026-11-20T15:03:00.000Z",
    ]);
    const [first, second] = fold.points;
    expect(first?.prints).toBe(2);
    expect(first?.minuteNet).toBeCloseTo(callNotional + putNotional, 6);
    expect(first?.net).toBeCloseTo(callNotional + putNotional, 6);
    expect(first?.calls).toBeCloseTo(callNotional, 6);
    expect(first?.puts).toBeCloseTo(putNotional, 6);
    expect(second?.prints).toBe(1);
    expect(second?.minuteNet).toBeCloseTo(laterNotional, 6);
    expect(second?.net).toBeCloseTo(
      callNotional + putNotional + laterNotional,
      6
    );
    expect(second?.calls).toBeCloseTo(callNotional + laterNotional, 6);
    expect(second?.puts).toBeCloseTo(putNotional, 6);
    expect(fold.storedUntil).toBe(at(185).toISOString());
  });

  it("keeps equal trade times in input order", () => {
    const first = print({ tradedAt: at(1), underlyingPrice: 660 });
    const second = print({
      side: "mid",
      tradedAt: at(1),
      underlyingPrice: 662,
    });
    expect(foldHedgingPressure([first, second]).points[0]?.price).toBe(662);
    expect(foldHedgingPressure([second, first]).points[0]?.price).toBe(660);
  });

  it("takes the price of the newest priced print of the minute, counted or not", () => {
    const fold = foldHedgingPressure([
      print({ tradedAt: at(1), underlyingPrice: 660 }),
      // A not-signed print later in the minute moves the price.
      print({ side: "mid", tradedAt: at(20), underlyingPrice: 660.5 }),
      // Prints without a usable price do not clear it.
      print({ side: "mid", tradedAt: at(30), underlyingPrice: null }),
      print({ side: "mid", tradedAt: at(40), underlyingPrice: 0 }),
      print({ side: "mid", tradedAt: at(45), underlyingPrice: Number.NaN }),
      // A minute without a counted print gives no point.
      print({ side: "mid", tradedAt: at(70), underlyingPrice: 661 }),
      print({ tradedAt: at(130), underlyingPrice: 661.5 }),
    ]);
    expect(fold.points.map((point) => point.price)).toEqual([660.5, 661.5]);
    expect(fold.points.map((point) => point.minute)).toEqual([
      "2026-11-20T15:00:00.000Z",
      "2026-11-20T15:02:00.000Z",
    ]);
  });

  it("gives no point and a null stored time when no print is counted", () => {
    const fold = foldHedgingPressure([
      print({ side: "mid" }),
      print({ iv: null }),
    ]);
    expect(fold.points).toEqual([]);
    expect(fold.storedUntil).toBeNull();
    expect(fold.totals).toMatchObject({
      gross: 0,
      net: 0,
      notPriced: 1,
      notSigned: 1,
      prints: 2,
    });
  });

  it("names the largest rise and fall; the first minute wins a tie", () => {
    const buy = (seconds: number) => print({ tradedAt: at(seconds) });
    const sell = (seconds: number) =>
      print({ side: "bid", tradedAt: at(seconds) });
    const fold = foldHedgingPressure([
      buy(0),
      buy(60),
      buy(61),
      sell(120),
      sell(121),
      buy(180),
      buy(181),
      sell(240),
      sell(241),
    ]);
    expect(fold.totals.largestRise).toEqual({
      minute: "2026-11-20T15:01:00.000Z",
      minuteNet: fold.points[1]?.minuteNet,
    });
    expect(fold.totals.largestFall).toEqual({
      minute: "2026-11-20T15:02:00.000Z",
      minuteNet: fold.points[2]?.minuteNet,
    });
    // Only rises: no fall; only falls: no rise.
    expect(foldHedgingPressure([buy(0)]).totals.largestFall).toBeNull();
    expect(foldHedgingPressure([sell(0)]).totals.largestRise).toBeNull();
  });

  it("uses the rules it is given", () => {
    const value = print({ iv: 0.0477, strike: 700 });
    const fold = foldHedgingPressure([value], {
      ...HEDGING_PRESSURE_RULES,
      volFallback: 0.5,
    });
    expect(fold.totals.net).toBeCloseTo(
      modelDelta(value, 0.5) * 10 * 100 * 660,
      6
    );
    expect(fold.totals.ivAdjusted).toBe(1);
  });
});
