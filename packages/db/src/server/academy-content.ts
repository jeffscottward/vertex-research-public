// What: Drizzle repository for Academy course content (academy_lesson_sources, academy_lesson_specs).
// Reads serve academy.lessons and academy.lesson (packages/api/src/server/academy-content.ts); the one
// write, importCourse, serves `bun run vertex:academy:import` (scripts/academy/import-lessons.ts).
// Every source is validated with LessonSourceSchema and every spec with LessonSpecSchema before the
// transaction opens, so no writer can store a spec the lesson page cannot draw from. The stored spec
// is the parsed one (defaults applied) and its spec_hash is the sha256 of its canonical JSON.
// See: packages/db/migrations/0058_academy_content.sql; docs/vertex-academy.md#lesson-storage.
// Research and education only: nothing here places, changes or cancels an order.
import {
  LessonSourceSchema,
  type LessonSpec,
  LessonSpecSchema,
} from "@darkfactory/academy/schema";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";

import {
  type AcademyTranscriptSegment,
  academyLessonSources,
  academyLessonSpecs,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  DatabasePersistenceError,
  databaseErrorDetails,
  InvalidRepositoryInputError,
} from "./repository-errors.ts";

export type AcademyLessonSourceRecord = Readonly<{
  course: string;
  sourceId: string;
  url: string;
  caption: string;
  publishedAt: string;
  durationSeconds: number;
  transcript: readonly AcademyTranscriptSegment[];
  duplicateOf: string | null;
  updatedAt: Date;
}>;

export type AcademyLessonSpecRecord = Readonly<{
  course: string;
  slug: string;
  sourceId: string;
  /** The stored spec; readers validate it again with LessonSpecSchema. */
  spec: Readonly<Record<string, unknown>>;
  specHash: string;
  updatedAt: Date;
}>;

/** A lesson in a course listing: its spec and its source's publish date. */
export type AcademyLessonListEntry = AcademyLessonSpecRecord &
  Readonly<{ publishedAt: string }>;

/** One lesson with its whole source (transcript included). */
export type AcademyLessonRecord = AcademyLessonSpecRecord &
  Readonly<{ source: AcademyLessonSourceRecord }>;

export type AcademyCourseImportInput = Readonly<{
  course: string;
  /** Every source of the course (LessonSourceSchema; `course` must be this course). */
  sources: readonly unknown[];
  /** Every lesson spec of the course (LessonSpecSchema; `course` must be this course). */
  specs: readonly unknown[];
  /** Also delete the course's stored specs and sources that the input no longer lists. */
  prune?: boolean;
}>;

export type AcademyImportCounts = Readonly<{
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
}>;

export type AcademyCourseImportResult = Readonly<{
  course: string;
  sources: AcademyImportCounts;
  specs: AcademyImportCounts;
}>;

export type AcademyContentRepository = Readonly<{
  /** Lessons of one course, newest source first (then by slug). */
  listLessons: (course: string) => Promise<AcademyLessonListEntry[]>;
  /** One lesson with its source, or null when no lesson has this slug. */
  getLesson: (slug: string) => Promise<AcademyLessonRecord | null>;
  /** Knowledge-base videos of one course, not counting recorded exact duplicates. */
  countSources: (course: string) => Promise<number>;
  /**
   * Validates, then upserts every source and spec of one course in one transaction (an unchanged row
   * is left alone); with `prune`, deletes the course's rows the input does not list. When any write
   * fails, nothing is stored.
   */
  importCourse: (
    input: AcademyCourseImportInput
  ) => Promise<AcademyCourseImportResult>;
}>;

// check_violation, unique_violation, foreign_key_violation: the input is wrong, not the database.
const INPUT_ERRORS: Readonly<Record<string, true>> = {
  "23503": true,
  "23505": true,
  "23514": true,
};
const MAX_LISTED_ISSUES = 5;
// The academy.lessons contract caps a course listing at 500 (ACADEMY_LESSONS_MAX in @darkfactory/api).
// One extra row tells a full course from an overflowing one, which is a storage failure, not a list.
const MAX_LISTED_LESSONS = 500;

const mapError = (operation: string, error: unknown): never => {
  if (
    error instanceof InvalidRepositoryInputError ||
    error instanceof DatabasePersistenceError
  )
    throw error;
  const details = databaseErrorDetails(error);
  if (typeof details.code === "string" && INPUT_ERRORS[details.code] === true) {
    throw new InvalidRepositoryInputError(
      `academy content fails ${typeof details.constraint === "string" ? details.constraint : "a constraint"}`
    );
  }
  if (typeof details.code === "string") {
    throw new DatabasePersistenceError(operation);
  }
  throw error;
};

/** JSON with object keys sorted at every depth, so equal specs hash equally. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/** sha256 (lowercase hex) of the spec's canonical JSON. */
export const academyLessonSpecHash = async (spec: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(spec))
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

type SourceRow = typeof academyLessonSources.$inferInsert;
type SpecRow = typeof academyLessonSpecs.$inferInsert;

/** A validated course import: the rows importCourse writes. */
export type ValidatedAcademyImport = Readonly<{
  sources: readonly SourceRow[];
  specs: readonly SpecRow[];
}>;

const issuesOf = (
  where: string,
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
): string =>
  `${where}: ${issues
    .slice(0, 3)
    .map(
      (issue) =>
        `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`
    )
    .join("; ")}`;

/**
 * Parses a whole course import (no database access) or throws one InvalidRepositoryInputError naming
 * the first problems. importCourse runs it first; the import CLI's --dry-run runs it alone.
 */
export const parseAcademyCourseImport = async ({
  course,
  sources,
  specs,
}: AcademyCourseImportInput): Promise<ValidatedAcademyImport> => {
  const problems: string[] = [];
  const sourceRows: SourceRow[] = [];
  const sourceIds = new Set<string>();
  for (const [index, raw] of sources.entries()) {
    const parsed = LessonSourceSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(issuesOf(`source ${index}`, parsed.error.issues));
      continue;
    }
    const source = parsed.data;
    if (source.course !== course)
      problems.push(`source ${source.sourceId} is in course ${source.course}`);
    if (sourceIds.has(source.sourceId))
      problems.push(`source ${source.sourceId} is listed twice`);
    sourceIds.add(source.sourceId);
    sourceRows.push({
      caption: source.caption,
      course: source.course,
      duplicateOf: source.duplicateOf ?? null,
      durationSeconds: source.durationSeconds,
      publishedAt: source.publishedAt,
      sourceId: source.sourceId,
      transcript: source.transcript,
      url: source.url,
    });
  }
  const specRows: SpecRow[] = [];
  const slugs = new Set<string>();
  const usedSources = new Map<string, string>();
  for (const [index, raw] of specs.entries()) {
    const parsed = LessonSpecSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(issuesOf(`spec ${index}`, parsed.error.issues));
      continue;
    }
    const spec: LessonSpec = parsed.data;
    if (spec.course !== course)
      problems.push(`lesson ${spec.slug} is in course ${spec.course}`);
    if (slugs.has(spec.slug))
      problems.push(`lesson slug ${spec.slug} is used twice`);
    slugs.add(spec.slug);
    const other = usedSources.get(spec.sourceId);
    if (other !== undefined)
      problems.push(
        `lesson ${spec.slug} uses source ${spec.sourceId}, already used by ${other}`
      );
    usedSources.set(spec.sourceId, spec.slug);
    if (!sourceIds.has(spec.sourceId))
      problems.push(
        `lesson ${spec.slug} names source ${spec.sourceId}, which the import does not list`
      );
    specRows.push({
      course: spec.course,
      slug: spec.slug,
      sourceId: spec.sourceId,
      spec: spec as unknown as Readonly<Record<string, unknown>>,
      specHash: await academyLessonSpecHash(spec),
    });
  }
  if (problems.length > 0)
    throw new InvalidRepositoryInputError(
      `academy ${course} import is invalid (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n${problems
        .slice(0, MAX_LISTED_ISSUES)
        .join("\n")}`
    );
  return { sources: sourceRows, specs: specRows };
};

type WrittenRow = Readonly<{ createdAt: Date; updatedAt: Date }>;

/** created/updated from the returned rows (insert sets both timestamps to the same now()). */
const countWrites = (
  rows: readonly WrittenRow[],
  total: number,
  deleted: number
): AcademyImportCounts => {
  const created = rows.filter(
    (row) => row.createdAt.getTime() === row.updatedAt.getTime()
  ).length;
  return {
    created,
    deleted,
    unchanged: total - rows.length,
    updated: rows.length - created,
  };
};

const sourceColumns = {
  caption: academyLessonSources.caption,
  course: academyLessonSources.course,
  duplicateOf: academyLessonSources.duplicateOf,
  durationSeconds: academyLessonSources.durationSeconds,
  publishedAt: academyLessonSources.publishedAt,
  sourceId: academyLessonSources.sourceId,
  transcript: academyLessonSources.transcript,
  updatedAt: academyLessonSources.updatedAt,
  url: academyLessonSources.url,
};

const specColumns = {
  course: academyLessonSpecs.course,
  slug: academyLessonSpecs.slug,
  sourceId: academyLessonSpecs.sourceId,
  spec: academyLessonSpecs.spec,
  specHash: academyLessonSpecs.specHash,
  updatedAt: academyLessonSpecs.updatedAt,
};

/**
 * Refuses an import that would move another course's rows: a source id or lesson slug is unique
 * across courses, so an upsert on it would otherwise rewrite that row's course.
 */
const refuseCourseClashes = async (
  executor: DatabaseExecutor,
  course: string,
  slugs: readonly string[],
  sourceIds: readonly string[]
): Promise<void> => {
  const sourceClashes =
    sourceIds.length === 0
      ? []
      : await executor
          .select({
            course: academyLessonSources.course,
            id: academyLessonSources.sourceId,
          })
          .from(academyLessonSources)
          .where(
            and(
              inArray(academyLessonSources.sourceId, [...sourceIds]),
              ne(academyLessonSources.course, course)
            )
          )
          .limit(MAX_LISTED_ISSUES);
  const specClashes =
    slugs.length === 0
      ? []
      : await executor
          .select({
            course: academyLessonSpecs.course,
            id: academyLessonSpecs.slug,
          })
          .from(academyLessonSpecs)
          .where(
            and(
              inArray(academyLessonSpecs.slug, [...slugs]),
              ne(academyLessonSpecs.course, course)
            )
          )
          .limit(MAX_LISTED_ISSUES);
  const clashes = [
    ...sourceClashes.map((row) => `source ${row.id} belongs to ${row.course}`),
    ...specClashes.map((row) => `lesson ${row.id} belongs to ${row.course}`),
  ];
  if (clashes.length > 0)
    throw new InvalidRepositoryInputError(
      `academy ${course} import would move rows of another course:\n${clashes
        .slice(0, MAX_LISTED_ISSUES)
        .join("\n")}`
    );
};

const writeCourse = async (
  executor: DatabaseExecutor,
  course: string,
  { sources, specs }: ValidatedAcademyImport,
  prune: boolean
): Promise<AcademyCourseImportResult> => {
  const slugs = specs.map((spec) => spec.slug);
  const sourceIds = sources.map((source) => source.sourceId);
  await refuseCourseClashes(executor, course, slugs, sourceIds);
  // Specs first: a pruned lesson frees its source (and its source id for another lesson).
  const specsDeleted = prune
    ? await executor
        .delete(academyLessonSpecs)
        .where(
          and(
            eq(academyLessonSpecs.course, course),
            notInArray(academyLessonSpecs.slug, slugs)
          )
        )
        .returning({ slug: academyLessonSpecs.slug })
    : [];
  const writtenSources =
    sources.length === 0
      ? []
      : await executor
          .insert(academyLessonSources)
          .values([...sources])
          .onConflictDoUpdate({
            set: {
              caption: sql`excluded.caption`,
              duplicateOf: sql`excluded.duplicate_of`,
              durationSeconds: sql`excluded.duration_seconds`,
              publishedAt: sql`excluded.published_at`,
              transcript: sql`excluded.transcript`,
              updatedAt: sql`now()`,
              url: sql`excluded.url`,
            },
            // Never across courses (refuseCourseClashes reports those; this also covers a racing import).
            setWhere: sql`${academyLessonSources.course} = excluded.course and (${academyLessonSources.url}, ${academyLessonSources.caption}, ${academyLessonSources.publishedAt}, ${academyLessonSources.durationSeconds}, ${academyLessonSources.transcript}, ${academyLessonSources.duplicateOf}) is distinct from (excluded.url, excluded.caption, excluded.published_at, excluded.duration_seconds, excluded.transcript, excluded.duplicate_of)`,
            target: academyLessonSources.sourceId,
          })
          .returning({
            createdAt: academyLessonSources.createdAt,
            updatedAt: academyLessonSources.updatedAt,
          });
  const writtenSpecs =
    specs.length === 0
      ? []
      : await executor
          .insert(academyLessonSpecs)
          .values([...specs])
          .onConflictDoUpdate({
            set: {
              sourceId: sql`excluded.source_id`,
              spec: sql`excluded.spec`,
              specHash: sql`excluded.spec_hash`,
              updatedAt: sql`now()`,
            },
            setWhere: sql`${academyLessonSpecs.course} = excluded.course and ${academyLessonSpecs.specHash} <> excluded.spec_hash`,
            target: academyLessonSpecs.slug,
          })
          .returning({
            createdAt: academyLessonSpecs.createdAt,
            updatedAt: academyLessonSpecs.updatedAt,
          });
  const sourcesDeleted = prune
    ? await executor
        .delete(academyLessonSources)
        .where(
          and(
            eq(academyLessonSources.course, course),
            notInArray(academyLessonSources.sourceId, sourceIds)
          )
        )
        .returning({ sourceId: academyLessonSources.sourceId })
    : [];
  return {
    course,
    sources: countWrites(writtenSources, sources.length, sourcesDeleted.length),
    specs: countWrites(writtenSpecs, specs.length, specsDeleted.length),
  };
};

export const createAcademyContentRepository = (
  database: DatabaseExecutor
): AcademyContentRepository =>
  Object.freeze({
    countSources: async (course) => {
      try {
        const [row] = await database
          .select({ total: count() })
          .from(academyLessonSources)
          .where(
            and(
              eq(academyLessonSources.course, course),
              isNull(academyLessonSources.duplicateOf)
            )
          );
        return row?.total ?? 0;
      } catch (error) {
        return mapError("academy source count", error);
      }
    },
    getLesson: async (slug) => {
      try {
        const [row] = await database
          .select({ ...specColumns, source: sourceColumns })
          .from(academyLessonSpecs)
          .innerJoin(
            academyLessonSources,
            eq(academyLessonSpecs.sourceId, academyLessonSources.sourceId)
          )
          .where(eq(academyLessonSpecs.slug, slug))
          .limit(1);
        return row ?? null;
      } catch (error) {
        return mapError("academy lesson read", error);
      }
    },
    importCourse: async (input) => {
      const validated = await parseAcademyCourseImport(input);
      // drizzle's notInArray(column, []) matches every row: an empty pruning import would empty the course.
      if (
        input.prune === true &&
        (validated.specs.length === 0 || validated.sources.length === 0)
      )
        throw new InvalidRepositoryInputError(
          `academy ${input.course} import with prune lists no lessons or no sources; refusing to empty the course`
        );
      try {
        return await database.transaction((transaction) =>
          writeCourse(
            transaction,
            input.course,
            validated,
            input.prune === true
          )
        );
      } catch (error) {
        return mapError("academy content import", error);
      }
    },
    listLessons: async (course) => {
      try {
        const rows = await database
          .select({
            ...specColumns,
            publishedAt: academyLessonSources.publishedAt,
          })
          .from(academyLessonSpecs)
          .innerJoin(
            academyLessonSources,
            eq(academyLessonSpecs.sourceId, academyLessonSources.sourceId)
          )
          .where(eq(academyLessonSpecs.course, course))
          .orderBy(
            desc(academyLessonSources.publishedAt),
            asc(academyLessonSpecs.slug)
          )
          .limit(MAX_LISTED_LESSONS + 1);
        if (rows.length > MAX_LISTED_LESSONS)
          throw new DatabasePersistenceError(
            `academy lesson list (over ${MAX_LISTED_LESSONS} lessons)`
          );
        return rows;
      } catch (error) {
        return mapError("academy lesson list", error);
      }
    },
  });
