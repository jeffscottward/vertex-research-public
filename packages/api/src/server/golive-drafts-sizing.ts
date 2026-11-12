import {
  GOLIVE_QUOTE_MAX_SPREAD_SHARE,
  GOLIVE_QUOTE_SPREAD_FLOOR,
  type GoLiveDraftOutput,
  type GoLivePlanLimits,
  type GoLivePlanStatus,
  type GoLiveQuote,
  type GoLiveSizing,
  goLiveStrikesFitStructure,
} from "../contracts/golive-drafts.ts";
import {
  type VertexComboInput,
  VertexComboInputSchema,
} from "../contracts/vertex-orders.ts";
import { formatDay, parseDay } from "../options-engine/calendar.ts";
import { isNyseTradingDay } from "../strategy-dsl-compile.ts";

// Go-live draft queue: order session day, limit, size and approval rules. Pure: no I/O and no
// clock; the account value, the quotes and the time are passed in. Money is counted in whole
// cents, so a max loss is never a cent above its budget or a cap. The max-loss arithmetic is the
// arithmetic of final-order-gate.ts (golive-drafts-sizing.test.ts checks that both agree).
// Known limit of this version: positions already held in the account are not counted against the
// sleeve, name, open-risk and position caps. Only the drafts of the trading day are.

// A cent amount computed from decimal prices is within this of a whole number (binary floats).
const CENT_NOISE = 1e-6;
// A quote counts as live for 120 s. A time more than 60 s in the future is not trusted: not when
// a draft is approved, and not when collect stores the quote.
export const GOLIVE_QUOTE_MAX_AGE_MS = 120_000;
export const GOLIVE_QUOTE_MAX_FUTURE_SKEW_MS = 60_000;
// The most spreads one combo order may hold: the quantity limit of VertexComboInputSchema, read
// from the schema. Number(null) is 0, so a schema without a limit would size nothing.
export const GOLIVE_ORDER_MAX_QUANTITY = Number(
  VertexComboInputSchema.shape.quantity.maxValue
);

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

export type GoLiveSizingDraft = GoLiveSpread &
  Readonly<{
    // The order stored with an approval: it gives the room an approved draft holds.
    approvedOrder: VertexComboInput | null;
    entryBasis: GoLiveDraftOutput["entryBasis"];
    id: string;
    quote: QuotePrices | null;
    sleeveKey: string;
    state: DraftState;
  }>;

/** Whole cents of a price or a strike width in dollars. */
const toCents = (dollars: number): number => Math.round(dollars * 100);

const round2 = (value: number): number => Math.round(value * 100) / 100;

const isDebit = (structure: Structure): boolean =>
  structure === "callDebitVertical" || structure === "putDebitVertical";

export const strikeWidth = (
  spread: Readonly<{ longStrike: number; shortStrike: number }>
): number => Math.abs(spread.longStrike - spread.shortStrike);

/**
 * Throws when the strikes are the wrong way round for the structure (goLiveStrikesFitStructure).
 * The limit and the max loss use the width without its sign, so such a draft would get the
 * size of another position: a call debit vertical with swapped strikes is a call credit
 * vertical. collect refuses it; a stored row that has it gets no size and no legs. No sizing
 * reason says "wrong strikes", so this fails instead of answering with a reason that is not true.
 */
const assertStrikesFitStructure = (
  spread: Pick<
    GoLiveSpread,
    "longStrike" | "shortStrike" | "structure" | "symbol"
  >
): void => {
  if (
    !goLiveStrikesFitStructure(
      spread.structure,
      spread.longStrike,
      spread.shortStrike
    )
  )
    throw new Error(
      `${spread.symbol} ${spread.structure}: long strike ${spread.longStrike} and short strike ${spread.shortStrike} are the wrong way round`
    );
};

/**
 * The two-leg combo of one draft: ratio 1, one expiry. A debit vertical lists the bought leg
 * first, a credit vertical the sold leg. limitPrice: positive = debit, negative = credit.
 */
export const buildCombo = (
  draft: GoLiveSpread,
  quantity: number,
  limitPrice: number
): VertexComboInput => {
  assertStrikesFitStructure(draft);
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

// A difference of two decimal prices is within this of its decimal value (0.05 - 0.03 is
// 0.020000000000000004 in binary floats).
const PRICE_NOISE = 1e-9;

// null: the side is missing (not a number, no ask), has no bid (a bid of 0 or below: nobody
// bids, so the mid is no price), is crossed (bid above ask), or is a wide market: ask - bid is
// above GOLIVE_QUOTE_MAX_SPREAD_SHARE of the mid, so nobody trades at that mid. A leg that is at
// most GOLIVE_QUOTE_SPREAD_FLOOR wide is never a wide market: one tick is the tightest market a
// cheap option has.
const mid = (bid: number, ask: number): number | null => {
  if (
    !(
      Number.isFinite(bid) &&
      Number.isFinite(ask) &&
      bid > 0 &&
      ask > 0 &&
      bid <= ask
    )
  )
    return null;
  const middle = (bid + ask) / 2;
  const widest = Math.max(
    GOLIVE_QUOTE_MAX_SPREAD_SHARE * middle,
    GOLIVE_QUOTE_SPREAD_FLOOR
  );
  return ask - bid <= widest + PRICE_NOISE ? middle : null;
};

/**
 * Net limit per spread from the two mids. Debit: long mid - short mid, rounded DOWN to a cent
 * (never above mid). Credit: short mid - long mid, rounded UP to a cent (never below mid) and
 * returned negative. null when a side is missing, has a bid of 0, is crossed or is a wide market,
 * or when the rounded limit is not strictly between 0 and the strike width (at least one cent
 * from each).
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
  // Mids are half cents: the noise term removes binary float error before the cent rounding.
  const cents = debit
    ? Math.floor(net * 100 + CENT_NOISE)
    : Math.ceil(net * 100 - CENT_NOISE);
  if (!(cents >= 1 && cents <= toCents(width) - 1)) return null;
  return (debit ? cents : -cents) / 100;
};

// One option contract is 100 shares.
const MULTIPLIER = 100;

// Max loss of one spread in whole cents: the price per share in cents x 100 shares. Debit: the
// limit. Credit: width - credit.
const lossCentsPerSpread = (
  structure: Structure,
  limitPrice: number,
  width: number
): number =>
  MULTIPLIER *
  (isDebit(structure)
    ? toCents(limitPrice)
    : toCents(width) - toCents(-limitPrice));

/**
 * Max loss of `quantity` spreads. Debit: limit x quantity x 100. Credit: (width - credit) x
 * quantity x 100. The same amounts as classifyVertical in final-order-gate.ts, counted in cents.
 */
export const maxLoss = (
  structure: Structure,
  limitPrice: number,
  width: number,
  quantity: number
): number =>
  (lossCentsPerSpread(structure, limitPrice, width) * quantity) / 100;

export const maxLossPerSpread = (
  structure: Structure,
  limitPrice: number,
  width: number
): number => maxLoss(structure, limitPrice, width, 1);

/**
 * pct% of an amount of whole cents, rounded DOWN to the cent. Whole-number arithmetic (the
 * percentage is cut at its sixth decimal), so the result is never above the exact share.
 */
const shareCents = (amountCents: number, pct: number): number =>
  Number(
    (BigInt(amountCents) * BigInt(Math.floor(pct * 1_000_000 + 1e-3))) /
      100_000_000n
  );

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

/**
 * true when `order` is the order of this draft: its symbol and legs, a whole number of spreads
 * that one order may hold, and a limit in whole cents on the side of the structure (debit above
 * 0, credit below 0) strictly inside the strike width. The room of an approved draft is computed
 * from its stored order, so an order that fails here gives no room that can be trusted.
 */
export const approvedOrderFitsDraft = (
  draft: GoLiveSpread,
  order: VertexComboInput | null
): order is VertexComboInput => {
  if (order === null) return false;
  if (
    !goLiveStrikesFitStructure(
      draft.structure,
      draft.longStrike,
      draft.shortStrike
    )
  )
    return false;
  const { limitPrice, quantity } = order;
  if (
    !(
      Number.isInteger(quantity) &&
      quantity >= 1 &&
      quantity <= GOLIVE_ORDER_MAX_QUANTITY
    )
  )
    return false;
  const limitCents = toCents(
    isDebit(draft.structure) ? limitPrice : -limitPrice
  );
  if (
    !(
      Math.abs(limitPrice * 100 - Math.round(limitPrice * 100)) < CENT_NOISE &&
      limitCents >= 1 &&
      limitCents <= toCents(strikeWidth(draft)) - 1
    )
  )
    return false;
  return sameCombo(order, buildCombo(draft, quantity, limitPrice));
};

// The max loss in cents that an approved draft holds: the quantity of its stored order at the
// approved limit. null for a draft that is not approved. Throws when the stored order is missing
// or is not the order of the draft: no room can be computed, so nothing is sized.
const approvedLossCents = (draft: GoLiveSizingDraft): number | null => {
  if (draft.state !== "approved") return null;
  const order = draft.approvedOrder;
  if (!approvedOrderFitsDraft(draft, order))
    throw new Error(
      `The stored approved order of draft ${draft.id} is not the order of that draft`
    );
  return (
    order.quantity *
    lossCentsPerSpread(draft.structure, order.limitPrice, strikeWidth(draft))
  );
};

// The account value in whole cents (a part of a cent is dropped); null when it is not a usable
// amount.
const nlvCentsOf = (nlv: number | null): number | null =>
  nlv === null || !(nlv > 0 && Number.isFinite(nlv))
    ? null
    : Math.floor(nlv * 100 + CENT_NOISE);

/**
 * The room an approved draft holds in its sleeve, its name and the open risk: the max loss of its
 * stored order, and that amount as a share of the account value now (null when the account value
 * is unavailable). null for a draft that is not approved. Throws, as sizeDrafts does, when the
 * stored order is not the order of the draft.
 */
export const approvedRoomOf = (
  draft: GoLiveSizingDraft,
  nlv: number | null
): GoLiveDraftOutput["approvedRoom"] => {
  const lossCents = approvedLossCents(draft);
  if (lossCents === null) return null;
  const nlvCents = nlvCentsOf(nlv);
  return {
    maxLoss: lossCents / 100,
    // An account value below one cent has no share to show.
    maxLossPctNlv:
      nlvCents === null || nlvCents === 0
        ? null
        : round2((lossCents / nlvCents) * 100),
  };
};

/**
 * Quantity and max loss of every draft, in the order given. Money is counted in whole cents.
 * Per draft: budget = positionRiskPct% of NLV, rounded down to the cent; quantity =
 * floor(budget / max loss per spread). A quantity above what one order may hold is not reduced:
 * quantity 0 (quantity_above_order_limit).
 *
 * Cap room, in this order:
 * 1. Every approved draft holds one position and the max loss of its STORED order (quantity x
 *    max loss per spread at the approved limit) in its sleeve, its name and the open risk,
 *    whatever the account value and the quote are now. Its own sizing in the answer is what the
 *    position budget would buy today; no cap is applied to that figure.
 * 2. Proposed drafts with the entry basis signal_today, by sleeve order in the plan, then symbol,
 *    then id, pass the caps in this fixed order: sleeve budget, name cap, open risk cap, max
 *    positions. A draft that does not fit whole gets quantity 0 and the reason of the first cap
 *    it breaks.
 * Every other draft takes no room and is sized on the position budget alone: a rejected or an
 * expired draft (to show what was proposed), and a late entry (model_holds_account_does_not),
 * which can never be approved and which the account does not hold.
 */
export const sizeDrafts = <T extends GoLiveSizingDraft>(
  plan: GoLiveSizingPlan | null,
  drafts: readonly T[],
  nlv: number | null
): Readonly<{ draft: T; sizing: GoLiveSizing }>[] => {
  // Before anything else, also before the account value is looked at: a draft with wrong
  // strikes or an approved draft without its order refuses the whole call.
  const entries = drafts.map((draft, index) => {
    assertStrikesFitStructure(draft);
    return { draft, held: approvedLossCents(draft), index };
  });
  const nlvCents = nlvCentsOf(nlv);
  if (nlvCents === null)
    return drafts.map((draft) => ({
      draft,
      sizing: unsized(null, "nlv_unavailable"),
    }));
  const { limits, sleeves } = plan ?? NO_PLAN;
  const share = (pct: number): number => shareCents(nlvCents, pct);
  const budgetCents = share(limits.positionRiskPct);
  const budget = budgetCents / 100;
  const sleeveRank = (key: string): number => {
    const index = sleeves.findIndex((sleeve) => sleeve.key === key);
    return index === -1 ? sleeves.length : index;
  };
  const usedBySleeve = new Map<string, number>();
  const usedByName = new Map<string, number>();
  let openRisk = 0;
  let positions = 0;

  const hold = (draft: T, lossCents: number): void => {
    usedBySleeve.set(
      draft.sleeveKey,
      (usedBySleeve.get(draft.sleeveKey) ?? 0) + lossCents
    );
    usedByName.set(
      draft.symbol,
      (usedByName.get(draft.symbol) ?? 0) + lossCents
    );
    openRisk += lossCents;
    positions += 1;
  };
  // Step 1: approved drafts first, without a cap check. The owner approved them.
  for (const { draft, held } of entries) if (held !== null) hold(draft, held);

  const capReason = (draft: T, lossCents: number): SizingReason => {
    const sleeve = sleeves.find((entry) => entry.key === draft.sleeveKey);
    const inSleeve = usedBySleeve.get(draft.sleeveKey) ?? 0;
    const inName = usedByName.get(draft.symbol) ?? 0;
    if (inSleeve + lossCents > share(sleeve?.budgetPct ?? 0))
      return "sleeve_budget_used";
    if (inName + lossCents > share(limits.nameRiskCapPct))
      return "name_cap_reached";
    if (openRisk + lossCents > share(limits.openRiskCapPct))
      return "open_risk_cap_reached";
    if (positions + 1 > limits.maxPositions) return "max_positions_reached";
    hold(draft, lossCents);
    return "sized";
  };

  const sizeOne = (draft: T): GoLiveSizing => {
    const width = strikeWidth(draft);
    const limitPrice = limitFromQuote(draft.structure, draft.quote, width);
    if (limitPrice === null) return unsized(budget, "no_quote");
    // At least one cent: limitFromQuote keeps the limit a cent inside the width.
    const perSpread = lossCentsPerSpread(draft.structure, limitPrice, width);
    const quantity = Math.floor(budgetCents / perSpread);
    const lossCents = quantity * perSpread;
    let reason: SizingReason = "sized";
    if (quantity === 0) reason = "budget_below_one_spread";
    else if (quantity > GOLIVE_ORDER_MAX_QUANTITY)
      reason = "quantity_above_order_limit";
    else if (
      draft.state === "proposed" &&
      draft.entryBasis !== "model_holds_account_does_not"
    )
      reason = capReason(draft, lossCents);
    const fits = reason === "sized";
    return {
      budget,
      limitPrice,
      maxLoss: fits ? lossCents / 100 : null,
      maxLossPctNlv: fits ? round2((lossCents / nlvCents) * 100) : null,
      maxLossPerSpread: perSpread / 100,
      quantity: fits ? quantity : 0,
      reason,
    };
  };

  // Step 2. The order only matters between the drafts that take room.
  return entries
    .sort(
      (a, b) =>
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

const isLiveQuote = (
  quote: Pick<GoLiveQuote, "asOf" | "source"> | null,
  now: Date
): boolean => {
  if (quote === null || quote.source !== "ibkr_live") return false;
  const age = now.getTime() - quote.asOf.getTime();
  return (
    age >= -GOLIVE_QUOTE_MAX_FUTURE_SKEW_MS && age <= GOLIVE_QUOTE_MAX_AGE_MS
  );
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
