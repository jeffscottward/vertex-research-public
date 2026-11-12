import {
  GOLIVE_DRAFT_STATE_VALUES,
  GOLIVE_EXIT_REASON_VALUES,
  GOLIVE_NODE_BADGE_VALUES,
  GOLIVE_NOT_APPROVABLE_VALUES,
  GOLIVE_QUOTE_SOURCE_VALUES,
  GOLIVE_SIZING_REASON_VALUES,
  GOLIVE_STRUCTURE_VALUES,
  type GoLiveDraftOutput,
  type GoLivePlanOutput,
  type GoLiveQueueOutput,
  GoLiveQueueOutputSchema,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  accountText,
  apiErrorText,
  approveBlockers,
  DRAFT_STATE_WORDS,
  decisionText,
  ENGINE_POLICY_LINE,
  EXIT_REASON_WORDS,
  etClock,
  etDayClock,
  expiryDate,
  generatorText,
  groupDrafts,
  limitText,
  MARKET_NOTES_WORDS,
  maxLossText,
  NO_SIZED_ORDER_REASON,
  NODE_BADGE_WORDS,
  NOT_APPROVABLE_WORDS,
  nodeText,
  noteText,
  orderLegLines,
  orderSummaryRows,
  planLimitRows,
  planStatusText,
  planTitle,
  preCheckView,
  QUOTE_SOURCE_WORDS,
  quantityText,
  quoteText,
  SIZING_REASON_WORDS,
  STRUCTURE_WORDS,
  sleeveRow,
  strikesText,
} from "./golive-draft-queue-model.ts";

// 2026-11-11 is in standard time: 15:30Z is 10:30 in New York.
const AT = new Date("2026-11-11T15:30:00.000Z");

const ORDER = {
  legs: [
    {
      expiry: "20261218",
      ratio: 1,
      right: "C" as const,
      side: "BUY" as const,
      strike: 450,
    },
    {
      expiry: "20261218",
      ratio: 1,
      right: "P" as const,
      side: "SELL" as const,
      strike: 455.5,
    },
  ],
  limitPrice: 2.35,
  quantity: 2,
  symbol: "SPY",
};

const draft = (
  overrides: Partial<GoLiveDraftOutput> = {}
): GoLiveDraftOutput => ({
  createdAt: AT,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  entryBasis: "signal_today",
  exitReason: null,
  exitRule: "owner_standing_rule_v1",
  expiry: "20261218",
  id: "draft-1",
  kind: "entry",
  longStrike: 450,
  nodeBadgeAtDecision: null,
  notApprovable: [],
  notes: [],
  order: ORDER,
  parentDraftId: null,
  planId: "plan-1",
  planVersion: 1,
  preCheck: {
    enginePolicy: "not_evaluated_not_in_web_order_path",
    webFinalGate: null,
  },
  quote: null,
  shortStrike: 455,
  signalFacts: [],
  sizing: {
    budget: 2000,
    limitPrice: 2.35,
    maxLoss: 470,
    maxLossPctNlv: 0.47,
    maxLossPerSpread: 235,
    quantity: 2,
    reason: "sized",
  },
  sleeveKey: "trend",
  state: "proposed",
  structure: "callDebitVertical",
  symbol: "SPY",
  tradingDay: "2026-11-11",
  updatedAt: AT,
  ...overrides,
});

const plan = (overrides: Partial<GoLivePlanOutput> = {}): GoLivePlanOutput => ({
  approvalBasis: "owner_decision",
  approvedAt: AT,
  approvedBy: "owner",
  createdAt: AT,
  evidenceUrl: null,
  exitRule: "owner_standing_rule_v1",
  id: "plan-1",
  limits: {
    maxPositions: 6,
    nameRiskCapPct: 2,
    openRiskCapPct: 7.5,
    positionRiskPct: 1.25,
  },
  name: "Go-live allocation",
  ownerMessageUrl: "https://discord.com/channels/1/2/3",
  retiredAt: null,
  sleeves: [
    {
      anchorDelta: 0.5,
      budgetPct: 4,
      definitionNote: "Entry rule always true.",
      definitionVariant: "always_on_entry",
      dteMin: 20,
      dteTarget: 35,
      key: "trend",
      name: "Trend verticals",
      runKey: "trend-v1",
      structure: "putCreditVertical",
      symbols: ["SPY", "QQQ"],
      widthSigma: 1,
    },
  ],
  status: "approved",
  updatedAt: AT,
  version: 3,
  ...overrides,
});

describe("wording maps", () => {
  it.each([
    ["structure", GOLIVE_STRUCTURE_VALUES, STRUCTURE_WORDS],
    ["quote source", GOLIVE_QUOTE_SOURCE_VALUES, QUOTE_SOURCE_WORDS],
    ["sizing reason", GOLIVE_SIZING_REASON_VALUES, SIZING_REASON_WORDS],
    ["not approvable", GOLIVE_NOT_APPROVABLE_VALUES, NOT_APPROVABLE_WORDS],
    ["node badge", GOLIVE_NODE_BADGE_VALUES, NODE_BADGE_WORDS],
    ["draft state", GOLIVE_DRAFT_STATE_VALUES, DRAFT_STATE_WORDS],
    ["exit reason", GOLIVE_EXIT_REASON_VALUES, EXIT_REASON_WORDS],
    [
      "market notes",
      GoLiveQueueOutputSchema.shape.marketNotes.options,
      MARKET_NOTES_WORDS,
    ],
  ] as const)(
    "has distinct words for every %s value and no other key",
    (_name, values, words) => {
      const map: Readonly<Record<string, string>> = words;
      expect(Object.keys(map).sort()).toEqual([...values].sort());
      const texts = values.map((value) => map[value]);
      expect(new Set(texts).size).toBe(values.length);
      for (const text of texts) expect(text).toMatch(/\S/u);
      expect(Object.isFrozen(words)).toBe(true);
    }
  );

  it("uses the agreed words", () => {
    expect(STRUCTURE_WORDS).toEqual({
      callCreditVertical: "Call credit vertical (bear call spread)",
      callDebitVertical: "Call debit vertical (bull call spread)",
      putCreditVertical: "Put credit vertical (bull put spread)",
      putDebitVertical: "Put debit vertical (bear put spread)",
    });
    expect(QUOTE_SOURCE_WORDS).toEqual({
      ibkr_live: "IBKR live",
      model: "model price, indicative",
      yahoo_delayed_snapshot: "Yahoo, 15 min delayed, indicative",
    });
    expect(NODE_BADGE_WORDS).toEqual({
      down: "Node down",
      "running-armed": "Node running, armed",
      "running-disarmed": "Node running, disarmed",
      unknown: "Node state not readable",
    });
    expect(DRAFT_STATE_WORDS).toEqual({
      approved: "Approved (recorded). Not sent: this page sends no orders.",
      expired: "Expired",
      proposed: "Proposed",
      rejected: "Rejected",
    });
    expect(NOT_APPROVABLE_WORDS).toMatchObject({
      LATE_ENTRY_NOT_TESTED: "Late entry is not in the backtest",
      NO_LIVE_IBKR_QUOTE: "No live IBKR quote: the price shown is delayed",
      PLAN_NOT_APPROVED: "The plan is not approved",
    });
    expect(MARKET_NOTES_WORDS).toEqual({
      attached: "Market notes: attached to the drafts",
      feature_not_deployed: "Market notes: the feature is not deployed",
      none_active: "Market notes: none active",
    });
    expect(ENGINE_POLICY_LINE).toBe(
      "Engine policy (arm_gate): not part of the web order path; not evaluated here."
    );
  });

  it("marks every quote source that is not live as indicative", () => {
    for (const source of GOLIVE_QUOTE_SOURCE_VALUES)
      expect(QUOTE_SOURCE_WORDS[source].includes("indicative")).toBe(
        source !== "ibkr_live"
      );
  });
});

describe("time and expiry", () => {
  it("formats New York wall clock time", () => {
    expect(etClock(AT)).toBe("10:30 ET");
    // 03:10Z on the 12th is still the evening of the 11th in New York.
    expect(etDayClock(new Date("2026-11-12T03:10:00.000Z"))).toBe(
      "2026-11-11 22:10 ET"
    );
  });

  it("shows a YYYYMMDD expiry as a date and leaves other text unchanged", () => {
    expect(expiryDate("20261218")).toBe("2026-12-18");
    expect(expiryDate("Dec 18")).toBe("Dec 18");
  });
});

describe("plan", () => {
  it("names the plan with its version", () =>
    expect(planTitle(plan())).toBe("Go-live allocation (version 3)"));

  it.each([
    ["proposed", null, "Plan not approved"],
    ["retired", "owner_decision", "Plan retired"],
    ["approved", "owner_decision", "Plan approved by the owner"],
    [
      "approved",
      "owner_delegation",
      "Plan approved by delegation (the owner delegated the allocation choice)",
    ],
    ["approved", null, "Plan marked approved, approval basis not recorded"],
  ] as const)("says %s with basis %s as %s", (status, approvalBasis, text) =>
    expect(planStatusText({ approvalBasis, status })).toBe(text)
  );

  it("lists the limits as percents of the account", () =>
    expect(planLimitRows(plan().limits)).toEqual([
      { label: "Risk per position", value: "1.25% of the account" },
      { label: "Open risk cap", value: "7.50% of the account" },
      { label: "Per-name cap", value: "2% of the account" },
      { label: "Max positions", value: "6" },
    ]));

  it("describes a sleeve in words", () => {
    const [sleeve] = plan().sleeves;
    if (sleeve === undefined) throw new Error("fixture has one sleeve");
    expect(sleeveRow(sleeve)).toEqual({
      budget: "4% of the account",
      key: "trend",
      name: "Trend verticals",
      note: "Entry rule always true.",
      structure: "Put credit vertical (bull put spread)",
      symbols: "SPY, QQQ",
    });
  });
});

describe("status row", () => {
  it("shows the account value with its time", () =>
    expect(
      accountText({
        asOf: AT,
        netLiquidation: 100_000,
        unavailableReason: null,
      })
    ).toBe("Account value: $100,000 as of 10:30 ET"));

  it("says when the account value has no time", () =>
    expect(
      accountText({
        asOf: null,
        netLiquidation: 100_000,
        unavailableReason: null,
      })
    ).toBe("Account value: $100,000 (time not reported)"));

  it("never shows a missing account value as 0", () => {
    const account = { asOf: null, netLiquidation: null };
    expect(
      accountText({ ...account, unavailableReason: "monitor stale" })
    ).toBe("Account value not available: monitor stale");
    expect(accountText({ ...account, unavailableReason: null })).toBe(
      "Account value not available: no reason reported"
    );
  });

  it("says the node state with its check time", () =>
    expect(
      nodeText({ armedAt: null, badge: "running-disarmed", checkedAt: AT })
    ).toBe("Node running, disarmed (checked 10:30 ET)"));

  it("says what the generator reported", () => {
    const queue: Pick<
      GoLiveQueueOutput,
      "drafts" | "generatedAt" | "tradingDay"
    > = { drafts: [draft()], generatedAt: AT, tradingDay: "2026-11-11" };
    expect(generatorText(queue)).toBe("Generator ran at 10:30 ET: 1 draft");
    expect(generatorText({ ...queue, drafts: [] })).toBe(
      "Generator ran at 10:30 ET: 0 drafts"
    );
    expect(generatorText({ ...queue, generatedAt: null })).toBe(
      "Generator has not reported for 2026-11-11"
    );
  });
});

describe("drafts", () => {
  it("groups by entry basis and puts exit drafts in their own group", () => {
    const signal = draft({ id: "signal" });
    const late = draft({
      entryBasis: "model_holds_account_does_not",
      id: "late",
    });
    const noBasis = draft({ entryBasis: null, id: "no-basis" });
    const exit = draft({
      entryBasis: null,
      exitReason: "monthly_roll",
      id: "exit",
      kind: "exit",
    });
    expect(groupDrafts([exit, late, signal, noBasis])).toEqual({
      entrySignal: [signal],
      exits: [exit],
      modelHolds: [late, noBasis],
    });
    expect(groupDrafts([])).toEqual({
      entrySignal: [],
      exits: [],
      modelHolds: [],
    });
  });

  it("writes strikes as long / short", () =>
    expect(strikesText({ longStrike: 450, shortStrike: 455.5 })).toBe(
      "long 450.00 / short 455.50"
    ));

  it("names the quote source with its time", () => {
    const quote = {
      asOf: AT,
      longAsk: 5,
      longBid: 4.9,
      shortAsk: 2.7,
      shortBid: 2.6,
    };
    expect(quoteText(null)).toBe("No quote");
    expect(quoteText({ ...quote, source: "ibkr_live" })).toBe(
      "IBKR live, as of 10:30 ET"
    );
    expect(quoteText({ ...quote, source: "yahoo_delayed_snapshot" })).toBe(
      "Yahoo, 15 min delayed, indicative, as of 10:30 ET"
    );
    expect(quoteText({ ...quote, source: "model" })).toBe(
      "model price, indicative, as of 10:30 ET"
    );
  });

  it("writes the limit as a debit, a credit or no limit", () => {
    expect(limitText(2.35)).toBe("debit 2.35");
    expect(limitText(-1.1)).toBe("credit 1.10");
    expect(limitText(null)).toBe("no limit: no quote");
  });

  it.each(GOLIVE_SIZING_REASON_VALUES)(
    "shows quantity 0 with the reason %s",
    (reason) =>
      expect(quantityText({ quantity: 0, reason })).toBe(
        `0 (${SIZING_REASON_WORDS[reason]})`
      )
  );

  it("shows a sized quantity with its reason", () =>
    expect(quantityText({ quantity: 2, reason: "sized" })).toBe(
      "2 (sized from the plan's risk per position)"
    ));

  it("writes max loss in dollars and percent of the account, or why it is missing", () => {
    expect(
      maxLossText({ maxLoss: 470, maxLossPctNlv: 0.47, reason: "sized" })
    ).toBe("$470.00 (0.47% of account)");
    expect(
      maxLossText({ maxLoss: 470, maxLossPctNlv: null, reason: "sized" })
    ).toBe(
      "$470.00 (% of account not available: the account value is not available)"
    );
    expect(
      maxLossText({ maxLoss: null, maxLossPctNlv: null, reason: "no_quote" })
    ).toBe("not available: there is no quote");
    expect(
      maxLossText({ maxLoss: null, maxLossPctNlv: null, reason: "sized" })
    ).toBe("not available: no max loss was computed");
  });

  it("repeats the web final gate decision and its reasons verbatim", () => {
    expect(
      preCheckView({
        enginePolicy: "not_evaluated_not_in_web_order_path",
        webFinalGate: null,
      })
    ).toEqual({
      decision: "Web final gate: not run (no sized order to check)",
      enginePolicy: ENGINE_POLICY_LINE,
      reasons: [],
    });
    expect(
      preCheckView({
        enginePolicy: "not_evaluated_not_in_web_order_path",
        webFinalGate: {
          decision: "deny",
          jevStance: null,
          jevState: "stale",
          maxLoss: 470,
          maxLossPct: 2.4,
          reasons: ["Max loss 2.4% is above 2%", "JEV is stale"],
          structure: "debit-vertical",
        },
      })
    ).toEqual({
      decision: "Web final gate: deny",
      enginePolicy: ENGINE_POLICY_LINE,
      reasons: ["Max loss 2.4% is above 2%", "JEV is stale"],
    });
  });

  it("labels a market note that is not verified", () => {
    const note = { id: "n1", stance: "bullish", theme: "Breadth thrust" };
    expect(noteText({ ...note, verified: true })).toBe(
      "Breadth thrust: bullish"
    );
    expect(noteText({ ...note, verified: false })).toBe(
      "Breadth thrust: bullish (unverified)"
    );
  });

  it("writes the decision time and who decided", () => {
    expect(decisionText({ decidedAt: null, decidedBy: "owner" })).toBeNull();
    expect(decisionText({ decidedAt: AT, decidedBy: null })).toBe(
      "Decided 2026-11-11 10:30 ET"
    );
    expect(decisionText({ decidedAt: AT, decidedBy: "owner" })).toBe(
      "Decided 2026-11-11 10:30 ET by owner"
    );
  });

  it("lists why a draft cannot be approved", () => {
    expect(approveBlockers({ notApprovable: [], order: ORDER })).toEqual([]);
    expect(approveBlockers({ notApprovable: [], order: null })).toEqual([
      NO_SIZED_ORDER_REASON,
    ]);
    expect(
      approveBlockers({
        notApprovable: ["LATE_ENTRY_NOT_TESTED", "NO_LIVE_IBKR_QUOTE"],
        order: null,
      })
    ).toEqual([
      "Late entry is not in the backtest",
      "No live IBKR quote: the price shown is delayed",
    ]);
    expect(
      approveBlockers({
        notApprovable: [...GOLIVE_NOT_APPROVABLE_VALUES],
        order: ORDER,
      })
    ).toEqual(
      GOLIVE_NOT_APPROVABLE_VALUES.map((value) => NOT_APPROVABLE_WORDS[value])
    );
  });

  it("repeats the exact order for the confirm dialog", () => {
    expect(orderLegLines(ORDER)).toEqual([
      "BUY 1 SPY 2026-12-18 450.00 call",
      "SELL 1 SPY 2026-12-18 455.50 put",
    ]);
    expect(orderSummaryRows(ORDER, draft().sizing)).toEqual([
      { label: "Quantity", value: "2" },
      { label: "Limit", value: "debit 2.35" },
      { label: "Max loss", value: "$470.00 (0.47% of account)" },
    ]);
  });
});

describe("apiErrorText", () => {
  it("uses the API message when there is one", () => {
    expect(apiErrorText(new Error("  Draft order changed.  "))).toBe(
      "Draft order changed."
    );
    expect(apiErrorText({ message: "Not the owner" })).toBe("Not the owner");
  });

  it.each([[new Error("  ")], [{ message: 42 }], [null], ["offline"]])(
    "falls back to plain words for %j",
    (error) => expect(apiErrorText(error)).toBe("The request failed.")
  );
});
