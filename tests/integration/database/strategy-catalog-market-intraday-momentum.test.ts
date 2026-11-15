import { readFileSync } from "node:fs";

import { createNodeDatabase, type Database } from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Data migration 0063 (market intraday momentum reel strategy) and its guarded rollback on a real database.
const migrationSql = readFileSync(
  new URL(
    "../../../packages/db/migrations/0063_strategy_catalog_market_intraday_momentum.sql",
    import.meta.url
  ),
  "utf8"
);
const rollbackSql = readFileSync(
  new URL(
    "../../../packages/db/rollback/0063_strategy_catalog_market_intraday_momentum.down.sql",
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

const countRows = async (): Promise<number> => {
  const result = await postgres().query<{ n: number }>(
    "select count(*)::int as n from strategies where slug = 'market-intraday-momentum'"
  );
  return result[0]?.n ?? Number.NaN;
};

describe("0063 market intraday momentum catalog row (Postgres)", () => {
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

  it("inserts the research-only row once, tagged for its backtest study", async () => {
    expect(await countRows()).toBe(1);
    const [row] = await postgres().query<{
      id: string;
      section: string;
      status: string;
      study: boolean;
      research: boolean;
    }>(
      "select id, section, status, tags ? 'backtest-study' as study, tags ? 'research-only' as research from strategies where slug = 'market-intraday-momentum'"
    );
    expect(row).toEqual({
      id: "strategy-seed-market-intraday-momentum",
      research: true,
      section: "Reel ideas",
      status: "backtested",
      study: true,
    });
    await postgres().query(migrationSql);
    return expect(await countRows()).toBe(1);
  });

  it("refuses the rollback while the row was edited", async () => {
    await postgres().query(
      "update strategies set updated_at = updated_at + interval '1 second' where slug = 'market-intraday-momentum'"
    );
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    await postgres().query("ROLLBACK");
    expect(await countRows()).toBe(1);
    await postgres().query(
      "update strategies set updated_at = created_at where slug = 'market-intraday-momentum'"
    );
  });

  it("refuses the rollback while a backtest run references the row", async () => {
    await postgres().query(
      "insert into backtest_runs (id, status, spec, engine_version, requested_by, strategy_id) values ('imom-guard-run', 'queued', '{}'::jsonb, 'test', 'test', 'strategy-seed-market-intraday-momentum')"
    );
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    // The refused rollback leaves its BEGIN open on this connection; end it.
    await postgres().query("ROLLBACK");
    expect(await countRows()).toBe(1);
    await postgres().query(
      "delete from backtest_runs where id = 'imom-guard-run'"
    );
  });

  return it("deletes the row when nothing references it", async () => {
    await postgres().query(rollbackSql);
    return expect(await countRows()).toBe(0);
  });
});
