import { afterEach, describe, expect, it, vi } from "vitest";

import type { Lesson, LessonSource } from "../schema.ts";
import {
  ACADEMY_LESSONS,
  ACADEMY_SOURCES,
  buildCatalog,
  lessonBySlug,
  lessonSummaries,
  loadSources,
  neighboursIn,
  sourceCounts,
  toLessonSummary,
} from "./index.ts";
import { LESSON_SPECS } from "./specs.generated.ts";

describe("lesson catalog", () => {
  afterEach(() => {
    vi.doUnmock("./specs.generated.ts");
    vi.resetModules();
  });

  it("looks lessons up by slug", () => {
    const first = ACADEMY_LESSONS[0];
    expect(first).toBeDefined();
    expect(lessonBySlug(first?.slug ?? "")).toBe(first);
    expect(lessonBySlug("no-such-lesson")).toBeNull();
  });

  it("summarises lessons with and without a backtest", () => {
    const summaries = lessonSummaries();
    expect(summaries).toHaveLength(ACADEMY_LESSONS.length);
    const strategy = ACADEMY_LESSONS.find((l) => l.backtest !== undefined);
    const concept = ACADEMY_LESSONS.find((l) => l.backtest === undefined);
    if (strategy === undefined || concept === undefined) throw new Error("x");
    expect(toLessonSummary(strategy).structure).toBe(
      strategy.backtest?.structure
    );
    expect(toLessonSummary(concept).structure).toBeNull();
  });

  it("throws when a spec has no knowledge-base source", async () => {
    const spec = { ...(LESSON_SPECS[0] as object), sourceId: "missing-src" };
    vi.resetModules();
    vi.doMock("./specs.generated.ts", () => ({ LESSON_SPECS: [spec] }));
    // Module-load boundary: the catalog validates at import time, so it must be re-imported.
    await expect(import("./index.ts")).rejects.toThrow(
      /has no source missing-src/u
    );
  });

  it("tags the sources of each course file and counts videos per course", () => {
    const qftg = ACADEMY_SOURCES.filter(
      (source) => source.course === "quantfinancetogo"
    );
    expect(qftg.length).toBeGreaterThan(0);
    expect(
      ACADEMY_SOURCES.find((s) => s.sourceId === "DTlH37JjmfZ")?.course
    ).toBe("dyr");
    const counts = sourceCounts();
    expect(counts.quantfinancetogo).toBe(qftg.length);
    // The recorded exact duplicate is not counted.
    expect(counts.dyr).toBe(
      ACADEMY_SOURCES.filter((source) => source.course === "dyr").length - 1
    );
    expect(sourceCounts([])).toEqual({ dyr: 0, quantfinancetogo: 0 });
  });

  it("carries the course onto every lesson and summary", () => {
    for (const lesson of ACADEMY_LESSONS) {
      expect(lesson.course).toBe(lesson.source.course);
      expect(toLessonSummary(lesson).course).toBe(lesson.course);
    }
  });

  it("refuses a source in the wrong course file or listed twice", () => {
    const source = { sourceId: "Dx1", url: "", caption: "", publishedAt: "" };
    expect(
      loadSources({ dyr: [source], quantfinancetogo: [] }).map((s) => s.course)
    ).toEqual(["dyr"]);
    expect(() =>
      loadSources({
        dyr: [],
        quantfinancetogo: [{ ...source, course: "dyr" }],
      })
    ).toThrow(/names course dyr/u);
    expect(() =>
      loadSources({ dyr: [source], quantfinancetogo: [source] })
    ).toThrow(/appears in two sources/u);
  });

  const lesson = ACADEMY_LESSONS[0] as Lesson;
  const spec = LESSON_SPECS[0] as Record<string, unknown>;
  const qftgSource: LessonSource = {
    ...lesson.source,
    course: "quantfinancetogo",
    sourceId: "QftgSrc01",
    publishedAt: "2020-01-01",
  };

  it("validates course, slug and source across courses and orders course first", () => {
    const own = ACADEMY_SOURCES.find((s) => s.sourceId === spec["sourceId"]);
    if (own === undefined) throw new Error("no source");
    const qftgSpec = {
      ...spec,
      course: "quantfinancetogo",
      slug: "qftg-lesson",
      sourceId: "QftgSrc01",
    };
    const catalog = buildCatalog([qftgSpec, spec], [qftgSource, own]);
    // dyr first even though the QuantFinanceToGo lesson came first.
    expect(catalog.map((entry) => entry.course)).toEqual([
      "dyr",
      "quantfinancetogo",
    ]);
    expect(() => buildCatalog([spec, spec], [own])).toThrow(/used twice/u);
    expect(() =>
      buildCatalog([{ ...qftgSpec, sourceId: own.sourceId }], [own])
    ).toThrow(/of course dyr/u);
  });

  it("links previous and next only within the lesson's course", () => {
    const entries = [
      { course: "dyr", slug: "a", title: "A" },
      { course: "dyr", slug: "b", title: "B" },
      { course: "quantfinancetogo", slug: "q1", title: "Q1" },
      { course: "quantfinancetogo", slug: "q2", title: "Q2" },
    ] as const;
    expect(neighboursIn(entries, "b")).toEqual({
      previous: { slug: "a", title: "A" },
      next: null,
    });
    expect(neighboursIn(entries, "q1")).toEqual({
      previous: null,
      next: { slug: "q2", title: "Q2" },
    });
    expect(neighboursIn(entries, "missing")).toEqual({
      previous: null,
      next: null,
    });
  });
});
