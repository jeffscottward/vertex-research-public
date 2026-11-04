import { expect } from "vitest";
import { canonicalArtifactJson } from "@darkfactory/shared/vertex";
import { chatWorkerFixture } from "./vertex-research-chat-worker-runtime.test-support.ts";
import {
  AT,
  END,
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import { VertexResearchChatPlanV1Schema } from "../contracts/vertex-research-chat-execution.ts";
import { VertexResearchChatAppendResponseOutputSchema } from "../contracts/vertex-research-chat-conversation.ts";
import {
  type prepareFixture,
  consumeAndStageAdvisory,
  publishAdvisory,
  completeResponse,
  fenceInputs,
  type ConversationFixture,
} from "./vertex-research-chat-conversation-runtime.test-support.ts";
import { scaledTimeout } from "../../../../scripts/lib/test-timeout-scale.ts";

// SOURCE ONLY: no execution, PostgreSQL concurrency, live provider/storage or
// operational qualification claim. All positive conversation authority below
// comes from the original owners, never fabricated agent/history/authority rows.
export const TIMEOUT = scaledTimeout(120_000);
export const messages = "vertex_research_chat_messages";
export const closures = "vertex_research_chat_copy_domain_closures";
export const observations = "vertex_research_chat_copy_effect_observations";
const CALLER_END = "2026-09-24T14:00:00.000000001Z";
export const conversationFixture = (
  options: Readonly<{ storageReviewExpiresAt?: string }> = {}
) =>
  chatWorkerFixture({
    ...options,
    admissionPath: "conversation",
    participantId: "jan-smolen",
  });
export const eligibleResponse = async (
  options: Readonly<{ storageReviewExpiresAt?: string }> = {}
) => {
  const f = await conversationFixture(options),
    advisory = await consumeAndStageAdvisory(f);
  await publishAdvisory(f, advisory);
  await completeResponse(f);
  const cleaner = await fenceInputs(f);
  return { ...f, advisory, cleaner };
};
export const currentCallerGrants = (f: ConversationFixture) =>
  f
    .table("vertex_grant_bindings")
    .filter(
      (row) =>
        row["grantee_actor_id"] === owner.actorId &&
        row["collection_key"] === "" &&
        ["account-scope", "research-chat"].includes(row["resource_id"])
    )
    .map((binding) => {
      const current = f
        .table("vertex_grant_current")
        .find((row) => row["grant_id"] === binding["grant_id"]);
      const version = f
        .table("vertex_grant_versions")
        .find(
          (row) =>
            row["grant_id"] === binding["grant_id"] &&
            row["version"] === current?.["current_version"]
        );
      if (!(current && version))
        throw new Error("Actual current caller grant absent");
      return version["payload"];
    });
export const preserveCallerBeyondOriginalDeadline = async (
  f: ConversationFixture
) => {
  const grants = currentCallerGrants(f);
  expect(grants).toHaveLength(2);
  for (const grant of grants) {
    const expectedVersion = grant.version;
    expect(grant.expiresAt).toBe(END);

    await f.authorization.issueGrant({
      principal: { actorId: "fixture-grant-admin" },
      grantId: grant.grantId,
      granteeActorId: owner.actorId,
      scope,
      collectionId: null,
      resourceId: grant.resourceId,
      actions: grant.actions,
      version: "2.0.0",
      expectedVersion,
      validFrom: AT,
      expiresAt: CALLER_END,
    });
  }
};
export const originalPins = (f: ConversationFixture) =>
  canonicalArtifactJson({
    plan: f
      .table("vertex_research_chat_execution_plans")
      .filter((row) => row["response_request_id"] === f.responseRequestId),
    approval: f
      .table("vertex_research_chat_execution_approvals")
      .filter((row) => row["response_request_id"] === f.responseRequestId),
    storageReviews: f
      .table("vertex_research_chat_storage_reviews")
      .filter((row) => row["response_request_id"] === f.responseRequestId),
    records: f.table("vertex_records"),
    artifacts: f.table("vertex_artifacts"),
    contextGrants: f
      .table("vertex_grant_versions")
      .filter(
        (row) =>
          row["payload"].resourceId ===
          `research-chat-context-use:${f.responseRequestId}`
      ),
  });
export const append = async (
  f: ConversationFixture,
  expectedRevision = "2"
) => {
  const result = VertexResearchChatAppendResponseOutputSchema.parse(
    await f.runtime.conversation.appendResponse(owner, {
      ...f.selector,
      expectedRevision,
    })
  );
  if (result.status !== "appended")
    throw new Error("Actual eligible reference was not appended");
  return result;
};
export const contentInput = (f: ConversationFixture, messageId: string) => ({
  ...f.selector,
  messageId,
});
export const history = (f: ConversationFixture) =>
  f.store.readResearchChatTranscriptPage(owner, scope, f.request.threadId, {
    limit: 100,
    cursor: null,
  });
export const head = (f: ConversationFixture) =>
  f
    .table("vertex_research_chat_threads")
    .find((row) => row["thread_id"] === f.request.threadId)!["revision"];
export const inputIds = (f: ConversationFixture) => [
  f.recipe.copies.context.copyId,
  f.recipe.copies.tokenizeInput.copyId,
  f.recipe.copies.completionInput.copyId,
];
export const preparedPlan = (f: Awaited<ReturnType<typeof prepareFixture>>) =>
  VertexResearchChatPlanV1Schema.parse(
    f
      .table("vertex_research_chat_execution_plans")
      .find((row) => row["response_request_id"] === f.responseRequestId)?.[
      "payload"
    ]
  );
