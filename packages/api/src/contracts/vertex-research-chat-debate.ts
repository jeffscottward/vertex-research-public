import { z } from "zod";
import {
  canonicalArtifactJson,
  decimalUnits,
  deepFreezeArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { DigestSchema, IdentifierSchema, TimestampSchema } from "./vertex.ts";
import { PolicyArtifactPinSchema } from "./vertex-policy.ts";
import { VertexResearchChatRequestResponseInputSchema } from "./vertex-research-chat-response.ts";

// Additive SOURCE contracts. Parsing a pin, selection or decision NEVER grants
// source I/O, redisclosure, model dispatch or publication. Those are owner joins.
const id = IdentifierSchema.refine((v) => v.trim() === v);
const sha = DigestSchema.refine((v) => v.trim() === v);
const usd = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{0,17}[1-9])?$/u);
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const exact = <T extends z.ZodType>(shape: T) =>
  z
    .unknown()
    .transform((value, ctx) => {
      try {
        return JSON.parse(canonicalArtifactJson(value)) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Expected canonical data" });
        return z.NEVER;
      }
    })
    .pipe(shape)
    .transform(deepFreezeArtifact);
const participants = z
  .tuple([id, id])
  .refine((v) => v[0] !== v[1] && !v.includes("first-mate"));
const budgets = {
  turnTokens: count,
  turnCostUsd: usd,
  aggregateTokens: count,
  aggregateCostUsd: usd,
};
export const VertexResearchChatDebateConfigurationV1Schema = exact(
  z
    .object({
      profile: z.literal("vertex-research-chat-debate-configuration-v1"),
      accountAlias: id,
      environment: z.literal("research"),
      configurationId: id,
      participantIds: participants,
      synthesizerId: id,
      ...budgets,
      expiresAt: TimestampSchema,
    })
    .strict()
    .refine(
      (v) =>
        v.participantIds.includes(v.synthesizerId) &&
        BigInt(v.aggregateTokens) >= 5n * BigInt(v.turnTokens) &&
        decimalUnits(v.aggregateCostUsd) >= 5n * decimalUnits(v.turnCostUsd)
    )
);

// A source must already have terminal succeeded publication AND all input-fence
// ACKs. Caller values merely select exact originals; the output owner proves them.
export const VertexResearchChatPublishedPredecessorV1Schema = exact(
  z
    .object({
      ordinal: z.number().int().min(1).max(4),
      participantId: id,
      responseRequestId: id,
      planId: id,
      planSha256: sha,
      runId: id,
      copyId: id,
      reservationSha256: sha,
      contentSha256: sha,
      byteLength: z.number().int().min(1).max(262_144),
      publishedAt: TimestampSchema,
    })
    .strict()
);
const predecessors = z
  .array(VertexResearchChatPublishedPredecessorV1Schema)
  .max(4);
const ordered = (v: {
  ordinal: number;
  predecessors: readonly { ordinal: number; responseRequestId: string }[];
}): boolean => {
  return (
    v.predecessors.length === v.ordinal - 1 &&
    v.predecessors.every((p, i) => p.ordinal === i + 1) &&
    new Set(v.predecessors.map((p) => p.responseRequestId)).size ===
      v.predecessors.length
  );
};
export const VertexResearchChatDebateStepV1Schema = exact(
  z
    .object({
      profile: z.literal("vertex-research-chat-debate-step-v1"),
      runKey: id,
      ordinal: z.number().int().min(1).max(5),
      predecessors,
    })
    .strict()
    .refine(ordered)
);
export const VertexResearchChatDebateStepInputSchema = z
  .unknown()
  .transform((raw, ctx) => {
    try {
      const value = JSON.parse(canonicalArtifactJson(raw)) as Record<
        string,
        unknown
      >;
      const { debate, ...request } = value;
      return deepFreezeArtifact({
        ...VertexResearchChatRequestResponseInputSchema.parse(request),
        debate: VertexResearchChatDebateStepV1Schema.parse(debate),
      });
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Invalid stepwise debate request",
      });
      return z.NEVER;
    }
  });
export const VertexResearchChatDebateApproveInputSchema = exact(
  z
    .object({
      planId: id,
      planSha256: sha,
      request: VertexResearchChatDebateStepInputSchema,
    })
    .strict()
);
export const VertexResearchChatDebatePlanV1Schema = exact(
  z
    .object({
      profile: z.literal("vertex-research-chat-debate-plan-v1"),
      debateRunId: id,
      runKey: id,
      ordinal: z.number().int().min(1).max(5),
      kind: z.enum(["statement", "synthesis"]),
      configuration: PolicyArtifactPinSchema,
      participantIds: participants,
      synthesizerId: id,
      humanWindowSha256: sha,
      predecessors,
      ...budgets,
      derivedContext: z
        .object({
          sha256: sha,
          byteLength: z.number().int().min(1).max(500_000),
        })
        .strict(),
    })
    .strict()
    .refine(
      (v) =>
        ordered(v) &&
        v.participantIds.includes(v.synthesizerId) &&
        v.kind === (v.ordinal === 5 ? "synthesis" : "statement") &&
        v.predecessors.every(
          (p, i) => p.participantId === v.participantIds[i % 2]
        ) &&
        BigInt(v.aggregateTokens) >= 5n * BigInt(v.turnTokens) &&
        decimalUnits(v.aggregateCostUsd) >= 5n * decimalUnits(v.turnCostUsd)
    )
);
export const VertexResearchChatDerivedUseReviewInputSchema = exact(
  z
    .object({
      accountAlias: id,
      environment: z.literal("research"),
      responseRequestId: id,
      planId: id,
      planSha256: sha,
      decision: z.enum(["accepted", "rejected"]),
      expectedReviewId: id.nullable(),
      expiresAt: TimestampSchema,
      idempotencyKey: id,
    })
    .strict()
);
export const VertexResearchChatReadDebateRunInputSchema = exact(
  z
    .object({
      accountAlias: id,
      environment: z.literal("research"),
      threadId: id,
      runKey: id,
    })
    .strict()
);
export const VertexResearchChatReadDebateRunOutputSchema = exact(
  z
    .discriminatedUnion("status", [
      z
        .object({
          schemaVersion: z.literal("1.0.0"),
          executionAuthorized: z.literal(false),
          status: z.literal("unavailable"),
          selector: VertexResearchChatReadDebateRunInputSchema,
          checkedAt: TimestampSchema,
        })
        .strict(),
      z
        .object({
          schemaVersion: z.literal("1.0.0"),
          executionAuthorized: z.literal(false),
          status: z.literal("available"),
          selector: VertexResearchChatReadDebateRunInputSchema,
          debateRunId: id,
          participantIds: participants,
          synthesizerId: id,
          configuration: PolicyArtifactPinSchema,
          humanWindowSha256: sha,
          collectionId: id,
          snapshotId: id,
          ...budgets,
          chargedTokens: z.string().regex(/^(0|[1-9][0-9]*)$/u),
          chargedUsdUnits: z.string().regex(/^(0|[1-9][0-9]*)$/u),
          steps: z
            .array(
              z
                .object({
                  ordinal: z.number().int().min(1).max(5),
                  kind: z.enum(["statement", "synthesis"]),
                  participantId: id,
                  responseRequestId: id,
                  idempotencyKey: id,
                  planId: id,
                  planSha256: sha,
                  state: z.enum(["reserved", "spent"]),
                })
                .strict()
            )
            .max(5),
          nextStep: VertexResearchChatDebateStepV1Schema.nullable(),
          complete: z.boolean(),
          checkedAt: TimestampSchema,
          notAfter: TimestampSchema,
        })
        .strict(),
    ])
    .refine((value) => {
      if (value.status === "unavailable") return true;
      try {
        const steps = value.steps;
        const stepCount = BigInt(steps.length);
        if (
          !value.participantIds.includes(value.synthesizerId) ||
          timestampToEpochNanoseconds(value.checkedAt) >=
            timestampToEpochNanoseconds(value.notAfter) ||
          5n * BigInt(value.turnTokens) > BigInt(value.aggregateTokens) ||
          5n * decimalUnits(value.turnCostUsd) >
            decimalUnits(value.aggregateCostUsd) ||
          BigInt(value.chargedTokens) !==
            stepCount * BigInt(value.turnTokens) ||
          BigInt(value.chargedUsdUnits) !==
            stepCount * decimalUnits(value.turnCostUsd)
        )
          return false;
        if (
          steps.some(
            (step, i) =>
              step.ordinal !== i + 1 ||
              step.kind !== (i === 4 ? "synthesis" : "statement") ||
              step.participantId !==
                (i === 4 ? value.synthesizerId : value.participantIds[i % 2])
          )
        )
          return false;
        for (const key of [
          "responseRequestId",
          "idempotencyKey",
          "planId",
        ] as const)
          if (new Set(steps.map((step) => step[key])).size !== steps.length)
            return false;
        if (
          value.complete &&
          (steps.length !== 5 ||
            steps.some((step) => step.state !== "spent") ||
            value.nextStep !== null)
        )
          return false;
        if (value.nextStep) {
          const next = value.nextStep;
          if (
            value.complete ||
            steps.length >= 5 ||
            next.runKey !== value.selector.runKey ||
            next.ordinal !== steps.length + 1 ||
            next.predecessors.length !== steps.length ||
            steps.some((step) => step.state !== "spent")
          )
            return false;
          if (
            next.predecessors.some((pin, i) => {
              const step = steps[i];
              return (
                step === undefined ||
                pin.ordinal !== step.ordinal ||
                pin.participantId !== step.participantId ||
                pin.responseRequestId !== step.responseRequestId ||
                pin.planId !== step.planId ||
                pin.planSha256 !== step.planSha256
              );
            })
          )
            return false;
        }
        return true;
      } catch {
        return false;
      }
    })
);
export type VertexResearchChatDebateApproveInput = z.infer<
  typeof VertexResearchChatDebateApproveInputSchema
>;
export type VertexResearchChatReadDebateRunInput = z.infer<
  typeof VertexResearchChatReadDebateRunInputSchema
>;
export type VertexResearchChatDebateStepInput = z.infer<
  typeof VertexResearchChatDebateStepInputSchema
>;
export type VertexResearchChatDebatePlanV1 = z.infer<
  typeof VertexResearchChatDebatePlanV1Schema
>;
export type VertexResearchChatPublishedPredecessorV1 = z.infer<
  typeof VertexResearchChatPublishedPredecessorV1Schema
>;
export type VertexResearchChatReadDebateRunOutput = z.infer<
  typeof VertexResearchChatReadDebateRunOutputSchema
>;
export type VertexResearchChatDebateStepV1 = z.infer<
  typeof VertexResearchChatDebateStepV1Schema
>;
