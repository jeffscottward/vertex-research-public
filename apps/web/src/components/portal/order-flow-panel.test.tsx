// @vitest-environment jsdom
import type {
  MarketBarsInput,
  MarketBarsOutput,
  MarketDepthInput,
  MarketDepthOutput,
  MarketTicksInput,
  MarketTicksOutput,
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

import type { OrderFlowGateway } from "../../features/order-flow/order-flow-client.ts";
import type { MarketDataGateway } from "./market-data-client.ts";
import {
  type OrderFlowInstrument,
  OrderFlowPanel,
} from "./order-flow-panel.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
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
const click = async (element: Element | null | undefined) => {
  if (!(element instanceof HTMLElement)) throw new Error("Missing element");
  await act(async () => {
    element.click();
    await flush();
  });
};
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text
  );
const tab = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-order-flow-tab="${name}"]`);
const view = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[role=tabpanel]");

const t0 = Date.parse("2026-10-30T18:02:11Z") / 1000;
const contract = {
  conId: 1,
  currency: "USD",
  exchange: "SMART",
  lastTradeDateOrContractMonth: null,
  localSymbol: "SPY",
  longName: "Test listing",
  matches: 1,
  multiplier: null,
  secType: "STK",
  timeZoneId: "US/Eastern",
} as const;
const cache = { ageSeconds: 5, hit: true, stale: true, ttlSeconds: 30 };
const request = {
  contractMonth: null,
  currency: "USD",
  exchange: "SMART",
  secType: "STK",
  symbol: "SPY",
} as const;

const ticksOutput = (): MarketTicksOutput => ({
  asOf: new Date((t0 + 89) * 1000).toISOString(),
  cache,
  contract,
  fetchedAt: "2026-10-30T18:04:00Z",
  minTick: 0.01,
  // within 5 s of each print they sign (an older quote falls back to the tick rule)
  quotes: [
    { ap: 100.02, as: 3, bp: 100, bs: 4, t: t0 + 1 },
    { ap: 100.02, as: 3, bp: 100, bs: 4, t: t0 + 28 },
    { ap: 100.02, as: 3, bp: 100, bs: 4, t: t0 + 58 },
    { ap: 100.02, as: 3, bp: 100, bs: 4, t: t0 + 87 },
  ],
  receivedAt: "2026-10-30T18:04:01Z",
  request: { ...request, count: 500, quotes: true, useRTH: false },
  source: "ibkr-gateway",
  trades: [
    { c: null, p: 100.01, s: 100, t: t0, x: "ARCA" },
    { c: null, p: 100.02, s: 200, t: t0 + 30, x: "ARCA" },
    { c: null, p: 100, s: 300, t: t0 + 60, x: "NSDQ" },
    { c: "I", p: 100.01, s: 50, t: t0 + 89, x: "NSDQ" },
  ],
});

const depthOutput = (): MarketDepthOutput => ({
  asks: [
    { price: 100.02, size: 3, venue: "ARCA" },
    { price: 100.03, size: 5, venue: "NSDQ" },
  ],
  bids: [{ price: 100, size: 4, venue: "BATS" }],
  cache: { ...cache, stale: false },
  contract,
  fetchedAt: "2026-10-30T18:04:00Z",
  minTick: 0.01,
  receivedAt: "2026-10-30T18:04:01Z",
  request: { ...request, rows: 10, smartDepth: true },
  sizeMultiplier: 100,
  source: "ibkr-gateway",
  updates: 12,
  venues: { depth: ["ARCA", "NSDQ"], missing: ["IEX"], top: ["BATS"] },
});

const barsOutput = (): MarketBarsOutput => {
  const open = Date.parse("2026-10-30T13:30:00Z") / 1000;
  return {
    asOf: null,
    bars: [
      { c: 101, h: 102, l: 100, o: 100, t: open, v: 1 },
      { c: 103, h: 104, l: 101, o: 101, t: open + 1800, v: 1 },
      { c: 102, h: 103, l: 102, o: 103, t: open + 3600, v: 1 },
    ],
    cache: { ...cache, stale: false },
    contract,
    count: 3,
    fetchedAt: "2026-10-30T18:04:00Z",
    receivedAt: "2026-10-30T18:04:01Z",
    request: {
      ...request,
      barSize: "30 mins",
      duration: "5 D",
      useRTH: true,
      whatToShow: "TRADES",
    },
    source: "ibkr-gateway",
  };
};

const failure = (code: string) =>
  Object.assign(new Error(`${code} from service`), { code });

const gateways = (
  overrides: Partial<{
    ticks: (input: MarketTicksInput) => Promise<MarketTicksOutput>;
    depth: (input: MarketDepthInput) => Promise<MarketDepthOutput>;
    bars: (input: MarketBarsInput) => Promise<MarketBarsOutput>;
  }> = {}
) => {
  const orderFlow = {
    depth: vi.fn(overrides.depth ?? (async () => depthOutput())),
    ticks: vi.fn(overrides.ticks ?? (async () => ticksOutput())),
  } satisfies OrderFlowGateway;
  const marketData = {
    bars: vi.fn(overrides.bars ?? (async () => barsOutput())),
  } satisfies MarketDataGateway;
  return { marketData, orderFlow };
};

const STK: OrderFlowInstrument = {
  contractMonth: null,
  currency: "USD",
  exchange: "SMART",
  secType: "STK",
  symbol: "SPY",
};

const render = (
  gates: Readonly<{
    orderFlow: OrderFlowGateway;
    marketData: MarketDataGateway;
  }>,
  instrument: OrderFlowInstrument = STK
) =>
  mount(
    <OrderFlowPanel
      gateway={gates.orderFlow}
      instrument={instrument}
      marketData={gates.marketData}
      timeZoneId="US/Eastern"
    />
  );

describe("OrderFlowPanel", () => {
  it("fetches nothing until Load order flow is pressed", async () => {
    const gates = gateways();
    const container = await render(gates);
    expect(container.querySelector("h2")?.textContent).toBe("Order flow");
    expect(container.textContent).toContain(
      "Nothing is fetched until you load"
    );
    expect(container.querySelector("[role=tablist]")).toBeNull();
    expect(gates.orderFlow.ticks).not.toHaveBeenCalled();
    expect(gates.orderFlow.depth).not.toHaveBeenCalled();
    expect(gates.marketData.bars).not.toHaveBeenCalled();

    await click(button(container, "Load order flow"));
    expect(gates.orderFlow.ticks).toHaveBeenCalledWith({
      count: 500,
      currency: "USD",
      exchange: "SMART",
      quotes: true,
      secType: "STK",
      symbol: "SPY",
      useRTH: false,
    });
    expect(gates.orderFlow.depth).toHaveBeenCalledWith({
      currency: "USD",
      exchange: "SMART",
      rows: 10,
      secType: "STK",
      symbol: "SPY",
    });
    expect(gates.marketData.bars).toHaveBeenCalledWith({
      barSize: "30 mins",
      currency: "USD",
      duration: "5 D",
      exchange: "SMART",
      secType: "STK",
      symbol: "SPY",
      useRTH: true,
      whatToShow: "TRADES",
    });
    const labels = [...container.querySelectorAll("[role=tab]")].map(
      (node) => node.textContent
    );
    expect(labels).toEqual([
      "Time & Sales",
      "Order book",
      "Footprint",
      "Delta / CVD",
      "TPO",
    ]);
  });

  it("shows the tape with coverage, signing methods, source and the stale cache mark", async () => {
    const container = await render(gateways());
    await click(button(container, "Load order flow"));
    const text = view(container)?.textContent ?? "";
    expect(text).toContain("4 trades, 14:02:11-14:03:40 ET");
    expect(text).toContain("IBKR Gateway · fetched 2026-10-30 18:04:00 UTC");
    expect(text).toContain("as of 14:03:40 ET");
    expect(container.querySelector("[data-cache-stale]")).not.toBeNull();
    // t0 has no quote yet and no earlier price -> unsigned; the rest meet the quote rule
    // (100.02 at the ask, 100 at the bid) or sit inside the spread (100.01 -> tick rule).
    expect(
      container.querySelector("[data-signing-counts]")?.textContent
    ).toContain("2 quote rule · 1 tick rule · 1 unsigned");
    const rows = [...container.querySelectorAll("[data-time-sales] tbody tr")];
    expect(rows.map((row) => row.getAttribute("data-side"))).toEqual([
      "buy",
      "sell",
      "buy",
      "unknown",
    ]);
    expect(rows[0]?.textContent).toContain("14:03:40");
    expect(rows[0]?.textContent).toContain("tick rule");
  });

  it("renders the ladder with venues, the size multiplier and the IBKR venue notice", async () => {
    const container = await render(gateways());
    await click(button(container, "Load order flow"));
    await click(tab(container, "book"));
    const ladder = container.querySelector("[data-depth-ladder]");
    const rows = [...(ladder?.querySelectorAll("tbody tr") ?? [])];
    expect(rows.map((row) => row.getAttribute("data-ladder-side"))).toEqual([
      "ask",
      "ask",
      "bid",
    ]);
    expect(rows[0]?.textContent).toContain("100.03");
    expect(rows[0]?.textContent).toContain("NSDQ");
    expect(rows[0]?.textContent).toContain("800");
    expect(rows[2]?.textContent).toContain("400");
    expect(
      container.querySelector("[data-size-multiplier]")?.textContent
    ).toContain(
      "lots of mdSizeMultiplier shares (100), rounded down, so shown shares are a lower bound"
    );
    expect(container.querySelector("[data-book-state]")?.textContent).toContain(
      "spread 0.02"
    );
    const notice = container.querySelector("[data-venue-notice]")?.textContent;
    expect(notice).toContain("Depth from: ARCA, NSDQ");
    expect(notice).toContain("Top of book only: BATS");
    expect(notice).toContain("Missing market data permission");
    expect(notice).toContain("IEX");
  });

  it("shows a crossed or locked book instead of a spread", async () => {
    for (const [bid, label] of [
      [100.03, "Crossed book"],
      [100.02, "Locked book"],
    ] as const) {
      const container = await render(
        gateways({
          depth: async () => ({
            ...depthOutput(),
            bids: [{ price: bid, size: 4, venue: "BATS" }],
          }),
        })
      );
      await click(button(container, "Load order flow"));
      await click(tab(container, "book"));
      const state = container.querySelector("[data-book-state]");
      expect(state?.textContent).toBe(label);
      expect(state?.textContent).not.toContain("spread");
    }
  });

  it("renders the footprint, delta / CVD and TPO views, each noting the tick window", async () => {
    const container = await render(gateways());
    await click(button(container, "Load order flow"));
    await click(tab(container, "footprint"));
    expect(container.querySelector("[data-footprint]")).not.toBeNull();
    expect(
      container.querySelector("[data-window-note]")?.textContent
    ).toContain("Covers only the fetched tick window");
    expect(
      container.querySelectorAll('[data-footprint-total="Delta"] td').length
    ).toBeGreaterThan(1);
    expect(container.querySelector("[data-poc]")).not.toBeNull();

    await click(tab(container, "delta"));
    expect(container.querySelector("[data-delta-chart]")).not.toBeNull();
    expect(container.querySelector("[data-cvd-chart]")).not.toBeNull();
    // Signed: unsigned 100, buy 200, sell 300, buy 50 -> CVD -50.
    expect(
      container.querySelector("[data-cvd-summary]")?.textContent
    ).toContain("CVD −50");
    expect(container.querySelector("[data-window-note]")).not.toBeNull();

    await click(tab(container, "tpo"));
    const profile = container.querySelector("[data-tpo-profile]");
    expect(profile?.getAttribute("data-tpo-profile")).toBe("2026-10-30");
    expect(
      container.querySelector("[data-tpo-summary]")?.textContent
    ).toContain("POC");
    expect(
      container.querySelector("[data-tpo-letters]")?.textContent
    ).toContain("A 09:30 · B 10:00 · C 10:30");
  });

  it("shows a depth ENTITLEMENT honestly while the other views keep working", async () => {
    const container = await render(
      gateways({ depth: () => Promise.reject(failure("ENTITLEMENT")) })
    );
    await click(button(container, "Load order flow"));
    expect(tab(container, "book")?.getAttribute("data-view-state")).toBe(
      "error"
    );
    await click(tab(container, "book"));
    const alert = container.querySelector("[role=alert]");
    expect(alert?.getAttribute("data-error-code")).toBe("ENTITLEMENT");
    expect(alert?.textContent).toContain(
      "The IBKR account has no L2 market depth permission for SPY on SMART"
    );
    expect(alert?.textContent).toContain("subscriptions are not active");
    expect(container.querySelector("[data-depth-ladder]")).toBeNull();
    await click(tab(container, "tape"));
    expect(container.querySelector("[data-time-sales]")).not.toBeNull();
    await click(tab(container, "tpo"));
    expect(container.querySelector("[data-tpo-profile]")).not.toBeNull();
  });

  it("keeps TPO working when ticks fail, and refreshes one view at a time", async () => {
    let fail = true;
    const gates = gateways({
      ticks: async () => {
        if (fail) throw failure("PACED");
        return ticksOutput();
      },
    });
    const container = await render(gates);
    await click(button(container, "Load order flow"));
    const alert = view(container)?.querySelector("[role=alert]");
    expect(alert?.getAttribute("data-error-code")).toBe("PACED");
    expect(alert?.textContent).toContain("IBKR pacing");
    await click(tab(container, "footprint"));
    expect(
      view(container)?.querySelector("[data-error-code=PACED]")
    ).not.toBeNull();
    await click(tab(container, "tpo"));
    expect(container.querySelector("[data-tpo-profile]")).not.toBeNull();

    fail = false;
    await click(tab(container, "tape"));
    await click(container.querySelector('[aria-label="Refresh trade prints"]'));
    expect(gates.orderFlow.ticks).toHaveBeenCalledTimes(2);
    expect(gates.orderFlow.depth).toHaveBeenCalledTimes(1);
    expect(gates.marketData.bars).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-time-sales]")).not.toBeNull();

    await click(tab(container, "book"));
    await click(container.querySelector('[aria-label="Refresh order book"]'));
    expect(gates.orderFlow.depth).toHaveBeenCalledTimes(2);
    expect(gates.orderFlow.ticks).toHaveBeenCalledTimes(2);
  });

  it("passes the futures contract month and shows a single-exchange book without venues", async () => {
    const gates = gateways({
      depth: async () => ({
        ...depthOutput(),
        asks: [{ price: 4500.25, size: 7, venue: null }],
        bids: [{ price: 4500, size: 9, venue: null }],
        request: {
          ...depthOutput().request,
          exchange: "CME",
          secType: "FUT",
          smartDepth: false,
        },
        sizeMultiplier: 1,
        venues: null,
      }),
    });
    const container = await render(gates, {
      contractMonth: "202612",
      currency: "USD",
      exchange: "CME",
      secType: "FUT",
      symbol: "ES",
    });
    await click(button(container, "Load order flow"));
    expect(gates.orderFlow.ticks).toHaveBeenCalledWith(
      expect.objectContaining({ contractMonth: "202612", exchange: "CME" })
    );
    await click(tab(container, "book"));
    expect(container.textContent).toContain("Sizes in contracts");
    expect(container.querySelector("[data-venue-notice]")).toBeNull();
    expect(
      [...container.querySelectorAll("[data-depth-ladder] th")].map(
        (node) => node.textContent
      )
    ).not.toContain("Venue");
  });

  it("moves between tabs with the arrow keys", async () => {
    const container = await render(gateways());
    await click(button(container, "Load order flow"));
    const list = container.querySelector("[role=tablist]");
    await act(async () => {
      list?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
      );
      await flush();
    });
    expect(tab(container, "tpo")?.getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      list?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Home" })
      );
      await flush();
    });
    expect(tab(container, "tape")?.getAttribute("aria-selected")).toBe("true");
  });
});
