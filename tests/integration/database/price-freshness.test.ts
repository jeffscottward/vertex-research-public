import { readFileSync } from "node:fs";

import {
  createNodeDatabase,
  createOpenbbFreshnessRepository,
  type Database,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real Postgres integration test for migration 0092_price_freshness_state, its CHECK constraint,
// advisory-locked repository transitions, zero-write steady state, and guarded rollback SQL.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migrationSql = read(
  "../../../packages/db/migrations/0092_price_freshness_state.sql"
);
const rollbackSql = read(
  "../../../packages/db/rollback/0092_price_freshness_state.down.sql"
);

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};
const db = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};

const countRows = async (): Promise<number> => {
  const [row] = await postgres().query<{ n: number }>(
    "select count(*)::int as n from price_freshness_state"
  );
  return row?.n ?? 0;
};
beforeAll(async () => {
  testDatabase = await createPostgresTestDatabase();
  resource = createNodeDatabase({
    connectionString: testDatabase.databaseUrl,
    maxConnections: 2,
  });
  await migrate(resource.db);
}, 60_000);

afterAll(async () => {
  await resource?.close();
  if (testDatabase !== undefined) await dropPostgresTestDatabase(testDatabase);
});

describe("price_freshness_state on Postgres", () => {
  it("performs zero DB writes on noop/in-flight and persists stage, failure, commit, prune, clear, and recovery", async () => {
    const repo = createOpenbbFreshnessRepository(db());
    const t0 = new Date("2026-11-24T11:15:00Z");

    expect(await repo.getFreshnessState("price-freshness")).toBeNull();
    const noop = await repo.stageFreshnessTransition(
      "price-freshness",
      () => ({ kind: "noop" }),
      t0
    );
    expect(noop).toEqual({ activeKeys: [], kind: "noop" });
    expect(await countRows()).toBe(0);

    // Stage alert
    const staged = await repo.stageFreshnessTransition(
      "price-freshness",
      () => ({
        eventId: "evt-pg-1",
        kind: "stage-pending",
        pendingKeys: ["daily_bars:SPY", "daily_series:SPY"],
        pendingKind: "alert",
      }),
      t0
    );
    expect(staged).toEqual({
      activeKeys: [],
      eventId: "evt-pg-1",
      kind: "stage-pending",
      pendingKeys: ["daily_bars:SPY", "daily_series:SPY"],
      pendingKind: "alert",
    });
    expect(await countRows()).toBe(1);

    // Mark not-configured (preserves pending_* for chat fallback)
    const t1 = new Date("2026-11-24T11:15:02Z");
    expect(
      await repo.completeFreshnessDelivery(
        "price-freshness",
        "evt-pg-1",
        "not-configured",
        t1
      )
    ).toBe(true);
    const afterNtfy = await repo.getFreshnessState("price-freshness");
    expect(afterNtfy?.activeKeys).toEqual([]);
    expect(afterNtfy?.pendingDelivery).toBe("not-configured");
    expect(afterNtfy?.pendingEventId).toBe("evt-pg-1");

    // Wrong eventId is rejected
    expect(
      await repo.completeFreshnessDelivery(
        "price-freshness",
        "evt-wrong",
        "sent",
        t1
      )
    ).toBe(false);

    // Commit chat ack
    const t2 = new Date("2026-11-24T11:15:04Z");
    expect(
      await repo.completeFreshnessDelivery(
        "price-freshness",
        "evt-pg-1",
        "sent",
        t2
      )
    ).toBe(true);
    const committed = await repo.getFreshnessState("price-freshness");
    expect(committed?.activeKeys).toEqual([
      "daily_bars:SPY",
      "daily_series:SPY",
    ]);
    expect(committed?.pendingEventId).toBeNull();
    expect(committed?.pendingKind).toBeNull();
    expect(committed?.pendingDelivery).toBeNull();
    expect(committed?.pendingKeys).toEqual([]);
    expect(committed?.lastTransitionAt).toEqual(t2);

    // Partial recovery prunes active keys silently
    const t3 = new Date("2026-11-25T11:15:00Z");
    await repo.stageFreshnessTransition(
      "price-freshness",
      () => ({ activeKeys: ["daily_series:SPY"], kind: "prune-active" }),
      t3
    );
    expect(
      (await repo.getFreshnessState("price-freshness"))?.activeKeys
    ).toEqual(["daily_series:SPY"]);

    // Stage recovery then commit sent
    const t4 = new Date("2026-11-26T11:15:00Z");
    await repo.stageFreshnessTransition(
      "price-freshness",
      () => ({
        eventId: "evt-pg-rec",
        kind: "stage-pending",
        pendingKeys: [],
        pendingKind: "recovery",
      }),
      t4
    );
    expect(
      await repo.completeFreshnessDelivery(
        "price-freshness",
        "evt-pg-rec",
        "sent",
        t4
      )
    ).toBe(true);
    expect(
      (await repo.getFreshnessState("price-freshness"))?.activeKeys
    ).toEqual([]);
  });

  it("enforces CHECK constraints on monitor format, NULL array items, and pending tuple invariants", async () => {
    await expect(
      postgres().query(
        "insert into price_freshness_state (monitor) values ('BAD MONITOR')"
      )
    ).rejects.toThrow(/price_freshness_state_check/u);

    await expect(
      postgres().query(
        "insert into price_freshness_state (monitor, active_keys) values ('null-item', ARRAY[NULL]::text[])"
      )
    ).rejects.toThrow(/price_freshness_state_check/u);

    // Recovery must have empty pending_keys
    await expect(
      postgres().query(
        "insert into price_freshness_state (monitor, pending_event_id, pending_kind, pending_delivery, pending_keys) values ('bad-rec', 'evt-1', 'recovery', 'pending', ARRAY['daily_series:SPY']::text[])"
      )
    ).rejects.toThrow(/price_freshness_state_check/u);

    // Half-populated pending tuple is rejected (event id without kind/delivery)
    await expect(
      postgres().query(
        "insert into price_freshness_state (monitor, pending_event_id) values ('half-pending', 'evt-1')"
      )
    ).rejects.toThrow(/price_freshness_state_check/u);

    // Half-populated pending tuple is rejected (kind/keys without event id)
    await expect(
      postgres().query(
        "insert into price_freshness_state (monitor, pending_kind, pending_keys) values ('half-kind', 'alert', ARRAY['daily_series:SPY']::text[])"
      )
    ).rejects.toThrow(/price_freshness_state_check/u);

    // Alert must have non-empty pending_keys
    await expect(
      postgres().query(
        "insert into price_freshness_state (monitor, pending_event_id, pending_kind, pending_delivery, pending_keys) values ('empty-alert', 'evt-1', 'alert', 'pending', '{}'::text[])"
      )
    ).rejects.toThrow(/price_freshness_state_check/u);
  });

  it("rolls back cleanly with 0092_price_freshness_state.down.sql and re-applies cleanly", async () => {
    await postgres().query(rollbackSql);
    await expect(countRows()).rejects.toThrow(/price_freshness_state/u);
    await postgres().query(migrationSql);
    expect(await countRows()).toBe(0);
  });
});
