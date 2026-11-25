// @vitest-environment jsdom
import type { FlowTradeBubble, FlowTradeBubbles } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  FlowTradeBubblesPanel,
  type FlowTradeBubblesPanelProps,
} from "./flow-trade-bubbles-panel.tsx";

const makeBubble = (over: Partial<FlowTradeBubble> = {}): FlowTradeBubble => ({
  capture: "streamed",
  limitSize: 40,
  price: 6012.25,
  second: "2026-11-23T14:32:10.000Z",
  seq: 0,
  side: "buy",
  signing: "quote",
  size: 80,
  sizeMultiple: 2,
  ...over,
});

const sampleDocument = (
  over: Partial<FlowTradeBubbles> = {}
): FlowTradeBubbles => {
  const buy = makeBubble({
    price: 6011.5,
    second: "2026-11-23T14:15:05.000Z",
    seq: 0,
    side: "buy",
    size: 60,
    sizeMultiple: 1.5,
  });
  const sell = makeBubble({
    capture: "sampled",
    price: 6014.25,
    second: "2026-11-23T14:40:20.000Z",
    seq: 1,
    side: "sell",
    signing: "tick",
    size: 160,
    sizeMultiple: 4,
  });
  return {
    bubbles: [buy, sell],
    candles: [
      {
        close: 6012,
        coveredSeconds: 60,
        high: 6012.5,
        low: 6010.75,
        minute: "2026-11-23T14:15:00.000Z",
        open: 6011,
        volume: 1200,
        vwap: 6011.6,
      },
      {
        close: 6012,
        coveredSeconds: 60,
        high: 6013,
        low: 6011.5,
        minute: "2026-11-23T14:30:00.000Z",
        open: 6012,
        volume: 950,
        vwap: 6012.1,
      },
      {
        close: 6013,
        coveredSeconds: 60,
        high: 6014.5,
        low: 6012.5,
        minute: "2026-11-23T14:40:00.000Z",
        open: 6014,
        volume: 1600,
        vwap: 6013.4,
      },
    ],
    captureMode: "streamed",
    minutes: 60,
    priceRange: { max: 6014.5, min: 6010.75 },
    rules: {
      deepTradeLimit: 40,
      deepTradeLimitMeasuredOn: "2026-11-13",
      maxBubbles: 500,
      retentionDays: 730,
      version: "trade-bubbles.v1",
    },
    schemaVersion: "flow-trade-bubbles.v1",
    symbol: "ES",
    tape: {
      ageSeconds: 9,
      lastOkAt: "2026-11-23T14:59:51.000Z",
      lastStatus: "ok",
      message: null,
      sessionOpen: true,
      source: "ticks",
      state: "fresh",
    },
    tickSize: 0.25,
    totals: {
      buyTrades: 1,
      buyVolume: 60,
      largestBubble: sell,
      maxSize: 160,
      netVolume: -100,
      p95Size: 160,
      sellTrades: 1,
      sellVolume: 160,
      shownTrades: 2,
      totalTrades: 2,
      truncated: false,
    },
    windowEnd: "2026-11-23T15:00:00.000Z",
    windowStart: "2026-11-23T14:00:00.000Z",
    ...over,
  };
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const renderPanel = (props: FlowTradeBubblesPanelProps) => {
  if (container === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(<FlowTradeBubblesPanel {...props} />);
  });
  return container;
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("FlowTradeBubblesPanel", () => {
  it("renders loading and error states cleanly without a document", () => {
    const el = renderPanel({
      document: null,
      failure: null,
      refreshMs: 60_000,
      symbol: "SPY",
    });
    expect(el.textContent).toContain("Big futures trades (ES · SPY group)");
    expect(
      el.querySelector("[data-flow-trade-bubbles-loading]")
    ).not.toBeNull();

    renderPanel({
      document: null,
      failure: {
        code: "STORAGE_ERROR",
        failedAt: Date.parse("2026-11-23T15:00:00.000Z"),
        message: "database timeout",
      },
      refreshMs: 60_000,
      symbol: "ES",
    });
    expect(
      el.querySelector("[data-flow-trade-bubbles-error]")?.textContent
    ).toContain("Big futures trades not loaded: database timeout");
    expect(el.querySelector("[data-flow-trade-bubbles-loading]")).toBeNull();
  });

  it("renders candles, VWAP, buy/sell bubbles, truncation notice, and stale refresh error", () => {
    const doc = sampleDocument({
      totals: {
        ...sampleDocument().totals,
        buyTrades: 300,
        buyVolume: 18_500,
        netVolume: 2500,
        sellTrades: 300,
        sellVolume: 16_000,
        shownTrades: 2,
        totalTrades: 600,
        truncated: true,
      },
    });
    const el = renderPanel({
      document: doc,
      failure: {
        code: "STORAGE_ERROR",
        failedAt: Date.parse("2026-11-23T15:01:00.000Z"),
        message: "temporary blip",
      },
      refreshMs: 60_000,
      symbol: "ES",
    });

    expect(
      el.querySelector("[data-flow-trade-bubbles-error]")?.textContent
    ).toContain("Refresh failed: temporary blip");
    expect(el.textContent).not.toMatch(/E[SD]T ET|ET ET/);
    expect(
      el.querySelector("[data-flow-trade-bubbles-summary]")?.textContent
    ).toContain("18.5K");
    expect(
      el.querySelector("[data-flow-trade-bubbles-truncated]")?.textContent
    ).toContain("largest 2 of 600");
    expect(
      el.querySelector("[data-flow-trade-bubbles-truncated]")?.textContent
    ).toContain("totals cover all stored prints");
    expect(el.querySelectorAll("[data-flow-trade-bubbles-candle]").length).toBe(
      3
    );
    expect(el.querySelector("[data-flow-trade-bubbles-vwap]")).not.toBeNull();
    expect(el.querySelector("[data-flow-trade-bubbles-close]")).not.toBeNull();
    expect(el.querySelectorAll("[data-flow-trade-bubble]").length).toBe(2);
    expect(el.querySelectorAll("[data-flow-trade-bubble-row]").length).toBe(2);

    // Filtering a truncated window updates the truncation caveat to clarify subset totals.
    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[data-flow-trade-bubbles-side="buy"]'
      )?.click();
    });
    expect(
      el.querySelector("[data-flow-trade-bubbles-truncated]")?.textContent
    ).toContain("filtered totals cover only the returned top 2 prints");
  });

  it("supports side and size filtering, bubble & table selection, keyboard navigation, and empty states", () => {
    const doc = sampleDocument();
    const el = renderPanel({
      document: doc,
      failure: null,
      refreshMs: 60_000,
      symbol: "ES",
    });
    // Slider ARIA invariants hold when unselected (0 <= valuenow <= valuemax).
    const initialSlider = el.querySelector<HTMLDivElement>(
      "[data-flow-trade-bubbles-interactive]"
    );
    expect(initialSlider?.getAttribute("aria-valuemin")).toBe("0");
    expect(initialSlider?.getAttribute("aria-valuenow")).toBe("0");
    expect(initialSlider?.getAttribute("aria-valuemax")).toBe("2");
    expect(initialSlider?.getAttribute("aria-valuetext")).toBe(
      "No print selected"
    );

    // Click a bubble in SVG -> pins inspector + crosshair.
    const buyBubble = el.querySelector<SVGGElement>(
      '[data-flow-trade-bubble="buy"]'
    );
    act(() => {
      buyBubble?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      el.querySelector("[data-flow-trade-bubbles-inspector]")?.textContent
    ).toContain("Buy 60 contracts");
    expect(
      el.querySelector("[data-flow-trade-bubbles-crosshair]")
    ).not.toBeNull();

    // Clicking chart background outside any bubble keeps selection unchanged.
    const slider = el.querySelector<HTMLDivElement>(
      "[data-flow-trade-bubbles-interactive]"
    );
    expect(slider).not.toBeNull();
    act(() => {
      slider?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      el.querySelector("[data-flow-trade-bubbles-crosshair]")
    ).not.toBeNull();

    // Keyboard navigation on slider: ArrowRight, ArrowLeft, Home, End, unrelated key, Escape.
    for (const key of [
      "ArrowRight",
      "ArrowLeft",
      "End",
      "Home",
      "Tab",
      "Escape",
    ]) {
      act(() => {
        slider?.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
        );
      });
    }
    expect(el.querySelector("[data-flow-trade-bubbles-crosshair]")).toBeNull();

    // Select via table row, then clear selection button.
    const sellRow = el.querySelector<HTMLButtonElement>(
      'button[data-flow-trade-bubble-row="sell"]'
    );
    expect(sellRow).not.toBeNull();
    act(() => {
      sellRow?.click();
    });
    expect(
      el.querySelector("[data-flow-trade-bubbles-inspector]")?.textContent
    ).toContain("Sell 160 contracts");
    const clearBtn = el.querySelector<HTMLButtonElement>(
      "[data-flow-trade-bubbles-clear]"
    );
    act(() => {
      clearBtn?.click();
    });
    expect(el.querySelector("[data-flow-trade-bubbles-clear]")).toBeNull();

    // Filter to Buy only -> net volume becomes positive (text-success).
    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[data-flow-trade-bubbles-side="buy"]'
      )?.click();
    });
    expect(el.querySelectorAll("[data-flow-trade-bubble]").length).toBe(1);
    expect(
      el.querySelector("[data-flow-trade-bubbles-summary] .text-success")
    ).not.toBeNull();

    // Filter to >= 3x while on Buy -> 0 matching prints, inspector shows empty filter note.
    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[data-flow-trade-bubbles-size="3x"]'
      )?.click();
    });
    expect(el.querySelectorAll("[data-flow-trade-bubble]").length).toBe(0);
    expect(
      el.querySelector("[data-flow-trade-bubbles-inspector]")?.textContent
    ).toContain("No deep prints match the active filters");

    // Empty document (no candles, no bubbles) -> empty panel state.
    renderPanel({
      document: sampleDocument({
        bubbles: [],
        candles: [],
        captureMode: "none",
        priceRange: null,
        symbol: "NQ",
        totals: {
          buyTrades: 0,
          buyVolume: 0,
          largestBubble: null,
          maxSize: null,
          netVolume: 0,
          p95Size: null,
          sellTrades: 0,
          sellVolume: 0,
          shownTrades: 0,
          totalTrades: 0,
          truncated: false,
        },
      }),
      failure: null,
      refreshMs: 60_000,
      symbol: "NQ",
    });
    expect(el.querySelector("[data-flow-trade-bubbles-empty]")).not.toBeNull();
    expect(el.querySelector("[data-flow-trade-bubbles-svg]")).toBeNull();

    // Mismatched document symbol while switching ES -> NQ renders loading instead of stale ES data.
    renderPanel({
      document: sampleDocument({ symbol: "ES" }),
      failure: null,
      refreshMs: 60_000,
      symbol: "NQ",
    });
    expect(
      el.querySelector("[data-flow-trade-bubbles-loading]")
    ).not.toBeNull();
    expect(el.querySelector("[data-flow-trade-bubbles-svg]")).toBeNull();
  });

  it("handles bubble-only documents with no candles (no VWAP or close line for single print)", () => {
    const single = makeBubble({ size: 50, sizeMultiple: 1.25 });
    const el = renderPanel({
      document: sampleDocument({
        bubbles: [single],
        candles: [],
        priceRange: { max: single.price, min: single.price },
      }),
      failure: null,
      refreshMs: 60_000,
      symbol: "ES",
    });
    expect(el.querySelector("[data-flow-trade-bubbles-vwap]")).toBeNull();
    expect(el.querySelector("[data-flow-trade-bubbles-close]")).toBeNull();
    expect(el.querySelectorAll("[data-flow-trade-bubble]").length).toBe(1);
  });

  it("keeps the chart slider scrollable with a focus ring and hollow-up / filled-down candle bodies", () => {
    const el = renderPanel({
      document: sampleDocument(),
      failure: null,
      refreshMs: 60_000,
      symbol: "ES",
    });
    const slider = el.querySelector("[data-flow-trade-bubbles-interactive]");
    expect(slider?.className).toContain("overflow-x-auto");
    expect(slider?.className).toContain("focus-visible:ring-2");
    const upBody = el.querySelector(
      '[data-flow-trade-bubbles-candle="up"] rect'
    );
    const downBody = el.querySelector(
      '[data-flow-trade-bubbles-candle="down"] rect'
    );
    expect(upBody?.getAttribute("fill")).toBe("none");
    expect(downBody?.getAttribute("fill")).toBe("var(--color-destructive)");
    const caption = el.querySelector("[data-flow-trade-bubbles-caption]");
    expect(caption?.id).toBeTruthy();
    expect(slider?.getAttribute("aria-describedby")).toBe(caption?.id);
    const svg = el.querySelector("[data-flow-trade-bubbles-svg]");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
  });

  it("overlays gamma level lines and off-scale strips from gex and lets users toggle them off", () => {
    const el = renderPanel({
      document: sampleDocument(),
      failure: null,
      gex: {
        at: "2026-11-25T15:30:00Z",
        basis: 10,
        ivRegime: "contango",
        levels: {
          callWall: 6050,
          flip: 6002,
          kingNode: 6050,
          maxPain: 6003,
          putWall: 5950,
        },
        netDex: 1e6,
        regime: "positive",
        spot: 6002,
        symbolLevels: {
          callWall: 6060,
          flip: 6012,
          kingNode: 6060,
          maxPain: 6013,
          putWall: 5960,
        },
        ticker: "SPX",
        totalGex: 1e9,
        zeroDteShare: 0.4,
      },
      refreshMs: 60_000,
      symbol: "ES",
    });
    const toggle = el.querySelector<HTMLButtonElement>(
      "[data-flow-trade-bubbles-gamma-toggle]"
    );
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(el.querySelector("[data-flow-gamma-lines]")).not.toBeNull();
    expect(el.querySelector("[data-flow-gamma-offscale]")).not.toBeNull();
    act(() => {
      toggle?.click();
    });
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    expect(el.querySelector("[data-flow-gamma-lines]")).toBeNull();
    expect(el.querySelector("[data-flow-gamma-offscale]")).toBeNull();
  });

  it("omits gamma overlay when viewing SPY so SPY GEX levels are never plotted on the ES futures scale", () => {
    const el = renderPanel({
      document: sampleDocument(),
      failure: null,
      gex: {
        at: "2026-11-25T15:30:00Z",
        basis: 0,
        ivRegime: "contango",
        levels: {
          callWall: 615,
          flip: 602,
          kingNode: 615,
          maxPain: 600,
          putWall: 590,
        },
        netDex: 1e6,
        regime: "positive",
        spot: 605,
        symbolLevels: {
          callWall: 615,
          flip: 602,
          kingNode: 615,
          maxPain: 600,
          putWall: 590,
        },
        ticker: "SPY",
        totalGex: 1e9,
        zeroDteShare: 0.4,
      },
      refreshMs: 60_000,
      symbol: "SPY",
    });
    expect(
      el.querySelector("[data-flow-trade-bubbles-gamma-toggle]")
    ).toBeNull();
    expect(el.querySelector("[data-flow-gamma-lines]")).toBeNull();
    expect(el.querySelector("[data-flow-gamma-offscale]")).toBeNull();
  });
});
