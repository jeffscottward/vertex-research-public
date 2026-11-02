import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REPORTS_DIRECTORY,
  ROOT_TOKEN,
  runCoverageLane,
  shardArguments,
} from "./coverage-lane.ts";
import { spawnInherited } from "./test-env.ts";

const LANE = [
  "pnpm",
  "exec",
  "vitest",
  "run",
  "--config",
  "vitest.config.ts",
  "--project",
  "unit",
  "--project",
  "acceptance",
  "--coverage",
];
const VITEST = LANE.slice(1);

const originalArguments = [...process.argv];
const originalExitCode = process.exitCode;

const directories: string[] = [];
const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "coverage-lane-test-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  process.argv = [...originalArguments];
  process.exitCode = originalExitCode;
  vi.doUnmock("./coverage-lane.ts");
  vi.doUnmock("./test-env.ts");
  vi.resetModules();
  return await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const run = async (
  env: NodeJS.ProcessEnv,
  arguments_: readonly string[] = LANE,
  cwd?: string
) => {
  const spawn = vi.fn(async () => 5);
  const error = vi.fn();
  const root = cwd ?? (await temporaryDirectory());
  const code = await runCoverageLane(arguments_, {
    env,
    spawn,
    error,
    cwd: root,
  });
  return { code, spawn, error, root };
};

describe("shardArguments", () => {
  it("runs one numbered shard of every project except acceptance", () => {
    return expect(shardArguments(VITEST, "2/8", "reports")).toEqual([
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      "--project",
      "unit",
      "--coverage",
      "--shard=2/8",
      "--reporter=default",
      "--reporter=blob",
      "--outputFile.blob=reports/2-of-8.json",
    ]);
  });

  it("runs only the acceptance project for the acceptance shard", () => {
    return expect(shardArguments(VITEST, "acceptance", "reports")).toEqual([
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      "--project",
      "acceptance",
      "--coverage",
      "--reporter=default",
      "--reporter=blob",
      "--outputFile.blob=reports/acceptance.json",
    ]);
  });

  it("keeps a trailing --project without a name unchanged", () => {
    return expect(
      shardArguments(["run", "--project"], "1/1", "r")?.slice(0, 2)
    ).toEqual(["run", "--project"]);
  });

  return it("rejects malformed and out-of-range shard values", () => {
    for (const shard of ["0/2", "3/2", "1", "a/b", "1/100", "unit"]) {
      expect(shardArguments(VITEST, shard, "r"), shard).toBeNull();
    }
  });
});

describe("runCoverageLane", () => {
  it("prints usage without a command", async () => {
    const { code, error, spawn } = await run({}, []);
    expect(code).toBe(2);
    expect(error).toHaveBeenCalledWith(
      "Usage: bun scripts/coverage-lane.ts <command> [arguments...]"
    );
    return expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the command unchanged without shard or merge settings", async () => {
    const env = { KEEP: "1", COVERAGE_SHARD: "", COVERAGE_MERGE_DIR: "" };
    const { code, spawn } = await run(env);
    expect(code).toBe(5);
    return expect(spawn).toHaveBeenCalledWith("pnpm", VITEST, env);
  });

  it("runs a shard into the default or the configured reports directory", async () => {
    const first = await run({ COVERAGE_SHARD: "1/2" });
    expect(first.spawn).toHaveBeenCalledWith(
      "pnpm",
      expect.arrayContaining([
        `--outputFile.blob=${DEFAULT_REPORTS_DIRECTORY}/1-of-2.json`,
      ]),
      { COVERAGE_SHARD: "1/2", VITEST_COVERAGE_THRESHOLDS: "off" }
    );
    const reports = join(first.root, "blobs");
    const second = await run({
      COVERAGE_SHARD: "acceptance",
      COVERAGE_REPORTS_DIR: reports,
    });
    expect(second.code).toBe(5);
    return expect(second.spawn).toHaveBeenCalledWith(
      "pnpm",
      expect.arrayContaining([`--outputFile.blob=${reports}/acceptance.json`]),
      expect.anything()
    );
  });

  it("swaps the shard checkout root for a token in its blob reports", async () => {
    const root = await temporaryDirectory();
    const reports = join(root, DEFAULT_REPORTS_DIRECTORY);
    const blob = join(reports, "1-of-2.json");
    const spawn = vi.fn(async () => {
      await mkdir(reports);
      await writeFile(
        blob,
        JSON.stringify([`${root}/a.ts`, `${root}/b/c.ts`, "/elsewhere/d.ts"])
      );
      return 1;
    });
    const code = await runCoverageLane(LANE, {
      env: { COVERAGE_SHARD: "1/2" },
      spawn,
      error: vi.fn(),
      cwd: root,
    });
    expect(code).toBe(1);
    return expect(JSON.parse(await readFile(blob, "utf8"))).toEqual([
      `${ROOT_TOKEN}/a.ts`,
      `${ROOT_TOKEN}/b/c.ts`,
      "/elsewhere/d.ts",
    ]);
  });

  it("puts the merging checkout root into every blob report before the merge", async () => {
    // `$&` would expand in a string replacement; the root must stay literal.
    const root = await mkdtemp(join(await temporaryDirectory(), "root-$&-"));
    const reports = join(root, "reports");
    const names = ["1-of-2.json", "acceptance.json"];
    await mkdir(reports);
    await writeFile(
      join(reports, names[0]!),
      JSON.stringify([`${ROOT_TOKEN}/a.ts`])
    );
    await writeFile(
      join(reports, names[1]!),
      JSON.stringify([`${ROOT_TOKEN}/b.ts`, "/elsewhere/c.ts"])
    );
    let seen: unknown[] = [];
    const spawn = vi.fn(async () => {
      seen = await Promise.all(
        names.map(async (name) =>
          JSON.parse(await readFile(join(reports, name), "utf8"))
        )
      );
      return 0;
    });
    const code = await runCoverageLane(LANE, {
      env: { COVERAGE_MERGE_DIR: "reports" },
      spawn,
      error: vi.fn(),
      cwd: root,
    });
    expect(code).toBe(0);
    return expect(seen).toEqual([
      [`${root}/a.ts`],
      [`${root}/b.ts`, "/elsewhere/c.ts"],
    ]);
  });

  it("stops before the merge when the reports path is not a directory", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "reports"), "");
    const spawn = vi.fn(async () => 0);
    await expect(
      runCoverageLane(LANE, {
        env: { COVERAGE_MERGE_DIR: "reports" },
        spawn,
        error: vi.fn(),
        cwd: root,
      })
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    return expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects an invalid shard value", async () => {
    const { code, error, spawn } = await run({ COVERAGE_SHARD: "9/8" });
    expect(code).toBe(2);
    expect(error).toHaveBeenCalledWith(
      "COVERAGE_SHARD must be k/n (1 <= k <= n < 100) or acceptance."
    );
    return expect(spawn).not.toHaveBeenCalled();
  });

  it("merges blob reports and keeps the configured thresholds", async () => {
    const env = { COVERAGE_MERGE_DIR: ".vitest-reports" };
    const { code, spawn } = await run(env);
    expect(code).toBe(5);
    expect(spawn).toHaveBeenCalledWith(
      "pnpm",
      [
        "exec",
        "vitest",
        "--merge-reports=.vitest-reports",
        "--config",
        "vitest.config.ts",
        "--coverage",
      ],
      env
    );
    const withoutConfig = await run(env, ["pnpm", "exec", "vitest", "run"]);
    return expect(withoutConfig.spawn).toHaveBeenCalledWith(
      "pnpm",
      ["exec", "vitest", "--merge-reports=.vitest-reports", "--coverage"],
      env
    );
  });

  it("refuses to merge without a vitest run command", async () => {
    const { code, error } = await run({ COVERAGE_MERGE_DIR: "r" }, [
      "pnpm",
      "exec",
      "vitest",
    ]);
    expect(code).toBe(2);
    return expect(error).toHaveBeenCalledWith(
      "COVERAGE_MERGE_DIR needs a `vitest run` command."
    );
  });

  return it("refuses shard and merge settings together", async () => {
    const { code, error } = await run({
      COVERAGE_SHARD: "1/2",
      COVERAGE_MERGE_DIR: "r",
    });
    expect(code).toBe(2);
    return expect(error).toHaveBeenCalledWith(
      "Set COVERAGE_SHARD or COVERAGE_MERGE_DIR, not both."
    );
  });
});

describe("bun scripts/coverage-lane.ts", () => {
  return it("forwards arguments and node dependencies from the root wrapper", async () => {
    const runCoverageLaneMock = vi.fn(
      async (
        _arguments: readonly string[],
        dependencies: Readonly<{ error: (line: string) => void }>
      ) => {
        dependencies.error("probe");
        return 7;
      }
    );
    vi.doMock("./coverage-lane.ts", () => ({
      runCoverageLane: runCoverageLaneMock,
    }));
    vi.doMock("./test-env.ts", () => ({ spawnInherited }));
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    process.argv = ["bun", "coverage-lane.ts", "pnpm", "exec", "vitest"];

    // Importing the entrypoint is the behavior under test (it runs on load).
    await import("../coverage-lane.ts");

    expect(runCoverageLaneMock).toHaveBeenCalledWith(
      ["pnpm", "exec", "vitest"],
      expect.objectContaining({
        cwd: process.cwd(),
        env: process.env,
        spawn: spawnInherited,
      })
    );
    expect(stderr).toHaveBeenCalledWith("probe\n");
    stderr.mockRestore();
    return expect(process.exitCode).toBe(7);
  });
});
