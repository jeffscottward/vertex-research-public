import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@darkfactory/db/server";
import { createVertexResearchChatCopyCleanupStore } from "@darkfactory/db/server/vertex-worker";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  snapshotVertexChatCopyBinding,
  vertexChatCopyKey,
} from "@darkfactory/storage/chat-copies";
import {
  WorkerOperationSchema,
  WorkerPermissionSchema,
  VERTEX_WORKER_CONTRACT_SCHEMAS,
} from "../contracts/vertex-worker.ts";
import { VERTEX_WORKER_METHOD_DEFINITIONS } from "../contracts/vertex-worker-rpc.ts";
import { createVertexPlatformRequestDependencies } from "./vertex-runtime.ts";
import { vertexPersistenceBoundary } from "./vertex-experience-adapter.ts";
import { createVertexResearchChatCopyCleanupService } from "./vertex-research-chat-copy-cleanup-service.ts";
import { bearerDigest } from "./vertex-worker-auth.ts";

const scope = {
  accountAlias: "cleanup-account",
  environment: "research" as const,
};
const responseRequestId = `response-${"a".repeat(64)}`;
const before = "2026-09-24T12:00:00.000000001Z";
const now = "2026-09-24T12:01:00.000000001Z";
const expiry = "2026-09-24T12:05:00.000000001Z";
const ns = (value: string) => timestampToEpochNanoseconds(value).toString();
// Public deterministic synthetic credential, never a configured secret.
const token = btoa("x".repeat(32))
  .replace(/[=]/g, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_");
const context = { headers: new Headers({ authorization: `Bearer ${token}` }) };
const pageInput = { ...scope, cursor: null, limit: 64 };
const readInput = { ...scope, responseRequestId };
const fixture = async (withInventory = false) => {
  const recordHash = (value: unknown) =>
    hashArtifact(canonicalArtifactJson(value));
  const requestMetadata = {
    ...scope,
    threadId: "thread-one",
    parentMessageId: "message-one",
    participantId: "expert-one",
    snapshotRevision: "2",
    contextStartSequence: "1",
    idempotencyKey: "request-one",
  };
  const ownerActorId = "original-human";
  const response = withInventory
    ? `response-${await recordHash({ operation: "requestResponse", actorId: ownerActorId, scope, threadId: requestMetadata.threadId, idempotencyKey: requestMetadata.idempotencyKey })}`
    : responseRequestId;
  const metadataRows = new Map<string, Record<string, unknown>[]>();
  if (withInventory) {
    const family = {
      profile: "vertex-research-chat-copy-family-v1",
      ...scope,
      ownerActorId,
      threadId: requestMetadata.threadId,
      responseRequestId: response,
      requestSha256: "c".repeat(64),
      requestMetadata,
      storageProfileSha256: "d".repeat(64),
      createdAt: before,
    };
    const copyId = `chat-copy-${await recordHash({ operation: "reserveResearchChatCopy", actorId: ownerActorId, scope, threadId: family.threadId, responseRequestId: response, kind: "context", copyIdempotencyKey: "copy-one" })}`;
    const base = {
      profile: "vertex-research-chat-copy-allocation-v1",
      scope,
      ownerActorId,
      threadId: family.threadId,
      responseRequestId: response,
      requestSha256: family.requestSha256,
      copyId,
      copyIdempotencyKey: "copy-one",
      kind: "context" as const,
      storageProfileSha256: family.storageProfileSha256,
      maximumBytes: 2_097_152,
      parentCopyIds: [],
    };
    const reservationSha256 = await recordHash(base);
    const copyBinding = snapshotVertexChatCopyBinding({
      scope,
      ownerActorId,
      threadId: family.threadId,
      responseRequestId: response,
      copyId,
      kind: "context",
      storageProfileSha256: family.storageProfileSha256,
      maximumBytes: base.maximumBytes,
      reservationSha256,
      content: null,
    });
    const allocation = {
      ...base,
      reservationSha256,
      reservedAt: before,
      binding: copyBinding,
      objectKey: vertexChatCopyKey(copyBinding),
    };
    const common = {
      account_alias: scope.accountAlias,
      environment: scope.environment,
      response_request_id: response,
    };
    metadataRows.set("vertex_research_chat_copy_families", [
      {
        ...common,
        owner_actor_id: ownerActorId,
        thread_id: family.threadId,
        request_sha256: family.requestSha256,
        storage_profile_sha256: family.storageProfileSha256,
        request_idempotency_key: requestMetadata.idempotencyKey,
        created_at: before,
        created_at_ns: ns(before),
        payload: family,
        record_hash: await recordHash(family),
      },
    ]);
    metadataRows.set("vertex_research_chat_copy_allocations", [
      {
        ...common,
        owner_actor_id: ownerActorId,
        thread_id: family.threadId,
        request_sha256: family.requestSha256,
        copy_id: copyId,
        copy_idempotency_key: base.copyIdempotencyKey,
        kind: base.kind,
        storage_profile_sha256: family.storageProfileSha256,
        maximum_bytes: base.maximumBytes,
        reservation_sha256: reservationSha256,
        object_key: allocation.objectKey,
        reserved_at: before,
        reserved_at_ns: ns(before),
        payload: allocation,
        record_hash: await recordHash(allocation),
      },
    ]);
    const closure = {
      profile: "vertex-research-chat-copy-closure-v1",
      scope,
      responseRequestId: response,
      closureId: `copy-closure-${await recordHash({ operation: "closeResearchChatCopyFamily", scope, responseRequestId: response })}`,
      closedByActorId: ownerActorId,
      closedAt: before,
      inventorySha256: await recordHash({
        family,
        copies: [{ allocation, contentBinding: null }],
      }),
      copyIds: [copyId],
    };
    metadataRows.set("vertex_research_chat_copy_closures", [
      {
        ...common,
        closure_id: closure.closureId,
        closed_by_actor_id: ownerActorId,
        closed_at: before,
        closed_at_ns: ns(before),
        inventory_sha256: closure.inventorySha256,
        payload: closure,
        record_hash: await recordHash(closure),
      },
    ]);
    const command = {
      ...scope,
      threadId: family.threadId,
      responseRequestId: response,
      idempotencyKey: "cleanup-one",
    };
    const requestSha256 = await recordHash({
      operation: "requestCopyCleanup",
      actorId: ownerActorId,
      input: command,
    });
    const receipt = {
      schemaVersion: "1.0.0",
      executionAuthorized: false,
      status: "requested",
      ...command,
      ownerActorId,
      cleanupRequestId: `copy-cleanup-${requestSha256}`,
      requestSha256,
      recordedAt: before,
      targetKinds: ["context", "model-input", "derived-output"],
    };
    const intent = {
      profile: "vertex-research-chat-copy-explicit-cleanup-intent-v1",
      receipt,
      closureId: closure.closureId,
      inventorySha256: closure.inventorySha256,
    };
    metadataRows.set("vertex_research_chat_copy_cleanup_intents", [
      {
        ...common,
        owner_actor_id: ownerActorId,
        thread_id: family.threadId,
        idempotency_key: command.idempotencyKey,
        cleanup_request_id: receipt.cleanupRequestId,
        request_sha256: requestSha256,
        recorded_at: before,
        recorded_at_ns: ns(before),
        closure_id: closure.closureId,
        inventory_sha256: closure.inventorySha256,
        payload: intent,
        record_hash: await recordHash(intent),
      },
    ]);
  }
  const digest = await bearerDigest(context.headers);
  const servicePrincipalId = "dedicated-cleaner";
  const workerGrant = {
    grantId: "worker-credential",
    servicePrincipalId,
    ...scope,
    operations: ["chat-copy-cleanup-discovery"],
    issuedAt: before,
    expiresAt: expiry,
    revokedAt: null,
  };
  const credential: Record<string, unknown> = {
    account_alias: scope.accountAlias,
    environment: scope.environment,
    grant_id: workerGrant.grantId,
    service_principal_id: servicePrincipalId,
    credential_digest: digest,
    issued_at_ns: ns(before),
    expires_at_ns: ns(expiry),
    revoked_at: null,
    payload: workerGrant,
    record_hash: await hashArtifact(canonicalArtifactJson(workerGrant)),
  };
  const binding = {
    grantId: "exact-family",
    granteeActorId: servicePrincipalId,
    scope,
    collectionId: null,
    resourceId: `research-chat-copies:${response}`,
    actions: ["cleanup-chat-copies"],
  };
  const version = {
    ...binding,
    version: "1.0.0",
    revision: "1",
    status: "granted",
    validFrom: before,
    expiresAt: expiry,
    recordedAt: before,
    recordedByActorId: "offline-admin-fixture",
  };
  const resource: Record<string, unknown> = {
    account_alias: scope.accountAlias,
    environment: scope.environment,
    grant_id: binding.grantId,
    grantee_actor_id: servicePrincipalId,
    collection_key: "",
    resource_id: binding.resourceId,
    binding_hash: await hashArtifact(binding),
    binding_payload: binding,
    version_payload: version,
    record_hash: await hashArtifact(version),
    request_hash: "b".repeat(64),
    version_status: "granted",
    valid_from: before,
    valid_from_ns: ns(before),
    expires_at: expiry,
    expires_at_ns: ns(expiry),
    recorded_at: before,
    recorded_at_ns: ns(before),
    recorded_by_actor_id: version.recordedByActorId,
    expected_version: null,
    version_name: "1.0.0",
    version_revision: "1",
    current_version: "1.0.0",
    current_revision: "1",
  };
  let time = now;
  const calls: string[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (fragment: SQL) => {
    const q = dialect.sqlToQuery(fragment);
    calls.push(q.sql);
    if (q.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (q.sql.includes('from "vertex_worker_service_grants"')) {
      const selected =
        q.params[0] === scope.accountAlias &&
        q.params[1] === scope.environment &&
        (q.params[2] === digest || q.params[2] === workerGrant.grantId);
      return { rows: selected ? [structuredClone(credential)] : [] };
    }
    if (q.sql.includes("from vertex_grant_bindings")) {
      const selected =
        q.params[0] === scope.accountAlias &&
        q.params[1] === scope.environment &&
        q.params[2] === servicePrincipalId &&
        resource["version_status"] === "granted" &&
        (q.sql.includes("b.resource_id =")
          ? q.params[3] === binding.resourceId
          : true);
      return { rows: selected ? [structuredClone(resource)] : [] };
    }
    const table = /^select \* from "(vertex_research_chat_copy_[a-z_]+)"/.exec(
      q.sql
    )?.[1];
    if (table) return { rows: structuredClone(metadataRows.get(table) ?? []) };
    throw new Error("Unexpected body, processing or write SQL");
  });
  let active = false;
  const transaction = vi.fn(
    async (
      operation: (tx: { execute: typeof execute }) => Promise<unknown>
    ) => {
      if (active) throw new Error("Nested transaction");
      active = true;
      try {
        return await operation({ execute });
      } finally {
        active = false;
      }
    }
  );
  const db = { execute, transaction } as unknown as Database;
  const clock = { now: () => time };
  const worker = {
    routes: [],
    emitterBindings: [],
    serverPrincipal: vi.fn(async () => null),
    authorizeGrantAdministration: vi.fn(async () => false),
  };
  const body = vi.fn(async () => {
    throw new Error("Object content must remain unavailable");
  });
  const objectsForScope = vi.fn(() => ({
    objects: { put: body, get: body, delete: body },
  }));
  const runtime = createVertexPlatformRequestDependencies({
    db,
    clock,
    worker,
    objectsForScope,
  } as unknown as Parameters<
    typeof createVertexPlatformRequestDependencies
  >[0]);
  const service = runtime.administration.chatCopyCleanup!;
  const store = createVertexResearchChatCopyCleanupStore(db, {
    boundary: vertexPersistenceBoundary,
    clock,
    authorizeGrantAdministration: worker.authorizeGrantAdministration,
    validateWorker: async (name, value) =>
      VERTEX_WORKER_CONTRACT_SCHEMAS[
        name as keyof typeof VERTEX_WORKER_CONTRACT_SCHEMAS
      ].parse(value),
  });
  return {
    db,
    clock,
    worker,
    body,
    objectsForScope,
    runtime,
    service,
    store,
    execute,
    transaction,
    calls,
    credential,
    resource,
    response,
    setTime: (value: string) => {
      return (time = value);
    },
  };
};

describe("private actual runtime cleanup metadata composition", () => {
  it("returns complete original inventory and one original explicit ACK through the actual runtime boundary", async () => {
    const h = await fixture(true);
    const value = await h.service.read(context, {
      ...scope,
      responseRequestId: h.response,
    });
    expect(value?.inventory.copies).toHaveLength(1);
    expect(value?.inventory.copies[0]?.allocation.maximumBytes).toBe(2_097_152);
    expect(value?.inventory.copies[0]?.allocation.binding.content).toBeNull();
    expect(value?.explicitIntent).toMatchObject({
      status: "requested",
      executionAuthorized: false,
      ownerActorId: "original-human",
      recordedAt: before,
      targetKinds: ["context", "model-input", "derived-output"],
    });
    expect(Object.isFrozen(value?.inventory)).toBe(true);
    expect(h.body).not.toHaveBeenCalled();
    return expect(h.calls.every((sql) => sql.startsWith("select "))).toBe(true);
  });
  it("uses real bearer, credential and exact-family owners with no processing policy and no constructor I/O", async () => {
    const h = await fixture();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.runtime.contextDependencies.vertexWorker).toBeUndefined();
    expect(h.runtime.administration).not.toHaveProperty("worker");
    expect("chatCopyCleanup" in h.runtime.contextDependencies).toBe(false);
    expect(h.runtime.administration.policy).toBeUndefined();
    expect(Object.keys(h.service).sort()).toEqual(["discover", "read"]);
    await expect(h.service.discover(context, pageInput)).resolves.toEqual({
      responseRequestIds: [responseRequestId],
      nextCursor: null,
    });
    await expect(h.service.read(context, readInput)).resolves.toBeNull();
    expect(h.calls.every((sql) => sql.startsWith("select "))).toBe(true);
    expect(
      h.calls.some((sql) =>
        /account-scope|research_chat_(threads|messages)|vertex_worker_jobs/.test(
          sql
        )
      )
    ).toBe(false);
    expect(h.body).not.toHaveBeenCalled();
    expect(h.objectsForScope).not.toHaveBeenCalled();
    expect(h.worker.serverPrincipal).not.toHaveBeenCalled();
    return expect(h.worker.authorizeGrantAdministration).not.toHaveBeenCalled();
  });
  it("does not activate a service without explicit worker configuration or widen worker execution permissions", async () => {
    const h = await fixture();
    const runtime = createVertexPlatformRequestDependencies({
      db: h.db,
      clock: h.clock,
    });
    expect(runtime.administration.chatCopyCleanup).toBeUndefined();
    expect(runtime.contextDependencies.vertexWorker).toBeUndefined();
    expect(
      WorkerPermissionSchema.safeParse("chat-copy-cleanup-discovery").success
    ).toBe(true);
    expect(
      WorkerOperationSchema.safeParse("chat-copy-cleanup-discovery").success
    ).toBe(false);
    return expect(
      Object.hasOwn(
        VERTEX_WORKER_METHOD_DEFINITIONS,
        "chat-copy-cleanup-discovery"
      )
    ).toBe(false);
  });
  it.each([
    undefined,
    "",
    "Basic synthetic",
    "Bearer x",
    `Bearer ${token}=`,
    `Bearer ${token} extra`,
  ])(
    "rejects missing or noncanonical bearer without touching credentials: %s",
    async (header) => {
      const h = await fixture();
      await expect(
        h.service.discover(
          {
            headers: new Headers(
              header === undefined ? {} : { authorization: header }
            ),
          },
          pageInput
        )
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      return expect(h.execute).not.toHaveBeenCalled();
    }
  );
  it("rejects actor overrides, extra fields, nonresearch scope, malformed cursors and hostile data before authentication", async () => {
    const h = await fixture();
    const getter = vi.fn(() => scope.accountAlias);
    const accessor = Object.defineProperty({ ...pageInput }, "accountAlias", {
      get: getter,
      enumerable: true,
    });
    for (const raw of [
      accessor,
      { ...pageInput, actorId: "original-human" },
      { ...pageInput, environment: "paper" },
      { ...pageInput, limit: 65 },
      {
        ...pageInput,
        cursor: { ...scope, accountAlias: "other", afterGrantId: "grant" },
      },
      { ...pageInput, accountAlias: " cleanup-account" },
      { ...pageInput, cursor: "grant" },
      { ...pageInput, body: "private-sentinel" },
    ]) {
      await expect(h.service.discover(context, raw)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(getter).not.toHaveBeenCalled();
    return expect(h.execute).not.toHaveBeenCalled();
  });
  it("requires resource and credential authority independently and reauthenticates every call", async () => {
    const h = await fixture();
    await h.service.discover(context, pageInput);
    h.resource["version_status"] = "revoked";
    await expect(h.service.read(context, readInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    h.credential["revoked_at"] = now;
    await expect(h.service.discover(context, pageInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    return expect(h.body).not.toHaveBeenCalled();
  });
  it("sanitizes source failures and never leaks injected body, upstream message or authority window", async () => {
    const h = await fixture();
    const read = vi.fn(async () => {
      throw new Error("PRIVATE-UPSTREAM-SENTINEL");
    });
    const service = createVertexResearchChatCopyCleanupService({
      store: { ...h.store, read },
      clock: h.clock,
    });
    const error = await service
      .read(context, readInput)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(String(error)).not.toContain("PRIVATE-UPSTREAM-SENTINEL");
    const poisoned = createVertexResearchChatCopyCleanupService({
      store: {
        ...h.store,
        discover: async () => ({
          value: {
            responseRequestIds: [],
            nextCursor: null,
            body: "PRIVATE-BODY",
          },
          checkedAt: now,
          expiresAt: expiry,
        }),
      },
      clock: h.clock,
    });
    await expect(poisoned.discover(context, pageInput)).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    const clean = await h.service.discover(context, pageInput);
    return expect(Object.keys(clean).sort()).toEqual([
      "nextCursor",
      "responseRequestIds",
    ]);
  });
  return it("rejects expiry during the final asynchronous DB boundary and abort after authentication", async () => {
    const h = await fixture();
    const service = createVertexResearchChatCopyCleanupService({
      store: {
        ...h.store,
        discover: async (identity, input) => {
          const result = await h.store.discover(identity, input);
          h.setTime(expiry);
          return result;
        },
      },
      clock: h.clock,
    });
    await expect(service.discover(context, pageInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    h.setTime(now);
    const controller = new AbortController();
    controller.abort();
    return await expect(
      h.service.read({ ...context, signal: controller.signal }, readInput)
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});
