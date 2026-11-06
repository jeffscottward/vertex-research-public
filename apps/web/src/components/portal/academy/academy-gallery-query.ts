// What: Academy gallery URL state: filters (?q=, ?type=, ?regime=, ?instrument=, ?timeframe=,
// ?chart=) and paging (?page=), plus the pure filter and page helpers the gallery renders from.
// Used by: academy-gallery.tsx; app/(portal)/academy/page.tsx (reads the request's searchParams).
import type { LessonSummary } from "@darkfactory/academy";

/** Cards per gallery page: four rows of three at desktop width. */
export const ACADEMY_PAGE_SIZE = 12;

export type AcademyGalleryFilters = Readonly<{
  search: string;
  kind: string;
  regime: string;
  instrument: string;
  timeframe: string;
  scene: string;
}>;

export type AcademyGalleryQuery = AcademyGalleryFilters &
  Readonly<{ page: number }>;

export type AcademyGalleryOptions = Readonly<{
  kind: readonly string[];
  regime: readonly string[];
  instrument: readonly string[];
  timeframe: readonly string[];
  scene: readonly string[];
}>;

export type AcademySearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export const EMPTY_ACADEMY_FILTERS: AcademyGalleryFilters = Object.freeze({
  search: "",
  kind: "",
  regime: "",
  instrument: "",
  timeframe: "",
  scene: "",
});

export const DEFAULT_ACADEMY_QUERY: AcademyGalleryQuery = Object.freeze({
  ...EMPTY_ACADEMY_FILTERS,
  page: 1,
});

/** URL parameter for each filter; the defaults ("" and page 1) stay out of the URL. */
const ACADEMY_QUERY_KEYS: Readonly<
  Record<keyof AcademyGalleryFilters | "page", string>
> = Object.freeze({
  search: "q",
  kind: "type",
  regime: "regime",
  instrument: "instrument",
  timeframe: "timeframe",
  scene: "chart",
  page: "page",
});

const FILTER_NAMES = Object.keys(
  EMPTY_ACADEMY_FILTERS
) as readonly (keyof AcademyGalleryFilters)[];

const SELECT_NAMES = [
  "kind",
  "regime",
  "instrument",
  "timeframe",
  "scene",
] as const satisfies readonly (keyof AcademyGalleryOptions)[];

const unique = (values: readonly string[]) => [...new Set(values)].sort();

/** The choices each select offers, from the lessons on hand. */
export const academyGalleryOptions = (
  lessons: readonly LessonSummary[]
): AcademyGalleryOptions => ({
  kind: ["strategy", "concept"],
  regime: unique(lessons.flatMap((lesson) => lesson.tags.regime)),
  instrument: unique(lessons.flatMap((lesson) => lesson.tags.instruments)),
  timeframe: unique(lessons.map((lesson) => lesson.tags.timeframe)),
  scene: unique(lessons.map((lesson) => lesson.sceneType)),
});

const first = (value: string | readonly string[] | undefined): string =>
  (typeof value === "string" ? value : value?.[0]) ?? "";

/** Request searchParams -> gallery query. Repeated keys use the first value; a bad page is 1. */
export const readAcademyGalleryQuery = (
  params: AcademySearchParams
): AcademyGalleryQuery => {
  const page = first(params[ACADEMY_QUERY_KEYS.page]).trim();
  return {
    search: first(params[ACADEMY_QUERY_KEYS.search]).slice(0, 120),
    kind: first(params[ACADEMY_QUERY_KEYS.kind]).trim(),
    regime: first(params[ACADEMY_QUERY_KEYS.regime]).trim(),
    instrument: first(params[ACADEMY_QUERY_KEYS.instrument]).trim(),
    timeframe: first(params[ACADEMY_QUERY_KEYS.timeframe]).trim(),
    scene: first(params[ACADEMY_QUERY_KEYS.scene]).trim(),
    page: /^[1-9]\d{0,3}$/u.test(page) ? Number(page) : 1,
  };
};

/** Drops a select value no lesson carries, so a stale link shows "All" rather than nothing. */
export const sanitizeAcademyGalleryQuery = (
  query: AcademyGalleryQuery,
  options: AcademyGalleryOptions
): AcademyGalleryQuery => {
  const next: Record<string, string | number> = { ...query };
  for (const name of SELECT_NAMES)
    if (!options[name].includes(query[name])) next[name] = "";
  return next as AcademyGalleryQuery;
};

/** Lessons matching every set filter; search covers title, summary and topics, ignoring case. */
export const filterAcademyLessons = (
  lessons: readonly LessonSummary[],
  filters: AcademyGalleryFilters
): readonly LessonSummary[] => {
  const query = filters.search.trim().toLowerCase();
  return lessons.filter(
    (lesson) =>
      (filters.kind === "" || lesson.kind === filters.kind) &&
      (filters.regime === "" ||
        lesson.tags.regime.includes(filters.regime as never)) &&
      (filters.instrument === "" ||
        lesson.tags.instruments.includes(filters.instrument as never)) &&
      (filters.timeframe === "" ||
        lesson.tags.timeframe === filters.timeframe) &&
      (filters.scene === "" || lesson.sceneType === filters.scene) &&
      (query === "" ||
        `${lesson.title} ${lesson.summary} ${lesson.tags.topics.join(" ")}`
          .toLowerCase()
          .includes(query))
  );
};

export type AcademyGalleryPage<Item> = Readonly<{
  items: readonly Item[];
  /** The page shown: the requested one clamped to 1..pageCount. */
  page: number;
  pageCount: number;
  /** 1-based position of the first and last item shown (0 and 0 when empty). */
  from: number;
  to: number;
}>;

export const pageAcademyLessons = <Item>(
  items: readonly Item[],
  page: number,
  size: number = ACADEMY_PAGE_SIZE
): AcademyGalleryPage<Item> => {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(Math.trunc(page), 1), pageCount);
  const start = (current - 1) * size;
  const shown = items.slice(start, start + size);
  return {
    items: shown,
    page: current,
    pageCount,
    from: shown.length === 0 ? 0 : start + 1,
    to: start + shown.length,
  };
};

/**
 * The address for a query: other parameters and the hash are kept, the gallery's own keys are
 * set only when they differ from the default (blank filter, page 1).
 */
export const academyGalleryUrl = (
  query: AcademyGalleryQuery,
  location: Readonly<{ pathname: string; search: string; hash: string }>
): string => {
  const params = new URLSearchParams(location.search);
  for (const name of FILTER_NAMES) {
    const key = ACADEMY_QUERY_KEYS[name];
    params.delete(key);
    if (query[name].trim() !== "") params.set(key, query[name]);
  }
  params.delete(ACADEMY_QUERY_KEYS.page);
  if (query.page > 1) params.set(ACADEMY_QUERY_KEYS.page, String(query.page));
  const search = params.toString();
  return `${location.pathname}${search === "" ? "" : `?${search}`}${location.hash}`;
};
