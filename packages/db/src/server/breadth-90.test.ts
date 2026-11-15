import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  breadth90Days,
  breadth90Events,
  breadth90Status,
} from "../schema/index.ts";
import {
  BREADTH90_STATUS_ID,
  BREADTH90_UPSERT_BATCH,
  type Breadth90DayRecord,
  type Breadth90EventRecord,
  createBreadth90Repository,
} from "./breadth-90.ts";
import type { Database } from "./client.ts";

const NOW = new Date("2026-11-06T21:15:00.000Z");
const dialect = new PgDialect();

interface Operation {
  conflict?: "nothing" | Record<string, unknown>;
  kind: "select" | "insert";
  limit?: number;
  orderBy?: unknown[];
  returning?: boolean;
  table?: unknown;
  target?: unknown[];
  values?: unknown;
  where?: SQL;
}

// Chainable query double: records each operation and resolves the queued rows.
const createDouble = (outcomes: Array<readonly Record<string, unknown>[]>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    operations.push(operation);
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      limit: (limit: number) => {
        operation.limit = limit;
        return chain;
      },
      onConflictDoNothing: (config: { target: unknown[] }) => {
        operation.conflict = "nothing";
        operation.target = config.target;
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
      returning: () => {
        operation.returning = true;
        return chain;
      },
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(outcomes.shift() ?? []).then(resolve),
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
  const transactions: unknown[] = [];
  const database = {
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: () => builder({ kind: "select" }),
    transaction: async (operation: (transaction: unknown) => unknown) => {
      transactions.push(operation);
      return await operation(database);
    },
  } as unknown as Database;
  return { database, operations, transactions };
};

const day = (
  overrides: Partial<Breadth90DayRecord> = {}
): Breadth90DayRecord => ({
  adv: 2400,
  advPct: 82.5,
  date: "2026-11-06",
  decl: 509,
  dvol: 120_000_000,
  final: true,
  kind: "UP_90",
  source: "tradingview",
  sourceAsOf: "2026-11-06T21:10:00.000Z",
  upPct: 91.2,
  uvol: 1_240_000_000,
  ...overrides,
});

const event = (
  overrides: Partial<Breadth90EventRecord> = {}
): Breadth90EventRecord => ({
  advPct: 91,
  armedOn: "2026-10-28",
  date: "2026-11-06",
  grade: "major",
  kind: "FIRED",
  strict: false,
  tier: "major",
  trigger: "UP_90",
  upPct: 92.4,
  ...overrides,
});

const repositoryFor = (database: Database) => {
  let id = 0;
  return createBreadth90Repository(database, {
    generateId: () => {
      id += 1;
      return `event-${id}`;
    },
    now: () => NOW,
  });
};

describe("createBreadth90Repository", () => {
  it("upserts sessions by date in batches and counts the rows written", async () => {
    const days = Array.from(
      { length: BREADTH90_UPSERT_BATCH + 1 },
      (_, index) =>
        day({ date: `2024-01-${String((index % 28) + 1).padStart(2, "0")}` })
    );
    // The second batch's row lost to a stored final session, so nothing came back.
    const double = createDouble([
      days.slice(0, 3).map(({ date }) => ({ date })),
      [],
    ]);
    await expect(repositoryFor(double.database).upsertDays(days)).resolves.toBe(
      3
    );
    expect(double.operations).toHaveLength(2);
    const [first, second] = double.operations;
    expect(first?.table).toBe(breadth90Days);
    expect(first?.values).toHaveLength(BREADTH90_UPSERT_BATCH);
    expect(second?.values).toEqual([{ ...days.at(-1), updatedAt: NOW }]);
    const conflict = first?.conflict as {
      target: unknown;
      set: Record<string, SQL>;
      setWhere?: SQL;
    };
    expect(conflict.target).toBe(breadth90Days.date);
    expect(first?.returning).toBe(true);
    expect(dialect.sqlToQuery(conflict.setWhere as SQL).sql).toBe(
      '"breadth90_days"."final" = false or excluded.final = true'
    );
    expect(Object.keys(conflict.set).sort()).toEqual([
      "adv",
      "advPct",
      "decl",
      "dvol",
      "final",
      "kind",
      "source",
      "sourceAsOf",
      "upPct",
      "updatedAt",
      "uvol",
    ]);
    expect(dialect.sqlToQuery(conflict.set["sourceAsOf"] as SQL).sql).toBe(
      "excluded.source_as_of"
    );
  });

  it("writes nothing for empty sessions or events", async () => {
    const double = createDouble([]);
    const repository = repositoryFor(double.database);
    await expect(repository.upsertDays([])).resolves.toBe(0);
    await expect(repository.recordEvents([])).resolves.toEqual([]);
    expect(double.operations).toHaveLength(0);
  });

  it("lists the newest sessions first", async () => {
    const stored = { ...day(), updatedAt: NOW };
    const double = createDouble([[stored]]);
    await expect(
      createBreadth90Repository(double.database).listRecentDays(31)
    ).resolves.toEqual([stored]);
    const [select] = double.operations;
    expect(select?.table).toBe(breadth90Days);
    expect(select?.limit).toBe(31);
    expect(select?.orderBy).toHaveLength(1);
  });

  it("records events insert-once and returns only the created rows", async () => {
    const created = { ...event(), createdAt: NOW, id: "event-1" };
    const double = createDouble([[created]]);
    const repository = repositoryFor(double.database);
    await expect(
      repository.recordEvents([
        event(),
        event({ kind: "ARMED", tier: "standard" }),
      ])
    ).resolves.toEqual([created]);
    const [insert] = double.operations;
    expect(insert?.table).toBe(breadth90Events);
    expect(insert?.conflict).toBe("nothing");
    expect(insert?.target).toEqual([
      breadth90Events.kind,
      breadth90Events.date,
      breadth90Events.tier,
    ]);
    expect(insert?.returning).toBe(true);
    expect(insert?.values).toEqual([
      { ...event(), createdAt: NOW, id: "event-1" },
      expect.objectContaining({ id: "event-2", kind: "ARMED" }),
    ]);
  });

  it("generates random ids and the current time by default", async () => {
    const double = createDouble([[]]);
    await createBreadth90Repository(double.database).recordEvents([event()]);
    const [row] = (double.operations[0] as Operation).values as {
      id: string;
      createdAt: Date;
    }[];
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it("lists the newest events by date then creation time", async () => {
    const stored = { ...event(), createdAt: NOW, id: "event-1" };
    const double = createDouble([[stored]]);
    await expect(
      createBreadth90Repository(double.database).listRecentEvents(20)
    ).resolves.toEqual([stored]);
    const [select] = double.operations;
    expect(select?.table).toBe(breadth90Events);
    expect(select?.limit).toBe(20);
    expect(select?.orderBy).toHaveLength(2);
  });

  it("saves the single status row with an asOf-ordered update on conflict", async () => {
    const double = createDouble([]);
    const status = {
      armedOn: "2026-10-28",
      asOf: NOW,
      basket: null,
      sessionsLeft: 21,
      state: "ARMED" as const,
      strict: true,
    };
    await repositoryFor(double.database).saveStatus(status);
    const [insert] = double.operations;
    expect(insert?.table).toBe(breadth90Status);
    expect(insert?.values).toEqual({
      ...status,
      id: BREADTH90_STATUS_ID,
      updatedAt: NOW,
    });
    const { setWhere, ...conflict } = (insert as Operation).conflict as {
      setWhere: SQL;
    };
    expect(conflict).toEqual({
      set: { ...status, updatedAt: NOW },
      target: breadth90Status.id,
    });
    expect(dialect.sqlToQuery(setWhere).sql).toBe(
      'excluded.as_of >= "breadth90_status"."as_of"'
    );
  });

  it("reads the status row or null before the first push", async () => {
    const row = {
      armedOn: null,
      asOf: NOW,
      basket: {
        asOf: null,
        reportPath: null,
        rulesNote: null,
        summary: "Dip basket",
        tiers: [],
      },
      id: BREADTH90_STATUS_ID,
      sessionsLeft: null,
      state: "IDLE",
      strict: false,
      updatedAt: NOW,
    };
    const double = createDouble([[row], []]);
    const repository = createBreadth90Repository(double.database);
    const { id: _id, ...expected } = row;
    await expect(repository.getStatus()).resolves.toEqual(expected);
    await expect(repository.getStatus()).resolves.toBeNull();
    expect(double.operations[0]?.table).toBe(breadth90Status);
    expect(double.operations[0]?.limit).toBe(1);
    expect(
      dialect.sqlToQuery(double.operations[0]?.where as SQL).params
    ).toEqual([BREADTH90_STATUS_ID]);
  });

  it("collects a push in one transaction", async () => {
    const created = { ...event(), createdAt: NOW, id: "event-1" };
    const double = createDouble([[{ date: "2026-11-06" }], [created], []]);
    const status = {
      armedOn: null,
      asOf: NOW,
      basket: null,
      sessionsLeft: null,
      state: "IDLE" as const,
      strict: false,
    };
    await expect(
      repositoryFor(double.database).collect({
        days: [day()],
        events: [event()],
        status,
      })
    ).resolves.toEqual({ created: [created], days: 1 });
    expect(double.transactions).toHaveLength(1);
    expect(double.operations.map((operation) => operation.table)).toEqual([
      breadth90Days,
      breadth90Events,
      breadth90Status,
    ]);
    expect(double.operations[1]?.values).toEqual([
      { ...event(), createdAt: NOW, id: "event-1" },
    ]);
  });
});
