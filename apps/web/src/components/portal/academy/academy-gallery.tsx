"use client";

import {
  COURSES,
  type Course,
  type CourseId,
  DEFAULT_COURSE_ID,
  type LessonSummary,
} from "@darkfactory/academy";
import { PageHeader, Panel, StatusBadge } from "@darkfactory/ui";
import {
  ChartArea,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Search,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  type AcademyGalleryFilters,
  type AcademyGalleryQuery,
  academyGalleryOptions,
  academyGalleryUrl,
  DEFAULT_ACADEMY_QUERY,
  filterAcademyLessons,
  pageAcademyLessons,
  sanitizeAcademyGalleryQuery,
} from "./academy-gallery-query.ts";
import { AcademyThemeScope, AcademyThemeToggle } from "./academy-theme.tsx";
import { labelOf } from "./labels.ts";

export type AcademyMediaEntry = Readonly<{
  video: string;
  captions: string;
  thumbnail: string;
  durationSeconds: number;
}>;

type Media = Readonly<Record<string, AcademyMediaEntry>>;

export type AcademyGalleryProps = Readonly<{
  lessons: readonly LessonSummary[];
  media: Media;
  sourceCount: number;
  /** Filters and page from the request URL (?q=&type=&regime=&instrument=&timeframe=&chart=&page=). */
  initialQuery?: AcademyGalleryQuery;
  /** Course of the listed lessons (courses.ts); defaults to dyr. */
  course?: CourseId;
}>;

const CONTROL =
  "min-h-11 w-full rounded-md border border-border bg-background text-foreground text-sm";
const BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-1 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

const Select = ({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) => (
  <label
    className="flex min-w-0 flex-col gap-1 text-muted-foreground text-xs"
    htmlFor={id}
  >
    {label}
    <select
      className={`${CONTROL} px-2`}
      id={id}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      <option value="">All</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {labelOf(option)}
        </option>
      ))}
    </select>
  </label>
);

/** Lesson and video counts of one course; all copy comes from the course registry. */
const courseDescription = (
  course: Course,
  lessons: readonly LessonSummary[],
  sourceCount: number
) => {
  const strategies = lessons.filter(
    (lesson) => lesson.kind === "strategy"
  ).length;
  return (
    <>
      {lessons.length} lessons from {sourceCount} {course.creator} videos (
      {strategies} tradeable strategies, {lessons.length - strategies} concept
      lessons).{" "}
      {course.narrated
        ? "Each lesson has a chart video with color-coded captions and an interactive example;"
        : "Each lesson has an animated chart, an interactive example and a link to the source reel;"}{" "}
      strategy lessons add a modeled backtest and a paper deployment request
      that respects the master-rule gates.
    </>
  );
};

type CourseLessonsProps = Readonly<{
  course: Course;
  lessons: readonly LessonSummary[];
  media: Media;
  sourceCount: number;
  initialQuery: AcademyGalleryQuery;
  /** Panel heading ("Lessons" on a course page, the course title on /academy). */
  title: string;
  /** Mirror filters and page in the address bar (one gallery per page does). */
  syncUrl: boolean;
}>;

/** One course's lessons: filters, cards, pager and the course disclaimer. */
const CourseLessons = ({
  course,
  lessons,
  media,
  sourceCount,
  initialQuery,
  title,
  syncUrl,
}: CourseLessonsProps) => {
  // Control ids stay unique when several courses share the /academy page.
  const prefix =
    course.id === DEFAULT_COURSE_ID ? "academy" : `academy-${course.id}`;
  const options = useMemo(() => academyGalleryOptions(lessons), [lessons]);
  const [query, setQuery] = useState(() =>
    sanitizeAcademyGalleryQuery(initialQuery, options)
  );
  const panel = useRef<HTMLElement>(null);
  // Any filter change starts again from the first page.
  const set = (key: keyof AcademyGalleryFilters) => (value: string) =>
    setQuery((current) => ({ ...current, [key]: value, page: 1 }));
  const goTo = (page: number) => {
    setQuery((current) => ({ ...current, page }));
    panel.current?.scrollIntoView({ block: "start" });
  };
  // Keeps the filters and page in the address bar so a filtered view can be linked and restored.
  useEffect(() => {
    if (!syncUrl) return;
    const url = academyGalleryUrl(query, window.location);
    const { pathname, search, hash } = window.location;
    if (url !== `${pathname}${search}${hash}`)
      window.history.replaceState(window.history.state, "", url);
  }, [query, syncUrl]);
  const matching = useMemo(
    () => filterAcademyLessons(lessons, query),
    [query, lessons]
  );
  const shown = pageAcademyLessons(matching, query.page);
  return (
    <>
      <Panel
        className="scroll-mt-20"
        data-academy-course={course.id}
        description={courseDescription(course, lessons, sourceCount)}
        flush
        headingId={`${prefix}-lessons-title`}
        id={`course-${course.id}`}
        ref={panel}
        title={title}
      >
        <div
          aria-label="Filter lessons"
          className="grid grid-cols-2 items-end gap-3 border-border border-b p-4 sm:grid-cols-3 lg:grid-cols-[minmax(13rem,2fr)_repeat(5,minmax(0,1fr))_auto]"
          role="search"
        >
          <label
            className="col-span-2 flex min-w-0 flex-col gap-1 text-muted-foreground text-xs sm:col-span-3 lg:col-span-1"
            htmlFor={`${prefix}-search`}
          >
            Search
            <span className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-3.5 left-2 size-4"
              />
              <input
                className={`${CONTROL} pr-2 pl-8`}
                id={`${prefix}-search`}
                onChange={(event) => set("search")(event.target.value)}
                placeholder="Covered call, gamma, IV..."
                type="search"
                value={query.search}
              />
            </span>
          </label>
          <Select
            id={`${prefix}-kind`}
            label="Lesson type"
            onChange={set("kind")}
            options={options.kind}
            value={query.kind}
          />
          <Select
            id={`${prefix}-regime`}
            label="Market regime"
            onChange={set("regime")}
            options={options.regime}
            value={query.regime}
          />
          <Select
            id={`${prefix}-instrument`}
            label="Instrument"
            onChange={set("instrument")}
            options={options.instrument}
            value={query.instrument}
          />
          <Select
            id={`${prefix}-timeframe`}
            label="Timeframe"
            onChange={set("timeframe")}
            options={options.timeframe}
            value={query.timeframe}
          />
          <Select
            id={`${prefix}-scene`}
            label="Chart"
            onChange={set("scene")}
            options={options.scene}
            value={query.scene}
          />
          <button
            className={BUTTON}
            onClick={() => setQuery(DEFAULT_ACADEMY_QUERY)}
            type="button"
          >
            Clear
          </button>
        </div>
        <div className="flex flex-col gap-4 p-4">
          <p aria-live="polite" className="text-muted-foreground text-sm">
            Showing {matching.length} of {lessons.length} lessons
            {shown.pageCount > 1
              ? ` · ${shown.from}–${shown.to} on this page`
              : ""}
          </p>
          <ul
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
            data-academy-cards
          >
            {shown.items.map((lesson) => {
              const entry = media[lesson.slug];
              return (
                <li key={lesson.slug}>
                  <Link
                    className="group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-ring"
                    data-lesson-card={lesson.slug}
                    href={`/academy/${lesson.slug}`}
                    prefetch={false}
                  >
                    <span className="relative block aspect-video w-full bg-muted">
                      {entry === undefined ? (
                        <span className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
                          <ChartArea aria-hidden className="size-5" />{" "}
                          {labelOf(lesson.sceneType)} chart
                        </span>
                      ) : (
                        <img
                          alt=""
                          className="h-full w-full object-cover"
                          height={360}
                          loading="lazy"
                          src={entry.thumbnail}
                          width={640}
                        />
                      )}
                      <span
                        className={`absolute top-2 left-2 rounded px-2 py-0.5 font-medium text-xs ${lesson.kind === "strategy" ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}
                      >
                        {lesson.kind === "strategy" ? "Strategy" : "Concept"}
                      </span>
                      {entry === undefined ? null : (
                        <span className="absolute right-2 bottom-2 rounded bg-black/70 px-1.5 py-0.5 text-white text-xs">
                          {Math.round(entry.durationSeconds)} s
                        </span>
                      )}
                    </span>
                    <span className="flex flex-1 flex-col gap-2 p-3">
                      <span className="font-heading font-semibold text-base leading-snug group-hover:underline">
                        {lesson.title}
                      </span>
                      <span className="line-clamp-3 text-muted-foreground text-sm">
                        {lesson.summary}
                      </span>
                      <span className="mt-auto flex flex-wrap gap-1 pt-1">
                        {[
                          ...lesson.tags.regime,
                          ...lesson.tags.instruments.slice(0, 3),
                          lesson.tags.timeframe,
                        ].map((tag) => (
                          <span
                            className="rounded border border-border px-1.5 py-0.5 text-muted-foreground text-xs"
                            key={tag}
                          >
                            {labelOf(tag)}
                          </span>
                        ))}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {matching.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No lesson matches these filters.
            </p>
          ) : null}
        </div>
        {shown.pageCount > 1 ? (
          <nav
            aria-label="Lesson pages"
            className="flex flex-wrap items-center justify-between gap-3 border-border border-t p-4 text-sm"
            data-academy-pager
          >
            <button
              className={BUTTON}
              disabled={shown.page === 1}
              onClick={() => goTo(shown.page - 1)}
              type="button"
            >
              <ChevronLeft aria-hidden className="size-4" /> Previous
            </button>
            <span className="text-muted-foreground tabular-nums">
              Page {shown.page} of {shown.pageCount}
            </span>
            <button
              className={BUTTON}
              disabled={shown.page === shown.pageCount}
              onClick={() => goTo(shown.page + 1)}
              type="button"
            >
              Next <ChevronRight aria-hidden className="size-4" />
            </button>
          </nav>
        ) : null}
      </Panel>
      <p className="text-muted-foreground text-xs">{course.disclaimer}</p>
    </>
  );
};

/** One course's gallery: /academy/c/<course> (the default course also lists on /academy). */
export const AcademyGallery = ({
  lessons,
  media,
  sourceCount,
  initialQuery = DEFAULT_ACADEMY_QUERY,
  course: courseId = DEFAULT_COURSE_ID,
}: AcademyGalleryProps) => {
  const course = COURSES[courseId];
  return (
    <AcademyThemeScope>
      <div
        className="mx-auto flex max-w-7xl flex-col gap-6"
        data-academy-gallery={course.id}
      >
        <PageHeader
          actions={<AcademyThemeToggle />}
          description={course.tagline}
          status={
            <StatusBadge data-academy-count status="neutral">
              {lessons.length} lessons
            </StatusBadge>
          }
          title="Academy"
        />
        <CourseLessons
          course={course}
          initialQuery={initialQuery}
          lessons={lessons}
          media={media}
          sourceCount={sourceCount}
          syncUrl
          title="Lessons"
        />
      </div>
    </AcademyThemeScope>
  );
};

export type AcademyCourseListing = Readonly<{
  course: CourseId;
  lessons: readonly LessonSummary[];
  sourceCount: number;
}>;

export type AcademyCatalogProps = Readonly<{
  courses: readonly AcademyCourseListing[];
  media: Media;
  /** URL filters of the default course's gallery (old /academy?q=... links keep working). */
  initialQuery?: AcademyGalleryQuery;
}>;

/** /academy: a course picker, then each course's lessons grouped under its own panel. */
export const AcademyCatalog = ({
  courses,
  media,
  initialQuery = DEFAULT_ACADEMY_QUERY,
}: AcademyCatalogProps) => (
  <AcademyThemeScope>
    <div
      className="mx-auto flex max-w-7xl flex-col gap-6"
      data-academy-catalog
      data-academy-gallery
    >
      <PageHeader
        actions={<AcademyThemeToggle />}
        description={`Lessons from ${courses.length} creator courses: chart, interactive example, transcript`}
        status={
          <StatusBadge data-academy-count status="neutral">
            {courses.reduce(
              (total, listing) => total + listing.lessons.length,
              0
            )}{" "}
            lessons
          </StatusBadge>
        }
        title="Academy"
      />
      <Panel headingId="academy-courses-title" title="Courses">
        <ul
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          data-academy-courses
        >
          {courses.map((listing) => {
            const course = COURSES[listing.course];
            return (
              <li
                className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
                data-course-card={course.id}
                key={course.id}
              >
                <Link
                  className="font-heading font-semibold text-lg underline-offset-4 hover:underline"
                  href={`/academy/c/${course.id}`}
                  prefetch={false}
                >
                  {course.title}
                </Link>
                <span className="text-muted-foreground text-sm">
                  {course.tagline}
                </span>
                <span className="text-muted-foreground text-sm">
                  {listing.lessons.length} lessons · {listing.sourceCount}{" "}
                  {course.creator} videos ·{" "}
                  {course.narrated
                    ? "narrated chart videos"
                    : "live animations"}
                </span>
                <span className="flex flex-wrap gap-3 text-sm">
                  <a
                    className="inline-flex min-h-11 items-center underline"
                    href={`#course-${course.id}`}
                  >
                    Lessons below
                  </a>
                  <a
                    className="inline-flex min-h-11 items-center gap-1 underline"
                    href={course.profileUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {course.creator} on Instagram{" "}
                    <ExternalLink aria-hidden className="size-3" />
                  </a>
                </span>
              </li>
            );
          })}
        </ul>
      </Panel>
      {courses.map((listing) => {
        const course = COURSES[listing.course];
        return listing.lessons.length === 0 ? (
          <Panel
            data-academy-course={course.id}
            description={courseDescription(
              course,
              listing.lessons,
              listing.sourceCount
            )}
            headingId={`academy-${course.id}-lessons-title`}
            id={`course-${course.id}`}
            key={course.id}
            title={course.title}
          >
            <p className="text-muted-foreground text-sm" data-course-empty>
              No lessons yet: {listing.sourceCount} {course.creator} videos are
              in the knowledge base.
            </p>
          </Panel>
        ) : (
          <CourseLessons
            course={course}
            initialQuery={
              course.id === DEFAULT_COURSE_ID
                ? initialQuery
                : DEFAULT_ACADEMY_QUERY
            }
            key={course.id}
            lessons={listing.lessons}
            media={media}
            sourceCount={listing.sourceCount}
            syncUrl={course.id === DEFAULT_COURSE_ID}
            title={course.title}
          />
        );
      })}
    </div>
  </AcademyThemeScope>
);
