import type {
  OwnerRiskCaps,
  RiskAllocatorCandidate,
  RiskAllocatorLimit,
  RiskAllocatorParsedInput,
  RiskAllocatorRow,
  RiskAllocatorSuggestion,
  RiskRuleSet,
} from "./contracts/risk-allocator.ts";

// The one Vertex source for the owner's caps; every Vertex consumer reads this object.
// Snapshot of the owner's caps. Source of truth: market-watch-bot
// market_watch/premium_caps.py and market_watch/copyrot/copybook.py (CopyCaps), plus the
// OPTIONS_ONLY flag in market_watch/reentry/runner.py. `bun run vertex:owner-caps:check` compares
// this snapshot with a local market-watch-bot checkout. Vertex displays these values; it does not
// enforce or change them.
export const OWNER_RISK_CAPS: OwnerRiskCaps = Object.freeze({
  copyBookNamePct: 10,
  copyBookTotalPct: 50,
  leapsMinDte: 365,
  // market-watch-bot b218d58 raises LEAPS to 6% NLV, but it is not deployed yet: the live
  // gateway still accepts 2%. Never promise more than the live gateway accepts.
  leapsPremiumPct: 2,
  leapsPremiumPending: {
    commit: "b218d58",
    pct: 6,
    tracking: "Card mwb-push-redeploy: market-watch-bot redeploy",
  },
  optionsOnly: true,
  optionsOnlyScope:
    "No new share positions, long or short, outside the Crown copy book.",
  shortPremiumPct: 2,
  source: {
    decided: [
      { date: "2026-10-16", rule: "Options only; premium per name <= 2% NLV" },
      {
        date: "2026-10-21",
        rule: "Crown copy book: 10% NLV per name, 50% total",
      },
      {
        date: "2026-10-22",
        rule: "LEAPS (>= 365 DTE) premium per name <= 6% NLV",
      },
    ],
    files: [
      "market_watch/premium_caps.py",
      "market_watch/copyrot/copybook.py",
      "market_watch/reentry/runner.py",
    ],
    repository: "market-watch-bot",
  },
});

const DAY_MS = 86_400_000;

/** Calendar days from asOf to expiry (both ISO dates); null when either is missing. */
export const daysToExpiry = (
  expiry: string | null,
  asOf: string
): number | null => {
  if (expiry === null) return null;
  const end = Date.parse(`${expiry}T00:00:00Z`);
  const start = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(end) || Number.isNaN(start)) return null;
  return Math.round((end - start) / DAY_MS);
};

const cents = (value: number): number => Math.round(value * 100) / 100;

const limit = (
  id: RiskAllocatorLimit["id"],
  label: string,
  capPct: number,
  nlv: number,
  usedUsd: number
): RiskAllocatorLimit => {
  const capUsd = (capPct / 100) * nlv;
  return {
    capPct,
    capUsd: cents(capUsd),
    id,
    label,
    roomUsd: cents(Math.max(0, capUsd - usedUsd)),
    usedUsd: cents(usedUsd),
  };
};

/** Advisory size for one candidate row. Pure: reads only its input and the caps snapshot. */
const allocateCandidate = (
  candidate: RiskAllocatorCandidate,
  input: RiskAllocatorParsedInput,
  caps: OwnerRiskCaps = OWNER_RISK_CAPS
): RiskAllocatorRow => {
  const { nlv, positions } = input;
  const ruleSet: RiskRuleSet = candidate.crownCopy
    ? "crown-copy"
    : "options-only";
  const sameName = positions.filter((p) => p.symbol === candidate.symbol);
  const candidateDte =
    candidate.kind === "option"
      ? daysToExpiry(candidate.expiry, input.asOf)
      : null;
  const isLeaps = candidateDte !== null && candidateDte >= caps.leapsMinDte;
  const limits: RiskAllocatorLimit[] = [];
  const blockedReasons: string[] = [];
  let blocked = false;

  if (candidate.kind === "option") {
    const openPremium = sameName
      .filter((p) => p.kind === "option")
      .reduce((sum, p) => sum + p.value, 0);
    limits.push(
      limit(
        "option-premium",
        `Option premium per name (${isLeaps ? "LEAPS" : `< ${caps.leapsMinDte} DTE`})`,
        isLeaps ? caps.leapsPremiumPct : caps.shortPremiumPct,
        nlv,
        openPremium
      )
    );
    if (candidateDte === null)
      blockedReasons.push(
        "Expiry missing: the shorter-dated premium cap applies."
      );
    else if (candidateDte < 0) {
      blockedReasons.push("The option has expired.");
      blocked = true;
    }
  } else if (ruleSet === "options-only") {
    blockedReasons.push(`Options only: ${caps.optionsOnlyScope}`);
    blocked = true;
  }

  if (ruleSet === "crown-copy") {
    const copyLegs = positions.filter((p) => p.crownCopy);
    limits.push(
      limit(
        "copy-name",
        "Copy book per name",
        caps.copyBookNamePct,
        nlv,
        copyLegs
          .filter((p) => p.symbol === candidate.symbol)
          .reduce((sum, p) => sum + p.value, 0)
      ),
      limit(
        "copy-total",
        "Copy book total",
        caps.copyBookTotalPct,
        nlv,
        copyLegs.reduce((sum, p) => sum + p.value, 0)
      )
    );
  }

  // A row that is not blocked always has at least the premium or copy-book limits.
  const binding = blocked
    ? null
    : limits.reduce((lowest, item) =>
        item.roomUsd < lowest.roomUsd ? item : lowest
      );
  const maxUnits =
    binding === null ? 0 : Math.floor(binding.roomUsd / candidate.unitCost);
  return {
    bindingLimit: binding?.id ?? null,
    blockedReasons,
    candidateDte,
    isLeaps,
    kind: candidate.kind,
    limits,
    maxUnits,
    maxUsd: cents(maxUnits * candidate.unitCost),
    ruleSet,
    symbol: candidate.symbol,
  };
};

/** Advisory sizes for every candidate. No order is created or sent. */
export const suggestAllocation = (
  input: RiskAllocatorParsedInput,
  caps: OwnerRiskCaps = OWNER_RISK_CAPS
): RiskAllocatorSuggestion => ({
  advisoryOnly: true,
  rows: input.candidates.map((c) => allocateCandidate(c, input, caps)),
});
