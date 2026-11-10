// Builds the step-4 "current engine vs Nautilus" report page (research only; no orders).
// Usage: VERTEX_ORIGIN=https://<portal> VERTEX_AGENT_KEY_FILE=<operator read key file> \
//   bun run vertex:engine-comparison-report -- --out <dir> [--limit 500] [--no-journal]
// Read-only: calls backtestRuns.comparisons.list (per feature), backtestRuns.list and
// backtestRuns.get with an operator agent key (read access is enough) and reads the research
// worker's journal for outages. Writes <dir>/index.html and nothing else. The key is never printed.
import { z } from "zod";

import { BACKTEST_RUN_LIST_MAX } from "../../packages/api/src/contracts/backtest-runs.ts";
import {
  ENGINE_COMPARISON_FEATURES,
  ENGINE_COMPARISON_LIST_MAX,
  type EngineComparisonFeature,
  EngineRunSchema,
} from "../../packages/api/src/contracts/engine-comparison.ts";
import {
  buildModel,
  type ComparisonRow,
  ComparisonRowSchema,
  type JournalEntry,
  type NautilusRun,
} from "./model.ts";
import { renderReport } from "./render.ts";
import { RIG_BENCHMARK_2026_11_06 } from "./rig-benchmark-2026-11-06.ts";

export const WORKER_UNIT = "vertex-nautilus-worker.service";
export const SNAPSHOT_DIR = "snapshot-2026-11-06";
const API_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

export type ReportIo = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  exists: (path: string) => Promise<boolean>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
  /** journalctl -o json lines of the unit since the ISO time. */
  readJournal: (unit: string, sinceIso: string) => Promise<string>;
  readText: (path: string) => Promise<string>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  /** Writes the file whole (the caller's implementation replaces it atomically). */
  writeText: (path: string, text: string) => Promise<void>;
}>;

export type ReportArgs = Readonly<{
  journal: boolean;
  limit: number;
  out: string;
}>;

export const parseArgs = (argv: readonly string[]): ReportArgs => {
  let out: string | undefined;
  let limit = ENGINE_COMPARISON_LIST_MAX;
  let journal = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-journal") journal = false;
    else if (arg === "--out" || arg === "--limit") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      if (arg === "--out") out = value;
      else {
        limit = Number(value);
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > ENGINE_COMPARISON_LIST_MAX
        )
          throw new Error(`--limit must be 1 to ${ENGINE_COMPARISON_LIST_MAX}`);
      }
    } else if (arg !== "--") throw new Error(`unknown argument ${arg}`);
  }
  if (out === undefined) throw new Error("--out <dir> is required");
  return { journal, limit, out };
};

const apiKey = async (io: ReportIo): Promise<string> => {
  const direct = io.env["VERTEX_AGENT_API_KEY"]?.trim();
  if (direct !== undefined && direct !== "") return direct;
  const file = io.env["VERTEX_AGENT_KEY_FILE"];
  if (file === undefined || file === "")
    throw new Error(
      "set VERTEX_AGENT_KEY_FILE (or VERTEX_AGENT_API_KEY) to an operator agent key"
    );
  const key = (await io.readText(file)).trim();
  if (key === "") throw new Error("the agent key file is empty");
  return key;
};

const ResponseSchema = z.object({ json: z.unknown() });

const RunListSchema = z.object({
  runs: z.array(
    z.object({
      createdAt: z.string(),
      engineVersion: z.string(),
      error: z.string().nullable(),
      finishedAt: z.string().nullable(),
      id: z.string(),
      spec: z.object({
        comparison: z.unknown().optional(),
        from: z.string(),
        symbol: z.string(),
        to: z.string(),
      }),
      startedAt: z.string().nullable(),
      status: z.string(),
      strategySnapshot: z.object({ name: z.string() }).nullable(),
    })
  ),
});

const RunGetSchema = z.object({
  report: z.object({ engineRun: EngineRunSchema.optional() }).nullable(),
});

/** Parses journalctl -o json lines; lines without a text message are skipped. */
export const parseJournal = (text: string): JournalEntry[] =>
  text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    const entry = z
      .object({ __REALTIME_TIMESTAMP: z.string(), MESSAGE: z.unknown() })
      .safeParse(JSON.parse(line));
    if (!entry.success || typeof entry.data.MESSAGE !== "string") return [];
    return [
      {
        at: Number(entry.data.__REALTIME_TIMESTAMP) / 1000,
        message: entry.data.MESSAGE,
      },
    ];
  });

const build = async (args: ReportArgs, io: ReportIo): Promise<string> => {
  const originText = io.env["VERTEX_ORIGIN"];
  if (originText === undefined || originText === "")
    throw new Error("set VERTEX_ORIGIN to the portal origin");
  const origin = new URL(originText).origin;
  const key = await apiKey(io);
  const call = async (path: string, input: unknown): Promise<unknown> => {
    const response = await io.fetch(`${origin}/api/orpc/${path}`, {
      body: JSON.stringify({ json: input }),
      headers: { "content-type": "application/json", origin, "x-api-key": key },
      method: "POST",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `${path} returned HTTP ${response.status}: ${text.slice(0, 200)}`
      );
    return ResponseSchema.parse(JSON.parse(text)).json;
  };
  const comparisons: Partial<Record<EngineComparisonFeature, ComparisonRow[]>> =
    {};
  for (const feature of ENGINE_COMPARISON_FEATURES) {
    comparisons[feature] = z
      .object({ runs: z.array(ComparisonRowSchema) })
      .parse(
        await call("backtestRuns/comparisons/list", {
          feature,
          limit: args.limit,
        })
      ).runs;
  }
  const listed = RunListSchema.parse(
    await call("backtestRuns/list", { limit: BACKTEST_RUN_LIST_MAX })
  ).runs.filter(
    (run) =>
      run.engineVersion.startsWith("nautilus") &&
      run.spec.comparison === undefined
  );
  const nautilusRuns: NautilusRun[] = [];
  for (const run of listed) {
    const detail = RunGetSchema.parse(
      await call("backtestRuns/get", { id: run.id })
    );
    nautilusRuns.push({
      createdAt: run.createdAt,
      engineRun: detail.report?.engineRun ?? null,
      error: run.error,
      finishedAt: run.finishedAt,
      from: run.spec.from,
      id: run.id,
      label: run.strategySnapshot?.name ?? "-",
      startedAt: run.startedAt,
      status: run.status,
      symbol: run.spec.symbol,
      to: run.spec.to,
    });
  }
  let entries: JournalEntry[] = [];
  let journalRead = false;
  if (args.journal) {
    const since = new Date(
      Date.parse(RIG_BENCHMARK_2026_11_06.measuredAt) - DAY_MS
    ).toISOString();
    try {
      entries = parseJournal(await io.readJournal(WORKER_UNIT, since));
      journalRead = true;
    } catch (error) {
      io.stderr.write(
        `engine comparison report: worker journal not read (${error instanceof Error ? error.message : String(error)}); using the recorded outages only\n`
      );
    }
  }
  const model = buildModel({
    benchmark: RIG_BENCHMARK_2026_11_06,
    comparisons,
    generatedAt: io.now(),
    journal: { entries, read: journalRead },
    limit: args.limit,
    nautilusRuns,
  });
  const snapshot = (await io.exists(`${args.out}/${SNAPSHOT_DIR}/index.html`))
    ? { snapshotHref: `${SNAPSHOT_DIR}/` }
    : {};
  const pagePath = `${args.out}/index.html`;
  await io.writeText(pagePath, renderReport(model, snapshot));
  const total = model.features.reduce((sum, feature) => sum + feature.runs, 0);
  return `wrote ${pagePath}: ${total} comparison runs, ${nautilusRuns.length} Nautilus runs, ${model.outages.length} outage(s)`;
};

/** Builds the page and returns the process exit code (0 on success). */
export const runEngineComparisonReport = async (
  argv: readonly string[],
  io: ReportIo
): Promise<number> => {
  try {
    io.stdout.write(`${await build(parseArgs(argv), io)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `engine comparison report failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
