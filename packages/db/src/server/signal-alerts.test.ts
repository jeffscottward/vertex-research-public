import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  type SignalAlertEventRow,
  type SignalAlertRuleRow,
  signalAlertEvents,
  signalAlertRules,
} from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createSignalAlertRepository,
  SIGNAL_ALERT_RULES_PER_USER_MAX,
  SignalAlertLimitError,
  signalAlertRecordOf,
} from "./signal-alerts.ts";

const NOW = new Date("2026-11-02T15:00:00.000Z");
const CREATED = new Date("2026-11-02T13:00:00.000Z");
const BAR = new Date("2026-11-02T14:45:00.000Z");
const dialect = new PgDialect();

interface Operation {
  kind: "select" | "insert" | "update" | "delete";
  conflict?: unknown;
  join?: unknown;
  limit?: number;
  orderBy?: unknown[];
  set?: Record<string, unknown>;
  table?: unknown;
  values?: Record<string, unknown>;
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
      innerJoin: (table: unknown) => {
        operation.join = table;
        return chain;
      },
      limit: (limit: number) => {
        operation.limit = limit;
        return chain;
      },
      onConflictDoNothing: (conflict: unknown) => {
        operation.conflict = conflict;
        return chain;
      },
      orderBy: (...order: unknown[]) => {
        operation.orderBy = order;
        return chain;
      },
      returning: () => chain,
      set: (values: Record<string, unknown>) => {
        operation.set = values;
        return chain;
      },
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(outcomes.shift() ?? []).then(resolve),
      values: (values: Record<string, unknown>) => {
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
    select: () => builder({ kind: "select" }),
    update: (table: unknown) => builder({ kind: "update", table }),
  } as unknown as Database;
  return { database, operations };
};

const whereOf = (operation: Operation | undefined) => {
  if (operation?.where === undefined) throw new Error("no where clause");
  return dialect.sqlToQuery(operation.where);
};

const condition = {
  left: { field: "close", type: "price" },
  operator: "crosses-above",
  right: { type: "value", value: "10" },
};

const row = (
  overrides: Partial<SignalAlertRuleRow> = {}
): SignalAlertRuleRow => ({
  condition,
  createdAt: CREATED,
  fireCount: 0,
  frequency: "per-bar-close",
  id: "rule-1",
  kind: "alert",
  lastBarAt: null,
  lastCheckedAt: null,
  lastFiredAt: null,
  lastFiredBarAt: null,
  name: "SPY alert",
  origin: "manual",
  status: "active",
  symbol: "SPY",
  timeframe: "15m",
  updatedAt: CREATED,
  userId: "user-a",
  ...overrides,
});

const eventRow = (
  overrides: Partial<SignalAlertEventRow> = {}
): SignalAlertEventRow => ({
  barAt: BAR,
  delivery: "pending",
  firedAt: NOW,
  id: "gen-1",
  price: "11",
  ruleId: "rule-1",
  userId: "user-a",
  ...overrides,
});

const repositoryFor = (double: ReturnType<typeof createDouble>) =>
  createSignalAlertRepository(double.database, {
    generateId: () => "gen-1",
    now: () => NOW,
  });

describe("signalAlertRecordOf", () => {
  it("maps a row without the update timestamp", () => {
    const { updatedAt: _updatedAt, ...rest } = row();
    expect(signalAlertRecordOf(row())).toEqual(rest);
  });
});

describe("createSignalAlertRepository", () => {
  it("creates a rule under the per-owner limit and refuses past it", async () => {
    const double = createDouble([[{ rules: 0 }], [row()]]);
    const created = await repositoryFor(double).create({
      condition,
      frequency: "per-bar-close",
      kind: "alert",
      name: "SPY alert",
      origin: "manual",
      status: "active",
      symbol: "SPY",
      timeframe: "15m",
      userId: "user-a",
    });
    expect(created.id).toBe("rule-1");
    expect(double.operations[1]?.values).toMatchObject({
      createdAt: NOW,
      id: "gen-1",
      status: "active",
      updatedAt: NOW,
    });
    const full = createDouble([[{ rules: SIGNAL_ALERT_RULES_PER_USER_MAX }]]);
    await expect(
      repositoryFor(full).create({
        condition,
        frequency: "once",
        kind: "watch",
        name: "x",
        origin: "quant",
        status: "proposed",
        symbol: "SPY",
        timeframe: "1d",
        userId: "user-a",
      })
    ).rejects.toBeInstanceOf(SignalAlertLimitError);
    const empty = createDouble([[], []]);
    await expect(
      repositoryFor(empty).create({
        condition,
        frequency: "once",
        kind: "alert",
        name: "x",
        origin: "manual",
        status: "active",
        symbol: "SPY",
        timeframe: "1d",
        userId: "user-a",
      })
    ).rejects.toThrow("signal alert insert returned no row");
  });

  it("lists active rules of operator owners only, least recently attempted first", async () => {
    expect(await repositoryFor(createDouble([])).listActive(10, [])).toEqual(
      []
    );
    expect(
      await repositoryFor(createDouble([])).listActive(10, undefined)
    ).toEqual([]);
    const double = createDouble([[row()]]);
    const rules = await repositoryFor(double).listActive(10, [
      " Owner@Domain.test ",
      "owner@domain.test",
      "",
    ]);
    expect(rules.map((rule) => rule.id)).toEqual(["rule-1"]);
    const query = whereOf(double.operations[0]);
    expect(query.sql).toContain("lower(");
    expect(query.params).toEqual(["active", "owner@domain.test"]);
    expect(double.operations[0]?.limit).toBe(10);
  });

  it("lists by owner and active by owner", async () => {
    const double = createDouble([[row()], [row({ id: "rule-2" })]]);
    const repository = repositoryFor(double);
    expect((await repository.listByUser("user-a"))[0]?.id).toBe("rule-1");
    expect((await repository.listActiveByUser("user-a"))[0]?.id).toBe("rule-2");
    expect(whereOf(double.operations[0]).params).toEqual(["user-a"]);
    expect(whereOf(double.operations[1]).params).toEqual(["user-a", "active"]);
  });

  it("lists events with the rule name, optionally after a time", async () => {
    const event = {
      barAt: BAR,
      delivery: "sent",
      firedAt: NOW,
      id: "event-1",
      kind: "alert",
      name: "SPY alert",
      price: "11",
      ruleId: "rule-1",
      symbol: "SPY",
      userId: "user-a",
    };
    const double = createDouble([[event], []]);
    const repository = repositoryFor(double);
    expect(await repository.listEvents("user-a", null, 5)).toEqual([event]);
    expect(double.operations[0]?.join).toBe(signalAlertRules);
    expect(whereOf(double.operations[0]).params).toEqual(["user-a"]);
    await repository.listEvents("user-a", CREATED, 5);
    expect(whereOf(double.operations[1]).params).toEqual([
      "user-a",
      CREATED.toISOString(),
    ]);
  });

  it("marks checks and attempts on active rules only", async () => {
    const double = createDouble([[], []]);
    const repository = repositoryFor(double);
    await repository.markAttempted([]);
    expect(double.operations).toHaveLength(0);
    await repository.markAttempted(["rule-1"]);
    await repository.markChecked("rule-1", BAR, NOW);
    expect(double.operations[0]?.set).toEqual({ updatedAt: NOW });
    expect(double.operations[1]?.set).toEqual({
      lastBarAt: BAR,
      lastCheckedAt: NOW,
      updatedAt: NOW,
    });
    expect(whereOf(double.operations[1]).params).toEqual(["rule-1", "active"]);
  });

  it("settles pending deliveries once", async () => {
    const double = createDouble([[]]);
    const repository = repositoryFor(double);
    await repository.recordDelivery([], "sent");
    expect(double.operations).toHaveLength(0);
    await repository.recordDelivery(["event-1"], "failed");
    expect(double.operations[0]?.table).toBe(signalAlertEvents);
    expect(double.operations[0]?.set).toEqual({ delivery: "failed" });
    expect(whereOf(double.operations[0]).params).toEqual([
      "event-1",
      "pending",
    ]);
  });

  it("records a fire once per bar and finishes once rules", async () => {
    const double = createDouble([[row()], [eventRow()], []]);
    const fired = await repositoryFor(double).recordFire({
      barAt: BAR,
      done: true,
      firedAt: NOW,
      price: "11",
      ruleId: "rule-1",
      userId: "user-a",
    });
    expect(fired).toEqual({
      barAt: BAR,
      delivery: "pending",
      firedAt: NOW,
      id: "gen-1",
      kind: "alert",
      name: "SPY alert",
      price: "11",
      ruleId: "rule-1",
      symbol: "SPY",
      userId: "user-a",
    });
    expect(double.operations[1]?.conflict).toEqual({
      target: [signalAlertEvents.ruleId, signalAlertEvents.barAt],
    });
    expect(double.operations[2]?.set).toMatchObject({
      lastFiredAt: NOW,
      lastFiredBarAt: BAR,
      status: "done",
    });

    const repeat = createDouble([[row()], []]);
    expect(
      await repositoryFor(repeat).recordFire({
        barAt: BAR,
        done: false,
        firedAt: NOW,
        price: "11",
        ruleId: "rule-1",
        userId: "user-a",
      })
    ).toBeNull();
    expect(repeat.operations).toHaveLength(2);

    const gone = createDouble([[]]);
    expect(
      await repositoryFor(gone).recordFire({
        barAt: BAR,
        done: false,
        firedAt: NOW,
        price: "11",
        ruleId: "rule-1",
        userId: "user-a",
      })
    ).toBeNull();

    const kept = createDouble([[row()], [eventRow()], []]);
    await repositoryFor(kept).recordFire({
      barAt: BAR,
      done: false,
      firedAt: NOW,
      price: "11",
      ruleId: "rule-1",
      userId: "user-a",
    });
    expect(kept.operations[2]?.set).not.toHaveProperty("status");
  });

  it("removes and transitions owned rules", async () => {
    const double = createDouble([
      [{ id: "rule-1" }],
      [],
      [row({ status: "dismissed" })],
      [],
    ]);
    const repository = repositoryFor(double);
    expect(await repository.remove("rule-1", "user-a")).toBe(true);
    expect(await repository.remove("rule-1", "user-a")).toBe(false);
    expect(
      (await repository.transition("rule-1", "user-a", ["active"], "dismissed"))
        ?.status
    ).toBe("dismissed");
    expect(whereOf(double.operations[2]).params).toEqual([
      "rule-1",
      "user-a",
      "active",
    ]);
    expect(
      await repository.transition("rule-1", "user-a", ["proposed"], "active")
    ).toBeNull();
    expect(
      await repository.transition("rule-1", "user-a", [], "active")
    ).toBeNull();
    expect(double.operations).toHaveLength(4);
  });
});
