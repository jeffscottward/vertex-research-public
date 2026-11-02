import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  assistantActions,
  strategyDefinitionRevisions,
} from "../schema/index.ts";
import type { Database } from "./client.ts";
import { createRepositories } from "./repositories.ts";
import {
  createStrategyDefinitionsRepository,
  STRATEGY_DEFINITION_HISTORY_LIST_MAX,
  STRATEGY_DEFINITIONS_LIST_MAX,
} from "./strategy-definitions.ts";

const FIXED_NOW = new Date("2026-10-23T12:00:00.000Z");
const dialect = new PgDialect();

interface Operation {
  kind: string;
  values?: unknown;
  where?: SQL | undefined;
  limit?: number;
  columns?: unknown;
  conflict?: unknown;
}

const createDouble = (outcomes: Array<readonly unknown[]>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: (condition: SQL | undefined) => {
        operation.where = condition;
        return chain;
      },
      orderBy: () => chain,
      limit: (count: number) => {
        operation.limit = count;
        return chain;
      },
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      onConflictDoNothing: (config: unknown) => {
        operation.conflict = config;
        return chain;
      },
      returning: () => chain,
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(outcomes.shift() ?? []).then(resolve),
    };
    operations.push(operation);
    return chain;
  };
  const database = {
    select: (columns?: unknown) => builder({ kind: "select", columns }),
    insert: () => builder({ kind: "insert" }),
  } as unknown as Database;
  return { database, operations };
};

const sqlText = (condition: SQL | undefined) =>
  condition === undefined ? "" : dialect.sqlToQuery(condition).sql;

const dependencies = { now: () => FIXED_NOW, generateId: () => "row-1" };

describe("createStrategyDefinitionsRepository", () => {
  it("inserts one revision and returns null when the revision is taken", async () => {
    const { database, operations } = createDouble([[{ id: "row-1" }], []]);
    const repository = createStrategyDefinitionsRepository(
      database,
      dependencies
    );
    const input = {
      definitionId: "def-1",
      revision: 2,
      sha256: "a".repeat(64),
      name: "SMA",
      definition: { version: 1 },
      note: null,
      createdBy: "user-1",
    };
    await expect(repository.insert(input)).resolves.toEqual({ id: "row-1" });
    await expect(repository.insert(input)).resolves.toBeNull();
    expect(operations[0]?.values).toEqual({
      ...input,
      id: "row-1",
      createdAt: FIXED_NOW,
    });
    expect(operations[0]?.conflict).toEqual({
      target: [
        strategyDefinitionRevisions.definitionId,
        strategyDefinitionRevisions.revision,
      ],
    });
  });

  it("reads the latest revision, one revision or null", async () => {
    const { database, operations } = createDouble([
      [{ revision: 3 }],
      [],
      [{ revision: 2 }],
      [],
    ]);
    const repository = createStrategyDefinitionsRepository(
      database,
      dependencies
    );
    await expect(repository.latest("def-1")).resolves.toEqual({ revision: 3 });
    await expect(repository.latest("missing")).resolves.toBeNull();
    await expect(repository.get("def-1", 2)).resolves.toEqual({ revision: 2 });
    await expect(repository.get("def-1", 9)).resolves.toBeNull();
    expect(operations[0]?.limit).toBe(1);
    expect(sqlText(operations[2]?.where)).toContain(
      '"strategy_definition_revisions"."revision"'
    );
  });

  it("bounds history and list limits and lists only latest revisions", async () => {
    const { database, operations } = createDouble([[], [], [], []]);
    const repository = createStrategyDefinitionsRepository(
      database,
      dependencies
    );
    await repository.history("def-1", 999);
    await repository.history("def-1", 0);
    await repository.listLatest(999);
    await repository.listLatest(2.7);
    expect(operations[0]?.limit).toBe(STRATEGY_DEFINITION_HISTORY_LIST_MAX);
    expect(operations[1]?.limit).toBe(1);
    expect(Object.keys(operations[0]?.columns as object)).not.toContain(
      "definition"
    );
    expect(operations[2]?.limit).toBe(STRATEGY_DEFINITIONS_LIST_MAX);
    expect(operations[3]?.limit).toBe(2);
    expect(sqlText(operations[2]?.where)).toContain(
      "select max(other.revision)"
    );
  });

  it("is part of the repository set", () => {
    const repositories = createRepositories({} as Database);
    expect(repositories.strategyDefinitions).toBeDefined();
    expect(repositories.assistantActions).toBeDefined();
  });
});

describe("0029_ai_builder schema and migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0029_ai_builder.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0029_ai_builder.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: Array<{ idx: number; tag: string }> };

  it("creates both tables with checks and is journaled last", () => {
    expect(migration).toContain('CREATE TABLE "assistant_actions"');
    expect(migration).toContain('CREATE TABLE "strategy_definition_revisions"');
    expect(migration).toContain(
      "strategy_definition_revisions_revision_unique_idx"
    );
    expect(migration).not.toMatch(/DROP |DELETE FROM/i);
    expect(
      journal.entries.find(
        (entry: { tag: string }) => entry.tag === "0029_ai_builder"
      )
    ).toMatchObject({
      idx: 29,
      tag: "0029_ai_builder",
    });
  });

  it("rollback refuses while rows exist and never cascades", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });

  it("declares the revision table's indexes and checks", () => {
    const revisions = getTableConfig(strategyDefinitionRevisions);
    expect(revisions.indexes.map((entry) => entry.config.name)).toEqual([
      "strategy_definition_revisions_revision_unique_idx",
      "strategy_definition_revisions_created_idx",
    ]);
    expect(revisions.checks.map((entry) => entry.name)).toEqual([
      "strategy_definition_revisions_revision_check",
      "strategy_definition_revisions_sha_check",
      "strategy_definition_revisions_text_check",
      "strategy_definition_revisions_definition_check",
    ]);
    expect(revisions.foreignKeys).toEqual([]);
  });

  it("deletes actions with their thread, message and owner", () => {
    const config = getTableConfig(assistantActions);
    expect(config.foreignKeys.map((key) => key.onDelete)).toEqual([
      "cascade",
      "cascade",
      "cascade",
    ]);
    expect(
      config.foreignKeys
        .map((key) => getTableConfig(key.reference().foreignTable).name)
        .sort()
    ).toEqual(["assistant_messages", "assistant_threads", "user"]);
    expect(config.indexes.map((entry) => entry.config.name)).toEqual([
      "assistant_actions_thread_idx",
    ]);
    expect(config.checks.map((check) => check.name)).toContain(
      "assistant_actions_decided_check"
    );
  });
});
