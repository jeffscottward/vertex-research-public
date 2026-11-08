import { readFileSync } from "node:fs";

import { createNodeDatabase, type Database } from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Data migration 0059 (qc-port run A definitions linked from the library) and its guarded rollback.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migrationSql = read(
  "../../../packages/db/migrations/0059_qc_port_definitions.sql"
);
const rollbackSql = read(
  "../../../packages/db/rollback/0059_qc_port_definitions.down.sql"
);
const catalogRollbackSql = read(
  "../../../packages/db/rollback/0057_strategy_catalog_qc_ports.down.sql"
);
const IDEA = "qc-opex-week";

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};

const count = async (statement: string): Promise<number> => {
  const [row] = await postgres().query<{ n: number }>(
    `select count(*)::int as n from (${statement}) rows`
  );
  return row?.n ?? Number.NaN;
};
const revisions = () =>
  count(
    "select 1 from strategy_definition_revisions where definition_id like 'qc-%'"
  );
const linked = () =>
  count(
    "select 1 from strategies where id like 'strategy-seed-qc-%' and params <> '[]'::jsonb"
  );

const expectRefused = async (pattern: RegExp) => {
  await expect(postgres().query(rollbackSql)).rejects.toThrow(pattern);
  // The refused rollback leaves its BEGIN open on this connection; end it.
  await postgres().query("ROLLBACK");
};

describe("0059 qc-port definitions (Postgres)", () => {
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

  it("stores the 11 revisions and links each library row, leaving updated_at alone", async () => {
    expect(await revisions()).toBe(11);
    expect(await linked()).toBe(11);
    const [row] = await postgres().query<{
      sha256: string;
      name: string;
      definition: Record<string, unknown>;
      params: Array<{ name: string; default: string; options: string[] }>;
      edited: boolean;
    }>(
      `select r.sha256, r.name, r.definition, s.params, s.updated_at <> s.created_at as edited
       from strategy_definition_revisions r join strategies s on s.id = 'strategy-seed-' || r.definition_id
       where r.id = 'qc-def-${IDEA}-r1' and r.revision = 1 and r.created_by = 'migration:0059'`
    );
    expect(row?.definition["name"]).toBe(row?.name);
    expect(row?.edited).toBe(false);
    expect(
      row?.params.map((param) => [param.name, param.default, param.options])
    ).toEqual([
      ["definitionId", IDEA, [IDEA]],
      ["definitionSha256", row?.sha256, [row?.sha256]],
      ["runFrom", "1993-01-29", ["1993-01-29"]],
      ["initialCapital", "100000", ["100000"]],
    ]);
  });

  it("re-runs without duplicating rows or overwriting edited params", async () => {
    await postgres().query(
      `update strategies set params = '[{"name":"x","type":"boolean","title":"X","default":true}]'::jsonb where id = 'strategy-seed-${IDEA}'`
    );
    await postgres().query(migrationSql);
    expect(await revisions()).toBe(11);
    const [row] = await postgres().query<{ name: string }>(
      `select params->0->>'name' as name from strategies where id = 'strategy-seed-${IDEA}'`
    );
    expect(row?.name).toBe("x");
  });

  it("refuses the rollback while library params differ from what 0059 set", async () => {
    await expectRefused(/library params were changed after 0059/u);
    await postgres().query(
      `update strategies set params = '[]'::jsonb where id = 'strategy-seed-${IDEA}'`
    );
    await postgres().query(migrationSql);
    expect(await linked()).toBe(11);
  });

  it("refuses the rollback while a later revision or another author's row exists", async () => {
    await postgres().query(
      `insert into strategy_definition_revisions (id, definition_id, revision, name, definition, sha256, created_by)
       values ('later', '${IDEA}', 2, 'OpEx week', '{}'::jsonb, '${"a".repeat(64)}', 'operator')`
    );
    await expectRefused(/later revisions or rows by other authors/u);
    await postgres().query(
      "delete from strategy_definition_revisions where id = 'later'"
    );
    await postgres().query(
      `update strategy_definition_revisions set created_by = 'operator' where id = 'qc-def-${IDEA}-r1'`
    );
    await expectRefused(/later revisions or rows by other authors/u);
    await postgres().query(
      `update strategy_definition_revisions set created_by = 'migration:0059' where id = 'qc-def-${IDEA}-r1'`
    );
    expect(await revisions()).toBe(11);
  });

  it("links library params only when the matching 0059 revision is present", async () => {
    const [original] = await postgres().query<{ sha256: string }>(
      `select sha256 from strategy_definition_revisions where id = 'qc-def-${IDEA}-r1'`
    );
    await postgres().query(
      `update strategy_definition_revisions set sha256 = '${"b".repeat(64)}' where id = 'qc-def-${IDEA}-r1'`
    );
    await postgres().query(
      `update strategies set params = '[]'::jsonb where id = 'strategy-seed-${IDEA}'`
    );
    await postgres().query(migrationSql);
    expect(await linked()).toBe(10);
    await postgres().query(
      `update strategy_definition_revisions set sha256 = '${original?.sha256}' where id = 'qc-def-${IDEA}-r1'`
    );
    await postgres().query(migrationSql);
    expect(await linked()).toBe(11);
  });

  it("refuses the rollback while a seed strategy is referenced", async () => {
    await postgres().query(
      `insert into strategy_presets (id, strategy_id, name) values ('qc-ref', 'strategy-seed-${IDEA}', 'Ref')`
    );
    await expectRefused(/referenced by runs, results or specs/u);
    await postgres().query("delete from strategy_presets where id = 'qc-ref'");
    expect(await revisions()).toBe(11);
  });

  return it("rolls back to the 0057 state, which can itself roll back", async () => {
    await postgres().query(rollbackSql);
    expect(await revisions()).toBe(0);
    expect(await linked()).toBe(0);
    await postgres().query(catalogRollbackSql);
    expect(await count("select 1 from strategies where slug like 'qc-%'")).toBe(
      0
    );
  });
});
