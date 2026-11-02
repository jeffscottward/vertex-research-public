// What: Deploy gates for an Academy strategy. A typed port of the master-rule hard-gate candidates
// (research/master-rules: X01/X10 staged entry, X02 stop, X03 defined risk, X09 reward:risk, no 0DTE,
// C093) plus the owner caps (options only, premium per name as % of NLV) and a total-allocation cap.
// Pure: the server supplies the caps (OWNER_RISK_CAPS) and NLV, and enforces the result.
import { payoffSummary } from "./position.ts";
import type { StructureId } from "./schema.ts";
import { resolveRules, STRUCTURE_DEFS, structureLegs } from "./structures.ts";

export type GateCaps = Readonly<{
  optionsOnly: boolean;
  optionsOnlyScope: string;
  shortPremiumPct: number;
  leapsPremiumPct: number;
  leapsMinDte: number;
}>;

export type GateInput = Readonly<{
  structure: StructureId;
  rules: Readonly<Record<string, number>>;
  /** Share of NLV assigned to this strategy, percent. */
  allocationPct: number;
  /** Max loss per position as a percent of the allocation. */
  riskPerTradePct: number;
  nlv: number;
  /** Long option premium already open in the same underlying (from the portfolio feed), dollars. */
  openPremiumInNameUsd?: number;
  /** Allocations of other open Academy requests, percent of NLV. */
  otherAllocationsPct: number;
  /** Entry tranches; one tranche commits full size at once. */
  tranches: number;
  caps: GateCaps;
  /**
   * Max loss of one unit of the structure priced on the real ticker, dollars. Null when it could not be
   * priced (no stored bars); omitted when the caller does not size real units.
   */
  unitLossUsd?: number | null;
  /** Logged hit-rate evidence (for example the backtest) for the X09 exception. */
  evidence?: Readonly<{ trades: number; wins: number }>;
}>;

export type GateStatus = "pass" | "warn" | "conflict";
export type GateCheck = Readonly<{
  id: string;
  title: string;
  status: GateStatus;
  detail: string;
}>;

export type GateResult = Readonly<{
  verdict: "pass" | "blocked";
  checks: readonly GateCheck[];
  conflicts: readonly string[];
  premiumPerPositionUsd: number;
  premiumPerPositionPctNlv: number;
  rewardRisk: number | null;
  minDte: number;
}>;

export const GATE_TITLES = {
  "options-only": "Options only: no new share positions",
  X03: "X03 defined risk",
  X09: "X09 reward:risk at least 2:1",
  "no-0dte": "No 0DTE or next-day expiry",
  "premium-cap": "Premium (max loss) per position within the NLV cap",
  "allocation-total": "Total Academy allocation at most 100% of NLV",
  X02: "X02 stop at invalidation, sized as if the stop gaps",
  X10: "X01/X10 staged entries, never full size at once",
  "unit-fits-budget":
    "One unit's max loss within the per-position budget and the NLV cap",
  "nlv-known": "NLV known",
  X06: "X06 event gaps affordable",
  C093: "C093 exit long premium 10+ sessions before expiry",
} as const satisfies Readonly<Record<string, string>>;

const MIN_REWARD_RISK = 2;
const REFERENCE = { spot: 100, vol: 0.25, rate: 0.04 } as const;

/** Wilson score lower bound (95%) of a hit rate. */
export const wilsonLower = (wins: number, trades: number): number => {
  if (trades <= 0) return 0;
  const z = 1.96;
  const p = wins / trades;
  const denominator = 1 + (z * z) / trades;
  const centre = p + (z * z) / (2 * trades);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trades)) / trades);
  return (centre - margin) / denominator;
};

export const evaluateDeployGates = (input: GateInput): GateResult => {
  const definition = STRUCTURE_DEFS[input.structure];
  const rules = resolveRules(input.structure, input.rules);
  const legs = structureLegs(
    input.structure,
    rules,
    REFERENCE.spot,
    REFERENCE.vol,
    REFERENCE.rate
  );
  const summary = payoffSummary(legs, REFERENCE.spot, REFERENCE.rate);
  const options = legs.filter((leg) => leg.kind !== "stock");
  // Every structure has at least one option leg with a finite dte >= 1 (structureLegs floors it).
  const minDte = Math.min(...options.map((leg) => leg.dte));
  const maxDte = Math.max(...options.map((leg) => leg.dte));
  const rewardRisk =
    summary.maxProfit === null
      ? Number.POSITIVE_INFINITY
      : summary.maxLoss === null || summary.maxLoss >= 0
        ? null
        : summary.maxProfit / -summary.maxLoss;
  const premiumPerPositionUsd =
    (input.nlv * (input.allocationPct / 100) * input.riskPerTradePct) / 100;
  const openInName = Math.max(input.openPremiumInNameUsd ?? 0, 0);
  const premiumPerPositionPctNlv =
    input.nlv > 0
      ? (premiumPerPositionUsd / input.nlv) * 100
      : Number.POSITIVE_INFINITY;
  const namePctNlv =
    input.nlv > 0
      ? ((premiumPerPositionUsd + openInName) / input.nlv) * 100
      : Number.POSITIVE_INFINITY;
  const leaps = maxDte >= input.caps.leapsMinDte;
  const capPct = leaps
    ? input.caps.leapsPremiumPct
    : input.caps.shortPremiumPct;
  const checks: GateCheck[] = [];
  const add = (
    id: keyof typeof GATE_TITLES,
    status: GateStatus,
    detail: string
  ) => checks.push({ id, title: GATE_TITLES[id], status, detail });

  add(
    "nlv-known",
    input.nlv > 0 ? "pass" : "conflict",
    input.nlv > 0
      ? `NLV $${Math.round(input.nlv).toLocaleString("en-US")}.`
      : "NLV is unknown; caps cannot be checked."
  );
  add(
    "options-only",
    input.caps.optionsOnly && definition.usesShares ? "conflict" : "pass",
    definition.usesShares
      ? `${definition.label} opens or holds shares. ${input.caps.optionsOnlyScope}`
      : "Options legs only."
  );
  add(
    "X03",
    definition.undefinedRisk ? "conflict" : "pass",
    definition.undefinedRisk
      ? "Short option exposure without a covering long leg, shares or cash."
      : "Maximum loss is defined."
  );
  if (rewardRisk === null)
    add("X09", "conflict", "Reward or risk could not be computed.");
  else if (!Number.isFinite(rewardRisk)) add("X09", "pass", "Uncapped upside.");
  else if (rewardRisk >= MIN_REWARD_RISK)
    add(
      "X09",
      "pass",
      `Reward:risk ${rewardRisk.toFixed(2)}:1 at the reference strikes.`
    );
  else {
    const breakevenHitRate = 1 / (1 + rewardRisk);
    const lower =
      input.evidence === undefined
        ? null
        : wilsonLower(input.evidence.wins, input.evidence.trades);
    add(
      "X09",
      lower !== null && lower >= breakevenHitRate ? "pass" : "conflict",
      `Reward:risk ${rewardRisk.toFixed(2)}:1 needs a hit rate above ${(breakevenHitRate * 100).toFixed(1)}%.` +
        (lower === null
          ? " No logged hit-rate evidence."
          : ` Logged lower bound (95%) ${(lower * 100).toFixed(1)}%.`)
    );
  }
  add(
    "no-0dte",
    minDte <= 1 ? "conflict" : "pass",
    `Shortest leg ${Math.round(minDte)} DTE.`
  );
  add(
    "premium-cap",
    namePctNlv <= capPct + 1e-9 ? "pass" : "conflict",
    input.nlv > 0
      ? `Max loss per position $${Math.round(premiumPerPositionUsd).toLocaleString("en-US")} plus $${Math.round(openInName).toLocaleString("en-US")} premium already open in this name = ${namePctNlv.toFixed(2)}% of NLV; cap ${capPct}% (${leaps ? "LEAPS" : "shorter-dated"}).`
      : `NLV unknown: the ${capPct}% cap cannot be checked.`
  );
  if (input.unitLossUsd !== undefined) {
    const unitLoss = input.unitLossUsd;
    const capUsd = (capPct / 100) * Math.max(input.nlv, 0);
    const fits =
      unitLoss !== null &&
      unitLoss <= premiumPerPositionUsd + 1e-9 &&
      unitLoss + openInName <= capUsd + 1e-9;
    add(
      "unit-fits-budget",
      fits ? "pass" : "conflict",
      unitLoss === null
        ? "One unit could not be priced on this ticker (no stored daily bars)."
        : `One unit risks $${Math.round(unitLoss).toLocaleString("en-US")}; budget per position $${Math.round(premiumPerPositionUsd).toLocaleString("en-US")}, NLV cap $${Math.round(capUsd).toLocaleString("en-US")} less $${Math.round(openInName).toLocaleString("en-US")} already open.`
    );
  }
  const total = input.otherAllocationsPct + input.allocationPct;
  add(
    "allocation-total",
    total <= 100 + 1e-9 ? "pass" : "conflict",
    `Academy allocations would total ${total.toFixed(1)}% of NLV.`
  );
  const stopSet = rules.stopLossPct < 1000;
  add(
    "X02",
    stopSet || !definition.undefinedRisk ? "pass" : "conflict",
    stopSet
      ? `Stop at ${rules["stopLossPct"]}% of the entry premium.`
      : definition.undefinedRisk
        ? "No stop and undefined risk."
        : "Sized by max loss (the premium), as if the stop gaps."
  );
  add(
    "X10",
    input.tranches >= 2 ? "pass" : "conflict",
    `${input.tranches} entry tranche(s).`
  );
  add(
    "X06",
    "warn",
    "Do not pre-position for FOMC, CPI or earnings; the per-position cap must cover an event gap."
  );
  if (options.some((leg) => leg.side === "long") && rules.exitDte < 10)
    add(
      "C093",
      "warn",
      `Long premium exits at ${rules.exitDte} DTE; plan the exit 10+ sessions before expiry.`
    );

  const conflicts = checks
    .filter((check) => check.status === "conflict")
    .map((check) => check.id);
  return {
    verdict: conflicts.length === 0 ? "pass" : "blocked",
    checks,
    conflicts,
    premiumPerPositionUsd,
    premiumPerPositionPctNlv,
    rewardRisk:
      rewardRisk === null || !Number.isFinite(rewardRisk) ? null : rewardRisk,
    minDte,
  };
};

export const OVERRIDE_EXPLANATION_MIN = 40;

/** Validation errors for a rule override: every conflict acknowledged and named in the explanation. */
export const checkOverride = (
  conflicts: readonly string[],
  acknowledged: readonly string[],
  explanation: string
): string[] => {
  if (conflicts.length === 0) return ["There is no rule conflict to override"];
  const errors: string[] = [];
  for (const id of conflicts)
    if (!acknowledged.includes(id)) errors.push(`You must acknowledge ${id}`);
  const text = explanation.trim();
  if (text.length < OVERRIDE_EXPLANATION_MIN)
    errors.push(
      `The explanation must have at least ${OVERRIDE_EXPLANATION_MIN} characters`
    );
  else
    for (const id of conflicts)
      if (!text.toLowerCase().includes(id.toLowerCase()))
        errors.push(`The explanation must name rule ${id}`);
  return errors;
};
