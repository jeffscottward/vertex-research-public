import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  computePortfolioGenesisHash,
  PortfolioSnapshotSchema,
} from "../../../api/src/vertex.ts";
import type { Database } from "./client.ts";
import type { VertexBoundary, VertexScope } from "./vertex-ports.ts";
import { createVertexStore } from "./vertex-repository.ts";

const at = "2026-09-22T12:00:00.000000001Z";
const scope: VertexScope = {
  accountAlias: "synthetic-simulator-account",
  environment: "paper",
};
const principal = { actorId: "synthetic-native-owner" };
const genesis = async () => {
  const digest = "0".repeat(64);
  const value = PortfolioSnapshotSchema.parse({
    schemaVersion: "1.0.0",
    snapshotId: "genesis-snapshot",
    ...scope,
    streamId: "simulation-stream",
    ownerEpoch: "1",
    sequence: "1",
    sourceEventHash: digest,
    sourceKind: "paper-simulation",
    asOfAt: at,
    receivedAt: at,
    currency: "USD",
    cash: "100",
    netAssetValue: "100",
    positions: [],
    lots: [],
    reservations: [],
    sleeveAllocations: [],
    continuity: {
      ...scope,
      streamId: "simulation-stream",
      ownerEpoch: "1",
      highWaterSequence: "1",
      highWaterEventHash: digest,
      lastOccurredAt: at,
      lastReceivedAt: at,
      evaluatedAt: at,
      freshness: {
        status: "fresh",
        observedAt: at,
        evaluatedAt: at,
        maxAgeMs: 10_000,
      },
      state: "continuous",
      expectedNextSequence: "2",
      receivedSequence: null,
      newRiskInhibited: true,
      authoritative: false,
    },
    observationOnly: true,
    executionAuthorized: false,
    researchNotionalIncluded: false,
  });
  const sourceEventHash = await computePortfolioGenesisHash(value);
  return PortfolioSnapshotSchema.parse({
    ...value,
    sourceEventHash,
    continuity: { ...value.continuity, highWaterEventHash: sourceEventHash },
  });
};

type Query = Readonly<{ sql: string; params: unknown[] }>;
const harness = (
  respond: (query: Query) => Record<string, unknown>[] = () => []
) => {
  const queries: Query[] = [];
  const lifecycle: string[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (value: SQL) => {
    const query = dialect.sqlToQuery(value);
    queries.push(query);
    return { rows: respond(query) };
  });
  const transaction = vi.fn(
    async (
      operation: (tx: { execute: typeof execute }) => Promise<unknown>
    ) => {
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
  const db = { transaction } as unknown as Database;
  const boundary: VertexBoundary = {
    validate: (name, value, version) => {
      if (name !== "PortfolioSnapshot" || version !== "1.0.0") {
        throw new Error("Wrong contract");
      }
      return PortfolioSnapshotSchema.parse(value);
    },
    encode: (value) => new TextEncoder().encode(canonicalArtifactJson(value)),
    digest: (bytes) => hashArtifact(bytes),
  };
  const authorize = vi.fn(async () => true);
  const store = createVertexStore(db, {
    boundary,
    authorization: { authorize },
    clock: { now: () => at },
    maxProjectionAgeMs: 10_000,
  });
  return { store, queries, lifecycle, authorize, transaction };
};

// Native initial capital is a separately approved simulator policy. Fixtures
// below prove only authored observation logic, never native spending authority.
describe("first empty paper stream genesis observation", () => {
  it("atomically stores canonical sequence1 head and snapshot without receipt or reservation allocation", async () => {
    const test = harness();
    const snapshot = await genesis();
    expect(
      await test.store.recordPortfolioSnapshot(principal, scope, snapshot)
    ).toBe("recorded");
    expect(test.lifecycle).toEqual(["begin", "commit"]);
    const inserts = test.queries.filter((query) =>
      query.sql.startsWith("insert")
    );
    expect(
      inserts.some(
        (query) =>
          query.sql.includes('"vertex_projection_heads"') &&
          query.params.includes(snapshot.sourceEventHash)
      )
    ).toBe(true);
    expect(
      inserts.some((query) =>
        query.sql.includes('"vertex_portfolio_snapshots"')
      )
    ).toBe(true);
    expect(
      inserts.every(
        (query) =>
          !(
            query.sql.includes("vertex_paper_jobs") ||
            query.sql.includes("vertex_execution_projections") ||
            query.sql.includes("vertex_reservation_observations")
          )
      )
    ).toBe(true);
    expect(test.queries.every((query) => !query.sql.startsWith("update"))).toBe(
      true
    );
  });

  it("does not initialize a stream without the exact current emitter project grant", async () => {
    const test = harness();
    test.authorize.mockResolvedValue(false);
    await expect(
      test.store.recordPortfolioSnapshot(principal, scope, await genesis())
    ).rejects.toMatchObject({ code: "denied" });
    expect(test.transaction).not.toHaveBeenCalled();
  });

  it("rejects a tampered canonical genesis and rolls back before normalized writes", async () => {
    const test = harness();
    await expect(
      test.store.recordPortfolioSnapshot(principal, scope, {
        ...(await genesis()),
        cash: "101",
      })
    ).rejects.toMatchObject({ code: "integrity" });
    expect(test.lifecycle).toEqual(["begin", "rollback"]);
    expect(test.queries.some((query) => query.sql.startsWith("insert"))).toBe(
      false
    );
  });

  it("does not allow live broker relabeling or sequence2 genesis", async () => {
    const initial = await genesis();
    const test = harness();
    await expect(
      test.store.recordPortfolioSnapshot(principal, scope, {
        ...initial,
        sourceKind: "broker-observation",
      })
    ).rejects.toMatchObject({ code: "stale" });
    await expect(
      test.store.recordPortfolioSnapshot(principal, scope, {
        ...initial,
        sequence: "2",
        continuity: {
          ...initial.continuity,
          highWaterSequence: "2",
          expectedNextSequence: "3",
        },
      })
    ).rejects.toMatchObject({ code: "stale" });
    const live: VertexScope = { ...scope, environment: "live" };
    await expect(
      test.store.recordPortfolioSnapshot(principal, live, {
        ...initial,
        ...live,
        sourceKind: "broker-observation",
        continuity: { ...initial.continuity, ...live },
      })
    ).rejects.toMatchObject({ code: "stale" });
    expect(test.queries.some((query) => query.sql.startsWith("insert"))).toBe(
      false
    );
  });

  it("cannot reset an existing stream or overwrite a native predecessor", async () => {
    const snapshot = await genesis();
    const test = harness((query) =>
      query.sql.includes('from "vertex_projection_heads"')
        ? [
            {
              stream_id: snapshot.streamId,
              owner_epoch: "1",
              high_water_sequence: "2",
              high_water_event_hash: "b".repeat(64),
              last_occurred_at: at,
              last_received_at: at,
            },
          ]
        : []
    );
    await expect(
      test.store.recordPortfolioSnapshot(principal, scope, snapshot)
    ).rejects.toMatchObject({ code: "stale" });
    expect(test.queries.some((query) => query.sql.startsWith("insert"))).toBe(
      false
    );
  });

  it("keeps an exact immutable genesis retry idempotent", async () => {
    const snapshot = await genesis();
    const recordHash = await hashArtifact(snapshot);
    const test = harness((query) =>
      query.sql.includes('from "vertex_portfolio_snapshots"')
        ? [{ snapshot_id: snapshot.snapshotId, record_hash: recordHash }]
        : []
    );
    expect(
      await test.store.recordPortfolioSnapshot(principal, scope, snapshot)
    ).toBe("duplicate");
    expect(test.queries.some((query) => query.sql.startsWith("insert"))).toBe(
      false
    );
  });
});
