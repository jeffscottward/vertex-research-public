// @vitest-environment jsdom
import type {
  BacktestGetOutput,
  FlowEventsOutput,
  MarketBarsInput,
  MarketBarsOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
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

const chartProps = vi.hoisted(() => ({
  last: null as null | Record<string, unknown>,
}));
vi.mock("../../features/charts/market-chart.tsx", () => ({
  MarketBarsChart: (props: Record<string, unknown>) => {
    chartProps.last = props;
    return null;
  },
}));

import type { OrderFlowGateway } from "../../features/order-flow/order-flow-client.ts";
import type { BacktestsGateway } from "./agent-ops-client.tsx";
import { ChartsWorkspace } from "./charts-workspace.tsx";
import type { FlowEventsGateway } from "./flow-events-client.ts";
import type { JevVerdictGateway } from "./jev-verdict-client.ts";
import type { MarketDataGateway } from "./market-data-client.ts";
import type { OptionsAnalyticsGateway } from "./options-analytics-client.ts";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
// jsdom has no scrollIntoView (so vi.spyOn cannot wrap it): install a mock and
// put the prototype back afterwards.
const scrollDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView"
);
const scrolled = vi.fn();
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrolled,
    writable: true,
  });
});
afterAll(() => {
  if (scrollDescriptor === undefined)
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  else
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      scrollDescriptor
    );
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  scrolled.mockClear();
  window.history.replaceState(null, "", "/");
  document.body.replaceChildren();
  chartProps.last = null;
});
const flush = async () => ({
  ...(await (async () => {
    const results = {};
    for (let i = 0; i < 30; i += 1)
      Object.assign(results, await Promise.resolve());
    return results;
  })()),
});
const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    return await flush();
  });
  return container;
};

const select = (label: string): HTMLSelectElement => {
  const element = document.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`
  );
  if (element === null) throw new Error(`Missing select ${label}`);
  return element;
};
const change = async (
  element: HTMLSelectElement | HTMLInputElement,
  value: string
) => {
  return await act(async () => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    );
    return await flush();
  });
};
const submit = async () => {
  const button = [...document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === "Open"
  );
  if (button === undefined) throw new Error("Missing Open");
  return await act(async () => {
    button.click();
    return await flush();
  });
};
const symbolInput = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Symbol"]'
  );
  if (input === null) throw new Error("Missing Symbol");
  return input;
};

const DAY = 86_400;
const t0 = Date.parse("2024-01-01T00:00:00Z") / 1000;
const output = (count = 5): MarketBarsOutput => ({
  asOf: "2024-01-05T00:00:00Z",
  bars: Array.from({ length: count }, (_, index) => ({
    c: 101 + index,
    h: 102 + index,
    l: 99 + index,
    o: 100 + index,
    t: t0 + index * DAY,
    v: index === 0 ? null : 1000,
  })),
  cache: { ageSeconds: 42, hit: true, stale: false, ttlSeconds: 300 },
  contract: {
    conId: 756_733,
    currency: "USD",
    exchange: "SMART",
    lastTradeDateOrContractMonth: null,
    localSymbol: "SPY",
    longName: "SPDR S&P 500 ETF TRUST",
    matches: 1,
    multiplier: null,
    secType: "STK",
    timeZoneId: "US/Eastern",
  },
  count,
  fetchedAt: "2024-01-06T01:00:00Z",
  receivedAt: "2024-01-06T01:00:01Z",
  request: {
    barSize: "1 day",
    contractMonth: null,
    currency: "USD",
    duration: "1 Y",
    exchange: "SMART",
    secType: "STK",
    symbol: "SPY",
    useRTH: true,
    whatToShow: "TRADES",
  },
  source: "ibkr-gateway",
});

const marketGateway = (
  implementation: (input: MarketBarsInput) => Promise<MarketBarsOutput>
) => {
  return { bars: vi.fn(implementation) } satisfies MarketDataGateway;
};

const backtestsGateway = (): BacktestsGateway => ({
  get: vi.fn(
    async () =>
      ({
        backtest: {
          id: "bt-1",
          trades: [
            {
              entry_px: 101.5,
              entry_t: "2024-01-02",
              exit_px: 103,
              exit_t: "2024-01-03",
              pnl: 1.5,
              qty: 1,
              side: "long",
            },
            {
              entry_px: 90,
              entry_t: "2023-06-01",
              exit_px: 89,
              exit_t: "2023-06-02",
              pnl: 1,
              qty: 1,
              side: "short",
            },
          ],
        },
        task: null,
      }) as unknown as BacktestGetOutput
  ),
  list: vi.fn(
    async () =>
      [
        {
          id: "bt-1",
          instruments: "SPY",
          periodEnd: "2024-01-05",
          periodStart: "2024-01-01",
          strategy: "jump-model v1",
        },
      ] as never
  ),
});

// The options panel stays in its loading state, so no test reaches the network.
const optionsGateway = () =>
  ({
    snapshot: vi.fn(() => new Promise<never>(() => undefined)),
  }) satisfies OptionsAnalyticsGateway;

const jevGateway = () =>
  ({
    get: vi.fn(() => new Promise<never>(() => undefined)),
    refresh: vi.fn(() => new Promise<never>(() => undefined)),
  }) satisfies JevVerdictGateway;

const pendingFlowEventsGateway = (): FlowEventsGateway => ({
  events: vi.fn(() => new Promise<never>(() => undefined)),
});

describe("ChartsWorkspace", () => {
  it("loads the SPY daily defaults and shows source, contract, timing, cache and bar count", async () => {
    const market = marketGateway(async () => output());
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    expect(market.bars).toHaveBeenCalledWith({
      barSize: "1 day",
      currency: "USD",
      duration: "1 Y",
      exchange: "SMART",
      secType: "STK",
      symbol: "SPY",
      useRTH: true,
      whatToShow: "TRADES",
    });
    const text = container.textContent ?? "";
    expect(text).toContain("IBKR Gateway");
    expect(text).toContain("SPDR S&P 500 ETF TRUST");
    expect(text).toContain("756733");
    expect(text).toContain("2024-01-05T00:00:00Z");
    expect(text).toContain("2024-01-06T01:00:00Z");
    expect(text).toContain("hit");
    expect(text).toContain("42 s");
    expect(container.querySelector("[data-bar-count]")?.textContent).toContain(
      "5"
    );
    expect(chartProps.last?.["candles"]).toHaveLength(5);
    // Signal chart defaults: MA on the price, MACD below, volume pane.
    expect(chartProps.last?.["studies"]).toEqual({
      ema: [],
      extra: ["macd"],
      panes: [],
      sma: [20, 50],
      volume: true,
    });
    expect(container.querySelector("h2")?.textContent).toBe("SPY · 1D");
    expect(container.querySelector('a[href="/stock/SPY"]')?.textContent).toBe(
      "Options chain"
    );
    const openMenu = async (label: string) =>
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(`[data-chart-menu="${label}"]`)
          ?.click()
      );
    const indicator = (label: string) =>
      [...container.querySelectorAll<HTMLInputElement>("fieldset input")].find(
        (input) => input.parentElement?.textContent === label
      );
    const click = async (input: HTMLInputElement | undefined) =>
      await act(async () => input?.click());
    await openMenu("Overlay");
    await click(indicator("Bollinger 20, 2"));
    await click(indicator("VWAP 1σ, 2σ"));
    await openMenu("Study");
    await click(indicator("RSI 14"));
    await click(indicator("MACD 12, 26, 9"));
    expect(chartProps.last?.["studies"]).toMatchObject({
      extra: ["boll", "vwap"],
      panes: ["RSI"],
    });
    const volume = [
      ...container.querySelectorAll<HTMLInputElement>("label input"),
    ].find((input) => input.parentElement?.textContent === "Volume");
    await click(volume);
    expect(chartProps.last?.["studies"]).toMatchObject({ volume: false });
    expect(container.querySelector("[data-return-stats]")).not.toBeNull();
    const settings = container.querySelector("[data-bar-settings]");
    expect(settings).not.toBeNull();
    expect(settings?.className).toContain("open:w-full");
    expect(settings?.querySelector("div")?.className).not.toContain("absolute");
    const weekdaySection = container.querySelector("[data-weekday-stats]");
    expect(weekdaySection).not.toBeNull();
    expect(weekdaySection?.className).toContain("min-w-0");
    return expect(container.querySelector("[data-hour-stats]")).toBeNull();
  });

  it("limits durations to the bar size and switches futures to an exchange", async () => {
    const market = marketGateway(async () => output());
    await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    await change(select("Bar size"), "1 min");
    expect(
      [...select("Duration").options].map((option) => option.value)
    ).toEqual(["1 D", "2 D"]);
    expect(select("Duration").value).toBe("2 D");
    await change(select("Security type"), "FUT");
    const exchange = document.querySelector<HTMLInputElement>(
      'input[aria-label="Exchange"]'
    )!;
    expect(exchange.value).toBe("CME");
    await change(
      document.querySelector<HTMLInputElement>('input[aria-label="Symbol"]')!,
      "es"
    );
    await submit();
    return expect(market.bars).toHaveBeenLastCalledWith({
      barSize: "1 min",
      currency: "USD",
      duration: "2 D",
      exchange: "CME",
      secType: "FUT",
      symbol: "ES",
      useRTH: true,
      whatToShow: "TRADES",
    });
  });

  it("offers stock and futures sec types, exchange presets and quick picks", async () => {
    const base = output();
    const market = marketGateway(async (input) => ({
      ...base,
      request: {
        ...base.request,
        currency: input.currency ?? "USD",
        exchange: input.exchange ?? "SMART",
        secType: input.secType ?? "STK",
        symbol: input.symbol,
      },
    }));
    await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    const exchange = () =>
      document.querySelector<HTMLInputElement>('input[aria-label="Exchange"]')!;
    expect(
      [...select("Security type").options].map((option) => option.value)
    ).toEqual(["STK", "FUT", "CONTFUT"]);
    expect([...select("Data").options].map((option) => option.value)).toEqual([
      "TRADES",
      "MIDPOINT",
    ]);
    await change(select("Data"), "MIDPOINT");
    // A custom venue survives a sec type switch; presets follow it.
    await change(exchange(), "ARCA");
    await change(select("Security type"), "FUT");
    expect(exchange().value).toBe("ARCA");
    await change(select("Security type"), "STK");
    expect(exchange().value).toBe("ARCA");
    await change(exchange(), "CME");
    await change(select("Security type"), "STK");
    expect(exchange().value).toBe("SMART");
    expect(select("Data").value).toBe("MIDPOINT");

    expect(
      [...select("Quick pick").options].slice(1).map((option) => option.value)
    ).toEqual(["ES (E-mini S&P)", "NQ (E-mini Nasdaq)", "SPY", "QQQ"]);
    await change(select("Quick pick"), "ES (E-mini S&P)");
    expect(select("Quick pick").value).toBe("");
    await submit();
    expect(market.bars).toHaveBeenLastCalledWith(
      expect.objectContaining({
        exchange: "CME",
        secType: "CONTFUT",
        symbol: "ES",
        whatToShow: "MIDPOINT",
      })
    );
    // An unknown pick changes nothing.
    await change(select("Quick pick"), "BTC");
    expect(symbolInput().value).toBe("ES");
  });

  it("mounts the options and JEV panels only for USD stock charts", async () => {
    const usd = optionsGateway();
    const usdJev = jevGateway();
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={usdJev}
        marketData={marketGateway(async () => output())}
        optionsAnalytics={usd}
      />
    );
    expect(
      container.querySelector('[data-options-analytics="SPY"]')
    ).not.toBeNull();
    expect(usd.snapshot).toHaveBeenCalledWith({ flowHours: 24, symbol: "SPY" });
    expect(container.querySelector('[data-jev-verdict="SPY"]')).not.toBeNull();
    expect(usdJev.get).toHaveBeenCalledWith({ symbol: "SPY" });
    expect(usdJev.refresh).not.toHaveBeenCalled();

    const eur = optionsGateway();
    const eurJev = jevGateway();
    const base = output();
    const sap = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={eurJev}
        marketData={marketGateway(async () => ({
          ...base,
          request: { ...base.request, currency: "EUR", exchange: "IBIS" },
        }))}
        optionsAnalytics={eur}
      />
    );
    expect(sap.querySelector("[data-options-analytics]")).toBeNull();
    expect(sap.querySelector("[data-jev-verdict]")).toBeNull();
    expect(eurJev.get).not.toHaveBeenCalled();
    return expect(eur.snapshot).not.toHaveBeenCalled();
  });

  it("mounts the lazy order flow panel after Return analysis, futures included", async () => {
    const orderFlow = {
      depth: vi.fn(() => new Promise<never>(() => undefined)),
      // Settles at once: the panel asks for the TPO bars only after the trade prints settle.
      ticks: vi.fn(() => Promise.reject(new Error("ticks off in this test"))),
    } satisfies OrderFlowGateway;
    const base = output();
    const market = marketGateway(async (input) =>
      input.barSize === "30 mins"
        ? new Promise<never>(() => undefined)
        : {
            ...base,
            request: {
              ...base.request,
              contractMonth: "202612",
              exchange: "CME",
              secType: "FUT",
              symbol: "ES",
            },
          }
    );
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
        orderFlow={orderFlow}
      />
    );
    const panel = container.querySelector('[data-order-flow="ES"]');
    expect(panel).not.toBeNull();
    expect(panel?.querySelector("h2")?.textContent).toBe("Order flow");
    expect(
      container.querySelector("[data-return-analysis]")?.nextElementSibling
    ).toBe(panel);
    // Lazy: the chart load does not fetch order flow.
    expect(orderFlow.ticks).not.toHaveBeenCalled();
    expect(market.bars).toHaveBeenCalledTimes(1);
    const load = [...(panel?.querySelectorAll("button") ?? [])].find(
      (node) => node.textContent === "Load order flow"
    );
    await act(async () => {
      load?.click();
      return await flush();
    });
    const instrument = {
      contractMonth: "202612",
      currency: "USD",
      exchange: "CME",
      secType: "FUT",
      symbol: "ES",
    };
    expect(orderFlow.ticks).toHaveBeenCalledWith({
      ...instrument,
      count: 500,
      quotes: true,
      useRTH: false,
    });
    expect(orderFlow.depth).toHaveBeenCalledWith({ ...instrument, rows: 10 });
    return expect(market.bars).toHaveBeenLastCalledWith({
      ...instrument,
      barSize: "30 mins",
      duration: "5 D",
      useRTH: true,
      whatToShow: "TRADES",
    });
  });

  it("shows the oRPC error code and message", async () => {
    const market = marketGateway(async () => {
      throw Object.assign(new Error("IBKR pacing: retry in 12 s"), {
        code: "PACED",
      });
    });
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    const alert = container.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("PACED");
    return expect(alert?.textContent).toContain("IBKR pacing: retry in 12 s");
  });

  it("names a missing as-of time and the fetch time instead of a dash", async () => {
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        jevVerdict={jevGateway()}
        marketData={marketGateway(async () => ({ ...output(), asOf: null }))}
        optionsAnalytics={optionsGateway()}
      />
    );
    const asOf = container.querySelector("[data-as-of]");
    expect(asOf?.textContent).toBe("not reported by source");
    return expect(asOf?.getAttribute("title")).toBe(
      "IBKR Gateway sent no as-of time; fetched 2024-01-06 01:00 UTC"
    );
  });

  it.each([
    ["yesterday 14:00", "yesterday 14:00"],
    ["", "time not reported by source"],
  ])(
    "shows a fetch time %j that is not an ISO time as sent",
    async (fetchedAt, shown) => {
      const container = await mount(
        <ChartsWorkspace
          backtests={backtestsGateway()}
          jevVerdict={jevGateway()}
          marketData={marketGateway(async () => ({
            ...output(),
            asOf: null,
            fetchedAt,
          }))}
          optionsAnalytics={optionsGateway()}
        />
      );
      return expect(
        container.querySelector("[data-as-of]")?.getAttribute("title")
      ).toBe(`IBKR Gateway sent no as-of time; fetched ${shown}`);
    }
  );

  it("reports truncation to the renderer cap", async () => {
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={marketGateway(async () => output(4100))}
        optionsAnalytics={optionsGateway()}
      />
    );
    expect(chartProps.last?.["candles"]).toHaveLength(4096);
    return expect(container.textContent).toContain("last 4096 of 4100");
  });

  return it("overlays a selected backtest's trades and counts markers outside the range", async () => {
    const backtests = backtestsGateway();
    const container = await mount(
      <ChartsWorkspace
        backtests={backtests}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={marketGateway(async () => output())}
        optionsAnalytics={optionsGateway()}
      />
    );
    await change(select("Backtest trades"), "bt-1");
    expect(backtests.get).toHaveBeenCalledWith("bt-1");
    expect(chartProps.last?.["markers"]).toHaveLength(2);
    expect(
      container.querySelector("[data-marker-summary]")?.textContent
    ).toContain("2 shown");
    expect(
      container.querySelector("[data-marker-summary]")?.textContent
    ).toContain("2 outside");
    await change(select("Backtest trades"), "");
    return expect(chartProps.last?.["markers"]).toEqual([]);
  });
});

describe("ChartsWorkspace ?symbol= deep link", () => {
  it("loads the linked ticker and follows back/forward", async () => {
    window.history.replaceState(null, "", "/charts?symbol=nvda");
    const market = marketGateway(async () => output());
    await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    expect(market.bars).toHaveBeenLastCalledWith(
      expect.objectContaining({ secType: "STK", symbol: "NVDA" })
    );
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Symbol"]')
        ?.value
    ).toBe("NVDA");
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled).toHaveBeenCalledWith({ block: "start" });
    expect(scrolled.mock.contexts[0]).toBe(
      document.querySelector("[data-chart-results]")
    );

    window.history.pushState(null, "", "/charts?symbol=AAPL");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
      return await flush();
    });
    expect(market.bars).toHaveBeenLastCalledWith(
      expect.objectContaining({ symbol: "AAPL" })
    );
  });

  it("writes the submitted symbol to the URL once", async () => {
    window.history.replaceState(null, "", "/charts?symbol=SPY&x=1");
    const market = marketGateway(async () => output());
    await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    const length = window.history.length;
    await submit();
    expect(window.history.length).toBe(length);
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Symbol"]'
    );
    if (input === null) throw new Error("Missing Symbol");
    await change(input, "brk.b");
    await submit();
    expect(window.location.search).toBe("?symbol=BRK.B&x=1");
  });

  it("shows a clear message for an invalid ticker and loads the default", async () => {
    window.history.replaceState(null, "", "/charts?symbol=%3Cscript%3E");
    const market = marketGateway(async () => output());
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    expect(container.querySelector("[data-link-error]")?.textContent).toBe(
      '"<script>" is not a valid ticker. Showing SPY.'
    );
    expect(scrolled).not.toHaveBeenCalled();
    expect(market.bars).toHaveBeenLastCalledWith(
      expect.objectContaining({ symbol: "SPY" })
    );
  });

  it("ignores back/forward to another route", async () => {
    window.history.replaceState(null, "", "/charts?symbol=NVDA");
    const market = marketGateway(async () => output());
    await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    const calls = market.bars.mock.calls.length;
    window.history.pushState(null, "", "/elsewhere?symbol=AAPL");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
      return await flush();
    });
    expect(market.bars).toHaveBeenCalledTimes(calls);
    expect(symbolInput().value).toBe("NVDA");
  });

  it("adds no URL entry for futures or tickers the server would reject", async () => {
    window.history.replaceState(null, "", "/charts?symbol=SPY");
    const market = marketGateway(async () => output());
    await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    const length = window.history.length;
    await change(symbolInput(), "bf-b");
    await submit();
    expect(market.bars).toHaveBeenLastCalledWith(
      expect.objectContaining({ secType: "STK", symbol: "BF-B" })
    );
    await change(select("Security type"), "FUT");
    await change(symbolInput(), "es");
    await submit();
    expect(market.bars).toHaveBeenLastCalledWith(
      expect.objectContaining({ secType: "FUT", symbol: "ES" })
    );
    expect(window.history.length).toBe(length);
    expect(window.location.search).toBe("?symbol=SPY");
  });

  it("cancels the pending scroll when the linked load fails", async () => {
    window.history.replaceState(null, "", "/charts?symbol=NVDA");
    const market = marketGateway(async (input) => {
      if (input.symbol === "NVDA") throw new Error("offline");
      return output();
    });
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    expect(container.querySelector("[data-link-error]")).toBeNull();
    await change(symbolInput(), "spy");
    await submit();
    expect(market.bars).toHaveBeenLastCalledWith(
      expect.objectContaining({ symbol: "SPY" })
    );
    expect(scrolled).not.toHaveBeenCalled();
  });

  it("cancels the pending scroll on a manual submit", async () => {
    window.history.replaceState(null, "", "/charts?symbol=NVDA");
    // The web tsconfig lib predates Promise.withResolvers.
    let release: (value: MarketBarsOutput) => void = () => undefined;
    const linked = new Promise<MarketBarsOutput>((resolve) => {
      release = resolve;
    });
    const market = marketGateway(async (input) =>
      input.symbol === "NVDA" ? await linked : output()
    );
    await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    // The button is disabled while loading; submit the form itself.
    await act(async () => {
      document
        .querySelector('form[aria-label="Bar request"]')
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
      return await flush();
    });
    await act(async () => {
      release(output());
      return await flush();
    });
    expect(market.bars).toHaveBeenCalledTimes(2);
    expect(scrolled).not.toHaveBeenCalled();
  });
});

describe("ChartsWorkspace intervals", () => {
  const intervalButton = (label: string): HTMLButtonElement => {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>(
        "[data-chart-toolbar] button"
      ),
    ].find((node) => node.textContent === label);
    if (button === undefined) throw new Error(`Missing interval ${label}`);
    return button;
  };
  const press = async (button: HTMLButtonElement) =>
    await act(async () => {
      button.click();
      return await flush();
    });

  it("loads ?interval= and merges daily bars into weekly candles", async () => {
    window.history.replaceState(null, "", "/charts?symbol=SPY&interval=1W");
    const market = marketGateway(async () => output(10));
    await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    expect(market.bars).toHaveBeenLastCalledWith(
      expect.objectContaining({ barSize: "1 day", duration: "1 Y" })
    );
    // 2024-01-01 is a Monday: ten daily bars make two weeks.
    expect(chartProps.last?.["candles"]).toHaveLength(2);
    expect(intervalButton("1W").getAttribute("aria-pressed")).toBe("true");
  });

  it("switches the interval from the toolbar and keeps it in the URL", async () => {
    window.history.replaceState(null, "", "/charts?symbol=SPY");
    const market = marketGateway(async () => output());
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    await press(intervalButton("1h"));
    expect(market.bars).toHaveBeenLastCalledWith(
      expect.objectContaining({ barSize: "1 hour", duration: "1 M" })
    );
    expect(window.location.search).toBe("?symbol=SPY&interval=1h");
    expect(container.querySelector("h2")?.textContent).toBe("SPY · 1h");
    await press(intervalButton("1D"));
    expect(window.location.search).toBe("?symbol=SPY");
  });

  it("names a custom bar request and keeps 1W on a plain submit", async () => {
    const market = marketGateway(async () => output());
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    await change(select("Duration"), "6 M");
    await submit();
    expect(market.bars).toHaveBeenLastCalledWith(
      expect.objectContaining({ duration: "6 M" })
    );
    expect(container.querySelector("h2")?.textContent).toBe("SPY · 1 day");
    // Custom settings match no interval button, so none shows as pressed.
    expect(
      document.querySelectorAll(
        '[data-chart-toolbar] button[aria-pressed="true"]'
      )
    ).toHaveLength(0);
    expect(window.location.search).toBe("?symbol=SPY");
    await press(intervalButton("1W"));
    await submit();
    expect(container.querySelector("h2")?.textContent).toBe("SPY · 1W");
    expect(window.location.search).toBe("?symbol=SPY&interval=1W");
  });

  it("places trade markers over a whole merged week", async () => {
    window.history.replaceState(null, "", "/charts?symbol=SPY&interval=1W");
    const backtests: BacktestsGateway = {
      ...backtestsGateway(),
      get: vi.fn(
        async () =>
          ({
            backtest: {
              id: "bt-1",
              trades: [
                {
                  entry_px: 108,
                  entry_t: "2024-01-09",
                  exit_px: 109,
                  exit_t: "2024-01-10",
                  pnl: 1,
                  qty: 1,
                  side: "long",
                },
              ],
            },
            task: null,
          }) as unknown as BacktestGetOutput
      ),
    };
    const container = await mount(
      <ChartsWorkspace
        backtests={backtests}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={marketGateway(async () => output(10))}
        optionsAnalytics={optionsGateway()}
      />
    );
    await change(select("Backtest trades"), "bt-1");
    // Both fills fall in the week that starts 2024-01-08 (the last weekly candle).
    expect(
      container.querySelector("[data-marker-summary]")?.textContent
    ).toContain("2 shown · 0 outside");
  });
});

describe("ChartsWorkspace order-flow marks", () => {
  it("loads stored flow_events onto the price chart, combines with trade markers, and toggles off/on", async () => {
    const flowEvents: FlowEventsGateway = {
      events: vi.fn(async () => ({
        events: [
          {
            at: "2024-01-02T15:00:00.000Z",
            detail: "1 stacked buy imbalance (≥3:1 on ≥3 levels)",
            direction: "bullish" as const,
            kind: "stacked_imbalance" as const,
            premium: null,
            price: 101.2,
            size: null,
          },
          {
            at: "2024-01-03T15:00:00.000Z",
            detail: "Buying absorbed: delta +500 of 900",
            direction: "bearish" as const,
            kind: "absorption" as const,
            premium: null,
            price: 103.8,
            size: 900,
          },
        ],
        from: "2024-01-01T00:00:00.000Z",
        schemaVersion: "flow-events.v1" as const,
        symbol: "SPY" as const,
        to: "2024-01-06T00:00:00.000Z",
        truncated: false,
      })),
    };
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={flowEvents}
        jevVerdict={jevGateway()}
        marketData={marketGateway(async () => output())}
        optionsAnalytics={optionsGateway()}
      />
    );
    expect(flowEvents.events).toHaveBeenCalledWith(
      expect.objectContaining({
        kinds: ["stacked_imbalance", "absorption"],
        symbol: "SPY",
      })
    );
    expect(
      container.querySelector("[data-flow-marks-summary]")?.textContent
    ).toContain("▲ SI buy: 1");
    expect(
      container.querySelector("[data-flow-marks-summary]")?.textContent
    ).toContain("◆ ABS bearish: 1");
    const markers = chartProps.last?.["markers"] as {
      text: string;
      shape?: string;
      tone?: string;
    }[];
    expect(markers).toEqual([
      expect.objectContaining({ shape: "arrow", text: "SI", tone: "bullish" }),
      expect.objectContaining({
        shape: "diamond",
        text: "ABS",
        tone: "bearish",
      }),
    ]);

    const toggle = container.querySelector<HTMLInputElement>(
      "[data-flow-marks-toggle]"
    );
    expect(toggle?.checked).toBe(true);
    await act(async () => {
      toggle?.click();
      await flush();
    });
    expect(container.querySelector("[data-flow-marks-summary]")).toBeNull();
    expect(chartProps.last?.["markers"]).toEqual([]);
  });

  it("reports unsupported symbols without calling flow.events and handles forbidden/error responses", async () => {
    const flowEvents: FlowEventsGateway = {
      events: vi.fn(async () => {
        throw Object.assign(new Error("Operator access required"), {
          code: "FORBIDDEN",
          status: 403,
        });
      }),
    };
    const nvda = output();
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={flowEvents}
        jevVerdict={jevGateway()}
        marketData={marketGateway(async (input) => ({
          ...nvda,
          contract: { ...nvda.contract, localSymbol: input.symbol },
          request: { ...nvda.request, symbol: input.symbol },
        }))}
        optionsAnalytics={optionsGateway()}
      />
    );
    expect(
      container.querySelector('[data-flow-marks-status="forbidden"]')
    ).not.toBeNull();

    await change(symbolInput(), "NVDA");
    await submit();
    expect(
      container.querySelector('[data-flow-marks-status="unsupported"]')
        ?.textContent
    ).toContain("NVDA");
    // Called only for SPY, never for NVDA.
    expect(flowEvents.events).toHaveBeenCalledTimes(1);

    const failingGateway: FlowEventsGateway = {
      events: vi.fn(async () => {
        throw new Error("flow db down");
      }),
    };
    const host = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={failingGateway}
        jevVerdict={jevGateway()}
        marketData={marketGateway(async () => output())}
        optionsAnalytics={optionsGateway()}
      />
    );
    expect(
      host.querySelector('[data-flow-marks-status="error"]')?.textContent
    ).toContain("Request failed. Retry.");
  });

  it("does not overlay futures flow_events when ES is loaded as an equity (STK)", async () => {
    const flowEventsGateway: FlowEventsGateway = {
      events: vi.fn(async () => ({
        events: [],
        from: "2024-01-01T00:00:00.000Z",
        schemaVersion: "flow-events.v1" as const,
        symbol: "ES" as const,
        to: "2024-01-06T00:00:00.000Z",
        truncated: false,
      })),
    };
    const base = output();
    const esStock: MarketBarsOutput = {
      ...base,
      contract: { ...base.contract, localSymbol: "ES", secType: "STK" },
      request: { ...base.request, secType: "STK", symbol: "ES" },
    };
    const host = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={flowEventsGateway}
        jevVerdict={jevGateway()}
        marketData={marketGateway(async () => esStock)}
        optionsAnalytics={optionsGateway()}
      />
    );
    expect(flowEventsGateway.events).not.toHaveBeenCalled();
    expect(
      host.querySelector('[data-flow-marks-status="unsupported"]')?.textContent
    ).toContain("ES STK");
  });

  it("ignores stale out-of-order flow.events responses after switching symbols", async () => {
    let resolveSpy!: (value: FlowEventsOutput) => void;
    const flowEventsGateway: FlowEventsGateway = {
      events: vi.fn((input): Promise<FlowEventsOutput> => {
        if (input.symbol === "SPY") {
          return new Promise<FlowEventsOutput>((resolve) => {
            resolveSpy = resolve;
          });
        }
        return Promise.resolve({
          events: [
            {
              at: "2024-01-03T15:00:00.000Z",
              detail: "QQQ stacked sell imbalance",
              direction: "bearish" as const,
              kind: "stacked_imbalance" as const,
              premium: null,
              price: 400,
              size: null,
            },
          ],
          from: input.from,
          schemaVersion: "flow-events.v1" as const,
          symbol: "QQQ" as const,
          to: input.to,
          truncated: false,
        });
      }),
    };
    const market = marketGateway(async (input) => {
      const base = output();
      return {
        ...base,
        contract: { ...base.contract, localSymbol: input.symbol },
        request: { ...base.request, symbol: input.symbol },
      };
    });
    const host = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={flowEventsGateway}
        jevVerdict={jevGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
      />
    );
    expect(
      host.querySelector('[data-flow-marks-status="loading"]')
    ).not.toBeNull();
    await change(symbolInput(), "QQQ");
    await submit();
    expect(
      host.querySelector("[data-flow-marks-summary]")?.textContent
    ).toContain("▼ SI sell: 1");

    // Resolve the older SPY request after QQQ already settled; QQQ summary must stay intact.
    await act(async () => {
      resolveSpy({
        events: [
          {
            at: "2024-01-02T15:00:00.000Z",
            detail: "Stale SPY stacked buy",
            direction: "bullish",
            kind: "stacked_imbalance",
            premium: null,
            price: 590,
            size: null,
          },
        ],
        from: "2024-01-01T00:00:00.000Z",
        schemaVersion: "flow-events.v1",
        symbol: "SPY",
        to: "2024-01-06T00:00:00.000Z",
        truncated: false,
      });
      await flush();
    });
    const summaryText =
      host.querySelector("[data-flow-marks-summary]")?.textContent ?? "";
    expect(summaryText).toContain("▼ SI sell: 1");
    expect(summaryText).toContain("▲ SI buy: 0");
  });

  it("mounts IvRankHistoryPanel with the supplied openbb gateway for USD stocks", async () => {
    window.history.replaceState(null, "", "/charts?symbol=SPY");
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
    const market = marketGateway(async () => output());
    const host = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        flowEvents={pendingFlowEventsGateway()}
        jevVerdict={jevGateway()}
        marketData={market}
        openbb={{ ivHistory }}
        optionsAnalytics={optionsGateway()}
      />
    );
    expect(ivHistory).toHaveBeenCalledWith("SPY", 252);
    expect(host.querySelector('[data-iv-history="SPY"]')).not.toBeNull();
  });
});
