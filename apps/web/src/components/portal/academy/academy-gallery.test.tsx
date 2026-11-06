// @vitest-environment jsdom
import { lessonSummaries } from "@darkfactory/academy/lessons";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AcademyGallery } from "./academy-gallery.tsx";
import {
  type AcademyGalleryQuery,
  ACADEMY_PAGE_SIZE,
  DEFAULT_ACADEMY_QUERY,
} from "./academy-gallery-query.ts";

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

const lessons = lessonSummaries();
const first = lessons[0];
if (first === undefined) throw new Error("no lessons");

const mount = async (initialQuery?: AcademyGalleryQuery) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <AcademyGallery
        lessons={lessons}
        media={{
          [first.slug]: {
            captions: "/c.vtt",
            durationSeconds: 61.6,
            thumbnail: "/thumb.jpg",
            video: "/v.mp4",
          },
        }}
        sourceCount={7}
        {...(initialQuery === undefined ? {} : { initialQuery })}
      />
    )
  );
  return container;
};

const change = async (
  element: HTMLInputElement | HTMLSelectElement,
  value: string
) => {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value
  );
  await act(async () =>
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    )
  );
};

const cards = (container: HTMLElement) =>
  container.querySelectorAll("[data-lesson-card]");

/** Cards on the first page when `count` lessons match. */
const firstPage = (count: number) => Math.min(count, ACADEMY_PAGE_SIZE);

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label
  ) as HTMLButtonElement;

const pageCount = Math.ceil(lessons.length / ACADEMY_PAGE_SIZE);

describe("AcademyGallery", () => {
  it("shows every lesson with a thumbnail where media exists and a chart label otherwise", async () => {
    const container = await mount();
    expect(cards(container).length).toBe(firstPage(lessons.length));
    const card = container.querySelector(`[data-lesson-card="${first.slug}"]`);
    expect(card?.querySelector("img")?.getAttribute("src")).toBe("/thumb.jpg");
    expect(card?.textContent).toContain("62 s");
    const other = cards(container)[1];
    expect(other?.querySelector("img")).toBeNull();
    expect(other?.textContent).toContain("chart");
    expect(container.textContent).toContain("from 7 Define Your Risk");
    expect(container.textContent).toContain("Strategy");
    expect(container.textContent).toContain("Concept");
  });

  it("filters by every control, reports no match, and clears", async () => {
    const container = await mount();
    const select = (id: string) =>
      container.querySelector(`#${id}`) as HTMLSelectElement;
    await change(select("academy-kind"), "concept");
    const concepts = lessons.filter((lesson) => lesson.kind === "concept");
    expect(cards(container).length).toBe(firstPage(concepts.length));
    expect(container.textContent).toContain(
      `Showing ${concepts.length} of ${lessons.length} lessons`
    );
    expect(window.location.search).toBe("?type=concept");
    await change(select("academy-kind"), "");
    for (const [id, value, keep] of [
      [
        "academy-regime",
        first.tags.regime[0] ?? "",
        (l: (typeof lessons)[number]) =>
          l.tags.regime.includes(first.tags.regime[0] as never),
      ],
      [
        "academy-instrument",
        first.tags.instruments[0] ?? "",
        (l: (typeof lessons)[number]) =>
          l.tags.instruments.includes(first.tags.instruments[0] as never),
      ],
      [
        "academy-timeframe",
        first.tags.timeframe,
        (l: (typeof lessons)[number]) =>
          l.tags.timeframe === first.tags.timeframe,
      ],
      [
        "academy-scene",
        first.sceneType,
        (l: (typeof lessons)[number]) => l.sceneType === first.sceneType,
      ],
    ] as const) {
      await change(select(id), value);
      expect(cards(container).length).toBe(
        firstPage(lessons.filter(keep).length)
      );
      await change(select(id), "");
    }
    const search = container.querySelector(
      "#academy-search"
    ) as HTMLInputElement;
    await change(search, `  ${first.title.toUpperCase()}  `);
    expect(
      container.querySelector(`[data-lesson-card="${first.slug}"]`)
    ).not.toBeNull();
    await change(search, "zzzz no such lesson zzzz");
    expect(cards(container).length).toBe(0);
    expect(container.textContent).toContain("No lesson matches these filters.");
    expect(container.textContent).toContain(`Showing 0 of ${lessons.length}`);
    expect(container.querySelector("[data-academy-pager]")).toBeNull();
    expect(window.location.search).toBe("?q=zzzz+no+such+lesson+zzzz");
    await act(async () => button(container, "Clear").click());
    expect(cards(container).length).toBe(firstPage(lessons.length));
    expect(search.value).toBe("");
    expect(window.location.search).toBe("");
    // Many filter steps re-render the whole gallery; a loaded runner needs more than the 5 s default.
  }, 30_000);

  it("puts the title, lesson count chip and theme toggle in the page header", async () => {
    const container = await mount();
    const header = container.querySelector("header[data-variant=portal]");
    expect(header?.querySelector("h1")?.textContent).toBe("Academy");
    expect(
      header?.querySelector("[data-academy-count]")?.textContent
    ).toContain(`${lessons.length} lessons`);
    expect(
      header?.querySelector('button[aria-label^="Switch the Academy"]')
    ).not.toBeNull();
    const panel = container.querySelector("[data-slot=panel]");
    expect(panel?.querySelector('[role="search"]')).not.toBeNull();
    expect(panel?.querySelector("[data-academy-cards]")).not.toBeNull();
  });

  it("pages the grid with Previous and Next, keeping the page in the URL", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const replace = vi.spyOn(window.history, "replaceState");
    const container = await mount();
    // The default view already matches the bare URL: nothing is written on mount.
    expect(replace).not.toHaveBeenCalled();
    const pager = () => container.querySelector("[data-academy-pager]");
    expect(pager()?.textContent).toContain(`Page 1 of ${pageCount}`);
    expect(button(container, "Previous").disabled).toBe(true);
    await act(async () => button(container, "Next").click());
    expect(pager()?.textContent).toContain(`Page 2 of ${pageCount}`);
    expect(window.location.search).toBe("?page=2");
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(cards(container)[0]?.getAttribute("data-lesson-card")).toBe(
      lessons[ACADEMY_PAGE_SIZE]?.slug
    );
    expect(container.textContent).toContain(
      `${ACADEMY_PAGE_SIZE + 1}–${ACADEMY_PAGE_SIZE * 2} on this page`
    );
    await act(async () => button(container, "Previous").click());
    expect(window.location.search).toBe("");
    for (let page = 1; page < pageCount; page += 1)
      await act(async () => button(container, "Next").click());
    expect(button(container, "Next").disabled).toBe(true);
    expect(cards(container).length).toBe(
      lessons.length - ACADEMY_PAGE_SIZE * (pageCount - 1)
    );
    // A filter change starts again from the first page.
    await change(
      container.querySelector("#academy-search") as HTMLInputElement,
      "a"
    );
    expect(pager()?.textContent ?? "").not.toContain(`Page ${pageCount} of`);
    expect(new URLSearchParams(window.location.search).get("page")).toBeNull();
  }, 30_000);

  it("restores filters and page from the URL query and drops unknown values", async () => {
    window.history.replaceState(
      null,
      "",
      "/academy?type=concept&chart=bogus&page=2#top"
    );
    const concepts = lessons.filter((lesson) => lesson.kind === "concept");
    const container = await mount({
      ...DEFAULT_ACADEMY_QUERY,
      kind: "concept",
      scene: "bogus",
      page: 2,
    });
    expect(
      (container.querySelector("#academy-kind") as HTMLSelectElement).value
    ).toBe("concept");
    expect(
      (container.querySelector("#academy-scene") as HTMLSelectElement).value
    ).toBe("");
    expect(cards(container)[0]?.getAttribute("data-lesson-card")).toBe(
      concepts[ACADEMY_PAGE_SIZE]?.slug
    );
    // The unknown chart value is dropped from the address; the rest stays.
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`
    ).toBe("/academy?type=concept&page=2#top");
  });
});
