import {
  type BacktestRunsRepository,
  createBacktestRunsRepository,
  createNodeDatabase,
  type DatabaseResource,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The Nautilus worker queue on real Postgres: claimNext takes the oldest queued run of one engine
// with a conditional update (concurrent workers never get the same run), and failIfUnclaimed fails
// a queued run only when no run of its engine was claimed in the window.

const MINUTE_MS = 60_000;
const T0 = Date.parse("2026-11-05T12:00:00.000Z");

let testDatabase: PostgresTestDatabase;
let databaseResource: DatabaseResource;
let clock = T0;
let next = 0;

const repository = (): BacktestRunsRepository =>
  createBacktestRunsRepository(databaseResource.db, {
    generateId: () => {
      next += 1;
      return `br-${String(next).padStart(4, "0")}`;
    },
    now: () => new Date(clock),
  });

/** Creates a queued run of `engine` at `at` (epoch ms). */
const queue = async (engine: string, at: number) => {
  clock = at;
  return await repository().create({
    engineVersion: engine,
    requestedBy: "operator",
    spec: {
      costBps: 0,
      from: "2020-01-01",
      initialCapital: 10_000,
      rule: { fast: 5, kind: "smaCross", slow: 20 },
      stopLossPct: 0,
      symbol: "SPY",
      takeProfitPct: 0,
      timeframe: "1d",
      to: "2021-01-01",
    },
    strategyId: null,
    strategyRevision: null,
    strategySnapshot: null,
  });
};

/** Claims the next run of `engine` at `at`. */
const claimAt = async (engine: string, at: number) => {
  clock = at;
  return await repository().claimNext(engine);
};

describe("backtest run queue on real Postgres", { concurrent: false }, () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    databaseResource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 8,
    });
    return await migrate(databaseResource.db);
  }, 60_000);

  afterAll(async () => {
    try {
      if (databaseResource !== undefined) return await databaseResource.close();
      return;
    } finally {
      if (testDatabase !== undefined)
        await dropPostgresTestDatabase(testDatabase);
    }
  }, 60_000);

  it("claims the oldest queued run of the engine only", async () => {
    const engine = "nautilus-oldest";
    const newer = await queue(engine, T0 + 2 * MINUTE_MS);
    const older = await queue(engine, T0 + MINUTE_MS);
    const other = await queue("instant-2", T0);

    const first = await claimAt(engine, T0 + 3 * MINUTE_MS);
    expect(first).toMatchObject({
      engineVersion: engine,
      id: older.id,
      startedAt: new Date(T0 + 3 * MINUTE_MS),
      status: "running",
    });
    expect((await claimAt(engine, T0 + 4 * MINUTE_MS))?.id).toBe(newer.id);
    await expect(claimAt(engine, T0 + 5 * MINUTE_MS)).resolves.toBeNull();
    expect((await repository().get(other.id))?.status).toBe("queued");
  });

  it("never gives the same run to two concurrent claimers", async () => {
    const engine = "nautilus-race";
    const runs = await Promise.all(
      [0, 1, 2].map((index) => queue(engine, T0 + index * MINUTE_MS))
    );
    clock = T0 + 10 * MINUTE_MS;
    const claimed = await Promise.all(
      Array.from({ length: 8 }, () => repository().claimNext(engine))
    );
    const ids = claimed.flatMap((run) => (run === null ? [] : [run.id]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
    // A claimer that lost every attempt returned null; the rest are claimed one at a time.
    const drained: string[] = [];
    for (;;) {
      const run = await repository().claimNext(engine);
      if (run === null) break;
      drained.push(run.id);
    }
    expect([...ids, ...drained].sort()).toEqual(
      runs.map((run) => run.id).sort()
    );
  });

  it("fails an old queued run only when no run of its engine started in the window", async () => {
    const engine = "nautilus-idle";
    const window = T0 + 30 * MINUTE_MS;
    const before = new Date(window);
    const error = "Nautilus backtest worker did not pick up the run";

    // A run of the engine claimed before the window is not activity in the window.
    await queue(engine, T0);
    await claimAt(engine, T0 + MINUTE_MS);
    const waiting = await queue(engine, T0 + 2 * MINUTE_MS);
    // A TypeScript run that started inside the window does not count either.
    await queue("instant-2", T0);
    await claimAt("instant-2", window + MINUTE_MS);
    // A run created inside the window is not old enough.
    const fresh = await queue(engine, window + MINUTE_MS);

    await expect(
      repository().failIfUnclaimed(fresh.id, engine, before, error)
    ).resolves.toBe(false);
    await expect(
      repository().failIfUnclaimed(waiting.id, engine, before, error)
    ).resolves.toBe(true);
    expect(await repository().get(waiting.id)).toMatchObject({
      error,
      status: "failed",
    });
    expect((await repository().get(fresh.id))?.status).toBe("queued");
    // A terminal run is never rewritten.
    await expect(
      repository().failIfUnclaimed(waiting.id, engine, before, "again")
    ).resolves.toBe(false);
  });

  it("keeps the backlog queued while a worker of the engine is busy", async () => {
    const engine = "nautilus-busy";
    const window = T0 + 30 * MINUTE_MS;
    const before = new Date(window);
    await queue(engine, T0);
    const backlog = await queue(engine, T0 + MINUTE_MS);
    // The worker claimed the first run inside the window and is still running it.
    expect((await claimAt(engine, window + 2 * MINUTE_MS))?.id).not.toBe(
      backlog.id
    );
    await expect(
      repository().failIfUnclaimed(backlog.id, engine, before, "idle")
    ).resolves.toBe(false);
    expect((await repository().get(backlog.id))?.status).toBe("queued");
  });
});
