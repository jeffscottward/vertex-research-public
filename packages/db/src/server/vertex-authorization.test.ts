import { readFileSync } from "node:fs";
import {
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../schema/vertex-authorization.ts";
import type { Database } from "./client.ts";
import { createVertexAuthorization } from "./vertex-authorization.ts";
import type {
  VertexGrantBinding,
  VertexGrantVersion,
  VertexIssueGrantInput,
  VertexRevokeGrantInput,
} from "./vertex-authorization-ports.ts";
import type { VertexAction, VertexScope } from "./vertex-ports.ts";

// Authored only. This fixture double compiles parameterized SQL when tests are
// eventually allowed; no database engine, credentials or provider is used.
const NOW = "2026-09-22T12:00:00.000000001Z";
const BEFORE = "2026-09-22T11:59:59.000000001Z";
const START = "2026-09-22T11:59:00.000000001Z";
const END = "2026-09-22T12:10:00.000000001Z";
const administrator = { actorId: "privileged-operator" };
const principal = { actorId: "researcher-1" };
const scope: VertexScope = { accountAlias: "account-a", environment: "paper" };
const base: VertexGrantBinding = {
  grantId: "grant-1",
  granteeActorId: principal.actorId,
  scope,
  collectionId: "collection-1",
  resourceId: "dataset-1",
  actions: ["read"],
};
const issue = (
  overrides: Partial<VertexIssueGrantInput> = {}
): VertexIssueGrantInput => ({
  ...base,
  principal: administrator,
  version: "1.0.0",
  expectedVersion: null,
  validFrom: START,
  expiresAt: END,
  ...overrides,
});
const revoke = (
  overrides: Partial<VertexRevokeGrantInput> = {}
): VertexRevokeGrantInput => ({
  principal: administrator,
  grantId: base.grantId,
  scope,
  collectionId: base.collectionId,
  version: "2.0.0",
  expectedVersion: "1.0.0",
  ...overrides,
});
const query = (overrides: Record<string, unknown> = {}) => ({
  principal,
  scope,
  collectionId: base.collectionId,
  resourceId: base.resourceId,
  action: "read" as const,
  now: NOW,
  ...overrides,
});
const ns = (value: string): string =>
  timestampToEpochNanoseconds(value).toString();
const row = async (
  overrides: Partial<VertexGrantVersion> = {}
): Promise<Record<string, unknown>> => {
  const value: VertexGrantVersion = {
    ...base,
    version: "1.0.0",
    revision: "1",
    status: "granted",
    validFrom: START,
    expiresAt: END,
    recordedAt: BEFORE,
    recordedByActorId: administrator.actorId,
    ...overrides,
  };
  const bound: VertexGrantBinding = {
    grantId: value.grantId,
    granteeActorId: value.granteeActorId,
    scope: value.scope,
    collectionId: value.collectionId,
    resourceId: value.resourceId,
    actions: [...value.actions].sort(),
  };
  return {
    account_alias: value.scope.accountAlias,
    environment: value.scope.environment,
    grant_id: value.grantId,
    grantee_actor_id: value.granteeActorId,
    collection_key: value.collectionId ?? "",
    resource_id: value.resourceId,
    binding_hash: await hashArtifact(bound),
    binding_payload: bound,
    version_payload: value,
    record_hash: await hashArtifact(value),
    request_hash: "a".repeat(64),
    version_status: value.status,
    valid_from_ns: ns(value.validFrom),
    expires_at_ns: ns(value.expiresAt),
    recorded_at_ns: ns(value.recordedAt),
    version_name: value.version,
    version_revision: value.revision,
    current_version: value.version,
    current_revision: value.revision,
  };
};
type Step = Readonly<{ match: RegExp; rows: Record<string, unknown>[] }>;
const CURRENT = /from vertex_grant_bindings b join vertex_grant_current/;
const VERSION = /select request_hash from vertex_grant_versions/;
const harness = (steps: Step[] = [], privilegeAbsent = false) => {
  const pending = [...steps];
  const calls: { sql: string; params: unknown[] }[] = [];
  const lifecycle: string[] = [];
  const dialect = new PgDialect();
  let clock = NOW;
  const privileged = vi.fn(async () => true);
  const beforeQuery = vi.fn((): void => {
    // Intentionally empty default hook.
  });
  const execute = vi.fn(async (fragment: SQL) => {
    const compiled = dialect.sqlToQuery(fragment);
    calls.push({ sql: compiled.sql, params: compiled.params });
    beforeQuery();
    if (compiled.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (pending[0]?.match.test(compiled.sql))
      return { rows: pending.shift()!.rows };
    if (/^select\b|\breturning\b/i.test(compiled.sql))
      throw new Error("Unexpected scripted query");
    return { rows: [] };
  });
  const transaction = vi.fn(
    async (operation: (tx: unknown) => Promise<unknown>) => {
      lifecycle.push("begin");
      try {
        const result = await operation({ execute });
        lifecycle.push("commit");
        return result;
      } catch (error) {
        lifecycle.push("rollback");
        throw error;
      }
    }
  );
  const db = { execute, transaction } as unknown as Database;
  const store = createVertexAuthorization(db, {
    clock: { now: () => clock },
    ...(privilegeAbsent
      ? {}
      : { privilegedAuthorization: { authorize: privileged } }),
  });
  return {
    store,
    db,
    calls,
    pending,
    lifecycle,
    execute,
    privileged,
    beforeQuery,
    setClock: (value: string) => {
      return (clock = value);
    },
  };
};

describe("persistent exact Vertex authorization", () => {
  it("grants only a current exact actor/account/environment/collection/resource/action", async () => {
    const h = harness([{ match: CURRENT, rows: [await row()] }]);
    expect(await h.store.authorize(query())).toBe(true);
    expect(h.calls[0]!.params).toEqual(
      expect.arrayContaining([
        scope.accountAlias,
        scope.environment,
        principal.actorId,
        base.collectionId,
        base.resourceId,
        "read",
      ])
    );
    expect(h.calls[0]!.sql).toContain("v.version = p.current_version");
    expect(h.calls[0]!.sql).toContain("a.version = v.version");
    return expect(h.privileged).not.toHaveBeenCalled();
  });
  it.each([
    { principal: { actorId: "admin" } },
    { scope: { ...scope, accountAlias: "foreign-account" } },
    { scope: { ...scope, environment: "live" } },
    { collectionId: null },
    { collectionId: "foreign-collection" },
    { resourceId: "foreign-resource" },
    { action: "publish" },
  ])(
    "denies a mismatched exact binding without an admin fallback: %s",
    async (changed) => {
      const h = harness([{ match: CURRENT, rows: [await row()] }]);
      return expect(await h.store.authorize(query(changed) as never)).toBe(
        false
      );
    }
  );
  it("does not interpret wildcard-looking data as a grant", async () => {
    const h = harness();
    expect(await h.store.authorize(query({ resourceId: "*" }) as never)).toBe(
      false
    );
    return expect(h.calls).toEqual([]);
  });
  it("denies missing, revoked, unknown and corrupted current records", async () => {
    for (const rows of [
      [],
      [await row({ status: "revoked" })],
      [await row({ status: "unknown" as never })],
      [{ ...(await row()), record_hash: "0".repeat(64) }],
    ]) {
      const h = harness([{ match: CURRENT, rows }]);
      expect(await h.store.authorize(query())).toBe(false);
    }
  });
  it("expired current-clock grants cannot be revived by an older input.now", async () => {
    const h = harness([
      { match: CURRENT, rows: [await row({ expiresAt: NOW })] },
    ]);
    return expect(
      await h.store.authorize(query({ now: BEFORE }) as never)
    ).toBe(false);
  });
  it("rejects future request time and grants not yet effective", async () => {
    const h = harness();
    expect(await h.store.authorize(query({ now: END }) as never)).toBe(false);
    expect(h.calls).toEqual([]);
    const future = harness([
      {
        match: CURRENT,
        rows: [
          await row({
            validFrom: END,
            expiresAt: "2026-09-22T12:20:00.000000001Z",
          }),
        ],
      },
    ]);
    return expect(await future.store.authorize(query())).toBe(false);
  });
  it("does not retroactively authorize requests before grant recording", async () => {
    const h = harness([{ match: CURRENT, rows: [await row()] }]);
    return expect(await h.store.authorize(query({ now: START }) as never)).toBe(
      false
    );
  });
  it("rechecks injected clock after a slow read and preserves nanosecond expiry", async () => {
    const h = harness([
      {
        match: CURRENT,
        rows: [await row({ expiresAt: "2026-09-22T12:00:00.000000002Z" })],
      },
    ]);
    h.beforeQuery.mockImplementation(() =>
      h.setClock("2026-09-22T12:00:00.000000002Z")
    );
    return expect(await h.store.authorize(query())).toBe(false);
  });
  return it("database failure and excessive candidates deny rather than broaden access", async () => {
    const missing = harness();
    expect(await missing.store.authorize(query())).toBe(false);
    const bounded = harness([
      { match: CURRENT, rows: Array.from({ length: 129 }, () => ({})) },
    ]);
    return expect(await bounded.store.authorize(query())).toBe(false);
  });
});

describe("dedicated chat-copy cleanup grants", () => {
  const request = {
    principal: { actorId: "cleanup-service" },
    scope: { accountAlias: "account-a", environment: "research" as const },
    collectionId: null,
    resourceId: `research-chat-copies:response-${"b".repeat(64)}`,
    action: "cleanup-chat-copies" as const,
    now: NOW,
  };
  const binding: Partial<VertexGrantVersion> = {
    granteeActorId: request.principal.actorId,
    scope: request.scope,
    collectionId: null,
    resourceId: request.resourceId,
    actions: ["cleanup-chat-copies"],
  };
  it("accepts only the current exact cleanup action without processing or issuer authority", async () => {
    const h = harness([{ match: CURRENT, rows: [await row(binding)] }], true);
    expect(await h.store.authorize(request)).toBe(true);
    expect(h.calls[0]!.params).toEqual(
      expect.arrayContaining([
        request.principal.actorId,
        request.scope.accountAlias,
        "research",
        "",
        request.resourceId,
        "cleanup-chat-copies",
      ])
    );
    expect(h.privileged).not.toHaveBeenCalled();
    return await expect(
      h.store.issueGrant(
        issue({
          ...binding,
          principal: request.principal,
          actions: ["cleanup-chat-copies"],
        })
      )
    ).rejects.toMatchObject({ code: "denied" });
  });
  return it("denies processing-only, foreign, revoked and expired grants for cleanup", async () => {
    const changes: Partial<VertexGrantVersion>[] = [
      { actions: ["read", "publish"] },
      { granteeActorId: "other-service" },
      { scope: { ...request.scope, accountAlias: "other-account" } },
      { scope: { ...request.scope, environment: "paper" } },
      { collectionId: "collection-1" },
      { resourceId: `research-chat-copies:response-${"c".repeat(64)}` },
      { status: "revoked" },
      { expiresAt: NOW },
    ];
    for (const changed of changes) {
      const h = harness(
        [{ match: CURRENT, rows: [await row({ ...binding, ...changed })] }],
        true
      );
      expect(await h.store.authorize(request)).toBe(false);
      expect(h.privileged).not.toHaveBeenCalled();
    }
  });
});

describe("dedicated scope listing grants", () => {
  it("lists only exact current read/account-scope/null-collection grants", async () => {
    const permitted = await row({
      collectionId: null,
      resourceId: "account-scope",
    });
    const duplicate = await row({
      grantId: "grant-2",
      collectionId: null,
      resourceId: "account-scope",
    });
    const content = await row({ grantId: "grant-3" });
    const foreign = await row({
      grantId: "grant-4",
      granteeActorId: "someone-else",
      collectionId: null,
      resourceId: "account-scope",
    });
    const h = harness([
      { match: CURRENT, rows: [permitted, duplicate, content, foreign] },
    ]);
    expect(await h.store.listAuthorizedScopes(principal)).toEqual([scope]);
    expect(h.calls[0]!.sql).toContain("b.collection_key = ''");
    expect(h.calls[0]!.sql).toContain("b.resource_id = 'account-scope'");
    expect(h.calls[0]!.sql).toContain("a.action = 'read'");
    return expect(h.calls[0]!.params[0]).toBe(principal.actorId);
  });
  it("does not enumerate from revoked/expired or content-only rights", async () => {
    const h = harness([
      {
        match: CURRENT,
        rows: [
          await row(),
          await row({
            grantId: "grant-2",
            collectionId: null,
            resourceId: "account-scope",
            status: "revoked",
          }),
          await row({
            grantId: "grant-3",
            collectionId: null,
            resourceId: "account-scope",
            expiresAt: NOW,
          }),
        ],
      },
    ]);
    return expect(await h.store.listAuthorizedScopes(principal)).toEqual([]);
  });
  return it("fails closed for unavailable storage or an excessive listing", async () => {
    expect(await harness().store.listAuthorizedScopes(principal)).toEqual([]);
    const h = harness([
      { match: CURRENT, rows: Array.from({ length: 257 }, () => ({})) },
    ]);
    return expect(await h.store.listAuthorizedScopes(principal)).toEqual([]);
  });
});

describe("independently privileged immutable grant mutations", () => {
  it("content read grants cannot bootstrap a self-issued grant", async () => {
    const h = harness([{ match: CURRENT, rows: [await row()] }], true);
    expect(await h.store.authorize(query())).toBe(true);
    const before = h.calls.length;
    await expect(
      h.store.issueGrant(
        issue({ principal, granteeActorId: principal.actorId })
      )
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      h.store.revokeGrant(revoke({ principal }))
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.calls).toHaveLength(before);
    return expect(h.db.transaction).not.toHaveBeenCalled();
  });
  it.each([false, undefined, "true", 1])(
    "denies a nonliteral privilege decision: %s",
    async (decision) => {
      const h = harness();
      h.privileged.mockResolvedValue(decision as boolean);
      await expect(h.store.issueGrant(issue())).rejects.toMatchObject({
        code: "denied",
      });
      return expect(h.calls).toEqual([]);
    }
  );
  it("redacts throwing privilege policy and checks privilege again inside the transaction", async () => {
    const h = harness();
    h.privileged
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("private privilege details"));
    await expect(h.store.issueGrant(issue())).rejects.toMatchObject({
      code: "denied",
      message: "Vertex persistence denied",
    });
    expect(h.lifecycle).toEqual(["begin", "rollback"]);
    return expect(
      h.calls.every((value) => value.sql.includes("pg_advisory_xact_lock"))
    ).toBe(true);
  });
  it("atomically records binding, immutable version/actions and current pointer", async () => {
    const h = harness([
      { match: CURRENT, rows: [] },
      { match: VERSION, rows: [] },
    ]);
    const input = issue({ actions: ["read", "publish"] });
    expect(await h.store.issueGrant(input)).toBe("recorded");
    expect(h.privileged).toHaveBeenCalledTimes(3);
    expect(h.privileged).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "issue-grant",
        binding: expect.objectContaining({
          granteeActorId: principal.actorId,
          scope,
          collectionId: base.collectionId,
          resourceId: base.resourceId,
          actions: ["publish", "read"],
        }),
      })
    );
    expect(
      h.calls.filter((value) =>
        value.sql.startsWith("insert into vertex_grant_actions")
      )
    ).toHaveLength(2);
    expect(
      h.calls.some((value) =>
        value.sql.startsWith("insert into vertex_grant_bindings")
      )
    ).toBe(true);
    expect(
      h.calls.some((value) =>
        value.sql.startsWith("insert into vertex_grant_current")
      )
    ).toBe(true);
    return expect(h.lifecycle).toEqual(["begin", "commit"]);
  });
  it("requires expectedVersion CAS and strictly increasing semantic versions", async () => {
    for (const input of [
      issue({ version: "2.0.0", expectedVersion: null }),
      issue({ version: "0.9.9", expectedVersion: "1.0.0" }),
    ]) {
      const h = harness([
        { match: CURRENT, rows: [await row()] },
        { match: VERSION, rows: [] },
      ]);
      await expect(h.store.issueGrant(input)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(h.calls.some((value) => value.sql.startsWith("insert into"))).toBe(
        false
      );
    }
  });
  it("rejects changing grantee, resource or actions while retaining grantId", async () => {
    const changes: Partial<VertexIssueGrantInput>[] = [
      { granteeActorId: "new-actor" },
      { resourceId: "different-resource" },
      { actions: ["read", "publish"] },
    ];
    for (const changed of changes) {
      const h = harness([
        { match: CURRENT, rows: [await row()] },
        { match: VERSION, rows: [] },
      ]);
      await expect(
        h.store.issueGrant(
          issue({ version: "2.0.0", expectedVersion: "1.0.0", ...changed })
        )
      ).rejects.toMatchObject({ code: "conflict" });
      expect(h.calls.some((value) => value.sql.startsWith("insert into"))).toBe(
        false
      );
    }
  });
  it("duplicates only the exact current immutable request and rejects changed payload", async () => {
    const input = issue();
    const requestHash = await hashArtifact({ action: "issue-grant", input });
    const steps = [
      { match: CURRENT, rows: [await row()] },
      { match: VERSION, rows: [{ request_hash: requestHash }] },
    ];
    const h = harness(steps);
    expect(await h.store.issueGrant(input)).toBe("duplicate");
    expect(h.calls.some((value) => value.sql.startsWith("insert into"))).toBe(
      false
    );
    const changed = harness(steps);
    await expect(
      changed.store.issueGrant({
        ...input,
        expiresAt: "2026-09-22T12:20:00.000000001Z",
      })
    ).rejects.toMatchObject({ code: "conflict" });
    const superseded = harness([
      {
        match: CURRENT,
        rows: [
          await row({ version: "2.0.0", revision: "2", status: "revoked" }),
        ],
      },
      steps[1]!,
    ]);
    return await expect(
      superseded.store.issueGrant(input)
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("rolls back all appended revision/action rows if the current pointer CAS fails", async () => {
    const h = harness([
      { match: CURRENT, rows: [await row()] },
      { match: VERSION, rows: [] },
      { match: /returning grant_id/, rows: [] },
    ]);
    await expect(
      h.store.issueGrant(issue({ version: "2.0.0", expectedVersion: "1.0.0" }))
    ).rejects.toMatchObject({ code: "conflict" });
    expect(h.lifecycle).toEqual(["begin", "rollback"]);
    expect(
      h.calls.some((value) =>
        value.sql.startsWith("insert into vertex_grant_versions")
      )
    ).toBe(true);
    return expect(
      h.calls.some((value) =>
        value.sql.startsWith("update vertex_grant_versions")
      )
    ).toBe(false);
  });
  it("resolves exact revocation binding, preserves history and advances only its pointer", async () => {
    const existing = await row();
    const h = harness([
      { match: CURRENT, rows: [existing] },
      { match: CURRENT, rows: [existing] },
      { match: VERSION, rows: [] },
      { match: /returning grant_id/, rows: [{ grant_id: base.grantId }] },
    ]);
    expect(await h.store.revokeGrant(revoke())).toBe("recorded");
    expect(h.privileged).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "revoke-grant",
        binding: base,
        expectedVersion: "1.0.0",
        version: "2.0.0",
        validFrom: START,
        expiresAt: END,
      })
    );
    const inserted = h.calls.find((value) =>
      value.sql.startsWith("insert into vertex_grant_versions")
    )!;
    expect(inserted.params).toContain("revoked");
    expect(
      h.calls
        .filter((value) => value.sql.startsWith("update"))
        .every((value) => value.sql.startsWith("update vertex_grant_current"))
    ).toBe(true);
    expect(h.calls.some((value) => /delete|truncate/i.test(value.sql))).toBe(
      false
    );
    return expect(h.lifecycle).toEqual(["begin", "commit"]);
  });
  it("foreign collection revocation cannot discover or repurpose a grant", async () => {
    const h = harness([{ match: CURRENT, rows: [] }]);
    await expect(
      h.store.revokeGrant(revoke({ collectionId: "other-collection" }))
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.privileged).not.toHaveBeenCalled();
    return expect(h.calls[0]!.params).toEqual([
      scope.accountAlias,
      scope.environment,
      "other-collection",
      base.grantId,
    ]);
  });
  return it("rejects accessors and invalid action/version batches before privilege evaluation", async () => {
    const h = harness();
    let invoked = false;
    const malicious = Object.defineProperty({ ...issue() }, "granteeActorId", {
      enumerable: true,
      get: () => {
        invoked = true;
        return principal.actorId;
      },
    });
    await expect(h.store.issueGrant(malicious)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(invoked).toBe(false);
    for (const input of [
      issue({ version: "01.0.0" }),
      issue({ actions: [] }),
      issue({ actions: ["read", "read"] }),
      issue({ actions: ["issue-grant" as VertexAction] }),
    ]) {
      await expect(h.store.issueGrant(input)).rejects.toMatchObject({
        code: "invalid",
      });
    }
    return expect(h.privileged).not.toHaveBeenCalled();
  });
});

describe("authorization migration preservation source", () => {
  it("normalizes only four new tables with exact actions and nanosecond timestamps", () => {
    const source = readFileSync(
      new URL(
        "../../migration-sources/0008_vertex_buildout/forward/0011_vertex_authorization.sql",
        import.meta.url
      ),
      "utf8"
    );
    const names = [...source.matchAll(/CREATE TABLE (vertex_[a-z_]+)/g)]
      .map((match) => match[1]!)
      .sort();
    expect(names).toEqual(
      Object.values(schema)
        .map((table) => getTableConfig(table).name)
        .sort()
    );
    expect(source).toContain("valid_from_ns numeric(30,0)");
    expect(source).toContain("grant_id text PRIMARY KEY");
    return expect(source).not.toMatch(
      /ALTER TABLE|DROP TABLE|CREATE EXTENSION|CREATE DATABASE/i
    );
  });
  return it("refuses populated reverse migration before dropping any new grant history", () => {
    const source = readFileSync(
      new URL(
        "../../migration-sources/0008_vertex_buildout/rollback/0011_vertex_authorization.down.sql",
        import.meta.url
      ),
      "utf8"
    );
    expect(source).toContain("IN ACCESS EXCLUSIVE MODE");
    for (const name of [
      "vertex_grant_bindings",
      "vertex_grant_versions",
      "vertex_grant_actions",
      "vertex_grant_current",
    ]) {
      expect(source).toContain(`EXISTS(SELECT 1 FROM ${name} LIMIT 1)`);
    }
    expect(source.indexOf("RAISE EXCEPTION")).toBeLessThan(
      source.indexOf("DROP TABLE")
    );
    return expect(source).not.toMatch(/CASCADE|TRUNCATE|DELETE FROM/i);
  });
});
