import {
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import { expect } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { lifecycleFixture } from "../../../db/src/server/vertex-research-chat-copy-lifecycle.test-support.ts";
import { chatWorkerFixture } from "./vertex-research-chat-worker-runtime.test-support.ts";
import { extendChatWorkerSql } from "./vertex-research-chat-worker-sql.test-support.ts";
import { createVertexResearchChatExecutionRuntime } from "./vertex-research-chat-execution-runtime.ts";
import { decodeResearchChatAdvisoryOutput } from "./vertex-research-chat-output-parser.ts";
import { VertexResearchChatParticipantConfigurationV1Schema } from "../contracts/vertex-research-chat-execution.ts";
import { VertexResearchChatPrepareResponseInputSchema } from "../contracts/vertex-research-chat-conversation.ts";
import { AgentRunSchema } from "../contracts/vertex.ts";
import {
  WorkerReadArtifactOutputSchema,
  WorkerStageArtifactInputSchema,
  WorkerStageArtifactOutputSchema,
  WorkerPublishAgentInputSchema,
  WorkerResultSchema,
} from "../contracts/vertex-worker.ts";
import type { ModelUseRequest } from "../contracts/vertex-model-use.ts";

// No test module imports: this helper does not register or repeat another suite.
// Only external SQL, object transport, clock and provider responses are doubles.
// No authority result, grant, review, dispatch, publication or fence is minted here.
export const answerText =
  "Synthetic conversation answer — café Δ; not trading advice.";
export const conversationFixture = () =>
  chatWorkerFixture({
    admissionPath: "conversation",
    participantId: "jan-smolen",
  });
export type ConversationFixture = Awaited<
  ReturnType<typeof conversationFixture>
>;
export const prepareFixture = async (participantId = "jan-smolen") => {
  const f = await lifecycleFixture({ participantId }),
    db = extendChatWorkerSql(f);
  const runtime = createVertexResearchChatExecutionRuntime({
    ...f.runtimeOptions,
    db,
    storage: {
      ...f.runtimeOptions.storage,
      capabilities: f.copies.capabilities,
    },
  });
  return {
    ...f,
    db,
    runtime,
    request: VertexResearchChatPrepareResponseInputSchema.parse(f.request),
  };
};
export const readSelector = (f: {
  request: { threadId: string; idempotencyKey: string };
}) => ({
  ...scope,
  threadId: f.request.threadId,
  idempotencyKey: f.request.idempotencyKey,
});
export const base64 = (bytes: Uint8Array): string => {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
};
const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonicalArtifactJson(value));
export const reviewModel = async (
  f: ConversationFixture,
  request: ModelUseRequest,
  decision: "accepted" | "rejected" = "accepted"
) => {
  const original = await f.db.transaction((tx) =>
    f.runtime.workerModel.readModelOriginalForTransaction(
      tx,
      request,
      f.state.at
    )
  );
  return f.privacy.recordResearchChatModelPrivacyReview(
    f.privacyReviewer,
    f.privacyInput(request, { decision, expiresAt: original.expiresAt })
  );
};
export const consumeAndStageAdvisory = async (
  f: ConversationFixture,
  nativeProvider?: (
    input: Readonly<{
      completionInputBytes: Uint8Array;
      request: ModelUseRequest;
    }>
  ) => Promise<
    Readonly<{ responseBytes: Uint8Array; retainedBytes: Uint8Array }>
  >,
  proposals: readonly Record<string, unknown>[] = []
) => {
  const providerCalls: string[] = [];
  await reviewModel(f, f.tokenizeRequest);
  const tokenProof = await f.modelUseRequest(f.tokenizeRequest);
  expect(tokenProof).toMatchObject({
    decision: "allowed",
    externalDispatchAllowed: true,
  });
  if (!tokenProof.externalDispatchAllowed)
    throw new Error("Actual tokenize dispatch required");
  providerCalls.push("model-tokenize");
  const measuredInputTokens = 37; // External provider response fixture, not an admission decision.
  expect(await f.modelUseRequest(f.tokenizeRequest)).toMatchObject({
    decision: "allowed",
    externalDispatchAllowed: false,
  });
  const request = await f.completionRequest(measuredInputTokens);
  const input = WorkerReadArtifactOutputSchema.parse(
    await f.worker.invoke(f.identity, "readArtifact", {
      ...f.fence,
      collectionId: null,
      artifactId: f.recipe.copies.completionInput.copyId,
    })
  );
  const completionInputBytes = Uint8Array.from(
    atob(input.contentBase64),
    (character) => character.charCodeAt(0)
  );
  expect(await hashArtifact(completionInputBytes)).toBe(request.inputSha256);
  await reviewModel(f, request);
  const before = await f.modelUseRequest(request);
  expect(before).toMatchObject({
    decision: "allowed",
    externalDispatchAllowed: true,
  });
  if (!before.externalDispatchAllowed)
    throw new Error("Actual completion dispatch required");
  providerCalls.push("model-completion");
  const configuration =
    VertexResearchChatParticipantConfigurationV1Schema.parse(f.config.value);
  const nativeInput = JSON.parse(
      new TextDecoder().decode(completionInputBytes)
    ),
    evidence = JSON.parse(nativeInput.messages[1].content).data.evidence[0];
  const citation = {
    evidence_id: evidence.evidence_id,
    source_id: evidence.source_id,
    source_snapshot_id: evidence.source_snapshot_id,
    content_hash: evidence.content_hash,
    excerpt_digest: evidence.excerpt_digest,
    quote: String(evidence.excerpt).slice(0, 32),
  };
  const output = {
    claims: [{ text: answerText, kind: "fact", citations: [citation] }],
    proposals,
    execution_authorized: false,
  };
  const native = await nativeProvider?.({ completionInputBytes, request });
  const responseBytes =
    native?.responseBytes ??
    encode({
      model: configuration.provider.servedModel,
      usage: {
        prompt_tokens: measuredInputTokens,
        completion_tokens: 7,
        total_tokens: measuredInputTokens + 7,
      },
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: canonicalArtifactJson({ output, tool_requests: [] }),
          },
        },
      ],
    });
  const after = await f.modelUseRequest(request);
  expect(after).toMatchObject({
    decision: "allowed",
    externalDispatchAllowed: false,
  });
  const decoded = await decodeResearchChatAdvisoryOutput({
    plan: f.plan,
    configuration,
    request,
    responseBytes,
    completionInputBytes,
    modelPolicy: f.modelPolicy.value,
  });
  if (native) expect(base64(decoded.bytes)).toBe(base64(native.retainedBytes));
  const contentSha256 = await hashArtifact(decoded.bytes),
    rights = f.recipe.execution.queuedRun;
  const stage = WorkerStageArtifactInputSchema.parse({
    ...f.fence,
    collectionId: f.plan.collectionId,
    artifactId: f.recipe.copies.advisory.copyId,
    contentBase64: base64(decoded.bytes),
    contentSha256,
    canonicalSha256: contentSha256,
    contentType: "application/json",
    rightsPolicyId: rights.rightsPolicyId,
    rightsVersion: rights.rightsVersion,
    lineageArtifactIds: f.plan.reviewPins.map((pin) => pin.artifactId),
    chatCompletion: {
      request,
      responseBase64: base64(responseBytes),
      proof: after,
    },
  });
  expect(
    WorkerStageArtifactOutputSchema.parse(
      await f.worker.invoke(f.identity, "stageArtifact", stage)
    )
  ).toMatchObject({
    status: "accepted",
    artifact: {
      artifactId: f.recipe.copies.advisory.copyId,
      artifactSha256: contentSha256,
    },
  });
  return {
    providerCalls,
    decoded,
    contentSha256,
    request,
    responseBytes,
    completionInputBytes,
  };
};
export const publishAdvisory = async (
  f: ConversationFixture,
  advisory: Awaited<ReturnType<typeof consumeAndStageAdvisory>>
) => {
  const queued = f
    .table("vertex_records")
    .find(
      (row) => row["artifact_id"] === f.recipe.execution.queuedRun.artifactId
    );
  if (!queued) throw new Error("Actual queued AgentRun is absent");
  const run = AgentRunSchema.parse({
    ...queued["payload"],
    status: "completed",
    outputArtifactIds: [f.recipe.copies.advisory.copyId],
  });
  const contentSha256 = await hashArtifact(run),
    rights = f.recipe.execution.queuedRun;
  const stage = WorkerStageArtifactInputSchema.parse({
    ...f.fence,
    collectionId: f.plan.collectionId,
    artifactId: f.plan.runId,
    contentBase64: base64(encode(run)),
    contentSha256,
    canonicalSha256: contentSha256,
    contentType: "application/json",
    rightsPolicyId: rights.rightsPolicyId,
    rightsVersion: rights.rightsVersion,
    lineageArtifactIds: [],
  });
  const publish = WorkerPublishAgentInputSchema.parse({
    ...f.fence,
    collectionId: f.plan.collectionId,
    artifact: { artifactId: f.plan.runId, artifactSha256: contentSha256 },
    idempotencyKey: `chat-publish-${f.responseRequestId}`,
    run,
    advisoryProfileArtifact: {
      artifactId: f.recipe.copies.advisory.copyId,
      artifactSha256: advisory.contentSha256,
    },
    reviewPins: f.plan.reviewPins,
  });
  expect(
    WorkerStageArtifactOutputSchema.parse(
      await f.worker.invoke(f.identity, "stageArtifact", stage)
    ).artifact
  ).toEqual(publish.artifact);
  expect(
    WorkerResultSchema.parse(
      await f.worker.invoke(f.identity, "publishAgent", publish)
    ).outputArtifactIds
  ).toEqual([f.plan.runId]);
  return publish;
};
export const completeResponse = async (f: ConversationFixture) => {
  const outcomeSha256 = await hashArtifact({
    source: "synthetic-authenticated-worker-outcome",
    responseRequestId: f.responseRequestId,
    outcome: "succeeded",
  });
  return WorkerResultSchema.parse(
    await f.worker.invoke(f.identity, "complete", {
      ...f.fence,
      outcome: "succeeded",
      outcomeSha256,
      outputArtifactIds: [f.plan.runId],
    })
  );
};
export const fenceInputs = async (f: ConversationFixture) => {
  const cleaner = await f.grantCleanup(),
    results = await f.runtime.drainApprovedCopyCleanup(cleaner, f.selector);
  expect(results).toHaveLength(3);
  expect(results.every((result) => result.status === "fenced")).toBe(true);
  return cleaner;
};
export const eligibleResponse = async () => {
  const f = await conversationFixture(),
    advisory = await consumeAndStageAdvisory(f);
  await publishAdvisory(f, advisory);
  await completeResponse(f);
  const cleaner = await fenceInputs(f);
  return { ...f, advisory, cleaner };
};
export const revokeGrant = async (
  f: ConversationFixture,
  resourceId: string,
  actorId = owner.actorId
) => {
  const binding = f
    .table("vertex_grant_bindings")
    .find(
      (row) =>
        row["grantee_actor_id"] === actorId &&
        row["collection_key"] === "" &&
        row["resource_id"] === resourceId
    );
  if (!binding) throw new Error("Actual original grant binding absent");
  const current = f
    .table("vertex_grant_current")
    .find((row) => row["grant_id"] === binding["grant_id"]);
  if (!current) throw new Error("Actual current grant absent");
  return f.authorization.revokeGrant({
    principal: { actorId: "fixture-grant-admin" },
    grantId: binding["grant_id"],
    scope,
    collectionId: null,
    version: "2.0.0",
    expectedVersion: current["current_version"],
  });
};
