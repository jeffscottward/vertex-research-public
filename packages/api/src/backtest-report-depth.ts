// Backtest report depth (LuxAlgo gap P3): trade analysis, a per-run Monte Carlo cone with
// histograms, and a prop-firm style rule catalog with a pass/fail simulation.
// Every value is a deterministic function of one stored backtest run report. The Monte Carlo
// reuses the analytics simulator (`monteCarlo`) with a seed taken from the run's data hash.
// Research only: nothing here places, sizes or routes an order.

import {
  createRandom,
  type MonteCarloRun,
  monteCarlo,
  seedFrom,
} from "./backtest-analytics.ts";
import type { BacktestRunReportOutput } from "./contracts/backtest-runs.ts";

type ReportTrade = BacktestRunReportOutput["trades"][number];

const DAY_MS = 24 * 60 * 60 * 1000;
export const REPORT_MONTE_CARLO_PATHS = 1000;
const HISTOGRAM_BINS = 20;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export type HistogramBin = Readonly<{
  from: number;
  to: number;
  count: number;
}>;

// Equal-width bins over [min, max]; one bin when all values are equal; [] when empty.
export const histogram = (
  values: readonly number[],
  bins = HISTOGRAM_BINS
): HistogramBin[] => {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return [];
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of finite) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const count = high === low ? 1 : Math.max(1, Math.floor(bins));
  const width = high === low ? 1 : (high - low) / count;
  const indexes = finite.map((value) =>
    Math.min(count - 1, Math.floor((value - low) / width))
  );
  return Array.from({ length: count }, (_, index) => ({
    count: indexes.filter((at) => at === index).length,
    from: low + index * width,
    to: low + (index + 1) * width,
  }));
};

// ---------------------------------------------------------------------------
// Trades analysis

export type TradeGroupRow = Readonly<{
  key: string;
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  avgPnl: number;
}>;

export type TradesAnalysis = Readonly<{
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoffRatio: number | null;
  expectancy: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  avgHoldMs: number | null;
  avgHoldWinMs: number | null;
  avgHoldLossMs: number | null;
  byExitReason: TradeGroupRow[];
  byWeekday: TradeGroupRow[];
  pnlHistogram: HistogramBin[];
  holdDaysHistogram: HistogramBin[];
}>;

const average = (values: readonly number[]): number | null =>
  values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;

const groupRows = (
  trades: readonly ReportTrade[],
  keyOf: (trade: ReportTrade) => string,
  order: readonly string[]
): TradeGroupRow[] => {
  const groups = new Map<string, ReportTrade[]>();
  for (const trade of trades) {
    const key = keyOf(trade);
    const list = groups.get(key) ?? [];
    list.push(trade);
    groups.set(key, list);
  }
  return order.flatMap((key) => {
    const list = groups.get(key);
    if (list === undefined) return [];
    const wins = list.filter((trade) => trade.pnl > 0).length;
    const netPnl = list.reduce((total, trade) => total + trade.pnl, 0);
    return [
      {
        avgPnl: netPnl / list.length,
        key,
        netPnl,
        trades: list.length,
        winRate: wins / list.length,
        wins,
      },
    ];
  });
};

export const tradesAnalysis = (
  trades: readonly ReportTrade[]
): TradesAnalysis => {
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl < 0);
  const hold = (trade: ReportTrade) => trade.exitT - trade.entryT;
  const avgWin = average(wins.map((trade) => trade.pnl));
  const avgLoss = average(losses.map((trade) => trade.pnl));
  const pnls = trades.map((trade) => trade.pnl);
  return {
    avgHoldLossMs: average(losses.map(hold)),
    avgHoldMs: average(trades.map(hold)),
    avgHoldWinMs: average(wins.map(hold)),
    avgLoss,
    avgWin,
    byExitReason: groupRows(trades, (trade) => trade.exitReason, [
      "signal",
      "stop",
      "target",
      "end",
    ]),
    byWeekday: groupRows(
      trades,
      (trade) =>
        new Date(trade.entryT).toLocaleDateString("en-US", {
          timeZone: "UTC",
          weekday: "short",
        }),
      WEEKDAYS
    ),
    expectancy: average(pnls),
    holdDaysHistogram: histogram(trades.map((trade) => hold(trade) / DAY_MS)),
    largestLoss:
      losses.length === 0 ? null : Math.min(...losses.map((t) => t.pnl)),
    largestWin: wins.length === 0 ? null : Math.max(...wins.map((t) => t.pnl)),
    losses: losses.length,
    payoffRatio:
      avgWin === null || avgLoss === null || avgLoss === 0
        ? null
        : avgWin / Math.abs(avgLoss),
    pnlHistogram: histogram(pnls),
    trades: trades.length,
    winRate: trades.length === 0 ? null : wins.length / trades.length,
    wins: wins.length,
  };
};

// ---------------------------------------------------------------------------
// Per-run Monte Carlo (reshuffled trade order), cone and histograms

export type RunMonteCarlo = Readonly<{
  paths: number;
  seed: number;
  run: MonteCarloRun;
  finalPnlHistogram: HistogramBin[];
  maxDrawdownHistogram: HistogramBin[];
}>;

export const runMonteCarlo = (
  report: Pick<BacktestRunReportOutput, "trades" | "seriesSha256">,
  capital: number,
  mode: "reshuffle" | "bootstrap" = "reshuffle",
  paths = REPORT_MONTE_CARLO_PATHS
): RunMonteCarlo | null => {
  if (report.trades.length < 2 || !(capital > 0)) return null;
  const seed = seedFrom(`${report.seriesSha256}:${mode}`);
  const samples = { drawdowns: [] as number[], finals: [] as number[] };
  const run = monteCarlo(
    report.trades.map((trade) => trade.pnl),
    capital,
    mode,
    createRandom(seed),
    paths,
    samples
  );
  return {
    finalPnlHistogram: histogram(samples.finals),
    maxDrawdownHistogram: histogram(samples.drawdowns.map((v) => v * 100)),
    paths,
    run,
    seed,
  };
};

// ---------------------------------------------------------------------------
// Prop-firm style rule catalog and pass/fail simulation.
// Generic rule sets modeled on common evaluation formats; not tied to or endorsed by any firm.
// All limits are a percent of the starting balance, checked per UTC day. With a complete per-bar
// equity curve the day uses account equity, so intraday dips count; else closed trade P&L by exit day.

export type PropRule = Readonly<{
  id: string;
  label: string;
  profitTargetPct: number;
  maxDailyLossPct: number | null;
  maxLossPct: number;
  drawdown: "static" | "trailing";
  minTradingDays: number;
  // Best day may be at most this share of total profit when the target is reached.
  consistencyPct: number | null;
}>;

export const PROP_RULES: readonly PropRule[] = [
  {
    consistencyPct: null,
    drawdown: "static",
    id: "one-step",
    label: "One-step evaluation",
    maxDailyLossPct: 4,
    maxLossPct: 6,
    minTradingDays: 3,
    profitTargetPct: 10,
  },
  {
    consistencyPct: null,
    drawdown: "static",
    id: "two-step-1",
    label: "Two-step, phase 1",
    maxDailyLossPct: 5,
    maxLossPct: 10,
    minTradingDays: 4,
    profitTargetPct: 8,
  },
  {
    consistencyPct: null,
    drawdown: "static",
    id: "two-step-2",
    label: "Two-step, phase 2",
    maxDailyLossPct: 5,
    maxLossPct: 10,
    minTradingDays: 4,
    profitTargetPct: 5,
  },
  {
    consistencyPct: 50,
    drawdown: "trailing",
    id: "trailing-futures",
    label: "Futures-style trailing drawdown",
    maxDailyLossPct: null,
    maxLossPct: 4,
    minTradingDays: 5,
    profitTargetPct: 6,
  },
];

// One trading day: closing P&L and, from the equity curve, the lowest point of the day relative
// to the day's starting balance (`low` <= min(0, pnl)). Without `low` the day uses closed P&L only.
export type PropDay = Readonly<{ day: string; pnl: number; low?: number }>;

export type PropOutcome = Readonly<{
  status: "passed" | "failed" | "open";
  reason: string;
  // Trading days used up to the decision (or all days when open).
  days: number;
  decidedOn: string | null;
  finalPct: number;
  bestDayPct: number;
}>;

// Closed P&L per UTC exit day, in date order.
export const dailyPnl = (trades: readonly ReportTrade[]): PropDay[] => {
  const days = new Map<string, number>();
  for (const trade of trades) {
    const day = utcDay(trade.exitT);
    days.set(day, (days.get(day) ?? 0) + trade.pnl);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, pnl]) => ({ day, pnl }));
};

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

// Per-bar account equity grouped by UTC day, so intraday dips count against the limits.
export const dailyFromEquity = (
  equity: BacktestRunReportOutput["equity"],
  capital: number
): PropDay[] => {
  const byDay = new Map<string, { close: number; min: number }>();
  for (const point of equity) {
    const day = utcDay(point.t);
    const seen = byDay.get(day);
    byDay.set(day, {
      close: point.equity,
      min: Math.min(seen?.min ?? point.equity, point.equity),
    });
  }
  let start = capital;
  return [...byDay].map(([day, { close, min }]) => {
    const row = { day, low: Math.min(0, min - start), pnl: close - start };
    start = close;
    return row;
  });
};

const fmt = (value: number) => `${value.toFixed(2)}%`;

export const simulatePropRule = (
  days: readonly PropDay[],
  capital: number,
  rule: PropRule
): PropOutcome => {
  let balance = capital;
  let peak = capital;
  let bestDay = 0;
  const pct = (value: number) => (value / capital) * 100;
  // Trading days: days with any P&L movement (flat days on the equity curve do not count).
  let used = 0;
  for (const day of days) {
    const dayLow = day.low ?? Math.min(0, day.pnl);
    if (day.pnl !== 0 || dayLow !== 0) used += 1;
    const lowest = balance + dayLow;
    balance += day.pnl;
    bestDay = Math.max(bestDay, day.pnl);
    const result = (
      status: PropOutcome["status"],
      reason: string
    ): PropOutcome => ({
      bestDayPct: pct(bestDay),
      days: used,
      decidedOn: day.day,
      finalPct: pct(balance - capital),
      reason,
      status,
    });
    if (rule.maxDailyLossPct !== null && pct(-dayLow) >= rule.maxDailyLossPct)
      return result(
        "failed",
        `Daily loss ${fmt(pct(-dayLow))} hit the ${fmt(rule.maxDailyLossPct)} limit`
      );
    // Trailing floor follows the end-of-day balance peak and stops rising at the starting balance.
    const floor =
      rule.drawdown === "static"
        ? capital * (1 - rule.maxLossPct / 100)
        : Math.min(capital, peak - (capital * rule.maxLossPct) / 100);
    if (Math.min(lowest, balance) <= floor)
      return result(
        "failed",
        `${rule.drawdown === "static" ? "Max loss" : "Trailing drawdown"} ${fmt(rule.maxLossPct)} breached`
      );
    peak = Math.max(peak, balance);
    const profit = balance - capital;
    if (
      pct(profit) >= rule.profitTargetPct &&
      used >= rule.minTradingDays &&
      (rule.consistencyPct === null ||
        bestDay <= (profit * rule.consistencyPct) / 100)
    )
      return result(
        "passed",
        `Target ${fmt(rule.profitTargetPct)} reached in ${used} trading days`
      );
  }
  const finalProfit = balance - capital;
  let openReason = `Target ${fmt(rule.profitTargetPct)} not reached`;
  if (pct(finalProfit) >= rule.profitTargetPct) {
    openReason =
      used < rule.minTradingDays
        ? `Target reached but only ${used} of ${rule.minTradingDays} trading days`
        : `Target reached but best day is over ${rule.consistencyPct}% of profit`;
  }
  return {
    bestDayPct: pct(bestDay),
    days: used,
    decidedOn: null,
    finalPct: pct(finalProfit),
    reason: openReason,
    status: "open",
  };
};

export type PropSimulation = Readonly<{
  rule: PropRule;
  outcome: PropOutcome;
  // Share of reshuffled day orders that pass / fail (same daily P&L, random order).
  passRate: number;
  failRate: number;
  paths: number;
}>;

// The chart equity series is thinned on long runs; only a full one has every bar.
export const propRulesUseEquity = (
  report: Pick<BacktestRunReportOutput, "bars" | "equity">
): boolean => report.equity.length > 0 && report.equity.length === report.bars;

// Uses the per-bar equity curve when complete (intraday dips count); else closed trade P&L.
export const simulatePropRules = (
  report: Pick<
    BacktestRunReportOutput,
    "bars" | "equity" | "trades" | "seriesSha256"
  >,
  capital: number,
  rules: readonly PropRule[] = PROP_RULES,
  paths = REPORT_MONTE_CARLO_PATHS
): PropSimulation[] => {
  const days = propRulesUseEquity(report)
    ? dailyFromEquity(report.equity, capital)
    : dailyPnl(report.trades);
  return rules.map((rule) => {
    const random = createRandom(seedFrom(`${report.seriesSha256}:${rule.id}`));
    let passed = 0;
    let failed = 0;
    const order = [...days];
    for (let path = 0; path < paths && days.length > 0; path += 1) {
      for (let index = order.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        const held = order[index] as PropDay;
        order[index] = order[swap] as PropDay;
        order[swap] = held;
      }
      const status = simulatePropRule(order, capital, rule).status;
      if (status === "passed") passed += 1;
      else if (status === "failed") failed += 1;
    }
    const total = days.length === 0 ? 1 : paths;
    return {
      failRate: failed / total,
      outcome: simulatePropRule(days, capital, rule),
      passRate: passed / total,
      paths: days.length === 0 ? 0 : paths,
      rule,
    };
  });
};

// ---------------------------------------------------------------------------
// Bar-by-bar replay state (charts page): pure reducer so the controls are testable.

export const REPLAY_SPEEDS = [1, 2, 5, 10, 25] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export type BarReplayState = Readonly<{
  active: boolean;
  playing: boolean;
  // Index of the last visible bar.
  index: number;
  total: number;
  speed: ReplaySpeed;
}>;

export type BarReplayAction =
  | Readonly<{ type: "start"; total: number; from?: number }>
  | Readonly<{ type: "stop" }>
  | Readonly<{ type: "play" }>
  | Readonly<{ type: "pause" }>
  | Readonly<{ type: "step"; by: number }>
  | Readonly<{ type: "seek"; index: number }>
  | Readonly<{ type: "tick" }>
  | Readonly<{ type: "speed"; speed: ReplaySpeed }>
  | Readonly<{ type: "resize"; total: number }>;

export const BAR_REPLAY_IDLE: BarReplayState = {
  active: false,
  index: 0,
  playing: false,
  speed: 1,
  total: 0,
};

const clampIndex = (index: number, total: number) =>
  Math.max(0, Math.min(Math.max(0, total - 1), Math.round(index)));

export const barReplayReducer = (
  state: BarReplayState,
  action: BarReplayAction
): BarReplayState => {
  switch (action.type) {
    case "start": {
      if (action.total <= 0) return BAR_REPLAY_IDLE;
      const from = action.from ?? Math.floor(action.total / 2);
      return {
        ...state,
        active: true,
        index: clampIndex(from, action.total),
        playing: false,
        total: action.total,
      };
    }
    case "stop":
      return { ...BAR_REPLAY_IDLE, speed: state.speed };
    case "play":
      return state.active && state.index < state.total - 1
        ? { ...state, playing: true }
        : state;
    case "pause":
      return { ...state, playing: false };
    case "step":
      return state.active
        ? {
            ...state,
            index: clampIndex(state.index + action.by, state.total),
            playing: false,
          }
        : state;
    case "seek":
      return state.active
        ? { ...state, index: clampIndex(action.index, state.total) }
        : state;
    case "tick": {
      if (!(state.active && state.playing)) return state;
      const index = clampIndex(state.index + 1, state.total);
      return { ...state, index, playing: index < state.total - 1 };
    }
    case "speed":
      return { ...state, speed: action.speed };
    case "resize":
      return state.active
        ? action.total <= 0
          ? { ...BAR_REPLAY_IDLE, speed: state.speed }
          : {
              ...state,
              index: clampIndex(state.index, action.total),
              total: action.total,
            }
        : state;
  }
};
