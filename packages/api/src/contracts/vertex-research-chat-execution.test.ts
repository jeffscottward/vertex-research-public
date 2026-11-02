import { describe, expect, it } from "vitest";
import {
  VertexResearchChatApproveInputSchema,
  VertexResearchChatPlanInputSchema,
  VertexResearchChatPlanV1Schema,
  VertexResearchChatInputPolicyV1Schema,
  VertexResearchChatStorageReviewInputSchema,
  VertexResearchChatStorageEvidenceV1Schema,
} from "./vertex-research-chat-execution.ts";

const sha = "a".repeat(64);
const request = {
  accountAlias: "fixture",
  environment: "research",
  threadId: "chat-fixture",
  parentMessageId: "message-fixture",
  participantId: "jan-smolen",
  snapshotRevision: "2",
  contextStartSequence: "1",
  retrievalQuery: "SYNTHETIC literal query",
  idempotencyKey: "fixture-response",
};
const evidence = {
  artifactId: "storage-report",
  artifactSha256: sha,
  contractName: "ResearchChatStorageEvidence",
  schemaVersion: "1.0.0",
};
const inputPolicy = {
  modelPolicySha256: sha,
  modelPolicy: { ...evidence, artifactId: "synthetic-model-policy" },
  endpointPolicySha256: { "model-tokenize": sha, "model-completion": sha },
  modelDescriptorSha256: sha,
  modelDescriptor: { ...evidence, artifactId: "synthetic-descriptor" },
};
const descriptivePlan = () => {
  const { retrievalQuery: omittedQuery, ...origin } = request;
  return {
    ...origin,
    schemaVersion: "1.0.0",
    format: "vertex-research-chat-plan-v1",
    ownerActorId: "synthetic-owner",
    responseRequestId: "synthetic-response",
    requestSha256: sha,
    planId: "synthetic-plan",
    planSha256: sha,
    plannedAt: "2026-09-25T00:00:00Z",
    expiresAt: "2026-09-26T00:00:00Z",
    participantConfiguration: evidence,
    collectionId: "synthetic-collection",
    snapshotId: "synthetic-snapshot",
    reviewPins: [
      {
        collectionId: "synthetic-collection",
        evidenceId: "synthetic-evidence",
        artifactId: "synthetic-evidence-artifact",
        artifactSha256: sha,
        reviewId: "synthetic-review",
        reviewVersion: "1.0.0",
        rightsPolicyId: "synthetic-rights",
        rightsVersion: "1.0.0",
      },
    ],
    selectionId: "synthetic-selection",
    selectionSha256: sha,
    retentionArtifact: evidence,
    retentionSha256: sha,
    storageEvidence: evidence,
    capabilityReferenceId: "synthetic-capability",
    backendDeploymentId: "synthetic-backend",
    storageProfileSha256: sha,
    provider: {
      providerId: "synthetic-provider",
      modelVersion: "synthetic-model",
      servedModel: "synthetic-model",
      tokenizerArtifact: evidence,
      tokenizeEndpoint: evidence,
      completionEndpoint: evidence,
      maximumInputTokens: 1000,
      maximumOutputTokens: 100,
      maximumCostUsd: "1",
    },
    inputPolicy,
    context: { sha256: sha, byteLength: 1 },
    tokenizeInput: { sha256: sha, byteLength: 1 },
    completionInput: { sha256: sha, byteLength: 1 },
    runId: "synthetic-run",
    traceId: "synthetic-trace",
    taskContract: "synthetic-task",
    advisoryMaximumBytes: 1000,
    executionAuthorized: false,
  };
};
describe("private one-expert governance contracts", () => {
  it("requires full immutable policy binding on a descriptive plan, not caller-supplied authority", () => {
    const plan = descriptivePlan();
    expect(VertexResearchChatPlanV1Schema.parse(plan)).toEqual(plan);
    const { inputPolicy: ignored, ...missing } = plan;
    expect(VertexResearchChatPlanV1Schema.safeParse(missing).success).toBe(
      false
    );
    for (const key of Object.keys(inputPolicy)) {
      const changed: Record<string, unknown> = { ...inputPolicy };
      delete changed[key];
      expect(
        VertexResearchChatPlanV1Schema.safeParse({
          ...plan,
          inputPolicy: changed,
        }).success
      ).toBe(false);
    }
    for (const operation of ["model-tokenize", "model-completion"]) {
      const changed: Record<string, unknown> = {
        ...inputPolicy.endpointPolicySha256,
      };
      delete changed[operation];
      expect(
        VertexResearchChatInputPolicyV1Schema.safeParse({
          ...inputPolicy,
          endpointPolicySha256: changed,
        }).success
      ).toBe(false);
    }
    expect(
      VertexResearchChatInputPolicyV1Schema.safeParse({
        ...inputPolicy,
        authorized: true,
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatInputPolicyV1Schema.safeParse({
        ...inputPolicy,
        modelPolicySha256: "partial-or-boolean",
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatInputPolicyV1Schema.safeParse({
        ...inputPolicy,
        modelDescriptor: {
          ...inputPolicy.modelDescriptor,
          content: "copied text",
        },
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatInputPolicyV1Schema.safeParse({
        ...inputPolicy,
        endpointPolicySha256: {
          ...inputPolicy.endpointPolicySha256,
          "other-operation": sha,
        },
      }).success
    ).toBe(false);
    const parsed = VertexResearchChatPlanV1Schema.parse(plan);
    expect(Object.isFrozen(parsed.inputPolicy)).toBe(true);
    expect(Object.isFrozen(parsed.inputPolicy.modelDescriptor)).toBe(true);
    expect(Object.isFrozen(parsed.inputPolicy.endpointPolicySha256)).toBe(true);
    expect(
      VertexResearchChatPlanInputSchema.safeParse({ ...request, inputPolicy })
        .success
    ).toBe(false);
    expect(
      VertexResearchChatApproveInputSchema.safeParse({
        planId: plan.planId,
        planSha256: sha,
        request,
        inputPolicy,
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatApproveInputSchema.safeParse({
        planId: plan.planId,
        planSha256: sha,
        request: { ...request, inputPolicy },
      }).success
    ).toBe(false);
  });
  it("preserves the exact inert approval echo, without normalizing query bytes", () => {
    const value = {
      planId: "plan-fixture",
      planSha256: sha,
      request: { ...request, retrievalQuery: "  SYNTHETIC literal query  " },
    };
    expect(VertexResearchChatApproveInputSchema.parse(value)).toEqual(value);
    expect(
      VertexResearchChatApproveInputSchema.safeParse({
        ...value,
        authorized: true,
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatApproveInputSchema.safeParse({
        ...value,
        request: { ...request, modelVersion: "injected" },
      }).success
    ).toBe(false);
  });
  it("requires request-specific plan and all fixed copy operations for storage review", () => {
    const value = {
      accountAlias: "fixture",
      environment: "research",
      responseRequestId: "response-fixture",
      planId: "plan-fixture",
      planSha256: sha,
      evidence,
      decision: "accepted",
      allowedCopyOperations: ["create", "inspect", "read", "fence"],
      expiresAt: "2026-09-26T00:00:00Z",
      expectedReviewId: null,
      idempotencyKey: "review-fixture",
    };
    expect(VertexResearchChatStorageReviewInputSchema.parse(value)).toEqual(
      value
    );
    const { planSha256: ignored, ...transferable } = value;
    expect(
      VertexResearchChatStorageReviewInputSchema.safeParse(transferable).success
    ).toBe(false);
    expect(
      VertexResearchChatStorageReviewInputSchema.safeParse({
        ...value,
        allowedCopyOperations: ["create", "read"],
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatStorageReviewInputSchema.safeParse({
        ...value,
        actorId: "claimed-reviewer",
      }).success
    ).toBe(false);
  });
  it("does not accept canary success or an owner boolean as technical evidence", () => {
    return expect(
      VertexResearchChatStorageEvidenceV1Schema.safeParse({
        schemaVersion: "1.0.0",
        qualified: true,
        canaryPassed: true,
      }).success
    ).toBe(false);
  });
  it("rejects accessors before executing them", () => {
    let invoked = false;
    const value = Object.defineProperty({}, "request", {
      enumerable: true,
      get: () => {
        invoked = true;
        return request;
      },
    });
    expect(VertexResearchChatApproveInputSchema.safeParse(value).success).toBe(
      false
    );
    return expect(invoked).toBe(false);
  });
});
