// @vitest-environment jsdom
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
  verdict: "blocked",
  checks: [
    {
      id: "nlv-known",
      title: "NLV known",
      status: "conflict",
      detail: "Feed unavailable",
    },
    {
      id: "options-only",
      title: "Options only",
      status: "conflict",
      detail: "Shares",
    },
    { id: "X06", title: "X06", status: "warn", detail: "Events" },
    { id: "X03", title: "X03", status: "pass", detail: "Defined" },
  ],
  conflicts: ["nlv-known", "options-only"],
  premiumPerPositionUsd: 0,
  premiumPerPositionPctNlv: -1,
  rewardRisk: null,
  nlv: null,
  nlvSource: "unavailable",
  nlvDetail: "Portfolio feed unavailable.",
  statedNlv: null,
  openPremiumInNameUsd: 0,
  otherAllocationsPct: 0,
  unitLossUsd: null,
  structure: "covered_call",
};

const gateway = (): AcademyGateway & {
  deployRequest: ReturnType<typeof vi.fn>;
} => ({
  tickers: vi.fn(async () => ({ tickers: [] })),
  backtest: vi.fn(async () => {
    throw new Error("Backtest not under test");
  }),
  deployPreview: vi.fn(async () => blockedGate),
  deployRequest: vi.fn(
    async (): Promise<AcademyDeployRequestOutput> => ({
      gate: blockedGate,
      request: {
        id: "dr-9",
        status: "requested",
        strategyId: "s",
        strategySlug: "dyr-itm-covered-call-otm-put",
        mode: "paper",
        executionAuthorized: false,
        brokerSubmissionAllowed: false,
      },
      override: {
        used: true,
        auditId: "a-1",
        rules: ["nlv-known", "options-only"],
      },
    })
  ),
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
        slug: "itm-covered-call-otm-put",
        statedNlv: 250_000,
        override: {
          password: "secret-pass",
          acknowledged: ["nlv-known", "options-only"],
          explanation: expect.stringContaining("options-only"),
        },
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
      verdict: "pass",
      conflicts: [],
      nlv: 1_000_000,
      nlvSource: "portfolio-monitor",
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
});
