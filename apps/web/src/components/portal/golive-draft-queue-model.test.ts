import { readdirSync, readFileSync } from "node:fs";
import {
  AGENT_OPS_API_ERRORS,
  GOLIVE_DRAFT_STATE_VALUES,
  GOLIVE_EXIT_REASON_VALUES,
  GOLIVE_EXIT_RULE,
  GOLIVE_NODE_BADGE_VALUES,
  GOLIVE_NOT_APPROVABLE_VALUES,
  GOLIVE_QUOTE_MAX_SPREAD_SHARE,
  GOLIVE_QUOTE_SOURCE_VALUES,
  GOLIVE_QUOTE_SPREAD_FLOOR,
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
  APPROVED_ORDER_NOT_SHOWN,
  accountText,
  approveBlockers,
  approvedOrderView,
  CURRENT_PRECHECK_LABEL,
  CURRENT_QUOTE_LABEL,
  CURRENT_SIZING_LABEL,
  canSendApproved,
  currentSizingText,
  DRAFT_STATE_WORDS,
  decisionAftermathText,
  decisionFailure,
  decisionText,
  draftGroupOf,
  draftStateText,
  draftsTitle,
  ENGINE_POLICY_LINE,
  EXIT_GROUP_TITLE,
  EXIT_REASON_WORDS,
  EXIT_RULE_WORDS,
  emptyGroupText,
  entrySignalGroupTitle,
  etDayClock,
  exitReasonText,
  exitRuleText,
  exitScheduleText,
  expiryDate,
  type GoLiveDraftContext,
  generatorText,
  groupDrafts,
  JEV_STANCE_WORDS,
  JEV_STATE_WORDS,
  keyedLines,
  LIVE_QUOTE_MAX_AGE_SECONDS,
  LOAD_ERROR_WORDS,
  limitText,
  loadErrorText,
  loadedText,
  MARKET_NOTES_WORDS,
  MODEL_HOLDS_GROUP_TITLE,
  marketNotesText,
  maxLossText,
  NO_ENTRY_BASIS_REASON,
  NO_PLAN_TEXT,
  NO_SIZED_ORDER_REASON,
  NODE_BADGE_WORDS,
  NODE_DISARMED_NOTE,
  NOT_APPROVABLE_WORDS,
  nodeText,
  noLiveQuoteReason,
  noOrdersNotice,
  noOrdersNoticeParts,
  noteText,
  noticeCapsText,
  notKnownText,
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
  SEND_STATE_WORDS,
  SIGNED_OUT_TEXT,
  SIZING_REASON_WORDS,
  STRUCTURE_WORDS,
  safeHttpsUrl,
  sendOutcomeText,
  sendStateText,
  sendSummaryRows,
  sleeveRow,
  staleDialogNotice,
  staleDialogReason,
  strikesText,
  structureText,
  VERTEX_ORDERS_TAB_LABEL,
  VERTEX_ORDERS_TAB_VALUE,
  wideSpreadWords,
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
  approvedRoom: null,
  createdAt: AT,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  entryBasis: "signal_today",
  exitReason: null,
  exitRule: "owner_standing_rule_v1",
  exitSchedule: null,
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
  planVersion: 3,
  preCheck: {
    enginePolicy: "not_evaluated_not_in_web_order_path",
    webFinalGate: null,
  },
  quote: null,
  revision: 3,
  send: null,
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

// The plan in force and the server's clock at the queue read (node.checkedAt).
const CONTEXT: GoLiveDraftContext = { plan: plan(), readAt: AT };
const blockers = (
  entry: GoLiveDraftOutput,
  context: GoLiveDraftContext = CONTEXT
): readonly string[] => approveBlockers(entry, context);
/** A value a newer server could answer and this build does not know. */
const future = <Value>(raw: string): Value => raw as unknown as Value;
const coded = (code: string, message = code): Error =>
  Object.assign(new Error(message), { code });
const QUOTE = {
  asOf: AT,
  longAsk: 5,
  longBid: 4.9,
  shortAsk: 2.7,
  shortBid: 2.6,
};
const NO_UNDEFINED = /undefined|\(\)|^\s*$/u;

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
      down: "Node down: its container is stopped or missing",
      "running-armed": "Node running, armed",
      "running-disarmed": "Node running, disarmed",
      unknown:
        "Node state unknown: the node status could not be read or was incomplete",
    });
    expect(NODE_DISARMED_NOTE).toBe(
      "A disarmed node does not stop an order placed on the Portfolio order screen; only the kill switch does."
    );
    expect(DRAFT_STATE_WORDS).toEqual({
      approved:
        "Approved (recorded). This page did not send it: it sends no orders.",
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
    expect(noOrdersNotice(plan())).toBe(
      "Approve sends that exact order to IBKR as one combo limit order, only while you have ARMED the execution node, only if engine policy v3 accepts it (the order bridge runs the node's own check) and only inside the caps of the plan in force (7.5% open risk on the plan's names, 2% per name, 1.25% per position). For the owner, an approved order whose send never reached the order bridge, or that the bridge refused, has a Send approved order button. The live order screen (Portfolio, Vertex orders tab) has no vertical ticket and takes single option orders only (buy to open, sell to close). Placing a vertical by hand at IBKR is outside Vertex and its checks."
    );
    // The notice never tells the owner to place an approved vertical on a Vertex screen.
    for (const shown of [plan(), null, undefined])
      expect(noOrdersNotice(shown)).not.toMatch(/to place|use the|yourself/iu);
    expect(noOrdersNoticeParts(plan()).link).toBe("Portfolio");
    expect(PORTFOLIO_HREF).toBe("/portfolio?tab=orders");
    expect(APPROVAL_NOT_SENT_SENTENCE).toBe(
      "This records your approval and sends this exact order as one combo limit order, only if the execution node is armed, engine policy v3 accepts it and the plan caps allow it."
    );
  });

  it("pins the facts behind the notice: the vertical ticket is mounted in simulated mode only, on the Vertex orders tab", () => {
    // Read from the sources. When someone lets a Vertex screen open a vertical on the live
    // account, or renames the tab, this fails and the notice must be rewritten.
    const portal = new URL("./", import.meta.url);
    const read = (name: string): string =>
      readFileSync(new URL(name, portal), "utf8");
    const mounts = readdirSync(portal)
      .filter((name) => /\.tsx$/u.test(name) && !/\.test\.tsx$/u.test(name))
      .flatMap((name) =>
        (read(name).match(/<VerticalTicket\b/gu) ?? []).map(() => name)
      );
    // (a) The one mount of the vertical ticket sits inside a `mode === "simulated"` condition.
    expect(mounts).toEqual(["vertex-orders.tsx"]);
    expect(read("vertex-orders.tsx")).toMatch(
      /\{\s*status\?\.gates\.mode === "simulated" \? \(\s*<VerticalTicket\b[^>]*\/>\s*\) : null\s*\}/u
    );
    // (b) The tab that holds that screen is still "orders" / "Vertex orders".
    const tab =
      /value: "([^"]+)",\s*label: "([^"]+)",\s*content: <VertexOrders\b/u.exec(
        read("portfolio-tabs.tsx")
      );
    expect(tab?.[1]).toBe(VERTEX_ORDERS_TAB_VALUE);
    expect(tab?.[2]).toBe(VERTEX_ORDERS_TAB_LABEL);
    expect(VERTEX_ORDERS_TAB_LABEL).toBe("Vertex orders");
    expect(noOrdersNotice(plan())).toContain(
      `(Portfolio, ${VERTEX_ORDERS_TAB_LABEL} tab) has no vertical ticket`
    );
    expect(noOrdersNotice(plan())).not.toContain("Orders & stops");
    expect(PORTFOLIO_HREF).toBe(`/portfolio?tab=${VERTEX_ORDERS_TAB_VALUE}`);
    expect(MARKET_NOTES_WORDS).toEqual({
      attached: "Market notes: attached to the drafts",
      feature_not_deployed: "Market notes: the feature is not deployed",
      none_active: "Market notes: none active",
    });
    expect(ENGINE_POLICY_LINE).toBe(
      "Engine policy (arm_gate): not part of the web order path; not evaluated here."
    );
  });

  it("builds the caps in the notice from the plan in force, never from fixed numbers", () => {
    const limits = {
      maxPositions: 3,
      nameRiskCapPct: 1.5,
      openRiskCapPct: 3,
      positionRiskPct: 0.75,
    };
    expect(noticeCapsText(plan({ limits }))).toBe(
      "only inside the caps of the plan in force (3% open risk on the plan's names, 1.5% per name, 0.75% per position)"
    );
    // A plan that is not approved, or no plan: the send gate sends nothing.
    for (const none of [
      null,
      plan({ approvalBasis: null, status: "proposed" }),
      plan({ status: "retired" }),
    ])
      expect(noticeCapsText(none)).toBe(
        "only under an approved plan (no approved plan is in force now, so nothing is sent)"
      );
    // Before the queue is read the notice names no number.
    expect(noticeCapsText(undefined)).toBe(
      "only inside the caps of the plan in force"
    );
    expect(noOrdersNotice(undefined)).not.toMatch(/\d%/u);
  });

  it("has no sentence that says or suggests this page sent, staged or will send an order", () => {
    const facts = {
      generatedAt: AT,
      plan: plan(),
      tradingDay: "2026-11-11",
    };
    // NO_ORDERS_NOTICE and APPROVAL_NOT_SENT_SENTENCE describe the send after an approval
    // (GO-LIVE 4, owner 2026-11-12) and are pinned word for word above.
    const sentences = [
      REJECTION_RECORD_SENTENCE,
      NODE_DISARMED_NOTE,
      ENGINE_POLICY_LINE,
      NO_PLAN_TEXT,
      MODEL_HOLDS_GROUP_TITLE,
      EXIT_GROUP_TITLE,
      OTHER_GROUP_TITLE,
      NO_SIZED_ORDER_REASON,
      NO_ENTRY_BASIS_REASON,
      OWNER_ONLY_DECISION_TEXT,
      REJECT_NOTE_REQUIRED,
      SIGNED_OUT_TEXT,
      CURRENT_SIZING_LABEL,
      CURRENT_QUOTE_LABEL,
      CURRENT_PRECHECK_LABEL,
      APPROVED_ORDER_NOT_SHOWN,
      draftsTitle("2026-11-11"),
      entrySignalGroupTitle("2026-11-11"),
      loadedText(AT),
      notKnownText("x"),
      ...(["entrySignal", "modelHolds"] as const).flatMap((group) => [
        emptyGroupText(group, facts),
        emptyGroupText(group, { ...facts, generatedAt: null }),
        emptyGroupText(group, { ...facts, plan: null }),
        emptyGroupText(group, {
          ...facts,
          plan: plan({ approvalBasis: null, status: "proposed" }),
        }),
      ]),
      generatorText({ ...facts, drafts: [] }),
      generatorText({ ...facts, drafts: [], generatedAt: null }),
      decisionAftermathText(null, "2026-11-11", true),
      decisionAftermathText(undefined, "2026-11-11", true),
      decisionAftermathText(draft(), "2026-11-11", false),
      staleDialogNotice("the draft is no longer in the queue"),
      ...GOLIVE_DRAFT_STATE_VALUES.map((state) =>
        decisionAftermathText(draft({ state }), "2026-11-11", true)
      ),
      ...[
        ...Object.keys(AGENT_OPS_API_ERRORS),
        "INTERNAL_SERVER_ERROR",
        undefined,
      ].flatMap((code) =>
        (["approve", "reject"] as const).map(
          (type) =>
            decisionFailure(
              code === undefined
                ? new TypeError("Failed to fetch")
                : coded(code),
              type,
              draft(),
              CONTEXT
            ).text
        )
      ),
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
        LOAD_ERROR_WORDS,
      ].flatMap((words) => Object.values<string>(words)),
    ];
    // The only allowed uses of these verbs are the denials below.
    const denials = [
      "This page sends no orders.",
      "this page sends no orders.",
      "It does not send the order.",
      "This page did not send it: it sends no orders.",
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
    expect(etDayClock(AT)).toBe("2026-11-11 10:30 ET");
    // Midnight in New York is 00:00 on the new day, in winter and in summer time.
    expect(etDayClock(new Date("2026-11-12T05:00:00.000Z"))).toBe(
      "2026-11-12 00:00 ET"
    );
    expect(etDayClock(new Date("2026-07-01T04:00:00.000Z"))).toBe(
      "2026-07-01 00:00 ET"
    );
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
    [
      "proposed",
      null,
      "Plan proposed, not approved: no owner approval is recorded for it",
    ],
    // The queue answers only a proposed or an approved plan; this is the fallback.
    [
      "retired",
      "owner_decision",
      "Plan retired, so it is not in force and is not treated as approved",
    ],
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

  it("names the cause of a missing plan record and never calls an unknown status approved", () => {
    expect(NO_PLAN_TEXT).toBe(
      "No plan record: no proposed or approved plan is stored"
    );
    expect(
      planStatusText({ approvalBasis: null, status: future("paused") })
    ).toBe(
      "Plan status not known to this page version (paused), so the plan is not treated as approved"
    );
    expect(
      planStatusText({ approvalBasis: future("committee"), status: "approved" })
    ).toBe(
      "Plan marked approved, approval basis not known to this page version (committee)"
    );
  });

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
  it("shows the account value with the date and time of its reading", () =>
    expect(
      accountText({
        asOf: AT,
        netLiquidation: 100_000,
        unavailableReason: null,
      })
    ).toBe("Account value: $100,000 as of 2026-11-11 10:30 ET"));

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

  it("says the node state with the date and time of its check", () => {
    expect(
      nodeText({ armedAt: null, badge: "running-disarmed", checkedAt: AT })
    ).toBe("Node running, disarmed (checked 2026-11-11 10:30 ET)");
    expect(nodeText({ armedAt: null, badge: "down", checkedAt: AT })).toBe(
      "Node down: its container is stopped or missing (checked 2026-11-11 10:30 ET)"
    );
    expect(
      nodeText({ armedAt: null, badge: future("paused"), checkedAt: AT })
    ).toBe(
      "Node state not known to this page version (paused) (checked 2026-11-11 10:30 ET)"
    );
  });

  it("says what the generator count counts, with the date of the run", () => {
    const queue: Pick<
      GoLiveQueueOutput,
      "drafts" | "generatedAt" | "tradingDay"
    > = {
      drafts: [draft(), draft({ id: "old", state: "expired" })],
      generatedAt: AT,
      tradingDay: "2026-11-11",
    };
    expect(generatorText(queue)).toBe(
      "Generator ran at 2026-11-11 10:30 ET. 2 drafts are listed for 2026-11-11, counting decided and expired drafts."
    );
    expect(generatorText({ ...queue, drafts: [draft()] })).toBe(
      "Generator ran at 2026-11-11 10:30 ET. 1 draft is listed for 2026-11-11, counting decided and expired drafts."
    );
    expect(generatorText({ ...queue, drafts: [] })).toBe(
      "Generator ran at 2026-11-11 10:30 ET. 0 drafts are listed for 2026-11-11, counting decided and expired drafts."
    );
  });

  it("names both causes when the generator has not reported", () => {
    expect(
      generatorText({ drafts: [], generatedAt: null, tradingDay: "2026-11-11" })
    ).toBe(
      "The generator has not reported for 2026-11-11: it has not run yet, or its run was refused (the journal of vertex-golive-drafts.service on the rig says which)."
    );
    // The unit named in the sentence is the unit the repository installs.
    expect(
      readFileSync(
        new URL(
          "../../../../../infra/golive-drafts/vertex-golive-drafts.service",
          import.meta.url
        ),
        "utf8"
      )
    ).toContain("[Service]");
  });

  it("says that the page does not refresh and when it was loaded", () =>
    expect(loadedText(AT)).toBe(
      "This page does not refresh on its own. Loaded 2026-11-11 10:30 ET."
    ));

  it("names an unknown market-notes status instead of a blank", () => {
    expect(marketNotesText("none_active")).toBe("Market notes: none active");
    expect(marketNotesText(future("paused"))).toBe(
      "Market notes: status not known to this page version (paused)"
    );
  });
});

describe("group headings and empty groups", () => {
  const facts = { generatedAt: AT, plan: plan(), tradingDay: "2026-11-11" };

  it("names the order session day instead of today", () => {
    expect(draftsTitle("2026-11-11")).toBe(
      "Drafts for 2026-11-11 (the order session day)"
    );
    expect(entrySignalGroupTitle("2026-11-11")).toBe(
      "Entry signal for 2026-11-11"
    );
    for (const group of ["entrySignal", "modelHolds"] as const)
      for (const text of [
        emptyGroupText(group, facts),
        emptyGroupText(group, { ...facts, generatedAt: null }),
        emptyGroupText(group, { ...facts, plan: null }),
      ]) {
        expect(text).toContain("2026-11-11");
        expect(text).not.toMatch(/\btoday\b/iu);
      }
  });

  it("says there is no entry signal only when the generator reported", () => {
    expect(emptyGroupText("entrySignal", facts)).toBe(
      "No entry signal for 2026-11-11 under the plan's entry rule: the generator ran at 2026-11-11 10:30 ET and reported no entry draft."
    );
    expect(emptyGroupText("modelHolds", facts)).toBe(
      "No late entry for 2026-11-11: the generator ran at 2026-11-11 10:30 ET and reported no position that the model holds and the account does not."
    );
  });

  it("says the signals are not known when the generator has not reported", () => {
    const silent = { ...facts, generatedAt: null };
    expect(emptyGroupText("entrySignal", silent)).toBe(
      "The generator has not reported for 2026-11-11, so entry signals are not known."
    );
    expect(emptyGroupText("modelHolds", silent)).toBe(
      "The generator has not reported for 2026-11-11, so it is not known whether the model holds a position the account does not."
    );
    for (const group of ["entrySignal", "modelHolds"] as const)
      expect(emptyGroupText(group, silent)).not.toMatch(/^No /u);
  });

  it("names a missing plan record as the cause", () => {
    for (const generatedAt of [AT, null]) {
      const none = { ...facts, generatedAt, plan: null };
      expect(emptyGroupText("entrySignal", none)).toBe(
        "No plan record is stored, so there is no entry rule to draft from for 2026-11-11."
      );
      expect(emptyGroupText("modelHolds", none)).toBe(
        "No plan record is stored, so there is no model position to compare with the account for 2026-11-11."
      );
    }
  });

  it("adds that a proposed plan lets no draft be approved", () => {
    const proposed = plan({ approvalBasis: null, status: "proposed" });
    const added =
      " Plan proposed, not approved: no owner approval is recorded for it, so no draft can be approved.";
    expect(emptyGroupText("entrySignal", { ...facts, plan: proposed })).toBe(
      `${emptyGroupText("entrySignal", facts)}${added}`
    );
    expect(
      emptyGroupText("modelHolds", {
        ...facts,
        generatedAt: null,
        plan: proposed,
      })
    ).toBe(
      `${emptyGroupText("modelHolds", { ...facts, generatedAt: null })}${added}`
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
    expect(blockers(late)).toEqual(["Late entry is not in the backtest"]);
    expect(
      blockers({ ...late, notApprovable: ["LATE_ENTRY_NOT_TESTED"] })
    ).toEqual(["Late entry is not in the backtest"]);
    expect(blockers(draft({ entryBasis: null }))).toEqual([
      NO_ENTRY_BASIS_REASON,
    ]);
    for (const entry of [late, draft({ entryBasis: null })])
      expect(
        draftGroupOf(entry) === "entrySignal" || draftGroupOf(entry) === "exits"
      ).toBe(false);
  });

  it("writes strikes as long / short", () =>
    expect(strikesText({ longStrike: 450, shortStrike: 455.5 })).toBe(
      "long $450.00 / short $455.50"
    ));

  it("names the quote source with its date and time", () => {
    const of = (
      quote: GoLiveDraftOutput["quote"],
      notApprovable: GoLiveDraftOutput["notApprovable"] = []
    ): string => quoteText({ notApprovable, quote }, AT);
    expect(of(null)).toBe("No quote: none was recorded for this draft");
    expect(of({ ...QUOTE, source: "ibkr_live" })).toBe(
      "IBKR live, as of 2026-11-11 10:30 ET"
    );
    expect(of({ ...QUOTE, source: "yahoo_delayed_snapshot" })).toBe(
      "Yahoo, 15 min delayed, indicative, as of 2026-11-11 10:30 ET"
    );
    expect(of({ ...QUOTE, source: "model" })).toBe(
      "model price, indicative, as of 2026-11-11 10:30 ET"
    );
    // 03:30Z is still the evening before in New York: the date is the New York date.
    expect(
      of({
        ...QUOTE,
        asOf: new Date("2026-11-11T03:30:00.000Z"),
        source: "ibkr_live",
      })
    ).toBe("IBKR live, as of 2026-11-10 22:30 ET");
    expect(of({ ...QUOTE, source: future("broker_x") })).toBe(
      "quote source not known to this page version (broker_x), as of 2026-11-11 10:30 ET"
    );
  });

  it("does not call an IBKR quote live when the server did not count it as live", () => {
    const old = {
      ...QUOTE,
      asOf: new Date(AT.getTime() - 121_000),
      source: "ibkr_live" as const,
    };
    const ahead = {
      ...QUOTE,
      asOf: new Date(AT.getTime() + 61_000),
      source: "ibkr_live" as const,
    };
    const notLive = ["NO_LIVE_IBKR_QUOTE"] as const;
    const oldText = quoteText({ notApprovable: [...notLive], quote: old }, AT);
    const aheadText = quoteText(
      { notApprovable: [...notLive], quote: ahead },
      AT
    );
    expect(oldText).toBe(
      "IBKR quote, too old to count as live (older than 120 s when the server read the queue), as of 2026-11-11 10:27 ET"
    );
    expect(aheadText).toBe(
      "IBKR quote, not counted as live (its time is after the server's clock), as of 2026-11-11 10:31 ET"
    );
    for (const text of [oldText, aheadText])
      expect(text).not.toContain("IBKR live");
    expect(noLiveQuoteReason(old, AT)).toBe(
      "No live IBKR quote: the IBKR quote shown is older than 120 s, so it does not count as live"
    );
    expect(noLiveQuoteReason(ahead, AT)).toBe(
      "No live IBKR quote: the IBKR quote shown has a time after the server's clock, so it is not trusted"
    );
  });

  it("uses the same live-quote age as the server", () => {
    const source = readFileSync(
      new URL(
        "../../../../../packages/api/src/server/golive-drafts-sizing.ts",
        import.meta.url
      ),
      "utf8"
    );
    const found = /GOLIVE_QUOTE_MAX_AGE_MS = ([\d_]+);/u.exec(source);
    expect(Number(found?.[1]?.replaceAll("_", "")) / 1000).toBe(
      LIVE_QUOTE_MAX_AGE_SECONDS
    );
    expect(LIVE_QUOTE_MAX_AGE_SECONDS).toBe(120);
  });

  it("gives the missing live quote a cause for each quote source", () => {
    const reasons = [
      noLiveQuoteReason(null, AT),
      ...GOLIVE_QUOTE_SOURCE_VALUES.map((source) =>
        noLiveQuoteReason({ ...QUOTE, source }, AT)
      ),
      noLiveQuoteReason({ ...QUOTE, source: future("broker_x") }, AT),
    ];
    expect(reasons).toEqual([
      "No live IBKR quote: no quote was recorded for this draft",
      "No live IBKR quote: the IBKR quote shown is older than 120 s, so it does not count as live",
      "No live IBKR quote: the price shown is a Yahoo snapshot, delayed 15 minutes",
      "No live IBKR quote: the price shown is a model price, not a market quote",
      "No live IBKR quote: the quote source is not known to this page version (broker_x)",
    ]);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("writes the limit in dollars per spread as a debit or a credit", () => {
    expect(limitText({ limitPrice: 2.35, reason: "sized" })).toBe(
      "$2.35 debit per spread"
    );
    expect(limitText({ limitPrice: -1.1, reason: "sized" })).toBe(
      "$1.10 credit per spread"
    );
  });

  it("names the cause of a missing limit from the sizing reason, and blames the quote only for no_quote", () => {
    const none = (reason: GoLiveDraftOutput["sizing"]["reason"]): string =>
      limitText({ limitPrice: null, reason });
    expect(none("no_quote")).toBe("no limit: no usable quote");
    // The server sends no limit when the account value is missing, also beside a good quote.
    expect(none("nlv_unavailable")).toBe(
      "no limit: the account value is not available"
    );
    for (const reason of GOLIVE_SIZING_REASON_VALUES) {
      const text = none(reason);
      expect(text.startsWith("no limit: ")).toBe(true);
      expect(text.includes("quote")).toBe(reason === "no_quote");
    }
    expect(none("quantity_above_order_limit")).toBe(
      `no limit: ${SIZING_REASON_WORDS.quantity_above_order_limit}`
    );
    expect(none("sized")).toBe("no limit: no limit was computed");
    expect(none(future("new_cap"))).toBe(
      "no limit: sizing reason not known to this page version (new_cap)"
    );
  });

  it.each(GOLIVE_SIZING_REASON_VALUES)(
    "shows quantity 0 with the reason %s",
    (reason) =>
      expect(quantityText({ quantity: 0, reason })).toBe(
        `0 spreads (${SIZING_REASON_WORDS[reason]})`
      )
  );

  it("names the cause when the budget buys more spreads than one order may hold", () =>
    expect(
      quantityText({ quantity: 0, reason: "quantity_above_order_limit" })
    ).toBe(
      "0 spreads (the budget buys more spreads than one order may hold, and the draft is not reduced)"
    ));

  it("shows a sized quantity in spreads with its reason", () => {
    expect(quantityText({ quantity: 2, reason: "sized" })).toBe(
      "2 spreads (sized from the plan's risk per position)"
    );
    expect(quantityText({ quantity: 1, reason: "sized" })).toBe(
      "1 spread (sized from the plan's risk per position)"
    );
    expect(quantityText({ quantity: 2, reason: future("new_cap") })).toBe(
      "2 spreads (sizing reason not known to this page version (new_cap))"
    );
  });

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
    ).toBe(`not available: ${SIZING_REASON_WORDS.no_quote}`);
    // no_quote covers more than a missing quote: every cause the server has is named.
    expect(SIZING_REASON_WORDS.no_quote).toBe(
      "there is no usable quote: none was recorded, a leg has no bid or no ask, a leg is crossed (bid above ask), a leg has a bid-ask spread wider than half its mid and wider than $0.05, or the net price is not between 0 and the strike width"
    );
    // The two numbers in the sentence are the contract's.
    expect(GOLIVE_QUOTE_MAX_SPREAD_SHARE).toBe(0.5);
    expect(GOLIVE_QUOTE_SPREAD_FLOOR).toBe(0.05);
    expect(
      wideSpreadWords(GOLIVE_QUOTE_MAX_SPREAD_SHARE, GOLIVE_QUOTE_SPREAD_FLOOR)
    ).toBe("wider than half its mid and wider than $0.05");
    // Other limits in the contract give other numbers in the sentence, never stale words.
    expect(wideSpreadWords(0.25, 0.1)).toBe(
      "wider than 25% of its mid and wider than $0.10"
    );
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
    expect(blockers(draft())).toEqual([]);
    expect(blockers(draft({ order: null }))).toEqual([NO_SIZED_ORDER_REASON]);
    expect(
      blockers(
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
      blockers(draft({ notApprovable: [...GOLIVE_NOT_APPROVABLE_VALUES] }))
    ).toEqual(
      GOLIVE_NOT_APPROVABLE_VALUES.map((value) =>
        value === "NO_LIVE_IBKR_QUOTE"
          ? "No live IBKR quote: no quote was recorded for this draft"
          : NOT_APPROVABLE_WORDS[value]
      )
    );
  });

  it("does not offer Approve unless the plan in force is approved and is the draft's plan", () => {
    // The server lists no blocker in each case: the page gates on the plan itself.
    expect(blockers(draft(), { plan: null, readAt: AT })).toEqual([
      "The plan is not approved: there is no plan record",
    ]);
    expect(
      blockers(draft(), {
        plan: plan({ approvalBasis: null, status: "proposed" }),
        readAt: AT,
      })
    ).toEqual(["The plan is not approved: it is proposed"]);
    expect(
      blockers(draft(), { plan: plan({ status: "retired" }), readAt: AT })
    ).toEqual(["The plan is not approved: it is retired"]);
    expect(
      blockers(draft(), {
        plan: plan({ status: future("paused") }),
        readAt: AT,
      })
    ).toEqual([
      "The plan is not approved: its status is not known to this page version (paused)",
    ]);
    expect(
      blockers(draft({ planVersion: 2 }), { plan: plan(), readAt: AT })
    ).toEqual([
      "The plan is not approved for this draft: it was drafted for plan plan-1 version 2, and the plan in force is plan-1 version 3",
    ]);
    // Marked approved on a basis this page version does not know: not offered either.
    expect(
      blockers(draft(), {
        plan: plan({ approvalBasis: future("committee") }),
        readAt: AT,
      })
    ).toEqual([
      "The plan's approval basis is not known to this page version (committee)",
    ]);
    for (const approvalBasis of ["owner_decision", "owner_delegation"] as const)
      expect(
        blockers(draft(), { plan: plan({ approvalBasis }), readAt: AT })
      ).toEqual([]);
    // The server's own blocker gets the same cause and is not listed twice.
    expect(
      blockers(draft({ notApprovable: ["PLAN_NOT_APPROVED"] }), {
        plan: plan({ approvalBasis: null, status: "proposed" }),
        readAt: AT,
      })
    ).toEqual(["The plan is not approved: it is proposed"]);
    expect(blockers(draft({ notApprovable: ["PLAN_NOT_APPROVED"] }))).toEqual([
      "The plan is not approved",
    ]);
  });

  it("blocks Approve when the dry pre-check denied the order, whatever the server listed", () => {
    const gate = {
      jevStance: null,
      jevState: "none" as const,
      maxLoss: 470,
      maxLossPct: 2.4,
      reasons: [],
      structure: "debit-vertical" as const,
    };
    const preCheck = (decision: "allow" | "deny") => ({
      enginePolicy: "not_evaluated_not_in_web_order_path" as const,
      webFinalGate: { ...gate, decision },
    });
    expect(blockers(draft({ preCheck: preCheck("allow") }))).toEqual([]);
    expect(blockers(draft({ preCheck: preCheck("deny") }))).toEqual([
      "The dry pre-check (web final gate) denied the order",
    ]);
    expect(
      blockers(
        draft({
          notApprovable: ["PRECHECK_DENIED"],
          preCheck: preCheck("deny"),
        })
      )
    ).toEqual(["The dry pre-check (web final gate) denied the order"]);
    expect(blockers(draft({ preCheck: preCheck(future("review")) }))).toEqual([
      "The pre-check decision is not known to this page version (review)",
    ]);
  });

  it("shows the stored approved order apart from the current sizing", () => {
    expect(approvedOrderView(draft())).toBeNull();
    expect(
      approvedOrderView(draft({ decidedAt: AT, state: "rejected" }))
    ).toBeNull();
    expect(
      approvedOrderView(
        draft({
          approvedOrder: ORDER,
          decidedAt: AT,
          nodeBadgeAtDecision: "running-disarmed",
          state: "approved",
        })
      )
    ).toEqual({
      label: "Approved order (recorded 2026-11-11 10:30 ET)",
      legs: orderLegLines(ORDER),
      missing: null,
      nodeBadge: "Node badge read at approval: Node running, disarmed",
      room: "Risk room held by this approval: the server did not send it",
      rows: [
        { label: "Quantity", value: "2 spreads" },
        { label: "Limit", value: "$2.35 debit per spread" },
      ],
    });
    expect(
      approvedOrderView(draft({ decidedAt: null, state: "approved" }))
    ).toEqual({
      label: "Approved order (recorded time not recorded)",
      legs: [],
      missing: APPROVED_ORDER_NOT_SHOWN,
      nodeBadge: "Node badge read at approval: not recorded",
      room: "Risk room held by this approval: the server did not send it",
      rows: [],
    });
    // True for the one case a page can meet: the server leaves the order out of the answer.
    expect(APPROVED_ORDER_NOT_SHOWN).toBe(
      "This answer carries no approved order, so it cannot be shown here. The server withholds it from API key callers."
    );
    expect(APPROVED_ORDER_NOT_SHOWN).not.toMatch(/not stored/iu);
    expect(CURRENT_SIZING_LABEL).toBe(
      "Current indicative sizing (recomputed now; not the approved order)"
    );
    expect(CURRENT_QUOTE_LABEL).toBe(
      "Quote (current value, not the value at approval)"
    );
    expect(CURRENT_PRECHECK_LABEL).toBe(
      "Pre-check (current value, not the value at approval)"
    );
    expect(currentSizingText(draft().sizing)).toBe(
      "limit $2.35 debit per spread; quantity 2 spreads (sized from the plan's risk per position); max loss $470.00 (0.47% of account)"
    );
  });

  it("names the cause that puts a draft under Other drafts", () => {
    expect(blockers(draft({ entryBasis: null }))).toEqual([
      NO_ENTRY_BASIS_REASON,
    ]);
    expect(blockers(draft({ entryBasis: future("new_basis") }))).toEqual([
      "The entry basis is not known to this page version (new_basis)",
    ]);
    expect(blockers(draft({ kind: future("roll") }))).toEqual([
      "The draft kind is not known to this page version (roll)",
    ]);
  });

  it("shows the risk room an approval holds, in dollars and percent of the account value", () => {
    const approved = (
      approvedRoom: GoLiveDraftOutput["approvedRoom"]
    ): string | undefined =>
      approvedOrderView(
        draft({
          approvedOrder: ORDER,
          approvedRoom,
          decidedAt: AT,
          state: "approved",
        })
      )?.room;
    expect(approved({ maxLoss: 882, maxLossPctNlv: 8.82 })).toBe(
      "Risk room held by this approval: $882.00 max loss (8.82% of account value)"
    );
    expect(approved({ maxLoss: 882, maxLossPctNlv: null })).toBe(
      "Risk room held by this approval: $882.00 max loss (% of account value not available: the account value is not available)"
    );
    expect(approved(null)).toBe(
      "Risk room held by this approval: the server did not send it"
    );
    // A draft that is not approved holds no room and shows none.
    expect(
      approvedOrderView(draft({ approvedRoom: null, state: "proposed" }))
    ).toBeNull();
    expect(
      approvedOrderView(
        draft({
          approvedRoom: { maxLoss: 882, maxLossPctNlv: 8.82 },
          state: "rejected",
        })
      )
    ).toBeNull();
  });

  it("gives equal lines different keys", () => {
    expect(keyedLines(["a", "b", "a"])).toEqual([
      { key: "1:a", text: "a" },
      { key: "1:b", text: "b" },
      { key: "2:a", text: "a" },
    ]);
  });

  it("repeats the exact order for the confirm dialog, with units", () => {
    expect(orderLegLines(ORDER)).toEqual([
      "BUY 1 SPY 2026-12-18 $450.00 call",
      "SELL 1 SPY 2026-12-18 $455.50 put",
    ]);
    expect(orderSummaryRows(ORDER, draft().sizing)).toEqual([
      { label: "Quantity", value: "2 spreads" },
      { label: "Limit", value: "$2.35 debit per spread" },
      { label: "Max loss", value: "$470.00 (0.47% of account)" },
    ]);
    expect(
      orderSummaryRows({ ...ORDER, quantity: 1 }, draft().sizing)[0]
    ).toEqual({ label: "Quantity", value: "1 spread" });
  });
});

describe("values a newer server could answer", () => {
  it("names the raw value and never prints undefined or a blank", () => {
    const texts = [
      structureText(future("ironCondor")),
      draftStateText(future("paused")),
      marketNotesText(future("paused")),
      exitReasonText(future("stop_loss")),
      exitRuleText(future("owner_standing_rule_v2")),
      nodeText({ armedAt: null, badge: future("paused"), checkedAt: AT }),
      quantityText({ quantity: 2, reason: future("new_cap") }),
      maxLossText({
        maxLoss: null,
        maxLossPctNlv: null,
        reason: future("new_cap"),
      }),
      quoteText(
        { notApprovable: [], quote: { ...QUOTE, source: future("broker_x") } },
        AT
      ),
      ...blockers(draft({ notApprovable: [future("MARGIN_CALL")] })),
      ...orderLegLines({
        ...ORDER,
        legs: ORDER.legs.map((leg) => ({ ...leg, right: future("X") })),
      }),
    ];
    for (const text of texts) {
      expect(text).toMatch(/not known to this page version \(\w+\)/u);
      expect(text).not.toMatch(NO_UNDEFINED);
    }
    expect(structureText(future("ironCondor"))).toBe(
      "not known to this page version (ironCondor)"
    );
    expect(notKnownText("x")).toBe("not known to this page version (x)");
    // A property of every object is not a known value.
    expect(structureText(future("constructor"))).toBe(
      "not known to this page version (constructor)"
    );
  });

  it("names an unknown pre-check decision, stance and state", () => {
    const view = preCheckView({
      enginePolicy: "not_evaluated_not_in_web_order_path",
      webFinalGate: {
        decision: future("review"),
        jevStance: future("MIXED"),
        jevState: future("paused"),
        maxLoss: 470,
        maxLossPct: 0.47,
        reasons: [],
        structure: "debit-vertical",
      },
    });
    expect(view.decision).toBe(
      "Dry pre-check (web final gate; positions, kill switch and options-only gate not included): not known to this page version (review). Not a clearance to send."
    );
    expect(view.stance).toBe(
      "JEV stance used by the check: not known to this page version (MIXED) (JEV state not known to this page version (paused))"
    );
  });

  it.each<readonly [string, Partial<GoLiveDraftOutput>]>([
    ["structure", { structure: future<GoLiveDraftOutput["structure"]>("x") }],
    [
      "sizing reason",
      { sizing: { ...draft().sizing, reason: future<"sized">("x") } },
    ],
    ["exit rule", { exitRule: future<GoLiveDraftOutput["exitRule"]>("x") }],
    [
      "exit reason",
      { exitReason: future<GoLiveDraftOutput["exitReason"]>("x") },
    ],
    ["quote source", { quote: { ...QUOTE, source: future<"ibkr_live">("x") } }],
    ["blocker", { notApprovable: [future<"SIZED_TO_ZERO">("x")] }],
    ["kind", { kind: future<GoLiveDraftOutput["kind"]>("x") }],
    [
      "entry basis",
      { entryBasis: future<GoLiveDraftOutput["entryBasis"]>("x") },
    ],
  ])("never offers Approve for an unknown %s", (_name, overrides) => {
    const reasons = blockers(draft(overrides));
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(reason).not.toMatch(NO_UNDEFINED);
  });
});

describe("loadErrorText", () => {
  it("has plain words for every error code of the contract, a missing answer and an unknown code", () => {
    expect(Object.keys(LOAD_ERROR_WORDS).sort()).toEqual(
      [...Object.keys(AGENT_OPS_API_ERRORS), "NO_ANSWER", "OTHER"].sort()
    );
    expect(Object.isFrozen(LOAD_ERROR_WORDS)).toBe(true);
    const texts = Object.values(LOAD_ERROR_WORDS);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it.each(
    Object.entries(AGENT_OPS_API_ERRORS).map(
      ([code, { message }]) => [code, message] as const
    )
  )("does not show the code %s or its default message raw", (code, message) => {
    const text = loadErrorText(coded(code, message));
    expect(text).not.toContain(code);
    expect(text).not.toContain(message);
    expect(text.endsWith(" A load only reads: it recorded nothing.")).toBe(
      true
    );
  });

  it("says plainly that the session has ended on UNAUTHORIZED", () =>
    expect(
      loadErrorText(coded("UNAUTHORIZED", "Authentication required"))
    ).toBe(
      "You are signed out: the session has ended. Sign in again. A load only reads: it recorded nothing."
    ));

  it.each([
    [new TypeError("Failed to fetch")],
    [new Error("  ")],
    [{ message: 42 }],
    [null],
    ["offline"],
  ])(
    "names a missing answer for %j and never shows the browser text",
    (error) =>
      expect(loadErrorText(error)).toBe(
        "No answer came back from the server (network failure or timeout). A load only reads: it recorded nothing."
      )
  );

  it("does not show a validation text of the server", () =>
    expect(
      loadErrorText(coded("BAD_REQUEST", "Input validation failed: tradingDay"))
    ).toBe(
      "The server refused the request as invalid. This page and the server may be different versions: reload the page. A load only reads: it recorded nothing."
    ));

  it("adds the server detail of a storage error after the plain sentence", () => {
    expect(
      loadErrorText(
        coded(
          "STORAGE_ERROR",
          "Draft d1 has equal strikes. Write the plan again with scripts/golive/seed-plan.ts"
        )
      )
    ).toBe(
      "The draft store could not be read. Server detail: Draft d1 has equal strikes. Write the plan again with scripts/golive/seed-plan.ts. A load only reads: it recorded nothing."
    );
    expect(
      loadErrorText(
        coded("STORAGE_ERROR", AGENT_OPS_API_ERRORS.STORAGE_ERROR.message)
      )
    ).toBe(
      "The draft store could not be read. A load only reads: it recorded nothing."
    );
  });

  it("names an error code this page version does not know", () =>
    expect(loadErrorText(coded("INTERNAL_SERVER_ERROR", "boom"))).toBe(
      "The server failed with an error code not known to this page version (INTERNAL_SERVER_ERROR). A load only reads: it recorded nothing."
    ));
});

describe("decisionFailure", () => {
  const fail = (
    error: unknown,
    type: "approve" | "reject" = "approve",
    entry: GoLiveDraftOutput = draft()
  ) => decisionFailure(error, type, entry, CONTEXT);

  it.each(["approve", "reject"] as const)(
    "says for every code whether the %s was recorded or that it is not known",
    (type) => {
      const errors = [
        ...Object.entries(AGENT_OPS_API_ERRORS).map(([code, { message }]) =>
          coded(code, message)
        ),
        coded("INTERNAL_SERVER_ERROR", "boom"),
        new TypeError("Failed to fetch"),
      ];
      for (const error of errors) {
        const { text } = fail(error, type);
        expect(text).toMatch(
          /Nothing was recorded\.|recorded nothing\.|not known whether it was recorded\.|was stored and/u
        );
        expect(text).not.toContain("Failed to fetch");
        expect(text).not.toContain("boom");
        expect(text).not.toContain("The decision was not recorded");
      }
    }
  );

  it("keeps the dialog open only when nothing was recorded and the owner can act in it", () => {
    const actions = Object.fromEntries(
      [...Object.keys(AGENT_OPS_API_ERRORS), "INTERNAL_SERVER_ERROR"].map(
        (code) => [code, fail(coded(code)).action]
      )
    );
    expect(actions).toEqual({
      BAD_REQUEST: "stay",
      CONFLICT: "close",
      FORBIDDEN: "close",
      INTERNAL_SERVER_ERROR: "close",
      NOT_CONFIGURED: "close",
      NOT_FOUND: "close",
      STORAGE_ERROR: "close",
      UNAUTHORIZED: "stay",
      UPSTREAM_ERROR: "close",
      VALIDATION_ERROR: "close",
    });
    expect(fail(new TypeError("Failed to fetch")).action).toBe("close");
  });

  it("says plainly that the session has ended on UNAUTHORIZED", () =>
    expect(fail(coded("UNAUTHORIZED", "Authentication required"))).toEqual({
      action: "stay",
      aftermath: "none",
      text: "You are signed out: the session has ended. Sign in again. Nothing was recorded.",
    }));

  it("tells a lost owner right from lost operator access on FORBIDDEN, and names both when it cannot tell", () => {
    for (const message of [
      "Owner (admin) access required",
      "A draft decision needs the owner's browser session",
    ])
      expect(fail(coded("FORBIDDEN", message))).toEqual({
        action: "close",
        aftermath: "none",
        text: "Only the owner can approve or reject a draft. Nothing was recorded.",
      });
    expect(fail(coded("FORBIDDEN", "Operator access required")).text).toBe(
      "Operator access was lost for this session. Nothing was recorded."
    );
    expect(fail(coded("FORBIDDEN", "Forbidden")).text).toBe(
      "The server refused this session: either only the owner can approve or reject a draft, or operator access was lost. Nothing was recorded."
    );
  });

  it("pins the FORBIDDEN messages against the server source", () => {
    const read = (path: string): string =>
      readFileSync(
        new URL(
          `../../../../../packages/api/src/server/${path}`,
          import.meta.url
        ),
        "utf8"
      );
    const drafts = read("golive-drafts.ts");
    expect(drafts).toContain('"Owner (admin) access required"');
    expect(drafts).toContain(
      '"A draft decision needs the owner\'s browser session"'
    );
    expect(read("operator-access.ts")).toContain('"Operator access required"');
  });

  it("does not say that a CONFLICT means nothing is recorded", () => {
    expect(fail(coded("CONFLICT", "The draft is no longer proposed"))).toEqual({
      action: "close",
      aftermath: "refused",
      text: "The server refused this approval: the draft was already decided or expired, or its order or plan changed after this page loaded it. This attempt recorded nothing.",
    });
    expect(
      fail(coded("CONFLICT", "The draft is no longer proposed"), "reject").text
    ).toBe(
      "The server refused this rejection: the draft was already decided or expired, or its order or plan changed after this page loaded it. This attempt recorded nothing."
    );
  });

  it.each(GOLIVE_NOT_APPROVABLE_VALUES)(
    "puts the blocker %s of a CONFLICT in words, never as a code",
    (code) => {
      const { text } = fail(
        coded("CONFLICT", `Draft cannot be approved: ${code}`)
      );
      expect(text).not.toContain(code);
      expect(text).not.toMatch(/[A-Z]{3,}_[A-Z_]+/u);
      expect(text.startsWith("The server refused this approval: ")).toBe(true);
    }
  );

  it("uses the words of the row for a blocker, and never says 'approved' about a rejection", () => {
    const entry = draft({ quote: { ...QUOTE, source: "model" } });
    const error = coded(
      "CONFLICT",
      "Draft cannot be approved: PRECHECK_DENIED, NO_LIVE_IBKR_QUOTE"
    );
    expect(fail(error, "approve", entry).text).toBe(
      "The server refused this approval: the dry pre-check (web final gate) denied the order; no live IBKR quote: the price shown is a model price, not a market quote. This attempt recorded nothing."
    );
    const rejection = fail(error, "reject", entry).text;
    expect(rejection.startsWith("The server refused this rejection: ")).toBe(
      true
    );
    expect(rejection).not.toContain("cannot be approved");
  });

  it("says a missing draft is not in the queue of the order session day", () =>
    expect(
      fail(
        coded(
          "NOT_FOUND",
          "Draft is not in the queue of trading day 2026-11-12"
        ),
        "reject"
      )
    ).toEqual({
      action: "close",
      aftermath: "refused",
      text: "The server did not find this draft in the queue of the order session day, so this rejection recorded nothing.",
    }));

  it("gives a code this build does not handle the fallback: close, reload, result not known", () => {
    // Also the answer for a code a later contract adds before this page learns its words.
    for (const type of ["approve", "reject"] as const)
      expect(fail(coded("INTERNAL_SERVER_ERROR", "boom"), type)).toEqual({
        action: "close",
        aftermath: "result_not_known",
        text: `The server failed during this ${
          type === "approve" ? "approval" : "rejection"
        } with an error code not known to this page version (INTERNAL_SERVER_ERROR), so it is not known whether it was recorded.`,
      });
  });

  it("says the result is not known when no answer came back", () =>
    expect(fail(new TypeError("Failed to fetch"))).toEqual({
      action: "close",
      aftermath: "result_not_known",
      text: "No answer came back for this approval (network failure or timeout), so it is not known whether it was recorded.",
    }));

  it("says the rejection was stored when the server's storage error says so", () => {
    const stored = fail(
      coded(
        "STORAGE_ERROR",
        "The rejection of draft draft-1 was stored. Draft d2 has equal strikes."
      ),
      "reject"
    );
    expect(stored).toEqual({
      action: "close",
      aftermath: "result_not_known",
      text: "The server answered that this rejection was stored and that its store failed afterwards. Server detail: The rejection of draft draft-1 was stored. Draft d2 has equal strikes.",
    });
    expect(stored.text).not.toContain("not known whether");
    // The sentence the page looks for is the sentence the server writes.
    expect(
      readFileSync(
        new URL(
          "../../../../../packages/api/src/server/golive-drafts.ts",
          import.meta.url
        ),
        "utf8"
      )
    ).toMatch(/`The rejection of draft \$\{[^}]+\} was stored\. /u);
  });

  it("says the result is not known for a storage error that does not say what was stored", () =>
    expect(
      fail(coded("STORAGE_ERROR", "Draft d2 has equal strikes."), "reject")
    ).toEqual({
      action: "close",
      aftermath: "result_not_known",
      text: "The draft store failed during this rejection, so it is not known whether it was recorded. Server detail: Draft d2 has equal strikes.",
    }));

  it("does not show a validation text of the server on BAD_REQUEST", () =>
    expect(
      fail(coded("BAD_REQUEST", "Input validation failed: note"), "reject")
    ).toEqual({
      action: "stay",
      aftermath: "none",
      text: "The server refused this rejection as an invalid request. Nothing was recorded.",
    }));
});

describe("decisionAftermathText", () => {
  it("says what the reloaded queue shows for the draft", () => {
    expect(decisionAftermathText(null, "2026-11-11", true)).toBe(
      "The queue could not be read again, so the rows below may be out of date. Reload the queue before you decide again."
    );
    expect(decisionAftermathText(undefined, "2026-11-11", true)).toBe(
      "The queue was read again: this draft is not in the queue of 2026-11-11."
    );
    expect(
      decisionAftermathText(
        draft({ decidedAt: AT, decidedBy: "owner", state: "rejected" }),
        "2026-11-11",
        false
      )
    ).toBe(
      "The queue was read again: the draft is already decided. Its state is: Rejected by the owner (recorded). Decided 2026-11-11 10:30 ET by owner."
    );
    expect(
      decisionAftermathText(draft({ state: "expired" }), "2026-11-11", true)
    ).toBe(
      "The queue was read again: the draft is no longer proposed. Its state is: Expired: the generator no longer wants this draft."
    );
  });

  it("says no decision is recorded for a still-proposed draft only after a refusal", () =>
    expect(decisionAftermathText(draft(), "2026-11-11", true)).toBe(
      "The queue was read again: the draft is still proposed, so no decision is recorded for it."
    ));

  it("does not say that nothing is recorded when the result of the request is not known", () => {
    // The request may still be running on the server when this read answers "proposed".
    const text = decisionAftermathText(draft(), "2026-11-11", false);
    expect(text).toBe(
      "The queue was read again: the draft is still proposed in this read; the request may still complete. Reload before you decide again."
    );
    expect(text).not.toContain("no decision is recorded");
  });
});

describe("staleDialogReason", () => {
  // The dialog shows revision 3 of the draft (the fixture's revision).
  const approve = { draft: draft(), order: ORDER, type: "approve" as const };
  const reject = { draft: draft(), type: "reject" as const };

  it("finds nothing when the fresh row is the draft the dialog shows", () => {
    expect(staleDialogReason(approve, draft(), CONTEXT)).toBeNull();
    expect(staleDialogReason(reject, draft(), CONTEXT)).toBeNull();
    // A new object with the same order is still the same order.
    expect(
      staleDialogReason(
        approve,
        draft({
          order: { ...ORDER, legs: ORDER.legs.map((leg) => ({ ...leg })) },
        }),
        CONTEXT
      )
    ).toBeNull();
  });

  it("names a draft that is gone or no longer proposed, for approve and reject", () => {
    for (const decision of [approve, reject]) {
      expect(staleDialogReason(decision, undefined, CONTEXT)).toBe(
        "the draft is no longer in the queue"
      );
      expect(
        staleDialogReason(decision, draft({ state: "expired" }), CONTEXT)
      ).toBe(
        "the draft is no longer proposed (Expired: the generator no longer wants this draft)"
      );
    }
  });

  it("names the blockers of a draft that can no longer be approved; a rejection is not blocked by them", () => {
    const blocked = draft({
      notApprovable: ["PRECHECK_DENIED", "SIZED_TO_ZERO"],
    });
    expect(staleDialogReason(approve, blocked, CONTEXT)).toBe(
      "the draft can no longer be approved: the dry pre-check (web final gate) denied the order; the quantity is 0"
    );
    expect(staleDialogReason(reject, blocked, CONTEXT)).toBeNull();
    expect(
      staleDialogReason(approve, draft(), {
        plan: plan({ approvalBasis: null, status: "proposed" }),
        readAt: AT,
      })
    ).toBe(
      "the draft can no longer be approved: the plan is not approved: it is proposed"
    );
  });

  it.each([
    ["quantity", { ...ORDER, quantity: 3 }],
    ["limit", { ...ORDER, limitPrice: 2.36 }],
    ["symbol", { ...ORDER, symbol: "QQQ" }],
    [
      "strike",
      {
        ...ORDER,
        legs: ORDER.legs.map((leg, index) =>
          index === 0 ? { ...leg, strike: 451 } : leg
        ),
      },
    ],
    ["leg count", { ...ORDER, legs: ORDER.legs.slice(0, 1) }],
  ])(
    "names an order whose %s differs from the order the dialog shows",
    (_name, order) => {
      expect(staleDialogReason(approve, draft({ order }), CONTEXT)).toBe(
        "the order of the draft changed and is no longer the order the dialog showed"
      );
      expect(staleDialogReason(reject, draft({ order }), CONTEXT)).toBeNull();
    }
  );

  it("names a draft that was refreshed to another revision, for approve and reject, also with an equal order", () => {
    for (const decision of [approve, reject])
      expect(staleDialogReason(decision, draft({ revision: 4 }), CONTEXT)).toBe(
        "the draft was refreshed after the dialog opened (it is now revision 4; the dialog showed revision 3)"
      );
    expect(
      staleDialogReason(approve, draft({ revision: 3 }), CONTEXT)
    ).toBeNull();
  });

  describe("for Send approved order", () => {
    const approved = draft({
      approvedOrder: ORDER,
      send: "refused",
      state: "approved",
    });
    const send = { draft: approved, order: ORDER, type: "send" as const };

    it("finds nothing while the fresh row can still send the order the dialog shows", () => {
      expect(staleDialogReason(send, approved, CONTEXT)).toBeNull();
      // A newer revision of an approved row changes nothing about its stored order.
      expect(
        staleDialogReason(send, { ...approved, revision: 9 }, CONTEXT)
      ).toBeNull();
    });

    it("names a row that can no longer send, or that stores another order", () => {
      expect(staleDialogReason(send, undefined, CONTEXT)).toBe(
        "the draft is no longer in the queue"
      );
      expect(
        staleDialogReason(send, { ...approved, send: "unknown" }, CONTEXT)
      ).toBe(
        "the approved order can no longer be sent here (outcome unknown: the order may still reach IBKR. Check open orders at IBKR; the next order preview checks it)"
      );
      expect(
        staleDialogReason(
          send,
          { ...approved, send: null, state: "expired" },
          CONTEXT
        )
      ).toBe(
        `the approved order can no longer be sent here (${draftStateText("expired")})`
      );
      expect(
        staleDialogReason(
          send,
          { ...approved, approvedOrder: { ...ORDER, quantity: 1 } },
          CONTEXT
        )
      ).toBe(
        "the approved order changed and is no longer the order the dialog showed"
      );
      expect(
        staleDialogNotice("the draft is no longer in the queue", true)
      ).toBe(
        "A newer read of the queue shows that the draft is no longer in the queue. The open dialog was closed and nothing was sent."
      );
    });
  });

  it("puts the reason in a notice that says the dialog closed and nothing was recorded", () =>
    expect(staleDialogNotice("the draft is no longer in the queue")).toBe(
      "A newer read of the queue shows that the draft is no longer in the queue. The open dialog was closed and nothing was recorded."
    ));
});

describe("send of an approved entry", () => {
  it("has words for every send state, and names a value it does not know", () => {
    expect(SEND_STATE_WORDS).toEqual({
      not_found:
        "Not found at IBKR: the outcome was unknown and a later check did not find the order. Not sent again here; check the IBKR order history.",
      not_sent:
        "Not sent: no send of this order reached the order bridge (a send the checks here refused records nothing).",
      refused:
        "Not sent: the order bridge refused the last send before IBKR. It can be sent again.",
      not_taken:
        "Not placed: the order bridge answered that the last send was not taken (for example aborted). Not sent again here, since it may still be at IBKR under this ref; check open orders at IBKR.",
      sent: "Sent to IBKR: IBKR took the last send (submitted, or found there later).",
      unavailable:
        "Not known: the order records could not be read. Reload the queue; the send button needs a known state.",
      unknown:
        "Outcome unknown: the order may still reach IBKR. Check open orders at IBKR; the next order preview checks it.",
    });
    expect(sendStateText(future("queued"))).toContain("Send state ");
    expect(sendStateText(future("queued"))).toContain("queued");
  });

  it("offers a send only for an approved entry with its stored order, not sent or refused", () => {
    const approved = draft({ approvedOrder: ORDER, state: "approved" });
    for (const send of ["not_sent", "refused"] as const)
      expect(canSendApproved({ ...approved, send })).toBe(true);
    for (const send of [
      "sent",
      "unknown",
      "not_found",
      "unavailable",
      null,
    ] as const)
      expect(canSendApproved({ ...approved, send })).toBe(false);
    expect(
      canSendApproved({ ...approved, approvedOrder: null, send: "not_sent" })
    ).toBe(false);
    expect(
      canSendApproved({ ...approved, kind: "exit", send: "not_sent" })
    ).toBe(false);
    expect(
      canSendApproved({ ...approved, send: "not_sent", state: "proposed" })
    ).toBe(false);
  });

  it("repeats the stored order and the room its approval holds in the send dialog", () => {
    expect(
      sendSummaryRows(
        { approvedRoom: { maxLoss: 1250, maxLossPctNlv: 1.25 } },
        ORDER
      ).map((row) => row.label)
    ).toEqual(["Quantity", "Limit", "Max loss"]);
  });

  it("words the outcome of a resend without an approval", () => {
    const result = {
      message: "ok",
      mode: "live" as const,
      orderRef: "vertex-gl1",
      permId: 7,
      state: "submitted" as const,
    };
    expect(sendOutcomeText({ result, sent: true }, true)).toBe(
      "Sent to IBKR as one combo limit order (live, submitted, ref vertex-gl1). ok"
    );
    expect(
      sendOutcomeText(
        {
          result: {
            ...result,
            message:
              "Engine refused the opening: ENGINE_DISARMED: no_arm_record",
            permId: null,
            state: "engine_refused",
          },
          sent: true,
        },
        true
      )
    ).toBe(
      "Nothing was sent: the order bridge refused it before IBKR (ENGINE_DISARMED: no_arm_record). Its row shows whether it can be sent again."
    );
    expect(
      sendOutcomeText(
        { result: { ...result, state: "rejected" }, sent: true },
        true
      )
    ).toBe("IBKR did not take the order (rejected): ok");
    expect(sendOutcomeText({ message: "timeout", sent: "unknown" }, true)).toBe(
      "The send outcome is unknown (timeout). Check open orders at IBKR before doing anything else."
    );
    expect(
      sendOutcomeText(
        { reasons: ["GO-LIVE V3_NOT_ON_LIVE_PATH: off"], sent: false },
        true
      )
    ).toBe(
      "Nothing was sent: go-live sends are off because the order gateway does not report engine policy v3 (simulated gateway or an older bridge)."
    );
    expect(
      sendOutcomeText(
        {
          reasons: [
            "GO-LIVE ENGINE_DISARMED: approved, engine running-disarmed (checked T)",
          ],
          sent: false,
        },
        true
      )
    ).toBe(
      "Engine disarmed: nothing was sent (engine running-disarmed (checked T))."
    );
    expect(
      sendOutcomeText(
        { reasons: ["GO-LIVE DRAFT_ALREADY_SENT: already sent"], sent: false },
        true
      )
    ).toBe("Not sent: already sent.");
  });
});

describe("plan links", () => {
  it("accepts only an absolute https URL with a host", () => {
    expect(safeHttpsUrl("https://example.com/evidence")).toBe(
      "https://example.com/evidence"
    );
    for (const value of [
      null,
      "http://example.com/evidence",
      // The URL parser accepts these two and a browser resolves them on the app's own origin.
      "https:example.com",
      "https:/x",
      "https:///x",
      "https:// example.com",
      // Starts like a link and is no URL at all: the parser throws, and the answer is still null.
      "https://[",
      " https://example.com",
      "javascript:alert(1)",
      "data:text/html,x",
      "/relative",
      "//example.com/x",
      "not a url",
    ])
      expect(safeHttpsUrl(value)).toBeNull();
  });
});

describe("exitScheduleText", () => {
  it("names the loser day, the winner time and the closing combo", () => {
    expect(exitScheduleText(null)).toBeNull();
    const text = exitScheduleText({
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
    expect(text).toContain("Loser closes 2026-12-15");
    expect(text).toContain("3x SPY SELL 600C / BUY 610C");
  });
});

describe("sendOutcomeText", () => {
  it("leads with sends off, then a disarmed node, lists every other refusal, and never calls an unknown outcome not sent", () => {
    expect(
      sendOutcomeText({
        reasons: [
          "GO-LIVE V3_NOT_ON_LIVE_PATH: the order gateway does not report engine policy v3 on the live path (simulated gateway or an older bridge), so go-live sends are off; the approval is recorded",
          "GO-LIVE ENGINE_DISARMED: approved, engine running-disarmed (checked T); the owner arms the node",
        ],
        sent: false,
      })
    ).toBe(
      "Approved and recorded; nothing was sent: go-live sends are off because the order gateway does not report engine policy v3 (simulated gateway or an older bridge)."
    );
    expect(
      sendOutcomeText({
        reasons: [
          "GO-LIVE ENGINE_DISARMED: approved, engine running-disarmed (checked T); the owner arms the node",
          "GO-LIVE OPEN_RISK_CAP: over the total cap",
        ],
        sent: false,
      })
    ).toBe(
      "Approved, engine disarmed: nothing was sent (engine running-disarmed (checked T); the owner arms the node). Also: over the total cap."
    );
    expect(
      sendOutcomeText({
        reasons: ["GO-LIVE OPEN_RISK_CAP: over the total cap"],
        sent: false,
      })
    ).toBe("Approved, not sent: over the total cap.");
    expect(
      sendOutcomeText({ message: "Outcome unknown (timeout)", sent: "unknown" })
    ).toBe(
      "Approved; the send outcome is unknown (Outcome unknown (timeout)). Check open orders at IBKR before doing anything else."
    );
    expect(
      sendOutcomeText({
        result: {
          message: "Sent to IBKR (status Submitted).",
          mode: "live",
          orderRef: "vertex-abc",
          permId: null,
          state: "submitted",
        },
        sent: true,
      })
    ).toContain(
      "Approved and sent to IBKR as one combo limit order (live, submitted, ref vertex-abc)"
    );
    const result = {
      message: "m",
      mode: "live" as const,
      orderRef: "vertex-abc",
      permId: null,
    };
    expect(
      sendOutcomeText({
        result: { ...result, state: "unconfirmed" },
        sent: true,
      })
    ).toContain("(live, unconfirmed, ref vertex-abc)");
    expect(
      sendOutcomeText({ result: { ...result, state: "aborted" }, sent: true })
    ).toBe("Approved; IBKR did not take the order (aborted): m");
    const refused = (message: string) =>
      sendOutcomeText({
        result: { ...result, message, state: "engine_refused" },
        sent: true,
      });
    expect(
      refused(
        "Engine refused the opening: ENGINE_DISARMED: no_arm_record (the owner arms the node)"
      )
    ).toBe(
      "Approved; nothing was sent: the order bridge refused it before IBKR (ENGINE_DISARMED: no_arm_record (the owner arms the node)). Its row shows whether it can be sent again."
    );
    expect(
      refused(
        "Engine refused the opening at send time: V3_REFUSED snapshot_stale: old"
      )
    ).toBe(
      "Approved; nothing was sent: the order bridge refused it before IBKR (V3_REFUSED snapshot_stale: old). Its row shows whether it can be sent again."
    );
  });
});
