import { readFileSync } from "node:fs";

import { createNodeDatabase, type Database } from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Data migrations 0073 (Trend Trio catalog row) and 0074 (its indicator vocabulary) and their guarded rollbacks
// on a real database. The description and the outcome tag change after the study and are not asserted.
const readSql = (path: string) =>
  readFileSync(
    new URL(`../../../packages/db/${path}`, import.meta.url),
    "utf8"
  );
const migrationSql = readSql("migrations/0073_strategy_catalog_trend_trio.sql");
const rollbackSql = readSql(
  "rollback/0073_strategy_catalog_trend_trio.down.sql"
);
const termsMigrationSql = readSql(
  "migrations/0074_semantic_terms_trend_indicators.sql"
);
const termsRollbackSql = readSql(
  "rollback/0074_semantic_terms_trend_indicators.down.sql"
);
const TERM_LIST =
  "('supertrend', 'ultimate_ma', 'alphatrend', 'chandelier_exit', 'slingshot')";

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};

const countRows = async (): Promise<number> => {
  const result = await postgres().query<{ n: number }>(
    "select count(*)::int as n from strategies where slug = 'trend-trio'"
  );
  return result[0]?.n ?? Number.NaN;
};

const countTerms = async (): Promise<number> => {
  const result = await postgres().query<{ n: number }>(
    `select count(*)::int as n from semantic_terms where id in ${TERM_LIST}`
  );
  return result[0]?.n ?? Number.NaN;
};

describe("0073 Trend Trio catalog row and 0074 indicator terms (Postgres)", () => {
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

  it("inserts the research-only reconstruction row once, tagged for its backtest study", async () => {
    expect(await countRows()).toBe(1);
    const [row] = await postgres().query<{
      id: string;
      section: string;
      status: string;
      study: boolean;
      research: boolean;
      reconstruction: boolean;
      claim: string;
      metrics: boolean;
    }>(
      "select id, section, status, tags ? 'backtest-study' as study, tags ? 'research-only' as research, tags ? 'reconstruction' as reconstruction, external_validation ->> 'sourceUrl' as claim, jsonb_array_length(external_validation -> 'claimedMetrics') > 0 as metrics from strategies where slug = 'trend-trio'"
    );
    expect(row).toEqual({
      claim: "https://www.instagram.com/reel/DfuMtdWKDB7/",
      id: "strategy-seed-trend-trio",
      metrics: true,
      reconstruction: true,
      research: true,
      section: "Reel ideas",
      status: "backtested",
      study: true,
    });
    await postgres().query(migrationSql);
    return expect(await countRows()).toBe(1);
  });

  it("inserts the five uncertified terms with source none once", async () => {
    const rows = await postgres().query<{ id: string }>(
      `select id from semantic_terms where id in ${TERM_LIST} and source = 'none' and not certified order by id`
    );
    expect(rows.map((row) => row.id)).toEqual([
      "alphatrend",
      "chandelier_exit",
      "slingshot",
      "supertrend",
      "ultimate_ma",
    ]);
    await postgres().query(termsMigrationSql);
    return expect(await countTerms()).toBe(5);
  });

  it("refuses the rollback while the row was edited", async () => {
    await postgres().query(
      "update strategies set updated_at = updated_at + interval '1 second' where slug = 'trend-trio'"
    );
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    await postgres().query("ROLLBACK");
    expect(await countRows()).toBe(1);
    await postgres().query(
      "update strategies set updated_at = created_at where slug = 'trend-trio'"
    );
  });

  it("refuses the rollback while a backtest run references the row", async () => {
    await postgres().query(
      "insert into backtest_runs (id, status, spec, engine_version, requested_by, strategy_id) values ('trio-guard-run', 'queued', '{}'::jsonb, 'test', 'test', 'strategy-seed-trend-trio')"
    );
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    // The refused rollback leaves its BEGIN open on this connection; end it.
    await postgres().query("ROLLBACK");
    expect(await countRows()).toBe(1);
    await postgres().query(
      "delete from backtest_runs where id = 'trio-guard-run'"
    );
  });

  it("refuses the terms rollback while a term was edited", async () => {
    await postgres().query(
      "update semantic_terms set updated_by = 'operator' where id = 'slingshot'"
    );
    await expect(postgres().query(termsRollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    await postgres().query("ROLLBACK");
    expect(await countTerms()).toBe(5);
    await postgres().query(
      "update semantic_terms set updated_by = null where id = 'slingshot'"
    );
  });

  it("deletes the row when nothing references it", async () => {
    await postgres().query(rollbackSql);
    return expect(await countRows()).toBe(0);
  });

  return it("deletes only the five terms when none was edited", async () => {
    const before = await postgres().query<{ n: number }>(
      "select count(*)::int as n from semantic_terms"
    );
    await postgres().query(termsRollbackSql);
    expect(await countTerms()).toBe(0);
    const after = await postgres().query<{ n: number }>(
      "select count(*)::int as n from semantic_terms"
    );
    return expect(after[0]?.n).toBe((before[0]?.n ?? 0) - 5);
  });
});
