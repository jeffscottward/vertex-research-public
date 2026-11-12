import { describe, expect, it } from "vitest";

import { appContract } from "./contract.ts";
import {
  GOLIVE_COLLECT_MAX,
  GOLIVE_NOT_APPROVABLE_VALUES,
  GOLIVE_SIZING_REASON_VALUES,
  GOLIVE_STANDING_MAX_LOSS_PCT,
  GOLIVE_STANDING_NAME_CAP_PCT,
  GoLiveCollectInputSchema,
  GoLiveCollectOutputSchema,
  GoLiveDraftApproveInputSchema,
  GoLiveDraftRejectInputSchema,
  GoLivePlanSeedSchema,
  GoLiveQueueInputSchema,
  GoLiveQueueOutputSchema,
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
      }).success
    ).toBe(false);
  });

  it("needs the explicit confirmation and the exact order to approve", () => {
    const approval = { confirm: true, id: "d-spy", order: order() };
    expect(GoLiveDraftApproveInputSchema.parse(approval)).toEqual(approval);
    expect(
      GoLiveDraftApproveInputSchema.parse({ ...approval, note: "As shown" })
        .note
    ).toBe("As shown");
    for (const bad of [
      { ...approval, confirm: false },
      { id: "d-spy", order: order() },
      { confirm: true, id: "d-spy" },
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
    for (const bad of [
      { id: "d-spy" },
      { id: "d-spy", note: "" },
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

  it("names a cause for every state: no unknown reason", () => {
    for (const values of [
      GOLIVE_NOT_APPROVABLE_VALUES,
      GOLIVE_SIZING_REASON_VALUES,
    ])
      expect(values.filter((value) => /unknown/iu.test(value))).toEqual([]);
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
