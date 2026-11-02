import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as native from "../schema/vertex-native-facts.ts";

// Source-only regressions, not evidence of successful migration execution.
const forward = (): string =>
  readFileSync(
    new URL(
      "../../migration-sources/0008_vertex_buildout/forward/0013_vertex_native_facts.sql",
      import.meta.url
    ),
    "utf8"
  );
const reverse = (): string =>
  readFileSync(
    new URL(
      "../../migration-sources/0008_vertex_buildout/rollback/0013_vertex_native_facts.down.sql",
      import.meta.url
    ),
    "utf8"
  );
describe("additive native fact evidence schema", () => {
  it("enumerates exactly the normalized schema tables in forward and guarded reverse", () => {
    const created = [...forward().matchAll(/CREATE TABLE (vertex_[a-z_]+)/g)]
      .map((match) => match[1]!)
      .sort();
    const dropped = [...reverse().matchAll(/DROP TABLE (vertex_[a-z_]+)/g)]
      .map((match) => match[1]!)
      .sort();
    expect(created).toEqual(
      Object.values(native)
        .map((table) => getTableConfig(table).name)
        .sort()
    );
    expect(dropped).toEqual(created);
    expect(created).toHaveLength(9);
    for (const name of created) expect(reverse()).toContain(`'${name}'`);
  });
  it("preserves existing order/genesis stream tables and adds no cash or permission mutation", () => {
    expect(forward()).not.toMatch(
      /\b(?:ALTER|DROP|TRUNCATE|UPDATE|DELETE|INSERT|CREATE TRIGGER)\b/i
    );
    expect(forward()).not.toMatch(
      /CREATE TABLE vertex_(?:projection_heads|execution_projections|reservations|accounts)\b/i
    );
    expect(forward()).toContain(
      "REFERENCES vertex_projection_heads(account_alias,environment,stream_id)"
    );
    return expect(forward()).toContain(
      "REFERENCES vertex_native_journal_proofs(account_alias,environment,artifact_id,sha256,source_event_id)"
    );
  });
  it("bounds immutable canonical proof bytes, sequence and native ordinal", () => {
    expect(forward()).toContain(
      "byte_length BETWEEN 1 AND 1048576 AND octet_length(canonical_json) = byte_length"
    );
    expect(forward()).toContain("CHECK(sequence >= 2 AND owner_epoch > 0)");
    expect(forward()).toContain("previous_event_hash text NOT NULL");
    expect(forward()).toContain("CHECK(fact_ordinal BETWEEN 0 AND 63)");
    expect(forward()).toContain(
      "CREATE UNIQUE INDEX vertex_native_fact_journal_identity ON vertex_native_fact_projections(account_alias,environment,owner_epoch,proof_journal_sequence,proof_journal_head_hash,fact_ordinal)"
    );
    const table = getTableConfig(native.vertexNativeFactProjections);
    expect(
      table.columns
        .find((column) => column.name === "proof_journal_sequence")!
        .getSQLType()
    ).toMatch(/numeric\(30,\s*0\)/);
    return expect(
      table.columns
        .find((column) => column.name === "fact_ordinal")!
        .getSQLType()
    ).toBe("integer");
  });
  it("retains pending future obligations and prohibits nonzero option-expiry deltas", () => {
    expect(forward()).toContain(
      "settlement_state <> 'settled' OR due_at_ns IS NULL OR due_at_ns <= occurred_at_ns"
    );
    expect(forward()).toContain(
      "fact_kind <> 'option-expiry' OR (cash_delta = '0' AND share_delta = '0')"
    );
    expect(forward()).toContain("settlement_state IN ('pending','settled')");
    return expect(forward()).not.toMatch(
      /intent_id|buying_power|available_cash|reserved_cash/i
    );
  });
  return it("locks every new table and refuses any populated rollback before the first drop", () => {
    expect(reverse()).toContain("IN ACCESS EXCLUSIVE MODE");
    expect(reverse()).toContain("SELECT EXISTS (SELECT 1 FROM %I LIMIT 1)");
    expect(reverse()).toContain("IF has_rows THEN");
    expect(reverse().indexOf("RAISE EXCEPTION")).toBeLessThan(
      reverse().indexOf("DROP TABLE")
    );
    expect(reverse()).not.toMatch(/\bCASCADE\b|\bTRUNCATE\b|DELETE FROM/i);
    return expect(reverse().trimEnd()).toMatch(/COMMIT;$/);
  });
});
