import type { OptionsExpectedMoveOutput } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  barSpacing,
  CONE_CURVE_STEPS,
  expectedMoveConeFigures,
  expectedMoveOverlayData,
  expectedMoveTargetIndex,
  MAX_EXPECTED_MOVE_CONE_BARS,
  MIN_EXPECTED_MOVE_CONE_BARS,
  sameExpectedMoveCone,
  toExpectedMoveCone,
  validExpectedMoveCone,
  withAlpha,
} from "./expected-move-overlay.ts";
import type { ChartPalette, ExpectedMoveCone } from "./types.ts";

const DAY_MS = 86_400_000;

const palette: ChartPalette = {
  accent: "#feda00",
  background: "#0d1117",
  falling: "#8b949e",
  foreground: "#f0f6fc",
  grid: "#30363d",
  rising: "#f0f6fc",
  warning: "oklch(0.76 0.16 70)",
};

const baseCone: ExpectedMoveCone = {
  basis: "atm_straddle_mid",
  dte: 16,
  expectedMove: 25.6,
  expectedMovePct: 0.0426,
  expiry: "2026-11-20",
  expiryCloseMs: Date.parse("2026-11-20T21:00:00.000Z"),
  lowerBand: 574.4,
  spot: 600,
  straddleLower: 579.57,
  straddlePrice: 20.43,
  straddleUpper: 620.43,
  upperBand: 625.6,
};

describe("validExpectedMoveCone", () => {
  it("accepts valid quoted and IV-model cones and rejects malformed shapes", () => {
    expect(validExpectedMoveCone(baseCone)).toBe(true);
    expect(
      validExpectedMoveCone({
        ...baseCone,
        basis: "atm_iv_model",
        straddleLower: null,
        straddlePrice: null,
        straddleUpper: null,
      })
    ).toBe(true);
    expect(validExpectedMoveCone({ ...baseCone, expiry: "bad" })).toBe(false);
    expect(validExpectedMoveCone({ ...baseCone, dte: -1 })).toBe(false);
    expect(validExpectedMoveCone({ ...baseCone, upperBand: 599 })).toBe(false);
    expect(validExpectedMoveCone({ ...baseCone, straddleUpper: null })).toBe(
      false
    );
    expect(validExpectedMoveCone({ ...baseCone, straddlePrice: -1 })).toBe(
      false
    );
    expect(validExpectedMoveCone({ ...baseCone, straddleUpper: 599 })).toBe(
      false
    );
    expect(sameExpectedMoveCone(baseCone, baseCone)).toBe(true);
    expect(sameExpectedMoveCone(baseCone, { ...baseCone })).toBe(true);
    expect(sameExpectedMoveCone(baseCone, null)).toBe(false);
    expect(sameExpectedMoveCone(baseCone, { ...baseCone, dte: 99 })).toBe(
      false
    );
  });
});

describe("toExpectedMoveCone", () => {
  it("maps valid API output and returns null when output, band, or spot is missing", () => {
    expect(toExpectedMoveCone(null)).toBeNull();
    const apiOut: OptionsExpectedMoveOutput = {
      band: {
        atmIv: 0.24,
        atmStrike: 600,
        basis: "atm_straddle_mid",
        callPrice: 10.2,
        callQuoteSource: "ibkr",
        expectedMove: 25.6,
        expectedMovePct: 0.0426,
        expiryCloseAt: "2026-11-20T21:00:00.000Z",
        expiryCloseMs: baseCone.expiryCloseMs,
        lowerBand: 574.4,
        putPrice: 10.23,
        putQuoteSource: "ibkr",
        straddleLower: 579.57,
        straddlePct: 0.034_05,
        straddlePrice: 20.43,
        straddleUpper: 620.43,
        upperBand: 625.6,
      },
      currency: "USD",
      dte: 16,
      expiries: [{ date: "2026-11-20", dte: 16 }],
      expiriesSources: ["yahoo"],
      expiry: "2026-11-20",
      notes: ["Research view only."],
      quoteTime: null,
      receivedAt: "2026-11-04T15:00:00.000Z",
      sources: [
        { message: null, source: "quantdata", status: "off" },
        { message: null, source: "ibkr", status: "used" },
        { message: null, source: "yahoo", status: "used" },
      ],
      spot: 600,
      spotSource: "ibkr",
      symbol: "SPY",
      unavailableReason: null,
    };
    expect(toExpectedMoveCone(apiOut)).toEqual(baseCone);
    expect(
      toExpectedMoveCone({
        ...apiOut,
        band: null,
        unavailableReason: "none",
      })
    ).toBeNull();
  });
});

describe("expectedMoveTargetIndex", () => {
  const times = [1000, 1000 + DAY_MS, 1000 + 2 * DAY_MS];
  const last = times[2]!;

  it("handles exact, expanded, compressed, and invalid target horizons", () => {
    expect(barSpacing([])).toBe(DAY_MS);
    expect(barSpacing(times)).toBe(DAY_MS);
    expect(expectedMoveTargetIndex([], last + DAY_MS, DAY_MS)).toBeNull();
    expect(expectedMoveTargetIndex(times, last + DAY_MS, 0)).toBeNull();
    expect(expectedMoveTargetIndex(times, last, DAY_MS)).toBeNull();

    const expanded = expectedMoveTargetIndex(times, last + DAY_MS, DAY_MS);
    expect(expanded).toEqual({
      anchorIndex: 2,
      horizonScale: "expanded",
      span: MIN_EXPECTED_MOVE_CONE_BARS,
      targetIndex: 2 + MIN_EXPECTED_MOVE_CONE_BARS,
    });

    const exact = expectedMoveTargetIndex(times, last + 10 * DAY_MS, DAY_MS);
    expect(exact).toEqual({
      anchorIndex: 2,
      horizonScale: "exact",
      span: 10,
      targetIndex: 12,
    });

    const compressed = expectedMoveTargetIndex(
      times,
      last + 90 * DAY_MS,
      DAY_MS
    );
    expect(compressed).toEqual({
      anchorIndex: 2,
      horizonScale: "compressed",
      span: MAX_EXPECTED_MOVE_CONE_BARS,
      targetIndex: 2 + MAX_EXPECTED_MOVE_CONE_BARS,
    });
  });
});

describe("withAlpha", () => {
  it("supports oklch, 3-digit hex, 6-digit hex, rgb/rgba, and CSS color-mix fallback", () => {
    expect(withAlpha("oklch(0.76 0.16 70)", 0.16)).toBe(
      "oklch(0.76 0.16 70 / 0.16)"
    );
    expect(withAlpha("oklch(0.76 0.16 70 / 0.9)", 0.2)).toBe(
      "oklch(0.76 0.16 70 / 0.2)"
    );
    expect(withAlpha("#fa0", 0.5)).toBe("rgba(255, 170, 0, 0.5)");
    expect(withAlpha("#feda00", 0.16)).toBe("rgba(254, 218, 0, 0.16)");
    expect(withAlpha("rgb(10, 20, 30)", 0.25)).toBe("rgba(10, 20, 30, 0.25)");
    expect(withAlpha("hsl(45 90% 50%)", 0.2)).toBe(
      "color-mix(in srgb, hsl(45 90% 50%) 20%, transparent)"
    );
  });
});

describe("expectedMoveConeFigures", () => {
  const coords = [
    { x: 200, y: 150 },
    { x: 320, y: 80 },
    { x: 320, y: 220 },
    { x: 320, y: 95 },
    { x: 320, y: 205 },
  ];

  it("returns empty array for invalid coordinates or overlay payload", () => {
    const data = expectedMoveOverlayData(baseCone, palette, 2);
    expect(expectedMoveConeFigures(coords.slice(0, 4), data)).toEqual([]);
    expect(expectedMoveConeFigures(coords, null)).toEqual([]);
    expect(expectedMoveConeFigures(coords, { bad: true })).toEqual([]);
  });

  it("draws √t cone polygon, dashed bands, guides, straddle ticks, and clamped pills", () => {
    const data = expectedMoveOverlayData(baseCone, palette, 2);
    const figs = expectedMoveConeFigures(coords, data, {
      height: 300,
      width: 400,
    });
    // 1 polygon + 2 curves + 2 guides + 2 straddle ticks + 3 labels + 2 BE labels = 12
    expect(figs).toHaveLength(12);
    expect(figs.every((fig) => fig.ignoreEvent === true)).toBe(true);
    const polygon = figs[0]!;
    expect(polygon.type).toBe("polygon");
    expect((polygon.attrs["coordinates"] as unknown[]).length).toBe(
      (CONE_CURVE_STEPS + 1) * 2
    );

    // Off-scale Y clamping adds ↑ and ↓ prefixes and keeps the upper pill below the legend.
    const clamped = expectedMoveConeFigures(
      [
        { x: 200, y: 150 },
        { x: 320, y: -40 },
        { x: 320, y: 360 },
        { x: 320, y: 20 },
        { x: 320, y: 280 },
      ],
      data,
      { height: 300, width: 400 }
    );
    const clampedTextFigs = clamped.filter((fig) => fig.type === "text");
    const texts = clampedTextFigs.map((fig) => fig.attrs["text"]);
    expect(texts[0]).toBe("↑ +1σ $625.60");
    expect(clampedTextFigs[0]?.attrs["y"]).toBe(70);
    expect(texts[1]).toBe("↓ -1σ $574.40");
    expect(
      clampedTextFigs.every((fig) => fig.styles["family"] === data.fontFamily)
    ).toBe(true);

    // In-bounds upper pill inside the top legend band shifts below the legend without ↑ prefix.
    const legendClear = expectedMoveConeFigures(
      [
        { x: 200, y: 150 },
        { x: 320, y: 36 },
        { x: 320, y: 220 },
        { x: 320, y: 95 },
        { x: 320, y: 205 },
      ],
      data,
      { height: 300, width: 800 }
    );
    const legendClearTexts = legendClear.filter((fig) => fig.type === "text");
    expect(legendClearTexts[0]?.attrs["text"]).toBe("+1σ $625.60");
    expect(legendClearTexts[0]?.attrs["y"]).toBe(64);

    // When both +1σ and -1σ sit above the viewport (or -1σ sits inside the clamped upper pill band),
    // -1σ stacks cleanly below +1σ without colliding on the same pixels.
    const bothAbove = expectedMoveConeFigures(
      [
        { x: 200, y: 150 },
        { x: 320, y: -40 },
        { x: 320, y: -10 },
        { x: 320, y: -30 },
        { x: 320, y: -5 },
      ],
      data,
      { height: 300, width: 400 }
    ).filter((fig) => fig.type === "text");
    expect(bothAbove[0]?.attrs["text"]).toBe("↑ +1σ $625.60");
    expect(bothAbove[0]?.attrs["y"]).toBe(70);
    expect(bothAbove[1]?.attrs["text"]).toBe("↑ -1σ $574.40");
    expect(bothAbove[1]?.attrs["y"]).toBe(72);

    const nearUpper = expectedMoveConeFigures(
      [
        { x: 200, y: 150 },
        { x: 320, y: -40 },
        { x: 320, y: 58 },
        { x: 320, y: -20 },
        { x: 320, y: 90 },
      ],
      data,
      { height: 300, width: 400 }
    ).filter((fig) => fig.type === "text");
    expect(nearUpper[0]?.attrs["y"]).toBe(70);
    expect(nearUpper[1]?.attrs["text"]).toBe("-1σ $574.40");
    expect(nearUpper[1]?.attrs["y"]).toBe(72);

    // Target panned off-canvas horizontally hides labels
    const hiddenX = expectedMoveConeFigures(coords, data, {
      height: 300,
      width: 250,
    });
    expect(hiddenX.filter((fig) => fig.type === "text")).toHaveLength(0);
    // Near right edge flips pill and BE labels inward so they never clip into the Y-axis
    const nearEdge = expectedMoveConeFigures(
      [
        { x: 200, y: 150 },
        { x: 380, y: 80 },
        { x: 380, y: 220 },
        { x: 380, y: 100 },
        { x: 380, y: 200 },
      ],
      data,
      { height: 300, width: 400 }
    );
    const nearTexts = nearEdge.filter((fig) => fig.type === "text");
    expect(nearTexts).toHaveLength(5);
    expect(nearTexts.every((fig) => fig.attrs["align"] === "right")).toBe(true);
    expect(nearTexts.every((fig) => Number(fig.attrs["x"]) < 380)).toBe(true);

    // Without bounding box, labels are unclamped; without straddle, ticks are omitted
    const modelData = expectedMoveOverlayData(
      {
        ...baseCone,
        basis: "atm_iv_model",
        straddleLower: null,
        straddlePrice: null,
        straddleUpper: null,
      },
      {
        accent: palette.accent,
        background: palette.background,
        falling: palette.falling,
        foreground: palette.foreground,
        grid: palette.grid,
        rising: palette.rising,
      },
      2
    );
    expect(modelData.stroke).toBe(palette.accent);
    const modelFigs = expectedMoveConeFigures(coords, modelData);
    // 1 polygon + 2 curves + 2 guides + 3 labels = 8 (no straddle ticks)
    expect(modelFigs).toHaveLength(8);
  });
});
