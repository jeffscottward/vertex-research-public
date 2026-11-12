import type {
  GOLIVE_DRAFT_STATE_VALUES,
  GOLIVE_EXIT_REASON_VALUES,
  GOLIVE_NODE_BADGE_VALUES,
  GOLIVE_NOT_APPROVABLE_VALUES,
  GOLIVE_QUOTE_SOURCE_VALUES,
  GOLIVE_SIZING_REASON_VALUES,
  GOLIVE_STRUCTURE_VALUES,
  GoLiveDraftOutput,
  GoLivePlanLimits,
  GoLivePlanOutput,
  GoLivePlanSleeve,
  GoLiveQueueOutput,
  GoLiveQuote,
  GoLiveSizing,
} from "@darkfactory/api";

import { pct, price, usd } from "./portfolio-monitor-model.ts";

// Pure wording and derivation for the go-live order draft queue (/drafts). No React, no I/O.
// Every enum of the contract has one exhaustive Record here, typed from the contract array, so a
// new enum value is a type error until it has words.

export type GoLiveStructure = (typeof GOLIVE_STRUCTURE_VALUES)[number];
export type GoLiveQuoteSource = (typeof GOLIVE_QUOTE_SOURCE_VALUES)[number];
export type GoLiveSizingReason = (typeof GOLIVE_SIZING_REASON_VALUES)[number];
export type GoLiveNotApprovable = (typeof GOLIVE_NOT_APPROVABLE_VALUES)[number];
export type GoLiveNodeBadge = (typeof GOLIVE_NODE_BADGE_VALUES)[number];
export type GoLiveDraftStateValue = (typeof GOLIVE_DRAFT_STATE_VALUES)[number];
export type GoLiveExitReason = (typeof GOLIVE_EXIT_REASON_VALUES)[number];
export type GoLiveMarketNotes = GoLiveQueueOutput["marketNotes"];
type GoLiveOrder = NonNullable<GoLiveDraftOutput["order"]>;

// ---------- fixed sentences ----------

export const NO_ORDERS_NOTICE =
  "This page sends no orders. Approve records your decision. To place an approved draft, use Portfolio > Orders.";
export const APPROVAL_NOT_SENT_SENTENCE =
  "This records your approval. It does not send the order.";
export const EXIT_RULE_WORDS =
  "Winners may run to expiry. Losers close 3 trading days before expiry. Open winners close 15:45 ET on expiry day.";
export const ENGINE_POLICY_LINE =
  "Engine policy (arm_gate): not part of the web order path; not evaluated here.";
export const NO_PLAN_TEXT = "No plan record";
export const NO_ENTRY_SIGNAL_TEXT =
  "No entry signal today under the plan's entry rule.";
export const ENTRY_SIGNAL_GROUP_TITLE = "Entry signal today";
export const MODEL_HOLDS_GROUP_TITLE =
  "Model holds, account does not (late entry not tested, cannot be approved)";
export const EXIT_GROUP_TITLE = "Exit rule";
export const NO_SIZED_ORDER_REASON = "No sized order to approve";
export const OWNER_ONLY_DECISION_TEXT =
  "Only the owner can approve or reject a draft.";
export const REJECT_NOTE_REQUIRED = "A note is required to reject a draft.";

// ---------- wording maps ----------

export const STRUCTURE_WORDS: Readonly<Record<GoLiveStructure, string>> =
  Object.freeze({
    callCreditVertical: "Call credit vertical (bear call spread)",
    callDebitVertical: "Call debit vertical (bull call spread)",
    putCreditVertical: "Put credit vertical (bull put spread)",
    putDebitVertical: "Put debit vertical (bear put spread)",
  });

export const QUOTE_SOURCE_WORDS: Readonly<Record<GoLiveQuoteSource, string>> =
  Object.freeze({
    ibkr_live: "IBKR live",
    model: "model price, indicative",
    yahoo_delayed_snapshot: "Yahoo, 15 min delayed, indicative",
  });

export const SIZING_REASON_WORDS: Readonly<Record<GoLiveSizingReason, string>> =
  Object.freeze({
    budget_below_one_spread:
      "the risk budget for one position is below the max loss of one spread",
    max_positions_reached: "the plan's maximum number of positions is reached",
    name_cap_reached: "the per-name risk cap is reached",
    nlv_unavailable: "the account value is not available",
    no_quote: "there is no quote",
    open_risk_cap_reached: "the open risk cap is reached",
    sized: "sized from the plan's risk per position",
    sleeve_budget_used: "the sleeve budget is used",
  });

export const NOT_APPROVABLE_WORDS: Readonly<
  Record<GoLiveNotApprovable, string>
> = Object.freeze({
  DRAFT_EXPIRED: "The draft has expired",
  DRAFT_NOT_PROPOSED: "The draft is no longer proposed",
  LATE_ENTRY_NOT_TESTED: "Late entry is not in the backtest",
  NLV_UNAVAILABLE: "The account value is not available",
  NO_LIVE_IBKR_QUOTE: "No live IBKR quote: the price shown is delayed",
  PLAN_NOT_APPROVED: "The plan is not approved",
  PRECHECK_DENIED: "The web final gate denied the order",
  SIZED_TO_ZERO: "The quantity is 0",
});

export const NODE_BADGE_WORDS: Readonly<Record<GoLiveNodeBadge, string>> =
  Object.freeze({
    down: "Node down",
    "running-armed": "Node running, armed",
    "running-disarmed": "Node running, disarmed",
    unknown: "Node state not readable",
  });

export const DRAFT_STATE_WORDS: Readonly<
  Record<GoLiveDraftStateValue, string>
> = Object.freeze({
  approved: "Approved (recorded). Not sent: this page sends no orders.",
  expired: "Expired",
  proposed: "Proposed",
  rejected: "Rejected",
});

export const MARKET_NOTES_WORDS: Readonly<Record<GoLiveMarketNotes, string>> =
  Object.freeze({
    attached: "Market notes: attached to the drafts",
    feature_not_deployed: "Market notes: the feature is not deployed",
    none_active: "Market notes: none active",
  });

export const EXIT_REASON_WORDS: Readonly<Record<GoLiveExitReason, string>> =
  Object.freeze({
    loser_3_trading_days_before_expiry:
      "Loser: closes 3 trading days before expiry",
    monthly_roll: "Monthly roll: closes the old spread",
    winner_expiry_day_1545_et: "Open winner: closes 15:45 ET on expiry day",
  });

// ---------- time ----------

const ET_CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  timeZone: "America/New_York",
});
const ET_DAY = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});

/** "HH:MM ET" (New York wall clock). */
export const etClock = (value: Date): string => `${ET_CLOCK.format(value)} ET`;

/** "YYYY-MM-DD HH:MM ET" for a decision, which may be read on a later day. */
export const etDayClock = (value: Date): string =>
  `${ET_DAY.format(value)} ${etClock(value)}`;

/** An option expiry "YYYYMMDD" as "YYYY-MM-DD". Any other text is shown unchanged. */
export const expiryDate = (expiry: string): string =>
  expiry.replace(/^(\d{4})(\d{2})(\d{2})$/u, "$1-$2-$3");

// ---------- plan ----------

export const planTitle = (plan: GoLivePlanOutput): string =>
  `${plan.name} (version ${plan.version})`;

export const planStatusText = (
  plan: Pick<GoLivePlanOutput, "approvalBasis" | "status">
): string => {
  if (plan.status === "proposed") return "Plan not approved";
  if (plan.status === "retired") return "Plan retired";
  if (plan.approvalBasis === "owner_decision")
    return "Plan approved by the owner";
  if (plan.approvalBasis === "owner_delegation")
    return "Plan approved by delegation (the owner delegated the allocation choice)";
  // The seed script never writes this; the page still does not call it an owner approval.
  return "Plan marked approved, approval basis not recorded";
};

export type GoLiveLabelValue = Readonly<{ label: string; value: string }>;

const accountPct = (value: number): string =>
  `${pct(value, Number.isInteger(value) ? 0 : 2)} of the account`;

export const planLimitRows = (
  limits: GoLivePlanLimits
): readonly GoLiveLabelValue[] => [
  { label: "Risk per position", value: accountPct(limits.positionRiskPct) },
  { label: "Open risk cap", value: accountPct(limits.openRiskCapPct) },
  { label: "Per-name cap", value: accountPct(limits.nameRiskCapPct) },
  { label: "Max positions", value: String(limits.maxPositions) },
];

export type GoLiveSleeveRow = Readonly<{
  budget: string;
  key: string;
  name: string;
  note: string;
  structure: string;
  symbols: string;
}>;

export const sleeveRow = (sleeve: GoLivePlanSleeve): GoLiveSleeveRow => ({
  budget: accountPct(sleeve.budgetPct),
  key: sleeve.key,
  name: sleeve.name,
  note: sleeve.definitionNote,
  structure: STRUCTURE_WORDS[sleeve.structure],
  symbols: sleeve.symbols.join(", "),
});

// ---------- status row ----------

/** Account value in words. A missing value is named with its reason and is never shown as 0. */
export const accountText = (account: GoLiveQueueOutput["account"]): string => {
  if (account.netLiquidation === null)
    return `Account value not available: ${account.unavailableReason ?? "no reason reported"}`;
  const value = usd(account.netLiquidation);
  return account.asOf === null
    ? `Account value: ${value} (time not reported)`
    : `Account value: ${value} as of ${etClock(account.asOf)}`;
};

export const nodeText = (node: GoLiveQueueOutput["node"]): string =>
  `${NODE_BADGE_WORDS[node.badge]} (checked ${etClock(node.checkedAt)})`;

export const generatorText = (
  queue: Pick<GoLiveQueueOutput, "drafts" | "generatedAt" | "tradingDay">
): string => {
  if (queue.generatedAt === null)
    return `Generator has not reported for ${queue.tradingDay}`;
  const count = queue.drafts.length;
  return `Generator ran at ${etClock(queue.generatedAt)}: ${count} ${count === 1 ? "draft" : "drafts"}`;
};

// ---------- drafts ----------

export type GoLiveDraftGroups = Readonly<{
  entrySignal: readonly GoLiveDraftOutput[];
  exits: readonly GoLiveDraftOutput[];
  modelHolds: readonly GoLiveDraftOutput[];
}>;

/** Exit drafts, entry drafts whose rule fired today, and every other entry draft. */
export const groupDrafts = (
  drafts: readonly GoLiveDraftOutput[]
): GoLiveDraftGroups => {
  const exits = drafts.filter((draft) => draft.kind === "exit");
  const entries = drafts.filter((draft) => draft.kind !== "exit");
  return {
    entrySignal: entries.filter((draft) => draft.entryBasis === "signal_today"),
    exits,
    modelHolds: entries.filter((draft) => draft.entryBasis !== "signal_today"),
  };
};

export const strikesText = (
  draft: Pick<GoLiveDraftOutput, "longStrike" | "shortStrike">
): string =>
  `long ${price(draft.longStrike)} / short ${price(draft.shortStrike)}`;

export const quoteText = (quote: GoLiveQuote | null): string =>
  quote === null
    ? "No quote"
    : `${QUOTE_SOURCE_WORDS[quote.source]}, as of ${etClock(quote.asOf)}`;

/** Net limit per spread: positive is a debit paid, negative is a credit received. */
export const limitText = (limitPrice: number | null): string => {
  if (limitPrice === null) return "no limit: no quote";
  return `${limitPrice < 0 ? "credit" : "debit"} ${Math.abs(limitPrice).toFixed(2)}`;
};

/** The quantity with its sizing reason. 0 always shows why. */
export const quantityText = (
  sizing: Pick<GoLiveSizing, "quantity" | "reason">
): string => `${sizing.quantity} (${SIZING_REASON_WORDS[sizing.reason]})`;

export const maxLossText = (
  sizing: Pick<GoLiveSizing, "maxLoss" | "maxLossPctNlv" | "reason">
): string => {
  if (sizing.maxLoss === null)
    return `not available: ${
      sizing.reason === "sized"
        ? "no max loss was computed"
        : SIZING_REASON_WORDS[sizing.reason]
    }`;
  const dollars = usd(sizing.maxLoss, 2);
  return sizing.maxLossPctNlv === null
    ? `${dollars} (% of account not available: the account value is not available)`
    : `${dollars} (${pct(sizing.maxLossPctNlv)} of account)`;
};

export type GoLivePreCheckView = Readonly<{
  decision: string;
  enginePolicy: string;
  reasons: readonly string[];
}>;

/** The web final gate decision with its reasons verbatim, and the fixed engine policy line. */
export const preCheckView = (
  preCheck: GoLiveDraftOutput["preCheck"]
): GoLivePreCheckView => {
  const gate = preCheck.webFinalGate;
  return {
    decision:
      gate === null
        ? "Web final gate: not run (no sized order to check)"
        : `Web final gate: ${gate.decision}`,
    enginePolicy: ENGINE_POLICY_LINE,
    reasons: gate === null ? [] : gate.reasons,
  };
};

export const noteText = (note: GoLiveDraftOutput["notes"][number]): string =>
  `${note.theme}: ${note.stance}${note.verified ? "" : " (unverified)"}`;

/** "Decided <day> <time> ET by <who>", or null while nobody has decided. */
export const decisionText = (
  draft: Pick<GoLiveDraftOutput, "decidedAt" | "decidedBy">
): string | null => {
  if (draft.decidedAt === null) return null;
  const who = draft.decidedBy === null ? "" : ` by ${draft.decidedBy}`;
  return `Decided ${etDayClock(draft.decidedAt)}${who}`;
};

/** Why Approve is disabled, in words. Empty means the draft can be approved. */
export const approveBlockers = (
  draft: Pick<GoLiveDraftOutput, "notApprovable" | "order">
): readonly string[] => {
  const reasons = draft.notApprovable.map(
    (value) => NOT_APPROVABLE_WORDS[value]
  );
  // Approve repeats the exact order; without one there is nothing to confirm.
  return reasons.length === 0 && draft.order === null
    ? [NO_SIZED_ORDER_REASON]
    : reasons;
};

const RIGHT_WORDS = { C: "call", P: "put" } as const;

/** One line per leg of the exact order, as the owner would place it. */
export const orderLegLines = (order: GoLiveOrder): readonly string[] =>
  order.legs.map(
    (leg) =>
      `${leg.side} ${leg.ratio} ${order.symbol} ${expiryDate(leg.expiry)} ${price(leg.strike)} ${RIGHT_WORDS[leg.right]}`
  );

/** The rows of the confirm dialog: the exact order and its max loss. */
export const orderSummaryRows = (
  order: GoLiveOrder,
  sizing: Pick<GoLiveSizing, "maxLoss" | "maxLossPctNlv" | "reason">
): readonly GoLiveLabelValue[] => [
  { label: "Quantity", value: String(order.quantity) },
  { label: "Limit", value: limitText(order.limitPrice) },
  { label: "Max loss", value: maxLossText(sizing) },
];

// ---------- errors ----------

/** The API's own message when it has one, otherwise a plain fallback. */
export const apiErrorText = (error: unknown): string => {
  const message =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "message")
      : undefined;
  return typeof message === "string" && message.trim() !== ""
    ? message.trim()
    : "The request failed.";
};
