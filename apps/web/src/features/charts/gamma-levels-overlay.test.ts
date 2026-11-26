import type { FlowGex, OptionsAnalyticsOutput } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  extractGammaLevelEntries,
  GAMMA_LEVEL_KINDS,
  GAMMA_LEVEL_META,
  type GammaLevelsOverlay,
  gammaLevelsFigures,
  gammaLevelsFromFlowGex,
  gammaLevelsFromOptionsAnalytics,
  gammaLevelsObjectLabel,
  gammaLevelsOverlayData,
  groupCoincidentGammaLevels,
  resolveGammaLabelY,
  sameGammaLevelsOverlay,
  validGammaLevelsOverlay,
} from "./gamma-levels-overlay.ts";
import type { ChartPalette } from "./types.ts";

const PALETTE: ChartPalette = {
  accent: "#feda00",
  background: "#111111",
  destructive: "#ef4444",
  falling: "#888888",
  foreground: "#fafafa",
  grid: "#333333",
  info: "#3b82f6",
  king: "#f59e0b",
  rising: "#fafafa",
  success: "#22c55e",
  warning: "#eab308",
};

const sampleOverlay = (
  overrides: Partial<GammaLevelsOverlay> = {}
): GammaLevelsOverlay => ({
  asOf: "2026-11-25T15:30:00Z",
  basis: 0,
  callWall: 615,
  flip: 602.5,
  kingNode: 615,
  maxPain: 600,
  putWall: 590,
  regime: "positive",
  source: "optionsAnalytics",
  spot: 605,
  symbol: "SPY",
  underlyingTicker: "SPY",
  ...overrides,
});

const optionsSnapshot = (
  overrides: Partial<{
    flip: number | null;
    callWall: number | null;
    putWall: number | null;
    kingNode: number | null;
    maxPain: number | null;
    spot: number | null;
  }> = {}
): OptionsAnalyticsOutput =>
  ({
    context: {
      dealerSignAssumption: "dealers long calls, short puts",
      expiry: {
        monthlyOpexDays: 10,
        nextExpiry: "2026-11-27",
        nextExpiryDte: 2,
        nextMonthlyOpex: "2026-12-18",
      },
      factors: [],
      flow: {
        bearishPremium: 0,
        bias: "balanced",
        bullishPremium: 0,
        newestTradeAt: null,
        weekShare: null,
        zeroDteShare: null,
      },
      greeks: { netCharm: null, netDex: null, netVanna: null },
      iv: { backIv: null, frontIv: null, regime: "no_term_data" },
      levels: {
        callWall: "callWall" in overrides ? overrides.callWall : 615,
        callWallMoves: 1.5,
        dailyMove: 6.5,
        flip: "flip" in overrides ? overrides.flip : 602.5,
        flipMoves: -0.4,
        kingNode: "kingNode" in overrides ? overrides.kingNode : 615,
        putWall: "putWall" in overrides ? overrides.putWall : 590,
        putWallMoves: -2.3,
      },
      regime: "positive",
      session: "midday",
    },
    exposure: {
      gexExpiry: "2026-11-27",
      maxPain: "maxPain" in overrides ? overrides.maxPain : 600,
      message: null,
      status: "ok",
      strikes: [],
      totalGex: 1e9,
    },
    flow: {
      buckets: [],
      callPremium: 0,
      events: [],
      hours: 24,
      message: null,
      putPremium: 0,
      status: "empty",
    },
    notes: [],
    rateLimited: false,
    receivedAt: "2026-11-25T15:30:00Z",
    retryAfterSeconds: null,
    source: "quantdata",
    spot: "spot" in overrides ? overrides.spot : 605,
    strikeProfiles: {
      flow: {
        complete: true,
        newestTradeAt: null,
        offLadderTrades: 0,
        oldestTradeAt: null,
        source: "quantdata_page",
        trades: 0,
      },
      strikes: [],
    },
    symbol: "SPY",
    volatility: {
      message: null,
      skew: [],
      status: "empty",
      surface: { moneyness: [], rows: [] },
      termStructure: [],
    },
  }) as unknown as OptionsAnalyticsOutput;

const flowGexSample = (overrides: Partial<FlowGex> = {}): FlowGex => ({
  at: "2026-11-25T15:30:00Z",
  basis: 12,
  ivRegime: "contango",
  levels: {
    callWall: 6100,
    flip: 5980,
    kingNode: 6100,
    maxPain: 6000,
    putWall: 5900,
  },
  netDex: 1e7,
  regime: "positive",
  spot: 6010,
  symbolLevels: {
    callWall: 6112,
    flip: 5992,
    kingNode: 6112,
    maxPain: 6012,
    putWall: 5912,
  },
  ticker: "SPX",
  totalGex: 2e9,
  zeroDteShare: 0.45,
  ...overrides,
});

describe("gamma-levels-overlay builders and validation", () => {
  it("exposes metadata for all five gamma levels", () => {
    expect(GAMMA_LEVEL_KINDS).toEqual([
      "flip",
      "callWall",
      "putWall",
      "maxPain",
      "kingNode",
    ]);
    for (const kind of GAMMA_LEVEL_KINDS) {
      expect(GAMMA_LEVEL_META[kind].glyph.length).toBeGreaterThan(0);
      expect(GAMMA_LEVEL_META[kind].label.length).toBeGreaterThan(0);
    }
  });

  it("builds an overlay from optionsAnalytics.snapshot or returns null when all levels are missing", () => {
    const built = gammaLevelsFromOptionsAnalytics(optionsSnapshot());
    expect(built).toEqual(sampleOverlay());
    expect(
      gammaLevelsFromOptionsAnalytics(
        optionsSnapshot({
          callWall: null,
          flip: null,
          kingNode: null,
          maxPain: null,
          putWall: null,
        })
      )
    ).toBeNull();
    expect(
      gammaLevelsFromOptionsAnalytics(
        optionsSnapshot({
          callWall: Number.NaN,
          flip: -5,
          kingNode: 0,
          maxPain: null,
          putWall: Number.POSITIVE_INFINITY,
          spot: 0,
        })
      )
    ).toBeNull();
  });

  it("builds an overlay from flow_gex using symbolLevels for futures and never plots unshifted SPX on ES", () => {
    expect(gammaLevelsFromFlowGex("ES", null)).toBeNull();
    // Cross-instrument GEX (e.g. SPY GEX passed for ES, or unknown symbol) must return null.
    expect(
      gammaLevelsFromFlowGex("ES", flowGexSample({ basis: 0, ticker: "SPY" }))
    ).toBeNull();
    expect(
      gammaLevelsFromFlowGex("AAPL", flowGexSample({ basis: 0, ticker: "SPX" }))
    ).toBeNull();
    // Futures without basis/symbolLevels must not plot raw SPX numbers on ES.
    expect(
      gammaLevelsFromFlowGex(
        "ES",
        flowGexSample({ basis: null, symbolLevels: null, ticker: "SPX" })
      )
    ).toBeNull();
    // Futures with basis shifts spot and uses symbolLevels.
    expect(gammaLevelsFromFlowGex("ES", flowGexSample())).toEqual({
      asOf: "2026-11-25T15:30:00Z",
      basis: 12,
      callWall: 6112,
      flip: 5992,
      kingNode: 6112,
      maxPain: 6012,
      putWall: 5912,
      regime: "positive",
      source: "flowGex",
      spot: 6022,
      symbol: "ES",
      underlyingTicker: "SPX",
    });
    // Futures with null spot keeps spot null; non-finite basis keeps spot null.
    expect(
      gammaLevelsFromFlowGex("ES", flowGexSample({ spot: null }))?.spot
    ).toBeNull();
    expect(
      gammaLevelsFromFlowGex("ES", flowGexSample({ basis: Number.NaN }))?.spot
    ).toBeNull();
    // Direct ticker match (SPY on SPY) works even if symbolLevels is null.
    expect(
      gammaLevelsFromFlowGex(
        "SPY",
        flowGexSample({
          basis: null,
          levels: {
            callWall: 615,
            flip: 600,
            kingNode: null,
            maxPain: 605,
            putWall: 590,
          },
          spot: 605,
          symbolLevels: null,
          ticker: "SPY",
        })
      )
    ).toMatchObject({
      callWall: 615,
      flip: 600,
      kingNode: null,
      maxPain: 605,
      putWall: 590,
      spot: 605,
      symbol: "SPY",
    });
    // Requesting the options underlying directly (SPX) uses unshifted levels even when basis is present.
    expect(gammaLevelsFromFlowGex("SPX", flowGexSample())).toMatchObject({
      basis: 0,
      callWall: 6100,
      flip: 5980,
      kingNode: 6100,
      maxPain: 6000,
      putWall: 5900,
      spot: 6010,
      symbol: "SPX",
    });
    // All levels null returns null.
    expect(
      gammaLevelsFromFlowGex(
        "SPY",
        flowGexSample({
          levels: {
            callWall: null,
            flip: null,
            kingNode: null,
            maxPain: null,
            putWall: null,
          },
          symbolLevels: null,
          ticker: "SPY",
        })
      )
    ).toBeNull();
  });

  it("validates overlay bounds and compares overlays by value", () => {
    const valid = sampleOverlay();
    expect(validGammaLevelsOverlay(valid)).toBe(true);
    expect(validGammaLevelsOverlay(sampleOverlay({ symbol: "  " }))).toBe(
      false
    );
    expect(validGammaLevelsOverlay(sampleOverlay({ spot: -1 }))).toBe(false);
    expect(validGammaLevelsOverlay(sampleOverlay({ basis: Number.NaN }))).toBe(
      false
    );
    expect(validGammaLevelsOverlay(sampleOverlay({ flip: 0 }))).toBe(false);
    expect(
      validGammaLevelsOverlay(
        sampleOverlay({
          callWall: null,
          flip: null,
          kingNode: null,
          maxPain: null,
          putWall: null,
        })
      )
    ).toBe(false);

    expect(sameGammaLevelsOverlay(null, null)).toBe(true);
    expect(sameGammaLevelsOverlay(valid, null)).toBe(false);
    expect(sameGammaLevelsOverlay(valid, sampleOverlay())).toBe(true);
    expect(
      sameGammaLevelsOverlay(valid, sampleOverlay({ kingNode: 590 }))
    ).toBe(false);
  });
});

describe("coincident grouping, entries, and label de-overlapping", () => {
  it("extracts entries with distance % and coincidence metadata", () => {
    const entries = extractGammaLevelEntries(sampleOverlay());
    expect(entries).toHaveLength(5);
    const callWall = entries.find((e) => e.kind === "callWall");
    const kingNode = entries.find((e) => e.kind === "kingNode");
    expect(callWall?.coincidentWith).toEqual(["kingNode"]);
    expect(kingNode?.coincidentWith).toEqual(["callWall"]);
    expect(callWall?.distancePct).toBeCloseTo(((615 - 605) / 605) * 100);

    const noSpotEntries = extractGammaLevelEntries(
      sampleOverlay({ spot: null })
    );
    expect(noSpotEntries[0]?.distancePct).toBeNull();
    expect(gammaLevelsObjectLabel(sampleOverlay())).toBe("Gamma levels (5)");
    expect(
      extractGammaLevelEntries(sampleOverlay({ maxPain: null }))
    ).toHaveLength(4);
  });

  it("merges coincident levels cleanly and sorts descending by price", () => {
    // Call wall and King node share 615 -> merged into one group with callWall primary.
    const groups = groupCoincidentGammaLevels(sampleOverlay(), 2);
    expect(groups.map((g) => g.price)).toEqual([615, 602.5, 600, 590]);
    expect(groups[0]).toMatchObject({
      glyphs: "▲★",
      hasKingNode: true,
      key: "callWall+kingNode",
      pillText: "▲★ Call wall · King 615.00",
      primaryKind: "callWall",
    });

    // When flip precedes putWall in GAMMA_LEVEL_KINDS at the same price, putWall takes primary priority.
    const mergedFlipPut = groupCoincidentGammaLevels(
      sampleOverlay({
        callWall: null,
        flip: 590,
        kingNode: 580,
        maxPain: null,
        putWall: 590,
      }),
      1
    );
    expect(mergedFlipPut[0]).toMatchObject({
      key: "putWall+flip",
      pillText: "▼⇄ Put wall · Flip 590.0",
      primaryKind: "putWall",
    });
    expect(mergedFlipPut[1]).toMatchObject({
      hasKingNode: true,
      key: "kingNode",
      primaryKind: "kingNode",
    });
  });

  it("spreads clustered labels vertically without overlapping and respects bounds", () => {
    expect(resolveGammaLabelY([], 10, 200)).toEqual({});
    const spread = resolveGammaLabelY(
      [
        { id: "a", idealY: 100 },
        { id: "b", idealY: 102 },
        { id: "c", idealY: 104 },
      ],
      10,
      200,
      20
    );
    expect(spread["a"]).toBe(100);
    expect(spread["b"]).toBe(120);
    expect(spread["c"]).toBe(140);

    // Near bottom boundary: backward pass pulls labels up so none escape maxY.
    const bottomClamped = resolveGammaLabelY(
      [
        { id: "a", idealY: 190 },
        { id: "b", idealY: 195 },
        { id: "c", idealY: 198 },
      ],
      10,
      200,
      20
    );
    expect(bottomClamped["c"]).toBe(200);
    expect(bottomClamped["b"]).toBe(180);
    expect(bottomClamped["a"]).toBe(160);
  });
});

describe("gammaLevelsOverlayData and gammaLevelsFigures", () => {
  it("builds KLineCharts line, gold accent, leader, pill, and out-of-bounds edge figures", () => {
    const overlay = sampleOverlay();
    const data = gammaLevelsOverlayData(overlay, PALETTE, 2);
    expect(data.lines).toHaveLength(4);
    expect(data.lines[0]?.isMergedWithKing).toBe(true);
    expect(data.lines[0]?.color).toBe(PALETTE.success);

    // Fallback palette (no optional semantic tokens).
    const minimalPalette: ChartPalette = {
      accent: "#feda00",
      background: "#111111",
      falling: "#888888",
      foreground: "#fafafa",
      grid: "#333333",
      rising: "#fafafa",
    };
    const fallbackData = gammaLevelsOverlayData(
      sampleOverlay({ kingNode: 585 }),
      minimalPalette,
      2
    );
    expect(fallbackData.lines).toHaveLength(5);
    expect(fallbackData.kingColor).toBe(minimalPalette.accent);

    // Reject invalid extendData or empty lines.
    expect(gammaLevelsFigures([], null)).toEqual([]);
    expect(gammaLevelsFigures([], { lines: [] })).toEqual([]);

    // Mix of above-bounds, clustered in-bounds (triggers leader), and below-bounds.
    const coords = [
      { x: 100, y: -15 }, // callWall+kingNode above viewport
      { x: 100, y: 120 }, // flip in viewport
      { x: 100, y: 124 }, // maxPain clustered near flip -> pushed down with leader line
      { x: 100, y: 410 }, // putWall below viewport
    ];
    const figures = gammaLevelsFigures(coords, data, {
      height: 360,
      width: 800,
    });
    const texts = figures
      .filter((f) => f.type === "text")
      .map((f) => f.attrs.text);
    expect(texts).toContain("⇄ Flip 602.50");
    expect(texts).toContain("◎ Max pain 600.00");
    expect(texts.some((t) => t.startsWith("↑ Above:"))).toBe(true);
    expect(texts.some((t) => t.startsWith("↓ Below:"))).toBe(true);
    // In-bounds pills sit at the left edge, away from the newest candles; a pill moved off its
    // line by the de-overlap keeps a leader from the line.
    const pills = figures.filter(
      (f) => f.type === "text" && !/^[↑↓]/u.test(f.attrs.text)
    );
    expect(pills.map((f) => f.type === "text" && f.attrs)).toEqual([
      {
        align: "left",
        baseline: "middle",
        text: "⇄ Flip 602.50",
        x: 8,
        y: 120,
      },
      {
        align: "left",
        baseline: "middle",
        text: "◎ Max pain 600.00",
        x: 8,
        y: 140,
      },
    ]);
    expect(
      figures.some(
        (f) =>
          f.type === "line" &&
          f.attrs.coordinates[0]?.y === 124 &&
          f.attrs.coordinates[1]?.x === 8 &&
          f.attrs.coordinates[1]?.y === 140
      )
    ).toBe(true);

    // Every figure sets ignoreEvent: true so user drawings and panning stay unaffected.
    expect(figures.every((f) => f.ignoreEvent)).toBe(true);

    // In-bounds merged Call wall + King node draws solid line + gold accent dash line; default bounding fallback works.
    const allInBounds = gammaLevelsFigures(
      [
        { x: 50, y: 60 },
        { x: 50, y: 140 },
        { x: 50, y: 200 },
        { x: 50, y: 280 },
      ],
      data
    );
    const goldAccentLines = allInBounds.filter(
      (f) =>
        f.type === "line" &&
        f.styles.color === PALETTE.king &&
        f.styles.style === "dashed"
    );
    expect(goldAccentLines).toHaveLength(1);

    // Narrow 375 px viewport condenses multi-level above/below summaries so labels do not clip.
    const narrowFigs = gammaLevelsFigures(
      [
        { x: 50, y: -20 },
        { x: 50, y: -10 },
        { x: 50, y: 400 },
        { x: 50, y: 420 },
      ],
      data,
      { height: 360, width: 375 }
    );
    const narrowTexts = narrowFigs
      .filter((f) => f.type === "text")
      .map((f) => f.attrs.text);
    expect(narrowTexts).toContain("↑ Above: 2 (▲★ 615.00…)");
    expect(narrowTexts).toContain("↓ Below: 2 (◎ 600.00…)");

    // A narrow pane draws the short pill (glyphs and price) so it covers few candles.
    const narrowInBounds = gammaLevelsFigures(
      [
        { x: 50, y: 60 },
        { x: 50, y: 140 },
        { x: 50, y: 200 },
        { x: 50, y: 280 },
      ],
      data,
      { height: 360, width: 375 }
    );
    expect(
      narrowInBounds.filter((f) => f.type === "text").map((f) => f.attrs.text)
    ).toEqual(["▲★ 615.00", "⇄ 602.50", "◎ 600.00", "▼ 590.00"]);

    // Mid-width 460 px viewport also condenses 3+ off-scale groups when the full string would clip.
    const midWidthFigs = gammaLevelsFigures(
      [
        { x: 50, y: -30 },
        { x: 50, y: -20 },
        { x: 50, y: -10 },
        { x: 50, y: 120 },
      ],
      data,
      { height: 360, width: 460 }
    );
    const midWidthTexts = midWidthFigs
      .filter((f) => f.type === "text")
      .map((f) => f.attrs.text);
    expect(midWidthTexts).toContain("↑ Above: 3 (▲★ 615.00…)");

    // Missing/non-finite coordinates are skipped safely.
    expect(
      gammaLevelsFigures([{ x: 0, y: Number.NaN }], data, {
        height: 360,
        width: 800,
      })
    ).toEqual([]);
  });
});
