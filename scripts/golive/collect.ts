// What: one go-live draft collection for the rig timer. RECORDS ONLY: no order, no broker call.
// Flow: (1) GET goLiveDrafts.queue for the plan in force and the trading day; without a plan the run
// stops with a message and exit 0. (2) `python -m golive` in services/research computes the
// candidates from local files, with the plan JSON on stdin; its environment has HOME and PATH only
// (never the key) and it uses no network. (3) GoLiveCollectInputSchema checks its stdout: strikes
// the right way round for the structure, a real expiry after the trading day, finite numbers. On
// top of it every quote must carry a source the rig can truthfully produce (GOLIVE_RIG_QUOTE_SOURCES:
// the generator reads Yahoo chain snapshots only, so never ibkr_live and never model). One refused
// candidate refuses the whole run. (4) POST goLiveDrafts.collect stores the candidates and its
// answer is checked with GoLiveCollectOutputSchema. --dry-run prints the checked document and posts
// nothing.
// Nothing is posted unless every check passed: the server expires the day's proposed drafts that a
// post does not name, so an empty or partial post after an error would remove drafts.
// "Zero candidates" is posted only as an honest result. It is told apart from an error by all of:
// the generator exited 0 (not killed, not timed out), wrote nothing to stderr, and printed exactly
// one document that passes the schema and names the plan id, plan version and trading day of this
// run. The generator refuses stale data itself (exit 1). Text on stderr with an empty candidate
// list is a failure. Text on stderr with candidates is passed on and the candidates are posted.
// Transport: VERTEX_ORIGIN must be https; http is accepted for a loopback host only (tests, local
// development). No request follows a redirect, so the key reaches the one configured origin only.
// The key is never printed: every line this run writes has the key replaced.
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... bun run vertex:golive:collect \
//   --data <qc-ports data dir> --chain-store <option-chain snapshot store> [--trading-day YYYY-MM-DD]
//   [--python <interpreter>] [--dry-run]
// Environment instead of flags: GOLIVE_DATA_DIR, GOLIVE_CHAIN_STORE, GOLIVE_PYTHON (default python3).
// GOLIVE_GENERATOR_TIMEOUT_MS: the generator is killed after this time (default 300000 = 300 s).
// Exit codes: 0 stored, printed (--dry-run) or no plan; 1 failure, including a generator that
// calls the trading day a closed market day (its calendar disagrees with the server's); 2 usage.
// After exit 1 nothing was stored, except when the collect request itself was sent and its answer
// could not be read: the message then says that the stored state is unknown.
// Used by: scripts/vertex-golive-collect.ts, infra/golive-drafts/vertex-golive-drafts-run.
// See: services/research/golive/generator.py, packages/api/src/contracts/golive-drafts.ts.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { CalendarDateSchema } from "../../packages/api/src/contracts/calendar-date.ts";
import {
  GoLiveCollectInputSchema,
  GoLiveCollectOutputSchema,
  GoLivePlanLimitsSchema,
  GoLivePlanSleeveSchema,
  GoLivePlanStatusSchema,
} from "../../packages/api/src/contracts/golive-drafts.ts";

export const GOLIVE_COLLECT_USAGE =
  "Usage: bun run vertex:golive:collect --data <qc-ports data dir> --chain-store <option-chain snapshot store> [--trading-day YYYY-MM-DD] [--python <interpreter>] [--dry-run]  (needs VERTEX_ORIGIN and VERTEX_AGENT_API_KEY; VERTEX_ORIGIN must be https; GOLIVE_DATA_DIR, GOLIVE_CHAIN_STORE and GOLIVE_PYTHON replace the flags; GOLIVE_GENERATOR_TIMEOUT_MS limits the generator, default 300000)";

/** Where `python -m golive` runs: the package is services/research/golive. */
export const GOLIVE_RESEARCH_DIR = fileURLToPath(
  new URL("../../services/research", import.meta.url)
);
/**
 * Exit code of `python -m golive` when its calendar says the day is not an NYSE trading day
 * (golive/__main__.py). The day comes from the server, so this is a calendar disagreement.
 */
export const GOLIVE_EXIT_NOT_TRADING_DAY = 3;
/** How long the generator may run before it is killed. */
export const GOLIVE_GENERATOR_TIMEOUT_MS = 300_000;
/**
 * The quote sources the rig generator can truthfully produce. generator.py sets one label,
 * QUOTE_SOURCE = "yahoo_delayed_snapshot": it never emits "model", and "ibkr_live" is a claim only
 * the server can make.
 */
export const GOLIVE_RIG_QUOTE_SOURCES: readonly string[] = [
  "yahoo_delayed_snapshot",
];
const REQUEST_TIMEOUT_MS = 30_000;
/** The generator's environment: what an interpreter needs, and never the API key. */
const PYTHON_ENV_KEYS = ["HOME", "PATH"] as const;
/** Hosts for which plain http is accepted (URL.hostname keeps the brackets of an IPv6 address). */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "[::1]", "localhost"];

export type ProcessResult = Readonly<{
  code: number;
  /** The signal that ended the command, or null when it exited by itself. */
  signal: string | null;
  stderr: string;
  stdout: string;
  /** True when the command passed its time limit and was killed. */
  timedOut: boolean;
}>;
export type RunProcess = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    env: Readonly<Record<string, string>>;
    stdin: string;
    timeoutMs: number;
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

/**
 * Runs a command with stdin. A command that cannot start gives exit code 127 and its error text; a
 * command ended by a signal gives exit code 1 and the signal; a command still running after
 * `timeoutMs` is killed and reported as timed out.
 */
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
  const done =
    Promise.withResolvers<
      Pick<ProcessResult, "code" | "signal" | "timedOut">
    >();
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    // The pipes are closed here and not awaited: a process the command started may hold them open.
    child.stdout.destroy();
    child.stderr.destroy();
    done.resolve({ code: 1, signal: "SIGKILL", timedOut: true });
  }, options.timeoutMs);
  child.on("error", (error) => {
    stderr += error.message;
    done.resolve({ code: 127, signal: null, timedOut: false });
  });
  child.on("close", (code, signal) =>
    done.resolve({ code: code ?? 1, signal, timedOut: false })
  );
  // A command that exits before it reads stdin breaks the pipe. That is the command's result, not
  // a failure here: without this listener the runtime reports an unhandled error.
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.stdin);
  const ended = await done.promise;
  clearTimeout(timer);
  return { ...ended, stderr, stdout };
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
  const url = new URL(origin);
  // The key travels in a header: it is sent over TLS, or to this machine only.
  const loopbackHttp =
    url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname);
  if (!(url.protocol === "https:" || loopbackHttp)) {
    throw new UsageError(
      "VERTEX_ORIGIN must be an https URL (http is accepted for 127.0.0.1, ::1 and localhost only); no request was made"
    );
  }
  return { apiKey, origin: url.origin };
};

const generatorTimeoutOf = (env: CollectIo["env"]): number => {
  const text = env["GOLIVE_GENERATOR_TIMEOUT_MS"];
  if (text === undefined || text === "") {
    return GOLIVE_GENERATOR_TIMEOUT_MS;
  }
  if (!/^[1-9]\d{0,8}$/u.test(text)) {
    throw new UsageError(
      "GOLIVE_GENERATOR_TIMEOUT_MS must be a whole number of milliseconds above 0"
    );
  }
  return Number(text);
};

// The queue answer as the RPC transport sends it: { json, meta }. The full GoLiveQueueOutputSchema
// cannot check this text form (its dates arrive as text), so the fields this run reads are checked
// with the contract's own field schemas, and the plan keeps its other fields for the generator.
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
    sendsOrders: z.literal(false),
    tradingDay: CalendarDateSchema,
  }),
});
type Queue = z.infer<typeof QueueEnvelopeSchema>["json"];

// The collect answer of the RPC transport: { json: GoLiveCollectOutputSchema }.
const CollectEnvelopeSchema = z.looseObject({
  json: GoLiveCollectOutputSchema,
});

/** One request to the configured origin. A redirect is an error: the key goes to no second host. */
const request = async (
  io: CollectIo,
  url: string,
  init: RequestInit,
  name: string
): Promise<string> => {
  const response = await io
    .fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    .catch((error: unknown) => {
      throw new CollectError(
        `${name}: the request failed (no answer, a time limit, or a redirect, which is refused so that the key reaches ${new URL(url).origin} only): ${error instanceof Error ? error.message : String(error)}`
      );
    });
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
  const text = await request(
    io,
    `${api.origin}/api/orpc/goLiveDrafts/queue?data=${encodeURIComponent(input)}`,
    { headers: { origin: api.origin, "x-api-key": api.apiKey }, method: "GET" },
    "goLiveDrafts.queue"
  );
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

/** Throws for every way the generator can end without a result; exit 0 passes. */
const refuseFailedGenerator = (
  generated: ProcessResult,
  tradingDay: string,
  dayFrom: string,
  timeoutMs: number
): void => {
  const said = generated.stderr.trim();
  if (generated.timedOut) {
    throw new CollectError(
      `the generator did not finish within ${timeoutMs} ms and was killed; nothing was posted`
    );
  }
  if (generated.signal !== null) {
    throw new CollectError(
      `the generator was ended by ${generated.signal}; nothing was posted:\n${said}`
    );
  }
  if (generated.code === GOLIVE_EXIT_NOT_TRADING_DAY) {
    throw new CollectError(
      `calendar disagreement: ${dayFrom} named ${tradingDay} as the trading day and the generator's calendar says it is not one (exit ${GOLIVE_EXIT_NOT_TRADING_DAY}); nothing was posted:\n${said}`
    );
  }
  if (generated.code !== 0) {
    throw new CollectError(
      `the generator failed (exit ${generated.code}); nothing was posted:\n${said}`
    );
  }
};

const run = async (io: CollectIo): Promise<string> => {
  const options = parseCollectArguments(io.argv, io.env);
  const api = apiOf(io.env);
  const timeoutMs = generatorTimeoutOf(io.env);
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
      timeoutMs,
    }
  );
  refuseFailedGenerator(
    generated,
    tradingDay,
    options.tradingDay === undefined ? "the server" : "--trading-day",
    timeoutMs
  );
  const said = generated.stderr.trim();
  if (said !== "") {
    io.stderr.write(`${said}\n`);
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
  const foreign = document.candidates.flatMap((candidate, index) =>
    candidate.quote === null ||
    GOLIVE_RIG_QUOTE_SOURCES.includes(candidate.quote.source)
      ? []
      : [`candidates[${index}].quote.source is ${candidate.quote.source}`]
  );
  if (foreign.length > 0) {
    throw new CollectError(
      `the generator labelled a quote with a source the rig cannot produce (it reads ${GOLIVE_RIG_QUOTE_SOURCES.join(", ")} only); nothing was posted:\n${foreign.join("\n")}`
    );
  }
  if (document.candidates.length === 0 && said !== "") {
    throw new CollectError(
      "the generator gave no candidates and wrote the text above to stderr; an error is not read as a day without candidates; nothing was posted"
    );
  }
  if (options.dryRun) {
    return JSON.stringify(document, null, 2);
  }
  const answer = await request(
    io,
    `${api.origin}/api/orpc/goLiveDrafts/collect`,
    {
      body: JSON.stringify({ json: document }),
      headers: {
        "content-type": "application/json",
        origin: api.origin,
        "x-api-key": api.apiKey,
      },
      method: "POST",
    },
    "goLiveDrafts.collect"
  );
  const stored = CollectEnvelopeSchema.safeParse(
    jsonOf(
      answer,
      "The request was sent and whether the candidates were stored is unknown: the goLiveDrafts.collect answer"
    )
  );
  if (!stored.success) {
    throw new CollectError(
      `goLiveDrafts.collect answered with a body that is not a collect result; the request was sent and whether the candidates were stored is unknown:\n${answer.slice(0, 300)}`
    );
  }
  const today = document.candidates.filter(
    (candidate) => candidate.entryBasis === "signal_today"
  ).length;
  const { created, expired, unchanged, updated } = stored.data.json;
  return `${tradingDay} plan ${plan.id} v${plan.version} (${plan.status}): ${today} signal_today, ${document.candidates.length - today} model_holds_account_does_not; stored: ${created} created, ${updated} updated, ${unchanged} unchanged, ${expired} expired`;
};

/** Runs one collection and returns the process exit code: 0 ok, 1 failure, 2 usage. */
export const runGoLiveCollect = async (io: CollectIo): Promise<number> => {
  if (io.argv.includes("--help")) {
    io.stdout.write(`${GOLIVE_COLLECT_USAGE}\n`);
    return 0;
  }
  // A server answer or an error text may repeat the key: no line leaves this run with it.
  const apiKey = io.env["VERTEX_AGENT_API_KEY"];
  const hidden = (text: string): string =>
    apiKey ? text.replaceAll(apiKey, "[key hidden]") : text;
  const safe: CollectIo = {
    ...io,
    stderr: { write: (text) => io.stderr.write(hidden(text)) },
    stdout: { write: (text) => io.stdout.write(hidden(text)) },
  };
  try {
    safe.stdout.write(`${await run(safe)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      safe.stderr.write(`${error.message}\n`);
      return 2;
    }
    safe.stderr.write(
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
