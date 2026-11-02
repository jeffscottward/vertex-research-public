import { readFile } from "node:fs/promises";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  notificationAdmissions,
  notificationCooldowns,
} from "./notification.ts";
import { vertexObjectMetadata } from "./object-metadata.ts";

// Source-only assertions authored now; migration execution/restore and actual
// engine/extension/account proof remain separate, unexecuted acceptance gates.
describe("additive notification and object metadata schema", () => {
  it("qualifies admission deduplication fully but shares cooldown across purposes", () => {
    const admissions = getTableConfig(notificationAdmissions);
    const cooldowns = getTableConfig(notificationCooldowns);
    expect(
      admissions.primaryKeys[0]?.columns.map((column) => column.name)
    ).toEqual([
      "tenant_key",
      "recipient_key",
      "channel",
      "purpose",
      "idempotency_key",
    ]);
    expect(
      cooldowns.primaryKeys[0]?.columns.map((column) => column.name)
    ).toEqual(["tenant_key", "recipient_key", "channel"]);
    expect(admissions.primaryKeys[0]?.getName()).toBe(
      "notification_admissions_pkey"
    );
    expect(cooldowns.primaryKeys[0]?.getName()).toBe(
      "notification_cooldowns_pkey"
    );
    return expect(
      admissions.checks.map((constraint) => constraint.name)
    ).toContain("notification_admissions_outcome_check");
  });

  it("stores no notification payload destination configuration credential or error fields", () => {
    const names = getTableConfig(notificationAdmissions).columns.map(
      (column) => column.name
    );
    expect(names).toEqual([
      "tenant_key",
      "recipient_key",
      "channel",
      "purpose",
      "idempotency_key",
      "fingerprint",
      "attempt_id",
      "acceptance",
      "admitted_at_ms",
      "expires_at_ms",
      "outcome_at_ms",
    ]);
    for (const forbidden of [
      "body",
      "title",
      "email",
      "topic",
      "token",
      "destination",
      "configuration_ref",
      "last_error",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("uses exact scope for immutable object metadata without body storage", () => {
    const config = getTableConfig(vertexObjectMetadata);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual(
      ["account_alias", "environment", "collection_key", "object_key"]
    );
    expect(config.primaryKeys[0]?.getName()).toBe(
      "vertex_object_metadata_pkey"
    );
    expect(config.columns.map((column) => column.name)).not.toContain("body");
    return expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "vertex_object_metadata_scope_check",
        "vertex_object_metadata_digest_check",
        "vertex_object_metadata_size_check",
      ])
    );
  });

  // The hand-authored 0009/0010 drafts were folded into the canonical
  // 0008_vertex_buildout migration and its guarded rollback (2bf4c34).
  return it.each([
    "notification_admissions",
    "notification_cooldowns",
    "vertex_object_metadata",
  ])(
    "authors additive %s in 0008 with a guarded empty-only reversal",
    async (table) => {
      const forward = await readFile(
        new URL("../../migrations/0008_vertex_buildout.sql", import.meta.url),
        "utf8"
      );
      const rollback = await readFile(
        new URL(
          "../../rollback/0008_vertex_buildout.down.sql",
          import.meta.url
        ),
        "utf8"
      );
      const statements = forward
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement.includes(`"${table}"`));
      expect(statements).toContainEqual(
        expect.stringMatching(new RegExp(`^CREATE TABLE "${table}" \\(`, "u"))
      );
      for (const statement of statements) {
        expect(statement).toMatch(
          /^(?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX|ALTER TABLE "[a-z_]+" ADD CONSTRAINT)\b/u
        );
        expect(statement).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM)\b/u);
      }
      // Comments may name forbidden operations; only executable SQL is checked.
      const executable = rollback
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      const lock = executable.indexOf("LOCK TABLE");
      const exclusive = executable.indexOf("IN ACCESS EXCLUSIVE MODE");
      const guard = executable.indexOf(`'${table}'`);
      const raise = executable.indexOf("RAISE EXCEPTION");
      const drop = executable.indexOf("DROP TABLE");
      expect(executable.slice(lock, exclusive)).toContain(
        `"public"."${table}"`
      );
      expect(executable).toContain(
        "SELECT EXISTS (SELECT 1 FROM %I.%I LIMIT 1)"
      );
      expect(guard).toBeGreaterThan(exclusive);
      expect(guard).toBeLessThan(raise);
      expect(raise).toBeLessThan(drop);
      expect(executable.slice(drop)).toContain(`"public"."${table}"`);
      expect(executable).not.toMatch(/\bCASCADE\b/u);
      expect(executable).toContain("BEGIN;");
      return expect(executable).toContain("COMMIT;");
    }
  );
});
