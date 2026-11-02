import { describe, expect, it } from "vitest";

import { ACADEMY_LESSONS } from "./lessons/index.ts";
import narration from "./lessons/narration-timing.json" with { type: "json" };
import {
  INTRO_SECONDS,
  lessonTimeline,
  lessonVtt,
  narrationTimingFor,
  parseLessonVtt,
} from "./timeline.ts";

describe("narration timing", () => {
  it("covers every lesson with one duration per step", () => {
    for (const lesson of ACADEMY_LESSONS) {
      expect(narrationTimingFor(lesson), lesson.slug).not.toBeNull();
    }
    expect(Object.keys(narration).sort()).toEqual(
      ACADEMY_LESSONS.map((lesson) => lesson.slug).sort()
    );
  });

  it("drives the timeline and captions from the narration durations", () => {
    const lesson = ACADEMY_LESSONS[0];
    if (lesson === undefined) throw new Error("no lessons");
    const timing = narrationTimingFor(lesson);
    if (timing === null) throw new Error("no timing");
    const timeline = lessonTimeline(lesson);
    expect(timeline.intro).toBe(timing.intro);
    expect(timeline.steps.map((step) => step.end - step.start)).toEqual(
      timing.steps.map((seconds) => expect.closeTo(seconds, 6))
    );
    const cues = parseLessonVtt(lessonVtt(lesson));
    expect(cues.at(-1)?.end).toBeCloseTo(timeline.total - timeline.outro, 2);
  });

  it("falls back to spec seconds without a slug or when step counts differ", () => {
    const steps = [{ seconds: 3, caption: "c", element: "price" }] as never;
    expect(lessonTimeline({ steps }).intro).toBe(INTRO_SECONDS);
    const lesson = ACADEMY_LESSONS[0];
    if (lesson === undefined) throw new Error("no lessons");
    expect(narrationTimingFor({ slug: lesson.slug, steps: [] })).toBeNull();
    expect(lessonTimeline({ slug: lesson.slug, steps }).steps[0]?.end).toBe(
      INTRO_SECONDS + 3
    );
  });
});
