import {
  AGENT_OPS_API_ERRORS,
  type GOLIVE_DRAFT_STATE_VALUES,
  type GOLIVE_EXIT_REASON_VALUES,
  type GOLIVE_NODE_BADGE_VALUES,
  type GOLIVE_NOT_APPROVABLE_VALUES,
  GOLIVE_QUOTE_MAX_SPREAD_SHARE,
  type GOLIVE_QUOTE_SOURCE_VALUES,
  GOLIVE_QUOTE_SPREAD_FLOOR,
  type GOLIVE_SIZING_REASON_VALUES,
  type GOLIVE_STRUCTURE_VALUES,
  type GoLiveDraftOutput,
  type GoLivePlanLimits,
  type GoLivePlanOutput,
  type GoLivePlanSleeve,
  type GoLiveQueueOutput,
  type GoLiveQuote,
  type GoLiveSizing,
  type VertexOrderResult,
} from "@darkfactory/api";

import { pct, price, usd } from "./portfolio-monitor-model.ts";

// Pure wording and derivation for the go-live order draft queue (/drafts). No React, no I/O.
// Every enum of the contract has one exhaustive Record here, typed from the contract array, so a
// new enum value is a type error until it has words. The browser client does not validate an
// answer, so a newer server's value can still arrive at run time: every lookup goes through
// wordsOf, which names the raw value instead of printing "undefined" or a blank.

type GoLiveStructure = (typeof GOLIVE_STRUCTURE_VALUES)[number];
type GoLiveQuoteSource = (typeof GOLIVE_QUOTE_SOURCE_VALUES)[number];
type GoLiveSizingReason = (typeof GOLIVE_SIZING_REASON_VALUES)[number];
type GoLiveNotApprovable = (typeof GOLIVE_NOT_APPROVABLE_VALUES)[number];
type GoLiveNodeBadge = (typeof GOLIVE_NODE_BADGE_VALUES)[number];
type GoLiveDraftStateValue = (typeof GOLIVE_DRAFT_STATE_VALUES)[number];
type GoLiveExitReason = (typeof GOLIVE_EXIT_REASON_VALUES)[number];
type GoLiveMarketNotes = GoLiveQueueOutput["marketNotes"];
type GoLiveExitRule = GoLiveDraftOutput["exitRule"];
type GoLiveOrder = NonNullable<GoLiveDraftOutput["order"]>;
type GoLiveGate = NonNullable<GoLiveDraftOutput["preCheck"]["webFinalGate"]>;
type GoLiveGateDecision = GoLiveGate["decision"];
type GoLiveJevStance = NonNullable<GoLiveGate["jevStance"]>;
type GoLiveJevState = GoLiveGate["jevState"];
type GoLiveOptionRight = GoLiveOrder["legs"][number]["right"];
type GoLiveApiErrorCode = keyof typeof AGENT_OPS_API_ERRORS;

/** A value this page version has no words for (a newer server), named with the raw value. */
export const notKnownText = (raw: unknown): string =>
  `not known to this page version (${String(raw)})`;

/**
 * The `never` check of an exhaustive switch. A value this build does not know (a newer server)
 * gets the fallback at run time instead of a crash; at compile time a missing case is an error.
 */
const unhandled = <Fallback>(_value: never, fallback: Fallback): Fallback =>
  fallback;

/** The raw text of a value that reached a `never` branch at run time. */
const rawOf = (value: never): string => String(value);

/** True when the map has words for the value. A property every object has is not a known value. */
const isKnown = <Key extends string>(
  words: Readonly<Record<Key, unknown>>,
  value: unknown
): value is Key => typeof value === "string" && Object.hasOwn(words, value);

/** The words of a contract value, or the raw value named as not known. Never undefined. */
const wordsOf = <Key extends string>(
  words: Readonly<Record<Key, string>>,
  value: Key,
  prefix = ""
): string =>
  isKnown(words, value) ? words[value] : `${prefix}${notKnownText(value)}`;

// ---------- fixed sentences ----------

// The live order screen is the "Vertex orders" tab of the Portfolio page (portfolio-tabs.tsx, tab
// value "orders"); ?tab= opens it directly. That screen mounts the vertical ticket in simulated
// mode only (vertex-orders.tsx), so on the live account no Vertex screen opens a vertical spread:
// the notice must not point the owner there to place an approved draft. The model test reads both
// sources and fails when either fact changes; the notice is then rewritten.
export const VERTEX_ORDERS_TAB_VALUE = "orders";
export const VERTEX_ORDERS_TAB_LABEL = "Vertex orders";
export const PORTFOLIO_HREF = `/portfolio?tab=${VERTEX_ORDERS_TAB_VALUE}`;
// The notice in three parts, so the page can make the page name a link to that tab.
export const NO_ORDERS_NOTICE_PARTS = Object.freeze({
  after: `, ${VERTEX_ORDERS_TAB_LABEL} tab) has no vertical ticket and takes single option orders only (buy to open, sell to close). Placing a vertical by hand at IBKR is outside Vertex and its checks.`,
  before:
    "Approve records your decision. It sends nothing today: sending waits until engine policy v3 checks the live path (owner 2026-11-12). Then Approve will send that exact order to IBKR as one combo limit order, only while you have ARMED the execution node and only inside the plan caps (4% total, 2% per name, 1% per position). The live order screen (",
  link: "Portfolio",
});
export const NO_ORDERS_NOTICE = `${NO_ORDERS_NOTICE_PARTS.before}${NO_ORDERS_NOTICE_PARTS.link}${NO_ORDERS_NOTICE_PARTS.after}`;
export const APPROVAL_NOT_SENT_SENTENCE =
  "This records your approval. It sends nothing until engine policy v3 checks the live path; then it sends this exact order as one combo limit order, only if the execution node is armed and the plan caps allow it.";
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
export const NO_PLAN_TEXT =
  "No plan record: no proposed or approved plan is stored";
export const MODEL_HOLDS_GROUP_TITLE =
  "Model holds, account does not (late entry, outside the tested entry rule: approve only with the tick box)";
export const EXIT_GROUP_TITLE =
  "Exit proposals under the owner exit rule (you close the position)";
export const OTHER_GROUP_TITLE = "Other drafts (cannot be approved)";
export const NO_ENTRY_BASIS_REASON =
  "The draft has no entry basis recorded, so it is not tied to a tested entry";
export const SIGNED_OUT_TEXT =
  "You are signed out: the session has ended. Sign in again.";
export const CURRENT_SIZING_LABEL =
  "Current indicative sizing (recomputed now; not the approved order)";
export const CURRENT_QUOTE_LABEL =
  "Quote (current value, not the value at approval)";
export const CURRENT_PRECHECK_LABEL =
  "Pre-check (current value, not the value at approval)";
// The server refuses the whole queue for a browser session when a stored approved order is
// missing, and leaves the order out for an API key. So an approved draft without an order means
// "left out of this answer", never "not stored".
export const APPROVED_ORDER_NOT_SHOWN =
  "This answer carries no approved order, so it cannot be shown here. The server withholds it from API key callers.";
export const NO_SIZED_ORDER_REASON = "No sized order to approve";
export const OWNER_ONLY_DECISION_TEXT =
  "Only the owner can approve or reject a draft.";
export const REJECT_NOTE_REQUIRED = "A note is required to reject a draft.";
// The server counts an IBKR quote as live for this long (GOLIVE_QUOTE_MAX_AGE_MS in
// packages/api/src/server/golive-drafts-sizing.ts; the model test compares the two).
export const LIVE_QUOTE_MAX_AGE_SECONDS = 120;

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

/**
 * The server's two limits for a usable leg quote, in words: its bid-ask spread is too wide only
 * when it is wider than `share` of its mid AND wider than `floor` dollars.
 */
export const wideSpreadWords = (share: number, floor: number): string =>
  `wider than ${share === 0.5 ? "half" : `${share * 100}% of`} its mid and wider than $${floor.toFixed(2)}`;

// Both numbers in the no_quote sentence come from the contract.
const MAX_SPREAD_WORDS = wideSpreadWords(
  GOLIVE_QUOTE_MAX_SPREAD_SHARE,
  GOLIVE_QUOTE_SPREAD_FLOOR
);

export const SIZING_REASON_WORDS: Readonly<Record<GoLiveSizingReason, string>> =
  Object.freeze({
    budget_below_one_spread:
      "the risk budget for one position is below the max loss of one spread",
    max_positions_reached: "the plan's maximum number of positions is reached",
    name_cap_reached: "the per-name risk cap is reached",
    nlv_unavailable: "the account value is not available",
    // Every cause the server sizes as no_quote, not only a missing quote.
    no_quote: `there is no usable quote: none was recorded, a leg has no bid or no ask, a leg is crossed (bid above ask), a leg has a bid-ask spread ${MAX_SPREAD_WORDS}, or the net price is not between 0 and the strike width`,
    open_risk_cap_reached: "the open risk cap is reached",
    quantity_above_order_limit:
      "the budget buys more spreads than one order may hold, and the draft is not reduced",
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
  // The cause depends on the plan in force: notApprovableText gives it.
  PLAN_NOT_APPROVED: "The plan is not approved",
  PRECHECK_DENIED: "The dry pre-check (web final gate) denied the order",
  SIZED_TO_ZERO: "The quantity is 0",
});

export const NODE_BADGE_WORDS: Readonly<Record<GoLiveNodeBadge, string>> =
  Object.freeze({
    down: "Node down: its container is stopped or missing",
    "running-armed": "Node running, armed",
    "running-disarmed": "Node running, disarmed",
    unknown:
      "Node state unknown: the node status could not be read or was incomplete",
  });

export const DRAFT_STATE_WORDS: Readonly<
  Record<GoLiveDraftStateValue, string>
> = Object.freeze({
  // "Not sent" would be false once the owner has placed the order by hand: only this page is meant.
  approved:
    "Approved (recorded). This page did not send it: it sends no orders.",
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

const RIGHT_WORDS: Readonly<Record<GoLiveOptionRight, string>> = Object.freeze({
  C: "call",
  P: "put",
});

export const structureText = (value: GoLiveStructure): string =>
  wordsOf(STRUCTURE_WORDS, value);
export const draftStateText = (value: GoLiveDraftStateValue): string =>
  wordsOf(DRAFT_STATE_WORDS, value);
export const marketNotesText = (value: GoLiveMarketNotes): string =>
  wordsOf(MARKET_NOTES_WORDS, value, "Market notes: status ");
export const exitReasonText = (value: GoLiveExitReason): string =>
  wordsOf(EXIT_REASON_WORDS, value);
export const exitRuleText = (value: GoLiveExitRule): string =>
  wordsOf(EXIT_RULE_WORDS, value);
const sizingReasonText = (value: GoLiveSizingReason): string =>
  wordsOf(SIZING_REASON_WORDS, value, "sizing reason ");
const nodeBadgeText = (value: GoLiveNodeBadge): string =>
  wordsOf(NODE_BADGE_WORDS, value, "Node state ");

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

/** "YYYY-MM-DD HH:MM ET" (New York). Every time on the page carries its date. */
export const etDayClock = (value: Date): string =>
  `${ET_DAY.format(value)} ${ET_CLOCK.format(value)} ET`;

/** An option expiry "YYYYMMDD" as "YYYY-MM-DD". Any other text is shown unchanged. */
export const expiryDate = (expiry: string): string =>
  expiry.replace(/^(\d{4})(\d{2})(\d{2})$/u, "$1-$2-$3");

/** The page has no polling: the line says so and when the queue on screen was loaded. */
export const loadedText = (loadedAt: Date): string =>
  `This page does not refresh on its own. Loaded ${etDayClock(loadedAt)}.`;

// ---------- plan ----------

export const planTitle = (plan: GoLivePlanOutput): string =>
  `${plan.name} (version ${plan.version})`;

export const planStatusText = (
  plan: Pick<GoLivePlanOutput, "approvalBasis" | "status">
): string => {
  switch (plan.status) {
    case "proposed":
      return "Plan proposed, not approved: no owner approval is recorded for it";
    case "retired":
      // The queue answers only a proposed or an approved plan; kept as the fallback.
      return "Plan retired, so it is not in force and is not treated as approved";
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
            `Plan marked approved, approval basis ${notKnownText(rawOf(plan.approvalBasis))}`
          );
      }
    default:
      return unhandled(
        plan.status,
        `Plan status ${notKnownText(rawOf(plan.status))}, so the plan is not treated as approved`
      );
  }
};

/**
 * A link target only when it is an absolute https URL with a host; anything else is not rendered
 * as a link. The URL parser alone accepts "https:example.com" and "https:/x", which a browser
 * resolves on the app's own origin, so the text itself must start with "https://<host>".
 */
export const safeHttpsUrl = (value: string | null): string | null =>
  value !== null && /^https:\/\/[^/\s]/u.test(value) && parsesAsHttps(value)
    ? value
    : null;

/** True when the URL parser accepts the text as an https URL. A text it rejects is no link. */
const parsesAsHttps = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
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
  structure: structureText(sleeve.structure),
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
    : `Account value: ${value} as of ${etDayClock(account.asOf)}`;
};

export const nodeText = (node: GoLiveQueueOutput["node"]): string =>
  `${nodeBadgeText(node.badge)} (checked ${etDayClock(node.checkedAt)})`;

/**
 * What the generator reported. A refused run posts nothing, so "has not reported" names both
 * causes. The count is every draft listed for the day, and says so.
 */
export const generatorText = (
  queue: Pick<GoLiveQueueOutput, "drafts" | "generatedAt" | "tradingDay">
): string => {
  if (queue.generatedAt === null)
    return `The generator has not reported for ${queue.tradingDay}: it has not run yet, or its run was refused (the journal of vertex-golive-drafts.service on the rig says which).`;
  const count = queue.drafts.length;
  return `Generator ran at ${etDayClock(queue.generatedAt)}. ${count} ${count === 1 ? "draft is" : "drafts are"} listed for ${queue.tradingDay}, counting decided and expired drafts.`;
};

// ---------- drafts ----------

/** The plan in force and the server's clock at the queue read (node.checkedAt). */
export type GoLiveDraftContext = Readonly<{
  plan: Pick<
    GoLivePlanOutput,
    "approvalBasis" | "id" | "status" | "version"
  > | null;
  readAt: Date;
}>;

export type GoLiveDraftGroupKey =
  | "entrySignal"
  | "exits"
  | "modelHolds"
  | "other";
export type GoLiveDraftGroups = Readonly<
  Record<GoLiveDraftGroupKey, readonly GoLiveDraftOutput[]>
>;

/** The heading over all draft groups. The day is the order session day, not always today. */
export const draftsTitle = (tradingDay: string): string =>
  `Drafts for ${tradingDay} (the order session day)`;

export const entrySignalGroupTitle = (tradingDay: string): string =>
  `Entry signal for ${tradingDay}`;

/**
 * Why an entry group is empty. "No entry signal" is said only when the generator reported; with
 * no report the signals are not known, and with no plan record there is nothing to draft from.
 */
export const emptyGroupText = (
  group: "entrySignal" | "modelHolds",
  queue: Readonly<{
    generatedAt: Date | null;
    plan: Pick<GoLivePlanOutput, "approvalBasis" | "status"> | null;
    tradingDay: string;
  }>
): string => {
  const { generatedAt, plan, tradingDay } = queue;
  const entry = group === "entrySignal";
  if (plan === null)
    return entry
      ? `No plan record is stored, so there is no entry rule to draft from for ${tradingDay}.`
      : `No plan record is stored, so there is no model position to compare with the account for ${tradingDay}.`;
  const notApproved =
    plan.status === "approved"
      ? ""
      : ` ${planStatusText(plan)}, so no draft can be approved.`;
  if (generatedAt === null)
    return `${
      entry
        ? `The generator has not reported for ${tradingDay}, so entry signals are not known.`
        : `The generator has not reported for ${tradingDay}, so it is not known whether the model holds a position the account does not.`
    }${notApproved}`;
  const ran = `the generator ran at ${etDayClock(generatedAt)}`;
  return `${
    entry
      ? `No entry signal for ${tradingDay} under the plan's entry rule: ${ran} and reported no entry draft.`
      : `No late entry for ${tradingDay}: ${ran} and reported no position that the model holds and the account does not.`
  }${notApproved}`;
};

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

/** A strike or a price per share in dollars. */
const dollars = (value: number): string => `$${price(value)}`;

export const strikesText = (
  draft: Pick<GoLiveDraftOutput, "longStrike" | "shortStrike">
): string =>
  `long ${dollars(draft.longStrike)} / short ${dollars(draft.shortStrike)}`;

/**
 * The quote source with its date and time in New York, so an old quote is seen as old. An IBKR
 * quote is called live only when the server counted it as live (no NO_LIVE_IBKR_QUOTE blocker);
 * otherwise the label says whether it is too old or dated after the server's clock.
 */
export const quoteText = (
  draft: Pick<GoLiveDraftOutput, "notApprovable" | "quote">,
  readAt: Date
): string => {
  const { quote } = draft;
  if (quote === null) return "No quote: none was recorded for this draft";
  const asOf = `as of ${etDayClock(quote.asOf)}`;
  if (
    quote.source !== "ibkr_live" ||
    !draft.notApprovable.includes("NO_LIVE_IBKR_QUOTE")
  )
    return `${wordsOf(QUOTE_SOURCE_WORDS, quote.source, "quote source ")}, ${asOf}`;
  return quote.asOf.getTime() > readAt.getTime()
    ? `IBKR quote, not counted as live (its time is after the server's clock), ${asOf}`
    : `IBKR quote, too old to count as live (older than ${LIVE_QUOTE_MAX_AGE_SECONDS} s when the server read the queue), ${asOf}`;
};

/** Why there is no live IBKR quote, from the quote the draft has. */
export const noLiveQuoteReason = (
  quote: GoLiveQuote | null,
  readAt: Date
): string => {
  const lead = NOT_APPROVABLE_WORDS.NO_LIVE_IBKR_QUOTE;
  if (quote === null) return `${lead}: no quote was recorded for this draft`;
  switch (quote.source) {
    case "yahoo_delayed_snapshot":
      return `${lead}: the price shown is a Yahoo snapshot, delayed 15 minutes`;
    case "model":
      return `${lead}: the price shown is a model price, not a market quote`;
    case "ibkr_live":
      return quote.asOf.getTime() > readAt.getTime()
        ? `${lead}: the IBKR quote shown has a time after the server's clock, so it is not trusted`
        : `${lead}: the IBKR quote shown is older than ${LIVE_QUOTE_MAX_AGE_SECONDS} s, so it does not count as live`;
    default:
      return unhandled(
        quote.source,
        `${lead}: the quote source is ${notKnownText(rawOf(quote.source))}`
      );
  }
};

type GoLivePlanRef = Pick<GoLiveDraftOutput, "planId" | "planVersion">;

// The approval bases planStatusText has words for.
const APPROVAL_BASIS_KNOWN: Readonly<
  Record<NonNullable<GoLivePlanOutput["approvalBasis"]>, true>
> = { owner_decision: true, owner_delegation: true };

/**
 * Why the plan does not let this draft be approved, or null when the plan in force is approved
 * and is the plan the draft was made for. The same rule as the server's PLAN_NOT_APPROVED.
 */
const planProblem = (
  draft: GoLivePlanRef,
  plan: GoLiveDraftContext["plan"]
): string | null => {
  const lead = NOT_APPROVABLE_WORDS.PLAN_NOT_APPROVED;
  if (plan === null) return `${lead}: there is no plan record`;
  switch (plan.status) {
    case "approved":
      if (plan.id !== draft.planId || plan.version !== draft.planVersion)
        return `${lead} for this draft: it was drafted for plan ${draft.planId} version ${draft.planVersion}, and the plan in force is ${plan.id} version ${plan.version}`;
      // An approval on a basis this page version has no words for is not offered for Approve.
      return plan.approvalBasis === null ||
        isKnown(APPROVAL_BASIS_KNOWN, plan.approvalBasis)
        ? null
        : `The plan's approval basis is ${notKnownText(plan.approvalBasis)}`;
    case "proposed":
      return `${lead}: it is proposed`;
    case "retired":
      return `${lead}: it is retired`;
    default:
      return unhandled(
        plan.status,
        `${lead}: its status is ${notKnownText(rawOf(plan.status))}`
      );
  }
};

type GoLiveBlockerFacts = GoLivePlanRef & Pick<GoLiveDraftOutput, "quote">;

/** One blocker in words. The quote and plan blockers name the cause for this draft. */
const notApprovableText = (
  value: GoLiveNotApprovable,
  draft: GoLiveBlockerFacts,
  context: GoLiveDraftContext
): string => {
  if (value === "NO_LIVE_IBKR_QUOTE")
    return noLiveQuoteReason(draft.quote, context.readAt);
  if (value === "PLAN_NOT_APPROVED")
    return planProblem(draft, context.plan) ?? NOT_APPROVABLE_WORDS[value];
  return wordsOf(NOT_APPROVABLE_WORDS, value, "Blocker ");
};

/** "1 spread", "2 spreads": a quantity always says what it counts. */
const spreadsText = (quantity: number): string =>
  `${quantity} ${quantity === 1 ? "spread" : "spreads"}`;

/** A net price per spread in dollars: positive is a debit paid, negative is a credit received. */
const netPriceText = (limitPrice: number): string =>
  `$${Math.abs(limitPrice).toFixed(2)} ${limitPrice < 0 ? "credit" : "debit"} per spread`;

/**
 * The limit of the live sizing, or why there is none. The server sends no limit for more causes
 * than a bad quote (a missing account value, for one), so the cause is the sizing reason's own:
 * the quote is called unusable only when the reason is no_quote.
 */
export const limitText = (
  sizing: Pick<GoLiveSizing, "limitPrice" | "reason">
): string => {
  if (sizing.limitPrice !== null) return netPriceText(sizing.limitPrice);
  switch (sizing.reason) {
    case "no_quote":
      return "no limit: no usable quote";
    case "sized":
      return "no limit: no limit was computed";
    default:
      return `no limit: ${sizingReasonText(sizing.reason)}`;
  }
};

/** The quantity in spreads with its sizing reason. 0 always shows why. */
export const quantityText = (
  sizing: Pick<GoLiveSizing, "quantity" | "reason">
): string =>
  `${spreadsText(sizing.quantity)} (${sizingReasonText(sizing.reason)})`;

export const maxLossText = (
  sizing: Pick<GoLiveSizing, "maxLoss" | "maxLossPctNlv" | "reason">
): string => {
  if (sizing.maxLoss === null)
    return `not available: ${
      sizing.reason === "sized"
        ? "no max loss was computed"
        : sizingReasonText(sizing.reason)
    }`;
  const amount = usd(sizing.maxLoss, 2);
  return sizing.maxLossPctNlv === null
    ? `${amount} (% of account not available: the account value is not available)`
    : `${amount} (${pct(sizing.maxLossPctNlv)} of account)`;
};

/** The live numbers of a draft in one line, for a row whose approved order is shown separately. */
export const currentSizingText = (sizing: GoLiveSizing): string =>
  `limit ${limitText(sizing)}; quantity ${quantityText(sizing)}; max loss ${maxLossText(sizing)}`;

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
        : `Dry pre-check (web final gate; positions, kill switch and options-only gate not included): ${wordsOf(PRECHECK_DECISION_WORDS, gate.decision)}. Not a clearance to send.`,
    enginePolicy: ENGINE_POLICY_LINE,
    reasons: gate === null ? [] : gate.reasons,
    stance:
      gate === null
        ? null
        : `JEV stance used by the check: ${
            gate.jevStance === null
              ? "none"
              : wordsOf(JEV_STANCE_WORDS, gate.jevStance)
          } (${wordsOf(JEV_STATE_WORDS, gate.jevState, "JEV state ")})`,
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

type GoLiveApproveFacts = GoLiveBlockerFacts &
  Pick<
    GoLiveDraftOutput,
    | "entryBasis"
    | "exitReason"
    | "exitRule"
    | "kind"
    | "notApprovable"
    | "order"
    | "preCheck"
    | "sizing"
    | "structure"
  >;

/**
 * A value of the draft this page version has no words for. The page does not offer Approve on a
 * draft it cannot describe in full.
 */
const unknownValueBlockers = (draft: GoLiveApproveFacts): readonly string[] => {
  const reasons: string[] = [];
  const check = <Key extends string>(
    words: Readonly<Record<Key, string>>,
    value: Key | null,
    name: string
  ): void => {
    if (value !== null && !isKnown(words, value))
      reasons.push(`The ${name} is ${notKnownText(value)}`);
  };
  check(STRUCTURE_WORDS, draft.structure, "structure");
  check(SIZING_REASON_WORDS, draft.sizing.reason, "sizing reason");
  check(EXIT_RULE_WORDS, draft.exitRule, "exit rule");
  check(EXIT_REASON_WORDS, draft.exitReason, "exit reason");
  check(QUOTE_SOURCE_WORDS, draft.quote?.source ?? null, "quote source");
  check(
    PRECHECK_DECISION_WORDS,
    draft.preCheck.webFinalGate?.decision ?? null,
    "pre-check decision"
  );
  for (const leg of draft.order?.legs ?? [])
    check(RIGHT_WORDS, leg.right, "option right");
  return [...new Set(reasons)];
};

/** Why a draft is under "Other drafts": the cause is named, not always "no entry basis". */
const otherGroupReason = (
  draft: Pick<GoLiveDraftOutput, "entryBasis" | "kind">
): string => {
  if (draft.kind !== "entry" && draft.kind !== "exit")
    return `The draft kind is ${notKnownText(rawOf(draft.kind))}`;
  return draft.entryBasis === null
    ? NO_ENTRY_BASIS_REASON
    : `The entry basis is ${notKnownText(draft.entryBasis)}`;
};

/**
 * Why Approve is disabled, in words. Empty means the draft can be approved. The server decides
 * (notApprovable); the page adds what it can see itself, so it never offers an Approve that
 * contradicts its own text: the group heading, the plan status and the pre-check line.
 */
export const approveBlockers = (
  draft: GoLiveApproveFacts,
  context: GoLiveDraftContext
): readonly string[] => {
  const listed = (value: GoLiveNotApprovable): boolean =>
    draft.notApprovable.includes(value);
  const reasons = draft.notApprovable.map((value) =>
    notApprovableText(value, draft, context)
  );
  const plan = planProblem(draft, context.plan);
  if (plan !== null && !listed("PLAN_NOT_APPROVED")) reasons.push(plan);
  const group = draftGroupOf(draft);
  if (group === "modelHolds" && !listed("LATE_ENTRY_NOT_TESTED"))
    reasons.push(NOT_APPROVABLE_WORDS.LATE_ENTRY_NOT_TESTED);
  if (group === "other") reasons.push(otherGroupReason(draft));
  if (
    draft.preCheck.webFinalGate?.decision === "deny" &&
    !listed("PRECHECK_DENIED")
  )
    reasons.push(NOT_APPROVABLE_WORDS.PRECHECK_DENIED);
  reasons.push(...unknownValueBlockers(draft));
  // Approve repeats the exact order; without one there is nothing to confirm.
  return reasons.length === 0 && draft.order === null
    ? [NO_SIZED_ORDER_REASON]
    : reasons;
};

/** One line per leg of the exact order, as the dialog repeats it and the approval stores it. */
export const orderLegLines = (order: GoLiveOrder): readonly string[] =>
  order.legs.map(
    (leg) =>
      `${leg.side} ${leg.ratio} ${order.symbol} ${expiryDate(leg.expiry)} ${dollars(leg.strike)} ${wordsOf(RIGHT_WORDS, leg.right, "option right ")}`
  );

const orderRows = (order: GoLiveOrder): readonly GoLiveLabelValue[] => [
  { label: "Quantity", value: spreadsText(order.quantity) },
  { label: "Limit", value: netPriceText(order.limitPrice) },
];

/** The rows of the confirm dialog: the exact order and its max loss. */
export const orderSummaryRows = (
  order: GoLiveOrder,
  sizing: Pick<GoLiveSizing, "maxLoss" | "maxLossPctNlv" | "reason">
): readonly GoLiveLabelValue[] => [
  ...orderRows(order),
  { label: "Max loss", value: maxLossText(sizing) },
];

/** The stored room of an approval. The page computes nothing here: it shows what the server holds. */
const approvedRoomText = (room: GoLiveDraftOutput["approvedRoom"]): string => {
  if (room === null) return "the server did not send it";
  return `${usd(room.maxLoss, 2)} max loss (${
    room.maxLossPctNlv === null
      ? "% of account value not available: the account value is not available"
      : `${pct(room.maxLossPctNlv)} of account value`
  })`;
};

export type GoLiveApprovedOrderView = Readonly<{
  label: string;
  legs: readonly string[];
  /** Set when the answer carries no approved order; legs and rows are then empty. */
  missing: string | null;
  /** The node badge the server read when the owner approved. */
  nodeBadge: string;
  /** The max loss this approval holds against the plan's caps, as stored with the approval. */
  room: string;
  rows: readonly GoLiveLabelValue[];
}>;

/**
 * The order stored with the approval. null unless the draft is approved. The live sizing of the
 * row is recomputed at every read and can differ from this order.
 */
export const approvedOrderView = (
  draft: Pick<
    GoLiveDraftOutput,
    | "approvedOrder"
    | "approvedRoom"
    | "decidedAt"
    | "nodeBadgeAtDecision"
    | "state"
  >
): GoLiveApprovedOrderView | null => {
  if (draft.state !== "approved") return null;
  const recorded =
    draft.decidedAt === null
      ? "time not recorded"
      : etDayClock(draft.decidedAt);
  const shared = {
    label: `Approved order (recorded ${recorded})`,
    nodeBadge: `Node badge read at approval: ${
      draft.nodeBadgeAtDecision === null
        ? "not recorded"
        : nodeBadgeText(draft.nodeBadgeAtDecision)
    }`,
    room: `Risk room held by this approval: ${approvedRoomText(draft.approvedRoom)}`,
  };
  const order = draft.approvedOrder;
  return order === null
    ? { ...shared, legs: [], missing: APPROVED_ORDER_NOT_SHOWN, rows: [] }
    : {
        ...shared,
        legs: orderLegLines(order),
        missing: null,
        rows: orderRows(order),
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

// NO_ANSWER: the request failed without an answer of the API (network failure, timeout).
// OTHER: the API answered with an error code this page version does not know.
type GoLiveFailureCause = GoLiveApiErrorCode | "NO_ANSWER" | "OTHER";

type GoLiveFailure = Readonly<{
  cause: GoLiveFailureCause;
  code: string | null;
  message: string | null;
}>;

const failureOf = (error: unknown): GoLiveFailure => {
  const code = errorField(error, "code");
  const message = errorField(error, "message");
  if (code === null) return { cause: "NO_ANSWER", code, message };
  return {
    cause: isKnown(AGENT_OPS_API_ERRORS, code) ? code : "OTHER",
    code,
    message,
  };
};

/** Why the queue could not be loaded, in plain words for every cause. No raw code or browser text. */
export const LOAD_ERROR_WORDS: Readonly<Record<GoLiveFailureCause, string>> =
  Object.freeze({
    BAD_REQUEST:
      "The server refused the request as invalid. This page and the server may be different versions: reload the page.",
    CONFLICT: "The server reported a conflict between its records.",
    FORBIDDEN: "The server refused this session: operator access is required.",
    NO_ANSWER:
      "No answer came back from the server (network failure or timeout).",
    NOT_CONFIGURED: "The server is not set up to answer this request.",
    NOT_FOUND:
      "The server did not find what this page asked for. This page and the server may be different versions: reload the page.",
    OTHER: "The server failed with an error code",
    STORAGE_ERROR: "The draft store could not be read.",
    UNAUTHORIZED: SIGNED_OUT_TEXT,
    UPSTREAM_ERROR: "A service the server depends on did not answer it.",
    VALIDATION_ERROR: "The server found a record that fails its own checks.",
  });

// The causes whose server message is written for an operator and may follow the plain sentence.
// BAD_REQUEST carries a validation text and NO_ANSWER a browser text: neither is shown.
const DETAIL_CAUSES: Readonly<Partial<Record<GoLiveFailureCause, true>>> = {
  CONFLICT: true,
  NOT_CONFIGURED: true,
  NOT_FOUND: true,
  STORAGE_ERROR: true,
  UPSTREAM_ERROR: true,
  VALIDATION_ERROR: true,
};

/** " Server detail: <message>." when the server wrote more than the default text of its code. */
const serverDetail = (failure: GoLiveFailure): string => {
  const { cause, code, message } = failure;
  if (message === null || DETAIL_CAUSES[cause] !== true || message === code)
    return "";
  if (
    isKnown(AGENT_OPS_API_ERRORS, cause) &&
    AGENT_OPS_API_ERRORS[cause].message === message
  )
    return "";
  return ` Server detail: ${message}${/[.!?]$/u.test(message) ? "" : "."}`;
};

const NOTHING_RECORDED_BY_A_LOAD = "A load only reads: it recorded nothing.";

/** A failed queue load in plain words, with the server detail of a storage error. */
export const loadErrorText = (error: unknown): string => {
  const failure = failureOf(error);
  const words =
    failure.cause === "OTHER"
      ? `${LOAD_ERROR_WORDS.OTHER} ${notKnownText(failure.code)}.`
      : LOAD_ERROR_WORDS[failure.cause];
  return `${words}${serverDetail(failure)} ${NOTHING_RECORDED_BY_A_LOAD}`;
};

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

/** The blocker codes of a server message in the words of the row, or null when it has none. */
const blockerWords = (
  message: string | null,
  draft: GoLiveBlockerFacts,
  context: GoLiveDraftContext
): string | null => {
  const matches: readonly string[] =
    message?.match(NOT_APPROVABLE_CODE_PATTERN) ?? [];
  const codes = [...new Set(matches.filter(isNotApprovableCode))];
  return codes.length === 0
    ? null
    : codes
        .map((code) => lowerFirst(notApprovableText(code, draft, context)))
        .join("; ");
};

// The FORBIDDEN messages of the server (packages/api/src/server/golive-drafts.ts and
// operator-access.ts; the model test compares them with the source). They tell a caller who is
// not the owner from a session that lost operator access. Any other text names both.
const OWNER_REQUIRED_MESSAGES: readonly string[] = [
  "Owner (admin) access required",
  "A draft decision needs the owner's browser session",
];
const OPERATOR_REQUIRED_MESSAGE = "Operator access required";

const forbiddenText = (message: string | null): string => {
  if (message !== null && OWNER_REQUIRED_MESSAGES.includes(message))
    return `${OWNER_ONLY_DECISION_TEXT} Nothing was recorded.`;
  if (message === OPERATOR_REQUIRED_MESSAGE)
    return "Operator access was lost for this session. Nothing was recorded.";
  return "The server refused this session: either only the owner can approve or reject a draft, or operator access was lost. Nothing was recorded.";
};

export type GoLiveDecisionFailure = Readonly<{
  /**
   * stay: nothing was recorded and the owner can act in the dialog, which shows the text.
   * close: the dialog closes, the queue is read again and the text is shown above it.
   */
  action: "close" | "stay";
  /**
   * What follows the text after the reload. none: nothing. refused: this attempt recorded
   * nothing, so the reloaded row is the whole truth. result_not_known: the request may still
   * complete, so a row that is still proposed does not mean nothing is recorded.
   */
  aftermath: "none" | "refused" | "result_not_known";
  text: string;
}>;

// The server's storage error after a stored rejection starts with this statement
// (packages/api/src/server/golive-drafts.ts; the model test compares it with the source).
const STORED_STATEMENT =
  /^The (?:rejection|approval) of draft \S+ was stored\./u;

/**
 * A failed approve or reject in plain words. Every text says whether anything was recorded or
 * that it is not known; none says "not recorded" about a draft that may already be decided.
 */
export const decisionFailure = (
  error: unknown,
  type: "approve" | "reject",
  draft: GoLiveBlockerFacts,
  context: GoLiveDraftContext
): GoLiveDecisionFailure => {
  const failure = failureOf(error);
  const act = type === "approve" ? "approval" : "rejection";
  const notKnown = "so it is not known whether it was recorded.";
  const reload = (text: string): GoLiveDecisionFailure => ({
    action: "close",
    aftermath: "result_not_known",
    text: `${text}${serverDetail(failure)}`,
  });
  switch (failure.cause) {
    case "UNAUTHORIZED":
      return {
        action: "stay",
        aftermath: "none",
        text: `${SIGNED_OUT_TEXT} Nothing was recorded.`,
      };
    case "BAD_REQUEST":
      // The request is checked before anything is stored. The validation text is not shown.
      return {
        action: "stay",
        aftermath: "none",
        text: `The server refused this ${act} as an invalid request. Nothing was recorded.`,
      };
    case "FORBIDDEN":
      return {
        action: "close",
        aftermath: "none",
        text: forbiddenText(failure.message),
      };
    case "NOT_FOUND":
      return {
        action: "close",
        aftermath: "refused",
        text: `The server did not find this draft in the queue of the order session day, so this ${act} recorded nothing.`,
      };
    case "CONFLICT": {
      // The draft or its order changed since this page loaded it. An earlier attempt whose answer
      // was lost may be what decided it, so only this attempt is said to have recorded nothing.
      const blockers = blockerWords(failure.message, draft, context);
      return {
        action: "close",
        aftermath: "refused",
        text: `The server refused this ${act}: ${
          blockers ??
          "the draft was already decided or expired, or its order or plan changed after this page loaded it"
        }. This attempt recorded nothing.`,
      };
    }
    case "STORAGE_ERROR":
      // The store can fail after the decision is written; the server then says so, and the page
      // does not call the result unknown next to that statement.
      return reload(
        failure.message !== null && STORED_STATEMENT.test(failure.message)
          ? `The server answered that this ${act} was stored and that its store failed afterwards.`
          : `The draft store failed during this ${act}, ${notKnown}`
      );
    case "VALIDATION_ERROR":
      return reload(
        `The server found a record that fails its own checks during this ${act}, ${notKnown}`
      );
    case "UPSTREAM_ERROR":
      return reload(
        `A service the server depends on did not answer during this ${act}, ${notKnown}`
      );
    case "NOT_CONFIGURED":
      return reload(
        `The server answered that it is not set up for this ${act}, ${notKnown}`
      );
    case "NO_ANSWER":
      return reload(
        `No answer came back for this ${act} (network failure or timeout), ${notKnown}`
      );
    default:
      // OTHER: the server answered with a code this page version does not know. The same answer
      // covers a cause a later contract adds before this switch has a case for it (the exhaustive
      // LOAD_ERROR_WORDS map above is where such a code is a type error): close, reload, and say
      // that the result is not known.
      return reload(
        `The server failed during this ${act} with an error code ${notKnownText(failure.code)}, ${notKnown}`
      );
  }
};

/**
 * What the queue shows for the draft after a failed decision was followed by a reload.
 * null: the reload failed. undefined: the draft is not in the reloaded queue.
 * attemptRecordedNothing is false when the result of the request is not known: the request may
 * still complete on the server, so "still proposed" is then only what this read shows.
 */
export const decisionAftermathText = (
  draft:
    | Pick<GoLiveDraftOutput, "decidedAt" | "decidedBy" | "state">
    | null
    | undefined,
  tradingDay: string,
  attemptRecordedNothing: boolean
): string => {
  if (draft === null)
    return "The queue could not be read again, so the rows below may be out of date. Reload the queue before you decide again.";
  const lead = "The queue was read again:";
  if (draft === undefined)
    return `${lead} this draft is not in the queue of ${tradingDay}.`;
  if (draft.state === "proposed")
    return attemptRecordedNothing
      ? `${lead} the draft is still proposed, so no decision is recorded for it.`
      : `${lead} the draft is still proposed in this read; the request may still complete. Reload before you decide again.`;
  const state = draftStateText(draft.state);
  const decided = decisionText(draft);
  return `${lead} the draft is ${
    draft.state === "approved" || draft.state === "rejected"
      ? "already decided"
      : "no longer proposed"
  }. Its state is: ${state}${/[.!?]$/u.test(state) ? "" : "."}${
    decided === null ? "" : ` ${decided}.`
  }`;
};

// ---------- an open dialog and a newer read ----------

// The draft is the one the dialog shows: its revision is what the owner saw.
type GoLiveShownDraft = Pick<GoLiveDraftOutput, "revision">;
type GoLiveOpenDecision =
  | Readonly<{
      draft: GoLiveShownDraft;
      order: GoLiveOrder;
      outsideTestedEntryRule?: boolean;
      type: "approve";
    }>
  | Readonly<{ draft: GoLiveShownDraft; type: "reject" }>;

/** The fields of an order in a fixed sequence, so two orders compare by value. */
const orderKey = (order: GoLiveOrder): string =>
  JSON.stringify([
    order.symbol,
    order.quantity,
    order.limitPrice,
    order.legs.map((leg) => [
      leg.side,
      leg.ratio,
      leg.expiry,
      leg.strike,
      leg.right,
    ]),
  ]);

/**
 * Why an open dialog no longer matches the queue, or null when it still does. A newer read can
 * arrive behind the dialog; the page then closes it instead of offering a decision that its own
 * row forbids. Both decisions need a proposed draft of the revision the dialog shows; an approval
 * also needs no blocker and the exact order the dialog shows.
 */
export const staleDialogReason = (
  decision: GoLiveOpenDecision,
  fresh: GoLiveDraftOutput | undefined,
  context: GoLiveDraftContext
): string | null => {
  if (fresh === undefined) return "the draft is no longer in the queue";
  if (fresh.state !== "proposed")
    return `the draft is no longer proposed (${draftStateText(fresh.state)})`;
  // A rerun of the generator refreshes an open draft under a new revision: the owner has not
  // seen that draft, whatever the decision and even when the order is the same.
  if (fresh.revision !== decision.draft.revision)
    return `the draft was refreshed after the dialog opened (it is now revision ${fresh.revision}; the dialog showed revision ${decision.draft.revision})`;
  if (decision.type === "reject") return null;
  const blockers =
    decision.outsideTestedEntryRule === true &&
    lateEntryOnlyBlocker(fresh, context)
      ? []
      : approveBlockers(fresh, context);
  if (blockers.length > 0)
    return `the draft can no longer be approved: ${blockers.map(lowerFirst).join("; ")}`;
  return fresh.order !== null &&
    orderKey(fresh.order) === orderKey(decision.order)
    ? null
    : "the order of the draft changed and is no longer the order the dialog showed";
};

export const staleDialogNotice = (reason: string): string =>
  `A newer read of the queue shows that ${reason}. The open dialog was closed and nothing was recorded.`;

/**
 * The owner's standing exit rule for an approved entry, in words: the day a loser closes and the
 * time an open winner closes, and the closing combo. null when the draft has no schedule.
 */
export const exitScheduleText = (
  schedule: GoLiveDraftOutput["exitSchedule"]
): string | null => {
  if (schedule === null) return null;
  const { closeOrder } = schedule;
  const legs = closeOrder.legs
    .map((leg) => `${leg.side} ${leg.strike}${leg.right}`)
    .join(" / ");
  return `Loser closes ${schedule.loserCloseDay} (3 trading days before expiry); open winner closes ${etDayClock(schedule.winnerCloseAt)}. Close: ${closeOrder.quantity}x ${closeOrder.symbol} ${legs}, limit from the live quote at exit.`;
};

/** What the send after an approval gave: sent, refused with its reasons, or an unknown outcome. */
export type GoLiveSendResult =
  | Readonly<{ result: VertexOrderResult; sent: true }>
  | Readonly<{ reasons: readonly string[]; sent: false }>
  | Readonly<{ message: string; sent: "unknown" }>;

const GO_LIVE_PREFIX = "GO-LIVE ";
const reasonCode = (reason: string): string =>
  reason.startsWith(GO_LIVE_PREFIX)
    ? (reason.slice(GO_LIVE_PREFIX.length).split(":")[0] ?? "")
    : "";
const reasonText = (reason: string): string =>
  reason.startsWith(GO_LIVE_PREFIX)
    ? reason.slice(reason.indexOf(":") + 1).trim()
    : reason;

/**
 * The notice after an approval: what the order path did with the approved order. Sends off (v3
 * not on the live path) and a disarmed node lead the notice; every other refusal is listed.
 */
export const sendOutcomeText = (outcome: GoLiveSendResult): string => {
  if (outcome.sent === "unknown")
    return `Approved; the send outcome is unknown (${outcome.message}). Check open orders at IBKR before doing anything else.`;
  if (outcome.sent) {
    const { result } = outcome;
    const reached =
      result.state === "submitted" || result.state === "unconfirmed";
    return reached
      ? `Approved and sent to IBKR as one combo limit order (${result.mode}, ${result.state}, ref ${result.orderRef}). ${result.message}`
      : `Approved; IBKR did not take the order (${result.state}): ${result.message}`;
  }
  const codes = outcome.reasons.map(reasonCode);
  const others = outcome.reasons
    .filter((reason) => {
      const code = reasonCode(reason);
      return code !== "V3_NOT_ON_LIVE_PATH" && code !== "ENGINE_DISARMED";
    })
    .map(reasonText);
  const rest = others.length === 0 ? "" : ` Also: ${others.join("; ")}.`;
  if (codes.includes("V3_NOT_ON_LIVE_PATH"))
    return `Approved and recorded; nothing was sent: go-live sends wait until engine policy v3 checks the live path.${rest}`;
  const disarmed = outcome.reasons.find(
    (reason) => reasonCode(reason) === "ENGINE_DISARMED"
  );
  if (disarmed !== undefined)
    return `Approved, engine disarmed: nothing was sent (${reasonText(disarmed).replace(/^approved, /u, "")}).${rest}`;
  return `Approved, not sent: ${others.join("; ")}.`;
};

export const OUTSIDE_TESTED_RULE_LABEL =
  "I approve this position outside the tested entry rule (a late entry the backtest never tested).";

/**
 * Whether the only thing that blocks Approve is that the draft is a late entry: the owner may then
 * approve it with the explicit outside-the-tested-rule tick (owner 2026-11-12). The server lifts
 * that one reason only with the tick; every other blocker stays.
 */
export const lateEntryOnlyBlocker = (
  draft: GoLiveApproveFacts,
  context: GoLiveDraftContext
): boolean =>
  draft.order !== null &&
  draft.notApprovable.includes("LATE_ENTRY_NOT_TESTED") &&
  approveBlockers(draft, context).every(
    (reason) => reason === NOT_APPROVABLE_WORDS.LATE_ENTRY_NOT_TESTED
  );
