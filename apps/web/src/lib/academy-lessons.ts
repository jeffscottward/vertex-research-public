// What: Server-only lesson loaders of the Academy pages. A course's `store` (courses.ts) picks the
// source: "package" courses (Define Your Risk) come straight from @darkfactory/academy as before;
// "database" courses (QuantFinanceToGo) come from Postgres through academy.lessons and academy.lesson,
// dispatched in-process with the page request's cookie (operator-only like the pages). The page
// builds the lesson's charts client-side from the returned spec.
// Used by: apps/web/src/app/(portal)/academy/**/page.tsx. See: docs/vertex-academy.md#lesson-storage.

import { COURSES, type CourseId } from "@darkfactory/academy/courses";
import {
  ACADEMY_LESSONS,
  type LessonLink,
  lessonBySlug,
  lessonSummaries,
  neighboursIn,
  sourceCounts,
} from "@darkfactory/academy/lessons";
import type { Lesson, LessonSummary } from "@darkfactory/academy/schema";
import { type AcademyLessonOutput, createApiClient } from "@darkfactory/api";

import { ownErrorData } from "./capacity-retry.ts";
import {
  createAuthenticatedDashboardFetch,
  type DashboardTransportFetch,
} from "./dashboard-transport.ts";
import { dispatchInternalOrpcRequest } from "./server-internal-dispatch.ts";
import { resolvePortalAppUrl } from "./server-session.ts";

const ACADEMY_TIMEOUT_MS = 10_000;
// A lesson carries its spec and whole transcript; a course listing up to 500 cards.
const ACADEMY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Test seam: the transport of the in-process oRPC dispatch. */
export type AcademyTransport = DashboardTransportFetch;

const academyApi = (
  cookieHeader: string | null,
  transport: AcademyTransport
) => {
  const appUrl = resolvePortalAppUrl();
  return createApiClient({
    baseUrl: appUrl,
    fetch: createAuthenticatedDashboardFetch(
      cookieHeader,
      appUrl.origin,
      transport,
      ACADEMY_TIMEOUT_MS,
      undefined,
      ACADEMY_MAX_RESPONSE_BYTES
    ),
  }).academy;
};

export type AcademyCourseLessons = Readonly<{
  lessons: readonly LessonSummary[];
  sourceCount: number;
}>;

/** One course's gallery cards and source count. A failed read throws (the page error boundary). */
export const loadCourseLessons = async (
  course: CourseId,
  cookieHeader: string | null,
  transport: AcademyTransport = dispatchInternalOrpcRequest
): Promise<AcademyCourseLessons> => {
  if (COURSES[course].store === "package")
    return {
      lessons: lessonSummaries().filter((lesson) => lesson.course === course),
      sourceCount: sourceCounts()[course],
    };
  const { lessons, sourceCount } = await academyApi(
    cookieHeader,
    transport
  ).lessons({ course });
  return { lessons, sourceCount };
};

type CourseListing = AcademyCourseLessons &
  Readonly<{
    course: CourseId;
    /** The course's lessons could not be read (its storage is missing or failing). */
    unavailable?: true;
  }>;

/**
 * One course's listing for the /academy index. Unlike loadCourseLessons, a failed database read
 * (for example a web deploy before migration 0058) marks only that course unavailable, so the
 * other courses still list.
 */
export const loadCourseListing = async (
  course: CourseId,
  cookieHeader: string | null,
  transport: AcademyTransport = dispatchInternalOrpcRequest
): Promise<CourseListing> => {
  try {
    return {
      course,
      ...(await loadCourseLessons(course, cookieHeader, transport)),
    };
  } catch (error) {
    const code = ownErrorData(error, "code");
    console.error(
      `academy course ${course} unavailable: ${typeof code === "string" ? code : "read failed"}`
    );
    return { course, lessons: [], sourceCount: 0, unavailable: true };
  }
};

export type AcademyLessonPage = Readonly<{
  lesson: Lesson;
  previous: LessonLink | null;
  next: LessonLink | null;
}>;

const toLesson = ({
  spec,
  source: { duplicateOf, ...source },
}: AcademyLessonOutput): Lesson => ({
  ...spec,
  source: duplicateOf === undefined ? source : { ...source, duplicateOf },
});

/** One lesson with its course neighbours, or null when no lesson has this slug. */
export const loadLesson = async (
  slug: string,
  cookieHeader: string | null,
  transport: AcademyTransport = dispatchInternalOrpcRequest
): Promise<AcademyLessonPage | null> => {
  const packaged = lessonBySlug(slug);
  if (packaged !== null)
    return { lesson: packaged, ...neighboursIn(ACADEMY_LESSONS, slug) };
  try {
    const output = await academyApi(cookieHeader, transport).lesson({ slug });
    return {
      lesson: toLesson(output),
      next: output.next,
      previous: output.previous,
    };
  } catch (error) {
    // A slug that is not a valid lesson slug never reaches the handler (input validation).
    const code = ownErrorData(error, "code");
    if (code === "NOT_FOUND" || code === "BAD_REQUEST") return null;
    throw error;
  }
};
