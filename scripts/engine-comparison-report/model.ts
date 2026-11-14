// Data model of the step-4 "current engine vs Nautilus" report page (research only; no orders).
// Pure functions: the run step (./run.ts) fetches the stored comparison runs and the worker
// journal, this file turns them into figures, ./render.ts writes the page. p95 is the nearest
// rank, the same method as the 2026-11-06 rig benchmark.
import { z } from "zod";

import {
  ENGINE_COMPARISON_FEATURES,
  ENGINE_COMPARISON_SUPERSEDED_ERROR,
  type EngineComparisonFeature,
  EngineComparisonSpecSchema,
  EngineDifferencesSchema,
  EngineRunSchema,
} from "../../packages/api/src/contracts/engine-comparison.ts";
import type { Benchmark } from "./rig-benchmark-2026-11-06.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** An error streak or a stopped service shorter than this is not an outage. */
const OUTAGE_MIN_MS = 10 * 60_000;
/** Owner decision date of switch-plan step 4 (docs/vertex-rebuild/nautilus-backtest-engine.md). */
const STEP4_DECISION_DATE = "2026-11-20";
/** Step 4 dual run went live on production (switch plan). */
const STEP4_DUAL_RUN_SINCE = "2026-11-06";
/** Pass condition of step 4: two weeks of live side-by-side data. */
const STEP4_DAYS_NEEDED = 14;
const STEP4_FEATURES: readonly EngineComparisonFeature[] = [
  "instant",
  "sweep",
  "autopilotGate",
];

const FEATURE_TITLES: Readonly<Record<EngineComparisonFeature, string>> = {
  academy: "Academy options backtest",
  autopilotGate: "Autopilot gate",
  instant: "Instant backtest",
  paperForward: "Paper forward tick",
  setupReplay: "Setup replay",
  sweep: "Parameter sweep",
};

/** Switch-plan step of each feature. */
const FEATURE_STEP: Readonly<Record<EngineComparisonFeature, number>> = {
  academy: 6,
  autopilotGate: 4,
  instant: 4,
  paperForward: 5,
  setupReplay: 5,
  sweep: 4,
};

/** An ISO date-time with an offset, normalized to UTC (`utcDay` and the page read it as UTC). */
export const IsoDateSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

/** One row of backtestRuns.comparisons.list as JSON (dates as ISO strings). */
export const ComparisonRowSchema = z.object({
  comparison: EngineComparisonSpecSchema,
  createdAt: IsoDateSchema,
  differences: EngineDifferencesSchema.nullable(),
  engineRun: EngineRunSchema.nullable(),
  error: z.string().nullable(),
  finishedAt: IsoDateSchema.nullable(),
  from: z.string(),
  id: z.string(),
  queueWaitMs: z.number().nullable(),
  startedAt: IsoDateSchema.nullable(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  symbol: z.string(),
  to: z.string(),
});
export type ComparisonRow = z.infer<typeof ComparisonRowSchema>;

/** A Nautilus backtest run that is not a comparison (backtestRuns.list + get). */
export type NautilusRun = Readonly<{
  createdAt: string;
  engineRun: z.infer<typeof EngineRunSchema> | null;
  error: string | null;
  finishedAt: string | null;
  from: string;
  id: string;
  label: string;
  startedAt: string | null;
  status: string;
  symbol: string;
  to: string;
}>;

export type JournalEntry = Readonly<{ at: number; message: string }>;

export type Outage = Readonly<{
  from: number;
  /** null: still going on when the report was built. */
  to: number | null;
  reason: string;
}>;

export type Stats = Readonly<{
  max: number;
  n: number;
  p50: number;
  p95: number;
}>;

/** Nearest-rank percentile (p in 0..1); undefined for no values. */
export const nearestRank = (
  values: readonly number[],
  p: number
): number | undefined => {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
};

export const statsOf = (values: readonly number[]): Stats | null => {
  const finite = values.filter((value) => Number.isFinite(value));
  const p50 = nearestRank(finite, 0.5);
  const p95 = nearestRank(finite, 0.95);
  if (p50 === undefined || p95 === undefined) return null;
  return { max: Math.max(...finite), n: finite.length, p50, p95 };
};

// Lines of the worker that mean it could not reach the API (not the 429 quiet pauses).
const ERROR_LINE =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|fetch failed|Unable to connect|timed out|returned HTTP 5\d\d/i;
const STOPPED_LINE = /^Stopped /;
const STARTED_LINE = /^Started /;
/**
 * Errors closer together than this belong to one outage. The worker logs each failed request;
 * its longest silent stretch between two of them (idle wait, request timeouts and the quiet pause
 * after the request budget) is about 7 min.
 */
const ERROR_CLUSTER_GAP_MS = 10 * 60_000;

const errorReason = (message: string): string => {
  const match = /getaddrinfo (ENOTFOUND|EAI_AGAIN)/.exec(message);
  if (match !== null)
    return `worker could not resolve the API host name (getaddrinfo ${match[1]})`;
  if (/returned HTTP 5\d\d/i.test(message))
    return "API answered with server errors (HTTP 5xx)";
  if (/timed out/i.test(message)) return "API requests timed out";
  return "worker could not reach the API";
};

interface ErrorCluster {
  from: number;
  last: number;
  reason: string;
  /** A service start after the last error; errors within the gap continue the outage. */
  restartedAt: number | null;
}

/** The outage of a closed error cluster: up to the restart after it, else its last error. */
const clusterOutage = (cluster: ErrorCluster): Outage =>
  cluster.restartedAt === null
    ? { from: cluster.from, reason: cluster.reason, to: cluster.last }
    : {
        from: cluster.from,
        reason: `${cluster.reason} until the service restart`,
        to: cluster.restartedAt,
      };

/** The outage still open when the journal ends: recent errors, or a stop with no start. */
const openAtEnd = (
  cluster: ErrorCluster | null,
  stoppedAt: number | null,
  now: number
): Outage[] => {
  if (cluster !== null && stoppedAt !== null)
    return [
      {
        from: cluster.from,
        reason: `${cluster.reason}, then the service stopped`,
        to: null,
      },
    ];
  if (cluster !== null)
    return [
      cluster.restartedAt === null && now - cluster.last <= ERROR_CLUSTER_GAP_MS
        ? { from: cluster.from, reason: cluster.reason, to: null }
        : clusterOutage(cluster),
    ];
  return stoppedAt === null
    ? []
    : [{ from: stoppedAt, reason: "worker service stopped", to: null }];
};

/**
 * Worker outages in the journal: a cluster of connection errors (each within 10 min of the one
 * before; it ends at the last error, or at the service start after it when no error follows), or
 * the unit stopped until its next start; both only when they last at least `minMs`. Other lines
 * (quiet pauses, alerts, web-restart pauses) neither start nor end an outage.
 */
export const findOutages = (
  entries: readonly JournalEntry[],
  options: Readonly<{ minMs?: number; now: number }>
): Outage[] => {
  const minMs = options.minMs ?? OUTAGE_MIN_MS;
  const sorted = [...entries].sort((left, right) => left.at - right.at);
  const found: Outage[] = [];
  let cluster: ErrorCluster | null = null;
  let stoppedAt: number | null = null;
  for (const entry of sorted) {
    if (
      cluster !== null &&
      entry.at - Math.max(cluster.last, cluster.restartedAt ?? 0) >
        ERROR_CLUSTER_GAP_MS
    ) {
      found.push(clusterOutage(cluster));
      cluster = null;
    }
    if (ERROR_LINE.test(entry.message)) {
      cluster ??= {
        from: entry.at,
        last: entry.at,
        reason: errorReason(entry.message),
        restartedAt: null,
      };
      cluster.last = entry.at;
      cluster.restartedAt = null;
    } else if (STOPPED_LINE.test(entry.message)) stoppedAt ??= entry.at;
    else if (STARTED_LINE.test(entry.message)) {
      if (cluster !== null) cluster.restartedAt = entry.at;
      else if (stoppedAt !== null)
        found.push({
          from: stoppedAt,
          reason: "worker service stopped",
          to: entry.at,
        });
      stoppedAt = null;
    }
  }
  found.push(...openAtEnd(cluster, stoppedAt, options.now));
  return found.filter(
    (outage) => (outage.to ?? options.now) - outage.from >= minMs
  );
};

/** Union of outage lists: overlapping windows merge and keep the reason of the earliest one (the earlier list on a tie). */
export const mergeOutages = (
  ...lists: readonly (readonly Outage[])[]
): Outage[] => {
  const all = lists.flat().sort((left, right) => left.from - right.from);
  const merged: { from: number; reason: string; to: number | null }[] = [];
  for (const outage of all) {
    const last = merged.at(-1);
    if (last !== undefined && (last.to === null || outage.from <= last.to)) {
      last.to =
        last.to === null || outage.to === null
          ? null
          : Math.max(last.to, outage.to);
      continue;
    }
    merged.push({ ...outage });
  }
  return merged;
};

export type FeatureSummary = Readonly<{
  cpu: Stats | null;
  days: number;
  differing: number;
  differenceItems: readonly Readonly<{
    detail: string;
    field: string;
    label: string;
  }>[];
  engineWall: Stats | null;
  failures: readonly Readonly<{ count: number; error: string }>[];
  feature: EngineComparisonFeature;
  gpu: readonly string[];
  matched: number;
  nautilusHosts: readonly string[];
  processWall: Stats | null;
  queueWait: Stats | null;
  requests: number;
  runs: number;
  /** First and last creation time; null without runs. */
  span: Readonly<{ first: string; last: string }> | null;
  status: Readonly<Record<ComparisonRow["status"], number>>;
  step: number;
  superseded: number;
  title: string;
  /** The list returned as many rows as asked for: older rows may be missing. */
  truncated: boolean;
  tsFrozen: number;
  tsHosts: readonly string[];
  tsWall: Stats | null;
}>;

const DIFFERENCE_ITEMS_MAX = 12;

const unique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort();

const utcDay = (iso: string): string => iso.slice(0, 10);

export const summarizeFeature = (
  feature: EngineComparisonFeature,
  rows: readonly ComparisonRow[],
  limit: number
): FeatureSummary => {
  const created = rows.map((row) => row.createdAt).sort();
  const first = created[0];
  const last = created.at(-1);
  const failed = rows.filter((row) => row.status === "failed");
  const superseded = failed.filter(
    (row) => row.error === ENGINE_COMPARISON_SUPERSEDED_ERROR
  ).length;
  const failureCounts = new Map<string, number>();
  for (const row of failed) {
    if (row.error === ENGINE_COMPARISON_SUPERSEDED_ERROR) continue;
    const error = row.error ?? "failed without an error text";
    failureCounts.set(error, (failureCounts.get(error) ?? 0) + 1);
  }
  const engineRuns = rows.flatMap((row) =>
    row.engineRun === null ? [] : [row.engineRun]
  );
  const status = { failed: 0, queued: 0, running: 0, succeeded: 0 };
  for (const row of rows) status[row.status] += 1;
  return {
    cpu: statsOf(
      engineRuns.flatMap((run) => (run.cpuMs === null ? [] : [run.cpuMs]))
    ),
    days: new Set(created.map(utcDay)).size,
    differenceItems: rows
      .flatMap((row) =>
        (row.differences?.items ?? []).map((item) => ({
          detail: item.detail,
          field: item.field,
          label: row.comparison.label,
        }))
      )
      .slice(0, DIFFERENCE_ITEMS_MAX),
    differing: rows.filter((row) => row.differences?.ok === false).length,
    engineWall: statsOf(
      engineRuns.flatMap((run) => (run.wallMs === null ? [] : [run.wallMs]))
    ),
    failures: [...failureCounts]
      .map(([error, count]) => ({ count, error }))
      .sort((left, right) => right.count - left.count),
    feature,
    gpu: unique(engineRuns.map((run) => run.gpu)),
    matched: rows.filter((row) => row.differences?.ok === true).length,
    nautilusHosts: unique(engineRuns.map((run) => run.host)),
    processWall: statsOf(
      engineRuns.flatMap((run) =>
        run.processWallMs === null ? [] : [run.processWallMs]
      )
    ),
    queueWait: statsOf(
      rows.flatMap((row) =>
        row.queueWaitMs === null || row.status === "failed"
          ? []
          : [row.queueWaitMs]
      )
    ),
    requests: new Set(rows.map((row) => row.comparison.groupId)).size,
    runs: rows.length,
    span: first === undefined || last === undefined ? null : { first, last },
    status,
    step: FEATURE_STEP[feature],
    superseded,
    title: FEATURE_TITLES[feature],
    truncated: rows.length >= limit,
    tsFrozen: rows.filter((row) => row.comparison.typescript.wallMs === null)
      .length,
    tsHosts: unique(rows.map((row) => row.comparison.typescript.host)),
    tsWall: statsOf(
      rows.flatMap((row) =>
        row.comparison.typescript.wallMs === null
          ? []
          : [row.comparison.typescript.wallMs]
      )
    ),
  };
};

export type TimelinePoint = Readonly<{
  at: string;
  kind:
    | "matched"
    | "differs"
    | "unknown"
    | "failed"
    | "superseded"
    | "pending"
    | "nautilus";
  row: string;
}>;

export type OutageView = Readonly<{
  from: string;
  hours: number;
  reason: string;
  /** Runs created inside the window (any feature, Nautilus-only runs included). */
  runsCreated: number;
  to: string | null;
}>;

export type ReportModel = Readonly<{
  benchmark: Benchmark;
  features: readonly FeatureSummary[];
  generatedAt: string;
  journal: Readonly<{ entries: number; firstAt: string | null; read: boolean }>;
  limit: number;
  /** backtestRuns.list returned its maximum: older Nautilus runs may be missing. */
  nautilusListFull: boolean;
  nautilusRuns: readonly (NautilusRun & { queueWaitMs: number | null })[];
  outages: readonly OutageView[];
  step4: Readonly<{
    daysNeeded: number;
    /** Whole days from the dual run start to the build time. */
    daysSinceStart: number;
    decisionDate: string;
    /** One line per step-4 feature: its live runs since the dual run start. */
    lines: readonly string[];
    met: boolean;
    since: string;
    verdict: string;
  }>;
  timeline: readonly TimelinePoint[];
  windowFrom: string;
}>;

const pointKind = (row: ComparisonRow): TimelinePoint["kind"] => {
  if (row.status === "failed")
    return row.error === ENGINE_COMPARISON_SUPERSEDED_ERROR
      ? "superseded"
      : "failed";
  if (row.status !== "succeeded") return "pending";
  if (row.differences === null) return "unknown";
  return row.differences.ok ? "matched" : "differs";
};

/**
 * Step 4 passes with two weeks of live side-by-side data: the dual run live for `daysNeeded`
 * days and compared runs (succeeded, differences stored) of every step-4 feature in that time.
 * Rows from before the dual run start do not count; a feature at the list limit has lower-bound
 * counts.
 */
const step4Status = (
  summaries: readonly FeatureSummary[],
  rows: Readonly<
    Partial<Record<EngineComparisonFeature, readonly ComparisonRow[]>>
  >,
  daysSinceStart: number
): Readonly<{ lines: string[]; met: boolean; verdict: string }> => {
  const since = `${STEP4_DUAL_RUN_SINCE}T00:00:00.000Z`;
  const live = summaries.map((summary) => {
    const liveRows = (rows[summary.feature] ?? []).filter(
      (row) => row.createdAt >= since
    );
    const days = [
      ...new Set(liveRows.map((row) => utcDay(row.createdAt))),
    ].sort();
    const requests = new Set(liveRows.map((row) => row.comparison.groupId))
      .size;
    const compared = liveRows.filter(
      (row) => row.status === "succeeded" && row.differences !== null
    );
    const bound = summary.truncated ? " at least" : "";
    // Calendar days so far, the start day and today included.
    const calendarDays = daysSinceStart + 1;
    return {
      compared: compared.length,
      line:
        liveRows.length === 0
          ? `${summary.title}: no live comparison runs since ${STEP4_DUAL_RUN_SINCE}.`
          : `${summary.title}:${bound} ${liveRows.length} runs (${compared.length} compared) from ${requests} request(s), on ${days.length} of ${calendarDays} calendar day(s) (${days[0]} to ${days.at(-1)}); ${compared.filter((row) => row.differences?.ok === true).length} same, ${compared.filter((row) => row.differences?.ok === false).length} differ.`,
      summary,
    };
  });
  const without = live
    .filter((entry) => entry.compared === 0)
    .map((entry) => entry.summary.title);
  const lowerBound = live
    .filter((entry) => entry.summary.truncated)
    .map((entry) => entry.summary.title);
  const enoughTime = daysSinceStart >= STEP4_DAYS_NEEDED;
  const parts = [
    enoughTime
      ? `The dual run has been live ${daysSinceStart} days.`
      : `Not met yet: the dual run has been live ${daysSinceStart} of ${STEP4_DAYS_NEEDED} days.`,
    without.length === 0
      ? "Every step-4 feature has compared live runs."
      : `No compared live runs for ${without.join(", ")}.`,
    lowerBound.length === 0
      ? ""
      : `Counts for ${lowerBound.join(", ")} are lower bounds (list limit reached).`,
  ];
  const met = enoughTime && without.length === 0;
  return {
    lines: live.map((entry) => entry.line),
    met,
    verdict: `${met ? "Met. " : ""}${parts.filter((part) => part !== "").join(" ")}`,
  };
};

export const buildModel = (
  input: Readonly<{
    benchmark: Benchmark;
    comparisons: Readonly<
      Partial<Record<EngineComparisonFeature, readonly ComparisonRow[]>>
    >;
    generatedAt: Date;
    journal: Readonly<{ entries: readonly JournalEntry[]; read: boolean }>;
    limit: number;
    nautilusListFull: boolean;
    nautilusRuns: readonly NautilusRun[];
  }>
): ReportModel => {
  const now = input.generatedAt.getTime();
  const features = ENGINE_COMPARISON_FEATURES.map((feature) =>
    summarizeFeature(feature, input.comparisons[feature] ?? [], input.limit)
  );
  const known = input.benchmark.knownOutages.map((outage) => ({
    from: Date.parse(outage.from),
    reason: outage.reason,
    to: Date.parse(outage.to),
  }));
  const allRows = ENGINE_COMPARISON_FEATURES.flatMap(
    (feature) => input.comparisons[feature] ?? []
  );
  const createdTimes = [
    ...allRows.map((row) => Date.parse(row.createdAt)),
    ...input.nautilusRuns.map((run) => Date.parse(run.createdAt)),
  ];
  const outages = mergeOutages(
    known,
    findOutages(input.journal.entries, { now })
  ).map((outage) => ({
    from: new Date(outage.from).toISOString(),
    hours: ((outage.to ?? now) - outage.from) / HOUR_MS,
    reason: outage.reason,
    runsCreated: createdTimes.filter(
      (at) => at >= outage.from && at < (outage.to ?? now)
    ).length,
    to: outage.to === null ? null : new Date(outage.to).toISOString(),
  }));
  const earliest = Math.min(
    Date.parse(input.benchmark.measuredAt),
    ...createdTimes,
    ...outages.map((outage) => Date.parse(outage.from))
  );
  const windowFrom = new Date(
    Math.floor(earliest / DAY_MS) * DAY_MS
  ).toISOString();
  const timeline: TimelinePoint[] = [
    ...ENGINE_COMPARISON_FEATURES.flatMap((feature) =>
      (input.comparisons[feature] ?? []).map((row) => ({
        at: row.createdAt,
        kind: pointKind(row),
        row: FEATURE_TITLES[feature],
      }))
    ),
    ...input.nautilusRuns.map((run) => ({
      at: run.createdAt,
      kind: "nautilus" as const,
      row: "Nautilus backtest runs",
    })),
  ];
  const daysSinceStart = Math.floor(
    (now - Date.parse(`${STEP4_DUAL_RUN_SINCE}T00:00:00.000Z`)) / DAY_MS
  );
  const journalFirst = input.journal.entries.reduce(
    (first, entry) => Math.min(first, entry.at),
    Number.POSITIVE_INFINITY
  );
  return {
    benchmark: input.benchmark,
    features,
    generatedAt: input.generatedAt.toISOString(),
    journal: {
      entries: input.journal.entries.length,
      firstAt: Number.isFinite(journalFirst)
        ? new Date(journalFirst).toISOString()
        : null,
      read: input.journal.read,
    },
    limit: input.limit,
    nautilusListFull: input.nautilusListFull,
    nautilusRuns: [...input.nautilusRuns]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((run) => ({
        ...run,
        queueWaitMs:
          run.startedAt === null
            ? null
            : Date.parse(run.startedAt) - Date.parse(run.createdAt),
      })),
    outages,
    step4: {
      daysNeeded: STEP4_DAYS_NEEDED,
      daysSinceStart,
      decisionDate: STEP4_DECISION_DATE,
      since: STEP4_DUAL_RUN_SINCE,
      ...step4Status(
        features.filter((summary) => STEP4_FEATURES.includes(summary.feature)),
        input.comparisons,
        daysSinceStart
      ),
    },
    timeline,
    windowFrom,
  };
};
