import type { SafePrincipal } from "@darkfactory/auth/types";
import {
  VertexStoreError,
  type VertexArtifactMetadata,
  type VertexCommandKey,
  type VertexRecord,
  type VertexScope,
  type VertexStore,
} from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import {
  VertexArtifactStorageError,
  type VertexArtifactStorage,
  type VertexManifestPut,
  type VertexManifestRead,
} from "@darkfactory/storage/vertex";
import { describe, expect, it, vi } from "vitest";
import {
  AgentRunSchema,
  ResearchEvidenceSchema,
  StrategySpecSchema,
  TradeIntentSchema,
} from "./contracts/vertex.ts";
import {
  AcceptedReviewSchema,
  PortfolioSnapshotSchema,
} from "./contracts/vertex-control.ts";
import type {
  VertexResearchProposalInput,
  VertexReviewDecisionInput,
  VertexSimulationProposalInput,
} from "./contracts/vertex-experience.ts";
import { createVertexExperienceCommands } from "./server/vertex-experience-commands.ts";
import {
  VertexExperienceServiceError,
  type VertexExperienceDependencies,
} from "./server/vertex-experience-core.ts";

const principal: SafePrincipal = {
  userId: "member-1",
  role: "member",
  status: "active",
};
const actor = Object.freeze({ actorId: principal.userId });
const scope: VertexScope = Object.freeze({
  accountAlias: "fixture-paper",
  environment: "paper",
});
const observedAt = "2026-09-21T14:00:00Z";
const now = "2026-09-21T14:00:01.123456789Z";
const deadline = "2026-09-21T14:10:00Z";
const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const policy = Object.freeze({
  version: "1.0.0",
  reviewVersion: "1.0.0",
  ttlMilliseconds: 60_000,
});
const sourceIdentity = {
  provider: "fixture",
  sourceId: "source-1",
  snapshotId: "source-snapshot-1",
  contentHash: digest,
};
const evidence = ResearchEvidenceSchema.parse({
  schemaVersion: "1.0.0",
  collectionId: "collection-1",
  evidenceId: "evidence-1",
  snapshotId: "sealed-import-1",
  sourceType: "paper",
  sourceUri: "https://example.test/paper",
  sourceIdentity,
  sourceLocator: "page 3",
  attribution: "Synthetic fixture author",
  publishedAt: observedAt,
  capturedAt: now,
  contentHash: digest,
  claim: "Synthetic bounded hypothesis",
  method: "Fixture only",
  limitations: ["Not actual research"],
  acceptanceStatus: "unreviewed",
  rightsPolicyId: "fixture-rights",
  untrustedContent: true,
});
const strategy = StrategySpecSchema.parse({
  schemaVersion: "1.0.0",
  strategyId: "strategy-1",
  version: "1.0.0",
  sleeve: "quant",
  hypothesis: "Synthetic deterministic fixture",
  universe: ["fixture-instrument"],
  signalSchedule: { calendar: "XNYS", timezone: "UTC", interval: "bar-close" },
  entryRules: [
    {
      ruleId: "entry-1",
      featureId: "fixture-feature",
      operator: "gt",
      threshold: "1",
      lookbackBars: 5,
    },
  ],
  exitRules: [
    {
      ruleId: "exit-1",
      featureId: "fixture-feature",
      operator: "lt",
      threshold: "0",
      lookbackBars: 5,
    },
  ],
  riskLimits: {
    maximumLoss: "90",
    maximumNotional: "1000",
    maximumPositions: 1,
  },
  requiredData: [
    {
      kind: "candles",
      maximumAgeMs: 5000,
      pointInTimeRequired: true,
      entitlementPolicyId: "fixture-rights",
    },
  ],
  costModel: {
    commissionPerUnit: "0.01",
    spreadBps: "2",
    slippageBps: "1",
    borrowAnnualBps: "100",
    impactModel: "participation-capped",
    maximumParticipationBps: "500",
  },
  codeDigest: digest,
});
const intent = TradeIntentSchema.parse({
  schemaVersion: "1.0.0",
  intentId: "intent-1",
  idempotencyKey: "intent-key-1",
  correlationId: "research-1",
  proposalOnly: true,
  executionAuthorized: false,
  strategyVersion: "strategy-artifact-1",
  ...scope,
  instrumentId: "fixture-instrument",
  side: "buy",
  quantity: "1",
  orderType: "limit",
  limitPrice: "100.5",
  stopPrice: null,
  tickSize: "0.01",
  timeInForce: "DAY",
  quoteAsOf: observedAt,
  referenceQuote: {
    schemaVersion: "1.0.0",
    quoteId: "quote-1",
    instrumentId: "fixture-instrument",
    currency: "USD",
    bid: "100",
    ask: "101",
    bidSize: "10",
    askSize: "12",
    lastPrice: null,
    sourceTimestamp: observedAt,
    receivedAt: now,
    source: {
      identity: sourceIdentity,
      dataKind: "real",
      syntheticReason: null,
      providerTimezone: "America/New_York",
      entitlement: {
        policyId: "fixture-rights",
        status: "granted",
        checkedAt: observedAt,
        expiresAt: deadline,
      },
      freshness: {
        status: "fresh",
        observedAt,
        evaluatedAt: now,
        maxAgeMs: 5000,
      },
    },
  },
  proposedAt: now,
  reasonEvidenceIds: ["evidence-1"],
  maxLossBudget: "20",
  expiresAt: "2026-09-21T14:00:50Z",
});
const portfolio = PortfolioSnapshotSchema.parse({
  schemaVersion: "1.0.0",
  snapshotId: "portfolio-1",
  ...scope,
  streamId: "stream-1",
  ownerEpoch: "2",
  sequence: "7",
  sourceEventHash: digest,
  sourceKind: "paper-simulation",
  asOfAt: observedAt,
  receivedAt: now,
  currency: "USD",
  cash: "1000",
  netAssetValue: "1000",
  positions: [],
  lots: [],
  reservations: [],
  sleeveAllocations: [],
  continuity: {
    ...scope,
    streamId: "stream-1",
    ownerEpoch: "2",
    highWaterSequence: "7",
    highWaterEventHash: digest,
    lastOccurredAt: observedAt,
    lastReceivedAt: now,
    evaluatedAt: now,
    freshness: {
      status: "fresh",
      observedAt,
      evaluatedAt: now,
      maxAgeMs: 5000,
    },
    state: "continuous",
    expectedNextSequence: "8",
    receivedSequence: null,
    newRiskInhibited: true,
    authoritative: false,
  },
  observationOnly: true,
  executionAuthorized: false,
  researchNotionalIncluded: false,
});
const researchInput: VertexResearchProposalInput = {
  ...scope,
  question: "Compare these synthetic claims without executing trades.",
  collectionId: "collection-1",
  evidenceIds: ["evidence-1"],
  role: "research",
  idempotencyKey: "research-key-1",
  proposalOnly: true,
  executionAuthorized: false,
};
const failure = async (
  operation: Promise<unknown>,
  code: string
): Promise<void> => {
  await expect(operation).rejects.toBeInstanceOf(VertexExperienceServiceError);
  await expect(operation).rejects.toMatchObject({ code });
};

const fixture = async () => {
  const committed = new Map<string, VertexManifestRead>();
  const staged = new Map<string, VertexManifestRead>();
  const receipts = new Map<
    string,
    { requestHash: string; value: VertexRecord }
  >();
  const state = {
    now,
    deniedResource: null as string | null,
    storageDenied: false,
  };
  const events: string[] = [];
  const clock = { now: vi.fn(() => state.now) };
  const authorization = {
    authorize: vi.fn(
      async (request: { resourceId: string; now: string }) =>
        request.resourceId !== state.deniedResource
    ),
  };
  const seal = async (
    artifactId: string,
    contractName: VertexArtifactMetadata["contractName"],
    value: unknown,
    collectionId: string | null = null
  ): Promise<VertexManifestRead> => {
    const bytes = new TextEncoder().encode(canonicalArtifactJson(value));
    const metadata: VertexArtifactMetadata = Object.freeze({
      artifactId,
      scope,
      collectionId,
      objectKey: `fixture/${artifactId}`,
      artifactSha256: await hashArtifact(bytes),
      sourceContentSha256: contractName === "ResearchEvidence" ? digest : null,
      byteLength: bytes.byteLength,
      contentType: "application/json",
      schemaVersion: "1.0.0",
      contractName,
      rights: Object.freeze({
        policyId: "fixture-rights",
        version: "1.0.0",
        status: "granted",
        allowedUses: ["store", "read", "derive"] as const,
        checkedAt: observedAt,
        expiresAt: deadline,
        retentionUntil: null,
      }),
      lineageArtifactIds: [],
      createdAt: now,
    });
    return Object.freeze({ bytes, metadata });
  };
  const install = async (
    artifactId: string,
    contractName: VertexArtifactMetadata["contractName"],
    value: unknown,
    collectionId: string | null = null
  ) => {
    const sealed = await seal(artifactId, contractName, value, collectionId);
    committed.set(artifactId, sealed);
    return sealed;
  };
  const evidenceArtifact = await install(
    "evidence-artifact-1",
    "ResearchEvidence",
    evidence,
    "collection-1"
  );
  await install("strategy-artifact-1", "StrategySpec", strategy);
  const intentArtifact = await install(
    "intent-artifact-1",
    "TradeIntent",
    intent
  );
  const acceptedReview = AcceptedReviewSchema.parse({
    schemaVersion: "1.0.0",
    reviewId: "accepted-review-1",
    ...scope,
    collectionId: null,
    artifactId: "intent-artifact-1",
    artifactSha256: intentArtifact.metadata.artifactSha256,
    reviewVersion: policy.reviewVersion,
    decision: "accepted",
    purpose: "paper-simulation",
    actorId: actor.actorId,
    reviewedAt: now,
    expiresAt: "2026-09-21T14:00:40Z",
    policyVersion: policy.version,
    strategyVersion: "strategy-artifact-1",
    supersedesReviewId: null,
    executionAuthorized: false,
  });
  const cache = (key: VertexCommandKey, value: VertexRecord): VertexRecord => {
    receipts.set(`${key.kind}:${key.idempotencyKey}`, {
      requestHash: key.requestHash,
      value,
    });
    return value;
  };
  const store = {
    findRecordArtifact: vi.fn<VertexStore["findRecordArtifact"]>(
      async (_actor, _scope, lookup) => {
        const id =
          lookup.artifactId ??
          (lookup.contractName === "TradeIntent" &&
          lookup.recordId === "intent-1"
            ? "intent-artifact-1"
            : "absent");
        return committed.get(id)?.metadata ?? null;
      }
    ),
    findEvidence: vi.fn<VertexStore["findEvidence"]>(
      async () => committed.get("evidence-artifact-1")?.metadata ?? null
    ),
    getCommandReceipt: vi.fn<VertexStore["getCommandReceipt"]>(
      async (_actor, _scope, key) => {
        events.push("receipt");
        const previous = receipts.get(`${key.kind}:${key.idempotencyKey}`);
        if (previous && previous.requestHash !== key.requestHash)
          throw new VertexStoreError("conflict");
        return previous?.value ?? null;
      }
    ),
    recordReviewedEvidence: vi.fn<VertexStore["recordReviewedEvidence"]>(
      async (input) => {
        events.push("review-transaction");
        return cache(input as unknown as VertexCommandKey, {
          review: input.review,
          acceptedEvidenceArtifactId: null,
        });
      }
    ),
    enqueueResearchProposal: vi.fn<VertexStore["enqueueResearchProposal"]>(
      async (input) => {
        events.push("research-transaction");
        const bytes = staged.get(input.metadata.artifactId);
        if (!bytes) throw new VertexStoreError("integrity");
        committed.set(input.metadata.artifactId, bytes);
        return cache(input as unknown as VertexCommandKey, {
          artifactId: input.metadata.artifactId,
          sha256: input.metadata.artifactSha256,
          value: input.record,
        });
      }
    ),
    queuePaperSimulation: vi.fn<VertexStore["queuePaperSimulation"]>(
      async (input) => {
        events.push("simulation-transaction");
        const admission = input.admission as { admissionId: string };
        return cache(input as unknown as VertexCommandKey, {
          jobId: `simulation-${await hashArtifact(input.admission)}`,
          admissionId: admission.admissionId,
          status: "queued",
          simulationOnly: true,
          brokerSubmissionAllowed: false,
          liveAuthorization: false,
        });
      }
    ),
    listReviews: vi.fn<VertexStore["listReviews"]>(async () => [
      acceptedReview,
    ]),
    getPortfolioSnapshot: vi.fn<VertexStore["getPortfolioSnapshot"]>(
      async () => portfolio
    ),
    registerArtifact: vi.fn(),
    recordImmutable: vi.fn(),
    recordReview: vi.fn(),
    admitPaperSimulation: vi.fn(),
    publishCollectionSnapshot: vi.fn(),
    putRights: vi.fn(),
  };
  const getManifest = vi.fn<VertexArtifactStorage["getManifest"]>(
    async (input) => {
      if (state.storageDenied) throw new VertexArtifactStorageError("denied");
      return committed.get(input.artifactId) ?? null;
    }
  );
  const storagePort = {
    getManifest,
    putManifest: vi.fn(),
    stageManifest: vi.fn(),
    putContent: vi.fn(),
    getContent: vi.fn(),
  };
  const storage = vi.fn(() => storagePort);
  const prepareManifest = vi.fn(
    async (input: VertexManifestPut): Promise<VertexArtifactMetadata> => {
      events.push("stage");
      const sealed = await seal(
        input.artifactId,
        input.contractName,
        input.manifest,
        input.collectionId
      );
      const value = {
        ...sealed,
        metadata: {
          ...sealed.metadata,
          lineageArtifactIds: [...input.lineageArtifactIds],
          createdAt: input.createdAt,
        },
      };
      staged.set(input.artifactId, value);
      return value.metadata;
    }
  );
  const research = {
    available: vi.fn(async () => true),
    taskContract: "bounded-research-v1",
    modelVersion: "fixture-model-v1",
    tokenBudget: 1000,
    costBudgetUsd: "0.1",
    rightsPolicyId: "fixture-rights",
    allowedTools: ["read-evidence", "propose-strategy"] as const,
  };
  const simulation = {
    available: vi.fn(async () => true),
    simulatorId: "paper-simulator-1",
    maximumLoss: "100",
    maximumNotional: "900",
    ttlMilliseconds: 60_000,
  };
  const gateway = {
    listBindings: vi.fn(),
    resolveScope: vi.fn(),
    readStatus: vi.fn(),
  };
  const broker = { submit: vi.fn(), cancel: vi.fn(), modify: vi.fn() };
  const deps: VertexExperienceDependencies & { broker: typeof broker } = {
    store: store as unknown as VertexStore,
    authorization: authorization as unknown as NonNullable<
      VertexExperienceDependencies["authorization"]
    >,
    clock,
    storage,
    prepareManifest,
    reviewPolicy: policy,
    research,
    simulation,
    gateway,
    broker,
  };
  const reviewInput: VertexReviewDecisionInput = {
    ...scope,
    artifactId: "evidence-artifact-1",
    artifactSha256: evidenceArtifact.metadata.artifactSha256,
    strategyVersion: "strategy-artifact-1",
    decision: "accepted",
    purpose: "research",
    expectedReviewId: "review-predecessor-1",
    idempotencyKey: "review-key-1",
  };
  const simulationInput: VertexSimulationProposalInput = {
    ...scope,
    environment: "paper",
    admissionId: "admission-1",
    reviewId: acceptedReview.reviewId,
    reviewVersion: acceptedReview.reviewVersion,
    intentId: intent.intentId,
    intentSha256: intentArtifact.metadata.artifactSha256,
    strategyVersion: intent.strategyVersion,
    idempotencyKey: "simulation-key-1",
    simulationOnly: true,
    brokerSubmissionAllowed: false,
    liveAuthorization: false,
  };
  return {
    deps,
    store,
    storage,
    storagePort,
    getManifest,
    prepareManifest,
    committed,
    staged,
    receipts,
    state,
    clock,
    authorization,
    events,
    research,
    simulation,
    gateway,
    broker,
    install,
    acceptedReview,
    reviewInput,
    simulationInput,
  };
};

const noSeparateWrites = (h: Awaited<ReturnType<typeof fixture>>) => {
  for (const fn of [
    h.store.registerArtifact,
    h.store.recordImmutable,
    h.store.recordReview,
    h.store.admitPaperSimulation,
    h.store.publishCollectionSnapshot,
    h.store.putRights,
    h.storagePort.putManifest,
    h.storagePort.putContent,
  ])
    expect(fn).not.toHaveBeenCalled();
};

const noTransport = (h: Awaited<ReturnType<typeof fixture>>) => {
  for (const fn of [...Object.values(h.gateway), ...Object.values(h.broker)])
    expect(fn).not.toHaveBeenCalled();
};

// Source-authored only. These doubles model trusted atomic ports, not a DB proof.
describe("Vertex authenticated review commands", () => {
  it("commits an exact authenticated review overlay without rewriting sealed evidence", async () => {
    const h = await fixture();
    const original = h.committed.get("evidence-artifact-1")!;
    const originalBytes = new Uint8Array(original.bytes);
    const service = createVertexExperienceCommands(h.deps);
    const result = await service.decideReview(principal, h.reviewInput);
    const requestHash = await hashArtifact({
      actorId: principal.userId,
      kind: "review",
      input: h.reviewInput,
    });
    expect(result).toEqual({
      schemaVersion: "1.0.0",
      reviewId: `review-${requestHash}`,
      ...scope,
      collectionId: "collection-1",
      artifactId: h.reviewInput.artifactId,
      artifactSha256: h.reviewInput.artifactSha256,
      reviewVersion: policy.reviewVersion,
      decision: "accepted",
      purpose: "research",
      actorId: principal.userId,
      reviewedAt: now,
      expiresAt: "2026-09-21T14:01:01.124Z",
      policyVersion: policy.version,
      strategyVersion: h.reviewInput.strategyVersion,
      supersedesReviewId: h.reviewInput.expectedReviewId,
      executionAuthorized: false,
    });
    expect(h.store.recordReviewedEvidence).toHaveBeenCalledExactlyOnceWith({
      principal: actor,
      scope,
      review: result,
      acceptedEvidence: null,
      kind: "review",
      command: h.reviewInput,
      idempotencyKey: h.reviewInput.idempotencyKey,
      requestHash,
    });
    expect(h.authorization.authorize).toHaveBeenCalledWith({
      principal: actor,
      scope,
      collectionId: "collection-1",
      resourceId: h.reviewInput.artifactId,
      action: "review",
      now,
    });
    expect(h.committed.get("evidence-artifact-1")).toBe(original);
    expect(original.bytes).toEqual(originalBytes);
    expect(await hashArtifact(original.bytes)).toBe(
      h.reviewInput.artifactSha256
    );
    expect(JSON.parse(new TextDecoder().decode(original.bytes))).toEqual(
      evidence
    );
    expect(evidence.acceptanceStatus).toBe("unreviewed");
    expect(h.prepareManifest).not.toHaveBeenCalled();
    noSeparateWrites(h);
    return noTransport(h);
  });

  it("returns the old receipt before generating a new review timestamp or staging bytes", async () => {
    const h = await fixture();
    const service = createVertexExperienceCommands(h.deps);
    const first = await service.decideReview(principal, h.reviewInput);
    h.state.now = "2026-09-21T14:00:02Z";
    h.events.length = 0;
    h.store.getCommandReceipt.mockImplementationOnce(async () => {
      h.events.push("receipt");
      return { review: first, acceptedEvidenceArtifactId: null };
    });
    await expect(
      service.decideReview(principal, h.reviewInput)
    ).resolves.toEqual(first);
    expect(h.events).toEqual(["receipt"]);
    expect(first.reviewedAt).toBe(now);
    expect(first.expiresAt).toBe("2026-09-21T14:01:01.124Z");
    expect(h.store.recordReviewedEvidence).toHaveBeenCalledTimes(1);
    return expect(h.prepareManifest).not.toHaveBeenCalled();
  });

  it("rejects digest, exact strategy identity and predecessor conflicts without separate writes", async () => {
    const h = await fixture();
    const service = createVertexExperienceCommands(h.deps);
    await failure(
      service.decideReview(principal, {
        ...h.reviewInput,
        artifactSha256: otherDigest,
      }),
      "CONFLICT"
    );
    await failure(
      service.decideReview(principal, {
        ...h.reviewInput,
        strategyVersion: strategy.version,
      }),
      "NOT_FOUND"
    );
    h.store.recordReviewedEvidence.mockRejectedValueOnce(
      new VertexStoreError("conflict")
    );
    await failure(service.decideReview(principal, h.reviewInput), "CONFLICT");
    expect(h.store.recordReviewedEvidence).toHaveBeenCalledTimes(1);
    expect(h.store.recordReviewedEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        review: expect.objectContaining({
          supersedesReviewId: "review-predecessor-1",
        }),
      })
    );
    return noSeparateWrites(h);
  });

  it("requires the TradeIntent exact strategy artifact and paper-review purpose", async () => {
    const h = await fixture();
    const metadata = h.committed.get("intent-artifact-1")!.metadata;
    await h.install("strategy-other", "StrategySpec", strategy);
    await failure(
      createVertexExperienceCommands(h.deps).decideReview(principal, {
        ...h.reviewInput,
        artifactId: metadata.artifactId,
        artifactSha256: metadata.artifactSha256,
        strategyVersion: "strategy-other",
        purpose: "paper-simulation",
      }),
      "CONFLICT"
    );
    await failure(
      createVertexExperienceCommands(h.deps).decideReview(principal, {
        ...h.reviewInput,
        purpose: "paper-simulation",
      }),
      "BAD_REQUEST"
    );
    return expect(h.store.recordReviewedEvidence).not.toHaveBeenCalled();
  });

  it.each([
    { name: "actor", changed: { actorId: "other-member" } },
    { name: "scope", changed: { accountAlias: "other-account" } },
    { name: "digest", changed: { artifactSha256: otherDigest } },
    { name: "strategy", changed: { strategyVersion: "strategy-other" } },
    { name: "predecessor", changed: { supersedesReviewId: null } },
    { name: "decision", changed: { decision: "rejected" } },
    { name: "purpose", changed: { purpose: "paper-simulation" } },
    { name: "review identity", changed: { reviewId: "foreign-review" } },
    { name: "collection", changed: { collectionId: "foreign-collection" } },
    { name: "review policy version", changed: { reviewVersion: "2.0.0" } },
    { name: "policy version", changed: { policyVersion: "2.0.0" } },
  ])("rejects a malicious echoed review $name", async ({ changed }) => {
    const h = await fixture();
    h.store.recordReviewedEvidence.mockImplementationOnce(async (input) => ({
      review: { ...(input.review as VertexRecord), ...changed },
      acceptedEvidenceArtifactId: null,
    }));
    return await failure(
      createVertexExperienceCommands(h.deps).decideReview(
        principal,
        h.reviewInput
      ),
      "INVALID_SOURCE"
    );
  });

  it("rejects any rewritten accepted-evidence receipt", async () => {
    const h = await fixture();
    h.store.recordReviewedEvidence.mockImplementationOnce(async (input) => ({
      review: input.review,
      acceptedEvidenceArtifactId: "rewritten-evidence",
    }));
    await failure(
      createVertexExperienceCommands(h.deps).decideReview(
        principal,
        h.reviewInput
      ),
      "INVALID_SOURCE"
    );
    return expect(h.prepareManifest).not.toHaveBeenCalled();
  });

  it("uses current grants even for an admin or source carrying an accepted flag", async () => {
    for (const role of ["member", "admin"] as const) {
      const h = await fixture();
      const accepted = await h.install(
        "evidence-artifact-1",
        "ResearchEvidence",
        { ...evidence, acceptanceStatus: "accepted" },
        "collection-1"
      );
      h.state.deniedResource = "evidence-artifact-1";
      await failure(
        createVertexExperienceCommands(h.deps).decideReview(
          { ...principal, role },
          { ...h.reviewInput, artifactSha256: accepted.metadata.artifactSha256 }
        ),
        "FORBIDDEN"
      );
      expect(h.store.recordReviewedEvidence).not.toHaveBeenCalled();
      expect(h.prepareManifest).not.toHaveBeenCalled();
    }
  });

  it("rechecks grant expiry on a previously successful idempotency key", async () => {
    const h = await fixture();
    const service = createVertexExperienceCommands(h.deps);
    await service.decideReview(principal, h.reviewInput);
    h.state.now = deadline;
    h.authorization.authorize.mockImplementation(
      async (request) => request.now !== deadline
    );
    await failure(service.decideReview(principal, h.reviewInput), "FORBIDDEN");
    expect(h.store.getCommandReceipt).toHaveBeenCalledTimes(1);
    return expect(h.store.recordReviewedEvidence).toHaveBeenCalledTimes(1);
  });

  it("honors current storage-rights denial even when catalog rights were granted", async () => {
    const h = await fixture();
    h.state.storageDenied = true;
    await failure(
      createVertexExperienceCommands(h.deps).decideReview(
        principal,
        h.reviewInput
      ),
      "FORBIDDEN"
    );
    return expect(h.store.recordReviewedEvidence).not.toHaveBeenCalled();
  });

  it.each(["bytes", "scope", "source-digest", "collection", "rights-policy"])(
    "rejects mismatched committed source %s",
    async (kind) => {
      const h = await fixture();
      const original = h.committed.get("evidence-artifact-1")!;
      const changed =
        kind === "bytes"
          ? {
              ...original,
              bytes: new TextEncoder().encode(
                canonicalArtifactJson({ ...evidence, claim: "Tampered" })
              ),
            }
          : {
              ...original,
              metadata: {
                ...original.metadata,
                ...(kind === "scope"
                  ? { scope: { ...scope, accountAlias: "other-account" } }
                  : {}),
                ...(kind === "source-digest"
                  ? { sourceContentSha256: otherDigest }
                  : {}),
                ...(kind === "collection"
                  ? { collectionId: "other-collection" }
                  : {}),
                ...(kind === "rights-policy"
                  ? {
                      rights: {
                        ...original.metadata.rights,
                        policyId: "other-policy",
                      },
                    }
                  : {}),
              },
            };
      h.getManifest.mockResolvedValueOnce(changed);
      await failure(
        createVertexExperienceCommands(h.deps).decideReview(
          principal,
          h.reviewInput
        ),
        "INVALID_SOURCE"
      );
      return expect(h.store.recordReviewedEvidence).not.toHaveBeenCalled();
    }
  );

  it("rejects storage envelope accessors without ever invoking untrusted getters", async () => {
    for (const key of ["bytes", "metadata"]) {
      const h = await fixture();
      const original = h.committed.get("evidence-artifact-1")!;
      const getter = vi.fn(() => {
        throw new Error("Untrusted getter executed");
      });
      const malicious = Object.defineProperty({ ...original }, key, {
        enumerable: true,
        get: getter,
      });
      h.getManifest.mockResolvedValueOnce(malicious);
      await failure(
        createVertexExperienceCommands(h.deps).decideReview(
          principal,
          h.reviewInput
        ),
        "INVALID_SOURCE"
      );
      expect(getter).not.toHaveBeenCalled();
      expect(h.store.recordReviewedEvidence).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed catalog metadata before reading its scope fields", async () => {
    const h = await fixture();
    h.store.findRecordArtifact.mockResolvedValueOnce({
      ...h.committed.get("evidence-artifact-1")?.metadata,
      scope: null,
    } as unknown as VertexArtifactMetadata);
    await failure(
      createVertexExperienceCommands(h.deps).decideReview(
        principal,
        h.reviewInput
      ),
      "INVALID_SOURCE"
    );
    expect(h.getManifest).not.toHaveBeenCalled();
    return expect(h.store.recordReviewedEvidence).not.toHaveBeenCalled();
  });

  it("rejects an expired receipt without minting a new review or accepting the original flag", async () => {
    const h = await fixture();
    const service = createVertexExperienceCommands(h.deps);
    const first = await service.decideReview(principal, h.reviewInput);
    h.state.now = first.expiresAt;
    await failure(service.decideReview(principal, h.reviewInput), "CONFLICT");
    expect(h.store.recordReviewedEvidence).toHaveBeenCalledTimes(1);
    return expect(h.prepareManifest).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied actor, clock or execution fields before any write", async () => {
    for (const added of [
      { actorId: "admin" },
      { reviewedAt: observedAt },
      { policyVersion: "9.0.0" },
      { executionAuthorized: true },
    ]) {
      const h = await fixture();
      await failure(
        createVertexExperienceCommands(h.deps).decideReview(principal, {
          ...h.reviewInput,
          ...added,
        } as VertexReviewDecisionInput),
        "BAD_REQUEST"
      );
      expect(h.store.recordReviewedEvidence).not.toHaveBeenCalled();
    }
  });
});

describe("Vertex queued research commands", () => {
  it("is unavailable without a real supervisor or staging metadata capability", async () => {
    const h = await fixture();
    const { research: _research, ...withoutSupervisor } = h.deps;
    const { prepareManifest: _prepare, ...withoutMetadata } = h.deps;
    for (const deps of [withoutSupervisor, withoutMetadata]) {
      await failure(
        createVertexExperienceCommands(deps).proposeResearch(
          principal,
          researchInput
        ),
        "SERVICE_UNAVAILABLE"
      );
    }
    h.research.available.mockResolvedValue(false);
    await failure(
      createVertexExperienceCommands(h.deps).proposeResearch(
        principal,
        researchInput
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(h.prepareManifest).not.toHaveBeenCalled();
    return expect(h.store.enqueueResearchProposal).not.toHaveBeenCalled();
  });

  it("stages canonical queued bytes and delegates record, receipt and outbox atomically", async () => {
    const h = await fixture();
    const result = await createVertexExperienceCommands(h.deps).proposeResearch(
      principal,
      researchInput
    );
    const requestHash = await hashArtifact({
      actorId: principal.userId,
      kind: "research",
      input: researchInput,
    });
    const record = AgentRunSchema.parse({
      schemaVersion: "1.0.0",
      runId: `run-${requestHash}`,
      agentRole: researchInput.role,
      taskContract: h.research.taskContract,
      allowedTools: [...h.research.allowedTools],
      modelVersion: h.research.modelVersion,
      inputEvidenceIds: researchInput.evidenceIds,
      outputArtifactIds: [],
      tokenBudget: h.research.tokenBudget,
      costBudgetUsd: h.research.costBudgetUsd,
      status: "queued",
      errors: [],
      approvalRequests: [],
      executionAuthorized: false,
    });
    const sha256 = await hashArtifact(record);
    expect(result).toEqual({
      artifactId: `agent-${requestHash}`,
      sha256,
      value: record,
    });
    expect(h.events).toEqual(["receipt", "stage", "research-transaction"]);
    expect(h.prepareManifest).toHaveBeenCalledExactlyOnceWith({
      principal: actor,
      scope,
      collectionId: researchInput.collectionId,
      artifactId: result.artifactId,
      contractName: "AgentRun",
      manifest: record,
      artifactSha256: sha256,
      sourceContentSha256: null,
      rightsPolicyId: "fixture-rights",
      lineageArtifactIds: ["evidence-artifact-1"],
      createdAt: now,
    });
    expect(h.store.enqueueResearchProposal).toHaveBeenCalledExactlyOnceWith({
      principal: actor,
      scope,
      collectionId: researchInput.collectionId,
      record,
      metadata: h.staged.get(result.artifactId)?.metadata,
      proposal: {
        question: researchInput.question,
        evidenceIds: researchInput.evidenceIds,
        role: researchInput.role,
        proposalOnly: true,
        executionAuthorized: false,
      },
      kind: "research",
      command: researchInput,
      idempotencyKey: researchInput.idempotencyKey,
      requestHash,
    });
    expect(h.authorization.authorize).toHaveBeenCalledWith({
      principal: actor,
      scope,
      collectionId: researchInput.collectionId,
      resourceId: researchInput.collectionId,
      action: "publish",
      now,
    });
    expect(h.research.available).toHaveBeenCalledWith(scope, undefined);
    expect(evidence.acceptanceStatus).toBe("unreviewed");
    noSeparateWrites(h);
    return noTransport(h);
  });

  it("reuses committed receipt and bytes without generating another createdAt", async () => {
    const h = await fixture();
    const service = createVertexExperienceCommands(h.deps);
    const first = await service.proposeResearch(principal, researchInput);
    h.state.now = "2026-09-21T14:00:02Z";
    h.events.length = 0;
    await expect(
      service.proposeResearch(principal, researchInput)
    ).resolves.toEqual(first);
    expect(h.events).toEqual(["receipt"]);
    expect(h.prepareManifest).toHaveBeenCalledTimes(1);
    expect(h.store.enqueueResearchProposal).toHaveBeenCalledTimes(1);
    return expect(h.prepareManifest.mock.calls[0]?.[0].createdAt).toBe(now);
  });

  it.each(["missing", "identity", "collection"])(
    "rejects %s evidence before staging",
    async (kind) => {
      const h = await fixture();
      if (kind === "missing") {
        h.store.findEvidence.mockResolvedValue(null);
      } else
        await h.install(
          "evidence-artifact-1",
          "ResearchEvidence",
          {
            ...evidence,
            ...(kind === "identity"
              ? { evidenceId: "different-evidence" }
              : { collectionId: "other-collection" }),
          },
          "collection-1"
        );
      await failure(
        createVertexExperienceCommands(h.deps).proposeResearch(
          principal,
          researchInput
        ),
        kind === "missing" ? "NOT_FOUND" : "INVALID_SOURCE"
      );
      expect(h.prepareManifest).not.toHaveBeenCalled();
      return expect(h.store.enqueueResearchProposal).not.toHaveBeenCalled();
    }
  );

  it.each([
    "digest",
    "role",
    "evidence",
    "run",
    "artifact",
    "outputs",
    "status",
  ])("rejects a queued receipt with altered %s", async (kind) => {
    const h = await fixture();
    h.store.enqueueResearchProposal.mockImplementationOnce(async (input) => {
      const record = input.record as VertexRecord;
      const value = {
        ...record,
        ...(kind === "role" ? { agentRole: "knowledge-import" } : {}),
        ...(kind === "evidence"
          ? { inputEvidenceIds: ["other-evidence"] }
          : {}),
        ...(kind === "run" ? { runId: "other-run" } : {}),
        ...(kind === "outputs"
          ? { outputArtifactIds: ["unexpected-output"] }
          : {}),
        ...(kind === "status" ? { status: "running" } : {}),
      };
      return {
        artifactId:
          kind === "artifact" ? "other-artifact" : input.metadata.artifactId,
        value,
        sha256: kind === "digest" ? otherDigest : await hashArtifact(value),
      };
    });
    return await failure(
      createVertexExperienceCommands(h.deps).proposeResearch(
        principal,
        researchInput
      ),
      "INVALID_SOURCE"
    );
  });

  it("rejects a schema-valid echoed record that has never been committed", async () => {
    const h = await fixture();
    h.store.enqueueResearchProposal.mockImplementationOnce(async (input) => ({
      artifactId: input.metadata.artifactId,
      sha256: input.metadata.artifactSha256,
      value: input.record,
    }));
    await failure(
      createVertexExperienceCommands(h.deps).proposeResearch(
        principal,
        researchInput
      ),
      "NOT_FOUND"
    );
    expect(h.committed.size).toBe(3);
    expect(h.staged.size).toBe(1);
    return noSeparateWrites(h);
  });

  it("never queues after failed staging or publishes a staged orphan after transaction failure", async () => {
    const failedStage = await fixture();
    failedStage.prepareManifest.mockRejectedValueOnce(
      new VertexArtifactStorageError("unavailable")
    );
    await failure(
      createVertexExperienceCommands(failedStage.deps).proposeResearch(
        principal,
        researchInput
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(failedStage.store.enqueueResearchProposal).not.toHaveBeenCalled();
    expect(failedStage.committed.size).toBe(3);
    const failedTransaction = await fixture();
    failedTransaction.store.enqueueResearchProposal.mockRejectedValueOnce(
      new VertexStoreError("unavailable")
    );
    await failure(
      createVertexExperienceCommands(failedTransaction.deps).proposeResearch(
        principal,
        researchInput
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(failedTransaction.staged.size).toBe(1);
    expect(failedTransaction.committed.size).toBe(3);
    return noSeparateWrites(failedTransaction);
  });
});

describe("Vertex paper-simulation commands", () => {
  it("is unavailable without a real bound available simulator and cannot contact brokers", async () => {
    const h = await fixture();
    const { simulation: _simulation, ...unbound } = h.deps;
    await failure(
      createVertexExperienceCommands(unbound).proposeSimulation(
        principal,
        h.simulationInput
      ),
      "SERVICE_UNAVAILABLE"
    );
    h.simulation.available.mockResolvedValue(false);
    await failure(
      createVertexExperienceCommands(h.deps).proposeSimulation(
        principal,
        h.simulationInput
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(h.store.queuePaperSimulation).not.toHaveBeenCalled();
    return noTransport(h);
  });

  it("queues exact reviewed intent, strategy and portfolio with minimum decimal caps and earliest expiry", async () => {
    const h = await fixture();
    const result = await createVertexExperienceCommands(
      h.deps
    ).proposeSimulation(principal, h.simulationInput);
    const requestHash = await hashArtifact({
      actorId: principal.userId,
      kind: "simulation",
      input: h.simulationInput,
    });
    const queuedAdmission =
      h.store.queuePaperSimulation.mock.calls[0]?.[0].admission;
    expect(result).toEqual({
      jobId: `simulation-${await hashArtifact(queuedAdmission)}`,
      admissionId: "admission-1",
      status: "queued",
      simulationOnly: true,
      brokerSubmissionAllowed: false,
      liveAuthorization: false,
    });
    expect(h.store.queuePaperSimulation).toHaveBeenCalledExactlyOnceWith({
      principal: actor,
      scope,
      kind: "simulation",
      command: h.simulationInput,
      idempotencyKey: h.simulationInput.idempotencyKey,
      requestHash,
      admission: {
        schemaVersion: "1.0.0",
        admissionId: "admission-1",
        admissionKind: "PAPER-SIMULATION",
        ...scope,
        simulatorId: h.simulation.simulatorId,
        streamId: portfolio.streamId,
        ownerEpoch: portfolio.ownerEpoch,
        intentId: intent.intentId,
        intentSha256: h.simulationInput.intentSha256,
        reviewedArtifactSha256: h.simulationInput.intentSha256,
        reviewId: h.acceptedReview.reviewId,
        reviewVersion: h.acceptedReview.reviewVersion,
        actorId: principal.userId,
        policyVersion: policy.version,
        strategyVersion: "strategy-artifact-1",
        portfolioSnapshotId: portfolio.snapshotId,
        portfolioSequence: portfolio.sequence,
        maximumLoss: "20",
        maximumNotional: "900",
        admittedAt: now,
        expiresAt: h.acceptedReview.expiresAt,
        idempotencyKey: h.simulationInput.idempotencyKey,
        simulationOnly: true,
        brokerSubmissionAllowed: false,
        liveAuthorization: false,
        executionAuthorized: false,
      },
    });
    expect(h.simulation.available).toHaveBeenCalledWith(scope, undefined);
    expect(h.store.listReviews).toHaveBeenCalledWith(
      actor,
      scope,
      "intent-artifact-1"
    );
    expect(h.store.getPortfolioSnapshot).toHaveBeenCalledWith(actor, scope);
    expect(h.prepareManifest).not.toHaveBeenCalled();
    noSeparateWrites(h);
    return noTransport(h);
  });

  it("uses exact decimal minima when simulator and strategy caps are independently tighter", async () => {
    const h = await fixture();
    h.simulation.maximumLoss = "19.999999999";
    h.simulation.maximumNotional = "1000";
    await h.install("strategy-artifact-1", "StrategySpec", {
      ...strategy,
      riskLimits: { ...strategy.riskLimits, maximumNotional: "899.999999999" },
    });
    await createVertexExperienceCommands(h.deps).proposeSimulation(
      principal,
      h.simulationInput
    );
    expect(h.store.queuePaperSimulation).toHaveBeenCalledWith(
      expect.objectContaining({
        admission: expect.objectContaining({
          maximumLoss: "19.999999999",
          maximumNotional: "899.999999999",
        }),
      })
    );
    return noTransport(h);
  });

  it("requires the server's current review version, not just matching client and stored versions", async () => {
    const h = await fixture();
    const deps = {
      ...h.deps,
      reviewPolicy: { ...policy, reviewVersion: "2.0.0" },
    };
    await failure(
      createVertexExperienceCommands(deps).proposeSimulation(
        principal,
        h.simulationInput
      ),
      "FORBIDDEN"
    );
    expect(h.store.queuePaperSimulation).not.toHaveBeenCalled();
    await createVertexExperienceCommands(h.deps).proposeSimulation(
      principal,
      h.simulationInput
    );
    await failure(
      createVertexExperienceCommands(deps).proposeSimulation(
        principal,
        h.simulationInput
      ),
      "FORBIDDEN"
    );
    return expect(h.store.queuePaperSimulation).toHaveBeenCalledTimes(1);
  });

  it("rechecks the current review policy before returning a previous simulation receipt", async () => {
    const h = await fixture();
    await createVertexExperienceCommands(h.deps).proposeSimulation(
      principal,
      h.simulationInput
    );
    const deps = { ...h.deps, reviewPolicy: { ...policy, version: "2.0.0" } };
    await failure(
      createVertexExperienceCommands(deps).proposeSimulation(
        principal,
        h.simulationInput
      ),
      "FORBIDDEN"
    );
    expect(h.store.listReviews).toHaveBeenCalledTimes(2);
    expect(h.store.getCommandReceipt).toHaveBeenCalledTimes(1);
    return expect(h.store.queuePaperSimulation).toHaveBeenCalledTimes(1);
  });

  it.each([
    { artifactSha256: otherDigest },
    { artifactId: "other-intent-artifact" },
    { actorId: "other-member" },
    { accountAlias: "other-account" },
    { reviewVersion: "2.0.0" },
    { policyVersion: "2.0.0" },
    { strategyVersion: "other-strategy" },
    { decision: "rejected" },
    { purpose: "research" },
  ])("rejects a nonmatching accepted review %j", async (changed) => {
    const h = await fixture();
    h.store.listReviews.mockResolvedValue([
      { ...h.acceptedReview, ...changed },
    ]);
    await failure(
      createVertexExperienceCommands(h.deps).proposeSimulation(
        principal,
        h.simulationInput
      ),
      "FORBIDDEN"
    );
    expect(h.store.queuePaperSimulation).not.toHaveBeenCalled();
    return noTransport(h);
  });

  it("rejects changed intent hash, missing current review and expired review", async () => {
    const h = await fixture();
    const service = createVertexExperienceCommands(h.deps);
    await failure(
      service.proposeSimulation(principal, {
        ...h.simulationInput,
        intentSha256: otherDigest,
      }),
      "CONFLICT"
    );
    h.store.listReviews.mockResolvedValueOnce([]);
    await failure(
      service.proposeSimulation(principal, h.simulationInput),
      "FORBIDDEN"
    );
    h.state.now = h.acceptedReview.expiresAt;
    await failure(
      service.proposeSimulation(principal, h.simulationInput),
      "CONFLICT"
    );
    return expect(h.store.queuePaperSimulation).not.toHaveBeenCalled();
  });

  it("rejects missing, discontinuous or wrong-account portfolio snapshots", async () => {
    const h = await fixture();
    const service = createVertexExperienceCommands(h.deps);
    h.store.getPortfolioSnapshot.mockResolvedValueOnce(null);
    await failure(
      service.proposeSimulation(principal, h.simulationInput),
      "SERVICE_UNAVAILABLE"
    );
    h.store.getPortfolioSnapshot.mockResolvedValueOnce({
      ...portfolio,
      continuity: {
        ...portfolio.continuity,
        state: "gap",
        receivedSequence: "9",
      },
    });
    await failure(
      service.proposeSimulation(principal, h.simulationInput),
      "CONFLICT"
    );
    h.store.getPortfolioSnapshot.mockResolvedValueOnce({
      ...portfolio,
      accountAlias: "other-account",
      continuity: { ...portfolio.continuity, accountAlias: "other-account" },
    });
    await failure(
      service.proposeSimulation(principal, h.simulationInput),
      "CONFLICT"
    );
    return expect(h.store.queuePaperSimulation).not.toHaveBeenCalled();
  });

  it("returns the queued receipt before generating another admission timestamp", async () => {
    const h = await fixture();
    const service = createVertexExperienceCommands(h.deps);
    const first = await service.proposeSimulation(principal, h.simulationInput);
    h.store.getCommandReceipt.mockImplementationOnce(async () => {
      h.clock.now.mockImplementation(() => {
        throw new Error("Generated admission timestamp after receipt");
      });
      return first;
    });
    await expect(
      service.proposeSimulation(principal, h.simulationInput)
    ).resolves.toEqual(first);
    expect(h.store.queuePaperSimulation).toHaveBeenCalledTimes(1);
    expect(h.store.getPortfolioSnapshot).toHaveBeenCalledTimes(1);
    expect(h.store.listReviews).toHaveBeenCalledTimes(2);
    expect(h.getManifest.mock.calls.map(([input]) => input.artifactId)).toEqual(
      ["intent-artifact-1", "strategy-artifact-1", "intent-artifact-1"]
    );
    return noTransport(h);
  });

  it.each([
    { admissionId: "foreign-admission" },
    { status: "submitted" },
    { simulationOnly: false },
    { brokerSubmissionAllowed: true },
    { liveAuthorization: true },
    { executionAuthorized: true },
    { jobId: "unbound-job" },
    { jobId: `simulation-${otherDigest}` },
  ])("rejects a malicious simulation receipt %j", async (changed) => {
    const h = await fixture();
    h.store.queuePaperSimulation.mockImplementationOnce(async (input) => ({
      jobId: `simulation-${await hashArtifact(input.admission)}`,
      admissionId: "admission-1",
      status: "queued",
      simulationOnly: true,
      brokerSubmissionAllowed: false,
      liveAuthorization: false,
      ...changed,
    }));
    await failure(
      createVertexExperienceCommands(h.deps).proposeSimulation(
        principal,
        h.simulationInput
      ),
      "INVALID_SOURCE"
    );
    return noTransport(h);
  });

  it("preserves atomic port rejection of superseded review or changed portfolio", async () => {
    const h = await fixture();
    h.store.queuePaperSimulation.mockRejectedValueOnce(
      new VertexStoreError("stale")
    );
    await failure(
      createVertexExperienceCommands(h.deps).proposeSimulation(
        principal,
        h.simulationInput
      ),
      "CONFLICT"
    );
    noSeparateWrites(h);
    return noTransport(h);
  });
});

describe("Vertex command idempotency and authority", () => {
  it("conflicts rather than replaying an idempotency key with a changed original command", async () => {
    const h = await fixture();
    const service = createVertexExperienceCommands(h.deps);
    await service.decideReview(principal, h.reviewInput);
    await service.proposeResearch(principal, researchInput);
    await service.proposeSimulation(principal, h.simulationInput);
    await failure(
      service.decideReview(principal, {
        ...h.reviewInput,
        decision: "rejected",
      }),
      "CONFLICT"
    );
    await failure(
      service.proposeResearch(principal, {
        ...researchInput,
        question: "A different synthetic research question.",
      }),
      "CONFLICT"
    );
    await failure(
      service.proposeSimulation(principal, {
        ...h.simulationInput,
        admissionId: "changed-admission",
      }),
      "CONFLICT"
    );
    expect(h.store.recordReviewedEvidence).toHaveBeenCalledTimes(1);
    expect(h.store.enqueueResearchProposal).toHaveBeenCalledTimes(1);
    expect(h.store.queuePaperSimulation).toHaveBeenCalledTimes(1);
    return expect(h.prepareManifest).toHaveBeenCalledTimes(1);
  });

  it("denies all command families before data access when account scope is not granted", async () => {
    const h = await fixture();
    h.state.deniedResource = "account-scope";
    const service = createVertexExperienceCommands(h.deps);
    await failure(service.decideReview(principal, h.reviewInput), "FORBIDDEN");
    await failure(
      service.proposeResearch(principal, researchInput),
      "FORBIDDEN"
    );
    await failure(
      service.proposeSimulation(principal, h.simulationInput),
      "FORBIDDEN"
    );
    expect(h.store.findRecordArtifact).not.toHaveBeenCalled();
    expect(h.store.findEvidence).not.toHaveBeenCalled();
    expect(h.store.getCommandReceipt).not.toHaveBeenCalled();
    expect(h.prepareManifest).not.toHaveBeenCalled();
    return noTransport(h);
  });

  it("requires collection publish and exact admission grants beyond account membership", async () => {
    const h = await fixture();
    const service = createVertexExperienceCommands(h.deps);
    h.state.deniedResource = researchInput.collectionId;
    await failure(
      service.proposeResearch(principal, researchInput),
      "FORBIDDEN"
    );
    h.state.deniedResource = h.simulationInput.admissionId;
    await failure(
      service.proposeSimulation(principal, h.simulationInput),
      "FORBIDDEN"
    );
    expect(h.prepareManifest).not.toHaveBeenCalled();
    expect(h.store.enqueueResearchProposal).not.toHaveBeenCalled();
    expect(h.store.queuePaperSimulation).not.toHaveBeenCalled();
    return noTransport(h);
  });
});
