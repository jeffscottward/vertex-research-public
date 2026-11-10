import { describe, expect, it } from "vitest";

import {
  academyStrategySlug,
  COURSE_IDS,
  COURSE_LIST,
  COURSES,
  courseOf,
  courseOfStrategySlug,
  DEFAULT_COURSE_ID,
  isAcademyStrategySlug,
  isCourseId,
  lessonSlugOfStrategy,
  lessonSpecPath,
} from "./courses.ts";

describe("course registry", () => {
  it("keeps the Define Your Risk strings the Academy used before courses", () => {
    expect(DEFAULT_COURSE_ID).toBe("dyr");
    expect(COURSES.dyr).toMatchObject({
      creator: "Define Your Risk",
      librarySection: "Define Your Risk Academy",
      narrated: true,
      shortTitle: "DYR",
      store: "package",
      specDir: "packages/academy/src/lessons/specs",
      specFormat: "json",
      strategyPrefix: "dyr-",
      strategyTag: "define-your-risk",
      tagline:
        "Define Your Risk options lessons: video, interactive chart, backtest",
      timestamps: "estimated",
    });
    expect(COURSES.dyr.disclaimer).toBe(
      "Educational content based on Define Your Risk videos. Charts use illustrative values and Black-Scholes pricing. Backtests are modeled, not historical option fills. Nothing here is advice or an order."
    );
  });

  it("registers QuantFinanceToGo as an unnarrated course with its own prefix and folders", () => {
    expect(COURSES.quantfinancetogo).toMatchObject({
      creator: "QuantFinanceToGo",
      kbPath: "trading/quantfinancetogo",
      narrated: false,
      profileUrl: "https://www.instagram.com/quantfinancetogo/",
      store: "database",
      specDir: "scripts/academy/lessons/quantfinancetogo/specs",
      specFormat: "ts",
      strategyPrefix: "qftg-",
      timestamps: "segments",
      title: "QuantFinanceToGo",
    });
    expect(COURSES.quantfinancetogo.disclaimer).toMatch(
      /Nothing here is advice/u
    );
  });

  it("lists every course once, default first, with ids matching their keys", () => {
    expect(COURSE_LIST.map((course) => course.id)).toEqual([...COURSE_IDS]);
    expect(COURSE_LIST[0]?.id).toBe(DEFAULT_COURSE_ID);
    for (const id of COURSE_IDS) expect(COURSES[id].id).toBe(id);
  });

  it("gives every course distinct folders, files, sections and non-overlapping prefixes", () => {
    for (const key of ["specDir", "librarySection", "strategyTag"] as const)
      expect(new Set(COURSE_LIST.map((course) => course[key])).size).toBe(
        COURSE_LIST.length
      );
    for (const a of COURSE_LIST)
      for (const b of COURSE_LIST)
        if (a !== b)
          expect(a.strategyPrefix.startsWith(b.strategyPrefix)).toBe(false);
  });

  it("resolves a lesson's course, defaulting to dyr", () => {
    expect(courseOf({})).toBe(COURSES.dyr);
    expect(courseOf({ course: undefined })).toBe(COURSES.dyr);
    expect(courseOf({ course: "quantfinancetogo" })).toBe(
      COURSES.quantfinancetogo
    );
    expect(isCourseId("quantfinancetogo")).toBe(true);
    expect(isCourseId("nope")).toBe(false);
  });

  it("maps lessons to Academy strategy slugs and back for every course", () => {
    expect(academyStrategySlug({ slug: "wheel" })).toBe("dyr-wheel");
    expect(
      academyStrategySlug({ slug: "binomial", course: "quantfinancetogo" })
    ).toBe("qftg-binomial");
    expect(courseOfStrategySlug("qftg-binomial")).toBe(
      COURSES.quantfinancetogo
    );
    expect(courseOfStrategySlug("momentum")).toBeNull();
    expect(isAcademyStrategySlug("dyr-wheel")).toBe(true);
    expect(isAcademyStrategySlug("qftg-binomial")).toBe(true);
    expect(isAcademyStrategySlug("orb-spy")).toBe(false);
    expect(lessonSlugOfStrategy("dyr-wheel")).toBe("wheel");
    expect(lessonSlugOfStrategy("qftg-binomial")).toBe("binomial");
    expect(lessonSlugOfStrategy("orb-spy")).toBeNull();
  });

  it("locates spec files in the course folder", () => {
    expect(lessonSpecPath({ slug: "wheel" })).toBe(
      "packages/academy/src/lessons/specs/wheel.json"
    );
    expect(
      lessonSpecPath({ slug: "binomial", course: "quantfinancetogo" })
    ).toBe("scripts/academy/lessons/quantfinancetogo/specs/binomial.ts");
  });
});
