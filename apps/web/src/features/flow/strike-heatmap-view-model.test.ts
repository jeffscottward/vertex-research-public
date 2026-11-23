import { type FlowStrikeHeatmap, STRIKE_HEATMAP_RULES } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import { labFlowStrikeHeatmap } from "../../lab/fixtures/flow.ts";
import {
  buildStrikeHeatmapGrid,
  cellAriaLabel,
  describeSelectedCell,
  formatSlotRange,
  formatSlotShortTime,
  formatStrikeLabel,
  heatmapCellBackground,
  heatmapCellKey,
  moveHeatmapSelection,
  STRIKE_HEATMAP_BUCKET_OPTIONS,
  STRIKE_HEATMAP_LOADING,
  STRIKE_HEATMAP_NO_CELLS,
  strikeHeatmapEmptyLine,
  strikeHeatmapFailureLine,
  strikeHeatmapHeaderLine,
  strikeHeatmapOmittedLine,
  strikeHeatmapRuleText,
  strikeHeatmapSymbolOf,
  strikeHeatmapTitle,
  strikeHeatmapTotalsLine,
} from "./strike-heatmap-view-model.ts";

const baseSlot = (
  index: number,
  start: string,
  end: string,
  price: number | null = 580,
  unread = false
) => ({
  bearishPremium: 0,
  bullishPremium: 0,
  end,
  grossPremium: 0,
  index,
  netPremium: 0,
  price,
  prints: 0,
  start,
  unread,
  unsignedPrints: 0,
  volume: 0,
});

const baseStrike = (strike: number, netPremium = 0) => ({
  bearishPremium: netPremium < 0 ? Math.abs(netPremium) : 0,
  bullishPremium: netPremium > 0 ? netPremium : 0,
  callPremium: Math.abs(netPremium),
  grossPremium: Math.abs(netPremium),
  netPremium,
  prints: 1,
  putPremium: 0,
  strike,
  unsignedPrints: 0,
  volume: 10,
});

const makeResponse = (
  overrides: Partial<FlowStrikeHeatmap> = {}
): FlowStrikeHeatmap => ({
  ...labFlowStrikeHeatmap("SPY", 15),
  ...overrides,
});

describe("strike-heatmap-view-model", () => {
  it("resolves supported symbols, titles, and exported constants", () => {
    expect(strikeHeatmapSymbolOf("SPY")).toBe("SPY");
    expect(strikeHeatmapSymbolOf("ES")).toBe("ES");
    expect(strikeHeatmapSymbolOf("QQQ")).toBeNull();
    expect(strikeHeatmapSymbolOf("NQ")).toBeNull();

    expect(strikeHeatmapTitle("SPY")).toBe(
      "Options flow heatmap · SPY options"
    );
    expect(strikeHeatmapTitle("ES")).toBe(
      "Options flow heatmap · SPX options (ES)"
    );
    expect(STRIKE_HEATMAP_BUCKET_OPTIONS).toEqual([5, 15, 30]);
    expect(STRIKE_HEATMAP_LOADING).toContain("Loading");
    expect(STRIKE_HEATMAP_NO_CELLS).toContain("No regular-session");
  });

  it("formats strikes, slot clocks, ranges, and the 30m 15-minute close slot", () => {
    expect(heatmapCellKey(580.5, 4)).toBe("580.5:4");
    expect(formatStrikeLabel(580)).toBe("580");
    expect(formatStrikeLabel(580.5)).toBe("580.5");
    expect(formatStrikeLabel(580.25)).toBe("580.25");
    expect(formatStrikeLabel(580.001)).toBe("580");

    expect(formatSlotShortTime("2026-10-30T13:30:00.000Z")).toBe("09:30");
    expect(
      formatSlotRange(
        {
          end: "2026-10-30T13:45:00.000Z",
          start: "2026-10-30T13:30:00.000Z",
        },
        15
      )
    ).toBe("09:30–09:45 ET");
    expect(
      formatSlotRange(
        {
          end: "2026-10-30T20:15:00.000Z",
          start: "2026-10-30T20:00:00.000Z",
        },
        30
      )
    ).toBe("16:00–16:15 ET (15m close)");
    expect(
      formatSlotRange(
        {
          end: "2026-10-30T14:00:00.000Z",
          start: "2026-10-30T13:30:00.000Z",
        },
        30
      )
    ).toBe("09:30–10:00 ET");
  });

  it("formats empty, failure, header, totals, omitted, and rule copy across all branches", () => {
    expect(strikeHeatmapEmptyLine("SPY")).toBe(
      "No option prints stored for SPY in the last 14 days."
    );

    const failure = {
      code: "STORAGE_ERROR",
      failedAt: Date.parse("2026-10-30T15:00:00.000Z"),
      message: "db offline",
    };
    expect(strikeHeatmapFailureLine(failure, 60_000, null, 15)).toBe(
      "Options flow heatmap failed (STORAGE_ERROR): db offline. Retry now or wait for 11:01 ET."
    );
    expect(strikeHeatmapFailureLine(failure, 60_000, 15, 15)).toBe(
      "Options flow heatmap failed (STORAGE_ERROR): db offline. Retry now or wait for 11:01 ET."
    );
    expect(strikeHeatmapFailureLine(failure, 60_000, 15, 5)).toBe(
      "Options flow heatmap failed (STORAGE_ERROR): db offline. Showing previous 15m grid. Retry now or wait for 11:01 ET."
    );

    const spy = labFlowStrikeHeatmap("SPY", 15);
    expect(strikeHeatmapHeaderLine(spy)).toContain("Session 2026-10-30");
    expect(strikeHeatmapHeaderLine(spy)).toContain("15m slots");
    expect(strikeHeatmapHeaderLine(spy)).toContain("prints through");
    expect(strikeHeatmapHeaderLine(spy)).toContain("1 open gap");

    const multiGap = makeResponse({
      session: null,
      storedUntil: null,
      unread: {
        from: "2026-10-30T15:10:00.000Z",
        ranges: 2,
        to: "2026-10-30T15:40:00.000Z",
      },
    });
    expect(strikeHeatmapHeaderLine(multiGap)).toContain("Session none");
    expect(strikeHeatmapHeaderLine(multiGap)).not.toContain("prints through");
    expect(strikeHeatmapHeaderLine(multiGap)).toContain("2 open gaps");

    const noGap = labFlowStrikeHeatmap("ES", 15);
    expect(strikeHeatmapHeaderLine(noGap)).not.toContain("Incomplete");

    expect(strikeHeatmapTotalsLine(spy)).toContain("unsigned)");
    const noUnsigned = makeResponse({
      totals: { ...spy.totals, unsignedPrints: 0 },
    });
    expect(strikeHeatmapTotalsLine(noUnsigned)).not.toContain("unsigned");

    expect(strikeHeatmapOmittedLine(noGap)).toBeNull();
    expect(strikeHeatmapOmittedLine(spy)).toContain("3 minor strikes");
    const oneOmitted = makeResponse({
      totals: { ...spy.totals, omittedStrikes: 1, totalStrikes: 21 },
    });
    expect(strikeHeatmapOmittedLine(oneOmitted)).toContain("1 minor strike (");

    const ruleText = strikeHeatmapRuleText(STRIKE_HEATMAP_RULES);
    expect(ruleText).toContain("strike-heatmap.v1");
    expect(ruleText).toContain("top 20 strikes");
    expect(ruleText).toContain("Research view only.");
  });

  it("computes contrast-safe diverging oklab backgrounds and returns undefined for zero/flat", () => {
    expect(heatmapCellBackground(0, 1_000_000)).toBeUndefined();
    expect(heatmapCellBackground(500_000, 0)).toBeUndefined();
    expect(heatmapCellBackground(1_000_000, 1_000_000)).toBe(
      "color-mix(in oklab, var(--color-success) 42%, transparent)"
    );
    expect(heatmapCellBackground(-1_000_000, 1_000_000)).toBe(
      "color-mix(in oklab, var(--color-destructive) 42%, transparent)"
    );
    expect(heatmapCellBackground(100_000, 1_000_000)).toBe(
      "color-mix(in oklab, var(--color-success) 17%, transparent)"
    );
  });

  it("places spot accurately (above-all, below-all, at, between, null, and unsorted fallback)", () => {
    const strikes = [baseStrike(600), baseStrike(590), baseStrike(580)];
    const slots = [
      baseSlot(0, "2026-10-30T13:30:00.000Z", "2026-10-30T13:45:00.000Z", 595),
    ];

    const above = buildStrikeHeatmapGrid(
      makeResponse({
        cells: [],
        slots,
        storedUntil: "2026-10-30T13:44:00.000Z",
        strikes,
        totals: { ...labFlowStrikeHeatmap("SPY").totals, latestPrice: 605 },
      })
    );
    expect(above.spot?.placement).toEqual({ kind: "above-all" });
    expect(above.spot?.label).toBe("SPY spot 605.00 · 09:44 ET");

    const below = buildStrikeHeatmapGrid(
      makeResponse({
        cells: [],
        slots,
        storedUntil: null,
        strikes,
        totals: { ...labFlowStrikeHeatmap("SPY").totals, latestPrice: 575 },
      })
    );
    expect(below.spot?.placement).toEqual({ kind: "below-all" });
    expect(below.spot?.label).toBe("SPY spot 575.00");

    const exact = buildStrikeHeatmapGrid(
      makeResponse({
        cells: [],
        slots,
        strikes,
        totals: { ...labFlowStrikeHeatmap("SPY").totals, latestPrice: 590 },
      })
    );
    expect(exact.spot?.placement).toEqual({ kind: "at", strike: 590 });
    expect(exact.rows[1]?.spotAt).toBe(true);
    expect(exact.rows[0]?.spotAt).toBe(false);

    const between = buildStrikeHeatmapGrid(
      makeResponse({
        cells: [],
        slots,
        strikes,
        totals: { ...labFlowStrikeHeatmap("SPY").totals, latestPrice: 594.5 },
      })
    );
    expect(between.spot?.placement).toEqual({
      aboveStrike: 600,
      belowStrike: 590,
      kind: "between",
    });
    expect(between.rows[0]?.spotBelow).toBe(true);
    expect(between.rows[1]?.spotBelow).toBe(false);

    const noSpot = buildStrikeHeatmapGrid(
      makeResponse({
        cells: [],
        slots,
        strikes,
        totals: { ...labFlowStrikeHeatmap("SPY").totals, latestPrice: null },
      })
    );
    expect(noSpot.spot).toBeNull();

    const noStrikes = buildStrikeHeatmapGrid(
      makeResponse({ cells: [], slots, strikes: [] })
    );
    expect(noStrikes.spot).toBeNull();
    expect(noStrikes.defaultSelectedKey).toBeNull();

    // Between the lower adjacent pair (exercises loop advancement to final pair)
    const lowerBetween = buildStrikeHeatmapGrid(
      makeResponse({
        cells: [],
        slots,
        strikes,
        totals: { ...labFlowStrikeHeatmap("SPY").totals, latestPrice: 585 },
      })
    );
    expect(lowerBetween.spot?.placement).toEqual({
      aboveStrike: 590,
      belowStrike: 580,
      kind: "between",
    });
  });

  it("picks default selected cell deterministically across tie-breakers", () => {
    const cell = (
      strike: number,
      slotIndex: number,
      netPremium: number,
      grossPremium: number
    ) => ({
      bearishPremium: netPremium < 0 ? Math.abs(netPremium) : 0,
      bullishPremium: netPremium > 0 ? netPremium : 0,
      callPremium: grossPremium,
      grossPremium,
      netPremium,
      prints: 2,
      putPremium: 0,
      slotIndex,
      strike,
      unsignedPrints: 0,
      volume: 10,
    });

    const slots = [
      baseSlot(0, "2026-10-30T13:30:00.000Z", "2026-10-30T13:45:00.000Z"),
      baseSlot(1, "2026-10-30T13:45:00.000Z", "2026-10-30T14:00:00.000Z"),
    ];
    const strikes = [baseStrike(600), baseStrike(590)];

    // 1. Largest |netPremium| wins (even negative)
    expect(
      buildStrikeHeatmapGrid(
        makeResponse({
          cells: [cell(600, 0, 100, 200), cell(590, 1, -250, 250)],
          slots,
          strikes,
        })
      ).defaultSelectedKey
    ).toBe("590:1");

    // 2. Tied |netPremium| -> larger grossPremium wins
    expect(
      buildStrikeHeatmapGrid(
        makeResponse({
          cells: [cell(600, 0, 0, 100), cell(590, 1, 0, 300)],
          slots,
          strikes,
        })
      ).defaultSelectedKey
    ).toBe("590:1");

    // 3. Tied |netPremium| and grossPremium -> higher strike wins
    expect(
      buildStrikeHeatmapGrid(
        makeResponse({
          cells: [cell(590, 0, 100, 200), cell(600, 1, 100, 200)],
          slots,
          strikes,
        })
      ).defaultSelectedKey
    ).toBe("600:1");

    // 4. Tied |netPremium|, grossPremium, strike -> earlier slotIndex wins
    expect(
      buildStrikeHeatmapGrid(
        makeResponse({
          cells: [cell(600, 1, 100, 200), cell(600, 0, 100, 200)],
          slots,
          strikes,
        })
      ).defaultSelectedKey
    ).toBe("600:0");
  });

  it("moves roving-tabindex keyboard selection across sparse active cells", () => {
    const cell = (strike: number, slotIndex: number) => ({
      bearishPremium: 0,
      bullishPremium: 100,
      callPremium: 100,
      grossPremium: 100,
      netPremium: 100,
      prints: 1,
      putPremium: 0,
      slotIndex,
      strike,
      unsignedPrints: 0,
      volume: 10,
    });
    const slots = [0, 1, 2, 3].map((idx) =>
      baseSlot(
        idx,
        `2026-10-30T13:${String(30 + idx * 5).padStart(2, "0")}:00.000Z`,
        `2026-10-30T13:${String(35 + idx * 5).padStart(2, "0")}:00.000Z`
      )
    );
    const strikes = [baseStrike(610), baseStrike(600), baseStrike(590)];
    const grid = buildStrikeHeatmapGrid(
      makeResponse({
        // Row 0 (610): cols 0 and 3
        // Row 1 (600): empty row!
        // Row 2 (590): col 2 only
        cells: [cell(610, 0), cell(610, 3), cell(590, 2)],
        slots,
        strikes,
      })
    );

    expect(moveHeatmapSelection(grid.rows, "999:9", "right")).toBe("999:9");
    expect(moveHeatmapSelection(grid.rows, "610:0", "right")).toBe("610:3");
    expect(moveHeatmapSelection(grid.rows, "610:3", "right")).toBe("610:3");
    expect(moveHeatmapSelection(grid.rows, "610:3", "left")).toBe("610:0");
    expect(moveHeatmapSelection(grid.rows, "610:0", "left")).toBe("610:0");
    expect(moveHeatmapSelection(grid.rows, "610:3", "home")).toBe("610:0");
    expect(moveHeatmapSelection(grid.rows, "610:0", "end")).toBe("610:3");
    // Vertical skips empty row 1 and finds nearest active cell by column distance
    expect(moveHeatmapSelection(grid.rows, "610:3", "down")).toBe("590:2");
    expect(moveHeatmapSelection(grid.rows, "590:2", "down")).toBe("590:2");
    expect(moveHeatmapSelection(grid.rows, "590:2", "up")).toBe("610:3");
    expect(moveHeatmapSelection(grid.rows, "610:0", "down")).toBe("590:2");
    expect(moveHeatmapSelection(grid.rows, "610:0", "up")).toBe("610:0");
    // Moving up from col 0 to a row with [col 0, col 3] keeps the closer col 0 over farther col 3
    const twoColGrid = buildStrikeHeatmapGrid(
      makeResponse({
        cells: [cell(610, 0), cell(610, 3), cell(590, 0)],
        slots,
        strikes: [baseStrike(610), baseStrike(590)],
      })
    );
    expect(moveHeatmapSelection(twoColGrid.rows, "590:0", "up")).toBe("610:0");
  });

  it("formats accessible cell labels and inspector readouts for bull, bear, flat, gap, and missing slot", () => {
    const response = makeResponse({
      bucketMinutes: 15,
      slots: [
        baseSlot(
          0,
          "2026-10-30T13:30:00.000Z",
          "2026-10-30T13:45:00.000Z",
          581.25,
          false
        ),
        baseSlot(
          1,
          "2026-10-30T13:45:00.000Z",
          "2026-10-30T14:00:00.000Z",
          null,
          true
        ),
      ],
    });
    const bullCell = {
      bearishPremium: 20_000,
      bullishPremium: 120_000,
      callPremium: 120_000,
      grossPremium: 140_000,
      netPremium: 100_000,
      prints: 5,
      putPremium: 20_000,
      slotIndex: 0,
      strike: 582,
      unsignedPrints: 0,
      volume: 150,
    };
    const bearCell = {
      ...bullCell,
      netPremium: -80_000,
      slotIndex: 1,
      unsignedPrints: 2,
    };
    const flatCell = {
      ...bullCell,
      netPremium: 0,
      slotIndex: 5,
      unsignedPrints: 3,
    };

    const [slot0, slot1] = response.slots;
    if (slot0 === undefined || slot1 === undefined)
      throw new Error("Expected two slots");
    expect(cellAriaLabel(response, bullCell, slot0)).toContain(
      "net bullish, 5 prints"
    );
    expect(cellAriaLabel(response, bearCell, slot1)).toContain(
      "net bearish, 5 prints, unread collector gap"
    );
    expect(cellAriaLabel(response, flatCell, slot0)).toContain(
      "flat or unsigned"
    );

    const bullReadout = describeSelectedCell(response, bullCell);
    expect(bullReadout.headline).toBe(
      "SPY strike 582 · 09:30–09:45 ET · SPY 581.25"
    );
    expect(bullReadout.netLine).toBe("Net +$100K");
    expect(bullReadout.metaLine).not.toContain("unsigned");

    const bearReadout = describeSelectedCell(response, bearCell);
    expect(bearReadout.headline).toBe(
      "SPY strike 582 · 09:45–10:00 ET · SPY price not recorded · unread gap"
    );
    expect(bearReadout.metaLine).toContain("(2 unsigned)");

    const missingSlotReadout = describeSelectedCell(response, flatCell);
    expect(missingSlotReadout.headline).toBe(
      "SPY strike 582 · slot 5 · SPY price not recorded"
    );
  });
});
