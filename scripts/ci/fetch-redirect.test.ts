import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// workerd (the vertex-web runtime on QuantVPS) rejects `fetch(url, { redirect: "error" })`
// with a TypeError before it sends the request: 'Invalid redirect value, must be one of
// "follow" or "manual"'. Unit tests run under Node, which accepts "error", so the bug
// passed CI. On 2026-11-27 it made every Nasdaq open-interest read fail on QuantVPS
// (card vertex-chain-oi-quantdata-zero-deploy); arxiv.ts and deploy-status.ts had met it
// before. Use redirect "manual" and refuse a 3xx in the status check.
const root = fileURLToPath(new URL("../..", import.meta.url));
const REDIRECT_ERROR = /\bredirect\s*[:=]\s*["'`]error["'`]/u;
const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.tsx?$/u;

const redirectErrorLines = (text: string): number[] =>
  text
    .split("\n")
    .flatMap((line, index) => (REDIRECT_ERROR.test(line) ? [index + 1] : []));

describe("fetch redirect mode", () => {
  it("matches the forms that workerd rejects and nothing else", () => {
    expect(
      redirectErrorLines(
        [
          'redirect: "error",',
          "redirect: 'error',",
          "init.redirect = `error`;",
          'redirect: "manual",',
          'redirect: "follow",',
          'const mode = "error";',
        ].join("\n")
      )
    ).toEqual([1, 2, 3]);
  });

  it('no app or package source passes redirect "error" to fetch', () => {
    const files = execFileSync(
      "git",
      [
        "ls-files",
        "-z",
        "--",
        "packages/*.ts",
        "packages/*.tsx",
        "apps/*.ts",
        "apps/*.tsx",
      ],
      { cwd: root, encoding: "utf8" }
    )
      .split("\0")
      .filter((file) => file !== "" && !TEST_FILE.test(file));
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((file) =>
      redirectErrorLines(readFileSync(join(root, file), "utf8")).map(
        (line) => `${file}:${line}`
      )
    );
    expect(hits).toEqual([]);
  });
});
