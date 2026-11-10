// What: UI lab fixtures for the strategy pages: library, backtests, Quant Lab, filter studies,
// optimizations, Academy gate and Vertex strategy specs. Fictional and deterministic (seeded from
// LAB_NOW).
// Used by: apps/web/src/lab/entries/strategies.tsx.
import {
  type AcademyDeployInput,
  type AcademyGateOutput,
  type AcademyTickersOutput,
  type AgentTaskOutput,
  BacktestAnalyticsSchema,
  type BacktestGetOutput,
  type BacktestResultSummaryOutput,
  computeOptimizationAnalytics,
  type FilterStudy,
  type OptimizationGetOutput,
  type OptimizationRunOutput,
  type OptimizationSummaryOutput,
  type QuantLabListOutput,
  type ResearchStudy,
  type StrategyGetOutput,
  type StrategyPresetOutput,
  type StrategySummaryOutput,
} from "@darkfactory/api";
import { type StrategySpec, StrategySpecSchema } from "@darkfactory/api/vertex";
import { hashArtifact } from "@darkfactory/shared/vertex";
import type {
  ExperienceScope,
  ImmutableArtifact,
} from "../../features/experience/ports.ts";
import backtestAnalyticsJson from "./backtest-analytics.json";
import {
  createSeededRandom,
  LAB_NOW,
  LAB_TICKERS,
  labBasePrice,
  labDaysAgo,
  roundTo,
} from "./core.ts";

/** A Date `days` before LAB_NOW. */
const labDate = (days: number): Date =>
  new Date(LAB_NOW.getTime() - days * 86_400_000);

// ---------------------------------------------------------------------------
// Backtests

type NonEmpty<T> = readonly [T, ...T[]];

/** The seed with this id, else the first (lab URLs may carry any ?id=). */
const pickSeed = <T extends Readonly<{ id: string }>>(
  seeds: NonEmpty<T>,
  id: string
): T => seeds.find((seed) => seed.id === id) ?? seeds[0];

/** Lab backtest ids: the keys of the precomputed analytics JSON. */
type LabBacktestId = keyof typeof backtestAnalyticsJson;

type LabBacktestSeed = Readonly<{
  id: LabBacktestId;
  sharpe: number;
  strategyId: string | null;
  strategy: string;
  instrument: string;
  ageDays: number;
}>;

const BACKTEST_SEEDS: NonEmpty<LabBacktestSeed> = [
  {
    ageDays: 2,
    id: "bt-demo-momentum",
    instrument: "SPY",
    sharpe: 1.18,
    strategy: "Demo momentum v1",
    strategyId: "s-demo-momentum",
  },
  {
    ageDays: 5,
    id: "bt-demo-reversion",
    instrument: "QQQ",
    sharpe: 0.94,
    strategy: "Demo mean reversion v2",
    strategyId: "s-demo-reversion",
  },
  {
    ageDays: 9,
    id: "bt-demo-breakout",
    instrument: "NVDA",
    sharpe: 0.71,
    strategy: "Demo breakout v1",
    strategyId: "s-demo-breakout",
  },
  {
    ageDays: 14,
    id: "bt-demo-carry",
    instrument: "GLD",
    sharpe: 0.38,
    strategy: "Demo gold carry v1",
    strategyId: null,
  },
];

const EQUITY_POINTS = 160;
const LAB_CAPITAL = 100_000;

type LabTrade = BacktestGetOutput["backtest"]["trades"][number];

const labEquity = (seed: LabBacktestSeed) => {
  const random = createSeededRandom(`equity:${seed.id}`);
  const points: Array<{ t: string; equity: number }> = [];
  let equity = LAB_CAPITAL;
  for (let index = 0; index < EQUITY_POINTS; index += 1) {
    equity *= 1 + (random() - 0.46) * 0.02;
    points.push({
      equity: roundTo(equity, 2),
      t: labDaysAgo(seed.ageDays + EQUITY_POINTS - index),
    });
  }
  return points;
};

const labDrawdown = (equity: readonly { t: string; equity: number }[]) => {
  let peak = 0;
  return equity.map((point) => {
    peak = Math.max(peak, point.equity);
    return { drawdown: roundTo(point.equity / peak - 1, 4), t: point.t };
  });
};

const REGIMES = ["trend", "chop", "stress"] as const;

const labTrades = (seed: LabBacktestSeed): LabTrade[] => {
  const random = createSeededRandom(`trades:${seed.id}`);
  const base = labBasePrice(seed.instrument);
  return Array.from({ length: 14 }, (_, index) => {
    const start = seed.ageDays + EQUITY_POINTS - 4 - index * 11;
    const entry = roundTo(base * (0.92 + random() * 0.12), 2);
    const exit = roundTo(entry * (0.96 + random() * 0.09), 2);
    const qty = 40 + Math.floor(random() * 60);
    const side = index % 4 === 3 ? ("short" as const) : ("long" as const);
    const direction = side === "long" ? 1 : -1;
    return {
      commission: 1.25,
      entry_px: entry,
      entry_t: labDaysAgo(start),
      exit_px: exit,
      exit_t: labDaysAgo(start - 6),
      pnl: roundTo((exit - entry) * qty * direction, 2),
      qty,
      regime: REGIMES[index % REGIMES.length],
      side,
      symbol: seed.instrument,
    };
  }).reverse();
};

const labBacktestSummary = (
  seed: LabBacktestSeed
): BacktestResultSummaryOutput => {
  const equity = labEquity(seed);
  return {
    createdAt: labDate(seed.ageDays),
    dataSource: "Demo daily bars (fake)",
    foldCount: 2,
    id: seed.id,
    instruments: seed.instrument,
    isSplit: null,
    maxDrawdown: Math.min(...labDrawdown(equity).map((p) => p.drawdown)),
    metrics: { cagr: roundTo(seed.sharpe * 0.07, 3), sharpe: seed.sharpe },
    notes: "Fictional lab run. Dummy data only.",
    paperId: null,
    periodEnd: labDaysAgo(seed.ageDays + 1),
    periodStart: labDaysAgo(seed.ageDays + EQUITY_POINTS),
    pointCount: EQUITY_POINTS,
    strategy: seed.strategy,
    strategyId: seed.strategyId,
    taskId: `task-${seed.id}`,
    taskTitle: `Backtest ${seed.strategy}`,
    tradeCount: 14,
  };
};

export const LAB_BACKTEST_ROWS: readonly BacktestResultSummaryOutput[] =
  BACKTEST_SEEDS.map(labBacktestSummary);

const labTask = (
  id: string,
  title: string,
  kind: AgentTaskOutput["kind"]
): AgentTaskOutput => ({
  agent: "demo-agent",
  createdAt: labDate(3),
  finishedAt: labDate(2),
  id,
  kind,
  links: [],
  metrics: {},
  paperId: null,
  startedAt: labDate(3),
  status: "succeeded",
  summary: "Fictional lab task.",
  title,
  updatedAt: labDate(2),
});

/**
 * computeBacktestAnalytics output per lab backtest, precomputed so the server-side analytics
 * module stays out of app code. strategies.test.tsx checks it against the live computation.
 */
const LAB_BACKTEST_ANALYTICS: Readonly<
  Record<LabBacktestId, BacktestGetOutput["backtest"]["analytics"]>
> = {
  "bt-demo-breakout": BacktestAnalyticsSchema.parse(
    backtestAnalyticsJson["bt-demo-breakout"]
  ),
  "bt-demo-carry": BacktestAnalyticsSchema.parse(
    backtestAnalyticsJson["bt-demo-carry"]
  ),
  "bt-demo-momentum": BacktestAnalyticsSchema.parse(
    backtestAnalyticsJson["bt-demo-momentum"]
  ),
  "bt-demo-reversion": BacktestAnalyticsSchema.parse(
    backtestAnalyticsJson["bt-demo-reversion"]
  ),
};

/** The inputs the server feeds computeBacktestAnalytics for a lab backtest id. */
export const labBacktestAnalyticsInput = (id: string) => {
  const seed = pickSeed(BACKTEST_SEEDS, id);
  return {
    equity: labEquity(seed),
    id: seed.id,
    initialCapital: LAB_CAPITAL,
    trades: labTrades(seed),
  };
};

/** Detail for a lab backtest id; unknown ids show the first run. */
export const labBacktestDetail = (id: string): BacktestGetOutput => {
  const seed = pickSeed(BACKTEST_SEEDS, id);
  const summary = labBacktestSummary(seed);
  const equity = labEquity(seed);
  const trades = labTrades(seed);
  const mid = labDaysAgo(seed.ageDays + EQUITY_POINTS / 2);
  return {
    backtest: {
      ...summary,
      analytics: LAB_BACKTEST_ANALYTICS[seed.id],
      benchmark: {
        label: "SPY buy and hold (fake)",
        points: equity.map((point, index) => ({
          equity: roundTo(LAB_CAPITAL * (1 + index * 0.0006), 2),
          t: point.t,
        })),
      },
      drawdown: labDrawdown(equity),
      equity,
      folds: [
        {
          label: "wf-1",
          metrics: { sharpe: 0.68 },
          test_end: summary.periodEnd,
          test_start: mid,
          train_end: mid,
          train_start: summary.periodStart,
        },
        {
          label: "wf-2",
          metrics: { sharpe: 0.52 },
          test_end: summary.periodEnd,
          test_start: summary.periodEnd,
          train_end: summary.periodEnd,
          train_start: summary.periodStart,
        },
      ],
      isSplit: {
        in_sample: {
          end: mid,
          metrics: { sharpe: 1.12 },
          start: summary.periodStart,
        },
        out_of_sample: {
          end: summary.periodEnd,
          metrics: { sharpe: 0.71 },
          start: mid,
        },
      },
      ratingEvaluation: null,
      ratingSeries: null,
      runConfig: {
        commissionPerTrade: 1.25,
        fillModel: "bar",
        initialCapital: LAB_CAPITAL,
        timeframe: "1D",
      },
      trades,
    },
    task: labTask(summary.taskId, `Backtest ${seed.strategy}`, "backtest"),
  };
};

// ---------------------------------------------------------------------------
// Strategy library

type LabStrategySeed = Readonly<{
  id: string;
  name: string;
  status: StrategySummaryOutput["status"];
  section: string | null;
  favorite: boolean;
  tags: readonly string[];
  // Defaults: normal priority and no external claim.
  priority?: StrategySummaryOutput["priority"];
  externalValidation?: StrategySummaryOutput["externalValidation"];
}>;

const STRATEGY_SEEDS: NonEmpty<LabStrategySeed> = [
  {
    favorite: true,
    id: "s-demo-momentum",
    name: "Demo momentum v1",
    section: "Trend",
    status: "paper",
    tags: ["momentum", "etf"],
  },
  {
    favorite: false,
    id: "s-demo-reversion",
    name: "Demo mean reversion v2",
    section: "Mean reversion",
    status: "backtested",
    tags: ["reversion"],
  },
  {
    favorite: false,
    id: "s-demo-breakout",
    name: "Demo breakout v1",
    section: "Trend",
    status: "researching",
    tags: ["breakout", "large-cap"],
  },
  {
    favorite: false,
    id: "s-demo-wheel",
    name: "Demo options wheel",
    section: "Options",
    status: "idea",
    tags: ["options"],
  },
  // High priority and externally pre-validated: a fictional third-party claim (never a Vertex validation).
  {
    externalValidation: {
      claimedMethod:
        "Fictional claim: 1,000 demo strategies on 4 demo markets, ranked by total net R with no correction for the number of strategies tried.",
      claimedMetrics: [
        { label: "Rank", value: "1 of 1,000 by total net R" },
        { label: "Trades", value: "412" },
        { label: "Win rate", value: "18%" },
        { label: "Max drawdown", value: "44R" },
      ],
      publishedOn: "2026-09-24",
      sourceAuthor: "Demo channel, video site",
      sourceTitle: "Demo video: the best of 1,000 backtested strategies",
      sourceUrl: "https://video.example.test/demo-volume-spike",
    },
    favorite: false,
    id: "s-demo-volume-spike",
    name: "Demo volume spike breakout",
    priority: "high",
    section: "Reel ideas",
    status: "backtested",
    tags: ["research-only", "externally-pre-validated", "breakout"],
  },
];

const strategyParams: StrategySummaryOutput["params"] = [
  {
    default: 20,
    max: 250,
    min: 5,
    name: "lookback",
    step: 1,
    title: "Lookback bars",
    type: "integer",
  },
  {
    default: "demo",
    name: "venue",
    options: ["demo", "paper"],
    title: "Venue",
    type: "choice",
  },
  { default: true, name: "use_stops", title: "Use stops", type: "boolean" },
];

const labStrategySummary = (
  seed: LabStrategySeed,
  index: number
): StrategySummaryOutput => {
  const backtests = LAB_BACKTEST_ROWS.filter(
    (row) => row.strategyId === seed.id
  );
  const latest = backtests[0];
  return {
    backtestCount: backtests.length,
    createdAt: labDate(60 + index * 7),
    description: `${seed.name}: fictional lab strategy. Dummy data only.`,
    favorite: seed.favorite,
    id: seed.id,
    kind: "python",
    latestBacktest:
      latest === undefined
        ? null
        : {
            cagr: 0.084 - index * 0.01,
            createdAt: latest.createdAt,
            id: latest.id,
            maxDrawdown: latest.maxDrawdown,
            sharpe: 1.18 - index * 0.21,
            totalReturn: 0.142 - index * 0.03,
          },
    name: seed.name,
    params: strategyParams,
    presetCount: 1,
    priority: seed.priority ?? "normal",
    externalValidation: seed.externalValidation ?? null,
    section: seed.section,
    slug: seed.id.slice(2),
    sourceRef: `demo/strategies/${seed.id.slice(2)}.py`,
    status: seed.status,
    tags: [...seed.tags],
    updatedAt: labDate(1 + index),
  };
};

export const LAB_STRATEGY_ROWS: readonly StrategySummaryOutput[] =
  STRATEGY_SEEDS.map(labStrategySummary);

const labPreset = (strategy: StrategySummaryOutput): StrategyPresetOutput => ({
  createdAt: labDate(20),
  id: `preset-${strategy.slug}`,
  name: "Demo conservative",
  strategyId: strategy.id,
  updatedAt: labDate(4),
  values: { lookback: 40, use_stops: true, venue: "paper" },
});

/** Detail for a lab strategy id; unknown ids show the first strategy. */
export const labStrategyDetail = (id: string): StrategyGetOutput => {
  const seed = pickSeed(STRATEGY_SEEDS, id);
  const strategy = labStrategySummary(seed, STRATEGY_SEEDS.indexOf(seed));
  return {
    backtests: LAB_BACKTEST_ROWS.filter(
      (row) => row.strategyId === strategy.id
    ),
    presets: [labPreset(strategy)],
    strategy,
  };
};

// ---------------------------------------------------------------------------
// Quant Lab

const DEMO_SHA = "0123456789abcdef".repeat(4);

export const LAB_QUANT_LAB: QuantLabListOutput = {
  captures: [
    {
      capturedAt: labDate(1),
      doi: "10.0000/demo.0001",
      id: "cap-demo-1",
      pdfStatus: "retained",
      ssrnId: "0000001",
      title: "Demo Paper: Momentum in Fictional Markets",
      topic: "momentum",
      url: "https://example.test/papers/demo-0001",
      version: "1",
    },
    {
      capturedAt: labDate(3),
      doi: "10.0000/demo.0002",
      id: "cap-demo-2",
      pdfStatus: "metadata_only:demo",
      ssrnId: "0000002",
      title: "Demo Paper: Volatility Carry",
      topic: "volatility",
      url: "https://example.test/papers/demo-0002",
      version: "2",
    },
  ],
  studies: [
    {
      backtest: {
        createdAt: labDate(2),
        id: "bt-demo-momentum",
        instruments: "SPY, QQQ, DIA, IWM",
        maxDrawdown: -0.118,
        metrics: { cagr: 0.084, deflated_sharpe: 0.91, sharpe: 1.18 },
        notes:
          "PASS Sharpe above 0.5 out of sample\nFAIL Max drawdown under 10%\nDemo provenance: lab fixture",
        periodEnd: labDaysAgo(2),
        periodStart: labDaysAgo(800),
      },
      createdAt: labDate(12),
      hypothesis:
        "Twelve-month momentum on the demo ETF set beats buy and hold after costs (fictional).",
      id: "ql-demo-momentum",
      name: "Demo time-series momentum study",
      ourReading: {
        gaps: "Costs assumed at 2 bps (demo).",
        interpretation: "Signal rebalanced monthly on closes (demo).",
      },
      paper: {
        id: "paper-demo-1",
        identifier: null,
        sourceUrl: null,
        stage: "backtested",
        title: "Demo Paper: Momentum in Fictional Markets",
        verdict: "promising",
      },
      paperClaims: [
        {
          locator: "Demo table 2",
          quote: "Momentum earns a positive premium in the demo sample.",
        },
      ],
      specKey: "demo/momentum-v1",
      specSha256: DEMO_SHA,
      strategy: {
        id: "s-demo-momentum",
        slug: "demo-momentum",
        status: "paper",
      },
    },
    {
      backtest: null,
      createdAt: labDate(20),
      hypothesis: "Overnight gaps on demo large caps revert intraday.",
      id: "ql-demo-reversion",
      name: "Demo overnight reversion study",
      ourReading: {},
      paper: null,
      paperClaims: [],
      specKey: "demo/reversion-v2",
      specSha256: "fedcba9876543210".repeat(4),
      strategy: null,
    },
  ],
};

// ---------------------------------------------------------------------------
// Filter studies

const labFilterMetrics = (
  sharpe: number,
  halves: readonly [number, number],
  tradesPerYear: number
) => ({
  cagr: roundTo(sharpe * 0.09, 4),
  maxDrawdown: roundTo(0.12 + (1 - sharpe) * 0.1, 4),
  sharpe,
  sharpeHalves: [halves[0], halves[1]] as [number, number],
  trades: Math.round(tradesPerYear * 20),
  tradesPerYear,
});

/** A fictional filter study (demo numbers, not a research result), shaped like researchStudies.get. */
const LAB_FILTER_STUDY_DOCUMENT: FilterStudy = {
  daily: {
    costBpsPerSide: 5,
    trials: 4,
    universe: ["DEMO", "TEST", "LAB"],
    variants: [
      {
        ...labFilterMetrics(0.62, [0.58, 0.66], 48),
        deflatedProbability: 0.71,
        filter: "none",
        strategy: "breakout_20",
        verdict: null,
      },
      {
        ...labFilterMetrics(0.74, [0.7, 0.79], 36),
        deflatedProbability: 0.83,
        filter: "adx_above",
        strategy: "breakout_20",
        verdict: "KEEP",
      },
      {
        ...labFilterMetrics(0.41, [0.52, 0.3], 22),
        deflatedProbability: 0.4,
        filter: "adx_below",
        strategy: "breakout_20",
        verdict: "DROP (trade floor)",
      },
      {
        ...labFilterMetrics(0.55, [0.6, 0.49], 31),
        deflatedProbability: 0.55,
        filter: "adx_falling",
        strategy: "rsi2_dip",
        verdict: "KEEP (not significant)",
      },
    ],
    window: {
      days: 5000,
      end: "2026-10-30",
      secondHalfStart: "2016-11-01",
      start: "2006-11-01",
    },
  },
  id: "lab-demo-filters",
  intraday: {
    barMinutes: 5,
    costBpsPerSide: 1,
    sensitivity: { costBpsPerSide: 5, verdict: "DROP (cost)" },
    spearman: { firstHalf: 0.08, secondHalf: 0.05 },
    symbol: "DEMO",
    variants: [
      { ...labFilterMetrics(0.2, [0.25, 0.15], 200), filter: "none" },
      { ...labFilterMetrics(0.31, [0.34, 0.28], 120), filter: "rvol_above_1" },
    ],
    verdict: "KEEP",
    window: {
      end: "2026-10-30",
      secondHalfStart: "2018-05-01",
      sessions: 3000,
      start: "2014-11-03",
    },
  },
  ran: "2026-10-31",
  spec: "docs/specs/research/adx-filter.md",
};

/** researchStudies.get output for the lab: the fictional study above. */
export const LAB_FILTER_STUDY: ResearchStudy = {
  id: LAB_FILTER_STUDY_DOCUMENT.id,
  study: LAB_FILTER_STUDY_DOCUMENT,
  updatedAt: labDate(7),
};

// ---------------------------------------------------------------------------
// Optimizations

type LabOptimizationSeed = Readonly<{
  id: string;
  strategyId: string;
  strategyName: string;
  method: OptimizationRunOutput["method"];
  ageDays: number;
}>;

const OPTIMIZATION_SEEDS: NonEmpty<LabOptimizationSeed> = [
  {
    ageDays: 3,
    id: "opt-demo-momentum",
    method: "grid",
    strategyId: "s-demo-momentum",
    strategyName: "Demo momentum v1",
  },
  {
    ageDays: 8,
    id: "opt-demo-reversion",
    method: "tpe",
    strategyId: "s-demo-reversion",
    strategyName: "Demo mean reversion v2",
  },
];

type LabTrial = Readonly<{
  index: number;
  params: { fast: number; slow: number };
  score: number;
  metrics: Record<string, number>;
}>;

const labTrials = (seed: LabOptimizationSeed): LabTrial[] => {
  const random = createSeededRandom(`trials:${seed.id}`);
  const trials: LabTrial[] = [];
  for (const fast of [5, 10, 15, 20, 25])
    for (const slow of [50, 75, 100, 125, 150]) {
      const score = roundTo(
        1.4 -
          Math.abs(fast - 15) * 0.03 -
          Math.abs(slow - 100) * 0.004 +
          random() * 0.2,
        3
      );
      trials.push({
        index: trials.length,
        metrics: {
          max_drawdown: roundTo(-0.08 - random() * 0.1, 3),
          sharpe: score,
        },
        params: { fast, slow },
        score,
      });
    }
  return trials;
};

const labOptimizationRun = (
  seed: LabOptimizationSeed
): OptimizationRunOutput => {
  const trials = labTrials(seed);
  const best = trials.reduce((left, right) =>
    right.score > left.score ? right : left
  );
  const objectives: OptimizationRunOutput["objectives"] = [
    { direction: "maximize", metric: "sharpe" },
  ];
  const runTrials: OptimizationRunOutput["trials"] = trials.map((trial) => ({
    ...trial,
    status: "ok",
  }));
  const selected = {
    degradation: roundTo(best.score * -0.26, 3),
    inSampleScore: best.score,
    params: best.params,
    score: roundTo(best.score * 0.74, 3),
    status: "ok" as const,
    trialIndex: best.index,
  };
  return {
    analytics: computeOptimizationAnalytics({
      method: seed.method,
      objectives,
      trials: runTrials,
    }),
    best: {
      metrics: best.metrics,
      params: best.params,
      score: best.score,
      trialIndex: best.index,
    },
    createdAt: labDate(seed.ageDays),
    diagnostics: null,
    folds: [],
    id: seed.id,
    marketRanking: ["SPY", "QQQ", "IWM", "GLD"].map((market, index) => ({
      market,
      rank: index + 1,
      status: "ok" as const,
      value: roundTo(1.2 - index * 0.17, 2),
    })),
    markets: ["SPY", "QQQ", "IWM", "GLD"],
    method: seed.method,
    notes: "Fictional lab optimization. Dummy data only.",
    objectives,
    oos: {
      inSample: { end: 350, start: 0 },
      mode: "is_oos",
      outOfSample: { end: 500, start: 350 },
      reason: null,
      selected,
      topK: [selected],
    },
    paretoFront: [],
    seed: 7,
    stopReason: "exhausted",
    strategyId: seed.strategyId,
    strategyName: seed.strategyName,
    taskId: `task-${seed.id}`,
    trialCount: trials.length,
    trials: runTrials,
    validation: {
      mode: "is_oos",
      params: { isFraction: 0.7, nObservations: 500, topK: 3 },
    },
  };
};

const toOptimizationSummary = (
  run: OptimizationRunOutput
): OptimizationSummaryOutput => {
  const {
    trials,
    paretoFront,
    folds,
    marketRanking: _ranking,
    oos: _oos,
    analytics: _analytics,
    ...rest
  } = run;
  return {
    ...rest,
    foldCount: folds.length,
    paretoCount: paretoFront.length,
    storedTrialCount: trials.length,
    taskTitle: `Optimize ${run.strategyName}`,
  };
};

export const LAB_OPTIMIZATION_ROWS: readonly OptimizationSummaryOutput[] =
  OPTIMIZATION_SEEDS.map((seed) =>
    toOptimizationSummary(labOptimizationRun(seed))
  );

/** Detail for a lab optimization id; unknown ids show the first run. */
export const labOptimizationDetail = (id: string): OptimizationGetOutput => {
  const seed = pickSeed(OPTIMIZATION_SEEDS, id);
  return {
    optimization: labOptimizationRun(seed),
    task: labTask(
      `task-${seed.id}`,
      `Optimize ${seed.strategyName}`,
      "optimization"
    ),
  };
};

// ---------------------------------------------------------------------------
// Academy

export const LAB_ACADEMY_TICKERS: AcademyTickersOutput = {
  tickers: LAB_TICKERS.map((ticker) => ({
    bars: 1999,
    first: labDaysAgo(2000),
    last: labDaysAgo(1),
    ticker,
  })),
};

export const labAcademyGate = (
  input: AcademyDeployInput
): AcademyGateOutput => ({
  checks: [
    {
      detail: "Demo Capital NLV from the lab fixture.",
      id: "nlv-known",
      status: "pass",
      title: "NLV known",
    },
    {
      detail: `${input.ticker} defined-risk structure (demo).`,
      id: "options-only",
      status: "pass",
      title: "Options only",
    },
    {
      detail: "Demo earnings in 9 days.",
      id: "X06",
      status: "warn",
      title: "Event window",
    },
  ],
  conflicts: [],
  nlv: 250_000,
  nlvDetail: "Demo Capital (DU0000000), fake NLV.",
  nlvSource: "portfolio-monitor",
  openPremiumInNameUsd: 0,
  otherAllocationsPct: 4,
  premiumPerPositionPctNlv: 0.16,
  premiumPerPositionUsd: 412,
  rewardRisk: 0.42,
  statedNlv: null,
  structure: "covered_call",
  unitLossUsd: 980,
  verdict: "pass",
});

// ---------------------------------------------------------------------------
// Vertex strategy specs (Strategy reviews)

export const LAB_EXPERIENCE_SCOPES: readonly ExperienceScope[] = [
  { accountAlias: "demo-capital", environment: "paper" },
  { accountAlias: "demo-capital", environment: "research" },
];

const labStrategySpec = (
  strategyId: string,
  sleeve: StrategySpec["sleeve"],
  hypothesis: string,
  universe: readonly string[]
): StrategySpec =>
  StrategySpecSchema.parse({
    codeDigest: DEMO_SHA,
    costModel: {
      borrowAnnualBps: "0",
      commissionPerUnit: "0.005",
      impactModel: "fixed-bps",
      maximumParticipationBps: "5",
      slippageBps: "2",
      spreadBps: "1",
    },
    entryRules: [
      {
        featureId: "demo-momentum-score",
        lookbackBars: 20,
        operator: "gte",
        ruleId: "entry",
        threshold: "0.5",
      },
    ],
    exitRules: [
      {
        featureId: "demo-momentum-score",
        lookbackBars: 5,
        operator: "lt",
        ruleId: "exit",
        threshold: "0",
      },
    ],
    hypothesis,
    requiredData: [
      {
        entitlementPolicyId: "demo-bars-policy",
        kind: "candles",
        maximumAgeMs: 120_000,
        pointInTimeRequired: true,
      },
    ],
    riskLimits: {
      maximumLoss: "2500",
      maximumNotional: "50000",
      maximumPositions: 4,
    },
    schemaVersion: "1.0.0",
    signalSchedule: {
      calendar: "demo-calendar",
      interval: "bar-close",
      timezone: "UTC",
    },
    sleeve,
    strategyId,
    universe,
    version: "1.0.0",
  });

const LAB_SPECS: readonly StrategySpec[] = [
  labStrategySpec(
    "demo-momentum",
    "quant",
    "Demo momentum v1: ETFs with positive 20-bar momentum outperform (fictional).",
    ["SPY", "QQQ", "DIA", "IWM"]
  ),
  labStrategySpec(
    "demo-swing-breakout",
    "swing",
    "Demo breakout v1: large caps closing above a 50-bar high continue (fictional).",
    ["NVDA", "MSFT", "AAPL"]
  ),
];

/** The lab specs as immutable artifacts with their real content hash. */
export const labStrategyArtifacts = async (): Promise<
  readonly ImmutableArtifact<StrategySpec>[]
> =>
  Promise.all(
    LAB_SPECS.map(async (value) => ({
      artifactId: `artifact-${value.strategyId}`,
      sha256: await hashArtifact(value),
      value,
    }))
  );
