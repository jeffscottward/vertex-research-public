import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import {
  array,
  fail,
  identifier,
  insert,
  object,
  one,
  type PersistenceContext,
  rows,
  string,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexPrincipal,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";
import { createQueryOperations } from "./vertex-query-store.ts";
import {
  type ChatApprovedInputs,
  type ChatPreparedInputs,
  chatExecutionTransactionContext,
  researchChatContextUseResource,
  type VertexResearchChatExecutionOptions,
} from "./vertex-research-chat-execution-ports.ts";
import { reusePredecessorRead } from "./vertex-research-chat-predecessor-walk.ts";
import type { ResearchChatSourceInputs } from "./vertex-research-chat-source-ports.ts";
import { createResearchChatOperations } from "./vertex-research-chat-store.ts";
// Request-scoped private storage evidence approvals share the review owner,
// not the public AcceptedReview/StrategySpec catalog or its foreign keys.
import { createResearchChatStorageReviewOperations } from "./vertex-research-chat-storage-review.ts";

// This owner stores metadata only. Original query/context echoes exist only in
// invocation memory until the separately governed copy writer consumes them.
// No unavailable receipt is upgraded and no model or ordinary stage is called.
export const createResearchChatExecutionOperations = (
  ctx: PersistenceContext,
  options: VertexResearchChatExecutionOptions
) => {
  const reviews = createResearchChatStorageReviewOperations(ctx, options);
  const experts = ctx.capture(options.experts);
  const firstMate =
    options.firstMate === undefined
      ? undefined
      : ctx.capture(options.firstMate);
  const nativeEvidence =
    options.nativeEvidence === undefined
      ? undefined
      : ctx.capture(options.nativeEvidence);
  const nativePlan = (plan: VertexRecord): boolean =>
    plan["format"] === "vertex-research-chat-native-evidence-plan-v1";
  const nativeRequest = (request: VertexRecord): boolean =>
    request["protocol"] === "first-mate-read-reviewed-evidence-v1";
  const nativePin = (): VertexRecord => {
    if (!nativeEvidence) return fail("unavailable");
    return object(nativeEvidence.artifact);
  };
  const requireNativeConfiguration = (
    configuration: VertexRecord,
    scope: VertexScope
  ): void => {
    if (
      configuration["format"] !==
        "vertex-research-chat-native-evidence-configuration-v1" ||
      configuration["participantId"] !== "first-mate" ||
      configuration["accountAlias"] !== scope.accountAlias ||
      configuration["environment"] !== "research" ||
      time(configuration["expiresAt"]) <= time(ctx.now())
    )
      fail("denied");
  };
  const approvalMatches = async (
    plan: VertexRecord,
    approval: VertexRecord
  ): Promise<boolean> => {
    if (nativePlan(plan))
      return (
        approval["format"] ===
          "vertex-research-chat-native-evidence-approval-v1" &&
        approval["consent"] === "approve-bounded-native-evidence-protocol-v1" &&
        approval["nativeEvidenceSha256"] ===
          (await ctx.hash(plan["nativeEvidence"]))
      );
    if (plan["format"] === "vertex-research-chat-plan-v2")
      return (
        approval["format"] === "vertex-research-chat-approval-v2" &&
        approval["debateSha256"] === (await ctx.hash(plan["debate"]))
      );
    return approval["format"] === "vertex-research-chat-approval-v1";
  };
  const disposePrepared = (prepared: ChatPreparedInputs): void => {
    for (const kind of [
      "context",
      "tokenizeInput",
      "completionInput",
      "evidenceBundle",
    ] as const)
      prepared[kind]?.fill(0);
  };
  const finalCurrent = (at: string, ...ends: readonly string[]): void => {
    const now = time(ctx.now());
    if (now < time(at) || ends.some((end) => time(end) <= now)) fail("stale");
  };
  const approvalGrantEnd = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    responseRequestId: string
  ): Promise<string> => {
    const resourceId = researchChatContextUseResource(responseRequestId);
    const at = ctx.now();
    await ctx.authorize(principal, scope, null, resourceId, "publish", at);
    const found = await rows(
      tx,
      sql`select v.payload, v.record_hash, c.current_version, c.revision from vertex_grant_bindings b join vertex_grant_current c on c.account_alias = b.account_alias and c.environment = b.environment and c.grant_id = b.grant_id join vertex_grant_versions v on v.account_alias = c.account_alias and v.environment = c.environment and v.grant_id = c.grant_id and v.version = c.current_version join vertex_grant_actions a on a.account_alias = v.account_alias and a.environment = v.environment and a.grant_id = v.grant_id and a.version = v.version where b.account_alias = ${scope.accountAlias} and b.environment = ${scope.environment} and b.grantee_actor_id = ${principal.actorId} and b.collection_key = '' and b.resource_id = ${resourceId} and a.action = ${"publish"} and v.status = 'granted' order by v.expires_at_ns desc limit 129`
    );
    if (found.length > 128) return fail("denied");
    for (const row of found) {
      const value = object(row["payload"]),
        boundScope = object(value["scope"]);
      if ((await ctx.hash(value)) !== row["record_hash"])
        return fail("integrity");
      if (
        value["granteeActorId"] === principal.actorId &&
        boundScope["accountAlias"] === scope.accountAlias &&
        boundScope["environment"] === scope.environment &&
        value["collectionId"] === null &&
        value["resourceId"] === resourceId &&
        value["status"] === "granted" &&
        array(value["actions"], 8).includes("publish") &&
        value["version"] === row["current_version"] &&
        value["revision"] === row["revision"] &&
        time(value["recordedAt"]) <= time(at) &&
        time(value["validFrom"]) <= time(at) &&
        time(value["expiresAt"]) > time(ctx.now())
      ) {
        return string(value["expiresAt"]);
      }
    }
    return fail("denied");
  };
  const validate = async (
    name: "planInput" | "approveInput" | "plan" | "approval" | "configuration",
    raw: unknown
  ): Promise<VertexRecord> => {
    const supplied = ctx.capture(raw);
    const before = await ctx.hash(supplied);
    const parsed = ctx.capture(await options.validate(name, supplied));
    if ((await ctx.hash(parsed)) !== before) return fail("invalid");
    return parsed;
  };
  const identity = async (
    principal: VertexPrincipal,
    command: VertexRecord
  ) => {
    const scope: VertexScope = {
      accountAlias: identifier(command["accountAlias"]),
      environment: "research",
    };
    if (command["environment"] !== "research") return fail("invalid");
    const requestSha256 = await ctx.hash({
      operation: "requestResponse",
      actorId: principal.actorId,
      input: command,
    });
    const responseRequestId = `response-${await ctx.hash({ operation: "requestResponse", actorId: principal.actorId, scope, threadId: command["threadId"], idempotencyKey: command["idempotencyKey"] })}`;
    return { scope, requestSha256, responseRequestId };
  };
  const readPin = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    pin: VertexRecord
  ): Promise<VertexRecord> => {
    const bytes = await options.readSelectedArtifact(tx, principal, scope, pin);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > 1_048_576 ||
      (await ctx.digest(bytes)) !== pin["artifactSha256"]
    )
      return fail("integrity");
    let value: VertexRecord;
    try {
      value = object(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      );
    } catch {
      return fail("integrity");
    }
    const canonical = ctx.encode(value);
    if (
      canonical.byteLength !== bytes.byteLength ||
      !bytes.every((byte, index) => byte === canonical[index])
    )
      return fail("integrity");
    return value;
  };
  const firstMatePin = (): VertexRecord => {
    if (!firstMate) return fail("unavailable");
    return object(firstMate.artifact);
  };
  const requireFirstMate = (
    configuration: VertexRecord,
    scope: VertexScope
  ): void => {
    if (
      configuration["format"] !==
        "vertex-research-chat-first-mate-configuration-v1" ||
      configuration["mode"] !== "single-turn-advisory" ||
      configuration["participantId"] !== "first-mate" ||
      configuration["accountAlias"] !== scope.accountAlias ||
      configuration["environment"] !== "research" ||
      scope.environment !== "research" ||
      time(configuration["expiresAt"]) <= time(ctx.now())
    )
      fail("denied");
  };
  // Configuration observation only: never corpus qualification, context consent,
  // provider readiness or permission to dispatch. Fail closed without pin leaks.
  const readFirstMateAdvisoryConfiguration = async (
    principal: VertexPrincipal,
    rawScope: VertexScope
  ) => {
    const scope = ctx.capture(rawScope);
    const unavailable = {
      status: "unavailable" as const,
      authorization: "requires-governed-prepare" as const,
      reasonCodes: ["first-mate-configuration-unavailable" as const],
    };
    try {
      const observed = await ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "read",
        async (tx, at) => {
          const configuration = await validate(
            "configuration",
            await readPin(tx, principal, scope, firstMatePin())
          );
          requireFirstMate(configuration, scope);
          await ctx.authorize(
            principal,
            scope,
            null,
            "research-chat",
            "read",
            ctx.now()
          );
          finalCurrent(at, string(configuration["expiresAt"]));
          return { at, expiresAt: string(configuration["expiresAt"]) };
        }
      );
      finalCurrent(observed.at, observed.expiresAt);
      return {
        status: "configured" as const,
        authorization: "requires-governed-prepare" as const,
        reasonCodes: ["governed-prepare-required" as const],
      };
    } catch {
      return unavailable;
    }
  };
  const resolve = async (
    tx: Transaction,
    principal: VertexPrincipal,
    command: VertexRecord,
    responseRequestId: string,
    at: string,
    sourceInputs?: ResearchChatSourceInputs
  ): Promise<
    Readonly<{
      fields: VertexRecord;
      prepared: ChatPreparedInputs;
      sourceExpiresAt?: string;
    }>
  > => {
    const scope: VertexScope = {
      accountAlias: identifier(command["accountAlias"]),
      environment: "research",
    };
    const isFirstMate = command["participantId"] === "first-mate",
      isNative = nativeRequest(command);
    if (isNative && !isFirstMate) return fail("denied");
    if (isFirstMate && command["debate"] !== undefined) return fail("denied");
    const matches = isFirstMate
      ? []
      : experts.filter(
          (entry) => entry.participantId === command["participantId"]
        );
    if (!isFirstMate && matches.length !== 1) return fail("unavailable");
    const participantConfiguration = isNative
      ? nativePin()
      : isFirstMate
        ? firstMatePin()
        : object(requirePresent(matches[0], "matches[0]").artifact);
    const configuration = await validate(
      "configuration",
      await readPin(tx, principal, scope, participantConfiguration)
    );
    if (isNative) {
      requireNativeConfiguration(configuration, scope);
    } else if (isFirstMate) requireFirstMate(configuration, scope);
    if (
      configuration["participantId"] !== command["participantId"] ||
      configuration["accountAlias"] !== scope.accountAlias ||
      configuration["environment"] !== scope.environment ||
      time(configuration["expiresAt"]) <= time(ctx.now())
    )
      return fail("denied");
    const local = chatExecutionTransactionContext(ctx, tx, at);
    const chat = createResearchChatOperations(local).executionChatOwner;
    const {
      debate: omittedStep,
      protocol: omittedProtocol,
      ...humanRequest
    } = command;
    if (omittedStep !== undefined && !options.debate)
      return fail("unavailable");
    const messages = await chat.readContext(
      tx,
      principal,
      scope,
      humanRequest,
      at
    );
    const selection = await options.readSelection(tx, principal, scope);
    if (
      selection["accountAlias"] !== scope.accountAlias ||
      selection["environment"] !== scope.environment ||
      time(selection["issuedAt"]) > time(at) ||
      time(selection["expiresAt"]) <= time(ctx.now())
    )
      return fail("denied");
    const selectedResearch = object(selection["research"]);
    if (
      selectedResearch["taskContract"] !== configuration["taskContract"] ||
      selectedResearch["modelVersion"] !==
        object(configuration["provider"])["modelVersion"]
    )
      return fail("denied");
    const retention = await options.readRetention(
      tx,
      principal,
      scope,
      selection,
      isNative
    );
    const retentionPolicy = object(retention["policy"]);
    if (
      retention["profile"] !==
        (isNative
          ? "vertex-research-chat-native-evidence-retention-observation-v1"
          : "vertex-research-chat-copy-retention-observation-v1") ||
      retention["accountAlias"] !== scope.accountAlias ||
      retention["environment"] !== scope.environment ||
      retention["observedByActorId"] !== principal.actorId ||
      retention["selectionId"] !== selection["selectionId"] ||
      retention["selectionSha256"] !== selection["selectionSha256"]
    )
      return fail("integrity");
    const requiredRules = [
      { kind: "context", cleanupTrigger: "response-attempt-terminal" },
      { kind: "model-input", cleanupTrigger: "response-attempt-terminal" },
      { kind: "derived-output", cleanupTrigger: "explicit-user-cleanup" },
      ...(isNative
        ? [
            {
              kind: "native-intermediate",
              cleanupTrigger: "response-attempt-terminal",
            },
          ]
        : []),
    ];
    if (
      (await ctx.hash(retentionPolicy["rules"])) !==
        (await ctx.hash(requiredRules)) ||
      (await ctx.hash(retentionPolicy["earlierCleanupTriggers"])) !==
        (await ctx.hash(["revocation", "rights-expiry"]))
    )
      return fail("denied");
    if (
      isNative &&
      (retentionPolicy["format"] !==
        "vertex-research-chat-native-evidence-retention-policy-v1" ||
        (await ctx.hash(retentionPolicy["nativeIntermediatePurposes"])) !==
          (await ctx.hash([
            "evidenceBundle",
            "phaseOneResponse",
            "toolResult",
            "phaseTwoTokenizeInput",
            "phaseTwoCompletionInput",
          ])))
    )
      return fail("denied");
    const queries = createQueryOperations(local);
    const evidence: VertexRecord[] = [];
    const reviewPins = array(configuration["reviewPins"], 16).map(object);
    if (
      reviewPins.length === 0 ||
      new Set(reviewPins.map((pin) => pin["evidenceId"])).size !==
        reviewPins.length
    )
      return fail("invalid");
    for (const pin of reviewPins) {
      if (pin["collectionId"] !== configuration["collectionId"])
        return fail("denied");
      const accepted = await queries.getAcceptedEvidence(
        principal,
        scope,
        identifier(configuration["collectionId"]),
        identifier(pin["evidenceId"])
      );
      if (
        !accepted ||
        accepted.artifact.artifactId !== pin["artifactId"] ||
        accepted.artifact.artifactSha256 !== pin["artifactSha256"] ||
        accepted.review["reviewId"] !== pin["reviewId"] ||
        accepted.review["reviewVersion"] !== pin["reviewVersion"] ||
        accepted.artifact.rights.policyId !== pin["rightsPolicyId"] ||
        accepted.artifact.rights.version !== pin["rightsVersion"] ||
        accepted.evidence["snapshotId"] !== configuration["snapshotId"]
      )
        return fail("denied");
      await ctx.authorize(
        { actorId: identifier(accepted.review["actorId"]) },
        scope,
        identifier(configuration["collectionId"]),
        accepted.artifact.artifactId,
        "review",
        ctx.now()
      );
      await ctx.rights(
        tx,
        scope,
        identifier(configuration["collectionId"]),
        accepted.artifact.rights,
        "derive",
        ctx.now()
      );
      // Accepted-evidence metadata is not proof of original bytes: use its real
      // object reader before pure framing. The pin remains configuration-owned.
      const original = await options.readCollectionArtifact(
        tx,
        principal,
        scope,
        identifier(configuration["collectionId"]),
        {
          artifactId: accepted.artifact.artifactId,
          artifactSha256: accepted.artifact.artifactSha256,
          contractName: "ResearchEvidence",
          schemaVersion: "1.0.0",
        }
      );
      if (
        !(original instanceof Uint8Array) ||
        (await ctx.digest(original)) !== accepted.artifact.artifactSha256 ||
        (await ctx.hash(accepted.evidence)) !== accepted.artifact.artifactSha256
      )
        return fail("integrity");
      const current = await queries.getAcceptedEvidence(
        principal,
        scope,
        identifier(configuration["collectionId"]),
        identifier(pin["evidenceId"])
      );
      if (!current || (await ctx.hash(current)) !== (await ctx.hash(accepted)))
        return fail("stale");
      evidence.push({
        artifact: accepted.artifact,
        evidence: accepted.evidence,
        review: accepted.review,
      });
    }
    const debatePrepared =
      omittedStep === undefined
        ? undefined
        : await requirePresent(
            options.debate,
            "options.debate"
          ).prepareForTransaction(
            tx,
            principal,
            scope,
            {
              request: command,
              responseRequestId,
              configuration,
              messages,
              selection,
              ...(sourceInputs === undefined ? {} : { sourceInputs }),
            },
            at
          );
    let prepared: ChatPreparedInputs;
    try {
      prepared = await options.prepareInputs(tx, principal, scope, {
        request: command,
        ownerActorId: principal.actorId,
        responseRequestId,
        configuration,
        participantConfiguration,
        messages,
        evidence,
        selection,
        ...(debatePrepared ? { debatePrepared } : {}),
      });
    } finally {
      for (const source of debatePrepared?.sources ?? []) source.bytes?.fill(0);
    }
    const descriptors: Record<string, unknown> = {};
    for (const purpose of [
      "context",
      "tokenizeInput",
      "completionInput",
    ] as const) {
      const bytes = prepared[purpose];
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 1 ||
        bytes.byteLength > 1_048_576
      )
        return fail("invalid");
      descriptors[purpose] = {
        sha256: await ctx.digest(bytes),
        byteLength: bytes.byteLength,
      };
    }
    if (isNative) {
      const bundle = prepared.evidenceBundle,
        descriptor = object(
          object(prepared.fields["nativeEvidence"])["bundle"]
        );
      if (
        !(bundle instanceof Uint8Array) ||
        bundle.byteLength < 1 ||
        bundle.byteLength > 262_144 ||
        descriptor["byteLength"] !== bundle.byteLength ||
        descriptor["sha256"] !== (await ctx.digest(bundle))
      )
        return fail("integrity");
      const { bundle: omittedBundle, ...protocol } = object(
        prepared.fields["nativeEvidence"]
      );
      if (
        (await ctx.hash(protocol)) !==
        (await ctx.hash(configuration["nativeEvidence"]))
      )
        return fail("integrity");
    } else if (
      prepared.evidenceBundle !== undefined ||
      prepared.fields["nativeEvidence"] !== undefined
    )
      return fail("integrity");
    // Output of the pure builder is data, not permission. Authoritative source
    // fields below overwrite it and the strict plan schema rejects extra text.
    const fields = {
      ...prepared.fields,
      participantConfiguration,
      collectionId: configuration["collectionId"],
      snapshotId: configuration["snapshotId"],
      reviewPins,
      selectionId: selection["selectionId"],
      selectionSha256: selection["selectionSha256"],
      retentionArtifact: retention["artifact"],
      retentionSha256: await ctx.hash(retentionPolicy),
      storageEvidence: options.storage.evidence,
      capabilityReferenceId: options.storage.capabilityReferenceId,
      backendDeploymentId: options.storage.backendDeploymentId,
      storageProfileSha256: options.storage.storageProfileSha256,
      provider: configuration["provider"],
      taskContract: configuration["taskContract"],
      advisoryMaximumBytes: configuration["advisoryMaximumBytes"],
      ...descriptors,
    };
    return {
      fields,
      prepared,
      ...(debatePrepared
        ? { sourceExpiresAt: debatePrepared.useExpiresAt }
        : {}),
    };
  };
  const withSourceInputs = async <T>(
    principal: VertexPrincipal,
    raw: unknown,
    purpose: string,
    operation: (inputs?: ResearchChatSourceInputs) => Promise<T>
  ): Promise<T> => {
    const captured = ctx.capture(raw),
      approving = Object.hasOwn(object(captured), "request");
    const supplied = await validate(
        approving ? "approveInput" : "planInput",
        captured
      ),
      command = approving ? object(supplied["request"]) : supplied;
    if (command["debate"] === undefined) return operation();
    if (!options.debate) return fail("unavailable");
    const inputs = await options.debate.prepareSourceInputs(
      ctx.capture(principal),
      command,
      purpose,
      approving ? string(supplied["planSha256"]) : null
    );
    try {
      return await operation(inputs);
    } finally {
      options.debate.disposeSourceInputs(inputs);
    }
  };
  const planWithSources = async (
    principal: VertexPrincipal,
    raw: unknown,
    sourceInputs?: ResearchChatSourceInputs
  ): Promise<VertexRecord> => {
    const command = await validate("planInput", raw);
    const { scope, requestSha256, responseRequestId } = await identity(
      principal,
      command
    );
    return ctx.run(
      principal,
      scope,
      null,
      "research-chat",
      "publish",
      async (tx, at) => {
        await ctx.authorize(
          principal,
          scope,
          null,
          "research-chat",
          "read",
          at
        );
        const chat = createResearchChatOperations(
          chatExecutionTransactionContext(ctx, tx, at)
        ).executionChatOwner;
        const old = await chat.readResponse(
          tx,
          principal,
          scope,
          identifier(command["threadId"]),
          identifier(command["idempotencyKey"])
        );
        if (old) return fail("conflict");
        const prior = await one(
          tx,
          "vertex_research_chat_execution_plans",
          scope,
          sql`response_request_id = ${responseRequestId}`
        );
        if (prior) {
          if (
            prior["request_sha256"] !== requestSha256 ||
            prior["owner_actor_id"] !== principal.actorId
          )
            return fail("conflict");
          const existing = await reviews.plan(
            tx,
            scope,
            responseRequestId,
            string(prior["plan_id"]),
            string(prior["plan_sha256"])
          );
          if (existing["format"] === "vertex-research-chat-plan-v2")
            await requirePresent(
              options.debate,
              "options.debate"
            ).recheckSourceInputsForTransaction(
              tx,
              principal,
              existing,
              sourceInputs,
              ctx.now()
            );
          return existing;
        }
        const resolved = await resolve(
          tx,
          principal,
          command,
          responseRequestId,
          at,
          sourceInputs
        );
        disposePrepared(resolved.prepared);
        const {
          retrievalQuery: omittedQuery,
          debate: omittedStep,
          protocol: omittedProtocol,
          ...metadata
        } = command;
        const body = {
          schemaVersion: "1.0.0",
          format: nativeRequest(command)
            ? "vertex-research-chat-native-evidence-plan-v1"
            : omittedStep === undefined
              ? "vertex-research-chat-plan-v1"
              : "vertex-research-chat-plan-v2",
          ...metadata,
          ownerActorId: principal.actorId,
          responseRequestId,
          requestSha256,
          ...resolved.fields,
          plannedAt: at,
          executionAuthorized: false,
        };
        const planSha256 = await ctx.hash(body);
        const value = await validate("plan", {
          ...body,
          planId: `chat-plan-${planSha256}`,
          planSha256,
        });
        // Descriptive evidence read only. Acceptance deliberately follows plan
        // hashing: no accepted-review/plan cyclic hash and no copy before consent.
        await reviews.evidence(tx, principal, scope, value, at);
        if (time(value["expiresAt"]) <= time(ctx.now())) return fail("stale");
        await insert(tx, "vertex_research_chat_execution_plans", scope, {
          response_request_id: responseRequestId,
          owner_actor_id: principal.actorId,
          thread_id: command["threadId"],
          idempotency_key: command["idempotencyKey"],
          request_sha256: requestSha256,
          plan_id: value["planId"],
          plan_sha256: planSha256,
          storage_evidence_artifact_id: object(value["storageEvidence"])[
            "artifactId"
          ],
          storage_evidence_sha256: object(value["storageEvidence"])[
            "artifactSha256"
          ],
          record_hash: await ctx.hash(value),
          payload: value,
        });
        // Final transactional I/O may cross a grant/report deadline. Reuse the
        // original evidence owner, then sample all retained input bounds.
        await reviews.evidence(tx, principal, scope, value, ctx.now());
        finalCurrent(
          at,
          string(value["expiresAt"]),
          ...(resolved.sourceExpiresAt ? [resolved.sourceExpiresAt] : [])
        );
        return value;
      },
      true
    );
  };
  const planResearchChatResponse = (
    principal: VertexPrincipal,
    raw: unknown
  ): Promise<VertexRecord> => {
    return withSourceInputs(principal, raw, "plan", (inputs) =>
      planWithSources(principal, raw, inputs)
    );
  };
  // Private descriptive preview join. It never creates approval, qualification,
  // copies or a response receipt. The existing planner owns all original pins;
  // a current re-resolution must equal them, never replace them with a new head.
  const readPlannedForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    raw: unknown,
    at: string,
    sourceInputs?: ResearchChatSourceInputs
  ) => {
    const request = await validate("planInput", raw);
    const { scope, requestSha256, responseRequestId } = await identity(
      principal,
      request
    );
    await ctx.authorize(principal, scope, null, "account-scope", "read", at);
    await ctx.authorize(principal, scope, null, "research-chat", "read", at);
    await ctx.authorize(principal, scope, null, "research-chat", "publish", at);
    const row = await one(
      tx,
      "vertex_research_chat_execution_plans",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!row) return fail("unavailable");
    const plan = await reviews.plan(
      tx,
      scope,
      responseRequestId,
      string(row["plan_id"]),
      string(row["plan_sha256"])
    );
    if (
      plan["ownerActorId"] !== principal.actorId ||
      plan["requestSha256"] !== requestSha256 ||
      plan["threadId"] !== request["threadId"]
    )
      return fail("conflict");
    finalCurrent(at, string(plan["expiresAt"]));
    let prepared: ChatPreparedInputs | null = null;
    let finalPrepared: ChatPreparedInputs | null = null;
    try {
      const original = await resolve(
        tx,
        principal,
        request,
        responseRequestId,
        ctx.now(),
        sourceInputs
      );
      prepared = original.prepared;
      for (const [key, value] of Object.entries(original.fields)) {
        if ((await ctx.hash(value)) !== (await ctx.hash(plan[key])))
          return fail("stale");
      }
      const retentionPolicy = await readPin(
        tx,
        principal,
        scope,
        object(plan["retentionArtifact"])
      );
      if ((await ctx.hash(retentionPolicy)) !== plan["retentionSha256"])
        return fail("integrity");
      const provider = object(plan["provider"]);
      const tokenizeEndpoint = await readPin(
        tx,
        principal,
        scope,
        object(provider["tokenizeEndpoint"])
      );
      const completionEndpoint = await readPin(
        tx,
        principal,
        scope,
        object(provider["completionEndpoint"])
      );
      const storage = await reviews.evidence(
        tx,
        principal,
        scope,
        plan,
        ctx.now()
      );
      const final = await resolve(
        tx,
        principal,
        request,
        responseRequestId,
        ctx.now(),
        sourceInputs
      );
      finalPrepared = final.prepared;
      for (const [key, value] of Object.entries(final.fields)) {
        if ((await ctx.hash(value)) !== (await ctx.hash(plan[key])))
          return fail("stale");
      }
      const lastStorage = await reviews.evidence(
        tx,
        principal,
        scope,
        plan,
        ctx.now()
      );
      if (
        (await ctx.hash(lastStorage.value)) !== (await ctx.hash(storage.value))
      )
        return fail("integrity");
      const ends = [
        time(plan["expiresAt"]),
        ...storage.bounds,
        ...lastStorage.bounds,
        ...(final.sourceExpiresAt ? [time(final.sourceExpiresAt)] : []),
      ];
      const notAfterNs = ends.reduce((left, right) =>
        left <= right ? left : right
      );
      const now = time(ctx.now());
      if (now < time(at) || notAfterNs <= now) return fail("stale");
      return {
        plan,
        request,
        prepared,
        retentionPolicy,
        storageEvidence: storage.value,
        tokenizeEndpoint,
        completionEndpoint,
        notAfterNs: notAfterNs.toString(),
      };
    } catch (error) {
      if (prepared) disposePrepared(prepared);
      throw error;
    } finally {
      if (finalPrepared) disposePrepared(finalPrepared);
    }
  };
  const approveWithSources = async (
    principal: VertexPrincipal,
    raw: unknown,
    sourceInputs?: ResearchChatSourceInputs
  ): Promise<VertexRecord> => {
    const supplied = await validate("approveInput", raw);
    const command = object(supplied["request"]);
    const { scope, requestSha256, responseRequestId } = await identity(
      principal,
      command
    );
    return ctx.run(
      principal,
      scope,
      null,
      researchChatContextUseResource(responseRequestId),
      "publish",
      async (tx, at) => {
        const selected = await reviews.plan(
          tx,
          scope,
          responseRequestId,
          identifier(supplied["planId"]),
          string(supplied["planSha256"])
        );
        // This comparison MUST precede reconstructing or using the query echo.
        if (
          selected["ownerActorId"] !== principal.actorId ||
          selected["requestSha256"] !== requestSha256 ||
          selected["threadId"] !== command["threadId"]
        )
          return fail("conflict");
        if (
          nativePlan(selected) !== nativeRequest(command) ||
          (nativePlan(selected) &&
            supplied["consent"] !==
              "approve-bounded-native-evidence-protocol-v1")
        )
          return fail("denied");
        const grantExpiresAt = await approvalGrantEnd(
          tx,
          principal,
          scope,
          responseRequestId
        );
        await ctx.authorize(
          principal,
          scope,
          null,
          "research-chat",
          "read",
          at
        );
        await ctx.authorize(
          principal,
          scope,
          null,
          "research-chat",
          "publish",
          at
        );
        const old = await createResearchChatOperations(
          chatExecutionTransactionContext(ctx, tx, at)
        ).executionChatOwner.readResponse(
          tx,
          principal,
          scope,
          identifier(command["threadId"]),
          identifier(command["idempotencyKey"])
        );
        if (old) return fail("conflict");
        if (time(selected["expiresAt"]) <= time(ctx.now()))
          return fail("stale");
        const storageReview =
          await reviews.readResearchChatStorageQualificationForTransaction(
            tx,
            principal,
            scope,
            selected,
            at
          );
        const prior = await one(
          tx,
          "vertex_research_chat_execution_approvals",
          scope,
          sql`response_request_id = ${responseRequestId}`
        );
        if (prior) {
          const value = await validate("approval", prior["payload"]);
          if (
            (await ctx.hash(value)) !== prior["record_hash"] ||
            value["planSha256"] !== selected["planSha256"] ||
            value["storageReviewId"] !== storageReview["reviewId"] ||
            value["storageReviewSha256"] !== (await ctx.hash(storageReview))
          )
            return fail("conflict");
          if (!(await approvalMatches(selected, value)))
            return fail("integrity");
          if (selected["format"] === "vertex-research-chat-plan-v2") {
            await currentDebate(tx, scope, selected, ctx.now());
            await requirePresent(
              options.debate,
              "options.debate"
            ).recheckSourceInputsForTransaction(
              tx,
              principal,
              selected,
              sourceInputs,
              ctx.now()
            );
          }
          const current =
            await reviews.readResearchChatStorageQualificationForTransaction(
              tx,
              principal,
              scope,
              selected,
              ctx.now()
            );
          if (current["reviewId"] !== storageReview["reviewId"])
            return fail("stale");
          finalCurrent(at, string(selected["expiresAt"]), grantExpiresAt);
          return value;
        }
        // Observe current authority/thread state, never the immutable plan's clock.
        // The echoed request and every resolved pin below still match that plan;
        // later human appends do not rebase its exact parent/high-water prefix.
        const resolved = await resolve(
          tx,
          principal,
          command,
          responseRequestId,
          ctx.now(),
          sourceInputs
        );
        disposePrepared(resolved.prepared);
        for (const [key, value] of Object.entries(resolved.fields)) {
          if ((await ctx.hash(value)) !== (await ctx.hash(selected[key])))
            return fail("stale");
        }
        const {
          retrievalQuery: omittedQuery,
          debate: omittedStep,
          protocol: omittedProtocol,
          ...metadata
        } = command;
        if (omittedStep !== undefined) {
          if (
            !options.debate ||
            selected["format"] !== "vertex-research-chat-plan-v2"
          )
            return fail("denied");
          await options.debate.reserveForTransaction(
            tx,
            scope,
            selected,
            ctx.now()
          );
        }
        const approval = await validate("approval", {
          format: nativePlan(selected)
            ? "vertex-research-chat-native-evidence-approval-v1"
            : omittedStep === undefined
              ? "vertex-research-chat-approval-v1"
              : "vertex-research-chat-approval-v2",
          schemaVersion: "1.0.0",
          ...metadata,
          ...(nativePlan(selected)
            ? {
                consent: supplied["consent"],
                nativeEvidenceSha256: await ctx.hash(
                  selected["nativeEvidence"]
                ),
              }
            : {}),
          ...(omittedStep === undefined
            ? {}
            : { debateSha256: await ctx.hash(selected["debate"]) }),
          approvedAt: at,
          executionAuthorized: false,
          ownerActorId: principal.actorId,
          planId: selected["planId"],
          planSha256: selected["planSha256"],
          requestSha256,
          responseRequestId,
          storageReviewId: storageReview["reviewId"],
          storageReviewSha256: await ctx.hash(storageReview),
        });
        await ctx.authorize(
          principal,
          scope,
          null,
          researchChatContextUseResource(responseRequestId),
          "publish",
          ctx.now()
        );
        await insert(tx, "vertex_research_chat_execution_approvals", scope, {
          response_request_id: responseRequestId,
          plan_id: selected["planId"],
          plan_sha256: selected["planSha256"],
          owner_actor_id: principal.actorId,
          storage_review_id: storageReview["reviewId"],
          record_hash: await ctx.hash(approval),
          payload: approval,
        });
        const current =
          await reviews.readResearchChatStorageQualificationForTransaction(
            tx,
            principal,
            scope,
            selected,
            ctx.now()
          );
        if (current["reviewId"] !== storageReview["reviewId"])
          return fail("stale");
        if (selected["format"] === "vertex-research-chat-plan-v2")
          await requirePresent(
            options.debate,
            "options.debate"
          ).recheckSourceInputsForTransaction(
            tx,
            principal,
            selected,
            sourceInputs,
            ctx.now()
          );
        finalCurrent(
          at,
          string(selected["expiresAt"]),
          grantExpiresAt,
          ...(resolved.sourceExpiresAt ? [resolved.sourceExpiresAt] : [])
        );
        return approval;
      },
      true
    );
  };
  const approveResearchChatResponse = (
    principal: VertexPrincipal,
    raw: unknown
  ): Promise<VertexRecord> => {
    return withSourceInputs(principal, raw, "approve", (inputs) =>
      approveWithSources(principal, raw, inputs)
    );
  };
  // Private lifecycle join; replay of an approval is not current copy authority.
  // Reconstruct exact originals every time, before and AFTER external copy I/O.
  const readApprovedForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    raw: unknown,
    at: string,
    sourceInputs?: ResearchChatSourceInputs
  ): Promise<ChatApprovedInputs> => {
    const supplied = await validate("approveInput", raw),
      command = object(supplied["request"]);
    const { scope, requestSha256, responseRequestId } = await identity(
      principal,
      command
    );
    const selected = await reviews.plan(
      tx,
      scope,
      responseRequestId,
      identifier(supplied["planId"]),
      string(supplied["planSha256"])
    );
    // Do not use a query echo until it matches the persisted original request.
    if (
      selected["ownerActorId"] !== principal.actorId ||
      selected["requestSha256"] !== requestSha256 ||
      selected["threadId"] !== command["threadId"]
    )
      return fail("conflict");
    const row = await one(
      tx,
      "vertex_research_chat_execution_approvals",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!row) return fail("denied");
    const approval = await validate("approval", row["payload"]);
    if (
      (await ctx.hash(approval)) !== row["record_hash"] ||
      row["owner_actor_id"] !== principal.actorId ||
      row["plan_id"] !== selected["planId"] ||
      row["plan_sha256"] !== selected["planSha256"] ||
      row["storage_review_id"] !== approval["storageReviewId"]
    )
      return fail("integrity");
    if (!(await approvalMatches(selected, approval))) return fail("integrity");
    if (
      nativePlan(selected) !== nativeRequest(command) ||
      (nativePlan(selected) &&
        supplied["consent"] !== "approve-bounded-native-evidence-protocol-v1")
    )
      return fail("denied");
    const {
      retrievalQuery: omittedQuery,
      debate: omittedStep,
      protocol: omittedProtocol,
      ...metadata
    } = command;
    if (
      omittedStep !== undefined &&
      (selected["format"] !== "vertex-research-chat-plan-v2" ||
        approval["format"] !== "vertex-research-chat-approval-v2" ||
        approval["debateSha256"] !== (await ctx.hash(selected["debate"])))
    )
      return fail("integrity");
    for (const [key, value] of Object.entries({
      ...metadata,
      ownerActorId: principal.actorId,
      responseRequestId,
      requestSha256,
      planId: selected["planId"],
      planSha256: selected["planSha256"],
    })) {
      if (approval[key] !== value) return fail("integrity");
    }
    if (
      time(approval["approvedAt"]) < time(selected["plannedAt"]) ||
      time(approval["approvedAt"]) > time(at)
    )
      return fail("stale");
    const grantExpiresAt = await approvalGrantEnd(
      tx,
      principal,
      scope,
      responseRequestId
    );
    await ctx.authorize(
      principal,
      scope,
      null,
      "research-chat",
      "read",
      ctx.now()
    );
    await ctx.authorize(
      principal,
      scope,
      null,
      "research-chat",
      "publish",
      ctx.now()
    );
    const old = await createResearchChatOperations(
      chatExecutionTransactionContext(ctx, tx, at)
    ).executionChatOwner.readResponse(
      tx,
      principal,
      scope,
      identifier(command["threadId"]),
      identifier(command["idempotencyKey"])
    );
    if (old) return fail("conflict");
    finalCurrent(at, string(selected["expiresAt"]), grantExpiresAt);
    if (
      selected["format"] === "vertex-research-chat-plan-v2" &&
      sourceInputs?.request.planSha256 !== selected["planSha256"]
    )
      return fail("denied");
    const resolved = await resolve(
      tx,
      principal,
      command,
      responseRequestId,
      ctx.now(),
      sourceInputs
    );
    for (const [key, value] of Object.entries(resolved.fields)) {
      if ((await ctx.hash(value)) !== (await ctx.hash(selected[key])))
        return fail("stale");
    }
    const review =
      await reviews.readResearchChatStorageQualificationForTransaction(
        tx,
        principal,
        scope,
        selected,
        ctx.now()
      );
    if (
      approval["storageReviewId"] !== review["reviewId"] ||
      approval["storageReviewSha256"] !== (await ctx.hash(review))
    )
      return fail("denied");
    const debateEnd =
      selected["format"] === "vertex-research-chat-plan-v2"
        ? await currentDebate(tx, scope, selected, at)
        : string(selected["expiresAt"]);
    const expiresAt = [
      string(selected["expiresAt"]),
      grantExpiresAt,
      string(review["expiresAt"]),
      debateEnd,
      ...(resolved.sourceExpiresAt ? [resolved.sourceExpiresAt] : []),
    ].reduce((a, b) => (time(a) <= time(b) ? a : b));
    finalCurrent(at, expiresAt);
    return {
      scope: { accountAlias: scope.accountAlias, environment: "research" },
      request: command,
      plan: selected,
      approval,
      prepared: resolved.prepared,
      expiresAt,
    };
  };
  // Worker continuation consumes the ORIGINAL stored approval, not a fabricated
  // approveInput/query. Copied content is verified by the lifecycle owner; this
  // join rechecks current original policy/review/rights and owner permissions.
  const readCurrentOriginalOnce = async (
    tx: Transaction,
    scope: VertexScope,
    responseRequestId: string,
    at: string
  ) => {
    if (scope.environment !== "research") return fail("denied");
    const row = await one(
      tx,
      "vertex_research_chat_execution_plans",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!row) return fail("denied");
    const plan = await reviews.plan(
      tx,
      scope,
      responseRequestId,
      identifier(row["plan_id"]),
      string(row["plan_sha256"])
    );
    const principal = { actorId: identifier(plan["ownerActorId"]) };
    const approved = await one(
      tx,
      "vertex_research_chat_execution_approvals",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!approved) return fail("denied");
    const approval = await validate("approval", approved["payload"]);
    if (
      (await ctx.hash(approval)) !== approved["record_hash"] ||
      approved["owner_actor_id"] !== principal.actorId ||
      approved["plan_id"] !== plan["planId"] ||
      approved["plan_sha256"] !== plan["planSha256"] ||
      approved["storage_review_id"] !== approval["storageReviewId"]
    )
      return fail("integrity");
    for (const key of [
      "accountAlias",
      "environment",
      "ownerActorId",
      "responseRequestId",
      "requestSha256",
      "planId",
      "planSha256",
      "threadId",
      "parentMessageId",
      "participantId",
      "snapshotRevision",
      "contextStartSequence",
      "idempotencyKey",
    ]) {
      if (approval[key] !== plan[key]) return fail("integrity");
    }
    if (
      time(approval["approvedAt"]) < time(plan["plannedAt"]) ||
      time(approval["approvedAt"]) > time(at)
    )
      return fail("stale");
    const grantExpiresAt = await approvalGrantEnd(
      tx,
      principal,
      scope,
      responseRequestId
    );
    await ctx.authorize(
      principal,
      scope,
      null,
      "research-chat",
      "read",
      ctx.now()
    );
    await ctx.authorize(
      principal,
      scope,
      null,
      "research-chat",
      "publish",
      ctx.now()
    );
    const local = chatExecutionTransactionContext(ctx, tx, at);
    await createResearchChatOperations(local).readResearchChatThread(
      principal,
      scope,
      identifier(plan["threadId"])
    );
    const configuration = await validate(
      "configuration",
      await readPin(
        tx,
        principal,
        scope,
        object(plan["participantConfiguration"])
      )
    );
    if (plan["participantId"] === "first-mate") {
      if (
        plan["debate"] !== undefined ||
        (await ctx.hash(nativePlan(plan) ? nativePin() : firstMatePin())) !==
          (await ctx.hash(plan["participantConfiguration"]))
      )
        return fail("denied");
      if (nativePlan(plan)) {
        requireNativeConfiguration(configuration, scope);
      } else {
        if (plan["format"] !== "vertex-research-chat-plan-v1")
          return fail("denied");
        requireFirstMate(configuration, scope);
      }
    }
    if (
      configuration["participantId"] !== plan["participantId"] ||
      configuration["accountAlias"] !== scope.accountAlias ||
      configuration["environment"] !== scope.environment ||
      configuration["collectionId"] !== plan["collectionId"] ||
      configuration["snapshotId"] !== plan["snapshotId"] ||
      configuration["taskContract"] !== plan["taskContract"] ||
      (await ctx.hash(configuration["provider"])) !==
        (await ctx.hash(plan["provider"])) ||
      (await ctx.hash(configuration["reviewPins"])) !==
        (await ctx.hash(plan["reviewPins"])) ||
      (await ctx.hash(configuration["modelPolicy"])) !==
        (await ctx.hash(object(plan["inputPolicy"])["modelPolicy"]))
    )
      return fail("integrity");
    if (nativePlan(plan)) {
      const { bundle: omittedBundle, ...protocol } = object(
        plan["nativeEvidence"]
      );
      if (
        (await ctx.hash(protocol)) !==
        (await ctx.hash(configuration["nativeEvidence"]))
      )
        return fail("integrity");
    } else if (configuration["nativeEvidence"] !== undefined)
      return fail("integrity");
    const selection = await options.readSelection(tx, principal, scope);
    if (
      selection["selectionId"] !== plan["selectionId"] ||
      selection["selectionSha256"] !== plan["selectionSha256"]
    )
      return fail("stale");
    const retention = await options.readRetention(
      tx,
      principal,
      scope,
      selection,
      nativePlan(plan)
    );
    if (
      (await ctx.hash(retention["artifact"])) !==
        (await ctx.hash(plan["retentionArtifact"])) ||
      (await ctx.hash(retention["policy"])) !== plan["retentionSha256"]
    )
      return fail("stale");
    const queries = createQueryOperations(local);
    for (const pin of array(plan["reviewPins"], 16).map(object)) {
      const accepted = await queries.getAcceptedEvidence(
        principal,
        scope,
        identifier(plan["collectionId"]),
        identifier(pin["evidenceId"])
      );
      if (
        !accepted ||
        accepted.artifact.artifactId !== pin["artifactId"] ||
        accepted.artifact.artifactSha256 !== pin["artifactSha256"] ||
        accepted.review["reviewId"] !== pin["reviewId"] ||
        accepted.review["reviewVersion"] !== pin["reviewVersion"] ||
        accepted.artifact.rights.policyId !== pin["rightsPolicyId"] ||
        accepted.artifact.rights.version !== pin["rightsVersion"] ||
        accepted.evidence["snapshotId"] !== plan["snapshotId"]
      )
        return fail("denied");
      await ctx.authorize(
        { actorId: identifier(accepted.review["actorId"]) },
        scope,
        identifier(plan["collectionId"]),
        accepted.artifact.artifactId,
        "review",
        ctx.now()
      );
      await ctx.rights(
        tx,
        scope,
        identifier(plan["collectionId"]),
        accepted.artifact.rights,
        "derive",
        ctx.now()
      );
      await ctx.rights(
        tx,
        scope,
        identifier(plan["collectionId"]),
        accepted.artifact.rights,
        "export",
        ctx.now()
      );
    }
    const review =
      await reviews.readResearchChatStorageQualificationForTransaction(
        tx,
        principal,
        scope,
        plan,
        ctx.now()
      );
    if (
      approval["storageReviewId"] !== review["reviewId"] ||
      approval["storageReviewSha256"] !== (await ctx.hash(review))
    )
      return fail("denied");
    if (!(await approvalMatches(plan, approval))) return fail("integrity");
    const debateEnd =
      plan["format"] === "vertex-research-chat-plan-v2"
        ? await currentDebate(tx, scope, plan, at)
        : string(plan["expiresAt"]);
    const expiresAt = [
      string(plan["expiresAt"]),
      grantExpiresAt,
      string(review["expiresAt"]),
      string(configuration["expiresAt"]),
      string(selection["expiresAt"]),
      debateEnd,
    ].reduce((a, b) => (time(a) <= time(b) ? a : b));
    finalCurrent(at, expiresAt);
    return { plan, approval, configuration, selection, expiresAt };
  };
  // An earlier debate turn's currency check reads its original several times
  // (eligibility, inspection, fence ACKs, live proof). Inside one predecessor
  // walk (withPredecessorWalk) a completed read is reused after the same final
  // clock checks as a fresh read. Copy-lifecycle callers still check domain
  // closure and authority loss afresh before each use. Outside a walk every
  // call reads again.
  const readCurrentOriginalForTransaction = (
    tx: Transaction,
    scope: VertexScope,
    responseRequestId: string,
    at: string
  ) =>
    reusePredecessorRead(
      tx,
      readCurrentOriginalOnce,
      JSON.stringify([
        scope.accountAlias,
        scope.environment,
        responseRequestId,
      ]),
      () => readCurrentOriginalOnce(tx, scope, responseRequestId, at),
      (kept) => {
        if (time(kept.approval["approvedAt"]) > time(at)) fail("stale");
        finalCurrent(at, kept.expiresAt);
      }
    );
  const currentDebate = async (
    tx: Transaction,
    scope: VertexScope,
    plan: VertexRecord,
    at: string
  ): Promise<string> => {
    if (!options.debate) return fail("unavailable");
    await options.debate.requireReservationForTransaction(tx, scope, plan);
    return options.debate.currentForTransaction(tx, scope, plan, at);
  };
  const recheckSourceInputsForTransaction = (
    tx: Transaction,
    plan: VertexRecord,
    inputs: ResearchChatSourceInputs | undefined,
    at: string
  ) => {
    if (plan["format"] !== "vertex-research-chat-plan-v2")
      return Promise.resolve(null);
    if (!options.debate) return fail("unavailable");
    return options.debate.recheckSourceInputsForTransaction(
      tx,
      { actorId: identifier(plan["ownerActorId"]) },
      plan,
      inputs,
      at
    );
  };
  return {
    planResearchChatResponse,
    readPlannedForTransaction,
    approveResearchChatResponse,
    readApprovedForTransaction,
    readCurrentOriginalForTransaction,
    withSourceInputs,
    recheckSourceInputsForTransaction,
    readFirstMateAdvisoryConfiguration,
    ...reviews,
  };
};
