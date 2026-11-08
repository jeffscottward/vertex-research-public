import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  flowBook,
  flowEvents,
  flowGex,
  flowMinutes,
  flowOptionGaps,
  flowOptionPrints,
  flowSamples,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  createFlowRepository,
  FLOW_UPSERT_BATCH,
  type FlowBookRecord,
  type FlowEventRecord,
  type FlowGexRecord,
  type FlowMinuteRecord,
  type FlowOptionPrintRecord,
  type FlowSampleRecord,
} from "./flow.ts";

const dialect = new PgDialect();
const FROM = new Date("2026-11-02T14:30:00.000Z");
const TO = new Date("2026-11-02T15:30:00.000Z");

interface Operation {
  columns?: unknown;
  conflict?: "nothing" | Record<string, unknown>;
  kind: "select" | "insert" | "delete";
  limit?: number;
  orderBy?: unknown[];
  returning?: unknown;
  table?: unknown;
  values?: unknown;
  where?: SQL;
}

type Rows = readonly Record<string, unknown>[];

// Chainable query double: records each operation and resolves the queued rows.
// An outcome function receives the operation, so batch sizes can echo back.
const createDouble = (
  outcomes: Array<Rows | ((operation: Operation) => Rows)>
) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    operations.push(operation);
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      limit: (count: number) => {
        operation.limit = count;
        return chain;
      },
      onConflictDoNothing: () => {
        operation.conflict = "nothing";
        return chain;
      },
      onConflictDoUpdate: (config: Record<string, unknown>) => {
        operation.conflict = config;
        return chain;
      },
      orderBy: (...order: unknown[]) => {
        operation.orderBy = order;
        return chain;
      },
      returning: (columns: unknown) => {
        operation.returning = columns;
        return chain;
      },
      then: (resolve: (rows: unknown) => unknown) => {
        const next = outcomes.shift() ?? [];
        return Promise.resolve(
          typeof next === "function" ? next(operation) : next
        ).then(resolve);
      },
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      where: (condition: SQL) => {
        operation.where = condition;
        return chain;
      },
    };
    return chain;
  };
  const database = {
    delete: (table: unknown) => builder({ kind: "delete", table }),
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: (columns?: unknown) => builder({ columns, kind: "select" }),
  } as unknown as DatabaseExecutor;
  return { database, operations };
};

const whereOf = (operation: Operation | undefined) => {
  if (operation?.where === undefined) throw new Error("no where clause");
  return dialect.sqlToQuery(operation.where);
};

const echo = (operation: Operation): Rows =>
  (operation.values as Rows).map(() => ({}));

const rows = <T>(count: number, make: (index: number) => unknown): T[] =>
  Array.from({ length: count }, (_, index) => make(index) as T);

describe("createFlowRepository insert-once writers", () => {
  const cases = [
    ["insertBooks", flowBook],
    ["insertEvents", flowEvents],
    ["insertGex", flowGex],
    ["insertOptionPrints", flowOptionPrints],
  ] as const;

  for (const [method, table] of cases) {
    it(`${method} batches with onConflictDoNothing and counts returned rows`, async () => {
      // Second batch reports only one new row (the other was a conflict).
      const double = createDouble([echo, [{}]]);
      const repository = createFlowRepository(double.database);
      const input = rows<never>(FLOW_UPSERT_BATCH + 2, (index) => ({
        index,
      }));
      const insert = repository[method] as (
        rows: readonly unknown[]
      ) => Promise<number>;
      await expect(insert(input)).resolves.toBe(FLOW_UPSERT_BATCH + 1);
      expect(double.operations).toHaveLength(2);
      const [first, second] = double.operations;
      expect(first?.kind).toBe("insert");
      expect(first?.table).toBe(table);
      expect(first?.values).toHaveLength(FLOW_UPSERT_BATCH);
      expect(first?.conflict).toBe("nothing");
      expect(first?.returning).toBeDefined();
      expect(second?.values).toEqual([
        { index: FLOW_UPSERT_BATCH },
        { index: FLOW_UPSERT_BATCH + 1 },
      ]);
    });

    it(`${method} issues nothing for no rows`, async () => {
      const double = createDouble([]);
      const repository = createFlowRepository(double.database);
      const insert = repository[method] as (
        rows: readonly unknown[]
      ) => Promise<number>;
      await expect(insert([])).resolves.toBe(0);
      expect(double.operations).toHaveLength(0);
    });
  }

  it("typed fixtures are accepted by the writers", async () => {
    const double = createDouble([[{}], [{}], [{}], [{}]]);
    const repository = createFlowRepository(double.database);
    await repository.insertBooks([{} as FlowBookRecord]);
    await repository.insertEvents([{} as FlowEventRecord]);
    await repository.insertGex([{} as FlowGexRecord]);
    await repository.insertOptionPrints([{} as FlowOptionPrintRecord]);
    expect(double.operations.map((operation) => operation.table)).toEqual([
      flowBook,
      flowEvents,
      flowGex,
      flowOptionPrints,
    ]);
  });
});

describe("createFlowRepository.upsertMinutes", () => {
  it("upserts by symbol+minute in batches, guarded on covered_seconds", async () => {
    const double = createDouble([echo, echo]);
    const repository = createFlowRepository(double.database);
    const input = rows<FlowMinuteRecord>(FLOW_UPSERT_BATCH + 3, (index) => ({
      index,
    }));
    await expect(repository.upsertMinutes(input)).resolves.toBe(input.length);
    expect(double.operations).toHaveLength(2);
    const [first, second] = double.operations;
    expect(first?.table).toBe(flowMinutes);
    expect(first?.values).toHaveLength(FLOW_UPSERT_BATCH);
    expect(second?.values).toHaveLength(3);
    const conflict = first?.conflict as {
      set: Record<string, SQL>;
      setWhere: SQL;
      target: unknown[];
    };
    expect(conflict.target).toEqual([flowMinutes.symbol, flowMinutes.minute]);
    expect(dialect.sqlToQuery(conflict.setWhere).sql).toMatch(
      /^excluded\.covered_seconds >= .*"covered_seconds"$/
    );
    expect(dialect.sqlToQuery(conflict.set["coveredSeconds"] as SQL).sql).toBe(
      "excluded.covered_seconds"
    );
    expect(Object.keys(conflict.set)).toHaveLength(17);
    expect(first?.returning).toEqual({ minute: flowMinutes.minute });
  });

  it("returns zero for no rows", async () => {
    const double = createDouble([]);
    const repository = createFlowRepository(double.database);
    await expect(repository.upsertMinutes([])).resolves.toBe(0);
    expect(double.operations).toHaveLength(0);
  });
});

describe("createFlowRepository.recordSample", () => {
  it("upserts on symbol+source+at, replacing items/message/status", async () => {
    const double = createDouble([[]]);
    const repository = createFlowRepository(double.database);
    const sample = { items: 3, status: "ok" } as unknown as FlowSampleRecord;
    await repository.recordSample(sample);
    const [operation] = double.operations;
    expect(operation?.table).toBe(flowSamples);
    expect(operation?.values).toBe(sample);
    const conflict = operation?.conflict as {
      set: Record<string, SQL>;
      target: unknown[];
    };
    expect(conflict.target).toEqual([
      flowSamples.symbol,
      flowSamples.source,
      flowSamples.at,
    ]);
    expect(
      Object.fromEntries(
        Object.entries(conflict.set).map(([key, value]) => [
          key,
          dialect.sqlToQuery(value).sql,
        ])
      )
    ).toEqual({
      items: "excluded.items",
      message: "excluded.message",
      status: "excluded.status",
    });
  });
});

describe("createFlowRepository.prune", () => {
  it("deletes from every flow table before the cutoff and sums removed rows", async () => {
    const double = createDouble([
      [{}],
      [],
      [{}, {}],
      [{}],
      [],
      [{}, {}, {}],
      [{}],
    ]);
    const repository = createFlowRepository(double.database);
    await expect(repository.prune(FROM)).resolves.toBe(8);
    expect(double.operations.map((operation) => operation.kind)).toEqual(
      new Array(7).fill("delete")
    );
    expect(double.operations.map((operation) => operation.table)).toEqual([
      flowSamples,
      flowMinutes,
      flowBook,
      flowOptionPrints,
      flowEvents,
      flowGex,
      flowOptionGaps,
    ]);
    expect(whereOf(double.operations[6]).sql).toContain('"end_time" < $1');
    for (const operation of double.operations) {
      const where = whereOf(operation);
      expect(where.sql).toContain(" < $1");
      expect(where.params).toEqual([FROM.toISOString()]);
    }
  });
});

describe("createFlowRepository option gaps", () => {
  const gap = {
    createdAt: FROM,
    endTime: TO,
    startTime: FROM,
    symbol: "SPY" as const,
  };

  it("reads one symbol's gaps, newest end first", async () => {
    const double = createDouble([[gap]]);
    const repository = createFlowRepository(double.database);
    await expect(repository.optionGaps("SPY")).resolves.toEqual([gap]);
    const [operation] = double.operations;
    expect(operation?.table).toBe(flowOptionGaps);
    expect(whereOf(operation)).toMatchObject({
      params: ["SPY"],
      sql: '"flow_option_gaps"."symbol" = $1',
    });
    expect(dialect.sqlToQuery(operation?.orderBy?.[0] as SQL).sql).toBe(
      '"flow_option_gaps"."end_time" desc'
    );
  });

  it("saves a gap, moving only the end of a stored gap with the same start", async () => {
    const double = createDouble([[]]);
    const repository = createFlowRepository(double.database);
    await repository.saveOptionGap(gap);
    const [operation] = double.operations;
    expect(operation).toMatchObject({
      kind: "insert",
      table: flowOptionGaps,
      values: gap,
    });
    const conflict = operation?.conflict as {
      set: Record<string, SQL>;
      target: unknown[];
    };
    expect(conflict.target).toEqual([
      flowOptionGaps.symbol,
      flowOptionGaps.startTime,
    ]);
    expect(Object.keys(conflict.set)).toEqual(["endTime"]);
    expect(dialect.sqlToQuery(conflict.set["endTime"] as SQL).sql).toBe(
      "excluded.end_time"
    );
  });

  it("deletes one gap by symbol and start", async () => {
    const double = createDouble([[]]);
    const repository = createFlowRepository(double.database);
    await repository.deleteOptionGap("ES", FROM);
    const [operation] = double.operations;
    expect(operation).toMatchObject({ kind: "delete", table: flowOptionGaps });
    expect(whereOf(operation)).toMatchObject({
      params: ["ES", FROM.toISOString()],
      sql: '("flow_option_gaps"."symbol" = $1 and "flow_option_gaps"."start_time" = $2)',
    });
  });
});

describe("createFlowRepository.newestOptionPrintAt", () => {
  it("returns null when no prints exist", async () => {
    const double = createDouble([[{ at: null }]]);
    const repository = createFlowRepository(double.database);
    await expect(repository.newestOptionPrintAt("SPY")).resolves.toBeNull();
    const [operation] = double.operations;
    expect(operation?.table).toBe(flowOptionPrints);
    expect(whereOf(operation).params).toEqual(["SPY"]);
  });

  it("returns null when the driver returns no row", async () => {
    const double = createDouble([[]]);
    const repository = createFlowRepository(double.database);
    await expect(repository.newestOptionPrintAt("SPY")).resolves.toBeNull();
  });

  it("passes a Date through", async () => {
    const double = createDouble([[{ at: TO }]]);
    const repository = createFlowRepository(double.database);
    await expect(repository.newestOptionPrintAt("SPY")).resolves.toBe(TO);
  });

  it("parses a string from the driver", async () => {
    const double = createDouble([[{ at: TO.toISOString() }]]);
    const repository = createFlowRepository(double.database);
    await expect(repository.newestOptionPrintAt("SPY")).resolves.toEqual(TO);
  });
});

describe("createFlowRepository.newestDataAt", () => {
  it("returns null when every table is empty", async () => {
    const double = createDouble([[{ at: null }], [], [{ at: null }]]);
    const repository = createFlowRepository(double.database);
    await expect(repository.newestDataAt("ES")).resolves.toBeNull();
    expect(double.operations.map((operation) => operation.table)).toEqual([
      flowMinutes,
      flowBook,
      flowOptionPrints,
    ]);
    for (const operation of double.operations)
      expect(whereOf(operation).params).toEqual(["ES"]);
  });

  it("returns the max over Date and string values", async () => {
    const double = createDouble([
      [{ at: FROM }],
      [{ at: TO.toISOString() }],
      [{ at: null }],
    ]);
    const repository = createFlowRepository(double.database);
    await expect(repository.newestDataAt("ES")).resolves.toEqual(TO);
  });
});

describe("createFlowRepository.latestSamples", () => {
  it("queries latest then latest-ok per source in order and skips missing rows", async () => {
    const tickLast = { source: "ticks", status: "error" };
    const tickOk = { source: "ticks", status: "ok" };
    const gexLast = { source: "gex", status: "ok" };
    const double = createDouble([
      [tickLast],
      [tickOk],
      [],
      [],
      [],
      [],
      [gexLast],
      [],
    ]);
    const repository = createFlowRepository(double.database);
    await expect(repository.latestSamples("SPY")).resolves.toEqual({
      latest: [tickLast, gexLast],
      latestOk: [tickOk],
    });
    expect(double.operations).toHaveLength(8);
    const params = double.operations.map(
      (operation) => whereOf(operation).params
    );
    expect(params).toEqual([
      ["SPY", "ticks"],
      ["SPY", "ticks", "ok"],
      ["SPY", "depth"],
      ["SPY", "depth", "ok"],
      ["SPY", "options"],
      ["SPY", "options", "ok"],
      ["SPY", "gex"],
      ["SPY", "gex", "ok"],
    ]);
    for (const operation of double.operations) {
      expect(operation.table).toBe(flowSamples);
      expect(operation.limit).toBe(1);
    }
    expect(whereOf(double.operations[1]).sql).toContain('"status" = $3');
    expect(whereOf(double.operations[0]).sql).not.toContain('"status"');
  });
});

describe("createFlowRepository.readWindow", () => {
  it("reads five tables bounded by symbol and window, gex null when absent", async () => {
    const minute = { minute: FROM };
    const book = { at: FROM };
    const print = { tradedAt: FROM };
    const event = { at: TO };
    const double = createDouble([[minute], [book], [print], [event], []]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readWindow({ from: FROM, symbol: "SPY", to: TO })
    ).resolves.toEqual({
      books: [book],
      events: [event],
      gex: null,
      minutes: [minute],
      prints: [print],
    });
    expect(double.operations.map((operation) => operation.table)).toEqual([
      flowMinutes,
      flowBook,
      flowOptionPrints,
      flowEvents,
      flowGex,
    ]);
    for (const operation of double.operations.slice(0, 4)) {
      const where = whereOf(operation);
      expect(where.sql).toMatch(/[=] \$1 and .* >= \$2 and .* <= \$3/);
      expect(where.params).toEqual([
        "SPY",
        FROM.toISOString(),
        TO.toISOString(),
      ]);
    }
    const gexWhere = whereOf(double.operations[4]);
    expect(gexWhere.sql).toMatch(/[=] \$1 and .* <= \$2/);
    expect(gexWhere.params).toEqual(["SPY", TO.toISOString()]);
    expect(double.operations[4]?.limit).toBe(1);
  });

  it("reads the gex row up to gexAt when given", async () => {
    const double = createDouble([[], [], [], [], []]);
    const repository = createFlowRepository(double.database);
    const later = new Date(TO.getTime() + 86_400_000);
    await repository.readWindow({
      from: FROM,
      gexAt: later,
      symbol: "SPY",
      to: TO,
    });
    expect(whereOf(double.operations[4]).params).toEqual([
      "SPY",
      later.toISOString(),
    ]);
  });

  it("returns the newest gex row when present", async () => {
    const gex = { at: TO };
    const double = createDouble([[], [], [], [], [gex]]);
    const repository = createFlowRepository(double.database);
    const result = await repository.readWindow({
      from: FROM,
      symbol: "SPY",
      to: TO,
    });
    expect(result.gex).toBe(gex);
  });
});
