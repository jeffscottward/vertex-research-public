import { z } from "zod";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  DecimalStringSchema,
  DigestSchema,
  ExecutionReceiptSchema,
  FreshnessSchema,
  IdentifierSchema,
  NonnegativeDecimalSchema,
  PositiveDecimalSchema,
  SchemaVersionSchema,
  TimestampSchema,
  VersionSchema,
} from "./vertex.ts";

// Additive records only. Existing TradeIntent and RiskDecision remain drafts.
// A paper-simulation admission is never a broker-paper or live authority grant.
export const VertexEnvironmentSchema = z.enum(["research", "paper", "live"]);
export const ProjectionSequenceSchema = z.string().regex(/^(0|[1-9]\d{0,29})$/);
const PositiveSequenceSchema = ProjectionSequenceSchema.refine(
  (value) => value !== "0",
  { message: "Expected a positive sequence" }
);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const ids = () =>
  z
    .array(IdentifierSchema)
    .max(512)
    .refine((values) => new Set(values).size === values.length, {
      message: "Duplicate identity",
    });
const ordered = (start: string, end: string, equal = false): boolean => {
  try {
    const left = timestampToEpochNanoseconds(start);
    const right = timestampToEpochNanoseconds(end);
    return equal ? left <= right : left < right;
  } catch {
    return false;
  }
};

const projectionScope = {
  accountAlias: IdentifierSchema,
  environment: VertexEnvironmentSchema,
  streamId: IdentifierSchema,
  ownerEpoch: PositiveSequenceSchema,
};
export const ProjectionContinuitySchema = z
  .object({
    ...projectionScope,
    highWaterSequence: ProjectionSequenceSchema,
    highWaterEventHash: DigestSchema.nullable(),
    lastOccurredAt: TimestampSchema.nullable(),
    lastReceivedAt: TimestampSchema.nullable(),
    evaluatedAt: TimestampSchema,
    freshness: FreshnessSchema,
    state: z.enum([
      "empty",
      "continuous",
      "gap",
      "stale",
      "epoch-mismatch",
      "unavailable",
    ]),
    expectedNextSequence: PositiveSequenceSchema,
    receivedSequence: ProjectionSequenceSchema.nullable(),
    newRiskInhibited: z.literal(true),
    authoritative: z.literal(false),
  })
  .strict()
  .refine(
    (value) => {
      if (
        !(
          ProjectionSequenceSchema.safeParse(value.highWaterSequence).success &&
          ProjectionSequenceSchema.safeParse(value.expectedNextSequence).success
        )
      )
        return false;
      if (
        BigInt(value.expectedNextSequence) !==
        BigInt(value.highWaterSequence) + 1n
      )
        return false;
      if (
        value.freshness.evaluatedAt !== value.evaluatedAt ||
        value.freshness.observedAt !== value.lastOccurredAt
      )
        return false;
      if (value.highWaterSequence === "0") {
        return (
          value.highWaterEventHash === null &&
          value.lastOccurredAt === null &&
          value.lastReceivedAt === null &&
          value.state !== "continuous"
        );
      }
      if (
        value.highWaterEventHash === null ||
        value.lastOccurredAt === null ||
        value.lastReceivedAt === null
      )
        return false;
      if (
        !(
          ordered(value.lastOccurredAt, value.lastReceivedAt, true) &&
          ordered(value.lastReceivedAt, value.evaluatedAt, true)
        )
      )
        return false;
      if (value.state === "continuous")
        return (
          value.freshness.status === "fresh" && value.receivedSequence === null
        );
      if (value.state === "stale") return value.freshness.status === "stale";
      return value.state !== "empty";
    },
    { message: "Projection continuity does not match its high-water mark" }
  )
  .readonly()
  .transform(deepFreezeArtifact);

export const PortfolioPositionSchema = z
  .object({
    instrumentId: IdentifierSchema,
    quantity: DecimalStringSchema,
    marketValue: DecimalStringSchema.nullable(),
    costBasis: NonnegativeDecimalSchema.nullable(),
    currency: CurrencySchema,
    priceAsOf: TimestampSchema.nullable(),
    sleeveId: IdentifierSchema.nullable(),
  })
  .strict();
export const PortfolioLotSchema = z
  .object({
    lotId: IdentifierSchema,
    instrumentId: IdentifierSchema,
    quantity: DecimalStringSchema,
    unitCost: NonnegativeDecimalSchema,
    currency: CurrencySchema,
    openedAt: TimestampSchema,
    sourceEventId: IdentifierSchema,
  })
  .strict();
export const ReservationProjectionSchema = z
  .object({
    reservationId: IdentifierSchema,
    submissionKey: IdentifierSchema,
    instrumentId: IdentifierSchema.nullable(),
    cashAmount: NonnegativeDecimalSchema,
    shareQuantity: NonnegativeDecimalSchema,
    currency: CurrencySchema,
    state: z.enum(["reserved", "spent", "released", "unknown"]),
    sourceEventId: IdentifierSchema,
    authoritative: z.literal(false),
  })
  .strict();
export const SleeveAllocationProjectionSchema = z
  .object({
    sleeveId: IdentifierSchema,
    allocatedAmount: NonnegativeDecimalSchema,
    currency: CurrencySchema,
    sourceEventId: IdentifierSchema,
    authoritative: z.literal(false),
  })
  .strict();
export const PortfolioSnapshotSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    snapshotId: IdentifierSchema,
    ...projectionScope,
    sequence: PositiveSequenceSchema,
    sourceEventHash: DigestSchema,
    sourceKind: z.enum([
      "broker-observation",
      "paper-simulation",
      "source-unavailable",
    ]),
    asOfAt: TimestampSchema,
    receivedAt: TimestampSchema,
    currency: CurrencySchema,
    cash: DecimalStringSchema.nullable(),
    netAssetValue: DecimalStringSchema.nullable(),
    positions: z.array(PortfolioPositionSchema).max(10_000),
    lots: z.array(PortfolioLotSchema).max(20_000),
    reservations: z.array(ReservationProjectionSchema).max(10_000),
    sleeveAllocations: z.array(SleeveAllocationProjectionSchema).max(128),
    continuity: ProjectionContinuitySchema,
    observationOnly: z.literal(true),
    executionAuthorized: z.literal(false),
    researchNotionalIncluded: z.literal(false),
  })
  .strict()
  .refine(
    (value) => {
      const continuity = value.continuity;
      return (
        ordered(value.asOfAt, value.receivedAt, true) &&
        continuity.accountAlias === value.accountAlias &&
        continuity.environment === value.environment &&
        continuity.streamId === value.streamId &&
        continuity.ownerEpoch === value.ownerEpoch &&
        continuity.highWaterSequence === value.sequence &&
        continuity.highWaterEventHash === value.sourceEventHash &&
        continuity.lastOccurredAt === value.asOfAt &&
        continuity.lastReceivedAt === value.receivedAt &&
        (value.sourceKind !== "paper-simulation" ||
          value.environment === "paper") &&
        (value.environment !== "research" || value.netAssetValue === null) &&
        (value.sourceKind !== "source-unavailable" ||
          (value.cash === null &&
            value.netAssetValue === null &&
            value.positions.length === 0 &&
            value.lots.length === 0 &&
            value.reservations.length === 0 &&
            value.sleeveAllocations.length === 0 &&
            continuity.state === "unavailable")) &&
        new Set(value.positions.map((position) => position.instrumentId))
          .size === value.positions.length &&
        new Set(value.lots.map((lot) => lot.lotId)).size ===
          value.lots.length &&
        new Set(
          value.reservations.map((reservation) => reservation.reservationId)
        ).size === value.reservations.length &&
        new Set(value.sleeveAllocations.map((sleeve) => sleeve.sleeveId))
          .size === value.sleeveAllocations.length
      );
    },
    {
      message: "Portfolio observation scope, chronology or continuity mismatch",
    }
  )
  .readonly()
  .transform(deepFreezeArtifact);

// A native PAPER-SIMULATION owner may originate its own durable initial
// checkpoint before any simulated order exists. Cloud ingestion only observes
// this checkpoint; it cannot mint, spend or restore native simulation capital.
// Hash exactly the full snapshot minus these two self-referential hash fields.
// biome-ignore lint/suspicious/useAwait: async keeps the promise contract so synchronous validation failures reject instead of throwing.
export const computePortfolioGenesisHash = async (
  input: PortfolioSnapshot
): Promise<string> => {
  canonicalArtifactJson(input);
  const value = PortfolioSnapshotSchema.parse(input);
  if (
    value.environment !== "paper" ||
    value.sourceKind !== "paper-simulation" ||
    value.sequence !== "1" ||
    value.continuity.state !== "continuous"
  ) {
    throw new TypeError("Expected an initial paper-simulation observation");
  }
  const { sourceEventHash: _sourceEventHash, continuity, ...body } = value;
  const { highWaterEventHash: _highWaterEventHash, ...continuityBody } =
    continuity;
  return hashArtifact({ ...body, continuity: continuityBody });
};

export const parsePortfolioGenesis = async (
  input: unknown
): Promise<PortfolioSnapshot> => {
  canonicalArtifactJson(input);
  const value = PortfolioSnapshotSchema.parse(input);
  if ((await computePortfolioGenesisHash(value)) !== value.sourceEventHash)
    throw new TypeError("Portfolio genesis hash mismatch");
  return value;
};

export const AcceptedReviewSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    reviewId: IdentifierSchema,
    accountAlias: IdentifierSchema,
    environment: VertexEnvironmentSchema,
    collectionId: IdentifierSchema.nullable(),
    artifactId: IdentifierSchema,
    artifactSha256: DigestSchema,
    reviewVersion: VersionSchema,
    decision: z.enum(["accepted", "rejected"]),
    purpose: z.enum(["research", "paper-simulation"]),
    actorId: IdentifierSchema,
    reviewedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    policyVersion: VersionSchema,
    strategyVersion: IdentifierSchema,
    supersedesReviewId: IdentifierSchema.nullable(),
    executionAuthorized: z.literal(false),
  })
  .strict()
  .refine(
    (value) =>
      ordered(value.reviewedAt, value.expiresAt) &&
      (value.purpose !== "paper-simulation" || value.environment === "paper") &&
      value.supersedesReviewId !== value.reviewId,
    { message: "Review scope or expiry mismatch" }
  )
  .readonly()
  .transform(deepFreezeArtifact);

// The simulator consumes this separate immutable admission alongside a matching
// nonexecutable TradeIntent; it must independently verify hashes and current
// deterministic policy. No draft field is promoted or changed by this record.
export const PaperSimulationAdmissionSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    admissionId: IdentifierSchema,
    admissionKind: z.literal("PAPER-SIMULATION"),
    accountAlias: IdentifierSchema,
    environment: z.literal("paper"),
    simulatorId: IdentifierSchema,
    streamId: IdentifierSchema,
    ownerEpoch: PositiveSequenceSchema,
    intentId: IdentifierSchema,
    intentSha256: DigestSchema,
    reviewedArtifactSha256: DigestSchema,
    reviewId: IdentifierSchema,
    reviewVersion: VersionSchema,
    actorId: IdentifierSchema,
    policyVersion: VersionSchema,
    strategyVersion: IdentifierSchema,
    portfolioSnapshotId: IdentifierSchema,
    portfolioSequence: PositiveSequenceSchema,
    maximumLoss: PositiveDecimalSchema,
    maximumNotional: PositiveDecimalSchema,
    admittedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    idempotencyKey: IdentifierSchema,
    simulationOnly: z.literal(true),
    brokerSubmissionAllowed: z.literal(false),
    liveAuthorization: z.literal(false),
    executionAuthorized: z.literal(false),
  })
  .strict()
  .refine(
    (value) =>
      ordered(value.admittedAt, value.expiresAt) &&
      value.intentSha256 === value.reviewedArtifactSha256,
    {
      message:
        "Paper admission must bind the exact reviewed draft and an expiry",
    }
  )
  .readonly()
  .transform(deepFreezeArtifact);

export const ExecutionProjectionSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    projectionId: IdentifierSchema,
    ...projectionScope,
    sequence: PositiveSequenceSchema,
    previousEventHash: DigestSchema.nullable(),
    eventHash: DigestSchema,
    occurredAt: TimestampSchema,
    receivedAt: TimestampSchema,
    actorId: IdentifierSchema,
    policyVersion: VersionSchema,
    strategyVersion: IdentifierSchema,
    reviewedArtifactSha256: DigestSchema,
    admissionId: IdentifierSchema.nullable(),
    expiresAt: TimestampSchema,
    idempotencyKey: IdentifierSchema,
    sourceKind: z.enum(["broker-observation", "paper-simulation"]),
    receipt: ExecutionReceiptSchema,
    authoritative: z.literal(false),
    reservationAuthority: z.literal("native-owner-only"),
  })
  .strict()
  .refine(
    (value) => {
      return (
        ordered(value.occurredAt, value.receivedAt, true) &&
        ordered(value.occurredAt, value.expiresAt) &&
        value.receipt.environment === value.environment &&
        (value.sequence === "1"
          ? value.previousEventHash === null
          : value.previousEventHash !== null) &&
        (value.sourceKind !== "paper-simulation" ||
          (value.environment === "paper" && value.admissionId !== null))
      );
    },
    {
      message: "Execution projection scope, predecessor or chronology mismatch",
    }
  )
  .readonly()
  .transform(deepFreezeArtifact);

// eventHash covers the canonical record with eventHash omitted, including its
// exact receipt, scope, ordering, review binding and nanosecond timestamps.
// biome-ignore lint/suspicious/useAwait: async keeps the promise contract so synchronous validation failures reject instead of throwing.
export const computeExecutionProjectionHash = async (
  input: ExecutionProjection
): Promise<string> => {
  canonicalArtifactJson(input);
  const value = ExecutionProjectionSchema.parse(input);
  const { eventHash: _eventHash, ...payload } = value;
  return hashArtifact(canonicalArtifactJson(payload));
};

export const parseExecutionProjection = async (
  input: unknown
): Promise<ExecutionProjection> => {
  canonicalArtifactJson(input);
  const value = ExecutionProjectionSchema.parse(input);
  if ((await computeExecutionProjectionHash(value)) !== value.eventHash)
    throw new Error("Execution projection hash mismatch");
  return value;
};

export const VertexPortfolioGetInputSchema = z
  .object({
    accountAlias: IdentifierSchema,
    environment: VertexEnvironmentSchema,
  })
  .strict();
export const VertexContinuityGetInputSchema = z
  .object({
    accountAlias: IdentifierSchema,
    environment: VertexEnvironmentSchema,
    streamId: IdentifierSchema,
  })
  .strict();
export const VertexPortfolioReadSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("available"),
        snapshot: PortfolioSnapshotSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("unavailable"),
        reason: z.enum([
          "capability-disabled",
          "source-unavailable",
          "not-found",
        ]),
        executionAuthorized: z.literal(false),
      })
      .strict(),
  ])
  .readonly()
  .transform(deepFreezeArtifact);
export const VertexContinuityReadSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("available"),
        continuity: ProjectionContinuitySchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("unavailable"),
        reason: z.enum([
          "capability-disabled",
          "source-unavailable",
          "not-found",
        ]),
        executionAuthorized: z.literal(false),
      })
      .strict(),
  ])
  .readonly()
  .transform(deepFreezeArtifact);
export const VertexReviewListInputSchema = z
  .object({
    accountAlias: IdentifierSchema,
    environment: VertexEnvironmentSchema,
    artifactId: IdentifierSchema,
  })
  .strict();
export const VertexReviewListOutputSchema = z
  .array(AcceptedReviewSchema)
  .max(512)
  .readonly();
export const VertexControlArtifactRefsSchema = ids().readonly();

export type ProjectionContinuity = z.infer<typeof ProjectionContinuitySchema>;
export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshotSchema>;
export type PortfolioPosition = z.infer<typeof PortfolioPositionSchema>;
export type PortfolioLot = z.infer<typeof PortfolioLotSchema>;
export type ReservationProjection = z.infer<typeof ReservationProjectionSchema>;
export type SleeveAllocationProjection = z.infer<
  typeof SleeveAllocationProjectionSchema
>;
export type AcceptedReview = z.infer<typeof AcceptedReviewSchema>;
export type PaperSimulationAdmission = z.infer<
  typeof PaperSimulationAdmissionSchema
>;
export type ExecutionProjection = z.infer<typeof ExecutionProjectionSchema>;
export type VertexPortfolioGetInput = z.infer<
  typeof VertexPortfolioGetInputSchema
>;
export type VertexContinuityGetInput = z.infer<
  typeof VertexContinuityGetInputSchema
>;
export type VertexPortfolioRead = z.infer<typeof VertexPortfolioReadSchema>;
export type VertexContinuityRead = z.infer<typeof VertexContinuityReadSchema>;
export type VertexReviewListInput = z.infer<typeof VertexReviewListInputSchema>;

export const VERTEX_CONTROL_CONTRACT_SCHEMAS = {
  ProjectionContinuity: ProjectionContinuitySchema,
  PortfolioSnapshot: PortfolioSnapshotSchema,
  AcceptedReview: AcceptedReviewSchema,
  PaperSimulationAdmission: PaperSimulationAdmissionSchema,
  ExecutionProjection: ExecutionProjectionSchema,
} as const;
