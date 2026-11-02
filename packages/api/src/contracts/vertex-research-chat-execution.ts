import { z } from "zod";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
} from "@darkfactory/shared/vertex";
import { DigestSchema, IdentifierSchema, TimestampSchema } from "./vertex.ts";
import { VertexResearchChatRequestResponseInputSchema } from "./vertex-research-chat-response.ts";
import { VertexResearchChatOrdinalSchema } from "./vertex-research-chat.ts";
import { WorkerReviewPinSchema } from "./vertex-worker.ts";
import {
  VertexResearchChatDebatePlanV1Schema,
  VertexResearchChatDebateStepInputSchema,
  VertexResearchChatDebateApproveInputSchema,
} from "./vertex-research-chat-debate.ts";
import {
  VertexResearchChatNativeEvidenceProtocolSchema,
  VertexResearchChatNativeEvidencePlanProtocolSchema,
  VertexResearchChatNativeEvidenceRequestSchema,
  VertexResearchChatNativeEvidenceApproveInputSchema,
  RESEARCH_CHAT_NATIVE_EVIDENCE_CONSENT,
} from "./vertex-research-chat-native-evidence.ts";

// Versioned private governance records. Parsing is NEVER authorization. No
// profile here extends AcceptedReview or certifies a deployment by itself.
const id = IdentifierSchema.refine((v) => v.trim() === v);
const sha = DigestSchema.refine((v) => v.trim() === v);
const scope = { accountAlias: id, environment: z.literal("research") };
const pin = z
  .object({
    artifactId: id,
    artifactSha256: sha,
    contractName: id,
    schemaVersion: z.literal("1.0.0"),
  })
  .strict();
const bytes = z
  .object({ sha256: sha, byteLength: z.number().int().min(1).max(1_048_576) })
  .strict();
const canonical = z.unknown().transform((value, ctx) => {
  try {
    return JSON.parse(canonicalArtifactJson(value)) as unknown;
  } catch {
    ctx.addIssue({ code: "custom", message: "Expected canonical data" });
    return z.NEVER;
  }
});
const exact = <T extends z.ZodType>(shape: T) =>
  canonical.pipe(shape).transform(deepFreezeArtifact);
export const VertexResearchChatStorageEvidenceV1Schema = exact(
  z
    .object({
      schemaVersion: z.literal("1.0.0"),
      format: z.literal("vertex-research-chat-storage-evidence-v1"),
      ...scope,
      evidenceId: id,
      issuerActorId: id,
      capabilityReferenceId: id,
      backendDeploymentId: id,
      storageProfileSha256: sha,
      implementationSha256: sha,
      contractSha256: sha,
      observedAt: TimestampSchema,
      expiresAt: TimestampSchema,
      namespace: z.literal("vertex/chat-copy/v1"),
      createSemantics: z.literal("conditional-create-no-overwrite"),
      readSemantics: z.literal("exact-bound-current-bytes-or-fenced"),
      fenceSemantics: z.literal(
        "conditional-permanent-tombstone-no-resurrection"
      ),
      retainedVersions: z.literal(
        "no-application-readable-prior-content-version"
      ),
      durabilityEvidence: z.array(pin).min(1).max(16),
      claimScope: z.literal("application-managed-copy-namespace-only"),
      excludedClaims: z.tuple([
        z.literal("provider"),
        z.literal("backups"),
        z.literal("physical-media"),
        z.literal("RAM"),
        z.literal("exports"),
      ]),
    })
    .strict()
);
const provider = z
  .object({
    providerId: id,
    modelVersion: id,
    servedModel: id,
    tokenizerArtifact: pin,
    tokenizeEndpoint: pin,
    completionEndpoint: pin,
    maximumInputTokens: z.number().int().positive(),
    maximumOutputTokens: z.number().int().positive(),
    maximumCostUsd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/u),
  })
  .strict();
const exactBudgetUsd = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{0,17}[1-9])?$/u);
export const VertexResearchChatInputBudgetsSchema = z
  .object({
    requestTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    attemptTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    requestCostUsd: exactBudgetUsd,
    attemptCostUsd: exactBudgetUsd,
    tokenizeCostUsd: exactBudgetUsd,
    completionCostUsd: exactBudgetUsd,
  })
  .strict();
export const VertexResearchChatExpertConfigurationV1Schema = exact(
  z
    .object({
      schemaVersion: z.literal("1.0.0"),
      format: z.literal("vertex-research-chat-expert-configuration-v1"),
      ...scope,
      participantId: id,
      participantLabel: z.string().min(1).max(160),
      personaText: z.string().min(1).max(4000),
      collectionId: id,
      snapshotId: id,
      taskContract: id,
      provider,
      // Explicit private ModelPolicy is tool-config; role=model stays the descriptor.
      modelPolicy: pin,
      budgets: VertexResearchChatInputBudgetsSchema,
      reviewPins: z.array(WorkerReviewPinSchema).min(1).max(16),
      advisoryMaximumBytes: z.number().int().min(1).max(1_048_576),
      expiresAt: TimestampSchema,
    })
    .strict()
    .refine(
      (value) =>
        value.participantId !== "first-mate" &&
        value.provider.maximumOutputTokens <
          value.provider.maximumInputTokens &&
        new Set(value.reviewPins.map((entry) => entry.evidenceId)).size ===
          value.reviewPins.length &&
        value.reviewPins.every(
          (entry) => entry.collectionId === value.collectionId
        )
    )
);
// Separate immutable role/profile, not an expert alias or tool permission.
export const VertexResearchChatFirstMateConfigurationV1Schema = exact(
  z
    .object({
      schemaVersion: z.literal("1.0.0"),
      format: z.literal("vertex-research-chat-first-mate-configuration-v1"),
      ...scope,
      participantId: z.literal("first-mate"),
      mode: z.literal("single-turn-advisory"),
      participantLabel: z.string().min(1).max(160),
      personaText: z.string().min(1).max(4000),
      collectionId: id,
      snapshotId: id,
      taskContract: id,
      provider,
      modelPolicy: pin,
      budgets: VertexResearchChatInputBudgetsSchema,
      reviewPins: z.array(WorkerReviewPinSchema).min(1).max(16),
      advisoryMaximumBytes: z.number().int().min(1).max(1_048_576),
      expiresAt: TimestampSchema,
    })
    .strict()
    .refine((value) => {
      return (
        value.provider.maximumOutputTokens <
          value.provider.maximumInputTokens &&
        new Set(value.reviewPins.map((entry) => entry.evidenceId)).size ===
          value.reviewPins.length &&
        value.reviewPins.every(
          (entry) => entry.collectionId === value.collectionId
        )
      );
    })
);
export const VertexResearchChatNativeEvidenceConfigurationV1Schema = exact(
  z
    .object({
      schemaVersion: z.literal("1.0.0"),
      format: z.literal(
        "vertex-research-chat-native-evidence-configuration-v1"
      ),
      ...scope,
      participantId: z.literal("first-mate"),
      participantLabel: z.string().min(1).max(160),
      personaText: z.string().min(1).max(4000),
      collectionId: id,
      snapshotId: id,
      taskContract: id,
      provider,
      modelPolicy: pin,
      budgets: VertexResearchChatInputBudgetsSchema,
      reviewPins: z.array(WorkerReviewPinSchema).min(1).max(16),
      nativeEvidence: VertexResearchChatNativeEvidenceProtocolSchema,
      advisoryMaximumBytes: z.number().int().min(1).max(1_048_576),
      expiresAt: TimestampSchema,
    })
    .strict()
    .refine(
      (value) =>
        value.provider.maximumOutputTokens <
          value.provider.maximumInputTokens &&
        new Set(value.reviewPins.map((entry) => entry.evidenceId)).size ===
          value.reviewPins.length &&
        value.reviewPins.every(
          (entry) => entry.collectionId === value.collectionId
        )
    )
);
export const VertexResearchChatParticipantConfigurationV1Schema = z.union([
  VertexResearchChatExpertConfigurationV1Schema,
  VertexResearchChatFirstMateConfigurationV1Schema,
  VertexResearchChatNativeEvidenceConfigurationV1Schema,
]);
export type VertexResearchChatNativeEvidenceConfigurationV1 = z.infer<
  typeof VertexResearchChatNativeEvidenceConfigurationV1Schema
>;
export type VertexResearchChatParticipantConfigurationV1 = z.infer<
  typeof VertexResearchChatParticipantConfigurationV1Schema
>;
const origin = {
  ...scope,
  ownerActorId: id,
  responseRequestId: id,
  threadId: id,
  parentMessageId: id,
  participantId: id,
  snapshotRevision: VertexResearchChatOrdinalSchema,
  contextStartSequence: VertexResearchChatOrdinalSchema,
  idempotencyKey: id,
  requestSha256: sha,
};
// Nonsecret immutable policy bindings, never permission or copied input text.
// Artifact pins identify original bytes; DTO digests identify full strict parses.
export const VertexResearchChatInputPolicyV1Schema = exact(
  z
    .object({
      modelPolicySha256: sha,
      modelPolicy: pin,
      endpointPolicySha256: z
        .object({ "model-tokenize": sha, "model-completion": sha })
        .strict(),
      modelDescriptorSha256: sha,
      modelDescriptor: pin,
    })
    .strict()
);
const planShape = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    format: z.literal("vertex-research-chat-plan-v1"),
    ...origin,
    planId: id,
    planSha256: sha,
    plannedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    participantConfiguration: pin,
    collectionId: id,
    snapshotId: id,
    reviewPins: z.array(WorkerReviewPinSchema).min(1).max(16),
    selectionId: id,
    selectionSha256: sha,
    retentionArtifact: pin,
    retentionSha256: sha,
    storageEvidence: pin,
    capabilityReferenceId: id,
    backendDeploymentId: id,
    storageProfileSha256: sha,
    provider,
    inputPolicy: VertexResearchChatInputPolicyV1Schema,
    context: bytes,
    tokenizeInput: bytes,
    completionInput: bytes,
    runId: id,
    traceId: id,
    taskContract: id,
    // No output digest: reserve the derived allocation; bind actual bytes later.
    advisoryMaximumBytes: z.number().int().min(1).max(1_048_576),
    executionAuthorized: z.literal(false),
  })
  .strict();
export const VertexResearchChatPlanV1Schema = exact(planShape);
export const VertexResearchChatPlanV2Schema = exact(
  planShape
    .extend({
      format: z.literal("vertex-research-chat-plan-v2"),
      debate: VertexResearchChatDebatePlanV1Schema,
    })
    .strict()
);
export const VertexResearchChatNativeEvidencePlanV1Schema = exact(
  planShape
    .extend({
      format: z.literal("vertex-research-chat-native-evidence-plan-v1"),
      participantId: z.literal("first-mate"),
      nativeEvidence: VertexResearchChatNativeEvidencePlanProtocolSchema,
    })
    .strict()
);
export type VertexResearchChatNativeEvidencePlanV1 = z.infer<
  typeof VertexResearchChatNativeEvidencePlanV1Schema
>;
export const VertexResearchChatExecutionPlanSchema = z.union([
  VertexResearchChatPlanV1Schema,
  VertexResearchChatPlanV2Schema,
  VertexResearchChatNativeEvidencePlanV1Schema,
]);
export const VertexResearchChatPlanInputSchema =
  VertexResearchChatRequestResponseInputSchema;
export const VertexResearchChatApproveInputSchema = exact(
  z
    .object({
      planId: id,
      planSha256: sha,
      // Inert original bytes, not authority. Digest comparison precedes query use;
      // original human prefix is reconstructed from persistence, never this echo.
      request: VertexResearchChatRequestResponseInputSchema,
    })
    .strict()
);
export const VertexResearchChatStorageReviewInputSchema = exact(
  z
    .object({
      ...scope,
      responseRequestId: id,
      planId: id,
      planSha256: sha,
      evidence: pin,
      decision: z.enum(["accepted", "rejected"]),
      allowedCopyOperations: z.tuple([
        z.literal("create"),
        z.literal("inspect"),
        z.literal("read"),
        z.literal("fence"),
      ]),
      expiresAt: TimestampSchema,
      expectedReviewId: id.nullable(),
      idempotencyKey: id,
    })
    .strict()
);
const VertexResearchChatStorageReviewV1Schema = exact(
  z
    .object({
      schemaVersion: z.literal("1.0.0"),
      format: z.literal("vertex-research-chat-storage-qualification-review-v1"),
      ...scope,
      responseRequestId: id,
      planId: id,
      planSha256: sha,
      ownerActorId: id,
      reviewId: id,
      requestSha256: sha,
      actorId: id,
      issuerActorId: id,
      evidence: pin,
      decision: z.enum(["accepted", "rejected"]),
      purpose: z.literal("storage-qualification"),
      allowedCopyOperations: z.tuple([
        z.literal("create"),
        z.literal("inspect"),
        z.literal("read"),
        z.literal("fence"),
      ]),
      reviewedAt: TimestampSchema,
      expiresAt: TimestampSchema,
      supersedesReviewId: id.nullable(),
      idempotencyKey: id,
    })
    .strict()
);
const approvalShape = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    format: z.literal("vertex-research-chat-approval-v1"),
    ...origin,
    planId: id,
    planSha256: sha,
    storageReviewId: id,
    storageReviewSha256: sha,
    approvedAt: TimestampSchema,
    executionAuthorized: z.literal(false),
  })
  .strict();
const VertexResearchChatApprovalV1Schema = exact(approvalShape);
const VertexResearchChatApprovalV2Schema = exact(
  approvalShape
    .extend({
      format: z.literal("vertex-research-chat-approval-v2"),
      debateSha256: sha,
    })
    .strict()
);
const VertexResearchChatNativeEvidenceApprovalV1Schema = exact(
  approvalShape
    .extend({
      format: z.literal("vertex-research-chat-native-evidence-approval-v1"),
      participantId: z.literal("first-mate"),
      consent: z.literal(RESEARCH_CHAT_NATIVE_EVIDENCE_CONSENT),
      nativeEvidenceSha256: sha,
    })
    .strict()
);
export const VertexResearchChatExecutionApprovalSchema = z.union([
  VertexResearchChatApprovalV1Schema,
  VertexResearchChatApprovalV2Schema,
  VertexResearchChatNativeEvidenceApprovalV1Schema,
]);
export const VertexResearchChatExecutionRequestSchema = z.union([
  VertexResearchChatPlanInputSchema,
  VertexResearchChatDebateStepInputSchema,
  VertexResearchChatNativeEvidenceRequestSchema,
]);
export const VertexResearchChatExecutionApproveSchema = z.union([
  VertexResearchChatApproveInputSchema,
  VertexResearchChatDebateApproveInputSchema,
  VertexResearchChatNativeEvidenceApproveInputSchema,
]);
export const VertexResearchChatExecutionSelectorSchema = exact(
  z.object({ ...scope, threadId: id, responseRequestId: id }).strict()
);
const VertexResearchChatDeliveryV1Schema = exact(
  z
    .object({
      schemaVersion: z.literal("1.0.0"),
      executionAuthorized: z.literal(false),
      ...scope,
      responseRequestId: id,
      threadId: id,
      planSha256: sha,
      runId: id,
      jobId: id,
      messageId: id,
      sequence: VertexResearchChatOrdinalSchema,
      threadRevision: VertexResearchChatOrdinalSchema,
      projectionSha256: sha,
      recordedAt: TimestampSchema,
    })
    .strict()
    .refine((v) => BigInt(v.threadRevision) === BigInt(v.sequence) + 1n)
);
export const VERTEX_RESEARCH_CHAT_EXECUTION_SCHEMAS = Object.freeze({
  plan: VertexResearchChatExecutionPlanSchema,
  planInput: VertexResearchChatExecutionRequestSchema,
  approveInput: VertexResearchChatExecutionApproveSchema,
  approval: VertexResearchChatExecutionApprovalSchema,
  storageEvidence: VertexResearchChatStorageEvidenceV1Schema,
  configuration: VertexResearchChatParticipantConfigurationV1Schema,
  storageReviewInput: VertexResearchChatStorageReviewInputSchema,
  storageReview: VertexResearchChatStorageReviewV1Schema,
  selector: VertexResearchChatExecutionSelectorSchema,
  delivery: VertexResearchChatDeliveryV1Schema,
});
export type VertexResearchChatExecutionPlan = z.infer<
  typeof VertexResearchChatExecutionPlanSchema
>;
