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
  STRATEGY_TEMPLATES,
  type StrategyDefinition,
  type StrategyDefinitionInput,
  StrategyDefinitionSchema,
} from "./strategy-dsl.ts";
import {
  averageDirectionalIndex,
  averageTrueRange,
  compileStrategy,
  exponentialMean,
  relativeStrength,
  relativeVolumeAtTime,
  runStrategyDefinition,
  SectorQuadrantDataError,
  type SectorQuadrantPoint,
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
