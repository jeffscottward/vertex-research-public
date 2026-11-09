import { readFileSync } from "node:fs";

import { createNodeDatabase, type Database } from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Data migration 0057 (QuantConnect idea ports) and its guarded rollback on a real database.
const migrationSql = readFileSync(
  new URL(
    "../../../packages/db/migrations/0057_strategy_catalog_qc_ports.sql",
    import.meta.url
  ),
  "utf8"
);
const rollbackSql = readFileSync(
  new URL(
    "../../../packages/db/rollback/0057_strategy_catalog_qc_ports.down.sql",
    import.meta.url
  ),
  "utf8"
);
const definitionsRollbackSql = readFileSync(
  new URL(
    "../../../packages/db/rollback/0061_qc_port_definitions.down.sql",
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
    "select count(*)::int as n from strategies where slug like 'qc-%'"
  );
  return result[0]?.n ?? Number.NaN;
};

describe("0057 qc-port catalog rows (Postgres)", () => {
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

  it("inserts the 11 research-only rows once", async () => {
    expect(await countRows()).toBe(11);
    await postgres().query(migrationSql);
    return expect(await countRows()).toBe(11);
  });

  it("refuses the rollback while the 0061 definitions exist", async () => {
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /the qc-port definitions of 0061 still exist; roll back 0061 first/u
    );
    // The refused rollback leaves its BEGIN open on this connection; end it.
    await postgres().query("ROLLBACK");
    expect(await countRows()).toBe(11);
    await postgres().query(definitionsRollbackSql);
    const [left] = await postgres().query<{ n: number }>(
      "select count(*)::int as n from strategy_definition_revisions where created_by = 'migration:0061'"
    );
    expect(left?.n).toBe(0);
  });

  it("refuses the rollback while a backtest run references a row", async () => {
    await postgres().query(
      "insert into backtest_runs (id, status, spec, engine_version, requested_by, strategy_id) values ('qc-guard-run', 'queued', '{}'::jsonb, 'test', 'test', 'strategy-seed-qc-opex-week')"
    );
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    // The refused rollback leaves its BEGIN open on this connection; end it.
    await postgres().query("ROLLBACK");
    expect(await countRows()).toBe(11);
    await postgres().query(
      "delete from backtest_runs where id = 'qc-guard-run'"
    );
  });

  return it("deletes the rows when nothing references them", async () => {
    await postgres().query(rollbackSql);
    return expect(await countRows()).toBe(0);
  });
});
