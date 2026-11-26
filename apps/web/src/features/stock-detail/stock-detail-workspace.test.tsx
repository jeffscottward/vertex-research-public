// @vitest-environment jsdom
import type { OptionsChainOutput } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const chartProps = vi.hoisted(() => ({
  last: null as null | Record<string, unknown>,
}));
vi.mock("../charts/market-chart.tsx", () => ({
  MarketBarsChart: (props: Record<string, unknown>) => {
    chartProps.last = props;
    return null;
  },
}));

import type { MarketDataGateway } from "../../components/portal/market-data-client.ts";
import type { OptionsAnalyticsGateway } from "../../components/portal/options-analytics-client.ts";
import {
  createFakeMarketDataGateway,
  createFakeOptionsChainGateway,
} from "./fake-gateways.ts";
import type { OptionsChainGateway } from "./options-chain-client.ts";
import {
  CHAIN_REQUEST_TIMEOUT_MS,
  chainFlow,
  chainKpis,
  chainSummary,
  StockDetailWorkspace,
} from "./stock-detail-workspace.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  chartProps.last = null;
});

const flush = async () => {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
};
const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    await flush();
  });
  return container;
};
const run = async (action: () => void) =>
  await act(async () => {
    action();
    await flush();
  });

const pendingAnalytics = (): OptionsAnalyticsGateway => ({
  greekHeatmap: vi.fn(() => new Promise<never>(() => undefined)),
  snapshot: vi.fn(() => new Promise<never>(() => undefined)),
});

const spies = () => {
  const chain = createFakeOptionsChainGateway();
  const market = createFakeMarketDataGateway();
  return {
    analytics: pendingAnalytics(),
    chain: {
      chain: vi.fn(chain.chain),
      expectedMove: vi.fn(chain.expectedMove),
      expiries: vi.fn(chain.expiries),
    } satisfies OptionsChainGateway,
    market: { bars: vi.fn(market.bars) } satisfies MarketDataGateway,
  };
};

const workspace = (
  symbol: string,
  gateways: ReturnType<typeof spies>
): ReactElement => (
  <StockDetailWorkspace
    marketData={gateways.market}
    optionsAnalytics={gateways.analytics}
    optionsChain={gateways.chain}
    symbol={symbol}
  />
);

const link = (container: HTMLElement, label: string): HTMLAnchorElement => {
  const found = [...container.querySelectorAll("nav a")].find(
    (node) => node.textContent === label
  );
  if (!(found instanceof HTMLAnchorElement))
    throw new Error(`Missing tab ${label}`);
  return found;
};

vi.mock("../openbb/openbb-panels.tsx", () => ({
  OpenbbFilingsTab: (props: { gateway?: unknown; symbol: string }) => (
    <div
      data-filings={props.symbol}
      data-gateway={props.gateway === undefined ? "browser" : "supplied"}
    />
  ),
}));

describe("StockDetailWorkspace", () => {
  it("passes a supplied openbb gateway to the filings tab", async () => {
    window.history.pushState(null, "", "/stock/AAPL?tab=filings");
    const gateways = spies();
    const container = await mount(
      <StockDetailWorkspace
        marketData={gateways.market}
        openbb={{} as never}
        optionsAnalytics={gateways.analytics}
        optionsChain={gateways.chain}
        symbol="AAPL"
      />
    );
    expect(
      container
        .querySelector('[data-filings="AAPL"]')
        ?.getAttribute("data-gateway")
    ).toBe("supplied");
  });

  it("mounts IvRankHistoryPanel on the analytics tab with the supplied openbb gateway", async () => {
    window.history.pushState(null, "", "/stock/SPY?tab=analytics");
    const gateways = spies();
    const ivHistory = vi.fn(async () => ({
      asOf: null,
      basis: null,
      latest: null,
      minSessions: 252 as const,
      own: {
        asOf: null,
        ivPercentile: null,
        ivRank: null,
        latestValue: null,
        minSessions: 252 as const,
        reason: "No ATM IV sessions stored",
        sessions: 0,
        windowSessions: 252 as const,
      },
      points: [],
      proxy: null,
      proxyIndex: null,
      reason: "Own ATM IV: No ATM IV sessions stored",
      requestedSessions: 252 as const,
      symbol: "SPY",
      unit: null,
      windowSessions: 252 as const,
    }));
    const container = await mount(
      <StockDetailWorkspace
        marketData={gateways.market}
        openbb={{ ivHistory } as never}
        optionsAnalytics={gateways.analytics}
        optionsChain={gateways.chain}
        symbol="SPY"
      />
    );
    expect(ivHistory).toHaveBeenCalledWith("SPY", 252);
    expect(container.querySelector('[data-iv-history="SPY"]')).not.toBeNull();
  });
  it("opens with the 1D chart and the nearest expiry chain without input", async () => {
    window.history.replaceState(null, "", "/stock/NVDA");
    const gateways = spies();
    const container = await mount(workspace("NVDA", gateways));
    expect(gateways.market.bars).toHaveBeenCalledWith(
      expect.objectContaining({
        barSize: "1 day",
        duration: "1 Y",
        secType: "STK",
        symbol: "NVDA",
      })
    );
    expect(gateways.chain.chain).toHaveBeenCalledWith({ symbol: "NVDA" });
    expect(chartProps.last?.["candles"]).toHaveLength(252);
    expect(chartProps.last?.["studies"]).toMatchObject({
      extra: ["macd"],
      volume: true,
    });
    expect(
      container.querySelector("[data-stock-chart=NVDA] h2")?.textContent
    ).toBe("NVDA price · 1D");
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Expiry"]'
    );
    expect(select?.value).toBe("2026-11-06");
    expect(select?.options.length).toBe(10);
    expect(
      container.querySelectorAll("[data-chain-layout=split] tbody tr")
    ).toHaveLength(20);
    const kpis =
      container.querySelector("[data-stock-kpis]")?.textContent ?? "";
    expect(kpis).toContain("$251.64");
    expect(kpis).toContain("2 days · 10 expiries listed");
    expect(kpis).toContain("ATM IV");
    expect(
      container.querySelector("[data-chain-notes]")?.textContent
    ).toContain("DUMMY DATA");
    expect(link(container, "Chart").getAttribute("aria-current")).toBe("page");
  });

  it("switches expiry, strikes, interval and tab through the URL", async () => {
    window.history.replaceState(null, "", "/stock/NVDA");
    const gateways = spies();
    const container = await mount(workspace("NVDA", gateways));
    const expiry = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Expiry"]'
    );
    await run(() => {
      if (expiry === null) return;
      expiry.value = "2026-12-18";
      expiry.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(gateways.chain.chain).toHaveBeenLastCalledWith({
      expiry: "2026-12-18",
      symbol: "NVDA",
    });
    expect(window.location.search).toBe("?expiry=2026-12-18");
    const strikes = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Strikes"]'
    );
    await run(() => {
      if (strikes === null) return;
      strikes.value = "all";
      strikes.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      container.querySelectorAll("[data-chain-layout=split] tbody tr")
    ).toHaveLength(41);
    await run(() => {
      if (strikes === null) return;
      strikes.value = "10";
      strikes.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      container.querySelectorAll("[data-chain-layout=split] tbody tr")
    ).toHaveLength(10);
    const weekly = [
      ...container.querySelectorAll<HTMLButtonElement>(
        "[data-chart-toolbar] button"
      ),
    ].find((button) => button.textContent === "1W");
    await run(() => weekly?.click());
    expect(window.location.search).toBe("?interval=1W&expiry=2026-12-18");
    const weeks = chartProps.last?.["candles"];
    expect(Array.isArray(weeks) ? weeks.length : 0).toBeLessThan(60);
    await run(() => link(container, "Options chain").click());
    expect(window.location.search).toBe(
      "?interval=1W&expiry=2026-12-18&tab=options"
    );
    expect(container.querySelector("[data-stock-chart]")).toBeNull();
    expect(container.querySelector("[data-chain-panel]")).not.toBeNull();
    await run(() => link(container, "Analytics").click());
    expect(container.querySelector("[data-chain-panel]")).toBeNull();
    expect(gateways.analytics.snapshot).toHaveBeenCalledWith({
      flowHours: 24,
      symbol: "NVDA",
    });
    await run(() => link(container, "Filings").click());
    expect(window.location.search).toContain("tab=filings");
    expect(
      container
        .querySelector('[data-filings="NVDA"]')
        ?.getAttribute("data-gateway")
    ).toBe("browser");
    expect(container.querySelector("[data-chain-panel]")).toBeNull();
    // Back to the chart tab via history.
    window.history.pushState(null, "", "/stock/NVDA?interval=5m");
    await run(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(gateways.market.bars).toHaveBeenLastCalledWith(
      expect.objectContaining({ barSize: "5 mins" })
    );
    expect(link(container, "Chart").getAttribute("href")).toBe("?interval=5m");
  });

  it("keeps the expiry select mounted and focused while the next chain loads", async () => {
    window.history.replaceState(null, "", "/stock/NVDA");
    const gateways = spies();
    const container = await mount(workspace("NVDA", gateways));
    const expiry = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Expiry"]'
    );
    expiry?.focus();
    gateways.chain.chain.mockImplementation(() => new Promise(() => undefined));
    await run(() => {
      if (expiry === null) return;
      expiry.value = "2026-11-13";
      expiry.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("Loading NVDA options");
    const during = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Expiry"]'
    );
    expect(during).toBe(expiry);
    expect(document.activeElement).toBe(expiry);
    expect(during?.value).toBe("2026-11-13");
  });

  it("falls back to the nearest expiry for an unlisted expiry link", async () => {
    window.history.replaceState(
      null,
      "",
      "/stock/NVDA?expiry=2030-01-18&tab=options"
    );
    const gateways = spies();
    const container = await mount(workspace("NVDA", gateways));
    expect(gateways.chain.chain).toHaveBeenCalledWith({
      expiry: "2030-01-18",
      symbol: "NVDA",
    });
    expect(gateways.chain.chain).toHaveBeenLastCalledWith({ symbol: "NVDA" });
    expect(window.location.search).toBe("?tab=options");
    expect(container.textContent).toContain(
      "No options expire on 2030-01-18. Showing the nearest expiry."
    );
    const expiry = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Expiry"]'
    );
    await run(() => {
      if (expiry === null) return;
      expiry.value = "2026-11-13";
      expiry.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("No options expire on");
  });

  it("clears the fallback notice on a tab change or back/forward", async () => {
    window.history.replaceState(null, "", "/stock/NVDA?expiry=2030-01-18");
    const container = await mount(workspace("NVDA", spies()));
    expect(container.textContent).toContain("No options expire on 2030-01-18");
    await run(() => link(container, "Options chain").click());
    expect(container.textContent).not.toContain("No options expire on");
    window.history.replaceState(null, "", "/stock/NVDA?expiry=2030-01-18");
    await run(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(container.textContent).toContain("No options expire on 2030-01-18");
    window.history.pushState(null, "", "/stock/NVDA?tab=options");
    await run(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(container.textContent).not.toContain("No options expire on");
  });

  it("asks for share-class bars with a dot", async () => {
    window.history.replaceState(null, "", "/stock/BF-B");
    const gateways = spies();
    await mount(workspace("BF-B", gateways));
    expect(gateways.market.bars).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "BF.B" })
    );
    expect(gateways.chain.chain).toHaveBeenCalledWith({ symbol: "BF-B" });
  });

  it("shows provider errors for the chain and the chart", async () => {
    window.history.replaceState(null, "", "/stock/FAIL");
    const container = await mount(workspace("FAIL", spies()));
    const alerts = [...container.querySelectorAll("[role=alert]")].map((node) =>
      node.getAttribute("data-error-code")
    );
    expect(alerts).toEqual(["UNAVAILABLE", "UNAVAILABLE"]);
    expect(container.querySelector("[data-stock-kpis]")?.textContent).toContain(
      "Nearest listed expiry"
    );
    expect(container.querySelector("[data-stock-kpis]")?.textContent).toContain(
      "Not loaded: "
    );
    const noOptions = await mount(workspace("NOOPT", spies()));
    expect(
      noOptions.querySelector("[data-chain-panel] [role=alert]")?.textContent
    ).toContain("NOT_FOUND");
  });

  it("reports an empty bar series and ignores late answers after unmount", async () => {
    window.history.replaceState(null, "", "/stock/NVDA");
    const gateways = spies();
    let release: () => void = () => undefined;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = await createFakeMarketDataGateway().bars({ symbol: "NVDA" });
    gateways.market.bars.mockImplementation(async () => ({
      ...base,
      bars: [],
    }));
    const container = await mount(workspace("NVDA", gateways));
    expect(container.textContent).toContain("No bars returned for NVDA.");
    // Late success after the interval changed and the page closed.
    gateways.market.bars.mockImplementation(async () => {
      await late;
      return base;
    });
    gateways.chain.chain.mockImplementation(async () => {
      await late;
      return await createFakeOptionsChainGateway().chain({ symbol: "NVDA" });
    });
    const hourly = [
      ...container.querySelectorAll<HTMLButtonElement>(
        "[data-chart-toolbar] button"
      ),
    ].find((button) => button.textContent === "1h");
    await run(() => hourly?.click());
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      release();
      await flush();
    });
    // Late failures after the page closed.
    const failing = spies();
    let fail: () => void = () => undefined;
    const lateFailure = new Promise<void>((resolve) => {
      fail = resolve;
    });
    failing.market.bars.mockImplementation(async () => {
      await lateFailure;
      throw new Error("late");
    });
    failing.chain.chain.mockImplementation(async () => {
      await lateFailure;
      throw new Error("late");
    });
    await mount(workspace("NVDA", failing));
    const succeeding = spies();
    succeeding.chain.chain.mockImplementation(async () => {
      await lateFailure;
      return await createFakeOptionsChainGateway().chain({ symbol: "NVDA" });
    });
    await mount(workspace("NVDA", succeeding));
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      fail();
      await flush();
    });
    const later = spies();
    later.chain.chain.mockImplementation(() => new Promise(() => undefined));
    const second = await mount(workspace("NVDA", later));
    expect(second.textContent).toContain("Loading NVDA options");
  });
});

describe("last price card", () => {
  const subText = async (
    change: Partial<Pick<OptionsChainOutput, "quoteTime" | "spotSource">>
  ) => {
    const gateways = spies();
    const chain = await createFakeOptionsChainGateway().chain({
      symbol: "NVDA",
    });
    gateways.chain.chain.mockImplementation(async () => ({
      ...chain,
      ...change,
    }));
    const container = await mount(workspace("NVDA", gateways));
    return container.querySelector("[data-stock-kpis]")?.textContent ?? "";
  };

  it("names the source of the spot when it sends no quote time", async () => {
    // The dummy chain: a Quant Data spot without a quote time.
    await expect(subText({})).resolves.toContain("Spot from Quant Data");
    await expect(subText({ spotSource: "ibkr" })).resolves.toContain(
      "Spot from IBKR"
    );
    await expect(subText({ spotSource: "yahoo" })).resolves.toContain(
      "Spot from Yahoo Finance"
    );
  });

  it("shows the quote time when there is one, and the plain text without a source", async () => {
    const timed = await subText({
      quoteTime: "2026-11-04T15:00:00.000Z",
      spotSource: "ibkr",
    });
    expect(timed).toContain("Quote 04 Nov 2026 15:00 UTC");
    expect(timed).not.toContain("Spot from");
    const unknown = await subText({ spotSource: null });
    expect(unknown).toContain("Spot from the options feed");
    // While the chain loads there is no source yet.
    const loading = spies();
    loading.chain.chain.mockImplementation(() => new Promise(() => undefined));
    const pending = await mount(workspace("NVDA", loading));
    expect(pending.querySelector("[data-stock-kpis]")?.textContent).toContain(
      "Spot from the options feed"
    );
  });
});

describe("chain source and flow lines", () => {
  it("shows what each source did and the Quant Data flow under the KPI row", async () => {
    const container = await mount(workspace("NVDA", spies()));
    const lines = container.querySelector("[data-chain-sources]");
    expect(lines?.previousElementSibling?.hasAttribute("data-stock-kpis")).toBe(
      true
    );
    expect(lines?.querySelector("p")?.textContent).toBe(
      "Sources · Quant Data: used · IBKR: used · Yahoo Finance: used"
    );
    expect(lines?.querySelector("[data-source-message]")).toBeNull();
    const chain = await createFakeOptionsChainGateway().chain({
      symbol: "NVDA",
    });
    const flow = chainFlow(chain);
    expect(flow?.call).toBeGreaterThan(1000);
    expect(flow?.put).toBeGreaterThan(1000);
    expect(container.querySelector("[data-chain-flow]")?.textContent).toMatch(
      /^Quant Data flow · call premium \$[\d.]+[KMB]? · put premium \$[\d.]+[KMB]? \(this expiry\)$/u
    );
  });

  it("shows each source reason as visible text and hides the flow line without flow", async () => {
    const gateways = spies();
    const chain = await createFakeOptionsChainGateway().chain({
      symbol: "NVDA",
    });
    gateways.chain.chain.mockImplementation(async () => ({
      ...chain,
      rows: chain.rows.map((row) => ({
        call: row.call === null ? null : { ...row.call, flow: null },
        put: row.put === null ? null : { ...row.put, flow: null },
        strike: row.strike,
      })),
      sources: [
        {
          message: "QuantData termStructure: HTTP 500.",
          source: "quantdata",
          status: "failed",
        },
        {
          message: "IBKR is asked only during the US regular session",
          source: "ibkr",
          status: "off",
        },
        {
          message: "Yahoo Finance has no option rows for this expiry",
          source: "yahoo",
          status: "empty",
        },
      ],
    }));
    const container = await mount(workspace("NVDA", gateways));
    const items = [
      ...container.querySelectorAll("[data-chain-sources] [data-source]"),
    ].map((node) => [
      node.getAttribute("data-source"),
      node.getAttribute("data-status"),
      node.textContent,
    ]);
    expect(items).toEqual([
      [
        "quantdata",
        "failed",
        " · Quant Data: failed (QuantData termStructure: HTTP 500.)",
      ],
      [
        "ibkr",
        "off",
        " · IBKR: off (IBKR is asked only during the US regular session)",
      ],
      [
        "yahoo",
        "empty",
        " · Yahoo Finance: no data (Yahoo Finance has no option rows for this expiry)",
      ],
    ]);
    // A long message without spaces breaks instead of overflowing a narrow screen.
    expect(
      container.querySelector("[data-chain-sources]")?.className.split(" ")
    ).toContain("break-words");
    // Text only: nothing is left for a hover title.
    expect(
      container.querySelectorAll("[data-chain-sources] [title]")
    ).toHaveLength(0);
    expect(container.querySelector("[data-chain-flow]")).toBeNull();
  });

  it("shows the warning of a used source and marks first-page flow", async () => {
    const gateways = spies();
    const chain = await createFakeOptionsChainGateway().chain({
      symbol: "NVDA",
    });
    const warning =
      "Quant Data order flow: first provider page only, so flow totals can be too low";
    gateways.chain.chain.mockImplementation(async () => ({
      ...chain,
      flowFirstPageOnly: true,
      sources: [
        { message: warning, source: "quantdata", status: "used" },
        chain.sources[1],
        chain.sources[2],
      ],
    }));
    const container = await mount(workspace("NVDA", gateways));
    expect(container.querySelector("[data-chain-sources] p")?.textContent).toBe(
      `Sources · Quant Data: used (${warning}) · IBKR: used · Yahoo Finance: used`
    );
    expect(container.querySelector("[data-chain-flow]")?.textContent).toMatch(
      /\(this expiry, first provider page only\)$/u
    );
  });

  it("shows no source line while the chain loads or after it failed", async () => {
    const loading = spies();
    loading.chain.chain.mockImplementation(() => new Promise(() => undefined));
    const pending = await mount(workspace("NVDA", loading));
    expect(pending.querySelector("[data-chain-sources]")).toBeNull();
    const failed = await mount(workspace("FAIL", spies()));
    expect(failed.querySelector("[data-error-code]")).not.toBeNull();
    expect(failed.querySelector("[data-chain-sources]")).toBeNull();
  });
});

describe("chainFlow", () => {
  it("sums call and put premium, and is null without any flow", async () => {
    const chain = await createFakeOptionsChainGateway().chain({
      symbol: "NVDA",
    });
    const call = chain.rows[20]?.call ?? null;
    const flow = { premium: 1500.5, trades: 2, volume: 30 };
    expect(chainFlow({ ...chain, rows: [] })).toBeNull();
    expect(
      chainFlow({
        ...chain,
        rows: [
          { call: null, put: null, strike: 90 },
          {
            call: call === null ? null : { ...call, flow: null },
            put: null,
            strike: 95,
          },
        ],
      })
    ).toBeNull();
    expect(
      chainFlow({
        ...chain,
        rows: [
          {
            call: call === null ? null : { ...call, flow },
            put: null,
            strike: 100,
          },
          {
            call: call === null ? null : { ...call, flow },
            put:
              call === null
                ? null
                : { ...call, flow: { ...flow, premium: 10 } },
            strike: 105,
          },
        ],
      })
    ).toEqual({ call: 3001, put: 10 });
    // Puts alone still give a line.
    expect(
      chainFlow({
        ...chain,
        rows: [
          {
            call: null,
            put: call === null ? null : { ...call, flow },
            strike: 100,
          },
        ],
      })
    ).toEqual({ call: 0, put: 1500.5 });
  });
});

describe("chainKpis", () => {
  it("names the chain state while there is no chain", () => {
    // Every tile shows the state; the Put/call OI tile keeps it in the detail under a short value.
    const notReady = (text: string) => ({
      atmIv: text,
      expiry: text,
      price: text,
      putCallOiDetail: text,
      putCallOiValue: "No ratio",
      strike: text,
    });
    expect(chainKpis({ type: "loading" })).toEqual(notReady("Loading…"));
    expect(
      chainKpis({
        failure: {
          code: "UNAVAILABLE",
          message: "The options feed did not answer.",
        },
        type: "error",
      })
    ).toEqual(notReady("Not loaded: The options feed did not answer."));
    expect(chainKpis({ startedAt: 0, type: "no-answer" })).toEqual(
      notReady("Not loaded: no answer after 30 s")
    );
  });

  it("names each value a loaded chain lacks", async () => {
    const chain = await createFakeOptionsChainGateway().chain({
      symbol: "NVDA",
    });
    const full = chainKpis({ chain, type: "ready" });
    expect(full.price).toBe("$251.64");
    expect(full.strike).toMatch(/^Strike \d+\.\d{2}$/u);
    expect(full.atmIv).toMatch(/^\d+\.\d%$/u);
    expect(full.putCallOiValue).toMatch(/^\d+\.\d{2}$/u);
    expect(full.putCallOiDetail).toBe(
      "OI reported for 41 of 41 calls and 41 of 41 puts in the returned chain"
    );
    expect(
      chainKpis({ chain: { ...chain, rows: [], spot: null }, type: "ready" })
    ).toEqual({
      atmIv: "No ATM strike for this expiry",
      expiry: full.expiry,
      price: "No price in this chain snapshot",
      putCallOiDetail: "No contracts in the returned chain",
      putCallOiValue: "No ratio",
      strike: "No ATM strike for this expiry",
    });
    const noIv = chainKpis({
      chain: {
        ...chain,
        rows: [{ call: null, put: null, strike: 250 }],
        spot: 250,
      },
      type: "ready",
    });
    expect(noIv.atmIv).toBe("No IV at the ATM strike");
    expect(noIv.strike).toBe("Strike 250.00");
  });

  it("keeps the put/call OI value short and gives the reason in the detail", async () => {
    const chain = await createFakeOptionsChainGateway().chain({
      symbol: "NVDA",
    });
    const legs = chain.rows.find(
      (row) => row.put !== null && row.call !== null
    );
    const put = legs?.put ?? null;
    const call = legs?.call ?? null;
    expect(put).not.toBeNull();
    expect(call).not.toBeNull();
    // Each row: call and put open interest, null when not reported, "absent" for no contract.
    type Leg = number | null | "absent";
    const oi = (...rows: readonly (readonly [Leg, Leg])[]) => {
      const kpis = chainKpis({
        chain: {
          ...chain,
          rows: rows.map(([callOi, putOi], index) => ({
            call:
              callOi === "absent" || call === null
                ? null
                : { ...call, openInterest: callOi },
            put:
              putOi === "absent" || put === null
                ? null
                : { ...put, openInterest: putOi },
            strike: 250 + index,
          })),
          spot: 250,
        },
        type: "ready",
      });
      return [kpis.putCallOiValue, kpis.putCallOiDetail];
    };
    expect(oi([400, 600])).toEqual([
      "1.50",
      "OI reported for 1 of 1 calls and 1 of 1 puts in the returned chain",
    ]);
    // A reported put total of 0 is a ratio of 0, not a missing ratio.
    expect(oi([400, 0], [100, 0])).toEqual([
      "0.00",
      "OI reported for 2 of 2 calls and 2 of 2 puts in the returned chain",
    ]);
    expect(oi(["absent", "absent"])).toEqual([
      "No ratio",
      "No contracts in the returned chain",
    ]);
    expect(oi([0, 0])).toEqual([
      "No ratio",
      "Reported call and put OI totals are 0",
    ]);
    expect(oi([0, 1200])).toEqual([
      "No ratio",
      "Call OI is 0; a ratio needs call OI above 0",
    ]);
    // Puts and no call contracts: no ratio, and the puts are not zero.
    expect(oi(["absent", 1200])).toEqual([
      "No ratio",
      "No call contracts; OI reported for 1 of 1 puts in the returned chain",
    ]);
    expect(oi(["absent", null], ["absent", 300])).toEqual([
      "No ratio",
      "No call contracts; OI reported for 1 of 2 puts in the returned chain",
    ]);
    expect(oi([400, "absent"], [null, "absent"], [null, "absent"])).toEqual([
      "No ratio",
      "No put contracts; OI reported for 1 of 3 calls in the returned chain",
    ]);
    expect(oi([null, null])).toEqual([
      "No ratio",
      "OI reported for 0 of 1 calls and 0 of 1 puts in the returned chain",
    ]);
    expect(oi([400, null])).toEqual([
      "No ratio",
      "OI reported for 1 of 1 calls and 0 of 1 puts in the returned chain",
    ]);
    // A partly reported side is never summed as complete.
    expect(oi([0, 1200], [null, 300], [null, null])).toEqual([
      "No ratio",
      "OI reported for 1 of 3 calls and 2 of 3 puts in the returned chain",
    ]);
  });
});

describe("chain request deadline", () => {
  it("names the request time after the deadline and loads again on Retry", async () => {
    vi.useFakeTimers();
    try {
      const gateways = spies();
      const chain = await createFakeOptionsChainGateway().chain({
        symbol: "NVDA",
      });
      let resolve: (value: OptionsChainOutput) => void = () => undefined;
      gateways.chain.chain.mockImplementation(
        () =>
          new Promise<OptionsChainOutput>((done) => {
            resolve = done;
          })
      );
      const container = await mount(workspace("NVDA", gateways));
      const kpis = () => container.querySelector("[data-stock-kpis]");
      const oiDetails = () =>
        kpis()?.querySelector("dl:last-child")?.querySelectorAll("dd");
      expect(kpis()?.textContent).toContain("Loading…");
      expect(kpis()?.textContent).not.toContain("—");
      expect(oiDetails()?.[0]?.textContent).toBe("No ratio");
      expect(oiDetails()?.[1]?.textContent).toBe("Loading…");
      await run(() => vi.advanceTimersByTime(CHAIN_REQUEST_TIMEOUT_MS));
      expect(
        container.querySelector("[data-chain-no-answer] p")?.textContent
      ).toMatch(
        /^NVDA options requested at \d{2}:\d{2}.* · no answer after 30 s$/u
      );
      expect(kpis()?.textContent).toContain("Not loaded: no answer after 30 s");
      expect(oiDetails()?.[0]?.textContent).toBe("No ratio");
      expect(oiDetails()?.[1]?.textContent).toBe(
        "Not loaded: no answer after 30 s"
      );
      const retry = container.querySelector<HTMLButtonElement>(
        "[data-chain-no-answer] button"
      );
      expect(retry?.textContent).toBe("Retry");
      await run(() => retry?.click());
      expect(gateways.chain.chain).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("Loading NVDA options");
      await run(() => vi.advanceTimersByTime(CHAIN_REQUEST_TIMEOUT_MS));
      expect(container.querySelector("[data-chain-no-answer]")).not.toBeNull();
      // An answer that arrives after the deadline still replaces the no-answer state.
      await run(() => resolve(chain));
      expect(container.querySelector("[data-chain-no-answer]")).toBeNull();
      expect(kpis()?.textContent).toContain("$251.64");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("expected move on stock chart tab", () => {
  it("shows ExpectedMoveBar by default, toggles off/on, and syncs expiry switches", async () => {
    const gateways = spies();
    const host = await mount(workspace("SPY", gateways));
    const bar = host.querySelector("[data-expected-move-bar]");
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain("±1σ move");
    const expirySelect = host.querySelector<HTMLSelectElement>(
      "[data-expected-move-expiry]"
    );
    expect(expirySelect).not.toBeNull();
    const secondDate = expirySelect?.options[1]?.value ?? "";
    expect(secondDate).not.toBe("");
    await run(() => {
      if (expirySelect) {
        expirySelect.value = secondDate;
        expirySelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(gateways.chain.chain).toHaveBeenLastCalledWith({
      expiry: secondDate,
      symbol: "SPY",
    });

    const toggle = host.querySelector<HTMLInputElement>(
      "[data-expected-move-toggle]"
    )!;
    expect(toggle.checked).toBe(true);
    await run(() => toggle.click());
    expect(host.querySelector("[data-expected-move-bar]")).toBeNull();
    await run(() => toggle.click());
    expect(host.querySelector("[data-expected-move-bar]")).not.toBeNull();

    // Retry from ExpectedMoveBar re-requests the chain
    const failed = spies();
    const failHost = await mount(workspace("FAIL", failed));
    const retryBtn = failHost.querySelector<HTMLButtonElement>(
      "[data-expected-move-bar] button"
    );
    expect(retryBtn).not.toBeNull();
    const beforeCalls = failed.chain.chain.mock.calls.length;
    await run(() => retryBtn?.click());
    expect(failed.chain.chain.mock.calls.length).toBe(beforeCalls + 1);
  });
});

describe("chainSummary", () => {
  it("averages ATM IV and sums open interest", async () => {
    const chain = await createFakeOptionsChainGateway().chain({
      symbol: "NVDA",
    });
    const summary = chainSummary(chain);
    expect(summary.atmStrike).toBe(chain.rows[20]?.strike);
    expect(summary.atmIv).toBeGreaterThan(0.2);
    expect(summary.putCallOi).toBeCloseTo(1, 1);
    const empty: OptionsChainOutput = { ...chain, rows: [], spot: null };
    const none = { contracts: 0, reported: 0, total: 0 };
    expect(chainSummary(empty)).toEqual({
      atmIv: null,
      atmStrike: null,
      calls: none,
      putCallOi: null,
      puts: none,
    });
    expect(
      chainSummary({
        ...chain,
        rows: [{ call: null, put: null, strike: 250 }],
        spot: 250,
      })
    ).toEqual({
      atmIv: null,
      atmStrike: 250,
      calls: none,
      putCallOi: null,
      puts: none,
    });
  });
});
