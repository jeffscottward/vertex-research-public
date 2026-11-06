import { describe, expect, it } from "vitest";

import { SMALL_BARS, waveBars } from "./fixtures.ts";
import {
  compileScript,
  runScript,
  SCRIPT_BARS_MAX,
  SCRIPT_TEMPLATES,
  scriptTemplate,
} from "./index.ts";

const bars = waveBars(400);
const LAST = bars.length - 1;
const closes = bars.map((b) => b.close);

const PLOT_TITLES: Readonly<Record<string, readonly string[]>> = {
  "atr-trailing-stop": ["Long stop", "Short stop"],
  "bollinger-bands": ["Basis", "Upper", "Lower"],
  cci: ["CCI", "Upper", "Lower"],
  "donchian-channel": ["Upper", "Basis", "Lower"],
  "ema-ribbon": ["EMA 1", "EMA 2", "EMA 3", "EMA 4", "EMA 5"],
  "keltner-channel": ["Basis", "Upper", "Lower"],
  macd: ["Histogram", "MACD", "Signal", "Zero"],
  obv: ["OBV", "Signal"],
  "pivot-levels": ["Buy-side liquidity", "Sell-side liquidity"],
  rsi: ["RSI", "Overbought", "Middle", "Oversold"],
  "sma-cross": ["Fast SMA", "Slow SMA"],
  stochastic: ["%K", "%D", "Upper", "Lower"],
  "strategy-ma-cross": ["Fast", "Slow"],
  "strategy-rsi-mean-reversion": ["RSI", "Overbought", "Oversold"],
  "vwma-vs-sma": ["VWMA", "SMA"],
};

const mean = (xs: readonly number[]) =>
  xs.reduce((a, b) => a + b, 0) / xs.length;
const lastN = (xs: readonly number[], n: number, end = LAST) =>
  xs.slice(end - n + 1, end + 1);
const wilder = (xs: readonly number[], n: number) => {
  let prev = mean(xs.slice(0, n));
  for (let i = n; i < xs.length; i++)
    prev = (prev * (n - 1) + (xs[i] ?? 0)) / n;
  return prev;
};
const trueRanges = bars.map((b, i) => {
  const prev = bars[i - 1];
  if (!prev) return b.high - b.low;
  return Math.max(
    b.high - b.low,
    Math.abs(b.high - prev.close),
    Math.abs(b.low - prev.close)
  );
});
const rsiAt = (n: number) => {
  const up = closes.slice(1).map((c, i) => Math.max(c - (closes[i] ?? 0), 0));
  const down = closes.slice(1).map((c, i) => Math.max((closes[i] ?? 0) - c, 0));
  const u = wilder(up, n);
  const d = wilder(down, n);
  return 100 - 100 / (1 + u / d);
};

const plotsOf = (id: string) => {
  const result = runScript(scriptTemplate(id)?.source ?? "", bars);
  if (!result.ok) throw new Error(`${id}: ${JSON.stringify(result.errors)}`);
  return result.plots.map((p) => p.values);
};
const firstValue = (values: readonly (number | null)[] | undefined) =>
  values?.findIndex((v) => v !== null);

describe("SCRIPT_TEMPLATES", () => {
  it("ships at least 10 indicators plus 2 strategies with unique ids", () => {
    const ids = SCRIPT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      SCRIPT_TEMPLATES.filter((t) => t.category !== "strategy").length
    ).toBeGreaterThanOrEqual(10);
    expect(
      SCRIPT_TEMPLATES.filter((t) => t.category === "strategy").length
    ).toBeGreaterThanOrEqual(2);
    expect(scriptTemplate("rsi")?.title).toBe("RSI (70/30)");
    expect(scriptTemplate("missing")).toBeUndefined();
  });

  it.each(SCRIPT_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s compiles and runs on fixture bars",
    (_id, template) => {
      const compiled = compileScript(template.source);
      expect(compiled).toMatchObject({ ok: true });
      if (!compiled.ok) return;
      expect(compiled.kind).toBe(
        template.category === "strategy" ? "strategy" : "indicator"
      );

      const result = runScript(template.source, bars);
      if (!result.ok)
        throw new Error(`${template.id}: ${JSON.stringify(result.errors)}`);
      expect(result.warnings).toEqual([]);
      expect(result.plots.map((p) => p.title)).toEqual(
        PLOT_TITLES[template.id]
      );
      for (const plot of result.plots) {
        expect(plot.values).toHaveLength(bars.length);
        expect(plot.color).toMatch(/^#[0-9a-f]{6}$/);
        // Every series produces real numbers once warmed up.
        expect(plot.values.some((v) => v !== null && Number.isFinite(v))).toBe(
          true
        );
      }
      // Tiny inputs: still no runtime errors while every indicator is warming up.
      expect(runScript(template.source, SMALL_BARS).ok).toBe(true);
    }
  );

  it("strategy templates emit entry markers", () => {
    for (const id of ["strategy-ma-cross", "strategy-rsi-mean-reversion"]) {
      const source = scriptTemplate(id)?.source ?? "";
      const result = runScript(source, bars);
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      expect(result.signals.some((s) => s.kind === "long")).toBe(true);
    }
    const cross = runScript(
      scriptTemplate("strategy-ma-cross")?.source ?? "",
      bars
    );
    if (cross.ok) {
      const kinds = cross.signals.map((s) => s.kind);
      // Entries alternate because a repeat entry in the open direction is ignored.
      expect(kinds.every((k, i) => i === 0 || k !== kinds[i - 1])).toBe(true);
    }
  });

  it("pivot template marks pivots on the pivot bar via offset", () => {
    const result = runScript(
      scriptTemplate("pivot-levels")?.source ?? "",
      bars
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const highs = result.signals.filter((s) => s.text === "PH");
    // Independent count of 5/5 pivot highs on the same bars.
    const expected = bars.filter((bar, i) => {
      if (i < 5 || i + 5 >= bars.length) return false;
      const left = bars.slice(i - 5, i).every((b) => b.high < bar.high);
      const right = bars.slice(i + 1, i + 6).every((b) => b.high <= bar.high);
      return left && right;
    });
    expect(highs.map((s) => s.timestamp)).toEqual(
      expected.map((b) => b.timestamp)
    );
    expect(highs.length).toBeGreaterThan(3);
    for (const marker of highs) {
      const i = bars.findIndex((b) => b.timestamp === marker.timestamp);
      const window = bars.slice(Math.max(0, i - 5), i + 6).map((b) => b.high);
      expect(marker.value).toBe(Math.max(...window));
    }
  });

  it("every template fits the default budget on the maximum bar count", () => {
    const most = waveBars(SCRIPT_BARS_MAX);
    for (const template of SCRIPT_TEMPLATES) {
      const result = runScript(template.source, most);
      expect(result.ok, template.id).toBe(true);
    }
  });

  it("template inputs can be overridden", () => {
    const source = scriptTemplate("sma-cross")?.source ?? "";
    const result = runScript(source, bars, { inputs: { fastLen: 5 } });
    if (!result.ok) throw new Error("run failed");
    expect(result.plots[0]?.values.findIndex((v) => v !== null)).toBe(4);
  });
});

describe("template values match independent formulas", () => {
  it("sma-cross: SMA(10) and SMA(30)", () => {
    const [fast, slow] = plotsOf("sma-cross");
    expect(firstValue(fast)).toBe(9);
    expect(firstValue(slow)).toBe(29);
    expect(fast?.[LAST]).toBeCloseTo(mean(lastN(closes, 10)), 9);
    expect(slow?.[LAST]).toBeCloseTo(mean(lastN(closes, 30)), 9);
  });

  it("ema-ribbon: EMAs of lengths 8, 13, 21, 34, 55", () => {
    const plots = plotsOf("ema-ribbon");
    expect(plots.map(firstValue)).toEqual([7, 12, 20, 33, 54]);
  });

  it("rsi: Wilder RSI(14) with 70/50/30 levels", () => {
    const [rsi, upper, middle, lower] = plotsOf("rsi");
    expect(firstValue(rsi)).toBe(14);
    expect(rsi?.[LAST]).toBeCloseTo(rsiAt(14), 9);
    expect(new Set(upper)).toEqual(new Set([70]));
    expect(new Set(middle)).toEqual(new Set([50]));
    expect(new Set(lower)).toEqual(new Set([30]));
  });

  it("macd: histogram = MACD - signal, warm-up 26 then 9", () => {
    const [hist, macdLine, signal, zero] = plotsOf("macd");
    expect(firstValue(macdLine)).toBe(25);
    expect(firstValue(signal)).toBe(33);
    expect(firstValue(hist)).toBe(33);
    for (let i = 33; i <= LAST; i++) {
      expect(hist?.[i]).toBeCloseTo(
        (macdLine?.[i] ?? 0) - (signal?.[i] ?? 0),
        9
      );
    }
    expect(new Set(zero)).toEqual(new Set([0]));
  });

  it("bollinger-bands: SMA(20) ± 2 population standard deviations", () => {
    const [basis, upper, lower] = plotsOf("bollinger-bands");
    const window = lastN(closes, 20);
    const avg = mean(window);
    const dev = Math.sqrt(mean(window.map((x) => (x - avg) ** 2)));
    expect(basis?.[LAST]).toBeCloseTo(avg, 9);
    expect(upper?.[LAST]).toBeCloseTo(avg + 2 * dev, 9);
    expect(lower?.[LAST]).toBeCloseTo(avg - 2 * dev, 9);
  });

  it("keltner-channel: bands 2 x Wilder ATR(10) from the EMA", () => {
    const [basis, upper, lower] = plotsOf("keltner-channel");
    const atr = wilder(trueRanges, 10);
    expect(upper?.[LAST]).toBeCloseTo((basis?.[LAST] ?? 0) + 2 * atr, 9);
    expect(lower?.[LAST]).toBeCloseTo((basis?.[LAST] ?? 0) - 2 * atr, 9);
  });

  it("donchian-channel: 20-bar highest high, lowest low and their midpoint", () => {
    const [upper, mid, lower] = plotsOf("donchian-channel");
    const hi = Math.max(
      ...lastN(
        bars.map((b) => b.high),
        20
      )
    );
    const lo = Math.min(
      ...lastN(
        bars.map((b) => b.low),
        20
      )
    );
    expect(upper?.[LAST]).toBe(hi);
    expect(lower?.[LAST]).toBe(lo);
    expect(mid?.[LAST]).toBeCloseTo((hi + lo) / 2, 12);
    expect(firstValue(upper)).toBe(19);
  });

  it("stochastic: %K and %D stay in 0..100 with 80/20 levels", () => {
    const [k, d, upper, lower] = plotsOf("stochastic");
    expect(firstValue(k)).toBe(15);
    expect(firstValue(d)).toBe(17);
    for (const v of [...(k ?? []), ...(d ?? [])]) {
      if (v !== null) expect(v >= 0 && v <= 100).toBe(true);
    }
    expect(d?.[LAST]).toBeCloseTo(
      mean([k?.[LAST] ?? 0, k?.[LAST - 1] ?? 0, k?.[LAST - 2] ?? 0]),
      9
    );
    expect(new Set(upper)).toEqual(new Set([80]));
    expect(new Set(lower)).toEqual(new Set([20]));
  });

  it("cci: (typical - SMA) / (0.015 x mean deviation)", () => {
    const [cci] = plotsOf("cci");
    const typical = bars.map((b) => (b.high + b.low + b.close) / 3);
    const window = lastN(typical, 20);
    const avg = mean(window);
    const dev = mean(window.map((x) => Math.abs(x - avg)));
    expect(cci?.[LAST]).toBeCloseTo(
      ((typical[LAST] ?? 0) - avg) / (0.015 * dev),
      9
    );
  });

  it("obv: cumulative signed volume", () => {
    const [obv] = plotsOf("obv");
    let total = 0;
    for (let i = 1; i <= LAST; i++) {
      total +=
        Math.sign((closes[i] ?? 0) - (closes[i - 1] ?? 0)) *
        (bars[i]?.volume ?? 0);
    }
    expect(obv?.[0]).toBe(0);
    expect(obv?.[LAST]).toBe(total);
  });

  it("vwma-vs-sma: volume-weighted vs simple 20-bar average", () => {
    const [vwma, sma] = plotsOf("vwma-vs-sma");
    const window = bars.slice(LAST - 19);
    const weighted =
      window.reduce((sum, b) => sum + b.close * b.volume, 0) /
      window.reduce((sum, b) => sum + b.volume, 0);
    expect(vwma?.[LAST]).toBeCloseTo(weighted, 9);
    expect(sma?.[LAST]).toBeCloseTo(mean(lastN(closes, 20)), 9);
  });

  it("atr-trailing-stop: exactly one stop is drawn on every bar after warm-up", () => {
    const [longStop, shortStop] = plotsOf("atr-trailing-stop");
    for (let i = 10; i <= LAST; i++) {
      expect((longStop?.[i] === null) !== (shortStop?.[i] === null)).toBe(true);
    }
    expect(longStop?.filter((v) => v !== null).length).toBeGreaterThan(20);
    expect(shortStop?.filter((v) => v !== null).length).toBeGreaterThan(20);
  });

  it("strategy-rsi-mean-reversion: entries on RSI crossing up through 30", () => {
    const result = runScript(
      scriptTemplate("strategy-rsi-mean-reversion")?.source ?? "",
      bars
    );
    if (!result.ok) throw new Error("run failed");
    const rsi = result.plots[0]?.values ?? [];
    for (const signal of result.signals.filter((s) => s.kind === "long")) {
      const i = bars.findIndex((b) => b.timestamp === signal.timestamp);
      expect(rsi[i] ?? 0).toBeGreaterThan(30);
      expect(rsi[i - 1] ?? 100).toBeLessThanOrEqual(30);
    }
  });
});
