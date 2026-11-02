import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  type AgentModelRun,
  agentModelRunEvents,
  agentModelRuns,
  agentTasks,
} from "../schema/index.ts";
import {
  AGENT_MODEL_RUN_FACETS,
  AgentModelRunClosedError,
  AgentModelRunEventLimitError,
  AgentModelRunInputError,
  AgentModelRunSearchTimeoutError,
  AgentModelRunStateError,
  AgentModelRunStorageError,
  clampLimit,
  createAgentModelRunsRepository,
  decodeModelRunCursor,
  encodeModelRunCursor,
  facetValueSql,
  horizonBucketOf,
  isModelRunClosed,
  isTerminalModelRunStatus,
  mapModelRunWriteError,
  modelRunConditions,
  modelRunSourcesFor,
  resolveRatingSource,
  uniqueValues,
} from "./agent-model-runs.ts";
import type { Database } from "./client.ts";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const dialect = new PgDialect();
const text = (value: SQL | undefined): string =>
  value === undefined ? "" : dialect.sqlToQuery(value).sql;
const params = (value: SQL): unknown[] => dialect.sqlToQuery(value).params;

type Call = [string, unknown[]];
interface Operation {
  kind: string;
  calls: Call[];
}

// Chainable query double: records every builder call and resolves the queued outcome on await.
const createDouble = (outcomes: Array<readonly unknown[] | Error>) => {
  const operations: Operation[] = [];
  const start = (kind: string, args: unknown[]) => {
    const operation: Operation = { calls: [[kind, args]], kind };
    operations.push(operation);
    const chain: object = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "then")
            return (
              resolve: (value: unknown) => unknown,
              reject: (error: unknown) => unknown
            ) => {
              const outcome = outcomes.shift() ?? [];
              return (
                outcome instanceof Error
                  ? Promise.reject(outcome)
                  : Promise.resolve(outcome)
              ).then(resolve, reject);
            };
          if (property === "as") return (name: string) => ({ subquery: name });
          return (...args: unknown[]) => {
            operation.calls.push([String(property), args]);
            return chain;
          };
        },
      }
    );
    return chain;
  };
  const database = {
    transaction: async <T>(work: (transaction: unknown) => Promise<T>) =>
      work(database),
    execute: async (statement: SQL) => {
      operations.push({ calls: [["execute", [statement]]], kind: "execute" });
      return [];
    },
    insert: (...args: unknown[]) => start("insert", args),
    select: (...args: unknown[]) => start("select", args),
    selectDistinct: (...args: unknown[]) => start("selectDistinct", args),
    update: (...args: unknown[]) => start("update", args),
  } as unknown as Database;
  return { database, operations };
};

const argOf = (operation: Operation | undefined, name: string): unknown =>
  operation?.calls.find(([call]) => call === name)?.[1][0];

const run = (overrides: Partial<AgentModelRun> = {}): AgentModelRun => ({
  analysts: [],
  batch: null,
  costUsd: 0,
  createdAt: NOW,
  dataSource: null,
  decisionDate: "2026-09-01",
  durationMs: null,
  entryPrice: null,
  error: null,
  finishedAt: null,
  flags: [],
  framework: "tradingagents",
  frameworkVersion: null,
  horizon: null,
  id: "run-1",
  inputTokens: 0,
  llmCalls: 0,
  memory: false,
  model: "gpt-4o-mini",
  modelsServed: [],
  outputTokens: 0,
  provider: "openai",
  purpose: "live",
  rating: null,
  ratingSource: "missing",
  runKey: "key-1",
  startedAt: null,
  status: "queued",
  stopPrice: null,
  targetPrice: null,
  taskId: null,
  ticker: "AAPL",
  toolCalls: 0,
  updatedAt: NOW,
  variant: null,
  ...overrides,
});

const repositoryFor = (outcomes: Array<readonly unknown[] | Error>) => {
  const double = createDouble(outcomes);
  return {
    ...double,
    repository: createAgentModelRunsRepository(double.database, {
      generateId: () => "run-new",
      now: () => NOW,
    }),
  };
};

const pgError = (code: string) => Object.assign(new Error("pg"), { code });

describe("agent_model_runs schema and migration", () => {
  it("links an agent task with set null and declares the facet indexes", () => {
    const config = getTableConfig(agentModelRuns);
    const [foreignKey] = config.foreignKeys;
    expect(foreignKey?.reference().foreignTable).toBe(agentTasks);
    expect(foreignKey?.onDelete).toBe("set null");
    expect(config.indexes.map((index) => index.config.name)).toContain(
      "agent_model_runs_flags_idx"
    );
    expect(config.checks.map((check) => check.name)).toEqual([
      "agent_model_runs_enum_check",
      "agent_model_runs_text_check",
      "agent_model_runs_numbers_check",
      "agent_model_runs_json_check",
    ]);
  });

  it("is journaled as 0037 and rolls back only an empty table", () => {
    const migration = readFileSync(
      new URL("../../migrations/0037_agent_model_runs.sql", import.meta.url),
      "utf8"
    );
    const rollback = readFileSync(
      new URL("../../rollback/0037_agent_model_runs.down.sql", import.meta.url),
      "utf8"
    );
    const journal = JSON.parse(
      readFileSync(
        new URL("../../migrations/meta/_journal.json", import.meta.url),
        "utf8"
      )
    ) as { entries: { idx: number; tag: string }[] };
    expect(migration).toContain('CREATE TABLE "agent_model_runs"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "agent_model_runs_run_key_idx"'
    );
    expect(migration).toContain("ON DELETE set null");
    expect(
      journal.entries.find((entry) => entry.tag === "0037_agent_model_runs")
    ).toMatchObject({ idx: 37 });
    expect(rollback).toContain(
      "agent_model_runs is not empty; refusing rollback"
    );
    expect(rollback).not.toMatch(/CASCADE/i);
  });
});

describe("model run rules", () => {
  it("buckets horizon text by the largest unit named", () => {
    expect(horizonBucketOf(null)).toBe("unknown");
    expect(horizonBucketOf("next earnings")).toBe("unknown");
    expect(horizonBucketOf("intraday")).toBe("days");
    expect(horizonBucketOf("5d")).toBe("days");
    expect(horizonBucketOf("Short-term")).toBe("days");
    expect(horizonBucketOf("2-4 weeks")).toBe("weeks");
    expect(horizonBucketOf("3W")).toBe("weeks");
    expect(horizonBucketOf("6 months")).toBe("months");
    expect(horizonBucketOf("3m")).toBe("months");
    expect(horizonBucketOf("2 weeks to 3 months")).toBe("months");
    expect(horizonBucketOf("1 year")).toBe("quarters_plus");
    expect(horizonBucketOf("1y")).toBe("quarters_plus");
    expect(horizonBucketOf("next quarter")).toBe("quarters_plus");
    expect(horizonBucketOf("long term")).toBe("quarters_plus");
  });

  it("derives the rating source and never reads a missing rating as hold", () => {
    expect(resolveRatingSource(null, undefined)).toBe("missing");
    expect(resolveRatingSource(null, "missing")).toBe("missing");
    expect(() => resolveRatingSource(null, "stated")).toThrow(
      AgentModelRunInputError
    );
    expect(resolveRatingSource("hold", undefined)).toBe("stated");
    expect(resolveRatingSource("hold", "mapped")).toBe("mapped");
    expect(() => resolveRatingSource("buy", "missing")).toThrow(
      "ratingSource cannot be missing"
    );
  });

  it("moves forward only; a terminal status only repeats", () => {
    expect(modelRunSourcesFor("queued")).toEqual(["queued"]);
    expect(modelRunSourcesFor("running")).toEqual(["queued", "running"]);
    expect(modelRunSourcesFor("failed")).toEqual([
      "queued",
      "running",
      "failed",
    ]);
    expect(isTerminalModelRunStatus("cancelled")).toBe(true);
    expect(isTerminalModelRunStatus("running")).toBe(false);
    expect(new AgentModelRunStateError("succeeded", "running")).toMatchObject({
      from: "succeeded",
      message: "run is succeeded; it cannot move to running",
      to: "running",
    });
  });

  it("round-trips a cursor and rejects a forged one", () => {
    const cursor = encodeModelRunCursor(run());
    expect(decodeModelRunCursor(cursor)).toEqual(["2026-09-01", NOW, "run-1"]);
    const forge = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const bad of [
      "not a cursor!",
      Buffer.from("{").toString("base64url"),
      forge({ a: 1 }),
      forge(["2026-09-01", NOW.toISOString()]),
      forge([1, NOW.toISOString(), "id"]),
      forge(["2026-9-1", NOW.toISOString(), "id"]),
      forge(["2026-09-01", 5, "id"]),
      forge(["2026-09-01", NOW.toISOString(), 5]),
      forge(["2026-09-01", NOW.toISOString(), ""]),
      forge(["2026-09-01", "never", "id"]),
    ])
      expect(() => decodeModelRunCursor(bad)).toThrow("cursor is not valid");
  });

  it("maps database errors once", () => {
    expect(() =>
      mapModelRunWriteError({ cause: pgError("23503") }, "record")
    ).toThrow("taskId does not match an agent task");
    expect(() => mapModelRunWriteError(pgError("23514"), "record")).toThrow(
      AgentModelRunInputError
    );
    expect(() => mapModelRunWriteError(pgError("22003"), "record")).toThrow(
      "run violates a field constraint"
    );
    expect(() => mapModelRunWriteError(pgError("57014"), "update")).toThrow(
      AgentModelRunStorageError
    );
    const bug = new TypeError("bug");
    expect(() => mapModelRunWriteError(bug, "update")).toThrow(bug);
    expect(() => mapModelRunWriteError("text", "update")).toThrow();
    let deep: unknown = pgError("23514");
    for (let depth = 0; depth < 6; depth += 1) deep = { cause: deep };
    let thrown: unknown;
    try {
      mapModelRunWriteError(deep, "update");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(deep);
  });

  it("dedupes values and clamps limits", () => {
    expect(uniqueValues(["a", "b", "a"])).toEqual(["a", "b"]);
    expect(clampLimit(0, 200)).toBe(1);
    expect(clampLimit(5.7, 200)).toBe(5);
    expect(clampLimit(900, 200)).toBe(200);
  });
});

describe("model run filters", () => {
  it("builds no condition for empty filters", () => {
    expect(
      modelRunConditions({ framework: [], rating: [], servedModel: [] })
    ).toEqual([]);
  });

  it("builds every filter and skips the facet being counted", () => {
    const filters = {
      batch: "grid-1",
      decisionFrom: "2026-01-01",
      decisionTo: "2026-12-31",
      flags: ["rerun"],
      framework: ["tradingagents"],
      horizonBucket: ["weeks" as const],
      model: ["m"],
      provider: ["openai"],
      purpose: ["live" as const],
      rating: ["buy" as const, "unrated" as const],
      servedModel: ["served"],
      status: ["failed" as const],
      ticker: ["AAPL"],
      variant: ["v1"],
    };
    const all = modelRunConditions(filters).map(text).join(" | ");
    for (const fragment of [
      '"agent_model_runs"."framework" in',
      '"agent_model_runs"."provider" in',
      '"agent_model_runs"."model" in',
      '"agent_model_runs"."ticker" in',
      '"agent_model_runs"."status" in',
      '"agent_model_runs"."purpose" in',
      '"agent_model_runs"."variant" in',
      '"agent_model_runs"."models_served" @>',
      '"agent_model_runs"."flags" @>',
      '"agent_model_runs"."rating" is null',
      "(case when",
      '"agent_model_runs"."batch" =',
      '"agent_model_runs"."decision_date" >=',
      '"agent_model_runs"."decision_date" <=',
    ])
      expect(all).toContain(fragment);
    expect(modelRunConditions(filters)).toHaveLength(14);
    for (const facet of AGENT_MODEL_RUN_FACETS)
      expect(modelRunConditions(filters, facet)).toHaveLength(13);
    const [served] = modelRunConditions({ servedModel: ["x"] });
    expect(params(served as SQL)).toEqual(['[{"served":"x"}]']);
    const [onlyUnrated] = modelRunConditions({ rating: ["unrated"] });
    expect(text(onlyUnrated)).toBe('"agent_model_runs"."rating" is null');
    const [onlyNamed] = modelRunConditions({ rating: ["sell"] });
    expect(text(onlyNamed)).toBe('"agent_model_runs"."rating" in ($1)');
  });

  it("selects one value per facet", () => {
    expect(text(facetValueSql("servedModel"))).toContain(
      "jsonb_array_elements"
    );
    expect(text(facetValueSql("flags"))).toContain("jsonb_array_elements_text");
    expect(text(facetValueSql("rating"))).toContain("coalesce");
    expect(text(facetValueSql("horizonBucket"))).toContain("~*");
    expect(text(facetValueSql("ticker"))).toBe('"agent_model_runs"."ticker"');
    expect(text(facetValueSql("batch"))).toBe('"agent_model_runs"."batch"');
    expect(modelRunConditions({ batch: "grid-1" }, "batch").map(text)).toEqual(
      []
    );
  });
});

describe("createAgentModelRunsRepository", () => {
  it("reads one run or null", async () => {
    const { repository, operations } = repositoryFor([[run()], []]);
    await expect(repository.get("run-1")).resolves.toEqual(run());
    await expect(repository.get("missing")).resolves.toBeNull();
    expect(argOf(operations[0], "limit")).toBe(1);
  });

  it("records a new run with derived defaults", async () => {
    const created = run({ id: "run-new" });
    const { repository, operations } = repositoryFor([[created]]);
    await expect(
      repository.record({
        analysts: ["market", "market"],
        decisionDate: "2026-09-01",
        flags: ["rerun", "rerun"],
        framework: "tradingagents",
        model: "gpt-4o-mini",
        provider: "openai",
        rating: "buy",
        runKey: "key-1",
        status: "succeeded",
        ticker: "AAPL",
      })
    ).resolves.toEqual({ created: true, run: created });
    expect(argOf(operations[0], "values")).toMatchObject({
      analysts: ["market"],
      finishedAt: NOW,
      flags: ["rerun"],
      id: "run-new",
      purpose: "live",
      ratingSource: "stated",
      startedAt: NOW,
    });
    expect(argOf(operations[0], "onConflictDoNothing")).toEqual({
      target: agentModelRuns.runKey,
    });
  });

  it("records every optional field as given", async () => {
    const { repository, operations } = repositoryFor([[run()]]);
    const startedAt = new Date("2026-09-01T10:00:00.000Z");
    await repository.record({
      analysts: [],
      batch: "grid-1",
      costUsd: 0.5,
      dataSource: "yfinance",
      decisionDate: "2026-09-01",
      durationMs: 1000,
      entryPrice: 10,
      error: null,
      finishedAt: null,
      flags: [],
      framework: "tradingagents",
      frameworkVersion: "0.2.0+abc123",
      horizon: "2 weeks",
      inputTokens: 1,
      llmCalls: 2,
      memory: true,
      model: "m",
      modelsServed: [{ requested: "m", served: "m-1" }],
      outputTokens: 3,
      provider: "openai",
      purpose: "benchmark",
      rating: null,
      runKey: "key-2",
      startedAt,
      status: "running",
      stopPrice: 9,
      targetPrice: 12,
      taskId: "task-1",
      ticker: "AAPL",
      toolCalls: 4,
      variant: "v1",
    });
    expect(argOf(operations[0], "values")).toMatchObject({
      batch: "grid-1",
      finishedAt: null,
      memory: true,
      modelsServed: [{ requested: "m", served: "m-1" }],
      ratingSource: "missing",
      startedAt,
      status: "running",
      taskId: "task-1",
    });
  });

  it("returns the existing run unchanged for a repeated key", async () => {
    const existing = run({ model: "first" });
    const { repository } = repositoryFor([[], [existing]]);
    await expect(
      repository.record({
        decisionDate: "2026-09-01",
        framework: "tradingagents",
        model: "second",
        provider: "openai",
        runKey: "key-1",
        ticker: "AAPL",
      })
    ).resolves.toEqual({ created: false, run: existing });
  });

  it("reports a key that vanished and maps write errors", async () => {
    const input = {
      decisionDate: "2026-09-01",
      framework: "tradingagents",
      model: "m",
      provider: "openai",
      runKey: "key-1",
      ticker: "AAPL",
    };
    await expect(
      repositoryFor([[], []]).repository.record(input)
    ).rejects.toBeInstanceOf(AgentModelRunStorageError);
    await expect(
      repositoryFor([pgError("23503")]).repository.record(input)
    ).rejects.toThrow("taskId does not match an agent task");
  });

  it("pages newest decision first with a keyset cursor", async () => {
    const rows = [run({ id: "c" }), run({ id: "b" }), run({ id: "a" })];
    const first = repositoryFor([rows]);
    const page = await first.repository.list({ filters: {}, limit: 2 });
    expect(page.runs.map((row) => row.id)).toEqual(["c", "b"]);
    expect(page.nextCursor).toBe(
      encodeModelRunCursor(rows[1] as AgentModelRun)
    );
    expect(argOf(first.operations[0], "limit")).toBe(3);
    expect(argOf(first.operations[0], "where")).toBeUndefined();

    const second = repositoryFor([[run({ id: "a" })]]);
    const last = await second.repository.list({
      cursor: page.nextCursor ?? "",
      filters: { ticker: ["AAPL"] },
      limit: 2,
    });
    expect(last).toEqual({ nextCursor: null, runs: [run({ id: "a" })] });
    expect(text(argOf(second.operations[0], "where") as SQL)).toContain(
      '("agent_model_runs"."decision_date", "agent_model_runs"."created_at", "agent_model_runs"."id") <'
    );
    await expect(
      repositoryFor([]).repository.list({ cursor: "!", filters: {}, limit: 1 })
    ).rejects.toBeInstanceOf(AgentModelRunInputError);
  });

  it("counts every facet over the other filters", async () => {
    const outcomes = AGENT_MODEL_RUN_FACETS.map((facet) => [
      { count: 2, value: `${facet}-value` },
    ]);
    const { repository, operations } = repositoryFor(outcomes);
    const facets = await repository.facets({ ticker: ["AAPL"] });
    expect(facets.ticker).toEqual([{ count: 2, value: "ticker-value" }]);
    expect(Object.keys(facets)).toEqual([...AGENT_MODEL_RUN_FACETS]);
    // One inner and one outer select per facet.
    expect(operations).toHaveLength(AGENT_MODEL_RUN_FACETS.length * 2);
    expect(argOf(operations[1], "from")).toEqual({ subquery: "facet" });
    expect(argOf(operations[1], "limit")).toBe(50);
  });

  it("summarizes a breakdown group with hold share", async () => {
    const { repository, operations } = repositoryFor([
      [
        {
          failed: 1,
          holds: 1,
          key: "gpt",
          rated: 2,
          runs: 4,
          totalCostUsd: 2,
        },
        { failed: 0, holds: 0, key: null, rated: 0, runs: 1, totalCostUsd: 0 },
      ],
    ]);
    await expect(repository.breakdown({}, "servedModel")).resolves.toEqual([
      {
        avgCostUsd: 0.5,
        failed: 1,
        holdShare: 0.5,
        key: "gpt",
        rated: 2,
        runs: 4,
        totalCostUsd: 2,
      },
      {
        avgCostUsd: 0,
        failed: 0,
        holdShare: null,
        key: null,
        rated: 0,
        runs: 1,
        totalCostUsd: 0,
      },
    ]);
    expect(operations[0]?.kind).toBe("selectDistinct");
    expect(argOf(operations[1], "limit")).toBe(100);
  });

  it("updates usage, levels and rating without a status change", async () => {
    const updated = run({ costUsd: 1 });
    const { repository, operations } = repositoryFor([[updated]]);
    await expect(
      repository.update({
        costUsd: 1,
        durationMs: 5,
        entryPrice: 10,
        error: "boom",
        finishedAt: null,
        flags: ["rerun", "rerun"],
        horizon: "1w",
        id: "run-1",
        inputTokens: 1,
        llmCalls: 1,
        modelsServed: [{ requested: "a", served: "b" }],
        outputTokens: 1,
        rating: "hold",
        startedAt: NOW,
        stopPrice: 9,
        targetPrice: 11,
        toolCalls: 1,
      })
    ).resolves.toEqual(updated);
    expect(argOf(operations[0], "set")).toEqual({
      costUsd: 1,
      durationMs: 5,
      entryPrice: 10,
      error: "boom",
      finishedAt: null,
      flags: ["rerun"],
      horizon: "1w",
      inputTokens: 1,
      llmCalls: 1,
      modelsServed: [{ requested: "a", served: "b" }],
      outputTokens: 1,
      rating: "hold",
      ratingSource: "stated",
      startedAt: NOW,
      stopPrice: 9,
      targetPrice: 11,
      toolCalls: 1,
      updatedAt: NOW,
    });
    expect(text(argOf(operations[0], "where") as SQL)).toBe(
      '("agent_model_runs"."id" = $1 and "agent_model_runs"."status" in ($2, $3))'
    );
  });

  it("stamps start and finish times on status changes", async () => {
    const running = repositoryFor([[run()]]);
    await running.repository.update({ id: "run-1", status: "running" });
    const runningSet = argOf(running.operations[0], "set") as Record<
      string,
      SQL
    >;
    expect(text(runningSet["startedAt"])).toContain("coalesce");
    expect(runningSet["finishedAt"]).toBeUndefined();
    expect(text(argOf(running.operations[0], "where") as SQL)).toContain(
      '"agent_model_runs"."status" in'
    );

    const done = repositoryFor([[run()]]);
    await done.repository.update({ id: "run-1", status: "succeeded" });
    const doneSet = argOf(done.operations[0], "set") as Record<string, SQL>;
    expect(text(doneSet["finishedAt"])).toContain("coalesce");

    const queued = repositoryFor([[run()]]);
    await queued.repository.update({
      id: "run-1",
      ratingSource: "mapped",
      status: "queued",
    });
    expect(argOf(queued.operations[0], "set")).toEqual({
      ratingSource: "mapped",
      status: "queued",
      updatedAt: NOW,
    });
  });

  it("tells a missing run from a final status", async () => {
    await expect(
      repositoryFor([[], []]).repository.update({
        id: "missing",
        status: "running",
      })
    ).resolves.toBeNull();
    await expect(
      repositoryFor([[], [run()]]).repository.update({
        costUsd: 1,
        id: "run-1",
      })
    ).resolves.toBeNull();
    await expect(
      repositoryFor([[], [run({ status: "failed" })]]).repository.update({
        id: "run-1",
        status: "running",
      })
    ).rejects.toThrow("run is failed; it cannot move to running");
    await expect(
      repositoryFor([pgError("23514")]).repository.update({
        id: "run-1",
        ratingSource: "missing",
      })
    ).rejects.toBeInstanceOf(AgentModelRunInputError);
  });
});

describe("finished runs", () => {
  it("keeps a finish time and lets only rating, source and flags change", async () => {
    const finish = repositoryFor([[run()]]);
    await finish.repository.update({
      finishedAt: null,
      id: "run-1",
      status: "failed",
    });
    const set = argOf(finish.operations[0], "set") as Record<string, SQL>;
    expect(text(set["finishedAt"])).toContain("coalesce");
    const given = new Date("2026-10-01T11:00:00.000Z");
    const explicit = repositoryFor([[run()]]);
    await explicit.repository.update({
      finishedAt: given,
      id: "run-1",
      status: "failed",
    });
    expect(argOf(explicit.operations[0], "set")).toMatchObject({
      finishedAt: given,
    });
    const labels = repositoryFor([[run()]]);
    await labels.repository.update({
      flags: ["rerun"],
      id: "run-1",
      rating: "hold",
    });
    expect(text(argOf(labels.operations[0], "where") as SQL)).not.toContain(
      '"agent_model_runs"."status" in'
    );
    await expect(
      repositoryFor([[], [run({ status: "succeeded" })]]).repository.update({
        costUsd: 2,
        id: "run-1",
      })
    ).rejects.toThrow("only rating, ratingSource and flags can change");
    await expect(
      repositoryFor([[], [run({ status: "succeeded" })]]).repository.update({
        id: "run-1",
        status: "succeeded",
        stopPrice: 1,
      })
    ).rejects.toThrow("only rating, ratingSource and flags can change");
    await expect(
      repositoryFor([[], [run({ status: "running" })]]).repository.update({
        id: "run-1",
        status: "succeeded",
      })
    ).resolves.toBeNull();
  });
});

describe("agent_model_run_events schema and migration", () => {
  it("cascades from the run and indexes the generated search vector", () => {
    const config = getTableConfig(agentModelRunEvents);
    const [foreignKey] = config.foreignKeys;
    expect(foreignKey?.reference().foreignTable).toBe(agentModelRuns);
    expect(foreignKey?.onDelete).toBe("cascade");
    expect(config.indexes.map((index) => index.config.name)).toEqual([
      "agent_model_run_events_run_seq_idx",
      "agent_model_run_events_search_idx",
    ]);
    const migration = readFileSync(
      new URL(
        "../../migrations/0038_agent_model_run_events.sql",
        import.meta.url
      ),
      "utf8"
    );
    expect(migration).toContain("GENERATED ALWAYS AS (to_tsvector(");
    expect(migration).toContain('USING gin ("search")');
    const rollback = readFileSync(
      new URL(
        "../../rollback/0038_agent_model_run_events.down.sql",
        import.meta.url
      ),
      "utf8"
    );
    expect(rollback).toContain(
      "agent_model_run_events is not empty; refusing rollback"
    );
  });
});

describe("model run events", () => {
  const event = {
    agent: "Market Analyst",
    kind: "reasoning" as const,
    seq: 0,
    title: "Reads the chart",
  };
  const running = [{ finishedAt: null, status: "running", updatedAt: NOW }];

  it("appends events, adds flag and redacted slugs once and reports the last seq", async () => {
    const { repository, operations } = repositoryFor([
      running,
      [{ events: 0, lastSeq: null }],
      [
        { kind: "flag", seq: 1, title: "rerun" },
        { kind: "flag", seq: 2, title: "rerun" },
        { kind: "reasoning", seq: 0, title: "x" },
      ],
      [],
      [],
    ]);
    const at = new Date("2026-10-01T11:00:00.000Z");
    await expect(
      repository.appendEvents("run-1", [
        {
          ...event,
          at,
          body: "b",
          costUsd: 0.1,
          durationMs: 5,
          inputTokens: 1,
          model: "m",
          outputTokens: 2,
          redacted: true,
          toolName: "t",
        },
        { ...event, kind: "flag", seq: 1, title: "rerun" },
      ])
    ).resolves.toEqual({ appended: 3, lastSeq: 2 });
    expect(argOf(operations[0], "for")).toBe("update");
    const values = argOf(operations[2], "values") as Record<string, unknown>[];
    expect(values[0]).toEqual({
      agent: "Market Analyst",
      at,
      body: "b",
      costUsd: 0.1,
      durationMs: 5,
      id: "run-new",
      inputTokens: 1,
      kind: "reasoning",
      model: "m",
      outputTokens: 2,
      runId: "run-1",
      seq: 0,
      title: "Reads the chart",
      toolName: "t",
    });
    expect(values[1]).toMatchObject({ at: NOW, body: null, toolName: null });
    expect(argOf(operations[2], "onConflictDoNothing")).toEqual({
      target: [agentModelRunEvents.runId, agentModelRunEvents.seq],
    });
    const updates = operations.filter(
      (operation) => operation.kind === "update"
    );
    expect(
      updates.map((operation) => params(argOf(operation, "where") as SQL)[1])
    ).toEqual(['["rerun"]', '["redacted"]']);
  });

  it("accepts exact retries below the highest seq and refuses new low seqs", async () => {
    const retry = repositoryFor([
      running,
      [{ events: 3, lastSeq: 2 }],
      [{ seq: 1 }],
      [{ kind: "reasoning", seq: 3, title: "x" }],
    ]);
    await expect(
      retry.repository.appendEvents("run-1", [
        { ...event, seq: 1 },
        { ...event, seq: 3 },
      ])
    ).resolves.toEqual({ appended: 1, lastSeq: 3 });
    expect(text(argOf(retry.operations[2], "where") as SQL)).toContain(
      '"agent_model_run_events"."seq" in'
    );
    await expect(
      repositoryFor([
        running,
        [{ events: 3, lastSeq: 7 }],
        [],
      ]).repository.appendEvents("run-1", [{ ...event, seq: 5 }])
    ).rejects.toThrow("seq must increase: the run's highest seq is 7");
    await expect(
      repositoryFor([running, [], []]).repository.appendEvents("run-1", [
        { ...event, seq: 0 },
      ])
    ).resolves.toEqual({ appended: 0, lastSeq: null });
  });

  it("returns null for a missing run and refuses a closed one", async () => {
    await expect(
      repositoryFor([[]]).repository.appendEvents("missing", [event])
    ).resolves.toBeNull();
    const old = new Date(NOW.getTime() - 11 * 60 * 1000);
    await expect(
      repositoryFor([
        [{ finishedAt: old, status: "succeeded", updatedAt: NOW }],
      ]).repository.appendEvents("run-1", [event])
    ).rejects.toBeInstanceOf(AgentModelRunClosedError);
    await expect(
      repositoryFor([
        [{ finishedAt: null, status: "failed", updatedAt: old }],
      ]).repository.appendEvents("run-1", [event])
    ).rejects.toThrow("takes no new events");
    expect(
      isModelRunClosed(
        { finishedAt: NOW, status: "succeeded", updatedAt: NOW },
        NOW
      )
    ).toBe(false);
    expect(
      isModelRunClosed(
        { finishedAt: old, status: "running", updatedAt: old },
        NOW
      )
    ).toBe(false);
  });

  it("maps a rejected insert and rolls back past the event limit", async () => {
    await expect(
      repositoryFor([
        running,
        [{ events: 0, lastSeq: null }],
        pgError("23514"),
      ]).repository.appendEvents("run-1", [event])
    ).rejects.toBeInstanceOf(AgentModelRunInputError);
    await expect(
      repositoryFor([
        running,
        [{ events: 5000, lastSeq: 4999 }],
        [{ kind: "reasoning", seq: 5000, title: "x" }],
      ]).repository.appendEvents("run-1", [{ ...event, seq: 5000 }])
    ).rejects.toBeInstanceOf(AgentModelRunEventLimitError);
  });

  it("pages events after a seq in order", async () => {
    const { repository, operations } = repositoryFor([[{ seq: 3 }]]);
    await expect(repository.events("run-1", 2, 900)).resolves.toEqual([
      { seq: 3 },
    ]);
    expect(argOf(operations[0], "limit")).toBe(500);
    expect(text(argOf(operations[0], "where") as SQL)).toContain(
      '"agent_model_run_events"."seq" >'
    );
    expect(argOf(operations[0], "select")).not.toHaveProperty("search");
  });

  it("searches the newest matching events under a timeout and groups snippets", async () => {
    const empty = repositoryFor([[]]);
    await expect(empty.repository.search("support", {})).resolves.toEqual([]);
    expect(empty.operations[0]?.kind).toBe("execute");
    expect(text(argOf(empty.operations[0], "execute") as SQL)).toBe(
      "set local statement_timeout = 2000"
    );
    expect(argOf(empty.operations[1], "limit")).toBe(5000);

    const { repository, operations } = repositoryFor([
      [
        { ...run({ id: "a" }), rank: 0.5 },
        { ...run({ id: "b" }), rank: 0.2 },
      ],
      [
        { agent: "x", kind: "reasoning", runId: "a", seq: 1, text: "s1" },
        { agent: "y", kind: "decision", runId: "a", seq: 4, text: "s2" },
      ],
    ]);
    await expect(
      repository.search("support", { ticker: ["AAPL"] })
    ).resolves.toEqual([
      {
        rank: 0.5,
        run: run({ id: "a" }),
        snippets: [
          { agent: "x", kind: "reasoning", seq: 1, text: "s1" },
          { agent: "y", kind: "decision", seq: 4, text: "s2" },
        ],
      },
      { rank: 0.2, run: run({ id: "b" }), snippets: [] },
    ]);
    expect(text(argOf(operations[1], "where") as SQL)).toContain(
      "websearch_to_tsquery"
    );
    expect(argOf(operations[2], "limit")).toBe(50);
    expect(argOf(operations[4], "from")).toEqual({ subquery: "ranked" });
    await expect(
      repositoryFor([
        Object.assign(new Error("timeout"), { cause: pgError("57014") }),
      ]).repository.search("x", {})
    ).rejects.toBeInstanceOf(AgentModelRunSearchTimeoutError);
    const bug = new TypeError("bug");
    await expect(repositoryFor([bug]).repository.search("x", {})).rejects.toBe(
      bug
    );
  });
});
