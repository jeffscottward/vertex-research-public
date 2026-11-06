import { describe, expect, it } from "vitest";

import { SMALL_BARS, SMALL_CLOSES, waveBars } from "./fixtures.ts";
import { runScript, type ScriptBar } from "./index.ts";

// One plotted expression on the fixture, values rounded to 4 places.
const ta = (expr: string, bars: readonly ScriptBar[] = SMALL_BARS) => {
  const result = runScript(`indicator("t")\nplot(${expr})\n`, bars);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return (result.plots[0]?.values ?? []).map((v) =>
    v === null ? null : Number(v.toFixed(4))
  );
};

const r4 = (v: number) => Number(v.toFixed(4));

// Independent reference implementations (textbook formulas) for the long fixture.
const closes = (bars: readonly ScriptBar[]) => bars.map((b) => b.close);
const refSma = (xs: readonly number[], n: number) =>
  xs.map((_, i) =>
    i < n - 1 ? null : xs.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n
  );
const refWilder = (xs: readonly (number | null)[], n: number) => {
  const out: (number | null)[] = [];
  let prev: number | null = null;
  let run: number[] = [];
  for (const x of xs) {
    if (x === null) {
      out.push(null);
      run = [];
      continue;
    }
    if (prev === null) {
      run.push(x);
      if (run.length >= n) prev = run.slice(-n).reduce((a, b) => a + b, 0) / n;
    } else prev = (prev * (n - 1) + x) / n;
    out.push(prev);
  }
  return out;
};
const refRsi = (xs: readonly number[], n: number) => {
  const up = xs.map((x, i) =>
    i === 0 ? null : Math.max(x - (xs[i - 1] ?? 0), 0)
  );
  const down = xs.map((x, i) =>
    i === 0 ? null : Math.max((xs[i - 1] ?? 0) - x, 0)
  );
  const au = refWilder(up, n);
  const ad = refWilder(down, n);
  return au.map((u, i) => {
    const d = ad[i] ?? null;
    if (u === null || d === null) return null;
    return d === 0 ? 100 : 100 - 100 / (1 + u / d);
  });
};
const refAtr = (bars: readonly ScriptBar[], n: number) => {
  const tr = bars.map((b, i) => {
    const prev = bars[i - 1];
    if (!prev) return b.high - b.low;
    return Math.max(
      b.high - b.low,
      Math.abs(b.high - prev.close),
      Math.abs(b.low - prev.close)
    );
  });
  return refWilder(tr, n);
};
const rounded = (xs: readonly (number | null)[]) =>
  xs.map((v) => (v === null ? null : r4(v)));

describe("moving averages on the hand-checked fixture", () => {
  it("ta.sma", () => {
    expect(ta("ta.sma(close, 3)")).toEqual([
      null,
      null,
      11,
      r4(34 / 3),
      12,
      r4(38 / 3),
      r4(40 / 3),
      14,
      r4(44 / 3),
      r4(46 / 3),
    ]);
  });

  it("ta.ema(close, 3): SMA seed, then alpha = 2 / (3 + 1) = 0.5", () => {
    const seed = (10 + 11 + 12) / 3;
    const e3 = 0.5 * 11 + 0.5 * seed;
    const e4 = 0.5 * 13 + 0.5 * e3;
    const e5 = 0.5 * 14 + 0.5 * e4;
    const e6 = 0.5 * 13 + 0.5 * e5;
    const e7 = 0.5 * 15 + 0.5 * e6;
    expect(ta("ta.ema(close, 3)").slice(0, 8)).toEqual([
      null,
      null,
      seed,
      e3,
      e4,
      e5,
      e6,
      e7,
    ]);
    expect([seed, e3, e4, e5, e6, e7]).toEqual([11, 11, 12, 13, 13, 14]);
  });

  it("ta.ema(close, 4): alpha = 0.4", () => {
    const seed = (10 + 11 + 12 + 11) / 4;
    const e4 = 0.4 * 13 + 0.6 * seed;
    const e5 = 0.4 * 14 + 0.6 * e4;
    const e6 = 0.4 * 13 + 0.6 * e5;
    expect(ta("ta.ema(close, 4)").slice(0, 7)).toEqual([
      null,
      null,
      null,
      seed,
      r4(e4),
      r4(e5),
      r4(e6),
    ]);
    expect([seed, e4, e5, e6].map(r4)).toEqual([11, 11.8, 12.68, 12.808]);
  });

  it("ta.rma(close, 3) (Wilder): SMA seed, then (prev * 2 + x) / 3", () => {
    const seed = 11;
    const r3 = (seed * 2 + 11) / 3;
    const r4v = (r3 * 2 + 13) / 3;
    const r5 = (r4v * 2 + 14) / 3;
    const r6 = (r5 * 2 + 13) / 3;
    expect(ta("ta.rma(close, 3)").slice(0, 7)).toEqual(
      [null, null, seed, r3, r4v, r5, r6].map((v) =>
        v === null ? null : r4(v)
      )
    );
    expect([r4v, r5, r6].map(r4)).toEqual([
      r4(35 / 3),
      r4(112 / 9),
      r4(341 / 27),
    ]);
  });

  it("ta.wma weights the newest bar highest", () => {
    expect(ta("ta.wma(close, 3)")[2]).toBe(r4((12 * 3 + 11 * 2 + 10) / 6));
  });

  it("ta.vwma weights by volume", () => {
    expect(ta("ta.vwma(close, 3)")[2]).toBe(
      r4((10 * 100 + 11 * 200 + 12 * 150) / 450)
    );
  });
});

describe("oscillators", () => {
  it("ta.rsi uses Wilder (RMA) averages of gains and losses", () => {
    const values = ta("ta.rsi(close, 3)");
    expect(values.slice(0, 3)).toEqual([null, null, null]);
    // Gains 1,1,0 and losses 0,0,1 seed the averages at 2/3 and 1/3.
    expect(values[3]).toBe(r4(100 - 100 / 3));
    expect(values[4]).toBe(r4(100 - 100 / 6));
    expect(values[5]).toBe(r4(100 - 100 / (1 + 29 / 4)));
  });

  it("ta.rsi is 100 with no losses", () => {
    const rising = SMALL_BARS.map((b, i) => ({ ...b, close: 10 + i }));
    expect(ta("ta.rsi(close, 3)", rising)[5]).toBe(100);
  });

  it("ta.macd returns [macd, signal, histogram]", () => {
    const result = runScript(
      'indicator("t")\n[m, s, h] = ta.macd(close, 2, 3, 2)\nplot(m)\nplot(s)\nplot(h)\n',
      SMALL_BARS
    );
    if (!result.ok) throw new Error("macd failed");
    const [m, s, h] = result.plots.map((p) => p.values);
    expect(m?.[1]).toBeNull();
    expect(m?.[2]).toBeCloseTo(0.5, 10);
    expect(m?.[3]).toBeCloseTo(1 / 6, 10);
    expect(s?.[2]).toBeNull();
    expect(s?.[3]).toBeCloseTo(1 / 3, 10);
    expect(h?.[3]).toBeCloseTo(-1 / 6, 10);
  });

  it("ta.stoch", () => {
    expect(ta("ta.stoch(close, high, low, 3)")[4]).toBe(75);
  });

  it("ta.cci", () => {
    expect(ta("ta.cci(close, 3)")[2]).toBe(100);
  });

  it("ta.mom, ta.change and ta.roc", () => {
    expect(ta("ta.change(close)").slice(0, 3)).toEqual([null, 1, 1]);
    expect(ta("ta.change(close, 2)")[3]).toBe(0);
    expect(ta("ta.mom(close, 2)")[4]).toBe(1);
    expect(ta("ta.roc(close, 2)")[4]).toBe(r4(100 / 12));
  });
});

describe("volatility", () => {
  it("ta.tr variable is na on the first bar; ta.tr(true) is high - low", () => {
    expect(ta("ta.tr").slice(0, 5)).toEqual([null, 2, 2, 2, 3]);
    expect(ta("ta.tr(true)")[0]).toBe(2);
  });

  it("ta.atr is the Wilder RMA of true range", () => {
    expect(ta("ta.atr(3)").slice(0, 6)).toEqual([
      null,
      null,
      2,
      2,
      r4(7 / 3),
      r4(20 / 9),
    ]);
  });

  it("ta.stdev is the population standard deviation", () => {
    expect(ta("ta.stdev(close, 3)")[2]).toBe(r4(Math.sqrt(2 / 3)));
    expect(ta("ta.stdev(close, 3, false)")[2]).toBe(1);
  });

  it("ta.bb is basis ± mult * stdev", () => {
    const result = runScript(
      'indicator("t")\n[b, u, l] = ta.bb(close, 3, 2)\nplot(u - l)\n',
      SMALL_BARS
    );
    if (!result.ok) throw new Error("bb failed");
    expect(result.plots[0]?.values[2]).toBeCloseTo(4 * Math.sqrt(2 / 3), 10);
  });

  it("ta.highest / ta.lowest (with the 1-argument high/low form)", () => {
    expect(ta("ta.highest(high, 3)")[4]).toBe(14);
    expect(ta("ta.lowest(low, 3)")[4]).toBe(10);
    expect(ta("ta.highest(3)")[4]).toBe(14);
    expect(ta("ta.lowest(3)")[4]).toBe(10);
  });
});

describe("events and accumulators", () => {
  it("ta.crossover / crossunder / cross", () => {
    const hits = (expr: string) =>
      ta(`${expr} ? 1 : 0`)
        .map((v, i) => (v === 1 ? i : -1))
        .filter((i) => i >= 0);
    expect(hits("ta.crossover(close, 12.5)")).toEqual([4]);
    expect(hits("ta.crossunder(close, 13.5)")).toEqual([6]);
    expect(hits("ta.cross(close, 13.5)")).toEqual([5, 6, 7]);
  });

  it("ta.pivothigh / ta.pivotlow confirm after the right bars", () => {
    expect(ta("ta.pivothigh(close, 1, 1)")).toEqual([
      null,
      null,
      null,
      12,
      null,
      null,
      14,
      null,
      null,
      16,
    ]);
    expect(ta("ta.pivotlow(close, 1, 1)")).toEqual([
      null,
      null,
      null,
      null,
      11,
      null,
      null,
      13,
      null,
      null,
    ]);
    expect(ta("ta.pivothigh(1, 1)")[3]).toBe(13);
  });

  it("ta.valuewhen and ta.barssince", () => {
    expect(ta("ta.valuewhen(close > 13, close, 0)").slice(4, 8)).toEqual([
      null,
      14,
      14,
      15,
    ]);
    expect(ta("ta.valuewhen(close > 13, close, 1)")[7]).toBe(14);
    expect(ta("ta.barssince(close < 12)").slice(0, 6)).toEqual([
      0, 0, 1, 0, 1, 2,
    ]);
    expect(ta("ta.barssince(close > 100)")[9]).toBeNull();
  });

  it("ta.cum and ta.obv", () => {
    expect(ta("ta.cum(close)")[2]).toBe(33);
    expect(ta("ta.obv").slice(0, 5)).toEqual([0, 200, 350, 50, 300]);
    expect(ta("ta.obv[1]")[1]).toBe(0);
  });
});

describe("math and helpers", () => {
  it("math.*", () => {
    const at0 = (expr: string) => ta(expr)[0];
    expect(at0("math.abs(-close)")).toBe(10);
    expect(at0("math.max(1, close, 3)")).toBe(10);
    expect(at0("math.min(close, 3)")).toBe(3);
    expect(at0("math.avg(close, 20)")).toBe(15);
    expect(at0("math.round(close / 3)")).toBe(3);
    expect(at0("math.round(close / 3, 2)")).toBe(3.33);
    expect(at0("math.floor(-1.5)")).toBe(-2);
    expect(at0("math.ceil(1.2)")).toBe(2);
    expect(at0("math.sqrt(close * 10)")).toBe(10);
    expect(at0("math.log(math.exp(2))")).toBe(2);
    expect(at0("math.pow(close, 2)")).toBe(100);
    expect(at0("math.sign(-close)")).toBe(-1);
    expect(at0("math.sqrt(-1)")).toBeNull();
    expect(at0("math.max(close, na)")).toBeNull();
  });
});

describe("agreement with reference formulas on a long series", () => {
  const bars = waveBars(200);
  const xs = closes(bars);

  it("SMA, RSI and ATR match textbook implementations", () => {
    expect(ta("ta.sma(close, 14)", bars)).toEqual(rounded(refSma(xs, 14)));
    expect(ta("ta.rsi(close, 14)", bars)).toEqual(rounded(refRsi(xs, 14)));
    expect(ta("ta.atr(14)", bars)).toEqual(rounded(refAtr(bars, 14)));
  });

  it("repeated and mixed calls each produce their own correct values", () => {
    const result = runScript(
      [
        'indicator("t")',
        "plot(ta.sma(close, 5))",
        "plot(ta.sma(close, 5))",
        "plot(ta.sma(close, 5) + ta.sma(close, 3))",
        "plot(ta.rsi(close, 14) - ta.rsi(close, 7))",
      ].join("\n"),
      bars
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const [first, second, mixed, rsiGap] = result.plots.map((p) =>
      rounded(p.values)
    );
    const sma5 = refSma(xs, 5);
    const sma3 = refSma(xs, 3);
    expect(first).toEqual(rounded(sma5));
    expect(second).toEqual(rounded(sma5));
    expect(mixed).toEqual(
      rounded(sma5.map((v, i) => (v === null ? null : v + (sma3[i] ?? 0))))
    );
    const rsi14 = refRsi(xs, 14);
    const rsi7 = refRsi(xs, 7);
    expect(rsiGap).toEqual(
      rounded(rsi14.map((v, i) => (v === null ? null : v - (rsi7[i] ?? 0))))
    );
  });

  it("ta.rma equals the Pine reference pine_rma code, run as a Vertex script", () => {
    const reference = [
      'indicator("t")',
      "pine_rma(src, length) =>",
      "    alpha = 1 / length",
      "    sum = 0.0",
      "    sum := na(sum[1]) ? ta.sma(src, length) : alpha * src + (1 - alpha) * nz(sum[1])",
      "    sum",
      "plot(pine_rma(close, 14))",
      "plot(ta.rma(close, 14))",
    ].join("\n");
    const result = runScript(reference, bars);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const [pine, builtin] = result.plots.map((p) => rounded(p.values));
    expect(builtin).toEqual(pine);
    expect(builtin).toEqual(rounded(refWilder(xs, 14)));
  });

  it("ta.ema equals the SMA-seeded EMA formula and converges to the first-value seed", () => {
    const result = runScript(
      [
        'indicator("t")',
        "sma_seeded(src, length) =>",
        "    alpha = 2 / (length + 1)",
        "    sum = 0.0",
        "    sum := na(sum[1]) ? ta.sma(src, length) : alpha * src + (1 - alpha) * nz(sum[1])",
        "    sum",
        // The Pine reference example for ta.ema seeds with the first source value.
        "pine_ema(src, length) =>",
        "    alpha = 2 / (length + 1)",
        "    sum = 0.0",
        "    sum := na(sum[1]) ? src : alpha * src + (1 - alpha) * nz(sum[1])",
        "    sum",
        "plot(ta.ema(close, 14))",
        "plot(sma_seeded(close, 14))",
        "plot(pine_ema(close, 14))",
      ].join("\n"),
      bars
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const [builtin, seeded, firstValue] = result.plots.map((p) => p.values);
    expect(rounded(builtin ?? [])).toEqual(rounded(seeded ?? []));
    expect(builtin?.slice(0, 13).every((v) => v === null)).toBe(true);
    // The seed's weight decays by (13 / 15) per bar: identical well before bar 199.
    expect(builtin?.[199]).toBeCloseTo(firstValue?.[199] ?? 0, 8);
    expect(
      Math.abs((builtin?.[14] ?? 0) - (firstValue?.[14] ?? 0))
    ).toBeGreaterThan(1e-6);
  });

  it("closing prices fixture is as documented", () => {
    expect(SMALL_BARS.map((b) => b.close)).toEqual([...SMALL_CLOSES]);
  });
});

describe("degenerate inputs", () => {
  it("ta.rsi is 0 when the source only falls", () => {
    expect(ta("ta.rsi(-bar_index, 2)").slice(1, 4)).toEqual([null, 0, 0]);
  });

  it("ta.stoch and ta.cci are na on a flat window", () => {
    expect(ta("ta.stoch(1, 1, 1, 2)").every((v) => v === null)).toBe(true);
    expect(ta("ta.cci(1, 3)").every((v) => v === null)).toBe(true);
  });

  it("ta.vwma and ta.cum skip na sources", () => {
    // close: 10 11 12 11 13 ...; only closes above 12 count.
    const src = "close > 12 ? close : na";
    expect(ta(`ta.vwma(${src}, 1)`).slice(3, 5)).toEqual([null, 13]);
    expect(ta(`ta.cum(${src})`).slice(3, 6)).toEqual([0, 13, 27]);
  });
});
