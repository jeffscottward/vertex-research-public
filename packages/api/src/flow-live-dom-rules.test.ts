import { describe, expect, it } from "vitest";

import {
  FLOW_LIVE_DOM_MAX_LEVELS,
  FLOW_LIVE_DOM_RULES_VERSION,
  FLOW_LIVE_DOM_VERSION,
} from "./contracts/flow.ts";
import {
  type BuildFlowLiveDomInput,
  buildFlowLiveDom,
  canonicalDomPrice,
  canonicalDomTickIndex,
  FLOW_LIVE_DOM_IMBALANCE_MIN_CONTRACTS,
  FLOW_LIVE_DOM_IMBALANCE_RATIO,
} from "./flow-live-dom-rules.ts";

const baseInput = (
  over: Partial<BuildFlowLiveDomInput> = {}
): BuildFlowLiveDomInput => ({
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
  depthUpdates: 420,
  lastTrade: {
    price: 6012.5,
    side: "buy",
    size: 6,
    t: "2026-11-24T14:29:59.000Z",
  },
  minTick: 0.25,
  seq: 520,
  since: null,
  source: "live_stream",
  symbol: "ES",
  tapeFeed: {
    error: null,
    lastAt: "2026-11-24T14:29:59.000Z",
    state: "live",
  },
  tapeSeq: 100,
  volumeByPrice: [
    [6012.5, 240, 60, 0, 18],
    [6012.25, 40, 150, 5, 14],
    [6012.0, 310, 290, 0, 42],
  ],
  volumeSource: "streamed_tape",
  windowSeconds: 900,
  ...over,
});

describe("buildFlowLiveDom", () => {
  it("builds a contiguous 1-tick ladder with outward cumulatives, POC, imbalances, and totals", () => {
    const out = buildFlowLiveDom(baseInput());
    expect(out.schemaVersion).toBe(FLOW_LIVE_DOM_VERSION);
    expect(out.rules.version).toBe(FLOW_LIVE_DOM_RULES_VERSION);
    expect(out.bookState).toBe("normal");
    expect(out.bestBid).toBe(6012.25);
    expect(out.bestAsk).toBe(6012.5);
    expect(out.mid).toBe(6012.375);
    expect(out.spread).toBe(0.25);
    expect(out.spreadTicks).toBe(1);
    expect(out.pocPrice).toBe(6012);
    expect(out.pocVolume).toBe(600);
    expect(out.rows.map((r) => r.price)).toEqual([
      6012.75, 6012.5, 6012.25, 6012,
    ]);

    const ask2 = out.rows[0];
    const bestAsk = out.rows[1];
    const bestBid = out.rows[2];
    const bid2 = out.rows[3];
    expect(ask2?.cumAskSize).toBe(138);
    expect(bestAsk?.cumAskSize).toBe(52);
    expect(bestAsk?.isBestAsk).toBe(true);
    expect(bestAsk?.isLastTrade).toBe(true);
    expect(bestAsk?.imbalance).toBe("buy"); // 240 >= 15 and 240 >= 3 * 60
    expect(bestBid?.cumBidSize).toBe(68);
    expect(bestBid?.isBestBid).toBe(true);
    expect(bestBid?.imbalance).toBe("sell"); // 150 >= 15 and 150 >= 3 * 40
    expect(bid2?.cumBidSize).toBe(332);
    expect(bid2?.isPoc).toBe(true);
    expect(bid2?.imbalance).toBeNull();

    expect(out.totals).toEqual({
      askSize: 138,
      bidSharePct: 70.6,
      bidSize: 332,
      tradedBuy: 590,
      tradedDelta: 90,
      tradedSell: 500,
      tradedTotal: 1095,
      tradedUnsigned: 5,
      trades: 74,
    });
  });

  it("canonicalizes ticks, sums duplicates, filters invalid inputs, and falls back when minTick is null", () => {
    expect(canonicalDomTickIndex(6012.25, 0.25)).toBe(24_049);
    expect(canonicalDomPrice(24_049, 0.25)).toBe(6012.25);

    const out = buildFlowLiveDom(
      baseInput({
        asks: [
          [6012.500_000_1, 10],
          [6012.499_999_9, 15],
          [Number.NaN, 5],
          [0.01, 5], // rounds to tick 0 -> skipped
        ],
        bids: [
          [6012.25, 20],
          [6012.25, 30],
          [-5, 10],
          [6012.0, 0],
        ],
        minTick: null,
        volumeByPrice: [
          [6012.5, 10, 2, 1, 2],
          [6012.5, 5, 3, 2, 3],
          [6012.25, 0, 0, 0, 0],
          [0.01, 10, 0, 0, 1], // tick 0 -> skipped
          [Number.POSITIVE_INFINITY, 1, 1, 0, 1],
          [6012.0, -1, 0, 0, 1],
        ],
      })
    );
    expect(out.minTick).toBe(0.25);
    const rAsk = out.rows.find((r) => r.price === 6012.5);
    const rBid = out.rows.find((r) => r.price === 6012.25);
    expect(rAsk?.askSize).toBe(25);
    expect(rAsk?.tradedBuy).toBe(15);
    expect(rAsk?.tradedSell).toBe(5);
    expect(rAsk?.tradedUnsigned).toBe(3);
    expect(rAsk?.trades).toBe(5);
    expect(rAsk?.imbalance).toBe("buy"); // exact boundary: 15 >= 15 and 15 >= 3 * 5
    expect(rBid?.bidSize).toBe(50);
    expect(FLOW_LIVE_DOM_IMBALANCE_MIN_CONTRACTS).toBe(15);
    expect(FLOW_LIVE_DOM_IMBALANCE_RATIO).toBe(3);
  });

  it("classifies locked, crossed, one-sided, and empty books accurately", () => {
    const locked = buildFlowLiveDom(
      baseInput({
        asks: [[6012.25, 10]],
        bids: [[6012.25, 20]],
        volumeByPrice: [],
      })
    );
    expect(locked.bookState).toBe("locked");
    expect(locked.spread).toBe(0);
    expect(locked.spreadTicks).toBe(0);
    expect(locked.pocPrice).toBeNull();
    expect(locked.pocVolume).toBe(0);

    const crossed = buildFlowLiveDom(
      baseInput({
        asks: [
          [6012.0, 10],
          [6012.25, 15],
        ],
        bids: [
          [6012.5, 20],
          [6012.25, 25],
        ],
        volumeByPrice: [],
      })
    );
    expect(crossed.bookState).toBe("crossed");
    expect(crossed.spread).toBe(-0.5);
    expect(crossed.spreadTicks).toBe(-2);
    // Cumulatives stay outward independent of crossed state
    expect(crossed.rows.find((r) => r.price === 6012.5)?.cumBidSize).toBe(20);
    expect(crossed.rows.find((r) => r.price === 6012.25)?.cumBidSize).toBe(45);
    expect(crossed.rows.find((r) => r.price === 6012.0)?.cumAskSize).toBe(10);
    expect(crossed.rows.find((r) => r.price === 6012.25)?.cumAskSize).toBe(25);

    const oneSidedBid = buildFlowLiveDom(
      baseInput({ asks: [], bids: [[6012.25, 20]], volumeByPrice: [] })
    );
    expect(oneSidedBid.bookState).toBe("one_sided");
    expect(oneSidedBid.mid).toBe(6012.25);
    expect(oneSidedBid.spread).toBeNull();
    expect(oneSidedBid.spreadTicks).toBeNull();

    const oneSidedAsk = buildFlowLiveDom(
      baseInput({ asks: [[6012.5, 20]], bids: [], volumeByPrice: [] })
    );
    expect(oneSidedAsk.bookState).toBe("one_sided");
    expect(oneSidedAsk.mid).toBe(6012.5);

    const emptyAll = buildFlowLiveDom(
      baseInput({
        asks: [],
        bids: [],
        lastTrade: null,
        volumeByPrice: [],
      })
    );
    expect(emptyAll.bookState).toBe("empty");
    expect(emptyAll.rows).toEqual([]);
    expect(emptyAll.totals.bidSharePct).toBeNull();

    const emptyBookWithLastTrade = buildFlowLiveDom(
      baseInput({
        asks: [],
        bids: [],
        lastTrade: {
          price: 6012.5,
          side: "unsigned",
          size: 2,
          t: "2026-11-24T14:30:00.000Z",
        },
        volumeByPrice: [],
      })
    );
    expect(emptyBookWithLastTrade.rows.map((r) => r.price)).toEqual([6012.5]);
    expect(emptyBookWithLastTrade.rows[0]?.isLastTrade).toBe(true);

    const emptyBookWithVolumeOnly = buildFlowLiveDom(
      baseInput({
        asks: [],
        bids: [],
        lastTrade: null,
        volumeByPrice: [[6012.0, 10, 5, 0, 2]],
      })
    );
    expect(emptyBookWithVolumeOnly.pocPrice).toBe(6012);
    expect(emptyBookWithVolumeOnly.rows.map((r) => r.price)).toEqual([6012]);
  });

  it("caps ladders over 80 ticks around mid, clamps near zero, and tie-breaks POC", () => {
    const wide = buildFlowLiveDom(
      baseInput({
        asks: [[6050.0, 10]],
        bids: [[6000.0, 10]],
        volumeByPrice: [
          [6025.5, 50, 50, 0, 10], // dist 2 ticks above mid 6025
          [6024.5, 50, 50, 0, 10], // dist 2 ticks below mid 6025 -> higher price 6025.5 wins tie
          [6026.0, 50, 50, 0, 10], // dist 4 ticks -> loses to dist 2
        ],
      })
    );
    expect(wide.rows).toHaveLength(FLOW_LIVE_DOM_MAX_LEVELS);
    expect(wide.pocPrice).toBe(6025.5);

    const closerWins = buildFlowLiveDom(
      baseInput({
        asks: [[6025.25, 10]],
        bids: [[6025.0, 10]],
        volumeByPrice: [
          [6026.0, 50, 50, 0, 10],
          [6025.25, 50, 50, 0, 10],
        ],
      })
    );
    expect(closerWins.pocPrice).toBe(6025.25);

    const nearZero = buildFlowLiveDom(
      baseInput({
        asks: [[15.0, 10]],
        bids: [[0.5, 10]],
        minTick: 0.25,
        volumeByPrice: [[25.0, 5, 5, 0, 1]],
      })
    );
    expect(nearZero.rows).toHaveLength(FLOW_LIVE_DOM_MAX_LEVELS);
    expect(nearZero.rows.at(-1)?.tickIndex).toBe(1);
  });
});
