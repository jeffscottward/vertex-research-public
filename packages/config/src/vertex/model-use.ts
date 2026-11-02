import {
  PolicyRegistryError,
  type PolicyPrincipal,
  type PolicyScope,
} from "./ports.ts";

// Internal structural ports, NOT a public validator or a replacement storage ACL.
export type ModelUseIdentity = PolicyScope &
  Readonly<{
    researchPrincipalId: string;
    consumerServiceId: string;
    selectionId: string;
    selectionSha256: string;
    providerId: string;
    modelVersion: string;
    tokenizerArtifactId: string;
    tokenizerSha256: string;
    endpointReferenceId: string;
    endpointSha256: string;
    modelUsePolicyVersion: string;
  }>;
export type ModelUseOperation = "model-tokenize" | "model-completion";
export type ModelUseEvidence = Readonly<{
  artifactId: string;
  artifactSha256: string;
  reviewId: string;
  reviewVersion: string;
  rightsPolicyId: string;
  rightsVersion: string;
}>;
export type ModelUseGrantRecord = ModelUseIdentity &
  Readonly<{
    schemaVersion: string;
    grantId: string;
    grantVersion: string;
    revision: string;
    operations: readonly ModelUseOperation[];
    purposes: readonly string[];
    allowedTools: readonly string[];
    evidence: readonly ModelUseEvidence[];
    maximumInputBytes: number;
    maximumInputTokens: number;
    maximumOutputTokens: number;
    maximumCostUsd: string;
    privacyPolicyId: string;
    privacyPolicyVersion: string;
    validFrom: string;
    expiresAt: string;
    status: "granted" | "revoked";
    issuedByActorId: string;
    issuedAt: string;
    modelProcessingOnly: true;
    executionAuthorized: false;
  }>;
export type ModelUseRequestRecord = ModelUseIdentity &
  Readonly<{
    schemaVersion: string;
    requestId: string;
    requestSha256: string;
    jobId: string;
    leaseId: string;
    leaseEpoch: string;
    grantId: string;
    grantVersion: string;
    operation: ModelUseOperation;
    purpose: string;
    tools: readonly string[];
    evidence: readonly ModelUseEvidence[];
    inputSha256: string;
    inputBytes: number;
    inputTokens: number | null;
    maximumOutputTokens: number;
    maximumCostUsd: string;
    deadlineAt: string;
  }>;
export type ModelUseProofRecord = ModelUseIdentity &
  Readonly<{
    schemaVersion: string;
    requestId: string;
    requestSha256: string;
    jobId: string;
    leaseId: string;
    leaseEpoch: string;
    grantId: string;
    grantVersion: string;
    grantRevision: string | null;
    operation: ModelUseOperation;
    decision: "allowed" | "denied";
    reasonCodes: readonly string[];
    checkedAt: string;
    validUntil: string;
    currentEvidenceSha256: string;
    privacyPolicyId: string | null;
    privacyPolicyVersion: string | null;
    externalDispatchAllowed: boolean;
    modelProcessingOnly: true;
    executionAuthorized: false;
  }>;
export interface ModelUseRecords {
  ModelUseGrant: ModelUseGrantRecord;
  ModelUseRequest: ModelUseRequestRecord;
  ModelUseProof: ModelUseProofRecord;
}
export type ModelUseBoundary = Readonly<{
  validate: <K extends keyof ModelUseRecords>(
    name: K,
    value: unknown
  ) => Promise<ModelUseRecords[K]>;
  encode: (value: unknown) => Uint8Array;
  digest: (bytes: Uint8Array) => Promise<string>;
  epochNanoseconds: (timestamp: string) => bigint;
  decimalUnits: (value: string) => bigint;
}>;
// These facts come ONLY from configured transaction-bound server adapters.
// Each fact retains exact identity/hash/time; there is no caller "authorized" flag.
export type ModelBudgetAdmission = Readonly<{
  policyId: string;
  policyVersion: string;
  policyArtifactId: string;
  policyArtifactSha256: string;
  periodId: string;
  startsAt: string;
  expiresAt: string;
  maximumTokens: number;
  maximumCostUsd: string;
  jobMaximumTokens: number;
  jobMaximumCostUsd: string;
  chargeProfile: "approved-grant-ceiling-v1";
  unknownOutcome: "retain-charge";
}>;
export type ModelBudgetReservation = Readonly<{
  reservationId: string;
  requestSha256: string;
  operation: ModelUseOperation;
  inputBytes: number;
  inputTokens: number | null;
  maximumOutputTokens: number;
  maximumCostUsd: string;
  expiresAt: string;
}>;
export type CurrentModelUseContext = Readonly<{
  authenticatedActorId: string;
  lease: Readonly<{
    jobId: string;
    leaseId: string;
    leaseEpoch: string;
    researchPrincipalId: string;
    consumerServiceId: string;
    accountAlias: string;
    environment: "research" | "paper";
    selectionId: string;
    selectionSha256: string;
    state: "leased";
    expiresAt: string;
    deadlineAt: string;
  }>;
  selection: ModelUseIdentity & Readonly<{ expiresAt: string }>;
  evidence: readonly (ModelUseEvidence &
    Readonly<{
      reviewDecision: "accepted";
      originalArtifactSha256: string;
      readGrantVersion: string;
      reviewedAt: string;
      reviewExpiresAt: string;
      rightsStatus: "granted";
      rightsExpiresAt: string;
    }>)[];
  budgetAdmission: ModelBudgetAdmission;
  // Only the DB store populates this after atomic aggregate reservation.
  budget?: ModelBudgetReservation;
  privacy: Readonly<{
    policyId: string;
    policyVersion: string;
    requestSha256: string;
    allowedOperation: ModelUseOperation;
    expiresAt: string;
  }>;
}>;
export type ModelUseGrantMutation = Readonly<{
  principal: PolicyPrincipal;
  grant: unknown;
  expectedRevision: string | null;
  commandId: string;
}>;
export type ModelUsePrivilegeRequest = Readonly<{
  principal: PolicyPrincipal;
  operation: "issue-model-use" | "revoke-model-use";
  grant: ModelUseGrantRecord;
  expectedRevision: string | null;
  commandId: string;
  requestSha256: string;
  now: string;
}>;
export type ModelUseRepository = Readonly<{
  issueGrant: (
    input: ModelUseGrantMutation
  ) => Promise<"recorded" | "duplicate">;
  revokeGrant: (
    input: ModelUseGrantMutation
  ) => Promise<"recorded" | "duplicate">;
  currentModelUse: (
    principal: PolicyPrincipal,
    request: unknown
  ) => Promise<ModelUseProofRecord>;
}>;
export const modelUseIdentity = (
  value: ModelUseIdentity
): ModelUseIdentity => ({
  accountAlias: value.accountAlias,
  environment: value.environment,
  researchPrincipalId: value.researchPrincipalId,
  consumerServiceId: value.consumerServiceId,
  selectionId: value.selectionId,
  selectionSha256: value.selectionSha256,
  providerId: value.providerId,
  modelVersion: value.modelVersion,
  tokenizerArtifactId: value.tokenizerArtifactId,
  tokenizerSha256: value.tokenizerSha256,
  endpointReferenceId: value.endpointReferenceId,
  endpointSha256: value.endpointSha256,
  modelUsePolicyVersion: value.modelUsePolicyVersion,
});
export const modelUseHash = async (
  boundary: ModelUseBoundary,
  value: unknown
): Promise<string> => {
  const bytes = boundary.encode(value);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 262_144)
    throw new PolicyRegistryError("invalid");
  const hash = await boundary.digest(new Uint8Array(bytes));
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new PolicyRegistryError("integrity");
  return hash;
};
export const evaluateCurrentModelUse = async (
  boundary: ModelUseBoundary,
  principal: PolicyPrincipal,
  request: ModelUseRequestRecord,
  grant: ModelUseGrantRecord | null,
  current: CurrentModelUseContext | null,
  checkedAt: string
): Promise<ModelUseProofRecord> => {
  const at = boundary.epochNanoseconds(checkedAt);
  let reason = "current-model-use-context-unavailable";
  let validUntil = checkedAt;
  const identityMatches = async (value: ModelUseIdentity): Promise<boolean> =>
    (await modelUseHash(boundary, modelUseIdentity(value))) ===
    (await modelUseHash(boundary, modelUseIdentity(request)));
  const future = (value: string): boolean =>
    boundary.epochNanoseconds(value) > at;
  const evidenceHash = await modelUseHash(boundary, request.evidence);
  if (!grant) {
    reason = "model-use-grant-unavailable";
  } else if (
    grant.status !== "granted" ||
    grant.grantId !== request.grantId ||
    grant.grantVersion !== request.grantVersion
  ) {
    reason = "model-use-grant-not-current";
  } else if (!(await identityMatches(grant))) {
    reason = "model-use-grant-identity-mismatch";
  } else if (
    boundary.epochNanoseconds(grant.validFrom) > at ||
    !future(grant.expiresAt) ||
    !future(request.deadlineAt)
  ) {
    reason = "model-use-grant-expired";
  } else if (
    !(
      grant.operations.includes(request.operation) &&
      grant.purposes.includes(request.purpose)
    ) ||
    request.tools.some((tool) => !grant.allowedTools.includes(tool))
  ) {
    reason = "model-use-purpose-tool-denied";
  } else if (
    request.inputBytes > grant.maximumInputBytes ||
    (request.inputTokens !== null &&
      request.inputTokens > grant.maximumInputTokens) ||
    request.maximumOutputTokens > grant.maximumOutputTokens ||
    boundary.decimalUnits(request.maximumCostUsd) >
      boundary.decimalUnits(grant.maximumCostUsd)
  ) {
    reason = "model-use-budget-exceeded";
  } else if (current && !current.budget) {
    reason = "model-use-budget-not-reserved";
  } else if (current?.budget) {
    const lease = current.lease;
    const deadlines = [
      grant.expiresAt,
      request.deadlineAt,
      lease.expiresAt,
      lease.deadlineAt,
      current.selection.expiresAt,
      current.budget.expiresAt,
      current.privacy.expiresAt,
    ];
    let evidenceCurrent = current.evidence.length === request.evidence.length;
    for (const evidence of request.evidence) {
      const allowed = grant.evidence.find(
        (entry) => entry.artifactId === evidence.artifactId
      );
      const observed = current.evidence.find(
        (entry) => entry.artifactId === evidence.artifactId
      );
      if (
        !(allowed && observed) ||
        (await modelUseHash(boundary, allowed)) !==
          (await modelUseHash(boundary, evidence))
      ) {
        evidenceCurrent = false;
        continue;
      }
      const observedRef: ModelUseEvidence = {
        artifactId: observed.artifactId,
        artifactSha256: observed.artifactSha256,
        reviewId: observed.reviewId,
        reviewVersion: observed.reviewVersion,
        rightsPolicyId: observed.rightsPolicyId,
        rightsVersion: observed.rightsVersion,
      };
      if (
        (await modelUseHash(boundary, observedRef)) !==
          (await modelUseHash(boundary, evidence)) ||
        observed.originalArtifactSha256 !== evidence.artifactSha256 ||
        observed.reviewDecision !== "accepted" ||
        observed.rightsStatus !== "granted" ||
        !observed.readGrantVersion ||
        boundary.epochNanoseconds(observed.reviewedAt) > at
      )
        evidenceCurrent = false;
      deadlines.push(observed.reviewExpiresAt, observed.rightsExpiresAt);
    }
    if (
      current.authenticatedActorId !== principal.actorId ||
      lease.state !== "leased" ||
      lease.jobId !== request.jobId ||
      lease.leaseId !== request.leaseId ||
      lease.leaseEpoch !== request.leaseEpoch ||
      lease.researchPrincipalId !== request.researchPrincipalId ||
      lease.consumerServiceId !== request.consumerServiceId ||
      lease.accountAlias !== request.accountAlias ||
      lease.environment !== request.environment ||
      lease.selectionId !== request.selectionId ||
      lease.selectionSha256 !== request.selectionSha256
    ) {
      reason = "model-use-lease-mismatch";
    } else if (!(await identityMatches(current.selection))) {
      reason = "selected-model-tokenizer-endpoint-mismatch";
    } else if (!evidenceCurrent) {
      reason = "current-read-review-rights-mismatch";
    } else if (
      current.budget.requestSha256 !== request.requestSha256 ||
      current.budget.operation !== request.operation ||
      current.budget.inputBytes !== request.inputBytes ||
      current.budget.inputTokens !== request.inputTokens ||
      current.budget.maximumOutputTokens !== request.maximumOutputTokens ||
      current.budget.maximumCostUsd !== request.maximumCostUsd ||
      !current.budget.reservationId
    ) {
      reason = "model-use-budget-not-reserved";
    } else if (
      current.privacy.requestSha256 !== request.requestSha256 ||
      current.privacy.policyId !== grant.privacyPolicyId ||
      current.privacy.policyVersion !== grant.privacyPolicyVersion ||
      current.privacy.allowedOperation !== request.operation
    ) {
      reason = "model-use-privacy-mismatch";
    } else if (deadlines.some((deadline) => !future(deadline))) {
      reason = "model-use-current-facts-expired";
    } else {
      reason = "exact-current-model-use-authorized";
      validUntil = deadlines.reduce((left, right) =>
        boundary.epochNanoseconds(left) <= boundary.epochNanoseconds(right)
          ? left
          : right
      );
    }
  }
  const allowed = reason === "exact-current-model-use-authorized";
  return boundary.validate("ModelUseProof", {
    schemaVersion: "1.0.0",
    ...modelUseIdentity(request),
    requestId: request.requestId,
    requestSha256: request.requestSha256,
    jobId: request.jobId,
    leaseId: request.leaseId,
    leaseEpoch: request.leaseEpoch,
    grantId: request.grantId,
    grantVersion: request.grantVersion,
    grantRevision: grant?.revision ?? null,
    operation: request.operation,
    decision: allowed ? "allowed" : "denied",
    reasonCodes: [reason],
    checkedAt,
    validUntil,
    currentEvidenceSha256: evidenceHash,
    privacyPolicyId: allowed && grant ? grant.privacyPolicyId : null,
    privacyPolicyVersion: allowed && grant ? grant.privacyPolicyVersion : null,
    externalDispatchAllowed: false,
    modelProcessingOnly: true,
    executionAuthorized: false,
  });
};
