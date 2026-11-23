import type { StrikeProfileRow } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  buildStrikeProfile,
  STRIKE_PROFILE_LABELS,
  STRIKE_PROFILE_METRICS,
  type StrikeProfileSnapshot,
  type StrikeProfileView,
} from "./strike-profiles-model.ts";

const row = (
  strike: number,
  over: Partial<StrikeProfileRow> = {}
): StrikeProfileRow => ({
  bearishPremium: 0,
  bullishPremium: 0,
  callOpenInterest: 0,
  callVolume: 0,
  holderPayout: 0,
  putOpenInterest: 0,
  putVolume: 0,
  strike,
  trades: 0,
  ...over,
});

const ROWS: readonly StrikeProfileRow[] = [
  row(90, {
    callOpenInterest: 10,
    holderPayout: 320_000,
    putOpenInterest: 500,
  }),
  row(100, {
    bearishPremium: 250_000,
    bullishPremium: 1_000_000,
    callOpenInterest: 300,
    callVolume: 200,
    holderPayout: 25_000,
    putOpenInterest: 300,
    putVolume: 50,
    trades: 2,
  }),
  row(120, {
    bearishPremium: 400_000,
    callOpenInterest: 800,
    holderPayout: 635_000,
    putVolume: 100,
    trades: 1,
  }),
  row(130, {
    callOpenInterest: 5,
    holderPayout: 1_740_000,
    putOpenInterest: 5,
  }),
];

const snapshot = (
  over: {
    readonly spot?: number | null;
    readonly strikes?: readonly StrikeProfileRow[];
    readonly flow?: Partial<StrikeProfileSnapshot["strikeProfiles"]["flow"]>;
    readonly exposure?: Partial<StrikeProfileSnapshot["exposure"]>;
    readonly flowSection?: Partial<StrikeProfileSnapshot["flow"]>;
  } = {}
): StrikeProfileSnapshot => ({
  exposure: {
    gexExpiry: "2026-10-23",
    maxPain: 100,
    message: null,
    status: "ok",
    strikes: [],
    totalGex: null,
    ...over.exposure,
  },
  flow: {
    buckets: [],
    callPremium: 0,
    events: [],
    hours: 24,
    message: null,
    putPremium: 0,
    status: "ok",
    ...over.flowSection,
  },
  spot: over.spot === undefined ? 101 : over.spot,
  strikeProfiles: {
    flow: {
      complete: true,
      newestTradeAt: "2026-10-22T14:10:00.000Z",
      offLadderTrades: 0,
      oldestTradeAt: "2026-10-22T13:05:00.000Z",
      source: "quantdata_page",
      trades: 3,
      ...over.flow,
    },
    strikes: [...(over.strikes ?? ROWS)],
  },
});

const ladder = (
  view: StrikeProfileView
): Extract<StrikeProfileView, { kind: "ladder" }> => {
  if (view.kind !== "ladder")
    throw new Error(`expected a ladder: ${view.message}`);
  return view;
};

describe("buildStrikeProfile", () => {
  it("lists the four profiles with their labels", () => {
    expect(
      STRIKE_PROFILE_METRICS.map((metric) => STRIKE_PROFILE_LABELS[metric])
    ).toEqual(["Open interest", "Flow volume", "Net premium", "Max pain"]);
  });

  it("draws open interest puts left and calls right, highest strike first", () => {
    const view = ladder(buildStrikeProfile("openInterest", snapshot()));
    expect(view.layout).toBe("split");
    expect(view.columns).toEqual(["Strike", "Puts", "Calls"]);
    expect(view.rows.map((item) => item.strike)).toEqual([130, 120, 100, 90]);
    // One scale for both sides: the largest put or call OI (800).
    expect(view.rows[1]).toMatchObject({
      left: 0,
      leftText: "0",
      right: 1,
      rightText: "800",
    });
    expect(view.rows[3]).toMatchObject({
      left: 500 / 800,
      leftText: "500",
      right: 10 / 800,
    });
    expect(view.rows[3]?.title).toBe("Strike 90: put OI 500, call OI 10");
    expect(view.rows.some((item) => item.maxPain)).toBe(false);
    // Spot 101: 130 and 120 are above it, so the line follows index 1.
    expect(view.spotAfter).toBe(1);
    expect(view.spotLabel).toBe("Spot 101.00");
    expect(view.captions).toEqual([
      "Open contracts per strike, all expiries (QuantData; can be the previous session). Puts left, calls right.",
      "Strikes: the 55 nearest spot and the 25 largest by open interest (at most 80), plus the max-pain strike.",
    ]);
  });

  it("places the spot line by the strikes above spot", () => {
    expect(
      ladder(buildStrikeProfile("openInterest", snapshot({ spot: 140 })))
        .spotAfter
    ).toBe(-1);
    expect(
      ladder(buildStrikeProfile("openInterest", snapshot({ spot: 80 })))
        .spotAfter
    ).toBe(3);
    // A strike equal to spot sits below the line.
    expect(
      ladder(buildStrikeProfile("openInterest", snapshot({ spot: 100 })))
        .spotAfter
    ).toBe(1);
    const none = ladder(
      buildStrikeProfile("openInterest", snapshot({ spot: null }))
    );
    expect(none.spotAfter).toBeNull();
    expect(none.spotLabel).toBeNull();
    expect(none.captions).toContain(
      "Strikes: the 40 lowest and the 25 largest by open interest, plus the max-pain strike."
    );
  });

  it("draws flow volume with the coverage of the order-flow page", () => {
    const view = ladder(buildStrikeProfile("flowVolume", snapshot()));
    expect(view.rows[2]).toMatchObject({
      left: 0.25,
      leftText: "50",
      right: 1,
      rightText: "200",
    });
    expect(view.rows[2]?.title).toBe(
      "Strike 100: put contracts 50, call contracts 200, 2 prints"
    );
    expect(view.captions).toContain(
      "Newest 3 prints, 10-22 13:05 to 10-22 14:10 UTC, of the last 24 h window."
    );
    const partial = buildStrikeProfile(
      "flowVolume",
      snapshot({ flow: { complete: false, offLadderTrades: 4 } })
    );
    expect(partial.captions).toContain("First provider page only.");
    expect(partial.captions).toContain("4 prints at strikes not shown.");
    expect(
      buildStrikeProfile(
        "flowVolume",
        snapshot({
          flow: { newestTradeAt: null, oldestTradeAt: null, trades: 0 },
        })
      ).captions
    ).toContain("No counted prints in the last 24 h.");
  });

  it("states the coverage of stored prints and draws them when the page failed", () => {
    const stored = buildStrikeProfile(
      "flowVolume",
      snapshot({
        flow: { source: "stored_prints" },
        flowSection: {
          message: "QuantData orderFlow: HTTP 500.",
          status: "unavailable",
        },
      })
    );
    expect(stored.kind).toBe("ladder");
    expect(stored.captions).toContain(
      "All stored prints of the last 24 h (10-22 13:05 to 10-22 14:10 UTC)."
    );
    expect(
      buildStrikeProfile(
        "flowVolume",
        snapshot({ flow: { complete: false, source: "stored_prints" } })
      ).captions
    ).toContain(
      "Stored prints can be incomplete: the collector has gaps or is behind in this window."
    );
    expect(
      buildStrikeProfile(
        "netPremium",
        snapshot({
          flow: {
            newestTradeAt: null,
            oldestTradeAt: null,
            source: "stored_prints",
          },
        })
      ).captions
    ).toContain("No stored prints in the last 24 h.");
  });

  it("draws net premium as one signed bar between bearish and bullish premium", () => {
    const view = ladder(buildStrikeProfile("netPremium", snapshot()));
    expect(view.columns).toEqual(["Strike", "Bearish", "Bullish"]);
    // Net 100: +750K (the scale); net 120: -400K.
    expect(view.rows[2]).toMatchObject({
      left: 0,
      leftText: "$250K",
      right: 1,
      rightText: "$1M",
    });
    expect(view.rows[1]).toMatchObject({ left: 400 / 750, right: 0 });
    expect(view.rows[1]?.title).toBe(
      "Strike 120: bearish $400,000, bullish $0, net −$400,000"
    );
    expect(view.rows[2]?.title).toBe(
      "Strike 100: bearish $250,000, bullish $1,000,000, net $750,000"
    );
    expect(view.rows.map((item) => item.barText)).toEqual([
      "Net $0",
      "Net −$400K",
      "Net +$750K",
      "Net $0",
    ]);
    // The other profiles show every value in a cell.
    expect(
      ladder(buildStrikeProfile("openInterest", snapshot())).rows[0]?.barText
    ).toBeNull();
  });

  it("draws max pain as the payout above the smallest payout", () => {
    const view = ladder(buildStrikeProfile("maxPain", snapshot()));
    expect(view.layout).toBe("single");
    expect(view.columns).toEqual(["Strike", "Payout"]);
    const marked = view.rows.find((item) => item.maxPain);
    expect(marked).toMatchObject({ leftText: "$25K", right: 0, strike: 100 });
    // 130 has the largest excess: 1,740,000 - 25,000.
    expect(view.rows[0]).toMatchObject({ right: 1, rightText: "" });
    expect(view.rows[3]?.right).toBeCloseTo(295_000 / 1_715_000, 10);
    expect(view.rows[3]?.title).toBe("Strike 90: holder payout $320,000");
  });

  it("says so when a profile has only zero values", () => {
    const view = ladder(
      buildStrikeProfile(
        "flowVolume",
        snapshot({ strikes: [row(100), row(110)] })
      )
    );
    expect(view.rows.every((item) => item.left === 0 && item.right === 0)).toBe(
      true
    );
    expect(view.captions).toContain("No values for this profile.");
  });

  it("shows the source section's message when a profile cannot draw", () => {
    const missingOi = buildStrikeProfile(
      "maxPain",
      snapshot({
        exposure: {
          message: "QuantData openInterest: HTTP 500.",
          status: "unavailable",
        },
      })
    );
    expect(missingOi).toMatchObject({
      kind: "message",
      message: "QuantData openInterest: HTTP 500.",
    });
    expect(
      buildStrikeProfile(
        "openInterest",
        snapshot({ exposure: { status: "empty" } })
      )
    ).toMatchObject({
      message: "QuantData sent no open interest for this symbol.",
    });
    expect(
      buildStrikeProfile(
        "netPremium",
        snapshot({
          flowSection: {
            message: "No QuantData option-flow trades in the last 24 h.",
            status: "empty",
          },
        })
      )
    ).toMatchObject({
      message: "No QuantData option-flow trades in the last 24 h.",
    });
    expect(
      buildStrikeProfile(
        "flowVolume",
        snapshot({ flowSection: { status: "unavailable" } })
      )
    ).toMatchObject({ message: "No option-flow prints." });
    // OI ok but no ladder rows (no OI strikes).
    expect(
      buildStrikeProfile("flowVolume", snapshot({ strikes: [] }))
    ).toMatchObject({
      kind: "message",
      message: "No strikes: QuantData sent no open interest for this symbol.",
    });
  });
});
