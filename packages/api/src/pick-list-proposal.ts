import { blackScholes, CONTRACT_MULTIPLIER } from "@darkfactory/academy";

import type {
  PickListProposalOutput,
  PickListProposalRowOutput,
  PickListProposalStructureOutput,
  PickListProposalTier,
  PickListScreenMemberOutput,
} from "./contracts/pick-lists.ts";
import type { SectorRotationQuadrant } from "./contracts/sector-rotation.ts";
import { normalQuantile } from "./quant-distributions.ts";
import { OWNER_RISK_CAPS } from "./risk-allocator.ts";
import { MAX_LOSS_PCT } from "./server/vertex-orders-rules.ts";

// Buy-proposal math for bucketed pick lists (pure; no network, no orders). For each screened
// member it proposes one defined-risk structure and a size as % of NLV max loss:
//
//   tier    full  all 3 screen gates pass and the sector ETF quadrant (or, without a sector
//                 ETF, the member's own quadrant) is leading or improving   -> 0.50% NLV
//           half  all 3 gates pass, rotation not leading or improving       -> 0.25% NLV
//           none  a gate fails or data is missing                           -> watch only
//   size    min(tier %, owner max-loss gate 2% NLV, premium cap per name for < 365 DTE)
//   struct  call debit spread on the first monthly expiry (third Friday) at least 120 DTE
//           (inside the 90-180 DTE window): long the ~0.60 delta call, short the ~0.30 delta
//           call. Strikes solve the Black-Scholes delta, N(d1) = delta, so
//           K = S × exp(-d1 × σ√T + (r + σ²/2) × T), rounded to a listed-strike increment.
//   price   Black-Scholes, no dividends, r = 4%, σ = annualized realized volatility of up to 252
//           daily log returns (sample standard deviation × √252; needs 60 returns).
//
// Max loss of a debit spread is the debit paid, so every proposed structure has a defined max
// loss. Estimates only: live quotes, skew and dividends differ, and strikes and expiry are picked
// from the live chain at entry. A proposal never authorizes a trade.

const PROPOSAL_FULL_MAX_LOSS_PCT = 0.5;
const PROPOSAL_HALF_MAX_LOSS_PCT = 0.25;
/** Owner hard gate (2026-11-02), shared with the order rules: max loss of a new position <= 2% NLV. */
const PROPOSAL_MAX_LOSS_GATE_PCT = MAX_LOSS_PCT;
const PROPOSAL_DTE_MIN = 90;
const PROPOSAL_DTE_MAX = 180;
const PROPOSAL_TARGET_DTE = 120;
const PROPOSAL_LONG_DELTA = 0.6;
const PROPOSAL_SHORT_DELTA = 0.3;
const PROPOSAL_RISK_FREE_RATE = 0.04;
const TRADING_DAYS = 252;
const MIN_RETURNS = 60;
/** Below this annualized volatility the series is treated as flat (no estimate). */
const MIN_VOLATILITY = 0.0001;
const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365;
const GATE_NAMES = {
  emaTrend: "EMA trend",
  aboveVwap20: "above VWAP20",
  notOverextended: "not overextended",
} as const;

export const PROPOSAL_RULES: PickListProposalOutput["rules"] = Object.freeze({
  fullMaxLossPct: PROPOSAL_FULL_MAX_LOSS_PCT,
  halfMaxLossPct: PROPOSAL_HALF_MAX_LOSS_PCT,
  maxLossGatePct: PROPOSAL_MAX_LOSS_GATE_PCT,
  namePremiumCapPct: OWNER_RISK_CAPS.shortPremiumPct,
  dteMin: PROPOSAL_DTE_MIN,
  dteMax: PROPOSAL_DTE_MAX,
  targetDte: PROPOSAL_TARGET_DTE,
  longDelta: PROPOSAL_LONG_DELTA,
  shortDelta: PROPOSAL_SHORT_DELTA,
  riskFreeRate: PROPOSAL_RISK_FREE_RATE,
});

const round = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/** Third Friday of a UTC month, as epoch milliseconds. */
const thirdFriday = (year: number, month: number): number => {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return Date.UTC(year, month, 1 + ((5 - first + 7) % 7) + 14);
};

/** First monthly expiry (third Friday) at least `minDte` calendar days after `asOf` (YYYY-MM-DD). */
export const monthlyExpiryAtLeast = (
  asOf: string,
  minDte: number
): Readonly<{ expiry: string; dte: number }> => {
  const start = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start))
    throw new RangeError(`Not a calendar date: ${asOf}`);
  const date = new Date(start);
  for (let offset = 0; ; offset += 1) {
    const ms = thirdFriday(date.getUTCFullYear(), date.getUTCMonth() + offset);
    const dte = Math.round((ms - start) / DAY_MS);
    if (dte >= minDte)
      return { expiry: new Date(ms).toISOString().slice(0, 10), dte };
  }
};

/** Annualized realized volatility of up to 252 daily log returns; null below 60 returns. */
export const realizedVolatility = (
  closes: readonly number[]
): number | null => {
  const recent = closes.slice(-(TRADING_DAYS + 1));
  const returns: number[] = [];
  for (let index = 1; index < recent.length; index += 1) {
    const previous = recent[index - 1] as number;
    const current = recent[index] as number;
    if (previous > 0 && current > 0) returns.push(Math.log(current / previous));
  }
  if (returns.length < MIN_RETURNS) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (returns.length - 1);
  const annualized = Math.sqrt(variance * TRADING_DAYS);
  return annualized >= MIN_VOLATILITY ? annualized : null;
};

/** Typical listed-strike spacing for a price level. */
export const strikeIncrement = (spot: number): number => {
  if (spot < 25) return 0.5;
  if (spot < 100) return 1;
  if (spot < 250) return 2.5;
  return 5;
};

const roundStrike = (value: number, increment: number): number =>
  round(Math.max(increment, Math.round(value / increment) * increment), 2);

/** Strike whose Black-Scholes call delta is `delta`. */
export const strikeForDelta = (
  spot: number,
  vol: number,
  years: number,
  delta: number,
  rate = PROPOSAL_RISK_FREE_RATE
): number => {
  const d1 = normalQuantile(delta);
  const sqrtT = Math.sqrt(years);
  return spot * Math.exp(-d1 * vol * sqrtT + (rate + 0.5 * vol * vol) * years);
};

/** The call debit spread estimate for one member. */
export const callDebitSpread = (
  spot: number,
  vol: number,
  asOf: string
): PickListProposalStructureOutput => {
  const { expiry, dte } = monthlyExpiryAtLeast(asOf, PROPOSAL_TARGET_DTE);
  const years = dte / DAYS_PER_YEAR;
  const increment = strikeIncrement(spot);
  const longStrike = roundStrike(
    strikeForDelta(spot, vol, years, PROPOSAL_LONG_DELTA),
    increment
  );
  const shortTarget = roundStrike(
    strikeForDelta(spot, vol, years, PROPOSAL_SHORT_DELTA),
    increment
  );
  const shortStrike =
    shortTarget > longStrike ? shortTarget : round(longStrike + increment, 2);
  const price = (strike: number) =>
    blackScholes({
      kind: "call",
      spot,
      strike,
      years,
      vol,
      rate: PROPOSAL_RISK_FREE_RATE,
    });
  const long = price(longStrike);
  const short = price(shortStrike);
  const estDebit = round(Math.max(0, long.price - short.price), 2);
  const maxLossPerSpread = round(estDebit * CONTRACT_MULTIPLIER, 2);
  return {
    kind: "call-debit-spread",
    expiry,
    dte,
    longStrike,
    shortStrike,
    longDelta: round(long.delta, 2),
    shortDelta: round(short.delta, 2),
    estDebit,
    maxLossPerSpread,
    maxProfitPerSpread: round(
      (shortStrike - longStrike) * CONTRACT_MULTIPLIER - maxLossPerSpread,
      2
    ),
  };
};

const quadrantText = (quadrant: SectorRotationQuadrant | null): string =>
  quadrant ?? "unknown";

const tierFor = (
  member: PickListScreenMemberOutput
): Readonly<{ tier: PickListProposalTier; why: string }> => {
  if (member.status === "unknown")
    return {
      tier: "none",
      why: `No entry: data missing (${member.reason ?? "a gate has too little history"}).`,
    };
  if (member.status === "fail") {
    const failed = (
      Object.keys(GATE_NAMES) as (keyof typeof GATE_NAMES)[]
    ).filter((gate) => member.gates[gate].ok === false);
    return {
      tier: "none",
      why: `No entry: gate failed (${failed.map((gate) => GATE_NAMES[gate]).join(", ")}). Watch only.`,
    };
  }
  const rotation =
    member.sectorEtf === null
      ? `no sector ETF; own RRG ${quadrantText(member.quadrant)}`
      : `sector ${member.sectorEtf} ${quadrantText(member.sectorQuadrant)}; own RRG ${quadrantText(member.quadrant)}`;
  const deciding =
    member.sectorEtf === null ? member.quadrant : member.sectorQuadrant;
  const leading = deciding === "leading" || deciding === "improving";
  return leading
    ? { tier: "full", why: `All 3 gates pass; ${rotation}.` }
    : {
        tier: "half",
        why: `All 3 gates pass; ${rotation} (half size: rotation not leading or improving).`,
      };
};

const TIER_PCT: Readonly<Record<PickListProposalTier, number>> = {
  full: PROPOSAL_FULL_MAX_LOSS_PCT,
  half: PROPOSAL_HALF_MAX_LOSS_PCT,
  none: 0,
};

export type ProposalMemberInput = Readonly<{
  screened: PickListScreenMemberOutput;
  /** Daily closes, oldest first; null when the bars could not be loaded. */
  closes: readonly number[] | null;
  buckets: readonly string[];
  /** Calendar date the DTE counts from (YYYY-MM-DD). */
  asOf: string;
}>;

/** One proposal row: tier, size and structure for a screened member. */
export const proposeMember = ({
  screened,
  closes,
  buckets,
  asOf,
}: ProposalMemberInput): PickListProposalRowOutput => {
  const volatility = closes === null ? null : realizedVolatility(closes);
  const { tier: screenTier, why } = tierFor(screened);
  const base = {
    symbol: screened.symbol,
    buckets: [...buckets],
    status: screened.status,
    last: screened.last,
    lastDate: screened.lastDate,
    sectorEtf: screened.sectorEtf,
    quadrant: screened.quadrant,
    sectorQuadrant: screened.sectorQuadrant,
    volatility: volatility === null ? null : round(volatility, 4),
  };
  if (screenTier === "none" || screened.last === null)
    return {
      ...base,
      tier: "none",
      maxLossPctNlv: 0,
      structure: null,
      notes: why,
    };
  if (volatility === null)
    return {
      ...base,
      tier: "none",
      maxLossPctNlv: 0,
      structure: null,
      notes: `No entry: fewer than ${MIN_RETURNS} daily returns for a volatility estimate.`,
    };
  const maxLossPctNlv = Math.min(
    TIER_PCT[screenTier],
    PROPOSAL_MAX_LOSS_GATE_PCT,
    OWNER_RISK_CAPS.shortPremiumPct
  );
  return {
    ...base,
    tier: screenTier,
    maxLossPctNlv,
    structure: callDebitSpread(screened.last, volatility, asOf),
    notes: `${why} Enter in 3 tranches (40/30/30).`,
  };
};

export type ProposalCandidate = Readonly<{
  symbol: string;
  sector: string | null;
  buckets: readonly string[];
}>;

export type ProposalBucketList = Readonly<{
  bucketSymbol: string;
  listId: string;
  listName: string;
  /** The bucket's members in bucket order (rank order, first 50). */
  members: readonly Readonly<{ symbol: string; sector: string | null }>[];
}>;

/** Unique members across buckets in bucket order; a member keeps every bucket that holds it. */
export const proposalCandidates = (
  lists: readonly ProposalBucketList[]
): ProposalCandidate[] => {
  const bySymbol = new Map<
    string,
    { symbol: string; sector: string | null; buckets: string[] }
  >();
  for (const list of lists)
    for (const member of list.members) {
      const found = bySymbol.get(member.symbol);
      if (found === undefined)
        bySymbol.set(member.symbol, {
          symbol: member.symbol,
          sector: member.sector,
          buckets: [list.bucketSymbol],
        });
      else {
        if (!found.buckets.includes(list.bucketSymbol))
          found.buckets.push(list.bucketSymbol);
        found.sector ??= member.sector;
      }
    }
  return [...bySymbol.values()];
};

/** Proposed rows first (full, then half), then no-entry rows; bucket order inside a tier. */
export const orderProposalRows = (
  rows: readonly PickListProposalRowOutput[]
): PickListProposalRowOutput[] => {
  const rank: Readonly<Record<PickListProposalTier, number>> = {
    full: 0,
    half: 1,
    none: 2,
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank[a.row.tier] - rank[b.row.tier] || a.index - b.index)
    .map(({ row }) => row);
};

export const totalMaxLossPct = (
  rows: readonly PickListProposalRowOutput[]
): number =>
  round(
    rows.reduce((sum, row) => sum + row.maxLossPctNlv, 0),
    4
  );
