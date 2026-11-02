import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACADEMY_LESSONS,
  lessonBySlug,
  lessonSummaries,
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
});
