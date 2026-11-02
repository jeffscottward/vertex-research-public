// @vitest-environment jsdom
import type { Lesson } from "@darkfactory/academy";
import { lessonBySlug } from "@darkfactory/academy/lessons";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LessonInteractive, TableView } from "./lesson-interactive.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

const fixture = (slug: string): Lesson => {
  const lesson = lessonBySlug(slug);
  if (lesson === null) throw new Error(`fixture ${slug} missing`);
  return lesson;
};

const mount = async (lesson: Lesson) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<LessonInteractive lesson={lesson} />));
  return { container, root };
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

const click = async (element: Element | null) =>
  act(async () => (element as HTMLElement).click());

const timeOf = (container: HTMLElement) =>
  container
    .querySelector("[data-interactive-chart]")
    ?.getAttribute("data-time");

describe("LessonInteractive", () => {
  it("edits every kind of parameter, keeps the default for a blank number, and resets", async () => {
    const base = fixture("covered-call-asymmetry-fixes");
    const lesson: Lesson = {
      ...base,
      params: [
        ...base.params,
        { id: "pickNone", label: "Pick none", kind: "select", default: "x" },
        {
          id: "pickOne",
          label: "Pick one",
          kind: "select",
          default: "a",
          options: ["a", "b"],
        },
        { id: "note", label: "Note", kind: "text", default: "hi" },
        {
          id: "size",
          label: "Size",
          kind: "number",
          default: 3,
          step: 1,
          unit: "contracts",
        },
      ],
    };
    const { container } = await mount(lesson);
    const none = container.querySelector(
      "#param-pickNone"
    ) as HTMLSelectElement;
    expect(none.options.length).toBe(0);
    const pick = container.querySelector("#param-pickOne") as HTMLSelectElement;
    await change(pick, "b");
    expect(pick.value).toBe("b");
    const note = container.querySelector("#param-note") as HTMLInputElement;
    expect(note.type).toBe("text");
    await change(note, "typed");
    expect(note.value).toBe("typed");
    const size = container.querySelector("#param-size") as HTMLInputElement;
    expect(size.step).toBe("1");
    expect(container.textContent).toContain("Size (contracts)");
    await change(size, "");
    expect(size.value).toBe("");
    await change(size, "5");
    expect(size.value).toBe("5");
    const first = base.params[0];
    if (first === undefined) throw new Error("no params");
    const firstInput = container.querySelector(
      `#param-${first.id}`
    ) as HTMLInputElement;
    expect(firstInput.step).toBe(
      first.step === undefined ? "any" : String(first.step)
    );
    await click(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Reset parameters")
      ) ?? null
    );
    expect(pick.value).toBe("a");
    expect(note.value).toBe("hi");
    expect(size.value).toBe("3");
    expect(container.querySelectorAll("[data-formula]").length).toBe(
      lesson.formulas.length
    );
  });

  it("steps through the lesson, colors a repeated element by its first step, and scrubs", async () => {
    const base = fixture("covered-call-asymmetry-fixes");
    const [one, two] = base.steps;
    if (one === undefined || two === undefined) throw new Error("few steps");
    const lesson: Lesson = {
      ...base,
      steps: [
        { ...one, time: [0, 0.3] },
        { ...two, element: one.element, color: "red", time: undefined },
      ],
    };
    const { container } = await mount(lesson);
    expect(container.querySelector("[data-step-caption]")).toBeNull();
    await click(container.querySelector('[data-step-button="0"]'));
    expect(timeOf(container)).toBe("0.300");
    const caption = container.querySelector(
      "[data-step-caption]"
    ) as HTMLElement;
    const firstColor = caption.style.borderLeft;
    await click(container.querySelector('[data-step-button="1"]'));
    expect(timeOf(container)).toBe("0.300");
    expect(
      (container.querySelector("[data-step-caption]") as HTMLElement).style
        .borderLeft
    ).toBe(firstColor);
    expect(
      container
        .querySelector('[data-step-button="1"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
    await click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Show all"
      ) ?? null
    );
    expect(container.querySelector("[data-step-caption]")).toBeNull();
    const before = timeOf(container);
    await click(container.querySelector("[data-scrub-back]"));
    expect(timeOf(container)).not.toBe(before);
    const scrubber = container.querySelector(
      "#lesson-scrubber"
    ) as HTMLInputElement;
    await change(scrubber, "0");
    await click(container.querySelector("[data-scrub-back]"));
    expect(timeOf(container)).toBe("0.000");
    await change(scrubber, "1000");
    await click(container.querySelector("[data-scrub-forward]"));
    expect(timeOf(container)).toBe("1.000");
    expect(container.querySelector("[data-scrub-label]")?.textContent).toMatch(
      / of \d+$/u
    );
  });

  it("plays forward to the end, stops, restarts from entry, and pauses", async () => {
    vi.useFakeTimers();
    const { container } = await mount(fixture("covered-call-asymmetry-fixes"));
    const play = container.querySelector(
      '[aria-label="Play forward in time"]'
    ) as HTMLButtonElement;
    await click(play);
    expect(play.getAttribute("aria-label")).toBe("Pause");
    await act(async () => {
      vi.advanceTimersByTime(120 * 300);
    });
    expect(timeOf(container)).toBe("1.000");
    expect(play.getAttribute("aria-label")).toBe("Play forward in time");
    await click(play);
    expect(timeOf(container)).toBe("0.000");
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(timeOf(container)).not.toBe("0.000");
    await click(play);
    expect(play.getAttribute("aria-label")).toBe("Play forward in time");
    const paused = timeOf(container);
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(timeOf(container)).toBe(paused);
  });

  it("formats percent and trade timelines and rotates 3D charts", async () => {
    const pct = await mount(fixture("beta-core-plus-option-overlays"));
    expect(
      pct.container.querySelector("[data-scrub-label]")?.textContent
    ).toMatch(/\d%$/u);
    expect(pct.container.querySelector("#lesson-azimuth")).toBeNull();
    const trades = await mount(fixture("three-trading-biases"));
    expect(
      trades.container.querySelector("[data-scrub-label]")?.textContent
    ).toMatch(/: \d+ of \d+$/u);
    const surface = await mount(fixture("itm-debit-call-spread"));
    const azimuth = surface.container.querySelector(
      "#lesson-azimuth"
    ) as HTMLInputElement;
    await change(azimuth, "1.2");
    expect(azimuth.value).toBe("1.2");
  });

  it("survives a lesson change with stale step and parameter state", async () => {
    const base = fixture("covered-call-asymmetry-fixes");
    const lessonA: Lesson = {
      ...base,
      params: [
        ...base.params,
        { id: "oldOnly", label: "Old only", kind: "number", default: 4 },
      ],
    };
    const { container, root } = await mount(lessonA);
    await change(
      container.querySelector("#param-oldOnly") as HTMLInputElement,
      ""
    );
    const last = lessonA.steps.length - 1;
    await click(container.querySelector(`[data-step-button="${last}"]`));
    const lessonB: Lesson = {
      ...base,
      steps: base.steps.slice(0, 1),
      params: [
        ...base.params,
        { id: "newOnly", label: "New only", kind: "number", default: 9 },
      ],
    };
    await act(async () => root.render(<LessonInteractive lesson={lessonB} />));
    expect(container.querySelector("[data-step-caption]")).toBeNull();
    expect(
      (container.querySelector("#param-newOnly") as HTMLInputElement).value
    ).toBe("9");
  });
});

describe("TableView", () => {
  it("renders a note only when present", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <>
          <TableView
            table={{
              id: "a",
              title: "A",
              columns: ["x", "y"],
              rows: [["1", "2"]],
            }}
          />
          <TableView
            table={{
              id: "b",
              title: "B",
              columns: ["x"],
              rows: [],
              note: "Hi",
            }}
          />
        </>
      )
    );
    expect(container.querySelector('[data-table="a"] p')).toBeNull();
    expect(container.querySelector('[data-table="b"] p')?.textContent).toBe(
      "Hi"
    );
  });
});
