import type { SafePrincipal } from "@darkfactory/auth/types";
import type {
  VertexArtifactMetadata,
  VertexAuthorizationRepository,
  VertexRecord,
  VertexScope,
  VertexStore,
} from "@darkfactory/db/server/vertex";
import type { VertexArtifactStorage } from "@darkfactory/storage/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { describe, expect, it, vi } from "vitest";
import {
  computeExecutionProjectionHash,
  type ExecutionProjection,
} from "./contracts/vertex-control.ts";
import {
  computeNativeFactProjectionHash,
  type NativeFact,
  type NativeFactProjection,
} from "./contracts/vertex-native-facts.ts";
import {
  createVertexExperienceReads,
  type VertexExperienceReads,
} from "./server/vertex-experience-reads.ts";
import type { VertexExperienceDependencies } from "./server/vertex-experience-core.ts";

// exactOptionalPropertyTypes: model a missing optional dependency by omission.
const withoutDependency = <T extends object, K extends keyof T>(
  dependencies: T,
  key: K
): Omit<T, K> => {
  const copy = { ...dependencies };
  delete copy[key];
  return copy;
};

const principal: SafePrincipal = {
  userId: "reader-1",
  role: "member",
  status: "active",
};
const scope: VertexScope = {
  accountAlias: "fixture-paper",
  environment: "paper",
};
const pageInput = { ...scope, limit: 100, cursor: null };
const NOW = "2026-09-21T14:00:01Z";
const BEFORE = "2026-09-21T14:00:00Z";
const AFTER = "2026-09-22T14:00:00Z";
const digest = "a".repeat(64);
const rights = {
  policyId: "fixture-rights",
  version: "1.0.0",
  status: "granted",
  allowedUses: ["store", "read", "derive"],
  checkedAt: BEFORE,
  expiresAt: AFTER,
  retentionUntil: AFTER,
} as const;
const sourceIdentity = {
  provider: "fixture-provider",
  sourceId: "source-1",
  snapshotId: "snapshot-1",
  contentHash: digest,
};
const costs = {
  commissionPerUnit: "0",
  spreadBps: "1",
  slippageBps: "1",
  borrowAnnualBps: "0",
  impactModel: "fixed-bps",
  maximumParticipationBps: "100",
};
const strategy = {
  schemaVersion: "1.0.0",
  strategyId: "strategy-1",
  version: "1.0.0",
  sleeve: "quant",
  hypothesis: "Source fixture only",
  universe: ["instrument-1"],
  signalSchedule: { calendar: "XNYS", timezone: "UTC", interval: "bar-close" },
  entryRules: [
    {
      ruleId: "entry",
      featureId: "fixture",
      operator: "gt",
      threshold: "0",
      lookbackBars: 1,
    },
  ],
  exitRules: [
    {
      ruleId: "exit",
      featureId: "fixture",
      operator: "lt",
      threshold: "0",
      lookbackBars: 1,
    },
  ],
  riskLimits: {
    maximumLoss: "10",
    maximumNotional: "100",
    maximumPositions: 1,
  },
  requiredData: [
    {
      kind: "quotes",
      maximumAgeMs: 5000,
      pointInTimeRequired: true,
      entitlementPolicyId: "fixture-rights",
    },
  ],
  costModel: costs,
  codeDigest: digest,
};
const agent = {
  schemaVersion: "1.0.0",
  runId: "agent-1",
  agentRole: "research",
  taskContract: "research-task",
  allowedTools: ["read-evidence"],
  modelVersion: null,
  inputEvidenceIds: [],
  outputArtifactIds: [],
  tokenBudget: 100,
  costBudgetUsd: "1",
  status: "queued",
  errors: [],
  approvalRequests: [],
  executionAuthorized: false,
};
const evidence = {
  schemaVersion: "1.0.0",
  evidenceId: "evidence-1",
  collectionId: "collection-1",
  snapshotId: "snapshot-1",
  sourceType: "paper",
  sourceUri: "https://example.test/research",
  sourceIdentity,
  sourceLocator: "page 1",
  attribution: "Synthetic fixture",
  publishedAt: BEFORE,
  capturedAt: NOW,
  contentHash: digest,
  claim: "Synthetic claim",
  method: "Fixture",
  limitations: [],
  acceptanceStatus: "unreviewed",
  rightsPolicyId: "fixture-rights",
  untrustedContent: true,
};
const dataset = {
  schemaVersion: "1.0.0",
  datasetId: "dataset-1",
  provider: "fixture-provider",
  entitlementPolicyId: "fixture-rights",
  instrumentUniverse: ["instrument-1"],
  startAtInclusive: "2026-09-20T14:00:00Z",
  endAtExclusive: BEFORE,
  captureTime: NOW,
  dataVintageId: null,
  dataVintageStatus: "unavailable",
  asOfAt: BEFORE,
  adjustmentMethod: "unadjusted",
  calendar: "XNYS",
  contentHash: digest,
  storageRef: "dataset-object",
  retentionPolicy: "fixture-retention",
  sources: [sourceIdentity],
  gammaProvenance: null,
};
const backtest = {
  schemaVersion: "1.0.0",
  runId: "backtest-1",
  strategyVersion: "strategy-artifact",
  datasetManifestIds: ["dataset-1"],
  seed: 1,
  engineVersion: "1.0.0",
  trainingWindow: {
    startAtInclusive: "2026-09-19T14:00:00Z",
    endAtExclusive: "2026-09-20T14:00:00Z",
  },
  testWindow: {
    startAtInclusive: "2026-09-20T14:00:00Z",
    endAtExclusive: BEFORE,
  },
  benchmark: "fixture-benchmark",
  transactionCosts: costs,
  slippageModel: "fixed-bps",
  resultsRef: null,
  leakageChecks: [],
  reviewStatus: "unreviewed",
  validationMode: "historical",
  forwardSampleCount: 0,
  gammaProvenance: null,
};
const draft = {
  schemaVersion: "1.0.0",
  intentId: "intent-1",
  idempotencyKey: "intent-key",
  correlationId: "correlation-1",
  proposalOnly: true,
  executionAuthorized: false,
  strategyVersion: "strategy-artifact",
  ...scope,
  instrumentId: "instrument-1",
  side: "buy",
  quantity: "1",
  orderType: "limit",
  limitPrice: "100",
  stopPrice: null,
  tickSize: "0.01",
  timeInForce: "DAY",
  quoteAsOf: BEFORE,
  referenceQuote: {
    schemaVersion: "1.0.0",
    quoteId: "quote-1",
    instrumentId: "instrument-1",
    currency: "USD",
    bid: "99",
    ask: "100",
    bidSize: "2",
    askSize: "2",
    lastPrice: null,
    sourceTimestamp: BEFORE,
    receivedAt: NOW,
    source: {
      identity: sourceIdentity,
      dataKind: "real",
      syntheticReason: null,
      providerTimezone: "UTC",
      entitlement: {
        policyId: "fixture-rights",
        status: "granted",
        checkedAt: BEFORE,
        expiresAt: AFTER,
      },
      freshness: {
        status: "fresh",
        observedAt: BEFORE,
        evaluatedAt: NOW,
        maxAgeMs: 5000,
      },
    },
  },
  proposedAt: NOW,
  reasonEvidenceIds: ["evidence-1"],
  maxLossBudget: "10",
  expiresAt: AFTER,
};
const continuity = {
  ...scope,
  streamId: "stream-1",
  ownerEpoch: "1",
  highWaterSequence: "1",
  highWaterEventHash: digest,
  lastOccurredAt: BEFORE,
  lastReceivedAt: NOW,
  evaluatedAt: NOW,
  freshness: {
    status: "unknown",
    observedAt: BEFORE,
    evaluatedAt: NOW,
    maxAgeMs: 5000,
  },
  state: "unavailable",
  expectedNextSequence: "2",
  receivedSequence: null,
  newRiskInhibited: true,
  authoritative: false,
};
const portfolio = {
  schemaVersion: "1.0.0",
  snapshotId: "portfolio-1",
  ...scope,
  streamId: "stream-1",
  ownerEpoch: "1",
  sequence: "1",
  sourceEventHash: digest,
  sourceKind: "source-unavailable",
  asOfAt: BEFORE,
  receivedAt: NOW,
  currency: "USD",
  cash: null,
  netAssetValue: null,
  positions: [],
  lots: [],
  reservations: [],
  sleeveAllocations: [],
  continuity,
  observationOnly: true,
  executionAuthorized: false,
  researchNotionalIncluded: false,
};
const gatewayStatus = {
  schemaVersion: "1.0.0",
  statusId: "gateway-status",
  gatewayId: "gateway-1",
  environment: "paper",
  observedAt: NOW,
  infrastructure: "unavailable",
  brokerHandshake: "not-attempted",
  recovery: "disabled",
  trading: "disabled",
  reasonCodes: ["source-unavailable"],
  lastHumanRequestId: null,
};
const projection = async (): Promise<ExecutionProjection> => {
  const value = {
    schemaVersion: "1.0.0",
    projectionId: "projection-1",
    ...scope,
    streamId: "stream-1",
    ownerEpoch: "1",
    sequence: "1",
    previousEventHash: null,
    eventHash: digest,
    occurredAt: BEFORE,
    receivedAt: NOW,
    actorId: "owner-1",
    policyVersion: "1.0.0",
    strategyVersion: "strategy-artifact",
    reviewedArtifactSha256: digest,
    admissionId: "admission-1",
    expiresAt: AFTER,
    idempotencyKey: "projection-key",
    sourceKind: "paper-simulation",
    receipt: {
      schemaVersion: "1.0.0",
      intentId: "intent-1",
      submissionKey: "submission-1",
      brokerOrderRef: null,
      environment: "paper",
      observationOnly: true,
      status: "not-submitted",
      totalQuantity: "1",
      filledQuantity: "0",
      remainingQuantity: "1",
      lastReconciledAt: NOW,
      errorClass: null,
      auditEventIds: ["audit-1"],
    },
    authoritative: false,
    reservationAuthority: "native-owner-only",
  } as ExecutionProjection;
  return { ...value, eventHash: await computeExecutionProjectionHash(value) };
};

const settlement = {
  settlementId: "settlement-1",
  instrumentId: "option-1",
  underlyingId: "underlying-1",
  settlementKind: "physical",
  settlementState: "pending",
  quantity: "1",
  currency: "USD",
  cashDelta: "0",
  shareDelta: "0",
  dueAt: AFTER,
  fillEventIds: ["fill-1"],
} as const;
const nativeFacts: readonly NativeFact[] = [
  {
    kind: "checkpoint",
    snapshotId: "portfolio-1",
    snapshotSha256: digest,
    journalSequence: "2",
    journalHeadHash: digest,
  },
  {
    kind: "cash-settlement",
    settlementId: "settlement-1",
    currency: "USD",
    cashDelta: "-10",
    fillEventIds: ["fill-1"],
  },
  { kind: "assignment", ...settlement },
  { kind: "exercise", ...settlement },
  { kind: "option-expiry", ...settlement },
  {
    kind: "corporate-action",
    actionId: "action-1",
    oldInstrumentId: "old-1",
    newInstrumentId: "new-1",
    quantityNumerator: "2",
    quantityDenominator: "1",
    previousQuantity: "1",
    newQuantity: "2",
    cashDelta: "0",
    currency: "USD",
    previousQualificationSha256: digest,
    replacementQualificationSha256: digest,
  },
  {
    kind: "reconciliation",
    reconciliationId: "reconciliation-1",
    observedSnapshotId: "portfolio-1",
    unknownCount: 1,
    reconciled: false,
  },
  {
    kind: "kill-state",
    action: "pause-new-risk",
    reasonCodes: ["manual-pause"],
    grantId: null,
  },
];
const nativeProjection = async (
  fact: NativeFact
): Promise<NativeFactProjection> => {
  const value: NativeFactProjection = {
    schemaVersion: "1.0.0",
    projectionId: "native-projection-1",
    ...scope,
    environment: "paper",
    streamId: "stream-1",
    ownerEpoch: "1",
    sequence: "2",
    proofJournalSequence: "2",
    proofJournalHeadHash: digest,
    factOrdinal: 0,
    previousEventHash: digest,
    eventHash: digest,
    occurredAt: BEFORE,
    receivedAt: NOW,
    actorId: "owner-1",
    policyVersion: "1.0.0",
    expiresAt: AFTER,
    idempotencyKey: "native-fact-key",
    sourceKind: "paper-simulation",
    proof: {
      artifactId: "proof-artifact",
      sha256: digest,
      sourceEventId: "journal-event-1",
    },
    fact,
    authoritative: false,
    reservationAuthority: "native-owner-only",
    executionAuthorized: false,
  };
  return { ...value, eventHash: await computeNativeFactProjectionHash(value) };
};

interface Stored {
  metadata: VertexArtifactMetadata;
  bytes: Uint8Array;
  value: VertexRecord;
}
const harness = () => {
  const entries = new Map<string, Stored>();
  const add = async (
    artifactId: string,
    contractName: VertexArtifactMetadata["contractName"],
    value: VertexRecord,
    collectionId: string | null = null
  ): Promise<Stored> => {
    const bytes = new TextEncoder().encode(canonicalArtifactJson(value));
    const metadata: VertexArtifactMetadata = {
      artifactId,
      contractName,
      scope,
      collectionId,
      objectKey: `fixture/${artifactId}`,
      artifactSha256: await hashArtifact(bytes),
      sourceContentSha256:
        typeof value["contentHash"] === "string" ? value["contentHash"] : null,
      byteLength: bytes.byteLength,
      contentType: "application/json",
      schemaVersion: "1.0.0",
      rights,
      lineageArtifactIds: [],
      createdAt: NOW,
    };
    const stored = { metadata, bytes, value };
    entries.set(artifactId, stored);
    return stored;
  };
  const authorize = vi.fn<VertexAuthorizationRepository["authorize"]>(
    async () => true
  );
  const listAuthorizedScopes = vi.fn<
    VertexAuthorizationRepository["listAuthorizedScopes"]
  >(async () => [scope]);
  const listArtifacts = vi.fn<VertexStore["listArtifacts"]>(
    async (_actor, _scope, input) => ({
      items: [...entries.values()]
        .filter(
          (entry) =>
            entry.metadata.contractName === input.contractName &&
            (input.strategyVersion === undefined ||
              entry.value["strategyVersion"] === input.strategyVersion)
        )
        .slice(0, input.limit)
        .map((entry) => entry.metadata),
      nextCursor: null,
    })
  );
  const findRecordArtifact = vi.fn<VertexStore["findRecordArtifact"]>(
    async (_actor, _scope, input) => {
      const found =
        input.artifactId === undefined
          ? [...entries.values()].find(
              (entry) =>
                entry.metadata.contractName === input.contractName &&
                [
                  entry.value["evidenceId"],
                  entry.value["datasetId"],
                  entry.value["intentId"],
                  entry.value["runId"],
                ].includes(input.recordId)
            )
          : entries.get(input.artifactId);
      return found?.metadata ?? null;
    }
  );
  const listScopeReviews = vi.fn<VertexStore["listScopeReviews"]>(async () => ({
    items: [],
    nextCursor: null,
  }));
  const listPaperAdmissions = vi.fn<VertexStore["listPaperAdmissions"]>(
    async () => ({ items: [], nextCursor: null })
  );
  const listExecutionProjections = vi.fn<
    VertexStore["listExecutionProjections"]
  >(async () => ({ items: [], nextCursor: null }));
  const getPortfolioSnapshot = vi.fn<VertexStore["getPortfolioSnapshot"]>(
    async () => null
  );
  const getContinuity = vi.fn<VertexStore["getContinuity"]>(async () => null);
  const getManifest = vi.fn<VertexArtifactStorage["getManifest"]>(
    async (input) => {
      const stored = entries.get(input.artifactId);
      return stored ? { metadata: stored.metadata, bytes: stored.bytes } : null;
    }
  );
  const storage = vi.fn(
    () => ({ getManifest }) as unknown as VertexArtifactStorage
  );
  const resolveScope = vi.fn(async () => scope as VertexScope | null);
  const readStatus = vi.fn(async () => gatewayStatus as unknown);
  const listBindings = vi.fn(
    async (): Promise<unknown> => [
      {
        gatewayId: "gateway-1",
        environment: "paper",
        accountAlias: "fixture-paper",
      },
    ]
  );
  const mutate = vi.fn(async () => {
    throw new Error("Mutation forbidden in reads");
  });
  const store = {
    listArtifacts,
    findRecordArtifact,
    listScopeReviews,
    listPaperAdmissions,
    listExecutionProjections,
    getPortfolioSnapshot,
    getContinuity,
    recordImmutable: mutate,
    recordReview: mutate,
    admitPaperSimulation: mutate,
  } as unknown as VertexStore;
  const dependencies: VertexExperienceDependencies = {
    store,
    authorization: {
      authorize,
      listAuthorizedScopes,
    } as unknown as VertexAuthorizationRepository,
    clock: { now: () => NOW },
    storage,
    gateway: { listBindings, resolveScope, readStatus },
  };
  return {
    entries,
    add,
    authorize,
    listAuthorizedScopes,
    listBindings,
    listArtifacts,
    findRecordArtifact,
    listScopeReviews,
    listPaperAdmissions,
    listExecutionProjections,
    getPortfolioSnapshot,
    getContinuity,
    getManifest,
    storage,
    resolveScope,
    readStatus,
    mutate,
    dependencies,
    service: createVertexExperienceReads(dependencies),
  };
};

const endpoints: readonly Readonly<{
  name: string;
  run: (
    service: VertexExperienceReads,
    who?: SafePrincipal
  ) => Promise<unknown>;
}>[] = [
  {
    name: "scopes",
    run: (service, who = principal) => service.scopes(who, {}),
  },
  {
    name: "portfolio",
    run: (service, who = principal) => service.portfolio(who, scope),
  },
  {
    name: "continuity",
    run: (service, who = principal) =>
      service.continuity(who, { ...scope, streamId: "stream-1" }),
  },
  {
    name: "strategies",
    run: (service, who = principal) => service.strategies(who, pageInput),
  },
  {
    name: "agents",
    run: (service, who = principal) => service.agents(who, pageInput),
  },
  {
    name: "agent",
    run: (service, who = principal) =>
      service.agent(who, { ...scope, artifactId: "agent-artifact" }),
  },
  {
    name: "inbox",
    run: (service, who = principal) => service.inbox(who, pageInput),
  },
  {
    name: "dossier",
    run: (service, who = principal) =>
      service.dossier(who, { ...scope, artifactId: "strategy-artifact" }),
  },
  {
    name: "audit",
    run: (service, who = principal) => service.audit(who, pageInput),
  },
  {
    name: "gateway",
    run: (service, who = principal) =>
      service.gateway(who, { gatewayId: "gateway-1", environment: "paper" }),
  },
];

describe("experience read capability and authorization gates", () => {
  it.each(endpoints)(
    "$name requires real store, authorization and clock dependencies",
    async ({ run }) => {
      const h = harness();

      for (const dependencies of [
        {},
        { ...h.dependencies, store: undefined },
        { ...h.dependencies, authorization: undefined },
        { ...h.dependencies, clock: undefined },
      ]) {
        await expect(
          run(createVertexExperienceReads(dependencies))
        ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      }
    }
  );
  it.each(endpoints)(
    "$name rejects denial without protected source I/O, including admin",
    async ({ run }) => {
      const h = harness();
      h.authorize.mockResolvedValue(false);
      await expect(
        run(h.service, { ...principal, role: "admin" })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      for (const port of [
        h.listArtifacts,
        h.findRecordArtifact,
        h.listScopeReviews,
        h.listPaperAdmissions,
        h.listExecutionProjections,
        h.getPortfolioSnapshot,
        h.getContinuity,
        h.getManifest,
        h.readStatus,
      ])
        expect(port).not.toHaveBeenCalled();
    }
  );
  it("does not treat account-scope alone as an artifacts or records grant", async () => {
    const h = harness();
    h.authorize.mockImplementation(
      async (input) => input.resourceId === "account-scope"
    );
    await expect(
      h.service.strategies(principal, pageInput)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.service.agent(principal, { ...scope, artifactId: "agent-artifact" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.listArtifacts).not.toHaveBeenCalled();
    return expect(h.findRecordArtifact).not.toHaveBeenCalled();
  });
  it("does not fabricate empty artifact pages without storage", async () => {
    const h = harness();
    await expect(
      createVertexExperienceReads(
        withoutDependency(h.dependencies, "storage")
      ).agents(principal, pageInput)
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    return expect(h.listArtifacts).not.toHaveBeenCalled();
  });
  it("sanitizes unknown port exceptions and rechecks cancellation after await", async () => {
    const h = harness();
    h.listArtifacts.mockRejectedValueOnce(new Error("private provider secret"));
    await expect(h.service.agents(principal, pageInput)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Vertex capability unavailable",
    });
    const controller = new AbortController();
    h.getPortfolioSnapshot.mockImplementationOnce(async () => {
      controller.abort();
      return null;
    });
    return await expect(
      createVertexExperienceReads({
        ...h.dependencies,
        signal: controller.signal,
      }).portfolio(principal, scope)
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});

describe("configured gateway list", () => {
  const binding = {
    gatewayId: "gateway-1",
    environment: "paper",
    accountAlias: "fixture-paper",
  };
  it("lists configured gateways the caller may read, checking scope and gateway", async () => {
    const h = harness();
    expect(await h.service.gateways(principal, {})).toEqual([binding]);
    const resources = h.authorize.mock.calls.map(([input]) => input.resourceId);
    expect(resources).toEqual(["account-scope", "gateway-1"]);
    expect(h.readStatus).not.toHaveBeenCalled();
  });
  it("hides a gateway whose scope or gateway grant is missing", async () => {
    const h = harness();
    h.authorize.mockImplementation(
      async (input) => input.resourceId === "account-scope"
    );
    expect(await h.service.gateways(principal, {})).toEqual([]);
    h.authorize.mockResolvedValue(false);
    expect(await h.service.gateways(principal, {})).toEqual([]);
  });
  it("fails the whole list on an authorization outage instead of hiding it", async () => {
    const h = harness();
    h.authorize.mockRejectedValue(new Error("private authorization text"));
    await expect(h.service.gateways(principal, {})).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
  it("requires the gateway and core dependencies and a strict empty input", async () => {
    const h = harness();
    await expect(
      createVertexExperienceReads(
        withoutDependency(h.dependencies, "gateway")
      ).gateways(principal, {})
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(
      createVertexExperienceReads({}).gateways(principal, {})
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(
      h.service.gateways(principal, { gatewayId: "gateway-1" } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.listBindings).not.toHaveBeenCalled();
  });
  it("rejects malformed, duplicate or excessive gateway configuration", async () => {
    const h = harness();
    for (const bindings of [
      [binding, binding],
      [{ ...binding, environment: "research" }],
      [{ ...binding, token: "secret" }],
      Array.from({ length: 129 }, (_, index) => ({
        ...binding,
        gatewayId: `gateway-${index}`,
      })),
    ]) {
      h.listBindings.mockResolvedValueOnce(bindings);
      await expect(h.service.gateways(principal, {})).rejects.toMatchObject({
        code: "INVALID_SOURCE",
      });
    }
  });
});

describe("authorized scopes and non-authoritative observations", () => {
  it("lists only real explicit scopes and rejects malformed, duplicate or excessive results", async () => {
    const h = harness();
    expect(await h.service.scopes(principal, {})).toEqual([scope]);
    expect(h.listAuthorizedScopes).toHaveBeenCalledWith({
      actorId: principal.userId,
    });

    for (const scopes of [
      [scope, scope],
      [{ ...scope, admin: true }],
      Array.from({ length: 513 }, (_, index) => ({
        ...scope,
        accountAlias: `scope-${index}`,
      })),
    ]) {
      h.listAuthorizedScopes.mockResolvedValueOnce(scopes as never);
      await expect(h.service.scopes(principal, {})).rejects.toMatchObject({
        code: "INVALID_SOURCE",
      });
    }
  });
  it("returns missing observations explicitly unavailable, never synthetic zero balances", async () => {
    const h = harness();
    expect(await h.service.portfolio(principal, scope)).toEqual({
      status: "unavailable",
      reason: "not-found",
      executionAuthorized: false,
    });
    expect(
      await h.service.continuity(principal, { ...scope, streamId: "stream-1" })
    ).toEqual({
      status: "unavailable",
      reason: "not-found",
      executionAuthorized: false,
    });
    h.getPortfolioSnapshot.mockResolvedValueOnce(portfolio);
    expect(await h.service.portfolio(principal, scope)).toEqual({
      status: "available",
      snapshot: portfolio,
    });
    h.getContinuity.mockResolvedValueOnce(continuity);
    return expect(
      await h.service.continuity(principal, { ...scope, streamId: "stream-1" })
    ).toEqual({ status: "available", continuity });
  });
  it("rejects cross-scope snapshots and mismatched stream identities", async () => {
    const h = harness();
    h.getPortfolioSnapshot.mockResolvedValueOnce({
      ...portfolio,
      accountAlias: "foreign",
      continuity: { ...continuity, accountAlias: "foreign" },
    });
    await expect(h.service.portfolio(principal, scope)).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    h.getContinuity.mockResolvedValueOnce({
      ...continuity,
      streamId: "foreign",
    });
    return await expect(
      h.service.continuity(principal, { ...scope, streamId: "stream-1" })
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
});

describe("bounded artifact and audit pages", () => {
  it("reads exact committed source contracts and forwards only strict scope fields", async () => {
    const h = harness();
    const item = await h.add("strategy-artifact", "StrategySpec", strategy);
    const run = await h.add("agent-artifact", "AgentRun", agent);
    expect(await h.service.strategies(principal, pageInput)).toEqual({
      items: [
        {
          artifactId: item.metadata.artifactId,
          sha256: item.metadata.artifactSha256,
          value: strategy,
        },
      ],
      nextCursor: null,
    });
    expect(
      await h.service.agent(principal, {
        ...scope,
        artifactId: run.metadata.artifactId,
      })
    ).toEqual({
      artifactId: run.metadata.artifactId,
      sha256: run.metadata.artifactSha256,
      value: agent,
    });
    expect(h.listArtifacts).toHaveBeenCalledWith(
      { actorId: principal.userId },
      scope,
      { contractName: "StrategySpec", limit: 100, cursor: null }
    );
    return expect(h.findRecordArtifact).toHaveBeenCalledWith(
      { actorId: principal.userId },
      scope,
      { artifactId: "agent-artifact", contractName: "AgentRun" }
    );
  });
  it("enforces input1..100 and opaque cursor bounds before I/O", async () => {
    const h = harness();
    for (const input of [
      { ...pageInput, limit: 0 },
      { ...pageInput, limit: 101 },
      { ...pageInput, limit: 1.5 },
      { ...pageInput, cursor: "a".repeat(4097) },
      { ...pageInput, cursor: "not/a/cursor" },
    ]) {
      await expect(h.service.agents(principal, input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    return expect(h.listArtifacts).not.toHaveBeenCalled();
  });
  it("rejects overfull, duplicate, malformed and nonadvancing source pages", async () => {
    const h = harness();
    const item = await h.add("agent-artifact", "AgentRun", agent);
    for (const page of [
      { items: [item.metadata, item.metadata], nextCursor: null },
      { items: [], nextCursor: "invalid/cursor" },
      { items: [], nextCursor: "same" },
      { items: [], nextCursor: null, extra: true },
    ]) {
      h.listArtifacts.mockResolvedValueOnce(page);
      await expect(
        h.service.agents(principal, { ...pageInput, cursor: "same" })
      ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    }
    h.listArtifacts.mockResolvedValueOnce({
      items: [item.metadata, item.metadata],
      nextCursor: null,
    });
    return await expect(
      h.service.agents(principal, { ...pageInput, limit: 1 })
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
  it("rejects wrong identity, contract, scope and immutable bytes", async () => {
    const h = harness();
    const item = await h.add("agent-artifact", "AgentRun", agent);
    for (const metadata of [
      { ...item.metadata, artifactId: "other" },
      { ...item.metadata, contractName: "StrategySpec" },
      { ...item.metadata, scope: { ...scope, accountAlias: "foreign" } },
      { ...item.metadata, rights: null },
    ]) {
      h.findRecordArtifact.mockResolvedValueOnce(metadata as never);
      await expect(
        h.service.agent(principal, { ...scope, artifactId: "agent-artifact" })
      ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    }
    item.bytes = new TextEncoder().encode(
      canonicalArtifactJson({ ...agent, runId: "tampered" })
    );
    return await expect(
      h.service.agent(principal, { ...scope, artifactId: "agent-artifact" })
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
  it("checks artifact grants before object storage, not acceptance labels", async () => {
    const h = harness();
    await h.add("agent-artifact", "AgentRun", agent, "collection-1");
    h.authorize.mockImplementation(
      async (input) => input.resourceId !== "agent-artifact"
    );
    await expect(h.service.agents(principal, pageInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    return expect(h.getManifest).not.toHaveBeenCalled();
  });
  it("validates projection event hashes, identity uniqueness and native-only authority", async () => {
    const h = harness();
    const value = await projection();
    h.listExecutionProjections.mockResolvedValueOnce({
      items: [value],
      nextCursor: null,
    });
    expect(await h.service.audit(principal, pageInput)).toEqual({
      items: [value],
      nextCursor: null,
    });

    for (const items of [
      [{ ...value, eventHash: digest }],
      [value, value],
      [{ ...value, authoritative: true }],
    ]) {
      h.listExecutionProjections.mockResolvedValueOnce({
        items,
        nextCursor: null,
      });
      await expect(h.service.audit(principal, pageInput)).rejects.toMatchObject(
        { code: "INVALID_SOURCE" }
      );
    }
  });
  it.each(nativeFacts)(
    "preserves native $kind facts without fabricating execution receipts",
    async (fact) => {
      const h = harness();
      const native = await nativeProjection(fact);
      const order = await projection();
      h.listExecutionProjections.mockResolvedValueOnce({
        items: [order, native],
        nextCursor: null,
      });
      expect(await h.service.audit(principal, pageInput)).toEqual({
        items: [order, native],
        nextCursor: null,
      });
      expect(Object.hasOwn(native, "receipt")).toBe(false);
      return expect(h.authorize).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: "stream-1",
          scope,
          action: "read",
        })
      );
    }
  );
  it("rejects native hash tampering, hybrid receipts, foreign scope and duplicate union identities", async () => {
    const h = harness();
    const native = await nativeProjection(nativeFacts[0]!);
    const order = await projection();
    const duplicateBody = { ...native, projectionId: order.projectionId };
    const duplicate = {
      ...duplicateBody,
      eventHash: await computeNativeFactProjectionHash(duplicateBody),
    };
    const foreignBody = { ...native, accountAlias: "foreign" };
    const foreign = {
      ...foreignBody,
      eventHash: await computeNativeFactProjectionHash(foreignBody),
    };

    for (const items of [
      [{ ...native, eventHash: digest }],
      [{ ...native, receipt: order.receipt }],
      [foreign],
      [order, duplicate],
      [{ ...native, environment: "live" }],
    ]) {
      h.listExecutionProjections.mockResolvedValueOnce({
        items,
        nextCursor: null,
      });
      await expect(h.service.audit(principal, pageInput)).rejects.toMatchObject(
        { code: "INVALID_SOURCE" }
      );
    }
  });
});

describe("composite inbox cursor", () => {
  it("never rereads an exhausted section and binds actor, scope and page limit", async () => {
    const h = harness();
    h.listArtifacts.mockImplementation(async (_actor, _scope, input) => ({
      items: [],
      nextCursor:
        input.contractName === "AgentRun" && input.cursor === null
          ? "agents_next"
          : null,
    }));
    const first = await h.service.inbox(principal, { ...pageInput, limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const second = await h.service.inbox(principal, {
      ...pageInput,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.nextCursor).toBeNull();
    expect(
      h.listArtifacts.mock.calls.filter(
        (call) => call[2].contractName === "StrategySpec"
      )
    ).toHaveLength(1);
    expect(h.listScopeReviews).toHaveBeenCalledTimes(1);
    expect(
      h.listArtifacts.mock.calls
        .filter((call) => call[2].contractName === "AgentRun")
        .map((call) => call[2].cursor)
    ).toEqual([null, "agents_next"]);

    for (const [who, input] of [
      [
        { ...principal, userId: "other" },
        { ...pageInput, limit: 1, cursor: first.nextCursor },
      ],
      [
        principal,
        {
          ...pageInput,
          accountAlias: "other",
          limit: 1,
          cursor: first.nextCursor,
        },
      ],
      [principal, { ...pageInput, limit: 2, cursor: first.nextCursor }],
    ] as const) {
      await expect(h.service.inbox(who, input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
  });
  it("cannot reuse a cursor as an authorization grant", async () => {
    const h = harness();
    h.listArtifacts.mockImplementation(async () => ({
      items: [],
      nextCursor: "next",
    }));
    const first = await h.service.inbox(principal, pageInput);
    h.authorize.mockResolvedValue(false);
    h.listArtifacts.mockClear();
    await expect(
      h.service.inbox(principal, { ...pageInput, cursor: first.nextCursor })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    return expect(h.listArtifacts).not.toHaveBeenCalled();
  });
  it("fails unavailable when combined section cursors cannot fit4096", async () => {
    const h = harness();
    h.listArtifacts.mockResolvedValue({
      items: [],
      nextCursor: "a".repeat(3000),
    });
    return await expect(
      h.service.inbox(principal, pageInput)
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});

describe("bounded exact-strategy dossier joins", () => {
  it("resolves reasonEvidenceIds and backtest dataset IDs with catalog, storage and rights", async () => {
    const h = harness();
    await h.add("strategy-artifact", "StrategySpec", strategy);
    await h.add("draft-artifact", "TradeIntent", draft, "collection-1");
    await h.add("backtest-artifact", "BacktestRun", backtest, "collection-1");
    await h.add(
      "evidence-artifact",
      "ResearchEvidence",
      evidence,
      "collection-1"
    );
    await h.add("dataset-artifact", "DatasetManifest", dataset, "collection-1");
    const result = await h.service.dossier(principal, {
      ...scope,
      artifactId: "strategy-artifact",
    });
    expect(result.drafts.map((item) => item.artifactId)).toEqual([
      "draft-artifact",
    ]);
    expect(result.evidence).toEqual([evidence]);
    expect(result.datasets).toEqual([dataset]);
    expect(result.backtests.map((item) => item.artifactId)).toEqual([
      "backtest-artifact",
    ]);
    expect(h.findRecordArtifact).toHaveBeenCalledWith(
      { actorId: principal.userId },
      scope,
      { contractName: "ResearchEvidence", recordId: "evidence-1" }
    );
    expect(h.listArtifacts).toHaveBeenCalledWith(
      { actorId: principal.userId },
      scope,
      {
        limit: 100,
        cursor: null,
        strategyVersion: "strategy-artifact",
        contractName: "TradeIntent",
      }
    );
    expect(h.listPaperAdmissions).toHaveBeenCalledWith(
      { actorId: principal.userId },
      scope,
      { limit: 100, cursor: null, strategyVersion: "strategy-artifact" }
    );
    return expect(h.mutate).not.toHaveBeenCalled();
  });
  it("never substitutes an empty list when linked evidence is unavailable", async () => {
    const h = harness();
    await h.add("strategy-artifact", "StrategySpec", strategy);
    await h.add("draft-artifact", "TradeIntent", draft, "collection-1");
    return await expect(
      h.service.dossier(principal, {
        ...scope,
        artifactId: "strategy-artifact",
      })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("rejects a version label in place of the exact immutable strategy and mismatched source hashes", async () => {
    const h = harness();
    await h.add("strategy-artifact", "StrategySpec", strategy);
    const wrong = await h.add(
      "backtest-artifact",
      "BacktestRun",
      { ...backtest, strategyVersion: strategy.version },
      "collection-1"
    );
    h.listArtifacts
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({ items: [wrong.metadata], nextCursor: null });
    await expect(
      h.service.dossier(principal, {
        ...scope,
        artifactId: "strategy-artifact",
      })
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await h.add("backtest-artifact", "BacktestRun", backtest, "collection-1");
    const data = await h.add(
      "dataset-artifact",
      "DatasetManifest",
      dataset,
      "collection-1"
    );
    data.metadata = { ...data.metadata, sourceContentSha256: "b".repeat(64) };
    return await expect(
      h.service.dossier(principal, {
        ...scope,
        artifactId: "strategy-artifact",
      })
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
  it("joins persisted review and admission only to the exact scoped draft hash", async () => {
    const h = harness();
    await h.add("strategy-artifact", "StrategySpec", strategy);
    const intent = await h.add(
      "draft-artifact",
      "TradeIntent",
      draft,
      "collection-1"
    );
    await h.add(
      "evidence-artifact",
      "ResearchEvidence",
      evidence,
      "collection-1"
    );
    const reviewed = {
      schemaVersion: "1.0.0",
      reviewId: "review-1",
      ...scope,
      collectionId: "collection-1",
      artifactId: "draft-artifact",
      artifactSha256: intent.metadata.artifactSha256,
      reviewVersion: "1.0.0",
      decision: "accepted",
      purpose: "paper-simulation",
      actorId: "reviewer-1",
      reviewedAt: NOW,
      expiresAt: AFTER,
      policyVersion: "1.0.0",
      strategyVersion: "strategy-artifact",
      supersedesReviewId: null,
      executionAuthorized: false,
    };
    const admitted = {
      schemaVersion: "1.0.0",
      admissionId: "admission-1",
      admissionKind: "PAPER-SIMULATION",
      ...scope,
      simulatorId: "simulator-1",
      streamId: "stream-1",
      ownerEpoch: "1",
      intentId: "intent-1",
      intentSha256: intent.metadata.artifactSha256,
      reviewedArtifactSha256: intent.metadata.artifactSha256,
      reviewId: "review-1",
      reviewVersion: "1.0.0",
      actorId: "reviewer-1",
      policyVersion: "1.0.0",
      strategyVersion: "strategy-artifact",
      portfolioSnapshotId: "portfolio-1",
      portfolioSequence: "1",
      maximumLoss: "10",
      maximumNotional: "100",
      admittedAt: NOW,
      expiresAt: AFTER,
      idempotencyKey: "admission-key",
      simulationOnly: true,
      brokerSubmissionAllowed: false,
      liveAuthorization: false,
      executionAuthorized: false,
    };
    h.listScopeReviews.mockResolvedValue({
      items: [reviewed],
      nextCursor: null,
    });
    h.listPaperAdmissions.mockResolvedValue({
      items: [admitted],
      nextCursor: null,
    });
    const result = await h.service.dossier(principal, {
      ...scope,
      artifactId: "strategy-artifact",
    });
    expect(result.reviews).toEqual([reviewed]);
    expect(result.admissions).toEqual([admitted]);
    expect(result.evidence[0]?.acceptanceStatus).toBe("unreviewed");
    h.listScopeReviews.mockResolvedValueOnce({
      items: [{ ...reviewed, artifactSha256: digest }],
      nextCursor: null,
    });
    await expect(
      h.service.dossier(principal, {
        ...scope,
        artifactId: "strategy-artifact",
      })
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    h.listPaperAdmissions.mockResolvedValueOnce({
      items: [{ ...admitted, actorId: "foreign-reviewer" }],
      nextCursor: null,
    });
    await expect(
      h.service.dossier(principal, {
        ...scope,
        artifactId: "strategy-artifact",
      })
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    return expect(h.mutate).not.toHaveBeenCalled();
  });
  it("fails unavailable rather than returning a truncated513-record dossier section", async () => {
    const h = harness();
    await h.add("strategy-artifact", "StrategySpec", strategy);
    const all: VertexArtifactMetadata[] = [];
    for (let index = 0; index < 513; index += 1) {
      const stored = await h.add(
        `draft-${index}`,
        "TradeIntent",
        { ...draft, intentId: `intent-${index}` },
        "collection-1"
      );
      all.push(stored.metadata);
    }
    let offset = 0;
    h.listArtifacts.mockImplementation(async () => {
      const items = all.slice(offset, offset + 100);
      offset += items.length;
      return {
        items,
        nextCursor: offset < all.length ? `offset_${offset}` : null,
      };
    });
    await expect(
      h.service.dossier(principal, {
        ...scope,
        artifactId: "strategy-artifact",
      })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(h.listArtifacts).toHaveBeenCalledTimes(6);
    return expect(h.findRecordArtifact).toHaveBeenCalledTimes(1);
  });
  it("caps each collected section512 and refuses repeated or endlessly advancing cursors", async () => {
    const h = harness();
    await h.add("strategy-artifact", "StrategySpec", strategy);
    let page = 0;
    h.listArtifacts.mockImplementation(async () => ({
      items: [],
      nextCursor: `page_${++page}`,
    }));
    await expect(
      h.service.dossier(principal, {
        ...scope,
        artifactId: "strategy-artifact",
      })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(h.listArtifacts).toHaveBeenCalledTimes(8);
    h.listArtifacts.mockResolvedValue({ items: [], nextCursor: "cycle" });
    return await expect(
      h.service.dossier(principal, {
        ...scope,
        artifactId: "strategy-artifact",
      })
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
});

describe("read-only gateway", () => {
  it("keeps an unavailable status unavailable and invokes no mutation", async () => {
    const h = harness();
    expect(
      await h.service.gateway(principal, {
        gatewayId: "gateway-1",
        environment: "paper",
      })
    ).toEqual(gatewayStatus);
    expect(h.readStatus).toHaveBeenCalledWith(
      { actorId: principal.userId },
      "gateway-1",
      "paper",
      undefined
    );
    expect(h.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        scope,
        resourceId: "account-scope",
        action: "read",
      })
    );
    expect(h.mutate).not.toHaveBeenCalled();
    // Every exposed method is a read and never requests or admits a run.
    return expect(Object.keys(h.service).sort()).toEqual([
      "agent",
      "agents",
      "audit",
      "continuity",
      "dossier",
      "gateway",
      "gateways",
      "inbox",
      "portfolio",
      "scopes",
      "strategies",
    ]);
  });
  it("requires configured resolver and exact account/environment authorization", async () => {
    const h = harness();
    await expect(
      createVertexExperienceReads(
        withoutDependency(h.dependencies, "gateway")
      ).gateway(principal, { gatewayId: "gateway-1", environment: "paper" })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    h.resolveScope.mockResolvedValueOnce(null);
    await expect(
      h.service.gateway(principal, {
        gatewayId: "gateway-1",
        environment: "paper",
      })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    h.resolveScope.mockResolvedValueOnce({ ...scope, environment: "live" });
    await expect(
      h.service.gateway(principal, {
        gatewayId: "gateway-1",
        environment: "paper",
      })
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    h.authorize.mockImplementation(
      async (input) => input.resourceId !== "gateway-1"
    );
    await expect(
      h.service.gateway(principal, {
        gatewayId: "gateway-1",
        environment: "paper",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    return expect(h.readStatus).not.toHaveBeenCalled();
  });
  it("rejects foreign gateway status rather than displaying it", async () => {
    const h = harness();
    h.readStatus.mockResolvedValueOnce({
      ...gatewayStatus,
      gatewayId: "other",
    });
    return await expect(
      h.service.gateway(principal, {
        gatewayId: "gateway-1",
        environment: "paper",
      })
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
});
