import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { lifecycleFixture } from "../../../db/src/server/vertex-research-chat-copy-lifecycle.test-support.ts";
import {
  chatWorkerFixture,
  type PreparedChatFixture,
  type ChatFixtureObserver,
} from "./vertex-research-chat-worker-runtime.test-support.ts";
import {
  LATER,
  SENTINELS,
  owner,
  scope,
  END,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import {
  base64,
  consumeAndStageAdvisory,
  publishAdvisory,
  completeResponse,
  fenceInputs,
  type ConversationFixture,
} from "./vertex-research-chat-conversation-runtime.test-support.ts";
import {
  VertexResearchChatDebateConfigurationV1Schema,
  VertexResearchChatDebateStepInputSchema,
  VertexResearchChatReadDebateRunOutputSchema,
  type VertexResearchChatPublishedPredecessorV1,
} from "../contracts/vertex-research-chat-debate.ts";
import { VertexResearchChatPlanV2Schema } from "../contracts/vertex-research-chat-execution.ts";
import { VertexResearchChatAppendResponseOutputSchema } from "../contracts/vertex-research-chat-conversation.ts";
import { WorkerReadArtifactOutputSchema } from "../contracts/vertex-worker.ts";
import { AcceptedReviewSchema } from "../contracts/vertex-control.ts";
import { researchParityPython } from "./research-python.test-support.ts";
import { scaledTimeout } from "../../../../scripts/lib/test-timeout-scale.ts";

// Source acceptance only: one serial SQL-memory DB and real R2 copy adapter.
// No PostgreSQL isolation/durability, live qualification, provider or model claim.
// Grants/reviews/approvals/admission/model dispatch/staging/publication/fences are
// the original owners. Only historical policy, SQL, object I/O and model are fake.
type DiagnosticStage =
  | "prepare"
  | "consumeStage"
  | "publish"
  | "complete"
  | "fence"
  | "readRun";
export const createDebateDiagnostic = () => {
  // The budget stops a runaway diagnostic run. The five-turn acceptance run
  // makes about 1.4M SQL attempts with the linear predecessor walk;
  // VERTEX_CHAT_DEBATE_DIAGNOSTIC_SQL_BUDGET overrides the default.
  const enabled = process.env["VERTEX_CHAT_DEBATE_DIAGNOSTICS"] === "1",
    started = performance.now(),
    budgetSetting = process.env["VERTEX_CHAT_DEBATE_DIAGNOSTIC_SQL_BUDGET"],
    maximumSqlAttempts =
      budgetSetting === undefined ? 3_000_000 : Number(budgetSetting);
  if (!(Number.isSafeInteger(maximumSqlAttempts) && maximumSqlAttempts > 0))
    throw new Error(
      "VERTEX_CHAT_DEBATE_DIAGNOSTIC_SQL_BUDGET must be a positive integer"
    );
  const stop = Object.assign(
    new Error(
      `Diagnostic stop: ${maximumSqlAttempts} SQL-attempt budget exhausted; not an acceptance result`
    ),
    { name: "DebateDiagnosticBudgetExceeded" }
  );
  const owners: Record<string, number> = {
    locks: 0,
    grants: 0,
    rights: 0,
    policy: 0,
    debate: 0,
    copies: 0,
    execution: 0,
    chatModel: 0,
    conversation: 0,
    worker: 0,
    modelUse: 0,
    artifacts: 0,
    events: 0,
    other: 0,
  };
  const verbs: Record<string, number> = {
    select: 0,
    insert: 0,
    update: 0,
    delete: 0,
    other: 0,
  };
  const copyOperations: Record<string, number> = {
    create: 0,
    inspect: 0,
    read: 0,
    fence: 0,
    other: 0,
  };
  let copyCalls: readonly { operation: string }[] = [],
    copyCursor = 0,
    total = 0,
    ordinal = 0,
    stage: DiagnosticStage = "prepare",
    active = false,
    aborted = false,
    stageSqlStart = 0;
  const emit = (
    event: "begin" | "end" | "snapshot" | "budget-abort" | "finally",
    outcome?: "returned" | "threw"
  ): void => {
    if (!enabled) return;
    for (; copyCursor < copyCalls.length; copyCursor++) {
      const operation = copyCalls[copyCursor]!.operation,
        key = Object.hasOwn(copyOperations, operation) ? operation : "other";
      copyOperations[key] = copyOperations[key]! + 1;
    }
    // Fixed labels/counts only: NEVER query text/parameters, IDs, bodies or errors.
    process.stderr.write(
      `${JSON.stringify({
        diagnostic: "vertex-debate-diagnostic",
        event,
        ordinal,
        stage,
        active,
        ...(outcome ? { outcome } : {}),
        elapsedMs: Math.round(performance.now() - started),
        sql: {
          attempted: total,
          stageAttempted: total - stageSqlStart,
          owners,
          verbs,
        },
        copies: copyOperations,
        budget: { maximumSqlAttempts, aborted },
        ownerEntries: "not-instrumented",
      })}\n`
    );
  };
  const classifyOwner = (query: string): string => {
    if (query.includes("pg_advisory_xact_lock")) return "locks";
    const table =
      /\b(?:from|into|update)\s+"?(vertex_[a-z_0-9]+)"?/i.exec(query)?.[1] ??
      "";
    if (table.startsWith("vertex_grant_")) return "grants";
    if (table.startsWith("vertex_rights")) return "rights";
    if (table.startsWith("vertex_policy_")) return "policy";
    if (
      table.startsWith("vertex_research_chat_debate_") ||
      table === "vertex_research_chat_derived_dependencies"
    )
      return "debate";
    if (table.startsWith("vertex_research_chat_copy_")) return "copies";
    if (
      table.startsWith("vertex_research_chat_execution_") ||
      table.startsWith("vertex_research_chat_storage_")
    )
      return "execution";
    if (table.startsWith("vertex_research_chat_model_")) return "chatModel";
    if (
      table.startsWith("vertex_research_chat_worker_") ||
      table.startsWith("vertex_worker_")
    )
      return "worker";
    if (table.startsWith("vertex_research_chat_")) return "conversation";
    if (table.startsWith("vertex_model_use_")) return "modelUse";
    if (table === "vertex_artifacts" || table === "vertex_records")
      return "artifacts";
    if (table === "vertex_outbox" || table.startsWith("vertex_event"))
      return "events";
    return "other";
  };
  const observeQuery = enabled
    ? (query: { sql: string }): void => {
        if (aborted) throw stop;
        total += 1;
        const ownerClass = classifyOwner(query.sql),
          verb =
            /^\s*(select|insert|update|delete)\b/i
              .exec(query.sql)?.[1]
              ?.toLowerCase() ?? "other";
        owners[ownerClass] = owners[ownerClass]! + 1;
        verbs[verb] = verbs[verb]! + 1;
        if (total % 5000 === 0) emit("snapshot");
        if (total >= maximumSqlAttempts) {
          aborted = true;
          emit("budget-abort");
          throw stop;
        }
      }
    : undefined;
  const run = async <T>(
    nextOrdinal: number,
    nextStage: DiagnosticStage,
    operation: () => Promise<T>
  ): Promise<T> => {
    if (!enabled) return operation();
    if (aborted) throw stop;
    ordinal = nextOrdinal;
    stage = nextStage;
    active = true;
    stageSqlStart = total;
    emit("begin");
    let outcome: "returned" | "threw" = "threw";
    try {
      const value = await operation();
      if (aborted) throw stop;
      outcome = "returned";
      return value;
    } finally {
      active = false;
      emit("end", outcome);
    }
  };
  // Nested measurements are inclusive and never overwrite the enclosing run state.
  const measure: ChatFixtureObserver = (label, operation) => {
    if (!enabled) return operation();
    const sqlStart = total,
      timeStart = performance.now(),
      parent = { ordinal, stage, active };
    const emitSubphase = (
      event: "subphase-begin" | "subphase-end",
      outcome?: "returned" | "threw"
    ): void => {
      process.stderr.write(
        `${JSON.stringify({
          diagnostic: "vertex-debate-diagnostic",
          event,
          ...parent,
          subphase: label,
          ...(outcome ? { outcome } : {}),
          elapsedMs: Math.round(performance.now() - started),
          durationMs: Math.round(performance.now() - timeStart),
          sql: { attempted: total, subphaseAttempted: total - sqlStart },
        })}\n`
      );
    };
    emitSubphase("subphase-begin");
    return (async () => {
      let outcome: "returned" | "threw" = "threw";
      try {
        const value = await operation();
        outcome = "returned";
        return value;
      } finally {
        emitSubphase("subphase-end", outcome);
      }
    })();
  };
  const attachCopies = (calls: readonly { operation: string }[]): void => {
    copyCalls = calls;
  };
  const finish = (): void => {
    emit("finally");
    if (aborted) throw stop;
  };
  return { observeQuery, attachCopies, run, measure, finish };
};

export const debateReviewer = { actorId: "fixture-derived-reviewer" };
export const participants = ["jan-smolen", "ernie-chan"] as const;
const runKey = "finite-two-experts-two-rounds";
const runSelector = (f: { request: { threadId: string } }) => ({
  ...scope,
  threadId: f.request.threadId,
  runKey,
});
export const decodeBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
export const stepPlan = (f: { plan: unknown }) =>
  VertexResearchChatPlanV2Schema.parse(f.plan);
export const readRun = async (
  f: Pick<ConversationFixture, "runtime" | "request">
) =>
  VertexResearchChatReadDebateRunOutputSchema.parse(
    await f.runtime.conversation.readDebateRun(owner, runSelector(f))
  );
export const counters = (f: Pick<ConversationFixture, "table" | "copies">) => ({
  charges: structuredClone(f.table("vertex_research_chat_debate_steps")),
  dispatches: structuredClone(f.table("vertex_research_chat_model_dispatches")),
  modelBudget: structuredClone(f.table("vertex_model_use_budget_reservations")),
  origins: structuredClone(f.table("vertex_research_chat_worker_origins")),
  creates: f.copies.calls.filter((call) => call.operation === "create").length,
});
export const recordDerivedReview = async (
  f: PreparedChatFixture,
  overrides: Record<string, unknown> = {}
) => {
  const debate = f.runtime.debate;
  if (!debate) throw new Error("Concrete derived-use owner absent");
  const plan = stepPlan(f);
  await f.base.grant(
    debateReviewer.actorId,
    debate.reviewResource(plan.responseRequestId),
    ["review"]
  );
  for (const pin of plan.debate.predecessors) {
    await f.base.grant(
      debateReviewer.actorId,
      pin.copyId,
      ["read"],
      plan.collectionId
    );
    await f.base.grant(owner.actorId, await debate.useResource(plan, pin), [
      "publish",
    ]);
  }
  return debate.recordResearchChatDerivedUseReview(debateReviewer, {
    ...scope,
    responseRequestId: plan.responseRequestId,
    planId: plan.planId,
    planSha256: plan.planSha256,
    decision: "accepted",
    expectedReviewId: null,
    expiresAt: plan.expiresAt,
    idempotencyKey: `derived-${plan.responseRequestId}`,
    ...overrides,
  });
};
export const debateFixture = async (
  diagnostic?: ReturnType<typeof createDebateDiagnostic>
) => {
  const measure: ChatFixtureObserver =
    diagnostic?.measure ?? ((_label, operation) => operation());
  const base = await measure("lifecycleSetup", () =>
    lifecycleFixture({
      participantId: participants[0],
      // Debate tests never read the SQL log; see retainQueries in sqlMemory.
      retainQueries: false,
      ...(diagnostic?.observeQuery
        ? { observeQuery: diagnostic.observeQuery }
        : {}),
    })
  );
  diagnostic?.attachCopies(base.copies.calls);
  // Reuse previously issued exact grants, never replace an authorization result.
  // Revoked/expired grants stay revoked/expired: all uses rejoin their real owner.
  const originalGrant = base.grant;
  const grant: typeof originalGrant = async (
    actorId,
    resourceId,
    actions,
    collectionId = null,
    expiresAt = END
  ) => {
    const id = `grant-${await hashArtifact({ actorId, resourceId, actions, collectionId })}`;
    if (
      base.table("vertex_grant_versions").some((row) => row["grant_id"] === id)
    )
      return id;
    return originalGrant(actorId, resourceId, actions, collectionId, expiresAt);
  };
  const second = await base.artifact(
    "second-expert-config",
    {
      ...base.config.value,
      participantId: participants[1],
      participantLabel: "Second Authored Fixture Expert",
      personaText:
        "Synthetic second expert; critique assumptions, not a real persona.",
    },
    "ResearchChatExpertConfiguration"
  );
  const configuration = VertexResearchChatDebateConfigurationV1Schema.parse({
    profile: "vertex-research-chat-debate-configuration-v1",
    ...scope,
    configurationId: "bounded-debate",
    participantIds: participants,
    synthesizerId: participants[1],
    turnTokens: 2000,
    turnCostUsd: "1",
    aggregateTokens: 10_000,
    aggregateCostUsd: "5",
    expiresAt: END,
  });
  const debateConfig = await base.artifact(
    "debate-config",
    configuration,
    "ResearchChatDebateConfiguration"
  );
  const modelUse = await base.artifact(
    "model-use",
    {
      consumer_service_id: "fixture-consumer",
      model_use_policy_version: "1.0.0",
      purpose: "research",
      tokenizer_artifact_id:
        base.config.value["provider"].tokenizerArtifact.artifactId,
      tokenize_grant_id: "chat-tokenize-grant",
      tokenize_grant_version: "1.0.0",
      completion_grant_id: "chat-completion-grant",
      completion_grant_version: "1.0.0",
    },
    "ModelUsePolicy"
  );
  const adapter = await base.artifact(
    "adapter-config",
    {
      profile: "vertex-research-chat-adapter-config-v1",
      provider_configs: [],
      admission_limits: [],
      endpoint_artifact_ids: [
        base.tokenize.pin.artifactId,
        base.completion.pin.artifactId,
      ],
      model_artifact_id: base.descriptor.pin.artifactId,
      model_policy_artifact_id: base.modelPolicy.pin.artifactId,
      model_use_artifact_id: modelUse.pin.artifactId,
      calendar_artifact_ids: [],
    },
    "ResearchChatAdapterConfiguration"
  );
  const selection = {
    ...base.selection,
    artifacts: [
      ...base.selection.artifacts,
      {
        bindingId: "debate-config",
        role: "tool-config" as const,
        artifact: debateConfig.pin,
      },
      {
        bindingId: "model-use",
        role: "tool-config" as const,
        artifact: modelUse.pin,
      },
      {
        bindingId: "adapter-config",
        role: "provider-config" as const,
        artifact: adapter.pin,
      },
    ],
  };
  const experts = [
    { participantId: participants[0], artifact: base.config.pin },
    { participantId: participants[1], artifact: second.pin },
  ];
  const thread = await base.store.createResearchChatThread({
    principal: owner,
    scope,
    title: "Synthetic finite debate",
    participantIds: participants,
    idempotencyKey: "debate-thread",
  });
  const human = await base.store.sendResearchChatMessage({
    principal: owner,
    scope,
    threadId: thread["threadId"] as string,
    expectedRevision: "1",
    idempotencyKey: "debate-human",
    body: SENTINELS.human,
    requestedParticipantIds: [],
    mode: "discuss",
  });
  const humanRequest = {
    ...base.request,
    threadId: thread["threadId"] as string,
    parentMessageId: (human["message"] as { messageId: string }).messageId,
  };
  await grant(debateReviewer.actorId, "account-scope", ["read"]);
  const requestFor = (
    ordinal: number,
    predecessors: readonly VertexResearchChatPublishedPredecessorV1[] = []
  ) =>
    VertexResearchChatDebateStepInputSchema.parse({
      ...humanRequest,
      participantId:
        ordinal === 5
          ? configuration.synthesizerId
          : participants[(ordinal - 1) % 2],
      idempotencyKey: `debate-step-${ordinal}`,
      debate: {
        profile: "vertex-research-chat-debate-step-v1",
        runKey,
        ordinal,
        predecessors,
      },
    });
  const turn = async (
    ordinal: number,
    predecessors: readonly VertexResearchChatPublishedPredecessorV1[] = [],
    onPrepared?: (value: PreparedChatFixture) => Promise<void>
  ) => {
    const request = requestFor(ordinal, predecessors),
      responseRequestId = `response-${await hashArtifact({ operation: "requestResponse", actorId: owner.actorId, scope, threadId: request.threadId, idempotencyKey: request.idempotencyKey })}`;
    await measure("turnContextGrant", () =>
      grant(owner.actorId, `research-chat-context-use:${responseRequestId}`, [
        "publish",
      ])
    );
    await measure("turnStorageReviewGrant", () =>
      grant(
        "fixture-independent-reviewer",
        `research-chat-storage-qualification:${responseRequestId}`,
        ["review"]
      )
    );
    const selector = {
      ...scope,
      threadId: request.threadId,
      responseRequestId,
    };
    const selectedConfig =
      request.participantId === participants[0] ? base.config : second;
    const sharedBase = {
      ...base,
      grant,
      request,
      responseRequestId,
      selector,
      selection,
      config: selectedConfig,
      runtimeOptions: { ...base.runtimeOptions, experts },
      reviewInput: (plan: Record<string, unknown>) => ({
        ...base.reviewInput(plan),
        responseRequestId,
        idempotencyKey: `storage-${responseRequestId}`,
      }),
      grantCleanup: async (
        actorId = "fixture-cleanup",
        expiresAt = "2026-09-25T13:00:00.000000001Z"
      ) => {
        await grant(actorId, "account-scope", ["read"], null, expiresAt);
        await grant(
          actorId,
          `research-chat-copies:${responseRequestId}`,
          ["cleanup-chat-copies"],
          null,
          expiresAt
        );
        return { actorId };
      },
      revokeContext: async () => {
        const grantId = await grant(
          owner.actorId,
          `research-chat-context-use:${responseRequestId}`,
          ["publish"]
        );
        return base.authorization.revokeGrant({
          principal: { actorId: "fixture-grant-admin" },
          grantId,
          scope,
          collectionId: null,
          version: "2.0.0",
          expectedVersion: "1.0.0",
        });
      },
    };
    return chatWorkerFixture({
      // Debate turns widen the parsed request alias; the value is the same scope.
      sharedBase: sharedBase as typeof base,
      admissionPath: "conversation",
      ...(diagnostic ? { observeOperation: diagnostic.measure } : {}),
      debate: {
        configuration: debateConfig.pin,
        reviewerActorId: debateReviewer.actorId,
      },
      onPrepared: async (value) => {
        const prior = counters({ ...base, copies: base.copies });
        expect(prior.charges).toHaveLength(ordinal - 1);
        expect(prior.dispatches).toHaveLength(2 * (ordinal - 1));
        expect(
          base
            .table("vertex_research_chat_execution_approvals")
            .some((row) => row["response_request_id"] === responseRequestId)
        ).toBe(false);
        expect(prior.creates).toBe(4 * (ordinal - 1));
        if (onPrepared) {
          await onPrepared(value);
          return;
        }
        await recordDerivedReview(value);
      },
    });
  };
  const prepare = async (
    ordinal: number,
    predecessors: readonly VertexResearchChatPublishedPredecessorV1[] = []
  ): Promise<PreparedChatFixture> => {
    const boundary = new Error(
      "Fixture intentionally stopped before exact approval"
    );
    let prepared: PreparedChatFixture | undefined;
    try {
      await turn(ordinal, predecessors, async (value) => {
        prepared = value;
        throw boundary;
      });
    } catch (error) {
      if (error !== boundary) throw error;
    }
    if (!prepared) throw new Error("Actual prepare boundary was not reached");
    return prepared;
  };
  return { base, configuration, requestFor, turn, prepare };
};
export const nativeOutput = async (f: ConversationFixture) => {
  const copies: Record<string, string> = {};
  for (const name of ["context", "tokenizeInput", "completionInput"] as const) {
    const value = WorkerReadArtifactOutputSchema.parse(
      await f.worker.invoke(f.identity, "readArtifact", {
        ...f.fence,
        collectionId: null,
        artifactId: f.recipe.copies[name].copyId,
      })
    );
    copies[name] = value.contentBase64;
  }
  const artifacts: Record<string, string> = {};
  for (const { artifact } of f.selection.artifacts) {
    const value = [...f.objects.values()].find(
      (entry) => entry.id === artifact.artifactId
    );
    if (!value)
      throw new Error(
        `Original selected fixture bytes absent: ${artifact.artifactId}`
      );
    expect(await hashArtifact(value.body)).toBe(artifact.artifactSha256);
    artifacts[artifact.artifactId] = base64(value.body);
  }
  const queued = f
    .table("vertex_records")
    .find(
      (row) => row["artifact_id"] === f.recipe.execution.queuedRun.artifactId
    );
  if (!queued) throw new Error("Original queued AgentRun absent");
  const review = AcceptedReviewSchema.parse(f.corpusReview);
  const root = resolve(import.meta.dirname, "../../../.."),
    research = resolve(root, "services/research");
  const python = researchParityPython;
  const body = {
    action: "consume",
    recipe: f.recipe,
    lease: f.lease,
    selection: f.selection,
    artifacts,
    copies,
    queuedRunBase64: base64(
      new TextEncoder().encode(canonicalArtifactJson(queued["payload"]))
    ),
    originalEvidenceBase64: base64(f.corpus.body),
    acceptedReview: review,
    nowNs: timestampToEpochNanoseconds(f.state.at).toString(),
  };
  const output = execFileSync(
    python,
    [resolve(research, "adapters/tests/chat_debate_bridge.py")],
    {
      cwd: research,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPATH: [
          research,
          ...[
            "market-data",
            "control-client",
            "host",
            "gateway",
            "execution",
          ].map((name) => resolve(root, "services", name)),
        ].join(":"),
      },
      input: JSON.stringify(body),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  const result = JSON.parse(output);
  expect(result.outcome).toMatchObject({
    status: "completed",
    outputArtifactIds: [f.plan.runId],
    executionAuthorized: false,
  });
  expect(
    result.sentBodies.map((sent: { bodyBase64: string }) => sent.bodyBase64)
  ).toEqual([copies["tokenizeInput"], copies["completionInput"]]);
  expect(result.controlMethods).toContain("stageArtifact");
  expect(result.controlMethods).toContain("publishAgent");
  expect(result.publicationRequests).toHaveLength(1);
  return {
    responseBytes: decodeBase64(result.responseBase64),
    retainedBytes: decodeBase64(result.retainedBase64),
    result,
  };
};
export const finishTurn = async (f: ConversationFixture, native = false) => {
  const advisory = await consumeAndStageAdvisory(
    f,
    native ? () => nativeOutput(f) : undefined
  );
  await publishAdvisory(f, advisory);
  await completeResponse(f);
  const cleaner = await fenceInputs(f);
  const row = f
    .table("vertex_research_chat_threads")
    .find((value) => value["thread_id"] === f.request.threadId);
  if (!row) throw new Error("Original thread absent");
  const appended = VertexResearchChatAppendResponseOutputSchema.parse(
    await f.runtime.conversation.appendResponse(owner, {
      ...f.selector,
      expectedRevision: row["revision"],
    })
  );
  if (appended.status !== "appended")
    throw new Error("Actual publication/fence eligible reference absent");
  return { ...f, advisory, cleaner, appended };
};

export const TIMEOUT = scaledTimeout(180_000);
export const pending = (f: PreparedChatFixture) =>
  f.runtime.conversation.approveAndRequestDebateStep(owner, f.approveInput);
export const unchanged = (f: PreparedChatFixture) => counters(f.base);
export const nextPins = async (
  f: Parameters<typeof readRun>[0]
): Promise<readonly VertexResearchChatPublishedPredecessorV1[]> => {
  const run = await readRun(f);
  if (run.status !== "available" || run.nextStep === null)
    throw new Error("Actual completed predecessor selection unavailable");
  return run.nextStep.predecessors;
};

// Each loss finishes three full real-owner turns (minutes each), so every loss
// is registered from its own test file and runs in a parallel vitest worker.
export const rechecksAncestorLoss = (
  loss: "ancestor-cleanup" | "ancestor-expiry" | "current-rights"
) =>
  it(
    `rechecks ${loss} through the full ancestor chain and blocks dependent approval`,
    async () => {
      const scenario = await debateFixture();
      const first = await finishTurn(
        await scenario.turn(1, [], (prepared) =>
          recordDerivedReview(
            prepared,
            loss === "ancestor-expiry" ? { expiresAt: LATER } : {}
          ).then(() => undefined)
        )
      );
      const second = await finishTurn(
        await scenario.turn(2, await nextPins(first))
      );
      const prepared = await scenario.prepare(3, await nextPins(second));
      await recordDerivedReview(prepared);
      if (loss === "ancestor-cleanup") {
        await first.revokeContext();
        await first.runtime.drainApprovedCopyCleanup(
          first.cleaner,
          first.selector
        );
      } else if (loss === "ancestor-expiry") {
        scenario.base.state.at = LATER;
      } else {
        const rights = first.corpus.metadata.rights;
        scenario.base.state.at = LATER;
        await first.store.putRights(
          { actorId: "fixture-grant-admin" },
          scope,
          "corpus",
          {
            ...rights,
            version: "2.0.0",
            status: "expired",
            checkedAt: LATER,
            expiresAt: LATER,
          }
        );
      }
      const before = unchanged(prepared);
      expect(await pending(prepared)).toMatchObject({
        status: "blocked",
      });
      expect(unchanged(prepared)).toEqual(before);
      expect(
        await second.runtime.conversation.readResponseContent(owner, {
          ...second.selector,
          messageId: second.appended.message.messageId,
        })
      ).toMatchObject({ status: "unavailable" });
      return expect(
        await second.store.readResearchChatTranscriptPage(
          owner,
          scope,
          second.request.threadId,
          { limit: 100, cursor: null }
        )
      ).toMatchObject({
        items: [
          { sequence: "1" },
          { kind: "advisory-reference" },
          { kind: "advisory-reference" },
        ],
      });
    },
    // Two finished turns plus a third prepare: three full real-owner turns.
    3 * TIMEOUT
  );
