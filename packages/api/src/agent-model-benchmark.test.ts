import { describe, expect, it } from "vitest";

import {
  armKeyOf,
  type BenchmarkBars,
  type BenchmarkRun,
  benchmarkPairTickers,
  computeBenchmark,
  forwardReturn,
  LOCAL_MODEL_FLAG,
  median,
  modalRating,
  NO_SERVED_MODEL,
  NO_VARIANT,
  ratingDirection,
  signTestP,
} from "./agent-model-benchmark.ts";
import {
  AGENT_MODEL_BENCHMARK_ARMS_MAX,
  AGENT_MODEL_BENCHMARK_BAR_TICKERS_MAX,
  AGENT_MODEL_BENCHMARK_MATRIX_ARMS_MAX,
  AgentModelBenchmarkInputSchema,
  AgentModelBenchmarkOutputSchema,
} from "./contracts/agent-model-runs.ts";

const run = (overrides: Partial<BenchmarkRun> = {}): BenchmarkRun => ({
  costUsd: 0.1,
  decisionDate: "2026-09-01",
  durationMs: null,
  flags: [],
  framework: "tradingagents",
  inputTokens: 100,
  llmCalls: 2,
  model: "A",
  modelsServed: [],
  outputTokens: 10,
  provider: "openai",
  rating: "hold",
  status: "succeeded",
  ticker: "AAPL",
  toolCalls: 3,
  variant: null,
  ...overrides,
});

const cell = (
  model: string,
  ticker: string,
  rating: BenchmarkRun["rating"],
  overrides: Partial<BenchmarkRun> = {}
) => run({ model, rating, ticker, ...overrides });

// Weekday bars from 2026-09-01 at UTC midnight with the given closes.
const WEEKDAYS = [
  "2026-09-01",
  "2026-09-02",
  "2026-09-03",
  "2026-09-04",
  "2026-09-07",
  "2026-09-08",
  "2026-09-09",
  "2026-09-10",
];
const barsOf = (closes: readonly number[]): BenchmarkBars => ({
  c: Float64Array.from(closes),
  t: Float64Array.from(
    closes.map((_, index) => Date.parse(`${WEEKDAYS[index]}T00:00:00.000Z`))
  ),
});

describe("benchmark primitives", () => {
  it("computes the exact two-sided sign test", () => {
    expect(signTestP(0, 0)).toBe(1);
    // m = 10, k = 1: 2 * (1 + 10) / 1024
    expect(signTestP(9, 1)).toBeCloseTo(0.021_484_375, 12);
    expect(signTestP(1, 9)).toBeCloseTo(0.021_484_375, 12);
    // m = 10, k = 0: 2 / 1024
    expect(signTestP(10, 0)).toBeCloseTo(0.001_953_125, 12);
    // m = 7, k = 1: 2 * (1 + 7) / 128
    expect(signTestP(6, 1)).toBeCloseTo(0.125, 12);
    // m = 20, k = 5: 2 * (1 + 20 + 190 + 1140 + 4845 + 15504) / 2^20
    expect(signTestP(15, 5)).toBeCloseTo((2 * 21_700) / 1_048_576, 12);
    expect(signTestP(1, 0)).toBe(1);
    expect(signTestP(5, 5)).toBe(1);
    const large = signTestP(3000, 2000);
    expect(large).toBeGreaterThanOrEqual(0);
    expect(large).toBeLessThan(1e-40);
    expect(signTestP(2500, 2500)).toBe(1);
  });

  it("picks the modal rating, ties nearest hold then bullish", () => {
    expect(modalRating([])).toBeNull();
    expect(modalRating(["sell", "sell", "buy"])).toBe("sell");
    expect(modalRating(["overweight", "underweight"])).toBe("overweight");
    expect(modalRating(["buy", "sell"])).toBe("buy");
    expect(modalRating(["buy", "hold"])).toBe("hold");
    expect(modalRating(["sell", "underweight"])).toBe("underweight");
  });

  it("maps ratings to a direction and takes medians", () => {
    expect(ratingDirection("buy")).toBe(1);
    expect(ratingDirection("overweight")).toBe(1);
    expect(ratingDirection("hold")).toBe(0);
    expect(ratingDirection("underweight")).toBe(-1);
    expect(ratingDirection("sell")).toBe(-1);
    expect(ratingDirection(null)).toBe(0);
    expect(median([])).toBeNull();
    expect(median([30, 10, 20])).toBe(20);
    expect(median([300, 100])).toBe(200);
  });

  it("names arms by each grouping", () => {
    const sample = run({
      model: "gpt-4o-mini",
      modelsServed: [
        { requested: "x", served: "b-2" },
        { requested: "y", served: "a-1" },
        { requested: "z", served: "b-2" },
      ],
      variant: "no-memory",
    });
    expect(armKeyOf(sample, "model")).toBe("gpt-4o-mini");
    expect(armKeyOf(sample, "provider_model")).toBe("openai:gpt-4o-mini");
    expect(armKeyOf(sample, "framework")).toBe("tradingagents");
    expect(armKeyOf(sample, "variant")).toBe("no-memory");
    expect(armKeyOf(sample, "servedModel")).toBe("a-1 + b-2");
    expect(armKeyOf(run(), "variant")).toBe(NO_VARIANT);
    expect(armKeyOf(run(), "servedModel")).toBe(NO_SERVED_MODEL);
    const long = run({
      modelsServed: Array.from({ length: 16 }, (_, index) => ({
        requested: "m",
        served: `${"s".repeat(40)}-${index}`,
      })),
    });
    expect(armKeyOf(long, "servedModel")).toHaveLength(400);
  });

  it("reads a forward return from the last bar on or before the decision date", () => {
    const bars = barsOf([100, 101, 102, 103, 104, 105, 106, 107]);
    expect(forwardReturn(bars, "2026-09-01")).toBeCloseTo(0.05, 12);
    expect(forwardReturn(bars, "2026-09-05", 2)).toBeCloseTo(105 / 103 - 1, 12);
    expect(forwardReturn(bars, "2026-09-05")).toBeNull();
    expect(forwardReturn(bars, "2026-08-31")).toBeNull();
    expect(forwardReturn(barsOf([0, 1, 1, 1, 1, 1]), "2026-09-01")).toBeNull();
    expect(forwardReturn(barsOf([1, 1, 1, 1, 1, 0]), "2026-09-01")).toBeNull();
    expect(forwardReturn(barsOf([]), "2026-09-01")).toBeNull();
  });
});

describe("benchmark arms and agreement", () => {
  // Baseline A has reruns; B is the arm under test; C is a local arm on another cell.
  const runs: BenchmarkRun[] = [
    cell("A", "AAPL", "underweight", { durationMs: 100 }),
    cell("A", "AAPL", "underweight", { durationMs: 300 }),
    cell("A", "MSFT", "overweight"),
    cell("A", "MSFT", "underweight"),
    cell("A", "NVDA", "hold"),
    cell("B", "AAPL", "sell", { costUsd: 0.5, durationMs: 10 }),
    cell("B", "AAPL", null, { durationMs: 20, status: "failed" }),
    cell("B", "MSFT", "overweight", {
      durationMs: 30,
      modelsServed: [{ requested: "B", served: "B-2026" }],
    }),
    cell("B", "MSFT", null),
    cell("B", "NVDA", "buy"),
    cell("C", "AMD", null, {
      costUsd: 0,
      flags: [LOCAL_MODEL_FLAG],
      status: "running",
    }),
  ];

  it("summarizes each arm and its agreement with the baseline", () => {
    const output = computeBenchmark(
      runs,
      { armBy: "model", baselineArm: "A" },
      new Map(),
      false
    );
    expect(AgentModelBenchmarkOutputSchema.parse(output)).toEqual(output);
    expect(output).toMatchObject({
      armBy: "model",
      armsTruncated: false,
      baselineArm: "A",
      cells: 4,
      pair: null,
      runCount: 11,
      truncated: false,
    });
    expect(output.arms.map((arm) => arm.key)).toEqual(["A", "B", "C"]);
    const [a, b, c] = output.arms;
    expect(a).toMatchObject({
      baseline: null,
      extremityShare: 0,
      medianDurationMs: 200,
      rated: 5,
      ratedCells: 3,
      // AAPL agrees; MSFT splits overweight/underweight (modal share 1/2).
      rerun: { allAgreeShare: 0.5, cells: 2, meanModalShare: 0.75 },
    });
    expect(b).toEqual({
      avgCostUsd: expect.closeTo(0.18, 12),
      // AAPL sell vs {underweight}: no match, distance 1; MSFT overweight in {overweight,
      // underweight}: match, 0; NVDA buy vs {hold}: no match, 2.
      baseline: { matchRate: 1 / 3, meanClosestDistance: 1, sharedCells: 3 },
      cells: 3,
      extremityShare: 2 / 3,
      failed: 1,
      finished: 4,
      inputTokens: 500,
      key: "B",
      llmCalls: 10,
      local: false,
      medianDurationMs: 20,
      outputTokens: 50,
      rated: 3,
      ratedCells: 3,
      ratingMix: { buy: 1, hold: 0, overweight: 1, sell: 1, underweight: 0 },
      rerun: { allAgreeShare: null, cells: 0, meanModalShare: null },
      runs: 5,
      servedModels: ["B-2026"],
      toolCalls: 15,
      totalCostUsd: expect.closeTo(0.9, 12),
      unrated: 1,
    });
    expect(c).toMatchObject({
      baseline: { matchRate: null, meanClosestDistance: null, sharedCells: 0 },
      extremityShare: null,
      finished: 0,
      local: true,
      medianDurationMs: null,
      ratedCells: 0,
      totalCostUsd: 0,
    });
    // Modal ratings: A = underweight, overweight, hold; B = sell, overweight, buy.
    expect(output.matrix.arms).toEqual(["A", "B", "C"]);
    expect(output.matrix.rows[0]).toEqual([
      { agreeShare: 1, sharedCells: 3 },
      { agreeShare: 1 / 3, sharedCells: 3 },
      { agreeShare: null, sharedCells: 0 },
    ]);
    expect(output.matrix.rows[1]?.[0]).toEqual({
      agreeShare: 1 / 3,
      sharedCells: 3,
    });
  });

  it("leaves the baseline out when it is unset or matches no arm", () => {
    for (const baselineArm of [undefined, "missing"]) {
      const output = computeBenchmark(
        runs,
        { armBy: "model", baselineArm },
        new Map(),
        true
      );
      expect(output.baselineArm).toBeNull();
      expect(output.truncated).toBe(true);
      expect(output.arms.every((arm) => arm.baseline === null)).toBe(true);
    }
  });

  it("caps the arm list and the matrix", () => {
    const many = Array.from(
      { length: AGENT_MODEL_BENCHMARK_ARMS_MAX + 1 },
      (_, index) => run({ model: `m-${String(index).padStart(3, "0")}` })
    );
    const output = computeBenchmark(many, { armBy: "model" }, new Map(), false);
    expect(output.arms).toHaveLength(AGENT_MODEL_BENCHMARK_ARMS_MAX);
    expect(output.armsTruncated).toBe(true);
    expect(output.arms[0]?.key).toBe("m-000");
    expect(output.matrix.arms).toHaveLength(
      AGENT_MODEL_BENCHMARK_MATRIX_ARMS_MAX
    );
    expect(output.matrix.rows[0]).toHaveLength(
      AGENT_MODEL_BENCHMARK_MATRIX_ARMS_MAX
    );
  });
});

describe("paired comparison", () => {
  const runs: BenchmarkRun[] = [
    // Both call down; AAPL rises: both miss (tie). Rating changed.
    cell("A", "AAPL", "underweight", { costUsd: 1, durationMs: 50 }),
    cell("B", "AAPL", "sell", { costUsd: 2, durationMs: 70 }),
    // Both call up; MSFT falls: both miss (tie). Same rating.
    cell("A", "MSFT", "overweight"),
    cell("B", "MSFT", "overweight", { status: "failed" }),
    cell("B", "MSFT", "overweight"),
    // A holds: no call.
    cell("A", "NVDA", "hold"),
    cell("B", "NVDA", "buy"),
    // A up, B down; TSLA falls: B wins.
    cell("A", "TSLA", "buy"),
    cell("B", "TSLA", "sell"),
    // AMD bars too short for a 5-day return.
    cell("A", "AMD", "sell"),
    cell("B", "AMD", "overweight"),
    // META has no bars at all.
    cell("A", "META", "buy"),
    cell("B", "META", "buy"),
    // Only A finished on ORCL: not shared.
    cell("A", "ORCL", "buy"),
    cell("B", "ORCL", null, { status: "failed" }),
    // Only B on IBM: not shared.
    cell("B", "IBM", "buy"),
  ];
  const rising = barsOf([100, 101, 102, 103, 104, 105, 106, 107]);
  const falling = barsOf([107, 106, 105, 104, 103, 102, 101, 100]);
  const bars = new Map<string, BenchmarkBars>([
    ["AAPL", rising],
    ["MSFT", falling],
    ["TSLA", falling],
    ["AMD", barsOf([1, 2, 3])],
  ]);

  it("lists the tickers whose bars are needed", () => {
    expect(
      benchmarkPairTickers(runs, {
        armBy: "model",
        pair: { control: "A", treatment: "B" },
      })
    ).toEqual(["AAPL", "AMD", "META", "MSFT", "NVDA", "TSLA"]);
    expect(benchmarkPairTickers(runs, { armBy: "model" })).toEqual([]);
    expect(
      benchmarkPairTickers(runs, {
        armBy: "model",
        pair: { control: "A", treatment: "Z" },
      })
    ).toEqual([]);
  });

  it("counts wins, losses, ties and exclusions with the sign test", () => {
    const output = computeBenchmark(
      runs,
      { armBy: "model", pair: { control: "A", treatment: "B" } },
      bars,
      false
    );
    expect(output.pair).toEqual({
      changedRating: 4,
      compared: 3,
      control: "A",
      controlArm: {
        hits: 0,
        medianDurationMs: 50,
        runs: 6,
        totalCostUsd: expect.closeTo(1.5, 12),
        totalTokens: 660,
      },
      excludedNoBars: 2,
      excludedNoCall: 1,
      forwardDays: 5,
      losses: 0,
      sharedCells: 6,
      signTestP: 1,
      tickersOverCap: [],
      tickersWithoutBars: ["META"],
      ties: 2,
      treatment: "B",
      treatmentArm: {
        hits: 1,
        medianDurationMs: 70,
        runs: 7,
        totalCostUsd: expect.closeTo(2.6, 12),
        totalTokens: 770,
      },
      wins: 1,
    });
  });

  it("scores a control win and an empty pair", () => {
    const output = computeBenchmark(
      [
        cell("A", "TSLA", "sell"),
        cell("B", "TSLA", "buy"),
        cell("A", "AMD", "buy"),
        cell("B", "AMD", "hold"),
      ],
      { armBy: "model", pair: { control: "A", treatment: "B" } },
      bars,
      false
    );
    expect(output.pair).toMatchObject({
      excludedNoCall: 1,
      losses: 1,
      signTestP: 1,
      wins: 0,
    });
    const empty = computeBenchmark(
      runs,
      { armBy: "model", pair: { control: "X", treatment: "Y" } },
      bars,
      false
    );
    expect(empty.pair).toMatchObject({
      compared: 0,
      controlArm: { medianDurationMs: null, runs: 0 },
      sharedCells: 0,
      signTestP: 1,
    });
  });
});

describe("paired comparison past the bar ticker cap", () => {
  it("names the tickers whose bars were not loaded apart from tickers without bars", () => {
    const tickers = Array.from(
      { length: AGENT_MODEL_BENCHMARK_BAR_TICKERS_MAX + 2 },
      (_, index) => `T${String(index).padStart(3, "0")}`
    );
    const runs = tickers.flatMap((ticker) => [
      cell("A", ticker, "buy"),
      cell("B", ticker, "sell"),
    ]);
    const options = {
      armBy: "model" as const,
      pair: { control: "A", treatment: "B" },
    };
    const loaded = benchmarkPairTickers(runs, options).slice(
      0,
      AGENT_MODEL_BENCHMARK_BAR_TICKERS_MAX
    );
    // The server loads the first 50; T000 has none.
    const bars = new Map<string, BenchmarkBars>(
      loaded
        .slice(1)
        .map((ticker) => [ticker, barsOf([100, 101, 102, 103, 104, 105, 106])])
    );
    const output = computeBenchmark(runs, options, bars, false);
    expect(output.pair).toMatchObject({
      compared: AGENT_MODEL_BENCHMARK_BAR_TICKERS_MAX - 1,
      excludedNoBars: 3,
      tickersOverCap: ["T050", "T051"],
      tickersWithoutBars: ["T000"],
    });
  });
});

describe("benchmark input", () => {
  it("validates arms, the pair and the date order", () => {
    expect(
      AgentModelBenchmarkInputSchema.parse({
        armBy: "provider_model",
        batch: "grid-1",
        pair: { control: "a", treatment: "b" },
      })
    ).toMatchObject({ armBy: "provider_model" });
    for (const bad of [
      { armBy: "ticker" },
      { armBy: "model", pair: { control: "a", treatment: "a" } },
      { armBy: "model", decisionFrom: "2026-09-02", decisionTo: "2026-09-01" },
      { armBy: "model", extra: 1 },
    ])
      expect(AgentModelBenchmarkInputSchema.safeParse(bad).success).toBe(false);
  });
});
