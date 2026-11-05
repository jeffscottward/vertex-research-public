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
      date: dateAt(index),
      o: c,
      h: c + halfRange,
      l: c - halfRange,
      c,
      v: volume,
    };
  });

const rising = series(80, (index) => 100 + 0.1 * index);
const falling = series(80, (index) => 200 - 0.1 * index);

describe("emaTrendGate", () => {
  it("needs 50 bars", () => {
    expect(emaTrendGate(rising.slice(0, 49))).toEqual({
      ok: null,
      detail: "Not enough history (49 bars, needs 50)",
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
      ok: null,
      detail: "No volume in the last 20 bars",
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
      { date: "2026-01-01", o: 1, h: 12, l: 6, c: 9, v: 1 },
      { date: "2026-01-02", o: 1, h: 30, l: 15, c: 15, v: 3 },
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
    bars[15] = { date: dateAt(15), o: 10, h: 18, l: 2, c: 10, v: 1 };
    expect(wilderAtr(bars, 14)).toBe(3);
  });

  it("uses gaps from the previous close", () => {
    const bars: ScreenBar[] = [
      { date: "2026-01-01", o: 10, h: 10, l: 10, c: 10, v: 1 },
      { date: "2026-01-02", o: 14, h: 15, l: 14, c: 15, v: 1 },
      { date: "2026-01-03", o: 5, h: 6, l: 5, c: 5, v: 1 },
    ];
    expect(wilderAtr(bars, 2)).toBe((5 + 10) / 2);
  });
});

describe("notOverextendedGate", () => {
  it("needs 20 bars", () => {
    expect(notOverextendedGate(rising.slice(0, 19))).toEqual({
      ok: null,
      detail: "Not enough history (19 bars, needs 20)",
    });
  });

  it("fails a close far above EMA20 + 2 × ATR14", () => {
    expect(notOverextendedGate(rising)).toMatchObject({ ok: true });
    const spiked = [
      ...rising.slice(0, -1),
      { date: dateAt(79), o: 150, h: 151, l: 149, c: 150, v: 1000 },
    ];
    const result = notOverextendedGate(spiked);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(
      /^Close 150\.00 vs ceiling \d+\.\d{2} \(EMA20 \d+\.\d{2} \+ 2×ATR14 \d+\.\d{2}\)$/u
    );
  });
});

describe("screenStatus", () => {
  it("is unknown without bars or with any open gate", () => {
    expect(screenStatus(null)).toBe("unknown");
    expect(screenStatus(screenGates(rising.slice(0, 30)))).toBe("unknown");
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
      symbol: "AAA",
      sector: "Technology",
      bars,
      reason: null,
      benchmark,
      sectorCloses: closesOf(bars),
    });
    expect(result).toMatchObject({
      symbol: "AAA",
      status: "pass",
      last: bars.at(-1)?.c,
      lastDate: bars.at(-1)?.date,
      sector: "Technology",
      sectorEtf: "XLK",
      reason: null,
    });
    expect(result.quadrant).not.toBeNull();
    expect(result.sectorQuadrant).toBe(result.quadrant);
  });

  it("is unknown with the fetch reason when bars are missing", () => {
    const missing = screenMember({
      symbol: "BBB",
      sector: null,
      bars: null,
      reason: "Yahoo chart returned HTTP 404",
      benchmark,
      sectorCloses: null,
    });
    expect(missing).toEqual({
      symbol: "BBB",
      status: "unknown",
      last: null,
      lastDate: null,
      gates: {
        emaTrend: { ok: null, detail: "No daily bars" },
        aboveVwap20: { ok: null, detail: "No daily bars" },
        notOverextended: { ok: null, detail: "No daily bars" },
      },
      quadrant: null,
      sector: null,
      sectorEtf: null,
      sectorQuadrant: null,
      reason: "Yahoo chart returned HTTP 404",
    });
    expect(
      screenMember({
        symbol: "CCC",
        sector: "Energy",
        bars: [],
        reason: null,
        benchmark: null,
        sectorCloses: null,
      })
    ).toMatchObject({ reason: "No daily bars", sectorEtf: "XLE" });
  });
});
