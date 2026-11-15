import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client.ts";
import { one, time } from "./vertex-persistence-core.ts";
import type {
  VertexArtifactMetadata,
  VertexBoundary,
  VertexBoundaryContractName,
  VertexRecord,
  VertexRightsRecord,
  VertexScope,
} from "./vertex-ports.ts";
import { createVertexStore } from "./vertex-repository.ts";

// Source-only authored regressions. No database, server, provider or credentials.
// The fixture boundary accepts only explicitly registered fixture graphs; it is
// not a second public schema. Integration injects the authoritative API parser.
const NOW = "2026-09-22T12:00:00.000000001Z";
const BEFORE = "2026-09-22T11:59:59.000000001Z";
const LATER = "2026-09-22T12:10:00.000000001Z";
const principal = { actorId: "reviewer-1" };
const scope: VertexScope = { accountAlias: "vertex-a", environment: "paper" };
const rights: VertexRightsRecord = {
  policyId: "policy-1",
  version: "1.0.0",
  status: "granted",
  allowedUses: ["store", "read", "derive"],
  checkedAt: BEFORE,
  expiresAt: LATER,
  retentionUntil: LATER,
};
const encoder = new TextEncoder();
const digest = async (bytes: Uint8Array): Promise<string> =>
  hashArtifact(new TextDecoder().decode(bytes));
const hash = (value: unknown): Promise<string> =>
  hashArtifact(canonicalArtifactJson(value));
const dialect = new PgDialect();
type Query = Readonly<{ sql: string; params: unknown[] }>;
type Step = Readonly<{ match: RegExp; rows: Record<string, unknown>[] }>;

const harness = (steps: Step[] = []) => {
  const pending = [...steps];
  const calls: Query[] = [];
  const lifecycle: string[] = [];
  const allowed = new Map<VertexBoundaryContractName, Set<string>>();
  const authorize = vi.fn(async () => true);
  const validate = vi.fn(
    async (
      name: VertexBoundaryContractName,
      input: unknown,
      version: "1.0.0"
    ): Promise<VertexRecord> => {
      if (
        version !== "1.0.0" ||
        !allowed.get(name)?.has(canonicalArtifactJson(input))
      )
        throw new Error("Fixture not registered");
      return structuredClone(input) as VertexRecord;
    }
  );
  const boundary: VertexBoundary = {
    validate,
    encode: (value) => encoder.encode(canonicalArtifactJson(value)),
    digest,
  };
  const execute = vi.fn(async (value: SQL) => {
    const query = dialect.sqlToQuery(value);
    calls.push({ sql: query.sql, params: query.params });
    if (query.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (pending[0]?.match.test(query.sql))
      return { rows: pending.shift()!.rows };
    // These legacy fixtures contain no native facts. Still assert the exact
    // additional scoped identity/pending query rather than defaulting all SQL.
    if (
      /^select \* from "vertex_native_fact_projections" where/.test(query.sql)
    ) {
      expect(query.params.slice(0, 2)).toEqual([
        scope.accountAlias,
        scope.environment,
      ]);
      expect(query.sql).toMatch(
        /projection_id = .* or \(stream_id = |stream_id = .* and owner_epoch >= .* and applied = false/
      );
      return { rows: [] };
    }
    if (
      /^select \* from "vertex_execution_projections" where/.test(query.sql) &&
      query.sql.includes("and applied = false")
    ) {
      expect(query.params.slice(0, 2)).toEqual([
        scope.accountAlias,
        scope.environment,
      ]);
      expect(query.sql).toMatch(
        /order by \(owner_epoch <> .* desc, sequence, projection_id/
      );
      return { rows: [] };
    }
    if (/^select\b/i.test(query.sql) || /returning\b/i.test(query.sql))
      throw new Error(`Unexpected fixture query: ${query.sql}`);
    return { rows: [] };
  });
  const tx = { execute };
  const db = {
    transaction: vi.fn(async (body: (value: unknown) => Promise<unknown>) => {
      lifecycle.push("begin");
      try {
        const value = await body(tx);
        lifecycle.push("commit");
        return value;
      } catch (error) {
        lifecycle.push("rollback");
        throw error;
      }
    }),
  } as unknown as Database;
  let clock = NOW;
  const store = createVertexStore(db, {
    boundary,
    clock: { now: () => clock },
    authorization: { authorize },
    maxProjectionAgeMs: 60_000,
  });
  const accept = (name: VertexBoundaryContractName, value: unknown): void => {
    if (!allowed.has(name)) allowed.set(name, new Set());
    allowed.get(name)!.add(canonicalArtifactJson(value));
  };
  return {
    store,
    db,
    tx,
    calls,
    lifecycle,
    pending,
    authorize,
    validate,
    boundary,
    accept,
    setClock: (value: string) => {
      return (clock = value);
    },
  };
};

const policyRow = async (value: VertexRightsRecord = rights) => ({
  policy_id: value.policyId,
  version: value.version,
  revision: "1",
  checked_at_ns: time(value.checkedAt).toString(),
  record_hash: await hash(value),
  payload: value,
});
const metadata = async (
  value: VertexRecord,
  contractName: VertexArtifactMetadata["contractName"] = "DatasetManifest",
  collectionId: string | null = null
): Promise<VertexArtifactMetadata> => ({
  artifactId: "artifact-1",
  scope,
  collectionId,
  objectKey: "sealed/artifact-1.json",
  artifactSha256: await hash(value),
  sourceContentSha256:
    typeof value["contentHash"] === "string" ? value["contentHash"] : null,
  byteLength: encoder.encode(canonicalArtifactJson(value)).byteLength,
  contentType: "application/json",
  schemaVersion: "1.0.0",
  contractName,
  rights,
  lineageArtifactIds: [],
  createdAt: BEFORE,
});
const artifactRow = async (value: VertexArtifactMetadata) => ({
  artifact_id: value.artifactId,
  collection_key: value.collectionId ?? "",
  metadata_hash: await hash(value),
  payload: value,
});
const head = (overrides: VertexRecord = {}) => ({
  stream_id: "native-stream",
  owner_epoch: "1",
  high_water_sequence: "1",
  high_water_event_hash: "a".repeat(64),
  last_occurred_at: BEFORE,
  last_received_at: BEFORE,
  expires_at_ns: time(LATER).toString(),
  state: "continuous",
  received_sequence: null,
  ...overrides,
});
const projection = async (
  overrides: VertexRecord = {}
): Promise<VertexRecord> => {
  const value = {
    schemaVersion: "1.0.0",
    projectionId: "projection-2",
    ...scope,
    streamId: "native-stream",
    ownerEpoch: "1",
    sequence: "2",
    previousEventHash: "a".repeat(64),
    occurredAt: NOW,
    receivedAt: NOW,
    actorId: principal.actorId,
    policyVersion: "1.0.0",
    strategyVersion: "strategy-sealed-1",
    reviewedArtifactSha256: "b".repeat(64),
    admissionId: null,
    expiresAt: LATER,
    idempotencyKey: "projection-key-2",
    sourceKind: "broker-observation",
    receipt: {
      schemaVersion: "1.0.0",
      intentId: "intent-1",
      submissionKey: "submission-1",
      brokerOrderRef: "native-order-1",
      environment: "paper",
      observationOnly: true,
      status: "filled",
      totalQuantity: "1",
      filledQuantity: "1",
      remainingQuantity: "0",
      lastReconciledAt: NOW,
      errorClass: null,
      auditEventIds: ["audit-1"],
    },
    authoritative: false,
    reservationAuthority: "native-owner-only",
    ...overrides,
  };
  return { ...value, eventHash: await hash(value) };
};

describe("Vertex explicit boundaries and rights", () => {
  it("requires all injected authorities without discovering defaults", () => {
    const h = harness();
    expect(() =>
      createVertexStore(h.db, {
        boundary: undefined,
        clock: { now: () => NOW },
        authorization: { authorize: h.authorize },
        maxProjectionAgeMs: 1000,
      } as never)
    ).toThrowError(/unavailable/);
    return expect(h.db.transaction).not.toHaveBeenCalled();
  });
  it.each([false, undefined, "true", 1])(
    "denies nonliteral grants before any SQL: %s",
    async (grant) => {
      const h = harness();
      h.authorize.mockResolvedValue(grant as boolean);
      await expect(
        h.store.findDataset(principal, scope, "dataset-1")
      ).rejects.toMatchObject({ code: "denied" });
      return expect(h.calls).toEqual([]);
    }
  );
  it("treats a throwing authorizer as denial", async () => {
    const h = harness();
    h.authorize.mockRejectedValue(new Error("sensitive authority detail"));
    await expect(
      h.store.getPortfolioSnapshot(principal, scope)
    ).rejects.toMatchObject({
      code: "denied",
      message: "Vertex persistence denied",
    });
    return expect(h.calls).toEqual([]);
  });
  it("rechecks authorization after acquiring its scope fence", async () => {
    const h = harness();
    h.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      h.store.getContinuity(principal, scope, "native-stream")
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.calls).toHaveLength(1);
    return expect(h.lifecycle).toEqual(["begin", "rollback"]);
  });
  it("rejects unvalidated wire objects before persistence", async () => {
    const h = harness();
    await expect(
      h.store.recordReview(principal, scope, { schemaVersion: "1.0.0" })
    ).rejects.toMatchObject({ code: "invalid" });
    expect(h.validate).toHaveBeenCalledWith(
      "AcceptedReview",
      { schemaVersion: "1.0.0" },
      "1.0.0"
    );
    return expect(h.calls).toEqual([]);
  });
  it("preserves nanosecond boundaries rather than Date rounding", () => {
    expect(time(NOW) - time("2026-09-22T12:00:00.000000000Z")).toBe(1n);
    return expect(time(NOW)).toBe(timestampToEpochNanoseconds(NOW));
  });
  it("returns latest denied rights without substituting an older grant", async () => {
    const denied: VertexRightsRecord = {
      ...rights,
      version: "2.0.0",
      status: "denied",
      checkedAt: NOW,
    };
    const h = harness([
      {
        match: /from "vertex_rights_versions"/,
        rows: [await policyRow(denied)],
      },
    ]);
    expect(
      await h.store.getRights(principal, scope, "collection-1", rights.policyId)
    ).toEqual(denied);
    expect(h.calls[1]!.sql).toContain("order by revision desc");
    return expect(h.calls[1]!.params).toEqual([
      scope.accountAlias,
      scope.environment,
      "collection-1",
      rights.policyId,
    ]);
  });
  it("revocation blocks a previously registered artifact", async () => {
    const a = await metadata({ schemaVersion: "1.0.0" });
    const denied: VertexRightsRecord = {
      ...rights,
      version: "2.0.0",
      status: "denied",
    };
    const h = harness([
      { match: /from "vertex_artifacts"/, rows: [await artifactRow(a)] },
      {
        match: /from "vertex_rights_versions"/,
        rows: [await policyRow(denied)],
      },
    ]);
    await expect(
      h.store.findArtifact(principal, scope, null, a.artifactId)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.lifecycle).toEqual(["begin", "rollback"]);
  });
  it("makes registration idempotent only for exact metadata", async () => {
    const a = await metadata({ schemaVersion: "1.0.0" });
    const steps = [
      { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
      { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
      { match: /from "vertex_artifacts"/, rows: [await artifactRow(a)] },
    ];
    const h = harness(steps);
    expect(await h.store.registerArtifact(principal, a)).toBe("duplicate");
    const changed = harness(steps);
    return await expect(
      changed.store.registerArtifact(principal, {
        ...a,
        byteLength: a.byteLength + 1,
      })
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("does not let source content hashes impersonate manifest hashes", async () => {
    const value = {
      schemaVersion: "1.0.0",
      datasetId: "dataset-1",
      contentHash: "c".repeat(64),
    };
    const a = await metadata(value);
    const h = harness([
      { match: /from "vertex_artifacts"/, rows: [await artifactRow(a)] },
      { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
    ]);
    h.accept("DatasetManifest", value);
    return await expect(
      h.store.recordImmutable({
        principal,
        scope,
        collectionId: null,
        contractName: "DatasetManifest",
        record: value,
        artifact: {
          artifactId: a.artifactId,
          artifactSha256: value.contentHash,
        },
        idempotencyKey: "record-1",
      })
    ).rejects.toMatchObject({ code: "integrity" });
  });
  return it("encloses disjunctive identity lookup inside account/environment scope", async () => {
    const h = harness([{ match: /from "vertex_outbox"/, rows: [] }]);
    const { sql } = await import("drizzle-orm");
    await one(
      h.tx as never,
      "vertex_outbox",
      scope,
      sql`event_id = ${"event-1"} or idempotency_key = ${"key-1"}`
    );
    expect(h.calls[0]!.sql).toMatch(
      /account_alias = \$1 and environment = \$2 and \(event_id = \$3 or idempotency_key = \$4\)/
    );
    return expect(h.calls[0]!.params).toEqual([
      scope.accountAlias,
      scope.environment,
      "event-1",
      "key-1",
    ]);
  });
});

describe("Vertex ordered native-owner projections", () => {
  it("verifies eventHash over exactly the eventHash-excluded graph", async () => {
    const value = { ...(await projection()), eventHash: "f".repeat(64) };
    const h = harness();
    h.accept("ExecutionProjection", value);
    await expect(
      h.store.appendExecutionProjection(principal, scope, value)
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(h.calls).toEqual([]);
  });
  it("rejects foreign account scope before SQL", async () => {
    const value = await projection({ accountAlias: "foreign" });
    const h = harness();
    h.accept("ExecutionProjection", value);
    await expect(
      h.store.appendExecutionProjection(principal, scope, value)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.calls).toEqual([]);
  });
  it.each(["gap", "epoch-mismatch"])(
    "retains %s facts but never advances highwater",
    async (kind) => {
      const value = await projection(
        kind === "gap" ? { sequence: "3" } : { ownerEpoch: "2" }
      );
      const h = harness([
        { match: /from "vertex_execution_projections"/, rows: [] },
        { match: /from "vertex_projection_heads"/, rows: [head()] },
        {
          match:
            /update vertex_projection_heads set state = .* returning high_water_sequence/,
          rows: [{ high_water_sequence: "1" }],
        },
      ]);
      h.accept("ExecutionProjection", value);
      expect(
        await h.store.appendExecutionProjection(principal, scope, value)
      ).toEqual({
        status: kind,
        highWaterSequence: "1",
        highWaterEventHash: "a".repeat(64),
      });
      expect(
        h.calls.some((query) =>
          /insert into "vertex_execution_projections"/.test(query.sql)
        )
      ).toBe(true);
      expect(
        h.calls.some((query) => /set high_water_sequence/.test(query.sql))
      ).toBe(false);
      expect(
        h.calls.some(
          (query) =>
            /set state =/.test(query.sql) && query.params.includes(kind)
        )
      ).toBe(true);
      const stateUpdate = h.calls.find((query) =>
        /update vertex_projection_heads set state =/.test(query.sql)
      )!;
      expect(stateUpdate.sql).toMatch(
        /and owner_epoch = .* and high_water_sequence = .* and high_water_event_hash is not distinct from .* returning high_water_sequence/
      );
      expect(stateUpdate.params.slice(-6)).toEqual([
        scope.accountAlias,
        scope.environment,
        "native-stream",
        "1",
        "1",
        "a".repeat(64),
      ]);
      return expect(h.pending).toEqual([]);
    }
  );
  it("exact hash replay is duplicate, while changed payload conflicts", async () => {
    const value = await projection();
    const previous = {
      event_hash: value["eventHash"],
      projection_id: value["projectionId"],
      applied: true,
      payload: value,
    };
    const h = harness([
      { match: /from "vertex_execution_projections"/, rows: [previous] },
      {
        match: /from "vertex_projection_heads"/,
        rows: [
          head({
            high_water_sequence: "2",
            high_water_event_hash: value["eventHash"],
          }),
        ],
      },
    ]);
    h.accept("ExecutionProjection", value);
    expect(
      await h.store.appendExecutionProjection(principal, scope, value)
    ).toMatchObject({ status: "duplicate", highWaterSequence: "2" });
    const changed = await projection({ policyVersion: "2.0.0" });
    const conflict = harness([
      { match: /from "vertex_execution_projections"/, rows: [previous] },
    ]);
    conflict.accept("ExecutionProjection", changed);
    return await expect(
      conflict.store.appendExecutionProjection(principal, scope, changed)
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("accepts expired contiguous historical facts but reports stale", async () => {
    const priorReceipt = (await projection())["receipt"] as VertexRecord;
    const value = await projection({
      occurredAt: "2026-09-22T11:59:59.100000001Z",
      receivedAt: "2026-09-22T11:59:59.200000001Z",
      expiresAt: "2026-09-22T11:59:59.900000001Z",
      receipt: {
        ...priorReceipt,
        lastReconciledAt: "2026-09-22T11:59:59.200000001Z",
      },
    });
    const h = harness([
      { match: /from "vertex_execution_projections"/, rows: [] },
      { match: /from "vertex_projection_heads"/, rows: [head()] },
      { match: /from "vertex_execution_projections"/, rows: [] },
      {
        match: /returning high_water_sequence/,
        rows: [{ high_water_sequence: "2" }],
      },
    ]);
    h.accept("ExecutionProjection", value);
    return expect(
      await h.store.appendExecutionProjection(principal, scope, value)
    ).toMatchObject({ status: "stale", highWaterSequence: "2" });
  });
  it("computes read freshness from the injected clock, not stored labels", async () => {
    const h = harness([
      { match: /from "vertex_projection_heads"/, rows: [head()] },
    ]);
    h.setClock("2026-09-22T12:05:00.000000001Z");
    const value = await h.store.getContinuity(
      principal,
      scope,
      "native-stream"
    );
    return expect(value).toMatchObject({
      state: "stale",
      authoritative: false,
      newRiskInhibited: true,
      freshness: {
        status: "stale",
        evaluatedAt: "2026-09-22T12:05:00.000000001Z",
      },
    });
  });
  return it("does not create reservation authority from receipt projections", async () => {
    const value = await projection({ sequence: "3" });
    const h = harness([
      { match: /from "vertex_execution_projections"/, rows: [] },
      { match: /from "vertex_projection_heads"/, rows: [head()] },
      {
        match:
          /update vertex_projection_heads set state = .* returning high_water_sequence/,
        rows: [{ high_water_sequence: "1" }],
      },
    ]);
    h.accept("ExecutionProjection", value);
    await h.store.appendExecutionProjection(principal, scope, value);
    expect(
      h.calls.some((query) => /reservation|allocation/.test(query.sql))
    ).toBe(false);
    return expect(h.pending).toEqual([]);
  });
});

describe("Vertex fenced account-scoped outbox", () => {
  it("rejects excessive batches and expired leases without a claim", async () => {
    const h = harness();
    await expect(
      h.store.claimOutbox(principal, scope, {
        leaseOwner: "worker-1",
        limit: 101,
        leaseExpiresAt: LATER,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      h.store.claimOutbox(principal, scope, {
        leaseOwner: "worker-1",
        limit: 1,
        leaseExpiresAt: BEFORE,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(
      h.calls.every((query) => query.sql.includes("pg_advisory_xact_lock"))
    ).toBe(true);
  });
  it("claims with SKIP LOCKED and exact collection authorization", async () => {
    const payload = { schemaVersion: "1.0.0", admissionId: "admission-1" };
    const row = {
      event_id: "simulation-1",
      collection_key: "collection-1",
      event_type: "vertex.paper-simulation.admitted",
      payload,
      record_hash: await hash(payload),
      lease_fence: "9007199254740992",
    };
    const h = harness([
      { match: /from vertex_outbox/, rows: [row] },
      { match: /returning event_id/, rows: [{ event_id: row.event_id }] },
    ]);
    expect(
      await h.store.claimOutbox(principal, scope, {
        leaseOwner: "worker-1",
        limit: 1,
        leaseExpiresAt: LATER,
      })
    ).toMatchObject([
      {
        eventId: row.event_id,
        scope,
        collectionId: "collection-1",
        leaseFence: "9007199254740993",
        payload,
      },
    ]);
    expect(h.calls[1]!.sql).toContain("for update skip locked");
    return expect(h.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionId: "collection-1",
        resourceId: row.event_id,
        action: "dispatch-outbox",
      })
    );
  });
  it("old fence and changed settlement payload never succeed", async () => {
    const input = {
      eventId: "event-1",
      leaseOwner: "worker-1",
      leaseFence: "1",
      result: "published" as const,
      availableAt: NOW,
    };
    const row = {
      collection_key: "",
      lease_owner: "worker-1",
      lease_fence: "2",
      settlement_hash: null,
      published_at: null,
      lease_expires_at_ns: time(LATER).toString(),
    };
    const h = harness([{ match: /from "vertex_outbox"/, rows: [row] }]);
    expect(await h.store.settleOutbox(principal, scope, input)).toBe(false);
    const exact = harness([
      {
        match: /from "vertex_outbox"/,
        rows: [
          { ...row, lease_fence: "1", settlement_hash: await hash(input) },
        ],
      },
    ]);
    expect(await exact.store.settleOutbox(principal, scope, input)).toBe(true);
    const changed = harness([
      {
        match: /from "vertex_outbox"/,
        rows: [
          { ...row, lease_fence: "1", settlement_hash: await hash(input) },
        ],
      },
    ]);
    return expect(
      await changed.store.settleOutbox(principal, scope, {
        ...input,
        availableAt: LATER,
      })
    ).toBe(false);
  });
  it("settles a current claim as a retry or publication with the exact owner receipt", async () => {
    const row = {
      collection_key: "",
      lease_owner: "worker-1",
      lease_fence: "1",
      settlement_hash: null,
      published_at: null,
      lease_expires_at_ns: time(LATER).toString(),
    };
    const settle = async (result: "published" | "retry") => {
      const h = harness([
        { match: /from "vertex_outbox"/, rows: [row] },
        { match: /returning event_id/, rows: [{ event_id: "event-1" }] },
      ]);
      const input = {
        eventId: "event-1",
        leaseOwner: "worker-1",
        leaseFence: "1",
        result,
        availableAt: LATER,
      };
      expect(await h.store.settleOutbox(principal, scope, input)).toBe(true);
      const update = h.calls.find((entry) =>
        entry.sql.startsWith("update vertex_outbox")
      )!;
      expect(update.params.slice(0, 3)).toEqual([
        result === "published" ? NOW : null,
        time(LATER).toString(),
        await hash(input),
      ]);
      return expect(h.lifecycle).toEqual(["begin", "commit"]);
    };
    await settle("retry");
    return settle("published");
  });
  it("refuses a retry before now and reports a lost settlement race as unsettled", async () => {
    const row = {
      collection_key: "",
      lease_owner: "worker-1",
      lease_fence: "1",
      settlement_hash: null,
      published_at: null,
      lease_expires_at_ns: time(LATER).toString(),
    };
    const input = {
      eventId: "event-1",
      leaseOwner: "worker-1",
      leaseFence: "1",
      result: "retry" as const,
      availableAt: NOW,
    };
    const early = harness([{ match: /from "vertex_outbox"/, rows: [row] }]);
    await expect(
      early.store.settleOutbox(principal, scope, {
        ...input,
        availableAt: BEFORE,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    expect(
      early.calls.some((entry) => entry.sql.startsWith("update vertex_outbox"))
    ).toBe(false);
    const raced = harness([
      { match: /from "vertex_outbox"/, rows: [row] },
      { match: /returning event_id/, rows: [] },
    ]);
    expect(await raced.store.settleOutbox(principal, scope, input)).toBe(false);
    const missing = harness([{ match: /from "vertex_outbox"/, rows: [] }]);
    expect(await missing.store.settleOutbox(principal, scope, input)).toBe(
      false
    );
    return expect(missing.lifecycle).toEqual(["begin", "commit"]);
  });
  return it("expired owner cannot settle an uncompleted delivery", async () => {
    const h = harness([
      {
        match: /from "vertex_outbox"/,
        rows: [
          {
            collection_key: "",
            lease_owner: "worker-1",
            lease_fence: "1",
            settlement_hash: null,
            published_at: null,
            lease_expires_at_ns: time(NOW).toString(),
          },
        ],
      },
    ]);
    return expect(
      await h.store.settleOutbox(principal, scope, {
        eventId: "event-1",
        leaseOwner: "worker-1",
        leaseFence: "1",
        result: "retry",
        availableAt: LATER,
      })
    ).toBe(false);
  });
});

const publicationFixture = async (sourceCount = 2) => {
  const imports: {
    record: VertexRecord;
    artifact: { artifactId: string; artifactSha256: string };
    metadata: VertexArtifactMetadata;
  }[] = [];
  for (let offset = 0; offset < sourceCount; offset += 512) {
    const count = Math.min(512, sourceCount - offset);
    const sources = Array.from({ length: count }, (_, index) => ({
      provider: "fixture",
      sourceId: `source-${offset + index}`,
      snapshotId: "source-capture-1",
      contentHash: (offset + index).toString(16).padStart(64, "0"),
    }));
    const record = {
      schemaVersion: "1.0.0",
      collectionId: "collection-1",
      snapshotId: "generation-1",
      sourceIdentities: sources,
      contentHashes: sources.map((source) => source.contentHash),
      duplicateMappings: [],
      unavailableSources: [],
      transcriptQuality: "not-applicable",
      retrievalScope: "collection-only",
      rightsPolicyId: rights.policyId,
      replacementScope: "collection-snapshot",
      contentClass: "article",
      untrustedContent: true,
    };
    const a = {
      ...(await metadata(record, "KnowledgeImport", "collection-1")),
      artifactId: `import-${offset}`,
      objectKey: `sealed/import-${offset}.json`,
    };
    imports.push({
      record,
      artifact: { artifactId: a.artifactId, artifactSha256: a.artifactSha256 },
      metadata: a,
    });
  }
  const input = {
    principal,
    scope,
    collectionId: "collection-1",
    expectedActiveSnapshotId: null,
    imports: imports.map(({ record, artifact }) => ({ record, artifact })),
    evidence: [],
    datasets: [],
    idempotencyKey: "publish-1",
  };
  const descriptor = {
    scope,
    collectionId: input.collectionId,
    expectedActiveSnapshotId: null,
    snapshotId: "generation-1",
    importArtifacts: imports.map((item) => item.artifact),
    evidenceArtifacts: [],
    datasetArtifacts: [],
  };
  const requestHash = await hash(descriptor);
  const events: VertexRecord[] = [];
  for (const [ordinal, shard] of imports.entries()) {
    const identity = {
      schemaVersion: "1.0.0",
      eventType: "knowledge.imported",
      occurredAt: NOW,
      effectiveAt: NOW,
      correlationId: `publication-${requestHash}`,
      causationId: null,
      actorId: principal.actorId,
      moduleId: "vertex-persistence",
      moduleVersion: "1.0.0",
      environment: scope.environment,
      idempotencyKey: `publication-${requestHash}-${ordinal}`,
      payload: shard.record,
    };
    events.push({
      ...identity,
      eventId: `event-${await hash(identity)}`,
      receivedAt: NOW,
    });
  }
  const sealedSteps: Step[] = [];
  for (const [index, item] of imports.entries()) {
    sealedSteps.push(
      {
        match: /from "vertex_artifacts"/,
        rows: [await artifactRow(item.metadata)],
      },
      // The shared rights head is read once per transaction, then reused.
      ...(index === 0
        ? [
            {
              match: /from "vertex_rights_versions"/,
              rows: [await policyRow()],
            },
          ]
        : [])
    );
  }
  return { input, imports, descriptor, requestHash, events, sealedSteps };
};

describe("Vertex all-shard collection publication", () => {
  it("atomically publishes 1700 sources without weakening the 512-source shard contract", async () => {
    const f = await publicationFixture(1700);
    const h = harness([
      ...f.sealedSteps,
      { match: /from "vertex_collection_generations"/, rows: [] },
      { match: /from "vertex_collections"/, rows: [] },
      {
        match: /returning active_snapshot_id/,
        rows: [{ active_snapshot_id: "generation-1" }],
      },
      ...f.events.map(() => ({ match: /from "vertex_outbox"/, rows: [] })),
    ]);
    for (const item of f.imports) h.accept("KnowledgeImport", item.record);
    for (const event of f.events) h.accept("EventEnvelope", event);
    expect(await h.store.publishCollectionSnapshot(f.input)).toEqual({
      status: "published",
      snapshotId: "generation-1",
      previousSnapshotId: null,
    });
    expect(f.imports).toHaveLength(4);
    expect(
      h.calls.filter((query) =>
        /insert into "vertex_source_identities"/.test(query.sql)
      )
    ).toHaveLength(1700);
    expect(
      h.calls.filter((query) =>
        /insert into "vertex_collection_shards"/.test(query.sql)
      )
    ).toHaveLength(4);
    expect(
      h.calls.filter((query) => /update vertex_collections/.test(query.sql))
    ).toHaveLength(1);
    expect(
      h.calls.filter((query) => /insert into "vertex_outbox"/.test(query.sql))
    ).toHaveLength(4);
    expect(h.lifecycle).toEqual(["begin", "commit"]);
    return expect(h.pending).toEqual([]);
  });
  it("keeps historical generation and exact-idempotency receipts separate from the active pointer", async () => {
    const f = await publicationFixture();
    const prior = {
      request_hash: f.requestHash,
      idempotency_key: f.input.idempotencyKey,
      snapshot_id: "generation-1",
      previous_snapshot_id: null,
    };
    const h = harness([
      ...f.sealedSteps,
      { match: /from "vertex_collection_generations"/, rows: [prior] },
    ]);
    for (const item of f.imports) h.accept("KnowledgeImport", item.record);
    expect(await h.store.publishCollectionSnapshot(f.input)).toMatchObject({
      status: "duplicate",
    });
    expect(
      h.calls.some((query) => /update vertex_collections/.test(query.sql))
    ).toBe(false);
    const changed = harness([
      ...f.sealedSteps,
      {
        match: /from "vertex_collection_generations"/,
        rows: [{ ...prior, request_hash: "0".repeat(64) }],
      },
    ]);
    for (const item of f.imports)
      changed.accept("KnowledgeImport", item.record);
    return await expect(
      changed.store.publishCollectionSnapshot(f.input)
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("rolls back on compare-and-swap failure after staging", async () => {
    const f = await publicationFixture();
    const h = harness([
      ...f.sealedSteps,
      { match: /from "vertex_collection_generations"/, rows: [] },
      { match: /from "vertex_collections"/, rows: [] },
      { match: /returning active_snapshot_id/, rows: [] },
    ]);
    for (const item of f.imports) h.accept("KnowledgeImport", item.record);
    await expect(
      h.store.publishCollectionSnapshot(f.input)
    ).rejects.toMatchObject({ code: "conflict" });
    expect(h.lifecycle).toEqual(["begin", "rollback"]);
    expect(
      h.calls.some((query) =>
        /insert into "vertex_collection_generations"/.test(query.sql)
      )
    ).toBe(true);
    return expect(
      h.calls.some((query) => /insert into "vertex_outbox"/.test(query.sql))
    ).toBe(false);
  });
  it("rolls back activation when any shard event cannot be persisted", async () => {
    const f = await publicationFixture();
    const h = harness([
      ...f.sealedSteps,
      { match: /from "vertex_collection_generations"/, rows: [] },
      { match: /from "vertex_collections"/, rows: [] },
      {
        match: /returning active_snapshot_id/,
        rows: [{ active_snapshot_id: "generation-1" }],
      },
    ]);
    for (const item of f.imports) h.accept("KnowledgeImport", item.record);
    // Deliberately do not register the generated EventEnvelope in the fixture
    // boundary. Validation failure must abort the same transaction as CAS.
    await expect(
      h.store.publishCollectionSnapshot(f.input)
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(h.lifecycle).toEqual(["begin", "rollback"]);
  });
  it("rejects duplicate global source identities and mismatched shard policy", async () => {
    const f = await publicationFixture();
    const h = harness();
    for (const item of f.imports) h.accept("KnowledgeImport", item.record);
    const duplicate = {
      record: f.imports[0]!.record,
      artifact: { ...f.imports[0]!.artifact, artifactId: "second-import" },
    };
    await expect(
      h.store.publishCollectionSnapshot({
        ...f.input,
        imports: [...f.input.imports, duplicate],
      })
    ).rejects.toMatchObject({ code: "integrity" });
    const mismatch = {
      ...f.imports[0]!.record,
      rightsPolicyId: "foreign-policy",
    };
    h.accept("KnowledgeImport", mismatch);
    await expect(
      h.store.publishCollectionSnapshot({
        ...f.input,
        imports: [...f.input.imports, { ...duplicate, record: mismatch }],
      })
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(h.calls).toEqual([]);
  });
  it("rejects unavailable sources that repeat or are also published as available", async () => {
    const f = await publicationFixture();
    const h = harness();
    const import0 = f.input.imports[0]!;
    const unavailable = (sourceId: string) => ({
      sourceId,
      reason: "provider-unavailable",
    });
    for (const unavailableSources of [
      [unavailable("source-0")],
      [unavailable("source-missing"), unavailable("source-missing")],
    ]) {
      const record = { ...import0.record, unavailableSources };
      h.accept("KnowledgeImport", record);
      await expect(
        h.store.publishCollectionSnapshot({
          ...f.input,
          imports: [{ ...import0, record }],
        })
      ).rejects.toMatchObject({ code: "integrity" });
    }
    return expect(h.calls).toEqual([]);
  });
  return it("does not synthesize missing source manifests", async () => {
    const f = await publicationFixture();
    const h = harness([{ match: /from "vertex_artifacts"/, rows: [] }]);
    for (const item of f.imports) h.accept("KnowledgeImport", item.record);
    await expect(
      h.store.publishCollectionSnapshot(f.input)
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(h.calls.some((query) => /insert into/.test(query.sql))).toBe(
      false
    );
  });
});

const reviewFixture = async () => {
  const draft: VertexRecord = {
    schemaVersion: "1.0.0",
    intentId: "intent-1",
    ...scope,
    strategyVersion: "strategy-sealed-1",
    proposalOnly: true,
    executionAuthorized: false,
    expiresAt: LATER,
    maxLossBudget: "100",
  };
  const artifact = await metadata(draft, "TradeIntent", "collection-1");
  const review: VertexRecord = {
    schemaVersion: "1.0.0",
    reviewId: "review-1",
    ...scope,
    collectionId: "collection-1",
    artifactId: artifact.artifactId,
    artifactSha256: artifact.artifactSha256,
    reviewVersion: "1.0.0",
    decision: "accepted",
    purpose: "paper-simulation",
    actorId: principal.actorId,
    reviewedAt: BEFORE,
    expiresAt: LATER,
    policyVersion: "1.0.0",
    strategyVersion: "strategy-sealed-1",
    supersedesReviewId: null,
    executionAuthorized: false,
  };
  const admission: VertexRecord = {
    schemaVersion: "1.0.0",
    admissionId: "admission-1",
    admissionKind: "PAPER-SIMULATION",
    ...scope,
    simulatorId: "simulator-1",
    streamId: "native-stream",
    ownerEpoch: "1",
    intentId: "intent-1",
    intentSha256: artifact.artifactSha256,
    reviewedArtifactSha256: artifact.artifactSha256,
    reviewId: "review-1",
    reviewVersion: "1.0.0",
    actorId: principal.actorId,
    policyVersion: "1.0.0",
    strategyVersion: "strategy-sealed-1",
    portfolioSnapshotId: "portfolio-1",
    portfolioSequence: "1",
    maximumLoss: "10",
    maximumNotional: "100",
    admittedAt: NOW,
    expiresAt: LATER,
    idempotencyKey: "admit-1",
    simulationOnly: true,
    brokerSubmissionAllowed: false,
    liveAuthorization: false,
    executionAuthorized: false,
  };
  const row = {
    artifact_id: artifact.artifactId,
    collection_key: "collection-1",
    review_id: "review-1",
    payload: review,
    record_hash: await hash(review),
  };
  const steps: Step[] = [
    { match: /from "vertex_reviews"/, rows: [row] },
    { match: /from "vertex_artifacts"/, rows: [await artifactRow(artifact)] },
    { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
    { match: /from "vertex_records"/, rows: [{ payload: draft }] },
  ];
  return { draft, artifact, review, admission, row, steps };
};

describe("Vertex immutable review and simulation-only admission", () => {
  it("requires the exact reviewer actor and never stores a substituted actor", async () => {
    const f = await reviewFixture();
    const h = harness();
    h.accept("AcceptedReview", f.review);
    await expect(
      h.store.recordReview({ actorId: "other-reviewer" }, scope, f.review)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.calls.some((query) => /insert into/.test(query.sql))).toBe(
      false
    );
  });
  it("blocks non-paper scope without changing a draft", async () => {
    const f = await reviewFixture();
    const h = harness();
    h.accept("PaperSimulationAdmission", f.admission);
    await expect(
      h.store.admitPaperSimulation(
        principal,
        { ...scope, environment: "live" },
        f.admission
      )
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.calls).toEqual([]);
  });
  it("requires the latest accepted review, not a superseded acceptance", async () => {
    const f = await reviewFixture();
    const h = harness([
      ...f.steps,
      {
        match: /from "vertex_reviews"/,
        rows: [{ ...f.row, review_id: "review-2" }],
      },
    ]);
    h.accept("PaperSimulationAdmission", f.admission);
    await expect(
      h.store.admitPaperSimulation(principal, scope, f.admission)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(
      h.calls.some((query) => /insert into "vertex_paper_jobs"/.test(query.sql))
    ).toBe(false);
  });
  it.each(["policyVersion", "strategyVersion", "reviewVersion"])(
    "rejects changed %s bindings",
    async (key) => {
      const f = await reviewFixture();
      const changed = {
        ...f.admission,
        [key]: key === "strategyVersion" ? "other-strategy" : "2.0.0",
      };
      const h = harness([
        ...f.steps,
        { match: /from "vertex_reviews"/, rows: [f.row] },
      ]);
      h.accept("PaperSimulationAdmission", changed);
      await expect(
        h.store.admitPaperSimulation(principal, scope, changed)
      ).rejects.toMatchObject({ code: "integrity" });
      return expect(
        h.calls.some((query) => /insert into/.test(query.sql))
      ).toBe(false);
    }
  );
  it("refuses even a one-nanosecond expired accepted review", async () => {
    const f = await reviewFixture();
    const expired = {
      ...f.review,
      expiresAt: "2026-09-22T12:00:00.000000000Z",
    };
    const h = harness();
    h.accept("AcceptedReview", expired);
    return await expect(
      h.store.recordReview(principal, scope, expired)
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("rejects accessors before cloning or calling an authority", async () => {
    const h = harness();
    let invoked = false;
    const hostile = Object.defineProperty({}, "actorId", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "reviewer-1";
      },
    });
    await expect(
      h.store.getPortfolioSnapshot(hostile as typeof principal, scope)
    ).rejects.toMatchObject({ code: "invalid" });
    expect(invoked).toBe(false);
    return expect(h.authorize).not.toHaveBeenCalled();
  });
  return it("stores legitimate expired rights checks without extending access", async () => {
    const expired: VertexRightsRecord = {
      ...rights,
      version: "2.0.0",
      status: "expired",
      checkedAt: NOW,
      expiresAt: BEFORE,
    };
    const h = harness([
      { match: /from "vertex_rights_versions"/, rows: [] },
      { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
    ]);
    await h.store.putRights(principal, scope, null, expired);
    return expect(
      h.calls.some(
        (query) =>
          /insert into "vertex_rights_versions"/.test(query.sql) &&
          query.params.includes("expired")
      )
    ).toBe(true);
  });
});

describe("Vertex versioned run snapshots", () => {
  return it("appends AgentRun status revisions by sealed digest, never UPDATE", async () => {
    const base = {
      schemaVersion: "1.0.0",
      runId: "agent-run-1",
      agentRole: "research",
      taskContract: "task-1",
      allowedTools: [],
      modelVersion: null,
      inputEvidenceIds: [],
      outputArtifactIds: [],
      tokenBudget: 100,
      costBudgetUsd: "1",
      status: "queued",
      errors: [],
      approvalRequests: [],
      executionAuthorized: false,
    };
    const next = { ...base, status: "running" };
    for (const [index, value] of [base, next].entries()) {
      const a = {
        ...(await metadata(value, "AgentRun")),
        artifactId: `run-revision-${index}`,
        objectKey: `sealed/run-revision-${index}.json`,
      };
      const h = harness([
        { match: /from "vertex_artifacts"/, rows: [await artifactRow(a)] },
        { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
        { match: /from "vertex_record_idempotency"/, rows: [] },
        { match: /from "vertex_records"/, rows: [] },
      ]);
      h.accept("AgentRun", value);
      expect(
        await h.store.recordImmutable({
          principal,
          scope,
          collectionId: null,
          contractName: "AgentRun",
          record: value,
          artifact: {
            artifactId: a.artifactId,
            artifactSha256: a.artifactSha256,
          },
          idempotencyKey: `run-key-${index}`,
        })
      ).toMatchObject({ status: "recorded", recordId: base.runId });
      const insert = h.calls.find((query) =>
        /insert into "vertex_records"/.test(query.sql)
      )!;
      expect(
        insert.params.filter((parameter) => parameter === a.artifactSha256)
          .length
      ).toBeGreaterThanOrEqual(3);
      expect(
        h.calls.some((query) =>
          /insert into "vertex_agent_versions"/.test(query.sql)
        )
      ).toBe(true);
      expect(h.calls.some((query) => /^update/i.test(query.sql))).toBe(false);
    }
  });
});

describe("Vertex late paper observations", () => {
  it("retains a later bound receipt after admission expiry without reopening admission", async () => {
    const f = await reviewFixture();
    const admitted = {
      ...f.admission,
      admittedAt: "2026-09-22T11:59:58.000000001Z",
      expiresAt: "2026-09-22T11:59:59.500000001Z",
    };
    const emitter = { actorId: "native-owner-1" };
    const value = await projection({
      actorId: emitter.actorId,
      sourceKind: "paper-simulation",
      admissionId: f.admission["admissionId"],
      reviewedArtifactSha256: f.admission["reviewedArtifactSha256"],
    });
    const h = harness([
      {
        match: /from "vertex_paper_jobs"/,
        rows: [{ payload: admitted, record_hash: await hash(admitted) }],
      },
      { match: /from "vertex_execution_projections"/, rows: [] },
      { match: /from "vertex_projection_heads"/, rows: [head()] },
      { match: /from "vertex_execution_projections"/, rows: [] },
      {
        match: /returning high_water_sequence/,
        rows: [{ high_water_sequence: "2" }],
      },
    ]);
    h.accept("ExecutionProjection", value);
    expect(
      await h.store.appendExecutionProjection(emitter, scope, value)
    ).toMatchObject({ status: "applied", highWaterSequence: "2" });
    expect(
      h.calls.some((query) =>
        /insert into "vertex_receipt_orders"/.test(query.sql)
      )
    ).toBe(true);
    expect(
      h.calls.some((query) =>
        /(?:insert into|update) "?vertex_paper_jobs/.test(query.sql)
      )
    ).toBe(false);
    return expect(
      h.calls.some((query) => /reservation|allocation/.test(query.sql))
    ).toBe(false);
  });
  return it("rejects an emitter identity that differs from the authorized principal", async () => {
    const value = await projection({ actorId: "foreign-emitter" });
    const h = harness();
    h.accept("ExecutionProjection", value);
    await expect(
      h.store.appendExecutionProjection(principal, scope, value)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.calls).toEqual([]);
  });
});

describe("Vertex sealed strategy integrity", () => {
  return it("rejects tampered strategy limits before paper admission", async () => {
    const f = await reviewFixture();
    const strategy = {
      schemaVersion: "1.0.0",
      strategyId: "strategy-1",
      version: "1.0.0",
      riskLimits: {
        maximumLoss: "100",
        maximumNotional: "1000",
        maximumPositions: 1,
      },
    };
    const a = {
      ...(await metadata(strategy, "StrategySpec")),
      artifactId: "strategy-sealed-1",
      objectKey: "sealed/strategy-1.json",
    };
    const tampered = {
      ...strategy,
      riskLimits: { ...strategy.riskLimits, maximumNotional: "2000" },
    };
    const h = harness([
      ...f.steps,
      { match: /from "vertex_reviews"/, rows: [f.row] },
      {
        match: /from "vertex_records"/,
        rows: [
          {
            collection_key: "",
            payload: tampered,
            record_hash: a.artifactSha256,
          },
        ],
      },
      { match: /from "vertex_artifacts"/, rows: [await artifactRow(a)] },
      { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
    ]);
    h.accept("PaperSimulationAdmission", f.admission);
    await expect(
      h.store.admitPaperSimulation(principal, scope, f.admission)
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(h.calls.some((query) => /insert into/.test(query.sql))).toBe(
      false
    );
  });
});

describe("Vertex dataset collection-scoped lookup", () => {
  it("uses the explicit collection for dataset authorization, SQL and artifact rights", async () => {
    const collection = "collection-1";
    const a = await metadata(
      { schemaVersion: "1.0.0", datasetId: "dataset-1" },
      "DatasetManifest",
      collection
    );
    const h = harness([
      {
        match: /from "vertex_datasets"/,
        rows: [{ collection_key: collection, artifact_id: a.artifactId }],
      },
      { match: /from "vertex_artifacts"/, rows: [await artifactRow(a)] },
      { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
    ]);
    expect(
      await h.store.findDataset(principal, scope, "dataset-1", collection)
    ).toEqual(a);
    const lookup = h.calls.find((entry) =>
      entry.sql.includes('from "vertex_datasets"')
    )!;
    expect(lookup.sql).toContain("collection_key =");
    expect(lookup.params).toEqual([
      scope.accountAlias,
      scope.environment,
      "dataset-1",
      collection,
    ]);
    expect(h.authorize).not.toHaveBeenCalledWith(
      expect.objectContaining({ collectionId: null })
    );
    expect(h.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionId: collection,
        resourceId: "dataset-1",
        action: "read",
      })
    );
    return expect(h.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionId: collection,
        resourceId: a.artifactId,
        action: "read",
      })
    );
  });
  it("retains a null-only lookup for the legacy three-argument call", async () => {
    const h = harness([{ match: /from "vertex_datasets"/, rows: [] }]);
    expect(await h.store.findDataset(principal, scope, "dataset-1")).toBeNull();
    const lookup = h.calls.find((entry) =>
      entry.sql.includes('from "vertex_datasets"')
    )!;
    expect(lookup.sql).toContain("collection_key =");
    expect(lookup.params).toEqual([
      scope.accountAlias,
      scope.environment,
      "dataset-1",
      "",
    ]);
    return expect(h.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionId: null,
        resourceId: "dataset-1",
        action: "read",
      })
    );
  });
  it("does not widen an explicit wrong collection to account-wide dataset lookup", async () => {
    const h = harness([{ match: /from "vertex_datasets"/, rows: [] }]);
    expect(
      await h.store.findDataset(
        principal,
        scope,
        "dataset-1",
        "other-collection"
      )
    ).toBeNull();
    expect(
      h.calls.filter((entry) => entry.sql.includes('from "vertex_datasets"'))
    ).toHaveLength(1);
    expect(
      h.calls.find((entry) => entry.sql.includes('from "vertex_datasets"'))!
        .params
    ).toEqual([
      scope.accountAlias,
      scope.environment,
      "dataset-1",
      "other-collection",
    ]);
    return expect(
      h.calls.some((entry) => entry.sql.includes('from "vertex_artifacts"'))
    ).toBe(false);
  });
  return it("denies an explicit collection grant failure before SQL", async () => {
    const h = harness();
    h.authorize.mockResolvedValue(false);
    await expect(
      h.store.findDataset(principal, scope, "dataset-1", "collection-1")
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.calls).toEqual([]);
  });
});

describe("Vertex native proof byte snapshot", () => {
  const projectionInput = { projectionId: "projection-1" };
  it("rejects anything but one plain bounded Uint8Array before any SQL", async () => {
    const h = harness();
    const append = h.store.appendNativeFactProjection as (
      ...args: unknown[]
    ) => Promise<unknown>;
    class Subclass extends Uint8Array {}
    const shadowed = new Uint8Array([1]);
    Object.defineProperty(shadowed, "length", { value: 2 });
    const throwing = new Proxy(new Uint8Array([1]), {
      getPrototypeOf: () => {
        throw new Error("Synthetic hostile prototype");
      },
    });
    const cases: unknown[][] = [
      [principal, scope, projectionInput],
      [principal, scope, projectionInput, [1, 2, 3]],
      [principal, scope, projectionInput, new Subclass([1])],
      [principal, scope, projectionInput, shadowed],
      [principal, scope, projectionInput, throwing],
      [principal, scope, projectionInput, new Uint8Array(0)],
      [principal, scope, projectionInput, new Uint8Array(1_048_577)],
      [
        principal,
        scope,
        projectionInput,
        new Uint8Array(new SharedArrayBuffer(1)),
      ],
    ];
    for (const args of cases)
      await expect(append(...args)).rejects.toMatchObject({ code: "invalid" });
    expect(h.validate).not.toHaveBeenCalled();
    return expect(h.calls).toEqual([]);
  });
  return it("forwards valid proof bytes to the native fact owner", async () => {
    const h = harness();
    const proof = encoder.encode('{"proof":true}');
    const pending = h.store.appendNativeFactProjection(
      principal,
      scope,
      projectionInput,
      proof
    );
    await expect(pending).rejects.toBeDefined();
    expect(h.validate).toHaveBeenCalledWith(
      "NativeFactProjection",
      projectionInput,
      "1.0.0"
    );
    return expect(h.calls).toEqual([]);
  });
});
