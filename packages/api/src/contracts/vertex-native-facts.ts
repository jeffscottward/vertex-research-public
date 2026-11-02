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
  IdentifierSchema,
  PositiveDecimalSchema,
  SchemaVersionSchema,
  TimestampSchema,
  VersionSchema,
} from "./vertex.ts";
import { ProjectionSequenceSchema } from "./vertex-control.ts";

const PositiveSequenceSchema = ProjectionSequenceSchema.refine(
  (value) => value !== "0",
  { message: "Expected positive journal identity" }
);
const FactSequenceSchema = PositiveSequenceSchema.refine(
  (value) => {
    return (
      ProjectionSequenceSchema.safeParse(value).success && BigInt(value) >= 2n
    );
  },
  { message: "Native facts follow the sequence-one portfolio genesis" }
);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const ids = (maximum = 512) =>
  z
    .array(IdentifierSchema)
    .min(1)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, {
      message: "Duplicate source identity",
    });
const ordered = (left: string, right: string, equal = false): boolean => {
  try {
    const a = timestampToEpochNanoseconds(left);
    const b = timestampToEpochNanoseconds(right);
    return equal ? a <= b : a < b;
  } catch {
    return false;
  }
};

export const NativeCheckpointFactSchema = z
  .object({
    kind: z.literal("checkpoint"),
    snapshotId: IdentifierSchema,
    snapshotSha256: DigestSchema,
    journalSequence: PositiveSequenceSchema,
    journalHeadHash: DigestSchema,
  })
  .strict();
export const NativeCashSettlementFactSchema = z
  .object({
    kind: z.literal("cash-settlement"),
    settlementId: IdentifierSchema,
    currency: CurrencySchema,
    cashDelta: DecimalStringSchema,
    fillEventIds: ids(),
  })
  .strict();
const optionSettlement = {
  settlementId: IdentifierSchema,
  instrumentId: IdentifierSchema,
  underlyingId: IdentifierSchema,
  settlementKind: z.enum(["cash", "physical"]),
  settlementState: z.enum(["pending", "settled"]),
  quantity: PositiveDecimalSchema,
  currency: CurrencySchema,
  cashDelta: DecimalStringSchema,
  shareDelta: DecimalStringSchema,
  dueAt: TimestampSchema,
  fillEventIds: ids(),
};
export const NativeAssignmentFactSchema = z
  .object({ kind: z.literal("assignment"), ...optionSettlement })
  .strict();
export const NativeExerciseFactSchema = z
  .object({ kind: z.literal("exercise"), ...optionSettlement })
  .strict();
export const NativeOptionExpiryFactSchema = z
  .object({ kind: z.literal("option-expiry"), ...optionSettlement })
  .strict();
export const NativeCorporateActionFactSchema = z
  .object({
    kind: z.literal("corporate-action"),
    actionId: IdentifierSchema,
    oldInstrumentId: IdentifierSchema,
    newInstrumentId: IdentifierSchema,
    quantityNumerator: PositiveSequenceSchema,
    quantityDenominator: PositiveSequenceSchema,
    previousQuantity: DecimalStringSchema,
    newQuantity: DecimalStringSchema,
    cashDelta: DecimalStringSchema,
    currency: CurrencySchema,
    previousQualificationSha256: DigestSchema,
    replacementQualificationSha256: DigestSchema,
  })
  .strict();
export const NativeReconciliationFactSchema = z
  .object({
    kind: z.literal("reconciliation"),
    reconciliationId: IdentifierSchema,
    observedSnapshotId: IdentifierSchema,
    unknownCount: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .refine((value) => !Object.is(value, -0), {
        message: "Negative zero is not canonical",
      }),
    reconciled: z.boolean(),
  })
  .strict();
export const NativeKillStateFactSchema = z
  .object({
    kind: z.literal("kill-state"),
    action: z.enum(["pause-new-risk", "reset-new-risk", "reconcile-required"]),
    reasonCodes: ids(64),
    grantId: IdentifierSchema.nullable(),
  })
  .strict();

export const NativeFactSchema = z
  .discriminatedUnion("kind", [
    NativeCheckpointFactSchema,
    NativeCashSettlementFactSchema,
    NativeAssignmentFactSchema,
    NativeExerciseFactSchema,
    NativeOptionExpiryFactSchema,
    NativeCorporateActionFactSchema,
    NativeReconciliationFactSchema,
    NativeKillStateFactSchema,
  ])
  .refine(
    (fact) => {
      if (
        fact.kind === "assignment" ||
        fact.kind === "exercise" ||
        fact.kind === "option-expiry"
      ) {
        if (fact.instrumentId === fact.underlyingId) return false;
        if (fact.settlementKind === "cash" && fact.shareDelta !== "0")
          return false;
        if (
          fact.kind === "option-expiry" &&
          (fact.cashDelta !== "0" || fact.shareDelta !== "0")
        )
          return false;
      }
      if (
        fact.kind === "reconciliation" &&
        fact.reconciled &&
        fact.unknownCount !== 0
      )
        return false;
      if (
        fact.kind === "kill-state" &&
        fact.action === "reset-new-risk" &&
        fact.grantId === null
      )
        return false;
      return true;
    },
    {
      message:
        "Native observed fact contradicts settlement, reconciliation or reset state",
    }
  )
  .readonly()
  .transform(deepFreezeArtifact);

const occurredBinding = (
  fact: z.infer<typeof NativeFactSchema>,
  occurredAt: string
): boolean => {
  if (
    fact.kind === "assignment" ||
    fact.kind === "exercise" ||
    fact.kind === "option-expiry"
  ) {
    // Pending obligations may be due in the future. Their deltas describe the
    // obligation ONLY, never spendable cash/shares or a second reservation.
    return fact.settlementState === "settled"
      ? ordered(fact.dueAt, occurredAt, true)
      : true;
  }
  return true;
};

const FactOrdinalSchema = z
  .number()
  .int()
  .min(0)
  .max(63)
  .refine((value) => !Object.is(value, -0), {
    message: "Negative zero is not a canonical fact ordinal",
  });

export const NativeFactProjectionSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    projectionId: IdentifierSchema,
    accountAlias: IdentifierSchema,
    environment: z.literal("paper"),
    streamId: IdentifierSchema,
    ownerEpoch: PositiveSequenceSchema,
    sequence: FactSequenceSchema,
    // Journal identity is independent from the global order/fact stream sequence:
    // one durable native transition may emit up to 64 separately proved facts.
    proofJournalSequence: PositiveSequenceSchema,
    proofJournalHeadHash: DigestSchema,
    factOrdinal: FactOrdinalSchema,
    previousEventHash: DigestSchema,
    eventHash: DigestSchema,
    occurredAt: TimestampSchema,
    receivedAt: TimestampSchema,
    actorId: IdentifierSchema,
    policyVersion: VersionSchema,
    expiresAt: TimestampSchema,
    idempotencyKey: IdentifierSchema,
    sourceKind: z.literal("paper-simulation"),
    proof: z
      .object({
        artifactId: IdentifierSchema,
        sha256: DigestSchema,
        sourceEventId: IdentifierSchema,
      })
      .strict(),
    fact: NativeFactSchema,
    authoritative: z.literal(false),
    reservationAuthority: z.literal("native-owner-only"),
    executionAuthorized: z.literal(false),
  })
  .strict()
  .refine(
    (value) =>
      ordered(value.occurredAt, value.receivedAt, true) &&
      ordered(value.occurredAt, value.expiresAt) &&
      occurredBinding(value.fact, value.occurredAt),
    { message: "Native fact observation chronology mismatch" }
  )
  .readonly()
  .transform(deepFreezeArtifact);

export const NativeJournalProofSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    proofKind: z.literal("native-journal-event"),
    accountAlias: IdentifierSchema,
    environment: z.literal("paper"),
    streamId: IdentifierSchema,
    ownerEpoch: PositiveSequenceSchema,
    sourceEventId: IdentifierSchema,
    journalSequence: PositiveSequenceSchema,
    journalHeadHash: DigestSchema,
    factOrdinal: FactOrdinalSchema,
    occurredAt: TimestampSchema,
    eventType: z.enum([
      "checkpoint",
      "cash-settlement",
      "assignment",
      "exercise",
      "option-expiry",
      "corporate-action",
      "reconciliation",
      "kill-state",
    ]),
    payload: NativeFactSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.eventType === value.payload.kind &&
      occurredBinding(value.payload, value.occurredAt),
    { message: "Journal proof event type or settlement chronology mismatch" }
  )
  .readonly()
  .transform(deepFreezeArtifact);

export const MAX_NATIVE_JOURNAL_PROOF_BYTES = 1_048_576;
// biome-ignore lint/suspicious/useAwait: async keeps the promise contract so synchronous validation failures reject instead of throwing.
export const computeNativeFactProjectionHash = async (
  input: NativeFactProjection
): Promise<string> => {
  canonicalArtifactJson(input);
  const { eventHash: _eventHash, ...body } =
    NativeFactProjectionSchema.parse(input);
  return hashArtifact(body);
};
export const parseNativeFactProjection = async (
  input: unknown
): Promise<NativeFactProjection> => {
  canonicalArtifactJson(input);
  const value = NativeFactProjectionSchema.parse(input);
  if ((await computeNativeFactProjectionHash(value)) !== value.eventHash)
    throw new TypeError("Native fact hash mismatch");
  return value;
};
export const parseNativeJournalProof = async (
  projection: NativeFactProjection,
  inputBytes: Uint8Array
): Promise<NativeJournalProof> => {
  if (
    !(inputBytes instanceof Uint8Array) ||
    Object.getPrototypeOf(inputBytes) !== Uint8Array.prototype ||
    Object.hasOwn(inputBytes, "buffer") ||
    Object.hasOwn(inputBytes, "byteLength") ||
    Object.hasOwn(inputBytes, "length") ||
    Object.hasOwn(inputBytes, "byteOffset") ||
    !(inputBytes.buffer instanceof ArrayBuffer) ||
    inputBytes.byteLength === 0 ||
    inputBytes.byteLength > MAX_NATIVE_JOURNAL_PROOF_BYTES
  )
    throw new TypeError("Invalid native proof bytes");
  const bytes = new Uint8Array(inputBytes.byteLength);
  Uint8Array.prototype.set.call(bytes, inputBytes);
  const fact = await parseNativeFactProjection(projection);
  if ((await hashArtifact(bytes)) !== fact.proof.sha256)
    throw new TypeError("Native proof hash mismatch");
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const decoded: unknown = JSON.parse(text);
  if (canonicalArtifactJson(decoded) !== text)
    throw new TypeError("Noncanonical native proof");
  const proof = NativeJournalProofSchema.parse(decoded);
  if (
    proof.accountAlias !== fact.accountAlias ||
    proof.environment !== fact.environment ||
    proof.streamId !== fact.streamId ||
    proof.ownerEpoch !== fact.ownerEpoch ||
    proof.sourceEventId !== fact.proof.sourceEventId ||
    proof.journalSequence !== fact.proofJournalSequence ||
    proof.journalHeadHash !== fact.proofJournalHeadHash ||
    proof.factOrdinal !== fact.factOrdinal ||
    proof.occurredAt !== fact.occurredAt ||
    canonicalArtifactJson(proof.payload) !== canonicalArtifactJson(fact.fact)
  )
    throw new TypeError("Native proof observation binding mismatch");
  if (
    proof.payload.kind === "checkpoint" &&
    (proof.payload.journalSequence !== proof.journalSequence ||
      proof.payload.journalHeadHash !== proof.journalHeadHash)
  )
    throw new TypeError("Checkpoint proof head mismatch");
  return proof;
};

export type NativeFact = z.infer<typeof NativeFactSchema>;
export type NativeFactProjection = z.infer<typeof NativeFactProjectionSchema>;
export type NativeJournalProof = z.infer<typeof NativeJournalProofSchema>;
export const VERTEX_NATIVE_FACT_CONTRACT_SCHEMAS = {
  NativeFact: NativeFactSchema,
  NativeFactProjection: NativeFactProjectionSchema,
  NativeJournalProof: NativeJournalProofSchema,
} as const;
