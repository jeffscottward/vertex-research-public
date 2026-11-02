import {
  canonicalArtifactJson,
  decimalUnits,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  ModelUseGrantSchema,
  ModelUseRequestSchema,
  VERTEX_MODEL_USE_CONTRACT_SCHEMAS,
  computeModelUseRequestHash,
  parseModelUseRequest,
} from "./vertex-model-use.ts";
import type {
  ModelUseBoundary,
  ModelUseRecords,
  CurrentModelUseContext,
} from "../../../config/src/vertex/model-use.ts";
import {
  fixtureAt,
  fixtureDigest,
  fixtureExpires,
  fixtureScope,
} from "./vertex-policy.test-support.ts";

export const modelUseBoundary: ModelUseBoundary = {
  validate: async <K extends keyof ModelUseRecords>(
    name: K,
    value: unknown
  ): Promise<ModelUseRecords[K]> => {
    canonicalArtifactJson(value);
    const parsed =
      name === "ModelUseRequest"
        ? await parseModelUseRequest(value)
        : VERTEX_MODEL_USE_CONTRACT_SCHEMAS[name].parse(value);
    return parsed as ModelUseRecords[K];
  },
  encode: (value) => new TextEncoder().encode(canonicalArtifactJson(value)),
  digest: hashArtifact,
  epochNanoseconds: timestampToEpochNanoseconds,
  decimalUnits,
};
export const modelUseFixture = async () => {
  const identity = {
    ...fixtureScope,
    researchPrincipalId: "synthetic-researcher",
    consumerServiceId: "synthetic-host",
    selectionId: "selection-1",
    selectionSha256: fixtureDigest,
    providerId: "synthetic-provider",
    modelVersion: "synthetic-model-v1",
    tokenizerArtifactId: "synthetic-tokenizer",
    tokenizerSha256: fixtureDigest,
    endpointReferenceId: "synthetic-endpoint",
    endpointSha256: fixtureDigest,
    modelUsePolicyVersion: "1.0.0",
  };
  const evidence = [
    {
      artifactId: "synthetic-evidence",
      artifactSha256: fixtureDigest,
      reviewId: "synthetic-review",
      reviewVersion: "1.0.0",
      rightsPolicyId: "synthetic-rights",
      rightsVersion: "2.0.0",
    },
  ];
  const grant = ModelUseGrantSchema.parse({
    schemaVersion: "1.0.0",
    grantId: "synthetic-model-grant",
    grantVersion: "1.0.0",
    revision: "1",
    ...identity,
    operations: ["model-tokenize", "model-completion"],
    purposes: ["research"],
    allowedTools: ["read-evidence"],
    evidence,
    maximumInputBytes: 100,
    maximumInputTokens: 100,
    maximumOutputTokens: 10,
    maximumCostUsd: "1",
    privacyPolicyId: "synthetic-privacy",
    privacyPolicyVersion: "1.0.0",
    validFrom: fixtureAt,
    expiresAt: fixtureExpires,
    status: "granted",
    issuedByActorId: "synthetic-operator",
    issuedAt: fixtureAt,
    modelProcessingOnly: true,
    executionAuthorized: false,
  });
  const raw = ModelUseRequestSchema.parse({
    schemaVersion: "1.0.0",
    requestId: "synthetic-model-request",
    requestSha256: fixtureDigest,
    ...identity,
    jobId: "synthetic-job",
    leaseId: "synthetic-lease",
    leaseEpoch: "1",
    grantId: grant.grantId,
    grantVersion: grant.grantVersion,
    operation: "model-completion",
    purpose: "research",
    tools: ["read-evidence"],
    evidence,
    inputSha256: fixtureDigest,
    inputBytes: 10,
    inputTokens: 3,
    maximumOutputTokens: 2,
    maximumCostUsd: "0.1",
    deadlineAt: fixtureExpires,
  });
  const request = await parseModelUseRequest({
    ...raw,
    requestSha256: await computeModelUseRequestHash(raw),
  });
  const current: CurrentModelUseContext = {
    authenticatedActorId: "synthetic-service-actor",
    lease: {
      ...fixtureScope,
      jobId: request.jobId,
      leaseId: request.leaseId,
      leaseEpoch: request.leaseEpoch,
      researchPrincipalId: identity.researchPrincipalId,
      consumerServiceId: identity.consumerServiceId,
      selectionId: identity.selectionId,
      selectionSha256: identity.selectionSha256,
      state: "leased",
      expiresAt: fixtureExpires,
      deadlineAt: fixtureExpires,
    },
    selection: { ...identity, expiresAt: fixtureExpires },
    evidence: evidence.map((item) => ({
      ...item,
      reviewDecision: "accepted",
      originalArtifactSha256: item.artifactSha256,
      readGrantVersion: "1.0.0",
      reviewedAt: fixtureAt,
      reviewExpiresAt: fixtureExpires,
      rightsStatus: "granted",
      rightsExpiresAt: fixtureExpires,
    })),
    budgetAdmission: {
      policyId: "synthetic-budget",
      policyVersion: "1.0.0",
      policyArtifactId: "synthetic-budget-artifact",
      policyArtifactSha256: fixtureDigest,
      periodId: "synthetic-period",
      startsAt: fixtureAt,
      expiresAt: fixtureExpires,
      maximumTokens: 1000,
      maximumCostUsd: "10",
      jobMaximumTokens: 1000,
      jobMaximumCostUsd: "10",
      chargeProfile: "approved-grant-ceiling-v1",
      unknownOutcome: "retain-charge",
    },
    budget: {
      reservationId: `model-budget:${request.requestSha256}`,
      requestSha256: request.requestSha256,
      operation: request.operation,
      inputBytes: request.inputBytes,
      inputTokens: request.inputTokens,
      maximumOutputTokens: request.maximumOutputTokens,
      maximumCostUsd: request.maximumCostUsd,
      expiresAt: fixtureExpires,
    },
    privacy: {
      policyId: grant.privacyPolicyId,
      policyVersion: grant.privacyPolicyVersion,
      requestSha256: request.requestSha256,
      allowedOperation: request.operation,
      expiresAt: fixtureExpires,
    },
  };
  return {
    grant,
    request,
    current,
    principal: { actorId: "synthetic-service-actor" },
  };
};
