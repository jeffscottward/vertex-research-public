// The one command of the semantic-layer eval recorder: `bun run eval:semantic:record -- [--expect=<n>]
// [--log=<file>] [trials] [concurrency] [stale | upgrade | ids...]`.
// A run that needs the model starts one OMP session with the model RECORDING_MODEL and only the
// eval tool, and has that session run `runBridge` (bridge.ts) once in its JavaScript eval kernel. In
// that session `completion()` answers with that model. The bridge starts the recorder (record.ts)
// and answers its model requests.
// A run that needs no model starts the recorder directly: `upgrade`, and `--expect=0` (the recorder
// prints what it would record and stops; use it with `stale` to see the cost of a recording).
//   --expect=<n>  passed to the recorder: the run stops before the first model request when it
//                 selects another number of trials than n (state the planned number for a `stale` run).
//   --log=<file>  the log of the bridge; default a new file in the temporary directory.
// The bridge ends its log with one line "STATS " + its statistics (bridge.ts, BridgeStats); `rc` in
// it is the exit code of the recorder and `last` its last message with the failed trials. This
// command prints that line and reads its verdict from it, not from the reply text of the session:
// the session is a model that follows one instruction. The bridge refuses a log file that exists, so
// a session that runs the cell twice records once.
// Exit code: the exit code of the recorder (1 when the log has no statistics); 2 for wrong arguments.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EVAL_QUESTIONS } from "./questions.ts";
import { parseCount, parseSelection, RECORDING_MODEL } from "./recording.ts";

const BRIDGE = fileURLToPath(new URL("./bridge.ts", import.meta.url));

export type SessionOptions = Readonly<{
  /** [trials] [concurrency] [stale | upgrade | ids...] */
  recorderArgs: readonly string[];
  log: string;
  expectSelected?: number;
  deadlineSeconds: number;
  /** False for `upgrade` and for `--expect=0`: the recorder then makes no model request. */
  needsModel: boolean;
}>;

/** The arguments of record.ts for these options. */
export const recorderArgsOf = (options: SessionOptions): string[] => [
  ...(options.expectSelected === undefined
    ? []
    : [`--expect=${options.expectSelected}`]),
  ...options.recorderArgs,
];

/** The code of the one eval cell: it loads the bridge from this checkout and runs it. */
export const cellCode = (options: SessionOptions): string => {
  const bridgeOptions = {
    deadlineSeconds: options.deadlineSeconds,
    log: options.log,
    model: RECORDING_MODEL,
    recorderArgs: recorderArgsOf(options),
  };
  return [
    `const { runBridge } = await import(${JSON.stringify(BRIDGE)});`,
    `const stats = await runBridge({ completion, ...${JSON.stringify(bridgeOptions)} });`,
    `return "RESULT " + JSON.stringify(stats);`,
  ].join("\n");
};

/** The `omp` arguments of the recording session. */
export const sessionArgs = (options: SessionOptions): string[] => [
  "-p",
  "--no-session",
  "--no-tools",
  "--tools",
  "eval",
  "--no-lsp",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-context-files",
  "--no-title",
  "--model",
  RECORDING_MODEL,
  `Call the eval tool exactly once with language "js", timeout ${options.deadlineSeconds + 300} and exactly this code, then reply with only the line of the output that starts with RESULT, verbatim, and nothing else. Do not change the code and do not run anything else, also not when it fails; in that case reply with the error text.\n\n${cellCode(options)}`,
];

/** Reads the arguments of this command. Throws on a wrong recorder argument, before any model call. */
export const parseSessionArgs = (
  argv: readonly string[],
  now: Date
): SessionOptions => {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const recorderArgs = argv.filter((arg) => !arg.startsWith("--"));
  let expectSelected: number | undefined;
  let log = join(
    tmpdir(),
    `semantic-eval-record-${now.toISOString().replaceAll(/[:.]/gu, "-")}.log`
  );
  for (const flag of flags) {
    const cut = flag.indexOf("=");
    const name = cut === -1 ? flag : flag.slice(0, cut);
    const value = cut === -1 ? undefined : flag.slice(cut + 1);
    if (name === "--expect" && value !== undefined && /^\d+$/u.test(value)) {
      expectSelected = Number(value);
    } else if (name === "--log" && value !== undefined && value !== "") {
      // Absolute: the session, which writes the log, starts in another directory.
      log = resolve(value);
    } else {
      throw new Error(
        `Unknown option ${flag}. Usage: [--expect=<n>] [--log=<file>] [trials] [concurrency] [stale | upgrade | ids...]`
      );
    }
  }
  const [trials, concurrency, ...selectors] = recorderArgs;
  parseCount("trials", trials, 3);
  parseCount("concurrency", concurrency, 6);
  const selection = parseSelection(
    selectors,
    EVAL_QUESTIONS.map((question) => question.id)
  );
  return {
    deadlineSeconds: 3000,
    ...(expectSelected === undefined ? {} : { expectSelected }),
    log,
    needsModel: selection.kind !== "upgrade" && expectSelected !== 0,
    recorderArgs,
  };
};

/** The statistics line that the bridge wrote last into its log; null when the log has none. */
export const statsOf = (
  log: string
): Readonly<{ line: string; rc: unknown }> | null => {
  const line = log.split("\n").findLast((entry) => entry.startsWith("STATS "));
  if (line === undefined) return null;
  try {
    const stats: unknown = JSON.parse(line.slice("STATS ".length));
    return {
      line,
      rc:
        typeof stats === "object" && stats !== null && "rc" in stats
          ? stats.rc
          : null,
    };
  } catch {
    return null;
  }
};

if (import.meta.main) {
  let options: SessionOptions;
  try {
    options = parseSessionArgs(process.argv.slice(2), new Date());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
  if (!options.needsModel) {
    const recorder = spawnSync(
      "bun",
      [
        fileURLToPath(
          new URL("../../../scripts/with-test-env.ts", import.meta.url)
        ),
        "bun",
        fileURLToPath(new URL("./record.ts", import.meta.url)),
        ...recorderArgsOf(options),
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        stdio: "inherit",
      }
    );
    process.exit(recorder.status ?? 1);
  }
  // The bridge refuses a log that exists; without this check the verdict below would be the one
  // of the earlier run.
  if (existsSync(options.log)) {
    console.error(
      `The log file ${options.log} exists: one log file for each run.`
    );
    process.exit(2);
  }
  console.info(`bridge log: ${options.log}`);
  // The session starts in the temporary directory, so it loads no project context.
  const session = spawnSync("omp", sessionArgs(options), {
    cwd: tmpdir(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: (options.deadlineSeconds + 600) * 1000,
  });
  process.stdout.write(session.stdout ?? "");
  const stats = existsSync(options.log)
    ? statsOf(readFileSync(options.log, "utf8"))
    : null;
  if (stats === null) {
    console.error(`No statistics in the bridge log ${options.log}.`);
    process.exit(1);
  }
  console.info(stats.line);
  process.exit(typeof stats.rc === "number" ? stats.rc : 1);
}
