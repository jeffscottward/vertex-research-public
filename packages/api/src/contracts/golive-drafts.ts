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
// This contract has no send route and its service calls no order gateway: an approval is a stored
// owner decision. The draft page sends an approved entry through vertexOrders.comboPreview /
// comboSubmit with goLiveDraftId (GO-LIVE 4), gated by golive-send-gate.ts (node armed, plan caps,
// exact approved order) and only through an order bridge that runs engine policy v3 and the node
// ARM record on every opening combo (docs/vertex-rebuild/golive-draft-queue.md).
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
// The send of an approved entry draft, read from the order intent store: not_sent (no send has
// run), refused (the order bridge refused the last send before IBKR: nothing was sent), sent
// (placed, or found at IBKR), unknown (in flight or outcome unknown: it may still reach IBKR),
// not_found (an unknown outcome checked later and not found at IBKR; not sent again here),
// unavailable (the store is missing or did not answer).
export const GOLIVE_SEND_STATE_VALUES = [
  "not_sent",
  "refused",
  "sent",
  "unknown",
  "not_found",
  "unavailable",
] as const;
// The send states "Send approved order" offers a send for (the server checks again at send).
export const GOLIVE_SENDABLE_STATES = ["not_sent", "refused"] as const;
export const GOLIVE_QUOTE_SOURCE_VALUES = [
  "ibkr_live",
  "yahoo_delayed_snapshot",
  "model",
] as const;
export const GOLIVE_SIZING_REASON_VALUES = [
  "sized",
  "budget_below_one_spread",
  // The budget buys more spreads than one order may hold (the quantity limit of the combo
  // order). The draft is not reduced: quantity 0.
  "quantity_above_order_limit",
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
// The widest market of one leg that still gives a price: ask - bid at most this share of the mid.
// A wider leg (0.01 bid, 5.00 asked) has a mid that nobody trades at, so it gives no limit.
export const GOLIVE_QUOTE_MAX_SPREAD_SHARE = 0.5;
// In dollars. A leg is never called wide for ask - bid at or below this: it is one tick of an
// option priced under 3 dollars, so 0.05 bid, 0.10 asked is the tightest market such a leg has.
export const GOLIVE_QUOTE_SPREAD_FLOOR = 0.05;
// The most drafts one trading day may hold. collect refuses a batch that would go above it, so
// the queue always lists every draft of the day.
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
// A time as ISO-8601 date-time text with "Z" or a numeric offset ("2026-11-11T20:45:02Z"), read
// as a date. Nothing is coerced: null, true and a number are refused (coercion read them as 1970),
// and so is a time without an offset, which names no fixed instant.
const InstantTextSchema = z.iso
  .datetime({ offset: true })
  .transform((text) => new Date(text));
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
    quote: GoLiveQuoteSchema.extend({ asOf: InstantTextSchema }).nullable(),
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
    // The exact order the owner approved, stored with the decision. null unless state is approved.
    // sizing and order below are recomputed at every read and can differ from it later.
    approvedOrder: VertexComboInputSchema.nullable(),
    // The room an approved draft holds in its sleeve, its name and the open risk: the quantity of
    // approvedOrder x the max loss per spread at the approved limit. It does not change with the
    // account value; maxLossPctNlv is that amount as a share of the account value now, and null
    // when the account value is unavailable. null unless state is approved, and for API keys.
    approvedRoom: z
      .object({
        maxLoss: z.number().finite(),
        maxLossPctNlv: z.number().finite().nullable(),
      })
      .strict()
      .nullable(),
    createdAt: z.date(),
    decidedAt: z.date().nullable(),
    decidedBy: z.string().nullable(),
    decisionNote: z.string().nullable(),
    entryBasis: z.enum(GOLIVE_ENTRY_BASIS_VALUES).nullable(),
    exitReason: z.enum(GOLIVE_EXIT_REASON_VALUES).nullable(),
    exitRule: z.literal(GOLIVE_EXIT_RULE),
    // When the owner's standing exit rule (owner_standing_rule_v1) closes this position, for an
    // approved entry draft: a loser closes on loserCloseDay (3 NYSE trading days before expiry),
    // an open winner at winnerCloseAt (15:45 New York time on the expiry day). closeOrder is the
    // combo that closes the approved order (every leg reversed, same quantity); its limit is set
    // from the live quote when the exit draft is placed, so it is null here. null otherwise.
    exitSchedule: z
      .object({
        closeOrder: z
          .object({
            legs: VertexComboInputSchema.shape.legs,
            quantity: z.number().int().positive(),
            symbol: z.string(),
          })
          .strict(),
        loserCloseDay: CalendarDateSchema,
        winnerCloseAt: z.date(),
      })
      .strict()
      .nullable(),
    expiry: z.string(),
    id: z.string().min(1),
    kind: z.enum(GOLIVE_DRAFT_KIND_VALUES),
    longStrike: z.number(),
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
    // 1 when the draft is stored; every later write to it adds 1. approve sends the revision the
    // owner read and is refused when the draft has another one.
    revision: z.number().int().positive(),
    // Where the send of an approved entry stands (the order intent rows of its fixed orderRef):
    // not_sent and refused may be sent with "Send approved order"; the server decides again at
    // send. null for any other draft and for API keys.
    send: z.enum(GOLIVE_SEND_STATE_VALUES).nullable(),
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
    // True when this caller may approve and reject (owner in a browser session).
    canDecide: z.boolean(),
    // Every draft of the trading day: collect keeps a day at or below this number.
    drafts: z.array(GoLiveDraftSchema).max(GOLIVE_DRAFT_LIST_MAX),
    // null: the generator has not reported for this trading day.
    generatedAt: z.date().nullable(),
    marketNotes: z.enum(["attached", "none_active", "feature_not_deployed"]),
    node: GoLiveNodeSchema,
    // null: no plan record exists.
    plan: GoLivePlanSchema.nullable(),
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
    generatedAt: InstantTextSchema,
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
// Every candidate of the batch is counted once: created (a new draft), updated (a stored draft
// that is still open got the new quote, facts or entry basis, or came back from expired) or
// unchanged (nothing was written for it). expired counts the stored drafts this run expired.
export const GoLiveCollectOutputSchema = z
  .object({
    created: z.number().int().min(0),
    expired: z.number().int().min(0),
    unchanged: z.number().int().min(0),
    updated: z.number().int().min(0),
  })
  .strict();

export const GoLiveDraftApproveInputSchema = z
  .object({
    confirm: z.literal(true),
    id: IdSchema,
    note: z.string().max(1000).optional(),
    // The owner confirms the exact order shown: the server refuses when its own sized order differs.
    order: VertexComboInputSchema,
    // Owner 2026-11-12 (GO-LIVE 4 step 6): a late entry (model_holds_account_does_not) may be
    // approved only with this explicit acknowledgement that it is outside the tested entry rule.
    outsideTestedEntryRule: z.literal(true).optional(),
    // The revision of the draft as the owner read it: the server refuses when the draft has
    // another one (a later generator run changed its quote, facts or entry basis). At most the
    // largest value the stored whole number (int4) holds.
    revision: z.number().int().positive().max(2_147_483_647),
  })
  .strict();
// The note is trimmed first: blanks alone are no note.
export const GoLiveDraftRejectInputSchema = z
  .object({ id: IdSchema, note: z.string().trim().min(1).max(1000) })
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
export type GoLiveSendState = (typeof GOLIVE_SEND_STATE_VALUES)[number];
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
