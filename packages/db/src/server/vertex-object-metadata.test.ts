import type { ObjectMetadata } from "@darkfactory/storage";
import { vertexQualifiedObjectKey } from "@darkfactory/storage";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client.ts";
import { createVertexObjectMetadataRepository } from "./vertex-object-metadata.ts";
import type { VertexAuthorization, VertexScope } from "./vertex-ports.ts";

const scope: VertexScope = {
  accountAlias: "synthetic-account",
  environment: "research",
};
const digest = "a".repeat(64);
const key = vertexQualifiedObjectKey(
  scope,
  "synthetic-collection",
  "manifest",
  digest
);
const at = "2026-09-22T12:00:00.000000001Z";
const metadata: ObjectMetadata = {
  key,
  size: 10,
  contentType: "application/json",
  checksum: digest,
  createdAt: at,
  updatedAt: at,
};
const row = {
  account_alias: scope.accountAlias,
  environment: scope.environment,
  collection_key: "synthetic-collection",
  object_key: key,
  kind: "manifest",
  digest,
  size: "10",
  content_type: "application/json",
  checksum: digest,
  created_at: at,
  updated_at: at,
};
const fixture = (
  selected: Record<string, unknown>[] = [row],
  maximumContentBytes = 1_048_576
) => {
  const dialect = new PgDialect();
  const queries: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query);
    queries.push(compiled);
    return { rows: compiled.sql.startsWith("select") ? selected : [] };
  });
  const transaction = vi.fn(
    async (
      operation: (tx: { execute: typeof execute }) => Promise<unknown>,
      _config?: unknown
    ) => operation({ execute })
  );
  const authorize = vi.fn(
    async (_request: Parameters<VertexAuthorization["authorize"]>[0]) => true
  );
  const options = {
    scope,
    principal: { actorId: "synthetic-actor" },
    collectionId: "synthetic-collection",
    clock: { now: () => at },
    authorization: { authorize },
    maximumContentBytes,
  };
  const db = { transaction } as unknown as Database;
  return {
    queries,
    execute,
    transaction,
    authorize,
    db,
    options,
    repository: createVertexObjectMetadataRepository(db, options),
  };
};

// No database/provider creation or test execution occurred while authoring.
describe("request-scoped immutable ObjectMetadataRepository", () => {
  it("upserts only by create-or-compare and never overwrites another immutable object", async () => {
    const test = fixture();
    await test.repository.upsert(metadata);
    expect(test.transaction).toHaveBeenCalledTimes(1);
    expect(test.queries[0]?.sql).toContain(
      "on conflict (account_alias, environment, collection_key, object_key) do nothing"
    );
    expect(test.queries[0]?.sql).not.toContain("do update");
    expect(test.queries[1]?.params).toEqual([
      scope.accountAlias,
      scope.environment,
      "synthetic-collection",
      key,
    ]);
    return expect(
      test.authorize.mock.calls.every(
        ([request]) =>
          request.scope.accountAlias === scope.accountAlias &&
          request.scope.environment === scope.environment &&
          request.collectionId === "synthetic-collection" &&
          request.action === "publish"
      )
    ).toBe(true);
  });

  it("returns frozen metadata only after exact-scoped read permission", async () => {
    const test = fixture();
    const value = await test.repository.findByKey(key);
    expect(value).toEqual(metadata);
    expect(Object.isFrozen(value)).toBe(true);
    expect(test.transaction.mock.calls[0]?.[1]).toEqual({
      accessMode: "read only",
    });
    expect(test.queries[0]?.params).toEqual([
      scope.accountAlias,
      scope.environment,
      "synthetic-collection",
      key,
    ]);
    return expect(test.authorize).toHaveBeenCalledTimes(2);
  });

  it("returns null for missing metadata without inventing an empty object", async () =>
    expect(await fixture([]).repository.findByKey(key)).toBeNull());

  it("denies cross-account environment collection and account-wide aliases before SQL", async () => {
    const test = fixture();
    const wrong = [
      vertexQualifiedObjectKey(
        { ...scope, accountAlias: "other" },
        "synthetic-collection",
        "manifest",
        digest
      ),
      vertexQualifiedObjectKey(
        { ...scope, environment: "paper" },
        "synthetic-collection",
        "manifest",
        digest
      ),
      vertexQualifiedObjectKey(scope, "other", "manifest", digest),
      vertexQualifiedObjectKey(scope, null, "manifest", digest),
    ];
    for (const objectKey of wrong) {
      await expect(test.repository.findByKey(objectKey)).rejects.toMatchObject({
        code: "denied",
      });
    }
    return expect(test.transaction).not.toHaveBeenCalled();
  });

  it("denies missing scope permission before metadata SQL", async () => {
    const test = fixture();
    test.authorize.mockResolvedValue(false);
    await expect(test.repository.upsert(metadata)).rejects.toMatchObject({
      code: "denied",
    });
    await expect(test.repository.findByKey(key)).rejects.toMatchObject({
      code: "denied",
    });
    return expect(test.transaction).not.toHaveBeenCalled();
  });

  it("detects immutable size type timestamp and checksum changes", async () => {
    const test = fixture();
    for (const change of [
      { size: 11 },
      { contentType: "application/octet-stream" },
      { createdAt: "2026-09-22T12:00:00Z" },
    ]) {
      await expect(
        test.repository.upsert({ ...metadata, ...change })
      ).rejects.toMatchObject({ code: "conflict" });
    }
    await expect(
      test.repository.upsert({ ...metadata, checksum: "b".repeat(64) })
    ).rejects.toMatchObject({ code: "integrity" });
    return await expect(
      test.repository.upsert({
        ...metadata,
        updatedAt: "2026-09-22T12:00:00.000000002Z",
      })
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("retains the 1MiB manifest cap even with a larger raw-content budget", async () => {
    const test = fixture([row], 64 * 1_048_576);
    await expect(
      test.repository.upsert({ ...metadata, size: 1_048_577 })
    ).rejects.toMatchObject({ code: "invalid" });
    expect(test.transaction).not.toHaveBeenCalled();
    const contentKey = vertexQualifiedObjectKey(
      scope,
      "synthetic-collection",
      "content",
      digest
    );
    const contentMetadata = {
      ...metadata,
      key: contentKey,
      contentType: "application/octet-stream",
      size: 1_048_577,
    };
    const content = fixture(
      [
        {
          ...row,
          object_key: contentKey,
          kind: "content",
          content_type: "application/octet-stream",
          size: "1048577",
        },
      ],
      64 * 1_048_576
    );
    return await expect(
      content.repository.upsert(contentMetadata)
    ).resolves.toBeUndefined();
  });

  it("refuses a mismatched digest/kind or malformed database row", async () => {
    await expect(
      fixture([{ ...row, digest: "b".repeat(64) }]).repository.findByKey(key)
    ).rejects.toMatchObject({ code: "integrity" });
    await expect(
      fixture([{ ...row, kind: "content" }]).repository.findByKey(key)
    ).rejects.toMatchObject({ code: "integrity" });
    return await expect(
      fixture([{ ...row, size: "9007199254740992" }]).repository.findByKey(key)
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("does not allow generic deleteByKey to bypass retention or shared references", async () => {
    const test = fixture();
    await expect(test.repository.deleteByKey(key)).rejects.toMatchObject({
      code: "denied",
    });
    expect(test.transaction).not.toHaveBeenCalled();
    return expect(test.queries).toHaveLength(0);
  });

  it("rejects accessor metadata without executing user code", async () => {
    const test = fixture();
    let accessed = false;
    const hostile = { ...metadata };
    Object.defineProperty(hostile, "size", {
      enumerable: true,
      get: () => {
        accessed = true;
        return 10;
      },
    });
    await expect(test.repository.upsert(hostile)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(accessed).toBe(false);
    return expect(test.transaction).not.toHaveBeenCalled();
  });

  it("requires explicit database clock and authorization injection", () => {
    const test = fixture();
    expect(() =>
      createVertexObjectMetadataRepository(test.db, {
        ...test.options,
        authorization: undefined!,
      })
    ).toThrow();
    expect(() =>
      createVertexObjectMetadataRepository(test.db, {
        ...test.options,
        clock: undefined!,
      })
    ).toThrow();
    for (const maximumContentBytes of [
      0,
      -1,
      Number.NaN,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        createVertexObjectMetadataRepository(test.db, {
          ...test.options,
          maximumContentBytes,
        })
      ).toThrow();
    }
  });

  return it("does not expose database exception details", async () => {
    const test = fixture();
    test.transaction.mockRejectedValue(
      new Error("private-database-connection-details")
    );
    return await expect(test.repository.findByKey(key)).rejects.toMatchObject({
      code: "unavailable",
      message: "Vertex persistence unavailable",
    });
  });
});
