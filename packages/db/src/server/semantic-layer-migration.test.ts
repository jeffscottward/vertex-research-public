import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  semanticRelationships,
  semanticSqlAttributes,
  semanticTerms,
} from "../schema/index.ts";

const dialect = new PgDialect();

const READER_TABLES = [
  "strategies",
  "backtest_runs",
  "autopilot_campaigns",
  "autopilot_candidates",
  "deployment_requests",
  "forward_drift_monitors",
];

const TERM_IDS = [
  "net_liquidation",
  "open_risk",
  "pnl",
  "position",
  "crown_copy_leg",
  "strategy_gate_pass",
  "backtest_sharpe",
  "backtest_max_drawdown",
  "deployment_request",
  "drift_level",
];

const ATTRIBUTE_IDS = [
  "strategy_gate_pass",
  "backtest_sharpe",
  "backtest_max_drawdown",
  "deployment_request",
  "drift_level",
];

/** Added to semantic_sql_attributes by 0058_semantic_unlinked_runs (checked in its own describe). */
const ADDED_IN_0058 = {
  checks: ["semantic_sql_attributes_grain_check"],
  columns: ["grain"],
};

describe("0056_semantic_layer migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0056_semantic_layer.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0056_semantic_layer.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  /** Text of one INSERT statement: from its header to the terminating `;` at a line end. */
  const insertBlock = (table: string) => {
    const start = migration.indexOf(`INSERT INTO "${table}"`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf(";\n", start);
    return migration.slice(start, end === -1 ? undefined : end);
  };
  const seededIds = (table: string) =>
    [...insertBlock(table).matchAll(/^\s*\('([a-z_0-9]+)'/gm)].map(
      (match) => match[1]
    );

  it.each([
    ["semantic_terms", semanticTerms],
    ["semantic_sql_attributes", semanticSqlAttributes],
    ["semantic_relationships", semanticRelationships],
  ] as [string, PgTable][])(
    "matches the drizzle columns and checks of %s",
    (name, table) => {
      const config = getTableConfig(table);
      expect(config.name).toBe(name);
      const start = migration.indexOf(`CREATE TABLE "${config.name}" (`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = migration.slice(start, migration.indexOf("\n);", start));
      const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
        (match) => match[1]
      );
      expect([...sqlColumns].sort()).toEqual(
        config.columns
          .map((column) => column.name)
          .filter((column) => !ADDED_IN_0058.columns.includes(column))
          .sort()
      );
      expect(config.checks.length).toBeGreaterThan(0);
      for (const check of config.checks) {
        if (ADDED_IN_0058.checks.includes(check.name)) continue;
        expect(body).toContain(
          `CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`
        );
      }
    }
  );

  it("matches the drizzle foreign key; its one-attribute-per-term index is replaced in 0058", () => {
    const attributes = getTableConfig(semanticSqlAttributes);
    expect(attributes.foreignKeys).toHaveLength(1);
    expect(migration).toContain(
      `ALTER TABLE "semantic_sql_attributes" ADD CONSTRAINT "${attributes.foreignKeys[0]?.getName()}" FOREIGN KEY ("term_id") REFERENCES "public"."semantic_terms"("id") ON DELETE cascade`
    );
    expect(migration).toContain(
      `CREATE UNIQUE INDEX "semantic_sql_attributes_term_idx" ON "semantic_sql_attributes" USING btree ("term_id")`
    );
    expect(getTableConfig(semanticTerms).foreignKeys).toHaveLength(0);
    expect(getTableConfig(semanticRelationships).foreignKeys).toHaveLength(0);
  });

  it("grants the reader role CONNECT, USAGE and SELECT on exactly the six tables", () => {
    const start = migration.indexOf(
      "IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_semantic_reader')"
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const block = migration.slice(start, migration.indexOf("END\n$$;", start));
    expect(block).toContain(
      'CREATE ROLE "vertex_semantic_reader" NOLOGIN NOINHERIT;'
    );
    expect(block).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_semantic_reader') THEN"
    );
    expect(block).toContain(
      `EXECUTE format('GRANT CONNECT ON DATABASE %I TO "vertex_semantic_reader"', current_database());`
    );
    expect(block).toContain(
      'GRANT USAGE ON SCHEMA "public" TO "vertex_semantic_reader";'
    );
    expect(block).toMatch(
      /ELSE\n\s+RAISE WARNING 'role vertex_semantic_reader is missing/u
    );
    const grants = [
      ...migration.matchAll(
        /GRANT ([A-Z, ]+) ON TABLE ([^;]+) TO "vertex_semantic_reader";/g
      ),
    ];
    expect(block).toContain(
      "AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication))"
    );
    expect(block).toContain(
      "OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member\n      WHERE r.rolname = 'vertex_semantic_reader') THEN"
    );
    expect(block).toContain(
      "RAISE EXCEPTION 'role vertex_semantic_reader must be a plain login: no superuser, bypassrls, createrole, createdb or replication attribute and no membership in another role';"
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[1]).toBe("SELECT");
    const tables = [...(grants[0]?.[2] ?? "").matchAll(/"([a-z_]+)"/g)].map(
      (match) => match[1]
    );
    expect(tables).toEqual(READER_TABLES);
    expect(migration).not.toMatch(/ON TABLE[^;]*"user"/u);
    expect(migration).not.toMatch(
      /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO "vertex_semantic_reader"/u
    );
    expect(migration).not.toMatch(/GRANT "vertex_semantic_reader" TO/u);
  });

  it("grants the app role SELECT and UPDATE only on the semantic tables", () => {
    const grants = [
      ...migration.matchAll(
        /GRANT ([A-Z, ]+) ON TABLE ([^;]+) TO "vertex_research";/g
      ),
    ];
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[1]).toBe("SELECT, UPDATE");
    expect(grants[0]?.[2]).toBe(
      '"semantic_terms", "semantic_sql_attributes", "semantic_relationships"'
    );
    expect(migration).not.toMatch(/GRANT [^;]*(INSERT|DELETE)/u);
  });

  it("seeds exactly the ten terms and five SQL attributes", () => {
    expect(seededIds("semantic_terms")).toEqual(TERM_IDS);
    expect(seededIds("semantic_sql_attributes")).toEqual(ATTRIBUTE_IDS);
  });

  it("certifies all 21 seed rows as 'migration 0056'", () => {
    const certifiedBy = (table: string) =>
      insertBlock(table).split("'migration 0056'").length - 1;
    expect(certifiedBy("semantic_terms")).toBe(10);
    expect(certifiedBy("semantic_sql_attributes")).toBe(5);
    expect(certifiedBy("semantic_relationships")).toBe(6);
    expect(seededIds("semantic_relationships")).toHaveLength(6);
    expect(migration.split("'migration 0056'").length - 1).toBe(21);
  });

  it("is journaled as idx 56 after 0055", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0056_semantic_layer"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 56 });
    expect(journal.entries[index - 1]).toMatchObject({
      idx: 55,
      tag: "0055_strategy_catalog_calendar_spread",
    });
  });

  it("has a guarded rollback that refuses on any operator work (edits or removed certifications), revokes the grants and never cascades", () => {
    expect(rollback).toContain(
      "semantic layer has operator edits; refusing rollback"
    );
    for (const table of [
      "semantic_terms",
      "semantic_sql_attributes",
      "semantic_relationships",
    ]) {
      expect(rollback).toContain(
        `EXISTS (SELECT 1 FROM "public"."${table}" WHERE "updated_by" IS NOT NULL OR NOT "certified" OR "certified_by" IS DISTINCT FROM 'migration 0056')`
      );
      expect(rollback).toContain(`DROP TABLE "public"."${table}";`);
    }
    expect(rollback).toContain(
      `REVOKE SELECT ON TABLE ${READER_TABLES.map((table) => `"public"."${table}"`).join(", ")} FROM "vertex_semantic_reader";`
    );
    expect(rollback).toContain(
      'REVOKE USAGE ON SCHEMA "public" FROM "vertex_semantic_reader";'
    );
    expect(rollback).toContain(
      `EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM "vertex_semantic_reader"', current_database());`
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DELETE FROM|DROP ROLE/u);
  });
});

describe("0058_semantic_unlinked_runs migration", () => {
  const migration = readFileSync(
    new URL(
      "../../migrations/0058_semantic_unlinked_runs.sql",
      import.meta.url
    ),
    "utf8"
  );
  const rollback = readFileSync(
    new URL(
      "../../rollback/0058_semantic_unlinked_runs.down.sql",
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
  const sqlBodies = [...migration.matchAll(/\$sql\$([\s\S]*?)\$sql\$/g)].map(
    (match) => match[1] ?? ""
  );

  it("adds the drizzle grain column, check and per-grain unique index", () => {
    const config = getTableConfig(semanticSqlAttributes);
    const grain = config.columns.find((column) => column.name === "grain");
    expect(grain?.notNull).toBe(true);
    expect(migration).toContain(
      `ALTER TABLE "semantic_sql_attributes" ADD COLUMN "grain" text DEFAULT 'strategy' NOT NULL;`
    );
    // 0058 added the initial five grains; 0097 widened the check constraint to ten grains.
    expect(migration).toContain(
      `ADD CONSTRAINT "semantic_sql_attributes_grain_check" CHECK ("semantic_sql_attributes"."grain" in ('strategy', 'run_spec', 'candidate', 'request', 'monitor'))`
    );
    expect(config.indexes).toHaveLength(1);
    const [index] = config.indexes;
    expect(index?.config.unique).toBe(true);
    expect(migration).toContain(
      'DROP INDEX "semantic_sql_attributes_term_idx";'
    );
    expect(migration).toContain(
      `CREATE UNIQUE INDEX "${index?.config.name}" ON "semantic_sql_attributes" USING btree ("term_id","grain")`
    );
  });

  it("seeds exactly two run-spec attributes, both NOT certified", () => {
    const rows = [
      ...migration.matchAll(
        /^\s*\('([a-z_0-9]+)', '([a-z_0-9]+)', '([a-z_]+)'/gm
      ),
    ].map((match) => match.slice(1, 4));
    expect(rows).toEqual([
      ["backtest_sharpe_run_spec", "backtest_sharpe", "run_spec"],
      ["backtest_max_drawdown_run_spec", "backtest_max_drawdown", "run_spec"],
    ]);
    expect(
      migration.match(
        /\$sql\$, false, null, null, 'Needs owner certification: /g
      )
    ).toHaveLength(2);
    expect(migration).not.toMatch(/\$sql\$, true,/u);
    expect(migration).not.toMatch(/DELETE|GRANT|semantic_terms/u);
  });

  it("fills grain for the 0056 attributes without touching their SQL or certification", () => {
    const updates = migration.match(/^UPDATE .*$/gmu) ?? [];
    expect(updates).toEqual([
      `UPDATE "semantic_sql_attributes" SET "grain" = CASE "id" WHEN 'strategy_gate_pass' THEN 'candidate' WHEN 'deployment_request' THEN 'request' WHEN 'drift_level' THEN 'monitor' ELSE "grain" END WHERE "id" IN ('strategy_gate_pass', 'deployment_request', 'drift_level');--> statement-breakpoint`,
    ]);
  });

  it("reads only engine runs without a strategy, latest per full run spec", () => {
    expect(sqlBodies).toHaveLength(2);
    for (const body of sqlBodies) {
      expect(body).toContain(
        "where run.status = 'succeeded' and run.strategy_id is null and run.report is not null"
      );
      expect(body).toContain(
        "select distinct on (runs.symbol, runs.timeframe, runs.rule, runs.stop_loss_pct, runs.take_profit_pct, runs.cost_bps, runs.date_from, runs.date_to)"
      );
      // Only the metrics travel through the window and sort, not the whole report.
      expect(body).toContain("run.report -> 'metrics' as metrics");
      expect(body).not.toMatch(/run\.report,|run\.report\s*$/mu);
      expect(body).not.toMatch(/backtest_results|strategies|\$3/u);
    }
    expect(sqlBodies[0]).not.toContain("$2");
    expect(sqlBodies[1]).toContain("$2::numeric");
  });

  it("is journaled right after 0057", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0058_semantic_unlinked_runs"
    );
    expect(journal.entries[index - 1]).toMatchObject({
      tag: "0057_strategy_catalog_qc_ports",
    });
  });

  it("has a guarded rollback that refuses on operator work and restores one attribute per term", () => {
    expect(rollback).toContain(
      "run-spec SQL attributes have operator work or unknown rows; refusing rollback"
    );
    // The guard compares the note with the exact seed note.
    const seedNote = migration.match(
      /'(Needs owner certification: [^']+)'/u
    )?.[1];
    expect(seedNote).toBeDefined();
    expect(rollback).toContain(
      `"certification_note" IS DISTINCT FROM '${seedNote}'`
    );
    expect(rollback).toContain(
      `DELETE FROM "public"."semantic_sql_attributes" WHERE "grain" = 'run_spec' AND "id" IN ('backtest_sharpe_run_spec', 'backtest_max_drawdown_run_spec');`
    );
    expect(rollback).toContain(
      `CREATE UNIQUE INDEX "semantic_sql_attributes_term_idx" ON "public"."semantic_sql_attributes" USING btree ("term_id");`
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DROP TABLE|DROP ROLE/u);
  });
});

describe("0097_semantic_terms_smart_money migration", () => {
  const migration = readFileSync(
    new URL(
      "../../migrations/0097_semantic_terms_smart_money.sql",
      import.meta.url
    ),
    "utf8"
  );
  const rollback = readFileSync(
    new URL(
      "../../rollback/0097_semantic_terms_smart_money.down.sql",
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

  const SMART_MONEY_READER_TABLES = [
    "flow_market_premium",
    "flow_market_premium_sessions",
    "openbb_congress_trades",
    "openbb_congress_filings",
    "openbb_sec_form4_filings",
    "openbb_sec_form4_transactions",
    "openbb_sec_form4_owners",
    "openbb_sec_13f_filings",
    "openbb_sec_13f_holdings",
    "openbb_cusip_symbols",
    "openbb_short_volume_daily",
  ];

  const SMART_MONEY_TERMS: readonly Readonly<{
    id: string;
    grain: string;
    params: number;
  }>[] = [
    { grain: "ticker", id: "large_options_premium_ranking", params: 2 },
    { grain: "filing_trade", id: "congress_trades", params: 3 },
    { grain: "issuer_cluster", id: "insider_cluster_buys", params: 2 },
    { grain: "filer_position", id: "institutional_13f_changes", params: 2 },
    { grain: "ticker_session", id: "short_volume", params: 2 },
  ];

  it("widens the drizzle grain check constraint to all ten grains", () => {
    const config = getTableConfig(semanticSqlAttributes);
    const grainCheck = config.checks.find(
      (check) => check.name === "semantic_sql_attributes_grain_check"
    );
    expect(grainCheck).toBeDefined();
    expect(migration).toContain(
      'ALTER TABLE "semantic_sql_attributes" DROP CONSTRAINT "semantic_sql_attributes_grain_check";'
    );
    expect(migration).toContain(
      `ADD CONSTRAINT "semantic_sql_attributes_grain_check" CHECK (${grainCheck ? dialect.sqlToQuery(grainCheck.value).sql : ""})`
    );
  });

  it("grants SELECT only on the 11 smart-money tables to vertex_semantic_reader with the plain-role guard", () => {
    expect(migration).toContain(
      "RAISE EXCEPTION 'role vertex_semantic_reader must be a plain login: no superuser, bypassrls, createrole, createdb or replication attribute and no membership in another role';"
    );
    const grants = [
      ...migration.matchAll(
        /GRANT ([A-Z, ]+) ON TABLE ([^;]+) TO "vertex_semantic_reader";/g
      ),
    ];
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[1]).toBe("SELECT");
    expect(grants[0]?.[2]).toBe(
      SMART_MONEY_READER_TABLES.map((table) => `"${table}"`).join(", ")
    );
    expect(migration).not.toMatch(
      /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO "vertex_semantic_reader"/u
    );
  });

  it("seeds 5 certified smart-money terms, 5 SQL attributes without stray $N literals, and 5 relationships", () => {
    const sqlBodies = [...migration.matchAll(/\$sql\$([\s\S]*?)\$sql\$/g)].map(
      (match) => match[1] ?? ""
    );
    expect(sqlBodies).toHaveLength(SMART_MONEY_TERMS.length);
    for (const [index, term] of SMART_MONEY_TERMS.entries()) {
      const body = sqlBodies[index] ?? "";
      expect(migration).toContain(
        `('${term.id}', '${term.id}', '${term.grain}'`
      );
      // certifiedStatement() rewrites every /\$(\d+)/g even inside SQL literals/comments.
      const placeholders = [...body.matchAll(/\$(\d+)/g)].map((m) =>
        Number(m[1])
      );
      expect(placeholders.length, term.id).toBeGreaterThan(0);
      for (const n of placeholders) {
        expect(n, `${term.id} placeholder $${n}`).toBeGreaterThanOrEqual(1);
        expect(n, `${term.id} placeholder $${n}`).toBeLessThanOrEqual(
          term.params
        );
      }
      expect(body, `${term.id} source column`).toContain(" as source");
      expect(body, `${term.id} as_of column`).toContain(" as as_of");
      expect(body, `${term.id} data_delay column`).toContain(" as data_delay");
    }
    expect(migration.split("'migration 0097'").length - 1).toBe(15);
  });

  it("is journaled as idx 97 right after 0096", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0097_semantic_terms_smart_money"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 97 });
    expect(journal.entries[index - 1]).toMatchObject({
      idx: 96,
      tag: "0096_strategy_catalog_smart_money_backtests",
    });
  });

  it("has a guarded rollback with BEGIN/COMMIT, certification_note check, grain check and REVOKE SELECT", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("COMMIT;");
    expect(rollback).toContain(
      "smart-money semantic terms have operator edits or unknown grain rows; refusing rollback"
    );
    expect(rollback).toContain(
      '"certification_note" IS DISTINCT FROM seed_note'
    );
    expect(rollback).toContain(
      `REVOKE SELECT ON TABLE ${SMART_MONEY_READER_TABLES.map((table) => `"public"."${table}"`).join(", ")} FROM "vertex_semantic_reader";`
    );
    expect(rollback).toContain(
      `CHECK ("semantic_sql_attributes"."grain" in ('strategy', 'run_spec', 'candidate', 'request', 'monitor'))`
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DROP TABLE|DROP ROLE/u);
  });
});
