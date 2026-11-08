import { describe, expect, it } from "vitest";

import { type CostProfile, ZERO_COST_PROFILE } from "./backtest-costs.ts";
import {
  type BarColumns,
  downsampleIndexes,
  InstantBacktestInputError,
  type InstantRunParams,
  priorExtreme,
  rollingMean,
  runInstantBacktest,
  runSignalBacktest,
  type SignalRunOptions,
  wilderRsi,
} from "./instant-backtest-engine.ts";

const DAY_MS = 86_400_000;

type Row = readonly [o: number, h: number, l: number, c: number];

const columns = (rows: readonly Row[], step = DAY_MS): BarColumns => ({
  t: Float64Array.from(rows, (_, index) => index * step),
  o: Float64Array.from(rows, (row) => row[0]),
  h: Float64Array.from(rows, (row) => row[1]),
  l: Float64Array.from(rows, (row) => row[2]),
  c: Float64Array.from(rows, (row) => row[3]),
});

const smaParams = (
  overrides: Partial<InstantRunParams> = {}
): InstantRunParams => ({
  rule: { kind: "smaCross", fast: 1, slow: 2 },
  stopLossPct: 0,
  takeProfitPct: 0,
  costBps: 0,
  ...overrides,
});

const nanToNull = (values: Float64Array) =>
  Array.from(values, (value) => (Number.isNaN(value) ? null : value));

describe("rollingMean", () => {
  it("averages each full window and leaves earlier bars NaN", () => {
    expect(nanToNull(rollingMean(Float64Array.of(1, 2, 3, 4), 2))).toEqual([
      null,
      1.5,
      2.5,
      3.5,
    ]);
  });
});

describe("priorExtreme", () => {
  it("returns the highest value of the prior bars, excluding the bar itself", () => {
    expect(
      nanToNull(priorExtreme(Float64Array.of(1, 3, 2, 5, 4), 2, 1))
    ).toEqual([null, null, 3, 3, 5]);
  });

  it("returns the lowest value of the prior bars", () => {
    expect(
      nanToNull(priorExtreme(Float64Array.of(1, 3, 2, 5, 4), 2, -1))
    ).toEqual([null, null, 1, 2, 2]);
  });

  it("drops values that leave the window", () => {
    expect(nanToNull(priorExtreme(Float64Array.of(5, 1, 1, 1), 2, 1))).toEqual([
      null,
      null,
      5,
      1,
    ]);
  });
});

describe("runInstantBacktest input checks", () => {
  const valid = columns([
    [10, 10, 10, 10],
    [10, 11, 10, 11],
    [11, 12, 11, 12],
  ]);

  it("rejects columns of unequal length", () => {
    expect(() =>
      runInstantBacktest({ ...valid, o: Float64Array.of(1) }, smaParams())
    ).toThrow("Bar columns must have equal length");
  });

  it("rejects fewer than two bars", () => {
    expect(() =>
      runInstantBacktest(columns([[10, 10, 10, 10]]), smaParams())
    ).toThrow("At least 2 bars needed");
  });

  it.each([
    [
      { kind: "smaCross", fast: 0, slow: 2 } as const,
      "fast must be an integer",
    ],
    [
      { kind: "smaCross", fast: 1, slow: 4 } as const,
      "slow must be an integer",
    ],
    [
      { kind: "smaCross", fast: 2, slow: 2 } as const,
      "fast must be shorter than slow",
    ],
    [
      {
        kind: "breakout",
        entryLookback: 1.5,
        exitLookback: 1,
        trendSma: 0,
      } as const,
      "entryLookback must be an integer",
    ],
    [
      {
        kind: "breakout",
        entryLookback: 1,
        exitLookback: 9,
        trendSma: 0,
      } as const,
      "exitLookback must be an integer",
    ],
    [
      {
        kind: "breakout",
        entryLookback: 1,
        exitLookback: 1,
        trendSma: 9,
      } as const,
      "trendSma must be an integer",
    ],
    [
      {
        kind: "rsiReversion",
        period: 3,
        oversold: 30,
        overbought: 70,
      } as const,
      "period must be an integer from 1 to 2",
    ],
    [
      {
        kind: "rsiReversion",
        period: 2,
        oversold: Number.NaN,
        overbought: 70,
      } as const,
      "oversold must be from 0 to 100",
    ],
    [
      {
        kind: "rsiReversion",
        period: 2,
        oversold: -1,
        overbought: 70,
      } as const,
      "oversold must be from 0 to 100",
    ],
    [
      {
        kind: "rsiReversion",
        period: 2,
        oversold: 30,
        overbought: 101,
      } as const,
      "overbought must be from 0 to 100",
    ],
    [
      {
        kind: "rsiReversion",
        period: 2,
        oversold: 70,
        overbought: 70,
      } as const,
      "oversold must be below overbought",
    ],
  ])("rejects rule %j", (rule, message) => {
    expect(() => runInstantBacktest(valid, smaParams({ rule }))).toThrow(
      message
    );
  });

  it.each([
    [{ stopLossPct: -1 }, "stopLossPct"],
    [{ takeProfitPct: Number.NaN }, "takeProfitPct"],
    [{ costBps: 600 }, "costBps"],
  ])("rejects risk setting %j", (overrides, name) => {
    let thrown: unknown;
    try {
      runInstantBacktest(valid, smaParams(overrides));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InstantBacktestInputError);
    expect((thrown as Error).message).toContain(name);
  });
});

describe("runInstantBacktest moving-average rule", () => {
  // Signals at each close: -1, -1, 1, 1, -1, -1. Entry fills at the open of bar 3 and the exit
  // at the open of bar 5, so no bar uses a later price.
  const bars = columns([
    [10, 10.5, 9.5, 10],
    [10, 10.5, 9.5, 10],
    [10, 12.5, 9.5, 12],
    [12.5, 13.5, 12, 13],
    [11.5, 12, 10.5, 11],
    [10, 10.5, 8.5, 9],
  ]);

  it("enters and exits at the next open after each signal", () => {
    const result = runInstantBacktest(bars, smaParams());
    expect(Array.from(result.equity)).toEqual([1, 1, 1, 1.04, 0.88, 0.8]);
    expect(result.trades).toEqual([
      {
        entryIndex: 3,
        exitIndex: 5,
        entryPrice: 12.5,
        exitPrice: 10,
        units: 0.08,
        netReturn: -0.199_999_999_999_999_96,
        pnl: -0.199_999_999_999_999_96,
        exitReason: "signal",
      },
    ]);
    expect(result.stats.trades).toBe(1);
    expect(result.stats.winRate).toBe(0);
    expect(result.stats.profitFactor).toBe(0);
    expect(result.stats.exposure).toBeCloseTo(2 / 6);
    expect(result.stats.totalReturn).toBeCloseTo(-0.2);
    expect(result.stats.maxDrawdown).toBeCloseTo(0.8 / 1.04 - 1);
    expect(result.stats.buyHoldReturn).toBeCloseTo(-0.1);
    expect(result.stats.buyHoldMaxDrawdown).toBeCloseTo(9 / 13 - 1);
  });

  it("charges the cost on both legs", () => {
    const result = runInstantBacktest(bars, smaParams({ costBps: 100 }));
    expect(result.trades[0]?.netReturn).toBeCloseTo(
      ((0.99 / 12.5) * 10 * 0.99) / 1 - 1
    );
    expect(result.equity[5]).toBeCloseTo((0.99 / 12.5) * 10 * 0.99);
  });

  it("closes an open position at the last close", () => {
    const result = runInstantBacktest(
      columns([
        [10, 10, 10, 10],
        [10, 11, 10, 11],
        [12, 12, 12, 12],
        [13, 14, 13, 14],
      ]),
      smaParams({ costBps: 100 })
    );
    expect(result.trades.at(-1)).toMatchObject({
      entryIndex: 2,
      exitIndex: 3,
      exitPrice: 14,
      exitReason: "end",
    });
    expect(result.equity[3]).toBeCloseTo((0.99 / 12) * 14 * 0.99);
    expect(result.stats.winRate).toBe(1);
    expect(result.stats.profitFactor).toBeNull();
  });

  it("ignores a signal on the last bar", () => {
    const result = runInstantBacktest(
      columns([
        [10, 10, 10, 10],
        [10, 10, 10, 10],
        [10, 10, 10, 10],
        [10, 11, 10, 11],
      ]),
      smaParams()
    );
    expect(result.trades).toEqual([]);
    expect(result.stats).toMatchObject({
      trades: 0,
      winRate: null,
      profitFactor: null,
      exposure: 0,
      sharpe: null,
      sortino: null,
      maxDrawdown: 0,
      totalReturn: 0,
    });
  });

  it("reports win rate and profit factor across several trades", () => {
    // Each cycle has one winning trade (a long rise with a slow fall) and one losing trade.
    const rows: Row[] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (const price of [
        100, 101, 102, 103, 104, 105, 106, 105.5, 105, 100, 101, 100.5, 100.2,
      ]) {
        rows.push([price, price + 0.1, price - 0.1, price]);
      }
    }
    const result = runInstantBacktest(columns(rows), smaParams());
    const wins = result.trades.filter((trade) => trade.pnl > 0);
    const losses = result.trades.filter((trade) => trade.pnl <= 0);
    expect(wins.length).toBeGreaterThan(0);
    expect(losses.length).toBeGreaterThan(0);
    expect(result.stats.winRate).toBe(wins.length / result.trades.length);
    const sum = (values: readonly number[]) =>
      values.reduce((total, value) => total + value, 0);
    expect(result.stats.profitFactor).toBeCloseTo(
      sum(wins.map((trade) => trade.pnl)) /
        -sum(losses.map((trade) => trade.pnl))
    );
    expect(result.stats.sharpe).not.toBeNull();
    expect(result.stats.sortino).not.toBeNull();
    expect(result.stats.cagr).not.toBeNull();
  });

  it("returns null ratios when no time elapses and handles two bars", () => {
    const rows: Row[] = [
      [10, 10, 10, 10],
      [10, 11, 10, 11],
      [12, 12, 12, 12],
      [13, 13, 9, 9],
    ];
    const flatTime = runInstantBacktest(columns(rows, 0), smaParams());
    expect(flatTime.stats.cagr).toBeNull();
    expect(flatTime.stats.sharpe).toBeNull();
    expect(flatTime.stats.sortino).toBeNull();
    const two = runInstantBacktest(
      columns([
        [10, 10, 10, 10],
        [10, 10, 10, 10],
      ]),
      smaParams({ rule: { kind: "smaCross", fast: 1, slow: 2 } })
    );
    expect(two.stats.sharpe).toBeNull();
    expect(two.stats.bars).toBe(2);
  });
});

describe("runInstantBacktest moving-average re-entry", () => {
  it("waits for a new cross up after a stop instead of buying again", () => {
    // Fast (1) stays above slow (2) on bars 1-4, so only bar 1 is a cross. The 10% stop fills on
    // bar 3. Bar 5 closes below the average and bar 6 crosses up again; the re-entry is bar 7.
    const rows: Row[] = [
      [10, 10, 10, 10],
      [10, 11, 10, 11],
      [10, 12, 10, 12],
      [12, 13, 8.5, 12.5],
      [12.5, 13.5, 12.5, 13],
      [13, 13, 9, 9],
      [9, 11, 9, 11],
      [11, 12, 11, 12],
    ];
    const result = runInstantBacktest(
      columns(rows),
      smaParams({ stopLossPct: 10 })
    );
    expect(
      result.trades.map((trade) => [
        trade.entryIndex,
        trade.exitIndex,
        trade.exitReason,
      ])
    ).toEqual([
      [2, 3, "stop"],
      [7, 7, "end"],
    ]);
  });
});

describe("runInstantBacktest stop-loss and take-profit", () => {
  // Bar 1 closes above the 2-bar average, so the entry fills at the open of bar 2 (price 10).
  // A 10% stop sits at 9 and a 20% target at 12.
  const entry: Row[] = [
    [10, 10, 10, 10],
    [10, 11, 10, 11],
  ];
  const risk = { stopLossPct: 10, takeProfitPct: 20 };
  const firstTrade = (rows: readonly Row[]) =>
    runInstantBacktest(columns([...entry, ...rows]), smaParams(risk)).trades[0];

  it("fills the stop inside the bar", () => {
    expect(
      firstTrade([
        [10, 10.5, 8.5, 10.2],
        [10, 10, 10, 10],
      ])
    ).toMatchObject({ exitIndex: 2, exitPrice: 9, exitReason: "stop" });
  });

  it("fills at the open when the price gaps through the stop", () => {
    expect(
      firstTrade([
        [10, 11.6, 9.9, 11.5],
        [8, 8.2, 7.9, 8],
      ])
    ).toMatchObject({ exitIndex: 3, exitPrice: 8, exitReason: "stop" });
  });

  it("fills the target inside the bar", () => {
    expect(
      firstTrade([
        [10, 12.5, 9.9, 11.5],
        [12, 12, 12, 12],
      ])
    ).toMatchObject({ exitPrice: 12, exitReason: "target" });
  });

  it("fills at the open when the price gaps through the target", () => {
    expect(
      firstTrade([
        [10, 11.8, 9.9, 11.5],
        [13, 13.5, 12.9, 13.2],
      ])
    ).toMatchObject({ exitIndex: 3, exitPrice: 13, exitReason: "target" });
  });

  it("fills the stop first when both levels are inside one bar", () => {
    expect(
      firstTrade([
        [10, 12.5, 8.5, 11],
        [11, 11, 11, 11],
      ])
    ).toMatchObject({
      exitPrice: 9,
      exitReason: "stop",
    });
  });
});

describe("runInstantBacktest breakout rule", () => {
  const rows: Row[] = [
    [10, 10.5, 9.5, 10],
    [10, 10.6, 9.6, 10.2],
    [10.2, 11, 10.1, 10.9],
    [11, 11.5, 10.8, 11.4],
    [11.3, 11.4, 10.9, 11],
    [10.9, 11, 10, 10.05],
    [10, 10.2, 9.8, 10.1],
  ];

  it("enters above the prior high and exits below the prior low", () => {
    const result = runInstantBacktest(
      columns(rows),
      smaParams({
        rule: {
          kind: "breakout",
          entryLookback: 2,
          exitLookback: 2,
          trendSma: 0,
        },
      })
    );
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      entryIndex: 3,
      exitIndex: 6,
      entryPrice: 11,
      exitPrice: 10,
      exitReason: "signal",
    });
    expect(result.trades[0]?.netReturn).toBeCloseTo(10 / 11 - 1);
  });

  it("skips a breakout below the trend average", () => {
    const falling: Row[] = [
      [20, 20, 20, 20],
      [18, 18, 18, 18],
      [15, 15, 15, 15],
      [12, 12, 12, 12],
      [10, 10, 10, 10],
      [10, 10.2, 10, 10.2],
      [10.2, 10.9, 10.2, 10.9],
      [10.9, 11, 10.9, 11],
    ];
    const rule = {
      kind: "breakout",
      entryLookback: 2,
      exitLookback: 3,
      trendSma: 5,
    } as const;
    const filtered = runInstantBacktest(columns(falling), smaParams({ rule }));
    const unfiltered = runInstantBacktest(
      columns(falling),
      smaParams({ rule: { ...rule, trendSma: 0 } })
    );
    expect(filtered.trades).toEqual([]);
    expect(unfiltered.trades.length).toBeGreaterThan(0);
  });
});

describe("wilderRsi", () => {
  it("seeds with the mean change and then smooths by hand", () => {
    // Changes -1,-1,-1,+1,+1,+1 with period 2.
    // Bar 2: gain 0, loss 1 -> 0. Bar 3: loss (1+1)/2=1 -> 0.
    // Bar 4: gain (0+1)/2=.5, loss (1+0)/2=.5 -> 50. Bar 5: .75/.25 -> 75. Bar 6: .875/.125 -> 87.5.
    expect(
      nanToNull(wilderRsi(Float64Array.of(10, 9, 8, 7, 8, 9, 10), 2))
    ).toEqual([null, null, 0, 0, 50, 75, 87.5]);
  });

  it("counts rises in the seed window", () => {
    // Changes +1,-1,+2. Seed: gain .5, loss .5 -> 50. Bar 3: gain (.5+2)/2=1.25, loss .25 -> 250/3.
    expect(nanToNull(wilderRsi(Float64Array.of(10, 11, 10, 12), 2))).toEqual([
      null,
      null,
      50,
      250 / 3,
    ]);
  });

  it("gives 50 for a flat window and 100 without losses", () => {
    expect(nanToNull(wilderRsi(Float64Array.of(5, 5, 5, 6), 2))).toEqual([
      null,
      null,
      50,
      100,
    ]);
  });

  it("returns only NaN when the series is too short", () => {
    expect(nanToNull(wilderRsi(Float64Array.of(1, 2), 2))).toEqual([
      null,
      null,
    ]);
  });
});

describe("runInstantBacktest RSI reversion rule", () => {
  const rows: Row[] = [
    [10, 10, 10, 10],
    [10, 10, 9, 9],
    [9, 9, 8, 8],
    [8, 8, 7, 7],
    [7, 8, 7, 8],
    [8, 9, 8, 9],
    [9, 10, 9, 10],
  ];

  it("buys after RSI falls below oversold and sells after it rises above overbought", () => {
    // RSI(2) by bar: -, -, 0, 0, 50, 75, 87.5. Entry signal on bar 2 fills at the bar 3 open;
    // the bar 3 signal is ignored while long; the bar 5 exit signal fills at the bar 6 open.
    const result = runInstantBacktest(
      columns(rows),
      smaParams({
        rule: { kind: "rsiReversion", period: 2, oversold: 30, overbought: 70 },
      })
    );
    expect(result.trades).toEqual([
      {
        entryIndex: 3,
        exitIndex: 6,
        entryPrice: 8,
        exitPrice: 9,
        units: 1 / 8,
        netReturn: 9 / 8 - 1,
        pnl: 9 / 8 - 1,
        exitReason: "signal",
      },
    ]);
    expect(result.stats.exposure).toBeCloseTo(3 / 7);
  });
});

describe("runInstantBacktest annualized growth", () => {
  it("reports CAGR as not available when it overflows on a short series", () => {
    const minute = 60_000;
    const result = runInstantBacktest(
      columns(
        [
          [10, 10, 10, 10],
          [10, 11, 10, 11],
          [11, 11, 11, 11],
          [15, 15, 15, 15],
        ],
        minute
      ),
      smaParams()
    );
    expect(result.stats.totalReturn).toBeGreaterThan(0.3);
    expect(result.stats.cagr).toBeNull();
  });
});

describe("downsampleIndexes", () => {
  it("needs room for the first and last index", () => {
    expect(() => downsampleIndexes(10, 1)).toThrow(RangeError);
  });

  it("keeps every index when the series is short", () => {
    expect(downsampleIndexes(5, 10)).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps the first and last index and at most the limit", () => {
    expect(downsampleIndexes(10, 4)).toEqual([0, 3, 6, 9]);
    expect(downsampleIndexes(11, 4)).toEqual([0, 4, 8, 10]);
  });
});

describe("runInstantBacktest cost profiles", () => {
  const bars = columns([
    [10, 10.5, 9.5, 10],
    [10, 10.5, 9.5, 10],
    [10, 12.5, 9.5, 12],
    [12.5, 13.5, 12, 13],
    [11.5, 12, 10.5, 11],
    [10, 10.5, 8.5, 9],
  ]);
  const profile: CostProfile = {
    ...ZERO_COST_PROFILE,
    commission: {
      ...ZERO_COST_PROFILE.commission,
      minPerOrder: 1,
      perShare: 0.01,
    },
    id: "hand",
    slippage: { bps: 100, kind: "bps" },
  };

  it("applies slippage and commission in the fills (hand-computed)", () => {
    const result = runInstantBacktest(
      bars,
      smaParams({ costs: { capital: 1000, profile } })
    );
    // Entry: fill 12.5 x 1.01 = 12.625; 999 / 12.625 shares (0.79 commission < 1 minimum).
    const shares = 999 / 12.625;
    // Exit: fill 10 x 0.99 = 9.9; proceeds minus the 1.00 minimum commission.
    const cash = (shares * 9.9 - 1) / 1000;
    const trade = result.trades[0];
    expect(trade?.entryPrice).toBeCloseTo(12.625, 12);
    expect(trade?.exitPrice).toBeCloseTo(9.9, 12);
    expect(trade?.units).toBeCloseTo(shares / 1000, 12);
    expect(trade?.pnl).toBeCloseTo(cash - 1, 12);
    expect(result.equity[5]).toBeCloseTo(cash, 12);
    expect(trade?.costs?.commission).toBeCloseTo(0.002, 12);
    expect(trade?.costs?.slippage).toBeCloseTo((shares * 0.225) / 1000, 12);
    expect(trade?.costs?.total).toBeCloseTo(
      0.002 + (shares * 0.225) / 1000,
      12
    );
    // Before costs: the same shares bought at 12.5 and sold at 10.
    expect(trade?.grossPnl).toBeCloseTo((shares * (10 - 12.5)) / 1000, 12);
  });

  it("skips an entry whose minimum charge exceeds the cash", () => {
    const result = runInstantBacktest(
      bars,
      smaParams({
        costs: {
          capital: 1,
          profile: {
            ...profile,
            commission: { ...profile.commission, minPerOrder: 5 },
          },
        },
      })
    );
    expect(result.trades).toEqual([]);
    expect(Array.from(result.equity)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("rejects a capital that is not above 0", () => {
    expect(() =>
      runInstantBacktest(bars, smaParams({ costs: { capital: 0, profile } }))
    ).toThrow("capital must be above 0");
  });

  it("uses the ATR of the bar before the fill", () => {
    const atrProfile: CostProfile = {
      ...ZERO_COST_PROFILE,
      slippage: { fraction: 0.5, kind: "atr", period: 2 },
    };
    const result = runInstantBacktest(
      bars,
      smaParams({ costs: { capital: 1, profile: atrProfile } })
    );
    // ATR(2) at bar 2: (1 + 3) / 2 = 2, so the entry at bar 3 pays 1. At bar 4: (1.5 + 2.5) / 2.
    expect(result.trades[0]?.entryPrice).toBe(13.5);
    expect(result.trades[0]?.exitPrice).toBe(9);
  });

  // Golden test: a zero-cost profile must reproduce the run without a profile bit for bit.
  it("reproduces the run without costs exactly with the zero profile", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const rows: Row[] = [];
    let price = 100;
    for (let index = 0; index < 600; index += 1) {
      const open = price * (1 + (random() - 0.5) * 0.02);
      const close = open * (1 + (random() - 0.5) * 0.04);
      rows.push([
        open,
        Math.max(open, close) * (1 + random() * 0.01),
        Math.min(open, close) * (1 - random() * 0.01),
        close,
      ]);
      price = close;
    }
    const golden = columns(rows);
    const variants: InstantRunParams[] = [
      smaParams({ costBps: 3, rule: { fast: 5, kind: "smaCross", slow: 20 } }),
      smaParams({
        costBps: 1,
        rule: {
          entryLookback: 10,
          exitLookback: 5,
          kind: "breakout",
          trendSma: 30,
        },
        stopLossPct: 2,
        takeProfitPct: 4,
      }),
    ];
    const zeroAtr: CostProfile = {
      ...ZERO_COST_PROFILE,
      slippage: { fraction: 0, kind: "atr", period: 14 },
    };
    for (const params of variants) {
      const plain = runInstantBacktest(golden, params);
      expect(plain.trades.length).toBeGreaterThan(3);
      for (const zero of [ZERO_COST_PROFILE, zeroAtr]) {
        const costed = runInstantBacktest(golden, {
          ...params,
          costs: { capital: 25_000, profile: zero },
        });
        expect(Array.from(costed.equity)).toEqual(Array.from(plain.equity));
        expect(costed.stats).toEqual(plain.stats);
        expect(
          costed.trades.map(
            ({ costs: _costs, grossPnl: _gross, ...trade }) => trade
          )
        ).toEqual(plain.trades);
      }
    }
  });
});

describe("runSignalBacktest stop management", () => {
  const constant = (size: number, value: number) =>
    new Float64Array(size).fill(value);
  const signalsOf = (size: number) => {
    const signals = new Int8Array(size);
    signals[0] = 1;
    return signals;
  };
  const run = (
    rows: readonly Row[],
    overrides: Partial<SignalRunOptions> = {}
  ) =>
    runSignalBacktest(columns(rows), signalsOf(rows.length), {
      costBps: 0,
      stopDistance: constant(rows.length, 5),
      stopLossPct: 0,
      takeProfitPct: 0,
      ...overrides,
    });

  // Entry at the bar 1 open (100) with a 5 stop: R = 5.
  const breakevenRows: Row[] = [
    [100, 100, 100, 100],
    [100, 103, 99, 102],
    // The high reaches entry + 1R (105); the low (99) is below the entry but the new stop
    // applies only from the next bar.
    [102, 106, 99, 104],
    [104, 104, 99.5, 100],
    [100, 101, 99.5, 100],
  ];

  it("moves the stop to the entry once the high reaches entry + breakevenR × R", () => {
    const { trades } = run(breakevenRows, { management: { breakevenR: 1 } });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      entryIndex: 1,
      entryPrice: 100,
      exitIndex: 3,
      exitPrice: 100,
      exitReason: "stop",
    });
  });

  it("leaves the stop below a breakeven level the high never reaches", () => {
    const { trades } = run(breakevenRows, { management: { breakevenR: 2 } });
    expect(trades[0]).toMatchObject({ exitIndex: 4, exitReason: "end" });
  });

  it("moves the stop the same way with a cost profile", () => {
    const { trades } = run(breakevenRows, {
      costs: { capital: 1000, profile: ZERO_COST_PROFILE },
      management: { breakevenR: 1 },
    });
    expect(trades[0]).toMatchObject({ exitIndex: 3, exitReason: "stop" });
  });

  it("moves nothing without a stop", () => {
    const { trades } = runSignalBacktest(
      columns(breakevenRows),
      signalsOf(breakevenRows.length),
      {
        costBps: 0,
        management: { breakevenR: 1 },
        stopLossPct: 0,
        takeProfitPct: 0,
      }
    );
    expect(trades[0]).toMatchObject({ exitIndex: 4, exitReason: "end" });
  });

  // Entry at 100, stop 95 (R = 5). The trail activates once the high reaches 105.
  const trailRows: Row[] = [
    [100, 100, 100, 100],
    [100, 104, 99, 103],
    // Active: stop = highest close 105 - 2 × ATR 1 = 103.
    [103, 106, 102, 105],
    // Stop = 107 - 2 = 105.
    [105, 108, 104, 107],
    // ATR 3 would give 107 - 6 = 101: the stop never moves down.
    [107, 108, 106, 107],
    [107, 107, 104.5, 105],
    [105, 106, 104, 105],
  ];
  const trailAtr = Float64Array.from([1, 1, 1, 1, 3, 1, 1]);

  it("trails the highest close by multiple × ATR once activated and never lowers it", () => {
    const { trades } = run(trailRows, {
      management: { trail: { activateR: 1, atr: trailAtr, multiple: 2 } },
    });
    expect(trades[0]).toMatchObject({
      exitIndex: 5,
      exitPrice: 105,
      exitReason: "stop",
    });
  });

  it("does not trail before the high reaches entry + activateR × R", () => {
    const { trades } = run(trailRows, {
      management: { trail: { activateR: 2, atr: trailAtr, multiple: 2 } },
    });
    expect(trades[0]).toMatchObject({ exitIndex: 6, exitReason: "end" });
  });

  it("leaves the stop on a NaN ATR", () => {
    const { trades } = run(trailRows, {
      management: {
        trail: {
          activateR: 1,
          atr: constant(trailRows.length, Number.NaN),
          multiple: 2,
        },
      },
    });
    expect(trades[0]).toMatchObject({ exitIndex: 6, exitReason: "end" });
  });

  it("combines breakeven and trail, taking the higher stop", () => {
    const { trades } = run(trailRows, {
      management: {
        breakevenR: 1,
        trail: { activateR: 1, atr: trailAtr, multiple: 2 },
      },
    });
    expect(trades[0]).toMatchObject({ exitIndex: 5, exitPrice: 105 });
  });

  it.each([
    [{ maxLeverage: 2 }, "maxLeverage needs riskPct"],
    [{ maxLeverage: 0.5, riskPct: 1 }, "maxLeverage must be from 1 to 50"],
    [{ maxLeverage: 51, riskPct: 1 }, "maxLeverage must be from 1 to 50"],
    [
      { maxLeverage: Number.NaN, riskPct: 1 },
      "maxLeverage must be from 1 to 50",
    ],
    [{ management: { breakevenR: 0 } }, "breakevenR must be above 0"],
    [
      { management: { breakevenR: Number.POSITIVE_INFINITY } },
      "breakevenR must be above 0",
    ],
    [
      {
        management: {
          trail: { activateR: 0, atr: constant(7, 1), multiple: 1 },
        },
      },
      "trail activateR must be above 0",
    ],
    [
      {
        management: {
          trail: { activateR: 1, atr: constant(7, 1), multiple: Number.NaN },
        },
      },
      "trail multiple must be above 0",
    ],
    [
      {
        management: {
          trail: { activateR: 1, atr: constant(6, 1), multiple: 1 },
        },
      },
      "trail ATR must match the bar count",
    ],
  ] as const)("rejects %o", (overrides, message) => {
    expect(() => run(trailRows, overrides)).toThrow(
      new InstantBacktestInputError(message)
    );
  });
});

describe("runSignalBacktest maxLeverage", () => {
  // Entry at 100 with a stop 1 below: riskPct 10 of equity 1 is 0.1 units, cost 10.
  const bars = columns([
    [100, 100, 100, 100],
    [100, 102, 100, 102],
    [102, 103, 101, 103],
  ]);
  const signals = Int8Array.from([1, 0, 0]);
  const run = (maxLeverage?: number) =>
    runSignalBacktest(bars, signals, {
      costBps: 0,
      riskPct: 10,
      stopDistance: new Float64Array(3).fill(1),
      stopLossPct: 0,
      takeProfitPct: 0,
      ...(maxLeverage === undefined ? {} : { maxLeverage }),
    });

  it("caps the position at the cash without maxLeverage", () => {
    const { equity, trades } = run();
    expect(trades[0]?.units).toBeCloseTo(0.01, 12);
    expect(equity[1]).toBeCloseTo(1.02, 12);
  });

  it("caps the position at cash × maxLeverage, borrowing into negative rest", () => {
    const { equity, trades } = run(5);
    expect(trades[0]?.units).toBeCloseTo(0.05, 12);
    // rest = 1 - 5 = -4; equity = -4 + 0.05 × 102.
    expect(equity[1]).toBeCloseTo(1.1, 12);
    // Closed at the last close: -4 + 0.05 × 103.
    expect(equity[2]).toBeCloseTo(1.15, 12);
  });

  it("sizes by risk when the leverage cap is above the risk size", () => {
    const { equity, trades } = run(20);
    expect(trades[0]?.units).toBeCloseTo(0.1, 12);
    // rest = 1 - 10 = -9; equity = -9 + 0.1 × 102.
    expect(equity[1]).toBeCloseTo(1.2, 12);
  });
});
