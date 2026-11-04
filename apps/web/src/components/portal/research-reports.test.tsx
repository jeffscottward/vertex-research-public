// @vitest-environment jsdom
import type {
  ApiClient,
  ResearchReportDatasetName,
  ResearchReportDatasetOutput,
  ResearchReportsListOutput,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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

import {
  createBrowserResearchReportsGateway,
  ResearchReportDetail,
  type ResearchReportsGateway,
  ResearchReportsCatalog,
} from "./research-reports.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  runtime.client = null;
  runtime.origins.length = 0;
});

const NOW = new Date("2026-11-03T10:00:00.000Z");
const hex = (digit: string) => digit.repeat(64);

const catalog = (): ResearchReportsListOutput => ({
  categories: [
    {
      description: "Fixture group",
      id: "group",
      label: "Group",
      reportIds: ["AAA"],
    },
  ],
  reports: [
    {
      assetType: "equity",
      companyResearch: null,
      currency: "USD",
      dataRevision: hex("a"),
      exchange: null,
      id: "AAA",
      identityStatus: "verified",
      importedAt: NOW,
      name: "Fixture A",
      providerSymbol: "AAA",
      sourceUpdatedAt: NOW,
      status: "ready",
      symbol: "AAA",
    },
    {
      assetType: null,
      companyResearch: {
        acceptedAt: NOW,
        reportRevision: null,
        revision: hex("e"),
      },
      currency: null,
      dataRevision: hex("b"),
      exchange: null,
      id: "BBB",
      identityStatus: "verified",
      importedAt: NOW,
      name: "Fixture B",
      providerSymbol: "BBB",
      sourceUpdatedAt: null,
      status: "ready",
      symbol: "BBB",
    },
  ],
});

const dataset = (
  name: ResearchReportDatasetName,
  data: unknown
): ResearchReportDatasetOutput => ({
  byteLength: 10,
  data,
  dataRevision: hex("a"),
  dataset: name,
  reportId: "AAA",
  revisions: [hex("a")],
  sha256: hex("c"),
});

const gatewayOf = (
  overrides: Partial<ResearchReportsGateway> = {}
): ResearchReportsGateway => ({
  dataset: async (_reportId, name) =>
    dataset(name, {
      asOf: "2026-09-10",
      items: [
        {
          summary: "Fixture item summary",
          title: "Fixture headline",
          url: "https://example.test/n",
        },
        { title: "Plain" },
      ],
      metrics: [
        { label: "Revenue", value: "1 USD" },
        { label: "Score", period: "FY", value: 2 },
      ],
      sections: [{ body: ["line"], id: "s", title: `${name} section` }],
      sources: [
        { id: "a", title: "Linked source", url: "https://example.test/s" },
        { id: "b", title: "Plain source" },
      ],
      summary: `${name} summary`,
      title: `${name} title`,
      warnings: ["Fixture warning"],
    }),
  list: async () => catalog(),
  ...overrides,
});

const mount = async (element: React.ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

const state = (container: HTMLElement, attribute: string) =>
  container.querySelector(`[${attribute}]`)?.getAttribute(attribute);

describe("research dossier catalog", () => {
  it("lists reports by group with links to their dossier", async () => {
    const container = await mount(
      <ResearchReportsCatalog gateway={gatewayOf()} />
    );
    expect(state(container, "data-research-reports-state")).toBe("ready");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("#research-group-group")?.textContent).toBe(
      "Group"
    );
    const link = container.querySelector("[data-research-report='AAA'] a");
    expect(link?.getAttribute("href")).toBe("/research/reports/AAA");
    expect(link?.textContent).toBe("AAAFixture A");
    const other = container.querySelector("[data-research-report='BBB']");
    expect(
      other
        ?.closest("[data-research-group]")
        ?.getAttribute("data-research-group")
    ).toBe("other");
    expect(other?.textContent).toContain("Accepted");
  });

  it("shows an empty state, a retryable error and operator-only text", async () => {
    const empty = await mount(
      <ResearchReportsCatalog
        gateway={gatewayOf({
          list: async () => ({ categories: [], reports: [] }),
        })}
      />
    );
    expect(empty.textContent).toContain("No research dossiers imported yet");

    let calls = 0;
    const failing = await mount(
      <ResearchReportsCatalog
        gateway={gatewayOf({
          list: async () => {
            calls += 1;
            if (calls === 1)
              throw {
                code: "STORAGE_ERROR",
                message: "Research report storage unavailable",
              };
            return catalog();
          },
        })}
      />
    );
    expect(failing.querySelector("[role='alert']")?.textContent).toBe(
      "Research dossiers unavailable. STORAGE_ERROR: Research report storage unavailable"
    );
    await act(async () => failing.querySelector("button")?.click());
    expect(state(failing, "data-research-reports-state")).toBe("ready");

    const denied = await mount(
      <ResearchReportsCatalog
        gateway={gatewayOf({
          list: async () => {
            throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
          },
        })}
      />
    );
    expect(denied.textContent).toContain(
      "Research reports are limited to operators."
    );
  });

  it("shows loading while the catalog is pending", async () => {
    const container = await mount(
      <ResearchReportsCatalog
        gateway={gatewayOf({ list: () => new Promise(() => undefined) })}
      />
    );
    const loading = container.querySelector("[aria-busy='true']");
    expect(loading?.getAttribute("role")).toBe("status");
    expect(loading?.textContent).toBe("Loading Research dossiers");
  });
});

describe("research dossier detail", () => {
  it("renders the fundamentals first and switches datasets", async () => {
    const read = vi.fn(gatewayOf().dataset);
    const container = await mount(
      <ResearchReportDetail
        gateway={gatewayOf({ dataset: read })}
        reportId="AAA"
      />
    );
    expect(read).toHaveBeenLastCalledWith("AAA", "fundamentals");
    expect(container.querySelector("h1")?.textContent).toBe("AAA dossier");
    expect(container.textContent).toContain("fundamentals summary");
    expect(container.textContent).toContain("fundamentals title");
    expect(container.textContent).toContain("Fixture warning");
    expect(container.textContent).toContain("Fixture item summary");
    expect(
      container.querySelector("[data-dataset-section='s'] summary")?.textContent
    ).toBe("fundamentals section");
    expect(
      container.querySelector("[data-dataset-sources] summary")?.textContent
    ).toBe("Sources (2)");
    expect(
      container
        .querySelector("[aria-label='News items'] a")
        ?.getAttribute("href")
    ).toBe("https://example.test/n");
    const pressed = () =>
      [...container.querySelectorAll("[aria-pressed='true']")].map((button) =>
        button.getAttribute("data-dataset-tab")
      );
    expect(pressed()).toEqual(["fundamentals"]);
    await act(async () =>
      (
        container.querySelector(
          "[data-dataset-tab='news']"
        ) as HTMLButtonElement
      ).click()
    );
    expect(read).toHaveBeenLastCalledWith("AAA", "news");
    expect(pressed()).toEqual(["news"]);
    expect(
      container.querySelector("#research-dataset-heading")?.textContent
    ).toBe("News");
    expect(container.textContent).toContain("news summary");
  });

  it("keeps the newest dataset when an older request answers last", async () => {
    const pending = new Map<
      ResearchReportDatasetName,
      (value: ResearchReportDatasetOutput) => void
    >();
    const failures = new Map<
      ResearchReportDatasetName,
      (error: unknown) => void
    >();
    const container = await mount(
      <ResearchReportDetail
        gateway={gatewayOf({
          dataset: (_id, name) =>
            new Promise((resolve, reject) => {
              pending.set(name, resolve);
              failures.set(name, reject);
            }),
        })}
        reportId="AAA"
      />
    );
    await act(async () =>
      (
        container.querySelector(
          "[data-dataset-tab='news']"
        ) as HTMLButtonElement
      ).click()
    );
    await act(async () =>
      pending.get("news")?.(dataset("news", { summary: "news data" }))
    );
    await act(async () =>
      pending.get("fundamentals")?.(
        dataset("fundamentals", { summary: "stale data" })
      )
    );
    expect(container.textContent).toContain("news data");
    expect(container.textContent).not.toContain("stale data");
    await act(async () =>
      (
        container.querySelector(
          "[data-dataset-tab='committee']"
        ) as HTMLButtonElement
      ).click()
    );
    await act(async () =>
      (
        container.querySelector(
          "[data-dataset-tab='market']"
        ) as HTMLButtonElement
      ).click()
    );
    await act(async () =>
      failures.get("committee")?.({ code: "STORAGE_ERROR" })
    );
    await act(async () =>
      pending.get("market")?.(dataset("market", { summary: "market data" }))
    );
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(
      container.querySelector("#research-dataset-heading")?.textContent
    ).toBe("Market");
    expect(container.textContent).toContain("market data");
  });

  it("renders a bare dataset and retries a failed read", async () => {
    let calls = 0;
    const container = await mount(
      <ResearchReportDetail
        gateway={gatewayOf({
          dataset: async (_id, name) => {
            calls += 1;
            if (calls === 1)
              throw { code: "NOT_FOUND", message: "Research report not found" };
            return dataset(name, {});
          },
        })}
        reportId="AAA"
      />
    );
    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "Fundamentals dataset unavailable. NOT_FOUND: Research report not found"
    );
    await act(async () =>
      (
        container.querySelector("[role='alert'] + button") as HTMLButtonElement
      ).click()
    );
    expect(state(container, "data-research-report-state")).toBe("ready");
    expect(container.querySelector("[data-dataset-sources]")).toBeNull();
    expect(container.textContent).toContain("Revision aaaaaaaaaaaa (1 stored)");
  });
});

describe("research dossier gateway and entry point", () => {
  it("creates the browser client lazily, once, on the page origin", async () => {
    const list = vi.fn(async () => catalog());
    const read = vi.fn(async () => dataset("market", {}));
    runtime.client = {
      researchReports: { dataset: read, list },
    } as unknown as ApiClient;
    const gateway = createBrowserResearchReportsGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.list();
    await gateway.dataset("AAA", "market");
    expect(read).toHaveBeenCalledWith({ dataset: "market", reportId: "AAA" });
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(Object.isFrozen(gateway)).toBe(true);
    await mount(<ResearchReportsCatalog />);
    await mount(<ResearchReportDetail reportId="AAA" />);
    expect(list).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
