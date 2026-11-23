// @vitest-environment jsdom
import type {
  ApiClient,
  OpenbbSecOutput,
  OpenbbShortsOutput,
  OpenbbStatusOutput,
  OpenbbVolContextOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ client: null as ApiClient | null }));

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn(() => runtime.client as ApiClient),
}));

import { createBrowserOpenbbGateway, type OpenbbGateway } from "./gateway.ts";
import {
  OPENBB_REQUEST_TIMEOUT_MS,
  OpenbbFilingsTab,
  OpenbbMarketsSection,
  OpenbbShortsPanel,
} from "./openbb-panels.tsx";

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
});

const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
};

const NOW = new Date("2026-11-08T15:00:00Z");

const VOL: OpenbbVolContextOutput = {
  asOf: "2026-11-06",
  indices: [
    { close: 19, date: "2026-11-06", id: "VIX" },
    { close: 17, date: "2026-11-06", id: "VIX9D" },
    { close: 120, date: "2026-11-05", id: "GVZ" },
  ],
  ivDaily: [
    {
      asOf: "2026-11-06",
      atmIv30d: 0.15,
      callIv25d30d: 0.12,
      callOi: 1,
      callVolume: 1,
      callWall: 600,
      contracts: 10,
      gammaFlip: 580,
      ivPercentile: 42,
      netGex: null,
      putIv25d30d: 0.2,
      putOi: 1,
      putVolume: 1,
      putWall: 550,
      sessions: 252,
      underlying: "SPY",
      underlyingPrice: 590,
    },
    {
      asOf: "2026-11-06",
      atmIv30d: null,
      callIv25d30d: null,
      callOi: 1,
      callVolume: 1,
      callWall: null,
      contracts: 10,
      gammaFlip: null,
      ivPercentile: null,
      netGex: null,
      putIv25d30d: null,
      putOi: 1,
      putVolume: 1,
      putWall: null,
      sessions: 3,
      underlying: "QQQ",
      underlyingPrice: 500,
    },
  ],
  ivOneYear: [
    {
      asOf: "2026-11-06",
      basis: "own_atm_iv",
      ivPercentile: 42,
      ivRank: 38,
      latestValue: 0.15,
      minSessions: 252,
      own: {
        asOf: "2026-11-06",
        ivPercentile: 42,
        ivRank: 38,
        latestValue: 0.15,
        minSessions: 252,
        reason: null,
        sessions: 252,
        windowSessions: 252,
      },
      proxy: {
        asOf: "2026-11-06",
        index: "VIX",
        ivPercentile: 40,
        ivRank: 35,
        latestValue: 19,
        minSessions: 252,
        reason: null,
        sessions: 252,
        windowSessions: 252,
      },
      proxyIndex: null,
      reason: null,
      sessions: 252,
      underlying: "SPY",
      unit: "decimal",
      windowSessions: 252,
    },
    {
      asOf: null,
      basis: null,
      ivPercentile: null,
      ivRank: null,
      latestValue: null,
      minSessions: 252,
      own: {
        asOf: "2026-11-06",
        ivPercentile: null,
        ivRank: null,
        latestValue: null,
        minSessions: 252,
        reason: "No ATM IV in the latest session",
        sessions: 2,
        windowSessions: 252,
      },
      proxy: {
        asOf: null,
        index: "VXN",
        ivPercentile: null,
        ivRank: null,
        latestValue: null,
        minSessions: 252,
        reason: "No VXN sessions stored",
        sessions: 0,
        windowSessions: 252,
      },
      proxyIndex: null,
      reason:
        "Own ATM IV: No ATM IV in the latest session; VXN proxy: No VXN sessions stored",
      sessions: 0,
      underlying: "QQQ",
      unit: null,
      windowSessions: 252,
    },
    {
      asOf: "2026-11-05",
      basis: "vol_index_proxy",
      ivPercentile: 78,
      ivRank: 64,
      latestValue: 22,
      minSessions: 252,
      own: {
        asOf: null,
        ivPercentile: null,
        ivRank: null,
        latestValue: null,
        minSessions: 252,
        reason: "No ATM IV sessions stored",
        sessions: 0,
        windowSessions: 252,
      },
      proxy: {
        asOf: "2026-11-05",
        index: "RVX",
        ivPercentile: 78,
        ivRank: 64,
        latestValue: 22,
        minSessions: 252,
        reason: null,
        sessions: 252,
        windowSessions: 252,
      },
      proxyIndex: "RVX",
      reason: null,
      sessions: 252,
      underlying: "IWM",
      unit: "vol_points",
      windowSessions: 252,
    },
  ],
  ratios: { vix3mVix6m: null, vix9dVix: 0.895, vixVix3m: 0.9 },
  term: [],
  vxCurve: {
    earlier: {
      asOf: "2026-10-30",
      points: [{ contractMonth: "2026-11", price: 17 }],
    },
    latest: {
      asOf: "2026-11-06",
      points: [{ contractMonth: "2026-11", price: 19 }],
    },
  },
};
const EMPTY_VOL: OpenbbVolContextOutput = {
  asOf: null,
  indices: [],
  ivDaily: [],
  ivOneYear: [],
  ratios: { vix3mVix6m: null, vix9dVix: null, vixVix3m: null },
  term: [],
  vxCurve: { earlier: null, latest: null },
};
const SHORTS: OpenbbShortsOutput = {
  from: "2026-06-21",
  ftd: [
    {
      cusip: "78462F103",
      price: 580,
      quantity: 1000,
      settlementDate: "2026-10-15",
      symbol: "SPY",
    },
  ],
  otcWeekly: [
    {
      lastUpdated: null,
      shares: 5_000_000,
      symbol: "SPY",
      tier: "T1",
      trades: 10,
      venue: "ats",
      weekStart: "2026-10-19",
    },
  ],
  shortInterest: [
    {
      avgDailyVolume: 1,
      daysToCover: 1.5,
      previousShortInterest: null,
      settlementDate: "2026-10-15",
      shortInterest: 2_000_000,
      symbol: "SPY",
    },
  ],
  shortVolume: [
    {
      date: "2026-11-06",
      shortExemptVolume: 0,
      shortRatio: 0.45,
      shortVolume: 45,
      symbol: "SPY",
      totalVolume: 100,
    },
  ],
  symbol: "SPY",
};
const EMPTY_SHORTS: OpenbbShortsOutput = {
  from: "2026-06-21",
  ftd: [],
  otcWeekly: [],
  shortInterest: [],
  shortVolume: [],
  symbol: "AAPL",
};
const SEC: OpenbbSecOutput = {
  changes13f: [
    {
      accessionNumber: "0001193125-26-463399",
      change: "added",
      cusip: "037833100",
      delayDays: 47,
      filedOn: "2026-11-16",
      filerCik: "1067983",
      filerName: "BERKSHIRE",
      issuer: "APPLE",
      optionType: "",
      period: "2026-09-30",
      previousPeriod: "2026-06-30",
      previousShares: 2e8,
      previousValue: 5e10,
      shares: 3e8,
      value: 6.75e10,
    },
  ],
  filings: [
    {
      accessionNumber: "0000320193-26-000105",
      cik: "320193",
      description: "",
      filingDate: "2026-10-31",
      formType: "10-K",
      reportDate: null,
      symbol: "AAPL",
      url: "https://www.sec.gov/x",
    },
  ],
  ftd: [],
  holdings13f: [
    {
      accessionNumber: "0001193125-26-463399",
      assetClass: null,
      cusip: "037833100",
      filedOn: "2026-11-16",
      filerCik: "1067983",
      filerName: "BERKSHIRE",
      issuer: "APPLE",
      optionType: "",
      periodEnding: "2026-09-30",
      shares: 3e8,
      symbol: "AAPL",
      value: 6.75e10,
      weight: null,
    },
    {
      accessionNumber: null,
      assetClass: null,
      cusip: "037833100",
      filedOn: null,
      filerCik: "1067983",
      filerName: "BERKSHIRE",
      issuer: "APPLE",
      optionType: "put",
      periodEnding: "2026-09-30",
      shares: null,
      symbol: null,
      value: 1,
      weight: null,
    },
  ],
  insiderTrades: [
    {
      accessionNumber: "0001140361-26-040001",
      acquiredDisposed: "D",
      filingDate: "2026-11-04",
      ownerName: "Owner",
      ownerTitle: "CEO",
      price: 225.5,
      rowNumber: 0,
      shares: 5e4,
      sharesAfter: null,
      symbol: "AAPL",
      transactionCode: "S",
      transactionDate: null,
      url: null,
    },
    {
      accessionNumber: "0001140361-26-040001",
      acquiredDisposed: null,
      filingDate: "2026-11-04",
      ownerName: "Other",
      ownerTitle: null,
      price: null,
      rowNumber: 1,
      shares: null,
      sharesAfter: null,
      symbol: "AAPL",
      transactionCode: null,
      transactionDate: null,
      url: null,
    },
  ],
  symbol: "AAPL",
};

const gatewayOf = (overrides: Partial<OpenbbGateway> = {}): OpenbbGateway => ({
  cot: vi.fn(async () => ({
    from: "2026-10-01",
    rows: [
      {
        category: "leveraged_funds" as const,
        long: 1,
        market: "ES",
        marketCode: "13874A",
        net: -5000,
        openInterest: 9,
        reportDate: "2026-11-03",
        reportType: "tff" as const,
        short: 2,
      },
    ],
  })),
  events: vi.fn(async (from: string, to: string) => ({
    events: [
      {
        date: "2026-11-10",
        detail: null,
        eventKey: "a",
        kind: "auction",
        source: "treasury",
        time: "11:30",
        title: "10Y auction",
      },
      {
        date: "2026-11-12",
        detail: null,
        eventKey: "b",
        kind: "fomc",
        source: "fed",
        time: null,
        title: "Minutes",
      },
    ],
    from,
    to,
  })),
  macro: vi.fn(async () => ({
    from: "2025-10-04",
    series: [
      {
        firstDate: "2026-11-05",
        frequency: "daily",
        id: "EFFR",
        lastDate: "2026-11-06",
        name: "Fed funds",
        pointCount: 1,
        points: [{ date: "2026-11-06", value: 3.87 }],
        source: "fed",
        unit: "percent",
        updatedAt: NOW,
      },
      {
        firstDate: "2026-11-05",
        frequency: "daily",
        id: "SOFR",
        lastDate: "2026-11-06",
        name: "SOFR",
        pointCount: 1,
        points: [],
        source: "fed",
        unit: "percent",
        updatedAt: NOW,
      },
    ],
  })),
  sec: vi.fn(async () => SEC),
  shorts: vi.fn(async () => SHORTS),
  status: vi.fn(async () => ({ runs: [], tables: [] })),
  volContext: vi.fn(async () => VOL),
  ...overrides,
});

const runOf = (
  job: string,
  extra: Partial<OpenbbStatusOutput["runs"][number]> = {}
): OpenbbStatusOutput["runs"][number] => ({
  blocked: null,
  error: null,
  finishedAt: NOW,
  id: `run-${job}`,
  job,
  openbbVersion: "1.4.0",
  rowsReceived: 0,
  rowsWritten: 0,
  startedAt: NOW,
  status: "ok",
  warnings: [],
  ...extra,
});

const text = (container: Element, selector: string) =>
  container.querySelector(selector)?.textContent ?? "";

describe("OpenbbMarketsSection", () => {
  it("renders every block with its as-of date", async () => {
    const gateway = gatewayOf();
    const { container } = await render(
      <OpenbbMarketsSection gateway={gateway} now={() => NOW} />
    );
    expect(gateway.cot).toHaveBeenCalledWith(8);
    expect(gateway.macro).toHaveBeenCalledWith("2025-10-04");
    expect(gateway.events).toHaveBeenCalledWith("2026-11-08", "2026-11-22");
    expect(text(container, "h2")).toBe("Vol, positioning and macro (OpenBB)");
    expect(text(container, '[data-openbb-block="vol-strip"]')).toContain(
      "As of 2026-11-06"
    );
    expect(text(container, "[data-vol-ratios]")).toBe(
      "VIX9D/VIX 0.895 · VIX/VIX3M 0.900 · VIX3M/VIX6M Not yet collected (VIX3M, VIX6M)"
    );
    expect(container.querySelectorAll("[data-vol-index]")).toHaveLength(2);
    expect(text(container, '[data-openbb-block="vx-curve"]')).toContain(
      "5 sessions earlier (2026-10-30)"
    );
    const iv = text(container, '[data-openbb-block="iv"]');
    expect(iv).toContain("15.0%");
    expect(iv).toContain("8.0%");
    expect(iv).toContain("42 / 38");
    expect(iv).toContain("Own ATM IV (252d, 2026-11-06)");
    expect(iv).toContain("Not computable");
    expect(iv).toContain("No ATM IV in the latest session");
    expect(iv).toContain("78 / 64");
    expect(iv).toContain("RVX proxy (252d, 2026-11-05)");
    expect(iv).toContain("Not yet collected");
    expect(iv).toContain("600.00 / 550.00");
    expect(text(container, '[data-openbb-block="cot"]')).toContain(
      "leveraged funds"
    );
    expect(text(container, '[data-openbb-block="macro"]')).toContain(
      "3.87 percent"
    );
    const events = text(container, '[data-openbb-block="events"]');
    expect(events).toContain("2026-11-10 11:30");
    expect(events).toContain("As of 2026-11-08");
  });

  it("shows the blocked notice and the second-source notice of a panel's job", async () => {
    const notices = (container: Element, block: string) =>
      [
        ...container.querySelectorAll(
          `[data-openbb-block="${block}"] [data-openbb-notice]`
        ),
      ].map((notice) => notice.textContent);
    const quiet = await render(
      <OpenbbMarketsSection gateway={gatewayOf()} now={() => NOW} />
    );
    expect(
      quiet.container.querySelectorAll("[data-openbb-notice]")
    ).toHaveLength(0);
    const gateway = gatewayOf({
      status: async () => ({
        runs: [
          runOf("cboe-option-iv", {
            blocked: {
              attempts: 2,
              nextRetryAt: new Date("2026-11-20T04:46:00.000Z"),
              since: new Date("2026-11-19T22:45:00.000Z"),
            },
            error: "HTTP 403 from cdn-api.cboe.com",
            status: "blocked_upstream",
          }),
          runOf("cboe-vx-curve", {
            status: "partial",
            warnings: [
              "cboe VX curve 2026-11-19: ContentTypeError: 403; used the CFE settlement file of 2026-11-19",
            ],
          }),
          runOf("cboe-vol-indices"),
        ],
        tables: [],
      }),
    });
    const { container } = await render(
      <OpenbbMarketsSection gateway={gateway} now={() => NOW} />
    );
    expect(notices(container, "iv")).toEqual([
      "Blocked upstream: HTTP 403 from cdn-api.cboe.com since Nov 19, 5:45 PM ET. Next retry: the first ingest run after Nov 19, 11:46 PM ET. The rows below are from the last good run.",
    ]);
    expect(notices(container, "vx-curve")).toEqual([
      "Source of the newest rows: CFE daily settlement file, because the Cboe curve read failed. Settlement prices differ slightly from the Cboe end-of-day quotes of earlier rows.",
    ]);
    expect(notices(container, "vol-strip")).toEqual([]);
    expect(
      container.querySelector("[data-openbb-notice]")?.getAttribute("role")
    ).toBe("status");
    // The rows of the last good run stay below the notice.
    expect(text(container, '[data-openbb-block="iv"]')).toContain("15.0%");
    // A partial fallback run shows the Yahoo source note instead of the blocked notice.
    const fallback = gatewayOf({
      status: async () => ({
        runs: [
          runOf("cboe-option-iv", {
            rowsReceived: 12,
            rowsWritten: 12,
            status: "partial",
            warnings: [
              "cboe chain SPY: ContentTypeError: 403; used the Yahoo option chain (IV: Yahoo column; greeks: Black-Scholes, rate 4%, trailing dividend yield)",
            ],
          }),
          runOf("cboe-vx-curve"),
          runOf("cboe-vol-indices"),
        ],
        tables: [],
      }),
    });
    const shown = await render(
      <OpenbbMarketsSection gateway={fallback} now={() => NOW} />
    );
    expect(notices(shown.container, "iv")).toEqual([
      "Source of the newest rows: Yahoo option chain for SPY (Yahoo implied volatility, Black-Scholes greeks), because the Cboe chain read failed. Values differ from the Cboe series of earlier rows; the IV percentile mixes the two methods across the boundary.",
    ]);
  });

  it("renders the panels without notices when the status read fails", async () => {
    const { container } = await render(
      <OpenbbMarketsSection
        gateway={gatewayOf({
          status: () => Promise.reject(new Error("status down")),
        })}
        now={() => NOW}
      />
    );
    expect(container.querySelectorAll("[data-openbb-notice]")).toHaveLength(0);
    expect(text(container, '[data-openbb-block="vol-strip"]')).toContain(
      "As of 2026-11-06"
    );
    expect(container.querySelector("[data-openbb-error]")).toBeNull();
  });

  it("shows Not yet collected for empty blocks and an empty curve without an earlier date", async () => {
    const gateway = gatewayOf({
      cot: async () => ({ from: "2026-10-01", rows: [] }),
      events: async (from, to) => ({ events: [], from, to }),
      macro: async () => ({ from: "2025-10-04", series: [] }),
      volContext: async () => EMPTY_VOL,
    });
    const { container } = await render(
      <OpenbbMarketsSection gateway={gateway} now={() => NOW} />
    );
    expect(container.querySelectorAll("[data-empty]")).toHaveLength(6);
    expect(container.querySelectorAll("[data-as-of]")).toHaveLength(6);
    expect(text(container, "[data-as-of]")).toBe("Not yet collected");
  });

  it("names a VX curve whose earlier session was never collected", async () => {
    const gateway = gatewayOf({
      volContext: async () => ({
        ...VOL,
        vxCurve: { earlier: null, latest: VOL.vxCurve.latest },
      }),
    });
    const { container } = await render(
      <OpenbbMarketsSection gateway={gateway} now={() => NOW} />
    );
    const curve = text(container, '[data-openbb-block="vx-curve"]');
    expect(curve).toContain("19.00");
    expect(curve).toContain("Not yet collectedNot yet collected");
    expect(curve).not.toContain("Not reported by source");
  });

  it("reports a failed load and operator-only access", async () => {
    const failing = await render(
      <OpenbbMarketsSection
        gateway={gatewayOf({
          volContext: () =>
            Promise.reject({ code: "STORAGE_ERROR", message: "down" }),
        })}
      />
    );
    expect(text(failing.container, "[data-openbb-error]")).toBe(
      "OpenBB market data unavailable. STORAGE_ERROR: down"
    );
    const forbidden = await render(
      <OpenbbMarketsSection
        gateway={gatewayOf({
          volContext: () =>
            Promise.reject({ code: "FORBIDDEN", message: "no", status: 403 }),
        })}
      />
    );
    expect(text(forbidden.container, "[data-openbb-error]")).toContain(
      "Operator access required"
    );
  });

  it("names the request time after the deadline and loads again on Retry", async () => {
    vi.useFakeTimers();
    try {
      let resolve: (value: OpenbbVolContextOutput) => void = () => undefined;
      const volContext = vi.fn(
        () =>
          new Promise<OpenbbVolContextOutput>((done) => {
            resolve = done;
          })
      );
      const { container } = await render(
        <OpenbbMarketsSection gateway={gatewayOf({ volContext })} />
      );
      expect(container.querySelector("[data-openbb-no-answer]")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(OPENBB_REQUEST_TIMEOUT_MS);
      });
      expect(container.querySelector("[aria-busy]")).toBeNull();
      expect(text(container, "[data-openbb-no-answer] p")).toMatch(
        /^OpenBB market data requested at \d{2}:\d{2}.* · no answer after 30 s$/u
      );
      const retry = container.querySelector<HTMLButtonElement>(
        "[data-openbb-no-answer] button"
      );
      expect(retry?.textContent).toBe("Retry");
      await act(async () => retry?.click());
      expect(volContext).toHaveBeenCalledTimes(2);
      expect(text(container, "[aria-busy]")).toBe(
        "Loading OpenBB market data…"
      );
      await act(async () => {
        vi.advanceTimersByTime(OPENBB_REQUEST_TIMEOUT_MS);
      });
      expect(container.querySelector("[data-openbb-no-answer]")).not.toBeNull();
      // An answer that arrives after the deadline still replaces the no-answer state.
      await act(async () => resolve(VOL));
      expect(container.querySelector("[data-openbb-no-answer]")).toBeNull();
      expect(text(container, '[data-openbb-block="vol-strip"]')).toContain(
        "As of 2026-11-06"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an answer that arrives after unmount", async () => {
    let resolve: (value: OpenbbVolContextOutput) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const pending = await render(
      <OpenbbMarketsSection
        gateway={gatewayOf({
          volContext: () =>
            new Promise((done) => {
              resolve = done;
            }),
        })}
      />
    );
    expect(text(pending.container, "[aria-busy]")).toBe(
      "Loading OpenBB market data…"
    );
    await act(async () => pending.root.unmount());
    await act(async () => resolve(VOL));
    const failing = await render(
      <OpenbbShortsPanel
        gateway={gatewayOf({
          shorts: () =>
            new Promise((_done, fail) => {
              reject = fail;
            }),
        })}
        symbol="SPY"
      />
    );
    await act(async () => failing.root.unmount());
    await act(async () => reject(new Error("late")));
    expect(document.querySelector("[data-openbb-error]")).toBeNull();
  });
});

describe("OpenbbShortsPanel and OpenbbFilingsTab", () => {
  it("renders the short, off-exchange, short interest and FTD blocks", async () => {
    const gateway = gatewayOf();
    const { container } = await render(
      <OpenbbShortsPanel gateway={gateway} symbol="SPY" />
    );
    expect(gateway.shorts).toHaveBeenCalledWith("SPY", 140);
    expect(text(container, '[data-openbb-block="short-volume"]')).toContain(
      "45.0%"
    );
    expect(text(container, '[data-openbb-block="otc"]')).toContain("5M");
    expect(text(container, '[data-openbb-block="short-interest"]')).toContain(
      "1.50"
    );
    expect(text(container, '[data-openbb-block="ftd"]')).toContain("580.00");
  });

  it("renders filings, insiders, 13F holders and short data for a symbol", async () => {
    const gateway = gatewayOf({ shorts: async () => EMPTY_SHORTS });
    const { container } = await render(
      <OpenbbFilingsTab gateway={gateway} symbol="AAPL" />
    );
    expect(gateway.sec).toHaveBeenCalledWith("AAPL");
    const link = container.querySelector('[data-openbb-block="filings"] a');
    expect(link?.getAttribute("href")).toBe("https://www.sec.gov/x");
    expect(link?.textContent).toBe("0000320193-26-000105");
    const insider = text(container, '[data-openbb-block="insider"]');
    expect(insider).toContain("Owner (CEO)");
    expect(insider).toContain("S D");
    expect(insider).toContain("OtherNot reported by source");
    const holders = text(container, '[data-openbb-block="13f"]');
    expect(holders).toContain("BERKSHIRE");
    expect(holders).toContain("put");
    // An empty option type is a plain share holding, not a value the source left out.
    expect(holders).toContain("Shares (no option)");
    const changes = text(container, '[data-openbb-block="13f-changes"]');
    expect(changes).toContain("added");
    expect(changes).toContain("2026-09-30 vs 2026-06-30");
    expect(changes).toContain("47");
    expect(changes).toContain("Source: SEC Form 13F-HR");
    expect(text(container, '[data-openbb-block="ftd"]')).toContain(
      "Not yet collected"
    );
  });

  it("names the symbol when filings fail to load and shows descriptions as link text", async () => {
    const failing = await render(
      <OpenbbFilingsTab
        gateway={gatewayOf({ sec: () => Promise.reject(new Error("x")) })}
        symbol="MSFT"
      />
    );
    expect(text(failing.container, "[data-openbb-error]")).toContain(
      "MSFT filings unavailable."
    );
    const described = await render(
      <OpenbbFilingsTab
        gateway={gatewayOf({
          sec: async () => ({
            ...SEC,
            filings: [
              {
                ...(SEC.filings[0] as OpenbbSecOutput["filings"][number]),
                description: "Annual report",
              },
            ],
          }),
        })}
        symbol="AAPL"
      />
    );
    expect(text(described.container, '[data-openbb-block="filings"] a')).toBe(
      "Annual report"
    );
    const empty = await render(
      <OpenbbFilingsTab
        gateway={gatewayOf({
          sec: async () => ({
            changes13f: [],
            filings: [],
            ftd: [],
            holdings13f: [],
            insiderTrades: [],
            symbol: "TSLA",
          }),
          shorts: async () => EMPTY_SHORTS,
        })}
        symbol="TSLA"
      />
    );
    expect(empty.container.querySelectorAll("[data-empty]")).toHaveLength(8);
    expect(
      text(empty.container, '[data-openbb-block="13f-changes"] [data-empty]')
    ).toContain("No tracked 13F filer held this symbol");
  });
});

describe("createBrowserOpenbbGateway", () => {
  it("forwards each read to the openbb client with one shared client", async () => {
    const openbb = {
      cot: vi.fn(async () => "cot"),
      events: vi.fn(async () => "events"),
      macro: vi.fn(async () => "macro"),
      sec: vi.fn(async () => "sec"),
      shorts: vi.fn(async () => "shorts"),
      status: vi.fn(async () => "status"),
      volContext: vi.fn(async () => "vol"),
    };
    runtime.client = { openbb } as unknown as ApiClient;
    const gateway = createBrowserOpenbbGateway();
    await gateway.volContext();
    await gateway.cot(5);
    await gateway.macro("2025-10-04");
    await gateway.events("2026-11-08", "2026-11-22");
    await gateway.shorts("SPY", 140);
    await gateway.sec("AAPL");
    await gateway.status();
    expect(openbb.status).toHaveBeenCalledWith({});
    expect(openbb.volContext).toHaveBeenCalledWith({});
    expect(openbb.cot).toHaveBeenCalledWith({ weeks: 5 });
    expect(openbb.macro).toHaveBeenCalledWith({ from: "2025-10-04" });
    expect(openbb.events).toHaveBeenCalledWith({
      from: "2026-11-08",
      to: "2026-11-22",
    });
    expect(openbb.shorts).toHaveBeenCalledWith({ days: 140, symbol: "SPY" });
    expect(openbb.sec).toHaveBeenCalledWith({ symbol: "AAPL" });
  });

  it("builds a browser gateway when none is supplied", async () => {
    runtime.client = {
      openbb: { shorts: vi.fn(async () => EMPTY_SHORTS) },
    } as unknown as ApiClient;
    const { container } = await render(<OpenbbShortsPanel symbol="AAPL" />);
    expect(container.querySelectorAll("[data-empty]")).toHaveLength(4);
    runtime.client = {
      openbb: {
        sec: vi.fn(async () => SEC),
        shorts: vi.fn(async () => EMPTY_SHORTS),
      },
    } as unknown as ApiClient;
    const filings = await render(<OpenbbFilingsTab symbol="AAPL" />);
    expect(
      filings.container.querySelector('[data-openbb-block="13f"]')
    ).not.toBeNull();
    runtime.client = {
      openbb: {
        cot: vi.fn(async () => ({ from: "x", rows: [] })),
        events: vi.fn(async () => ({ events: [], from: "x", to: "y" })),
        macro: vi.fn(async () => ({ from: "2025-10-04", series: [] })),
        status: vi.fn(async () => ({ runs: [], tables: [] })),
        volContext: vi.fn(async () => EMPTY_VOL),
      },
    } as unknown as ApiClient;
    const markets = await render(<OpenbbMarketsSection />);
    expect(markets.container.querySelectorAll("[data-empty]")).toHaveLength(6);
  });
});
