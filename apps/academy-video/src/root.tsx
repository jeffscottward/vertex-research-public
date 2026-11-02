import { lessonTimeline } from "@darkfactory/academy";
import { lessonBySlug } from "@darkfactory/academy/lessons";
import { type CalculateMetadataFunction, Composition } from "remotion";

import {
  LessonVideoComposition,
  type LessonVideoProps,
} from "./lesson-composition.tsx";

const FPS = 30;

const calculateMetadata: CalculateMetadataFunction<LessonVideoProps> = ({
  props,
}) => {
  const lesson = lessonBySlug(props.slug);
  const seconds = lesson === null ? 3 : lessonTimeline(lesson).total;
  return { durationInFrames: Math.ceil(seconds * FPS), props };
};

export const RemotionRoot = () => (
  <Composition
    calculateMetadata={calculateMetadata}
    component={LessonVideoComposition}
    defaultProps={{ slug: "itm-debit-call-spread" }}
    durationInFrames={FPS * 30}
    fps={FPS}
    height={720}
    id="AcademyLesson"
    width={1280}
  />
);
