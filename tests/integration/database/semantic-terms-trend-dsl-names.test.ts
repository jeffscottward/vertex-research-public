import { readFileSync } from "node:fs";

import { createNodeDatabase, type Database } from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Data migration 0075 (strategy DSL sentence in three trend indicator descriptions) and its guarded rollback on a
// real database.
const migrationSql = readFileSync(
  new URL(
    "../../../packages/db/migrations/0075_semantic_terms_trend_dsl_names.sql",
    import.meta.url
  ),
  "utf8"
);
const rollbackSql = readFileSync(
  new URL(
    "../../../packages/db/rollback/0075_semantic_terms_trend_dsl_names.down.sql",
    import.meta.url
  ),
  "utf8"
);
const IDS = "'supertrend', 'alphatrend', 'chandelier_exit'";
const DSL = "In the strategy DSL it is the indicator";

type Row = Readonly<{ id: string; description: string; stamp: string }>;

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};

/** Every term with its text and row version, ordered by id. */
const rows = (): Promise<readonly Row[]> =>
  postgres().query<Row>(
    "select id, description, updated_at::text as stamp from semantic_terms order by id"
  );

const count = async (where: string): Promise<number> => {
  const result = await postgres().query<{ n: number }>(
    `select count(*)::int as n from semantic_terms where ${where}`
  );
  return result[0]?.n ?? Number.NaN;
};

const withSentence = (): Promise<number> =>
  count(`id in (${IDS}) and description like '%${DSL}%'`);

const refusesRollback = async (): Promise<void> => {
  const before = await rows();
  await expect(postgres().query(rollbackSql)).rejects.toThrow(
    /refusing rollback/u
  );
  // The refused rollback leaves its BEGIN open on this connection; end it.
  await postgres().query("ROLLBACK");
  expect(await rows()).toEqual(before);
};

/** `set` puts one guard state on supertrend, `unset` removes it again. */
const GUARDS = [
  {
    name: "an operator edit",
    set: "updated_by = 'u_owner'",
    unset: "updated_by = null",
  },
  {
    name: "a certification",
    set: "certified = true, certified_at = now(), certified_by = 'u_owner'",
    unset: "certified = false, certified_at = null, certified_by = null",
  },
  {
    name: "a certification time",
    set: "certified_at = now()",
    unset: "certified_at = null",
  },
  {
    name: "a certifier",
    set: "certified_by = 'u_owner'",
    unset: "certified_by = null",
  },
  {
    name: "a certification note",
    set: "certification_note = 'declined: wording'",
    unset: "certification_note = null",
  },
] as const;

describe("0075 trend indicator DSL names (Postgres)", () => {
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

  it("gives the three terms the DSL sentence once and changes no row on a second run", async () => {
    expect(await withSentence()).toBe(3);
    expect(await count(`description like '%${DSL}%'`)).toBe(3);
    expect(await count(`id in (${IDS}) and updated_by is null`)).toBe(3);
    const before = await rows();
    await postgres().query(migrationSql);
    expect(await rows()).toEqual(before);
  });

  it("rolls back to the 0074 text with a new row version and applies again", async () => {
    const applied = await rows();
    await postgres().query(rollbackSql);
    const rolledBack = await rows();
    expect(await withSentence()).toBe(0);
    for (const [index, row] of rolledBack.entries()) {
      const was = applied[index];
      if (IDS.includes(`'${row.id}'`)) {
        expect(was?.description.startsWith(`${row.description} ${DSL}`)).toBe(
          true
        );
        expect(row.stamp).not.toBe(was?.stamp);
      } else expect(row).toEqual(was);
    }
    await postgres().query(migrationSql);
    const again = await rows();
    for (const [index, row] of again.entries()) {
      expect(row.description).toBe(applied[index]?.description);
      if (IDS.includes(`'${row.id}'`))
        expect(row.stamp).not.toBe(rolledBack[index]?.stamp);
    }
  });

  it.each(GUARDS)(
    "refuses the rollback and skips the update while a term has $name",
    async ({ set, unset }) => {
      await postgres().query(
        `update semantic_terms set ${set} where id = 'supertrend'`
      );
      await refusesRollback();
      await postgres().query(
        `update semantic_terms set ${unset} where id = 'supertrend'`
      );
      // Back to the 0074 text, then the mark: the update skips that row only.
      await postgres().query(rollbackSql);
      await postgres().query(
        `update semantic_terms set ${set} where id = 'supertrend'`
      );
      const marked = (await rows()).find((row) => row.id === "supertrend");
      await postgres().query(migrationSql);
      expect(await withSentence()).toBe(2);
      expect((await rows()).find((row) => row.id === "supertrend")).toEqual(
        marked
      );
      await postgres().query(
        `update semantic_terms set ${unset} where id = 'supertrend'`
      );
      await postgres().query(migrationSql);
      expect(await withSentence()).toBe(3);
    }
  );

  it("refuses the rollback and skips the update while a description was changed outside the application", async () => {
    // A direct SQL change leaves no operator mark; the text hash catches it.
    await postgres().query(
      "update semantic_terms set description = description || ' Local note.' where id = 'alphatrend'"
    );
    await refusesRollback();
    await postgres().query(
      "update semantic_terms set description = left(description, length(description) - length(' Local note.')) where id = 'alphatrend'"
    );
    await postgres().query(rollbackSql);
    await postgres().query(
      "update semantic_terms set description = description || ' Local note.' where id = 'alphatrend'"
    );
    const changed = (await rows()).find((row) => row.id === "alphatrend");
    await postgres().query(migrationSql);
    expect(await withSentence()).toBe(2);
    expect((await rows()).find((row) => row.id === "alphatrend")).toEqual(
      changed
    );
    // Reset: remove the note; the update then applies to the row.
    await postgres().query(
      "update semantic_terms set description = left(description, length(description) - length(' Local note.')) where id = 'alphatrend'"
    );
    await postgres().query(migrationSql);
    expect(await withSentence()).toBe(3);
  });
});
