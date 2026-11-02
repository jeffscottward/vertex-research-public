import { z } from "zod";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
} from "@darkfactory/shared/vertex";
import { DigestSchema, IdentifierSchema, TimestampSchema } from "./vertex.ts";

// Metadata-only original acknowledgement. Neither acceptance nor a subsequent
// read establishes physical cleanup, execution permission or literal presence.
const CleanupIdentifierSchema = IdentifierSchema.refine(
  (value) => value.trim() === value,
  { message: "Identifier must consume the complete string" }
);
const CleanupDigestSchema = DigestSchema.refine(
  (value) => value.trim() === value,
  { message: "Digest must consume the complete string" }
);
const CleanupTimestampSchema = TimestampSchema.refine(
  (value) => value.trim() === value,
  { message: "Timestamp must consume the complete string" }
);
const ResponseRequestIdSchema = z
  .string()
  .regex(/^response-[0-9a-f]{64}$/)
  .length(73);
const CleanupRequestIdSchema = z
  .string()
  .regex(/^copy-cleanup-[0-9a-f]{64}$/)
  .length(77);
const CanonicalDataSchema = z.unknown().transform((value, ctx) => {
  try {
    return JSON.parse(canonicalArtifactJson(value)) as unknown;
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Cleanup DTO must be a canonical JSON data graph",
    });
    return z.NEVER;
  }
});
const inputFields = {
  accountAlias: CleanupIdentifierSchema,
  environment: z.literal("research"),
  threadId: CleanupIdentifierSchema,
  responseRequestId: ResponseRequestIdSchema,
  idempotencyKey: CleanupIdentifierSchema,
};
export const VertexResearchChatRequestCopyCleanupInputSchema =
  CanonicalDataSchema.pipe(z.object(inputFields).strict()).transform(
    deepFreezeArtifact
  );
// Read uses the ORIGINAL cleanup request key, never a response request key or a
// fresh retry key. Absence cannot establish that an in-flight request failed.
export const VertexResearchChatReadCopyCleanupInputSchema =
  CanonicalDataSchema.pipe(z.object(inputFields).strict()).transform(
    deepFreezeArtifact
  );
export const VertexResearchChatCopyCleanupReceiptSchema =
  CanonicalDataSchema.pipe(
    z
      .object({
        schemaVersion: z.literal("1.0.0"),
        executionAuthorized: z.literal(false),
        status: z.literal("requested"),
        ...inputFields,
        ownerActorId: CleanupIdentifierSchema,
        cleanupRequestId: CleanupRequestIdSchema,
        requestSha256: CleanupDigestSchema,
        recordedAt: CleanupTimestampSchema,
        targetKinds: z.tuple([
          z.literal("context"),
          z.literal("model-input"),
          z.literal("derived-output"),
        ]),
      })
      .strict()
      .refine(
        (value) =>
          value.cleanupRequestId === `copy-cleanup-${value.requestSha256}`,
        { message: "Cleanup request identity must match its commitment" }
      )
  ).transform(deepFreezeArtifact);
/** @alias Named procedure schema kept distinct for the contract/OpenAPI surface. */
export const VertexResearchChatRequestCopyCleanupOutputSchema =
  VertexResearchChatCopyCleanupReceiptSchema;
/** @alias Named procedure schema kept distinct for the contract/OpenAPI surface. */
export const VertexResearchChatReadCopyCleanupOutputSchema =
  VertexResearchChatCopyCleanupReceiptSchema;

export type VertexResearchChatRequestCopyCleanupInput = z.infer<
  typeof VertexResearchChatRequestCopyCleanupInputSchema
>;
export type VertexResearchChatReadCopyCleanupInput = z.infer<
  typeof VertexResearchChatReadCopyCleanupInputSchema
>;
export type VertexResearchChatCopyCleanupReceipt = z.infer<
  typeof VertexResearchChatCopyCleanupReceiptSchema
>;
