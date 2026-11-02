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
  NonnegativeDecimalSchema,
  SchemaVersionSchema,
  TimestampSchema,
  VersionSchema,
} from "./vertex.ts";
import {
  PolicyEnvironmentSchema,
  PolicyRevisionSchema,
} from "./vertex-policy.ts";

// Model processing is an independent permission. Storage's four allowedUses
// remain unchanged; read/derive NEVER implicitly authorizes model processing.
export const ModelUseOperationSchema = z.enum([
  "model-tokenize",
  "model-completion",
]);
const ids = () =>
  z
    .array(IdentifierSchema)
    .max(128)
    .refine((values) => new Set(values).size === values.length, {
      message: "Duplicate model-use identity",
    });
const bound = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ordered = (left: string, right: string): boolean =>
  timestampToEpochNanoseconds(left) < timestampToEpochNanoseconds(right);
const scope = {
  accountAlias: IdentifierSchema,
  environment: PolicyEnvironmentSchema,
};
const identity = {
  ...scope,
  researchPrincipalId: IdentifierSchema,
  consumerServiceId: IdentifierSchema,
  selectionId: IdentifierSchema,
  selectionSha256: DigestSchema,
  providerId: IdentifierSchema,
  modelVersion: IdentifierSchema,
  tokenizerArtifactId: IdentifierSchema,
  tokenizerSha256: DigestSchema,
  endpointReferenceId: IdentifierSchema,
  endpointSha256: DigestSchema,
  modelUsePolicyVersion: VersionSchema,
};
export const ModelUseEvidenceReferenceSchema = z
  .object({
    artifactId: IdentifierSchema,
    artifactSha256: DigestSchema,
    reviewId: IdentifierSchema,
    reviewVersion: VersionSchema,
    rightsPolicyId: IdentifierSchema,
    rightsVersion: VersionSchema,
  })
  .strict();
export const ModelUseGrantSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    grantId: IdentifierSchema,
    grantVersion: VersionSchema,
    revision: PolicyRevisionSchema,
    ...identity,
    operations: z
      .array(ModelUseOperationSchema)
      .min(1)
      .max(2)
      .refine((value) => new Set(value).size === value.length, {
        message: "Duplicate model-use operation",
      }),
    purposes: ids().min(1),
    allowedTools: ids(),
    evidence: z.array(ModelUseEvidenceReferenceSchema).max(128),
    maximumInputBytes: bound,
    maximumInputTokens: bound,
    maximumOutputTokens: bound,
    maximumCostUsd: NonnegativeDecimalSchema,
    privacyPolicyId: IdentifierSchema,
    privacyPolicyVersion: VersionSchema,
    validFrom: TimestampSchema,
    expiresAt: TimestampSchema,
    status: z.enum(["granted", "revoked"]),
    issuedByActorId: IdentifierSchema,
    issuedAt: TimestampSchema,
    modelProcessingOnly: z.literal(true),
    executionAuthorized: z.literal(false),
  })
  .strict()
  .refine(
    (value) =>
      ordered(value.validFrom, value.expiresAt) &&
      (value.status === "revoked" ||
        timestampToEpochNanoseconds(value.issuedAt) <=
          timestampToEpochNanoseconds(value.expiresAt)) &&
      new Set(value.evidence.map((entry) => entry.artifactId)).size ===
        value.evidence.length,
    { message: "Grant chronology or duplicate evidence" }
  )
  .readonly()
  .transform(deepFreezeArtifact);
export const ModelUseRequestSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    requestId: IdentifierSchema,
    requestSha256: DigestSchema,
    ...identity,
    jobId: IdentifierSchema,
    leaseId: IdentifierSchema,
    leaseEpoch: PolicyRevisionSchema,
    grantId: IdentifierSchema,
    grantVersion: VersionSchema,
    operation: ModelUseOperationSchema,
    purpose: IdentifierSchema,
    tools: ids(),
    evidence: z.array(ModelUseEvidenceReferenceSchema).max(128),
    inputSha256: DigestSchema,
    inputBytes: bound,
    inputTokens: bound.nullable(),
    maximumOutputTokens: bound,
    maximumCostUsd: NonnegativeDecimalSchema,
    deadlineAt: TimestampSchema,
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.evidence.map((entry) => entry.artifactId)).size ===
        value.evidence.length &&
      (value.operation !== "model-completion" || value.inputTokens !== null) &&
      (value.operation !== "model-tokenize" || value.maximumOutputTokens === 0),
    { message: "Model use requires bounded exact input and unique evidence" }
  )
  .readonly()
  .transform(deepFreezeArtifact);
export const ModelUseProofSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    requestId: IdentifierSchema,
    requestSha256: DigestSchema,
    ...identity,
    jobId: IdentifierSchema,
    leaseId: IdentifierSchema,
    leaseEpoch: PolicyRevisionSchema,
    grantId: IdentifierSchema,
    grantVersion: VersionSchema,
    grantRevision: PolicyRevisionSchema.nullable(),
    operation: ModelUseOperationSchema,
    decision: z.enum(["allowed", "denied"]),
    reasonCodes: ids().min(1),
    checkedAt: TimestampSchema,
    validUntil: TimestampSchema,
    currentEvidenceSha256: DigestSchema,
    privacyPolicyId: IdentifierSchema.nullable(),
    privacyPolicyVersion: VersionSchema.nullable(),
    externalDispatchAllowed: z.boolean(),
    modelProcessingOnly: z.literal(true),
    executionAuthorized: z.literal(false),
  })
  .strict()
  .refine(
    (value) =>
      timestampToEpochNanoseconds(value.checkedAt) <=
        timestampToEpochNanoseconds(value.validUntil) &&
      (!value.externalDispatchAllowed || value.decision === "allowed") &&
      (value.decision !== "allowed" ||
        (value.grantRevision !== null &&
          value.privacyPolicyId !== null &&
          value.privacyPolicyVersion !== null &&
          ordered(value.checkedAt, value.validUntil))),
    {
      message:
        "Allowed proof requires current grant, privacy and future expiry; dispatch requires admission",
    }
  )
  .readonly()
  .transform(deepFreezeArtifact);

// biome-ignore lint/suspicious/useAwait: async keeps the promise contract so synchronous validation failures reject instead of throwing.
export const computeModelUseRequestHash = async (
  input: ModelUseRequest
): Promise<string> => {
  canonicalArtifactJson(input);
  const { requestSha256: _digest, ...body } =
    ModelUseRequestSchema.parse(input);
  return hashArtifact(canonicalArtifactJson(body));
};
export const parseModelUseRequest = async (
  input: unknown
): Promise<ModelUseRequest> => {
  canonicalArtifactJson(input);
  const value = ModelUseRequestSchema.parse(input);
  if ((await computeModelUseRequestHash(value)) !== value.requestSha256)
    throw new TypeError("Model-use request digest mismatch");
  return value;
};
export type ModelUseGrant = z.infer<typeof ModelUseGrantSchema>;
export type ModelUseRequest = z.infer<typeof ModelUseRequestSchema>;
export type ModelUseProof = z.infer<typeof ModelUseProofSchema>;
export const VERTEX_MODEL_USE_CONTRACT_SCHEMAS = {
  ModelUseGrant: ModelUseGrantSchema,
  ModelUseRequest: ModelUseRequestSchema,
  ModelUseProof: ModelUseProofSchema,
} as const;
export const VERTEX_MODEL_USE_SEMANTIC_RULES = Object.freeze({
  ModelUseGrant:
    "independent-model-processing-grant; exact-scope-model-tokenizer-endpoint-selection-pins; unique-operation-purpose-tool-evidence; ordered-validity-window; current-version-and-privileged-issuer-required-at-use; never-storage-or-execution-authority",
  ModelUseRequest:
    "canonical-sha256-excluding-requestSha256; unique-evidence; completion-requires-inputTokens; tokenize-zero-output; exact-worker-fence-input-and-request-budget",
  ModelUseProof:
    "current-request-hash-bound-observation; allowed-requires-current-grant-revision-and-privacy-and-future-expiry; checkedAt-not-after-validUntil; externalDispatchAllowed-only-first-durable-budget-admission; rechecks-never-rearm; authenticated-transport-current-use-only; not-transferable-not-generic-true",
});
