import { describe, expect, it } from "vitest";

import {
  GOLIVE_NOT_APPROVABLE_VALUES,
  type GoLiveSizing,
} from "./contracts/golive-drafts.ts";
import { evaluateFinalOrderGate } from "./server/final-order-gate.ts";
import {
  buildCombo,
  GOLIVE_QUOTE_MAX_AGE_MS,
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
      limitFromQuote("callDebitVertical", quote(0, 0.03, 0, 0.02), 5)
    ).toBeNull();
    // Net credit 0.995 on a 1 wide spread rounds up to the width.
    expect(
      limitFromQuote("putCreditVertical", quote(0, 0.02, 1, 1.01), 1)
    ).toBeNull();
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

  it("shows no money value, and never 0, when the account value is unavailable", () => {
    for (const nlv of [null, 0, -5]) {
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

  it("sizes approved drafts first so they keep their room", () => {
    expect(
      reasons(PLAN, [
        draft("d1", { symbol: "IWM" }),
        draft("d2", { state: "approved", symbol: "QQQ" }),
      ])
    ).toEqual(["d1:sleeve_budget_used:0", "d2:sized:16"]);
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
      notApprovableReasons(approvable({}, { quote: at(-60_000) }))
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
