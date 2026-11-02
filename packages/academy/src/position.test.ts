import { describe, expect, it } from "vitest";

import { num, resolveLegs } from "./position.ts";
import { lessonTimeline, parseLessonVtt } from "./timeline.ts";

describe("num", () => {
  it("parses numeric strings and falls back otherwise", () => {
    expect(num({ a: "12.5" }, "a", 1)).toBe(12.5);
    expect(num({ a: "abc" }, "a", 7)).toBe(7);
    expect(num({}, "a", 3)).toBe(3);
    expect(num({ a: 4 }, "a", 3)).toBe(4);
  });
});

describe("resolveLegs", () => {
  it("defaults missing strike and dte to spot and 30 days", () => {
    const [leg] = resolveLegs([{ kind: "call", side: "long", qty: 1 }], {
      spot: 120,
    });
    expect(leg?.strike).toBe(120);
    expect(leg?.dte).toBe(30);
  });
});

describe("timeline colors and plain cues", () => {
  it("keeps the first color for a repeated element", () => {
    const step = { seconds: 2, caption: "c", element: "price" };
    const timeline = lessonTimeline({
      steps: [
        { ...step, color: "blue" },
        { ...step, color: "red" },
      ],
    } as never);
    expect(timeline.steps.map((s) => s.color)).toEqual(["blue", "blue"]);
  });

  it("parses cues without a class span", () => {
    const [cue] = parseLessonVtt(
      "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nplain &lt;text&gt; &amp; more"
    );
    expect(cue).toMatchObject({
      id: "1",
      color: "gray",
      element: "",
      text: "plain <text> & more",
    });
  });
});
