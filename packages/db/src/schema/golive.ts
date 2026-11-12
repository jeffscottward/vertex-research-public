import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Go-live draft queue (docs/vertex-rebuild/golive-draft-queue.md, migration 0067_golive_drafts).
// golive_plans holds every version of the allocation plan; at most one row is in force (proposed
// or approved). golive_drafts holds the order drafts the rig generator sends for a trading day and
// the owner's stored decision on each. golive_draft_runs records the last generator report of a
// day. RECORDS ONLY: nothing here places, stages or sends an order.
//
// The value lists mirror packages/api/src/contracts/golive-drafts.ts. They are declared here
// because the db package does not import the api package; the table checks enforce them.

export const GOLIVE_PLAN_STATUSES = [
  "proposed",
  "approved",
  "retired",
] as const;
export const GOLIVE_PLAN_APPROVAL_BASES = [
  "owner_decision",
  "owner_delegation",
] as const;
export const GOLIVE_STRUCTURES = [
  "callDebitVertical",
  "putDebitVertical",
  "putCreditVertical",
  "callCreditVertical",
] as const;
export const GOLIVE_DEFINITION_VARIANTS = [
  "as_studied",
  "always_on_entry",
  "top_1",
] as const;
export const GOLIVE_DRAFT_KINDS = ["entry", "exit"] as const;
export const GOLIVE_DRAFT_STATES = [
  "proposed",
  "approved",
  "rejected",
  "expired",
] as const;
export const GOLIVE_ENTRY_BASES = [
  "signal_today",
  "model_holds_account_does_not",
] as const;
export const GOLIVE_EXIT_REASONS = [
  "loser_3_trading_days_before_expiry",
  "winner_expiry_day_1545_et",
  "monthly_roll",
] as const;
export const GOLIVE_EXIT_RULE_VALUE = "owner_standing_rule_v1" as const;
export const GOLIVE_NODE_BADGES = [
  "running-disarmed",
  "running-armed",
  "down",
  "unknown",
] as const;
export const GOLIVE_QUOTE_SOURCES = [
  "ibkr_live",
  "yahoo_delayed_snapshot",
  "model",
] as const;

export type GoLivePlanStatusValue = (typeof GOLIVE_PLAN_STATUSES)[number];
export type GoLivePlanApprovalBasisValue =
  (typeof GOLIVE_PLAN_APPROVAL_BASES)[number];
export type GoLiveStructureValue = (typeof GOLIVE_STRUCTURES)[number];
export type GoLiveDefinitionVariantValue =
  (typeof GOLIVE_DEFINITION_VARIANTS)[number];
export type GoLiveDraftKindValue = (typeof GOLIVE_DRAFT_KINDS)[number];
export type GoLiveDraftStateValue = (typeof GOLIVE_DRAFT_STATES)[number];
export type GoLiveEntryBasisValue = (typeof GOLIVE_ENTRY_BASES)[number];
export type GoLiveExitReasonValue = (typeof GOLIVE_EXIT_REASONS)[number];
export type GoLiveExitRuleValue = typeof GOLIVE_EXIT_RULE_VALUE;
export type GoLiveNodeBadgeValue = (typeof GOLIVE_NODE_BADGES)[number];
export type GoLiveQuoteSourceValue = (typeof GOLIVE_QUOTE_SOURCES)[number];

/** golive_plans.limits: percent of account equity, and a position count. */
export interface GoLivePlanLimitsValue {
  maxPositions: number;
  nameRiskCapPct: number;
  openRiskCapPct: number;
  positionRiskPct: number;
}

/** One element of golive_plans.sleeves (GoLivePlanSleeveSchema in the contract). */
export interface GoLivePlanSleeveValue {
  anchorDelta: number;
  budgetPct: number;
  definitionNote: string;
  definitionVariant: GoLiveDefinitionVariantValue;
  dteMin: number;
  dteTarget: number;
  key: string;
  name: string;
  runKey: string;
  structure: GoLiveStructureValue;
  symbols: string[];
  widthSigma: number;
}

/** One leg of golive_drafts.approved_order. expiry is YYYYMMDD. */
export interface GoLiveApprovedOrderLegValue {
  expiry: string;
  ratio: number;
  right: "C" | "P";
  side: "BUY" | "SELL";
  strike: number;
}

/**
 * golive_drafts.approved_order: the exact combo the owner approved (the shape of
 * VertexComboInputSchema in packages/api). limitPrice is net per spread: positive = debit.
 */
export interface GoLiveApprovedOrderValue {
  legs: GoLiveApprovedOrderLegValue[];
  limitPrice: number;
  quantity: number;
  symbol: string;
}

/** golive_drafts.quote. asOf is an ISO-8601 instant (jsonb holds no timestamp type). */
export interface GoLiveStoredQuoteValue {
  asOf: string;
  longAsk: number;
  longBid: number;
  shortAsk: number;
  shortBid: number;
  source: GoLiveQuoteSourceValue;
}

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

const oneOf = (column: AnyPgColumn, values: readonly string[]): SQL =>
  sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;

export const goLivePlans = pgTable(
  "golive_plans",
  {
    approvalBasis: text("approval_basis").$type<GoLivePlanApprovalBasisValue>(),
    approvedAt: utcTimestamp("approved_at"),
    approvedBy: text("approved_by"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    evidenceUrl: text("evidence_url"),
    exitRule: text("exit_rule").$type<GoLiveExitRuleValue>().notNull(),
    /** The plan's name key, the same in every version of it (for example funded-lower-bar-pie). */
    id: text("id").notNull(),
    limits: jsonb("limits").$type<GoLivePlanLimitsValue>().notNull(),
    name: text("name").notNull(),
    ownerMessageUrl: text("owner_message_url"),
    retiredAt: utcTimestamp("retired_at"),
    sleeves: jsonb("sleeves").$type<GoLivePlanSleeveValue[]>().notNull(),
    status: text("status").$type<GoLivePlanStatusValue>().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
    /** One counter over all plans: each write takes max(version) + 1. */
    version: integer("version").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.id, table.version],
      name: "golive_plans_id_version_pk",
    }),
    uniqueIndex("golive_plans_version_idx").on(table.version),
    // At most one plan is in force: every proposed or approved row has the same index key.
    uniqueIndex("golive_plans_in_force_idx")
      .on(table.exitRule)
      .where(sql`${table.status} in ('proposed', 'approved')`),
    check(
      "golive_plans_fields_check",
      sql`char_length(${table.id}) between 1 and 128 and char_length(${table.name}) between 1 and 120 and ${table.version} >= 1 and ${oneOf(table.status, GOLIVE_PLAN_STATUSES)} and (${table.approvalBasis} is null or ${oneOf(table.approvalBasis, GOLIVE_PLAN_APPROVAL_BASES)}) and ${table.exitRule} = '${sql.raw(GOLIVE_EXIT_RULE_VALUE)}' and jsonb_typeof(${table.limits}) = 'object' and jsonb_typeof(${table.sleeves}) = 'array'`
    ),
    // A proposed plan carries no approval. An approved plan names its basis, the owner message,
    // who approved and when. A delegation always carries its evidence link. A retired plan keeps
    // whatever approval it had.
    check(
      "golive_plans_approval_check",
      sql`(${table.status} <> 'proposed' or ${table.approvalBasis} is null) and (${table.status} <> 'approved' or (${table.approvalBasis} is not null and ${table.ownerMessageUrl} is not null and ${table.approvedBy} is not null and ${table.approvedAt} is not null)) and (${table.approvalBasis} is distinct from 'owner_delegation' or ${table.evidenceUrl} is not null) and ((${table.status} = 'retired') = (${table.retiredAt} is not null))`
    ),
  ]
);

export type GoLivePlanRow = typeof goLivePlans.$inferSelect;

export const goLiveDraftRuns = pgTable(
  "golive_draft_runs",
  {
    candidateCount: integer("candidate_count").notNull(),
    generatedAt: utcTimestamp("generated_at").notNull(),
    planId: text("plan_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    tradingDay: date("trading_day", { mode: "string" }).primaryKey(),
  },
  (table) => [
    foreignKey({
      columns: [table.planId, table.planVersion],
      foreignColumns: [goLivePlans.id, goLivePlans.version],
      name: "golive_draft_runs_plan_fk",
    }).onDelete("restrict"),
    check("golive_draft_runs_fields_check", sql`${table.candidateCount} >= 0`),
  ]
);

export type GoLiveDraftRunRow = typeof goLiveDraftRuns.$inferSelect;

export const goLiveDrafts = pgTable(
  "golive_drafts",
  {
    /** The exact order the owner approved. Set exactly when state is approved. */
    approvedOrder: jsonb("approved_order").$type<GoLiveApprovedOrderValue>(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    decidedAt: utcTimestamp("decided_at"),
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
    entryBasis: text("entry_basis").$type<GoLiveEntryBasisValue>(),
    exitReason: text("exit_reason").$type<GoLiveExitReasonValue>(),
    exitRule: text("exit_rule").$type<GoLiveExitRuleValue>().notNull(),
    /** YYYYMMDD. */
    expiry: text("expiry").notNull(),
    /** Deterministic: a hash of the plan version, the trading day and the structure. */
    id: text("id").primaryKey(),
    kind: text("kind").$type<GoLiveDraftKindValue>().notNull(),
    longStrike: doublePrecision("long_strike").notNull(),
    nodeBadgeAtDecision: text(
      "node_badge_at_decision"
    ).$type<GoLiveNodeBadgeValue>(),
    parentDraftId: text("parent_draft_id"),
    planId: text("plan_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    quote: jsonb("quote").$type<GoLiveStoredQuoteValue>(),
    /**
     * Counts the writes to this row: 1 at insert, plus 1 at every later write. An approval names
     * the revision the owner read, so it is refused when the draft changed in between.
     */
    revision: integer("revision").notNull().default(1),
    shortStrike: doublePrecision("short_strike").notNull(),
    signalFacts: jsonb("signal_facts").$type<string[]>().notNull(),
    sleeveKey: text("sleeve_key").notNull(),
    state: text("state").$type<GoLiveDraftStateValue>().notNull(),
    structure: text("structure").$type<GoLiveStructureValue>().notNull(),
    symbol: text("symbol").notNull(),
    tradingDay: date("trading_day", { mode: "string" }).notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.planId, table.planVersion],
      foreignColumns: [goLivePlans.id, goLivePlans.version],
      name: "golive_drafts_plan_fk",
    }).onDelete("restrict"),
    index("golive_drafts_trading_day_idx").on(table.tradingDay),
    check(
      "golive_drafts_fields_check",
      sql`${oneOf(table.kind, GOLIVE_DRAFT_KINDS)} and ${oneOf(table.structure, GOLIVE_STRUCTURES)} and ${oneOf(table.state, GOLIVE_DRAFT_STATES)} and (${table.entryBasis} is null or ${oneOf(table.entryBasis, GOLIVE_ENTRY_BASES)}) and (${table.exitReason} is null or ${oneOf(table.exitReason, GOLIVE_EXIT_REASONS)}) and (${table.nodeBadgeAtDecision} is null or ${oneOf(table.nodeBadgeAtDecision, GOLIVE_NODE_BADGES)}) and ${table.exitRule} = '${sql.raw(GOLIVE_EXIT_RULE_VALUE)}' and ${table.expiry} ~ '^[0-9]{8}$' and ${table.longStrike} > 0 and ${table.longStrike} < 'Infinity'::double precision and ${table.shortStrike} > 0 and ${table.shortStrike} < 'Infinity'::double precision and ${table.longStrike} <> ${table.shortStrike} and char_length(${table.sleeveKey}) between 1 and 40 and char_length(${table.symbol}) between 1 and 10 and jsonb_typeof(${table.signalFacts}) = 'array'`
    ),
    // An entry has its basis and no exit fields; an exit has its reason and the draft it closes.
    check(
      "golive_drafts_kind_check",
      sql`(${table.kind} <> 'entry' or (${table.entryBasis} is not null and ${table.exitReason} is null and ${table.parentDraftId} is null)) and (${table.kind} <> 'exit' or (${table.exitReason} is not null and ${table.entryBasis} is null and ${table.parentDraftId} is not null))`
    ),
    // decided_by and decided_at are both set exactly when the owner approved or rejected.
    check(
      "golive_drafts_decision_check",
      sql`(${table.state} in ('approved', 'rejected')) = (${table.decidedBy} is not null) and (${table.state} in ('approved', 'rejected')) = (${table.decidedAt} is not null)`
    ),
    check("golive_drafts_revision_check", sql`${table.revision} > 0`),
    // An approval always stores the order that was approved; no other state carries one.
    check(
      "golive_drafts_approved_order_check",
      sql`(${table.state} = 'approved') = (${table.approvedOrder} is not null) and (${table.approvedOrder} is null or jsonb_typeof(${table.approvedOrder}) = 'object')`
    ),
  ]
);

export type GoLiveDraftRow = typeof goLiveDrafts.$inferSelect;
