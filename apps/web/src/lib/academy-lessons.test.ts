import {
  ACADEMY_LESSONS,
  lessonSummaries,
  neighboursIn,
  sourceCounts,
  toLessonSummary,
} from "@darkfactory/academy/lessons";
import type { Lesson } from "@darkfactory/academy/schema";
import { describe, expect, it, vi } from "vitest";

vi.mock("./server-internal-dispatch.ts", () => ({
  dispatchInternalOrpcRequest: () => {
    throw new Error("tests pass their own transport");
  },
}));

import { DATABASE_COURSE_LESSONS } from "../../../../packages/academy/src/lessons/database-courses.test-support.ts";
import {
  loadCourseLessons,
  loadCourseListing,
  loadLesson,
} from "./academy-lessons.ts";

const [FIRST, SECOND] = DATABASE_COURSE_LESSONS as [Lesson, Lesson];
const specOf = ({ source: _source, ...spec }: Lesson) => spec;

// oRPC RPC wire format: the payload under `json`.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify({ json: body }), {
    headers: { "content-type": "application/json" },
    status,
  });

const transportOf = (respond: (request: Request) => Response) => {
  const requests: Request[] = [];
  const transport = vi.fn(async (request: Request) => {
    requests.push(request);
    return respond(request);
  });
  return { requests, transport };
};

describe("loadCourseLessons", () => {
  it("answers a packaged course from @darkfactory/academy without a request", async () => {
    const { transport } = transportOf(() => json({}));
    await expect(loadCourseLessons("dyr", null, transport)).resolves.toEqual({
      lessons: lessonSummaries().filter((lesson) => lesson.course === "dyr"),
      sourceCount: sourceCounts().dyr,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("reads a database course through academy.lessons with the request cookie", async () => {
    const lessons = [toLessonSummary(FIRST)];
    const { requests, transport } = transportOf(() =>
      json({ course: "quantfinancetogo", lessons, sourceCount: 3 })
    );
    await expect(
      loadCourseLessons("quantfinancetogo", "session=abc", transport)
    ).resolves.toEqual({ lessons, sourceCount: 3 });
    expect(new URL(requests[0]?.url ?? "").pathname).toMatch(
      /\/academy\/lessons$/u
    );
    expect(requests[0]?.headers.get("cookie")).toBe("session=abc");
  });
});

describe("loadCourseListing", () => {
  it("marks only a failing database course unavailable (e.g. web deployed before migration 0059)", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { transport } = transportOf(() =>
      json(
        {
          code: "STORAGE_ERROR",
          data: undefined,
          defined: true,
          message: "STORAGE_ERROR",
          status: 503,
        },
        503
      )
    );
    await expect(
      loadCourseListing("quantfinancetogo", "c=1", transport)
    ).resolves.toEqual({
      course: "quantfinancetogo",
      lessons: [],
      sourceCount: 0,
      unavailable: true,
    });
    expect(error).toHaveBeenCalledWith(
      "academy course quantfinancetogo unavailable: STORAGE_ERROR"
    );
    await expect(
      loadCourseListing("dyr", "c=1", transport)
    ).resolves.toMatchObject({
      course: "dyr",
      sourceCount: sourceCounts().dyr,
    });
    const broken = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      loadCourseListing("quantfinancetogo", "c=1", broken)
    ).resolves.toMatchObject({ unavailable: true });
    expect(error).toHaveBeenLastCalledWith(
      "academy course quantfinancetogo unavailable: read failed"
    );
    error.mockRestore();
  });
});

describe("loadLesson", () => {
  it("answers a packaged lesson without a request", async () => {
    const packaged = ACADEMY_LESSONS[0] as Lesson;
    const { transport } = transportOf(() => json({}));
    await expect(loadLesson(packaged.slug, null, transport)).resolves.toEqual({
      lesson: packaged,
      ...neighboursIn(ACADEMY_LESSONS, packaged.slug),
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("joins a stored lesson's spec and source, keeping a recorded duplicate", async () => {
    const previous = { slug: FIRST.slug, title: FIRST.title };
    const { transport } = transportOf(() =>
      json({
        next: null,
        previous,
        source: SECOND.source,
        spec: specOf(SECOND),
      })
    );
    const page = await loadLesson(SECOND.slug, "c=1", transport);
    expect(page).toEqual({ lesson: SECOND, next: null, previous });
    const duplicate = { ...FIRST.source, duplicateOf: SECOND.sourceId };
    const withDuplicate = transportOf(() =>
      json({
        next: null,
        previous: null,
        source: duplicate,
        spec: specOf(FIRST),
      })
    );
    const read = await loadLesson(FIRST.slug, "c=1", withDuplicate.transport);
    expect(read?.lesson.source.duplicateOf).toBe(SECOND.sourceId);
  });

  it("answers null for an unknown or invalid slug and throws other failures", async () => {
    const failing = (code: string, status: number) =>
      transportOf(() =>
        json(
          { code, data: undefined, defined: true, message: code, status },
          status
        )
      ).transport;
    await expect(
      loadLesson("no-such-lesson", "c=1", failing("NOT_FOUND", 404))
    ).resolves.toBeNull();
    await expect(
      loadLesson("Bad Slug", "c=1", failing("BAD_REQUEST", 400))
    ).resolves.toBeNull();
    await expect(
      loadLesson("no-such-lesson", "c=1", failing("STORAGE_ERROR", 503))
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
});
