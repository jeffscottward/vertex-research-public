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

  it("verifies all repository migrations pass on a migrated database, even without a Drizzle ledger, and flags missing tables, constraints, triggers, and functions", async () => {
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

    // 4. Revert flow_large_trades_check to pre-0083 (without 'streamed') -> flags 0083_flow_capture_streamed.
    await testDatabase.query(
      "ALTER TABLE public.flow_large_trades DROP CONSTRAINT flow_large_trades_check"
    );
    await testDatabase.query(
      `ALTER TABLE public.flow_large_trades ADD CONSTRAINT flow_large_trades_check CHECK (symbol IN ('ES', 'NQ') AND capture = 'sampled')`
    );
    const staleCheckRaw = await captureSnapshot();
    const staleCheckParsed = parsePostgresSnapshot(staleCheckRaw);
    expect(staleCheckParsed.ok).toBe(true);
    if (!staleCheckParsed.ok) return;

    const staleCheckReport = checkAppliedMigrations(
      loaded.migrations,
      staleCheckParsed.snapshot
    );
    expect(staleCheckReport.ok).toBe(false);
    expect(staleCheckReport.missing).toContainEqual(
      expect.objectContaining({
        reasons: expect.arrayContaining([
          "constraint flow_large_trades.flow_large_trades_check missing 'streamed'",
        ]),
        tag: "0083_flow_capture_streamed",
      })
    );

    // 5. Drop an existing trigger -> flags 0005_workflow_durability.
    await testDatabase.query(
      "DROP TRIGGER workflow_journal_immutable ON public.workflow_journal"
    );
    const missingTriggerRaw = await captureSnapshot();
    const missingTriggerParsed = parsePostgresSnapshot(missingTriggerRaw);
    expect(missingTriggerParsed.ok).toBe(true);
    if (!missingTriggerParsed.ok) return;

    const missingTriggerReport = checkAppliedMigrations(
      loaded.migrations,
      missingTriggerParsed.snapshot
    );
    expect(missingTriggerReport.ok).toBe(false);
    expect(missingTriggerReport.missing).toContainEqual(
      expect.objectContaining({
        reasons: expect.arrayContaining([
          "missing trigger workflow_journal.workflow_journal_immutable",
        ]),
        tag: "0005_workflow_durability",
      })
    );

    // 6. Disable an existing trigger -> flags 0008_vertex_buildout.
    await testDatabase.query(
      "ALTER TABLE public.vertex_portfolio_epoch_transitions DISABLE TRIGGER vertex_epoch_transition_immutable"
    );
    const disabledTriggerRaw = await captureSnapshot();
    const disabledTriggerParsed = parsePostgresSnapshot(disabledTriggerRaw);
    expect(disabledTriggerParsed.ok).toBe(true);
    if (!disabledTriggerParsed.ok) return;

    const disabledTriggerReport = checkAppliedMigrations(
      loaded.migrations,
      disabledTriggerParsed.snapshot
    );
    expect(disabledTriggerReport.ok).toBe(false);
    expect(disabledTriggerReport.missing).toContainEqual(
      expect.objectContaining({
        reasons: expect.arrayContaining([
          "trigger vertex_portfolio_epoch_transitions.vertex_epoch_transition_immutable is disabled",
        ]),
        tag: "0008_vertex_buildout",
      })
    );

    // 7. Drop a trigger function (CASCADE) -> flags 0008_vertex_buildout for both function and dependent triggers.
    await testDatabase.query(
      "DROP FUNCTION public.vertex_reject_native_approval_audit_mutation() CASCADE"
    );
    const missingFnRaw = await captureSnapshot();
    const missingFnParsed = parsePostgresSnapshot(missingFnRaw);
    expect(missingFnParsed.ok).toBe(true);
    if (!missingFnParsed.ok) return;

    const missingFnReport = checkAppliedMigrations(
      loaded.migrations,
      missingFnParsed.snapshot
    );
    expect(missingFnReport.ok).toBe(false);
    expect(missingFnReport.missing).toContainEqual(
      expect.objectContaining({
        reasons: expect.arrayContaining([
          "missing function vertex_reject_native_approval_audit_mutation",
          "missing trigger vertex_native_approval_audit.vertex_native_approval_audit_immutable",
          "missing trigger vertex_native_approval_audit.vertex_native_approval_audit_no_truncate",
        ]),
        tag: "0008_vertex_buildout",
      })
    );

    // 8. Drop 0104 trigger function (CASCADE) -> proves trigger-only migration 0104_jev_verdict_log_append_only is caught.
    await testDatabase.query(
      "DROP FUNCTION public.jev_verdict_log_reject_mutation() CASCADE"
    );
    const missing0104Raw = await captureSnapshot();
    const missing0104Parsed = parsePostgresSnapshot(missing0104Raw);
    expect(missing0104Parsed.ok).toBe(true);
    if (!missing0104Parsed.ok) return;

    const missing0104Report = checkAppliedMigrations(
      loaded.migrations,
      missing0104Parsed.snapshot
    );
    expect(missing0104Report.ok).toBe(false);
    expect(missing0104Report.missing).toContainEqual(
      expect.objectContaining({
        reasons: expect.arrayContaining([
          "missing function jev_verdict_log_reject_mutation",
          "missing trigger jev_verdict_log.jev_verdict_log_immutable",
          "missing trigger jev_verdict_log.jev_verdict_log_no_truncate",
        ]),
        tag: "0104_jev_verdict_log_append_only",
      })
    );
  });
});
