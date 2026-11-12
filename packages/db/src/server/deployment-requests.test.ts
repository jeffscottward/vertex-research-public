import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { deploymentRequests, type StrategyParam } from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  checkDeploymentParamsFit,
  checkDeploymentTransition,
  DEPLOYMENT_MAX_LOSS_PCT_CEILING,
  DEPLOYMENT_OPTION_STRUCTURES,
  deploymentOptionLegs,
  DeploymentRequestInputError,
  DeploymentRequestStateError,
  normalizeDeploymentLimits,
  normalizeDeploymentNote,
  normalizeDeploymentOptions,
  normalizeDeploymentSymbol,
  normalizeDeploymentTimeframe,
  resolveDeploymentParams,
} from "./deployment-requests.ts";
import { createDeploymentRequestsRepository } from "./repositories.ts";
import { InvalidRepositoryInputError } from "./repository-errors.ts";

const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");
const dialect = new PgDialect();

const schema: StrategyParam[] = [
  {
    name: "lookback",
    type: "integer",
    title: "Lookback",
    default: 20,
    min: 5,
    max: 250,
  },
  { name: "threshold", type: "decimal", title: "Threshold", default: 0.5 },
  {
    name: "side",
    type: "choice",
    title: "Side",
    default: "long",
    options: ["long", "short"],
  },
];
const limits = {
  maxOrderSize: 1,
  maxPosition: 2,
  maxOrdersPerMinute: 5,
  dailyLossLimit: 500,
};

const options = {
  structure: "callDebitVertical",
  dte: { target: 45, min: 30 },
  width: { unit: "sigma", value: 1 },
  anchorDelta: 0.5,
  budgetPctOfAccount: 1,
  maxLossPctOfAccount: 2,
};
const optionsMigration = readFileSync(
  new URL(
    "../../migrations/0067_deployment_request_options.sql",
    import.meta.url
  ),
  "utf8"
);

describe("0021 deployment requests migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0021_deployment_requests.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL(
      "../../rollback/0021_deployment_requests.down.sql",
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

  it("is idempotent and matches the drizzle columns, checks, indexes and foreign keys", () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "deployment_requests"'
    );
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(
      /^\s*(GRANT|TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    const config = getTableConfig(deploymentRequests);
    const sqlColumns = [...migration.matchAll(/^\s{2}"([a-z_]+)" /gm)].map(
      (match) => match[1]
    );
    // "options" is added by 0067 (checked in its own block below).
    expect([...sqlColumns].sort()).toEqual(
      config.columns
        .map((column) => column.name)
        .filter((name) => name !== "options")
        .sort()
    );
    for (const index of config.indexes) {
      expect(migration).toContain(
        `CREATE INDEX IF NOT EXISTS "${index.config.name}" ON "deployment_requests"`
      );
    }
    for (const check of config.checks) {
      const source =
        check.name === "deployment_requests_options_check"
          ? optionsMigration
          : migration;
      expect(source).toContain(`CONSTRAINT "${check.name}" CHECK`);
      expect(source).toContain(dialect.sqlToQuery(check.value).sql);
    }
    expect(migration).toContain(
      'FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE restrict'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("preset_id") REFERENCES "public"."strategy_presets"("id") ON DELETE set null'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE restrict'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE restrict'
    );
    expect(migration).toContain(
      `CHECK ("deployment_requests"."mode" = 'paper')`
    );
    return expect(migration).toContain(
      `"deployment_requests"."status" in ('draft', 'requested', 'approved', 'rejected', 'withdrawn')`
    );
  });

  it("is journaled as idx 21 after 0020", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0021_deployment_requests"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 21 });
    return expect(journal.entries[index - 1]).toMatchObject({
      idx: 20,
      tag: "0020_optimization_runs",
    });
  });

  return it("rollback refuses while rows exist and never cascades", () => {
    expect(rollback).toContain(
      "deployment_requests is not empty; refusing rollback"
    );
    expect(rollback).toContain('DROP TABLE "public"."deployment_requests"');
    return expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});

describe("0067 deployment request options migration", () => {
  const rollback = readFileSync(
    new URL(
      "../../rollback/0067_deployment_request_options.down.sql",
      import.meta.url
    ),
    "utf8"
  );

  it("adds a nullable column without a default, idempotently, and leaves mode fixed to paper", () => {
    expect(optionsMigration).toContain(
      'ALTER TABLE "deployment_requests" ADD COLUMN IF NOT EXISTS "options" jsonb;'
    );
    expect(optionsMigration).not.toMatch(
      /"options" jsonb[^;]*(DEFAULT|NOT NULL)/i
    );
    expect(optionsMigration).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployment_requests_options_check'"
    );
    expect(optionsMigration).not.toMatch(
      /^\s*(GRANT|TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    // Comments aside, no statement names the mode column or its check.
    return expect(optionsMigration.replace(/^--.*$/gm, "")).not.toMatch(
      /mode|live/i
    );
  });

  it("repeats the cheap hard rules in the CHECK: object, size, structure and the max-loss ceiling", () => {
    expect(optionsMigration).toContain(
      '"deployment_requests"."options" is null or (case when jsonb_typeof("deployment_requests"."options") = \'object\''
    );
    expect(optionsMigration).toContain(
      'octet_length("deployment_requests"."options"::text) <= 4096'
    );
    expect(optionsMigration).toContain(
      `in (${DEPLOYMENT_OPTION_STRUCTURES.map((name) => `'${name}'`).join(", ")})`
    );
    expect(optionsMigration).toContain(
      `("deployment_requests"."options"->>'maxLossPctOfAccount')::numeric > 0 and ("deployment_requests"."options"->>'maxLossPctOfAccount')::numeric <= ${DEPLOYMENT_MAX_LOSS_PCT_CEILING} else false end`
    );
    const column = getTableConfig(deploymentRequests).columns.find(
      (entry) => entry.name === "options"
    );
    // The drizzle column, once declared, must be nullable without a default like the SQL.
    return expect(column?.notNull ?? false).toBe(false);
  });

  return it("rollback refuses while a row has options, then drops the check and the column", () => {
    expect(rollback).toContain(
      "deployment_requests has rows with options; refusing rollback"
    );
    expect(rollback).toContain(
      'DROP CONSTRAINT IF EXISTS "deployment_requests_options_check"'
    );
    expect(rollback).toContain('DROP COLUMN IF EXISTS "options"');
    expect(rollback.indexOf("DROP CONSTRAINT")).toBeLessThan(
      rollback.indexOf("DROP COLUMN")
    );
    return expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DROP TABLE/i);
  });
});

describe("deployment request options rules", () => {
  const refused = (value: unknown, message: string | RegExp, symbol = "SPY") =>
    expect(() => normalizeDeploymentOptions(value, symbol)).toThrow(message);

  it("keeps the old format valid: no options block normalises to null", () => {
    expect(normalizeDeploymentOptions(undefined, "SPY")).toBeNull();
    return expect(normalizeDeploymentOptions(null, "SPY")).toBeNull();
  });

  it("refuses a max loss above the ceiling and accepts exactly the ceiling", () => {
    expect(DEPLOYMENT_MAX_LOSS_PCT_CEILING).toBe(2);
    refused(
      { ...options, maxLossPctOfAccount: 2.5 },
      "options.maxLossPctOfAccount must be greater than 0 and at most 2"
    );
    refused({ ...options, maxLossPctOfAccount: 2.000_001 }, /at most 2/);
    refused({ ...options, maxLossPctOfAccount: 0 }, /greater than 0/);
    refused({ ...options, maxLossPctOfAccount: "2" }, /must be a number/);
    expect(() => normalizeDeploymentOptions(options, "SPY")).not.toThrow();
    return expect(normalizeDeploymentOptions(options, "SPY")).toEqual({
      ...options,
      legs: [
        { role: "anchor", action: "buy", right: "call" },
        { role: "wing", action: "sell", right: "call" },
      ],
      group: null,
    });
  });

  it("keeps the budget within the max loss", () => {
    refused(
      { ...options, maxLossPctOfAccount: 1, budgetPctOfAccount: 1.5 },
      "options.budgetPctOfAccount must not exceed options.maxLossPctOfAccount"
    );
    refused({ ...options, budgetPctOfAccount: 0 }, /greater than 0/);
    return expect(
      normalizeDeploymentOptions(
        { ...options, maxLossPctOfAccount: 1, budgetPctOfAccount: 1 },
        "SPY"
      )
    ).toMatchObject({ budgetPctOfAccount: 1, maxLossPctOfAccount: 1 });
  });

  it("derives the legs from the structure and refuses legs that disagree", () => {
    expect(deploymentOptionLegs("putDebitVertical")).toEqual([
      { role: "anchor", action: "buy", right: "put" },
      { role: "wing", action: "sell", right: "put" },
    ]);
    expect(deploymentOptionLegs("putCreditVertical")).toEqual([
      { role: "anchor", action: "sell", right: "put" },
      { role: "wing", action: "buy", right: "put" },
    ]);
    expect(deploymentOptionLegs("callCreditVertical")).toEqual([
      { role: "anchor", action: "sell", right: "call" },
      { role: "wing", action: "buy", right: "call" },
    ]);
    for (const structure of DEPLOYMENT_OPTION_STRUCTURES) {
      expect(
        normalizeDeploymentOptions(
          { ...options, structure, legs: deploymentOptionLegs(structure) },
          "SPY"
        )?.legs
      ).toEqual(deploymentOptionLegs(structure));
    }
    // A debit vertical described with the legs of a credit vertical.
    refused(
      { ...options, legs: deploymentOptionLegs("callCreditVertical") },
      "options.legs do not agree with callDebitVertical: the anchor leg must buy a call"
    );
    // The right of one leg differs.
    refused(
      {
        ...options,
        legs: [
          { role: "anchor", action: "buy", right: "call" },
          { role: "wing", action: "sell", right: "put" },
        ],
      },
      "the wing leg must sell a call"
    );
    refused(
      { ...options, legs: [{ role: "anchor", action: "buy", right: "call" }] },
      /exactly the anchor leg and the wing leg/
    );
    return refused(
      {
        ...options,
        legs: [
          { role: "anchor", action: "buy", right: "call", strike: 500 },
          { role: "wing", action: "sell", right: "call" },
        ],
      },
      "options.legs[0].strike is not a recognized field"
    );
  });

  it("checks structure, expiry, width, delta and unknown keys", () => {
    refused(
      { ...options, structure: "ironCondor" },
      /options.structure must be one of/
    );
    refused({ ...options, dte: { target: 45, min: 46 } }, /options.dte.min/);
    refused({ ...options, dte: { target: 0, min: 0 } }, /options.dte.target/);
    refused({ ...options, dte: { target: 45.5, min: 30 } }, /whole number/);
    refused(
      { ...options, dte: { target: 45, min: 30, max: 60 } },
      /options.dte.max/
    );
    refused(
      { ...options, width: 5 },
      "options.width must be an object with unit and value"
    );
    refused(
      { ...options, width: { unit: "sigma", value: 0 } },
      /options.width.value/
    );
    refused(
      { ...options, width: { unit: "sigma", value: 10_000.5 } },
      /options.width.value/
    );
    refused(
      { ...options, width: { unit: "sigma", value: "1" } },
      "options.width.value must be a number"
    );
    refused(
      { ...options, width: { unit: "percent", value: 1 } },
      "options.width.unit must be one of sigma, price"
    );
    refused({ ...options, width: { value: 1 } }, /options.width.unit/);
    refused(
      { ...options, width: { unit: "price", value: 5, strikes: 1 } },
      "options.width.strikes is not a recognized field"
    );
    expect(
      normalizeDeploymentOptions(
        { ...options, width: { unit: "price", value: 10_000 } },
        "SPY"
      )?.width
    ).toEqual({ unit: "price", value: 10_000 });
    refused({ ...options, anchorDelta: 1 }, /options.anchorDelta/);
    refused({ ...options, anchorDelta: 0 }, /options.anchorDelta/);
    refused(
      { ...options, live: true },
      "options.live is not a recognized field"
    );
    refused([], "options must be an object");
    return refused("callDebitVertical", "options must be an object");
  });

  it("applies the group rules: 2 to 16 unique symbols that include the request symbol", () => {
    const group = { key: "grp-1", symbols: ["spy", "QQQ", "IWM"] };
    expect(
      normalizeDeploymentOptions({ ...options, group }, "qqq")?.group
    ).toEqual({ key: "grp-1", symbols: ["SPY", "QQQ", "IWM"] });
    refused(
      { ...options, group: { key: "grp-1", symbols: ["SPY", "spy"] } },
      "options.group.symbols must not repeat a symbol"
    );
    refused(
      { ...options, group: { key: "grp-1", symbols: ["SPY"] } },
      "options.group.symbols must list 2 to 16 symbols"
    );
    refused(
      {
        ...options,
        group: {
          key: "grp-1",
          symbols: Array.from({ length: 17 }, (_, index) => `S${index}`),
        },
      },
      "options.group.symbols must list 2 to 16 symbols"
    );
    refused(
      { ...options, group },
      "options.group.symbols must include the request symbol GLD",
      "GLD"
    );
    refused(
      { ...options, group: { key: "bad key", symbols: ["SPY", "QQQ"] } },
      /options.group.key/
    );
    return refused(
      { ...options, group: { ...group, owner: "x" } },
      "options.group.owner is not a recognized field"
    );
  });

  return it("throws DeploymentRequestInputError", () => {
    return expect(() =>
      normalizeDeploymentOptions({ ...options, maxLossPctOfAccount: 3 }, "SPY")
    ).toThrow(DeploymentRequestInputError);
  });
});

describe("deployment request rules", () => {
  it("normalizes symbol and timeframe", () => {
    expect(normalizeDeploymentSymbol(" mesz5 ")).toBe("MESZ5");
    expect(normalizeDeploymentSymbol("btc/usd")).toBe("BTC/USD");
    expect(() => normalizeDeploymentSymbol("")).toThrow(
      DeploymentRequestInputError
    );
    expect(() => normalizeDeploymentSymbol("ES; drop")).toThrow(
      /symbol must be/
    );
    expect(normalizeDeploymentTimeframe("15m")).toBe("15m");
    expect(() => normalizeDeploymentTimeframe("0m")).toThrow(/timeframe/);
    return expect(() => normalizeDeploymentTimeframe("1y")).toThrow(
      /timeframe/
    );
  });

  it("requires all four positive limits with whole orders per minute", () => {
    expect(normalizeDeploymentLimits(limits)).toEqual(limits);
    for (const key of [
      "maxOrderSize",
      "maxPosition",
      "maxOrdersPerMinute",
      "dailyLossLimit",
    ]) {
      expect(() => normalizeDeploymentLimits({ ...limits, [key]: 0 })).toThrow(
        `limits.${key} must be a number greater than 0`
      );
      const { [key as keyof typeof limits]: _dropped, ...rest } = limits;
      expect(() => normalizeDeploymentLimits(rest)).toThrow(
        `limits.${key} must be a number greater than 0`
      );
    }
    expect(() =>
      normalizeDeploymentLimits({ ...limits, maxOrdersPerMinute: 1.5 })
    ).toThrow(/whole number/);
    expect(() =>
      normalizeDeploymentLimits({ ...limits, maxOrderSize: 3 })
    ).toThrow(/must not exceed limits.maxPosition/);
    expect(() => normalizeDeploymentLimits({ ...limits, leverage: 2 })).toThrow(
      /not a recognized limit/
    );
    return expect(() =>
      normalizeDeploymentLimits({
        ...limits,
        dailyLossLimit: Number.POSITIVE_INFINITY,
      })
    ).toThrow(/dailyLossLimit/);
  });

  it("resolves params from defaults, preset and explicit values against the schema", () => {
    expect(resolveDeploymentParams(schema)).toEqual({
      lookback: 20,
      threshold: 0.5,
      side: "long",
    });
    expect(
      resolveDeploymentParams(schema, { lookback: 50 }, { side: "short" })
    ).toEqual({ lookback: 50, threshold: 0.5, side: "short" });
    expect(() => resolveDeploymentParams(schema, { lookback: 1 })).toThrow(
      "params.lookback must be at least 5"
    );
    expect(() => resolveDeploymentParams(schema, { side: "flat" })).toThrow(
      /params.side must be one of long, short/
    );
    expect(() => resolveDeploymentParams(schema, { leverage: 3 })).toThrow(
      "params.leverage is not a parameter of this strategy"
    );
    expect(() => resolveDeploymentParams(schema, [1])).toThrow(
      "params must be an object"
    );
    return expect(resolveDeploymentParams([], {})).toEqual({});
  });

  it("detects stored params that no longer fit the strategy schema", () => {
    expect(() =>
      checkDeploymentParamsFit(schema, {
        lookback: 20,
        threshold: 0.5,
        side: "long",
      })
    ).not.toThrow();
    expect(() => checkDeploymentParamsFit(schema, { lookback: 20 })).toThrow(
      /missing threshold, side/
    );
    return expect(() => checkDeploymentParamsFit([], { lookback: 20 })).toThrow(
      /not a parameter/
    );
  });

  it("allows only the documented lifecycle transitions", () => {
    expect(checkDeploymentTransition("submit", "draft")).toBe("requested");
    expect(checkDeploymentTransition("approve", "requested")).toBe("approved");
    expect(checkDeploymentTransition("reject", "requested")).toBe("rejected");
    for (const from of ["draft", "requested", "approved"] as const) {
      expect(checkDeploymentTransition("withdraw", from)).toBe("withdrawn");
    }
    expect(() => checkDeploymentTransition("approve", "draft")).toThrow(
      DeploymentRequestStateError
    );
    expect(() => checkDeploymentTransition("submit", "approved")).toThrow(
      "Cannot submit a request that is approved"
    );
    expect(() => checkDeploymentTransition("withdraw", "rejected")).toThrow(
      DeploymentRequestStateError
    );
    return expect(() =>
      checkDeploymentTransition("withdraw", "withdrawn")
    ).toThrow(DeploymentRequestStateError);
  });

  return it("requires a note only when rejecting", () => {
    expect(normalizeDeploymentNote(" ok ", false)).toBe("ok");
    expect(normalizeDeploymentNote(undefined, false)).toBeNull();
    expect(() => normalizeDeploymentNote("  ", true)).toThrow(
      "note is required"
    );
    return expect(() =>
      normalizeDeploymentNote("x".repeat(1001), false)
    ).toThrow(/1000/);
  });
});

type Row = Record<string, unknown>;
interface Operation {
  kind: string;
  locked?: boolean;
  set?: Row;
  values?: Row;
}

// Minimal executor double: each awaited query consumes the next outcome; writes are recorded.
const createDouble = (outcomes: Array<readonly Row[] | Error>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      for: () => {
        operation.locked = true;
        return chain;
      },
      values: (values: Row) => {
        operation.values = values;
        return chain;
      },
      set: (values: Row) => {
        operation.set = values;
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
  const database: Record<string, unknown> = {
    select: () => builder({ kind: "select" }),
    insert: () => builder({ kind: "insert" }),
    update: () => builder({ kind: "update" }),
  };
  database["transaction"] = (
    operation: (transaction: unknown) => Promise<unknown>
  ) => operation(database);
  return { database: database as unknown as Database, operations };
};

const stored = (overrides: Row = {}): Row => ({
  id: "dr-1",
  strategyId: "s-1",
  presetId: null,
  params: { lookback: 20, threshold: 0.5, side: "long" },
  symbol: "ES",
  timeframe: "5m",
  mode: "paper",
  limits,
  status: "draft",
  requestedBy: "user-a",
  requestedAt: null,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
  strategySlug: "hmm",
  strategyName: "HMM",
  presetName: null,
  ...overrides,
});

const repositoryFor = (outcomes: Array<readonly Row[] | Error>) => {
  const double = createDouble(outcomes);
  const repository = createDeploymentRequestsRepository(double.database, {
    now: () => FIXED_NOW,
    generateId: () => "dr-1",
  });
  return { repository, operations: double.operations };
};

describe("deployment requests repository", () => {
  it("creates a paper draft with params resolved from defaults, preset and explicit values", async () => {
    const { repository, operations } = repositoryFor([
      [{ params: schema }],
      [{ values: { lookback: 60 } }],
      [],
      [stored()],
    ]);
    const row = await repository.create({
      strategyId: "s-1",
      presetId: "p-1",
      params: { side: "short" },
      symbol: " es ",
      timeframe: "5m",
      limits,
      requestedBy: "user-a",
    });
    expect(row).toMatchObject({ id: "dr-1", status: "draft" });
    const insert = operations.find((operation) => operation.kind === "insert")!;
    expect(insert.values).toMatchObject({
      strategyId: "s-1",
      presetId: "p-1",
      params: { lookback: 60, threshold: 0.5, side: "short" },
      symbol: "ES",
      timeframe: "5m",
      mode: "paper",
      status: "draft",
      requestedBy: "user-a",
      limits,
    });
    return expect(Object.keys(insert.values!)).not.toContain("requestedAt");
  });

  it("returns null for a missing strategy and refuses a preset of another strategy", async () => {
    expect(
      await repositoryFor([[]]).repository.create({
        strategyId: "s-x",
        symbol: "ES",
        timeframe: "5m",
        limits,
        requestedBy: "user-a",
      })
    ).toBeNull();
    await expect(
      repositoryFor([[{ params: schema }], []]).repository.create({
        strategyId: "s-1",
        presetId: "p-other",
        symbol: "ES",
        timeframe: "5m",
        limits,
        requestedBy: "user-a",
      })
    ).rejects.toThrow("presetId is not a preset of this strategy");
    return await expect(
      repositoryFor([]).repository.create({
        strategyId: "s-1",
        symbol: "ES",
        timeframe: "5m",
        limits: { ...limits, maxPosition: 0 },
        requestedBy: "user-a",
      })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
  });

  it("edits drafts only", async () => {
    const { repository, operations } = repositoryFor([
      [{ status: "draft", strategyId: "s-1" }],
      [{ params: schema }],
      [],
      [stored({ symbol: "NQ" })],
    ]);
    expect(
      await repository.update({
        id: "dr-1",
        symbol: "nq",
        params: { lookback: 30 },
      })
    ).toMatchObject({ symbol: "NQ" });
    expect(
      operations.find((operation) => operation.kind === "update")!.set
    ).toMatchObject({
      symbol: "NQ",
      params: { lookback: 30, threshold: 0.5, side: "long" },
    });
    await expect(
      repositoryFor([
        [{ status: "requested", strategyId: "s-1" }],
      ]).repository.update({ id: "dr-1", symbol: "NQ" })
    ).rejects.toThrow(DeploymentRequestStateError);
    await expect(
      repositoryFor([]).repository.update({ id: "dr-1" })
    ).rejects.toThrow(/at least one field/);
    return expect(
      await repositoryFor([[]]).repository.update({
        id: "missing",
        symbol: "NQ",
      })
    ).toBeNull();
  });

  it("checks an options edit on update: the 2% ceiling holds and null clears the block", async () => {
    const current = [
      { status: "draft", strategyId: "s-1", symbol: "SPY", options: null },
    ];
    const over = repositoryFor([current, [{ params: schema }], []]);
    await expect(
      over.repository.update({
        id: "dr-1",
        options: { ...options, maxLossPctOfAccount: 2.5 },
      })
    ).rejects.toThrow(/at most 2/u);
    expect(
      over.operations.some((operation) => operation.kind === "update")
    ).toBe(false);

    const cleared = repositoryFor([
      [{ ...current[0], options }],
      [{ params: schema }],
      [],
      [stored()],
    ]);
    await cleared.repository.update({ id: "dr-1", options: null });
    expect(
      cleared.operations.find((operation) => operation.kind === "update")!.set
    ).toMatchObject({ options: null });

    const kept = repositoryFor([current, [{ params: schema }], [], [stored()]]);
    await kept.repository.update({ id: "dr-1", options });
    expect(
      kept.operations.find((operation) => operation.kind === "update")!.set
    ).toMatchObject({ options: { maxLossPctOfAccount: 2 } });
  });

  it("submits with a requested timestamp and approves only with the matching slug", async () => {
    const submit = repositoryFor([
      [{ status: "draft", strategyId: "s-1", params: stored()["params"] }],
      [{ slug: "hmm", params: schema }],
      [],
      [stored({ status: "requested" })],
    ]);
    await submit.repository.transition({
      id: "dr-1",
      action: "submit",
      actorId: "user-a",
    });
    expect(
      submit.operations.find((operation) => operation.kind === "update")!.set
    ).toEqual({
      status: "requested",
      updatedAt: FIXED_NOW,
      requestedAt: FIXED_NOW,
    });

    const wrongSlug = repositoryFor([
      [{ status: "requested", strategyId: "s-1", params: stored()["params"] }],
      [{ slug: "hmm", params: schema }],
    ]);
    await expect(
      wrongSlug.repository.transition({
        id: "dr-1",
        action: "approve",
        actorId: "user-a",
        confirmSlug: "jump",
      })
    ).rejects.toThrow("type the strategy slug hmm to approve");
    expect(
      wrongSlug.operations.some((operation) => operation.kind === "update")
    ).toBe(false);

    const approve = repositoryFor([
      [{ status: "requested", strategyId: "s-1", params: stored()["params"] }],
      [{ slug: "hmm", params: schema }],
      [],
      [stored({ status: "approved" })],
    ]);
    await approve.repository.transition({
      id: "dr-1",
      action: "approve",
      actorId: "user-a",
      confirmSlug: " hmm ",
      note: "ok",
    });
    // Only lifecycle columns change; nothing dispatch- or execution-shaped is written.
    return expect(
      approve.operations.find((operation) => operation.kind === "update")!.set
    ).toEqual({
      status: "approved",
      updatedAt: FIXED_NOW,
      decidedBy: "user-a",
      decidedAt: FIXED_NOW,
      decisionNote: "ok",
    });
  });

  return it("rejects with a required note, refuses terminal transitions and stale params", async () => {
    await expect(
      repositoryFor([]).repository.transition({
        id: "dr-1",
        action: "reject",
        actorId: "user-a",
      })
    ).rejects.toThrow("note is required");
    await expect(
      repositoryFor([]).repository.transition({
        id: "dr-1",
        action: "withdraw",
        actorId: "user-a",
        note: "x",
      })
    ).rejects.toThrow(/note applies only/);
    await expect(
      repositoryFor([
        [{ status: "rejected", strategyId: "s-1", params: {} }],
      ]).repository.transition({
        id: "dr-1",
        action: "withdraw",
        actorId: "user-a",
      })
    ).rejects.toThrow("Cannot withdraw a request that is rejected");
    await expect(
      repositoryFor([
        [{ status: "draft", strategyId: "s-1", params: { lookback: 20 } }],
        [{ slug: "hmm", params: schema }],
      ]).repository.transition({
        id: "dr-1",
        action: "submit",
        actorId: "user-a",
      })
    ).rejects.toThrow(/schema changed/);
    return expect(
      await repositoryFor([[]]).repository.transition({
        id: "missing",
        action: "submit",
        actorId: "user-a",
      })
    ).toBeNull();
  });
});

describe("deployment requests repository options", () => {
  it("stores the normalised options block on create and null for the old format", async () => {
    const withOptions = repositoryFor([[{ params: schema }], [], [stored()]]);
    await withOptions.repository.create({
      strategyId: "s-1",
      symbol: "spy",
      timeframe: "1d",
      limits,
      options,
      requestedBy: "user-a",
    });
    expect(
      withOptions.operations.find((operation) => operation.kind === "insert")!
        .values
    ).toMatchObject({
      symbol: "SPY",
      options: {
        ...options,
        legs: deploymentOptionLegs("callDebitVertical"),
        group: null,
      },
    });

    const oldFormat = repositoryFor([[{ params: schema }], [], [stored()]]);
    await oldFormat.repository.create({
      strategyId: "s-1",
      symbol: "ES",
      timeframe: "5m",
      limits,
      requestedBy: "user-a",
    });
    expect(
      oldFormat.operations.find((operation) => operation.kind === "insert")!
        .values
    ).toMatchObject({ options: null });

    const refused = repositoryFor([]);
    await expect(
      refused.repository.create({
        strategyId: "s-1",
        symbol: "SPY",
        timeframe: "1d",
        limits,
        options: { ...options, maxLossPctOfAccount: 2.5 },
        requestedBy: "user-a",
      })
    ).rejects.toThrow(InvalidRepositoryInputError);
    return expect(refused.operations).toEqual([]);
  });

  it("creates one draft per symbol in a single insert and refuses repeated symbols before any query", async () => {
    const group = { key: "grp-1", symbols: ["SPY", "QQQ", "IWM"] };
    const { repository, operations } = repositoryFor([
      [{ params: schema }],
      [],
      [stored({ symbol: "SPY" })],
      [stored({ symbol: "QQQ" })],
      [stored({ symbol: "IWM" })],
    ]);
    const rows = await repository.createGroup({
      strategyId: "s-1",
      symbols: ["spy", "QQQ", "IWM"],
      timeframe: "1d",
      limits,
      options: { ...options, group },
      requestedBy: "user-a",
    });
    expect(rows?.map((row) => row.symbol)).toEqual(["SPY", "QQQ", "IWM"]);
    const inserts = operations.filter(
      (operation) => operation.kind === "insert"
    );
    expect(inserts).toHaveLength(1);
    const values = inserts[0]!.values as unknown as Row[];
    expect(values.map((value) => value["symbol"])).toEqual([
      "SPY",
      "QQQ",
      "IWM",
    ]);
    for (const value of values) {
      expect(value).toMatchObject({
        mode: "paper",
        status: "draft",
        options: { maxLossPctOfAccount: 2, group },
      });
    }

    const duplicate = repositoryFor([]);
    await expect(
      duplicate.repository.createGroup({
        strategyId: "s-1",
        symbols: ["SPY", "spy"],
        timeframe: "1d",
        limits,
        options: {
          ...options,
          group: { key: "grp-1", symbols: ["SPY", "spy"] },
        },
        requestedBy: "user-a",
      })
    ).rejects.toThrow("options.group.symbols must not repeat a symbol");
    expect(duplicate.operations).toEqual([]);

    // The group in the options must be the group being created.
    const mismatch = repositoryFor([]);
    await expect(
      mismatch.repository.createGroup({
        strategyId: "s-1",
        symbols: ["SPY", "QQQ"],
        timeframe: "1d",
        limits,
        options: { ...options, group },
        requestedBy: "user-a",
      })
    ).rejects.toThrow(/exactly the symbols of the group/);
    expect(mismatch.operations).toEqual([]);

    return expect(
      await repositoryFor([[]]).repository.createGroup({
        strategyId: "missing",
        symbols: ["SPY", "QQQ"],
        timeframe: "1d",
        limits,
        options: {
          ...options,
          group: { key: "grp-1", symbols: ["SPY", "QQQ"] },
        },
        requestedBy: "user-a",
      })
    ).toBeNull();
  });

  return it("never approves a stored options block above the ceiling", async () => {
    const { repository, operations } = repositoryFor([
      [
        {
          status: "requested",
          strategyId: "s-1",
          params: { lookback: 20, threshold: 0.5, side: "long" },
          symbol: "SPY",
          options: {
            ...options,
            legs: deploymentOptionLegs("callDebitVertical"),
            group: null,
            maxLossPctOfAccount: 2.5,
            budgetPctOfAccount: 1,
          },
        },
      ],
      [{ slug: "hmm", params: schema }],
    ]);
    await expect(
      repository.transition({
        id: "dr-1",
        action: "approve",
        actorId: "user-b",
        confirmSlug: "hmm",
      })
    ).rejects.toThrow(
      "options.maxLossPctOfAccount must be greater than 0 and at most 2"
    );
    return expect(
      operations.filter((operation) => operation.kind === "update")
    ).toEqual([]);
  });
});
