import { readFileSync } from "node:fs";

import { createNodeDatabase, type Database } from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Data migration 0081 (agent vocabulary for flow control) and its guarded rollback on a real database.
const migrationSql = readFileSync(
  new URL(
    "../../../packages/db/migrations/0081_semantic_terms_flow_control.sql",
    import.meta.url
  ),
  "utf8"
);
const rollbackSql = readFileSync(
  new URL(
    "../../../packages/db/rollback/0081_semantic_terms_flow_control.down.sql",
    import.meta.url
  ),
  "utf8"
);
const IDS = "'options_net_drift', 'futures_deep_trades', 'flow_control_state'";

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};

const count = async (where: string): Promise<number> => {
  const result = await postgres().query<{ n: number }>(
    `select count(*)::int as n from semantic_terms where ${where}`
  );
  return result[0]?.n ?? Number.NaN;
};

const refusesRollback = async (): Promise<void> => {
  await expect(postgres().query(rollbackSql)).rejects.toThrow(
    /refusing rollback/u
  );
  // The refused rollback leaves its BEGIN open on this connection; end it.
  await postgres().query("ROLLBACK");
  expect(await count(`id in (${IDS})`)).toBe(3);
};

describe("0081 flow control terms (Postgres)", () => {
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

  it("inserts the three uncertified terms with source none once and leaves the other terms alone", async () => {
    const others = await count(`id not in (${IDS})`);
    const driftLevel = await postgres().query(
      "select label, description, synonyms from semantic_terms where id = 'drift_level'"
    );
    expect(
      await count(
        `id in (${IDS}) and source = 'none' and not certified and feed_path is null and updated_by is null`
      )
    ).toBe(3);
    // Applying the file again changes nothing (ON CONFLICT DO NOTHING).
    await postgres().query(migrationSql);
    expect(await count(`id in (${IDS})`)).toBe(3);
    expect(await count(`id not in (${IDS})`)).toBe(others);
    expect(
      await postgres().query(
        "select label, description, synonyms from semantic_terms where id = 'drift_level'"
      )
    ).toEqual(driftLevel);
    expect(driftLevel).toHaveLength(1);
  });

  it("refuses the rollback while an operator edited a term", async () => {
    await postgres().query(
      "update semantic_terms set updated_by = 'u_owner' where id = 'options_net_drift'"
    );
    await refusesRollback();
    await postgres().query(
      "update semantic_terms set updated_by = null where id = 'options_net_drift'"
    );
  });

  it("refuses the rollback while a term is certified", async () => {
    await postgres().query(
      "update semantic_terms set certified = true, certified_at = now(), certified_by = 'u_owner' where id = 'futures_deep_trades'"
    );
    await refusesRollback();
    await postgres().query(
      "update semantic_terms set certified = false, certified_at = null, certified_by = null where id = 'futures_deep_trades'"
    );
  });

  it("refuses the rollback while a term has a certification note and no certification", async () => {
    // An operator who declines a term leaves a note; updated_by and certified stay unset.
    await postgres().query(
      "update semantic_terms set certification_note = 'declined: wording' where id = 'futures_deep_trades'"
    );
    await refusesRollback();
    await postgres().query(
      "update semantic_terms set certification_note = null where id = 'futures_deep_trades'"
    );
  });

  it("refuses the rollback while a SQL attribute belongs to a term", async () => {
    await postgres().query(
      "insert into semantic_sql_attributes (id, term_id, description, sql) values ('flow_control_guard', 'flow_control_state', 'guard test', 'select 1')"
    );
    await refusesRollback();
    await postgres().query(
      "delete from semantic_sql_attributes where id = 'flow_control_guard'"
    );
  });

  it("deletes only the three terms when nothing was edited", async () => {
    const others = await count(`id not in (${IDS})`);
    await postgres().query(rollbackSql);
    expect(await count(`id in (${IDS})`)).toBe(0);
    expect(await count(`id not in (${IDS})`)).toBe(others);
  });
});
