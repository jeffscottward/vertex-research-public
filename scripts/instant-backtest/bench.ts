// Latency benchmark for the instant backtest on stored bars (research only; no orders).
// Usage: DATABASE_URL=... bun run vertex:instant-backtest:bench -- [runs=10] > result.json
// Calls instantBacktest.run through the real oRPC handler and the real Postgres repository,
// with an in-process operator session (no HTTP, no browser). For each stored series it measures:
//   cold: bar cache cleared before each run (series lookup + full bar load + engine + encoding);
//         Postgres and OS caches stay warm, so this is not a first read from disk
//   warm: bars cached; each run uses a different parameter set (engine + encoding)
// Prints JSON with every sample, the median and the p95 (nearest rank).
import {
  type ApiClient,
  createApiClient,
  type InstantBacktestRunInput,
} from "@darkfactory/api";
import {
  clearInstantBacktestCacheForTesting,
  createApiContext,
  handleApiRequest,
} from "@darkfactory/api/server";
import type { SafeAuthSession } from "@darkfactory/auth/server";
import { createNodeDatabase, createRepositories } from "@darkfactory/db/server";

const OPERATOR = "bench-operator@domain.test";
const now = new Date();
const session: SafeAuthSession = {
  user: {
    id: "bench-operator",
    name: "Benchmark operator",
    email: OPERATOR,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
    role: "member",
    status: "active",
  },
  session: {
    id: "bench-session",
    userId: "bench-operator",
    expiresAt: new Date(now.getTime() + 3_600_000),
    createdAt: now,
    updatedAt: now,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId: "bench-operator", role: "member", status: "active" },
};

// Every request in the benchmark is the same operator; role checks see the same session.
const authenticated = async (): Promise<SafeAuthSession> => session;

const percentile = (sorted: readonly number[], fraction: number): number =>
  sorted[
    Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
  ] as number;

const summarize = (samples: readonly number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    samplesMs: samples.map(round),
    medianMs: round(
      sorted.length % 2 === 1
        ? (sorted[(sorted.length - 1) / 2] as number)
        : ((sorted[sorted.length / 2 - 1] as number) +
            (sorted[sorted.length / 2] as number)) /
            2
    ),
    p95Ms: round(percentile(sorted, 0.95)),
  };
};

const timed = async (work: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await work();
  return performance.now() - started;
};

export type BenchIo = Readonly<{
  env: NodeJS.ProcessEnv;
  /** Bun version of the running process, when known. */
  bunVersion?: string | undefined;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}>;

const benchmark = async (
  argv: readonly string[],
  io: BenchIo
): Promise<string> => {
  const { env } = io;
  const runs = Number(argv[0] ?? "10");
  if (!Number.isInteger(runs) || runs < 1 || runs > 1000) {
    throw new Error("runs must be an integer from 1 to 1000");
  }
  const databaseUrl = env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is required");
  }
  const resource = createNodeDatabase({ connectionString: databaseUrl });
  const repositories = createRepositories(resource.db);
  const client: ApiClient = createApiClient({
    baseUrl: "https://bench.localhost",
    fetch: async (request: Request) =>
      await handleApiRequest(
        request,
        createApiContext(request, {
          repositories,
          requestId: "bench",
          capabilities: {
            ai: false,
            emailDelivery: false,
            analytics: false,
            telemetryExport: false,
          },
          requireSession: authenticated,
          requireRole: authenticated,
          operatorEmails: [OPERATOR],
        })
      ),
  });
  try {
    const { series } = await client.instantBacktest.series();
    const results: Record<string, unknown>[] = [];
    for (const entry of series) {
      const input = (fast: number): InstantBacktestRunInput => ({
        symbol: entry.symbol,
        timeframe: entry.timeframe,
        rule: { kind: "smaCross", fast, slow: 200 },
        stopLossPct: 10,
        takeProfitPct: 0,
        costBps: 2,
      });
      const breakout: InstantBacktestRunInput = {
        ...input(1),
        rule: {
          kind: "breakout",
          entryLookback: 20,
          exitLookback: 10,
          trendSma: 50,
        },
      };
      // One discarded run per series loads code paths before measurement starts.
      await client.instantBacktest.run(input(50));
      const cold: number[] = [];
      for (let index = 0; index < runs; index += 1) {
        clearInstantBacktestCacheForTesting();
        cold.push(await timed(() => client.instantBacktest.run(input(50))));
      }
      const warm: number[] = [];
      const warmCompute: number[] = [];
      for (let index = 0; index < runs; index += 1) {
        const started = performance.now();
        const output = await client.instantBacktest.run(
          index % 2 === 0 ? input(20 + index) : breakout
        );
        warm.push(performance.now() - started);
        if (output.timing.cache !== "hit") {
          throw new Error("warm run missed the bar cache");
        }
        warmCompute.push(output.timing.computeMs);
      }
      results.push({
        series: `${entry.symbol}:${entry.timeframe}`,
        bars: entry.barCount,
        cold: summarize(cold),
        warm: summarize(warm),
        warmEngineAndEncoding: summarize(warmCompute),
      });
    }
    return JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        runtime:
          io.bunVersion === undefined ? "unknown" : `bun ${io.bunVersion}`,
        runsPerCase: runs,
        percentile: "p95 nearest rank",
        results,
      },
      null,
      2
    );
  } finally {
    await resource.close();
  }
};

/** Runs the benchmark, prints JSON and returns the process exit code (0 on success). */
export const runInstantBacktestBench = async (
  argv: readonly string[],
  io: BenchIo
): Promise<number> => {
  try {
    io.stdout.write(`${await benchmark(argv, io)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `instant backtest benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
