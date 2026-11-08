// Regenerates packages/academy/src/lessons/specs.generated.ts (static imports of every lesson spec of
// every course) and validates every spec. Usage:
// bun scripts/academy/build-lesson-index.ts [--check | --only <slug>[,<slug>]]
// Specs of the default course (dyr) live in specs/<slug>.json; every other course in
// specs/<course specDir>/<slug>.<specFormat> with a matching `course` field: TypeScript modules that
// export `spec` (AGENTS.md rule 13: no new JSON data files). Slugs and sourceIds are unique across
// all courses.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  COURSE_LIST,
  type CourseId,
} from "../../packages/academy/src/courses.ts";

import {
  buildScene,
  buildTables,
  type LessonSpec,
  LessonSpecSchema,
  lessonVtt,
} from "../../packages/academy/src/index.ts";
import { defaultValues } from "../../packages/academy/src/position.ts";
import { SOURCES_OUTPUT } from "./course-files.ts";

interface Writer {
  write: (text: string) => unknown;
}

/** Builds the lesson's scenes, tables and captions; returns one message per problem. */
const sceneErrors = (file: string, lesson: LessonSpec): string[] => {
  const errors: string[] = [];
  try {
    const values = defaultValues(lesson.params);
    for (const t of [0, 0.5, 1]) {
      const scene = buildScene(lesson, values, t);
      for (const panel of scene.panels)
        for (const series of panel.series)
          if (
            series.points.some(
              (point) =>
                !(Number.isFinite(point[0]) && Number.isFinite(point[1]))
            )
          )
            errors.push(
              `${file}: non-finite point in ${panel.id}/${series.element} at t=${t}`
            );
      buildTables(lesson, values, t);
    }
    lessonVtt(lesson);
  } catch (error) {
    errors.push(
      `${file}: scene failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return errors;
};

type SpecFile = Readonly<{
  course: CourseId;
  /** Path below the specs folder (`<slug>.json` or `<course specDir>/<slug>.<specFormat>`). */
  file: string;
  /** Lesson slug the file name promises (file name without its extension). */
  slug: string;
  format: "json" | "ts";
}>;

/** Spec files of every course: the default course first, then each course folder (courses.ts). */
const specFiles = (dir: string): SpecFile[] =>
  COURSE_LIST.flatMap((course) => {
    const folder = join(dir, course.specDir);
    if (!existsSync(folder)) return [];
    const extension = `.${course.specFormat}`;
    return readdirSync(folder)
      .filter((name) => name.endsWith(extension))
      .sort()
      .map((name) => ({
        course: course.id,
        file: course.specDir === "" ? name : `${course.specDir}/${name}`,
        format: course.specFormat,
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

const readSpec = (dir: string, spec: SpecFile): Promise<unknown> =>
  readData(join(dir, spec.file), spec.format, "spec");

type SpecContext = Readonly<{
  dir: string;
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
  { dir, allFiles }: SpecContext
): Promise<string | undefined> => {
  for (const other of allFiles) {
    if (other.file === spec.file) continue;
    const raw = (await readSpec(dir, other)) as { sourceId?: string };
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
  const { dir, sourceCourses, seen, only, allFiles } = context;
  const parsed = LessonSpecSchema.safeParse(await readSpec(dir, spec));
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
  lessons: string,
  errors: string[]
): Promise<Map<string, CourseId>> => {
  const sourceCourses = new Map<string, CourseId>();
  for (const course of COURSE_LIST) {
    const output = SOURCES_OUTPUT[course.id];
    const path = join(lessons, output.file);
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
          `${output.file}: sourceId ${sourceId} already listed by ${SOURCES_OUTPUT[other].file}`
        );
    }
  }
  return sourceCourses;
};

/** One import line of the generated index. */
const importLine = (spec: SpecFile, index: number): string =>
  spec.format === "json"
    ? `import spec${index} from "./specs/${spec.file}" with { type: "json" };`
    : `import { spec as spec${index} } from "./specs/${spec.file}";`;

export type LessonIndexOptions = Readonly<{
  /** Repository root holding packages/academy. */
  root: string;
  stdout: Writer;
  stderr: Writer;
}>;

/** Validates the lesson specs and writes or checks the generated index; resolves to the exit code. */
export const buildLessonIndex = async (
  args: readonly string[],
  { root, stdout, stderr }: LessonIndexOptions
): Promise<number> => {
  const lessons = join(root, "packages/academy/src/lessons");
  const dir = join(lessons, "specs");
  const out = join(lessons, "specs.generated.ts");
  const errors: string[] = [];
  const sourceCourses = await readSourceCourses(lessons, errors);

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
  const allFiles = specFiles(dir);
  const files =
    only === null ? allFiles : allFiles.filter((spec) => only.has(spec.slug));
  const seen = new Map<string, string>();
  for (const spec of files)
    errors.push(
      ...(await specErrors(spec, { allFiles, dir, only, seen, sourceCourses }))
    );

  const body = [
    "// Generated by scripts/academy/build-lesson-index.ts. Do not edit by hand.",
    ...files.map(importLine),
    "",
    `export const LESSON_SPECS: readonly unknown[] = [${files.map((_, index) => `spec${index}`).join(", ")}];`,
    "",
  ].join("\n");

  if (only !== null) {
    const missing = [...only].filter(
      (name) => !files.some((spec) => spec.slug === name)
    );
    if (missing.length > 0)
      errors.push(`missing spec files: ${missing.join(", ")}`);
  } else if (args.includes("--check")) {
    const current = readFileSync(out, "utf8");
    if (current !== body)
      errors.push(
        "specs.generated.ts is stale; run bun scripts/academy/build-lesson-index.ts"
      );
  } else writeFileSync(out, body);

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
