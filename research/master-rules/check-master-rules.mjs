import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalPostUrl,
  classifyCluster,
  DEBATE_RULES,
  frontMatterUrls,
  GENERATED_FILE_MAX_BYTES,
  kbTiersOf,
  MAX_SOURCES,
  PAID_SOURCE_KBS,
  PAID_STATEMENT,
  pickSources,
  searchModulesOf,
  TARGETS,
  urlFromSourceFile,
} from "./build-master-rule-pack.mjs";
import {
  checkStrategy,
  loadRulePack,
  masterRulesSection,
  rulesFor,
} from "./master-rules.mjs";

// Minimal debit pricer for the fixtures (the archived scripts/analyze-options.mjs is not on this line).
function priceStrategy(s) {
  if (s.kind === "stock") return { ...s, legs: [] };
  const debit = s.legs.reduce(
    (v, l) => v + (l.side === "buy" ? l.premium : -l.premium),
    0
  );
  const calls = s.legs.filter((l) => l.type === "call").map((l) => l.strike);
  const width =
    s.kind === "bull-call-spread"
      ? Math.max(...calls) - Math.min(...calls)
      : null;
  return {
    ...s,
    entryPrice: debit,
    maxLoss: debit * 100,
    maxProfit: width === null ? null : (width - debit) * 100,
  };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pack = loadRulePack();
const classification = JSON.parse(
  readFileSync(
    resolve(root, "research/master-rules/classification.json"),
    "utf8"
  )
);
const cluster = (over) => ({
  canonical_rule: "Cut losers early.",
  cluster_id: "T1",
  consensus_count: 1,
  kbs: [],
  kind: "risk",
  methodologies: ["macro"],
  timeframes: ["swing"],
  title: "t",
  ...over,
});

test("pack is advisory and holds only A and B rules with a known target", () => {
  assert.equal(pack.mode, "advisory");
  assert.ok(pack.rules.length > 50);
  const targets = new Set(Object.values(TARGETS));
  for (const r of pack.rules) {
    assert.ok(["A", "B"].includes(r.cls), r.id);
    assert.equal(r.mode, "advisory");
    assert.ok(targets.has(r.target), `${r.id} ${r.target}`);
  }
});

test("classification covers every cluster and debate once", () => {
  assert.equal(
    classification.rows.length,
    classification.clusters + classification.debates
  );
  assert.equal(
    new Set(classification.rows.map((r) => r.id)).size,
    classification.rows.length
  );
  for (const r of classification.rows.filter((row) => row.cls === "C"))
    assert.ok(r.feature && ["S", "M", "L"].includes(r.effort), r.id);
  for (const r of classification.rows.filter((row) => row.cls === "D"))
    assert.ok(r.reason, r.id);
});

test("classifier: style conflicts are D, negated style rules still fit, consensus makes A", () => {
  assert.equal(
    classifyCluster(
      cluster({ canonical_rule: "Sell 0DTE SPX condors every day." })
    ).cls,
    "D"
  );
  assert.equal(
    classifyCluster(
      cluster({ canonical_rule: "Never sell naked calls.", consensus_count: 4 })
    ).cls,
    "A"
  );
  assert.equal(
    classifyCluster(
      cluster({ methodologies: ["orderflow"], timeframes: ["intraday"] })
    ).cls,
    "D"
  );
  assert.equal(
    classifyCluster(
      cluster({ canonical_rule: "Trade from the volume profile value area." })
    ).cls,
    "C"
  );
  assert.equal(classifyCluster(cluster({ consensus_count: 3 })).cls, "A");
  assert.equal(classifyCluster(cluster()).cls, "B");
});

test("candidate hard gates come only from A debate rules", () => {
  const gates = DEBATE_RULES.filter((d) => d.candidateHardGate);
  assert.ok(gates.length >= 3);
  for (const g of gates) assert.equal(g.cls, "A");
});

test("rulesFor puts A rules first", () => {
  const rules = rulesFor("options-analysis-scoring");
  const firstB = rules.findIndex((r) => r.cls === "B");
  if (firstB >= 0) assert.ok(rules.slice(firstB).every((r) => r.cls === "B"));
  assert.ok(rules.some((r) => r.cls === "A"));
});

const leg = (side, type, strike, premium) => ({ premium, side, strike, type });

test("checkStrategy: share position conflicts with options-only", () => {
  const s = priceStrategy({ id: "s", kind: "stock", name: "s" });
  assert.equal(checkStrategy(s)[0].status, "conflict");
});

test("checkStrategy: reward:risk and premium caps (LEAPS 6%, shorter 2%)", () => {
  const spread = priceStrategy({
    id: "b",
    kind: "bull-call-spread",
    legs: [leg("buy", "call", 100, 5), leg("sell", "call", 110, 2)],
    name: "b",
  });
  // max loss 300, max gain 700 -> 2.33
  const short = checkStrategy(spread, { dte: 60, nlv: 10_000 });
  assert.equal(short.find((f) => f.rule.startsWith("X09")).status, "pass");
  assert.equal(
    short.find((f) => f.rule.startsWith("premium cap 2%")).status,
    "conflict"
  ); // 3% > 2%
  const leaps = checkStrategy(spread, { dte: 400, nlv: 10_000 });
  assert.equal(
    leaps.find((f) => f.rule.startsWith("premium cap 6%")).status,
    "pass"
  );
  const withOpen = checkStrategy(spread, {
    dte: 400,
    nlv: 10_000,
    openPremiumInName: 400,
  });
  assert.equal(
    withOpen.find((f) => f.rule.startsWith("premium cap 6%")).status,
    "conflict"
  ); // 7%
  const wide = priceStrategy({
    id: "w",
    kind: "bull-call-spread",
    legs: [leg("buy", "call", 100, 8), leg("sell", "call", 110, 2)],
    name: "w",
  });
  assert.equal(
    checkStrategy(wide).find((f) => f.rule.startsWith("X09")).status,
    "warn"
  );
  assert.equal(
    checkStrategy(wide).find((f) => f.rule.startsWith("premium cap")).status,
    "unknown"
  );
});

test("checkStrategy: 0DTE and late long premium", () => {
  const call = priceStrategy({
    id: "c",
    kind: "long-call",
    legs: [leg("buy", "call", 100, 2)],
    name: "c",
  });
  assert.ok(
    checkStrategy(call, { dte: 0 }).some(
      (f) => f.rule === "no 0DTE" && f.status === "conflict"
    )
  );
  assert.ok(
    checkStrategy(call, { dte: 7 }).some((f) => f.rule.startsWith("C093"))
  );
  assert.ok(checkStrategy(call).every((f) => f.mode === "advisory"));
});

test("report section lists advisory rules with ids and targets", () => {
  const s = masterRulesSection();
  assert.equal(s.mode, "advisory");
  assert.ok(s.body.length > 5);
  assert.ok(
    s.body.every((line) => /^\[[AB] (C\d{3}|X\d{2}) · [a-z-]+\] /.test(line))
  );
});

test("debated clusters leave the pack; the X rule replaces them", () => {
  for (const r of classification.rows.filter(
    (row) => row.id.startsWith("C") && row.debate
  ))
    assert.ok(!["A", "B"].includes(r.cls), r.id);
  for (const id of ["C015", "C028", "C527"])
    assert.ok(!pack.rules.some((r) => r.id === id), id);
});

test("hand-reviewed classes stay pinned", () => {
  const byId = new Map(classification.rows.map((r) => [r.id, r.cls]));
  for (const [id, cls] of Object.entries({
    C004: "C",
    C090: "D",
    C096: "D",
    X03: "A",
    X04: "D",
    X08: "D",
    X09: "A",
  }))
    assert.equal(byId.get(id), cls, id);
});

test("checkStrategy: a missing maxProfit counts as uncapped upside", () => {
  const flags = checkStrategy({
    entryPrice: 2,
    kind: "long-call",
    legs: [{ side: "buy" }],
    maxLoss: 200,
  });
  assert.equal(flags.find((f) => f.rule.startsWith("X09")).status, "pass");
});

test("source URLs: only public Instagram, YouTube, TikTok and X posts, in canonical form", () => {
  assert.equal(
    canonicalPostUrl("https://www.instagram.com/reel/DdUwh-KDMnS/?igsh=abc"),
    "https://www.instagram.com/p/DdUwh-KDMnS/"
  );
  assert.equal(
    canonicalPostUrl("https://youtu.be/AKMu5SjQ_YE"),
    "https://www.youtube.com/watch?v=AKMu5SjQ_YE"
  );
  assert.equal(
    canonicalPostUrl("https://www.youtube.com/watch?v=AKMu5SjQ_YE&t=30s"),
    "https://www.youtube.com/watch?v=AKMu5SjQ_YE"
  );
  assert.equal(
    canonicalPostUrl(
      "https://www.tiktok.com/@nicholas_crown/video/7640628216486497549"
    ),
    "https://www.tiktok.com/@nicholas_crown/video/7640628216486497549"
  );
  assert.equal(
    canonicalPostUrl(
      "https://twitter.com/KobeissiLetter/status/2102086193751925233"
    ),
    "https://x.com/KobeissiLetter/status/2102086193751925233"
  );
  for (const rejected of [
    "https://letter.nicholascrown.com/p/when-good-news-stops-working",
    "https://drive.google.com/file/d/abc/view",
    "file:///home/someone/trading/x.md",
    "https://www.youtube.com/watch?v=short",
    "https://www.instagram.com/someone/",
    "not a url",
    null,
  ])
    assert.equal(canonicalPostUrl(rejected), null, String(rejected));
});

test("source URLs from KB file names: Instagram posts and reels, YouTube ids, nothing else", () => {
  assert.equal(
    urlFromSourceFile("trading/jay-medrow/posts/CsrgRLONUIE.md"),
    "https://www.instagram.com/p/CsrgRLONUIE/"
  );
  assert.equal(
    urlFromSourceFile("trading/smbcapital/raw/ig-De1izeOGQwi.md"),
    "https://www.instagram.com/p/De1izeOGQwi/"
  );
  assert.equal(
    urlFromSourceFile(
      "trading/define-your-risk-instagram/transcripts/Da5k4GCupsY.md"
    ),
    "https://www.instagram.com/p/Da5k4GCupsY/"
  );
  assert.equal(
    urlFromSourceFile(
      "trading/jan-smolen/exhaustive/curated-markdown/transcripts/undated - Strategy - youtube_B3zGICjrfAY.md"
    ),
    "https://www.youtube.com/watch?v=B3zGICjrfAY"
  );
  assert.equal(urlFromSourceFile("trading/junnyyang/raw/2ovNaN3K-LI.md"), null);
  assert.equal(urlFromSourceFile("trading/x/concepts/stops.md"), null);
  assert.deepEqual(frontMatterUrls(root, "../outside.md"), []);
  assert.deepEqual(frontMatterUrls(root, "/etc/hosts.md"), []);
  assert.deepEqual(frontMatterUrls(root, "missing/file.md"), []);
});

test("cited sources: top-tier KBs first, one KB at a time, at most MAX_SOURCES, no quotes or paths", () => {
  const records = new Map(
    [
      ["a:risk:1", "a", "low"],
      ["a:risk:2", "a", "high"],
      ["b:risk:1", "b", "high"],
      ["top:risk:1", "top", "medium"],
      ...Array.from({ length: 10 }, (_, i) => [
        `k${i}:risk:1`,
        `k${i}`,
        "high",
      ]),
    ].map(([id, kb, confidence]) => [
      id,
      {
        confidence,
        id,
        kb,
        quote: "verbatim words",
        source_file: `trading/${kb}/posts/AbCdEfGhIjK.md`,
        statement: `  Rule   from ${id}. `,
      },
    ])
  );
  const tiers = kbTiersOf([
    { kb: "top", source_tier: "top" },
    { kb: "a" },
    { title: "no kb id" },
  ]);
  assert.deepEqual(tiers, { a: null, top: "top" });
  const two = pickSources(
    ["a:risk:1", "a:risk:2", "b:risk:1", "top:risk:1", "gone:risk:1"],
    records,
    tiers,
    (record) => `https://www.instagram.com/p/${record.kb}/`
  );
  assert.deepEqual(
    two.map((s) => s.recordId),
    ["top:risk:1", "a:risk:2", "b:risk:1", "a:risk:1"]
  );
  assert.deepEqual(two[0], {
    kb: "top",
    recordId: "top:risk:1",
    statement: "Rule from top:risk:1.",
    url: "https://www.instagram.com/p/top/",
  });
  const many = pickSources([...records.keys()], records, tiers, () => null);
  assert.equal(many.length, MAX_SOURCES);
  assert.equal(new Set(many.map((s) => s.kb)).size, MAX_SOURCES);
});

test("paid-source KBs keep a statement only for public social posts", () => {
  const records = new Map([
    [
      "nicholas-crown:risk:1",
      {
        id: "nicholas-crown:risk:1",
        kb: "nicholas-crown",
        statement: "Letter rule.",
        confidence: "high",
      },
    ],
    [
      "nicholas-crown:risk:2",
      {
        id: "nicholas-crown:risk:2",
        kb: "nicholas-crown",
        statement: "TikTok rule.",
        confidence: "high",
      },
    ],
  ]);
  const urls = {
    "nicholas-crown:risk:2":
      "https://www.tiktok.com/@nicholas_crown/video/7640628216486497549",
  };
  const picked = pickSources(
    [...records.keys()],
    records,
    {},
    (r) => urls[r.id] ?? null
  );
  const byId = Object.fromEntries(picked.map((s) => [s.recordId, s]));
  assert.deepEqual(byId["nicholas-crown:risk:1"], {
    kb: "nicholas-crown",
    recordId: "nicholas-crown:risk:1",
    statement: PAID_STATEMENT,
    url: null,
  });
  assert.equal(byId["nicholas-crown:risk:2"].statement, "TikTok rule.");
  for (const kb of [
    "argus-media",
    "kobeissi-letter",
    "nicholas-crown",
    "sp-global-platts",
  ])
    assert.ok(PAID_SOURCE_KBS.has(kb));
});

test("pack rules and the generated sources module carry cited sources; the classification carries KB tiers", async () => {
  const { MASTER_RULE_SOURCES } = await import(
    "../../packages/api/src/server/master-rules-sources.generated.ts"
  );
  const { MASTER_RULES_INDEX_BASE } = await import(
    "../../packages/api/src/server/master-rules-index.generated.ts"
  );
  assert.equal(pack.kbTiers["jay-medrow"], "top");
  assert.equal(pack.kbTiers["nicholas-crown"], "top");
  assert.deepEqual(classification.kbTiers, pack.kbTiers);
  assert.deepEqual(MASTER_RULES_INDEX_BASE.kbTiers, pack.kbTiers);
  // Sources would push the classification past Biome's 1 MiB limit; they live in the pack and the module.
  for (const r of classification.rows) assert.equal(r.sources, undefined, r.id);
  for (const r of pack.rules)
    assert.deepEqual(r.sources, MASTER_RULE_SOURCES[r.id] ?? [], r.id);
  const rows = new Map(classification.rows.map((r) => [r.id, r]));
  assert.deepEqual(
    MASTER_RULES_INDEX_BASE.rows.map((r) => r.id),
    classification.rows.map((r) => r.id)
  );
  let cited = 0;
  for (const [id, sources] of Object.entries(MASTER_RULE_SOURCES)) {
    const row = rows.get(id);
    assert.ok(row && !id.startsWith("X"), id);
    assert.ok(sources.length > 0 && sources.length <= MAX_SOURCES, id);
    for (const s of sources) {
      cited += 1;
      assert.deepEqual(Object.keys(s).sort(), [
        "kb",
        "recordId",
        "statement",
        "url",
      ]);
      assert.ok(row.kbs.includes(s.kb), `${id} ${s.kb}`);
      assert.ok(s.url === null || canonicalPostUrl(s.url) === s.url, s.url);
      assert.doesNotMatch(s.statement, /\/home\/|\/Users\/|\.md\b/);
    }
  }
  assert.ok(cited > 1000);
  const jay = classification.rows.find(
    (r) => r.kbs.includes("jay-medrow") && /2s10s/i.test(r.title)
  );
  assert.ok(jay, "a jay-medrow 2s10s rule");
  assert.match(
    MASTER_RULE_SOURCES[jay.id].find((s) => s.kb === "jay-medrow").url,
    /^https:\/\/www\.instagram\.com\/p\//
  );
});

test("search modules split rows from sources and every generated file stays under Biome's 1 MiB limit", () => {
  const meta = { clusters: 1, debates: 1, kbTiers: { a: "top" } };
  const rows = [
    {
      ...cluster({ kbs: ["a"] }),
      id: "C1",
      cls: "B",
      reason: "r",
      rule: "R",
      consensus: 1,
      sources: [{ kb: "a" }],
    },
    {
      ...cluster(),
      id: "X1",
      cls: "A",
      reason: "r",
      rule: "R",
      consensus: null,
      sources: [],
    },
  ];
  const modules = searchModulesOf(meta, rows);
  assert.deepEqual(Object.keys(modules.sources), ["C1"]);
  assert.deepEqual(Object.keys(modules.index.rows[0]).sort(), [
    "cls",
    "consensus",
    "id",
    "kbs",
    "kind",
    "reason",
    "rule",
    "title",
  ]);
  for (const file of [
    "research/master-rules/classification.json",
    "research/master-rules/rule-pack.json",
    "packages/api/src/server/master-rules-index.generated.ts",
    "packages/api/src/server/master-rules-sources.generated.ts",
  ])
    assert.ok(
      statSync(resolve(root, file)).size < GENERATED_FILE_MAX_BYTES,
      file
    );
});

test("committed sources never publish a paid-source statement without a public post URL", async () => {
  const { MASTER_RULE_SOURCES } = await import(
    "../../packages/api/src/server/master-rules-sources.generated.ts"
  );
  const { PAID_SOURCE_PLACEHOLDER } = await import(
    "../../packages/api/src/contracts/master-rules.ts"
  );
  assert.equal(PAID_STATEMENT, PAID_SOURCE_PLACEHOLDER);
  const all = Object.values(MASTER_RULE_SOURCES).flat();
  assert.ok(all.length > 0);
  for (const source of all) {
    assert.ok(source.statement.length <= 300, source.recordId);
    if (PAID_SOURCE_KBS.has(source.kb))
      assert.ok(
        source.url !== null || source.statement === PAID_STATEMENT,
        source.recordId
      );
  }
});
