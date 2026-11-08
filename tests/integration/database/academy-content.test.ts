import { readFileSync } from "node:fs";

import {
  academyLessonSources,
  academyLessonSpecs,
} from "@darkfactory/db/schema";
import {
  academyLessonSpecHash,
  createAcademyContentRepository,
  createNodeDatabase,
  type Database,
  InvalidRepositoryInputError,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importAcademyCourses } from "../../../scripts/academy/import-lessons.ts";
import { DATABASE_COURSE_CONTENT } from "../../../scripts/academy/lessons/index.ts";

// Academy content tables (migration 0058) on a real database: repository reads and the import write,
// the checks and foreign keys behind them, and the guarded rollback.

const ROLLBACK = readFileSync(
  new URL(
    "../../../packages/db/rollback/0058_academy_content.down.sql",
    import.meta.url
  ),
  "utf8"
);

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const database = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};

const QFTG = DATABASE_COURSE_CONTENT.quantfinancetogo;
if (QFTG === undefined)
  throw new Error("QuantFinanceToGo import input missing");

type RawSpec = Readonly<Record<string, unknown> & { sourceId: string }>;
type RawSource = Readonly<Record<string, unknown> & { sourceId: string }>;
const SPECS = QFTG.specs as readonly RawSpec[];
const SOURCES = QFTG.sources as readonly RawSource[];
const firstSpec = SPECS[0] as RawSpec;
const sourceOf = (spec: RawSpec): RawSource => {
  const source = SOURCES.find((entry) => entry.sourceId === spec.sourceId);
  if (source === undefined) throw new Error(`no source ${spec.sourceId}`);
  return source;
};

describe("academy content repository (Postgres)", () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
    });
    await migrate(resource.db);
  }, 60_000);

  afterAll(async () => {
    await resource?.close();
    if (testDatabase !== undefined)
      await dropPostgresTestDatabase(testDatabase);
  });

  it("imports the QuantFinanceToGo course, then leaves an unchanged re-import alone", async () => {
    const repository = createAcademyContentRepository(database());
    const [first] = await importAcademyCourses(repository);
    expect(first).toEqual({
      course: "quantfinancetogo",
      sources: {
        created: SOURCES.length,
        updated: 0,
        unchanged: 0,
        deleted: 0,
      },
      specs: { created: SPECS.length, updated: 0, unchanged: 0, deleted: 0 },
    });
    const [again] = await importAcademyCourses(repository);
    expect(again).toEqual({
      course: "quantfinancetogo",
      sources: {
        created: 0,
        updated: 0,
        unchanged: SOURCES.length,
        deleted: 0,
      },
      specs: { created: 0, updated: 0, unchanged: SPECS.length, deleted: 0 },
    });
    expect(await repository.countSources("quantfinancetogo")).toBe(
      SOURCES.filter((source) => source["duplicateOf"] === undefined).length
    );
    expect(await repository.countSources("dyr")).toBe(0);
    // Two full imports, each checking that all 48 lessons draw: well over 5 s on a CI runner. A timed-out
    // import keeps writing on the pool and deadlocks the rollback test below.
  }, 60_000);

  it("lists a course newest first and reads one lesson with its source", async () => {
    const repository = createAcademyContentRepository(database());
    const lessons = await repository.listLessons("quantfinancetogo");
    expect(lessons).toHaveLength(SPECS.length);
    const dates = lessons.map((lesson) => lesson.publishedAt);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(await repository.listLessons("dyr")).toEqual([]);

    const slug = String(firstSpec["slug"]);
    const lesson = await repository.getLesson(slug);
    expect(lesson).toMatchObject({
      course: "quantfinancetogo",
      slug,
      sourceId: firstSpec.sourceId,
      spec: { slug, course: "quantfinancetogo", sourceId: firstSpec.sourceId },
      source: {
        course: "quantfinancetogo",
        sourceId: firstSpec.sourceId,
        url: sourceOf(firstSpec)["url"],
        transcript: sourceOf(firstSpec)["transcript"],
        duplicateOf: null,
      },
    });
    expect(lesson?.specHash).toBe(await academyLessonSpecHash(lesson?.spec));
    await expect(repository.getLesson("no-such-lesson")).resolves.toBeNull();
  });

  it("updates a changed spec and prunes what the input no longer lists", async () => {
    const repository = createAcademyContentRepository(database());
    const [kept, changed] = SPECS;
    if (kept === undefined || changed === undefined) throw new Error("specs");
    const result = await repository.importCourse({
      course: "quantfinancetogo",
      prune: true,
      sources: [sourceOf(kept), sourceOf(changed)],
      specs: [kept, { ...changed, title: "A changed lesson title" }],
    });
    expect(result.specs).toEqual({
      created: 0,
      updated: 1,
      unchanged: 1,
      deleted: SPECS.length - 2,
    });
    expect(result.sources).toMatchObject({ unchanged: 2 });
    expect(result.sources.deleted).toBe(SOURCES.length - 2);
    expect(
      (await repository.getLesson(String(changed["slug"])))?.spec["title"]
    ).toBe("A changed lesson title");
    expect(await repository.listLessons("quantfinancetogo")).toHaveLength(2);
  });

  it("refuses invalid input before writing and constraint breaks inside the transaction", async () => {
    const repository = createAcademyContentRepository(database());
    await expect(
      repository.importCourse({
        course: "quantfinancetogo",
        sources: [sourceOf(firstSpec)],
        specs: [{ ...firstSpec, steps: [] }],
      })
    ).rejects.toThrow(InvalidRepositoryInputError);
    // The composite foreign key ties a lesson to a source of its own course: moving a used source to
    // another course fails, and the whole import with it.
    await expect(
      repository.importCourse({
        course: "dyr",
        sources: [{ ...sourceOf(firstSpec), course: "dyr" }],
        specs: [],
      })
    ).rejects.toThrow(/academy_lesson_specs_source_fk/u);
    expect(await repository.listLessons("quantfinancetogo")).toHaveLength(2);
    // The checks hold for rows written around the repository.
    await expect(
      database()
        .insert(academyLessonSpecs)
        .values({
          course: "quantfinancetogo",
          slug: "mismatch",
          sourceId: firstSpec.sourceId,
          spec: { slug: "other" },
          specHash: "0".repeat(64),
        })
    ).rejects.toThrow();
    await expect(
      database().insert(academyLessonSources).values({
        caption: "",
        course: "quantfinancetogo",
        durationSeconds: 1,
        publishedAt: "yesterday",
        sourceId: "Bad01",
        transcript: [],
        url: "https://example.test/",
      })
    ).rejects.toThrow();
  });

  it("refuses the rollback while content exists, then drops both tables", async () => {
    const postgres = (): PostgresTestDatabase => {
      if (testDatabase === undefined) throw new Error("Database not started");
      return testDatabase;
    };
    await expect(postgres().query(ROLLBACK)).rejects.toThrow(
      /academy content tables are not empty/u
    );
    // The refused rollback leaves its BEGIN open on this connection; end it.
    await postgres().query("ROLLBACK");
    await database().delete(academyLessonSpecs);
    await database().delete(academyLessonSources);
    await postgres().query(ROLLBACK);
    const [tables] = await postgres().query<{
      specs: string | null;
      sources: string | null;
    }>(
      "select to_regclass('public.academy_lesson_specs')::text as specs, to_regclass('public.academy_lesson_sources')::text as sources"
    );
    expect(tables).toEqual({ specs: null, sources: null });
  });
});
