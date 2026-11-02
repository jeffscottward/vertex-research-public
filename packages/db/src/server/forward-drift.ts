import { and, desc, eq, isNull, sql } from "drizzle-orm";

import {
  type ForwardDriftCheck,
  type ForwardDriftLevel,
  type ForwardDriftLevels,
  type ForwardDriftPoint,
  type ForwardDriftThresholds,
  type ForwardDriftTrade,
  forwardDriftAlerts,
  forwardDriftMonitors,
  type PaperRunnerStatus,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Forward drift monitors and their in-app alerts. create stores an empty monitor pinned to a
// baseline backtest run; saveEvaluation writes the new paper series, the evaluated levels and the
// raised alerts in one transaction, only when the stored version still matches (optimistic lock);
// acknowledgeAlert marks an open alert once. The baseline run and revision are never updated.
// Paper data only; no order path.

export const FORWARD_DRIFT_LIST_MAX = 100;
export const FORWARD_DRIFT_ALERTS_MAX = 200;
export const FORWARD_DRIFT_MESSAGE_MAX_LENGTH = 500;

export type ForwardDriftMonitorRecord = Readonly<{
  id: string;
  label: string;
  baselineRunId: string;
  strategyRevision: string | null;
  thresholds: ForwardDriftThresholds;
  points: ForwardDriftPoint[];
  trades: ForwardDriftTrade[];
  levels: ForwardDriftLevels;
  level: ForwardDriftLevel;
  version: number;
  paperStatus: PaperRunnerStatus;
  paperNote: string | null;
  paperTickedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ForwardDriftMonitorSummaryRecord = Omit<
  ForwardDriftMonitorRecord,
  "points" | "trades"
> &
  Readonly<{ pointCount: number; tradeCount: number }>;

export type ForwardDriftAlertRecord = Readonly<{
  id: string;
  monitorId: string;
  check: ForwardDriftCheck;
  level: "warn" | "alert";
  message: string;
  forwardValue: number | null;
  baselineValue: number | null;
  ratio: number | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
}>;

export type ForwardDriftAlertInput = Pick<
  ForwardDriftAlertRecord,
  "check" | "level" | "message" | "forwardValue" | "baselineValue" | "ratio"
>;

export type ForwardDriftCreateInput = Readonly<{
  label: string;
  baselineRunId: string;
  strategyRevision: string | null;
  thresholds: ForwardDriftThresholds;
  createdBy: string;
}>;

export type ForwardDriftSaveInput = Readonly<{
  id: string;
  expectedVersion: number;
  points: ForwardDriftPoint[];
  trades: ForwardDriftTrade[];
  levels: ForwardDriftLevels;
  level: ForwardDriftLevel;
  alerts: readonly ForwardDriftAlertInput[];
}>;

export type ForwardDriftRepository = Readonly<{
  create: (
    input: ForwardDriftCreateInput
  ) => Promise<ForwardDriftMonitorRecord>;
  get: (id: string) => Promise<ForwardDriftMonitorRecord | null>;
  list: (limit: number) => Promise<ForwardDriftMonitorSummaryRecord[]>;
  /** Returns null when the monitor is missing or another recording changed it first. */
  saveEvaluation: (input: ForwardDriftSaveInput) => Promise<Readonly<{
    monitor: ForwardDriftMonitorRecord;
    alerts: ForwardDriftAlertRecord[];
  }> | null>;
  listAlerts: (
    filter: Readonly<{ monitorId?: string; openOnly: boolean; limit: number }>
  ) => Promise<ForwardDriftAlertRecord[]>;
  /** Returns null when the alert is missing or already acknowledged. */
  acknowledgeAlert: (
    id: string,
    by: string
  ) => Promise<ForwardDriftAlertRecord | null>;
  /** Starts or stops the paper runner; returns null when the monitor is missing. */
  setPaperStatus: (
    id: string,
    status: PaperRunnerStatus
  ) => Promise<ForwardDriftMonitorRecord | null>;
  /** Records the time and outcome of one paper tick. The series and version are not changed. */
  notePaperTick: (id: string, note: string | null) => Promise<void>;
  /** Ids of monitors with a running paper runner, least recently ticked first. */
  listRunningPaper: (limit: number) => Promise<string[]>;
}>;

/** Trims alert text to the stored maximum. */
export const boundDriftMessage = (message: string): string =>
  message.slice(0, FORWARD_DRIFT_MESSAGE_MAX_LENGTH);

const summaryColumns = {
  baselineRunId: forwardDriftMonitors.baselineRunId,
  createdAt: forwardDriftMonitors.createdAt,
  createdBy: forwardDriftMonitors.createdBy,
  id: forwardDriftMonitors.id,
  label: forwardDriftMonitors.label,
  level: forwardDriftMonitors.level,
  levels: forwardDriftMonitors.levels,
  paperNote: forwardDriftMonitors.paperNote,
  paperStatus: forwardDriftMonitors.paperStatus,
  paperTickedAt: forwardDriftMonitors.paperTickedAt,
  pointCount:
    sql<number>`jsonb_array_length(${forwardDriftMonitors.points})`.mapWith(
      Number
    ),
  strategyRevision: forwardDriftMonitors.strategyRevision,
  thresholds: forwardDriftMonitors.thresholds,
  tradeCount:
    sql<number>`jsonb_array_length(${forwardDriftMonitors.trades})`.mapWith(
      Number
    ),
  updatedAt: forwardDriftMonitors.updatedAt,
  version: forwardDriftMonitors.version,
};

const clamp = (limit: number, max: number): number =>
  Math.min(Math.max(Math.trunc(limit), 1), max);

export const createForwardDriftRepository = (
  database: DatabaseExecutor,
  dependencies: Readonly<{ now: () => Date; generateId: () => string }>
): ForwardDriftRepository => ({
  acknowledgeAlert: async (id, by) => {
    const [row] = await database
      .update(forwardDriftAlerts)
      .set({ acknowledgedAt: dependencies.now(), acknowledgedBy: by })
      .where(
        and(
          eq(forwardDriftAlerts.id, id),
          isNull(forwardDriftAlerts.acknowledgedAt)
        )
      )
      .returning();
    return (row as ForwardDriftAlertRecord | undefined) ?? null;
  },
  create: async (input) => {
    const now = dependencies.now();
    const [row] = await database
      .insert(forwardDriftMonitors)
      .values({
        baselineRunId: input.baselineRunId,
        createdAt: now,
        createdBy: input.createdBy,
        id: dependencies.generateId(),
        label: input.label,
        strategyRevision: input.strategyRevision,
        thresholds: input.thresholds,
        updatedAt: now,
      })
      .returning();
    return row as ForwardDriftMonitorRecord;
  },
  get: async (id) => {
    const [row] = await database
      .select()
      .from(forwardDriftMonitors)
      .where(eq(forwardDriftMonitors.id, id))
      .limit(1);
    return (row as ForwardDriftMonitorRecord | undefined) ?? null;
  },
  list: async (limit) =>
    (await database
      .select(summaryColumns)
      .from(forwardDriftMonitors)
      .orderBy(desc(forwardDriftMonitors.createdAt))
      .limit(
        clamp(limit, FORWARD_DRIFT_LIST_MAX)
      )) as ForwardDriftMonitorSummaryRecord[],
  listAlerts: async (filter) => {
    const conditions = [
      filter.monitorId === undefined
        ? undefined
        : eq(forwardDriftAlerts.monitorId, filter.monitorId),
      filter.openOnly ? isNull(forwardDriftAlerts.acknowledgedAt) : undefined,
    ];
    return (await database
      .select()
      .from(forwardDriftAlerts)
      .where(and(...conditions))
      .orderBy(desc(forwardDriftAlerts.createdAt))
      .limit(
        clamp(filter.limit, FORWARD_DRIFT_ALERTS_MAX)
      )) as ForwardDriftAlertRecord[];
  },
  listRunningPaper: async (limit) =>
    (
      await database
        .select({ id: forwardDriftMonitors.id })
        .from(forwardDriftMonitors)
        .where(eq(forwardDriftMonitors.paperStatus, "running"))
        // Least recently ticked first, so a batch limit never starves later monitors.
        .orderBy(
          sql`${forwardDriftMonitors.paperTickedAt} asc nulls first`,
          forwardDriftMonitors.createdAt
        )
        .limit(clamp(limit, FORWARD_DRIFT_LIST_MAX))
    ).map((row) => row.id),
  notePaperTick: async (id, note) => {
    await database
      .update(forwardDriftMonitors)
      .set({
        paperNote: note === null ? null : boundDriftMessage(note),
        paperTickedAt: dependencies.now(),
      })
      .where(eq(forwardDriftMonitors.id, id));
  },
  saveEvaluation: (input) =>
    database.transaction(async (tx) => {
      const now = dependencies.now();
      const [monitor] = await tx
        .update(forwardDriftMonitors)
        .set({
          level: input.level,
          levels: input.levels,
          points: input.points,
          trades: input.trades,
          updatedAt: now,
          version: input.expectedVersion + 1,
        })
        .where(
          and(
            eq(forwardDriftMonitors.id, input.id),
            eq(forwardDriftMonitors.version, input.expectedVersion)
          )
        )
        .returning();
      if (monitor === undefined) return null;
      const alerts =
        input.alerts.length === 0
          ? []
          : await tx
              .insert(forwardDriftAlerts)
              .values(
                input.alerts.map((alert) => ({
                  ...alert,
                  createdAt: now,
                  id: dependencies.generateId(),
                  message: boundDriftMessage(alert.message),
                  monitorId: input.id,
                }))
              )
              .returning();
      return {
        alerts: alerts as ForwardDriftAlertRecord[],
        monitor: monitor as ForwardDriftMonitorRecord,
      };
    }),
  setPaperStatus: async (id, status) => {
    const [row] = await database
      .update(forwardDriftMonitors)
      .set({ paperStatus: status, updatedAt: dependencies.now() })
      .where(eq(forwardDriftMonitors.id, id))
      .returning();
    return (row as ForwardDriftMonitorRecord | undefined) ?? null;
  },
});
