import { readFileSync } from "node:fs";

import { createNodeDatabase, type Database } from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Data migration 0074 (agent vocabulary for the five trend indicators) and its guarded rollback on a real database.
const migrationSql = readFileSync(
  new URL(
    "../../../packages/db/migrations/0074_semantic_terms_trend_indicators.sql",
    import.meta.url
  ),
  "utf8"
);
const rollbackSql = readFileSync(
  new URL(
    "../../../packages/db/rollback/0074_semantic_terms_trend_indicators.down.sql",
    import.meta.url
  ),
  "utf8"
);
const IDS =
  "'supertrend', 'ultimate_ma', 'alphatrend', 'chandelier_exit', 'slingshot'";

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
  expect(await count(`id in (${IDS})`)).toBe(5);
};

describe("0074 trend indicator terms (Postgres)", () => {
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

  it("inserts the five uncertified terms with source none once and leaves the other terms alone", async () => {
    const others = await count(`id not in (${IDS})`);
    expect(
      await count(
        `id in (${IDS}) and source = 'none' and not certified and feed_path is null and updated_by is null`
      )
    ).toBe(5);
    // Applying the file again changes nothing (ON CONFLICT DO NOTHING).
    await postgres().query(migrationSql);
    expect(await count(`id in (${IDS})`)).toBe(5);
    expect(await count(`id not in (${IDS})`)).toBe(others);
  });

  it("refuses the rollback while an operator edited a term", async () => {
    await postgres().query(
      "update semantic_terms set updated_by = 'u_owner' where id = 'supertrend'"
    );
    await refusesRollback();
    await postgres().query(
      "update semantic_terms set updated_by = null where id = 'supertrend'"
    );
  });

  it("refuses the rollback while a term is certified", async () => {
    await postgres().query(
      "update semantic_terms set certified = true, certified_at = now(), certified_by = 'u_owner' where id = 'slingshot'"
    );
    await refusesRollback();
    await postgres().query(
      "update semantic_terms set certified = false, certified_at = null, certified_by = null where id = 'slingshot'"
    );
  });

  it("refuses the rollback while a term has a certification note and no certification", async () => {
    // An operator who declines a term leaves a note; updated_by and certified stay unset.
    await postgres().query(
      "update semantic_terms set certification_note = 'declined: wording' where id = 'ultimate_ma'"
    );
    await refusesRollback();
    await postgres().query(
      "update semantic_terms set certification_note = null where id = 'ultimate_ma'"
    );
  });

  it("refuses the rollback while a SQL attribute belongs to a term", async () => {
    await postgres().query(
      "insert into semantic_sql_attributes (id, term_id, description, sql) values ('alphatrend_guard', 'alphatrend', 'guard test', 'select 1')"
    );
    await refusesRollback();
    await postgres().query(
      "delete from semantic_sql_attributes where id = 'alphatrend_guard'"
    );
  });

  it("deletes only the five terms when nothing was edited", async () => {
    const others = await count(`id not in (${IDS})`);
    await postgres().query(rollbackSql);
    expect(await count(`id in (${IDS})`)).toBe(0);
    expect(await count(`id not in (${IDS})`)).toBe(others);
  });
});
