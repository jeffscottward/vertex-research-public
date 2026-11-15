// Regenerates each course's spec index (specs.generated.ts beside its specs folder: static imports of
// every lesson spec) and validates every spec of every course. Usage:
// bun scripts/academy/build-lesson-index.ts [--check | --only <slug>[,<slug>]]
// Specs live in the course's specDir (courses.ts) as <slug>.<specFormat> with a matching `course`
// field. Define Your Risk (store "package"): JSON files in packages/academy/src/lessons/specs, indexed
// into the package. Database courses: TypeScript modules exporting `spec` under
// scripts/academy/lessons/<course>/specs (AGENTS.md rule 13: no new JSON data files), indexed for the
// import CLI (`bun run vertex:academy:import`) only. Slugs and sourceIds are unique across all courses.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  COURSE_LIST,
  type CourseId,
} from "../../packages/academy/src/courses.ts";
import { LessonSpecSchema } from "../../packages/academy/src/index.ts";
import { SOURCE_ID_FILES, specIndexPath } from "./course-files.ts";
import { sceneErrors } from "./spec-checks.ts";

interface Writer {
  write: (text: string) => unknown;
}

type SpecFile = Readonly<{
  course: CourseId;
  /** Label in messages: `<slug>.json` (package course) or `<course>/<slug>.<specFormat>`. */
  file: string;
  /** File name inside the course's specs folder. */
  name: string;
  /** Absolute path of the file. */
  path: string;
  /** Lesson slug the file name promises (file name without its extension). */
  slug: string;
  format: "json" | "ts";
}>;

/** Spec files of every course: the default course first, then each course folder (courses.ts). */
const specFiles = (root: string): SpecFile[] =>
  COURSE_LIST.flatMap((course) => {
    const folder = join(root, course.specDir);
    if (!existsSync(folder)) return [];
    const extension = `.${course.specFormat}`;
    return readdirSync(folder)
      .filter((name) => name.endsWith(extension))
      .sort()
      .map((name) => ({
        course: course.id,
        file: course.store === "package" ? name : `${course.id}/${name}`,
        format: course.specFormat,
        name,
        path: join(folder, name),
        slug: name.slice(0, -extension.length),
      }));
  });

/** Raw contents of a JSON file or the named export of a TypeScript module. */
const readData = async (
  path: string,
  format: "json" | "ts",
  name: string
): Promise<unknown> =>
  format === "json"
    ? (JSON.parse(readFileSync(path, "utf8")) as unknown)
    : ((await import(pathToFileURL(path).href)) as Record<string, unknown>)[
        name
      ];

const readSpec = (spec: SpecFile): Promise<unknown> =>
  readData(spec.path, spec.format, "spec");

type SpecContext = Readonly<{
  /** sourceId → course of the sources file that lists it. */
  sourceCourses: ReadonlyMap<string, CourseId>;
  /** sourceId → first file that used it; updated as specs are checked. */
  seen: Map<string, string>;
  /** Files selected with --only, or null when every spec is checked. */
  only: ReadonlySet<string> | null;
  allFiles: readonly SpecFile[];
}>;

/** First other spec file that uses the sourceId (reads the files that were not checked). */
const otherUser = async (
  sourceId: string,
  spec: SpecFile,
  { allFiles }: SpecContext
): Promise<string | undefined> => {
  for (const other of allFiles) {
    if (other.file === spec.file) continue;
    const raw = (await readSpec(other)) as { sourceId?: string };
    if (raw.sourceId === sourceId) return other.file;
  }
  return undefined;
};

/** Validates one spec file; returns one message per problem. */
const specErrors = async (
  spec: SpecFile,
  context: SpecContext
): Promise<string[]> => {
  const { course, file, slug } = spec;
  const { sourceCourses, seen, only, allFiles } = context;
  const parsed = LessonSpecSchema.safeParse(await readSpec(spec));
  if (!parsed.success)
    return [
      `${file}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
    ];
  const errors: string[] = [];
  const lesson = parsed.data;
  if (lesson.slug !== slug)
    errors.push(`${file}: slug ${lesson.slug} must match the file name`);
  const twin = allFiles.find(
    (other) => other.file !== file && other.slug === slug
  );
  if (twin !== undefined)
    errors.push(`${file}: slug ${slug} also used by ${twin.file}`);
  if (lesson.course !== course)
    errors.push(
      `${file}: course ${lesson.course} does not match its folder (course ${course})`
    );
  const sourceCourse = sourceCourses.get(lesson.sourceId);
  if (sourceCourse === undefined)
    errors.push(`${file}: unknown sourceId ${lesson.sourceId}`);
  else if (sourceCourse !== lesson.course)
    errors.push(
      `${file}: sourceId ${lesson.sourceId} is a ${sourceCourse} source, not ${lesson.course}`
    );
  const previous =
    seen.get(lesson.sourceId) ??
    (only === null
      ? undefined
      : await otherUser(lesson.sourceId, spec, context));
  if (previous !== undefined)
    errors.push(
      `${file}: sourceId ${lesson.sourceId} already used by ${previous}`
    );
  seen.set(lesson.sourceId, file);
  return [...errors, ...sceneErrors(file, lesson)];
};

/** sourceId → course of every sources file present; a sourceId listed twice is an error. */
const readSourceCourses = async (
  root: string,
  errors: string[]
): Promise<Map<string, CourseId>> => {
  const sourceCourses = new Map<string, CourseId>();
  for (const course of COURSE_LIST) {
    const output = SOURCE_ID_FILES[course.id];
    const path = join(root, output.path);
    const sources = existsSync(path)
      ? ((await readData(path, output.format, "SOURCES")) as {
          sourceId: string;
        }[])
      : [];
    for (const { sourceId } of sources) {
      const other = sourceCourses.get(sourceId);
      if (other === undefined) sourceCourses.set(sourceId, course.id);
      else
        errors.push(
          `${output.path}: sourceId ${sourceId} already listed by ${SOURCE_ID_FILES[other].path}`
        );
    }
  }
  return sourceCourses;
};

/** One import line of a generated index (the index sits beside the specs folder). */
const importLine = (spec: SpecFile, index: number): string =>
  spec.format === "json"
    ? `import spec${index} from "./specs/${spec.name}" with { type: "json" };`
    : `import { spec as spec${index} } from "./specs/${spec.name}";`;

/** Contents of one course's generated spec index. */
const indexBody = (files: readonly SpecFile[]): string =>
  [
    "// Generated by scripts/academy/build-lesson-index.ts. Do not edit by hand.",
    ...files.map(importLine),
    "",
    `export const LESSON_SPECS: readonly unknown[] = [${files.map((_, index) => `spec${index}`).join(", ")}];`,
    "",
  ].join("\n");

export type LessonIndexOptions = Readonly<{
  /** Repository root holding packages/academy and scripts/academy. */
  root: string;
  stdout: Writer;
  stderr: Writer;
}>;

/** Validates the lesson specs and writes or checks the generated indexes; resolves to the exit code. */
export const buildLessonIndex = async (
  args: readonly string[],
  { root, stdout, stderr }: LessonIndexOptions
): Promise<number> => {
  const errors: string[] = [];
  const sourceCourses = await readSourceCourses(root, errors);

  // --only a,b.json,c.ts validates just those slugs and writes nothing (safe for parallel authors).
  const onlyIndex = args.indexOf("--only");
  const only =
    onlyIndex >= 0
      ? new Set(
          (args[onlyIndex + 1] ?? "")
            .split(",")
            .map((name) => name.replace(/\.(?:json|ts)$/u, ""))
        )
      : null;
  const allFiles = specFiles(root);
  const files =
    only === null ? allFiles : allFiles.filter((spec) => only.has(spec.slug));
  const seen = new Map<string, string>();
  for (const spec of files)
    errors.push(
      ...(await specErrors(spec, { allFiles, only, seen, sourceCourses }))
    );

  if (only === null)
    // One index per course whose specs folder exists.
    for (const course of COURSE_LIST) {
      if (!existsSync(join(root, course.specDir))) continue;
      const index = specIndexPath(course.id);
      const out = join(root, index);
      const body = indexBody(files.filter((spec) => spec.course === course.id));
      if (!args.includes("--check")) writeFileSync(out, body);
      else if (!existsSync(out) || readFileSync(out, "utf8") !== body)
        errors.push(
          `${index} is stale; run bun scripts/academy/build-lesson-index.ts`
        );
    }
  else {
    const missing = [...only].filter(
      (name) => !files.some((spec) => spec.slug === name)
    );
    if (missing.length > 0)
      errors.push(`missing spec files: ${missing.join(", ")}`);
  }

  if (errors.length > 0) {
    stderr.write(`${errors.join("\n")}\n`);
    return 1;
  }
  stdout.write(`${files.length} lesson specs valid\n`);
  return 0;
};

export type LessonIndexEntrypoint = Readonly<{
  isMain: boolean | undefined;
  argv: readonly string[];
  options: LessonIndexOptions;
  exitState: { exitCode?: number | string | null | undefined };
}>;

/** CLI entry: runs only when this module is the process entry point. */
export const runLessonIndexEntrypoint = async ({
  isMain,
  argv,
  options,
  exitState,
}: LessonIndexEntrypoint): Promise<void> => {
  if (!isMain) return;
  exitState.exitCode = await buildLessonIndex(argv.slice(2), options);
};

await runLessonIndexEntrypoint({
  argv: process.argv,
  exitState: process,
  isMain: import.meta.main,
  options: {
    root: resolve(import.meta.dirname, "../.."),
    stderr: process.stderr,
    stdout: process.stdout,
  },
});
