// @vitest-environment jsdom
import { lessonSummaries } from "@darkfactory/academy/lessons";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { AcademyGallery } from "./academy-gallery.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const lessons = lessonSummaries();
const first = lessons[0];
if (first === undefined) throw new Error("no lessons");

const mount = async () => {
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
            video: "/v.mp4",
            captions: "/c.vtt",
            thumbnail: "/thumb.jpg",
            durationSeconds: 61.6,
          },
        }}
        sourceCount={7}
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

describe("AcademyGallery", () => {
  it("shows every lesson with a thumbnail where media exists and a chart label otherwise", async () => {
    const container = await mount();
    expect(cards(container).length).toBe(lessons.length);
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
    expect(cards(container).length).toBe(concepts.length);
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
      expect(cards(container).length).toBe(lessons.filter(keep).length);
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
    const clear = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Clear"
    ) as HTMLButtonElement;
    await act(async () => clear.click());
    expect(cards(container).length).toBe(lessons.length);
    expect(search.value).toBe("");
  });
});
