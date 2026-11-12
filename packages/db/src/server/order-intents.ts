import { and, eq, gte, inArray } from "drizzle-orm";

import { auditRecords } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Persisted owner option-order intents (state-machine audit 2026-11-03, card sma-vertex-order-unknown).
// Submit writes an intent row before the bridge call and a result row after it. A bridge timeout or
// failure writes outcome "unknown": the order may still reach IBKR. A later preview or submit
// reconciles unknown intents against the account and writes a "reconciled" row. Rows go to the
// generic audit_records table (no migration), entity type "vertex_order", entity id = orderRef.

export const ORDER_INTENT_ACTIONS = [
  "vertex.order.intent",
  "vertex.order.result",
  "vertex.order.reconciled",
] as const;
export type OrderIntentAction = (typeof ORDER_INTENT_ACTIONS)[number];

export type OrderIntentOutcome =
  | "placed"
  | "unknown"
  | "open"
  | "position-changed"
  | "not-found";

export type OrderIntent = Readonly<{
  orderRef: string;
  // Display label, for example "AAPL 2027-01-15 200 call".
  contract: string;
  symbol: string;
  expiry: string;
  strike: number;
  right: string;
  // Position in the contract when the intent was written.
  heldBefore: number;
  createdAt: Date;
}>;

export type OrderIntentRepository = Readonly<{
  recordIntent: (
    input: Readonly<{
      actorUserId: string;
      requestId: string;
      intent: Omit<OrderIntent, "createdAt">;
    }>
  ) => Promise<void>;
  recordOutcome: (
    input: Readonly<{
      action: "vertex.order.result" | "vertex.order.reconciled";
      actorUserId: string;
      requestId: string;
      orderRef: string;
      outcome: OrderIntentOutcome;
    }>
  ) => Promise<void>;
  /** Intents since a time whose last outcome is missing or "unknown". */
  unresolved: (since: Date) => Promise<readonly OrderIntent[]>;
  /** Whether any row (intent, result or reconciliation) exists for this orderRef. */
  hasIntent: (orderRef: string) => Promise<boolean>;
}>;

export const createOrderIntentRepository = (
  database: DatabaseExecutor,
  dependencies: Readonly<{ now: () => Date; generateId: () => string }>
): OrderIntentRepository => {
  const insert = async (
    action: OrderIntentAction,
    actorUserId: string,
    requestId: string,
    orderRef: string,
    metadata: Readonly<Record<string, string | number>>
  ): Promise<void> => {
    if (requestId.trim() === "") throw new Error("requestId is required");
    if (orderRef.trim() === "") throw new Error("orderRef is required");
    await database.insert(auditRecords).values({
      action,
      actorUserId,
      createdAt: dependencies.now(),
      entityId: orderRef,
      entityType: "vertex_order",
      id: dependencies.generateId(),
      metadata: { ...metadata },
      requestId,
    });
  };
  return {
    hasIntent: async (orderRef) => {
      const rows = await database
        .select({ id: auditRecords.id })
        .from(auditRecords)
        .where(
          and(
            eq(auditRecords.entityType, "vertex_order"),
            eq(auditRecords.entityId, orderRef)
          )
        )
        .limit(1);
      return rows.length > 0;
    },
    recordIntent: async ({ actorUserId, requestId, intent }) =>
      await insert(
        "vertex.order.intent",
        actorUserId,
        requestId,
        intent.orderRef,
        {
          contract: intent.contract,
          expiry: intent.expiry,
          heldBefore: intent.heldBefore,
          right: intent.right,
          strike: intent.strike,
          symbol: intent.symbol,
        }
      ),
    recordOutcome: async (input) =>
      await insert(
        input.action,
        input.actorUserId,
        input.requestId,
        input.orderRef,
        { outcome: input.outcome }
      ),
    unresolved: async (since) => {
      const rows = await database
        .select({
          action: auditRecords.action,
          createdAt: auditRecords.createdAt,
          entityId: auditRecords.entityId,
          metadata: auditRecords.metadata,
        })
        .from(auditRecords)
        .where(
          and(
            eq(auditRecords.entityType, "vertex_order"),
            inArray(auditRecords.action, [...ORDER_INTENT_ACTIONS]),
            gte(auditRecords.createdAt, since)
          )
        );
      const sorted = [...rows].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      );
      const intents = new Map<string, OrderIntent>();
      const last = new Map<string, string>();
      for (const row of sorted) {
        const metadata = (row.metadata ?? {}) as Record<string, unknown>;
        if (row.action === "vertex.order.intent")
          intents.set(row.entityId, {
            contract: String(metadata["contract"] ?? ""),
            createdAt: row.createdAt,
            expiry: String(metadata["expiry"] ?? ""),
            heldBefore: Number(metadata["heldBefore"] ?? 0),
            orderRef: row.entityId,
            right: String(metadata["right"] ?? ""),
            strike: Number(metadata["strike"] ?? 0),
            symbol: String(metadata["symbol"] ?? ""),
          });
        else last.set(row.entityId, String(metadata["outcome"] ?? ""));
      }
      return [...intents.values()].filter((intent) => {
        const outcome = last.get(intent.orderRef);
        return outcome === undefined || outcome === "unknown";
      });
    },
  };
};
