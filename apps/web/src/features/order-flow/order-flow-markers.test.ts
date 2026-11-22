import type { FlowSnapshotEvent } from "@darkfactory/api";
import { describe, expect, it } from "vitest";
import type { DisplayCandle } from "../charts/types.ts";
import { buildFootprint } from "./footprint.ts";
import {
  flowEventsToChartMarkers,
  matchEventsToFootprint,
} from "./order-flow-markers.ts";

const T0 = Date.UTC(2026, 10, 9, 15, 0, 0);

const candle = (
  minuteOffset: number,
  low: number,
  high: number
): DisplayCandle => ({
  close: (low + high) / 2,
  high,
  id: String(minuteOffset),
  low,
  open: (low + high) / 2,
  timestamp: T0 + minuteOffset * 60_000,
  volume: 1000,
});

const flowEvent = (
  overrides: Partial<FlowSnapshotEvent> & {
    at: string;
    kind: FlowSnapshotEvent["kind"];
  }
): FlowSnapshotEvent => ({
  detail: "test event",
  direction: "bullish",
  premium: null,
  price: 100.5,
  size: null,
  ...overrides,
});

describe("flowEventsToChartMarkers", () => {
  it("maps stacked_imbalance and absorption events onto candles, groups per bar, stacks same-side marks, and ignores other kinds", () => {
    const candles = [candle(0, 100, 102), candle(5, 101, 104)];
    const events: FlowSnapshotEvent[] = [
      // Ignored non-marker kind.
      flowEvent({
        at: new Date(T0 + 60_000).toISOString(),
        kind: "large_print",
      }),
      // Two bullish stacked imbalances in the first 5m bar -> aggregated to SI ×2.
      flowEvent({
        at: new Date(T0 + 60_000).toISOString(),
        detail: "1 stacked buy imbalance",
        direction: "bullish",
        kind: "stacked_imbalance",
      }),
      flowEvent({
        at: new Date(T0 + 120_000).toISOString(),
        detail: "1 stacked buy imbalance",
        direction: "bullish",
        kind: "stacked_imbalance",
      }),
      // Bullish absorption on the same bar -> stacked below (stackOrder 1 vs 0).
      flowEvent({
        at: new Date(T0 + 180_000).toISOString(),
        detail: "Selling absorbed",
        direction: "bullish",
        kind: "absorption",
      }),
      // Bearish stacked imbalance and bearish absorption on bar 2.
      flowEvent({
        at: new Date(T0 + 6 * 60_000).toISOString(),
        detail: "1 stacked sell imbalance",
        direction: "bearish",
        kind: "stacked_imbalance",
      }),
      flowEvent({
        at: new Date(T0 + 7 * 60_000).toISOString(),
        detail: "Buying absorbed",
        direction: "bearish",
        kind: "absorption",
      }),
      // Neutral event on bar 2.
      flowEvent({
        at: new Date(T0 + 8 * 60_000).toISOString(),
        detail: "Neutral absorption",
        direction: "neutral",
        kind: "absorption",
      }),
      // Outside the loaded bar window and invalid timestamp.
      flowEvent({
        at: new Date(T0 - 60_000).toISOString(),
        kind: "stacked_imbalance",
      }),
      flowEvent({
        at: "not-a-timestamp",
        kind: "absorption",
      }),
    ];

    const result = flowEventsToChartMarkers(events, candles, 300);
    expect(result.shownEvents).toBe(6);
    expect(result.outsideEvents).toBe(2);
    expect(result.stackedBuy).toBe(2);
    expect(result.stackedSell).toBe(1);
    expect(result.absorptionSell).toBe(1);
    expect(result.absorptionBuy).toBe(1);
    expect(result.items).toHaveLength(8);
    expect(result.markers).toEqual([
      {
        id: `flow-absorption-bullish-${T0}`,
        position: "below",
        shape: "diamond",
        stackOrder: 0,
        text: "ABS",
        timestamp: T0,
        tone: "bullish",
        value: 100,
      },
      {
        id: `flow-stacked_imbalance-bullish-${T0}`,
        position: "below",
        shape: "arrow",
        stackOrder: 1,
        text: "SI ×2",
        timestamp: T0,
        tone: "bullish",
        value: 100,
      },
      {
        id: `flow-absorption-bearish-${T0 + 5 * 60_000}`,
        position: "above",
        shape: "diamond",
        stackOrder: 0,
        text: "ABS",
        timestamp: T0 + 5 * 60_000,
        tone: "bearish",
        value: 104,
      },
      {
        id: `flow-absorption-neutral-${T0 + 5 * 60_000}`,
        position: "above",
        shape: "diamond",
        stackOrder: 1,
        text: "ABS",
        timestamp: T0 + 5 * 60_000,
        tone: "neutral",
        value: 102.5,
      },
      {
        id: `flow-stacked_imbalance-bearish-${T0 + 5 * 60_000}`,
        position: "above",
        shape: "arrow",
        stackOrder: 2,
        text: "SI",
        timestamp: T0 + 5 * 60_000,
        tone: "bearish",
        value: 104,
      },
    ]);
  });

  it("handles empty candles cleanly", () => {
    const result = flowEventsToChartMarkers(
      [flowEvent({ at: new Date(T0).toISOString(), kind: "absorption" })],
      [],
      60
    );
    expect(result.markers).toEqual([]);
    expect(result.outsideEvents).toBe(1);
    expect(result.shownEvents).toBe(0);
  });

  it("excludes intraday gap/overnight events that fall after the matched candle ends", () => {
    // Two 5-minute RTH candles separated by an overnight gap (next day 09:30 ET).
    const day1Close = candle(0, 500, 502);
    const day2Open = {
      close: 505,
      high: 506,
      id: "day2",
      low: 504,
      open: 504.5,
      timestamp: T0 + 17 * 3_600_000,
      volume: 100,
    };
    const overnight = flowEvent({
      at: new Date(T0 + 5 * 3_600_000).toISOString(),
      detail: "Overnight Globex stacked buy",
      direction: "bullish",
      kind: "stacked_imbalance",
    });
    const inDay2 = flowEvent({
      at: new Date(day2Open.timestamp + 60_000).toISOString(),
      detail: "RTH stacked sell",
      direction: "bearish",
      kind: "stacked_imbalance",
    });
    const result = flowEventsToChartMarkers(
      [overnight, inDay2],
      [day1Close, day2Open],
      300
    );
    expect(result.shownEvents).toBe(1);
    expect(result.outsideEvents).toBe(1);
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0]?.timestamp).toBe(day2Open.timestamp);
  });

  it("accepts a neutral stacked_imbalance without incrementing buy or sell counts", () => {
    const result = flowEventsToChartMarkers(
      [
        flowEvent({
          at: new Date(T0).toISOString(),
          direction: "neutral",
          kind: "stacked_imbalance",
        }),
      ],
      [candle(0, 100, 102)],
      60
    );
    expect(result.shownEvents).toBe(1);
    expect(result.stackedBuy).toBe(0);
    expect(result.stackedSell).toBe(0);
    expect(result.markers).toEqual([
      expect.objectContaining({
        position: "above",
        shape: "arrow",
        text: "SI",
        tone: "neutral",
      }),
    ]);
  });
});

describe("matchEventsToFootprint", () => {
  it("matches stacked_imbalance and absorption events to footprint time buckets", () => {
    const tSec = Math.floor(T0 / 1000);
    const footprint = buildFootprint(
      [
        {
          ask: null,
          bid: null,
          conditions: null,
          method: "quote",
          price: 100.01,
          side: "buy",
          size: 10,
          t: tSec,
          venue: null,
        },
        {
          ask: null,
          bid: null,
          conditions: null,
          method: "quote",
          price: 100.02,
          side: "sell",
          size: 10,
          t: tSec + 65,
          venue: null,
        },
      ],
      { bucketSeconds: 60, priceStep: 0.01, tickSize: 0.01 }
    );
    expect(footprint).not.toBeNull();
    if (footprint === null) return;

    const matched = matchEventsToFootprint(
      [
        flowEvent({
          at: new Date(T0 + 10_000).toISOString(),
          kind: "large_print",
        }),
        flowEvent({ at: "bad-time", kind: "absorption" }),
        flowEvent({
          at: new Date(T0 - 60_000).toISOString(),
          kind: "stacked_imbalance",
        }),
        flowEvent({
          at: new Date(T0 + 15_000).toISOString(),
          direction: "bullish",
          kind: "stacked_imbalance",
        }),
        flowEvent({
          at: new Date(T0 + 25_000).toISOString(),
          direction: "bearish",
          kind: "absorption",
        }),
      ],
      footprint
    );
    expect(matched.matchedCount).toBe(2);
    const first = matched.byBucketStart.get(tSec);
    expect(first?.stackedImbalances).toHaveLength(1);
    expect(first?.absorptions).toHaveLength(1);
    expect(matched.byBucketStart.get(tSec + 60)).toBeUndefined();
  });
});
