import {
  createNodeDatabase,
  type DatabaseResource,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0104 on real Postgres. The test role owns jev_verdict_log, as the app
// role "vertex_research" does on production, so a grant cannot stop it. The
// triggers must reject UPDATE, DELETE and TRUNCATE for the owner too.

const APPEND_ONLY = { code: "23514" };

let testDatabase: PostgresTestDatabase;
let databaseResource: DatabaseResource;

describe("migration 0104 jev_verdict_log append-only for the table owner", {
  concurrent: false,
}, () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    databaseResource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 2,
    });
    return await migrate(databaseResource.db);
  }, 60_000);

  afterAll(async () => {
    try {
      if (databaseResource !== undefined) return await databaseResource.close();
      return;
    } finally {
      if (testDatabase !== undefined)
        await dropPostgresTestDatabase(testDatabase);
    }
  }, 60_000);

  it("inserts and reads rows, and rejects update, delete and truncate by the owner", async () => {
    const database = testDatabase;
    const owner = await database.query<{ owned: boolean }>(
      "SELECT tableowner = current_user AS owned FROM pg_tables WHERE tablename = 'jev_verdict_log'"
    );
    expect(owner[0]?.owned).toBe(true);

    await database.query(
      `INSERT INTO jev_verdict_log
         (id, source, symbol, decided_at, stance, prob_bearish, prob_bullish, prob_neutral, logged_at)
       VALUES ('log-1', 'jev-verdict', 'SPY', now(), 'BULLISH', 0.1, 0.7, 0.2, now())`
    );

    for (const statement of [
      "UPDATE jev_verdict_log SET stance = 'BEARISH' WHERE id = 'log-1'",
      "DELETE FROM jev_verdict_log WHERE id = 'log-1'",
      "TRUNCATE jev_verdict_log",
    ])
      await expect(database.query(statement)).rejects.toMatchObject(
        APPEND_ONLY
      );

    const rows = await database.query<{ stance: string }>(
      "SELECT stance FROM jev_verdict_log WHERE id = 'log-1'"
    );
    expect(rows).toEqual([{ stance: "BULLISH" }]);
  });
});
