import {
  canonicalArtifactJson,
  deepFreezeArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { z } from "zod";
import { DigestSchema, IdentifierSchema, TimestampSchema } from "./vertex.ts";
import {
  VertexResearchChatOrdinalSchema,
  VertexResearchChatSendMessageInputSchema,
} from "./vertex-research-chat.ts";

// Pure additive boundary, deliberately not registered as a procedure. These
// selectors, receipt shapes and digest strings establish no identity, access,
// copy/retention policy, corpus membership, artifact integrity or model grant.
const ResponseIdentifierSchema = IdentifierSchema.refine(
  (value) => value.trim() === value,
  { message: "Identifier must consume the complete string" }
);
const ResponseDigestSchema = DigestSchema.refine(
  (value) => value.trim() === value,
  { message: "Digest must consume the complete string" }
);
// Reuse actual human chat literal/scalar/control/nonblank semantics. The caller
// supplies a complete bounded query: no default, truncation or normalization.
// The bounds are UTF-16 code units. Zod >=4.6 measures min/max in code points,
// so min/max stay only as the documented minLength/maxLength (the minimum runs
// just below 10 units, where both measures agree) and the refine enforces both.
const documentedMinimum = z.minLength(10);
documentedMinimum._zod.def.when = (payload) =>
  typeof payload.value === "string" && payload.value.length < 10;
const RetrievalQuerySchema = VertexResearchChatSendMessageInputSchema.shape.body
  .check(documentedMinimum)
  .max(2000)
  .refine((value) => value.length >= 10 && value.length <= 2000, {
    message: "Expected 10 to 2000 UTF-16 code units",
  })
  .refine((value) => !/[\t\r\n]/u.test(value), {
    message: "Retrieval query must be single-line literal text",
  });
const scope = {
  accountAlias: ResponseIdentifierSchema,
  environment: z.literal("research"),
};
const record = {
  executionAuthorized: z.literal(false),
  schemaVersion: z.literal("1.0.0"),
};
const contextRange = {
  contextStartSequence: VertexResearchChatOrdinalSchema,
  snapshotRevision: VertexResearchChatOrdinalSchema,
};
const boundedRange = (value: {
  snapshotRevision: string;
  contextStartSequence: string;
}): boolean => {
  // String format failures can be nonfatal to Zod's subsequent refinements.
  // Always guard BigInt so malformed source scalars fail, never throw.
  try {
    const snapshot = BigInt(value.snapshotRevision);
    const count = snapshot - BigInt(value.contextStartSequence);
    return snapshot >= 2n && count >= 1n && count <= 16n;
  } catch {
    return false;
  }
};

// Use the shared canonical-domain validator before Zod visits properties. This
// rejects accessors, hidden/symbol fields and non-data graphs without executing
// getters. JSON.parse only detaches canonical data; it is not another encoder.
const CanonicalDataSchema = z.unknown().transform((value, ctx) => {
  try {
    return JSON.parse(canonicalArtifactJson(value)) as unknown;
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Response DTO must be a canonical JSON data graph",
    });
    return z.NEVER;
  }
});

export const VertexResearchChatResponseReasonCodeSchema = z.enum([
  "participant-unavailable",
  "corpus-unavailable",
  "context-limit",
  "context-lineage-unsupported",
  "context-use-unavailable",
  "context-retention-unavailable",
  "model-input-preparation-unavailable",
  "model-input-approval-unavailable",
  "research-runtime-unavailable",
  "worker-unavailable",
  "projection-unavailable",
  "policy-unavailable",
  "policy-revoked",
  "rights-denied",
  "review-unavailable",
  "deadline",
  "worker-failed",
  "cancelled",
  "outcome-unknown",
  // Definite causes added 2026-11 (additive). The broader codes above stay
  // valid for stored receipts and for stores that still write them.
  "research-runtime-not-configured",
  "model-input-denied",
  "model-input-approval-denied",
  "projection-read-failed",
  "projection-read-denied",
  // Cause of "projection-unavailable", sent next to it (additive). Each names
  // one distinct exit of the server's eligibility lookup.
  "response-not-recorded",
  "response-not-produced",
  "response-publication-unconfirmed",
  "response-input-copies-unconfirmed",
  "response-authority-closed",
  "response-check-incomplete",
  // Sent next to "outcome-unknown" when the worker job itself reports no
  // outcome; the worker reconciles when the job lease ends.
  "worker-outcome-unconfirmed",
]);
const UnavailableReasonsSchema = z
  .array(VertexResearchChatResponseReasonCodeSchema)
  .min(1)
  .max(32)
  .refine((values) => new Set(values).size === values.length, {
    message: "Duplicate response reason",
  })
  .readonly();

export const VertexResearchChatRequestResponseInputSchema =
  CanonicalDataSchema.pipe(
    z
      .object({
        ...scope,
        parentMessageId: ResponseIdentifierSchema,
        participantId: ResponseIdentifierSchema,
        threadId: ResponseIdentifierSchema,
        ...contextRange,
        idempotencyKey: ResponseIdentifierSchema,
        retrievalQuery: RetrievalQuerySchema,
      })
      .strict()
      .refine(boundedRange, {
        message:
          "Expected one explicit context range of one through sixteen messages",
      })
  );

// NOT_FOUND is absence at read time, not permission for a fresh key/recompute.
// A future authorized service must reconcile this exact original request key.
export const VertexResearchChatReadResponseInputSchema =
  CanonicalDataSchema.pipe(
    z
      .object({
        ...scope,
        idempotencyKey: ResponseIdentifierSchema,
        threadId: ResponseIdentifierSchema,
      })
      .strict()
  );

const receiptCommon = {
  ...record,
  ...scope,
  idempotencyKey: ResponseIdentifierSchema,
  ownerActorId: ResponseIdentifierSchema,
  parentMessageId: ResponseIdentifierSchema,
  participantId: ResponseIdentifierSchema,
  recordedAt: TimestampSchema,
  requestSha256: ResponseDigestSchema,
  responseRequestId: ResponseIdentifierSchema,
  threadId: ResponseIdentifierSchema,
  ...contextRange,
  // Proposal acceptance is not actual worker binding or compute admission.
  jobId: z.null(),
};
const AdmissionSchema = z
  .object({
    bindingSha256: ResponseDigestSchema,
    collectionId: ResponseIdentifierSchema,
    contextSha256: ResponseDigestSchema,
    eventId: ResponseIdentifierSchema,
    participantConfigSha256: ResponseDigestSchema,
    proposal: z
      .object({
        artifactId: ResponseIdentifierSchema,
        sha256: ResponseDigestSchema,
      })
      .strict()
      .readonly(),
    runId: ResponseIdentifierSchema,
  })
  .strict()
  .readonly();
const ReceiptShapeSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        ...receiptCommon,
        admission: z.null(),
        reasonCodes: UnavailableReasonsSchema,
        status: z.literal("unavailable"),
      })
      .strict(),
    z
      .object({
        ...receiptCommon,
        admission: AdmissionSchema,
        reasonCodes: z
          .array(VertexResearchChatResponseReasonCodeSchema)
          .length(0)
          .readonly(),
        status: z.literal("admitted"),
      })
      .strict(),
  ])
  .refine(boundedRange, {
    message: "Receipt must preserve the exact bounded requested prefix range",
  })
  .readonly();

// Immutable acknowledgement: never upgrade an unavailable receipt or insert a
// later worker identity. Raw-command and server-resolved binding hashes remain
// separate. DB integrity/current authorization are not proved by these schemas.
export const VertexResearchChatResponseReceiptSchema =
  CanonicalDataSchema.pipe(ReceiptShapeSchema).transform(deepFreezeArtifact);
/** @alias Named procedure schema kept distinct for the contract/OpenAPI surface. */
export const VertexResearchChatRequestResponseOutputSchema =
  VertexResearchChatResponseReceiptSchema;

const JobSchema = z
  .object({
    jobId: ResponseIdentifierSchema,
    // When the current job lease ends (additive; older servers omit it). A job
    // with no reported outcome is reconciled by the worker at this time.
    leaseExpiresAt: TimestampSchema.optional(),
    state: z.enum([
      "leased",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "unknown",
    ]),
  })
  .strict()
  .readonly();
const AppendedMessageSchema = z
  .object({
    messageId: ResponseIdentifierSchema,
    sequence: VertexResearchChatOrdinalSchema,
    threadRevision: VertexResearchChatOrdinalSchema,
  })
  .strict()
  .refine(
    (value) => {
      try {
        return BigInt(value.threadRevision) === BigInt(value.sequence) + 1n;
      } catch {
        return false;
      }
    },
    {
      message:
        "Appended thread revision must be the exact bounded sequence plus one",
    }
  )
  .readonly();
const DeliverySchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("not-applicable") }).strict(),
    z.object({ status: z.literal("pending") }).strict(),
    z.object({ status: z.literal("eligible") }).strict(),
    z
      .object({
        reasonCodes: UnavailableReasonsSchema,
        status: z.literal("unavailable"),
      })
      .strict(),
    z
      .object({ message: AppendedMessageSchema, status: z.literal("appended") })
      .strict(),
  ])
  .readonly();

// Actual job state comes from the persisted owned worker join, never AgentRun
// queued state or an internal model-use lease. An appended reference describes
// historical existence only; read the current transcript for body visibility.
// No copied context/proposal/response text or private worker output is retained.
export const VertexResearchChatReadResponseOutputSchema =
  CanonicalDataSchema.pipe(
    z
      .object({
        ...record,
        checkedAt: TimestampSchema,
        delivery: DeliverySchema,
        job: JobSchema.nullable(),
        receipt: ReceiptShapeSchema,
      })
      .strict()
      .refine(
        (value) => {
          try {
            if (
              timestampToEpochNanoseconds(value.checkedAt) <
              timestampToEpochNanoseconds(value.receipt.recordedAt)
            )
              return false;
            if (value.receipt.status === "unavailable")
              return (
                value.job === null && value.delivery.status === "not-applicable"
              );
            if (value.delivery.status === "not-applicable") return false;
            if (value.delivery.status === "pending")
              return (
                value.job === null ||
                value.job.state === "leased" ||
                value.job.state === "running"
              );
            if (value.delivery.status === "eligible")
              return value.job?.state === "succeeded";
            if (value.delivery.status === "appended") {
              return (
                value.job?.state === "succeeded" &&
                BigInt(value.delivery.message.sequence) >=
                  BigInt(value.receipt.snapshotRevision)
              );
            }
            return true;
          } catch {
            return false;
          }
        },
        {
          message:
            "Observation must preserve receipt chronology and actual job/delivery relationships",
        }
      )
      .readonly()
  ).transform(deepFreezeArtifact);

export type VertexResearchChatResponseReasonCode = z.infer<
  typeof VertexResearchChatResponseReasonCodeSchema
>;
export type VertexResearchChatRequestResponseInput = z.infer<
  typeof VertexResearchChatRequestResponseInputSchema
>;
export type VertexResearchChatReadResponseInput = z.infer<
  typeof VertexResearchChatReadResponseInputSchema
>;
export type VertexResearchChatResponseReceipt = z.infer<
  typeof VertexResearchChatResponseReceiptSchema
>;
export type VertexResearchChatRequestResponseOutput = z.infer<
  typeof VertexResearchChatRequestResponseOutputSchema
>;
export type VertexResearchChatReadResponseOutput = z.infer<
  typeof VertexResearchChatReadResponseOutputSchema
>;
