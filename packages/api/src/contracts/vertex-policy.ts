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
  PositiveDecimalSchema,
  SchemaVersionSchema,
  TimestampSchema,
  VersionSchema,
} from "./vertex.ts";

// These are configuration declarations, never credentials, current authority,
// spendable capital, broker connectivity or permission to rearm native risk.
export const PolicyEnvironmentSchema = z.enum(["research", "paper"]);
export const PolicyRevisionSchema = z.string().regex(/^[1-9]\d{0,29}$/);
export const PolicyHeadRevisionSchema = z.string().regex(/^(0|[1-9]\d{0,29})$/);
export const RuntimeCapabilityStateSchema = z.enum([
  "disabled",
  "unknown",
  "incompatible",
  "unavailable",
  "ready",
]);
export const ConfigurationGroupSchema = z.enum([
  "broker-execution",
  "quantvps-transport",
  "options-analytics",
  "fundamentals-news",
  "historical-quant-data",
  "models-agent-tools",
  "storage-queue-audit",
]);
export const PolicyRoleSchema = z.enum([
  "risk",
  "licensing-rights",
  "review",
  "capital",
  "cost",
  "calendar",
  "retention",
  "provider-budget",
  "tool",
]);
const ids = () =>
  z
    .array(IdentifierSchema)
    .max(128)
    .refine((value) => new Set(value).size === value.length, {
      message: "Duplicate identity",
    });
const unique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;
const before = (left: string, right: string): boolean =>
  timestampToEpochNanoseconds(left) < timestampToEpochNanoseconds(right);
const milliseconds = z.number().int().positive().max(86_400_000);
const scope = {
  accountAlias: IdentifierSchema,
  environment: PolicyEnvironmentSchema,
};

export const PolicyArtifactPinSchema = z
  .object({
    artifactId: IdentifierSchema,
    artifactSha256: DigestSchema,
    contractName: IdentifierSchema,
    schemaVersion: SchemaVersionSchema,
  })
  .strict();
export const RuntimeArtifactBindingSchema = z
  .object({
    bindingId: IdentifierSchema,
    role: z.enum([
      "instrument",
      "calendar",
      "quote",
      "greeks",
      "simulation-engine",
      "endpoint",
      "model",
      "tokenizer",
      "fee",
      "settlement",
      "clock",
      "native-capital",
      "provider-config",
      "tool-config",
      "broker-observation",
    ]),
    artifact: PolicyArtifactPinSchema,
  })
  .strict();
export const PolicySourcePinSchema = z
  .object({
    sourceId: IdentifierSchema,
    revision: IdentifierSchema,
    sourceSha256: DigestSchema,
    provenanceArtifact: PolicyArtifactPinSchema,
  })
  .strict();
export const RuntimeModulePinSchema = z
  .object({
    moduleId: IdentifierSchema,
    version: VersionSchema,
    codeSha256: DigestSchema,
    contractSha256: DigestSchema,
    artifact: PolicyArtifactPinSchema,
    enabled: z.boolean(),
    capabilities: ids(),
    requiredComponents: ids().min(1),
  })
  .strict();
export const RuntimePolicyPinSchema = z
  .object({
    role: PolicyRoleSchema,
    policyId: IdentifierSchema,
    version: VersionSchema,
    artifact: PolicyArtifactPinSchema,
  })
  .strict();
export const ScopedConfigurationReferenceSchema = z
  .object({
    referenceId: IdentifierSchema,
    referenceSha256: DigestSchema,
    logicalName: IdentifierSchema,
    kind: z.enum(["secret-reference", "nonsecret-reference"]),
    ownerService: IdentifierSchema,
    ...scope,
    permissions: ids().min(1),
    entitlementPolicyId: IdentifierSchema.nullable(),
    rotationOwner: IdentifierSchema,
    requiredWhen: ids(),
    legacyAliases: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)).max(32),
    verificationState: z.enum([
      "unknown",
      "unavailable",
      "incompatible",
      "verified",
    ]),
    lastVerifiedAt: TimestampSchema.nullable(),
    expiresAt: TimestampSchema,
    // Reference IDs are opaque catalog keys, not secret-manager URLs or values.
    exposure: z.literal("server-only"),
  })
  .strict()
  .refine(
    (value) =>
      value.verificationState !== "verified" || value.lastVerifiedAt !== null,
    { message: "Verified reference needs evidence time" }
  );
export const RuntimeConfigurationGroupSchema = z
  .object({
    group: ConfigurationGroupSchema,
    state: RuntimeCapabilityStateSchema,
    referenceIds: ids(),
    reasonCodes: ids(),
    provenanceSourceIds: ids().min(1),
  })
  .strict();
export const ProviderCapabilityFactSchema = z
  .object({
    capabilityId: IdentifierSchema,
    providerId: IdentifierSchema,
    endpointReferenceId: IdentifierSchema,
    endpointSha256: DigestSchema,
    modelVersion: IdentifierSchema.nullable(),
    operation: IdentifierSchema,
    state: RuntimeCapabilityStateSchema,
    rightsPolicyId: IdentifierSchema,
    rightsPolicyVersion: VersionSchema,
    observedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    evidenceArtifact: PolicyArtifactPinSchema,
  })
  .strict()
  .refine((value) => before(value.observedAt, value.expiresAt), {
    message: "Capability evidence expiry",
  });
export const RuntimeReviewConfigurationSchema = z
  .object({
    policyId: IdentifierSchema,
    version: VersionSchema,
    reviewVersion: VersionSchema,
    ttlMilliseconds: milliseconds,
    requiredComponents: ids().min(1),
  })
  .strict();
export const RuntimeResearchConfigurationSchema = z
  .object({
    moduleId: IdentifierSchema,
    taskContract: IdentifierSchema,
    modelVersion: IdentifierSchema,
    modelCapabilityId: IdentifierSchema,
    tokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    costBudgetUsd: NonnegativeDecimalSchema,
    rightsPolicyId: IdentifierSchema,
    allowedTools: z
      .array(
        z.enum([
          "read-evidence",
          "search-authorized-corpus",
          "propose-strategy",
          "request-backtest",
          "write-research-artifact",
        ])
      )
      .max(5),
    requiredComponents: ids().min(1),
  })
  .strict();
export const RuntimeSimulationConfigurationSchema = z
  .object({
    moduleId: IdentifierSchema,
    simulatorId: IdentifierSchema,
    maximumLoss: PositiveDecimalSchema,
    maximumNotional: PositiveDecimalSchema,
    ttlMilliseconds: milliseconds,
    requiredComponents: ids().min(1),
    capitalAuthority: z.literal("native-owner-only"),
  })
  .strict();

export const RuntimePolicySelectionSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    selectionId: IdentifierSchema,
    selectionSha256: DigestSchema,
    ...scope,
    revision: PolicyRevisionSchema,
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    sourcePins: z.array(PolicySourcePinSchema).min(1).max(128),
    modules: z.array(RuntimeModulePinSchema).max(128),
    policies: z.array(RuntimePolicyPinSchema).min(1).max(128),
    configuration: z.array(RuntimeConfigurationGroupSchema).length(7),
    references: z.array(ScopedConfigurationReferenceSchema).max(256),
    providerCapabilities: z.array(ProviderCapabilityFactSchema).max(256),
    artifacts: z.array(RuntimeArtifactBindingSchema).max(512),
    review: RuntimeReviewConfigurationSchema.nullable(),
    research: RuntimeResearchConfigurationSchema.nullable(),
    simulation: RuntimeSimulationConfigurationSchema.nullable(),
    readOnly: z.literal(true),
    nativeRearmAllowed: z.literal(false),
    cloudCapitalAuthority: z.literal(false),
  })
  .strict()
  .refine(
    (value) => {
      if (!before(value.issuedAt, value.expiresAt)) return false;
      if (
        !(
          unique(value.sourcePins.map((pin) => pin.sourceId)) &&
          unique(value.modules.map((pin) => pin.moduleId)) &&
          unique(value.policies.map((pin) => pin.role)) &&
          unique(value.configuration.map((group) => group.group)) &&
          unique(value.references.map((reference) => reference.referenceId)) &&
          unique(value.providerCapabilities.map((fact) => fact.capabilityId))
        )
      )
        return false;
      if (!unique(value.artifacts.map((binding) => binding.bindingId)))
        return false;
      const sources = new Set(value.sourcePins.map((pin) => pin.sourceId));
      const refs = new Map(
        value.references.map((reference) => [reference.referenceId, reference])
      );
      const modules = new Map(value.modules.map((pin) => [pin.moduleId, pin]));
      const policies = new Map(value.policies.map((pin) => [pin.role, pin]));
      if (
        value.configuration.some(
          (group) =>
            group.referenceIds.some((id) => !refs.has(id)) ||
            group.provenanceSourceIds.some((id) => !sources.has(id))
        )
      )
        return false;
      if (
        value.references.some(
          (reference) =>
            reference.accountAlias !== value.accountAlias ||
            reference.environment !== value.environment ||
            timestampToEpochNanoseconds(reference.expiresAt) <
              timestampToEpochNanoseconds(value.expiresAt)
        )
      )
        return false;
      if (
        value.providerCapabilities.some(
          (fact) =>
            refs.get(fact.endpointReferenceId)?.referenceSha256 !==
              fact.endpointSha256 ||
            fact.rightsPolicyId !==
              policies.get("licensing-rights")?.policyId ||
            fact.rightsPolicyVersion !==
              policies.get("licensing-rights")?.version
        )
      )
        return false;
      if (
        value.review !== null &&
        (policies.get("review")?.policyId !== value.review.policyId ||
          policies.get("review")?.version !== value.review.version)
      )
        return false;
      if (value.research !== null) {
        const fact = value.providerCapabilities.find(
          (candidate) =>
            candidate.capabilityId === value.research?.modelCapabilityId
        );
        if (
          !(modules.has(value.research.moduleId) && fact) ||
          fact.modelVersion !== value.research.modelVersion ||
          value.research.rightsPolicyId !==
            policies.get("licensing-rights")?.policyId ||
          !policies.has("tool") ||
          !policies.has("provider-budget")
        )
          return false;
      }
      if (
        value.simulation !== null &&
        (value.environment !== "paper" ||
          !modules.has(value.simulation.moduleId) ||
          ["risk", "capital", "cost", "calendar"].some(
            (role) => !value.policies.some((pin) => pin.role === role)
          ))
      )
        return false;
      return true;
    },
    {
      message: "Policy selection pins, scope, groups or configuration mismatch",
    }
  )
  .readonly()
  .transform(deepFreezeArtifact);

// The digest covers canonical JSON of EVERY selection field except itself.
// Timestamp strings are never round-tripped through millisecond Date objects.
// biome-ignore lint/suspicious/useAwait: async keeps the promise contract so synchronous validation failures reject instead of throwing.
export const computeRuntimePolicySelectionHash = async (
  input: RuntimePolicySelection
): Promise<string> => {
  canonicalArtifactJson(input);
  const { selectionSha256: _digest, ...body } =
    RuntimePolicySelectionSchema.parse(input);
  return hashArtifact(canonicalArtifactJson(body));
};
export const parseRuntimePolicySelection = async (
  input: unknown
): Promise<RuntimePolicySelection> => {
  canonicalArtifactJson(input);
  const value = RuntimePolicySelectionSchema.parse(input);
  if (
    (await computeRuntimePolicySelectionHash(value)) !== value.selectionSha256
  )
    throw new TypeError("Policy selection digest mismatch");
  return value;
};

export const PolicySelectionLookupSchema = z
  .object({
    ...scope,
    selectionId: IdentifierSchema,
    selectionSha256: DigestSchema,
  })
  .strict();
export const RuntimePolicyHeadSchema = z
  .object({
    ...scope,
    revision: PolicyHeadRevisionSchema,
    selectionId: IdentifierSchema.nullable(),
    selectionSha256: DigestSchema.nullable(),
    state: z.enum(["disabled", "active-read-only", "draining"]),
    updatedAt: TimestampSchema,
  })
  .strict()
  .refine(
    (value) =>
      (value.selectionId === null) === (value.selectionSha256 === null) &&
      (value.state === "disabled" || value.selectionId !== null),
    { message: "Head identity mismatch" }
  )
  .readonly()
  .transform(deepFreezeArtifact);
export const RuntimeOwnershipPinSchema = z
  .object({
    ...scope,
    holderId: IdentifierSchema,
    holderKind: z.enum(["job", "open-position"]),
    ownerServiceId: IdentifierSchema,
    ownerEpoch: PolicyRevisionSchema,
    selectionId: IdentifierSchema,
    selectionSha256: DigestSchema,
    module: RuntimeModulePinSchema,
    pinnedAt: TimestampSchema,
    releasedAt: TimestampSchema.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.releasedAt === null ||
      timestampToEpochNanoseconds(value.releasedAt) >=
        timestampToEpochNanoseconds(value.pinnedAt),
    { message: "Pin release chronology" }
  )
  .readonly()
  .transform(deepFreezeArtifact);
export const RuntimeComponentEvidenceSchema = z
  .object({
    evidenceId: IdentifierSchema,
    componentId: IdentifierSchema,
    ...scope,
    selectionId: IdentifierSchema,
    selectionSha256: DigestSchema,
    state: RuntimeCapabilityStateSchema,
    codeSha256: DigestSchema,
    contractSha256: DigestSchema,
    observedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    reasonCodes: ids(),
  })
  .strict()
  .refine((value) => before(value.observedAt, value.expiresAt), {
    message: "Readiness chronology",
  })
  .readonly()
  .transform(deepFreezeArtifact);

export type RuntimePolicySelection = z.infer<
  typeof RuntimePolicySelectionSchema
>;
export type RuntimeModulePin = z.infer<typeof RuntimeModulePinSchema>;
export type RuntimePolicyHead = z.infer<typeof RuntimePolicyHeadSchema>;
export type RuntimeOwnershipPin = z.infer<typeof RuntimeOwnershipPinSchema>;
export type RuntimeComponentEvidence = z.infer<
  typeof RuntimeComponentEvidenceSchema
>;
export type RuntimeCapabilityState = z.infer<
  typeof RuntimeCapabilityStateSchema
>;
export type PolicySelectionLookup = z.infer<typeof PolicySelectionLookupSchema>;
export type PolicyArtifactPin = z.infer<typeof PolicyArtifactPinSchema>;
export const VERTEX_POLICY_CONTRACT_SCHEMAS = {
  RuntimePolicySelection: RuntimePolicySelectionSchema,
  PolicySelectionLookup: PolicySelectionLookupSchema,
  RuntimePolicyHead: RuntimePolicyHeadSchema,
  RuntimeOwnershipPin: RuntimeOwnershipPinSchema,
  RuntimeComponentEvidence: RuntimeComponentEvidenceSchema,
} as const;
export const VERTEX_POLICY_SEMANTIC_RULES = Object.freeze({
  RuntimePolicySelection:
    "strict-v1; canonical-sha256-excluding-selectionSha256; seven-distinct-groups; unique-source/module/role/reference/capability/binding-ids; exact-scope-reference-pins; endpoint-reference-digest-equality; research-model-and-rights-pins; simulation-paper-only-risk/capital/cost/calendar-pins; never-authority",
  RuntimePolicyHead:
    "paired-null-identity; non-disabled-requires-selection; decimal-string-revision",
  RuntimeOwnershipPin:
    "release-not-before-pin; exact-module-and-selection; no-owner-transfer-on-activation",
  RuntimeComponentEvidence:
    "observedAt-before-expiresAt; trusted-port-origin-required; state-is-not-authorization",
});
