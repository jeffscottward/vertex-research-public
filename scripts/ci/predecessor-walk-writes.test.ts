import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Card vertex-debate-approval-sql-load (owner decision 2026-11-16). An owned
// transaction is one predecessor walk: a completed predecessor read is kept
// until the transaction ends (packages/db/src/server/
// vertex-research-chat-predecessor-walk.ts). A write in the same transaction can
// change a kept value, so every raw SQL write in packages/db/src/server/vertex-*.ts
// must call forgetPredecessorWalkReads just before its statement. This test
// names each raw write without that call and each Drizzle builder write, which
// would bypass the rule.

const folder = fileURLToPath(
  new URL("../../packages/db/src/server/", import.meta.url)
);
const rawWrite = /sql`\s*(update|delete|insert)\b/i;
const builderWrite = /\b(tx|dbtx|db|executor)\.(update|insert|delete)\(/;
const forget = /^\s*forgetPredecessorWalkReads\(\w+\);\s*$/;
// The statement opens at most 3 lines above the SQL text, for example
// `const changed = await rows(` / `tx,` / sql`update ...`.
const window = 4;

const unguardedWrites = (name: string, source: string): readonly string[] => {
  const lines = source.split("\n"),
    found: string[] = [];
  lines.forEach((line, index) => {
    if (builderWrite.test(line) && !line.trimStart().startsWith("//"))
      found.push(`${name}:${index + 1} Drizzle builder write`);
    if (!rawWrite.test(line)) return;
    const above = lines.slice(Math.max(0, index - window), index);
    if (!above.some((previous) => forget.test(previous)))
      found.push(
        `${name}:${index + 1} raw write without forgetPredecessorWalkReads`
      );
  });
  return found;
};

describe("predecessor walk writes", () => {
  it("every raw write in a vertex store drops the kept predecessor reads", () => {
    const files = readdirSync(folder).filter(
      (name) =>
        name.startsWith("vertex-") &&
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        !name.includes("test-support")
    );
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap((name) =>
      unguardedWrites(name, readFileSync(join(folder, name), "utf8"))
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
        ].join("\n")
      )
    ).toEqual([
      "a.ts:7 raw write without forgetPredecessorWalkReads",
      "a.ts:9 Drizzle builder write",
    ]);
  });
});
