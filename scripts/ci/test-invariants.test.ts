import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, matchesGlob, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript-api";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import vitestConfig, { coverageThresholds } from "../../vitest.config.ts";
import coverageBaseline from "./coverage-baseline.json" with { type: "json" };

type Manifest = Readonly<{ scripts?: Readonly<Record<string, string>> }>;
type VitestRun = Readonly<{ cwd: string; arguments_: readonly string[] }>;
type ListedFile = Readonly<{ file: string; projectName: string }>;

const root = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
// Each `vitest list` loads the config through Vite, whose native bundler
// (Rolldown) starts about 25 threads even under a CPU quota. All ~20 lists at
// once exhaust the Docker verifier's process limit, which counts threads, and
// its memory. availableParallelism() follows the quota (2 in the verifier).
const LIST_CONCURRENCY = Math.min(4, availableParallelism());
const vitestBin = join(root, "node_modules/vitest/vitest.mjs");
const listDirectory = await mkdtemp(
  join(tmpdir(), "darkfactory-test-invariants-")
);
let listCount = 0;

afterAll(() => rm(listDirectory, { force: true, recursive: true }));

// Files below 100% when Vertex moved to TypeScript (2026-10-11). Lower only.
const COVERAGE_RATCHET_LIMIT = 305;

// Every coverage exclusion is reviewed here. Editing vitest.config.ts alone fails this test.
const COVERAGE_EXCLUDE_ALLOWLIST = [
  // Tests are the measuring instrument, not measured source.
  "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
  // Ambient declarations contain no executable code.
  "**/*.d.ts",
  // Generator output; freshness checks own these bytes.
  "**/generated/**",
  "apps/web/src/features/generated-navigation.ts",
  // Root entry wrappers only hand process I/O to a measured CLI; the
  // "thin root entries" test below fails the moment one gains logic.
  "scripts/*.ts",
] as const;

// Wrappers must not branch, loop, catch or declare block-bodied functions.
const LOGIC = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Block,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.QuestionDotToken,
]);

// Imports, then exactly `process.exitCode = [await] runCli(...)`.
const isThinEntry = (source: string): boolean => {
  const file = ts.createSourceFile("entry.ts", source, ts.ScriptTarget.Latest);
  const statements = [...file.statements];
  const last = statements.pop();
  if (
    last === undefined ||
    !statements.every(ts.isImportDeclaration) ||
    !ts.isExpressionStatement(last) ||
    !ts.isBinaryExpression(last.expression) ||
    last.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    last.expression.left.getText(file) !== "process.exitCode"
  ) {
    return false;
  }
  const { right } = last.expression;
  let logic = false;
  const visit = (node: ts.Node): void => {
    logic ||= LOGIC.has(node.kind);
    ts.forEachChild(node, visit);
  };
  visit(right);
  return (
    !logic &&
    ts.isCallExpression(ts.isAwaitExpression(right) ? right.expression : right)
  );
};

const SOURCE_ROOT = /^(?:apps\/[^/]+\/src\/|packages\/[^/]+\/src\/|scripts\/)/u;
const SOURCE_EXTENSION = /\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/u;
const TEST_FILE = /\.(?:test|spec)\.[^./]+$/u;
const LOCAL_PROJECTS = [
  "unit",
  "contract",
  "operations",
  "e2e-helpers",
] as const;

const git = async (...arguments_: string[]): Promise<string[]> => {
  return (
    await execFileAsync("git", arguments_, {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout
    .split("\0")
    .filter(Boolean);
};

const trackedFiles = git("ls-files", "-z").then((files) => new Set(files));

const readManifest = async (directory: string): Promise<Manifest> => {
  return JSON.parse(
    await readFile(join(directory, "package.json"), "utf8")
  ) as Manifest;
};

const matchesAny = (file: string, patterns: readonly string[]): boolean => {
  return patterns.some((pattern) => matchesGlob(file, pattern));
};

const workspaceDirectories = async (): Promise<string[]> => {
  return (
    await git(
      "ls-files",
      "-z",
      "--",
      "apps/*/package.json",
      "packages/*/package.json"
    )
  ).map((file) => join(root, file.replace(/\/package\.json$/u, "")));
};

// Expands `bun run` chains into the Vitest invocations a composite script really executes.
const expandVitestRuns = async (
  script: string,
  cwd = root
): Promise<VitestRun[]> => {
  const command = (await readManifest(cwd)).scripts?.[script];
  if (command === undefined) {
    throw new Error(
      `missing script ${script} in ${relative(root, cwd) || "root"}`
    );
  }
  const runs: VitestRun[] = [];
  for (const step of command.split(" && ")) {
    const words = step
      .trim()
      .replace(/^bun scripts\/with-test-env\.ts /u, "")
      .split(/\s+/u)
      .map((token) => token.replace(/^"(.*)"$/u, "$1"));
    // A root entry that wraps a command (`bun scripts/x.ts pnpm exec …`) runs it.
    const tokens =
      words[0] === "bun" && /^scripts\/[^/]+\.ts$/u.test(words[1] ?? "")
        ? words.slice(2)
        : words;
    if (tokens.length === 3 && tokens[0] === "bun" && tokens[1] === "run") {
      runs.push(...(await expandVitestRuns(tokens[2]!, cwd)));
    } else if (tokens.slice(0, 3).join(" ") === "pnpm exec vitest") {
      runs.push({ arguments_: tokens.slice(3), cwd });
    } else if (tokens.slice(0, 4).join(" ") === "bunx --no-install turbo run") {
      const task = tokens[4]!;
      const passThrough = tokens.includes("--")
        ? tokens.slice(tokens.indexOf("--") + 1)
        : [];
      // Turbo forwards flags only; a forwarded path filter would silently narrow every package.
      expect(passThrough.every((token) => token.startsWith("--"))).toBe(true);
      for (const directory of await workspaceDirectories()) {
        if ((await readManifest(directory)).scripts?.[task] !== undefined) {
          runs.push(...(await expandVitestRuns(task, directory)));
        }
      }
    } else if (step.includes("vitest") || step.includes("turbo")) {
      throw new Error(`unrecognized test runner step: ${step}`);
    }
  }
  return runs;
};

const listFiles = async (run: VitestRun): Promise<string[]> => {
  const [subcommand, ...rest] = run.arguments_;
  expect(subcommand).toBe("run");
  listCount += 1;
  const output = join(listDirectory, `list-${listCount}.json`);
  const arguments_ = rest.filter((argument) => argument !== "--coverage");
  await execFileAsync(
    process.execPath,
    [vitestBin, "list", ...arguments_, "--filesOnly", `--json=${output}`],
    {
      cwd: run.cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    }
  );
  const listed = JSON.parse(await readFile(output, "utf8")) as ListedFile[];
  const tracked = await trackedFiles;
  // Untracked or ignored local files never count; only committed tests reach CI.
  return listed
    .map(({ file }) => relative(root, file))
    .filter((file) => tracked.has(file));
};

const allTestFiles = async (): Promise<ListedFile[]> => {
  const output = join(listDirectory, "all.json");
  await execFileAsync(
    process.execPath,
    [
      vitestBin,
      "list",
      "--config",
      "vitest.config.ts",
      "--filesOnly",
      `--json=${output}`,
    ],
    {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    }
  );
  const tracked = await trackedFiles;
  return (JSON.parse(await readFile(output, "utf8")) as ListedFile[])
    .map(({ file, projectName }) => ({
      file: relative(root, file),
      projectName,
    }))
    .filter(({ file }) => tracked.has(file));
};

const executionCounts = async (
  script: string
): Promise<Map<string, number>> => {
  const runs = await expandVitestRuns(script);
  const listed: string[][] = [];
  let next = 0;
  let failed = false;
  // After a failure no new list starts, and the running ones finish before the
  // error surfaces, so afterAll never removes the directory under them.
  const listRemaining = async (): Promise<void> => {
    while (!failed && next < runs.length) {
      const index = next;
      next += 1;
      try {
        listed[index] = await listFiles(runs[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const lanes = await Promise.allSettled(
    Array.from({ length: Math.min(LIST_CONCURRENCY, runs.length) }, () =>
      listRemaining()
    )
  );
  for (const lane of lanes) {
    if (lane.status === "rejected") throw lane.reason;
  }
  const counts = new Map<string, number>();
  for (const files of listed) {
    for (const file of files) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return counts;
};

// Expands `bun run` chains down to the commands a root script really executes.
const leafSteps = async (script: string): Promise<string[]> => {
  const command = (await readManifest(root)).scripts?.[script];
  expect(command, script).toBeDefined();
  const leaves: string[] = [];
  for (const step of (command ?? "").split(" && ")) {
    const nested = /^bun run (\S+)$/u.exec(step.trim());
    leaves.push(...(nested ? await leafSteps(nested[1]!) : [step.trim()]));
  }
  return leaves;
};

type CiLaneJob = Readonly<{
  strategy: Readonly<{ matrix: Readonly<{ lane: readonly string[] }> }>;
  steps: readonly Readonly<{ if?: string; name?: string; run?: string }>[];
}>;

type CiWorkflow = Readonly<{
  jobs: Readonly<{
    verification: CiLaneJob;
    "verification-coverage": CiLaneJob;
  }>;
}>;

const ciVerification = readFile(
  join(root, ".github/workflows/ci.yml"),
  "utf8"
).then((text) => {
  // The coverage lane is its own job (it waits for the shards); the others
  // share one matrix. Together they are the four required lanes, in verify order.
  const { verification, "verification-coverage": coverage } = (
    parse(text) as CiWorkflow
  ).jobs;
  const lanes = [
    ...verification.strategy.matrix.lane,
    ...coverage.strategy.matrix.lane,
  ];
  const order = ["core", "coverage", "integration", "browser"];
  return {
    steps: [...verification.steps, ...coverage.steps],
    strategy: {
      matrix: {
        lane: order
          .filter((lane) => lanes.includes(lane))
          .concat(lanes.filter((lane) => !order.includes(lane))),
      },
    },
  };
});

describe("coverage measures every authored source file", () => {
  it("pins coverage exclusions to the reviewed allowlist", () => {
    expect(vitestConfig.test?.coverage?.exclude).toEqual([
      ...COVERAGE_EXCLUDE_ALLOWLIST,
    ]);
    expect(vitestConfig.test?.coverage?.include).toEqual([
      "apps/*/src/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
      "packages/*/src/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
      "scripts/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    ]);
    // Coverage shards switch thresholds off; the merged lane uses these.
    expect(vitestConfig.test?.coverage?.thresholds).toEqual(
      process.env["VITEST_COVERAGE_THRESHOLDS"] === "off"
        ? {}
        : coverageThresholds
    );
    const thresholds: Record<string, unknown> = coverageThresholds;
    const [everyOther, ...legacy] = Object.entries(thresholds);
    // Each listed file keeps exactly its recorded minimums, keyed by the file
    // path with glob characters escaped.
    expect(
      Object.fromEntries(
        legacy.map(([glob, minimums]) => [glob.replaceAll("\\", ""), minimums])
      )
    ).toEqual(coverageBaseline.files);
    // Every other file (the negated list) stays at exactly 100%.
    expect(everyOther).toEqual([
      `!(${legacy.map(([glob]) => glob).join("|")})`,
      { branches: 100, functions: 100, lines: 100, statements: 100 },
    ]);
    return expect(legacy).toHaveLength(
      Object.keys(coverageBaseline.files).length
    );
  });

  // The ratchet list only shrinks: no new file, and no file already at 100%.
  it("keeps the coverage ratchet list to legacy files below 100%", async () => {
    const tracked = await trackedFiles;
    const entries = Object.entries(coverageBaseline.files);
    expect(entries.length).toBeLessThanOrEqual(COVERAGE_RATCHET_LIMIT);
    for (const [file, minimums] of entries) {
      // `bun run init` deletes its own scripts and the operator plane; the
      // entry of a deleted file matches nothing.
      if (!tracked.has(file)) continue;
      expect(Object.keys(minimums).sort(), file).toEqual([
        "branches",
        "functions",
        "lines",
        "statements",
      ]);
      const values = Object.values(minimums);
      expect(
        values.every((value) => value >= 0 && value <= 100),
        file
      ).toBe(true);
      expect(Math.min(...values), `${file} is at 100%; remove it`).toBeLessThan(
        100
      );
    }
  });

  it("tracks no retired Civet sources that coverage would silently skip", async () => {
    return expect(
      [...(await trackedFiles)].filter((file) => /\.civet$/iu.test(file))
    ).toEqual([]);
  });

  it("keeps every excluded root entry a thin wrapper around a measured CLI", async () => {
    const entries = [...(await trackedFiles)].filter(
      (file) => matchesGlob(file, "scripts/*.ts") && !TEST_FILE.test(file)
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const source = await readFile(join(root, entry), "utf8");
      expect(isThinEntry(source), entry).toBe(true);
    }
    // The checker itself must see logic hidden inside the exit-code call.
    for (const logic of [
      "process.exitCode = await run(a ? 1 : 2);",
      "process.exitCode = run(() => { return 1; });",
      "process.exitCode = run(a ?? b, c && d);",
      "const a = 1;\nprocess.exitCode = run(a);",
      "process.exitCode = 1;",
    ]) {
      expect(isThinEntry(logic), logic).toBe(false);
    }
  });

  return it("includes every tracked non-test source file outside the allowlist", async () => {
    const include = vitestConfig.test?.coverage?.include ?? [];
    const exclude = vitestConfig.test?.coverage?.exclude ?? [];
    const tracked = [...(await trackedFiles)];
    const sources = tracked.filter(
      (file) => SOURCE_ROOT.test(file) && SOURCE_EXTENSION.test(file)
    );
    const unmeasured = sources.filter((file) => {
      return (
        !TEST_FILE.test(file) &&
        (!matchesAny(file, include) || matchesAny(file, exclude))
      );
    });
    const allowlisted = unmeasured.filter((file) =>
      matchesAny(file, COVERAGE_EXCLUDE_ALLOWLIST.slice(1))
    );
    expect(unmeasured).toEqual(allowlisted);
    for (const pattern of COVERAGE_EXCLUDE_ALLOWLIST) {
      expect(
        tracked.some((file) => matchesGlob(file, pattern)),
        `stale exclusion ${pattern}`
      ).toBe(true);
    }
  });
});

describe("every Vitest test file runs in the gates", {
  timeout: 120_000,
}, () => {
  it("assigns each test file to exactly one Vitest project", async () => {
    const files = await allTestFiles();
    const owners = new Map<string, string[]>();
    for (const { file, projectName } of files) {
      owners.set(file, [...(owners.get(file) ?? []), projectName]);
    }
    expect([...owners].filter(([, projects]) => projects.length > 1)).toEqual(
      []
    );
    // A tracked test outside every project would silently never run; only Playwright specs may.
    const orphans = [...(await trackedFiles)].filter(
      (file) => TEST_FILE.test(file) && !owners.has(file)
    );
    return expect(
      orphans.filter((file) => !matchesGlob(file, "tests/e2e/*.spec.ts"))
    ).toEqual([]);
  });

  it("runs every test file exactly once in the full verify lifecycle", async () => {
    // One after the other: a failing list then leaves nothing running.
    const files = await allTestFiles();
    const counts = await executionCounts("verify");
    const expected = new Map(files.map(({ file }) => [file, 1]));
    return expect(Object.fromEntries(counts)).toEqual(
      Object.fromEntries(expected)
    );
  });

  return it("runs every unit, contract, operations, and e2e-helpers file in verify:prepush", async () => {
    // One after the other: a failing list then leaves nothing running.
    const files = await allTestFiles();
    const counts = await executionCounts("verify:prepush");
    const local = files.filter(({ projectName }) =>
      LOCAL_PROJECTS.some((name) => name === projectName)
    );
    expect(local.length).toBeGreaterThan(0);
    return expect(
      local.filter(({ file }) => !counts.has(file)).map(({ file }) => file)
    ).toEqual([]);
  });
});

describe("verify mirrors the CI lanes and builds once", () => {
  it("chains exactly the CI lanes, each through its verify:<lane> script", async () => {
    const { strategy, steps } = await ciVerification;
    expect(steps.map(({ run }) => run)).toContain(
      'bun run "verify:${{ matrix.lane }}"'
    );
    return expect((await readManifest(root)).scripts?.["verify"]).toBe(
      strategy.matrix.lane.map((lane) => `bun run verify:${lane}`).join(" && ")
    );
  });

  // verify:browser needs the production build, so a build break fails that required lane.
  it("runs the turbo build exactly once, in the browser lane", async () => {
    const { strategy } = await ciVerification;
    const builds = await Promise.all(
      strategy.matrix.lane.map(async (lane) => {
        const leaves = await leafSteps(`verify:${lane}`);
        return [
          lane,
          leaves.filter((leaf) => /\bturbo run build\b/u.test(leaf)).length,
        ];
      })
    );
    return expect(Object.fromEntries(builds)).toEqual({
      browser: 1,
      core: 0,
      coverage: 0,
      integration: 0,
    });
  });

  // Pull requests may run a subset of the browser specs; every other event runs all.
  it("chooses browser specs only for pull requests and passes them to Playwright", async () => {
    const { steps } = await ciVerification;
    const choose = steps.filter(({ name }) => name === "Choose browser specs");
    expect(choose).toHaveLength(1);
    expect(choose[0]?.if).toBe(
      "matrix.lane == 'browser' && github.event_name == 'pull_request'"
    );
    expect(choose[0]?.run).toContain(
      'specs="$(bun scripts/browser-specs.ts HEAD^1 HEAD)" || specs=""'
    );
    expect(choose[0]?.run).toContain('echo "BROWSER_SPECS=${specs}"');
    const script = await readFile(
      join(root, "scripts/ci/browser-lane.sh"),
      "utf8"
    );
    return expect(script).toContain(
      'read -r -a specs <<<"${BROWSER_SPECS:-}"\n  bun run verify:browser "${specs[@]}"'
    );
  });

  // Host network changes made Chromium fail requests with ERR_NETWORK_CHANGED.
  return it("runs verify:browser in a private network namespace in CI", async () => {
    const { steps } = await ciVerification;
    expect(
      steps
        .filter(
          ({ run }) =>
            run?.includes("verify:") === true ||
            run?.includes("browser-lane.sh") === true
        )
        .map(({ if: condition, run }) => [condition, run])
    ).toEqual([
      ["matrix.lane != 'browser'", 'bun run "verify:${{ matrix.lane }}"'],
      ["matrix.lane == 'browser'", "bash scripts/ci/browser-lane.sh"],
      // The coverage lane is its own job and runs its verify script directly.
      [undefined, 'bun run "verify:${{ matrix.lane }}"'],
    ]);
    const script = await readFile(
      join(root, "scripts/ci/browser-lane.sh"),
      "utf8"
    );
    expect(script).toContain(
      "namespace=(unshare --user --map-current-user --net --keep-caps)"
    );
    expect(script).toContain("ip link set lo up");
    return expect(script).toContain("bun run verify:browser");
  });
});
