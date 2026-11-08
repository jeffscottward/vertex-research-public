// Stores the Academy's database courses (courses.ts `store: "database"`) in Postgres
// (academy_lesson_sources, academy_lesson_specs), read by academy.lessons and academy.lesson.
// Usage: DATABASE_URL=postgres://... bun run vertex:academy:import [-- options]
//   --course <id>       one database course (default: every database course)
//   --kb <dir|default>  read the sources from the knowledge-base notes instead of the committed
//                       sources.generated.ts snapshot ("default": ~/Github/knowledge-bases/<kbPath>/<notes>);
//                       needs --course
//   --prune             also delete the course's stored lessons and sources the input no longer lists
//   --dry-run           validate and print what would be stored, without a database
// Input: the authored specs (scripts/academy/lessons/<course>/specs, indexed by build-lesson-index.ts)
// and the sources. Every spec must pass LessonSpecSchema and draw finite scenes, tables and captions;
// every source must pass LessonSourceSchema. Nothing is stored unless the whole course is valid; each
// course is then written in one transaction through the Academy content repository, which validates
// again (an unchanged row is left alone). Exit codes: 0 stored (or valid on --dry-run), 1 database
// failure, 2 usage or invalid input. Research and education only: nothing here places orders.
import {
  type AcademyContentRepository,
  type AcademyCourseImportResult,
  type AcademyImportCounts,
  createAcademyContentRepository,
  createNodeDatabase,
  InvalidRepositoryInputError,
  parseAcademyCourseImport,
  type ValidatedAcademyImport,
} from "@darkfactory/db/server";

import {
  COURSE_LIST,
  type CourseId,
  isCourseId,
} from "../../packages/academy/src/courses.ts";
import type { LessonSpec } from "../../packages/academy/src/schema.ts";
import { knowledgeBaseDir, readKnowledgeBaseSources } from "./build-sources.ts";
import {
  type CourseContent,
  DATABASE_COURSE_CONTENT,
} from "./lessons/index.ts";
import { sceneErrors } from "./spec-checks.ts";

export const ACADEMY_IMPORT_USAGE = [
  "Usage: DATABASE_URL=postgres://... bun run vertex:academy:import [-- --course <id>] [--kb <dir|default>] [--prune] [--dry-run]",
  `Database courses: ${COURSE_LIST.filter(
    (course) => course.store === "database"
  )
    .map((course) => course.id)
    .join(", ")}. --kb needs --course.`,
].join("\n");

export type AcademyImportIo = Readonly<{
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}>;

export type AcademyContentStore = Readonly<{
  close: () => Promise<void>;
  importCourse: AcademyContentRepository["importCourse"];
}>;

/** Test seam: opens the content store for a database URL. */
export type OpenAcademyContentStore = (
  databaseUrl: string
) => AcademyContentStore;

export const openAcademyContentStore: OpenAcademyContentStore = (
  databaseUrl
) => {
  const resource = createNodeDatabase({ connectionString: databaseUrl });
  return {
    close: () => resource.close(),
    importCourse: createAcademyContentRepository(resource.db).importCourse,
  };
};

export type AcademyImportDependencies = Readonly<{
  /** Home directory holding the default knowledge-base checkout (--kb default). */
  home: string;
  content?: Readonly<Partial<Record<CourseId, CourseContent>>>;
  openStore?: OpenAcademyContentStore;
}>;

/** A usage or input problem; the CLI exits with code 2. */
class UsageError extends Error {}

const DATABASE_COURSES: readonly CourseId[] = COURSE_LIST.filter(
  (course) => course.store === "database"
).map((course) => course.id);

/**
 * Validates one course's content with the repository's parser, then checks that every lesson draws.
 * Throws InvalidRepositoryInputError naming the problems.
 */
export const checkCourseContent = async (
  course: CourseId,
  content: CourseContent
): Promise<ValidatedAcademyImport> => {
  const parsed = await parseAcademyCourseImport({ course, ...content });
  const problems = parsed.specs.flatMap((row) =>
    sceneErrors(row.slug, row.spec as unknown as LessonSpec)
  );
  if (problems.length > 0)
    throw new InvalidRepositoryInputError(
      `academy ${course} lessons do not draw:\n${problems.slice(0, 5).join("\n")}`
    );
  return parsed;
};

const contentOf = (
  course: CourseId,
  content: Readonly<Partial<Record<CourseId, CourseContent>>>
): CourseContent => {
  const found = content[course];
  if (found === undefined)
    throw new UsageError(
      `course ${course} has no import input (scripts/academy/lessons/index.ts)`
    );
  return found;
};

/**
 * Imports the committed content of every database course (or the listed ones) through the repository,
 * after the same checks as the CLI. Used by the E2E setup to seed the test database.
 */
export const importAcademyCourses = async (
  repository: Pick<AcademyContentRepository, "importCourse">,
  {
    courses = DATABASE_COURSES,
    content = DATABASE_COURSE_CONTENT,
    prune = false,
  }: Readonly<{
    courses?: readonly CourseId[];
    content?: Readonly<Partial<Record<CourseId, CourseContent>>>;
    prune?: boolean;
  }> = {}
): Promise<AcademyCourseImportResult[]> => {
  const results: AcademyCourseImportResult[] = [];
  for (const course of courses) {
    const input = contentOf(course, content);
    await checkCourseContent(course, input);
    results.push(await repository.importCourse({ course, ...input, prune }));
  }
  return results;
};

type ImportOptions = Readonly<{
  courses: readonly CourseId[];
  kb: string | null;
  prune: boolean;
  dryRun: boolean;
}>;

const FLAGS: Readonly<Record<string, true>> = {
  "--dry-run": true,
  "--prune": true,
};
const VALUED: Readonly<Record<string, true>> = {
  "--course": true,
  "--kb": true,
};

const parseArgs = (args: readonly string[]): ImportOptions => {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const queue = [...args];
  for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
    if (FLAGS[arg] === true) flags.add(arg);
    else if (VALUED[arg] === true) {
      const value = queue.shift();
      if (value === undefined || value.startsWith("--"))
        throw new UsageError(`${arg} needs a value`);
      values.set(arg, value);
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  const course = values.get("--course");
  if (course !== undefined && !isCourseId(course))
    throw new UsageError(`unknown course "${course}"`);
  if (course !== undefined && !DATABASE_COURSES.includes(course))
    throw new UsageError(
      `course ${course} is stored in @darkfactory/academy, not in Postgres`
    );
  const kb = values.get("--kb") ?? null;
  if (kb !== null && course === undefined)
    throw new UsageError("--kb needs --course");
  return {
    courses: course === undefined ? DATABASE_COURSES : [course],
    dryRun: flags.has("--dry-run"),
    kb,
    prune: flags.has("--prune"),
  };
};

const describeCounts = (
  noun: string,
  total: number,
  counts: AcademyImportCounts
) =>
  `${total} ${noun} (${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.deleted} deleted)`;

/** The CLI: resolves to the exit code. */
export const runAcademyImport = async (
  args: readonly string[],
  io: AcademyImportIo,
  {
    home,
    content = DATABASE_COURSE_CONTENT,
    openStore = openAcademyContentStore,
  }: AcademyImportDependencies
): Promise<number> => {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout.write(`${ACADEMY_IMPORT_USAGE}\n`);
    return 0;
  }
  let store: AcademyContentStore | undefined;
  try {
    const options = parseArgs(args);
    const inputs = new Map<CourseId, CourseContent>();
    for (const course of options.courses) {
      const committed = contentOf(course, content);
      const sources =
        options.kb === null
          ? committed.sources
          : readKnowledgeBaseSources(
              course,
              options.kb === "default"
                ? knowledgeBaseDir(course, home)
                : options.kb
            );
      const input = { ...committed, sources };
      const parsed = await checkCourseContent(course, input);
      inputs.set(course, input);
      if (options.dryRun)
        io.stdout.write(
          `${course}: valid, would store ${parsed.sources.length} sources and ${parsed.specs.length} lessons${options.prune ? " and prune the rest" : ""}\n`
        );
    }
    if (options.dryRun) return 0;
    const databaseUrl = io.env["DATABASE_URL"];
    if (databaseUrl === undefined || databaseUrl.trim() === "")
      throw new UsageError("DATABASE_URL is required (or pass --dry-run)");
    store = openStore(databaseUrl);
    for (const [course, input] of inputs) {
      const result = await store.importCourse({
        course,
        ...input,
        prune: options.prune,
      });
      io.stdout.write(
        `${course}: ${describeCounts("sources", input.sources.length, result.sources)}; ${describeCounts("lessons", input.specs.length, result.specs)}\n`
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n${ACADEMY_IMPORT_USAGE}\n`);
      return 2;
    }
    if (error instanceof InvalidRepositoryInputError) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }
    io.stderr.write(
      `academy import failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  } finally {
    await store?.close();
  }
};
