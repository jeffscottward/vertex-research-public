import { describe, expect, it } from "vitest";

import { labFlowSnapshot } from "../../lab/fixtures/flow.ts";
import { MISSING } from "./format.ts";
import {
  basisNote,
  bookMetrics,
  buildFlowChart,
  CHART_HEIGHT,
  CHART_SLOT_WIDTH,
  coverageText,
  eventRows,
  type FlowFreshness,
  type FlowGex,
  type FlowMinute,
  type FlowOptionPrint,
  freshnessRows,
  gexLevelRows,
  gexMetrics,
  neverCollected,
  optionPrintRows,
  optionsMetrics,
  orderFlowMetrics,
  pressureText,
  windowLabel,
} from "./view-model.ts";

const spy = labFlowSnapshot("SPY", 120);
const es = labFlowSnapshot("ES", 120);

const freshness = (overrides: Partial<FlowFreshness>): FlowFreshness => ({
  ageSeconds: null,
  lastOkAt: null,
  lastStatus: null,
  message: null,
  sessionOpen: false,
  source: "ticks",
  state: "never",
  ...overrides,
});

const minute = (
  at: string,
  overrides: Partial<FlowMinute> = {}
): FlowMinute => ({
  bearishPremium: 0,
  bookPressure: null,
  bullishPremium: 0,
  buyVolume: 0,
  callPremium: 0,
  close: null,
  coveredSeconds: 60,
  cvd: 0,
  delta: 0,
  minute: at,
  optionTrades: 0,
  putPremium: 0,
  sellVolume: 0,
  trades: 0,
  volume: 0,
  vwap: null,
  ...overrides,
});

const labels = (metrics: readonly { label: string }[]) =>
  metrics.map((metric) => metric.label);
const metricValue = (
  metrics: readonly { label: string; value: string }[],
  label: string
) => metrics.find((metric) => metric.label === label)?.value;

describe("flow view model", () => {
  it("labels the window choices", () => {
    expect(windowLabel(60)).toBe("60 min");
    expect(windowLabel(390)).toBe("390 min (full session)");
  });

  it("orders freshness rows by source and describes each", () => {
    const rows = freshnessRows([
      freshness({ source: "gex" }),
      freshness({
        ageSeconds: 75,
        lastOkAt: "2026-11-06T15:42:00.000Z",
        lastStatus: "ok",
        source: "ticks",
        state: "fresh",
      }),
      freshness({
        ageSeconds: 4000,
        lastOkAt: "2026-11-06T14:00:00.000Z",
        lastStatus: "unavailable",
        message: "vertex-history timed out",
        source: "depth",
        state: "stale",
      }),
      freshness({ ageSeconds: 30, source: "options", state: "closed" }),
    ]);
    expect(rows.map((row) => row.source)).toEqual([
      "ticks",
      "depth",
      "options",
      "gex",
    ]);
    expect(rows[0]).toMatchObject({
      age: "1m ago",
      label: "Ticks",
      lastOk: "Nov 6, 10:42 AM EST",
      lastStatus: "ok",
      tone: "success",
    });
    expect(rows[1]).toMatchObject({
      age: "1h 6m ago",
      message: "vertex-history timed out",
      tone: "warning",
    });
    expect(rows[2]?.tone).toBe("info");
    expect(rows[3]).toMatchObject({
      age: "never collected",
      lastOk: MISSING,
      lastStatus: "no samples yet",
      message: null,
      tone: "neutral",
    });
  });

  it("detects a symbol that was never collected", () => {
    expect(neverCollected([freshness({}), freshness({ source: "gex" })])).toBe(
      true
    );
    expect(neverCollected(spy.freshness)).toBe(false);
  });

  it("describes sampled coverage", () => {
    expect(coverageText(2240, 7200)).toBe("37m 20s of 2h (31%)");
    expect(coverageText(0, 0)).toBe(MISSING);
  });

  it("lists order-flow metrics, with off-exchange share for SPY only", () => {
    const spyMetrics = orderFlowMetrics(spy.orderFlow, "SPY");
    expect(labels(spyMetrics)).toContain("Off-exchange share");
    expect(metricValue(spyMetrics, "Off-exchange share")).toBe("41%");
    expect(metricValue(spyMetrics, "Large prints")).toBe("3");
    expect(labels(orderFlowMetrics(es.orderFlow, "ES"))).not.toContain(
      "Off-exchange share"
    );
  });

  it("describes book pressure", () => {
    expect(pressureText(null)).toBe(MISSING);
    expect(pressureText(0.24)).toBe("+0.24 (bid-heavy)");
    expect(pressureText(-0.3)).toBe("−0.30 (ask-heavy)");
    expect(pressureText(0.04)).toBe("+0.04 (balanced)");
    const book = spy.orderFlow.book;
    if (book === null) throw new Error("fixture has a book");
    const metrics = bookMetrics(book);
    expect(metricValue(metrics, "Best bid")).toBe("683.40 × 1.3K");
    expect(metricValue(metrics, "Levels")).toBe("10");
  });

  it("lists options metrics", () => {
    const metrics = optionsMetrics(spy.optionsFlow);
    expect(metricValue(metrics, "Call premium")).toBe("$5.6M");
    expect(metricValue(metrics, "Put/call premium")).toBe("0.66");
    expect(metricValue(metrics, "Sweeps")).toBe("11 · $2.6M");
    expect(metricValue(metrics, "Blocks")).toBe("3 · $1.2M");
    expect(metricValue(metrics, "0DTE share")).toBe("44%");
  });

  it("formats top option prints with their flags", () => {
    const [call, put] = spy.optionsFlow.topPrints as [
      FlowOptionPrint,
      FlowOptionPrint,
    ];
    const rows = optionPrintRows([call, put, { ...put, moneyness: "unknown" }]);
    expect(rows[0]).toMatchObject({
      flags: ["OTM", "golden sweep", "unusual", "vol>OI", "opening"],
      premium: "$1.4M",
      right: "C",
      side: "At ask",
      tone: "success",
    });
    expect(rows[1]).toMatchObject({
      flags: ["OTM"],
      right: "P",
      tone: "destructive",
    });
    expect(rows[2]?.flags).toEqual([]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });

  it("shows GEX levels in symbol and underlying price", () => {
    const gex = es.gex as FlowGex;
    const rows = gexLevelRows(gex);
    expect(rows.map((row) => row.label)).toEqual([
      "Gamma flip",
      "Call wall",
      "Put wall",
      "Max pain",
    ]);
    expect(rows[0]).toMatchObject({
      symbolPrice: "6,858.50",
      underlyingPrice: "6,840.00",
    });
    expect(
      gexLevelRows({ ...gex, symbolLevels: null }).map((row) => row.symbolPrice)
    ).toEqual([MISSING, MISSING, MISSING, MISSING]);
    const metrics = gexMetrics(gex);
    expect(metricValue(metrics, "Regime")).toContain("Positive gamma");
    expect(metricValue(metrics, "Net DEX")).toBe("$3.1B");
    expect(metricValue(metrics, "IV regime")).toContain("Contango");
    expect(labels(metrics)).toContain("SPX spot");
  });

  it("explains the basis between the symbol and the options underlying", () => {
    const gex = es.gex as FlowGex;
    expect(basisNote("SPY", spy.gex as FlowGex)).toBe(
      "Levels come from SPY options, already in SPY price."
    );
    expect(basisNote("ES", gex)).toBe(
      "Levels come from SPX options, shifted into ES price by the ES − SPX basis of +18.50."
    );
    expect(basisNote("ES", { ...gex, basis: null })).toContain(
      "basis is unknown"
    );
  });

  it("labels events", () => {
    const rows = eventRows(spy.events);
    expect(rows[0]).toMatchObject({
      direction: "bullish",
      kind: "Option sweep",
      time: "3:56 PM EDT",
      tone: "success",
    });
    expect(rows[1]).toMatchObject({ kind: "Large print", tone: "neutral" });
  });
});

describe("flow minute chart", () => {
  const range = {
    windowEnd: "2026-11-06T15:09:00.000Z",
    windowStart: "2026-11-06T15:00:00.000Z",
  };

  it("returns null without a sampled minute", () => {
    expect(buildFlowChart({ ...range, minutes: [] })).toBeNull();
    expect(
      buildFlowChart({
        ...range,
        minutes: [minute("2026-11-06T15:01:00.000Z", { coveredSeconds: 0 })],
      })
    ).toBeNull();
  });

  it("lays minutes on the window axis with gaps for unsampled minutes", () => {
    const chart = buildFlowChart({
      ...range,
      minutes: [
        // Outside the window: ignored.
        minute("2026-11-06T14:50:00.000Z", { cvd: 999, delta: 999 }),
        minute("2026-11-06T15:00:00.000Z", { cvd: 100, delta: 100 }),
        minute("2026-11-06T15:01:00.000Z", { cvd: 50, delta: -50 }),
        // Zero coverage counts as a gap.
        minute("2026-11-06T15:02:00.000Z", { coveredSeconds: 0, delta: 7 }),
        minute("2026-11-06T15:05:00.000Z", { cvd: 70, delta: 20 }),
        minute("2026-11-06T15:07:00.000Z", { cvd: -30, delta: -100 }),
        minute("2026-11-06T15:08:00.000Z", { cvd: -10, delta: 20 }),
        minute("2026-11-06T15:09:00.000Z", { cvd: 0, delta: 10 }),
        minute("2026-11-06T15:30:00.000Z", { cvd: 5, delta: 5 }),
      ],
    });
    if (chart === null) throw new Error("expected a chart");
    expect(chart.slots).toBe(10);
    expect(chart.width).toBe(10 * CHART_SLOT_WIDTH);
    expect(chart.height).toBe(CHART_HEIGHT);
    expect(chart.covered).toBe(6);
    expect(chart.maxAbsDelta).toBe(100);
    expect(chart.lastCvd).toBe(0);
    expect(chart.bars.map((bar) => bar.positive)).toEqual([
      true,
      false,
      true,
      false,
      true,
      true,
    ]);
    const [up, down] = chart.bars;
    expect(up?.y).toBe(chart.zeroY - (up?.height ?? 0));
    expect(down?.y).toBe(chart.zeroY);
    expect(chart.gaps).toEqual([
      { width: 3 * CHART_SLOT_WIDTH, x: 2 * CHART_SLOT_WIDTH },
      { width: CHART_SLOT_WIDTH, x: 6 * CHART_SLOT_WIDTH },
    ]);
    expect(chart.cvdSegments).toHaveLength(3);
    // The lone 15:05 minute draws a short tick (two points at one height).
    const tick = (chart.cvdSegments[1] ?? "").split(" ");
    expect(tick).toHaveLength(2);
    expect(tick[0]?.split(",")[1]).toBe(tick[1]?.split(",")[1]);
    expect(chart.startLabel).toBe("10:00 AM EST");
    expect(chart.endLabel).toBe("10:09 AM EST");
  });

  it("closes a trailing gap and keeps a flat CVD line in range", () => {
    const chart = buildFlowChart({
      ...range,
      minutes: [minute("2026-11-06T15:00:00.000Z")],
    });
    if (chart === null) throw new Error("expected a chart");
    expect(chart.maxAbsDelta).toBe(1);
    expect(chart.gaps).toEqual([
      { width: 9 * CHART_SLOT_WIDTH, x: CHART_SLOT_WIDTH },
    ]);
    expect(chart.cvdZeroY).toBeGreaterThan(0);
    expect(chart.cvdZeroY).toBeLessThan(CHART_HEIGHT);
  });
});
