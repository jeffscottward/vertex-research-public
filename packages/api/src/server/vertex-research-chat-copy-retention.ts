import { z } from "zod";
import type { ArtifactPin } from "@darkfactory/config/vertex";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
} from "@darkfactory/shared/vertex";
import { VersionSchema } from "../contracts/vertex.ts";

// API-private metadata format, deliberately absent from the public registry.
// Exact selected preferences are not consent, permission to copy/use a model,
// backend qualification, a reusable capability or proof that cleanup occurred.
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}(?![\s\S])/);
const version = VersionSchema.refine((value) => !/\s/.test(value));
const policySchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    format: z.literal("vertex-research-chat-copy-retention-policy-v1"),
    accountAlias: identifier,
    environment: z.literal("research"),
    policyId: identifier,
    policyVersion: version,
    rules: z
      .tuple([
        z
          .object({
            kind: z.literal("context"),
            cleanupTrigger: z.literal("response-attempt-terminal"),
          })
          .strict()
          .readonly(),
        z
          .object({
            kind: z.literal("model-input"),
            cleanupTrigger: z.literal("response-attempt-terminal"),
          })
          .strict()
          .readonly(),
        z
          .object({
            kind: z.literal("derived-output"),
            cleanupTrigger: z.literal("explicit-user-cleanup"),
          })
          .strict()
          .readonly(),
      ])
      .readonly(),
    earlierCleanupTriggers: z
      .tuple([z.literal("revocation"), z.literal("rights-expiry")])
      .readonly(),
  })
  .strict()
  .readonly();

// Explicitly selected bounded native protocol only. The legacy three-rule
// parser remains exact; intermediate model bodies are never final advisories.
const nativePolicySchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    format: z.literal(
      "vertex-research-chat-native-evidence-retention-policy-v1"
    ),
    accountAlias: identifier,
    environment: z.literal("research"),
    policyId: identifier,
    policyVersion: version,
    rules: z
      .tuple([
        z
          .object({
            kind: z.literal("context"),
            cleanupTrigger: z.literal("response-attempt-terminal"),
          })
          .strict()
          .readonly(),
        z
          .object({
            kind: z.literal("model-input"),
            cleanupTrigger: z.literal("response-attempt-terminal"),
          })
          .strict()
          .readonly(),
        z
          .object({
            kind: z.literal("derived-output"),
            cleanupTrigger: z.literal("explicit-user-cleanup"),
          })
          .strict()
          .readonly(),
        z
          .object({
            kind: z.literal("native-intermediate"),
            cleanupTrigger: z.literal("response-attempt-terminal"),
          })
          .strict()
          .readonly(),
      ])
      .readonly(),
    nativeIntermediatePurposes: z
      .tuple([
        z.literal("evidenceBundle"),
        z.literal("phaseOneResponse"),
        z.literal("toolResult"),
        z.literal("phaseTwoTokenizeInput"),
        z.literal("phaseTwoCompletionInput"),
      ])
      .readonly(),
    earlierCleanupTriggers: z
      .tuple([z.literal("revocation"), z.literal("rights-expiry")])
      .readonly(),
  })
  .strict()
  .readonly();
export type VertexResearchChatNativeCopyRetentionPolicy = z.infer<
  typeof nativePolicySchema
>;

export type VertexResearchChatCopyRetentionPolicy = z.infer<
  typeof policySchema
>;
export type VertexResearchChatCopyRetentionLookup = Readonly<{
  accountAlias: string;
  environment: "research";
  selectionId: string;
  selectionSha256: string;
}>;
export type VertexResearchChatCopyRetentionObservation = Readonly<{
  profile: "vertex-research-chat-copy-retention-observation-v1";
  accountAlias: string;
  environment: "research";
  observedByActorId: string;
  consumerServiceId: string;
  selectionId: string;
  selectionSha256: string;
  policy: VertexResearchChatCopyRetentionPolicy;
  artifact: ArtifactPin;
  checkedAt: string;
}>;

export type VertexResearchChatNativeCopyRetentionObservation = Omit<
  VertexResearchChatCopyRetentionObservation,
  "profile" | "policy"
> &
  Readonly<{
    profile: "vertex-research-chat-native-evidence-retention-observation-v1";
    policy: VertexResearchChatNativeCopyRetentionPolicy;
  }>;

export const parseVertexResearchChatNativeCopyRetentionPolicy = (
  input: unknown
): VertexResearchChatNativeCopyRetentionPolicy => {
  const captured = canonicalArtifactJson(input);
  if (input !== null && typeof input === "object") {
    for (const key of [
      "rules",
      "nativeIntermediatePurposes",
      "earlierCleanupTriggers",
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor &&
        "value" in descriptor &&
        Array.isArray(descriptor.value) &&
        Object.getPrototypeOf(descriptor.value) !== Array.prototype
      ) {
        throw new TypeError("Expected plain native retention tuple");
      }
      void 0;
    }
  }
  return deepFreezeArtifact(nativePolicySchema.parse(JSON.parse(captured)));
};

export const parseVertexResearchChatCopyRetentionPolicy = (
  input: unknown
): VertexResearchChatCopyRetentionPolicy => {
  // Capture own data before Zod can touch it. The shared canonical preflight
  // rejects accessors (without executing them), hidden/symbol keys and cycles.
  const captured = canonicalArtifactJson(input);
  if (input !== null && typeof input === "object") {
    // The shared artifact domain permits array subclasses; this fixed private
    // format does not. Inspect descriptors, never evaluate a source property.
    for (const key of ["rules", "earlierCleanupTriggers"]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor &&
        "value" in descriptor &&
        Array.isArray(descriptor.value) &&
        Object.getPrototypeOf(descriptor.value) !== Array.prototype
      ) {
        throw new TypeError("Expected plain retention tuple");
      }
    }
  }
  return deepFreezeArtifact(policySchema.parse(JSON.parse(captured)));
};

// Terminal means a response attempt finishes, fails or cancels, not an SDK
// event. Only application-owned copies are covered; the human transcript is
// unchanged. No age TTL or provider/media/backup/RAM/export erasure is implied.
// checkedAt is an observation time, never a retention clock or approval key.
// Cleanup must still work from durably captured terms after read rights revoke;
// this processing-side reader is not an independent cleanup authority.
