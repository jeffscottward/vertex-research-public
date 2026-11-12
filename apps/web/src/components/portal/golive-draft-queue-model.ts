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
export type GoLiveExitRule = GoLiveDraftOutput["exitRule"];
type GoLiveOrder = NonNullable<GoLiveDraftOutput["order"]>;
type GoLiveGate = NonNullable<GoLiveDraftOutput["preCheck"]["webFinalGate"]>;
type GoLiveGateDecision = GoLiveGate["decision"];
type GoLiveJevStance = NonNullable<GoLiveGate["jevStance"]>;
type GoLiveJevState = GoLiveGate["jevState"];

/**
 * The `never` check of an exhaustive switch. A value this build does not know (a newer server)
 * gets the fallback at run time instead of a crash; at compile time a missing case is an error.
 */
const unhandled = <Fallback>(_value: never, fallback: Fallback): Fallback =>
  fallback;

// ---------- fixed sentences ----------

// The order ticket is the "Vertex orders" tab of the Portfolio page (portfolio-tabs.tsx, tab value
// "orders"); ?tab= opens it directly. "Orders & stops" is only the table of open orders.
export const ORDER_TICKET_TAB_VALUE = "orders";
export const ORDER_TICKET_TAB_LABEL = "Vertex orders";
export const PORTFOLIO_HREF = `/portfolio?tab=${ORDER_TICKET_TAB_VALUE}`;
// The notice in three parts, so the page can make the page name a link to that tab.
export const NO_ORDERS_NOTICE_PARTS = Object.freeze({
  after: ` and use the ${ORDER_TICKET_TAB_LABEL} tab.`,
  before:
    "This page sends no orders. Approve records your decision and places nothing. To place an order yourself, open ",
  link: "Portfolio",
});
export const NO_ORDERS_NOTICE = `${NO_ORDERS_NOTICE_PARTS.before}${NO_ORDERS_NOTICE_PARTS.link}${NO_ORDERS_NOTICE_PARTS.after}`;
export const APPROVAL_NOT_SENT_SENTENCE =
  "This records your approval. It does not send the order.";
export const REJECTION_RECORD_SENTENCE =
  "This records your rejection with the note. It changes no order.";
export const NODE_DISARMED_NOTE =
  "A disarmed node does not stop an order placed on the Portfolio order screen; only the kill switch does.";
export const EXIT_RULE_WORDS: Readonly<Record<GoLiveExitRule, string>> =
  Object.freeze({
    owner_standing_rule_v1:
      "Owner exit rule (nothing here closes a position; you close it): let winners run to expiry; close losers 3 trading days before expiry; close open winners at 15:45 ET on expiry day.",
  });
export const ENGINE_POLICY_LINE =
  "Engine policy (arm_gate): not part of the web order path; not evaluated here.";
export const NO_PLAN_TEXT = "No plan record";
export const NO_ENTRY_SIGNAL_TEXT =
  "No entry signal today under the plan's entry rule.";
export const ENTRY_SIGNAL_GROUP_TITLE = "Entry signal today";
export const MODEL_HOLDS_GROUP_TITLE =
  "Model holds, account does not (late entry not tested, cannot be approved)";
export const EXIT_GROUP_TITLE =
  "Exit proposals under the owner exit rule (you close the position)";
export const OTHER_GROUP_TITLE = "Other drafts (cannot be approved)";
export const NO_ENTRY_BASIS_REASON =
  "The draft has no entry basis recorded, so it is not tied to a tested entry";
export const SIGNED_OUT_TEXT =
  "You are signed out: the session has ended. Sign in again.";
export const CURRENT_SIZING_LABEL =
  "Current indicative sizing (recomputed now; not the approved order)";
export const APPROVED_ORDER_NOT_STORED =
  "Not stored with this approval, so the approved order cannot be shown.";
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
  // The cause depends on the quote: notApprovableText gives it.
  NO_LIVE_IBKR_QUOTE: "No live IBKR quote",
  PLAN_NOT_APPROVED: "The plan is not approved",
  PRECHECK_DENIED: "The dry pre-check (web final gate) denied the order",
  SIZED_TO_ZERO: "The quantity is 0",
});

export const NODE_BADGE_WORDS: Readonly<Record<GoLiveNodeBadge, string>> =
  Object.freeze({
    down: "Node down",
    "running-armed": "Node running, armed",
    "running-disarmed": "Node running, disarmed",
    unknown: "Node state unknown: the node status could not be read",
  });

export const DRAFT_STATE_WORDS: Readonly<
  Record<GoLiveDraftStateValue, string>
> = Object.freeze({
  approved: "Approved (recorded). Not sent: this page sends no orders.",
  expired: "Expired: the generator no longer wants this draft",
  proposed: "Proposed by the generator, not decided",
  rejected: "Rejected by the owner (recorded)",
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
      "Proposal to close: losing position, 3 trading days before expiry",
    monthly_roll: "Proposal to close the old spread: monthly roll",
    winner_expiry_day_1545_et:
      "Proposal to close: open winner, 15:45 ET on expiry day",
  });

export const PRECHECK_DECISION_WORDS: Readonly<
  Record<GoLiveGateDecision, string>
> = Object.freeze({ allow: "allow", deny: "deny" });

export const JEV_STANCE_WORDS: Readonly<Record<GoLiveJevStance, string>> =
  Object.freeze({
    BEARISH: "bearish",
    BULLISH: "bullish",
    NEUTRAL: "neutral",
  });

export const JEV_STATE_WORDS: Readonly<Record<GoLiveJevState, string>> =
  Object.freeze({
    fresh: "the JEV read is fresh",
    none: "there is no JEV read",
    stale: "the JEV read is stale",
    unreachable: "JEV could not be reached",
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
  switch (plan.status) {
    case "proposed":
      return "Plan not approved";
    case "retired":
      return "Plan retired";
    case "approved":
      switch (plan.approvalBasis) {
        case "owner_decision":
          return "Plan approved by the owner";
        case "owner_delegation":
          return "Plan approved by delegation (the owner delegated the allocation choice)";
        case null:
          // The seed script never writes this; the page still does not call it an owner approval.
          return "Plan marked approved, approval basis not recorded";
        default:
          return unhandled(
            plan.approvalBasis,
            "Plan marked approved, approval basis not known to this page"
          );
      }
    default:
      return unhandled(
        plan.status,
        "Plan status not known to this page, so the plan is not treated as approved"
      );
  }
};

/** A link target only when it is an absolute https URL; anything else is not rendered as a link. */
export const safeHttpsUrl = (value: string | null): string | null => {
  if (value === null) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
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

export type GoLiveDraftGroupKey =
  | "entrySignal"
  | "exits"
  | "modelHolds"
  | "other";
export type GoLiveDraftGroups = Readonly<
  Record<GoLiveDraftGroupKey, readonly GoLiveDraftOutput[]>
>;

/**
 * The one group of a draft. The group heading and the Approve button both follow from it
 * (approveBlockers), so a heading that says "cannot be approved" never sits over an enabled Approve.
 */
export const draftGroupOf = (
  draft: Pick<GoLiveDraftOutput, "entryBasis" | "kind">
): GoLiveDraftGroupKey => {
  switch (draft.kind) {
    case "exit":
      return "exits";
    case "entry":
      switch (draft.entryBasis) {
        case "signal_today":
          return "entrySignal";
        case "model_holds_account_does_not":
          return "modelHolds";
        case null:
          return "other";
        default:
          return unhandled(draft.entryBasis, "other");
      }
    default:
      return unhandled(draft.kind, "other");
  }
};

/** Every draft in exactly one group: none is dropped and none is listed twice. */
export const groupDrafts = (
  drafts: readonly GoLiveDraftOutput[]
): GoLiveDraftGroups => {
  const of = (key: GoLiveDraftGroupKey): readonly GoLiveDraftOutput[] =>
    drafts.filter((draft) => draftGroupOf(draft) === key);
  return {
    entrySignal: of("entrySignal"),
    exits: of("exits"),
    modelHolds: of("modelHolds"),
    other: of("other"),
  };
};

export const strikesText = (
  draft: Pick<GoLiveDraftOutput, "longStrike" | "shortStrike">
): string =>
  `long ${price(draft.longStrike)} / short ${price(draft.shortStrike)}`;

/** The quote source with its date and time in New York, so an old quote is seen as old. */
export const quoteText = (quote: GoLiveQuote | null): string =>
  quote === null
    ? "No quote: none was recorded for this draft"
    : `${QUOTE_SOURCE_WORDS[quote.source]}, as of ${etDayClock(quote.asOf)}`;

/** Why there is no live IBKR quote, from the quote the draft has. */
export const noLiveQuoteReason = (quote: GoLiveQuote | null): string => {
  const lead = NOT_APPROVABLE_WORDS.NO_LIVE_IBKR_QUOTE;
  if (quote === null) return `${lead}: no quote was recorded for this draft`;
  switch (quote.source) {
    case "yahoo_delayed_snapshot":
      return `${lead}: the price shown is a Yahoo snapshot, delayed 15 minutes`;
    case "model":
      return `${lead}: the price shown is a model price, not a market quote`;
    case "ibkr_live":
      return `${lead}: the IBKR quote shown is too old to count as live`;
    default:
      return unhandled(
        quote.source,
        `${lead}: the quote source is not known to this page`
      );
  }
};

/** One blocker in words. The quote blocker names the cause for this draft's quote. */
const notApprovableText = (
  value: GoLiveNotApprovable,
  quote: GoLiveQuote | null
): string =>
  value === "NO_LIVE_IBKR_QUOTE"
    ? noLiveQuoteReason(quote)
    : NOT_APPROVABLE_WORDS[value];

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

/** The live numbers of a draft in one line, for a row whose approved order is shown separately. */
export const currentSizingText = (sizing: GoLiveSizing): string =>
  `limit ${limitText(sizing.limitPrice)}; quantity ${quantityText(sizing)}; max loss ${maxLossText(sizing)}`;

export type GoLivePreCheckView = Readonly<{
  decision: string;
  enginePolicy: string;
  reasons: readonly string[];
  /** The JEV stance the gate used with the state of that read; null when the gate did not run. */
  stance: string | null;
}>;

/**
 * The dry web final gate decision with its reasons verbatim, and the fixed engine policy line.
 * The decision line says what the dry run leaves out and that it is not a clearance to send.
 */
export const preCheckView = (
  preCheck: GoLiveDraftOutput["preCheck"]
): GoLivePreCheckView => {
  const gate = preCheck.webFinalGate;
  return {
    decision:
      gate === null
        ? "Dry pre-check (web final gate): not run, because there is no sized order to check."
        : `Dry pre-check (web final gate; positions, kill switch and options-only gate not included): ${PRECHECK_DECISION_WORDS[gate.decision]}. Not a clearance to send.`,
    enginePolicy: ENGINE_POLICY_LINE,
    reasons: gate === null ? [] : gate.reasons,
    stance:
      gate === null
        ? null
        : `JEV stance used by the check: ${
            gate.jevStance === null ? "none" : JEV_STANCE_WORDS[gate.jevStance]
          } (${JEV_STATE_WORDS[gate.jevState]})`,
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
  draft: Pick<
    GoLiveDraftOutput,
    "entryBasis" | "kind" | "notApprovable" | "order" | "quote"
  >
): readonly string[] => {
  const reasons = draft.notApprovable.map((value) =>
    notApprovableText(value, draft.quote)
  );
  // The group heading says these cannot be approved, so the button is blocked here as well,
  // whatever the server listed.
  const group = draftGroupOf(draft);
  if (
    group === "modelHolds" &&
    !draft.notApprovable.includes("LATE_ENTRY_NOT_TESTED")
  )
    reasons.push(NOT_APPROVABLE_WORDS.LATE_ENTRY_NOT_TESTED);
  if (group === "other") reasons.push(NO_ENTRY_BASIS_REASON);
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

export type GoLiveApprovedOrderView = Readonly<{
  label: string;
  legs: readonly string[];
  /** Set when the approval has no stored order; legs and rows are then empty. */
  missing: string | null;
  rows: readonly GoLiveLabelValue[];
}>;

/**
 * The order stored with the approval. null unless the draft is approved. The live sizing of the
 * row is recomputed at every read and can differ from this order.
 */
export const approvedOrderView = (
  draft: Pick<GoLiveDraftOutput, "approvedOrder" | "decidedAt" | "state">
): GoLiveApprovedOrderView | null => {
  if (draft.state !== "approved") return null;
  const recorded =
    draft.decidedAt === null
      ? "time not recorded"
      : etDayClock(draft.decidedAt);
  const label = `Approved order (recorded ${recorded})`;
  const order = draft.approvedOrder;
  return order === null
    ? { label, legs: [], missing: APPROVED_ORDER_NOT_STORED, rows: [] }
    : {
        label,
        legs: orderLegLines(order),
        missing: null,
        rows: [
          { label: "Quantity", value: String(order.quantity) },
          { label: "Limit", value: limitText(order.limitPrice) },
        ],
      };
};

export type GoLiveKeyedLine = Readonly<{ key: string; text: string }>;

/** A unique React key per line, also when two lines have the same text. */
export const keyedLines = (
  lines: readonly string[]
): readonly GoLiveKeyedLine[] => {
  const seen = new Map<string, number>();
  return lines.map((text) => {
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return { key: `${count}:${text}`, text };
  });
};

// ---------- errors ----------

const errorField = (error: unknown, key: string): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const value: unknown = Reflect.get(error, key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

/** True when the API answered CONFLICT: the draft or its order changed since the page loaded it. */
export const isConflict = (error: unknown): boolean =>
  errorField(error, "code") === "CONFLICT";

/** A signed-out session in plain words; else the API's own message; else a plain fallback. */
export const apiErrorText = (error: unknown): string =>
  errorField(error, "code") === "UNAUTHORIZED"
    ? SIGNED_OUT_TEXT
    : (errorField(error, "message") ?? "The request failed.");

const NOT_APPROVABLE_CODES = Object.keys(
  NOT_APPROVABLE_WORDS
) as readonly GoLiveNotApprovable[];
const NOT_APPROVABLE_CODE_PATTERN = new RegExp(
  `\\b(?:${NOT_APPROVABLE_CODES.join("|")})\\b`,
  "gu"
);
const isNotApprovableCode = (value: string): value is GoLiveNotApprovable =>
  NOT_APPROVABLE_CODES.some((code) => code === value);
const lowerFirst = (text: string): string =>
  `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/**
 * A failed approve or reject in words. Blocker codes in the API message (PRECHECK_DENIED, ...)
 * are replaced by the same words the row shows; a signed-out session is named as such.
 */
export const decisionErrorText = (
  error: unknown,
  quote: GoLiveQuote | null
): string => {
  const text = apiErrorText(error);
  if (text === SIGNED_OUT_TEXT) return `${text} Nothing was recorded.`;
  const matches: readonly string[] =
    text.match(NOT_APPROVABLE_CODE_PATTERN) ?? [];
  const codes = matches.filter(isNotApprovableCode);
  if (codes.length === 0) return text;
  const words = [...new Set(codes)].map((code) =>
    lowerFirst(notApprovableText(code, quote))
  );
  return `The draft cannot be approved: ${words.join("; ")}.`;
};
