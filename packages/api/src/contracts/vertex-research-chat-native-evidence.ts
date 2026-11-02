import { z } from "zod";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
  decimalUnits,
} from "@darkfactory/shared/vertex";
import { IdentifierSchema, DigestSchema } from "./vertex.ts";
import { PolicyArtifactPinSchema } from "./vertex-policy.ts";
import { VertexResearchChatRequestResponseInputSchema } from "./vertex-research-chat-response.ts";

export const RESEARCH_CHAT_NATIVE_EVIDENCE_PROTOCOL =
  "first-mate-read-reviewed-evidence-v1" as const;
export const RESEARCH_CHAT_NATIVE_EVIDENCE_SERIALIZER =
  "agno-1.7.12-openai-1.93.0-native-single-invoke-v1" as const;
export const RESEARCH_CHAT_NATIVE_EVIDENCE_CONSENT =
  "approve-bounded-native-evidence-protocol-v1" as const;
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const money = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{0,17}[1-9])?$/u)
  .refine((value) => value.trim() === value);
const id = IdentifierSchema.refine((value) => value.trim() === value);
const sha = DigestSchema.refine((value) => value.trim() === value);
const canonical = z.unknown().transform((value, ctx) => {
  try {
    return JSON.parse(canonicalArtifactJson(value)) as unknown;
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Expected canonical native protocol data",
    });
    return z.NEVER;
  }
});
const exact = <T extends z.ZodType>(shape: T) =>
  canonical.pipe(shape).transform(deepFreezeArtifact);
const ceiling = (
  phaseOrdinal: 1 | 2,
  operation: "model-tokenize" | "model-completion"
) =>
  z
    .object({
      phaseOrdinal: z.literal(phaseOrdinal),
      operation: z.literal(operation),
      maximumInputTokens: integer,
      maximumOutputTokens:
        operation === "model-tokenize" ? z.literal(0) : integer,
      maximumCostUsd: money,
    })
    .strict();
export const VertexResearchChatNativeEvidenceProtocolSchema = z
  .object({
    profile: z.literal(RESEARCH_CHAT_NATIVE_EVIDENCE_PROTOCOL),
    toolName: z.literal("read_reviewed_evidence"),
    maximumCalls: z.literal(1),
    phaseCount: z.literal(2),
    derivationProfile: z.literal("reviewed-evidence-single-projection-v1"),
    serializerProfile: z.literal(RESEARCH_CHAT_NATIVE_EVIDENCE_SERIALIZER),
    nativeCapability: PolicyArtifactPinSchema,
    operationCeilings: z.tuple([
      ceiling(1, "model-tokenize"),
      ceiling(1, "model-completion"),
      ceiling(2, "model-tokenize"),
      ceiling(2, "model-completion"),
    ]),
    aggregateTokens: integer,
    aggregateCostUsd: money,
    maximumIntermediateBytes: z.literal(262_144),
  })
  .strict()
  .refine((value) => {
    try {
      return (
        value.operationCeilings.reduce(
          (sum, entry) =>
            sum +
            BigInt(entry.maximumInputTokens) +
            BigInt(entry.maximumOutputTokens),
          0n
        ) <= BigInt(value.aggregateTokens) &&
        value.operationCeilings.reduce(
          (sum, entry) => sum + decimalUnits(entry.maximumCostUsd),
          0n
        ) <= decimalUnits(value.aggregateCostUsd)
      );
    } catch {
      return false;
    }
  });
export const VertexResearchChatNativeEvidencePlanProtocolSchema =
  VertexResearchChatNativeEvidenceProtocolSchema.safeExtend({
    bundle: z
      .object({ sha256: sha, byteLength: integer.max(262_144) })
      .strict(),
  });
// The original parser owns every human input constraint. The protocol is removed
// only for that strict parse; it is retained in the new immutable request digest.
export const VertexResearchChatNativeEvidenceRequestSchema = exact(
  z
    .object({
      accountAlias: IdentifierSchema,
      environment: z.literal("research"),
      threadId: IdentifierSchema,
      parentMessageId: IdentifierSchema,
      participantId: z.literal("first-mate"),
      snapshotRevision: z.string(),
      contextStartSequence: z.string(),
      idempotencyKey: IdentifierSchema,
      retrievalQuery: z.string(),
      protocol: z.literal(RESEARCH_CHAT_NATIVE_EVIDENCE_PROTOCOL),
    })
    .strict()
    .superRefine((value, ctx) => {
      const { protocol, ...human } = value;
      const parsed =
        VertexResearchChatRequestResponseInputSchema.safeParse(human);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: "custom",
            message: issue.message,
            path: issue.path,
          });
        }
      }
    })
);
export const VertexResearchChatNativeEvidenceApproveInputSchema = exact(
  z
    .object({
      planId: id,
      planSha256: sha,
      request: VertexResearchChatNativeEvidenceRequestSchema,
      consent: z.literal(RESEARCH_CHAT_NATIVE_EVIDENCE_CONSENT),
    })
    .strict()
);
export type VertexResearchChatNativeEvidenceRequest = z.infer<
  typeof VertexResearchChatNativeEvidenceRequestSchema
>;
export type VertexResearchChatNativeEvidenceProtocol = z.infer<
  typeof VertexResearchChatNativeEvidenceProtocolSchema
>;
export type VertexResearchChatNativeEvidenceApproveInput = z.infer<
  typeof VertexResearchChatNativeEvidenceApproveInputSchema
>;

// Fixed tool dictionary, pinned by the separately selected serving manifest.
export const researchChatNativeEvidenceToolSchema = () => ({
  type: "function",
  function: {
    name: "read_reviewed_evidence",
    description:
      "Read one reviewed evidence projection from the approved immutable bundle.",
    strict: true,
    parameters: {
      type: "object",
      properties: { evidence_id: { type: "string" } },
      required: ["evidence_id"],
      additionalProperties: false,
    },
  },
});
