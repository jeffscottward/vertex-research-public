import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TestEnvironmentDependencies } from "./test-env.ts";

// The coverage lane is one Vitest run at 100% thresholds. A 2-vCPU CI runner
// cannot finish it within the job limit, so CI splits it:
//
// - COVERAGE_SHARD=k/n runs shard k of n of every project except acceptance;
//   COVERAGE_SHARD=acceptance runs only the acceptance project. Each writes a
//   blob report to COVERAGE_REPORTS_DIR and checks no threshold
//   (VITEST_COVERAGE_THRESHOLDS=off, read by vitest.config.ts).
// - COVERAGE_MERGE_DIR=<dir> merges those blob reports and enforces the
//   thresholds from vitest.config.ts on the combined coverage.
// - With neither set (local `bun run verify`), the command runs unchanged.
//
// Blob reports hold absolute paths, and self-hosted runners check out into
// different directories. A shard therefore replaces its checkout root with
// ROOT_TOKEN, and the merge replaces the token with the merging checkout root.
// Without this, files tested only on another runner merge as uncovered.

export const DEFAULT_REPORTS_DIRECTORY = ".vitest-reports";
export const ROOT_TOKEN = "<coverage-lane-root>";

export type CoverageLaneDependencies = TestEnvironmentDependencies &
  Readonly<{ cwd: string }>;

/** Replaces `from` with `to` in every blob report of `directory`, if it exists. */
const relocateBlobs = async (
  directory: string,
  from: string,
  to: string
): Promise<void> => {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    // No directory: the shard run failed before Vitest wrote a report, or the
    // merge has nothing to read. Vitest reports either case itself.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const path = join(directory, name);
    // A function replacer keeps `$` in a checkout path literal.
    const content = (await readFile(path, "utf8")).replaceAll(from, () => to);
    await writeFile(path, content);
  }
};

const SHARD = /^([1-9]\d?)\/([1-9]\d?)$/u;
const ACCEPTANCE = "acceptance";

/** The arguments with each `--project <name>` pair kept only if `keep(name)`. */
const withoutProjects = (
  arguments_: readonly string[],
  keep: (project: string) => boolean
): string[] => {
  const kept: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    const project = arguments_[index + 1];
    if (argument === "--project" && project !== undefined) {
      if (keep(project)) kept.push(argument, project);
      index += 1;
    } else kept.push(argument);
  }
  return kept;
};

const configArguments = (arguments_: readonly string[]): string[] => {
  const index = arguments_.indexOf("--config");
  const config = arguments_[index + 1];
  return index >= 0 && config !== undefined ? ["--config", config] : [];
};

/** Arguments for one shard run, or null when the shard value is invalid. */
export const shardArguments = (
  arguments_: readonly string[],
  shard: string,
  reportsDirectory: string
): string[] | null => {
  const match = SHARD.exec(shard);
  const isAcceptance = shard === ACCEPTANCE;
  if (!(isAcceptance || (match && Number(match[1]) <= Number(match[2]))))
    return null;
  const selected = withoutProjects(arguments_, (project) =>
    isAcceptance ? project === ACCEPTANCE : project !== ACCEPTANCE
  );
  const name = isAcceptance ? ACCEPTANCE : shard.replace("/", "-of-");
  return [
    ...selected,
    ...(isAcceptance ? [] : [`--shard=${shard}`]),
    "--reporter=default",
    "--reporter=blob",
    `--outputFile.blob=${reportsDirectory}/${name}.json`,
  ];
};

/** `bun scripts/coverage-lane.ts pnpm exec vitest run [arguments...]` */
export const runCoverageLane = async (
  arguments_: readonly string[],
  dependencies: CoverageLaneDependencies
): Promise<number> => {
  const [command, ...rest] = arguments_;
  if (command === undefined) {
    dependencies.error(
      "Usage: bun scripts/coverage-lane.ts <command> [arguments...]"
    );
    return 2;
  }
  const shard = dependencies.env["COVERAGE_SHARD"];
  const merge = dependencies.env["COVERAGE_MERGE_DIR"];
  if (shard && merge) {
    dependencies.error("Set COVERAGE_SHARD or COVERAGE_MERGE_DIR, not both.");
    return 2;
  }
  if (merge) {
    // `pnpm exec vitest run …` becomes `pnpm exec vitest --merge-reports=…`.
    const runIndex = rest.indexOf("run");
    if (runIndex < 0) {
      dependencies.error("COVERAGE_MERGE_DIR needs a `vitest run` command.");
      return 2;
    }
    await relocateBlobs(
      resolve(dependencies.cwd, merge),
      ROOT_TOKEN,
      dependencies.cwd
    );
    return await dependencies.spawn(
      command,
      [
        ...rest.slice(0, runIndex),
        `--merge-reports=${merge}`,
        ...configArguments(rest),
        "--coverage",
      ],
      dependencies.env
    );
  }
  if (shard) {
    const reportsDirectory =
      dependencies.env["COVERAGE_REPORTS_DIR"] || DEFAULT_REPORTS_DIRECTORY;
    const sharded = shardArguments(rest, shard, reportsDirectory);
    if (sharded === null) {
      dependencies.error(
        `COVERAGE_SHARD must be k/n (1 <= k <= n < 100) or ${ACCEPTANCE}.`
      );
      return 2;
    }
    const code = await dependencies.spawn(command, sharded, {
      ...dependencies.env,
      VITEST_COVERAGE_THRESHOLDS: "off",
    });
    await relocateBlobs(
      resolve(dependencies.cwd, reportsDirectory),
      dependencies.cwd,
      ROOT_TOKEN
    );
    return code;
  }
  return await dependencies.spawn(command, rest, dependencies.env);
};
