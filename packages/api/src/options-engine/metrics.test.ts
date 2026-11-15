import { describe, expect, it } from "vitest";
import type { LedgerResult, TradeRecord } from "./ledger.ts";
import {
  deflatedSharpeRatio,
  deflatedStats,
  expectedMaxSharpe,
  moments,
  normalCdf,
  normalInvCdf,
  summarize,
  worstMonth,
} from "./metrics.ts";

// Expected values: CPython 3.12 statistics.NormalDist, backtesting/optimizer.py and qc_ports/metrics.py.
const ledger = (
  dates: string[],
  equity: number[],
  openPositions: number[],
  pnls: number[] = []
): LedgerResult => ({
  capital: 100,
  dates,
  engine: "qc-ports-ledger",
  equity,
  openPositions,
  skipped: [],
  trades: pnls.map((pnl) => ({ pnl }) as TradeRecord),
});

describe("normal distribution", () => {
  it("matches NormalDist cdf and inv_cdf in every AS241 region", () => {
    expect([0, 1.5, -4].map(normalCdf)).toEqual([
      0.5, 0.933_192_798_731_141_9, 3.167_124_183_311_998e-5,
    ]);
    expect([0.5, 0.3, 0.05, 1e-20, 0.999_999].map(normalInvCdf)).toEqual([
      0, -0.524_400_512_708_040_7, -1.644_853_626_951_472_6,
      -9.262_340_089_798_405, 4.753_424_308_817_089,
    ]);
    for (const p of [0, 1, Number.NaN])
      expect(() => normalInvCdf(p)).toThrow(
        "p must be in the range 0.0 < p < 1.0"
      );
  });
});

describe("deflated Sharpe", () => {
  it("matches optimizer.deflated_sharpe_ratio", () => {
    expect(expectedMaxSharpe(10, 0.01)).toBe(0.157_459_830_134_575);
    const result = deflatedSharpeRatio(0.1, 10, 0.01, 250);
    expect([
      result.z,
      result.probability,
      result.expectedMaxSharpe,
      result.skew,
      result.kurtosis,
    ]).toEqual([
      -0.904_442_538_895_446_3, 0.182_880_395_179_357_72, 0.157_459_830_134_575,
      0, 3,
    ]);
  });

  it("refuses the inputs optimizer.py refuses", () => {
    expect(() => expectedMaxSharpe(1, 0.01)).toThrow(
      "Need at least two trials"
    );
    expect(() => expectedMaxSharpe(2.5, 0.01)).toThrow(
      "Need at least two trials"
    );
    expect(() => expectedMaxSharpe(10, -1)).toThrow(
      "Sharpe variance must be >= 0"
    );
    expect(() => deflatedSharpeRatio(0.1, 10, 0.01, 1)).toThrow(
      "Need at least two observations"
    );
    expect(() => deflatedSharpeRatio(Number.NaN, 10, 0.01, 100)).toThrow(
      "DSR inputs must be finite"
    );
    expect(() => deflatedSharpeRatio(0.5, 10, 0.01, 100, 10, 3)).toThrow(
      "Non-positive Sharpe standard error term"
    );
  });

  it("is null without observations, with a bad radicand or a bad trial variance", () => {
    const none = { deflatedSharpe: null, expectedMaxSharpe: null };
    expect(deflatedStats(0.1, 1, null, 1, 0, 3)).toEqual({
      ...none,
      sharpeVariance: null,
    });
    expect(deflatedStats(0.1, 1, -1, 100, 0, 3)).toEqual({
      ...none,
      sharpeVariance: -1,
    });
    expect(deflatedStats(0.1, 1, Number.POSITIVE_INFINITY, 100, 0, 3)).toEqual({
      ...none,
      sharpeVariance: Number.POSITIVE_INFINITY,
    });
    expect(deflatedStats(0.1, 1, null, 100, Number.NaN, 3)).toEqual({
      ...none,
      sharpeVariance: Number.NaN,
    });
    expect(deflatedStats(0.5, 32, 0.01, 100, 10, 3)).toEqual({
      ...none,
      sharpeVariance: 0.01,
    });
  });
});

describe("summary statistics", () => {
  it("computes moments, drawdown and the worst month", () => {
    expect(moments([0.01])).toEqual([0.01, 0, 0, 3]);
    expect(moments([0.01, 0.01, 0.01])).toEqual([0.01, 0, 0, 3]);
    expect(moments([0.01, -0.02, 0.03, 0])).toEqual([
      0.004_999_999_999_999_999, 0.020_816_659_994_661_327,
      5.647_227_668_884_549e-18, 1.852_071_005_917_159_7,
    ]);
    expect(worstMonth([], [], 1)).toBeNull();
  });

  it("matches metrics.summarize", () => {
    const stats = summarize(
      ledger(
        ["2024-01-02", "2024-01-03", "2024-02-01", "2024-02-02"],
        [100, 102, 99, 101],
        [1, 1, 0, 0],
        [1, -2]
      ),
      1
    );
    expect(stats).toEqual({
      cagr: 0.124_386_289_025_304_91,
      days: 4,
      deflatedSharpe: 0.567_636_115_349_448_5,
      end: "2024-02-02",
      expectedMaxSharpe: 0,
      exposure: 0.5,
      finalEquity: 101,
      maxDrawdown: -0.029_411_764_705_882_36,
      nTrials: 1,
      sharpe: 1.997_337_215_740_507,
      sharpeVariance: 0.545_471_159_648_017_1,
      skipped: 0,
      start: "2024-01-02",
      totalReturn: 0.010_000_000_000_000_009,
      trades: 2,
      winRate: 0.5,
      worstMonth: "2024-02",
      worstMonthReturn: -0.009_803_921_568_627_416,
    });
    const flat = summarize(
      ledger(["2024-01-02", "2024-01-03"], [100, 100], [0, 0]),
      5
    );
    expect([flat.cagr, flat.sharpe, flat.deflatedSharpe, flat.winRate]).toEqual(
      [0, null, null, null]
    );
    const ruined = summarize(
      ledger(["2024-01-02", "2024-01-02"], [100, -5], [0, 0]),
      1
    );
    expect([ruined.cagr, ruined.maxDrawdown]).toEqual([null, -1.05]);
  });

  it("refuses a bad trial count and too short runs", () => {
    const run = ledger(["2024-01-02", "2024-01-03"], [100, 100], [0, 0]);
    for (const n of [0, 1.5])
      expect(() => summarize(run, n)).toThrow(
        "n_trials must be an integer >= 1"
      );
    expect(() => summarize(ledger(["2024-01-02"], [100], [0]), 1)).toThrow(
      "Need at least two run days"
    );
  });
});
