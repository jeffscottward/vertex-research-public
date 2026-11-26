import type { FlowTradeBubble, FlowTradeBubbles } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  buildTradeBubblesPlot,
  describeTradeBubble,
  filterTradeBubbles,
  moveBubbleSelection,
  summarizeTradeBubbles,
  tradeBubbleRadius,
  tradeBubblesCaptureBadge,
  tradeBubblesKey,
  tradeBubblesRuleLine,
  tradeBubblesTableRows,
  tradeBubblesTapeBadge,
  tradeBubblesTitle,
} from "./trade-bubbles-view-model.ts";

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

const makeDoc = (over: Partial<FlowTradeBubbles> = {}): FlowTradeBubbles => {
  const b1 = makeBubble({
    price: 6011.5,
    second: "2026-11-23T14:15:05.000Z",
    seq: 0,
    side: "buy",
    size: 60,
    sizeMultiple: 1.5,
  });
  const b2 = makeBubble({
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
    bubbles: [b1, b2],
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
      largestBubble: b2,
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

describe("trade-bubbles-view-model", () => {
  it("formats titles, rules, and capture/tape badges", () => {
    expect(tradeBubblesTitle("ES", "ES")).toBe("Big futures trades (ES)");
    expect(tradeBubblesTitle("SPY", "ES")).toBe(
      "Big futures trades (ES · SPY group)"
    );
    expect(tradeBubblesRuleLine(makeDoc())).toContain("≥ 40 contracts");

    expect(tradeBubblesCaptureBadge("streamed")).toEqual({
      label: "Streamed tape",
      tone: "success",
    });
    expect(tradeBubblesCaptureBadge("sampled")).toEqual({
      label: "Sampled tape",
      tone: "warning",
    });
    expect(tradeBubblesCaptureBadge("mixed")).toEqual({
      label: "Mixed tape",
      tone: "warning",
    });
    expect(tradeBubblesCaptureBadge("none")).toEqual({
      label: "No deep prints",
      tone: "neutral",
    });

    expect(tradeBubblesTapeBadge(makeDoc().tape).tone).toBe("success");
    expect(
      tradeBubblesTapeBadge({
        ...makeDoc().tape,
        ageSeconds: 180,
        state: "stale",
      }).tone
    ).toBe("warning");
    expect(
      tradeBubblesTapeBadge({ ...makeDoc().tape, state: "closed" })
    ).toEqual({ label: "Market closed", tone: "neutral" });
    expect(
      tradeBubblesTapeBadge({ ...makeDoc().tape, state: "never" })
    ).toEqual({ label: "No tape sample", tone: "warning" });
  });

  it("filters bubbles by side and size multiple and scales radius monotonically", () => {
    const doc = makeDoc();
    expect(filterTradeBubbles(doc.bubbles, "all", "all")).toHaveLength(2);
    expect(filterTradeBubbles(doc.bubbles, "buy", "all")).toHaveLength(1);
    expect(filterTradeBubbles(doc.bubbles, "sell", "2x")).toHaveLength(1);
    expect(filterTradeBubbles(doc.bubbles, "all", "3x")).toHaveLength(1);
    expect(filterTradeBubbles(doc.bubbles, "buy", "2x")).toHaveLength(0);

    const small = tradeBubbleRadius(40, 160);
    const medium = tradeBubbleRadius(160, 160);
    const huge = tradeBubbleRadius(500, 160);
    expect(small).toBeGreaterThanOrEqual(5.5);
    expect(medium).toBeGreaterThan(small);
    expect(huge).toBeLessThanOrEqual(22);
    expect(huge).toBeGreaterThan(medium);
  });

  it("builds SVG plot geometry with candles, VWAP, paint-ordered bubbles, and handles empty/bubble-only states", () => {
    const doc = makeDoc();
    const plot = buildTradeBubblesPlot(doc, doc.bubbles);
    expect(plot).not.toBeNull();
    expect(plot?.candles.map((c) => c.direction)).toEqual([
      "up",
      "flat",
      "down",
    ]);
    expect(plot?.vwapLinePoints).toContain(",");
    expect(plot?.closeLinePoints).toContain(",");
    expect(plot?.priceTicks).toHaveLength(5);
    expect(plot?.timeTicks).toHaveLength(5);
    expect(plot?.bubbles[0]?.bubble.size).toBe(160);
    expect(plot?.bubbles[1]?.bubble.size).toBe(60);
    expect(plot?.chronologicalKeys).toEqual(doc.bubbles.map(tradeBubblesKey));

    const bubblesOnly = buildTradeBubblesPlot(
      makeDoc({ candles: [], totals: { ...doc.totals, p95Size: null } }),
      doc.bubbles
    );
    expect(bubblesOnly?.vwapLinePoints).toBeNull();
    expect(bubblesOnly?.closeLinePoints).toContain(",");

    const singleBubble = buildTradeBubblesPlot(
      makeDoc({ bubbles: [doc.bubbles[0]!], candles: [] }),
      [doc.bubbles[0]!]
    );
    expect(singleBubble?.closeLinePoints).toBeNull();

    const filteredEmpty = buildTradeBubblesPlot(makeDoc({ candles: [] }), []);
    expect(filteredEmpty?.bubbles).toEqual([]);

    const totallyEmpty = buildTradeBubblesPlot(
      makeDoc({ bubbles: [], candles: [], priceRange: null }),
      []
    );
    expect(totallyEmpty).toBeNull();
  });

  it("builds top-print table rows, summary stats, descriptions, and keyboard navigation", () => {
    const doc = makeDoc();
    const tieBubbles = [
      makeBubble({ second: "2026-11-23T14:20:00.000Z", seq: 0, size: 100 }),
      makeBubble({ second: "2026-11-23T14:20:00.000Z", seq: 2, size: 100 }),
      makeBubble({ second: "2026-11-23T14:25:00.000Z", seq: 0, size: 100 }),
      makeBubble({
        capture: "sampled",
        second: "2026-11-23T14:10:00.000Z",
        seq: 0,
        side: "sell",
        signing: "tick",
        size: 50,
      }),
    ];
    const rows = tradeBubblesTableRows(tieBubbles);
    expect(rows.map((r) => r.key)).toEqual([
      "2026-11-23T14:25:00.000Z#0",
      "2026-11-23T14:20:00.000Z#2",
      "2026-11-23T14:20:00.000Z#0",
      "2026-11-23T14:10:00.000Z#0",
    ]);
    expect(rows[3]?.captureLabel).toBe("Sampled");
    expect(rows[3]?.signingLabel).toBe("Tick");
    const buyDesc = describeTradeBubble(doc.bubbles[0]!);
    expect(buyDesc).toContain("Buy 60 contracts (1.50×)");
    expect(buyDesc).not.toContain("ET ET");
    expect(describeTradeBubble(doc.bubbles[1]!)).toContain(
      "Sell 160 contracts (4.00×)"
    );
    expect(rows[0]?.multipleLabel).toBe("2.00×");

    const plotCheck = buildTradeBubblesPlot(doc, doc.bubbles);
    expect(plotCheck?.timeTicks[0]?.anchor).toBe("start");
    expect(plotCheck?.timeTicks[2]?.anchor).toBe("middle");
    expect(plotCheck?.timeTicks[4]?.anchor).toBe("end");
    expect(plotCheck?.candles[0]?.label).not.toMatch(/E[SD]T ET/);

    // Unfiltered truncated document uses full-window doc.totals (not only shown bubbles).
    const truncatedDoc = makeDoc({
      totals: {
        ...doc.totals,
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
    const summaryUnfiltered = summarizeTradeBubbles(
      truncatedDoc,
      truncatedDoc.bubbles,
      false
    );
    expect(summaryUnfiltered.buyContracts).toBe("18.5K");
    expect(summaryUnfiltered.sellContracts).toBe("16K");
    expect(summaryUnfiltered.netTone).toBe("success");
    expect(summaryUnfiltered.shownLabel).toBe("2 of 600 prints");

    const summaryAll = summarizeTradeBubbles(
      doc,
      [doc.bubbles[1]!, doc.bubbles[0]!],
      true
    );
    expect(summaryAll.netTone).toBe("destructive");
    expect(summaryAll.shownLabel).toBe("2 prints");
    expect(summaryAll.largestPrint).toContain("Sell 160");
    const summaryBuy = summarizeTradeBubbles(doc, [doc.bubbles[0]!], true);
    expect(summaryBuy.netTone).toBe("success");
    expect(summaryBuy.shownLabel).toBe("1 of 2 prints");
    expect(summaryBuy.largestPrint).toContain("Buy 60");

    const summaryEmpty = summarizeTradeBubbles(doc, [], true);
    expect(summaryEmpty.netTone).toBe("neutral");
    expect(summaryEmpty.largestPrint).toBe("None");
    const keys = ["a", "b", "c"];
    expect(moveBubbleSelection([], null, "next")).toBeNull();
    expect(moveBubbleSelection(keys, null, "first")).toBe("a");
    expect(moveBubbleSelection(keys, null, "last")).toBe("c");
    expect(moveBubbleSelection(keys, null, "next")).toBe("a");
    expect(moveBubbleSelection(keys, null, "prev")).toBe("c");
    expect(moveBubbleSelection(keys, "a", "next")).toBe("b");
    expect(moveBubbleSelection(keys, "c", "next")).toBe("c");
    expect(moveBubbleSelection(keys, "b", "prev")).toBe("a");
    expect(moveBubbleSelection(keys, "a", "prev")).toBe("a");
  });
});
