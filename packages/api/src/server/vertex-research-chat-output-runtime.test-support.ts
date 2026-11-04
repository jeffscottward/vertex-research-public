import { expect } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import type { chatWorkerFixture } from "./vertex-research-chat-worker-runtime.test-support.ts";
import {
  LATER,
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import { decodeResearchChatAdvisoryOutput } from "./vertex-research-chat-output-parser.ts";
import { VertexResearchChatExpertConfigurationV1Schema } from "../contracts/vertex-research-chat-execution.ts";
import { AgentRunSchema } from "../contracts/vertex.ts";
import {
  WorkerReadArtifactOutputSchema,
  WorkerStageArtifactInputSchema,
  WorkerStageArtifactOutputSchema,
  WorkerPublishAgentInputSchema,
  WorkerResultSchema,
} from "../contracts/vertex-worker.ts";
import type { ModelUseRequest } from "../contracts/vertex-model-use.ts";
import { scaledTimeout } from "../../../../scripts/lib/test-timeout-scale.ts";

// SOURCE ONLY: no executions/results claimed. All positive authority is issued
// by the actual fixture owners. Only SQL/object/R2/provider/clock boundaries are
// synthetic; pre-existing selected technical history remains explicitly so.
// Raw authenticated-worker response bytes are NOT provider attestation. This
// suite does not append chat messages, activate providers or qualify erasure.
export const TIMEOUT = scaledTimeout(120_000);
export const origins = "vertex_research_chat_advisory_origins";
export const effects = "vertex_research_chat_copy_effects";
export const observations = "vertex_research_chat_copy_effect_observations";
export const closures = "vertex_research_chat_copy_domain_closures";
export const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
export const answerText =
  "Synthetic final answer — café Δ; not trading advice.";
export const providerExtra = "PROVIDER_EXTRA_MUST_NOT_BE_RETAINED";
type Fixture = Awaited<ReturnType<typeof chatWorkerFixture>>;
export const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
export const unbase64 = (value: string): Uint8Array => {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
};
export const jsonBytes = (value: unknown): Uint8Array => {
  return encoder.encode(canonicalArtifactJson(value));
};
export const copyCalls = (f: Fixture, operation: string, copyId?: string) => {
  return f.copies.calls.filter(
    (call) =>
      call.operation === operation &&
      (copyId === undefined || call.copyId === copyId)
  );
};
export const inputIds = (f: Fixture): string[] => {
  return [
    f.recipe.copies.context.copyId,
    f.recipe.copies.tokenizeInput.copyId,
    f.recipe.copies.completionInput.copyId,
  ];
};
export const job = (f: Fixture) => {
  return f
    .table("vertex_worker_jobs")
    .find((row) => row["job_id"] === f.lease.jobId)!;
};
export const outputOwner = (f: Fixture) => {
  const result = f.runtime.output;
  if (!result)
    throw new Error("Concrete original output owner is not configured");
  return result;
};
export const reviewModel = async (
  f: Fixture,
  request: ModelUseRequest
): Promise<void> => {
  const original = await f.db.transaction((tx) =>
    f.runtime.workerModel.readModelOriginalForTransaction(
      tx,
      request,
      f.state.at
    )
  );
  await f.privacy.recordResearchChatModelPrivacyReview(
    f.privacyReviewer,
    f.privacyInput(request, { expiresAt: original.expiresAt })
  );
};
const readInput = async (f: Fixture, copyId: string): Promise<Uint8Array> => {
  const result = WorkerReadArtifactOutputSchema.parse(
    await f.worker.invoke(f.identity, "readArtifact", {
      ...f.fence,
      collectionId: null,
      artifactId: copyId,
    })
  );
  const bytes = unbase64(result.contentBase64);
  expect(await hashArtifact(bytes)).toBe(result.contentSha256);
  return bytes;
};

// Pure parity DATA helper for Main: exact approved completion bytes -> native
// response with whitespace/Unicode/ignored extra field. It reads only citation
// strings; it NEVER reserializes lossy JSON.parse epoch integers into input bytes.
const buildSyntheticChatOutputResponse = (
  completionInputBytes: Uint8Array,
  servedModel: string,
  inputTokens: number
) => {
  const body = JSON.parse(decoder.decode(completionInputBytes));
  const envelope = JSON.parse(body.messages[1].content),
    evidence = envelope.data.evidence[0];
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
    proposals: [],
    execution_authorized: false,
  };
  const native = {
    model: servedModel,
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: 7,
      total_tokens: inputTokens + 7,
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
    ignored_provider_field: providerExtra,
  };
  const responseBytes = encoder.encode(
    ` \n${JSON.stringify(native, null, 2)}\n`
  );
  return { native, responseBytes, output };
};
export const consumedCompletion = async (f: Fixture) => {
  const providerCalls: string[] = [];
  await reviewModel(f, f.tokenizeRequest);
  const tokenProof = await f.modelUseRequest(f.tokenizeRequest);
  expect(tokenProof).toMatchObject({
    decision: "allowed",
    externalDispatchAllowed: true,
  });
  if (!tokenProof.externalDispatchAllowed)
    throw new Error("No actual tokenize dispatch admission");
  providerCalls.push("model-tokenize");
  // External provider double supplies a bounded measured count after admission.
  const measuredInputTokens = 37;
  expect(await f.modelUseRequest(f.tokenizeRequest)).toMatchObject({
    decision: "allowed",
    externalDispatchAllowed: false,
  });
  const request = await f.completionRequest(measuredInputTokens);
  const completionInputBytes = await readInput(
    f,
    f.recipe.copies.completionInput.copyId
  );
  expect(await hashArtifact(completionInputBytes)).toBe(request.inputSha256);
  await reviewModel(f, request);
  const before = await f.modelUseRequest(request);
  expect(before).toMatchObject({
    decision: "allowed",
    externalDispatchAllowed: true,
  });
  if (!before.externalDispatchAllowed)
    throw new Error("No actual completion dispatch admission");
  providerCalls.push("model-completion");
  const configuration = VertexResearchChatExpertConfigurationV1Schema.parse(
    f.config.value
  );
  const response = buildSyntheticChatOutputResponse(
    completionInputBytes,
    configuration.provider.servedModel,
    measuredInputTokens
  );
  // Genuine AFTER-return proof from the real original model-use/audit owner.
  const after = await f.modelUseRequest(request);
  expect(after).toMatchObject({
    decision: "allowed",
    externalDispatchAllowed: false,
  });
  const decoded = await decodeResearchChatAdvisoryOutput({
    plan: f.plan,
    configuration,
    request,
    responseBytes: response.responseBytes,
    completionInputBytes,
    modelPolicy: f.modelPolicy.value,
  });
  const contentSha256 = await hashArtifact(decoded.bytes),
    queued = f.recipe.execution.queuedRun;
  const stage = WorkerStageArtifactInputSchema.parse({
    ...f.fence,
    collectionId: f.plan.collectionId,
    artifactId: f.recipe.copies.advisory.copyId,
    contentBase64: base64(decoded.bytes),
    contentSha256,
    canonicalSha256: contentSha256,
    contentType: "application/json",
    rightsPolicyId: queued.rightsPolicyId,
    rightsVersion: queued.rightsVersion,
    lineageArtifactIds: f.plan.reviewPins.map((pin) => pin.artifactId),
    chatCompletion: {
      request,
      responseBase64: base64(response.responseBytes),
      proof: after,
    },
  });
  return {
    request,
    before,
    after,
    completionInputBytes,
    ...response,
    decoded,
    contentSha256,
    stage,
    providerCalls,
  };
};
type Consumed = Awaited<ReturnType<typeof consumedCompletion>>;
export const stageAdvisory = async (f: Fixture, consumed: Consumed) => {
  const result = WorkerStageArtifactOutputSchema.parse(
    await f.worker.invoke(f.identity, "stageArtifact", consumed.stage)
  );
  expect(result).toMatchObject({
    status: "accepted",
    artifact: {
      artifactId: f.recipe.copies.advisory.copyId,
      artifactSha256: consumed.contentSha256,
    },
  });
  return result;
};
export const publicationInput = async (f: Fixture, consumed: Consumed) => {
  const queued = f
    .table("vertex_records")
    .find(
      (row) => row["artifact_id"] === f.recipe.execution.queuedRun.artifactId
    )!;
  const run = AgentRunSchema.parse({
    ...queued["payload"],
    status: "completed",
    outputArtifactIds: [f.recipe.copies.advisory.copyId],
  });
  const contentSha256 = await hashArtifact(run),
    bytes = jsonBytes(run),
    rights = f.recipe.execution.queuedRun;
  const stage = WorkerStageArtifactInputSchema.parse({
    ...f.fence,
    collectionId: f.plan.collectionId,
    artifactId: f.plan.runId,
    contentBase64: base64(bytes),
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
      artifactSha256: consumed.contentSha256,
    },
    reviewPins: f.plan.reviewPins,
  });
  return { run, bytes, contentSha256, stage, publish };
};
export const publishedOutput = async (f: Fixture, consumed: Consumed) => {
  await stageAdvisory(f, consumed);
  const publication = await publicationInput(f, consumed);
  expect(
    WorkerStageArtifactOutputSchema.parse(
      await f.worker.invoke(f.identity, "stageArtifact", publication.stage)
    ).artifact
  ).toEqual(publication.publish.artifact);
  const result = WorkerResultSchema.parse(
    await f.worker.invoke(f.identity, "publishAgent", publication.publish)
  );
  expect(result.outputArtifactIds).toEqual([f.plan.runId]);
  expect(
    f
      .table("vertex_worker_agent_publications")
      .filter((row) => row["run_id"] === f.plan.runId)
  ).toHaveLength(1);
  return publication;
};
export const complete = async (
  f: Fixture,
  outcome: "succeeded" | "unknown",
  ids: string[]
) => {
  const outcomeSha256 = await hashArtifact({
    source: "synthetic-authenticated-worker-outcome",
    responseRequestId: f.responseRequestId,
    outcome,
  });
  return WorkerResultSchema.parse(
    await f.worker.invoke(f.identity, "complete", {
      ...f.fence,
      outcome,
      outcomeSha256,
      outputArtifactIds: ids,
    })
  );
};
export const inputOnlyClosure = (f: Fixture): void => {
  expect(f.table(closures).map((row) => row["domain"])).toEqual(["inputs"]);
  expect(f.table("vertex_research_chat_copy_closures")).toHaveLength(0);
};
export const noOrdinaryAdvisory = (f: Fixture): void => {
  const id = f.recipe.copies.advisory.copyId;
  for (const table of [
    "vertex_worker_stages",
    "vertex_records",
    "vertex_artifacts",
  ])
    expect(f.table(table).some((row) => row["artifact_id"] === id)).toBe(false);
};
export const originalChatReadGrant = (f: Fixture) => {
  const binding = f
    .table("vertex_grant_bindings")
    .find(
      (row) =>
        row["grantee_actor_id"] === owner.actorId &&
        row["collection_key"] === "" &&
        row["resource_id"] === "research-chat"
    );
  if (!binding)
    throw new Error("Actual original owner chat-read grant binding is absent");
  const version = f
    .table("vertex_grant_versions")
    .find(
      (row) =>
        row["grant_id"] === binding["grant_id"] && row["version"] === "1.0.0"
    );
  if (!version)
    throw new Error("Actual original owner chat-read grant version is absent");
  return version["payload"];
};
export const shortenChatReadGrant = async (f: Fixture): Promise<void> => {
  const original = originalChatReadGrant(f);
  expect(
    await f.authorization.issueGrant({
      principal: { actorId: original.recordedByActorId },
      grantId: original.grantId,
      granteeActorId: owner.actorId,
      scope,
      collectionId: null,
      resourceId: "research-chat",
      actions: original.actions,
      version: "2.0.0",
      expectedVersion: "1.0.0",
      validFrom: f.state.at,
      expiresAt: LATER,
    })
  ).toBe("recorded");
  expect(
    f
      .table("vertex_grant_versions")
      .find(
        (row) =>
          row["grant_id"] === original.grantId && row["version"] === "2.0.0"
      )!["payload"].expiresAt
  ).toBe(LATER);
};
