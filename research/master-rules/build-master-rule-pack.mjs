#!/usr/bin/env node
// Builds research/master-rules/{classification,rule-pack}.json from the master trading rule set.
// Input: ~/Github/knowledge-bases/trading/_master-rules (clusters.json, conflicts.json, debates/*.json).
// The classification is a deterministic keyword/scope heuristic. It is research input only and never authorizes orders.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src =
  process.env.MASTER_RULES_DIR ??
  resolve(homedir(), "Github/knowledge-bases/trading/_master-rules");
const outDir = resolve(root, "research/master-rules");

// Where a rule applies in Vertex, by rule kind.
export const TARGETS = {
  entry: "committee-checklist",
  wisdom: "committee-checklist",
  time_filter: "committee-event-check",
  options_structure: "options-analysis-scoring",
  risk: "risk-allocator",
  sizing: "position-sizing",
  exit: "alert-stop-rules",
  regime: "research-report-regime",
  indicator: "research-report-technicals",
};

const NEGATED = /^(never|do not|don't|avoid|no |not |stop |skip |refuse)/i;
// Style conflicts with our book: options only (except Crown copy), no 0DTE/intraday scalping, no physical desk.
const STYLE = [
  [
    /\b0\s?dte\b|same-day (option|expir)|same-day [a-z -]{0,20}options?\b/i,
    "0DTE / same-day options are outside our style (short-dated premium is capped at 2% NLV and we do not trade same-day).",
  ],
  [
    /scalp|prop[- ]firm|funded account|evaluation account/i,
    "Intraday scalping / prop-firm rules do not fit a swing and LEAPS options book.",
  ],
  [/\b(forex|fx pair|currency pair)s?\b/i, "We do not trade spot FX."],
  [
    /short (the )?(stock|shares|equity)|short[- ]sell/i,
    "Opening share shorts is forbidden by the options-only rule (Crown copy book excepted).",
  ],
  [
    /\bbuy (the )?shares\b|accumulate shares|share (buy|purchase)/i,
    "Opening share positions is forbidden by the options-only rule (Crown copy book excepted).",
  ],
  [
    /short strangle|naked (call|put)|sell(ing)? naked|undefined[- ]risk short/i,
    "Undefined-risk short premium does not fit our defined-risk options style.",
  ],
  [
    /\bmargin\b|leverage[d]? (long|equity)/i,
    "Margin-financed equity positions do not fit the options-only book.",
  ],
  [
    /funding rate|on-chain|altcoin|bitcoin|\bbtc\b|crypto/i,
    "We do not trade crypto.",
  ],
  [
    /cargo|refiner|barge|physical (desk|trader|delivery)|tanker|regulators?/i,
    "Physical-commodity desk practice; we trade listed options only.",
  ],
];
// Rules that need data or features Vertex does not have yet: [pattern, feature, effort].
const NEEDS = [
  [
    /order[- ]?flow|footprint|\bdelta\b.*(candle|bar|volume)|cumulative delta|\btape\b|depth of market|\bdom\b|absorption|iceberg/i,
    "Order-flow / footprint feed",
    "L",
  ],
  [
    /volume profile|market profile|value area|\bpoc\b|point of control|\bvwap\b|tpo/i,
    "Volume / market profile engine",
    "M",
  ],
  [/\bcot\b|commitments of traders/i, "CFTC COT positioning feed", "S"],
  [
    /season|cycle|presidential|month of the year/i,
    "Seasonality / cycle module",
    "M",
  ],
  [
    /breadth|advance[- ]decline|above (their |the )?(50|200)|new highs|mcclellan/i,
    "Breadth series (partial in market-health)",
    "M",
  ],
  [/insider|13f|form 4/i, "Insider / 13F filings feed", "M"],
  [
    /put[- ]call ratio|aaii|fear (and|&) greed|sentiment survey|\bvix\b term/i,
    "Sentiment series (put/call, AAII, VIX term)",
    "S",
  ],
  [
    /backtest|walk[- ]forward|monte carlo|out[- ]of[- ]sample|sample size|confidence interval|expectancy/i,
    "Logged trade journal + backtest harness",
    "L",
  ],
  [
    /skew|term structure|iv rank|iv percentile|vol(atility)? surface/i,
    "IV term-structure / skew surface and IV-rank history",
    "M",
  ],
  [
    /futures curve|contango|backwardation|(?<!cost )basis\b/i,
    "Futures curve data",
    "M",
  ],
];

const intradayOnly = (c) =>
  c.timeframes.length > 0 && c.timeframes.every((t) => t === "intraday");
const onlyMethods = (c, set) =>
  c.methodologies.length > 0 && c.methodologies.every((m) => set.includes(m));

// Hand review of the A list (2026-10-23): rows the heuristic placed wrongly.
const OVERRIDES = {
  C004: {
    cls: "C",
    reason: "Needs: Volume / market profile engine (VAL/VAH).",
    feature: "Volume / market profile engine",
    effort: "M",
  },
  C044: {
    cls: "C",
    reason: "Needs: Volume / market profile engine (balance/imbalance).",
    feature: "Volume / market profile engine",
    effort: "M",
  },
  C014: {
    cls: "D",
    reason:
      "Daily session loss cap is an intraday-trading rule; our book is swing/LEAPS.",
  },
  C106: { cls: "D", reason: "Prop-account daily drawdown rule." },
  C090: {
    cls: "D",
    reason: "Scratch-on-hesitation is an intraday tape habit.",
  },
  C113: { cls: "D", reason: "Trading intraday stop runs; not our style." },
  C069: {
    cls: "D",
    reason:
      "Futures/commodity spread mean reversion; we trade listed equity options.",
  },
  // Hand review 2026-11-02 (In The Money Adam merge, knowledge-bases master rules).
  C168: {
    cls: "D",
    reason:
      "Flat-by-close is an intraday rule (now also day-trade options); our book does not day trade.",
  },
  C653: {
    cls: "B",
    reason:
      "Prefers LEAPS over futures for long-term leverage; contango is the reason given, no curve data needed.",
  },
  // Hand review 2026-11-03 (Junny Yang merge, knowledge-bases master rules).
  C677: {
    cls: "D",
    reason:
      "Trading an IPO-day pop needs shares; listed options do not exist at the IPO.",
  },
  C678: {
    cls: "C",
    reason: "Needs: IPO lockup-expiry calendar.",
    feature: "IPO lockup-expiry calendar",
    effort: "S",
  },
  C695: {
    cls: "B",
    reason:
      'Pipeline-growth judgment for pre-revenue names; "qualification cycle" is a sales cycle, not seasonality.',
  },
};

export function classifyCluster(c, debated = new Map()) {
  if (OVERRIDES[c.cluster_id])
    return { ...OVERRIDES[c.cluster_id], override: true };
  const debate = debated.get(c.cluster_id);
  const text = `${c.title}. ${c.canonical_rule}`;
  const negated = NEGATED.test(c.canonical_rule.trim());
  if (!negated)
    for (const [re, why] of STYLE)
      if (re.test(text)) return { cls: "D", reason: why };
  if (
    intradayOnly(c) &&
    onlyMethods(c, [
      "orderflow",
      "futures-intraday",
      "crypto",
      "discretionary-technical",
      "systematic-automation",
    ])
  )
    return {
      cls: "D",
      reason:
        "Intraday-only rule for futures/order-flow trading; our book holds options for days to years.",
    };
  if (onlyMethods(c, ["crypto"]))
    return { cls: "D", reason: "Crypto-only rule; we do not trade crypto." };
  if (onlyMethods(c, ["commodities-physical"]))
    return {
      cls: "D",
      reason:
        "Physical-commodity desk knowledge; reference only for an options book.",
    };
  for (const [re, feature, effort] of NEEDS)
    if (re.test(text))
      return { cls: "C", reason: `Needs: ${feature}.`, feature, effort };
  if (onlyMethods(c, ["orderflow"]))
    return {
      cls: "C",
      reason: "Needs: Order-flow / footprint feed.",
      feature: "Order-flow / footprint feed",
      effort: "L",
    };
  if (debate)
    return {
      cls: "D",
      reason: `Debated in ${debate}; the debate outcome rule ${debate} replaces both sides.`,
      supersededBy: debate,
    };
  if (c.consensus_count >= 3)
    return {
      cls: "A",
      reason: `High conviction: ${c.consensus_count} knowledge bases agree.`,
    };
  return {
    cls: "B",
    reason: `Fits our style and existing data; ${c.consensus_count} knowledge base${c.consensus_count === 1 ? "" : "s"}.`,
  };
}

// Debate outcomes, condensed from each debate's judge summary (kb-chat judge; JEV verdict unavailable).
export const DEBATE_RULES = [
  {
    id: "X01",
    kind: "sizing",
    cls: "A",
    candidateHardGate: true,
    rule: "Scale in only when total size, add levels and one never-lowered invalidation level are fixed before the first entry. Adding because the price is lower is averaging down.",
  },
  {
    id: "X02",
    kind: "risk",
    cls: "A",
    candidateHardGate: true,
    rule: "Every position has a stop at its invalidation level from entry, and size is set from that distance. For long options the premium is the maximum loss, so size the premium as if the stop will gap.",
  },
  {
    id: "X03",
    kind: "options_structure",
    cls: "A",
    candidateHardGate: true,
    rule: "Default to defined-risk structures (debit spreads, credit spreads, long options, cash-secured puts). No undefined-risk short premium.",
  },
  {
    id: "X04",
    kind: "sizing",
    cls: "D",
    rule: "No risk-per-trade percentage came out of the debate. Our owner caps (LEAPS 6% / short-dated 2% premium per name; Crown book 10% per name, 50% total) stay the sizing rule.",
    reason: "No rule produced; existing owner caps already cover this.",
  },
  {
    id: "X05",
    kind: "sizing",
    cls: "A",
    rule: "A stop is not a maximum-loss limit; position size is the real control. Keep per-name concentration inside the owner caps.",
  },
  {
    id: "X06",
    kind: "time_filter",
    cls: "A",
    candidateHardGate: true,
    rule: "Do not pre-position for a post-event move (FOMC, CPI, earnings). Going flat is not the default either: size every open position so an event gap through the stop is affordable.",
  },
  {
    id: "X07",
    kind: "risk",
    cls: "A",
    rule: "Do not use margin to buy dips. Options premium is paid in cash and capped per name.",
  },
  {
    id: "X08",
    kind: "options_structure",
    cls: "D",
    rule: "0DTE SPX condors: no settled edge for retail; the debate ended at a conditional wait.",
    reason: "0DTE is outside our style.",
  },
  {
    id: "X09",
    kind: "options_structure",
    cls: "A",
    candidateHardGate: true,
    rule: "Require at least 2:1 reward to risk by default. Lower it for a setup only when the lower confidence bound of its logged hit rate supports the lower ratio.",
  },
  {
    id: "X10",
    kind: "entry",
    cls: "A",
    candidateHardGate: true,
    rule: "Do not commit full size at an apparent bottom. Stage entries and wait for confirmation before the full position.",
  },
  {
    id: "X11",
    kind: "entry",
    cls: "A",
    rule: "An extended or parabolic move alone is not a trigger to fade it. Wait for a confirmed reversal.",
  },
  {
    id: "X12",
    kind: "exit",
    cls: "A",
    rule: "Neither blind mechanical trailing nor a never-touch rule: trail only to plan levels (structure, not ticks or ATR alone) and record each change.",
  },
];

function build() {
  const clusters = JSON.parse(
    readFileSync(resolve(src, "clusters.json"), "utf8")
  );
  const conflicts = JSON.parse(
    readFileSync(resolve(src, "conflicts.json"), "utf8")
  );
  const debatedIds = new Set(
    existsSync(resolve(src, "debates"))
      ? readdirSync(resolve(src, "debates")).map((f) => f.replace(".json", ""))
      : []
  );
  const debated = new Map();
  for (const x of conflicts)
    if (debatedIds.has(x.conflict_id))
      for (const id of [...(x.clusters?.a ?? []), ...(x.clusters?.b ?? [])])
        debated.set(id, x.conflict_id);
  const rows = clusters.map((c) => {
    const k = classifyCluster(c, debated);
    return {
      id: c.cluster_id,
      title: c.title,
      rule: c.canonical_rule,
      kind: c.kind,
      consensus: c.consensus_count,
      kbs: c.kbs,
      methodologies: c.methodologies,
      timeframes: c.timeframes,
      debate: debated.get(c.cluster_id) ?? null,
      ...k,
      target:
        k.cls === "A" || k.cls === "B"
          ? (TARGETS[c.kind] ?? "committee-checklist")
          : null,
    };
  });
  for (const d of DEBATE_RULES)
    rows.push({
      id: d.id,
      title: `Debate outcome ${d.id}`,
      rule: d.rule,
      kind: d.kind,
      consensus: null,
      kbs: [],
      methodologies: [],
      timeframes: [],
      debate: d.id,
      cls: d.cls,
      reason:
        d.reason ??
        "Debate outcome (kb-chat judge agreement; no independent JEV verdict) that fits our style.",
      target: d.cls === "A" ? TARGETS[d.kind] : null,
      candidateHardGate: !!d.candidateHardGate,
    });
  const counts = {};
  for (const r of rows) {
    counts[r.cls] = (counts[r.cls] ?? 0) + 1;
  }
  const meta = {
    generatedFrom:
      "knowledge-bases/trading/_master-rules (clusters.json, conflicts.json, debates/)",
    clusters: clusters.length,
    debates: DEBATE_RULES.length,
    counts,
    method:
      "A = 3+ knowledge bases or a won debate, and fits our style. B = fits and needs no missing data. C = needs a missing feature or data feed. D = style conflict. Keyword and scope heuristics; research input only.",
  };
  const pack = {
    ...meta,
    mode: "advisory",
    note: "Advisory only. Nothing here changes live order engines. Hard gates need an owner pick.",
    rules: rows
      .filter((r) => r.cls === "A" || r.cls === "B")
      .map(
        ({
          id,
          cls,
          title,
          rule,
          kind,
          consensus,
          target,
          debate,
          candidateHardGate,
        }) => ({
          id,
          cls,
          title,
          rule,
          kind,
          consensus,
          target,
          debate,
          candidateHardGate: !!candidateHardGate,
          mode: "advisory",
        })
      ),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, "classification.json"),
    `${JSON.stringify({ ...meta, rows }, null, 1)}\n`
  );
  writeFileSync(
    resolve(outDir, "rule-pack.json"),
    `${JSON.stringify(pack, null, 1)}\n`
  );
  return meta;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(build()));
