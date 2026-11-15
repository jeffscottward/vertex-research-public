import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "@darkfactory/db/server";
import { extendChatWorkerSql } from "./vertex-research-chat-worker-sql.test-support.ts";

// The chat worker SQL fixture is itself test infrastructure. These cases pin
// the PostgreSQL semantics it claims for statements no owner suite reaches.
type Row = Record<string, unknown>;
const fixture = () => {
  const tables = new Map<string, Row[]>();
  const table = (name: string): Row[] => {
    const rows = tables.get(name) ?? [];
    tables.set(name, rows);
    return rows;
  };
  const db = extendChatWorkerSql({
    db: {
      execute: () => Promise.reject(new Error("unexpected delegated SQL")),
    } as unknown as Database,
    table,
    calls: [],
    state: { afterQuery: () => undefined },
  });
  return { db, table };
};
const ids = (result: unknown): unknown[] => {
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray(result.rows)
  )
    return result.rows.map((row: Row) => row["id"]);
  throw new Error("fixture result without rows");
};

describe("chat worker SQL fixture", () => {
  it("evaluates IS [NOT] DISTINCT FROM with PostgreSQL null semantics", async () => {
    const { db, table } = fixture();
    table("vertex_fixture_values").push(
      { id: "null", value: null },
      { id: "x", value: "x" },
      { id: "y", value: "y" }
    );
    await expect(
      db
        .execute(
          sql`select id from vertex_fixture_values where value is not distinct from ${null}`
        )
        .then(ids)
    ).resolves.toEqual(["null"]);
    await expect(
      db
        .execute(
          sql`select id from vertex_fixture_values where value is not distinct from ${"x"}`
        )
        .then(ids)
    ).resolves.toEqual(["x"]);
    await expect(
      db
        .execute(
          sql`select id from vertex_fixture_values where value is distinct from ${"x"}`
        )
        .then(ids)
    ).resolves.toEqual(["null", "y"]);
  });

  it("coalesces a NULL native review predecessor in phase uniqueness", async () => {
    const { db, table } = fixture();
    const phase = {
      account_alias: "fixture-account",
      environment: "research",
      response_request_id: "response-1",
      phase_ordinal: 1,
      phase_sha256: "a".repeat(64),
    };
    table("vertex_research_chat_native_phases").push({ ...phase });
    table("vertex_research_chat_native_phase_requests").push({
      ...phase,
      operation: "model-completion",
      request_id: "request-1",
      request_sha256: "b".repeat(64),
    });
    const insert = (reviewId: string, supersedes: string | null) =>
      db.execute(
        sql`insert into vertex_research_chat_native_model_privacy_reviews (account_alias, environment, response_request_id, phase_ordinal, phase_sha256, operation, request_id, request_sha256, review_id, supersedes_review_id) values (${phase.account_alias}, ${phase.environment}, ${phase.response_request_id}, ${phase.phase_ordinal}, ${phase.phase_sha256}, ${"model-completion"}, ${"request-1"}, ${"b".repeat(64)}, ${reviewId}, ${supersedes})`
      );
    await insert("review-1", null);
    await expect(insert("review-2", null)).rejects.toMatchObject({
      code: "23505",
    });
    await insert("review-3", "review-1");
    expect(
      table("vertex_research_chat_native_model_privacy_reviews").map(
        (row) => row["review_id"]
      )
    ).toEqual(["review-1", "review-3"]);
  });
});
