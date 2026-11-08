import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
// Only the template repository keeps its lists exact; see GateOptions.
const options = { stale: existsSync(`${root}scripts/init/plan.ts`) };

type Tracked = Readonly<{ path: string; link: boolean; executable: boolean }>;

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
      executable: entry.startsWith("100755 "),
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
      "infra/tsconfig.json",
      "scripts/tsconfig.json",
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
    expect(
      classifyJsonFile("packages/api/src/data/universe.schema.json")
    ).toBeNull();
    expect(
      classifyJsonFile("packages/api/src/data/tsconfig.universe.json")
    ).toBeNull();
    expect(
      classifyJsonFile("apps/web/src/data/wrangler.prices.json")
    ).toBeNull();
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
      "infra/quant-vps/status/vertex-status-collect.service.tailnet",
      "infra/quant-vps/systemd/vertex-host.service.in",
      "scripts/vertex-quant-lab-record.ts",
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
      "infra/quantvps/engine-status/vertex-engine-status-write",
    ])
      expect([path, isRuntimeSource(path)]).toEqual([path, false]);
  });

  it("covers executable files whatever their name", () => {
    expect(
      isRuntimeSource(
        "infra/quantvps/engine-status/vertex-engine-status-write",
        true
      )
    ).toBe(true);
    expect(isRuntimeSource("scripts/ci/ci-changes.sh", true)).toBe(false);
  });

  it("finds JSON data names, quoted or not, and fixture imports", () => {
    const source = [
      'import spec from "./specs/a.json" with { type: "json" };',
      "const file = `${dir}/status.jsonl`;",
      "open('/opt/x/health.json')",
      "scp deep-value.json host:/srv/lenses/rotation-matrix.json",
      'const own = "https://h.example/vertex-research-lenses/v1/deep-value.json";',
      'import { demo } from "../fixtures/demo.ts";',
      'import { core } from "../fixtures";',
      'const again = "./specs/a.json";',
    ].join("\n");
    expect(jsonDataReferences(source, "packages/a/src/a.ts")).toEqual([
      "${dir}/status.jsonl",
      "../fixtures",
      "../fixtures/demo.ts",
      "./specs/a.json",
      "/opt/x/health.json",
      "deep-value.json",
      "host:/srv/lenses/rotation-matrix.json",
      "https://h.example/vertex-research-lenses/v1/deep-value.json",
    ]);
  });

  it("finds file names in shell, unit files and Python format strings", () => {
    expect(
      jsonDataReferences(
        "cp latest.json /srv/lenses/\njq -r .x state.json",
        "infra/x/push.sh"
      )
    ).toEqual(["latest.json", "state.json"]);
    expect(
      jsonDataReferences(
        "ExecStart=/usr/bin/cat state.json",
        "infra/x/a.service"
      )
    ).toEqual(["state.json"]);
    expect(
      jsonDataReferences(
        'path = os.path.join(STATE, "pg-%s.json" % name)\n# writes /opt/x/health.json',
        "infra/x/collect.py"
      )
    ).toEqual(["pg-%s.json"]);
    expect(
      jsonDataReferences("x = pydantic.Json\ny = sa.JSON", "services/a/m.py")
    ).toEqual([]);
  });

  it("ignores config names, third-party URLs, calls, property access, bare extensions and comments", () => {
    const source = [
      'fetch("https://www.sec.gov/files/company_tickers.json")',
      'fetch("https://data.sec.gov/api/xbrl/companyfacts/CIK1.json")',
      'readFile("package.json"); readFile("./tsconfig.build.json")',
      'headers: { accept: "application/json" }',
      "const body = await response.json();",
      "const typed = await c.req.json<Body>();",
      "const k = await ky.get(u).json<T>();",
      "const r = res?.json;",
      "let v = resp.await?.json::<Value>()?;",
      "window.JSON.stringify(x); globalThis.JSON.parse(y);",
      "const value = reply.json;",
      'if (file.endsWith(".json")) types[".json"] = "application/json";',
      "// reads status.json from the file server",
      "/* writes /opt/x/health.json */",
      " * see deep-value.json",
      'const marked = "health.json"; // json-data-ignore: label text, not a file read',
    ].join("\n");
    expect(jsonDataReferences(source, "packages/a/src/a.ts")).toEqual([]);
    expect(
      jsonDataReferences('const f = "status.json";', "packages/a/src/a.ts")
    ).toEqual(["status.json"]);
    expect(
      jsonDataReferences("# json-data-ignore:\ncat state.json", "infra/a.sh")
    ).toEqual(["state.json"]);
  });

  it("stays linear on a long minified line", () => {
    const line = `const uri = "data:application/octet-stream;base64,${"QUJD".repeat(250_000)}";`;
    const started = performance.now();
    expect(jsonDataReferences(line, "packages/a/src/a.ts")).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
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
    expect(
      checkJsonFiles(
        tracked,
        ["data/a.json", "data/c.json", "gone.json"],
        { "data/b.json": "x" },
        { stale: false }
      )
    ).toEqual([]);
  });

  it("ratchets runtime reader names in both directions", () => {
    const found = new Map([
      ["packages/a/src/a.ts", ["x.json", "y.json"]],
      ["packages/a/src/b.ts", ["x.json"]],
    ]);
    expect(
      report(
        checkRuntimeReaders(
          found,
          {
            "packages/a/src/a.ts": ["x.json", "z.json"],
            "packages/a/src/d.ts": ["d.json"],
            "packages/a/scripts/moved.ts": ["m.json"],
          },
          new Set([
            "packages/a/src/a.ts",
            "packages/a/src/b.ts",
            "packages/a/src/d.ts",
          ])
        )
      )
    ).toEqual([
      "packages/a/src/a.ts: new JSON data reference y.json: read the data from Postgres through a repository (AGENTS.md rule 13)",
      "packages/a/src/b.ts: new JSON data reference x.json: read the data from Postgres through a repository (AGENTS.md rule 13)",
      "packages/a/src/a.ts: JSON data reference z.json is gone: remove it from scripts/ci/json-data-allowlist.ts",
      "packages/a/src/d.ts: JSON data reference d.json is gone: remove it from scripts/ci/json-data-allowlist.ts",
      "packages/a/scripts/moved.ts: baseline entry is not a tracked runtime file: remove it if the file is gone; moving a reader out of runtime scope does not remove it",
    ]);
    expect(
      report(
        checkRuntimeReaders(
          found,
          {
            "packages/a/src/a.ts": ["x.json", "y.json", "z.json"],
            "packages/a/src/gone.ts": ["g.json"],
          },
          new Set(["packages/a/src/a.ts"]),
          { stale: false }
        )
      )
    ).toEqual([
      "packages/a/src/b.ts: new JSON data reference x.json: read the data from Postgres through a repository (AGENTS.md rule 13)",
    ]);
  });
});

describe("repository", () => {
  it(
    "has no JSON data file outside the allowlist",
    async () => {
      const tracked = (await trackedFiles()).map(({ path }) => path);
      expect(
        report(
          checkJsonFiles(tracked, PENDING_JSON_DATA, KEPT_JSON_DATA, options)
        )
      ).toEqual([]);
    },
    scaledTimeout(30_000)
  );

  it(
    "has no new runtime JSON data access",
    async () => {
      const found = new Map<string, string[]>();
      const runtime = new Set<string>();
      for (const { path, link, executable } of await trackedFiles()) {
        if (link || !isRuntimeSource(path, executable)) continue;
        runtime.add(path);
        const names = jsonDataReferences(
          await readFile(`${root}${path}`, "utf8"),
          path
        );
        if (names.length > 0) found.set(path, names);
      }
      expect(
        report(
          checkRuntimeReaders(found, RUNTIME_JSON_READERS, runtime, options)
        )
      ).toEqual([]);
    },
    scaledTimeout(30_000)
  );
});
