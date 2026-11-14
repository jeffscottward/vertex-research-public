import {
  BACKTEST_STUDY_TAG,
  StrategyBacktestStudySchema,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import fixture from "../../features/research-studies/fixtures/strategy-backtest-study.json";
import { VERDICT_LABELS } from "./strategy-library-model.ts";
import { toStrategyStudyViewModel } from "./strategy-reel-study-model.ts";

const STUDY = StrategyBacktestStudySchema.parse(fixture);

describe("toStrategyStudyViewModel", () => {
  it("maps the verdict, source, rules, gaps and provenance", () => {
    const model = toStrategyStudyViewModel(STUDY);
    expect(BACKTEST_STUDY_TAG).toBe("backtest-study");
    expect(model).toMatchObject({
      equityLabel: "LD34 as stated on SPY: return since the first month",
      notes: STUDY.notes,
      provenance:
        "Code bde73275e2a1 · nautilus_trader 1.221.0 · data sha256:3f1c9a0e77d2 · run ld34-2026-11-08T21:00Z",
      ran: "2026-11-08",
      source: {
        label: "Instagram reel DffCOSDBMoC (hooper.algo.fxx)",
        url: "https://www.instagram.com/reel/DffCOSDBMoC/",
      },
      spec: "docs/specs/strategies/ld34-nested-donchian-breakout.md",
      title: "LD34 nested Donchian long-only breakout",
      verdict: "needs-more-data",
      verdictLabel: "Needs more data",
      verdictReason: STUDY.verdictReason,
    });
    expect(model.rules[0]).toEqual({
      item: "Entry",
      key: "0:Entry",
      rule: "Buy when an hourly bar closes above the 20-day Donchian high.",
      source: "transcript [18.50-22.70]",
    });
    expect(model.gaps.map((row) => row.key)).toEqual(["0", "1"]);
    expect(VERDICT_LABELS).toEqual({
      edge: "Edge",
      "needs-more-data": "Needs more data",
      "no-edge": "No edge",
    });
  });

  it("formats each run, with a dash for a missing statistic", () => {
    const [underlying, options] = toStrategyStudyViewModel(STUDY).forms;
    expect(underlying?.runs[0]).toEqual({
      buyHoldCagr: "10.40%",
      buyHoldSharpe: "0.62",
      cagr: "7.10%",
      exposure: "38.00%",
      key: "0:SPY",
      market: "US equity index ETF",
      maxDrawdown: "-14.30%",
      oosCagr: "5.20%",
      oosSharpe: "0.48",
      period: "2004-01-02 to 2026-11-06",
      profitFactor: "1.42",
      sharpe: "0.66",
      symbol: "SPY",
      trades: "1,212",
      winRate: "41.00%",
    });
    expect(underlying?.runs[1]).toMatchObject({
      buyHoldCagr: "—",
      buyHoldSharpe: "—",
      oosCagr: "—",
      oosSharpe: "—",
      profitFactor: "—",
      trades: "0",
    });
    expect(options).toMatchObject({
      key: "options",
      label: "Vertex form (options, defined risk)",
    });
  });

  it("shows a missing profit factor with trades as no losses", () => {
    const [form] = STUDY.forms;
    const [run] = form?.runs ?? [];
    const study = StrategyBacktestStudySchema.parse({
      ...STUDY,
      forms: [{ ...form, runs: [{ ...run, profitFactor: null, trades: 3 }] }],
    });
    expect(
      toStrategyStudyViewModel(study).forms[0]?.runs[0]?.profitFactor
    ).toBe("no losses");
  });

  it("labels robustness, sensitivity and comparison rows", () => {
    const model = toStrategyStudyViewModel(STUDY);
    expect(model.robustness.map((row) => row.status)).toEqual([
      "pass",
      "fail",
      "info",
    ]);
    expect(model.sensitivity[0]).toEqual({
      cagr: "6.40%",
      key: "0:ATR stop multiple:1.5",
      maxDrawdown: "-15.10%",
      param: "ATR stop multiple",
      sharpe: "0.60",
      trades: "1,290",
      value: "1.5",
    });
    expect(model.comparison.map((row) => row.kind)).toEqual([
      "Buy and hold",
      "Library strategy",
      "This strategy",
    ]);
  });

  it("splits the equity curve into return and drawdown series and names the deepest drawdown", () => {
    const model = toStrategyStudyViewModel(STUDY);
    expect(model.equity[0]).toEqual({ time: "2026-05", value: 0 });
    expect(model.drawdown[2]).toEqual({ time: "2026-07", value: -0.021 });
    expect(model.equitySummary).toBe(
      "Monthly equity 2026-05 to 2026-10: 3.10% since the start."
    );
    expect(model.drawdownSummary).toBe("Deepest drawdown -2.10% in 2026-07.");
    const flat = toStrategyStudyViewModel({
      ...STUDY,
      equity: [
        { drawdown: 0, month: "2026-01", value: 0 },
        { drawdown: 0, month: "2026-02", value: 0.01 },
      ],
    });
    expect(flat.drawdownSummary).toBe("No drawdown in the stored months.");
  });
});
