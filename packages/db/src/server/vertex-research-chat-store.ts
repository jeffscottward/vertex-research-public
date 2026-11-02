import {
  snapshotVertexChatCopyBinding,
  VERTEX_CHAT_COPY_FENCE_PROFILE,
  vertexChatCopyKey,
} from "@darkfactory/storage/chat-copies";
import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import { createResearchChatResponseReceiptOperations } from "./vertex-command-store.ts";
import {
  array,
  fail,
  identifier,
  insert,
  json,
  object,
  one,
  type PersistenceContext,
  type Row,
  rows,
  scopeWhere,
  sequence,
  string,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexBoundaryContractName,
  VertexPage,
  VertexPrincipal,
  VertexRecord,
  VertexResearchChatInputName,
  VertexScope,
  VertexStore,
} from "./vertex-ports.ts";
import {
  createResearchChatCopyMetadata,
  createResearchChatCopyOperations,
} from "./vertex-research-chat-copy-store.ts";
import {
  createResearchChatNativePhaseStore,
  isNativeEvidencePlan,
  nativeEvidenceCopyKey,
  nativeEvidenceCopyPurposes,
} from "./vertex-research-chat-native-phase-store.ts";

const envelope = {
  schemaVersion: "1.0.0",
  executionAuthorized: false,
} as const;
const unavailableReason = "research-chat-agent-admission-unavailable";
const exact = (value: unknown, keys: readonly string[]): VertexRecord => {
  const result = object(value);
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result, key))
  )
    return fail("invalid");
  return result;
};
const researchScope = (
  principal: VertexPrincipal,
  scope: VertexScope
): void => {
  exact(principal, ["actorId"]);
  exact(scope, ["accountAlias", "environment"]);
  identifier(principal.actorId);
  identifier(scope.accountAlias);
  if (scope.environment !== "research") fail("invalid");
};
const ordinal = (value: unknown): bigint => {
  const result = sequence(value);
  if (result < 1n) return fail("invalid");
  return result;
};
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const cursor = (binding: string, after: string): string =>
  btoa(JSON.stringify({ version: 1, binding, after }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/[=]+$/g, "");
const cursorPosition = (
  value: unknown,
  binding: string,
  messages: boolean
): string | null => {
  if (value === null) return null;
  try {
    if (
      typeof value !== "string" ||
      value.length > 4096 ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    )
      return fail("invalid");
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = exact(
      JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))),
      ["version", "binding", "after"]
    );
    const after = string(decoded["after"]);
    if (
      decoded["version"] !== 1 ||
      decoded["binding"] !== binding ||
      cursor(binding, after) !== value
    )
      return fail("invalid");
    if (messages) {
      ordinal(after);
    } else identifier(after);
    return after;
  } catch {
    return fail("invalid");
  }
};

type TranscriptPosition = Readonly<{
  after: string;
  snapshotRevision: string;
  highWaterSequence: string;
}>;
const transcriptCursor = (
  binding: string,
  position: TranscriptPosition
): string => {
  return btoa(
    JSON.stringify({
      version: 2,
      operation: "readTranscriptPage",
      binding,
      ...position,
    })
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/[=]+$/g, "");
};

// An operation group in the existing store, not a second store/runtime. Human
// statements require current content grants and ownership, not selected policy,
// corpus readiness or a model. No worker/job/outbox is admitted by this module.
export const createResearchChatOperations = (ctx: PersistenceContext) => {
  const responseReceipts = createResearchChatResponseReceiptOperations(ctx);
  const input = async (
    name: VertexResearchChatInputName,
    principal: VertexPrincipal,
    scope: VertexScope,
    value: unknown
  ): Promise<VertexRecord> => {
    researchScope(principal, scope);
    return await ctx.validateResearchChatInput(name, value);
  };
  const checked = async (
    name: VertexBoundaryContractName,
    value: unknown,
    expectedHash?: unknown
  ): Promise<VertexRecord> => {
    const before = await ctx.hash(value);
    if (expectedHash !== undefined && before !== expectedHash)
      return fail("integrity");
    const result = await ctx.validate(name, value);
    if ((await ctx.hash(result)) !== before) return fail("integrity");
    return freeze(result);
  };
  const threadIdentity = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    key: string
  ): Promise<string> => {
    return `chat-${await ctx.hash({ operation: "createThread", actorId: principal.actorId, scope, idempotencyKey: key })}`;
  };
  const messageIdentity = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string,
    key: string
  ): Promise<string> => {
    return `message-${await ctx.hash({ operation: "sendMessage", actorId: principal.actorId, scope, threadId, idempotencyKey: key })}`;
  };
  const owned = (
    row: Row,
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string
  ): void => {
    if (
      row["account_alias"] !== scope.accountAlias ||
      row["environment"] !== scope.environment ||
      row["owner_actor_id"] !== principal.actorId ||
      row["thread_id"] !== threadId
    )
      fail("integrity");
  };
  const request = (
    operation: "createThread" | "sendMessage",
    principal: VertexPrincipal,
    value: VertexRecord
  ): VertexRecord => ({ operation, actorId: principal.actorId, input: value });
  const verifyRequest = async (
    operation: "createThread" | "sendMessage",
    principal: VertexPrincipal,
    scope: VertexScope,
    row: Row
  ): Promise<VertexRecord> => {
    const stored = exact(row["request"], ["operation", "actorId", "input"]);
    if (
      stored["operation"] !== operation ||
      stored["actorId"] !== principal.actorId ||
      (await ctx.hash(stored)) !== row["request_hash"]
    )
      return fail("integrity");
    const command = await ctx.validateResearchChatInput(
      operation,
      stored["input"]
    );
    if (
      command["accountAlias"] !== scope.accountAlias ||
      command["environment"] !== scope.environment ||
      command["idempotencyKey"] !== row["idempotency_key"]
    )
      return fail("integrity");
    return command;
  };
  const verifyThread = async (
    row: Row,
    principal: VertexPrincipal,
    scope: VertexScope
  ): Promise<Readonly<{ current: VertexRecord; original: VertexRecord }>> => {
    const current = await checked(
      "ResearchChatThread",
      row["payload"],
      row["record_hash"]
    );
    const threadId = identifier(current["threadId"]);
    owned(row, principal, scope, threadId);
    const command = await verifyRequest("createThread", principal, scope, row);
    const original = await checked(
      "ResearchChatThread",
      row["response"],
      row["response_hash"]
    );
    const expected = {
      ...envelope,
      ...scope,
      threadId: await threadIdentity(
        principal,
        scope,
        identifier(command["idempotencyKey"])
      ),
      ownerActorId: principal.actorId,
      title: command["title"],
      participantIds: command["participantIds"],
      createdAt: row["created_at"],
      updatedAt: row["created_at"],
      revision: "1",
    };
    if (
      (await ctx.hash(expected)) !== row["response_hash"] ||
      (await ctx.hash({
        ...current,
        updatedAt: original["updatedAt"],
        revision: "1",
      })) !== row["response_hash"]
    )
      return fail("integrity");
    if (
      current["revision"] !== row["revision"] ||
      current["updatedAt"] !== row["updated_at"] ||
      ordinal(current["revision"]) !== sequence(row["last_sequence"]) + 1n
    )
      return fail("integrity");
    return { current, original };
  };
  const loadThread = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string
  ): Promise<Readonly<{ row: Row; current: VertexRecord }> | null> => {
    const row = await one(
      tx,
      "vertex_research_chat_threads",
      scope,
      sql`owner_actor_id = ${principal.actorId} and thread_id = ${threadId}`
    );
    if (!row) return null;
    const { current } = await verifyThread(row, principal, scope);
    if (current["threadId"] !== threadId) return fail("integrity");
    return { row, current };
  };
  const response = (requested: readonly unknown[]): VertexRecord => ({
    status: requested.length === 0 ? "not-requested" : "unavailable",
    runId: null,
    jobId: null,
    reasonCodes: requested.length === 0 ? [] : [unavailableReason],
  });
  const verifyMessage = async (
    row: Row,
    principal: VertexPrincipal,
    scope: VertexScope,
    thread: VertexRecord
  ): Promise<
    Readonly<{ message: VertexRecord; acknowledgement: VertexRecord }>
  > => {
    const threadId = identifier(thread["threadId"]);
    owned(row, principal, scope, threadId);
    const command = await verifyRequest("sendMessage", principal, scope, row);
    if (command["threadId"] !== threadId) return fail("integrity");
    const selected = array(thread["participantIds"], 16);
    const requested = array(command["requestedParticipantIds"], 8);
    if (requested.some((id) => !selected.includes(id)))
      return fail("integrity");
    const message = await checked(
      "ResearchChatMessage",
      row["payload"],
      row["record_hash"]
    );
    const expectedMessage = {
      ...envelope,
      threadId,
      messageId: await messageIdentity(
        principal,
        scope,
        threadId,
        identifier(command["idempotencyKey"])
      ),
      sequence: command["expectedRevision"],
      author: { kind: "user", actorId: principal.actorId },
      kind: "statement",
      body: command["body"],
      citations: [],
      recordedAt: row["recorded_at"],
    };
    if (
      (await ctx.hash(expectedMessage)) !== row["record_hash"] ||
      message["messageId"] !== row["message_id"] ||
      message["sequence"] !== row["sequence"] ||
      ordinal(message["sequence"]) >= ordinal(thread["revision"]) ||
      time(message["recordedAt"]) < time(thread["createdAt"]) ||
      time(message["recordedAt"]) > time(thread["updatedAt"])
    )
      return fail("integrity");
    const acknowledgement = await checked(
      "ResearchChatSendMessageOutput",
      row["response"],
      row["response_hash"]
    );
    const expected = {
      ...envelope,
      message,
      threadRevision: (ordinal(message["sequence"]) + 1n).toString(),
      response: response(requested),
    };
    if ((await ctx.hash(expected)) !== row["response_hash"])
      return fail("integrity");
    return { message, acknowledgement };
  };

  const referenceIdentity = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string,
    responseRequestId: string
  ): Promise<string> => {
    const digest = await ctx.hash({
      operation: "appendResponse",
      actorId: principal.actorId,
      scope,
      threadId,
      responseRequestId,
    });
    return `message-${digest}`;
  };
  const referenceDraft = (message: VertexRecord): VertexRecord => {
    const {
      messageId,
      sequence: position,
      parentMessageId,
      recordedAt,
      ...draft
    } = message;
    return draft;
  };
  const indexed = (row: Row, expected: VertexRecord): void => {
    const entries = Object.entries(expected);
    for (const [key, value] of entries)
      if (row[key] !== value) fail("integrity");
  };
  const historicalRecord = async (
    tx: Transaction,
    table: string,
    scope: VertexScope,
    responseRequestId: string
  ): Promise<Readonly<{ row: Row; value: VertexRecord }>> => {
    const row = await one(
      tx,
      table,
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!row) return fail("integrity");
    const value = object(row["payload"]);
    indexed(row, {
      account_alias: scope.accountAlias,
      environment: scope.environment,
      response_request_id: responseRequestId,
    });
    if ((await ctx.hash(value)) !== row["record_hash"])
      return fail("integrity");
    return { row, value };
  };
  // Historical integrity only: these immutable joins confer NO current read,
  // publish, eligibility, lease or storage authority and never read answer bytes.
  // Interpret original proofs at recordedAt, never at today's clock/rights head.
  const verifyReferenceProvenance = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    message: VertexRecord
  ): Promise<void> => {
    const pin = object(message["response"]);
    const author = object(message["author"]);
    const responseRequestId = identifier(pin["responseRequestId"]);
    const threadId = identifier(message["threadId"]);
    const at = string(message["recordedAt"]);
    const storedPlan = await historicalRecord(
      tx,
      "vertex_research_chat_execution_plans",
      scope,
      responseRequestId
    );
    const plan = storedPlan.value;
    const { planId, planSha256, ...planBody } = plan;
    indexed(storedPlan.row, {
      owner_actor_id: principal.actorId,
      thread_id: threadId,
      plan_id: pin["planId"],
      plan_sha256: pin["planSha256"],
      request_sha256: pin["requestSha256"],
      idempotency_key: plan["idempotencyKey"],
    });
    const native = isNativeEvidencePlan(plan);
    if (
      ![
        "vertex-research-chat-plan-v1",
        "vertex-research-chat-plan-v2",
        "vertex-research-chat-native-evidence-plan-v1",
      ].includes(String(plan["format"])) ||
      plan["executionAuthorized"] !== false ||
      plan["accountAlias"] !== scope.accountAlias ||
      plan["environment"] !== scope.environment ||
      plan["ownerActorId"] !== principal.actorId ||
      plan["threadId"] !== threadId ||
      plan["responseRequestId"] !== responseRequestId ||
      planId !== pin["planId"] ||
      planSha256 !== pin["planSha256"] ||
      (await ctx.hash(planBody)) !== planSha256 ||
      planId !== `chat-plan-${planSha256}`
    )
      return fail("integrity");
    if (
      plan["parentMessageId"] !== message["replyToMessageId"] ||
      plan["participantId"] !== author["participantId"] ||
      plan["runId"] !== author["runId"] ||
      plan["traceId"] !== pin["traceId"] ||
      plan["requestSha256"] !== pin["requestSha256"] ||
      plan["snapshotRevision"] !== pin["snapshotRevision"] ||
      plan["contextStartSequence"] !== pin["contextStartSequence"] ||
      object(plan["context"])["sha256"] !== pin["contextSha256"] ||
      ordinal(pin["snapshotRevision"]) > ordinal(message["sequence"]) ||
      time(plan["plannedAt"]) > time(at)
    )
      return fail("integrity");
    const receipt = await responseReceipts.read(
      tx,
      principal,
      scope,
      threadId,
      identifier(plan["idempotencyKey"])
    );
    if (
      receipt?.["status"] !== "admitted" ||
      receipt["responseRequestId"] !== responseRequestId ||
      receipt["requestSha256"] !== pin["requestSha256"] ||
      receipt["parentMessageId"] !== message["replyToMessageId"] ||
      receipt["participantId"] !== author["participantId"] ||
      receipt["snapshotRevision"] !== pin["snapshotRevision"] ||
      receipt["contextStartSequence"] !== pin["contextStartSequence"] ||
      time(receipt["recordedAt"]) > time(at)
    )
      return fail("integrity");
    const approved = await historicalRecord(
      tx,
      "vertex_research_chat_execution_approvals",
      scope,
      responseRequestId
    );
    const approval = approved.value;
    indexed(approved.row, {
      owner_actor_id: principal.actorId,
      plan_id: planId,
      plan_sha256: planSha256,
      storage_review_id: approval["storageReviewId"],
    });
    if (
      approval["ownerActorId"] !== principal.actorId ||
      approval["responseRequestId"] !== responseRequestId ||
      approval["planId"] !== planId ||
      approval["planSha256"] !== planSha256 ||
      approval["requestSha256"] !== pin["requestSha256"] ||
      approval["accountAlias"] !== scope.accountAlias ||
      approval["environment"] !== scope.environment
    )
      return fail("integrity");
    if (
      approval["format"] !==
        (native
          ? "vertex-research-chat-native-evidence-approval-v1"
          : plan["format"] === "vertex-research-chat-plan-v2"
            ? "vertex-research-chat-approval-v2"
            : "vertex-research-chat-approval-v1") ||
      approval["executionAuthorized"] !== false ||
      approval["threadId"] !== threadId ||
      approval["parentMessageId"] !== message["replyToMessageId"] ||
      approval["participantId"] !== author["participantId"] ||
      approval["snapshotRevision"] !== pin["snapshotRevision"] ||
      approval["contextStartSequence"] !== pin["contextStartSequence"] ||
      approval["idempotencyKey"] !== plan["idempotencyKey"] ||
      time(approval["approvedAt"]) < time(plan["plannedAt"]) ||
      time(approval["approvedAt"]) > time(at)
    )
      return fail("integrity");
    const storedOrigin = await historicalRecord(
      tx,
      "vertex_research_chat_worker_origins",
      scope,
      responseRequestId
    );
    const origin = storedOrigin.value;
    indexed(storedOrigin.row, {
      owner_actor_id: principal.actorId,
      plan_id: planId,
      plan_sha256: planSha256,
      run_id: author["runId"],
      event_id: pin["eventId"],
      job_id: pin["jobId"],
      recipe_sha256: origin["recipeSha256"],
    });
    if (
      origin["profile"] !== "vertex-research-chat-worker-origin-v1" ||
      origin["accountAlias"] !== scope.accountAlias ||
      origin["environment"] !== scope.environment ||
      origin["responseRequestId"] !== responseRequestId ||
      origin["ownerActorId"] !== principal.actorId ||
      origin["planId"] !== planId ||
      origin["planSha256"] !== planSha256 ||
      origin["requestSha256"] !== pin["requestSha256"] ||
      origin["approvalSha256"] !== approved.row["record_hash"] ||
      origin["runId"] !== author["runId"] ||
      origin["traceId"] !== pin["traceId"] ||
      origin["eventId"] !== pin["eventId"] ||
      origin["jobId"] !== pin["jobId"] ||
      origin["contextSha256"] !== pin["contextSha256"] ||
      origin["collectionId"] !== plan["collectionId"] ||
      origin["jobId"] !==
        `job-${await ctx.hash({ scope, eventId: origin["eventId"] })}` ||
      time(origin["admittedAt"]) > time(at)
    )
      return fail("integrity");
    const recipe = object(origin["recipe"]);
    if (
      (await ctx.hash(recipe)) !== origin["recipeSha256"] ||
      recipe["profile"] !==
        (native
          ? "vertex-research-chat-native-evidence-job-v1"
          : plan["format"] === "vertex-research-chat-plan-v2"
            ? "vertex-research-chat-job-v2"
            : "vertex-research-chat-job-v1") ||
      recipe["actor_id"] !== principal.actorId ||
      recipe["account_alias"] !== scope.accountAlias ||
      recipe["environment"] !== scope.environment ||
      recipe["response_request_id"] !== responseRequestId ||
      recipe["plan_id"] !== planId ||
      recipe["plan_sha256"] !== planSha256 ||
      recipe["run_id"] !== author["runId"] ||
      recipe["trace_id"] !== pin["traceId"]
    )
      return fail("integrity");
    if (plan["format"] === "vertex-research-chat-plan-v2") {
      const debate = object(plan["debate"]);
      if (
        debate["profile"] !== "vertex-research-chat-debate-plan-v1" ||
        approval["debateSha256"] !== (await ctx.hash(debate)) ||
        (await ctx.hash(object(recipe["execution"])["debate"])) !==
          (await ctx.hash(debate))
      )
        return fail("integrity");
    } else if (
      Object.hasOwn(plan, "debate") ||
      Object.hasOwn(approval, "debateSha256") ||
      Object.hasOwn(object(recipe["execution"]), "debate")
    )
      return fail("integrity");
    if (
      native &&
      (approval["consent"] !== "approve-bounded-native-evidence-protocol-v1" ||
        object(plan["nativeEvidence"])["profile"] !==
          "first-mate-read-reviewed-evidence-v1" ||
        approval["nativeEvidenceSha256"] !==
          (await ctx.hash(plan["nativeEvidence"])) ||
        (await ctx.hash(object(recipe["execution"])["nativeEvidence"])) !==
          (await ctx.hash(plan["nativeEvidence"])))
    )
      return fail("integrity");
    const reply = await one(
      tx,
      "vertex_research_chat_messages",
      scope,
      sql`owner_actor_id = ${principal.actorId} and thread_id = ${threadId} and message_id = ${message["replyToMessageId"]}`
    );
    if (
      !reply ||
      reply["sequence"] !== (ordinal(pin["snapshotRevision"]) - 1n).toString()
    )
      return fail("integrity");
    // The original human verifier is intentionally retained for this original
    // response-to row; it is never widened to accept an agent as human context.
    const thread = await loadThread(tx, principal, scope, threadId);
    if (!thread) return fail("integrity");
    await verifyMessage(reply, principal, scope, thread.current);
    const storedAdvisory = await historicalRecord(
      tx,
      "vertex_research_chat_advisory_origins",
      scope,
      responseRequestId
    );
    const advisory = storedAdvisory.value;
    const artifact = object(pin["runArtifact"]);
    const profile = object(pin["advisoryArtifact"]);
    indexed(storedAdvisory.row, {
      job_id: pin["jobId"],
      run_id: author["runId"],
      plan_sha256: planSha256,
      copy_id: profile["artifactId"],
      content_sha256: profile["artifactSha256"],
      request_sha256: advisory["modelUseRequestSha256"],
      response_sha256: advisory["responseSha256"],
    });
    if (
      advisory["profile"] !==
        (native
          ? "vertex-research-chat-native-evidence-advisory-origin-v1"
          : "vertex-research-chat-advisory-origin-v1") ||
      advisory["accountAlias"] !== scope.accountAlias ||
      advisory["environment"] !== scope.environment ||
      advisory["responseRequestId"] !== responseRequestId ||
      advisory["planId"] !== planId ||
      advisory["planSha256"] !== planSha256 ||
      advisory["originalRequestSha256"] !== pin["requestSha256"] ||
      advisory["jobId"] !== pin["jobId"] ||
      advisory["runId"] !== author["runId"] ||
      advisory["traceId"] !== pin["traceId"] ||
      advisory["eventId"] !== pin["eventId"] ||
      advisory["recipeSha256"] !== origin["recipeSha256"] ||
      advisory["copyId"] !== profile["artifactId"] ||
      advisory["contentSha256"] !== profile["artifactSha256"] ||
      artifact["artifactId"] !== author["runId"] ||
      object(object(recipe["copies"])["advisory"])["copyId"] !==
        profile["artifactId"]
    )
      return fail("integrity");
    const publication = await one(
      tx,
      "vertex_worker_agent_publications",
      scope,
      sql`run_id = ${author["runId"]}`
    );
    const admission = await one(
      tx,
      "vertex_worker_run_admissions",
      scope,
      sql`job_id = ${pin["jobId"]} and run_id = ${author["runId"]}`
    );
    const queued = await one(
      tx,
      "vertex_records",
      scope,
      sql`artifact_id = ${origin["runArtifactId"]} and contract_name = 'AgentRun'`
    );
    const completed = await one(
      tx,
      "vertex_records",
      scope,
      sql`artifact_id = ${author["runId"]} and contract_name = 'AgentRun'`
    );
    if (!(publication && admission && queued && completed))
      return fail("integrity");
    const queuedRun = await checked(
      "AgentRun",
      queued["payload"],
      queued["record_hash"]
    );
    const run = await checked(
      "AgentRun",
      completed["payload"],
      completed["record_hash"]
    );
    if (
      queued["record_hash"] !== origin["runSha256"] ||
      queued["artifact_sha256"] !== origin["runSha256"] ||
      queuedRun["runId"] !== author["runId"] ||
      queuedRun["status"] !== "queued" ||
      (await ctx.hash({
        ...queuedRun,
        status: "completed",
        outputArtifactIds: [profile["artifactId"]],
      })) !== artifact["artifactSha256"] ||
      completed["record_hash"] !== artifact["artifactSha256"] ||
      completed["artifact_sha256"] !== artifact["artifactSha256"]
    )
      return fail("integrity");
    indexed(queued, {
      account_alias: scope.accountAlias,
      environment: scope.environment,
      collection_key: plan["collectionId"],
      artifact_id: origin["runArtifactId"],
      contract_name: "AgentRun",
    });
    indexed(completed, {
      account_alias: scope.accountAlias,
      environment: scope.environment,
      collection_key: plan["collectionId"],
      artifact_id: author["runId"],
      contract_name: "AgentRun",
    });
    const event = await one(
      tx,
      "vertex_outbox",
      scope,
      sql`event_id = ${origin["eventId"]}`
    );
    if (!event) return fail("integrity");
    const eventPayload = object(event["payload"]);
    indexed(event, {
      account_alias: scope.accountAlias,
      environment: scope.environment,
      collection_key: plan["collectionId"],
      event_id: origin["eventId"],
      record_hash: origin["eventSha256"],
    });
    if (
      (await ctx.hash(eventPayload)) !== origin["eventSha256"] ||
      eventPayload["eventId"] !== origin["eventId"] ||
      eventPayload["actorId"] !== principal.actorId ||
      eventPayload["correlationId"] !== pin["traceId"] ||
      (await ctx.hash(eventPayload["payload"])) !== origin["runSha256"] ||
      time(approval["approvedAt"]) > time(origin["admittedAt"])
    )
      return fail("integrity");
    indexed(publication, {
      account_alias: scope.accountAlias,
      environment: scope.environment,
      run_id: author["runId"],
      run_artifact_id: artifact["artifactId"],
      advisory_artifact_id: profile["artifactId"],
      advisory_sha256: profile["artifactSha256"],
    });
    indexed(admission, {
      account_alias: scope.accountAlias,
      environment: scope.environment,
      job_id: pin["jobId"],
      run_id: author["runId"],
      request_hash: origin["recipeSha256"],
    });
    if (
      (await ctx.hash(publication["review_pins"])) !==
        (await ctx.hash(plan["reviewPins"])) ||
      publication["request_hash"] !==
        (await ctx.hash({
          run,
          artifact,
          profile,
          reviewPins: plan["reviewPins"],
        })) ||
      time(admission["admitted_at"]) > time(publication["published_at"]) ||
      time(advisory["boundAt"]) > time(publication["published_at"]) ||
      time(publication["published_at"]) > time(at)
    )
      return fail("integrity");
    if (native && scope.environment !== "research") return fail("integrity");
    const nativeInventory = native
      ? await createResearchChatCopyMetadata(ctx).load(
          tx,
          { accountAlias: scope.accountAlias, environment: "research" },
          responseRequestId
        )
      : null;
    if (native) {
      if (
        nativeInventory?.copies.length !== 9 ||
        nativeInventory.family.ownerActorId !== principal.actorId ||
        nativeInventory.family.requestSha256 !== plan["requestSha256"] ||
        nativeInventory.family.storageProfileSha256 !==
          plan["storageProfileSha256"]
      )
        return fail("integrity");
      const phase = await createResearchChatNativePhaseStore(ctx).read(
        tx,
        scope,
        plan,
        nativeInventory,
        2,
        at
      );
      const chain = exact(advisory["nativeChain"], [
        "phaseOneDispatchSha256",
        "phaseOneProofSha256",
        "phaseTwoSha256",
        "derivationSha256",
      ]);
      const dispatch = await one(
        tx,
        "vertex_research_chat_native_model_dispatches",
        scope,
        sql`response_request_id = ${responseRequestId} and phase_ordinal = 1 and operation = 'model-completion'`
      );
      const finalRequest = await one(
        tx,
        "vertex_research_chat_native_phase_requests",
        scope,
        sql`response_request_id = ${responseRequestId} and phase_ordinal = 2 and operation = 'model-completion'`
      );
      if (
        !(phase && dispatch && finalRequest) ||
        (await ctx.hash(dispatch["payload"])) !== dispatch["record_hash"] ||
        (await ctx.hash(finalRequest["payload"])) !==
          finalRequest["record_hash"] ||
        chain["phaseOneDispatchSha256"] !== dispatch["record_hash"] ||
        chain["phaseOneProofSha256"] !==
          object(phase.derivation)["phaseOneProofSha256"] ||
        chain["phaseTwoSha256"] !== phase.phaseSha256 ||
        chain["derivationSha256"] !== (await ctx.hash(phase.derivation)) ||
        dispatch["request_sha256"] !==
          object(phase.derivation)["phaseOneRequestSha256"] ||
        finalRequest["request_sha256"] !== advisory["modelUseRequestSha256"] ||
        finalRequest["phase_sha256"] !== phase.phaseSha256
      )
        return fail("integrity");
    }
    const acknowledgements: VertexRecord[] = [];
    const fencePurposes = native
      ? nativeEvidenceCopyPurposes
          .filter((purpose) => purpose !== "advisory")
          .sort((a, b) =>
            string(object(object(recipe["copies"])[a])["copyId"]) <
            string(object(object(recipe["copies"])[b])["copyId"])
              ? -1
              : 1
          )
      : ["context", "tokenizeInput", "completionInput"];
    for (const purpose of fencePurposes) {
      const copy = object(object(recipe["copies"])[purpose]);
      const copyId = identifier(copy["copyId"]);
      const intermediate =
        native &&
        [
          "phaseOneResponse",
          "toolResult",
          "phaseTwoTokenizeInput",
          "phaseTwoCompletionInput",
        ].includes(purpose);
      const nativeEntry = nativeInventory?.copies.find(
        (entry) => entry.allocation.copyId === copyId
      );
      if (native && !nativeEntry?.contentBinding) return fail("integrity");
      const contentPin = intermediate
        ? requirePresent(
            requirePresent(nativeEntry, "nativeEntry").contentBinding,
            "nativeEntry!.contentBinding"
          ).content
        : purpose === "evidenceBundle"
          ? object(object(plan["nativeEvidence"])["bundle"])
          : object(plan[purpose]);
      const maximumBytes = intermediate
        ? object(plan["nativeEvidence"])["maximumIntermediateBytes"]
        : contentPin.byteLength;
      const allocationRow = await one(
        tx,
        "vertex_research_chat_copy_allocations",
        scope,
        sql`response_request_id = ${responseRequestId} and copy_id = ${copyId}`
      );
      const effectRow = await one(
        tx,
        "vertex_research_chat_copy_effects",
        scope,
        sql`response_request_id = ${responseRequestId} and copy_id = ${copyId} and operation = 'fence'`
      );
      const observedRow = await one(
        tx,
        "vertex_research_chat_copy_effect_observations",
        scope,
        sql`response_request_id = ${responseRequestId} and copy_id = ${copyId} and operation = 'fence'`
      );
      if (!(allocationRow && effectRow && observedRow))
        return fail("integrity");
      const allocation = object(allocationRow["payload"]);
      const {
        reservationSha256,
        reservedAt,
        binding: savedBinding,
        objectKey,
        ...base
      } = allocation;
      const binding = snapshotVertexChatCopyBinding({
        scope,
        ownerActorId: principal.actorId,
        threadId,
        responseRequestId,
        copyId,
        kind: purpose === "context" ? "context" : "model-input",
        storageProfileSha256: plan["storageProfileSha256"],
        maximumBytes,
        reservationSha256: copy["reservationSha256"],
        content: null,
      });
      if (
        (await ctx.hash(allocation)) !== allocationRow["record_hash"] ||
        (await ctx.hash(base)) !== copy["reservationSha256"] ||
        reservationSha256 !== copy["reservationSha256"] ||
        (await ctx.hash(savedBinding)) !== (await ctx.hash(binding)) ||
        objectKey !== vertexChatCopyKey(binding) ||
        base["copyId"] !== copyId ||
        base["copyIdempotencyKey"] !==
          (native
            ? nativeEvidenceCopyKey(purpose)
            : `one-expert-${purpose}-v1`) ||
        base["requestSha256"] !== pin["requestSha256"] ||
        base["ownerActorId"] !== principal.actorId ||
        base["threadId"] !== threadId ||
        base["responseRequestId"] !== responseRequestId ||
        base["storageProfileSha256"] !== plan["storageProfileSha256"] ||
        time(reservedAt) > time(at)
      )
        return fail("integrity");
      indexed(allocationRow, {
        account_alias: scope.accountAlias,
        environment: scope.environment,
        owner_actor_id: principal.actorId,
        thread_id: threadId,
        response_request_id: responseRequestId,
        request_sha256: pin["requestSha256"],
        copy_id: copyId,
        copy_idempotency_key: base["copyIdempotencyKey"],
        kind: binding.kind,
        storage_profile_sha256: plan["storageProfileSha256"],
        maximum_bytes: binding.maximumBytes,
        reservation_sha256: reservationSha256,
        object_key: objectKey,
        reserved_at: reservedAt,
        reserved_at_ns: time(reservedAt).toString(),
      });
      if (
        base["profile"] !== "vertex-research-chat-copy-allocation-v1" ||
        base["kind"] !== binding.kind ||
        base["maximumBytes"] !== binding.maximumBytes ||
        (await ctx.hash(base["scope"])) !== (await ctx.hash(scope)) ||
        (intermediate
          ? copy["content"] !== null
          : (await ctx.hash({
              sha256: copy["sha256"],
              byteLength: copy["byteLength"],
            })) !== (await ctx.hash(contentPin))) ||
        (native &&
          (await ctx.hash(
            requirePresent(
              requirePresent(nativeEntry, "nativeEntry").contentBinding,
              "nativeEntry!.contentBinding"
            ).content
          )) !== (await ctx.hash(contentPin)))
      )
        return fail("integrity");
      const { content, ...stableBinding } = binding;
      const bindingSha256 = await ctx.hash(stableBinding);
      const effect = exact(effectRow["payload"], [
        "profile",
        "scope",
        "responseRequestId",
        "copyId",
        "planSha256",
        "operation",
        "bindingSha256",
        "content",
        "intentCommittedAt",
      ]);
      const expectedEffect = {
        profile: "vertex-research-chat-copy-effect-v1",
        scope,
        responseRequestId,
        copyId,
        planSha256,
        operation: "fence",
        bindingSha256,
        content: contentPin,
        intentCommittedAt: effect["intentCommittedAt"],
      };
      indexed(effectRow, {
        account_alias: scope.accountAlias,
        environment: scope.environment,
        response_request_id: responseRequestId,
        copy_id: copyId,
        operation: "fence",
        plan_sha256: planSha256,
        binding_sha256: bindingSha256,
        intent_committed_at_ns: time(effect["intentCommittedAt"]).toString(),
      });
      if (
        (await ctx.hash(effect)) !== effectRow["record_hash"] ||
        (await ctx.hash(expectedEffect)) !== effectRow["record_hash"]
      )
        return fail("integrity");
      const observed = exact(observedRow["payload"], [
        "profile",
        "scope",
        "responseRequestId",
        "copyId",
        "planSha256",
        "operation",
        "proof",
        "observedAt",
      ]);
      const proof = exact(observed["proof"], [
        "key",
        "state",
        "bindingSha256",
        "reservationSha256",
        "storageProfileSha256",
        "sha256",
        "byteLength",
        "etag",
        "version",
        "uploadedAt",
      ]);
      const expectedObserved = {
        profile: "vertex-research-chat-copy-effect-observation-v1",
        scope,
        responseRequestId,
        copyId,
        planSha256,
        operation: "fence",
        proof,
        observedAt: observed["observedAt"],
      };
      const marker = ctx.encode({
        profile: VERTEX_CHAT_COPY_FENCE_PROFILE,
        bindingSha256,
      });
      indexed(observedRow, {
        account_alias: scope.accountAlias,
        environment: scope.environment,
        response_request_id: responseRequestId,
        copy_id: copyId,
        operation: "fence",
        observed_at_ns: time(observed["observedAt"]).toString(),
      });
      if (
        (await ctx.hash(observed)) !== observedRow["record_hash"] ||
        (await ctx.hash(expectedObserved)) !== observedRow["record_hash"] ||
        proof["key"] !== objectKey ||
        proof["state"] !== "fenced" ||
        proof["bindingSha256"] !== bindingSha256 ||
        proof["reservationSha256"] !== reservationSha256 ||
        proof["storageProfileSha256"] !== plan["storageProfileSha256"] ||
        proof["sha256"] !== (await ctx.digest(marker)) ||
        proof["byteLength"] !== marker.byteLength ||
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(string(proof["etag"])) ||
        !/^[\x21-\x7e]{1,256}$/.test(string(proof["version"])) ||
        time(proof["uploadedAt"]) > time(observed["observedAt"]) ||
        time(effect["intentCommittedAt"]) > time(observed["observedAt"]) ||
        time(observed["observedAt"]) > time(at)
      )
        return fail("integrity");
      acknowledgements.push(observed);
    }
    if (
      (await ctx.hash(acknowledgements)) !== pin["fenceAcknowledgementsSha256"]
    )
      return fail("integrity");
  };
  const verifyReference = async (
    tx: Transaction,
    row: Row,
    principal: VertexPrincipal,
    scope: VertexScope,
    thread: VertexRecord,
    chronology = true
  ): Promise<
    Readonly<{ message: VertexRecord; acknowledgement: VertexRecord }>
  > => {
    const threadId = identifier(thread["threadId"]);
    owned(row, principal, scope, threadId);
    const stored = exact(row["request"], ["operation", "actorId", "input"]);
    if (
      stored["operation"] !== "appendResponse" ||
      stored["actorId"] !== principal.actorId ||
      (await ctx.hash(stored)) !== row["request_hash"]
    )
      return fail("integrity");
    const command = await input(
      "appendResponse",
      principal,
      scope,
      stored["input"]
    );
    if ((await ctx.hash(command)) !== (await ctx.hash(stored["input"])))
      return fail("integrity");
    const responseRequestId = identifier(command["responseRequestId"]);
    if (
      command["accountAlias"] !== scope.accountAlias ||
      command["environment"] !== scope.environment ||
      command["threadId"] !== threadId ||
      row["idempotency_key"] !== `append-${responseRequestId}` ||
      command["expectedRevision"] !== row["sequence"]
    )
      return fail("integrity");
    const message = await checked(
      "ResearchChatAgentReferenceMessage",
      row["payload"],
      row["record_hash"]
    );
    const author = object(message["author"]);
    if (
      message["threadId"] !== threadId ||
      message["messageId"] !== row["message_id"] ||
      message["messageId"] !==
        (await referenceIdentity(
          principal,
          scope,
          threadId,
          responseRequestId
        )) ||
      message["sequence"] !== row["sequence"] ||
      message["recordedAt"] !== row["recorded_at"] ||
      object(message["response"])["responseRequestId"] !== responseRequestId ||
      !array(thread["participantIds"], 16).includes(author["participantId"]) ||
      ordinal(message["sequence"]) >= ordinal(thread["revision"]) ||
      time(message["recordedAt"]) < time(thread["createdAt"]) ||
      time(message["recordedAt"]) > time(thread["updatedAt"])
    )
      return fail("integrity");
    const acknowledgement = await checked(
      "ResearchChatAppendResponseOutput",
      row["response"],
      row["response_hash"]
    );
    const expected = {
      ...envelope,
      status: "appended",
      selector: { ...scope, threadId, responseRequestId },
      message,
      threadRevision: (ordinal(message["sequence"]) + 1n).toString(),
    };
    if ((await ctx.hash(expected)) !== row["response_hash"])
      return fail("integrity");
    if (chronology) {
      const prior = await one(
        tx,
        "vertex_research_chat_messages",
        scope,
        sql`owner_actor_id = ${principal.actorId} and thread_id = ${threadId} and sequence = ${(ordinal(message["sequence"]) - 1n).toString()}::numeric`
      );
      if (!prior || prior["message_id"] !== message["parentMessageId"])
        return fail("integrity");
      const previous = await verifyHistoricalMessage(
        tx,
        prior,
        principal,
        scope,
        thread,
        false
      );
      if (
        previous.message["messageId"] !== message["parentMessageId"] ||
        ordinal(previous.message["sequence"]) + 1n !==
          ordinal(message["sequence"]) ||
        time(previous.message["recordedAt"]) > time(message["recordedAt"])
      )
        return fail("integrity");
    }
    await verifyReferenceProvenance(tx, principal, scope, message);
    return { message, acknowledgement };
  };
  const verifyHistoricalMessage = async (
    tx: Transaction,
    row: Row,
    principal: VertexPrincipal,
    scope: VertexScope,
    thread: VertexRecord,
    chronology = true
  ): Promise<
    Readonly<{ message: VertexRecord; acknowledgement: VertexRecord }>
  > => {
    const operation = object(row["request"])["operation"];
    if (operation === "sendMessage")
      return await verifyMessage(row, principal, scope, thread);
    if (operation === "appendResponse")
      return await verifyReference(
        tx,
        row,
        principal,
        scope,
        thread,
        chronology
      );
    return fail("integrity");
  };

  // Internal transaction-bound STRUCTURAL persistence only, never an RPC or an
  // authorization capability. The concrete owner must join live original/source,
  // read+publish grants and eligibility BEFORE AND AFTER this call in the SAME
  // transaction/lock chain. A reference DTO is not evidence of that authority.
  const readThreadForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string
  ): Promise<Readonly<{ row: Row; current: VertexRecord }> | null> => {
    const command = await input("readThread", principal, scope, {
      ...scope,
      threadId,
    });
    return loadThread(tx, principal, scope, identifier(command["threadId"]));
  };
  const readReferenceForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    raw: Readonly<{
      threadId: string;
      responseRequestId: string;
      messageId?: string;
    }>
  ): Promise<Readonly<{
    message: VertexRecord;
    acknowledgement: VertexRecord;
    row: Row;
  }> | null> => {
    const captured = ctx.capture(raw);
    const selector = exact(
      captured,
      captured.messageId === undefined
        ? ["threadId", "responseRequestId"]
        : ["threadId", "responseRequestId", "messageId"]
    );
    researchScope(principal, scope);
    const threadId = identifier(selector["threadId"]);
    const responseRequestId = identifier(selector["responseRequestId"]);
    if (selector["messageId"] !== undefined) identifier(selector["messageId"]);
    const thread = await loadThread(tx, principal, scope, threadId);
    if (!thread) return null;
    const found = await rows(
      tx,
      sql`select * from vertex_research_chat_messages where ${scopeWhere(scope)} and request->>'operation' = 'appendResponse' and payload->'response'->>'responseRequestId' = ${responseRequestId} limit 2`
    );
    if (found.length > 1) return fail("integrity");
    const row = found[0];
    if (!row) return null;
    if (
      row["owner_actor_id"] !== principal.actorId ||
      row["thread_id"] !== threadId ||
      (selector["messageId"] !== undefined &&
        row["message_id"] !== selector["messageId"])
    )
      return fail("conflict");
    const result = await verifyReference(
      tx,
      row,
      principal,
      scope,
      thread.current
    );
    return { ...result, row };
  };
  const appendReferenceForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    raw: Readonly<{
      threadId: string;
      responseRequestId: string;
      expectedRevision: string;
    }>,
    reference: VertexRecord,
    at: string
  ): Promise<VertexRecord> => {
    const command = await input("appendResponse", principal, scope, {
      ...scope,
      ...exact(ctx.capture(raw), [
        "threadId",
        "responseRequestId",
        "expectedRevision",
      ]),
    });
    const threadId = identifier(command["threadId"]);
    const responseRequestId = identifier(command["responseRequestId"]);
    const expectedRevision = string(command["expectedRevision"]);
    const draft = exact(ctx.capture(reference), [
      "schemaVersion",
      "executionAuthorized",
      "threadId",
      "author",
      "kind",
      "replyToMessageId",
      "response",
    ]);
    const previous = await readReferenceForTransaction(tx, principal, scope, {
      threadId,
      responseRequestId,
    });
    if (previous) {
      if (
        (await ctx.hash(draft)) !==
        (await ctx.hash(referenceDraft(previous.message)))
      )
        return fail("conflict");
      // Correct replay ignores today's expectedRevision: immutable original ACK.
      return previous.acknowledgement;
    }
    const thread = await loadThread(tx, principal, scope, threadId);
    if (!thread) return fail("denied");
    if (thread.current["revision"] !== expectedRevision)
      return fail("conflict");
    if (time(at) < time(thread.current["updatedAt"])) return fail("stale");
    const prior = await one(
      tx,
      "vertex_research_chat_messages",
      scope,
      sql`owner_actor_id = ${principal.actorId} and thread_id = ${threadId} and sequence = ${thread.row["last_sequence"]}::numeric`
    );
    if (!prior) return fail("integrity");
    const predecessor = await verifyHistoricalMessage(
      tx,
      prior,
      principal,
      scope,
      thread.current
    );
    if (
      predecessor.message["sequence"] !== thread.row["last_sequence"] ||
      ordinal(predecessor.message["sequence"]) + 1n !==
        ordinal(expectedRevision)
    )
      return fail("integrity");
    const messageId = await referenceIdentity(
      principal,
      scope,
      threadId,
      responseRequestId
    );
    const message = await checked("ResearchChatAgentReferenceMessage", {
      ...draft,
      messageId,
      sequence: expectedRevision,
      parentMessageId: predecessor.message["messageId"],
      recordedAt: at,
    });
    if (
      message["threadId"] !== threadId ||
      object(message["response"])["responseRequestId"] !== responseRequestId ||
      !array(thread.current["participantIds"], 16).includes(
        object(message["author"])["participantId"]
      )
    )
      return fail("integrity");
    await verifyReferenceProvenance(tx, principal, scope, message);
    const nextRevision = (ordinal(expectedRevision) + 1n).toString();
    ordinal(nextRevision);
    const updated = await checked("ResearchChatThread", {
      ...thread.current,
      revision: nextRevision,
      updatedAt: at,
    });
    const result = await checked("ResearchChatAppendResponseOutput", {
      ...envelope,
      status: "appended",
      selector: { ...scope, threadId, responseRequestId },
      message,
      threadRevision: nextRevision,
    });
    const requested = {
      operation: "appendResponse",
      actorId: principal.actorId,
      input: command,
    };
    const changed = await rows(
      tx,
      sql`update vertex_research_chat_threads set revision = ${nextRevision}, last_sequence = ${expectedRevision}, updated_at = ${at}, payload = ${json(updated)}, record_hash = ${await ctx.hash(updated)} where ${scopeWhere(scope)} and owner_actor_id = ${principal.actorId} and thread_id = ${threadId} and revision = ${expectedRevision} and last_sequence = ${thread.row["last_sequence"]} and record_hash = ${thread.row["record_hash"]} returning thread_id`
    );
    if (
      changed.length !== 1 ||
      requirePresent(changed[0], "changed[0]")["thread_id"] !== threadId
    )
      return fail("conflict");
    await insert(tx, "vertex_research_chat_messages", scope, {
      owner_actor_id: principal.actorId,
      thread_id: threadId,
      message_id: messageId,
      sequence: expectedRevision,
      recorded_at: at,
      idempotency_key: `append-${responseRequestId}`,
      request: requested,
      request_hash: await ctx.hash(requested),
      payload: message,
      record_hash: await ctx.hash(message),
      response: result,
      response_hash: await ctx.hash(result),
    });
    return result;
  };
  const transcriptBinding = (
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string,
    limit: number,
    position: TranscriptPosition
  ): Promise<string> => {
    return ctx.hash({
      operation: "readTranscriptPage",
      version: 2,
      actorId: principal.actorId,
      scope,
      threadId,
      limit,
      ...position,
    });
  };
  const transcriptPosition = async (
    value: unknown,
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string,
    limit: number
  ): Promise<TranscriptPosition | null> => {
    if (value === null) return null;
    try {
      if (
        typeof value !== "string" ||
        value.length > 4096 ||
        !/^[A-Za-z0-9_-]+$/.test(value)
      )
        return fail("invalid");
      const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
      const decoded = exact(
        JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))),
        [
          "version",
          "operation",
          "binding",
          "after",
          "snapshotRevision",
          "highWaterSequence",
        ]
      );
      const position = {
        after: string(decoded["after"]),
        snapshotRevision: string(decoded["snapshotRevision"]),
        highWaterSequence: string(decoded["highWaterSequence"]),
      };
      const after = ordinal(position.after);
      const snapshot = ordinal(position.snapshotRevision);
      const highWater = sequence(position.highWaterSequence);
      if (
        after.toString() !== position.after ||
        snapshot.toString() !== position.snapshotRevision ||
        highWater.toString() !== position.highWaterSequence ||
        snapshot !== highWater + 1n ||
        after >= highWater
      )
        return fail("invalid");
      const binding = await transcriptBinding(
        principal,
        scope,
        threadId,
        limit,
        position
      );
      if (
        decoded["version"] !== 2 ||
        decoded["operation"] !== "readTranscriptPage" ||
        decoded["binding"] !== binding ||
        transcriptCursor(binding, position) !== value
      )
        return fail("invalid");
      return position;
    } catch {
      return fail("invalid");
    }
  };

  const createResearchChatThread: VertexStore["createResearchChatThread"] =
    async (raw) => {
      exact(raw, [
        "principal",
        "scope",
        "title",
        "participantIds",
        "idempotencyKey",
      ]);
      const { principal, scope, title, participantIds, idempotencyKey } = raw;
      const command = await input("createThread", principal, scope, {
        ...scope,
        title,
        participantIds,
        idempotencyKey,
      });
      const requested = request("createThread", principal, command);
      const requestHash = await ctx.hash(requested);
      const threadId = await threadIdentity(principal, scope, idempotencyKey);
      return ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "publish",
        async (tx, at) => {
          const previous = await one(
            tx,
            "vertex_research_chat_threads",
            scope,
            sql`owner_actor_id = ${principal.actorId} and idempotency_key = ${idempotencyKey}`
          );
          if (previous) {
            if (previous["request_hash"] !== requestHash)
              return fail("conflict");
            return (await verifyThread(previous, principal, scope)).original;
          }
          const result = await checked("ResearchChatThread", {
            ...envelope,
            ...scope,
            threadId,
            title: command["title"],
            participantIds: command["participantIds"],
            ownerActorId: principal.actorId,
            createdAt: at,
            updatedAt: at,
            revision: "1",
          });
          const resultHash = await ctx.hash(result);
          await ctx.ensureAccount(tx, scope, at);
          await insert(tx, "vertex_research_chat_threads", scope, {
            owner_actor_id: principal.actorId,
            thread_id: threadId,
            idempotency_key: idempotencyKey,
            request: requested,
            request_hash: requestHash,
            response: result,
            response_hash: resultHash,
            revision: "1",
            last_sequence: "0",
            created_at: at,
            updated_at: at,
            payload: result,
            record_hash: resultHash,
          });
          return result;
        },
        true
      );
    };

  const readResearchChatThread: VertexStore["readResearchChatThread"] = async (
    principal,
    scope,
    threadId
  ) => {
    await input("readThread", principal, scope, { ...scope, threadId });
    return ctx.run(
      principal,
      scope,
      null,
      "research-chat",
      "read",
      async (tx) => {
        return (
          (await loadThread(tx, principal, scope, threadId))?.current ?? null
        );
      },
      true
    );
  };

  const sendResearchChatMessage: VertexStore["sendResearchChatMessage"] =
    async (raw) => {
      exact(raw, [
        "principal",
        "scope",
        "threadId",
        "expectedRevision",
        "idempotencyKey",
        "body",
        "requestedParticipantIds",
        "mode",
      ]);
      const {
        principal,
        scope,
        threadId,
        expectedRevision,
        idempotencyKey,
        body,
        requestedParticipantIds,
        mode,
      } = raw;
      const command = await input("sendMessage", principal, scope, {
        ...scope,
        threadId,
        expectedRevision,
        idempotencyKey,
        body,
        requestedParticipantIds,
        mode,
      });
      const requested = request("sendMessage", principal, command);
      const requestHash = await ctx.hash(requested);
      return ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "publish",
        async (tx, at) => {
          const thread = await loadThread(tx, principal, scope, threadId);
          // Missing and other owners' IDs have exactly the same result.
          if (!thread) return fail("denied");
          const previous = await one(
            tx,
            "vertex_research_chat_messages",
            scope,
            sql`owner_actor_id = ${principal.actorId} and thread_id = ${threadId} and idempotency_key = ${idempotencyKey}`
          );
          if (previous) {
            if (previous["request_hash"] !== requestHash)
              return fail("conflict");
            return (
              await verifyMessage(previous, principal, scope, thread.current)
            ).acknowledgement;
          }
          if (thread.current["revision"] !== expectedRevision)
            return fail("conflict");
          const selected = array(thread.current["participantIds"], 16);
          if (requestedParticipantIds.some((id) => !selected.includes(id)))
            return fail("invalid");
          if (time(at) < time(thread.current["updatedAt"]))
            return fail("stale");
          const nextRevision = (ordinal(expectedRevision) + 1n).toString();
          ordinal(nextRevision);
          const messageId = await messageIdentity(
            principal,
            scope,
            threadId,
            idempotencyKey
          );
          const message = await checked("ResearchChatMessage", {
            ...envelope,
            threadId,
            messageId,
            sequence: expectedRevision,
            author: { kind: "user", actorId: principal.actorId },
            kind: "statement",
            body: command["body"],
            citations: [],
            recordedAt: at,
          });
          const updated = await checked("ResearchChatThread", {
            ...thread.current,
            revision: nextRevision,
            updatedAt: at,
          });
          const result = await checked("ResearchChatSendMessageOutput", {
            ...envelope,
            message,
            threadRevision: nextRevision,
            response: response(requestedParticipantIds),
          });
          // Existing global authorization -> policy -> account/environment lock order
          // serializes revocation and same-scope writers. The exact CAS additionally
          // rejects a changed head; SQL uniqueness binds each sequence and receipt.
          const changed = await rows(
            tx,
            sql`update vertex_research_chat_threads set revision = ${nextRevision}, last_sequence = ${expectedRevision}, updated_at = ${at}, payload = ${json(updated)}, record_hash = ${await ctx.hash(updated)} where ${scopeWhere(scope)} and owner_actor_id = ${principal.actorId} and thread_id = ${threadId} and revision = ${expectedRevision} and last_sequence = ${thread.row["last_sequence"]} and record_hash = ${thread.row["record_hash"]} returning thread_id`
          );
          if (
            changed.length !== 1 ||
            requirePresent(changed[0], "changed[0]")["thread_id"] !== threadId
          )
            return fail("conflict");
          await insert(tx, "vertex_research_chat_messages", scope, {
            owner_actor_id: principal.actorId,
            thread_id: threadId,
            message_id: messageId,
            sequence: expectedRevision,
            recorded_at: at,
            idempotency_key: idempotencyKey,
            request: requested,
            request_hash: requestHash,
            payload: message,
            record_hash: await ctx.hash(message),
            response: result,
            response_hash: await ctx.hash(result),
          });
          return result;
        },
        true
      );
    };

  const listResearchChatThreads: VertexStore["listResearchChatThreads"] =
    async (principal, scope, raw) => {
      exact(raw, ["limit", "cursor"]);
      const command = await input("listThreads", principal, scope, {
        ...scope,
        ...raw,
      });
      const binding = await ctx.hash({
        operation: "listThreads",
        actorId: principal.actorId,
        scope,
        threadId: null,
        limit: command["limit"],
      });
      const after = cursorPosition(command["cursor"], binding, false);
      return ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "read",
        async (tx) => {
          const candidates = await rows(
            tx,
            sql`select * from "vertex_research_chat_threads" where ${scopeWhere(scope)} and owner_actor_id = ${principal.actorId} ${after === null ? sql`` : sql`and thread_id collate "C" > ${after} collate "C"`} order by thread_id collate "C" asc limit ${raw.limit + 1}`
          );
          if (candidates.length > raw.limit + 1) return fail("integrity");
          const items: VertexRecord[] = [];
          let previous = after;
          for (const row of candidates) {
            const { current } = await verifyThread(row, principal, scope);
            const id = identifier(current["threadId"]);
            if (previous !== null && id <= previous) return fail("integrity");
            previous = id;
            items.push(current);
          }
          const visible = items.slice(0, raw.limit);
          return freeze({
            items: visible,
            nextCursor:
              items.length > raw.limit
                ? cursor(
                    binding,
                    identifier(
                      requirePresent(
                        visible.at(-1),
                        "visible[visible.length - 1]"
                      )["threadId"]
                    )
                  )
                : null,
          });
        },
        true
      );
    };

  const listResearchChatMessages: VertexStore["listResearchChatMessages"] =
    async (principal, scope, threadId, raw) => {
      exact(raw, ["limit", "cursor"]);
      const command = await input("listMessages", principal, scope, {
        ...scope,
        threadId,
        ...raw,
      });
      const binding = await ctx.hash({
        operation: "listMessages",
        actorId: principal.actorId,
        scope,
        threadId,
        limit: command["limit"],
      });
      const after = cursorPosition(command["cursor"], binding, true);
      return ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "read",
        async (tx) => {
          const thread = await loadThread(tx, principal, scope, threadId);
          if (!thread)
            return freeze({
              items: [],
              nextCursor: null,
            } as VertexPage<VertexRecord>);
          const candidates = await rows(
            tx,
            sql`select * from "vertex_research_chat_messages" where ${scopeWhere(scope)} and owner_actor_id = ${principal.actorId} and thread_id = ${threadId} ${after === null ? sql`` : sql`and sequence > ${after}::numeric`} order by sequence asc limit ${raw.limit + 1}`
          );
          if (candidates.length > raw.limit + 1) return fail("integrity");
          const items: VertexRecord[] = [];
          const ids = new Set<string>();
          let previous = after === null ? 0n : ordinal(after);
          for (const row of candidates) {
            const { message } = await verifyHistoricalMessage(
              tx,
              row,
              principal,
              scope,
              thread.current
            );
            const id = identifier(message["messageId"]);
            const current = ordinal(message["sequence"]);
            if (ids.has(id) || current <= previous) return fail("integrity");
            ids.add(id);
            previous = current;
            items.push(message);
          }
          const visible = items.slice(0, raw.limit);
          return freeze({
            items: visible,
            nextCursor:
              items.length > raw.limit
                ? cursor(
                    binding,
                    string(
                      requirePresent(
                        visible.at(-1),
                        "visible[visible.length - 1]"
                      )["sequence"]
                    )
                  )
                : null,
          });
        },
        true
      );
    };

  const readResearchChatTranscriptPage: VertexStore["readResearchChatTranscriptPage"] =
    async (principal, scope, threadId, raw) => {
      exact(raw, ["limit", "cursor"]);
      const command = await input("readTranscriptPage", principal, scope, {
        ...scope,
        threadId,
        ...raw,
      });
      if (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 100)
        return fail("invalid");
      const position = await transcriptPosition(
        command["cursor"],
        principal,
        scope,
        threadId,
        raw.limit
      );
      // Reuse the same owner, read grant and authorization -> policy -> scope
      // lock order as human writes. Capture current head before selecting rows.
      return ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "read",
        async (tx) => {
          const thread = await loadThread(tx, principal, scope, threadId);
          if (!thread) return null;
          const snapshotRevision =
            position?.snapshotRevision ?? string(thread.current["revision"]);
          const highWaterSequence =
            position?.highWaterSequence ?? string(thread.row["last_sequence"]);
          const highWater = sequence(highWaterSequence);
          if (ordinal(thread.current["revision"]) < ordinal(snapshotRevision))
            return fail("invalid");
          const after = position?.after ?? null;
          const candidates = await rows(
            tx,
            sql`select * from "vertex_research_chat_messages" where ${scopeWhere(scope)} and owner_actor_id = ${principal.actorId} and thread_id = ${threadId} and sequence <= ${highWaterSequence}::numeric ${after === null ? sql`` : sql`and sequence > ${after}::numeric`} order by sequence asc limit ${raw.limit + 1}`
          );
          if (candidates.length > raw.limit + 1) return fail("integrity");
          const items: VertexRecord[] = [];
          const ids = new Set<string>();
          let previous = after === null ? 0n : ordinal(after);
          for (const row of candidates) {
            const { message } = await verifyHistoricalMessage(
              tx,
              row,
              principal,
              scope,
              thread.current
            );
            const id = identifier(message["messageId"]);
            const current = ordinal(message["sequence"]);
            // Check the lookahead too: no holes, duplicate rows or rows outside the
            // captured boundary may turn a corrupt transcript into a valid page.
            if (ids.has(id) || current !== previous + 1n || current > highWater)
              return fail("integrity");
            ids.add(id);
            previous = current;
            items.push(message);
          }
          const visible = items.slice(0, raw.limit);
          let nextCursor: string | null = null;
          if (items.length > raw.limit) {
            const next = {
              after: string(
                requirePresent(visible.at(-1), "visible[visible.length - 1]")[
                  "sequence"
                ]
              ),
              snapshotRevision,
              highWaterSequence,
            };
            nextCursor = transcriptCursor(
              await transcriptBinding(
                principal,
                scope,
                threadId,
                raw.limit,
                next
              ),
              next
            );
          } else if (
            previous !== highWater ||
            (visible.length === 0 && highWater !== 0n)
          )
            return fail("integrity");
          // The head is current, never reconstructed from cursor metadata. Only the
          // snapshot boundary survives appends; a null cursor captures latest again.
          return checked("ResearchChatReadTranscriptPageOutput", {
            ...envelope,
            thread: thread.current,
            snapshotRevision,
            highWaterSequence,
            items: visible,
            nextCursor,
          });
        },
        true
      );
    };

  // Shared NEW-request verification only. Original response receipts still win
  // before this helper is called; copy inventory never changes legacy queries.
  const verifyResponsePrefix = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    thread: Readonly<{ current: VertexRecord }>,
    command: VertexRecord,
    at: string,
    captured?: VertexRecord[]
  ): Promise<void> => {
    const {
      threadId,
      parentMessageId,
      participantId,
      snapshotRevision,
      contextStartSequence,
    } = command;
    const snapshot = ordinal(snapshotRevision);
    const start = ordinal(contextStartSequence);
    const count = snapshot - start;
    if (
      snapshot < 2n ||
      count < 1n ||
      count > 16n ||
      snapshot > ordinal(thread.current["revision"])
    )
      return fail("invalid");
    if (!array(thread.current["participantIds"], 16).includes(participantId))
      return fail("invalid");
    const highWater = snapshot - 1n;
    const candidates = await rows(
      tx,
      sql`select * from "vertex_research_chat_messages" where ${scopeWhere(scope)} and owner_actor_id = ${principal.actorId} and thread_id = ${threadId} and sequence >= ${contextStartSequence}::numeric and sequence <= ${highWater.toString()}::numeric order by sequence asc limit 17`
    );
    if (BigInt(candidates.length) !== count) return fail("integrity");
    const ids = new Set<string>();
    let previousSequence = start - 1n;
    let parent: VertexRecord | null = null;
    for (const row of candidates) {
      let message: VertexRecord;
      try {
        message = (await verifyMessage(row, principal, scope, thread.current))
          .message;
      } catch {
        return fail("integrity");
      }
      const current = ordinal(message["sequence"]);
      const id = identifier(message["messageId"]);
      if (
        current !== previousSequence + 1n ||
        current > highWater ||
        ids.has(id)
      )
        return fail("integrity");
      ids.add(id);
      previousSequence = current;
      parent = message;
      captured?.push(message);
    }
    if (previousSequence !== highWater || !parent) return fail("integrity");
    if (parent["messageId"] !== parentMessageId) return fail("invalid");
    if (time(at) < time(thread.current["updatedAt"])) return fail("stale");
  };

  const requestResearchChatResponse: VertexStore["requestResearchChatResponse"] =
    async (raw) => {
      const captured = ctx.capture(raw);
      exact(captured, [
        "principal",
        "scope",
        "threadId",
        "parentMessageId",
        "participantId",
        "snapshotRevision",
        "contextStartSequence",
        "retrievalQuery",
        "idempotencyKey",
      ]);
      const {
        principal,
        scope,
        threadId,
        parentMessageId,
        participantId,
        snapshotRevision,
        contextStartSequence,
        retrievalQuery,
        idempotencyKey,
      } = captured;
      const command = await input("requestResponse", principal, scope, {
        ...scope,
        threadId,
        parentMessageId,
        participantId,
        snapshotRevision,
        contextStartSequence,
        retrievalQuery,
        idempotencyKey,
      });
      const requestHash = await ctx.hash({
        operation: "requestResponse",
        actorId: principal.actorId,
        input: command,
      });
      return ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "publish",
        async (tx, at) => {
          // Publish never implies read. Both checks share the existing revocation
          // lock order; no selected policy/capability resolver is consulted.
          await ctx.authorize(
            principal,
            scope,
            null,
            "research-chat",
            "read",
            at
          );
          const thread = await loadThread(tx, principal, scope, threadId);
          if (!thread) return fail("denied");
          const previous = await responseReceipts.read(
            tx,
            principal,
            scope,
            threadId,
            idempotencyKey
          );
          if (previous) {
            if (
              time(previous["recordedAt"]) < time(thread.current["createdAt"])
            )
              return fail("integrity");
            if (previous["requestSha256"] !== requestHash)
              return fail("conflict");
            // Reconcile an immutable original BEFORE any new prefix/member check.
            // Never reread context or silently retry computation under another key.
            return freeze(previous);
          }
          await verifyResponsePrefix(tx, principal, scope, thread, command, at);
          // Membership includes First Mate. This is only a truthful unavailable
          // receipt, never evidence of corpus admission or First Mate tool execution.
          const metadata = {
            ...scope,
            threadId,
            parentMessageId,
            participantId,
            snapshotRevision,
            contextStartSequence,
            idempotencyKey,
          };
          return freeze(
            await responseReceipts.save(
              tx,
              principal,
              scope,
              metadata,
              requestHash,
              at
            )
          );
        },
        true
      );
    };

  const readResearchChatResponse: VertexStore["readResearchChatResponse"] =
    async (rawPrincipal, rawScope, rawThreadId, rawIdempotencyKey) => {
      const [principal, scope, threadId, idempotencyKey] = ctx.capture([
        rawPrincipal,
        rawScope,
        rawThreadId,
        rawIdempotencyKey,
      ] as const);
      await input("readResponse", principal, scope, {
        ...scope,
        threadId,
        idempotencyKey,
      });
      return ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "read",
        async (tx, at) => {
          const thread = await loadThread(tx, principal, scope, threadId);
          if (!thread) return null;
          const receipt = await responseReceipts.read(
            tx,
            principal,
            scope,
            threadId,
            idempotencyKey
          );
          if (!receipt) return null;
          if (time(receipt["recordedAt"]) < time(thread.current["createdAt"]))
            return fail("integrity");
          // A regressed real clock is an error, never a fabricated checkedAt.
          if (time(at) < time(receipt["recordedAt"])) return fail("stale");
          // This source stage has no trusted terminal delivery projection yet.
          // Preserve the real original admission, without inventing a job/answer.
          return checked("ResearchChatReadResponseOutput", {
            ...envelope,
            checkedAt: at,
            receipt,
            job: null,
            delivery:
              receipt["status"] === "admitted"
                ? {
                    status: "unavailable",
                    reasonCodes: ["projection-unavailable"],
                  }
                : { status: "not-applicable" },
          });
        },
        true
      );
    };

  const copies = createResearchChatCopyOperations(ctx, {
    loadThread,
    verifyResponsePrefix,
    readResponse: responseReceipts.read,
  });
  const operations = {
    listResearchChatThreads,
    createResearchChatThread,
    readResearchChatThread,
    listResearchChatMessages,
    readResearchChatTranscriptPage,
    sendResearchChatMessage,
    requestResearchChatResponse,
    readResearchChatResponse,
    ...copies,
  };
  const executionChatOwner = Object.freeze({
    readResponse: responseReceipts.read,
    readContext: async (
      tx: Transaction,
      principal: VertexPrincipal,
      scope: VertexScope,
      raw: VertexRecord,
      at: string
    ): Promise<readonly VertexRecord[]> => {
      const command = await input("requestResponse", principal, scope, raw);
      await ctx.authorize(principal, scope, null, "research-chat", "read", at);
      const thread = await loadThread(
        tx,
        principal,
        scope,
        identifier(command["threadId"])
      );
      if (!thread) return fail("denied");
      const messages: VertexRecord[] = [];
      await verifyResponsePrefix(
        tx,
        principal,
        scope,
        thread,
        command,
        at,
        messages
      );
      return freeze(messages);
    },
  });
  // Deliberately non-enumerable: the repository's public operation spread does
  // not expose this transaction-bound original-byte reader as a new RPC/port.
  const conversationChatOwner = Object.freeze({
    readThreadForTransaction,
    readReferenceForTransaction,
    appendReferenceForTransaction,
  });
  Object.defineProperty(operations, "executionChatOwner", {
    value: executionChatOwner,
  });
  return Object.defineProperty(operations, "conversationChatOwner", {
    value: conversationChatOwner,
  }) as typeof operations & {
    readonly executionChatOwner: typeof executionChatOwner;
    readonly conversationChatOwner: typeof conversationChatOwner;
  };
};
