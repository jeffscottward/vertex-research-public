import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantArtifactSchema } from "../contracts/assistant.ts";

// The script engine is another package; these tests fix its compile result. One test in
// assistant-chart-tools.engine.test.ts runs chart_script against the real engine.
const scripting = vi.hoisted(() => ({ compileScript: vi.fn() }));
vi.mock("@darkfactory/scripting", () => ({
  compileScript: scripting.compileScript,
}));

import {
  ASSISTANT_CHART_TOOLS,
  ARTIFACT_NOT_STORED,
  cleanStrings,
  cleanText,
  type ChartToolContext,
  type ChartToolOutcome,
  isChartTool,
  jsonbTextBytes,
  parseChartTime,
  runChartTool,
  shortTurnId,
  storableTrace,
} from "./assistant-chart-tools.ts";

const contextFor = (
  turnId = "abc12345",
  chartSymbol?: string
): ChartToolContext => {
  let next = 0;
  return {
    nextDrawingNumber: () => {
      next += 1;
      return next;
    },
    turnId,
    ...(chartSymbol === undefined ? {} : { chartSymbol }),
  };
};

const JAN_2 = Date.UTC(2026, 0, 2);
const JAN_3 = Date.UTC(2026, 0, 3);

const errorOf = (outcome: ChartToolOutcome): string => {
  if (!("error" in outcome)) throw new Error("expected a tool error");
  return outcome.error;
};

const artifactOf = (outcome: ChartToolOutcome) => {
  if (!("artifact" in outcome)) throw new Error("expected an artifact");
  return outcome.artifact;
};

beforeEach(() => {
  scripting.compileScript.mockReset();
});

describe("chart tool registry", () => {
  it("lists four tools with object JSON Schemas and display-only descriptions", () => {
    expect(ASSISTANT_CHART_TOOLS.map((tool) => tool.name)).toEqual([
      "chart_draw",
      "chart_clear_drawings",
      "chart_script",
      "teach_steps",
    ]);
    for (const tool of ASSISTANT_CHART_TOOLS) {
      expect(tool.parameters["type"]).toBe("object");
      expect(tool.parameters["$schema"]).toBeUndefined();
      expect(tool.parameters["additionalProperties"]).toBe(false);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(isChartTool(tool.name)).toBe(true);
    }
    expect(isChartTool("market_bars")).toBe(false);
    return expect(runChartTool("market_bars", {}, contextFor())).toEqual({
      error: "Tool not available to the assistant",
    });
  });

  it("reads ISO-8601 times (no offset means UTC) and epoch milliseconds", () => {
    expect(parseChartTime("2026-01-02")).toBe(JAN_2);
    expect(parseChartTime("2026-01-02T00:00:00Z")).toBe(JAN_2);
    expect(parseChartTime("2026-01-02T00:00")).toBe(JAN_2);
    expect(parseChartTime("2026-01-02 00:00:00")).toBe(JAN_2);
    expect(parseChartTime("2026-01-01T19:00:00-05:00")).toBe(JAN_2);
    expect(parseChartTime("2026-01-02T00:00:00.000+0000")).toBe(JAN_2);
    expect(parseChartTime(JAN_2)).toBe(JAN_2);
    for (const bad of [
      "yesterday",
      "2026-13-40",
      "2026-01-02T25:00:00Z",
      "1767312000",
      "",
      1_767_312_000, // seconds, not milliseconds
      1.5,
      Number.MAX_SAFE_INTEGER,
    ])
      expect(parseChartTime(bad)).toBeNull();
  });

  it("shortens turn ids to their last 8 letters or digits", () => {
    expect(shortTurnId("0193f1c2-aaaa-7bbb-8ccc-1234ABCD5678")).toBe(
      "abcd5678"
    );
    expect(shortTurnId("message-1")).toBe("message1");
    return expect(shortTurnId("---")).toMatch(/^[a-z0-9]{1,8}$/u);
  });
});

describe("chart_draw", () => {
  it("converts drawings to chart points with quant ids numbered across the turn", () => {
    const context = contextFor();
    const first = runChartTool(
      "chart_draw",
      {
        drawings: [
          {
            points: [{ price: 5000, time: "2026-01-02" }],
            text: " Support ",
            tool: "level",
          },
          {
            points: [
              { price: 4990, time: JAN_2 },
              { price: 5010, time: "2026-01-03T00:00:00Z" },
            ],
            tool: "trend",
          },
        ],
        symbol: "es",
      },
      context
    );
    expect(first).toEqual({
      artifact: {
        drawings: [
          {
            id: "quant-abc12345-1",
            points: [{ timestamp: JAN_2, value: 5000 }],
            text: "Support",
            tool: "level",
          },
          {
            id: "quant-abc12345-2",
            points: [
              { timestamp: JAN_2, value: 4990 },
              { timestamp: JAN_3, value: 5010 },
            ],
            text: "",
            tool: "trend",
          },
        ],
        kind: "chart_drawings",
        replace: false,
        symbol: "ES",
      },
      text: expect.stringContaining("Prepared 2 drawings for ES"),
    });
    const second = artifactOf(
      runChartTool(
        "chart_draw",
        {
          drawings: [
            {
              points: [{ price: 5005, time: JAN_3 }],
              text: "Note",
              tool: "text",
            },
          ],
          replace: true,
          symbol: "ES",
        },
        context
      )
    );
    expect(second).toMatchObject({
      drawings: [{ id: "quant-abc12345-3" }],
      replace: true,
    });
    return expect(AssistantArtifactSchema.parse(second)).toEqual(second);
  });

  it("refuses wrong point counts per tool, bad times, missing text and too many drawings", () => {
    const point = { price: 1, time: JAN_2 };
    const draw = (drawings: unknown[], symbol = "ES") =>
      errorOf(runChartTool("chart_draw", { drawings, symbol }, contextFor()));
    expect(draw([{ points: [point], tool: "trend" }])).toBe(
      "drawings[0]: a trend drawing needs 2 points, got 1"
    );
    expect(draw([{ points: [point], tool: "rectangle" }])).toMatch(
      /rectangle drawing needs 2 points/
    );
    expect(draw([{ points: [point], tool: "fib" }])).toMatch(
      /fib drawing needs 2 points/
    );
    expect(draw([{ points: [point, point], tool: "level" }])).toBe(
      "drawings[0]: a level drawing needs 1 point, got 2"
    );
    expect(
      draw([
        { points: [point], tool: "level" },
        { points: [point, point], tool: "text", text: "x" },
      ])
    ).toMatch(/^drawings\[1\]: a text drawing needs 1 point/);
    expect(draw([{ points: [point], tool: "text" }])).toBe(
      "drawings[0]: a text drawing needs text"
    );
    expect(
      draw([{ points: [{ price: 1, time: "last tuesday" }], tool: "level" }])
    ).toMatch(/^drawings\[0\]\.points\[0\]\.time: use ISO-8601/);
    expect(
      draw([{ points: [{ price: 1, time: 1_767_312_000 }], tool: "level" }])
    ).toMatch(/epoch milliseconds/);
    expect(
      draw(new Array(25).fill({ points: [point], tool: "level" }))
    ).toMatch(/^Invalid arguments: drawings: /);
    expect(draw([])).toMatch(/^Invalid arguments: drawings: /);
    expect(draw([{ points: [point], tool: "arrow" }])).toMatch(
      /drawings\.0\.tool/
    );
    expect(draw([{ points: [point], tool: "level" }], "BF-B")).toMatch(
      /symbol: Symbol: letters/
    );
    expect(
      draw([{ points: [{ price: 1e13, time: JAN_2 }], tool: "level" }])
    ).toMatch(/^Invalid arguments: drawings\.0\.points\.0\.value/);
    return expect(
      errorOf(runChartTool("chart_draw", "not an object", contextFor()))
    ).toMatch(/^Invalid arguments: arguments: /);
  });

  it("defaults to the chart the operator is on, and asks for a symbol off a chart", () => {
    const drawings = [{ points: [{ price: 1, time: JAN_2 }], tool: "level" }];
    expect(
      artifactOf(
        runChartTool("chart_draw", { drawings }, contextFor("t", "ESZ6"))
      )
    ).toMatchObject({ symbol: "ESZ6" });
    // A given symbol wins over the chart's.
    expect(
      artifactOf(
        runChartTool(
          "chart_draw",
          { drawings, symbol: "nqz6" },
          contextFor("t", "ESZ6")
        )
      )
    ).toMatchObject({ symbol: "NQZ6" });
    expect(
      errorOf(runChartTool("chart_draw", { drawings }, contextFor()))
    ).toBe(
      "Name the chart symbol: no symbol was given and the operator is not on a chart"
    );
    const draw = ASSISTANT_CHART_TOOLS.find(
      (tool) => tool.name === "chart_draw"
    );
    expect(draw?.description).toContain("exact chart symbol");
    return expect(JSON.stringify(draw?.parameters["properties"])).toContain(
      "ESZ6, not the root ES"
    );
  });

  it("lists at most five validation issues", () => {
    const message = errorOf(
      runChartTool(
        "chart_draw",
        {
          drawings: new Array(7).fill({ points: [], tool: "nope" }),
          symbol: "ES",
        },
        contextFor()
      )
    );
    expect(message.split("; ")).toHaveLength(5);
    return expect(message).toMatch(/\(and \d+ more\)$/u);
  });
});

describe("chart_clear_drawings", () => {
  it("returns a clear artifact for the symbol", () => {
    expect(
      runChartTool("chart_clear_drawings", { symbol: "nq" }, contextFor())
    ).toEqual({
      artifact: { kind: "chart_clear", symbol: "NQ" },
      text: expect.stringContaining("NQ"),
    });
    expect(
      runChartTool("chart_clear_drawings", {}, contextFor("t", "esz6"))
    ).toMatchObject({ artifact: { kind: "chart_clear", symbol: "ESZ6" } });
    expect(
      errorOf(runChartTool("chart_clear_drawings", {}, contextFor()))
    ).toMatch(/^Name the chart symbol/);
    return expect(
      errorOf(
        runChartTool("chart_clear_drawings", { symbol: "BF-B" }, contextFor())
      )
    ).toMatch(/^Invalid arguments: symbol/);
  });
});

describe("chart_script", () => {
  const source = '//@version=5\nindicator("EMA", overlay=true)\nplot(close)';

  it("compiles the script and returns it with the declared overlay", () => {
    scripting.compileScript.mockReturnValue({
      inputs: [{ defval: 20, id: "len", kind: "int", title: "Length" }],
      kind: "indicator",
      ok: true,
      overlay: false,
      shortTitle: "EMA",
      title: "EMA",
    });
    const outcome = runChartTool(
      "chart_script",
      { source, title: "My EMA" },
      contextFor()
    );
    expect(scripting.compileScript).toHaveBeenCalledWith(source);
    return expect(outcome).toEqual({
      artifact: {
        kind: "chart_script",
        overlay: false,
        source,
        title: "My EMA",
      },
      text: 'Compiled "EMA" (indicator, in its own pane, 1 input). The operator can open it in the chart\'s script editor; it is display only.',
    });
  });

  it("lists up to ten compile errors as line:column messages and no artifact", () => {
    scripting.compileScript.mockReturnValue({
      errors: Array.from({ length: 12 }, (_, index) => ({
        column: index + 1,
        line: index + 2,
        message: index === 0 ? `Unknown function ${"x".repeat(200)}` : "Bad",
      })),
      ok: false,
    });
    const message = errorOf(
      runChartTool("chart_script", { source, title: "Broken" }, contextFor())
    );
    const lines = message.split("\n");
    expect(lines[0]).toBe(
      "The script did not compile (12 errors). Fix them and call chart_script again:"
    );
    expect(lines[1]).toMatch(/^- line 2:1 Unknown function x+…$/u);
    expect(lines[1]?.length).toBeLessThan(180);
    expect(lines[2]).toBe("- line 3:2 Bad");
    expect(lines).toHaveLength(12);
    expect(lines.at(-1)).toBe("- and 2 more");
    scripting.compileScript.mockReturnValue({
      errors: [{ column: 3, line: 1, message: "Expected )" }],
      ok: false,
    });
    return expect(
      errorOf(
        runChartTool("chart_script", { source, title: "x" }, contextFor())
      )
    ).toBe(
      "The script did not compile (1 error). Fix them and call chart_script again:\n- line 1:3 Expected )"
    );
  });

  it("turns an engine failure or bad arguments into a tool error", () => {
    scripting.compileScript.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(
      errorOf(
        runChartTool("chart_script", { source, title: "x" }, contextFor())
      )
    ).toBe("The script check failed; try a simpler script");
    expect(
      errorOf(
        runChartTool(
          "chart_script",
          { source: "x".repeat(16_001), title: "x" },
          contextFor()
        )
      )
    ).toMatch(/^Invalid arguments: source/);
    return expect(scripting.compileScript).toHaveBeenCalledTimes(1);
  });
});

describe("teach_steps", () => {
  it("returns the walkthrough with step drawings converted and numbered", () => {
    const outcome = runChartTool(
      "teach_steps",
      {
        steps: [
          {
            body: "Price often pauses at old highs.",
            title: "What a level is",
          },
          {
            body: "This one held twice.",
            drawings: [
              {
                points: [{ price: 5000, time: "2026-01-02" }],
                text: "Level",
                tool: "level",
              },
            ],
            title: "An example",
          },
          { body: "Nothing to draw.", drawings: [], title: "Recap" },
        ],
        topic: "Support levels",
      },
      contextFor("turn9999", "ESZ6")
    );
    expect(artifactOf(outcome)).toEqual({
      kind: "teach",
      symbol: "ESZ6",
      steps: [
        { body: "Price often pauses at old highs.", title: "What a level is" },
        {
          body: "This one held twice.",
          drawings: [
            {
              id: "quant-turn9999-1",
              points: [{ timestamp: JAN_2, value: 5000 }],
              text: "Level",
              tool: "level",
            },
          ],
          title: "An example",
        },
        { body: "Nothing to draw.", title: "Recap" },
      ],
      topic: "Support levels",
    });
    return expect("text" in outcome ? outcome.text : "").toContain(
      '3-step walkthrough of "Support levels"'
    );
  });

  it("needs a symbol for step drawings, and none for a walkthrough without drawings", () => {
    const drawn = {
      steps: [
        {
          body: "b",
          drawings: [{ points: [{ price: 1, time: JAN_2 }], tool: "level" }],
          title: "t",
        },
      ],
      topic: "Topic",
    };
    expect(errorOf(runChartTool("teach_steps", drawn, contextFor()))).toMatch(
      /^steps\[0\]\.drawings: Name the chart symbol/
    );
    expect(
      artifactOf(
        runChartTool(
          "teach_steps",
          { ...drawn, symbol: "aapl" },
          contextFor("t", "ESZ6")
        )
      )
    ).toMatchObject({ symbol: "AAPL" });
    return expect(
      artifactOf(
        runChartTool(
          "teach_steps",
          { steps: [{ body: "b", title: "t" }], topic: "Topic" },
          contextFor()
        )
      )
    ).not.toHaveProperty("symbol");
  });

  it("refuses empty, oversize and badly drawn walkthroughs", () => {
    const step = { body: "b", title: "t" };
    const teach = (steps: unknown[]) =>
      errorOf(
        runChartTool("teach_steps", { steps, topic: "Topic" }, contextFor())
      );
    expect(teach([])).toMatch(/^Invalid arguments: steps/);
    expect(teach(new Array(13).fill(step))).toMatch(
      /^Invalid arguments: steps/
    );
    expect(
      teach([
        {
          ...step,
          drawings: new Array(5).fill({
            points: [{ price: 1, time: JAN_2 }],
            tool: "level",
          }),
        },
      ])
    ).toMatch(/^Invalid arguments: steps\.0\.drawings/);
    return expect(
      teach([
        step,
        {
          ...step,
          drawings: [{ points: [{ price: 1, time: JAN_2 }], tool: "trend" }],
        },
      ])
    ).toBe("steps[1].drawings[0]: a trend drawing needs 2 points, got 1");
  });
});

describe("jsonbTextBytes", () => {
  it("counts the bytes of Postgres's jsonb text form: UTF-8, ', ' and ': ' separators, plain numbers", () => {
    // 3-byte characters: a character count (6) or compact JSON (no spaces) would be too low.
    expect(jsonbTextBytes("€€")).toBe(8);
    expect(jsonbTextBytes({ a: "€", b: [1, true, null] })).toBe(
      '{"a": "€", "b": [1, true, null]}'.length + 2
    );
    expect(jsonbTextBytes({ a: undefined, b: false })).toBe(
      '{"b": false}'.length
    );
    expect(jsonbTextBytes([])).toBe(2);
    expect(jsonbTextBytes({})).toBe(2);
    // jsonb prints 1.5e-7 as 0.00000015.
    expect(jsonbTextBytes(1.5e-7)).toBeGreaterThanOrEqual("0.00000015".length);
    expect(jsonbTextBytes(-2e-10)).toBeGreaterThanOrEqual(
      "-0.0000000002".length
    );
    return expect(jsonbTextBytes(5000.25)).toBe(7);
  });
});

describe("cleaning model text", () => {
  it("removes control characters (line feed and tab stay) and lone surrogates, keeping emoji", () => {
    expect(
      cleanText("a\u0000b\u0007c\u007f\nd\te\r😀\uD83D\uDE00x\uD83D")
    ).toBe("abc\nd\te😀😀x");
    return expect(
      cleanStrings({ a: ["x\u0000", { b: "\uDE00y" }], n: 1, t: true })
    ).toEqual({ a: ["x", { b: "y" }], n: 1, t: true });
  });

  it("cleans every artifact string the chart tools build", () => {
    const draw = artifactOf(
      runChartTool(
        "chart_draw",
        {
          drawings: [
            {
              points: [{ price: 1, time: JAN_2 }],
              text: "Sup\u0000port \uD83D",
              tool: "text",
            },
          ],
          symbol: "ES",
        },
        contextFor()
      )
    );
    expect(draw).toMatchObject({ drawings: [{ text: "Support" }] });
    const teach = artifactOf(
      runChartTool(
        "teach_steps",
        {
          steps: [{ body: "One\n\ttwo\u0000\uDE00", title: "Ti\u0001tle" }],
          topic: "To\u0000pic\uD83D",
        },
        contextFor()
      )
    );
    expect(teach).toEqual({
      kind: "teach",
      steps: [{ body: "One\n\ttwo", title: "Title" }],
      topic: "Topic",
    });
    scripting.compileScript.mockReturnValue({
      inputs: [],
      kind: "indicator",
      ok: true,
      overlay: true,
      shortTitle: "S",
      title: "S",
    });
    const script = artifactOf(
      runChartTool(
        "chart_script",
        {
          source: '//@version=5\n\tindicator("S")\u0000\nplot(close)',
          title: "S\uD83D",
        },
        contextFor()
      )
    );
    expect(scripting.compileScript).toHaveBeenCalledWith(
      '//@version=5\n\tindicator("S")\nplot(close)'
    );
    return expect(script).toMatchObject({
      source: '//@version=5\n\tindicator("S")\nplot(close)',
      title: "S",
    });
  });
});

describe("storableTrace", () => {
  const entry = (artifact?: unknown) => ({
    args: "{}",
    durationMs: 1,
    error: null,
    ok: true,
    tool: "chart_script",
    ...(artifact === undefined ? {} : { artifact }),
  });
  // A 3-byte-character script: about 30 KB of jsonb text each.
  const bigScript = {
    kind: "chart_script",
    overlay: true,
    source: "€".repeat(10_000),
    title: "Big €",
  };

  it("keeps a small trace as is, with strings cleaned", () => {
    expect(
      storableTrace([entry(), { ...entry(), error: "x\u0000\uD83D" }])
    ).toEqual([entry(), { ...entry(), error: "x" }]);
    return expect(storableTrace([])).toEqual([]);
  });

  it("drops artifacts from the end, then entries, so the stored row passes the 64 KB check", () => {
    const trace = [
      entry(bigScript),
      entry(),
      entry(bigScript),
      entry(bigScript),
    ];
    expect(jsonbTextBytes(trace)).toBeGreaterThan(65_536);
    const fitted = storableTrace(trace);
    expect(jsonbTextBytes(fitted)).toBeLessThanOrEqual(60_000);
    expect(fitted).toHaveLength(4);
    expect(fitted.map((row) => "artifact" in row)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(fitted[3]?.error).toBe(ARTIFACT_NOT_STORED);
    expect(fitted[1]?.error).toBeNull();
    // Entries alone too big (long args): the last entries go.
    const wide = Array.from({ length: 64 }, () => ({
      ...entry(),
      args: "€".repeat(400),
    }));
    const kept = storableTrace(wide);
    expect(kept.length).toBeLessThan(64);
    expect(jsonbTextBytes(kept)).toBeLessThanOrEqual(60_000);
    // At most 64 entries.
    return expect(
      storableTrace(Array.from({ length: 70 }, () => entry()))
    ).toHaveLength(64);
  });
});
