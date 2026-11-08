import { FilterStudySchema } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import seeded from "./fixtures/adx-filter-study.json";
import { toFilterStudyViewModel } from "./view-model.ts";

const metrics = {
  cagr: 0.0811,
  maxDrawdown: 0.2231,
  sharpe: 0.7979,
  sharpeHalves: [0.6791, null] as [number, null],
  trades: 1322,
  tradesPerYear: 60.666,
};

const study = {
  daily: {
    costBpsPerSide: 5,
    trials: 3,
    universe: ["SPY", "QQQ"],
    variants: [
      {
        ...metrics,
        deflatedProbability: 0.85,
        filter: "none",
        strategy: "sma_cross_20_50",
        verdict: null,
      },
      {
        ...metrics,
        deflatedProbability: null,
        filter: "adx_above",
        strategy: "sma_cross_20_50",
        verdict: "DROP (trade floor)",
      },
      {
        ...metrics,
        deflatedProbability: 0.5,
        filter: "adx_falling",
        strategy: "new_strategy",
        verdict: "KEEP (kept, not significant after deflation)",
      },
      {
        ...metrics,
        cagr: -0.0004,
        deflatedProbability: 0.97,
        filter: "adx_below",
        sharpeHalves: [0.5, 0.6],
        strategy: "sma_cross_20_50",
        verdict: "KEEP",
      },
    ],
    window: {
      days: 5492,
      end: "2026-10-30",
      secondHalfStart: "2015-11-30",
      start: "2005-01-03",
    },
  },
  id: "adx-rvol-filters",
  intraday: {
    barMinutes: 5,
    costBpsPerSide: 1,
    sensitivity: { costBpsPerSide: 5, verdict: "KEEP" },
    spearman: { firstHalf: 0.1063, secondHalf: null },
    symbol: "SPY",
    variants: [
      { ...metrics, filter: "none" },
      { ...metrics, filter: "rvol_above_1", sharpe: null },
    ],
    verdict: "KEEP",
    window: {
      end: "2021-05-06",
      secondHalfStart: "2014-09-30",
      sessions: 3325,
      start: "2008-02-20",
    },
  },
  ran: "2026-10-31",
  spec: "docs/specs/research/adx-filter.md",
};

describe("toFilterStudyViewModel", () => {
  it("formats rows, labels, verdict tones and summaries", () => {
    const model = toFilterStudyViewModel(study);
    expect(
      model.dailyRows.map((row) => [row.strategy, row.filter, row.tone])
    ).toEqual([
      ["SMA 20/50 cross", "No filter", "baseline"],
      ["SMA 20/50 cross", "ADX(14) > 20", "drop"],
      ["new_strategy", "ADX(14) falling over 5 bars", "caution"],
      ["SMA 20/50 cross", "ADX(14) < 20", "keep"],
    ]);
    expect(model.dailyRows[0]).toMatchObject({
      cagr: "8.1%",
      deflated: "0.85",
      firstHalf: "0.68",
      key: "sma_cross_20_50:none",
      maxDrawdown: "22.3%",
      secondHalf: "—",
      sharpe: "0.80",
      trades: "1,322",
      tradesPerYear: "60.7",
      verdict: "Baseline",
    });
    expect(model.dailyRows[1]?.deflated).toBe("—");
    expect(model.dailySummary).toBe(
      "2 of 3 ADX filter variants met the keep rule (Sharpe higher in both halves and at least 30 trades per year)."
    );
    expect(model.dailyCaption).toContain(
      "Equal-weight portfolio of 2 symbols (SPY, QQQ). 5 bp per side."
    );
    expect(
      model.intradayRows.map((row) => [row.filter, row.verdict, row.sharpe])
    ).toEqual([
      ["No filter", "Baseline", "0.80"],
      ["RVOL at time (20) > 1.0", "KEEP", "—"],
    ]);
    expect(model.intradayCaption).toContain(
      "SPY 5-minute bars, 2008-02-20 to 2021-05-06 (3,325 sessions"
    );
    expect(model.intradaySummary).toBe(
      "RVOL filter verdict: KEEP at 1 bp; KEEP at 5 bp. The filtered strategy still loses money (Sharpe 0.68 and — in the two halves), so the strategy itself does not work. Spearman correlation of RVOL with the absolute rest-of-day move: 0.11 (first half), — (second half)."
    );
    expect(model.dailyRows[3]?.cagr).toBe("0.0%");
    return expect(model.spec).toBe("docs/specs/research/adx-filter.md");
  });

  it("rejects an invalid summary", () => {
    expect(() => toFilterStudyViewModel({ ...study, extra: true })).toThrow();
    return expect(() =>
      toFilterStudyViewModel({ ...study, ran: "31 October 2026" })
    ).toThrow();
  });

  it("accepts the seeded study (the 0051_research_studies migration row)", () => {
    const parsed = FilterStudySchema.parse(seeded);
    expect(parsed.daily.variants).toHaveLength(13);
    return expect(
      parsed.intraday.variants.map((variant) => variant.filter)
    ).toEqual(["none", "rvol_above_1"]);
  });
});
