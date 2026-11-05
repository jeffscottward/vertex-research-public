import type {
  PortfolioMonitorPosition,
  VertexOrderInput,
} from "@darkfactory/api";

// Per-position order actions (owner 2026-11-04): Close (full quantity), Buy 1, Sell 1. The
// server applies every order rule again; this file only builds the default order to review.

export type PositionAction = "close" | "buy" | "sell";

export type OptionContract = Readonly<{
  symbol: string;
  expiry: string;
  strike: number;
  right: "C";
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

export const parseOptionContract = (
  position: Pick<PortfolioMonitorPosition, "secType" | "description" | "symbol">
): OptionContract | null => {
  if (position.secType.trim().toUpperCase() !== "OPT") return null;
  const parts = contractParts(position.description);
  // The IBKR order gateway places calls only, so put rows get no buttons.
  if (parts === null || parts.right.startsWith("P")) return null;
  return {
    symbol: position.symbol.trim().toUpperCase() || parts.root,
    expiry: parts.expiry,
    strike: parts.strike,
    right: "C",
  };
};

// Fraction the marketable limit moves past the mark toward the fill side.
const MARKETABLE_OFFSET = 0.05;

const roundCents = (value: number): number =>
  Math.max(0.01, Math.round(value * 100) / 100);

// Default limit: the mark (IBKR last/mark price; the monitor feed has no bid/ask, so this is the
// best available mid estimate). "Marketable" moves it 5% toward the fill side.
export const defaultLimit = (
  mark: number | null,
  side: "BUY" | "SELL",
  marketable: boolean
): number | null => {
  if (mark === null || !Number.isFinite(mark) || mark <= 0) return null;
  if (!marketable) return roundCents(mark);
  return roundCents(
    side === "BUY"
      ? mark * (1 + MARKETABLE_OFFSET)
      : mark * (1 - MARKETABLE_OFFSET)
  );
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
  contract: OptionContract;
  side: "BUY" | "SELL";
  quantity: number;
  limitPrice: number | null;
}>;

// Why a row has no order buttons (its contract could not be parsed).
export const actionsUnavailableReason = (
  position: Pick<PortfolioMonitorPosition, "secType" | "description">
): string => {
  if (position.secType.trim().toUpperCase() !== "OPT")
    return "Options only here";
  return contractParts(position.description)?.right.startsWith("P")
    ? "Puts: not supported by the order gateway"
    : "Contract not recognized";
};

export const draftFor = (
  contract: OptionContract,
  position: PortfolioMonitorPosition,
  action: PositionAction,
  marketable: boolean
): PositionOrderDraft => {
  const side = actionSide(action, position.position);
  return {
    contract,
    side,
    quantity: actionQuantity(action, position.position),
    limitPrice: defaultLimit(position.last, side, marketable),
  };
};

export const toPositionOrderInput = (
  draft: PositionOrderDraft,
  quantity: number,
  limitPrice: number
): VertexOrderInput => ({
  symbol: draft.contract.symbol,
  secType: "OPT",
  expiry: draft.contract.expiry,
  strike: draft.contract.strike,
  right: draft.contract.right,
  side: draft.side,
  quantity,
  orderType: "LMT",
  limitPrice,
});

// Estimated cost (BUY) or proceeds (SELL) in USD: contracts x limit x 100.
export const estimatedAmount = (quantity: number, limitPrice: number): number =>
  Math.round(quantity * limitPrice * 100 * 100) / 100;
