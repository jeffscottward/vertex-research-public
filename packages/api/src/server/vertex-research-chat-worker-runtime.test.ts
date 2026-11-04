import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { chatWorkerFixture } from "./vertex-research-chat-worker-runtime.test-support.ts";
import { ResearchChatRecipeSchema } from "./vertex-runtime-recipe-profiles.ts";
import {
  computeModelUseRequestHash,
  ModelUseRequestSchema,
  parseModelUseRequest,
  type ModelUseRequest,
} from "../contracts/vertex-model-use.ts";
import {
  SENTINELS,
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import { AgentRunSchema } from "../contracts/vertex.ts";
import {
  WorkerReadArtifactOutputSchema,
  WorkerStageArtifactInputSchema,
  WorkerPublishAgentInputSchema,
} from "../contracts/vertex-worker.ts";
import { VertexResearchChatReadResponseOutputSchema } from "../contracts/vertex-research-chat-response.ts";
import { scaledTimeout } from "../../../../scripts/lib/test-timeout-scale.ts";

// Source proof with actual original owners, external SQL/R2/object/provider/clock
// doubles only. Selected policy/technical-stage history is explicitly synthetic;
// this is NOT real privacy approval, storage qualification or provider readiness.
const reidentify = async (
  request: ModelUseRequest,
  change: Record<string, unknown>
) => {
  const {
    requestId: oldId,
    requestSha256: oldHash,
    ...body
  } = { ...request, ...change };
  const identified = {
    ...body,
    requestId: `model-use-${await hashArtifact(body)}`,
  };
  const parsed = ModelUseRequestSchema.parse({
    ...identified,
    requestSha256: "0".repeat(64),
  });
  return parseModelUseRequest({
    ...parsed,
    requestSha256: await computeModelUseRequestHash(parsed),
  });
};
// Each case builds the full real-owner chat worker fixture (~10s alone).
describe("actual approved chat copies through private worker/model boundary", {
  timeout: scaledTimeout(120_000),
}, () => {
  it("queues real bodyless AgentRun/outbox, binds actual lease, admits exact run, reads governed original bytes", async () => {
    const f = await chatWorkerFixture();
    expect(f.admitted.status).toBe("admitted");
    expect(f.admitted.jobId).toBeNull();
    expect(f.origin.runId).toBe(f.plan.runId);
    expect(f.origin.eventId).toBe(f.outbox.eventId);
    expect(f.lease.jobId).toBe(f.origin.jobId);
    expect(
      f
        .table("vertex_worker_jobs")
        .find((row) => row["job_id"] === f.lease.jobId)!["state"]
    ).toBe("running");
    expect(ResearchChatRecipeSchema.parse(f.recipe)).toEqual(f.recipe);
    expect(f.recipe.copies.advisory.content).toBeNull();
    const rowsBefore = f.table("vertex_worker_stages").length;
    for (const purpose of [
      "context",
      "tokenizeInput",
      "completionInput",
    ] as const) {
      const reference = f.recipe.copies[purpose];
      const result = WorkerReadArtifactOutputSchema.parse(
        await f.worker.invoke(f.identity, "readArtifact", {
          ...f.fence,
          collectionId: null,
          artifactId: reference.copyId,
        })
      );
      const bytes = Uint8Array.from(atob(result.contentBase64), (char) =>
        char.charCodeAt(0)
      );
      expect(await hashArtifact(bytes)).toBe(reference.sha256);
      expect(bytes.byteLength).toBe(reference.byteLength);
      expect(result.artifact.artifactId).toBe(reference.copyId);
      expect(result.canonicalSha256).toBeNull();
      expect(
        f
          .table("vertex_worker_stages")
          .some((row) => row["artifact_id"] === reference.copyId)
      ).toBe(false);
    }
    expect(f.table("vertex_worker_stages").length).toBe(rowsBefore);
    return expect(
      await f.runtime.admitApprovedResponse(owner, f.approveInput)
    ).toEqual(f.admitted);
  });
  it("keeps plaintext sentinels out of NEW ordinary command/origin/outbox/stage/run objects", async () => {
    const f = await chatWorkerFixture();
    const records = [
      f.admitted,
      f.origin,
      f.recipe,
      f.outbox.payload,
      ...f
        .table("vertex_command_receipts")
        .filter((row) => row["idempotency_key"] === f.responseRequestId),
      ...f
        .table("vertex_worker_stages")
        .filter((row) => row["job_id"] === f.lease.jobId),
    ];
    const text =
      canonicalArtifactJson(records) +
      f.ordinaryWrites
        .map((key) => new TextDecoder().decode(f.objects.get(key)!.body))
        .join("");
    for (const sentinel of Object.values(SENTINELS))
      expect(text).not.toContain(sentinel);
    expect(
      f
        .table("vertex_research_proposals")
        .some((row) => row["artifact_id"] === f.origin.runArtifactId)
    ).toBe(false);
    return expect(f.originalKeys.size).toBeGreaterThan(0);
  });
  it("requires independent exact privacy and existing first durable budgets for each immutable operation", async () => {
    const f = await chatWorkerFixture(),
      provider = { calls: [] as string[] };
    const denied = await f.modelUseRequest(f.tokenizeRequest);
    expect(denied.decision).toBe("denied");
    expect(denied.externalDispatchAllowed).toBe(false);
    await f.privacy.recordResearchChatModelPrivacyReview(
      f.privacyReviewer,
      f.privacyInput(f.tokenizeRequest)
    );
    const first = await f.modelUseRequest(f.tokenizeRequest);
    expect(first.decision).toBe("allowed");
    expect(first.externalDispatchAllowed).toBe(true);
    if (first.externalDispatchAllowed) provider.calls.push("model-tokenize");
    const tokenized = await f.modelUseRequest(f.tokenizeRequest);
    expect(tokenized.decision).toBe("allowed");
    expect(tokenized.externalDispatchAllowed).toBe(false);
    const completion = await f.completionRequest(37);
    await f.privacy.recordResearchChatModelPrivacyReview(
      f.privacyReviewer,
      f.privacyInput(completion)
    );
    const completionProof = await f.modelUseRequest(completion);
    expect(completionProof.decision).toBe("allowed");
    expect(completionProof.externalDispatchAllowed).toBe(true);
    if (completionProof.externalDispatchAllowed)
      provider.calls.push("model-completion");
    // The external double loses its reply AFTER dispatch. The stored original
    // operation/charge stays, exact replay false; no real provider was called.
    expect((await f.modelUseRequest(completion)).externalDispatchAllowed).toBe(
      false
    );
    const changed = await f.completionRequest(38);
    await expect(
      f.privacy.recordResearchChatModelPrivacyReview(
        f.privacyReviewer,
        f.privacyInput(changed, { idempotencyKey: "changed-completion" })
      )
    ).rejects.toThrow();
    const altered = await f
      .modelUseRequest(changed)
      .catch((_error: unknown) => null);
    expect(altered?.externalDispatchAllowed ?? false).toBe(false);
    expect(provider.calls).toEqual(["model-tokenize", "model-completion"]);
    expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(2);
    return expect(f.table("vertex_model_use_budget_reservations")).toHaveLength(
      2
    );
  });
  it("commits original loss during actual model budget admission before outside worker denial", async () => {
    const f = await chatWorkerFixture();
    await f.privacy.recordResearchChatModelPrivacyReview(
      f.privacyReviewer,
      f.privacyInput(f.tokenizeRequest)
    );
    expect(f.lease.deadlineAt).toBe(f.plan.expiresAt);
    let crossed = false,
      providerEffects = 0;
    f.state.afterQuery = (query) => {
      if (
        !crossed &&
        query.sql.includes("insert into vertex_model_use_budget_reservations")
      ) {
        crossed = true;
        return (f.state.at = f.plan.expiresAt);
      }
      return;
    };
    const dispatchIfAuthorized = async () => {
      const proof = await f.modelUseRequest(f.tokenizeRequest);
      if (proof.externalDispatchAllowed) providerEffects += 1;
      return proof;
    };
    await expect(dispatchIfAuthorized()).rejects.toThrow();
    expect(crossed).toBe(true);
    expect(providerEffects).toBe(0);
    // The ORIGINAL lifecycle owner proved loss after the real reservation.
    // The wrapper must commit that loss, not roll it back at lease expiry.
    expect(
      f
        .table("vertex_research_chat_copy_domain_closures")
        .map((row) => row["domain"])
        .sort()
    ).toEqual(["derived", "inputs"]);
    expect(f.table("vertex_model_use_budget_reservations")).toHaveLength(1);
    expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(0);
    return expect(
      f
        .table("vertex_model_use_proof_audits")
        .every((row) => row["payload"].externalDispatchAllowed === false)
    ).toBe(true);
  });
  it("denies swapped origin/run/recipe/copy/fence selectors and cloned service identity", async () => {
    const f = await chatWorkerFixture(),
      reference = f.recipe.copies.tokenizeInput;
    await expect(
      f.worker.invoke(f.identity, "admitRun", {
        ...f.fence,
        runId: "swapped-run",
        requestSha256: f.origin.recipeSha256,
      })
    ).rejects.toThrow();
    await expect(
      f.worker.invoke(f.identity, "admitRun", {
        ...f.fence,
        runId: f.plan.runId,
        requestSha256: f.plan.requestSha256,
      })
    ).rejects.toThrow();
    await expect(
      f.worker.invoke(f.identity, "readArtifact", {
        ...f.fence,
        leaseEpoch: "2",
        collectionId: null,
        artifactId: reference.copyId,
      })
    ).rejects.toThrow();
    await expect(
      f.worker.invoke({ ...f.identity }, "readArtifact", {
        ...f.fence,
        collectionId: null,
        artifactId: reference.copyId,
      })
    ).rejects.toThrow();
    await expect(
      f.worker.invoke(f.identity, "readArtifact", {
        ...f.fence,
        collectionId: "corpus",
        artifactId: reference.copyId,
      })
    ).rejects.toThrow();
    await expect(
      f.worker.invoke(f.identity, "readArtifact", {
        ...f.fence,
        collectionId: null,
        artifactId: "copy-other-origin",
      })
    ).rejects.toThrow();
    return await expect(
      f.runtime.admitApprovedResponse(owner, {
        ...f.approveInput,
        request: { ...f.request, retrievalQuery: "different original request" },
      })
    ).rejects.toThrow();
  });
  it("denies wrong operation endpoint, changed approved bytes/cost/count and mutable recipe projections", async () => {
    const f = await chatWorkerFixture();
    for (const fields of [
      {
        endpointReferenceId: "complete",
        endpointSha256: f.completion.pin.artifactSha256,
      },
      { inputSha256: "a".repeat(64) },
      { inputBytes: f.tokenizeRequest.inputBytes + 1 },
      { maximumCostUsd: "0" },
      { inputTokens: 1 },
    ]) {
      const request = await reidentify(f.tokenizeRequest, fields);
      await expect(
        f.privacy.recordResearchChatModelPrivacyReview(
          f.privacyReviewer,
          f.privacyInput(request)
        )
      ).rejects.toThrow();
      expect(
        (await f.modelUseRequest(request).catch((_error: unknown) => null))
          ?.externalDispatchAllowed ?? false
      ).toBe(false);
    }
    expect(() =>
      ResearchChatRecipeSchema.parse({ ...f.recipe, request: f.request })
    ).toThrow();
    expect(() =>
      ResearchChatRecipeSchema.parse({
        ...f.recipe,
        copies: {
          ...f.recipe.copies,
          advisory: { ...f.recipe.copies.advisory, sha256: "a".repeat(64) },
        },
      })
    ).toThrow();
    expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(0);
    // A caller's forged request is NOT evidence of original authority loss.
    expect(f.table("vertex_research_chat_copy_domain_closures")).toHaveLength(
      0
    );
    return expect(f.table("vertex_model_use_budget_reservations")).toHaveLength(
      0
    );
  });
  it("denies a governed read crossed by original revocation and durably closes its copy family", async () => {
    const f = await chatWorkerFixture(),
      reference = f.recipe.copies.context;
    f.copies.state.afterRead = async () => {
      await f.revokeContext();
    };
    await expect(
      f.worker.invoke(f.identity, "readArtifact", {
        ...f.fence,
        collectionId: null,
        artifactId: reference.copyId,
      })
    ).rejects.toThrow();
    expect(
      f
        .table("vertex_research_chat_copy_domain_closures")
        .map((row) => row["domain"])
        .sort()
    ).toEqual(["derived", "inputs"]);
    return expect(
      f.copies.calls.filter((call) => call.operation === "create")
    ).toHaveLength(3);
  });
  it("fails closed all unsupported output/publication/success paths without ordinary advisory writes", async () => {
    const f = await chatWorkerFixture(),
      before = f.ordinaryWrites.length;
    await expect(
      f.worker.invoke(f.identity, "readArtifact", {
        ...f.fence,
        collectionId: null,
        artifactId: f.recipe.copies.advisory.copyId,
      })
    ).rejects.toThrow();
    const stageAttempt = WorkerStageArtifactInputSchema.parse({
      ...f.fence,
      collectionId: "corpus",
      artifactId: f.recipe.copies.advisory.copyId,
      contentBase64: btoa("private answer"),
      contentSha256: await hashArtifact(
        new TextEncoder().encode("private answer")
      ),
      canonicalSha256: null,
      contentType: "application/json",
      rightsPolicyId: "policy-rights",
      rightsVersion: "1.0.0",
      lineageArtifactIds: [],
    });
    await expect(
      f.worker.invoke(f.identity, "stageArtifact", stageAttempt)
    ).rejects.toThrow();
    const queued = f
      .table("vertex_records")
      .find((row) => row["artifact_id"] === f.origin.runArtifactId)!["payload"];
    const attemptedRun = AgentRunSchema.parse({
      ...queued,
      status: "completed",
      outputArtifactIds: [f.recipe.copies.advisory.copyId],
    });
    const publicationAttempt = WorkerPublishAgentInputSchema.parse({
      ...f.fence,
      collectionId: "corpus",
      artifact: {
        artifactId: "untrusted-terminal-run-attempt",
        artifactSha256: await hashArtifact(attemptedRun),
      },
      idempotencyKey: "untrusted-publication-attempt",
      run: attemptedRun,
      advisoryProfileArtifact: {
        artifactId: f.recipe.copies.advisory.copyId,
        artifactSha256: "a".repeat(64),
      },
      reviewPins: f.plan.reviewPins,
    });
    await expect(
      f.worker.invoke(f.identity, "publishAgent", publicationAttempt)
    ).rejects.toThrow();
    await expect(
      f.worker.invoke(f.identity, "complete", {
        ...f.fence,
        outcome: "succeeded",
        outcomeSha256: "a".repeat(64),
        outputArtifactIds: [],
      })
    ).rejects.toThrow();
    expect(f.ordinaryWrites).toHaveLength(before);
    expect(
      f
        .table("vertex_worker_jobs")
        .find((row) => row["job_id"] === f.lease.jobId)!["state"]
    ).toBe("running");
    expect(f.table("vertex_worker_agent_publications")).toHaveLength(0);
    const response = VertexResearchChatReadResponseOutputSchema.parse(
      await f.store.readResearchChatResponse(
        owner,
        scope,
        f.request.threadId,
        f.request.idempotencyKey
      )
    );
    return expect(response.delivery).toEqual({
      status: "unavailable",
      reasonCodes: ["projection-unavailable"],
    });
  });
});
