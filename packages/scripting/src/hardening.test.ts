import { describe, expect, it } from "vitest";

import { SMALL_BARS } from "./fixtures.ts";
import {
  compileScript,
  type RunOptions,
  type RunResult,
  runScript,
  SCRIPT_OPS_DEFAULT,
  SCRIPT_SOURCE_MAX,
} from "./index.ts";

type Ok = Extract<RunResult, { ok: true }>;

const source = (body: string, header = 'indicator("t")') =>
  `${header}\n${body}\n`;

const run = (body: string, options: RunOptions = {}, header?: string): Ok => {
  const result = runScript(source(body, header), SMALL_BARS, options);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  // Every result must survive postMessage (structured clone): no functions or prototypes.
  expect(() => structuredClone(result)).not.toThrow();
  return result;
};

const firstError = (
  body: string,
  options: RunOptions = {},
  header?: string
) => {
  const result = runScript(source(body, header), SMALL_BARS, options);
  if (result.ok) throw new Error("expected an error");
  return result.errors[0];
};

const PROTO_KEYS = [
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
  "valueOf",
];

describe("user strings never reach object prototypes", () => {
  it.each(PROTO_KEYS)("plot style %s falls back to a line", (key) => {
    const result = run(`plot(close, style="${key}")`);
    expect(result.plots[0]?.kind).toBe("line");
  });

  it.each(PROTO_KEYS)("plotshape location %s is unknown", (key) => {
    expect(firstError(`plotshape(true, location="${key}")`)).toEqual({
      column: 1,
      line: 2,
      message: `plotshape: unknown location '${key}'`,
    });
  });

  it.each(PROTO_KEYS)("color.%s is not a color", (key) => {
    expect(firstError(`plot(close, color=color.${key})`)?.message).toBe(
      `not supported in Vertex scripts yet: color.${key}`
    );
  });

  it.each(PROTO_KEYS)(
    "namespace members ta.%s / math.%s are unknown",
    (key) => {
      expect(firstError(`x = ta.${key}(close)`)?.message).toBe(
        `not supported in Vertex scripts yet: ta.${key}`
      );
      expect(firstError(`x = math.${key}`)?.message).toBe(
        `not supported in Vertex scripts yet: math.${key}`
      );
      expect(firstError(`x = plot.${key}`)?.message).toBe(
        `not supported in Vertex scripts yet: plot.${key}`
      );
    }
  );

  it.each(PROTO_KEYS)("bare %s() is an unknown function", (key) => {
    expect(firstError(`x = ${key}(1)`)?.message).toBe(
      `Unknown function '${key}'`
    );
  });

  it("input options and overrides treat prototype names as plain strings", () => {
    const body = [
      'mode = input.string("a", "Mode", options=["a", "constructor"])',
      'plot(mode == "constructor" ? 1 : 0)',
    ].join("\n");
    expect(run(body).inputs[0]?.options).toEqual(["a", "constructor"]);
    const picked = run(body, { inputs: { mode: "constructor" } });
    expect(picked.plots[0]?.values[0]).toBe(1);
    const rejected = run(body, { inputs: { mode: "toString" } });
    expect(rejected.plots[0]?.values[0]).toBe(0);
    expect(rejected.warnings).toEqual([
      "Input 'mode' ignored: not one of the options",
    ]);
  });

  it("variables, functions and input ids may use prototype names", () => {
    const body = [
      "constructor = close",
      "toString(x) => x * 2",
      '__proto__ = input.int(3, "Proto")',
      "plot(toString(constructor) + __proto__)",
    ].join("\n");
    expect(run(body).plots[0]?.values[0]).toBe(23);
    const overridden = run(body, {
      inputs: Object.fromEntries([["__proto__", 5]]),
    });
    expect(overridden.inputs[0]?.id).toBe("__proto__");
    expect(overridden.plots[0]?.values[0]).toBe(25);
    // An inherited key is not an override.
    expect(run(body, { inputs: {} }).warnings).toEqual([]);
  });
});

describe("emitted strings are capped", () => {
  const long = (n: number) => "x".repeat(n);

  it("clips script titles to 80 characters with a warning", () => {
    const header = `indicator("${long(120)}", shorttitle="${long(90)}")`;
    const compiled = compileScript(source("plot(close)", header));
    expect(compiled).toMatchObject({
      ok: true,
      shortTitle: long(80),
      title: long(80),
    });
    const result = run("plot(close)", {}, header);
    expect(result.warnings).toEqual([
      "Script title shortened to 80 characters",
      "Script short title shortened to 80 characters",
    ]);
  });

  it("clips plot, hline and input titles to 60 characters", () => {
    const result = run(
      [
        `n = input.int(2, "${long(70)}")`,
        `plot(close, "${long(61)}")`,
        `hline(1, "${long(100)}")`,
        `plot(close, "${long(60)}")`,
      ].join("\n")
    );
    expect(result.plots.map((p) => p.title.length)).toEqual([60, 60, 60]);
    expect(result.inputs[0]?.title).toBe(long(60));
    expect(result.warnings).toEqual([
      "Input 'n': title shortened to 60 characters",
      "Title of plot 1 shortened to 60 characters",
      "Title of hline 2 shortened to 60 characters",
    ]);
  });

  it("clips input options to 32 entries of 60 characters", () => {
    const options = Array.from({ length: 40 }, (_, i) => `"${i}${long(70)}"`);
    const result = run(
      `m = input.string("0${long(70)}", "M", options=[${options.join(", ")}])\nplot(close)`
    );
    const spec = result.inputs[0];
    expect(spec?.options).toHaveLength(32);
    expect(spec?.options?.every((o) => o.length === 60)).toBe(true);
    expect(spec?.defval).toBe(`0${long(59)}`);
    expect(result.warnings).toEqual([
      "Input 'm': options cut to the first 32",
      "Input 'm': options shortened to 60 characters",
      "Input 'm': default shortened to 60 characters",
    ]);
    // The clipped default still selects the clipped option on override.
    const picked = run(
      `m = input.string("0${long(70)}", "M", options=[${options.join(", ")}])\nplot(close)`,
      { inputs: { m: `1${long(59)}` } }
    );
    expect(picked.warnings).not.toContain(
      "Input 'm' ignored: not one of the options"
    );
  });

  it("rejects a default that is only among the clipped-away options", () => {
    const options = Array.from({ length: 40 }, (_, i) => `"o${i}"`);
    expect(
      firstError(`m = input.string("o39", options=[${options.join(", ")}])`)
        ?.message
    ).toBe("Default value must be one of the options");
  });

  it("clips input ids and string defaults", () => {
    const id = `v${long(80)}`;
    const result = run(`${id} = input.string("${long(250)}")\nplot(close)`);
    expect(result.inputs[0]?.id).toBe(id.slice(0, 60));
    expect(result.inputs[0]?.defval).toBe(long(200));
    expect(result.inputs[0]?.title).toBe(id.slice(0, 60));
  });

  it("rejects more than 64 inputs", () => {
    const body = Array.from(
      { length: 65 },
      (_, i) => `i${i} = input(${i})`
    ).join("\n");
    expect(firstError(body)).toEqual({
      column: 7,
      line: 66,
      message: "Too many inputs (max 64)",
    });
  });

  it("clips marker text to 24 characters with one warning", () => {
    const result = run(`plotshape(true, text="${long(30)}")`);
    expect(result.signals).toHaveLength(SMALL_BARS.length);
    expect(result.signals.every((s) => s.text === long(24))).toBe(true);
    expect(result.warnings).toEqual(["Marker text shortened to 24 characters"]);
    const strategy = run(
      `strategy.entry("${long(40)}", strategy.long)`,
      {},
      'strategy("s")'
    );
    expect(strategy.signals[0]?.text).toBe(long(24));
  });

  it("never splits a surrogate pair", () => {
    const result = run(`plotshape(true, text="${"x".repeat(23)}😀")`);
    expect(result.signals[0]?.text).toBe("x".repeat(23));
  });
});

describe("operation budget option", () => {
  // About 3 ops per iteration: 1.5M iterations exceed the 2M default.
  const heavy = "x = 0\nfor i = 1 to 1500000\n    x += 1\nplot(x)";
  const once = [SMALL_BARS[0]] as const;
  const runOnce = (body: string, maxOps: number) =>
    runScript(source(body), once as never, { maxOps });

  it.each([Number.POSITIVE_INFINITY, Number.NaN, Number.NEGATIVE_INFINITY])(
    "%s falls back to the default budget",
    (maxOps) => {
      expect(runOnce(heavy, maxOps)).toMatchObject({
        errors: [{ message: "Script stopped: operation budget used" }],
        ok: false,
      });
    }
  );

  it("clamps to 10x the default", () => {
    const endless = "x = 0\nfor i = 1 to 1000000000\n    x += 1\nplot(x)";
    expect(runOnce(endless, 1e15)).toMatchObject({
      errors: [{ message: "Script stopped: operation budget used" }],
      ok: false,
    });
    // 10x the default is enough for the heavy loop.
    expect(runOnce(heavy, 10 * SCRIPT_OPS_DEFAULT).ok).toBe(true);
  });

  it("clamps small and fractional values to at least 1", () => {
    for (const maxOps of [0, -5, 0.5]) {
      expect(runOnce("plot(close)", maxOps)).toMatchObject({
        errors: [{ line: 1, message: "Script stopped: operation budget used" }],
        ok: false,
      });
    }
  });
});

describe("deep expressions and runaway strings get positioned errors", () => {
  it("rejects long operator chains at the operator, within the source limit", () => {
    const chain = `x = ${Array.from({ length: 2000 }, () => "1").join(" + ")}`;
    expect(chain.length).toBeLessThan(SCRIPT_SOURCE_MAX);
    const error = firstError(chain);
    expect(error?.message).toBe(
      "Expression is too long; split it into smaller steps"
    );
    expect(error?.line).toBe(2);
    // The 256th operator: "x = " then "1 + " per term.
    expect(error?.column).toBe(4 + 255 * 4 + 3);
  });

  it("accepts a chain under the cap", () => {
    const chain = `plot(${Array.from({ length: 200 }, () => "1").join(" + ")})`;
    expect(run(chain).plots[0]?.values[0]).toBe(200);
  });

  it("rejects long history chains", () => {
    expect(firstError(`x = close${"[0]".repeat(300)}`)).toMatchObject({
      line: 2,
      message: "Expression is too long; split it into smaller steps",
    });
  });

  it("rejects deep bracket nesting within the source limit", () => {
    const deep = `x = ${"(".repeat(5000)}1${")".repeat(5000)}`;
    expect(deep.length).toBeLessThan(SCRIPT_SOURCE_MAX);
    expect(firstError(deep)).toMatchObject({
      line: 2,
      message: "Expression is nested too deeply",
    });
  });

  it("stops runaway strings at the line that grows them", () => {
    expect(
      firstError('var s = "ab"\ns := s + s + s + s\nplot(close)')
    ).toMatchObject({
      line: 3,
      message: "String too long (max 4096 characters)",
    });
    expect(
      firstError('s = ""\nfor i = 1 to 1000\n    s += "abcdefgh"\nplot(close)')
    ).toEqual({
      column: 5,
      line: 4,
      message: "String too long (max 4096 characters)",
    });
  });

  it("rejects oversized string literals and constant concatenation", () => {
    expect(firstError(`x = "${"y".repeat(5000)}"`)).toEqual({
      column: 5,
      line: 2,
      message: "String too long (max 4096 characters)",
    });
    const half = `"${"y".repeat(2100)}"`;
    expect(compileScript(`indicator(${half} + ${half})`)).toMatchObject({
      errors: [{ message: "String too long (max 4096 characters)" }],
      ok: false,
    });
  });
});

describe("lengths must be whole numbers, not price series", () => {
  const lengthError = (name: string, param: string) =>
    `${name}: '${param}' must be a whole number, not a price series (missing an argument?)`;

  it.each([
    ["x = ta.highest(close)", 16, "ta.highest", "length"],
    ["x = ta.lowest(low)", 15, "ta.lowest", "length"],
    ["x = ta.pivothigh(high, 5)", 18, "ta.pivothigh", "leftbars"],
    ["x = ta.sma(close, close)", 19, "ta.sma", "length"],
    ["x = ta.ema(close, hl2 * 2)", 19, "ta.ema", "length"],
    ["x = ta.macd(close, 12, open, 9)", 24, "ta.macd", "slowlen"],
    ["x = ta.atr(ta.sma(close, 3))", 12, "ta.atr", "length"],
  ])("%s is a compile error", (body, column, name, param) => {
    const compiled = compileScript(source(body));
    expect(compiled).toEqual({
      errors: [{ column, line: 2, message: lengthError(name, param) }],
      ok: false,
    });
  });

  it("follows price series through variables and input.source", () => {
    expect(
      firstError("src = input.source(close)\nx = ta.highest(src)")?.message
    ).toBe(lengthError("ta.highest", "length"));
    expect(firstError("p = close[1] - 1\nx = ta.rsi(close, p)")?.message).toBe(
      lengthError("ta.rsi", "length")
    );
  });

  it("accepts integer lengths in every form", () => {
    const result = run(
      [
        'len = input.int(3, "Len")',
        "n = 2",
        "plot(ta.highest(3))",
        "plot(ta.highest(high, len))",
        "plot(ta.lowest(low, n + 1))",
        "plot(ta.pivothigh(1, 1))",
        "plot(ta.sma(close, ta.barssince(close > 0) + 2))",
      ].join("\n")
    );
    expect(result.plots.map((p) => p.values[4])).toEqual([
      14,
      14,
      10,
      null,
      12,
    ]);
    expect(result.plots[3]?.values[3]).toBe(13);
  });

  it("rejects missing required lengths and fractional lengths", () => {
    expect(firstError("x = ta.sma(close)")?.message).toBe(
      "'ta.sma' expects 2 arguments, got 1"
    );
    expect(firstError("x = ta.atr()")?.message).toBe(
      "'ta.atr' expects 1 argument, got 0"
    );
    expect(firstError("x = ta.pivotlow(2)")?.message).toBe(
      "'ta.pivotlow' expects 2 to 3 arguments, got 1"
    );
    expect(firstError("plot(ta.sma(close, 2.5))")).toEqual({
      column: 6,
      line: 2,
      message: "ta.sma: 'length' must be a positive integer",
    });
  });
});
