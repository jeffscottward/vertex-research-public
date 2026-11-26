import { readFileSync } from "node:fs";

import { createNodeDatabase, type Database } from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Data migration 0096 (Smart-money PR 7 backtests) and its guarded rollback on Postgres.
const migrationSql = readFileSync(
  new URL(
    "../../../packages/db/migrations/0096_strategy_catalog_smart_money_backtests.sql",
    import.meta.url
  ),
  "utf8"
);
const rollbackSql = readFileSync(
  new URL(
    "../../../packages/db/rollback/0096_strategy_catalog_smart_money_backtests.down.sql",
    import.meta.url
  ),
  "utf8"
);

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};

const runMigration = async (): Promise<void> => {
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const sql = stmt.trim();
    if (sql !== "") await postgres().query(sql);
  }
};

const insiderRow = async () => {
  const rows = await postgres().query<{
    status: string;
    source_ref: string;
    unedited: boolean;
  }>(
    `select status, source_ref, (updated_at = created_at) as unedited
       from strategies where slug = 'insider-purchase-confirmation'`
  );
  return rows[0];
};

const newRowCount = async (): Promise<number | undefined> => {
  const rows = await postgres().query<{ count: number }>(
    `select count(*)::int as count from strategies
      where slug in ('smart-money-congress-buys', 'smart-money-large-bullish-premium')`
  );
  return rows[0]?.count;
};

describe("0096 smart-money PR 7 catalog rows (Postgres)", () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 2,
    });
    await migrate(resource.db);
  }, 60_000);

  afterAll(async () => {
    await resource?.close();
    if (testDatabase !== undefined)
      await dropPostgresTestDatabase(testDatabase);
  });

  it("updates insider-purchase-confirmation without modifying updated_at and inserts both new rows idempotently", async () => {
    const rows = await postgres().query<{
      id: string;
      slug: string;
      status: string;
      source_ref: string;
      section: string;
      unedited: boolean;
      has_study: boolean;
      has_failed: boolean;
      has_needs_data: boolean;
    }>(
      `select
         id,
         slug,
         status,
         source_ref,
         section,
         (updated_at = created_at) as unedited,
         (tags ? 'backtest-study') as has_study,
         (tags ? 'failed') as has_failed,
         (tags ? 'needs-data') as has_needs_data
       from strategies
       where slug in (
         'insider-purchase-confirmation',
         'smart-money-congress-buys',
         'smart-money-large-bullish-premium'
       )
       order by slug`
    );

    expect(rows).toEqual([
      {
        has_failed: true,
        has_needs_data: false,
        has_study: true,
        id: "strategy-seed-insider-purchase-confirmation",
        section: "Idea discovery",
        slug: "insider-purchase-confirmation",
        source_ref: "docs/specs/strategies/insider-purchase-confirmation.md",
        status: "backtested",
        unedited: true,
      },
      {
        has_failed: true,
        has_needs_data: false,
        has_study: true,
        id: "strategy-seed-smart-money-congress-buys",
        section: "Idea discovery",
        slug: "smart-money-congress-buys",
        source_ref: "docs/specs/strategies/smart-money-congress-buys.md",
        status: "backtested",
        unedited: true,
      },
      {
        has_failed: false,
        has_needs_data: true,
        has_study: true,
        id: "strategy-seed-smart-money-large-bullish-premium",
        section: "Idea discovery",
        slug: "smart-money-large-bullish-premium",
        source_ref:
          "docs/specs/strategies/smart-money-large-bullish-premium.md",
        status: "researching",
        unedited: true,
      },
    ]);

    // Re-running migration SQL is idempotent (no duplicate slugs, no update once needs-data is gone).
    await runMigration();
    const countRows = await postgres().query<{ count: number }>(
      `select count(*)::int as count from strategies where slug in (
         'insider-purchase-confirmation',
         'smart-money-congress-buys',
         'smart-money-large-bullish-premium'
       )`
    );
    expect(countRows[0]?.count).toBe(3);
  });

  it("refuses rollback when any of the three rows was edited", async () => {
    await postgres().query(
      "update strategies set updated_at = updated_at + interval '1 second' where slug = 'insider-purchase-confirmation'"
    );
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    await postgres().query("ROLLBACK");
    await postgres().query(
      "update strategies set updated_at = created_at where slug = 'insider-purchase-confirmation'"
    );
  });

  it("refuses rollback when a backtest run references one of the rows", async () => {
    await postgres().query(
      "insert into backtest_runs (id, status, spec, engine_version, requested_by, strategy_id) values ('sm-pr7-guard-run', 'queued', '{}'::jsonb, 'test', 'test', 'strategy-seed-smart-money-congress-buys')"
    );
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    await postgres().query("ROLLBACK");
    await postgres().query(
      "delete from backtest_runs where id = 'sm-pr7-guard-run'"
    );
  });

  it("deletes the two new rows and restores the original 0031 insider row on clean rollback", async () => {
    await postgres().query(rollbackSql);

    const remaining = await postgres().query<{
      id: string;
      slug: string;
      status: string;
      source_ref: string;
      has_needs_data: boolean;
      has_failed: boolean;
    }>(
      `select
         id,
         slug,
         status,
         source_ref,
         (tags ? 'needs-data') as has_needs_data,
         (tags ? 'failed') as has_failed
       from strategies
       where slug in (
         'insider-purchase-confirmation',
         'smart-money-congress-buys',
         'smart-money-large-bullish-premium'
       )
       order by slug`
    );

    expect(remaining).toEqual([
      {
        has_failed: false,
        has_needs_data: true,
        id: "strategy-seed-insider-purchase-confirmation",
        slug: "insider-purchase-confirmation",
        source_ref: "services/research/strategies/alert_templates.py",
        status: "researching",
      },
    ]);
  });

  it("leaves the insider row alone when it was edited, has no needs-data tag, or is not in the migrated state", async () => {
    // State after the clean rollback: the 0031 row, unedited, and no new rows.
    expect(await insiderRow()).toEqual({
      source_ref: "services/research/strategies/alert_templates.py",
      status: "researching",
      unedited: true,
    });

    // An edited row (updated_at differs from created_at) is not updated; the new rows are added.
    await postgres().query(
      "update strategies set updated_at = created_at + interval '1 second' where slug = 'insider-purchase-confirmation'"
    );
    await runMigration();
    expect((await insiderRow())?.status).toBe("researching");
    expect(await newRowCount()).toBe(2);
    await postgres().query(
      "update strategies set updated_at = created_at where slug = 'insider-purchase-confirmation'"
    );

    // A row without the needs-data tag is not updated either.
    await postgres().query(
      "update strategies set tags = tags - 'needs-data' where slug = 'insider-purchase-confirmation'"
    );
    expect((await insiderRow())?.unedited).toBe(true);
    await runMigration();
    expect((await insiderRow())?.status).toBe("researching");

    // Rollback: the two new rows go, and the 0031 values are not written over a row that the
    // forward migration never changed.
    await postgres().query(
      "update strategies set source_ref = 'docs/specs/strategies/other.md' where slug = 'insider-purchase-confirmation'"
    );
    await postgres().query(rollbackSql);
    expect(await newRowCount()).toBe(0);
    expect(await insiderRow()).toEqual({
      source_ref: "docs/specs/strategies/other.md",
      status: "researching",
      unedited: true,
    });
  });
});
