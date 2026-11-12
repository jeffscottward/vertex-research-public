// Paper agent desk: six agents per ticker and a paper-only journal (ported from vertex-research PR #2).
//   1. fundamental      - earnings evidence, base-case valuation, committee status
//   2. news-sentiment   - dated news, upcoming catalysts, risks, supplied X/social labels
//   3. technical        - 200-session SMA trend plus the 3-month ROC reset rule
//   4. backtest         - replay of the same rule on the ticker's own history
//   5. process          - combines the four results and updates the paper journal
//   6. pitch            - posture, scenario tree, exit levels and monitoring; the process agent
//                         and the paper book do not read it
// This module has no broker, network or order code. Paper positions are journal records only.
// Owner rule (2026-10-16): options only, no share positions. A paper position records the
// underlying reference move for process review; it does not select, price or propose any trade.
import { z } from "zod";
import { required } from "../lib/required.ts";
import { type PitchResult, pitchAgent } from "./pitch.ts";
import {
  type Committee,
  type FundamentalResult,
  type Fundamentals,
  fundamentalAgent,
  type News,
  type NewsSentimentResult,
  newsSentimentAgent,
  type Sentiment,
} from "./research.ts";
import {
  type BacktestResult,
  type BacktestSettings,
  type Bar,
  backtestAgent,
  backtestParameters,
  completedBars,
  isCalendarDay,
  type Rule,
  type RulePoint,
  ruleParameters,
  ruleSeries,
  simulateTrade,
  type TechnicalResult,
  technicalAgent,
} from "./technical.ts";

export const DESK_VERSION = 1;
export const MAX_TICKERS = 10;
export const MAX_OPEN_PAPER_POSITIONS = 5;
export const VEHICLE_POLICY =
  "Options only: a paper record tracks the underlying reference price; no option is selected or priced and no share position is proposed.";

const Day = z.string().refine(isCalendarDay, "must be a YYYY-MM-DD date");
const FillRecord = z.strictObject({
  basis: z.enum(["open", "close"]),
  date: Day,
  price: z.number().positive(),
});
const PositionRecord = z.strictObject({
  entry: FillRecord.nullable(),
  exit: FillRecord.extend({
    closedOnRun: Day,
    reason: z.enum(["close-below-sma", "hold-period"]),
    returnPct: z.number(),
  }).nullable(),
  heldSessions: z.number().int().nonnegative(),
  id: z.string().min(1),
  mark: z
    .strictObject({
      close: z.number().positive(),
      date: Day,
      returnPct: z.number(),
    })
    .nullable(),
  openedOnRun: Day,
  reportId: z.string().min(1),
  signalDate: Day,
  status: z.enum(["pending-entry", "open", "pending-exit", "closed"]),
});
export const PaperBook = z.strictObject({
  lastRunAsOf: Day.nullable(),
  mode: z.literal("paper"),
  orders: z.literal("none"),
  positions: z.array(PositionRecord),
  vehiclePolicy: z.string(),
  version: z.literal(DESK_VERSION),
});
export type PaperBook = z.infer<typeof PaperBook>;
export type PaperPosition = z.infer<typeof PositionRecord>;

export const emptyBook = (): PaperBook => ({
  lastRunAsOf: null,
  mode: "paper",
  orders: "none",
  positions: [],
  vehiclePolicy: VEHICLE_POLICY,
  version: DESK_VERSION,
});

/**
 * Refuses a journal write that would rewrite history or lock the book: a run date after today
 * would block every later real run, and a date before the last saved run would reorder it.
 */
export const assertWritable = (
  book: PaperBook,
  asOf: string,
  today: string
): void => {
  if (asOf > today)
    throw new TypeError(
      `Refusing to save a run dated ${asOf}, after today ${today}`
    );
  if (book.lastRunAsOf !== null && asOf < book.lastRunAsOf) {
    throw new TypeError(
      `Paper book already ran for ${book.lastRunAsOf}; refusing to save an earlier date ${asOf}`
    );
  }
};

export type DeskInput = Readonly<{
  metadata: Readonly<{
    id: string;
    name: string | null;
    assetType: string | null;
  }>;
  history: readonly unknown[];
  fundamentals: Fundamentals | null;
  news: News | null;
  committee: Committee | null;
  sentiment: Sentiment | null;
}>;

type Decision =
  | "paper-open"
  | "paper-pending-entry"
  | "paper-hold"
  | "paper-exit-pending"
  | "paper-close"
  | "paper-review"
  | "watch"
  | "no-action";
export type ProcessResult = Readonly<{
  agent: "process";
  decision: Decision;
  reasons: readonly string[];
}>;

// Rule order: the trend checks first, then the reset checks.
const CHECK_TEXT = [
  ["closeAboveSma", "close is not above the SMA"],
  ["smaRising", "SMA is not rising"],
  ["rocNearZero", "ROC is outside the reset band"],
  ["priorRocHigh", "no prior ROC reading reached the minimum peak"],
] as const;

const failedChecks = (technical: TechnicalResult): string => {
  const checks = required(technical.checks, "technical checks");
  return CHECK_TEXT.filter(([key]) => checks[key] !== true)
    .map(([, text]) => text)
    .join("; ");
};

type EntryContext = Readonly<{
  technical: TechnicalResult;
  agents: Readonly<{
    fundamental: FundamentalResult;
    backtest: BacktestResult;
  }>;
  assetType: string | null;
  history: readonly PaperPosition[];
  activeCount: number;
}>;

const entryBlockers = ({
  technical,
  agents,
  assetType,
  history,
  activeCount,
}: EntryContext): string[] => {
  const { fundamental, backtest } = agents;
  const reasons: string[] = [];
  if (assetType === "future")
    reasons.push(
      "Futures are excluded: roll and multiplier rules are not modeled."
    );
  if (technical.status !== "evaluated")
    reasons.push(`Technical: ${technical.reason}`);
  else if (technical.stale)
    reasons.push(
      `Technical: latest bar ${technical.barDate} is ${technical.staleDays} days old.`
    );
  reasons.push(
    ...fundamental.reasons
      .filter(() => fundamental.blocking)
      .map((reason) => `Fundamental: ${reason}`)
  );
  if (!backtest.sampleSufficient)
    reasons.push(
      `Backtest: ${backtest.closedTrades} closed trades (minimum ${backtest.settings.minClosedTrades}).`
    );
  else if (backtest.positiveExpectancy === false)
    reasons.push(
      `Backtest: mean closed-trade return ${backtest.meanReturnPct}% is not positive.`
    );
  const barDate = technical.barDate as string;
  if (
    history.some(
      (position) =>
        position.signalDate >= barDate ||
        (position.exit !== null && position.exit.date >= barDate)
    )
  ) {
    reasons.push(
      `Paper book already holds the signal or an exit on or after ${barDate}.`
    );
  }
  if (activeCount >= MAX_OPEN_PAPER_POSITIONS)
    reasons.push(
      `Paper book already holds ${MAX_OPEN_PAPER_POSITIONS} active positions.`
    );
  return reasons;
};

const decideEntry = (context: EntryContext): ProcessResult => {
  const { technical } = context;
  if (technical.barDate === null)
    return {
      agent: "process",
      decision: "no-action",
      reasons: [`Technical: ${technical.reason}`],
    };
  const reasons = entryBlockers(context);
  if (technical.signal && reasons.length === 0) {
    return {
      agent: "process",
      decision: "paper-open",
      reasons: [
        "Trend and ROC reset confirmed; fundamental and backtest gates passed. The paper reference entry uses the next session's open.",
      ],
    };
  }
  if (technical.signal)
    return {
      agent: "process",
      decision: "watch",
      reasons: ["Rule signal present but a gate failed.", ...reasons],
    };
  const trend =
    technical.checks?.closeAboveSma === true &&
    technical.checks.smaRising === true;
  const failed = failedChecks(technical);
  if (trend)
    return {
      agent: "process",
      decision: "watch",
      reasons: [`Uptrend confirmed; reset not met: ${failed}.`, ...reasons],
    };
  return {
    agent: "process",
    decision: "no-action",
    reasons: [`Trend filter not met: ${failed}.`, ...reasons],
  };
};

const STATE_DECISION = {
  closed: "paper-close",
  open: "paper-hold",
  "pending-entry": "paper-pending-entry",
  "pending-exit": "paper-exit-pending",
} as const;

const manageActive = (
  position: PaperPosition,
  bars: readonly Bar[],
  series: readonly RulePoint[],
  settings: BacktestSettings,
  asOf: string
): Readonly<{ position: PaperPosition; process: ProcessResult }> => {
  const signalIndex = bars.findIndex((bar) => bar.date === position.signalDate);
  if (signalIndex < 0) {
    return {
      position,
      process: {
        agent: "process",
        decision: "paper-review",
        reasons: [
          `Signal bar ${position.signalDate} is missing from the market data; the position is unchanged.`,
        ],
      },
    };
  }
  const trade = simulateTrade(bars, series, signalIndex, settings);
  const base = { ...position, status: trade.state };
  if (trade.state === "pending-entry") {
    return {
      position: base,
      process: {
        agent: "process",
        decision: STATE_DECISION[trade.state],
        reasons: ["Waiting for the first session after the signal."],
      },
    };
  }
  if (trade.state === "closed") {
    const exit = {
      ...trade.exit,
      closedOnRun: asOf,
      returnPct: trade.returnPct,
    };
    const next = {
      ...base,
      entry: trade.entry,
      exit,
      heldSessions: trade.heldSessions,
      mark: { close: exit.price, date: exit.date, returnPct: trade.returnPct },
    };
    return {
      position: next,
      process: {
        agent: "process",
        decision: "paper-close",
        reasons: [
          `Exit rule ${exit.reason} on ${exit.date}; underlying reference return ${trade.returnPct}% after costs.`,
        ],
      },
    };
  }
  const next = {
    ...base,
    entry: trade.entry,
    heldSessions: trade.heldSessions,
    mark: trade.mark,
  };
  const exitNote =
    trade.exitSignalDate === null
      ? ""
      : ` Close below the SMA on ${trade.exitSignalDate}; exit at the next open.`;
  return {
    position: next,
    process: {
      agent: "process",
      decision: STATE_DECISION[trade.state],
      reasons: [
        `Held ${trade.heldSessions} of ${settings.holdSessions} sessions; underlying reference mark ${trade.mark.returnPct}%.${exitNote}`,
      ],
    },
  };
};

const pendingPosition = (
  reportId: string,
  signalDate: string,
  asOf: string
): PaperPosition => ({
  entry: null,
  exit: null,
  heldSessions: 0,
  id: `${reportId}-${signalDate}`,
  mark: null,
  openedOnRun: asOf,
  reportId,
  signalDate,
  status: "pending-entry",
});

export type DeskRunOptions = Readonly<{
  reports: readonly DeskInput[];
  asOf: string;
  book?: unknown;
  rule?: Partial<Rule>;
  backtest?: Partial<BacktestSettings>;
}>;

const checkRun = ({ reports, asOf }: DeskRunOptions): void => {
  if (!isCalendarDay(asOf))
    throw new TypeError("asOf must be a YYYY-MM-DD date");
  if (reports.length === 0 || reports.length > MAX_TICKERS)
    throw new TypeError(`Supply 1-${MAX_TICKERS} reports`);
  if (
    new Set(reports.map((report) => report.metadata.id)).size !== reports.length
  )
    throw new TypeError("Reports contain duplicate IDs");
};

/**
 * Runs the six agents for each report and returns the run report plus the next paper book.
 * The prior book is not mutated. Positions opened on a run after `asOf` are hidden from this
 * run and left unchanged, so a dry run for an earlier date shows only what was known then.
 */
export type DeskTicker = Readonly<{
  reportId: string;
  name: string | null;
  assetType: string | null;
  agents: Readonly<{
    fundamental: FundamentalResult;
    newsSentiment: NewsSentimentResult;
    technical: TechnicalResult;
    backtest: BacktestResult;
    process: ProcessResult;
    pitch: PitchResult;
  }>;
}>;

export type DeskReport = Readonly<{
  version: typeof DESK_VERSION;
  mode: "paper";
  orders: "none";
  asOf: string;
  vehiclePolicy: typeof VEHICLE_POLICY;
  rule: Rule;
  backtestSettings: BacktestSettings;
  tickers: readonly DeskTicker[];
  paperBook: Readonly<{
    active: number;
    closed: number;
    activePositions: readonly PaperPosition[];
    notInThisRun: readonly string[];
  }>;
  limits: readonly string[];
}>;

export type DeskRun = Readonly<{ report: DeskReport; book: PaperBook }>;

export const runDesk = (options: DeskRunOptions): DeskRun => {
  checkRun(options);
  const { reports, asOf } = options;
  const prior = PaperBook.parse(options.book ?? emptyBook());
  const rule = ruleParameters(options.rule);
  const settings = backtestParameters(options.backtest);
  const later = prior.positions.filter(
    (position) => position.openedOnRun > asOf
  );
  // A position closed on a later run is replayed as active, so its exit is found again only
  // when the bars up to `asOf` show it.
  const positions = prior.positions
    .filter((position) => position.openedOnRun <= asOf)
    .map((position) =>
      position.exit !== null && position.exit.closedOnRun > asOf
        ? { ...position, exit: null, status: "open" as const }
        : position
    );
  const runIds = new Set(reports.map((report) => report.metadata.id));
  const tickers = reports.map((report): DeskTicker => {
    const reportId = report.metadata.id;
    const bars = completedBars(report.history).filter(
      (bar) => bar.date <= asOf
    );
    const series = ruleSeries(bars, rule);
    const agents = {
      backtest: backtestAgent(bars, series, settings),
      fundamental: fundamentalAgent(
        { ...report, assetType: report.metadata.assetType },
        { asOf }
      ),
      newsSentiment: newsSentimentAgent(
        { news: report.news, reportId, sentiment: report.sentiment },
        { asOf }
      ),
      technical: technicalAgent(bars, series, { asOf, rule }),
    };
    const activeIndex = positions.findIndex(
      (position) =>
        position.reportId === reportId && position.status !== "closed"
    );
    let process: ProcessResult;
    if (activeIndex >= 0) {
      const managed = manageActive(
        positions[activeIndex] as PaperPosition,
        bars,
        series,
        settings,
        asOf
      );
      positions[activeIndex] = managed.position;
      process = managed.process;
    } else {
      process = decideEntry({
        activeCount: positions.filter(
          (position) => position.status !== "closed"
        ).length,
        agents,
        assetType: report.metadata.assetType,
        history: positions.filter((position) => position.reportId === reportId),
        technical: agents.technical,
      });
      if (process.decision === "paper-open")
        positions.push(
          pendingPosition(reportId, agents.technical.barDate as string, asOf)
        );
    }
    // The pitch is computed last and only reported: no decision above reads it.
    const pitch = pitchAgent({
      asOf,
      fundamental: agents.fundamental,
      fundamentals: report.fundamentals,
      newsSentiment: agents.newsSentiment,
      technical: agents.technical,
    });
    return {
      agents: { ...agents, pitch, process },
      assetType: report.metadata.assetType,
      name: report.metadata.name,
      reportId,
    };
  });
  const active = positions.filter((position) => position.status !== "closed");
  const book: PaperBook = {
    ...prior,
    lastRunAsOf:
      prior.lastRunAsOf !== null && prior.lastRunAsOf > asOf
        ? prior.lastRunAsOf
        : asOf,
    positions: [...positions, ...later],
    vehiclePolicy: VEHICLE_POLICY,
  };
  return {
    book,
    report: {
      asOf,
      backtestSettings: settings,
      limits: [
        "Agents are deterministic readers of accepted report datasets; they do not collect new data.",
        "Stale datasets block paper entries. Refresh market and news data before treating a run as current.",
        "Paper results use underlying reference prices only. They are not option P&L and not trade approval.",
        "Active positions of tickers not in this run are not updated, but they count toward the position cap.",
      ],
      mode: "paper",
      orders: "none",
      paperBook: {
        active: active.length,
        activePositions: active,
        closed: positions.length - active.length,
        notInThisRun: active
          .filter((position) => !runIds.has(position.reportId))
          .map((position) => position.id),
      },
      rule,
      tickers,
      vehiclePolicy: VEHICLE_POLICY,
      version: DESK_VERSION,
    },
  };
};

/** Short plain-text summary for logs or chat. */
export const renderSummary = (report: DeskReport): string => {
  const lines = [
    `Paper agent desk ${report.asOf}: paper only, no orders.`,
    report.vehiclePolicy,
  ];
  for (const ticker of report.tickers) {
    const { technical, fundamental, newsSentiment, backtest, process, pitch } =
      ticker.agents;
    const { priceStop, timeStop } = pitch.exits;
    const above = technical.checks?.closeAboveSma;
    lines.push(
      `${ticker.reportId}: ${process.decision} | ROC ${technical.rocPct ?? "n/a"}% | close above SMA${report.rule.smaPeriod}: ${above === true ? "yes" : above === false ? "no" : "unknown"}` +
        ` | backtest ${backtest.closedTrades} trades, mean underlying reference return ${backtest.meanReturnPct ?? "n/a"}%` +
        ` | fundamentals ${fundamental.status}${fundamental.blocking ? " (blocking)" : ""} | sentiment ${newsSentiment.sentiment.status}`,
      `  ${process.reasons.join(" ")}`,
      `  Pitch (analysis only): ${pitch.posture} | ${pitch.direction} | price stop ${priceStop === null ? "n/a" : `${priceStop.level} (${priceStop.distancePct}% from close)`} | next catalyst ${timeStop === null ? "none dated" : `${timeStop.date} ${timeStop.title}`}`
    );
  }
  const notInRun =
    report.paperBook.notInThisRun.length === 0
      ? ""
      : ` Not in this run: ${report.paperBook.notInThisRun.join(", ")}.`;
  lines.push(
    `Paper book: ${report.paperBook.active} active, ${report.paperBook.closed} closed.${notInRun}`
  );
  return lines.join("\n");
};
