// Yahoo Finance call-site inventory (card vertex-sources-chase-enloe, 2026-11-09): Vertex reads Yahoo
// through undocumented public endpoints and Python/JS client packages, with no agreement with Yahoo.
// docs/vertex-rebuild/data-sources/reel-de8mrtzrrpy.md lists every source file that does so (and quotes
// the terms); this gate fails when a file gains or loses such a call without that list changing.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);

const INVENTORY_DOC = "docs/vertex-rebuild/data-sources/reel-de8mrtzrrpy.md";
const START = "<!-- yahoo-call-sites:start -->";
const END = "<!-- yahoo-call-sites:end -->";
// A Yahoo Finance endpoint host or the `yahoo-finance2` npm package anywhere in the file (code or
// comment), or a Python `yfinance`/`yahooquery` import (also inside `import pandas, yfinance`). The bare
// word `yfinance` (a provenance label, a `uv --with yfinance` hint) does not count.
// POSIX ERE classes only: CI and the rig may run different `git grep` regex engines.
const CALL = [
  String.raw`finance\.yahoo\.com|fc\.yahoo\.com|yahoo-finance2`,
  "^[[:space:]]*(import|from)[[:space:]]+([[:alnum:]_.]+[[:space:]]*,[[:space:]]*)*(yfinance|yahooquery)([^[:alnum:]_]|$)",
].join("|");
const SOURCE_GLOBS = [
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.cts",
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.py",
  "*.ipynb",
  "*.sh",
];
// Test files read fixtures, not Yahoo. Fetch scripts that live beside tests (golden fixture rebuilders)
// do call Yahoo, so whole `tests/` folders stay in scope. Default pathspecs let `*` cross `/`.
const NOT_SOURCE = [
  ":!*.test.*",
  ":!*.spec.*",
  ":!*/test_*.py",
  ":!*_test.py",
  ":!*/conftest.py",
];

/** Tracked source files that call Yahoo Finance. */
async function callSites(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["grep", "--no-color", "-lE", CALL, "--", ...SOURCE_GLOBS, ...NOT_SOURCE],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 }
    );
    return stdout.split("\n").filter((path) => path !== "");
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if (error instanceof Error && "code" in error && error.code === 1)
      return [];
    throw error;
  }
}

/** The backticked file paths in the first column of the inventory table. */
function inventory(doc: string): string[] {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  expect(start, `${INVENTORY_DOC} lacks ${START}`).toBeGreaterThanOrEqual(0);
  expect(end, `${INVENTORY_DOC} lacks ${END}`).toBeGreaterThan(start);
  return doc
    .slice(start + START.length, end)
    .split("\n")
    .flatMap((line) => {
      const match = /^\|\s*`([^`]+)`\s*\|/u.exec(line);
      return match?.[1] === undefined ? [] : [match[1]];
    });
}

describe("Yahoo Finance call sites", () => {
  it("match the inventory in the source review", async () => {
    const doc = await readFile(
      new URL(`../../${INVENTORY_DOC}`, import.meta.url),
      "utf8"
    );
    const listed = inventory(doc);
    expect(new Set(listed).size, "duplicate rows in the inventory").toBe(
      listed.length
    );
    expect([...listed].sort()).toEqual((await callSites()).sort());
  });
});
