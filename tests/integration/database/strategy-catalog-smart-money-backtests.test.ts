import { readFileSync } from "node:fs";

import {
  createNodeDatabase,
  createResearchStudyRepository,
  type Database,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Data migration 0095 (Smart-money PR 7 backtests), its guarded rollback, and research_studies upserts on Postgres.
const migrationSql = readFileSync(
  new URL(
    "../../../packages/db/migrations/0095_strategy_catalog_smart_money_backtests.sql",
    import.meta.url
  ),
  "utf8"
);
const rollbackSql = readFileSync(
  new URL(
    "../../../packages/db/rollback/0095_strategy_catalog_smart_money_backtests.down.sql",
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

const getDb = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};

describe("0095 smart-money PR 7 catalog rows and studies (Postgres)", () => {
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
    for (const stmt of migrationSql.split("--> statement-breakpoint")) {
      const sql = stmt.trim();
      if (sql !== "") await postgres().query(sql);
    }
    const countRows = await postgres().query<{ count: number }>(
      `select count(*)::int as count from strategies where slug in (
         'insider-purchase-confirmation',
         'smart-money-congress-buys',
         'smart-money-large-bullish-premium'
       )`
    );
    expect(countRows[0]?.count).toBe(3);
  });

  it("upserts all three research_studies documents cleanly", async () => {
    const repo = createResearchStudyRepository(getDb());
    const samples = [
      {
        id: "insider-purchase-confirmation",
        verdict: "no-edge",
        specRef: "docs/specs/strategies/insider-purchase-confirmation.md",
      },
      {
        id: "smart-money-congress-buys",
        verdict: "no-edge",
        specRef: "docs/specs/strategies/smart-money-congress-buys.md",
      },
      {
        id: "smart-money-large-bullish-premium",
        verdict: "needs-more-data",
        specRef: "docs/specs/strategies/smart-money-large-bullish-premium.md",
      },
    ] as const;

    for (const sample of samples) {
      const result = await repo.upsert({
        id: sample.id,
        ranOn: "2026-11-25",
        specRef: sample.specRef,
        summary: {
          id: sample.id,
          kind: "strategy-backtest",
          ran: "2026-11-25",
          spec: sample.specRef,
          verdict: sample.verdict,
        },
      });
      expect(result.id).toBe(sample.id);
    }

    const verdicts = new Map(
      (await repo.verdicts(samples.map((s) => s.id))).map((row) => [
        row.id,
        row.verdict,
      ])
    );
    expect(verdicts.get("insider-purchase-confirmation")).toBe("no-edge");
    expect(verdicts.get("smart-money-congress-buys")).toBe("no-edge");
    expect(verdicts.get("smart-money-large-bullish-premium")).toBe(
      "needs-more-data"
    );
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
});
