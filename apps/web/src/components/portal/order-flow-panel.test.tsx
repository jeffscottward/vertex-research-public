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

const failure = (code: string, message = `${code} from service`) =>
  Object.assign(new Error(message), { code });

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
        // IBKR's long back-off: shown at once, not retried.
        if (fail) throw failure("PACED", "IBKR history pacing: retry in 600 s");
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

const selectNamed = (container: HTMLElement, name: string) => {
  const label = [...container.querySelectorAll("label")].find(
    (node) => node.textContent?.trim() === name
  );
  const select = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  if (!(select instanceof HTMLSelectElement))
    throw new Error(`Missing select ${name}`);
  return select;
};
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
};
const viewText = (container: HTMLElement) => view(container)?.textContent ?? "";

describe("OrderFlowPanel edge states", () => {
  it("says so when IBKR returns no prints, quotes, book levels or bars", async () => {
    const gates = gateways({
      bars: async () => ({
        ...barsOutput(),
        bars: [],
        count: 0,
        request: { ...barsOutput().request, useRTH: false },
      }),
      depth: async () => ({
        ...depthOutput(),
        asks: [],
        bids: [],
        minTick: null,
        venues: { depth: [], missing: [], top: [] },
      }),
      ticks: async () => ({
        ...ticksOutput(),
        asOf: null,
        minTick: null,
        quotes: [],
        request: { ...ticksOutput().request, useRTH: true },
        trades: [],
      }),
    });
    const container = await render(gates);
    await click(button(container, "Load order flow"));
    expect(viewText(container)).toContain(
      "IBKR returned no trade prints for this window."
    );
    expect(viewText(container)).toContain("regular hours only");
    expect(viewText(container)).toContain("no bid/ask quotes returned");
    await click(tab(container, "book"));
    expect(viewText(container)).toContain(
      "IBKR returned an empty book for this snapshot."
    );
    expect(viewText(container)).toContain("Depth from: —");
    expect(container.querySelector("[data-venues-missing]")).toBeNull();
    await click(tab(container, "footprint"));
    expect(viewText(container)).toContain(
      "No trade prints to build a footprint from."
    );
    expect(
      [...selectNamed(container, "Bucket").options].map((o) => o.textContent)
    ).toEqual(["Auto"]);
    await click(tab(container, "delta"));
    expect(viewText(container)).toContain(
      "No trade prints to compute delta from."
    );
    await click(tab(container, "tpo"));
    expect(viewText(container)).toContain(
      "IBKR returned no 30-minute bars for a profile."
    );
    expect(viewText(container)).toContain("all hours");
  });

  it("shows only the error when ticks and bars fail, and the service detail when it adds nothing new", async () => {
    const gates = gateways({
      bars: async () => {
        throw failure("UNAVAILABLE");
      },
      ticks: async () => {
        throw failure("UPSTREAM_ERROR");
      },
    });
    const container = await render(gates);
    await click(button(container, "Load order flow"));
    const alert = container.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("UPSTREAM_ERROR");
    expect(alert?.textContent).not.toContain("IBKR service said");
    for (const name of ["footprint", "delta", "tpo"]) {
      await click(tab(container, name));
      expect(container.querySelector("[role=alert]")).not.toBeNull();
      expect(viewText(container)).not.toContain("No trade prints");
    }
  });

  it("handles a one-sided futures book with zero sizes and no venues", async () => {
    const gates = gateways({
      depth: async () => ({
        ...depthOutput(),
        asks: [],
        bids: [
          { price: 7400.25, size: 0, venue: null },
          { price: 7400, size: 0, venue: null },
        ],
        minTick: null,
        request: { ...depthOutput().request, secType: "FUT", smartDepth: true },
        sizeMultiplier: 1,
        venues: null,
      }),
    });
    const container = await render(gates, {
      ...STK,
      exchange: "CME",
      secType: "FUT",
      symbol: "ES",
    });
    await click(button(container, "Load order flow"));
    await click(tab(container, "book"));
    const summary = container.querySelector("[data-book-summary]");
    expect(summary?.textContent).toContain("—");
    expect(summary?.textContent).toContain("contracts");
    expect(container.querySelector("[data-venue-notice]")).toBeNull();
    expect(
      container.querySelector<HTMLElement>(
        "[data-depth-ladder] [aria-hidden=true]"
      )?.style.width
    ).toBe("0%");
  });

  it("labels a derived tick, leaves empty footprint cells clear and draws a flat delta", async () => {
    const gates = gateways({
      ticks: async () => ({
        ...ticksOutput(),
        minTick: null,
        quotes: [],
        trades: [
          { c: null, p: 100.01, s: 100, t: t0, x: null },
          { c: null, p: 100.02, s: 0, t: t0 + 30, x: null },
          { c: null, p: 100.01, s: 100, t: t0 + 60, x: null },
        ],
      }),
    });
    const container = await render(gates);
    await click(button(container, "Load order flow"));
    expect(viewText(container)).toContain("—");
    await click(tab(container, "footprint"));
    expect(viewText(container)).toContain("derived from the prints");
    const cells = [...container.querySelectorAll<HTMLElement>("td[style]")];
    expect(
      cells.some((cell) => cell.style.backgroundColor === "transparent")
    ).toBe(true);
    await click(tab(container, "delta"));
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("refetches with the chosen rows and prints, and switches bucket, step and session", async () => {
    const twoSessions = (): MarketBarsOutput => {
      const base = barsOutput();
      const dayBefore = base.bars.map((item) => ({
        ...item,
        t: item.t - 86_400,
      }));
      return { ...base, bars: [...dayBefore, ...base.bars], count: 6 };
    };
    const gates = gateways({ bars: async () => twoSessions() });
    const container = await render(gates);
    await click(button(container, "Load order flow"));
    await choose(selectNamed(container, "Prints"), "1000");
    await click(container.querySelector("[aria-label='Refresh trade prints']"));
    expect(gates.orderFlow.ticks).toHaveBeenLastCalledWith(
      expect.objectContaining({ count: 1000 })
    );
    await click(tab(container, "book"));
    await choose(selectNamed(container, "Rows per side"), "20");
    await click(container.querySelector("[aria-label='Refresh order book']"));
    expect(gates.orderFlow.depth).toHaveBeenLastCalledWith(
      expect.objectContaining({ rows: 20 })
    );
    await click(tab(container, "footprint"));
    const bucket = selectNamed(container, "Bucket");
    const seconds = [...bucket.options]
      .map((o) => o.value)
      .find((v) => v !== "auto");
    await choose(bucket, seconds ?? "auto");
    expect(selectNamed(container, "Bucket").value).toBe(seconds);
    await choose(selectNamed(container, "Bucket"), "auto");
    expect(selectNamed(container, "Bucket").value).toBe("auto");
    const step = selectNamed(container, "Price step");
    const multiple = [...step.options]
      .map((o) => o.value)
      .find((v) => v !== "auto");
    await choose(step, multiple ?? "auto");
    expect(selectNamed(container, "Price step").value).toBe(multiple);
    await choose(selectNamed(container, "Price step"), "auto");
    await click(tab(container, "tpo"));
    const session = selectNamed(container, "Session");
    const older = [...session.options].at(-1)?.value ?? "";
    await choose(session, older);
    expect(selectNamed(container, "Session").value).toBe(older);
    const list = container.querySelector("[role=tablist]");
    await act(async () => {
      list?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "a" })
      );
      await flush();
    });
    expect(tab(container, "tpo")?.getAttribute("aria-selected")).toBe("true");
  });

  it("ignores results that arrive after the panel is gone", async () => {
    let resolveDepth: (value: MarketDepthOutput) => void = () => undefined;
    let rejectBars: (reason: unknown) => void = () => undefined;
    const gates = gateways({
      bars: () =>
        new Promise<MarketBarsOutput>((_resolve, reject) => {
          rejectBars = reject;
        }),
      depth: () =>
        new Promise<MarketDepthOutput>((resolve) => {
          resolveDepth = resolve;
        }),
    });
    const container = await render(gates);
    await click(button(container, "Load order flow"));
    expect(gates.marketData.bars).toHaveBeenCalledTimes(1);
    await click(tab(container, "book"));
    expect(viewText(container)).toContain("Loading");
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      resolveDepth(depthOutput());
      rejectBars(failure("PACED", "IBKR history pacing: retry in 3 s"));
      await flush();
    });
    expect(container.textContent).toBe("");
    expect(gates.marketData.bars).toHaveBeenCalledTimes(1);
  });

  it("asks for the TPO bars only after the trade prints settle", async () => {
    let resolveTicks: (value: MarketTicksOutput) => void = () => undefined;
    const gates = gateways({
      ticks: () =>
        new Promise<MarketTicksOutput>((resolve) => {
          resolveTicks = resolve;
        }),
    });
    const container = await render(gates);
    await click(button(container, "Load order flow"));
    expect(gates.orderFlow.depth).toHaveBeenCalledTimes(1);
    expect(gates.marketData.bars).not.toHaveBeenCalled();
    await act(async () => {
      resolveTicks(ticksOutput());
      await flush();
    });
    expect(gates.marketData.bars).toHaveBeenCalledTimes(1);
    await click(tab(container, "tpo"));
    expect(container.querySelector("[data-tpo-profile]")).not.toBeNull();
  });

  it("refreshes the TPO bars on their own from the TPO tab", async () => {
    const gates = gateways();
    const container = await render(gates);
    await click(button(container, "Load order flow"));
    await click(tab(container, "tpo"));
    await click(container.querySelector('[aria-label="Refresh TPO bars"]'));
    expect(gates.marketData.bars).toHaveBeenCalledTimes(2);
    expect(gates.orderFlow.ticks).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-tpo-profile]")).not.toBeNull();
  });

  it("retries one paced trade-prints request after the wait the service names", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let calls = 0;
      const gates = gateways({
        ticks: async () => {
          calls += 1;
          if (calls === 1)
            throw failure("PACED", "IBKR history pacing: retry in 70 s");
          return ticksOutput();
        },
      });
      const container = await render(gates);
      await click(button(container, "Load order flow"));
      expect(gates.orderFlow.ticks).toHaveBeenCalledTimes(1);
      expect(gates.marketData.bars).not.toHaveBeenCalled();
      expect(container.querySelector("[role=alert]")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(70_000);
        await flush();
      });
      expect(gates.orderFlow.ticks).toHaveBeenCalledTimes(2);
      expect(gates.marketData.bars).toHaveBeenCalledTimes(1);
      expect(container.querySelector("[data-time-sales]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("TPO pacing retry", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const pacedOnce = (message: string) => {
      let calls = 0;
      return gateways({
        bars: async () => {
          calls += 1;
          if (calls === 1) throw failure("PACED", message);
          return barsOutput();
        },
      });
    };

    it("retries one paced bars request after the wait the service names", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const gates = pacedOnce("IBKR history pacing: retry in 3 s");
      const container = await render(gates);
      await click(button(container, "Load order flow"));
      await click(tab(container, "tpo"));
      expect(gates.marketData.bars).toHaveBeenCalledTimes(1);
      expect(viewText(container)).toContain("Loading");
      expect(container.querySelector("[role=alert]")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
        await flush();
      });
      expect(gates.marketData.bars).toHaveBeenCalledTimes(2);
      expect(container.querySelector("[data-tpo-profile]")).not.toBeNull();
    });

    it("shows the pacing error at once when the wait is IBKR's long back-off", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const gates = pacedOnce("IBKR history pacing: retry in 600 s");
      const container = await render(gates);
      await click(button(container, "Load order flow"));
      await click(tab(container, "tpo"));
      expect(
        view(container)?.querySelector("[data-error-code=PACED]")
      ).not.toBeNull();
      expect(gates.marketData.bars).toHaveBeenCalledTimes(1);
    });

    it("drops the retry when the panel goes away during the wait", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const gates = pacedOnce("IBKR history pacing: retry in 3 s");
      const container = await render(gates);
      await click(button(container, "Load order flow"));
      for (const root of roots.splice(0)) await act(async () => root.unmount());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
        await flush();
      });
      expect(gates.marketData.bars).toHaveBeenCalledTimes(1);
      expect(container.textContent).toBe("");
    });
  });

  it("draws a flat delta for one unsigned print and profiles one-period and no-single-print sessions", async () => {
    const open = Date.parse("2026-10-30T13:30:00Z") / 1000;
    const gates = gateways({
      bars: async () => ({
        ...barsOutput(),
        bars: [
          { c: 101, h: 101, l: 100, o: 100, t: open - 86_400, v: 1 },
          { c: 101, h: 101, l: 100, o: 100, t: open, v: 1 },
          { c: 101, h: 101, l: 100, o: 100, t: open + 1800, v: 1 },
        ],
        count: 3,
      }),
      ticks: async () => ({
        ...ticksOutput(),
        quotes: [],
        trades: [{ c: null, p: 100.01, s: 10, t: t0, x: "ARCA" }],
      }),
    });
    const container = await render(gates);
    await click(button(container, "Load order flow"));
    await click(tab(container, "delta"));
    expect(container.querySelector("svg")).not.toBeNull();
    await click(tab(container, "tpo"));
    const summary = () =>
      container.querySelector("[data-tpo-summary]")?.textContent ?? "";
    expect(summary()).toContain("Initial balance (A+B)");
    expect(summary()).toContain("none");
    const session = selectNamed(container, "Session");
    await choose(session, [...session.options].at(-1)?.value ?? "");
    expect(summary()).toContain("Initial balance (A)");
  });
});
