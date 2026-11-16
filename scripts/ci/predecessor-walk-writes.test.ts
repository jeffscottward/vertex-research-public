import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
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

const repo = fileURLToPath(new URL("../../", import.meta.url));
const folders = [
  "../../packages/db/src/server/",
  "../../packages/api/src/server/",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const rawWrite =
  /\bsql(?:<[^>`]*>)?\s*`\s*(?:with\b[^`]*?)?\b(update|delete|insert|merge|truncate)\b/gi;
const builderWrite =
  /\b(tx|trx|dbtx|db|executor|transaction)\s*\.(update|insert|delete)\(/;
const forget = /^\s*forgetPredecessorWalkReads\((\w+)\);\s*$/;
// The SQL text sits at most 3 lines below the line that runs it, for example
// `const changed = await rows(` / `tx,` / sql`update ...`.
const window = 3;

// The transaction name on a line that runs a statement: `<name>.execute(`,
// `rows(<name>, ...` or `rows(` with `<name>,` on the next line.
const runnerOn = (lines: readonly string[], index: number): string | null => {
  const line = lines[index] ?? "";
  const call = /\b(\w+)\.execute\(/.exec(line) ?? /\brows\((\w+),/.exec(line);
  if (call?.[1]) return call[1];
  if (/\brows\(\s*$/.test(line))
    return /^\s*(\w+),/.exec(lines[index + 1] ?? "")?.[1] ?? null;
  return null;
};

// Each raw write must be run by a statement whose first line comes directly
// after `forgetPredecessorWalkReads(<same name>);`. Lines that only open the
// statement (they end with `(`, as in `const updated = (`) may sit between.
const unguardedWrites = (name: string, source: string): readonly string[] => {
  const lines = source.split("\n"),
    found: string[] = [];
  lines.forEach((line, index) => {
    if (builderWrite.test(line) && !line.trimStart().startsWith("//"))
      found.push(`${name}:${index + 1} Drizzle builder write`);
  });
  for (const match of source.matchAll(rawWrite)) {
    const index = source.slice(0, match.index).split("\n").length - 1;
    let start = index,
      runner = runnerOn(lines, start);
    while (runner === null && start > index - window && start > 0) {
      start -= 1;
      runner = runnerOn(lines, start);
    }
    let before = start - 1;
    while (before >= 0 && /[=]\s*\($/.test((lines[before] ?? "").trimEnd()))
      before -= 1;
    const dropped = forget.exec(lines[before] ?? "")?.[1];
    if (dropped === undefined)
      found.push(
        `${name}:${index + 1} raw write without forgetPredecessorWalkReads`
      );
    else if (dropped !== runner)
      found.push(
        `${name}:${index + 1} forgetPredecessorWalkReads names another transaction`
      );
  }
  return found.sort();
};

describe("predecessor walk writes", () => {
  it("every raw write in a vertex store drops the kept predecessor reads", () => {
    const files = folders.flatMap((folder) =>
      readdirSync(folder, { recursive: true, encoding: "utf8" })
        .filter(
          (name) =>
            basename(name).startsWith("vertex-") &&
            name.endsWith(".ts") &&
            !name.endsWith(".test.ts") &&
            !name.includes("test-support")
        )
        .map((name) => join(folder, name))
    );
    expect(files.length).toBeGreaterThan(20);
    const found = files.flatMap((path) =>
      unguardedWrites(relative(repo, path), readFileSync(path, "utf8"))
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
          "  forgetPredecessorWalkReads(tx);",
          "  await tx.execute(sql`select 1`);",
          "  await tx.execute(sql`update t set a = 3`);",
          "  forgetPredecessorWalkReads(tx);",
          "  const updated = (",
          "    await tx.execute(sql<{ a: number }>`delete from t returning a`)",
          "  ).rows;",
          "  await trx.delete(table);",
        ].join("\n")
      )
    ).toEqual([
      "a.ts:11 raw write without forgetPredecessorWalkReads",
      "a.ts:21 forgetPredecessorWalkReads names another transaction",
      "a.ts:22 Drizzle builder write",
      "a.ts:25 raw write without forgetPredecessorWalkReads",
      "a.ts:30 Drizzle builder write",
      "a.ts:7 raw write without forgetPredecessorWalkReads",
      "a.ts:9 Drizzle builder write",
    ]);
  });
});
