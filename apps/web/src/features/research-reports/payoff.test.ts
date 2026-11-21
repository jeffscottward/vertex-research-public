import { describe, expect, it } from "vitest";

import {
  type AvailablePayoff,
  expiryProfit,
  type OptionKind,
  type PayoffLeg,
  type PayoffStrategy,
  prepareExpiryPayoff,
  readMultiplier,
} from "./payoff.ts";

// Synthetic unit fixtures only; these are not market quotes or stored strategies.
// Old inputs map to the narrow type like this (design, "Module 1", parity table):
// reportId absent or "APP" -> assumedMultiplier 100; reportId "SIVE" -> assumedMultiplier null;
// multiplier x -> readMultiplier(x); stored quantity or stockShares -> the units argument.
type LegInput = Readonly<{
  side: PayoffLeg["side"];
  type: PayoffLeg["type"];
  strike: number;
  premium: number | null;
  multiplier?: unknown;
}>;
const leg = (input: LegInput): PayoffLeg => ({
  multiplier: readMultiplier(input.multiplier),
  premium: input.premium,
  side: input.side,
  strike: input.strike,
  type: input.type,
});
const option = (
  kind: OptionKind,
  legs: readonly LegInput[],
  overrides: Readonly<{ multiplier?: unknown; assumed?: number | null }> = {}
): PayoffStrategy => ({
  assumedMultiplier: overrides.assumed === undefined ? 100 : overrides.assumed,
  kind,
  legs: legs.map(leg),
  multiplier: readMultiplier(overrides.multiplier),
});
const stock = (basis: number | null): PayoffStrategy => ({
  basis,
  kind: "stock",
});
const NONE = { assumed: null } as const;

const LONG_CALL: readonly LegInput[] = [
  { premium: 5, side: "buy", strike: 100, type: "call" },
];
const SHORT_PUT: readonly LegInput[] = [
  { premium: 5, side: "sell", strike: 100, type: "put" },
];
const CALL_BUY: LegInput = {
  premium: 8,
  side: "buy",
  strike: 100,
  type: "call",
};
const CALL_SELL: LegInput = {
  premium: 3,
  side: "sell",
  strike: 110,
  type: "call",
};
const CALL_SPREAD: readonly LegInput[] = [CALL_BUY, CALL_SELL];
const PUT_SELL: LegInput = {
  premium: 7,
  side: "sell",
  strike: 100,
  type: "put",
};
const PUT_BUY: LegInput = { premium: 2, side: "buy", strike: 90, type: "put" };
const PUT_SPREAD: readonly LegInput[] = [PUT_SELL, PUT_BUY];

const longCall = option("long-call", LONG_CALL);
const shortPut = option("cash-secured-put", SHORT_PUT);
const callSpread = option("bull-call-spread", CALL_SPREAD);
const putSpread = option("put-credit-spread", PUT_SPREAD);

const available = (
  strategy: PayoffStrategy,
  units: number
): AvailablePayoff => {
  const payoff = prepareExpiryPayoff(strategy, units);
  if (!payoff.available) throw new Error(payoff.reason);
  return payoff;
};
const reason = (strategy: PayoffStrategy, units = 1): string => {
  const payoff = prepareExpiryPayoff(strategy, units);
  return payoff.available ? "available" : payoff.reason;
};

describe("intrinsic expiry profit or loss (the 14 cases of the old model)", () => {
  it("a long call pays its premium and gains only above its strike", () => {
    expect(expiryProfit(longCall, 90, 1)).toBe(-500);
    expect(expiryProfit(longCall, 105, 1)).toBe(0);
    expect(expiryProfit(longCall, 120, 1)).toBe(1500);
    const payoff = available(longCall, 1);
    expect(payoff.maxLoss).toBe(500);
    expect(payoff.maxProfit).toBeNull();
    expect(payoff.breakevens).toEqual([105]);
  });

  it("a short put receives premium but owes in-the-money intrinsic value", () => {
    expect(expiryProfit(shortPut, 110, 1)).toBe(500);
    expect(expiryProfit(shortPut, 95, 1)).toBe(0);
    expect(expiryProfit(shortPut, 0, 1)).toBe(-9500);
    const payoff = available(shortPut, 1);
    expect(payoff.maxLoss).toBe(9500);
    expect(payoff.maxProfit).toBe(500);
    expect(payoff.breakevens).toEqual([95]);
  });

  it("a bull call spread has a debit floor and a width-minus-debit cap", () => {
    expect(expiryProfit(callSpread, 0, 1)).toBe(-500);
    expect(expiryProfit(callSpread, 100, 1)).toBe(-500);
    expect(expiryProfit(callSpread, 105, 1)).toBe(0);
    expect(expiryProfit(callSpread, 110, 1)).toBe(500);
    expect(expiryProfit(callSpread, 1000, 1)).toBe(500);
    const payoff = available(callSpread, 1);
    expect(payoff.maxLoss).toBe(500);
    expect(payoff.maxProfit).toBe(500);
    expect(payoff.breakevens).toEqual([105]);
    // Computing each call independently would lose the spread width here.
    expect(expiryProfit(callSpread, 1e20, 1)).toBe(500);
  });

  it("a put credit spread caps losses below the long strike and profit above the short strike", () => {
    expect(expiryProfit(putSpread, 0, 1)).toBe(-500);
    expect(expiryProfit(putSpread, 90, 1)).toBe(-500);
    expect(expiryProfit(putSpread, 95, 1)).toBe(0);
    expect(expiryProfit(putSpread, 100, 1)).toBe(500);
    expect(expiryProfit(putSpread, 1000, 1)).toBe(500);
    const payoff = available(putSpread, 1);
    expect(payoff.maxLoss).toBe(500);
    expect(payoff.maxProfit).toBe(500);
    expect(payoff.breakevens).toEqual([95]);
  });

  it("the contract count multiplies every leg and the risk by 100 shares, not the breakeven", () => {
    // Old: stored quantity 3 as the default size, then an explicit size of 2.
    expect(expiryProfit(putSpread, 90, 3)).toBe(-1500);
    expect(expiryProfit(putSpread, 100, 2)).toBe(1000);
    const payoff = available(putSpread, 2);
    expect(payoff.maxLoss).toBe(1000);
    expect(payoff.maxProfit).toBe(1000);
    expect(payoff.breakevens).toEqual([95]);
    expect(payoff.units).toBe(2);
    expect(payoff.contractMultiplier).toBe(100);
    expect(payoff.multiplierAssumed).toBe(true);
  });

  it("an option of a report without the assumed multiplier never inherits 100 shares", () => {
    expect(
      expiryProfit(option("long-call", LONG_CALL, NONE), 120, 1)
    ).toBeNull();
    for (const multiplier of [null, 0, "unverified", Number.POSITIVE_INFINITY])
      expect(
        expiryProfit(
          option("long-call", LONG_CALL, { ...NONE, multiplier }),
          120,
          1
        )
      ).toBeNull();
    expect(expiryProfit(longCall, 120, 1)).toBe(1500);
  });

  it("an explicit strategy multiplier scales risk and profit, not the breakeven", () => {
    const supplied = option("bull-call-spread", CALL_SPREAD, {
      ...NONE,
      multiplier: "10",
    });
    expect(expiryProfit(supplied, 100, 3)).toBe(-150);
    expect(expiryProfit(supplied, 110, 3)).toBe(150);
    expect(expiryProfit(supplied, 110, 2)).toBe(100);
    const payoff = available(supplied, 3);
    expect(payoff.maxLoss).toBe(150);
    expect(payoff.maxProfit).toBe(150);
    expect(payoff.breakevens).toEqual([105]);
    expect(payoff.multiplierAssumed).toBe(false);
  });

  it("matching explicit leg multipliers support spreads without a strategy multiplier", () => {
    const legs = [
      { ...PUT_SELL, multiplier: "50" },
      { ...PUT_BUY, multiplier: 50 },
    ];
    const supplied = option("put-credit-spread", legs, NONE);
    expect(expiryProfit(supplied, 90, 1)).toBe(-250);
    expect(expiryProfit(supplied, 100, 1)).toBe(250);
    expect(
      expiryProfit(
        option("put-credit-spread", legs, { ...NONE, multiplier: 50 }),
        100,
        1
      )
    ).toBe(250);
    expect(available(supplied, 1).multiplierAssumed).toBe(false);
  });

  it("missing, conflicting and invalid leg multipliers cannot fabricate spread arithmetic", () => {
    const spread = (
      legs: readonly LegInput[],
      multiplier?: unknown
    ): PayoffStrategy =>
      option("bull-call-spread", legs, { ...NONE, multiplier });
    const cases: readonly (readonly [PayoffStrategy, string])[] = [
      [
        spread([{ ...CALL_BUY, multiplier: 10 }, CALL_SELL]),
        "multiplier-missing",
      ],
      [
        spread([
          { ...CALL_BUY, multiplier: 10 },
          { ...CALL_SELL, multiplier: 100 },
        ]),
        "multiplier-mismatch",
      ],
      [
        spread(
          [
            { ...CALL_BUY, multiplier: 10 },
            { ...CALL_SELL, multiplier: 10 },
          ],
          100
        ),
        "multiplier-mismatch",
      ],
      [
        spread([{ ...CALL_BUY, multiplier: null }, CALL_SELL], 10),
        "multiplier-invalid",
      ],
      [
        spread([{ ...CALL_BUY, multiplier: -10 }, CALL_SELL], 10),
        "multiplier-invalid",
      ],
      [
        spread([CALL_BUY, { ...CALL_SELL, multiplier: null }], 10),
        "multiplier-invalid",
      ],
    ];
    for (const [strategy, expected] of cases) {
      expect(expiryProfit(strategy, 110, 1)).toBeNull();
      expect(reason(strategy)).toBe(expected);
    }
  });

  it("an explicit multiplier overrides the assumed one, and stock ignores option multipliers", () => {
    expect(
      expiryProfit(option("long-call", LONG_CALL, { multiplier: 10 }), 120, 1)
    ).toBe(150);
    expect(
      expiryProfit(
        option("long-call", [{ ...LONG_CALL[0], multiplier: 10 } as LegInput]),
        120,
        1
      )
    ).toBe(150);
    expect(expiryProfit(stock(40), 50, 25)).toBe(250);
  });

  it("stock uses the supplied cost basis and shares, never the option multiplier", () => {
    expect(expiryProfit(stock(40), 50, 25)).toBe(250);
    expect(expiryProfit(stock(40), 0, 25)).toBe(-1000);
    expect(expiryProfit(stock(40), 50, 2.5)).toBe(25);
    const payoff = available(stock(40), 10);
    expect(payoff.maxLoss).toBe(400);
    expect(payoff.maxProfit).toBeNull();
    expect(payoff.breakevens).toEqual([40]);
    expect(payoff.breakevenRanges).toEqual([]);
    expect(payoff.contractMultiplier).toBeNull();
    expect(payoff.multiplierAssumed).toBe(false);
    expect(payoff.netPremiumPerShare).toBe(40);
    expect(payoff.knots).toEqual([0]);
    // Old: stockEntry undefined; stockShares undefined with no size argument.
    expect(expiryProfit(stock(null), 50, 25)).toBeNull();
    expect(reason(stock(null), 25)).toBe("stock-basis");
    expect(reason(stock(-1), 25)).toBe("stock-basis");
    expect(expiryProfit(stock(40), 50, Number.NaN)).toBeNull();
    expect(reason(stock(40), Number.NaN)).toBe("size");
  });

  it("missing leg premiums cannot become zero", () => {
    const incomplete = option("bull-call-spread", [
      CALL_BUY,
      { ...CALL_SELL, premium: null },
    ]);
    expect(expiryProfit(incomplete, 105, 1)).toBeNull();
    expect(reason(incomplete)).toBe("premium");
    for (const premium of [Number.NaN, Number.POSITIVE_INFINITY, -1])
      expect(
        reason(option("long-call", [{ ...LONG_CALL[0], premium } as LegInput]))
      ).toBe("premium");
  });

  it("a genuinely supplied zero premium preserves zero-payoff price ranges", () => {
    const freeCall = option("long-call", [
      { premium: 0, side: "buy", strike: 100, type: "call" },
    ]);
    expect(expiryProfit(freeCall, 90, 1)).toBe(0);
    expect(expiryProfit(freeCall, 110, 1)).toBe(1000);
    const payoff = available(freeCall, 1);
    expect(payoff.maxLoss).toBe(0);
    expect(payoff.breakevens).toEqual([]);
    expect(payoff.breakevenRanges).toEqual([{ from: 0, to: 100 }]);
    const capped = available(
      option("bull-call-spread", [
        { premium: 10, side: "buy", strike: 100, type: "call" },
        { premium: 0, side: "sell", strike: 110, type: "call" },
      ]),
      1
    );
    expect(capped.maxProfit).toBe(0);
    expect(capped.breakevenRanges).toEqual([{ from: 110, to: null }]);
    expect(capped.breakevens).toEqual([]);
  });

  it("invalid prices, sizes and malformed structures have no numerical payoff", () => {
    for (const price of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(expiryProfit(longCall, price, 1)).toBeNull();
      expect(expiryProfit(stock(40), price, 1)).toBeNull();
    }
    for (const size of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(expiryProfit(longCall, 120, size)).toBeNull();
      expect(reason(longCall, size)).toBe("size");
    }
    expect(reason(option("long-call", []))).toBe("no-legs");
    for (const strike of [Number.NaN, -1])
      expect(
        reason(option("long-call", [{ ...LONG_CALL[0], strike } as LegInput]))
      ).toBe("strike");
    expect(reason(option("put-credit-spread", CALL_SPREAD))).toBe("structure");
    const flipped = CALL_SPREAD.map(
      (entry): LegInput => ({
        ...entry,
        side: entry.side === "buy" ? "sell" : "buy",
      })
    );
    expect(
      expiryProfit(option("bull-call-spread", flipped), 105, 1)
    ).toBeNull();
    expect(reason(option("bull-call-spread", flipped))).toBe("structure");
  });
});

describe("readMultiplier", () => {
  it("keeps an absent value apart from an invalid one", () => {
    expect(readMultiplier(undefined)).toBeUndefined();
    for (const value of [
      null,
      0,
      -10,
      "",
      " ",
      "unverified",
      Number.POSITIVE_INFINITY,
      Number.NaN,
      true,
      {},
    ])
      expect(readMultiplier(value)).toBeNull();
    expect(readMultiplier(50)).toBe(50);
    expect(readMultiplier("10")).toBe(10);
    expect(readMultiplier(" 2.5 ")).toBe(2.5);
  });
});

describe("structures and limits beyond the old cases", () => {
  it("refuses every leg set that is not the 1:1 structure of its kind", () => {
    const refusedSets: readonly (readonly [OptionKind, readonly LegInput[]])[] =
      [
        ["long-call", SHORT_PUT],
        ["long-call", [{ ...LONG_CALL[0], type: "put" } as LegInput]],
        ["long-call", CALL_SPREAD],
        ["cash-secured-put", LONG_CALL],
        ["cash-secured-put", [{ ...SHORT_PUT[0], type: "call" } as LegInput]],
        ["cash-secured-put", PUT_SPREAD],
        ["bull-call-spread", LONG_CALL],
        ["bull-call-spread", [CALL_BUY, CALL_BUY]],
        ["bull-call-spread", [CALL_SELL, CALL_SELL]],
        ["bull-call-spread", PUT_SPREAD],
        ["bull-call-spread", [CALL_BUY, { ...CALL_SELL, type: "put" }]],
        ["bull-call-spread", [CALL_BUY, { ...CALL_SELL, strike: 100 }]],
        ["put-credit-spread", [PUT_SELL, { ...PUT_BUY, strike: 100 }]],
        ["put-credit-spread", [PUT_SELL, { ...PUT_BUY, type: "call" }]],
        ["put-credit-spread", [...PUT_SPREAD, PUT_BUY]],
      ];
    for (const [kind, legs] of refusedSets)
      expect(reason(option(kind, legs))).toBe("structure");
  });

  it("gives the knots and the per-share premium of each structure", () => {
    expect(available(longCall, 1).knots).toEqual([0, 100]);
    expect(available(putSpread, 1).knots).toEqual([0, 90, 100]);
    expect(available(putSpread, 1).netPremiumPerShare).toBe(-5);
    expect(available(callSpread, 1).netPremiumPerShare).toBe(5);
    // A strike of 0 is one knot, not two.
    const atZero = available(
      option("cash-secured-put", [
        { premium: 0, side: "sell", strike: 0, type: "put" },
      ]),
      1
    );
    expect(atZero.knots).toEqual([0]);
    expect(atZero.breakevenRanges).toEqual([{ from: 0, to: null }]);
    expect(atZero.breakevens).toEqual([]);
  });

  it("reports numbers beyond the supported range instead of infinite amounts", () => {
    const huge = Number.MAX_VALUE;
    expect(reason(stock(huge), 10)).toBe("range");
    expect(expiryProfit(stock(1), huge, huge)).toBeNull();
    // units x multiplier overflows.
    expect(
      reason(option("long-call", LONG_CALL, { multiplier: huge }), 10)
    ).toBe("range");
    // net premium x multiplier overflows.
    expect(
      reason(
        option("long-call", [{ ...LONG_CALL[0], premium: huge } as LegInput])
      )
    ).toBe("range");
    // The value at the knot 0 overflows: strike x multiplier.
    expect(
      reason(
        option("cash-secured-put", [
          { premium: 0, side: "sell", strike: huge, type: "put" },
        ])
      )
    ).toBe("range");
    // The value at a later knot overflows while the value at 0 is finite: width x multiplier.
    expect(
      reason(
        option("bull-call-spread", [
          { premium: 8, side: "buy", strike: 0, type: "call" },
          { premium: 3, side: "sell", strike: huge, type: "call" },
        ])
      )
    ).toBe("range");
    // The long-call crossing (strike + premium) overflows with a multiplier of 1.
    expect(
      reason(
        option(
          "long-call",
          [{ premium: huge, side: "buy", strike: huge, type: "call" }],
          { multiplier: 1 }
        )
      )
    ).toBe("range");
    // A profit beyond the range at one price gives no value there.
    const call = option("long-call", LONG_CALL, { multiplier: 1e300 });
    expect(reason(call)).toBe("available");
    expect(expiryProfit(call, 1e300, 1)).toBeNull();
  });
});
