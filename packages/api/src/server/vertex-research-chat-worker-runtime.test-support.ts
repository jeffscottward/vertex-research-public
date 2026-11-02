import { createVertexStore } from "@darkfactory/db/server/vertex";
import { createVertexWorkerStore } from "@darkfactory/db/server/vertex-worker";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import {
  vertexQualifiedObjectKey,
  type VertexObjectCapabilities,
} from "@darkfactory/storage";
import { lifecycleFixture } from "../../../db/src/server/vertex-research-chat-copy-lifecycle.test-support.ts";
import {
  BEFORE,
  SENTINELS,
  owner,
  reviewer,
  scope,
  AT,
  END,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import { extendChatWorkerSql } from "./vertex-research-chat-worker-sql.test-support.ts";
import {
  createVertexResearchChatExecutionRuntime,
  type VertexResearchChatExecutionRuntimeOptions,
} from "./vertex-research-chat-execution-runtime.ts";
import { createVertexRuntimePolicy } from "./vertex-runtime-policy.ts";
import { createVertexRuntimeModelUse } from "./vertex-runtime-model-use.ts";
import { createVertexRuntimeRecipes } from "./vertex-runtime-recipes.ts";
import { vertexPersistenceBoundary } from "./vertex-experience-adapter.ts";
import {
  VERTEX_WORKER_CONTRACT_SCHEMAS,
  WorkerLeaseSchema,
  WorkerResultSchema,
  WorkerServiceGrantSchema,
} from "../contracts/vertex-worker.ts";
import {
  computeRuntimePolicySelectionHash,
  parseRuntimePolicySelection,
  RuntimeComponentEvidenceSchema,
} from "../contracts/vertex-policy.ts";
import {
  computeModelUseRequestHash,
  ModelUseGrantSchema,
  ModelUseRequestSchema,
  ModelUseProofSchema,
  parseModelUseRequest,
  type ModelUseRequest,
} from "../contracts/vertex-model-use.ts";
import { AgentRunSchema, EventEnvelopeSchema } from "../contracts/vertex.ts";
import {
  VertexResearchChatParticipantConfigurationV1Schema,
  VertexResearchChatStorageReviewInputSchema,
} from "../contracts/vertex-research-chat-execution.ts";
import { VertexResearchChatResponseReceiptSchema } from "../contracts/vertex-research-chat-response.ts";
import { VertexResearchChatApproveAndRequestResponseOutputSchema } from "../contracts/vertex-research-chat-conversation.ts";
import { ResearchChatRecipeSchema } from "./vertex-runtime-recipe-profiles.ts";
import type { ChatModelPrivacyReviewInput } from "./vertex-research-chat-model-privacy.ts";
import { ChatModelPrivacyReviewInputSchema } from "../contracts/vertex-model-privacy-rendezvous.ts";
import {
  VertexResearchChatExecutionPlanSchema,
  VertexResearchChatExecutionRequestSchema,
  VertexResearchChatExecutionApproveSchema,
  VertexResearchChatExecutionApprovalSchema,
} from "../contracts/vertex-research-chat-execution.ts";
import { VertexResearchChatExecutionPrepareOutputSchema } from "../contracts/vertex-research-chat-conversation.ts";
import { nativeHistoricalInputs } from "./native-evidence.test-support.ts";
import {
  RESEARCH_CHAT_NATIVE_EVIDENCE_PROTOCOL,
  RESEARCH_CHAT_NATIVE_EVIDENCE_CONSENT,
  RESEARCH_CHAT_NATIVE_EVIDENCE_SERIALIZER,
} from "../contracts/vertex-research-chat-native-evidence.ts";
import { mutableClone } from "./mutable-clone.test-support.ts";

export type PreparedChatFixture = Readonly<{
  base: Awaited<ReturnType<typeof lifecycleFixture>>;
  runtime: ReturnType<typeof createVertexResearchChatExecutionRuntime>;
  request: ReturnType<typeof VertexResearchChatExecutionRequestSchema.parse>;
  plan: ReturnType<typeof VertexResearchChatExecutionPlanSchema.parse>;
  approveInput: ReturnType<
    typeof VertexResearchChatExecutionApproveSchema.parse
  >;
  prepared: ReturnType<
    typeof VertexResearchChatExecutionPrepareOutputSchema.parse
  > | null;
}>;

export type ChatFixtureOperation =
  | "lifecycleSetup"
  | "turnContextGrant"
  | "turnStorageReviewGrant"
  | "previewPrepare"
  | "storageReview"
  | "onPrepared"
  | "approvalAdmission"
  | "resolveBinding"
  | "bindOutbox"
  | "admitRun"
  | "missingReviewProbe"
  | "derivedReview"
  | "alteredPlanProbe"
  | "readContextArtifact"
  | "readCompletionArtifact";
export type ChatFixtureObserver = <T>(
  label: ChatFixtureOperation,
  operation: () => Promise<T>
) => Promise<T>;

const encode = (value: unknown) =>
  new TextEncoder().encode(canonicalArtifactJson(value));
const admin = { actorId: "fixture-grant-admin" };
export const chatWorkerFixture = async (
  fixtureOptions: Readonly<{
    nativeEvidence?: boolean | "bounded-budget";
    rendezvous?: boolean;
    rightsObservation?: boolean;
    rendezvousConfigMutation?: "wrong-profile" | "extra-field";
    frozenRightsAtExecution?: boolean;
    omitServiceOperation?:
      | "stageArtifact"
      | "publishAgent"
      | "complete"
      | "prepareModelPrivacyReview"
      | "readModelPrivacyReview"
      | "currentRightsObservation"
      | "acceptedEvidenceObservation"
      | "prepareNativeEvidencePhaseTwo";
    omitOutputOwner?: boolean;
    corpusReviewExpiresAt?: string;
    storageReviewExpiresAt?: string;
    participantId?: string;
    admissionPath?: "private" | "conversation";
    sharedBase?: Awaited<ReturnType<typeof lifecycleFixture>>;
    debate?: VertexResearchChatExecutionRuntimeOptions["debate"];
    onPrepared?: (value: PreparedChatFixture) => Promise<void>;
    observeOperation?: ChatFixtureObserver;
  }> = {}
) => {
  const observe: ChatFixtureObserver =
    fixtureOptions.observeOperation ?? ((_label, operation) => operation());
  if (fixtureOptions.rightsObservation && !fixtureOptions.rendezvous) {
    throw new Error("Observation fixture requires explicit rendezvous profile");
  }
  if (
    fixtureOptions.rendezvousConfigMutation &&
    !fixtureOptions.rightsObservation
  ) {
    throw new Error("Malformed profile probe requires observation fixture");
  }
  if (fixtureOptions.frozenRightsAtExecution && fixtureOptions.sharedBase)
    throw new Error("Frozen rights fixture requires original construction");
  const f =
      fixtureOptions.sharedBase ??
      (await lifecycleFixture({
        ...(fixtureOptions.frozenRightsAtExecution
          ? { frozenRightsAtExecution: true }
          : {}),
        ...(fixtureOptions.corpusReviewExpiresAt
          ? { corpusReviewExpiresAt: fixtureOptions.corpusReviewExpiresAt }
          : {}),
        ...(fixtureOptions.participantId
          ? { participantId: fixtureOptions.participantId }
          : {}),
      })),
    db = extendChatWorkerSql(f),
    clock = { now: () => f.state.at };
  const native = fixtureOptions.nativeEvidence
    ? await nativeHistoricalInputs(f)
    : null;
  if (native) {
    Object.assign(f, {
      config: native.config,
      modelPolicy: native.modelPolicy,
      selection: native.selection,
    });
  }
  const request = VertexResearchChatExecutionRequestSchema.parse({
    ...f.request,
    ...(native ? { protocol: RESEARCH_CHAT_NATIVE_EVIDENCE_PROTOCOL } : {}),
  });
  const suffix = fixtureOptions.debate ? `-${f.responseRequestId}` : "";
  const workerGrantId = `chat-worker-grant${suffix}`,
    tokenizeGrantId = "chat-tokenize-grant",
    completionGrantId = "chat-completion-grant";
  // This fixture's selected head/private technical documents remain SYNTHETIC
  // EXTERNAL HISTORY, not records issued by an operational policy authority.
  // All NEW chat consent, copy effects, command/outbox/run/service/model grants,
  // privacy review and model-use reservations use their actual source owners.
  const replaceHistoricalArtifact = async (
    id: string,
    value: Record<string, unknown>
  ) => {
    const row = f
      .table("vertex_artifacts")
      .find((row) => row["artifact_id"] === id)!;
    const body = encode(value),
      sha = await hashArtifact(body),
      key = vertexQualifiedObjectKey(scope, null, "manifest", sha);
    const metadata = {
      ...row["payload"],
      artifactSha256: sha,
      objectKey: key,
      byteLength: body.byteLength,
    };
    Object.assign(row, {
      artifact_sha256: sha,
      object_key: key,
      byte_length: String(body.byteLength),
      metadata_hash: await hashArtifact(metadata),
      payload: metadata,
    });
    f.objects.set(key, { id, body });
    return {
      artifactId: id,
      artifactSha256: sha,
      contractName: metadata.contractName,
      schemaVersion: "1.0.0" as const,
    };
  };
  const budgetPin = await replaceHistoricalArtifact(
    "selected-provider-budget",
    {
      format: "vertex-model-budget-policy-v1",
      ...scope,
      policyId: "policy-provider-budget",
      policyVersion: "1.0.0",
      periodId: "fixture-period",
      startsAt: BEFORE,
      expiresAt: END,
      maximumTokens: 100_000,
      maximumCostUsd:
        fixtureOptions.nativeEvidence === "bounded-budget" ? "0.15" : "10",
      chargeProfile: "approved-grant-ceiling-v1",
      unknownOutcome: "retain-charge",
    }
  );
  const selected = mutableClone(f.selection);
  if (fixtureOptions.rendezvous) {
    const use = await f.artifact(
      "rendezvous-model-use",
      {
        consumer_service_id: "fixture-consumer",
        model_use_policy_version: "1.0.0",
        purpose: "research",
        tokenizer_artifact_id: f.descriptor.value["tokenizerArtifactId"],
        tokenize_grant_id: tokenizeGrantId,
        tokenize_grant_version: "1.0.0",
        completion_grant_id: completionGrantId,
        completion_grant_version: "1.0.0",
      },
      "ModelUsePolicy"
    );
    const profile = native
      ? "vertex-first-mate-native-evidence-adapter-config-v1"
      : fixtureOptions.rendezvousConfigMutation === "wrong-profile"
        ? "vertex-first-mate-review-rendezvous-adapter-config-v3"
        : fixtureOptions.rightsObservation
          ? "vertex-first-mate-review-rendezvous-adapter-config-v2"
          : "vertex-first-mate-review-rendezvous-adapter-config-v1";
    const adapter = await f.artifact(
      "rendezvous-adapter-config",
      {
        profile,
        provider_configs: [],
        admission_limits: [],
        endpoint_artifact_ids: [
          f.tokenize.pin.artifactId,
          f.completion.pin.artifactId,
        ],
        model_artifact_id: f.descriptor.pin.artifactId,
        model_policy_artifact_id: f.modelPolicy.pin.artifactId,
        model_use_artifact_id: use.pin.artifactId,
        calendar_artifact_ids: [],
        privacy_review_rendezvous: {
          maximum_wait_ms: 30_000,
          maximum_status_reads: 8,
          poll_interval_ms: 100,
        },
        ...(native
          ? {
              native_evidence: {
                protocol: RESEARCH_CHAT_NATIVE_EVIDENCE_PROTOCOL,
                nativeServing: native.serving.pin,
                serializerProfile: RESEARCH_CHAT_NATIVE_EVIDENCE_SERIALIZER,
                allowedTools: ["read_reviewed_evidence"],
              },
            }
          : {}),
        ...(fixtureOptions.rendezvousConfigMutation === "extra-field"
          ? { unsupported: true }
          : {}),
      },
      "FirstMatePrivacyRendezvousAdapter"
    );
    selected.artifacts.push(
      { bindingId: use.pin.artifactId, role: "tool-config", artifact: use.pin },
      {
        bindingId: adapter.pin.artifactId,
        role: "provider-config",
        artifact: adapter.pin,
      }
    );
  }
  const historical = {
    ...selected,
    modules: selected.modules.map((module) => ({ ...module, enabled: true })),
    references: selected.references.map((reference) => ({
      ...reference,
      verificationState: "verified" as const,
      lastVerifiedAt: BEFORE,
    })),
    providerCapabilities: selected.providerCapabilities.map((capability) => ({
      ...capability,
      state: "ready" as const,
    })),
    policies: selected.policies.map((policy) =>
      policy.role === "provider-budget"
        ? { ...policy, artifact: budgetPin }
        : policy
    ),
    artifacts: [
      ...selected.artifacts,
      ...(fixtureOptions.debate
        ? f.runtimeOptions.experts.map((expert) => ({
            bindingId: expert.artifact.artifactId,
            role: "tool-config" as const,
            artifact: expert.artifact,
          }))
        : [
            {
              bindingId: f.config.pin.artifactId,
              role: "tool-config" as const,
              artifact: f.config.pin,
            },
          ]),
    ],
  };
  const selection = await parseRuntimePolicySelection({
    ...historical,
    selectionSha256: await computeRuntimePolicySelectionHash(historical),
  });
  const selectedRow = f
    .table("vertex_policy_selections")
    .find((row) => row["selection_id"] === selection.selectionId)!;
  Object.assign(selectedRow, {
    selection_sha256: selection.selectionSha256,
    payload: selection,
  });
  const head = f.table("vertex_policy_heads")[0]!,
    headBody = {
      ...head["payload"],
      selectionSha256: selection.selectionSha256,
    };
  Object.assign(head, {
    selection_sha256: selection.selectionSha256,
    record_hash: await hashArtifact(headBody),
    payload: headBody,
  });
  // SYNTHETIC EXTERNAL HISTORICAL HOST BYTES, not host qualification or an
  // operational readiness claim. Keep the ORIGINAL nonempty component pins.
  // The existing host-object bootstrap reader must check this exact digest,
  // selection/module pins, independent read/licensing rights and actual issued
  // service grant. No accepted worker job or readiness callback is fabricated.
  const module = selection.modules.find(
    (module) => module.moduleId === selection.research!.moduleId
  )!;
  const hostReceipt = RuntimeComponentEvidenceSchema.parse({
    ...scope,
    evidenceId: "synthetic-external-host-receipt",
    componentId: module.requiredComponents[0],
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
    state: "ready",
    codeSha256: module.codeSha256,
    contractSha256: module.contractSha256,
    observedAt: AT,
    expiresAt: "2026-09-24T12:05:00.000000001Z",
    reasonCodes: ["synthetic-external-fixture-not-operational-readiness"],
  });
  const hostBody = encode(hostReceipt);
  const hostEvidence = {
    artifactId: "synthetic-external-host-receipt",
    artifactSha256: await hashArtifact(hostBody),
    contractName: "RuntimeComponentEvidence",
    schemaVersion: "1.0.0" as const,
  };
  f.objects.set(
    vertexQualifiedObjectKey(
      scope,
      null,
      "manifest",
      hostEvidence.artifactSha256
    ),
    { id: hostEvidence.artifactId, body: hostBody }
  );
  await f.grant(owner.actorId, hostEvidence.artifactId, ["read"]);
  const originalKeys = new Set(f.objects.keys()),
    ordinaryWrites: string[] = [];
  const objectCapabilities = (): VertexObjectCapabilities => ({
    ...f.runtimeOptions.objectCapabilities(),
    putIfAbsent: async (input) => {
      const prior = f.objects.get(input.key);
      const checksum = await hashArtifact(input.body);
      if (
        (input.checksum !== undefined && input.checksum !== checksum) ||
        (prior && (await hashArtifact(prior.body)) !== checksum)
      )
        // A conflicting existing key: the capability contract has no conflict
        // status, and every non-ok result fails closed in the storage owner.
        return { status: "unavailable", state: "unconfigured" };
      if (!prior) {
        f.objects.set(input.key, {
          id: input.key,
          body: new Uint8Array(input.body),
        });
        ordinaryWrites.push(input.key);
      }
      return {
        status: "ok",
        value: {
          key: input.key,
          size: input.body.byteLength,
          checksum,
          createdAt: AT,
          updatedAt: AT,
        },
      };
    },
  });
  const policyOptions: VertexResearchChatExecutionRuntimeOptions["policy"] = {
    ...f.runtimeOptions.policy,
    components: [
      {
        ...scope,
        componentId: hostReceipt.componentId,
        moduleId: module.moduleId,
        servicePrincipalId: "fixture-consumer",
        grantId: workerGrantId,
        maximumAgeMilliseconds: 300_000,
        source: "host-object",
        principal: owner,
        evidence: hostEvidence,
        rightsPolicyId: "policy-rights",
        rightsVersion: "1.0.0",
      },
    ],
    jobModules: [
      {
        ...scope,
        kind: "research-run",
        consumerServiceId: "fixture-consumer",
        moduleId: module.moduleId,
      },
    ],
  };
  const policy = createVertexRuntimePolicy({
    ...policyOptions,
    db,
    clock,
    objectCapabilities,
  });
  const privacyReviewer = { actorId: "fixture-privacy-reviewer" };
  const runtime = createVertexResearchChatExecutionRuntime({
    ...f.runtimeOptions,
    db,
    policy: policyOptions,
    objectCapabilities,
    privacyReviewerActorId: privacyReviewer.actorId,
    storage: {
      ...f.runtimeOptions.storage,
      capabilities: f.copies.capabilities,
    },
    ...(native ? { nativeEvidence: { artifact: native.config.pin } } : {}),
    ...(fixtureOptions.debate ? { debate: fixtureOptions.debate } : {}),
  });
  const store = createVertexStore(db, {
    boundary: vertexPersistenceBoundary,
    authorization: f.authorization,
    clock,
    maxProjectionAgeMs: 60_000,
  });
  const conversationAppend = (revision: string, key: string) => {
    const command = {
      principal: owner,
      scope,
      threadId: request.threadId,
      expectedRevision: revision,
      idempotencyKey: key,
      body: `${SENTINELS.human} ${key}`,
      requestedParticipantIds: [],
      mode: "discuss",
    } as const;
    return store.sendResearchChatMessage(command);
  };
  const append =
    fixtureOptions.admissionPath === "conversation"
      ? conversationAppend
      : f.append;
  // Independent exact rights/grants, never blanket root grants.
  await f.grant(admin.actorId, "policy-rights", ["manage-rights"], "corpus");
  const rights = {
    policyId: "policy-rights",
    version: "1.0.0",
    status: "granted" as const,
    allowedUses: ["store", "read", "derive", "export"] as const,
    checkedAt: fixtureOptions.frozenRightsAtExecution ? clock.now() : BEFORE,
    expiresAt: END,
    retentionUntil: null,
  };
  await store.putRights(admin, scope, "corpus", rights);
  for (const [policyId, collection] of [
    ["policy-rights", null],
    ["policy-rights", "corpus"],
    ["corpus-rights", "corpus"],
  ] as const)
    await f.grant(owner.actorId, policyId, ["read", "publish"], collection);
  // The optional path changes orchestration only, never authority. Preparing
  // consent precedes the independent review; approval/copy/admission remain real.
  const prepared =
    fixtureOptions.admissionPath === "conversation"
      ? VertexResearchChatExecutionPrepareOutputSchema.parse(
          await observe<unknown>("previewPrepare", () =>
            native
              ? runtime.conversation.prepareResearchChatNativeEvidence(
                  owner,
                  request
                )
              : fixtureOptions.debate
                ? runtime.conversation.prepareDebateStep(owner, request)
                : runtime.conversation.prepareResponse(owner, request)
          )
        )
      : null;
  if (prepared !== null && prepared.status !== "prepared")
    throw new Error("Actual conversation consent preview unavailable");
  const plan = VertexResearchChatExecutionPlanSchema.parse(
    prepared === null
      ? await runtime.planResearchChatResponse(owner, request)
      : f
          .table("vertex_research_chat_execution_plans")
          .find((row) => row["response_request_id"] === f.responseRequestId)?.[
          "payload"
        ]
  );
  await observe("storageReview", () =>
    runtime.recordResearchChatStorageQualificationReview(
      reviewer,
      VertexResearchChatStorageReviewInputSchema.parse({
        ...f.reviewInput(plan),
        ...(fixtureOptions.storageReviewExpiresAt
          ? { expiresAt: fixtureOptions.storageReviewExpiresAt }
          : {}),
      })
    )
  );
  const approveInput = VertexResearchChatExecutionApproveSchema.parse({
    planId: plan.planId,
    planSha256: plan.planSha256,
    request,
    ...(native ? { consent: RESEARCH_CHAT_NATIVE_EVIDENCE_CONSENT } : {}),
  });
  let approval: ReturnType<
    typeof VertexResearchChatExecutionApprovalSchema.parse
  > | null = null;
  if (fixtureOptions.admissionPath !== "conversation") {
    const originalApproval = VertexResearchChatExecutionApprovalSchema.parse(
      await runtime.approveResearchChatResponse(owner, approveInput)
    );
    approval = originalApproval;
    await runtime.writeApprovedInputs(owner, approveInput);
  }
  const configuration =
    VertexResearchChatParticipantConfigurationV1Schema.parse(f.config.value);
  const run = AgentRunSchema.parse({
    schemaVersion: "1.0.0",
    runId: plan.runId,
    agentRole: "research",
    taskContract: plan.taskContract,
    allowedTools: [],
    modelVersion: configuration.provider.modelVersion,
    inputEvidenceIds: configuration.reviewPins.map((pin) => pin.evidenceId),
    outputArtifactIds: [],
    tokenBudget: configuration.budgets.requestTokens,
    costBudgetUsd: configuration.budgets.requestCostUsd,
    status: "queued",
    errors: [],
    approvalRequests: [],
    executionAuthorized: false,
  });
  const runArtifactId = `chat-agent-${await hashArtifact({ responseRequestId: f.responseRequestId })}`;
  const eventBody = {
    schemaVersion: "1.0.0",
    eventType: "agent.recorded",
    occurredAt: AT,
    effectiveAt: AT,
    correlationId: plan.traceId,
    causationId: null,
    actorId: owner.actorId,
    moduleId: "vertex-persistence",
    moduleVersion: "1.0.0",
    environment: "research",
    idempotencyKey: `chat-event-${f.responseRequestId}`,
    payload: run,
  };
  const eventId = `event-${await hashArtifact(eventBody)}`;
  await f.grant(owner.actorId, runArtifactId, ["read", "publish"], "corpus");
  await f.grant(
    owner.actorId,
    eventId,
    ["publish", "dispatch-outbox"],
    "corpus"
  );
  // Anticipated run/event grants above come from the actual grant owner BEFORE
  // the combined conversation operation admits its queued run and outbox.
  await (fixtureOptions.onPrepared
    ? observe("onPrepared", () =>
        fixtureOptions.onPrepared!({
          base: f,
          runtime,
          request,
          plan,
          approveInput,
          prepared,
        })
      )
    : undefined);
  const approvalReceipt =
    fixtureOptions.admissionPath === "conversation"
      ? VertexResearchChatApproveAndRequestResponseOutputSchema.parse(
          await observe("approvalAdmission", () =>
            native
              ? runtime.conversation.approveAndRequestResearchChatNativeEvidence(
                  owner,
                  approveInput
                )
              : fixtureOptions.debate
                ? runtime.conversation.approveAndRequestDebateStep(
                    owner,
                    approveInput
                  )
                : runtime.conversation.approveAndRequestResponse(
                    owner,
                    approveInput
                  )
          )
        )
      : null;
  if (approvalReceipt !== null && approvalReceipt.status !== "recorded")
    throw new Error("Actual conversation approval/admission unavailable");
  const admitted = VertexResearchChatResponseReceiptSchema.parse(
    approvalReceipt === null
      ? await runtime.admitApprovedResponse(owner, approveInput)
      : approvalReceipt.receipt
  );
  if (approval === null)
    approval = VertexResearchChatExecutionApprovalSchema.parse(
      f
        .table("vertex_research_chat_execution_approvals")
        .find((row) => row["response_request_id"] === f.responseRequestId)?.[
        "payload"
      ]
    );
  const origin = f
    .table("vertex_research_chat_worker_origins")
    .find((row) => row["response_request_id"] === f.responseRequestId)![
    "payload"
  ];
  const recipe = ResearchChatRecipeSchema.parse(origin.recipe);
  await f.grant(
    owner.actorId,
    origin.recipeArtifactId,
    ["read", "publish"],
    "corpus"
  );
  for (const artifactId of [plan.runId, recipe.copies.advisory.copyId])
    await f.grant(owner.actorId, artifactId, ["read", "publish"], "corpus");
  // Actual outbox claims include earlier fixture publication/review events.
  await f.grant(owner.actorId, "vertex-outbox", ["dispatch-outbox"]);
  for (const row of f.table("vertex_outbox")) {
    if (row["event_id"] !== eventId)
      await f.grant(
        owner.actorId,
        row["event_id"],
        ["dispatch-outbox"],
        row["collection_key"] || null
      );
  }
  const privacy = runtime.privacy;
  if (!privacy)
    throw new Error("Concrete independent privacy owner was not configured");
  const modelUse = createVertexRuntimeModelUse({
    db,
    clock,
    objectCapabilities,
    policySelection: policy.policySelection,
    readSelectedArtifact: policy.readSelectedArtifact,
    requestEvidence: [],
    privilegedAuthorization: {
      authorize: async (request) =>
        request.principal.actorId === admin.actorId &&
        request.grant.accountAlias === scope.accountAlias,
    },
    chat: { owner: runtime.workerModel, privacy },
  });
  const worker = createVertexWorkerStore(db, {
    boundary: vertexPersistenceBoundary,
    authorization: f.authorization,
    clock,
    maxProjectionAgeMs: 60_000,
    validateWorker: (name, value) =>
      VERTEX_WORKER_CONTRACT_SCHEMAS[
        name as keyof typeof VERTEX_WORKER_CONTRACT_SCHEMAS
      ].parse(value),
    objectCapabilities,
    authorizeGrantAdministration: async (context) => context === admin,
    policySelection: policy.policySelection,
    pinPolicySelection: policy.pinPolicySelection,
    chatWorker: runtime.worker,
    ...(fixtureOptions.omitOutputOwner ? {} : { chatOutput: runtime.output }),
    modelUse: modelUse.modelUse,
    chatModelPrivacyReview: (tx, operation, request, at, bytes) =>
      privacy.rendezvousForTransaction(
        tx,
        operation,
        ModelUseRequestSchema.parse(request),
        at,
        bytes
      ),
    authorizeBootstrapEnqueue: async () => false,
    authorizeNativeBootstrap: async () => false,
    epochTransition: async () => {
      throw new Error("not chat");
    },
    nativeProjectionPrincipal: async () => {
      throw new Error("not chat");
    },
    nativeOutboxReplay: async () => {
      throw new Error("not chat");
    },
  });
  const workerToken = btoa("synthetic-source-only-not-secret!".padEnd(32, "!"))
    .replace(/[=]/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const credentialDigest = await hashArtifact(
    fixtureOptions.rendezvous
      ? new TextEncoder().encode(workerToken)
      : encode({
          fixture: "synthetic-worker-credential-digest-not-a-secret",
          ...(suffix ? { responseRequestId: f.responseRequestId } : {}),
        })
  );
  await worker.issueGrant(
    admin,
    WorkerServiceGrantSchema.parse({
      ...scope,
      grantId: workerGrantId,
      servicePrincipalId: "fixture-consumer",
      operations: [
        "claim",
        "policySelection",
        "admitRun",
        "readArtifact",
        "currentModelUse",
        "currentRights",
        "acceptedEvidence",
        "stageArtifact",
        "publishAgent",
        "complete",
        "cancel",
        "status",
        "readiness",
        ...(fixtureOptions.rendezvous
          ? ["prepareModelPrivacyReview", "readModelPrivacyReview"]
          : []),
        ...(native ? ["prepareNativeEvidencePhaseTwo"] : []),
        ...(fixtureOptions.rightsObservation
          ? ["currentRightsObservation", "acceptedEvidenceObservation"]
          : []),
      ].filter(
        (operation) => operation !== fixtureOptions.omitServiceOperation
      ),
      issuedAt: BEFORE,
      expiresAt: END,
      revokedAt: null,
    }),
    credentialDigest
  );
  const identity = await worker.authenticate(credentialDigest, scope, "claim");
  const leases = await store.claimOutbox(owner, scope, {
    leaseOwner: "chat-worker-instance",
    leaseExpiresAt: "2026-09-24T12:10:00.000000001Z",
    limit: 100,
  });
  const outbox = leases.find((lease) => lease.eventId === eventId);
  if (!outbox) throw new Error("Actual queued chat outbox claim unavailable");
  const recipes = createVertexRuntimeRecipes({
    db,
    store,
    workerStore: worker,
    policyRegistry: policy.registry,
    readSelectedArtifact: policy.readSelectedArtifact,
    objectCapabilities,
    clock,
    consumerServiceId: "fixture-consumer",
    routes: [
      {
        taskContract: plan.taskContract,
        kind: "research-run",
        bindingId: f.config.pin.artifactId,
        ttlMilliseconds: 60_000,
      },
    ],
    chatWorker: runtime.worker,
  });
  const event = EventEnvelopeSchema.parse(outbox.payload);
  const binding = await observe("resolveBinding", () =>
    recipes.resolveBinding({
      identity,
      lease: outbox,
      command: { kind: "queued-agent", event },
      signal: new AbortController().signal,
    })
  );
  if (!binding) throw new Error("Actual chat binding unavailable");
  const bound = WorkerResultSchema.parse(
    await observe("bindOutbox", () =>
      worker.bindOutbox(identity, outbox, {
        ...binding,
        workerInstanceId: outbox.leaseOwner,
      })
    )
  );
  if (bound.status !== "accepted" || bound.lease === null)
    throw new Error("Actual first worker binding was not accepted");
  const lease = WorkerLeaseSchema.parse(bound.lease);
  const fence = {
    ...scope,
    jobId: lease.jobId,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
  };
  const runAdmission = WorkerResultSchema.parse(
    await observe("admitRun", () =>
      worker.invoke(identity, "admitRun", {
        ...fence,
        runId: plan.runId,
        requestSha256: lease.payloadSha256,
      })
    )
  );
  if (runAdmission.status !== "accepted" || runAdmission.state !== "running")
    throw new Error("Actual chat run was not admitted");
  const evidence = configuration.reviewPins.map((pin) => ({
    artifactId: pin.artifactId,
    artifactSha256: pin.artifactSha256,
    reviewId: pin.reviewId,
    reviewVersion: pin.reviewVersion,
    rightsPolicyId: pin.rightsPolicyId,
    rightsVersion: pin.rightsVersion,
  }));
  // Model grant administration requires BOTH original account-read and exact
  // grant-read permissions, independently from its administrative identity.
  await f.grant(admin.actorId, "account-scope", ["read"]);
  for (const operation of ["model-tokenize", "model-completion"] as const) {
    const tokenize = operation === "model-tokenize",
      grantId = tokenize ? tokenizeGrantId : completionGrantId,
      input = recipe.copies[tokenize ? "tokenizeInput" : "completionInput"];
    await f.grant(owner.actorId, grantId, ["read"]);
    await f.grant(admin.actorId, grantId, ["read"]);
    const endpoint = tokenize ? f.tokenize : f.completion;
    if (
      fixtureOptions.debate &&
      f
        .table("vertex_model_use_grant_versions")
        .some((row) => row["grant_id"] === grantId)
    )
      continue;
    await modelUse.grantAdministration.issueGrant({
      principal: admin,
      commandId: grantId,
      expectedRevision: null,
      grant: ModelUseGrantSchema.parse({
        schemaVersion: "1.0.0",
        ...scope,
        grantId,
        grantVersion: "1.0.0",
        revision: "1",
        researchPrincipalId: owner.actorId,
        consumerServiceId: "fixture-consumer",
        selectionId: selection.selectionId,
        selectionSha256: selection.selectionSha256,
        providerId: configuration.provider.providerId,
        modelVersion: configuration.provider.modelVersion,
        tokenizerArtifactId:
          configuration.provider.tokenizerArtifact.artifactId,
        tokenizerSha256:
          configuration.provider.tokenizerArtifact.artifactSha256,
        endpointReferenceId: endpoint.value["endpoint_id"],
        endpointSha256: endpoint.pin.artifactSha256,
        modelUsePolicyVersion: "1.0.0",
        operations: [operation],
        purposes: ["research"],
        allowedTools: native && !tokenize ? ["read_reviewed_evidence"] : [],
        evidence,
        maximumInputBytes:
          fixtureOptions.debate || native ? 1_000_000 : input.byteLength,
        maximumInputTokens: 128,
        maximumOutputTokens: tokenize
          ? 0
          : configuration.provider.maximumOutputTokens,
        maximumCostUsd:
          configuration.budgets[
            tokenize ? "tokenizeCostUsd" : "completionCostUsd"
          ],
        privacyPolicyId: "chat-privacy-policy",
        privacyPolicyVersion: "1.0.0",
        validFrom: BEFORE,
        expiresAt: END,
        status: "granted",
        issuedByActorId: admin.actorId,
        issuedAt: AT,
        modelProcessingOnly: true,
        executionAuthorized: false,
      }),
    });
  }
  const requestFor = async (
    operation: "model-tokenize" | "model-completion",
    inputTokens: number | null
  ): Promise<ModelUseRequest> => {
    const tokenize = operation === "model-tokenize",
      endpoint = tokenize ? f.tokenize : f.completion,
      input = recipe.copies[tokenize ? "tokenizeInput" : "completionInput"];
    const body = {
      schemaVersion: "1.0.0",
      ...scope,
      researchPrincipalId: owner.actorId,
      consumerServiceId: "fixture-consumer",
      selectionId: selection.selectionId,
      selectionSha256: selection.selectionSha256,
      providerId: configuration.provider.providerId,
      modelVersion: configuration.provider.modelVersion,
      tokenizerArtifactId: configuration.provider.tokenizerArtifact.artifactId,
      tokenizerSha256: configuration.provider.tokenizerArtifact.artifactSha256,
      endpointReferenceId: endpoint.value["endpoint_id"],
      endpointSha256: endpoint.pin.artifactSha256,
      modelUsePolicyVersion: "1.0.0",
      ...fence,
      grantId: tokenize ? tokenizeGrantId : completionGrantId,
      grantVersion: "1.0.0",
      operation,
      purpose: "research",
      tools: native && !tokenize ? ["read_reviewed_evidence"] : [],
      evidence,
      inputSha256: input.sha256,
      inputBytes: input.byteLength,
      inputTokens,
      maximumOutputTokens: tokenize
        ? 0
        : configuration.provider.maximumOutputTokens,
      maximumCostUsd:
        configuration.budgets[
          tokenize ? "tokenizeCostUsd" : "completionCostUsd"
        ],
      deadlineAt: recipe.execution.deadlineAt,
    };
    const identity = {
      ...body,
      requestId: `model-use-${await hashArtifact(body)}`,
    };
    const parsed = ModelUseRequestSchema.parse({
      ...identity,
      requestSha256: "0".repeat(64),
    });
    return parseModelUseRequest({
      ...parsed,
      requestSha256: await computeModelUseRequestHash(parsed),
    });
  };
  await f.grant(privacyReviewer.actorId, "account-scope", ["read"]);
  await f.grant(privacyReviewer.actorId, "chat-privacy-policy", ["review"]);
  for (const operation of ["model-tokenize", "model-completion"])
    await f.grant(
      privacyReviewer.actorId,
      `research-chat-model-privacy:${f.responseRequestId}:${native ? "phase-1:" : ""}${operation}`,
      ["review"]
    );
  const source = new TextEncoder().encode(
    "Whole authored source content, distinct from bounded claim"
  );
  f.objects.set(
    vertexQualifiedObjectKey(
      scope,
      "corpus",
      "content",
      await hashArtifact(source)
    ),
    { id: "original-source-content", body: source }
  );
  const tokenizeRequest = await requestFor("model-tokenize", null);
  const completionRequest = (inputTokens: number) =>
    requestFor("model-completion", inputTokens);
  const privacyInput = (
    request: ModelUseRequest,
    overrides: Partial<ChatModelPrivacyReviewInput> = {}
  ): ChatModelPrivacyReviewInput =>
    ChatModelPrivacyReviewInputSchema.parse({
      responseRequestId: f.responseRequestId,
      planId: plan.planId,
      planSha256: plan.planSha256,
      request,
      decision: "accepted",
      expiresAt: lease.leaseExpiresAt,
      expectedReviewId: null,
      idempotencyKey: `privacy-${request.operation}${suffix}`,
      ...overrides,
    });
  const modelUseRequest = async (request: ModelUseRequest) =>
    ModelUseProofSchema.parse(
      await worker.invoke(identity, "currentModelUse", request)
    );
  return {
    ...f,
    db,
    clock,
    runtime,
    policy,
    store,
    append,
    worker,
    identity,
    selection,
    scope,
    request,
    plan,
    approval,
    approveInput,
    admitted,
    prepared,
    approvalReceipt,
    origin,
    recipe,
    outbox,
    binding,
    lease,
    fence,
    runAdmission,
    privacy,
    privacyReviewer,
    tokenizeRequest,
    completionRequest,
    privacyInput,
    modelUseRequest,
    modelUse,
    ordinaryWrites,
    originalKeys,
    objectCapabilities,
    workerToken,
    grantAdmin: admin,
  };
};
