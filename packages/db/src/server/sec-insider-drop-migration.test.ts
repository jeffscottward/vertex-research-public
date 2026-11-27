import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Migration 0102 drops the retired openbb_sec_insider_trades table without CASCADE;
// its rollback recreates the exact table definition and guarded grant from 0064.
const TAG = "0102_drop_openbb_sec_insider_trades";
const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");
const migration = read(`../../migrations/${TAG}.sql`);
const rollback = read(`../../rollback/${TAG}.down.sql`);
const source0064 = read("../../migrations/0064_openbb_sources.sql");
const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
  entries: { idx: number; tag: string; when: number }[];
};

const extractTableBlock = (sqlText: string, headerPattern: RegExp): string => {
  const match = headerPattern.exec(sqlText);
  if (!match) throw new Error(`Missing table block for ${headerPattern}`);
  const start = match.index + match[0].length;
  const end = sqlText.indexOf("\n);", start);
  if (end === -1) throw new Error("Unterminated CREATE TABLE block");
  return sqlText.slice(start, end);
};

describe(TAG, () => {
  it("drops openbb_sec_insider_trades in one statement without CASCADE and is registered in the journal", () => {
    expect(migration.trim()).toBe('DROP TABLE "openbb_sec_insider_trades";');
    expect(migration.toUpperCase()).not.toContain("CASCADE");
    const entry = journal.entries.find((item) => item.tag === TAG);
    expect(entry?.idx).toBe(102);
  });

  it("recreates the exact columns, constraints, and guarded vertex_research grant from 0064", () => {
    const originalBody = extractTableBlock(
      source0064,
      /CREATE TABLE "openbb_sec_insider_trades" \(/u
    );
    const rollbackBody = extractTableBlock(
      rollback,
      /CREATE TABLE "public"\."openbb_sec_insider_trades" \(/u
    );
    expect(rollbackBody).toBe(originalBody);
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("SET LOCAL search_path = pg_catalog, public;");
    expect(rollback).toContain("SET LOCAL row_security = off;");
    expect(rollback).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN"
    );
    expect(rollback).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."openbb_sec_insider_trades" TO "vertex_research";'
    );
    expect(rollback).toContain("COMMIT;");
  });
});
