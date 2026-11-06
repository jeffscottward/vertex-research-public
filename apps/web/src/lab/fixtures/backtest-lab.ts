// What: Deterministic fake backtest data for the UI lab: stored series, instant runs, backtest run
// reports, sweeps, combos, drift monitors, setup replay and Autopilot campaigns.
// Used by: apps/web/src/lab/entries/backtest-lab.tsx.
import {
  type AutopilotCampaignDetailOutput,
  type AutopilotCampaignOutput,
  type AutopilotCandidateDetailOutput,
  type AutopilotCandidateSummaryOutput,
  type AutopilotGateOutput,
  assessSweepRobustness,
  type BacktestCombo,
  type BacktestComboInput,
  type BacktestRun,
  type BacktestRunReportOutput,
  type BacktestRunSummary,
  type BacktestSweepInput,
  type BacktestSweepOutput,
  type ForwardDriftAlert,
  type ForwardDriftMonitor,
  type ForwardDriftMonitorSummary,
  type InstantBacktestRunInput,
  type InstantBacktestRunOutput,
  type InstantBacktestSeries,
  type SetupReplayOccurrence,
  type SetupReplayPreset,
  type SetupReplayRunInput,
  type SetupReplayRunOutput,
  STRATEGY_TEMPLATES,
  type StrategyDefinition,
  StrategyDefinitionSchema,
} from "@darkfactory/api";
import { CORE7_MARKETS } from "@darkfactory/shared/universes";

import { createSeededRandom, LAB_NOW, labDaysAgo, roundTo } from "./core.ts";
import { labBars } from "./market.ts";

const DAY_MS = 86_400_000;
const SERIES_BARS = 750;
const REPORT_BARS = 260;
const SHA = (letter: string): string => letter.repeat(64);
const at = (days: number): Date => new Date(LAB_NOW.getTime() - days * DAY_MS);
/** Index into a fixture list whose length the fixture itself fixes (never out of range). */
const item = <T>(list: readonly T[], index: number): T => list[index] as T;
const final = <T>(list: readonly T[]): T => list.at(-1) as T;
const isoDay = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().slice(0, 10);
const HEX = "0123456789abcdef";

/** Core 7 futures first (the default universe), then their ETF twins and two stocks. */
const SERIES_SYMBOLS: readonly string[] = [
  ...CORE7_MARKETS.map((market) => market.future),
  ...CORE7_MARKETS.map((market) => market.etf),
  "AAPL",
  "NVDA",
];

const seriesOf = (symbol: string, index: number): InstantBacktestSeries => {
  const bars = labBars(symbol, SERIES_BARS);
  return {
    barCount: bars.length,
    firstT: item(bars, 0).t * 1000,
    importedAt: `${labDaysAgo(1)}T06:00:00.000Z`,
    lastT: final(bars).t * 1000,
    source: "Demo daily bars (fake data)",
    sourceSha256: SHA(HEX.charAt(index % 16)),
    symbol,
    timeframe: "1d",
  };
};

export const LAB_BACKTEST_SERIES: readonly InstantBacktestSeries[] =
  SERIES_SYMBOLS.map(seriesOf);

const seriesFor = (symbol: string): InstantBacktestSeries =>
  LAB_BACKTEST_SERIES.find((entry) => entry.symbol === symbol) ??
  seriesOf(symbol, 0);

/** Equity path that follows the bars with a dampened beta and a little seeded noise. */
const equityPath = (symbol: string, count: number): number[] => {
  const bars = labBars(symbol, count);
  const random = createSeededRandom(`equity:${symbol}:${count}`);
  const first = item(bars, 0).c;
  return bars.map((bar, index) =>
    roundTo(
      (bar.c / first) ** 0.7 * (1 + index * 0.0004 + (random() - 0.5) * 0.01),
      5
    )
  );
};

const maxDrawdown = (values: readonly number[]): number => {
  let peak = item(values, 0);
  let worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    worst = Math.max(worst, (peak - value) / peak);
  }
  return roundTo(worst, 4);
};

export const labInstantRun = (
  input: InstantBacktestRunInput
): InstantBacktestRunOutput => {
  const series = seriesFor(input.symbol);
  const bars = labBars(input.symbol, SERIES_BARS);
  const seed =
    input.rule.kind === "smaCross" ? input.rule.fast : input.rule.entryLookback;
  const curve = equityPath(`${input.symbol}:${seed}`, SERIES_BARS);
  const last = final(curve);
  const buyHold = final(bars).c / item(bars, 0).c - 1;
  return {
    equity: bars.map((bar, index) => ({
      equity: item(curve, index),
      t: bar.t * 1000,
    })),
    series,
    stats: {
      bars: bars.length,
      buyHoldMaxDrawdown: -maxDrawdown(bars.map((bar) => bar.c)),
      buyHoldReturn: roundTo(buyHold, 4),
      cagr: roundTo(last ** (252 / SERIES_BARS) - 1, 4),
      exposure: 0.64,
      maxDrawdown: -maxDrawdown(curve),
      profitFactor: 1.62,
      sharpe: 0.94,
      sortino: 1.31,
      totalReturn: roundTo(last - 1, 4),
      trades: 14 + (seed % 9),
      winRate: 0.57,
    },
    timing: { cache: "hit", computeMs: 3.4, loadMs: 0.6 },
  };
};

const reportOf = (symbol: string, capital: number): BacktestRunReportOutput => {
  const bars = labBars(symbol, REPORT_BARS);
  const curve = equityPath(symbol, REPORT_BARS);
  let peak = capital;
  const equity = curve.map((value, index) => {
    const money = roundTo(capital * value);
    peak = Math.max(peak, money);
    return {
      drawdownPct: roundTo((peak - money) / peak, 4),
      equity: money,
      t: item(bars, index).t * 1000,
    };
  });
  const finalEquity = final(equity).equity;
  const trades: BacktestRunReportOutput["trades"] = [];
  let balance = capital;
  for (let n = 1; n <= 6; n += 1) {
    const entry = item(bars, n * 36);
    const exit = item(bars, n * 36 + 20);
    const entryPrice = entry.c;
    const exitPrice = exit.c;
    const units = Math.floor(balance / entryPrice);
    const pnl = roundTo((exitPrice - entryPrice) * units);
    balance = roundTo(balance + pnl);
    trades.push({
      balanceAfter: balance,
      entryPrice,
      entryT: entry.t * 1000,
      exitPrice,
      exitReason: n % 3 === 0 ? "stop" : "signal",
      exitT: exit.t * 1000,
      n,
      netReturn: roundTo(exitPrice / entryPrice - 1, 4),
      pnl,
      units,
    });
  }
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl <= 0);
  const grossProfit = roundTo(wins.reduce((sum, trade) => sum + trade.pnl, 0));
  const grossLoss = roundTo(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const netProfit = roundTo(finalEquity - capital);
  const drawdownPct = Math.max(...equity.map((point) => point.drawdownPct));
  return {
    bars: bars.length,
    equity,
    firstT: item(equity, 0).t,
    lastT: final(equity).t,
    metrics: {
      absoluteDrawdown: roundTo(capital * 0.03),
      averageLossTrade: roundTo(grossLoss / Math.max(1, losses.length)),
      averageProfitTrade: roundTo(grossProfit / Math.max(1, wins.length)),
      buyHoldReturn: roundTo(final(bars).c / item(bars, 0).c - 1, 4),
      cagr: roundTo(finalEquity / capital - 1, 4),
      expectedPayoff: roundTo(netProfit / trades.length),
      exposure: 0.61,
      finalEquity,
      grossLoss,
      grossProfit,
      initialDeposit: capital,
      largestLossTrade: Math.min(...trades.map((trade) => trade.pnl)),
      largestProfitTrade: Math.max(...trades.map((trade) => trade.pnl)),
      lossTrades: losses.length,
      maxConsecutiveLosses: 2,
      maxConsecutiveLossesMoney: roundTo(grossLoss / 2),
      maxConsecutiveWins: 3,
      maxDrawdownAbs: roundTo(drawdownPct * capital),
      maxDrawdownPct: drawdownPct,
      maximalConsecutiveLoss: roundTo(grossLoss / 2),
      maximalConsecutiveLossCount: 2,
      netProfit,
      profitFactor: 1.74,
      profitTrades: wins.length,
      recoveryFactor: 2.1,
      sharpe: 1.08,
      sortino: 1.52,
      totalReturn: roundTo(finalEquity / capital - 1, 4),
      totalTrades: trades.length,
      winRate: roundTo(wins.length / trades.length, 4),
    },
    prices: bars.map((bar) => ({
      c: bar.c,
      h: bar.h,
      l: bar.l,
      o: bar.o,
      t: bar.t * 1000,
    })),
    seriesSha256: seriesFor(symbol).sourceSha256,
    trades,
    tradesTruncated: false,
  };
};

/** A finished fake run: its report is always present. */
type LabRun = BacktestRun & Readonly<{ report: BacktestRunReportOutput }>;

const runOf = (symbol: string, index: number): LabRun => ({
  createdAt: at(index + 1),
  engineVersion: "instant-2",
  error: null,
  finishedAt: at(index + 1),
  id: `lab-run-${symbol.replace("=F", "").toLowerCase()}`,
  report: reportOf(symbol, 10_000),
  spec: {
    costBps: 2,
    from: labDaysAgo(REPORT_BARS * 1.4),
    initialCapital: 10_000,
    rule: { fast: 20 + index * 5, kind: "smaCross", slow: 120 + index * 10 },
    stopLossPct: 0,
    symbol,
    takeProfitPct: 0,
    timeframe: "1d",
    to: labDaysAgo(0),
  },
  startedAt: at(index + 1),
  status: "succeeded",
  strategyId: "lab-strategy-momentum",
  strategyRevision: SHA(HEX.charAt(10 + (index % 2))),
  strategySnapshot: {
    id: "lab-strategy-momentum",
    kind: "dsl",
    name: "Demo momentum v1",
    params: [],
    slug: "demo-momentum-v1",
    sourceRef: null,
    updatedAt: labDaysAgo(30),
  },
});

/** One finished run per Core 7 future, newest first. */
const LAB_BACKTEST_RUNS: readonly LabRun[] = CORE7_MARKETS.map(
  (market, index) => runOf(market.future, index)
);

export const LAB_BACKTEST_RUN_SUMMARIES: readonly BacktestRunSummary[] =
  LAB_BACKTEST_RUNS.map(({ report: _report, ...summary }) => summary);

export const LAB_DEFAULT_RUN_ID: string = item(LAB_BACKTEST_RUNS, 0).id;

export const labBacktestRun = (id: string): LabRun =>
  LAB_BACKTEST_RUNS.find((run) => run.id === id) ?? item(LAB_BACKTEST_RUNS, 0);

export const LAB_STRATEGIES: readonly Readonly<{ id: string; name: string }>[] =
  [
    { id: "lab-strategy-momentum", name: "Demo momentum v1" },
    { id: "lab-strategy-breakout", name: "Demo breakout v2" },
  ];

/** A smooth fake surface over every grid cell, ranked with the real robustness scorer. */
export const labSweep = (input: BacktestSweepInput): BacktestSweepOutput => {
  const dimensions = input.dimensions.map((dimension) => {
    const values: number[] = [];
    for (
      let value = dimension.from;
      value <= dimension.to + 1e-9;
      value += dimension.step
    )
      values.push(roundTo(value, 6));
    return { param: dimension.param, values };
  });
  const shape = dimensions.map((dimension) => dimension.values.length);
  const size = shape.reduce((product, length) => product * length, 1);
  const cells = Array.from({ length: size }, (_, index) => {
    const coordinates: number[] = [];
    let rest = index;
    for (let dimension = shape.length - 1; dimension >= 0; dimension -= 1) {
      const length = item(shape, dimension);
      coordinates.unshift(rest % length);
      rest = Math.floor(rest / length);
    }
    const score = coordinates.reduce(
      (sum, position, dimension) =>
        sum + Math.sin((position + 1) / (item(shape, dimension) / 2.5)),
      0
    );
    const value = roundTo(0.18 + score * 0.12, 4);
    return { coordinates, value };
  });
  const robustness = assessSweepRobustness(
    shape,
    cells.map((cell) => cell.value)
  );
  const series = seriesFor(input.symbol);
  return {
    bars: series.barCount,
    cells: cells.map((cell, index) => ({
      coordinates: cell.coordinates,
      error: null,
      metrics: {
        cagr: roundTo(cell.value / 3, 4),
        maxDrawdown: roundTo(-0.12 - Math.abs(cell.value) / 4, 4),
        profitFactor: roundTo(1.2 + cell.value, 3),
        sharpe: roundTo(0.6 + cell.value * 2, 3),
        sortino: roundTo(0.8 + cell.value * 2.5, 3),
        totalReturn: cell.value,
        winRate: 0.55,
      },
      params: cell.coordinates.map((position, dimension) =>
        item(item(dimensions, dimension).values, position)
      ),
      robustness: {
        neighbourMean: item(robustness.neighbourMean, index),
        neighbours: item(robustness.neighbours, index),
        rank: item(robustness.rank, index),
        spike: item(robustness.spike, index),
        worst: item(robustness.worst, index),
      },
      trades: 12 + (index % 7),
    })),
    computeMs: 42,
    dimensions,
    engineVersion: "instant-2",
    firstT: series.firstT,
    from: input.from,
    lastT: series.lastT,
    metric: input.metric ?? "totalReturn",
    ranking: [...robustness.ranking],
    seriesSha256: series.sourceSha256,
    spikeRatio: 0.5,
    symbol: input.symbol,
    timeframe: input.timeframe,
    to: input.to,
  };
};

/** Combined equity of the chosen runs at their weights; the rest of the deposit stays cash. */
export const labCombo = (input: BacktestComboInput): BacktestCombo => {
  const slots = input.slots.map((slot) => ({
    run: labBacktestRun(slot.runId),
    weight: slot.weight,
  }));
  const invested = slots.reduce((sum, slot) => sum + slot.weight, 0);
  const cash = roundTo(input.deposit * (1 - invested));
  const points = Array.from({ length: REPORT_BARS }, (_, index) => {
    const equity = slots.reduce((sum, slot) => {
      const point = item(slot.run.report.equity, index);
      return sum + (input.deposit * slot.weight * point.equity) / 10_000;
    }, cash);
    return {
      equity: roundTo(equity),
      t: item(item(slots, 0).run.report.equity, index).t,
    };
  });
  let peak = input.deposit;
  const withDrawdown = points.map((point) => {
    peak = Math.max(peak, point.equity);
    return { ...point, drawdownPct: roundTo((peak - point.equity) / peak, 4) };
  });
  const finalEquity = final(withDrawdown).equity;
  const combinedDrawdownPct = Math.max(
    ...withDrawdown.map((point) => point.drawdownPct)
  );
  const stats = {
    cagr: roundTo(finalEquity / input.deposit - 1, 4),
    maxDrawdownPct: combinedDrawdownPct,
    sharpe: 1.21,
    totalReturn: roundTo(finalEquity / input.deposit - 1, 4),
  };
  const matrix = (same: number, other: number): number[][] =>
    slots.map((_, row) =>
      slots.map((__, column) => (row === column ? same : other))
    );
  return {
    cash,
    correlation: matrix(1, 0.34),
    deposit: input.deposit,
    diversification: {
      combinedDrawdownPct,
      diversified: true,
      ratio: 0.72,
      weightedSlotDrawdownPct: roundTo(combinedDrawdownPct / 0.72, 4),
    },
    drawdownOverlap: matrix(1, 0.28),
    finalEquity,
    jointDrawdownShare: 0.28,
    netProfit: roundTo(finalEquity - input.deposit),
    points: withDrawdown,
    slots: slots.map((slot, index) => {
      const { metrics } = slot.run.report;
      const full = {
        cagr: metrics.cagr,
        maxDrawdownPct: metrics.maxDrawdownPct,
        sharpe: metrics.sharpe,
        totalReturn: metrics.totalReturn,
      };
      return {
        allocation: roundTo(input.deposit * slot.weight),
        engineVersion: slot.run.engineVersion,
        full,
        label: `${slot.run.spec.symbol} · Demo momentum v1`,
        pnl: roundTo(input.deposit * slot.weight * full.totalReturn),
        recent: { ...full, sharpe: index === 1 ? 0.31 : 0.98 },
        runId: slot.run.id,
        seriesSha256: slot.run.report.seriesSha256,
        strategyRevision: slot.run.strategyRevision,
        verdict: index === 1 ? "degrading" : "robust",
        verdictReason:
          index === 1
            ? "Recent Sharpe is less than half of the full-period Sharpe."
            : "Recent results hold up against the full period.",
        weight: slot.weight,
      };
    }),
    stats,
  };
};

const THRESHOLDS: ForwardDriftMonitorSummary["thresholds"] = {
  drawdown: { alert: 2, warn: 1.5 },
  losingStreak: { alert: 2, warn: 1.5 },
  profitFactor: { alert: 0.5, warn: 0.7 },
  sharpe: { alert: 0.4, warn: 0.6 },
  winRate: { alert: 0.6, warn: 0.8 },
};

export const LAB_DRIFT_ALERTS: readonly ForwardDriftAlert[] = [
  {
    acknowledgedAt: null,
    baselineValue: 0.09,
    check: "drawdown",
    createdAt: at(1),
    forwardValue: 0.15,
    id: "lab-alert-1",
    level: "warn",
    message: "Paper drawdown is 1.7x the backtest drawdown.",
    monitorId: "lab-monitor-es",
    ratio: 1.67,
  },
];

const summaryOf = (
  run: BacktestRun,
  index: number
): ForwardDriftMonitorSummary => ({
  baselineRunId: run.id,
  createdAt: at(40 + index),
  id: `lab-monitor-${run.spec.symbol.replace("=F", "").toLowerCase()}`,
  label: `${run.spec.symbol} · Demo momentum v1`,
  level: index === 0 ? "warn" : "ok",
  paper: {
    note: "Recorded 1 new settled bar",
    status: index === 0 ? "running" : "off",
    tickedAt: at(0),
  },
  pointCount: 30,
  strategyRevision: run.strategyRevision,
  thresholds: THRESHOLDS,
  tradeCount: 8,
  updatedAt: at(0),
  version: 3,
});

export const LAB_DRIFT_MONITORS: readonly ForwardDriftMonitorSummary[] =
  LAB_BACKTEST_RUNS.slice(0, 3).map(summaryOf);

export const labDriftMonitor = (id: string): ForwardDriftMonitor => {
  const summary =
    LAB_DRIFT_MONITORS.find((monitor) => monitor.id === id) ??
    item(LAB_DRIFT_MONITORS, 0);
  const run = labBacktestRun(summary.baselineRunId);
  const equity = run.report.equity.map((point) => ({
    equity: point.equity,
    t: point.t,
  }));
  const last = final(equity);
  const random = createSeededRandom(`drift:${id}`);
  const points = Array.from({ length: 30 }, (_, index) => ({
    equity: roundTo(
      last.equity * (1 + (random() - 0.55) * 0.02 * index ** 0.5)
    ),
    t: last.t + (index + 1) * DAY_MS,
  }));
  return {
    ...summary,
    alerts: LAB_DRIFT_ALERTS.filter((alert) => alert.monitorId === id),
    baseline: {
      engineVersion: run.engineVersion,
      equity,
      initialCapital: run.spec.initialCapital,
      label: summary.label,
      seriesSha256: run.report.seriesSha256,
    },
    checks: [
      {
        alertAt: 2,
        baseline: 0.09,
        direction: "higher-is-worse",
        forward: 0.15,
        key: "drawdown",
        label: "Max drawdown",
        level: "warn",
        minSample: 10,
        ratio: 1.67,
        reason: "Paper drawdown is 1.7x the backtest drawdown.",
        sample: 30,
        warnAt: 1.5,
      },
      {
        alertAt: 0.4,
        baseline: 1.08,
        direction: "lower-is-worse",
        forward: 0.92,
        key: "sharpe",
        label: "Sharpe ratio",
        level: "ok",
        minSample: 20,
        ratio: 0.85,
        reason: "Within the warn threshold.",
        sample: 30,
        warnAt: 0.6,
      },
      {
        alertAt: 0.6,
        baseline: 0.67,
        direction: "lower-is-worse",
        forward: 0.63,
        key: "winRate",
        label: "Win rate",
        level: "ok",
        minSample: 5,
        ratio: 0.94,
        reason: "Within the warn threshold.",
        sample: 8,
        warnAt: 0.8,
      },
    ],
    points,
    trades: points
      .filter((_, index) => index % 4 === 3)
      .map((point, index) => ({
        pnl: index % 3 === 2 ? -84.5 : 132.25,
        t: point.t,
      })),
  };
};

export const LAB_SETUP_PRESETS: readonly SetupReplayPreset[] = [
  {
    description: "Opens above the prior day's high and closes above the open.",
    id: "gapUpHold",
    label: "Gap up and hold",
  },
  {
    description: "Closes above the highest high of the prior 20 days.",
    id: "breakout20",
    label: "20-day breakout",
  },
  {
    description: "RSI(2) below 10 while above the 200-day average.",
    id: "rsi2Oversold",
    label: "RSI(2) oversold",
  },
  {
    description: "Closes back above the 50-day average after a close below it.",
    id: "reclaim50",
    label: "50-day reclaim",
  },
];

export const labSetupReplay = (
  input: SetupReplayRunInput
): SetupReplayRunOutput => {
  const symbol = input.seriesId.replace(":1d", "");
  const bars = labBars(symbol, SERIES_BARS);
  const outcomes: readonly SetupReplayOccurrence["outcome"][] = [
    "target",
    "stop",
    "target",
    "time",
    "target",
    "stop",
  ];
  const occurrences = outcomes.map((outcome, index) => {
    const entry = item(bars, SERIES_BARS - 30 - index * 60);
    const exit = item(bars, SERIES_BARS - 25 - index * 60);
    const rMultiple =
      outcome === "target" ? input.targetR : outcome === "stop" ? -1 : 0.35;
    const entryPrice = entry.c;
    return {
      barsHeld: outcome === "time" ? input.maxHoldBars : 4,
      entryDate: isoDay(entry.t),
      entryPrice,
      exitDate: isoDay(exit.t),
      exitPrice: roundTo(entryPrice * (1 + rMultiple * 0.02)),
      outcome,
      returnPct: roundTo(rMultiple * 2, 2),
      rMultiple,
    };
  });
  return {
    monteCarlo: {
      paths: input.paths,
      pProfit: 0.71,
      seed: 4242,
      totalR: { p5: -3.1, p25: 0.8, p50: 2.9, p75: 5.2, p95: 8.4 },
      totalReturnPct: { p5: -6.2, p25: 1.6, p50: 5.9, p75: 10.6, p95: 17.3 },
      tradesPerPath: occurrences.length,
    },
    occurrences,
    series: {
      bars: bars.length,
      from: new Date(item(bars, 0).t * 1000).toISOString().slice(0, 10),
      id: input.seriesId,
      symbol,
      to: new Date(final(bars).t * 1000).toISOString().slice(0, 10),
    },
    summary: {
      avgR: 0.62,
      breakEvenShare: roundTo(1 / (1 + input.targetR), 4),
      count: occurrences.length,
      expectancyR: 0.71,
      stopFirst: 2,
      targetFirst: 3,
      targetShare: 0.6,
      timeExit: 1,
      winRate: 0.67,
    },
  };
};

const LAB_DEFINITION: StrategyDefinition = StrategyDefinitionSchema.parse({
  ...STRATEGY_TEMPLATES.smaCross,
  name: "Demo momentum v1",
});

const AUTOPILOT_CONFIG: AutopilotCampaignOutput["config"] = {
  budget: {
    gatePerGeneration: 3,
    maxCandidates: 2000,
    maxCpuMinutes: 60,
    populationSize: 40,
    tickSeconds: 20,
  },
  costBps: 5,
  gateVersion: "autopilot-gate-v1",
  seed: 7,
};

export const LAB_AUTOPILOT_CAMPAIGNS: readonly AutopilotCampaignOutput[] = [
  {
    bestCandidateId: "lab-cand-1",
    bestFitness: 1.62,
    candidateCount: 480,
    config: AUTOPILOT_CONFIG,
    cpuMs: 1_260_000,
    createdAt: at(3),
    createdBy: "analyst@example.test",
    finishedAt: null,
    gatedCount: 18,
    generation: 12,
    id: "lab-campaign-es",
    name: "Demo ES=F daily breeding",
    note: null,
    startedAt: at(3),
    status: "stopped",
    symbol: "ES=F",
    tickedAt: at(0),
    timeframe: "1d",
    updatedAt: at(0),
    verifiedCount: 2,
  },
  {
    bestCandidateId: null,
    bestFitness: 0.88,
    candidateCount: 2000,
    config: { ...AUTOPILOT_CONFIG, seed: 11 },
    cpuMs: 3_600_000,
    createdAt: at(9),
    createdBy: "analyst@example.test",
    finishedAt: at(7),
    gatedCount: 40,
    generation: 50,
    id: "lab-campaign-gc",
    name: "Demo GC=F daily breeding",
    note: "Candidate budget reached",
    startedAt: at(9),
    status: "completed",
    symbol: "GC=F",
    tickedAt: at(7),
    timeframe: "1d",
    updatedAt: at(7),
    verifiedCount: 0,
  },
];

const LAB_GATE: AutopilotGateOutput = {
  checks: [
    {
      detail: "Annualized out-of-sample Sharpe 1.04.",
      id: "oosSharpe",
      label: "Out-of-sample Sharpe",
      passed: true,
      threshold: ">= 0.5",
      value: 1.04,
    },
    {
      detail: "In-sample Sharpe deflated for 480 trials.",
      id: "deflatedSharpe",
      label: "Deflated Sharpe ratio",
      passed: true,
      threshold: ">= 0.95",
      value: 0.97,
    },
    {
      detail: "38 trades in the full period.",
      id: "minTrades",
      label: "Minimum trades",
      passed: true,
      threshold: ">= 30",
      value: 38,
    },
  ],
  costStress: { costBps: 10, oosSharpe: 0.86 },
  deflatedSharpe: {
    expectedMaxSharpe: 0.42,
    probability: 0.97,
    sharpe: 1.62,
    trials: 480,
  },
  fdr: { discoveries: 2, qValue: 0.04, tested: 18 },
  folds: [
    { from: "2024-01-02", to: "2024-12-31", totalReturn: 0.11 },
    { from: "2025-01-02", to: "2025-12-31", totalReturn: 0.07 },
  ],
  monteCarlo: {
    drawdownP5: -0.18,
    finalP5: 0.04,
    finalP50: 0.31,
    probabilityOfProfit: 0.88,
  },
  neighbours: [],
  oos: {
    cagr: 0.09,
    maxDrawdown: -0.11,
    sharpe: 1.04,
    totalReturn: 0.19,
    trades: 14,
  },
  passed: true,
  splitT: "2024-01-02T00:00:00.000Z",
  tradesTotal: 38,
  version: "autopilot-gate-v1",
};

const candidateOf = (
  index: number,
  status: AutopilotCandidateSummaryOutput["status"]
): AutopilotCandidateSummaryOutput => ({
  campaignId: "lab-campaign-es",
  createdAt: at(1),
  deploymentRequestId: null,
  fitness: roundTo(1.62 - index * 0.11, 2),
  gate:
    status === "evaluated"
      ? null
      : { ...LAB_GATE, passed: status === "verified" },
  gatedAt: status === "evaluated" ? null : at(1),
  generation: 12 - index,
  id: `lab-cand-${index + 1}`,
  inSample: {
    fitness: roundTo(1.62 - index * 0.11, 2),
    maxDrawdown: roundTo(-0.09 - index * 0.01, 2),
    sharpe: roundTo(1.62 - index * 0.11, 2),
    totalReturn: roundTo(0.64 - index * 0.05, 2),
    trades: 38 - index,
  },
  label: `trendSma(${200 - index * 10}) / exitBelowSma(${20 + index})`,
  oosSharpe: status === "evaluated" ? null : roundTo(1.04 - index * 0.2, 2),
  origin: item(
    ["crossover", "mutation", "neighbour", "random"] as const,
    index % 4
  ),
  parentIds: [],
  status,
  strategyId: null,
});

const LAB_CANDIDATES: readonly AutopilotCandidateSummaryOutput[] = [
  candidateOf(0, "verified"),
  candidateOf(1, "verified"),
  candidateOf(2, "rejected"),
  candidateOf(3, "evaluated"),
  candidateOf(4, "evaluated"),
];

export const labAutopilotDetail = (
  id: string
): AutopilotCampaignDetailOutput => ({
  campaign:
    LAB_AUTOPILOT_CAMPAIGNS.find((campaign) => campaign.id === id) ??
    item(LAB_AUTOPILOT_CAMPAIGNS, 0),
  gated: LAB_CANDIDATES.filter((candidate) => candidate.gate !== null),
  leaderboard: [...LAB_CANDIDATES],
  seriesTrials: 480,
});

export const labAutopilotCandidate = (
  id: string
): AutopilotCandidateDetailOutput => {
  const candidate =
    LAB_CANDIDATES.find((entry) => entry.id === id) ?? item(LAB_CANDIDATES, 0);
  return {
    candidate,
    children: LAB_CANDIDATES.slice(3),
    curve: equityPath(`autopilot:${id}`, 120).map((equity, index) => ({
      equity,
      t: new Date(LAB_NOW.getTime() - (119 - index) * 7 * DAY_MS).toISOString(),
    })),
    definition: LAB_DEFINITION,
    liveReadiness: {
      allowed: false,
      checks: [
        {
          detail: "Every gate check passed.",
          id: "gate",
          label: "Verification gate",
          status: "pass",
        },
        {
          detail: "Live trades use options on the ETF twin only.",
          id: "optionsOnly",
          label: "Master rule: options only",
          status: "conflict",
        },
      ],
    },
    nautilus: null,
    parents: [],
  };
};
