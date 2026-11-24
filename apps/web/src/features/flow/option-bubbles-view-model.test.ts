import type {
  FlowOptionBubbles,
  FlowOptionBubblesItem,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";
import {
  BUBBLES_CHART_HEIGHT,
  BUBBLES_CHART_WIDTH,
  bubbleAriaLabel,
  bubbleRadiusFor,
  bubbleSideStyleOf,
  buildOptionBubblesPlot,
  describeSelectedBubble,
  nextBubbleKeyTarget,
  filterOptionBubbles,
  formatThresholdLabel,
  OPTION_BUBBLES_MIN_PREMIUM_OPTIONS,
  optionBubblesChartAriaLabel,
  optionBubblesDisclosureLine,
  optionBubblesEmptyLine,
  optionBubblesFailureLine,
  optionBubblesHeaderLine,
  optionBubblesNoMatchesLine,
  optionBubblesRuleText,
  optionBubblesSymbolOf,
  optionBubblesTitle,
  optionBubblesTotalsLine,
} from "./option-bubbles-view-model.ts";

const makeBubble = (
  id: string,
  overrides: Partial<FlowOptionBubblesItem> = {}
): FlowOptionBubblesItem => ({
  at: "2026-11-20T15:14:22.000Z",
  consolidation: "sweep",
  contract: "SPY 2026-11-27 685C",
  directionalSign: 1,
  dte: 7,
  expiry: "2026-11-27",
  goldenSweep: false,
  id,
  iv: 18.2,
  moneyness: "otm",
  opening: false,
  premium: 400_000,
  price: 3.2,
  right: "call",
  sentiment: "bullish",
  side: "ask",
  size: 1250,
  strike: 685,
  underlyingPrice: 683.4,
  unusual: false,
  volumeOverOi: false,
  ...overrides,
});

const makeResponse = (
  overrides: Partial<FlowOptionBubbles> = {}
): FlowOptionBubbles => ({
  bubbles: [
    makeBubble("b-1", {
      at: "2026-11-20T14:45:00.000Z",
      goldenSweep: true,
      opening: true,
      premium: 1_200_000,
      right: "call",
      side: "above_ask",
      underlyingPrice: 682.8,
      unusual: true,
      volumeOverOi: true,
    }),
    makeBubble("b-2", {
      at: "2026-11-20T15:30:00.000Z",
      consolidation: "block",
      contract: "SPY 2026-11-27 680P",
      directionalSign: -1,
      moneyness: "itm",
      premium: 500_000,
      right: "put",
      sentiment: "bearish",
      side: "bid",
      strike: 680,
      underlyingPrice: 684.1,
    }),
    makeBubble("b-3", {
      at: "2026-11-20T16:15:00.000Z",
      directionalSign: 0,
      moneyness: "not_reported",
      premium: 260_000,
      price: null,
      right: "call",
      sentiment: "neutral",
      side: "mid",
      underlyingPrice: 683.6,
    }),
  ],
  gaps: [
    {
      end: "2026-11-20T16:00:00.000Z",
      start: "2026-11-20T15:45:00.000Z",
    },
  ],
  minPremiumUsd: 250_000,
  options: {
    ageSeconds: 20,
    lastOkAt: "2026-11-20T16:30:00.000Z",
    lastStatus: "ok",
    message: null,
    sessionOpen: true,
    source: "options",
    state: "fresh",
  },
  pricePoints: [
    { minute: "2026-11-20T14:44:00.000Z", price: 682.6, unread: false },
    { minute: "2026-11-20T14:45:00.000Z", price: 682.8, unread: false },
    { minute: "2026-11-20T15:30:00.000Z", price: 684.1, unread: false },
    { minute: "2026-11-20T15:46:00.000Z", price: 683.9, unread: true },
    { minute: "2026-11-20T16:15:00.000Z", price: 683.6, unread: false },
  ],
  rules: {
    defaultMinPremiumUsd: 250_000,
    maxBubbles: 120,
    retentionDays: 14,
    storedMinPremiumUsd: 10_000,
    version: "option-bubbles.v1",
  },
  schemaVersion: "flow-option-bubbles.v1",
  session: "2026-11-20",
  sessionEnd: "2026-11-20T21:15:00.000Z",
  sessionStart: "2026-11-20T14:30:00.000Z",
  storedUntil: "2026-11-20T16:15:00.000Z",
  symbol: "SPY",
  ticker: "SPY",
  totals: {
    askSidePremium: 1_200_000,
    bearishPremium: 500_000,
    bidSidePremium: 500_000,
    bullishPremium: 1_200_000,
    callBubbles: 2,
    callPremium: 1_460_000,
    latestPrice: 683.6,
    maxBubblePremium: 1_200_000,
    plottedBubbles: 3,
    putBubbles: 1,
    putPremium: 500_000,
    sessionGrossPremium: 9_500_000,
    sessionPrints: 210,
    shownBubbles: 3,
    unplottedBubbles: 0,
    unsignedPremium: 260_000,
  },
  truncated: false,
  unread: {
    from: "2026-11-20T15:45:00.000Z",
    ranges: 1,
    to: "2026-11-20T16:00:00.000Z",
  },
  ...overrides,
});

describe("option-bubbles-view-model copy and symbol gating", () => {
  it("gates symbols to SPY and ES and builds accurate titles and thresholds", () => {
    expect(optionBubblesSymbolOf("SPY")).toBe("SPY");
    expect(optionBubblesSymbolOf("ES")).toBe("ES");
    expect(optionBubblesSymbolOf("QQQ")).toBeNull();
    expect(optionBubblesSymbolOf("NQ")).toBeNull();

    expect(optionBubblesTitle("SPY")).toBe(
      "Option print bubbles · SPY options"
    );
    expect(optionBubblesTitle("ES")).toBe(
      "Option print bubbles · SPX options (ES)"
    );
    expect(
      OPTION_BUBBLES_MIN_PREMIUM_OPTIONS.map(formatThresholdLabel)
    ).toEqual(["$100K", "$250K", "$500K", "$1M"]);
    expect(optionBubblesEmptyLine("SPY")).toContain("SPY");
  });

  it("formats no-matches, failure, header, totals, disclosure, and rule lines", () => {
    expect(optionBubblesNoMatchesLine(250_000, "all", "all")).toContain(
      "$250K"
    );
    expect(optionBubblesNoMatchesLine(500_000, "call", "ask")).toContain(
      "matching call ask-side"
    );
    expect(optionBubblesNoMatchesLine(100_000, "put", "bid")).toContain(
      "matching put bid-side"
    );

    const failure = {
      code: "STORAGE_ERROR",
      failedAt: Date.parse("2026-11-20T16:00:00.000Z"),
      message: "read failed",
    };
    expect(
      optionBubblesFailureLine(failure, 60_000, 250_000, 500_000)
    ).toContain("Showing previous >= $250K view.");
    expect(
      optionBubblesHeaderLine(makeResponse({ unread: null }))
    ).not.toContain("Incomplete");
    expect(
      optionBubblesFailureLine(failure, 60_000, 250_000, 250_000)
    ).not.toContain("Showing previous");

    const response = makeResponse();
    expect(optionBubblesHeaderLine(response)).toContain("1 open gap");
    expect(
      optionBubblesHeaderLine(
        makeResponse({
          session: null,
          storedUntil: null,
          unread: {
            from: "2026-11-20T15:00:00.000Z",
            ranges: 2,
            to: "2026-11-20T16:00:00.000Z",
          },
        })
      )
    ).toContain("2 open gaps");

    expect(optionBubblesTotalsLine(response)).toContain("3 big prints");
    expect(
      optionBubblesTotalsLine(
        makeResponse({
          totals: { ...response.totals, shownBubbles: 1 },
        })
      )
    ).toContain("1 big print");

    expect(optionBubblesDisclosureLine(response)).toBeNull();
    expect(
      optionBubblesDisclosureLine(
        makeResponse({
          totals: { ...response.totals, unplottedBubbles: 1 },
          truncated: true,
        })
      )
    ).toContain("top 120 prints");
    expect(
      optionBubblesDisclosureLine(
        makeResponse({
          totals: { ...response.totals, unplottedBubbles: 2 },
        })
      )
    ).toContain("2 big prints reported no underlying price and are listed");

    expect(optionBubblesRuleText(response.rules)).toContain(
      "option-bubbles.v1"
    );
  });
});

describe("option-bubbles-view-model visual encoding and filtering", () => {
  it("maps sides to filled, hollow, and dashed styles and scales radii monotonically", () => {
    expect(bubbleSideStyleOf("above_ask")).toBe("filled");
    expect(bubbleSideStyleOf("ask")).toBe("filled");
    expect(bubbleSideStyleOf("bid")).toBe("hollow");
    expect(bubbleSideStyleOf("below_bid")).toBe("hollow");
    expect(bubbleSideStyleOf("mid")).toBe("dashed");
    expect(bubbleSideStyleOf("not_classified")).toBe("dashed");

    expect(bubbleRadiusFor(0, 0)).toBe(5);
    expect(bubbleRadiusFor(250_000, 1_000_000)).toBeGreaterThan(5);
    expect(bubbleRadiusFor(1_000_000, 1_000_000)).toBe(22);
    expect(bubbleRadiusFor(5_000_000, 1_000_000)).toBe(22);
  });

  it("filters bubbles by right and side cleanly", () => {
    const bubbles = makeResponse().bubbles;
    expect(filterOptionBubbles(bubbles, "all", "all")).toHaveLength(3);
    expect(
      filterOptionBubbles(bubbles, "call", "all").map((b) => b.id)
    ).toEqual(["b-1", "b-3"]);
    expect(filterOptionBubbles(bubbles, "put", "all").map((b) => b.id)).toEqual(
      ["b-2"]
    );
    expect(filterOptionBubbles(bubbles, "all", "ask").map((b) => b.id)).toEqual(
      ["b-1"]
    );
    expect(filterOptionBubbles(bubbles, "all", "bid").map((b) => b.id)).toEqual(
      ["b-2"]
    );
  });

  it("describes selected bubbles and aria labels with complete honest fields", () => {
    const response = makeResponse();
    const b1 = describeSelectedBubble(response.bubbles[0]!, "SPY");
    expect(b1.headline).toContain("Call");
    expect(b1.executionLine).toContain("Above ask (Bullish flow)");
    expect(b1.flags).toEqual([
      "Golden sweep",
      "Unusual",
      "Vol > OI",
      "Opening",
    ]);

    const b2 = describeSelectedBubble(response.bubbles[1]!, "SPY");
    expect(b2.headline).toContain("Put");
    expect(b2.executionLine).toContain("Bearish flow");

    const unpriced = makeBubble("u-1", {
      directionalSign: 0,
      dte: null,
      iv: null,
      price: null,
      underlyingPrice: null,
    });
    const desc = describeSelectedBubble(unpriced, "SPX");
    expect(desc.executionLine).toContain("option price not reported");
    expect(desc.executionLine).toContain("Unsigned flow");
    expect(desc.contextLine).toContain("SPX price not reported");
    expect(desc.contextLine).toContain("DTE not reported");
    expect(desc.contextLine).toContain("IV not reported");
    expect(bubbleAriaLabel(unpriced, "SPX")).toContain(
      "underlying price not reported"
    );

    expect(optionBubblesChartAriaLabel(response, 1)).toContain(
      "1 big option print"
    );
    expect(
      optionBubblesChartAriaLabel(makeResponse({ session: null }), 2)
    ).toContain("2 big option prints");
  });
});

describe("buildOptionBubblesPlot", () => {
  it("returns null without session bounds or when neither price points nor plotted bubbles exist", () => {
    expect(
      buildOptionBubblesPlot(
        makeResponse({ sessionEnd: null, sessionStart: null }),
        "all",
        "all"
      )
    ).toBeNull();
    expect(
      buildOptionBubblesPlot(
        makeResponse({ bubbles: [], pricePoints: [] }),
        "all",
        "all"
      )
    ).toBeNull();
  });

  it("builds segmented price paths, gap bands, ticks, latest spot, draw order, and table order", () => {
    const plot = buildOptionBubblesPlot(makeResponse(), "all", "all");
    expect(plot).not.toBeNull();
    if (plot === null) return;

    expect(plot.width).toBe(BUBBLES_CHART_WIDTH);
    expect(plot.height).toBe(BUBBLES_CHART_HEIGHT);
    expect(plot.priceTicks).toHaveLength(5);
    expect(plot.timeTicks).toHaveLength(6);
    expect(plot.timeTicks.at(-1)?.label).toContain("ET");
    expect(plot.gapRects).toHaveLength(1);
    // 14:44 + 14:45 form a segment; 15:30, 15:46 (unread), 16:15 are isolated dots
    expect(plot.priceSegments).toHaveLength(1);
    expect(plot.priceDots).toHaveLength(3);
    expect(plot.latestSpot?.price).toBe(683.6);

    // Chronological order for keyboard nav
    expect(plot.chronologicalBubbles.map((b) => b.bubble.id)).toEqual([
      "b-1",
      "b-2",
      "b-3",
    ]);
    // Largest drawn first so smallest sits on top
    expect(plot.drawBubbles.map((b) => b.bubble.id)).toEqual([
      "b-1",
      "b-2",
      "b-3",
    ]);
    expect(plot.drawBubbles[0]?.halo).toBe(true);
    expect(plot.drawBubbles[0]?.glyph).toBe("C");
    expect(plot.drawBubbles[1]?.glyph).toBe("P");
    expect(plot.sizeLegend).toHaveLength(3);
  });

  it("handles bubble-only sessions, small bubbles without glyphs, null latestPrice, and tie-breaking", () => {
    const plot = buildOptionBubblesPlot(
      makeResponse({
        bubbles: [
          makeBubble("a", {
            at: "2026-11-20T15:00:00.000Z",
            premium: 500_000,
            underlyingPrice: 681,
          }),
          makeBubble("b", {
            at: "2026-11-20T15:00:00.000Z",
            premium: 500_000,
            underlyingPrice: 685,
          }),
          makeBubble("tiny", {
            at: "2026-11-20T15:05:00.000Z",
            premium: 250_000,
            underlyingPrice: 683,
          }),
          makeBubble("mega", {
            at: "2026-11-20T15:10:00.000Z",
            premium: 12_000_000,
            underlyingPrice: 684,
          }),
          makeBubble("unplotted", {
            at: "2026-11-20T15:12:00.000Z",
            premium: 600_000,
            underlyingPrice: null,
          }),
        ],
        gaps: [],
        pricePoints: [],
        totals: {
          ...makeResponse().totals,
          latestPrice: null,
        },
      }),
      "all",
      "all"
    );
    expect(plot).not.toBeNull();
    if (plot === null) return;

    expect(plot.latestSpot).toBeNull();
    // "tiny" ($250k vs $12M scaleMax) has r < 10 so glyph is null
    const tinyPlot = plot.chronologicalBubbles.find(
      (b) => b.bubble.id === "tiny"
    );
    expect(tinyPlot?.glyph).toBeNull();
    // Table includes unplotted prints and breaks equal-premium ties by id desc
    expect(plot.tableBubbles.map((b) => b.id)).toEqual([
      "mega",
      "unplotted",
      "b",
      "a",
      "tiny",
    ]);
  });

  it("expands Y range when latestPrice is outside the price points and bubbles range", () => {
    const lowPlot = buildOptionBubblesPlot(
      makeResponse({
        bubbles: [],
        pricePoints: [
          { minute: "2026-11-20T14:44:00.000Z", price: 685, unread: false },
        ],
        totals: { ...makeResponse().totals, latestPrice: 680 },
      }),
      "all",
      "all"
    );
    expect(lowPlot?.latestSpot?.price).toBe(680);

    const highPlot = buildOptionBubblesPlot(
      makeResponse({
        bubbles: [],
        pricePoints: [
          { minute: "2026-11-20T14:44:00.000Z", price: 680, unread: false },
        ],
        totals: { ...makeResponse().totals, latestPrice: 690 },
      }),
      "all",
      "all"
    );
    expect(highPlot?.latestSpot?.price).toBe(690);
  });
});

describe("nextBubbleKeyTarget", () => {
  it("handles arrow, Home, End, Escape, missing id, and unrelated keys", () => {
    const ids = ["a", "b", "c"];
    expect(nextBubbleKeyTarget(ids, "b", "Escape")).toBe("clear");
    expect(nextBubbleKeyTarget(ids, "b", "ArrowLeft")).toBe("a");
    expect(nextBubbleKeyTarget(ids, "a", "ArrowLeft")).toBe("a");
    expect(nextBubbleKeyTarget(ids, "b", "ArrowRight")).toBe("c");
    expect(nextBubbleKeyTarget(ids, "c", "ArrowRight")).toBe("c");
    expect(nextBubbleKeyTarget(ids, "b", "Home")).toBe("a");
    expect(nextBubbleKeyTarget(ids, "b", "End")).toBe("c");
    expect(nextBubbleKeyTarget(ids, "missing", "ArrowRight")).toBeUndefined();
    expect(nextBubbleKeyTarget(ids, "b", "Tab")).toBeUndefined();
  });
});
