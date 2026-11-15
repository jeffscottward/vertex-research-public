// Builtin impls called directly with a stub host: covers the defensive paths the checker
// and runtime never route a script into (na/out-of-range bars, wrong argument types).

import { describe, expect, it } from "vitest";

import {
  type Args,
  BUILTIN_FUNCTIONS,
  BUILTIN_VARIABLES,
  type CallEnv,
  type RuntimeHost,
  type SignalRequest,
  SOURCES,
  truthy,
} from "./builtins.ts";
import { START } from "./errors.ts";
import { SMALL_BARS } from "./fixtures.ts";
import { Site } from "./series.ts";
import { color, type Value } from "./values.ts";

type StubHost = RuntimeHost & { signals: SignalRequest[] };

const stubHost = (): StubHost => {
  const signals: SignalRequest[] = [];
  return {
    bars: SMALL_BARS,
    input: () => null,
    isStrategy: true,
    obv: () => null,
    plot: () => undefined,
    position: null,
    positionSize: () => 0,
    signal: (request) => {
      signals.push(request);
    },
    signals,
  };
};

const stubEnv = (
  name: string,
  overrides: Partial<CallEnv> = {}
): CallEnv & { host: StubHost } => {
  const site = new Site();
  return {
    at: START,
    bar: 0,
    charge: () => undefined,
    host: stubHost(),
    id: 1,
    name,
    site: () => site,
    ...overrides,
  } as CallEnv & { host: StubHost };
};

const call = (name: string, args: Args, env = stubEnv(name)): Value => {
  const spec = BUILTIN_FUNCTIONS.get(name);
  if (!spec) throw new Error(`no builtin ${name}`);
  return spec.impl(args, env);
};

describe("argument coercion", () => {
  it("rejects wrong argument types", () => {
    expect(() => call("math.abs", ["x"])).toThrow(
      "math.abs: 'number' must be a number, got string"
    );
    expect(() => call("ta.sma", [1, 0])).toThrow(
      "ta.sma: 'length' must be a positive integer"
    );
    expect(() => call("ta.valuewhen", [true, 1, -1])).toThrow(
      "ta.valuewhen: 'occurrence' must be a non-negative integer"
    );
    expect(() =>
      call("plotshape", [true, null, null, null, null, null, 5])
    ).toThrow("plotshape: 'text' must be a string");
    expect(() => call("color.new", ["red"])).toThrow(
      "color.new: 'color' must be a color"
    );
  });

  it("reads conditions: na is false, numbers are non-zero, others fail", () => {
    expect(truthy(undefined, START)).toBe(false);
    expect(truthy(null, START)).toBe(false);
    expect(truthy(0, START)).toBe(false);
    expect(truthy(2, START)).toBe(true);
    expect(truthy(true, START)).toBe(true);
    expect(() => truthy("x", START)).toThrow(
      "Expected a condition, got string"
    );
    expect(call("bool", [1])).toBe(true);
  });
});

describe("pure functions", () => {
  it("passes na through", () => {
    expect(call("math.abs", [null])).toBeNull();
    expect(call("color.new", [null])).toBeNull();
    expect(call("color.rgb", [1, null, 3])).toBeNull();
    expect(call("int", [null])).toBeNull();
    expect(call("float", [null])).toBeNull();
    expect(call("math.pow", [null, 2])).toBeNull();
    expect(call("math.pow", [2, null])).toBeNull();
    expect(call("math.round", [null])).toBeNull();
  });

  it("casts and formats values", () => {
    expect(call("int", [-2.7])).toBe(-2);
    expect(call("float", [2.5])).toBe(2.5);
    expect(call("color.new", [color("#FF0000"), 50])).toEqual({
      color: "#ff0000",
    });
    expect(call("str.tostring", [])).toBe("NaN");
    expect(call("str.tostring", [null])).toBe("NaN");
    expect(call("str.tostring", [color("#00FF00")])).toBe("#00ff00");
    expect(call("str.tostring", [[1, 2]])).toBe("");
    expect(call("str.tostring", [true])).toBe("true");
  });

  it("returns na for ta.tr past the last bar", () => {
    expect(call("ta.tr", [], stubEnv("ta.tr", { bar: 99 }))).toBeNull();
  });
});

describe("compile-time builtins", () => {
  it("do nothing when called at run time", () => {
    expect(call("bgcolor", [])).toBeNull();
    expect(call("indicator", ["t"])).toBeNull();
  });
});

describe("bar variables", () => {
  it("read every builtin variable on a bar", () => {
    const host = stubHost();
    const last = SMALL_BARS.length - 1;
    const read = (name: string, bar: number) =>
      BUILTIN_VARIABLES.get(name)?.(host, bar);
    expect(read("barstate.isconfirmed", 0)).toBe(true);
    expect(read("barstate.isfirst", 0)).toBe(true);
    expect(read("barstate.ishistory", 0)).toBe(true);
    expect(read("barstate.islast", last)).toBe(true);
    expect(read("barstate.isnew", 0)).toBe(true);
    expect(read("barstate.isrealtime", 0)).toBe(false);
    expect(read("last_bar_index", 0)).toBe(last);
    // fixtures start at 2026-01-05 14:30 UTC, one bar per minute.
    expect(read("dayofmonth", 0)).toBe(5);
    expect(read("dayofweek", 0)).toBe(2);
    expect(read("hour", 0)).toBe(14);
    expect(read("minute", 1)).toBe(31);
    expect(read("month", 0)).toBe(1);
    expect(read("year", 0)).toBe(2026);
    expect(SOURCES.get("hlcc4")?.(SMALL_BARS[0]!)).toBe(10);
  });

  it("are na past the last bar", () => {
    const host = stubHost();
    for (const name of ["dayofmonth", "time", "close", "ta.tr"]) {
      expect(BUILTIN_VARIABLES.get(name)?.(host, 99)).toBeNull();
    }
  });

  it("fail when a bar-reading builtin has no bar", () => {
    expect(() =>
      call("ta.vwma", [1, 2], stubEnv("ta.vwma", { bar: 99 }))
    ).toThrow("No bar data");
  });
});

describe("markers and strategy", () => {
  it("prices absolute shapes at the series value", () => {
    const env = stubEnv("plotshape");
    call("plotshape", [5, null, null, "absolute"], env);
    call("plotshape", [true, null, null, "absolute"], env);
    expect(env.host.signals.map((s) => s.price)).toEqual([5, null]);
  });

  it("labels a plotchar marker with its char unless text is given", () => {
    const env = stubEnv("plotchar");
    call("plotchar", [true, null, "▲"], env);
    call("plotchar", [true, null, "▲", null, null, null, "buy"], env);
    call("plotchar", [true], env);
    expect(env.host.signals.map((s) => s.text)).toEqual(["▲", "buy", ""]);
  });

  it("enters with an empty id and rejects bad directions", () => {
    const env = stubEnv("strategy.entry");
    call("strategy.entry", [null, "long"], env);
    expect(env.host.position).toEqual({ direction: "long", id: "" });
    expect(() => call("strategy.entry", ["x", "up"], env)).toThrow(
      "direction must be strategy.long or strategy.short"
    );
  });

  it("marks a short exit below the bar and ignores closes with no position", () => {
    const env = stubEnv("strategy.close_all");
    call("strategy.close_all", [], env);
    expect(env.host.signals).toEqual([]);
    call("strategy.entry", ["s", "short"], env);
    call("strategy.close_all", [null, null, null, null, false], env);
    expect(env.host.position).not.toBeNull();
    call("strategy.close_all", ["done"], env);
    expect(env.host.position).toBeNull();
    expect(env.host.signals.at(-1)).toMatchObject({
      kind: "exit",
      location: "belowbar",
      text: "done",
    });
  });

  it("skips strategy.close when its when= is false", () => {
    const env = stubEnv("strategy.close");
    call("strategy.entry", ["L", "long"], env);
    call(
      "strategy.close",
      ["L", null, null, null, null, null, null, false],
      env
    );
    expect(env.host.position).toEqual({ direction: "long", id: "L" });
  });
});

describe("stateful builtins", () => {
  const series = (name: string, args: (bar: number) => Args) => {
    const env = stubEnv(name);
    return SMALL_BARS.map((_, bar) => call(name, args(bar), { ...env, bar }));
  };

  it("finds low pivots from bar lows when no source is given", () => {
    const values = series("ta.pivotlow", () => [1, 1]);
    // lows: 9 10 11 10 12 13 12 14 15 14 -> pivot lows at bars 3 and 6, confirmed a bar later.
    expect(values).toEqual([
      null,
      null,
      null,
      null,
      10,
      null,
      null,
      12,
      null,
      null,
    ]);
  });

  it("sums a window, fixes na and reads na mult as 0", () => {
    const closes = SMALL_BARS.map((b) => b.close);
    expect(series("math.sum", (bar) => [closes[bar]!, 2])[1]).toBe(21);
    expect(
      series("fixnan", (bar) => [bar === 1 ? null : closes[bar]!]).slice(0, 2)
    ).toEqual([10, 10]);
    const bands = series("ta.bb", (bar) => [closes[bar]!, 2, null]);
    expect(bands[1]).toEqual([10.5, 10.5, 10.5]);
  });

  it("returns na for an unbiased stdev of length 1", () => {
    expect(series("ta.stdev", () => [1, 1, false])[0]).toBeNull();
  });
});
