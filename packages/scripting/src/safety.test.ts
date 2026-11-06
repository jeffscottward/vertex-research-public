/// <reference types="node" />

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

// Patterns (not plain strings) so this file does not match itself; whitespace-tolerant.
const FORBIDDEN: readonly RegExp[] = [
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bimport\s*\(/,
];

describe("interpreter safety", () => {
  it("never uses eval, Function or dynamic import anywhere in the package source", () => {
    const files = readdirSync(SRC).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(SRC, file), "utf8");
      for (const needle of FORBIDDEN)
        if (needle.test(text)) hits.push(`${file}: ${needle.source}`);
    }
    expect(hits).toEqual([]);
  });
});
