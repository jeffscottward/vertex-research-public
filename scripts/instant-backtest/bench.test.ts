import type {
  MarketBarColumns,
  MarketBarSeries,
  MarketBarsRepository,
} from "@darkfactory/db/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runInstantBacktestBench } from "./bench.ts";

const DAY_MS = 86_400_000;
const at = new Date("2026-10-18T12:00:00.000Z");

const fakes = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  createNodeDatabase: vi.fn(),
  createRepositories: vi.fn(),
}));

vi.mock("@darkfactory/db/server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createNodeDatabase: fakes.createNodeDatabase,
  createRepositories: fakes.createRepositories,
}));

const columns = (size: number): MarketBarColumns => {
  const close = Float64Array.from(
    { length: size },
    (_, index) => 100 + index * 0.05 + 10 * Math.sin(index / 40)
  );
  return {
    t: Float64Array.from({ length: size }, (_, index) => index * DAY_MS),
    o: close,
    h: close.map((value) => value + 1),
    l: close.map((value) => value - 1),
    c: close,
  };
};

const series = (symbol: string, importedAt = at): MarketBarSeries => ({
  id: `${symbol}:1d`,
  symbol,
  timeframe: "1d",
  source: "Synthetic benchmark bars",
  sourceSha256: "a".repeat(64),
  barCount: 600,
  firstT: 0,
  lastT: 599 * DAY_MS,
  importedAt,
});

const useRepository = (repository: Partial<MarketBarsRepository>) => {
  fakes.createRepositories.mockReturnValue({
    marketBars: {
      listSeries: vi.fn(async () => [series("AAA"), series("BBB")]),
      getSeries: vi.fn(async (symbol: string) => series(symbol)),
      loadColumns: vi.fn(async () => columns(600)),
      replaceSeries: vi.fn(),
      ...repository,
    },
  });
};

const run = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  bunVersion?: string
) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runInstantBacktestBench(argv, {
    env,
    bunVersion,
    stdout: { write: (text: string) => out.push(text) > 0 },
    stderr: { write: (text: string) => err.push(text) > 0 },
  });
  return { code, out: out.join(""), err: err.join("") };
};

const DATABASE = { DATABASE_URL: "postgresql://bench.test/db" };

beforeEach(() => {
  vi.clearAllMocks();
  fakes.createNodeDatabase.mockReturnValue({ db: {}, close: fakes.close });
  useRepository({});
});

describe("runInstantBacktestBench", () => {
  it("measures cold and warm runs for every stored series", async () => {
    const result = await run(["3"], DATABASE, "1.4.2");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as {
      runtime: string;
      runsPerCase: number;
      results: Array<{
        series: string;
        bars: number;
        cold: { samplesMs: number[]; medianMs: number; p95Ms: number };
        warm: { samplesMs: number[] };
      }>;
    };
    expect(report.runtime).toBe("bun 1.4.2");
    expect(report.runsPerCase).toBe(3);
    expect(report.results.map((entry) => entry.series)).toEqual([
      "AAA:1d",
      "BBB:1d",
    ]);
    const [first] = report.results;
    expect(first?.cold.samplesMs).toHaveLength(3);
    expect(first?.warm.samplesMs).toHaveLength(3);
    expect(first?.cold.p95Ms).toBe(Math.max(...(first?.cold.samplesMs ?? [])));
    expect(first?.cold.medianMs).toBe(
      [...(first?.cold.samplesMs ?? [])].sort((a, b) => a - b)[1]
    );
    expect(fakes.createNodeDatabase).toHaveBeenCalledWith({
      connectionString: DATABASE.DATABASE_URL,
    });
    expect(fakes.close).toHaveBeenCalledTimes(1);
  });

  it("uses the mean of the two middle samples for an even run count", async () => {
    const result = await run(["2"], DATABASE);
    const report = JSON.parse(result.out) as {
      runtime: string;
      results: Array<{ warm: { samplesMs: number[]; medianMs: number } }>;
    };
    expect(report.runtime).toBe("unknown");
    const warm = report.results[0]?.warm;
    const [a = 0, b = 0] = warm?.samplesMs ?? [];
    expect(warm?.medianMs).toBeCloseTo((a + b) / 2, 1);
  });

  it.each([
    [["0"], DATABASE, "runs must be an integer from 1 to 1000"],
    [["x"], DATABASE, "runs must be an integer from 1 to 1000"],
    [[], {}, "DATABASE_URL is required"],
    [["1"], { DATABASE_URL: "" }, "DATABASE_URL is required"],
  ])("rejects %j", async (argv, env, message) => {
    const result = await run(argv, env);
    expect(result.code).toBe(1);
    expect(result.err).toContain(message);
    expect(fakes.createNodeDatabase).not.toHaveBeenCalled();
  });

  it("fails when a warm run misses the bar cache and still closes the pool", async () => {
    let version = 0;
    useRepository({
      getSeries: vi.fn(async (symbol: string) => {
        version += 1;
        return series(symbol, new Date(at.getTime() + version));
      }),
    });
    const result = await run(["1"], DATABASE);
    expect(result.code).toBe(1);
    expect(result.err).toContain("warm run missed the bar cache");
    expect(fakes.close).toHaveBeenCalledTimes(1);
  });

  it("reports non-Error failures as text", async () => {
    fakes.createNodeDatabase.mockImplementationOnce(() => {
      throw "pool unavailable";
    });
    const result = await run(["1"], DATABASE);
    expect(result.err).toBe(
      "instant backtest benchmark failed: pool unavailable\n"
    );
  });
});
