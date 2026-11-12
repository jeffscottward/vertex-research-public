import { readFileSync } from "node:fs";

import { createNodeDatabase, type Database } from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Data migration 0070 (Triple RSI, tested and failed) and its guarded rollback on a real database.
const migrationSql = readFileSync(
  new URL(
    "../../../packages/db/migrations/0070_strategy_catalog_triple_rsi.sql",
    import.meta.url
  ),
  "utf8"
);
const rollbackSql = readFileSync(
  new URL(
    "../../../packages/db/rollback/0070_strategy_catalog_triple_rsi.down.sql",
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
    "select count(*)::int as n from strategies where slug = 'triple-rsi'"
  );
  return result[0]?.n ?? Number.NaN;
};

describe("0070 Triple RSI catalog row (Postgres)", () => {
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

  it("inserts the research-only row once, tagged failed and for its backtest study", async () => {
    expect(await countRows()).toBe(1);
    const [row] = await postgres().query<{
      id: string;
      section: string;
      status: string;
      study: boolean;
      research: boolean;
      failed: boolean;
      claim: string;
    }>(
      "select id, section, status, tags ? 'backtest-study' as study, tags ? 'research-only' as research, tags ? 'failed' as failed, external_validation ->> 'sourceUrl' as claim from strategies where slug = 'triple-rsi'"
    );
    expect(row).toEqual({
      claim:
        "https://www.quantifiedstrategies.com/triple-rsi-trading-strategy/",
      failed: true,
      id: "strategy-seed-triple-rsi",
      research: true,
      section: "Entry timing",
      status: "backtested",
      study: true,
    });
    await postgres().query(migrationSql);
    return expect(await countRows()).toBe(1);
  });

  it("refuses the rollback while the row was edited", async () => {
    await postgres().query(
      "update strategies set updated_at = updated_at + interval '1 second' where slug = 'triple-rsi'"
    );
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    await postgres().query("ROLLBACK");
    expect(await countRows()).toBe(1);
    await postgres().query(
      "update strategies set updated_at = created_at where slug = 'triple-rsi'"
    );
  });

  it("refuses the rollback while a backtest run references the row", async () => {
    await postgres().query(
      "insert into backtest_runs (id, status, spec, engine_version, requested_by, strategy_id) values ('trsi-guard-run', 'queued', '{}'::jsonb, 'test', 'test', 'strategy-seed-triple-rsi')"
    );
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    // The refused rollback leaves its BEGIN open on this connection; end it.
    await postgres().query("ROLLBACK");
    expect(await countRows()).toBe(1);
    await postgres().query(
      "delete from backtest_runs where id = 'trsi-guard-run'"
    );
  });

  return it("deletes the row when nothing references it", async () => {
    await postgres().query(rollbackSql);
    return expect(await countRows()).toBe(0);
  });
});
