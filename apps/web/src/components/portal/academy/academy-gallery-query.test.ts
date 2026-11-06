import { lessonSummaries } from "@darkfactory/academy/lessons";
import { describe, expect, it } from "vitest";

import {
  ACADEMY_PAGE_SIZE,
  academyGalleryOptions,
  academyGalleryUrl,
  DEFAULT_ACADEMY_QUERY,
  EMPTY_ACADEMY_FILTERS,
  filterAcademyLessons,
  pageAcademyLessons,
  readAcademyGalleryQuery,
  sanitizeAcademyGalleryQuery,
} from "./academy-gallery-query.ts";

const lessons = lessonSummaries();
const first = lessons[0];
if (first === undefined) throw new Error("no lessons");
const options = academyGalleryOptions(lessons);

describe("readAcademyGalleryQuery", () => {
  it("defaults every filter and page 1 for an empty URL", () => {
    expect(readAcademyGalleryQuery({})).toEqual(DEFAULT_ACADEMY_QUERY);
  });

  it("reads each URL key, the first of repeated values, and trims selects", () => {
    expect(
      readAcademyGalleryQuery({
        q: "  gamma ",
        type: ["concept", "strategy"],
        regime: " bullish ",
        instrument: "etf",
        timeframe: "days",
        chart: "payoff",
        page: "3",
      })
    ).toEqual({
      search: "  gamma ",
      kind: "concept",
      regime: "bullish",
      instrument: "etf",
      timeframe: "days",
      scene: "payoff",
      page: 3,
    });
    expect(readAcademyGalleryQuery({ type: [] }).kind).toBe("");
    expect(readAcademyGalleryQuery({ q: "x".repeat(500) }).search).toHaveLength(
      120
    );
  });

  it.each(["0", "-2", "abc", "1.5", "99999", ""])(
    "falls back to page 1 for page=%j",
    (page) => {
      expect(readAcademyGalleryQuery({ page }).page).toBe(1);
    }
  );
});

describe("sanitizeAcademyGalleryQuery", () => {
  it("keeps known select values and the search, and blanks unknown ones", () => {
    const known = {
      ...DEFAULT_ACADEMY_QUERY,
      search: "anything",
      kind: "strategy",
      regime: first.tags.regime[0] ?? "",
      timeframe: first.tags.timeframe,
      scene: first.sceneType,
      page: 4,
    };
    expect(sanitizeAcademyGalleryQuery(known, options)).toEqual(known);
    expect(
      sanitizeAcademyGalleryQuery(
        {
          ...known,
          kind: "bogus",
          regime: "bogus",
          instrument: "bogus",
          timeframe: "bogus",
          scene: "bogus",
        },
        options
      )
    ).toEqual({ ...EMPTY_ACADEMY_FILTERS, search: "anything", page: 4 });
  });
});

describe("filterAcademyLessons", () => {
  it("returns every lesson without filters", () => {
    expect(filterAcademyLessons(lessons, EMPTY_ACADEMY_FILTERS)).toEqual(
      lessons
    );
  });

  it("matches the search against title, summary and topics, ignoring case and padding", () => {
    const found = filterAcademyLessons(lessons, {
      ...EMPTY_ACADEMY_FILTERS,
      search: `  ${first.title.toUpperCase()}  `,
    });
    expect(found).toContain(first);
    const topic = lessons.find((lesson) => lesson.tags.topics.length > 0);
    const word = topic?.tags.topics[0] ?? "";
    expect(
      filterAcademyLessons(lessons, { ...EMPTY_ACADEMY_FILTERS, search: word })
    ).toContain(topic);
    expect(
      filterAcademyLessons(lessons, {
        ...EMPTY_ACADEMY_FILTERS,
        search: "zzzz no such lesson zzzz",
      })
    ).toEqual([]);
  });

  it("combines the select filters", () => {
    const filters = {
      ...EMPTY_ACADEMY_FILTERS,
      kind: first.kind,
      regime: first.tags.regime[0] ?? "",
      instrument: first.tags.instruments[0] ?? "",
      timeframe: first.tags.timeframe,
      scene: first.sceneType,
    };
    const found = filterAcademyLessons(lessons, filters);
    expect(found).toContain(first);
    for (const lesson of found) {
      expect(lesson.kind).toBe(filters.kind);
      expect(lesson.tags.regime).toContain(filters.regime);
      expect(lesson.tags.timeframe).toBe(filters.timeframe);
      expect(lesson.sceneType).toBe(filters.scene);
    }
  });
});

describe("pageAcademyLessons", () => {
  const items = Array.from({ length: 30 }, (_, index) => index);

  it("shows twelve per page by default and reports the shown range", () => {
    expect(ACADEMY_PAGE_SIZE).toBe(12);
    expect(pageAcademyLessons(items, 1)).toEqual({
      items: items.slice(0, 12),
      page: 1,
      pageCount: 3,
      from: 1,
      to: 12,
    });
    expect(pageAcademyLessons(items, 3)).toMatchObject({
      items: items.slice(24),
      from: 25,
      to: 30,
    });
  });

  it("clamps an out-of-range page and reports an empty list as one page", () => {
    expect(pageAcademyLessons(items, 9).page).toBe(3);
    expect(pageAcademyLessons(items, -1, 10).page).toBe(1);
    expect(pageAcademyLessons([], 2)).toEqual({
      items: [],
      page: 1,
      pageCount: 1,
      from: 0,
      to: 0,
    });
  });
});

describe("academyGalleryUrl", () => {
  const location = { pathname: "/academy", search: "", hash: "" };

  it("leaves the defaults out of the URL", () => {
    expect(academyGalleryUrl(DEFAULT_ACADEMY_QUERY, location)).toBe("/academy");
    expect(
      academyGalleryUrl(
        { ...DEFAULT_ACADEMY_QUERY, search: "   " },
        { ...location, search: "?q=old&page=2" }
      )
    ).toBe("/academy");
  });

  it("writes set filters and pages past the first, keeping other params and the hash", () => {
    expect(
      academyGalleryUrl(
        {
          search: "covered call",
          kind: "strategy",
          regime: "bullish",
          instrument: "etf",
          timeframe: "days",
          scene: "payoff",
          page: 2,
        },
        { pathname: "/lab/academy", search: "?theme=light&q=old", hash: "#x" }
      )
    ).toBe(
      "/lab/academy?theme=light&q=covered+call&type=strategy&regime=bullish&instrument=etf&timeframe=days&chart=payoff&page=2#x"
    );
  });

  it("round-trips through readAcademyGalleryQuery", () => {
    const query = {
      ...DEFAULT_ACADEMY_QUERY,
      search: "iv crush",
      kind: "concept",
      page: 5,
    };
    const url = new URL(academyGalleryUrl(query, location), "http://x");
    expect(
      readAcademyGalleryQuery(Object.fromEntries(url.searchParams))
    ).toEqual(query);
  });
});
