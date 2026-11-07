// What: Deterministic fake data for the UI lab Overview and Portfolio pages: IBKR monitor snapshot,
// Nautilus/2FA status, agent tasks, sector rotation, todos, Vertex orders and the experience
// (decision inbox, portfolio projection) records. Fictional account "Demo Capital" only.
// Used by: apps/web/src/lab/entries/overview.tsx.
import {
  type AgentOpsSummaryOutput,
  type AgentTaskEventOutput,
  type AgentTaskOutput,
  type AgentTaskStatusValue,
  type IbkrRecoveryStatusOutput,
  type NautilusArmStatusOutput,
  type PortfolioMonitorExecution,
  type PortfolioMonitorOrder,
  type PortfolioMonitorOutput,
  type PortfolioMonitorPosition,
  type ResearchPaperStageValue,
  type RoundHandleCheckOutput,
  SECTOR_ROTATION_SECTORS,
  type SectorRotationSnapshot,
  type TodoItemOutput,
  type VertexOrdersStatus,
} from "@darkfactory/api";
import type {
  AgentRun,
  PortfolioSnapshot,
  ProjectionContinuity,
  StrategySpec,
  VertexContinuityRead,
  VertexPortfolioRead,
} from "@darkfactory/api/vertex";
import { hashArtifact } from "@darkfactory/shared/vertex";

import { localDayKey } from "../../components/portal/portfolio-monitor-model.ts";
import type { DashboardSummaryState } from "../../features/dashboard/view-model.ts";
import type {
  DecisionInbox,
  ExperienceScope,
  ImmutableArtifact,
} from "../../features/experience/ports.ts";
import {
  createSeededRandom,
  LAB_ACCOUNT,
  LAB_NOW,
  labBasePrice,
  labDaysAgo,
  labMinutesAgo,
  roundTo,
} from "./core.ts";

/** Wall clock for the live-monitor freshness fields only (owner-approved lab exception). */
export const labWallClock = (): Date => new Date();

/** 64 hex chars derived from a seed: stands in for event hashes and code digests. */
export const labHex = (seed: string): string => {
  const random = createSeededRandom(`hex:${seed}`);
  let hex = "";
  while (hex.length < 64)
    hex += Math.floor(random() * 0x1_00_00_00)
      .toString(16)
      .padStart(6, "0");
  return hex.slice(0, 64);
};

/** Canonical decimal string (no trailing zeros), as the vertex schemas require. */
const decimal = (value: number): string => String(roundTo(value, 2));

// ---------- dashboard summary (SSR state) ----------

export const LAB_DASHBOARD_SUMMARY_STATE: DashboardSummaryState = {
  summary: {
    capabilities: {
      ai: true,
      analytics: false,
      emailDelivery: false,
      telemetryExport: false,
    },
    featureItems: { active: 0, archived: 0, draft: 0, recent: [], total: 0 },
    session: {
      expiresAt: new Date(LAB_NOW.getTime() + 8 * 3_600_000),
      name: "Demo Analyst",
      role: "admin",
      status: "active",
      userId: "demo-operator",
    },
  },
  type: "ready",
};

// ---------- IBKR monitor (account glance, Portfolio tabs) ----------

type PositionSeed = Readonly<{
  symbol: string;
  qty: number;
  avg: number;
  secType?: string;
  description?: string;
  last?: number;
  multiplier?: number;
}>;

const POSITION_SEEDS: readonly PositionSeed[] = [
  { avg: 552.1, qty: 120, symbol: "SPY" },
  { avg: 470.3, qty: 60, symbol: "QQQ" },
  { avg: 231, qty: 80, symbol: "GLD" },
  { avg: 121.4, qty: 150, symbol: "NVDA" },
  { avg: 214.8, qty: 90, symbol: "AAPL" },
  { avg: 401.2, qty: 40, symbol: "MSFT" },
  { avg: 262.4, qty: -20, symbol: "TSLA" },
  {
    avg: 9.8,
    description: "SPY 18DEC26 600 C",
    last: 12.45,
    multiplier: 100,
    qty: 5,
    secType: "OPT",
    symbol: "SPY",
  },
];

/** Seed -> monitor row; P&L and weight follow from quantity, average cost and the lab price. */
const LAB_POSITION_ROWS = POSITION_SEEDS.map((seed, index) => {
  const random = createSeededRandom(`position:${seed.symbol}:${index}`);
  const multiplier = seed.multiplier ?? 1;
  const last = seed.last ?? labBasePrice(seed.symbol);
  const marketValue = roundTo(seed.qty * last * multiplier);
  const costBasis = roundTo(seed.qty * seed.avg * multiplier);
  const unrealized = roundTo(marketValue - costBasis);
  const dailyPnl = roundTo(marketValue * (random() - 0.4) * 0.02);
  const row: PortfolioMonitorPosition = {
    avgPrice: seed.avg,
    costBasis,
    currency: "USD",
    dailyPnl,
    description: seed.description ?? `${seed.symbol} demo holding`,
    id: `demo-pos-${index + 1}`,
    last,
    marketValue,
    position: seed.qty,
    realized: 0,
    secType: seed.secType ?? "STK",
    symbol: seed.symbol,
    unrealized,
    unrealizedPct: roundTo((unrealized / Math.abs(costBasis)) * 100),
    weightPct: roundTo((marketValue / LAB_ACCOUNT.netLiquidation) * 100),
  };
  return { dailyPnl, marketValue, row, unrealized };
});

const LAB_MONITOR_POSITIONS: readonly PortfolioMonitorPosition[] =
  LAB_POSITION_ROWS.map(({ row }) => row);

const total = (
  pick: (row: (typeof LAB_POSITION_ROWS)[number]) => number
): number =>
  roundTo(LAB_POSITION_ROWS.reduce((sum, row) => sum + pick(row), 0));

const order = (
  fields: Pick<
    PortfolioMonitorOrder,
    "permId" | "symbol" | "action" | "orderType" | "qty" | "status"
  > &
    Partial<PortfolioMonitorOrder>
): PortfolioMonitorOrder => ({
  avgFill: null,
  clientId: 195,
  completedStatus: "",
  completedTime: "",
  conId: String(400_000 + fields.permId),
  filledQty: 0,
  key: `perm:${fields.permId}`,
  limitPrice: null,
  ocaGroup: "",
  orderId: fields.permId - 700_000,
  orderRef: "demo",
  outsideRth: false,
  parentKey: null,
  remaining: fields.qty,
  secType: "STK",
  stopPrice: null,
  tif: "GTC",
  trailPct: null,
  ...fields,
});

const LAB_OPEN_ORDERS: readonly PortfolioMonitorOrder[] = [
  order({
    action: "SELL",
    orderType: "STP",
    permId: 710_001,
    qty: 120,
    status: "PreSubmitted",
    stopPrice: 560,
    symbol: "SPY",
  }),
  order({
    action: "BUY",
    limitPrice: 130.35,
    orderType: "LMT",
    permId: 710_002,
    qty: 50,
    status: "Submitted",
    symbol: "NVDA",
    tif: "DAY",
  }),
  order({
    action: "SELL",
    orderType: "TRAIL",
    permId: 710_003,
    qty: 80,
    status: "PreSubmitted",
    symbol: "GLD",
    trailPct: 5,
  }),
];

/** Completed orders stamp today's local day so "Completed / cancelled today" lists them. */
const labCompletedOrders = (now: Date): PortfolioMonitorOrder[] => {
  const day = localDayKey(now);
  return [
    order({
      action: "BUY",
      avgFill: 229.84,
      completedStatus: "Filled",
      completedTime: `${day} 10:12:44 America/New_York`,
      filledQty: 30,
      limitPrice: 230,
      orderType: "LMT",
      permId: 710_004,
      qty: 30,
      remaining: 0,
      status: "Filled",
      symbol: "AAPL",
      tif: "DAY",
    }),
    order({
      action: "BUY",
      completedStatus: "Cancelled by demo operator",
      completedTime: `${day} 11:40:03 America/New_York`,
      limitPrice: 218.5,
      orderType: "LMT",
      permId: 710_005,
      qty: 40,
      status: "Cancelled",
      symbol: "IWM",
      tif: "DAY",
    }),
  ];
};

const LAB_EXECUTIONS: readonly PortfolioMonitorExecution[] = [
  {
    avgPrice: 229.84,
    commission: 1,
    exchange: "SMART",
    execId: "demo-exec-0001",
    localSymbol: "",
    permId: 9001,
    orderRef: "demo",
    price: 229.84,
    realized: null,
    secType: "STK",
    shares: 30,
    side: "BOT",
    symbol: "AAPL",
    time: "20261030 10:12:44",
  },
  {
    avgPrice: 419.2,
    commission: 1,
    exchange: "SMART",
    execId: "demo-exec-0002",
    localSymbol: "",
    permId: 9002,
    orderRef: "demo",
    price: 419.2,
    realized: 412.6,
    secType: "STK",
    shares: 10,
    side: "SLD",
    symbol: "MSFT",
    time: "20261030 13:05:19",
  },
];

/**
 * The ibkr-monitor snapshot for Demo Capital. Freshness fields and completed-order days use
 * `now` (the live wall clock in the lab) so the monitor reads "Live"; every value is seeded.
 */
export const labPortfolioMonitorSnapshot = (
  now: Date
): PortfolioMonitorOutput => {
  const stamp = now.toISOString();
  const gross = total((row) => Math.abs(row.marketValue));
  return {
    account: { count: 1, mode: "paper" },
    completed: labCompletedOrders(now),
    executions: [...LAB_EXECUTIONS],
    messages: [
      {
        at: labMinutesAgo(42),
        code: 2104,
        message: "Market data farm connection is OK: demo farm",
      },
    ],
    orders: [...LAB_OPEN_ORDERS],
    pnl: {
      daily: total((row) => row.dailyPnl),
      realized: 412.6,
      unrealized: total((row) => row.unrealized),
    },
    positions: [...LAB_MONITOR_POSITIONS],
    readOnly: true,
    source: "ibkr-gateway",
    status: {
      clientId: 195,
      connected: true,
      dataAsOf: stamp,
      gateway: "live",
      generatedAt: stamp,
      lastError: null,
      ordersAsOf: stamp,
      receivedAt: stamp,
    },
    summary: {
      availableFunds: 141_300,
      buyingPower: 412_600,
      cushion: 0.61,
      equityWithLoanValue: LAB_ACCOUNT.netLiquidation,
      excessLiquidity: 152_480,
      grossPositionValue: gross,
      initMarginReq: 108_700,
      leverage: roundTo(gross / LAB_ACCOUNT.netLiquidation),
      lookAheadExcessLiquidity: 150_910,
      maintMarginReq: 97_520,
      netLiquidation: LAB_ACCOUNT.netLiquidation,
      settledCash: LAB_ACCOUNT.cash,
      totalCashValue: LAB_ACCOUNT.cash,
    },
  };
};

export const LAB_ROUND_HANDLES: RoundHandleCheckOutput = {
  checked: 2,
  flags: [
    {
      handle: "560.00",
      key: "perm:710001",
      kind: "stop",
      offset: 0.37,
      price: 560,
      side: "below",
      suggested: 559.63,
    },
  ],
  skippedTrailing: 1,
};

// ---------- Nautilus arm and IBKR 2FA recovery ----------

export const LAB_NAUTILUS_STATUS: NautilusArmStatusOutput = {
  arm: {
    armed: false,
    armedAt: null,
    armedBy: null,
    detail: "no_arm_record",
    imageVersion: "demo-node-1.4.2",
    killSwitchActive: false,
    reason: null,
    state: "disarmed",
  },
  armError: null,
  badge: "running-disarmed",
  checkedAt: labMinutesAgo(1),
  container: { health: "healthy", state: "running" },
};

export const LAB_RECOVERY_STATUS: IbkrRecoveryStatusOutput = {
  canRequest: false,
  checkedAt: labMinutesAgo(1),
  cooldownUntil: null,
  gateway: {
    feedsMissing: false,
    loginState: "logged-in",
    needsLogin: false,
    reason: "demo gateway logged in",
    since: labMinutesAgo(240),
  },
  request: null,
};

// ---------- agent tasks (Mission control) ----------

type TaskSeed = Readonly<{
  id: string;
  kind: AgentTaskOutput["kind"];
  title: string;
  status: AgentTaskStatusValue;
  minutesAgo: number;
  summary?: string;
  metrics?: AgentTaskOutput["metrics"];
  event?: Readonly<{ level: AgentTaskEventOutput["level"]; message: string }>;
}>;

const TASK_SEEDS: readonly TaskSeed[] = [
  {
    event: {
      level: "warn",
      message: "Needs review: Sharpe below the 1.5 target.",
    },
    id: "demo-task-01",
    kind: "backtest",
    metrics: { folds: 5, sharpe: 1.21 },
    minutesAgo: 18,
    status: "needs_review",
    summary: "Out-of-sample Sharpe 1.21 across 5 folds; review before paper.",
    title: "Demo momentum v1 walk-forward on core 7 ETF twins",
  },
  {
    event: { level: "warn", message: "Blocked: dataset access not granted." },
    id: "demo-task-02",
    kind: "paper",
    minutesAgo: 47,
    status: "blocked",
    summary: "Waiting for dataset access: demo VIX futures curve.",
    title: "Extract spec: demo volatility-carry paper",
  },
  {
    event: {
      level: "error",
      message: "Demo history service timed out after 30 s.",
    },
    id: "demo-task-03",
    kind: "data",
    minutesAgo: 95,
    status: "failed",
    summary: "Upstream timeout on the demo history service.",
    title: "Refresh demo daily bars for SPY QQQ DIA IWM",
  },
  {
    event: { level: "info", message: "Fold 3 of 5 finished." },
    id: "demo-task-04",
    kind: "optimization",
    minutesAgo: 6,
    status: "running",
    title: "Grid search: Demo breakout v2 stop distance",
  },
  {
    id: "demo-task-05",
    kind: "research",
    minutesAgo: 12,
    status: "running",
    title: "Sector rotation note: energy weakening",
  },
  {
    event: { level: "info", message: "Queued by demo operator." },
    id: "demo-task-06",
    kind: "strategy",
    minutesAgo: 3,
    status: "queued",
    title: "Draft Demo mean-reversion v3 rules",
  },
  {
    id: "demo-task-07",
    kind: "backtest",
    metrics: { cagr: "8.7%", maxDrawdown: "-11.2%", sharpe: 0.94 },
    minutesAgo: 130,
    status: "succeeded",
    title: "Demo trend v4 on GLD SLV USO",
  },
  {
    id: "demo-task-08",
    kind: "forward_test",
    metrics: { drift: 0.03, trades: 14 },
    minutesAgo: 220,
    status: "succeeded",
    title: "Paper-forward check: Demo momentum v1",
  },
  {
    id: "demo-task-09",
    kind: "research",
    metrics: { candidates: 3 },
    minutesAgo: 340,
    status: "succeeded",
    title: "Earnings drift scan: AAPL NVDA MSFT AMZN",
  },
  {
    id: "demo-task-10",
    kind: "ops",
    minutesAgo: 410,
    status: "cancelled",
    title: "Rotate demo report archive",
  },
];

const minutesBefore = (minutes: number): Date =>
  new Date(LAB_NOW.getTime() - minutes * 60_000);

export const LAB_AGENT_TASKS: readonly AgentTaskOutput[] = TASK_SEEDS.map(
  (seed) => ({
    agent: "demo-research-agent",
    createdAt: minutesBefore(seed.minutesAgo + 30),
    finishedAt: ["succeeded", "failed", "cancelled"].includes(seed.status)
      ? minutesBefore(seed.minutesAgo)
      : null,
    id: seed.id,
    kind: seed.kind,
    links: [],
    metrics: seed.metrics ?? {},
    paperId: null,
    startedAt:
      seed.status === "queued" ? null : minutesBefore(seed.minutesAgo + 25),
    status: seed.status,
    summary: seed.summary ?? null,
    title: seed.title,
    updatedAt: minutesBefore(seed.minutesAgo),
  })
);

const PAPER_STAGE_COUNTS: Readonly<Record<ResearchPaperStageValue, number>> = {
  backtested: 1,
  forward_tested: 1,
  implemented: 2,
  ingested: 3,
  queued: 4,
  spec_extracted: 2,
  verdict: 5,
};

const tasksWith = (status: AgentTaskStatusValue): number =>
  LAB_AGENT_TASKS.filter((task) => task.status === status).length;

export const LAB_AGENT_SUMMARY: AgentOpsSummaryOutput = {
  failedLast24h: 1,
  // Newest first, like the summary procedure.
  latestEvents: TASK_SEEDS.flatMap((seed, index) =>
    seed.event === undefined
      ? []
      : [
          {
            at: minutesBefore(seed.minutesAgo),
            id: `demo-event-${index + 1}`,
            level: seed.event.level,
            message: seed.event.message,
            taskId: seed.id,
            taskKind: seed.kind,
            taskTitle: seed.title,
          },
        ]
  ).sort((left, right) => right.at.getTime() - left.at.getTime()),
  paperStageCounts: { ...PAPER_STAGE_COUNTS },
  statusCounts: {
    blocked: tasksWith("blocked"),
    cancelled: tasksWith("cancelled"),
    failed: tasksWith("failed"),
    needs_review: tasksWith("needs_review"),
    queued: tasksWith("queued"),
    running: tasksWith("running"),
    succeeded: 41,
  },
};

// ---------- sector rotation card (Mission control, Today) ----------

const SECTOR_QUADRANTS: Readonly<
  Record<
    (typeof SECTOR_ROTATION_SECTORS)[number]["symbol"],
    SectorRotationSnapshot["sectors"][number]["quadrant"]
  >
> = {
  XLB: "lagging",
  XLC: "leading",
  XLE: "lagging",
  XLF: "weakening",
  XLI: "weakening",
  XLK: "leading",
  XLP: "improving",
  XLRE: "lagging",
  XLU: "improving",
  XLV: "improving",
  XLY: "leading",
};

const LAB_SECTOR_CHANGES: SectorRotationSnapshot["changes"] = [
  {
    date: labDaysAgo(0),
    from: "improving",
    name: "Communication Services",
    symbol: "XLC",
    to: "leading",
  },
  {
    date: labDaysAgo(0),
    from: "weakening",
    name: "Energy",
    symbol: "XLE",
    to: "lagging",
  },
  {
    date: labDaysAgo(0),
    from: "lagging",
    name: "Utilities",
    symbol: "XLU",
    to: "improving",
  },
];

export const LAB_SECTOR_ROTATION: SectorRotationSnapshot = {
  asOf: labDaysAgo(0),
  benchmark: "SPY",
  changes: LAB_SECTOR_CHANGES,
  previousDate: labDaysAgo(1),
  recentTransitions: [
    ...LAB_SECTOR_CHANGES,
    {
      date: labDaysAgo(6),
      from: "leading",
      name: "Financials",
      symbol: "XLF",
      to: "weakening",
    },
  ],
  schemaVersion: 1,
  sectors: SECTOR_ROTATION_SECTORS.map((sector) => {
    const random = createSeededRandom(`sector:${sector.symbol}`);
    const quadrant = SECTOR_QUADRANTS[sector.symbol];
    const changed = LAB_SECTOR_CHANGES.some(
      (change) => change.symbol === sector.symbol
    );
    const periods = changed ? 1 : 2 + Math.floor(random() * 10);
    const leadingRatio = quadrant === "leading" || quadrant === "weakening";
    const risingMomentum = quadrant === "leading" || quadrant === "improving";
    return {
      date: labDaysAgo(0),
      momentum: roundTo((risingMomentum ? 100.4 : 99.6) + random() - 0.5),
      name: sector.name,
      periods,
      quadrant,
      ratio: roundTo((leadingRatio ? 101.2 : 98.8) + random() - 0.5),
      since: labDaysAgo(periods - 1),
      symbol: sector.symbol,
    };
  }),
  timeframe: "daily",
};

// ---------- todos ----------

const todo = (
  id: number,
  title: string,
  fields: Partial<TodoItemOutput>
): TodoItemOutput => ({
  createdAt: minutesBefore(id * 600),
  dueDate: null,
  id: `demo-todo-${id}`,
  note: null,
  sourceUrl: null,
  status: "open",
  tags: [],
  title,
  updatedAt: minutesBefore(id * 300),
  ...fields,
});

export const LAB_TODOS: readonly TodoItemOutput[] = [
  todo(1, "Review Demo momentum v1 walk-forward folds", {
    dueDate: labDaysAgo(0),
    note: "Check fold 3 drawdown before paper trading.",
    tags: ["backtest", "review"],
  }),
  todo(2, "Grant demo VIX futures dataset to the research agent", {
    dueDate: labDaysAgo(-1),
    tags: ["data"],
  }),
  todo(3, "Move SPY stop off the 560.00 round handle", {
    dueDate: labDaysAgo(-2),
    note: "Round-number check suggests 559.63.",
    tags: ["orders"],
  }),
  todo(4, "Read demo sector rotation note on energy", {
    sourceUrl: "https://example.test/notes/energy-rotation",
    tags: ["research"],
  }),
  todo(5, "Rebalance GLD trailing stop after earnings week", {
    dueDate: labDaysAgo(3),
    tags: ["orders"],
  }),
  todo(6, "Archive Demo trend v3 results", {
    status: "done",
    tags: ["housekeeping"],
  }),
];

// ---------- Vertex orders (simulated mock account) ----------

export const LAB_VERTEX_ORDERS_STATUS: VertexOrdersStatus = {
  gates: {
    killSwitch: false,
    mode: "simulated",
    optionsOnly: true,
    ordersEnabled: false,
  },
  netLiquidation: LAB_ACCOUNT.netLiquidation,
  openOrders: [
    {
      cancellable: true,
      expiry: "20261218",
      limitPrice: 11.8,
      orderRef: "vertex-demo-1",
      orderType: "LMT",
      permId: 910_001,
      quantity: 2,
      right: "C",
      secType: "OPT",
      side: "BUY",
      status: "Submitted",
      strike: 600,
      symbol: "SPY",
    },
    {
      cancellable: true,
      expiry: "20270115",
      limitPrice: 7.35,
      orderRef: "vertex-demo-2",
      orderType: "LMT",
      permId: 910_002,
      quantity: 1,
      right: "P",
      secType: "OPT",
      side: "SELL",
      status: "PreSubmitted",
      strike: 480,
      symbol: "QQQ",
    },
  ],
};

// ---------- experience records (Today decision inbox, Portfolio projection) ----------

export const LAB_EXPERIENCE_SCOPE: ExperienceScope = {
  accountAlias: "demo-capital",
  environment: "paper",
};

const OCCURRED_AT = labMinutesAgo(5);
const RECEIVED_AT = labMinutesAgo(4);
const EVALUATED_AT = labMinutesAgo(3);
const HIGH_WATER = "1842";
const HIGH_WATER_HASH = labHex(`event:${HIGH_WATER}`);

const labContinuity = (state: "continuous" | "gap"): ProjectionContinuity => ({
  ...LAB_EXPERIENCE_SCOPE,
  authoritative: false,
  evaluatedAt: EVALUATED_AT,
  expectedNextSequence: "1843",
  freshness: {
    evaluatedAt: EVALUATED_AT,
    maxAgeMs: 300_000,
    observedAt: OCCURRED_AT,
    status: "fresh",
  },
  highWaterEventHash: HIGH_WATER_HASH,
  highWaterSequence: HIGH_WATER,
  lastOccurredAt: OCCURRED_AT,
  lastReceivedAt: RECEIVED_AT,
  newRiskInhibited: true,
  ownerEpoch: "3",
  receivedSequence: state === "gap" ? "1845" : null,
  state,
  streamId: "demo-capital-paper-stream",
});

const STOCK_SEEDS = POSITION_SEEDS.filter((seed) => seed.secType === undefined);

const SNAPSHOT: PortfolioSnapshot = {
  schemaVersion: "1.0.0",
  snapshotId: `demo-snapshot-${HIGH_WATER}`,
  ...LAB_EXPERIENCE_SCOPE,
  asOfAt: OCCURRED_AT,
  cash: decimal(LAB_ACCOUNT.cash),
  continuity: labContinuity("continuous"),
  currency: "USD",
  executionAuthorized: false,
  lots: STOCK_SEEDS.map((seed, index) => ({
    currency: "USD",
    instrumentId: seed.symbol,
    lotId: `demo-lot-${seed.symbol}-1`,
    openedAt: labMinutesAgo((index + 2) * 4320),
    quantity: decimal(seed.qty),
    sourceEventId: `demo-fill-${1700 + index}`,
    unitCost: decimal(seed.avg),
  })),
  netAssetValue: decimal(LAB_ACCOUNT.netLiquidation),
  observationOnly: true,
  ownerEpoch: "3",
  positions: STOCK_SEEDS.map((seed, index) => ({
    costBasis: decimal(Math.abs(seed.qty * seed.avg)),
    currency: "USD",
    instrumentId: seed.symbol,
    marketValue: decimal(seed.qty * labBasePrice(seed.symbol)),
    priceAsOf: OCCURRED_AT,
    quantity: decimal(seed.qty),
    sleeveId: index % 2 === 0 ? "quant" : "swing",
  })),
  receivedAt: RECEIVED_AT,
  researchNotionalIncluded: false,
  reservations: [
    {
      authoritative: false,
      cashAmount: "6517.5",
      currency: "USD",
      instrumentId: "NVDA",
      reservationId: "demo-reservation-1",
      shareQuantity: "50",
      sourceEventId: "demo-fill-1830",
      state: "reserved",
      submissionKey: "demo-submission-nvda-1",
    },
  ],
  sequence: HIGH_WATER,
  sleeveAllocations: [
    {
      allocatedAmount: "150000",
      authoritative: false,
      currency: "USD",
      sleeveId: "quant",
      sourceEventId: "demo-alloc-1",
    },
    {
      allocatedAmount: "60000",
      authoritative: false,
      currency: "USD",
      sleeveId: "swing",
      sourceEventId: "demo-alloc-2",
    },
  ],
  sourceEventHash: HIGH_WATER_HASH,
  sourceKind: "paper-simulation",
  streamId: "demo-capital-paper-stream",
};

export const LAB_PORTFOLIO_READ: VertexPortfolioRead = {
  snapshot: SNAPSHOT,
  status: "available",
};

export const LAB_INBOX_CONTINUITY: VertexContinuityRead = {
  continuity: labContinuity("gap"),
  status: "available",
};

const strategy = (
  strategyId: string,
  sleeve: StrategySpec["sleeve"],
  universe: readonly string[],
  hypothesis: string
): StrategySpec => ({
  codeDigest: labHex(`code:${strategyId}`),
  costModel: {
    borrowAnnualBps: "0",
    commissionPerUnit: "0.005",
    impactModel: "fixed-bps",
    maximumParticipationBps: "50",
    slippageBps: "2",
    spreadBps: "1",
  },
  entryRules: [
    {
      featureId: "demo-momentum-20d",
      lookbackBars: 20,
      operator: "gte",
      ruleId: "entry",
      threshold: "0.02",
    },
  ],
  exitRules: [
    {
      featureId: "demo-momentum-20d",
      lookbackBars: 20,
      operator: "lt",
      ruleId: "exit",
      threshold: "0",
    },
  ],
  hypothesis,
  requiredData: [
    {
      entitlementPolicyId: "demo-policy",
      kind: "quotes",
      maximumAgeMs: 60_000,
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
    calendar: "demo-us-equities",
    interval: "session-close",
    timezone: "UTC",
  },
  sleeve,
  strategyId,
  universe: [...universe],
  version: "1.0.0",
});

const agentRun = (
  runId: string,
  agentRole: AgentRun["agentRole"],
  status: AgentRun["status"],
  fields: Pick<AgentRun, "errors" | "approvalRequests">
): AgentRun => ({
  agentRole,
  allowedTools: ["read-evidence", "search-authorized-corpus"],
  costBudgetUsd: "4.5",
  inputEvidenceIds: [`demo-evidence-${runId}`],
  modelVersion: "demo-model-2026-10",
  outputArtifactIds: [],
  runId,
  schemaVersion: "1.0.0",
  status,
  taskContract: `demo-contract-${agentRole}`,
  tokenBudget: 200_000,
  ...fields,
  executionAuthorized: false,
});

/** An immutable artifact whose sha256 is the real canonical hash, so the experience guards accept it. */
const labArtifact = async <T>(
  artifactId: string,
  value: T
): Promise<ImmutableArtifact<T>> => ({
  artifactId,
  sha256: await hashArtifact(value),
  value,
});

export const LAB_INBOX_STRATEGIES: readonly StrategySpec[] = [
  strategy(
    "demo-momentum-v1",
    "quant",
    ["SPY", "QQQ", "DIA", "IWM"],
    "Demo hypothesis: 20-day momentum in index ETFs persists for one week."
  ),
  strategy(
    "demo-wheel-v2",
    "wheel",
    ["AAPL", "MSFT"],
    "Demo hypothesis: cash-secured puts on large caps earn the volatility premium."
  ),
];

export const LAB_INBOX_RUNS: readonly AgentRun[] = [
  agentRun("demo-run-101", "research", "running", {
    approvalRequests: [
      { kind: "research-review", requestId: "demo-review-request-1" },
    ],
    errors: [],
  }),
  agentRun("demo-run-102", "backtest-review", "blocked", {
    approvalRequests: [],
    errors: [{ code: "permission-denied", retryable: false }],
  }),
  agentRun("demo-run-103", "knowledge-import", "failed", {
    approvalRequests: [
      { kind: "rights-review", requestId: "demo-rights-request-1" },
    ],
    errors: [{ code: "provider-unavailable", retryable: true }],
  }),
];

/** The decision inbox: hashes are computed, so this is async. */
export const labDecisionInbox = async (): Promise<DecisionInbox> => ({
  agents: await Promise.all(
    LAB_INBOX_RUNS.map((value) => labArtifact(`${value.runId}-artifact`, value))
  ),
  continuity: LAB_INBOX_CONTINUITY,
  reviews: [],
  strategies: await Promise.all(
    LAB_INBOX_STRATEGIES.map((value) =>
      labArtifact(`${value.strategyId}-artifact`, value)
    )
  ),
});
