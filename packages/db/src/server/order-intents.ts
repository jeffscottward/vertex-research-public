import { and, eq, gte, inArray } from "drizzle-orm";

import { auditRecords, vertexOrderSendClaims } from "../schema/index.ts";
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

export const ORDER_INTENT_OUTCOMES = [
  "placed",
  "unknown",
  "open",
  "position-changed",
  "not-found",
  // The order bridge refused it before IBKR (engine policy v3 or the node ARM check): nothing was sent.
  "refused",
] as const;
export type OrderIntentOutcome = (typeof ORDER_INTENT_OUTCOMES)[number];

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
  /** Whether the last outcome written for this orderRef is "refused" (nothing reached IBKR). */
  refused: (orderRef: string) => Promise<boolean>;
  /**
   * Once-only send of a fixed orderRef across processes: in one transaction, claims
   * (orderRef, attempt) in vertex_order_send_claims and writes the intent row. attempt is the
   * number of earlier sends of the ref the order bridge refused. false, with nothing written, when
   * the ref was already sent (its last row is not a refusal) or another send holds the claim.
   */
  recordIntentOnce: (
    input: Readonly<{
      actorUserId: string;
      requestId: string;
      intent: Omit<OrderIntent, "createdAt">;
    }>
  ) => Promise<boolean>;
  /** What the last row of each orderRef says (refs with no row: "none"). */
  sendStates: (
    orderRefs: readonly string[]
  ) => Promise<ReadonlyMap<string, OrderSendState>>;
}>;

/**
 * What the last row of an orderRef says: no row, an intent with no outcome yet ("pending": in
 * flight, or the process stopped before its outcome), or the outcome written last.
 */
export type OrderSendState = "none" | "pending" | OrderIntentOutcome;

type RefRow = Readonly<{
  action: string;
  createdAt: Date;
  entityId: string;
  metadata: unknown;
}>;

const outcomeOf = (row: RefRow): unknown =>
  (row.metadata as Record<string, unknown> | null)?.["outcome"];

// The very last row decides: a later intent row (a new send) is not refused. On a timestamp tie an
// intent sorts last (a resend in flight is never read as refused).
const stateOf = (rows: readonly RefRow[]): OrderSendState => {
  const intentLast = (action: string) =>
    action === "vertex.order.intent" ? 1 : 0;
  const last = [...rows]
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        intentLast(a.action) - intentLast(b.action)
    )
    .at(-1);
  if (last === undefined) return "none";
  if (last.action === "vertex.order.intent") return "pending";
  // An outcome this code does not know is read as unknown: the order may have reached IBKR.
  const outcome = ORDER_INTENT_OUTCOMES.find(
    (known) => known === outcomeOf(last)
  );
  return outcome ?? "unknown";
};

export const createOrderIntentRepository = (
  database: DatabaseExecutor,
  dependencies: Readonly<{ now: () => Date; generateId: () => string }>
): OrderIntentRepository => {
  const insert = async (
    executor: DatabaseExecutor,
    action: OrderIntentAction,
    actorUserId: string,
    requestId: string,
    orderRef: string,
    metadata: Readonly<Record<string, string | number>>
  ): Promise<void> => {
    if (requestId.trim() === "") throw new Error("requestId is required");
    if (orderRef.trim() === "") throw new Error("orderRef is required");
    await executor.insert(auditRecords).values({
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
  const rowsOf = async (
    executor: DatabaseExecutor,
    orderRefs: readonly string[]
  ): Promise<readonly RefRow[]> =>
    await executor
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
          inArray(auditRecords.entityId, [...orderRefs]),
          inArray(auditRecords.action, [...ORDER_INTENT_ACTIONS])
        )
      );
  const intentMetadata = (intent: Omit<OrderIntent, "createdAt">) => ({
    contract: intent.contract,
    expiry: intent.expiry,
    heldBefore: intent.heldBefore,
    right: intent.right,
    strike: intent.strike,
    symbol: intent.symbol,
  });
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
        database,
        "vertex.order.intent",
        actorUserId,
        requestId,
        intent.orderRef,
        intentMetadata(intent)
      ),
    recordIntentOnce: async ({ actorUserId, requestId, intent }) => {
      if (requestId.trim() === "") throw new Error("requestId is required");
      if (intent.orderRef.trim() === "")
        throw new Error("orderRef is required");
      // A second transaction inserting the same (orderRef, attempt) waits for the first one and
      // then inserts nothing (primary key), so exactly one of two concurrent sends gets true.
      return await database.transaction(async (transaction) => {
        const rows = await rowsOf(transaction, [intent.orderRef]);
        const state = stateOf(rows);
        if (state !== "none" && state !== "refused") return false;
        const attempt = rows.filter(
          (row) =>
            row.action !== "vertex.order.intent" && outcomeOf(row) === "refused"
        ).length;
        const claimed = await transaction
          .insert(vertexOrderSendClaims)
          .values({
            attempt,
            claimedAt: dependencies.now(),
            orderRef: intent.orderRef,
            requestId,
          })
          .onConflictDoNothing()
          .returning({ attempt: vertexOrderSendClaims.attempt });
        if (claimed.length === 0) return false;
        await insert(
          transaction,
          "vertex.order.intent",
          actorUserId,
          requestId,
          intent.orderRef,
          intentMetadata(intent)
        );
        return true;
      });
    },
    recordOutcome: async (input) =>
      await insert(
        database,
        input.action,
        input.actorUserId,
        input.requestId,
        input.orderRef,
        { outcome: input.outcome }
      ),
    refused: async (orderRef) =>
      stateOf(await rowsOf(database, [orderRef])) === "refused",
    sendStates: async (orderRefs) => {
      const rows =
        orderRefs.length === 0 ? [] : await rowsOf(database, orderRefs);
      return new Map(
        orderRefs.map((ref) => [
          ref,
          stateOf(rows.filter((row) => row.entityId === ref)),
        ])
      );
    },
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
        if (row.action === "vertex.order.intent") {
          // A new intent for the ref (a go-live draft sent again after a refusal) is unresolved
          // until its own outcome row.
          last.delete(row.entityId);
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
        } else last.set(row.entityId, String(metadata["outcome"] ?? ""));
      }
      return [...intents.values()].filter((intent) => {
        const outcome = last.get(intent.orderRef);
        return outcome === undefined || outcome === "unknown";
      });
    },
  };
};
