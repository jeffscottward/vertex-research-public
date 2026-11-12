import { describe, expect, it } from "vitest";

import {
  GOLIVE_NOT_APPROVABLE_VALUES,
  GOLIVE_QUOTE_MAX_SPREAD_SHARE,
  GOLIVE_QUOTE_SPREAD_FLOOR,
  type GoLiveSizing,
} from "./contracts/golive-drafts.ts";
import { VertexComboInputSchema } from "./contracts/vertex-orders.ts";
import { evaluateFinalOrderGate } from "./server/final-order-gate.ts";
import {
  approvedOrderFitsDraft,
  approvedRoomOf,
  buildCombo,
  exitScheduleOf,
  GOLIVE_ORDER_MAX_QUANTITY,
  GOLIVE_QUOTE_MAX_AGE_MS,
  GOLIVE_QUOTE_MAX_FUTURE_SKEW_MS,
  type GoLiveNotApprovableInput,
  type GoLiveSizingDraft,
  type GoLiveSizingPlan,
  type GoLiveSpread,
  limitFromQuote,
  maxLoss,
  maxLossPerSpread,
  notApprovableReasons,
  orderFor,
  orderSessionDay,
  sameCombo,
  sizeDrafts,
  strikeWidth,
} from "./server/golive-drafts-sizing.ts";

const NOW = new Date("2026-11-12T15:00:00.000Z");
const EXPIRY = "20261218";

const quote = (
  longBid: number,
  longAsk: number,
  shortBid: number,
  shortAsk: number
) => ({ longAsk, longBid, shortAsk, shortBid });

// Long mid 2.35, short mid 1.10: net debit 1.25 on a 5 wide call spread (max loss 125).
const DEBIT_QUOTE = quote(2.3, 2.4, 1.05, 1.15);

const spread = (overrides: Partial<GoLiveSpread> = {}): GoLiveSpread => ({
  expiry: EXPIRY,
  longStrike: 100,
  shortStrike: 105,
  structure: "callDebitVertical",
  symbol: "SPY",
  ...overrides,
});

describe("orderSessionDay", () => {
  const day = (instant: string): string => orderSessionDay(new Date(instant));

  it("is today in New York on a trading day before 16:00", () => {
    // Thursday 2026-11-12: 04:00 (before the open), 09:30 and 15:59 New York time.
    expect(day("2026-11-12T09:00:00Z")).toBe("2026-11-12");
    expect(day("2026-11-12T14:30:00Z")).toBe("2026-11-12");
    expect(day("2026-11-12T20:59:59Z")).toBe("2026-11-12");
    // 00:30 New York time: the UTC date and the New York date are the same day again.
    expect(day("2026-11-12T05:30:00Z")).toBe("2026-11-12");
  });

  it("is the next trading day from 16:00 New York time", () => {
    expect(day("2026-11-12T21:00:00Z")).toBe("2026-11-13");
    // 22:30 New York time on Wednesday: the UTC date is already Thursday.
    expect(day("2026-11-12T03:30:00Z")).toBe("2026-11-12");
    // Friday 16:00 and Friday 23:59 lead to Monday.
    expect(day("2026-11-13T21:00:00Z")).toBe("2026-11-16");
    expect(day("2026-11-14T04:59:00Z")).toBe("2026-11-16");
  });

  it("skips weekends and NYSE holidays", () => {
    // Saturday and Sunday, in the morning.
    expect(day("2026-11-14T15:00:00Z")).toBe("2026-11-16");
    expect(day("2026-11-15T15:00:00Z")).toBe("2026-11-16");
    // Thanksgiving, Thursday 2026-11-26: at 10:00, and from Wednesday's close.
    expect(day("2026-11-26T15:00:00Z")).toBe("2026-11-27");
    expect(day("2026-11-25T21:00:00Z")).toBe("2026-11-27");
    // Good Friday 2026-04-03 before a weekend: Thursday's close leads to Monday.
    expect(day("2026-04-02T20:00:00Z")).toBe("2026-04-06");
    // Christmas on a Friday, then the weekend.
    expect(day("2026-12-24T21:00:00Z")).toBe("2026-12-28");
  });

  it("keeps 16:00 New York time across the daylight saving change", () => {
    // Friday 2026-03-06, winter time (UTC-5): 15:59 is 20:59Z.
    expect(day("2026-03-06T20:59:00Z")).toBe("2026-03-06");
    expect(day("2026-03-06T21:00:00Z")).toBe("2026-03-09");
    // Monday 2026-03-09, summer time (UTC-4): 15:59 is 19:59Z.
    expect(day("2026-03-09T19:59:00Z")).toBe("2026-03-09");
    expect(day("2026-03-09T20:00:00Z")).toBe("2026-03-10");
    // Friday 2026-10-30, summer time; Monday 2026-11-02, winter time again.
    expect(day("2026-10-30T19:59:00Z")).toBe("2026-10-30");
    expect(day("2026-10-30T20:00:00Z")).toBe("2026-11-02");
    expect(day("2026-11-02T20:59:00Z")).toBe("2026-11-02");
    expect(day("2026-11-02T21:00:00Z")).toBe("2026-11-03");
  });
});

describe("buildCombo", () => {
  it("builds two ratio-1 legs of one expiry for each structure", () => {
    expect(buildCombo(spread(), 3, 1.25)).toEqual({
      legs: [
        { expiry: EXPIRY, ratio: 1, right: "C", side: "BUY", strike: 100 },
        { expiry: EXPIRY, ratio: 1, right: "C", side: "SELL", strike: 105 },
      ],
      limitPrice: 1.25,
      quantity: 3,
      symbol: "SPY",
    });
    expect(
      buildCombo(
        spread({
          longStrike: 105,
          shortStrike: 100,
          structure: "putDebitVertical",
        }),
        1,
        2
      ).legs
    ).toEqual([
      { expiry: EXPIRY, ratio: 1, right: "P", side: "BUY", strike: 105 },
      { expiry: EXPIRY, ratio: 1, right: "P", side: "SELL", strike: 100 },
    ]);
    // A credit vertical lists the sold leg first and carries a negative limit.
    expect(
      buildCombo(
        spread({
          longStrike: 95,
          shortStrike: 100,
          structure: "putCreditVertical",
        }),
        2,
        -0.8
      )
    ).toEqual({
      legs: [
        { expiry: EXPIRY, ratio: 1, right: "P", side: "SELL", strike: 100 },
        { expiry: EXPIRY, ratio: 1, right: "P", side: "BUY", strike: 95 },
      ],
      limitPrice: -0.8,
      quantity: 2,
      symbol: "SPY",
    });
    expect(
      buildCombo(
        spread({
          longStrike: 110,
          shortStrike: 105,
          structure: "callCreditVertical",
        }),
        1,
        -1
      ).legs
    ).toEqual([
      { expiry: EXPIRY, ratio: 1, right: "C", side: "SELL", strike: 105 },
      { expiry: EXPIRY, ratio: 1, right: "C", side: "BUY", strike: 110 },
    ]);
  });
});

describe("limitFromQuote", () => {
  it("prices a debit at or below the net mid, rounded down to a cent", () => {
    expect(limitFromQuote("callDebitVertical", DEBIT_QUOTE, 5)).toBe(1.25);
    // Net mid 1.255 -> 1.25.
    expect(
      limitFromQuote("putDebitVertical", quote(2.3, 2.41, 1.05, 1.15), 5)
    ).toBe(1.25);
    // 2.30 - 1.15 is 1.1499999999999999 in binary floats; the limit is still 1.15.
    expect(
      limitFromQuote("callDebitVertical", quote(2.25, 2.35, 1.1, 1.2), 5)
    ).toBe(1.15);
  });

  it("asks a credit at or above the net mid, rounded up to a cent, stored negative", () => {
    // Short mid 1.255, long mid 0.50: net credit 0.755 -> 0.76.
    expect(
      limitFromQuote("putCreditVertical", quote(0.45, 0.55, 1.2, 1.31), 5)
    ).toBe(-0.76);
    expect(
      limitFromQuote("callCreditVertical", quote(1.1, 1.2, 2.25, 2.35), 5)
    ).toBe(-1.15);
  });

  it("refuses a missing or crossed side", () => {
    expect(limitFromQuote("callDebitVertical", null, 5)).toBeNull();
    for (const bad of [
      quote(Number.NaN, 2.4, 1.05, 1.15),
      quote(2.3, Number.POSITIVE_INFINITY, 1.05, 1.15),
      quote(-0.01, 2.4, 1.05, 1.15),
      quote(0, 0, 1.05, 1.15),
      // Crossed: bid above ask.
      quote(2.5, 2.4, 1.05, 1.15),
      quote(2.3, 2.4, 1.2, 1.15),
      quote(2.3, 2.4, 0, 0),
    ])
      expect(limitFromQuote("callDebitVertical", bad, 5)).toBeNull();
  });

  it("refuses a bid of 0 on either leg: nobody bids, so the mid is no price", () => {
    // Long 0/5.00 and short 0/0.05 gave a limit of 2.47 before.
    expect(
      limitFromQuote("callDebitVertical", quote(0, 5, 0, 0.05), 5)
    ).toBeNull();
    for (const structure of [
      "callDebitVertical",
      "putDebitVertical",
      "putCreditVertical",
      "callCreditVertical",
    ] as const)
      for (const bad of [
        quote(0, 2.4, 1.05, 1.15),
        quote(2.3, 2.4, 0, 1.15),
        quote(0, 1.15, 2.3, 2.4),
        quote(1.05, 1.15, 0, 2.4),
      ])
        expect(limitFromQuote(structure, bad, 5)).toBeNull();
    // The smallest bid is a price.
    expect(
      limitFromQuote("callDebitVertical", quote(2.3, 2.4, 0.01, 0.01), 5)
    ).toBe(2.34);
  });

  describe("a wide market", () => {
    // [bid, ask] of one leg next to a tight other leg, as the long and as the short leg.
    const usable = (bid: number, ask: number): boolean[] => [
      limitFromQuote("callDebitVertical", quote(bid, ask, 0.01, 0.01), 500) !==
        null,
      limitFromQuote("putCreditVertical", quote(0.01, 0.01, bid, ask), 500) !==
        null,
    ];

    it("gives no limit when a leg is quoted wider than half of its mid", () => {
      // Long 0.01/5.00 and short 0.01/0.05 gave a limit of 2.47 before: nobody trades at 2.505.
      for (const structure of [
        "callDebitVertical",
        "putDebitVertical",
        "putCreditVertical",
        "callCreditVertical",
      ] as const) {
        expect(
          limitFromQuote(structure, quote(0.01, 5, 0.01, 0.05), 5)
        ).toBeNull();
        expect(
          limitFromQuote(structure, quote(0.01, 0.05, 0.01, 5), 5)
        ).toBeNull();
        // One wide leg is enough, whichever it is.
        expect(
          limitFromQuote(structure, quote(0.01, 5, 2.3, 2.4), 5)
        ).toBeNull();
        expect(
          limitFromQuote(structure, quote(2.3, 2.4, 0.01, 5), 5)
        ).toBeNull();
      }
      expect(usable(0.01, 5)).toEqual([false, false]);
      expect(usable(1, 2)).toEqual([false, false]);
    });

    it("still uses a leg quoted at exactly half of its mid, and not a cent wider", () => {
      // Mid 1.00, width 0.50: exactly the share.
      expect(GOLIVE_QUOTE_MAX_SPREAD_SHARE).toBe(0.5);
      expect(usable(0.75, 1.25)).toEqual([true, true]);
      expect(usable(0.74, 1.25)).toEqual([false, false]);
      expect(usable(0.75, 1.26)).toEqual([false, false]);
      // Mid 0.04, width 0.02 (0.05 - 0.03 is 0.020000000000000004 in binary floats).
      expect(usable(0.03, 0.05)).toEqual([true, true]);
      // Mid 12, width 6.
      expect(usable(9, 15)).toEqual([true, true]);
      expect(usable(8.99, 15)).toEqual([false, false]);
    });

    it("uses a cheap leg that is quoted one tick wide", () => {
      // A cheap leg next to a leg of 2.90/3.00, as the short leg of a debit spread and as the
      // long leg of a credit spread.
      const usableCheap = (bid: number, ask: number): boolean[] => [
        limitFromQuote("callDebitVertical", quote(2.9, 3, bid, ask), 500) !==
          null,
        limitFromQuote("putCreditVertical", quote(bid, ask, 2.9, 3), 500) !==
          null,
      ];
      expect(GOLIVE_QUOTE_SPREAD_FLOOR).toBe(0.05);
      // One 5-cent tick on 0.05/0.10 is more than half of the mid of 0.075, and it is the
      // tightest market such an option can have. The same for one cent on 0.01/0.02.
      expect(usableCheap(0.05, 0.1)).toEqual([true, true]);
      expect(usableCheap(0.01, 0.02)).toEqual([true, true]);
      expect(
        limitFromQuote("callDebitVertical", quote(2.9, 3, 0.05, 0.1), 5)
      ).toBe(2.87);
      // Up to 5 cents wide is usable; one cent more is not.
      expect(usableCheap(0.01, 0.05)).toEqual([true, true]);
      expect(usableCheap(0.01, 0.06)).toEqual([true, true]);
      expect(usableCheap(0.03, 0.06)).toEqual([true, true]);
      expect(usableCheap(0.01, 0.07)).toEqual([false, false]);
      expect(usableCheap(0.05, 0.11)).toEqual([false, false]);
      // Above 5 cents the share of the mid decides: 0.10 wide on a mid of 0.25, and on 0.15.
      expect(usableCheap(0.2, 0.3)).toEqual([true, true]);
      expect(usableCheap(0.1, 0.2)).toEqual([false, false]);
      // The 5 cents do not make a wide market usable: the long leg of 0.01/5.00 still refuses.
      expect(
        limitFromQuote("callDebitVertical", quote(0.01, 5, 0.01, 0.05), 5)
      ).toBeNull();
      expect(usableCheap(0.01, 5)).toEqual([false, false]);
    });

    it("uses markets as they are quoted for liquid options", () => {
      for (const [bid, ask] of [
        [2.9, 3.3],
        [0.6, 0.71],
        [24.68, 24.8],
        [0.76, 0.78],
        [2.16, 2.17],
        [3.83, 3.86],
        // No width at all.
        [1.25, 1.25],
      ] as const)
        expect(usable(bid, ask)).toEqual([true, true]);
    });

    it("sizes nothing on a wide market", () => {
      const [sized] = sizeDrafts(
        PLAN,
        [draft("d1", { quote: quote(0.01, 5, 0.01, 0.05) })],
        50_000
      );
      expect(sized?.sizing).toEqual({
        budget: 1000,
        limitPrice: null,
        maxLoss: null,
        maxLossPctNlv: null,
        maxLossPerSpread: null,
        quantity: 0,
        reason: "no_quote",
      });
    });
  });

  it("refuses a net outside (0, width), before and after rounding", () => {
    // Debit below 0: the long leg is cheaper than the short leg.
    expect(
      limitFromQuote("callDebitVertical", quote(1.05, 1.15, 2.3, 2.4), 5)
    ).toBeNull();
    // Credit below 0.
    expect(
      limitFromQuote("putCreditVertical", quote(2.3, 2.4, 1.05, 1.15), 5)
    ).toBeNull();
    // Net equal to the width, and above it.
    expect(limitFromQuote("callDebitVertical", DEBIT_QUOTE, 1.25)).toBeNull();
    expect(limitFromQuote("callDebitVertical", DEBIT_QUOTE, 1)).toBeNull();
    // Net debit 0.005 rounds down to 0.
    expect(
      limitFromQuote("callDebitVertical", quote(0.02, 0.02, 0.015, 0.015), 5)
    ).toBeNull();
    // Net credit 0.995 on a 1 wide spread rounds up to the width.
    expect(
      limitFromQuote("putCreditVertical", quote(0.01, 0.01, 1, 1.01), 1)
    ).toBeNull();
    // One cent inside the width on each side is a limit.
    expect(
      limitFromQuote("callDebitVertical", quote(1, 1.02, 0.02, 0.02), 1)
    ).toBe(0.99);
    expect(
      limitFromQuote("putCreditVertical", quote(0.02, 0.02, 0.03, 0.03), 1)
    ).toBe(-0.01);
  });
});

describe("maxLoss", () => {
  it("is limit x 100 for a debit and (width - credit) x 100 for a credit", () => {
    expect(maxLossPerSpread("callDebitVertical", 1.25, 5)).toBe(125);
    expect(maxLossPerSpread("putDebitVertical", 0.4, 2.5)).toBe(40);
    expect(maxLossPerSpread("putCreditVertical", -0.76, 5)).toBe(424);
    expect(maxLossPerSpread("callCreditVertical", -1.15, 5)).toBe(385);
    expect(maxLoss("putCreditVertical", -0.76, 5, 4)).toBe(1696);
  });

  it("agrees with the web final order gate", () => {
    const examples: readonly Readonly<{
      draft: GoLiveSpread;
      limitPrice: number;
      quantity: number;
    }>[] = [
      { draft: spread(), limitPrice: 1.25, quantity: 16 },
      {
        draft: spread({
          longStrike: 95,
          shortStrike: 100,
          structure: "putCreditVertical",
        }),
        limitPrice: -0.76,
        quantity: 4,
      },
      {
        draft: spread({
          longStrike: 412.5,
          shortStrike: 410,
          structure: "putDebitVertical",
        }),
        limitPrice: 0.87,
        quantity: 7,
      },
      {
        draft: spread({
          longStrike: 110,
          shortStrike: 105,
          structure: "callCreditVertical",
        }),
        limitPrice: -1.15,
        quantity: 3,
      },
    ];
    for (const { draft, limitPrice, quantity } of examples) {
      const gateMaxLoss = (size: number): number | null =>
        evaluateFinalOrderGate({
          accountValue: 1_000_000,
          jev: null,
          now: NOW,
          order: {
            engine: "test",
            legs: buildCombo(draft, size, limitPrice).legs.map((leg) => ({
              ...leg,
              secType: "OPT",
            })),
            limitPrice,
            quantity: size,
            reason: "test",
            symbol: draft.symbol,
          },
          positions: [],
        }).maxLoss;
      const width = strikeWidth(draft);
      expect(gateMaxLoss(1)).not.toBeNull();
      expect(maxLossPerSpread(draft.structure, limitPrice, width)).toBe(
        gateMaxLoss(1)
      );
      expect(maxLoss(draft.structure, limitPrice, width, quantity)).toBe(
        gateMaxLoss(quantity)
      );
    }
  });
});

// NLV 100,000: position budget 2% = 2,000; sleeve a 3% = 3,000; sleeve b and c 2% = 2,000;
// name cap 2% = 2,000; open risk cap 5% = 5,000.
const NLV = 100_000;
const PLAN: GoLiveSizingPlan = {
  limits: {
    maxPositions: 3,
    nameRiskCapPct: 2,
    openRiskCapPct: 5,
    positionRiskPct: 2,
  },
  sleeves: [
    { budgetPct: 3, key: "a" },
    { budgetPct: 2, key: "b" },
    { budgetPct: 2, key: "c" },
  ],
};

const draft = (
  id: string,
  overrides: Partial<GoLiveSizingDraft> = {}
): GoLiveSizingDraft => ({
  approvedOrder: null,
  entryBasis: "signal_today",
  expiry: EXPIRY,
  id,
  longStrike: 100,
  quote: DEBIT_QUOTE,
  shortStrike: 105,
  sleeveKey: "a",
  state: "proposed",
  structure: "callDebitVertical",
  symbol: "SPY",
  ...overrides,
});

/** An approved draft with the order that was stored at its approval. */
const approvedDraft = (
  id: string,
  quantity: number,
  limitPrice: number,
  overrides: Partial<GoLiveSizingDraft> = {}
): GoLiveSizingDraft => {
  const base = draft(id, { ...overrides, state: "approved" });
  return { ...base, approvedOrder: buildCombo(base, quantity, limitPrice) };
};

// 16 spreads at 125: the whole 2,000 position budget.
const SIZED: GoLiveSizing = {
  budget: 2000,
  limitPrice: 1.25,
  maxLoss: 2000,
  maxLossPctNlv: 2,
  maxLossPerSpread: 125,
  quantity: 16,
  reason: "sized",
};
const unfit = (reason: GoLiveSizing["reason"]): GoLiveSizing => ({
  budget: 2000,
  limitPrice: 1.25,
  maxLoss: null,
  maxLossPctNlv: null,
  maxLossPerSpread: 125,
  quantity: 0,
  reason,
});

const reasons = (
  plan: GoLiveSizingPlan | null,
  drafts: readonly GoLiveSizingDraft[],
  nlv: number | null = NLV
): string[] =>
  sizeDrafts(plan, drafts, nlv).map(
    ({ draft: sized, sizing }) =>
      `${sized.id}:${sizing.reason}:${sizing.quantity}`
  );

describe("sizeDrafts", () => {
  it("sizes one draft to floor(budget / max loss per spread)", () => {
    expect(sizeDrafts(PLAN, [draft("d1")], NLV)).toEqual([
      { draft: draft("d1"), sizing: SIZED },
    ]);
    // Limit 1.30: 15 spreads at 130 = 1,950, not 16.
    const [smaller] = sizeDrafts(
      PLAN,
      [draft("d1", { quote: quote(2.35, 2.45, 1.05, 1.15) })],
      NLV
    );
    expect(smaller?.sizing).toEqual({
      budget: 2000,
      limitPrice: 1.3,
      maxLoss: 1950,
      maxLossPctNlv: 1.95,
      maxLossPerSpread: 130,
      quantity: 15,
      reason: "sized",
    });
  });

  it("gives no size and no legs to a draft whose strikes are the wrong way round", () => {
    // The width has no sign, so each of the first four would be sized as the opposite position.
    const wrong = [
      ["callDebitVertical", 105, 100],
      ["putCreditVertical", 100, 95],
      ["putDebitVertical", 100, 105],
      ["callCreditVertical", 100, 105],
      // Two equal strikes are no vertical.
      ["callDebitVertical", 100, 100],
    ] as const;
    for (const [structure, longStrike, shortStrike] of wrong) {
      const bad = draft("bad", { longStrike, shortStrike, structure });
      const message = `SPY ${structure}: long strike ${longStrike} and short strike ${shortStrike} are the wrong way round`;
      // With and without an account value, and next to a draft that is in order: nothing is
      // returned, so no draft of the call gets a size.
      for (const nlv of [NLV, null])
        expect(() => sizeDrafts(PLAN, [draft("d1"), bad], nlv)).toThrow(
          message
        );
      expect(() => buildCombo({ ...bad, expiry: EXPIRY }, 1, 1.25)).toThrow(
        message
      );
    }
  });

  it("shows no money value, and never 0, when the account value is unavailable", () => {
    for (const nlv of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const sized = sizeDrafts(
        PLAN,
        [draft("d1"), draft("d2", { quote: null })],
        nlv
      );
      expect(sized.map((entry) => entry.sizing)).toEqual(
        Array.from({ length: 2 }, () => ({
          budget: null,
          limitPrice: null,
          maxLoss: null,
          maxLossPctNlv: null,
          maxLossPerSpread: null,
          quantity: 0,
          reason: "nlv_unavailable",
        }))
      );
    }
  });

  it("gives quantity 0 with no_quote when there is no usable quote", () => {
    const sized = sizeDrafts(
      PLAN,
      [
        draft("d1", { quote: null }),
        draft("d2", { quote: quote(2.5, 2.4, 1.05, 1.15) }),
      ],
      NLV
    );
    for (const entry of sized)
      expect(entry.sizing).toEqual({
        budget: 2000,
        limitPrice: null,
        maxLoss: null,
        maxLossPctNlv: null,
        maxLossPerSpread: null,
        quantity: 0,
        reason: "no_quote",
      });
  });

  it("gives quantity 0 when the budget is below one spread", () => {
    // Net debit 25 on a 50 wide spread: 2,500 per spread against a 2,000 budget.
    const [wide] = sizeDrafts(
      PLAN,
      [
        draft("d1", {
          quote: quote(39.9, 40.1, 14.9, 15.1),
          shortStrike: 150,
        }),
      ],
      NLV
    );
    expect(wide?.sizing).toEqual({
      budget: 2000,
      limitPrice: 25,
      maxLoss: null,
      maxLossPctNlv: null,
      maxLossPerSpread: 2500,
      quantity: 0,
      reason: "budget_below_one_spread",
    });
    // No plan: no budget.
    const [noPlan] = sizeDrafts(null, [draft("d1")], NLV);
    expect(noPlan?.sizing).toMatchObject({
      budget: 0,
      quantity: 0,
      reason: "budget_below_one_spread",
    });
  });

  it("stops at the sleeve budget", () => {
    const sized = sizeDrafts(
      PLAN,
      [draft("d2", { symbol: "QQQ" }), draft("d1", { symbol: "IWM" })],
      NLV
    );
    // Sorted by symbol: IWM takes 2,000 of the 3,000 sleeve budget; QQQ does not fit whole.
    expect(sized.map((entry) => entry.sizing)).toEqual([
      unfit("sleeve_budget_used"),
      SIZED,
    ]);
    // A sleeve that is not in the plan has no budget, and is sized after the plan's sleeves.
    expect(
      reasons(PLAN, [draft("d1", { sleeveKey: "zz" }), draft("d2")])
    ).toEqual(["d1:sleeve_budget_used:0", "d2:sized:16"]);
  });

  it("stops at the name cap", () => {
    expect(
      reasons(PLAN, [draft("d1", { sleeveKey: "b" }), draft("d2")])
    ).toEqual(["d1:name_cap_reached:0", "d2:sized:16"]);
  });

  it("stops at the open risk cap", () => {
    expect(
      reasons(PLAN, [
        draft("d1", { sleeveKey: "c", symbol: "IWM" }),
        draft("d2", { sleeveKey: "b", symbol: "QQQ" }),
        draft("d3"),
      ])
    ).toEqual(["d1:open_risk_cap_reached:0", "d2:sized:16", "d3:sized:16"]);
  });

  it("stops at the position count", () => {
    const plan = { ...PLAN, limits: { ...PLAN.limits, maxPositions: 1 } };
    expect(
      reasons(plan, [
        draft("d1", { sleeveKey: "b", symbol: "QQQ" }),
        draft("d2"),
      ])
    ).toEqual(["d1:max_positions_reached:0", "d2:sized:16"]);
  });

  it("gives an approved draft the room of its stored order, before every other draft", () => {
    expect(
      reasons(PLAN, [
        draft("d1", { symbol: "IWM" }),
        approvedDraft("d2", 16, 1.25, { symbol: "QQQ" }),
      ])
    ).toEqual(["d1:sleeve_budget_used:0", "d2:sized:16"]);
  });

  describe("an approved draft after the account value fell", () => {
    // Approved at NLV 50,000 (budget 1,000) on long 2.40/2.50, short 0.95/1.00: limit 1.47,
    // 147 per spread, 6 spreads, max loss 882.
    const APPROVED_QUOTE = quote(2.4, 2.5, 0.95, 1);
    const approved = approvedDraft("a1", 6, 1.47, { quote: APPROVED_QUOTE });
    // Every cap is 10% of the account value: 1,000 at NLV 10,000.
    const plan: GoLiveSizingPlan = {
      limits: {
        maxPositions: 3,
        nameRiskCapPct: 10,
        openRiskCapPct: 10,
        positionRiskPct: 2,
      },
      sleeves: [
        { budgetPct: 10, key: "a" },
        { budgetPct: 10, key: "b" },
      ],
    };
    // One spread of 125 at NLV 10,000 (budget 200): 882 + 125 = 1,007 is above 1,000.
    const other = (overrides: Partial<GoLiveSizingDraft>) =>
      draft("p1", overrides);

    it("was sized to 6 spreads and 882 when it was approved", () => {
      const [then] = sizeDrafts(
        plan,
        [draft("a1", { quote: APPROVED_QUOTE })],
        50_000
      );
      expect(then?.sizing).toEqual({
        budget: 1000,
        limitPrice: 1.47,
        maxLoss: 882,
        maxLossPctNlv: 1.76,
        maxLossPerSpread: 147,
        quantity: 6,
        reason: "sized",
      });
    });

    it("still counts its approved 882 in the sleeve, the name and the open risk at NLV 10,000", () => {
      expect(
        reasons(plan, [approved, other({ symbol: "QQQ" })], 10_000)
      ).toEqual(["a1:sized:1", "p1:sleeve_budget_used:0"]);
      expect(
        reasons(plan, [approved, other({ sleeveKey: "b" })], 10_000)
      ).toEqual(["a1:sized:1", "p1:name_cap_reached:0"]);
      expect(
        reasons(
          plan,
          [approved, other({ sleeveKey: "b", symbol: "QQQ" })],
          10_000
        )
      ).toEqual(["a1:sized:1", "p1:open_risk_cap_reached:0"]);
      // 882 + 125 fits under 1,007.00 and not under 1,006.99: the room is 882 to the cent.
      expect(
        reasons(plan, [approved, other({ symbol: "QQQ" })], 10_070)
      ).toEqual(["a1:sized:1", "p1:sized:1"]);
      expect(
        reasons(plan, [approved, other({ symbol: "QQQ" })], 10_069.9)
      ).toEqual(["a1:sized:1", "p1:sleeve_budget_used:0"]);
    });

    it("shows today's size of the approved draft without changing its room", () => {
      const [now] = sizeDrafts(plan, [approved], 10_000);
      // What the position budget of 200 buys today. The room is still the approved 882.
      expect(now?.sizing).toEqual({
        budget: 200,
        limitPrice: 1.47,
        maxLoss: 147,
        maxLossPctNlv: 1.47,
        maxLossPerSpread: 147,
        quantity: 1,
        reason: "sized",
      });
    });

    it("reports the room it holds: the approved 882, as a share of the account value now", () => {
      expect(approvedRoomOf(approved, 50_000)).toEqual({
        maxLoss: 882,
        maxLossPctNlv: 1.76,
      });
      // The amount does not move with the account value; its share does.
      expect(approvedRoomOf(approved, 10_000)).toEqual({
        maxLoss: 882,
        maxLossPctNlv: 8.82,
      });
      expect(approvedRoomOf(approved, 7000)).toEqual({
        maxLoss: 882,
        maxLossPctNlv: 12.6,
      });
      // Without a quote today, too: the room comes from the stored order.
      expect(approvedRoomOf({ ...approved, quote: null }, 10_000)).toEqual({
        maxLoss: 882,
        maxLossPctNlv: 8.82,
      });
      // A credit order: 3 x (5 - 2.06) x 100.
      expect(
        approvedRoomOf(
          approvedDraft("a2", 3, -2.06, {
            longStrike: 95,
            shortStrike: 100,
            structure: "putCreditVertical",
          }),
          10_000
        )
      ).toEqual({ maxLoss: 882, maxLossPctNlv: 8.82 });
      // No account value: the amount is known, its share is not. Never 0 and never infinite.
      for (const nlv of [
        null,
        0,
        -5,
        0.004,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ])
        expect(approvedRoomOf(approved, nlv)).toEqual({
          maxLoss: 882,
          maxLossPctNlv: null,
        });
    });

    it("reports no room for a draft that is not approved, and refuses a wrong stored order", () => {
      for (const state of ["proposed", "rejected", "expired"] as const)
        expect(
          approvedRoomOf(draft("d1", { quote: APPROVED_QUOTE, state }), 10_000)
        ).toBeNull();
      // An order that is not the order of the draft gives no room that can be trusted.
      expect(() =>
        approvedRoomOf({ ...approved, approvedOrder: null }, 10_000)
      ).toThrow(
        "The stored approved order of draft a1 is not the order of that draft"
      );
    });

    it("still holds its position slot at NLV 7,000, where one spread is above the budget", () => {
      // No money cap can refuse here: only the position count is left.
      const onePosition: GoLiveSizingPlan = {
        limits: {
          maxPositions: 1,
          nameRiskCapPct: 100,
          openRiskCapPct: 100,
          positionRiskPct: 2,
        },
        sleeves: [
          { budgetPct: 100, key: "a" },
          { budgetPct: 100, key: "b" },
        ],
      };
      // Budget 140: the approved draft's own size today is 0, and the other draft costs 125.
      expect(
        reasons(
          onePosition,
          [approved, other({ sleeveKey: "b", symbol: "QQQ" })],
          7000
        )
      ).toEqual(["a1:budget_below_one_spread:0", "p1:max_positions_reached:0"]);
      // Without the approved draft the other one is sized.
      expect(
        reasons(onePosition, [other({ sleeveKey: "b", symbol: "QQQ" })], 7000)
      ).toEqual(["p1:sized:1"]);
    });

    it("holds its room without a quote today, and from a credit order", () => {
      expect(
        reasons(
          plan,
          [{ ...approved, quote: null }, other({ symbol: "QQQ" })],
          10_000
        )
      ).toEqual(["a1:no_quote:0", "p1:sleeve_budget_used:0"]);
      // A 5 wide put credit spread approved as 3 x (5 - 2.06) x 100 = 882.
      const credit = approvedDraft("a2", 3, -2.06, {
        longStrike: 95,
        quote: null,
        shortStrike: 100,
        structure: "putCreditVertical",
      });
      expect(reasons(plan, [credit, other({ symbol: "QQQ" })], 10_070)).toEqual(
        ["a2:no_quote:0", "p1:sized:1"]
      );
      expect(
        reasons(plan, [credit, other({ symbol: "QQQ" })], 10_069.9)
      ).toEqual(["a2:no_quote:0", "p1:sleeve_budget_used:0"]);
    });

    it("refuses to size a day with an approved draft whose stored order is not its order", () => {
      const order = buildCombo(approved, 6, 1.47);
      const [buy, sell] = order.legs;
      if (buy === undefined || sell === undefined)
        throw new Error("Expected two legs");
      const wrong: readonly GoLiveSizingDraft["approvedOrder"][] = [
        null,
        { ...order, symbol: "QQQ" },
        { ...order, legs: [sell, buy] },
        { ...order, legs: [buy, { ...sell, strike: 106 }] },
        { ...order, legs: [buy, { ...sell, expiry: "20270115" }] },
        // A debit order with a credit limit, a limit of the whole width, a limit that is not
        // whole cents, and a quantity no order can hold.
        { ...order, limitPrice: -1.47 },
        { ...order, limitPrice: 5 },
        { ...order, limitPrice: 1.475 },
        { ...order, quantity: 0 },
        { ...order, quantity: 1.5 },
        { ...order, quantity: GOLIVE_ORDER_MAX_QUANTITY + 1 },
      ];
      for (const approvedOrder of wrong) {
        const bad = { ...approved, approvedOrder };
        expect(approvedOrderFitsDraft(bad, approvedOrder)).toBe(false);
        // With and without an account value: no draft of the call gets a size.
        for (const nlv of [10_000, null])
          expect(() => sizeDrafts(plan, [draft("d1"), bad], nlv)).toThrow(
            "The stored approved order of draft a1 is not the order of that draft"
          );
      }
      expect(approvedOrderFitsDraft(approved, order)).toBe(true);
      // A draft with wrong strikes has no order to compare with: false, without an error.
      expect(
        approvedOrderFitsDraft(
          { ...approved, longStrike: 105, shortStrike: 100 },
          order
        )
      ).toBe(false);
      // Only an approved draft holds an order to check.
      expect(() => sizeDrafts(plan, [draft("d1")], 10_000)).not.toThrow();
    });
  });

  it("gives quantity 0 when the budget buys more spreads than one order may hold", () => {
    // The number is the combo order's own limit, not a copy of it.
    const order = buildCombo(spread(), GOLIVE_ORDER_MAX_QUANTITY, 1.25);
    expect(VertexComboInputSchema.safeParse(order).success).toBe(true);
    expect(
      VertexComboInputSchema.safeParse({
        ...order,
        quantity: GOLIVE_ORDER_MAX_QUANTITY + 1,
      }).success
    ).toBe(false);
    // A penny spread: long mid 0.025, short mid 0.01, limit 0.01, 1 per spread. At NLV 600,000
    // the budget of 12,000 buys 12,000 spreads.
    const penny = draft("d1", { quote: quote(0.02, 0.03, 0.01, 0.01) });
    const both = [penny, draft("d2", { symbol: "QQQ" })];
    const sizing = sizeDrafts(PLAN, both, 600_000)[0]?.sizing;
    expect(sizing).toEqual({
      budget: 12_000,
      limitPrice: 0.01,
      maxLoss: null,
      maxLossPctNlv: null,
      maxLossPerSpread: 1,
      quantity: 0,
      reason: "quantity_above_order_limit",
    });
    expect(
      sizing === undefined ? "none" : orderFor(spread(), sizing)
    ).toBeNull();
    // It uses no room: the next draft of the sleeve is sized.
    expect(reasons(PLAN, both, 600_000)).toEqual([
      "d1:quantity_above_order_limit:0",
      "d2:sized:96",
    ]);
    // Exactly the limit is an order: budget 10,000 at NLV 500,000.
    expect(reasons(PLAN, [penny], 500_000)).toEqual([
      `d1:sized:${GOLIVE_ORDER_MAX_QUANTITY}`,
    ]);
    expect(reasons(PLAN, [penny], 500_050)).toEqual([
      "d1:quantity_above_order_limit:0",
    ]);
  });

  it("gives no cap room to a late entry, which can never be approved", () => {
    const onePosition = {
      ...PLAN,
      limits: { ...PLAN.limits, maxPositions: 1 },
    };
    const late = draft("d1", {
      entryBasis: "model_holds_account_does_not",
      symbol: "AAA",
    });
    // AAA sorts before SPY. The account does not hold it, so it takes no slot from SPY.
    expect(reasons(onePosition, [late, draft("d2")])).toEqual([
      "d1:sized:16",
      "d2:sized:16",
    ]);
    // Nor sleeve, name or open-risk room: every signal_today draft is sized as without it.
    const lateOnes = ["SPY", "QQQ", "IWM"].map((symbol, index) =>
      draft(`late-${index}`, {
        entryBasis: "model_holds_account_does_not",
        symbol,
      })
    );
    const wanted = [
      draft("d2"),
      draft("d3", { sleeveKey: "b", symbol: "QQQ" }),
    ];
    expect(reasons(PLAN, wanted)).toEqual(["d2:sized:16", "d3:sized:16"]);
    expect(reasons(PLAN, [...lateOnes, ...wanted])).toEqual([
      "late-0:sized:16",
      "late-1:sized:16",
      "late-2:sized:16",
      "d2:sized:16",
      "d3:sized:16",
    ]);
  });

  describe("cents", () => {
    const cents = (value: number | null): number => {
      if (value === null) throw new Error("Expected a money value");
      return Math.round(value * 100);
    };

    it("rounds the budget down to the cent", () => {
      const one = { ...PLAN, limits: { ...PLAN.limits, positionRiskPct: 1 } };
      // 1% of 99,999.60 is 999.996: the budget is 999.99, and 8 spreads of 125 do not fit.
      const [sized] = sizeDrafts(one, [draft("d1")], 99_999.6);
      expect(sized?.sizing).toMatchObject({
        budget: 999.99,
        maxLoss: 875,
        quantity: 7,
        reason: "sized",
      });
      expect(sizeDrafts(one, [draft("d1")], 100_000)[0]?.sizing).toMatchObject({
        budget: 1000,
        maxLoss: 1000,
        quantity: 8,
      });
    });

    it("never lets the max loss pass the budget by a cent", () => {
      // 20,000 per spread (debit 200 on a 500 wide spread) against a budget of 39,999.99.
      const wide = draft("d1", {
        quote: quote(299.9, 300.1, 99.9, 100.1),
        shortStrike: 600,
      });
      const plan: GoLiveSizingPlan = {
        limits: {
          maxPositions: 3,
          nameRiskCapPct: 100,
          openRiskCapPct: 100,
          positionRiskPct: 2,
        },
        sleeves: [{ budgetPct: 100, key: "a" }],
      };
      const [below] = sizeDrafts(plan, [wide], 1_999_999.5);
      expect(below?.sizing).toMatchObject({
        budget: 39_999.99,
        maxLoss: 20_000,
        maxLossPerSpread: 20_000,
        quantity: 1,
        reason: "sized",
      });
      const [exact] = sizeDrafts(plan, [wide], 2_000_000);
      expect(exact?.sizing).toMatchObject({
        budget: 40_000,
        maxLoss: 40_000,
        quantity: 2,
      });
    });

    it("names the cap that is passed by one cent", () => {
      // Two drafts of 2,000 each. Sleeve budget and open risk cap of 4% hold exactly both.
      const plan: GoLiveSizingPlan = {
        limits: {
          maxPositions: 3,
          nameRiskCapPct: 2,
          openRiskCapPct: 4,
          positionRiskPct: 2,
        },
        sleeves: [{ budgetPct: 4, key: "a" }],
      };
      // SPY is sized before XLE (by symbol).
      const two = [draft("d1"), draft("d2", { symbol: "XLE" })];
      expect(reasons(plan, two, 100_000)).toEqual([
        "d1:sized:16",
        "d2:sized:16",
      ]);
      // 3.99999% of 100,000 is 3,999.99.
      const open = {
        ...plan,
        limits: { ...plan.limits, openRiskCapPct: 3.999_99 },
      };
      expect(reasons(open, two, 100_000)).toEqual([
        "d1:sized:16",
        "d2:open_risk_cap_reached:0",
      ]);
      const sleeve = { ...plan, sleeves: [{ budgetPct: 3.999_99, key: "a" }] };
      expect(reasons(sleeve, two, 100_000)).toEqual([
        "d1:sized:16",
        "d2:sleeve_budget_used:0",
      ]);
    });

    it("keeps every max loss within the budget and every cap, over a grid", () => {
      // Percentages in tenths of a percent and account values in cents, so the test checks
      // with whole numbers: loss in cents x 1000 <= NLV in cents x tenths of a percent.
      const within = (lossCents: number, nlvCents: number, tenths: number) =>
        lossCents * 1000 <= nlvCents * tenths;
      const quotes = [
        DEBIT_QUOTE,
        quote(2.4, 2.5, 0.95, 1),
        quote(0.02, 0.03, 0.01, 0.01),
        quote(4.31, 4.37, 0.11, 0.13),
        quote(299.9, 300.1, 99.9, 100.1),
        quote(0.07, 0.09, 0.02, 0.03),
      ];
      const creditQuotes = [
        quote(0.45, 0.55, 1.2, 1.31),
        quote(0.02, 0.03, 4.9, 4.96),
        quote(1.1, 1.2, 2.25, 2.35),
      ];
      const symbols = ["SPY", "QQQ", "IWM"] as const;
      const nlvCentsList = [
        700_000, 1_000_000, 1_006_990, 5_000_000, 9_999_960, 10_000_000,
        12_345_678, 60_000_000, 199_999_950, 333_333_333,
      ];
      let sizedCount = 0;
      for (const nlvCents of nlvCentsList)
        for (const position of [5, 10, 13, 20])
          for (const cap of [position, 2 * position, 37]) {
            const plan: GoLiveSizingPlan = {
              limits: {
                maxPositions: 4,
                nameRiskCapPct: cap / 10,
                openRiskCapPct: (2 * cap) / 10,
                positionRiskPct: position / 10,
              },
              sleeves: [
                { budgetPct: (cap + 3) / 10, key: "a" },
                { budgetPct: cap / 10, key: "b" },
              ],
            };
            const drafts: GoLiveSizingDraft[] = [
              approvedDraft("a0", 6, 1.47, { quote: quote(2.4, 2.5, 0.95, 1) }),
              ...quotes.map((entry, index) =>
                draft(`d${index}`, {
                  quote: entry,
                  shortStrike: index === 4 ? 600 : 105,
                  sleeveKey: index % 2 === 0 ? "a" : "b",
                  symbol: symbols[index % 3] ?? "SPY",
                })
              ),
              ...creditQuotes.map((entry, index) =>
                draft(`c${index}`, {
                  longStrike: 95,
                  quote: entry,
                  shortStrike: 100,
                  sleeveKey: index % 2 === 0 ? "b" : "a",
                  structure: "putCreditVertical",
                  symbol: symbols[(index + 1) % 3] ?? "SPY",
                })
              ),
            ];
            // The approved draft (sleeve a, SPY) holds 882 whatever is sized for it today.
            let open = 88_200;
            let positions = 1;
            const bySleeve = new Map([["a", 88_200]]);
            const byName = new Map([["SPY", 88_200]]);
            for (const { draft: one, sizing } of sizeDrafts(
              plan,
              drafts,
              nlvCents / 100
            )) {
              const budgetCents = cents(sizing.budget);
              // The budget is the share rounded down to the cent: not above, and not a cent less.
              expect(within(budgetCents, nlvCents, position)).toBe(true);
              expect(within(budgetCents + 1, nlvCents, position)).toBe(false);
              if (sizing.maxLoss === null) {
                expect(sizing.quantity).toBe(0);
                continue;
              }
              sizedCount += 1;
              const perSpread = cents(sizing.maxLossPerSpread);
              const loss = cents(sizing.maxLoss);
              expect(loss).toBe(sizing.quantity * perSpread);
              expect(loss).toBeLessThanOrEqual(budgetCents);
              // One more spread would not fit the budget.
              expect(loss + perSpread).toBeGreaterThan(budgetCents);
              expect(sizing.quantity).toBeLessThanOrEqual(
                GOLIVE_ORDER_MAX_QUANTITY
              );
              if (one.state !== "proposed") continue;
              open += loss;
              positions += 1;
              const inSleeve = (bySleeve.get(one.sleeveKey) ?? 0) + loss;
              const inName = (byName.get(one.symbol) ?? 0) + loss;
              bySleeve.set(one.sleeveKey, inSleeve);
              byName.set(one.symbol, inName);
              const sleeveTenths = one.sleeveKey === "a" ? cap + 3 : cap;
              expect(within(inSleeve, nlvCents, sleeveTenths)).toBe(true);
              expect(within(inName, nlvCents, cap)).toBe(true);
              expect(within(open, nlvCents, 2 * cap)).toBe(true);
              expect(positions).toBeLessThanOrEqual(4);
            }
          }
      // The grid does size drafts: the checks above ran.
      expect(sizedCount).toBeGreaterThan(200);
    });
  });

  it("sizes rejected and expired drafts alone, without using cap room", () => {
    expect(
      reasons(PLAN, [
        draft("d1", { state: "rejected", symbol: "AAA" }),
        draft("d2", { state: "expired", symbol: "AAB" }),
        draft("d3", { symbol: "IWM" }),
      ])
    ).toEqual(["d1:sized:16", "d2:sized:16", "d3:sized:16"]);
  });

  it("breaks a tie on sleeve and symbol by id and keeps the given order", () => {
    // Two drafts of one name: the lower id is sized first, whatever the input order.
    for (const ids of [
      ["d1", "d2", "d0"],
      ["d2", "d0", "d1"],
      ["d0", "d1", "d2"],
    ])
      expect(
        reasons(
          PLAN,
          ids.map((id) => draft(id))
        ).sort()
      ).toEqual([
        "d0:sized:16",
        "d1:sleeve_budget_used:0",
        "d2:sleeve_budget_used:0",
      ]);
    expect(
      sizeDrafts(PLAN, [draft("d2"), draft("d0"), draft("d1")], NLV).map(
        (entry) => entry.draft.id
      )
    ).toEqual(["d2", "d0", "d1"]);
  });
});

describe("orderFor", () => {
  it("is the exact combo of a sized draft and null for quantity 0", () => {
    expect(orderFor(spread(), SIZED)).toEqual(buildCombo(spread(), 16, 1.25));
    expect(
      orderFor(spread(), {
        ...SIZED,
        maxLoss: null,
        maxLossPctNlv: null,
        quantity: 0,
        reason: "name_cap_reached",
      })
    ).toBeNull();
  });
});

describe("sameCombo", () => {
  it("accepts only the same symbol, quantity, limit and legs", () => {
    const order = buildCombo(spread(), 16, 1.25);
    const [first, second] = order.legs;
    if (first === undefined || second === undefined)
      throw new Error("Expected two legs");
    expect(sameCombo(order, buildCombo(spread(), 16, 1.25))).toBe(true);
    for (const other of [
      null,
      { ...order, limitPrice: 1.26 },
      { ...order, limitPrice: 1.24 },
      { ...order, quantity: 17 },
      { ...order, quantity: 15 },
      { ...order, symbol: "QQQ" },
      { ...order, legs: [first] },
      { ...order, legs: [first, second, second] },
      { ...order, legs: [second, first] },
      { ...order, legs: [{ ...first, expiry: "20270115" }, second] },
      { ...order, legs: [{ ...first, strike: 101 }, second] },
      { ...order, legs: [{ ...first, right: "P" as const }, second] },
      { ...order, legs: [first, { ...second, side: "BUY" as const }] },
      { ...order, legs: [first, { ...second, ratio: 2 }] },
    ])
      expect(sameCombo(order, other)).toBe(false);
  });
});

describe("notApprovableReasons", () => {
  const approvable = (
    overrides: Partial<GoLiveNotApprovableInput> = {},
    draftOverrides: Partial<GoLiveNotApprovableInput["draft"]> = {}
  ): GoLiveNotApprovableInput => ({
    draft: {
      entryBasis: "signal_today",
      planId: "plan",
      planVersion: 2,
      quote: { asOf: new Date(NOW.getTime() - 30_000), source: "ibkr_live" },
      state: "proposed",
      ...draftOverrides,
    },
    nlv: NLV,
    now: NOW,
    plan: { id: "plan", status: "approved", version: 2 },
    quantity: 16,
    webFinalGate: "allow",
    ...overrides,
  });
  const at = (ageMs: number) => ({
    asOf: new Date(NOW.getTime() - ageMs),
    source: "ibkr_live" as const,
  });

  it("is empty for a proposed, sized draft of the approved plan with a live quote", () => {
    expect(notApprovableReasons(approvable())).toEqual([]);
    // Exactly 120 s old and 60 s ahead are still live.
    expect(
      notApprovableReasons(
        approvable({}, { quote: at(GOLIVE_QUOTE_MAX_AGE_MS) })
      )
    ).toEqual([]);
    expect(
      notApprovableReasons(
        approvable({}, { quote: at(-GOLIVE_QUOTE_MAX_FUTURE_SKEW_MS) })
      )
    ).toEqual([]);
  });

  it("names each cause", () => {
    const cases: readonly (readonly [GoLiveNotApprovableInput, string[]])[] = [
      [approvable({ plan: null }), ["PLAN_NOT_APPROVED"]],
      [
        approvable({ plan: { id: "plan", status: "proposed", version: 2 } }),
        ["PLAN_NOT_APPROVED"],
      ],
      [
        approvable({ plan: { id: "plan", status: "retired", version: 2 } }),
        ["PLAN_NOT_APPROVED"],
      ],
      // The draft belongs to another plan or to an older version of the plan in force.
      [
        approvable({ plan: { id: "other", status: "approved", version: 2 } }),
        ["PLAN_NOT_APPROVED"],
      ],
      [
        approvable({ plan: { id: "plan", status: "approved", version: 3 } }),
        ["PLAN_NOT_APPROVED"],
      ],
      [
        approvable({}, { entryBasis: "model_holds_account_does_not" }),
        ["LATE_ENTRY_NOT_TESTED"],
      ],
      [approvable({}, { quote: null }), ["NO_LIVE_IBKR_QUOTE"]],
      [
        approvable(
          {},
          { quote: { asOf: NOW, source: "yahoo_delayed_snapshot" } }
        ),
        ["NO_LIVE_IBKR_QUOTE"],
      ],
      [
        approvable({}, { quote: { asOf: NOW, source: "model" } }),
        ["NO_LIVE_IBKR_QUOTE"],
      ],
      [
        approvable({}, { quote: at(GOLIVE_QUOTE_MAX_AGE_MS + 1) }),
        ["NO_LIVE_IBKR_QUOTE"],
      ],
      [approvable({}, { quote: at(-60_001) }), ["NO_LIVE_IBKR_QUOTE"]],
      [approvable({ nlv: null }), ["NLV_UNAVAILABLE"]],
      [approvable({ quantity: 0, webFinalGate: null }), ["SIZED_TO_ZERO"]],
      [approvable({ webFinalGate: "deny" }), ["PRECHECK_DENIED"]],
      [approvable({}, { state: "approved" }), ["DRAFT_NOT_PROPOSED"]],
      [approvable({}, { state: "rejected" }), ["DRAFT_NOT_PROPOSED"]],
      [
        approvable({}, { state: "expired" }),
        ["DRAFT_NOT_PROPOSED", "DRAFT_EXPIRED"],
      ],
    ];
    for (const [input, expected] of cases)
      expect(notApprovableReasons(input)).toEqual(expected);
  });

  it("lists every cause at once, in the contract's order", () => {
    expect(
      notApprovableReasons(
        approvable(
          { nlv: null, plan: null, quantity: 0, webFinalGate: "deny" },
          {
            entryBasis: "model_holds_account_does_not",
            quote: null,
            state: "expired",
          }
        )
      )
    ).toEqual([...GOLIVE_NOT_APPROVABLE_VALUES]);
  });
});

describe("exitScheduleOf (owner_standing_rule_v1)", () => {
  const order = {
    legs: [
      { expiry: "20261218", ratio: 1, right: "C", side: "BUY", strike: 600 },
      { expiry: "20261218", ratio: 1, right: "C", side: "SELL", strike: 610 },
    ],
    limitPrice: 2.5,
    quantity: 3,
    symbol: "SPY",
  } as const;

  it("closes a loser 3 trading days before expiry and a winner at 15:45 New York time", () => {
    expect(
      exitScheduleOf({
        approvedOrder: order,
        expiry: "20261218",
        kind: "entry",
        state: "approved",
      })
    ).toEqual({
      closeOrder: {
        legs: [
          {
            expiry: "20261218",
            ratio: 1,
            right: "C",
            side: "SELL",
            strike: 600,
          },
          {
            expiry: "20261218",
            ratio: 1,
            right: "C",
            side: "BUY",
            strike: 610,
          },
        ],
        quantity: 3,
        symbol: "SPY",
      },
      loserCloseDay: "2026-12-15",
      winnerCloseAt: new Date("2026-12-18T20:45:00.000Z"),
    });
  });

  it("skips NYSE holidays and follows daylight saving time", () => {
    // 2026-06-19 (Juneteenth) is closed; the Thursday expiry counts back over Mon-Wed.
    const schedule = exitScheduleOf({
      approvedOrder: order,
      expiry: "20260618",
      kind: "entry",
      state: "approved",
    });
    expect(schedule?.loserCloseDay).toBe("2026-06-15");
    expect(schedule?.winnerCloseAt).toEqual(
      new Date("2026-06-18T19:45:00.000Z")
    );
    // Over a holiday: 2026-11-26 (Thanksgiving) is skipped for a 2026-11-30 expiry.
    expect(
      exitScheduleOf({
        approvedOrder: order,
        expiry: "20261130",
        kind: "entry",
        state: "approved",
      })?.loserCloseDay
    ).toBe("2026-11-24");
  });

  it("is null unless the draft is an approved entry with its order", () => {
    for (const draft of [
      { approvedOrder: order, kind: "exit", state: "approved" },
      { approvedOrder: order, kind: "entry", state: "proposed" },
      { approvedOrder: null, kind: "entry", state: "approved" },
    ] as const)
      expect(exitScheduleOf({ ...draft, expiry: "20261218" })).toBeNull();
  });
});
