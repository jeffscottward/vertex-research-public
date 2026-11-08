// What: Authored import input of each database course (courses.ts `store: "database"`): its lesson
// specs (specs/<slug>.ts, indexed by build-lesson-index.ts into specs.generated.ts) and its knowledge-base
// sources snapshot (sources.generated.ts, written by build-sources.ts). Tool input only, read by
// `bun run vertex:academy:import` (import-lessons.ts) and by tests; the app reads these lessons from
// Postgres through academy.lessons and academy.lesson (AGENTS.md rule 13).
import type { CourseId } from "../../../packages/academy/src/courses.ts";
import { SOURCES as QUANTFINANCETOGO_SOURCES } from "./quantfinancetogo/sources.generated.ts";
import { LESSON_SPECS as QUANTFINANCETOGO_SPECS } from "./quantfinancetogo/specs.generated.ts";

export type CourseContent = Readonly<{
  /** Lesson specs as authored (LessonSpecSchema input). */
  specs: readonly unknown[];
  /** Knowledge-base sources (LessonSourceSchema). */
  sources: readonly unknown[];
}>;

export const DATABASE_COURSE_CONTENT: Readonly<
  Partial<Record<CourseId, CourseContent>>
> = {
  quantfinancetogo: {
    sources: QUANTFINANCETOGO_SOURCES,
    specs: QUANTFINANCETOGO_SPECS,
  },
};
