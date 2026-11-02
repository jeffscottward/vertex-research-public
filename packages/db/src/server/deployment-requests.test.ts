import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { deploymentRequests, type StrategyParam } from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  checkDeploymentParamsFit,
  checkDeploymentTransition,
  DeploymentRequestInputError,
  DeploymentRequestStateError,
  normalizeDeploymentLimits,
  normalizeDeploymentNote,
  normalizeDeploymentSymbol,
  normalizeDeploymentTimeframe,
  resolveDeploymentParams,
} from "./deployment-requests.ts";
import {
  createDeploymentRequestsRepository,
  InvalidRepositoryInputError,
} from "./repositories.ts";

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
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    for (const index of config.indexes) {
      expect(migration).toContain(
        `CREATE INDEX IF NOT EXISTS "${index.config.name}" ON "deployment_requests"`
      );
    }
    for (const check of config.checks) {
      expect(migration).toContain(`CONSTRAINT "${check.name}" CHECK`);
      expect(migration).toContain(dialect.sqlToQuery(check.value).sql);
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
