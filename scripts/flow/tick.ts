// Flow pipeline tick client for the scheduler (QuantVPS timer, every minute; research only, no orders).
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... bun run vertex:flow:tick [--dry-run] [--seed]
// It calls flow.collect with an operator agent WRITE key. The server decides which sources are due,
// samples IBKR ticks and depth inside the shared historical budget and QuantData options flow and GEX,
// and stores features and events. --dry-run fetches and computes only: nothing is stored. --seed is an
// operator backfill (ignores sessions and due times, options look-back 72 h; IBKR budget checks still
// apply), so a closed market shows its last session. Each run
// prints one line per symbol and source (the journal is the record of IBKR sampling), then one budget
// line: free QuantData starts beyond the caller reserve, the IBKR window and the run time. The key is
// never printed. Doc: docs/vertex-rebuild/flow-pipeline.md.

import { z } from "zod";

import { checkConnectivityAlertsNow } from "../connectivity/tick.ts";

export type FlowTickIo = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  post: (url: string, init: RequestInit) => Promise<Response>;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
}>;

const CollectSchema = z.object({
  json: z.object({
    at: z.string(),
    // Optional, so the script also works against the previous app after a rollback.
    budget: z
      .object({
        ibkrLimit: z.number(),
        ibkrRecent: z.number().nullable(),
        quantDataFree: z.number().nullable(),
        quantDataReserve: z.number(),
        runSeconds: z.number(),
      })
      .optional(),
    busy: z.boolean(),
    pruned: z.number(),
    runs: z.array(
      z.object({
        events: z.number(),
        items: z.number(),
        message: z.string().nullable(),
        source: z.string(),
        status: z.string(),
        symbol: z.string(),
      })
    ),
  }),
});

/**
 * The web app restarting (restart-when-idle deploys) or a gateway hiccup: the next minute's run
 * retries, so the unit should not be marked failed (each failed QuantVPS unit opens a card).
 */
class TransientError extends Error {}
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const AUTH_FAILURE_PATTERN =
  /\bHTTP\s+(?:401|403)\b|\b(authentication failed|access forbidden|unauthorized)\b/iu;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const required = (
  env: FlowTickIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
};

type TickResult = Readonly<{
  exitCode: number;
  lines: string[];
}>;

const tick = async (io: FlowTickIo): Promise<TickResult> => {
  const unknown = io.argv.filter(
    (argument) => argument !== "--dry-run" && argument !== "--seed"
  );
  if (unknown.length > 0)
    throw new Error(`unknown argument: ${unknown.join(" ")}`);
  const apiKey = required(io.env, "VERTEX_AGENT_API_KEY");
  const origin = new URL(required(io.env, "VERTEX_ORIGIN")).origin;
  const response = await io
    .post(`${origin}/api/orpc/flow/collect`, {
      body: JSON.stringify({
        json: {
          dryRun: io.argv.includes("--dry-run"),
          seed: io.argv.includes("--seed"),
        },
      }),
      headers: {
        "content-type": "application/json",
        origin,
        "x-api-key": apiKey,
      },
      method: "POST",
    })
    .catch((error: unknown) => {
      throw new TransientError(`flow.collect unreachable: ${messageOf(error)}`);
    });
  const text = await response.text();
  if (TRANSIENT_STATUSES.has(response.status))
    throw new TransientError(
      `flow.collect returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  if (!response.ok)
    throw new Error(
      `flow.collect returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `flow.collect returned a body that is not JSON: ${text.slice(0, 300)}`
    );
  }
  const parsed = CollectSchema.safeParse(body);
  if (!parsed.success)
    throw new Error(
      `flow.collect returned an unexpected shape: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  const dryRun = io.argv.includes("--dry-run");
  const { at, budget, busy, pruned, runs } = parsed.data.json;
  if (busy)
    return {
      exitCode: 0,
      lines: [`flow collect ${at}: another run is still active; skipped`],
    };
  const lines = [
    `flow collect ${at}: ${runs.length} run(s), pruned ${pruned}`,
    ...runs
      .filter(
        (run) => run.status !== "skipped" || run.message !== "market closed"
      )
      .map(
        (run) =>
          `${run.symbol} ${run.source} ${run.status} items=${run.items} events=${run.events}${run.message ? ` ${run.message}` : ""}`
      ),
    ...(budget === undefined
      ? []
      : [
          `budget quantdata_free=${budget.quantDataFree ?? "unread"} reserve=${budget.quantDataReserve} ibkr=${budget.ibkrRecent ?? "unread"}/${budget.ibkrLimit} run=${budget.runSeconds}s`,
        ]),
  ];
  const unavailable = runs.filter((run) => run.status === "unavailable");
  if (unavailable.length === 0 || dryRun) {
    return { exitCode: 0, lines };
  }
  const authFailures = unavailable.filter(
    (run) => run.message !== null && AUTH_FAILURE_PATTERN.test(run.message)
  );
  for (const run of authFailures) {
    io.stderr.write(
      `flow tick auth failure: ${run.symbol} ${run.source}: ${run.message}\n`
    );
  }
  let alertDelivered = false;
  try {
    const checked = await checkConnectivityAlertsNow(
      io,
      { apiKey, origin },
      false
    );
    alertDelivered = checked.delivered;
  } catch (error) {
    io.stderr.write(`flow tick alert check failed: ${messageOf(error)}\n`);
  }
  // Never exit 0 silently when an auth/credential failure occurred and no alert channel delivered it.
  const exitCode = authFailures.length > 0 && !alertDelivered ? 1 : 0;
  return { exitCode, lines };
};

/** Runs one collection and returns the process exit code (0 on success). */
export const runFlowTick = async (io: FlowTickIo): Promise<number> => {
  try {
    const result = await tick(io);
    for (const line of result.lines) io.stdout.write(`${line}\n`);
    return result.exitCode;
  } catch (error) {
    if (error instanceof TransientError) {
      io.stderr.write(
        `flow tick skipped (retries next run): ${error.message}\n`
      );
      return 0;
    }
    io.stderr.write(`flow tick failed: ${messageOf(error)}\n`);
    return 1;
  }
};
