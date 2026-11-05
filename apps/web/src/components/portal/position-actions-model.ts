import type {
  PortfolioMonitorPosition,
  VertexComboInput,
  VertexOrderInput,
} from "@darkfactory/api";

// Per-position order actions (owner 2026-11-04): Close (full quantity), Buy 1, Sell 1. The
// server applies every order rule again; this file only builds the default order to review.

export type PositionAction = "close" | "buy" | "sell";

export type OptionContract = Readonly<{
  symbol: string;
  expiry: string;
  strike: number;
  right: "C" | "P";
}>;

// Two description forms: the Vertex portfolio feed ("SYMBOL YYYYMMDD STRIKE RIGHT", see
// describePosition in packages/api/src/server/portfolio-monitor.ts) and the OCC option symbol
// (root, YYMMDD, C or P, strike x 1000 in 8 digits, for example "SPY   261218C00500000").
const FEED = /^\s*\S+\s+(\d{8})\s+(\d+(?:\.\d+)?)\s+(C|P|CALL|PUT)\s*$/u;
const OCC = /^\s*([A-Z0-9.]{1,6})\s*(\d{2})(\d{4})([CP])(\d{8})\s*$/u;

const contractParts = (
  description: string
): Readonly<{
  root: string;
  expiry: string;
  strike: number;
  right: string;
}> | null => {
  const text = description.toUpperCase();
  const feed = FEED.exec(text);
  if (feed !== null)
    return {
      root: "",
      expiry: String(feed[1]),
      strike: Number(feed[2]),
      right: String(feed[3]),
    };
  const occ = OCC.exec(text);
  if (occ === null) return null;
  return {
    root: String(occ[1]),
    expiry: `20${occ[2]}${occ[3]}`,
    strike: Number(occ[5]) / 1000,
    right: String(occ[4]),
  };
};

// Contract fields of an order: an option, or shares (expiry "", strike 0, right "").
export type OrderContract = Readonly<{
  symbol: string;
  expiry: string;
  strike: number;
  right: "C" | "P" | "";
}>;

// Shares (IBKR STK, which includes ETFs) can always be closed (owner 2026-11-04).
export const shareContract = (
  position: Pick<PortfolioMonitorPosition, "secType" | "symbol">
): OrderContract | null =>
  position.secType.trim().toUpperCase() === "STK"
    ? {
        symbol: position.symbol.trim().toUpperCase(),
        expiry: "",
        strike: 0,
        right: "",
      }
    : null;

// Structured IBKR fields first (expiry YYYYMMDD, strike > 0, right C/P/CALL/PUT), else the text.
const structuredParts = (
  option: PortfolioMonitorPosition["option"]
): Readonly<{
  root: string;
  expiry: string;
  strike: number;
  right: string;
}> | null => {
  if (option === undefined) return null;
  const right = option.right.trim().toUpperCase();
  const expiry = option.expiry.trim().slice(0, 8);
  return /^\d{8}$/u.test(expiry) &&
    option.strike > 0 &&
    /^(C|P|CALL|PUT)$/u.test(right)
    ? { root: "", expiry, strike: option.strike, right }
    : null;
};

export const parseOptionContract = (
  position: Pick<
    PortfolioMonitorPosition,
    "secType" | "description" | "symbol" | "option"
  >
): OptionContract | null => {
  if (position.secType.trim().toUpperCase() !== "OPT") return null;
  const parts =
    structuredParts(position.option) ?? contractParts(position.description);
  if (parts === null) return null;
  return {
    symbol: position.symbol.trim().toUpperCase() || parts.root,
    expiry: parts.expiry,
    strike: parts.strike,
    right: parts.right.startsWith("P") ? "P" : "C",
  };
};

// Fraction the marketable limit moves past the mark toward the fill side: 5% for options, 1% for
// shares.
const MARKETABLE_OFFSET = 0.05;
const SHARE_MARKETABLE_OFFSET = 0.01;

const roundCents = (value: number): number =>
  Math.max(0.01, Math.round(value * 100) / 100);

// Default limit: the mark (IBKR last/mark price; the monitor feed has no bid/ask, so this is the
// best available mid estimate). "Marketable" moves it 5% toward the fill side.
export const defaultLimit = (
  mark: number | null,
  side: "BUY" | "SELL",
  marketable: boolean,
  offset: number = MARKETABLE_OFFSET
): number | null => {
  if (mark === null || !Number.isFinite(mark) || mark <= 0) return null;
  if (!marketable) return roundCents(mark);
  return roundCents(side === "BUY" ? mark * (1 + offset) : mark * (1 - offset));
};

export const actionSide = (
  action: PositionAction,
  heldQuantity: number
): "BUY" | "SELL" => {
  if (action === "buy") return "BUY";
  if (action === "sell") return "SELL";
  return heldQuantity < 0 ? "BUY" : "SELL";
};

export const actionQuantity = (
  action: PositionAction,
  heldQuantity: number
): number => (action === "close" ? Math.abs(Math.trunc(heldQuantity)) : 1);

export type PositionOrderDraft = Readonly<{
  secType: "OPT" | "STK";
  contract: OrderContract;
  side: "BUY" | "SELL";
  quantity: number;
  limitPrice: number | null;
}>;

// Why a row has no order buttons: an option whose contract could not be parsed, or a security
// type the order path does not support (for example futures).
export const actionsUnavailableReason = (
  position: Pick<PortfolioMonitorPosition, "secType">
): string => {
  const code = position.secType.trim().toUpperCase();
  return code === "OPT"
    ? "Contract not recognized"
    : `Not supported here (${code || "unknown"})`;
};

export const draftFor = (
  contract: OrderContract,
  position: PortfolioMonitorPosition,
  action: PositionAction,
  marketable: boolean,
  secType: "OPT" | "STK" = "OPT"
): PositionOrderDraft => {
  const side = actionSide(action, position.position);
  return {
    secType,
    contract,
    side,
    quantity: actionQuantity(action, position.position),
    limitPrice: defaultLimit(
      position.last,
      side,
      marketable,
      secType === "STK" ? SHARE_MARKETABLE_OFFSET : MARKETABLE_OFFSET
    ),
  };
};

export const toPositionOrderInput = (
  draft: PositionOrderDraft,
  quantity: number,
  limitPrice: number
): VertexOrderInput => ({
  symbol: draft.contract.symbol,
  secType: draft.secType,
  expiry: draft.contract.expiry,
  strike: draft.contract.strike,
  right: draft.contract.right,
  side: draft.side,
  quantity,
  orderType: "LMT",
  limitPrice,
});

// Estimated cost (BUY) or proceeds (SELL) in USD: quantity x limit x multiplier (100 per option
// contract, 1 per share).
export const estimatedAmount = (
  quantity: number,
  limitPrice: number,
  multiplier = 100
): number => Math.round(quantity * limitPrice * multiplier * 100) / 100;

// ---------- spreads (owner 2026-11-04: close as ONE combo order, never leg by leg) ----------

export type ComboLegDraft = Readonly<{
  contract: OptionContract;
  held: number;
  side: "BUY" | "SELL";
  ratio: number;
  mark: number | null;
}>;

export type ComboDraft = Readonly<{
  symbol: string;
  quantity: number;
  legs: readonly ComboLegDraft[];
  // Net per combo at the marks: positive = debit paid, negative = credit received.
  limitPrice: number | null;
}>;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

// The option legs of this position's name when they form a spread (two or more legs, one short),
// else null. A spread leg that cannot be parsed makes the whole group unusable ("unparsed").
export const spreadGroup = (
  position: PortfolioMonitorPosition,
  positions: readonly PortfolioMonitorPosition[]
): readonly PortfolioMonitorPosition[] | "unparsed" | null => {
  const legs = positions.filter(
    (p) =>
      p.secType.trim().toUpperCase() === "OPT" &&
      p.symbol === position.symbol &&
      p.position !== 0
  );
  if (legs.length < 2 || !legs.some((p) => p.position < 0)) return null;
  return legs.every((p) => parseOptionContract(p) !== null) ? legs : "unparsed";
};

export const comboDraft = (
  symbol: string,
  legs: readonly PortfolioMonitorPosition[],
  marketable: boolean
): ComboDraft => {
  const quantity = legs
    .map((p) => Math.abs(Math.trunc(p.position)))
    .reduce(gcd);
  const drafts = legs.map(
    (p): ComboLegDraft => ({
      // spreadGroup only returns legs that parse.
      contract: parseOptionContract(p) as OptionContract,
      held: p.position,
      side: p.position > 0 ? "SELL" : "BUY",
      ratio: Math.abs(Math.trunc(p.position)) / quantity,
      mark: p.last,
    })
  );
  return {
    symbol,
    quantity,
    legs: drafts,
    limitPrice: comboLimit(drafts, marketable),
  };
};

// Net per combo at the marks (BUY legs add, SELL legs subtract). "Marketable" pays 5% of the net
// more (or accepts 5% less credit) so the order fills sooner.
export const comboLimit = (
  legs: readonly ComboLegDraft[],
  marketable: boolean
): number | null => {
  if (legs.some((leg) => leg.mark === null)) return null;
  const net = legs.reduce(
    (sum, leg) =>
      // Every mark is a number here (checked above).
      sum + (leg.side === "BUY" ? 1 : -1) * leg.ratio * (leg.mark as number),
    0
  );
  const value = marketable ? net + Math.abs(net) * MARKETABLE_OFFSET : net;
  return Math.round(value * 100) / 100;
};

export const toComboInput = (
  draft: ComboDraft,
  limitPrice: number
): VertexComboInput => ({
  symbol: draft.symbol,
  quantity: draft.quantity,
  limitPrice,
  legs: draft.legs.map((leg) => ({
    expiry: leg.contract.expiry,
    strike: leg.contract.strike,
    right: leg.contract.right,
    side: leg.side,
    ratio: leg.ratio,
  })),
});
