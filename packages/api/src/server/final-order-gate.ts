import type { JevVerdictOutput } from "../contracts/jev-verdict.ts";
import { daysToExpiry } from "./vertex-orders-rules.ts";

// Final JEV order gate (merge plan P6). One pure function that every order path (platform ticket,
// re-entry, harness, wish-list, ops scripts) calls after its own code gates and immediately before
// transmit. Owner rules enforced here (2026-11-02 / 2026-11-04):
// - options only, defined risk: a long option, a debit vertical or a defined-width credit vertical;
//   no shares, no naked short options, no ratio or mixed-expiry shapes;
// - max possible loss of a new position <= 2% of account value; unknown account value denies;
// - the P5 JEV verdict must be fresh and must not oppose the structure's direction; missing,
//   stale or unreachable denies. Risk-reducing orders (stops, closes) are sent when JEV is
//   unreachable, but an explicit JEV deny still blocks them.
// JEV never changes size or price: this gate only answers allow or deny with reasons.
// This module places no orders and reads no environment.

const MULTIPLIER = 100;
const FINAL_GATE_MAX_LOSS_PCT = 2;

export type FinalGateLeg = Readonly<{
  secType: string;
  expiry: string;
  strike: number;
  right: "C" | "P" | "";
  side: "BUY" | "SELL";
  ratio: number;
}>;

export type FinalGateOrder = Readonly<{
  symbol: string;
  legs: readonly FinalGateLeg[];
  quantity: number;
  // Per structure: positive = debit paid, negative = credit received.
  limitPrice: number;
  riskReducing: boolean;
  engine: string;
  reason: string;
}>;

export type StructureKind =
  | "long-option"
  | "debit-vertical"
  | "credit-vertical"
  | "risk-reducing"
  | "rejected";

export type Direction = "bullish" | "bearish";

export type Structure = Readonly<{
  kind: StructureKind;
  direction: Direction | null;
  maxLoss: number | null;
  reasons: readonly string[];
}>;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const rejected = (reason: string): Structure => ({
  direction: null,
  kind: "rejected",
  maxLoss: null,
  reasons: [reason],
});

const classifyVertical = (
  first: FinalGateLeg,
  second: FinalGateLeg,
  quantity: number,
  limitPrice: number
): Structure => {
  if (first.expiry !== second.expiry || first.right !== second.right)
    return rejected("A vertical needs one expiry and one right on both legs.");
  if (first.side === second.side)
    return rejected("A vertical needs one BUY leg and one SELL leg.");
  if (first.strike === second.strike)
    return rejected("A vertical needs two different strikes.");
  const buy = first.side === "BUY" ? first : second;
  const sell = first.side === "BUY" ? second : first;
  const width = Math.abs(buy.strike - sell.strike);
  const call = buy.right === "C";
  // Calls: the lower strike costs more. Puts: the higher strike costs more.
  const debit = call ? buy.strike < sell.strike : buy.strike > sell.strike;
  if (debit) {
    if (!(limitPrice > 0 && limitPrice < width))
      return rejected(
        "A debit vertical needs a debit limit above 0 and below the strike width."
      );
    return {
      direction: call ? "bullish" : "bearish",
      kind: "debit-vertical",
      maxLoss: round2(limitPrice * quantity * MULTIPLIER),
      reasons: [],
    };
  }
  const credit = -limitPrice;
  if (!(credit > 0 && credit < width))
    return rejected(
      "A credit vertical needs a credit limit above 0 and below the strike width."
    );
  return {
    direction: call ? "bearish" : "bullish",
    kind: "credit-vertical",
    maxLoss: round2((width - credit) * quantity * MULTIPLIER),
    reasons: [],
  };
};

export const classifyStructure = (order: FinalGateOrder): Structure => {
  const { legs, quantity, limitPrice } = order;
  if (legs.some((l) => l.secType !== "OPT"))
    return rejected("Options only: shares and other instruments are refused.");
  if (legs.some((l) => l.right !== "C" && l.right !== "P"))
    return rejected("Each leg needs right C or P.");
  if (legs.some((l) => l.ratio !== 1))
    return rejected("Ratio legs are refused: an extra short leg is naked.");
  if (!(quantity > 0 && Number.isInteger(quantity)))
    return rejected("Quantity must be a positive whole number.");

  const [first, second] = legs;
  if (legs.length === 1 && first !== undefined) {
    if (first.side !== "BUY")
      return rejected("A single SELL leg opens a naked short: refused.");
    if (!(limitPrice > 0))
      return rejected("A long option needs a debit limit.");
    return {
      direction: first.right === "C" ? "bullish" : "bearish",
      kind: "long-option",
      maxLoss: round2(limitPrice * quantity * MULTIPLIER),
      reasons: [],
    };
  }
  if (legs.length !== 2 || first === undefined || second === undefined)
    return rejected("Only single legs and two-leg verticals are allowed.");

  return classifyVertical(first, second, quantity, limitPrice);
};

export type FinalGateInput = Readonly<{
  order: FinalGateOrder;
  // Account value (NLV) from a fresh snapshot; null when unknown.
  accountValue: number | null;
  // P5 verdict; null when JEV or the verdict store is unreachable.
  jev: JevVerdictOutput | null;
  // true when JEV was reached for this order and answered deny.
  jevDenied?: boolean;
  now: Date;
}>;

export type FinalGateDecision = Readonly<{
  decision: "allow" | "deny";
  structure: StructureKind;
  maxLoss: number | null;
  maxLossPct: number | null;
  jevState: "fresh" | "stale" | "none" | "unreachable";
  reasons: readonly string[];
}>;

const jevReasons = (
  jev: JevVerdictOutput | null,
  direction: Direction | null
): string[] => {
  if (jev === null) return ["JEV verdict is unreachable: deny."];
  if (jev.state !== "fresh" || jev.verdict === null)
    return [`JEV verdict is ${jev.state}: a fresh verdict is required.`];
  const stance = jev.verdict.stance;
  if (
    (direction === "bullish" && stance === "BEARISH") ||
    (direction === "bearish" && stance === "BULLISH")
  )
    return [`JEV stance ${stance} opposes this ${direction} structure.`];
  return [];
};

export const evaluateFinalOrderGate = (
  input: FinalGateInput
): FinalGateDecision => {
  const { order, accountValue, jev, now } = input;
  const reasons: string[] = [];
  const jevState = jev === null ? "unreachable" : jev.state;

  for (const l of order.legs) {
    const days = l.secType === "OPT" ? daysToExpiry(l.expiry, now) : 0;
    if (days === null || days < 0)
      reasons.push(
        `Leg ${l.expiry} ${l.strike}${l.right}: expiry is not valid.`
      );
  }
  if (input.jevDenied === true) reasons.push("JEV denied this order.");

  if (order.riskReducing) {
    // Stops and closes: no structure or loss check (they remove risk); a JEV outage never blocks.
    return {
      decision: reasons.length === 0 ? "allow" : "deny",
      jevState,
      maxLoss: null,
      maxLossPct: null,
      reasons:
        reasons.length === 0 && jevState !== "fresh"
          ? ["Risk-reducing order sent without a fresh JEV verdict (logged)."]
          : reasons,
      structure: "risk-reducing",
    };
  }

  const structure = classifyStructure(order);
  reasons.push(...structure.reasons);

  let maxLossPct: number | null = null;
  if (accountValue === null || !(accountValue > 0))
    reasons.push(
      "Account value is unknown: cannot check the 2% max-loss gate."
    );
  else if (structure.maxLoss !== null) {
    maxLossPct = round2((structure.maxLoss / accountValue) * 100);
    if (
      structure.maxLoss >
      (accountValue * FINAL_GATE_MAX_LOSS_PCT) / 100 + 1e-6
    )
      reasons.push(
        `Max loss $${structure.maxLoss} is ${maxLossPct}%; the limit is ${FINAL_GATE_MAX_LOSS_PCT}% of account value.`
      );
  }

  reasons.push(...jevReasons(jev, structure.direction));

  return {
    decision: reasons.length === 0 ? "allow" : "deny",
    jevState,
    maxLoss: structure.maxLoss,
    maxLossPct,
    reasons,
    structure: structure.kind,
  };
};
