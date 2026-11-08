// Flow pipeline tick client for the scheduler (QuantVPS timer, every minute; research only, no orders).
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... bun run vertex:flow:tick [--dry-run] [--seed]
// It calls flow.collect with an operator agent WRITE key. The server decides which sources are due,
// samples IBKR ticks and depth inside the shared historical budget and QuantData options flow and GEX,
// and stores features and events. --dry-run fetches and computes only: nothing is stored. --seed is an
// operator backfill (ignores sessions and due times, options look-back 72 h; IBKR budget checks still
// apply), so a closed market shows its last session. Each run
// prints one line per symbol and source (the journal is the record of IBKR sampling). The key is
// never printed. Doc: docs/vertex-rebuild/flow-pipeline.md.

import { z } from "zod";

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

const required = (
  env: FlowTickIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
};

const tick = async (io: FlowTickIo): Promise<string[]> => {
  const unknown = io.argv.filter(
    (argument) => argument !== "--dry-run" && argument !== "--seed"
  );
  if (unknown.length > 0)
    throw new Error(`unknown argument: ${unknown.join(" ")}`);
  const apiKey = required(io.env, "VERTEX_AGENT_API_KEY");
  const origin = new URL(required(io.env, "VERTEX_ORIGIN")).origin;
  const response = await io.post(`${origin}/api/orpc/flow/collect`, {
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
  });
  const text = await response.text();
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
  const { at, busy, pruned, runs } = parsed.data.json;
  if (busy) return [`flow collect ${at}: another run is still active; skipped`];
  return [
    `flow collect ${at}: ${runs.length} run(s), pruned ${pruned}`,
    ...runs
      .filter(
        (run) => run.status !== "skipped" || run.message !== "market closed"
      )
      .map(
        (run) =>
          `${run.symbol} ${run.source} ${run.status} items=${run.items} events=${run.events}${run.message ? ` ${run.message}` : ""}`
      ),
  ];
};

/** Runs one collection and returns the process exit code (0 on success). */
export const runFlowTick = async (io: FlowTickIo): Promise<number> => {
  try {
    for (const line of await tick(io)) io.stdout.write(`${line}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `flow tick failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
