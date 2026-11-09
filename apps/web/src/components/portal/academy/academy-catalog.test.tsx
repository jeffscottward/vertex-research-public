// @vitest-environment jsdom
import { COURSES, type LessonSummary } from "@darkfactory/academy";
import { lessonSummaries, toLessonSummary } from "@darkfactory/academy/lessons";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DATABASE_COURSE_LESSONS } from "../../../../../../packages/academy/src/lessons/database-courses.test-support.ts";
import {
  AcademyCatalog,
  type AcademyCourseListing,
  AcademyGallery,
} from "./academy-gallery.tsx";
import { DEFAULT_ACADEMY_QUERY } from "./academy-gallery-query.ts";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

const dyr = lessonSummaries().filter((lesson) => lesson.course === "dyr");
// Two QuantFinanceToGo concept lessons (database course: the authored import input).
const qftg: LessonSummary[] = DATABASE_COURSE_LESSONS.map(toLessonSummary)
  .filter(
    (lesson) =>
      lesson.course === "quantfinancetogo" && lesson.kind === "concept"
  )
  .slice(0, 2);
const firstQftg = qftg[0]?.slug ?? "";

const mount = async (node: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return container;
};

const change = async (element: HTMLSelectElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value"
  )?.set?.call(element, value);
  await act(async () =>
    element.dispatchEvent(new Event("change", { bubbles: true }))
  );
};

const catalog = (courses: readonly AcademyCourseListing[]) =>
  mount(
    <AcademyCatalog
      courses={courses}
      initialQuery={{ ...DEFAULT_ACADEMY_QUERY, kind: "strategy" }}
      media={{}}
    />
  );

describe("AcademyCatalog", () => {
  it("offers a course picker and groups the lessons by course", async () => {
    const container = await catalog([
      { course: "dyr", lessons: dyr, sourceCount: 153 },
      { course: "quantfinancetogo", lessons: qftg, sourceCount: 51 },
    ]);
    const picker = container.querySelectorAll("[data-course-card]");
    expect(
      [...picker].map((card) => card.getAttribute("data-course-card"))
    ).toEqual(["dyr", "quantfinancetogo"]);
    const qftgCard = container.querySelector(
      '[data-course-card="quantfinancetogo"]'
    );
    expect(qftgCard?.querySelector("a")?.getAttribute("href")).toBe(
      "/academy/c/quantfinancetogo"
    );
    expect(qftgCard?.textContent).toContain(
      "2 lessons · 51 QuantFinanceToGo videos"
    );
    expect(qftgCard?.textContent).toContain("live animations");
    expect(
      container.querySelector('[data-course-card="dyr"]')?.textContent
    ).toContain("narrated chart videos");
    expect(
      qftgCard?.querySelector(
        `a[href="${COURSES.quantfinancetogo.profileUrl}"]`
      )
    ).not.toBeNull();
    expect(
      container.querySelector("[data-academy-count]")?.textContent
    ).toContain(`${dyr.length + 2} lessons`);

    const section = (id: string) =>
      container.querySelector(`[data-academy-course="${id}"]`);
    // The Define Your Risk listing keeps its copy, filter ids and URL filters.
    expect(section("dyr")?.textContent).toContain(
      `${dyr.length} lessons from 153 Define Your Risk videos`
    );
    expect(section("dyr")?.querySelector("#academy-kind")).not.toBeNull();
    expect(
      section("dyr")?.querySelector<HTMLSelectElement>("#academy-kind")?.value
    ).toBe("strategy");
    expect(window.location.search).toBe("?type=strategy");
    expect(container.textContent).toContain(COURSES.dyr.disclaimer);
    expect(container.textContent).toContain(
      COURSES.quantfinancetogo.disclaimer
    );

    // The second course has its own controls, starts unfiltered and leaves the URL alone.
    const qftgSection = section("quantfinancetogo");
    expect(qftgSection?.textContent).toContain(
      "2 lessons from 51 QuantFinanceToGo videos"
    );
    expect(qftgSection?.textContent).toContain("link to the source reel");
    expect(qftgSection?.querySelectorAll("[data-lesson-card]")).toHaveLength(2);
    expect(
      qftgSection
        ?.querySelector(`[data-lesson-card="${firstQftg}"]`)
        ?.getAttribute("href")
    ).toBe(`/academy/${firstQftg}`);
    const kind = qftgSection?.querySelector(
      "#academy-quantfinancetogo-kind"
    ) as HTMLSelectElement;
    await change(kind, "strategy");
    expect(qftgSection?.querySelectorAll("[data-lesson-card]")).toHaveLength(0);
    expect(window.location.search).toBe("?type=strategy");
  });

  it("shows a packaged course without lessons as an empty group with its video count", async () => {
    const container = await catalog([
      { course: "dyr", lessons: [], sourceCount: 153 },
      { course: "quantfinancetogo", lessons: qftg, sourceCount: 51 },
    ]);
    const empty = container.querySelector(
      '[data-academy-course="dyr"] [data-course-empty="no-lessons"]'
    );
    expect(empty?.textContent).toContain(
      "No lessons yet: 153 Define Your Risk videos are in the knowledge base."
    );
  });

  it("says a database course with no rows has not been imported yet", async () => {
    const container = await catalog([
      { course: "dyr", lessons: dyr, sourceCount: 153 },
      { course: "quantfinancetogo", lessons: [], sourceCount: 0 },
    ]);
    const empty = container.querySelector(
      '[data-academy-course="quantfinancetogo"] [data-course-empty="not-imported"]'
    );
    expect(empty?.textContent).toContain("Course content not imported yet");
    expect(container.textContent).not.toContain("No lessons yet");
  });

  it("keeps listing the other courses when one course is unavailable", async () => {
    const container = await catalog([
      { course: "dyr", lessons: dyr, sourceCount: 153 },
      {
        course: "quantfinancetogo",
        lessons: [],
        sourceCount: 0,
        unavailable: true,
      },
    ]);
    const unavailable = container.querySelector(
      '[data-academy-course="quantfinancetogo"] [data-course-empty="unavailable"]'
    );
    expect(unavailable?.textContent).toContain("Course unavailable");
    expect(
      container.querySelector('[data-course-card="quantfinancetogo"]')
        ?.textContent
    ).toContain("Lessons unavailable");
    expect(
      container.querySelectorAll(
        '[data-academy-course="dyr"] [data-lesson-card]'
      ).length
    ).toBeGreaterThan(0);
  });
});

describe("AcademyGallery for a database course with no rows", () => {
  it("says the content has not been imported instead of an empty gallery", async () => {
    const container = await mount(
      <AcademyGallery
        course="quantfinancetogo"
        lessons={[]}
        media={{}}
        sourceCount={0}
      />
    );
    expect(
      container.querySelector('[data-course-empty="not-imported"]')?.textContent
    ).toContain("Course content not imported yet");
    expect(container.querySelector("[data-lesson-card]")).toBeNull();
  });
});

describe("AcademyGallery for one course", () => {
  it("takes its copy and disclaimer from the course registry", async () => {
    const container = await mount(
      <AcademyGallery
        course="quantfinancetogo"
        lessons={qftg}
        media={{}}
        sourceCount={51}
      />
    );
    expect(
      container
        .querySelector("[data-academy-gallery]")
        ?.getAttribute("data-academy-gallery")
    ).toBe("quantfinancetogo");
    expect(container.textContent).toContain(COURSES.quantfinancetogo.tagline);
    expect(container.textContent).toContain(
      "2 lessons from 51 QuantFinanceToGo videos (0 tradeable strategies, 2 concept lessons)"
    );
    expect(container.textContent).toContain(
      COURSES.quantfinancetogo.disclaimer
    );
    expect(container.textContent).not.toContain("Define Your Risk");
    expect(
      container.querySelector("#academy-quantfinancetogo-search")
    ).not.toBeNull();
  });
});
