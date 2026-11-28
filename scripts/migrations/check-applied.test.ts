import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkAppliedMigrations,
  type DatabaseSnapshot,
  defaultRunGit,
  EXIT_APPLIED,
  EXIT_ERROR,
  EXIT_UNAPPLIED,
  extractMigrationExpectations,
  type GitRunner,
  loadMigrationsFromGit,
  MIGRATIONS_SNAPSHOT_SQL,
  type MigrationSource,
  makeTriggerKey,
  parseIdentToken,
  parsePostgresSnapshot,
  runMigrationCheckCli,
  type SnapshotTrigger,
  splitTopLevel,
  stripSqlComments,
  truncatePgIdent,
} from "./check-applied.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const emptySnapshot = (): DatabaseSnapshot => ({
  appGrants: new Set(),
  columns: new Map(),
  constraints: new Map(),
  functions: new Set(),
  indexes: new Set(),
  ledgerHashes: new Set(),
  roles: new Set(),
  tables: new Set(),
  triggers: new Map(),
});

const buildSnapshot = (
  overrides: Partial<{
    appGrants: string[];
    columns: [string, string][];
    constraints: [string, string][];
    functions: string[];
    indexes: string[];
    ledgerHashes: string[];
    roles: string[];
    tables: string[];
    triggers: [string, SnapshotTrigger][];
  }>
): DatabaseSnapshot => ({
  appGrants: new Set(overrides.appGrants ?? []),
  columns: new Map(overrides.columns ?? []),
  constraints: new Map(overrides.constraints ?? []),
  functions: new Set(overrides.functions ?? []),
  indexes: new Set(overrides.indexes ?? []),
  ledgerHashes: new Set(overrides.ledgerHashes ?? []),
  roles: new Set(overrides.roles ?? []),
  tables: new Set(overrides.tables ?? []),
  triggers: new Map(overrides.triggers ?? []),
});

describe("SQL and identifier helpers", () => {
  it("truncates PostgreSQL identifiers to 63 UTF-8 bytes and folds unquoted names", () => {
    expect(truncatePgIdent("MyTable", false)).toBe("mytable");
    expect(truncatePgIdent("MyTable", true)).toBe("MyTable");
    const longAscii = "a".repeat(80);
    expect(truncatePgIdent(longAscii, true)).toBe("a".repeat(63));
    // Multi-byte UTF-8 character straddling the 63-byte boundary is not split.
    const utf8 = `${"a".repeat(62)}é`;
    expect(truncatePgIdent(utf8, true)).toBe("a".repeat(62));
  });

  it("parses schema-qualified, quoted, escaped-quote, and unquoted identifiers", () => {
    expect(parseIdentToken('"public"."research_screen_rows"')).toBe(
      "research_screen_rows"
    );
    expect(parseIdentToken("public.Research_Rows")).toBe("research_rows");
    expect(parseIdentToken(' "a""b" ')).toBe('a"b');
  });

  it("strips line and block comments while preserving quotes and escaped quotes", () => {
    const sql = [
      "-- leading comment",
      `SELECT 'it''s -- not a comment' AS "col""--name", /* block comment */ 1;`,
      "/* unterminated block",
    ].join("\n");
    expect(stripSqlComments(sql)).toBe(
      `\nSELECT 'it''s -- not a comment' AS "col""--name",   1;\n `
    );
    expect(stripSqlComments("SELECT 1 -- eof without newline")).toBe(
      "SELECT 1 "
    );
    expect(stripSqlComments("SELECT 'unterminated")).toBe(
      "SELECT 'unterminated"
    );
    expect(stripSqlComments('SELECT "unterminated')).toBe(
      'SELECT "unterminated'
    );
    expect(
      stripSqlComments(
        "CREATE FUNCTION f() AS $$ -- keep\nBEGIN PERFORM $1; END; $$;\n-- drop\nSELECT 1;"
      )
    ).toBe(
      "CREATE FUNCTION f() AS $$ -- keep\nBEGIN PERFORM $1; END; $$;\n\nSELECT 1;"
    );
    expect(stripSqlComments("SELECT $1$ -- drop")).toBe("SELECT $1$ ");
  });

  it("splits top-level statements while respecting quotes, parens, and dollar-quoted blocks", () => {
    const sql = `
      CREATE TABLE "t" ("a" text DEFAULT 'x;y', "b" text);
      DO $$ BEGIN GRANT SELECT ON "t" TO "vertex_research"; END $$;
      DO $tag$ BEGIN PERFORM 1; END $tag$;
      SELECT $1, "col"";1" FROM "t" WHERE a = 'it''s';
      DO $$ unterminated
    `;
    const parts = splitTopLevel(sql, ";")
      .map((p) => p.trim())
      .filter(Boolean);
    expect(parts).toHaveLength(5);
    expect(parts[1]).toContain("GRANT SELECT");
    expect(parts[2]).toContain("$tag$");
    expect(parts[3]).toContain("SELECT $1");
  });
});

describe("extractMigrationExpectations", () => {
  it("tracks tables, columns, nullability, indexes, constraints, renames, drops, and grants", () => {
    const migrations: MigrationSource[] = [
      {
        sql: `
          CREATE TABLE "public"."items" (
            "id" text PRIMARY KEY NOT NULL,
            "legacy_col" text,
            "status" text NOT NULL,
            "note" text,
            CONSTRAINT "items_status_check" CHECK ("status" in ('draft', 'live')),
            CONSTRAINT "items_pk" PRIMARY KEY ("id"),
            UNIQUE ("id"),
            ,
            (1 + 1)
          );
          CREATE INDEX "items_status_idx" ON "items" ("status");
          CREATE INDEX "items_legacy_idx" ON "items" ("legacy_col");
          CREATE TABLE "ephemeral" ("x" text);
          ALTER TABLE "ephemeral" ADD COLUMN "y" text;
          ALTER TABLE "ephemeral" ALTER COLUMN "y" SET NOT NULL;
          ALTER TABLE "ephemeral" ADD CONSTRAINT "ephemeral_check" CHECK ("x" in ('a'));
          GRANT SELECT ON TABLE "ephemeral" TO "vertex_research";
        `,
        tag: "0000_init",
      },
      {
        sql: `
          ALTER TABLE "items" ADD COLUMN "extra" text;
          ALTER TABLE "items" DROP COLUMN "legacy_col";
          ALTER TABLE "items" ALTER COLUMN "status" DROP NOT NULL;
          ALTER TABLE "items" ALTER COLUMN "note" SET NOT NULL;
          ALTER TABLE "items" DROP CONSTRAINT "items_status_check";
          ALTER TABLE "items" ADD CONSTRAINT "items_status_check" CHECK ("status" in ('draft', 'live', 'archived', 'has spaces'));
          ALTER TABLE "items" RENAME CONSTRAINT "items_status_check" TO "items_state_check";
          ALTER TABLE "items" ADD CONSTRAINT "items_fk" FOREIGN KEY ("id") REFERENCES "items"("id");
          ALTER TABLE "items" RENAME CONSTRAINT "items_fk" TO "items_self_fk";
          ALTER TABLE "items" DROP CONSTRAINT "nonexistent_con";
          ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;
          DROP INDEX "items_legacy_idx";
          DROP TABLE "ephemeral";
          DO $$
          BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
              GRANT SELECT, INSERT, UPDATE ON TABLE "items" TO "vertex_research";
            END IF;
          END
          $$;
          GRANT SELECT, TRUNCATE ON "items" TO "vertex_research";
        `,
        tag: "0001_evolve",
      },
      {
        sql: `
          -- Replaced check that adds no new literal and a non-check constraint
          ALTER TABLE "items" DROP CONSTRAINT "items_state_check";
          ALTER TABLE "items" ADD CONSTRAINT "items_state_check" CHECK ("status" in ('draft', 'live'));
          ALTER TABLE "items" ADD CONSTRAINT "items_plain_check" CHECK ("extra" is not null);
          -- Unclosed create table edge case (no closing paren)
          CREATE TABLE "broken_paren" ("a" text;
          -- Pure DML seed migration
          INSERT INTO "items" ("id") VALUES ('1') ON CONFLICT DO NOTHING;
        `,
        tag: "0002_seed",
      },
    ];

    const exp = extractMigrationExpectations(migrations);
    expect(exp.tables.get("items")).toBe("0000_init");
    expect(exp.tables.has("ephemeral")).toBe(false);
    expect(exp.columns.get("items.id")).toBe("0000_init");
    expect(exp.columns.get("items.extra")).toBe("0001_evolve");
    expect(exp.columns.has("items.legacy_col")).toBe(false);
    expect(exp.columns.has("ephemeral.x")).toBe(false);
    expect(exp.nullability.get("items.status")).toEqual({
      nullable: "YES",
      tag: "0001_evolve",
    });
    expect(exp.nullability.get("items.note")).toEqual({
      nullable: "NO",
      tag: "0001_evolve",
    });
    expect(exp.indexes.has("items_status_idx")).toBe(true);
    expect(exp.indexes.has("items_legacy_idx")).toBe(false);
    expect(exp.constraints.get("items.items_state_check")).toBe("0002_seed");
    expect(exp.constraints.get("items.items_self_fk")).toBe("0001_evolve");
    expect(exp.grants.get("items:SELECT")).toBe("0001_evolve");
    expect(exp.grants.get("items:INSERT")).toBe("0001_evolve");
    expect(exp.grants.has("items:TRUNCATE")).toBe(false);
    expect(exp.grants.has("ephemeral:SELECT")).toBe(false);
  });

  it("tracks newly-added safe literals on replaced CHECK constraints and handles quotes inside parens", () => {
    const migrations: MigrationSource[] = [
      {
        sql: `CREATE TABLE "trades" (
          "id" text DEFAULT 'a)b' NOT NULL,
          "capture" text NOT NULL,
          CONSTRAINT "trades_check" CHECK ("capture" in ('sampled'))
        );`,
        tag: "0078_trades",
      },
      {
        sql: `
          ALTER TABLE "trades" DROP CONSTRAINT "trades_check";
          ALTER TABLE "trades" ADD CONSTRAINT "trades_check" CHECK ("capture" in ('sampled', 'streamed'));
        `,
        tag: "0083_streamed",
      },
    ];

    const exp = extractMigrationExpectations(migrations);
    expect(exp.columns.get("trades.id")).toBe("0078_trades");
    expect(exp.requiredLiterals.get("trades.trades_check")).toEqual([
      { literal: "streamed", tag: "0083_streamed" },
    ]);
  });

  it("parses all real repository migrations cleanly", () => {
    const loaded = loadMigrationsFromGit(REPO_ROOT, "HEAD");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.migrations.length).toBeGreaterThanOrEqual(95);
    const exp = extractMigrationExpectations(loaded.migrations);
    expect(exp.tables.get("research_screen_bars")).toBe("0076_research_screen");
    expect(exp.tables.get("research_screen_rows")).toBe("0076_research_screen");
    expect(exp.tables.get("flow_book_snapshots")).toBe(
      "0094_flow_book_snapshots"
    );
    expect(exp.grants.get("research_screen_rows:SELECT")).toBe(
      "0076_research_screen"
    );
    expect(exp.grants.get("flow_book_snapshots:DELETE")).toBe(
      "0094_flow_book_snapshots"
    );
    expect(exp.columns.has("user_preferences.mode")).toBe(false);
    expect(exp.columns.has("user_preferences.color_scheme")).toBe(false);
    expect(
      exp.constraints.has("workflow_runs.workflow_runs_owner_id_user_id_fk")
    ).toBe(true);
    expect(
      exp.requiredLiterals.get("flow_large_trades.flow_large_trades_check")
    ).toEqual([{ literal: "streamed", tag: "0083_flow_capture_streamed" }]);
    expect(exp.nullability.get("golive_drafts.short_strike")).toEqual({
      nullable: "YES",
      tag: "0090_golive_single_leg",
    });
    expect(exp.functions.get("reject_workflow_journal_mutation")).toBe(
      "0005_workflow_durability"
    );
    expect(exp.functions.get("delete_workflow_run_outbox_events")).toBe(
      "0005_workflow_durability"
    );
    expect(
      exp.triggers.get(
        makeTriggerKey("workflow_journal", "workflow_journal_immutable")
      )
    ).toEqual({
      fn: "reject_workflow_journal_mutation",
      table: "workflow_journal",
      tag: "0005_workflow_durability",
      trigger: "workflow_journal_immutable",
    });
    expect(
      exp.triggers.get(
        makeTriggerKey("workflow_runs", "workflow_runs_delete_outbox")
      )
    ).toEqual({
      fn: "delete_workflow_run_outbox_events",
      table: "workflow_runs",
      tag: "0005_workflow_durability",
      trigger: "workflow_runs_delete_outbox",
    });
    expect(exp.functions.get("vertex_reject_epoch_transition_mutation")).toBe(
      "0008_vertex_buildout"
    );
    expect(
      exp.functions.get("vertex_reject_native_approval_audit_mutation")
    ).toBe("0008_vertex_buildout");
    expect(
      exp.triggers.get(
        makeTriggerKey(
          "vertex_portfolio_epoch_transitions",
          "vertex_epoch_transition_immutable"
        )
      )?.tag
    ).toBe("0008_vertex_buildout");
    expect(
      exp.triggers.get(
        makeTriggerKey(
          "vertex_portfolio_epoch_transitions",
          "vertex_epoch_transition_no_truncate"
        )
      )?.tag
    ).toBe("0008_vertex_buildout");
    expect(
      exp.triggers.get(
        makeTriggerKey(
          "vertex_native_approval_audit",
          "vertex_native_approval_audit_immutable"
        )
      )?.tag
    ).toBe("0008_vertex_buildout");
    expect(
      exp.triggers.get(
        makeTriggerKey(
          "vertex_native_approval_audit",
          "vertex_native_approval_audit_no_truncate"
        )
      )?.tag
    ).toBe("0008_vertex_buildout");
    expect(exp.functions.get("vertex_chat_copy_immutable")).toBe(
      "0012_vertex_research_chat_copy_inventory"
    );
    for (const [table, trigger] of [
      ["vertex_research_chat_copy_families", "vertex_copy_family_immutable"],
      [
        "vertex_research_chat_copy_allocations",
        "vertex_copy_allocation_immutable",
      ],
      [
        "vertex_research_chat_copy_content_bindings",
        "vertex_copy_content_immutable",
      ],
      [
        "vertex_research_chat_copy_dependencies",
        "vertex_copy_dependency_immutable",
      ],
      ["vertex_research_chat_copy_closures", "vertex_copy_closure_immutable"],
    ] as const) {
      expect(exp.triggers.get(makeTriggerKey(table, trigger))).toEqual({
        fn: "vertex_chat_copy_immutable",
        table,
        tag: "0012_vertex_research_chat_copy_inventory",
        trigger,
      });
    }
    expect(
      exp.triggers.get(
        makeTriggerKey(
          "vertex_research_chat_copy_cleanup_intents",
          "vertex_copy_cleanup_immutable"
        )
      )
    ).toEqual({
      fn: "vertex_chat_copy_immutable",
      table: "vertex_research_chat_copy_cleanup_intents",
      tag: "0013_vertex_research_chat_copy_cleanup",
      trigger: "vertex_copy_cleanup_immutable",
    });
  });

  it("tracks functions, triggers, dollar-quoted bodies, DO LANGUAGE blocks, drops, and schema guards", () => {
    const migrations: MigrationSource[] = [
      {
        sql: `
          CREATE TABLE "a" ("id" text PRIMARY KEY);
          CREATE TABLE "a.b" ("id" text PRIMARY KEY);
          CREATE TABLE "orders" ("id" text PRIMARY KEY, "on" text, "note" text);
          CREATE FUNCTION public."fn_a"() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            PERFORM $msg$it's -- not a comment$msg$;
            RETURN NEW;
          END;
          $$;
          --> statement-breakpoint
          CREATE FUNCTION "fn_keep"() RETURNS trigger LANGUAGE plpgsql AS $fn$
          BEGIN
            RETURN NEW;
          END;
          $fn$;
          --> statement-breakpoint
          CREATE FUNCTION fn_drop_args(a int, b text) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
          CREATE FUNCTION fn_cascade() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
          CREATE FUNCTION fn_cascade_kept() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
          CREATE FUNCTION "PUBLIC"."wrong_schema_fn"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
          CREATE FUNCTION analytics.other_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
          CREATE TRIGGER "tr_a" BEFORE UPDATE ON "a" FOR EACH ROW EXECUTE FUNCTION "fn_a"();
          CREATE TRIGGER "tr_ab" AFTER UPDATE OF "on", "note" ON "public"."a.b" FOR EACH ROW WHEN (NEW."note" = 'EXECUTE FUNCTION fake()') EXECUTE PROCEDURE "fn_keep"();
          CREATE TRIGGER "tr_cascade" BEFORE DELETE ON "orders" FOR EACH ROW EXECUTE FUNCTION fn_cascade();
          CREATE TRIGGER "tr_cascade_arg" BEFORE INSERT ON "orders" FOR EACH ROW EXECUTE FUNCTION fn_drop_args();
          CREATE TRIGGER "tr_builtin" BEFORE UPDATE ON PUBLIC.orders FOR EACH ROW EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger();
          CREATE TRIGGER "tr_quoted_fn" BEFORE UPDATE ON "orders" FOR EACH ROW EXECUTE FUNCTION "my""fn"();
          CREATE TRIGGER "tr_no_exec" BEFORE INSERT ON "orders" FOR EACH ROW;
          CREATE TRIGGER "tr_bad_no_on" BEFORE INSERT FOR EACH ROW EXECUTE FUNCTION fn_keep();
          CREATE TRIGGER "tr_other_schema" BEFORE INSERT ON analytics.events FOR EACH ROW WHEN (EXISTS (SELECT 1 FROM a JOIN b ON a.id = b.id)) EXECUTE FUNCTION fn_keep();
          CREATE TRIGGER "tr_upper_public" BEFORE INSERT ON "PUBLIC".orders FOR EACH ROW EXECUTE FUNCTION fn_keep();
          CREATE TRIGGER "tr_temp" BEFORE DELETE ON "orders" FOR EACH ROW EXECUTE FUNCTION fn_cascade_kept();
          DO LANGUAGE plpgsql $do$
          BEGIN
            -- comment before constraint and commented-out grant inside DO block
            ALTER TABLE "orders" ADD CONSTRAINT "orders_note_ck" CHECK ("note" <> '');
            -- GRANT SELECT ON TABLE "orders" TO "vertex_research";
            GRANT INSERT ON TABLE "orders" TO "vertex_research";
            CREATE OR REPLACE FUNCTION "do_fn"() RETURNS trigger LANGUAGE plpgsql AS $inner$ BEGIN RETURN NEW; END; $inner$;
            CREATE OR REPLACE TRIGGER "do_trig" AFTER DELETE ON "orders" FOR EACH ROW EXECUTE FUNCTION "do_fn"();
          END
          $do$;
        `,
        tag: "0001_triggers",
      },
      {
        sql: `
          DROP TABLE "a";
          DROP TRIGGER IF EXISTS "tr_temp" ON public."orders";
          DROP TRIGGER IF EXISTS "tr_other" ON analytics.events;
          DROP FUNCTION IF EXISTS fn_drop_args(a int, b text), fn_cascade(), analytics.other_fn(), ??? CASCADE;
          DROP FUNCTION IF EXISTS fn_cascade_kept() RESTRICT;
        `,
        tag: "0002_cleanup",
      },
    ];

    const exp = extractMigrationExpectations(migrations);
    expect(exp.functions.get("fn_a")).toBe("0001_triggers");
    expect(exp.functions.get("fn_keep")).toBe("0001_triggers");
    expect(exp.functions.get("do_fn")).toBe("0001_triggers");
    expect(exp.functions.has("fn_drop_args")).toBe(false);
    expect(exp.functions.has("fn_cascade")).toBe(false);
    expect(exp.functions.has("fn_cascade_kept")).toBe(false);
    expect(exp.functions.has("wrong_schema_fn")).toBe(false);
    expect(exp.functions.has("other_fn")).toBe(false);

    expect(exp.triggers.has(makeTriggerKey("a", "tr_a"))).toBe(false);
    expect(exp.triggers.get(makeTriggerKey("a.b", "tr_ab"))).toEqual({
      fn: "fn_keep",
      table: "a.b",
      tag: "0001_triggers",
      trigger: "tr_ab",
    });
    expect(exp.triggers.has(makeTriggerKey("orders", "tr_cascade"))).toBe(
      false
    );
    expect(exp.triggers.has(makeTriggerKey("orders", "tr_cascade_arg"))).toBe(
      true
    );
    expect(exp.triggers.has(makeTriggerKey("orders", "tr_temp"))).toBe(false);
    expect(exp.triggers.get(makeTriggerKey("orders", "tr_builtin"))).toEqual({
      fn: null,
      table: "orders",
      tag: "0001_triggers",
      trigger: "tr_builtin",
    });
    expect(exp.triggers.get(makeTriggerKey("orders", "tr_quoted_fn"))).toEqual({
      fn: 'my"fn',
      table: "orders",
      tag: "0001_triggers",
      trigger: "tr_quoted_fn",
    });
    expect(exp.triggers.get(makeTriggerKey("orders", "tr_no_exec"))).toEqual({
      fn: null,
      table: "orders",
      tag: "0001_triggers",
      trigger: "tr_no_exec",
    });
    expect(exp.constraints.get("orders.orders_note_ck")).toBe("0001_triggers");
    expect(exp.grants.has("orders:SELECT")).toBe(false);
    expect(exp.grants.get("orders:INSERT")).toBe("0001_triggers");
    expect(exp.triggers.get(makeTriggerKey("orders", "do_trig"))).toEqual({
      fn: "do_fn",
      table: "orders",
      tag: "0001_triggers",
      trigger: "do_trig",
    });
    expect(exp.triggers.has(makeTriggerKey("events", "tr_other_schema"))).toBe(
      false
    );
    expect(exp.triggers.has(makeTriggerKey("orders", "tr_upper_public"))).toBe(
      false
    );
  });
});

describe("parsePostgresSnapshot", () => {
  it("parses all valid record kinds framed by @@START and @@END", () => {
    const raw = [
      "@@START\t\t\t",
      "H\tabc123\t\t",
      "H\t\t\t",
      "T\tresearch_screen_rows\t\t",
      "T\t\t\t",
      "C\tresearch_screen_rows\treport_id\tNO",
      "C\t\t\t",
      "I\tresearch_screen_runs_slot_at_idx\t\t",
      "I\t\t\t",
      "K\tflow_large_trades\tflow_large_trades_check\tCHECK ((capture = ANY (ARRAY['sampled'::text, 'streamed'::text])))",
      "K\t\t\t",
      "R\tvertex_research\t\t",
      "R\t\t\t",
      "G\tresearch_screen_rows\tSELECT\t",
      "G\t\t\t",
      "F\tjev_verdict_log_reject_mutation\t\t",
      "F\tfn_space \t\t",
      "F\t\t\t",
      "TR\tjev_verdict_log\tjev_verdict_log_immutable\tO:jev_verdict_log_reject_mutation",
      "TR\ta.b\ttr.colon\tA:quoted:fn ",
      "TR\t\t\t",
      "@@END\t\t\t",
    ].join("\n");

    const parsed = parsePostgresSnapshot(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.snapshot.ledgerHashes.has("abc123")).toBe(true);
    expect(parsed.snapshot.tables.has("research_screen_rows")).toBe(true);
    expect(parsed.snapshot.columns.get("research_screen_rows.report_id")).toBe(
      "NO"
    );
    expect(
      parsed.snapshot.indexes.has("research_screen_runs_slot_at_idx")
    ).toBe(true);
    expect(
      parsed.snapshot.constraints.get(
        "flow_large_trades.flow_large_trades_check"
      )
    ).toContain("'streamed'");
    expect(parsed.snapshot.roles.has("vertex_research")).toBe(true);
    expect(parsed.snapshot.appGrants.has("research_screen_rows:SELECT")).toBe(
      true
    );
    expect(
      parsed.snapshot.functions.has("jev_verdict_log_reject_mutation")
    ).toBe(true);
    expect(parsed.snapshot.functions.has("fn_space ")).toBe(true);
    expect(
      parsed.snapshot.triggers.get(
        makeTriggerKey("jev_verdict_log", "jev_verdict_log_immutable")
      )
    ).toEqual({ enabled: "O", fn: "jev_verdict_log_reject_mutation" });
    expect(
      parsed.snapshot.triggers.get(makeTriggerKey("a.b", "tr.colon"))
    ).toEqual({ enabled: "A", fn: "quoted:fn " });
  });

  it("rejects empty, truncated, or malformed snapshots", () => {
    expect(parsePostgresSnapshot("")).toEqual({
      error:
        "incomplete Postgres migration snapshot (missing @@START/@@END markers)",
      ok: false,
    });
    expect(parsePostgresSnapshot("@@START\t\t\t\nT\tfoo\t\t\n")).toEqual({
      error:
        "incomplete Postgres migration snapshot (missing @@START/@@END markers)",
      ok: false,
    });
    expect(
      parsePostgresSnapshot("@@START\t\t\t\nZ\tbad\t\t\n@@END\t\t\t\n")
    ).toEqual({
      error: "unexpected record kind 'Z' in Postgres migration snapshot",
      ok: false,
    });
    for (const badPayload of ["O", "O:", "X:fn", "OO:fn"]) {
      expect(
        parsePostgresSnapshot(
          `@@START\t\t\t\nTR\ttbl\ttrg\t${badPayload}\n@@END\t\t\t\n`
        )
      ).toEqual({
        error: "malformed trigger record in Postgres migration snapshot",
        ok: false,
      });
    }
  });
});

describe("checkAppliedMigrations", () => {
  const sampleMigrations: MigrationSource[] = [
    {
      sql: `
        CREATE TABLE "orders" (
          "id" text PRIMARY KEY NOT NULL,
          "capture" text NOT NULL,
          "note" text NOT NULL,
          CONSTRAINT "orders_check" CHECK ("capture" in ('sampled'))
        );
        CREATE INDEX "orders_id_idx" ON "orders" ("id");
        GRANT SELECT, INSERT ON TABLE "orders" TO "vertex_research";
      `,
      tag: "0000_orders",
    },
    {
      sql: `
        ALTER TABLE "orders" ADD COLUMN "extra" text;
        ALTER TABLE "orders" ALTER COLUMN "note" DROP NOT NULL;
        ALTER TABLE "orders" DROP CONSTRAINT "orders_check";
        ALTER TABLE "orders" ADD CONSTRAINT "orders_check" CHECK ("capture" in ('sampled', 'streamed'));
        CREATE TABLE "research_screen_rows" ("id" text PRIMARY KEY NOT NULL);
        GRANT SELECT, INSERT, UPDATE ON TABLE "research_screen_rows" TO "vertex_research";
      `,
      tag: "0001_screen",
    },
    {
      sql: `INSERT INTO "orders" ("id", "capture", "note") VALUES ('1', 'sampled', 'x') ON CONFLICT DO NOTHING;`,
      tag: "0002_seed",
    },
  ];

  it("passes when all structural requirements are present even without Drizzle ledger rows", () => {
    const snap = buildSnapshot({
      appGrants: [
        "orders:SELECT",
        "orders:INSERT",
        "research_screen_rows:SELECT",
        "research_screen_rows:INSERT",
        "research_screen_rows:UPDATE",
      ],
      columns: [
        ["orders.id", "NO"],
        ["orders.capture", "NO"],
        ["orders.note", "YES"],
        ["orders.extra", "YES"],
        ["research_screen_rows.id", "NO"],
      ],
      constraints: [
        [
          "orders.orders_check",
          "CHECK ((capture = ANY (ARRAY['sampled'::text, 'streamed'::text])))",
        ],
      ],
      indexes: ["orders_id_idx"],
      ledgerHashes: [
        createHash("sha256")
          .update(sampleMigrations[0]?.sql ?? "")
          .digest("hex"),
      ],
      roles: ["vertex_research"],
      tables: ["orders", "research_screen_rows"],
    });

    const report = checkAppliedMigrations(sampleMigrations, snap);
    expect(report).toEqual({
      checkedCount: 3,
      ledgerCount: 1,
      missing: [],
      ok: true,
      structuralCount: 2,
    });
  });

  it("reports missing tables, columns, nullability, indexes, constraints, check literals, and grants", () => {
    const snap = buildSnapshot({
      appGrants: ["orders:SELECT"],
      columns: [
        ["orders.id", "NO"],
        ["orders.capture", "NO"],
        ["orders.note", "NO"],
      ],
      constraints: [
        ["orders.orders_check", "CHECK ((capture = 'sampled'::text))"],
      ],
      indexes: [],
      roles: ["vertex_research"],
      tables: ["orders"],
    });

    const report = checkAppliedMigrations(sampleMigrations, snap);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([
      {
        reasons: [
          "missing index orders_id_idx",
          "missing vertex_research privilege INSERT on orders",
        ],
        tag: "0000_orders",
      },
      {
        reasons: [
          "missing table research_screen_rows",
          "missing column orders.extra",
          "column orders.note is NOT NULL (expected nullable)",
          "constraint orders.orders_check missing 'streamed'",
        ],
        tag: "0001_screen",
      },
    ]);
  });

  it("reports missing constraint, nullable when expected NOT NULL, and groups multiple missing grants", () => {
    const migrations: MigrationSource[] = [
      {
        sql: `
          CREATE TABLE "t" ("a" text);
          ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL;
          ALTER TABLE "t" ADD CONSTRAINT "t_check" CHECK ("a" <> '');
          GRANT SELECT, INSERT, UPDATE ON TABLE "t" TO "vertex_research";
        `,
        tag: "0000_t",
      },
    ];
    const snap = buildSnapshot({
      columns: [["t.a", "YES"]],
      roles: ["vertex_research"],
      tables: ["t"],
    });
    const report = checkAppliedMigrations(migrations, snap);
    expect(report.ok).toBe(false);
    expect(report.missing[0]?.reasons).toEqual([
      "column t.a is nullable (expected NOT NULL)",
      "missing constraint t.t_check",
      "missing vertex_research privilege SELECT, INSERT, UPDATE on t",
    ]);
  });

  it("skips app-role grant checks when vertex_research role does not exist", () => {
    const migrations: MigrationSource[] = [
      {
        sql: `
          CREATE TABLE "t" ("id" text PRIMARY KEY NOT NULL);
          GRANT SELECT ON TABLE "t" TO "vertex_research";
        `,
        tag: "0000_t",
      },
    ];
    const snap = buildSnapshot({
      columns: [["t.id", "NO"]],
      roles: ["postgres"],
      tables: ["t"],
    });
    expect(checkAppliedMigrations(migrations, snap).ok).toBe(true);
  });

  it("does not fail on an empty migration list with an empty snapshot", () => {
    expect(checkAppliedMigrations([], emptySnapshot())).toEqual({
      checkedCount: 0,
      ledgerCount: 0,
      missing: [],
      ok: true,
      structuralCount: 0,
    });
  });

  it("verifies trigger-only migrations (0104 pattern), disabled/replica-only triggers, wrong functions, and missing parent suppression", () => {
    const migrations: MigrationSource[] = [
      {
        sql: `CREATE TABLE "jev_verdict_log" ("id" text PRIMARY KEY);`,
        tag: "0082_jev_verdict_log",
      },
      {
        sql: `
          CREATE FUNCTION jev_verdict_log_reject_mutation() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'jev_verdict_log is append-only' USING ERRCODE = '23514';
          END;
          $$;
          --> statement-breakpoint
          CREATE TRIGGER jev_verdict_log_immutable
          BEFORE UPDATE OR DELETE ON "jev_verdict_log"
          FOR EACH ROW EXECUTE FUNCTION jev_verdict_log_reject_mutation();
          --> statement-breakpoint
          CREATE TRIGGER jev_verdict_log_no_truncate
          BEFORE TRUNCATE ON "jev_verdict_log"
          FOR EACH STATEMENT EXECUTE FUNCTION jev_verdict_log_reject_mutation();
        `,
        tag: "0104_jev_verdict_log_append_only",
      },
    ];

    const unapplied = checkAppliedMigrations(
      migrations,
      buildSnapshot({
        columns: [["jev_verdict_log.id", "NO"]],
        tables: ["jev_verdict_log"],
      })
    );
    expect(unapplied.ok).toBe(false);
    expect(unapplied.structuralCount).toBe(2);
    expect(unapplied.missing).toEqual([
      {
        reasons: [
          "missing function jev_verdict_log_reject_mutation",
          "missing trigger jev_verdict_log.jev_verdict_log_immutable",
          "missing trigger jev_verdict_log.jev_verdict_log_no_truncate",
        ],
        tag: "0104_jev_verdict_log_append_only",
      },
    ]);

    const applied = checkAppliedMigrations(
      migrations,
      buildSnapshot({
        columns: [["jev_verdict_log.id", "NO"]],
        functions: ["jev_verdict_log_reject_mutation"],
        tables: ["jev_verdict_log"],
        triggers: [
          [
            makeTriggerKey("jev_verdict_log", "jev_verdict_log_immutable"),
            { enabled: "O", fn: "jev_verdict_log_reject_mutation" },
          ],
          [
            makeTriggerKey("jev_verdict_log", "jev_verdict_log_no_truncate"),
            { enabled: "A", fn: "jev_verdict_log_reject_mutation" },
          ],
        ],
      })
    );
    expect(applied.ok).toBe(true);
    expect(applied.missing).toEqual([]);
    expect(applied.structuralCount).toBe(2);
    expect(applied.ledgerCount).toBe(0);

    const drifted = checkAppliedMigrations(
      migrations,
      buildSnapshot({
        columns: [["jev_verdict_log.id", "NO"]],
        functions: ["jev_verdict_log_reject_mutation"],
        tables: ["jev_verdict_log"],
        triggers: [
          [
            makeTriggerKey("jev_verdict_log", "jev_verdict_log_immutable"),
            {
              enabled: "D",
              fn: "other_schema.jev_verdict_log_reject_mutation",
            },
          ],
          [
            makeTriggerKey("jev_verdict_log", "jev_verdict_log_no_truncate"),
            { enabled: "R", fn: "jev_verdict_log_reject_mutation" },
          ],
        ],
      })
    );
    expect(drifted.ok).toBe(false);
    expect(drifted.missing).toEqual([
      {
        reasons: [
          "trigger jev_verdict_log.jev_verdict_log_immutable is disabled",
          "trigger jev_verdict_log.jev_verdict_log_immutable calls other_schema.jev_verdict_log_reject_mutation (expected jev_verdict_log_reject_mutation)",
          "trigger jev_verdict_log.jev_verdict_log_no_truncate is replica-only (not active on origin)",
        ],
        tag: "0104_jev_verdict_log_append_only",
      },
    ]);

    const noParent = checkAppliedMigrations(migrations, emptySnapshot());
    expect(noParent.ok).toBe(false);
    expect(noParent.missing).toEqual([
      {
        reasons: ["missing table jev_verdict_log"],
        tag: "0082_jev_verdict_log",
      },
      {
        reasons: ["missing function jev_verdict_log_reject_mutation"],
        tag: "0104_jev_verdict_log_append_only",
      },
    ]);
  });
});

describe("loadMigrationsFromGit", () => {
  it("handles missing journal, invalid JSON, missing entries, bad tag, and missing SQL file", () => {
    const failJournal: GitRunner = () => ({
      ok: false,
      stderr: "fatal",
      stdout: "",
    });
    expect(loadMigrationsFromGit("/repo", "abc1234", failJournal)).toEqual({
      error:
        "cannot read packages/db/migrations/meta/_journal.json from commit abc1234 in /repo",
      ok: false,
    });

    const badJson: GitRunner = () => ({ ok: true, stderr: "", stdout: "{" });
    expect(loadMigrationsFromGit("/repo", "abc1234", badJson)).toEqual({
      error:
        "packages/db/migrations/meta/_journal.json in commit abc1234 is not valid JSON",
      ok: false,
    });

    const noEntries: GitRunner = () => ({
      ok: true,
      stderr: "",
      stdout: "{}",
    });
    expect(loadMigrationsFromGit("/repo", "abc1234", noEntries)).toEqual({
      error:
        "packages/db/migrations/meta/_journal.json in commit abc1234 has no entries array",
      ok: false,
    });

    const badTag: GitRunner = () => ({
      ok: true,
      stderr: "",
      stdout: JSON.stringify({ entries: [{ tag: "../evil" }] }),
    });
    expect(loadMigrationsFromGit("/repo", "abc1234", badTag)).toEqual({
      error:
        "packages/db/migrations/meta/_journal.json in commit abc1234 contains an invalid migration tag",
      ok: false,
    });

    const nonObjectEntry: GitRunner = () => ({
      ok: true,
      stderr: "",
      stdout: JSON.stringify({ entries: [null] }),
    });
    expect(loadMigrationsFromGit("/repo", "abc1234", nonObjectEntry)).toEqual({
      error:
        "packages/db/migrations/meta/_journal.json in commit abc1234 contains an invalid migration tag",
      ok: false,
    });

    const missingSql: GitRunner = (_dir, args) => {
      if (args[1]?.endsWith("_journal.json")) {
        return {
          ok: true,
          stderr: "",
          stdout: JSON.stringify({ entries: [{ tag: "0000_init" }] }),
        };
      }
      return { ok: false, stderr: "missing", stdout: "" };
    };
    expect(loadMigrationsFromGit("/repo", "abc1234", missingSql)).toEqual({
      error:
        "migration file packages/db/migrations/0000_init.sql is missing in commit abc1234",
      ok: false,
    });
  });

  it("defaultRunGit returns ok=false for nonexistent commit", () => {
    const res = defaultRunGit(REPO_ROOT, [
      "show",
      "0000000000000000000000000000000000000000:nonexistent",
    ]);
    expect(res.ok).toBe(false);
  });
});

describe("runMigrationCheckCli", () => {
  const runCli = (
    args: string[],
    stdin: string,
    runGit?: GitRunner
  ): { code: number; lines: string[] } => {
    const lines: string[] = [];
    const code = runMigrationCheckCli(args, {
      readStdin: () => stdin,
      ...(runGit ? { runGit } : {}),
      stdout: (line) => {
        lines.push(line);
      },
    });
    return { code, lines };
  };

  it("prints the SQL snapshot query with --print-sql", () => {
    const res = runCli(["--print-sql"], "");
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe(MIGRATIONS_SNAPSHOT_SQL);
  });

  it("returns 2 on bad or incomplete CLI arguments", () => {
    expect(runCli(["--unknown"], "").code).toBe(2);
    expect(runCli(["--git-dir", "/repo"], "").code).toBe(2);
    expect(runCli(["--git-dir"], "").code).toBe(2);
    expect(runCli(["--sha"], "").code).toBe(2);
  });

  it("returns 2 on incomplete snapshot or unreadable git commit", () => {
    const badSnap = runCli(["--git-dir", "/repo", "--sha", "abc1234"], "");
    expect(badSnap.code).toBe(2);
    expect(badSnap.lines[0]).toContain(
      "incomplete Postgres migration snapshot"
    );

    const badGit = runCli(
      ["--git-dir", "/repo", "--sha", "abc1234"],
      "@@START\t\t\t\n@@END\t\t\t\n",
      () => ({ ok: false, stderr: "", stdout: "" })
    );
    expect(badGit.code).toBe(2);
    expect(badGit.lines[0]).toContain("cannot read");
  });

  it("returns 0 when all migrations are applied and 1 with capped reason list when missing", () => {
    const sql0 = `
      CREATE TABLE "t1" ("id" text);
      CREATE TABLE "t2" ("id" text);
      CREATE TABLE "t3" ("id" text);
      CREATE TABLE "t4" ("id" text);
      CREATE TABLE "t5" ("id" text);
    `;
    const fakeGit: GitRunner = (_dir, args) => {
      if (args[1]?.endsWith("_journal.json")) {
        return {
          ok: true,
          stderr: "",
          stdout: JSON.stringify({ entries: [{ tag: "0000_many" }] }),
        };
      }
      return { ok: true, stderr: "", stdout: sql0 };
    };

    const blocked = runCli(
      ["--git-dir", "/repo", "--sha", "abc1234"],
      "@@START\t\t\t\n@@END\t\t\t\n",
      fakeGit
    );
    expect(blocked.code).toBe(EXIT_UNAPPLIED);
    expect(blocked.lines[0]).toBe("1 build migration(s) not applied on prod:");
    expect(blocked.lines[1]).toContain("0000_many");
    expect(blocked.lines[1]).toContain("(+1 more)");

    const applied = runCli(
      ["--git-dir", "/repo", "--sha", "abc1234"],
      [
        "@@START\t\t\t",
        "T\tt1\t\t",
        "T\tt2\t\t",
        "T\tt3\t\t",
        "T\tt4\t\t",
        "T\tt5\t\t",
        "C\tt1\tid\tYES",
        "C\tt2\tid\tYES",
        "C\tt3\tid\tYES",
        "C\tt4\tid\tYES",
        "C\tt5\tid\tYES",
        "@@END\t\t\t",
      ].join("\n"),
      fakeGit
    );
    expect(applied.code).toBe(EXIT_APPLIED);
    expect(applied.lines[0]).toBe(
      "all 1 build migrations applied (1 structurally verified, 0 in drizzle ledger)"
    );

    const partial = runCli(
      ["--git-dir", "/repo", "--sha", "abc1234"],
      [
        "@@START\t\t\t",
        "T\tt1\t\t",
        "T\tt2\t\t",
        "T\tt3\t\t",
        "T\tt4\t\t",
        "C\tt1\tid\tYES",
        "C\tt2\tid\tYES",
        "C\tt3\tid\tYES",
        "C\tt4\tid\tYES",
        "@@END\t\t\t",
      ].join("\n"),
      fakeGit
    );
    expect(partial.code).toBe(EXIT_UNAPPLIED);
    expect(partial.lines[1]).toBe("  - 0000_many: missing table t5");
    expect(partial.lines[1]).not.toContain("more)");
  });

  it("preserves surviving required literals across multiple CHECK constraint widenings", () => {
    const migrations = [
      {
        sql: `CREATE TABLE "s" ("kind" text, CONSTRAINT "s_kind_ck" CHECK ("kind" in ('a', 'b')));`,
        tag: "0001_base",
      },
      {
        sql: `
          ALTER TABLE "s" DROP CONSTRAINT "s_kind_ck";
          ALTER TABLE "s" ADD CONSTRAINT "s_kind_ck" CHECK ("kind" in ('a', 'b', 'c', 'temp'));
        `,
        tag: "0002_widen_one",
      },
      {
        sql: `
          ALTER TABLE "s" DROP CONSTRAINT "s_kind_ck";
          ALTER TABLE "s" ADD CONSTRAINT "s_kind_ck" CHECK ("kind" in ('a', 'b', 'c', 'd'));
        `,
        tag: "0003_widen_two",
      },
    ];
    const exp = extractMigrationExpectations(migrations);
    expect(exp.requiredLiterals.get("s.s_kind_ck")).toEqual([
      { literal: "c", tag: "0002_widen_one" },
      { literal: "d", tag: "0003_widen_two" },
    ]);
  });

  it("handles multi-action ALTER TABLE, DO $$ DDL blocks, and SQL escaped single quotes in CHECK literals", () => {
    const migrations = [
      {
        sql: `
          CREATE TABLE "t" (
            "id" text PRIMARY KEY,
            "kind" text,
            CONSTRAINT "t_kind_ck" CHECK ("kind" in ('a', 'it''s'))
          );
          ALTER TABLE "t" ADD COLUMN "c1" text, ADD COLUMN "c2" text, ;
          ALTER TABLE "t" DROP CONSTRAINT "t_kind_ck", ADD CONSTRAINT "t_kind_ck" CHECK ("kind" in ('a', 'it''s', 'c'));
          DO $$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 't_extra_ck') THEN
              ALTER TABLE "t" ADD CONSTRAINT "t_extra_ck" CHECK ("c1" in ('x', 'y'));
            END IF;
          END
          $$;
          DO $$ BEGIN GRANT SELECT ON TABLE "t" TO "vertex_research"; END $$;
          DO $unclosed;
          DO $bad$ SELECT 1;
        `,
        tag: "0001_combo",
      },
      {
        sql: `ALTER TABLE "t" ADD CONSTRAINT "t_unterm_ck" CHECK ("kind" = 'unterminated`,
        tag: "0002_unterm",
      },
    ];
    const exp = extractMigrationExpectations(migrations);
    expect(exp.columns.has("t.c1")).toBe(true);
    expect(exp.columns.has("t.c2")).toBe(true);
    expect(exp.constraints.get("t.t_extra_ck")).toBe("0001_combo");
    expect(exp.grants.get("t:SELECT")).toBe("0001_combo");
    // 'it''s' must NOT be split into bogus literals 'it' and 's'; only 'c' is newly added.
    expect(exp.requiredLiterals.get("t.t_kind_ck")).toEqual([
      { literal: "c", tag: "0001_combo" },
    ]);

    // Real repository DO $$ migrations (0018, 0019, 0036, 0069) now track their constraints.
    const realLoaded = loadMigrationsFromGit(REPO_ROOT, "HEAD");
    expect(realLoaded.ok).toBe(true);
    if (realLoaded.ok) {
      const realExp = extractMigrationExpectations(realLoaded.migrations);
      expect(
        realExp.constraints.get(
          "backtest_results.backtest_results_extras_check"
        )
      ).toBe("0018_backtest_run_config");
      expect(
        realExp.constraints.get(
          "backtest_results.backtest_results_strategy_id_strategies_id_fk"
        )
      ).toBe("0019_strategy_library");
      expect(
        realExp.constraints.get(
          "backtest_results.backtest_results_rating_series_check"
        )
      ).toBe("0036_backtest_rating_series");
      expect(
        realExp.constraints.get(
          "deployment_requests.deployment_requests_options_check"
        )
      ).toBe("0069_deployment_request_options");
    }
  });

  it("returns EXIT_ERROR (2) when readStdin throws an Error or non-Error value", () => {
    const linesErr: string[] = [];
    const rcErr = runMigrationCheckCli(
      ["--git-dir", "/repo", "--sha", "abc1234"],
      {
        readStdin: () => {
          throw new Error("EPIPE");
        },
        stdout: (line) => {
          linesErr.push(line);
        },
      }
    );
    expect(rcErr).toBe(EXIT_ERROR);
    expect(linesErr[0]).toContain(
      "cannot read Postgres migration snapshot from stdin: EPIPE"
    );

    const linesStr: string[] = [];
    const rcStr = runMigrationCheckCli(
      ["--git-dir", "/repo", "--sha", "abc1234"],
      {
        readStdin: () => {
          throw "raw-io-failure";
        },
        stdout: (line) => {
          linesStr.push(line);
        },
      }
    );
    expect(rcStr).toBe(EXIT_ERROR);
    expect(linesStr[0]).toContain("raw-io-failure");
  });
});
