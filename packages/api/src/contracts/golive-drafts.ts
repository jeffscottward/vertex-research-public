import { oc } from "@orpc/contract";
import { z } from "zod";

import { AGENT_OPS_API_ERRORS } from "./agent-ops.ts";
import { CalendarDateSchema } from "./calendar-date.ts";
import {
  VertexComboInputSchema,
  VertexFinalGateSchema,
} from "./vertex-orders.ts";

// Go-live draft queue (card vertex-golive-draft-queue). Vertex computes what the allocation plan
// wants today and drafts defined-risk vertical orders. The owner approves or rejects each draft.
//
// RECORDS ONLY. This contract has no send route and its service calls no order gateway: an
// approval is a stored owner decision and nothing reaches a broker. The owner places an approved
// draft through the existing order screen (vertexOrders.comboPreview / comboSubmit). A send route
// is a later change behind its own flag; it must check the Nautilus arm state itself, because the
// order bridge checks only the kill switch (docs/vertex-rebuild/golive-draft-queue.md).
//
// Access: plan and draft reads need an operator. approve and reject need the owner in a browser
// session (agent API keys are refused). collect is the rig generator's write (operator write key).
// No procedure approves a plan: the plan record is written by scripts/golive/seed-plan.ts. An
// approved plan always needs the owner message link; a plan approved by delegation also needs the
// evidence link (for a plain owner decision the owner's message is the evidence).

export const GOLIVE_PLAN_STATUS_VALUES = [
  "proposed",
  "approved",
  "retired",
] as const;
// How an approved plan was approved. A delegation is never shown as a plain owner approval.
export const GOLIVE_PLAN_APPROVAL_BASIS_VALUES = [
  "owner_decision",
  "owner_delegation",
] as const;
export const GOLIVE_STRUCTURE_VALUES = [
  "callDebitVertical",
  "putDebitVertical",
  "putCreditVertical",
  "callCreditVertical",
] as const;
// How a sleeve changes its study definition. The generator has one builder per value and refuses
// a value it does not know: as_studied (unchanged), always_on_entry (entry rule always true),
// top_1 (rotation holds the single best name).
export const GOLIVE_DEFINITION_VARIANT_VALUES = [
  "as_studied",
  "always_on_entry",
  "top_1",
] as const;
export const GOLIVE_DRAFT_KIND_VALUES = ["entry", "exit"] as const;
export const GOLIVE_DRAFT_STATE_VALUES = [
  "proposed",
  "approved",
  "rejected",
  "expired",
] as const;
// signal_today: the plan's tested entry rule fired for this trading day.
// model_holds_account_does_not: the backtest model holds this position and the account does not.
// A late entry is not in the backtest, so such a draft is listed and cannot be approved.
export const GOLIVE_ENTRY_BASIS_VALUES = [
  "signal_today",
  "model_holds_account_does_not",
] as const;
// Owner standing exit rule: winners may run to expiry; losers close 3 trading days before expiry;
// open winners close 15:45 ET on expiry day. The monthly roll closes the old spread.
export const GOLIVE_EXIT_REASON_VALUES = [
  "loser_3_trading_days_before_expiry",
  "winner_expiry_day_1545_et",
  "monthly_roll",
] as const;
export const GOLIVE_EXIT_RULE = "owner_standing_rule_v1" as const;
// Why a draft cannot be approved now. Every value names its cause; there is no "unknown".
export const GOLIVE_NOT_APPROVABLE_VALUES = [
  "PLAN_NOT_APPROVED",
  "LATE_ENTRY_NOT_TESTED",
  "NO_LIVE_IBKR_QUOTE",
  "NLV_UNAVAILABLE",
  "SIZED_TO_ZERO",
  "PRECHECK_DENIED",
  "DRAFT_NOT_PROPOSED",
  "DRAFT_EXPIRED",
] as const;
export const GOLIVE_QUOTE_SOURCE_VALUES = [
  "ibkr_live",
  "yahoo_delayed_snapshot",
  "model",
] as const;
export const GOLIVE_SIZING_REASON_VALUES = [
  "sized",
  "budget_below_one_spread",
  "nlv_unavailable",
  "no_quote",
  "sleeve_budget_used",
  "name_cap_reached",
  "open_risk_cap_reached",
  "max_positions_reached",
] as const;
export const GOLIVE_NODE_BADGE_VALUES = [
  "running-disarmed",
  "running-armed",
  "down",
  "unknown",
] as const;
export const GOLIVE_DRAFT_LIST_MAX = 200;
export const GOLIVE_COLLECT_MAX = 50;
// Standing owner rule: at most 2% of the account at risk in one position. A plan may only be
// stricter. Changing this value is an owner decision.
export const GOLIVE_STANDING_MAX_LOSS_PCT = 2;
// Standing owner rule: at most 2% of the account in one underlying (the 6% LEAPS cap does not
// apply: plan verticals are short-dated). A plan may only be stricter.
export const GOLIVE_STANDING_NAME_CAP_PCT = 2;

const IdSchema = z.string().trim().min(1).max(128);
const PctSchema = z.number().finite().positive().max(100);
const SymbolSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9.]{0,9}$/u, "Symbol must be 1-10 letters");
/** True when YYYYMMDD names a real calendar day (20261399 and 20260230 do not). */
const isCalendarDay = (yyyymmdd: string): boolean => {
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};
const ExpirySchema = z
  .string()
  .regex(/^\d{8}$/u, "Expiry must be YYYYMMDD")
  .refine(isCalendarDay, { message: "Expiry must be a real calendar day" });
const StrikeSchema = z.number().finite().positive().max(100_000);
// A message link, not a channel link: /channels/<guild>/<channel>/<message>.
const OwnerMessageUrlSchema = z
  .string()
  .max(200)
  .regex(
    /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/u,
    "Owner link must be a Discord message link"
  );
// The "https://" prefix is checked as text: the URL parser alone accepts "https:example.com",
// which a browser resolves as a relative link on the app's own origin.
const EvidenceUrlSchema = z
  .url({ protocol: /^https$/u })
  .max(400)
  .regex(/^https:\/\/[^/\s]/u, "Evidence link must start with https://");

export const GoLivePlanStatusSchema = z.enum(GOLIVE_PLAN_STATUS_VALUES);
export const GoLiveStructureSchema = z.enum(GOLIVE_STRUCTURE_VALUES);
export const GoLiveDraftStateSchema = z.enum(GOLIVE_DRAFT_STATE_VALUES);

export const GoLivePlanLimitsSchema = z
  .object({
    maxPositions: z.number().int().positive().max(50),
    nameRiskCapPct: PctSchema.max(GOLIVE_STANDING_NAME_CAP_PCT),
    openRiskCapPct: PctSchema,
    positionRiskPct: PctSchema.max(GOLIVE_STANDING_MAX_LOSS_PCT),
  })
  .strict();

export const GoLivePlanSleeveSchema = z
  .object({
    anchorDelta: z.number().finite().positive().max(1),
    budgetPct: PctSchema,
    // The same change in words, for the page.
    definitionNote: z.string().max(300),
    definitionVariant: z.enum(GOLIVE_DEFINITION_VARIANT_VALUES),
    dteMin: z.number().int().positive().max(1000),
    dteTarget: z.number().int().positive().max(1000),
    key: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/u, "Sleeve key must be kebab-case"),
    name: z.string().min(1).max(80),
    // Run key of the study definition (services/research/strategies/qc_ports/ideas.py family).
    runKey: z.string().min(1).max(80),
    structure: GoLiveStructureSchema,
    symbols: z.array(SymbolSchema).min(1).max(20),
    widthSigma: z.number().finite().positive().max(10),
  })
  .strict();

export const GoLivePlanSchema = z
  .object({
    // null while the plan is proposed.
    approvalBasis: z.enum(GOLIVE_PLAN_APPROVAL_BASIS_VALUES).nullable(),
    approvedAt: z.date().nullable(),
    approvedBy: z.string().nullable(),
    createdAt: z.date(),
    evidenceUrl: EvidenceUrlSchema.nullable(),
    exitRule: z.literal(GOLIVE_EXIT_RULE),
    id: z.string().min(1),
    limits: GoLivePlanLimitsSchema,
    name: z.string(),
    ownerMessageUrl: OwnerMessageUrlSchema.nullable(),
    retiredAt: z.date().nullable(),
    sleeves: z.array(GoLivePlanSleeveSchema).min(1).max(20),
    status: GoLivePlanStatusSchema,
    updatedAt: z.date(),
    version: z.number().int().positive(),
  })
  .strict();

// The plan document the seed script validates before it writes (never an API input).
export const GoLivePlanSeedSchema = z
  .object({
    approvalBasis: z.enum(GOLIVE_PLAN_APPROVAL_BASIS_VALUES).nullable(),
    approvedBy: z.string().min(1).max(120).nullable(),
    evidenceUrl: EvidenceUrlSchema.nullable(),
    id: IdSchema,
    limits: GoLivePlanLimitsSchema,
    name: z.string().min(1).max(120),
    ownerMessageUrl: OwnerMessageUrlSchema.nullable(),
    sleeves: z.array(GoLivePlanSleeveSchema).min(1).max(20),
    status: z.enum(["proposed", "approved"]),
  })
  .strict()
  .superRefine((plan, context) => {
    const issue = (message: string): void => {
      context.addIssue({ code: "custom", message });
    };
    const approved = plan.status === "approved";
    if (approved !== (plan.approvalBasis !== null)) {
      issue("approvalBasis is set exactly when the plan is approved");
    }
    if (
      approved &&
      (plan.ownerMessageUrl === null || plan.approvedBy === null)
    ) {
      issue("An approved plan needs the owner message link and approvedBy");
    }
    if (
      plan.approvalBasis === "owner_delegation" &&
      plan.evidenceUrl === null
    ) {
      issue("A plan approved by delegation needs the evidence link");
    }
    const budget = plan.sleeves.reduce(
      (sum, sleeve) => sum + sleeve.budgetPct,
      0
    );
    if (budget > plan.limits.openRiskCapPct + 1e-9) {
      issue("Sleeve budgets add up to more than the open risk cap");
    }
    if (
      new Set(plan.sleeves.map((sleeve) => sleeve.key)).size !==
      plan.sleeves.length
    ) {
      issue("Sleeve keys must be unique");
    }
    if (plan.sleeves.some((sleeve) => sleeve.dteMin > sleeve.dteTarget)) {
      issue("dteMin must not be above dteTarget");
    }
  });

// Which strike the long leg holds. A bull vertical (call debit, put credit) buys the lower strike
// and sells the higher one; a bear vertical (put debit, call credit) buys the higher strike and
// sells the lower one. The max loss arithmetic is only right for this orientation: a call debit
// vertical with the strikes swapped is a call credit vertical with another max loss.
const LONG_STRIKE_IS_LOWER: Readonly<
  Record<(typeof GOLIVE_STRUCTURE_VALUES)[number], boolean>
> = {
  callCreditVertical: false,
  callDebitVertical: true,
  putCreditVertical: true,
  putDebitVertical: false,
};
/** True when the two strikes are different and the right way round for the structure. */
export const goLiveStrikesFitStructure = (
  structure: (typeof GOLIVE_STRUCTURE_VALUES)[number],
  longStrike: number,
  shortStrike: number
): boolean =>
  LONG_STRIKE_IS_LOWER[structure]
    ? longStrike < shortStrike
    : longStrike > shortStrike;

export const GoLiveQuoteSchema = z
  .object({
    asOf: z.date(),
    longAsk: z.number().finite().min(0),
    longBid: z.number().finite().min(0),
    shortAsk: z.number().finite().min(0),
    shortBid: z.number().finite().min(0),
    source: z.enum(GOLIVE_QUOTE_SOURCE_VALUES),
  })
  .strict();

// One market note attached as context. verified is false when any claim is not "supported".
export const GoLiveDraftNoteSchema = z
  .object({
    id: z.string(),
    stance: z.string(),
    theme: z.string(),
    verified: z.boolean(),
  })
  .strict();

// What the rig generator sends for one wanted ENTRY: the structure and the facts behind it.
// Limit, quantity and max loss are computed by the server at read time from the live account.
// Exit drafts are not sent by the rig: the server derives them from held positions (later unit).
export const GoLiveDraftCandidateSchema = z
  .object({
    entryBasis: z.enum(GOLIVE_ENTRY_BASIS_VALUES),
    expiry: ExpirySchema,
    longStrike: StrikeSchema,
    quote: GoLiveQuoteSchema.extend({ asOf: z.coerce.date() }).nullable(),
    shortStrike: StrikeSchema,
    // Gate and signal values with their dates, as plain text facts ("VIX 19.5 on 2026-11-11").
    signalFacts: z.array(z.string().max(200)).max(20),
    sleeveKey: z.string().min(1).max(40),
    structure: GoLiveStructureSchema,
    symbol: SymbolSchema,
  })
  .strict()
  .refine((draft) => draft.longStrike !== draft.shortStrike, {
    message: "A vertical needs two different strikes",
  })
  .refine(
    (draft) =>
      goLiveStrikesFitStructure(
        draft.structure,
        draft.longStrike,
        draft.shortStrike
      ),
    {
      message:
        "The long and short strikes are the wrong way round for this structure",
    }
  );

export const GoLiveSizingSchema = z
  .object({
    budget: z.number().finite().nullable(),
    // Net per spread: positive = debit paid, negative = credit received. null without a quote.
    limitPrice: z.number().finite().nullable(),
    maxLoss: z.number().finite().nullable(),
    maxLossPctNlv: z.number().finite().nullable(),
    maxLossPerSpread: z.number().finite().nullable(),
    quantity: z.number().int().min(0),
    reason: z.enum(GOLIVE_SIZING_REASON_VALUES),
  })
  .strict();

export const GoLivePreCheckSchema = z
  .object({
    // The engine policy in arm_gate.py is not part of the web order path and is not run here.
    enginePolicy: z.literal("not_evaluated_not_in_web_order_path"),
    // The web final order gate, run dry on the sized order (packages/api final-order-gate.ts).
    // null when there is no sized order to check.
    webFinalGate: VertexFinalGateSchema.nullable(),
  })
  .strict();

export const GoLiveDraftSchema = z
  .object({
    createdAt: z.date(),
    decidedAt: z.date().nullable(),
    decidedBy: z.string().nullable(),
    decisionNote: z.string().nullable(),
    entryBasis: z.enum(GOLIVE_ENTRY_BASIS_VALUES).nullable(),
    exitReason: z.enum(GOLIVE_EXIT_REASON_VALUES).nullable(),
    exitRule: z.literal(GOLIVE_EXIT_RULE),
    expiry: z.string(),
    id: z.string().min(1),
    kind: z.enum(GOLIVE_DRAFT_KIND_VALUES),
    longStrike: z.number(),
    // The exact order the owner approved, stored with the decision. null unless state is approved.
    // sizing and order below are recomputed at every read and can differ from it later.
    approvedOrder: VertexComboInputSchema.nullable(),
    // The node badge read when the owner approved. An approval never sends anything.
    nodeBadgeAtDecision: z.enum(GOLIVE_NODE_BADGE_VALUES).nullable(),
    notApprovable: z.array(z.enum(GOLIVE_NOT_APPROVABLE_VALUES)),
    notes: z.array(GoLiveDraftNoteSchema),
    // The exact combo the owner would place, when the draft is sized. null otherwise.
    order: VertexComboInputSchema.nullable(),
    parentDraftId: z.string().nullable(),
    planId: z.string().min(1),
    planVersion: z.number().int().positive(),
    preCheck: GoLivePreCheckSchema,
    quote: GoLiveQuoteSchema.nullable(),
    shortStrike: z.number(),
    signalFacts: z.array(z.string()),
    // Computed at read time from the live account; never stored.
    sizing: GoLiveSizingSchema,
    sleeveKey: z.string(),
    state: GoLiveDraftStateSchema,
    structure: GoLiveStructureSchema,
    symbol: z.string(),
    tradingDay: CalendarDateSchema,
    updatedAt: z.date(),
  })
  .strict();

export const GoLiveAccountSchema = z
  .object({
    asOf: z.date().nullable(),
    // null when the portfolio monitor did not answer or its value is stale; never shown as 0.
    netLiquidation: z.number().finite().positive().nullable(),
    unavailableReason: z.string().max(120).nullable(),
  })
  .strict();

export const GoLiveNodeSchema = z
  .object({
    armedAt: z.string().nullable(),
    badge: z.enum(GOLIVE_NODE_BADGE_VALUES),
    checkedAt: z.date(),
  })
  .strict();

export const GoLiveQueueOutputSchema = z
  .object({
    account: GoLiveAccountSchema,
    drafts: z.array(GoLiveDraftSchema),
    // null: the generator has not reported for this trading day.
    generatedAt: z.date().nullable(),
    marketNotes: z.enum(["attached", "none_active", "feature_not_deployed"]),
    node: GoLiveNodeSchema,
    // null: no plan record exists.
    plan: GoLivePlanSchema.nullable(),
    // True when this caller may approve and reject (owner in a browser session).
    canDecide: z.boolean(),
    // Literal: this API cannot send an order.
    sendsOrders: z.literal(false),
    tradingDay: CalendarDateSchema,
  })
  .strict();

export const GoLiveQueueInputSchema = z
  .object({ tradingDay: CalendarDateSchema.optional() })
  .strict();

export const GoLiveCollectInputSchema = z
  .object({
    candidates: z.array(GoLiveDraftCandidateSchema).max(GOLIVE_COLLECT_MAX),
    generatedAt: z.coerce.date(),
    planId: IdSchema,
    planVersion: z.number().int().positive(),
    tradingDay: CalendarDateSchema,
  })
  .strict()
  .superRefine((input, context) => {
    // An expiry on or before the trading day is not an order anyone can hold.
    const day = input.tradingDay.replaceAll("-", "");
    input.candidates.forEach((candidate, index) => {
      if (candidate.expiry <= day)
        context.addIssue({
          code: "custom",
          message: "The expiry must be after the trading day",
          path: ["candidates", index, "expiry"],
        });
    });
  });
export const GoLiveCollectOutputSchema = z
  .object({
    created: z.number().int().min(0),
    expired: z.number().int().min(0),
    unchanged: z.number().int().min(0),
  })
  .strict();

export const GoLiveDraftApproveInputSchema = z
  .object({
    confirm: z.literal(true),
    id: IdSchema,
    note: z.string().max(1000).optional(),
    // The owner confirms the exact order shown: the server refuses when its own sized order differs.
    order: VertexComboInputSchema,
  })
  .strict();
export const GoLiveDraftRejectInputSchema = z
  .object({ id: IdSchema, note: z.string().min(1).max(1000) })
  .strict();

const goLiveApi = oc.errors(AGENT_OPS_API_ERRORS);
const tags = ["Go-live draft queue"];

const queue = goLiveApi
  .route({
    method: "GET",
    operationId: "goLiveDrafts.queue",
    path: "/golive-drafts/queue",
    summary:
      "The allocation plan in force and the order drafts of one trading day (records only)",
    tags,
  })
  .input(GoLiveQueueInputSchema)
  .output(GoLiveQueueOutputSchema);

const collect = goLiveApi
  .route({
    method: "POST",
    operationId: "goLiveDrafts.collect",
    path: "/golive-drafts/collect",
    summary:
      "Store the generator's draft candidates for one trading day (idempotent; sends nothing)",
    tags,
  })
  .input(GoLiveCollectInputSchema)
  .output(GoLiveCollectOutputSchema);

const approve = goLiveApi
  .route({
    method: "POST",
    operationId: "goLiveDrafts.approve",
    path: "/golive-drafts/{id}/approve",
    summary:
      "Record the owner's approval of one exact draft order; sends nothing",
    tags,
  })
  .input(GoLiveDraftApproveInputSchema)
  .output(GoLiveDraftSchema);

const reject = goLiveApi
  .route({
    method: "POST",
    operationId: "goLiveDrafts.reject",
    path: "/golive-drafts/{id}/reject",
    summary: "Record the owner's rejection of one draft with a note",
    tags,
  })
  .input(GoLiveDraftRejectInputSchema)
  .output(GoLiveDraftSchema);

export const goLiveDraftsContract = { approve, collect, queue, reject };

export type GoLivePlanStatus = z.infer<typeof GoLivePlanStatusSchema>;
export type GoLivePlanOutput = z.infer<typeof GoLivePlanSchema>;
export type GoLivePlanSeed = z.infer<typeof GoLivePlanSeedSchema>;
export type GoLivePlanSleeve = z.infer<typeof GoLivePlanSleeveSchema>;
export type GoLivePlanLimits = z.infer<typeof GoLivePlanLimitsSchema>;
export type GoLiveDraftCandidate = z.infer<typeof GoLiveDraftCandidateSchema>;
export type GoLiveDraftOutput = z.infer<typeof GoLiveDraftSchema>;
export type GoLiveDraftState = z.infer<typeof GoLiveDraftStateSchema>;
export type GoLiveSizing = z.infer<typeof GoLiveSizingSchema>;
export type GoLiveQuote = z.infer<typeof GoLiveQuoteSchema>;
export type GoLiveQueueOutput = z.infer<typeof GoLiveQueueOutputSchema>;
export type GoLiveCollectInput = z.input<typeof GoLiveCollectInputSchema>;
export type GoLiveCollectOutput = z.infer<typeof GoLiveCollectOutputSchema>;
export type GoLiveDraftApproveInput = z.input<
  typeof GoLiveDraftApproveInputSchema
>;
export type GoLiveDraftRejectInput = z.input<
  typeof GoLiveDraftRejectInputSchema
>;
