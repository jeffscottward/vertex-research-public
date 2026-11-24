import { buildFlowLiveDom, type FlowLiveDom } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  buildLiveDomDisplayRows,
  buildLiveDomKpis,
  buildLiveDomStatusBanner,
  captureBookSizes,
  domPriceDecimals,
  domSymbolOf,
  formatDomPrice,
  formatSignedContracts,
  frameCenterTick,
  inspectLiveDomRow,
  LIVE_DOM_CADENCE_OPTIONS,
  LIVE_DOM_WINDOW_OPTIONS,
  liveDomTitle,
  nextDomBackoffMs,
  shouldResetDomClientState,
  sliceDomRows,
} from "./live-dom-view-model.ts";

const makeFrame = (
  over: Partial<Parameters<typeof buildFlowLiveDom>[0]> = {}
): FlowLiveDom =>
  buildFlowLiveDom({
    asks: [
      [6012.5, 52],
      [6012.75, 86],
    ],
    bids: [
      [6012.25, 68],
      [6012.0, 264],
    ],
    capturedAt: "2026-11-24T14:30:00.000Z",
    contract: "ESZ6",
    depthFeed: {
      error: null,
      lastAt: "2026-11-24T14:30:00.000Z",
      state: "live",
    },
    depthUpdates: 120,
    lastTrade: {
      price: 6012.5,
      side: "buy",
      size: 6,
      t: "2026-11-24T14:29:59.000Z",
    },
    minTick: 0.25,
    seq: 150,
    since: null,
    source: "live_stream",
    symbol: "ES",
    tapeFeed: {
      error: null,
      lastAt: "2026-11-24T14:29:59.000Z",
      state: "live",
    },
    tapeSeq: 30,
    volumeByPrice: [
      [6012.5, 240, 60, 0, 18],
      [6012.25, 40, 150, 0, 14],
      [6012.0, 310, 290, 0, 42],
    ],
    volumeSource: "streamed_tape",
    windowSeconds: 900,
    ...over,
  });

describe("live-dom-view-model", () => {
  it("maps symbols, titles, decimals, signed contracts, options, and exponential backoff", () => {
    expect(domSymbolOf("SPY")).toBe("ES");
    expect(domSymbolOf("ES")).toBe("ES");
    expect(domSymbolOf("QQQ")).toBe("NQ");
    expect(domSymbolOf("NQ")).toBe("NQ");

    expect(liveDomTitle("ES")).toBe("Live DOM ladder (ES)");
    expect(liveDomTitle("SPY")).toContain("S&P 500");

    expect(domPriceDecimals(1)).toBe(2);
    expect(domPriceDecimals(0.25)).toBe(2);
    expect(domPriceDecimals(0.125)).toBe(3);
    expect(formatDomPrice(6012.5, 2)).toBe("6012.50");

    expect(formatSignedContracts(18)).toBe("+18");
    expect(formatSignedContracts(-12)).toBe("-12");
    expect(formatSignedContracts(0)).toBe("0");

    expect(LIVE_DOM_WINDOW_OPTIONS.map((o) => o.label)).toEqual([
      "5m",
      "15m",
      "30m",
      "60m",
    ]);
    expect(LIVE_DOM_CADENCE_OPTIONS.map((o) => o.label)).toEqual([
      "500 ms",
      "1 s",
      "2 s",
    ]);

    expect(nextDomBackoffMs(0)).toBe(1000);
    expect(nextDomBackoffMs(1)).toBe(2000);
    expect(nextDomBackoffMs(3)).toBe(8000);
    expect(nextDomBackoffMs(6)).toBe(15_000);
  });

  it("captures book sizes, detects client reset conditions, and slices around center tick", () => {
    const f1 = makeFrame();
    const f2 = makeFrame({
      asks: [
        [6012.5, 40],
        [6012.75, 100],
      ],
      bids: [
        [6012.25, 86],
        [6012.0, 264],
      ],
    });
    expect(shouldResetDomClientState(null, f1)).toBe(true);
    expect(shouldResetDomClientState(f1, f2)).toBe(false);
    expect(shouldResetDomClientState(f1, makeFrame({ symbol: "NQ" }))).toBe(
      true
    );
    expect(shouldResetDomClientState(f1, makeFrame({ contract: "ESH7" }))).toBe(
      true
    );
    expect(
      shouldResetDomClientState(f1, makeFrame({ source: "recorded_fallback" }))
    ).toBe(true);

    const sizes = captureBookSizes(f1.rows);
    expect(sizes.size).toBe(4);
    const gapFrame = makeFrame({
      asks: [[6013.0, 10]],
      bids: [[6012.0, 10]],
      volumeByPrice: [],
    });
    expect(captureBookSizes(gapFrame.rows).size).toBe(2);
    const initialDisplay = buildLiveDomDisplayRows(f1, null, null);
    expect(initialDisplay[0]?.bidDelta).toBe(0);
    expect(initialDisplay[0]?.askDelta).toBe(0);
    const withNewTick = makeFrame({
      asks: [
        [6012.5, 40],
        [6012.75, 100],
        [6013.0, 15],
      ],
      bids: [
        [6012.25, 86],
        [6012.0, 264],
      ],
    });
    const display = buildLiveDomDisplayRows(withNewTick, sizes, null);
    const bestAsk = display.find((d) => d.row.isBestAsk);
    const bestBid = display.find((d) => d.row.isBestBid);
    expect(bestAsk?.askDelta).toBe(-12);
    expect(bestAsk?.askDeltaText).toBe("-12");
    expect(bestAsk?.ariaLabel).toContain("3x buy imbalance");
    expect(bestBid?.bidDelta).toBe(18);
    expect(bestBid?.bidDeltaText).toBe("+18");
    expect(bestBid?.ariaLabel).toContain("3x sell imbalance");

    // Inspection text covers tagged and plain rows
    expect(inspectLiveDomRow(bestAsk!)).toContain(
      "Best Ask · Last Trade · 3x Buy Imbalance"
    );
    expect(inspectLiveDomRow(bestBid!)).toContain(
      "Best Bid · 3x Sell Imbalance"
    );
    const plain = display.find(
      (d) =>
        !(
          d.row.isBestAsk ||
          d.row.isBestBid ||
          d.row.isLastTrade ||
          d.row.isPoc
        )
    );
    expect(inspectLiveDomRow(plain!)).toContain("Vol 0 contracts");
    const pocRow = display.find((d) => d.row.isPoc);
    expect(inspectLiveDomRow(pocRow!)).toContain("POC");

    // Slicing on wide ladders clamps at top and bottom cleanly
    const wide = makeFrame({
      asks: [[6020.0, 10]],
      bids: [[6000.0, 10]],
      volumeByPrice: [],
    });
    expect(sliceDomRows(wide.rows, frameCenterTick(wide), 10)).toHaveLength(10);
    expect(sliceDomRows(wide.rows, 24_000, 10)).toHaveLength(10); // bottom clamp
    expect(sliceDomRows(wide.rows, 24_080, 10)).toHaveLength(10); // top clamp
    expect(sliceDomRows(wide.rows, null, 10)).toHaveLength(wide.rows.length);

    // Center tick fallbacks (lastTrade, POC, empty)
    const tradeOnly = makeFrame({ asks: [], bids: [], volumeByPrice: [] });
    expect(frameCenterTick(tradeOnly)).toBe(Math.round(6012.5 / 0.25));
    const pocOnly = makeFrame({
      asks: [],
      bids: [],
      lastTrade: null,
      volumeByPrice: [[6012.0, 10, 5, 0, 2]],
    });
    expect(frameCenterTick(pocOnly)).toBe(Math.round(6012.0 / 0.25));
    const empty = makeFrame({
      asks: [],
      bids: [],
      lastTrade: null,
      volumeByPrice: [],
    });
    expect(frameCenterTick(empty)).toBeNull();
    expect(buildLiveDomDisplayRows(empty, null, null)).toEqual([]);
  });

  it("builds KPI cards for normal, multi-tick, locked, crossed, one-sided, and empty books", () => {
    const normalKpis = buildLiveDomKpis(makeFrame());
    expect(normalKpis[0]?.detail).toContain("1 tick");
    expect(normalKpis[3]?.label).toBe("Window volume");

    const wideSpread = buildLiveDomKpis(
      makeFrame({
        asks: [[6013.0, 10]],
        bids: [[6012.25, 10]],
        since: 1_763_900_000,
      })
    );
    expect(wideSpread[0]?.detail).toContain("3 ticks");
    expect(wideSpread[3]?.label).toBe("Since-reset volume");

    const locked = buildLiveDomKpis(
      makeFrame({
        asks: [[6012.25, 10]],
        bids: [[6012.25, 10]],
        volumeByPrice: [],
      })
    );
    expect(locked[0]?.value).toBe("Locked 6012.25");

    const crossed = buildLiveDomKpis(
      makeFrame({
        asks: [[6012.0, 10]],
        bids: [[6012.5, 10]],
        volumeByPrice: [],
      })
    );
    expect(crossed[0]?.detail).toContain("Crossed");

    const bidOnly = buildLiveDomKpis(
      makeFrame({
        asks: [],
        bids: [[6012.25, 10]],
        lastTrade: null,
        volumeByPrice: [],
      })
    );
    expect(bidOnly[0]?.value).toBe("Bid 6012.25");
    expect(bidOnly[1]?.detail).toContain("15m window");

    const askOnly = buildLiveDomKpis(
      makeFrame({
        asks: [[6012.5, 10]],
        bids: [],
        lastTrade: null,
        since: 1_763_900_000,
        volumeByPrice: [],
        volumeSource: "large_trades_only",
      })
    );
    expect(askOnly[0]?.value).toBe("Ask 6012.50");
    expect(askOnly[1]?.detail).toBe("No trades since reset");
    expect(askOnly[3]?.detail).toBe("Large trades only in fallback window");

    const empty = buildLiveDomKpis(
      makeFrame({
        asks: [],
        bids: [],
        lastTrade: null,
        volumeByPrice: [],
        volumeSource: "none",
      })
    );
    expect(empty[0]?.value).toBe("No resting quotes");
    expect(empty[2]?.value).toBe("No resting depth");
    expect(empty[3]?.detail).toBe("0 prints in active window");
  });

  it("builds definite status-language banners for every connection phase and source", () => {
    const fLive = makeFrame();
    expect(
      buildLiveDomStatusBanner({
        cadenceMs: 500,
        errorAtMs: null,
        errorMessage: null,
        frame: fLive,
        pausedAtMs: Date.parse("2026-11-24T14:30:05.000Z"),
        phase: "paused",
        retryInMs: null,
        symbol: "ES",
      }).badge
    ).toBe("Paused");

    expect(
      buildLiveDomStatusBanner({
        cadenceMs: 500,
        errorAtMs: null,
        errorMessage: null,
        frame: null,
        pausedAtMs: null,
        phase: "paused",
        retryInMs: null,
        symbol: "ES",
      }).detail
    ).toContain("paused by operator");

    expect(
      buildLiveDomStatusBanner({
        cadenceMs: 500,
        errorAtMs: null,
        errorMessage: null,
        frame: fLive,
        pausedAtMs: null,
        phase: "hidden",
        retryInMs: null,
        symbol: "ES",
      }).badge
    ).toBe("Tab hidden");

    expect(
      buildLiveDomStatusBanner({
        cadenceMs: 500,
        errorAtMs: Date.parse("2026-11-24T14:30:05.000Z"),
        errorMessage: "network offline",
        frame: fLive,
        pausedAtMs: null,
        phase: "error",
        retryInMs: 4000,
        symbol: "ES",
      }).detail
    ).toContain("retrying in 4 s");

    expect(
      buildLiveDomStatusBanner({
        cadenceMs: 500,
        errorAtMs: null,
        errorMessage: null,
        frame: null,
        pausedAtMs: null,
        phase: "error",
        retryInMs: null,
        symbol: "ES",
      }).detail
    ).toContain("transport connection dropped");

    expect(
      buildLiveDomStatusBanner({
        cadenceMs: 500,
        errorAtMs: null,
        errorMessage: null,
        frame: null,
        pausedAtMs: null,
        phase: "connecting",
        retryInMs: null,
        symbol: "ES",
      }).badge
    ).toBe("Connecting");

    expect(
      buildLiveDomStatusBanner({
        cadenceMs: 1000,
        errorAtMs: null,
        errorMessage: null,
        frame: fLive,
        pausedAtMs: null,
        phase: "reconnecting",
        retryInMs: null,
        symbol: "ES",
      }).detail
    ).toContain("renewing stream lease");

    expect(
      buildLiveDomStatusBanner({
        cadenceMs: 500,
        errorAtMs: null,
        errorMessage: null,
        frame: fLive,
        pausedAtMs: null,
        phase: "streaming",
        retryInMs: null,
        symbol: "ES",
      }).tone
    ).toBe("success");

    const fRecorded = makeFrame({
      depthFeed: {
        error: "History /dom not deployed (HTTP 404)",
        lastAt: "2026-11-24T14:29:55.000Z",
        state: "recorded",
      },
      source: "recorded_fallback",
      volumeSource: "large_trades_only",
    });
    expect(
      buildLiveDomStatusBanner({
        cadenceMs: 500,
        errorAtMs: null,
        errorMessage: null,
        frame: fRecorded,
        pausedAtMs: null,
        phase: "streaming",
        retryInMs: null,
        symbol: "ES",
      }).detail
    ).toContain("large trades only");

    const fRecordedNoErr = makeFrame({
      depthFeed: { error: null, lastAt: null, state: "starting" },
      source: "recorded_fallback",
      volumeSource: "streamed_tape",
    });
    expect(
      buildLiveDomStatusBanner({
        cadenceMs: 500,
        errorAtMs: null,
        errorMessage: null,
        frame: fRecordedNoErr,
        pausedAtMs: null,
        phase: "streaming",
        retryInMs: null,
        symbol: "ES",
      }).detail
    ).toContain("starting");

    const fEmpty = makeFrame({
      asks: [],
      bids: [],
      depthFeed: { error: null, lastAt: null, state: "never" },
      source: "empty",
      volumeByPrice: [],
      volumeSource: "none",
    });
    expect(
      buildLiveDomStatusBanner({
        cadenceMs: 500,
        errorAtMs: null,
        errorMessage: null,
        frame: fEmpty,
        pausedAtMs: null,
        phase: "streaming",
        retryInMs: null,
        symbol: "NQ",
      }).badge
    ).toBe("No depth yet");
  });
});
