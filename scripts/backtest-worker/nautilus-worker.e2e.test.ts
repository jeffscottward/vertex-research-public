import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COST_PROFILE_PRESETS } from "../../packages/api/src/backtest-costs.ts";
import { buildBacktestRunReport } from "../../packages/api/src/backtest-run-report.ts";
import {
  BACKTEST_RUN_NAUTILUS_ENGINE,
  BacktestRunEngineCompleteManyInputSchema,
} from "../../packages/api/src/contracts/backtest-runs.ts";
import {
  barsInPositionOf,
  type InstantRunResult,
  runInstantBacktest,
  summarize,
} from "../../packages/api/src/instant-backtest-engine.ts";
import { engineStatsMismatch } from "../../packages/api/src/server/backtest-run-engine.ts";
import {
  type NautilusWorkerIo,
  runCommand,
  runNautilusWorker,
  sleep,
} from "./nautilus-worker.ts";

// End to end with the real engine: the worker runs `python -m nautilus_backtest batch - -` from
// VERTEX_NAUTILUS_PYTHON (a venv with services/research/requirements-nautilus-linux-py312.lock),
// in two engine processes, against an in-process fake API that hands out one batch. The fake API
// checks the posted items with the contract schema, recomputes the stats as the API does and
// builds the report with the API code. Without VERTEX_NAUTILUS_PYTHON the suite does not run (the
// base CI lane has no Nautilus; the Python Nautilus lane covers the engine itself).

const python = process.env["VERTEX_NAUTILUS_PYTHON"]?.trim() || undefined;
const DAY_MS = 86_400_000;
const SIZE = 400;
const SHA = "b".repeat(64);

const close = Array.from(
  { length: SIZE },
  (_, index) => 100 + index * 0.05 + 10 * Math.sin(index / 20)
);
const bars = {
  c: close,
  h: close.map((value) => value + 1),
  l: close.map((value) => value - 1),
  o: close.map(
    (value, index) => (index === 0 ? value : close[index - 1]) as number
  ),
  t: close.map((_, index) => index * DAY_MS),
};
const columns = {
  c: Float64Array.from(bars.c),
  h: Float64Array.from(bars.h),
  l: Float64Array.from(bars.l),
  o: Float64Array.from(bars.o),
  t: Float64Array.from(bars.t),
};
const profile = COST_PROFILE_PRESETS["ibkr-pro-fixed-us-stock"];
const spec = {
  costBps: 5,
  costProfile: profile,
  from: "1970-01-01",
  initialCapital: 50_000,
  rule: { fast: 5, kind: "smaCross" as const, slow: 30 },
  stopLossPct: 3,
  symbol: "SPY",
  takeProfitPct: 6,
  timeframe: "1d" as const,
  to: "1971-02-04",
};

const fakeApi = (runs: readonly unknown[]) => {
  const queue = [...runs];
  const posted: { path: string; input: unknown }[] = [];
  const post = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname.replace("/api/orpc/", "");
    const input = (JSON.parse(String(init.body)) as { json: unknown }).json;
    posted.push({ input, path });
    if (path.endsWith("/claim"))
      return Response.json({
        json: { batch: queue.shift() ?? null, run: null },
      });
    const items = (input as { items: { id: string; error?: string }[] }).items;
    return Response.json({
      json: {
        outcomes: items.map((item) => ({
          id: item.id,
          status: item.error === undefined ? "succeeded" : "failed",
        })),
      },
    });
  };
  return { post, posted };
};

const ioFor = (post: NautilusWorkerIo["post"]): NautilusWorkerIo => ({
  env: {
    VERTEX_AGENT_API_KEY: "test-key",
    VERTEX_NAUTILUS_PYTHON: python,
    VERTEX_ORIGIN: "https://vertex.example.test",
    VERTEX_WORKER_PAUSE_FILE: "/nonexistent/vertex-nautilus-worker.pause",
    VERTEX_WORKER_RESTART_LOCK: "/nonexistent/vertex-web-restart.lock",
    VERTEX_WORKER_PROCESSES: "2",
  },
  fileAgeMs: () => null,
  restartLock: async () => "free",
  hostname: "rig-test",
  post,
  researchDir: fileURLToPath(
    new URL("../../services/research/", import.meta.url)
  ),
  runCommand,
  signal: new AbortController().signal,
  sleep,
  stderr: { write: () => undefined },
  stdout: { write: () => undefined },
});

describe.skipIf(python === undefined)(
  "nautilus worker with the real engine",
  () => {
    it("posts a result that passes the contract and builds the same trades as the API engine", {
      timeout: 120_000,
    }, async () => {
      const costs = { capital: spec.initialCapital, profile };
      const api = fakeApi([
        {
          bars,
          runs: [
            {
              costs,
              end: SIZE,
              first: 0,
              id: "run-1",
              sectorQuadrants: null,
              spec,
            },
            // The second half of the bars, in the other engine process.
            {
              costs,
              end: SIZE,
              first: SIZE / 2,
              id: "run-2",
              sectorQuadrants: null,
              spec,
            },
          ],
          seriesSha256: SHA,
        },
      ]);
      expect(await runNautilusWorker(["--once"], ioFor(api.post))).toBe(0);
      const complete = api.posted.find((call) =>
        call.path.endsWith("/completeMany")
      );
      const many = BacktestRunEngineCompleteManyInputSchema.parse(
        complete?.input
      );
      expect(many.engine).toBe(BACKTEST_RUN_NAUTILUS_ENGINE);
      const [input, half] = many.items;
      if (
        input === undefined ||
        !("result" in input) ||
        "kind" in input.result ||
        half === undefined ||
        !("result" in half)
      )
        throw new Error("expected two equity results");
      expect(input).toMatchObject({ id: "run-1", seriesSha256: SHA });
      expect(input.result.equity).toHaveLength(SIZE);
      expect(half.result.equity).toHaveLength(SIZE / 2);
      expect(input.engineRun).toMatchObject({
        gpu: "not used (Nautilus engine is CPU-only)",
        host: "rig-test",
        processCases: 1,
        processes: 2,
      });
      expect(input.engineRun?.cpuMs).toBeGreaterThan(0);
      expect(input.engineRun?.wallMs).toBeGreaterThan(0);

      // The API recomputes the stats from the equity and trades; Nautilus must agree.
      const equity = Float64Array.from(input.result.equity);
      const trades = input.result.trades as InstantRunResult["trades"];
      const stats = summarize(
        columns,
        equity,
        trades,
        barsInPositionOf(trades)
      );
      expect(engineStatsMismatch(input.result.stats, stats)).toBeNull();
      expect(
        new Set(trades.map((trade) => trade.exitReason)).size
      ).toBeGreaterThan(1);

      const report = buildBacktestRunReport(
        columns,
        { equity, stats, trades },
        spec.initialCapital,
        profile
      );
      expect(report.bars).toBe(SIZE);
      expect(report.metrics.totalTrades).toBeGreaterThan(0);
      expect(report.costs?.profileId).toBe(profile.id);

      const typescript = runInstantBacktest(columns, {
        costBps: spec.costBps,
        costs: { capital: spec.initialCapital, profile },
        rule: spec.rule,
        stopLossPct: spec.stopLossPct,
        takeProfitPct: spec.takeProfitPct,
      });
      const shape = (
        trades: readonly Readonly<{
          entryIndex: number;
          exitIndex: number;
          exitReason: string;
        }>[]
      ) =>
        trades.map(({ entryIndex, exitIndex, exitReason }) => ({
          entryIndex,
          exitIndex,
          exitReason,
        }));
      expect(shape(input.result.trades)).toEqual(shape(typescript.trades));
    });

    it("fails a run with the engine input error message", {
      timeout: 120_000,
    }, async () => {
      const api = fakeApi([
        {
          bars,
          runs: [
            {
              costs: null,
              end: 1,
              first: 0,
              id: "run-1",
              sectorQuadrants: null,
              spec: { ...spec, costProfile: undefined },
            },
          ],
          seriesSha256: SHA,
        },
      ]);
      expect(await runNautilusWorker(["--once"], ioFor(api.post))).toBe(0);
      expect(api.posted.at(-1)).toEqual({
        input: {
          engine: BACKTEST_RUN_NAUTILUS_ENGINE,
          items: [{ error: "At least 2 bars needed", id: "run-1" }],
        },
        path: "backtestRuns/engine/completeMany",
      });
    });
  }
);
