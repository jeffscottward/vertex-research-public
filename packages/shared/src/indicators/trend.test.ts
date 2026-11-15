import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  alphaTrend,
  atr,
  chandelierExit,
  ema,
  highest,
  lowest,
  MA_TYPES,
  type MaType,
  type Momentum,
  mfi,
  movingAverage,
  rma,
  rsi,
  slingshot,
  sma,
  supertrend,
  trueRange,
  ultimateMa,
  wma,
} from "./index.ts";

type Line = ReadonlyArray<number | null>;
type Reference = Readonly<{
  bars: Readonly<
    Record<"open" | "high" | "low" | "close" | "volume", number[]>
  >;
  expected: Readonly<Record<string, Line>>;
}>;
const reference = JSON.parse(
  readFileSync(
    new URL(
      "../../../../services/research/tests/fixtures/trend-indicator-reference.json",
      import.meta.url
    ),
    "utf8"
  )
) as Reference;
const { high, low, close, volume } = reference.bars;
const expected = (key: string): Line => {
  const line = reference.expected[key];
  if (line === undefined) throw new Error(`missing fixture key ${key}`);
  return line;
};

const matches = (actual: Float64Array, want: Line) => {
  expect(actual).toHaveLength(want.length);
  for (const [index, value] of want.entries()) {
    const got = actual[index];
    if (value === null) expect(got, `bar ${index}`).toBeNaN();
    else
      expect(Math.abs(Number(got) - value), `bar ${index}`).toBeLessThanOrEqual(
        1e-9
      );
  }
};
const plain = (values: Float64Array): number[] => Array.from(values);

describe("trend indicators against the reference fixture", () => {
  it("SuperTrend 10, 3", () => {
    const result = supertrend(high, low, close);
    matches(result.line, expected("supertrend_10_3.line"));
    matches(result.direction, expected("supertrend_10_3.direction"));
  });

  it.each(MA_TYPES)("Ultimate MA %s 20", (maType: MaType) => {
    const result = ultimateMa(close, volume, maType);
    matches(result.value, expected(`ultimate_ma_${maType}_20.value`));
    matches(result.direction, expected(`ultimate_ma_${maType}_20.direction`));
  });

  it.each(["mfi", "rsi"] as const)(
    "AlphaTrend 14, 1 %s",
    (momentum: Momentum) => {
      const result = alphaTrend(high, low, close, volume, 14, 1, momentum);
      matches(result.line, expected(`alphatrend_14_1_${momentum}.line`));
      matches(
        result.direction,
        expected(`alphatrend_14_1_${momentum}.direction`)
      );
    }
  );

  it("Chandelier Exit 22, 3", () => {
    const result = chandelierExit(high, low, close);
    matches(result.longStop, expected("chandelier_22_3.longStop"));
    matches(result.shortStop, expected("chandelier_22_3.shortStop"));
    matches(result.direction, expected("chandelier_22_3.direction"));
  });

  it("Slingshot 38, 62", () => {
    const result = slingshot(close);
    matches(result.fast, expected("slingshot_38_62.fast"));
    matches(result.slow, expected("slingshot_38_62.slow"));
    matches(result.direction, expected("slingshot_38_62.direction"));
  });

  it("MFI of hlc3 and RSI of close, 14", () => {
    const hlc3 = high.map(
      (h, i) => (h + Number(low[i]) + Number(close[i])) / 3
    );
    matches(mfi(hlc3, volume, 14), expected("mfi_hlc3_14"));
    matches(rsi(close, 14), expected("rsi_close_14"));
  });

  it("accepts Float64Array input", () => {
    const result = supertrend(
      Float64Array.from(high),
      Float64Array.from(low),
      Float64Array.from(close)
    );
    matches(result.line, expected("supertrend_10_3.line"));
  });
});

describe("building blocks by hand", () => {
  const N = Number.NaN;

  it("sma and wma skip undefined values", () => {
    expect(plain(sma([1, N, 2, 3, 4], 2))).toEqual([N, N, 1.5, 2.5, 3.5]);
    expect(plain(wma([1, N, 2, 3], 2))).toEqual([N, N, 5 / 3, 8 / 3]);
  });

  it("ema and rma seed with the simple mean", () => {
    const alpha = 2 / 3;
    const third = alpha * 3 + (1 - alpha) * 1.5;
    expect(plain(ema([1, 2, 3, 4], 2))).toEqual([
      N,
      1.5,
      third,
      alpha * 4 + (1 - alpha) * third,
    ]);
    expect(plain(rma([2, 4, 6], 2))).toEqual([N, 3, 0.5 * 6 + 0.5 * 3]);
  });

  it("true range and atr", () => {
    expect(plain(trueRange([3, 5], [1, 4], [2, 4.5], false))).toEqual([N, 3]);
    expect(plain(trueRange([3, 5], [1, 4], [2, 4.5], true))).toEqual([2, 3]);
    expect(plain(atr([3, 5], [1, 4], [2, 4.5], 2))).toEqual([N, 2.5]);
  });

  it("highest and lowest include the current bar", () => {
    expect(plain(highest([1, 3, 2, 1, 0], 2))).toEqual([N, 3, 3, 2, 1]);
    expect(plain(lowest([3, 1, 2, 3, 4], 2))).toEqual([N, 1, 1, 2, 3]);
  });

  it("mfi and rsi with no falling flow", () => {
    expect(plain(mfi([1, 2, 3], [1, 1, 1], 2))).toEqual([N, N, 100]);
    expect(plain(mfi([1, 1, 1], [1, 1, 1], 2))).toEqual([N, N, N]);
    expect(plain(rsi([1, 2, 3], 2))).toEqual([N, N, 100]);
    expect(plain(rsi([1, 1, 1], 2))).toEqual([N, N, N]);
  });

  it("vwma is undefined while the volume sum is 0", () => {
    expect(plain(movingAverage([1, 2, 3], [0, 0, 1], "vwma", 2))).toEqual([
      N,
      N,
      3,
    ]);
  });

  it("Slingshot direction is 0 when the averages are equal", () => {
    expect(plain(slingshot([5, 5, 5], 1, 2).direction)).toEqual([N, 0, 0]);
    expect(plain(slingshot([3, 2, 1], 1, 2).direction)).toEqual([N, -1, -1]);
  });

  it("Ultimate MA direction falls when the value drops", () => {
    expect(plain(ultimateMa([3, 2, 1], null, "sma", 1, 1).direction)).toEqual([
      N,
      -1,
      -1,
    ]);
  });
});

describe("argument errors", () => {
  it("rejects bad lengths and multipliers", () => {
    const message = "length must be an integer from 1 to 2000";
    expect(() => sma([1], 0)).toThrow(new RangeError(message));
    expect(() => sma([1], 2001)).toThrow(message);
    expect(() => sma([1], 1.5)).toThrow(message);
    expect(() => ultimateMa([1], null, "sma", 20, 0)).toThrow(
      "smoothing must be an integer from 1 to 2000"
    );
    expect(() => supertrend([1], [1], [1], 10, 0)).toThrow(
      new RangeError("factor must be a positive number")
    );
    expect(() =>
      supertrend([1], [1], [1], 10, Number.POSITIVE_INFINITY)
    ).toThrow("factor must be a positive number");
    expect(() => alphaTrend([1], [1], [1], [1], 14, -1)).toThrow(
      "coeff must be a positive number"
    );
    expect(() => chandelierExit([1], [1], [1], 22, 0)).toThrow(
      "multiple must be a positive number"
    );
    expect(() => movingAverage([1], null, "t3", 2, 0)).toThrow(
      "t3_factor must be a positive number"
    );
  });

  it("rejects mismatched series and missing volume", () => {
    expect(() => trueRange([1, 2], [1], [1], true)).toThrow(
      new RangeError("input series must have the same length")
    );
    expect(() => movingAverage([1], null, "vwma", 2)).toThrow(
      new RangeError("vwma needs volume")
    );
    expect(() => movingAverage([1], [1, 2], "vwma", 2)).toThrow(
      "input series must have the same length"
    );
    expect(() => alphaTrend([1], [1], [1], null)).toThrow(
      new RangeError("AlphaTrend momentum mfi needs volume; use momentum rsi")
    );
    expect(() => alphaTrend([1], [1], [1], [1, 2])).toThrow(
      "input series must have the same length"
    );
  });

  it("rejects unknown types", () => {
    expect(() => movingAverage([1], null, "dema" as MaType, 2)).toThrow(
      new RangeError(
        "ma_type must be one of sma, ema, wma, hull, vwma, rma, tema, t3"
      )
    );
    expect(() =>
      alphaTrend([1], [1], [1], null, 14, 1, "cci" as Momentum)
    ).toThrow(new RangeError("momentum must be mfi or rsi"));
  });
});
