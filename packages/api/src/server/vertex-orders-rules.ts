import type {
  VertexComboInput,
  VertexComboReview,
  VertexOrderInput,
  VertexOrderReview,
} from "../contracts/vertex-orders.ts";

// Pure order rules for the owner order screen. The server applies them on preview AND again on
// submit, from a fresh account snapshot. Owner rules (2026-10-16/22): options only; limit orders
// only; premium per name, including premium already open in that name, <= 6% NLV for LEAPS
// (expiry >= 365 days) and <= 2% NLV for shorter-dated options. A short-dated buy must also keep
// the name's total option premium within 6%. SELL only closes held contracts (no naked short).
// Calls and puts are allowed (Vertex order tail, own client id, 2026-11-04).

// Premium caps are not set here. They arrive with each account snapshot (OrderAccount.caps): the
// live bridge reports the IBKR gateway's effective caps (market_watch/premium_caps.py), so this
// screen never promises more than the gateway accepts. The mock reports MOCK_PREMIUM_CAPS.
export type PremiumCaps = Readonly<{
  leapsMinDays: number;
  leapsPct: number;
  shortPct: number;
}>;
const CONTRACT_MULTIPLIER = 100;
// Owner hard gate 2026-11-02: max possible loss of a new position <= 2% of account value.
export const MAX_LOSS_PCT = 2;
const DAY_MS = 86_400_000;

export type OrderPosition = Readonly<{
  symbol: string;
  // Only "OPT" rows count as option premium or held contracts; share rows are ignored.
  secType: string;
  expiry: string;
  strike: number;
  right: string;
  quantity: number;
  // Cost basis in USD for the whole position (open premium).
  premium: number;
}>;

export type GatewayOpenOrder = Readonly<{
  permId: number;
  symbol: string;
  secType: string;
  expiry: string | null;
  strike: number | null;
  right: string | null;
  side: string;
  quantity: number;
  orderType: string;
  limitPrice: number | null;
  status: string;
  orderRef: string;
}>;

export type OrderGates = Readonly<{
  killSwitch: boolean;
  optionsOnly: boolean;
}>;

export type OrderAccount = Readonly<{
  netLiquidation: number | null;
  positions: readonly OrderPosition[];
  openOrders: readonly GatewayOpenOrder[];
  gates: OrderGates;
  caps: PremiumCaps;
}>;

const round2 = (value: number): number => Math.round(value * 100) / 100;

export const parseExpiry = (expiry: string): Date | null => {
  const year = Number(expiry.slice(0, 4));
  const month = Number(expiry.slice(4, 6));
  const day = Number(expiry.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
};

export const daysToExpiry = (expiry: string, now: Date): number | null => {
  const date = parseExpiry(expiry);
  if (date === null) return null;
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  return Math.round((date.getTime() - today) / DAY_MS);
};

const isLeaps = (expiry: string | null, now: Date, minDays: number): boolean =>
  expiry !== null && (daysToExpiry(expiry, now) ?? 0) >= minDays;

export const contractLabel = (order: VertexOrderInput): string =>
  `${order.symbol} ${order.expiry} ${order.strike} ${order.right === "C" ? "call" : "put"}`;

export const sameContract = (
  order: Readonly<{
    symbol: string;
    expiry: string;
    strike: number;
    right: string;
  }>,
  other: Readonly<{
    symbol: string;
    expiry: string | null;
    strike: number | null;
    right: string | null;
  }>
): boolean =>
  other.symbol === order.symbol &&
  other.expiry === order.expiry &&
  other.right === order.right &&
  other.strike !== null &&
  Math.abs(other.strike - order.strike) < 1e-6;

// Open premium in one name: held option cost basis plus resting BUY option orders.
export const openPremium = (
  account: OrderAccount,
  name: string,
  now: Date,
  bucket: "all" | "short-dated"
): number => {
  const keep = (expiry: string | null): boolean =>
    bucket === "all" || !isLeaps(expiry, now, account.caps.leapsMinDays);
  const held = account.positions
    .filter((p) => p.secType === "OPT" && p.symbol === name && keep(p.expiry))
    .reduce((sum, p) => sum + Math.max(0, p.premium), 0);
  const resting = account.openOrders
    .filter(
      (o) =>
        o.symbol === name &&
        o.secType === "OPT" &&
        o.side === "BUY" &&
        keep(o.expiry)
    )
    .reduce(
      (sum, o) => sum + o.quantity * (o.limitPrice ?? 0) * CONTRACT_MULTIPLIER,
      0
    );
  return round2(held + resting);
};

// A working combo (BAG) on the name may already be closing it: no second order until it is done.
const workingCombo = (account: OrderAccount, name: string): boolean =>
  account.openOrders.some((o) => o.secType === "BAG" && o.symbol === name);

const WORKING_COMBO = (name: string) =>
  `A combo order on ${name} is still working: wait for it or cancel it first.`;

// Shares can only be closed or reduced here (owner 2026-11-04: every held position has a working
// Close; options only applies to NEW positions). Only the kill switch, a non-limit order, a size
// beyond the holding or a resting order on the shares (for example a stop) blocks it.
const evaluateShareClose = (
  order: VertexOrderInput,
  account: OrderAccount
): VertexOrderReview => {
  const reasons: string[] = [];
  const held = account.positions
    .filter((p) => p.secType === "STK" && p.symbol === order.symbol)
    .reduce((sum, p) => sum + p.quantity, 0);
  const buy = order.side === "BUY";
  const reduces = buy ? order.quantity <= -held : order.quantity <= held;
  if (order.orderType !== "LMT")
    reasons.push("Limit orders only: set orderType LMT with a limit price.");
  if (!reduces)
    reasons.push(
      `${order.side} ${order.quantity} with ${held} shares held: shares can only be closed or reduced here (options only for new positions).`
    );
  if (
    account.openOrders.some(
      (o) => o.symbol === order.symbol && o.secType === "STK"
    )
  )
    reasons.push(
      `An open order (for example a stop) rests on ${order.symbol} shares: cancel it first.`
    );
  const notional = round2(order.quantity * order.limitPrice);
  return {
    order,
    contractLabel: `${order.symbol} shares`,
    daysToExpiry: 0,
    premium: notional,
    premiumPctNlv:
      account.netLiquidation !== null && account.netLiquidation > 0
        ? round2((notional / account.netLiquidation) * 100)
        : null,
    netLiquidation: account.netLiquidation,
    heldContracts: held,
    cap: {
      kind: "none",
      label: buy
        ? "No cap: closing buy (covers a short)"
        : "No cap: closing sale",
      limitPct: 0,
      limitAmount: 0,
      openPremium: 0,
      afterOrder: 0,
      afterOrderPct: 0,
    },
    accepted: reasons.length === 0,
    reasons,
  };
};

export const evaluateOrder = (
  order: VertexOrderInput,
  account: OrderAccount,
  now: Date
): VertexOrderReview => {
  if (order.secType === "STK") return evaluateShareClose(order, account);
  const reasons: string[] = [];
  const nlv = account.netLiquidation;
  const premium = round2(
    order.quantity * order.limitPrice * CONTRACT_MULTIPLIER
  );
  const days = daysToExpiry(order.expiry, now);
  const leaps = days !== null && days >= account.caps.leapsMinDays;
  const buy = order.side === "BUY";
  const held = account.positions
    .filter((p) => p.secType === "OPT" && sameContract(order, p))
    .reduce((sum, p) => sum + p.quantity, 0);
  // A closing order only reduces a held position: SELL against a long, or BUY against a short
  // (owner 2026-11-04: closing and reducing is always allowed, also on expiry day).
  const closing = buy
    ? held < 0 && order.quantity <= -held
    : order.quantity <= held;
  const opening = buy && !closing;

  if (order.secType !== "OPT")
    reasons.push(
      "Options only for new positions: only option (OPT) or share-close (STK) orders are allowed."
    );
  if (order.right !== "C" && order.right !== "P")
    reasons.push("Option right must be C (call) or P (put).");
  if (!(order.strike > 0)) reasons.push("Option strike must be positive.");
  if (order.orderType !== "LMT")
    reasons.push("Limit orders only: set orderType LMT with a limit price.");
  if (days === null) reasons.push("Expiry is not a valid date.");
  else if (days < 0 || (days < 1 && !closing))
    reasons.push(
      days < 0
        ? "Expiry must be after today."
        : "Expiry must be after today (only a closing order may trade on expiry day)."
    );
  // The kill switch blocks opening and increasing only (owner 2026-11-04: Close no matter what).
  if (opening && account.gates.killSwitch)
    reasons.push(
      "Kill switch is on: no opening or increasing orders (closing stays allowed)."
    );
  // Closing and reducing is never blocked by the options-only or max-loss gates (owner 2026-11-04).
  if (opening && !account.gates.optionsOnly)
    reasons.push(
      "Trading gate OPTIONS_ONLY is not confirmed on: no new positions."
    );
  if (opening && (nlv === null || !(nlv > 0)))
    reasons.push("Net liquidation is unknown: cannot check the premium caps.");
  if (workingCombo(account, order.symbol))
    reasons.push(WORKING_COMBO(order.symbol));
  if (
    account.openOrders.some(
      (o) => sameContract(order, o) && o.secType === "OPT"
    )
  )
    reasons.push("An open order for this contract already exists.");
  // Never leg out of a spread (owner 2026-11-04): a name with a short option leg is a spread; its
  // legs close together as one combo order (evaluateCombo), not one by one.
  if (closing && isSpreadName(account, order.symbol))
    reasons.push(
      `${order.symbol} options form a spread: close it as one combo order (Close), not leg by leg.`
    );
  // No naked shorts (standing rule 2026-11-04): a SELL that opens a short is refused. Sell-to-open is
  // only allowed as a leg of a defined-width spread, which a single order never is.
  if (!buy && order.quantity > held)
    reasons.push(
      `Sell ${order.quantity} > held ${held} contracts: SELL only closes held contracts. Sell-to-open is only allowed as a leg of a defined-width spread (no naked short).`
    );

  const kind = opening ? (leaps ? "leaps" : "short-dated") : "none";
  const limitPct =
    kind === "leaps"
      ? account.caps.leapsPct
      : kind === "short-dated"
        ? account.caps.shortPct
        : 0;
  const bucketOpen =
    kind === "short-dated"
      ? openPremium(account, order.symbol, now, "short-dated")
      : openPremium(account, order.symbol, now, "all");
  const afterOrder = round2(bucketOpen + (opening ? premium : 0));
  const usableNlv = nlv !== null && nlv > 0 ? nlv : null;
  const limitAmount =
    usableNlv === null ? 0 : round2((usableNlv * limitPct) / 100);
  const afterOrderPct =
    usableNlv === null ? 0 : round2((afterOrder / usableNlv) * 100);

  if (opening && usableNlv !== null) {
    if (afterOrder > limitAmount + 1e-6)
      reasons.push(
        `Premium cap: ${order.symbol} would hold $${afterOrder} (${afterOrderPct}% NLV) of ${kind === "leaps" ? "LEAPS" : "short-dated"} premium; the cap is ${limitPct}% ($${limitAmount}).`
      );
    if (kind === "short-dated") {
      const total = round2(
        openPremium(account, order.symbol, now, "all") + premium
      );
      const totalCap = round2((usableNlv * account.caps.leapsPct) / 100);
      if (total > totalCap + 1e-6)
        reasons.push(
          `Premium cap: ${order.symbol} total option premium would be $${total}; the per-name maximum is ${account.caps.leapsPct}% ($${totalCap}).`
        );
    }
  }

  // Hard max-loss gate (owner 2026-11-02): a new long option can lose its whole premium, so an
  // opening BUY whose premium is above 2% NLV is refused, whatever the per-name cap allows.
  if (
    opening &&
    usableNlv !== null &&
    premium > (usableNlv * MAX_LOSS_PCT) / 100 + 1e-6
  )
    reasons.push(
      `Max loss: this order risks $${premium} (${round2((premium / usableNlv) * 100)}% NLV); new positions are limited to ${MAX_LOSS_PCT}% NLV.`
    );

  return {
    order,
    contractLabel: contractLabel(order),
    daysToExpiry: days ?? 0,
    premium,
    premiumPctNlv:
      usableNlv === null ? null : round2((premium / usableNlv) * 100),
    netLiquidation: nlv,
    heldContracts: held,
    cap: {
      kind,
      label:
        kind === "leaps"
          ? `LEAPS cap ${account.caps.leapsPct}% NLV per name`
          : kind === "short-dated"
            ? `Short-dated cap ${account.caps.shortPct}% NLV per name`
            : buy
              ? "No cap: closing buy (covers a short)"
              : "No cap: closing sale",
      limitPct,
      limitAmount,
      openPremium: bucketOpen,
      afterOrder,
      afterOrderPct,
    },
    accepted: reasons.length === 0,
    reasons,
  };
};

// A name with two or more option legs, at least one of them short, is treated as a spread.
const isSpreadName = (account: OrderAccount, name: string): boolean => {
  const legs = account.positions.filter(
    (p) => p.secType === "OPT" && p.symbol === name && p.quantity !== 0
  );
  return legs.length >= 2 && legs.some((p) => p.quantity < 0);
};

const comboLabel = (order: VertexComboInput): string =>
  `${order.symbol} combo x${order.quantity}: ${order.legs
    .map(
      (leg) =>
        `${leg.side} ${leg.ratio > 1 ? `${leg.ratio}x ` : ""}${leg.expiry} ${leg.strike}${leg.right}`
    )
    .join(" / ")}`;

// Spread close as ONE combo order. Close-only: every leg must reverse a held leg exactly
// (ratio x quantity == held size), so the order removes the whole spread and opens nothing.
export const evaluateCombo = (
  order: VertexComboInput,
  account: OrderAccount,
  now: Date
): VertexComboReview => {
  const reasons: string[] = [];
  // Close-only by construction, so the kill switch does not block it (owner 2026-11-04).
  if (workingCombo(account, order.symbol))
    reasons.push(WORKING_COMBO(order.symbol));
  const keys = order.legs.map(
    (leg) => `${leg.expiry}:${leg.strike}:${leg.right}`
  );
  if (new Set(keys).size !== keys.length)
    reasons.push("Each leg must be a different contract.");
  for (const leg of order.legs) {
    const contract = { symbol: order.symbol, ...leg };
    const label = `${leg.expiry} ${leg.strike}${leg.right}`;
    const held = account.positions
      .filter((p) => p.secType === "OPT" && sameContract(contract, p))
      .reduce((sum, p) => sum + p.quantity, 0);
    const size = leg.ratio * order.quantity;
    const reverses = leg.side === "SELL" ? held === size : -held === size;
    if (!reverses)
      reasons.push(
        `Leg ${leg.side} ${size} ${label} does not close the held ${held} exactly (close-only, no legging out).`
      );
    const days = daysToExpiry(leg.expiry, now);
    if (days === null || days < 0)
      reasons.push(`Leg ${label}: expiry is not a valid future date.`);
    if (
      account.openOrders.some(
        (o) => o.secType === "OPT" && sameContract(contract, o)
      )
    )
      reasons.push(
        `Leg ${label}: an open order rests on this contract; cancel it first.`
      );
  }
  return {
    order,
    label: comboLabel(order),
    netAmount: round2(order.limitPrice * order.quantity * CONTRACT_MULTIPLIER),
    accepted: reasons.length === 0,
    reasons,
  };
};

// Per-name premium caps for an opening debit vertical, counted like a long option buy: the net
// debit plus premium already open in the name stays within the LEAPS cap (all expiries) and, for
// a short-dated spread, within the short-dated cap. Credit verticals pay no premium.
const comboPremiumReasons = (
  order: VertexComboInput,
  account: OrderAccount,
  now: Date
): string[] => {
  const debit = round2(order.limitPrice * order.quantity * CONTRACT_MULTIPLIER);
  const nlv = account.netLiquidation;
  if (!(debit > 0) || nlv === null || !(nlv > 0)) return [];
  const { leapsMinDays, leapsPct, shortPct } = account.caps;
  const reasons: string[] = [];
  const total = round2(openPremium(account, order.symbol, now, "all") + debit);
  const totalCap = round2((nlv * leapsPct) / 100);
  if (total > totalCap + 1e-6)
    reasons.push(
      `Premium cap: ${order.symbol} total option premium would be $${total}; the per-name maximum is ${leapsPct}% ($${totalCap}).`
    );
  const shortDated = order.legs.some(
    (leg) => (daysToExpiry(leg.expiry, now) ?? 0) < leapsMinDays
  );
  const bucket = round2(
    openPremium(account, order.symbol, now, "short-dated") + debit
  );
  const bucketCap = round2((nlv * shortPct) / 100);
  if (shortDated && bucket > bucketCap + 1e-6)
    reasons.push(
      `Premium cap: ${order.symbol} would hold $${bucket} of short-dated premium; the cap is ${shortPct}% ($${bucketCap}).`
    );
  return reasons;
};

// Opening vertical as ONE combo order (merge plan P6). Both gateways call this (the live order tail accepts opening verticals, market-watch-bot PR #36); the
// structure, the 2% max loss and the JEV verdict are checked by the final gate
// (final-order-gate.ts). Here: the account gates and the order-book checks.
export const evaluateOpeningCombo = (
  order: VertexComboInput,
  account: OrderAccount,
  now: Date
): VertexComboReview => {
  const reasons: string[] = [];
  if (account.gates.killSwitch)
    reasons.push("Kill switch is on: no opening or increasing orders.");
  if (!account.gates.optionsOnly)
    reasons.push(
      "Trading gate OPTIONS_ONLY is not confirmed on: no new positions."
    );
  if (workingCombo(account, order.symbol))
    reasons.push(WORKING_COMBO(order.symbol));
  for (const leg of order.legs) {
    const label = `${leg.expiry} ${leg.strike}${leg.right}`;
    const days = daysToExpiry(leg.expiry, now);
    if (days === null || days < 1)
      reasons.push(`Leg ${label}: expiry must be after today.`);
    if (
      account.openOrders.some(
        (o) =>
          o.secType === "OPT" &&
          sameContract({ symbol: order.symbol, ...leg }, o)
      )
    )
      reasons.push(
        `Leg ${label}: an open order rests on this contract; cancel it first.`
      );
  }
  reasons.push(...comboPremiumReasons(order, account, now));
  return {
    accepted: reasons.length === 0,
    label: comboLabel(order),
    netAmount: round2(order.limitPrice * order.quantity * CONTRACT_MULTIPLIER),
    order,
    reasons,
  };
};
