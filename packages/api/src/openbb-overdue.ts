import {
  FLOW_SOURCE_METADATA,
  FLOW_SOURCES,
  type FlowSource,
} from "./contracts/flow.ts";
import {
  OPENBB_JOB_METADATA,
  OPENBB_JOBS,
  type OpenbbSourceStatus,
} from "./contracts/openbb.ts";
import { isNyseTradingDay, utcDay } from "./nyse-calendar.ts";

// Pure per-source overdue evaluation and incident-transition logic for OpenBB jobs and QuantVPS
// flow sources (docs/vertex-rebuild/designs/smart-money/plan-pr6.md). Research data alerting only:
// no DB or HTTP dependencies, no order or risk paths.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const FORM4_DUE_HOUR_NY = 10;
const FINRA_DUE_HOUR_NY = 10;
const MARKET_PREMIUM_OPEN_MINUTE = 9 * 60 + 30;
const MARKET_PREMIUM_CLOSE_MINUTE = 16 * 60 + 15;
const MARKET_PREMIUM_CLEAR_MINUTE =
  MARKET_PREMIUM_CLOSE_MINUTE -
  Math.floor(FLOW_SOURCE_METADATA.market_premium.maxAgeSeconds / 60);

export const OPENBB_OVERDUE_MONITOR = "openbb-overdue" as const;
const OPENBB_OVERDUE_IN_FLIGHT_LEASE_MS = 60_000 as const;
const OPENBB_OVERDUE_MAX_LISTED_ITEMS = 8 as const;
const OPENBB_OVERDUE_REASON_MAX = 300;

/** QuantVPS flow sources read from flow_samples (market_premium comes from flow_market_premium_sessions). */
export const NON_PREMIUM_FLOW_SOURCES: readonly Exclude<
  FlowSource,
  "market_premium"
>[] = FLOW_SOURCES.filter(
  (source): source is Exclude<FlowSource, "market_premium"> =>
    source !== "market_premium"
);

/** Monitored source keys for the QuantVPS overdue pager (22 non-retired OpenBB jobs + market_premium). */
export const OPENBB_MONITORED_OVERDUE_KEYS: readonly string[] = [
  ...OPENBB_JOBS.filter(
    (job) => OPENBB_JOB_METADATA[job].schedule !== "retired"
  ).map((job) => `openbb:${job}`),
  "flow:market_premium",
];

export const sourceKeyOf = (
  item: Readonly<{ kind: OpenbbSourceStatus["kind"]; source: string }>
): string => `${item.kind}:${item.source}`;

type NyParts = Readonly<{
  day: number;
  hour: number;
  isoDate: string;
  minute: number;
  month: number;
  second: number;
  utcDayNum: number;
  year: number;
}>;

const NY_FORMAT = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});

const nyParts = (date: Date): NyParts => {
  const map = Object.fromEntries(
    NY_FORMAT.formatToParts(date).map((part) => [part.type, part.value])
  ) as Record<string, string>;
  const year = Number(map["year"]);
  const month = Number(map["month"]);
  const day = Number(map["day"]);
  return {
    day,
    hour: Number(map["hour"]),
    isoDate: `${map["year"]}-${map["month"]}-${map["day"]}`,
    minute: Number(map["minute"]),
    month,
    second: Number(map["second"]),
    utcDayNum: utcDay(year, month - 1, day),
    year,
  };
};

const isoDayOf = (utcDayNum: number): string =>
  new Date(utcDayNum * DAY_MS).toISOString().slice(0, 10);

/**
 * Exact UTC epoch millisecond timestamp of wall time `hour:minute:00 America/New_York` on
 * `utcDayNum` (DST-safe for every non-ambiguous wall time such as 00:00, 09:30, 10:00, 15:45).
 */
export const nyWallTimeUtcMs = (
  utcDayNum: number,
  hour: number,
  minute: number
): number => {
  const guess = utcDayNum * DAY_MS + (hour + 5) * HOUR_MS + minute * 60_000;
  const actual = nyParts(new Date(guess));
  const deltaSeconds =
    (actual.utcDayNum - utcDayNum) * 86_400 +
    (actual.hour - hour) * 3600 +
    (actual.minute - minute) * 60 +
    actual.second;
  return guess - deltaSeconds * 1000;
};

/**
 * Elapsed milliseconds between `from` and `to` falling inside America/New_York calendar dates
 * that are NYSE trading days (DST-safe). Weekends and NYSE holidays do not accrue age.
 */
export const elapsedTradingDayMs = (from: Date, to: Date): number => {
  if (to.getTime() <= from.getTime()) return 0;
  const startDay = nyParts(from).utcDayNum;
  const endDay = nyParts(to).utcDayNum;
  let total = 0;
  for (let day = startDay; day <= endDay; day += 1) {
    if (!isNyseTradingDay(day)) continue;
    const winStart = Math.max(from.getTime(), nyWallTimeUtcMs(day, 0, 0));
    const winEnd = Math.min(to.getTime(), nyWallTimeUtcMs(day + 1, 0, 0));
    if (winEnd > winStart) total += winEnd - winStart;
  }
  return total;
};

/** UTC instant when `elapsedTradingDayMs(from, instant)` reaches `maxAgeMs`. */
export const tradingDayDeadline = (from: Date, maxAgeMs: number): Date => {
  let remaining = maxAgeMs;
  let day = nyParts(from).utcDayNum;
  for (;;) {
    if (isNyseTradingDay(day)) {
      const winStart = Math.max(from.getTime(), nyWallTimeUtcMs(day, 0, 0));
      const winEnd = nyWallTimeUtcMs(day + 1, 0, 0);
      const span = Math.max(0, winEnd - winStart);
      if (remaining <= span) return new Date(winStart + remaining);
      remaining -= span;
    }
    day += 1;
  }
};

/** Most recent NYSE trading day strictly before `todayUtcDay`, formatted as `YYYY-MM-DD`. */
export const previousNyseTradingDay = (todayUtcDay: number): string => {
  let day = todayUtcDay - 1;
  while (!isNyseTradingDay(day)) day -= 1;
  return isoDayOf(day);
};

/**
 * Whether QuantData `market_premium` live options session is open right now: NYSE trading day
 * and 09:30–16:15 America/New_York. Shared between `openbb.status` and `smartMoney.ranking`.
 */
export const isMarketPremiumSessionOpen = (now: Date): boolean => {
  const parts = nyParts(now);
  if (!isNyseTradingDay(parts.utcDayNum)) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return (
    minutes >= MARKET_PREMIUM_OPEN_MINUTE &&
    minutes < MARKET_PREMIUM_CLOSE_MINUTE
  );
};

const isFlowSourceSessionOpen = (
  source: Exclude<FlowSource, "market_premium">,
  now: Date
): boolean => {
  const parts = nyParts(now);
  if (!isNyseTradingDay(parts.utcDayNum)) return false;
  const minutes = parts.hour * 60 + parts.minute;
  if (source === "net_drift")
    return minutes >= 9 * 60 + 30 && minutes < 16 * 60 + 20;
  if (source === "options" || source === "gex")
    return minutes >= 9 * 60 + 30 && minutes < 16 * 60 + 15;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
};

const sanitizeReason = (text: string): string => {
  const compact = text.replace(/[\r\n\t]+/gu, " ").trim();
  const safe = compact.replace(/unavailable/giu, "failed");
  return safe.length <= OPENBB_OVERDUE_REASON_MAX
    ? safe
    : `${safe.slice(0, OPENBB_OVERDUE_REASON_MAX - 3)}...`;
};

export type Form4IndexDaySummary = Readonly<{
  complete: boolean;
  indexDay: string;
}>;

export type Form4OverdueResult = Readonly<{
  incompleteDays: string[];
  newestCompleteDay: string | null;
  overdue: boolean;
  overdueSince: Date | null;
  reason: string | null;
}>;

/**
 * Single definition of SEC Form 4 overdue state, shared by `openbb.insiderClusters` and
 * `openbb.status`. Overdue when: no usable run in 30 h, an existing incomplete index day is older
 * than yesterday (or yesterday is incomplete at/after 10:00 ET), or no complete index day exists
 * in the last 7 calendar days. Using existing index-day rows avoids false alarms on US federal
 * holidays when NYSE is open but EDGAR publishes no index (Columbus Day, Veterans Day).
 */
export const evaluateForm4Overdue = (
  input: Readonly<{
    days: readonly Form4IndexDaySummary[];
    lastOkAt: Date | null;
    now: Date;
  }>
): Form4OverdueResult => {
  const parts = nyParts(input.now);
  const today = parts.isoDate;
  const yesterday = isoDayOf(parts.utcDayNum - 1);
  const weekAgo = isoDayOf(parts.utcDayNum - 7);
  const maxAgeMs = OPENBB_JOB_METADATA["sec-form4"].maxAgeHours * HOUR_MS;
  const incompleteDays = input.days
    .filter((day) => !day.complete)
    .map((day) => day.indexDay);
  const newestCompleteDay =
    input.days.find((day) => day.complete && day.indexDay <= today)?.indexDay ??
    null;

  if (input.lastOkAt === null) {
    return {
      incompleteDays,
      newestCompleteDay,
      overdue: true,
      overdueSince: null,
      reason: "No usable sec-form4 run recorded yet",
    };
  }
  if (input.now.getTime() - input.lastOkAt.getTime() > maxAgeMs) {
    return {
      incompleteDays,
      newestCompleteDay,
      overdue: true,
      overdueSince: new Date(input.lastOkAt.getTime() + maxAgeMs),
      reason: "Last usable run older than 30 h",
    };
  }
  const lateIncomplete = incompleteDays.filter(
    (day) =>
      day < yesterday || (day === yesterday && parts.hour >= FORM4_DUE_HOUR_NY)
  );
  if (lateIncomplete.length > 0) {
    return {
      incompleteDays,
      newestCompleteDay,
      overdue: true,
      overdueSince: new Date(
        nyWallTimeUtcMs(parts.utcDayNum, FORM4_DUE_HOUR_NY, 0)
      ),
      reason: sanitizeReason(
        `Form 4 index incomplete for ${lateIncomplete.slice(0, 3).join(", ")}`
      ),
    };
  }
  if (!input.days.some((day) => day.complete && day.indexDay >= weekAgo)) {
    return {
      incompleteDays,
      newestCompleteDay,
      overdue: true,
      overdueSince: null,
      reason: "No complete Form 4 index day in the last 7 days",
    };
  }
  return {
    incompleteDays,
    newestCompleteDay,
    overdue: false,
    overdueSince: null,
    reason: null,
  };
};

export type OverdueJobRunInput = Readonly<{
  job: string;
  latest: Readonly<{
    error: string | null;
    finishedAt: Date;
    status: string;
  }> | null;
  latestUsable: Readonly<{
    finishedAt: Date;
    status: string;
  }> | null;
}>;

export type OverdueMarketPremiumSessionInput = Readonly<{
  capturedAt: Date | null;
  lastAttemptAt: Date | null;
  lastMessage: string | null;
  sessionDate: string;
  status: string;
}>;

export type OverdueFlowSampleInput = Readonly<{
  at: Date;
  message: string | null;
  source: string;
  status: string;
}>;

export type EvaluateOpenbbSourcesInput = Readonly<{
  flow?: Readonly<{
    marketPremiumSessions: readonly OverdueMarketPremiumSessionInput[];
    samples?: Readonly<{
      latest: readonly OverdueFlowSampleInput[];
      latestOk: readonly OverdueFlowSampleInput[];
    }>;
  }>;
  form4Days: readonly Form4IndexDaySummary[];
  now: Date;
  runs: readonly OverdueJobRunInput[];
  shortVolumeNewestDate: string | null;
}>;

export type OpenbbSourcesEvaluation = Readonly<{
  clearableKeys: string[];
  monitoredKeys: string[];
  overdueMonitored: OpenbbSourceStatus[];
  sources: OpenbbSourceStatus[];
}>;

const parseIsoUtcDay = (iso: string): number =>
  utcDay(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10))
  );

const isCapturedNearClose = (
  capturedAt: Date,
  sessionDate: string
): boolean => {
  const sessionDay = parseIsoUtcDay(sessionDate);
  const clearCutoffMs = nyWallTimeUtcMs(
    sessionDay,
    Math.floor(MARKET_PREMIUM_CLEAR_MINUTE / 60),
    MARKET_PREMIUM_CLEAR_MINUTE % 60
  );
  return capturedAt.getTime() >= clearCutoffMs;
};

const withBlockedDetail = (
  baseReason: string,
  latest: OverdueJobRunInput["latest"]
): string =>
  latest?.status === "blocked_upstream" && latest.error !== null
    ? sanitizeReason(`${baseReason} (blocked upstream: ${latest.error})`)
    : sanitizeReason(baseReason);

/**
 * Evaluates every OpenBB job (all 23 in OPENBB_JOBS) and QuantVPS flow sources when supplied.
 * Returns `sources` (for `openbb.status`) plus `monitoredKeys`, `overdueMonitored`, and
 * `clearableKeys` (for the 23-source QuantVPS overdue alert monitor).
 */
const checkFinraShortVolume = (
  parts: NyParts,
  shortVolumeNewestDate: string | null,
  latest: OverdueJobRunInput["latest"]
): Readonly<{
  overdue: boolean;
  overdueSince: Date | null;
  reason: string | null;
}> => {
  if (!isNyseTradingDay(parts.utcDayNum) || parts.hour < FINRA_DUE_HOUR_NY)
    return { overdue: false, overdueSince: null, reason: null };
  const expectedDay = previousNyseTradingDay(parts.utcDayNum);
  const dueAt = new Date(
    nyWallTimeUtcMs(parts.utcDayNum, FINRA_DUE_HOUR_NY, 0)
  );
  if (shortVolumeNewestDate === null) {
    return {
      overdue: true,
      overdueSince: dueAt,
      reason: withBlockedDetail(
        `No short volume rows stored yet (expected ${expectedDay})`,
        latest
      ),
    };
  }
  if (shortVolumeNewestDate < expectedDay) {
    return {
      overdue: true,
      overdueSince: dueAt,
      reason: withBlockedDetail(
        `Short volume newest date ${shortVolumeNewestDate} behind ${expectedDay}`,
        latest
      ),
    };
  }
  return { overdue: false, overdueSince: null, reason: null };
};

const evaluateOpenbbJobAge = (
  job: (typeof OPENBB_JOBS)[number],
  lastOkAt: Date | null,
  latest: OverdueJobRunInput["latest"],
  input: EvaluateOpenbbSourcesInput,
  parts: NyParts
): Readonly<{
  overdue: boolean;
  overdueSince: Date | null;
  reason: string | null;
}> => {
  const meta = OPENBB_JOB_METADATA[job];
  if (meta.schedule === "retired" || meta.maxAgeHours === null)
    return { overdue: false, overdueSince: null, reason: null };
  const maxAgeMs = meta.maxAgeHours * HOUR_MS;
  if (job === "sec-form4") {
    const form4 = evaluateForm4Overdue({
      days: input.form4Days,
      lastOkAt,
      now: input.now,
    });
    return {
      overdue: form4.overdue,
      overdueSince: form4.overdueSince,
      reason:
        form4.reason === null ? null : withBlockedDetail(form4.reason, latest),
    };
  }
  if (lastOkAt === null) {
    return {
      overdue: true,
      overdueSince: null,
      reason: withBlockedDetail("No usable run recorded yet", latest),
    };
  }
  if (meta.schedule === "trading-day") {
    if (elapsedTradingDayMs(lastOkAt, input.now) > maxAgeMs) {
      return {
        overdue: true,
        overdueSince: tradingDayDeadline(lastOkAt, maxAgeMs),
        reason: withBlockedDetail(
          `Last usable run older than ${meta.maxAgeHours} trading-day h`,
          latest
        ),
      };
    }
  } else if (input.now.getTime() - lastOkAt.getTime() > maxAgeMs) {
    return {
      overdue: true,
      overdueSince: new Date(lastOkAt.getTime() + maxAgeMs),
      reason: withBlockedDetail(
        `Last usable run older than ${meta.maxAgeHours} h`,
        latest
      ),
    };
  }
  if (job === "finra-short-volume")
    return checkFinraShortVolume(parts, input.shortVolumeNewestDate, latest);
  return { overdue: false, overdueSince: null, reason: null };
};

const evaluateMarketPremiumSource = (
  sessions: readonly OverdueMarketPremiumSessionInput[],
  now: Date,
  parts: NyParts
): Readonly<{ clearable: boolean; entry: OpenbbSourceStatus }> => {
  const meta = FLOW_SOURCE_METADATA.market_premium;
  const limitMs = meta.maxAgeSeconds * 1000;
  const sorted = [...sessions].sort((a, b) =>
    b.sessionDate.localeCompare(a.sessionDate)
  );
  const todaySession = sorted.find((s) => s.sessionDate === parts.isoDate);
  const newestSession = sorted.find((s) => s.sessionDate <= parts.isoDate);
  const newestWithCapture = sorted.find(
    (s) => s.sessionDate <= parts.isoDate && s.capturedAt !== null
  );
  const inSession = isMarketPremiumSessionOpen(now);
  let overdue = false;
  let overdueSince: Date | null = null;
  let reason: string | null = null;
  let clearable = false;

  if (inSession) {
    const openMs = nyWallTimeUtcMs(parts.utcDayNum, 9, 30);
    const capturedAt = todaySession?.capturedAt ?? null;
    const deadlineMs =
      capturedAt === null ? openMs + limitMs : capturedAt.getTime() + limitMs;
    if (now.getTime() >= deadlineMs) {
      overdue = true;
      overdueSince = new Date(deadlineMs);
      const msg = todaySession?.lastMessage;
      const detail = msg === null || msg === undefined ? "" : ` (${msg})`;
      reason = sanitizeReason(
        capturedAt === null
          ? `No intraday market premium capture yet today${detail}`
          : `Intraday market premium capture older than 30 min${detail}`
      );
    } else {
      clearable = capturedAt !== null;
    }
  } else if (newestSession !== undefined) {
    clearable =
      newestSession.status === "complete" ||
      (newestSession.capturedAt !== null &&
        isCapturedNearClose(
          newestSession.capturedAt,
          newestSession.sessionDate
        ));
  }

  return {
    clearable,
    entry: {
      kind: "flow",
      label: meta.label,
      lastOkAt: newestWithCapture?.capturedAt ?? null,
      lastRunAt:
        newestSession?.lastAttemptAt ?? newestWithCapture?.capturedAt ?? null,
      lastStatus: newestSession?.status ?? null,
      maxAgeSeconds: meta.maxAgeSeconds,
      overdue,
      overdueSince,
      reason,
      retired: false,
      smartMoney: meta.smartMoney,
      source: "market_premium",
    },
  };
};

const evaluateFlowSampleSource = (
  source: Exclude<FlowSource, "market_premium">,
  samples: Readonly<{
    latest: readonly OverdueFlowSampleInput[];
    latestOk: readonly OverdueFlowSampleInput[];
  }>,
  now: Date
): OpenbbSourceStatus => {
  const meta = FLOW_SOURCE_METADATA[source];
  const latest = samples.latest.find((s) => s.source === source) ?? null;
  const latestOk = samples.latestOk.find((s) => s.source === source) ?? null;
  const open = isFlowSourceSessionOpen(source, now);
  const limitMs = meta.maxAgeSeconds * 1000;
  let overdue = false;
  let overdueSince: Date | null = null;
  let reason: string | null = null;
  if (open) {
    if (latestOk === null) {
      overdue = true;
      reason = "No ok SPY flow sample stored yet";
    } else if (now.getTime() - latestOk.at.getTime() > limitMs) {
      overdue = true;
      overdueSince = new Date(latestOk.at.getTime() + limitMs);
      const msg = latest?.message;
      reason = sanitizeReason(
        msg === null || msg === undefined
          ? `SPY flow sample older than ${meta.maxAgeSeconds} s`
          : `SPY flow sample older than ${meta.maxAgeSeconds} s (${msg})`
      );
    }
  }
  return {
    kind: "flow",
    label: meta.label,
    lastOkAt: latestOk?.at ?? null,
    lastRunAt: latest?.at ?? null,
    lastStatus: latest?.status ?? null,
    maxAgeSeconds: meta.maxAgeSeconds,
    overdue,
    overdueSince,
    reason,
    retired: false,
    smartMoney: meta.smartMoney,
    source,
  };
};

const appendFlowSources = (
  flow: NonNullable<EvaluateOpenbbSourcesInput["flow"]>,
  now: Date,
  parts: NyParts,
  sources: OpenbbSourceStatus[],
  monitoredKeys: string[],
  overdueMonitored: OpenbbSourceStatus[],
  clearableKeys: string[]
): void => {
  const mp = evaluateMarketPremiumSource(
    flow.marketPremiumSessions,
    now,
    parts
  );
  sources.push(mp.entry);
  const mpKey = sourceKeyOf(mp.entry);
  monitoredKeys.push(mpKey);
  if (mp.entry.overdue) overdueMonitored.push(mp.entry);
  else if (mp.clearable) clearableKeys.push(mpKey);
  if (flow.samples === undefined) return;
  for (const source of NON_PREMIUM_FLOW_SOURCES) {
    sources.push(evaluateFlowSampleSource(source, flow.samples, now));
  }
};

export const evaluateOpenbbSources = (
  input: EvaluateOpenbbSourcesInput
): OpenbbSourcesEvaluation => {
  const parts = nyParts(input.now);
  const runsByJob = new Map(input.runs.map((entry) => [entry.job, entry]));
  const sources: OpenbbSourceStatus[] = [];
  const monitoredKeys: string[] = [];
  const overdueMonitored: OpenbbSourceStatus[] = [];
  const clearableKeys: string[] = [];

  for (const job of OPENBB_JOBS) {
    const meta = OPENBB_JOB_METADATA[job];
    const run = runsByJob.get(job);
    const latest = run?.latest ?? null;
    const lastOkAt = run?.latestUsable?.finishedAt ?? null;
    const retired = meta.schedule === "retired";
    const status = evaluateOpenbbJobAge(job, lastOkAt, latest, input, parts);
    const entry: OpenbbSourceStatus = {
      kind: "openbb",
      label: meta.label,
      lastOkAt,
      lastRunAt: latest?.finishedAt ?? null,
      lastStatus: latest?.status ?? null,
      maxAgeSeconds: meta.maxAgeHours === null ? null : meta.maxAgeHours * 3600,
      overdue: status.overdue,
      overdueSince: status.overdueSince,
      reason: status.reason,
      retired,
      smartMoney: meta.smartMoney,
      source: job,
    };
    sources.push(entry);
    if (!retired) {
      const key = sourceKeyOf(entry);
      monitoredKeys.push(key);
      if (status.overdue) overdueMonitored.push(entry);
      else clearableKeys.push(key);
    }
  }

  if (input.flow !== undefined) {
    appendFlowSources(
      input.flow,
      input.now,
      parts,
      sources,
      monitoredKeys,
      overdueMonitored,
      clearableKeys
    );
  }

  return { clearableKeys, monitoredKeys, overdueMonitored, sources };
};

export type OpenbbOverduePlannedAlert = Readonly<{
  body: string;
  kind: "alert" | "recovery";
  title: string;
}>;

export type OpenbbOverdueDiff =
  | Readonly<{
      action: "alert" | "recovery";
      alert: OpenbbOverduePlannedAlert;
      idempotencySource: string;
      newlyOverdue: OpenbbSourceStatus[];
      nextActiveKeys: string[];
    }>
  | Readonly<{
      action: "noop" | "in-flight" | "prune-active" | "clear-pending";
      alert: null;
      idempotencySource: null;
      newlyOverdue: OpenbbSourceStatus[];
      nextActiveKeys: string[];
    }>;

const formatOverdueItem = (item: OpenbbSourceStatus): string => {
  const since =
    item.overdueSince === null
      ? "no usable run"
      : `since ${item.overdueSince.toISOString().slice(0, 16)}Z`;
  return `${item.source} (${since})`;
};

/** Formats one consolidated ASCII-only alert message (title <= 120 B, body <= 1000 B). */
export const formatOverdueAlertMessage = (
  newlyOverdue: readonly OpenbbSourceStatus[],
  totalOverdue: number,
  monitoredCount: number
): Readonly<{ body: string; title: string }> => {
  const count = newlyOverdue.length;
  const noun = count === 1 ? "source" : "sources";
  const title = `Vertex: ${count} data ${noun} overdue`;
  const listed = newlyOverdue
    .slice(0, OPENBB_OVERDUE_MAX_LISTED_ITEMS)
    .map(formatOverdueItem);
  const overflow = count - listed.length;
  if (overflow > 0) listed.push(`+${overflow} more`);
  const body = `${listed.join(", ")}. Total overdue: ${totalOverdue}/${monitoredCount}. Check openbb_status or /smart-money.`;
  return { body, title };
};

/** Formats one ASCII-only full-recovery message (title <= 120 B, body <= 400 B). */
export const formatOverdueRecoveryMessage = (
  recoveredCount: number,
  monitoredCount: number
): Readonly<{ body: string; title: string }> => ({
  body: `All ${monitoredCount} monitored OpenBB and Smart Money sources are current again (${recoveredCount} recovered).`,
  title: "Vertex: all monitored data sources current again",
});

const sameStringSet = (
  left: readonly string[],
  right: readonly string[]
): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
};

/**
 * Exhaustive 5-way incident transition (+ 60 s in-flight lease guard), mirroring price-freshness.
 * `idempotencySource` anchors on `lastTransitionAt` so retries of an uncommitted event keep the
 * same key while a new same-day incident after recovery gets a fresh ntfy idempotency key.
 */
export const diffOverdueIncident = (
  input: Readonly<{
    activeKeys: readonly string[];
    clearableKeys: readonly string[];
    lastTransitionAt: Date | null;
    monitoredKeys: readonly string[];
    now: Date;
    overdue: readonly OpenbbSourceStatus[];
    pendingEventId: string | null;
    updatedAt: Date | null;
  }>
): OpenbbOverdueDiff => {
  if (
    input.pendingEventId !== null &&
    input.updatedAt !== null &&
    input.now.getTime() - input.updatedAt.getTime() <
      OPENBB_OVERDUE_IN_FLIGHT_LEASE_MS
  ) {
    return {
      action: "in-flight",
      alert: null,
      idempotencySource: null,
      newlyOverdue: [],
      nextActiveKeys: [...input.activeKeys].sort(),
    };
  }

  const activeSet = new Set(input.activeKeys);
  const clearableSet = new Set(input.clearableKeys);
  const monitoredSet = new Set(input.monitoredKeys);
  const overdueKeys = input.overdue.map(sourceKeyOf);
  const retainedActive = input.activeKeys.filter(
    (key) => monitoredSet.has(key) && !clearableSet.has(key)
  );
  const newlyOverdue = input.overdue.filter(
    (item) => !activeSet.has(sourceKeyOf(item))
  );
  const nextActiveKeys = [
    ...new Set([...retainedActive, ...overdueKeys]),
  ].sort();
  const anchor = input.lastTransitionAt?.toISOString() ?? "init";

  if (newlyOverdue.length > 0) {
    const message = formatOverdueAlertMessage(
      newlyOverdue,
      input.overdue.length,
      input.monitoredKeys.length
    );
    return {
      action: "alert",
      alert: { ...message, kind: "alert" },
      idempotencySource: `openbb-overdue:alert:${anchor}:${nextActiveKeys.join(",")}`,
      newlyOverdue,
      nextActiveKeys,
    };
  }

  if (nextActiveKeys.length === 0 && input.activeKeys.length > 0) {
    const sortedPrev = [...input.activeKeys].sort();
    const message = formatOverdueRecoveryMessage(
      sortedPrev.length,
      input.monitoredKeys.length
    );
    return {
      action: "recovery",
      alert: { ...message, kind: "recovery" },
      idempotencySource: `openbb-overdue:recovery:${anchor}:${sortedPrev.join(",")}`,
      newlyOverdue: [],
      nextActiveKeys: [],
    };
  }

  if (!sameStringSet(nextActiveKeys, input.activeKeys)) {
    return {
      action: "prune-active",
      alert: null,
      idempotencySource: null,
      newlyOverdue: [],
      nextActiveKeys,
    };
  }

  if (input.pendingEventId !== null) {
    return {
      action: "clear-pending",
      alert: null,
      idempotencySource: null,
      newlyOverdue: [],
      nextActiveKeys,
    };
  }

  return {
    action: "noop",
    alert: null,
    idempotencySource: null,
    newlyOverdue: [],
    nextActiveKeys,
  };
};
