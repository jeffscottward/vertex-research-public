import { describe, expect, it } from "vitest";

import { SMALL_BARS, waveBars } from "./fixtures.ts";
import {
  compileScript,
  type RunOptions,
  type RunResult,
  runScript,
  SCRIPT_BARS_MAX,
  SCRIPT_PLOTS_MAX,
  SCRIPT_SIGNALS_MAX,
  SCRIPT_SOURCE_MAX,
  type ScriptBar,
} from "./index.ts";

type Ok = Extract<RunResult, { ok: true }>;

const run = (
  body: string,
  options: RunOptions = {},
  bars: readonly ScriptBar[] = SMALL_BARS,
  header = 'indicator("t")'
): Ok => {
  const result = runScript(`${header}\n${body}\n`, bars, options);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
};

const errors = (
  body: string,
  options: RunOptions = {},
  header = 'indicator("t")'
) => {
  const result = runScript(`${header}\n${body}\n`, SMALL_BARS, options);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
};

// Values of the plots, rounded for readable expectations.
const plots = (result: Ok, digits = 4) =>
  result.plots.map((p) =>
    p.values.map((v) => (v === null ? null : Number(v.toFixed(digits))))
  );

const series = (body: string, options: RunOptions = {}) =>
  plots(run(body, options));

describe("declarations", () => {
  it("compiles indicator() metadata", () => {
    expect(
      compileScript(
        '//@version=5\nindicator("My RSI", shorttitle="RSI", overlay=false)\n'
      )
    ).toEqual({
      inputs: [],
      kind: "indicator",
      ok: true,
      overlay: false,
      shortTitle: "RSI",
      title: "My RSI",
    });
    expect(compileScript('strategy("S", overlay=true)')).toMatchObject({
      kind: "strategy",
      ok: true,
      overlay: true,
      shortTitle: "S",
    });
  });

  it("requires exactly one declaration", () => {
    expect(compileScript("x = 1\n")).toEqual({
      errors: [
        {
          column: 1,
          line: 1,
          message: "Script must declare indicator() or strategy()",
        },
      ],
      ok: false,
    });
    expect(compileScript('indicator("a")\nstrategy("b")\n')).toEqual({
      errors: [
        {
          column: 1,
          line: 2,
          message: "Only one indicator() or strategy() declaration is allowed",
        },
      ],
      ok: false,
    });
    expect(compileScript("indicator(title)\n")).toMatchObject({
      errors: [
        { column: 11, line: 1, message: "indicator title must be a constant" },
      ],
      ok: false,
    });
  });
});

describe("series semantics", () => {
  it("reads history with x[n] and builtin[n]", () => {
    expect(
      series("x = close\nplot(x[1])\nplot(close[2])\nplot(bar_index)")
    ).toEqual([
      [null, 10, 11, 12, 11, 13, 14, 13, 15, 16],
      [null, null, 10, 11, 12, 11, 13, 14, 13, 15],
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    ]);
  });

  it("records history of arbitrary expressions", () => {
    expect(
      series("plot((close - open)[1])\nplot(ta.sma(close, 2)[1])")[1]
    ).toEqual([null, null, 10.5, 11.5, 11.5, 12, 13.5, 13.5, 14, 15.5]);
  });

  it("keeps var state across bars while plain declarations re-evaluate", () => {
    const [counter, plain, carried] = series(
      "var count = 0\ncount := count + 1\nd = 0\nd := d + 1\nvar float hi = na\nhi := math.max(nz(hi), high)\nplot(count)\nplot(d)\nplot(hi)"
    );
    expect(counter).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(plain).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(carried).toEqual([11, 12, 13, 13, 14, 15, 15, 16, 17, 17]);
  });

  it("supports compound assignment and x[1] of a var", () => {
    const [total, prev] = series(
      "var s = 0.0\ns += close\nplot(s)\nplot(s[1])"
    );
    expect(total).toEqual([10, 21, 33, 44, 57, 71, 84, 99, 115, 130]);
    expect(prev?.slice(0, 3)).toEqual([null, 10, 21]);
  });

  it("type prefixes declare variables", () => {
    expect(
      series(
        "float a = close\nint b = 2\nbool c = close > 12\nplot(c ? a * b : -1)"
      )[0]
    ).toEqual([-1, -1, -1, -1, 26, 28, 26, 30, 32, 30]);
  });

  it("destructures tuples", () => {
    const [mid, upper, lower] = series(
      "[b, u, l] = ta.bb(close, 3, 2)\nplot(b)\nplot(u)\nplot(l)"
    );
    expect(mid?.[2]).toBe(11);
    expect(upper?.[2]).toBeCloseTo(12.633, 3);
    expect(lower?.[2]).toBeCloseTo(9.367, 3);
  });
});

describe("na handling", () => {
  it("propagates na through arithmetic and comparisons", () => {
    const [sum, cmp, nzed, isNa] = series(
      "plot(close[1] + 1)\nplot(close[1] > 5 ? 1 : 0)\nplot(nz(close[1], -1))\nplot(na(close[1]) ? 1 : 0)"
    );
    expect(sum?.slice(0, 2)).toEqual([null, 11]);
    expect(cmp?.slice(0, 2)).toEqual([0, 1]);
    expect(nzed?.slice(0, 2)).toEqual([-1, 10]);
    expect(isNa?.slice(0, 2)).toEqual([1, 0]);
  });

  it("turns division by zero into na", () => {
    expect(series("plot(close / 0)\nplot(na)")).toEqual([
      Array.from({ length: 10 }, () => null),
      Array.from({ length: 10 }, () => null),
    ]);
  });
});

describe("control flow", () => {
  it("runs if / else if / else by indentation", () => {
    const source = [
      "x = 0",
      "if close > 13",
      "    x := 2",
      "else if close > 11",
      "    x := 1",
      "else",
      "    x := -1",
      "plot(x)",
    ].join("\n");
    expect(series(source)[0]).toEqual([-1, -1, 1, -1, 1, 2, 1, 2, 2, 2]);
  });

  it("short-circuits and/or and evaluates not", () => {
    expect(series("plot(close > 12 and not (close > 14) ? 1 : 0)")[0]).toEqual([
      0, 0, 0, 0, 1, 1, 1, 0, 0, 0,
    ]);
  });

  it("runs bounded for loops with by, break and continue", () => {
    const source = [
      "total = 0",
      "for i = 0 to 10 by 2",
      "    if i == 4",
      "        continue",
      "    if i > 8",
      "        break",
      "    total += i",
      "down = 0",
      "for j = 3 to 1",
      "    down := down * 10 + j",
      "plot(total)",
      "plot(down)",
    ].join("\n");
    const [total, down] = series(source);
    expect(total?.[0]).toBe(0 + 2 + 6 + 8);
    expect(down?.[0]).toBe(321);
  });

  it("stops runaway loops on the operation budget with the line", () => {
    const result = runScript(
      'indicator("t")\nx = 0\nfor i = 0 to 100000000\n    x += 1\nplot(x)\n',
      SMALL_BARS,
      { maxOps: 50_000 }
    );
    expect(result).toMatchObject({
      errors: [{ message: "Script stopped: operation budget used" }],
      ok: false,
    });
    if (!result.ok) expect([3, 4]).toContain(result.errors[0]?.line);
  });

  it("counts every bar against the budget", () => {
    expect(
      runScript('indicator("t")\nplot(close)\n', waveBars(500), { maxOps: 102 })
    ).toMatchObject({
      errors: [{ line: 2, message: "Script stopped: operation budget used" }],
      ok: false,
    });
  });
});

describe("user functions", () => {
  it("supports single-line and multi-line bodies with defaults and named args", () => {
    const source = [
      "scale(x, k = 2) => x * k",
      "band(src, width) =>",
      "    mid = src",
      "    mid + width",
      "plot(scale(close))",
      "plot(scale(k = 3, x = close))",
      "plot(band(close, 0.5))",
    ].join("\n");
    const [two, three, band] = series(source);
    expect(two?.[0]).toBe(20);
    expect(three?.[0]).toBe(30);
    expect(band?.[0]).toBe(10.5);
  });

  it("runs parameter defaults that use named constants", () => {
    const source = [
      "f(x, m = math.pi) => x * m",
      "g(x, m = -math.pi) => x * m",
      "h(x, c = color.red) => x",
      "plot(f(close))",
      "plot(f(close, 2))",
      "plot(g(close))",
      "plot(h(close))",
      "plot(h(close, color.blue))",
    ].join("\n");
    const [pi, two, minus, plain, blue] = series(source);
    expect(pi?.[0]).toBeCloseTo(10 * Math.PI);
    expect(two?.[0]).toBe(20);
    expect(minus?.[0]).toBeCloseTo(-10 * Math.PI);
    expect(plain?.[0]).toBe(10);
    expect(blue?.[0]).toBe(10);
  });

  it("returns tuples from functions", () => {
    const source =
      "pair(x) =>\n    [x, x * 2]\n[a, b] = pair(close)\nplot(a + b)";
    expect(series(source)[0]?.[0]).toBe(30);
  });

  it("keeps separate ta state per call site", () => {
    // One function body, two call sites with different sources: shared state would mix the
    // close and volume histories inside the single ta.ema / ta.cum node.
    const source = [
      "smooth(src) => ta.ema(src, 3)",
      "total(src) => ta.cum(src)",
      "plot(smooth(close))",
      "plot(smooth(volume))",
      "plot(total(close))",
      "plot(total(volume))",
      "plot(ta.ema(close, 3))",
    ].join("\n");
    const [emaClose, emaVolume, cumClose, cumVolume, direct] = series(source);
    // EMA(3), alpha 0.5, seeded with SMA(10, 11, 12) = 11 and SMA(100, 200, 150) = 150.
    expect(emaClose).toEqual([null, null, 11, 11, 12, 13, 13, 14, 15, 15]);
    expect(emaVolume?.slice(0, 6)).toEqual([
      null,
      null,
      150,
      225,
      237.5,
      168.75,
    ]);
    expect(cumClose?.slice(0, 4)).toEqual([10, 21, 33, 44]);
    expect(cumVolume?.slice(0, 4)).toEqual([100, 300, 450, 750]);
    expect(direct).toEqual(emaClose);
  });

  it("gives each call site its own var state", () => {
    const source =
      "counter(step) =>\n    var n = 0\n    n := n + step\n    n\nplot(counter(1))\nplot(counter(10))";
    const [ones, tens] = series(source);
    expect(ones?.slice(0, 3)).toEqual([1, 2, 3]);
    expect(tens?.slice(0, 3)).toEqual([10, 20, 30]);
  });

  it("rejects recursion, global mutation and parameter mutation", () => {
    expect(errors("f(x) => f(x)")[0]?.message).toBe(
      "Recursive functions are not supported"
    );
    expect(errors("g = 0\nf(x) =>\n    g := x\n    x")[0]).toMatchObject({
      line: 4,
      message: "Cannot modify global variable 'g' inside a function",
    });
    expect(errors("f(x) =>\n    x := 1\n    x")[0]?.message).toBe(
      "Cannot modify function parameter 'x'"
    );
  });
});

describe("checker errors", () => {
  it("points at undeclared identifiers and unknown functions", () => {
    expect(errors("plot(foo)")).toEqual([
      { column: 6, line: 2, message: "Undeclared identifier 'foo'" },
    ]);
    expect(errors("x = bar(1)")[0]).toEqual({
      column: 5,
      line: 2,
      message: "Unknown function 'bar'",
    });
    expect(errors("y := 1")[0]?.message).toBe(
      "'y' must be declared with '=' before ':='"
    );
    expect(errors("x = 1\nx = 2")[0]).toMatchObject({
      line: 3,
      message: "'x' is already declared",
    });
  });

  it("checks arity and argument names", () => {
    expect(errors("x = ta.sma(close)")[0]?.message).toBe(
      "'ta.sma' expects 2 arguments, got 1"
    );
    expect(errors("plot(close, colour=color.red)")[0]).toEqual({
      column: 13,
      line: 2,
      message: "'plot' has no argument named 'colour'",
    });
    expect(errors("plot(series=close, 1)")[0]?.message).toBe(
      "Positional argument after a named argument"
    );
  });

  it("enforces global-only outputs and strategy-only orders", () => {
    expect(errors("if close > 1\n    plot(close)")[0]).toMatchObject({
      column: 5,
      line: 3,
      message:
        "'plot' is only allowed at the top level, not inside if, for or functions",
    });
    expect(errors('strategy.entry("L", strategy.long)')[0]?.message).toBe(
      "'strategy.entry' needs a strategy() declaration"
    );
  });

  it("collects several errors", () => {
    expect(errors("plot(a)\nplot(b)")).toHaveLength(2);
  });

  it("reports runtime type errors with positions", () => {
    expect(errors('x = close + "a"\nplot(x)')[0]).toEqual({
      column: 11,
      line: 2,
      message: "Operator '+' needs numbers, got number and string",
    });
    expect(errors("plot(close > 1)")[0]?.message).toBe(
      "plot expects a number series, got boolean"
    );
  });
});

describe("unsupported Pine features", () => {
  const cases: [string, string][] = [
    ['s = request.security("AAPL", "D", close)', "request.security"],
    ["a = array.new_float(0)", "array.new_float"],
    ['l = label.new(bar_index, high, "x")', "label.new"],
    ["ln = line.new(0, 0, 1, 1)", "line.new"],
    ["b = box.new(0, 0, 1, 1)", "box.new"],
    ["t = table.new(position.top_right, 1, 1)", "table.new"],
    ["varip x = 0", "varip"],
    ["while close > 1\n    x = 1", "while"],
    ["x = switch\n    close > 1 => 1", "switch"],
    ["type Point\n    float x", "type"],
    ["method m(float x) => x", "method"],
    ["array<float> a = na", "array"],
    ["x = close\ny = x.abs()", "methods and fields"],
    ["x = ta.supertrend(3, 10)", "ta.supertrend"],
    ["for x in a\n    y = x", "for...in"],
    ["x = if close > 1\n    1", "if expressions"],
  ];

  it.each(cases)("%s", (body, name) => {
    expect(errors(body)[0]?.message).toBe(
      `not supported in Vertex scripts yet: ${name}`
    );
  });

  it("warns and ignores alertcondition()", () => {
    const result = run(
      'alertcondition(close > open, "Up", "Close above open")\nplot(close)'
    );
    expect(result.warnings).toEqual([
      "alertcondition() is ignored in Vertex scripts",
    ]);
  });
});

describe("plots and shapes", () => {
  it("emits plot metadata, styles, colors and hlines", () => {
    const result = run(
      'plot(close, "Close", color=color.green, style=plot.style_histogram, linewidth=2)\nplot(close, style=plot.style_circles, color=#123456)\nhline(12, "Mid", color=color.gray)\nplot(open, color=close > open ? color.lime : color.red)'
    );
    expect(result.plots.map((p) => [p.id, p.title, p.kind, p.color])).toEqual([
      ["plot_0", "Close", "histogram", "#4caf50"],
      ["plot_1", "Plot 2", "circles", "#123456"],
      ["plot_2", "Mid", "hline", "#787b86"],
      ["plot_3", "Plot 4", "line", "#00e676"],
    ]);
    expect(result.plots[2]?.values.every((v) => v === 12)).toBe(true);
    expect(result.plots[0]?.values).toHaveLength(SMALL_BARS.length);
  });

  it("color.new returns the base color", () => {
    expect(
      run("plot(close, color=color.new(color.red, 50))").plots[0]?.color
    ).toBe("#ff5252");
  });

  it("shifts plots by offset", () => {
    expect(series("plot(close, offset=1)")[0]?.slice(0, 3)).toEqual([
      null,
      10,
      11,
    ]);
  });

  it("caps plots", () => {
    const body = Array.from(
      { length: SCRIPT_PLOTS_MAX + 1 },
      () => "plot(close)"
    ).join("\n");
    expect(errors(body)[0]).toMatchObject({
      line: SCRIPT_PLOTS_MAX + 2,
      message: `Too many plots (max ${SCRIPT_PLOTS_MAX})`,
    });
  });

  it("places plotshape markers above or below the bar", () => {
    const result = run(
      'plotshape(close > 14, "Hi", location=location.abovebar, text="hi")\nplotshape(close < 11, location=location.belowbar)'
    );
    expect(result.signals).toEqual([
      {
        kind: "shape",
        location: "belowbar",
        text: "",
        timestamp: SMALL_BARS[0]?.timestamp,
        value: 9,
      },
      {
        kind: "shape",
        location: "abovebar",
        text: "hi",
        timestamp: SMALL_BARS[7]?.timestamp,
        value: 16,
      },
      {
        kind: "shape",
        location: "abovebar",
        text: "hi",
        timestamp: SMALL_BARS[8]?.timestamp,
        value: 17,
      },
      {
        kind: "shape",
        location: "abovebar",
        text: "hi",
        timestamp: SMALL_BARS[9]?.timestamp,
        value: 16,
      },
    ]);
  });

  it("caps signals with a warning", () => {
    const result = run(
      "plotshape(true)",
      {},
      waveBars(SCRIPT_SIGNALS_MAX + 20)
    );
    expect(result.signals).toHaveLength(SCRIPT_SIGNALS_MAX);
    expect(result.warnings[0]).toMatch(/Signals capped/);
  });
});

describe("strategy signals", () => {
  const header = 'strategy("S", overlay=true)';

  it("turns strategy.entry/close into display markers", () => {
    const source = [
      "if close > 12 and close[1] <= 12",
      '    strategy.entry("L", strategy.long, comment="go long")',
      "if close < 14 and close[1] >= 14",
      '    strategy.close("L")',
      'strategy.entry("S", strategy.short, when=bar_index == 9)',
      "plot(strategy.position_size)",
    ].join("\n");
    const result = run(source, {}, SMALL_BARS, header);
    expect(
      result.signals.map((s) => [
        SMALL_BARS.findIndex((b) => b.timestamp === s.timestamp),
        s.kind,
        s.text,
        s.location,
        s.value,
      ])
    ).toEqual([
      [4, "long", "go long", "belowbar", 12],
      [6, "exit", "Close L", "abovebar", 14],
      [9, "short", "S", "abovebar", 16],
    ]);
    expect(plots(result)[0]).toEqual([0, 0, 0, 0, 1, 1, 0, 0, 0, -1]);
  });

  it("ignores repeat entries in the same direction (no pyramiding)", () => {
    const result = run(
      'strategy.entry("L", strategy.long)',
      {},
      SMALL_BARS,
      header
    );
    expect(result.signals).toHaveLength(1);
  });
});

describe("inputs", () => {
  const source = [
    'len = input.int(3, "Length", minval=2, maxval=5)',
    'mult = input.float(1.5, "Mult")',
    'show = input.bool(true, "Show")',
    'mode = input.string("fast", "Mode", options=["fast", "slow"])',
    'src = input.source(close, "Source")',
    "legacy = input(7)",
    "plot(show ? ta.sma(src, len) * mult : na)",
    'plot(mode == "fast" ? 1 : 0)',
    "plot(legacy)",
  ].join("\n");

  it("lists input specs at compile and run time", () => {
    const compiled = compileScript(`indicator("t")\n${source}\n`);
    const expected = [
      { defval: 3, id: "len", kind: "int", max: 5, min: 2, title: "Length" },
      { defval: 1.5, id: "mult", kind: "float", title: "Mult" },
      { defval: true, id: "show", kind: "bool", title: "Show" },
      {
        defval: "fast",
        id: "mode",
        kind: "string",
        options: ["fast", "slow"],
        title: "Mode",
      },
      { defval: "close", id: "src", kind: "source", title: "Source" },
      { defval: 7, id: "legacy", kind: "int", title: "legacy" },
    ];
    expect(compiled).toMatchObject({ inputs: expected, ok: true });
    expect(run(source).inputs).toEqual(expected);
  });

  it("applies overrides by input id, clamping to min/max", () => {
    const base = plots(run(source));
    expect(base[0]?.[2]).toBe(16.5);
    const high = plots(
      run(source, { inputs: { len: 99, mode: "slow", mult: 1, src: "high" } })
    );
    // len clamps to 5: SMA(high, 5) at bar 4 = (11+12+13+12+14)/5.
    expect(high[0]?.[4]).toBe(12.4);
    expect(high[0]?.[3]).toBeNull();
    expect(high[1]?.[0]).toBe(0);
    const low = plots(run(source, { inputs: { len: -3, show: false } }));
    expect(low[0]?.[1]).toBeNull();
    expect(plots(run(source, { inputs: { len: 2.4 } }))[0]?.[1]).toBe(15.75);
  });

  it("warns on bad or unknown overrides and keeps the default", () => {
    const result = run(source, {
      inputs: { len: "x", mode: "medium", nope: 1 },
    });
    expect(result.warnings).toEqual([
      "Input 'len' ignored: expected a number",
      "Input 'mode' ignored: not one of the options",
      "Unknown input 'nope' ignored",
    ]);
    expect(plots(result)[1]?.[0]).toBe(1);
  });

  it("warns on overrides of the wrong type for bool, source and string inputs", () => {
    const result = run(source, { inputs: { mode: 3, show: 1, src: "zz" } });
    expect(result.warnings).toEqual([
      "Input 'show' ignored: expected true or false",
      "Input 'mode' ignored: expected a string",
      "Input 'src' ignored: expected a price source such as close",
    ]);
  });

  it("rejects non-constant input arguments and inputs in local scope", () => {
    expect(errors("x = input.int(close)")[0]?.message).toBe(
      "input.int default value must be a constant"
    );
    expect(errors("if close > 1\n    x = input(1)")[0]?.message).toMatch(
      /only allowed at the top level/
    );
  });
});

describe("limits and robustness", () => {
  it("rejects oversized sources and bar sets", () => {
    expect(compileScript("x".repeat(SCRIPT_SOURCE_MAX + 1))).toEqual({
      errors: [
        {
          column: 1,
          line: 1,
          message: `Script is too long (max ${SCRIPT_SOURCE_MAX} characters)`,
        },
      ],
      ok: false,
    });
    expect(runScript('indicator("t")', waveBars(SCRIPT_BARS_MAX + 1))).toEqual({
      errors: [
        {
          column: 1,
          line: 1,
          message: `Too many bars (max ${SCRIPT_BARS_MAX})`,
        },
      ],
      ok: false,
    });
  });

  it("validates bars", () => {
    const bad = [SMALL_BARS[1], SMALL_BARS[0]] as ScriptBar[];
    expect(runScript('indicator("t")', bad)).toMatchObject({
      errors: [{ message: "Bar 1 timestamp is not after the previous bar" }],
      ok: false,
    });
  });

  it("never throws on hostile input", () => {
    const hostile: unknown[] = [null, 42, {}, "\u0000", "(".repeat(20_000)];
    for (const source of hostile) {
      expect(() => compileScript(source as string)).not.toThrow();
      expect(compileScript(source as string).ok).toBe(false);
      expect(
        runScript(source as string, null as unknown as ScriptBar[]).ok
      ).toBe(false);
    }
    expect(
      runScript('indicator("t")', "bars" as unknown as ScriptBar[]).ok
    ).toBe(false);
  });

  it("rejects deep nesting that fits the source limit with a positioned error", () => {
    const deep = `indicator("t")\nx = ${"(".repeat(8000)}1${")".repeat(7000)}`;
    expect(deep.length).toBeLessThan(SCRIPT_SOURCE_MAX);
    expect(compileScript(deep)).toEqual({
      errors: [
        { column: 69, line: 2, message: "Expression is nested too deeply" },
      ],
      ok: false,
    });
  });

  it("runs with zero bars", () => {
    expect(run("plot(close)", {}, []).plots[0]?.values).toEqual([]);
  });
});

describe("more language coverage", () => {
  it("returns the value of the last statement, including through if blocks", () => {
    const source = [
      "sign(x) =>",
      "    r = 0",
      "    if x > 12",
      "        r := 1",
      "    else if x < 11",
      "        r := -1",
      "    r",
      "plot(sign(close))",
    ].join("\n");
    expect(series(source)[0]).toEqual([-1, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
  });

  it("joins continuation lines and accepts //@version=6", () => {
    const result = runScript(
      '//@version=6\nindicator("t",\n     overlay=true)\nx = close +\n  1\nplot(x)\n',
      SMALL_BARS
    );
    expect(result).toMatchObject({ ok: true, overlay: true });
    if (result.ok) expect(result.plots[0]?.values[0]).toBe(11);
  });

  it("exposes bar series, time and composite sources", () => {
    const [hl2, ohlc4, time, volume] = series(
      "plot(hl2)\nplot(ohlc4)\nplot(time)\nplot(volume[1])"
    );
    expect(hl2?.[0]).toBe(10);
    expect(ohlc4?.[0]).toBe(9.875);
    expect(time?.[1]).toBe(SMALL_BARS[1]?.timestamp);
    expect(volume?.slice(0, 2)).toEqual([null, 100]);
  });

  it("supports color.rgb, str.tostring in marker text and plotshape offset", () => {
    const result = run(
      'plot(close, color=color.rgb(255, 128, 0))\nplotshape(bar_index == 3, text="b" + str.tostring(bar_index), offset=-1)'
    );
    expect(result.plots[0]?.color).toBe("#ff8000");
    expect(result.signals).toEqual([
      {
        kind: "shape",
        location: "abovebar",
        text: "b3",
        timestamp: SMALL_BARS[2]?.timestamp,
        value: 13,
      },
    ]);
  });

  it("accepts input.color without listing it as an editable input", () => {
    const result = run(
      'c = input.color(color.teal, "Line color")\nplot(close, color=c)'
    );
    expect(result.inputs).toEqual([]);
    expect(result.plots[0]?.color).toBe("#00897b");
  });

  it("reports runtime errors inside functions at the failing expression", () => {
    expect(errors('f(x) => x + "s"\nplot(f(close))')[0]).toEqual({
      column: 11,
      line: 2,
      message: "Operator '+' needs numbers, got number and string",
    });
    expect(errors("plot(ta.sma(close, 0))")[0]).toMatchObject({
      column: 6,
      line: 2,
      message: "ta.sma: 'length' must be a positive integer",
    });
    expect(errors("plot(close[-1])")[0]?.message).toBe(
      "History offset must be a non-negative number"
    );
  });

  it("charges long indicator windows against the operation budget", () => {
    const bars = waveBars(2000);
    const options = { maxOps: 60_000 };
    expect(
      runScript('indicator("t")\nplot(ta.sma(close, 2))\n', bars, options).ok
    ).toBe(true);
    expect(
      runScript('indicator("t")\nplot(ta.sma(close, 1500))\n', bars, options)
    ).toMatchObject({
      errors: [{ message: "Script stopped: operation budget used" }],
      ok: false,
    });
  });
});

describe("operators and statements at run time", () => {
  it("computes modulo and inequality", () => {
    expect(series("plot(close % 3)\nplot(close != 11 ? 1 : 0)")).toEqual([
      [1, 2, 0, 2, 1, 2, 1, 0, 1, 0],
      [1, 0, 1, 0, 1, 1, 1, 1, 1, 1],
    ]);
  });

  it("applies unary operators and propagates na", () => {
    expect(series("plot(-na)\nplot(+close)")).toEqual([
      new Array(10).fill(null),
      [10, 11, 12, 11, 13, 14, 13, 15, 16, 15],
    ]);
    expect(series("plot(close[na])")[0]).toEqual(new Array(10).fill(null));
  });

  it("reports type errors the checker cannot see through function parameters", () => {
    const message = (body: string) => errors(body)[0]?.message;
    expect(message("f() => [1, 2]\nplot(f() == f() ? 1 : 0)")).toBe(
      "Tuples cannot be compared"
    );
    expect(message('f(x) => x < 2\nplot(f("a") ? 1 : 0)')).toBe(
      "Operator '<' needs numbers, got string and number"
    );
    expect(message('f(x) => -x\nplot(f("a") ? 1 : 0)')).toBe(
      "Operator '-' needs a number, got string"
    );
    expect(
      message("f() => [1, 2]\ng() => [f(), 1]\n[a, b] = g()\nplot(a)")
    ).toBe("Tuples cannot be nested");
    expect(message("f() => 1\n[a, b] = f()\nplot(a)")).toBe(
      "Expected 2 values on the right, got number"
    );
    expect(
      message(
        'f(x) =>\n    s = 0.0\n    for i = 0 to x\n        s += 1\n    s\nplot(f("a"))'
      )
    ).toBe("Loop end must be a number");
    expect(message("f(x) => close[x]\nplot(f(-1))")).toBe(
      "History offset must be a non-negative number"
    );
  });

  it("skips loops with an na bound and rejects a zero step", () => {
    expect(
      series(
        "s = 0.0\nfor i = 0 to na\n    s += 1\nfor i = 0 to 3 by na\n    s += 1\nplot(s)"
      )[0]
    ).toEqual(new Array(10).fill(0));
    expect(
      errors("s = 0.0\nfor i = 0 to 5 by 0\n    s += 1\nplot(s)")[0]
    ).toMatchObject({
      message: "Loop step must not be 0",
    });
  });

  it("drops markers shifted before the first bar", () => {
    const result = run("plotshape(true, offset=-2)");
    expect(result.signals).toHaveLength(8);
    expect(result.signals[0]?.timestamp).toBe(SMALL_BARS[0]?.timestamp);
  });

  it("reads the strategy position size history", () => {
    const result = run(
      'if bar_index == 2\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size[1])',
      {},
      SMALL_BARS,
      'strategy("s")'
    );
    expect(plots(result)[0]).toEqual([null, 0, 0, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("charges windowed kernels against the operation budget", () => {
    expect(
      runScript('indicator("t")\nplot(ta.sma(close, 4000))\n', SMALL_BARS, {
        maxOps: 100,
      })
    ).toMatchObject({
      errors: [{ message: "Script stopped: operation budget used" }],
      ok: false,
    });
  });

  it("rejects non-finite bar fields and treats null options as none", () => {
    const bad = [{ ...SMALL_BARS[0]!, close: Number.NaN }];
    expect(runScript('indicator("t")\nplot(close)\n', bad)).toMatchObject({
      errors: [{ message: "Bar 0 has a missing or non-finite field" }],
      ok: false,
    });
    expect(
      runScript(
        'indicator("t")\nplot(close)\n',
        SMALL_BARS,
        null as unknown as RunOptions
      ).ok
    ).toBe(true);
  });
});
