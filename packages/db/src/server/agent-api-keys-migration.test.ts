import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { apiKeys } from "../schema/index.ts";

describe("0016 agent API keys migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0016_agent_api_keys.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0016_agent_api_keys.down.sql", import.meta.url),
    "utf8"
  );

  it("is idempotent and creates exactly the drizzle apikey columns and indexes", () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "apikey"');
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(
      /^\s*(GRANT|TRUNCATE|UPDATE|DELETE|INSERT)\s/im
    );
    const config = getTableConfig(apiKeys);
    expect(config.name).toBe("apikey");
    const sqlColumns = [...migration.matchAll(/^\s{2}"([a-z_]+)" /gm)].map(
      (match) => match[1]
    );
    expect(sqlColumns).toEqual(config.columns.map((column) => column.name));
    for (const index of config.indexes) {
      expect(migration).toContain(
        `CREATE INDEX IF NOT EXISTS "${index.config.name}" ON "apikey"`
      );
    }
  });

  it("stores timestamps with time zone and never a plaintext column", () => {
    for (const column of [
      "last_refill_at",
      "last_request",
      "expires_at",
      "created_at",
      "updated_at",
    ]) {
      expect(migration).toContain(`"${column}" timestamp with time zone`);
    }
    return expect(migration).not.toMatch(
      /"(plaintext|raw_key|secret)[a-z_]*"/i
    );
  });

  return it("rollback refuses while keys exist and never cascades", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain('DROP TABLE "public"."apikey"');
    return expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});
