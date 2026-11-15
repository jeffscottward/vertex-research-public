#!/usr/bin/env node
// Builds research/master-rules/{classification,rule-pack}.json from the master trading rule set, and the
// search index that the master_rules_search tool bundles (packages/api/src/server/master-rules-index.generated.ts).
// Input: ~/Github/knowledge-bases/trading/_master-rules (clusters.json, conflicts.json, debates/*.json,
// rules.jsonl for the cited source statements, inventory.json for each KB's source_tier). Set MASTER_RULES_DIR
// to read another checkout. Source URLs come from the `url:` front matter of each record's KB file (two levels
// above MASTER_RULES_DIR) or from the file name; only public Instagram, YouTube, TikTok and X post URLs are kept.
// The classification is a deterministic keyword/scope heuristic. It is research input only and never authorizes orders.
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src =
  process.env.MASTER_RULES_DIR ??
  resolve(homedir(), "Github/knowledge-bases/trading/_master-rules");
const outDir = resolve(root, "research/master-rules");
const serverDir = resolve(root, "packages/api/src/server");
const indexModule = resolve(serverDir, "master-rules-index.generated.ts");
const sourcesModule = resolve(serverDir, "master-rules-sources.generated.ts");

// Cited sources per rule: at most this many member records, one KB at a time.
export const MAX_SOURCES = 8;
const STATEMENT_MAX = 300;
const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 };
const TIER_ORDER = { top: 0 };
const SHORTCODE = "[A-Za-z0-9_-]{5,40}";
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

const youtubeIdOf = (url, host) => {
  if (host === "youtu.be") return url.pathname.slice(1);
  if (url.pathname === "/watch") return url.searchParams.get("v") ?? "";
  return url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)\/?$/)?.[1] ?? "";
};

// Canonical public post URL per host (www. and m. removed), from the parsed URL; null when it is no post.
const POST_URLS = {
  "instagram.com": (url) => {
    const post = url.pathname.match(
      new RegExp(`^/(?:[A-Za-z0-9_.]+/)?(?:p|reel|reels|tv)/(${SHORTCODE})/?$`)
    );
    return post ? `https://www.instagram.com/p/${post[1]}/` : null;
  },
  "youtube.com": (url) => {
    const id = youtubeIdOf(url, "youtube.com");
    return YOUTUBE_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  },
  "youtu.be": (url) => {
    const id = youtubeIdOf(url, "youtu.be");
    return YOUTUBE_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  },
  "tiktok.com": (url) => {
    const video = url.pathname.match(
      /^\/@([A-Za-z0-9_.]{1,40})\/video\/(\d{5,25})\/?$/
    );
    return video
      ? `https://www.tiktok.com/@${video[1]}/video/${video[2]}`
      : null;
  },
  "x.com": (url) => {
    const status = url.pathname.match(
      /^\/([A-Za-z0-9_]{1,30})\/status\/(\d{5,25})\/?$/
    );
    return status ? `https://x.com/${status[1]}/status/${status[2]}` : null;
  },
};
POST_URLS["twitter.com"] = POST_URLS["x.com"];

/**
 * A public post URL in one canonical form, or null. Only Instagram, YouTube, TikTok and X posts qualify;
 * query strings are dropped.
 */
export function canonicalPostUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^(?:www|m)\./, "");
  return Object.hasOwn(POST_URLS, host) ? POST_URLS[host](url) : null;
}

/**
 * The post URL a KB file name names: posts/<shortcode>.md, ig-<shortcode>.md and a shortcode file of an
 * "-instagram" KB (Instagram), youtube_<id> (YouTube).
 */
export function urlFromSourceFile(sourceFile) {
  if (typeof sourceFile !== "string") return null;
  const instagramPost = sourceFile.match(
    new RegExp(`^trading/[a-z0-9-]+/posts/(${SHORTCODE})\\.md$`)
  );
  if (instagramPost) return `https://www.instagram.com/p/${instagramPost[1]}/`;
  const instagramKbPost = sourceFile.match(
    /^trading\/[a-z0-9-]+-instagram\/(?:transcripts|sources|raw)\/([A-Za-z0-9_-]{11})\.md$/
  );
  if (instagramKbPost)
    return `https://www.instagram.com/p/${instagramKbPost[1]}/`;
  const name = sourceFile.split("/").pop() ?? "";
  const reel = name.match(new RegExp(`^ig-(${SHORTCODE})\\.md$`));
  if (reel) return `https://www.instagram.com/p/${reel[1]}/`;
  const video = name.match(
    /(?:^|[^A-Za-z0-9])youtube_([A-Za-z0-9_-]{11})\.(?:md|json)$/
  );
  return video ? `https://www.youtube.com/watch?v=${video[1]}` : null;
}

/**
 * Candidate URLs in the front matter of a KB file under kbRoot: `url:`, then an http(s) `source:`, then a
 * YouTube `source_id` ("<kb>-youtube-<id>"). Empty for a missing file, no front matter or a path outside kbRoot.
 */
export function frontMatterUrls(kbRoot, sourceFile) {
  if (
    typeof sourceFile !== "string" ||
    !sourceFile.endsWith(".md") ||
    sourceFile.startsWith("/") ||
    sourceFile.split("/").includes("..")
  )
    return [];
  const file = resolve(kbRoot, sourceFile);
  if (!(file.startsWith(`${kbRoot}${sep}`) && existsSync(file))) return [];
  const text = readFileSync(file, "utf8");
  if (!text.startsWith("---")) return [];
  const end = text.indexOf("\n---", 3);
  const header = end === -1 ? "" : text.slice(3, end);
  const field = (key) =>
    header.match(
      new RegExp(`^${key}:\\s*["']?([^"'\\s]+)["']?\\s*$`, "m")
    )?.[1];
  const youtubeId = field("source_id")?.match(
    /-youtube-([A-Za-z0-9_-]{11})$/
  )?.[1];
  return [
    field("url"),
    field("source"),
    youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : undefined,
  ].filter((value) => typeof value === "string");
}

/** The public URL of one rules.jsonl record: front matter first, then the file name; null when none is known. */
function sourceUrl(record, kbRoot) {
  for (const candidate of [
    ...frontMatterUrls(kbRoot, record.source_file),
    urlFromSourceFile(record.source_file),
  ]) {
    const url = canonicalPostUrl(candidate);
    if (url !== null) return url;
  }
  return null;
}

const statementText = (statement) => {
  const text = String(statement ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > STATEMENT_MAX
    ? `${text.slice(0, STATEMENT_MAX - 1)}…`
    : text;
};

/**
 * Up to MAX_SOURCES cited member records of one cluster: top-tier KBs first, then higher confidence, then
 * member order, taking one record per KB in turn so that many KBs are cited. Only the paraphrased
 * statement, the KB, the record id and a public URL leave the build: never quotes or file paths.
 */
// Paid or subscriber-only sources (review 2026-11-11): a record from these KBs keeps its statement and URL
// only when it comes from a public social post (Instagram, YouTube, TikTok, X). Otherwise only the KB and
// record id are cited; the paraphrased statement stays out of this public repository.
export const PAID_SOURCE_KBS = new Set([
  "argus-media",
  "kobeissi-letter",
  "nicholas-crown",
  "sp-global-platts",
]);
export const PAID_STATEMENT = "Paid source: statement withheld.";

export function pickSources(memberIds, records, kbTiers, urlOf) {
  const ranked = (memberIds ?? [])
    .map((id, order) => ({ order, record: records.get(id) }))
    .filter((entry) => entry.record !== undefined)
    .sort(
      (a, b) =>
        (TIER_ORDER[kbTiers[a.record.kb]] ?? 1) -
          (TIER_ORDER[kbTiers[b.record.kb]] ?? 1) ||
        (CONFIDENCE_ORDER[a.record.confidence] ?? 3) -
          (CONFIDENCE_ORDER[b.record.confidence] ?? 3) ||
        a.order - b.order
    );
  const byKb = new Map();
  for (const { record } of ranked) {
    const list = byKb.get(record.kb) ?? [];
    list.push(record);
    byKb.set(record.kb, list);
  }
  const picked = [];
  for (let round = 0; picked.length < MAX_SOURCES; round += 1) {
    const next = [...byKb.values()]
      .map((list) => list[round])
      .filter((record) => record !== undefined);
    if (next.length === 0) break;
    picked.push(...next.slice(0, MAX_SOURCES - picked.length));
  }
  return picked.map((record) => {
    const url = urlOf(record);
    return PAID_SOURCE_KBS.has(record.kb) && url === null
      ? { kb: record.kb, recordId: record.id, statement: PAID_STATEMENT, url }
      : {
          kb: record.kb,
          recordId: record.id,
          statement: statementText(record.statement),
          url,
        };
  });
}

/** Each KB's source_tier from inventory.json ("top" or null), sorted by KB id. */
export function kbTiersOf(inventory) {
  return Object.fromEntries(
    inventory
      .filter((entry) => typeof entry.kb === "string")
      .map((entry) => [entry.kb, entry.source_tier ?? null])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
}

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
  // Hand review 2026-11-08 (QuantFinanceToGo merge, knowledge-bases master rules 91644e65).
  C229: {
    cls: "B",
    reason:
      'Portfolio stress test beyond VaR (liquidity, correlation breaks); "basis blowouts" is one example, not a futures-curve feed requirement.',
  },
  // Hand review 2026-11-09 (not a lil fish merge, knowledge-bases master rules 8bbcd66a).
  // Prop-firm account mechanics; we trade our own options book and hold no evaluation or funded accounts.
  C082: { cls: "D", reason: "Prop-firm evaluation pass-probability rule." },
  C745: { cls: "D", reason: "Prop-firm challenge rule." },
  C747: { cls: "D", reason: "Prop-account copy-trading rule." },
  C749: { cls: "D", reason: "Prop-firm account-type choice." },
  C751: { cls: "D", reason: "Prop-account payout buffer rule." },
  C758: { cls: "D", reason: "Prop-account stacking rule." },
  C759: { cls: "D", reason: "Prop-firm evaluation budget rule." },
  // Hand review 2026-11-11 (Jay Medrow merge, knowledge-bases master rules; owner ranks the source top tier with Crown).
  // Holding physical metal is outside the options-only book.
  C811: { cls: "D", reason: "Physical-metal holding; options-only book." },
  // Underlying choice: options on bullion-backed ETFs (GLD/SLV), not miners. GLD and SLV are in the OpenBB symbol set.
  C857: {
    cls: "B",
    reason: "Underlying selection: bullion-backed ETF options, not miners.",
  },
  C829: {
    cls: "C",
    reason:
      "Needs: BLS employment-situation series (payrolls, diffusion, hours, revisions, AHE).",
    feature: "BLS jobs-report series via FRED",
    effort: "S",
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

// What the master_rules_search tool searches: every classified cluster and debate outcome (index) and
// the cited sources of each, by rule id (sources). Written as two TypeScript modules so the web build
// bundles them (no file read at run time) and each stays under Biome's 1 MiB file limit.
export function searchModulesOf(meta, rows) {
  return {
    index: {
      clusters: meta.clusters,
      debates: meta.debates,
      kbTiers: meta.kbTiers,
      rows: rows.map(
        ({ id, title, rule, kind, cls, reason, consensus, kbs }) => ({
          id,
          title,
          rule,
          kind,
          cls,
          reason,
          consensus,
          kbs,
        })
      ),
    },
    sources: Object.fromEntries(
      rows
        .filter((row) => row.sources.length > 0)
        .map((row) => [row.id, row.sources])
    ),
  };
}

// Biome skips (and so never formats or lints) files above 1 MiB; every generated file must stay below.
export const GENERATED_FILE_MAX_BYTES = 1024 * 1024;

const readJsonLines = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

function build() {
  const clusters = JSON.parse(
    readFileSync(resolve(src, "clusters.json"), "utf8")
  );
  const conflicts = JSON.parse(
    readFileSync(resolve(src, "conflicts.json"), "utf8")
  );
  const records = new Map(
    readJsonLines(resolve(src, "rules.jsonl")).map((record) => [
      record.id,
      record,
    ])
  );
  const kbTiers = kbTiersOf(
    JSON.parse(readFileSync(resolve(src, "inventory.json"), "utf8"))
  );
  const kbRoot = resolve(src, "../..");
  const urlOf = (record) => sourceUrl(record, kbRoot);
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
      sources: pickSources(c.member_ids, records, kbTiers, urlOf),
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
      sources: [],
    });
  const counts = {};
  for (const r of rows) {
    counts[r.cls] = (counts[r.cls] ?? 0) + 1;
  }
  const meta = {
    generatedFrom:
      "knowledge-bases/trading/_master-rules (clusters.json, conflicts.json, debates/, rules.jsonl, inventory.json)",
    clusters: clusters.length,
    debates: DEBATE_RULES.length,
    counts,
    method:
      "A = 3+ knowledge bases or a won debate, and fits our style. B = fits and needs no missing data. C = needs a missing feature or data feed. D = style conflict. Keyword and scope heuristics; research input only.",
    kbTiers,
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
          sources,
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
          sources,
        })
      ),
  };
  mkdirSync(outDir, { recursive: true });
  // Cited sources stay out of the classification: with them it would pass Biome's 1 MiB limit. A and B
  // rules carry them in the rule pack; every row's sources are in the sources module.
  const classification = {
    ...meta,
    rows: rows.map(({ sources: _sources, ...row }) => row),
  };
  writeFileSync(
    resolve(outDir, "classification.json"),
    `${JSON.stringify(classification, null, 1)}\n`
  );
  writeFileSync(
    resolve(outDir, "rule-pack.json"),
    `${JSON.stringify(pack, null, 1)}\n`
  );
  const modules = searchModulesOf(meta, rows);
  const header = [
    "// Generated by research/master-rules/build-master-rule-pack.mjs. Do not edit by hand.",
    "// Advisory research input from trader knowledge bases; it never authorizes a trade.",
  ];
  writeFileSync(
    indexModule,
    [
      ...header,
      'import type { MasterRulesIndexBase } from "../contracts/master-rules.ts";',
      "",
      `export const MASTER_RULES_INDEX_BASE: MasterRulesIndexBase = ${JSON.stringify(modules.index, null, 2)};`,
      "",
    ].join("\n")
  );
  writeFileSync(
    sourcesModule,
    [
      ...header,
      "// Cited knowledge-base records per rule id: paraphrased statements and public post URLs only.",
      'import type { MasterRuleSourcesById } from "../contracts/master-rules.ts";',
      "",
      `export const MASTER_RULE_SOURCES: MasterRuleSourcesById = ${JSON.stringify(modules.sources, null, 2)};`,
      "",
    ].join("\n")
  );
  const written = [
    resolve(outDir, "classification.json"),
    resolve(outDir, "rule-pack.json"),
    indexModule,
    sourcesModule,
  ];
  // Biome owns the committed layout of every written file.
  const format = spawnSync(
    "bunx",
    ["--bun", "--no-install", "biome", "format", "--write", ...written],
    { cwd: root, stdio: "ignore" }
  );
  if (format.status !== 0)
    console.error("biome format failed: run bun run format before committing");
  for (const file of written)
    if (statSync(file).size >= GENERATED_FILE_MAX_BYTES)
      throw new Error(
        `${file} is ${statSync(file).size} bytes; Biome skips files of 1 MiB or more. Split it before committing.`
      );
  const { kbTiers: _tiers, ...summary } = meta;
  return {
    ...summary,
    sources: rows.reduce((total, row) => total + row.sources.length, 0),
    sourcesWithUrl: rows.reduce(
      (total, row) => total + row.sources.filter((s) => s.url).length,
      0
    ),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(build()));
