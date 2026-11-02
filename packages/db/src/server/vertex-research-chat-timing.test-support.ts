import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { vertexQualifiedObjectKey } from "@darkfactory/storage";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as chatSchemas from "../../../api/src/contracts/vertex-research-chat.ts";
import { VERTEX_RESEARCH_CHAT_EXECUTION_SCHEMAS } from "../../../api/src/contracts/vertex-research-chat-execution.ts";
import { VertexResearchChatRequestResponseInputSchema } from "../../../api/src/contracts/vertex-research-chat-response.ts";
import { createVertexRuntimePolicyArtifacts } from "../../../api/src/server/vertex-runtime-policy-artifacts.ts";
import type { Database, Transaction } from "./client.ts";
import { createVertexAuthorization } from "./vertex-authorization.ts";
import { createPersistenceContext } from "./vertex-persistence-core.ts";
import type {
  VertexAction,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";
import {
  researchChatContextUseResource,
  researchChatStorageReviewResource,
  type VertexResearchChatExecutionOptions,
} from "./vertex-research-chat-execution-ports.ts";
import { createResearchChatExecutionOperations } from "./vertex-research-chat-execution-store.ts";
import { createResearchChatOperations } from "./vertex-research-chat-store.ts";

// Only SQL/storage/clock boundaries are doubled. ACL, artifact reads, rights,
// strict schemas, human append and private storage-review ownership are real.
// This does NOT qualify PostgreSQL locking, physical storage or a chat worker.
const BEFORE = "2026-09-24T11:00:00.000000001Z";
const START = "2026-09-24T12:00:00.000000001Z";
export const PLANNED = "2026-09-24T12:01:00.000000001Z";
export const PROGRESSED = "2026-09-24T12:02:00.000000001Z";
export const CURRENT = "2026-09-24T12:03:00.000000001Z";
export const EDGE = "2026-09-24T12:03:00.000000002Z";
export const END = "2026-09-24T13:00:00.000000001Z";
export const owner = { actorId: "chat-owner" };
export const reviewer = { actorId: "independent-reviewer" };
export const issuer = { actorId: "storage-issuer" };
export const scope: VertexScope = {
  accountAlias: "timing-fixture",
  environment: "research",
};
export const ns = (value: string): string =>
  timestampToEpochNanoseconds(value).toString();
const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonicalArtifactJson(value));
type Row = Record<string, unknown>;
interface Query {
  params: unknown[];
  sql: string;
}
const schema = (name: string) => {
  const schemas: Record<string, { parse: (value: unknown) => unknown }> = {
    createThread: chatSchemas.VertexResearchChatCreateThreadInputSchema,
    sendMessage: chatSchemas.VertexResearchChatSendMessageInputSchema,
    requestResponse: VertexResearchChatRequestResponseInputSchema,
    ResearchChatThread: chatSchemas.VertexResearchChatThreadSchema,
    ResearchChatMessage: chatSchemas.VertexResearchChatMessageSchema,
    ResearchChatSendMessageOutput:
      chatSchemas.VertexResearchChatSendMessageOutputSchema,
  };
  const found = schemas[name];
  if (!found) throw new Error(`Unconfigured real schema: ${name}`);
  return found;
};
const grantRow = async (
  actorId: string,
  resourceId: string,
  actions: VertexAction[],
  overrides: Row = {}
): Promise<Row> => {
  const binding = {
    grantId: `grant-${await hashArtifact({ actorId, resourceId, actions })}`,
    granteeActorId: actorId,
    scope,
    collectionId: null,
    resourceId,
    actions: [...actions].sort(),
  };
  const value = {
    ...binding,
    version: "1.0.0",
    revision: "1",
    status: "granted",
    validFrom: BEFORE,
    expiresAt: END,
    recordedAt: BEFORE,
    recordedByActorId: "fixture-grant-admin",
    ...overrides,
  };
  return {
    account_alias: scope.accountAlias,
    environment: scope.environment,
    grant_id: binding.grantId,
    grantee_actor_id: actorId,
    collection_key: "",
    resource_id: resourceId,
    binding_hash: await hashArtifact(binding),
    binding_payload: binding,
    version_payload: value,
    payload: value,
    record_hash: await hashArtifact(value),
    request_hash: "a".repeat(64),
    version_status: value.status,
    valid_from_ns: ns(value.validFrom as string),
    expires_at_ns: ns(value.expiresAt as string),
    recorded_at_ns: ns(value.recordedAt as string),
    version_name: value.version,
    version_revision: value.revision,
    current_version: value.version,
    current_revision: value.revision,
    revision: value.revision,
  };
};

export const timingFixture = async () => {
  const tables = new Map<string, Row[]>();
  const table = (name: string): Row[] => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const grants: Row[] = [];
  const calls: Query[] = [];
  const lifecycle: string[] = [];
  const state = {
    at: START,
    readIds: [] as string[],
    selectionReads: 0,
    afterRead: (_artifactId: string): void => {
      // Intentionally empty default hook.
    },
    afterQuery: (_query: Query): void => {
      // Intentionally empty default hook.
    },
  };
  const dialect = new PgDialect();
  const parameter = (query: Query, column: string): unknown => {
    const match = new RegExp(
      `${column.replaceAll(".", "\\.")} = \\$(\\d+)`
    ).exec(query.sql);
    return match ? query.params[Number(match[1]) - 1] : undefined;
  };
  const matches = (row: Row, query: Query, where: string): boolean => {
    for (const match of where.matchAll(
      /(?:\b\w+\.)?"?([a-z_0-9]+)"?\s*(=|>=|<=)\s*\$(\d+)/g
    )) {
      const actual = row[match[1]!];
      const expected = query.params[Number(match[3]) - 1];
      if (match[2] === "=" && actual !== expected) return false;
      if (
        match[2] === ">=" &&
        BigInt(String(actual)) < BigInt(String(expected))
      )
        return false;
      if (
        match[2] === "<=" &&
        BigInt(String(actual)) > BigInt(String(expected))
      )
        return false;
    }
    for (const match of where.matchAll(/\b([a-z_0-9]+)\s*=\s*'([^']*)'/g)) {
      if (row[match[1]!] !== match[2]) return false;
    }
    return true;
  };
  const execute = async (fragment: SQL) => {
    const query = dialect.sqlToQuery(fragment);
    calls.push(query);
    state.afterQuery(query);
    if (query.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (query.sql.includes("from vertex_grant_bindings")) {
      const actorId = parameter(query, "b.grantee_actor_id");
      const resource = parameter(query, "b.resource_id");
      const action =
        parameter(query, "a.action") ??
        (query.sql.includes("a.action = 'read'") ? "read" : undefined);
      return {
        rows: grants.filter(
          (row) =>
            row["grantee_actor_id"] === actorId &&
            row["resource_id"] === resource &&
            (row["version_payload"] as Row)["status"] === "granted" &&
            ((row["version_payload"] as Row)["actions"] as unknown[]).includes(
              action
            ) &&
            parameter(query, "b.account_alias") === scope.accountAlias &&
            parameter(query, "b.environment") === scope.environment
        ),
      };
    }
    if (/^insert into vertex_account/.test(query.sql)) return { rows: [] };
    const inserted = /^insert into "(\w+)" \((.*?)\) values \((.*)\)$/.exec(
      query.sql
    );
    if (inserted) {
      const columns = [...inserted[2]!.matchAll(/"(\w+)"/g)].map(
        (match) => match[1]!
      );
      const values = inserted[3]!.split(", ");
      const row: Row = {};
      for (const [index, column] of columns.entries()) {
        row[column] = values[index]!.includes("::jsonb")
          ? JSON.parse(query.params[index] as string)
          : query.params[index];
      }
      table(inserted[1]!).push(row);
      return { rows: [] };
    }
    const updated = /^update (\w+) set (.*?) where (.*?) returning (\w+)$/.exec(
      query.sql
    );
    if (updated) {
      const found = table(updated[1]!).filter((row) =>
        matches(row, query, updated[3]!)
      );
      for (const row of found) {
        for (const match of updated[2]!.matchAll(
          /(\w+) = \$(\d+)(::jsonb)?/g
        )) {
          const value = query.params[Number(match[2]) - 1];
          row[match[1]!] = match[3] ? JSON.parse(value as string) : value;
        }
      }
      return {
        rows: found.map((row) => ({ [updated[4]!]: row[updated[4]!] })),
      };
    }
    const selected = /from "?(vertex_\w+)"? where (.*)/.exec(query.sql);
    if (selected) {
      const found = table(selected[1]!).filter((row) =>
        matches(row, query, selected[2]!)
      );
      if (query.sql.includes("order by reviewed_at_ns desc"))
        found.sort((a, b) =>
          BigInt(String(a["reviewed_at_ns"])) >
          BigInt(String(b["reviewed_at_ns"]))
            ? -1
            : 1
        );
      if (query.sql.includes("order by sequence asc"))
        found.sort((a, b) =>
          BigInt(String(a["sequence"])) < BigInt(String(b["sequence"])) ? -1 : 1
        );
      const limit = /limit (\d+)/.exec(query.sql);
      return { rows: limit ? found.slice(0, Number(limit[1])) : found };
    }
    throw new Error(`Unexpected timing fixture SQL: ${query.sql}`);
  };
  const tx = { execute } as unknown as Transaction;
  const db = {
    execute,
    transaction: async (
      operation: (transaction: Transaction) => Promise<unknown>
    ) => {
      const before = structuredClone(tables);
      lifecycle.push("begin");
      try {
        const result = await operation(tx);
        lifecycle.push("commit");
        return result;
      } catch (error) {
        tables.clear();
        for (const [name, rows] of before) tables.set(name, rows);
        lifecycle.push("rollback");
        throw error;
      }
    },
  } as unknown as Database;
  const clock = { now: () => state.at };
  const authorization = createVertexAuthorization(db, { clock });
  const ctx = createPersistenceContext(db, {
    boundary: {
      encode,
      digest: hashArtifact,
      validate: async (name, value) =>
        schema(name).parse(value) as VertexRecord,
      validateResearchChatInput: async (name, value) =>
        schema(name).parse(value) as VertexRecord,
    },
    clock,
    authorization,
    maxProjectionAgeMs: 60_000,
  });
  const setGrant = async (
    actorId: string,
    resourceId: string,
    actions: VertexAction[],
    overrides: Row = {}
  ): Promise<void> => {
    const row = await grantRow(actorId, resourceId, actions, overrides);
    const index = grants.findIndex(
      (old) => old["grant_id"] === row["grant_id"]
    );
    if (index < 0) {
      grants.push(row);
    } else grants[index] = row;
  };
  const objects = new Map<string, { id: string; body: Uint8Array }>();
  const setRights = async (
    policyId: string,
    overrides: Row = {}
  ): Promise<Row> => {
    const value = {
      policyId,
      version: "1.0.0",
      status: "granted",
      allowedUses: ["read", "store", "derive"],
      checkedAt: BEFORE,
      expiresAt: END,
      retentionUntil: null,
      ...overrides,
    };
    const row = {
      ...scope,
      account_alias: scope.accountAlias,
      collection_key: "",
      policy_id: policyId,
      version: value.version,
      revision: "1",
      status: value.status,
      checked_at_ns: ns(value.checkedAt as string),
      expires_at_ns: ns(value.expiresAt as string),
      retention_until_ns:
        value.retentionUntil === null
          ? null
          : ns(value.retentionUntil as string),
      record_hash: await hashArtifact(value),
      payload: value,
    };
    const rows = table("vertex_rights_versions");
    const index = rows.findIndex((old) => old["policy_id"] === policyId);
    if (index < 0) {
      rows.push(row);
    } else rows[index] = row;
    return value;
  };
  const artifact = async (
    id: string,
    value: Row,
    contractName: string,
    staged = false
  ) => {
    const body = encode(value);
    const pin = {
      artifactId: id,
      artifactSha256: await hashArtifact(body),
      contractName,
      schemaVersion: "1.0.0",
    };
    const key = vertexQualifiedObjectKey(
      scope,
      null,
      "manifest",
      pin.artifactSha256
    );
    objects.set(key, { id, body });
    const rights = await setRights(`rights-${id}`);
    if (!staged) {
      const metadata = {
        ...pin,
        scope,
        collectionId: null,
        objectKey: key,
        sourceContentSha256: null,
        byteLength: body.byteLength,
        contentType: "application/json",
        rights,
        lineageArtifactIds: [],
        createdAt: BEFORE,
      };
      table("vertex_artifacts").push({
        account_alias: scope.accountAlias,
        environment: scope.environment,
        collection_key: "",
        artifact_id: id,
        artifact_sha256: pin.artifactSha256,
        object_key: key,
        byte_length: String(body.byteLength),
        rights_policy_id: rights["policyId"],
        rights_version: rights["version"],
        metadata_hash: await hashArtifact(metadata),
        payload: metadata,
      });
    }
    for (const actor of [owner, reviewer])
      await setGrant(actor.actorId, id, ["read"]);
    return { pin, body, key, rights };
  };
  const artifacts = createVertexRuntimePolicyArtifacts({
    clock,
    objectCapabilities: () => ({
      head: async (key) => {
        const object = objects.get(key);
        if (!object) return { status: "not-found" as const };
        return {
          status: "ok" as const,
          value: {
            key,
            size: object.body.byteLength,
            checksum: await hashArtifact(object.body),
            createdAt: BEFORE,
            updatedAt: BEFORE,
          },
        };
      },
      getBounded: async (key) => {
        const object = objects.get(key);
        if (!object) return { status: "not-found" as const };
        const body = new Uint8Array(object.body);
        state.readIds.push(object.id);
        state.afterRead(object.id);
        return {
          status: "ok" as const,
          value: {
            body,
            metadata: {
              key,
              size: body.byteLength,
              createdAt: BEFORE,
              updatedAt: BEFORE,
            },
          },
        };
      },
    }),
  });
  for (const actor of [owner, reviewer])
    await setGrant(actor.actorId, "account-scope", ["read"]);
  await setGrant(owner.actorId, "research-chat", ["publish", "read"]);
  const chat = createResearchChatOperations(ctx);
  const thread = await chat.createResearchChatThread({
    principal: owner,
    scope,
    title: "Synthetic timing boundary",
    participantIds: ["expert-1"],
    idempotencyKey: "create-thread",
  });
  const append = async (revision: string, key: string) =>
    chat.sendResearchChatMessage({
      principal: owner,
      scope,
      threadId: thread["threadId"] as string,
      expectedRevision: revision,
      idempotencyKey: key,
      body: `Synthetic original human body ${key}`,
      requestedParticipantIds: [],
      mode: "discuss",
    });
  const first = await append("1", "first-message");
  const request = {
    ...scope,
    threadId: thread["threadId"],
    parentMessageId: (first["message"] as Row)["messageId"],
    participantId: "expert-1",
    snapshotRevision: "2",
    contextStartSequence: "1",
    retrievalQuery: "Synthetic exact retrieval query",
    idempotencyKey: "response-key",
  };
  const responseRequestId = `response-${await hashArtifact({ operation: "requestResponse", actorId: owner.actorId, scope, threadId: request.threadId, idempotencyKey: request.idempotencyKey })}`;
  const requestSha256 = await hashArtifact({
    operation: "requestResponse",
    actorId: owner.actorId,
    input: request,
  });
  const reportOne = await artifact(
    "report-one",
    { report: "synthetic durability one" },
    "StorageReport"
  );
  const reportTwo = await artifact(
    "report-two",
    { report: "synthetic durability two" },
    "StorageReport"
  );
  const storageIdentity = {
    capabilityReferenceId: "fixture-capability",
    backendDeploymentId: "fixture-deployment",
    storageProfileSha256: "a".repeat(64),
    implementationSha256: "b".repeat(64),
    contractSha256: "c".repeat(64),
  };
  const evidenceValue = {
    schemaVersion: "1.0.0",
    format: "vertex-research-chat-storage-evidence-v1",
    ...scope,
    ...storageIdentity,
    evidenceId: "storage-evidence",
    issuerActorId: issuer.actorId,
    observedAt: BEFORE,
    expiresAt: END,
    namespace: "vertex/chat-copy/v1",
    createSemantics: "conditional-create-no-overwrite",
    readSemantics: "exact-bound-current-bytes-or-fenced",
    fenceSemantics: "conditional-permanent-tombstone-no-resurrection",
    retainedVersions: "no-application-readable-prior-content-version",
    durabilityEvidence: [reportOne.pin, reportTwo.pin],
    claimScope: "application-managed-copy-namespace-only",
    excludedClaims: ["provider", "backups", "physical-media", "RAM", "exports"],
  };
  const evidence = await artifact(
    "storage-evidence",
    evidenceValue,
    "ResearchChatStorageEvidence",
    true
  );
  const eventId = "synthetic-stage-event";
  const jobId = `job-${await hashArtifact({ scope, eventId })}`;
  const stable = {
    kind: "research-run",
    researchPrincipalId: issuer.actorId,
    payloadArtifactId: "stage-input",
    payloadSha256: "d".repeat(64),
    policySelectionId: "stage-selection",
    policySelectionSha256: "e".repeat(64),
    deadlineAt: END,
  };
  const lease = {
    ...scope,
    ...stable,
    jobId,
    eventId,
    leaseId: "historical-worker-lease",
    leaseEpoch: "1",
  };
  const service = {
    ...scope,
    grantId: "historical-service-grant",
    servicePrincipalId: "stage-worker",
    operations: ["stageArtifact"],
    issuedAt: BEFORE,
    expiresAt: END,
    revokedAt: null,
  };
  const descriptor = {
    ...scope,
    artifactId: evidence.pin.artifactId,
    jobId,
    collectionId: null,
    contentSha256: evidence.pin.artifactSha256,
    canonicalSha256: evidence.pin.artifactSha256,
    contentType: "application/json",
    rightsPolicyId: evidence.rights["policyId"],
    rightsVersion: evidence.rights["version"],
    createdAt: START,
  };
  table("vertex_worker_stages").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    collection_key: "",
    artifact_id: evidence.pin.artifactId,
    job_id: jobId,
    content_sha256: evidence.pin.artifactSha256,
    canonical_sha256: evidence.pin.artifactSha256,
    byte_length: evidence.body.byteLength,
    object_key: evidence.key,
    request_hash: await hashArtifact(descriptor),
    payload: descriptor,
  });
  table("vertex_worker_jobs").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    job_id: jobId,
    event_id: eventId,
    grant_id: service.grantId,
    lease_id: lease.leaseId,
    lease_epoch: lease.leaseEpoch,
    binding_hash: await hashArtifact({ scope, eventId, ...stable }),
    payload: lease,
  });
  table("vertex_worker_run_admissions").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    job_id: jobId,
    admitted_at: START,
    lease_epoch: lease.leaseEpoch,
  });
  table("vertex_worker_service_grants").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    grant_id: service.grantId,
    service_principal_id: service.servicePrincipalId,
    record_hash: await hashArtifact(service),
    payload: service,
  });
  await setGrant(issuer.actorId, evidence.pin.artifactId, ["publish"]);
  await setGrant(reviewer.actorId, evidence.pin.artifactId, ["review"]);
  await setGrant(
    reviewer.actorId,
    researchChatStorageReviewResource(responseRequestId),
    ["review"]
  );
  await setGrant(
    owner.actorId,
    researchChatContextUseResource(responseRequestId),
    ["publish"]
  );
  const inertPin = (artifactId: string) => ({
    artifactId,
    artifactSha256: "f".repeat(64),
    contractName: "FixturePin",
    schemaVersion: "1.0.0",
  });
  const provider = {
    providerId: "fixture-provider",
    modelVersion: "fixture-model",
    servedModel: "fixture-model",
    tokenizerArtifact: inertPin("tokenizer"),
    tokenizeEndpoint: inertPin("tokenize-endpoint"),
    completionEndpoint: inertPin("completion-endpoint"),
    maximumInputTokens: 1024,
    maximumOutputTokens: 64,
    maximumCostUsd: "1",
  };
  const reviewPins = [
    {
      collectionId: "corpus",
      evidenceId: "corpus-evidence",
      artifactId: "corpus-artifact",
      artifactSha256: "f".repeat(64),
      reviewId: "corpus-review",
      reviewVersion: "1.0.0",
      rightsPolicyId: "corpus-rights",
      rightsVersion: "1.0.0",
    },
  ];
  const configuration = {
    schemaVersion: "1.0.0",
    format: "vertex-research-chat-expert-configuration-v1",
    ...scope,
    participantId: "expert-1",
    participantLabel: "Synthetic Expert",
    personaText: "Synthetic role only.",
    collectionId: "corpus",
    snapshotId: "snapshot",
    taskContract: "research-task",
    provider,
    reviewPins,
    modelPolicy: inertPin("model-policy"),
    budgets: {
      requestTokens: 2048,
      attemptTokens: 2048,
      requestCostUsd: "1",
      attemptCostUsd: "1",
      tokenizeCostUsd: "0.1",
      completionCostUsd: "0.9",
    },
    advisoryMaximumBytes: 8192,
    expiresAt: END,
  };
  const configurationArtifact = await artifact(
    "expert-configuration",
    configuration,
    "ResearchChatExpertConfiguration"
  );
  const { retrievalQuery: omittedQuery, ...metadata } = request;
  // This is a strict descriptive persisted-plan fixture, NOT a successfully
  // prepared plan or accepted qualification. Its original bytes remain fixed.
  const planBody = {
    schemaVersion: "1.0.0",
    format: "vertex-research-chat-plan-v1",
    ...metadata,
    ownerActorId: owner.actorId,
    responseRequestId,
    requestSha256,
    plannedAt: PLANNED,
    expiresAt: END,
    participantConfiguration: configurationArtifact.pin,
    collectionId: configuration.collectionId,
    snapshotId: configuration.snapshotId,
    reviewPins,
    selectionId: "selected-policy",
    selectionSha256: "a".repeat(64),
    retentionArtifact: inertPin("retention"),
    retentionSha256: "b".repeat(64),
    storageEvidence: evidence.pin,
    capabilityReferenceId: storageIdentity.capabilityReferenceId,
    backendDeploymentId: storageIdentity.backendDeploymentId,
    storageProfileSha256: storageIdentity.storageProfileSha256,
    provider,
    inputPolicy: {
      modelPolicySha256: "f".repeat(64),
      modelPolicy: inertPin("model-policy"),
      endpointPolicySha256: {
        "model-tokenize": "f".repeat(64),
        "model-completion": "f".repeat(64),
      },
      modelDescriptorSha256: "f".repeat(64),
      modelDescriptor: inertPin("model-descriptor"),
    },
    context: { sha256: "c".repeat(64), byteLength: 1 },
    tokenizeInput: { sha256: "d".repeat(64), byteLength: 1 },
    completionInput: { sha256: "e".repeat(64), byteLength: 1 },
    runId: "fixture-run",
    traceId: "fixture-trace",
    taskContract: configuration.taskContract,
    advisoryMaximumBytes: configuration.advisoryMaximumBytes,
    executionAuthorized: false,
  };
  const planSha256 = await hashArtifact(planBody);
  const plan = VERTEX_RESEARCH_CHAT_EXECUTION_SCHEMAS.plan.parse({
    ...planBody,
    planId: `chat-plan-${planSha256}`,
    planSha256,
  });
  table("vertex_research_chat_execution_plans").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    response_request_id: responseRequestId,
    owner_actor_id: owner.actorId,
    thread_id: request.threadId,
    request_sha256: requestSha256,
    plan_id: plan.planId,
    plan_sha256: planSha256,
    record_hash: await hashArtifact(plan),
    payload: plan,
  });
  const unexpectedCopy = async (): Promise<never> => {
    throw new Error("timing fixture must not execute governed copy operations");
  };
  const options: VertexResearchChatExecutionOptions = {
    validate: (name, value) =>
      VERTEX_RESEARCH_CHAT_EXECUTION_SCHEMAS[name].parse(value) as VertexRecord,
    experts: [
      { participantId: "expert-1", artifact: configurationArtifact.pin },
    ],
    storage: {
      ...storageIdentity,
      evidence: evidence.pin,
      reviewerActorId: reviewer.actorId,
      capabilities: {
        createCopy: unexpectedCopy,
        inspectCopy: unexpectedCopy,
        readCopy: unexpectedCopy,
        fenceCopy: unexpectedCopy,
      },
    },
    readSelectedArtifact: async (
      transaction,
      principal,
      selectedScope,
      pin
    ) => {
      if (selectedScope.environment === "live") {
        throw new Error("fixture never reads live-scope artifacts");
      }
      return await artifacts.readSelectedArtifact(
        transaction,
        principal,
        { ...selectedScope, environment: selectedScope.environment },
        pin as Parameters<typeof artifacts.readSelectedArtifact>[3]
      );
    },
    readCollectionArtifact: async () => {
      throw new Error("fixture must not reach unwired collection reader");
    },
    readSelection: async () => {
      state.selectionReads++;
      throw new Error(
        "fixture stops at unwired execution selection/input-builder boundary"
      );
    },
    readRetention: async () => {
      throw new Error("fixture must not reach unwired retention composition");
    },
    prepareInputs: async () => {
      throw new Error("no replacement pure input builder");
    },
  };
  const operations = createResearchChatExecutionOperations(ctx, options);
  const reviewInput = {
    ...scope,
    responseRequestId,
    planId: plan.planId,
    planSha256: plan.planSha256,
    evidence: evidence.pin,
    decision: "accepted",
    allowedCopyOperations: ["create", "inspect", "read", "fence"],
    expiresAt: END,
    expectedReviewId: null,
    idempotencyKey: "storage-review-key",
  };
  const recordReview = (overrides: Row = {}) =>
    operations.recordResearchChatStorageQualificationReview(reviewer, {
      ...reviewInput,
      ...overrides,
    });
  const readReview = () =>
    ctx.run(
      owner,
      scope,
      null,
      researchChatContextUseResource(responseRequestId),
      "publish",
      (transaction, at) =>
        operations.readResearchChatStorageQualificationForTransaction(
          transaction,
          owner,
          scope,
          plan,
          at
        ),
      true
    );
  const approveInput = {
    planId: plan.planId,
    planSha256: plan.planSha256,
    request,
  };
  state.at = PLANNED;
  return {
    state,
    calls,
    lifecycle,
    tables,
    table,
    grants,
    db,
    tx,
    ctx,
    authorization,
    chat,
    operations,
    plan,
    request,
    approveInput,
    options,
    evidence,
    reportOne,
    reportTwo,
    configurationArtifact,
    setGrant,
    setRights,
    append,
    recordReview,
    readReview,
  };
};
