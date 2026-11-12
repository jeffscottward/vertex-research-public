import { describe, expect, it } from "vitest";

import { appContract } from "./contract.ts";
import {
  GOLIVE_COLLECT_MAX,
  GOLIVE_DRAFT_LIST_MAX,
  GOLIVE_QUOTE_MAX_SPREAD_SHARE,
  GOLIVE_NOT_APPROVABLE_VALUES,
  GOLIVE_SIZING_REASON_VALUES,
  GOLIVE_STANDING_MAX_LOSS_PCT,
  GOLIVE_STANDING_NAME_CAP_PCT,
  GoLiveCollectInputSchema,
  GoLiveCollectOutputSchema,
  GoLiveDraftApproveInputSchema,
  GoLiveDraftRejectInputSchema,
  GoLiveDraftSchema,
  GoLivePlanSeedSchema,
  GoLiveQueueInputSchema,
  GoLiveQueueOutputSchema,
  goLiveStrikesFitStructure,
} from "./contracts/golive-drafts.ts";

const NOW = new Date("2026-11-13T21:30:00.000Z");
const OWNER_LINK = "https://discord.com/channels/1/2/3";
const EVIDENCE_LINK = "https://evidence.domain.test/report";

const sleeve = (key: string, budgetPct: number) => ({
  anchorDelta: 0.3,
  budgetPct,
  definitionNote: "Unchanged from the study.",
  definitionVariant: "as_studied",
  dteMin: 20,
  dteTarget: 35,
  key,
  name: key,
  runKey: `run-${key}`,
  structure: "callDebitVertical",
  symbols: ["SPY", "QQQ"],
  widthSigma: 1,
});

const seed = () => ({
  approvalBasis: "owner_delegation",
  approvedBy: "owner",
  evidenceUrl: EVIDENCE_LINK,
  id: "pie",
  limits: {
    maxPositions: 4,
    nameRiskCapPct: 2,
    openRiskCapPct: 6,
    positionRiskPct: 2,
  },
  name: "Lower-bar pie",
  ownerMessageUrl: OWNER_LINK,
  sleeves: [sleeve("trend", 4), sleeve("income", 2)],
  status: "approved",
});

// The body the rig generator pushes: times as ISO text.
const candidate = () => ({
  entryBasis: "signal_today",
  expiry: "20261218",
  longStrike: 100,
  quote: {
    asOf: "2026-11-13T21:29:30.000Z",
    longAsk: 2.4,
    longBid: 2.3,
    shortAsk: 1.15,
    shortBid: 1.05,
    source: "yahoo_delayed_snapshot",
  },
  shortStrike: 105,
  signalFacts: ["VIX 19.5 on 2026-11-13"],
  sleeveKey: "trend",
  structure: "callDebitVertical",
  symbol: "SPY",
});

const batch = () => ({
  candidates: [candidate()],
  generatedAt: "2026-11-13T21:00:00.000Z",
  planId: "pie",
  planVersion: 1,
  tradingDay: "2026-11-16",
});

const order = () => ({
  legs: [
    { expiry: "20261218", ratio: 1, right: "C", side: "BUY", strike: 100 },
    { expiry: "20261218", ratio: 1, right: "C", side: "SELL", strike: 105 },
  ],
  limitPrice: 1.25,
  quantity: 16,
  symbol: "SPY",
});

// A proposed draft as the queue returns it, sized.
const draft = () => ({
  approvedOrder: null,
  approvedRoom: null,
  createdAt: NOW,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  entryBasis: "signal_today",
  exitReason: null,
  exitRule: "owner_standing_rule_v1",
  expiry: "20261218",
  id: "d-spy",
  kind: "entry",
  longStrike: 100,
  nodeBadgeAtDecision: null,
  notApprovable: [],
  notes: [],
  order: order(),
  parentDraftId: null,
  planId: "pie",
  planVersion: 1,
  preCheck: {
    enginePolicy: "not_evaluated_not_in_web_order_path",
    webFinalGate: null,
  },
  quote: null,
  revision: 1,
  shortStrike: 105,
  signalFacts: [],
  sizing: {
    budget: 2000,
    limitPrice: 1.25,
    maxLoss: 2000,
    maxLossPctNlv: 2,
    maxLossPerSpread: 125,
    quantity: 16,
    reason: "sized",
  },
  sleeveKey: "trend",
  state: "proposed",
  structure: "callDebitVertical",
  symbol: "SPY",
  tradingDay: "2026-11-16",
  updatedAt: NOW,
});

// The plan record as the queue returns it.
const planOutput = () => ({
  ...seed(),
  approvedAt: NOW,
  createdAt: NOW,
  exitRule: "owner_standing_rule_v1",
  retiredAt: null,
  updatedAt: NOW,
  version: 1,
});

const issuesOf = (value: unknown): string[] =>
  (GoLivePlanSeedSchema.safeParse(value).error?.issues ?? []).map(
    (issue) => issue.message
  );

describe("goLiveDrafts contract", () => {
  it("is registered with queue, collect, approve and reject, and no send route", () => {
    expect(Object.keys(appContract.goLiveDrafts).sort()).toEqual([
      "approve",
      "collect",
      "queue",
      "reject",
    ]);
    const routes = Object.fromEntries(
      Object.entries(appContract.goLiveDrafts).map(([name, procedure]) => {
        const { method, operationId, path } = procedure["~orpc"].route;
        return [name, { method, operationId, path }];
      })
    );
    expect(routes).toEqual({
      approve: {
        method: "POST",
        operationId: "goLiveDrafts.approve",
        path: "/golive-drafts/{id}/approve",
      },
      collect: {
        method: "POST",
        operationId: "goLiveDrafts.collect",
        path: "/golive-drafts/collect",
      },
      // GET: the agent viewer's read-only rule admits it.
      queue: {
        method: "GET",
        operationId: "goLiveDrafts.queue",
        path: "/golive-drafts/queue",
      },
      reject: {
        method: "POST",
        operationId: "goLiveDrafts.reject",
        path: "/golive-drafts/{id}/reject",
      },
    });
  });

  it("takes an optional trading day for the queue", () => {
    expect(GoLiveQueueInputSchema.parse({})).toEqual({});
    expect(GoLiveQueueInputSchema.parse({ tradingDay: "2026-11-16" })).toEqual({
      tradingDay: "2026-11-16",
    });
    for (const bad of [
      { tradingDay: "11/16/2026" },
      { tradingDay: "2026-13-01" },
      { limit: 5 },
    ])
      expect(GoLiveQueueInputSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts the generator's batch and reads its times as dates", () => {
    const parsed = GoLiveCollectInputSchema.parse(batch());
    expect(parsed.generatedAt).toEqual(new Date("2026-11-13T21:00:00.000Z"));
    expect(parsed.candidates[0]?.quote?.asOf).toEqual(
      new Date("2026-11-13T21:29:30.000Z")
    );
    expect(
      GoLiveCollectInputSchema.parse({
        ...batch(),
        candidates: [{ ...candidate(), quote: null, signalFacts: [] }],
      }).candidates[0]?.quote
    ).toBeNull();
    expect(
      GoLiveCollectInputSchema.parse({ ...batch(), candidates: [] }).candidates
    ).toEqual([]);
  });

  it("rejects malformed batches", () => {
    const one = candidate();
    for (const bad of [
      { ...batch(), extra: true },
      { ...batch(), planVersion: 0 },
      { ...batch(), planId: " " },
      { ...batch(), tradingDay: "tomorrow" },
      { ...batch(), generatedAt: "yesterday" },
      { ...batch(), candidates: [{ ...one, extra: 1 }] },
      // A vertical needs two different strikes.
      { ...batch(), candidates: [{ ...one, shortStrike: one.longStrike }] },
      { ...batch(), candidates: [{ ...one, longStrike: 0 }] },
      { ...batch(), candidates: [{ ...one, expiry: "2026-12-18" }] },
      { ...batch(), candidates: [{ ...one, symbol: "spy" }] },
      { ...batch(), candidates: [{ ...one, structure: "ironCondor" }] },
      { ...batch(), candidates: [{ ...one, entryBasis: "hunch" }] },
      { ...batch(), candidates: [{ ...one, sleeveKey: "" }] },
      {
        ...batch(),
        candidates: [{ ...one, quote: { ...one.quote, source: "broker" } }],
      },
      {
        ...batch(),
        candidates: [{ ...one, quote: { ...one.quote, longBid: -0.01 } }],
      },
      // The generator sends no size and no limit: the server computes them.
      { ...batch(), candidates: [{ ...one, quantity: 3 }] },
      { ...batch(), candidates: [{ ...one, limitPrice: 1.25 }] },
      {
        ...batch(),
        candidates: Array.from({ length: GOLIVE_COLLECT_MAX + 1 }, () => one),
      },
    ])
      expect(GoLiveCollectInputSchema.safeParse(bad).success).toBe(false);
    expect(
      GoLiveCollectOutputSchema.safeParse({
        created: 1,
        expired: 0,
        submitted: 1,
        unchanged: 0,
        updated: 0,
      }).success
    ).toBe(false);
  });

  it("answers a collect with four counters, each of them required", () => {
    const answer = { created: 1, expired: 2, unchanged: 3, updated: 4 };
    expect(GoLiveCollectOutputSchema.parse(answer)).toEqual(answer);
    for (const key of ["created", "expired", "unchanged", "updated"] as const) {
      const { [key]: _left, ...without } = answer;
      expect(GoLiveCollectOutputSchema.safeParse(without).success).toBe(false);
      for (const bad of [-1, 0.5, null, "1"])
        expect(
          GoLiveCollectOutputSchema.safeParse({ ...answer, [key]: bad }).success
        ).toBe(false);
    }
  });

  it("reads a time only from ISO-8601 date-time text with an offset", () => {
    const withTimes = (
      asOf: unknown,
      generatedAt: unknown = "2026-11-13T21:00:00Z"
    ) => ({
      ...batch(),
      candidates: [{ ...candidate(), quote: { ...candidate().quote, asOf } }],
      generatedAt,
    });
    // What the generator sends, with fractions, and with a numeric offset.
    for (const [text, instant] of [
      ["2026-11-11T20:45:02Z", "2026-11-11T20:45:02.000Z"],
      ["2026-11-11T20:45:02.123Z", "2026-11-11T20:45:02.123Z"],
      ["2026-11-11T15:45:02-05:00", "2026-11-11T20:45:02.000Z"],
    ] as const) {
      const parsed = GoLiveCollectInputSchema.parse(withTimes(text, text));
      expect(parsed.candidates[0]?.quote?.asOf).toEqual(new Date(instant));
      expect(parsed.generatedAt).toEqual(new Date(instant));
    }
    // null and true were read as 1970 before; a time without an offset has no fixed instant.
    for (const bad of [
      null,
      true,
      false,
      0,
      1_794_429_902_000,
      "",
      "yesterday",
      "2026-11-11",
      "2026-11-11T20:45:02",
      "2026-11-11 20:45:02Z",
      "2026-02-30T20:45:02Z",
      new Date("2026-11-11T20:45:02Z"),
    ]) {
      expect(collectIssues(withTimes(bad))).not.toEqual([]);
      expect(collectIssues(withTimes("2026-11-11T20:45:02Z", bad))).not.toEqual(
        []
      );
    }
  });

  const collectIssues = (value: unknown): string[] =>
    (GoLiveCollectInputSchema.safeParse(value).error?.issues ?? []).map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`
    );

  it("accepts strikes only the right way round for the structure", () => {
    // [structure, long strike, short strike]. A bull vertical (call debit, put credit) buys the
    // lower strike; a bear vertical (put debit, call credit) buys the higher strike.
    const right = [
      ["callDebitVertical", 100, 105],
      ["putCreditVertical", 95, 100],
      ["putDebitVertical", 105, 100],
      ["callCreditVertical", 105, 100],
    ] as const;
    for (const [structure, longStrike, shortStrike] of right) {
      expect(
        goLiveStrikesFitStructure(structure, longStrike, shortStrike)
      ).toBe(true);
      expect(
        goLiveStrikesFitStructure(structure, shortStrike, longStrike)
      ).toBe(false);
      expect(goLiveStrikesFitStructure(structure, longStrike, longStrike)).toBe(
        false
      );
      const withStrikes = (long: number, short: number) => ({
        ...batch(),
        candidates: [
          { ...candidate(), longStrike: long, shortStrike: short, structure },
        ],
      });
      expect(collectIssues(withStrikes(longStrike, shortStrike))).toEqual([]);
      expect(collectIssues(withStrikes(shortStrike, longStrike))).toEqual([
        "candidates.0: The long and short strikes are the wrong way round for this structure",
      ]);
    }
  });

  it("takes an expiry only when it is a real calendar day after the trading day", () => {
    const withExpiry = (expiry: string) => ({
      ...batch(),
      candidates: [{ ...candidate(), expiry }],
    });
    // The day after the trading day, a later day, and 29 February of a leap year.
    for (const expiry of ["20261117", "20261218", "20280229"])
      expect(collectIssues(withExpiry(expiry))).toEqual([]);
    for (const expiry of [
      "20261399",
      "20260230",
      "20270229",
      "20261200",
      "20261131",
    ])
      expect(collectIssues(withExpiry(expiry))).toContain(
        "candidates.0.expiry: Expiry must be a real calendar day"
      );
    // The trading day itself, the day before, and a day long past.
    for (const expiry of ["20261116", "20261115", "20250117"])
      expect(collectIssues(withExpiry(expiry))).toEqual([
        "candidates.0.expiry: The expiry must be after the trading day",
      ]);
    // Each candidate is checked: the second one is named.
    expect(
      collectIssues({
        ...batch(),
        candidates: [candidate(), { ...candidate(), expiry: "20261116" }],
      })
    ).toEqual([
      "candidates.1.expiry: The expiry must be after the trading day",
    ]);
  });

  it("needs the explicit confirmation and the exact order to approve", () => {
    const approval = {
      confirm: true,
      id: "d-spy",
      order: order(),
      revision: 3,
    };
    expect(GoLiveDraftApproveInputSchema.parse(approval)).toEqual(approval);
    expect(
      GoLiveDraftApproveInputSchema.parse({ ...approval, note: "As shown" })
        .note
    ).toBe("As shown");
    for (const bad of [
      { ...approval, confirm: false },
      { id: "d-spy", order: order(), revision: 3 },
      { confirm: true, id: "d-spy", revision: 3 },
      // The revision of the draft the owner read: required, a whole number above 0.
      { confirm: true, id: "d-spy", order: order() },
      { ...approval, revision: 0 },
      { ...approval, revision: -1 },
      { ...approval, revision: 1.5 },
      { ...approval, revision: "3" },
      { ...approval, revision: null },
      { ...approval, order: { ...order(), limitPrice: 0 } },
      { ...approval, order: { ...order(), quantity: 0 } },
      { ...approval, order: { ...order(), legs: order().legs.slice(0, 1) } },
      { ...approval, send: true },
      { ...approval, note: "x".repeat(1001) },
    ])
      expect(GoLiveDraftApproveInputSchema.safeParse(bad).success).toBe(false);
  });

  it("needs a note to reject", () => {
    expect(
      GoLiveDraftRejectInputSchema.parse({ id: "d-spy", note: "Too close" })
    ).toEqual({ id: "d-spy", note: "Too close" });
    // The note is stored without the blanks around it.
    expect(
      GoLiveDraftRejectInputSchema.parse({
        id: "d-spy",
        note: "  Too close \n",
      })
    ).toEqual({ id: "d-spy", note: "Too close" });
    for (const bad of [
      { id: "d-spy" },
      { id: "d-spy", note: "" },
      // Blanks alone are no note.
      { id: "d-spy", note: " " },
      { id: "d-spy", note: " \t\n " },
      { id: "d-spy", note: "x".repeat(1001) },
      { id: "", note: "Too close" },
      { id: "d-spy", note: "Too close", order: order() },
    ])
      expect(GoLiveDraftRejectInputSchema.safeParse(bad).success).toBe(false);
  });

  it("describes a queue that cannot send and never shows an account value of 0", () => {
    const queue = {
      account: {
        asOf: null,
        netLiquidation: null,
        unavailableReason: "Portfolio monitor did not answer",
      },
      canDecide: false,
      drafts: [],
      generatedAt: null,
      marketNotes: "feature_not_deployed",
      node: { armedAt: null, badge: "unknown", checkedAt: NOW },
      plan: null,
      sendsOrders: false,
      tradingDay: "2026-11-16",
    };
    expect(GoLiveQueueOutputSchema.parse(queue)).toEqual(queue);
    for (const bad of [
      { ...queue, sendsOrders: true },
      { ...queue, account: { ...queue.account, netLiquidation: 0 } },
      { ...queue, node: { ...queue.node, badge: "armed" } },
      { ...queue, marketNotes: "unknown" },
      { ...queue, submitted: [] },
    ])
      expect(GoLiveQueueOutputSchema.safeParse(bad).success).toBe(false);
  });

  it("always says whether the caller may decide", () => {
    const queue = {
      account: { asOf: null, netLiquidation: null, unavailableReason: null },
      canDecide: true,
      drafts: [],
      generatedAt: null,
      marketNotes: "none_active",
      node: { armedAt: null, badge: "unknown", checkedAt: NOW },
      plan: null,
      sendsOrders: false,
      tradingDay: "2026-11-16",
    };
    for (const canDecide of [true, false])
      expect(
        GoLiveQueueOutputSchema.parse({ ...queue, canDecide }).canDecide
      ).toBe(canDecide);
    // Required and a boolean: an answer without it, or with a guess, is refused.
    const { canDecide: _canDecide, ...without } = queue;
    for (const bad of [
      without,
      { ...queue, canDecide: null },
      { ...queue, canDecide: "true" },
      { ...queue, canDecide: 1 },
    ])
      expect(GoLiveQueueOutputSchema.safeParse(bad).success).toBe(false);
  });

  it("carries the approved order of a draft, or null, and never leaves it out", () => {
    expect(GoLiveDraftSchema.parse(draft())).toEqual(draft());
    const approved = {
      ...draft(),
      approvedOrder: order(),
      approvedRoom: { maxLoss: 2000, maxLossPctNlv: 2 },
      revision: 2,
      state: "approved",
    };
    expect(GoLiveDraftSchema.parse(approved)).toEqual(approved);
    // The approved order and today's order are separate fields: one can be null without the other.
    const unsizedToday = { ...approved, order: null };
    expect(GoLiveDraftSchema.parse(unsizedToday)).toEqual(unsizedToday);
    const { approvedOrder: _approvedOrder, ...without } = draft();
    for (const bad of [
      without,
      { ...draft(), approvedOrder: {} },
      { ...draft(), approvedOrder: "16 x 1.25" },
      { ...draft(), approvedOrder: { ...order(), quantity: 0 } },
      { ...draft(), approvedOrder: { ...order(), limitPrice: 0 } },
      { ...draft(), approvedOrder: { ...order(), legs: [] } },
      { ...draft(), approvedOrder: { ...order(), sent: true } },
    ])
      expect(GoLiveDraftSchema.safeParse(bad).success).toBe(false);
  });

  it("carries the revision of a draft: a whole number above 0", () => {
    for (const revision of [1, 2, 4711])
      expect(GoLiveDraftSchema.parse({ ...draft(), revision }).revision).toBe(
        revision
      );
    const { revision: _revision, ...without } = draft();
    for (const bad of [
      without,
      { ...draft(), revision: 0 },
      { ...draft(), revision: -1 },
      { ...draft(), revision: 1.5 },
      { ...draft(), revision: "1" },
      { ...draft(), revision: null },
    ])
      expect(GoLiveDraftSchema.safeParse(bad).success).toBe(false);
  });

  it("carries the room an approved draft holds, or null, and never leaves it out", () => {
    const withRoom = (approvedRoom: unknown) => ({ ...draft(), approvedRoom });
    // The share of the account value is null when the account value is unavailable.
    for (const room of [
      null,
      { maxLoss: 882, maxLossPctNlv: 8.82 },
      { maxLoss: 882, maxLossPctNlv: null },
    ])
      expect(GoLiveDraftSchema.parse(withRoom(room))).toEqual(withRoom(room));
    const { approvedRoom: _approvedRoom, ...without } = draft();
    for (const bad of [
      without,
      withRoom({}),
      withRoom(882),
      withRoom({ maxLoss: 882 }),
      withRoom({ maxLossPctNlv: 8.82 }),
      withRoom({ maxLoss: null, maxLossPctNlv: 8.82 }),
      withRoom({ maxLoss: Number.POSITIVE_INFINITY, maxLossPctNlv: 1 }),
      withRoom({ maxLoss: 882, maxLossPctNlv: 8.82, quantity: 6 }),
    ])
      expect(GoLiveDraftSchema.safeParse(bad).success).toBe(false);
  });

  it("sets the widest usable market at half of the mid", () => {
    expect(GOLIVE_QUOTE_MAX_SPREAD_SHARE).toBe(0.5);
  });

  it("returns a plan only with a Discord message link and an https evidence link, or without them", () => {
    const queue = {
      account: { asOf: null, netLiquidation: null, unavailableReason: null },
      canDecide: false,
      drafts: [],
      generatedAt: null,
      marketNotes: "none_active",
      node: { armedAt: null, badge: "unknown", checkedAt: NOW },
      plan: planOutput(),
      sendsOrders: false,
      tradingDay: "2026-11-16",
    };
    expect(GoLiveQueueOutputSchema.parse(queue)).toEqual(queue);
    const withPlan = (links: Record<string, string | null>) => ({
      ...queue,
      plan: { ...planOutput(), ...links },
    });
    const withoutLinks = withPlan({ evidenceUrl: null, ownerMessageUrl: null });
    expect(GoLiveQueueOutputSchema.parse(withoutLinks)).toEqual(withoutLinks);
    for (const links of [
      { ownerMessageUrl: "https://discord.com/channels/1/2" },
      { ownerMessageUrl: "https://discord.com.evil.test/channels/1/2/3" },
      { ownerMessageUrl: "javascript:alert(document.domain)" },
      { ownerMessageUrl: "" },
      { evidenceUrl: "http://evidence.domain.test/report" },
      { evidenceUrl: "javascript:alert(document.domain)" },
      { evidenceUrl: "evidence report" },
      // The URL parser accepts these; a browser resolves them on the app's own origin.
      { evidenceUrl: "https:example.com" },
      { evidenceUrl: "https:/example.com/report" },
      { evidenceUrl: "" },
    ])
      expect(GoLiveQueueOutputSchema.safeParse(withPlan(links)).success).toBe(
        false
      );
  });

  it("names a cause for every state: no unknown reason", () => {
    for (const values of [
      GOLIVE_NOT_APPROVABLE_VALUES,
      GOLIVE_SIZING_REASON_VALUES,
    ])
      expect(values.filter((value) => /unknown/iu.test(value))).toEqual([]);
    // A quantity above what one order may hold has its own reason and quantity 0.
    const aboveLimit = {
      ...draft(),
      order: null,
      sizing: {
        budget: 12_000,
        limitPrice: 0.01,
        maxLoss: null,
        maxLossPctNlv: null,
        maxLossPerSpread: 1,
        quantity: 0,
        reason: "quantity_above_order_limit",
      },
    };
    expect(GoLiveDraftSchema.parse(aboveLimit)).toEqual(aboveLimit);
  });

  it("lists at most GOLIVE_DRAFT_LIST_MAX drafts of one trading day", () => {
    const queue = (count: number) => ({
      account: { asOf: null, netLiquidation: null, unavailableReason: null },
      canDecide: false,
      drafts: Array.from({ length: count }, (_unused, index) => ({
        ...draft(),
        id: `d-${index}`,
      })),
      generatedAt: null,
      marketNotes: "none_active",
      node: { armedAt: null, badge: "unknown", checkedAt: NOW },
      plan: null,
      sendsOrders: false,
      tradingDay: "2026-11-16",
    });
    expect(GOLIVE_DRAFT_LIST_MAX).toBe(200);
    expect(
      GoLiveQueueOutputSchema.safeParse(queue(GOLIVE_DRAFT_LIST_MAX)).success
    ).toBe(true);
    expect(
      GoLiveQueueOutputSchema.safeParse(queue(GOLIVE_DRAFT_LIST_MAX + 1))
        .success
    ).toBe(false);
  });
});

describe("go-live plan seed", () => {
  it("accepts an approved plan with both links and a proposed plan without them", () => {
    expect(issuesOf(seed())).toEqual([]);
    expect(
      issuesOf({
        ...seed(),
        approvalBasis: "owner_decision",
        evidenceUrl: null,
      })
    ).toEqual([]);
    expect(
      issuesOf({
        ...seed(),
        approvalBasis: null,
        approvedBy: null,
        evidenceUrl: null,
        ownerMessageUrl: null,
        status: "proposed",
      })
    ).toEqual([]);
  });

  it("keeps the standing risk rules as upper limits", () => {
    expect(GOLIVE_STANDING_MAX_LOSS_PCT).toBe(2);
    expect(GOLIVE_STANDING_NAME_CAP_PCT).toBe(2);
    const limits = seed().limits;
    for (const looser of [
      { ...limits, positionRiskPct: 2.01 },
      { ...limits, nameRiskCapPct: 2.01 },
      { ...limits, openRiskCapPct: 0 },
      { ...limits, maxPositions: 0 },
    ])
      expect(
        GoLivePlanSeedSchema.safeParse({ ...seed(), limits: looser }).success
      ).toBe(false);
  });

  it("refuses an approval without its basis, its owner link or its evidence", () => {
    expect(issuesOf({ ...seed(), approvalBasis: null })).toEqual([
      "approvalBasis is set exactly when the plan is approved",
    ]);
    expect(issuesOf({ ...seed(), status: "proposed" })).toEqual([
      "approvalBasis is set exactly when the plan is approved",
    ]);
    expect(issuesOf({ ...seed(), ownerMessageUrl: null })).toEqual([
      "An approved plan needs the owner message link and approvedBy",
    ]);
    expect(issuesOf({ ...seed(), approvedBy: null })).toEqual([
      "An approved plan needs the owner message link and approvedBy",
    ]);
    expect(issuesOf({ ...seed(), evidenceUrl: null })).toEqual([
      "A plan approved by delegation needs the evidence link",
    ]);
    // A channel link is not a message link; the evidence link must be https.
    expect(
      GoLivePlanSeedSchema.safeParse({
        ...seed(),
        ownerMessageUrl: "https://discord.com/channels/1/2",
      }).success
    ).toBe(false);
    expect(
      GoLivePlanSeedSchema.safeParse({
        ...seed(),
        evidenceUrl: "http://evidence.domain.test/report",
      }).success
    ).toBe(false);
    // The evidence link starts with the text "https://". The URL parser alone accepts
    // "https:example.com", which a browser resolves on the app's own origin.
    for (const evidenceUrl of [
      "https://example.com/report",
      "https://evidence.domain.test/a?b=1#c",
    ])
      expect(issuesOf({ ...seed(), evidenceUrl })).toEqual([]);
    for (const evidenceUrl of [
      "https:example.com",
      "https:/example.com/report",
      "https:///example.com/report",
      "//example.com/report",
      "/report",
    ])
      expect(
        GoLivePlanSeedSchema.safeParse({ ...seed(), evidenceUrl }).success
      ).toBe(false);
    expect(issuesOf({ ...seed(), evidenceUrl: "https:example.com" })).toContain(
      "Evidence link must start with https://"
    );
  });

  it("refuses sleeves that break the plan's own limits", () => {
    expect(
      issuesOf({
        ...seed(),
        sleeves: [sleeve("trend", 4), sleeve("income", 3)],
      })
    ).toEqual(["Sleeve budgets add up to more than the open risk cap"]);
    expect(
      issuesOf({ ...seed(), sleeves: [sleeve("trend", 3), sleeve("trend", 3)] })
    ).toEqual(["Sleeve keys must be unique"]);
    expect(
      issuesOf({
        ...seed(),
        sleeves: [{ ...sleeve("trend", 4), dteMin: 40 }],
      })
    ).toEqual(["dteMin must not be above dteTarget"]);
    expect(
      GoLivePlanSeedSchema.safeParse({
        ...seed(),
        sleeves: [{ ...sleeve("trend", 4), key: "Trend Sleeve" }],
      }).success
    ).toBe(false);
  });
});
