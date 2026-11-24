import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  flowBook,
  flowBookSnapshots,
  flowEvents,
  flowGex,
  flowLargeTrades,
  flowMarketPremium,
  flowMarketPremiumSessions,
  flowMinutes,
  flowNetDrift,
  flowOptionGaps,
  flowOptionPrints,
  flowSamples,
  flowTapeSeconds,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  createFlowRepository,
  FLOW_UPSERT_BATCH,
  type FlowBookRecord,
  type FlowBookSnapshotRecord,
  type FlowEventRecord,
  type FlowGexRecord,
  type FlowLargeTradeRecord,
  type FlowMarketPremiumRecord,
  type FlowMarketPremiumSessionRecord,
  type FlowMinuteRecord,
  type FlowNetDriftRecord,
  type FlowOptionPrintRecord,
  type FlowSampleRecord,
  type FlowTapeSecondsRecord,
} from "./flow.ts";
import { InvalidRepositoryInputError } from "./repository-errors.ts";

const dialect = new PgDialect();
const FROM = new Date("2026-11-02T14:30:00.000Z");
const TO = new Date("2026-11-02T15:30:00.000Z");

interface Operation {
  columns?: unknown;
  conflict?: "nothing" | Record<string, unknown>;
  groupBy?: unknown[];
  kind: "select" | "insert" | "delete" | "update";
  limit?: number;
  orderBy?: unknown[];
  returning?: unknown;
  set?: unknown;
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
      groupBy: (...columns: unknown[]) => {
        operation.groupBy = columns;
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
      set: (values: unknown) => {
        operation.set = values;
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
    selectDistinctOn: (on: unknown[], columns?: unknown) =>
      builder({ columns, groupBy: on, kind: "select" }),
    update: (table: unknown) => builder({ kind: "update", table }),
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
    expect(dialect.sqlToQuery(conflict.setWhere)).toEqual({
      params: [],
      sql: 'excluded.covered_seconds >= "flow_minutes"."covered_seconds"',
    });
    expect(dialect.sqlToQuery(conflict.set["coveredSeconds"] as SQL).sql).toBe(
      "excluded.covered_seconds"
    );
    expect(Object.keys(conflict.set)).toHaveLength(17);
    expect(first?.returning).toEqual({ minute: flowMinutes.minute });
  });

  it.each([
    [
      "coverage",
      'excluded.covered_seconds >= "flow_minutes"."covered_seconds"',
    ],
    ["trades", 'excluded.trades >= "flow_minutes"."trades"'],
  ] as const)(
    "builds the condition of the replace rule %s",
    async (replace, expected) => {
      const double = createDouble([echo]);
      const repository = createFlowRepository(double.database);
      const input = rows<FlowMinuteRecord>(2, (index) => ({ index }));
      await expect(repository.upsertMinutes(input, replace)).resolves.toBe(2);
      const [operation] = double.operations;
      const conflict = operation?.conflict as {
        set: Record<string, SQL>;
        setWhere: SQL;
      };
      expect(dialect.sqlToQuery(conflict.setWhere)).toEqual({
        params: [],
        sql: expected,
      });
      expect(Object.keys(conflict.set)).toHaveLength(17);
      expect(dialect.sqlToQuery(conflict.set["trades"] as SQL).sql).toBe(
        "excluded.trades"
      );
    }
  );

  it("returns zero for no rows", async () => {
    const double = createDouble([]);
    const repository = createFlowRepository(double.database);
    await expect(repository.upsertMinutes([])).resolves.toBe(0);
    expect(double.operations).toHaveLength(0);
  });
});

describe("createFlowRepository tape seconds", () => {
  const record = (index: number): FlowTapeSecondsRecord => ({
    contract: "ESZ6",
    contracts: new Array<number>(60).fill(index),
    covered: "1".repeat(60),
    minute: new Date(FROM.getTime() + index * 60_000),
    symbol: "ES",
    totalTrades: index * 60,
    trades: new Array<number>(60).fill(index),
  });

  it("upserts by symbol+minute in batches and replaces a row with at least as many trades", async () => {
    const double = createDouble([echo, [{}]]);
    const repository = createFlowRepository(double.database);
    const input = rows<FlowTapeSecondsRecord>(FLOW_UPSERT_BATCH + 1, record);
    // The second batch reports one written row.
    await expect(repository.upsertTapeSeconds(input)).resolves.toBe(
      FLOW_UPSERT_BATCH + 1
    );
    expect(double.operations).toHaveLength(2);
    const [first, second] = double.operations;
    expect(first?.kind).toBe("insert");
    expect(first?.table).toBe(flowTapeSeconds);
    expect(first?.values).toHaveLength(FLOW_UPSERT_BATCH);
    expect(second?.values).toEqual([record(FLOW_UPSERT_BATCH)]);
    const conflict = first?.conflict as {
      set: Record<string, SQL>;
      setWhere: SQL;
      target: unknown[];
    };
    expect(conflict.target).toEqual([
      flowTapeSeconds.symbol,
      flowTapeSeconds.minute,
    ]);
    expect(dialect.sqlToQuery(conflict.setWhere)).toEqual({
      params: [],
      sql: 'excluded.total_trades >= "flow_tape_seconds"."total_trades"',
    });
    expect(
      Object.fromEntries(
        Object.entries(conflict.set).map(([key, value]) => [
          key,
          dialect.sqlToQuery(value).sql,
        ])
      )
    ).toEqual({
      contract: "excluded.contract",
      contracts: "excluded.contracts",
      covered: "excluded.covered",
      totalTrades: "excluded.total_trades",
      trades: "excluded.trades",
    });
    expect(first?.returning).toEqual({ minute: flowTapeSeconds.minute });
  });

  it("counts only the rows that the replace rule wrote", async () => {
    // Two rows offered, one kept by the rule: the statement returns one row.
    const double = createDouble([[{}]]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.upsertTapeSeconds([record(1), record(2)])
    ).resolves.toBe(1);
  });

  it("issues no statement for no rows", async () => {
    const double = createDouble([]);
    const repository = createFlowRepository(double.database);
    await expect(repository.upsertTapeSeconds([])).resolves.toBe(0);
    expect(double.operations).toHaveLength(0);
  });

  it("reads the rows of a symbol and minute range in minute order, end-exclusive", async () => {
    const double = createDouble([[record(0), record(1)]]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readTapeSeconds({ from: FROM, symbol: "NQ", to: TO })
    ).resolves.toEqual([record(0), record(1)]);
    const [operation] = double.operations;
    expect(operation?.kind).toBe("select");
    expect(operation?.table).toBe(flowTapeSeconds);
    expect(operation?.columns).toEqual({
      contract: flowTapeSeconds.contract,
      contracts: flowTapeSeconds.contracts,
      covered: flowTapeSeconds.covered,
      minute: flowTapeSeconds.minute,
      symbol: flowTapeSeconds.symbol,
      totalTrades: flowTapeSeconds.totalTrades,
      trades: flowTapeSeconds.trades,
    });
    expect(whereOf(operation)).toMatchObject({
      params: ["NQ", FROM.toISOString(), TO.toISOString()],
      sql: '("flow_tape_seconds"."symbol" = $1 and "flow_tape_seconds"."minute" >= $2 and "flow_tape_seconds"."minute" < $3)',
    });
    expect(
      ((operation?.orderBy as SQL[] | undefined) ?? []).map(
        (order) => dialect.sqlToQuery(order).sql
      )
    ).toEqual(['"flow_tape_seconds"."minute" asc']);
  });

  it("reads the starts of the minute rows of a symbol and range, end-exclusive", async () => {
    const double = createDouble([[{ minute: FROM }, { minute: TO }]]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readMinuteStarts({ from: FROM, symbol: "ES", to: TO })
    ).resolves.toEqual([FROM, TO]);
    const [operation] = double.operations;
    expect(operation?.table).toBe(flowMinutes);
    expect(operation?.columns).toEqual({ minute: flowMinutes.minute });
    expect(whereOf(operation)).toMatchObject({
      params: ["ES", FROM.toISOString(), TO.toISOString()],
      sql: '("flow_minutes"."symbol" = $1 and "flow_minutes"."minute" >= $2 and "flow_minutes"."minute" < $3)',
    });
    expect(
      ((operation?.orderBy as SQL[] | undefined) ?? []).map(
        (order) => dialect.sqlToQuery(order).sql
      )
    ).toEqual(['"flow_minutes"."minute" asc']);
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
  // flow_tape_seconds is not in the list below: its counts cannot be collected again and are
  // not pruned.
  it("deletes from each flow table before its own cutoff and sums removed rows", async () => {
    const double = createDouble([
      [{}],
      [],
      [{}, {}],
      [{}],
      [],
      [{}, {}, {}],
      [{}],
      [{}, {}],
      [{}, {}, {}, {}],
      [{}],
    ]);
    const repository = createFlowRepository(double.database);
    const at = (day: number) => new Date(Date.UTC(2026, 0, day));
    const cutoffs = {
      flow_book: at(3),
      flow_book_snapshots: at(10),
      flow_events: at(5),
      flow_gex: at(6),
      flow_large_trades: at(9),
      flow_minutes: at(2),
      flow_net_drift: at(8),
      flow_option_gaps: at(7),
      flow_option_prints: at(4),
      flow_samples: at(1),
    };
    await expect(repository.prune(cutoffs)).resolves.toBe(15);
    expect(double.operations.map((operation) => operation.kind)).toEqual(
      new Array(10).fill("delete")
    );
    expect(double.operations.map((operation) => operation.table)).toEqual([
      flowSamples,
      flowMinutes,
      flowBook,
      flowOptionPrints,
      flowEvents,
      flowGex,
      flowOptionGaps,
      flowNetDrift,
      flowLargeTrades,
      flowBookSnapshots,
    ]);
    expect(whereOf(double.operations[8]).sql).toContain('"second" < $1');
    expect(whereOf(double.operations[9]).sql).toContain('"captured_at" < $1');
    expect(whereOf(double.operations[6]).sql).toContain('"end_time" < $1');
    expect(whereOf(double.operations[7]).sql).toContain('"minute" < $1');
    double.operations.forEach((operation, index) => {
      const where = whereOf(operation);
      expect(where.sql).toContain(" < $1");
      expect(where.params).toEqual([at(index + 1).toISOString()]);
    });
  });
});

describe("createFlowRepository net drift", () => {
  it("queries the newest sample of the net_drift source", async () => {
    const netDrift = { source: "net_drift", status: "ok" };
    const double = createDouble([
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [netDrift],
      [netDrift],
    ]);
    const repository = createFlowRepository(double.database);
    await expect(repository.latestSamples("QQQ")).resolves.toEqual({
      latest: [netDrift],
      latestOk: [netDrift],
    });
    expect(whereOf(double.operations[8]).params).toEqual(["QQQ", "net_drift"]);
  });

  const bucket = (minute: number): FlowNetDriftRecord => ({
    filterProfile: "otm-clean.v1",
    minute: new Date(FROM.getTime() + minute * 60_000),
    netCallPremium: 1000,
    netCallVolume: 10,
    netPutPremium: -500,
    netPutVolume: -5,
    part: "total",
    ticker: "SPX",
    underlyingPrice: null,
  });

  it("upserts net drift by ticker, part and minute and rewrites a row only when a value or the filter profile changed", async () => {
    const input = rows<FlowNetDriftRecord>(FLOW_UPSERT_BATCH + 1, bucket);
    const double = createDouble([echo, []]);
    const repository = createFlowRepository(double.database);
    await expect(repository.upsertNetDrift(input)).resolves.toBe(
      FLOW_UPSERT_BATCH
    );
    expect(double.operations).toHaveLength(2);
    const [first] = double.operations;
    expect(first?.table).toBe(flowNetDrift);
    const conflict = first?.conflict as Record<string, unknown>;
    expect(conflict["target"]).toEqual([
      flowNetDrift.ticker,
      flowNetDrift.part,
      flowNetDrift.minute,
    ]);
    expect(
      Object.fromEntries(
        Object.entries(conflict["set"] as Record<string, SQL>).map(
          ([key, value]) => [key, dialect.sqlToQuery(value).sql]
        )
      )
    ).toEqual({
      filterProfile: "excluded.filter_profile",
      netCallPremium: "excluded.net_call_premium",
      netCallVolume: "excluded.net_call_volume",
      netPutPremium: "excluded.net_put_premium",
      netPutVolume: "excluded.net_put_volume",
      underlyingPrice: "excluded.underlying_price",
    });
    const setWhere = dialect.sqlToQuery(conflict["setWhere"] as SQL).sql;
    for (const column of [
      "net_call_premium",
      "net_put_premium",
      "net_call_volume",
      "net_put_volume",
      "underlying_price",
      "filter_profile",
    ])
      expect(setWhere).toContain(
        `"flow_net_drift"."${column}" is distinct from excluded.${column}`
      );
  });

  it("returns zero net drift rows for no input", async () => {
    const double = createDouble([]);
    const repository = createFlowRepository(double.database);
    await expect(repository.upsertNetDrift([])).resolves.toBe(0);
    expect(double.operations).toHaveLength(0);
  });

  it("reads net drift for the tickers and the time range in minute order", async () => {
    const double = createDouble([[bucket(0)]]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readNetDrift({ from: FROM, tickers: ["SPX", "SPY"], to: TO })
    ).resolves.toEqual([bucket(0)]);
    const [operation] = double.operations;
    expect(operation?.table).toBe(flowNetDrift);
    expect(whereOf(operation)).toMatchObject({
      params: ["SPX", "SPY", FROM.toISOString(), TO.toISOString()],
      sql: '("flow_net_drift"."ticker" in ($1, $2) and "flow_net_drift"."minute" >= $3 and "flow_net_drift"."minute" < $4)',
    });
    expect(dialect.sqlToQuery(operation?.orderBy?.[0] as SQL).sql).toBe(
      '"flow_net_drift"."minute" asc'
    );
  });

  it("returns the newest total net drift minute, or null for an empty table or a missing driver row", async () => {
    const double = createDouble([
      [{ minute: TO.toISOString() }],
      [{ minute: null }],
      [],
    ]);
    const repository = createFlowRepository(double.database);
    await expect(repository.newestNetDriftMinute("QQQ")).resolves.toEqual(TO);
    await expect(repository.newestNetDriftMinute("QQQ")).resolves.toBeNull();
    await expect(repository.newestNetDriftMinute("QQQ")).resolves.toBeNull();
    expect(whereOf(double.operations[0])).toMatchObject({
      params: ["QQQ", "total"],
      sql: '("flow_net_drift"."ticker" = $1 and "flow_net_drift"."part" = $2)',
    });
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

  it("adds a gap; a stored gap with the same start keeps the later end", async () => {
    const double = createDouble([[]]);
    const repository = createFlowRepository(double.database);
    await repository.addOptionGap(gap);
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
      'greatest("flow_option_gaps"."end_time", excluded.end_time)'
    );
  });

  it("moves one gap's end by symbol and start", async () => {
    const double = createDouble([[]]);
    const repository = createFlowRepository(double.database);
    await repository.moveOptionGapEnd("SPY", FROM, TO);
    const [operation] = double.operations;
    expect(operation).toMatchObject({
      kind: "update",
      set: { endTime: TO },
      table: flowOptionGaps,
    });
    expect(whereOf(operation)).toMatchObject({
      params: ["SPY", FROM.toISOString()],
      sql: '("flow_option_gaps"."symbol" = $1 and "flow_option_gaps"."start_time" = $2)',
    });
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

describe("createFlowRepository.readHedgingPrints", () => {
  it("reads the line's columns of a symbol and range, end-exclusive, by time then id, with a limit", async () => {
    const row = {
      dte: 0.4,
      id: "print-1",
      iv: 21.5,
      right: "call",
      side: "ask",
      size: 10,
      strike: 660,
      tradedAt: FROM,
      underlyingPrice: 661.2,
    };
    const double = createDouble([[row]]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readHedgingPrints({
        from: FROM,
        limit: 200_001,
        symbol: "ES",
        to: TO,
      })
    ).resolves.toEqual([row]);
    const [operation] = double.operations;
    expect(operation?.kind).toBe("select");
    expect(operation?.table).toBe(flowOptionPrints);
    expect(operation?.columns).toEqual({
      dte: flowOptionPrints.dte,
      id: flowOptionPrints.id,
      iv: flowOptionPrints.iv,
      right: flowOptionPrints.right,
      side: flowOptionPrints.side,
      size: flowOptionPrints.size,
      strike: flowOptionPrints.strike,
      tradedAt: flowOptionPrints.tradedAt,
      underlyingPrice: flowOptionPrints.underlyingPrice,
    });
    expect(whereOf(operation)).toMatchObject({
      params: ["ES", FROM.toISOString(), TO.toISOString()],
      sql: '("flow_option_prints"."symbol" = $1 and "flow_option_prints"."traded_at" >= $2 and "flow_option_prints"."traded_at" < $3)',
    });
    expect(
      ((operation?.orderBy as SQL[] | undefined) ?? []).map(
        (order) => dialect.sqlToQuery(order).sql
      )
    ).toEqual([
      '"flow_option_prints"."traded_at" asc',
      '"flow_option_prints"."id" asc',
    ]);
    expect(operation?.limit).toBe(200_001);
  });
});
describe("createFlowRepository.readLargeOptionPrints", () => {
  it("reads big option prints of a symbol and range above minPremiumUsd, ordered by premium desc, traded_at desc, id desc", async () => {
    const row = {
      id: "big-1",
      premium: 500_000,
      right: "call",
      strike: 685,
      symbol: "SPY",
      tradedAt: FROM,
    };
    const double = createDouble([[row]]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readLargeOptionPrints({
        from: FROM,
        limit: 121,
        minPremiumUsd: 250_000,
        symbol: "SPY",
        to: TO,
      })
    ).resolves.toEqual([row]);
    const [operation] = double.operations;
    expect(operation?.kind).toBe("select");
    expect(operation?.table).toBe(flowOptionPrints);
    expect(whereOf(operation)).toMatchObject({
      params: ["SPY", FROM.toISOString(), TO.toISOString(), 250_000],
      sql: '("flow_option_prints"."symbol" = $1 and "flow_option_prints"."traded_at" >= $2 and "flow_option_prints"."traded_at" < $3 and "flow_option_prints"."premium" >= $4)',
    });
    expect(
      ((operation?.orderBy as SQL[] | undefined) ?? []).map(
        (order) => dialect.sqlToQuery(order).sql
      )
    ).toEqual([
      '"flow_option_prints"."premium" desc',
      '"flow_option_prints"."traded_at" desc',
      '"flow_option_prints"."id" desc',
    ]);
    expect(operation?.limit).toBe(121);
  });
});

describe("createFlowRepository.readOptionStrikeTotals", () => {
  it("groups a symbol's prints of a range and expiry floor by strike, right and sentiment", async () => {
    const row = {
      contracts: 30,
      newestAt: TO,
      oldestAt: FROM,
      premium: 12_000,
      right: "call",
      sentiment: "bullish",
      strike: 660,
      trades: 3,
    };
    const double = createDouble([[row]]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readOptionStrikeTotals({
        from: FROM,
        minExpiry: "2026-11-20",
        symbol: "SPY",
        to: TO,
      })
    ).resolves.toEqual([row]);
    const [operation] = double.operations;
    expect(operation?.kind).toBe("select");
    expect(operation?.table).toBe(flowOptionPrints);
    expect(Object.keys(operation?.columns ?? {}).sort()).toEqual([
      "contracts",
      "newestAt",
      "oldestAt",
      "premium",
      "right",
      "sentiment",
      "strike",
      "trades",
    ]);
    expect(whereOf(operation)).toMatchObject({
      params: ["SPY", FROM.toISOString(), TO.toISOString(), "2026-11-20", 0],
      sql: '("flow_option_prints"."symbol" = $1 and "flow_option_prints"."traded_at" >= $2 and "flow_option_prints"."traded_at" < $3 and "flow_option_prints"."expiry" >= $4 and "flow_option_prints"."strike" > $5)',
    });
    expect(operation?.groupBy).toEqual([
      flowOptionPrints.strike,
      flowOptionPrints.right,
      flowOptionPrints.sentiment,
    ]);
    expect(
      ((operation?.orderBy as SQL[] | undefined) ?? []).map(
        (order) => dialect.sqlToQuery(order).sql
      )
    ).toEqual([
      '"flow_option_prints"."strike" asc',
      '"flow_option_prints"."right" asc',
      '"flow_option_prints"."sentiment" asc',
    ]);
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

describe("createFlowRepository.latestSamples with a source list", () => {
  it("queries only the sources that the caller names", async () => {
    const tickLast = { source: "ticks", status: "error" };
    const tickOk = { source: "ticks", status: "ok" };
    const double = createDouble([[tickLast], [tickOk]]);
    const repository = createFlowRepository(double.database);
    await expect(repository.latestSamples("ES", ["ticks"])).resolves.toEqual({
      latest: [tickLast],
      latestOk: [tickOk],
    });
    expect(
      double.operations.map((operation) => whereOf(operation).params)
    ).toEqual([
      ["ES", "ticks"],
      ["ES", "ticks", "ok"],
    ]);
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
      [],
      [],
      [],
      [],
    ]);
    const repository = createFlowRepository(double.database);
    await expect(repository.latestSamples("SPY")).resolves.toEqual({
      latest: [tickLast, gexLast],
      latestOk: [tickOk],
    });
    expect(double.operations).toHaveLength(12);
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
      ["SPY", "net_drift"],
      ["SPY", "net_drift", "ok"],
      ["SPY", "market_premium"],
      ["SPY", "market_premium", "ok"],
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

describe("createFlowRepository.readEvents", () => {
  it("queries flow_events bounded by symbol, range and limit without a kind filter", async () => {
    const event = { at: TO, kind: "stacked_imbalance" };
    const double = createDouble([[event]]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readEvents({ from: FROM, limit: 50, symbol: "ES", to: TO })
    ).resolves.toEqual([event]);
    expect(double.operations).toHaveLength(1);
    expect(double.operations[0]?.table).toBe(flowEvents);
    expect(double.operations[0]?.limit).toBe(50);
    const where = whereOf(double.operations[0]);
    expect(where.sql).toMatch(/[=] \$1 and .* >= \$2 and .* <= \$3/);
    expect(where.sql).not.toContain(" in ");
    expect(where.params).toEqual(["ES", FROM.toISOString(), TO.toISOString()]);
  });

  it("filters by event kinds when provided", async () => {
    const double = createDouble([[]]);
    const repository = createFlowRepository(double.database);
    await repository.readEvents({
      from: FROM,
      kinds: ["stacked_imbalance", "absorption"],
      limit: 201,
      symbol: "SPY",
      to: TO,
    });
    const where = whereOf(double.operations[0]);
    expect(where.sql).toContain('"kind" in ($4, $5)');
    expect(where.params).toEqual([
      "SPY",
      FROM.toISOString(),
      TO.toISOString(),
      "stacked_imbalance",
      "absorption",
    ]);
    expect(double.operations[0]?.limit).toBe(201);
  });
});

describe("createFlowRepository deep trades", () => {
  const SECOND = new Date("2026-11-02T15:00:01.000Z");
  const trade = (seq: number): FlowLargeTradeRecord => ({
    capture: "sampled",
    limitSize: 40,
    price: 6870.5,
    sampledAt: TO,
    second: SECOND,
    seq,
    side: "buy",
    signing: "quote",
    size: 42,
    symbol: "ES",
  });
  const event = (key: string): FlowEventRecord => ({
    at: SECOND,
    detail: "Large print",
    direction: "bullish",
    key,
    kind: "large_print",
    premium: null,
    price: 6870.5,
    size: 50,
    source: "ibkr",
    symbol: "ES",
  });
  const withTransaction = (
    outcomes: Parameters<typeof createDouble>[0]
  ): ReturnType<typeof createDouble> & { transactions: () => number } => {
    const double = createDouble(outcomes);
    let opened = 0;
    const database = Object.assign(Object.create(null), double.database, {
      transaction: async (
        run: (tx: DatabaseExecutor) => Promise<unknown>
      ): Promise<unknown> => {
        opened += 1;
        return run(double.database);
      },
    }) as DatabaseExecutor;
    return { ...double, database, transactions: () => opened };
  };

  it("inserts the events and the large trades of one sample in one transaction and counts only new rows", async () => {
    const trades = rows<FlowLargeTradeRecord>(FLOW_UPSERT_BATCH + 1, trade);
    const double = withTransaction([
      (operation) => echo(operation).slice(1),
      echo,
      [{}],
    ]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.insertTickSample({
        events: [event("a"), event("b")],
        trades,
      })
    ).resolves.toEqual({ events: 1, trades: FLOW_UPSERT_BATCH });
    expect(double.transactions()).toBe(1);
    expect(double.operations.map((operation) => operation.table)).toEqual([
      flowLargeTrades,
      flowLargeTrades,
      flowEvents,
    ]);
    for (const operation of double.operations)
      expect(operation.conflict).toBe("nothing");
  });

  it("writes nothing and opens no transaction for no input", async () => {
    const double = withTransaction([]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.insertTickSample({ events: [], trades: [] })
    ).resolves.toEqual({ events: 0, trades: 0 });
    expect(double.transactions()).toBe(0);
    expect(double.operations).toEqual([]);
  });

  it("stores neither kind when one insert fails", async () => {
    const double = withTransaction([
      echo,
      () => {
        throw new Error("insert failed");
      },
    ]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.insertTickSample({ events: [event("a")], trades: [trade(0)] })
    ).rejects.toThrow("insert failed");
    expect(double.transactions()).toBe(1);
  });

  it("reads the large trades of a symbol and time range in second and seq order, end-exclusive", async () => {
    const double = createDouble([[trade(0)]]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readLargeTrades({ from: FROM, symbol: "NQ", to: TO })
    ).resolves.toEqual([trade(0)]);
    const [operation] = double.operations;
    expect(operation?.table).toBe(flowLargeTrades);
    expect(whereOf(operation)).toMatchObject({
      params: ["NQ", FROM.toISOString(), TO.toISOString()],
      sql: '("flow_large_trades"."symbol" = $1 and "flow_large_trades"."second" >= $2 and "flow_large_trades"."second" < $3)',
    });
    expect(
      ((operation?.orderBy as SQL[] | undefined) ?? []).map(
        (order) => dialect.sqlToQuery(order).sql
      )
    ).toEqual([
      '"flow_large_trades"."second" asc',
      '"flow_large_trades"."seq" asc',
    ]);
  });

  it("stores and reads back a large trade with the capture mode streamed", async () => {
    const streamed: FlowLargeTradeRecord = { ...trade(3), capture: "streamed" };
    const double = withTransaction([echo, [streamed]]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.insertTickSample({ events: [], trades: [streamed] })
    ).resolves.toEqual({ events: 0, trades: 1 });
    const [insert] = double.operations;
    expect(insert?.table).toBe(flowLargeTrades);
    expect(insert?.values).toEqual([streamed]);
    await expect(
      repository.readLargeTrades({ from: FROM, symbol: "ES", to: TO })
    ).resolves.toEqual([streamed]);
  });

  it("returns the newest total net drift price at or before a time, or null", async () => {
    const double = createDouble([
      [{ minute: FROM, price: 6850.25 }],
      [],
      [{ minute: FROM, price: null }],
    ]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.netDriftPriceAtOrBefore("SPX", TO)
    ).resolves.toEqual({ minute: FROM, price: 6850.25 });
    await expect(
      repository.netDriftPriceAtOrBefore("SPX", TO)
    ).resolves.toBeNull();
    await expect(
      repository.netDriftPriceAtOrBefore("SPX", TO)
    ).resolves.toBeNull();
    const [operation] = double.operations;
    expect(whereOf(operation)).toMatchObject({
      params: ["SPX", "total", TO.toISOString()],
      sql: '("flow_net_drift"."ticker" = $1 and "flow_net_drift"."part" = $2 and "flow_net_drift"."minute" <= $3 and "flow_net_drift"."underlying_price" is not null)',
    });
    expect(operation?.limit).toBe(1);
    expect(dialect.sqlToQuery(operation?.orderBy?.[0] as SQL).sql).toBe(
      '"flow_net_drift"."minute" desc'
    );
  });
});

describe("createFlowRepository market premium", () => {
  const CAPTURED = new Date("2026-11-20T16:00:00.000Z");
  const premiumRow = (index: number): FlowMarketPremiumRecord => ({
    bearishPremium: 1,
    bullishPremium: 2,
    capturedAt: CAPTURED,
    filterProfile: "premium-gte-100k.v1",
    premium: 3,
    sessionDate: "2026-11-20",
    ticker: `T${index}`,
    tradeCount: 1,
    volume: 10,
  });
  const ledgerRow: FlowMarketPremiumSessionRecord = {
    attempts: 1,
    capturedAt: CAPTURED,
    lastAttemptAt: CAPTURED,
    lastMessage: "live",
    sessionDate: "2026-11-20",
    status: "partial",
    tickers: FLOW_UPSERT_BATCH + 1,
  };
  const withTransaction = (outcomes: Parameters<typeof createDouble>[0]) => {
    const double = createDouble(outcomes);
    let opened = 0;
    const database = Object.assign(Object.create(null), double.database, {
      transaction: async (
        run: (tx: DatabaseExecutor) => Promise<unknown>
      ): Promise<unknown> => {
        opened += 1;
        return run(double.database);
      },
    }) as DatabaseExecutor;
    return { ...double, database, transactions: () => opened };
  };

  it("upserts the rows in batches, deletes older captures of the session and replaces the ledger row in one transaction", async () => {
    const double = withTransaction([echo, echo, [], []]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.storeMarketPremium({
        rows: rows<FlowMarketPremiumRecord>(FLOW_UPSERT_BATCH + 1, premiumRow),
        session: ledgerRow,
      })
    ).resolves.toBe(FLOW_UPSERT_BATCH + 1);
    expect(double.transactions()).toBe(1);
    expect(
      double.operations.map((operation) => [operation.kind, operation.table])
    ).toEqual([
      ["insert", flowMarketPremium],
      ["insert", flowMarketPremium],
      ["delete", flowMarketPremium],
      ["insert", flowMarketPremiumSessions],
    ]);
    const conflict = double.operations[0]?.conflict as {
      set: Record<string, unknown>;
      target: unknown[];
    };
    expect(Object.keys(conflict.set).sort()).toEqual([
      "bearishPremium",
      "bullishPremium",
      "capturedAt",
      "filterProfile",
      "premium",
      "tradeCount",
      "volume",
    ]);
    expect(conflict.target).toEqual([
      flowMarketPremium.sessionDate,
      flowMarketPremium.ticker,
    ]);
    const deleted = whereOf(double.operations[2]);
    expect(deleted.sql).toContain('"session_date" = $1');
    expect(deleted.sql).toContain('"captured_at" < $2');
    expect(deleted.params).toEqual(["2026-11-20", CAPTURED.toISOString()]);
    expect(double.operations[3]?.values).toEqual(ledgerRow);
    const ledgerConflict = double.operations[3]?.conflict as {
      set: Record<string, unknown>;
      target: unknown;
    };
    expect(Object.keys(ledgerConflict.set).sort()).toEqual([
      "attempts",
      "capturedAt",
      "lastAttemptAt",
      "lastMessage",
      "status",
      "tickers",
    ]);
    expect(ledgerConflict.target).toBe(flowMarketPremiumSessions.sessionDate);
  });

  it("writes only the ledger row when an attempt brings no rows", async () => {
    const double = withTransaction([[]]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.storeMarketPremium({ rows: [], session: ledgerRow })
    ).resolves.toBe(0);
    expect(double.operations.map((operation) => operation.table)).toEqual([
      flowMarketPremiumSessions,
    ]);
  });

  it("reads the ledger of a date range, oldest first", async () => {
    const double = createDouble([[ledgerRow]]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.marketPremiumLedger({ from: "2025-10-16", to: "2026-11-20" })
    ).resolves.toEqual([ledgerRow]);
    const where = whereOf(double.operations[0]);
    expect(where.sql).toContain('"session_date" >= $1');
    expect(where.sql).toContain('"session_date" <= $2');
    expect(where.params).toEqual(["2025-10-16", "2026-11-20"]);
    expect(double.operations[0]?.orderBy).toHaveLength(1);
  });

  it("answers an empty ranking for no sessions without a query", async () => {
    const double = createDouble([]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.marketPremiumRanking({
        filterProfile: "premium-gte-100k.v1",
        limit: 50,
        sessionDates: [],
        sort: "net_bullish",
        ticker: null,
      })
    ).resolves.toEqual({
      rows: [],
      totals: { bearishPremium: 0, bullishPremium: 0, premium: 0, tickers: 0 },
    });
    expect(double.operations).toEqual([]);
  });

  const grouped = (ticker: string) => ({
    bearishPremium: 1,
    bullishPremium: 2,
    premium: 3,
    sessionsPresent: 1,
    ticker,
    tradeCount: 1,
    volume: 10,
  });
  const TOTALS = {
    bearishPremium: 1,
    bullishPremium: 2,
    premium: 3,
    tickers: 2,
  };

  it.each([
    ["net_bullish", "desc"],
    ["net_bearish", "asc"],
    ["total", "desc"],
  ] as const)(
    "ranks by %s, numbers the rows and sums the window totals",
    async (sort, direction) => {
      const double = createDouble([
        [grouped("AAPL"), grouped("NVDA")],
        [TOTALS],
      ]);
      const repository = createFlowRepository(double.database);
      await expect(
        repository.marketPremiumRanking({
          filterProfile: "premium-gte-100k.v1",
          limit: 25,
          sessionDates: ["2026-11-20", "2026-11-19"],
          sort,
          ticker: null,
        })
      ).resolves.toEqual({
        rows: [
          { ...grouped("AAPL"), rank: 1 },
          { ...grouped("NVDA"), rank: 2 },
        ],
        totals: TOTALS,
      });
      const [select, sums] = double.operations;
      expect(select?.limit).toBe(25);
      expect(select?.groupBy).toEqual([flowMarketPremium.ticker]);
      expect(whereOf(select).sql).toContain('"session_date" in ($1, $2)');
      expect(whereOf(select).sql).toContain('"filter_profile" = $3');
      expect(JSON.stringify(whereOf(select).params)).toContain(
        "premium-gte-100k.v1"
      );
      const [order] = select?.orderBy ?? [];
      expect(dialect.sqlToQuery(order as SQL).sql).toContain(direction);
      expect(whereOf(sums).sql).toContain('"session_date" in ($1, $2)');
    }
  );

  it("keeps a filtered ticker's rank in the whole market and reads every ticker for it", async () => {
    const double = createDouble([
      [grouped("AAPL"), grouped("MSFT"), grouped("NVDA")],
      [TOTALS],
    ]);
    const repository = createFlowRepository(double.database);
    const found = await repository.marketPremiumRanking({
      filterProfile: "premium-gte-100k.v1",
      limit: 5,
      sessionDates: ["2026-11-20"],
      sort: "total",
      ticker: "NVDA",
    });
    expect(found.rows).toEqual([{ ...grouped("NVDA"), rank: 3 }]);
    expect(double.operations[0]?.limit).toBeUndefined();
    const missing = createDouble([[grouped("AAPL")], [TOTALS]]);
    await expect(
      createFlowRepository(missing.database).marketPremiumRanking({
        filterProfile: "premium-gte-100k.v1",
        limit: 5,
        sessionDates: ["2026-11-20"],
        sort: "total",
        ticker: "ZZZ",
      })
    ).resolves.toEqual({ rows: [], totals: TOTALS });
  });

  it("answers zero totals when the sum query returns no row", async () => {
    const double = createDouble([[], []]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.marketPremiumRanking({
        filterProfile: "premium-gte-100k.v1",
        limit: 5,
        sessionDates: ["2026-11-20"],
        sort: "total",
        ticker: null,
      })
    ).resolves.toEqual({
      rows: [],
      totals: { bearishPremium: 0, bullishPremium: 0, premium: 0, tickers: 0 },
    });
  });
});

describe("createFlowRepository.readOptionPrintMinutes", () => {
  it("groups one symbol's option prints by minute, end-exclusive, ascending, normalizing timestamps and nullable price", async () => {
    const from = new Date("2026-11-20T14:30:00.000Z");
    const to = new Date("2026-11-20T21:15:00.000Z");
    const m1 = new Date("2026-11-20T14:30:00.000Z");
    const m2Iso = "2026-11-20T14:31:00.000Z";
    const double = createDouble([
      [
        {
          callPremium: "250000",
          callPrints: "2",
          callVolume: "50",
          lastPrice: "661.25",
          lastTradedAt: new Date("2026-11-20T14:30:42.000Z"),
          minute: m1,
          putPremium: "125000",
          putPrints: "1",
          putVolume: "30",
        },
        {
          callPremium: 0,
          callPrints: 0,
          callVolume: 0,
          lastPrice: null,
          lastTradedAt: "2026-11-20T14:31:15.000Z",
          minute: m2Iso,
          putPremium: 50_000,
          putPrints: 1,
          putVolume: 20,
        },
      ],
    ]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readOptionPrintMinutes({ from, symbol: "SPY", to })
    ).resolves.toEqual([
      {
        callPremium: 250_000,
        callPrints: 2,
        callVolume: 50,
        lastPrice: 661.25,
        lastTradedAt: new Date("2026-11-20T14:30:42.000Z"),
        minute: m1,
        putPremium: 125_000,
        putPrints: 1,
        putVolume: 30,
      },
      {
        callPremium: 0,
        callPrints: 0,
        callVolume: 0,
        lastPrice: null,
        lastTradedAt: new Date("2026-11-20T14:31:15.000Z"),
        minute: new Date(m2Iso),
        putPremium: 50_000,
        putPrints: 1,
        putVolume: 20,
      },
    ]);
    const [select] = double.operations;
    expect(select?.table).toBe(flowOptionPrints);
    expect(whereOf(select).sql).toContain('"symbol" = $1');
    expect(whereOf(select).sql).toContain('"traded_at" >= $2');
    expect(whereOf(select).sql).toContain('"traded_at" < $3');
    expect(whereOf(select).params).toEqual([
      "SPY",
      from.toISOString(),
      to.toISOString(),
    ]);
    expect(select?.groupBy).toHaveLength(1);
    expect(dialect.sqlToQuery(select?.groupBy?.[0] as SQL).sql).toContain(
      "date_trunc('minute'"
    );
    expect(dialect.sqlToQuery(select?.orderBy?.[0] as SQL).sql).toContain(
      "asc"
    );
  });
});

describe("createFlowRepository.readOptionPrintDays", () => {
  it("groups regular-hours weekday option prints by New York session date, keeps newest limit, and returns oldest first", async () => {
    const from = new Date("2026-11-01T14:30:00.000Z");
    const to = new Date("2026-11-20T21:15:00.000Z");
    const double = createDouble([
      [
        {
          callPremium: "500000",
          callPrints: "5",
          callVolume: "100",
          lastPrice: "662.5",
          putPremium: "600000",
          putPrints: "6",
          putVolume: "120",
          session: "2026-11-20",
        },
        {
          callPremium: "400000",
          callPrints: "4",
          callVolume: "80",
          lastPrice: null,
          putPremium: "300000",
          putPrints: "3",
          putVolume: "60",
          session: "2026-11-19",
        },
      ],
    ]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readOptionPrintDays({ from, limit: 20, symbol: "ES", to })
    ).resolves.toEqual([
      {
        callPremium: 400_000,
        callPrints: 4,
        callVolume: 80,
        lastPrice: null,
        putPremium: 300_000,
        putPrints: 3,
        putVolume: 60,
        session: "2026-11-19",
      },
      {
        callPremium: 500_000,
        callPrints: 5,
        callVolume: 100,
        lastPrice: 662.5,
        putPremium: 600_000,
        putPrints: 6,
        putVolume: 120,
        session: "2026-11-20",
      },
    ]);
    const [select] = double.operations;
    expect(select?.table).toBe(flowOptionPrints);
    expect(select?.limit).toBe(20);
    const where = whereOf(select);
    expect(where.sql).toContain('"symbol" = $1');
    expect(where.sql).toContain("America/New_York");
    expect(where.sql).toContain("extract(isodow from");
    expect(where.sql).toContain("09:30:00");
    expect(where.sql).toContain("16:15:00");
    expect(where.params).toEqual(["ES", from.toISOString(), to.toISOString()]);
    expect(dialect.sqlToQuery(select?.orderBy?.[0] as SQL).sql).toContain(
      "desc"
    );
  });
});

describe("createFlowRepository.readOptionPrintStrikeBuckets", () => {
  it("groups by strike, slotIndex, right and side and normalizes numbers and dates", async () => {
    const from = new Date("2026-11-20T14:30:00.000Z");
    const to = new Date("2026-11-20T21:15:00.000Z");
    const double = createDouble([
      [
        {
          lastTradedAt: "2026-11-20T14:44:59.000Z",
          premium: "200000",
          prints: "2",
          right: "call",
          side: "ask",
          slotIndex: "0",
          strike: "600",
          volume: "200",
        },
      ],
    ]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readOptionPrintStrikeBuckets({
        bucketMinutes: 15,
        from,
        symbol: "SPY",
        to,
      })
    ).resolves.toEqual([
      {
        lastTradedAt: new Date("2026-11-20T14:44:59.000Z"),
        premium: 200_000,
        prints: 2,
        right: "call",
        side: "ask",
        slotIndex: 0,
        strike: 600,
        volume: 200,
      },
    ]);
    const [select] = double.operations;
    expect(select?.table).toBe(flowOptionPrints);
    expect(select?.groupBy).toHaveLength(4);
    expect(select?.orderBy).toHaveLength(4);
    const where = whereOf(select);
    expect(where.params).toEqual(["SPY", from.toISOString(), to.toISOString()]);
  });

  it("rejects invalid bucketMinutes or invalid date bounds", async () => {
    const from = new Date("2026-11-20T14:30:00.000Z");
    const to = new Date("2026-11-20T21:15:00.000Z");
    const double = createDouble([]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readOptionPrintStrikeBuckets({
        bucketMinutes: 10 as 15,
        from,
        symbol: "SPY",
        to,
      })
    ).rejects.toThrow(InvalidRepositoryInputError);
    await expect(
      repository.readOptionPrintStrikeBuckets({
        bucketMinutes: 15,
        from: to,
        symbol: "SPY",
        to: from,
      })
    ).rejects.toThrow(InvalidRepositoryInputError);
    await expect(
      repository.readOptionPrintStrikeBuckets({
        bucketMinutes: 15,
        from: new Date("invalid"),
        symbol: "SPY",
        to,
      })
    ).rejects.toThrow(InvalidRepositoryInputError);
  });
});

describe("createFlowRepository.readOptionPrintSlotPrices", () => {
  it("selects distinct slot prices ordered by slotIndex asc, tradedAt desc, id desc", async () => {
    const from = new Date("2026-11-20T14:30:00.000Z");
    const to = new Date("2026-11-20T21:15:00.000Z");
    const double = createDouble([
      [
        {
          price: "600.55",
          pricedAt: "2026-11-20T14:44:59.000Z",
          slotIndex: "0",
        },
      ],
    ]);
    const repository = createFlowRepository(double.database);
    await expect(
      repository.readOptionPrintSlotPrices({
        bucketMinutes: 15,
        from,
        symbol: "SPY",
        to,
      })
    ).resolves.toEqual([
      {
        price: 600.55,
        pricedAt: new Date("2026-11-20T14:44:59.000Z"),
        slotIndex: 0,
      },
    ]);
    const [select] = double.operations;
    expect(select?.table).toBe(flowOptionPrints);
    expect(select?.orderBy).toHaveLength(3);
    const where = whereOf(select);
    expect(where.sql).toContain("Infinity");
    expect(where.params).toEqual(["SPY", from.toISOString(), to.toISOString()]);
  });
});

describe("createFlowRepository book snapshots", () => {
  it("upserts snapshots in batches and gives streamed precedence over sampled", async () => {
    const double = createDouble([
      new Array(FLOW_UPSERT_BATCH).fill({ capturedAt: new Date(0) }),
      [{ capturedAt: new Date(5000) }],
    ]);
    const repository = createFlowRepository(double.database);
    const row = (index: number): FlowBookSnapshotRecord => ({
      askPrices: [6000.25],
      askSizes: [30],
      bestAsk: 6000.25,
      bestBid: 6000,
      bidPrices: [6000],
      bidSizes: [20],
      capture: "streamed",
      capturedAt: new Date(1_700_000_000_000 + index * 5000),
      contract: "ESZ6",
      minTick: 0.25,
      symbol: "ES",
    });
    const input = Array.from({ length: FLOW_UPSERT_BATCH + 1 }, (_, index) =>
      row(index)
    );
    await expect(repository.upsertBookSnapshots(input)).resolves.toBe(
      FLOW_UPSERT_BATCH + 1
    );
    expect(double.operations).toHaveLength(2);
    const [first] = double.operations;
    expect(first?.kind).toBe("insert");
    expect(first?.table).toBe(flowBookSnapshots);
    const conflict = first?.conflict as {
      setWhere: SQL;
      target: unknown[];
    };
    expect(conflict.target).toEqual([
      flowBookSnapshots.symbol,
      flowBookSnapshots.capturedAt,
    ]);
    expect(dialect.sqlToQuery(conflict.setWhere)).toEqual({
      params: [],
      sql: "excluded.capture = 'streamed' or \"flow_book_snapshots\".\"capture\" = 'sampled'",
    });
  });

  it("reads snapshots newest-first up to limit and reverses them to ascending order", async () => {
    const newer: FlowBookSnapshotRecord = {
      askPrices: [6001.25],
      askSizes: [15],
      bestAsk: 6001.25,
      bestBid: 6001,
      bidPrices: [6001],
      bidSizes: [12],
      capture: "streamed",
      capturedAt: new Date("2026-11-23T14:30:05.000Z"),
      contract: "ESZ6",
      minTick: 0.25,
      symbol: "ES",
    };
    const older: FlowBookSnapshotRecord = {
      ...newer,
      capturedAt: new Date("2026-11-23T14:30:00.000Z"),
    };
    const double = createDouble([[newer, older]]);
    const repository = createFlowRepository(double.database);
    const from = new Date("2026-11-23T14:00:00.000Z");
    const to = new Date("2026-11-23T15:00:00.000Z");
    const rows = await repository.readBookSnapshots({
      from,
      limit: 5000,
      symbol: "ES",
      to,
    });
    expect(rows).toEqual([older, newer]);
    const [select] = double.operations;
    expect(select?.kind).toBe("select");
    expect(select?.table).toBe(flowBookSnapshots);
    expect(select?.limit).toBe(5000);
    expect(whereOf(select).sql).toContain('"captured_at" >= $2');
    expect(whereOf(select).sql).toContain('"captured_at" < $3');
  });
});
describe("createFlowRepository readMinutes", () => {
  it("reads minute bars of ES or NQ in [from, to) ascending by minute", async () => {
    const bar: FlowMinuteRecord = {
      absorption: null,
      buyVolume: 1200,
      close: 6002.25,
      coveredSeconds: 60,
      delta: 200,
      high: 6003,
      largePrints: 2,
      largePrintVolume: 110,
      low: 6000.5,
      minute: new Date("2026-11-23T14:30:00.000Z"),
      offExchangeVolume: 0,
      open: 6001,
      sellVolume: 1000,
      stackedBuy: 0,
      stackedSell: 0,
      symbol: "ES",
      trades: 420,
      volume: 2200,
      vwap: 6001.75,
    };
    const double = createDouble([[bar]]);
    const repository = createFlowRepository(double.database);
    const from = new Date("2026-11-23T14:00:00.000Z");
    const to = new Date("2026-11-23T15:00:00.000Z");
    await expect(
      repository.readMinutes({ from, symbol: "ES", to })
    ).resolves.toEqual([bar]);
    const [select] = double.operations;
    expect(select?.kind).toBe("select");
    expect(select?.table).toBe(flowMinutes);
    expect(whereOf(select).sql).toContain('"minute" >= $2');
    expect(whereOf(select).sql).toContain('"minute" < $3');
  });
});
