import {
  type VertexObjectCapabilities,
  vertexQualifiedObjectKey,
} from "@darkfactory/storage";
import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import {
  createResearchChatCommandOperations,
  createResearchChatResponseReceiptOperations,
} from "./vertex-command-store.ts";
import {
  array,
  fail,
  identifier,
  insert,
  object,
  one,
  type PersistenceContext,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexArtifactMetadata,
  VertexPrincipal,
  VertexRecord,
  VertexRightsRecord,
  VertexScope,
} from "./vertex-ports.ts";
import type { createResearchChatCopyLifecycle } from "./vertex-research-chat-copy-lifecycle.ts";
import type { createResearchChatExecutionOperations } from "./vertex-research-chat-execution-store.ts";
import {
  isNativeEvidencePlan,
  nativeEvidenceCopyKey,
  nativeEvidenceCopyPurposes,
} from "./vertex-research-chat-native-phase-store.ts";
import type { ResearchChatSourceInputs } from "./vertex-research-chat-source-ports.ts";

type Scope = Readonly<{ accountAlias: string; environment: "research" }>;
type Execution = ReturnType<typeof createResearchChatExecutionOperations>;
type Copies = ReturnType<typeof createResearchChatCopyLifecycle>;
export const createResearchChatWorkerOperations = (
  ctx: PersistenceContext,
  execution: Execution,
  copies: Copies,
  options: Readonly<{
    objectCapabilities: (scope: VertexScope) => VertexObjectCapabilities;
    validateRecipe: (value: unknown) => VertexRecord;
  }>
) => {
  const receipts = createResearchChatResponseReceiptOperations(ctx);
  const commands = createResearchChatCommandOperations(ctx);
  const current = (at: string, expiresAt: string): void => {
    if (time(ctx.now()) < time(at) || time(ctx.now()) >= time(expiresAt))
      fail("stale");
  };
  const recipeFor = (
    joined: NonNullable<
      Awaited<ReturnType<Copies["readCurrentOriginalForTransaction"]>>
    >,
    queuedMetadata: VertexArtifactMetadata
  ): VertexRecord => {
    const { plan, configuration, inventory } = joined;
    const refs: Record<string, unknown> = {};
    const native = isNativeEvidencePlan(plan);
    for (const purpose of native
      ? nativeEvidenceCopyPurposes
      : ([
          "context",
          "tokenizeInput",
          "completionInput",
          "advisory",
        ] as const)) {
      const entry = inventory.copies.find(
        (candidate) =>
          candidate.allocation.copyIdempotencyKey ===
          (native ? nativeEvidenceCopyKey(purpose) : `one-expert-${purpose}-v1`)
      );
      if (!entry) return fail("integrity");
      const initial = [
        "context",
        "tokenizeInput",
        "completionInput",
        "evidenceBundle",
      ].includes(purpose);
      refs[purpose] = {
        copyId: entry.allocation.copyId,
        reservationSha256: entry.allocation.reservationSha256,
        ...(initial
          ? object(
              purpose === "evidenceBundle"
                ? object(plan["nativeEvidence"])["bundle"]
                : plan[purpose]
            )
          : { content: null }),
      };
    }
    return options.validateRecipe({
      profile: native
        ? "vertex-research-chat-native-evidence-job-v1"
        : plan["format"] === "vertex-research-chat-plan-v2"
          ? "vertex-research-chat-job-v2"
          : "vertex-research-chat-job-v1",
      run_id: plan["runId"],
      trace_id: plan["traceId"],
      actor_id: plan["ownerActorId"],
      account_alias: plan["accountAlias"],
      environment: "research",
      response_request_id: plan["responseRequestId"],
      plan_id: plan["planId"],
      plan_sha256: plan["planSha256"],
      copies: refs,
      execution: {
        collectionId: plan["collectionId"],
        snapshotId: plan["snapshotId"],
        taskContract: plan["taskContract"],
        ...(plan["format"] === "vertex-research-chat-plan-v2"
          ? { debate: plan["debate"] }
          : {}),
        ...(native ? { nativeEvidence: plan["nativeEvidence"] } : {}),
        advisoryMaximumBytes: plan["advisoryMaximumBytes"],
        budgets: configuration["budgets"],
        deadlineAt: plan["expiresAt"],
        inputPolicy: plan["inputPolicy"],
        participantConfiguration: plan["participantConfiguration"],
        provider: plan["provider"],
        queuedRun: {
          artifactId: queuedMetadata.artifactId,
          artifactSha256: queuedMetadata.artifactSha256,
          rightsPolicyId: queuedMetadata.rights.policyId,
          rightsVersion: queuedMetadata.rights.version,
        },
        reviewPins: plan["reviewPins"],
        selectionId: plan["selectionId"],
        selectionSha256: plan["selectionSha256"],
      },
    });
  };
  const originalForDomain = async (
    tx: Transaction,
    scope: VertexScope,
    selector: Readonly<{
      eventId?: string;
      jobId?: string;
      responseRequestId?: string;
    }>,
    at: string,
    domain: "inputs" | "derived"
  ) => {
    const keys = Object.keys(selector);
    if (
      keys.length !== 1 ||
      !["eventId", "jobId", "responseRequestId"].includes(
        requirePresent(keys[0], "keys[0]")
      )
    )
      return fail("invalid");
    const filter = selector.eventId
      ? sql`event_id = ${selector.eventId}`
      : selector.jobId
        ? sql`job_id = ${selector.jobId}`
        : sql`response_request_id = ${identifier(selector.responseRequestId)}`;
    const row = await one(
      tx,
      "vertex_research_chat_worker_origins",
      scope,
      filter
    );
    if (!row) return null;
    if (scope.environment !== "research") return fail("denied");
    const origin = object(row["payload"]);
    if (
      (await ctx.hash(origin)) !== row["record_hash"] ||
      origin["profile"] !== "vertex-research-chat-worker-origin-v1" ||
      origin["accountAlias"] !== scope.accountAlias ||
      origin["environment"] !== scope.environment ||
      origin["ownerActorId"] !== row["owner_actor_id"] ||
      origin["responseRequestId"] !== row["response_request_id"] ||
      origin["runId"] !== row["run_id"] ||
      origin["eventId"] !== row["event_id"] ||
      origin["jobId"] !== row["job_id"] ||
      origin["planId"] !== row["plan_id"] ||
      origin["planSha256"] !== row["plan_sha256"] ||
      origin["recipeSha256"] !== row["recipe_sha256"]
    )
      return fail("integrity");
    // Unsupported historical wire shapes fail BEFORE current-authority checks;
    // they are not evidence of a genuine original global loss.
    options.validateRecipe(origin["recipe"]);
    const joined =
      domain === "inputs"
        ? await copies.readCurrentOriginalForTransaction(
            tx,
            { accountAlias: scope.accountAlias, environment: "research" },
            identifier(origin["responseRequestId"]),
            at
          )
        : await copies.readCurrentDerivedForTransaction(
            tx,
            { accountAlias: scope.accountAlias, environment: "research" },
            identifier(origin["responseRequestId"]),
            at
          );
    if (!joined) return { closed: true as const, origin };
    const { plan, approval } = joined;
    if (
      plan["ownerActorId"] !== origin["ownerActorId"] ||
      plan["planId"] !== origin["planId"] ||
      plan["planSha256"] !== origin["planSha256"] ||
      plan["requestSha256"] !== origin["requestSha256"] ||
      (await ctx.hash(approval)) !== origin["approvalSha256"] ||
      plan["runId"] !== origin["runId"] ||
      plan["traceId"] !== origin["traceId"]
    )
      return fail("integrity");
    const metadataRow = await one(
      tx,
      "vertex_artifacts",
      scope,
      sql`artifact_id = ${origin["runArtifactId"]} and collection_key = ${plan["collectionId"]}`
    );
    if (!metadataRow) return fail("integrity");
    const queuedMetadata = object(
      metadataRow["payload"]
    ) as unknown as VertexArtifactMetadata;
    if (
      (await ctx.hash(queuedMetadata)) !== metadataRow["metadata_hash"] ||
      queuedMetadata.scope.accountAlias !== scope.accountAlias ||
      queuedMetadata.scope.environment !== scope.environment ||
      queuedMetadata.collectionId !== plan["collectionId"] ||
      queuedMetadata.artifactId !== origin["runArtifactId"] ||
      queuedMetadata.artifactSha256 !== origin["runSha256"] ||
      queuedMetadata.contractName !== "AgentRun"
    )
      return fail("integrity");
    const recipe = recipeFor(joined, queuedMetadata);
    if (
      (await ctx.hash(recipe)) !== origin["recipeSha256"] ||
      (await ctx.hash(recipe)) !== (await ctx.hash(origin["recipe"]))
    )
      return fail("integrity");
    const event = await one(
      tx,
      "vertex_outbox",
      scope,
      sql`event_id = ${origin["eventId"]}`
    );
    const run = await one(
      tx,
      "vertex_records",
      scope,
      sql`artifact_id = ${origin["runArtifactId"]} and contract_name = 'AgentRun'`
    );
    if (
      !(event && run) ||
      event["record_hash"] !== origin["eventSha256"] ||
      (await ctx.hash(event["payload"])) !== origin["eventSha256"] ||
      run["record_hash"] !== origin["runSha256"] ||
      run["artifact_sha256"] !== origin["runSha256"] ||
      (await ctx.hash(run["payload"])) !== origin["runSha256"] ||
      object(run["payload"])["runId"] !== plan["runId"] ||
      object(run["payload"])["status"] !== "queued" ||
      object(event["payload"])["actorId"] !== plan["ownerActorId"] ||
      object(event["payload"])["correlationId"] !== plan["traceId"] ||
      (await ctx.hash(object(event["payload"])["payload"])) !==
        origin["runSha256"] ||
      origin["jobId"] !==
        `job-${await ctx.hash({ scope, eventId: origin["eventId"] })}`
    )
      return fail("integrity");
    current(at, joined.expiresAt);
    return {
      closed: false as const,
      origin,
      ...joined,
      recipe,
      queuedMetadata,
    };
  };
  const originalForTransaction = (
    tx: Transaction,
    scope: VertexScope,
    selector: Readonly<{
      eventId?: string;
      jobId?: string;
      responseRequestId?: string;
    }>,
    at: string
  ) => originalForDomain(tx, scope, selector, at, "inputs");
  const derivedForTransaction = (
    tx: Transaction,
    scope: VertexScope,
    selector: Readonly<{
      eventId?: string;
      jobId?: string;
      responseRequestId?: string;
    }>,
    at: string
  ) => originalForDomain(tx, scope, selector, at, "derived");
  const admitWithSources = async (
    principal: VertexPrincipal,
    supplied: unknown,
    sourceInputs?: ResearchChatSourceInputs
  ): Promise<VertexRecord> => {
    // Full original approveInput is needed ONLY at this authenticated owner edge.
    // It never enters a recipe, origin, ordinary stage, outbox or command receipt.
    const captured = ctx.capture(supplied),
      command = object(object(captured)["request"]);
    const scope: Scope = {
      accountAlias: identifier(command["accountAlias"]),
      environment: "research",
    };
    if (command["environment"] !== "research") return fail("denied");
    const responseRequestId = `response-${await ctx.hash({ operation: "requestResponse", actorId: principal.actorId, scope, threadId: command["threadId"], idempotencyKey: command["idempotencyKey"] })}`;
    const requestHash = await ctx.hash({
      operation: "requestResponse",
      actorId: principal.actorId,
      input: command,
    });
    const replay = await ctx.run(
      principal,
      scope,
      null,
      "research-chat",
      "publish",
      async (tx, at) => {
        const receipt = await receipts.read(
          tx,
          principal,
          scope,
          identifier(command["threadId"]),
          identifier(command["idempotencyKey"])
        );
        if (!receipt) return null;
        if (
          receipt["status"] !== "admitted" ||
          receipt["requestSha256"] !== requestHash
        )
          return fail("conflict");
        const original = await originalForTransaction(
          tx,
          scope,
          { responseRequestId },
          at
        );
        if (!original || original.closed) return null;
        if (
          original.plan["planId"] !== object(captured)["planId"] ||
          original.plan["planSha256"] !== object(captured)["planSha256"]
        )
          return fail("conflict");
        await execution.recheckSourceInputsForTransaction(
          tx,
          original.plan,
          sourceInputs,
          ctx.now()
        );
        return receipt;
      },
      true
    );
    if (replay) return replay;
    for (const purpose of [
      "context",
      "tokenizeInput",
      "completionInput",
    ] as const) {
      const bytes = await copies.readApprovedInput(
        principal,
        captured,
        purpose,
        sourceInputs
      );
      bytes.fill(0);
    }
    const prepared = await ctx.run(
      principal,
      scope,
      null,
      "research-chat",
      "publish",
      async (tx, at) => {
        const approved = await execution.readApprovedForTransaction(
          tx,
          principal,
          captured,
          at,
          sourceInputs
        );
        for (const purpose of [
          "context",
          "tokenizeInput",
          "completionInput",
        ] as const)
          approved.prepared[purpose].fill(0);
        approved.prepared.evidenceBundle?.fill(0);
        const joined = await copies.readCurrentOriginalForTransaction(
          tx,
          scope,
          responseRequestId,
          at
        );
        if (!joined) return null;
        const { plan, selection, configuration } = joined;
        const research = object(selection["research"]),
          budgets = object(configuration["budgets"]);
        const run = await ctx.validate("AgentRun", {
          schemaVersion: "1.0.0",
          runId: plan["runId"],
          agentRole: "research",
          taskContract: plan["taskContract"],
          allowedTools: [],
          modelVersion: object(plan["provider"])["modelVersion"],
          inputEvidenceIds: array(plan["reviewPins"], 16).map(
            (pin) => object(pin)["evidenceId"]
          ),
          outputArtifactIds: [],
          tokenBudget: budgets["requestTokens"],
          costBudgetUsd: budgets["requestCostUsd"],
          status: "queued",
          errors: [],
          approvalRequests: [],
          executionAuthorized: false,
        });
        const runSha256 = await ctx.hash(run),
          runArtifactId = `chat-agent-${await ctx.hash({ responseRequestId })}`;
        const policyId = identifier(research["rightsPolicyId"]),
          collectionId = identifier(plan["collectionId"]);
        await ctx.authorize(
          principal,
          scope,
          collectionId,
          runArtifactId,
          "publish",
          ctx.now()
        );
        const rightsRow = await ctx.latestRights(
          tx,
          scope,
          collectionId,
          policyId
        );
        if (
          !rightsRow ||
          (await ctx.hash(rightsRow["payload"])) !== rightsRow["record_hash"]
        )
          return fail("denied");
        const rights = object(
          rightsRow["payload"]
        ) as unknown as VertexRightsRecord;
        await ctx.rights(tx, scope, collectionId, rights, "store", ctx.now());
        const bytes = ctx.encode(run);
        const metadata: VertexArtifactMetadata = {
          artifactId: runArtifactId,
          scope,
          collectionId,
          objectKey: vertexQualifiedObjectKey(
            scope,
            collectionId,
            "manifest",
            runSha256
          ),
          artifactSha256: runSha256,
          sourceContentSha256: null,
          byteLength: bytes.byteLength,
          contentType: "application/json",
          schemaVersion: "1.0.0",
          contractName: "AgentRun",
          rights,
          lineageArtifactIds: array(plan["reviewPins"], 16).map((pin) =>
            identifier(object(pin)["artifactId"])
          ),
          createdAt: at,
        };
        current(at, joined.expiresAt);
        return {
          run,
          metadata,
          bytes,
          at,
          recipe: recipeFor(joined, metadata),
          expiresAt: joined.expiresAt,
        };
      },
      true
    );
    if (!prepared) return fail("denied");
    const objects = options.objectCapabilities(scope);
    if (!(objects.putIfAbsent && objects.getBounded))
      return fail("unavailable");
    // Only bodyless queued provenance goes to ordinary immutable storage.
    const saved = await objects.putIfAbsent({
      key: prepared.metadata.objectKey,
      body: prepared.bytes,
      contentType: "application/json",
      checksum: prepared.metadata.artifactSha256,
    });
    if (saved.status !== "ok") return fail("unavailable");
    const read = await objects.getBounded(
      prepared.metadata.objectKey,
      1_048_576
    );
    if (
      read.status !== "ok" ||
      read.value.metadata.key !== prepared.metadata.objectKey ||
      read.value.metadata.size !== prepared.bytes.byteLength ||
      (await ctx.digest(read.value.body)) !== prepared.metadata.artifactSha256
    )
      return fail("integrity");
    const receipt = await ctx.run(
      principal,
      scope,
      null,
      "research-chat",
      "publish",
      async (tx, at) => {
        const old = await receipts.read(
          tx,
          principal,
          scope,
          identifier(command["threadId"]),
          identifier(command["idempotencyKey"])
        );
        if (old) {
          if (
            old["status"] !== "admitted" ||
            old["requestSha256"] !== requestHash
          )
            return fail("conflict");
          const original = await originalForTransaction(
            tx,
            scope,
            { responseRequestId },
            ctx.now()
          );
          if (!original || original.closed) return fail("denied");
          await execution.recheckSourceInputsForTransaction(
            tx,
            original.plan,
            sourceInputs,
            ctx.now()
          );
          return old;
        }
        const approved = await execution.readApprovedForTransaction(
          tx,
          principal,
          captured,
          at,
          sourceInputs
        );
        for (const purpose of [
          "context",
          "tokenizeInput",
          "completionInput",
        ] as const)
          approved.prepared[purpose].fill(0);
        const joined = await copies.readCurrentOriginalForTransaction(
          tx,
          scope,
          responseRequestId,
          at
        );
        if (!joined) return null;
        const { plan, approval } = joined;
        const recipe = recipeFor(joined, prepared.metadata),
          recipeSha256 = await ctx.hash(recipe);
        if (recipeSha256 !== (await ctx.hash(prepared.recipe)))
          return fail("stale");
        const eventBody = {
          schemaVersion: "1.0.0",
          eventType: "agent.recorded",
          occurredAt: prepared.at,
          effectiveAt: prepared.at,
          correlationId: plan["traceId"],
          causationId: null,
          actorId: principal.actorId,
          moduleId: "vertex-persistence",
          moduleVersion: "1.0.0",
          environment: "research",
          idempotencyKey: `chat-event-${responseRequestId}`,
          payload: prepared.run,
        };
        const event = await ctx.validate("EventEnvelope", {
          ...eventBody,
          eventId: `event-${await ctx.hash(eventBody)}`,
          receivedAt: prepared.at,
        });
        await commands.enqueueForTransaction(
          tx,
          principal,
          scope,
          plan,
          prepared.run,
          prepared.metadata,
          event,
          at
        );
        const origin = {
          profile: "vertex-research-chat-worker-origin-v1",
          ...scope,
          responseRequestId,
          ownerActorId: principal.actorId,
          requestSha256: plan["requestSha256"],
          planId: plan["planId"],
          planSha256: plan["planSha256"],
          approvalSha256: await ctx.hash(approval),
          runId: plan["runId"],
          traceId: plan["traceId"],
          runArtifactId: prepared.metadata.artifactId,
          runSha256: prepared.metadata.artifactSha256,
          eventId: event["eventId"],
          eventSha256: await ctx.hash(event),
          jobId: `job-${await ctx.hash({ scope, eventId: event["eventId"] })}`,
          recipeArtifactId: `chat-recipe-${recipeSha256}`,
          recipeSha256,
          recipe,
          contextSha256: object(plan["context"])["sha256"],
          participantConfigSha256: object(plan["participantConfiguration"])[
            "artifactSha256"
          ],
          collectionId: plan["collectionId"],
          admittedAt: at,
        };
        await insert(tx, "vertex_research_chat_worker_origins", scope, {
          response_request_id: responseRequestId,
          owner_actor_id: principal.actorId,
          plan_id: plan["planId"],
          plan_sha256: plan["planSha256"],
          run_id: plan["runId"],
          event_id: event["eventId"],
          job_id: origin.jobId,
          recipe_sha256: recipeSha256,
          record_hash: await ctx.hash(origin),
          payload: origin,
        });
        const {
          retrievalQuery: omittedQuery,
          debate: omittedStep,
          protocol: omittedProtocol,
          ...metadata
        } = command;
        const result = await receipts.save(
          tx,
          principal,
          scope,
          metadata,
          requestHash,
          at,
          true
        );
        const after = await copies.readCurrentOriginalForTransaction(
          tx,
          scope,
          responseRequestId,
          ctx.now()
        );
        if (!after) return null;
        const sourceUse = await execution.recheckSourceInputsForTransaction(
          tx,
          after.plan,
          sourceInputs,
          ctx.now()
        );
        if (sourceUse) current(at, sourceUse.expiresAt);
        current(prepared.at, prepared.expiresAt);
        current(at, after.expiresAt);
        return result;
      },
      true
    );
    if (!receipt) return fail("denied");
    return receipt;
  };
  const admitApprovedResponse = (
    principal: VertexPrincipal,
    supplied: unknown
  ): Promise<VertexRecord> => {
    return execution.withSourceInputs(
      principal,
      supplied,
      "admit",
      (sourceInputs) => admitWithSources(principal, supplied, sourceInputs)
    );
  };
  const readForDispatch = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    eventId: string
  ) => {
    const result = await ctx.run(
      principal,
      scope,
      null,
      "research-chat",
      "read",
      async (tx, at) => {
        const joined = await originalForTransaction(tx, scope, { eventId }, at);
        if (joined && joined.origin["ownerActorId"] !== principal.actorId)
          return fail("denied");
        return joined;
      },
      true
    );
    if (result?.closed) return fail("denied");
    return result;
  };
  return Object.freeze({
    admitApprovedResponse,
    originalForTransaction,
    derivedForTransaction,
    readForDispatch,
    recipeFor,
    readOriginalInput: copies.readOriginalInput,
    readNativeInput: copies.readNativeInput,
    copies,
  });
};
export type ResearchChatWorkerOperations = ReturnType<
  typeof createResearchChatWorkerOperations
>;
