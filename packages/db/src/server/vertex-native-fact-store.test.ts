import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  ExecutionProjectionSchema,
  NativeFactProjectionSchema,
  NativeJournalProofSchema,
  PortfolioSnapshotSchema,
} from "../../../api/src/vertex.ts";
import type { Database } from "./client.ts";
import { createNativeFactOperations } from "./vertex-native-fact-store.ts";
import {
  createPersistenceContext,
  type Row,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexBoundary,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";
import { createProjectionOperations } from "./vertex-projection-store.ts";

// Authored source only. No tests, database, provider or runtime were executed.
const NOW = "2026-09-22T12:00:00.000000001Z";
const BEFORE = "2026-09-22T11:59:59.000000001Z";
const LATER = "2026-09-22T12:10:00.000000001Z";
const scope: VertexScope = {
  accountAlias: "synthetic-native-account",
  environment: "paper",
};
const principal = { actorId: "synthetic-native-owner" };
const encoder = new TextEncoder();
const encode = (value: unknown): Uint8Array =>
  encoder.encode(canonicalArtifactJson(value));
const hash = (value: unknown): Promise<string> => hashArtifact(encode(value));
const genesisHash = "a".repeat(64);
const checkpoint = {
  kind: "checkpoint",
  snapshotId: "checkpoint-1",
  snapshotSha256: "b".repeat(64),
  journalSequence: "7",
  journalHeadHash: "c".repeat(64),
};
const option = {
  kind: "assignment",
  settlementId: "obligation-1",
  instrumentId: "option-1",
  underlyingId: "equity-1",
  settlementKind: "physical",
  settlementState: "pending",
  quantity: "1",
  currency: "USD",
  cashDelta: "-100",
  shareDelta: "1",
  dueAt: LATER,
  fillEventIds: ["fill-1"],
};
const fixture = async (
  fact: VertexRecord = checkpoint,
  overrides: VertexRecord = {},
  proofOverrides: VertexRecord = {}
) => {
  const common = {
    schemaVersion: "1.0.0",
    projectionId: "native-2",
    ...scope,
    streamId: "native-stream",
    ownerEpoch: "1",
    sequence: "2",
    proofJournalSequence: "7",
    proofJournalHeadHash: "c".repeat(64),
    factOrdinal: 0,
    previousEventHash: genesisHash,
    occurredAt: NOW,
    receivedAt: NOW,
    actorId: principal.actorId,
    policyVersion: "1.0.0",
    expiresAt: LATER,
    idempotencyKey: "native-key-2",
    sourceKind: "paper-simulation",
    fact,
    authoritative: false,
    reservationAuthority: "native-owner-only",
    executionAuthorized: false,
    ...overrides,
  };
  const sourceEventId = `source-${common.projectionId}`;
  const proof = {
    schemaVersion: "1.0.0",
    proofKind: "native-journal-event",
    accountAlias: common.accountAlias,
    environment: common.environment,
    streamId: common.streamId,
    ownerEpoch: common.ownerEpoch,
    sourceEventId,
    journalSequence: common.proofJournalSequence,
    journalHeadHash: common.proofJournalHeadHash,
    factOrdinal: common.factOrdinal,
    occurredAt: common.occurredAt,
    eventType: fact["kind"],
    payload: fact,
    ...proofOverrides,
  };
  const bytes = encode(proof);
  const body = {
    ...common,
    proof: {
      artifactId: `proof-${common.projectionId}`,
      sha256: await hashArtifact(bytes),
      sourceEventId,
    },
  };
  return { value: { ...body, eventHash: await hash(body) }, proof, bytes };
};
const rehash = async (value: VertexRecord): Promise<VertexRecord> => {
  const { eventHash: _hash, ...body } = value;
  return { ...body, eventHash: await hash(body) };
};
const orderFixture = async (
  overrides: VertexRecord = {}
): Promise<VertexRecord> => {
  const body = {
    schemaVersion: "1.0.0",
    projectionId: "order-2",
    ...scope,
    streamId: "native-stream",
    ownerEpoch: "1",
    sequence: "2",
    previousEventHash: genesisHash,
    occurredAt: NOW,
    receivedAt: NOW,
    actorId: principal.actorId,
    policyVersion: "1.0.0",
    strategyVersion: "strategy-1",
    reviewedArtifactSha256: "d".repeat(64),
    admissionId: null,
    expiresAt: LATER,
    idempotencyKey: "order-key-2",
    sourceKind: "broker-observation",
    receipt: {
      schemaVersion: "1.0.0",
      intentId: "intent-1",
      submissionKey: "submission-1",
      brokerOrderRef: "order-ref-1",
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
  return { ...body, eventHash: await hash(body) };
};

type Query = Readonly<{ sql: string; params: unknown[] }>;
const harness = (seedHead = true) => {
  const tables = new Map<string, Row[]>();
  const data = (name: string): Row[] => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  if (seedHead)
    data("vertex_projection_heads").push({
      ...scope,
      stream_id: "native-stream",
      owner_epoch: "1",
      high_water_sequence: "1",
      high_water_event_hash: genesisHash,
      last_occurred_at: BEFORE,
      last_received_at: BEFORE,
      expires_at_ns: time(LATER).toString(),
      state: "continuous",
      received_sequence: null,
    });
  const queries: Query[] = [];
  const lifecycle: string[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    const s = query.sql;
    const p = query.params;
    queries.push(query);
    if (s.includes("pg_advisory_xact_lock")) return { rows: [] };
    const inserted =
      /^insert into "([a-z_][a-z0-9_]*)" \(([^)]+)\) values/.exec(s);
    if (inserted) {
      // Column names may contain digits (e.g. "sha256"); a letters-only
      // pattern silently drops them and shifts every later parameter.
      const keys = [...inserted[2]!.matchAll(/"([a-z_][a-z0-9_]*)"/g)].map(
        (match) => match[1]!
      );
      data(inserted[1]!).push(
        Object.fromEntries(
          keys.map((key, i) => [
            key,
            key === "payload" ? JSON.parse(String(p[i])) : p[i],
          ])
        )
      );
      return { rows: [] };
    }
    if (
      s.startsWith("insert into vertex_accounts") ||
      s.startsWith("insert into vertex_account_aliases")
    )
      return { rows: [] };
    const selected = /^select \* from "([a-z_]+)"/.exec(s);
    if (selected) {
      const name = selected[1]!;
      const found = data(name);
      if (name === "vertex_projection_heads")
        return { rows: found.filter((row) => row["stream_id"] === p[2]) };
      if (name === "vertex_native_journal_proofs")
        return { rows: found.filter((row) => row["artifact_id"] === p[2]) };
      if (
        name === "vertex_execution_projections" ||
        name === "vertex_native_fact_projections"
      ) {
        if (s.includes("projection_id ="))
          return {
            rows: found
              .filter(
                (row) =>
                  row["projection_id"] === p[2] ||
                  (row["stream_id"] === p[3] &&
                    ((row["owner_epoch"] === p[4] &&
                      row["sequence"] === p[5]) ||
                      row["idempotency_key"] === p[6])) ||
                  (s.includes("proof_journal_sequence =") &&
                    row["owner_epoch"] === p[7] &&
                    row["proof_journal_sequence"] === p[8] &&
                    row["proof_journal_head_hash"] === p[9] &&
                    row["fact_ordinal"] === p[10])
              )
              .slice(0, 1),
          };
        if (s.includes("applied = false")) {
          const pending = found.filter(
            (row) => row["stream_id"] === p[2] && row["applied"] === false
          );
          pending.sort(
            (a, b) =>
              Number(b["owner_epoch"] !== p[3]) -
                Number(a["owner_epoch"] !== p[3]) ||
              Number(
                BigInt(String(a["sequence"])) - BigInt(String(b["sequence"]))
              )
          );
          return { rows: pending.slice(0, 1) };
        }
        if (s.includes("applied = true"))
          return {
            rows: found.filter(
              (row) =>
                row["stream_id"] === p[2] &&
                row["owner_epoch"] === p[3] &&
                row["sequence"] === p[4] &&
                row["event_hash"] === p[5] &&
                row["applied"] === true
            ),
          };
        return {
          rows: found.filter((row) => row["stream_id"] === p[2]).slice(0, 1),
        };
      }
      if (name === "vertex_portfolio_snapshots") return { rows: [] };
      throw new Error("Unexpected fixture table");
    }
    if (
      s.startsWith("update vertex_projection_heads set high_water_sequence")
    ) {
      const head = data("vertex_projection_heads").find(
        (row) =>
          row["stream_id"] === p[9] &&
          row["owner_epoch"] === p[10] &&
          row["high_water_sequence"] === p[11] &&
          row["high_water_event_hash"] === p[12]
      );
      if (!head) return { rows: [] };
      Object.assign(head, {
        high_water_sequence: p[0],
        high_water_event_hash: p[1],
        last_occurred_at: p[2],
        last_received_at: p[3],
        expires_at_ns: p[4],
        state: p[5],
        received_sequence: p[6],
      });
      return { rows: [{ high_water_sequence: p[0] }] };
    }
    if (s.startsWith("update vertex_projection_heads set state")) {
      // Compare-and-swap like Postgres: the store requires exactly one
      // `returning` row and fails closed ("conflict") otherwise.
      const head = data("vertex_projection_heads").find(
        (row) =>
          row["stream_id"] === p[4] &&
          row["owner_epoch"] === p[5] &&
          row["high_water_sequence"] === p[6] &&
          row["high_water_event_hash"] === p[7]
      );
      if (!head) return { rows: [] };
      Object.assign(head, { state: p[0], received_sequence: p[1] });
      return { rows: [{ high_water_sequence: head["high_water_sequence"] }] };
    }
    const updated =
      /^update "(vertex_(?:execution|native_fact)_projections)" set applied/.exec(
        s
      );
    if (updated) {
      const row = data(updated[1]!).find(
        (item) => item["projection_id"] === p[3] && item["event_hash"] === p[4]
      )!;
      Object.assign(row, { applied: true, disposition: p[0] });
      return { rows: [] };
    }
    throw new Error("Unexpected fixture SQL");
  });
  const db = {
    transaction: vi.fn(
      async (
        operation: (tx: { execute: typeof execute }) => Promise<unknown>
      ) => {
        const snapshot = structuredClone([...tables.entries()]);
        lifecycle.push("begin");
        try {
          const result = await operation({ execute });
          lifecycle.push("commit");
          return result;
        } catch (error) {
          tables.clear();
          for (const [key, value] of snapshot) tables.set(key, value);
          lifecycle.push("rollback");
          throw error;
        }
      }
    ),
  } as unknown as Database;
  const validate = vi.fn<VertexBoundary["validate"]>((name, input, version) => {
    if (version !== "1.0.0") throw new Error("Wrong fixture version");
    if (name === "NativeFactProjection")
      return NativeFactProjectionSchema.parse(input);
    if (name === "NativeJournalProof")
      return NativeJournalProofSchema.parse(input);
    if (name === "ExecutionProjection")
      return ExecutionProjectionSchema.parse(input);
    if (name === "PortfolioSnapshot")
      return PortfolioSnapshotSchema.parse(input);
    throw new Error("Unexpected fixture contract");
  });
  const authorize = vi.fn(async () => true);
  const ctx = createPersistenceContext(db, {
    boundary: { validate, encode, digest: hashArtifact },
    authorization: { authorize },
    clock: { now: () => NOW },
    maxProjectionAgeMs: 60_000,
  });
  const native = createNativeFactOperations(ctx);
  const orders = createProjectionOperations(ctx);
  return { native, orders, queries, lifecycle, data, authorize, validate, db };
};

const facts: ReadonlyArray<readonly [VertexRecord, string]> = [
  [checkpoint, "vertex_native_checkpoints"],
  [
    {
      kind: "cash-settlement",
      settlementId: "cash-1",
      currency: "USD",
      cashDelta: "12.5",
      fillEventIds: ["fill-1"],
    },
    "vertex_native_settlements",
  ],
  [option, "vertex_native_settlements"],
  [{ ...option, kind: "exercise" }, "vertex_native_settlements"],
  [
    { ...option, kind: "option-expiry", cashDelta: "0", shareDelta: "0" },
    "vertex_native_settlements",
  ],
  [
    {
      kind: "corporate-action",
      actionId: "action-1",
      oldInstrumentId: "old-1",
      newInstrumentId: "new-1",
      quantityNumerator: "2",
      quantityDenominator: "1",
      previousQuantity: "1",
      newQuantity: "2",
      cashDelta: "0",
      currency: "USD",
      previousQualificationSha256: "d".repeat(64),
      replacementQualificationSha256: "e".repeat(64),
    },
    "vertex_native_corporate_actions",
  ],
  [
    {
      kind: "reconciliation",
      reconciliationId: "reconciliation-1",
      observedSnapshotId: "checkpoint-1",
      unknownCount: 0,
      reconciled: true,
    },
    "vertex_native_reconciliations",
  ],
  [
    {
      kind: "kill-state",
      action: "reset-new-risk",
      reasonCodes: ["reconciled"],
      grantId: "observed-native-grant",
    },
    "vertex_native_kill_states",
  ],
];

describe("native fact proof and scoped emitter boundary", () => {
  it.each(facts)(
    "normalizes exact observed fact %j in one transaction",
    async (fact, table) => {
      const h = harness();
      const f = await fixture(fact);
      expect(
        await h.native.appendNativeFactProjection(
          principal,
          scope,
          f.value,
          f.bytes
        )
      ).toEqual({
        status: "applied",
        highWaterSequence: "2",
        highWaterEventHash: f.value.eventHash,
      });
      expect(h.data(table)).toHaveLength(1);
      expect(h.data(table)[0]).toMatchObject({
        authoritative: false,
        execution_authorized: false,
      });
      expect(h.data("vertex_native_journal_proofs")[0]).toMatchObject({
        canonical_json: canonicalArtifactJson(f.proof),
        sha256: f.value.proof.sha256,
        payload: f.proof,
      });
      expect(h.lifecycle).toEqual(["begin", "commit"]);
      expect(
        h.queries.every(
          (q) =>
            !/vertex_(?:paper_jobs|receipt_orders|receipt_fills|reservation_observations|sleeve_observations)/.test(
              q.sql
            )
        )
      ).toBe(true);
      return expect(h.authorize).toHaveBeenCalledWith({
        principal,
        scope,
        collectionId: null,
        resourceId: "native-stream",
        action: "project",
        now: NOW,
      });
    }
  );
  it("rejects a forged event hash before any SQL", async () => {
    const h = harness();
    const f = await fixture();
    await expect(
      h.native.appendNativeFactProjection(
        principal,
        scope,
        { ...f.value, eventHash: "f".repeat(64) },
        f.bytes
      )
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(h.queries).toEqual([]);
  });
  it.each([{ accountAlias: "foreign" }, { actorId: "foreign-emitter" }])(
    "denies mismatched emitter/scope %j",
    async (overrides) => {
      const h = harness();
      const f = await fixture(checkpoint, overrides);
      await expect(
        h.native.appendNativeFactProjection(principal, scope, f.value, f.bytes)
      ).rejects.toMatchObject({ code: "denied" });
      return expect(h.queries).toEqual([]);
    }
  );
  it("rechecks the current exact project grant after the shared account lock", async () => {
    const h = harness();
    const f = await fixture();
    h.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      h.native.appendNativeFactProjection(principal, scope, f.value, f.bytes)
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.queries).toHaveLength(1);
    expect(h.data("vertex_native_journal_proofs")).toEqual([]);
    return expect(h.lifecycle).toEqual(["begin", "rollback"]);
  });
  it.each([
    { accountAlias: "foreign" },
    { environment: "live" },
    { streamId: "other-stream" },
    { ownerEpoch: "2" },
    { sourceEventId: "other-source" },
    { occurredAt: BEFORE },
    { journalSequence: "8" },
    { journalHeadHash: "d".repeat(64) },
    { factOrdinal: 1 },
    { payload: { ...checkpoint, snapshotId: "other-snapshot" } },
  ])("rejects independently hashed but unbound proof %j", async (overrides) => {
    const h = harness();
    const f = await fixture(checkpoint, {}, overrides);
    await expect(
      h.native.appendNativeFactProjection(principal, scope, f.value, f.bytes)
    ).rejects.toMatchObject({
      code: overrides.environment ? "invalid" : "integrity",
    });
    return expect(h.data("vertex_native_fact_projections")).toEqual([]);
  });
  it("hashes raw proof bytes separately and rejects a wrong reference digest", async () => {
    const h = harness();
    const f = await fixture();
    const value = await rehash({
      ...f.value,
      proof: { ...f.value.proof, sha256: "f".repeat(64) },
    });
    await expect(
      h.native.appendNativeFactProjection(principal, scope, value, f.bytes)
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(h.queries).toEqual([]);
  });
  it("rejects noncanonical JSON even when its supplied raw-byte digest matches", async () => {
    const h = harness();
    const f = await fixture();
    const bytes = encoder.encode(JSON.stringify(f.proof, null, 2));
    const value = await rehash({
      ...f.value,
      proof: { ...f.value.proof, sha256: await hashArtifact(bytes) },
    });
    return await expect(
      h.native.appendNativeFactProjection(principal, scope, value, bytes)
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it.each([new Uint8Array(), new Uint8Array(1_048_577)])(
    "bounds proof bytes before persistence",
    async (bytes) => {
      const h = harness();
      const f = await fixture();
      await expect(
        h.native.appendNativeFactProjection(principal, scope, f.value, bytes)
      ).rejects.toMatchObject({ code: "invalid" });
      return expect(h.queries).toEqual([]);
    }
  );
  it("snapshots caller bytes before an asynchronous validator can yield", async () => {
    const h = harness();
    const f = await fixture();
    const pending = h.native.appendNativeFactProjection(
      principal,
      scope,
      f.value,
      f.bytes
    );
    f.bytes.fill(0);
    expect(await pending).toMatchObject({ status: "applied" });
    return expect(
      h.data("vertex_native_journal_proofs")[0]!["canonical_json"]
    ).toBe(canonicalArtifactJson(f.proof));
  });
  it("retains exact proof catalog identity on retry and rejects stored payload tampering", async () => {
    const h = harness();
    const f = await fixture();
    await h.native.appendNativeFactProjection(
      principal,
      scope,
      f.value,
      f.bytes
    );
    expect(
      await h.native.appendNativeFactProjection(
        principal,
        scope,
        f.value,
        f.bytes
      )
    ).toMatchObject({ status: "duplicate" });
    expect(h.data("vertex_native_journal_proofs")).toHaveLength(1);
    h.data("vertex_native_journal_proofs")[0]!["payload"] = {
      ...f.proof,
      sourceEventId: "changed",
    };
    return await expect(
      h.native.appendNativeFactProjection(principal, scope, f.value, f.bytes)
    ).rejects.toMatchObject({ code: "integrity" });
  });
  return it("redacts exceptions from canonical encoding and injected validation", async () => {
    const h = harness();
    const f = await fixture();
    h.validate.mockImplementationOnce(() => {
      throw new Error("private provider material");
    });
    return await expect(
      h.native.appendNativeFactProjection(principal, scope, f.value, f.bytes)
    ).rejects.toMatchObject({
      message: "Vertex persistence invalid",
      code: "invalid",
    });
  });
});

describe("one contiguous native/order stream, never buying power", () => {
  it("requires genesis for native facts without claiming an empty head", async () => {
    const h = harness(false);
    const f = await fixture();
    await expect(
      h.native.appendNativeFactProjection(principal, scope, f.value, f.bytes)
    ).rejects.toMatchObject({ code: "stale" });
    expect(h.data("vertex_projection_heads")).toEqual([]);
    expect(h.data("vertex_native_journal_proofs")).toEqual([]);
    return expect(h.lifecycle).toEqual(["begin", "rollback"]);
  });
  it("preserves legacy broker sequence-one observations without allowing native sequence one", async () => {
    const h = harness(false);
    expect(
      await h.orders.appendExecutionProjection(
        principal,
        scope,
        await orderFixture({ sequence: "1", previousEventHash: null })
      )
    ).toMatchObject({ status: "applied", highWaterSequence: "1" });
    const f = await fixture(checkpoint, {
      sequence: "1",
      previousEventHash: null,
    });
    return await expect(
      h.native.appendNativeFactProjection(principal, scope, f.value, f.bytes)
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("does not let a legacy broker receipt occupy the existing genesis position", async () => {
    const h = harness();
    await expect(
      h.orders.appendExecutionProjection(
        principal,
        scope,
        await orderFixture({ sequence: "1", previousEventHash: null })
      )
    ).rejects.toMatchObject({ code: "conflict" });
    expect(h.data("vertex_execution_projections")).toEqual([]);
    return expect(
      h.data("vertex_projection_heads")[0]!["high_water_event_hash"]
    ).toBe(genesisHash);
  });
  it.each([
    { sequence: "3" },
    { ownerEpoch: "2" },
    { previousEventHash: "f".repeat(64) },
  ])("persists unresolved %j without advancing head", async (overrides) => {
    const h = harness();
    const f = await fixture(checkpoint, overrides);
    const status = overrides.ownerEpoch ? "epoch-mismatch" : "gap";
    expect(
      await h.native.appendNativeFactProjection(
        principal,
        scope,
        f.value,
        f.bytes
      )
    ).toMatchObject({
      status,
      highWaterSequence: "1",
      highWaterEventHash: genesisHash,
    });
    expect(h.data("vertex_native_fact_projections")[0]).toMatchObject({
      applied: false,
      disposition: status,
      payload: f.value,
    });
    return expect(h.data("vertex_projection_heads")[0]).toMatchObject({
      state: status,
      high_water_sequence: "1",
    });
  });
  it("repairs only contiguous exact retries and retains both kinds of pending facts", async () => {
    const h = harness();
    const second = await orderFixture();
    const third = await fixture(checkpoint, {
      sequence: "3",
      projectionId: "native-3",
      idempotencyKey: "native-key-3",
      previousEventHash: second["eventHash"],
    });
    expect(
      await h.native.appendNativeFactProjection(
        principal,
        scope,
        third.value,
        third.bytes
      )
    ).toMatchObject({ status: "gap" });
    expect(
      await h.orders.appendExecutionProjection(principal, scope, second)
    ).toMatchObject({ status: "applied", highWaterSequence: "2" });
    expect(h.data("vertex_projection_heads")[0]!["state"]).toBe("gap");
    expect(
      await h.native.appendNativeFactProjection(
        principal,
        scope,
        third.value,
        third.bytes
      )
    ).toMatchObject({ status: "applied", highWaterSequence: "3" });
    expect(h.data("vertex_projection_heads")[0]!["state"]).toBe("continuous");
    expect(h.data("vertex_native_fact_projections")).toHaveLength(1);
    expect(h.data("vertex_native_fact_projections")[0]!["payload"]).toEqual(
      third.value
    );
    const fourth = await orderFixture({
      sequence: "4",
      projectionId: "order-4",
      idempotencyKey: "order-key-4",
      previousEventHash: third.value.eventHash,
    });
    return expect(
      await h.orders.appendExecutionProjection(principal, scope, fourth)
    ).toMatchObject({ status: "applied", highWaterSequence: "4" });
  });
  it.each(["projection-id", "sequence", "idempotency"])(
    "rejects cross-kind %s collisions in both directions",
    async (collision) => {
      for (const firstKind of ["order", "native"]) {
        const h = harness();
        const f = await fixture();
        const override =
          collision === "projection-id"
            ? {
                projectionId: f.value.projectionId,
                sequence: "3",
                previousEventHash: f.value.eventHash,
              }
            : collision === "idempotency"
              ? {
                  idempotencyKey: f.value.idempotencyKey,
                  sequence: "3",
                  previousEventHash: f.value.eventHash,
                }
              : {};
        const order = await orderFixture(override);
        if (firstKind === "order") {
          await h.orders.appendExecutionProjection(principal, scope, order);
          await expect(
            h.native.appendNativeFactProjection(
              principal,
              scope,
              f.value,
              f.bytes
            )
          ).rejects.toMatchObject({ code: "conflict" });
        } else {
          await h.native.appendNativeFactProjection(
            principal,
            scope,
            f.value,
            f.bytes
          );
          await expect(
            h.orders.appendExecutionProjection(principal, scope, order)
          ).rejects.toMatchObject({ code: "conflict" });
        }
        expect(
          h.data("vertex_execution_projections").length +
            h.data("vertex_native_fact_projections").length
        ).toBe(1);
      }
    }
  );
  it("retains epoch mismatch inhibition while the other event kind advances", async () => {
    const h = harness();
    const foreign = await fixture(checkpoint, {
      projectionId: "epoch-2",
      idempotencyKey: "epoch-key-2",
      ownerEpoch: "2",
    });
    await h.native.appendNativeFactProjection(
      principal,
      scope,
      foreign.value,
      foreign.bytes
    );
    await h.orders.appendExecutionProjection(
      principal,
      scope,
      await orderFixture()
    );
    return expect(h.data("vertex_projection_heads")[0]).toMatchObject({
      state: "epoch-mismatch",
      high_water_sequence: "2",
      owner_epoch: "1",
    });
  });
  it("keeps valid expired historical facts rather than requiring admission freshness", async () => {
    const h = harness();
    const f = await fixture(checkpoint, {
      occurredAt: "2026-09-22T11:59:59.100000001Z",
      receivedAt: "2026-09-22T11:59:59.200000001Z",
      expiresAt: "2026-09-22T11:59:59.900000001Z",
    });
    expect(
      await h.native.appendNativeFactProjection(
        principal,
        scope,
        f.value,
        f.bytes
      )
    ).toMatchObject({ status: "stale", highWaterSequence: "2" });
    expect(h.data("vertex_native_fact_projections")[0]!["applied"]).toBe(true);
    return expect(
      h.queries.every((q) => !q.sql.includes("vertex_paper_jobs"))
    ).toBe(true);
  });
  it("stores pending future assignment obligations without posting cash or shares", async () => {
    const h = harness();
    const f = await fixture(option);
    await h.native.appendNativeFactProjection(
      principal,
      scope,
      f.value,
      f.bytes
    );
    expect(h.data("vertex_native_settlements")[0]).toMatchObject({
      settlement_state: "pending",
      due_at: LATER,
      cash_delta: "-100",
      share_delta: "1",
      authoritative: false,
      execution_authorized: false,
    });
    return expect(
      h.queries
        .filter((q) => q.sql.startsWith("update"))
        .every((q) => q.sql.includes("vertex_projection_heads"))
    ).toBe(true);
  });
  it.each([
    { ...option, settlementState: "settled" },
    { ...option, kind: "option-expiry", cashDelta: "1", shareDelta: "0" },
    { ...option, kind: "option-expiry", cashDelta: "0", shareDelta: "1" },
  ])(
    "rejects premature settlement or manufactured expiry deltas %j",
    async (fact) => {
      const h = harness();
      const f = await fixture(fact);
      await expect(
        h.native.appendNativeFactProjection(principal, scope, f.value, f.bytes)
      ).rejects.toMatchObject({ code: "invalid" });
      return expect(h.queries).toEqual([]);
    }
  );
  it("binds a portfolio snapshot to an applied native fact without manufacturing an order receipt", async () => {
    const h = harness();
    const f = await fixture();
    await h.native.appendNativeFactProjection(
      principal,
      scope,
      f.value,
      f.bytes
    );
    const continuity = await h.orders.getContinuity(
      principal,
      scope,
      "native-stream"
    );
    const snapshot = {
      schemaVersion: "1.0.0",
      snapshotId: "snapshot-after-fact",
      ...scope,
      streamId: "native-stream",
      ownerEpoch: "1",
      sequence: "2",
      sourceEventHash: f.value.eventHash,
      sourceKind: "paper-simulation",
      asOfAt: NOW,
      receivedAt: NOW,
      currency: "USD",
      cash: "0",
      netAssetValue: "0",
      positions: [],
      lots: [],
      reservations: [],
      sleeveAllocations: [],
      continuity,
      observationOnly: true,
      executionAuthorized: false,
      researchNotionalIncluded: false,
    };
    expect(
      await h.orders.recordPortfolioSnapshot(principal, scope, snapshot)
    ).toBe("recorded");
    expect(h.data("vertex_portfolio_snapshots")).toHaveLength(1);
    return expect(h.data("vertex_receipt_orders")).toEqual([]);
  });
  it("admits distinct ordinals from one journal event without equating journal and projection sequence", async () => {
    const h = harness();
    const first = await fixture();
    await h.native.appendNativeFactProjection(
      principal,
      scope,
      first.value,
      first.bytes
    );
    const next = await fixture(
      {
        kind: "reconciliation",
        reconciliationId: "reconciliation-1",
        observedSnapshotId: "checkpoint-1",
        unknownCount: 0,
        reconciled: true,
      },
      {
        projectionId: "native-3",
        idempotencyKey: "native-key-3",
        sequence: "3",
        previousEventHash: first.value.eventHash,
        factOrdinal: 1,
      }
    );
    expect(
      await h.native.appendNativeFactProjection(
        principal,
        scope,
        next.value,
        next.bytes
      )
    ).toMatchObject({ status: "applied", highWaterSequence: "3" });
    return expect(
      h
        .data("vertex_native_fact_projections")
        .map((row) => [
          row["sequence"],
          row["proof_journal_sequence"],
          row["fact_ordinal"],
        ])
    ).toEqual([
      ["2", "7", 0],
      ["3", "7", 1],
    ]);
  });
  it.each(["native-stream", "stream-alias"])(
    "rejects journal ordinal reuse through %s and rolls back proof aliases",
    async (streamId) => {
      const h = harness();
      const first = await fixture();
      await h.native.appendNativeFactProjection(
        principal,
        scope,
        first.value,
        first.bytes
      );
      const changed = await fixture(
        { ...checkpoint, snapshotId: "changed-checkpoint" },
        {
          streamId,
          projectionId: "native-alias",
          idempotencyKey: "native-key-alias",
          sequence: "3",
          previousEventHash: first.value.eventHash,
        }
      );
      await expect(
        h.native.appendNativeFactProjection(
          principal,
          scope,
          changed.value,
          changed.bytes
        )
      ).rejects.toMatchObject({ code: "conflict" });
      expect(h.data("vertex_native_journal_proofs")).toHaveLength(1);
      return expect(h.data("vertex_native_fact_projections")).toHaveLength(1);
    }
  );
  it.each([
    "proof_journal_sequence",
    "proof_journal_head_hash",
    "fact_ordinal",
    "proof_source_event_id",
    "proof_artifact_id",
    "fact_kind",
  ])(
    "rejects normalized %s tampering before an exact retry is duplicate",
    async (column) => {
      const h = harness();
      const f = await fixture();
      await h.native.appendNativeFactProjection(
        principal,
        scope,
        f.value,
        f.bytes
      );
      h.data("vertex_native_fact_projections")[0]![column] =
        column === "fact_ordinal" ? 1 : "tampered";
      return await expect(
        h.native.appendNativeFactProjection(principal, scope, f.value, f.bytes)
      ).rejects.toMatchObject({ code: "integrity" });
    }
  );
  return it("checks new native normalized columns when reading a snapshot predecessor", async () => {
    const h = harness();
    const f = await fixture();
    await h.native.appendNativeFactProjection(
      principal,
      scope,
      f.value,
      f.bytes
    );
    h.data("vertex_native_fact_projections")[0]!["fact_ordinal"] = 1;
    const continuity = await h.orders.getContinuity(
      principal,
      scope,
      "native-stream"
    );
    const snapshot = {
      schemaVersion: "1.0.0",
      snapshotId: "snapshot-after-fact",
      ...scope,
      streamId: "native-stream",
      ownerEpoch: "1",
      sequence: "2",
      sourceEventHash: f.value.eventHash,
      sourceKind: "paper-simulation",
      asOfAt: NOW,
      receivedAt: NOW,
      currency: "USD",
      cash: "0",
      netAssetValue: "0",
      positions: [],
      lots: [],
      reservations: [],
      sleeveAllocations: [],
      continuity,
      observationOnly: true,
      executionAuthorized: false,
      researchNotionalIncluded: false,
    };
    return await expect(
      h.orders.recordPortfolioSnapshot(principal, scope, snapshot)
    ).rejects.toMatchObject({ code: "integrity" });
  });
});
