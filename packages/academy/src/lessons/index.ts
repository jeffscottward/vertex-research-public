// What: The lesson catalog: validated specs joined with their knowledge-base source (transcript).
// Server-side only in the web app (pages pass one lesson or the summaries to client components).
import {
  type Lesson,
  type LessonSource,
  type LessonSpec,
  LessonSpecSchema,
  type LessonSummary,
} from "../schema.ts";
import mediaManifest from "./media-manifest.json" with { type: "json" };
import sources from "./sources.json" with { type: "json" };
import { LESSON_SPECS } from "./specs.generated.ts";

const SOURCES: ReadonlyMap<string, LessonSource> = new Map(
  (sources as LessonSource[]).map((source) => [source.sourceId, source])
);

const load = (): Lesson[] =>
  LESSON_SPECS.map((raw) => {
    const spec: LessonSpec = LessonSpecSchema.parse(raw);
    const source = SOURCES.get(spec.sourceId);
    if (source === undefined)
      throw new Error(`lesson ${spec.slug} has no source ${spec.sourceId}`);
    return { ...spec, source };
  }).sort((a, b) => b.source.publishedAt.localeCompare(a.source.publishedAt));

export const ACADEMY_LESSONS: readonly Lesson[] = Object.freeze(load());

const BY_SLUG: ReadonlyMap<string, Lesson> = new Map(
  ACADEMY_LESSONS.map((lesson) => [lesson.slug, lesson])
);

export const lessonBySlug = (slug: string): Lesson | null =>
  BY_SLUG.get(slug) ?? null;

export const toLessonSummary = (lesson: Lesson): LessonSummary => ({
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

/** Every knowledge-base source, including those without a lesson yet (progress reporting). */
export const ACADEMY_SOURCES: readonly LessonSource[] =
  sources as LessonSource[];

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
