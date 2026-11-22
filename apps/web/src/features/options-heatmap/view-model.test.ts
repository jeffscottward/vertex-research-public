import type {
  GreekHeatmapMetricData,
  GreekHeatmapOutput,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";
import {
  buildHeatmapGridView,
  cellBackground,
  formatDistancePct,
  formatExpiryShort,
  formatExposure,
  formatExposureFull,
  formatPrice,
  formatStrike,
  GREEK_HEATMAP_TABS,
  nextTabIndex,
} from "./view-model.ts";

const baseMetric = (
  overrides: Partial<GreekHeatmapMetricData> = {}
): GreekHeatmapMetricData => ({
  expiryTotals: [1_500_000, -500_000],
  grandTotal: 1_000_000,
  marks: {
    callWall: 610,
    flip: 602.5,
    kingStrike: 610,
    putWall: 595,
  },
  message: null,
  rows: [
    { strike: 610, total: 2_400_000, values: [2_000_000, 400_000] },
    { strike: 605, total: 300_000, values: [300_000, null] },
    { strike: 600, total: -100_000, values: [-50_000, -50_000] },
    { strike: 595, total: -1_600_000, values: [-750_000, -850_000] },
  ],
  status: "ok",
  ...overrides,
});

const sampleOutput = (
  overrides: Partial<GreekHeatmapOutput> = {}
): GreekHeatmapOutput => ({
  expiries: [
    { dte: 1, expiry: "2026-11-23" },
    { dte: 28, expiry: "2026-12-20" },
  ],
  message: null,
  metrics: {
    charm: baseMetric({
      marks: { callWall: 605, flip: null, kingStrike: 605, putWall: 595 },
    }),
    dex: baseMetric({
      marks: { callWall: 610, flip: null, kingStrike: 610, putWall: null },
    }),
    gex: baseMetric(),
    vex: baseMetric({
      marks: { callWall: 610, flip: null, kingStrike: 610, putWall: 595 },
    }),
    volumeGex: baseMetric({
      marks: { callWall: 605, flip: 600, kingStrike: 605, putWall: 595 },
    }),
  },
  notes: ["Research view only."],
  rateLimited: false,
  receivedAt: "2026-11-22T15:00:00.000Z",
  retryAfterSeconds: null,
  source: "quantdata",
  spot: 604.2,
  status: "ok",
  symbol: "SPY",
  ...overrides,
});

describe("greek heatmap formatting helpers", () => {
  it("formats compact and full signed exposure values across scales", () => {
    expect(formatExposure(null)).toBe("");
    expect(formatExposure(0)).toBe("$0");
    expect(formatExposure(0.2)).toBe("$0");
    expect(formatExposure(420)).toBe("+$420");
    expect(formatExposure(-420)).toBe("−$420");
    expect(formatExposure(15_400)).toBe("+$15K");
    expect(formatExposure(-450_000)).toBe("−$450K");
    expect(formatExposure(4_250_000)).toBe("+$4.3M");
    expect(formatExposure(-1_850_000_000)).toBe("−$1.85B");

    expect(formatExposureFull(0)).toBe("$0");
    expect(formatExposureFull(125_400)).toBe("+$125,400");
    expect(formatExposureFull(-125_400)).toBe("−$125,400");
  });

  it("formats strikes, prices, short expiry dates and spot distances", () => {
    expect(formatStrike(610)).toBe("610");
    expect(formatStrike(610.5)).toBe("610.50");
    expect(formatPrice(604.2)).toBe("$604.20");
    expect(formatExpiryShort("2026-11-23")).toBe("Nov 23");
    expect(formatDistancePct(610, null)).toBeNull();
    expect(formatDistancePct(610, 0)).toBeNull();
    expect(formatDistancePct(604.2, 604.2)).toBe("at spot");
    expect(formatDistancePct(610, 600)).toBe("+1.7%");
    expect(formatDistancePct(590, 600)).toBe("−1.7%");
  });

  it("computes diverging semantic backgrounds with theme tokens", () => {
    expect(cellBackground(null, 100)).toBeUndefined();
    expect(cellBackground(0, 100)).toBeUndefined();
    expect(cellBackground(100, 0)).toBeUndefined();
    expect(cellBackground(100, 100)).toBe(
      "color-mix(in oklab, var(--color-success) 42%, transparent)"
    );
    expect(cellBackground(-100, 100)).toBe(
      "color-mix(in oklab, var(--color-destructive) 42%, transparent)"
    );
    expect(cellBackground(50, 100)).toContain("var(--color-success)");
  });

  it("computes WAI-ARIA tab keyboard navigation indices", () => {
    expect(GREEK_HEATMAP_TABS).toHaveLength(5);
    expect(nextTabIndex(0, "ArrowRight", 5)).toBe(1);
    expect(nextTabIndex(4, "ArrowRight", 5)).toBe(0);
    expect(nextTabIndex(0, "ArrowLeft", 5)).toBe(4);
    expect(nextTabIndex(2, "Home", 5)).toBe(0);
    expect(nextTabIndex(2, "End", 5)).toBe(4);
    expect(nextTabIndex(2, "Enter", 5)).toBeNull();
  });
});

describe("buildHeatmapGridView", () => {
  it("places king, call wall, put wall, spot divider and flip divider on the GEX ladder", () => {
    const view = buildHeatmapGridView(sampleOutput(), "gex");
    expect(view.tab.id).toBe("gex");
    expect(view.maxAbsCell).toBe(2_000_000);
    expect(view.flipLabel).toBe("Gamma flip");
    expect(view.flipIsReference).toBe(false);
    expect(view.flipLevel).toBe(602.5);
    expect(view.kingValue).toBe(2_400_000);
    expect(view.callWallValue).toBe(2_400_000);
    expect(view.putWallValue).toBe(-1_600_000);

    // 610: king + call wall
    expect(view.rows[0]).toMatchObject({
      barWidthPct: 100,
      flipPosition: null,
      isCallWall: true,
      isKing: true,
      isPutWall: false,
      spotPosition: null,
      strike: 610,
    });
    // 605: spot 604.2 sits between 605 and 600; flip 602.5 also sits between 605 and 600, ordered descending!
    expect(view.rows[1]).toMatchObject({
      dividers: [
        { kind: "spot", label: "Spot $604.20", price: 604.2 },
        { kind: "flip", label: "Gamma flip $602.50", price: 602.5 },
      ],
      flipPosition: "below",
      spotPosition: "below",
      strike: 605,
    });
    // 595: put wall
    expect(view.rows[3]).toMatchObject({
      isPutWall: true,
      strike: 595,
    });

    // Negative-gamma regime: flip (604.5) > spot (601.2) between 605 and 600 -> Flip renders above Spot.
    const flipAbove = buildHeatmapGridView(
      sampleOutput({
        metrics: {
          ...sampleOutput().metrics,
          gex: baseMetric({
            marks: {
              callWall: 610,
              flip: 604.5,
              kingStrike: 610,
              putWall: 595,
            },
          }),
        },
        spot: 601.2,
      }),
      "gex"
    );
    expect(flipAbove.rows[1]?.dividers.map((d) => d.kind)).toEqual([
      "flip",
      "spot",
    ]);

    // Epsilon boundary: level within 1e-6 above nextStrike gets only "at" on next row, never "below" on row above.
    const nearBoundary = buildHeatmapGridView(
      sampleOutput({ spot: 600 + 5e-7 }),
      "gex"
    );
    expect(nearBoundary.rows[1]?.spotPosition).toBeNull();
    expect(nearBoundary.rows[2]?.spotPosition).toBe("at");
  });

  it("uses GEX flip as reference on VEX/Charm/DEX and labels Vol-GEX flip on volumeGex", () => {
    const vexView = buildHeatmapGridView(sampleOutput(), "vex");
    expect(vexView.flipLabel).toBe("GEX flip (ref.)");
    expect(vexView.flipIsReference).toBe(true);
    expect(vexView.flipLevel).toBe(602.5);

    const volView = buildHeatmapGridView(sampleOutput(), "volumeGex");
    expect(volView.flipLabel).toBe("Vol-GEX flip");
    expect(volView.flipIsReference).toBe(false);
    expect(volView.flipLevel).toBe(600);
    // Flip 600 lands directly ON row strike 600.
    expect(volView.rows[2]?.flipPosition).toBe("at");
  });

  it("handles null marks, null totals, and missing spot/flip cleanly", () => {
    const emptyMarks = baseMetric({
      marks: { callWall: null, flip: null, kingStrike: null, putWall: null },
      rows: [{ strike: 600, total: null, values: [null, null] }],
    });
    const out = sampleOutput({
      metrics: {
        charm: emptyMarks,
        dex: emptyMarks,
        gex: emptyMarks,
        vex: emptyMarks,
        volumeGex: emptyMarks,
      },
      spot: null,
    });
    const view = buildHeatmapGridView(out, "gex");
    expect(view.flipLevel).toBeNull();
    expect(view.flipLabel).toBe("Gamma flip");
    expect(view.kingValue).toBeNull();
    expect(view.callWallValue).toBeNull();
    expect(view.putWallValue).toBeNull();
    expect(view.rows[0]?.barWidthPct).toBe(0);
    expect(view.rows[0]?.spotPosition).toBeNull();
    expect(view.rows[0]?.flipPosition).toBeNull();

    // Mark strike not in displayed rows falls back to null value.
    const offGrid = buildHeatmapGridView(
      sampleOutput({
        metrics: {
          ...sampleOutput().metrics,
          gex: baseMetric({
            marks: { callWall: 700, flip: null, kingStrike: 700, putWall: 500 },
          }),
        },
      }),
      "gex"
    );
    expect(offGrid.kingValue).toBeNull();
    expect(offGrid.callWallValue).toBeNull();
    expect(offGrid.putWallValue).toBeNull();
  });
});
