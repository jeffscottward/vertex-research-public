import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COST_PROFILE_PRESETS } from "./backtest-costs.ts";

import {
  type BarColumns,
  InstantBacktestInputError,
  runInstantBacktest,
  runSignalBacktest,
} from "./instant-backtest-engine.ts";
import {
  STRATEGY_CALENDAR_INTRADAY_REFUSAL,
  STRATEGY_OPTIONS_REFUSAL,
  STRATEGY_TEMPLATES,
  type StrategyDefinition,
  type StrategyDefinitionInput,
  StrategyDefinitionSchema,
} from "./strategy-dsl.ts";
import {
  assertServerRunnable,
  averageDirectionalIndex,
  averageTrueRange,
  compileStrategy,
  exponentialMean,
  isNyseTradingDay,
  ivRankSeries,
  nyseHolidays,
  REALIZED_VOL_PERIODS_PER_YEAR,
  realizedVolatility,
  relativeStrength,
  relativeVolumeAtTime,
  rollingZScore,
  runStrategyDefinition,
  SectorQuadrantDataError,
  type SectorQuadrantPoint,
  STRATEGY_SERIES_MAX_FILL_DAYS,
  type StrategySeriesContext,
  StrategySeriesDataError,
  StrategyUnsupportedError,
} from "./strategy-dsl-compile.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const wave = (size: number, step = DAY_MS): BarColumns => {
  const c = Float64Array.from(
    { length: size },
    (_, index) => 100 + index * 0.05 + 10 * Math.sin(index / 20)
  );
  const o = Float64Array.from(c, (close, index) =>
    index === 0 ? close : (c[index - 1] as number)
  );
  return {
    c,
    h: Float64Array.from(
      c,
      (close, index) => Math.max(close, o[index] as number) + 0.2
    ),
    l: Float64Array.from(
      c,
      (close, index) => Math.min(close, o[index] as number) - 0.2
    ),
    o,
    t: Float64Array.from(c, (_, index) => index * step),
  };
};

const define = (input: StrategyDefinitionInput): StrategyDefinition =>
  StrategyDefinitionSchema.parse(input);

const nanToNull = (values: Float64Array) =>
  Array.from(values, (value) =>
    Number.isNaN(value) ? null : Math.round(value * 1e6) / 1e6
  );

const sma = (length: number) =>
  ({ length, name: "sma", type: "indicator" }) as const;

const smaCross = (fast: number, slow: number) =>
  define({
    entry: { all: [{ left: sma(fast), op: "crossesAbove", right: sma(slow) }] },
    exit: { any: [{ left: sma(fast), op: "<=", right: sma(slow) }] },
    name: "SMA cross",
    version: 1,
  });

describe("compile parity with the golden rules", () => {
  const bars = wave(1500);

  it.each([
    [10, 40],
    [20, 50],
    [5, 6],
  ])("SMA cross %i/%i equals the golden smaCross result", (fast, slow) => {
    for (const costBps of [0, 7]) {
      const golden = runInstantBacktest(bars, {
        costBps,
        rule: { fast, kind: "smaCross", slow },
        stopLossPct: 5,
        takeProfitPct: 12,
      });
      const compiled = runStrategyDefinition(
        bars,
        {
          ...smaCross(fast, slow),
          stopLoss: { kind: "pct", pct: 5 },
          takeProfit: { kind: "pct", pct: 12 },
        },
        costBps
      );
      expect(compiled.trades).toEqual(golden.trades);
      expect(Array.from(compiled.equity)).toEqual(Array.from(golden.equity));
      expect(compiled.stats).toEqual(golden.stats);
      expect(golden.trades.length).toBeGreaterThan(3);
    }
  });

  it("the SMA cross template equals the golden 20/50 result", () => {
    const template = define(STRATEGY_TEMPLATES.smaCross);
    const golden = runInstantBacktest(bars, {
      costBps: 0,
      rule: { fast: 20, kind: "smaCross", slow: 50 },
      stopLossPct: 0,
      takeProfitPct: 0,
    });
    expect(runStrategyDefinition(bars, template, 0)).toEqual(golden);
  });

  it("the Donchian template equals the golden breakout without a trend filter", () => {
    const template = define(STRATEGY_TEMPLATES.donchianBreakout);
    const golden = runInstantBacktest(bars, {
      costBps: 3,
      rule: {
        entryLookback: 20,
        exitLookback: 10,
        kind: "breakout",
        trendSma: 0,
      },
      stopLossPct: 0,
      takeProfitPct: 0,
    });
    expect(runStrategyDefinition(bars, template, 3)).toEqual(golden);
  });

  it("every template runs and trades on the synthetic series", () => {
    for (const template of Object.values(STRATEGY_TEMPLATES)) {
      const result = runStrategyDefinition(bars, define(template), 5);
      expect(result.trades.length).toBeGreaterThan(0);
      expect(result.equity.every(Number.isFinite)).toBe(true);
    }
  });
});

describe("indicators", () => {
  it("exponentialMean seeds with the simple average", () => {
    expect(nanToNull(exponentialMean(Float64Array.of(1, 2, 3, 4), 2))).toEqual([
      null,
      1.5,
      2.5 / 1 - 0,
      3.5,
    ]);
    expect(nanToNull(exponentialMean(Float64Array.of(1), 2))).toEqual([null]);
  });

  it("relativeStrength is 100 without losses and 0 without gains", () => {
    expect(nanToNull(relativeStrength(Float64Array.of(1, 2, 3, 4), 2))).toEqual(
      [null, null, 100, 100]
    );
    expect(nanToNull(relativeStrength(Float64Array.of(4, 3, 2, 1), 2))).toEqual(
      [null, null, 0, 0]
    );
    expect(nanToNull(relativeStrength(Float64Array.of(1, 2), 2))).toEqual([
      null,
      null,
    ]);
    expect(nanToNull(relativeStrength(Float64Array.of(1, 2, 1, 2), 2))).toEqual(
      [null, null, 50, 75]
    );
  });

  it("averageTrueRange uses gaps against the previous close", () => {
    const bars: BarColumns = {
      c: Float64Array.of(10, 10, 10),
      h: Float64Array.of(11, 14, 11),
      l: Float64Array.of(9, 12, 6),
      o: Float64Array.of(10, 13, 10),
      t: Float64Array.of(0, 1, 2),
    };
    // True ranges: 2, 4 (14 - 10), 5 (11 - 6).
    expect(nanToNull(averageTrueRange(bars, 2))).toEqual([null, 3, 4]);
  });
});

describe("compileStrategy", () => {
  const rows = (closes: number[], step = DAY_MS): BarColumns => ({
    c: Float64Array.from(closes),
    h: Float64Array.from(closes, (close) => close + 1),
    l: Float64Array.from(closes, (close) => close - 1),
    o: Float64Array.from(closes),
    t: Float64Array.from(closes, (_, index) => index * step),
  });
  const price = (field: "open" | "high" | "low" | "close") =>
    ({ field, type: "price" }) as const;
  const value = (number: number) => ({ type: "const", value: number }) as const;

  it.each([
    [">", [0, 0, 1, 1, 0]],
    [">=", [0, 1, 1, 1, 0]],
    ["<", [1, 0, 0, 0, 1]],
    ["<=", [1, 1, 0, 0, 1]],
    ["crossesAbove", [0, 0, 1, 0, 0]],
    ["crossesBelow", [1, 0, 0, 0, 1]],
  ] as const)("operator %s", (op, expected) => {
    const compiled = compileStrategy(
      rows([1, 2, 3, 3, 1]),
      define({
        entry: { all: [{ left: price("close"), op, right: value(2) }] },
        name: "op",
        version: 1,
      })
    );
    expect(Array.from(compiled.signals)).toEqual(expected);
  });

  it("exits an open position when the entry conditions still hold", () => {
    const definition = define({
      entry: { all: [{ left: price("close"), op: ">", right: value(0) }] },
      exit: { any: [{ left: price("close"), op: ">", right: value(4) }] },
      name: "exit while entry holds",
      version: 1,
    });
    const bars = rows([1, 2, 5, 2, 2]);
    expect(Array.from(compileStrategy(bars, definition).exits)).toEqual([
      0, 0, 1, 0, 0,
    ]);
    const result = runStrategyDefinition(bars, definition, 0);
    expect(result.trades[0]).toMatchObject({
      entryIndex: 1,
      exitIndex: 3,
      exitReason: "signal",
    });
  });

  it("entry wins over exit and exit fires when entry does not", () => {
    const compiled = compileStrategy(
      rows([1, 5, 2]),
      define({
        entry: { all: [{ left: price("high"), op: ">", right: value(5) }] },
        exit: { any: [{ left: price("low"), op: "<", right: value(4) }] },
        name: "both",
        version: 1,
      })
    );
    expect(Array.from(compiled.signals)).toEqual([-1, 1, -1]);
  });

  it("compares against an exponential average", () => {
    const compiled = compileStrategy(
      rows([1, 2, 3, 4]),
      define({
        entry: {
          all: [
            {
              left: price("close"),
              op: ">",
              right: { length: 2, name: "ema", type: "indicator" },
            },
          ],
        },
        name: "ema",
        version: 1,
      })
    );
    expect(Array.from(compiled.signals)).toEqual([0, 1, 1, 1]);
  });

  it("uses open prices, highest and lowest of prior bars", () => {
    const compiled = compileStrategy(
      rows([1, 3, 2, 5, 4]),
      define({
        entry: {
          all: [
            {
              left: price("open"),
              op: ">",
              right: {
                length: 2,
                name: "highest",
                source: "close",
                type: "indicator",
              },
            },
          ],
        },
        exit: {
          any: [
            {
              left: price("close"),
              op: "<",
              right: {
                length: 2,
                name: "lowest",
                source: "close",
                type: "indicator",
              },
            },
          ],
        },
        name: "channel",
        version: 1,
      })
    );
    expect(Array.from(compiled.signals)).toEqual([0, 0, 0, 1, 0]);
  });

  it("limits entries to the UTC session, including sessions past midnight", () => {
    const bars = rows([5, 5, 5, 5, 5, 5], 4 * HOUR_MS); // 00, 04, 08, 12, 16, 20 UTC
    const entry: StrategyDefinitionInput["entry"] = {
      all: [{ left: price("close"), op: ">", right: value(1) }],
    };
    const day = compileStrategy(
      bars,
      define({
        entry,
        name: "day",
        session: { endUtc: "16:00", startUtc: "08:00" },
        version: 1,
      })
    );
    expect(Array.from(day.signals)).toEqual([0, 0, 1, 1, 0, 0]);
    const night = compileStrategy(
      bars,
      define({
        entry,
        name: "night",
        session: { endUtc: "04:00", startUtc: "20:00" },
        version: 1,
      })
    );
    expect(Array.from(night.signals)).toEqual([1, 0, 0, 0, 0, 1]);
  });

  it("returns ATR distances for ATR stops and targets", () => {
    const compiled = compileStrategy(
      rows([1, 2, 3]),
      define({
        entry: { all: [{ left: price("close"), op: ">", right: value(0) }] },
        name: "atr",
        stopLoss: { kind: "atr", length: 1, multiple: 2 },
        takeProfit: { kind: "atr", length: 1, multiple: 3 },
        version: 1,
      })
    );
    expect(Array.from(compiled.stopDistance ?? [])).toEqual([4, 4, 4]);
    expect(Array.from(compiled.targetDistance ?? [])).toEqual([6, 6, 6]);
  });

  it("rejects an indicator longer than the series", () => {
    expect(() => compileStrategy(rows([1, 2]), smaCross(1, 3))).toThrow(
      InstantBacktestInputError
    );
  });
});

describe("runSignalBacktest sizing and distance exits", () => {
  const flat = (rows: [number, number, number, number][]): BarColumns => ({
    c: Float64Array.from(rows, (row) => row[3]),
    h: Float64Array.from(rows, (row) => row[1]),
    l: Float64Array.from(rows, (row) => row[2]),
    o: Float64Array.from(rows, (row) => row[0]),
    t: Float64Array.from(rows, (_, index) => index * DAY_MS),
  });

  it("sizes by risk percent and keeps the rest in cash", () => {
    const bars = flat([
      [100, 100, 100, 100],
      [100, 101, 99, 100],
      [100, 100, 89, 95],
    ]);
    const result = runSignalBacktest(bars, Int8Array.of(1, 0, 0), {
      costBps: 0,
      riskPct: 1,
      stopLossPct: 10,
      takeProfitPct: 0,
    });
    // Risk 0.01 over a 10-point stop: 0.001 units, 0.1 of the cash.
    expect(result.trades[0]?.units).toBeCloseTo(0.001, 12);
    expect(result.trades[0]?.exitReason).toBe("stop");
    expect(result.equity[2]).toBeCloseTo(0.99, 12);
    expect(result.trades[0]?.netReturn).toBeCloseTo(-0.1, 12);
  });

  it("caps risk sizing at the available cash", () => {
    const bars = flat([
      [100, 100, 100, 100],
      [100, 101, 99, 100],
      [100, 101, 99, 100],
    ]);
    const result = runSignalBacktest(bars, Int8Array.of(1, 0, 0), {
      costBps: 0,
      riskPct: 50,
      stopLossPct: 1,
      takeProfitPct: 0,
    });
    expect(result.trades[0]?.units).toBeCloseTo(0.01, 12);
  });

  it("uses distance stops and targets read at the signal bar", () => {
    const bars = flat([
      [100, 100, 100, 100],
      [100, 106, 99, 105],
      [100, 100, 100, 100],
    ]);
    const result = runSignalBacktest(bars, Int8Array.of(1, 0, 0), {
      costBps: 0,
      stopDistance: Float64Array.of(2, 0, 0),
      stopLossPct: 0,
      takeProfitPct: 0,
      targetDistance: Float64Array.of(5, 0, 0),
    });
    expect(result.trades[0]).toMatchObject({
      exitPrice: 105,
      exitReason: "target",
    });
  });

  it("skips a risk-sized entry without a stop", () => {
    const bars = flat([
      [100, 100, 100, 100],
      [100, 101, 99, 100],
      [100, 101, 99, 100],
    ]);
    const result = runSignalBacktest(bars, Int8Array.of(1, 0, 0), {
      costBps: 0,
      riskPct: 1,
      stopLossPct: 0,
      takeProfitPct: 0,
    });
    expect(result.trades).toEqual([]);
  });

  it("skips an entry while a configured distance level is not available", () => {
    const bars = flat([
      [100, 100, 100, 100],
      [100, 101, 99, 100],
      [100, 101, 99, 100],
    ]);
    const options = { costBps: 0, stopLossPct: 0, takeProfitPct: 0 };
    for (const level of ["stopDistance", "targetDistance"] as const) {
      const skipped = runSignalBacktest(bars, Int8Array.of(1, 0, 0), {
        ...options,
        [level]: Float64Array.of(Number.NaN, 1, 1),
      });
      expect(skipped.trades).toEqual([]);
      const taken = runSignalBacktest(bars, Int8Array.of(0, 1, 0), {
        ...options,
        [level]: Float64Array.of(Number.NaN, 5, 5),
      });
      expect(taken.trades).toHaveLength(1);
    }
  });

  it("exits on the exit mask even when the signal says enter", () => {
    const bars = flat([
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
    ]);
    const result = runSignalBacktest(bars, Int8Array.of(1, 1, 1, 0), {
      costBps: 0,
      exits: Uint8Array.of(0, 1, 0, 0),
      stopLossPct: 0,
      takeProfitPct: 0,
    });
    expect(result.trades[0]).toMatchObject({
      entryIndex: 1,
      exitIndex: 2,
      exitReason: "signal",
    });
  });

  it("exits at the next open after the maximum hold", () => {
    const bars = flat([
      [100, 100, 100, 100],
      [101, 101, 101, 101],
      [102, 102, 102, 102],
      [103, 103, 103, 103],
      [104, 104, 104, 104],
    ]);
    const result = runSignalBacktest(bars, Int8Array.of(1, 0, 0, 0, 0), {
      costBps: 0,
      maxHoldBars: 2,
      stopLossPct: 0,
      takeProfitPct: 0,
    });
    // Fill at the open of bar 1, held bars 1 and 2, exit at the open of bar 3.
    expect(result.trades).toEqual([
      expect.objectContaining({
        entryIndex: 1,
        entryPrice: 101,
        exitIndex: 3,
        exitPrice: 103,
        exitReason: "signal",
      }),
    ]);
  });

  it("rejects bad signal input", () => {
    const bars = flat([
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ]);
    const options = { costBps: 0, stopLossPct: 0, takeProfitPct: 0 };
    expect(() => runSignalBacktest(bars, Int8Array.of(1), options)).toThrow(
      "Signals must match the bar count"
    );
    for (const riskPct of [0, 101, Number.NaN]) {
      expect(() =>
        runSignalBacktest(bars, Int8Array.of(0, 0), { ...options, riskPct })
      ).toThrow("riskPct must be above 0 and at most 100");
    }
    for (const maxHoldBars of [0, 1.5, Number.NaN]) {
      expect(() =>
        runSignalBacktest(bars, Int8Array.of(0, 0), {
          ...options,
          maxHoldBars,
        })
      ).toThrow("maxHoldBars must be a whole number of at least 1");
    }
  });
});

type ReferenceLine = readonly (number | null)[];
const reference = JSON.parse(
  readFileSync(
    new URL(
      "../../../services/research/tests/fixtures/indicator-reference.json",
      import.meta.url
    ),
    "utf8"
  )
) as {
  bars: Readonly<Record<"high" | "low" | "close", readonly number[]>>;
  expected: Readonly<{ adx_14: Readonly<{ adx: ReferenceLine }> }>;
};

const gsQuantReference = JSON.parse(
  readFileSync(
    new URL(
      "../../../services/research/tests/fixtures/gs-quant-reference.json",
      import.meta.url
    ),
    "utf8"
  )
) as { expected: Readonly<Record<string, ReferenceLine>> };

describe("zscore and realizedVol (gs-quant conventions)", () => {
  it("match gs-quant 2.2.4 zscores and volatility on every defined bar", () => {
    const close = Float64Array.from(reference.bars.close);
    for (const length of [5, 20]) {
      const cases = [
        [rollingZScore(close, length), `zscore_${length}`],
        [realizedVolatility(close, length), `realized_vol_${length}`],
      ] as const;
      for (const [actual, key] of cases) {
        const expected = gsQuantReference.expected[key] ?? [];
        expect(
          expected.filter((value) => value !== null).length
        ).toBeGreaterThan(0);
        for (const [index, value] of expected.entries()) {
          if (value === null)
            expect(actual[index], `${key} ${index}`).toBeNaN();
          else expect(actual[index], `${key} ${index}`).toBeCloseTo(value, 9);
        }
      }
    }
  });

  it("match a two-pass brute force with gaps, flat stretches and long windows", () => {
    // Deterministic noise with a non-finite gap and a flat stretch after a volatile one.
    let state = 7;
    const noise = () => {
      state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
      return state / 2 ** 31 - 0.5;
    };
    const values = Float64Array.from({ length: 3000 }, (_, index) => {
      if (index >= 1200 && index < 1203) return Number.NaN;
      if (index >= 2000 && index < 2300) return 123.456;
      return 100 + 40 * noise();
    });
    const exact = (end: number, length: number) => {
      const window = Array.from(values.subarray(end - length + 1, end + 1));
      if (window.some((value) => !Number.isFinite(value)))
        return { deviation: Number.NaN, mean: Number.NaN };
      const mean = window.reduce((sum, value) => sum + value, 0) / length;
      const squares = window.reduce(
        (sum, value) => sum + (value - mean) ** 2,
        0
      );
      return { deviation: Math.sqrt(squares / (length - 1)), mean };
    };
    for (const length of [2, 7, 50, 1000]) {
      const z = rollingZScore(values, length);
      for (let index = 0; index < values.length; index += 1) {
        if (index < length - 1) {
          expect(z[index]).toBeNaN();
          continue;
        }
        const { mean, deviation } = exact(index, length);
        const flat = values
          .subarray(index - length + 1, index + 1)
          .every((value) => value === values[index]);
        if (Number.isNaN(deviation) || flat)
          expect(z[index], `${length} ${index}`).toBeNaN();
        else
          expect(z[index], `${length} ${index}`).toBeCloseTo(
            ((values[index] as number) - mean) / deviation,
            8
          );
      }
    }
  });

  it("match hand cases, flat windows and non-positive prices", () => {
    // Windows [1, 2, 4] and [2, 4, 8]: (x - mean) / sample deviation.
    const z = rollingZScore(Float64Array.of(1, 2, 4, 8), 3);
    expect(nanToNull(z.slice(0, 2))).toEqual([null, null]);
    expect(z[2]).toBeCloseTo(5 / Math.sqrt(21), 12);
    expect(z[3]).toBeCloseTo(10 / Math.sqrt(84), 12);
    const flat = rollingZScore(Float64Array.of(5, 5, 5, 6), 2);
    expect(nanToNull(flat.slice(0, 3))).toEqual([null, null, null]);
    expect(flat[3]).toBeCloseTo(Math.SQRT1_2, 12);
    const vol = realizedVolatility(Float64Array.of(100, 110, 99, 99), 2);
    const scale = 100 * Math.sqrt(REALIZED_VOL_PERIODS_PER_YEAR);
    expect(nanToNull(vol.slice(0, 2))).toEqual([null, null]);
    expect(vol[2]).toBeCloseTo(scale * Math.sqrt(0.02), 9);
    expect(vol[3]).toBeCloseTo(scale * Math.sqrt(0.005), 9);
    expect(
      nanToNull(realizedVolatility(Float64Array.of(7, 7, 7, 7), 2))
    ).toEqual([null, null, 0, 0]);
    expect(
      nanToNull(realizedVolatility(Float64Array.of(1, 2, 0, 2, 4, 8), 2))
    ).toEqual([null, null, null, null, null, 0]);
    // Too few bars for one full window: nothing is available.
    expect(nanToNull(realizedVolatility(Float64Array.of(1, 2, 3), 3))).toEqual([
      null,
      null,
      null,
    ]);
    expect(nanToNull(rollingZScore(Float64Array.of(1, 2), 3))).toEqual([
      null,
      null,
    ]);
  });
});

describe("adx", () => {
  it("matches the TA-Lib ADX 14 reference on every defined bar", () => {
    const { high, low, close } = reference.bars;
    const actual = averageDirectionalIndex(
      {
        c: Float64Array.from(close),
        h: Float64Array.from(high),
        l: Float64Array.from(low),
        o: Float64Array.from(close),
        t: Float64Array.from(close, (_, index) => index * DAY_MS),
      },
      14
    );
    const expected = reference.expected.adx_14.adx;
    expect(expected.filter((value) => value !== null).length).toBeGreaterThan(
      0
    );
    for (const [index, value] of expected.entries()) {
      if (value === null) expect(actual[index], `bar ${index}`).toBeNaN();
      else expect(actual[index], `bar ${index}`).toBeCloseTo(value, 9);
    }
  });

  it("is 0 on flat bars and matches a hand case", () => {
    const flat = Float64Array.of(5, 5, 5);
    expect(
      nanToNull(
        averageDirectionalIndex(
          { c: flat, h: flat, l: flat, o: flat, t: Float64Array.of(0, 1, 2) },
          1
        )
      )
    ).toEqual([null, 0, 0]);
    const bars = {
      c: Float64Array.of(9, 11, 12, 11, 13),
      h: Float64Array.of(10, 12, 13, 12, 14),
      l: Float64Array.of(8, 9, 11, 10, 11),
      o: Float64Array.of(9, 11, 12, 11, 13),
      t: Float64Array.of(0, 1, 2, 3, 4),
    };
    // Same bars as the chart hand case: ADX(2) = [-, -, -, 50, (50 + 200/3) / 2].
    expect(nanToNull(averageDirectionalIndex(bars, 2))).toEqual([
      null,
      null,
      null,
      50,
      Math.round(((50 + 200 / 3) / 2) * 1e6) / 1e6,
    ]);
  });
});

describe("rvol", () => {
  // January dates: New York is UTC-5, so 09:30 New York is 14:30 UTC.
  const at = (day: number, hour: number, minute: number) =>
    Date.UTC(2024, 0, day, hour, minute);

  it("matches the shared intraday hand case", () => {
    const t = Float64Array.of(
      at(2, 14, 30),
      at(2, 14, 35),
      at(3, 14, 30),
      at(3, 14, 35),
      at(4, 14, 30),
      at(4, 14, 35)
    );
    const v = Float64Array.of(10, 20, 30, 10, 20, 40);
    expect(nanToNull(relativeVolumeAtTime(t, v, 2))).toEqual([
      null,
      null,
      null,
      null,
      1,
      Math.round((60 / 35) * 1e6) / 1e6,
    ]);
  });

  it("uses the last earlier slot, 0 before any bar, and NaN on a zero mean", () => {
    const t = Float64Array.of(
      at(2, 14, 30),
      at(2, 14, 35),
      at(3, 14, 30),
      at(3, 14, 35),
      at(4, 14, 25),
      at(4, 14, 32)
    );
    const v = Float64Array.of(10, 20, 30, 10, 5, 15);
    // 09:25 has no earlier bar in D1 or D2 (mean 0); 09:32 uses the 09:30 totals (10, 30).
    expect(nanToNull(relativeVolumeAtTime(t, v, 2))).toEqual([
      null,
      null,
      null,
      null,
      null,
      1,
    ]);
  });

  it("keeps one New York date together across UTC midnight", () => {
    // 23:30 and 00:30 UTC are 18:30 and 19:30 on the same New York date.
    const t = Float64Array.of(
      at(2, 23, 30),
      at(3, 0, 30),
      at(3, 23, 30),
      at(4, 0, 30),
      at(4, 23, 30),
      at(5, 0, 30)
    );
    const v = Float64Array.of(10, 20, 30, 10, 20, 40);
    expect(nanToNull(relativeVolumeAtTime(t, v, 2))).toEqual([
      null,
      null,
      null,
      null,
      1,
      Math.round((60 / 35) * 1e6) / 1e6,
    ]);
  });

  it("equals volume over the mean of previous volumes on daily bars", () => {
    const t = Float64Array.from({ length: 4 }, (_, index) =>
      at(2 + index, 0, 0)
    );
    expect(
      nanToNull(relativeVolumeAtTime(t, Float64Array.of(10, 30, 20, 50), 2))
    ).toEqual([null, null, 1, 2]);
  });

  it("follows daylight saving time in New York on intraday bars", () => {
    // 2024-03-10 New York moves to UTC-4: 09:30 is 14:30 UTC before and 13:30 UTC after.
    const t = Float64Array.of(
      Date.UTC(2024, 2, 8, 14, 30),
      Date.UTC(2024, 2, 8, 15, 30),
      Date.UTC(2024, 2, 11, 13, 30),
      Date.UTC(2024, 2, 11, 14, 30)
    );
    expect(
      nanToNull(relativeVolumeAtTime(t, Float64Array.of(10, 10, 30, 10), 1))
    ).toEqual([null, null, 3, 2]);
  });

  it.each([
    ["UTC midnight", 0],
    ["21:00 UTC", 21],
  ])(
    "is 1 on constant-volume daily bars at %s across the November change",
    (_, hour) => {
      const t = Float64Array.from({ length: 60 }, (_, index) =>
        Date.UTC(2024, 9, 1 + index, hour)
      );
      const values = nanToNull(
        relativeVolumeAtTime(t, new Float64Array(60).fill(500), 20)
      );
      expect(values.slice(0, 20)).toEqual(new Array(20).fill(null));
      expect(values.slice(20)).toEqual(new Array(40).fill(1));
    }
  );
});

describe("runStrategyDefinition costs", () => {
  it("passes a cost profile to the engine", () => {
    const profile = Object.values(COST_PROFILE_PRESETS)[0];
    if (profile === undefined) throw new Error("no cost profile");
    const result = runStrategyDefinition(wave(300), smaCross(10, 30), 0, {
      capital: 100_000,
      profile,
    });
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades[0]?.costs).toBeDefined();
  });
});

describe("offset and new indicators in definitions", () => {
  const rows = (closes: number[], volumes?: number[]): BarColumns => ({
    c: Float64Array.from(closes),
    h: Float64Array.from(closes, (close) => close + 1),
    l: Float64Array.from(closes, (close) => close - 1),
    o: Float64Array.from(closes),
    t: Float64Array.from(closes, (_, index) => index * DAY_MS),
    ...(volumes === undefined ? {} : { v: Float64Array.from(volumes) }),
  });
  const signals = (bars: BarColumns, input: StrategyDefinitionInput["entry"]) =>
    Array.from(
      compileStrategy(bars, define({ entry: input, name: "x", version: 1 }))
        .signals
    );

  it("reads a price series bars ago and caches by offset", () => {
    const close = { field: "close", type: "price" } as const;
    const ago = { field: "close", offset: 1, type: "price" } as const;
    expect(
      signals(rows([1, 2, 3, 2, 4]), {
        all: [
          { left: close, op: ">", right: ago },
          { left: close, op: ">=", right: ago },
        ],
      })
    ).toEqual([0, 1, 1, 0, 1]);
    expect(
      signals(rows([1, 2, 3, 2, 4]), {
        all: [
          { left: close, op: "crossesAbove", right: ago },
          {
            left: close,
            op: ">",
            right: { field: "close", offset: 1000, type: "price" },
          },
        ],
      })
    ).toEqual([0, 0, 0, 0, 0]);
    expect(
      signals(rows([1, 2, 3, 2, 4]), {
        all: [{ left: close, op: "crossesAbove", right: ago }],
      })
    ).toEqual([0, 1, 0, 0, 1]);
  });

  it("expresses ADX above a level and ADX falling over bars", () => {
    const bars = wave(200);
    const adx = { length: 14, name: "adx", type: "indicator" } as const;
    const adxAgo = { ...adx, offset: 5 } as const;
    const series = averageDirectionalIndex(bars, 14);
    const above = signals(bars, {
      all: [{ left: adx, op: ">", right: { type: "const", value: 20 } }],
    });
    expect(above).toEqual(Array.from(series, (value) => (value > 20 ? 1 : 0)));
    const falling = signals(bars, {
      all: [
        { left: adx, op: "<", right: adxAgo },
        { left: adxAgo, op: ">", right: { type: "const", value: 0 } },
      ],
    });
    expect(falling).toEqual(
      Array.from(series, (value, index) =>
        index >= 5 && value < (series[index - 5] as number) ? 1 : 0
      )
    );
    expect(falling.some((value) => value === 1)).toBe(true);
  });

  it("expresses a z-score stretch and a volatility ceiling", () => {
    const bars = wave(200);
    const z = { length: 20, name: "zscore", type: "indicator" } as const;
    const vol = { length: 10, name: "realizedVol", type: "indicator" } as const;
    const zSeries = rollingZScore(bars.c, 20);
    const volSeries = realizedVolatility(bars.c, 10);
    const entry = signals(bars, {
      all: [
        { left: z, op: "<", right: { type: "const", value: -1 } },
        { left: vol, op: "<", right: { type: "const", value: 50 } },
      ],
    });
    expect(entry).toEqual(
      Array.from(zSeries, (value, index) =>
        value < -1 && (volSeries[index] as number) < 50 ? 1 : 0
      )
    );
    expect(entry.some((value) => value === 1)).toBe(true);
  });

  it("runs rvol from bar volume and rejects bars without volume", () => {
    const rvol = { length: 2, name: "rvol", type: "indicator" } as const;
    const entry: StrategyDefinitionInput["entry"] = {
      all: [{ left: rvol, op: ">=", right: { type: "const", value: 1 } }],
    };
    expect(signals(rows([1, 1, 1, 1], [10, 30, 20, 50]), entry)).toEqual([
      0, 0, 1, 1,
    ]);
    expect(() => signals(rows([1, 1, 1, 1]), entry)).toThrow(
      InstantBacktestInputError
    );
  });
});

describe("sector quadrant filters", () => {
  // Entry on every bar with close > 0; no exit, so the first allowed bar is the only entry.
  const filtered = (timeframe: "daily" | "weekly" = "weekly") =>
    define({
      entry: {
        all: [
          {
            left: { field: "close", type: "price" },
            op: ">",
            right: { type: "const", value: 0 },
          },
        ],
      },
      filters: [
        {
          quadrants: ["leading", "improving"],
          sector: "XLK",
          timeframe,
          type: "sectorQuadrant",
        },
      ],
      name: "Filtered",
      version: 1,
    });
  const daily = wave(10); // 1970-01-01 to 1970-01-10
  const signalsOf = (
    bars: BarColumns,
    points: readonly SectorQuadrantPoint[]
  ) =>
    Array.from(
      compileStrategy(bars, filtered(), { "XLK:weekly": points }).signals
    );

  it("blocks entries on a lagging week and allows them on a leading week, as of each bar", () => {
    expect(
      signalsOf(daily, [
        { date: "1970-01-02", quadrant: "lagging" },
        { date: "1970-01-05", quadrant: "leading" },
        { date: "1970-01-08", quadrant: "weakening" },
      ])
    ).toEqual([0, 0, 0, 0, 1, 1, 1, 0, 0, 0]);
  });

  it("ignores points dated after the bar (no lookahead) and fails closed before any point", () => {
    expect(
      signalsOf(daily, [{ date: "1970-01-20", quadrant: "leading" }])
    ).toEqual(Array.from({ length: 10 }, () => 0));
  });

  it("uses only earlier dates for intraday bars", () => {
    const hourly = wave(30, HOUR_MS); // 1970-01-01 00:00 to 1970-01-02 05:00
    const signals = signalsOf(hourly, [
      { date: "1970-01-01", quadrant: "leading" },
    ]);
    expect(signals.slice(0, 24).every((value) => value === 0)).toBe(true);
    expect(signals.slice(24).every((value) => value === 1)).toBe(true);
  });

  it("does not block exits", () => {
    const definition = define({
      ...filtered(),
      exit: {
        any: [
          {
            left: { field: "close", type: "price" },
            op: ">",
            right: { type: "const", value: 0 },
          },
        ],
      },
    });
    const compiled = compileStrategy(daily, definition, {
      "XLK:weekly": [{ date: "1970-01-01", quadrant: "lagging" }],
    });
    expect(Array.from(compiled.signals)).toEqual(
      Array.from({ length: 10 }, () => -1)
    );
  });

  it("throws a typed error when the series is missing", () => {
    expect(() => runStrategyDefinition(daily, filtered("daily"), 0)).toThrow(
      new SectorQuadrantDataError("XLK", "daily")
    );
    expect(() => compileStrategy(daily, filtered(), {})).toThrow(
      "Sector quadrant data is not available for XLK (weekly)"
    );
    try {
      compileStrategy(daily, filtered(), {});
    } catch (error) {
      expect(error).toBeInstanceOf(InstantBacktestInputError);
      expect(error).toBeInstanceOf(SectorQuadrantDataError);
    }
  });

  it("runs a filtered definition with series", () => {
    const run = runStrategyDefinition(daily, filtered(), 0, undefined, {
      "XLK:weekly": [{ date: "1970-01-03", quadrant: "improving" }],
    });
    expect(run.trades.length).toBe(1);
  });
});

/** Weekday YYYY-MM-DD dates from `from` to `to`, inclusive, without `skip`. */
const weekdayDates = (
  from: string,
  to: string,
  skip: readonly string[] = []
): string[] => {
  const dates: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6 && !skip.includes(date)) dates.push(date);
  }
  return dates;
};

/** Daily bars dated `dates` (close 100, 101, ...), or `hours` bars on each date. */
const barsOn = (dates: readonly string[], hours = 0): BarColumns => {
  const t = Float64Array.from(
    dates.flatMap((date) =>
      hours === 0
        ? [Date.parse(`${date}T00:00:00Z`)]
        : Array.from(
            { length: hours },
            (_, hour) => Date.parse(`${date}T00:00:00Z`) + hour * HOUR_MS
          )
    )
  );
  const c = Float64Array.from(t, (_, index) => 100 + index);
  return {
    c,
    h: c.map((value) => value + 1),
    l: c.map((value) => value - 1),
    o: c,
    t,
  };
};

const closeAbove = (value: number) => ({
  left: { field: "close" as const, type: "price" as const },
  op: ">" as const,
  right: { type: "const" as const, value },
});

/** Entry on every bar, so the signals are the filter mask. */
const filtered = (...filters: unknown[]): StrategyDefinition =>
  define({
    entry: { all: [closeAbove(0)] },
    filters,
    name: "Filtered",
    version: 1,
  } as StrategyDefinitionInput);

const maskOf = (
  bars: BarColumns,
  filter: unknown,
  context?: StrategySeriesContext,
  symbol?: string
): number[] =>
  Array.from(
    compileStrategy(
      bars,
      filtered(filter),
      undefined,
      context === undefined
        ? undefined
        : { context, ...(symbol === undefined ? {} : { symbol }) }
    ).signals
  );

const ones = (size: number, at: readonly number[]): number[] =>
  Array.from({ length: size }, (_, index) => (at.includes(index) ? 1 : 0));

const byDate = (
  dates: readonly string[],
  values: readonly number[]
): Record<string, number> =>
  Object.fromEntries(
    dates.map((date, index) => [date, values[index] as number])
  );

describe("ivRank filter", () => {
  it("ranks each value in the window ending at it, NaN when flat", () => {
    expect(
      nanToNull(ivRankSeries(Float64Array.from([1, 3, 2, 2, 2, 2, 5]), 3))
    ).toEqual([null, null, 50, 0, null, null, 100]);
  });

  // VXN (the QQQ index) rises 0..21, then 10, 5, 30. Rank over 20 values: 100 at 19 to 21,
  // 38.9 at 22, 5.9 at 23, 100 at 24. The bars skip date 20.
  const dates = weekdayDates("2024-01-01", "2024-02-02");
  const vxn = byDate(dates, [
    ...Array.from({ length: 22 }, (_, index) => index),
    10,
    5,
    30,
  ]);
  const bars = barsOn(dates.filter((_, index) => index !== 20));

  it("passes on bars whose index rank is inside the bounds", () => {
    expect(dates.length).toBe(25);
    expect(
      maskOf(bars, { length: 20, min: 50, type: "ivRank" }, { VXN: vxn }, "QQQ")
    ).toEqual(ones(24, [19, 20, 23]));
    expect(
      maskOf(bars, { length: 20, max: 10, type: "ivRank" }, { VXN: vxn }, "QQQ")
    ).toEqual(ones(24, [22]));
    expect(
      maskOf(
        bars,
        { length: 20, max: 40, min: 30, type: "ivRank" },
        { VXN: vxn },
        "QQQ"
      )
    ).toEqual(ones(24, [21]));
  });

  it("uses the previous date's rank for intraday bars", () => {
    const hourly = barsOn([dates[21] as string, dates[24] as string], 24);
    expect(
      maskOf(
        hourly,
        { length: 20, max: 10, type: "ivRank" },
        { VXN: vxn },
        "QQQ"
      )
    ).toEqual([...ones(24, []), ...Array.from({ length: 24 }, () => 1)]);
  });

  it("needs the traded symbol, its index and the index series", () => {
    const filter = { length: 20, min: 50, type: "ivRank" };
    expect(() => maskOf(bars, filter)).toThrow(
      "ivRank needs the traded symbol"
    );
    expect(() => maskOf(bars, filter, {}, "toString")).toThrow(
      "ivRank has no implied-volatility index for toString"
    );
    expect(() => maskOf(bars, filter, { VXN: vxn }, "SPY")).toThrow(
      new StrategySeriesDataError("VIX")
    );
    const error = new StrategySeriesDataError("VIX");
    expect(error).toBeInstanceOf(InstantBacktestInputError);
    expect(error.name).toBe("StrategySeriesDataError");
  });
});

describe("vixTermStructure and volRegime filters", () => {
  const dates = weekdayDates("2024-01-01", "2024-01-08");
  const [d0, d1, d2, d3, d4, d5] = dates as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const bars = barsOn(dates);
  // Ratios: d0 1, d1 0.9, d3 1.2. None on d2 (VIX3M 0), d4 (no VIX3M) and d5 (no VIX).
  const context: StrategySeriesContext = {
    VIX: { [d0]: 20, [d1]: 18, [d2]: 15, [d3]: 30, [d4]: 16 },
    VIX3M: {
      "2023-12-29": 10,
      [d0]: 20,
      [d1]: 20,
      [d2]: 0,
      [d3]: 25,
      [d4]: Number.NaN,
      [d5]: 20,
    },
  };

  it("passes on bar dates whose VIX / VIX3M is inside the bounds, without carrying values", () => {
    expect(
      maskOf(bars, { maxRatio: 1, type: "vixTermStructure" }, context)
    ).toEqual([1, 1, 0, 0, 0, 0]);
    expect(
      maskOf(bars, { minRatio: 1.1, type: "vixTermStructure" }, context)
    ).toEqual([0, 0, 0, 1, 0, 0]);
    expect(() =>
      maskOf(bars, { maxRatio: 1, type: "vixTermStructure" }, { VIX: {} })
    ).toThrow("Series data is not available for VIX3M");
  });

  it("needs VIX, the term ratio and the SPY trend together", () => {
    // SPY 10 11 12 11 13 14: above its 3-day average on d2, d4 and d5.
    const regime: StrategySeriesContext = {
      SPY: byDate(dates, [10, 11, 12, 11, 13, 14]),
      VIX: byDate(dates, [15, 15, 15, 15, 15, 25]),
      VIX3M: byDate(dates, [16, 16, 16, 16, 14, 16]),
    };
    expect(
      maskOf(
        bars,
        { maxTermRatio: 1, maxVix: 20, trendLength: 3, type: "volRegime" },
        regime
      )
    ).toEqual([0, 0, 1, 0, 0, 0]);
    expect(
      maskOf(bars, { maxTermRatio: 1, maxVix: 20, type: "volRegime" }, regime)
    ).toEqual([0, 0, 0, 0, 0, 0]);
    expect(() =>
      maskOf(
        bars,
        { maxTermRatio: 1, maxVix: 20, type: "volRegime" },
        { VIX: { [d0]: 15 }, VIX3M: {} }
      )
    ).toThrow("Series data is not available for SPY");
  });
});

describe("calendarWindow filter", () => {
  // Spring 2019 from 6 March: Good Friday on the April expiration (19 April) and Memorial Day.
  const dates = weekdayDates("2019-03-06", "2019-05-30", [
    "2019-04-19",
    "2019-05-27",
  ]);
  const bars = barsOn(dates);
  const passing = (filter: unknown, on = bars, list = dates) =>
    maskOf(on, filter)
      .map((value, index) => (value === 1 ? list[index] : undefined))
      .filter((date) => date !== undefined);

  it("passes the last and first trading days around each month end", () => {
    // 6 March is the 4th trading day of March (1, 4 and 5 March have no bars but are weekdays
    // before the first bar); 31 May (after the last bar) counts as a trading day.
    expect(
      passing({
        fromDay: -2,
        toDay: 3,
        type: "calendarWindow",
        window: "turnOfMonth",
      })
    ).toEqual([
      "2019-03-28",
      "2019-03-29",
      "2019-04-01",
      "2019-04-02",
      "2019-04-03",
      "2019-04-29",
      "2019-04-30",
      "2019-05-01",
      "2019-05-02",
      "2019-05-03",
      "2019-05-30",
    ]);
  });

  it("passes the opex week from the prior trading day, with a holiday expiration moved earlier", () => {
    expect(passing({ type: "calendarWindow", window: "opexWeek" })).toEqual([
      "2019-03-08",
      "2019-03-11",
      "2019-03-12",
      "2019-03-13",
      "2019-03-14",
      "2019-03-15",
      "2019-04-12",
      "2019-04-15",
      "2019-04-16",
      "2019-04-17",
      "2019-04-18",
      "2019-05-10",
      "2019-05-13",
      "2019-05-14",
      "2019-05-15",
      "2019-05-16",
      "2019-05-17",
    ]);
    // Bars from Tuesday of the opex week: the window opens on Friday 8 March, before the bars.
    const late = weekdayDates("2019-03-12", "2019-03-20");
    expect(
      passing(
        { type: "calendarWindow", window: "opexWeek" },
        barsOn(late),
        late
      )
    ).toEqual(["2019-03-12", "2019-03-13", "2019-03-14", "2019-03-15"]);
  });

  it("passes listed months and works on intraday bars", () => {
    const april = passing({
      months: [4],
      type: "calendarWindow",
      window: "months",
    });
    expect(april.length).toBe(21);
    expect(april.every((date) => date?.startsWith("2019-04"))).toBe(true);
    // Intraday bars are refused, whatever the window: the UTC date is not the session.
    const hourly = barsOn(["2019-03-29", "2019-04-01"], 2);
    for (const window of ["months", "opexWeek"] as const) {
      const filter =
        window === "months"
          ? { months: [4], type: "calendarWindow", window }
          : { type: "calendarWindow", window };
      expect(() => maskOf(hourly, filter)).toThrow(
        new StrategyUnsupportedError(STRATEGY_CALENDAR_INTRADAY_REFUSAL)
      );
    }
  });

  it("takes trading days from the NYSE holiday rules, not from the bars", () => {
    // No bars on 1, 4 and 5 March or around the holiday: the rules still count them. A bar on a
    // Saturday or on Good Friday is outside the turn-of-month and opex windows.
    const sparse = ["2019-04-15", "2019-04-18", "2019-04-19", "2019-04-20"];
    expect(
      maskOf(barsOn(sparse), { type: "calendarWindow", window: "opexWeek" })
    ).toEqual([1, 1, 0, 0]);
    const monthEnd = ["2019-03-29", "2019-03-30", "2019-04-01", "2019-04-02"];
    expect(
      maskOf(barsOn(monthEnd), {
        fromDay: -1,
        toDay: 1,
        type: "calendarWindow",
        window: "turnOfMonth",
      })
    ).toEqual([1, 0, 1, 0]);
  });

  it("knows the NYSE holiday rules", () => {
    const iso = (year: number) =>
      [...nyseHolidays(year)]
        .sort((a, b) => a - b)
        .map((day) => new Date(day * DAY_MS).toISOString().slice(0, 10));
    // 2021: New Year on a Friday; 2022 New Year is a Saturday, so 31 Dec 2021 trades.
    expect(iso(2021)).toEqual([
      "2021-01-01",
      "2021-01-18",
      "2021-02-15",
      "2021-04-02",
      "2021-05-31",
      "2021-07-05",
      "2021-09-06",
      "2021-11-25",
      "2021-12-24",
    ]);
    expect(iso(2022)).toContain("2022-06-20");
    expect(iso(2022)).not.toContain("2021-12-31");
    expect(iso(2023)).toContain("2023-01-02");
    expect(iso(2027)).toContain("2027-06-18");
    expect(nyseHolidays(2021)).toBe(nyseHolidays(2021));
    expect(isNyseTradingDay(Date.parse("2021-12-31") / DAY_MS)).toBe(true);
    expect(isNyseTradingDay(Date.parse("2021-07-05") / DAY_MS)).toBe(false);
    expect(isNyseTradingDay(Date.parse("2021-07-03") / DAY_MS)).toBe(false);
  });
});

describe("series filter", () => {
  const dates = weekdayDates("2024-01-08", "2024-01-15");
  const [d0, d1, d2, d3, d4] = dates as [
    string,
    string,
    string,
    string,
    string,
  ];
  const bars = barsOn(dates);
  const seriesFilter = (condition: unknown, series = "GC=F") => ({
    condition,
    series,
    type: "series",
  });

  it("carries a value at most five trading days (bar dates), daily and intraday", () => {
    const days = weekdayDates("2024-01-08", "2024-01-22");
    const above = seriesFilter(closeAbove(100));
    const context = {
      "GC=F": { [days[0] as string]: 101, [days[8] as string]: 102 },
    };
    expect(STRATEGY_SERIES_MAX_FILL_DAYS).toBe(5);
    expect(maskOf(barsOn(days), above, context)).toEqual([
      1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1,
    ]);
    // Intraday: the value of day 0 is usable from day 1 on, for 5 more bar dates.
    expect(maskOf(barsOn(days.slice(0, 8), 2), above, context)).toEqual([
      0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0,
    ]);
  });

  it("compares the latest series value on or before each bar date", () => {
    // No value on d1 (d0 carries) and a Saturday value for Monday d5.
    const context = {
      "GC=F": {
        "2024-01-05": 101,
        "2024-01-13": 103,
        [d0]: 99,
        [d2]: 102,
      },
    };
    expect(maskOf(bars, seriesFilter(closeAbove(100)), context)).toEqual([
      0, 0, 1, 1, 1, 1,
    ]);
    expect(
      maskOf(bars, seriesFilter(closeAbove(100)), { "GC=F": { [d2]: 101 } })
    ).toEqual([0, 0, 1, 1, 1, 1]);
  });

  it("evaluates indicators on the series dates and crosses on the bars", () => {
    const context = {
      "ES=F": byDate([d0, d1, d2, d3, d4], [99, 101, 102, 99, 101]),
    };
    expect(
      maskOf(
        bars,
        seriesFilter({ ...closeAbove(100), op: "crossesAbove" }, "ES=F"),
        context
      )
    ).toEqual([0, 1, 0, 0, 1, 0]);
    // sma(2) of 99 101 102 99 101 = -, 100, 101.5, 100.5, 100.
    expect(
      maskOf(
        bars,
        seriesFilter(
          {
            left: { length: 2, name: "sma", type: "indicator" },
            op: ">=",
            right: { type: "const", value: 100.5 },
          },
          "ES=F"
        ),
        context
      )
    ).toEqual([0, 0, 1, 1, 0, 0]);
  });

  it("uses only earlier dates for intraday bars", () => {
    expect(
      maskOf(barsOn([d1, d2], 2), seriesFilter(closeAbove(100)), {
        "GC=F": { [d0]: 101, [d1]: 99 },
      })
    ).toEqual([1, 1, 0, 0]);
  });

  it("blocks every entry when the series has no values, and rejects bad input", () => {
    const sma = seriesFilter({
      left: { length: 50, name: "sma", type: "indicator" },
      op: ">",
      right: { type: "const", value: 0 },
    });
    expect(maskOf(bars, sma, { "GC=F": { [d0]: Number.NaN } })).toEqual(
      ones(6, [])
    );
    expect(() => maskOf(bars, sma, { "GC=F": { [d0]: 1 } })).toThrow(
      "sma length 50 is longer than the 1 bars"
    );
    expect(() =>
      maskOf(bars, seriesFilter(closeAbove(1)), { "GC=F": { "2024-1-8": 1 } })
    ).toThrow("Series GC=F has a date that is not YYYY-MM-DD: 2024-1-8");
    expect(() => maskOf(bars, seriesFilter(closeAbove(1)), {})).toThrow(
      new StrategySeriesDataError("GC=F")
    );
    expect(() =>
      compileStrategy(bars, filtered(seriesFilter(closeAbove(1))))
    ).toThrow(new StrategySeriesDataError("GC=F"));
  });
});

describe("filters with exits, runs and the options block", () => {
  const dates = weekdayDates("2024-01-01", "2024-01-12");
  const bars = barsOn(dates);
  const options = {
    dte: { min: 21, target: 45 },
    maxLossPct: 2,
    shortDelta: 0.2,
    structure: "putCreditVertical" as const,
    widthSigma: 0.5,
  };
  const definition = define({
    entry: { all: [closeAbove(0)] },
    exit: { any: [closeAbove(104)] },
    filters: [
      { months: [2], type: "calendarWindow", window: "months" },
      {
        condition: closeAbove(0),
        series: "VIX",
        type: "series",
      },
    ],
    name: "Options",
    options,
    version: 1,
  });

  it("never blocks exits and hands the options block to the runner unchanged", () => {
    const compiled = compileStrategy(bars, definition, undefined, {
      context: {
        VIX: byDate(
          dates,
          dates.map(() => 15)
        ),
      },
    });
    expect(Array.from(compiled.signals)).toEqual([
      0, 0, 0, 0, 0, -1, -1, -1, -1, -1,
    ]);
    expect(compiled.options).toBe(definition.options);
    expect(compiled.options).toEqual(options);
    expect(
      "options" in
        compileStrategy(wave(60), define(STRATEGY_TEMPLATES.smaCross))
    ).toBe(false);
  });

  it("runs calendar filters on the server engine and refuses series filters there", () => {
    const run = runStrategyDefinition(
      bars,
      filtered({ months: [1], type: "calendarWindow", window: "months" }),
      0
    );
    expect(run.trades.length).toBe(1);
    const series = filtered({
      condition: closeAbove(14),
      series: "VIX",
      type: "series",
    });
    expect(() => runStrategyDefinition(bars, series, 0)).toThrow(
      "STRATEGY_SERIES_FILTERS_UNSUPPORTED: the series filters need daily series"
    );
    // Research runners compile it with their context.
    expect(
      Array.from(
        compileStrategy(bars, series, undefined, {
          context: {
            VIX: byDate(
              dates,
              dates.map(() => 15)
            ),
          },
        }).signals
      )
    ).toEqual(dates.map(() => 1));
  });
});

describe("engine refusals", () => {
  const options = {
    dte: { min: 21, target: 45 },
    maxLossPct: 2,
    structure: "putCreditVertical" as const,
    widthSigma: 0.5,
  };

  it("never runs an options block as an equity strategy, but still compiles it", () => {
    const definition = define({ ...STRATEGY_TEMPLATES.smaCross, options });
    expect(() => runStrategyDefinition(wave(60), definition, 0)).toThrow(
      new StrategyUnsupportedError(STRATEGY_OPTIONS_REFUSAL)
    );
    try {
      runStrategyDefinition(wave(60), definition, 0);
    } catch (error) {
      expect(error).toBeInstanceOf(InstantBacktestInputError);
      expect((error as StrategyUnsupportedError).code).toBe(
        "STRATEGY_OPTIONS_UNSUPPORTED"
      );
      expect((error as Error).name).toBe("StrategyUnsupportedError");
    }
    expect(compileStrategy(wave(60), definition).options).toEqual(options);
  });

  it("asserts that the server engines can run a definition", () => {
    expect(() =>
      assertServerRunnable({
        filters: [{ type: "calendarWindow", window: "opexWeek" }],
      })
    ).not.toThrow();
    expect(() =>
      assertServerRunnable({
        filters: [
          { maxTermRatio: 1, maxVix: 20, trendLength: 200, type: "volRegime" },
        ],
      })
    ).toThrow(
      "STRATEGY_SERIES_FILTERS_UNSUPPORTED: the volRegime filters need daily series"
    );
    expect(() => assertServerRunnable({ options })).toThrow(
      STRATEGY_OPTIONS_REFUSAL.message
    );
  });
});
