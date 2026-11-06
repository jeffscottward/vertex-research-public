// @vitest-environment jsdom
import type {
  ApiClient,
  ResearchReportDatasetName,
  ResearchReportDatasetOutput,
  ResearchReportsListOutput,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
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
  ResearchReportsCatalog,
  type ResearchReportsGateway,
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
  // The catalog filter (?q=) and the dataset tabs (?tab=) write the URL.
  window.history.replaceState(null, "", "/");
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

const text = (container: ParentNode, selector: string) =>
  container.querySelector(selector)?.textContent;

const typeInto = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const kpis = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-slot='kpi-card']")].map((card) => [
    card.querySelector("dt")?.textContent,
    card.querySelector("dd")?.textContent,
  ]);

describe("research dossier catalog", () => {
  it("shows a header, KPIs and one panel per group with dossier and ticker links", async () => {
    const container = await mount(
      <ResearchReportsCatalog gateway={gatewayOf()} />
    );
    expect(state(container, "data-research-reports-state")).toBe("ready");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(text(container, "h1")).toBe("Research dossiers");
    expect(text(container, "[data-slot='page-status']")).toBe(
      "Status:Research only"
    );
    expect(
      container
        .querySelector("[data-slot='page-breadcrumb'] a")
        ?.getAttribute("href")
    ).toBe("/research");
    expect(kpis(container)).toEqual([
      ["Dossiers", "2"],
      ["Groups", "2"],
      ["Company research", "1"],
      ["Last updated", "2026-11-03"],
    ]);
    expect(text(container, "#research-group-group")).toBe("Group");
    const group = container.querySelector("[data-research-group='group']");
    expect(group?.getAttribute("data-slot")).toBe("panel");
    expect(
      group
        ?.querySelector("[data-slot='table-scroll']")
        ?.getAttribute("aria-label")
    ).toBe("Group dossiers");
    const dossier = container.querySelector(
      "[data-research-report='AAA'] [data-research-dossier-link]"
    );
    expect(dossier?.getAttribute("href")).toBe("/research/reports/AAA");
    expect(dossier?.textContent).toBe("Fixture A");
    const ticker = container.querySelector(
      "[data-research-report='AAA'] [data-slot='ticker-link']"
    );
    expect(ticker?.getAttribute("href")).toBe("/stock/AAA");
    expect(ticker?.textContent).toBe("AAA");
    const other = container.querySelector("[data-research-report='BBB']");
    expect(
      other
        ?.closest("[data-research-group]")
        ?.getAttribute("data-research-group")
    ).toBe("other");
    expect(other?.textContent).toContain("Accepted");
    expect(text(container, "[data-research-reports-shown]")).toBe(
      "2 of 2 dossiers"
    );
  });

  it("filters by symbol or name and keeps the filter in ?q=", async () => {
    window.history.replaceState(null, "", "/research/reports?q=fixture+b#top");
    const container = await mount(
      <ResearchReportsCatalog gateway={gatewayOf()} />
    );
    // A well-known node: the catalog renders one search box once it is ready.
    const input = container.querySelector(
      "input[type='search']"
    ) as HTMLInputElement;
    expect(input.value).toBe("fixture b");
    expect(container.querySelector("[data-research-report='AAA']")).toBeNull();
    expect(
      container.querySelector("[data-research-report='BBB']")
    ).not.toBeNull();
    expect(text(container, "[data-research-reports-shown]")).toBe(
      "1 of 2 dossiers"
    );
    await typeInto(input, "aaa");
    expect(window.location.search).toBe("?q=aaa");
    expect(window.location.hash).toBe("#top");
    expect(container.querySelector("[data-research-report='BBB']")).toBeNull();
    await typeInto(input, "zzz");
    expect(container.textContent).toContain("No dossier matches “zzz”.");
    expect(container.querySelector("[data-research-group]")).toBeNull();
    await typeInto(input, " ");
    expect(window.location.search).toBe("");
    expect(container.querySelectorAll("[data-research-group]")).toHaveLength(2);
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    await act(async () =>
      container.querySelector("form[role='search']")?.dispatchEvent(submit)
    );
    expect(submit.defaultPrevented).toBe(true);
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
    expect(empty.querySelector("[data-slot='kpi-card']")).toBeNull();
    expect(empty.querySelector("input[type='search']")).toBeNull();

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
    expect(text(failing, "[data-slot='page-status']")).toBe(
      "Status:Unavailable"
    );
    await act(async () =>
      (
        failing.querySelector("[role='alert'] + button") as HTMLButtonElement
      ).click()
    );
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
    expect(text(denied, "[data-slot='page-status']")).toBe(
      "Status:Operator only"
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
    expect(text(container, "[data-slot='page-status']")).toBe("Status:Loading");
  });

  it("server-renders the loading default with its header", () => {
    window.history.replaceState(null, "", "/research/reports?q=aaa");
    const markup = renderToString(
      <ResearchReportsCatalog gateway={gatewayOf()} />
    );
    expect(markup).toContain('data-research-reports-state="loading"');
    expect(markup).toContain(">Research dossiers</h1>");
    expect(markup).toContain('aria-busy="true"');
  });
});

const tabs = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLButtonElement>("[role='tab']"),
];
const openTab = async (container: HTMLElement, label: string) =>
  await act(async () =>
    tabs(container)
      .find((tab) => tab.textContent === label)
      ?.click()
  );
const selected = (container: HTMLElement) =>
  tabs(container)
    .filter((tab) => tab.getAttribute("aria-selected") === "true")
    .map((tab) => tab.textContent);

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
    expect(text(container, "h1")).toBe("AAA dossier");
    expect(text(container, "[data-slot='page-status']")).toBe(
      "Status:Research only"
    );
    const back = container.querySelector("[data-slot='page-breadcrumb'] a");
    expect(back?.getAttribute("href")).toBe("/research/reports");
    expect(back?.textContent).toBe("Research dossiers");
    expect(
      container.querySelector("[data-slot='ticker-link']")?.getAttribute("href")
    ).toBe("/stock/AAA");
    expect(tabs(container).map((tab) => tab.textContent)).toEqual([
      "Fundamentals",
      "Technicals",
      "Options analysis",
      "Committee",
      "News",
      "Market",
    ]);
    expect(text(container, "#research-dataset-heading")).toBe("Fundamentals");
    expect(container.textContent).toContain("fundamentals summary");
    expect(container.textContent).toContain("fundamentals title");
    expect(container.textContent).toContain("Fixture warning");
    expect(container.textContent).toContain("Fixture item summary");
    expect(
      container
        .querySelector("[data-dataset-metrics] [data-slot='table-scroll']")
        ?.getAttribute("aria-label")
    ).toBe("Fundamentals metrics");
    expect(
      [...container.querySelectorAll("[data-dataset-metrics] tbody tr")].map(
        (row) => row.textContent
      )
    ).toEqual(["Revenue1 USD—", "Score2FY"]);
    expect(text(container, "[data-dataset-section='s'] summary")).toBe(
      "fundamentals section"
    );
    expect(text(container, "[data-dataset-sources] h2")).toBe("Sources (2)");
    expect(
      container
        .querySelector("[aria-label='News items'] a")
        ?.getAttribute("href")
    ).toBe("https://example.test/n");
    expect(selected(container)).toEqual(["Fundamentals"]);
    await openTab(container, "News");
    expect(read).toHaveBeenLastCalledWith("AAA", "news");
    expect(selected(container)).toEqual(["News"]);
    expect(window.location.search).toBe("?tab=news");
    expect(text(container, "#research-dataset-heading")).toBe("News");
    expect(container.textContent).toContain("news summary");
  });

  it("links the report's real symbol, not its id", async () => {
    const base = catalog();
    const brk = { ...base.reports[0]!, id: "brk-b", symbol: "BRK.B" };
    const container = await mount(
      <ResearchReportDetail
        gateway={gatewayOf({
          list: async () => ({ ...base, reports: [brk] }),
        })}
        reportId="brk-b"
      />
    );
    expect(
      container.querySelector("[data-slot='ticker-link']")?.getAttribute("href")
    ).toBe("/stock/BRK.B");
  });

  it("shows no ticker link when the symbol is unknown", async () => {
    for (const list of [
      async () => catalog(),
      async () => Promise.reject(new Error("down")),
    ]) {
      const container = await mount(
        <ResearchReportDetail gateway={gatewayOf({ list })} reportId="ZZZ" />
      );
      expect(container.querySelector("[data-slot='ticker-link']")).toBeNull();
      expect(container.textContent).toContain("Imported research for ZZZ,");
    }
  });

  it("opens the dataset named by ?tab= without reading the default first", async () => {
    window.history.replaceState(null, "", "/research/reports/AAA?tab=market");
    const read = vi.fn(gatewayOf().dataset);
    const container = await mount(
      <ResearchReportDetail
        gateway={gatewayOf({ dataset: read })}
        initialTab="market"
        reportId="AAA"
      />
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("AAA", "market");
    expect(selected(container)).toEqual(["Market"]);
    expect(text(container, "#research-dataset-heading")).toBe("Market");
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
          // Executor form: the apps/web TypeScript lib predates Promise.withResolvers.
          dataset: (_id, name) =>
            new Promise((resolve, reject) => {
              pending.set(name, resolve);
              failures.set(name, reject);
            }),
        })}
        reportId="AAA"
      />
    );
    await openTab(container, "News");
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
    await openTab(container, "Committee");
    await openTab(container, "Market");
    await act(async () =>
      failures.get("committee")?.({ code: "STORAGE_ERROR" })
    );
    await act(async () =>
      pending.get("market")?.(dataset("market", { summary: "market data" }))
    );
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(text(container, "#research-dataset-heading")).toBe("Market");
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
    expect(container.querySelector("[data-dataset-metrics]")).toBeNull();
    expect(container.querySelector("[aria-label='News items']")).toBeNull();
    expect(container.querySelector("[data-dataset-section]")).toBeNull();
    expect(container.textContent).toContain("Revision aaaaaaaaaaaa (1 stored)");
    expect(container.textContent).toContain(
      "This dataset has no summary or warnings."
    );
  });
});

describe("research dossier dataset panels", () => {
  it("shows warnings without a title or summary", async () => {
    const container = await mount(
      <ResearchReportDetail
        gateway={gatewayOf({
          dataset: async (_id, name) =>
            dataset(name, { warnings: ["Only a warning"] }),
        })}
        reportId="AAA"
      />
    );
    expect(text(container, "[data-dataset-warnings] li")).toBe(
      "Only a warning"
    );
    expect(container.textContent).not.toContain(
      "This dataset has no summary or warnings."
    );
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
    expect(list).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
