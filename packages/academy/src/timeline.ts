// What: One timeline for the video and the captions. The Remotion composition and the WebVTT file
// both read lessonTimeline, so caption cues always match what the video draws.
// Narrated lessons (owner choice 2026-10-30: retime video to speech) take their intro and step
// durations from lessons/narration-timing.json (spoken length of each cue + a short pause), so the
// video, captions, web player and narration track share one clock.
import narrationTiming from "./lessons/narration-timing.json" with {
  type: "json",
};
import type { ColorToken, LessonSpec } from "./schema.ts";

export type NarrationTiming = Readonly<{
  intro: number;
  steps: readonly number[];
}>;

const NARRATION: Readonly<Record<string, NarrationTiming>> = narrationTiming;

/** Narration durations for a lesson, or null when none exist or the step count no longer matches. */
export const narrationTimingFor = (
  lesson: Readonly<{ slug?: string; steps: readonly unknown[] }>
): NarrationTiming | null => {
  const timing = lesson.slug === undefined ? undefined : NARRATION[lesson.slug];
  return timing !== undefined && timing.steps.length === lesson.steps.length
    ? timing
    : null;
};

export const VIDEO_FPS = 30;
export const INTRO_SECONDS = 2.5;
export const OUTRO_SECONDS = 3;

export type TimelineStep = Readonly<{
  index: number;
  start: number;
  end: number;
  caption: string;
  element: string;
  color: ColorToken;
  /** Time-fraction range animated during the step, or a constant. */
  time: readonly [number, number];
}>;

export type LessonTimeline = Readonly<{
  fps: number;
  intro: number;
  outro: number;
  total: number;
  steps: readonly TimelineStep[];
}>;

export const lessonTimeline = (
  lesson: Pick<LessonSpec, "steps"> & Readonly<{ slug?: string }>
): LessonTimeline => {
  // First revealing step wins (same rule as elementColors in scenes.ts).
  const colors = new Map<string, ColorToken>();
  const narration = narrationTimingFor(lesson);
  const intro = narration?.intro ?? INTRO_SECONDS;
  let cursor = intro;
  let lastTime = 0;
  const steps = lesson.steps.map((step, index) => {
    const start = cursor;
    cursor += narration?.steps[index] ?? step.seconds;
    const time = step.time ?? ([lastTime, lastTime] as const);
    lastTime = time[1];
    const color = colors.get(step.element) ?? step.color;
    colors.set(step.element, color);
    return {
      index,
      start,
      end: cursor,
      caption: step.caption,
      element: step.element,
      color,
      time,
    };
  });
  return {
    fps: VIDEO_FPS,
    intro,
    outro: OUTRO_SECONDS,
    total: cursor + OUTRO_SECONDS,
    steps,
  };
};

/** Lesson state at a video time in seconds: revealed elements, active step, progress and time fraction. */
export const stateAt = (timeline: LessonTimeline, seconds: number) => {
  const revealed = new Map<string, number>();
  let active: TimelineStep | null = null;
  let t = 0;
  for (const step of timeline.steps) {
    if (seconds < step.start) break;
    const progress = Math.min(
      (seconds - step.start) / Math.max(step.end - step.start, 0.001),
      1
    );
    // Elements draw in during the first 60% of their first step.
    const draw = Math.min(progress / 0.6, 1);
    revealed.set(step.element, Math.max(revealed.get(step.element) ?? 0, draw));
    active = step;
    const eased =
      progress < 0.5
        ? 2 * progress * progress
        : 1 - (-2 * progress + 2) ** 2 / 2;
    t = step.time[0] + (step.time[1] - step.time[0]) * eased;
  }
  revealed.set("axes", 1);
  return { revealed, active, t };
};

const stamp = (seconds: number): string => {
  const total = Math.max(seconds, 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total - hours * 3600 - minutes * 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
};

const escapeCue = (text: string): string =>
  text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/**
 * WebVTT captions. Each cue wraps its text in a class span <c.dyr-COLOR.el-ELEMENT> so the page can
 * color the caption with the same token as the drawn element and highlight that element.
 */
export const lessonVtt = (
  lesson: Pick<LessonSpec, "steps" | "title"> & Readonly<{ slug?: string }>
): string => {
  const timeline = lessonTimeline(lesson);
  const cues = [
    `intro\n${stamp(0)} --> ${stamp(timeline.intro)}\n<c.dyr-gold.el-title>${escapeCue(lesson.title)}</c>`,
    ...timeline.steps.map(
      (step) =>
        `step-${step.index + 1}\n${stamp(step.start)} --> ${stamp(step.end)}\n<c.dyr-${step.color}.el-${step.element}>${escapeCue(step.caption)}</c>`
    ),
  ];
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
};

export type ParsedCue = Readonly<{
  id: string;
  start: number;
  end: number;
  color: string;
  element: string;
  text: string;
}>;

const parseStamp = (value: string): number => {
  const [h, m, s] = value.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

/** Parse the cues written by lessonVtt (used by the page and the tests). */
export const parseLessonVtt = (vtt: string): ParsedCue[] =>
  vtt
    .split(/\n\n+/u)
    .slice(1)
    .map((block) => block.split("\n"))
    .filter((lines) => lines.length >= 3)
    .map((lines) => {
      const [id = "", range = "", ...text] = lines;
      const [from = "0", to = "0"] = range.split(" --> ");
      const body = text.join(" ").trim();
      const match = /^<c\.dyr-([a-z]+)\.el-([a-zA-Z0-9]+)>(.*)<\/c>$/u.exec(
        body
      );
      return {
        id,
        start: parseStamp(from),
        end: parseStamp(to),
        color: match?.[1] ?? "gray",
        element: match?.[2] ?? "",
        text: (match?.[3] ?? body)
          .replace(/&lt;/gu, "<")
          .replace(/&gt;/gu, ">")
          .replace(/&amp;/gu, "&"),
      };
    });
