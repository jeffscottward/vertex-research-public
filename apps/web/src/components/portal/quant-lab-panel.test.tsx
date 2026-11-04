// @vitest-environment jsdom
import type {
  ApiClient,
  QuantLabListOutput,
  QuantLabStudy,
} from "@darkfactory/api";
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

import BacktestsPage from "../../app/(portal)/backtests/page.tsx";
import {
  createBrowserQuantLabGateway,
  criterionLines,
  formatPct,
  formatRatio,
  paperClaim,
  paperHref,
  pdfLabel,
  QUANT_LAB_RECORD_COMMAND,
  QUANT_LAB_RESEARCH_NOTICE,
  QuantLabPanel,
  readingLabel,
  studyMetrics,
} from "./quant-lab-panel.tsx";

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

type Paper = NonNullable<QuantLabStudy["paper"]>;
type Backtest = NonNullable<QuantLabStudy["backtest"]>;

const paper = (overrides: Partial<Paper> = {}): Paper => ({
  id: "paper-ssrn-2242795",
  identifier: "10.2139/ssrn.2242795",
  sourceUrl: "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2242795",
  stage: "backtested",
  title: "The Real-Life Performance of Market Timing",
  verdict: "inconclusive",
  ...overrides,
});

const backtest = (overrides: Partial<Backtest> = {}): Backtest => ({
  createdAt: NOW,
  id: "bt-quantlab-7eb540a22b92-aaaaaaaaaaaa",
  instruments: "SPY",
  maxDrawdown: -0.2428,
  metrics: {
    bh_cagr: 0.111_482,
    bh_max_drawdown: -0.551_894,
    bh_sharpe: 0.5696,
    wf_cagr: 0.091_479,
    wf_max_drawdown: -0.242_813,
    wf_sharpe: 0.6354,
  },
  notes: [
    "Quant Lab verdict: inconclusive (3/4 preregistered criteria passed).",
    "PASS walk_forward_sharpe_gt_benchmark: Sharpe above buy and hold.",
    "",
    "FAIL oos_sharpe_gt_benchmark: Fixed out-of-sample Sharpe below.",
  ].join("\n"),
  periodEnd: "2026-10-16",
  periodStart: "2003-10-01",
  ...overrides,
});

const study = (overrides: Partial<QuantLabStudy> = {}): QuantLabStudy => ({
  backtest: backtest(),
  createdAt: NOW,
  hypothesis: "A 10-month SMA cuts drawdown.",
  id: "spec-7eb540a22b92aaaa",
  name: "SMA timing (Zakamulin 2013)",
  ourReading: {
    costs: { note: null, per_side_bps: 2, stress: true },
    gaps: ["No full text", 3, null],
    interpretation: "Faber form of the moving-average rule.",
    reviewed: false,
    reviewer: null,
  },
  paper: paper(),
  paperClaims: [
    { locator: "abstract", quote: "Performance is highly overstated." },
    { page: 4 },
  ],
  specKey: "zakamulin-2013-sma-timing",
  specSha256: "7".repeat(64),
  strategy: {
    id: "strategy-quantlab-zakamulin-2013-sma-timing",
    slug: "quantlab-zakamulin-2013-sma-timing",
    status: "backtested",
  },
  ...overrides,
});

const capture = (
  overrides: Partial<QuantLabListOutput["captures"][number]> = {}
) => ({
  capturedAt: NOW,
  doi: "10.2139/ssrn.2242795",
  id: "capture-0123456789abcdef",
  pdfStatus: "metadata_only:no_open_access_copy",
  ssrnId: "2242795",
  title: "The Real-Life Performance of Market Timing",
  topic: "market timing",
  url: "https://doi.org/10.2139/ssrn.2242795",
  version: "2013-04-01T00:00:00Z",
  ...overrides,
});

const output = (
  overrides: Partial<QuantLabListOutput> = {}
): QuantLabListOutput => ({
  captures: [capture()],
  studies: [study()],
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

describe("quant lab view helpers", () => {
  it("links the DOI first, then an http source URL, else nothing", () => {
    expect(paperHref(paper())).toBe("https://doi.org/10.2139/ssrn.2242795");
    expect(paperHref(paper({ identifier: "arxiv:1234" }))).toBe(
      "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2242795"
    );
    expect(
      paperHref(paper({ identifier: null, sourceUrl: "javascript:alert(1)" }))
    ).toBeNull();
    expect(paperHref(paper({ identifier: null, sourceUrl: null }))).toBeNull();
    expect(paperHref(null)).toBeNull();
  });

  it("formats walk-forward metrics against buy and hold", () => {
    expect(formatRatio(null)).toBe("—");
    expect(formatPct(null)).toBe("—");
    expect(studyMetrics(backtest())).toEqual([
      { benchmark: "0.57", label: "Sharpe", strategy: "0.64" },
      { benchmark: "11.1%", label: "CAGR", strategy: "9.1%" },
      { benchmark: "-55.2%", label: "Max drawdown", strategy: "-24.3%" },
    ]);
    expect(
      studyMetrics(
        backtest({ maxDrawdown: -0.1, metrics: { wf_sharpe: "n/a" } })
      )
    ).toEqual([{ benchmark: "—", label: "Max drawdown", strategy: "-10.0%" }]);
    expect(studyMetrics(backtest({ maxDrawdown: null, metrics: {} }))).toEqual(
      []
    );
  });

  it("splits notes into PASS/FAIL criteria and plain lines", () => {
    expect(criterionLines(null)).toEqual([]);
    expect(criterionLines("PASS a: b\nFAIL c: d\n  \nSpec x")).toEqual([
      { outcome: "pass", text: "a: b" },
      { outcome: "fail", text: "c: d" },
      { outcome: null, text: "Spec x" },
    ]);
  });

  it("reads claims, reading labels and PDF status", () => {
    expect(paperClaim({ locator: "abstract", quote: "q" })).toEqual({
      locator: "abstract",
      quote: "q",
    });
    expect(paperClaim({ locator: 7, page: 4 })).toEqual({
      locator: null,
      quote: '{"locator":7,"page":4}',
    });
    expect(readingLabel("per_side_bps")).toBe("Per side bps");
    expect(pdfLabel("retained")).toBe("Retained");
    expect(pdfLabel("metadata_only:no_open_access_copy")).toBe(
      "Metadata only (no open access copy)"
    );
  });
});

describe("QuantLabPanel", () => {
  it("shows each study with paper link, verdict, metrics and backtest link", async () => {
    const container = await mount(
      <QuantLabPanel gateway={{ list: async () => output() }} />
    );
    const section = container.querySelector(
      "section[aria-labelledby='quant-lab-heading']"
    );
    expect(section?.getAttribute("data-quant-lab-state")).toBe("ready");
    expect(section?.querySelector("h2")?.textContent).toBe("Quant Lab");
    expect(section?.textContent).toContain(QUANT_LAB_RESEARCH_NOTICE);
    const card = container.querySelector(
      "[data-quant-lab-study='spec-7eb540a22b92aaaa']"
    );
    expect(card?.querySelector("h3")?.textContent).toBe(
      "SMA timing (Zakamulin 2013)"
    );
    const paperLink = card?.querySelector("a[target='_blank']");
    expect(paperLink?.getAttribute("href")).toBe(
      "https://doi.org/10.2139/ssrn.2242795"
    );
    expect(paperLink?.getAttribute("rel")).toBe("noreferrer");
    expect(
      card?.querySelector("[data-verdict]")?.getAttribute("data-verdict")
    ).toBe("inconclusive");
    expect(
      card?.querySelector("[data-verdict]")?.getAttribute("data-status")
    ).toBe("warning");
    expect(card?.textContent).toContain("2003-10-01 to 2026-10-16");
    expect(
      card?.querySelector("a[href^='/backtests?id=']")?.getAttribute("href")
    ).toBe("/backtests?id=bt-quantlab-7eb540a22b92-aaaaaaaaaaaa");
    expect(card?.querySelector("[data-metric='Sharpe']")?.textContent).toBe(
      "Sharpe0.640.57"
    );
    const detail = card?.querySelector("[data-quant-lab-detail]");
    expect(detail?.querySelector("blockquote")?.textContent).toBe(
      "Performance is highly overstated."
    );
    expect(detail?.textContent).toContain("Source: abstract");
    expect(detail?.textContent).toContain('{"page":4}');
    expect(detail?.textContent).toContain("InterpretationFaber form");
    expect(detail?.textContent).toContain("Per side bps: 2");
    expect(detail?.textContent).toContain("Stress: true");
    expect(detail?.textContent).toContain("Note: —");
    expect(detail?.textContent).toContain("Reviewedfalse");
    expect(detail?.textContent).toContain("Reviewer—");
    const outcomes = [
      ...(detail?.querySelectorAll("[data-outcome]") ?? []),
    ].map((badge) => badge.getAttribute("data-outcome"));
    expect(outcomes).toEqual(["pass", "fail"]);
    expect(
      detail?.querySelector("[data-quant-lab-criteria]")?.children
    ).toHaveLength(3);
    const row = container.querySelector(
      "[data-capture='capture-0123456789abcdef']"
    );
    expect(row?.querySelector("a")?.getAttribute("href")).toBe(
      "https://doi.org/10.2139/ssrn.2242795"
    );
    expect(row?.textContent).toContain("Metadata only (no open access copy)");
    expect(row?.textContent).toContain("2026-11-03 10:00");
  });

  it("handles studies without paper, link, backtest or notes", async () => {
    const container = await mount(
      <QuantLabPanel
        gateway={{
          list: async () =>
            output({
              captures: [capture({ url: "ftp://example.test/paper" })],
              studies: [
                study({ backtest: null, id: "spec-a", paper: null }),
                study({
                  backtest: backtest({ notes: null }),
                  id: "spec-b",
                  paper: paper({
                    identifier: null,
                    sourceUrl: null,
                    verdict: "rejected",
                  }),
                }),
              ],
            }),
        }}
      />
    );
    const bare = container.querySelector("[data-quant-lab-study='spec-a']");
    expect(bare?.textContent).toContain("No linked paper");
    expect(bare?.textContent).toContain("No backtest yet.");
    expect(bare?.querySelector("[data-verdict]")?.textContent).toContain(
      "pending"
    );
    expect(bare?.textContent).toContain("No backtest notes.");
    const unlinked = container.querySelector("[data-quant-lab-study='spec-b']");
    expect(unlinked?.querySelector("a[target='_blank']")).toBeNull();
    expect(unlinked?.textContent).toContain(
      "The Real-Life Performance of Market Timing"
    );
    expect(
      unlinked?.querySelector("[data-verdict]")?.getAttribute("data-status")
    ).toBe("destructive");
    expect(container.querySelector("[data-capture] a")).toBeNull();
  });

  it("shows the empty state with the recorder command", async () => {
    const container = await mount(
      <QuantLabPanel
        gateway={{ list: async () => output({ captures: [], studies: [] }) }}
      />
    );
    expect(container.textContent).toContain(
      "No Quant Lab studies recorded yet"
    );
    expect(container.querySelector("code")?.textContent).toBe(
      QUANT_LAB_RECORD_COMMAND
    );
    expect(container.textContent).toContain("No captures yet.");
  });

  it("shows loading, then errors with a retry, and operator-only text", async () => {
    let resolveFirst: (value: QuantLabListOutput) => void = () => undefined;
    const pending = new Promise<QuantLabListOutput>((resolve) => {
      resolveFirst = resolve;
    });
    const container = await mount(
      <QuantLabPanel gateway={{ list: () => pending }} />
    );
    const loading = container.querySelector("[aria-busy='true']");
    expect(loading?.getAttribute("role")).toBe("status");
    expect(loading?.className).toContain("min-h-40");
    await act(async () => resolveFirst(output()));
    expect(
      container
        .querySelector("[data-quant-lab-state]")
        ?.getAttribute("data-quant-lab-state")
    ).toBe("ready");

    let calls = 0;
    const failing = await mount(
      <QuantLabPanel
        gateway={{
          list: async () => {
            calls += 1;
            if (calls === 1)
              throw {
                code: "STORAGE_ERROR",
                message: "Quant Lab storage unavailable",
              };
            return output();
          },
        }}
      />
    );
    expect(failing.querySelector("[role='alert']")?.textContent).toBe(
      "Quant Lab unavailable. STORAGE_ERROR: Quant Lab storage unavailable"
    );
    await act(async () => failing.querySelector("button")?.click());
    expect(
      failing
        .querySelector("[data-quant-lab-state]")
        ?.getAttribute("data-quant-lab-state")
    ).toBe("ready");

    const denied = await mount(
      <QuantLabPanel
        gateway={{
          list: async () => {
            throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
          },
        }}
      />
    );
    expect(denied.textContent).toContain(
      "Quant Lab studies are limited to operators."
    );
  });

  it("creates the browser client lazily, once, on the page origin", async () => {
    const list = vi.fn(async () => output());
    runtime.client = { quantLab: { list } } as unknown as ApiClient;
    const gateway = createBrowserQuantLabGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.list();
    await gateway.list();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(Object.isFrozen(gateway)).toBe(true);
    await mount(<QuantLabPanel />);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("is part of the Backtests page below the backtests workspace", () => {
    const view = document.createElement("div");
    view.innerHTML = renderToStaticMarkup(<BacktestsPage />);
    const section = view.querySelector("#quant-lab-heading");
    expect(section?.textContent).toBe("Quant Lab");
    expect(view.querySelectorAll("h1")).toHaveLength(1);
    const headings = [...view.querySelectorAll("h2")].map(
      (heading) => heading.textContent
    );
    expect(headings.indexOf("Quant Lab")).toBeLessThan(
      headings.indexOf("Filter studies")
    );
  });
});
