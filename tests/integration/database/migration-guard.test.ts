import { fileURLToPath } from "node:url";

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

import {
  checkAppliedMigrations,
  loadMigrationsFromGit,
  MIGRATIONS_SNAPSHOT_SQL,
  parsePostgresSnapshot,
} from "../../../scripts/migrations/check-applied.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

type SnapshotRow = Readonly<{
  a: string;
  b: string;
  c: string;
  kind: string;
}>;
let testDatabase: PostgresTestDatabase;
let databaseResource: DatabaseResource;

const captureSnapshot = async (): Promise<string> => {
  const rows = await testDatabase.query<SnapshotRow>(MIGRATIONS_SNAPSHOT_SQL);
  return rows.map((r) => `${r.kind}\t${r.a}\t${r.b}\t${r.c}`).join("\n");
};

describe("QuantVPS migration guard against real Postgres", {
  concurrent: false,
}, () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    databaseResource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
    });
    await migrate(databaseResource.db);
  });

  afterAll(async () => {
    if (databaseResource) {
      await databaseResource.close();
    }
    if (testDatabase) {
      await dropPostgresTestDatabase(testDatabase);
    }
  });

  it("verifies all repository migrations pass on a migrated database, even without a Drizzle ledger, and flags a missing table", async () => {
    const loaded = loadMigrationsFromGit(PROJECT_ROOT, "HEAD");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // 1. Fully migrated database with Drizzle ledger present.
    const fullRaw = await captureSnapshot();
    const fullParsed = parsePostgresSnapshot(fullRaw);
    expect(fullParsed.ok).toBe(true);
    if (!fullParsed.ok) return;

    const fullReport = checkAppliedMigrations(
      loaded.migrations,
      fullParsed.snapshot
    );
    expect(fullReport.missing).toEqual([]);
    expect(fullReport.ok).toBe(true);
    expect(fullReport.checkedCount).toBe(loaded.migrations.length);
    expect(fullReport.ledgerCount).toBe(loaded.migrations.length);

    // 2. Same database with drizzle.__drizzle_migrations dropped (simulates QuantVPS psql applies).
    await testDatabase.query("DROP TABLE drizzle.__drizzle_migrations");
    const noLedgerRaw = await captureSnapshot();
    const noLedgerParsed = parsePostgresSnapshot(noLedgerRaw);
    expect(noLedgerParsed.ok).toBe(true);
    if (!noLedgerParsed.ok) return;

    const noLedgerReport = checkAppliedMigrations(
      loaded.migrations,
      noLedgerParsed.snapshot
    );
    expect(noLedgerReport.missing).toEqual([]);
    expect(noLedgerReport.ok).toBe(true);
    expect(noLedgerReport.ledgerCount).toBe(0);

    // 3. Drop research_screen_rows (reproduces vertex-research-screen-storage-503).
    await testDatabase.query("DROP TABLE public.research_screen_rows");
    const missingRaw = await captureSnapshot();
    const missingParsed = parsePostgresSnapshot(missingRaw);
    expect(missingParsed.ok).toBe(true);
    if (!missingParsed.ok) return;

    const missingReport = checkAppliedMigrations(
      loaded.migrations,
      missingParsed.snapshot
    );
    expect(missingReport.ok).toBe(false);
    expect(missingReport.missing).toContainEqual(
      expect.objectContaining({
        reasons: expect.arrayContaining(["missing table research_screen_rows"]),
        tag: "0076_research_screen",
      })
    );
  });
});
