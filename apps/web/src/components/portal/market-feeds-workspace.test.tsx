// @vitest-environment jsdom
import type {
  ApiClient,
  GexIndexRow,
  MacroSeries,
  MarketContextOutput,
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
  createBrowserMarketFeedsGateway,
  MARKET_FEEDS_REFRESH_MS,
  MarketFeedsWorkspace,
} from "./market-feeds-workspace.tsx";

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
  vi.useRealTimers();
});

const ZERO_DTE = {
  expiry: "2026-11-03",
  netGex: -2,
  flip: 756.77,
  callWall: 752,
  putWall: 753,
};

const DGS10: MacroSeries = {
  id: "DGS10",
  label: "10-year Treasury yield",
  group: "rates",
  units: "%",
  status: "ok",
  stale: false,
  value: 4.94,
  date: "2026-10-30",
  change1d: -0.04,
  change1w: -0.06,
  change1m: 0.35,
  change1y: 0.83,
  pct1y: 86.4,
  source: "FRED",
  sourceUrl: "https://fred.stlouisfed.org/series/DGS10",
};

const gexRow = (overrides: Partial<GexIndexRow> = {}): GexIndexRow => ({
  symbol: "SPY",
  status: "ok",
  spot: 752.69,
  netGex: -12_500_453_319,
  regime: "amplified",
  flip: 768.49,
  spotVsFlip: "below",
  callWall: 752,
  putWall: 750,
  netVex: 1,
  netChex: 2,
  netDex: -3,
  fadeNote: "levels may fade after 2026-11-04",
  zeroDte: ZERO_DTE,
  notes: ["GEX negative: dealer hedging amplifies moves"],
  ...overrides,
});

const ready = (
  overrides: Partial<MarketContextOutput> = {}
): MarketContextOutput => ({
  generatedAt: "2026-11-03T14:59:00.000Z",
  stale: false,
  missing: [],
  gex: {
    asOf: "2026-11-03T14:50:00.000Z",
    oiSession: "2026-10-30",
    label: "Estimate from QuantData OI+IV.",
    index: [
      gexRow(),
      gexRow({
        symbol: "QQQ",
        regime: "dampened",
        netGex: 6_000_000_000,
        notes: [],
        fadeNote: null,
      }),
    ],
  },
  macro: {
    asOf: "2026-11-03T14:40:00.000Z",
    series: [DGS10],
    regimes: [{ id: "curve", label: "normal", rule: "10y-2y < 0 inverted" }],
    events: [
      { date: "2026-11-06", time: "08:30", name: "Employment Situation" },
    ],
  },
  news: {
    asOf: "2026-11-03T14:55:00.000Z",
    themes: [
      {
        id: "oil_hormuz",
        label: "Oil / Strait of Hormuz",
        count24h: 22,
        count72h: 25,
        sentiment24h: 0.07,
        shock: true,
      },
    ],
    headlines: [
      {
        title: "Oil prices climb",
        publisher: "CNBC",
        url: "https://example.test/oil",
        publishedAt: "2026-11-03T14:00:00.000Z",
        theme: "Oil / Strait of Hormuz",
        sentiment: 0.39,
        materiality: "high",
      },
    ],
  },
  ...overrides,
});

const mount = async (context: () => Promise<MarketContextOutput>) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<MarketFeedsWorkspace gateway={{ context }} />)
  );
  return container;
};

const text = (container: HTMLElement, selector: string) =>
  container.querySelector(selector)?.textContent ?? "";

describe("Market feeds", () => {
  it("shows GEX, macro and news with as-of times", async () => {
    const container = await mount(async () => ready());
    for (const section of ["gex", "macro", "news"])
      expect(text(container, `[data-as-of="${section}"]`)).toMatch(
        /^As of \d+\/\d+\/\d+/u
      );
    const spy = text(container, '[data-gex="SPY"]');
    expect(spy).toContain("752.69");
    expect(spy).toContain("$-12.5B");
    expect(spy).toContain("amplified");
    expect(spy).toContain("768.49 (spot below)");
    expect(spy).toContain("2026-11-03: flip 756.77, walls 752.00 / 753.00");
    expect(text(container, '[data-gex="QQQ"]')).toContain("$6B");
    expect(text(container, '[data-gex-notes="SPY"]')).toContain(
      "levels may fade"
    );
    expect(container.querySelector('[data-gex-notes="QQQ"]')).toBeNull();
    expect(text(container, '[data-macro="DGS10"]')).toContain("4.94 %");
    expect(text(container, '[data-macro="DGS10"]')).toContain("-0.04 / +0.35");
    expect(
      container.querySelector('[data-macro="DGS10"] a')?.getAttribute("href")
    ).toBe("https://fred.stlouisfed.org/series/DGS10");
    expect(text(container, "[data-macro-regimes]")).toContain("curve: normal");
    expect(text(container, "[data-macro-events]")).toContain(
      "2026-11-06 08:30: Employment Situation"
    );
    expect(text(container, '[data-theme="oil_hormuz"]')).toContain(
      "22 in 24 h, sentiment +0.07, shock"
    );
    const link = container.querySelector("[data-news-headlines] a");
    expect(link?.getAttribute("href")).toBe("https://example.test/oil");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(text(container, "[data-news-headlines]")).toContain("CNBC · ");
    expect(text(container, "[data-news-headlines]")).toContain(
      "sentiment +0.39 · high materiality"
    );
    expect(container.querySelector("[data-feeds-stale]")).toBeNull();
    expect(container.querySelector("[data-feeds-missing]")).toBeNull();
  });

  it("states missing, stale and unknown values without inventing them", async () => {
    const container = await mount(async () =>
      ready({
        stale: true,
        missing: ["gex", "news"],
        gex: null,
        news: null,
        macro: {
          asOf: null,
          regimes: [],
          events: [],
          series: [
            {
              ...DGS10,
              id: "WCESTUS1",
              status: "unavailable",
              stale: true,
              value: null,
              date: null,
              change1d: null,
              change1m: null,
              pct1y: null,
              sourceUrl: null,
              units: "",
            },
            {
              ...DGS10,
              id: "NFCI",
              status: "error",
              units: "",
            },
          ],
        },
      })
    );
    expect(text(container, "[data-feeds-stale]")).toContain("15 minutes");
    expect(text(container, "[data-feeds-missing]")).toContain("GEX, News");
    expect(text(container, '[data-section="gex"]')).toContain(
      "GEX not available."
    );
    expect(text(container, '[data-section="news"]')).toContain(
      "News not available."
    );
    expect(text(container, '[data-as-of="macro"]')).toBe("As of unknown");
    const missing = text(container, '[data-macro="WCESTUS1"]');
    expect(missing).toContain("(stale)");
    expect(missing).toContain("—");
    expect(container.querySelector('[data-macro="WCESTUS1"] a')).toBeNull();
    expect(text(container, '[data-macro="NFCI"]')).toContain("(error)");
    expect(text(container, '[data-macro="NFCI"]')).toContain("4.94");
    expect(container.querySelector("[data-macro-regimes]")).toBeNull();
    expect(container.querySelector("[data-macro-events]")).toBeNull();

    const sparse = await mount(async () =>
      ready({
        gex: {
          asOf: "2026-11-03T14:50:00.000Z",
          oiSession: null,
          label: null,
          index: [
            gexRow({
              spot: null,
              netGex: null,
              regime: null,
              flip: null,
              spotVsFlip: null,
              zeroDte: null,
              notes: [],
            }),
            gexRow({
              symbol: "QQQ",
              regime: "flat",
              fadeNote: null,
              zeroDte: { ...ZERO_DTE, expiry: null },
            }),
          ],
        },
        macro: {
          asOf: null,
          series: [],
          regimes: [{ id: "oil", label: "rising", rule: null }],
          events: [
            { date: "2026-11-10", time: null, name: "Consumer Price Index" },
          ],
        },
        news: {
          asOf: "2026-11-03T14:55:00.000Z",
          themes: [
            {
              id: "fed_rates",
              label: "Fed / rates",
              count24h: 5,
              count72h: 11,
              sentiment24h: null,
              shock: false,
            },
          ],
          headlines: [
            {
              title: "Fed holds",
              publisher: null,
              url: "https://example.test/fed",
              publishedAt: "2026-11-03T14:00:00.000Z",
              theme: null,
              sentiment: null,
              materiality: null,
            },
          ],
        },
      })
    );
    expect(text(sparse, '[data-section="gex"]')).toContain("Estimate");
    expect(text(sparse, '[data-section="gex"]')).not.toContain("Open interest");
    expect(text(sparse, '[data-gex="SPY"]')).toContain("———");
    expect(text(sparse, '[data-gex="QQQ"]')).toContain("flat");
    expect(text(sparse, '[data-gex="QQQ"]')).toContain("?: flip");
    expect(text(sparse, '[data-gex-notes="SPY"]')).toContain("levels may fade");
    expect(text(sparse, '[data-gex-notes="QQQ"]')).not.toContain("fade");
    expect(text(sparse, "[data-macro-regimes]")).toContain("oil: rising");
    expect(text(sparse, "[data-macro-events]")).toContain(
      "2026-11-10: Consumer Price Index"
    );
    expect(text(sparse, '[data-theme="fed_rates"]')).toContain(
      "5 in 24 h, sentiment —"
    );
    expect(text(sparse, '[data-theme="fed_rates"]')).not.toContain("shock");
    expect(
      sparse.querySelector("[data-news-headlines] p")?.textContent
    ).toMatch(/^\d+\/\d+\/\d+, [\d:]+ [AP]M$/u);

    const empty = await mount(async () =>
      ready({ news: { asOf: null, themes: [], headlines: [] } })
    );
    expect(text(empty, '[data-section="news"]')).toContain(
      "No macro headlines."
    );
    expect(empty.querySelector("[data-news-themes]")).toBeNull();
    const noMacro = await mount(async () => ready({ macro: null }));
    expect(text(noMacro, '[data-section="macro"]')).toContain(
      "Macro data not available."
    );
  });

  it("shows failures with a retry and access-required for non-operators", async () => {
    let fail = true;
    const container = await mount(async () => {
      if (fail)
        throw { code: "UNAVAILABLE", message: "No market context pushed yet" };
      return ready();
    });
    expect(text(container, '[role="alert"]')).toContain(
      "UNAVAILABLE: No market context pushed yet"
    );
    fail = false;
    await act(async () => container.querySelector("button")?.click());
    expect(
      container.querySelector('[data-feeds-state="ready"]')
    ).not.toBeNull();
    const denied = await mount(async () => {
      throw { code: "FORBIDDEN", status: 403, message: "Forbidden" };
    });
    expect(denied.querySelector("[data-feeds-state]")).toBeNull();
    expect(
      denied.querySelector('[data-operator-feature="market-context"]')
    ).not.toBeNull();
  });

  it("shows loading first and refreshes once a minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let resolveFirst: (value: MarketContextOutput) => void = () => undefined;
    // The web tsconfig lib predates Promise.withResolvers.
    const pending = new Promise<MarketContextOutput>((resolve) => {
      resolveFirst = resolve;
    });
    const context = vi.fn(() => pending);
    const container = await mount(context);
    expect(text(container, '[role="status"]')).toBe(
      "Loading GEX, macro and news…"
    );
    await act(async () => resolveFirst(ready()));
    await act(async () => {
      vi.advanceTimersByTime(MARKET_FEEDS_REFRESH_MS);
    });
    expect(context).toHaveBeenCalledTimes(2);
  });

  it("creates the browser client lazily, once, on the page origin", async () => {
    const get = vi.fn(async () => ready());
    runtime.client = { marketContext: { get } } as unknown as ApiClient;
    const gateway = createBrowserMarketFeedsGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.context();
    await gateway.context();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(get).toHaveBeenCalledWith({});
    expect(Object.isFrozen(gateway)).toBe(true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<MarketFeedsWorkspace />));
    expect(get).toHaveBeenCalledTimes(3);
  });
});
