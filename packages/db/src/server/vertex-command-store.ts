import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import { validateVertexCommand } from "./vertex-command-input.ts";
import { createOutboxOperations } from "./vertex-outbox-store.ts";
import {
  array,
  collectionId,
  collectionKey,
  digestString,
  fail,
  identifier,
  insert,
  object,
  one,
  type PersistenceContext,
  rows,
  scopeWhere,
  sequence,
  string,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexAction,
  VertexArtifactMetadata,
  VertexCommandKey,
  VertexCommandPolicyIdentity,
  VertexPrincipal,
  VertexRecord,
  VertexScope,
  VertexStore,
} from "./vertex-ports.ts";
import { createProjectionOperations } from "./vertex-projection-store.ts";
import { createResearchOperations } from "./vertex-research-store.ts";
import { createReviewOperations } from "./vertex-review-store.ts";

type CommandOperations = Pick<
  VertexStore,
  | "getCommandReceipt"
  | "recordReviewedEvidence"
  | "enqueueResearchProposal"
  | "queuePaperSimulation"
>;
type Loaded = Readonly<{
  metadata: VertexArtifactMetadata;
  value: VertexRecord;
}>;
const policyIdentity = (raw: unknown): VertexCommandPolicyIdentity => {
  const value = object(raw);
  if (
    Object.keys(value).length !== 4 ||
    ["selectionId", "selectionSha256", "selectionRevision", "revision"].some(
      (field) => !Object.hasOwn(value, field)
    )
  )
    return fail("invalid");
  sequence(value["selectionRevision"]);
  sequence(value["revision"]);
  return Object.freeze({
    selectionId: identifier(value["selectionId"]),
    selectionSha256: digestString(value["selectionSha256"]),
    selectionRevision: string(value["selectionRevision"]),
    revision: string(value["revision"]),
  });
};

// Internal helpers only: the caller supplies the existing locked transaction
// after current chat authorization and owned-thread verification. This isolated
// profile is deliberately NOT a legacy VertexCommandKey or a policy callback.
export const createResearchChatResponseReceiptOperations = (
  ctx: PersistenceContext
) => {
  const kind = "research-chat-response";
  const profile = "vertex-research-chat-response-command-v1";
  const metadataKeys = [
    "accountAlias",
    "environment",
    "threadId",
    "parentMessageId",
    "participantId",
    "snapshotRevision",
    "contextStartSequence",
    "idempotencyKey",
  ] as const;
  const exactMetadata = (
    value: unknown,
    keys: readonly string[]
  ): VertexRecord => {
    const result = object(value);
    if (
      Object.keys(result).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(result, key))
    )
      return fail("integrity");
    return result;
  };
  const identity = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string,
    idempotencyKey: string
  ): Promise<string> => {
    return `response-${await ctx.hash({ operation: "requestResponse", actorId: principal.actorId, scope, threadId, idempotencyKey })}`;
  };
  const expectedReceipt = (
    principal: VertexPrincipal,
    scope: VertexScope,
    metadata: VertexRecord,
    physicalKey: string,
    requestHash: string,
    at: string
  ): VertexRecord => {
    return {
      schemaVersion: "1.0.0",
      executionAuthorized: false,
      ...scope,
      threadId: metadata["threadId"],
      ownerActorId: principal.actorId,
      responseRequestId: physicalKey,
      parentMessageId: metadata["parentMessageId"],
      participantId: metadata["participantId"],
      idempotencyKey: metadata["idempotencyKey"],
      requestSha256: requestHash,
      recordedAt: at,
      snapshotRevision: metadata["snapshotRevision"],
      contextStartSequence: metadata["contextStartSequence"],
      status: "unavailable",
      reasonCodes: ["research-runtime-unavailable"],
      admission: null,
      jobId: null,
    };
  };
  const admitted = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    metadata: VertexRecord,
    physicalKey: string,
    requestHash: string,
    at: string
  ): Promise<VertexRecord> => {
    const row = await one(
      tx,
      "vertex_research_chat_worker_origins",
      scope,
      sql`response_request_id = ${physicalKey}`
    );
    if (!row) return fail("integrity");
    const origin = object(row["payload"]);
    if (
      (await ctx.hash(origin)) !== row["record_hash"] ||
      origin["ownerActorId"] !== principal.actorId ||
      origin["requestSha256"] !== requestHash ||
      origin["responseRequestId"] !== physicalKey ||
      row["owner_actor_id"] !== principal.actorId ||
      origin["runId"] !== row["run_id"] ||
      origin["eventId"] !== row["event_id"]
    )
      return fail("integrity");
    return {
      ...expectedReceipt(
        principal,
        scope,
        metadata,
        physicalKey,
        requestHash,
        at
      ),
      status: "admitted",
      reasonCodes: [],
      admission: {
        bindingSha256: row["record_hash"],
        contextSha256: origin["contextSha256"],
        participantConfigSha256: origin["participantConfigSha256"],
        collectionId: origin["collectionId"],
        proposal: {
          artifactId: origin["runArtifactId"],
          sha256: origin["runSha256"],
        },
        runId: origin["runId"],
        eventId: origin["eventId"],
      },
    };
  };
  const verify = async (
    tx: Transaction,
    row: VertexRecord,
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string,
    idempotencyKey: string,
    physicalKey: string
  ): Promise<VertexRecord> => {
    try {
      const command = exactMetadata(ctx.capture(row["command"]), [
        "profile",
        "operation",
        "actorId",
        "input",
      ]);
      const metadata = exactMetadata(command["input"], metadataKeys);
      if (
        command["profile"] !== profile ||
        command["operation"] !== "requestResponse" ||
        command["actorId"] !== principal.actorId
      )
        return fail("integrity");
      if (
        scope.environment !== "research" ||
        row["account_alias"] !== scope.accountAlias ||
        row["environment"] !== scope.environment ||
        row["actor_id"] !== principal.actorId ||
        row["kind"] !== kind ||
        row["idempotency_key"] !== physicalKey
      )
        return fail("integrity");
      if (
        metadata["accountAlias"] !== scope.accountAlias ||
        metadata["environment"] !== scope.environment ||
        metadata["threadId"] !== threadId ||
        metadata["idempotencyKey"] !== idempotencyKey
      )
        return fail("integrity");
      for (const field of [
        "accountAlias",
        "threadId",
        "parentMessageId",
        "participantId",
        "idempotencyKey",
      ])
        identifier(metadata[field]);
      const snapshot = sequence(metadata["snapshotRevision"]);
      const start = sequence(metadata["contextStartSequence"]);
      if (
        start < 1n ||
        snapshot < 2n ||
        snapshot - start < 1n ||
        snapshot - start > 16n
      )
        return fail("integrity");
      if (
        physicalKey !==
        (await identity(principal, scope, threadId, idempotencyKey))
      )
        return fail("integrity");
      if (
        row["collection_key"] !== "" ||
        row["target_artifact_id"] !== null ||
        row["review_id"] !== null ||
        row["admission_id"] !== null
      )
        return fail("integrity");
      const at = string(row["committed_at"]);
      if (row["committed_at_ns"] !== time(at).toString())
        return fail("integrity");
      const requestHash = digestString(row["request_hash"]);
      const result = ctx.capture(object(row["result"]));
      const expected =
        result["status"] === "admitted"
          ? await admitted(
              tx,
              principal,
              scope,
              metadata,
              physicalKey,
              requestHash,
              at
            )
          : expectedReceipt(
              principal,
              scope,
              metadata,
              physicalKey,
              requestHash,
              at
            );
      // Exact reconstructed result rejects extra keys, text copies, invented
      // jobs/admission, changed reasons and every metadata/time/scope mismatch.
      const resultHash = await ctx.hash(result);
      if (
        resultHash !== (await ctx.hash(expected)) ||
        (await ctx.hash({ command, result })) !==
          digestString(row["result_hash"])
      )
        return fail("integrity");
      const validated = await ctx.validate(
        "ResearchChatResponseReceipt",
        result
      );
      if ((await ctx.hash(validated)) !== resultHash) return fail("integrity");
      return validated;
    } catch {
      return fail("integrity");
    }
  };
  const read = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string,
    idempotencyKey: string
  ): Promise<VertexRecord | null> => {
    const physicalKey = await identity(
      principal,
      scope,
      threadId,
      idempotencyKey
    );
    const row = await one(
      tx,
      "vertex_command_receipts",
      scope,
      sql`actor_id = ${principal.actorId} and kind = ${kind} and idempotency_key = ${physicalKey}`
    );
    return row
      ? verify(tx, row, principal, scope, threadId, idempotencyKey, physicalKey)
      : null;
  };
  const save = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    metadataInput: VertexRecord,
    requestHash: string,
    at: string,
    admission = false
  ): Promise<VertexRecord> => {
    // Reject a full POST input here: the original query is hashed transiently,
    // never copied to the receipt owner, metadata, or immutable result.
    const metadata = exactMetadata(ctx.capture(metadataInput), metadataKeys);
    const threadId = identifier(metadata["threadId"]);
    const idempotencyKey = identifier(metadata["idempotencyKey"]);
    const physicalKey = await identity(
      principal,
      scope,
      threadId,
      idempotencyKey
    );
    const command = {
      profile,
      operation: "requestResponse",
      actorId: principal.actorId,
      input: metadata,
    };
    const result = admission
      ? await admitted(
          tx,
          principal,
          scope,
          metadata,
          physicalKey,
          requestHash,
          at
        )
      : expectedReceipt(
          principal,
          scope,
          metadata,
          physicalKey,
          requestHash,
          at
        );
    const row = {
      account_alias: scope.accountAlias,
      environment: scope.environment,
      actor_id: principal.actorId,
      kind,
      idempotency_key: physicalKey,
      request_hash: requestHash,
      command,
      result,
      result_hash: await ctx.hash({ command, result }),
      collection_key: "",
      target_artifact_id: null,
      review_id: null,
      admission_id: null,
      committed_at: at,
      committed_at_ns: time(at).toString(),
    };
    const verified = await verify(
      tx,
      row,
      principal,
      scope,
      threadId,
      idempotencyKey,
      physicalKey
    );
    await insert(tx, "vertex_command_receipts", scope, row);
    return verified;
  };
  return { read, save };
};

// Bodyless chat branch of the EXISTING command owner. No fake proposal question,
// no alternate outbox, and no second logical run identity.
export const createResearchChatCommandOperations = (
  ctx: PersistenceContext
) => ({
  enqueueForTransaction: async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    plan: VertexRecord,
    run: VertexRecord,
    metadata: VertexArtifactMetadata,
    event: VertexRecord,
    at: string
  ): Promise<void> => {
    if (
      scope.environment !== "research" ||
      plan["ownerActorId"] !== principal.actorId ||
      metadata.collectionId !== plan["collectionId"] ||
      metadata.artifactSha256 !== (await ctx.hash(run)) ||
      run["runId"] !== plan["runId"] ||
      run["taskContract"] !== plan["taskContract"] ||
      run["status"] !== "queued" ||
      array(run["allowedTools"]).length !== 0 ||
      array(run["outputArtifactIds"]).length !== 0 ||
      array(run["errors"]).length !== 0 ||
      event["correlationId"] !== plan["traceId"] ||
      event["actorId"] !== principal.actorId ||
      (await ctx.hash(event["payload"])) !== (await ctx.hash(run))
    )
      return fail("integrity");
    const local: PersistenceContext = {
      ...ctx,
      run: async (actor, target, collection, resource, action, operation) => {
        if (
          actor.actorId !== principal.actorId ||
          target.accountAlias !== scope.accountAlias ||
          target.environment !== scope.environment
        )
          return fail("denied");
        await ctx.authorize(
          actor,
          target,
          collection,
          resource,
          action,
          ctx.now()
        );
        return operation(tx, at);
      },
    };
    const research = createResearchOperations(local);
    await research.registerArtifact(principal, metadata);
    await research.recordImmutable({
      principal,
      scope,
      collectionId: metadata.collectionId,
      contractName: "AgentRun",
      record: run,
      artifact: metadata,
      idempotencyKey: `chat-run-${plan["responseRequestId"]}`,
    });
    await createOutboxOperations(local).enqueueEvent(
      principal,
      scope,
      metadata.collectionId,
      event
    );
  },
});

export const createCommandOperations = (
  ctx: PersistenceContext
): CommandOperations => {
  const boundContext = (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope
  ): PersistenceContext => {
    const run: PersistenceContext["run"] = async <T>(
      actor: VertexPrincipal,
      target: VertexScope,
      collection: string | null,
      resource: string,
      action: VertexAction,
      operation: (executor: Transaction, at: string) => Promise<T>
    ): Promise<T> => {
      if (
        actor.actorId !== principal.actorId ||
        target.accountAlias !== scope.accountAlias ||
        target.environment !== scope.environment
      )
        fail("denied");
      const at = ctx.now();
      await ctx.authorize(actor, target, collection, resource, action, at);
      return operation(tx, at);
    };
    return { ...ctx, run };
  };
  const operations = (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope
  ) => {
    const bound = boundContext(tx, principal, scope);
    const research = createResearchOperations(bound);
    const projection = createProjectionOperations(bound);
    const review = createReviewOperations(bound, projection.currentPortfolio);
    return { research, review, outbox: createOutboxOperations(bound) };
  };
  const currentPolicy = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    key: VertexCommandKey,
    at: string
  ): Promise<void> => {
    if (!ctx.commandPolicy) {
      if (key.commandPolicy !== undefined) fail("unavailable");
      return;
    }
    if (key.commandPolicy === undefined) return fail("denied");
    const allowed = await ctx.commandPolicy(
      tx,
      Object.freeze({
        principal: Object.freeze({ ...principal }),
        scope: Object.freeze({ ...scope }),
        kind: key.kind,
        commandPolicy: policyIdentity(key.commandPolicy),
        now: at,
      })
    );
    if (allowed !== true) fail("denied");
  };
  const load = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    artifactId: string,
    at: string
  ): Promise<Loaded> => {
    const stored = await one(
      tx,
      "vertex_records",
      scope,
      sql`artifact_id = ${artifactId}`
    );
    if (!stored) return fail("integrity");
    const collection = collectionId(stored["collection_key"]);
    const metadata = await ctx.artifact(
      tx,
      principal,
      scope,
      collection,
      artifactId,
      "read",
      at
    );
    if (
      !metadata ||
      metadata.artifactSha256 !== stored["artifact_sha256"] ||
      stored["record_hash"] !== metadata.artifactSha256 ||
      (await ctx.hash(stored["payload"])) !== metadata.artifactSha256 ||
      metadata.contractName !== stored["contract_name"]
    )
      return fail("integrity");
    const value = await ctx.validate(
      metadata.contractName as
        | "ResearchEvidence"
        | "AgentRun"
        | "TradeIntent"
        | "StrategySpec",
      stored["payload"]
    );
    if ((await ctx.hash(value)) !== metadata.artifactSha256) fail("integrity");
    return { metadata, value };
  };
  const publishedEvidence = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string,
    artifactId: string,
    at: string
  ): Promise<Loaded> => {
    const loaded = await load(tx, principal, scope, artifactId, at);
    if (
      loaded.metadata.contractName !== "ResearchEvidence" ||
      loaded.metadata.collectionId !== collection ||
      loaded.value["collectionId"] !== collection
    )
      fail("integrity");
    const direct = await one(
      tx,
      "vertex_claim_evidence",
      scope,
      sql`collection_id = ${collection} and evidence_id = ${loaded.value["evidenceId"]} and artifact_id = ${artifactId} and snapshot_id = ${loaded.value["snapshotId"]}`
    );
    if (!direct || loaded.value["acceptanceStatus"] === "accepted")
      fail("denied");
    return loaded;
  };
  const evidenceInputs = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string,
    evidenceIds: readonly unknown[],
    at: string
  ): Promise<Loaded[]> => {
    const result: Loaded[] = [];
    for (const id of evidenceIds) {
      const evidence = await one(
        tx,
        "vertex_evidence",
        scope,
        sql`collection_id = ${collection} and evidence_id = ${identifier(id)}`
      );
      if (!evidence) fail("integrity");
      const loaded = await publishedEvidence(
        tx,
        principal,
        scope,
        collection,
        string(requirePresent(evidence, "evidence")["artifact_id"]),
        at
      );
      await ctx.rights(
        tx,
        scope,
        collection,
        loaded.metadata.rights,
        "derive",
        at
      );
      result.push(loaded);
    }
    return result;
  };
  const reviewBinding = (
    command: VertexRecord,
    review: VertexRecord,
    principal: VertexPrincipal
  ): void => {
    for (const field of [
      "artifactId",
      "artifactSha256",
      "strategyVersion",
      "decision",
      "purpose",
      "accountAlias",
      "environment",
    ]) {
      if (review[field] !== command[field]) fail("integrity");
    }
    if (
      review["supersedesReviewId"] !== command["expectedReviewId"] ||
      review["actorId"] !== principal.actorId
    )
      fail("integrity");
  };
  const simulationBinding = (
    command: VertexRecord,
    admission: VertexRecord,
    principal: VertexPrincipal
  ): void => {
    for (const field of [
      "admissionId",
      "reviewId",
      "reviewVersion",
      "intentId",
      "intentSha256",
      "strategyVersion",
      "idempotencyKey",
      "accountAlias",
      "environment",
      "simulationOnly",
      "brokerSubmissionAllowed",
      "liveAuthorization",
    ]) {
      if (admission[field] !== command[field]) fail("integrity");
    }
    if (admission["actorId"] !== principal.actorId) fail("integrity");
  };
  const proposalBinding = async (
    command: VertexRecord,
    proposal: VertexRecord,
    agent: VertexRecord
  ): Promise<void> => {
    const expected = {
      question: command["question"],
      evidenceIds: command["evidenceIds"],
      role: command["role"],
      proposalOnly: true,
      executionAuthorized: false,
      ...(Object.hasOwn(command, "backtestExpectation")
        ? { backtestExpectation: command["backtestExpectation"] }
        : {}),
    };
    if (
      (await ctx.hash(proposal)) !== (await ctx.hash(expected)) ||
      agent["agentRole"] !== command["role"] ||
      (await ctx.hash(agent["inputEvidenceIds"])) !==
        (await ctx.hash(command["evidenceIds"])) ||
      agent["status"] !== "queued" ||
      array(agent["outputArtifactIds"]).length !== 0 ||
      array(agent["errors"], 32).length !== 0 ||
      agent["executionAuthorized"] !== false
    )
      fail("integrity");
  };
  const receipt = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    key: VertexCommandKey,
    at: string
  ): Promise<VertexRecord | null> => {
    // This runs inside the original command transaction and its grant/policy
    // locks, before either a duplicate return or any new mutation.
    await currentPolicy(tx, principal, scope, key, at);
    const found = await one(
      tx,
      "vertex_command_receipts",
      scope,
      sql`actor_id = ${principal.actorId} and kind = ${key.kind} and idempotency_key = ${key.idempotencyKey}`
    );
    if (!found) return null;
    if (found["request_hash"] !== key.requestHash) fail("conflict");
    const storedCommand = object(found["command"]);
    const guarded = Object.hasOwn(storedCommand, "commandPolicy");
    let originalCommand = storedCommand;
    let receiptHash = await ctx.hash(found["result"]);
    if (guarded) {
      if (
        Object.keys(storedCommand).length !== 2 ||
        !Object.hasOwn(storedCommand, "command")
      )
        fail("integrity");
      const storedPolicy = policyIdentity(storedCommand["commandPolicy"]);
      if (
        key.commandPolicy === undefined ||
        (await ctx.hash(storedPolicy)) !== (await ctx.hash(key.commandPolicy))
      )
        fail("conflict");
      originalCommand = object(storedCommand["command"]);
      receiptHash = await ctx.hash({
        result: found["result"],
        commandPolicy: storedPolicy,
      });
    } else if (key.commandPolicy !== undefined) {
      // A legacy receipt has no selected-policy proof and cannot be promoted.
      fail("conflict");
    }
    if (
      (await ctx.hash({
        actorId: principal.actorId,
        kind: key.kind,
        input: originalCommand,
      })) !== key.requestHash ||
      receiptHash !== found["result_hash"]
    )
      fail("integrity");
    const result = object(found["result"]);
    const nested = operations(tx, principal, scope);
    if (key.kind === "review") {
      const value = await ctx.validate("AcceptedReview", result["review"]);
      reviewBinding(key.command, value, principal);
      if (value["reviewId"] !== `review-${key.requestHash}`) fail("integrity");
      const original = await load(
        tx,
        principal,
        scope,
        identifier(value["artifactId"]),
        at
      );
      if (original.metadata.artifactSha256 !== value["artifactSha256"])
        fail("integrity");
      const latest = await one(
        tx,
        "vertex_reviews",
        scope,
        sql`artifact_id = ${value["artifactId"]} and collection_key = ${collectionKey(original.metadata.collectionId)} and purpose = ${value["purpose"]}`,
        sql`order by reviewed_at_ns desc, review_id desc`
      );
      if (!latest || latest["review_id"] !== value["reviewId"]) fail("stale");
      await nested.review.recordReview(principal, scope, value);
      if (result["acceptedEvidenceArtifactId"] !== null) fail("integrity");
      const link = await one(
        tx,
        "vertex_reviewed_artifact_links",
        scope,
        sql`review_id = ${value["reviewId"]} and artifact_id = ${original.metadata.artifactId} and artifact_sha256 = ${original.metadata.artifactSha256} and collection_key = ${collectionKey(original.metadata.collectionId)}`
      );
      if (!link) fail("integrity");
    }
    if (key.kind === "research") {
      const loaded = await load(
        tx,
        principal,
        scope,
        identifier(result["artifactId"]),
        at
      );
      if (
        loaded.metadata.contractName !== "AgentRun" ||
        result["sha256"] !== loaded.metadata.artifactSha256 ||
        (await ctx.hash(result["value"])) !== loaded.metadata.artifactSha256 ||
        loaded.metadata.collectionId !== key.command["collectionId"]
      )
        fail("integrity");
      const proposal = await one(
        tx,
        "vertex_research_proposals",
        scope,
        sql`artifact_id = ${result["artifactId"]} and collection_id = ${key.command["collectionId"]} and actor_id = ${principal.actorId}`
      );
      if (
        !proposal ||
        (await ctx.hash(proposal["payload"])) !== proposal["proposal_hash"]
      )
        fail("integrity");
      await proposalBinding(
        key.command,
        object(requirePresent(proposal, "proposal")["payload"]),
        loaded.value
      );
      const inputs = await evidenceInputs(
        tx,
        principal,
        scope,
        identifier(key.command["collectionId"]),
        array(key.command["evidenceIds"], 32),
        at
      );
      const links = await rows(
        tx,
        sql`select * from vertex_research_proposal_evidence where ${scopeWhere(scope)} and artifact_id = ${loaded.metadata.artifactId} order by ordinal limit 33`
      );
      if (
        links.length !== inputs.length ||
        links.some(
          (link, index) =>
            link["evidence_id"] !==
              requirePresent(inputs[index], "inputs[index]").value[
                "evidenceId"
              ] ||
            link["evidence_artifact_id"] !==
              requirePresent(inputs[index], "inputs[index]").metadata
                .artifactId ||
            link["evidence_sha256"] !==
              requirePresent(inputs[index], "inputs[index]").metadata
                .artifactSha256
        )
      )
        fail("integrity");
      await ctx.authorize(
        principal,
        scope,
        loaded.metadata.collectionId,
        loaded.metadata.artifactId,
        "publish",
        at
      );
    }
    if (key.kind === "simulation") {
      const job = await one(
        tx,
        "vertex_paper_jobs",
        scope,
        sql`admission_id = ${key.command["admissionId"]}`
      );
      if (!job || (await ctx.hash(job["payload"])) !== job["record_hash"])
        fail("integrity");
      const admission = await ctx.validate(
        "PaperSimulationAdmission",
        requirePresent(job, "job")["payload"]
      );
      simulationBinding(key.command, admission, principal);
      if (
        result["jobId"] !== `simulation-${await ctx.hash(admission)}` ||
        result["admissionId"] !== admission["admissionId"] ||
        result["status"] !== "queued" ||
        result["simulationOnly"] !== true ||
        result["brokerSubmissionAllowed"] !== false ||
        result["liveAuthorization"] !== false
      )
        fail("integrity");
      await nested.review.admitPaperSimulation(principal, scope, admission);
    }
    await currentPolicy(tx, principal, scope, key, ctx.now());
    return ctx.capture(result);
  };
  const saveReceipt = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    key: VertexCommandKey,
    result: VertexRecord,
    collection: string | null,
    target: string | null,
    reviewId: string | null,
    admissionId: string | null,
    at: string
  ): Promise<void> => {
    await currentPolicy(tx, principal, scope, key, ctx.now());
    const command =
      key.commandPolicy === undefined
        ? key.command
        : { command: key.command, commandPolicy: key.commandPolicy };
    const resultHash = await ctx.hash(
      key.commandPolicy === undefined
        ? result
        : { result, commandPolicy: key.commandPolicy }
    );
    await insert(tx, "vertex_command_receipts", scope, {
      actor_id: principal.actorId,
      kind: key.kind,
      idempotency_key: key.idempotencyKey,
      request_hash: key.requestHash,
      command,
      result,
      result_hash: resultHash,
      collection_key: collectionKey(collection),
      target_artifact_id: target,
      review_id: reviewId,
      admission_id: admissionId,
      committed_at: at,
      committed_at_ns: time(at).toString(),
    });
  };
  const keyOf = (
    kind: VertexCommandKey["kind"],
    input: Readonly<{
      idempotencyKey: string;
      requestHash: string;
      command: VertexRecord;
      commandPolicy?: VertexCommandPolicyIdentity;
    }>
  ): VertexCommandKey => ({
    kind,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    command: input.command,
    ...(input.commandPolicy === undefined
      ? {}
      : { commandPolicy: policyIdentity(input.commandPolicy) }),
  });
  const commandScope = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    key: VertexCommandKey
  ) => {
    const command = await validateVertexCommand(ctx, principal, scope, key);
    if (Object.hasOwn(command, "backtestExpectation")) {
      if (!key.commandPolicy) return fail("unavailable");
      const selected = object(object(command["backtestExpectation"])["policy"]);
      if (
        selected["selectionId"] !== key.commandPolicy.selectionId ||
        selected["selectionSha256"] !== key.commandPolicy.selectionSha256 ||
        selected["selectionRevision"] !== key.commandPolicy.selectionRevision
      )
        return fail("conflict");
    }
    if (key.commandPolicy !== undefined) {
      policyIdentity(key.commandPolicy);
      if (!ctx.commandPolicy) fail("unavailable");
    } else if (ctx.commandPolicy) {
      fail("denied");
    }
    return {
      command,
      collection:
        key.kind === "research" ? identifier(command["collectionId"]) : null,
      resource: identifier(
        key.kind === "review"
          ? command["artifactId"]
          : key.kind === "research"
            ? command["collectionId"]
            : command["admissionId"]
      ),
      action: (key.kind === "review"
        ? "review"
        : key.kind === "research"
          ? "publish"
          : "admit-paper-simulation") as VertexAction,
    };
  };
  const getCommandReceipt: VertexStore["getCommandReceipt"] = async (
    rawPrincipal,
    rawScope,
    rawKey
  ) => {
    const principal = ctx.capture(rawPrincipal);
    const scope = ctx.capture(rawScope);
    const key = ctx.capture(rawKey);
    const target = await commandScope(principal, scope, key);
    return ctx.run(
      principal,
      scope,
      target.collection,
      target.resource,
      target.action,
      (tx, at) => receipt(tx, principal, scope, key, at),
      true
    );
  };
  const recordReviewedEvidence: VertexStore["recordReviewedEvidence"] = async (
    raw
  ) => {
    const input = ctx.capture(raw);
    if (input.acceptedEvidence !== null) fail("denied");
    const key = keyOf("review", input);
    const target = await commandScope(input.principal, input.scope, key);
    return ctx.run(
      input.principal,
      input.scope,
      target.collection,
      target.resource,
      target.action,
      async (tx, at) => {
        const { principal, scope } = input;
        const existing = await receipt(tx, principal, scope, key, at);
        if (existing) return existing;
        const review = await ctx.validate("AcceptedReview", input.review);
        reviewBinding(target.command, review, principal);
        if (review["reviewId"] !== `review-${key.requestHash}`)
          fail("integrity");
        const original = await load(
          tx,
          principal,
          scope,
          identifier(review["artifactId"]),
          at
        );
        if (
          original.metadata.artifactSha256 !== review["artifactSha256"] ||
          original.metadata.collectionId !== review["collectionId"]
        )
          fail("integrity");
        const nested = operations(tx, principal, scope);
        if (original.metadata.contractName === "ResearchEvidence") {
          await publishedEvidence(
            tx,
            principal,
            scope,
            identifier(original.metadata.collectionId),
            original.metadata.artifactId,
            at
          );
        }
        await nested.review.recordReview(principal, scope, review);
        await insert(tx, "vertex_reviewed_artifact_links", scope, {
          review_id: review["reviewId"],
          collection_key: collectionKey(original.metadata.collectionId),
          artifact_id: original.metadata.artifactId,
          artifact_sha256: original.metadata.artifactSha256,
          committed_at: at,
          committed_at_ns: time(at).toString(),
        });
        const result: VertexRecord = {
          review,
          acceptedEvidenceArtifactId: null,
        };
        const eventId = `review-${await ctx.hash({ actorId: principal.actorId, requestHash: key.requestHash })}`;
        await insert(tx, "vertex_outbox", scope, {
          collection_key: collectionKey(original.metadata.collectionId),
          event_id: eventId,
          event_type: "vertex.review.recorded",
          idempotency_key: eventId,
          record_hash: await ctx.hash(result),
          payload: result,
          available_at_ns: time(at).toString(),
          lease_owner: null,
          lease_fence: "0",
          lease_expires_at: null,
          lease_expires_at_ns: null,
          published_at: null,
          settlement_hash: null,
        });
        await saveReceipt(
          tx,
          principal,
          scope,
          key,
          result,
          original.metadata.collectionId,
          original.metadata.artifactId,
          identifier(review["reviewId"]),
          null,
          at
        );
        return result;
      },
      true
    );
  };
  const enqueueResearchProposal: VertexStore["enqueueResearchProposal"] =
    async (raw) => {
      const input = ctx.capture(raw);
      const key = keyOf("research", input);
      const target = await commandScope(input.principal, input.scope, key);
      if (target.command["collectionId"] !== input.collectionId) fail("denied");
      return ctx.run(
        input.principal,
        input.scope,
        input.collectionId,
        input.collectionId,
        "publish",
        async (tx, at) => {
          const { principal, scope } = input;
          const existing = await receipt(tx, principal, scope, key, at);
          if (existing) return existing;
          const value = await ctx.validate("AgentRun", input.record);
          await proposalBinding(target.command, input.proposal, value);
          if (Object.hasOwn(target.command, "backtestExpectation")) {
            const expectation = object(target.command["backtestExpectation"]);
            if (
              value["runId"] !== `backtest-request-${key.requestHash}` ||
              input.metadata.artifactId !== `agent-${key.requestHash}` ||
              value["taskContract"] !== expectation["taskContract"]
            )
              fail("integrity");
          }
          const metadata = input.metadata;
          if (
            metadata.scope.accountAlias !== scope.accountAlias ||
            metadata.scope.environment !== scope.environment ||
            metadata.collectionId !== input.collectionId ||
            metadata.contractName !== "AgentRun"
          )
            fail("integrity");
          const evidence = await evidenceInputs(
            tx,
            principal,
            scope,
            input.collectionId,
            array(target.command["evidenceIds"], 32),
            at
          );
          const nested = operations(tx, principal, scope);
          await nested.research.registerArtifact(principal, metadata);
          await nested.research.recordImmutable({
            principal,
            scope,
            collectionId: input.collectionId,
            contractName: "AgentRun",
            record: value,
            artifact: metadata,
            idempotencyKey: `research-proposal-${key.requestHash}`,
          });
          await insert(tx, "vertex_research_proposals", scope, {
            artifact_id: metadata.artifactId,
            actor_id: principal.actorId,
            collection_id: input.collectionId,
            question: input.proposal.question,
            role: input.proposal.role,
            proposal_hash: await ctx.hash(input.proposal),
            payload: input.proposal,
            committed_at: at,
            committed_at_ns: time(at).toString(),
          });
          for (const [ordinal, item] of evidence.entries()) {
            await insert(tx, "vertex_research_proposal_evidence", scope, {
              artifact_id: metadata.artifactId,
              ordinal: String(ordinal),
              evidence_id: item.value["evidenceId"],
              evidence_artifact_id: item.metadata.artifactId,
              evidence_sha256: item.metadata.artifactSha256,
            });
          }
          const identity = {
            schemaVersion: "1.0.0",
            eventType: "agent.recorded",
            occurredAt: at,
            effectiveAt: at,
            correlationId: `research-${key.requestHash}`,
            causationId: null,
            actorId: principal.actorId,
            moduleId: "vertex-persistence",
            moduleVersion: "1.0.0",
            environment: scope.environment,
            idempotencyKey: `research-${key.requestHash}`,
            payload: value,
          };
          await nested.outbox.enqueueEvent(
            principal,
            scope,
            input.collectionId,
            {
              ...identity,
              eventId: `event-${await ctx.hash(identity)}`,
              receivedAt: at,
            }
          );
          const result = {
            artifactId: metadata.artifactId,
            sha256: metadata.artifactSha256,
            value,
          };
          await saveReceipt(
            tx,
            principal,
            scope,
            key,
            result,
            input.collectionId,
            metadata.artifactId,
            null,
            null,
            at
          );
          return result;
        },
        true
      );
    };
  const queuePaperSimulation: VertexStore["queuePaperSimulation"] = async (
    raw
  ) => {
    const input = ctx.capture(raw);
    const key = keyOf("simulation", input);
    const target = await commandScope(input.principal, input.scope, key);
    return ctx.run(
      input.principal,
      input.scope,
      null,
      target.resource,
      "admit-paper-simulation",
      async (tx, at) => {
        const existing = await receipt(
          tx,
          input.principal,
          input.scope,
          key,
          at
        );
        if (existing) return existing;
        const admission = await ctx.validate(
          "PaperSimulationAdmission",
          input.admission
        );
        simulationBinding(target.command, admission, input.principal);
        const nested = operations(tx, input.principal, input.scope);
        await nested.review.admitPaperSimulation(
          input.principal,
          input.scope,
          admission
        );
        const result = {
          jobId: `simulation-${await ctx.hash(admission)}`,
          admissionId: identifier(admission["admissionId"]),
          status: "queued",
          simulationOnly: true,
          brokerSubmissionAllowed: false,
          liveAuthorization: false,
        };
        await saveReceipt(
          tx,
          input.principal,
          input.scope,
          key,
          result,
          null,
          null,
          identifier(admission["reviewId"]),
          identifier(admission["admissionId"]),
          at
        );
        return result;
      },
      true
    );
  };
  return Object.freeze({
    getCommandReceipt,
    recordReviewedEvidence,
    enqueueResearchProposal,
    queuePaperSimulation,
  });
};
