import { describe, expect, it } from "vitest";
import type {
  AcceptedReview,
  PaperSimulationAdmission,
  StrategySpec,
  TradeIntent,
} from "@darkfactory/api/vertex";
import { createReadResource } from "../../components/research/read-resource.ts";
import type {
  ExperienceScope,
  ImmutableArtifact,
  SimulationQueueReceipt,
} from "./ports.ts";
import {
  buildReviewDecisionCommand,
  buildReviewModel,
  buildSimulationProposalCommand,
  isExactStrategySelection,
  strategySelectionKey,
  validateReviewResponse,
  validateSimulationQueueReceipt,
  type ReviewContext,
  type ReviewTarget,
} from "./review-model.ts";

// Deliberately authored fixtures, not provider evidence or production admissions.
const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const now = "2026-09-22T12:00:00Z";
const before = "2026-09-22T11:59:00Z";
const expires = "2026-09-22T12:10:00Z";
const scope: ExperienceScope = {
  accountAlias: "fixture-account",
  environment: "paper",
};
const target: ReviewTarget = {
  artifactId: "draft-artifact-1",
  sha256: hash,
  strategyVersion: "strategy-artifact-1",
};
const strategy: ImmutableArtifact<StrategySpec> = {
  artifactId: target.strategyVersion,
  sha256: otherHash,
  value: {
    schemaVersion: "1.0.0",
    strategyId: "fixture-strategy",
    version: "1.0.0",
    sleeve: "quant",
    hypothesis: "Authored regression fixture only",
    universe: ["FIXTURE"],
    signalSchedule: {
      calendar: "fixture-calendar",
      timezone: "UTC",
      interval: "bar-close",
    },
    entryRules: [
      {
        ruleId: "entry",
        featureId: "fixture",
        operator: "gte",
        threshold: "1",
        lookbackBars: 1,
      },
    ],
    exitRules: [
      {
        ruleId: "exit",
        featureId: "fixture",
        operator: "lt",
        threshold: "1",
        lookbackBars: 1,
      },
    ],
    riskLimits: {
      maximumLoss: "1",
      maximumNotional: "10",
      maximumPositions: 1,
    },
    requiredData: [
      {
        kind: "quotes",
        maximumAgeMs: 60_000,
        pointInTimeRequired: true,
        entitlementPolicyId: "fixture-policy",
      },
    ],
    costModel: {
      commissionPerUnit: "0",
      spreadBps: "1",
      slippageBps: "1",
      borrowAnnualBps: "0",
      impactModel: "fixed-bps",
      maximumParticipationBps: "1",
    },
    codeDigest: hash,
  },
};
const draft: ImmutableArtifact<TradeIntent> = {
  artifactId: target.artifactId,
  sha256: target.sha256,
  value: {
    schemaVersion: "1.0.0",
    intentId: "fixture-intent-1",
    idempotencyKey: "fixture-draft-request",
    correlationId: "fixture-correlation",
    proposalOnly: true,
    executionAuthorized: false,
    strategyVersion: target.strategyVersion,
    accountAlias: scope.accountAlias,
    environment: "paper",
    instrumentId: "FIXTURE",
    side: "buy",
    quantity: "1",
    orderType: "limit",
    limitPrice: "1",
    stopPrice: null,
    tickSize: "0.01",
    timeInForce: "DAY",
    quoteAsOf: before,
    referenceQuote: {
      schemaVersion: "1.0.0",
      quoteId: "fixture-quote",
      instrumentId: "FIXTURE",
      currency: "USD",
      bid: "1",
      ask: "1",
      bidSize: "1",
      askSize: "1",
      lastPrice: "1",
      sourceTimestamp: before,
      receivedAt: before,
      source: {
        identity: {
          provider: "fixture-provider",
          sourceId: "fixture-source",
          snapshotId: "fixture-snapshot",
          contentHash: hash,
        },
        dataKind: "real",
        syntheticReason: null,
        providerTimezone: "UTC",
        entitlement: {
          policyId: "fixture-policy",
          status: "granted",
          checkedAt: before,
          expiresAt: expires,
        },
        freshness: {
          status: "fresh",
          observedAt: before,
          evaluatedAt: before,
          maxAgeMs: 60_000,
        },
      },
    },
    proposedAt: before,
    reasonEvidenceIds: ["fixture-evidence"],
    maxLossBudget: "1",
    expiresAt: expires,
  },
};
const review = (overrides: Partial<AcceptedReview> = {}): AcceptedReview => ({
  schemaVersion: "1.0.0",
  reviewId: "review-1",
  accountAlias: scope.accountAlias,
  environment: "paper",
  collectionId: null,
  artifactId: target.artifactId,
  artifactSha256: target.sha256,
  reviewVersion: "1.0.0",
  decision: "accepted",
  purpose: "paper-simulation",
  actorId: "server-actor",
  reviewedAt: before,
  expiresAt: expires,
  policyVersion: "1.0.0",
  strategyVersion: target.strategyVersion,
  supersedesReviewId: null,
  executionAuthorized: false,
  ...overrides,
});
const admission = (
  overrides: Partial<PaperSimulationAdmission> = {}
): PaperSimulationAdmission => ({
  schemaVersion: "1.0.0",
  admissionId: "admission-1",
  admissionKind: "PAPER-SIMULATION",
  accountAlias: scope.accountAlias,
  environment: "paper",
  simulatorId: "fixture-simulator",
  streamId: "fixture-stream",
  ownerEpoch: "1",
  intentId: draft.value.intentId,
  intentSha256: draft.sha256,
  reviewedArtifactSha256: draft.sha256,
  reviewId: "review-1",
  reviewVersion: "1.0.0",
  actorId: "server-actor",
  policyVersion: "1.0.0",
  strategyVersion: target.strategyVersion,
  portfolioSnapshotId: "fixture-portfolio",
  portfolioSequence: "1",
  maximumLoss: "1",
  maximumNotional: "10",
  admittedAt: before,
  expiresAt: expires,
  idempotencyKey: "server-simulation-request",
  simulationOnly: true,
  brokerSubmissionAllowed: false,
  liveAuthorization: false,
  executionAuthorized: false,
  ...overrides,
});
const context = (overrides: Partial<ReviewContext> = {}): ReviewContext => ({
  scope,
  target,
  purpose: "paper-simulation",
  reviews: [review()],
  now,
  ...overrides,
});
const decisionInput = () => ({
  ...context(),
  decision: "accepted" as const,
  acknowledged: true,
  acknowledgedTarget: target,
  expectedReviewId: "review-1",
  idempotencyKey: "fixture-review-command",
});
const simulationInput = () => ({
  scope,
  strategy,
  draft,
  reviews: [review()],
  admission: admission(),
  acknowledged: true,
  acknowledgedAdmissionId: "admission-1",
  now,
});

// Client models narrow presentation only; no fixture can exercise a broker port.
describe("exact immutable strategy and review binding", () => {
  it("uses the immutable artifact ID, not semantic StrategySpec.version", () => {
    expect(
      isExactStrategySelection(
        { artifactId: strategy.artifactId, sha256: strategy.sha256 },
        strategy
      )
    ).toBe(true);
    expect(
      isExactStrategySelection(
        { artifactId: strategy.value.version, sha256: strategy.sha256 },
        strategy
      )
    ).toBe(false);
    expect(
      isExactStrategySelection(
        { artifactId: strategy.artifactId, sha256: hash },
        strategy
      )
    ).toBe(false);
    return expect(
      buildReviewModel(
        context({
          reviews: [review({ strategyVersion: strategy.value.version })],
        })
      ).status
    ).toBe("invalid");
  });
  it("rejects review hash and exact strategyVersion mismatches", () => {
    expect(
      buildReviewModel(
        context({ reviews: [review({ artifactSha256: otherHash })] })
      ).status
    ).toBe("invalid");
    expect(
      buildReviewModel(
        context({
          reviews: [review({ strategyVersion: "another-strategy-artifact" })],
        })
      ).status
    ).toBe("invalid");
    return expect(
      buildReviewModel(context({ target: { ...target, sha256: "not-a-hash" } }))
        .status
    ).toBe("invalid");
  });
  it("does not transfer acceptance to another artifact, scope or purpose", () => {
    expect(
      buildReviewModel(
        context({ target: { ...target, artifactId: "draft-artifact-2" } })
      ).status
    ).toBe("unreviewed");
    expect(
      buildReviewModel(
        context({ scope: { ...scope, accountAlias: "other-account" } })
      ).status
    ).toBe("unreviewed");
    expect(buildReviewModel(context({ purpose: "research" })).status).toBe(
      "unreviewed"
    );
    return expect(
      buildReviewModel(
        context({ scope: { ...scope, environment: "research" } })
      ).status
    ).toBe("invalid");
  });
  it("requires explicit decision and the current exact-artifact acknowledgement", () => {
    expect(() =>
      buildReviewDecisionCommand({ ...decisionInput(), decision: null })
    ).toThrow("Choose accept or reject");
    expect(() =>
      buildReviewDecisionCommand({ ...decisionInput(), acknowledged: false })
    ).toThrow("Confirm the exact");
    expect(() =>
      buildReviewDecisionCommand({
        ...decisionInput(),
        acknowledgedTarget: { ...target, sha256: otherHash },
      })
    ).toThrow("Confirm the exact");
    expect(() =>
      buildReviewDecisionCommand({
        ...decisionInput(),
        acknowledgedTarget: { ...target, strategyVersion: "other-strategy" },
      })
    ).toThrow("Confirm the exact");
    return expect(() =>
      buildReviewDecisionCommand({ ...decisionInput(), expectedReviewId: null })
    ).toThrow("latest review changed");
  });
  return it("sends no invented actor, policy or expiry and preserves strict nonexecution", () => {
    const command = buildReviewDecisionCommand(decisionInput());
    expect(command).toEqual({
      ...scope,
      artifactId: target.artifactId,
      artifactSha256: hash,
      strategyVersion: target.strategyVersion,
      decision: "accepted",
      purpose: "paper-simulation",
      expectedReviewId: "review-1",
      idempotencyKey: "fixture-review-command",
    });
    expect(command).not.toHaveProperty("actorId");
    expect(command).not.toHaveProperty("expiresAt");
    expect(command).not.toHaveProperty("policyVersion");
    expect(draft.value.proposalOnly).toBe(true);
    return expect(draft.value.executionAuthorized).toBe(false);
  });
});

describe("latest review freshness and supersession", () => {
  it("retains latest rejection rather than restoring old acceptance", () => {
    const rejected = review({
      reviewId: "review-2",
      decision: "rejected",
      supersedesReviewId: "review-1",
      reviewedAt: now,
    });
    const model = buildReviewModel(context({ reviews: [rejected, review()] }));
    expect(model.status).toBe("rejected");
    expect(model.expectedReviewId).toBe("review-2");
    expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        reviews: [review(), rejected],
      })
    ).toThrow("current accepted");
    return expect(() =>
      buildReviewDecisionCommand({
        ...decisionInput(),
        reviews: [review(), rejected],
      })
    ).toThrow("latest review changed");
  });
  it("does not fall back when the latest review expires", () => {
    const expired = review({
      reviewId: "review-2",
      supersedesReviewId: "review-1",
      expiresAt: now,
    });
    const model = buildReviewModel(context({ reviews: [review(), expired] }));
    expect(model.status).toBe("expired");
    expect(model.expectedReviewId).toBe("review-2");
    return expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        reviews: [review(), expired],
      })
    ).toThrow("current accepted");
  });
  it("uses nanosecond precision and rejects the exact expiry boundary", () => {
    const exact = review({ expiresAt: "2026-09-22T12:00:00.000000001Z" });
    expect(buildReviewModel(context({ reviews: [exact] })).status).toBe(
      "accepted"
    );
    expect(
      buildReviewModel(context({ reviews: [exact], now: exact.expiresAt }))
        .status
    ).toBe("expired");
    return expect(
      buildReviewModel(
        context({ reviews: [exact], now: "2026-09-22T08:00:00-04:00" })
      ).status
    ).toBe("accepted");
  });
  it("rejects future, invalid, missing-predecessor, forked and duplicate history", () => {
    expect(
      buildReviewModel(
        context({ reviews: [review({ reviewedAt: "2026-09-22T12:01:00Z" })] })
      ).status
    ).toBe("invalid");
    expect(buildReviewModel(context({ now: "invalid" })).status).toBe(
      "invalid"
    );
    expect(
      buildReviewModel(
        context({ reviews: [review({ supersedesReviewId: "missing" })] })
      ).status
    ).toBe("invalid");
    const second = review({
      reviewId: "review-2",
      supersedesReviewId: "review-1",
    });
    const third = review({
      reviewId: "review-3",
      supersedesReviewId: "review-1",
    });
    expect(
      buildReviewModel(context({ reviews: [review(), second, third] })).status
    ).toBe("invalid");
    expect(
      buildReviewModel(context({ reviews: [review(), review()] })).status
    ).toBe("invalid");
    return expect(
      buildReviewModel(
        context({ reviews: [review(), review({ reviewId: "another-root" })] })
      ).status
    ).toBe("invalid");
  });
  it("rejects a disconnected cycle and reversed predecessor chronology", () => {
    const cyclicA = review({
      reviewId: "cycle-a",
      supersedesReviewId: "cycle-b",
    });
    const cyclicB = review({
      reviewId: "cycle-b",
      supersedesReviewId: "cycle-a",
    });
    expect(
      buildReviewModel(context({ reviews: [review(), cyclicA, cyclicB] }))
        .status
    ).toBe("invalid");
    return expect(
      buildReviewModel(
        context({
          reviews: [
            review({ reviewedAt: now }),
            review({ reviewId: "review-2", supersedesReviewId: "review-1" }),
          ],
        })
      ).status
    ).toBe("invalid");
  });
  return it("validates the server response against exact command purpose and predecessor", () => {
    const command = buildReviewDecisionCommand(decisionInput());
    const response = review({
      reviewId: "review-2",
      supersedesReviewId: "review-1",
    });
    expect(validateReviewResponse(command, response, now)).toBe(response);
    for (const bad of [
      review({ ...response, artifactSha256: otherHash }),
      review({ ...response, strategyVersion: "other-strategy" }),
      review({ ...response, purpose: "research" }),
      review({ ...response, supersedesReviewId: null }),
      review({ ...response, decision: "rejected" }),
      review({ ...response, expiresAt: now }),
    ]) {
      expect(() => validateReviewResponse(command, bad, now)).toThrow();
    }
  });
});

describe("paper simulation is separately admitted and never a live order", () => {
  it("queues only the exact server admission without changing draft flags", () => {
    const command = buildSimulationProposalCommand(simulationInput());
    expect(command).toEqual({
      accountAlias: scope.accountAlias,
      environment: "paper",
      admissionId: "admission-1",
      reviewId: "review-1",
      reviewVersion: "1.0.0",
      intentId: draft.value.intentId,
      intentSha256: hash,
      strategyVersion: strategy.artifactId,
      idempotencyKey: "server-simulation-request",
      simulationOnly: true,
      brokerSubmissionAllowed: false,
      liveAuthorization: false,
    });
    expect(command).not.toHaveProperty("quantity");
    expect(command).not.toHaveProperty("executionAuthorized");
    return expect(draft.value.executionAuthorized).toBe(false);
  });
  it("rejects research or live environments and research-purpose acceptance", () => {
    expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        scope: { ...scope, environment: "research" },
      })
    ).toThrow("matching paper");
    expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        scope: { ...scope, environment: "live" },
      })
    ).toThrow("matching paper");
    expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        reviews: [review({ purpose: "research" })],
      })
    ).toThrow("current accepted");
    return expect(() =>
      buildReviewDecisionCommand({
        ...decisionInput(),
        scope: { ...scope, environment: "live" },
        purpose: "research",
        reviews: [],
        expectedReviewId: null,
      })
    ).toThrow("observation-only");
  });
  it("rejects absent admissions, absent acknowledgement and another admission acknowledgement", () => {
    expect(() =>
      buildSimulationProposalCommand({ ...simulationInput(), admission: null })
    ).toThrow("server-supplied");
    expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        acknowledged: false,
      })
    ).toThrow("explicitly acknowledge");
    return expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        acknowledgedAdmissionId: "other-admission",
      })
    ).toThrow("explicitly acknowledge");
  });
  it("requires exact admission intent/hash/version/review/actor/policy/account bindings", () => {
    const mismatches: Partial<PaperSimulationAdmission>[] = [
      { intentId: "another-intent" },
      { intentSha256: otherHash },
      { reviewedArtifactSha256: otherHash },
      { strategyVersion: strategy.value.version },
      { reviewId: "another-review" },
      { reviewVersion: "2.0.0" },
      { actorId: "another-actor" },
      { policyVersion: "2.0.0" },
      { accountAlias: "another-account" },
    ];
    for (const mismatch of mismatches) {
      expect(() =>
        buildSimulationProposalCommand({
          ...simulationInput(),
          admission: admission(mismatch),
        })
      ).toThrow("exact draft");
    }
  });
  it("rejects admission or draft expiry and overlong or future admissions", () => {
    expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        admission: admission({ expiresAt: now }),
      })
    ).toThrow("expired");
    expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        draft: { ...draft, value: { ...draft.value, expiresAt: now } },
      })
    ).toThrow("expired");
    expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        admission: admission({ admittedAt: "2026-09-22T12:01:00Z" }),
      })
    ).toThrow("chronology");
    expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        admission: admission({ expiresAt: "2026-09-22T12:11:00Z" }),
      })
    ).toThrow("chronology");
    return expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        draft: {
          ...draft,
          value: { ...draft.value, strategyVersion: strategy.value.version },
        },
      })
    ).toThrow("immutable StrategySpec");
  });
  it("rejects a formerly admitted review after a newer acceptance supersedes it", () => {
    const newer = review({
      reviewId: "review-2",
      supersedesReviewId: "review-1",
    });
    expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        reviews: [review(), newer],
      })
    ).toThrow("exact draft");
    return expect(
      buildSimulationProposalCommand({
        ...simulationInput(),
        reviews: [review(), newer],
        admission: admission({ reviewId: "review-2" }),
      }).reviewId
    ).toBe("review-2");
  });
  it("fails closed on forged authority flags without casting records into authority", () => {
    for (const flag of [
      "brokerSubmissionAllowed",
      "liveAuthorization",
      "executionAuthorized",
    ]) {
      const forged = { ...admission() };
      Reflect.set(forged, flag, true);
      expect(() =>
        buildSimulationProposalCommand({
          ...simulationInput(),
          admission: forged,
        })
      ).toThrow("broker or live authority");
    }
    const forgedDraft = { ...draft, value: { ...draft.value } };
    Reflect.set(forgedDraft.value, "executionAuthorized", true);
    expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        draft: forgedDraft,
      })
    ).toThrow("proposal-only");
    const forgedReview = { ...review() };
    Reflect.set(forgedReview, "executionAuthorized", true);
    return expect(
      buildReviewModel(context({ reviews: [forgedReview] })).status
    ).toBe("invalid");
  });
  return it("validates queue identity and retains the distinction between queued and executed", () => {
    const command = buildSimulationProposalCommand(simulationInput());
    const receipt: SimulationQueueReceipt = {
      jobId: "fixture-job",
      admissionId: command.admissionId,
      status: "queued",
      simulationOnly: true,
      brokerSubmissionAllowed: false,
      liveAuthorization: false,
    };
    expect(validateSimulationQueueReceipt(command, receipt)).toBe(receipt);
    expect(() =>
      validateSimulationQueueReceipt(command, {
        ...receipt,
        admissionId: "another-admission",
      })
    ).toThrow("queue receipt");
    expect(receipt).not.toHaveProperty("fill");
    expect(receipt).not.toHaveProperty("executionAuthorized");
    const executed = { ...receipt };
    Reflect.set(executed, "status", "executed");
    expect(() => validateSimulationQueueReceipt(command, executed)).toThrow(
      "queue receipt"
    );
    const broker = { ...receipt };
    Reflect.set(broker, "brokerSubmissionAllowed", true);
    return expect(() =>
      validateSimulationQueueReceipt(command, broker)
    ).toThrow("queue receipt");
  });
});

describe("selection retirement boundaries", () => {
  it("changes the subtree key for account, environment, artifact or hash edits", () => {
    const key = strategySelectionKey(scope, strategy);
    expect(
      strategySelectionKey(
        { ...scope, accountAlias: "other-account" },
        strategy
      )
    ).not.toBe(key);
    expect(
      strategySelectionKey({ ...scope, environment: "live" }, strategy)
    ).not.toBe(key);
    expect(
      strategySelectionKey(scope, {
        ...strategy,
        artifactId: "strategy-artifact-2",
      })
    ).not.toBe(key);
    return expect(
      strategySelectionKey(scope, { ...strategy, sha256: hash })
    ).not.toBe(key);
  });
  it("cannot reuse an acknowledged old draft after selection changes", () => {
    expect(() =>
      buildReviewDecisionCommand({
        ...decisionInput(),
        target: { ...target, artifactId: "draft-artifact-2" },
        reviews: [],
        expectedReviewId: null,
      })
    ).toThrow("exact selected artifact");
    return expect(() =>
      buildSimulationProposalCommand({
        ...simulationInput(),
        draft: { ...draft, artifactId: "draft-artifact-2" },
      })
    ).toThrow("current accepted");
  });
  return it("clears pending review delivery when a keyed selection retires its resource", async () => {
    let complete: ((value: AcceptedReview) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    const resource = createReadResource<ReviewTarget, AcceptedReview>(
      (_target, signal) => {
        requestSignal = signal;
        return new Promise((resolve) => (complete = resolve));
      }
    );
    const pending = resource.load(target);
    await Promise.resolve();
    resource.clear();
    expect(requestSignal?.aborted).toBe(true);
    complete?.(review());
    await pending;
    return expect(resource.getSnapshot()).toEqual({ type: "idle" });
  });
});
