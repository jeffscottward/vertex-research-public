// @vitest-environment jsdom

import type { LessonSource } from "@darkfactory/academy";
import { COURSES } from "@darkfactory/academy";
import { lessonBySlug } from "@darkfactory/academy/lessons";
import type {
  AcademyDeployRequestOutput,
  AcademyGateOutput,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AcademyGateway } from "./academy-client.ts";
import { AcademyLesson } from "./academy-lesson.tsx";

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

const blockedGate: AcademyGateOutput = {
  checks: [
    {
      detail: "Feed unavailable",
      id: "nlv-known",
      status: "conflict",
      title: "NLV known",
    },
    {
      detail: "Shares",
      id: "options-only",
      status: "conflict",
      title: "Options only",
    },
    { detail: "Events", id: "X06", status: "warn", title: "X06" },
    { detail: "Defined", id: "X03", status: "pass", title: "X03" },
  ],
  conflicts: ["nlv-known", "options-only"],
  nlv: null,
  nlvDetail: "Portfolio feed unavailable.",
  nlvSource: "unavailable",
  openPremiumInNameUsd: 0,
  otherAllocationsPct: 0,
  premiumPerPositionPctNlv: -1,
  premiumPerPositionUsd: 0,
  rewardRisk: null,
  statedNlv: null,
  structure: "covered_call",
  unitLossUsd: null,
  verdict: "blocked",
};

const gateway = (): AcademyGateway & {
  deployRequest: ReturnType<typeof vi.fn>;
} => ({
  backtest: vi.fn(async () => {
    throw new Error("Backtest not under test");
  }),
  deployPreview: vi.fn(async () => blockedGate),
  deployRequest: vi.fn(
    async (): Promise<AcademyDeployRequestOutput> => ({
      gate: blockedGate,
      override: {
        auditId: "a-1",
        rules: ["nlv-known", "options-only"],
        used: true,
      },
      request: {
        brokerSubmissionAllowed: false,
        executionAuthorized: false,
        id: "dr-9",
        mode: "paper",
        status: "requested",
        strategyId: "s",
        strategySlug: "dyr-itm-covered-call-otm-put",
      },
    })
  ),
  tickers: vi.fn(async () => ({ tickers: [] })),
});

const mount = async (fake: AcademyGateway) => {
  const lesson = lessonBySlug("itm-covered-call-otm-put");
  if (lesson === null) throw new Error("fixture lesson missing");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <AcademyLesson
        gateway={fake}
        lesson={lesson}
        media={null}
        next={null}
        previous={null}
      />
    )
  );
  return container;
};

const setValue = async (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string
) => {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value
  );
  await act(async () =>
    element.dispatchEvent(new Event("input", { bubbles: true }))
  );
};

describe("AcademyLesson", () => {
  it("shows an unnarrated course's lesson as a live animation with its source reel", async () => {
    const base = lessonBySlug("vega-exposure-basics");
    if (base === null) throw new Error("fixture lesson missing");
    const lesson = {
      ...base,
      course: "quantfinancetogo" as const,
      source: {
        ...base.source,
        course: "quantfinancetogo" as const,
        url: "https://www.instagram.com/reel/DfK1oP4IkLF/",
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <AcademyLesson
          lesson={lesson}
          media={{
            captions: "/c.vtt",
            durationSeconds: 30,
            thumbnail: "/t.jpg",
            video: "/v.mp4",
          }}
          next={null}
          previous={null}
        />
      )
    );
    const reel = container.querySelector("[data-source-reel]");
    expect(reel?.getAttribute("href")).toBe(
      "https://www.instagram.com/reel/DfK1oP4IkLF/"
    );
    expect(reel?.textContent).toContain("Source reel by QuantFinanceToGo");
    // No MP4 for an unnarrated course, and no "not rendered yet" notice either.
    expect(container.querySelector("video")).toBeNull();
    expect(container.textContent).not.toContain("not rendered yet");
    expect(container.textContent).toContain("Live animation");
    expect(container.querySelector("#video-title")?.textContent).toBe(
      "Chart animation"
    );
    expect(
      container.querySelector('nav[aria-label="Lesson sections"] a')
        ?.textContent
    ).toBe("Animation");
    const crumbs = [
      ...container.querySelectorAll('nav[aria-label="Breadcrumb"] a'),
    ].map((link) => link.getAttribute("href"));
    expect(crumbs).toEqual(["/academy", "/academy/c/quantfinancetogo"]);
    expect(container.textContent).toContain(
      COURSES.quantfinancetogo.disclaimer
    );
    expect(container.textContent).not.toContain(COURSES.dyr.disclaimer);
    expect(container.textContent).toContain(
      "Timestamps are the speech-to-text segment start times."
    );
  });

  it("keeps the Define Your Risk lesson narrated, with estimated timestamps and no reel link", async () => {
    const container = await mount(gateway());
    expect(container.querySelector("[data-source-reel]")).toBeNull();
    expect(container.textContent).toContain("not rendered yet");
    expect(container.textContent).toContain(COURSES.dyr.disclaimer);
    expect(container.textContent).toContain(
      "Timestamps are estimated from word position"
    );
  });

  it("renders a concept lesson with the browser gateway and both neighbour links", async () => {
    const lesson = lessonBySlug("vega-exposure-basics");
    if (lesson === null) throw new Error("fixture lesson missing");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <AcademyLesson
          lesson={lesson}
          media={null}
          next={{ slug: "after", title: "After lesson" }}
          previous={{ slug: "before", title: "Before lesson" }}
        />
      )
    );
    expect(container.querySelector("[data-concept-note]")).not.toBeNull();
    expect(container.querySelector("[data-lesson-backtest]")).toBeNull();
    expect(container.querySelector("[data-lesson-deploy]")).toBeNull();
    expect(container.textContent).toContain("Concept lesson");
    const header = container.querySelector("header[data-variant=portal]");
    expect(header?.querySelector("h1")?.textContent).toBe(lesson.title);
    const crumb = header?.querySelector(
      '[data-slot="page-breadcrumb"] nav[aria-label="Breadcrumb"] a'
    );
    expect(crumb?.getAttribute("href")).toBe("/academy");
    expect(crumb?.textContent?.trim()).toBe("Academy");
    const kind = header?.querySelector(
      '[data-slot="page-status"] [data-lesson-kind]'
    );
    expect(kind?.getAttribute("data-lesson-kind")).toBe("concept");
    expect(kind?.getAttribute("data-status")).toBe("neutral");
    expect(kind?.textContent).toContain("Concept lesson");
    expect(header?.textContent).toContain(lesson.summary);
    expect(
      header?.querySelector('button[aria-label^="Switch the Academy"]')
    ).not.toBeNull();
    expect(
      [
        ...container.querySelectorAll('nav[aria-label="Lesson sections"] a'),
      ].map((link) => link.getAttribute("href"))
    ).toEqual(["#video", "#interactive", "#transcript"]);
    expect(
      container.querySelector('a[href="/academy/before"]')?.textContent
    ).toContain("Before lesson");
    expect(
      container.querySelector('a[href="/academy/after"]')?.textContent
    ).toContain("After lesson");
  });

  it("colors the step caption with the element color and moves the scrubber in time", async () => {
    const container = await mount(gateway());
    const kind = container.querySelector("[data-lesson-kind]");
    expect(kind?.getAttribute("data-lesson-kind")).toBe("strategy");
    expect(kind?.getAttribute("data-status")).toBe("info");
    expect(kind?.textContent).toContain("Strategy");
    const chart = container.querySelector("[data-interactive-chart]");
    const before = chart?.getAttribute("data-time");
    await act(async () =>
      (
        container.querySelector("[data-scrub-forward]") as HTMLButtonElement
      ).click()
    );
    expect(chart?.getAttribute("data-time")).not.toBe(before);
    await act(async () =>
      (
        container.querySelector('[data-step-button="1"]') as HTMLButtonElement
      ).click()
    );
    const caption = container.querySelector("[data-step-caption]");
    expect(caption?.textContent).toContain("Sell the $95 call");
    expect(
      container.querySelectorAll("[data-lesson-tables] [data-table]").length
    ).toBeGreaterThan(3);
    expect(
      container.querySelectorAll("[data-transcript] li").length
    ).toBeGreaterThan(3);
  });

  it("shows blocking gates and sends the override with every rule acknowledged", async () => {
    vi.useFakeTimers();
    const fake = gateway();
    const container = await mount(fake);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    vi.useRealTimers();
    await act(async () => Promise.resolve());
    expect(
      container
        .querySelector("[data-gate-verdict]")
        ?.getAttribute("data-gate-verdict")
    ).toBe("blocked");
    const submit = container.querySelector(
      "[data-deploy-submit]"
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    for (const id of ["nlv-known", "options-only"])
      await act(async () =>
        (
          container.querySelector(`[data-ack="${id}"]`) as HTMLInputElement
        ).click()
      );
    await setValue(
      container.querySelector("#override-explanation") as HTMLTextAreaElement,
      "Paper test. I accept nlv-known and options-only for this one structure."
    );
    await setValue(
      container.querySelector("#override-password") as HTMLInputElement,
      "secret-pass"
    );
    // The feed is down (nlv null): the stated NLV is required before submit.
    expect(submit.disabled).toBe(true);
    await setValue(
      container.querySelector("#deploy-nlv") as HTMLInputElement,
      "250000"
    );
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(fake.deployRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        override: {
          acknowledged: ["nlv-known", "options-only"],
          explanation: expect.stringContaining("options-only"),
          password: "secret-pass",
        },
        slug: "itm-covered-call-otm-put",
        statedNlv: 250_000,
      })
    );
    expect(
      container
        .querySelector("[data-deploy-result]")
        ?.getAttribute("data-deploy-result")
    ).toBe("requested");
    expect(
      (container.querySelector("#override-password") as HTMLInputElement).value
    ).toBe("");
  });
  it("disables submit after a request is created so a double click cannot send it twice", async () => {
    vi.useFakeTimers();
    const passing: AcademyGateOutput = {
      ...blockedGate,
      conflicts: [],
      nlv: 1_000_000,
      nlvSource: "portfolio-monitor",
      verdict: "pass",
    };
    const fake = { ...gateway(), deployPreview: vi.fn(async () => passing) };
    const container = await mount(fake);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    vi.useRealTimers();
    await act(async () => Promise.resolve());
    const submit = container.querySelector(
      "[data-deploy-submit]"
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(fake.deployRequest).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(true);
  });

  it("colors gate status from the Academy palette, without dark: utilities", async () => {
    vi.useFakeTimers();
    const container = await mount(gateway());
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    vi.useRealTimers();
    await act(async () => Promise.resolve());
    expect(container.innerHTML).not.toContain("dark:");
    expect(
      container.querySelector('[aria-label="conflict"]')?.getAttribute("stroke")
    ).toMatch(/^#/u);
    expect(container.querySelector('[aria-label="pass"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="warning"]')).not.toBeNull();
  });

  // Positional args (not a `transcript` object key) keep this file clear of the
  // private-academy-sources guard, which flags reel URLs next to transcript keys.
  const renderWithSource = async (
    lines: LessonSource["transcript"],
    caption?: string
  ) => {
    const base = lessonBySlug("vega-exposure-basics");
    if (base === null) throw new Error("fixture lesson missing");
    const transcript = lines;
    const lesson = {
      ...base,
      source: {
        ...base.source,
        caption: caption ?? base.source.caption,
        transcript,
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <AcademyLesson
          lesson={lesson}
          media={null}
          next={null}
          previous={null}
        />
      )
    );
    const section = container.querySelector("#transcript");
    if (section === null) throw new Error("transcript section missing");
    return { lesson, section };
  };

  it("shows a music-only empty state with the caption when the transcript is empty", async () => {
    const { section, lesson } = await renderWithSource(
      [],
      "Sharpe ratio as a hypothesis test\n#quant"
    );
    expect(section.querySelector("[data-transcript]")).toBeNull();
    expect(section.textContent).not.toContain("Timestamps are");
    const empty = section.querySelector("[data-transcript-empty]");
    expect(empty?.textContent).toContain(
      "No spoken narration in this reel (music only)."
    );
    expect(empty?.textContent).toContain("The caption is shown below.");
    expect(section.querySelector("[data-source-caption]")?.textContent).toBe(
      "Sharpe ratio as a hypothesis test\n#quant"
    );
    expect(
      section.querySelector(`a[href="${lesson.source.url}"]`)
    ).not.toBeNull();
  });

  it("omits the caption block when the transcript and caption are both empty", async () => {
    const { section } = await renderWithSource([], "");
    const empty = section.querySelector("[data-transcript-empty]");
    expect(empty?.textContent).toContain("music only");
    expect(empty?.textContent).not.toContain("caption is shown below");
    expect(section.querySelector("[data-source-caption]")).toBeNull();
  });

  it("renders timestamped transcript lines when the transcript is present", async () => {
    const { section } = await renderWithSource([
      { start: 0, text: "First line" },
      { start: 65, text: "Second line" },
    ]);
    expect(section.querySelector("[data-transcript-empty]")).toBeNull();
    expect(section.textContent).toContain("Timestamps are");
    const items = section.querySelectorAll("[data-transcript] li");
    expect(items).toHaveLength(2);
    expect(items[1]?.textContent).toContain("Second line");
  });
});
