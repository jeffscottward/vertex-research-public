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

import type { DeepValueScoreOutput } from "@darkfactory/api";

import {
  type DeepValueFilter,
  DeepValueWorkspace,
  filterDeepValueRows,
  formatMoney,
} from "./deep-value-workspace.tsx";
import type { ResearchLensesGateway } from "./research-lenses-client.ts";
import {
  deepValueFixture,
  deepValueRow,
  deepValueScore,
} from "./research-lenses-test-fixtures.ts";

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
  overrides: Partial<ResearchLensesGateway> = {}
): ResearchLensesGateway => ({
  rotationMatrix: vi.fn(),
  deepValue: vi.fn(async () => deepValueFixture()),
  score: vi.fn(async () => deepValueScore()),
  ...overrides,
});

const render = async (gateway: ResearchLensesGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<DeepValueWorkspace gateway={gateway} />);
    return await flush();
  });
  return container;
};

const act$ = async (action: () => void) =>
  await act(async () => {
    action();
    return await flush();
  });

const setInput = async (
  element: HTMLInputElement | HTMLSelectElement,
  value: string
) =>
  await act$(() => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    );
  });

const symbols = (container: HTMLElement) =>
  [
    ...container.querySelectorAll(
      '[aria-label="Stored ranking"] button[aria-expanded]'
    ),
  ].map((element) => element.textContent);

const submitTicker = async (container: HTMLElement, value: string) => {
  const input = container.querySelector(
    'input[placeholder="e.g. SIRI"]'
  ) as HTMLInputElement;
  await setInput(input, value);
  return await act$(() => container.querySelector("form")?.requestSubmit());
};

describe("deep value helpers", () => {
  it("formats money in billions, millions and thousands", () => {
    expect(formatMoney(2.5e9)).toBe("$2.50B");
    expect(formatMoney(278e6)).toBe("$278M");
    expect(formatMoney(5e5)).toBe("$500k");
    return expect(formatMoney(null)).toBe("–");
  });

  return it("filters by role, text, flags and minimum total", () => {
    const rows = deepValueFixture().rows;
    const pick = (filter: Partial<DeepValueFilter>) =>
      filterDeepValueRows(rows, {
        role: "all",
        text: "",
        hideFlagged: false,
        minTotal: 0,
        ...filter,
      }).map((row) => row.symbol);
    expect(pick({})).toEqual(["TG", "SIRI", "REN"]);
    expect(pick({ role: "ours" })).toEqual(["SIRI", "REN"]);
    expect(pick({ role: "re-entry" })).toEqual(["REN"]);
    expect(pick({ text: " metal " })).toEqual(["TG", "REN"]);
    expect(pick({ text: "siri" })).toEqual(["SIRI"]);
    expect(pick({ hideFlagged: true })).toEqual(["TG", "REN"]);
    return expect(pick({ minTotal: 6 })).toEqual(["SIRI", "REN"]);
  });
});

describe("DeepValueWorkspace", () => {
  it("renders the stored ranking with criteria, flags and reasons", async () => {
    const container = await render(gatewayWith());
    const text = container.textContent;
    expect(text).toContain(
      "every proxy and cutoff here is ours, not the reel's"
    );
    expect(text).toContain(
      "3 names scored 2026-10-21 20:28 UTC (2 of ours, 1 from the optional low-price universe: price ≤ $10, cap $50M–$1.00B, ≥ $100k/day"
    );
    expect(symbols(container)).toEqual(["TG", "SIRI", "REN"]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "3 shown"
    );
    const headers = [...container.querySelectorAll("thead th")].map(
      (cell) => cell.textContent
    );
    expect(headers).toContain("Time horizon");
    expect(text).toContain("Time horizon");
    expect(text).toContain("penny");
    return expect(text).toContain(
      "Sources: Yahoo Finance; SEC EDGAR. All numeric cutoffs and proxies are ours."
    );
  });

  it("opens and closes a scorecard row", async () => {
    const container = await render(gatewayWith());
    const siri = [...container.querySelectorAll("button[aria-expanded]")].find(
      (element) => element.textContent === "SIRI"
    ) as HTMLButtonElement;
    await act$(() => siri.click());
    const card = container.querySelector('[aria-label="SIRI scorecard"]');
    expect(siri.getAttribute("aria-expanded")).toBe("true");
    expect(card?.textContent).toContain("#2 SIRI");
    expect(card?.textContent).toContain(
      "– · cap $12.50B · industry unknown · wish list, low-price universe"
    );
    expect(card?.textContent).toContain("⚠️ Penny stock (price < $1)");
    expect(card?.textContent).toContain(
      "Source gaps: sec: SEC companyfacts returned HTTP 500"
    );
    expect(card?.querySelectorAll("a")).toHaveLength(2);
    await act$(() => siri.click());
    return expect(
      container.querySelector('[aria-label="SIRI scorecard"]')
    ).toBeNull();
  });

  it("applies the filter controls", async () => {
    const container = await render(gatewayWith());
    await setInput(
      container.querySelector("select") as HTMLSelectElement,
      "re-entry"
    );
    expect(symbols(container)).toEqual(["REN"]);
    await setInput(
      container.querySelector("select") as HTMLSelectElement,
      "all"
    );
    const checkbox = container.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement;
    await act$(() => checkbox.click());
    expect(symbols(container)).toEqual(["TG", "REN"]);
    await act$(() => checkbox.click());
    const number = container.querySelector(
      'input[type="number"]'
    ) as HTMLInputElement;
    await setInput(number, "6");
    expect(symbols(container)).toEqual(["SIRI", "REN"]);
    await setInput(number, "");
    await setInput(
      container.querySelector('input[type="search"]') as HTMLInputElement,
      "tg"
    );
    return expect(symbols(container)).toEqual(["TG"]);
  });

  it("lists at most 300 rows and uses the fallback criteria when none are stored", async () => {
    const rows = Array.from({ length: 301 }, (_, index) =>
      deepValueRow(`S${index}`, { rank: index + 1 })
    );
    const container = await render(
      gatewayWith({
        deepValue: vi.fn(async () => deepValueFixture({ rows, criteria: [] })),
      })
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "301 shown (first 300 listed)"
    );
    expect(symbols(container)).toHaveLength(300);
    const headers = [...container.querySelectorAll("thead th")].map(
      (cell) => cell.textContent
    );
    expect(headers).toContain("Longevity");
    const first = container.querySelector(
      "button[aria-expanded]"
    ) as HTMLButtonElement;
    await act$(() => first.click());
    const card = container.querySelector('[aria-label="S0 scorecard"]');
    // Criteria without a stored result show a dash.
    return expect(card?.textContent).toContain("Longevity–");
  });

  it("scores one ticker on demand", async () => {
    const score = vi.fn(async () => deepValueScore());
    const container = await render(gatewayWith({ score }));
    await submitTicker(container, "   ");
    expect(score).not.toHaveBeenCalled();
    await submitTicker(container, " siri ");
    expect(score).toHaveBeenCalledWith("SIRI");
    const card = container.querySelector('[aria-label="SIRI scorecard"]');
    expect(card?.textContent).toContain("$7.96 · cap $500k");
    expect(card?.textContent).toContain("requested");
    expect(container.textContent).not.toContain("No stored industry median");
    return expect(card?.textContent).toContain("3/16");
  });

  it("notes a missing peer median, shows scoring progress and errors", async () => {
    let finish: (value: DeepValueScoreOutput) => void = () => undefined;
    const score = vi
      .fn<ResearchLensesGateway["score"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("No price or SEC data for ZZZZ"), {
          code: "NOT_FOUND",
        })
      );
    const container = await render(gatewayWith({ score }));
    await submitTicker(container, "SIRI");
    const submit = container.querySelector(
      'button[type="submit"]'
    ) as HTMLButtonElement;
    expect(submit.textContent).toBe("Scoring…");
    expect(submit.disabled).toBe(true);
    await act$(() => finish(deepValueScore({ peerMedian: null })));
    expect(container.textContent).toContain(
      "No stored industry median for this ticker"
    );
    await submitTicker(container, "ZZZZ");
    return expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not score: No price or SEC data for ZZZZ"
    );
  });

  it("shows an unknown price date and creates the browser gateway when none is supplied", async () => {
    const container = await render(gatewayWith());
    const ren = [...container.querySelectorAll("button[aria-expanded]")].find(
      (element) => element.textContent === "REN"
    ) as HTMLButtonElement;
    await act$(() => ren.click());
    expect(
      container.querySelector('[aria-label="REN scorecard"]')?.textContent
    ).toContain("prices as of –");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    try {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      roots.push(root);
      await act(async () => {
        root.render(<DeepValueWorkspace />);
        for (let index = 0; index < 200; index += 1) await Promise.resolve();
      });
      return expect(host.textContent).toMatch(
        /Loading ranking|Stored ranking unavailable/u
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  return it("shows loading, the operator notice and a retry for the stored ranking", async () => {
    const pending = await render(
      gatewayWith({
        deepValue: vi.fn(() => new Promise<never>(() => undefined)),
      })
    );
    expect(pending.textContent).toContain("Loading ranking…");
    let fail = true;
    const deepValue = vi.fn(async () => {
      if (fail)
        throw Object.assign(new Error("Forbidden"), {
          code: "FORBIDDEN",
          status: 403,
        });
      return deepValueFixture();
    });
    const container = await render(gatewayWith({ deepValue }));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Stored ranking unavailable:");
    fail = false;
    await act$(() => alert?.querySelector("button")?.click());
    return expect(symbols(container)).toEqual(["TG", "SIRI", "REN"]);
  });
});
