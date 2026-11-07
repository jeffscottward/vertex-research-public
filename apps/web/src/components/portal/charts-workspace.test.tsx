// @vitest-environment jsdom
import type {
  BacktestGetOutput,
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
import type { MarketDataGateway } from "./market-data-client.ts";
import type { JevVerdictGateway } from "./jev-verdict-client.ts";
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
  source: "ibkr-gateway",
  request: {
    symbol: "SPY",
    secType: "STK",
    exchange: "SMART",
    currency: "USD",
    barSize: "1 day",
    duration: "1 Y",
    whatToShow: "TRADES",
    useRTH: true,
    contractMonth: null,
  },
  contract: {
    conId: 756_733,
    secType: "STK",
    localSymbol: "SPY",
    exchange: "SMART",
    currency: "USD",
    lastTradeDateOrContractMonth: null,
    multiplier: null,
    longName: "SPDR S&P 500 ETF TRUST",
    timeZoneId: "US/Eastern",
    matches: 1,
  },
  bars: Array.from({ length: count }, (_, index) => ({
    t: t0 + index * DAY,
    o: 100 + index,
    h: 102 + index,
    l: 99 + index,
    c: 101 + index,
    v: index === 0 ? null : 1000,
  })),
  count,
  fetchedAt: "2024-01-06T01:00:00Z",
  asOf: "2024-01-05T00:00:00Z",
  cache: { hit: true, ageSeconds: 42, ttlSeconds: 300, stale: false },
  receivedAt: "2024-01-06T01:00:01Z",
});

const marketGateway = (
  implementation: (input: MarketBarsInput) => Promise<MarketBarsOutput>
) => {
  return { bars: vi.fn(implementation) } satisfies MarketDataGateway;
};

const backtestsGateway = (): BacktestsGateway => ({
  list: vi.fn(
    async () =>
      [
        {
          id: "bt-1",
          strategy: "jump-model v1",
          instruments: "SPY",
          periodStart: "2024-01-01",
          periodEnd: "2024-01-05",
        },
      ] as never
  ),
  get: vi.fn(
    async () =>
      ({
        backtest: {
          id: "bt-1",
          trades: [
            {
              entry_t: "2024-01-02",
              exit_t: "2024-01-03",
              side: "long",
              qty: 1,
              entry_px: 101.5,
              exit_px: 103,
              pnl: 1.5,
            },
            {
              entry_t: "2023-06-01",
              exit_t: "2023-06-02",
              side: "short",
              qty: 1,
              entry_px: 90,
              exit_px: 89,
              pnl: 1,
            },
          ],
        },
        task: null,
      }) as unknown as BacktestGetOutput
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

describe("ChartsWorkspace", () => {
  it("loads the SPY daily defaults and shows source, contract, timing, cache and bar count", async () => {
    const market = marketGateway(async () => output());
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
      />
    );
    expect(market.bars).toHaveBeenCalledWith({
      symbol: "SPY",
      secType: "STK",
      exchange: "SMART",
      currency: "USD",
      barSize: "1 day",
      duration: "1 Y",
      whatToShow: "TRADES",
      useRTH: true,
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
      volume: true,
      sma: [20, 50],
      ema: [],
      extra: ["macd"],
      panes: [],
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
    await openMenu("Study");
    await click(indicator("RSI 14"));
    await click(indicator("MACD 12, 26, 9"));
    expect(chartProps.last?.["studies"]).toMatchObject({
      extra: ["boll"],
      panes: ["RSI"],
    });
    const volume = [
      ...container.querySelectorAll<HTMLInputElement>("label input"),
    ].find((input) => input.parentElement?.textContent === "Volume");
    await click(volume);
    expect(chartProps.last?.["studies"]).toMatchObject({ volume: false });
    expect(container.querySelector("[data-return-stats]")).not.toBeNull();
    expect(container.querySelector("[data-weekday-stats]")).not.toBeNull();
    return expect(container.querySelector("[data-hour-stats]")).toBeNull();
  });

  it("limits durations to the bar size and switches futures to an exchange", async () => {
    const market = marketGateway(async () => output());
    await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
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
      symbol: "ES",
      secType: "FUT",
      exchange: "CME",
      currency: "USD",
      barSize: "1 min",
      duration: "2 D",
      whatToShow: "TRADES",
      useRTH: true,
    });
  });

  it("offers stock and futures sec types, exchange presets and quick picks", async () => {
    const base = output();
    const market = marketGateway(async (input) => ({
      ...base,
      request: {
        ...base.request,
        symbol: input.symbol,
        secType: input.secType ?? "STK",
        exchange: input.exchange ?? "SMART",
        currency: input.currency ?? "USD",
      },
    }));
    await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        marketData={market}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
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
        symbol: "ES",
        secType: "CONTFUT",
        exchange: "CME",
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
        marketData={marketGateway(async () => output())}
        optionsAnalytics={usd}
        jevVerdict={usdJev}
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
        marketData={marketGateway(async () => ({
          ...base,
          request: { ...base.request, currency: "EUR", exchange: "IBIS" },
        }))}
        optionsAnalytics={eur}
        jevVerdict={eurJev}
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
        marketData={market}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
      />
    );
    const alert = container.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("PACED");
    return expect(alert?.textContent).toContain("IBKR pacing: retry in 12 s");
  });

  it("reports truncation to the renderer cap", async () => {
    const container = await mount(
      <ChartsWorkspace
        backtests={backtestsGateway()}
        marketData={marketGateway(async () => output(4100))}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
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
        marketData={marketGateway(async () => output())}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
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
        marketData={market}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
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
        marketData={market}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
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
        marketData={market}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
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
        marketData={market}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
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
        marketData={market}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
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
        marketData={market}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
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
        marketData={market}
        optionsAnalytics={optionsGateway()}
        jevVerdict={jevGateway()}
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
        marketData={market}
        jevVerdict={jevGateway()}
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
        marketData={market}
        jevVerdict={jevGateway()}
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
        marketData={market}
        jevVerdict={jevGateway()}
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
                  entry_t: "2024-01-09",
                  exit_t: "2024-01-10",
                  side: "long",
                  qty: 1,
                  entry_px: 108,
                  exit_px: 109,
                  pnl: 1,
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
        marketData={marketGateway(async () => output(10))}
        jevVerdict={jevGateway()}
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
