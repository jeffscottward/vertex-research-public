// @vitest-environment jsdom
import type {
  ApiClient,
  FlowControl,
  FlowControlInput,
  FlowHedgingPressure,
  FlowLiquidityHeatmap,
  FlowLiveDom,
  FlowLiveDomStreamEvent,
  FlowLiveDomWindowSeconds,
  FlowOptionBubbles,
  FlowPutCallRatio,
  FlowSnapshot,
  FlowStrikeHeatmap,
  FlowTapeSpeed,
  FlowTapeSymbol,
  FlowTradeBubbles,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
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

import type { HedgingPressureRequest } from "../../features/flow/hedging-pressure-view-model.ts";
import type { LiquidityHeatmapRequest } from "../../features/flow/liquidity-heatmap-view-model.ts";
import type { OptionBubblesRequest } from "../../features/flow/option-bubbles-view-model.ts";
import type { PutCallRatioRequest } from "../../features/flow/put-call-ratio-view-model.ts";
import type { StrikeHeatmapRequest } from "../../features/flow/strike-heatmap-view-model.ts";
import type { TapeSpeedRequest } from "../../features/flow/tape-speed-view-model.ts";
import type { TradeBubblesRequest } from "../../features/flow/trade-bubbles-view-model.ts";
import type { FlowRequest } from "../../features/flow/view-model.ts";
import {
  labFlowControl,
  labFlowHedgingPressure,
  labFlowLiquidityHeatmap,
  labFlowLiveDom,
  labFlowLiveDomStream,
  labFlowOptionBubbles,
  labFlowPutCallRatio,
  labFlowSnapshot,
  labFlowStrikeHeatmap,
  labFlowTapeSpeed,
  labFlowTradeBubbles,
} from "../../lab/fixtures/flow.ts";
import {
  createBrowserFlowGateway,
  type FlowGateway,
  FlowWorkspace,
} from "./flow-workspace.tsx";

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

const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

const flush = () => act(async () => await Promise.resolve());

const compactStrikeHeatmapCache = new Map<string, FlowStrikeHeatmap>();
const compactStrikeHeatmap = (
  symbol: StrikeHeatmapRequest["symbol"],
  bucketMinutes: NonNullable<StrikeHeatmapRequest["bucketMinutes"]> = 15
): FlowStrikeHeatmap => {
  const key = `${symbol}:${bucketMinutes}`;
  const cached = compactStrikeHeatmapCache.get(key);
  if (cached !== undefined) return cached;
  const full = labFlowStrikeHeatmap(symbol, bucketMinutes);
  const slots = full.slots.slice(0, 2);
  const strikes = full.strikes.slice(0, 2);
  const slotSet = new Set(slots.map((slot) => slot.index));
  const strikeSet = new Set(strikes.map((strike) => strike.strike));
  const compact: FlowStrikeHeatmap = {
    ...full,
    cells: full.cells.filter(
      (cell) => slotSet.has(cell.slotIndex) && strikeSet.has(cell.strike)
    ),
    slots,
    strikes,
  };
  compactStrikeHeatmapCache.set(key, compact);
  return compact;
};

const compactOptionBubblesCache = new Map<string, FlowOptionBubbles>();
const compactOptionBubbles = (
  symbol: OptionBubblesRequest["symbol"],
  minPremiumUsd: NonNullable<OptionBubblesRequest["minPremiumUsd"]> = 250_000
): FlowOptionBubbles => {
  const key = `${symbol}:${minPremiumUsd}`;
  const cached = compactOptionBubblesCache.get(key);
  if (cached !== undefined) return cached;
  const full = labFlowOptionBubbles(symbol, minPremiumUsd);
  const compact: FlowOptionBubbles = {
    ...full,
    bubbles: full.bubbles.slice(0, 2),
    pricePoints: full.pricePoints.slice(0, 2),
  };
  compactOptionBubblesCache.set(key, compact);
  return compact;
};

const compactLiquidityHeatmapCache = new Map<string, FlowLiquidityHeatmap>();
const compactLiquidityHeatmap = (
  symbol: LiquidityHeatmapRequest["symbol"],
  minutes: LiquidityHeatmapRequest["minutes"]
): FlowLiquidityHeatmap => {
  const key = `${symbol}:${minutes}`;
  const cached = compactLiquidityHeatmapCache.get(key);
  if (cached !== undefined) return cached;
  const full = labFlowLiquidityHeatmap(symbol, minutes);
  const compact: FlowLiquidityHeatmap = {
    ...full,
    columns: full.columns.slice(0, 2),
    currentDom: full.currentDom.slice(0, 2),
    trades: full.trades.slice(0, 2),
    walls: full.walls.slice(0, 2),
  };
  compactLiquidityHeatmapCache.set(key, compact);
  return compact;
};

const compactLiveDomCache = new Map<string, FlowLiveDom>();
const compactLiveDom = (
  symbol: FlowTapeSymbol,
  windowSeconds: FlowLiveDomWindowSeconds = 900,
  since: number | null = null
): FlowLiveDom => {
  const key = `${symbol}:${windowSeconds}:${since ?? ""}`;
  const cached = compactLiveDomCache.get(key);
  if (cached !== undefined) return cached;
  const full = labFlowLiveDom(symbol, windowSeconds, since);
  const compact: FlowLiveDom = {
    ...full,
    rows: full.rows.slice(0, 2),
  };
  compactLiveDomCache.set(key, compact);
  return compact;
};

const compactLiveDomStream = (
  symbol: FlowTapeSymbol,
  windowSeconds: FlowLiveDomWindowSeconds = 900,
  since: number | null = null,
  signal?: AbortSignal
): AsyncIterable<FlowLiveDomStreamEvent> => ({
  async *[Symbol.asyncIterator]() {
    yield {
      frame: compactLiveDom(symbol, windowSeconds, since),
      type: "frame",
    };
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  },
});

const fixed = (
  snapshot: (request: FlowRequest) => FlowSnapshot | Promise<FlowSnapshot>,
  control: (input: FlowControlInput) => FlowControl | Promise<FlowControl> = ({
    group,
  }) => labFlowControl(group),
  tapeSpeed: (
    request: TapeSpeedRequest
  ) => FlowTapeSpeed | Promise<FlowTapeSpeed> = ({ minutes, symbol }) =>
    labFlowTapeSpeed(symbol, minutes),
  hedging: (
    request: HedgingPressureRequest
  ) => FlowHedgingPressure | Promise<FlowHedgingPressure> = ({ symbol }) =>
    labFlowHedgingPressure(symbol),
  putCallRatio: (
    request: PutCallRatioRequest
  ) => FlowPutCallRatio | Promise<FlowPutCallRatio> = ({ symbol }) =>
    labFlowPutCallRatio(symbol),
  liquidityHeatmap: (
    request: LiquidityHeatmapRequest
  ) => FlowLiquidityHeatmap | Promise<FlowLiquidityHeatmap> = ({
    minutes,
    symbol,
  }) => compactLiquidityHeatmap(symbol, minutes),
  strikeHeatmap: (
    request: StrikeHeatmapRequest
  ) => FlowStrikeHeatmap | Promise<FlowStrikeHeatmap> = ({
    bucketMinutes,
    symbol,
  }) => compactStrikeHeatmap(symbol, bucketMinutes),
  optionBubbles: (
    request: OptionBubblesRequest
  ) => FlowOptionBubbles | Promise<FlowOptionBubbles> = ({
    minPremiumUsd,
    symbol,
  }) => compactOptionBubbles(symbol, minPremiumUsd),
  tradeBubbles: (
    request: TradeBubblesRequest
  ) => FlowTradeBubbles | Promise<FlowTradeBubbles> = ({ minutes, symbol }) =>
    labFlowTradeBubbles(symbol, minutes)
) => {
  const calls: FlowRequest[] = [];
  const controlCalls: FlowControlInput[] = [];
  const tapeCalls: TapeSpeedRequest[] = [];
  const hedgingCalls: HedgingPressureRequest[] = [];
  const putCallCalls: PutCallRatioRequest[] = [];
  const heatmapCalls: LiquidityHeatmapRequest[] = [];
  const strikeHeatmapCalls: StrikeHeatmapRequest[] = [];
  const optionBubblesCalls: OptionBubblesRequest[] = [];
  const tradeBubblesCalls: TradeBubblesRequest[] = [];
  const gateway: FlowGateway = {
    control: async (input) => {
      controlCalls.push(input);
      return await control(input);
    },
    hedgingPressure: async (request) => {
      hedgingCalls.push(request);
      return await hedging(request);
    },
    liquidityHeatmap: async (request) => {
      heatmapCalls.push(request);
      return await liquidityHeatmap(request);
    },
    liveDomStream: async ({ since, symbol, windowSeconds }, options) =>
      compactLiveDomStream(
        symbol,
        windowSeconds,
        since ?? null,
        options?.signal
      ),
    optionBubbles: async (request) => {
      optionBubblesCalls.push(request);
      return await optionBubbles(request);
    },
    putCallRatio: async (request) => {
      putCallCalls.push(request);
      return await putCallRatio(request);
    },
    snapshot: async (request) => {
      calls.push(request);
      return await snapshot(request);
    },
    strikeHeatmap: async (request) => {
      strikeHeatmapCalls.push(request);
      return await strikeHeatmap(request);
    },
    tapeSpeed: async (request) => {
      tapeCalls.push(request);
      return await tapeSpeed(request);
    },
    tradeBubbles: async (request) => {
      tradeBubblesCalls.push(request);
      return await tradeBubbles(request);
    },
  };
  return {
    calls,
    controlCalls,
    gateway,
    heatmapCalls,
    hedgingCalls,
    optionBubblesCalls,
    putCallCalls,
    strikeHeatmapCalls,
    tapeCalls,
    tradeBubblesCalls,
  };
};

const button = (container: HTMLElement, name: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name
  );
  if (found === undefined) throw new Error(`Missing button ${name}`);
  return found;
};

const click = (element: HTMLElement) => act(async () => element.click());

const empty: FlowSnapshot = {
  ...labFlowSnapshot("SPY", 60),
  confluence: {
    bearish: 0,
    bullish: 0,
    factors: [],
    known: 0,
    label: "Not enough data",
    summary: "insufficient",
  },
  events: [],
  freshness: (["ticks", "depth", "options", "gex"] as const).map((source) => ({
    ageSeconds: null,
    lastOkAt: null,
    lastStatus: null,
    message: null,
    sessionOpen: false,
    source,
    state: "never" as const,
  })),
  gex: null,
  minutes: [],
  notes: [],
  optionsFlow: { ...labFlowSnapshot("SPY", 60).optionsFlow, trades: 0 },
  orderFlow: { ...labFlowSnapshot("SPY", 60).orderFlow, book: null },
};

describe("createBrowserFlowGateway", () => {
  it("creates one client on first use and calls flow.snapshot, flow.control, flow.tapeSpeed and flow.hedgingPressure", async () => {
    const snapshot = vi.fn(async () => labFlowSnapshot("SPY", 60));
    const control = vi.fn(async () => labFlowControl("sp500"));
    const tapeSpeed = vi.fn(async () => labFlowTapeSpeed("NQ", 240));
    const hedgingPressure = vi.fn(async () => labFlowHedgingPressure("ES"));
    const putCallRatio = vi.fn(async () => labFlowPutCallRatio("ES"));
    const liquidityHeatmap = vi.fn(async () =>
      labFlowLiquidityHeatmap("NQ", 60)
    );
    const liveDomStream = vi.fn(
      async (_input: unknown, options?: { signal?: AbortSignal }) =>
        labFlowLiveDomStream("ES", 900, null, options?.signal)
    );
    const strikeHeatmap = vi.fn(async () => labFlowStrikeHeatmap("ES", 30));
    const optionBubbles = vi.fn(async () =>
      labFlowOptionBubbles("ES", 500_000)
    );
    const tradeBubbles = vi.fn(async () => labFlowTradeBubbles("ES", 60));
    runtime.client = {
      flow: {
        control,
        hedgingPressure,
        liquidityHeatmap,
        liveDomStream,
        optionBubbles,
        putCallRatio,
        snapshot,
        strikeHeatmap,
        tapeSpeed,
        tradeBubbles,
      },
    } as unknown as ApiClient;
    const gateway = createBrowserFlowGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.snapshot({ minutes: 60, symbol: "SPY" });
    await gateway.snapshot({ minutes: 120, symbol: "ES" });
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(snapshot).toHaveBeenCalledWith({ minutes: 60, symbol: "SPY" });
    expect(snapshot).toHaveBeenCalledWith({ minutes: 120, symbol: "ES" });
    await gateway.control({ group: "nasdaq100" });
    expect(control).toHaveBeenCalledWith({ group: "nasdaq100" });
    await expect(
      gateway.tapeSpeed({ minutes: 240, symbol: "NQ" })
    ).resolves.toMatchObject({ symbol: "NQ" });
    expect(tapeSpeed).toHaveBeenCalledWith({ minutes: 240, symbol: "NQ" });
    await expect(
      gateway.hedgingPressure({ symbol: "ES" })
    ).resolves.toMatchObject({ ticker: "SPX" });
    expect(hedgingPressure).toHaveBeenCalledWith({ symbol: "ES" });
    await expect(gateway.putCallRatio({ symbol: "ES" })).resolves.toMatchObject(
      { ticker: "SPX" }
    );
    expect(putCallRatio).toHaveBeenCalledWith({ symbol: "ES" });
    await expect(
      gateway.liquidityHeatmap({ minutes: 60, symbol: "NQ" })
    ).resolves.toMatchObject({ symbol: "NQ" });
    expect(liquidityHeatmap).toHaveBeenCalledWith({
      minutes: 60,
      symbol: "NQ",
    });
    await expect(
      gateway.strikeHeatmap({ bucketMinutes: 30, symbol: "ES" })
    ).resolves.toMatchObject({ bucketMinutes: 30, ticker: "SPX" });
    expect(strikeHeatmap).toHaveBeenCalledWith({
      bucketMinutes: 30,
      symbol: "ES",
    });
    const ac = new AbortController();
    ac.abort();
    await gateway.liveDomStream(
      { cadenceMs: 500, symbol: "ES", windowSeconds: 900 },
      { signal: ac.signal }
    );
    expect(liveDomStream).toHaveBeenCalledWith(
      { cadenceMs: 500, symbol: "ES", windowSeconds: 900 },
      { signal: ac.signal }
    );
    await expect(
      gateway.optionBubbles({ minPremiumUsd: 500_000, symbol: "ES" })
    ).resolves.toMatchObject({ minPremiumUsd: 500_000, ticker: "SPX" });
    expect(optionBubbles).toHaveBeenCalledWith({
      minPremiumUsd: 500_000,
      symbol: "ES",
    });
    await expect(
      gateway.tradeBubbles({ minutes: 60, symbol: "ES" })
    ).resolves.toMatchObject({ symbol: "ES" });
    expect(tradeBubbles).toHaveBeenCalledWith({
      minutes: 60,
      symbol: "ES",
    });
    expect(runtime.origins).toHaveLength(1);
  });

  it("is the default gateway of the workspace", async () => {
    const snapshot = vi.fn(async () => labFlowSnapshot("SPY", 120));
    const control = vi.fn(async () => labFlowControl("sp500"));
    const tapeSpeed = vi.fn(async () => labFlowTapeSpeed("ES", 120));
    const hedgingPressure = vi.fn(async () => labFlowHedgingPressure("SPY"));
    const putCallRatio = vi.fn(async () => labFlowPutCallRatio("SPY"));
    const liquidityHeatmap = vi.fn(async () =>
      labFlowLiquidityHeatmap("ES", 120)
    );
    const liveDomStream = vi.fn(
      async (_input: unknown, options?: { signal?: AbortSignal }) =>
        labFlowLiveDomStream("ES", 900, null, options?.signal)
    );
    const strikeHeatmap = vi.fn(async () => labFlowStrikeHeatmap("SPY", 15));
    const optionBubbles = vi.fn(async () =>
      labFlowOptionBubbles("SPY", 250_000)
    );
    const tradeBubbles = vi.fn(async () => labFlowTradeBubbles("ES", 120));
    runtime.client = {
      flow: {
        control,
        hedgingPressure,
        liquidityHeatmap,
        liveDomStream,
        optionBubbles,
        putCallRatio,
        snapshot,
        strikeHeatmap,
        tapeSpeed,
        tradeBubbles,
      },
    } as unknown as ApiClient;
    const container = await render(<FlowWorkspace />);
    await vi.waitFor(() =>
      expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull()
    );
    expect(snapshot).toHaveBeenCalledWith({ minutes: 120, symbol: "SPY" });
    // SPY has no streamed tape: the page asks for the future of its group.
    expect(tapeSpeed).toHaveBeenCalledWith({ minutes: 120, symbol: "ES" });
    expect(hedgingPressure).toHaveBeenCalledWith({ symbol: "SPY" });
    expect(putCallRatio).toHaveBeenCalledWith({ symbol: "SPY" });
    expect(liquidityHeatmap).toHaveBeenCalledWith({
      minutes: 120,
      symbol: "ES",
    });
    expect(strikeHeatmap).toHaveBeenCalledWith({
      bucketMinutes: 15,
      symbol: "SPY",
    });
    expect(optionBubbles).toHaveBeenCalledWith({
      minPremiumUsd: 250_000,
      symbol: "SPY",
    });
    expect(tradeBubbles).toHaveBeenCalledWith({
      minutes: 120,
      symbol: "ES",
    });
  });
});

describe("FlowWorkspace", () => {
  it("shows every section of a SPY snapshot with its as-of stamp", async () => {
    const { calls, gateway } = fixed(({ minutes, symbol }) =>
      labFlowSnapshot(symbol, minutes)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    expect(calls).toEqual([{ minutes: 120, symbol: "SPY" }]);
    await vi.waitFor(() =>
      expect(
        container
          .querySelector("[data-flow-state]")
          ?.getAttribute("data-flow-state")
      ).toBe("idle")
    );
    const text = container.textContent ?? "";
    expect(container.querySelector("[data-flow-as-of]")?.textContent).toContain(
      "As of Oct 30, 4:00 PM EDT"
    );
    expect(text).toContain("generated Oct 30, 4:00 PM EDT");
    expect(text).toContain("Auto-refreshes every 60 s.");
    expect(
      container.querySelector("[data-flow-chart] figcaption")?.textContent
    ).toBe(
      "Delta per minute (buy − sell) and cumulative delta. 81 of 121 minutes with tape; shaded minutes have none."
    );
    expect(text).toContain(
      "Read-only research view. ES and NQ live DOM streams from active CME L2 depth and tape (recorded fallback when offline), while historical depth is recorded (5 s streamed, 1 min sampled fallback); SPY depth and SPY ticks are sampled, so their totals cover only the seconds shown above."
    );
    expect(
      container.querySelector('[data-metric="Tape coverage"]')
    ).not.toBeNull();
    expect(container.querySelectorAll("[data-flow-source]")).toHaveLength(4);
    expect(
      container.querySelector('[data-flow-source="options"] [data-freshness]')
        ?.textContent
    ).toContain("stale");
    expect(text).toContain("No new prints since the last sample.");
    expect(container.querySelector("[data-flow-never]")).toBeNull();
    expect(
      container.querySelector('[data-flow-confluence="agree_bullish"]')
        ?.textContent
    ).toContain("2 of 3 short-term factors bullish");
    expect(text).toContain("not a trade signal");
    expect(container.querySelectorAll("[data-flow-factor]")).toHaveLength(4);
    expect(
      container.querySelector('[data-flow-metrics="order-flow"]')?.textContent
    ).toContain("Off-exchange share");
    expect(
      container.querySelectorAll("[data-flow-bar]").length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-flow-gap]").length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-flow-cvd-segment]").length
    ).toBeGreaterThan(1);
    expect(
      container.querySelector('[data-flow-metrics="book"]')
    ).not.toBeNull();
    expect(text).toContain("Options flow (SPY)");
    expect(container.querySelectorAll("[data-flow-print]")).toHaveLength(2);
    expect(
      container.querySelector(
        '[role="region"][aria-label^="Top option prints"]'
      )
    ).not.toBeNull();
    expect(text).toContain("golden sweep");
    expect(container.querySelector("[data-flow-basis]")?.textContent).toBe(
      "Levels come from SPY options, already in SPY price."
    );
    expect(
      container.querySelectorAll('[data-flow-level="flip"] td')
    ).toHaveLength(1);
    expect(
      container.querySelector("[data-flow-gex-source]")?.textContent
    ).toContain("Source: QuantData open interest and IV, an estimate.");
    expect(container.querySelectorAll("[data-flow-event]")).toHaveLength(2);
    expect(container.querySelector("[data-flow-notes]")?.textContent).toContain(
      "Fictional lab data"
    );
    expect(button(container, "SPY").getAttribute("aria-pressed")).toBe("true");
  });

  it("switches symbol and window and refreshes on demand", async () => {
    const { calls, gateway } = fixed(({ minutes, symbol }) =>
      labFlowSnapshot(symbol, minutes)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await flush();
    await click(button(container, "SPY"));
    expect(calls).toHaveLength(1);

    await click(button(container, "ES"));
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-flow-snapshot="ES"]')
      ).not.toBeNull()
    );
    expect(calls.at(-1)).toEqual({ minutes: 120, symbol: "ES" });
    const text = container.textContent ?? "";
    expect(text).toContain("Options flow (SPX)");
    expect(text).toContain("ES options flow is read from SPX options.");
    expect(text).not.toContain("Off-exchange share");
    expect(container.querySelector("[data-flow-basis]")?.textContent).toContain(
      "basis of +18.50"
    );
    expect(
      container.querySelectorAll('[data-flow-level="flip"] td')
    ).toHaveLength(2);

    const select = container.querySelector(
      "[data-flow-window]"
    ) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "15 min",
      "30 min",
      "60 min",
      "120 min",
      "240 min",
      "390 min (full session)",
    ]);
    await act(async () => {
      select.value = "240";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(calls.at(-1)).toEqual({ minutes: 240, symbol: "ES" });

    const before = calls.length;
    await click(
      container.querySelector("[data-flow-refresh]") as HTMLButtonElement
    );
    await flush();
    expect(calls).toHaveLength(before + 1);
  });

  it("refreshes on its timer", async () => {
    vi.useFakeTimers();
    const { calls, gateway } = fixed(({ minutes, symbol }) =>
      labFlowSnapshot(symbol, minutes)
    );
    const container = await render(
      <FlowWorkspace gateway={gateway} refreshMs={5000} />
    );
    await flush();
    expect(container.textContent).toContain("Auto-refreshes every 5 s.");
    expect(calls).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(calls).toHaveLength(2);
  });

  it("explains a never-collected symbol and empty sections", async () => {
    const { gateway } = fixed(() => empty);
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull()
    );
    expect(container.querySelector("[data-flow-never]")?.textContent).toContain(
      "Nothing has been collected for SPY yet"
    );
    expect(
      [...container.querySelectorAll("[data-flow-empty]")].map((item) =>
        item.getAttribute("data-flow-empty")
      )
    ).toEqual(["factors", "minutes", "book", "options", "gex", "events"]);
    expect(
      container.querySelector('[data-flow-empty="minutes"]')?.textContent
    ).toBe(
      "No minute with tape in this window yet. SPY ticks are sampled every few minutes; ES and NQ ticks are streamed."
    );
    const text = container.textContent ?? "";
    expect(text).toContain("never collected");
    expect(text).toContain("no samples yet");
    expect(container.querySelector("[data-flow-chart]")).toBeNull();
    expect(container.querySelector("[data-flow-notes]")).toBeNull();
  });

  it("explains option flow without top prints", async () => {
    const base = labFlowSnapshot("SPY", 60);
    const { gateway } = fixed(() => ({
      ...base,
      optionsFlow: { ...base.optionsFlow, topPrints: [] },
    }));
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-flow-empty="prints"]')
      ).not.toBeNull()
    );
    expect(
      container.querySelector('[data-flow-metrics="options"]')
    ).not.toBeNull();
  });

  it("shows a dash for a print without flags", async () => {
    const base = labFlowSnapshot("SPY", 60);
    const [print] = base.optionsFlow.topPrints;
    const { gateway } = fixed(() => ({
      ...base,
      optionsFlow: {
        ...base.optionsFlow,
        topPrints: [
          {
            ...(print as FlowSnapshot["optionsFlow"]["topPrints"][number]),
            goldenSweep: false,
            moneyness: "not_reported",
            opening: false,
            unusual: false,
            volumeOverOi: false,
          },
        ],
      },
    }));
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(container.querySelector("[data-flow-print]")).not.toBeNull()
    );
    expect(
      container.querySelector("[data-flow-print] td:last-child")?.textContent
    ).toBe("—");
  });

  it("labels each vote, names the cause of a print without a classified side and of a GEX value without a regime", async () => {
    const base = labFlowSnapshot("ES", 60);
    const [print] = base.optionsFlow.topPrints;
    const [factor] = base.confluence.factors;
    const gex = base.gex;
    if (print === undefined || factor === undefined || gex === null)
      throw new Error("fixture has a print, a factor and a GEX row");
    const { gateway } = fixed(() => ({
      ...base,
      confluence: {
        ...base.confluence,
        factors: [
          { ...factor, key: "order_flow" as const, vote: "no_data" as const },
          { ...factor, key: "gex" as const, vote: "context" as const },
          {
            ...factor,
            key: "book" as const,
            vote: "later_vote" as typeof factor.vote,
          },
        ],
      },
      gex: {
        ...gex,
        at: "2026-11-18T14:05:00.000Z",
        ivRegime: "no_term_data" as const,
        regime: "no_data" as const,
      },
      optionsFlow: {
        ...base.optionsFlow,
        topPrints: [
          { ...print, side: "not_classified" as const },
          { ...print, at: "2026-11-18T14:06:00.000Z", side: "ask" as const },
        ],
      },
    }));
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull()
    );
    expect(
      [...container.querySelectorAll("[data-flow-factor]")].map(
        (item) => item.children[2]?.textContent
      )
    ).toEqual([
      "Status:no data",
      "Status:context",
      'Status:Value "later_vote" has no label in this page version · reload the page',
    ]);
    const sides = [
      ...container.querySelectorAll("[data-flow-print] td:nth-last-child(4)"),
    ];
    expect(sides.map((cell) => cell.textContent)).toEqual([
      "not classified",
      "At ask",
    ]);
    expect(sides.map((cell) => cell.getAttribute("title"))).toEqual([
      "QuantData sent no side code for this print, or a code that this version does not map",
      null,
    ]);
    const regime = container.querySelector(
      '[data-flow-metrics="gex"] [data-metric="Regime"] dd'
    );
    expect(regime?.textContent).toBe("no GEX estimate");
    expect(regime?.getAttribute("title")).toBe(
      "The stored GEX row of 2026-11-18 14:05 UTC has no positive or negative regime"
    );
    expect(
      container
        .querySelector('[data-flow-metrics="gex"] [data-metric="Total GEX"] dd')
        ?.hasAttribute("title")
    ).toBe(false);
  });

  it("shows operator access required when the API forbids it", async () => {
    const { gateway } = fixed(() => {
      throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
    });
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(
        container
          .querySelector("[data-operator-access]")
          ?.getAttribute("data-operator-feature")
      ).toBe("flow")
    );
  });

  it("shows an error, then recovers on refresh", async () => {
    let fail = true;
    const { gateway } = fixed(() => {
      if (fail)
        throw {
          code: "STORAGE_ERROR",
          message: "Flow storage request failed; retry",
        };
      return labFlowSnapshot("SPY", 120);
    });
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
        /^Load failed \d{2}:\d{2} UTC · Flow snapshot not loaded: STORAGE_ERROR: Flow storage request failed; retry · retrying every 60 s$/u
      )
    );
    expect(container.querySelector("[data-flow-snapshot]")).toBeNull();

    fail = false;
    await click(
      container.querySelector("[data-flow-refresh]") as HTMLButtonElement
    );
    await vi.waitFor(() =>
      expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull()
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();

    fail = true;
    await click(
      container.querySelector("[data-flow-refresh]") as HTMLButtonElement
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
        /^Load failed \d{2}:\d{2} UTC · Refresh failed: STORAGE_ERROR: Flow storage request failed; retry · showing the snapshot as of Oct 30, 4:00 PM EDT · retrying every 60 s$/u
      )
    );
    expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull();
  });

  it("ignores answers to requests a newer one replaced", async () => {
    // Promise.withResolvers is outside the ES2023 lib of this package.
    const pending: {
      resolve: (value: FlowSnapshot) => void;
      reject: (error: unknown) => void;
    }[] = [];
    const { calls, gateway } = fixed(({ minutes, symbol }) => {
      if (symbol === "ES") return labFlowSnapshot("ES", minutes);
      return new Promise<FlowSnapshot>((resolve, reject) => {
        pending.push({ reject, resolve });
      });
    });
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await click(button(container, "ES"));
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-flow-snapshot="ES"]')
      ).not.toBeNull()
    );
    await act(async () => pending[0]?.resolve(labFlowSnapshot("SPY", 120)));
    await flush();
    expect(container.querySelector('[data-flow-snapshot="ES"]')).not.toBeNull();
    expect(
      container
        .querySelector("[data-flow-state]")
        ?.getAttribute("data-flow-state")
    ).toBe("idle");

    await click(button(container, "SPY"));
    await click(button(container, "ES"));
    await act(async () => pending[1]?.reject(new Error("late failure")));
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-flow-snapshot="ES"]')
      ).not.toBeNull()
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(calls.map((call) => call.symbol)).toEqual([
      "SPY",
      "ES",
      "SPY",
      "ES",
    ]);
  });
});

describe("FlowWorkspace control panel", () => {
  const idle = (container: HTMLElement) =>
    vi.waitFor(() =>
      expect(
        container
          .querySelector("[data-flow-state]")
          ?.getAttribute("data-flow-state")
      ).toBe("idle")
    );

  it("shows the control panel first and loads the group of the selected symbol", async () => {
    const { controlCalls, gateway } = fixed(({ minutes, symbol }) =>
      labFlowSnapshot(symbol, minutes)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await idle(container);
    expect(controlCalls).toEqual([{ group: "sp500" }]);
    const panel = container.querySelector("[data-flow-control]");
    const snapshot = container.querySelector("[data-flow-snapshot]");
    expect(panel?.textContent).toContain("Who is in control: S&P 500");
    const blocks = [
      ...container.querySelectorAll(
        "[data-flow-control], [data-flow-snapshot]"
      ),
    ];
    expect(blocks).toEqual([panel, snapshot]);
    expect(container.querySelector("[data-flow-not-collected]")).toBeNull();
    const titles = [...container.querySelectorAll("h2")].map(
      (heading) => heading.textContent
    );
    expect(
      titles.indexOf("Short-term factors (last 15 to 30 min)")
    ).toBeLessThan(titles.indexOf("Data freshness"));
  });

  it("loads nasdaq100 for QQQ and NQ and names what is not collected", async () => {
    const { controlCalls, gateway } = fixed(({ minutes, symbol }) =>
      labFlowSnapshot(symbol, minutes)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await idle(container);
    await click(button(container, "QQQ"));
    await idle(container);
    expect(
      container.querySelector("[data-flow-control]")?.textContent
    ).toContain("Who is in control: Nasdaq 100");
    expect(
      container.querySelector("[data-flow-not-collected]")?.textContent
    ).toBe(
      "Not collected for QQQ: trades and option prints. The IBKR and vendor budgets go to ES, NQ and SPY."
    );
    await click(button(container, "NQ"));
    await idle(container);
    await click(button(container, "ES"));
    await idle(container);
    expect(controlCalls.map((call) => call.group)).toEqual([
      "sp500",
      "nasdaq100",
      "nasdaq100",
      "sp500",
    ]);
  });

  it("keeps the snapshot when the control read fails and shows the failure in the panel", async () => {
    let fail = true;
    const { gateway } = fixed(
      ({ minutes, symbol }) => labFlowSnapshot(symbol, minutes),
      ({ group }) => {
        if (fail) throw { code: "STORAGE_ERROR", message: "down", status: 500 };
        return labFlowControl(group);
      }
    );
    const container = await render(
      <FlowWorkspace gateway={gateway} refreshMs={5000} />
    );
    await idle(container);
    expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull();
    expect(
      container.querySelector("[data-flow-control-empty]")?.textContent
    ).toMatch(/^Control document failed to load \(/u);
    fail = false;
    await click(button(container, "Refresh"));
    await idle(container);
    expect(container.querySelector("[data-flow-control-side]")).not.toBeNull();
    fail = true;
    await click(button(container, "Refresh"));
    await idle(container);
    expect(
      container.querySelector("[data-flow-control-error]")?.textContent
    ).toContain("Showing the document of");
  });

  it("shows operator access required when the control read is forbidden", async () => {
    const { gateway } = fixed(
      ({ minutes, symbol }) => labFlowSnapshot(symbol, minutes),
      () => {
        throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
      }
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(container.querySelector("[data-flow-controls]")).toBeNull()
    );
  });

  it("refreshes the control document on the timer", async () => {
    vi.useFakeTimers();
    const { controlCalls, gateway } = fixed(({ minutes, symbol }) =>
      labFlowSnapshot(symbol, minutes)
    );
    await render(<FlowWorkspace gateway={gateway} refreshMs={5000} />);
    await flush();
    expect(controlCalls).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(controlCalls).toHaveLength(2);
  });

  it("ignores a control answer that a newer request replaced", async () => {
    const pending: ((value: ReturnType<typeof labFlowControl>) => void)[] = [];
    const { gateway } = fixed(
      ({ minutes, symbol }) => labFlowSnapshot(symbol, minutes),
      ({ group }) =>
        group === "sp500"
          ? new Promise((resolve) => {
              pending.push(resolve);
            })
          : labFlowControl(group)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await click(button(container, "QQQ"));
    await idle(container);
    await act(async () => pending[0]?.(labFlowControl("sp500")));
    await flush();
    expect(
      container.querySelector("[data-flow-control]")?.textContent
    ).toContain("Nasdaq 100");
  });

  it("opens the freshness list when a source is stale and on request", async () => {
    const lab = labFlowSnapshot("SPY", 60);
    const fresh = {
      ...lab,
      freshness: lab.freshness.map((row) => ({
        ...row,
        state: "fresh" as const,
      })),
    };
    const { gateway } = fixed(() => fresh);
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await idle(container);
    expect(container.querySelector("[data-flow-all-fresh]")).not.toBeNull();
    expect(container.querySelectorAll("[data-flow-source]")).toHaveLength(0);
    const toggle = button(container, "Show sources");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(container.querySelectorAll("[data-flow-source]")).toHaveLength(4);
    await click(button(container, "Hide sources"));
    expect(container.querySelectorAll("[data-flow-source]")).toHaveLength(0);
  });

  it("uses the word agree only in the control panel", async () => {
    const { gateway } = fixed(({ minutes, symbol }) =>
      labFlowSnapshot(symbol, minutes)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await idle(container);
    const confluence = container
      .querySelector("[data-flow-confluence]")
      ?.closest("section, div");
    expect(confluence?.textContent?.toLowerCase()).not.toContain("agree");
    expect(
      container.querySelector("[data-flow-control]")?.textContent
    ).toContain("agreement");
  });
});

describe("FlowWorkspace tape speed panel", () => {
  const snapshots = ({ minutes, symbol }: FlowRequest) =>
    labFlowSnapshot(symbol, minutes);
  const panel = (container: HTMLElement) => {
    const found = container.querySelector("[data-flow-tape-speed]");
    if (found === null) throw new Error("no tape speed panel");
    return found;
  };
  const panelState = (container: HTMLElement) =>
    panel(container).getAttribute("data-flow-tape-state");
  const settled = (container: HTMLElement, state: string) =>
    vi.waitFor(() => expect(panelState(container)).toBe(state));
  const storageDown = () => {
    throw { code: "STORAGE_ERROR", message: "down", status: 503 };
  };

  it("asks for the future of the symbol's group and the selected window", async () => {
    const { gateway, tapeCalls } = fixed(snapshots);
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await settled(container, "document");
    expect(panel(container).getAttribute("data-flow-tape-speed")).toBe("ES");
    for (const symbol of ["ES", "QQQ", "NQ"]) {
      await click(button(container, symbol));
      await settled(container, "document");
    }
    const select = container.querySelector(
      "[data-flow-window]"
    ) as HTMLSelectElement;
    await act(async () => {
      select.value = "240";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settled(container, "document");
    expect(tapeCalls).toEqual([
      { minutes: 120, symbol: "ES" },
      { minutes: 120, symbol: "ES" },
      { minutes: 120, symbol: "NQ" },
      { minutes: 120, symbol: "NQ" },
      { minutes: 240, symbol: "NQ" },
    ]);
    expect(panel(container).getAttribute("data-flow-tape-speed")).toBe("NQ");
  });

  it("sits below the control panel and above the snapshot panels", async () => {
    const { gateway } = fixed(snapshots);
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await settled(container, "document");
    const blocks = [
      ...container.querySelectorAll(
        "[data-flow-control], [data-flow-tape-speed], [data-flow-snapshot]"
      ),
    ].map((block) =>
      ["data-flow-control", "data-flow-tape-speed", "data-flow-snapshot"].find(
        (name) => block.hasAttribute(name)
      )
    );
    expect(blocks).toEqual([
      "data-flow-control",
      "data-flow-tape-speed",
      "data-flow-snapshot",
    ]);
  });

  it("shows a failed read in its panel only, and recovers on refresh", async () => {
    let fail = true;
    const { gateway } = fixed(snapshots, undefined, (request) =>
      fail ? storageDown() : labFlowTapeSpeed(request.symbol, request.minutes)
    );
    const container = await render(
      <FlowWorkspace gateway={gateway} refreshMs={5000} />
    );
    await settled(container, "failed");
    expect(
      container.querySelector("[data-flow-tape-error]")?.textContent
    ).toMatch(
      /^Load failed \d{2}:\d{2} UTC · Tape speed not loaded: STORAGE_ERROR: down · retrying every 5 s$/u
    );
    // The other two reads are not affected.
    expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull();
    expect(container.querySelector("[data-flow-control-side]")).not.toBeNull();
    expect(container.querySelector("[data-flow-error]")).toBeNull();

    fail = false;
    await click(button(container, "Refresh"));
    await settled(container, "document");
    expect(container.querySelector("[data-flow-tape-error]")).toBeNull();

    // A later failure keeps the last document below the error line.
    fail = true;
    await click(button(container, "Refresh"));
    await settled(container, "failed");
    expect(container.querySelector("[data-flow-tape-chart]")).not.toBeNull();
  });

  it("does not hold the other panels back while its read never answers", async () => {
    const { gateway } = fixed(
      snapshots,
      undefined,
      () => new Promise<FlowTapeSpeed>(() => undefined)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(
        container
          .querySelector("[data-flow-state]")
          ?.getAttribute("data-flow-state")
      ).toBe("idle")
    );
    expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull();
    expect(container.querySelector("[data-flow-control-side]")).not.toBeNull();
    expect(panelState(container)).toBe("loading");
    expect(panel(container).textContent).toContain("Loading tape speed…");
  });

  it("shows operator access required when its read is forbidden", async () => {
    const { gateway } = fixed(snapshots, undefined, () => {
      throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
    });
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(
        container
          .querySelector("[data-operator-access]")
          ?.getAttribute("data-operator-feature")
      ).toBe("flow")
    );
  });

  it("loads again on the timer, and a late forbidden answer holds the access screen through the next refresh", async () => {
    vi.useFakeTimers();
    const answers: Array<{
      resolve: (document: FlowTapeSpeed) => void;
      reject: (reason: unknown) => void;
    }> = [];
    const { gateway, tapeCalls } = fixed(
      snapshots,
      undefined,
      () =>
        new Promise<FlowTapeSpeed>((resolve, reject) => {
          answers.push({ reject, resolve });
        })
    );
    const access = (container: HTMLElement) =>
      container
        .querySelector("[data-operator-access]")
        ?.getAttribute("data-operator-feature");
    const container = await render(
      <FlowWorkspace gateway={gateway} refreshMs={5000} />
    );
    await flush();
    await flush();
    // The snapshot and the control document are on the page; the tape speed read is still open.
    expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull();
    expect(panelState(container)).toBe("loading");
    await act(async () =>
      answers[0]?.reject({
        code: "FORBIDDEN",
        message: "Forbidden",
        status: 403,
      })
    );
    expect(access(container)).toBe("flow");
    // The timer starts the next load. Its snapshot answers first; the access screen stays.
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(tapeCalls).toHaveLength(2);
    expect(access(container)).toBe("flow");
    // A tape speed answer that succeeds ends the hold; the load after it shows the page again.
    await act(async () => answers[1]?.resolve(labFlowTapeSpeed("ES", 120)));
    expect(access(container)).toBe("flow");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(tapeCalls).toHaveLength(3);
    expect(access(container)).toBeUndefined();
    expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull();
    expect(panelState(container)).toBe("document");
  });

  it("ends the hold of a forbidden answer when the next tape speed answer fails for another reason", async () => {
    vi.useFakeTimers();
    let call = 0;
    const { gateway } = fixed(snapshots, undefined, () => {
      call += 1;
      if (call === 1)
        throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
      return storageDown();
    });
    const container = await render(
      <FlowWorkspace gateway={gateway} refreshMs={5000} />
    );
    await flush();
    await flush();
    expect(container.querySelector("[data-operator-access]")).not.toBeNull();
    // Access is back, and the tape speed read now fails with a storage fault: only its panel
    // shows the fault.
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(container.querySelector("[data-operator-access]")).toBeNull();
    expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull();
    expect(panelState(container)).toBe("failed");
  });

  it("keeps its document from SPY to ES and clears it for another future and for another window, also after a failure", async () => {
    let fail = false;
    const pending: ((value: FlowTapeSpeed) => void)[] = [];
    let hold = false;
    const { gateway } = fixed(snapshots, undefined, (request) => {
      if (fail) return storageDown();
      if (hold)
        return new Promise<FlowTapeSpeed>((resolve) => {
          pending.push(resolve);
        });
      return labFlowTapeSpeed(request.symbol, request.minutes);
    });
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await settled(container, "document");
    hold = true;
    // Same future: the document of ES stays while the new answer is on its way.
    await click(button(container, "ES"));
    expect(panelState(container)).toBe("document");
    // Another future: the panel goes back to loading.
    await click(button(container, "NQ"));
    expect(panelState(container)).toBe("loading");
    await act(async () => pending.at(-1)?.(labFlowTapeSpeed("NQ", 120)));
    await settled(container, "document");

    hold = false;
    fail = true;
    await click(button(container, "Refresh"));
    await settled(container, "failed");
    hold = true;
    fail = false;
    const select = container.querySelector(
      "[data-flow-window]"
    ) as HTMLSelectElement;
    await act(async () => {
      select.value = "60";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Another window: the failure and the document are cleared.
    expect(panelState(container)).toBe("loading");
    expect(container.querySelector("[data-flow-tape-error]")).toBeNull();
  });

  it("ignores an answer and a failure of a request that a newer one replaced", async () => {
    const pending: {
      resolve: (value: FlowTapeSpeed) => void;
      reject: (error: unknown) => void;
    }[] = [];
    const { gateway } = fixed(snapshots, undefined, ({ minutes, symbol }) =>
      symbol === "ES"
        ? new Promise<FlowTapeSpeed>((resolve, reject) => {
            pending.push({ reject, resolve });
          })
        : labFlowTapeSpeed(symbol, minutes)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await click(button(container, "NQ"));
    await settled(container, "document");
    expect(panel(container).getAttribute("data-flow-tape-speed")).toBe("NQ");
    // The answer for SPY (the ES tape) arrives late: NQ stays.
    await act(async () => pending[0]?.resolve(labFlowTapeSpeed("ES", 120)));
    await flush();
    expect(panel(container).textContent).toContain("Tape NQZ6");

    await click(button(container, "SPY"));
    await click(button(container, "NQ"));
    await settled(container, "document");
    // The request for SPY fails late: no error line appears.
    await act(async () => pending[1]?.reject(new Error("late failure")));
    await flush();
    expect(panelState(container)).toBe("document");
    expect(container.querySelector("[data-flow-tape-error]")).toBeNull();
  });
});

describe("FlowWorkspace hedging pressure panel", () => {
  const snapshots = ({ minutes, symbol }: FlowRequest) =>
    labFlowSnapshot(symbol, minutes);
  const panel = (container: HTMLElement) =>
    container.querySelector("[data-flow-hedging]");
  const panelState = (container: HTMLElement) =>
    panel(container)?.getAttribute("data-flow-hedging-state");
  const settled = (container: HTMLElement, state: string) =>
    vi.waitFor(() => expect(panelState(container)).toBe(state));
  const access = (container: HTMLElement) =>
    container
      .querySelector("[data-operator-access]")
      ?.getAttribute("data-operator-feature");
  const forbidden = { code: "FORBIDDEN", message: "Forbidden", status: 403 };
  const storageDown = () => {
    throw { code: "STORAGE_ERROR", message: "down", status: 503 };
  };
  const tapeSpeeds = ({ minutes, symbol }: TapeSpeedRequest) =>
    labFlowTapeSpeed(symbol, minutes);

  it("calls once per load for SPY and ES, never for QQQ and NQ, and has no panel for them", async () => {
    const { gateway, hedgingCalls } = fixed(snapshots);
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await settled(container, "response");
    expect(panel(container)?.getAttribute("data-flow-hedging")).toBe("SPY");
    expect(hedgingCalls).toEqual([{ symbol: "SPY" }]);
    await click(button(container, "Refresh"));
    await settled(container, "response");
    expect(hedgingCalls).toEqual([{ symbol: "SPY" }, { symbol: "SPY" }]);
    await click(button(container, "ES"));
    await settled(container, "response");
    expect(panel(container)?.getAttribute("data-flow-hedging")).toBe("ES");
    for (const symbol of ["QQQ", "NQ"]) {
      await click(button(container, symbol));
      await vi.waitFor(() =>
        expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull()
      );
      expect(panel(container)).toBeNull();
      expect(
        container.querySelector("[data-flow-not-collected]")?.textContent
      ).toContain("option prints");
    }
    expect(hedgingCalls).toEqual([
      { symbol: "SPY" },
      { symbol: "SPY" },
      { symbol: "ES" },
    ]);
  });

  it("sits below the tape speed panel and above the snapshot panels", async () => {
    const { gateway } = fixed(snapshots);
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await settled(container, "response");
    const names = [
      "data-flow-tape-speed",
      "data-flow-hedging",
      "data-flow-snapshot",
    ];
    const blocks = [
      ...container.querySelectorAll(
        names.map((name) => `[${name}]`).join(", ")
      ),
    ].map((block) => names.find((name) => block.hasAttribute(name)));
    expect(blocks).toEqual(names);
  });

  it("clears its response on a symbol change, and keeps it on a window change", async () => {
    let hold = false;
    const pending: ((value: FlowHedgingPressure) => void)[] = [];
    const { gateway } = fixed(snapshots, undefined, tapeSpeeds, ({ symbol }) =>
      hold
        ? new Promise<FlowHedgingPressure>((resolve) => {
            pending.push(resolve);
          })
        : labFlowHedgingPressure(symbol)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await settled(container, "response");
    hold = true;
    const select = container.querySelector(
      "[data-flow-window]"
    ) as HTMLSelectElement;
    await act(async () => {
      select.value = "240";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Another window: the response of the session stays while the new answer is on its way.
    expect(panelState(container)).toBe("response");
    await click(button(container, "ES"));
    expect(panelState(container)).toBe("loading");
    expect(panel(container)?.textContent).toContain(
      "Loading hedging pressure…"
    );
    await act(async () => pending.at(-1)?.(labFlowHedgingPressure("ES")));
    await settled(container, "response");
  });

  it("shows a failed read in its panel only, keeps the last response, and recovers on refresh", async () => {
    let fail = true;
    const { gateway } = fixed(snapshots, undefined, tapeSpeeds, ({ symbol }) =>
      fail ? storageDown() : labFlowHedgingPressure(symbol)
    );
    const container = await render(
      <FlowWorkspace gateway={gateway} refreshMs={5000} />
    );
    await settled(container, "failed");
    expect(
      container.querySelector("[data-flow-hedging-error]")?.textContent
    ).toMatch(
      /^Hedging pressure not loaded: STORAGE_ERROR: down · retrying with the next refresh at \d{2}:\d{2} ET$/u
    );
    // The other panels are not affected.
    expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull();
    expect(container.querySelector("[data-flow-control-side]")).not.toBeNull();
    expect(container.querySelector("[data-flow-tape-chart]")).not.toBeNull();
    expect(container.querySelector("[data-flow-error]")).toBeNull();
    expect(container.querySelector("[data-flow-tape-error]")).toBeNull();

    fail = false;
    await click(button(container, "Refresh"));
    await settled(container, "response");
    expect(container.querySelector("[data-flow-hedging-error]")).toBeNull();

    fail = true;
    await click(button(container, "Refresh"));
    await settled(container, "failed");
    expect(
      container.querySelector('[data-flow-hedging-chart="pressure"]')
    ).not.toBeNull();
  });

  it("shows operator access required for a forbidden answer, also when the snapshot answers later", async () => {
    let answer: (value: FlowSnapshot) => void = () => undefined;
    const { gateway } = fixed(
      () =>
        new Promise<FlowSnapshot>((resolve) => {
          answer = resolve;
        }),
      undefined,
      tapeSpeeds,
      () => {
        throw forbidden;
      }
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() => expect(access(container)).toBe("flow"));
    await act(async () => answer(labFlowSnapshot("SPY", 120)));
    await flush();
    expect(access(container)).toBe("flow");
  });

  it("does not end a tape speed hold with a later hedging answer that is not forbidden", async () => {
    vi.useFakeTimers();
    let tapeCall = 0;
    const { gateway, hedgingCalls } = fixed(
      snapshots,
      undefined,
      () => {
        tapeCall += 1;
        if (tapeCall === 1) throw forbidden;
        return new Promise<FlowTapeSpeed>(() => undefined);
      },
      ({ symbol }) => labFlowHedgingPressure(symbol)
    );
    const container = await render(
      <FlowWorkspace gateway={gateway} refreshMs={5000} />
    );
    await flush();
    await flush();
    expect(access(container)).toBe("flow");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(hedgingCalls).toHaveLength(2);
    expect(access(container)).toBe("flow");
  });

  it("ends its own hold on the next hedging answer that is not forbidden", async () => {
    vi.useFakeTimers();
    let call = 0;
    const { gateway } = fixed(
      snapshots,
      undefined,
      tapeSpeeds,
      ({ symbol }) => {
        call += 1;
        if (call === 1) throw forbidden;
        if (call === 2) return storageDown();
        return labFlowHedgingPressure(symbol);
      }
    );
    const container = await render(
      <FlowWorkspace gateway={gateway} refreshMs={5000} />
    );
    await flush();
    await flush();
    expect(access(container)).toBe("flow");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(access(container)).toBeUndefined();
    expect(panelState(container)).toBe("failed");
  });

  it("ignores an answer and a failure of a request that a newer one replaced", async () => {
    const pending: {
      resolve: (value: FlowHedgingPressure) => void;
      reject: (error: unknown) => void;
    }[] = [];
    const { gateway } = fixed(snapshots, undefined, tapeSpeeds, ({ symbol }) =>
      symbol === "SPY"
        ? new Promise<FlowHedgingPressure>((resolve, reject) => {
            pending.push({ reject, resolve });
          })
        : labFlowHedgingPressure(symbol)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await click(button(container, "ES"));
    await settled(container, "response");
    // The answer for SPY arrives late: ES stays.
    await act(async () => pending[0]?.resolve(labFlowHedgingPressure("SPY")));
    await flush();
    expect(panel(container)?.getAttribute("data-flow-hedging")).toBe("ES");
    expect(panel(container)?.textContent).toContain("SPX index price");

    await click(button(container, "SPY"));
    await click(button(container, "ES"));
    await settled(container, "response");
    // The request for SPY fails late: no error line appears.
    await act(async () => pending[1]?.reject(new Error("late failure")));
    await flush();
    expect(panelState(container)).toBe("response");
    expect(container.querySelector("[data-flow-hedging-error]")).toBeNull();
  });
});

describe("FlowWorkspace put/call ratio panel", () => {
  const snapshots = ({ minutes, symbol }: FlowRequest) =>
    labFlowSnapshot(symbol, minutes);
  const panel = (container: HTMLElement) =>
    container.querySelector("[data-flow-pcr]");
  const stateOf = (container: HTMLElement) =>
    panel(container)?.getAttribute("data-flow-pcr-state");
  const storageDown = () =>
    Promise.reject(
      Object.assign(new Error("down"), { code: "STORAGE_ERROR", status: 503 })
    );
  const denied = () =>
    Promise.reject(
      Object.assign(new Error("no"), { code: "FORBIDDEN", status: 403 })
    );

  it("loads SPY and ES, skips QQQ and NQ, and keeps the response on a window change", async () => {
    const { gateway, putCallCalls } = fixed(snapshots);
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() => expect(stateOf(container)).toBe("response"));
    expect(panel(container)?.getAttribute("data-flow-pcr")).toBe("SPY");
    expect(putCallCalls).toEqual([{ symbol: "SPY" }]);

    // Window change does not clear the put/call panel (it covers the full session and days).
    const select =
      container.querySelector<HTMLSelectElement>("[data-flow-window]");
    await act(async () => {
      if (select !== null) {
        select.value = "60";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await vi.waitFor(() => expect(putCallCalls).toHaveLength(2));
    expect(stateOf(container)).toBe("response");

    await click(button(container, "ES"));
    await vi.waitFor(() =>
      expect(panel(container)?.getAttribute("data-flow-pcr")).toBe("ES")
    );
    await vi.waitFor(() => expect(stateOf(container)).toBe("response"));

    await click(button(container, "QQQ"));
    await vi.waitFor(() => expect(panel(container)).toBeNull());
    await click(button(container, "NQ"));
    await vi.waitFor(() => expect(panel(container)).toBeNull());
    expect(putCallCalls).toEqual([
      { symbol: "SPY" },
      { symbol: "SPY" },
      { symbol: "ES" },
    ]);
  });

  it("shows loading and failure with retry recovery", async () => {
    let fail = true;
    const { gateway } = fixed(
      snapshots,
      undefined,
      undefined,
      undefined,
      ({ symbol }) => (fail ? storageDown() : labFlowPutCallRatio(symbol))
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() => expect(stateOf(container)).toBe("failed"));
    expect(
      container.querySelector("[data-flow-pcr-error]")?.textContent
    ).toMatch(
      /^Put\/call ratio not loaded: STORAGE_ERROR: down · retrying with the next refresh at \d{2}:\d{2} ET$/u
    );

    fail = false;
    await click(button(container, "Refresh"));
    await vi.waitFor(() => expect(stateOf(container)).toBe("response"));
    expect(container.querySelector("[data-flow-pcr-error]")).toBeNull();
  });

  it("ignores stale put/call resolutions after switching symbols", async () => {
    const pending: Array<{
      resolve: (value: FlowPutCallRatio) => void;
      reject: (reason: unknown) => void;
    }> = [];
    const { gateway: slowGateway } = fixed(
      snapshots,
      undefined,
      undefined,
      undefined,
      ({ symbol }) =>
        symbol === "SPY"
          ? new Promise<FlowPutCallRatio>((resolve, reject) => {
              pending.push({ reject, resolve });
            })
          : labFlowPutCallRatio(symbol)
    );
    const slowContainer = await render(<FlowWorkspace gateway={slowGateway} />);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await click(button(slowContainer, "ES"));
    await vi.waitFor(() => expect(stateOf(slowContainer)).toBe("response"));
    await act(async () => pending[0]?.resolve(labFlowPutCallRatio("SPY")));
    expect(panel(slowContainer)?.getAttribute("data-flow-pcr")).toBe("ES");
  });

  it("ignores stale put/call rejections after switching symbols", async () => {
    const pending: Array<{
      resolve: (value: FlowPutCallRatio) => void;
      reject: (reason: unknown) => void;
    }> = [];
    const { gateway: rejectGateway } = fixed(
      snapshots,
      undefined,
      undefined,
      undefined,
      ({ symbol }) =>
        symbol === "SPY"
          ? new Promise<FlowPutCallRatio>((resolve, reject) => {
              pending.push({ reject, resolve });
            })
          : labFlowPutCallRatio(symbol)
    );
    const rejectContainer = await render(
      <FlowWorkspace gateway={rejectGateway} />
    );
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await click(button(rejectContainer, "ES"));
    await vi.waitFor(() => expect(stateOf(rejectContainer)).toBe("response"));
    await act(async () => pending[0]?.reject(new Error("late failure")));
    expect(rejectContainer.querySelector("[data-flow-pcr-error]")).toBeNull();
  });

  it("holds the operator access screen across a later snapshot resolution and clears it on a non-forbidden put/call answer", async () => {
    vi.useFakeTimers();
    let forbid = true;
    let resolveSnapshot: ((value: FlowSnapshot) => void) | null = null;
    const { gateway, putCallCalls } = fixed(
      ({ minutes, symbol }) =>
        resolveSnapshot === null && forbid
          ? new Promise<FlowSnapshot>((resolve) => {
              resolveSnapshot = resolve;
            })
          : labFlowSnapshot(symbol, minutes),
      undefined,
      undefined,
      undefined,
      ({ symbol }) => (forbid ? denied() : labFlowPutCallRatio(symbol))
    );
    const container = await render(
      <FlowWorkspace gateway={gateway} refreshMs={5000} />
    );
    await act(async () => void (await Promise.resolve()));
    expect(container.textContent).toContain("Operator access");
    // A late non-forbidden snapshot answer must NOT clear the putCallForbidden hold.
    await act(async () => resolveSnapshot?.(labFlowSnapshot("SPY", 120)));
    expect(container.textContent).toContain("Operator access");
    expect(panel(container)).toBeNull();

    // Next refresh returns a non-forbidden put/call answer and releases the hold.
    forbid = false;
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(putCallCalls).toHaveLength(2);
    expect(stateOf(container)).toBe("response");
  });
});

describe("FlowWorkspace liquidity heatmap", () => {
  it("loads the group future, isolates errors, ignores stale responses, holds forbidden access, and resets on group or window change", async () => {
    const snapshots = ({ minutes, symbol }: FlowRequest) =>
      labFlowSnapshot(symbol, minutes);
    const pending: Array<{
      reject: (reason: unknown) => void;
      resolve: (doc: FlowLiquidityHeatmap) => void;
    }> = [];
    const { gateway, heatmapCalls } = fixed(
      snapshots,
      undefined,
      undefined,
      undefined,
      undefined,
      () =>
        new Promise<FlowLiquidityHeatmap>((resolve, reject) => {
          pending.push({ reject, resolve });
        })
    );

    const container = await render(<FlowWorkspace gateway={gateway} />);
    expect(heatmapCalls).toEqual([{ minutes: 120, symbol: "ES" }]);

    // Switch to 15 min window before first resolves: stale resolve and stale reject must be ignored
    const select =
      container.querySelector<HTMLSelectElement>("[data-flow-window]");
    expect(select).not.toBeNull();
    await act(async () => {
      if (select) {
        select.value = "15";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(heatmapCalls).toEqual([
      { minutes: 120, symbol: "ES" },
      { minutes: 15, symbol: "ES" },
    ]);

    // First request resolves stale -> ignored
    await act(async () =>
      pending[0]?.resolve(labFlowLiquidityHeatmap("ES", 120))
    );
    expect(
      container
        .querySelector("[data-flow-heatmap]")
        ?.getAttribute("data-flow-heatmap-state")
    ).toBe("loading");

    // Second request fails with non-forbidden error -> isolated to heatmap panel only
    await act(async () => pending[1]?.reject(new Error("heatmap offline")));
    expect(
      container
        .querySelector("[data-flow-heatmap]")
        ?.getAttribute("data-flow-heatmap-state")
    ).toBe("failed");
    expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull();

    // Switch SPY -> ES (same group): refresh fires, resolves ok
    await click(button(container, "ES"));
    await act(async () =>
      pending[2]?.resolve(labFlowLiquidityHeatmap("ES", 15))
    );
    expect(
      container
        .querySelector("[data-flow-heatmap]")
        ?.getAttribute("data-flow-heatmap-state")
    ).toBe("document");

    // Switch ES -> NQ (new group): clears previous document, stale reject ignored
    await click(button(container, "NQ"));
    expect(
      container
        .querySelector("[data-flow-heatmap]")
        ?.getAttribute("data-flow-heatmap-state")
    ).toBe("loading");

    // Switch NQ -> QQQ before pending[3] settles, then reject pending[3] stale -> ignored
    await click(button(container, "QQQ"));
    await act(async () => pending[3]?.reject(new Error("stale failure")));
    expect(
      container
        .querySelector("[data-flow-heatmap]")
        ?.getAttribute("data-flow-heatmap-state")
    ).toBe("loading");

    // Forbidden error on latest request shows OperatorAccessRequired
    await act(async () =>
      pending[4]?.reject({ code: "FORBIDDEN", message: "operator required" })
    );
    expect(container.textContent).toContain("Operator access");
  });
});

describe("FlowWorkspace strike heatmap", () => {
  const snapshots = ({ minutes, symbol }: FlowRequest) =>
    labFlowSnapshot(symbol, minutes);
  const panel = (container: HTMLElement) =>
    container.querySelector("[data-flow-strike-heatmap]");
  const stateOf = (container: HTMLElement) =>
    panel(container)?.getAttribute("data-flow-strike-heatmap-state");
  const storageDown = () =>
    Promise.reject(
      Object.assign(new Error("down"), { code: "STORAGE_ERROR", status: 503 })
    );
  const denied = () =>
    Promise.reject(
      Object.assign(new Error("no"), { code: "FORBIDDEN", status: 403 })
    );

  it("loads SPY and ES, skips QQQ and NQ, and switches bucket width without refetching other panels", async () => {
    const { calls, gateway, strikeHeatmapCalls, putCallCalls } =
      fixed(snapshots);
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() => expect(stateOf(container)).toBe("response"));
    expect(panel(container)?.getAttribute("data-flow-strike-heatmap")).toBe(
      "SPY"
    );
    expect(strikeHeatmapCalls).toEqual([{ bucketMinutes: 15, symbol: "SPY" }]);
    expect(calls).toHaveLength(1);
    expect(putCallCalls).toHaveLength(1);

    // Switching bucket width to 5m refetches ONLY flow.strikeHeatmap.
    const btn5 = container.querySelector<HTMLButtonElement>(
      '[data-flow-strike-heatmap-bucket="5"]'
    );
    if (btn5 === null) throw new Error("Missing 5m bucket button");
    await click(btn5);
    await vi.waitFor(() => expect(strikeHeatmapCalls).toHaveLength(2));
    expect(strikeHeatmapCalls[1]).toEqual({ bucketMinutes: 5, symbol: "SPY" });
    expect(calls).toHaveLength(1);
    expect(putCallCalls).toHaveLength(1);

    // Switching to ES retains the chosen 5m bucket width.
    await click(button(container, "ES"));
    await vi.waitFor(() =>
      expect(panel(container)?.getAttribute("data-flow-strike-heatmap")).toBe(
        "ES"
      )
    );
    await vi.waitFor(() => expect(stateOf(container)).toBe("response"));
    expect(strikeHeatmapCalls[2]).toEqual({ bucketMinutes: 5, symbol: "ES" });

    // QQQ and NQ have no option prints: panel hides and no call is made.
    await click(button(container, "QQQ"));
    await vi.waitFor(() => expect(panel(container)).toBeNull());
    await click(button(container, "NQ"));
    await vi.waitFor(() => expect(panel(container)).toBeNull());
    expect(strikeHeatmapCalls).toHaveLength(3);
  });

  it("retries independently without refetching other panels", async () => {
    let fail = true;
    const { calls, gateway, strikeHeatmapCalls } = fixed(
      snapshots,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ({ bucketMinutes, symbol }) =>
        fail ? storageDown() : compactStrikeHeatmap(symbol, bucketMinutes)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() => expect(stateOf(container)).toBe("failed"));
    expect(
      container.querySelector("[data-flow-strike-heatmap-error]")?.textContent
    ).toContain("STORAGE_ERROR");
    const callsBeforeRetry = calls.length;

    // Panel Retry refetches ONLY flow.strikeHeatmap.
    fail = false;
    const retryBtn = container.querySelector<HTMLButtonElement>(
      "[data-flow-strike-heatmap-retry]"
    );
    if (retryBtn === null) throw new Error("Missing heatmap Retry button");
    await click(retryBtn);
    await vi.waitFor(() => expect(stateOf(container)).toBe("response"));
    expect(
      container.querySelector("[data-flow-strike-heatmap-error]")
    ).toBeNull();
    expect(calls).toHaveLength(callsBeforeRetry);
    expect(strikeHeatmapCalls).toHaveLength(2);
  });

  it("ignores stale resolutions and rejections after switching bucket width", async () => {
    const pending: Array<{
      resolve: (value: FlowStrikeHeatmap) => void;
      reject: (reason: unknown) => void;
    }> = [];
    const { gateway: slowGateway } = fixed(
      snapshots,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ({ bucketMinutes, symbol }) =>
        bucketMinutes === 5
          ? new Promise<FlowStrikeHeatmap>((resolve, reject) => {
              pending.push({ reject, resolve });
            })
          : compactStrikeHeatmap(symbol, bucketMinutes)
    );
    const slowContainer = await render(<FlowWorkspace gateway={slowGateway} />);
    await vi.waitFor(() => expect(stateOf(slowContainer)).toBe("response"));
    const slowBtn5 = slowContainer.querySelector<HTMLButtonElement>(
      '[data-flow-strike-heatmap-bucket="5"]'
    );
    const slowBtn30 = slowContainer.querySelector<HTMLButtonElement>(
      '[data-flow-strike-heatmap-bucket="30"]'
    );
    if (slowBtn5 === null || slowBtn30 === null)
      throw new Error("Missing bucket buttons");
    await click(slowBtn5);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await click(slowBtn30);
    await vi.waitFor(() =>
      expect(
        slowContainer.querySelector("[data-flow-strike-heatmap-header]")
          ?.textContent
      ).toContain("30m slots")
    );
    await act(async () => pending[0]?.resolve(compactStrikeHeatmap("SPY", 5)));
    expect(
      slowContainer.querySelector("[data-flow-strike-heatmap-header]")
        ?.textContent
    ).toContain("30m slots");

    // Stale rejection ignored too
    await click(slowBtn5);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await click(slowBtn30);
    await vi.waitFor(() => expect(stateOf(slowContainer)).toBe("response"));
    await act(async () => pending[1]?.reject(new Error("late failure")));
    expect(
      slowContainer.querySelector("[data-flow-strike-heatmap-error]")
    ).toBeNull();
  });

  it("holds the operator access screen across a later snapshot resolution and clears it on a non-forbidden heatmap answer", async () => {
    vi.useFakeTimers();
    let forbid = true;
    let resolveSnapshot: ((value: FlowSnapshot) => void) | null = null;
    const { gateway, strikeHeatmapCalls } = fixed(
      ({ minutes, symbol }) =>
        resolveSnapshot === null && forbid
          ? new Promise<FlowSnapshot>((resolve) => {
              resolveSnapshot = resolve;
            })
          : labFlowSnapshot(symbol, minutes),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ({ bucketMinutes, symbol }) =>
        forbid ? denied() : compactStrikeHeatmap(symbol, bucketMinutes)
    );
    const container = await render(
      <FlowWorkspace gateway={gateway} refreshMs={5000} />
    );
    await act(async () => void (await Promise.resolve()));
    expect(container.textContent).toContain("Operator access");
    await act(async () => resolveSnapshot?.(labFlowSnapshot("SPY", 120)));
    expect(container.textContent).toContain("Operator access");
    expect(panel(container)).toBeNull();

    forbid = false;
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(strikeHeatmapCalls).toHaveLength(2);
    expect(stateOf(container)).toBe("response");
  });

  it("discards a late SPY heatmap response after switching to ES", async () => {
    let resolveSpy: ((value: FlowStrikeHeatmap) => void) | null = null;
    let resolveEs: ((value: FlowStrikeHeatmap) => void) | null = null;
    const { gateway } = fixed(
      snapshots,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ({ symbol }) =>
        new Promise<FlowStrikeHeatmap>((resolve) => {
          if (symbol === "SPY") resolveSpy = resolve;
          else resolveEs = resolve;
        })
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() => expect(resolveSpy).not.toBeNull());
    await click(button(container, "ES"));
    await vi.waitFor(() => expect(resolveEs).not.toBeNull());
    await act(async () => resolveSpy?.(compactStrikeHeatmap("SPY", 15)));
    expect(stateOf(container)).toBe("loading");
    expect(panel(container)?.textContent).not.toContain("SPY strike");
    await act(async () => resolveEs?.(compactStrikeHeatmap("ES", 15)));
    await vi.waitFor(() => expect(stateOf(container)).toBe("response"));
    expect(panel(container)?.getAttribute("data-flow-strike-heatmap")).toBe(
      "ES"
    );
    expect(panel(container)?.textContent).toContain("SPX strike");
  });
});

describe("FlowWorkspace option print bubbles", () => {
  const snapshots = ({ minutes, symbol }: FlowRequest) =>
    labFlowSnapshot(symbol, minutes);
  const panel = (container: HTMLElement) =>
    container.querySelector("[data-flow-option-bubbles]");
  const stateOf = (container: HTMLElement) =>
    panel(container)?.getAttribute("data-flow-option-bubbles-state");
  const storageDown = () =>
    Promise.reject(
      Object.assign(new Error("down"), { code: "STORAGE_ERROR", status: 503 })
    );
  const denied = () =>
    Promise.reject(
      Object.assign(new Error("no"), { code: "FORBIDDEN", status: 403 })
    );

  it("loads SPY and ES, skips QQQ and NQ, and switches premium floor without refetching other panels", async () => {
    const { calls, gateway, optionBubblesCalls, putCallCalls } =
      fixed(snapshots);
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() => expect(stateOf(container)).toBe("response"));
    expect(panel(container)?.getAttribute("data-flow-option-bubbles")).toBe(
      "SPY"
    );
    expect(optionBubblesCalls).toEqual([
      { minPremiumUsd: 250_000, symbol: "SPY" },
    ]);
    expect(calls).toHaveLength(1);
    expect(putCallCalls).toHaveLength(1);

    // Switching premium floor to $500K refetches ONLY flow.optionBubbles.
    const btn500k = container.querySelector<HTMLButtonElement>(
      '[data-flow-option-bubbles-floor="500000"]'
    );
    if (btn500k === null) throw new Error("Missing $500K floor button");
    await click(btn500k);
    await vi.waitFor(() => expect(optionBubblesCalls).toHaveLength(2));
    expect(optionBubblesCalls[1]).toEqual({
      minPremiumUsd: 500_000,
      symbol: "SPY",
    });
    expect(calls).toHaveLength(1);
    expect(putCallCalls).toHaveLength(1);

    // Switching to ES retains the chosen $500K floor.
    await click(button(container, "ES"));
    await vi.waitFor(() =>
      expect(panel(container)?.getAttribute("data-flow-option-bubbles")).toBe(
        "ES"
      )
    );
    await vi.waitFor(() => expect(stateOf(container)).toBe("response"));
    expect(optionBubblesCalls[2]).toEqual({
      minPremiumUsd: 500_000,
      symbol: "ES",
    });

    // QQQ and NQ have no option prints: panel hides and no call is made.
    await click(button(container, "QQQ"));
    await vi.waitFor(() => expect(panel(container)).toBeNull());
    await click(button(container, "NQ"));
    await vi.waitFor(() => expect(panel(container)).toBeNull());
    expect(optionBubblesCalls).toHaveLength(3);
  });

  it("retries independently, ignores stale answers and rejections, holds forbidden access, and discards late SPY answers on ES", async () => {
    let fail = true;
    const { calls, gateway, optionBubblesCalls } = fixed(
      snapshots,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ({ minPremiumUsd, symbol }) =>
        fail ? storageDown() : compactOptionBubbles(symbol, minPremiumUsd)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() => expect(stateOf(container)).toBe("failed"));
    expect(
      container.querySelector("[data-flow-option-bubbles-error]")?.textContent
    ).toContain("STORAGE_ERROR");
    const callsBeforeRetry = calls.length;

    fail = false;
    const retryBtn = container.querySelector<HTMLButtonElement>(
      "[data-flow-option-bubbles-retry]"
    );
    if (retryBtn === null) throw new Error("Missing bubbles Retry button");
    await click(retryBtn);
    await vi.waitFor(() => expect(stateOf(container)).toBe("response"));
    expect(
      container.querySelector("[data-flow-option-bubbles-error]")
    ).toBeNull();
    expect(calls).toHaveLength(callsBeforeRetry);
    expect(optionBubblesCalls).toHaveLength(2);

    // Stale resolution and rejection ignored when a newer floor request succeeds
    const pending: {
      resolve: (value: FlowOptionBubbles) => void;
      reject: (reason: unknown) => void;
    }[] = [];
    const { gateway: slowGateway } = fixed(
      snapshots,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ({ minPremiumUsd, symbol }) =>
        minPremiumUsd === 100_000
          ? new Promise<FlowOptionBubbles>((resolve, reject) => {
              pending.push({ reject, resolve });
            })
          : compactOptionBubbles(symbol, minPremiumUsd)
    );
    const slowContainer = await render(<FlowWorkspace gateway={slowGateway} />);
    await vi.waitFor(() => expect(stateOf(slowContainer)).toBe("response"));
    const btn100k = slowContainer.querySelector<HTMLButtonElement>(
      '[data-flow-option-bubbles-floor="100000"]'
    );
    const btn1m = slowContainer.querySelector<HTMLButtonElement>(
      '[data-flow-option-bubbles-floor="1000000"]'
    );
    if (btn100k === null || btn1m === null)
      throw new Error("Missing floor buttons");
    await click(btn100k);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await click(btn1m);
    await vi.waitFor(() =>
      expect(panel(slowContainer)?.textContent).toContain("floor >= $1M")
    );
    await act(async () =>
      pending[0]?.resolve(compactOptionBubbles("SPY", 100_000))
    );
    expect(panel(slowContainer)?.textContent).toContain("floor >= $1M");

    await click(btn100k);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await click(btn1m);
    await vi.waitFor(() => expect(stateOf(slowContainer)).toBe("response"));
    await act(async () => pending[1]?.reject(new Error("late failure")));
    expect(
      slowContainer.querySelector("[data-flow-option-bubbles-error]")
    ).toBeNull();
  });

  it("holds the operator access screen across a later snapshot resolution and clears on a non-forbidden bubbles answer", async () => {
    vi.useFakeTimers();
    let forbid = true;
    let resolveSnapshot: ((value: FlowSnapshot) => void) | null = null;
    const { gateway, optionBubblesCalls } = fixed(
      ({ minutes, symbol }) =>
        resolveSnapshot === null && forbid
          ? new Promise<FlowSnapshot>((resolve) => {
              resolveSnapshot = resolve;
            })
          : labFlowSnapshot(symbol, minutes),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ({ minPremiumUsd, symbol }) =>
        forbid ? denied() : compactOptionBubbles(symbol, minPremiumUsd)
    );
    const container = await render(
      <FlowWorkspace gateway={gateway} refreshMs={5000} />
    );
    await act(async () => void (await Promise.resolve()));
    expect(container.textContent).toContain("Operator access");
    await act(async () => resolveSnapshot?.(labFlowSnapshot("SPY", 120)));
    expect(container.textContent).toContain("Operator access");
    expect(panel(container)).toBeNull();

    forbid = false;
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(optionBubblesCalls).toHaveLength(2);
    expect(stateOf(container)).toBe("response");
  });
});

describe("FlowWorkspace trade bubbles", () => {
  const snapshots = ({ minutes, symbol }: FlowRequest) =>
    labFlowSnapshot(symbol, minutes);
  const storageDown = () =>
    Promise.reject(
      Object.assign(new Error("down"), { code: "STORAGE_ERROR", status: 503 })
    );
  const denied = () =>
    Promise.reject(
      Object.assign(new Error("no"), { code: "FORBIDDEN", status: 403 })
    );

  it("loads ES for SPY, isolates errors, ignores stale responses, and honors forbidden holds", async () => {
    const { gateway, tradeBubblesCalls } = fixed(
      snapshots,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ({ minutes, symbol }) => labFlowTradeBubbles(symbol, minutes)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(
        container.querySelector("[data-flow-trade-bubbles-svg]")
      ).not.toBeNull()
    );
    expect(tradeBubblesCalls).toEqual([{ minutes: 120, symbol: "ES" }]);

    // Error isolation: a tradeBubbles error does not break other panels.
    const broken = fixed(
      snapshots,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => storageDown()
    );
    const errContainer = await render(
      <FlowWorkspace gateway={broken.gateway} />
    );
    await vi.waitFor(() =>
      expect(
        errContainer.querySelector("[data-flow-trade-bubbles-error]")
      ).not.toBeNull()
    );
    expect(errContainer.querySelector("[data-flow-snapshot]")).not.toBeNull();

    // Stale response and stale rejection ignored after switching symbols.
    const pending: Array<{
      resolve: (value: FlowTradeBubbles) => void;
      reject: (reason: unknown) => void;
    }> = [];
    const slow = fixed(
      snapshots,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ({ minutes, symbol }) =>
        symbol === "ES"
          ? new Promise<FlowTradeBubbles>((resolve, reject) => {
              pending.push({ reject, resolve });
            })
          : labFlowTradeBubbles(symbol, minutes)
    );
    const slowContainer = await render(
      <FlowWorkspace gateway={slow.gateway} />
    );
    await click(button(slowContainer, "NQ"));
    await vi.waitFor(() =>
      expect(
        slowContainer.querySelector("[data-flow-trade-bubbles]")?.textContent
      ).toContain("Big futures trades (NQ)")
    );
    await act(async () => pending[0]?.resolve(labFlowTradeBubbles("ES", 120)));
    await flush();
    expect(
      slowContainer.querySelector("[data-flow-trade-bubbles]")?.textContent
    ).toContain("Big futures trades (NQ)");

    await click(button(slowContainer, "ES"));
    await click(button(slowContainer, "NQ"));
    await vi.waitFor(() =>
      expect(
        slowContainer.querySelector("[data-flow-trade-bubbles]")?.textContent
      ).toContain("Big futures trades (NQ)")
    );
    await act(async () => pending[1]?.reject(new Error("late failure")));
    await flush();
    expect(
      slowContainer.querySelector("[data-flow-trade-bubbles-error]")
    ).toBeNull();

    // Forbidden hold keeps operator access screen even when snapshot resolves after it.
    let resolveSnap: ((value: FlowSnapshot) => void) | null = null;
    const forbidden = fixed(
      () =>
        new Promise<FlowSnapshot>((resolve) => {
          resolveSnap = resolve;
        }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => denied()
    );
    const forbContainer = await render(
      <FlowWorkspace gateway={forbidden.gateway} />
    );
    await vi.waitFor(() =>
      expect(forbContainer.textContent).toContain("Operator access")
    );
    await act(async () => resolveSnap?.(labFlowSnapshot("SPY", 120)));
    expect(forbContainer.textContent).toContain("Operator access");
  });
});
