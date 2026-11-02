import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";

import {
  type PriceAlertDeliveryValue,
  type PriceAlertKindValue,
  type PriceAlertRoleValue,
  type PriceAlertRuleRow,
  priceAlertRules,
  users,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Owner price alert rules (priceAlerts.*). Every owner query is scoped by user id. A rule is active
// until one evaluation reaches its level; trigger moves it to triggered exactly once (the update
// requires the active state, so a concurrent check and tick cannot both win) with delivery
// "pending", and recordDelivery settles that delivery once. Inputs are validated by the oRPC
// contract; the table checks enforce the same rules. Research only: no order path.

/** Rules (active and triggered) one owner may keep. */
export const PRICE_ALERT_RULES_PER_USER_MAX = 100;

export type PriceAlertRuleState =
  | Readonly<{ status: "active"; lastCheckedAt: Date | null }>
  | Readonly<{
      status: "triggered";
      triggeredAt: Date;
      triggerPrice: string;
      delivery: PriceAlertDeliveryValue;
    }>;

export type PriceAlertRuleRecord = Readonly<{
  id: string;
  userId: string;
  symbol: string;
  kind: PriceAlertKindValue;
  role: PriceAlertRoleValue;
  level: string;
  note: string | null;
  createdAt: Date;
  state: PriceAlertRuleState;
}>;

export type PriceAlertRuleCreateInput = Readonly<{
  userId: string;
  symbol: string;
  kind: PriceAlertKindValue;
  role: PriceAlertRoleValue;
  level: string;
  note: string | null;
}>;

export type PriceAlertTriggerInput = Readonly<{
  id: string;
  triggeredAt: Date;
  triggerPrice: string;
}>;

export type PriceAlertRepository = Readonly<{
  listByUser: (userId: string) => Promise<PriceAlertRuleRecord[]>;
  /** One owner's active rules, least recently attempted first. */
  listActiveByUser: (userId: string) => Promise<PriceAlertRuleRecord[]>;
  /**
   * Active rules of owners who are still operators (active, email-verified, email on the list),
   * least recently attempted first. An absent or empty list means no owner qualifies.
   */
  listActive: (
    limit: number,
    operatorEmails: readonly string[] | undefined
  ) => Promise<PriceAlertRuleRecord[]>;
  create: (input: PriceAlertRuleCreateInput) => Promise<PriceAlertRuleRecord>;
  remove: (id: string, userId: string) => Promise<boolean>;
  markChecked: (ids: readonly string[], checkedAt: Date) => Promise<void>;
  /** Moves active rules to the back of the queue without moving their evaluation window. */
  markAttempted: (ids: readonly string[]) => Promise<void>;
  /** Active -> triggered with delivery "pending"; null when the rule is gone or already triggered. */
  trigger: (
    input: PriceAlertTriggerInput
  ) => Promise<PriceAlertRuleRecord | null>;
  /** Settles a pending delivery; returns the rules it changed. */
  recordDelivery: (
    ids: readonly string[],
    delivery: Exclude<PriceAlertDeliveryValue, "pending">
  ) => Promise<PriceAlertRuleRecord[]>;
}>;

export class PriceAlertLimitError extends Error {
  constructor() {
    super(
      `An owner may keep at most ${PRICE_ALERT_RULES_PER_USER_MAX} price alert rules`
    );
    this.name = "PriceAlertLimitError";
  }
}

/** Maps a stored row to the typed state union. A triggered row missing a trigger field is corrupt. */
export const priceAlertRecordOf = (
  row: PriceAlertRuleRow
): PriceAlertRuleRecord => {
  let state: PriceAlertRuleState;
  if (row.status === "active") {
    state = { lastCheckedAt: row.lastCheckedAt, status: "active" };
  } else if (
    row.triggeredAt !== null &&
    row.triggerPrice !== null &&
    row.delivery !== null
  ) {
    state = {
      delivery: row.delivery,
      status: "triggered",
      triggeredAt: row.triggeredAt,
      triggerPrice: row.triggerPrice,
    };
  } else {
    throw new Error("price alert rule row has an incomplete triggered state");
  }
  return {
    createdAt: row.createdAt,
    id: row.id,
    kind: row.kind,
    level: row.level,
    note: row.note,
    role: row.role,
    state,
    symbol: row.symbol,
    userId: row.userId,
  };
};

export type PriceAlertRepositoryDependencies = Readonly<{
  now: () => Date;
  generateId: () => string;
}>;

export const createPriceAlertRepository = (
  database: DatabaseExecutor,
  dependencies: PriceAlertRepositoryDependencies
): PriceAlertRepository => {
  const active = eq(priceAlertRules.status, "active");
  return {
    create: async (input) => {
      const [existing] = await database
        .select({ rules: count() })
        .from(priceAlertRules)
        .where(eq(priceAlertRules.userId, input.userId));
      if ((existing?.rules ?? 0) >= PRICE_ALERT_RULES_PER_USER_MAX)
        throw new PriceAlertLimitError();
      const timestamp = dependencies.now();
      const [row] = await database
        .insert(priceAlertRules)
        .values({
          createdAt: timestamp,
          id: dependencies.generateId(),
          kind: input.kind,
          level: input.level,
          note: input.note,
          role: input.role,
          status: "active",
          symbol: input.symbol,
          updatedAt: timestamp,
          userId: input.userId,
        })
        .returning();
      if (row === undefined)
        throw new Error("price alert insert returned no row");
      return priceAlertRecordOf(row);
    },

    // updated_at moves on every check and attempt, so ordering by it is a round robin: a rule
    // whose quote keeps failing goes to the back instead of blocking the rules behind it.
    listActive: async (limit, operatorEmails) => {
      const emails = [
        ...new Set(
          (operatorEmails ?? [])
            .map((email) => email.trim().toLowerCase())
            .filter((email) => email.length > 0)
        ),
      ];
      if (emails.length === 0) return [];
      const operatorOwner = sql`${priceAlertRules.userId} in (select ${users.id} from ${users} where ${users.status} = 'active' and ${users.emailVerified} = true and lower(${users.email}) in (${sql.join(
        emails.map((email) => sql`${email}`),
        sql`, `
      )}))`;
      const rows = await database
        .select()
        .from(priceAlertRules)
        .where(and(active, operatorOwner))
        .orderBy(asc(priceAlertRules.updatedAt), asc(priceAlertRules.id))
        .limit(limit);
      return rows.map(priceAlertRecordOf);
    },

    listActiveByUser: async (userId) => {
      const rows = await database
        .select()
        .from(priceAlertRules)
        .where(and(eq(priceAlertRules.userId, userId), active))
        .orderBy(asc(priceAlertRules.updatedAt), asc(priceAlertRules.id))
        .limit(PRICE_ALERT_RULES_PER_USER_MAX);
      return rows.map(priceAlertRecordOf);
    },
    listByUser: async (userId) => {
      const rows = await database
        .select()
        .from(priceAlertRules)
        .where(eq(priceAlertRules.userId, userId))
        .orderBy(asc(priceAlertRules.status), desc(priceAlertRules.createdAt))
        .limit(PRICE_ALERT_RULES_PER_USER_MAX);
      return rows.map(priceAlertRecordOf);
    },

    markAttempted: async (ids) => {
      if (ids.length === 0) return;
      await database
        .update(priceAlertRules)
        .set({ updatedAt: dependencies.now() })
        .where(and(inArray(priceAlertRules.id, [...ids]), active));
    },

    markChecked: async (ids, checkedAt) => {
      if (ids.length === 0) return;
      await database
        .update(priceAlertRules)
        .set({ lastCheckedAt: checkedAt, updatedAt: dependencies.now() })
        .where(and(inArray(priceAlertRules.id, [...ids]), active));
    },

    recordDelivery: async (ids, delivery) => {
      if (ids.length === 0) return [];
      const rows = await database
        .update(priceAlertRules)
        .set({ delivery, updatedAt: dependencies.now() })
        .where(
          and(
            inArray(priceAlertRules.id, [...ids]),
            eq(priceAlertRules.status, "triggered"),
            eq(priceAlertRules.delivery, "pending")
          )
        )
        .returning();
      return rows.map(priceAlertRecordOf);
    },

    remove: async (id, userId) => {
      const removed = await database
        .delete(priceAlertRules)
        .where(
          and(eq(priceAlertRules.id, id), eq(priceAlertRules.userId, userId))
        )
        .returning({ id: priceAlertRules.id });
      return removed.length > 0;
    },

    trigger: async (input) => {
      const [row] = await database
        .update(priceAlertRules)
        .set({
          delivery: "pending",
          lastCheckedAt: input.triggeredAt,
          status: "triggered",
          triggeredAt: input.triggeredAt,
          triggerPrice: input.triggerPrice,
          updatedAt: dependencies.now(),
        })
        .where(and(eq(priceAlertRules.id, input.id), active))
        .returning();
      return row === undefined ? null : priceAlertRecordOf(row);
    },
  };
};
