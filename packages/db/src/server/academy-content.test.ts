import { ACADEMY_LESSONS } from "@darkfactory/academy/lessons";
import { describe, expect, it } from "vitest";

import { academyLessonSources, academyLessonSpecs } from "../schema/index.ts";
import {
  academyLessonSpecHash,
  canonicalJson,
  createAcademyContentRepository,
  parseAcademyCourseImport,
} from "./academy-content.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  DatabasePersistenceError,
  InvalidRepositoryInputError,
} from "./repository-errors.ts";

type Outcome = readonly Record<string, unknown>[] | Error;
type Call = readonly [string, unknown];

/**
 * A query-builder double: every builder method records its call and returns the chain; awaiting the
 * chain settles with the next queued outcome. `transaction` runs its callback on the same double.
 */
const createDouble = (outcomes: Outcome[], transactionError?: Error) => {
  const calls: Call[] = [];
  const queue = [...outcomes];
  const record =
    (name: string) =>
    (argument?: unknown): unknown => {
      calls.push([name, argument]);
      return chain;
    };
  const chain = {
    delete: record("delete"),
    from: record("from"),
    innerJoin: record("innerJoin"),
    insert: record("insert"),
    limit: record("limit"),
    onConflictDoUpdate: record("onConflictDoUpdate"),
    orderBy: record("orderBy"),
    returning: record("returning"),
    select: record("select"),
    values: record("values"),
    where: record("where"),
    then: (
      resolve: (value: unknown) => unknown,
      reject: (error: unknown) => unknown
    ) => {
      const next = queue.shift() ?? [];
      return next instanceof Error ? reject(next) : resolve(next);
    },
  };
  const database = {
    ...chain,
    then: undefined,
    transaction: async (run: (transaction: unknown) => Promise<unknown>) => {
      calls.push(["transaction", undefined]);
      if (transactionError !== undefined) throw transactionError;
      return run(database);
    },
  } as unknown as DatabaseExecutor;
  return {
    calls,
    database,
    names: () => calls.map(([name]) => name),
  };
};

const postgresError = (code: string, constraint?: string): Error =>
  Object.assign(new Error("query failed"), { cause: { code, constraint } });

// Two packaged Define Your Risk lessons: valid specs and sources of one course.
const [first, second] = ACADEMY_LESSONS;
if (first === undefined || second === undefined)
  throw new Error("the academy package ships no lessons");
const COURSE = first.course;
const specOf = ({ source: _source, ...spec }: typeof first) => spec;
const SPECS = [specOf(first), specOf(second)];
const SOURCES = [first.source, second.source];
const INPUT = { course: COURSE, sources: SOURCES, specs: SPECS };

const AT = new Date("2026-11-08T12:00:00.000Z");
const LATER = new Date("2026-11-08T12:05:00.000Z");
const created = { createdAt: AT, updatedAt: AT };
const updated = { createdAt: AT, updatedAt: LATER };

describe("canonicalJson and academyLessonSpecHash", () => {
  it("sorts keys at every depth and drops undefined members", () => {
    expect(
      canonicalJson({ b: [2, { d: 1, c: null }], a: "x", skip: undefined })
    ).toBe('{"a":"x","b":[2,{"c":null,"d":1}]}');
    expect(canonicalJson(3)).toBe("3");
  });

  it("hashes equal specs equally whatever their key order", async () => {
    const hash = await academyLessonSpecHash({ a: 1, b: 2 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    await expect(academyLessonSpecHash({ b: 2, a: 1 })).resolves.toBe(hash);
    await expect(academyLessonSpecHash({ a: 1, b: 3 })).resolves.not.toBe(hash);
  });
});

describe("parseAcademyCourseImport", () => {
  it("returns the rows to store: parsed specs with their hash, sources with a null duplicate", async () => {
    const parsed = await parseAcademyCourseImport(INPUT);
    expect(parsed.sources.map((row) => row.sourceId)).toEqual(
      SOURCES.map((source) => source.sourceId)
    );
    expect(parsed.sources[0]).toMatchObject({
      course: COURSE,
      duplicateOf: null,
      url: first.source.url,
    });
    expect(parsed.specs.map((row) => row.slug)).toEqual([
      first.slug,
      second.slug,
    ]);
    expect(parsed.specs[0]?.specHash).toBe(
      await academyLessonSpecHash(parsed.specs[0]?.spec)
    );
    const duplicate = { ...first.source, duplicateOf: second.source.sourceId };
    const withDuplicate = await parseAcademyCourseImport({
      ...INPUT,
      sources: [duplicate, second.source],
    });
    expect(withDuplicate.sources[0]?.duplicateOf).toBe(second.source.sourceId);
  });

  it("names every problem in one error", async () => {
    const strayCourse = COURSE === "dyr" ? "quantfinancetogo" : "dyr";
    const result = parseAcademyCourseImport({
      course: COURSE,
      sources: [
        null,
        { ...first.source, url: "http://insecure" },
        first.source,
        first.source,
        { ...second.source, course: strayCourse },
      ],
      specs: [
        { ...SPECS[0], kind: "nope" },
        SPECS[0],
        SPECS[0],
        { ...SPECS[1], sourceId: first.source.sourceId },
        { ...SPECS[1], slug: "unlisted-source", sourceId: "ZZZZZZZZZZZ" },
        { ...SPECS[1], slug: "stray-course", course: strayCourse },
      ],
    });
    await expect(result).rejects.toThrow(InvalidRepositoryInputError);
    const message = await result.then(
      () => "",
      (error: Error) => error.message
    );
    expect(message).toMatch(
      /^Invalid repository input: academy \S+ import is invalid \(\d+ problems\):/u
    );
    expect(message).toContain("source 0: (root)");
    expect(message).toContain("source 1: url");
    expect(message).toContain(
      `source ${first.source.sourceId} is listed twice`
    );
    expect(message).toContain(
      `source ${second.source.sourceId} is in course ${strayCourse}`
    );
    expect(message).toContain("spec 0: kind");
    // At most five problems are listed.
    expect(message.split("\n")).toHaveLength(6);
  });

  it("reports the spec problems: reused slug or source, unlisted source, wrong course", async () => {
    const strayCourse = COURSE === "dyr" ? "quantfinancetogo" : "dyr";
    const messageOf = (specs: unknown[]) =>
      parseAcademyCourseImport({ ...INPUT, specs }).then(
        () => "",
        (error: Error) => error.message
      );
    await expect(messageOf([SPECS[0], SPECS[0]])).resolves.toContain(
      `lesson slug ${first.slug} is used twice`
    );
    await expect(messageOf([SPECS[0], SPECS[0]])).resolves.toContain(
      "(2 problems)"
    );
    await expect(
      messageOf([{ ...SPECS[1], sourceId: first.source.sourceId }, SPECS[0]])
    ).resolves.toContain(
      `lesson ${first.slug} uses source ${first.source.sourceId}, already used by ${second.slug}`
    );
    await expect(
      messageOf([{ ...SPECS[0], sourceId: "ZZZZZZZZZZZ" }])
    ).resolves.toBe(
      `Invalid repository input: academy ${COURSE} import is invalid (1 problem):\nlesson ${first.slug} names source ZZZZZZZZZZZ, which the import does not list`
    );
    await expect(
      messageOf([{ ...SPECS[0], course: strayCourse }])
    ).resolves.toContain(`lesson ${first.slug} is in course ${strayCourse}`);
  });
});

describe("academy content repository", () => {
  it("lists a course's lessons joined with their source's publish date", async () => {
    const row = { slug: first.slug, publishedAt: first.source.publishedAt };
    const double = createDouble([[row]]);
    await expect(
      createAcademyContentRepository(double.database).listLessons(COURSE)
    ).resolves.toEqual([row]);
    expect(double.names()).toEqual([
      "select",
      "from",
      "innerJoin",
      "where",
      "orderBy",
    ]);
    expect(double.calls[1]?.[1]).toBe(academyLessonSpecs);
    expect(double.calls[2]?.[1]).toBe(academyLessonSources);
  });

  it("reads one lesson with its source, or null", async () => {
    const row = { slug: first.slug, source: { sourceId: "x" } };
    const double = createDouble([[row], []]);
    const repository = createAcademyContentRepository(double.database);
    await expect(repository.getLesson(first.slug)).resolves.toEqual(row);
    expect(double.calls).toContainEqual(["limit", 1]);
    await expect(repository.getLesson("missing")).resolves.toBeNull();
  });

  it("counts a course's sources, zero when the count row is missing", async () => {
    const double = createDouble([[{ total: 7 }], []]);
    const repository = createAcademyContentRepository(double.database);
    await expect(repository.countSources(COURSE)).resolves.toBe(7);
    expect(double.calls[1]?.[1]).toBe(academyLessonSources);
    await expect(repository.countSources(COURSE)).resolves.toBe(0);
  });

  it("maps database failures on every read and rethrows other errors", async () => {
    const failing = (error: Error) =>
      createAcademyContentRepository(
        createDouble([error, error, error]).database
      );
    const outage = failing(postgresError("08006"));
    await expect(outage.listLessons(COURSE)).rejects.toThrow(
      new DatabasePersistenceError("academy lesson list")
    );
    await expect(outage.getLesson("x")).rejects.toThrow(
      new DatabasePersistenceError("academy lesson read")
    );
    await expect(outage.countSources(COURSE)).rejects.toThrow(
      new DatabasePersistenceError("academy source count")
    );
    const bug = new TypeError("bug");
    await expect(failing(bug).getLesson("x")).rejects.toBe(bug);
  });

  it("imports a new course in one transaction: specs and sources upserted, nothing pruned", async () => {
    const double = createDouble([
      [created, created],
      [created, updated],
    ]);
    await expect(
      createAcademyContentRepository(double.database).importCourse(INPUT)
    ).resolves.toEqual({
      course: COURSE,
      sources: { created: 2, updated: 0, unchanged: 0, deleted: 0 },
      specs: { created: 1, updated: 1, unchanged: 0, deleted: 0 },
    });
    expect(double.names()).toEqual([
      "transaction",
      "insert",
      "values",
      "onConflictDoUpdate",
      "returning",
      "insert",
      "values",
      "onConflictDoUpdate",
      "returning",
    ]);
    expect(double.calls[1]?.[1]).toBe(academyLessonSources);
    expect(double.calls[5]?.[1]).toBe(academyLessonSpecs);
  });

  it("prunes unlisted specs before the upserts and unlisted sources after them", async () => {
    const double = createDouble([
      [{ slug: "gone" }],
      [],
      [updated],
      [{ sourceId: "a" }, { sourceId: "b" }],
    ]);
    await expect(
      createAcademyContentRepository(double.database).importCourse({
        ...INPUT,
        prune: true,
      })
    ).resolves.toEqual({
      course: COURSE,
      sources: { created: 0, updated: 0, unchanged: 2, deleted: 2 },
      specs: { created: 0, updated: 1, unchanged: 1, deleted: 1 },
    });
    expect(double.names().filter((name) => name === "delete")).toHaveLength(2);
    expect(double.calls[1]).toEqual(["delete", academyLessonSpecs]);
    expect(double.calls.at(-3)).toEqual(["delete", academyLessonSources]);
  });

  it("skips the upserts of an empty course and only prunes it", async () => {
    const double = createDouble([[{ slug: "a" }], [{ sourceId: "b" }]]);
    await expect(
      createAcademyContentRepository(double.database).importCourse({
        course: COURSE,
        sources: [],
        specs: [],
        prune: true,
      })
    ).resolves.toEqual({
      course: COURSE,
      sources: { created: 0, updated: 0, unchanged: 0, deleted: 1 },
      specs: { created: 0, updated: 0, unchanged: 0, deleted: 1 },
    });
    expect(double.names()).not.toContain("insert");
  });

  it("validates before opening a transaction", async () => {
    const double = createDouble([]);
    await expect(
      createAcademyContentRepository(double.database).importCourse({
        ...INPUT,
        specs: [{}],
      })
    ).rejects.toThrow(InvalidRepositoryInputError);
    expect(double.calls).toEqual([]);
  });

  it("maps constraint failures to input errors and other database failures to persistence errors", async () => {
    const importWith = (error: Error) =>
      createAcademyContentRepository(
        createDouble([], error).database
      ).importCourse(INPUT);
    await expect(
      importWith(postgresError("23503", "academy_lesson_specs_source_fk"))
    ).rejects.toThrow(
      new InvalidRepositoryInputError(
        "academy content fails academy_lesson_specs_source_fk"
      )
    );
    await expect(importWith(postgresError("23514"))).rejects.toThrow(
      new InvalidRepositoryInputError("academy content fails a constraint")
    );
    await expect(importWith(postgresError("40001"))).rejects.toThrow(
      new DatabasePersistenceError("academy content import")
    );
    for (const passthrough of [
      new InvalidRepositoryInputError("bad"),
      new DatabasePersistenceError("other"),
      new RangeError("bug"),
    ])
      await expect(importWith(passthrough)).rejects.toBe(passthrough);
  });
});
