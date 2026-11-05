import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  backtestResults,
  paperCaptures,
  strategySpecs,
} from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createQuantLabReadRepository,
  QUANT_LAB_CAPTURES_MAX_LISTED,
  QUANT_LAB_STUDIES_MAX_LISTED,
  quantLabBacktestPrefix,
} from "./quant-lab-read.ts";
import { DatabasePersistenceError } from "./repositories.ts";

const NOW = new Date("2026-11-03T10:00:00.000Z");
const dialect = new PgDialect();

interface Operation {
  joins: unknown[];
  kind: "select" | "selectDistinctOn";
  limit?: number;
  table?: unknown;
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
      leftJoin: (table: unknown) => {
        operation.joins.push(table);
        return chain;
      },
      limit: (value: number) => {
        operation.limit = value;
        return chain;
      },
      orderBy: () => chain,
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
      where: (condition: SQL) => {
        operation.where = condition;
        return chain;
      },
    };
    operations.push(operation);
    return chain;
  };
  const database = {
    select: () => builder({ joins: [], kind: "select" }),
    selectDistinctOn: () => builder({ joins: [], kind: "selectDistinctOn" }),
  } as unknown as Database;
  return { database, operations };
};

const paper = {
  id: "paper-ssrn-2242795",
  identifier: "10.2139/ssrn.2242795",
  sourceUrl: "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2242795",
  stage: "backtested",
  title: "The Real-Life Performance of Market Timing",
  verdict: "inconclusive",
};

const specRow = (overrides: Record<string, unknown> = {}) => ({
  createdAt: NOW,
  hypothesis: "A 10-month SMA cuts drawdown.",
  id: "spec-7eb540a22b92aaaa",
  name: "SMA timing",
  ourReading: { gaps: ["No full text"], interpretation: "Faber form" },
  paper,
  paperClaims: [{ locator: "abstract", quote: "highly overstated" }],
  specKey: "zakamulin-2013-sma-timing",
  specSha256: "7".repeat(64),
  strategy: {
    id: "strategy-quantlab-zakamulin-2013-sma-timing",
    slug: "quantlab-zakamulin-2013-sma-timing",
    status: "backtested",
  },
  ...overrides,
});

const backtestRow = (overrides: Record<string, unknown> = {}) => ({
  createdAt: NOW,
  id: "bt-quantlab-7eb540a22b92-aaaaaaaaaaaa",
  instruments: "SPY",
  maxDrawdown: -0.2428,
  metrics: { bh_sharpe: 0.5696, wf_sharpe: 0.6354 },
  notes: "Quant Lab verdict: inconclusive\nPASS a: b",
  periodEnd: "2026-10-16",
  periodStart: "2003-10-01",
  ...overrides,
});

const captureRow = {
  capturedAt: NOW,
  doi: "10.2139/ssrn.2242795",
  id: "capture-0123456789abcdef",
  pdfStatus: "metadata_only:no_open_access_copy",
  ssrnId: "2242795",
  title: "The Real-Life Performance of Market Timing",
  topic: "market timing",
  url: "https://doi.org/10.2139/ssrn.2242795",
  version: "2013-04-01T00:00:00Z",
};

describe("quant lab read repository", () => {
  it("joins each spec to its paper, strategy and the newest backtest of that exact spec", async () => {
    const shared = specRow().strategy;
    const double = createDouble([
      [
        specRow(),
        specRow({ id: "spec-b", paper: null, specSha256: "8".repeat(64) }),
        specRow({ id: "spec-c", specSha256: "9".repeat(64), strategy: null }),
      ],
      [
        backtestRow({ prefix: "bt-quantlab-777777777777-" }),
        backtestRow({
          id: "bt-quantlab-888888888888-bbbbbbbbbbbb",
          prefix: "bt-quantlab-888888888888-",
        }),
      ],
      [captureRow],
    ]);
    const model = await createQuantLabReadRepository(double.database).list();

    expect(model.studies[0]).toEqual({ ...specRow(), backtest: backtestRow() });
    expect(model.studies[1]).toMatchObject({
      backtest: { id: "bt-quantlab-888888888888-bbbbbbbbbbbb" },
      paper: null,
      strategy: shared,
    });
    expect(model.studies[2]).toMatchObject({ backtest: null, strategy: null });
    expect(model.captures).toEqual([captureRow]);

    const [specs, backtests, captures] = double.operations;
    expect(specs).toMatchObject({
      joins: [expect.anything(), expect.anything()],
      kind: "select",
      limit: QUANT_LAB_STUDIES_MAX_LISTED,
      table: strategySpecs,
    });
    expect(backtests).toMatchObject({
      kind: "selectDistinctOn",
      table: backtestResults,
    });
    const where = dialect.sqlToQuery(backtests?.where as SQL);
    expect(where.sql).toBe('left("backtest_results"."id", 25) in ($1, $2, $3)');
    expect(where.params).toEqual([
      "bt-quantlab-777777777777-",
      "bt-quantlab-888888888888-",
      "bt-quantlab-999999999999-",
    ]);
    return expect(captures).toMatchObject({
      kind: "select",
      limit: QUANT_LAB_CAPTURES_MAX_LISTED,
      table: paperCaptures,
    });
  });

  it("builds the backtest id prefix from the spec hash", () =>
    expect(quantLabBacktestPrefix(`7eb540a22b92${"0".repeat(52)}`)).toBe(
      "bt-quantlab-7eb540a22b92-"
    ));

  it("skips the backtest query when there are no specs", async () => {
    const double = createDouble([[], []]);
    const model = await createQuantLabReadRepository(double.database).list();
    expect(model).toEqual({ captures: [], studies: [] });
    return expect(double.operations.map((op) => op.kind)).toEqual([
      "select",
      "select",
    ]);
  });

  it("maps database failures and rethrows other errors", async () => {
    const pgError = Object.assign(new Error("pg"), { code: "42P01" });
    await expect(
      createQuantLabReadRepository(createDouble([pgError]).database).list()
    ).rejects.toBeInstanceOf(DatabasePersistenceError);
    const other = new Error("bug");
    return expect(
      createQuantLabReadRepository(createDouble([other]).database).list()
    ).rejects.toBe(other);
  });
});
