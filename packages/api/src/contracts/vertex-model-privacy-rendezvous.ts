import { z } from "zod";
import {
  deepFreezeArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { DigestSchema, IdentifierSchema, TimestampSchema } from "./vertex.ts";
import {
  ModelUseOperationSchema,
  ModelUseRequestSchema,
} from "./vertex-model-use.ts";

// Opt-in selected artifact, never a request flag or an implicit service grant.
const FirstMatePrivacyRendezvousLimitsSchema = z
  .object({
    maximum_wait_ms: z.number().int().min(1000).max(300_000),
    maximum_status_reads: z.number().int().min(1).max(300),
    poll_interval_ms: z.number().int().min(100).max(10_000),
  })
  .strict()
  .refine((v) => v.poll_interval_ms <= v.maximum_wait_ms)
  .readonly();
export const FirstMatePrivacyRendezvousAdapterSchema = z
  .object({
    profile: z.literal("vertex-first-mate-review-rendezvous-adapter-config-v1"),
    provider_configs: z.array(z.unknown()).max(128),
    admission_limits: z.array(z.unknown()).max(128),
    endpoint_artifact_ids: z.array(IdentifierSchema).max(128),
    calendar_artifact_ids: z.array(IdentifierSchema).max(128),
    model_artifact_id: IdentifierSchema,
    model_policy_artifact_id: IdentifierSchema,
    model_use_artifact_id: IdentifierSchema,
    privacy_review_rendezvous: FirstMatePrivacyRendezvousLimitsSchema,
  })
  .strict();
export const ChatModelPrivacyReviewInputSchema = z
  .object({
    responseRequestId: IdentifierSchema,
    planId: IdentifierSchema,
    planSha256: DigestSchema,
    request: ModelUseRequestSchema,
    decision: z.enum(["accepted", "rejected"]),
    expiresAt: TimestampSchema,
    expectedReviewId: IdentifierSchema.nullable(),
    idempotencyKey: IdentifierSchema,
  })
  .strict()
  .readonly()
  .transform(deepFreezeArtifact);
export const ModelPrivacyCandidateSchema = z
  .object({
    profile: z.literal("vertex-first-mate-model-privacy-candidate-v1"),
    candidateId: IdentifierSchema,
    accountAlias: IdentifierSchema,
    environment: z.literal("research"),
    responseRequestId: IdentifierSchema,
    planId: IdentifierSchema,
    planSha256: DigestSchema,
    request: ModelUseRequestSchema,
    submittedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .refine(
    (v) =>
      v.request.accountAlias === v.accountAlias &&
      v.request.environment === v.environment &&
      timestampToEpochNanoseconds(v.submittedAt) <
        timestampToEpochNanoseconds(v.expiresAt) &&
      timestampToEpochNanoseconds(v.expiresAt) <=
        timestampToEpochNanoseconds(v.request.deadlineAt)
  )
  .readonly()
  .transform(deepFreezeArtifact);
// Metadata observation ONLY. Neither acceptance nor candidate existence reserves
// a budget/dispatch or replaces currentModelUse's two exact authority checks.
export const ModelPrivacyCandidateStatusSchema = z
  .object({
    candidateId: IdentifierSchema,
    requestId: IdentifierSchema,
    requestSha256: DigestSchema,
    status: z.enum(["pending", "accepted", "rejected", "not-observed"]),
    expiresAt: TimestampSchema.nullable(),
  })
  .strict()
  .refine((v) => (v.status === "not-observed") === (v.expiresAt === null))
  .readonly()
  .transform(deepFreezeArtifact);
// Reviewer knows the original response, not the newly measured token count.
export const ReadModelPrivacyReviewRequestInputSchema = z
  .object({
    accountAlias: IdentifierSchema,
    environment: z.literal("research"),
    responseRequestId: IdentifierSchema,
    operation: ModelUseOperationSchema,
  })
  .strict();
export const RecordModelPrivacyReviewInputSchema = z
  .object({
    candidateId: IdentifierSchema,
    review: ChatModelPrivacyReviewInputSchema,
  })
  .strict();
export const ReadModelPrivacyReviewRequestOutputSchema = z
  .object({
    candidate: ModelPrivacyCandidateSchema,
    currentReviewId: IdentifierSchema.nullable(),
  })
  .strict()
  .readonly()
  .transform(deepFreezeArtifact);
export const RecordModelPrivacyReviewOutputSchema = z
  .object({
    candidateId: IdentifierSchema,
    requestSha256: DigestSchema,
    reviewId: IdentifierSchema,
    decision: z.enum(["accepted", "rejected"]),
    expiresAt: TimestampSchema,
  })
  .strict()
  .readonly()
  .transform(deepFreezeArtifact);

// Phase address is external to the unchanged exact ModelUseRequest v1.
export const NativeModelPrivacyPhaseSchema = z
  .object({
    phaseOrdinal: z.union([z.literal(1), z.literal(2)]),
    phaseSha256: DigestSchema,
  })
  .strict()
  .readonly();
const NativeChatModelPrivacyReviewInputSchema = z
  .object({
    responseRequestId: IdentifierSchema,
    planId: IdentifierSchema,
    planSha256: DigestSchema,
    request: ModelUseRequestSchema,
    decision: z.enum(["accepted", "rejected"]),
    expiresAt: TimestampSchema,
    expectedReviewId: IdentifierSchema.nullable(),
    idempotencyKey: IdentifierSchema,
    nativePhase: NativeModelPrivacyPhaseSchema,
  })
  .strict()
  .readonly()
  .transform(deepFreezeArtifact);
export const SelectedChatModelPrivacyReviewInputSchema = z.union([
  ChatModelPrivacyReviewInputSchema,
  NativeChatModelPrivacyReviewInputSchema,
]);
const NativeModelPrivacyCandidateSchema = z
  .object({
    profile: z.literal("vertex-first-mate-native-model-privacy-candidate-v1"),
    candidateId: IdentifierSchema,
    accountAlias: IdentifierSchema,
    environment: z.literal("research"),
    responseRequestId: IdentifierSchema,
    planId: IdentifierSchema,
    planSha256: DigestSchema,
    request: ModelUseRequestSchema,
    submittedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    nativePhase: NativeModelPrivacyPhaseSchema,
  })
  .strict()
  .refine(
    (v) =>
      v.request.accountAlias === v.accountAlias &&
      v.request.environment === v.environment &&
      timestampToEpochNanoseconds(v.submittedAt) <
        timestampToEpochNanoseconds(v.expiresAt) &&
      timestampToEpochNanoseconds(v.expiresAt) <=
        timestampToEpochNanoseconds(v.request.deadlineAt)
  )
  .readonly()
  .transform(deepFreezeArtifact);
export const SelectedModelPrivacyCandidateSchema = z.union([
  ModelPrivacyCandidateSchema,
  NativeModelPrivacyCandidateSchema,
]);
export const ReadNativeModelPrivacyReviewRequestInputSchema =
  ReadModelPrivacyReviewRequestInputSchema.extend({
    nativePhase: NativeModelPrivacyPhaseSchema,
  }).strict();
export const RecordNativeModelPrivacyReviewInputSchema = z
  .object({
    candidateId: IdentifierSchema,
    review: NativeChatModelPrivacyReviewInputSchema,
  })
  .strict();
export const ReadNativeModelPrivacyReviewRequestOutputSchema = z
  .object({
    candidate: NativeModelPrivacyCandidateSchema,
    currentReviewId: IdentifierSchema.nullable(),
  })
  .strict()
  .readonly()
  .transform(deepFreezeArtifact);
