// @vitest-environment jsdom
import type {
  ApiClient,
  GexIndexRow,
  MacroSeries,
  MarketContextOutput,
  MarketContextSection,
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
  type MarketFeedsWorkspaceProps,
  missingSectionText,
} from "./market-feeds-workspace.tsx";
import type { MarketSourceStatus } from "./market-source-status.ts";

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
  callWall: 752,
  expiry: "2026-11-03",
  flip: 756.77,
  netGex: -2,
  putWall: 753,
};

const DGS10: MacroSeries = {
  change1d: -0.04,
  change1m: 0.35,
  change1w: -0.06,
  change1y: 0.83,
  date: "2026-10-30",
  group: "rates",
  id: "DGS10",
  label: "10-year Treasury yield",
  pct1y: 86.4,
  source: "FRED",
  sourceUrl: "https://fred.stlouisfed.org/series/DGS10",
  stale: false,
  status: "ok",
  units: "%",
  value: 4.94,
};

const gexRow = (overrides: Partial<GexIndexRow> = {}): GexIndexRow => ({
  callWall: 752,
  fadeNote: "levels may fade after 2026-11-04",
  flip: 768.49,
  netChex: 2,
  netDex: -3,
  netGex: -12_500_453_319,
  netVex: 1,
  notes: ["GEX negative: dealer hedging amplifies moves"],
  putWall: 750,
  regime: "amplified",
  spot: 752.69,
  spotVsFlip: "below",
  status: "ok",
  symbol: "SPY",
  zeroDte: ZERO_DTE,
  ...overrides,
});

const ready = (
  overrides: Partial<MarketContextOutput> = {}
): MarketContextOutput => ({
  generatedAt: "2026-11-03T14:59:00.000Z",
  gex: {
    asOf: "2026-11-03T14:50:00.000Z",
    index: [
      gexRow(),
      gexRow({
        fadeNote: null,
        netGex: 6_000_000_000,
        notes: [],
        regime: "dampened",
        symbol: "QQQ",
      }),
    ],
    label: "Estimate from QuantData OI+IV.",
    oiSession: "2026-10-30",
  },
  macro: {
    asOf: "2026-11-03T14:40:00.000Z",
    events: [
      { date: "2026-11-06", name: "Employment Situation", time: "08:30" },
    ],
    regimes: [{ id: "curve", label: "normal", rule: "10y-2y < 0 inverted" }],
    series: [DGS10],
  },
  missing: [],
  news: {
    asOf: "2026-11-03T14:55:00.000Z",
    headlines: [
      {
        materiality: "high",
        publishedAt: "2026-11-03T14:00:00.000Z",
        publisher: "CNBC",
        sentiment: 0.39,
        theme: "Oil / Strait of Hormuz",
        title: "Oil prices climb",
        url: "https://example.test/oil",
      },
    ],
    themes: [
      {
        count24h: 22,
        count72h: 25,
        id: "oil_hormuz",
        label: "Oil / Strait of Hormuz",
        sentiment24h: 0.07,
        shock: true,
      },
    ],
  },
  sections: { gex: null, macro: null, news: null },
  stale: false,
  ...overrides,
});

const cellTitles = (container: HTMLElement, row: string) =>
  [...container.querySelectorAll(`${row} td`)].map((cell) =>
    cell.getAttribute("title")
  );

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

const renderWorkspace = async (props: MarketFeedsWorkspaceProps) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const rerender = (next: MarketFeedsWorkspaceProps) =>
    act(async () => root.render(<MarketFeedsWorkspace {...next} />));
  await rerender(props);
  return { container, rerender };
};

/** A gateway call per load; the test settles each answer later, in any order.
 * Executor form: the web tsconfig lib predates Promise.withResolvers. */
const queued = () => {
  const answers: {
    resolve: (value: MarketContextOutput) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const context = vi.fn(
    () =>
      new Promise<MarketContextOutput>((resolve, reject) => {
        answers.push({ reject, resolve });
      })
  );
  return { answers, context };
};

const pushedAt = (generatedAt: string) =>
  ready({ generatedAt, gex: null, macro: null, news: null });

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
    // Every symbol links to its stock page: the GEX row header and its notes.
    expect(
      container
        .querySelector('[data-gex="QQQ"] th a[data-slot="ticker-link"]')
        ?.getAttribute("href")
    ).toBe("/stock/QQQ");
    expect(
      container
        .querySelector('[data-gex-notes="SPY"] a[data-slot="ticker-link"]')
        ?.getAttribute("href")
    ).toBe("/stock/SPY");
    // Wide tables scroll sideways on a phone instead of squeezing columns.
    expect(
      [...container.querySelectorAll('[data-slot="table-scroll"]')].map(
        (region) => region.getAttribute("aria-label")
      )
    ).toEqual(["GEX by index", "Macro series"]);
    expect(
      container.querySelector('[data-section="gex"] h2')?.textContent
    ).toBe("Gamma exposure (GEX)");
  });

  it("reports live, stale and partial data to the page and reloads on the refresh signal", async () => {
    const statuses: MarketSourceStatus[] = [];
    const onStatusChange = (status: MarketSourceStatus) => {
      statuses.push(status);
    };
    let answer: Partial<MarketContextOutput> = {};
    const context = vi.fn(async () => ready(answer));
    const props = { gateway: { context }, onStatusChange };
    const { rerender } = await renderWorkspace(props);
    expect(statuses).toEqual(["loading", "ready"]);
    answer = { stale: true };
    await rerender({ ...props, refreshSignal: 1 });
    expect(context).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe("stale");
    // A section the rig could not read is a gap, not just old data.
    answer = { macro: null, missing: ["macro"] };
    await rerender({ ...props, refreshSignal: 2 });
    expect(statuses.at(-1)).toBe("partial");
    answer = {};
    await rerender({ ...props, refreshSignal: 3 });
    expect(statuses).toEqual(["loading", "ready", "stale", "partial", "ready"]);
    const denied = await mount(async () => {
      throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
    });
    expect(denied.querySelector("[data-feeds-state]")).toBeNull();
  });

  it("reports a load in flight from mount, Retry and the timer, and holds Retry meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { answers, context } = queued();
    const busy: boolean[] = [];
    const onBusyChange = (value: boolean) => {
      busy.push(value);
    };
    const { container } = await renderWorkspace({
      gateway: { context },
      onBusyChange,
    });
    expect(busy).toEqual([true]);
    await act(async () =>
      answers[0]?.reject({ code: "UNAVAILABLE", message: "No push yet" })
    );
    expect(busy).toEqual([true, false]);
    expect(container.querySelector("button")?.disabled).toBe(false);
    await act(async () => container.querySelector("button")?.click());
    expect(context).toHaveBeenCalledTimes(2);
    expect(busy).toEqual([true, false, true]);
    expect(container.querySelector("button")?.disabled).toBe(true);
    await act(async () =>
      answers[1]?.reject({ code: "UNAVAILABLE", message: "No push yet" })
    );
    expect(busy).toEqual([true, false, true, false]);
    expect(container.querySelector("button")?.disabled).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(MARKET_FEEDS_REFRESH_MS);
    });
    expect(context).toHaveBeenCalledTimes(3);
    expect(busy.at(-1)).toBe(true);
    expect(container.querySelector("button")?.disabled).toBe(true);
    await act(async () => answers[2]?.resolve(ready()));
    expect(busy.at(-1)).toBe(false);
    expect(
      container.querySelector('[data-feeds-state="ready"]')
    ).not.toBeNull();
  });

  it("keeps the newest answer when an older load settles last", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { answers, context } = queued();
    const statuses: MarketSourceStatus[] = [];
    const busy: boolean[] = [];
    const props: MarketFeedsWorkspaceProps = {
      gateway: { context },
      onBusyChange: (value) => {
        busy.push(value);
      },
      onStatusChange: (status) => {
        statuses.push(status);
      },
    };
    const { container, rerender } = await renderWorkspace(props);
    const note = () => text(container, '[role="note"]');
    // The page Refresh lands while the mount load is still out.
    await rerender({ ...props, refreshSignal: 1 });
    expect(context).toHaveBeenCalledTimes(2);
    await act(async () =>
      answers[1]?.resolve(pushedAt("2026-11-03T15:10:00.000Z"))
    );
    const newest = note();
    expect(busy.at(-1)).toBe(false);
    await act(async () =>
      answers[0]?.resolve({
        ...pushedAt("2026-11-03T14:00:00.000Z"),
        missing: ["gex"],
        stale: true,
      })
    );
    expect(note()).toBe(newest);
    expect(container.querySelector("[data-feeds-stale]")).toBeNull();
    expect(container.querySelector("[data-feeds-missing]")).toBeNull();
    expect(busy.at(-1)).toBe(false);
    // Two timer loads overlap; the older one fails after the newer one answered.
    await act(async () => {
      vi.advanceTimersByTime(MARKET_FEEDS_REFRESH_MS);
    });
    await act(async () => {
      vi.advanceTimersByTime(MARKET_FEEDS_REFRESH_MS);
    });
    expect(context).toHaveBeenCalledTimes(4);
    await act(async () =>
      answers[3]?.resolve(pushedAt("2026-11-03T15:20:00.000Z"))
    );
    const latest = note();
    expect(latest).not.toBe(newest);
    expect(busy.at(-1)).toBe(false);
    await act(async () =>
      answers[2]?.reject({ code: "UNAVAILABLE", message: "late" })
    );
    expect(note()).toBe(latest);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(busy.at(-1)).toBe(false);
    expect(statuses).toEqual(["loading", "ready"]);
  });

  it("states missing, stale and null values without inventing them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T15:20:00.000Z"));
    const container = await mount(async () =>
      ready({
        gex: null,
        macro: {
          asOf: null,
          events: [],
          regimes: [],
          series: [
            {
              ...DGS10,
              change1d: null,
              change1m: null,
              date: null,
              id: "WCESTUS1",
              pct1y: null,
              sourceUrl: null,
              stale: true,
              status: "unavailable",
              units: "",
              value: null,
            },
            {
              ...DGS10,
              id: "NFCI",
              status: "error",
              units: "",
            },
          ],
        },
        missing: ["gex", "news"],
        news: null,
        stale: true,
      })
    );
    expect(text(container, "[data-feeds-stale]")).toContain("15 minutes");
    expect(text(container, "[data-feeds-missing]")).toContain("GEX, News");
    // No `sections` entry and a stale document: no cause was reported, and the next step is a check.
    expect(text(container, '[data-section="gex"] [data-section-missing]')).toBe(
      "GEX not in the collector push of 14:59 UTC; this collector version reports no cause · collector has not pushed since 14:59 UTC; check the rig collector"
    );
    expect(
      text(container, '[data-section="news"] [data-section-missing]')
    ).toBe(
      "News not in the collector push of 14:59 UTC; this collector version reports no cause · collector has not pushed since 14:59 UTC; check the rig collector"
    );
    expect(text(container, '[data-as-of="macro"]')).toBe(
      "As of time not reported by source"
    );
    const missing = text(container, '[data-macro="WCESTUS1"]');
    expect(missing).toBe(
      "10-year Treasury yield (stale)no valuedate not reportedno prior value / no prior valueno value"
    );
    // The value cells name the series status; the snapshot has no time here.
    expect(cellTitles(container, '[data-macro="WCESTUS1"]')).toEqual([
      "series status stale in the macro snapshot; time not reported by source",
      null,
      null,
      "series status stale in the macro snapshot; time not reported by source",
    ]);
    expect(cellTitles(container, '[data-macro="NFCI"]')).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(container.querySelector('[data-macro="WCESTUS1"] a')).toBeNull();
    expect(text(container, '[data-macro="NFCI"]')).toContain("(error)");
    expect(text(container, '[data-macro="NFCI"]')).toContain("4.94");
    expect(container.querySelector("[data-macro-regimes]")).toBeNull();
    expect(container.querySelector("[data-macro-events]")).toBeNull();

    const sparse = await mount(async () =>
      ready({
        gex: {
          asOf: "2026-11-03T14:50:00.000Z",
          index: [
            gexRow({
              flip: null,
              netGex: null,
              notes: [],
              regime: null,
              spot: null,
              spotVsFlip: null,
              zeroDte: null,
            }),
            gexRow({
              fadeNote: null,
              regime: "flat",
              symbol: "QQQ",
              zeroDte: { ...ZERO_DTE, expiry: null },
            }),
          ],
          label: null,
          oiSession: null,
        },
        macro: {
          asOf: null,
          events: [
            { date: "2026-11-10", name: "Consumer Price Index", time: null },
          ],
          regimes: [{ id: "oil", label: "rising", rule: null }],
          series: [],
        },
        news: {
          asOf: "2026-11-03T14:55:00.000Z",
          headlines: [
            {
              materiality: null,
              publishedAt: "2026-11-03T14:00:00.000Z",
              publisher: null,
              sentiment: null,
              theme: null,
              title: "Fed holds",
              url: "https://example.test/fed",
            },
          ],
          themes: [
            {
              count24h: 5,
              count72h: 11,
              id: "fed_rates",
              label: "Fed / rates",
              sentiment24h: null,
              shock: false,
            },
          ],
        },
      })
    );
    expect(text(sparse, '[data-section="gex"]')).toContain("Estimate");
    expect(text(sparse, '[data-section="gex"]')).not.toContain("Open interest");
    expect(text(sparse, '[data-gex="SPY"]')).toBe(
      "SPYno valuenot computedregime not computedno value752.00 / 750.000DTE not in snapshot"
    );
    // A cell without a value names the snapshot it is missing from; a cell with a value has no title.
    const gexTitle = "not in the GEX snapshot of 14:50 UTC";
    expect(cellTitles(sparse, '[data-gex="SPY"]')).toEqual([
      gexTitle,
      gexTitle,
      gexTitle,
      gexTitle,
      null,
      gexTitle,
    ]);
    expect(text(sparse, '[data-gex="QQQ"]')).toContain("flat");
    expect(text(sparse, '[data-gex="QQQ"]')).toContain(
      "expiry not reported: flip 756.77, walls 752.00 / 753.00"
    );
    expect(cellTitles(sparse, '[data-gex="QQQ"]')).toEqual([
      null,
      null,
      null,
      null,
      null,
      gexTitle,
    ]);
    expect(text(sparse, '[data-gex-notes="SPY"]')).toContain("levels may fade");
    expect(text(sparse, '[data-gex-notes="QQQ"]')).not.toContain("fade");
    expect(text(sparse, "[data-macro-regimes]")).toContain("oil: rising");
    expect(text(sparse, "[data-macro-events]")).toContain(
      "2026-11-10: Consumer Price Index"
    );
    expect(text(sparse, '[data-theme="fed_rates"]')).toContain(
      "Fed / rates: 5 in 24 h, no sentiment score"
    );
    expect(text(sparse, '[data-theme="fed_rates"]')).not.toContain("shock");
    expect(
      sparse.querySelector("[data-news-headlines] p")?.textContent
    ).toMatch(/^\d+\/\d+\/\d+, [\d:]+ [AP]M$/u);

    const empty = await mount(async () =>
      ready({ news: { asOf: null, headlines: [], themes: [] } })
    );
    expect(text(empty, '[data-section="news"]')).toContain(
      "No macro headlines."
    );
    expect(empty.querySelector("[data-news-themes]")).toBeNull();
    const noMacro = await mount(async () => ready({ macro: null }));
    expect(text(noMacro, '[data-section="macro"] [data-section-missing]')).toBe(
      "Macro not in the collector push of 14:59 UTC; this collector version reports no cause · collector pushes every 5 min"
    );
  });

  it("names the snapshot of a null GEX or macro cell, with or without its time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T15:20:00.000Z"));
    const base = ready();
    const container = await mount(async () =>
      ready({
        gex: {
          asOf: null,
          index: [
            gexRow({ callWall: null, putWall: null }),
            gexRow({
              symbol: "QQQ",
              zeroDte: { ...ZERO_DTE, callWall: null, flip: null },
            }),
          ],
          label: null,
          oiSession: null,
        },
        macro: {
          asOf: "2026-11-03T14:40:00.000Z",
          events: [],
          regimes: [],
          series: [
            { ...DGS10, pct1y: null, status: "error", value: null },
            { ...DGS10, id: "DGS2", pct1y: null },
          ],
        },
        news: base.news,
      })
    );
    const noTime = "not in the GEX snapshot; time not reported by source";
    expect(text(container, '[data-gex="SPY"]')).toContain(
      "no value / no value"
    );
    expect(cellTitles(container, '[data-gex="SPY"]')).toEqual([
      null,
      null,
      null,
      null,
      noTime,
      null,
    ]);
    expect(text(container, '[data-gex="QQQ"]')).toContain(
      "2026-11-03: flip no value, walls no value / 753.00"
    );
    expect(cellTitles(container, '[data-gex="QQQ"]').at(-1)).toBe(noTime);
    expect(cellTitles(container, '[data-macro="DGS10"]')).toEqual([
      "series status error in the macro snapshot of 14:40 UTC",
      null,
      null,
      "series status error in the macro snapshot of 14:40 UTC",
    ]);
    expect(cellTitles(container, '[data-macro="DGS2"]')).toEqual([
      null,
      null,
      null,
      "series status ok in the macro snapshot of 14:40 UTC",
    ]);
  });

  it("shows the collector's cause in each missing section", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T15:00:00.000Z"));
    const container = await mount(async () =>
      ready({
        gex: null,
        macro: null,
        missing: ["gex", "macro", "news"],
        news: null,
        sections: {
          gex: { stateAt: null, status: "state_file_missing" },
          macro: {
            stateAt: "2026-11-03T14:50:00.000Z",
            status: "state_file_unreadable",
          },
          news: {
            stateAt: "2026-11-03T14:55:00.000Z",
            status: "state_file_invalid",
          },
        },
      })
    );
    const line = (section: string) =>
      text(container, `[data-section="${section}"] [data-section-missing]`);
    expect(line("gex")).toBe(
      "GEX not received: the collector found no GEX state file · collector push 14:59 UTC · collector pushes every 5 min"
    );
    expect(line("macro")).toBe(
      "Macro not received: the collector could not read the macro state file (last written 14:50 UTC) · collector push 14:59 UTC · collector pushes every 5 min"
    );
    expect(line("news")).toBe(
      "News not received: the news state file (last written 14:55 UTC) has a shape the collector does not accept · collector push 14:59 UTC · collector pushes every 5 min"
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
      throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
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

describe("missingSectionText", () => {
  const NOW = new Date("2026-11-18T14:10:00.000Z");
  const fresh = { generatedAt: "2026-11-18T14:05:00.000Z", stale: false };
  const stale = { generatedAt: "2026-11-18T14:05:00.000Z", stale: true };
  const at = "2026-11-18T13:55:00.000Z";
  const FRESH = "collector pushes every 5 min";
  const STALE =
    "collector has not pushed since 14:05 UTC; check the rig collector";

  it.each<[MarketContextSection | null, string]>([
    [
      { stateAt: null, status: "state_file_missing" },
      "GEX not received: the collector found no GEX state file · collector push 14:05 UTC",
    ],
    [
      { stateAt: at, status: "state_file_unreadable" },
      "GEX not received: the collector could not read the GEX state file (last written 13:55 UTC) · collector push 14:05 UTC",
    ],
    [
      { stateAt: null, status: "state_file_unreadable" },
      "GEX not received: the collector could not read the GEX state file (last written time not reported by source) · collector push 14:05 UTC",
    ],
    [
      { stateAt: at, status: "state_file_invalid" },
      "GEX not received: the GEX state file (last written 13:55 UTC) has a shape the collector does not accept · collector push 14:05 UTC",
    ],
    [
      { stateAt: null, status: "state_file_invalid" },
      "GEX not received: the GEX state file (last written time not reported by source) has a shape the collector does not accept · collector push 14:05 UTC",
    ],
    [
      null,
      "GEX not in the collector push of 14:05 UTC; this collector version reports no cause",
    ],
    [
      { stateAt: at, status: "ok" },
      "GEX not in the collector push of 14:05 UTC; this collector version reports no cause",
    ],
  ])("section %j, fresh and stale", (section, start) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(missingSectionText("GEX", section, fresh)).toBe(
      `${start} · ${FRESH}`
    );
    expect(missingSectionText("GEX", section, stale)).toBe(
      `${start} · ${STALE}`
    );
  });

  it("adds the date to a time that is not on the current UTC day", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T09:00:00.000Z"));
    expect(
      missingSectionText(
        "News",
        { stateAt: at, status: "state_file_unreadable" },
        stale
      )
    ).toBe(
      "News not received: the collector could not read the news state file (last written 2026-11-18 13:55 UTC) · collector push 2026-11-18 14:05 UTC · collector has not pushed since 2026-11-18 14:05 UTC; check the rig collector"
    );
  });
});
