import { describe, expect, it } from "vitest";

import {
  isQcPortStudy,
  isStrategyBacktestStudy,
  type ResearchStudyDocument,
  ResearchStudyDocumentSchema,
  STRATEGY_BACKTEST_COMPARISON_MAX,
  STRATEGY_BACKTEST_EQUITY_MAX,
  STRATEGY_BACKTEST_FORMS_MAX,
  STRATEGY_BACKTEST_GAPS_MAX,
  STRATEGY_BACKTEST_NOTES_MAX,
  STRATEGY_BACKTEST_ROBUSTNESS_MAX,
  STRATEGY_BACKTEST_RULES_MAX,
  STRATEGY_BACKTEST_RUNS_MAX,
  STRATEGY_BACKTEST_SENSITIVITY_MAX,
  type StrategyBacktestRun,
  type StrategyBacktestStudy,
  StrategyBacktestStudySchema,
} from "./contracts/research-studies.ts";

// A small strategy-backtest study with every field set. The numbers are illustrative test values,
// not results of the LD34 study.
const RUN: StrategyBacktestRun = {
  buyHoldCagr: 0.104,
  buyHoldSharpe: 0.62,
  cagr: 0.071,
  exposure: 0.38,
  from: "2004-01-02",
  market: "US equity index ETF",
  maxDrawdown: -0.143,
  oosCagr: 0.052,
  oosSharpe: 0.48,
  profitFactor: 1.42,
  sharpe: 0.66,
  symbol: "SPY",
  to: "2026-11-06",
  trades: 212,
  winRate: 0.41,
};

const STUDY: StrategyBacktestStudy = {
  comparison: [
    {
      cagr: 0.104,
      kind: "buy-and-hold",
      maxDrawdown: -0.552,
      name: "SPY buy and hold",
      sharpe: 0.62,
    },
    {
      cagr: 0.048,
      kind: "library",
      maxDrawdown: -0.211,
      name: "Donchian breakout (library)",
      sharpe: 0.41,
    },
    {
      cagr: 0.071,
      kind: "strategy",
      maxDrawdown: -0.143,
      name: "LD34 as stated",
      sharpe: 0.66,
    },
  ],
  equity: [
    { drawdown: 0, month: "2026-06", value: 0 },
    { drawdown: 0, month: "2026-07", value: 0.012 },
    { drawdown: -0.021, month: "2026-08", value: -0.009 },
    { drawdown: 0, month: "2026-09", value: 0.018 },
  ],
  equityLabel: "LD34 as stated on SPY, return since start",
  forms: [
    {
      description:
        "Hourly close above the daily 20/50/100/200-day Donchian ladder; 2x ATR(14) stop, 1% risk.",
      key: "underlying",
      label: "As stated (underlying)",
      runs: [RUN],
    },
    {
      description:
        "Call debit vertical on the same signal, sized so the debit is at most 2% of equity.",
      key: "options",
      label: "Vertex form (options, defined risk)",
      runs: [
        {
          ...RUN,
          buyHoldCagr: null,
          buyHoldSharpe: null,
          oosCagr: null,
          oosSharpe: null,
          profitFactor: null,
          trades: 0,
          winRate: 0,
        },
      ],
    },
  ],
  gaps: [
    {
      choice: "20/50/100/200 days, the ladder shown on the chart.",
      gap: "Donchian lookbacks are not spoken.",
    },
  ],
  id: "ld34-nested-donchian-breakout",
  kind: "strategy-backtest",
  notes: "Test fixture.\nNumbers are illustrative.",
  provenance: {
    commit: "bde73275",
    dataHash: "sha256:3f1c9a0e",
    engine: "nautilus_trader 1.221.0",
    runId: "ld34-2026-11-08T21:00Z",
  },
  ran: "2026-11-08",
  robustness: [
    { check: "Walk-forward", pass: true, result: "OOS Sharpe 0.48 (> 0)" },
    {
      check: "Deflated Sharpe",
      pass: false,
      result: "0.41 after 24 trials",
    },
    { check: "Monte Carlo", pass: null, result: "5th percentile CAGR 2.1%" },
  ],
  rules: [
    {
      item: "Entry",
      rule: "Buy when an hourly bar closes above the 20-day Donchian high.",
      source: "transcript [18.50-22.70]",
    },
  ],
  sensitivity: [
    {
      cagr: 0.064,
      maxDrawdown: -0.151,
      param: "ATR stop multiple",
      sharpe: 0.6,
      trades: 230,
      value: "1.5",
    },
  ],
  source: {
    label: "Instagram reel DffCOSDBMoC",
    url: "https://www.instagram.com/reel/DffCOSDBMoC/",
  },
  spec: "docs/specs/strategies/ld34-nested-donchian-breakout.md",
  title: "LD34 nested Donchian long-only breakout",
  verdict: "needs-more-data",
  verdictReason: "Positive OOS Sharpe, but the deflated Sharpe fails.",
};

const valid = (document: unknown): boolean =>
  StrategyBacktestStudySchema.safeParse(document).success;

const withRun = (
  patch: Partial<Record<keyof StrategyBacktestRun, unknown>>
) => ({
  ...STUDY,
  forms: [{ ...STUDY.forms[0], runs: [{ ...RUN, ...patch }] }],
});

const repeat = <T>(item: T, count: number): T[] =>
  Array.from({ length: count }, () => item);

const months = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    drawdown: 0,
    month: `${String(1990 + Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, "0")}`,
    value: 0,
  }));

describe("strategy-backtest study contract", () => {
  it("accepts a document with every field and keeps it unchanged", () => {
    expect(StrategyBacktestStudySchema.parse(STUDY)).toEqual(STUDY);
    expect(ResearchStudyDocumentSchema.parse(STUDY)).toEqual(STUDY);
  });

  it("accepts empty optional lists, empty notes, null statistics and the size limits", () => {
    const lean = {
      ...STUDY,
      comparison: [],
      gaps: [],
      notes: "",
      robustness: [],
      sensitivity: [],
    };
    expect(StrategyBacktestStudySchema.parse(lean)).toEqual(lean);
    const full = {
      ...STUDY,
      comparison: repeat(STUDY.comparison[0], STRATEGY_BACKTEST_COMPARISON_MAX),
      equity: months(STRATEGY_BACKTEST_EQUITY_MAX),
      forms: [
        {
          ...STUDY.forms[0],
          runs: repeat(RUN, STRATEGY_BACKTEST_RUNS_MAX),
        },
        STUDY.forms[1],
      ],
      gaps: repeat(STUDY.gaps[0], STRATEGY_BACKTEST_GAPS_MAX),
      notes: "n".repeat(STRATEGY_BACKTEST_NOTES_MAX),
      robustness: repeat(STUDY.robustness[0], STRATEGY_BACKTEST_ROBUSTNESS_MAX),
      rules: repeat(STUDY.rules[0], STRATEGY_BACKTEST_RULES_MAX),
      sensitivity: repeat(
        STUDY.sensitivity[0],
        STRATEGY_BACKTEST_SENSITIVITY_MAX
      ),
      title: "t".repeat(200),
    };
    expect(valid(full)).toBe(true);
    // A run of one day, a flat run and drawdowns at the bounds.
    expect(
      valid(withRun({ cagr: -1, from: RUN.to, maxDrawdown: -1, sharpe: 0 }))
    ).toBe(true);
    expect(valid(withRun({ maxDrawdown: 0 }))).toBe(true);
  });

  it("selects the schema by kind and narrows with isStrategyBacktestStudy", () => {
    const document = ResearchStudyDocumentSchema.parse(STUDY);
    expect(isStrategyBacktestStudy(document)).toBe(true);
    expect(isQcPortStudy(document)).toBe(false);
    expect(
      isStrategyBacktestStudy({ kind: "filter" } as ResearchStudyDocument)
    ).toBe(false);
    expect(
      ResearchStudyDocumentSchema.safeParse({ ...STUDY, kind: "strategy" })
        .success
    ).toBe(false);
  });

  it("rejects a document without a required field", () => {
    for (const key of Object.keys(STUDY)) {
      const { [key as keyof StrategyBacktestStudy]: _dropped, ...rest } = STUDY;
      expect(valid(rest), key).toBe(false);
    }
  });

  it("rejects bad top-level fields and extra keys", () => {
    const bad: Record<string, unknown>[] = [
      { extra: 1 },
      { title: "" },
      { title: " LD34" },
      { title: "t".repeat(201) },
      { ran: "2026-02-30" },
      { ran: "2026-11-8" },
      { spec: "docs/specs/research/ld34.md" },
      { spec: "docs/specs/strategies/LD34.md" },
      { id: "ld34" },
      { id: "Ld34-nested-donchian-breakout" },
      { verdict: "PASS" },
      { verdictReason: "" },
      { verdictReason: "r".repeat(1001) },
      { equityLabel: "" },
      { notes: "n".repeat(STRATEGY_BACKTEST_NOTES_MAX + 1) },
      { notes: null },
    ];
    for (const patch of bad)
      expect(valid({ ...STUDY, ...patch }), JSON.stringify(patch)).toBe(false);
  });

  it("requires an https source with a label", () => {
    for (const source of [
      { ...STUDY.source, url: "http://www.instagram.com/reel/DffCOSDBMoC/" },
      { ...STUDY.source, url: "javascript:alert(1)" },
      { ...STUDY.source, url: "instagram.com/reel/DffCOSDBMoC" },
      { ...STUDY.source, url: `https://example.com/${"a".repeat(300)}` },
      { ...STUDY.source, label: "" },
      { ...STUDY.source, extra: 1 },
    ])
      expect(valid({ ...STUDY, source }), JSON.stringify(source)).toBe(false);
  });

  it("rejects bad rules, gaps, robustness, sensitivity and comparison rows", () => {
    const bad: Record<string, unknown>[] = [
      { rules: [] },
      { rules: repeat(STUDY.rules[0], STRATEGY_BACKTEST_RULES_MAX + 1) },
      { rules: [{ ...STUDY.rules[0], item: "i".repeat(61) }] },
      { rules: [{ ...STUDY.rules[0], rule: "" }] },
      { rules: [{ ...STUDY.rules[0], source: "s".repeat(201) }] },
      { rules: [{ ...STUDY.rules[0], extra: 1 }] },
      { gaps: repeat(STUDY.gaps[0], STRATEGY_BACKTEST_GAPS_MAX + 1) },
      { gaps: [{ ...STUDY.gaps[0], choice: "" }] },
      { gaps: [{ ...STUDY.gaps[0], gap: "g".repeat(301) }] },
      {
        robustness: repeat(
          STUDY.robustness[0],
          STRATEGY_BACKTEST_ROBUSTNESS_MAX + 1
        ),
      },
      { robustness: [{ ...STUDY.robustness[0], pass: "yes" }] },
      { robustness: [{ ...STUDY.robustness[0], check: "c".repeat(81) }] },
      { robustness: [{ ...STUDY.robustness[0], result: "" }] },
      {
        sensitivity: repeat(
          STUDY.sensitivity[0],
          STRATEGY_BACKTEST_SENSITIVITY_MAX + 1
        ),
      },
      { sensitivity: [{ ...STUDY.sensitivity[0], trades: 1.5 }] },
      { sensitivity: [{ ...STUDY.sensitivity[0], maxDrawdown: 0.1 }] },
      { sensitivity: [{ ...STUDY.sensitivity[0], sharpe: null }] },
      { sensitivity: [{ ...STUDY.sensitivity[0], value: "v".repeat(41) }] },
      {
        comparison: repeat(
          STUDY.comparison[0],
          STRATEGY_BACKTEST_COMPARISON_MAX + 1
        ),
      },
      { comparison: [{ ...STUDY.comparison[0], kind: "benchmark" }] },
      { comparison: [{ ...STUDY.comparison[0], cagr: -1.5 }] },
      { comparison: [{ ...STUDY.comparison[0], name: "n".repeat(81) }] },
    ];
    for (const patch of bad)
      expect(valid({ ...STUDY, ...patch }), JSON.stringify(patch)).toBe(false);
  });

  it("rejects bad forms: none, too many, repeated or unknown keys, no runs", () => {
    const [underlying, options] = STUDY.forms;
    for (const forms of [
      [],
      repeat(underlying, STRATEGY_BACKTEST_FORMS_MAX + 1),
      [underlying, underlying],
      [{ ...options, key: "futures" }],
      [{ ...underlying, runs: [] }],
      [{ ...underlying, runs: repeat(RUN, STRATEGY_BACKTEST_RUNS_MAX + 1) }],
      [{ ...underlying, label: "" }],
      [{ ...underlying, description: "d".repeat(601) }],
      [{ ...underlying, extra: 1 }],
    ])
      expect(valid({ ...STUDY, forms }), JSON.stringify(forms)).toBe(false);
  });

  it("rejects bad run statistics, including non-finite numbers", () => {
    const bad: Partial<Record<keyof StrategyBacktestRun, unknown>>[] = [
      { from: "2026-11-07", to: "2026-11-06" },
      { from: "2004-13-01" },
      { trades: -1 },
      { trades: 1.5 },
      { maxDrawdown: 0.01 },
      { maxDrawdown: -1.01 },
      { winRate: 1.01 },
      { exposure: -0.01 },
      { profitFactor: -0.1 },
      { cagr: -1.01 },
      { cagr: null },
      { sharpe: Number.POSITIVE_INFINITY },
      { sharpe: Number.NaN },
      { oosSharpe: "0.4" },
      { buyHoldCagr: Number.NEGATIVE_INFINITY },
      { symbol: "" },
      { symbol: "S".repeat(41) },
      { market: "m".repeat(61) },
    ];
    for (const patch of bad)
      expect(valid(withRun(patch)), JSON.stringify(patch)).toBe(false);
    expect(valid(withRun({ extra: 1 } as never))).toBe(false);
  });

  it("rejects short, oversized, unordered or out-of-range equity", () => {
    const [first, second] = STUDY.equity as [
      StrategyBacktestStudy["equity"][number],
      StrategyBacktestStudy["equity"][number],
    ];
    for (const equity of [
      [first],
      months(STRATEGY_BACKTEST_EQUITY_MAX + 1),
      [second, first],
      [first, { ...second, month: first.month }],
      [first, { ...second, month: "2026-13" }],
      [first, { ...second, drawdown: 0.01 }],
      [first, { ...second, value: -1.01 }],
      [first, { ...second, extra: 1 }],
    ])
      expect(valid({ ...STUDY, equity }), JSON.stringify(equity)).toBe(false);
  });

  it("requires a traceable provenance: a 7 to 40 character lowercase commit", () => {
    for (const commit of ["bde7327", "a".repeat(40)])
      expect(
        valid({ ...STUDY, provenance: { ...STUDY.provenance, commit } })
      ).toBe(true);
    for (const provenance of [
      { ...STUDY.provenance, commit: "bde732" },
      { ...STUDY.provenance, commit: "BDE73275" },
      { ...STUDY.provenance, commit: "a".repeat(41) },
      { ...STUDY.provenance, engine: "" },
      { ...STUDY.provenance, dataHash: "h".repeat(81) },
      { ...STUDY.provenance, runId: " run" },
      { ...STUDY.provenance, extra: 1 },
    ])
      expect(valid({ ...STUDY, provenance }), JSON.stringify(provenance)).toBe(
        false
      );
  });

  it("names the id when it differs from the spec slug", () => {
    const issues = StrategyBacktestStudySchema.safeParse({
      ...STUDY,
      id: "ld34",
    }).error?.issues;
    expect(issues).toEqual([
      expect.objectContaining({
        message:
          "Expected id to equal the spec slug ld34-nested-donchian-breakout",
        path: ["id"],
      }),
    ]);
  });
});
