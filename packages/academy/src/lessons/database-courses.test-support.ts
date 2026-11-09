// Test support: the lessons of the database courses (courses.ts `store: "database"`), built from the
// authored specs that `bun run vertex:academy:import` writes to Postgres (scripts/academy/lessons/<course>)
// and their synthetic fixture sources (the real captions and transcripts stay in the knowledge base).
// Tests only: the app reads these lessons through academy.lessons
// and academy.lesson, never from these files.

import { SOURCES as QUANTFINANCETOGO_SOURCES } from "../../../../scripts/academy/lessons/quantfinancetogo/sources.fixture.ts";
import { LESSON_SPECS as QUANTFINANCETOGO_SPECS } from "../../../../scripts/academy/lessons/quantfinancetogo/specs.generated.ts";
import type { Lesson } from "../schema.ts";
import { ACADEMY_LESSONS, buildCatalog, loadSources } from "./index.ts";

/** Every lesson of every database course, in catalog order. */
export const DATABASE_COURSE_LESSONS: readonly Lesson[] = buildCatalog(
  QUANTFINANCETOGO_SPECS,
  loadSources({ quantfinancetogo: QUANTFINANCETOGO_SOURCES })
);

/** Packaged and database lessons together: every lesson the Academy shows. */
export const ALL_ACADEMY_LESSONS: readonly Lesson[] = [
  ...ACADEMY_LESSONS,
  ...DATABASE_COURSE_LESSONS,
];
