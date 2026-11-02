import { sql } from "drizzle-orm";
import type { Transaction } from "@darkfactory/db/server";
import {
  VertexStoreError,
  type VertexPrincipal,
  type VertexRecord,
} from "@darkfactory/db/server/vertex";
import { canonicalArtifactJson } from "@darkfactory/shared/vertex";
import {
  digestString,
  fail,
  identifier,
  object,
  one,
  string,
  time,
  type PersistenceContext,
} from "@darkfactory/db/server/vertex-research-chat-runtime";
import { createResearchChatOperations } from "@darkfactory/db/server/vertex-research-chat-runtime";
import type {
  createResearchChatExecutionOperations,
  createResearchChatDebateOperations,
  ResearchChatSourceInputs,
} from "@darkfactory/db/server/vertex-research-chat-runtime";
import type { createResearchChatCopyLifecycle } from "@darkfactory/db/server/vertex-research-chat-runtime";
import type { ResearchChatWorkerOperations } from "@darkfactory/db/server/vertex-research-chat-runtime";
import {
  VertexResearchChatPrepareResponseInputSchema,
  VertexResearchChatPrepareResponseOutputSchema,
  VertexResearchChatApproveAndRequestResponseInputSchema,
  VertexResearchChatApproveAndRequestResponseOutputSchema,
  VertexResearchChatAppendResponseInputSchema,
  VertexResearchChatAppendResponseOutputSchema,
  VertexResearchChatReadResponseContentInputSchema,
  VertexResearchChatReadResponseContentOutputSchema,
  VertexResearchChatAdvisoryOutputProfileSchema,
  VertexResearchChatExecutionPrepareOutputSchema,
  VertexResearchChatDebatePrepareOutputSchema,
  VertexResearchChatNativeEvidencePrepareOutputSchema,
} from "../contracts/vertex-research-chat-conversation.ts";
import {
  VertexResearchChatReadResponseInputSchema,
  VertexResearchChatReadResponseOutputSchema,
  VertexResearchChatResponseReceiptSchema,
  type VertexResearchChatResponseReasonCode,
} from "../contracts/vertex-research-chat-response.ts";
import {
  VertexResearchChatExecutionPlanSchema,
  VertexResearchChatExecutionApprovalSchema,
  VertexResearchChatExecutionRequestSchema,
  VertexResearchChatExecutionApproveSchema,
} from "../contracts/vertex-research-chat-execution.ts";
import {
  VertexResearchChatDebateStepInputSchema,
  VertexResearchChatDebateApproveInputSchema,
  VertexResearchChatReadDebateRunInputSchema,
  VertexResearchChatReadDebateRunOutputSchema,
  VertexResearchChatPublishedPredecessorV1Schema,
} from "../contracts/vertex-research-chat-debate.ts";
import {
  VertexResearchChatNativeEvidenceRequestSchema,
  VertexResearchChatNativeEvidenceApproveInputSchema,
} from "../contracts/vertex-research-chat-native-evidence.ts";
import { VertexResearchChatAgentReferenceMessageSchema } from "../contracts/vertex-research-chat.ts";
import { parseVertexResearchChatHumanContextV1 } from "../contracts/vertex-research-chat-context.ts";
import type { VertexResearchChatOutputRuntime } from "./vertex-research-chat-output-runtime.ts";
import { present } from "./present.ts";

type Scope = Readonly<{ accountAlias: string; environment: "research" }>;
type Execution = ReturnType<typeof createResearchChatExecutionOperations>;
type Copies = ReturnType<typeof createResearchChatCopyLifecycle>;
type Caller = Awaited<
  ReturnType<
    VertexResearchChatOutputRuntime["conversationCallerForTransaction"]
  >
>;
type Eligible = NonNullable<
  Awaited<
    ReturnType<
      VertexResearchChatOutputRuntime["conversationEligibilityForTransaction"]
    >
  >
>;
const envelope = {
  schemaVersion: "1.0.0",
  executionAuthorized: false,
} as const;
const same = (a: unknown, b: unknown): boolean =>
  canonicalArtifactJson(a) === canonicalArtifactJson(b);
const scopeOf = (
  value: Readonly<{ accountAlias: string; environment: "research" }>
): Scope =>
  Object.freeze({
    accountAlias: identifier(value.accountAlias),
    environment: "research",
  });
const minimum = (...values: readonly string[]): string =>
  values.reduce((a, b) => (time(a) <= time(b) ? a : b));
const timestamp = (value: string): string => {
  const nanoseconds = BigInt(value),
    milliseconds = nanoseconds / 1_000_000n;
  if (nanoseconds < 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER))
    return fail("integrity");
  const result = new Date(Number(milliseconds))
    .toISOString()
    .replace(
      /\.\d{3}Z$/u,
      `.${(nanoseconds % 1_000_000_000n).toString().padStart(9, "0")}Z`
    );
  if (time(result) !== nanoseconds) return fail("integrity");
  return result;
};
const artifact = (raw: unknown) => {
  const value = object(raw);
  return {
    artifactId: identifier(value["artifactId"]),
    artifactSha256: digestString(value["artifactSha256"]),
  };
};
const hardError = (error: unknown): boolean =>
  error instanceof VertexStoreError &&
  ["invalid", "integrity", "conflict"].includes(error.code);
const unavailableReason = (
  error: unknown,
  otherwise: VertexResearchChatResponseReasonCode
): VertexResearchChatResponseReasonCode =>
  error instanceof VertexStoreError && error.code === "stale"
    ? "deadline"
    : otherwise;
const checked = <T>(
  schema: Readonly<{ parse: (value: unknown) => T }>,
  value: unknown
): T => {
  const original = value;
  try {
    const parsed = schema.parse(original);
    return parsed;
  } catch {
    return fail("integrity");
  }
};
const jsonBytes = (bytes: Uint8Array): unknown => {
  const original = bytes;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(original);
    return JSON.parse(text) as unknown;
  } catch {
    return fail("integrity");
  }
};

// Programmatic concrete-owner composition. Construction performs no I/O, grant,
// approval, dispatch or worker invocation. Only this bounded leaf enters RPC.
export const createVertexResearchChatConversationRuntime = (
  ctx: PersistenceContext,
  execution: Execution,
  copies: Copies,
  worker: ResearchChatWorkerOperations,
  output: VertexResearchChatOutputRuntime,
  debate?: ReturnType<typeof createResearchChatDebateOperations>
) => {
  const chat = createResearchChatOperations(ctx);
  const history = chat.conversationChatOwner;
  const receiptOwner = chat.executionChatOwner;
  const principalOf = (raw: VertexPrincipal): VertexPrincipal => {
    const principal = ctx.capture(raw);
    if (Object.keys(principal).length !== 1) return fail("invalid");
    return Object.freeze({ actorId: identifier(principal.actorId) });
  };
  const current = (
    startedAt: string,
    caller: Caller,
    originalEnd?: string
  ): void => {
    const at = time(ctx.now());
    if (at < time(startedAt) || at < time(caller.checkedAt)) fail("stale");
    if (at >= time(caller.expiresAt)) fail("denied");
    if (originalEnd && at >= time(originalEnd)) fail("stale");
  };
  const threadForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: Scope,
    threadId: string
  ) => {
    const thread = await history.readThreadForTransaction(
      tx,
      principal,
      scope,
      threadId
    );
    if (
      !thread ||
      thread.current["ownerActorId"] !== principal.actorId ||
      thread.current["threadId"] !== threadId
    )
      return fail("denied");
    return thread;
  };
  const callerForThread = async (
    principal: VertexPrincipal,
    scope: Scope,
    threadId: string,
    publish: boolean,
    expected?: Caller
  ) => {
    const startedAt = ctx.now();
    const caller = await ctx.run(
      principal,
      scope,
      null,
      "research-chat",
      publish ? "publish" : "read",
      async (tx, at) => {
        await threadForTransaction(tx, principal, scope, threadId);
        return output.conversationCallerForTransaction(
          tx,
          principal,
          scope,
          at,
          publish,
          expected
        );
      },
      true
    );
    current(startedAt, caller);
    return caller;
  };
  // Error-only metadata observer: the caller gate is never evidence of original
  // authority loss. The existing owner independently verifies the historical
  // original and commits closure only for a genuine global loss, even if the
  // caller read/publish check failed. Invalid/integrity failures still propagate.
  const observeOriginal = async (
    principal: VertexPrincipal,
    scope: Scope,
    responseRequestId: string
  ): Promise<void> => {
    const originalId = responseRequestId;
    try {
      await output.observeDeniedOwnerRead(principal, scope, originalId);
    } catch (error) {
      if (hardError(error)) throw error;
    }
  };
  const selectorOf = (
    request: Readonly<{
      accountAlias: string;
      environment: "research";
      threadId: string;
      idempotencyKey: string;
    }>
  ) =>
    VertexResearchChatReadResponseInputSchema.parse({
      ...scopeOf(request),
      threadId: request.threadId,
      idempotencyKey: request.idempotencyKey,
    });
  const responseIdentity = (
    principal: VertexPrincipal,
    scope: Scope,
    threadId: string,
    idempotencyKey: string
  ) =>
    ctx
      .hash({
        operation: "requestResponse",
        actorId: principal.actorId,
        scope,
        threadId,
        idempotencyKey,
      })
      .then((hash) => `response-${hash}`);
  const readPlanForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: Scope,
    responseRequestId: string
  ) => {
    const row = await one(
      tx,
      "vertex_research_chat_execution_plans",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!row) return null;
    const plan = checked(VertexResearchChatExecutionPlanSchema, row["payload"]),
      { planId, planSha256, ...body } = plan;
    if (
      (await ctx.hash(plan)) !== row["record_hash"] ||
      (await ctx.hash(body)) !== planSha256 ||
      planId !== `chat-plan-${planSha256}` ||
      plan.accountAlias !== scope.accountAlias ||
      plan.environment !== scope.environment ||
      plan.ownerActorId !== principal.actorId ||
      plan.responseRequestId !== responseRequestId ||
      row["response_request_id"] !== responseRequestId ||
      row["owner_actor_id"] !== principal.actorId ||
      row["thread_id"] !== plan.threadId ||
      row["idempotency_key"] !== plan.idempotencyKey ||
      row["request_sha256"] !== plan.requestSha256 ||
      row["plan_id"] !== planId ||
      row["plan_sha256"] !== planSha256
    )
      return fail("integrity");
    return plan;
  };
  const prepare = async (rawPrincipal: VertexPrincipal, raw: unknown) => {
    const principal = principalOf(rawPrincipal),
      request = VertexResearchChatExecutionRequestSchema.parse(
        ctx.capture(raw)
      ),
      scope = scopeOf(request),
      selector = selectorOf(request),
      startedAt = ctx.now();
    const caller = await callerForThread(
      principal,
      scope,
      request.threadId,
      true
    );
    try {
      const planned = await execution.planResearchChatResponse(
        principal,
        request
      );
      const result = await execution.withSourceInputs(
        principal,
        request,
        "preview",
        (sourceInputs) =>
          ctx.run(
            principal,
            scope,
            null,
            "research-chat",
            "publish",
            async (tx, at) => {
              const original = await execution.readPlannedForTransaction(
                tx,
                principal,
                request,
                at,
                sourceInputs
              );
              try {
                const plan = checked(
                    VertexResearchChatExecutionPlanSchema,
                    original.plan
                  ),
                  contextBytes = original.prepared.context;
                if (
                  plan.planId !== planned["planId"] ||
                  plan.planSha256 !== planned["planSha256"] ||
                  !same(original.request, request)
                )
                  return fail("integrity");
                const context = checked(
                  { parse: parseVertexResearchChatHumanContextV1 },
                  jsonBytes(contextBytes)
                );
                for (const purpose of [
                  "context",
                  "tokenizeInput",
                  "completionInput",
                ] as const) {
                  const bytes = original.prepared[purpose];
                  if (
                    bytes.byteLength !== plan[purpose].byteLength ||
                    (await ctx.digest(bytes)) !== plan[purpose].sha256
                  )
                    return fail("integrity");
                }
                if (
                  plan.format === "vertex-research-chat-native-evidence-plan-v1"
                ) {
                  const bundle = original.prepared.evidenceBundle;
                  if (
                    !bundle ||
                    bundle.byteLength !==
                      plan.nativeEvidence.bundle.byteLength ||
                    (await ctx.digest(bundle)) !==
                      plan.nativeEvidence.bundle.sha256
                  )
                    return fail("integrity");
                }
                if (
                  context.owner_actor_id !== principal.actorId ||
                  context.response_request_id !== plan.responseRequestId ||
                  context.thread_id !== request.threadId ||
                  context.parent_message_id !== request.parentMessageId ||
                  context.snapshot_revision !== request.snapshotRevision ||
                  context.start_sequence !== request.contextStartSequence ||
                  context.participant_config_sha256 !==
                    plan.participantConfiguration.artifactSha256
                )
                  return fail("integrity");
                const tokenize = original.tokenizeEndpoint,
                  complete = original.completionEndpoint,
                  destination = new URL(string(complete["origin"]));
                if (
                  destination.protocol !== "https:" ||
                  destination.origin !== complete["origin"] ||
                  tokenize["origin"] !== complete["origin"] ||
                  destination.username ||
                  destination.password ||
                  destination.search ||
                  destination.hash
                )
                  return fail("integrity");
                const retention = original.retentionPolicy,
                  storage = original.storageEvidence,
                  readNotAfter = timestamp(original.notAfterNs);
                const finalCaller =
                  await output.conversationCallerForTransaction(
                    tx,
                    principal,
                    scope,
                    ctx.now(),
                    true,
                    caller
                  );
                const checkedAt = ctx.now(),
                  notAfter = minimum(readNotAfter, finalCaller.expiresAt);
                const value = checked(
                  VertexResearchChatExecutionPrepareOutputSchema,
                  {
                    ...envelope,
                    status: "prepared",
                    preview: {
                      responseRequestId: plan.responseRequestId,
                      planId: plan.planId,
                      planSha256: plan.planSha256,
                      request,
                      ...(plan.format === "vertex-research-chat-plan-v2"
                        ? { debate: plan.debate }
                        : {}),
                      ...(plan.format ===
                      "vertex-research-chat-native-evidence-plan-v1"
                        ? { nativeEvidence: plan.nativeEvidence }
                        : {}),
                      context: {
                        messageIds: context.messages.map(
                          (message) => message.message_id
                        ),
                        snapshotRevision: context.snapshot_revision,
                        contextStartSequence: context.start_sequence,
                        highWaterSequence: context.high_water_sequence,
                        messageCount: context.messages.length,
                        ...plan.context,
                      },
                      expert: {
                        participantId: plan.participantId,
                        configurationSha256:
                          plan.participantConfiguration.artifactSha256,
                        modelVersion: plan.provider.modelVersion,
                      },
                      inputs: {
                        tokenizeInput: plan.tokenizeInput,
                        completionInput: plan.completionInput,
                      },
                      corpus: {
                        collectionId: plan.collectionId,
                        snapshotId: plan.snapshotId,
                        reviewPins: plan.reviewPins,
                      },
                      model: {
                        providerId: plan.provider.providerId,
                        modelVersion: plan.provider.modelVersion,
                        servedModel: plan.provider.servedModel,
                        modelPolicySha256: plan.inputPolicy.modelPolicySha256,
                        destination: {
                          scheme: "https",
                          hostname: destination.hostname,
                          port: destination.port,
                        },
                        tokenizeEndpoint: {
                          ...artifact(plan.provider.tokenizeEndpoint),
                          endpointId: identifier(tokenize["endpoint_id"]),
                        },
                        completionEndpoint: {
                          ...artifact(plan.provider.completionEndpoint),
                          endpointId: identifier(complete["endpoint_id"]),
                        },
                      },
                      retention: {
                        policyId: retention["policyId"],
                        policyVersion: retention["policyVersion"],
                        artifact: artifact(plan.retentionArtifact),
                        rules: retention["rules"],
                        ...(plan.format ===
                        "vertex-research-chat-native-evidence-plan-v1"
                          ? {
                              nativeIntermediatePurposes:
                                retention["nativeIntermediatePurposes"],
                            }
                          : {}),
                        earlierCleanupTriggers:
                          retention["earlierCleanupTriggers"],
                        readNotAfter,
                        guaranteedDeletionDeadline: null,
                      },
                      storage: {
                        storageProfileSha256: plan.storageProfileSha256,
                        backendDeploymentId: plan.backendDeploymentId,
                        evidence: artifact(plan.storageEvidence),
                        namespace: storage["namespace"],
                        createSemantics: storage["createSemantics"],
                        readSemantics: storage["readSemantics"],
                        fenceSemantics: storage["fenceSemantics"],
                        retainedVersions: storage["retainedVersions"],
                        claimScope: storage["claimScope"],
                        excludedClaims: storage["excludedClaims"],
                      },
                      checkedAt,
                      notAfter,
                    },
                  }
                );
                current(checkedAt, finalCaller, notAfter);
                return { value, caller: finalCaller, notAfter, checkedAt };
              } finally {
                for (const purpose of [
                  "context",
                  "tokenizeInput",
                  "completionInput",
                  "evidenceBundle",
                ] as const)
                  original.prepared[purpose]?.fill(0);
              }
            },
            true
          )
      );
      current(result.checkedAt, result.caller, result.notAfter);
      return result.value;
    } catch (error) {
      if (hardError(error)) throw error;
      const finalCaller = await callerForThread(
        principal,
        scope,
        request.threadId,
        true,
        caller
      );
      const value = checked(VertexResearchChatExecutionPrepareOutputSchema, {
        ...envelope,
        status: "unavailable",
        selector,
        reasonCodes: [
          unavailableReason(error, "model-input-preparation-unavailable"),
        ],
      });
      current(startedAt, finalCaller);
      return value;
    }
  };
  const approve = async (rawPrincipal: VertexPrincipal, raw: unknown) => {
    const principal = principalOf(rawPrincipal),
      input = VertexResearchChatExecutionApproveSchema.parse(ctx.capture(raw)),
      request = input.request,
      scope = scopeOf(request),
      selector = selectorOf(request),
      startedAt = ctx.now();
    const requestSha256 = await ctx.hash({
      operation: "requestResponse",
      actorId: principal.actorId,
      input: request,
    });
    const caller = await callerForThread(
      principal,
      scope,
      request.threadId,
      true
    );
    const reconcile = async () => {
      let observedCaller = caller;
      const found = await ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "publish",
        async (tx, _at) => {
          await threadForTransaction(tx, principal, scope, request.threadId);
          const receipt = await receiptOwner.readResponse(
            tx,
            principal,
            scope,
            request.threadId,
            request.idempotencyKey
          );
          if (receipt) {
            if (receipt["requestSha256"] !== requestSha256)
              return fail("conflict");
            const plan = await readPlanForTransaction(
              tx,
              principal,
              scope,
              identifier(receipt["responseRequestId"])
            );
            if (
              plan &&
              (plan.planId !== input.planId ||
                plan.planSha256 !== input.planSha256 ||
                plan.requestSha256 !== requestSha256 ||
                plan.threadId !== request.threadId)
            )
              return fail("conflict");
            if (receipt["status"] === "admitted" && !plan)
              return fail("integrity");
          }
          const finalCaller = await output.conversationCallerForTransaction(
            tx,
            principal,
            scope,
            ctx.now(),
            true,
            caller
          );
          observedCaller = finalCaller;
          const value = receipt
            ? checked(VertexResearchChatApproveAndRequestResponseOutputSchema, {
                ...envelope,
                status: "recorded",
                selector,
                receipt: checked(
                  VertexResearchChatResponseReceiptSchema,
                  receipt
                ),
              })
            : null;
          current(startedAt, finalCaller);
          return value;
        },
        true
      );
      current(startedAt, observedCaller);
      return found;
    };
    const old = await reconcile();
    if (old) return old;
    let stage: "approval" | "copies" | "admission" = "approval";
    try {
      await execution.approveResearchChatResponse(principal, input);
      stage = "copies";
      await copies.writeApprovedInputs(principal, input);
      stage = "admission";
      await worker.admitApprovedResponse(principal, input);
      const recorded = await reconcile();
      if (recorded) return recorded;
      return VertexResearchChatApproveAndRequestResponseOutputSchema.parse({
        ...envelope,
        status: "unknown",
        selector,
        reasonCodes: ["outcome-unknown"],
      });
    } catch (error) {
      if (
        hardError(error) &&
        !(error instanceof VertexStoreError && error.code === "conflict")
      )
        throw error;
      // Inspect the ORIGINAL key once; do not retry approval, copy IO, admission
      // or provider work. A recovered immutable unavailable receipt stays so.
      let recovered: Awaited<ReturnType<typeof reconcile>>;
      try {
        recovered = await reconcile();
      } catch (reconciliationError) {
        if (
          hardError(reconciliationError) ||
          (reconciliationError instanceof VertexStoreError &&
            reconciliationError.code === "denied")
        )
          throw reconciliationError;
        return VertexResearchChatApproveAndRequestResponseOutputSchema.parse({
          ...envelope,
          status: "unknown",
          selector,
          reasonCodes: ["outcome-unknown"],
        });
      }
      if (recovered) return recovered;
      // A concurrent identical call may have committed the receipt before the
      // private approval/admission owner noticed it. Only that exact receipt
      // resolves its conflict; changed request/plan pins still reject above.
      if (error instanceof VertexStoreError && error.code === "conflict")
        throw error;
      if (
        stage === "approval" &&
        error instanceof VertexStoreError &&
        ["denied", "stale"].includes(error.code)
      )
        return VertexResearchChatApproveAndRequestResponseOutputSchema.parse({
          ...envelope,
          status: "blocked",
          selector,
          reasonCodes: [
            unavailableReason(error, "model-input-approval-unavailable"),
          ],
        });
      return VertexResearchChatApproveAndRequestResponseOutputSchema.parse({
        ...envelope,
        status: "unknown",
        selector,
        reasonCodes: ["outcome-unknown"],
      });
    }
  };
  const referenceDraft = async (source: Eligible): Promise<VertexRecord> => {
    const plan = source.joined.plan,
      origin = source.joined.origin;
    return {
      ...envelope,
      threadId: plan["threadId"],
      author: {
        kind: "agent",
        participantId: plan["participantId"],
        runId: plan["runId"],
      },
      kind: "advisory-reference",
      replyToMessageId: plan["parentMessageId"],
      response: {
        responseRequestId: plan["responseRequestId"],
        planId: plan["planId"],
        planSha256: plan["planSha256"],
        requestSha256: plan["requestSha256"],
        contextSha256: object(plan["context"])["sha256"],
        snapshotRevision: plan["snapshotRevision"],
        contextStartSequence: plan["contextStartSequence"],
        jobId: origin["jobId"],
        traceId: plan["traceId"],
        eventId: origin["eventId"],
        runArtifact: source.publication.artifact,
        advisoryArtifact: source.publication.advisory,
        fenceAcknowledgementsSha256: await ctx.hash(
          source.inputFenceAcknowledgements
        ),
      },
    };
  };
  const matchesReference = async (
    source: Eligible,
    raw: unknown
  ): Promise<void> => {
    const message = checked(VertexResearchChatAgentReferenceMessageSchema, raw),
      { messageId, sequence, parentMessageId, recordedAt, ...draft } = message;
    if (!same(draft, await referenceDraft(source))) return fail("integrity");
  };
  const sameEligibility = (before: Eligible, after: Eligible): void => {
    const unchanged =
      same(before.metadata, after.metadata) &&
      same(before.joined.plan, after.joined.plan) &&
      same(before.joined.approval, after.joined.approval) &&
      same(before.joined.origin, after.joined.origin) &&
      same(before.publication, after.publication) &&
      same(before.inputFenceAcknowledgements, after.inputFenceAcknowledgements);
    if (!unchanged) fail("integrity");
  };
  const appendResponse = async (
    rawPrincipal: VertexPrincipal,
    raw: unknown
  ) => {
    const principal = principalOf(rawPrincipal),
      input = VertexResearchChatAppendResponseInputSchema.parse(
        ctx.capture(raw)
      ),
      scope = scopeOf(input),
      { expectedRevision, ...selector } = input,
      startedAt = ctx.now();
    let insertionStarted = false;
    let invocationCaller: Caller | undefined;
    try {
      const result = await ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "publish",
        async (tx, at) => {
          const caller = await output.conversationCallerForTransaction(
            tx,
            principal,
            scope,
            at,
            true
          );
          invocationCaller = caller;
          await threadForTransaction(tx, principal, scope, input.threadId);
          const previous = await history.readReferenceForTransaction(
            tx,
            principal,
            scope,
            {
              threadId: input.threadId,
              responseRequestId: input.responseRequestId,
            }
          );
          if (previous) {
            const finalCaller = await output.conversationCallerForTransaction(
              tx,
              principal,
              scope,
              ctx.now(),
              true,
              caller
            );
            const value = checked(
              VertexResearchChatAppendResponseOutputSchema,
              previous.acknowledgement
            );
            current(startedAt, finalCaller);
            return { value, caller: finalCaller, expiresAt: null };
          }
          const source = await output.conversationEligibilityForTransaction(
            tx,
            principal,
            scope,
            input.responseRequestId,
            ctx.now()
          );
          if (!source) {
            const finalCaller = await output.conversationCallerForTransaction(
              tx,
              principal,
              scope,
              ctx.now(),
              true,
              caller
            );
            const value = VertexResearchChatAppendResponseOutputSchema.parse({
              ...envelope,
              status: "unavailable",
              selector,
              reasonCodes: ["projection-unavailable"],
            });
            return { value, caller: finalCaller, expiresAt: null };
          }
          if (source.joined.plan["threadId"] !== input.threadId)
            return fail("conflict");
          const draft = await referenceDraft(source);
          insertionStarted = true;
          const appended = await history.appendReferenceForTransaction(
            tx,
            principal,
            scope,
            {
              threadId: input.threadId,
              responseRequestId: input.responseRequestId,
              expectedRevision,
            },
            draft,
            ctx.now()
          );
          const after = await output.conversationEligibilityForTransaction(
            tx,
            principal,
            scope,
            input.responseRequestId,
            ctx.now()
          );
          if (!after) return fail("stale");
          sameEligibility(source, after);
          await matchesReference(after, appended["message"]);
          const finalCaller = await output.conversationCallerForTransaction(
            tx,
            principal,
            scope,
            ctx.now(),
            true,
            caller
          );
          const expiresAt = minimum(source.expiresAt, after.expiresAt);
          const value = checked(
            VertexResearchChatAppendResponseOutputSchema,
            appended
          );
          current(startedAt, finalCaller, expiresAt);
          return { value, caller: finalCaller, expiresAt };
        },
        true
      );
      current(startedAt, result.caller, result.expiresAt ?? undefined);
      return result.value;
    } catch (error) {
      await observeOriginal(principal, scope, input.responseRequestId);
      if (
        hardError(error) ||
        (error instanceof VertexStoreError && error.code === "denied")
      )
        throw error;
      const finalCaller = await callerForThread(
        principal,
        scope,
        input.threadId,
        true,
        invocationCaller
      );
      const value = insertionStarted
        ? checked(VertexResearchChatAppendResponseOutputSchema, {
            ...envelope,
            status: "unknown",
            selector,
            reasonCodes: ["outcome-unknown"],
          })
        : checked(VertexResearchChatAppendResponseOutputSchema, {
            ...envelope,
            status: "unavailable",
            selector,
            reasonCodes: [unavailableReason(error, "projection-unavailable")],
          });
      current(startedAt, finalCaller);
      return value;
    }
  };
  const readResponseContent = async (
    rawPrincipal: VertexPrincipal,
    raw: unknown
  ) => {
    const principal = principalOf(rawPrincipal),
      input = VertexResearchChatReadResponseContentInputSchema.parse(
        ctx.capture(raw)
      ),
      scope = scopeOf(input),
      startedAt = ctx.now();
    let bytes: Uint8Array | undefined;
    let invocationCaller: Caller | undefined;
    let sourceInputs: ResearchChatSourceInputs | undefined;
    try {
      const before = await ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "read",
        async (tx, at) => {
          const caller = await output.conversationCallerForTransaction(
            tx,
            principal,
            scope,
            at,
            false
          );
          invocationCaller = caller;
          const reference = await history.readReferenceForTransaction(
            tx,
            principal,
            scope,
            {
              threadId: input.threadId,
              responseRequestId: input.responseRequestId,
              messageId: input.messageId,
            }
          );
          if (!reference) return fail("denied");
          const source = await output.conversationEligibilityForTransaction(
            tx,
            principal,
            scope,
            input.responseRequestId,
            ctx.now()
          );
          if (source) await matchesReference(source, reference.message);
          const finalCaller = await output.conversationCallerForTransaction(
            tx,
            principal,
            scope,
            ctx.now(),
            false,
            caller
          );
          current(startedAt, finalCaller, source?.expiresAt);
          return {
            reference: checked(
              VertexResearchChatAgentReferenceMessageSchema,
              reference.message
            ),
            source,
            caller: finalCaller,
          };
        },
        true
      );
      current(startedAt, before.caller, before.source?.expiresAt);
      if (!before.source) {
        const value = checked(
          VertexResearchChatReadResponseContentOutputSchema,
          {
            ...envelope,
            status: "unavailable",
            reference: before.reference,
            checkedAt: ctx.now(),
            reasonCodes: ["projection-unavailable"],
          }
        );
        current(startedAt, before.caller);
        return value;
      }
      // Actual governed copy owner performs external IO OUTSIDE our SQL locks.
      // Its completed read is never delivery authority: the original/reference,
      // complete publication, three ACKs and exact caller are rejoined below.
      sourceInputs = await output.prepareSourceInputsForPlan(
        principal,
        scope,
        before.source.joined.plan,
        "private-content"
      );
      bytes = sourceInputs
        ? await output.readAdvisory(
            principal,
            scope,
            input.responseRequestId,
            sourceInputs
          )
        : await copies.readAdvisory(principal, scope, input.responseRequestId);
      const hash = await ctx.digest(bytes),
        profile = checked(
          VertexResearchChatAdvisoryOutputProfileSchema,
          jsonBytes(bytes)
        );
      const canonical = new TextEncoder().encode(
        canonicalArtifactJson(profile)
      );
      try {
        const identical =
          canonical.byteLength === bytes.byteLength &&
          canonical.every((value, index) => value === present(bytes)[index]);
        if (
          !identical ||
          bytes.byteLength !== before.source.metadata.byteLength ||
          hash !== before.source.metadata.contentSha256 ||
          profile.modelUseRequestSha256 !==
            before.source.metadata["modelUseRequestSha256"] ||
          profile.responseSha256 !== before.source.metadata["responseSha256"] ||
          profile.taskContract !== before.source.joined.plan["taskContract"] ||
          profile.modelVersion !==
            object(before.source.joined.plan["provider"])["modelVersion"]
        )
          return fail("integrity");
        if (
          before.source.joined.plan["format"] ===
          "vertex-research-chat-native-evidence-plan-v1"
            ? profile.profile !==
              "vertex-research-chat-native-evidence-advisory-v1"
            : before.source.joined.plan["format"] ===
                "vertex-research-chat-plan-v2"
              ? profile.profile !== "vertex-research-chat-advisory-v2" ||
                !same(profile.debate, before.source.joined.plan["debate"])
              : profile.profile !== "vertex-research-chat-advisory-v1"
        )
          return fail("integrity");
      } finally {
        canonical.fill(0);
      }
      const byteLength = bytes.byteLength;
      const after = await ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "read",
        async (tx, at) => {
          const reference = await history.readReferenceForTransaction(
            tx,
            principal,
            scope,
            {
              threadId: input.threadId,
              responseRequestId: input.responseRequestId,
              messageId: input.messageId,
            }
          );
          if (!(reference && same(reference.message, before.reference)))
            return fail("integrity");
          const source = await output.conversationEligibilityForTransaction(
            tx,
            principal,
            scope,
            input.responseRequestId,
            at
          );
          if (source) {
            sameEligibility(present(before.source), source);
            await matchesReference(source, reference.message);
          }
          const caller = await output.conversationCallerForTransaction(
            tx,
            principal,
            scope,
            ctx.now(),
            false,
            before.caller
          );
          const sourceUse = source
            ? await output.recheckSourceInputsForPlan(
                tx,
                principal,
                source.joined.plan,
                sourceInputs,
                ctx.now()
              )
            : null;
          const checkedAt = ctx.now(),
            notAfter = source
              ? minimum(
                  present(before.source).expiresAt,
                  source.expiresAt,
                  caller.expiresAt,
                  ...(sourceUse ? [sourceUse.expiresAt] : [])
                )
              : null;
          const value =
            source && notAfter
              ? checked(VertexResearchChatReadResponseContentOutputSchema, {
                  ...envelope,
                  status: "available",
                  reference: reference.message,
                  checkedAt,
                  notAfter,
                  profile,
                  sha256: hash,
                  byteLength,
                })
              : checked(VertexResearchChatReadResponseContentOutputSchema, {
                  ...envelope,
                  status: "unavailable",
                  reference: reference.message,
                  checkedAt,
                  reasonCodes: ["projection-unavailable"],
                });
          current(checkedAt, caller, notAfter ?? undefined);
          return { value, caller, notAfter, checkedAt };
        },
        true
      );
      // No await on the success path after the final transaction/frozen DTO.
      current(after.checkedAt, after.caller, after.notAfter ?? undefined);
      return after.value;
    } catch (error) {
      await observeOriginal(principal, scope, input.responseRequestId);
      if (hardError(error) || !invocationCaller) throw error;
      // Errors never carry a stale body; re-read only historical metadata and
      // current caller authority to provide an honest unavailable projection.
      const unavailable = await ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "read",
        async (tx, _at) => {
          const reference = await history.readReferenceForTransaction(
            tx,
            principal,
            scope,
            {
              threadId: input.threadId,
              responseRequestId: input.responseRequestId,
              messageId: input.messageId,
            }
          );
          if (!reference) return fail("denied");
          const caller = await output.conversationCallerForTransaction(
            tx,
            principal,
            scope,
            ctx.now(),
            false,
            invocationCaller
          );
          const value = checked(
            VertexResearchChatReadResponseContentOutputSchema,
            {
              ...envelope,
              status: "unavailable",
              reference: reference.message,
              checkedAt: ctx.now(),
              reasonCodes: [unavailableReason(error, "projection-unavailable")],
            }
          );
          current(startedAt, caller);
          return { value, caller };
        },
        true
      );
      current(startedAt, unavailable.caller);
      return unavailable.value;
    } finally {
      bytes?.fill(0);
      if (sourceInputs) output.disposeSourceInputs(sourceInputs.token);
    }
  };
  // Historical job projection does not renew original authority. It remains
  // useful after answer expiry, while current eligibility is a separate join.
  const jobForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: Scope,
    receipt: VertexRecord
  ) => {
    const responseRequestId = identifier(receipt["responseRequestId"]);
    const plan = await readPlanForTransaction(
      tx,
      principal,
      scope,
      responseRequestId
    );
    const approvalRow = await one(
      tx,
      "vertex_research_chat_execution_approvals",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!(plan && approvalRow)) return fail("integrity");
    const approval = checked(
      VertexResearchChatExecutionApprovalSchema,
      approvalRow["payload"]
    );
    if (
      plan.format === "vertex-research-chat-native-evidence-plan-v1"
        ? approval.format !==
            "vertex-research-chat-native-evidence-approval-v1" ||
          approval.nativeEvidenceSha256 !==
            (await ctx.hash(plan.nativeEvidence)) ||
          approval.consent !== "approve-bounded-native-evidence-protocol-v1"
        : plan.format === "vertex-research-chat-plan-v2"
          ? approval.format !== "vertex-research-chat-approval-v2" ||
            approval.debateSha256 !== (await ctx.hash(plan.debate))
          : approval.format !== "vertex-research-chat-approval-v1"
    )
      return fail("integrity");
    if (
      (await ctx.hash(approval)) !== approvalRow["record_hash"] ||
      approvalRow["owner_actor_id"] !== principal.actorId ||
      approvalRow["plan_id"] !== plan.planId ||
      approvalRow["plan_sha256"] !== plan.planSha256 ||
      approvalRow["storage_review_id"] !== approval.storageReviewId
    )
      return fail("integrity");
    for (const key of [
      "accountAlias",
      "environment",
      "ownerActorId",
      "responseRequestId",
      "threadId",
      "parentMessageId",
      "participantId",
      "snapshotRevision",
      "contextStartSequence",
      "idempotencyKey",
      "requestSha256",
      "planId",
      "planSha256",
    ] as const)
      if (approval[key] !== plan[key]) return fail("integrity");
    const row = await one(
      tx,
      "vertex_research_chat_worker_origins",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!row) return fail("integrity");
    const origin = object(row["payload"]);
    if (
      (await ctx.hash(origin)) !== row["record_hash"] ||
      row["record_hash"] !== object(receipt["admission"])["bindingSha256"] ||
      origin["profile"] !== "vertex-research-chat-worker-origin-v1" ||
      origin["accountAlias"] !== scope.accountAlias ||
      origin["environment"] !== scope.environment ||
      origin["responseRequestId"] !== responseRequestId ||
      origin["ownerActorId"] !== principal.actorId ||
      plan.ownerActorId !== principal.actorId ||
      plan.threadId !== receipt["threadId"] ||
      origin["requestSha256"] !== receipt["requestSha256"] ||
      origin["requestSha256"] !== plan.requestSha256 ||
      origin["planId"] !== plan.planId ||
      origin["planSha256"] !== plan.planSha256 ||
      origin["approvalSha256"] !== approvalRow["record_hash"] ||
      origin["runId"] !== plan.runId ||
      origin["traceId"] !== plan.traceId ||
      origin["recipeSha256"] !== (await ctx.hash(origin["recipe"])) ||
      origin["jobId"] !==
        `job-${await ctx.hash({ scope, eventId: origin["eventId"] })}`
    )
      return fail("integrity");
    for (const [key, expected] of Object.entries({
      response_request_id: responseRequestId,
      owner_actor_id: principal.actorId,
      plan_id: plan.planId,
      plan_sha256: plan.planSha256,
      run_id: origin["runId"],
      event_id: origin["eventId"],
      job_id: origin["jobId"],
      recipe_sha256: origin["recipeSha256"],
    }))
      if (row[key] !== expected) return fail("integrity");
    const event = await one(
      tx,
      "vertex_outbox",
      scope,
      sql`event_id = ${origin["eventId"]}`
    );
    const queued = await one(
      tx,
      "vertex_records",
      scope,
      sql`artifact_id = ${origin["runArtifactId"]} and contract_name = 'AgentRun'`
    );
    if (
      !(event && queued) ||
      event["record_hash"] !== origin["eventSha256"] ||
      (await ctx.hash(event["payload"])) !== origin["eventSha256"] ||
      queued["record_hash"] !== origin["runSha256"] ||
      queued["artifact_sha256"] !== origin["runSha256"] ||
      (await ctx.hash(queued["payload"])) !== origin["runSha256"] ||
      object(queued["payload"])["runId"] !== plan.runId ||
      object(queued["payload"])["status"] !== "queued" ||
      (await ctx.hash(object(event["payload"])["payload"])) !==
        origin["runSha256"]
    )
      return fail("integrity");
    const job = await one(
      tx,
      "vertex_worker_jobs",
      scope,
      sql`job_id = ${origin["jobId"]}`
    );
    if (!job) return null;
    const lease = object(job["payload"]),
      stable = {
        kind: lease["kind"],
        researchPrincipalId: lease["researchPrincipalId"],
        payloadArtifactId: lease["payloadArtifactId"],
        payloadSha256: lease["payloadSha256"],
        policySelectionId: lease["policySelectionId"],
        policySelectionSha256: lease["policySelectionSha256"],
        deadlineAt: lease["deadlineAt"],
      };
    if (
      lease["jobId"] !== job["job_id"] ||
      lease["eventId"] !== origin["eventId"] ||
      job["event_id"] !== origin["eventId"] ||
      lease["accountAlias"] !== scope.accountAlias ||
      lease["environment"] !== scope.environment ||
      lease["kind"] !== "research-run" ||
      lease["researchPrincipalId"] !== principal.actorId ||
      lease["payloadArtifactId"] !== origin["recipeArtifactId"] ||
      lease["payloadSha256"] !== origin["recipeSha256"] ||
      lease["policySelectionId"] !== plan.selectionId ||
      lease["policySelectionSha256"] !== plan.selectionSha256 ||
      lease["deadlineAt"] !== plan.expiresAt ||
      lease["leaseId"] !== job["lease_id"] ||
      lease["leaseEpoch"] !== job["lease_epoch"] ||
      time(lease["leaseExpiresAt"]).toString() !== job["lease_expires_at_ns"] ||
      time(lease["deadlineAt"]).toString() !== job["deadline_at_ns"] ||
      (await ctx.hash({ scope, eventId: origin["eventId"], ...stable })) !==
        job["binding_hash"]
    )
      return fail("integrity");
    if (
      ![
        "leased",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "unknown",
      ].includes(string(job["state"]))
    )
      return fail("integrity");
    if (
      job["outcome_hash"] !== null ||
      ["succeeded", "failed"].includes(string(job["state"]))
    )
      digestString(job["outcome_hash"]);
    return { jobId: identifier(job["job_id"]), state: string(job["state"]) };
  };
  const readResponse = async (rawPrincipal: VertexPrincipal, raw: unknown) => {
    const principal = principalOf(rawPrincipal),
      input = VertexResearchChatReadResponseInputSchema.parse(ctx.capture(raw)),
      scope = scopeOf(input),
      startedAt = ctx.now();
    const responseRequestId = await responseIdentity(
      principal,
      scope,
      input.threadId,
      input.idempotencyKey
    );
    try {
      const result = await ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "read",
        async (tx, at) => {
          const caller = await output.conversationCallerForTransaction(
            tx,
            principal,
            scope,
            at,
            false
          );
          const thread = await threadForTransaction(
            tx,
            principal,
            scope,
            input.threadId
          );
          const receipt = await receiptOwner.readResponse(
            tx,
            principal,
            scope,
            input.threadId,
            input.idempotencyKey
          );
          if (!receipt) {
            const finalCaller = await output.conversationCallerForTransaction(
              tx,
              principal,
              scope,
              ctx.now(),
              false,
              caller
            );
            current(startedAt, finalCaller);
            return { value: null, caller: finalCaller, eligibleEnd: undefined };
          }
          if (
            time(receipt["recordedAt"]) < time(thread.current["createdAt"]) ||
            time(receipt["recordedAt"]) > time(at)
          )
            return fail("integrity");
          let job: Awaited<ReturnType<typeof jobForTransaction>> = null;
          let delivery: VertexRecord = { status: "not-applicable" };
          let eligibleEnd: string | undefined;
          if (receipt["status"] === "admitted") {
            job = await jobForTransaction(tx, principal, scope, receipt);
            const reference = await history.readReferenceForTransaction(
              tx,
              principal,
              scope,
              { threadId: input.threadId, responseRequestId }
            );
            if (reference) {
              if (job?.state !== "succeeded") return fail("integrity");
              delivery = {
                status: "appended",
                message: {
                  messageId: reference.message["messageId"],
                  sequence: reference.message["sequence"],
                  threadRevision: reference.acknowledgement["threadRevision"],
                },
              };
            } else if (
              !job ||
              job.state === "leased" ||
              job.state === "running"
            ) {
              const original = await worker.derivedForTransaction(
                tx,
                scope,
                { responseRequestId },
                ctx.now()
              );
              delivery =
                original && !original.closed
                  ? { status: "pending" }
                  : { status: "unavailable", reasonCodes: ["policy-revoked"] };
            } else if (job.state === "succeeded") {
              const source = await output.conversationEligibilityForTransaction(
                tx,
                principal,
                scope,
                responseRequestId,
                ctx.now()
              );
              delivery = source
                ? { status: "eligible" }
                : {
                    status: "unavailable",
                    reasonCodes: ["projection-unavailable"],
                  };
              eligibleEnd = source?.expiresAt;
            } else {
              delivery = {
                status: "unavailable",
                reasonCodes: [
                  job.state === "failed"
                    ? "worker-failed"
                    : job.state === "cancelled"
                      ? "cancelled"
                      : "outcome-unknown",
                ],
              };
            }
          }
          const finalCaller = await output.conversationCallerForTransaction(
            tx,
            principal,
            scope,
            ctx.now(),
            false,
            caller
          );
          const value = checked(VertexResearchChatReadResponseOutputSchema, {
            ...envelope,
            checkedAt: ctx.now(),
            receipt,
            job,
            delivery,
          });
          current(startedAt, finalCaller, eligibleEnd);
          return { value, caller: finalCaller, eligibleEnd };
        },
        true
      );
      current(
        result.value?.checkedAt ?? result.caller.checkedAt,
        result.caller,
        result.eligibleEnd
      );
      return result.value;
    } catch (error) {
      await observeOriginal(principal, scope, responseRequestId);
      throw error;
    }
  };
  const prepareResponse = async (principal: VertexPrincipal, raw: unknown) =>
    checked(
      VertexResearchChatPrepareResponseOutputSchema,
      await prepare(
        principal,
        VertexResearchChatPrepareResponseInputSchema.parse(raw)
      )
    );
  const prepareDebateStep = async (principal: VertexPrincipal, raw: unknown) =>
    checked(
      VertexResearchChatDebatePrepareOutputSchema,
      await prepare(
        principal,
        VertexResearchChatDebateStepInputSchema.parse(raw)
      )
    );
  const approveAndRequestResponse = (
    principal: VertexPrincipal,
    raw: unknown
  ) =>
    approve(
      principal,
      VertexResearchChatApproveAndRequestResponseInputSchema.parse(raw)
    );
  const approveAndRequestDebateStep = (
    principal: VertexPrincipal,
    raw: unknown
  ) =>
    approve(principal, VertexResearchChatDebateApproveInputSchema.parse(raw));
  const prepareResearchChatNativeEvidence = async (
    principal: VertexPrincipal,
    raw: unknown
  ) =>
    checked(
      VertexResearchChatNativeEvidencePrepareOutputSchema,
      await prepare(
        principal,
        VertexResearchChatNativeEvidenceRequestSchema.parse(raw)
      )
    );
  const approveAndRequestResearchChatNativeEvidence = (
    principal: VertexPrincipal,
    raw: unknown
  ) =>
    approve(
      principal,
      VertexResearchChatNativeEvidenceApproveInputSchema.parse(raw)
    );
  const readDebateRun = async (rawPrincipal: VertexPrincipal, raw: unknown) => {
    const principal = principalOf(rawPrincipal),
      selector = VertexResearchChatReadDebateRunInputSchema.parse(raw),
      scope = scopeOf(selector);
    return await ctx.run(
      principal,
      scope,
      null,
      "research-chat",
      "read",
      async (tx, at) => {
        await threadForTransaction(tx, principal, scope, selector.threadId);
        const caller = await output.conversationCallerForTransaction(
          tx,
          principal,
          scope,
          at,
          false
        );
        const missing = () =>
          VertexResearchChatReadDebateRunOutputSchema.parse({
            ...envelope,
            status: "unavailable",
            selector,
            checkedAt: ctx.now(),
          });
        if (!debate) return missing();
        const stored = await debate.readRunForTransaction(
          tx,
          principal,
          scope,
          selector.threadId,
          selector.runKey
        );
        if (!stored) return missing();
        const { run, steps: originals } = stored,
          predecessors: ReturnType<
            typeof VertexResearchChatPublishedPredecessorV1Schema.parse
          >[] = [],
          steps: {
            ordinal: unknown;
            kind: unknown;
            participantId: unknown;
            responseRequestId: unknown;
            idempotencyKey: unknown;
            planId: unknown;
            planSha256: unknown;
            state: unknown;
          }[] = [];
        let notAfter = minimum(caller.expiresAt, string(run["expiresAt"])),
          ready = true,
          chargedTokens = 0n,
          chargedUsdUnits = 0n;
        for (const { charge, plan } of originals) {
          const step = object(plan["debate"]);
          steps.push({
            ordinal: charge["ordinal"],
            kind: step["kind"],
            participantId: plan["participantId"],
            responseRequestId: plan["responseRequestId"],
            idempotencyKey: plan["idempotencyKey"],
            planId: plan["planId"],
            planSha256: plan["planSha256"],
            state: charge["state"],
          });
          chargedTokens += BigInt(string(charge["chargedTokens"]));
          chargedUsdUnits += BigInt(string(charge["chargedUsdUnits"]));
          const source = await output.conversationEligibilityForTransaction(
            tx,
            principal,
            scope,
            identifier(plan["responseRequestId"]),
            ctx.now()
          );
          if (!source) {
            ready = false;
            continue;
          }
          present(steps.at(-1)).state = "spent";
          notAfter = minimum(notAfter, source.expiresAt);
          if (Number(step["ordinal"]) < 5) {
            const copy = source.joined.inventory.copies.find(
              (entry) => entry.allocation.copyId === source.metadata.copyId
            );
            if (!copy) return fail("integrity");
            const pin = VertexResearchChatPublishedPredecessorV1Schema.parse({
              ordinal: step["ordinal"],
              participantId: plan["participantId"],
              responseRequestId: plan["responseRequestId"],
              planId: plan["planId"],
              planSha256: plan["planSha256"],
              runId: plan["runId"],
              copyId: source.metadata.copyId,
              reservationSha256: copy.allocation.reservationSha256,
              contentSha256: source.metadata.contentSha256,
              byteLength: source.metadata.byteLength,
              publishedAt: source.publication.publishedAt,
            });
            const rechecked =
              await output.readPublishedPredecessorForTransaction(
                tx,
                principal,
                scope,
                pin,
                ctx.now()
              );
            notAfter = minimum(notAfter, rechecked.expiresAt);
            predecessors.push(pin);
          }
        }
        const finalCaller = await output.conversationCallerForTransaction(
          tx,
          principal,
          scope,
          ctx.now(),
          false,
          caller
        );
        notAfter = minimum(notAfter, finalCaller.expiresAt);
        if (time(ctx.now()) >= time(notAfter)) return missing();
        const value = VertexResearchChatReadDebateRunOutputSchema.parse({
          ...envelope,
          status: "available",
          selector,
          debateRunId: run["debateRunId"],
          participantIds: run["participantIds"],
          synthesizerId: run["synthesizerId"],
          configuration: run["configuration"],
          humanWindowSha256: run["humanWindowSha256"],
          collectionId: run["collectionId"],
          snapshotId: run["snapshotId"],
          turnTokens: run["turnTokens"],
          turnCostUsd: run["turnCostUsd"],
          aggregateTokens: run["aggregateTokens"],
          aggregateCostUsd: run["aggregateCostUsd"],
          chargedTokens: chargedTokens.toString(),
          chargedUsdUnits: chargedUsdUnits.toString(),
          steps,
          nextStep:
            ready && originals.length < 5
              ? {
                  profile: "vertex-research-chat-debate-step-v1",
                  runKey: selector.runKey,
                  ordinal: originals.length + 1,
                  predecessors,
                }
              : null,
          complete: ready && originals.length === 5,
          checkedAt: ctx.now(),
          notAfter,
        });
        current(at, finalCaller, notAfter);
        return value;
      },
      true
    );
  };
  return Object.freeze({
    prepareResponse,
    approveAndRequestResponse,
    prepareDebateStep,
    approveAndRequestDebateStep,
    prepareResearchChatNativeEvidence,
    approveAndRequestResearchChatNativeEvidence,
    readDebateRun,
    appendResponse,
    readResponseContent,
    readResponse,
    readFirstMateAdvisoryConfiguration:
      execution.readFirstMateAdvisoryConfiguration,
  });
};
export type VertexResearchChatConversationService = ReturnType<
  typeof createVertexResearchChatConversationRuntime
>;
