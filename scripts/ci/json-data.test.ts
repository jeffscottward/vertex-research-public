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
} from "./json-data.ts";
import {
  KEPT_JSON_DATA,
  PENDING_JSON_DATA,
  RUNTIME_JSON_READERS,
} from "./json-data-allowlist.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);

type Tracked = Readonly<{ path: string; link: boolean }>;

async function trackedFiles(): Promise<Tracked[]> {
  // `-s` shows the mode: skip submodules (160000). Symlinks (120000) count by name only.
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "-s"], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout
    .split("\0")
    .filter((entry) => entry !== "" && !entry.startsWith("160000 "))
    .map((entry) => ({
      link: entry.startsWith("120000 "),
      path: entry.slice(entry.indexOf("\t") + 1),
    }));
}

const report = (violations: ReadonlyArray<{ path: string; problem: string }>) =>
  violations.map(({ path, problem }) => `${path}: ${problem}`);

describe("JSON data file classes", () => {
  it("allows build config where the tool reads it", () => {
    for (const path of [
      "package.json",
      "packages/api/tsconfig.build.test.json",
      "apps/web/wrangler.jsonc",
      "apps/web/components.json",
      "apps/x/deno.jsonc",
      "docs/vertex-rebuild/deliverables.schema.json",
      ".vscode/settings.json",
      "apps/web/.vscode/launch.json",
      ".devcontainer/devcontainer.json",
      ".github/codeql.json",
      "biome.jsonc",
      "turbo.json",
      ".markdownlint-cli2.jsonc",
      ".mcp.json",
    ])
      expect([path, classifyJsonFile(path)]).toEqual([path, "config"]);
  });

  it("ties config names to their place", () => {
    expect(classifyJsonFile("apps/web/src/data/components.json")).toBeNull();
    expect(classifyJsonFile("packages/api/src/turbo.json")).toBeNull();
    expect(classifyJsonFile(".github/data/prices.json")).toBeNull();
  });

  it("allows fixtures, known generated artifacts and vendored code", () => {
    expect(classifyJsonFile("services/x/tests/fixtures/a.json")).toBe(
      "fixture"
    );
    expect(classifyJsonFile("packages/api/src/server/chain.fixture.json")).toBe(
      "fixture"
    );
    expect(classifyJsonFile("packages/db/migrations/meta/_journal.json")).toBe(
      "generated"
    );
    expect(
      classifyJsonFile(
        "packages/db/migration-sources/0008_vertex_buildout/generated/_journal.json"
      )
    ).toBe("generated");
    expect(classifyJsonFile("packages/api/openapi.json")).toBe("generated");
    expect(
      classifyJsonFile("packages/api/src/server/generated/u.json")
    ).toBeNull();
    expect(classifyJsonFile("services/h/vendor/lib/.cargo_vcs_info.json")).toBe(
      "vendor"
    );
  });

  it("treats every other JSON file as data, in every JSON format", () => {
    expect(classifyJsonFile("research/baskets/owner-baskets.json")).toBeNull();
    for (const path of [
      "a.jsonl",
      "a.ndjson",
      "a.json5",
      "a.geojson",
      "a.json.gz",
      "A.JSON",
      "a.jsonc",
    ])
      expect([path, isJsonFile(path)]).toEqual([path, true]);
    expect(isJsonFile("a/b.json5x")).toBe(false);
  });
});

describe("runtime sources", () => {
  it("covers app, package, service and infra code and unit files", () => {
    for (const path of [
      "packages/api/src/server/engines.ts",
      "infra/quant-vps/status/collect.py",
      "infra/quant-vps/exec-node/runtime/scripts/healthcheck.sh",
      "infra/quant-vps/status/Caddyfile.tailnet",
      "infra/quant-vps/research-lenses/vertex-research-lenses-push.path",
      "infra/quant-vps/exec-node/runtime/docker-compose.yml",
      "packages/jobs/verifier/Dockerfile",
      "services/contracts/rust/src/lib.rs",
      "scripts/vertex-signal-alerts-tick.ts",
    ])
      expect([path, isRuntimeSource(path)]).toEqual([path, true]);
  });

  it("skips tests, fixtures, build tooling and docs", () => {
    for (const path of [
      "packages/api/src/server/engines.test.ts",
      "packages/api/src/server/x.test-support.ts",
      "infra/quant-vps/status/test_collect.py",
      "services/research/tests/helpers.py",
      "apps/web/src/lab/fixtures/strategies.ts",
      "packages/api/scripts/openapi.ts",
      "scripts/ci/json-data.ts",
      "packages/api/README.md",
    ])
      expect([path, isRuntimeSource(path)]).toEqual([path, false]);
  });

  it("finds JSON data names, quoted or not, and fixture imports", () => {
    const source = [
      'import spec from "./specs/a.json" with { type: "json" };',
      "const file = `${dir}/status.jsonl`;",
      "open('/opt/x/health.json')",
      "scp deep-value.json host:/srv/lenses/rotation-matrix.json",
      'const own = "https://h.example/vertex-research-lenses/v1/deep-value.json";',
      'import { demo } from "../fixtures/demo.ts";',
      'const again = "./specs/a.json";',
    ].join("\n");
    expect(jsonDataReferences(source)).toEqual([
      "${dir}/status.jsonl",
      "../fixtures/demo.ts",
      "./specs/a.json",
      "/opt/x/health.json",
      "deep-value.json",
      "host:/srv/lenses/rotation-matrix.json",
      "https://h.example/vertex-research-lenses/v1/deep-value.json",
    ]);
  });

  it("ignores config names, third-party URLs, method calls, property access and comments", () => {
    const source = [
      'fetch("https://www.sec.gov/files/company_tickers.json")',
      'fetch("https://data.sec.gov/api/xbrl/companyfacts/CIK1.json")',
      'readFile("package.json"); readFile("./tsconfig.build.json")',
      'headers: { accept: "application/json" }',
      "const body = await response.json();",
      "const value = reply.json;",
      "// reads status.json from the file server",
      "# writes /opt/x/health.json",
      " * see deep-value.json",
    ].join("\n");
    expect(jsonDataReferences(source)).toEqual([]);
    expect(jsonDataReferences('const f = "status.json";')).toEqual([
      "status.json",
    ]);
  });
});

describe("allowlist checks", () => {
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
    expect(
      checkJsonFiles(tracked, ["data/a.json", "data/c.json"], {
        "data/b.json": "x",
      })
    ).toEqual([]);
  });

  it("ratchets runtime reader names in both directions", () => {
    const found = new Map([
      ["packages/a/src/a.ts", ["x.json", "y.json"]],
      ["packages/a/src/b.ts", ["x.json"]],
    ]);
    expect(
      report(
        checkRuntimeReaders(found, {
          "packages/a/src/a.ts": ["x.json", "z.json"],
          "packages/a/src/d.ts": ["d.json"],
          "packages/a/scripts/moved.ts": ["m.json"],
        })
      )
    ).toEqual([
      "packages/a/src/a.ts: new JSON data reference y.json: read the data from Postgres through a repository (AGENTS.md rule 13)",
      "packages/a/src/b.ts: new JSON data reference x.json: read the data from Postgres through a repository (AGENTS.md rule 13)",
      "packages/a/src/a.ts: JSON data reference z.json is gone: remove it from scripts/ci/json-data-allowlist.ts",
      "packages/a/src/d.ts: JSON data reference d.json is gone: remove it from scripts/ci/json-data-allowlist.ts",
      "packages/a/scripts/moved.ts: baseline entry is not a runtime file: moving a reader out of runtime scope does not remove it",
    ]);
  });
});

describe("repository", () => {
  it(
    "has no JSON data file outside the allowlist",
    async () => {
      const tracked = (await trackedFiles()).map(({ path }) => path);
      expect(
        report(checkJsonFiles(tracked, PENDING_JSON_DATA, KEPT_JSON_DATA))
      ).toEqual([]);
    },
    scaledTimeout(30_000)
  );

  it(
    "has no new runtime JSON data access",
    async () => {
      const found = new Map<string, string[]>();
      for (const { path, link } of await trackedFiles()) {
        if (link || !isRuntimeSource(path)) continue;
        const names = jsonDataReferences(
          await readFile(`${root}${path}`, "utf8")
        );
        if (names.length > 0) found.set(path, names);
      }
      expect(report(checkRuntimeReaders(found, RUNTIME_JSON_READERS))).toEqual(
        []
      );
    },
    scaledTimeout(30_000)
  );
});
