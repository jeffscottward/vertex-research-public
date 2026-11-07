import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { scaledTimeout } from "../lib/test-timeout-scale.ts";
import {
  checkJsonFiles,
  checkRuntimeReaders,
  classifyJsonFile,
  isJsonFile,
  isRuntimeSource,
  jsonDataReferences,
  matchesEntry,
} from "./json-data.ts";
import {
  KEPT_JSON_DATA,
  PENDING_JSON_DATA,
  RUNTIME_JSON_READERS,
} from "./json-data-allowlist.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);

async function trackedFiles(): Promise<string[]> {
  // `-s` shows the mode: skip submodules (160000) and symlinks (120000); they hold no JSON data.
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "-s"], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout
    .split("\0")
    .filter((entry) => entry.startsWith("100"))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
}

const report = (violations: ReadonlyArray<{ path: string; problem: string }>) =>
  violations.map(({ path, problem }) => `${path}: ${problem}`);

describe("JSON data file classes", () => {
  it("allows build config, fixtures, generated artifacts and vendored code", () => {
    expect(classifyJsonFile("package.json")).toBe("config");
    expect(classifyJsonFile("packages/api/tsconfig.build.json")).toBe("config");
    expect(classifyJsonFile("apps/web/wrangler.jsonc")).toBe("config");
    expect(classifyJsonFile(".vscode/settings.json")).toBe("config");
    expect(classifyJsonFile("biome.jsonc")).toBe("config");
    expect(classifyJsonFile(".markdownlint-cli2.jsonc")).toBe("config");
    expect(classifyJsonFile("services/x/tests/fixtures/a.json")).toBe(
      "fixture"
    );
    expect(classifyJsonFile("packages/api/src/server/chain.fixture.json")).toBe(
      "fixture"
    );
    expect(classifyJsonFile("packages/db/migrations/meta/_journal.json")).toBe(
      "generated"
    );
    expect(classifyJsonFile("packages/x/generated/out.json")).toBe("generated");
    expect(classifyJsonFile("packages/api/openapi.json")).toBe("generated");
    expect(classifyJsonFile("services/h/vendor/lib/.cargo_vcs_info.json")).toBe(
      "vendor"
    );
  });

  it("treats every other JSON file as data", () => {
    expect(
      classifyJsonFile("packages/academy/src/lessons/sources.json")
    ).toBeNull();
    expect(classifyJsonFile("research/baskets/owner-baskets.json")).toBeNull();
    expect(isJsonFile("a/b.jsonl")).toBe(true);
    expect(isJsonFile("a/b.ndjson")).toBe(true);
    expect(isJsonFile("a/b.json5x")).toBe(false);
  });
});

describe("runtime sources", () => {
  it("covers app, package, service and infra code, not tests or tooling", () => {
    expect(isRuntimeSource("packages/api/src/server/engines.ts")).toBe(true);
    expect(isRuntimeSource("infra/quant-vps/status/collect.py")).toBe(true);
    expect(isRuntimeSource("services/contracts/rust/src/lib.rs")).toBe(true);
    expect(isRuntimeSource("packages/api/src/server/engines.test.ts")).toBe(
      false
    );
    expect(isRuntimeSource("packages/api/src/server/x.test-support.ts")).toBe(
      false
    );
    expect(isRuntimeSource("infra/quant-vps/status/test_collect.py")).toBe(
      false
    );
    expect(isRuntimeSource("services/research/tests/helpers.py")).toBe(false);
    expect(isRuntimeSource("packages/api/scripts/openapi.ts")).toBe(false);
    expect(isRuntimeSource("scripts/ci/json-data.ts")).toBe(false);
    expect(isRuntimeSource("packages/api/README.md")).toBe(false);
  });

  it("finds JSON data names but not URLs or config names", () => {
    const source = [
      'import spec from "./specs/a.json" with { type: "json" };',
      "const file = `${dir}/status.jsonl`;",
      "open('/opt/x/health.json')",
      'fetch("https://www.sec.gov/files/company_tickers.json")',
      'readFile("package.json")',
      'headers: { accept: "application/json" }',
    ].join("\n");
    expect(jsonDataReferences(source)).toEqual([
      "./specs/a.json",
      "${dir}/status.jsonl",
      "/opt/x/health.json",
    ]);
  });
});

describe("allowlist checks", () => {
  it("matches directory entries by prefix and file entries exactly", () => {
    expect(matchesEntry("a/b/c.json", "a/b/")).toBe(true);
    expect(matchesEntry("a/bc.json", "a/b/")).toBe(false);
    expect(matchesEntry("a/b.json", "a/b.json")).toBe(true);
  });

  it("fails new, double-listed and stale data files", () => {
    const tracked = [
      "package.json",
      "data/a.json",
      "data/b.json",
      "data/c.json",
      "x.ts",
    ];
    expect(
      checkJsonFiles(tracked, ["data/a.json", "data/b.json", "gone.json"], {
        "data/b.json": "evidence",
      })
    ).toEqual([
      { path: "data/b.json", problem: "listed as both pending and kept" },
      {
        path: "data/c.json",
        problem:
          "new JSON data file: store the data in Postgres and serve it through oRPC (AGENTS.md rule 13)",
      },
      {
        path: "gone.json",
        problem: "allowlist entry matches no tracked JSON data file: remove it",
      },
    ]);
    expect(checkJsonFiles(tracked, ["data/"], {})).toEqual([]);
  });

  it("ratchets runtime reader counts in both directions", () => {
    const counts = new Map([
      ["a.ts", 2],
      ["b.ts", 1],
      ["c.ts", 1],
    ]);
    expect(
      report(checkRuntimeReaders(counts, { "a.ts": 2, "b.ts": 3, "d.ts": 1 }))
    ).toEqual([
      "c.ts: 1 JSON data references, baseline 0: read the data from Postgres through a repository (AGENTS.md rule 13)",
      "b.ts: 1 JSON data references, baseline 3: lower the baseline in scripts/ci/json-data-allowlist.ts",
      "d.ts: 0 JSON data references, baseline 1: lower the baseline in scripts/ci/json-data-allowlist.ts",
    ]);
  });
});

describe("repository", () => {
  it(
    "has no JSON data file outside the allowlist",
    async () => {
      const tracked = await trackedFiles();
      expect(
        report(checkJsonFiles(tracked, PENDING_JSON_DATA, KEPT_JSON_DATA))
      ).toEqual([]);
    },
    scaledTimeout(30_000)
  );

  it(
    "has no new runtime JSON data access",
    async () => {
      const counts = new Map<string, number>();
      for (const path of (await trackedFiles()).filter(isRuntimeSource)) {
        const references = jsonDataReferences(
          await readFile(`${root}${path}`, "utf8")
        );
        if (references.length > 0) counts.set(path, references.length);
      }
      expect(report(checkRuntimeReaders(counts, RUNTIME_JSON_READERS))).toEqual(
        []
      );
    },
    scaledTimeout(30_000)
  );
});
