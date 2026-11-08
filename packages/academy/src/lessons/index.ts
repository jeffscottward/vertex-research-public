// What: The packaged lesson catalog: validated specs joined with their knowledge-base source
// (transcript) for the courses this package ships (courses.ts `store: "package"`: Define Your Risk).
// Database courses (QuantFinanceToGo) live in Postgres and reach the web app through academy.lessons
// and academy.lesson; their lessons use the same helpers below (buildCatalog, neighboursIn,
// toLessonSummary). Server-side only in the web app (pages pass one lesson or the summaries to client
// components).
import { COURSE_IDS, COURSES, type CourseId } from "../courses.ts";
import {
  type Lesson,
  type LessonSource,
  type LessonSpec,
  LessonSpecSchema,
  type LessonSummary,
} from "../schema.ts";
import mediaManifest from "./media-manifest.json" with { type: "json" };
import dyrSources from "./sources.json" with { type: "json" };
import { LESSON_SPECS } from "./specs.generated.ts";

/** Contents of the sources file of each course this package ships (scripts/academy/course-files.ts). */
export type SourceFiles = Readonly<
  Partial<Record<CourseId, readonly unknown[]>>
>;

const SOURCE_FILES: SourceFiles = { dyr: dyrSources };

type RawSource = Omit<LessonSource, "course"> & { course?: string };

/** Tags every source with the course of its file; refuses a mismatched course or a reused sourceId. */
export const loadSources = (files: SourceFiles): LessonSource[] => {
  const seen = new Set<string>();
  return COURSE_IDS.flatMap((course) =>
    ((files[course] ?? []) as RawSource[]).map((raw): LessonSource => {
      if (raw.course !== undefined && raw.course !== course)
        throw new Error(
          `source ${raw.sourceId} in the ${COURSES[course].title} sources names course ${raw.course}`
        );
      if (seen.has(raw.sourceId))
        throw new Error(`sourceId ${raw.sourceId} appears in two sources`);
      seen.add(raw.sourceId);
      return { ...raw, course };
    })
  );
};

/** Validates the specs and joins each with its source; course order first, newest first inside. */
export const buildCatalog = (
  specs: readonly unknown[],
  sources: readonly LessonSource[]
): Lesson[] => {
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  const slugs = new Set<string>();
  return specs
    .map((raw) => {
      const spec: LessonSpec = LessonSpecSchema.parse(raw);
      if (slugs.has(spec.slug))
        throw new Error(`lesson slug ${spec.slug} is used twice`);
      slugs.add(spec.slug);
      const source = byId.get(spec.sourceId);
      if (source === undefined)
        throw new Error(`lesson ${spec.slug} has no source ${spec.sourceId}`);
      if (source.course !== spec.course)
        throw new Error(
          `lesson ${spec.slug} (${spec.course}) uses source ${spec.sourceId} of course ${source.course}`
        );
      return { ...spec, source };
    })
    .sort(
      (a, b) =>
        COURSE_IDS.indexOf(a.course) - COURSE_IDS.indexOf(b.course) ||
        b.source.publishedAt.localeCompare(a.source.publishedAt)
    );
};

/** Every knowledge-base source of every course, including those without a lesson yet. */
export const ACADEMY_SOURCES: readonly LessonSource[] = Object.freeze(
  loadSources(SOURCE_FILES)
);

export const ACADEMY_LESSONS: readonly Lesson[] = Object.freeze(
  buildCatalog(LESSON_SPECS, ACADEMY_SOURCES)
);

const BY_SLUG: ReadonlyMap<string, Lesson> = new Map(
  ACADEMY_LESSONS.map((lesson) => [lesson.slug, lesson])
);

export const lessonBySlug = (slug: string): Lesson | null =>
  BY_SLUG.get(slug) ?? null;

export type LessonLink = Readonly<{ slug: string; title: string }>;

/** Previous and next lesson of the same course in catalog order (null past either end). */
export const neighboursIn = (
  lessons: readonly Pick<Lesson, "course" | "slug" | "title">[],
  slug: string
): Readonly<{ previous: LessonLink | null; next: LessonLink | null }> => {
  const lesson = lessons.find((entry) => entry.slug === slug);
  const course = lessons.filter((entry) => entry.course === lesson?.course);
  const index = course.findIndex((entry) => entry.slug === slug);
  const at = (offset: number): LessonLink | null => {
    const entry = index < 0 ? undefined : course[index + offset];
    return entry === undefined
      ? null
      : { slug: entry.slug, title: entry.title };
  };
  return { previous: at(-1), next: at(1) };
};

export const toLessonSummary = (lesson: Lesson): LessonSummary => ({
  course: lesson.course,
  slug: lesson.slug,
  title: lesson.title,
  summary: lesson.summary,
  kind: lesson.kind,
  tags: lesson.tags,
  sceneType: lesson.scene.type,
  structure: lesson.backtest?.structure ?? null,
  publishedAt: lesson.source.publishedAt,
});

export const lessonSummaries = (): LessonSummary[] =>
  ACADEMY_LESSONS.map(toLessonSummary);

/** Knowledge-base videos per course, not counting recorded exact duplicates. */
export const sourceCounts = (
  sources: readonly LessonSource[] = ACADEMY_SOURCES
): Record<CourseId, number> =>
  Object.fromEntries(
    COURSE_IDS.map((course) => [
      course,
      sources.filter(
        (source) => source.course === course && source.duplicateOf === undefined
      ).length,
    ])
  ) as Record<CourseId, number>;

export type AcademyMedia = Readonly<{
  video: string;
  captions: string;
  thumbnail: string;
  durationSeconds: number;
  bytes: number;
  sha256: string;
  renderedAt: string;
}>;

/** Rendered media per lesson slug (written by scripts/academy/render-videos.ts). Files live under
 * apps/web/public/academy-media and are not committed. */
export const ACADEMY_MEDIA: Readonly<Record<string, AcademyMedia>> =
  mediaManifest as Record<string, AcademyMedia>;

/** Resolve render-manifest paths against an optional externally hosted media base. */
export const withAcademyMediaBaseUrl = (
  media: AcademyMedia,
  baseUrl: string | undefined
): AcademyMedia => {
  if (baseUrl === undefined || baseUrl.trim() === "") return media;
  const base = new URL(baseUrl);
  const resolve = (path: string) =>
    new URL(path.replace(/^\/+/, ""), `${base.href.replace(/\/+$/, "")}/`).href;
  return {
    ...media,
    video: resolve(media.video),
    captions: resolve(media.captions),
    thumbnail: resolve(media.thumbnail),
  };
};
