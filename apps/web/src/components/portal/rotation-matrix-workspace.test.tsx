// @vitest-environment jsdom
import type { RotationMatrixOutput } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ResearchLensesGateway } from "./research-lenses-client.ts";
import { rotationFixture } from "./research-lenses-test-fixtures.ts";
import {
  formatReturn,
  heatColor,
  parseRotationMatrixParams,
  type RotationMatrixSettings,
  RotationMatrixWorkspace,
  rotationMatrixSearch,
} from "./rotation-matrix-workspace.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  window.history.replaceState(null, "", "/");
  return document.body.replaceChildren();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const gatewayWith = (
  rotationMatrix: ResearchLensesGateway["rotationMatrix"]
): ResearchLensesGateway => ({
  rotationMatrix,
  deepValue: vi.fn(),
  score: vi.fn(),
});

const render = async (
  gateway: ResearchLensesGateway,
  initial?: RotationMatrixSettings
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      initial === undefined ? (
        <RotationMatrixWorkspace gateway={gateway} />
      ) : (
        <RotationMatrixWorkspace gateway={gateway} initial={initial} />
      )
    );
    return await flush();
  });
  return container;
};

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  return await act(async () => {
    (element as HTMLElement).click();
    return await flush();
  });
};

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find(
    (element) =>
      element.textContent === text ||
      element.getAttribute("aria-label") === text
  );

const typeFilter = async (container: HTMLElement, value: string) => {
  const input = container.querySelector(
    'input[type="search"]'
  ) as HTMLInputElement;
  return await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return await flush();
  });
};

const industryRows = (container: HTMLElement) =>
  [...container.querySelectorAll('tbody th[scope="row"]')].map(
    (cell) => cell.textContent
  );

const kpi = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-kpi="${id}"]`)?.textContent;

const status = (container: HTMLElement) =>
  container
    .querySelector('[data-slot="page-status"]')
    ?.textContent?.replace(/^Status:/u, "");

describe("rotation matrix helpers", () => {
  it("colors gains green, losses red and unknown values transparent", () => {
    expect(heatColor(10, "1M")).toBe("rgba(22, 163, 74, 0.85)");
    expect(heatColor(-1.5, "1D")).toBe("rgba(220, 38, 38, 0.50)");
    expect(heatColor(-100, "6M")).toBe("rgba(220, 38, 38, 0.85)");
    expect(heatColor(null, "3M")).toBe("transparent");
    return expect(heatColor(Number.NaN, "3M")).toBe("transparent");
  });

  it("formats returns with a sign", () => {
    expect(formatReturn(4.26)).toBe("+4.3%");
    expect(formatReturn(-2)).toBe("-2.0%");
    expect(formatReturn(0)).toBe("0.0%");
    return expect(formatReturn(null)).toBe("–");
  });

  return it("reads and writes the period URL parameter", () => {
    expect(parseRotationMatrixParams({})).toEqual({ period: "1M" });
    expect(parseRotationMatrixParams({ period: "3M" })).toEqual({
      period: "3M",
    });
    expect(parseRotationMatrixParams({ period: "2Y" })).toEqual({
      period: "1M",
    });
    expect(rotationMatrixSearch({ period: "1M" })).toBe("");
    return expect(rotationMatrixSearch({ period: "6M" })).toBe("?period=6M");
  });
});

describe("RotationMatrixWorkspace", () => {
  it("renders the header, KPIs, summary, our names and the grouped matrix by default", async () => {
    const rotationMatrix = vi.fn(async () => rotationFixture());
    const container = await render(gatewayWith(rotationMatrix));
    expect(rotationMatrix).toHaveBeenCalledWith("1M");
    expect(container.querySelector("h1")?.textContent).toBe("Rotation matrix");
    expect(status(container)).toBe("As of 2026-10-21");
    expect(window.location.search).toBe("");
    expect(button(container, "1M")?.getAttribute("aria-pressed")).toBe("true");
    expect(button(container, "6M")?.getAttribute("aria-pressed")).toBe("false");
    expect(kpi(container, "leading")).toBe(
      "Leading industry (1M)+6.0%Oil & Gas Production"
    );
    expect(kpi(container, "lagging")).toBe(
      "Lagging industry (1M)-2.5%Water Supply"
    );
    expect(kpi(container, "standouts")).toBe(
      "Standouts (> 2σ vs industry)1Top: HPK +42.4%"
    );
    const text = container.textContent;
    expect(text).toContain(
      "Median returns for 3,022 US-listed stocks by sector, industry and cap bucket. Color scale ±10%."
    );
    expect(text).toContain("Leading industries (1M)");
    expect(text).toContain("HPK +42.4% z=3.1 · Oil & Gas Production");
    expect(text).toContain(
      "Leaders in leading industries (1M and 3M top quintile): XOM"
    );
    expect(text).toContain("2 tracked names by cell");
    expect(text).toContain("Sources: Nasdaq stock screener; Yahoo Finance");
    expect(industryRows(container)).toEqual([
      "XOM",
      "OLD",
      "Oil & Gas Production ▲",
      "Oil Refining",
      "Water Supply ▼",
    ]);
    // Every symbol links to its stock page.
    const tickerLinks = [
      ...container.querySelectorAll('[data-slot="ticker-link"]'),
    ].map((link) => link.getAttribute("href"));
    expect(tickerLinks).toEqual([
      "/stock/HPK",
      "/stock/XOM",
      "/stock/XOM",
      "/stock/OLD",
    ]);
    const scroll = container.querySelector(
      '[aria-labelledby="rotation-matrix-heading"] [data-slot="table-scroll"]'
    );
    expect(scroll?.getAttribute("aria-label")).toBe("Rotation matrix for 1M");
    // The empty sector has no industries and is not listed.
    expect(text).not.toContain("Empty Sector");
    return expect(
      container.querySelector('a[href="https://finviz.com/map.ashx?t=sec_all"]')
    ).not.toBeNull();
  });

  it("opens a cell, a cell without a symbol list and the all-caps column", async () => {
    const container = await render(
      gatewayWith(vi.fn(async () => rotationFixture()))
    );
    await click(
      button(container, "Oil & Gas Production large: +5.0%, 3 names")
    );
    let detail = container.querySelector('[aria-label="Selected cell"]');
    expect(detail?.textContent).toContain("Oil & Gas Production · large · 1M");
    expect(detail?.textContent).toContain("Industry rank 1 (quintile 1).");
    expect(detail?.querySelector("a")?.getAttribute("href")).toBe("/stock/XOM");
    expect(detail?.textContent).toContain("$12.0B");
    await click(
      button(container, "Oil & Gas Production small: +9.0%, 1 names")
    );
    detail = container.querySelector('[aria-label="Selected cell"]');
    // No symbol list in the cell: every cap bucket of the industry is listed.
    expect(detail?.textContent).toContain("XOM");
    await click(button(container, "Oil Refining all caps: +1.0%, 3 names"));
    detail = container.querySelector('[aria-label="Selected cell"]');
    expect(detail?.textContent).toContain("Oil Refining · All caps · 1M");
    expect(detail?.textContent).toContain("PSX –");
    expect(detail?.textContent).not.toContain("Industry rank");
    expect(detail?.textContent).toContain("DK –");
    await click(button(container, "Oil Refining mid: –, 1 names"));
    detail = container.querySelector('[aria-label="Selected cell"]');
    expect(detail?.textContent).toContain("–% of 1 names up.");
    await click(button(container, "Close"));
    return expect(
      container.querySelector('[aria-label="Selected cell"]')
    ).toBeNull();
  });

  it("filters by industry text and by exact symbol, and clears a filter with no match", async () => {
    const container = await render(
      gatewayWith(vi.fn(async () => rotationFixture()))
    );
    await typeFilter(container, "water");
    expect(industryRows(container)).toEqual(["XOM", "OLD", "Water Supply ▼"]);
    await typeFilter(container, "psx");
    expect(industryRows(container)).toEqual(["XOM", "OLD", "Oil Refining"]);
    await typeFilter(container, " nothing-matches ");
    expect(industryRows(container)).toEqual(["XOM", "OLD"]);
    expect(container.textContent).toContain(
      "No industry, sector or symbol matches “nothing-matches”."
    );
    await click(button(container, "Clear filter"));
    expect(
      (container.querySelector('input[type="search"]') as HTMLInputElement)
        .value
    ).toBe("");
    return expect(industryRows(container)).toHaveLength(5);
  });

  it("switches period, writes it to the URL, closes the selection and handles empty optional data", async () => {
    window.history.replaceState(null, "", "/rotation-matrix#matrix");
    const rotationMatrix = vi.fn(async (period: "1D" | "1M" | "3M" | "6M") =>
      period === "1M"
        ? rotationFixture()
        : rotationFixture(period, {
            asOf: null,
            bottom: [],
            ours: [],
            source: null,
            standouts: [],
            top: [],
          })
    );
    const container = await render(gatewayWith(rotationMatrix));
    await click(
      button(container, "Oil & Gas Production large: +5.0%, 3 names")
    );
    await click(button(container, "6M"));
    expect(rotationMatrix).toHaveBeenLastCalledWith("6M");
    expect(window.location.pathname).toBe("/rotation-matrix");
    expect(window.location.search).toBe("?period=6M");
    expect(window.location.hash).toBe("#matrix");
    expect(button(container, "6M")?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[aria-label="Selected cell"]')).toBeNull();
    expect(status(container)).toBe("As of unknown");
    expect(kpi(container, "leading")).toBe(
      "Leading industry (6M)–No ranked industry"
    );
    expect(kpi(container, "lagging")).toBe(
      "Lagging industry (6M)–No ranked industry"
    );
    expect(kpi(container, "standouts")).toBe(
      "Standouts (> 2σ vs industry)0None above 2σ"
    );
    const text = container.textContent;
    expect(text).toContain("Color scale ±30%.");
    expect(text).toContain("No wish-list or re-entry name is a leader");
    expect(text).toContain("Sources: unknown; unknown.");
    expect(
      container.querySelector('a[href="https://finviz.com/map.ashx?t=sec_all"]')
    ).not.toBeNull();
    await click(button(container, "1M"));
    return expect(window.location.search).toBe("");
  });

  it("starts from the URL period and refreshes on demand", async () => {
    const leader = (symbol: string) => ({
      cap: "large" as const,
      cell1M: "leading",
      cell3M: "leading",
      covered: true,
      industry: "Oil & Gas Production",
      opportunity: true,
      roles: ["wish"],
      sector: "Energy",
      symbol,
    });
    const rotationMatrix = vi.fn(async (period: "1D" | "1M" | "3M" | "6M") =>
      rotationFixture(period, { ours: [leader("XOM"), leader("CVX")] })
    );
    const container = await render(gatewayWith(rotationMatrix), {
      period: "3M",
    });
    expect(rotationMatrix).toHaveBeenCalledWith("3M");
    expect(container.textContent).toContain(
      "Leaders in leading industries (1M and 3M top quintile): XOM, CVX"
    );
    expect(window.location.search).toBe("?period=3M");
    expect(button(container, "3M")?.getAttribute("aria-pressed")).toBe("true");
    await click(button(container, "Refresh"));
    expect(rotationMatrix).toHaveBeenCalledTimes(2);
    return expect(rotationMatrix).toHaveBeenLastCalledWith("3M");
  });

  it("keeps the newest period when an older response arrives late", async () => {
    let releaseSlow: (matrix: RotationMatrixOutput) => void = () => undefined;
    const slow = new Promise<RotationMatrixOutput>((resolve) => {
      releaseSlow = resolve;
    });
    const rotationMatrix = vi.fn(async (period: "1D" | "1M" | "3M" | "6M") =>
      period === "1M" ? slow : rotationFixture(period, { asOf: "2026-04-01" })
    );
    const container = await render(gatewayWith(rotationMatrix));
    expect(status(container)).toBe("Loading");
    expect(button(container, "Refresh")?.hasAttribute("disabled")).toBe(true);
    await click(button(container, "1D"));
    await act(async () => {
      releaseSlow(rotationFixture());
      return await flush();
    });
    return expect(status(container)).toBe("As of 2026-04-01");
  });

  it("creates the browser gateway when none is supplied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    try {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await act(async () => {
        root.render(<RotationMatrixWorkspace />);
        for (let index = 0; index < 200; index += 1) await Promise.resolve();
      });
      return expect(container.textContent).toMatch(
        /Loading rotation matrix|Rotation matrix unavailable/u
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  return it("shows loading, the server message on failure and retries", async () => {
    let fail = true;
    const rotationMatrix = vi.fn(async () => {
      if (fail)
        throw Object.assign(new Error("Rotation matrix not yet collected"), {
          code: "NOT_FOUND",
        });
      return rotationFixture();
    });
    const container = await render(gatewayWith(rotationMatrix));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Rotation matrix unavailable: Rotation matrix not yet collected"
    );
    expect(status(container)).toBe("Unavailable");
    expect(container.querySelector('[data-slot="kpi-row"]')).toBeNull();
    fail = false;
    await click(button(container, "Try again"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const pending = vi.fn(() => new Promise<never>(() => undefined));
    const loading = await render(gatewayWith(pending));
    return expect(
      loading.querySelector('[role="status"]')?.textContent
    ).toContain("Loading rotation matrix…");
  });
});
