import { describe, expect, it } from "vitest";

import { runChartTool } from "./assistant-chart-tools.ts";

// chart_script against the real @darkfactory/scripting engine (the other chart tool tests fix the
// compile result).
const context = { nextDrawingNumber: () => 1, turnId: "engine01" };

describe("chart_script with the real script engine", () => {
  it("accepts a valid indicator and lists line:column errors for a broken one", () => {
    const source = [
      "//@version=5",
      'indicator("EMA 20", overlay=true)',
      'len = input.int(20, "Length")',
      'plot(ta.ema(close, len), "EMA")',
    ].join("\n");
    expect(
      runChartTool("chart_script", { source, title: "EMA 20" }, context)
    ).toEqual({
      artifact: {
        kind: "chart_script",
        overlay: true,
        source,
        title: "EMA 20",
      },
      text: expect.stringContaining('Compiled "EMA 20" (indicator'),
    });
    const broken = runChartTool(
      "chart_script",
      {
        source:
          '//@version=5\nindicator("Broken")\nplot(ta.nosuchfunction(close))',
        title: "Broken",
      },
      context
    );
    expect(broken).not.toHaveProperty("artifact");
    return expect("error" in broken ? broken.error : "").toMatch(
      /^The script did not compile \(\d+ errors?\)\. Fix them and call chart_script again:\n- line 3:\d+ /u
    );
  });
});
