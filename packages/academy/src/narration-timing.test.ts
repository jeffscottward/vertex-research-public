import { describe, expect, it } from "vitest";

import { COURSES, courseOf } from "./courses.ts";
import { ALL_ACADEMY_LESSONS as ACADEMY_LESSONS } from "./lessons/database-courses.test-support.ts";
import narration from "./lessons/narration-timing.json" with { type: "json" };
import {
  INTRO_SECONDS,
  lessonTimeline,
  lessonVtt,
  narrationTimingFor,
  parseLessonVtt,
} from "./timeline.ts";

// Only narrated courses (courses.ts) record narration; the others play the live animation.
const NARRATED = ACADEMY_LESSONS.filter((lesson) => courseOf(lesson).narrated);

describe("narration timing", () => {
  it("covers every lesson of a narrated course with one duration per step", () => {
    expect(NARRATED.length).toBeGreaterThan(0);
    for (const lesson of NARRATED) {
      expect(narrationTimingFor(lesson), lesson.slug).not.toBeNull();
    }
    expect(Object.keys(narration).sort()).toEqual(
      NARRATED.map((lesson) => lesson.slug).sort()
    );
  });

  it("needs no narration for a lesson of a course that is not narrated", () => {
    expect(COURSES.quantfinancetogo.narrated).toBe(false);
    const unnarrated = ACADEMY_LESSONS.filter(
      (lesson) => !courseOf(lesson).narrated
    );
    for (const lesson of unnarrated)
      expect(Object.keys(narration)).not.toContain(lesson.slug);
    // A lesson without narration still gets a full timeline from its spec seconds.
    const steps = [
      { seconds: 4, caption: "c", element: "axes" },
      { seconds: 5, caption: "d", element: "price" },
    ] as never;
    const timeline = lessonTimeline({ slug: "qftg-only-lesson", steps });
    expect(narrationTimingFor({ slug: "qftg-only-lesson", steps })).toBeNull();
    expect(timeline.steps.at(-1)?.end).toBe(INTRO_SECONDS + 9);
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
