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
        deleted: 0,
        unchanged: 0,
        updated: 0,
      },
      specs: { created: SPECS.length, deleted: 0, unchanged: 0, updated: 0 },
    });
    // The re-import goes straight to the repository: the draw check above already passed, and it is
    // the CPU-heavy part (about 1.4 s per run here, several times that on a CI runner).
    const again = await repository.importCourse({
      course: "quantfinancetogo",
      ...QFTG,
    });
    expect(again).toEqual({
      course: "quantfinancetogo",
      sources: {
        created: 0,
        deleted: 0,
        unchanged: SOURCES.length,
        updated: 0,
      },
      specs: { created: 0, deleted: 0, unchanged: SPECS.length, updated: 0 },
    });
    expect(await repository.countSources("quantfinancetogo")).toBe(
      SOURCES.filter((source) => source["duplicateOf"] === undefined).length
    );
    expect(await repository.countSources("dyr")).toBe(0);
    // One importer run checks that all 48 lessons draw (CPU, not database): under 2 s locally, close to
    // the 5 s default on a loaded CI runner. Vitest does not cancel a timed-out test, so its import kept
    // writing and deadlocked the rollback test below; this ceiling keeps the test whole.
  }, 30_000);

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
      source: {
        course: "quantfinancetogo",
        duplicateOf: null,
        sourceId: firstSpec.sourceId,
        transcript: sourceOf(firstSpec)["transcript"],
        url: sourceOf(firstSpec)["url"],
      },
      sourceId: firstSpec.sourceId,
      spec: { course: "quantfinancetogo", slug, sourceId: firstSpec.sourceId },
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
      deleted: SPECS.length - 2,
      unchanged: 1,
      updated: 1,
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
    // Source ids and slugs are unique across courses: an import of another course naming them is
    // refused before any write, so it never moves a row to its own course.
    await expect(
      repository.importCourse({
        course: "dyr",
        sources: [{ ...sourceOf(firstSpec), course: "dyr" }],
        specs: [],
      })
    ).rejects.toThrow(
      `academy dyr import would move rows of another course:\nsource ${firstSpec.sourceId} belongs to quantfinancetogo`
    );
    await expect(
      repository.importCourse({
        course: "dyr",
        sources: [{ ...sourceOf(firstSpec), course: "dyr" }],
        specs: [{ ...firstSpec, course: "dyr" }],
      })
    ).rejects.toThrow(
      `lesson ${String(firstSpec["slug"])} belongs to quantfinancetogo`
    );
    expect(
      (await repository.getLesson(String(firstSpec["slug"])))?.course
    ).toBe("quantfinancetogo");
    // A pruning import with nothing in it would empty the course; it is refused.
    await expect(
      repository.importCourse({
        course: "quantfinancetogo",
        prune: true,
        sources: [],
        specs: [],
      })
    ).rejects.toThrow(/refusing to empty the course/u);
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
    expect(tables).toEqual({ sources: null, specs: null });
  });
});
