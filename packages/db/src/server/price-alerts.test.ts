import { readFileSync } from "node:fs";
import { asc, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { type PriceAlertRuleRow, priceAlertRules } from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createPriceAlertRepository,
  PRICE_ALERT_RULES_PER_USER_MAX,
  PriceAlertLimitError,
  priceAlertRecordOf,
} from "./price-alerts.ts";

const NOW = new Date("2026-10-13T14:00:00.000Z");
const CREATED = new Date("2026-10-13T13:00:00.000Z");
const dialect = new PgDialect();

interface Operation {
  kind: "select" | "insert" | "update" | "delete";
  limit?: number;
  orderBy?: unknown[];
  set?: Record<string, unknown>;
  table?: unknown;
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
    select: () => builder({ kind: "select" }),
    update: (table: unknown) => builder({ kind: "update", table }),
  } as unknown as Database;
  return { database, operations };
};

const whereOf = (operation: Operation | undefined) => {
  if (operation?.where === undefined) throw new Error("no where clause");
  return dialect.sqlToQuery(operation.where);
};

const row = (
  overrides: Partial<PriceAlertRuleRow> = {}
): PriceAlertRuleRow => ({
  createdAt: CREATED,
  delivery: null,
  id: "rule-1",
  kind: "below",
  lastCheckedAt: null,
  level: "54",
  note: null,
  role: "stop",
  status: "active",
  symbol: "BAC",
  triggeredAt: null,
  triggerPrice: null,
  updatedAt: CREATED,
  userId: "user-a",
  ...overrides,
});

const triggeredRow = row({
  delivery: "pending",
  lastCheckedAt: NOW,
  status: "triggered",
  triggeredAt: NOW,
  triggerPrice: "53.64",
});

const repositoryFor = (double: ReturnType<typeof createDouble>) =>
  createPriceAlertRepository(double.database, {
    generateId: () => "gen-1",
    now: () => NOW,
  });

describe("priceAlertRecordOf", () => {
  it("maps rows to the active or triggered state and rejects an incomplete trigger", () => {
    expect(priceAlertRecordOf(row()).state).toEqual({
      lastCheckedAt: null,
      status: "active",
    });
    expect(priceAlertRecordOf(triggeredRow)).toEqual({
      createdAt: CREATED,
      id: "rule-1",
      kind: "below",
      level: "54",
      note: null,
      role: "stop",
      state: {
        delivery: "pending",
        status: "triggered",
        triggeredAt: NOW,
        triggerPrice: "53.64",
      },
      symbol: "BAC",
      userId: "user-a",
    });
    for (const broken of [
      row({ status: "triggered" }),
      row({ status: "triggered", triggeredAt: NOW }),
      row({ status: "triggered", triggeredAt: NOW, triggerPrice: "1" }),
    ]) {
      expect(() => priceAlertRecordOf(broken)).toThrow(
        "incomplete triggered state"
      );
    }
  });
});

describe("price alert repository", () => {
  it("lists one owner's rules, active first then newest", async () => {
    const double = createDouble([[row(), triggeredRow]]);
    const rules = await repositoryFor(double).listByUser("user-a");
    expect(rules.map((rule) => rule.state.status)).toEqual([
      "active",
      "triggered",
    ]);
    const query = whereOf(double.operations[0]);
    expect(query.sql).toBe('"price_alert_rules"."user_id" = $1');
    expect(query.params).toEqual(["user-a"]);
    expect(double.operations[0]?.limit).toBe(PRICE_ALERT_RULES_PER_USER_MAX);
  });

  it("lists one owner's active rules, least recently attempted first", async () => {
    const double = createDouble([[row()]]);
    await repositoryFor(double).listActiveByUser("user-a");
    const query = whereOf(double.operations[0]);
    expect(query.sql).toBe(
      '("price_alert_rules"."user_id" = $1 and "price_alert_rules"."status" = $2)'
    );
    expect(query.params).toEqual(["user-a", "active"]);
    expect(double.operations[0]?.orderBy).toEqual([
      asc(priceAlertRules.updatedAt),
      asc(priceAlertRules.id),
    ]);
  });

  it("lists active rules of operator owners only, least recently attempted first", async () => {
    const double = createDouble([[row()]]);
    await repositoryFor(double).listActive(7, [
      " Owner@Domain.test ",
      "owner@domain.test",
      "",
      "second@domain.test",
    ]);
    const operation = double.operations[0];
    const query = whereOf(operation);
    expect(query.sql).toBe(
      '("price_alert_rules"."status" = $1 and "price_alert_rules"."user_id" in (select "user"."id" from "user" where "user"."status" = \'active\' and "user"."email_verified" = true and lower("user"."email") in ($2, $3)))'
    );
    expect(query.params).toEqual([
      "active",
      "owner@domain.test",
      "second@domain.test",
    ]);
    expect(operation?.limit).toBe(7);
    expect(operation?.orderBy).toEqual([
      asc(priceAlertRules.updatedAt),
      asc(priceAlertRules.id),
    ]);
  });

  it("lists nothing without a query when no operator email is configured", async () => {
    const double = createDouble([[row()]]);
    const repository = repositoryFor(double);
    await expect(repository.listActive(7, undefined)).resolves.toEqual([]);
    await expect(repository.listActive(7, [" "])).resolves.toEqual([]);
    expect(double.operations).toHaveLength(0);
  });

  it("creates an active rule under the per-owner cap", async () => {
    const double = createDouble([[{ rules: 3 }], [row({ id: "gen-1" })]]);
    const rule = await repositoryFor(double).create({
      kind: "below",
      level: "54",
      note: null,
      role: "stop",
      symbol: "BAC",
      userId: "user-a",
    });
    expect(rule.id).toBe("gen-1");
    expect(whereOf(double.operations[0]).params).toEqual(["user-a"]);
    expect(double.operations[1]).toMatchObject({
      kind: "insert",
      table: priceAlertRules,
      values: {
        createdAt: NOW,
        id: "gen-1",
        kind: "below",
        level: "54",
        note: null,
        role: "stop",
        status: "active",
        symbol: "BAC",
        updatedAt: NOW,
        userId: "user-a",
      },
    });
  });

  it("refuses a rule over the cap and reports an empty insert", async () => {
    const input = {
      kind: "above",
      level: "1",
      note: null,
      role: "price",
      symbol: "AAPL",
      userId: "user-a",
    } as const;
    const full = createDouble([[{ rules: PRICE_ALERT_RULES_PER_USER_MAX }]]);
    await expect(repositoryFor(full).create(input)).rejects.toBeInstanceOf(
      PriceAlertLimitError
    );
    expect(full.operations).toHaveLength(1);
    const empty = createDouble([[], []]);
    await expect(repositoryFor(empty).create(input)).rejects.toThrow(
      "price alert insert returned no row"
    );
  });

  it("removes only the owner's rule", async () => {
    const double = createDouble([[{ id: "rule-1" }], []]);
    const repository = repositoryFor(double);
    await expect(repository.remove("rule-1", "user-a")).resolves.toBe(true);
    await expect(repository.remove("rule-1", "user-b")).resolves.toBe(false);
    const query = whereOf(double.operations[1]);
    expect(query.sql).toBe(
      '("price_alert_rules"."id" = $1 and "price_alert_rules"."user_id" = $2)'
    );
    expect(query.params).toEqual(["rule-1", "user-b"]);
  });

  it("marks active rules checked and skips an empty batch", async () => {
    const double = createDouble([[]]);
    const repository = repositoryFor(double);
    await repository.markChecked([], NOW);
    expect(double.operations).toHaveLength(0);
    await repository.markChecked(["rule-1", "rule-2"], NOW);
    expect(double.operations[0]?.set).toEqual({
      lastCheckedAt: NOW,
      updatedAt: NOW,
    });
    const query = whereOf(double.operations[0]);
    expect(query.sql).toBe(
      '("price_alert_rules"."id" in ($1, $2) and "price_alert_rules"."status" = $3)'
    );
    expect(query.params).toEqual(["rule-1", "rule-2", "active"]);
  });

  it("moves unquoted active rules to the back of the queue and skips an empty batch", async () => {
    const double = createDouble([[]]);
    const repository = repositoryFor(double);
    await repository.markAttempted([]);
    expect(double.operations).toHaveLength(0);
    await repository.markAttempted(["rule-3"]);
    expect(double.operations[0]?.set).toEqual({ updatedAt: NOW });
    expect(whereOf(double.operations[0]).params).toEqual(["rule-3", "active"]);
  });

  it("triggers a rule only while it is still active", async () => {
    const double = createDouble([[triggeredRow], []]);
    const repository = repositoryFor(double);
    const input = { id: "rule-1", triggeredAt: NOW, triggerPrice: "53.64" };
    const rule = await repository.trigger(input);
    expect(rule?.state).toMatchObject({
      delivery: "pending",
      status: "triggered",
    });
    expect(double.operations[0]?.set).toEqual({
      delivery: "pending",
      lastCheckedAt: NOW,
      status: "triggered",
      triggeredAt: NOW,
      triggerPrice: "53.64",
      updatedAt: NOW,
    });
    expect(whereOf(double.operations[0]).params).toEqual(["rule-1", "active"]);
    await expect(repository.trigger(input)).resolves.toBeNull();
  });

  it("settles only pending deliveries and skips an empty batch", async () => {
    const double = createDouble([[{ ...triggeredRow, delivery: "sent" }]]);
    const repository = repositoryFor(double);
    await expect(repository.recordDelivery([], "sent")).resolves.toEqual([]);
    const settled = await repository.recordDelivery(["rule-1"], "sent");
    expect(settled[0]?.state).toMatchObject({ delivery: "sent" });
    expect(double.operations[0]?.set).toEqual({
      delivery: "sent",
      updatedAt: NOW,
    });
    expect(whereOf(double.operations[0]).params).toEqual([
      "rule-1",
      "triggered",
      "pending",
    ]);
  });
});

describe("0040_price_alert_rules migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0040_price_alert_rules.sql");
  const rollback = read("../../rollback/0040_price_alert_rules.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: Array<{ idx: number; tag: string }>;
  };

  it("creates the owner-scoped table with its state check", () => {
    expect(migration).toContain('CREATE TABLE "price_alert_rules"');
    expect(migration).toContain("price_alert_rules_state_check");
    expect(migration).toContain(
      'REFERENCES "public"."user"("id") ON DELETE cascade'
    );
    expect(
      journal.entries.find((entry) => entry.tag === "0040_price_alert_rules")
    ).toMatchObject({ idx: 40 });
  });

  it("grants the app role the repository privileges only when the role exists", () => {
    expect(migration).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN"
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "price_alert_rules" TO "vertex_research";'
    );
  });

  it("rollback refuses while rules exist and never cascades", () => {
    expect(rollback).toContain(
      "price_alert_rules is not empty; refusing rollback"
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});
