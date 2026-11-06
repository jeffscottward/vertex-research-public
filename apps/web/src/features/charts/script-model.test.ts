import type {
  RunResult,
  ScriptInputSpec,
  ScriptTemplate,
} from "@darkfactory/scripting";
import { describe, expect, it } from "vitest";
import {
  type AppliedScript,
  caretOffset,
  describeRun,
  groupTemplates,
  inputOptions,
  inputValue,
  isFreshRun,
  parseInputValue,
  resolveActiveScripts,
  type ScriptRun,
  SOURCE_OPTIONS,
  scriptLayers,
  toScriptBars,
} from "./script-model.ts";

const candles = [
  { close: 2, high: 3, id: "a", low: 1, open: 2, timestamp: 1000, volume: 5 },
];
const bars = toScriptBars(candles);
const ok = (
  extra: Partial<Extract<RunResult, { ok: true }>> = {}
): RunResult => ({
  inputs: [],
  kind: "indicator",
  ok: true,
  overlay: true,
  plots: [
    { color: "#2962ff", id: "plot_0", kind: "line", title: "SMA", values: [2] },
  ],
  shortTitle: "",
  signals: [],
  title: "Average",
  warnings: [],
  ...extra,
});
const entry = (id: string, title = "Mine"): AppliedScript => ({
  id,
  inputs: {},
  ref: null,
  source: "src",
  title,
});
const run = (applied: AppliedScript, result: RunResult): ScriptRun => ({
  bars,
  inputs: applied.inputs,
  result,
  source: applied.source,
});
const spec = (extra: Partial<ScriptInputSpec>): ScriptInputSpec => ({
  defval: 14,
  id: "length",
  kind: "int",
  title: "Length",
  ...extra,
});

describe("script panel model", () => {
  it("maps candles to script bars without ids", () =>
    expect(bars).toEqual([
      { close: 2, high: 3, low: 1, open: 2, timestamp: 1000, volume: 5 },
    ]));
  it("builds layers only when every applied script ran on these bars", () => {
    const first = entry("l1");
    const second = entry("l2", "");
    const runs = new Map([
      [first.id, run(first, ok({ shortTitle: "AVG" }))],
      [second.id, run(second, ok())],
    ]);
    expect(scriptLayers([first, second], runs, bars)).toEqual([
      expect.objectContaining({ id: "l1", overlay: true, title: "AVG" }),
      expect.objectContaining({ id: "l2", title: "Average" }),
    ]);
    // New bars, a changed source or changed inputs: wait for the re-run.
    expect(scriptLayers([first], runs, toScriptBars(candles))).toBeNull();
    expect(
      scriptLayers([{ ...first, source: "changed" }], runs, bars)
    ).toBeNull();
    expect(scriptLayers([{ ...first, inputs: {} }], runs, bars)).toBeNull();
    expect(scriptLayers([entry("missing")], runs, bars)).toBeNull();
    expect(isFreshRun(undefined, first, bars)).toBe(false);
    // A failed run draws nothing; titles fall back to the entry, then "Script".
    const failed = new Map([
      [first.id, run(first, { errors: [], ok: false })],
      [second.id, run(second, ok({ title: "" }))],
    ]);
    expect(scriptLayers([first, second], failed, bars)).toEqual([
      expect.objectContaining({ id: "l2", title: "Script" }),
    ]);
    const named = new Map([[first.id, run(first, ok({ title: "" }))]]);
    return expect(scriptLayers([first], named, bars)?.[0]?.title).toBe("Mine");
  });
  it("finds the caret offset for a line and column, clamped", () => {
    const source = "ab\ncdef\ng";
    expect(caretOffset(source, 1, 1)).toBe(0);
    expect(caretOffset(source, 2, 3)).toBe(5);
    expect(caretOffset(source, 2, 99)).toBe(7);
    expect(caretOffset(source, 9, 1)).toBe(8);
    expect(caretOffset(source, 0, 0)).toBe(0);
    return expect(caretOffset(source, Number.NaN, Number.NaN)).toBe(0);
  });
  it("groups templates by category in a fixed order, skipping empty ones", () => {
    const template = (id: string, category: ScriptTemplate["category"]) => ({
      category,
      description: id,
      id,
      source: "",
      title: id,
    });
    const groups = groupTemplates([
      template("rsi", "momentum"),
      template("sma", "trend"),
      template("ema", "trend"),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["Trend", "Momentum"]);
    return expect(groups[0]?.templates.map((entry) => entry.id)).toEqual([
      "sma",
      "ema",
    ]);
  });
  it("resolves stored refs to saved scripts and templates", () => {
    const saved = [{ id: "a:b", source: "s1", title: "Saved", updatedAt: 1 }];
    const templates: ScriptTemplate[] = [
      {
        category: "trend",
        description: "",
        id: "sma",
        source: "s2",
        title: "SMA",
      },
    ];
    return expect(
      resolveActiveScripts(
        [
          { inputs: { length: 2 }, ref: "saved:a:b" },
          { inputs: {}, ref: "template:sma" },
          { inputs: {}, ref: "saved:gone" },
          { inputs: {}, ref: "template:gone" },
        ],
        saved,
        templates
      )
    ).toEqual([
      { inputs: { length: 2 }, ref: "saved:a:b", source: "s1", title: "Saved" },
      { inputs: {}, ref: "template:sma", source: "s2", title: "SMA" },
    ]);
  });
  it("reads input values with defaults and parses control values", () => {
    const length = spec({ max: 50, min: 1 });
    expect(inputValue(length, {})).toBe(14);
    expect(inputValue(length, { length: 20 })).toBe(20);
    expect(inputValue(length, { length: "20" })).toBe(14);
    expect(inputValue(spec({ id: "toString" }), {})).toBe(14);
    expect(parseInputValue(length, "20")).toBe(20);
    for (const raw of ["", " ", "abc", "2.5", "0", "51", true])
      expect(parseInputValue(length, raw)).toBeNull();
    const factor = spec({ defval: 2, kind: "float" });
    expect(parseInputValue(factor, "2.5")).toBe(2.5);
    expect(parseInputValue(factor, "Infinity")).toBeNull();
    const flag = spec({ defval: true, kind: "bool" });
    expect(parseInputValue(flag, false)).toBe(false);
    expect(parseInputValue(flag, "true")).toBeNull();
    const label = spec({ defval: "x", kind: "string" });
    return expect(parseInputValue(label, "y".repeat(300))).toHaveLength(200);
  });
  it("offers options for sources and option lists", () => {
    expect(inputOptions(spec({ defval: "close", kind: "source" }))).toBe(
      SOURCE_OPTIONS
    );
    expect(
      inputOptions(spec({ defval: "a", kind: "string", options: ["a", "b"] }))
    ).toEqual(["a", "b"]);
    expect(
      inputOptions(spec({ defval: "a", kind: "string", options: [] }))
    ).toEqual([]);
    return expect(inputOptions(spec({}))).toEqual([]);
  });
  it("describes runs for the status line", () => {
    expect(describeRun(ok(), "Avg")).toBe(
      '"Avg" is on the chart: 1 plot, 0 signals.'
    );
    expect(
      describeRun(
        ok({
          plots: [],
          signals: [
            {
              kind: "long",
              location: "belowbar",
              text: "L",
              timestamp: 1000,
              value: 1,
            },
          ],
          warnings: ["Only the last 5000 bars were used."],
        }),
        "Avg"
      )
    ).toBe(
      '"Avg" is on the chart: 0 plots, 1 signal. Only the last 5000 bars were used.'
    );
    return expect(
      describeRun(
        {
          errors: [
            { column: 1, line: 1, message: "a" },
            { column: 1, line: 2, message: "b" },
          ],
          ok: false,
        },
        "Avg"
      )
    ).toBe('"Avg" did not run: 2 errors.');
  });
});
