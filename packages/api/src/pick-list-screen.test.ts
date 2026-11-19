import { describe, expect, it } from "vitest";

import {
  aboveVwapGate,
  closesOf,
  emaTrendGate,
  latestDailyQuadrant,
  notOverextendedGate,
  type ScreenBar,
  screenGates,
  screenMember,
  screenStatus,
  sectorEtfFor,
  vwap,
  wilderAtr,
} from "./pick-list-screen.ts";
import {
  computeRotationPoints,
  SECTOR_ROTATION_PARAMS,
} from "./sector-rotation.ts";

const dateAt = (index: number): string =>
  new Date(Date.UTC(2026, 0, 1) + index * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** Bars with closes from `closeAt`, a fixed half range and volume. */
const series = (
  count: number,
  closeAt: (index: number) => number,
  halfRange = 2,
  volume = 1000
): ScreenBar[] =>
  Array.from({ length: count }, (_, index) => {
    const c = closeAt(index);
    return {
      c,
      date: dateAt(index),
      h: c + halfRange,
      l: c - halfRange,
      o: c,
      v: volume,
    };
  });

const rising = series(80, (index) => 100 + 0.1 * index);
const falling = series(80, (index) => 200 - 0.1 * index);

describe("emaTrendGate", () => {
  it("needs 50 bars", () => {
    expect(emaTrendGate(rising.slice(0, 49))).toEqual({
      detail: "Not enough history (49 bars, needs 50)",
      ok: null,
    });
  });

  it("passes a rising stack and fails a falling one", () => {
    const result = emaTrendGate(rising);
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(
      /^Close 107\.90 vs EMA20 \d+\.\d{2}, EMA50 \d+\.\d{2}$/u
    );
    expect(emaTrendGate(falling).ok).toBe(false);
  });
});

describe("aboveVwapGate", () => {
  it("needs 20 bars and some volume", () => {
    expect(aboveVwapGate(rising.slice(0, 19)).ok).toBeNull();
    expect(aboveVwapGate(series(20, () => 10, 1, 0))).toEqual({
      detail: "No volume in the last 20 bars",
      ok: null,
    });
  });

  it("compares the close with the volume-weighted typical price", () => {
    expect(aboveVwapGate(rising)).toMatchObject({ ok: true });
    expect(aboveVwapGate(falling).ok).toBe(false);
    expect(aboveVwapGate(series(20, () => 10)).detail).toBe(
      "Close 10.00 vs 20-day VWAP 10.00"
    );
  });

  it("weights typical prices by volume", () => {
    const bars: ScreenBar[] = [
      { c: 9, date: "2026-01-01", h: 12, l: 6, o: 1, v: 1 },
      { c: 15, date: "2026-01-02", h: 30, l: 15, o: 1, v: 3 },
    ];
    expect(vwap(bars, 2)).toBe((9 * 1 + 20 * 3) / 4);
    expect(vwap(bars, 1)).toBe(20);
  });
});

describe("wilderAtr", () => {
  it("needs window + 1 bars", () => {
    expect(
      wilderAtr(
        series(14, () => 10),
        14
      )
    ).toBeNull();
  });

  it("seeds with the mean true range, then smooths", () => {
    const bars = series(16, () => 10, 1);
    expect(wilderAtr(bars.slice(0, 15), 14)).toBe(2);
    // The 15th true range is 16 (high − low): (13 × 2 + 16) ÷ 14 = 3.
    bars[15] = { c: 10, date: dateAt(15), h: 18, l: 2, o: 10, v: 1 };
    expect(wilderAtr(bars, 14)).toBe(3);
  });

  it("uses gaps from the previous close", () => {
    const bars: ScreenBar[] = [
      { c: 10, date: "2026-01-01", h: 10, l: 10, o: 10, v: 1 },
      { c: 15, date: "2026-01-02", h: 15, l: 14, o: 14, v: 1 },
      { c: 5, date: "2026-01-03", h: 6, l: 5, o: 5, v: 1 },
    ];
    expect(wilderAtr(bars, 2)).toBe((5 + 10) / 2);
  });
});

describe("notOverextendedGate", () => {
  it("needs 20 bars", () => {
    expect(notOverextendedGate(rising.slice(0, 19))).toEqual({
      detail: "Not enough history (19 bars, needs 20)",
      ok: null,
    });
  });

  it("fails a close far above EMA20 + 2 × ATR14", () => {
    expect(notOverextendedGate(rising)).toMatchObject({ ok: true });
    const spiked = [
      ...rising.slice(0, -1),
      { c: 150, date: dateAt(79), h: 151, l: 149, o: 150, v: 1000 },
    ];
    const result = notOverextendedGate(spiked);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(
      /^Close 150\.00 vs ceiling \d+\.\d{2} \(EMA20 \d+\.\d{2} \+ 2×ATR14 \d+\.\d{2}\)$/u
    );
  });
});

describe("screenStatus", () => {
  it("has no verdict without bars or with any open gate", () => {
    expect(screenStatus(null)).toBe("no_data");
    expect(screenStatus(screenGates(rising.slice(0, 30)))).toBe(
      "not_evaluated"
    );
  });

  it("has no verdict, with the gate's own cause, when enough bars have no volume", () => {
    const gates = screenGates(series(80, (index) => 100 + 0.1 * index, 2, 0));
    expect(gates.emaTrend.ok).toBe(true);
    expect(gates.aboveVwap20).toEqual({
      detail: "No volume in the last 20 bars",
      ok: null,
    });
    expect(screenStatus(gates)).toBe("not_evaluated");
  });

  it("passes only when every gate holds", () => {
    expect(screenStatus(screenGates(rising))).toBe("pass");
    expect(screenStatus(screenGates(falling))).toBe("fail");
  });
});

describe("sectorEtfFor", () => {
  it("maps GICS names and common aliases case-insensitively", () => {
    expect(sectorEtfFor("Information Technology")).toBe("XLK");
    expect(sectorEtfFor("  tech ")).toBe("XLK");
    expect(sectorEtfFor("Healthcare")).toBe("XLV");
    expect(sectorEtfFor("Health  Care")).toBe("XLV");
    expect(sectorEtfFor("Consumer Cyclical")).toBe("XLY");
    expect(sectorEtfFor("Consumer Defensive")).toBe("XLP");
    expect(sectorEtfFor("Basic Materials")).toBe("XLB");
    expect(sectorEtfFor("Communications")).toBe("XLC");
    expect(sectorEtfFor("Telecommunications")).toBe("XLC");
    expect(sectorEtfFor("Financial Services")).toBe("XLF");
    expect(sectorEtfFor("Finance")).toBe("XLF");
    expect(sectorEtfFor("INDUSTRIALS")).toBe("XLI");
    expect(sectorEtfFor("Energy")).toBe("XLE");
    expect(sectorEtfFor("Utilities")).toBe("XLU");
    expect(sectorEtfFor("Real Estate")).toBe("XLRE");
  });

  it("reads an ampersand as 'and' and returns null otherwise", () => {
    expect(sectorEtfFor("Consumer Staples")).toBe("XLP");
    expect(sectorEtfFor("Consumer & Discretionary")).toBeNull();
    expect(sectorEtfFor("Shipping")).toBeNull();
    expect(sectorEtfFor(null)).toBeNull();
  });
});

describe("latestDailyQuadrant", () => {
  const benchmark = closesOf(series(120, (index) => 400 + index));
  const member = closesOf(series(120, (index) => 50 + 0.5 * index ** 1.1));

  it("is null without a series or before the warm-up", () => {
    expect(latestDailyQuadrant(null, benchmark)).toBeNull();
    expect(latestDailyQuadrant(member, null)).toBeNull();
    expect(
      latestDailyQuadrant(member.slice(0, 40), benchmark.slice(0, 40))
    ).toBeNull();
  });

  it("is the newest daily rotation quadrant", () => {
    const expected = computeRotationPoints(
      member,
      benchmark,
      SECTOR_ROTATION_PARAMS.daily
    ).at(-1)?.quadrant;
    expect(expected).toBeDefined();
    expect(latestDailyQuadrant(member, benchmark)).toBe(expected);
  });
});

describe("screenMember", () => {
  const benchmark = closesOf(series(120, (index) => 400 + index));
  const bars = series(120, (index) => 100 + 0.1 * index);

  it("reports gates, quadrants and the sector ETF", () => {
    const result = screenMember({
      bars,
      benchmark,
      reason: null,
      sector: "Technology",
      sectorCloses: closesOf(bars),
      symbol: "AAA",
    });
    expect(result).toMatchObject({
      last: bars.at(-1)?.c,
      lastDate: bars.at(-1)?.date,
      reason: null,
      sector: "Technology",
      sectorEtf: "XLK",
      status: "pass",
      symbol: "AAA",
    });
    expect(result.quadrant).not.toBeNull();
    expect(result.sectorQuadrant).toBe(result.quadrant);
    expect(result.quadrantReason).toBeNull();
    expect(result.sectorQuadrantReason).toBeNull();
  });

  it("names why a rotation quadrant is missing", () => {
    const base = { benchmark, reason: null, symbol: "DDD" };
    expect(
      screenMember({ ...base, bars, sector: "Energy", sectorCloses: null })
        .sectorQuadrantReason
    ).toBe("XLE bars not loaded");
    expect(
      screenMember({ ...base, bars, sector: "Spaceships", sectorCloses: null })
        .sectorQuadrantReason
    ).toBe("No sector ETF mapped");
    const short = bars.slice(0, 3);
    expect(
      screenMember({
        ...base,
        bars: short,
        sector: "Energy",
        sectorCloses: closesOf(short),
      })
    ).toMatchObject({
      quadrantReason: "Too few daily bars shared with SPY",
      sectorQuadrantReason: "Too few daily bars shared with SPY",
    });
    expect(
      screenMember({
        ...base,
        bars,
        benchmark: null,
        sector: "Energy",
        sectorCloses: closesOf(bars),
      })
    ).toMatchObject({
      quadrantReason: "Benchmark SPY bars not loaded",
      sectorQuadrantReason: "Benchmark SPY bars not loaded",
    });
  });

  it("reports no data with the fetch reason when bars are missing", () => {
    const missing = screenMember({
      bars: null,
      benchmark,
      reason: "Yahoo chart returned HTTP 404",
      sector: null,
      sectorCloses: null,
      symbol: "BBB",
    });
    expect(missing).toEqual({
      gates: {
        aboveVwap20: { detail: "No daily bars", ok: null },
        emaTrend: { detail: "No daily bars", ok: null },
        notOverextended: { detail: "No daily bars", ok: null },
      },
      last: null,
      lastDate: null,
      quadrant: null,
      quadrantReason: "No daily bars",
      reason: "Yahoo chart returned HTTP 404",
      sector: null,
      sectorEtf: null,
      sectorQuadrant: null,
      sectorQuadrantReason: "No sector in import",
      status: "no_data",
      symbol: "BBB",
    });
    expect(
      screenMember({
        bars: [],
        benchmark: null,
        reason: null,
        sector: "Energy",
        sectorCloses: null,
        symbol: "CCC",
      })
    ).toMatchObject({ reason: "No daily bars", sectorEtf: "XLE" });
  });
});
