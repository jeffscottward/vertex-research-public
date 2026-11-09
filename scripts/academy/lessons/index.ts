// What: Authored lesson specs of each database course (courses.ts `store: "database"`): specs/<slug>.ts,
// indexed by build-lesson-index.ts into specs.generated.ts. Their sources (captions and transcripts)
// are not in this repository (owner decision 2026-11-08): `bun run vertex:academy:import` reads them
// from the knowledge base. Tests, CI and the E2E seed use synthetic stand-ins (sources.fixture.ts).
// Tool input only; the app reads these lessons from Postgres through academy.lessons and academy.lesson
// (AGENTS.md rule 13).
import type { CourseId } from "../../../packages/academy/src/courses.ts";
import { SOURCES as QUANTFINANCETOGO_FIXTURE_SOURCES } from "./quantfinancetogo/sources.fixture.ts";
import { LESSON_SPECS as QUANTFINANCETOGO_SPECS } from "./quantfinancetogo/specs.generated.ts";

export type CourseContent = Readonly<{
  /** Lesson specs as authored (LessonSpecSchema input). */
  specs: readonly unknown[];
  /** Knowledge-base sources (LessonSourceSchema). */
  sources: readonly unknown[];
}>;

/** The committed lesson specs of every database course. */
export const DATABASE_COURSE_SPECS: Readonly<
  Partial<Record<CourseId, readonly unknown[]>>
> = {
  quantfinancetogo: QUANTFINANCETOGO_SPECS,
};

/**
 * The committed specs with synthetic sources (no caption or transcript text): import input for tests,
 * CI and the E2E seed, which have no knowledge base.
 */
export const DATABASE_COURSE_FIXTURE_CONTENT: Readonly<
  Partial<Record<CourseId, CourseContent>>
> = {
  quantfinancetogo: {
    sources: QUANTFINANCETOGO_FIXTURE_SOURCES,
    specs: QUANTFINANCETOGO_SPECS,
  },
};
