// OpenBB tick client for the scheduler (docs/vertex-rebuild/openbb.md). Research only: no orders.
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... \
//   bun run vertex:openbb:tick <job> [--since YYYY-MM-DD] [--until YYYY-MM-DD (congress jobs)] [--symbols A,B] [--filers CIK,CIK]
//   [--window <days>@<HH:MM>-<HH:MM>] [--dry-run]
// It runs the pinned fetcher (`${OPENBB_PYTHON:-python3} -I -m vertex_openbb <job> ...` in
// services/openbb or OPENBB_SERVICE_DIR), checks its stdout with the Zod batch schema, posts every
// table to openbb.ingest in chunks of at most 2,000 rows with an operator agent WRITE key, then
// records the run with openbb.recordRun (ok, partial or failed; a failed fetcher is recorded too).
// When every source of the job was refused by its host (HTTP 403 or 429, or a bot check page), the
// fetcher document has `blocked`: the run is recorded as blocked_upstream and the tick exits 0, so
// one blocked source does not fail the unit. A timer run (VERTEX_OPENBB_TIMER=1) first reads
// openbb.status: a job in a blocked streak is skipped until the retry time (1 h after the first
// blocked run, then 6 h), and the first timer run of each 7-day period of the streak (from the
// second period on) exits 1 one time, so a lasting block is seen. A manual blocked run, or a timer
// run whose status read failed, earlier in the same period moves the exit 1 to the next period.
// --window skips the run outside a New York time window (days `mon-fri`, `daily` or a comma list
// such as `fri,sat`; start inclusive, end exclusive) so one 5-minute timer can drive every job.
// --dry-run fetches and prints per-table row counts only: nothing is posted or recorded.
// The key is never printed and never passed to the Python process.

import { z } from "zod";

import {
  OPENBB_BLOCKED_ESCALATE_MS,
  OPENBB_BLOCKED_RETRY_TOLERANCE_MS,
  OPENBB_JOB_TABLES,
  OPENBB_JOBS,
  OPENBB_MAX_INGEST_ROWS,
  OPENBB_TABLE_REQUIRES,
  type OpenbbBatchDocument,
  OpenbbBatchDocumentSchema,
  type OpenbbJob,
  openbbBlockedError,
} from "../../packages/api/src/contracts/openbb.ts";

const EnvelopeSchema = z.object({ json: z.unknown() });
const IngestReplySchema = z.object({ written: z.number().int().nonnegative() });
// The part of the openbb.status reply the backoff needs (dates arrive as ISO strings). A server
// older than the blocked_upstream status sends no `blocked`: then no run is skipped.
const StatusReplySchema = z.object({
  runs: z.array(
    z.object({
      blocked: z
        .object({ nextRetryAt: z.coerce.date(), since: z.coerce.date() })
        .nullish(),
      error: z.string().nullable(),
      job: z.string(),
      startedAt: z.coerce.date(),
    })
  ),
});

export type OpenbbSpawnResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type OpenbbTickIo = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  now: () => Date;
  post: (url: string, init: RequestInit) => Promise<Response>;
  spawn: (
    command: string,
    args: readonly string[],
    options: Readonly<{
      cwd: string;
      env: Readonly<Record<string, string | undefined>>;
    }>
  ) => Promise<OpenbbSpawnResult>;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
}>;

type Arguments = Readonly<{
  job: OpenbbJob;
  dryRun: boolean;
  window: string | null;
  passthrough: string[];
}>;

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const PASSTHROUGH_FLAGS = [
  "--since",
  "--until",
  "--symbols",
  "--filers",
] as const;
const DEFAULT_SERVICE_DIR = new URL("../../services/openbb", import.meta.url)
  .pathname;
const ERROR_MAX = 4000;
/** One openbb.* call may take this long before the tick gives up on it. */
const POST_TIMEOUT_MS = 60_000;
/** The status read before the fetch is short: the step budget is the fetcher deadline + 90 s. */
const STATUS_TIMEOUT_MS = 15_000;

/** The first `max` UTF-16 units of `text`, never ending inside a surrogate pair. */
export const truncateText = (text: string, max: number): string => {
  // 0xD800-0xDBFF: the high (first) half of a surrogate pair.
  const last = text.charCodeAt(max - 1);
  const end =
    text.length > max && last >= 0xd8_00 && last <= 0xdb_ff ? max - 1 : max;
  return text.slice(0, end);
};
/** Environment the Python fetcher may see; everything else (the agent key included) stays out. */
const CHILD_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "VERTEX_RESEARCH_CONTACT_EMAIL",
  "OPENBB_STOCK_UNIVERSE",
  "OPENBB_DEADLINE_S",
]);

/** The allowlisted variables of `env` (plus every LC_*), for the Python child. */
export const openbbChildEnv = (
  env: OpenbbTickIo["env"]
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (CHILD_ENV_NAMES.has(entry[0]) || entry[0].startsWith("LC_"))
    )
  );

class UsageError extends Error {}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const parseArguments = (argv: readonly string[]): Arguments => {
  const [job, ...rest] = argv;
  if (!OPENBB_JOBS.includes(job as OpenbbJob))
    throw new UsageError(
      `first argument must be a job: ${OPENBB_JOBS.join(", ")}`
    );
  const passthrough: string[] = [];
  let dryRun = false;
  let window: string | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] as string;
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = rest[index + 1];
    const known =
      flag === "--window" ||
      (PASSTHROUGH_FLAGS as readonly string[]).includes(flag);
    if (!known) throw new UsageError(`unknown argument: ${flag}`);
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(`${flag} needs a value`);
    index += 1;
    if (flag === "--window") window = value;
    else passthrough.push(flag, value);
  }
  return { dryRun, job: job as OpenbbJob, passthrough, window };
};

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: "America/New_York",
  weekday: "short",
});

/** Minutes after midnight of `HH:MM`; `24:00` (end of day) is 1440. */
const minutesOf = (text: string): number => {
  if (text === "24:00") return 24 * 60;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(text);
  if (match === null)
    throw new UsageError(`--window time ${text} is not HH:MM`);
  return Number(match[1]) * 60 + Number(match[2]);
};

const dayIndex = (text: string): number => {
  const index = DAYS.indexOf(text as (typeof DAYS)[number]);
  if (index < 0) throw new UsageError(`--window day ${text} is not mon..sun`);
  return index;
};

/** Days of `daily`, `mon-fri` style ranges or comma lists of either. */
const daysOf = (text: string): Set<number> => {
  if (text === "daily") return new Set([0, 1, 2, 3, 4, 5, 6]);
  const days = new Set<number>();
  for (const part of text.split(",")) {
    const [first, last = first] = part.split("-") as [string, string?];
    const start = dayIndex(first);
    const end = dayIndex(last);
    if (end < start)
      throw new UsageError(`--window day range ${part} runs backwards`);
    for (let day = start; day <= end; day += 1) days.add(day);
  }
  return days;
};

/** True when `now` (New York time) is inside `<days>@<HH:MM>-<HH:MM>`. */
export const insideOpenbbWindow = (spec: string, now: Date): boolean => {
  const match = /^([a-z,-]+)@(\d{2}:\d{2})-(\d{2}:\d{2})$/u.exec(spec);
  if (match === null)
    throw new UsageError(`--window ${spec} is not <days>@<HH:MM>-<HH:MM>`);
  const [, dayText, startText, endText] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  const days = daysOf(dayText);
  const start = minutesOf(startText);
  const end = minutesOf(endText);
  if (end <= start)
    throw new UsageError(`--window ${spec} must end after it starts`);
  const parts = Object.fromEntries(
    NY_PARTS.formatToParts(now).map((part) => [part.type, part.value])
  ) as Record<string, string>;
  const minute = Number(parts["hour"]) * 60 + Number(parts["minute"]);
  return (
    days.has(dayIndex(String(parts["weekday"]).toLowerCase())) &&
    minute >= start &&
    minute < end
  );
};

type Api = Readonly<{ origin: string; apiKey: string }>;

const apiOf = (env: OpenbbTickIo["env"]): Api => {
  const value = (name: string) => {
    const text = env[name]?.trim();
    if (text === undefined || text === "")
      throw new Error(`${name} is required`);
    return text;
  };
  return {
    apiKey: value("VERTEX_AGENT_API_KEY"),
    origin: new URL(value("VERTEX_ORIGIN")).origin,
  };
};

/** Posts one oRPC call; returns the `json` of the reply or throws with the HTTP status. */
const call = async (
  io: OpenbbTickIo,
  api: Api,
  procedure: "ingest" | "recordRun" | "status",
  input: unknown,
  timeoutMs = POST_TIMEOUT_MS
): Promise<unknown> => {
  const response = await io.post(`${api.origin}/api/orpc/openbb/${procedure}`, {
    body: JSON.stringify({ json: input }),
    headers: {
      "content-type": "application/json",
      origin: api.origin,
      "x-api-key": api.apiKey,
    },
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `openbb.${procedure} returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  return EnvelopeSchema.parse(JSON.parse(text)).json;
};

/** The blocked streak of a job before this run, from openbb.status. */
type BlockedStreak = Readonly<{
  error: string | null;
  lastStartedAt: Date;
  nextRetryAt: Date;
  since: Date;
}>;

/** The job's blocked streak, or null (no streak, or the status read failed: the run then tries). */
const blockedStreakOf = async (
  io: OpenbbTickIo,
  api: Api,
  job: OpenbbJob
): Promise<BlockedStreak | null> => {
  try {
    const reply = StatusReplySchema.parse(
      await call(io, api, "status", {}, STATUS_TIMEOUT_MS)
    );
    const run = reply.runs.find((candidate) => candidate.job === job);
    if (run?.blocked === undefined || run.blocked === null) return null;
    return {
      error: run.error,
      lastStartedAt: run.startedAt,
      nextRetryAt: run.blocked.nextRetryAt,
      since: run.blocked.since,
    };
  } catch (error) {
    io.stderr.write(
      `openbb tick: status read failed, the run tries without backoff: ${messageOf(error)}\n`
    );
    return null;
  }
};

/**
 * True on the first blocked run of each 7-day period of the streak: this run starts in a later
 * period than the newest earlier blocked run. Both sides use the start times of the run ledger, so
 * the rule does not depend on which run (timer or manual) came before.
 */
const passesEscalation = (streak: BlockedStreak, startedAt: Date): boolean => {
  const period = (at: Date): number =>
    Math.floor(
      (at.getTime() - streak.since.getTime()) / OPENBB_BLOCKED_ESCALATE_MS
    );
  return (
    period(startedAt) >= 1 && period(startedAt) > period(streak.lastStartedAt)
  );
};

type Fetched =
  | Readonly<{ ok: true; document: OpenbbBatchDocument }>
  | Readonly<{ ok: false; error: string }>;

const fetchBatch = async (
  io: OpenbbTickIo,
  args: Arguments
): Promise<Fetched> => {
  // The Python process gets an allowlisted environment: never the agent key or other secrets.
  let result: OpenbbSpawnResult;
  try {
    result = await io.spawn(
      io.env["OPENBB_PYTHON"]?.trim() || "python3",
      ["-I", "-m", "vertex_openbb", args.job, ...args.passthrough],
      {
        cwd: io.env["OPENBB_SERVICE_DIR"]?.trim() || DEFAULT_SERVICE_DIR,
        env: openbbChildEnv(io.env),
      }
    );
  } catch (error) {
    // A missing venv or interpreter, or stdout over the cap: still a recorded, failed run.
    return { error: `fetcher failed to run: ${messageOf(error)}`, ok: false };
  }
  if (result.stderr !== "") io.stderr.write(result.stderr);
  if (result.exitCode !== 0)
    return {
      error: `fetcher exited ${result.exitCode}: ${result.stderr.trim().slice(-500)}`,
      ok: false,
    };
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    return { error: "fetcher stdout is not JSON", ok: false };
  }
  const parsed = OpenbbBatchDocumentSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("; ");
    return { error: `fetcher batch failed the schema (${details})`, ok: false };
  }
  if (parsed.data.job !== args.job)
    return {
      error: `fetcher answered job ${parsed.data.job}, not ${args.job}`,
      ok: false,
    };
  return { document: parsed.data, ok: true };
};

type Outcome = Readonly<{
  received: number;
  written: number;
  failedChunks: number;
  chunks: number;
  errors: string[];
}>;

const postTables = async (
  io: OpenbbTickIo,
  api: Api,
  document: OpenbbBatchDocument
): Promise<Outcome> => {
  let received = 0;
  let written = 0;
  let chunks = 0;
  let failedChunks = 0;
  const errors: string[] = [];
  const failedTables = new Set<string>();
  // Post in OPENBB_JOB_TABLES order, so a required table always goes first.
  const order: readonly string[] = OPENBB_JOB_TABLES[document.job];
  const tables = [...document.tables].sort(
    (left, right) => order.indexOf(left.table) - order.indexOf(right.table)
  );
  for (const { table, rows } of tables) {
    const required = OPENBB_TABLE_REQUIRES[table];
    if (required !== undefined && failedTables.has(required)) {
      // Not posted: count its rows as received, its chunks as failed, and say why.
      const skipped = Math.ceil(rows.length / OPENBB_MAX_INGEST_ROWS);
      chunks += skipped;
      failedChunks += skipped;
      received += rows.length;
      failedTables.add(table);
      errors.push(`${table}: not posted because ${required} failed`);
      io.stderr.write(`${table}: not posted because ${required} failed\n`);
      continue;
    }
    for (let start = 0; start < rows.length; start += OPENBB_MAX_INGEST_ROWS) {
      const chunk = rows.slice(start, start + OPENBB_MAX_INGEST_ROWS);
      chunks += 1;
      received += chunk.length;
      try {
        const reply = IngestReplySchema.parse(
          await call(io, api, "ingest", {
            batch: { rows: chunk, table },
            job: document.job,
          })
        );
        written += reply.written;
        io.stdout.write(
          `${table}: wrote ${reply.written} of ${chunk.length} rows\n`
        );
      } catch (error) {
        failedChunks += 1;
        failedTables.add(table);
        errors.push(`${table}@${start}: ${messageOf(error)}`);
        io.stderr.write(
          `${table}: chunk at row ${start} failed: ${messageOf(error)}\n`
        );
      }
    }
  }
  return { chunks, errors, failedChunks, received, written };
};

const statusOf = (
  outcome: Outcome,
  warnings: number
): "ok" | "partial" | "failed" => {
  if (outcome.chunks > 0 && outcome.failedChunks === outcome.chunks)
    return "failed";
  return outcome.failedChunks > 0 || warnings > 0 ? "partial" : "ok";
};

/** The streak to wait for, when a timer run of a blocked job comes before its retry time. */
const backoffOf = async (
  io: OpenbbTickIo,
  api: Api | null,
  job: OpenbbJob
): Promise<Readonly<{ streak: BlockedStreak | null; skip: boolean }>> => {
  // Backoff applies to timer runs only: a manual run and a dry run always try, and they do not
  // read the status (so a manual run is also outside the 7-day rule).
  const streak =
    api !== null && io.env["VERTEX_OPENBB_TIMER"] === "1"
      ? await blockedStreakOf(io, api, job)
      : null;
  const skip =
    streak !== null &&
    io.now().getTime() <
      streak.nextRetryAt.getTime() - OPENBB_BLOCKED_RETRY_TOLERANCE_MS;
  if (streak !== null && skip)
    io.stdout.write(
      `skip: blocked upstream (${streak.error ?? "no reason recorded"}) since ${streak.since.toISOString()}; next retry not before ${streak.nextRetryAt.toISOString()}\n`
    );
  return { skip, streak };
};

type Blocked = NonNullable<OpenbbBatchDocument["blocked"]>;

/** The host that refused the job. The fetcher sets it only with empty tables; with rows it is ignored. */
const blockedOf = (document: OpenbbBatchDocument | null): Blocked | null =>
  document?.tables.every(({ rows }) => rows.length === 0)
    ? (document.blocked ?? null)
    : null;

/** Prints what a dry run fetched; nothing is posted or recorded. */
const printDryRun = (io: OpenbbTickIo, fetched: Fetched): number => {
  if (!fetched.ok) throw new Error(fetched.error);
  for (const { table, rows } of fetched.document.tables)
    io.stdout.write(`${table}: ${rows.length} rows\n`);
  io.stdout.write(`warnings: ${fetched.document.warnings.length}\n`);
  const blocked = blockedOf(fetched.document);
  if (blocked !== null)
    io.stdout.write(`blocked: ${openbbBlockedError(blocked)}\n`);
  return 0;
};

/** Records a blocked_upstream run. Returns 0; throws on the first run of a later 7-day period. */
const recordBlocked = async (
  io: OpenbbTickIo,
  api: Api,
  run: Readonly<{
    blocked: Blocked;
    document: OpenbbBatchDocument;
    startedAt: Date;
    streak: BlockedStreak | null;
  }>
): Promise<number> => {
  const { document, streak } = run;
  const reason = openbbBlockedError(run.blocked);
  await call(io, api, "recordRun", {
    error: reason,
    finishedAt: io.now().toISOString(),
    job: document.job,
    openbbVersion: document.openbbVersion,
    rowsReceived: 0,
    rowsWritten: 0,
    startedAt: run.startedAt.toISOString(),
    status: "blocked_upstream",
    warnings: document.warnings,
  });
  io.stdout.write(`${document.job}: blocked_upstream, ${reason}\n`);
  if (streak !== null && passesEscalation(streak, run.startedAt))
    throw new Error(
      `${document.job} is blocked upstream for more than 7 days (${reason} since ${streak.since.toISOString()})`
    );
  return 0;
};

/** Posts the tables and records the run (ok, partial or failed). Throws when anything failed. */
const recordOutcome = async (
  io: OpenbbTickIo,
  api: Api,
  args: Arguments,
  fetched: Fetched,
  startedAt: Date
): Promise<number> => {
  const document = fetched.ok ? fetched.document : null;
  const outcome: Outcome =
    document === null
      ? { chunks: 0, errors: [], failedChunks: 0, received: 0, written: 0 }
      : await postTables(io, api, document);
  const status =
    document === null ? "failed" : statusOf(outcome, document.warnings.length);
  const error = [fetched.ok ? [] : [fetched.error], outcome.errors]
    .flat()
    .join("; ");
  await call(io, api, "recordRun", {
    error: error === "" ? null : truncateText(error, ERROR_MAX),
    finishedAt: io.now().toISOString(),
    job: args.job,
    openbbVersion: document?.openbbVersion ?? null,
    rowsReceived: outcome.received,
    rowsWritten: outcome.written,
    startedAt: startedAt.toISOString(),
    status,
    warnings: document?.warnings ?? [],
  });
  io.stdout.write(
    `${args.job}: ${status}, ${outcome.written} of ${outcome.received} rows written\n`
  );
  if (error !== "") throw new Error(error);
  return 0;
};

/** Runs one job and returns the process exit code (0 ok, partial with warnings only, or blocked). */
export const runOpenbbTick = async (io: OpenbbTickIo): Promise<number> => {
  let args: Arguments;
  try {
    args = parseArguments(io.argv);
    if (args.window !== null && !insideOpenbbWindow(args.window, io.now())) {
      io.stdout.write("skip: outside window\n");
      return 0;
    }
  } catch (error) {
    io.stderr.write(`openbb tick: ${messageOf(error)}\n`);
    return 2;
  }
  try {
    const api = args.dryRun ? null : apiOf(io.env);
    const { skip, streak } = await backoffOf(io, api, args.job);
    if (skip) return 0;
    const startedAt = io.now();
    const fetched = await fetchBatch(io, args);
    if (api === null) return printDryRun(io, fetched);
    const blocked = blockedOf(fetched.ok ? fetched.document : null);
    if (fetched.ok && blocked !== null)
      return await recordBlocked(io, api, {
        blocked,
        document: fetched.document,
        startedAt,
        streak,
      });
    return await recordOutcome(io, api, args, fetched, startedAt);
  } catch (error) {
    io.stderr.write(`openbb tick failed: ${messageOf(error)}\n`);
    return 1;
  }
};
