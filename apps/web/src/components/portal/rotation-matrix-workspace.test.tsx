// @vitest-environment jsdom
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
  RotationMatrixWorkspace,
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

const render = async (gateway: ResearchLensesGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<RotationMatrixWorkspace gateway={gateway} />);
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

describe("rotation matrix helpers", () => {
  it("colors gains green, losses red and unknown values transparent", () => {
    expect(heatColor(10, "1M")).toBe("rgba(22, 163, 74, 0.85)");
    expect(heatColor(-1.5, "1D")).toBe("rgba(220, 38, 38, 0.50)");
    expect(heatColor(-100, "6M")).toBe("rgba(220, 38, 38, 0.85)");
    expect(heatColor(null, "3M")).toBe("transparent");
    return expect(heatColor(Number.NaN, "3M")).toBe("transparent");
  });

  return it("formats returns with a sign", () => {
    expect(formatReturn(4.26)).toBe("+4.3%");
    expect(formatReturn(-2)).toBe("-2.0%");
    expect(formatReturn(0)).toBe("0.0%");
    return expect(formatReturn(null)).toBe("–");
  });
});

describe("RotationMatrixWorkspace", () => {
  it("renders the summary, our names and the grouped matrix", async () => {
    const rotationMatrix = vi.fn(async () => rotationFixture());
    const container = await render(gatewayWith(rotationMatrix));
    expect(rotationMatrix).toHaveBeenCalledWith("1M");
    const text = container.textContent;
    expect(text).toContain("3,022 US-listed stocks. Daily close 2026-10-21");
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
    expect(detail?.querySelector("a")?.getAttribute("href")).toBe(
      "https://finviz.com/quote.ashx?t=XOM"
    );
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

  it("filters by industry text and by exact symbol", async () => {
    const container = await render(
      gatewayWith(vi.fn(async () => rotationFixture()))
    );
    await typeFilter(container, "water");
    expect(industryRows(container)).toEqual(["XOM", "OLD", "Water Supply ▼"]);
    await typeFilter(container, "psx");
    expect(industryRows(container)).toEqual(["XOM", "OLD", "Oil Refining"]);
    await typeFilter(container, "nothing-matches");
    return expect(industryRows(container)).toEqual(["XOM", "OLD"]);
  });

  it("switches period, closes the selection and handles empty optional data", async () => {
    const rotationMatrix = vi.fn(async (period: "1D" | "1M" | "3M" | "6M") =>
      period === "1M"
        ? rotationFixture()
        : rotationFixture(period, {
            asOf: null,
            ours: [],
            source: null,
          })
    );
    const container = await render(gatewayWith(rotationMatrix));
    await click(
      button(container, "Oil & Gas Production large: +5.0%, 3 names")
    );
    await click(button(container, "6M"));
    expect(rotationMatrix).toHaveBeenLastCalledWith("6M");
    expect(button(container, "6M")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[aria-label="Selected cell"]')).toBeNull();
    const text = container.textContent;
    expect(text).toContain("Daily close unknown. Color scale ±30%.");
    expect(text).toContain("No wish-list or re-entry name is a leader");
    expect(text).toContain("Sources: unknown; unknown.");
    return expect(
      container.querySelector('a[href="https://finviz.com/map.ashx?t=sec_all"]')
    ).not.toBeNull();
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
    fail = false;
    await click(button(container, "Try again"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const pending = vi.fn(() => new Promise<never>(() => undefined));
    const loading = await render(gatewayWith(pending));
    return expect(loading.textContent).toContain("Loading rotation matrix…");
  });
});
