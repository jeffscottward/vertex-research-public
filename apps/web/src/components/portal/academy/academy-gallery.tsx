"use client";

import type { LessonSummary } from "@darkfactory/academy";
import { ChartArea, GraduationCap, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

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
}>;

type Filters = Readonly<{
  search: string;
  kind: string;
  regime: string;
  instrument: string;
  timeframe: string;
  scene: string;
}>;

const EMPTY: Filters = {
  search: "",
  kind: "",
  regime: "",
  instrument: "",
  timeframe: "",
  scene: "",
};

const unique = (values: readonly string[]) => [...new Set(values)].sort();

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
    className="flex min-w-36 flex-1 flex-col gap-1 text-muted-foreground text-xs"
    htmlFor={id}
  >
    {label}
    <select
      className="min-h-11 rounded-md border border-border bg-background px-2 text-foreground text-sm"
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
}: AcademyGalleryProps) => {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const set = (key: keyof Filters) => (value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const options = useMemo(
    () => ({
      regime: unique(lessons.flatMap((lesson) => lesson.tags.regime)),
      instrument: unique(lessons.flatMap((lesson) => lesson.tags.instruments)),
      timeframe: unique(lessons.map((lesson) => lesson.tags.timeframe)),
      scene: unique(lessons.map((lesson) => lesson.sceneType)),
    }),
    [lessons]
  );
  const visible = useMemo(() => {
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
  }, [filters, lessons]);
  const strategies = lessons.filter(
    (lesson) => lesson.kind === "strategy"
  ).length;
  return (
    <AcademyThemeScope>
      <div
        className="mx-auto flex max-w-7xl flex-col gap-6"
        data-academy-gallery
      >
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <h1 className="flex items-center gap-2 font-heading font-semibold text-2xl sm:text-3xl">
              <GraduationCap aria-hidden className="size-6" /> Academy
            </h1>
            <p className="text-muted-foreground text-sm">
              Define Your Risk options lessons: video, interactive chart,
              backtest
            </p>
            <p className="max-w-3xl text-muted-foreground text-sm">
              {lessons.length} lessons from {sourceCount} Define Your Risk
              videos ({strategies} tradeable strategies,{" "}
              {lessons.length - strategies} concept lessons). Each lesson has a
              chart video with color-coded captions and an interactive example.
              Strategy lessons add a modeled backtest and a paper deployment
              request that respects the master-rule gates.
            </p>
          </div>
          <AcademyThemeToggle />
        </header>
        <section
          aria-label="Filter lessons"
          className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3"
        >
          <label
            className="flex min-w-56 flex-[2] flex-col gap-1 text-muted-foreground text-xs"
            htmlFor="academy-search"
          >
            Search
            <span className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-3.5 left-2 size-4"
              />
              <input
                className="min-h-11 w-full rounded-md border border-border bg-background pr-2 pl-8 text-foreground text-sm"
                id="academy-search"
                onChange={(event) => set("search")(event.target.value)}
                placeholder="Covered call, gamma, IV..."
                type="search"
                value={filters.search}
              />
            </span>
          </label>
          <Select
            id="academy-kind"
            label="Lesson type"
            onChange={set("kind")}
            options={["strategy", "concept"]}
            value={filters.kind}
          />
          <Select
            id="academy-regime"
            label="Market regime"
            onChange={set("regime")}
            options={options.regime}
            value={filters.regime}
          />
          <Select
            id="academy-instrument"
            label="Instrument"
            onChange={set("instrument")}
            options={options.instrument}
            value={filters.instrument}
          />
          <Select
            id="academy-timeframe"
            label="Timeframe"
            onChange={set("timeframe")}
            options={options.timeframe}
            value={filters.timeframe}
          />
          <Select
            id="academy-scene"
            label="Chart"
            onChange={set("scene")}
            options={options.scene}
            value={filters.scene}
          />
          <button
            className="min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted"
            onClick={() => setFilters(EMPTY)}
            type="button"
          >
            Clear
          </button>
        </section>
        <p aria-live="polite" className="text-muted-foreground text-sm">
          Showing {visible.length} of {lessons.length} lessons
        </p>
        <ul
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-academy-cards
        >
          {visible.map((lesson) => {
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
        {visible.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No lesson matches these filters.
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">{LABELS.disclaimer}</p>
      </div>
    </AcademyThemeScope>
  );
};
