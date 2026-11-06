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

/** Creates a queued run of `engine` at `at` (epoch ms), optionally in a comparison group. */
const queue = async (
  engine: string,
  at: number,
  comparison?: Readonly<{ feature: string; groupId: string }>
) => {
  clock = at;
  return await repository().create({
    engineVersion: engine,
    requestedBy: "operator",
    spec: {
      ...(comparison === undefined
        ? {}
        : { comparison: { ...comparison, label: "cell" } }),
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

  it("lists comparison runs apart from ordinary runs, by feature and group", async () => {
    const engine = "nautilus-lists";
    const plain = await queue(engine, T0);
    const sweepA = await queue(engine, T0 + MINUTE_MS, {
      feature: "sweep",
      groupId: "list-a",
    });
    const sweepB = await queue(engine, T0 + 2 * MINUTE_MS, {
      feature: "sweep",
      groupId: "list-b",
    });
    const instant = await queue(engine, T0 + 3 * MINUTE_MS, {
      feature: "instant",
      groupId: "list-c",
    });
    await repository().complete(
      (await repository().claim(instant.id))?.id ?? "",
      {
        differences: { items: [], ok: true },
        engineRun: { host: "rig" },
        metrics: {},
      }
    );
    const listed = (await repository().list({ limit: 100 })).map(
      (run) => run.id
    );
    expect(listed).toContain(plain.id);
    for (const run of [sweepA, sweepB, instant])
      expect(listed).not.toContain(run.id);

    const all = await repository().listComparisons({ limit: 100 });
    expect(all.map((run) => run.id)).toEqual(
      expect.arrayContaining([sweepA.id, sweepB.id, instant.id])
    );
    expect(all.map((run) => run.id)).not.toContain(plain.id);
    const sweeps = await repository().listComparisons({
      feature: "sweep",
      limit: 100,
    });
    expect(sweeps.map((run) => run.id).sort()).toEqual(
      [sweepA.id, sweepB.id].sort()
    );
    const group = await repository().listComparisons({
      groupId: "list-c",
      limit: 100,
    });
    expect(group).toHaveLength(1);
    expect(group[0]).toMatchObject({
      differences: { items: [], ok: true },
      engineRun: { host: "rig" },
      id: instant.id,
      status: "succeeded",
    });
    expect(group[0]).not.toHaveProperty("report");
    expect(
      (await repository().listComparisons({ groupId: "list-a", limit: 100 }))[0]
    ).toMatchObject({ differences: null, engineRun: null, id: sweepA.id });
  });

  it("claims one comparison group per batch and never gives a run to two callers", async () => {
    const engine = "nautilus-batch";
    const lone = await queue(engine, T0);
    const group = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        queue(engine, T0 + (index + 1) * MINUTE_MS, {
          feature: "sweep",
          groupId: "batch-g",
        })
      )
    );
    const other = await queue(engine, T0 + 20 * MINUTE_MS, {
      feature: "sweep",
      groupId: "batch-h",
    });
    clock = T0 + 30 * MINUTE_MS;
    // The oldest run has no group: it comes alone.
    expect(
      (await repository().claimBatch(engine, 50)).map((run) => run.id)
    ).toEqual([lone.id]);
    // Then the group, oldest first, at most `max` runs, never the other group.
    const first = await repository().claimBatch(engine, 5);
    expect(first.map((run) => run.id)).toEqual(
      group.slice(0, 5).map((run) => run.id)
    );
    // Four concurrent callers share the rest of the group without overlap.
    const batches = await Promise.all(
      Array.from({ length: 4 }, () => repository().claimBatch(engine, 50))
    );
    const ids = batches.flat().map((run) => run.id);
    expect(new Set(ids).size).toBe(ids.length);
    const rest = [...group.slice(5), other].map((run) => run.id);
    const drained: string[] = [];
    for (;;) {
      const batch = await repository().claimBatch(engine, 50);
      if (batch.length === 0) break;
      drained.push(...batch.map((run) => run.id));
    }
    expect([...ids, ...drained].sort()).toEqual(rest.sort());
    for (const batch of [...batches, first])
      for (const run of batch) expect(run.status).toBe("running");
  });

  const ENQUEUE_ENGINE = "nautilus-enqueue";
  const SUPERSEDED = "Superseded by a newer request";
  const DAY_MS = 24 * 60 * MINUTE_MS;
  const runInput = (requestedBy = "operator", feature = "sweep") => ({
    engineVersion: ENQUEUE_ENGINE,
    requestedBy,
    spec: {
      comparison: { feature, label: "cell" },
      costBps: 0,
      from: "2020-01-01",
      initialCapital: 10_000,
      rule: { fast: 5, kind: "smaCross" as const, slow: 20 },
      stopLossPct: 0,
      symbol: "SPY",
      takeProfitPct: 0,
      timeframe: "1d" as const,
      to: "2021-01-01",
    },
    strategyId: null,
    strategyRevision: null,
    strategySnapshot: null,
  });
  const enqueue = (
    groupId: string,
    at: number,
    count = 2,
    requestedBy = "operator",
    feature = "sweep"
  ) => {
    clock = at;
    return repository().enqueueGroup({
      groupId,
      reuseSince: new Date(at - DAY_MS),
      runs: Array.from({ length: count }, () => {
        const input = runInput(requestedBy, feature);
        return {
          ...input,
          spec: {
            ...input.spec,
            comparison: { ...input.spec.comparison, groupId },
          },
        };
      }),
      supersede: { engineVersion: ENQUEUE_ENGINE, feature, requestedBy },
      supersededError: SUPERSEDED,
    });
  };
  const group = async (groupId: string) =>
    repository().listComparisons({ groupId, limit: 100 });

  it("reuses a live comparison group and supersedes only older queued runs", async () => {
    // (1) Two identical requests at once store the group once; a third reuses it.
    const first = await Promise.all([enqueue("same", T0), enqueue("same", T0)]);
    expect(first.map((result) => result.created).sort()).toEqual([0, 2]);
    expect(first.filter((result) => result.reused)).toHaveLength(1);
    expect(await group("same")).toHaveLength(2);
    await expect(enqueue("same", T0 + MINUTE_MS)).resolves.toEqual({
      created: 0,
      reused: true,
      superseded: 0,
    });

    // (2) A new group of the same feature and requester supersedes the older queued runs, never
    // a running one, and never another requester's or another feature's runs.
    const runningId = (await group("same"))[0]?.id ?? "";
    clock = T0 + 2 * MINUTE_MS;
    await repository().claim(runningId);
    await enqueue("other-user", T0 + 3 * MINUTE_MS, 1, "someone-else");
    await enqueue("instant", T0 + 3 * MINUTE_MS, 1, "operator", "instant");
    await expect(enqueue("newer", T0 + 4 * MINUTE_MS)).resolves.toEqual({
      created: 2,
      reused: false,
      superseded: 1,
    });
    const same = await group("same");
    expect(same.map((run) => run.status).sort()).toEqual(["failed", "running"]);
    expect(same.find((run) => run.status === "failed")?.error).toBe(SUPERSEDED);
    expect((await group("other-user"))[0]?.status).toBe("queued");
    expect((await group("instant"))[0]?.status).toBe("queued");

    // A superseded group is queued again when it is asked for again (it supersedes "newer").
    await expect(enqueue("same", T0 + 5 * MINUTE_MS)).resolves.toEqual({
      created: 0,
      reused: true,
      superseded: 2,
    });
    // "same" still has its running run, so it was reused; a group whose runs were all
    // superseded gets new runs.
    await expect(enqueue("newer", T0 + 6 * MINUTE_MS)).resolves.toMatchObject({
      created: 2,
      reused: false,
    });
    // After 24 hours the same request queues new runs.
    await expect(
      enqueue("instant", T0 + 2 * DAY_MS, 1, "operator", "instant")
    ).resolves.toMatchObject({
      created: 1,
      reused: false,
    });
  });
  it("reuses only a group with a queued, running or succeeded run", async () => {
    const [first] = await group("err-g").then(async (runs) => {
      expect(runs).toHaveLength(0);
      await enqueue("err-g", T0, 1);
      return group("err-g");
    });
    // A run failed for another reason does not make the group reusable.
    await repository().fail(first?.id ?? "", "Nautilus engine failed (exit 1)");
    await expect(enqueue("err-g", T0 + MINUTE_MS, 1)).resolves.toMatchObject({
      created: 1,
      reused: false,
    });
    // A succeeded run does.
    const [queued] = (await group("err-g")).filter(
      (run) => run.status === "queued"
    );
    clock = T0 + 2 * MINUTE_MS;
    await repository().claim(queued?.id ?? "");
    await repository().complete(queued?.id ?? "", {
      differences: { items: [], ok: true },
      engineRun: { host: "rig" },
      metrics: {},
    });
    await expect(enqueue("err-g", T0 + 3 * MINUTE_MS, 1)).resolves.toEqual({
      created: 0,
      reused: true,
      superseded: 0,
    });
  });

  it("lets the later of two concurrent latest requests of different groups supersede the other", async () => {
    for (let round = 0; round < 5; round += 1) {
      const user = `racer-${round}`;
      const at = T0 + round * MINUTE_MS;
      const results = await Promise.all([
        enqueue(`race-${round}-a`, at, 2, user),
        enqueue(`race-${round}-b`, at, 2, user),
      ]);
      // One request ran first and the other superseded all of its runs.
      expect(results.map((result) => result.superseded).sort()).toEqual([0, 2]);
      const statuses = await Promise.all(
        ["a", "b"].map(async (side) =>
          (await group(`race-${round}-${side}`)).map((run) => run.status)
        )
      );
      expect(statuses.map((list) => [...new Set(list)].join()).sort()).toEqual([
        "failed",
        "queued",
      ]);
    }
  });
});
