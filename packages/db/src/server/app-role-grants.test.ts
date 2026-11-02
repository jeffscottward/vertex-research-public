import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const migration = read("../../migrations/0039_app_role_grants.sql");
const rollback = read("../../rollback/0039_app_role_grants.down.sql");

const granted: Record<string, string> = {
  assistant_actions: "SELECT, INSERT, UPDATE",
  strategy_definition_revisions: "SELECT, INSERT",
  todos: "SELECT, INSERT, UPDATE, DELETE",
  vertex_research_chat_messages: "SELECT, INSERT",
  vertex_research_chat_threads: "SELECT, INSERT, UPDATE",
};

const ungranted = [
  "vertex_research_chat_copy_allocations",
  "vertex_research_chat_copy_cleanup_intents",
  "vertex_research_chat_copy_closures",
  "vertex_research_chat_copy_content_bindings",
  "vertex_research_chat_copy_dependencies",
  "vertex_research_chat_copy_families",
  "vertex_worker_experiment_publications",
];

const statements = (sql: string, verb: "GRANT" | "REVOKE"): string[] =>
  sql
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${verb} `));

describe("0039_app_role_grants", () => {
  it("grants the app role exactly the privileges its repositories use", () => {
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

  it("keeps the source-only tables without grants", () => {
    for (const table of ungranted) {
      expect(migration).not.toContain(`"${table}"`);
    }
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
  });
});
