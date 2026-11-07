// @vitest-environment jsdom
import type { ApiClient, ResearchStudy } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  client: null as ApiClient | null,
  origins: [] as string[],
}));

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn((options: Readonly<{ baseUrl: string }>) => {
    runtime.origins.push(options.baseUrl);
    return runtime.client as ApiClient;
  }),
}));

import { FilterStudySchema } from "@darkfactory/api";

import BacktestsPage from "../../app/(portal)/backtests/page.tsx";
import seeded from "../../features/research-studies/fixtures/adx-filter-study.json";
import {
  createBrowserResearchStudyGateway,
  FILTER_STUDY_ID,
  FilterStudiesSection,
  RESEARCH_STUDIES_IMPORT_COMMAND,
  type ResearchStudyGateway,
} from "./filter-studies-section.tsx";

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

const STUDY: ResearchStudy = {
  id: FILTER_STUDY_ID,
  study: FilterStudySchema.parse(seeded),
  updatedAt: new Date("2026-11-07T12:00:00.000Z"),
};

const mount = async (element: React.ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

const stateOf = (container: HTMLElement): string | null | undefined =>
  container
    .querySelector("[data-filter-studies-state]")
    ?.getAttribute("data-filter-studies-state");

const failing = (error: unknown): ResearchStudyGateway => ({
  get: () => Promise.reject(error),
});

describe("FilterStudiesSection", () => {
  it("loads the ADX/RVOL study through the gateway and shows both tables", async () => {
    const get = vi.fn(async () => STUDY);
    const container = await mount(<FilterStudiesSection gateway={{ get }} />);
    expect(get).toHaveBeenCalledWith("adx-rvol-filters");
    expect(stateOf(container)).toBe("ready");
    expect(
      container.querySelector("#filter-studies-heading")?.textContent
    ).toBe("Filter studies");
    expect(container.querySelectorAll("table")).toHaveLength(2);
    expect(container.textContent).toContain(
      "docs/specs/research/adx-filter.md"
    );
  });

  it("shows loading first, with the heading", async () => {
    let resolve: (value: ResearchStudy) => void = () => undefined;
    // Executor form: the web tsconfig lib predates Promise.withResolvers.
    const pending = new Promise<ResearchStudy>((done) => {
      resolve = done;
    });
    const container = await mount(
      <FilterStudiesSection gateway={{ get: () => pending }} />
    );
    expect(stateOf(container)).toBe("loading");
    const loading = container.querySelector("[aria-busy='true']");
    expect(loading?.getAttribute("role")).toBe("status");
    expect(container.querySelector("h2")?.textContent).toBe("Filter studies");
    await act(async () => resolve(STUDY));
    expect(stateOf(container)).toBe("ready");
  });

  it("shows operator-only text, the import command when missing, and errors with a retry", async () => {
    const denied = await mount(
      <FilterStudiesSection
        gateway={failing({
          code: "FORBIDDEN",
          message: "Forbidden",
          status: 403,
        })}
      />
    );
    expect(stateOf(denied)).toBe("forbidden");
    expect(denied.textContent).toContain(
      "Filter studies are limited to operators."
    );

    const missing = await mount(
      <FilterStudiesSection
        gateway={failing({
          code: "NOT_FOUND",
          message: "Research study not found",
          status: 404,
        })}
      />
    );
    expect(stateOf(missing)).toBe("not-found");
    expect(missing.querySelector("code")?.textContent).toBe(
      RESEARCH_STUDIES_IMPORT_COMMAND
    );

    let calls = 0;
    const broken = await mount(
      <FilterStudiesSection
        gateway={{
          get: async () => {
            calls += 1;
            if (calls === 1)
              throw {
                code: "STORAGE_ERROR",
                message: "Research study storage unavailable",
              };
            return STUDY;
          },
        }}
      />
    );
    expect(stateOf(broken)).toBe("error");
    expect(broken.querySelector("[role='alert']")?.textContent).toBe(
      "Filter studies unavailable. STORAGE_ERROR: Research study storage unavailable"
    );
    await act(async () => broken.querySelector("button")?.click());
    expect(stateOf(broken)).toBe("ready");
  });

  it("treats a study that fails the schema as an error", async () => {
    const container = await mount(
      <FilterStudiesSection
        gateway={{
          get: async () =>
            ({
              ...STUDY,
              study: { id: FILTER_STUDY_ID },
            }) as unknown as ResearchStudy,
        }}
      />
    );
    expect(stateOf(container)).toBe("error");
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Filter studies unavailable. ERROR:"
    );
  });

  it("creates the browser client lazily, once, on the page origin", async () => {
    const get = vi.fn(async () => STUDY);
    runtime.client = { researchStudies: { get } } as unknown as ApiClient;
    const gateway = createBrowserResearchStudyGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.get(FILTER_STUDY_ID);
    await gateway.get(FILTER_STUDY_ID);
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(get).toHaveBeenCalledWith({ id: FILTER_STUDY_ID });
    expect(Object.isFrozen(gateway)).toBe(true);
    await mount(<FilterStudiesSection />);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("is part of the Backtests page below Quant Lab", () => {
    const markup = renderToStaticMarkup(<BacktestsPage />);
    const container = document.createElement("div");
    container.innerHTML = markup;
    expect(
      container.querySelector("#filter-studies-heading")?.textContent
    ).toBe("Filter studies");
    expect(markup.indexOf('id="quant-lab-heading"')).toBeGreaterThan(-1);
    expect(markup.indexOf('id="quant-lab-heading"')).toBeLessThan(
      markup.indexOf('id="filter-studies-heading"')
    );
  });
});
