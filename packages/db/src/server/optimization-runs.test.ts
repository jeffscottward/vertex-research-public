import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { optimizationRuns } from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  normalizeOptimizationRun,
  type OptimizationRunDraft,
} from "./optimization-runs.ts";
import {
  createOptimizationRunsRepository,
  InvalidRepositoryInputError,
} from "./repositories.ts";

const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");
const dialect = new PgDialect();

interface Operation {
  joined?: boolean;
  kind: string;
  table?: unknown;
  values?: Record<string, unknown>;
  where?: SQL;
}

const createDouble = (
  outcomes: Array<readonly Record<string, unknown>[] | Error>
) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      leftJoin: () => {
        operation.joined = true;
        return chain;
      },
      where: (condition: SQL | undefined) => {
        if (!(condition === undefined)) operation.where = condition;
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      values: (values: Record<string, unknown>) => {
        operation.values = values;
        return chain;
      },
      returning: () => chain,
      then: (
        resolve: (rows: unknown) => unknown,
        reject: (error: unknown) => unknown
      ) => {
        const outcome = outcomes.shift() ?? [];
        return (
          outcome instanceof Error
            ? Promise.reject(outcome)
            : Promise.resolve(outcome)
        ).then(resolve, reject);
      },
    };
    operations.push(operation);
    return chain;
  };
  const database = {
    select: () => builder({ kind: "select" }),
    insert: (table: unknown) => builder({ kind: "insert", table }),
  } as unknown as Database;
  return { database, operations };
};

const trial = (
  index: number,
  a: number,
  b: string,
  score: number | null,
  extra: Record<string, unknown> = {}
) => {
  return {
    index,
    params: { a, b },
    score,
    status: score === null ? "failed" : "ok",
    ...(score === null
      ? { reason: "all markets failed" }
      : { metrics: { sharpe: score } }),
    ...extra,
  };
};

// is_oos grid run over two markets.
const validRun = (): OptimizationRunDraft => ({
  taskId: "task-1",
  strategyId: "s-1",
  method: "grid",
  objectives: [{ metric: "sharpe", direction: "maximize" }],
  validation: {
    mode: "is_oos",
    params: { nObservations: 500, isFraction: 0.7, topK: 2 },
  },
  markets: ["ES", "NQ"],
  seed: 7,
  trialCount: 4,
  stopReason: "exhausted",
  best: {
    trialIndex: 2,
    params: { a: 2, b: "x" },
    score: 1.5,
    metrics: { sharpe: 1.5 },
  },
  trials: [
    trial(0, 1, "x", 0.5),
    trial(1, 1, "y", 0.25),
    trial(2, 2, "x", 1.5),
    trial(3, 2, "y", null),
  ],
  oos: {
    mode: "is_oos",
    inSample: { start: 0, end: 350 },
    outOfSample: { start: 350, end: 500 },
    selected: {
      trialIndex: 2,
      params: { a: 2, b: "x" },
      inSampleScore: 1.5,
      score: 0.9,
      degradation: -0.6,
      status: "ok",
      window: { start: 350, end: 500 },
    },
    topK: [
      {
        trialIndex: 2,
        params: { a: 2, b: "x" },
        inSampleScore: 1.5,
        score: 0.9,
        degradation: -0.6,
        status: "ok",
      },
    ],
    reason: null,
  },
  diagnostics: {
    deflatedSharpe: {
      sharpe: 0.1,
      nTrials: 3,
      sharpeVariance: 0.01,
      nObservations: 350,
      skew: 0,
      kurtosis: 3,
      expectedMaxSharpe: 0.08,
      z: 0.4,
      probability: 0.65,
    },
    deflatedSharpeReason: null,
    pbo: null,
    pboReason: "no returns function supplied",
  },
  notes: " synthetic ",
});

describe("0020 optimization runs migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0020_optimization_runs.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0020_optimization_runs.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  it("is idempotent and matches the drizzle columns, checks and indexes", () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "optimization_runs"'
    );
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(
      /^\s*(GRANT|TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    const config = getTableConfig(optimizationRuns);
    const sqlColumns = [...migration.matchAll(/^\s{2}"([a-z_]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    for (const index of config.indexes) {
      expect(migration).toContain(
        `CREATE INDEX IF NOT EXISTS "${index.config.name}" ON "optimization_runs"`
      );
    }
    for (const check of config.checks) {
      expect(migration).toContain(`CONSTRAINT "${check.name}" CHECK`);
      // The SQL text must equal the drizzle definition (schema and migration cannot drift).
      expect(migration).toContain(dialect.sqlToQuery(check.value).sql);
    }
    expect(migration).toContain(
      'REFERENCES "public"."agent_tasks"("id") ON DELETE cascade'
    );
    return expect(migration).toContain(
      'REFERENCES "public"."strategies"("id") ON DELETE set null'
    );
  });

  it("is journaled as idx 20 after 0019", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0020_optimization_runs"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 20 });
    return expect(journal.entries[index - 1]).toMatchObject({
      idx: 19,
      tag: "0019_strategy_library",
    });
  });

  return it("rollback refuses while rows exist and never cascades", () => {
    expect(rollback).toContain(
      "optimization_runs is not empty; refusing rollback"
    );
    expect(rollback).toContain('DROP TABLE "public"."optimization_runs"');
    return expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});

describe("optimization run normalizer", () => {
  it("accepts the mapped optimizer shape and trims text", () => {
    const normalized = normalizeOptimizationRun(validRun());
    expect(normalized).toMatchObject({
      method: "grid",
      trialCount: 4,
      seed: 7,
      notes: "synthetic",
      paretoFront: [],
      folds: [],
      marketRanking: [],
    });
    expect(normalized.trials[3]).toEqual({
      index: 3,
      params: { a: 2, b: "y" },
      score: null,
      status: "failed",
      reason: "all markets failed",
    });
    expect(normalized.oos?.topK).toHaveLength(1);
    return expect(normalized.diagnostics?.pbo).toBeNull();
  });

  it("enforces counts, bounds and index ranges", () => {
    expect(() =>
      normalizeOptimizationRun({ ...validRun(), trialCount: 3 })
    ).toThrow(/trials must not exceed trialCount|between 0 and 2/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        trials: [trial(0, 1, "x", 1), trial(0, 2, "x", 1)],
      })
    ).toThrow(/index must be unique/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        best: { trialIndex: 9, params: {}, score: 1, metrics: {} },
      })
    ).toThrow(/best.trialIndex must be between 0 and 3/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        markets: Array.from({ length: 41 }, (_, i) => `M${i}`),
      })
    ).toThrow(/markets must not exceed 40/);
    expect(() =>
      normalizeOptimizationRun({ ...validRun(), markets: ["ES", "ES"] })
    ).toThrow(/unique/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        trialCount: 6000,
        trials: Array.from({ length: 5001 }, (_, i) => trial(i, 1, "x", 1)),
      })
    ).toThrow(/trials must not exceed 5000/);
    expect(() =>
      normalizeOptimizationRun({ ...validRun(), seed: 2 ** 60 })
    ).toThrow(/seed must be an integer/);
    return expect(() =>
      normalizeOptimizationRun({ ...validRun(), notes: "x".repeat(4001) })
    ).toThrow(/notes/);
  });

  it("rejects non-finite values, unknown fields and bad shapes", () => {
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        trials: [trial(0, Number.NaN, "x", 1)],
      })
    ).toThrow(/finite/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        trials: [{ ...trial(0, 1, "x", 1), extra: 1 }],
      })
    ).toThrow(/not a recognized field/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        trials: [{ ...trial(0, 1, "x", 1), params: { a: { nested: 1 } } }],
      })
    ).toThrow(/number, boolean, string or null/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        trials: [{ ...trial(0, 1, "x", null), score: 2 }],
      })
    ).toThrow(/null for a failed trial/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        objectives: [{ metric: "sharpe", direction: "up" }],
      })
    ).toThrow(/direction/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        validation: { mode: "is_oos", params: { isFraction: 1.2 } },
      })
    ).toThrow(/isFraction/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        diagnostics: {
          deflatedSharpe: null,
          deflatedSharpeReason: null,
          pbo: null,
          pboReason: "x",
        },
      })
    ).toThrow(/deflatedSharpeReason is required/);
    return expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        diagnostics: {
          ...(validRun().diagnostics as object),
          pbo: {
            pbo: 1.5,
            nTrials: 3,
            nPeriodsUsed: 80,
            nPartitions: 8,
            nCombinations: 70,
            metric: "sharpe",
          },
        },
      })
    ).toThrow(/pbo.pbo must be between 0 and 1/);
  });

  it("enforces the optimizer's method and validation combinations", () => {
    expect(() =>
      normalizeOptimizationRun({ ...validRun(), method: "pareto" })
    ).toThrow(/at least two objectives/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        objectives: [
          { metric: "sharpe", direction: "maximize" },
          { metric: "dd", direction: "minimize" },
        ],
      })
    ).toThrow(/exactly one objective/);
    expect(() =>
      normalizeOptimizationRun({ ...validRun(), method: "market_only" })
    ).toThrow(/single validation only/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        oos: { ...(validRun().oos as object), mode: "walk_forward" },
      })
    ).toThrow(/oos.mode must match/);
    expect(() =>
      normalizeOptimizationRun({
        ...validRun(),
        paretoFront: [{ trialIndex: 0, params: {}, values: { sharpe: 1 } }],
      })
    ).toThrow(/pareto runs only/);
    const single = {
      ...validRun(),
      validation: { mode: "single", params: { nObservations: 500 } },
      diagnostics: null,
    };
    expect(() => normalizeOptimizationRun(single)).toThrow(
      /oos.mode must match/
    );
    const pareto = {
      ...single,
      method: "pareto",
      oos: null,
      best: null,
      objectives: [
        { metric: "sharpe", direction: "maximize" },
        { metric: "dd", direction: "minimize" },
      ],
      trials: [
        {
          index: 0,
          params: { a: 1 },
          score: null,
          status: "ok",
          metrics: { sharpe: 1, dd: 0.2 },
        },
      ],
      trialCount: 1,
      paretoFront: [
        { trialIndex: 0, params: { a: 1 }, values: { sharpe: 1, dd: 0.2 } },
      ],
    };
    expect(normalizeOptimizationRun(pareto).paretoFront).toHaveLength(1);
    expect(() =>
      normalizeOptimizationRun({
        ...pareto,
        paretoFront: [{ trialIndex: 0, params: {}, values: { cagr: 1 } }],
      })
    ).toThrow(/not an objective metric/);
    return expect(() =>
      normalizeOptimizationRun({
        ...pareto,
        best: { trialIndex: 0, params: {}, score: null, metrics: {} },
      })
    ).toThrow(/not a best trial/);
  });

  it("orders walk-forward folds and checks their windows", () => {
    const fold = (
      index: number,
      start: number,
      extra: Record<string, unknown> = {}
    ) => ({
      index,
      train: { start, end: start + 100 },
      test: { start: start + 100, end: start + 150 },
      seed: index,
      stopReason: "budget",
      trialCount: 2,
      bestTrialIndex: 0,
      params: { a: 1, b: "x" },
      oos: null,
      ...extra,
    });
    const walk = {
      ...validRun(),
      validation: {
        mode: "walk_forward",
        params: { nObservations: 500, trainLength: 100, testLength: 50 },
      },
      oos: {
        mode: "walk_forward",
        stitchedScore: 0.4,
        stitchedMetrics: { ES: { sharpe: 0.4 } },
        droppedMarkets: ["NQ"],
        reason: null,
      },
    };
    expect(
      normalizeOptimizationRun({ ...walk, folds: [fold(0, 0), fold(1, 50)] })
        .folds
    ).toHaveLength(2);
    expect(() =>
      normalizeOptimizationRun({ ...walk, folds: [fold(1, 0)] })
    ).toThrow(/index must equal its position/);
    expect(() =>
      normalizeOptimizationRun({ ...walk, folds: [fold(0, 50), fold(1, 0)] })
    ).toThrow(/after the previous fold/);
    expect(() =>
      normalizeOptimizationRun({
        ...walk,
        folds: [fold(0, 0, { test: { start: 50, end: 120 } })],
      })
    ).toThrow(/at or after train ends/);
    expect(() =>
      normalizeOptimizationRun({
        ...walk,
        folds: [fold(0, 0, { params: null })],
      })
    ).toThrow(/both be set or both be null/);
    expect(() =>
      normalizeOptimizationRun({
        ...walk,
        oos: { mode: "walk_forward", droppedMarkets: ["CL"] },
      })
    ).toThrow(/not a run market/);
    return expect(() =>
      normalizeOptimizationRun({ ...validRun(), folds: [fold(0, 0)] })
    ).toThrow(/walk_forward validation only/);
  });

  return it("accepts a market ranking only for market_only runs", () => {
    const ranking = [
      { rank: 1, market: "NQ", status: "ok", value: 1.2 },
      {
        rank: null,
        market: "ES",
        status: "failed",
        value: null,
        reason: "error",
      },
    ];
    const marketOnly = {
      ...validRun(),
      method: "market_only",
      validation: { mode: "single", params: {} },
      oos: null,
      trialCount: 1,
      trials: [trial(0, 1, "x", 1)],
      best: null,
      marketRanking: ranking,
    };
    expect(normalizeOptimizationRun(marketOnly).marketRanking).toHaveLength(2);
    expect(() =>
      normalizeOptimizationRun({ ...validRun(), marketRanking: ranking })
    ).toThrow(/market_only runs only/);
    return expect(() =>
      normalizeOptimizationRun({
        ...marketOnly,
        marketRanking: [
          { rank: 1, market: "ES", status: "failed", value: null },
        ],
      })
    ).toThrow(/must not rank a failed market/);
  });
});

describe("optimization runs repository", () => {
  const dependencies = { now: () => FIXED_NOW, generateId: () => "opt-1" };

  it("normalizes before inserting and maps input errors", async () => {
    const { database, operations } = createDouble([
      [{ id: "opt-1", taskId: "task-1" }],
      [{ name: "HMM" }],
    ]);
    const repository = createOptimizationRunsRepository(database, dependencies);
    const row = await repository.record(validRun());
    expect(row).toMatchObject({ id: "opt-1", strategyName: "HMM" });
    expect(operations[0]!.values).toMatchObject({
      id: "opt-1",
      createdAt: FIXED_NOW,
      notes: "synthetic",
      trialCount: 4,
    });
    return await expect(
      repository.record({ ...validRun(), method: "bayes" })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
  });

  it("maps a missing task (foreign key) to an input error", async () => {
    const foreignKey = Object.assign(new Error("fk"), { code: "23503" });
    const { database } = createDouble([foreignKey]);
    return await expect(
      createOptimizationRunsRepository(database, dependencies).record(
        validRun()
      )
    ).rejects.toThrow(/references a missing record/);
  });

  return it("lists with a strategy join and filters, and gets one row", async () => {
    const { database, operations } = createDouble([
      [{ id: "opt-1", storedTrialCount: 4 }],
      [{ id: "opt-1", strategyName: null }],
      [],
    ]);
    const repository = createOptimizationRunsRepository(database, dependencies);
    expect(await repository.list({ strategyId: "s-1", limit: 5 })).toEqual([
      { id: "opt-1", storedTrialCount: 4 },
    ]);
    expect(operations[0]!.joined).toBe(true);
    expect(dialect.sqlToQuery(operations[0]!.where!).params).toEqual(["s-1"]);
    expect(await repository.get("opt-1")).toEqual({
      id: "opt-1",
      strategyName: null,
    });
    expect(await repository.get("missing")).toBeNull();
    return await expect(repository.list({ limit: 0 })).rejects.toBeInstanceOf(
      InvalidRepositoryInputError
    );
  });
});
