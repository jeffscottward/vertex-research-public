// What: one go-live draft collection for the rig timer. RECORDS ONLY: no order, no broker call.
// Flow: (1) GET goLiveDrafts.queue for the plan in force and the trading day; without a plan the run
// stops with a message and exit 0. (2) `python -m golive` in services/research computes the
// candidates from local files, with the plan JSON on stdin; its environment has no key and it uses
// no network. (3) GoLiveCollectInputSchema checks its stdout. (4) POST goLiveDrafts.collect stores
// the candidates. --dry-run prints the checked document and posts nothing.
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... bun run vertex:golive:collect \
//   --data <qc-ports data dir> --chain-store <option-chain snapshot store> [--trading-day YYYY-MM-DD]
//   [--python <interpreter>] [--dry-run]
// Environment instead of flags: GOLIVE_DATA_DIR, GOLIVE_CHAIN_STORE, GOLIVE_PYTHON (default python3).
// Exit codes: 0 stored, printed (--dry-run), no plan, or a closed market day; 1 failure (nothing
// posted); 2 usage.
// Used by: scripts/vertex-golive-collect.ts, infra/golive-drafts/vertex-golive-drafts-run.
// See: services/research/golive/generator.py, packages/api/src/contracts/golive-drafts.ts.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { CalendarDateSchema } from "../../packages/api/src/contracts/calendar-date.ts";
import {
  GoLiveCollectInputSchema,
  GoLivePlanLimitsSchema,
  GoLivePlanSleeveSchema,
  GoLivePlanStatusSchema,
} from "../../packages/api/src/contracts/golive-drafts.ts";

export const GOLIVE_COLLECT_USAGE =
  "Usage: bun run vertex:golive:collect --data <qc-ports data dir> --chain-store <option-chain snapshot store> [--trading-day YYYY-MM-DD] [--python <interpreter>] [--dry-run]  (needs VERTEX_ORIGIN and VERTEX_AGENT_API_KEY; GOLIVE_DATA_DIR, GOLIVE_CHAIN_STORE and GOLIVE_PYTHON replace the flags)";

/** Where `python -m golive` runs: the package is services/research/golive. */
export const GOLIVE_RESEARCH_DIR = fileURLToPath(
  new URL("../../services/research", import.meta.url)
);
/** Exit code of `python -m golive` for a day that is not an NYSE trading day (golive/__main__.py). */
export const GOLIVE_EXIT_NOT_TRADING_DAY = 3;
const REQUEST_TIMEOUT_MS = 30_000;
/** The generator's environment: what an interpreter needs, and never the API key. */
const PYTHON_ENV_KEYS = ["HOME", "PATH"] as const;

export type ProcessResult = Readonly<{
  code: number;
  stderr: string;
  stdout: string;
}>;
export type RunProcess = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    env: Readonly<Record<string, string>>;
    stdin: string;
  }>
) => Promise<ProcessResult>;

export type CollectIo = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  run: RunProcess;
  stderr: Readonly<{ write: (text: string) => unknown }>;
  stdout: Readonly<{ write: (text: string) => unknown }>;
}>;

/** A usage or environment problem; the run exits with code 2. */
class UsageError extends Error {}
/** The run failed and nothing was posted; the run exits with code 1. */
class CollectError extends Error {}

/** Runs a command with stdin; a command that cannot start gives exit code 127 and its error text. */
export const runProcess: RunProcess = async (command, args, options) => {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = Promise.withResolvers<number>();
  child.on("error", (error) => {
    stderr += error.message;
    done.resolve(127);
  });
  child.on("close", (code) => done.resolve(code ?? 1));
  // A command that exits before it reads stdin breaks the pipe. That is the command's result, not
  // a failure here: without this listener the runtime reports an unhandled error.
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.stdin);
  return { code: await done.promise, stderr, stdout };
};

const VALUE_FLAGS = [
  "--data",
  "--chain-store",
  "--trading-day",
  "--python",
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

export type CollectOptions = Readonly<{
  chainStore: string;
  data: string;
  dryRun: boolean;
  python: string;
  tradingDay: string | undefined;
}>;

const isValueFlag = (argument: string): argument is ValueFlag =>
  (VALUE_FLAGS as readonly string[]).includes(argument);

/** Reads the flags, then the GOLIVE_* environment for a directory or interpreter no flag names. */
export const parseCollectArguments = (
  argv: readonly string[],
  env: CollectIo["env"]
): CollectOptions => {
  const values: Partial<Record<ValueFlag, string>> = {};
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!isValueFlag(argument)) {
      throw new UsageError(
        `Unknown argument ${argument}.\n${GOLIVE_COLLECT_USAGE}`
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new UsageError(`${argument} needs a value`);
    }
    values[argument] = value;
    index += 1;
  }
  const data = values["--data"] ?? env["GOLIVE_DATA_DIR"];
  const chainStore = values["--chain-store"] ?? env["GOLIVE_CHAIN_STORE"];
  if (!(data && chainStore)) {
    throw new UsageError(
      `--data and --chain-store are required.\n${GOLIVE_COLLECT_USAGE}`
    );
  }
  const tradingDay = values["--trading-day"];
  if (
    tradingDay !== undefined &&
    !CalendarDateSchema.safeParse(tradingDay).success
  ) {
    throw new UsageError("--trading-day must be a date written YYYY-MM-DD");
  }
  return {
    chainStore,
    data,
    dryRun,
    python: values["--python"] ?? (env["GOLIVE_PYTHON"] || "python3"),
    tradingDay,
  };
};

type Api = Readonly<{ apiKey: string; origin: string }>;

const apiOf = (env: CollectIo["env"]): Api => {
  const origin = env["VERTEX_ORIGIN"];
  const apiKey = env["VERTEX_AGENT_API_KEY"];
  if (!(origin && apiKey)) {
    throw new UsageError("VERTEX_ORIGIN and VERTEX_AGENT_API_KEY are required");
  }
  if (!URL.canParse(origin)) {
    throw new UsageError("VERTEX_ORIGIN must be a URL");
  }
  return { apiKey, origin: new URL(origin).origin };
};

// The queue answer as the RPC transport sends it: { json, meta }. Only the fields this run reads
// are checked; the plan keeps its other fields (dates arrive as text) for the generator.
const QueueEnvelopeSchema = z.looseObject({
  json: z.looseObject({
    plan: z
      .looseObject({
        id: z.string().min(1),
        limits: GoLivePlanLimitsSchema,
        sleeves: z.array(GoLivePlanSleeveSchema).min(1),
        status: GoLivePlanStatusSchema,
        version: z.number().int().positive(),
      })
      .nullable(),
    tradingDay: CalendarDateSchema,
  }),
});
type Queue = z.infer<typeof QueueEnvelopeSchema>["json"];

const bodyOf = async (response: Response, name: string): Promise<string> => {
  const text = await response.text();
  if (!response.ok) {
    throw new CollectError(
      `${name} returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }
  return text;
};

const jsonOf = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new CollectError(`${what} is not JSON: ${text.slice(0, 300)}`);
  }
};

const readQueue = async (
  io: CollectIo,
  api: Api,
  tradingDay: string | undefined
): Promise<Queue> => {
  // A GET procedure of the RPC transport takes its input in the `data` query parameter.
  const input = JSON.stringify({
    json: tradingDay === undefined ? {} : { tradingDay },
  });
  const response = await io.fetch(
    `${api.origin}/api/orpc/goLiveDrafts/queue?data=${encodeURIComponent(input)}`,
    {
      headers: { origin: api.origin, "x-api-key": api.apiKey },
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  const text = await bodyOf(response, "goLiveDrafts.queue");
  const envelope = QueueEnvelopeSchema.safeParse(
    jsonOf(text, "The goLiveDrafts.queue answer")
  );
  if (!envelope.success) {
    throw new CollectError(
      `goLiveDrafts.queue returned an unexpected shape; the generator was not run:\n${z.prettifyError(envelope.error)}`
    );
  }
  return envelope.data.json;
};

const run = async (io: CollectIo): Promise<string> => {
  const options = parseCollectArguments(io.argv, io.env);
  const api = apiOf(io.env);
  const { plan, tradingDay } = await readQueue(io, api, options.tradingDay);
  if (plan === null) {
    return `no plan in force for ${tradingDay}: the generator was not run and nothing was posted`;
  }
  const generated = await io.run(
    options.python,
    [
      "-m",
      "golive",
      "--data",
      options.data,
      "--chain-store",
      options.chainStore,
      "--trading-day",
      tradingDay,
    ],
    {
      cwd: GOLIVE_RESEARCH_DIR,
      env: Object.fromEntries(
        PYTHON_ENV_KEYS.flatMap((key) => {
          const value = io.env[key];
          return value === undefined ? [] : [[key, value]];
        })
      ),
      stdin: JSON.stringify(plan),
    }
  );
  if (generated.code === GOLIVE_EXIT_NOT_TRADING_DAY) {
    return `skipped: ${generated.stderr.trim()}; nothing was posted`;
  }
  if (generated.code !== 0) {
    throw new CollectError(
      `the generator failed (exit ${generated.code}); nothing was posted:\n${generated.stderr.trim()}`
    );
  }
  if (generated.stderr.trim() !== "") {
    io.stderr.write(`${generated.stderr.trim()}\n`);
  }
  const parsed = GoLiveCollectInputSchema.safeParse(
    jsonOf(generated.stdout, "The generator output")
  );
  if (!parsed.success) {
    throw new CollectError(
      `the generator output does not match GoLiveCollectInputSchema; nothing was posted:\n${z.prettifyError(parsed.error)}`
    );
  }
  const document = parsed.data;
  if (
    document.planId !== plan.id ||
    document.planVersion !== plan.version ||
    document.tradingDay !== tradingDay
  ) {
    throw new CollectError(
      `the generator answered for plan ${document.planId} v${document.planVersion} on ${document.tradingDay}, not ${plan.id} v${plan.version} on ${tradingDay}; nothing was posted`
    );
  }
  if (options.dryRun) {
    return JSON.stringify(document, null, 2);
  }
  const response = await io.fetch(
    `${api.origin}/api/orpc/goLiveDrafts/collect`,
    {
      body: JSON.stringify({ json: document }),
      headers: {
        "content-type": "application/json",
        origin: api.origin,
        "x-api-key": api.apiKey,
      },
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  const stored = await bodyOf(response, "goLiveDrafts.collect");
  const today = document.candidates.filter(
    (candidate) => candidate.entryBasis === "signal_today"
  ).length;
  return `${tradingDay} plan ${plan.id} v${plan.version} (${plan.status}): ${today} signal_today, ${document.candidates.length - today} model_holds_account_does_not; collect: ${stored.slice(0, 200)}`;
};

/** Runs one collection and returns the process exit code: 0 ok, 1 failure (nothing posted), 2 usage. */
export const runGoLiveCollect = async (io: CollectIo): Promise<number> => {
  if (io.argv.includes("--help")) {
    io.stdout.write(`${GOLIVE_COLLECT_USAGE}\n`);
    return 0;
  }
  try {
    io.stdout.write(`${await run(io)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }
    io.stderr.write(
      `golive collect failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};

type SystemProcess = Pick<NodeJS.Process, "argv" | "env" | "stderr" | "stdout">;

/** The real process, network and command access of one run. */
export const systemCollectIo = (host: SystemProcess): CollectIo => ({
  argv: host.argv.slice(2),
  env: host.env,
  fetch: (url, init) => globalThis.fetch(url, init),
  run: runProcess,
  stderr: host.stderr,
  stdout: host.stdout,
});
