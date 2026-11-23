import { describe, expect, it } from "vitest";
import {
  FLOW_LIQUIDITY_HEATMAP_MAX_COLUMNS,
  FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS,
  FLOW_LIQUIDITY_HEATMAP_MAX_TRADES,
  FLOW_LIQUIDITY_HEATMAP_MAX_WALLS,
  FLOW_LIQUIDITY_HEATMAP_RULES_VERSION,
  FLOW_LIQUIDITY_HEATMAP_VERSION,
  type FlowFreshness,
} from "./contracts/flow.ts";
import {
  bookSnapshotsFailureNote,
  buildFlowLiquidityHeatmap,
  choosePriceStep,
  liquidityColumnSeconds,
  liquidityHeatmapAxis,
  percentile95,
  type StoredBookSnapshotInput,
  type StoredLargeTradeInput,
  sanitizeDepthSide,
} from "./flow-liquidity-heatmap-rules.ts";

const freshDepth: FlowFreshness = {
  ageSeconds: 5,
  lastOkAt: "2026-11-23T15:00:00.000Z",
  lastStatus: "ok" as const,
  message: "streamed depth ESZ6: 12 snapshots, 20 levels",
  sessionOpen: true,
  source: "depth" as const,
  state: "fresh" as const,
};

const makeSnap = (
  overrides: Partial<StoredBookSnapshotInput> = {}
): StoredBookSnapshotInput => ({
  askPrices: [6000.25, 6000.5],
  askSizes: [30, 80],
  bestAsk: 6000.25,
  bestBid: 6000,
  bidPrices: [6000, 5999.75],
  bidSizes: [25, 60],
  capture: "streamed",
  capturedAt: new Date("2026-11-23T14:55:00.000Z"),
  contract: "ESZ6",
  minTick: 0.25,
  ...overrides,
});

describe("sanitizeDepthSide", () => {
  it("filters non-finite, zero, and negative levels, scales size, and caps at 20 levels", () => {
    const raw = [
      { price: 0, size: 10 },
      { price: -5, size: 10 },
      { price: Number.NaN, size: 10 },
      { price: 6000, size: 0 },
      { price: 6000, size: -2 },
      { price: 6000, size: Number.POSITIVE_INFINITY },
      ...Array.from({ length: 25 }, (_, i) => ({
        price: 6000 - i * 0.25,
        size: i + 1,
      })),
    ];
    const clean = sanitizeDepthSide(raw, 2);
    expect(clean.prices).toHaveLength(20);
    expect(clean.sizes).toHaveLength(20);
    expect(clean.best).toBe(6000);
    expect(clean.sizes[0]).toBe(2);
    expect(clean.sizes[19]).toBe(40);
  });

  it("defaults invalid sizeMultiplier to 1 and returns null best when empty", () => {
    expect(sanitizeDepthSide([{ price: 6000, size: 5 }], 0)).toEqual({
      best: 6000,
      prices: [6000],
      sizes: [5],
    });
    expect(sanitizeDepthSide([], Number.NaN)).toEqual({
      best: null,
      prices: [],
      sizes: [],
    });
  });
});

describe("liquidityColumnSeconds and liquidityHeatmapAxis", () => {
  it("maps streamed and sampled windows to <= 240 columns", () => {
    expect(liquidityColumnSeconds(15, true)).toBe(5);
    expect(liquidityColumnSeconds(30, true)).toBe(10);
    expect(liquidityColumnSeconds(60, true)).toBe(15);
    expect(liquidityColumnSeconds(120, true)).toBe(30);
    expect(liquidityColumnSeconds(240, true)).toBe(60);
    expect(liquidityColumnSeconds(390, true)).toBe(120);
    expect(liquidityColumnSeconds(60, false)).toBe(60);
    expect(liquidityColumnSeconds(120, false)).toBe(60);
    expect(liquidityColumnSeconds(240, false)).toBe(120);
    expect(liquidityColumnSeconds(390, false)).toBe(180);

    for (const minutes of [15, 30, 60, 120, 240, 390]) {
      for (const streamed of [true, false]) {
        const colSec = liquidityColumnSeconds(minutes, streamed);
        const axis = liquidityHeatmapAxis(
          new Date("2026-11-23T15:00:07.000Z"),
          minutes,
          colSec
        );
        expect(axis.totalColumns).toBeLessThanOrEqual(
          FLOW_LIQUIDITY_HEATMAP_MAX_COLUMNS
        );
        expect(axis.totalColumns).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe("choosePriceStep and percentile95", () => {
  it("picks smallest multiplier <= 80 buckets and falls back cleanly for extreme spans", () => {
    expect(choosePriceStep(6000, 6010, 0.25)).toBe(0.25);
    expect(choosePriceStep(6000, 6030, 0.25)).toBe(0.5);
    // Extreme range exceeding 160 * 0.25 * 79 = 3160 triggers dynamic fallback
    const extremeStep = choosePriceStep(10_000, 15_000, 0.25);
    const low = Math.floor(10_000 / extremeStep) * extremeStep;
    const high = Math.floor(15_000 / extremeStep) * extremeStep;
    expect(Math.round((high - low) / extremeStep) + 1).toBeLessThanOrEqual(
      FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS
    );
    // Boundary misalignment where floor(min) + floor(max) adds an extra bucket
    const alignedStep = choosePriceStep(10_000.25, 13_950, 0.25);
    const low2 = Math.floor(10_000.25 / alignedStep) * alignedStep;
    const high2 = Math.floor(13_950 / alignedStep) * alignedStep;
    expect(Math.round((high2 - low2) / alignedStep) + 1).toBeLessThanOrEqual(
      FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS
    );
  });

  it("computes nearest-rank p95 and returns 0 when empty or non-positive", () => {
    expect(percentile95([])).toBe(0);
    expect(percentile95([0, -5, Number.NaN])).toBe(0);
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile95(values)).toBe(95);
  });
});

describe("buildFlowLiquidityHeatmap", () => {
  const now = new Date("2026-11-23T15:00:00.000Z");
  const windowStart = new Date("2026-11-23T14:45:00.000Z");

  it("returns honest empty none state when no snapshots or trades exist", () => {
    const out = buildFlowLiquidityHeatmap({
      depth: freshDepth,
      largeTrades: [],
      minutes: 15,
      now,
      snapshots: [],
      symbol: "ES",
      windowEnd: now,
      windowStart,
    });
    expect(out.schemaVersion).toBe(FLOW_LIQUIDITY_HEATMAP_VERSION);
    expect(out.rules.version).toBe(FLOW_LIQUIDITY_HEATMAP_RULES_VERSION);
    expect(out.capture).toBe("none");
    expect(out.contract).toBeNull();
    expect(out.priceLevels).toEqual([]);
    expect(out.priceMin).toBeNull();
    expect(out.priceMax).toBeNull();
    expect(out.currentDom).toEqual([]);
    expect(out.walls).toEqual([]);
    expect(out.totals.recordedColumns).toBe(0);
    expect(out.totals.coveragePct).toBe(0);
    expect(out.columns.every((c) => c.state === "no_data")).toBe(true);
  });

  it("handles streamed/sampled precedence, mixed capture, coarse bid/ask merging, one-sided books, wall tie-breakers, and trade truncation", () => {
    const snapSampledEarlier = makeSnap({
      askPrices: [6000.25],
      askSizes: [10],
      bestAsk: 6000.25,
      bestBid: 6000,
      bidPrices: [6000],
      bidSizes: [15],
      capture: "sampled",
      capturedAt: new Date("2026-11-23T14:55:00.000Z"),
    });
    const snapStreamedSameBucket = makeSnap({
      askPrices: [6000.25, 6030],
      askSizes: [50, 50],
      bestAsk: 6000.25,
      bestBid: 6000,
      bidPrices: [6000, 5970],
      bidSizes: [50, 50],
      capture: "streamed",
      capturedAt: new Date("2026-11-23T14:55:01.000Z"),
    });
    const snapSampledLaterSameBucket = makeSnap({
      capture: "sampled",
      capturedAt: new Date("2026-11-23T14:55:04.000Z"),
    });
    const snapStreamedNewerSameBucket = makeSnap({
      askPrices: [6000.25, 6030],
      askSizes: [40, 40],
      bestAsk: 6000.25,
      bestBid: 6000,
      bidPrices: [6000, 5970],
      bidSizes: [40, 40],
      capture: "streamed",
      capturedAt: new Date("2026-11-23T14:55:02.000Z"),
    });
    const snapStreamedOlderSameBucket = makeSnap({
      capture: "streamed",
      capturedAt: new Date("2026-11-23T14:55:00.500Z"),
    });
    // One-sided snapshot in a later column + out-of-range snapshot ignored
    const oneSidedLater = makeSnap({
      askPrices: [6000.5, 6001.5, 6002.5, 6003.5, 6004.5, 6005.5],
      askSizes: [40, 40, 20, 20, 10, 10],
      bestAsk: 6000.5,
      bestBid: null,
      bidPrices: [],
      bidSizes: [],
      capture: "streamed",
      capturedAt: new Date("2026-11-23T14:56:00.000Z"),
    });
    const outOfRange = makeSnap({
      capturedAt: new Date("2026-11-23T12:00:00.000Z"),
    });

    // 505 trades in window + 1 out of window -> keeps newest 500
    const largeTrades: StoredLargeTradeInput[] = [
      {
        capture: "streamed",
        price: 5999,
        second: new Date("2026-11-23T12:00:00.000Z"),
        seq: 0,
        side: "buy",
        signing: "quote",
        size: 50,
      },
      ...Array.from(
        { length: FLOW_LIQUIDITY_HEATMAP_MAX_TRADES + 5 },
        (_, i) => ({
          capture: "streamed" as const,
          price: 6000 + (i % 4) * 0.25,
          second: new Date(
            new Date("2026-11-23T14:50:00.000Z").getTime() +
              Math.floor(i / 2) * 1000
          ),
          seq: i % 2,
          side: i % 2 === 0 ? ("buy" as const) : ("sell" as const),
          signing: i % 3 === 0 ? ("tick" as const) : ("quote" as const),
          size: 40 + (i % 10),
        })
      ),
    ];

    const out = buildFlowLiquidityHeatmap({
      depth: freshDepth,
      largeTrades,
      minutes: 15,
      now,
      snapshots: [
        snapSampledEarlier,
        snapStreamedSameBucket,
        snapSampledLaterSameBucket,
        snapStreamedNewerSameBucket,
        snapStreamedOlderSameBucket,
        oneSidedLater,
        outOfRange,
      ],
      symbol: "ES",
      windowEnd: now,
      windowStart,
    });

    expect(out.capture).toBe("mixed");
    expect(out.columnSeconds).toBe(5);
    // 60-point span (5970..6030) forces priceStep >= 1.0 so 6000 & 6000.25 share a bucket -> side: "both"
    expect(out.priceStep).toBeGreaterThanOrEqual(1);
    const recorded = out.columns.filter((c) => c.state === "recorded");
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.capture).toBe("streamed");
    expect(recorded[0]?.cells.some((c) => c.side === "both")).toBe(true);
    // One-sided later column has mid === null
    expect(recorded[1]?.mid).toBeNull();
    expect(recorded[1]?.bestBid).toBeNull();
    expect(recorded[1]?.bestAsk).toBe(6000.5);
    // Trade truncation keeps newest 500
    expect(out.tradesTruncated).toBe(true);
    expect(out.trades).toHaveLength(FLOW_LIQUIDITY_HEATMAP_MAX_TRADES);
    expect(out.totals.largeTrades).toBe(FLOW_LIQUIDITY_HEATMAP_MAX_TRADES + 5);
    // Walls capped at <= 10 and sorted deterministically
    expect(out.walls.length).toBeLessThanOrEqual(
      FLOW_LIQUIDITY_HEATMAP_MAX_WALLS
    );
    expect(out.walls[0]?.size).toBe(40);
  });

  it("handles sampled-only capture and tie-breaking with non-null mid and bid/ask walls at same price", () => {
    const snap1 = makeSnap({
      askPrices: [6001, 6002, 6003],
      askSizes: [50, 50, 50],
      bestAsk: 6001,
      bestBid: 6000,
      bidPrices: [6000, 5999, 5998],
      bidSizes: [50, 50, 50],
      capture: "sampled",
      capturedAt: new Date("2026-11-23T14:55:00.000Z"),
    });
    // Wide span makes bid 6000 and ask 6001 share a bucket + another snapshot gives higher persistence
    const snap2 = makeSnap({
      askPrices: [6000.25, 6040],
      askSizes: [50, 50],
      bestAsk: 6000.25,
      bestBid: 6000,
      bidPrices: [6000, 5960],
      bidSizes: [50, 50],
      capture: "sampled",
      capturedAt: new Date("2026-11-23T14:56:00.000Z"),
    });
    const out = buildFlowLiquidityHeatmap({
      depth: freshDepth,
      largeTrades: [],
      minutes: 15,
      now,
      snapshots: [snap1, snap2],
      symbol: "NQ",
      windowEnd: now,
      windowStart,
    });
    expect(out.capture).toBe("sampled");
    expect(out.columnSeconds).toBe(60);
    expect(out.rules.largeTradeLimit).toBe(10);
    expect(out.walls.length).toBeGreaterThan(0);
    expect(out.currentDom.some((d) => d.bidSize > 0 && d.askSize > 0)).toBe(
      true
    );
  });

  it("handles out-of-order snapshot inputs when selecting newest snapshot", () => {
    const later = makeSnap({
      capturedAt: new Date("2026-11-23T14:58:00.000Z"),
      contract: "ESZ6",
    });
    const earlier = makeSnap({
      capturedAt: new Date("2026-11-23T14:55:00.000Z"),
      contract: "ESZ6",
    });
    const out = buildFlowLiquidityHeatmap({
      depth: freshDepth,
      largeTrades: [],
      minutes: 15,
      now,
      snapshots: [later, earlier],
      symbol: "ES",
      windowEnd: now,
      windowStart,
    });
    expect(out.totals.recordedColumns).toBe(2);
    expect(out.contract).toBe("ESZ6");
  });

  it("formats bookSnapshotsFailureNote for tagged storage errors, plain errors, and non-errors", () => {
    const tagged = Object.assign(new Error("wrapped"), {
      causeName: "DatabaseError",
    });
    expect(bookSnapshotsFailureNote(tagged)).toBe(
      "; book snapshots not stored (DatabaseError)"
    );
    expect(bookSnapshotsFailureNote(new TypeError("bad"))).toBe(
      "; book snapshots not stored (TypeError)"
    );
    expect(bookSnapshotsFailureNote("boom")).toBe(
      "; book snapshots not stored (string)"
    );
  });
});
