import { readFileSync } from "node:fs";

import {
  createNodeDatabase,
  createStrategyLibraryRepository,
  type Database,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0065 (strategies.priority, strategies.external_validation and the volume spike breakout
// row) and its guarded rollback on a real database.
const migrationSql = readFileSync(
  new URL(
    "../../../packages/db/migrations/0065_strategy_catalog_volume_spike_breakout.sql",
    import.meta.url
  ),
  "utf8"
);
const rollbackSql = readFileSync(
  new URL(
    "../../../packages/db/rollback/0065_strategy_catalog_volume_spike_breakout.down.sql",
    import.meta.url
  ),
  "utf8"
);
// The DDL runs once; only the insert-if-missing statement may run again.
const insertSql = migrationSql.slice(migrationSql.indexOf("INSERT INTO"));
const OTHER_ROW =
  "insert into strategies (id, slug, name, kind, priority) values ('vsb-other', 'vsb-other', 'Other', 'python', 'high')";

const columnCount = async (): Promise<number> => {
  const result = await postgres().query<{ n: number }>(
    "select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'strategies' and column_name in ('priority', 'external_validation')"
  );
  return result[0]?.n ?? Number.NaN;
};

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};

const countRows = async (): Promise<number> => {
  const result = await postgres().query<{ n: number }>(
    "select count(*)::int as n from strategies where slug = 'volume-spike-breakout'"
  );
  return result[0]?.n ?? Number.NaN;
};

describe("0065 volume spike breakout catalog row (Postgres)", () => {
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

  it("inserts the high-priority research-only row once, with the source's claim", async () => {
    expect(await countRows()).toBe(1);
    const [row] = await postgres().query<Record<string, unknown>>(
      "select id, section, status, priority, tags ? 'backtest-study' as study, tags ? 'research-only' as research, tags ? 'externally-pre-validated' as claimed, external_validation ->> 'sourceUrl' as source, jsonb_array_length(external_validation -> 'claimedMetrics') as metrics from strategies where slug = 'volume-spike-breakout'"
    );
    expect(row).toEqual({
      claimed: true,
      id: "strategy-seed-volume-spike-breakout",
      metrics: 8,
      priority: "high",
      research: true,
      section: "Reel ideas",
      source: "https://youtu.be/XLMG6-SATRk",
      status: "backtested",
      study: true,
    });
    await postgres().query(insertSql);
    return expect(await countRows()).toBe(1);
  });

  it("defaults other rows to normal priority with no claim and refuses an unknown priority", async () => {
    const [counts] = await postgres().query<{ rows: number; plain: number }>(
      "select count(*)::int as rows, count(*) filter (where priority = 'normal' and external_validation is null)::int as plain from strategies where slug <> 'volume-spike-breakout'"
    );
    expect(counts?.rows).toBeGreaterThan(0);
    expect(counts?.plain).toBe(counts?.rows);
    return await expect(
      postgres().query(
        "update strategies set priority = 'urgent' where slug = 'volume-spike-breakout'"
      )
    ).rejects.toThrow(/strategies_priority_check/u);
  });

  it("reads the row through the repository with its parsed claim", async () => {
    if (resource === undefined) throw new Error("Database not started");
    const found = await createStrategyLibraryRepository(resource.db).get(
      "strategy-seed-volume-spike-breakout"
    );
    expect(found?.strategy.priority).toBe("high");
    expect(found?.strategy.externalValidation?.publishedOn).toBe("2026-09-24");
    return expect(
      found?.strategy.externalValidation?.claimedMetrics[0]
    ).toEqual({
      label: "Rank",
      value: "1 of 10,500 by total net R",
    });
  });

  it("keeps the high-priority row in a list limited to one row, ahead of a newer normal row", async () => {
    if (resource === undefined) throw new Error("Database not started");
    await postgres().query(
      "insert into strategies (id, slug, name, kind, created_at, updated_at) values ('vsb-newer', 'vsb-newer', 'Newer', 'python', now() + interval '1 day', now() + interval '1 day')"
    );
    const rows = await createStrategyLibraryRepository(resource.db).list({
      limit: 1,
    });
    expect(rows.map((row) => [row.id, row.priority])).toEqual([
      ["strategy-seed-volume-spike-breakout", "high"],
    ]);
    const two = await createStrategyLibraryRepository(resource.db).list({
      limit: 2,
    });
    expect(two[1]?.id).toBe("vsb-newer");
    await postgres().query("delete from strategies where id = 'vsb-newer'");
  });

  it("refuses an external claim that is not a JSON object", async () => {
    for (const value of [`'"claim"'`, "'[]'", "'null'", "'1'"]) {
      await expect(
        postgres().query(
          `update strategies set external_validation = ${value}::jsonb where slug = 'volume-spike-breakout'`
        ),
        value
      ).rejects.toThrow(/strategies_external_validation_check/u);
    }
    const [row] = await postgres().query<{ kind: string }>(
      "select jsonb_typeof(external_validation) as kind from strategies where slug = 'volume-spike-breakout'"
    );
    return expect(row?.kind).toBe("object");
  });

  it("clears a claim through the repository as SQL NULL, which the check accepts", async () => {
    if (resource === undefined) throw new Error("Database not started");
    const repository = createStrategyLibraryRepository(resource.db);
    const created = await repository.create({
      name: "Claim to clear",
      kind: "python",
      externalValidation: {
        sourceUrl: "https://video.example.test/claim",
        sourceTitle: "A claim",
        sourceAuthor: "Someone",
        publishedOn: "2026-09-24",
        claimedMethod: "One backtest.",
        claimedMetrics: [{ label: "Rank", value: "1" }],
      },
    });
    expect(created.externalValidation?.sourceTitle).toBe("A claim");
    const cleared = await repository.update({
      id: created.id,
      externalValidation: null,
    });
    expect(cleared?.externalValidation).toBeNull();
    const [stored] = await postgres().query<{ sql_null: boolean }>(
      `select external_validation is null as sql_null from strategies where id = '${created.id}'`
    );
    expect(stored?.sql_null).toBe(true);
    await postgres().query(`delete from strategies where id = '${created.id}'`);
  });

  it("refuses the rollback while the row was edited", async () => {
    await postgres().query(
      "update strategies set updated_at = updated_at + interval '1 second' where slug = 'volume-spike-breakout'"
    );
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    await postgres().query("ROLLBACK");
    expect(await countRows()).toBe(1);
    await postgres().query(
      "update strategies set updated_at = created_at where slug = 'volume-spike-breakout'"
    );
  });

  it("refuses the rollback while a backtest run references the row", async () => {
    await postgres().query(
      "insert into backtest_runs (id, status, spec, engine_version, requested_by, strategy_id) values ('vsb-guard-run', 'queued', '{}'::jsonb, 'test', 'test', 'strategy-seed-volume-spike-breakout')"
    );
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    // The refused rollback leaves its BEGIN open on this connection; end it.
    await postgres().query("ROLLBACK");
    expect(await countRows()).toBe(1);
    await postgres().query(
      "delete from backtest_runs where id = 'vsb-guard-run'"
    );
  });

  it("refuses to drop the columns while another row uses them, and keeps the row", async () => {
    await postgres().query(OTHER_ROW);
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /another strategy uses priority or external_validation; refusing rollback/u
    );
    await postgres().query("ROLLBACK");
    expect(await countRows()).toBe(1);
    expect(await columnCount()).toBe(2);
    await postgres().query("delete from strategies where id = 'vsb-other'");
  });

  return it("deletes the row and drops the two columns when nothing uses them", async () => {
    await postgres().query(rollbackSql);
    expect(await columnCount()).toBe(0);
    const [left] = await postgres().query<{ n: number }>(
      "select count(*)::int as n from strategies where id = 'strategy-seed-volume-spike-breakout'"
    );
    expect(left?.n).toBe(0);
    const [constraint] = await postgres().query<{ n: number }>(
      "select count(*)::int as n from pg_constraint where conname in ('strategies_priority_check', 'strategies_external_validation_check')"
    );
    return expect(constraint?.n).toBe(0);
  });
});
