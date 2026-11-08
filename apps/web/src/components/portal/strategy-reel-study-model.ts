// What: display rows for a strategy-backtest study (researchStudies.get, kind "strategy-backtest")
// on the strategy library detail of an entry tagged backtest-study, for example a strategy taken
// from a reel. Pure mapping; the document is validated by the API (StrategyBacktestStudySchema).
// Research only: a study verdict grants no trading authority.
import type { StrategyBacktestStudy } from "@darkfactory/api";

import { formatRatio, formatSignedPercent } from "./strategy-library-model.ts";
import type { JournalPoint } from "./trade-journal-model.ts";

/** Strategy library entries with this tag have a strategy-backtest study stored under their slug. */
export const BACKTEST_STUDY_TAG = "backtest-study";

type Verdict = StrategyBacktestStudy["verdict"];

export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  edge: "Edge",
  "needs-more-data": "Needs more data",
  "no-edge": "No edge",
};

const COMPARISON_KIND_LABELS: Readonly<
  Record<StrategyBacktestStudy["comparison"][number]["kind"], string>
> = {
  "buy-and-hold": "Buy and hold",
  library: "Library strategy",
  strategy: "This strategy",
};

export type RobustnessStatus = "pass" | "fail" | "info";

export type StrategyStudyRunRow = Readonly<{
  key: string;
  symbol: string;
  market: string;
  period: string;
  trades: string;
  cagr: string;
  sharpe: string;
  maxDrawdown: string;
  profitFactor: string;
  winRate: string;
  exposure: string;
  oosSharpe: string;
  oosCagr: string;
  buyHoldCagr: string;
  buyHoldSharpe: string;
}>;

export type StrategyStudyFormView = Readonly<{
  key: string;
  label: string;
  description: string;
  runs: readonly StrategyStudyRunRow[];
}>;

export type StrategyStudyViewModel = Readonly<{
  title: string;
  ran: string;
  spec: string;
  verdict: Verdict;
  verdictLabel: string;
  verdictReason: string;
  source: Readonly<{ url: string; label: string }>;
  rules: readonly Readonly<{
    key: string;
    item: string;
    rule: string;
    source: string;
  }>[];
  gaps: readonly Readonly<{ key: string; gap: string; choice: string }>[];
  forms: readonly StrategyStudyFormView[];
  robustness: readonly Readonly<{
    key: string;
    check: string;
    result: string;
    status: RobustnessStatus;
  }>[];
  sensitivity: readonly Readonly<{
    key: string;
    param: string;
    value: string;
    sharpe: string;
    cagr: string;
    maxDrawdown: string;
    trades: string;
  }>[];
  comparison: readonly Readonly<{
    key: string;
    name: string;
    kind: string;
    sharpe: string;
    cagr: string;
    maxDrawdown: string;
  }>[];
  /** Return since the start (0 = starting equity), oldest first, for lineGeometry. */
  equity: readonly JournalPoint[];
  /** Drawdown from the running peak (0 or negative), oldest first, for lineGeometry. */
  drawdown: readonly JournalPoint[];
  equityLabel: string;
  equitySummary: string;
  drawdownSummary: string;
  /** Commit, engine, data hash and run id of the study. */
  provenance: string;
  notes: string;
}>;

const count = (value: number): string => value.toLocaleString("en-US");

const robustnessStatus = (pass: boolean | null): RobustnessStatus => {
  if (pass === null) return "info";
  return pass ? "pass" : "fail";
};

export const toStrategyStudyViewModel = (
  study: StrategyBacktestStudy
): StrategyStudyViewModel => {
  const equity = study.equity.map((point) => ({
    time: point.month,
    value: point.value,
  }));
  const drawdown = study.equity.map((point) => ({
    time: point.month,
    value: point.drawdown,
  }));
  // The schema keeps at least two equity points, so the first and last exist.
  const first = study.equity[0] as StrategyBacktestStudy["equity"][number];
  const last = study.equity.at(-1) as StrategyBacktestStudy["equity"][number];
  const worst = study.equity.reduce((deepest, point) =>
    point.drawdown < deepest.drawdown ? point : deepest
  );
  return {
    comparison: study.comparison.map((row, index) => ({
      cagr: formatSignedPercent(row.cagr),
      key: `${index}:${row.name}`,
      kind: COMPARISON_KIND_LABELS[row.kind],
      maxDrawdown: formatSignedPercent(row.maxDrawdown),
      name: row.name,
      sharpe: formatRatio(row.sharpe),
    })),
    drawdown,
    drawdownSummary:
      worst.drawdown === 0
        ? "No drawdown in the stored months."
        : `Deepest drawdown ${formatSignedPercent(worst.drawdown)} in ${worst.month}.`,
    equity,
    equityLabel: study.equityLabel,
    equitySummary: `Monthly equity ${first.month} to ${last.month}: ${formatSignedPercent(last.value)} since the start.`,
    forms: study.forms.map((form) => ({
      description: form.description,
      key: form.key,
      label: form.label,
      runs: form.runs.map((run, index) => ({
        buyHoldCagr: formatSignedPercent(run.buyHoldCagr),
        buyHoldSharpe: formatRatio(run.buyHoldSharpe),
        cagr: formatSignedPercent(run.cagr),
        exposure: formatSignedPercent(run.exposure),
        key: `${index}:${run.symbol}`,
        market: run.market,
        maxDrawdown: formatSignedPercent(run.maxDrawdown),
        oosCagr: formatSignedPercent(run.oosCagr),
        oosSharpe: formatRatio(run.oosSharpe),
        period: `${run.from} to ${run.to}`,
        // Null means no losing trade; with no trades at all there is no ratio.
        profitFactor:
          run.profitFactor === null && run.trades > 0
            ? "no losses"
            : formatRatio(run.profitFactor),
        sharpe: formatRatio(run.sharpe),
        symbol: run.symbol,
        trades: count(run.trades),
        winRate: formatSignedPercent(run.winRate),
      })),
    })),
    gaps: study.gaps.map((row, index) => ({
      choice: row.choice,
      gap: row.gap,
      key: `${index}`,
    })),
    notes: study.notes,
    provenance: `Code ${study.provenance.commit.slice(0, 12)} · ${study.provenance.engine} · data ${study.provenance.dataHash} · run ${study.provenance.runId}`,
    ran: study.ran,
    robustness: study.robustness.map((row, index) => ({
      check: row.check,
      key: `${index}:${row.check}`,
      result: row.result,
      status: robustnessStatus(row.pass),
    })),
    rules: study.rules.map((row, index) => ({
      item: row.item,
      key: `${index}:${row.item}`,
      rule: row.rule,
      source: row.source,
    })),
    sensitivity: study.sensitivity.map((row, index) => ({
      cagr: formatSignedPercent(row.cagr),
      key: `${index}:${row.param}:${row.value}`,
      maxDrawdown: formatSignedPercent(row.maxDrawdown),
      param: row.param,
      sharpe: formatRatio(row.sharpe),
      trades: count(row.trades),
      value: row.value,
    })),
    source: study.source,
    spec: study.spec,
    title: study.title,
    verdict: study.verdict,
    verdictLabel: VERDICT_LABELS[study.verdict],
    verdictReason: study.verdictReason,
  };
};
