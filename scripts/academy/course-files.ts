// What: Build-time file locations per Academy course (scripts only; the app never names these files).
// Package courses (Define Your Risk) keep their JSON sources file and spec index in
// packages/academy/src/lessons until they move to Postgres (AGENTS.md rule 13). Database courses
// (courses.ts `store: "database"`) keep their authored specs and generated spec index under
// scripts/academy/lessons/<course>; their sources stay in the knowledge base (never committed), read by
// `bun run vertex:academy:import`, with a synthetic stand-in (sources.fixture.ts) for checks and tests.
import { dirname } from "node:path";

import { COURSES, type CourseId } from "../../packages/academy/src/courses.ts";

export type SourcesOutput = Readonly<{
  /** Repository-relative path of the course's sources file. */
  path: string;
  format: "json" | "ts";
}>;

const DYR_SOURCES: SourcesOutput = {
  format: "json",
  path: "packages/academy/src/lessons/sources.json",
};

/** The committed sources file build-sources.ts writes, package courses only. */
export const SOURCES_OUTPUT: Readonly<
  Partial<Record<CourseId, SourcesOutput>>
> = { dyr: DYR_SOURCES };

/**
 * The sources file of each course that build-lesson-index.ts checks spec sourceIds against: the real one
 * of a package course, the synthetic fixture (ids, URLs, dates; no text) of a database course.
 */
export const SOURCE_ID_FILES: Readonly<Record<CourseId, SourcesOutput>> = {
  dyr: DYR_SOURCES,
  quantfinancetogo: {
    format: "ts",
    path: "scripts/academy/lessons/quantfinancetogo/sources.fixture.ts",
  },
};

/** Repository-relative path of a course's generated spec index (beside its specs folder). */
export const specIndexPath = (course: CourseId): string =>
  `${dirname(COURSES[course].specDir)}/specs.generated.ts`;
