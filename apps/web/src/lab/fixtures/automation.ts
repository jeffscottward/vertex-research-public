// What: UI lab fixtures for Agents & Automation pages: agent tasks, model runs, benchmark, API keys,
// deployments, the order draft queue, engines and an assistant thread. All values are fictional
// and deterministic.
// Used by: apps/web/src/lab/entries/automation.tsx.
import type {
  AgentApiKeyOutput,
  AgentFrameworkOutput,
  AgentModelBenchmarkArmOutput,
  AgentModelBenchmarkOutput,
  AgentModelRunBreakdownOutput,
  AgentModelRunEventOutput,
  AgentModelRunFacetsOutput,
  AgentModelRunGetOutput,
  AgentModelRunOutput,
  AgentTaskEventOutput,
  AgentTaskOutput,
  AssistantMessageOutput,
  AssistantThreadGetOutput,
  AssistantThreadListOutput,
  AssistantThreadOutput,
  DeploymentRequestOutput,
  DeploymentStatusOutput,
  EnginesStatusOutput,
  GoLiveQueueOutput,
} from "@darkfactory/api";

import {
  LAB_ACCOUNT,
  LAB_NOW,
  labBasePrice,
  labMinutesAgo,
  roundTo,
} from "./core.ts";

const at = (minutes: number): Date => new Date(labMinutesAgo(minutes));

// ---------- Agent tasks ----------

const task = (
  id: string,
  title: string,
  kind: AgentTaskOutput["kind"],
  status: AgentTaskOutput["status"],
  minutes: number
): AgentTaskOutput => ({
  agent: "demo-agent",
  createdAt: at(minutes + 30),
  finishedAt: status === "running" ? null : at(minutes),
  id,
  kind,
  links: [{ label: "Backtests", url: "/backtests" }],
  metrics: { sharpe: 1.21, trades: 42 },
  paperId: null,
  startedAt: at(minutes + 25),
  status,
  summary: `${title}: dummy summary for the UI lab.`,
  title,
  updatedAt: at(minutes),
});

export const LAB_AGENT_TASKS: readonly AgentTaskOutput[] = [
  task("lab-task-1", "Demo momentum v1 backtest", "backtest", "succeeded", 45),
  task("lab-task-2", "Demo mean reversion sweep", "optimization", "running", 5),
  task("lab-task-3", "Review Demo carry paper", "paper", "needs_review", 180),
];

export const labAgentTaskEvents = (taskId: string): AgentTaskEventOutput[] => [
  {
    at: at(20),
    id: `${taskId}-event-1`,
    level: "info",
    message: "Demo step finished",
    taskId,
  },
];

// ---------- Model runs ----------

const RUN_MODELS = ["demo-model-large", "demo-model-small"] as const;
const RUN_CELLS = [
  ["NVDA", "buy"],
  ["SPY", "hold"],
  ["AAPL", "overweight"],
  ["MSFT", "sell"],
] as const;

const modelRun = (
  [ticker, rating]: (typeof RUN_CELLS)[number],
  index: number
): AgentModelRunOutput => {
  const entry = labBasePrice(ticker);
  return {
    analysts: ["market", "news"],
    batch: "demo-batch-1",
    costUsd: 0.18 + index * 0.02,
    createdAt: at(60 + index * 10),
    dataSource: "demo-bars",
    decisionDate: "2026-10-29",
    durationMs: 95_000,
    entryPrice: entry,
    error: null,
    finishedAt: at(58 + index * 10),
    flags: [],
    framework: "demo_agents",
    frameworkVersion: "0.1.0",
    horizon: "2 weeks",
    horizonBucket: "weeks",
    id: `lab-run-${index + 1}`,
    inputTokens: 12_000 + index * 500,
    llmCalls: 9,
    memory: false,
    model: index % 2 === 0 ? "demo-model-large" : "demo-model-small",
    modelsServed: [],
    outputTokens: 2400,
    provider: "demo-provider",
    purpose: "benchmark",
    rating,
    ratingSource: "stated",
    runKey: `demo-batch-1:${ticker}`,
    startedAt: at(60 + index * 10),
    status: "succeeded",
    stopPrice: roundTo(entry * 0.95),
    targetPrice: roundTo(entry * 1.1),
    taskId: null,
    ticker,
    toolCalls: 14,
    updatedAt: at(58 + index * 10),
    variant: null,
  };
};

export const LAB_MODEL_RUNS: readonly AgentModelRunOutput[] =
  RUN_CELLS.map(modelRun);

const facetOf = (values: readonly string[]) =>
  [...new Set(values)].map((value) => ({
    count: values.filter((item) => item === value).length,
    value,
  }));

export const LAB_MODEL_RUN_FACETS: AgentModelRunFacetsOutput = {
  batch: [{ count: LAB_MODEL_RUNS.length, value: "demo-batch-1" }],
  flags: [],
  framework: facetOf(LAB_MODEL_RUNS.map((run) => run.framework)),
  horizonBucket: facetOf(LAB_MODEL_RUNS.map((run) => run.horizonBucket)),
  model: facetOf(LAB_MODEL_RUNS.map((run) => run.model)),
  provider: facetOf(LAB_MODEL_RUNS.map((run) => run.provider)),
  purpose: facetOf(LAB_MODEL_RUNS.map((run) => run.purpose)),
  rating: facetOf(LAB_MODEL_RUNS.map((run) => String(run.rating))),
  servedModel: [],
  status: facetOf(LAB_MODEL_RUNS.map((run) => run.status)),
  ticker: facetOf(LAB_MODEL_RUNS.map((run) => run.ticker)),
  variant: [],
};

export const LAB_MODEL_RUN_BREAKDOWN: AgentModelRunBreakdownOutput = {
  groupBy: "model",
  rows: RUN_MODELS.map((model) => ({
    avgCostUsd: 0.2,
    failed: 0,
    holdShare: 0.5,
    key: model,
    rated: 2,
    runs: 2,
    totalCostUsd: 0.4,
  })),
};

const runEvents = (runId: string): AgentModelRunEventOutput[] =>
  (
    [
      ["market", "llm_call", "Demo market analyst read the bars"],
      ["news", "tool_call", "Demo headline lookup"],
      ["trader", "decision", "Demo decision: rating stated"],
    ] as const
  ).map(([agent, kind, title], seq) => ({
    agent,
    at: at(59 - seq),
    body: `${title}. Dummy text for the UI lab.`,
    costUsd: 0.01,
    durationMs: 1500,
    id: `${runId}-event-${seq}`,
    inputTokens: 1000,
    kind,
    model: "demo-model-large",
    outputTokens: 200,
    runId,
    seq,
    title,
    toolName: kind === "tool_call" ? "demo_headlines" : null,
  }));

export const labModelRunPage = (id: string): AgentModelRunGetOutput => {
  const run =
    LAB_MODEL_RUNS.find((item) => item.id === id) ?? modelRun(RUN_CELLS[0], 0);
  const events = runEvents(run.id);
  return { done: true, events, nextSeq: events.length - 1, run };
};

// ---------- Benchmark and frameworks ----------

const benchmarkArm = (
  key: string,
  overrides: Partial<AgentModelBenchmarkArmOutput>
): AgentModelBenchmarkArmOutput => ({
  avgCostUsd: 0.2,
  baseline: null,
  cells: 2,
  extremityShare: 0.5,
  failed: 0,
  finished: 2,
  inputTokens: 24_500,
  key,
  llmCalls: 18,
  local: false,
  medianDurationMs: 95_000,
  outputTokens: 4800,
  rated: 2,
  ratedCells: 2,
  ratingMix: { buy: 1, hold: 1, overweight: 0, sell: 0, underweight: 0 },
  rerun: { allAgreeShare: null, cells: 0, meanModalShare: null },
  runs: 2,
  servedModels: [],
  toolCalls: 28,
  totalCostUsd: 0.4,
  unrated: 0,
  ...overrides,
});

export const LAB_MODEL_BENCHMARK: AgentModelBenchmarkOutput = {
  armBy: "model",
  arms: [
    benchmarkArm("demo-model-large", {}),
    benchmarkArm("demo-model-small", {
      baseline: { matchRate: 0.5, meanClosestDistance: 0.5, sharedCells: 2 },
      local: true,
      ratingMix: { buy: 0, hold: 0, overweight: 1, sell: 1, underweight: 0 },
    }),
  ],
  armsTruncated: false,
  baselineArm: "demo-model-large",
  cells: 4,
  matrix: {
    arms: ["demo-model-large", "demo-model-small"],
    rows: [
      [
        { agreeShare: 1, sharedCells: 2 },
        { agreeShare: 0.5, sharedCells: 2 },
      ],
      [
        { agreeShare: 0.5, sharedCells: 2 },
        { agreeShare: 1, sharedCells: 2 },
      ],
    ],
  },
  pair: null,
  runCount: LAB_MODEL_RUNS.length,
  truncated: false,
};

export const LAB_AGENT_FRAMEWORKS: readonly AgentFrameworkOutput[] = [
  {
    benchName: "demo_agents",
    code: ["agents/demo_agents"],
    dataSources: [
      { name: "Demo bars", note: "Fictional daily bars.", pointInTime: "yes" },
    ],
    guards: ["Research only: ratings never place orders."],
    id: "demo_agents",
    license: "Demo license",
    links: [],
    name: "Demo Agents",
    stages: [
      { name: "Analysts", summary: "Demo analysts read bars and headlines." },
      { name: "Trader", summary: "Demo trader states a rating." },
    ],
    status: "reimplemented",
    summary: "A fictional multi-agent framework for the UI lab.",
    toolsAllowed: ["demo_bars", "demo_headlines"],
    toolsExcluded: ["orders"],
    version: "0.1.0",
  },
];

// ---------- API keys (display prefixes only, never key material) ----------

export const LAB_AGENT_API_KEYS: readonly AgentApiKeyOutput[] = [
  {
    access: "read",
    createdAt: at(60 * 24 * 20),
    enabled: true,
    expiresAt: null,
    id: "lab-key-1",
    lastUsedAt: at(30),
    name: "Demo research agent",
    prefix: "vx_demo_",
    start: "vx_demo_••••",
  },
  {
    access: "write",
    createdAt: at(60 * 24 * 5),
    enabled: true,
    expiresAt: null,
    id: "lab-key-2",
    lastUsedAt: null,
    name: "Demo backtest agent",
    prefix: "vx_demo_",
    start: "vx_demo_••••",
  },
];

// ---------- Deployments ----------

const service = (
  name: string,
  health: string | null
): DeploymentStatusOutput["services"][number] => ({
  exitCode: null,
  finishedAt: null,
  health,
  image: `demo/${name}:lab`,
  log: {
    errorLines: 0,
    lastLineAt: labMinutesAgo(1),
    lines: 1200,
    warnLines: 3,
  },
  oomKilled: false,
  present: true,
  restartCount: 0,
  running: true,
  service: name,
  startedAt: labMinutesAgo(60 * 26),
  status: "running",
});

export const LAB_DEPLOYMENT_STATUS: DeploymentStatusOutput = {
  configured: true,
  equity: {
    as_of: labMinutesAgo(1),
    available: true,
    available_funds: LAB_ACCOUNT.cash,
    buying_power: LAB_ACCOUNT.cash * 2,
    cash: LAB_ACCOUNT.cash,
    currency: LAB_ACCOUNT.currency,
    net_liq: LAB_ACCOUNT.netLiquidation,
    realized: 0,
    source: "demo-snapshot",
    unrealized: 512.4,
  },
  fetchedAt: LAB_NOW.toISOString(),
  fills: {
    as_of: labMinutesAgo(1),
    available: true,
    count: 1,
    items: [
      {
        exec_id_masked: "•••a1",
        order_id_masked: "•••100",
        price: roundTo(labBasePrice("SPY") * 0.99),
        qty: 10,
        side: "BUY",
        symbol: "SPY",
        time: labMinutesAgo(90),
      },
    ],
    source: "demo-snapshot",
  },
  logs: {
    as_of: labMinutesAgo(1),
    available: true,
    count: 1,
    items: [
      {
        count: 3,
        level: "WARNING",
        message: "Demo warning: dummy log line",
        source: "demo-collector",
        time: labMinutesAgo(12),
      },
    ],
    source: "demo-snapshot",
  },
  orders: {
    as_of: labMinutesAgo(1),
    available: true,
    count: 1,
    items: [
      {
        aux_price: null,
        client_id: 7,
        currency: "USD",
        filled: 0,
        order_id_masked: "•••101",
        price: roundTo(labBasePrice("QQQ") * 0.99),
        qty: 5,
        remaining: 5,
        sec_type: "STK",
        side: "BUY",
        status: "Submitted",
        stop: null,
        symbol: "QQQ",
        tif: "DAY",
        type: "LMT",
      },
    ],
    source: "demo-snapshot",
  },
  positions: {
    as_of: labMinutesAgo(1),
    available: true,
    count: 2,
    items: (["SPY", "QQQ"] as const).map((symbol, index) => {
      const price = labBasePrice(symbol);
      const qty = 20 - index * 10;
      return {
        avg_cost: roundTo(price * 0.97),
        avg_px: roundTo(price * 0.97),
        currency: "USD",
        market_price: price,
        market_value: roundTo(price * qty),
        multiplier: 1,
        qty,
        realized_pnl: 0,
        sec_type: "STK",
        symbol,
        unrealized_pnl: roundTo(price * 0.03 * qty),
      };
    }),
    source: "demo-snapshot",
  },
  risk: {
    as_of: labMinutesAgo(1),
    available: true,
    kill_switch: "clear",
    kill_switch_indicators: [
      { as_of: labMinutesAgo(1), engaged: false, source: "demo-risk" },
    ],
    last_risk_check: null,
    limits: {
      as_of: labMinutesAgo(1),
      available: true,
      max_order_size: 10,
      source: "demo-snapshot",
    },
    source: "demo-snapshot",
    watchdog: null,
  },
  services: [
    service("nautilus-trader", null),
    service("ib-gateway", "healthy"),
    service("demo-collector", null),
  ],
  session: {
    account_masked: "DU00•••00",
    as_of: labMinutesAgo(1),
    available: true,
    ibkr_adapter: { checked_at: labMinutesAgo(2), detail: null, ok: true },
    last_heartbeat_at: labMinutesAgo(1),
    raw_state: {
      container_exit_code: null,
      container_health: "healthy",
      container_status: "running",
      health_file_status: "ok",
      heartbeat_age_seconds: 30,
      last_runner_event: "heartbeat",
      last_runner_event_at: labMinutesAgo(1),
    },
    safe_mode: false,
    source: "demo-snapshot",
    started_at: labMinutesAgo(60 * 26),
    state: "running",
    stopped_at: null,
    strategies: [
      {
        id: "demo-momentum-v1",
        name: "Demo momentum v1",
        observation_only: false,
        started_at: labMinutesAgo(60 * 26),
        symbols: ["SPY", "QQQ"],
        trading_mode: "paper",
      },
    ],
    symbols: ["SPY", "QQQ"],
    trading_mode: "paper",
  },
  source: {
    ageSeconds: 60,
    generatedAt: labMinutesAgo(1),
    host: "demo-vps",
    stale: false,
  },
};

export const LAB_DEPLOYMENT_REQUESTS: readonly DeploymentRequestOutput[] = [
  {
    brokerSubmissionAllowed: false,
    createdAt: at(180),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    dispatch: {
      reason:
        "Order submission is disabled (VERTEX_ORDER_SUBMISSION=disabled); no execution transport exists.",
      state: "not-dispatched",
    },
    executionAuthorized: false,
    id: "lab-request-1",
    limits: {
      dailyLossLimit: 1000,
      maxOrderSize: 10,
      maxOrdersPerMinute: 5,
      maxPosition: 50,
    },
    mode: "paper",
    params: { lookback: 20 },
    presetId: null,
    presetName: null,
    requestedAt: at(120),
    requestedBy: "demo.analyst@example.test",
    status: "requested",
    strategyId: "lab-strategy-1",
    strategyName: "Demo momentum v1",
    strategySlug: "demo-momentum-v1",
    symbol: "SPY",
    timeframe: "1D",
    updatedAt: at(120),
  },
];

// ---------- Engines ----------

export const LAB_ENGINES_STATUS: EnginesStatusOutput = {
  engines: ["demo-signals", "demo-rebalance"].map((unit, index) => ({
    exitStatus: 0,
    lastExitAt: labMinutesAgo(14 + index * 5),
    lastRunAt: labMinutesAgo(15 + index * 5),
    nextRunAt: new Date(LAB_NOW.getTime() + 45 * 60_000).toISOString(),
    result: "success",
    serviceState: "inactive",
    timerActive: true,
    unit: `${unit}.timer`,
  })),
  generatedAt: labMinutesAgo(1),
  stale: false,
};

// ---------- Assistant ----------

const LAB_ASSISTANT_THREAD: AssistantThreadOutput = {
  createdAt: at(40),
  id: "lab-thread-1",
  title: "Demo momentum v1 review",
  updatedAt: at(35),
};

export const LAB_ASSISTANT_THREADS: AssistantThreadListOutput = {
  status: {
    configured: true,
    maxSteps: 8,
    model: "demo-model-large",
    usage: {
      day: "2026-10-30",
      inputTokens: 9000,
      outputTokens: 1500,
      requestLimit: 200,
      requests: 3,
      tokenLimit: 2_000_000,
    },
  },
  threads: [LAB_ASSISTANT_THREAD],
};

const message = (
  id: string,
  role: AssistantMessageOutput["role"],
  content: string,
  minutes: number
): AssistantMessageOutput => ({
  content,
  createdAt: at(minutes),
  id,
  inputTokens: role === "assistant" ? 3000 : 0,
  mode: "plan",
  model: role === "assistant" ? "demo-model-large" : null,
  outputTokens: role === "assistant" ? 500 : 0,
  role,
  threadId: LAB_ASSISTANT_THREAD.id,
  toolCalls: [],
});

export const LAB_ASSISTANT_THREAD_DETAIL: AssistantThreadGetOutput = {
  actions: [],
  messages: [
    message("lab-message-1", "user", "How did Demo momentum v1 do on SPY?", 38),
    message(
      "lab-message-2",
      "assistant",
      "Demo momentum v1 returned 12.4% on SPY in the dummy backtest, with a 6.1% max drawdown.",
      37
    ),
  ],
  thread: LAB_ASSISTANT_THREAD,
};

// The order draft queue (/drafts): a plan approved by delegation and one late entry the model
// holds, priced from a delayed snapshot, so the page shows a draft that cannot be approved.
// The owner link has the form of a Discord message link with made-up ids.
const LAB_GOLIVE_READ_AT = new Date(labMinutesAgo(1));
const LAB_GOLIVE_RAN_AT = new Date(labMinutesAgo(30));
const LAB_GOLIVE_DAY = LAB_NOW.toISOString().slice(0, 10);
const LAB_GOLIVE_LIMIT = 4.8;
const LAB_GOLIVE_QUANTITY = 10;
const LAB_GOLIVE_MAX_LOSS = LAB_GOLIVE_LIMIT * 100 * LAB_GOLIVE_QUANTITY;

export const LAB_GOLIVE_QUEUE: GoLiveQueueOutput = {
  account: {
    asOf: LAB_GOLIVE_READ_AT,
    netLiquidation: LAB_ACCOUNT.netLiquidation,
    unavailableReason: null,
  },
  canDecide: true,
  drafts: [
    {
      approvedOrder: null,
      approvedRoom: null,
      createdAt: LAB_GOLIVE_RAN_AT,
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
      entryBasis: "model_holds_account_does_not",
      exitReason: null,
      exitRule: "owner_standing_rule_v1",
      expiry: "20261218",
      id: "lab-draft-1",
      kind: "entry",
      longStrike: 580,
      nodeBadgeAtDecision: null,
      notApprovable: ["LATE_ENTRY_NOT_TESTED", "NO_LIVE_IBKR_QUOTE"],
      notes: [],
      order: {
        legs: [
          {
            expiry: "20261218",
            ratio: 1,
            right: "C",
            side: "BUY",
            strike: 580,
          },
          {
            expiry: "20261218",
            ratio: 1,
            right: "C",
            side: "SELL",
            strike: 590,
          },
        ],
        limitPrice: LAB_GOLIVE_LIMIT,
        quantity: LAB_GOLIVE_QUANTITY,
        symbol: "SPY",
      },
      parentDraftId: null,
      planId: "lab-golive-plan",
      planVersion: 1,
      preCheck: {
        enginePolicy: "not_evaluated_not_in_web_order_path",
        webFinalGate: {
          decision: "allow",
          jevStance: "BULLISH",
          jevState: "fresh",
          maxLoss: LAB_GOLIVE_MAX_LOSS,
          maxLossPct: roundTo(
            (LAB_GOLIVE_MAX_LOSS / LAB_ACCOUNT.netLiquidation) * 100,
            2
          ),
          reasons: ["Dummy check: max loss is within 2% of the account"],
          structure: "debit-vertical",
        },
      },
      quote: {
        asOf: LAB_GOLIVE_RAN_AT,
        longAsk: 12.3,
        longBid: 12.1,
        shortAsk: 7.5,
        shortBid: 7.3,
        source: "yahoo_delayed_snapshot",
      },
      revision: 1,
      shortStrike: 590,
      signalFacts: ["Dummy model has held SPY since 2026-10-20"],
      sizing: {
        budget: (LAB_ACCOUNT.netLiquidation * 2) / 100,
        limitPrice: LAB_GOLIVE_LIMIT,
        maxLoss: LAB_GOLIVE_MAX_LOSS,
        maxLossPctNlv: roundTo(
          (LAB_GOLIVE_MAX_LOSS / LAB_ACCOUNT.netLiquidation) * 100,
          2
        ),
        maxLossPerSpread: LAB_GOLIVE_LIMIT * 100,
        quantity: LAB_GOLIVE_QUANTITY,
        reason: "sized",
      },
      sleeveKey: "demo-trend",
      state: "proposed",
      structure: "callDebitVertical",
      symbol: "SPY",
      tradingDay: LAB_GOLIVE_DAY,
      updatedAt: LAB_GOLIVE_RAN_AT,
    },
  ],
  generatedAt: LAB_GOLIVE_RAN_AT,
  marketNotes: "none_active",
  node: {
    armedAt: null,
    badge: "running-disarmed",
    checkedAt: LAB_GOLIVE_READ_AT,
  },
  plan: {
    approvalBasis: "owner_delegation",
    approvedAt: new Date(labMinutesAgo(2880)),
    approvedBy: "demo-owner",
    createdAt: new Date(labMinutesAgo(4320)),
    evidenceUrl: "https://example.com/demo-golive-evidence",
    exitRule: "owner_standing_rule_v1",
    id: "lab-golive-plan",
    limits: {
      maxPositions: 6,
      nameRiskCapPct: 2,
      openRiskCapPct: 8,
      positionRiskPct: 2,
    },
    name: "Demo go-live allocation",
    ownerMessageUrl: "https://discord.com/channels/0/0/0",
    retiredAt: null,
    sleeves: [
      {
        anchorDelta: 0.5,
        budgetPct: 4,
        definitionNote: "Dummy sleeve: entry rule as studied.",
        definitionVariant: "as_studied",
        dteMin: 20,
        dteTarget: 45,
        key: "demo-trend",
        name: "Demo trend verticals",
        runKey: "demo-trend-v1",
        structure: "callDebitVertical",
        symbols: ["SPY", "QQQ"],
        widthSigma: 1,
      },
    ],
    status: "approved",
    updatedAt: new Date(labMinutesAgo(2880)),
    version: 1,
  },
  sendsOrders: false,
  tradingDay: LAB_GOLIVE_DAY,
};
