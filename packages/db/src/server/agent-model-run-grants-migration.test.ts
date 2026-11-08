import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrations = new URL("../../migrations/", import.meta.url);
const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const migration = read("../../migrations/0054_agent_model_run_grants.sql");
const rollback = read("../../rollback/0054_agent_model_run_grants.down.sql");

// What the agent-model-runs repository does: runs are recorded, read, locked FOR UPDATE while events
// are appended and updated; events are only appended and read. Nothing deletes from either table.
const granted: Record<string, string> = {
  agent_model_run_events: "SELECT, INSERT",
  agent_model_runs: "SELECT, INSERT, UPDATE",
};

const statements = (sql: string, verb: "GRANT" | "REVOKE"): string[] =>
  sql
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${verb} `));

describe("0054_agent_model_run_grants", () => {
  it("grants the app role exactly the privileges the model-run repository uses", () => {
    expect(statements(migration, "GRANT").sort()).toEqual(
      Object.entries(granted)
        .map(
          ([table, privileges]) =>
            `GRANT ${privileges} ON TABLE "${table}" TO "vertex_research";`
        )
        .sort()
    );
  });

  it("only grants when the app role exists, so fresh databases still migrate", () => {
    expect(migration).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN"
    );
  });

  it("rollback revokes only what the migration granted", () => {
    expect(statements(rollback, "REVOKE").sort()).toEqual(
      Object.entries(granted)
        .map(
          ([table, privileges]) =>
            `REVOKE ${privileges} ON TABLE "${table}" FROM "vertex_research";`
        )
        .sort()
    );
    expect(rollback).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN"
    );
  });

  it("rollback skips a table the app role owns, so it never strips an owner's privileges", () => {
    for (const [table, privileges] of Object.entries(granted)) {
      expect(rollback).toContain(
        [
          "    IF NOT EXISTS (",
          "      SELECT 1 FROM pg_class",
          `      WHERE oid = '${table}'::regclass`,
          "        AND relowner = (SELECT oid FROM pg_roles WHERE rolname = 'vertex_research')",
          "    ) THEN",
          `      REVOKE ${privileges} ON TABLE "${table}" FROM "vertex_research";`,
          "    END IF;",
        ].join("\n")
      );
    }
  });
});

// Since 0037 every new table needs a guarded app-role grant (0039 covered the tables before it), or
// operator-applied migrations leave the web app without access. List a table here only when it is
// source-only on purpose, with the reason.
const FIRST_GUARDED_MIGRATION = 37;
const ungrantedOnPurpose: readonly string[] = [];

describe("app-role grants for new tables", () => {
  it("every table created since 0037 has a vertex_research grant", () => {
    const created: string[] = [];
    const tablesGranted = new Set<string>();
    for (const name of readdirSync(migrations).filter((file) =>
      file.endsWith(".sql")
    )) {
      // Comments do not grant anything, and a grant only counts inside the role-existence guard.
      const sql = readFileSync(new URL(name, migrations), "utf8").replace(
        /--.*$/gmu,
        ""
      );
      if (Number(name.slice(0, 4)) >= FIRST_GUARDED_MIGRATION) {
        for (const match of sql.matchAll(
          /CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?/giu
        )) {
          if (match[1] !== undefined) created.push(match[1]);
        }
      }
      const guard = sql.indexOf(
        "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN"
      );
      if (guard === -1) continue;
      for (const match of sql
        .slice(guard, sql.indexOf("END IF;", guard))
        .matchAll(
          /GRANT [A-Z, ]+ ON TABLE ((?:"\w+"(?:, )?)+) TO "vertex_research"/gu
        )) {
        for (const table of (match[1] ?? "").matchAll(/"(\w+)"/gu)) {
          if (table[1] !== undefined) tablesGranted.add(table[1]);
        }
      }
    }
    expect(created).toContain("agent_model_runs");
    expect(created).toContain("agent_model_run_events");
    expect(
      created
        .filter(
          (table) =>
            !(tablesGranted.has(table) || ungrantedOnPurpose.includes(table))
        )
        .sort()
    ).toEqual([]);
  });
});
