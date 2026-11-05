import type {
  VertexOrderInput,
  VertexOrderReview,
} from "../contracts/vertex-orders.ts";

// Pure order rules for the owner order screen. The server applies them on preview AND again on
// submit, from a fresh account snapshot. Owner rules (2026-10-16/22): options only; limit orders
// only; premium per name, including premium already open in that name, <= 6% NLV for LEAPS
// (expiry >= 365 days) and <= 2% NLV for shorter-dated options. A short-dated buy must also keep
// the name's total option premium within 6%. SELL only closes held contracts (no naked short).
// Puts are refused because the IBKR gateway places calls only.

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
const MAX_LOSS_PCT = 2;
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

export const evaluateOrder = (
  order: VertexOrderInput,
  account: OrderAccount,
  now: Date
): VertexOrderReview => {
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
      "Options only: share and ETF orders are not allowed (owner rule)."
    );
  if (order.orderType !== "LMT")
    reasons.push("Limit orders only: set orderType LMT with a limit price.");
  if (order.right !== "C")
    reasons.push("Calls only: the IBKR order gateway does not place puts.");
  if (days === null) reasons.push("Expiry is not a valid date.");
  else if (days < 0 || (days < 1 && !closing))
    reasons.push(
      days < 0
        ? "Expiry must be after today."
        : "Expiry must be after today (only a closing order may trade on expiry day)."
    );
  if (account.gates.killSwitch)
    reasons.push("Kill switch is on: no new orders.");
  if (!account.gates.optionsOnly)
    reasons.push("Trading gate OPTIONS_ONLY is not confirmed on: no orders.");
  if (nlv === null || !(nlv > 0))
    reasons.push("Net liquidation is unknown: cannot check the premium caps.");
  if (
    account.openOrders.some(
      (o) => sameContract(order, o) && o.secType === "OPT"
    )
  )
    reasons.push("An open order for this contract already exists.");
  if (!buy && order.quantity > held)
    reasons.push(
      `Sell ${order.quantity} > held ${held} contracts: SELL only closes held contracts (no short).`
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
