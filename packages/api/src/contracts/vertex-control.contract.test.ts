import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { RiskDecisionSchema, TradeIntentSchema } from "./vertex.ts";
import {
  AcceptedReviewSchema,
  ExecutionProjectionSchema,
  PaperSimulationAdmissionSchema,
  PortfolioSnapshotSchema,
  ProjectionContinuitySchema,
  ProjectionSequenceSchema,
  VertexContinuityGetInputSchema,
  VertexContinuityReadSchema,
  VertexPortfolioGetInputSchema,
  VertexPortfolioReadSchema,
  VertexReviewListInputSchema,
  VERTEX_CONTROL_CONTRACT_SCHEMAS,
  computeExecutionProjectionHash,
  parseExecutionProjection,
  computePortfolioGenesisHash,
  parsePortfolioGenesis,
} from "./vertex-control.ts";

// Entirely synthetic fixtures. No account, provider, broker or store is opened.
const hash = "a".repeat(64);
const asOf = "2026-09-22T12:00:00.000000001Z";
const received = "2026-09-22T12:00:00.000000002Z";
const evaluated = "2026-09-22T12:00:00.000000003Z";
const expires = "2026-09-22T12:01:00Z";
const scope = {
  accountAlias: "synthetic-paper",
  environment: "paper",
  streamId: "synthetic-stream",
  ownerEpoch: "1",
} as const;
const continuity = {
  ...scope,
  highWaterSequence: "1",
  highWaterEventHash: hash,
  lastOccurredAt: asOf,
  lastReceivedAt: received,
  evaluatedAt: evaluated,
  freshness: {
    status: "fresh",
    observedAt: asOf,
    evaluatedAt: evaluated,
    maxAgeMs: 1000,
  },
  state: "continuous",
  expectedNextSequence: "2",
  receivedSequence: null,
  newRiskInhibited: true,
  authoritative: false,
} as const;
const position = {
  instrumentId: "synthetic-equity",
  quantity: "2",
  marketValue: "20",
  costBasis: "18",
  currency: "USD",
  priceAsOf: asOf,
  sleeveId: "synthetic-sleeve",
} as const;
const portfolio = {
  schemaVersion: "1.0.0",
  snapshotId: "synthetic-snapshot",
  ...scope,
  sequence: "1",
  sourceEventHash: hash,
  sourceKind: "paper-simulation",
  asOfAt: asOf,
  receivedAt: received,
  currency: "USD",
  cash: "80",
  netAssetValue: "100",
  positions: [position],
  lots: [
    {
      lotId: "lot-1",
      instrumentId: "synthetic-equity",
      quantity: "2",
      unitCost: "9",
      currency: "USD",
      openedAt: asOf,
      sourceEventId: "source-event-1",
    },
  ],
  reservations: [
    {
      reservationId: "reservation-1",
      submissionKey: "submission-1",
      instrumentId: null,
      cashAmount: "5",
      shareQuantity: "0",
      currency: "USD",
      state: "reserved",
      sourceEventId: "source-event-1",
      authoritative: false,
    },
  ],
  sleeveAllocations: [
    {
      sleeveId: "synthetic-sleeve",
      allocatedAmount: "20",
      currency: "USD",
      sourceEventId: "source-event-1",
      authoritative: false,
    },
  ],
  continuity,
  observationOnly: true,
  executionAuthorized: false,
  researchNotionalIncluded: false,
} as const;
const review = {
  schemaVersion: "1.0.0",
  reviewId: "review-1",
  accountAlias: scope.accountAlias,
  environment: "paper",
  collectionId: null,
  artifactId: "intent-artifact-1",
  artifactSha256: hash,
  reviewVersion: "1.0.0",
  decision: "accepted",
  purpose: "paper-simulation",
  actorId: "synthetic-reviewer",
  reviewedAt: asOf,
  expiresAt: expires,
  policyVersion: "1.0.0",
  strategyVersion: "strategy-1.0.0",
  supersedesReviewId: null,
  executionAuthorized: false,
} as const;
const admission = {
  schemaVersion: "1.0.0",
  admissionId: "admission-1",
  admissionKind: "PAPER-SIMULATION",
  ...scope,
  simulatorId: "synthetic-simulator",
  intentId: "intent-1",
  intentSha256: hash,
  reviewedArtifactSha256: hash,
  reviewId: "review-1",
  reviewVersion: "1.0.0",
  actorId: "synthetic-reviewer",
  policyVersion: "1.0.0",
  strategyVersion: "strategy-1.0.0",
  portfolioSnapshotId: "synthetic-snapshot",
  portfolioSequence: "1",
  maximumLoss: "5",
  maximumNotional: "10",
  admittedAt: received,
  expiresAt: expires,
  idempotencyKey: "paper-admission-1",
  simulationOnly: true,
  brokerSubmissionAllowed: false,
  liveAuthorization: false,
  executionAuthorized: false,
} as const;
const receipt = {
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
  lastReconciledAt: asOf,
  errorClass: null,
  auditEventIds: ["source-event-1"],
} as const;
const projection = {
  schemaVersion: "1.0.0",
  projectionId: "projection-1",
  ...scope,
  sequence: "1",
  previousEventHash: null,
  eventHash: hash,
  occurredAt: asOf,
  receivedAt: received,
  actorId: "synthetic-native-owner",
  policyVersion: "1.0.0",
  strategyVersion: "strategy-1.0.0",
  reviewedArtifactSha256: hash,
  admissionId: "admission-1",
  expiresAt: expires,
  idempotencyKey: "projection-key-1",
  sourceKind: "paper-simulation",
  receipt,
  authoritative: false,
  reservationAuthority: "native-owner-only",
} as const;

// Authored under build-first instruction; execution belongs to the final gate.
describe("Vertex additive control contracts", () => {
  it("freezes the exact five extension schemas without altering existing registries", () => {
    expect(Object.keys(VERTEX_CONTROL_CONTRACT_SCHEMAS)).toEqual([
      "ProjectionContinuity",
      "PortfolioSnapshot",
      "AcceptedReview",
      "PaperSimulationAdmission",
      "ExecutionProjection",
    ]);
    expect(PortfolioSnapshotSchema.parse(portfolio)).toEqual(portfolio);
    expect(AcceptedReviewSchema.parse(review)).toEqual(review);
    expect(PaperSimulationAdmissionSchema.parse(admission)).toEqual(admission);
    expect(ExecutionProjectionSchema.parse(projection)).toEqual(projection);
    const snapshot = PortfolioSnapshotSchema.parse(portfolio);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.positions)).toBe(true);
    expect(Object.isFrozen(snapshot.positions[0])).toBe(true);
    return expect(Object.isFrozen(snapshot.continuity.freshness)).toBe(true);
  });

  it("seals the native simulation genesis by omitting exactly its two recursive hashes", async () => {
    const parsed = PortfolioSnapshotSchema.parse(portfolio);
    const {
      sourceEventHash: _sourceHash,
      continuity: initialContinuity,
      ...body
    } = parsed;
    const { highWaterEventHash: _headHash, ...continuityBody } =
      initialContinuity;
    const digest = await computePortfolioGenesisHash(parsed);
    expect(digest).toBe(
      await hashArtifact({ ...body, continuity: continuityBody })
    );
    const sealed = {
      ...parsed,
      sourceEventHash: digest,
      continuity: { ...parsed.continuity, highWaterEventHash: digest },
    };
    expect(await parsePortfolioGenesis(sealed)).toEqual(sealed);
    await expect(
      parsePortfolioGenesis({ ...sealed, cash: "81" })
    ).rejects.toThrow("hash mismatch");
    await expect(
      parsePortfolioGenesis({ ...sealed, snapshotId: "other" })
    ).rejects.toThrow("hash mismatch");
    await expect(
      computePortfolioGenesisHash(
        PortfolioSnapshotSchema.parse({
          ...portfolio,
          sourceKind: "broker-observation",
        })
      )
    ).rejects.toThrow("initial paper-simulation");
    return await expect(
      computePortfolioGenesisHash(
        PortfolioSnapshotSchema.parse({
          ...portfolio,
          sequence: "2",
          continuity: {
            ...continuity,
            highWaterSequence: "2",
            expectedNextSequence: "3",
          },
        })
      )
    ).rejects.toThrow("initial paper-simulation");
  });

  it.each(["0", "1", "9007199254740993", "999999999999999999999999999999"])(
    "preserves integer string %s beyond JS precision",
    (sequence) =>
      expect(ProjectionSequenceSchema.parse(sequence)).toBe(sequence)
  );

  it.each([
    0,
    1,
    -0,
    "-1",
    "01",
    "1.0",
    "1e3",
    "",
    "1000000000000000000000000000000",
  ])("rejects noncanonical sequence %s", (sequence) =>
    expect(ProjectionSequenceSchema.safeParse(sequence).success).toBe(false)
  );

  it("uses exact nanosecond ordering instead of Date truncation", () => {
    expect(ProjectionContinuitySchema.safeParse(continuity).success).toBe(true);
    expect(
      ProjectionContinuitySchema.safeParse({
        ...continuity,
        lastReceivedAt: "2026-09-22T12:00:00Z",
      }).success
    ).toBe(false);
    expect(
      ExecutionProjectionSchema.safeParse({
        ...projection,
        receivedAt: "2026-09-22T12:00:00Z",
      }).success
    ).toBe(false);
    expect(
      PaperSimulationAdmissionSchema.safeParse({
        ...admission,
        expiresAt: admission.admittedAt,
      }).success
    ).toBe(false);
    expect(
      PaperSimulationAdmissionSchema.safeParse({
        ...admission,
        admittedAt: "bad",
      }).success
    ).toBe(false);
    return expect(
      AcceptedReviewSchema.safeParse({
        ...review,
        expiresAt: "2026-02-30T12:00:00Z",
      }).success
    ).toBe(false);
  });

  it("represents empty continuity honestly and requires consecutive high-water marks", () => {
    const empty = {
      ...continuity,
      highWaterSequence: "0",
      highWaterEventHash: null,
      lastOccurredAt: null,
      lastReceivedAt: null,
      expectedNextSequence: "1",
      state: "empty",
      freshness: {
        ...continuity.freshness,
        status: "missing",
        observedAt: null,
      },
    };
    expect(ProjectionContinuitySchema.safeParse(empty).success).toBe(true);
    expect(
      ProjectionContinuitySchema.safeParse({ ...empty, state: "continuous" })
        .success
    ).toBe(false);
    expect(
      ProjectionContinuitySchema.safeParse({
        ...continuity,
        highWaterSequence: "9007199254740993",
        expectedNextSequence: "9007199254740994",
      }).success
    ).toBe(true);
    expect(
      ProjectionContinuitySchema.safeParse({
        ...continuity,
        expectedNextSequence: "3",
      }).success
    ).toBe(false);
    expect(
      ProjectionContinuitySchema.safeParse({
        ...continuity,
        expectedNextSequence: "bad",
      }).success
    ).toBe(false);
    expect(
      ProjectionContinuitySchema.safeParse({
        ...continuity,
        highWaterSequence: "bad",
      }).success
    ).toBe(false);
    expect(
      ProjectionContinuitySchema.safeParse({
        ...continuity,
        highWaterEventHash: null,
      }).success
    ).toBe(false);
    expect(
      ProjectionContinuitySchema.safeParse({
        ...continuity,
        receivedSequence: "4",
      }).success
    ).toBe(false);
    return expect(
      ProjectionContinuitySchema.safeParse({
        ...continuity,
        freshness: { ...continuity.freshness, status: "unknown" },
      }).success
    ).toBe(false);
  });

  it("marks stale continuity as nonauthority and never enables risk from the cloud", () => {
    const later = "2026-09-22T12:00:02Z";
    const stale = {
      ...continuity,
      state: "stale",
      evaluatedAt: later,
      freshness: {
        ...continuity.freshness,
        status: "stale",
        evaluatedAt: later,
      },
    };
    expect(ProjectionContinuitySchema.safeParse(stale).success).toBe(true);
    expect(
      ProjectionContinuitySchema.safeParse({ ...stale, state: "continuous" })
        .success
    ).toBe(false);
    expect(
      ProjectionContinuitySchema.safeParse({ ...continuity, state: "stale" })
        .success
    ).toBe(false);
    expect(
      ProjectionContinuitySchema.safeParse({
        ...continuity,
        newRiskInhibited: false,
      }).success
    ).toBe(false);
    return expect(
      ProjectionContinuitySchema.safeParse({
        ...continuity,
        authoritative: true,
      }).success
    ).toBe(false);
  });

  it("rejects cross-account environment stream epoch and high-water portfolio bindings", () => {
    for (const mismatch of [
      { accountAlias: "other" },
      { environment: "live" },
      { streamId: "other-stream" },
      { ownerEpoch: "2" },
      { sequence: "2" },
      { sourceEventHash: "b".repeat(64) },
      { asOfAt: received },
      { receivedAt: evaluated },
    ]) {
      expect(
        PortfolioSnapshotSchema.safeParse({ ...portfolio, ...mismatch }).success
      ).toBe(false);
    }
    expect(
      PortfolioSnapshotSchema.safeParse({
        ...portfolio,
        positions: [position, position],
      }).success
    ).toBe(false);
    expect(
      PortfolioSnapshotSchema.safeParse({
        ...portfolio,
        lots: [...portfolio.lots, ...portfolio.lots],
      }).success
    ).toBe(false);
    expect(
      PortfolioSnapshotSchema.safeParse({
        ...portfolio,
        reservations: [...portfolio.reservations, ...portfolio.reservations],
      }).success
    ).toBe(false);
    return expect(
      PortfolioSnapshotSchema.safeParse({
        ...portfolio,
        sleeveAllocations: [
          ...portfolio.sleeveAllocations,
          ...portfolio.sleeveAllocations,
        ],
      }).success
    ).toBe(false);
  });

  it("does not disguise unavailable source or research notional as NAV", () => {
    expect(
      PortfolioSnapshotSchema.safeParse({
        ...portfolio,
        researchNotionalIncluded: true,
      }).success
    ).toBe(false);
    expect(
      PortfolioSnapshotSchema.safeParse({
        ...portfolio,
        sourceKind: "source-unavailable",
      }).success
    ).toBe(false);
    const unavailable = {
      ...portfolio,
      sourceKind: "source-unavailable",
      cash: null,
      netAssetValue: null,
      positions: [],
      lots: [],
      reservations: [],
      sleeveAllocations: [],
      continuity: { ...continuity, state: "unavailable" },
    };
    expect(PortfolioSnapshotSchema.safeParse(unavailable).success).toBe(true);
    expect(
      PortfolioSnapshotSchema.safeParse({
        ...unavailable,
        positions: [position],
      }).success
    ).toBe(false);
    const research = {
      ...portfolio,
      environment: "research",
      sourceKind: "broker-observation",
      continuity: { ...continuity, environment: "research" },
    };
    expect(PortfolioSnapshotSchema.safeParse(research).success).toBe(false);
    return expect(
      PortfolioSnapshotSchema.safeParse({ ...research, netAssetValue: null })
        .success
    ).toBe(true);
  });

  it("requires canonical decimal strings for all economic values", () => {
    for (const bad of [1, "1.0", "1e2", "-0", "NaN", "Infinity"]) {
      expect(
        PortfolioSnapshotSchema.safeParse({ ...portfolio, cash: bad }).success
      ).toBe(false);
      expect(
        PaperSimulationAdmissionSchema.safeParse({
          ...admission,
          maximumNotional: bad,
        }).success
      ).toBe(false);
    }
    return expect(
      PaperSimulationAdmissionSchema.safeParse({
        ...admission,
        maximumLoss: "0",
      }).success
    ).toBe(false);
  });

  it("binds reviews to explicit exact-version actors and expiring nonexecution purpose", () => {
    expect(
      AcceptedReviewSchema.safeParse({ ...review, purpose: "live" }).success
    ).toBe(false);
    expect(
      AcceptedReviewSchema.safeParse({ ...review, environment: "live" }).success
    ).toBe(false);
    expect(
      AcceptedReviewSchema.safeParse({ ...review, executionAuthorized: true })
        .success
    ).toBe(false);
    expect(
      AcceptedReviewSchema.safeParse({
        ...review,
        supersedesReviewId: review.reviewId,
      }).success
    ).toBe(false);
    expect(
      AcceptedReviewSchema.safeParse({ ...review, reviewVersion: "next" })
        .success
    ).toBe(false);
    return expect(
      AcceptedReviewSchema.safeParse({ ...review, actorId: "" }).success
    ).toBe(false);
  });

  it("admits simulation only and never repurposes drafts or eligibility as authorization", () => {
    for (const change of [
      { environment: "live" },
      { environment: "research" },
      { admissionKind: "PAPER-BROKER" },
      { simulationOnly: false },
      { brokerSubmissionAllowed: true },
      { executionAuthorized: true },
      { liveAuthorization: true },
      { reviewedArtifactSha256: "b".repeat(64) },
      { ownerEpoch: "0" },
      { portfolioSequence: "0" },
    ]) {
      expect(
        PaperSimulationAdmissionSchema.safeParse({ ...admission, ...change })
          .success
      ).toBe(false);
    }
    expect(TradeIntentSchema.safeParse(admission).success).toBe(false);
    expect(RiskDecisionSchema.safeParse(admission).success).toBe(false);
    return expect(
      PaperSimulationAdmissionSchema.safeParse({
        ...admission,
        proposalOnly: true,
      }).success
    ).toBe(false);
  });

  it("rejects a fabricated sequence chain and mismatched receipt environment", () => {
    expect(
      ExecutionProjectionSchema.safeParse({
        ...projection,
        previousEventHash: hash,
      }).success
    ).toBe(false);
    expect(
      ExecutionProjectionSchema.safeParse({
        ...projection,
        sequence: "2",
        previousEventHash: null,
      }).success
    ).toBe(false);
    expect(
      ExecutionProjectionSchema.safeParse({
        ...projection,
        sequence: "2",
        previousEventHash: hash,
      }).success
    ).toBe(true);
    expect(
      ExecutionProjectionSchema.safeParse({
        ...projection,
        receipt: { ...receipt, environment: "live" },
      }).success
    ).toBe(false);
    expect(
      ExecutionProjectionSchema.safeParse({ ...projection, admissionId: null })
        .success
    ).toBe(false);
    expect(
      ExecutionProjectionSchema.safeParse({
        ...projection,
        reservationAuthority: "cloud",
      }).success
    ).toBe(false);
    return expect(
      ExecutionProjectionSchema.safeParse({
        ...projection,
        authoritative: true,
      }).success
    ).toBe(false);
  });

  it("hashes every stable execution projection field except the hash itself", async () => {
    const parsed = ExecutionProjectionSchema.parse(projection);
    const { eventHash: _ignored, ...body } = parsed;
    const digest = await computeExecutionProjectionHash(parsed);
    expect(digest).toBe(await hashArtifact(canonicalArtifactJson(body)));
    const sealed = { ...projection, eventHash: digest };
    expect(await parseExecutionProjection(sealed)).toEqual(sealed);
    await expect(
      parseExecutionProjection({ ...sealed, actorId: "other-actor" })
    ).rejects.toThrow("hash mismatch");
    await expect(
      parseExecutionProjection({ ...sealed, accountAlias: "other-account" })
    ).rejects.toThrow("hash mismatch");
    await expect(
      parseExecutionProjection({ ...sealed, receivedAt: evaluated })
    ).rejects.toThrow("hash mismatch");
    return await expect(parseExecutionProjection(projection)).rejects.toThrow(
      "hash mismatch"
    );
  });

  it("rejects accessor inputs before invoking schema getters", async () => {
    let accessed = false;
    const hostile = { ...projection };
    Object.defineProperty(hostile, "actorId", {
      enumerable: true,
      get: () => {
        accessed = true;
        return "synthetic-native-owner";
      },
    });
    await expect(parseExecutionProjection(hostile)).rejects.toThrow();
    return expect(accessed).toBe(false);
  });

  it("rejects unknown versions and undeclared principal authority fields", () => {
    const cases = [
      { schema: PortfolioSnapshotSchema, value: portfolio },
      { schema: AcceptedReviewSchema, value: review },
      { schema: PaperSimulationAdmissionSchema, value: admission },
      { schema: ExecutionProjectionSchema, value: projection },
    ];

    for (const { schema, value } of cases) {
      expect(
        schema.safeParse({ ...value, schemaVersion: "2.0.0" }).success
      ).toBe(false);
      expect(schema.safeParse({ ...value, admin: true }).success).toBe(false);
      expect(
        schema.safeParse({ ...value, principal: { actorId: "other" } }).success
      ).toBe(false);
    }
  });

  it("distinguishes not-found and unavailable read states without exposing mutation", () => {
    expect(
      VertexPortfolioReadSchema.safeParse({
        status: "available",
        snapshot: portfolio,
      }).success
    ).toBe(true);
    expect(
      VertexContinuityReadSchema.safeParse({ status: "available", continuity })
        .success
    ).toBe(true);
    for (const reason of [
      "capability-disabled",
      "source-unavailable",
      "not-found",
    ]) {
      expect(
        VertexPortfolioReadSchema.safeParse({
          status: "unavailable",
          reason,
          executionAuthorized: false,
        }).success
      ).toBe(true);
      expect(
        VertexContinuityReadSchema.safeParse({
          status: "unavailable",
          reason,
          executionAuthorized: false,
        }).success
      ).toBe(true);
    }
    expect(
      VertexPortfolioGetInputSchema.parse({
        accountAlias: scope.accountAlias,
        environment: "paper",
      })
    ).toEqual({ accountAlias: scope.accountAlias, environment: "paper" });
    expect(
      VertexContinuityGetInputSchema.safeParse({
        accountAlias: scope.accountAlias,
        environment: "paper",
        streamId: scope.streamId,
      }).success
    ).toBe(true);
    expect(
      VertexReviewListInputSchema.safeParse({
        accountAlias: scope.accountAlias,
        environment: "paper",
        artifactId: "artifact-1",
      }).success
    ).toBe(true);
    expect(
      VertexPortfolioGetInputSchema.safeParse({
        accountAlias: scope.accountAlias,
        environment: "paper",
        includeOtherAccounts: true,
      }).success
    ).toBe(false);
    expect(
      VertexContinuityGetInputSchema.safeParse({
        accountAlias: scope.accountAlias,
        environment: "paper",
        streamId: "../other",
      }).success
    ).toBe(false);
    return expect(
      VertexPortfolioReadSchema.safeParse({
        status: "unavailable",
        reason: "unknown",
        executionAuthorized: false,
      }).success
    ).toBe(false);
  });
});
