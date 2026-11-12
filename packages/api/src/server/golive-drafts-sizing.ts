import type {
  GoLiveDraftOutput,
  GoLivePlanLimits,
  GoLivePlanStatus,
  GoLiveQuote,
  GoLiveSizing,
} from "../contracts/golive-drafts.ts";
import type { VertexComboInput } from "../contracts/vertex-orders.ts";
import { formatDay, parseDay } from "../options-engine/calendar.ts";
import { isNyseTradingDay } from "../strategy-dsl-compile.ts";

// Go-live draft queue: order session day, limit, size and approval rules. Pure: no I/O and no
// clock; the account value, the quotes and the time are passed in. The max-loss arithmetic is the arithmetic of
// final-order-gate.ts (golive-drafts-sizing.test.ts checks that both agree).
// Known limit of this version: positions already held in the account are not counted against the
// sleeve, name, open-risk and position caps. Only the drafts of the trading day are.

const MULTIPLIER = 100;
const EPSILON = 1e-6;
// A quote counts as live for 120 s. A time more than 60 s in the future is not trusted.
export const GOLIVE_QUOTE_MAX_AGE_MS = 120_000;
const QUOTE_MAX_FUTURE_SKEW_MS = 60_000;

const NY_DATE = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});
const NY_HOUR = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  timeZone: "America/New_York",
});
// The regular close. Known limit: a half-day (13:00 close) still counts as open until 16:00.
const SESSION_CLOSE_HOUR = 16;

/**
 * The trading day (YYYY-MM-DD) of the session in which an order would be placed: today's New
 * York date when today is an NYSE trading day and the New York time is before 16:00, otherwise
 * the next NYSE trading day.
 */
export const orderSessionDay = (now: Date): string => {
  const today = parseDay(NY_DATE.format(now));
  let day =
    Number(NY_HOUR.format(now)) < SESSION_CLOSE_HOUR ? today : today + 1;
  while (!isNyseTradingDay(day)) day += 1;
  return formatDay(day);
};

type Structure = GoLiveDraftOutput["structure"];
type DraftState = GoLiveDraftOutput["state"];
type NotApprovable = GoLiveDraftOutput["notApprovable"][number];
type SizingReason = GoLiveSizing["reason"];
type QuotePrices = Pick<
  GoLiveQuote,
  "longAsk" | "longBid" | "shortAsk" | "shortBid"
>;

export type GoLiveSpread = Readonly<{
  expiry: string;
  longStrike: number;
  shortStrike: number;
  structure: Structure;
  symbol: string;
}>;

export type GoLiveSizingPlan = Readonly<{
  limits: GoLivePlanLimits;
  sleeves: readonly Readonly<{ budgetPct: number; key: string }>[];
}>;

export type GoLiveSizingDraft = Readonly<{
  id: string;
  longStrike: number;
  quote: QuotePrices | null;
  shortStrike: number;
  sleeveKey: string;
  state: DraftState;
  structure: Structure;
  symbol: string;
}>;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const isDebit = (structure: Structure): boolean =>
  structure === "callDebitVertical" || structure === "putDebitVertical";

export const strikeWidth = (
  spread: Readonly<{ longStrike: number; shortStrike: number }>
): number => Math.abs(spread.longStrike - spread.shortStrike);

/**
 * The two-leg combo of one draft: ratio 1, one expiry. A debit vertical lists the bought leg
 * first, a credit vertical the sold leg. limitPrice: positive = debit, negative = credit.
 */
export const buildCombo = (
  draft: GoLiveSpread,
  quantity: number,
  limitPrice: number
): VertexComboInput => {
  const right =
    draft.structure === "callDebitVertical" ||
    draft.structure === "callCreditVertical"
      ? "C"
      : "P";
  const long = {
    expiry: draft.expiry,
    ratio: 1,
    right,
    side: "BUY",
    strike: draft.longStrike,
  } as const;
  const short = {
    expiry: draft.expiry,
    ratio: 1,
    right,
    side: "SELL",
    strike: draft.shortStrike,
  } as const;
  return {
    legs: isDebit(draft.structure) ? [long, short] : [short, long],
    limitPrice,
    quantity,
    symbol: draft.symbol,
  };
};

// null: the side is missing (not a number, a negative bid, no ask) or crossed (bid above ask).
const mid = (bid: number, ask: number): number | null =>
  Number.isFinite(bid) &&
  Number.isFinite(ask) &&
  bid >= 0 &&
  ask > 0 &&
  bid <= ask
    ? (bid + ask) / 2
    : null;

/**
 * Net limit per spread from the two mids. Debit: long mid - short mid, rounded DOWN to a cent
 * (never above mid). Credit: short mid - long mid, rounded UP to a cent (never below mid) and
 * returned negative. null when a side is missing or crossed, or when the net or the rounded
 * limit is not strictly between 0 and the strike width.
 */
export const limitFromQuote = (
  structure: Structure,
  quote: QuotePrices | null,
  width: number
): number | null => {
  if (quote === null) return null;
  const long = mid(quote.longBid, quote.longAsk);
  const short = mid(quote.shortBid, quote.shortAsk);
  if (long === null || short === null) return null;
  const debit = isDebit(structure);
  const net = debit ? long - short : short - long;
  if (!(net > 0 && net < width)) return null;
  // Mids are half cents: the epsilon removes binary float noise before the cent rounding.
  const limit =
    (debit ? Math.floor(net * 100 + EPSILON) : Math.ceil(net * 100 - EPSILON)) /
    100;
  if (!(limit > 0 && limit < width)) return null;
  return debit ? limit : -limit;
};

/**
 * Max loss of `quantity` spreads. Debit: limit x quantity x 100. Credit: (width - credit) x
 * quantity x 100. The same expressions as classifyVertical in final-order-gate.ts.
 */
export const maxLoss = (
  structure: Structure,
  limitPrice: number,
  width: number,
  quantity: number
): number => {
  if (isDebit(structure)) return round2(limitPrice * quantity * MULTIPLIER);
  const credit = -limitPrice;
  return round2((width - credit) * quantity * MULTIPLIER);
};

export const maxLossPerSpread = (
  structure: Structure,
  limitPrice: number,
  width: number
): number => maxLoss(structure, limitPrice, width, 1);

// No plan: no budget and no room, so every draft is sized to 0.
const NO_PLAN: GoLiveSizingPlan = {
  limits: {
    maxPositions: 0,
    nameRiskCapPct: 0,
    openRiskCapPct: 0,
    positionRiskPct: 0,
  },
  sleeves: [],
};

const STATE_RANK: Readonly<Record<DraftState, number>> = {
  approved: 0,
  expired: 2,
  proposed: 1,
  rejected: 2,
};

const compareText = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

const unsized = (
  budget: number | null,
  reason: SizingReason
): GoLiveSizing => ({
  budget,
  limitPrice: null,
  maxLoss: null,
  maxLossPctNlv: null,
  maxLossPerSpread: null,
  quantity: 0,
  reason,
});

/**
 * Quantity and max loss of every draft, in the order given.
 * Per draft: budget = positionRiskPct% of NLV; quantity = floor(budget / max loss per spread).
 * Then the caps, in this fixed order, over the drafts sorted approved first, then by sleeve order
 * in the plan, then by symbol: sleeve budget, name cap, open risk cap, max positions. A draft that
 * does not fit whole gets quantity 0 and the reason of the first cap it breaks.
 * Only proposed and approved drafts use cap room. A rejected or expired draft is sized on its own
 * budget alone, to show what was proposed.
 */
export const sizeDrafts = <T extends GoLiveSizingDraft>(
  plan: GoLiveSizingPlan | null,
  drafts: readonly T[],
  nlv: number | null
): Readonly<{ draft: T; sizing: GoLiveSizing }>[] => {
  if (nlv === null || !(nlv > 0))
    return drafts.map((draft) => ({
      draft,
      sizing: unsized(null, "nlv_unavailable"),
    }));
  const { limits, sleeves } = plan ?? NO_PLAN;
  const share = (pct: number): number => (nlv * pct) / 100;
  const budget = round2(share(limits.positionRiskPct));
  const sleeveRank = (key: string): number => {
    const index = sleeves.findIndex((sleeve) => sleeve.key === key);
    return index === -1 ? sleeves.length : index;
  };
  const usedBySleeve = new Map<string, number>();
  const usedByName = new Map<string, number>();
  let openRisk = 0;
  let positions = 0;

  const capReason = (draft: T, loss: number): SizingReason => {
    const sleeve = sleeves.find((entry) => entry.key === draft.sleeveKey);
    const inSleeve = usedBySleeve.get(draft.sleeveKey) ?? 0;
    const inName = usedByName.get(draft.symbol) ?? 0;
    if (inSleeve + loss > share(sleeve?.budgetPct ?? 0) + EPSILON)
      return "sleeve_budget_used";
    if (inName + loss > share(limits.nameRiskCapPct) + EPSILON)
      return "name_cap_reached";
    if (openRisk + loss > share(limits.openRiskCapPct) + EPSILON)
      return "open_risk_cap_reached";
    if (positions + 1 > limits.maxPositions) return "max_positions_reached";
    usedBySleeve.set(draft.sleeveKey, inSleeve + loss);
    usedByName.set(draft.symbol, inName + loss);
    openRisk += loss;
    positions += 1;
    return "sized";
  };

  const sizeOne = (draft: T): GoLiveSizing => {
    const width = strikeWidth(draft);
    const limitPrice = limitFromQuote(draft.structure, draft.quote, width);
    if (limitPrice === null) return unsized(budget, "no_quote");
    const perSpread = maxLossPerSpread(draft.structure, limitPrice, width);
    const quantity = Math.floor(budget / perSpread + EPSILON);
    const loss = maxLoss(draft.structure, limitPrice, width, quantity);
    let reason: SizingReason = "sized";
    if (quantity === 0) reason = "budget_below_one_spread";
    else if (STATE_RANK[draft.state] < 2) reason = capReason(draft, loss);
    const fits = reason === "sized";
    return {
      budget,
      limitPrice,
      maxLoss: fits ? loss : null,
      maxLossPctNlv: fits ? round2((loss / nlv) * 100) : null,
      maxLossPerSpread: perSpread,
      quantity: fits ? quantity : 0,
      reason,
    };
  };

  return drafts
    .map((draft, index) => ({ draft, index }))
    .sort(
      (a, b) =>
        STATE_RANK[a.draft.state] - STATE_RANK[b.draft.state] ||
        sleeveRank(a.draft.sleeveKey) - sleeveRank(b.draft.sleeveKey) ||
        compareText(a.draft.symbol, b.draft.symbol) ||
        compareText(a.draft.id, b.draft.id)
    )
    .map(({ draft, index }) => ({ draft, index, sizing: sizeOne(draft) }))
    .sort((a, b) => a.index - b.index)
    .map(({ draft, sizing }) => ({ draft, sizing }));
};

/** The exact combo of a sized draft; null when the draft is sized to 0. */
export const orderFor = (
  draft: GoLiveSpread,
  sizing: GoLiveSizing
): VertexComboInput | null =>
  sizing.quantity > 0 && sizing.limitPrice !== null
    ? buildCombo(draft, sizing.quantity, sizing.limitPrice)
    : null;

/** true when both combos have the same symbol, quantity, limit and legs in the same order. */
export const sameCombo = (
  a: VertexComboInput,
  b: VertexComboInput | null
): boolean =>
  b !== null &&
  a.symbol === b.symbol &&
  a.quantity === b.quantity &&
  a.limitPrice === b.limitPrice &&
  a.legs.length === b.legs.length &&
  a.legs.every((leg, index) => {
    const other = b.legs[index];
    return (
      other !== undefined &&
      leg.expiry === other.expiry &&
      leg.strike === other.strike &&
      leg.right === other.right &&
      leg.side === other.side &&
      leg.ratio === other.ratio
    );
  });

const isLiveQuote = (
  quote: Pick<GoLiveQuote, "asOf" | "source"> | null,
  now: Date
): boolean => {
  if (quote === null || quote.source !== "ibkr_live") return false;
  const age = now.getTime() - quote.asOf.getTime();
  return age >= -QUOTE_MAX_FUTURE_SKEW_MS && age <= GOLIVE_QUOTE_MAX_AGE_MS;
};

export type GoLiveNotApprovableInput = Readonly<{
  draft: Readonly<{
    entryBasis: GoLiveDraftOutput["entryBasis"];
    planId: string;
    planVersion: number;
    quote: Pick<GoLiveQuote, "asOf" | "source"> | null;
    state: DraftState;
  }>;
  nlv: number | null;
  now: Date;
  // The plan in force; a draft of another plan or plan version counts as "plan not approved".
  plan: Readonly<{
    id: string;
    status: GoLivePlanStatus;
    version: number;
  }> | null;
  quantity: number;
  // Decision of the web final order gate on the sized order; null when there is no sized order.
  webFinalGate: "allow" | "deny" | null;
}>;

/** Why the draft cannot be approved now, in the order of GOLIVE_NOT_APPROVABLE_VALUES. */
export const notApprovableReasons = (
  input: GoLiveNotApprovableInput
): NotApprovable[] => {
  const { draft, plan } = input;
  const reasons: NotApprovable[] = [];
  if (
    plan === null ||
    plan.status !== "approved" ||
    plan.id !== draft.planId ||
    plan.version !== draft.planVersion
  )
    reasons.push("PLAN_NOT_APPROVED");
  if (draft.entryBasis === "model_holds_account_does_not")
    reasons.push("LATE_ENTRY_NOT_TESTED");
  if (!isLiveQuote(draft.quote, input.now)) reasons.push("NO_LIVE_IBKR_QUOTE");
  if (input.nlv === null) reasons.push("NLV_UNAVAILABLE");
  if (input.quantity === 0) reasons.push("SIZED_TO_ZERO");
  if (input.webFinalGate === "deny") reasons.push("PRECHECK_DENIED");
  if (draft.state !== "proposed") reasons.push("DRAFT_NOT_PROPOSED");
  if (draft.state === "expired") reasons.push("DRAFT_EXPIRED");
  return reasons;
};
