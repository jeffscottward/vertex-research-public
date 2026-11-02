// Advisory master-rule pack for the Vertex committee and options analysis.
// Advisory only: flags never block, size or place orders. Hard gates need an owner pick.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LEAPS_MIN_DTE = 365;
const LEAPS_PREMIUM_PCT = 6;
const SHORT_PREMIUM_PCT = 2;
const MIN_REWARD_RISK = 2;

let cached;
export function loadRulePack(
  path = resolve(root, "research/master-rules/rule-pack.json")
) {
  if (!cached || path !== cached.path)
    cached = { pack: JSON.parse(readFileSync(path, "utf8")), path };
  return cached.pack;
}

/** A rules first, then B by consensus. */
export function rulesFor(
  target,
  { pack = loadRulePack(), limit = Number.POSITIVE_INFINITY } = {}
) {
  return pack.rules
    .filter((r) => r.target === target)
    .sort((a, b) =>
      a.cls === b.cls
        ? (b.consensus ?? 99) - (a.consensus ?? 99)
        : a.cls < b.cls
          ? -1
          : 1
    )
    .slice(0, limit);
}

const finite = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * Deterministic advisory checks for one priced strategy.
 * Strategy fields: kind, legs, entryPrice, maxLoss, maxProfit.
 * nlv is optional; without it the premium-cap check reports "unknown".
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one flat list of independent advisory checks.
export function checkStrategy(
  strategy,
  { dte = null, nlv = null, openPremiumInName = 0 } = {}
) {
  const flags = [];
  const add = (rule, status, detail) =>
    flags.push({ detail, mode: "advisory", rule, status });
  if (strategy.kind === "stock") {
    add(
      "options-only",
      "conflict",
      "Opening a share position conflicts with the owner options-only rule (Crown copy book excepted)."
    );
    return flags;
  }
  const uncovered =
    (strategy.legs ?? []).filter((l) => l.side === "sell").length >
      (strategy.legs ?? []).filter((l) => l.side === "buy").length &&
    strategy.kind !== "cash-secured-put";
  add(
    "X03 defined risk",
    uncovered ? "conflict" : "pass",
    uncovered
      ? "Short leg without a covering long leg or cash reserve."
      : "Maximum loss is defined."
  );
  if (
    finite(strategy.maxProfit) &&
    finite(strategy.maxLoss) &&
    strategy.maxLoss > 0
  ) {
    const rr = strategy.maxProfit / strategy.maxLoss;
    add(
      "X09 reward:risk >= 2:1",
      rr >= MIN_REWARD_RISK ? "pass" : "warn",
      `Maximum gain / maximum loss = ${Math.round(rr * 100) / 100}.`
    );
  } else
    add(
      "X09 reward:risk >= 2:1",
      strategy.maxProfit === null || strategy.maxProfit === undefined
        ? "pass"
        : "unknown",
      strategy.maxProfit === null || strategy.maxProfit === undefined
        ? "Uncapped upside."
        : "Gain or loss unknown."
    );
  if (finite(dte)) {
    if (dte <= 1)
      add(
        "no 0DTE",
        "conflict",
        "Same-day or next-day expiry is outside our style."
      );
    else if (dte <= 10 && (strategy.legs ?? []).some((l) => l.side === "buy"))
      add(
        "C093 exit long premium before expiry",
        "warn",
        `${dte} DTE: plan the exit 10+ sessions before expiry.`
      );
  }
  const capPct =
    finite(dte) && dte >= LEAPS_MIN_DTE ? LEAPS_PREMIUM_PCT : SHORT_PREMIUM_PCT;
  const premium = strategy.entryPrice > 0 ? strategy.maxLoss : null;
  if (premium !== null) {
    if (!finite(nlv) || nlv <= 0)
      add(`premium cap ${capPct}% NLV`, "unknown", "NLV not supplied.");
    else {
      const pct = ((premium + openPremiumInName) / nlv) * 100;
      add(
        `premium cap ${capPct}% NLV`,
        pct <= capPct ? "pass" : "conflict",
        `Premium in name ${Math.round(pct * 100) / 100}% of NLV (cap ${capPct}%; ${capPct === LEAPS_PREMIUM_PCT ? "LEAPS" : "shorter-dated"}).`
      );
    }
  }
  return flags;
}

/** Report section for the committee / options note. */
export function masterRulesSection({
  pack = loadRulePack(),
  perTarget = 3,
} = {}) {
  const targets = [
    "committee-checklist",
    "committee-event-check",
    "options-analysis-scoring",
    "risk-allocator",
    "position-sizing",
    "alert-stop-rules",
  ];
  return {
    body: targets.flatMap((t) =>
      rulesFor(t, { limit: perTarget, pack }).map(
        (r) => `[${r.cls} ${r.id} · ${t}] ${r.rule}`
      )
    ),
    id: "master-rules",
    mode: "advisory",
    sourceIds: ["master-rules"],
    title: "Master trading rules check (advisory)",
  };
}
