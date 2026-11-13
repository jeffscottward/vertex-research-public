import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Once-only send of an owner order with a fixed orderRef (a go-live draft), across web processes
// (card vertex-golive-exec-intake, deferred from the PR #206 review). A send claims
// (order_ref, attempt) before its intent row is written; the primary key lets exactly one of two
// concurrent sends of the same ref win. attempt is the number of earlier sends of the ref that the
// order bridge refused before IBKR (nothing was sent), so a refused draft can be sent again and
// that resend claims the next attempt. A claim is written in the same transaction as its intent
// row, so a send that stops before the intent row leaves no claim; claims are never updated or
// deleted. The intent and outcome rows stay in audit_records.
export const vertexOrderSendClaims = pgTable(
  "vertex_order_send_claims",
  {
    attempt: integer("attempt").notNull(),
    claimedAt: timestamp("claimed_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    orderRef: text("order_ref").notNull(),
    requestId: text("request_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.orderRef, table.attempt],
      name: "vertex_order_send_claims_pk",
    }),
    check(
      "vertex_order_send_claims_fields_check",
      sql`${table.attempt} >= 0 and char_length(${table.orderRef}) between 1 and 64 and char_length(${table.requestId}) between 1 and 200`
    ),
  ]
);

export type VertexOrderSendClaimRow = typeof vertexOrderSendClaims.$inferSelect;
