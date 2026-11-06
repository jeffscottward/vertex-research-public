import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { backtestResults, researchPapers } from "../schema/index.ts";
import {
  deriveBacktestDrawdown,
  maxBacktestDrawdown,
  normalizeBacktestResult,
} from "./backtest-results.ts";
import type { Database } from "./client.ts";
import {
  createBacktestResultsRepository,
  createResearchPapersRepository,
} from "./repositories.ts";
import { InvalidRepositoryInputError } from "./repository-errors.ts";

const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");
const dialect = new PgDialect();

interface Operation {
  kind: string;
  table?: unknown;
  values?: Record<string, unknown>;
  where?: SQL;
}

// Chainable query double: records each operation and resolves the queued outcome.
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

describe("0018 backtest run config migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0018_backtest_run_config.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL(
      "../../rollback/0018_backtest_run_config.down.sql",
      import.meta.url
    ),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  it("adds nullable columns idempotently and is journaled after 0017", () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "run_config" jsonb;');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "benchmark" jsonb;');
    expect(migration).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backtest_results_extras_check')"
    );
    expect(migration).not.toMatch(
      /NOT NULL|DROP |^\s*(GRANT|TRUNCATE|UPDATE|DELETE|INSERT)\s/im
    );
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0018_backtest_run_config"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 18 });
    return expect(journal.entries[index - 1]).toMatchObject({
      idx: 17,
      tag: "0017_backtest_results",
    });
  });

  return it("rollback refuses while extras exist and drops only its own objects", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain(
      'WHERE "run_config" IS NOT NULL OR "benchmark" IS NOT NULL'
    );
    return expect(rollback).not.toMatch(/CASCADE|DROP TABLE/i);
  });
});

describe("0036 backtest rating series migration", () => {
  const migration = readFileSync(
    new URL(
      "../../migrations/0036_backtest_rating_series.sql",
      import.meta.url
    ),
    "utf8"
  );
  const rollback = readFileSync(
    new URL(
      "../../rollback/0036_backtest_rating_series.down.sql",
      import.meta.url
    ),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  it("adds a nullable bounded object column idempotently and is journaled after 0033", () => {
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "rating_series" jsonb;'
    );
    expect(migration).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backtest_results_rating_series_check')"
    );
    expect(migration).toContain(
      `jsonb_typeof("backtest_results"."rating_series") = 'object' and octet_length("backtest_results"."rating_series"::text) <= 65536`
    );
    expect(migration).not.toMatch(
      /NOT NULL|DROP |^\s*(GRANT|TRUNCATE|UPDATE|DELETE|INSERT)\s/im
    );
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0036_backtest_rating_series"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 36 });
    return expect(journal.entries[index - 1]).toMatchObject({
      idx: 35,
      tag: "0035_strategy_catalog_sma30_timing",
    });
  });

  return it("rollback refuses while rating series exist and drops only its own objects", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain('WHERE "rating_series" IS NOT NULL');
    expect(rollback).toContain(
      'DROP CONSTRAINT "backtest_results_rating_series_check"'
    );
    return expect(rollback).not.toMatch(/CASCADE|DROP TABLE/i);
  });
});

describe("0017 backtest results migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0017_backtest_results.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0017_backtest_results.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };
  const followUp = [
    readFileSync(
      new URL("../../migrations/0018_backtest_run_config.sql", import.meta.url),
      "utf8"
    ),
    readFileSync(
      new URL("../../migrations/0019_strategy_library.sql", import.meta.url),
      "utf8"
    ),
    readFileSync(
      new URL(
        "../../migrations/0036_backtest_rating_series.sql",
        import.meta.url
      ),
      "utf8"
    ),
  ].join("\n");

  it("is idempotent and matches the drizzle columns, checks and indexes", () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "backtest_results"'
    );
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(
      /^\s*(GRANT|TRUNCATE|UPDATE|DELETE|INSERT)\s/im
    );
    const config = getTableConfig(backtestResults);
    const sqlColumns = [
      ...[...migration.matchAll(/^\s{2}"([a-z_]+)" /gm)].map(
        (match) => match[1]
      ),
      ...[...followUp.matchAll(/ADD COLUMN IF NOT EXISTS "([a-z_]+)"/g)].map(
        (match) => match[1]
      ),
    ];
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    for (const index of config.indexes) {
      expect(`${migration}\n${followUp}`).toContain(
        `CREATE INDEX IF NOT EXISTS "${index.config.name}" ON "backtest_results"`
      );
    }
    for (const check of config.checks) {
      expect(`${migration}\n${followUp}`).toContain(
        `CONSTRAINT "${check.name}" CHECK`
      );
    }
    expect(migration).toContain(
      'REFERENCES "public"."agent_tasks"("id") ON DELETE cascade'
    );
    return expect(migration).toContain(
      'REFERENCES "public"."research_papers"("id") ON DELETE set null'
    );
  });

  it("is journaled as idx 17 after 0016", () => {
    const index = journal.entries.findIndex(
      (entry: { tag: string }) => entry.tag === "0017_backtest_results"
    );
    expect(journal.entries[index]).toMatchObject({
      idx: 17,
      tag: "0017_backtest_results",
    });
    return expect(journal.entries[index - 1]).toMatchObject({
      idx: 16,
      tag: "0016_agent_api_keys",
    });
  });

  return it("rollback refuses while rows exist and never cascades", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain('DROP TABLE "public"."backtest_results"');
    return expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});

describe("backtest normalization", () => {
  it("derives drawdown against the running peak", () => {
    const drawdown = deriveBacktestDrawdown([
      { t: "2020-01-01", equity: 100 },
      { t: "2020-01-02", equity: 80 },
      { t: "2020-01-03", equity: 120 },
      { t: "2020-01-04", equity: 90 },
    ]);
    expect(drawdown.map((point) => Number(point.drawdown.toFixed(12)))).toEqual(
      [0, -0.2, 0, -0.25]
    );
    expect(maxBacktestDrawdown(drawdown)).toBe(-0.25);
    return expect(maxBacktestDrawdown([])).toBeNull();
  });

  it("enforces bounds, finiteness and order", () => {
    const base = {
      taskId: "t",
      strategy: "s",
      instruments: "SPY",
      periodStart: "2020-01-01",
      periodEnd: "2020-12-31",
      dataSource: "fixture",
    };
    expect(normalizeBacktestResult(base)).toMatchObject({
      equity: [],
      drawdown: [],
      maxDrawdown: null,
      tradeCount: 0,
      isSplit: null,
    });
    expect(() =>
      normalizeBacktestResult({ ...base, periodEnd: "2019-12-31" })
    ).toThrow(/periodEnd/);
    expect(() =>
      normalizeBacktestResult({
        ...base,
        metrics: { sharpe: Number.POSITIVE_INFINITY },
      })
    ).toThrow(/finite/);
    expect(() =>
      normalizeBacktestResult({ ...base, metrics: { nested: { a: 1 } } })
    ).toThrow(/finite number or a string/);
    expect(() =>
      normalizeBacktestResult({
        ...base,
        equity: [
          { t: "2020-01-02", equity: 1 },
          { t: "2020-01-01", equity: 1 },
        ],
      })
    ).toThrow(/after the previous/);
    expect(() =>
      normalizeBacktestResult({
        ...base,
        trades: Array.from({ length: 2001 }, () => ({})),
      })
    ).toThrow(/2000/);
    expect(() =>
      normalizeBacktestResult({
        ...base,
        trades: [
          {
            entry_t: "2020-01-02",
            exit_t: "2020-01-01",
            side: "long",
            qty: 1,
            entry_px: 1,
            exit_px: 1,
            pnl: 0,
          },
        ],
      })
    ).toThrow(/exit_t/);
    expect(() =>
      normalizeBacktestResult({
        ...base,
        trades: [
          {
            entry_t: "2020-01-01",
            exit_t: "2020-01-02",
            side: "flat",
            qty: 1,
            entry_px: 1,
            exit_px: 1,
            pnl: 0,
          },
        ],
      })
    ).toThrow(/side/);
    return expect(() =>
      normalizeBacktestResult({
        ...base,
        isSplit: {
          in_sample: { start: "2020-01-01", end: "2020-06-01" },
          out_of_sample: { start: "2020-05-01", end: "2020-12-31" },
        },
      })
    ).toThrow(/out_of_sample/);
  });

  it("keeps optional trade fields, run config and benchmark, and rejects invalid ones", () => {
    const base = {
      taskId: "t",
      strategy: "s",
      instruments: "ES",
      periodStart: "2020-01-01",
      periodEnd: "2020-12-31",
      dataSource: "fixture",
    };
    const trade = {
      entry_t: "2020-01-02",
      exit_t: "2020-01-03",
      side: "long",
      qty: 1,
      entry_px: 10,
      exit_px: 11,
      pnl: 1,
    };
    const normalized = normalizeBacktestResult({
      ...base,
      trades: [
        {
          ...trade,
          sl: 9,
          tp: 12,
          commission: 0.5,
          regime: " bull ",
          symbol: "ES",
        },
      ],
      runConfig: {
        initialCapital: 10_000,
        commissionPerContract: 0.5,
        slippagePercent: 0.01,
        timeframe: "15m",
        fillModel: "tick",
      },
      benchmark: {
        label: "SPY",
        points: [
          { t: "2020-01-01", equity: 300 },
          { t: "2020-01-02", equity: 301 },
        ],
      },
    });
    expect(normalized.trades[0]).toEqual({
      ...trade,
      sl: 9,
      tp: 12,
      commission: 0.5,
      regime: "bull",
      symbol: "ES",
    });
    expect(normalized.runConfig).toEqual({
      initialCapital: 10_000,
      commissionPerContract: 0.5,
      slippagePercent: 0.01,
      timeframe: "15m",
      fillModel: "tick",
    });
    expect(normalized.benchmark?.points).toHaveLength(2);
    expect(
      normalizeBacktestResult({ ...base, trades: [{ ...trade, sl: null }] })
        .trades[0]
    ).toEqual(trade);
    expect(
      normalizeBacktestResult({ ...base, runConfig: {} }).runConfig
    ).toBeNull();
    expect(() =>
      normalizeBacktestResult({
        ...base,
        trades: [{ ...trade, commission: -1 }],
      })
    ).toThrow(/commission/);
    expect(() =>
      normalizeBacktestResult({ ...base, runConfig: { fillModel: "daily" } })
    ).toThrow(/fillModel/);
    expect(() =>
      normalizeBacktestResult({ ...base, runConfig: { initialCapital: 0 } })
    ).toThrow(/initialCapital/);
    expect(() =>
      normalizeBacktestResult({ ...base, runConfig: { broker: "x" } })
    ).toThrow(/not a recognized field/);
    return expect(() =>
      normalizeBacktestResult({
        ...base,
        benchmark: { label: "SPY", points: [] },
      })
    ).toThrow(/benchmark/);
  });

  return it("keeps a rating series with defaults and rejects malformed ones", () => {
    const base = {
      dataSource: "fixture",
      instruments: "SPY",
      periodEnd: "2020-12-31",
      periodStart: "2020-01-01",
      strategy: "s",
      taskId: "t",
    };
    const decisions = [
      { date: "2020-01-02", rating: "buy", runId: "run-1" },
      { date: "2020-01-03", rating: null, runId: null },
      { date: "2020-01-06", rating: "sell" },
    ];
    expect(normalizeBacktestResult(base).ratingSeries).toBeNull();
    expect(
      normalizeBacktestResult({
        ...base,
        ratingSeries: { decisions, symbol: " SPY " },
      }).ratingSeries
    ).toEqual({
      costBps: 10,
      decisions: [
        { date: "2020-01-02", rating: "buy", runId: "run-1" },
        { date: "2020-01-03", rating: null },
        { date: "2020-01-06", rating: "sell" },
      ],
      symbol: "SPY",
      timeframe: "1d",
    });
    expect(
      normalizeBacktestResult({
        ...base,
        ratingSeries: {
          costBps: 0,
          decisions: [{ date: "2020-01-02" }, decisions[2]],
          symbol: "SPY",
          timeframe: "1d",
        },
      }).ratingSeries?.decisions[0]
    ).toEqual({ date: "2020-01-02", rating: null });
    const series = (overrides: Record<string, unknown>) => () =>
      normalizeBacktestResult({
        ...base,
        ratingSeries: { decisions, symbol: "SPY", ...overrides },
      });
    expect(() =>
      normalizeBacktestResult({ ...base, ratingSeries: [] })
    ).toThrow(/ratingSeries must be an object/);
    expect(series({ broker: "x" })).toThrow(/not a recognized field/);
    expect(series({ timeframe: "1m" })).toThrow(/timeframe must be 1d/);
    expect(series({ costBps: 501 })).toThrow(/costBps/);
    expect(series({ costBps: -1 })).toThrow(/costBps/);
    expect(series({ costBps: Number.NaN })).toThrow(/finite/);
    expect(series({ decisions: decisions.slice(0, 1) })).toThrow(
      /2 to 520 decisions/
    );
    expect(series({ decisions: "x" })).toThrow(/2 to 520 decisions/);
    expect(
      series({
        decisions: Array.from({ length: 521 }, (_, index) => ({
          date: `2020-01-${String((index % 28) + 1).padStart(2, "0")}`,
          rating: "hold",
        })),
      })
    ).toThrow(/2 to 520 decisions/);
    expect(series({ decisions: [decisions[0], decisions[0]] })).toThrow(
      /strictly increasing/
    );
    expect(series({ decisions: [decisions[0], "x"] })).toThrow(
      /decisions\[1\] must be an object/
    );
    expect(
      series({ decisions: [decisions[0], { date: "2020-02-03", order: 1 }] })
    ).toThrow(/not a recognized field/);
    expect(
      series({
        decisions: [decisions[0], { date: "2020-02-03", rating: "strong buy" }],
      })
    ).toThrow(/rating must be buy/);
    expect(
      series({
        decisions: [decisions[0], { date: "2020-02-31", rating: "buy" }],
      })
    ).toThrow(/calendar date/);
    expect(
      series({
        decisions: [
          decisions[0],
          { date: "2020-02-03", rating: "buy", runId: "x".repeat(41) },
        ],
      })
    ).toThrow(/runId/);
    expect(
      series({
        decisions: [
          decisions[0],
          { date: "2020-02-03", rating: "buy", runId: 7 },
        ],
      })
    ).toThrow(/runId/);
    return expect(series({ symbol: " " })).toThrow(/symbol must not be blank/);
  });
});

describe("backtest results repository", () => {
  const draft = {
    taskId: "task-1",
    strategy: "s",
    instruments: "SPY",
    periodStart: "2020-01-01",
    periodEnd: "2020-12-31",
    dataSource: "fixture",
    equity: [
      { t: "2020-01-01", equity: 100 },
      { t: "2020-01-02", equity: 50 },
    ],
  };

  it("inserts server-derived drawdown and counts", async () => {
    const double = createDouble([[{ id: "bt-gen" }]]);
    const repository = createBacktestResultsRepository(double.database, {
      now: () => FIXED_NOW,
      generateId: () => "bt-gen",
    });
    await repository.record(draft);
    const insert = double.operations[0]!;
    expect(insert.table).toBe(backtestResults);
    return expect(insert.values).toMatchObject({
      id: "bt-gen",
      drawdown: [
        { t: "2020-01-01", drawdown: 0 },
        { t: "2020-01-02", drawdown: -0.5 },
      ],
      maxDrawdown: -0.5,
      tradeCount: 0,
      createdAt: FIXED_NOW,
    });
  });

  it("maps validation failures and a missing task to InvalidRepositoryInputError", async () => {
    const repository = createBacktestResultsRepository(
      createDouble([]).database
    );
    await expect(
      repository.record({ ...draft, equity: [{ t: "2020-01-01", equity: -1 }] })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    const fk = createDouble([
      new DrizzleQueryError(
        "query",
        [],
        Object.assign(new Error("pg"), { code: "23503" })
      ),
    ]);
    return await expect(
      createBacktestResultsRepository(fk.database).record(draft)
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
  });

  it("reads the trial ledger of a strategy and maps database failures", async () => {
    const double = createDouble([
      [{ total: 3 }],
      [
        {
          id: "bt-2",
          stats: {
            returns: 2,
            mean: 0.02,
            sd: 0,
            firstT: "2024-01-01",
            lastT: "2024-01-03",
          },
        },
      ],
    ]);
    const repository = createBacktestResultsRepository(double.database);
    const ledger = await repository.trialLedger({
      id: "bt-1",
      strategyId: "strategy-1",
      taskId: "task-1",
    });
    expect(ledger).toEqual({
      scope: "strategy",
      key: "strategy-1",
      total: 3,
      others: [
        {
          id: "bt-2",
          returns: 2,
          meanReturn: 0.02,
          stdReturn: 0,
          firstT: "2024-01-01",
          lastT: "2024-01-03",
        },
      ],
    });
    expect(dialect.sqlToQuery(double.operations[0]!.where!).params).toEqual([
      "strategy-1",
    ]);
    expect(dialect.sqlToQuery(double.operations[1]!.where!).params).toEqual([
      "strategy-1",
      "bt-1",
    ]);
    const byTask = createDouble([[{ total: 1 }], []]);
    await expect(
      createBacktestResultsRepository(byTask.database).trialLedger({
        id: "bt-1",
        strategyId: null,
        taskId: "task-1",
      })
    ).resolves.toEqual({ scope: "task", key: "task-1", total: 1, others: [] });
    expect(dialect.sqlToQuery(byTask.operations[0]!.where!).params).toEqual([
      "task-1",
    ]);
    const failing = createDouble([
      new DrizzleQueryError(
        "query",
        [],
        Object.assign(new Error("pg"), { code: "57014" })
      ),
    ]);
    return await expect(
      createBacktestResultsRepository(failing.database).trialLedger({
        id: "bt-1",
        strategyId: null,
        taskId: "task-1",
      })
    ).rejects.toThrow("backtest trial ledger read");
  });

  return it("matches arXiv identifiers exactly or by version suffix only", async () => {
    const double = createDouble([[]]);
    await createResearchPapersRepository(double.database).findByArxivId(
      "2402.05272"
    );
    expect(double.operations[0]!.table).toBe(researchPapers);
    const query = dialect.sqlToQuery(double.operations[0]!.where!);
    expect(query.params).toEqual([
      "arXiv:2402.05272",
      "^arXiv:2402\\.05272v[0-9]+$",
    ]);
    return await expect(
      createResearchPapersRepository(double.database).findByArxivId(
        "2402.05272%"
      )
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
  });
});
