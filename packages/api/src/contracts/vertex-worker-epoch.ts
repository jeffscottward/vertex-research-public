import { z } from "zod";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  DigestSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  TimestampSchema,
} from "./vertex.ts";
import {
  PortfolioSnapshotSchema,
  ProjectionSequenceSchema,
  parsePortfolioGenesis,
  parseExecutionProjection,
} from "./vertex-control.ts";
import {
  parseNativeFactProjection,
  parseNativeJournalProof,
} from "./vertex-native-facts.ts";

const PositiveSequenceSchema = ProjectionSequenceSchema.refine(
  (value) => value !== "0",
  { message: "Expected positive epoch or journal sequence" }
);
export const MAX_EPOCH_TRANSITION_APPROVAL_BYTES = 1_048_576;
export const MAX_NATIVE_OUTBOX_REPLAY_DECODED_BYTES = 8_388_608;
// Dedicated replay route only; ordinary worker ingress keeps its smaller cap.
// Base64 expansion plus bounded grant/fence metadata fits this strict wire cap.
export const MAX_NATIVE_OUTBOX_REPLAY_WIRE_BYTES = 12_582_912;
const CanonicalApprovalBase64Schema = z
  .string()
  .min(4)
  .max(1_398_104)
  .refine(
    (value) => {
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          value
        )
      )
        return false;
      try {
        const decoded = atob(value);
        return (
          decoded.length > 0 &&
          decoded.length <= MAX_EPOCH_TRANSITION_APPROVAL_BYTES &&
          btoa(decoded) === value
        );
      } catch {
        return false;
      }
    },
    { message: "Expected canonical bounded native approval bytes" }
  );

// A restart is not seed admission. The separately enrolled native approver
// binds actual persisted prior-outbox ACK evidence, current owner fencing and
// the restored journal checkpoint to this exact immutable transition. The API
// shape alone, a worker grant, or these evidence hashes confer no authority.
export const PortfolioEpochTransitionSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    transitionId: IdentifierSchema,
    snapshot: PortfolioSnapshotSchema,
    priorOwnerEpoch: PositiveSequenceSchema,
    priorProjectionSequence: PositiveSequenceSchema,
    priorProjectionHash: DigestSchema,
    journalIdentity: IdentifierSchema,
    journalSequence: PositiveSequenceSchema,
    journalHeadSha256: DigestSchema,
    nativeOutboxEvidenceSha256: DigestSchema,
    nativeOwnerFenceSha256: DigestSchema,
    approvalBase64: CanonicalApprovalBase64Schema,
  })
  .strict()
  .refine(
    (value) => {
      return (
        value.snapshot.environment === "paper" &&
        value.snapshot.sourceKind === "paper-simulation" &&
        value.snapshot.sequence === "1" &&
        value.snapshot.continuity.state === "continuous" &&
        BigInt(value.snapshot.ownerEpoch) > BigInt(value.priorOwnerEpoch)
      );
    },
    {
      message:
        "Epoch transition requires a restored paper genesis and a strictly newer native owner",
    }
  )
  .readonly()
  .transform(deepFreezeArtifact);

export type PortfolioEpochTransition = z.infer<
  typeof PortfolioEpochTransitionSchema
>;
export const parsePortfolioEpochTransition = async (
  input: unknown
): Promise<PortfolioEpochTransition> => {
  canonicalArtifactJson(input);
  const value = PortfolioEpochTransitionSchema.parse(input);
  await parsePortfolioGenesis(value.snapshot);
  return value;
};

// Stable request identity includes exact signed bytes. The native signed
// statement binds snapshot SHA and evidence hashes, NOT this hash (which would
// otherwise circularly contain its own signature).
export const computePortfolioEpochTransitionHash = async (
  input: unknown
): Promise<string> => {
  const value = await parsePortfolioEpochTransition(input);
  return hashArtifact(value);
};

const ReplayKindSchema = z.enum([
  "portfolio-genesis",
  "portfolio-snapshot",
  "order",
  "native-fact",
]);
const NativeReplayRowIdentitySchema = z
  .object({
    projectionId: IdentifierSchema,
    sequence: PositiveSequenceSchema,
    eventHash: DigestSchema,
    projectionRawSha256: DigestSchema,
    kind: ReplayKindSchema,
    proofSha256: DigestSchema.nullable(),
  })
  .strict()
  .refine(
    (value) => (value.kind === "native-fact") === (value.proofSha256 !== null),
    { message: "Only native facts carry journal proof bytes" }
  );
export const NativeOutboxReplayGrantSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    grantId: IdentifierSchema,
    accountAlias: IdentifierSchema,
    environment: z.literal("paper"),
    streamId: IdentifierSchema,
    priorOwnerEpoch: PositiveSequenceSchema,
    currentOwnerEpoch: PositiveSequenceSchema,
    serviceActorId: IdentifierSchema,
    startingSequence: ProjectionSequenceSchema,
    startingEventHash: DigestSchema.nullable(),
    journalIdentity: IdentifierSchema,
    journalSequence: PositiveSequenceSchema,
    journalHeadSha256: DigestSchema,
    nativeJournalEvidenceSha256: DigestSchema,
    nativeOwnerFenceSha256: DigestSchema,
    retainedEpochTransitionSha256: DigestSchema.nullable(),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    rows: z.array(NativeReplayRowIdentitySchema).min(1).max(64),
    approvalBase64: CanonicalApprovalBase64Schema,
  })
  .strict()
  .refine(
    (value) => {
      if (
        BigInt(value.currentOwnerEpoch) <= BigInt(value.priorOwnerEpoch) ||
        (value.startingSequence === "0") !==
          (value.startingEventHash === null) ||
        timestampToEpochNanoseconds(value.issuedAt) >=
          timestampToEpochNanoseconds(value.expiresAt)
      )
        return false;
      if (
        value.retainedEpochTransitionSha256 !== null &&
        (value.startingSequence !== "0" ||
          value.rows[0]?.kind !== "portfolio-genesis")
      )
        return false;
      if (
        new Set(value.rows.map((row) => `${row.kind}:${row.projectionId}`))
          .size !== value.rows.length
      )
        return false;
      let sequence = BigInt(value.startingSequence);
      let eventHash = value.startingEventHash;
      for (const row of value.rows) {
        if (row.kind === "portfolio-snapshot") {
          if (
            sequence === 0n ||
            BigInt(row.sequence) !== sequence ||
            row.eventHash !== eventHash
          )
            return false;
        } else {
          if (
            BigInt(row.sequence) !== sequence + 1n ||
            (row.kind === "portfolio-genesis" && sequence !== 0n) ||
            (sequence === 0n && row.kind !== "portfolio-genesis")
          )
            return false;
          sequence = BigInt(row.sequence);
          eventHash = row.eventHash;
        }
      }
      return true;
    },
    {
      message:
        "Replay grant must bind a newer owner to an exact contiguous retained old outbox",
    }
  )
  .readonly()
  .transform(deepFreezeArtifact);

export const NativeOutboxReplaySchema = z
  .object({
    grant: NativeOutboxReplayGrantSchema,
    retainedEpochTransitionBase64: CanonicalApprovalBase64Schema.nullable(),
    rows: z
      .array(
        z
          .object({
            kind: ReplayKindSchema,
            projectionBase64: CanonicalApprovalBase64Schema,
            proofBase64: CanonicalApprovalBase64Schema.nullable(),
          })
          .strict()
      )
      .min(1)
      .max(64),
  })
  .strict()
  .refine(
    (value) => {
      if (value.rows.length !== value.grant.rows.length) return false;
      if (
        (value.retainedEpochTransitionBase64 === null) !==
        (value.grant.retainedEpochTransitionSha256 === null)
      )
        return false;
      let bytes =
        atob(value.grant.approvalBase64).length +
        (value.retainedEpochTransitionBase64 === null
          ? 0
          : atob(value.retainedEpochTransitionBase64).length);
      for (const [index, row] of value.rows.entries()) {
        if (
          row.kind !== value.grant.rows[index]?.kind ||
          (row.kind === "native-fact") !== (row.proofBase64 !== null)
        )
          return false;
        bytes +=
          atob(row.projectionBase64).length +
          (row.proofBase64 === null ? 0 : atob(row.proofBase64).length);
      }
      return bytes <= MAX_NATIVE_OUTBOX_REPLAY_DECODED_BYTES;
    },
    {
      message:
        "Replay batch kinds/count/bytes must match the signed bounded grant",
    }
  )
  .readonly()
  .transform(deepFreezeArtifact);

export type NativeOutboxReplayGrant = z.infer<
  typeof NativeOutboxReplayGrantSchema
>;
export type NativeOutboxReplay = z.infer<typeof NativeOutboxReplaySchema>;
const base64Bytes = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
// Native human signature subject is {replaySha256: this digest}. Excluding ONLY
// approvalBase64 avoids circular hashing; every row/raw/proof/evidence hash and
// recipient/scope/epoch/expiry remains in the signed subject.
// biome-ignore lint/suspicious/useAwait: async keeps the promise contract so synchronous validation failures reject instead of throwing.
export const computeNativeOutboxReplayGrantHash = async (
  input: unknown
): Promise<string> => {
  canonicalArtifactJson(input);
  const { approvalBase64: _approvalBase64, ...binding } =
    NativeOutboxReplayGrantSchema.parse(input);
  return hashArtifact(binding);
};

export const parseNativeOutboxReplay = async (
  input: unknown
): Promise<NativeOutboxReplay> => {
  canonicalArtifactJson(input);
  const replay = NativeOutboxReplaySchema.parse(input);
  if (replay.retainedEpochTransitionBase64 !== null) {
    const bytes = base64Bytes(replay.retainedEpochTransitionBase64);
    if (
      (await hashArtifact(bytes)) !== replay.grant.retainedEpochTransitionSha256
    )
      throw new TypeError("Retained epoch transition raw hash mismatch");
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const decoded: unknown = JSON.parse(text);
    if (canonicalArtifactJson(decoded) !== text)
      throw new TypeError("Noncanonical retained epoch transition");
    const transition = await parsePortfolioEpochTransition(decoded);
    const first = replay.rows[0];
    if (first === undefined)
      throw new TypeError("Retained epoch transition genesis binding mismatch");
    const snapshotText = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(base64Bytes(first.projectionBase64));
    if (
      first.kind !== "portfolio-genesis" ||
      transition.snapshot.ownerEpoch !== replay.grant.priorOwnerEpoch ||
      transition.snapshot.accountAlias !== replay.grant.accountAlias ||
      transition.snapshot.streamId !== replay.grant.streamId ||
      canonicalArtifactJson(transition.snapshot) !== snapshotText
    )
      throw new TypeError("Retained epoch transition genesis binding mismatch");
    // This is historical signed provenance only. Fresh replay approval must
    // independently ratify it after current revocation and native evidence
    // checks. Parsing never revives an expired original approval as authority.
  }
  let priorHash = replay.grant.startingEventHash;
  for (const [index, row] of replay.rows.entries()) {
    const identity = replay.grant.rows[index];
    if (identity === undefined)
      throw new TypeError("Native replay row identity mismatch");
    const bytes = base64Bytes(row.projectionBase64);
    if ((await hashArtifact(bytes)) !== identity.projectionRawSha256)
      throw new TypeError("Native replay raw projection hash mismatch");
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const decoded: unknown = JSON.parse(text);
    if (canonicalArtifactJson(decoded) !== text)
      throw new TypeError("Noncanonical native replay projection");
    const value =
      row.kind === "native-fact"
        ? await parseNativeFactProjection(decoded)
        : row.kind === "order"
          ? await parseExecutionProjection(decoded)
          : row.kind === "portfolio-genesis"
            ? await parsePortfolioGenesis(decoded)
            : PortfolioSnapshotSchema.parse(decoded);
    if (
      value.accountAlias !== replay.grant.accountAlias ||
      value.environment !== "paper" ||
      value.streamId !== replay.grant.streamId ||
      value.ownerEpoch !== replay.grant.priorOwnerEpoch ||
      value.sequence !== identity.sequence ||
      value.sourceKind !== "paper-simulation"
    )
      throw new TypeError("Native replay scope mismatch");
    if ("projectionId" in value) {
      if (
        value.projectionId !== identity.projectionId ||
        value.eventHash !== identity.eventHash ||
        value.previousEventHash !== priorHash
      )
        throw new TypeError("Native replay event chain mismatch");
      if (value.actorId !== replay.grant.serviceActorId)
        throw new TypeError("Native replay emitter mismatch");
    } else if (
      value.snapshotId !== identity.projectionId ||
      value.sourceEventHash !== identity.eventHash
    ) {
      throw new TypeError("Native replay snapshot identity mismatch");
    }
    if (row.kind === "native-fact") {
      if (row.proofBase64 === null)
        throw new TypeError("Native replay proof hash mismatch");
      const proofBytes = base64Bytes(row.proofBase64);
      if ((await hashArtifact(proofBytes)) !== identity.proofSha256)
        throw new TypeError("Native replay proof hash mismatch");
      await parseNativeJournalProof(
        await parseNativeFactProjection(decoded),
        proofBytes
      );
    }
    if (row.kind !== "portfolio-snapshot") priorHash = identity.eventHash;
  }
  return replay;
};

export const VERTEX_EPOCH_CONTRACT_SCHEMAS = Object.freeze({
  PortfolioEpochTransition: PortfolioEpochTransitionSchema,
  NativeOutboxReplayGrant: NativeOutboxReplayGrantSchema,
  NativeOutboxReplay: NativeOutboxReplaySchema,
});
