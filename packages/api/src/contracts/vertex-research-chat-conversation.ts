import { z } from "zod";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  DigestSchema,
  IdentifierSchema,
  TimestampSchema,
  VersionSchema,
} from "./vertex.ts";
import { WorkerReviewPinSchema } from "./vertex-worker.ts";
import {
  VertexResearchChatAgentReferenceMessageSchema,
  VertexResearchChatOrdinalSchema,
} from "./vertex-research-chat.ts";
import {
  VertexResearchChatReadResponseInputSchema,
  VertexResearchChatResponseReasonCodeSchema,
  VertexResearchChatResponseReceiptSchema,
} from "./vertex-research-chat-response.ts";
import {
  VertexResearchChatPlanInputSchema,
  VertexResearchChatApproveInputSchema,
  VertexResearchChatExecutionSelectorSchema,
} from "./vertex-research-chat-execution.ts";
import {
  VertexResearchChatDebatePlanV1Schema,
  VertexResearchChatDebateStepInputSchema,
} from "./vertex-research-chat-debate.ts";
import {
  VertexResearchChatNativeEvidenceRequestSchema,
  VertexResearchChatNativeEvidenceApproveInputSchema,
  VertexResearchChatNativeEvidencePlanProtocolSchema,
} from "./vertex-research-chat-native-evidence.ts";

// Public metadata is never permission. These exact data boundaries neither
// reconstruct private source provenance nor establish current read/publish rights.
const id = IdentifierSchema.refine((value) => value.trim() === value);
const sha = DigestSchema.refine((value) => value.trim() === value);
const record = {
  schemaVersion: z.literal("1.0.0"),
  executionAuthorized: z.literal(false),
};
const canonical = z.unknown().transform((value, ctx) => {
  const invalid = "Conversation DTO must be a canonical JSON data graph";
  try {
    return JSON.parse(canonicalArtifactJson(value)) as unknown;
  } catch {
    ctx.addIssue({ code: "custom", message: invalid });
    return z.NEVER;
  }
});
const exact = <T extends z.ZodType>(shape: T) =>
  canonical.pipe(shape).transform(deepFreezeArtifact);
const reasons = z
  .array(VertexResearchChatResponseReasonCodeSchema)
  .min(1)
  .max(32)
  .refine((values) => new Set(values).size === values.length);
const unknownReasons = z.tuple([z.literal("outcome-unknown")]);
const selectorFields = {
  accountAlias: id,
  environment: z.literal("research"),
  threadId: id,
  responseRequestId: id,
};
const ordinal = VertexResearchChatOrdinalSchema;
const bytePin = z
  .object({ sha256: sha, byteLength: z.number().int().min(1).max(1_048_576) })
  .strict();
const before = (start: string, end: string): boolean => {
  const invalid = false;
  try {
    return (
      timestampToEpochNanoseconds(start) < timestampToEpochNanoseconds(end)
    );
  } catch {
    return invalid;
  }
};

// Deliberately the actual existing parsers, not similar reconstructed requests.
export const VertexResearchChatPrepareResponseInputSchema =
  VertexResearchChatPlanInputSchema;
export const VertexResearchChatApproveAndRequestResponseInputSchema =
  VertexResearchChatApproveInputSchema;

const previewContext = z
  .object({
    messageIds: z
      .array(id)
      .min(1)
      .max(16)
      .refine((values) => new Set(values).size === values.length),
    snapshotRevision: ordinal,
    contextStartSequence: ordinal,
    highWaterSequence: ordinal,
    messageCount: z.number().int().min(1).max(16),
    sha256: sha,
    byteLength: z.number().int().min(1).max(65_536),
  })
  .strict()
  .refine(
    (value) => {
      const count = value.messageIds.length;
      try {
        return (
          value.messageCount === count &&
          BigInt(value.snapshotRevision) ===
            BigInt(value.highWaterSequence) + 1n &&
          BigInt(value.snapshotRevision) -
            BigInt(value.contextStartSequence) ===
            BigInt(count)
        );
      } catch {
        return false;
      }
    },
    {
      message:
        "Preview requires exact original contiguous human context metadata",
    }
  );

const artifact = z.object({ artifactId: id, artifactSha256: sha }).strict();
const endpoint = z
  .object({ artifactId: id, artifactSha256: sha, endpointId: id })
  .strict();
const destinationPort = z
  .string()
  .regex(/^(?:|[1-9][0-9]{0,4})$/u)
  .refine(
    (value) =>
      value.trim() === value && (value === "" || Number(value) <= 65_535)
  );
// v1 remains a distinct strict schema; v2 carries an explicit additional preview.
const preview = z
  .object({
    responseRequestId: id,
    planId: id,
    planSha256: sha,
    request: VertexResearchChatPrepareResponseInputSchema,
    context: previewContext,
    expert: z
      .object({ participantId: id, configurationSha256: sha, modelVersion: id })
      .strict(),
    inputs: z
      .object({ tokenizeInput: bytePin, completionInput: bytePin })
      .strict(),
    corpus: z
      .object({
        collectionId: id,
        snapshotId: id,
        reviewPins: z.array(WorkerReviewPinSchema).min(1).max(16),
      })
      .strict()
      .refine(
        (value) =>
          value.reviewPins.every(
            (pin) => pin.collectionId === value.collectionId
          ) &&
          new Set(value.reviewPins.map((pin) => pin.evidenceId)).size ===
            value.reviewPins.length
      ),
    model: z
      .object({
        providerId: id,
        modelVersion: id,
        servedModel: id,
        modelPolicySha256: sha,
        destination: z
          .object({
            scheme: z.literal("https"),
            hostname: z.string().min(1).max(253),
            port: destinationPort,
          })
          .strict(),
        tokenizeEndpoint: endpoint,
        completionEndpoint: endpoint,
      })
      .strict(),
    retention: z
      .object({
        policyId: id,
        policyVersion: VersionSchema.refine((value) => !/\s/u.test(value)),
        artifact,
        rules: z.tuple([
          z
            .object({
              kind: z.literal("context"),
              cleanupTrigger: z.literal("response-attempt-terminal"),
            })
            .strict(),
          z
            .object({
              kind: z.literal("model-input"),
              cleanupTrigger: z.literal("response-attempt-terminal"),
            })
            .strict(),
          z
            .object({
              kind: z.literal("derived-output"),
              cleanupTrigger: z.literal("explicit-user-cleanup"),
            })
            .strict(),
        ]),
        earlierCleanupTriggers: z.tuple([
          z.literal("revocation"),
          z.literal("rights-expiry"),
        ]),
        readNotAfter: TimestampSchema,
        // Original retention policy specifies cleanup triggers, not a deletion SLA.
        guaranteedDeletionDeadline: z.null(),
      })
      .strict(),
    storage: z
      .object({
        storageProfileSha256: sha,
        backendDeploymentId: id,
        evidence: artifact,
        namespace: z.literal("vertex/chat-copy/v1"),
        createSemantics: z.literal("conditional-create-no-overwrite"),
        readSemantics: z.literal("exact-bound-current-bytes-or-fenced"),
        fenceSemantics: z.literal(
          "conditional-permanent-tombstone-no-resurrection"
        ),
        retainedVersions: z.literal(
          "no-application-readable-prior-content-version"
        ),
        claimScope: z.literal("application-managed-copy-namespace-only"),
        excludedClaims: z.tuple([
          z.literal("provider"),
          z.literal("backups"),
          z.literal("physical-media"),
          z.literal("RAM"),
          z.literal("exports"),
        ]),
      })
      .strict(),
    checkedAt: TimestampSchema,
    notAfter: TimestampSchema,
  })
  .strict()
  .refine(
    (value) => {
      const request = value.request,
        context = value.context;
      try {
        return (
          request.snapshotRevision === context.snapshotRevision &&
          request.contextStartSequence === context.contextStartSequence &&
          request.parentMessageId === context.messageIds.at(-1) &&
          request.participantId === value.expert.participantId &&
          value.expert.modelVersion === value.model.modelVersion &&
          before(value.checkedAt, value.notAfter) &&
          timestampToEpochNanoseconds(value.notAfter) <=
            timestampToEpochNanoseconds(value.retention.readNotAfter)
        );
      } catch {
        return false;
      }
    },
    {
      message:
        "Consent preview must preserve exact original request, selected context, expert/model and read limits",
    }
  );
export const VertexResearchChatPrepareResponseOutputSchema = exact(
  z.discriminatedUnion("status", [
    z.object({ ...record, status: z.literal("prepared"), preview }).strict(),
    z
      .object({
        ...record,
        status: z.literal("unavailable"),
        selector: VertexResearchChatReadResponseInputSchema,
        reasonCodes: reasons,
      })
      .strict(),
  ])
);
export type VertexResearchChatPrepareResponseOutput = z.infer<
  typeof VertexResearchChatPrepareResponseOutputSchema
>;
export const VertexResearchChatDebatePrepareOutputSchema = exact(
  z.discriminatedUnion("status", [
    z
      .object({
        ...record,
        status: z.literal("prepared"),
        preview: preview
          .safeExtend({
            request: VertexResearchChatDebateStepInputSchema,
            debate: VertexResearchChatDebatePlanV1Schema,
          })
          .refine((value) => {
            const step = value.request.debate,
              plan = value.debate;
            return (
              step.runKey === plan.runKey &&
              step.ordinal === plan.ordinal &&
              canonicalArtifactJson(step.predecessors) ===
                canonicalArtifactJson(plan.predecessors) &&
              value.request.participantId ===
                (plan.kind === "synthesis"
                  ? plan.synthesizerId
                  : plan.participantIds[(plan.ordinal - 1) % 2]) &&
              !plan.predecessors.some(
                (pin) =>
                  pin.responseRequestId === value.responseRequestId ||
                  pin.planId === value.planId
              )
            );
          }),
      })
      .strict(),
    z
      .object({
        ...record,
        status: z.literal("unavailable"),
        selector: VertexResearchChatReadResponseInputSchema,
        reasonCodes: reasons,
      })
      .strict(),
  ])
);
export type VertexResearchChatDebatePrepareOutput = z.infer<
  typeof VertexResearchChatDebatePrepareOutputSchema
>;
export const VertexResearchChatNativeEvidencePrepareOutputSchema = exact(
  z.discriminatedUnion("status", [
    z
      .object({
        ...record,
        status: z.literal("prepared"),
        preview: z
          .object({
            ...preview.shape,
            request: VertexResearchChatNativeEvidenceRequestSchema,
            nativeEvidence: VertexResearchChatNativeEvidencePlanProtocolSchema,
            retention: preview.shape.retention
              .extend({
                rules: z.tuple([
                  z
                    .object({
                      kind: z.literal("context"),
                      cleanupTrigger: z.literal("response-attempt-terminal"),
                    })
                    .strict(),
                  z
                    .object({
                      kind: z.literal("model-input"),
                      cleanupTrigger: z.literal("response-attempt-terminal"),
                    })
                    .strict(),
                  z
                    .object({
                      kind: z.literal("derived-output"),
                      cleanupTrigger: z.literal("explicit-user-cleanup"),
                    })
                    .strict(),
                  z
                    .object({
                      kind: z.literal("native-intermediate"),
                      cleanupTrigger: z.literal("response-attempt-terminal"),
                    })
                    .strict(),
                ]),
                nativeIntermediatePurposes: z.tuple([
                  z.literal("evidenceBundle"),
                  z.literal("phaseOneResponse"),
                  z.literal("toolResult"),
                  z.literal("phaseTwoTokenizeInput"),
                  z.literal("phaseTwoCompletionInput"),
                ]),
              })
              .strict(),
          })
          .strict()
          .refine((value) => {
            const request = value.request,
              context = value.context;
            try {
              return (
                request.snapshotRevision === context.snapshotRevision &&
                request.contextStartSequence === context.contextStartSequence &&
                request.parentMessageId === context.messageIds.at(-1) &&
                request.participantId === value.expert.participantId &&
                value.expert.modelVersion === value.model.modelVersion &&
                before(value.checkedAt, value.notAfter) &&
                timestampToEpochNanoseconds(value.notAfter) <=
                  timestampToEpochNanoseconds(value.retention.readNotAfter)
              );
            } catch {
              return false;
            }
          }),
      })
      .strict(),
    z
      .object({
        ...record,
        status: z.literal("unavailable"),
        selector: VertexResearchChatReadResponseInputSchema,
        reasonCodes: reasons,
      })
      .strict(),
  ])
);
export type VertexResearchChatNativeEvidencePrepareOutput = z.infer<
  typeof VertexResearchChatNativeEvidencePrepareOutputSchema
>;
export const VertexResearchChatPrepareNativeEvidenceInputSchema =
  VertexResearchChatNativeEvidenceRequestSchema;
export const VertexResearchChatApproveAndRequestNativeEvidenceInputSchema =
  VertexResearchChatNativeEvidenceApproveInputSchema;
export const VertexResearchChatExecutionPrepareOutputSchema = z.union([
  VertexResearchChatPrepareResponseOutputSchema,
  VertexResearchChatDebatePrepareOutputSchema,
  VertexResearchChatNativeEvidencePrepareOutputSchema,
]);

const approveCommon = {
  ...record,
  selector: VertexResearchChatReadResponseInputSchema,
};
export const VertexResearchChatApproveAndRequestResponseOutputSchema = exact(
  z
    .discriminatedUnion("status", [
      z
        .object({
          ...approveCommon,
          status: z.literal("recorded"),
          receipt: VertexResearchChatResponseReceiptSchema,
        })
        .strict(),
      z
        .object({
          ...approveCommon,
          status: z.literal("blocked"),
          reasonCodes: reasons,
        })
        .strict(),
      z
        .object({
          ...approveCommon,
          status: z.literal("unknown"),
          reasonCodes: unknownReasons,
        })
        .strict(),
    ])
    .refine(
      (value) => {
        const selector = value.selector;
        if (value.status !== "recorded") return true;
        const receipt = value.receipt;
        return (
          selector.accountAlias === receipt.accountAlias &&
          selector.environment === receipt.environment &&
          selector.threadId === receipt.threadId &&
          selector.idempotencyKey === receipt.idempotencyKey
        );
      },
      {
        message:
          "Receipt must preserve the exact original scoped response selector",
      }
    )
);
// Blocked is not proof that no previous effect occurred. Unknown is inspect-only
// for this same original key, never a new-key/model retry instruction.
export const VertexResearchChatAppendResponseInputSchema = exact(
  z
    .object({
      ...selectorFields,
      expectedRevision: ordinal,
    })
    .strict()
);
const appendCommon = {
  ...record,
  selector: VertexResearchChatExecutionSelectorSchema,
};
export const VertexResearchChatAppendResponseOutputSchema = exact(
  z
    .discriminatedUnion("status", [
      z
        .object({
          ...appendCommon,
          status: z.literal("appended"),
          message: VertexResearchChatAgentReferenceMessageSchema,
          threadRevision: ordinal,
        })
        .strict(),
      z
        .object({
          ...appendCommon,
          status: z.literal("unavailable"),
          reasonCodes: reasons,
        })
        .strict(),
      z
        .object({
          ...appendCommon,
          status: z.literal("unknown"),
          reasonCodes: unknownReasons,
        })
        .strict(),
    ])
    .refine(
      (value) => {
        const selector = value.selector;
        if (value.status !== "appended") return true;
        try {
          return (
            value.message.threadId === selector.threadId &&
            value.message.response.responseRequestId ===
              selector.responseRequestId &&
            BigInt(value.threadRevision) === BigInt(value.message.sequence) + 1n
          );
        } catch {
          return false;
        }
      },
      {
        message:
          "Append must preserve original reference identity and exact next revision",
      }
    )
);

// Exact accepted native output projection, using Unicode codepoints rather than
// human-context UTF16 limits. Source evidence/quote provenance stays server-owned.
const nativeText = (maximum: number) =>
  z.string().refine(
    (value) => {
      const count = Array.from(value).length;
      return (
        count >= 1 &&
        count <= maximum &&
        !/[\u0000-\u0008\u000b-\u001f\u007f\ud800-\udfff]/u.test(value)
      );
    },
    { message: "Expected bounded native Unicode scalar text" }
  );
const nativeId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u)
  .refine((value) => value.trim() === value);
const nativeSha = z
  .string()
  .regex(/^[0-9a-f]{64}$/u)
  .refine((value) => value.trim() === value);
const nativeInteger = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => !Object.is(value, -0));
const nativeUsd = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{0,17}[1-9])?$/u)
  .refine((value) => value.trim() === value);
const citation = z
  .object({
    evidence_id: nativeId,
    source_id: nativeId,
    source_snapshot_id: nativeId,
    content_hash: nativeSha,
    excerpt_digest: nativeSha,
    quote: nativeText(1000),
  })
  .strict();
const claim = z
  .object({
    text: nativeText(2000),
    kind: z.enum(["fact", "hypothesis", "limitation"]),
    citations: z
      .array(citation)
      .min(1)
      .max(8)
      .refine(
        (values) =>
          new Set(values.map((value) => canonicalArtifactJson(value))).size ===
          values.length
      ),
  })
  .strict();
const proposal = z
  .object({
    proposal_id: nativeId,
    kind: z.enum(["strategy-hypothesis", "backtest-request"]),
    title: nativeText(200),
    rationale: claim,
    execution_authorized: z.literal(false),
  })
  .strict();
const usage = z
  .object({
    inputTokens: nativeInteger,
    outputTokens: nativeInteger,
    totalTokens: nativeInteger,
    completionCostUsd: nativeUsd,
  })
  .strict()
  .refine((value) => {
    const invalid = false;
    try {
      return (
        BigInt(value.totalTokens) ===
        BigInt(value.inputTokens) + BigInt(value.outputTokens)
      );
    } catch {
      return invalid;
    }
  });
const advisoryShape = z
  .object({
    profile: z.literal("vertex-research-chat-advisory-v1"),
    responseRequestId: id,
    planId: id,
    planSha256: sha,
    runId: id,
    traceId: id,
    taskContract: id,
    modelVersion: id,
    modelUseRequestSha256: sha,
    responseSha256: sha,
    usage,
    output: z
      .object({
        claims: z.array(claim).min(1).max(12),
        proposals: z
          .array(proposal)
          .max(8)
          .refine(
            (values) =>
              new Set(values.map((value) => value.proposal_id)).size ===
              values.length
          ),
        execution_authorized: z.literal(false),
      })
      .strict(),
    executionAuthorized: z.literal(false),
  })
  .strict();
export const VertexResearchChatAdvisoryProfileSchema = exact(advisoryShape);
export const VertexResearchChatAdvisoryV2ProfileSchema = exact(
  advisoryShape
    .extend({
      profile: z.literal("vertex-research-chat-advisory-v2"),
      debate: VertexResearchChatDebatePlanV1Schema,
    })
    .strict()
);
export const VertexResearchChatNativeEvidenceAdvisoryProfileSchema = exact(
  advisoryShape
    .extend({
      profile: z.literal("vertex-research-chat-native-evidence-advisory-v1"),
    })
    .strict()
);
export const VertexResearchChatAdvisoryOutputProfileSchema = z.union([
  VertexResearchChatAdvisoryProfileSchema,
  VertexResearchChatAdvisoryV2ProfileSchema,
  VertexResearchChatNativeEvidenceAdvisoryProfileSchema,
]);

export const VertexResearchChatReadResponseContentInputSchema = exact(
  z.object({ ...selectorFields, messageId: id }).strict()
);
const contentCommon = {
  ...record,
  reference: VertexResearchChatAgentReferenceMessageSchema,
  checkedAt: TimestampSchema,
};
export const VertexResearchChatReadResponseContentOutputSchema = exact(
  z
    .discriminatedUnion("status", [
      z
        .object({
          ...contentCommon,
          status: z.literal("available"),
          notAfter: TimestampSchema,
          profile: VertexResearchChatAdvisoryOutputProfileSchema,
          sha256: sha,
          byteLength: z.number().int().min(1).max(262_144),
        })
        .strict(),
      z
        .object({
          ...contentCommon,
          status: z.literal("unavailable"),
          reasonCodes: reasons,
        })
        .strict(),
    ])
    .refine(
      (value) => {
        const reference = value.reference;
        if (value.status !== "available") return true;
        const profile = value.profile,
          response = reference.response;
        return (
          before(value.checkedAt, value.notAfter) &&
          profile.responseRequestId === response.responseRequestId &&
          profile.planId === response.planId &&
          profile.planSha256 === response.planSha256 &&
          profile.runId === reference.author.runId &&
          profile.runId === response.runArtifact.artifactId &&
          profile.traceId === response.traceId &&
          value.sha256 === response.advisoryArtifact.artifactSha256 &&
          new TextEncoder().encode(canonicalArtifactJson(profile))
            .byteLength === value.byteLength
        );
      },
      {
        message:
          "Ephemeral content must preserve the exact reference, canonical byte length and original deadline",
      }
    )
);
// The source owner verifies actual byte hashes/current provenance. Missing
// reference or caller denial is an RPC error, not a fabricated unavailable body.

export type VertexResearchChatPrepareResponseInput = z.infer<
  typeof VertexResearchChatPrepareResponseInputSchema
>;
export type VertexResearchChatApproveAndRequestResponseInput = z.infer<
  typeof VertexResearchChatApproveAndRequestResponseInputSchema
>;
export type VertexResearchChatApproveAndRequestResponseOutput = z.infer<
  typeof VertexResearchChatApproveAndRequestResponseOutputSchema
>;
export type VertexResearchChatAppendResponseInput = z.infer<
  typeof VertexResearchChatAppendResponseInputSchema
>;
export type VertexResearchChatAppendResponseOutput = z.infer<
  typeof VertexResearchChatAppendResponseOutputSchema
>;
export type VertexResearchChatReadResponseContentInput = z.infer<
  typeof VertexResearchChatReadResponseContentInputSchema
>;
export type VertexResearchChatReadResponseContentOutput = z.infer<
  typeof VertexResearchChatReadResponseContentOutputSchema
>;
export type VertexResearchChatAdvisoryProfile = z.infer<
  typeof VertexResearchChatAdvisoryProfileSchema
>;
export type VertexResearchChatAdvisoryOutputProfile = z.infer<
  typeof VertexResearchChatAdvisoryOutputProfileSchema
>;
