// What: academy.lessons and academy.lesson, the read side of the Academy lesson catalog. Read-only and
// operator-only like the pages (the transcripts are private). A course's `store` (courses.ts) picks
// the source: "package" courses (Define Your Risk) answer from @darkfactory/academy, "database"
// courses (QuantFinanceToGo) from Postgres through the Academy content repository. Every stored spec
// and source is validated again here, at the boundary, so a row that no longer matches the schema is
// a storage error, never a broken page. Research and education only: nothing here places orders.
// See: packages/db/src/server/academy-content.ts; docs/vertex-academy.md#lesson-storage.
import { COURSES, type CourseId } from "@darkfactory/academy/courses";
import {
  ACADEMY_LESSONS,
  lessonBySlug,
  neighboursIn,
  sourceCounts,
  toLessonSummary,
} from "@darkfactory/academy/lessons";
import {
  LessonSourceSchema,
  type LessonSpec,
  LessonSpecSchema,
  type LessonSummary,
} from "@darkfactory/academy/schema";
import {
  type AcademyContentRepository,
  type AcademyLessonListEntry,
  type AcademyLessonSourceRecord,
  DatabasePersistenceError,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type {
  AcademyLessonOutput,
  AcademyLessonsOutput,
} from "../contracts/academy.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

/** A stored row that no longer passes LessonSpecSchema or LessonSourceSchema. */
export class AcademyContentShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcademyContentShapeError";
  }
}

const parsed = <T>(
  what: string,
  result:
    | Readonly<{ success: true; data: T }>
    | Readonly<{
        success: false;
        error: { issues: readonly { path: readonly PropertyKey[] }[] };
      }>
): T => {
  if (result.success) return result.data;
  const where = result.error.issues
    .slice(0, 3)
    .map((issue) => issue.path.map(String).join("."))
    .join(", ");
  throw new AcademyContentShapeError(
    `Academy ${what} has an unexpected shape at ${where}`
  );
};

const specOf = (row: Readonly<{ slug: string; spec: unknown }>): LessonSpec =>
  parsed(`lesson ${row.slug}`, LessonSpecSchema.safeParse(row.spec));

/** The stored source as LessonSource (a null duplicate is an absent one). */
export const toLessonSource = ({
  duplicateOf,
  updatedAt: _updatedAt,
  ...source
}: AcademyLessonSourceRecord): AcademyLessonOutput["source"] =>
  parsed(
    `source ${source.sourceId}`,
    LessonSourceSchema.safeParse(
      duplicateOf === null ? source : { ...source, duplicateOf }
    )
  );

/** Gallery cards of stored lessons, in the repository's order (newest source first). */
export const toLessonSummaries = (
  rows: readonly AcademyLessonListEntry[]
): LessonSummary[] =>
  rows.map((row) =>
    toLessonSummary({
      ...specOf(row),
      source: { publishedAt: row.publishedAt },
    })
  );

type Errors = Readonly<{
  NOT_FOUND: (options?: { message?: string }) => Error;
  STORAGE_ERROR: (options?: { message?: string }) => Error;
}>;

const contentRepository = (
  context: ApiContext,
  errors: Errors
): AcademyContentRepository => {
  const repository = context.repositories.academyContent;
  if (repository === undefined) throw errors.STORAGE_ERROR();
  return repository;
};

/** Runs a database read; shape and persistence failures become STORAGE_ERROR. */
const storageRead = async <T>(
  errors: Errors,
  read: () => Promise<T>
): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AcademyContentShapeError)
      throw errors.STORAGE_ERROR({ message: error.message });
    if (error instanceof DatabasePersistenceError) throw errors.STORAGE_ERROR();
    throw error;
  }
};

const packagedLessons = (course: CourseId): AcademyLessonsOutput => ({
  course,
  sourceCount: sourceCounts()[course],
  lessons: ACADEMY_LESSONS.filter((lesson) => lesson.course === course).map(
    toLessonSummary
  ),
});

const api = implement(appContract).$context<ApiContext>();

const lessonsProcedure = api.academy.lessons
  .use(requireOperator)
  .handler(
    async ({ context, errors, input }): Promise<AcademyLessonsOutput> => {
      if (COURSES[input.course].store === "package")
        return packagedLessons(input.course);
      const repository = contentRepository(context, errors);
      return await storageRead(errors, async () => ({
        course: input.course,
        lessons: toLessonSummaries(await repository.listLessons(input.course)),
        sourceCount: await repository.countSources(input.course),
      }));
    }
  );

const lessonProcedure = api.academy.lesson
  .use(requireOperator)
  .handler(async ({ context, errors, input }): Promise<AcademyLessonOutput> => {
    const packaged = lessonBySlug(input.slug);
    if (packaged !== null) {
      const { source, ...spec } = packaged;
      return {
        spec,
        source: { ...source, transcript: [...source.transcript] },
        ...neighboursIn(ACADEMY_LESSONS, input.slug),
      };
    }
    const repository = contentRepository(context, errors);
    return await storageRead(errors, async () => {
      const record = await repository.getLesson(input.slug);
      if (record === null)
        throw errors.NOT_FOUND({ message: `No lesson ${input.slug}` });
      const spec = specOf(record);
      const source = toLessonSource(record.source);
      // Previous and next stay inside the lesson's course, in gallery order.
      const course = toLessonSummaries(
        await repository.listLessons(spec.course)
      );
      return { spec, source, ...neighboursIn(course, input.slug) };
    });
  });

export const academyContentRouter = {
  lesson: lessonProcedure,
  lessons: lessonsProcedure,
};
