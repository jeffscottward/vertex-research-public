// Go-live caps at send (GO-LIVE 4 step 3, owner 2026-11-12). Pure: the account positions, the
// working orders and the account value are passed in. Before an approved draft is sent, the max
// loss it adds plus the max loss already at risk in the account (open positions AND working
// opening orders) must stay within the plan: total open risk <= openRiskCapPct of NLV, the name
// <= nameRiskCapPct, the order itself <= positionRiskPct. Every refusal has a name.
//
// Held risk is counted conservatively, in whole cents:
// - a short option is paired with a long of the same symbol, expiry and right (a vertical): the
//   strike width x 100 x paired contracts is at risk (an upper bound: a debit never exceeds the
//   width and the credit is not subtracted); the paired long contracts count nothing more;
// - a long option no short pairs with: its share of what was paid for it (|premium|);
// - a short option with no long to cover it is undefined risk: the send is refused
//   (UNDEFINED_RISK_HELD), never estimated;
// - a working order: its max loss as the bridge reports it, or, without one, refused
//   (WORKING_ORDER_RISK_UNKNOWN). Shares count their premium (cost) as at risk.
// Callers pass only the plan's names (golive-send-gate.ts).

export type HeldPosition = Readonly<{
  expiry: string;
  premium: number;
  quantity: number;
  right: string;
  secType: string;
  strike: number;
  symbol: string;
}>;

export type WorkingOrderRisk = Readonly<{
  maxLoss: number | null;
  symbol: string;
}>;

export type SendCapLimits = Readonly<{
  nameRiskCapPct: number;
  openRiskCapPct: number;
  positionRiskPct: number;
}>;

export const SEND_CAP_REFUSALS = [
  "NLV_UNAVAILABLE",
  "UNDEFINED_RISK_HELD",
  "WORKING_ORDER_RISK_UNKNOWN",
  "POSITION_CAP",
  "NAME_CAP",
  "OPEN_RISK_CAP",
] as const;
export type SendCapRefusal = (typeof SEND_CAP_REFUSALS)[number];

export type SendCapCheck = Readonly<{
  heldByName: Readonly<Record<string, number>>;
  heldTotal: number;
  refusals: readonly SendCapRefusal[];
}>;

const cents = (dollars: number): number => Math.round(dollars * 100);
const MULTIPLIER = 100;

interface Cover {
  left: number;
  p: HeldPosition;
}

/**
 * The cents at risk of one short option covered by longs of its group (nearest strike first,
 * the narrowest width), consuming their contracts; a trailing null when part stays uncovered.
 */
const coverShort = (
  short: HeldPosition,
  longs: readonly Cover[]
): (number | null)[] => {
  const amounts: (number | null)[] = [];
  let open = -short.quantity;
  const covers = [...longs].sort(
    (a, b) =>
      Math.abs(a.p.strike - short.strike) - Math.abs(b.p.strike - short.strike)
  );
  for (const cover of covers) {
    const used = Math.min(open, cover.left);
    if (used <= 0) continue;
    cover.left -= used;
    open -= used;
    amounts.push(
      cents(Math.abs(cover.p.strike - short.strike) * MULTIPLIER * used)
    );
  }
  if (open > 0) amounts.push(null);
  return amounts;
};

/** Max loss at risk per symbol in cents, or null for a symbol with an uncovered short option. */
export const heldRiskCents = (
  positions: readonly HeldPosition[]
): Map<string, number | null> => {
  const bySymbol = new Map<string, number | null>();
  const add = (symbol: string, amount: number | null): void => {
    const now = bySymbol.has(symbol) ? (bySymbol.get(symbol) ?? null) : 0;
    bySymbol.set(symbol, now === null || amount === null ? null : now + amount);
  };
  const options = new Map<
    string,
    { positions: HeldPosition[]; symbol: string }
  >();
  for (const position of positions) {
    if (position.quantity === 0) continue;
    if (position.secType !== "OPT") {
      add(position.symbol, cents(Math.abs(position.premium)));
      continue;
    }
    const key = JSON.stringify([
      position.symbol,
      position.expiry,
      position.right,
    ]);
    const group = options.get(key) ?? {
      positions: [],
      symbol: position.symbol,
    };
    group.positions.push(position);
    options.set(key, group);
  }
  for (const { positions: group, symbol } of options.values()) {
    const longs: Cover[] = group
      .filter((p) => p.quantity > 0)
      .map((p) => ({ left: p.quantity, p }));
    // Shorts first: a paired contract counts its width only (a vertical never loses more);
    // what is left of each long then counts its share of the premium paid.
    for (const short of group.filter((p) => p.quantity < 0))
      for (const amount of coverShort(short, longs)) add(symbol, amount);
    for (const long of longs)
      add(
        symbol,
        cents((Math.abs(long.p.premium) * long.left) / long.p.quantity)
      );
  }
  return bySymbol;
};

/**
 * The named refusals of sending one order that adds orderMaxLoss on symbol, against the account
 * as it is now. An empty list means the caps allow the send.
 */
export const checkSendCaps = (
  input: Readonly<{
    limits: SendCapLimits;
    nlv: number | null;
    orderMaxLoss: number;
    positions: readonly HeldPosition[];
    symbol: string;
    working: readonly WorkingOrderRisk[];
  }>
): SendCapCheck => {
  const refusals: SendCapRefusal[] = [];
  const held = heldRiskCents(input.positions);
  for (const order of input.working) {
    if (order.maxLoss === null) {
      refusals.push("WORKING_ORDER_RISK_UNKNOWN");
      continue;
    }
    // A name with undefined risk stays undefined (null), whatever works on it.
    const now = held.get(order.symbol);
    if (now !== null) held.set(order.symbol, (now ?? 0) + cents(order.maxLoss));
  }
  const heldByName: Record<string, number> = {};
  let total = 0;
  for (const [symbol, amount] of held) {
    if (amount === null) {
      refusals.push("UNDEFINED_RISK_HELD");
      continue;
    }
    heldByName[symbol] = amount / 100;
    total += amount;
  }
  const nlvCents =
    input.nlv === null || !(input.nlv > 0) ? null : cents(input.nlv);
  if (nlvCents === null) refusals.push("NLV_UNAVAILABLE");
  else {
    const order = cents(input.orderMaxLoss);
    const share = (pct: number): number => Math.floor((nlvCents * pct) / 100);
    if (order > share(input.limits.positionRiskPct))
      refusals.push("POSITION_CAP");
    if (
      (held.get(input.symbol) ?? 0) + order >
      share(input.limits.nameRiskCapPct)
    )
      refusals.push("NAME_CAP");
    if (total + order > share(input.limits.openRiskCapPct))
      refusals.push("OPEN_RISK_CAP");
  }
  return {
    heldByName,
    heldTotal: total / 100,
    refusals: [...new Set(refusals)],
  };
};
