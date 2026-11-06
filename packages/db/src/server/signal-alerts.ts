import { and, asc, count, desc, eq, gt, inArray, sql } from "drizzle-orm";

import {
  type SignalAlertDeliveryValue,
  type SignalAlertFrequencyValue,
  type SignalAlertKindValue,
  type SignalAlertOriginValue,
  type SignalAlertRuleRow,
  type SignalAlertStatusValue,
  type SignalAlertTimeframeValue,
  signalAlertEvents,
  signalAlertRules,
  users,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Owner signal alerts and watches (priceAlerts.signals.*). Every owner query is scoped by user id.
// The condition document is validated by the oRPC contract before it is stored and again when it is
// read for evaluation. A fire inserts one event per (rule, bar) (a concurrent check and tick cannot
// both record the same bar) and only then moves the rule's counters; a "once" rule moves to done
// with its fire. Status changes require the expected current status. Research only: no order path.

/** Rules (any status) one owner may keep. */
export const SIGNAL_ALERT_RULES_PER_USER_MAX = 50;

export type SignalAlertRuleRecord = Readonly<{
  id: string;
  userId: string;
  kind: SignalAlertKindValue;
  origin: SignalAlertOriginValue;
  name: string;
  symbol: string;
  timeframe: SignalAlertTimeframeValue;
  condition: Readonly<Record<string, unknown>>;
  frequency: SignalAlertFrequencyValue;
  status: SignalAlertStatusValue;
  lastCheckedAt: Date | null;
  lastBarAt: Date | null;
  lastFiredBarAt: Date | null;
  lastFiredAt: Date | null;
  fireCount: number;
  createdAt: Date;
}>;

export type SignalAlertRuleCreateInput = Readonly<{
  userId: string;
  kind: SignalAlertKindValue;
  origin: SignalAlertOriginValue;
  name: string;
  symbol: string;
  timeframe: SignalAlertTimeframeValue;
  condition: Readonly<Record<string, unknown>>;
  frequency: SignalAlertFrequencyValue;
  status: Extract<SignalAlertStatusValue, "proposed" | "active">;
}>;

export type SignalAlertFireInput = Readonly<{
  ruleId: string;
  userId: string;
  barAt: Date;
  price: string;
  firedAt: Date;
  /** "once" rules move to done with their fire. */
  done: boolean;
}>;

export type SignalAlertEventRecord = Readonly<{
  id: string;
  ruleId: string;
  userId: string;
  name: string;
  symbol: string;
  kind: SignalAlertKindValue;
  barAt: Date;
  price: string;
  delivery: SignalAlertDeliveryValue;
  firedAt: Date;
}>;

export type SignalAlertRepository = Readonly<{
  listByUser: (userId: string) => Promise<SignalAlertRuleRecord[]>;
  listActiveByUser: (userId: string) => Promise<SignalAlertRuleRecord[]>;
  /** Active rules of owners who are still operators, least recently attempted first. */
  listActive: (
    limit: number,
    operatorEmails: readonly string[] | undefined
  ) => Promise<SignalAlertRuleRecord[]>;
  create: (input: SignalAlertRuleCreateInput) => Promise<SignalAlertRuleRecord>;
  /** Moves a rule from one of `from` to `to`; null when it is gone or in another status. */
  transition: (
    id: string,
    userId: string,
    from: readonly SignalAlertStatusValue[],
    to: SignalAlertStatusValue
  ) => Promise<SignalAlertRuleRecord | null>;
  remove: (id: string, userId: string) => Promise<boolean>;
  /** Records an evaluation: the newest closed bar seen and the check time. */
  markChecked: (
    id: string,
    lastBarAt: Date | null,
    checkedAt: Date
  ) => Promise<void>;
  /** Moves active rules to the back of the queue without moving their cursor. */
  markAttempted: (ids: readonly string[]) => Promise<void>;
  /** Inserts the fire event once per (rule, bar); null when that bar already fired or the rule is not active. */
  recordFire: (
    input: SignalAlertFireInput
  ) => Promise<SignalAlertEventRecord | null>;
  recordDelivery: (
    eventIds: readonly string[],
    delivery: Exclude<SignalAlertDeliveryValue, "pending">
  ) => Promise<void>;
  listEvents: (
    userId: string,
    since: Date | null,
    limit: number
  ) => Promise<SignalAlertEventRecord[]>;
}>;

export class SignalAlertLimitError extends Error {
  constructor() {
    super(
      `An owner may keep at most ${SIGNAL_ALERT_RULES_PER_USER_MAX} signal alerts and watches`
    );
    this.name = "SignalAlertLimitError";
  }
}

export const signalAlertRecordOf = (
  row: SignalAlertRuleRow
): SignalAlertRuleRecord => ({
  condition: row.condition,
  createdAt: row.createdAt,
  fireCount: row.fireCount,
  frequency: row.frequency,
  id: row.id,
  kind: row.kind,
  lastBarAt: row.lastBarAt,
  lastCheckedAt: row.lastCheckedAt,
  lastFiredAt: row.lastFiredAt,
  lastFiredBarAt: row.lastFiredBarAt,
  name: row.name,
  origin: row.origin,
  status: row.status,
  symbol: row.symbol,
  timeframe: row.timeframe,
  userId: row.userId,
});

export type SignalAlertRepositoryDependencies = Readonly<{
  now: () => Date;
  generateId: () => string;
}>;

const eventColumns = {
  barAt: signalAlertEvents.barAt,
  delivery: signalAlertEvents.delivery,
  firedAt: signalAlertEvents.firedAt,
  id: signalAlertEvents.id,
  kind: signalAlertRules.kind,
  name: signalAlertRules.name,
  price: signalAlertEvents.price,
  ruleId: signalAlertEvents.ruleId,
  symbol: signalAlertRules.symbol,
  userId: signalAlertEvents.userId,
};

export const createSignalAlertRepository = (
  database: DatabaseExecutor,
  dependencies: SignalAlertRepositoryDependencies
): SignalAlertRepository => {
  const active = eq(signalAlertRules.status, "active");
  const owned = (id: string, userId: string) =>
    and(eq(signalAlertRules.id, id), eq(signalAlertRules.userId, userId));
  return {
    create: async (input) => {
      const [existing] = await database
        .select({ rules: count() })
        .from(signalAlertRules)
        .where(eq(signalAlertRules.userId, input.userId));
      if ((existing?.rules ?? 0) >= SIGNAL_ALERT_RULES_PER_USER_MAX)
        throw new SignalAlertLimitError();
      const timestamp = dependencies.now();
      const [row] = await database
        .insert(signalAlertRules)
        .values({
          condition: { ...input.condition },
          createdAt: timestamp,
          frequency: input.frequency,
          id: dependencies.generateId(),
          kind: input.kind,
          name: input.name,
          origin: input.origin,
          status: input.status,
          symbol: input.symbol,
          timeframe: input.timeframe,
          updatedAt: timestamp,
          userId: input.userId,
        })
        .returning();
      if (row === undefined)
        throw new Error("signal alert insert returned no row");
      return signalAlertRecordOf(row);
    },

    listActive: async (limit, operatorEmails) => {
      const emails = [
        ...new Set(
          (operatorEmails ?? [])
            .map((email) => email.trim().toLowerCase())
            .filter((email) => email.length > 0)
        ),
      ];
      if (emails.length === 0) return [];
      const operatorOwner = sql`${signalAlertRules.userId} in (select ${users.id} from ${users} where ${users.status} = 'active' and ${users.emailVerified} = true and lower(${users.email}) in (${sql.join(
        emails.map((email) => sql`${email}`),
        sql`, `
      )}))`;
      const rows = await database
        .select()
        .from(signalAlertRules)
        .where(and(active, operatorOwner))
        .orderBy(asc(signalAlertRules.updatedAt), asc(signalAlertRules.id))
        .limit(limit);
      return rows.map(signalAlertRecordOf);
    },

    listActiveByUser: async (userId) => {
      const rows = await database
        .select()
        .from(signalAlertRules)
        .where(and(eq(signalAlertRules.userId, userId), active))
        .orderBy(asc(signalAlertRules.updatedAt), asc(signalAlertRules.id))
        .limit(SIGNAL_ALERT_RULES_PER_USER_MAX);
      return rows.map(signalAlertRecordOf);
    },

    listByUser: async (userId) => {
      const rows = await database
        .select()
        .from(signalAlertRules)
        .where(eq(signalAlertRules.userId, userId))
        .orderBy(desc(signalAlertRules.createdAt), asc(signalAlertRules.id))
        .limit(SIGNAL_ALERT_RULES_PER_USER_MAX);
      return rows.map(signalAlertRecordOf);
    },

    listEvents: async (userId, since, limit) => {
      const rows = await database
        .select(eventColumns)
        .from(signalAlertEvents)
        .innerJoin(
          signalAlertRules,
          eq(signalAlertRules.id, signalAlertEvents.ruleId)
        )
        .where(
          since === null
            ? eq(signalAlertEvents.userId, userId)
            : and(
                eq(signalAlertEvents.userId, userId),
                gt(signalAlertEvents.firedAt, since)
              )
        )
        .orderBy(desc(signalAlertEvents.firedAt), asc(signalAlertEvents.id))
        .limit(limit);
      return rows;
    },

    markAttempted: async (ids) => {
      if (ids.length === 0) return;
      await database
        .update(signalAlertRules)
        .set({ updatedAt: dependencies.now() })
        .where(and(inArray(signalAlertRules.id, [...ids]), active));
    },

    markChecked: async (id, lastBarAt, checkedAt) => {
      await database
        .update(signalAlertRules)
        .set({
          lastBarAt,
          lastCheckedAt: checkedAt,
          updatedAt: dependencies.now(),
        })
        .where(and(eq(signalAlertRules.id, id), active));
    },

    recordDelivery: async (eventIds, delivery) => {
      if (eventIds.length === 0) return;
      await database
        .update(signalAlertEvents)
        .set({ delivery })
        .where(
          and(
            inArray(signalAlertEvents.id, [...eventIds]),
            eq(signalAlertEvents.delivery, "pending")
          )
        );
    },

    recordFire: async (input) => {
      const [rule] = await database
        .select()
        .from(signalAlertRules)
        .where(and(owned(input.ruleId, input.userId), active));
      if (rule === undefined) return null;
      const [event] = await database
        .insert(signalAlertEvents)
        .values({
          barAt: input.barAt,
          delivery: "pending",
          firedAt: input.firedAt,
          id: dependencies.generateId(),
          price: input.price,
          ruleId: input.ruleId,
          userId: input.userId,
        })
        .onConflictDoNothing({
          target: [signalAlertEvents.ruleId, signalAlertEvents.barAt],
        })
        .returning();
      if (event === undefined) return null;
      await database
        .update(signalAlertRules)
        .set({
          fireCount: sql`${signalAlertRules.fireCount} + 1`,
          lastFiredAt: input.firedAt,
          lastFiredBarAt: input.barAt,
          updatedAt: dependencies.now(),
          ...(input.done ? { status: "done" as const } : {}),
        })
        .where(eq(signalAlertRules.id, input.ruleId));
      return {
        barAt: event.barAt,
        delivery: event.delivery,
        firedAt: event.firedAt,
        id: event.id,
        kind: rule.kind,
        name: rule.name,
        price: event.price,
        ruleId: event.ruleId,
        symbol: rule.symbol,
        userId: event.userId,
      };
    },

    remove: async (id, userId) => {
      const removed = await database
        .delete(signalAlertRules)
        .where(owned(id, userId))
        .returning({ id: signalAlertRules.id });
      return removed.length > 0;
    },

    transition: async (id, userId, from, to) => {
      if (from.length === 0) return null;
      const [row] = await database
        .update(signalAlertRules)
        .set({ status: to, updatedAt: dependencies.now() })
        .where(
          and(owned(id, userId), inArray(signalAlertRules.status, [...from]))
        )
        .returning();
      return row === undefined ? null : signalAlertRecordOf(row);
    },
  };
};
