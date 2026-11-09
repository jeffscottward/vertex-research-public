import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  assistantMessages,
  assistantThreads,
  assistantUsage,
} from "../schema/index.ts";
import {
  ASSISTANT_DEFAULT_THREAD_TITLE,
  AssistantRecordInputError,
  assistantBudgetDay,
  normalizeAssistantContent,
  normalizeAssistantThreadTitle,
  normalizeAssistantToolTrace,
} from "./assistant-records.ts";
import type { Database } from "./client.ts";
import { createAssistantRepository } from "./repositories.ts";
import { InvalidRepositoryInputError } from "./repository-errors.ts";

const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");
const dialect = new PgDialect();

describe("0022 assistant migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0022_assistant.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0022_assistant.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  it("is idempotent and matches the drizzle columns, checks and indexes of all three tables", () => {
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(
      /^\s*(GRANT|TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    for (const table of [assistantThreads, assistantMessages, assistantUsage]) {
      const config = getTableConfig(table);
      const start = migration.indexOf(
        `CREATE TABLE IF NOT EXISTS "${config.name}" (`
      );
      expect(start).toBeGreaterThanOrEqual(0);
      const body = migration.slice(start, migration.indexOf("\n);", start));
      const sqlColumns = [...body.matchAll(/^\s{2}"([a-z_]+)" /gm)].map(
        (match) => match[1]
      );
      expect([...sqlColumns].sort()).toEqual(
        config.columns.map((column) => column.name).sort()
      );
      for (const index of config.indexes) {
        expect(migration).toContain(
          `CREATE INDEX IF NOT EXISTS "${index.config.name}" ON "${config.name}"`
        );
      }
      for (const check of config.checks) {
        expect(body).toContain(
          `CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`
        );
      }
    }
    expect(migration).toContain(
      'FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("thread_id") REFERENCES "public"."assistant_threads"("id") ON DELETE cascade'
    );
    return expect(migration).toContain(
      'CONSTRAINT "assistant_usage_pk" PRIMARY KEY ("user_id","day")'
    );
  });

  it("is journaled as idx 22 after 0021 and before the upstream appearance migrations", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0022_assistant"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 22 });
    expect(journal.entries[index - 1]).toMatchObject({
      idx: 21,
      tag: "0021_deployment_requests",
    });
    // Upstream appearance migrations (0023, 0024) are appended after the Vertex ledger.
    return expect(
      journal.entries.slice(index + 1).map((entry) => entry.tag)
    ).toEqual([
      "0023_appearance_preferences",
      "0024_shadcn_themes",
      "0025_market_bars",
      "0026_backtest_runs",
      "0027_forward_drift",
      "0028_paper_forward_runner",
      "0029_ai_builder",
      "0030_todos",
      "0031_strategy_catalog",
      "0032_strategy_catalog_carousel",
      "0033_strategy_catalog_quantjourney",
      "0034_autopilot",
      "0035_strategy_catalog_sma30_timing",
      "0036_backtest_rating_series",
      "0037_agent_model_runs",
      "0038_agent_model_run_events",
      "0039_app_role_grants",
      "0040_price_alert_rules",
      "0041_baskets",
      "0042_basket_benchmark_base",
      "0043_quant_lab",
      "0044_research_reports",
      "0045_market_bar_futures_symbols",
      "0046_click_log",
      "0047_sector_rotation",
      "0048_pick_lists",
      "0049_signal_alerts",
      "0050_plays",
      "0051_research_studies",
      "0052_flow_pipeline",
      "0053_flow_option_gaps",
      "0054_agent_model_run_grants",
      "0055_strategy_catalog_calendar_spread",
      "0056_semantic_layer",
      "0057_strategy_catalog_qc_ports",
      "0058_semantic_unlinked_runs",
      "0059_strategy_catalog_ld34",
    ]);
  });

  return it("rollback refuses while any assistant row exists and never cascades", () => {
    expect(rollback).toContain(
      "assistant tables are not empty; refusing rollback"
    );
    for (const table of [
      "assistant_threads",
      "assistant_messages",
      "assistant_usage",
    ]) {
      expect(rollback).toContain(`SELECT 1 FROM "public"."${table}"`);
      expect(rollback).toContain(`DROP TABLE "public"."${table}"`);
    }
    return expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});

describe("assistant record rules", () => {
  it("normalizes thread titles", () => {
    expect(normalizeAssistantThreadTitle(undefined)).toBe(
      ASSISTANT_DEFAULT_THREAD_TITLE
    );
    expect(normalizeAssistantThreadTitle("   ")).toBe(
      ASSISTANT_DEFAULT_THREAD_TITLE
    );
    expect(normalizeAssistantThreadTitle("  Summarize\n my   backtests ")).toBe(
      "Summarize my backtests"
    );
    expect(normalizeAssistantThreadTitle("x".repeat(300))).toHaveLength(120);
    return expect(() => normalizeAssistantThreadTitle(3)).toThrow(
      AssistantRecordInputError
    );
  });

  it("requires non-blank user content and caps length", () => {
    expect(normalizeAssistantContent("hi\u0000", "user")).toBe("hi");
    expect(normalizeAssistantContent("", "assistant")).toBe("");
    expect(() => normalizeAssistantContent("  ", "user")).toThrow(
      "content must not be blank"
    );
    return expect(() =>
      normalizeAssistantContent("x".repeat(32_001), "assistant")
    ).toThrow(/32000/);
  });

  it("keeps trace summaries short and well-formed", () => {
    expect(
      normalizeAssistantToolTrace([
        {
          args: "x".repeat(400),
          durationMs: 12.4,
          error: null,
          ok: true,
          tool: "tasks_list",
        },
      ])
    ).toEqual([
      {
        args: "x".repeat(300),
        durationMs: 12,
        error: null,
        ok: true,
        tool: "tasks_list",
      },
    ]);
    expect(() =>
      normalizeAssistantToolTrace([
        { args: "", durationMs: 1, ok: true, tool: "Bad Name" },
      ])
    ).toThrow(/tool name/);
    return expect(() =>
      normalizeAssistantToolTrace(
        new Array(65).fill({
          args: "",
          durationMs: 1,
          ok: true,
          tool: "summary",
        })
      )
    ).toThrow(/at most 64/);
  });

  it("keeps a chart tool's artifact object and refuses a non-object one", () => {
    const artifact = { kind: "chart_clear", symbol: "ES" };
    expect(
      normalizeAssistantToolTrace([
        {
          args: "{}",
          artifact,
          durationMs: 1,
          error: null,
          ok: true,
          tool: "chart_clear_drawings",
        },
      ])
    ).toEqual([
      {
        args: "{}",
        artifact,
        durationMs: 1,
        error: null,
        ok: true,
        tool: "chart_clear_drawings",
      },
    ]);
    expect(
      normalizeAssistantToolTrace([
        {
          args: `${"é".repeat(299)}\uD83D\uDE00`,
          artifact: {
            kind: "teach",
            steps: [{ body: "line 1\n\tline 2\u0001 😀", title: "T\u007f" }],
            topic: "Lev\u0000els\uD83D",
          },
          durationMs: 1,
          error: "bad\u0000\uD83D",
          ok: true,
          tool: "teach_steps",
        },
      ])
    ).toEqual([
      {
        // Cut at 300 code units inside the emoji: the lone half is removed.
        args: "é".repeat(299),
        artifact: {
          kind: "teach",
          steps: [{ body: "line 1\n\tline 2 😀", title: "T" }],
          topic: "Levels",
        },
        durationMs: 1,
        error: "bad ",
        ok: true,
        tool: "teach_steps",
      },
    ]);
    return expect(() =>
      normalizeAssistantToolTrace([
        { args: "", artifact: [], durationMs: 1, ok: true, tool: "chart_draw" },
      ])
    ).toThrow(/artifact must be an object/);
  });

  return it("uses UTC calendar days for the budget", () =>
    expect(assistantBudgetDay(new Date("2026-01-02T23:59:59.000-05:00"))).toBe(
      "2026-01-03"
    ));
});

type Row = Record<string, unknown>;
interface Operation {
  conflict?: Row;
  kind: string;
  set?: Row;
  values?: Row;
}

// Minimal executor double: each awaited query consumes the next outcome; writes are recorded.
const createDouble = (outcomes: Array<readonly Row[] | Error>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      limit: () => chain,
      onConflictDoUpdate: (config: Row) => {
        operation.conflict = config;
        return chain;
      },
      orderBy: () => chain,
      returning: () => chain,
      set: (values: Row) => {
        operation.set = values;
        return chain;
      },
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
      values: (values: Row) => {
        operation.values = values;
        return chain;
      },
      where: () => chain,
    };
    operations.push(operation);
    return chain;
  };
  const database: Record<string, unknown> = {
    insert: () => builder({ kind: "insert" }),
    select: () => builder({ kind: "select" }),
    update: () => builder({ kind: "update" }),
  };
  database["transaction"] = (
    operation: (transaction: unknown) => Promise<unknown>
  ) => operation(database);
  return { database: database as unknown as Database, operations };
};

const repositoryFor = (outcomes: Array<readonly Row[] | Error>) => {
  const double = createDouble(outcomes);
  const repository = createAssistantRepository(double.database, {
    generateId: () => "id-1",
    now: () => FIXED_NOW,
  });
  return { operations: double.operations, repository };
};

describe("assistant repository", () => {
  it("creates owner threads with a normalized title", async () => {
    const { repository, operations } = repositoryFor([
      [
        {
          createdAt: FIXED_NOW,
          id: "id-1",
          title: "Hello",
          updatedAt: FIXED_NOW,
          userId: "user-a",
        },
      ],
    ]);
    await repository.createThread({ title: "  Hello ", userId: "user-a" });
    return expect(operations[0]!.values).toEqual({
      createdAt: FIXED_NOW,
      id: "id-1",
      title: "Hello",
      updatedAt: FIXED_NOW,
      userId: "user-a",
    });
  });

  it("appends a message and bumps the thread in one transaction", async () => {
    const { repository, operations } = repositoryFor([[{ id: "id-1" }], []]);
    await repository.appendMessage({
      content: "Done",
      inputTokens: 120,
      mode: "plan",
      model: "anthropic/claude-sonnet-4.5",
      outputTokens: 30,
      role: "assistant",
      threadId: "t-1",
      toolCalls: [
        {
          args: "{}",
          durationMs: 40,
          error: null,
          ok: true,
          tool: "backtests_list",
        },
      ],
    });
    expect(operations[0]).toMatchObject({
      kind: "insert",
      values: {
        content: "Done",
        inputTokens: 120,
        mode: "plan",
        model: "anthropic/claude-sonnet-4.5",
        outputTokens: 30,
        role: "assistant",
        threadId: "t-1",
      },
    });
    expect(operations[0]!.values!["toolCalls"]).toEqual([
      {
        args: "{}",
        durationMs: 40,
        error: null,
        ok: true,
        tool: "backtests_list",
      },
    ]);
    expect(operations[1]).toMatchObject({
      kind: "update",
      set: { updatedAt: FIXED_NOW },
    });
    await expect(
      repositoryFor([]).repository.appendMessage({
        content: " ",
        mode: "plan",
        role: "user",
        threadId: "t-1",
      })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    return await expect(
      repositoryFor([]).repository.appendMessage({
        content: "x",
        mode: "live" as "plan",
        role: "user",
        threadId: "t-1",
      })
    ).rejects.toThrow(/mode must be one of plan, act/);
  });

  it("lists the latest messages oldest first", async () => {
    const { repository } = repositoryFor([[{ id: "m-2" }, { id: "m-1" }]]);
    return expect(
      (await repository.listMessages("t-1", 2)).map((row) => row.id)
    ).toEqual(["m-1", "m-2"]);
  });

  it("admits a model call with a conditional upsert and reports a refusal as null", async () => {
    const admitted = repositoryFor([
      [{ inputTokens: 10, outputTokens: 5, requests: 3 }],
    ]);
    expect(
      await admitted.repository.reserveRequest({
        day: "2026-01-02",
        maxRequests: 100,
        maxTokens: 1000,
        userId: "user-a",
      })
    ).toEqual({
      day: "2026-01-02",
      inputTokens: 10,
      outputTokens: 5,
      requests: 3,
    });
    const insert = admitted.operations[0]!;
    expect(insert.values).toMatchObject({
      day: "2026-01-02",
      requests: 1,
      userId: "user-a",
    });
    const conflict = insert.conflict!;
    expect(conflict["setWhere"]).toBeDefined();
    const where = dialect.sqlToQuery(
      conflict["setWhere"] as Parameters<typeof dialect.sqlToQuery>[0]
    );
    expect(where.sql).toContain('"assistant_usage"."requests" <');
    expect(where.sql).toContain(
      '"assistant_usage"."input_tokens" + "assistant_usage"."output_tokens" <'
    );
    expect(where.params).toEqual([100, 1000]);

    expect(
      await repositoryFor([[]]).repository.reserveRequest({
        day: "2026-01-02",
        maxRequests: 100,
        maxTokens: 1000,
        userId: "user-a",
      })
    ).toBeNull();
    return await expect(
      repositoryFor([]).repository.reserveRequest({
        day: "2026-1-2",
        maxRequests: 1,
        maxTokens: 1,
        userId: "user-a",
      })
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  return it("records token usage and reads zero usage for an unused day", async () => {
    const { repository, operations } = repositoryFor([[]]);
    await repository.recordTokens({
      day: "2026-01-02",
      inputTokens: 50,
      outputTokens: 7,
      userId: "user-a",
    });
    expect(operations[0]!.kind).toBe("update");
    return expect(
      await repositoryFor([[]]).repository.usage("user-a", "2026-01-02")
    ).toEqual({
      day: "2026-01-02",
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
    });
  });
});
