import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Card vertex-debate-approval-sql-load (owner decision 2026-11-16). An owned
// transaction is one predecessor walk: a completed predecessor read is kept
// until the transaction ends (packages/db/src/server/
// vertex-research-chat-predecessor-walk.ts). A write in the same transaction can
// change a kept value, so every raw SQL write in a vertex-*.ts file of
// packages/db/src/server or packages/api/src/server must call
// forgetPredecessorWalkReads just before its statement. This test names each raw
// write (also one that starts with a `with` clause or whose SQL text starts on the
// next line) without that call, and each Drizzle builder write, which would
// bypass the rule.

const folders = [
  "../../packages/db/src/server/",
  "../../packages/api/src/server/",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const rawWrite =
  /\bsql\s*`\s*(?:with\b[^`]*?)?\b(update|delete|insert|merge|truncate)\b/gi;
const builderWrite =
  /\b(tx|dbtx|db|executor|transaction)\.(update|insert|delete)\(/;
const forget = /^\s*forgetPredecessorWalkReads\((\w+)\);\s*$/;
// The transaction that runs the statement: `<name>.execute(` or `rows(` with
// `<name>,` on its next line.
const receiver = /\b(\w+)\.execute\(|\brows\(\s*\n\s*(\w+),|\brows\((\w+),/g;
// The statement opens at most 3 lines above the SQL text, for example
// `const changed = await rows(` / `tx,` / sql`update ...`.
const window = 4;

const unguardedWrites = (name: string, source: string): readonly string[] => {
  const lines = source.split("\n"),
    found: string[] = [];
  lines.forEach((line, index) => {
    if (builderWrite.test(line) && !line.trimStart().startsWith("//"))
      found.push(`${name}:${index + 1} Drizzle builder write`);
  });
  for (const match of source.matchAll(rawWrite)) {
    const index = source.slice(0, match.index).split("\n").length - 1;
    const above = lines.slice(Math.max(0, index - window), index);
    const dropped = above.flatMap((line) => {
      const call = forget.exec(line);
      return call?.[1] ? [call[1]] : [];
    });
    const runners = [
      ...lines
        .slice(Math.max(0, index - window), index + 1)
        .join("\n")
        .matchAll(receiver),
    ].map((run) => run[1] ?? run[2] ?? run[3] ?? "");
    if (dropped.length === 0)
      found.push(
        `${name}:${index + 1} raw write without forgetPredecessorWalkReads`
      );
    else if (!runners.some((runner) => dropped.includes(runner)))
      found.push(
        `${name}:${index + 1} forgetPredecessorWalkReads names another transaction`
      );
  }
  return found.sort();
};

describe("predecessor walk writes", () => {
  it("every raw write in a vertex store drops the kept predecessor reads", () => {
    const files = folders.flatMap((folder) =>
      readdirSync(folder)
        .filter(
          (name) =>
            name.startsWith("vertex-") &&
            name.endsWith(".ts") &&
            !name.endsWith(".test.ts") &&
            !name.includes("test-support")
        )
        .map((name) => join(folder, name))
    );
    expect(files.length).toBeGreaterThan(20);
    const found = files.flatMap((path) =>
      unguardedWrites(path, readFileSync(path, "utf8"))
    );
    expect(found).toEqual([]);
  });

  it("names a raw write without the call and a builder write", () => {
    expect(
      unguardedWrites(
        "a.ts",
        [
          "  forgetPredecessorWalkReads(tx);",
          "  const changed = await rows(",
          "    tx,",
          "    sql`update t set a = 1`",
          "  );",
          "  await tx.execute(",
          "    sql`delete from t`",
          "  );",
          "  await tx.update(table).set({ a: 1 });",
          "  await tx.execute(",
          "    sql`",
          "      with old as (select 1) update t set a = 2`",
          "  );",
          "  await tx.execute(sql`select 1 from t where kind = 'insert'`);",
          "  forgetPredecessorWalkReads(tx);",
          "  await tx.execute(sql`with x as (select 1) insert into t values (1)`);",
          "  const a = 1;",
          "  const b = 2;",
          "  const c = 3;",
          "  forgetPredecessorWalkReads(other);",
          "  await tx.execute(sql `truncate t`);",
          "  await transaction.insert(table).values({ a: 1 });",
        ].join("\n")
      )
    ).toEqual([
      "a.ts:11 raw write without forgetPredecessorWalkReads",
      "a.ts:21 forgetPredecessorWalkReads names another transaction",
      "a.ts:22 Drizzle builder write",
      "a.ts:7 raw write without forgetPredecessorWalkReads",
      "a.ts:9 Drizzle builder write",
    ]);
  });
});
