import { readFileSync } from "node:fs";
import {
  GOLIVE_DRAFT_STATE_VALUES,
  GOLIVE_EXIT_REASON_VALUES,
  GOLIVE_EXIT_RULE,
  GOLIVE_NODE_BADGE_VALUES,
  GOLIVE_NOT_APPROVABLE_VALUES,
  GOLIVE_QUOTE_SOURCE_VALUES,
  GOLIVE_SIZING_REASON_VALUES,
  GOLIVE_STRUCTURE_VALUES,
  type GoLiveDraftOutput,
  type GoLivePlanOutput,
  type GoLiveQueueOutput,
  GoLiveQueueOutputSchema,
  VertexFinalGateSchema,
} from "@darkfactory/api";

import { describe, expect, it } from "vitest";

import {
  APPROVAL_NOT_SENT_SENTENCE,
  APPROVED_ORDER_NOT_STORED,
  accountText,
  apiErrorText,
  approveBlockers,
  approvedOrderView,
  CURRENT_SIZING_LABEL,
  currentSizingText,
  DRAFT_STATE_WORDS,
  decisionErrorText,
  decisionText,
  draftGroupOf,
  ENGINE_POLICY_LINE,
  ENTRY_SIGNAL_GROUP_TITLE,
  EXIT_GROUP_TITLE,
  EXIT_REASON_WORDS,
  EXIT_RULE_WORDS,
  etClock,
  etDayClock,
  expiryDate,
  generatorText,
  groupDrafts,
  isConflict,
  JEV_STANCE_WORDS,
  JEV_STATE_WORDS,
  keyedLines,
  limitText,
  MARKET_NOTES_WORDS,
  MODEL_HOLDS_GROUP_TITLE,
  maxLossText,
  NO_ENTRY_BASIS_REASON,
  NO_ENTRY_SIGNAL_TEXT,
  NO_ORDERS_NOTICE,
  NO_ORDERS_NOTICE_PARTS,
  NO_PLAN_TEXT,
  NO_SIZED_ORDER_REASON,
  NODE_BADGE_WORDS,
  NODE_DISARMED_NOTE,
  NOT_APPROVABLE_WORDS,
  nodeText,
  noLiveQuoteReason,
  noteText,
  ORDER_TICKET_TAB_LABEL,
  ORDER_TICKET_TAB_VALUE,
  OTHER_GROUP_TITLE,
  OWNER_ONLY_DECISION_TEXT,
  orderLegLines,
  orderSummaryRows,
  PORTFOLIO_HREF,
  PRECHECK_DECISION_WORDS,
  planLimitRows,
  planStatusText,
  planTitle,
  preCheckView,
  QUOTE_SOURCE_WORDS,
  quantityText,
  quoteText,
  REJECT_NOTE_REQUIRED,
  REJECTION_RECORD_SENTENCE,
  SIGNED_OUT_TEXT,
  SIZING_REASON_WORDS,
  STRUCTURE_WORDS,
  safeHttpsUrl,
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
  approvedOrder: null,
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
    ["exit rule", [GOLIVE_EXIT_RULE], EXIT_RULE_WORDS],
    [
      "pre-check decision",
      VertexFinalGateSchema.shape.decision.options,
      PRECHECK_DECISION_WORDS,
    ],
    [
      "JEV stance",
      VertexFinalGateSchema.shape.jevStance.unwrap().options,
      JEV_STANCE_WORDS,
    ],
    [
      "JEV state",
      VertexFinalGateSchema.shape.jevState.options,
      JEV_STATE_WORDS,
    ],
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
      unknown: "Node state unknown: the node status could not be read",
    });
    expect(NODE_DISARMED_NOTE).toBe(
      "A disarmed node does not stop an order placed on the Portfolio order screen; only the kill switch does."
    );
    expect(DRAFT_STATE_WORDS).toEqual({
      approved: "Approved (recorded). Not sent: this page sends no orders.",
      expired: "Expired: the generator no longer wants this draft",
      proposed: "Proposed by the generator, not decided",
      rejected: "Rejected by the owner (recorded)",
    });
    expect(NOT_APPROVABLE_WORDS).toMatchObject({
      LATE_ENTRY_NOT_TESTED: "Late entry is not in the backtest",
      NO_LIVE_IBKR_QUOTE: "No live IBKR quote",
      PLAN_NOT_APPROVED: "The plan is not approved",
      PRECHECK_DENIED: "The dry pre-check (web final gate) denied the order",
    });
    expect(EXIT_RULE_WORDS[GOLIVE_EXIT_RULE]).toBe(
      "Owner exit rule (nothing here closes a position; you close it): let winners run to expiry; close losers 3 trading days before expiry; close open winners at 15:45 ET on expiry day."
    );
    expect(EXIT_REASON_WORDS).toEqual({
      loser_3_trading_days_before_expiry:
        "Proposal to close: losing position, 3 trading days before expiry",
      monthly_roll: "Proposal to close the old spread: monthly roll",
      winner_expiry_day_1545_et:
        "Proposal to close: open winner, 15:45 ET on expiry day",
    });
    expect(NO_ORDERS_NOTICE).toBe(
      "This page sends no orders. Approve records your decision and places nothing. To place an order yourself, open Portfolio and use the Vertex orders tab."
    );
    expect(NO_ORDERS_NOTICE_PARTS.link).toBe("Portfolio");
    expect(PORTFOLIO_HREF).toBe("/portfolio?tab=orders");
  });

  it("names the Portfolio tab that holds the order ticket, as portfolio-tabs.tsx defines it", () => {
    // The tab list is not exported, so the source is read: a renamed tab fails here.
    const source = readFileSync(
      new URL("portfolio-tabs.tsx", import.meta.url),
      "utf8"
    );
    const tab =
      /value: "([^"]+)",\s*label: "([^"]+)",\s*content: <VertexOrders\b/u.exec(
        source
      );
    expect(tab?.[1]).toBe(ORDER_TICKET_TAB_VALUE);
    expect(tab?.[2]).toBe(ORDER_TICKET_TAB_LABEL);
    expect(ORDER_TICKET_TAB_LABEL).toBe("Vertex orders");
    expect(NO_ORDERS_NOTICE).toContain(`the ${ORDER_TICKET_TAB_LABEL} tab`);
    expect(NO_ORDERS_NOTICE).not.toContain("Orders & stops");
    expect(PORTFOLIO_HREF).toBe(`/portfolio?tab=${ORDER_TICKET_TAB_VALUE}`);
    expect(MARKET_NOTES_WORDS).toEqual({
      attached: "Market notes: attached to the drafts",
      feature_not_deployed: "Market notes: the feature is not deployed",
      none_active: "Market notes: none active",
    });
    expect(ENGINE_POLICY_LINE).toBe(
      "Engine policy (arm_gate): not part of the web order path; not evaluated here."
    );
  });

  it("has no sentence that says or suggests this page sent, staged or will send an order", () => {
    const sentences = [
      NO_ORDERS_NOTICE,
      APPROVAL_NOT_SENT_SENTENCE,
      REJECTION_RECORD_SENTENCE,
      NODE_DISARMED_NOTE,
      ENGINE_POLICY_LINE,
      NO_PLAN_TEXT,
      NO_ENTRY_SIGNAL_TEXT,
      ENTRY_SIGNAL_GROUP_TITLE,
      MODEL_HOLDS_GROUP_TITLE,
      EXIT_GROUP_TITLE,
      OTHER_GROUP_TITLE,
      NO_SIZED_ORDER_REASON,
      NO_ENTRY_BASIS_REASON,
      OWNER_ONLY_DECISION_TEXT,
      REJECT_NOTE_REQUIRED,
      SIGNED_OUT_TEXT,
      CURRENT_SIZING_LABEL,
      APPROVED_ORDER_NOT_STORED,
      ...[
        STRUCTURE_WORDS,
        QUOTE_SOURCE_WORDS,
        SIZING_REASON_WORDS,
        NOT_APPROVABLE_WORDS,
        NODE_BADGE_WORDS,
        DRAFT_STATE_WORDS,
        MARKET_NOTES_WORDS,
        EXIT_REASON_WORDS,
        EXIT_RULE_WORDS,
        JEV_STATE_WORDS,
      ].flatMap((words) => Object.values<string>(words)),
    ];
    // The only allowed uses of these verbs are the denials below.
    const denials = [
      "This page sends no orders.",
      "this page sends no orders.",
      "It does not send the order.",
      "Not sent:",
    ];
    for (const sentence of sentences) {
      const rest = denials.reduce(
        (text, denial) => text.replaceAll(denial, ""),
        sentence
      );
      expect(rest).not.toMatch(
        /\b(?:sent|sends?|sending|staged?|staging|submit(?:s|ted)?|queued|routed|transmit\w*|will be placed|was placed|is placed|filled|executed)\b/iu
      );
    }
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
      modelHolds: [late],
      other: [noBasis],
    });
    expect(groupDrafts([])).toEqual({
      entrySignal: [],
      exits: [],
      modelHolds: [],
      other: [],
    });
    expect(OTHER_GROUP_TITLE).toBe("Other drafts (cannot be approved)");
  });

  it("puts a draft with a kind or entry basis this build does not know in the other group", () => {
    const unknownBasis = {
      entryBasis: "new_basis",
      kind: "entry",
    } as unknown as GoLiveDraftOutput;
    const unknownKind = {
      entryBasis: null,
      kind: "roll",
    } as unknown as GoLiveDraftOutput;
    expect(draftGroupOf(unknownBasis)).toBe("other");
    expect(draftGroupOf(unknownKind)).toBe("other");
  });

  it("blocks Approve in every group whose heading says it cannot be approved", () => {
    // The server listed no blocker: the page still does not offer Approve under such a heading.
    const late = draft({ entryBasis: "model_holds_account_does_not" });
    expect(approveBlockers(late)).toEqual([
      "Late entry is not in the backtest",
    ]);
    expect(
      approveBlockers({ ...late, notApprovable: ["LATE_ENTRY_NOT_TESTED"] })
    ).toEqual(["Late entry is not in the backtest"]);
    expect(approveBlockers(draft({ entryBasis: null }))).toEqual([
      NO_ENTRY_BASIS_REASON,
    ]);
    for (const entry of [late, draft({ entryBasis: null })])
      expect(
        draftGroupOf(entry) === "entrySignal" || draftGroupOf(entry) === "exits"
      ).toBe(false);
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
    expect(quoteText(null)).toBe("No quote: none was recorded for this draft");
    expect(quoteText({ ...quote, source: "ibkr_live" })).toBe(
      "IBKR live, as of 2026-11-11 10:30 ET"
    );
    expect(quoteText({ ...quote, source: "yahoo_delayed_snapshot" })).toBe(
      "Yahoo, 15 min delayed, indicative, as of 2026-11-11 10:30 ET"
    );
    expect(quoteText({ ...quote, source: "model" })).toBe(
      "model price, indicative, as of 2026-11-11 10:30 ET"
    );
    // 03:30Z is still the evening before in New York: the date is the New York date.
    expect(
      quoteText({
        ...quote,
        asOf: new Date("2026-11-11T03:30:00.000Z"),
        source: "ibkr_live",
      })
    ).toBe("IBKR live, as of 2026-11-10 22:30 ET");
  });

  it("gives the missing live quote a cause for each quote source", () => {
    const quote = {
      asOf: AT,
      longAsk: 5,
      longBid: 4.9,
      shortAsk: 2.7,
      shortBid: 2.6,
    };
    const reasons = [
      noLiveQuoteReason(null),
      ...GOLIVE_QUOTE_SOURCE_VALUES.map((source) =>
        noLiveQuoteReason({ ...quote, source })
      ),
    ];
    expect(reasons).toEqual([
      "No live IBKR quote: no quote was recorded for this draft",
      "No live IBKR quote: the IBKR quote shown is too old to count as live",
      "No live IBKR quote: the price shown is a Yahoo snapshot, delayed 15 minutes",
      "No live IBKR quote: the price shown is a model price, not a market quote",
    ]);
    expect(new Set(reasons).size).toBe(reasons.length);
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
      decision:
        "Dry pre-check (web final gate): not run, because there is no sized order to check.",
      enginePolicy: ENGINE_POLICY_LINE,
      reasons: [],
      stance: null,
    });
    expect(
      preCheckView({
        enginePolicy: "not_evaluated_not_in_web_order_path",
        webFinalGate: {
          decision: "allow",
          jevStance: "BULLISH",
          jevState: "fresh",
          maxLoss: 470,
          maxLossPct: 0.47,
          reasons: [],
          structure: "debit-vertical",
        },
      })
    ).toEqual({
      decision:
        "Dry pre-check (web final gate; positions, kill switch and options-only gate not included): allow. Not a clearance to send.",
      enginePolicy: ENGINE_POLICY_LINE,
      reasons: [],
      stance: "JEV stance used by the check: bullish (the JEV read is fresh)",
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
      decision:
        "Dry pre-check (web final gate; positions, kill switch and options-only gate not included): deny. Not a clearance to send.",
      enginePolicy: ENGINE_POLICY_LINE,
      reasons: ["Max loss 2.4% is above 2%", "JEV is stale"],
      stance: "JEV stance used by the check: none (the JEV read is stale)",
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
    expect(approveBlockers(draft())).toEqual([]);
    expect(approveBlockers(draft({ order: null }))).toEqual([
      NO_SIZED_ORDER_REASON,
    ]);
    expect(
      approveBlockers(
        draft({
          entryBasis: "model_holds_account_does_not",
          notApprovable: ["LATE_ENTRY_NOT_TESTED", "NO_LIVE_IBKR_QUOTE"],
          order: null,
        })
      )
    ).toEqual([
      "Late entry is not in the backtest",
      "No live IBKR quote: no quote was recorded for this draft",
    ]);
    expect(
      approveBlockers(
        draft({ notApprovable: [...GOLIVE_NOT_APPROVABLE_VALUES] })
      )
    ).toEqual(
      GOLIVE_NOT_APPROVABLE_VALUES.map((value) =>
        value === "NO_LIVE_IBKR_QUOTE"
          ? "No live IBKR quote: no quote was recorded for this draft"
          : NOT_APPROVABLE_WORDS[value]
      )
    );
  });

  it("shows the stored approved order apart from the current sizing", () => {
    expect(approvedOrderView(draft())).toBeNull();
    expect(
      approvedOrderView(draft({ decidedAt: AT, state: "rejected" }))
    ).toBeNull();
    expect(
      approvedOrderView(
        draft({ approvedOrder: ORDER, decidedAt: AT, state: "approved" })
      )
    ).toEqual({
      label: "Approved order (recorded 2026-11-11 10:30 ET)",
      legs: orderLegLines(ORDER),
      missing: null,
      rows: [
        { label: "Quantity", value: "2" },
        { label: "Limit", value: "debit 2.35" },
      ],
    });
    expect(
      approvedOrderView(draft({ decidedAt: null, state: "approved" }))
    ).toEqual({
      label: "Approved order (recorded time not recorded)",
      legs: [],
      missing: APPROVED_ORDER_NOT_STORED,
      rows: [],
    });
    expect(CURRENT_SIZING_LABEL).toBe(
      "Current indicative sizing (recomputed now; not the approved order)"
    );
    expect(currentSizingText(draft().sizing)).toBe(
      "limit debit 2.35; quantity 2 (sized from the plan's risk per position); max loss $470.00 (0.47% of account)"
    );
  });

  it("gives equal lines different keys", () => {
    expect(keyedLines(["a", "b", "a"])).toEqual([
      { key: "1:a", text: "a" },
      { key: "1:b", text: "b" },
      { key: "2:a", text: "a" },
    ]);
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

  it("says plainly that the session has ended on UNAUTHORIZED", () => {
    const error = Object.assign(new Error("Authentication required"), {
      code: "UNAUTHORIZED",
    });
    expect(apiErrorText(error)).toBe(
      "You are signed out: the session has ended. Sign in again."
    );
    expect(decisionErrorText(error, null)).toBe(
      "You are signed out: the session has ended. Sign in again. Nothing was recorded."
    );
  });
});

describe("decisionErrorText", () => {
  it.each(GOLIVE_NOT_APPROVABLE_VALUES)(
    "puts the blocker %s in words, never as a code",
    (code) => {
      const text = decisionErrorText(
        new Error(`Draft cannot be approved: ${code}`),
        null
      );
      expect(text).not.toContain(code);
      expect(text).not.toMatch(/[A-Z]{3,}_[A-Z_]+/u);
      expect(text.startsWith("The draft cannot be approved: ")).toBe(true);
    }
  );

  it("uses the same words as the row, with the cause of the quote blocker", () => {
    expect(
      decisionErrorText(
        new Error(
          "Draft cannot be approved: PRECHECK_DENIED, NO_LIVE_IBKR_QUOTE"
        ),
        {
          asOf: AT,
          longAsk: 5,
          longBid: 4.9,
          shortAsk: 2.7,
          shortBid: 2.6,
          source: "model",
        }
      )
    ).toBe(
      "The draft cannot be approved: the dry pre-check (web final gate) denied the order; no live IBKR quote: the price shown is a model price, not a market quote."
    );
  });

  it("leaves a message without a blocker code unchanged", () => {
    expect(
      decisionErrorText(new Error("The draft is no longer proposed"), null)
    ).toBe("The draft is no longer proposed");
  });

  it("knows a CONFLICT by its code", () => {
    expect(
      isConflict(Object.assign(new Error("x"), { code: "CONFLICT" }))
    ).toBe(true);
    expect(isConflict(new Error("CONFLICT"))).toBe(false);
    expect(isConflict(null)).toBe(false);
  });
});

describe("plan links", () => {
  it("accepts only an absolute https URL", () => {
    expect(safeHttpsUrl("https://example.com/evidence")).toBe(
      "https://example.com/evidence"
    );
    for (const value of [
      null,
      "http://example.com/evidence",
      "javascript:alert(1)",
      "data:text/html,x",
      "/relative",
      "//example.com/x",
      "not a url",
    ])
      expect(safeHttpsUrl(value)).toBeNull();
  });
});
