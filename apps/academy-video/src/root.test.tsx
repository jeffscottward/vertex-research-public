import { lessonTimeline } from "@darkfactory/academy";
import { lessonBySlug } from "@darkfactory/academy/lessons";
import type { CalculateMetadataFunction } from "remotion";
import { describe, expect, it } from "vitest";

import {
  LessonVideoComposition,
  type LessonVideoProps,
} from "./lesson-composition.tsx";
import { RemotionRoot } from "./root.tsx";

type RootProps = Readonly<{
  calculateMetadata: CalculateMetadataFunction<LessonVideoProps>;
  component: unknown;
  defaultProps: LessonVideoProps;
  durationInFrames: number;
  fps: number;
  height: number;
  id: string;
  width: number;
}>;

// RemotionRoot returns its <Composition> element; JSX element props are untyped.
const rootProps = (): RootProps => RemotionRoot().props;

const metadata = (slug: string) =>
  rootProps().calculateMetadata({
    props: { slug },
    defaultProps: { slug },
    abortSignal: new AbortController().signal,
    compositionId: "AcademyLesson",
    isRendering: true,
  });

describe("RemotionRoot", () => {
  it("registers one 720p lesson composition", () => {
    const { calculateMetadata: _metadata, ...props } = rootProps();
    expect(props).toEqual({
      component: LessonVideoComposition,
      defaultProps: { slug: "itm-debit-call-spread" },
      durationInFrames: 900,
      fps: 30,
      height: 720,
      id: "AcademyLesson",
      width: 1280,
    });
  });

  it("sizes the composition from the lesson timeline", async () => {
    const lesson = lessonBySlug("itm-debit-call-spread");
    if (lesson === null) throw new Error("missing default lesson");
    expect(await metadata(lesson.slug)).toEqual({
      durationInFrames: Math.ceil(lessonTimeline(lesson).total * 30),
      props: { slug: lesson.slug },
    });
  });

  it("gives unknown lessons a three second placeholder", async () => {
    expect(await metadata("missing-lesson")).toEqual({
      durationInFrames: 90,
      props: { slug: "missing-lesson" },
    });
  });
});
