import { describe, expect, it } from "vitest";
import {
  type Drawing,
  describeDrawing,
  drawingsStorageKey,
  drawingToolLabel,
  isChartType,
  isDrawingTool,
  parseDrawings,
  screenshotFileName,
  upsertDrawing,
  validDrawing,
} from "./workstation.ts";

const trend: Drawing = {
  id: "d1",
  points: [
    { timestamp: 1000, value: 10 },
    { timestamp: 2000, value: 12 },
  ],
  text: "",
  tool: "trend",
};

describe("chart workstation model", () => {
  it("recognizes chart types and drawing tools", () => {
    expect(isChartType("heikin-ashi")).toBe(true);
    expect(isChartType("renko")).toBe(false);
    expect(isDrawingTool("fib")).toBe(true);
    expect(isDrawingTool("brush")).toBe(false);
    expect(drawingToolLabel("level")).toBe("Horizontal level");
    return expect(drawingToolLabel("x" as never)).toBe("x");
  });
  it("validates drawings", () => {
    expect(validDrawing(trend)).toBe(true);
    expect(validDrawing(null)).toBe(false);
    expect(validDrawing({ ...trend, tool: "brush" })).toBe(false);
    expect(validDrawing({ ...trend, id: "" })).toBe(false);
    expect(validDrawing({ ...trend, text: "x".repeat(81) })).toBe(false);
    expect(validDrawing({ ...trend, points: [trend.points[0]] })).toBe(false);
    expect(validDrawing({ ...trend, points: [null, null] })).toBe(false);
    expect(
      validDrawing({
        ...trend,
        points: [{ timestamp: 1.5, value: 1 }, trend.points[1]],
      })
    ).toBe(false);
    return expect(
      validDrawing({
        ...trend,
        points: [{ timestamp: 1, value: Number.NaN }, trend.points[1]],
      })
    ).toBe(false);
  });
  it("parses stored drawings defensively", () => {
    expect(parseDrawings(null)).toEqual([]);
    expect(parseDrawings("{")).toEqual([]);
    expect(parseDrawings("{}")).toEqual([]);
    expect(parseDrawings(JSON.stringify([trend, { bad: true }]))).toEqual([
      trend,
    ]);
    return expect(drawingsStorageKey(" spy ")).toBe("vx.charts.drawings.SPY");
  });
  it("upserts drawings by id", () => {
    const added = upsertDrawing([], trend);
    expect(added).toEqual([trend]);
    const moved: Drawing = {
      ...trend,
      points: [
        { timestamp: 1000, value: 10 },
        { timestamp: 3000, value: 14 },
      ],
    };
    expect(upsertDrawing([trend, { ...trend, id: "d2" }], moved)[0]).toEqual(
      moved
    );
    return expect(upsertDrawing(added, { ...trend, id: "" })).toBe(added);
  });
  it("describes drawings for the object tree", () => {
    expect(describeDrawing(trend, 2)).toBe("Trend line 10.00 → 12.00");
    return expect(
      describeDrawing(
        {
          id: "t",
          points: [{ timestamp: 1, value: 5 }],
          text: "hi",
          tool: "text",
        },
        1
      )
    ).toBe("Text note 5.0 “hi”");
  });
  it("names screenshots safely", () => {
    const at = new Date("2026-11-04T10:00:00.000Z");
    expect(screenshotFileName("SPY 1 day bars", at)).toBe(
      "vertex-SPY-1-day-bars-2026-11-04T10-00-00-000Z.png"
    );
    return expect(screenshotFileName("!!!", at)).toBe(
      "vertex-chart-2026-11-04T10-00-00-000Z.png"
    );
  });
});
