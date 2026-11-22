import { eq, type SQL, sql } from "drizzle-orm";

import {
  type OpenbbFreshnessKind,
  type OpenbbFreshnessPersistedDelivery,
  openbbFreshnessState,
} from "../schema/openbb-freshness.ts";
import type { DatabaseExecutor } from "./client.ts";

// Durable per-monitor freshness state and delivery-outbox repository (card
// vertex-price-freshness-alert; research data alerting only, no orders). Serializes every
// transition on a monitor with a transaction-scoped advisory lock so overlapping ticks never
// double-stage or double-commit.

const MONITOR_PATTERN = /^[a-z0-9-]{1,40}$/u;

const lockMonitor = (monitor: string): SQL =>
  sql`select pg_advisory_xact_lock(hashtextextended('price_freshness_state:' || ${monitor}, 0))`;

const assertMonitor = (monitor: string): void => {
  if (!MONITOR_PATTERN.test(monitor))
    throw new Error(`Invalid freshness monitor: ${monitor}`);
};

export type OpenbbFreshnessState = Readonly<{
  activeKeys: string[];
  lastTransitionAt: Date | null;
  monitor: string;
  pendingDelivery: OpenbbFreshnessPersistedDelivery | null;
  pendingEventId: string | null;
  pendingKeys: string[];
  pendingKind: OpenbbFreshnessKind | null;
  updatedAt: Date;
}>;

export type OpenbbFreshnessDeliveryOutcome =
  | "sent"
  | "not-configured"
  | "failed";

export type OpenbbFreshnessStageDecision =
  | Readonly<{ kind: "noop" }>
  | Readonly<{ kind: "in-flight" }>
  | Readonly<{ activeKeys: readonly string[]; kind: "prune-active" }>
  | Readonly<{ kind: "clear-pending" }>
  | Readonly<{
      eventId: string;
      kind: "stage-pending";
      pendingKeys: readonly string[];
      pendingKind: OpenbbFreshnessKind;
    }>;

export type OpenbbFreshnessStageResult =
  | Readonly<{
      activeKeys: string[];
      kind: "noop" | "in-flight" | "prune-active" | "clear-pending";
    }>
  | Readonly<{
      activeKeys: string[];
      eventId: string;
      kind: "stage-pending";
      pendingKeys: string[];
      pendingKind: OpenbbFreshnessKind;
    }>;

export type OpenbbFreshnessRepository = Readonly<{
  getFreshnessState: (monitor: string) => Promise<OpenbbFreshnessState | null>;
  stageFreshnessTransition: (
    monitor: string,
    decide: (
      current: OpenbbFreshnessState | null
    ) => OpenbbFreshnessStageDecision,
    now: Date
  ) => Promise<OpenbbFreshnessStageResult>;
  completeFreshnessDelivery: (
    monitor: string,
    eventId: string,
    delivery: OpenbbFreshnessDeliveryOutcome,
    now: Date
  ) => Promise<boolean>;
}>;

const readState = async (
  executor: DatabaseExecutor,
  monitor: string
): Promise<OpenbbFreshnessState | null> => {
  const [row] = await executor
    .select()
    .from(openbbFreshnessState)
    .where(eq(openbbFreshnessState.monitor, monitor));
  if (row === undefined) return null;
  return {
    activeKeys: [...row.activeKeys],
    lastTransitionAt: row.lastTransitionAt,
    monitor: row.monitor,
    pendingDelivery: row.pendingDelivery,
    pendingEventId: row.pendingEventId,
    pendingKeys: [...row.pendingKeys],
    pendingKind: row.pendingKind,
    updatedAt: row.updatedAt,
  };
};

export const createOpenbbFreshnessRepository = (
  database: DatabaseExecutor
): OpenbbFreshnessRepository => ({
  completeFreshnessDelivery: async (monitor, eventId, delivery, now) => {
    assertMonitor(monitor);
    return await database.transaction(async (tx) => {
      await tx.execute(lockMonitor(monitor));
      const current = await readState(tx, monitor);
      if (current === null || current.pendingEventId !== eventId) return false;
      if (delivery === "sent") {
        await tx
          .update(openbbFreshnessState)
          .set({
            activeKeys: [...current.pendingKeys],
            lastTransitionAt: now,
            pendingDelivery: null,
            pendingEventId: null,
            pendingKeys: [],
            pendingKind: null,
            updatedAt: now,
          })
          .where(eq(openbbFreshnessState.monitor, monitor));
        return true;
      }
      await tx
        .update(openbbFreshnessState)
        .set({
          pendingDelivery: delivery,
          updatedAt: now,
        })
        .where(eq(openbbFreshnessState.monitor, monitor));
      return true;
    });
  },
  getFreshnessState: async (monitor) => {
    assertMonitor(monitor);
    return await readState(database, monitor);
  },
  stageFreshnessTransition: async (monitor, decide, now) => {
    assertMonitor(monitor);
    return await database.transaction(async (tx) => {
      await tx.execute(lockMonitor(monitor));
      const current = await readState(tx, monitor);
      const decision = decide(current);
      const currentActive = current === null ? [] : [...current.activeKeys];
      if (decision.kind === "noop" || decision.kind === "in-flight") {
        return { activeKeys: currentActive, kind: decision.kind };
      }
      if (decision.kind === "prune-active") {
        const activeKeys = [...decision.activeKeys];
        await tx
          .insert(openbbFreshnessState)
          .values({
            activeKeys,
            lastTransitionAt: now,
            monitor,
            pendingDelivery: null,
            pendingEventId: null,
            pendingKeys: [],
            pendingKind: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            set: {
              activeKeys,
              lastTransitionAt: now,
              pendingDelivery: null,
              pendingEventId: null,
              pendingKeys: [],
              pendingKind: null,
              updatedAt: now,
            },
            target: openbbFreshnessState.monitor,
          });
        return { activeKeys, kind: "prune-active" };
      }
      if (decision.kind === "clear-pending") {
        await tx
          .insert(openbbFreshnessState)
          .values({
            activeKeys: currentActive,
            lastTransitionAt: current?.lastTransitionAt ?? null,
            monitor,
            pendingDelivery: null,
            pendingEventId: null,
            pendingKeys: [],
            pendingKind: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            set: {
              pendingDelivery: null,
              pendingEventId: null,
              pendingKeys: [],
              pendingKind: null,
              updatedAt: now,
            },
            target: openbbFreshnessState.monitor,
          });
        return { activeKeys: currentActive, kind: "clear-pending" };
      }
      const pendingKeys = [...decision.pendingKeys];
      await tx
        .insert(openbbFreshnessState)
        .values({
          activeKeys: currentActive,
          lastTransitionAt: current?.lastTransitionAt ?? null,
          monitor,
          pendingDelivery: "pending",
          pendingEventId: decision.eventId,
          pendingKeys,
          pendingKind: decision.pendingKind,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          set: {
            pendingDelivery: "pending",
            pendingEventId: decision.eventId,
            pendingKeys,
            pendingKind: decision.pendingKind,
            updatedAt: now,
          },
          target: openbbFreshnessState.monitor,
        });
      return {
        activeKeys: currentActive,
        eventId: decision.eventId,
        kind: "stage-pending",
        pendingKeys,
        pendingKind: decision.pendingKind,
      };
    });
  },
});
