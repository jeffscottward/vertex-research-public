"use client";

import type { LessonSummary } from "@darkfactory/academy";
import { PageHeader, Panel, StatusBadge } from "@darkfactory/ui";
import { ChartArea, ChevronLeft, ChevronRight, Search } from "lucide-react";
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
import { LABELS, labelOf } from "./labels.ts";

export type AcademyMediaEntry = Readonly<{
  video: string;
  captions: string;
  thumbnail: string;
  durationSeconds: number;
}>;

export type AcademyGalleryProps = Readonly<{
  lessons: readonly LessonSummary[];
  media: Readonly<Record<string, AcademyMediaEntry>>;
  sourceCount: number;
  /** Filters and page from the request URL (?q=&type=&regime=&instrument=&timeframe=&chart=&page=). */
  initialQuery?: AcademyGalleryQuery;
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

export const AcademyGallery = ({
  lessons,
  media,
  sourceCount,
  initialQuery = DEFAULT_ACADEMY_QUERY,
}: AcademyGalleryProps) => {
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
    const url = academyGalleryUrl(query, window.location);
    const { pathname, search, hash } = window.location;
    if (url !== `${pathname}${search}${hash}`)
      window.history.replaceState(window.history.state, "", url);
  }, [query]);
  const matching = useMemo(
    () => filterAcademyLessons(lessons, query),
    [query, lessons]
  );
  const shown = pageAcademyLessons(matching, query.page);
  const strategies = lessons.filter(
    (lesson) => lesson.kind === "strategy"
  ).length;
  return (
    <AcademyThemeScope>
      <div
        className="mx-auto flex max-w-7xl flex-col gap-6"
        data-academy-gallery
      >
        <PageHeader
          actions={<AcademyThemeToggle />}
          description="Define Your Risk options lessons: video, interactive chart, backtest"
          status={
            <StatusBadge data-academy-count status="neutral">
              {lessons.length} lessons
            </StatusBadge>
          }
          title="Academy"
        />
        <Panel
          className="scroll-mt-20"
          description={
            <>
              {lessons.length} lessons from {sourceCount} Define Your Risk
              videos ({strategies} tradeable strategies,{" "}
              {lessons.length - strategies} concept lessons). Each lesson has a
              chart video with color-coded captions and an interactive example;
              strategy lessons add a modeled backtest and a paper deployment
              request that respects the master-rule gates.
            </>
          }
          flush
          headingId="academy-lessons-title"
          ref={panel}
          title="Lessons"
        >
          <div
            aria-label="Filter lessons"
            className="grid grid-cols-2 items-end gap-3 border-border border-b p-4 sm:grid-cols-3 lg:grid-cols-[minmax(13rem,2fr)_repeat(5,minmax(0,1fr))_auto]"
            role="search"
          >
            <label
              className="col-span-2 flex min-w-0 flex-col gap-1 text-muted-foreground text-xs sm:col-span-3 lg:col-span-1"
              htmlFor="academy-search"
            >
              Search
              <span className="relative">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-3.5 left-2 size-4"
                />
                <input
                  className={`${CONTROL} pr-2 pl-8`}
                  id="academy-search"
                  onChange={(event) => set("search")(event.target.value)}
                  placeholder="Covered call, gamma, IV..."
                  type="search"
                  value={query.search}
                />
              </span>
            </label>
            <Select
              id="academy-kind"
              label="Lesson type"
              onChange={set("kind")}
              options={options.kind}
              value={query.kind}
            />
            <Select
              id="academy-regime"
              label="Market regime"
              onChange={set("regime")}
              options={options.regime}
              value={query.regime}
            />
            <Select
              id="academy-instrument"
              label="Instrument"
              onChange={set("instrument")}
              options={options.instrument}
              value={query.instrument}
            />
            <Select
              id="academy-timeframe"
              label="Timeframe"
              onChange={set("timeframe")}
              options={options.timeframe}
              value={query.timeframe}
            />
            <Select
              id="academy-scene"
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
        <p className="text-muted-foreground text-xs">{LABELS.disclaimer}</p>
      </div>
    </AcademyThemeScope>
  );
};
