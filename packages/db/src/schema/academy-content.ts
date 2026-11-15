// What: Academy course content stored in Postgres (AGENTS.md rule 13): the knowledge-base source of
// each lesson (reel URL, caption, publish date, duration, transcript segments) and the lesson spec
// that the page draws its interactive chart from. One row per source and one per lesson; a lesson
// names exactly one source of the same course (composite foreign key), and a source backs at most one
// lesson. Courses whose `store` is "database" (packages/academy/src/courses.ts) live here; Define Your
// Risk still ships its JSON specs in @darkfactory/academy until it moves.
// Writes: `bun run vertex:academy:import` (scripts/academy/import-lessons.ts) through the repository,
// which validates every spec with LessonSpecSchema. Reads: academy.lessons and academy.lesson (oRPC,
// operator-only). Research and education only: nothing here places, changes or cancels an order.
// Used by: packages/db/src/server/academy-content.ts. See: docs/vertex-academy.md#lesson-storage.
import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const utc = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

/** One transcript segment: start time in seconds and the spoken text. */
export type AcademyTranscriptSegment = Readonly<{
  start: number;
  text: string;
}>;

export const academyLessonSources = pgTable(
  "academy_lesson_sources",
  {
    sourceId: text("source_id").primaryKey(),
    course: text("course").notNull(),
    url: text("url").notNull(),
    caption: text("caption").notNull(),
    /** As the knowledge base records it: a date (YYYY-MM-DD) or a UTC timestamp. */
    publishedAt: text("published_at").notNull(),
    durationSeconds: doublePrecision("duration_seconds").notNull(),
    transcript: jsonb("transcript")
      .$type<readonly AcademyTranscriptSegment[]>()
      .notNull(),
    /** Source this one exactly duplicates (not counted as a separate video), or null. */
    duplicateOf: text("duplicate_of"),
    createdAt: utc("created_at").defaultNow().notNull(),
    updatedAt: utc("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Target of the lessons' composite foreign key: a lesson's course must be its source's course.
    unique("academy_lesson_sources_source_course_key").on(
      table.sourceId,
      table.course
    ),
    index("academy_lesson_sources_course_idx").on(table.course),
    check(
      "academy_lesson_sources_fields_check",
      sql`${table.sourceId} ~ '^[A-Za-z0-9_-]{5,20}$' and ${table.course} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${table.course}) <= 40 and ${table.url} ~ '^https://' and length(${table.url}) <= 500 and length(${table.caption}) <= 5000 and ${table.publishedAt} ~ '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z)?$' and ${table.durationSeconds} >= 0 and ${table.durationSeconds} <= 86400 and (${table.duplicateOf} is null or ${table.duplicateOf} <> ${table.sourceId})`
    ),
    check(
      "academy_lesson_sources_transcript_check",
      sql`jsonb_typeof(${table.transcript}) = 'array' and octet_length(${table.transcript}::text) <= 262144`
    ),
  ]
);

export const academyLessonSpecs = pgTable(
  "academy_lesson_specs",
  {
    slug: text("slug").primaryKey(),
    course: text("course").notNull(),
    sourceId: text("source_id").notNull(),
    /** The parsed LessonSpec (defaults applied), as LessonSpecSchema returns it. */
    spec: jsonb("spec").$type<Readonly<Record<string, unknown>>>().notNull(),
    /** sha256 (hex) of the spec's canonical JSON (keys sorted); an unchanged import skips the row. */
    specHash: text("spec_hash").notNull(),
    createdAt: utc("created_at").defaultNow().notNull(),
    updatedAt: utc("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("academy_lesson_specs_source_idx").on(table.sourceId),
    index("academy_lesson_specs_course_idx").on(table.course),
    foreignKey({
      name: "academy_lesson_specs_source_fk",
      columns: [table.sourceId, table.course],
      foreignColumns: [
        academyLessonSources.sourceId,
        academyLessonSources.course,
      ],
    }),
    check(
      "academy_lesson_specs_fields_check",
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${table.slug}) <= 60 and ${table.specHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "academy_lesson_specs_spec_check",
      sql`jsonb_typeof(${table.spec}) = 'object' and octet_length(${table.spec}::text) <= 131072 and coalesce(${table.spec} ->> 'slug', '') = ${table.slug} and coalesce(${table.spec} ->> 'sourceId', '') = ${table.sourceId} and coalesce(${table.spec} ->> 'course', '') = ${table.course}`
    ),
  ]
);
