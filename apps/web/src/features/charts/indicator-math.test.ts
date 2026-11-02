import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adx,
  atr,
  bollinger,
  ema,
  type Line,
  lwma,
  MAX_INDICATOR_PERIOD,
  macd,
  parabolicSar,
  rvolAtTime,
  sma,
  smma,
  stochastic,
  trueRange,
  valueAt,
} from "./indicator-math.ts";

// Same synthetic bars and TA-Lib output the Python research tests use.
type Reference = Readonly<{
  source: string;
  bars: Readonly<Record<"high" | "low" | "close", number[]>>;
  expected: Readonly<Record<string, Line | Readonly<Record<string, Line>>>>;
}>;
const reference = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../services/research/tests/fixtures/indicator-reference.json",
      import.meta.url
    ),
    "utf8"
  )
) as Reference;
const single = (key: string): Line => reference.expected[key] as Line;
const multi = (key: string, part: string): Line =>
  (reference.expected[key] as Readonly<Record<string, Line>>)[part] ?? [];

const N: null = null;
const closeTo = (actual: Line, expected: Line) => {
  expect(actual).toHaveLength(expected.length);
  for (const [index, value] of expected.entries()) {
    const got = actual[index];
    if (value === null) expect(got, `bar ${index}`).toBeNull();
    else expect(got, `bar ${index}`).toBeCloseTo(value, 9);
  }
};
// Compare every bar TA-Lib defines; warmup is checked by the hand cases.
const matchesReference = (actual: Line, expected: Line) => {
  const defined = expected.flatMap((value, index) =>
    value === null ? [] : [index]
  );
  expect(defined.length).toBeGreaterThan(0);
  closeTo(
    defined.map((index) => actual[index] ?? null),
    defined.map((index) => expected[index] ?? null)
  );
};

describe("indicator math, hand-computed", () => {
  it("moving averages", () => {
    const values = [2, 4, 6, 8, 13];
    closeTo(sma(values, 3), [N, N, 4, 6, 9]);
    closeTo(ema(values, 3), [N, N, 4, 6, 9.5]);
    closeTo(smma(values, 3), [N, N, 4, 16 / 3, 71 / 9]);
    closeTo(lwma(values, 3), [N, N, 28 / 6, 40 / 6, 61 / 6]);
    expect(lwma([1, 2], 3)).toEqual([N, N]);
    expect(sma([1, 2], 3)).toEqual([N, N]);
    expect(stochastic({ close: [1], high: [2], low: [1] }, 1, 2, 1).k).toEqual([
      N,
    ]);
    expect(ema([1], 3)).toEqual([N]);
  });

  it("true range and ATR (Wilder and SMA)", () => {
    const bars = {
      close: [9, 11, 10, 14],
      high: [10, 12, 11, 15],
      low: [8, 9, 9, 11],
    };
    expect(trueRange(bars)).toEqual([N, 3, 2, 5]);
    closeTo(atr(bars, 2), [N, N, 2.5, 3.75]);
    closeTo(atr(bars, 2, "sma"), [N, N, 2.5, 3.5]);
  });

  it("Bollinger Bands", () => {
    const bands = bollinger([1, 2, 3, 4], 2, 2);
    closeTo(bands.middle, [N, 1.5, 2.5, 3.5]);
    closeTo(bands.upper, [N, 2.5, 3.5, 4.5]);
    closeTo(bands.lower, [N, 0.5, 1.5, 2.5]);
  });

  it("Parabolic SAR in both starting directions with reversals", () => {
    closeTo(
      parabolicSar(
        { high: [10, 11, 12, 11, 9], low: [9, 10, 11, 9, 8] },
        0.1,
        0.2
      ),
      [N, 9, 9.2, 12, 12]
    );
    const short = parabolicSar(
      { high: [12, 11, 10, 12, 13], low: [11, 9, 8, 9, 11] },
      0.1,
      0.2
    );
    closeTo(short.slice(0, 4), [N, 12, 11.7, 8]);
    expect(parabolicSar({ high: [1], low: [1] }, 0.02, 0.2)).toEqual([N]);
  });

  it("MACD", () => {
    const result = macd([1, 2, 4, 8, 16, 32], 2, 3, 2);
    closeTo(result.macd.slice(0, 5), [N, N, 2 / 3, 7 / 6, 79 / 36]);
    closeTo(result.signal.slice(0, 5), [N, N, N, 11 / 12, 191 / 108]);
    closeTo(result.histogram.slice(0, 5), [
      N,
      N,
      N,
      7 / 6 - 11 / 12,
      79 / 36 - 191 / 108,
    ]);
  });

  it("Stochastic, including a zero range", () => {
    const bars = {
      close: [9, 11, 10, 12, 11],
      high: [10, 11, 12, 13, 12],
      low: [8, 9, 10, 11, 10],
    };
    const k4 = (75 + 100 / 3) / 2;
    const result = stochastic(bars, 3, 2, 2);
    closeTo(result.k, [N, N, N, 62.5, k4]);
    closeTo(result.d, [N, N, N, N, (62.5 + k4) / 2]);
    const flat = { close: [5, 5, 5], high: [5, 5, 5], low: [5, 5, 5] };
    expect(stochastic(flat, 2, 1, 1).k).toEqual([N, 50, 50]);
  });

  it("ADX with +DI and -DI, including flat input", () => {
    const bars = {
      close: [9, 11, 12, 11, 13],
      high: [10, 12, 13, 12, 14],
      low: [8, 9, 11, 10, 11],
    };
    const result = adx(bars, 2);
    closeTo(result.plusDi, [N, N, 400 / 7, 80 / 3, 250 / 4.875]);
    closeTo(result.minusDi, [N, N, 0, 80 / 3, 50 / 4.875]);
    closeTo(result.adx, [N, N, N, 50, (50 + 200 / 3) / 2]);
    const flat = adx({ close: [5, 5, 5], high: [5, 5, 5], low: [5, 5, 5] }, 1);
    expect(flat.plusDi).toEqual([N, 0, 0]);
    expect(flat.adx).toEqual([N, 0, 0]);
  });
});

describe("indicator math, TA-Lib reference parity", () => {
  const { high, low, close } = reference.bars;
  const bars = { close, high, low };
  it("uses the TA-Lib fixture", () => {
    expect(reference.source).toMatch(/^TA-Lib C /u);
    expect(close).toHaveLength(80);
  });
  it.each([
    ["sma_10", () => sma(close, 10)],
    ["ema_10", () => ema(close, 10)],
    ["lwma_10", () => lwma(close, 10)],
    ["true_range", () => trueRange(bars)],
    ["atr_14", () => atr(bars, 14)],
    ["sar_002_02", () => parabolicSar(bars, 0.02, 0.2)],
  ] as const)("%s", (key, run) => {
    const expected = single(key);
    const actual = run();
    matchesReference(actual, expected);
    const first = expected.findIndex((value) => value !== null);
    expect(actual.slice(0, first).every((value) => value === null)).toBe(true);
    expect(actual[first]).not.toBeNull();
  });
  it("multi-line studies", () => {
    const bands = bollinger(close, 20, 2);
    for (const part of ["upper", "middle", "lower"] as const)
      matchesReference(bands[part], multi("bollinger_20_2", part));
    const lines = macd(close, 12, 26, 9);
    for (const part of ["macd", "signal", "histogram"] as const)
      matchesReference(lines[part], multi("macd_12_26_9", part));
    expect(lines.macd[24]).toBeNull();
    expect(lines.macd[25]).not.toBeNull();
    const stoch = stochastic(bars, 14, 3, 3);
    matchesReference(stoch.k, multi("stochastic_14_3_3", "k"));
    matchesReference(stoch.d, multi("stochastic_14_3_3", "d"));
    const directional = adx(bars, 14);
    matchesReference(directional.plusDi, multi("adx_14", "plus_di"));
    matchesReference(directional.minusDi, multi("adx_14", "minus_di"));
    matchesReference(directional.adx, multi("adx_14", "adx"));
  });
});

describe("indicator math input guards", () => {
  it.each([
    ["zero period", () => sma([1], 0), "period"],
    ["fractional period", () => sma([1], 1.5), "period"],
    ["oversized period", () => sma([1], MAX_INDICATOR_PERIOD + 1), "period"],
    ["non-finite value", () => sma([Number.NaN], 1), "finite"],
    [
      "length mismatch",
      () => trueRange({ close: [1], high: [1], low: [] }),
      "same length",
    ],
    [
      "close outside range",
      () => trueRange({ close: [3], high: [2], low: [1] }),
      "low <= close",
    ],
    ["zero deviations", () => bollinger([1], 1, 0), "positive"],
    [
      "acceleration above maximum",
      () => parabolicSar({ high: [2], low: [1] }, 0.3, 0.2),
      "exceed",
    ],
    ["fast not shorter", () => macd([1, 2], 3, 3, 1), "shorter"],
    ["zero lookback", () => rvolAtTime([], 0), "lookback"],
    [
      "non-finite timestamp",
      () => rvolAtTime([{ timestamp: Number.NaN, volume: 1 }], 1),
      "finite",
    ],
    [
      "non-finite volume",
      () => rvolAtTime([{ timestamp: 0, volume: Number.POSITIVE_INFINITY }], 1),
      "finite",
    ],
    [
      "negative volume",
      () => rvolAtTime([{ timestamp: 0, volume: -1 }], 1),
      "negative",
    ],
  ] as const)("rejects %s", (_name, run, message) => {
    expect(run).toThrow(message);
  });
  it("throws on a missing or null value inside a window", () => {
    expect(() => valueAt([1, null], 1)).toThrow("undefined at bar 1");
    expect(() => valueAt([1], 3)).toThrow("undefined at bar 3");
    expect(valueAt([1, 2], 1)).toBe(2);
  });
  it("does not mutate input", () => {
    const values = [3, 1, 2];
    sma(values, 1);
    expect(values).toEqual([3, 1, 2]);
  });
});

// New York time in January (UTC-5) as a UTC timestamp.
const ny = (day: number, hour: number, minute: number) =>
  Date.UTC(2026, 0, day, hour + 5, minute);

describe("RVOL at time", () => {
  it("matches the shared hand case on intraday bars", () => {
    const bars = [
      { timestamp: ny(5, 9, 30), volume: 10 },
      { timestamp: ny(5, 9, 35), volume: 20 },
      { timestamp: ny(6, 9, 30), volume: 30 },
      { timestamp: ny(6, 9, 35), volume: 10 },
      { timestamp: ny(7, 9, 30), volume: 20 },
      { timestamp: ny(7, 9, 35), volume: 40 },
    ];
    closeTo(rvolAtTime(bars, 2), [N, N, N, N, 1, 60 / 35]);
    // A 09:32 bar uses the previous sessions' volume through 09:30.
    const inserted = [
      ...bars.slice(0, 4),
      { timestamp: ny(7, 9, 32), volume: 20 },
    ];
    closeTo(rvolAtTime(inserted, 2), [N, N, N, N, 1]);
  });

  it("equals volume over the mean of previous volumes on daily bars", () => {
    const bars = [4, 6, 10, 0, 3].map((volume, index) => ({
      timestamp: Date.UTC(2026, 0, 5 + index, 21),
      volume,
    }));
    closeTo(rvolAtTime(bars, 2), [N, N, 2, 0, 3 / 5]);
  });

  it.each([
    ["UTC midnight", 0],
    ["21:00 UTC", 21],
  ])(
    "is 1 on constant-volume daily bars at %s across the November change",
    (_name, hour) => {
      const bars = Array.from({ length: 60 }, (_, index) => ({
        timestamp: Date.UTC(2024, 9, 1 + index, hour),
        volume: 500,
      }));
      const values = rvolAtTime(bars, 20);
      expect(values.slice(0, 20)).toEqual(new Array(20).fill(null));
      expect(values.slice(20)).toEqual(new Array(40).fill(1));
    }
  );

  it("gives null when the previous mean is 0", () => {
    const bars = [0, 0, 5].map((volume, index) => ({
      timestamp: ny(5 + index, 9, 30),
      volume,
    }));
    // The previous session has no bar by 09:00, so that mean is 0 too.
    const early = [
      { timestamp: ny(8, 9, 0), volume: 5 },
      { timestamp: ny(8, 9, 30), volume: 0 },
    ];
    expect(rvolAtTime([...bars, ...early], 1)).toEqual([
      null,
      null,
      null,
      null,
      1,
    ]);
  });

  it("groups by New York date, not UTC date", () => {
    // 20:30 New York is 01:30 UTC on the next day.
    const bars = [
      { timestamp: ny(5, 9, 30), volume: 10 },
      { timestamp: ny(5, 20, 30), volume: 10 },
      { timestamp: ny(6, 9, 30), volume: 5 },
      { timestamp: ny(6, 20, 30), volume: 15 },
    ];
    closeTo(rvolAtTime(bars, 1), [N, N, 0.5, 1]);
  });
});
