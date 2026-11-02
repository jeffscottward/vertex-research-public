import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyCluster,
  DEBATE_RULES,
  TARGETS,
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
