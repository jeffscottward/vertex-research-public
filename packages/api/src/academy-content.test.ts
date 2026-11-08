import {
  ACADEMY_LESSONS,
  neighboursIn,
  sourceCounts,
  toLessonSummary,
} from "@darkfactory/academy/lessons";
import type { Lesson } from "@darkfactory/academy/schema";
import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  type AcademyContentRepository,
  type AcademyLessonListEntry,
  type AcademyLessonRecord,
  DatabasePersistenceError,
  type Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import { DATABASE_COURSE_LESSONS } from "../../academy/src/lessons/database-courses.test-support.ts";
import { createApiClient } from "./client.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

const at = new Date("2026-11-08T12:00:00.000Z");

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-11-09T12:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: at,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: at,
  },
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  academyContent: AcademyContentRepository | undefined
) => {
  const repositories = (academyContent === undefined
    ? {}
    : { academyContent }) as unknown as Repositories;
  const denied = () =>
    new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
  const fetch = async (request: Request): Promise<Response> =>
    handleApiRequest(
      request,
      createApiContext(request, {
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        operatorEmails: ["operator@domain.test"],
        repositories,
        requestId: "request-1",
        requireRole: async () => {
          throw denied();
        },
        requireSession: async () => {
          if (requestSession === null) throw denied();
          return requestSession;
        },
      })
    );
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch })
    .academy;
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  message: RegExp = /.*/u
) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ORPCError);
  expect(error).toMatchObject({
    code,
    message: expect.stringMatching(message),
  });
};

const QFTG = DATABASE_COURSE_LESSONS.filter(
  (lesson) => lesson.course === "quantfinancetogo"
);
const [FIRST, SECOND] = QFTG as [Lesson, Lesson];
const specOf = ({ source: _source, ...spec }: Lesson) => spec;

const listEntry = (lesson: Lesson): AcademyLessonListEntry => ({
  course: lesson.course,
  publishedAt: lesson.source.publishedAt,
  slug: lesson.slug,
  sourceId: lesson.sourceId,
  spec: specOf(lesson),
  specHash: "a".repeat(64),
  updatedAt: at,
});

const record = (lesson: Lesson): AcademyLessonRecord => {
  const { duplicateOf, ...source } = lesson.source;
  return {
    ...listEntry(lesson),
    source: { ...source, duplicateOf: duplicateOf ?? null, updatedAt: at },
  };
};

type Reads = Readonly<{
  calls: string[];
  repository: AcademyContentRepository;
}>;

const repositoryOf = (
  overrides: Partial<AcademyContentRepository> = {}
): Reads => {
  const calls: string[] = [];
  const repository: AcademyContentRepository = {
    countSources: async (course) => {
      calls.push(`count:${course}`);
      return 7;
    },
    getLesson: async (slug) => {
      calls.push(`get:${slug}`);
      const found = QFTG.find((lesson) => lesson.slug === slug);
      return found === undefined ? null : record(found);
    },
    importCourse: () => Promise.reject(new Error("read-only procedures")),
    listLessons: async (course) => {
      calls.push(`list:${course}`);
      return QFTG.filter((lesson) => lesson.course === course).map(listEntry);
    },
    ...overrides,
  };
  return { calls, repository };
};

const operator = session("operator");

describe("academy.lessons and academy.lesson", () => {
  it("are operator-only and read nothing for anyone else", async () => {
    const reads = repositoryOf();
    for (const [who, code] of [
      [null, "UNAUTHORIZED"],
      [session("outsider"), "FORBIDDEN"],
    ] as const) {
      const academy = clientFor(who, reads.repository);
      await expectCode(academy.lessons({ course: "quantfinancetogo" }), code);
      await expectCode(academy.lesson({ slug: FIRST.slug }), code);
    }
    expect(reads.calls).toEqual([]);
  });

  it("lists a database course from Postgres, newest first, with its source count", async () => {
    const reads = repositoryOf();
    await expect(
      clientFor(operator, reads.repository).lessons({
        course: "quantfinancetogo",
      })
    ).resolves.toEqual({
      course: "quantfinancetogo",
      lessons: QFTG.map(toLessonSummary),
      sourceCount: 7,
    });
    expect(reads.calls).toEqual([
      "list:quantfinancetogo",
      "count:quantfinancetogo",
    ]);
  });

  it("lists a packaged course from @darkfactory/academy without the database", async () => {
    const reads = repositoryOf();
    await expect(
      clientFor(operator, undefined).lessons({ course: "dyr" })
    ).resolves.toEqual({
      course: "dyr",
      lessons: ACADEMY_LESSONS.filter((lesson) => lesson.course === "dyr").map(
        toLessonSummary
      ),
      sourceCount: sourceCounts().dyr,
    });
    expect(reads.calls).toEqual([]);
  });

  it("reads a stored lesson with its source and course neighbours", async () => {
    const reads = repositoryOf();
    const output = await clientFor(operator, reads.repository).lesson({
      slug: SECOND.slug,
    });
    expect(output).toEqual({
      spec: specOf(SECOND),
      source: SECOND.source,
      ...neighboursIn(QFTG, SECOND.slug),
    });
    expect(output.previous).toEqual({ slug: FIRST.slug, title: FIRST.title });
    expect(reads.calls).toEqual([
      `get:${SECOND.slug}`,
      "list:quantfinancetogo",
    ]);
  });

  it("keeps a recorded duplicate on the source", async () => {
    const reads = repositoryOf({
      getLesson: async () => {
        const stored = record(FIRST);
        return {
          ...stored,
          source: { ...stored.source, duplicateOf: SECOND.sourceId },
        };
      },
    });
    const output = await clientFor(operator, reads.repository).lesson({
      slug: FIRST.slug,
    });
    expect(output.source.duplicateOf).toBe(SECOND.sourceId);
  });

  it("reads a packaged lesson without the database", async () => {
    const packaged = ACADEMY_LESSONS[1] as Lesson;
    await expect(
      clientFor(operator, undefined).lesson({ slug: packaged.slug })
    ).resolves.toEqual({
      spec: specOf(packaged),
      source: packaged.source,
      ...neighboursIn(ACADEMY_LESSONS, packaged.slug),
    });
  });

  it("answers NOT_FOUND for an unknown slug", async () => {
    await expectCode(
      clientFor(operator, repositoryOf().repository).lesson({
        slug: "no-such-lesson",
      }),
      "NOT_FOUND",
      /No lesson no-such-lesson/u
    );
  });

  it("answers STORAGE_ERROR without storage, on a database failure or a malformed row", async () => {
    const academy = clientFor(operator, undefined);
    await expectCode(
      academy.lessons({ course: "quantfinancetogo" }),
      "STORAGE_ERROR"
    );
    await expectCode(academy.lesson({ slug: FIRST.slug }), "STORAGE_ERROR");

    const outage = repositoryOf({
      listLessons: () => Promise.reject(new DatabasePersistenceError("x")),
    });
    await expectCode(
      clientFor(operator, outage.repository).lessons({
        course: "quantfinancetogo",
      }),
      "STORAGE_ERROR",
      /Academy storage unavailable/u
    );

    const badSpec = repositoryOf({
      listLessons: async () => [{ ...listEntry(FIRST), spec: { title: 3 } }],
    });
    await expectCode(
      clientFor(operator, badSpec.repository).lessons({
        course: "quantfinancetogo",
      }),
      "STORAGE_ERROR",
      new RegExp(`Academy lesson ${FIRST.slug} has an unexpected shape at`, "u")
    );

    const badSource = repositoryOf({
      getLesson: async () => {
        const stored = record(FIRST);
        return { ...stored, source: { ...stored.source, url: "ftp://x" } };
      },
    });
    await expectCode(
      clientFor(operator, badSource.repository).lesson({ slug: FIRST.slug }),
      "STORAGE_ERROR",
      new RegExp(
        `Academy source ${FIRST.sourceId} has an unexpected shape at url`,
        "u"
      )
    );
  });

  it("does not hide unexpected failures as storage errors", async () => {
    const broken = repositoryOf({
      getLesson: () => Promise.reject(new TypeError("bug")),
    });
    await expectCode(
      clientFor(operator, broken.repository).lesson({ slug: FIRST.slug }),
      "INTERNAL_SERVER_ERROR"
    );
  });
});
