import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The desk is paper only: its source may import only local modules, zod and the file-system,
// path and crypto built-ins. Any network, process, broker or dynamic import fails this test.
const ALLOWED_IMPORTS: Readonly<Record<string, true>> = {
  "node:crypto": true,
  "node:fs": true,
  "node:fs/promises": true,
  "node:path": true,
  "node:url": true,
  zod: true,
};

const directory = import.meta.dirname;
const repository = join(directory, "..", "..");
const sources = [
  ...readdirSync(directory)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test"))
    .map((name) => join(directory, name)),
  join(directory, "..", "agent-desk.ts"),
].map((path) => ({ name: relative(repository, path), path }));
// `from "x"`, `from 'x'` and bare side-effect imports such as `import "x";`.
const SPECIFIER = /(?:\bfrom\s+|^\s*import\s+)["']([^"']+)["']/gmu;

describe("agent desk boundaries", () => {
  it.each(sources)(
    "$name imports no network, process or broker code",
    ({ name, path }) => {
      const source = readFileSync(path, "utf8");
      const specifiers = [...source.matchAll(SPECIFIER)].map(
        (match) => match[1] as string
      );
      for (const specifier of specifiers) {
        const allowed =
          specifier.startsWith("./") ||
          specifier === "../lib/required.ts" ||
          ALLOWED_IMPORTS[specifier] === true;
        expect(allowed, `${name}: ${specifier}`).toBe(true);
      }
      expect(source).not.toMatch(
        /\bimport\s*\(|\brequire\s*\(|\bfetch\s*\(|WebSocket|child_process|ibapi/u
      );
    }
  );

  it("covers every desk module, the pitch agent included", () => {
    expect(sources.map((source) => source.name)).toEqual(
      expect.arrayContaining([
        "scripts/agent-desk/desk.ts",
        "scripts/agent-desk/pitch.ts",
        "scripts/agent-desk/research.ts",
        "scripts/agent-desk/technical.ts",
      ])
    );
  });

  it("detects side-effect and single-quoted imports", () => {
    const sample = "import \"node:net\";\nimport { x } from 'undici';\n";
    expect([...sample.matchAll(SPECIFIER)].map((match) => match[1])).toEqual([
      "node:net",
      "undici",
    ]);
  });
});
