import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  snapshotVertexChatCopyBinding,
  vertexChatCopyKey,
} from "@darkfactory/storage/chat-copies";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client.ts";
import type { VertexRecord } from "./vertex-ports.ts";
import {
  createVertexResearchChatCopyCleanupStore,
  type VertexResearchChatCopyCleanupOptions,
} from "./vertex-research-chat-copy-cleanup-service.ts";

// Offline persistence doubles only. No PostgreSQL/lock/rotation qualification.
const scope = {
  accountAlias: "cleanup-room",
  environment: "research" as const,
};
const owner = { actorId: "original-human" };
const serviceActor = "independent-cleanup-service";
const before = "2026-09-24T12:00:00.000000001Z";
const now = "2026-09-24T12:01:00.000000001Z";
const expiry = "2026-09-24T12:05:00.000000001Z";
const credentialDigest = "a".repeat(64);
const ns = (value: string) => timestampToEpochNanoseconds(value).toString();
const hash = (value: unknown) => hashArtifact(canonicalArtifactJson(value));
type Row = Record<string, unknown>;
const TABLE = "vertex_research_chat_copy_";
const fixture = async () => {
  const requestMetadata = {
    ...scope,
    threadId: "thread-1",
    parentMessageId: "message-1",
    participantId: "expert-1",
    snapshotRevision: "2",
    contextStartSequence: "1",
    idempotencyKey: "response-1",
  };
  const responseRequestId = `response-${await hash({ operation: "requestResponse", actorId: owner.actorId, scope, threadId: requestMetadata.threadId, idempotencyKey: requestMetadata.idempotencyKey })}`;
  const family = {
    profile: "vertex-research-chat-copy-family-v1",
    ...scope,
    ownerActorId: owner.actorId,
    threadId: requestMetadata.threadId,
    responseRequestId,
    requestSha256: "b".repeat(64),
    requestMetadata,
    storageProfileSha256: "c".repeat(64),
    createdAt: before,
  };
  const identity = {
    scope,
    ownerActorId: owner.actorId,
    threadId: family.threadId,
    responseRequestId,
    requestSha256: family.requestSha256,
    kind: "context" as const,
    copyIdempotencyKey: "context-1",
    storageProfileSha256: family.storageProfileSha256,
    maximumBytes: 100,
    parentCopyIds: [],
  };
  const copyId = `chat-copy-${await hash({ operation: "reserveResearchChatCopy", actorId: owner.actorId, scope, threadId: family.threadId, responseRequestId, kind: identity.kind, copyIdempotencyKey: identity.copyIdempotencyKey })}`;
  const base = {
    profile: "vertex-research-chat-copy-allocation-v1",
    ...identity,
    copyId,
  };
  const reservationSha256 = await hash(base);
  const binding = snapshotVertexChatCopyBinding({
    scope,
    ownerActorId: owner.actorId,
    threadId: family.threadId,
    responseRequestId,
    copyId,
    kind: "context",
    storageProfileSha256: family.storageProfileSha256,
    maximumBytes: 100,
    reservationSha256,
    content: null,
  });
  const allocation = {
    ...base,
    reservationSha256,
    reservedAt: before,
    binding,
    objectKey: vertexChatCopyKey(binding),
  };
  const tables = new Map<string, Row[]>();
  const common = {
    account_alias: scope.accountAlias,
    environment: scope.environment,
    response_request_id: responseRequestId,
  };
  tables.set(`${TABLE}families`, [
    {
      ...common,
      owner_actor_id: owner.actorId,
      thread_id: family.threadId,
      request_sha256: family.requestSha256,
      storage_profile_sha256: family.storageProfileSha256,
      request_idempotency_key: requestMetadata.idempotencyKey,
      created_at: before,
      created_at_ns: ns(before),
      payload: family,
      record_hash: await hash(family),
    },
  ]);
  tables.set(`${TABLE}allocations`, [
    {
      ...common,
      owner_actor_id: owner.actorId,
      thread_id: family.threadId,
      request_sha256: family.requestSha256,
      copy_id: copyId,
      copy_idempotency_key: identity.copyIdempotencyKey,
      kind: "context",
      storage_profile_sha256: family.storageProfileSha256,
      maximum_bytes: 100,
      reservation_sha256: reservationSha256,
      object_key: allocation.objectKey,
      reserved_at: before,
      reserved_at_ns: ns(before),
      payload: allocation,
      record_hash: await hash(allocation),
    },
  ]);
  const worker = {
    grantId: "credential-grant",
    servicePrincipalId: serviceActor,
    ...scope,
    operations: ["chat-copy-cleanup-discovery"],
    issuedAt: before,
    expiresAt: expiry,
    revokedAt: null,
  };
  const credential: Row = {
    account_alias: scope.accountAlias,
    environment: scope.environment,
    grant_id: worker.grantId,
    service_principal_id: serviceActor,
    credential_digest: credentialDigest,
    issued_at_ns: ns(before),
    expires_at_ns: ns(expiry),
    revoked_at: null,
    payload: worker,
    record_hash: await hash(worker),
  };
  tables.set("vertex_worker_service_grants", [credential]);
  const grants: Row[] = [];
  const addGrant = async (
    grantId: string,
    response = responseRequestId,
    actorId = serviceActor,
    overrides: Row = {}
  ) => {
    const bound = {
      grantId,
      granteeActorId: actorId,
      scope,
      collectionId: null,
      resourceId: `research-chat-copies:${response}`,
      actions: ["cleanup-chat-copies"],
      ...overrides,
    };
    const version = {
      ...bound,
      version: "1.0.0",
      revision: "1",
      status: "granted",
      validFrom: before,
      expiresAt: expiry,
      recordedAt: before,
      recordedByActorId: "grant-admin",
    };
    const row: Row = {
      account_alias: scope.accountAlias,
      environment: scope.environment,
      grant_id: grantId,
      grantee_actor_id: actorId,
      collection_key: "",
      resource_id: bound.resourceId,
      binding_hash: await hashArtifact(bound),
      binding_payload: bound,
      version_payload: version,
      record_hash: await hashArtifact(version),
      request_hash: "d".repeat(64),
      version_status: "granted",
      valid_from: before,
      valid_from_ns: ns(before),
      expires_at: expiry,
      expires_at_ns: ns(expiry),
      recorded_at: before,
      recorded_at_ns: ns(before),
      recorded_by_actor_id: "grant-admin",
      expected_version: null,
      version_name: "1.0.0",
      version_revision: "1",
      current_version: "1.0.0",
      current_revision: "1",
    };
    grants.push(row);
    return row;
  };
  await addGrant("grant-000");
  let time = now;
  let active = false;
  const calls: { sql: string; params: unknown[] }[] = [];
  const controls: {
    query: ((text: string, rows: Row[]) => Promise<Row[]>) | null;
    lock: (() => void) | null;
    commit: (() => void) | null;
    hash: (() => void) | null;
    clock: (() => string) | null;
  } = { query: null, lock: null, commit: null, hash: null, clock: null };
  const dialect = new PgDialect();
  const execute = vi.fn(async (statement: SQL) => {
    const q = dialect.sqlToQuery(statement);
    calls.push(q);
    if (q.sql.includes("pg_advisory_xact_lock")) {
      if (q.params[0] !== "vertex-authorization:global") controls.lock?.();
      return { rows: [] };
    }
    if (!q.sql.startsWith("select "))
      throw new Error("Metadata mutation attempted");
    let result: Row[];
    if (q.sql.includes("from vertex_grant_bindings")) {
      result = grants.filter(
        (row) =>
          row["version_status"] === "granted" &&
          row["collection_key"] === "" &&
          /^research-chat-copies:response-[0-9a-f]{64}$/.test(
            String(row["resource_id"])
          ) &&
          (row["version_payload"] as { actions: string[] }).actions.includes(
            "cleanup-chat-copies"
          )
      );
      for (const match of q.sql.matchAll(/b\.([a-z_]+) = \$(\d+)/g))
        result = result.filter(
          (row) => row[match[1]!] === q.params[Number(match[2]) - 1]
        );
      for (const match of q.sql.matchAll(/v\.([a-z_]+) (<=|>) \$(\d+)/g))
        result = result.filter((row) =>
          match[2] === "<="
            ? BigInt(String(row[match[1]!])) <=
              BigInt(String(q.params[Number(match[3]) - 1]))
            : BigInt(String(row[match[1]!])) >
              BigInt(String(q.params[Number(match[3]) - 1]))
        );
      const after = /b\.grant_id collate "C" > \$(\d+)/.exec(q.sql);
      if (after)
        result = result.filter(
          (row) =>
            String(row["grant_id"]) > String(q.params[Number(after[1]) - 1])
        );
      result.sort((a, b) =>
        String(a["grant_id"]) < String(b["grant_id"]) ? -1 : 1
      );
    } else {
      const table = /^select \* from "([a-z_]+)"/.exec(q.sql)?.[1];
      if (
        !table ||
        (table !== "vertex_worker_service_grants" && !table.startsWith(TABLE))
      )
        throw new Error("Body/processing query attempted");
      result = [...(tables.get(table) ?? [])];
      for (const match of q.sql.matchAll(/([a-z_]+) = \$(\d+)/g))
        result = result.filter(
          (row) => row[match[1]!] === q.params[Number(match[2]) - 1]
        );
      if (q.sql.includes("order by cleanup_request_id"))
        result.sort((a, b) =>
          String(a["cleanup_request_id"]) < String(b["cleanup_request_id"])
            ? -1
            : 1
        );
    }
    const limit = /limit (?:\$(\d+)|(\d+))/.exec(q.sql);
    if (limit)
      result = result.slice(
        0,
        limit[1] ? Number(q.params[Number(limit[1]) - 1]) : Number(limit[2])
      );
    return {
      rows: structuredClone((await controls.query?.(q.sql, result)) ?? result),
    };
  });
  const transaction = vi.fn(
    async (
      operation: (tx: { execute: typeof execute }) => Promise<unknown>
    ) => {
      if (active) throw new Error("Nested independent transaction");
      active = true;
      try {
        const result = await operation({ execute });
        controls.commit?.();
        return result;
      } finally {
        active = false;
      }
    }
  );
  const registered = new Set<string>([canonicalArtifactJson(worker)]);
  const options: VertexResearchChatCopyCleanupOptions = {
    boundary: {
      encode: (value) => new TextEncoder().encode(canonicalArtifactJson(value)),
      digest: async (bytes) => {
        const result = await hashArtifact(bytes);
        controls.hash?.();
        return result;
      },
      validate: async (name, value) => {
        if (
          name !== "ResearchChatCopyCleanupReceipt" ||
          !registered.has(canonicalArtifactJson(value))
        )
          throw new Error("Unexpected boundary record");
        return structuredClone(value) as VertexRecord;
      },
      validateResearchChatInput: async (name, value) => {
        if (
          name !== "readCopyCleanup" ||
          !registered.has(canonicalArtifactJson(value))
        )
          throw new Error("Unexpected boundary input");
        return structuredClone(value) as VertexRecord;
      },
    },
    clock: { now: () => controls.clock?.() ?? time },
    validateWorker: async (name, value) => {
      if (
        name !== "WorkerServiceGrant" ||
        !registered.has(canonicalArtifactJson(value))
      )
        throw new Error("Unexpected worker record");
      return structuredClone(value) as VertexRecord;
    },
    authorizeGrantAdministration: vi.fn(async () => {
      throw new Error("Metadata cannot administer grants");
    }),
  };
  const db = { execute, transaction } as unknown as Database;
  const store = createVertexResearchChatCopyCleanupStore(db, options);
  const close = async () => {
    const value = {
      profile: "vertex-research-chat-copy-closure-v1",
      scope,
      responseRequestId,
      closureId: `copy-closure-${await hash({ operation: "closeResearchChatCopyFamily", scope, responseRequestId })}`,
      closedByActorId: "independent-closer",
      closedAt: before,
      inventorySha256: await hash({
        family,
        copies: [{ allocation, contentBinding: null }],
      }),
      copyIds: [copyId],
    };
    tables.set(`${TABLE}closures`, [
      {
        ...common,
        closure_id: value.closureId,
        closed_by_actor_id: value.closedByActorId,
        closed_at: before,
        closed_at_ns: ns(before),
        inventory_sha256: value.inventorySha256,
        payload: value,
        record_hash: await hash(value),
      },
    ]);
    return value;
  };
  const intent = async (key = "cleanup-1") => {
    const closure = await close();
    const command = {
      ...scope,
      threadId: family.threadId,
      responseRequestId,
      idempotencyKey: key,
    };
    const requestSha256 = await hash({
      operation: "requestCopyCleanup",
      actorId: owner.actorId,
      input: command,
    });
    const receipt = {
      schemaVersion: "1.0.0",
      executionAuthorized: false,
      status: "requested",
      ...command,
      ownerActorId: owner.actorId,
      cleanupRequestId: `copy-cleanup-${requestSha256}`,
      requestSha256,
      recordedAt: before,
      targetKinds: ["context", "model-input", "derived-output"],
    };
    const value = {
      profile: "vertex-research-chat-copy-explicit-cleanup-intent-v1",
      receipt,
      closureId: closure.closureId,
      inventorySha256: closure.inventorySha256,
    };
    const row = {
      ...common,
      owner_actor_id: owner.actorId,
      thread_id: family.threadId,
      idempotency_key: key,
      cleanup_request_id: receipt.cleanupRequestId,
      request_sha256: requestSha256,
      recorded_at: before,
      recorded_at_ns: ns(before),
      closure_id: closure.closureId,
      inventory_sha256: closure.inventorySha256,
      payload: value,
      record_hash: await hash(value),
    };
    tables.set(`${TABLE}cleanup_intents`, [
      ...(tables.get(`${TABLE}cleanup_intents`) ?? []),
      row,
    ]);
    registered.add(canonicalArtifactJson(command));
    registered.add(canonicalArtifactJson(receipt));
    return receipt;
  };
  return {
    store,
    db,
    options,
    execute,
    transaction,
    calls,
    tables,
    grants,
    credential,
    worker,
    registered,
    controls,
    responseRequestId,
    family,
    allocation,
    addGrant,
    close,
    intent,
    setTime: (value: string) => {
      return (time = value);
    },
  };
};

const authenticated = async () => {
  const h = await fixture();
  const identity = await h.store.authenticate(credentialDigest, scope);
  h.calls.length = 0;
  return { h, identity };
};

describe("actual cleanup metadata service authority", () => {
  it("constructs with zero I/O and authenticates independent service exact grants without processing", async () => {
    const h = await fixture();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
    const identity = await h.store.authenticate(credentialDigest, scope);
    expect(identity.servicePrincipalId).toBe(serviceActor);
    expect(Object.isFrozen(identity.scope)).toBe(true);
    const discovered = await h.store.discover(identity, {
      cursor: null,
      limit: 64,
    });
    expect(discovered.value).toEqual({
      responseRequestIds: [h.responseRequestId],
      nextCursor: null,
    });
    const read = await h.store.read(identity, h.responseRequestId);
    expect(read.value).toEqual({
      inventory: {
        family: h.family,
        copies: [{ allocation: h.allocation, contentBinding: null }],
        closure: null,
      },
      explicitIntent: null,
    });
    expect(h.calls.every((q) => q.sql.startsWith("select "))).toBe(true);
    expect(
      h.calls.some((q) =>
        /research_chat_(threads|messages)|vertex_worker_jobs|account-scope/.test(
          q.sql
        )
      )
    ).toBe(false);
    expect(h.options.authorizeGrantAdministration).not.toHaveBeenCalled();
    expect(Object.keys(h.store).sort()).toEqual([
      "authenticate",
      "discover",
      "read",
    ]);
    return expect(
      h.calls
        .filter((q) => q.sql.includes("pg_advisory_xact_lock"))
        .map((q) => q.params[0])
    ).toEqual(
      Array.from({ length: 3 }, () => [
        "vertex-authorization:global",
        JSON.stringify(["vertex", scope.accountAlias, scope.environment]),
      ]).flat()
    );
  });
  it("preserves explicit requested ACK and does not mistake generic closure for intent", async () => {
    const { h, identity } = await authenticated();
    await h.close();
    expect(
      (await h.store.read(identity, h.responseRequestId)).value?.explicitIntent
    ).toBeNull();
    const receipts = [
      await h.intent("request-a"),
      await h.intent("request-b"),
    ].sort((a, b) => (a.cleanupRequestId < b.cleanupRequestId ? -1 : 1));
    h.calls.length = 0;
    const read = await h.store.read(identity, h.responseRequestId);
    expect(read.value?.explicitIntent).toEqual(receipts[0]);
    expect(read.value?.explicitIntent?.["ownerActorId"]).toBe(owner.actorId);
    expect(read.value?.explicitIntent?.["status"]).toBe("requested");
    return expect(
      h.calls.filter((q) => q.sql.includes("cleanup_intents")).map((q) => q.sql)
    ).toEqual([
      expect.stringMatching(/order by cleanup_request_id collate "C" limit 1$/),
      expect.stringMatching(/idempotency_key = .* limit 2$/),
      expect.stringMatching(/cleanup_request_id = .* limit 2$/),
    ]);
  });
  it("bounds current-grant candidates, deduplicates one page and uses stable scope-bound cursors", async () => {
    const { h, identity } = await authenticated();
    for (let i = 1; i < 66; i++)
      await h.addGrant(
        `grant-${String(i).padStart(3, "0")}`,
        i < 64 ? h.responseRequestId : `response-${String(i).padStart(64, "0")}`
      );
    const first = await h.store.discover(identity, { cursor: null, limit: 64 });
    expect(first.value.responseRequestIds).toEqual([h.responseRequestId]);
    expect(first.value.nextCursor).toEqual({
      ...scope,
      afterGrantId: "grant-063",
    });
    const second = await h.store.discover(identity, {
      cursor: first.value.nextCursor,
      limit: 64,
    });
    expect(second.value.responseRequestIds).toHaveLength(2);
    expect(second.value.nextCursor).toBeNull();
    expect(
      h.calls.filter((q) => q.sql.includes("from vertex_grant_bindings"))
    ).toHaveLength(2);
    for (const q of h.calls.filter((q) =>
      q.sql.includes("from vertex_grant_bindings")
    ))
      expect(q.params.at(-1)).toBe(64);
    await expect(
      h.store.discover(identity, {
        cursor: { ...scope, accountAlias: "other", afterGrantId: "grant-063" },
        limit: 64,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    for (const limit of [0, -1, 65, 1.5, Number.NaN])
      await expect(
        h.store.discover(identity, { cursor: null, limit })
      ).rejects.toMatchObject({ code: "invalid" });
    h.grants.length = 0;
    await expect(
      h.store.read(identity, h.responseRequestId)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(
      (
        await h.store.discover(identity, {
          cursor: first.value.nextCursor,
          limit: 64,
        })
      ).value.responseRequestIds
    ).toEqual([]);
  });
  it("rejects forged, cloned, cross-instance identities and caller actor overrides", async () => {
    const { h, identity } = await authenticated();
    const other = createVertexResearchChatCopyCleanupStore(h.db, h.options);
    for (const candidate of [
      { ...identity },
      structuredClone(identity),
      { ...identity, servicePrincipalId: owner.actorId },
    ])
      await expect(
        h.store.read(candidate, h.responseRequestId)
      ).rejects.toMatchObject({ code: "denied" });
    await expect(
      other.read(identity, h.responseRequestId)
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      h.store.discover(identity, {
        cursor: null,
        limit: 64,
        actorId: owner.actorId,
      } as never)
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      h.store.authenticate(credentialDigest, { ...scope, environment: "paper" })
    ).rejects.toMatchObject({ code: "denied" });
    return await expect(
      h.store.authenticate("f".repeat(64), scope)
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("does not borrow original-owner or generic-read grants and needs the distinct credential permission", async () => {
    const { h, identity } = await authenticated();
    h.grants.length = 0;
    await h.addGrant("owner-grant", h.responseRequestId, owner.actorId);
    await h.addGrant("read-grant", h.responseRequestId, serviceActor, {
      actions: ["read"],
    });
    await h.addGrant("other-family", `response-${"f".repeat(64)}`);
    await expect(
      h.store.read(identity, h.responseRequestId)
    ).rejects.toMatchObject({ code: "denied" });
    const changed = { ...h.worker, operations: ["status"] };
    h.registered.add(canonicalArtifactJson(changed));
    h.credential["payload"] = changed;
    h.credential["record_hash"] = await hash(changed);
    return await expect(
      h.store.authenticate(credentialDigest, scope)
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("rechecks resource authority under the common lock before looking up family existence", async () => {
    const { h, identity } = await authenticated();
    h.controls.lock = () => {
      return (h.grants[0]!["version_status"] = "revoked");
    };
    await expect(
      h.store.read(identity, h.responseRequestId)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(
      h.calls.some((q) => q.sql.includes('from "vertex_research_chat_copy_'))
    ).toBe(false);
  });
  it.each([
    "grant_id",
    "service_principal_id",
    "account_alias",
    "environment",
    "issued_at_ns",
    "expires_at_ns",
    "record_hash",
  ])("rejects credential payload/column mismatch: %s", async (field) => {
    const h = await fixture();
    h.credential[field] = "corrupt";
    return await expect(
      h.store.authenticate(credentialDigest, scope)
    ).rejects.toMatchObject({
      code: expect.stringMatching(/denied|integrity/),
    });
  });
  it.each([
    "binding_hash",
    "record_hash",
    "current_version",
    "current_revision",
    "version_revision",
    "valid_from_ns",
    "expires_at_ns",
    "recorded_at_ns",
    "recorded_by_actor_id",
    "expected_version",
  ])(
    "rejects selected current-resource integrity mismatch: %s",
    async (field) => {
      const { h, identity } = await authenticated();
      h.controls.query = async (text, rows) =>
        text.includes("from vertex_grant_bindings")
          ? rows.map((row) => ({ ...row, [field]: "corrupt" }))
          : rows;
      return await expect(
        h.store.discover(identity, { cursor: null, limit: 64 })
      ).rejects.toMatchObject({
        code: expect.stringMatching(/invalid|integrity/),
      });
    }
  );
  it.each(["revoked", "expired", "rotated", "under-lock"])(
    "rechecks credential state: %s",
    async (mode) => {
      const { h, identity } = await authenticated();
      if (mode === "expired") {
        h.setTime(expiry);
      } else if (mode === "rotated") {
        h.credential["credential_digest"] = "f".repeat(64);
      } else if (mode === "under-lock") {
        h.controls.lock = () => {
          return (h.credential["revoked_at"] = now);
        };
      } else h.credential["revoked_at"] = now;
      return await expect(
        h.store.read(identity, h.responseRequestId)
      ).rejects.toMatchObject({ code: "denied" });
    }
  );
  it.each(["hash", "commit", "final-credential"])(
    "rejects expiry across delayed %s work",
    async (mode) => {
      const { h, identity } = await authenticated();
      if (mode === "hash") h.controls.hash = () => h.setTime(expiry);
      if (mode === "commit") h.controls.commit = () => h.setTime(expiry);
      if (mode === "final-credential") {
        let reads = 0;
        h.controls.query = async (text, rows) => {
          if (
            text.includes('from "vertex_worker_service_grants"') &&
            ++reads === 2
          )
            h.setTime(expiry);
          return rows;
        };
      }
      return await expect(
        h.store.read(identity, h.responseRequestId)
      ).rejects.toMatchObject({ code: "denied" });
    }
  );
  it("rechecks resource revocation after metadata and resource expiry after final credential hash", async () => {
    const { h, identity } = await authenticated();
    h.controls.query = async (text, rows) => {
      if (text.includes('from "vertex_research_chat_copy_families"'))
        h.grants[0]!["version_status"] = "revoked";
      return rows;
    };
    await expect(
      h.store.read(identity, h.responseRequestId)
    ).rejects.toMatchObject({ code: "denied" });
    h.grants[0]!["version_status"] = "granted";
    h.controls.query = null;
    const resourceExpiry = "2026-09-24T12:02:00.000000001Z";
    const row = h.grants[0]!;
    const version = {
      ...(row["version_payload"] as Row),
      expiresAt: resourceExpiry,
    };
    Object.assign(row, {
      version_payload: version,
      record_hash: await hashArtifact(version),
      expires_at: resourceExpiry,
      expires_at_ns: ns(resourceExpiry),
    });
    let credentialQueries = 0;
    h.controls.query = async (text, rows) => {
      if (
        text.includes('from "vertex_worker_service_grants"') &&
        ++credentialQueries === 2
      )
        h.controls.hash = () => h.setTime(resourceExpiry);
      return rows;
    };
    return await expect(
      h.store.read(identity, h.responseRequestId)
    ).rejects.toMatchObject({ code: "denied" });
  });
  for (const operation of ["discover", "read"] as const) {
    it.each([
      {
        boundary: "before expiry",
        observedAt: "2026-09-24T12:01:59.000000001Z",
      },
      { boundary: "at expiry", observedAt: "2026-09-24T12:02:00.000000001Z" },
      {
        boundary: "after expiry",
        observedAt: "2026-09-24T12:02:00.000000002Z",
      },
    ])(
      `rejects ${operation} clock rollback after the final credential observes $boundary`,
      async ({ observedAt }) => {
        const { h, identity } = await authenticated();
        const resourceExpiry = "2026-09-24T12:02:00.000000001Z";
        const rolledBackAt = "2026-09-24T12:01:30.000000001Z";
        const row = h.grants[0]!;
        const version = {
          ...(row["version_payload"] as Row),
          expiresAt: resourceExpiry,
        };
        Object.assign(row, {
          version_payload: version,
          record_hash: await hashArtifact(version),
          expires_at: resourceExpiry,
          expires_at_ns: ns(resourceExpiry),
        });
        let credentialQueries = 0;
        const finalSamples: string[] = [];
        h.controls.query = async (text, rows) => {
          if (
            text.includes('from "vertex_worker_service_grants"') &&
            ++credentialQueries === 2
          ) {
            // The private credential owner samples first; finish must not lose it.
            h.controls.clock = () => {
              const value =
                finalSamples.length === 0 ? observedAt : rolledBackAt;
              finalSamples.push(value);
              return value;
            };
          }
          return rows;
        };
        const result =
          operation === "discover"
            ? h.store.discover(identity, { cursor: null, limit: 64 })
            : h.store.read(identity, h.responseRequestId);
        await expect(result).rejects.toMatchObject({ code: "denied" });
        expect(credentialQueries).toBe(2);
        expect(finalSamples).toEqual([observedAt, rolledBackAt]);
        expect(timestampToEpochNanoseconds(rolledBackAt)).toBeGreaterThan(
          timestampToEpochNanoseconds(now)
        );
        return expect(timestampToEpochNanoseconds(observedAt)).toBeLessThan(
          timestampToEpochNanoseconds(identity.expiresAt)
        );
      }
    );
    it(`returns ${operation} metadata when the final credential and commit clocks advance before resource expiry`, async () => {
      const { h, identity } = await authenticated();
      const resourceExpiry = "2026-09-24T12:02:00.000000001Z";
      const credentialAt = "2026-09-24T12:01:30.000000001Z";
      const committedAt = "2026-09-24T12:01:59.000000001Z";
      const row = h.grants[0]!;
      const version = {
        ...(row["version_payload"] as Row),
        expiresAt: resourceExpiry,
      };
      Object.assign(row, {
        version_payload: version,
        record_hash: await hashArtifact(version),
        expires_at: resourceExpiry,
        expires_at_ns: ns(resourceExpiry),
      });
      let credentialQueries = 0;
      h.controls.query = async (text, rows) => {
        if (
          text.includes('from "vertex_worker_service_grants"') &&
          ++credentialQueries === 2
        )
          h.setTime(credentialAt);
        return rows;
      };
      h.controls.commit = () => h.setTime(committedAt);
      const result =
        operation === "discover"
          ? await h.store.discover(identity, { cursor: null, limit: 64 })
          : await h.store.read(identity, h.responseRequestId);
      expect(result).toEqual({
        value:
          operation === "discover"
            ? { responseRequestIds: [h.responseRequestId], nextCursor: null }
            : {
                inventory: {
                  family: h.family,
                  copies: [{ allocation: h.allocation, contentBinding: null }],
                  closure: null,
                },
                explicitIntent: null,
              },
        checkedAt: committedAt,
        expiresAt: resourceExpiry,
      });
      return expect(credentialQueries).toBe(2);
    });
    it.each(["rollback", "expiry"])(
      `rejects ${operation} when the clock crosses the resource authority boundary at commit: %s`,
      async (mode) => {
        const { h, identity } = await authenticated();
        const resourceExpiry = "2026-09-24T12:02:00.000000001Z";
        const credentialAt = "2026-09-24T12:01:59.000000001Z";
        const row = h.grants[0]!;
        const version = {
          ...(row["version_payload"] as Row),
          expiresAt: resourceExpiry,
        };
        Object.assign(row, {
          version_payload: version,
          record_hash: await hashArtifact(version),
          expires_at: resourceExpiry,
          expires_at_ns: ns(resourceExpiry),
        });
        let credentialQueries = 0;
        h.controls.query = async (text, rows) => {
          if (
            text.includes('from "vertex_worker_service_grants"') &&
            ++credentialQueries === 2
          )
            h.setTime(credentialAt);
          return rows;
        };
        h.controls.commit = () =>
          h.setTime(
            mode === "rollback"
              ? "2026-09-24T12:01:30.000000001Z"
              : resourceExpiry
          );
        const result =
          operation === "discover"
            ? h.store.discover(identity, { cursor: null, limit: 64 })
            : h.store.read(identity, h.responseRequestId);
        await expect(result).rejects.toMatchObject({ code: "denied" });
        return expect(credentialQueries).toBe(2);
      }
    );
  }
  it.each([
    "owner_actor_id",
    "thread_id",
    "cleanup_request_id",
    "inventory_sha256",
    "record_hash",
    "recorded_at_ns",
  ])("rejects selected original intent corruption: %s", async (field) => {
    const { h, identity } = await authenticated();
    await h.intent();
    h.tables.get(`${TABLE}cleanup_intents`)![0]![field] = "corrupt";
    return await expect(
      h.store.read(identity, h.responseRequestId)
    ).rejects.toMatchObject({ code: "integrity" });
  });
  return it("distinguishes absent family, orphan intent and incomplete/corrupt inventory", async () => {
    const { h, identity } = await authenticated();
    await h.intent();
    h.tables.delete(`${TABLE}allocations`);
    await expect(
      h.store.read(identity, h.responseRequestId)
    ).rejects.toMatchObject({ code: "integrity" });
    h.tables.delete(`${TABLE}families`);
    h.tables.delete(`${TABLE}closures`);
    await expect(
      h.store.read(identity, h.responseRequestId)
    ).rejects.toMatchObject({ code: "integrity" });
    h.tables.delete(`${TABLE}cleanup_intents`);
    return expect(
      (await h.store.read(identity, h.responseRequestId)).value
    ).toBeNull();
  });
});
