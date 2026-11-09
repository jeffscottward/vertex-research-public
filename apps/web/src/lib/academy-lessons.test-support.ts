// Test support: stand-ins for the Academy page loaders (academy-lessons.ts) that answer every course
// from memory, the database courses from their authored import input, so route tests need neither
// Postgres nor the in-process oRPC dispatch. Tests only.
import type { CourseId } from "@darkfactory/academy/courses";
import {
  neighboursIn,
  sourceCounts,
  toLessonSummary,
} from "@darkfactory/academy/lessons";

import { ALL_ACADEMY_LESSONS } from "../../../../packages/academy/src/lessons/database-courses.test-support.ts";
import { SOURCES as QUANTFINANCETOGO_SOURCES } from "../../../../scripts/academy/lessons/quantfinancetogo/sources.generated.ts";
import type {
  AcademyCourseLessons,
  AcademyLessonPage,
} from "./academy-lessons.ts";

const QUANTFINANCETOGO_VIDEOS = (
  QUANTFINANCETOGO_SOURCES as readonly Readonly<{ duplicateOf?: string }>[]
).filter((source) => source.duplicateOf === undefined).length;

export const loadCourseLessons = async (
  course: CourseId
): Promise<AcademyCourseLessons> => ({
  lessons: ALL_ACADEMY_LESSONS.filter((lesson) => lesson.course === course).map(
    toLessonSummary
  ),
  sourceCount:
    course === "quantfinancetogo"
      ? QUANTFINANCETOGO_VIDEOS
      : sourceCounts()[course],
});

export const loadCourseListing = async (course: CourseId) => ({
  course,
  ...(await loadCourseLessons(course)),
});

export const loadLesson = async (
  slug: string
): Promise<AcademyLessonPage | null> => {
  const lesson = ALL_ACADEMY_LESSONS.find((entry) => entry.slug === slug);
  return lesson === undefined
    ? null
    : { lesson, ...neighboursIn(ALL_ACADEMY_LESSONS, slug) };
};
