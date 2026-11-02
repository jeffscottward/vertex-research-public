import {
  buildScene,
  defaultValues,
  elementColors,
  type Lesson,
  lessonTimeline,
} from "@darkfactory/academy";
import { DARK_PALETTE, LessonChart } from "@darkfactory/academy/chart";
import { lessonBySlug } from "@darkfactory/academy/lessons";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type * as Remotion from "remotion";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LessonVideoComposition } from "./lesson-composition.tsx";

const video = vi.hoisted(() => ({ frame: 0, fps: 30 }));

// Remotion's frame hooks need a running composition; the rest of the module is used as is.
vi.mock("remotion", async (importOriginal) => ({
  ...(await importOriginal<typeof Remotion>()),
  useCurrentFrame: () => video.frame,
  useVideoConfig: () => ({ fps: video.fps }),
}));

type Props = Readonly<{
  children?: ReactNode;
  style?: Readonly<Record<string, unknown>>;
}>;
type Node = ReactElement<Props>;

const STRATEGY = "covered-call-asymmetry-fixes";
const CONCEPT = "high-iv-needs-low-hv";

const lesson = (slug: string): Lesson => {
  const found = lessonBySlug(slug);
  if (found === null) throw new Error(`missing lesson ${slug}`);
  return found;
};

const render = (slug: string, seconds: number): Node => {
  video.frame = Math.round(seconds * video.fps);
  const node: Node = LessonVideoComposition({ slug });
  return node;
};

const children = (node: Node): Node[] =>
  Children.toArray(node.props.children).filter((child): child is Node =>
    isValidElement(child)
  );

const text = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<Props>(node)) return text(node.props.children);
  return "";
};

const layers = (slug: string, seconds: number) => {
  const [chart, ...rest] = children(render(slug, seconds));
  if (chart === undefined) throw new Error("missing chart");
  const outro = rest.at(-1);
  const intro = rest.at(-2);
  if (intro === undefined || outro === undefined)
    throw new Error("missing overlays");
  const badge = rest.length === 3 ? rest[0] : undefined;
  return { chart, badge, intro, outro };
};

beforeEach(() => {
  video.frame = 0;
  video.fps = 30;
});

describe("LessonVideoComposition", () => {
  it("shows a placeholder for an unknown lesson", () => {
    const node = render("missing-lesson", 0);
    expect(text(node)).toBe("Unknown lesson missing-lesson");
    expect(node.props.style).toEqual({
      background: DARK_PALETTE.background,
      color: DARK_PALETTE.text,
    });
  });

  it("opens with the strategy title card and no active step", () => {
    const value = lesson(STRATEGY);
    const { chart, badge, intro, outro } = layers(STRATEGY, 0);
    expect(chart.type).toBe(LessonChart);
    expect(chart.props).toEqual({
      azimuth: 0.25,
      colors: elementColors(value),
      fixed: true,
      height: 720,
      highlight: null,
      idPrefix: "video",
      palette: DARK_PALETTE,
      revealed: new Map([["axes", 1]]),
      scene: buildScene(value, defaultValues(value.params), 0, 0.25),
      title: value.title,
      width: 1280,
    });
    expect(badge).toBeUndefined();
    expect(intro.props.style?.["opacity"]).toBe(1);
    expect(text(intro)).toContain("DEFINE YOUR RISK ACADEMY · STRATEGY");
    expect(text(intro)).toContain(value.title);
    expect(text(intro)).toContain(
      [
        ...value.tags.regime,
        ...value.tags.instruments,
        value.tags.timeframe,
      ].join(" · ")
    );
    expect(outro.props.style?.["opacity"]).toBe(0);
  });

  it("labels the active step and fades in the takeaways", () => {
    const value = lesson(STRATEGY);
    const timeline = lessonTimeline(value);
    const [first] = timeline.steps;
    if (first === undefined) throw new Error("lesson without steps");
    expect(first.element).toBe("spot");
    const during = layers(STRATEGY, first.start + 0.5);
    expect(during.chart.props).toMatchObject({ highlight: "spot" });
    expect(during.intro.props.style?.["opacity"]).toBe(0);
    expect(text(during.badge)).toBe(
      `Step 1/${timeline.steps.length} · Spot price`
    );
    expect(during.badge?.props.style).toMatchObject({
      color: DARK_PALETTE.tokens[first.color],
    });

    const end = layers(STRATEGY, timeline.total);
    expect(end.outro.props.style?.["opacity"]).toBe(1);
    const takeaways = children(end.outro).slice(1, -1).map(text);
    expect(takeaways).toEqual(value.takeaways.map((item) => `• ${item}`));
  });

  it("falls back to the element id for concept lessons without a label", () => {
    const value = lesson(CONCEPT);
    const timeline = lessonTimeline(value);
    const [first] = timeline.steps;
    if (first === undefined) throw new Error("lesson without steps");
    expect(first.element).toBe("price");
    const { intro, badge } = layers(CONCEPT, first.start + 0.1);
    expect(text(intro)).toContain("DEFINE YOUR RISK ACADEMY · CONCEPT");
    expect(text(badge)).toBe(`Step 1/${timeline.steps.length} · price`);
  });
});
