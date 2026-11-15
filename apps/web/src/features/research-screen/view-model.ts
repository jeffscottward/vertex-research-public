// View-model for the research screen page (researchScreen.status): the scheduler line, the run
// lines, the slot lists in New York time and the stored rows as display texts. Pure: every time is
// formatted with an explicit time zone. Research only: no row is an instruction to trade.
import type {
  ResearchScreenContext,
  ResearchScreenRow,
  ResearchScreenRun,
  ResearchScreenStatusOutput,
} from "@darkfactory/api";

export const RESEARCH_SCREEN_PATH = "/research/screen";

export type ResearchScreenTone =
  | "destructive"
  | "info"
  | "neutral"
  | "success"
  | "warning";

type Labelled = Readonly<{ label: string; tone: ResearchScreenTone }>;

const SCHEDULER_STATES: Readonly<
  Record<ResearchScreenStatusOutput["scheduler"]["state"], Labelled>
> = {
  late: { label: "Scheduler late", tone: "warning" },
  never: { label: "No tick yet", tone: "neutral" },
  ok: { label: "Scheduler running", tone: "success" },
  silent: { label: "Scheduler silent", tone: "destructive" },
};

const RUN_STATUSES: Readonly<Record<ResearchScreenRun["status"], Labelled>> = {
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "destructive" },
  interrupted: { label: "Interrupted", tone: "warning" },
  partial: { label: "Partial", tone: "warning" },
  running: { label: "In progress", tone: "info" },
};

const actionLabelled = (action: ResearchScreenRow["action"]): Labelled => {
  switch (action) {
    case "review-entry":
      return { label: "Review entry", tone: "success" };
    case "watch":
      return { label: "Watch", tone: "info" };
    case "wait":
      return { label: "Wait", tone: "neutral" };
    default:
      return { label: "No current data", tone: "warning" };
  }
};

const BARS_SOURCES: Readonly<
  Record<NonNullable<ResearchScreenRow["barsSource"]>, string>
> = {
  ibkr: "IBKR bars",
  yahoo: "Yahoo bars",
};

/** Shown where a number has no stored value. */
const RESEARCH_SCREEN_NO_VALUE = "none";

const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "short",
  timeZone: "America/New_York",
});
const UTC = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: "UTC",
});

/** "Nov 13, 09:30 ET (14:30 UTC)". */
export const formatScreenTime = (at: Date): string =>
  `${NEW_YORK.format(at)} ET (${UTC.format(at)} UTC)`;

const timeOr = (at: Date | null, missing: string): string =>
  at === null ? missing : formatScreenTime(at);

const fixed = (value: number | null, digits: number): string =>
  value === null ? RESEARCH_SCREEN_NO_VALUE : value.toFixed(digits);

const percent = (value: number | null): string =>
  value === null
    ? RESEARCH_SCREEN_NO_VALUE
    : `${value > 0 ? "+" : ""}${value.toFixed(2)} %`;

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;

/** "3 h 12 min", "12 min", or "no quote". */
export const formatQuoteAge = (ageMs: number | null): string => {
  if (ageMs === null) return "no quote";
  const minutes = Math.max(0, Math.floor(ageMs / MINUTE_MS));
  const hours = Math.floor(minutes / HOUR_MINUTES);
  const rest = minutes % HOUR_MINUTES;
  return hours > 0 ? `${hours} h ${rest} min` : `${rest} min`;
};

export type ResearchScreenRunView = Readonly<{
  detail: string;
  id: string;
  message: string | null;
  /** Percent of the reports worked; only for a run in progress. */
  progressPercent: number | null;
  slotLabels: string;
  statusLabel: string;
  timing: string;
  title: string;
  tone: ResearchScreenTone;
}>;

export type ResearchScreenSlotView = Readonly<{
  key: string;
  labels: string;
  time: string;
}>;

export type ResearchScreenRowView = Readonly<{
  actionLabel: string;
  actionTone: ResearchScreenTone;
  blockingWarnings: readonly string[];
  buyZone: string;
  change: string;
  collectionNote: string | null;
  errorCode: string | null;
  id: string;
  price: string;
  quoteAge: string;
  reasons: readonly string[];
  rewardRisk: string;
  score: string;
  sources: string;
  stop: string;
  /** The action the last good run stored, only when it differs from the shown action. */
  storedActionLabel: string | null;
  support: string;
  symbol: string;
  target: string;
  warnings: readonly string[];
}>;

export type ResearchScreenSnapshotView = Readonly<{
  /** Regime, breadth, VIX and scanner: every parsed value, in this order. */
  groups: readonly Readonly<{
    items: readonly Readonly<{ label: string; value: string }>[];
    title: string;
  }>[];
  setups: readonly Readonly<{
    direction: string;
    name: string;
    pattern: string;
    sector: string;
    ticker: string;
  }>[];
  themes: readonly Readonly<{ bias: string; change: string; name: string }>[];
}>;

export type ResearchScreenContextView = Readonly<{
  generated: string;
  lastError: string | null;
  retrieved: string;
  snapshot: ResearchScreenSnapshotView | null;
  stale: boolean;
  warning: string;
}>;

export type ResearchScreenViewModel = Readonly<{
  activeRun: ResearchScreenRunView | null;
  /** When the server evaluated this status. */
  asOf: string;
  context: ResearchScreenContextView | null;
  lastRun: ResearchScreenRunView | null;
  limitations: readonly string[];
  missedSlots: readonly ResearchScreenSlotView[];
  nextSlots: readonly ResearchScreenSlotView[];
  rows: readonly ResearchScreenRowView[];
  scheduler: Readonly<{
    label: string;
    lastTick: string;
    tone: ResearchScreenTone;
  }>;
}>;

const PERCENT = 100;

const toRun = (run: ResearchScreenRun | null): ResearchScreenRunView | null => {
  if (run === null) return null;
  const worked = run.succeeded + run.failed;
  const running = run.status === "running";
  const status = RUN_STATUSES[run.status];
  return {
    detail: `${run.succeeded} succeeded, ${run.failed} failed, ${run.notReached} not reached; bars: ${run.barsFromIbkr} IBKR, ${run.barsFromYahoo} Yahoo`,
    id: run.id,
    message: run.message,
    progressPercent: running
      ? Math.round((worked / Math.max(1, run.total)) * PERCENT)
      : null,
    slotLabels: run.slotLabels.join(", "),
    statusLabel: status.label,
    timing:
      run.finishedAt === null
        ? `Claimed ${formatScreenTime(run.claimedAt)}; deadline ${formatScreenTime(run.deadlineAt)}`
        : `Finished ${formatScreenTime(run.finishedAt)}`,
    title: `Run of ${formatScreenTime(run.slotAt)}: ${worked} of ${run.total} reports`,
    tone: status.tone,
  };
};

const toSlot = (
  slot: ResearchScreenStatusOutput["nextSlots"][number]
): ResearchScreenSlotView => ({
  key: slot.at.toISOString(),
  labels: slot.labels.join(", "),
  time: formatScreenTime(slot.at),
});

const collectionNote = (row: ResearchScreenRow): string | null => {
  if (row.collection === "never") return "Not collected yet";
  if (row.collection === "fresh") return null;
  return row.lastGoodAt === null
    ? "Latest collection failed; no earlier values are stored"
    : `Latest collection failed; values are from ${formatScreenTime(row.lastGoodAt)}`;
};

const sourceLabels = (row: ResearchScreenRow): string => {
  const labels = [
    ...(row.barsSource === null ? [] : [BARS_SOURCES[row.barsSource]]),
    ...(row.quoteSource === null ? [] : ["Yahoo quote"]),
  ];
  return labels.length === 0 ? "no source" : labels.join(", ");
};

const toRow = (row: ResearchScreenRow): ResearchScreenRowView => {
  const action = actionLabelled(row.action);
  return {
    actionLabel: action.label,
    actionTone: action.tone,
    blockingWarnings: row.blockingWarnings.map((warning) => warning.text),
    buyZone:
      row.buyZone === null
        ? RESEARCH_SCREEN_NO_VALUE
        : `${row.buyZone.low.toFixed(2)} to ${row.buyZone.high.toFixed(2)}`,
    change: percent(row.changePercent),
    collectionNote: collectionNote(row),
    errorCode: row.errorCode,
    id: row.reportId,
    price: fixed(row.price, 2),
    quoteAge: formatQuoteAge(row.quoteAgeMs),
    reasons: row.reasons,
    rewardRisk: fixed(row.rewardRisk, 2),
    score: row.score.toFixed(1),
    sources: sourceLabels(row),
    stop: fixed(row.stop, 2),
    storedActionLabel:
      row.storedAction === null || row.storedAction === row.action
        ? null
        : actionLabelled(row.storedAction).label,
    support: fixed(row.support, 2),
    symbol: row.symbol,
    target: fixed(row.target, 2),
    warnings: row.warnings,
  };
};

/** A share of 0 to 100 without a sign: "60.0 %". */
const share = (value: number | null): string =>
  value === null ? RESEARCH_SCREEN_NO_VALUE : `${value.toFixed(1)} %`;

const toSnapshot = (
  snapshot: NonNullable<ResearchScreenContext["snapshot"]>
): ResearchScreenSnapshotView => ({
  groups: [
    {
      items: [
        { label: "Label", value: snapshot.regime.label },
        {
          label: "Trend strength",
          value: snapshot.regime.trendStrength ?? RESEARCH_SCREEN_NO_VALUE,
        },
        {
          label: "Risk level",
          value: snapshot.regime.riskLevel ?? RESEARCH_SCREEN_NO_VALUE,
        },
      ],
      title: "Regime",
    },
    {
      items: [
        { label: "Score", value: fixed(snapshot.breadth.score, 0) },
        {
          label: "Regime",
          value: snapshot.breadth.regime ?? RESEARCH_SCREEN_NO_VALUE,
        },
        {
          label: "Above 20-day average",
          value: share(snapshot.breadth.above20DayPercent),
        },
        {
          label: "Above 50-day average",
          value: share(snapshot.breadth.above50DayPercent),
        },
        {
          label: "Above 200-day average",
          value: share(snapshot.breadth.above200DayPercent),
        },
      ],
      title: "Breadth",
    },
    {
      items: [
        { label: "Level", value: fixed(snapshot.vix.level, 2) },
        {
          label: "1-year percentile",
          value: fixed(snapshot.vix.percentile1Year, 0),
        },
        {
          label: "Regime",
          value: snapshot.vix.regime ?? RESEARCH_SCREEN_NO_VALUE,
        },
        {
          label: "Trend",
          value: snapshot.vix.trend ?? RESEARCH_SCREEN_NO_VALUE,
        },
      ],
      title: "VIX",
    },
    {
      items: [
        { label: "Scanned", value: fixed(snapshot.scanner.total, 0) },
        { label: "With setups", value: fixed(snapshot.scanner.withSetups, 0) },
        { label: "Bullish", value: fixed(snapshot.scanner.bullish, 0) },
        { label: "Bearish", value: fixed(snapshot.scanner.bearish, 0) },
      ],
      title: "Scanner",
    },
  ],
  setups: snapshot.setups.map((setup) => ({
    direction: setup.direction === "bullish" ? "Bullish" : "Bearish",
    name: setup.name ?? RESEARCH_SCREEN_NO_VALUE,
    pattern: setup.pattern ?? RESEARCH_SCREEN_NO_VALUE,
    sector: setup.sector ?? RESEARCH_SCREEN_NO_VALUE,
    ticker: setup.ticker,
  })),
  themes: snapshot.themes.map((theme) => ({
    bias: theme.bias ?? RESEARCH_SCREEN_NO_VALUE,
    change: percent(theme.changePercent),
    name: theme.name,
  })),
});

const NOT_RECORDED = "not recorded";

const toContext = (
  context: ResearchScreenContext | null
): ResearchScreenContextView | null =>
  context === null
    ? null
    : {
        generated: timeOr(context.generatedAt, NOT_RECORDED),
        lastError: context.lastError,
        retrieved: timeOr(context.retrievedAt, NOT_RECORDED),
        snapshot:
          context.snapshot === null ? null : toSnapshot(context.snapshot),
        stale: context.stale,
        warning: context.warning,
      };

export const toResearchScreenViewModel = (
  status: ResearchScreenStatusOutput
): ResearchScreenViewModel => {
  const scheduler = SCHEDULER_STATES[status.scheduler.state];
  return {
    activeRun: toRun(status.activeRun),
    asOf: formatScreenTime(status.evaluatedAt),
    context: toContext(status.swinglytics),
    lastRun: toRun(status.lastRun),
    limitations: status.limitations,
    missedSlots: status.missedSlots.map(toSlot),
    nextSlots: status.nextSlots.map(toSlot),
    rows: status.rows.map(toRow),
    scheduler: {
      label: scheduler.label,
      lastTick: timeOr(status.scheduler.lastTickAt, "No tick recorded"),
      tone: scheduler.tone,
    },
  };
};
