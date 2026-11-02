import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  accounts,
  auditRecords,
  outboxEvents,
  users,
} from "../schema/index.ts";
import * as vertex from "../schema/vertex.ts";

// These are source-only authored tests. Loading SQL text is not migration
// execution; the task author has not run this file or any database command.
const forward = (): string =>
  readFileSync(
    new URL(
      "../../migration-sources/0008_vertex_buildout/forward/0008_vertex_substrate.sql",
      import.meta.url
    ),
    "utf8"
  );
const reverse = (): string =>
  readFileSync(
    new URL(
      "../../migration-sources/0008_vertex_buildout/rollback/0008_vertex_substrate.down.sql",
      import.meta.url
    ),
    "utf8"
  );

describe("additive Vertex substrate schema", () => {
  it("never conflates Vertex accounts with authentication identities", () => {
    expect(vertex.vertexAccounts).not.toBe(accounts);
    expect(getTableConfig(vertex.vertexAccounts).name).toBe("vertex_accounts");
    expect(getTableConfig(accounts).name).toBe("account");
    for (const preserved of [accounts, users, auditRecords, outboxEvents]) {
      const name = getTableConfig(preserved).name;
      expect(forward()).not.toMatch(
        new RegExp(`(?:ALTER|DROP|TRUNCATE)\\s+TABLE\\s+"?${name}"?\\b`, "i")
      );
    }
  });
  it("hand-authored forward and guarded reverse enumerate the same new tables", () => {
    const created = [...forward().matchAll(/CREATE TABLE (vertex_[a-z_]+)/g)]
      .map((match) => match[1]!)
      .sort();
    const dropped = [...reverse().matchAll(/DROP TABLE (vertex_[a-z_]+)/g)]
      .map((match) => match[1]!)
      .sort();
    const schemaTables = Object.values(vertex)
      .map((table) => getTableConfig(table).name)
      .sort();
    expect(created).toEqual(schemaTables);
    expect(dropped).toEqual(created);
    expect(new Set(created).size).toBe(created.length);
    for (const name of created) expect(reverse()).toContain(`'${name}'`);
  });
  it("refuses populated rollback before any DROP and protects against races", () => {
    const source = reverse();
    expect(source).toContain("IN ACCESS EXCLUSIVE MODE");
    expect(source).toContain("SELECT EXISTS (SELECT 1 FROM %I LIMIT 1)");
    expect(source).toContain("IF has_rows THEN");
    expect(source.indexOf("RAISE EXCEPTION")).toBeLessThan(
      source.indexOf("DROP TABLE")
    );
    expect(source).not.toMatch(/\bCASCADE\b|\bTRUNCATE\b|DELETE FROM/i);
    return expect(source.trimEnd()).toMatch(/COMMIT;$/);
  });
  it("retains exact nanosecond/sequence storage and native observation-only values", () => {
    const heads = getTableConfig(vertex.vertexProjectionHeads);
    expect(
      heads.columns
        .find((column) => column.name === "high_water_sequence")!
        .getSQLType()
    ).toMatch(/numeric\(30,\s*0\)/);
    expect(
      heads.columns
        .find((column) => column.name === "expires_at_ns")!
        .getSQLType()
    ).toMatch(/numeric\(30,\s*0\)/);
    const positions = getTableConfig(vertex.vertexPortfolioPositions);
    expect(
      positions.columns
        .find((column) => column.name === "quantity")!
        .getSQLType()
    ).toBe("text");
    expect(forward()).toContain(
      "vertex_reservation_observation_only CHECK(authoritative = false)"
    );
    expect(forward()).toContain(
      "vertex_sleeve_observation_only CHECK(authoritative = false)"
    );
    return expect(forward()).not.toMatch(
      /CREATE (?:EXTENSION|DATABASE)|pgvector|agno/i
    );
  });
  return it("normalizes all shards, run revisions, evidence lineage and outbox fencing", () => {
    for (const name of [
      "vertex_collection_shards",
      "vertex_source_identities",
      "vertex_duplicate_mappings",
      "vertex_unavailable_sources",
      "vertex_claim_evidence",
      "vertex_dataset_sources",
      "vertex_strategy_versions",
      "vertex_backtest_versions",
      "vertex_agent_versions",
      "vertex_module_versions",
      "vertex_record_instruments",
      "vertex_record_relationships",
      "vertex_outbox",
    ]) {
      expect(forward()).toContain(`CREATE TABLE ${name}`);
    }
    expect(forward()).toContain(
      "vertex_generation_shard_count CHECK(shard_count BETWEEN 1 AND 64)"
    );
    return expect(forward()).toContain(
      "lease_fence numeric(30,0) NOT NULL DEFAULT 0"
    );
  });
});
