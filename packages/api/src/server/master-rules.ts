import { implement } from "@orpc/server";
import type { z } from "zod";

import { appContract } from "../contract.ts";
import {
  MASTER_RULE_CLASSES,
  MASTER_RULES_NOTE,
  type MasterRuleClass,
  type MasterRuleIndexRow,
  type MasterRuleMatch,
  type MasterRulesIndex,
  type MasterRulesSearchInputSchema,
  type MasterRulesSearchOutput,
  PAID_SOURCE_PLACEHOLDER,
} from "../contracts/master-rules.ts";
import type { ApiContext } from "./context.ts";
import { MASTER_RULES_INDEX_BASE } from "./master-rules-index.generated.ts";
import { MASTER_RULE_SOURCES } from "./master-rules-sources.generated.ts";
import { requireOperator } from "./operator-access.ts";

// master_rules_search: deterministic keyword search over the trader master rules that
// research/master-rules/build-master-rule-pack.mjs writes into master-rules-index.generated.ts and
// master-rules-sources.generated.ts. The web build bundles both modules: no model, no network and no
// file read at run time. Results are advisory research input only.

const api = implement(appContract).$context<ApiContext>();

/** The bundled index: every classified rule with its cited sources. */
export const MASTER_RULES_INDEX: MasterRulesIndex = {
  ...MASTER_RULES_INDEX_BASE,
  rows: MASTER_RULES_INDEX_BASE.rows.map((row) => ({
    ...row,
    sources: [...(MASTER_RULE_SOURCES[row.id] ?? [])],
  })),
};

export type MasterRulesSearchQuery = z.output<
  typeof MasterRulesSearchInputSchema
>;

// Field weights: a query word in the title counts most, then the KB names, the rule and the cited statements.
// Each word's field weights are multiplied by its rarity, ln(1 + rows / (1 + rows containing the word)),
// so that "2s10s" counts more than "yield".
const WEIGHTS = { kbs: 3, rule: 2, sources: 1, title: 4 } as const;
// Bonus when the whole multi-word query appears in the title, rule or a statement, and when every word matches.
const PHRASE_BONUS = 3;
const ALL_WORDS_BONUS = 2;
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "rule",
  "say",
  "the",
  "to",
  "what",
  "when",
  "which",
  "who",
  "with",
]);

const stem = (word: string): string =>
  /^[a-z]{4,}$/u.test(word) && word.endsWith("s") && !word.endsWith("ss")
    ? word.slice(0, -1)
    : word;

/** Lower-case words of a text, with a plain-plural "s" removed; "2s10s" and "10y" stay whole. */
export const searchWords = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "")
    .map(stem);

type IndexedRow = Readonly<{
  row: MasterRuleIndexRow;
  fields: Readonly<Record<keyof typeof WEIGHTS, ReadonlySet<string>>>;
  phrases: readonly string[];
}>;

type SearchIndex = Readonly<{
  rows: readonly IndexedRow[];
  // Number of rows that contain each word in any field.
  rowsWithWord: ReadonlyMap<string, number>;
}>;

const indexed = new WeakMap<MasterRulesIndex, SearchIndex>();

const searchIndexFor = (index: MasterRulesIndex): SearchIndex => {
  const cached = indexed.get(index);
  if (cached !== undefined) return cached;
  const rowsWithWord = new Map<string, number>();
  const rows = index.rows.map((row) => {
    // The withheld-statement placeholder of paid sources is not searchable text.
    const statements = row.sources
      .map((source) => source.statement)
      .filter((statement) => statement !== PAID_SOURCE_PLACEHOLDER);
    const fields = {
      kbs: new Set(row.kbs.flatMap(searchWords)),
      rule: new Set(searchWords(row.rule)),
      sources: new Set(statements.flatMap(searchWords)),
      title: new Set(searchWords(row.title)),
    };
    for (const word of new Set(
      Object.values(fields).flatMap((words) => [...words])
    ))
      rowsWithWord.set(word, (rowsWithWord.get(word) ?? 0) + 1);
    return {
      fields,
      phrases: [row.title, row.rule, ...statements].map((text) =>
        searchWords(text).join(" ")
      ),
      row,
    };
  });
  const built = { rows, rowsWithWord };
  indexed.set(index, built);
  return built;
};

/** Deterministic score of one row for the query words (0 = no match), rounded to 2 decimals. */
const scoreRow = (
  searchIndex: SearchIndex,
  entry: IndexedRow,
  words: readonly string[]
): number => {
  let score = 0;
  let matched = 0;
  for (const word of words) {
    let weight = 0;
    for (const field of Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[])
      if (entry.fields[field].has(word)) weight += WEIGHTS[field];
    if (weight === 0) continue;
    matched += 1;
    const rarity = Math.log(
      1 +
        searchIndex.rows.length /
          (1 + (searchIndex.rowsWithWord.get(word) ?? 0))
    );
    score += weight * rarity;
  }
  if (score === 0) return 0;
  if (words.length > 1) {
    const phrase = words.join(" ");
    if (entry.phrases.some((text) => ` ${text} `.includes(` ${phrase} `)))
      score += PHRASE_BONUS;
    if (matched === words.length) score += ALL_WORDS_BONUS;
  }
  return Math.round(score * 100) / 100;
};

const classRank = (cls: MasterRuleClass): number =>
  MASTER_RULE_CLASSES.indexOf(cls);

const compareMatches = (
  left: Readonly<{ row: MasterRuleIndexRow; score: number }>,
  right: Readonly<{ row: MasterRuleIndexRow; score: number }>
): number =>
  right.score - left.score ||
  classRank(left.row.cls) - classRank(right.row.cls) ||
  (right.row.consensus ?? -1) - (left.row.consensus ?? -1) ||
  (left.row.id < right.row.id ? -1 : left.row.id > right.row.id ? 1 : 0);

const toMatch = (
  index: MasterRulesIndex,
  row: MasterRuleIndexRow,
  score: number,
  kb: string | null
): MasterRuleMatch => ({
  cls: row.cls,
  consensus: row.consensus,
  id: row.id,
  kbTiers: Object.fromEntries(
    row.kbs.map((name) => [name, index.kbTiers[name] ?? null])
  ),
  kbs: row.kbs,
  kind: row.kind,
  reason: row.reason,
  rule: row.rule,
  score,
  // With a kb filter, that KB's sources come first so they are cited first.
  sources:
    kb === null
      ? row.sources
      : [
          ...row.sources.filter((source) => source.kb === kb),
          ...row.sources.filter((source) => source.kb !== kb),
        ],
  title: row.title,
});

/**
 * Searches the master rules. Words are matched in the title, rule, KB names and cited source
 * statements; rows are ranked by score, then class (A first), consensus and id. A query of only
 * stop words ("what", "rule", ...) lists the filtered rows in that same order.
 */
export const searchMasterRules = (
  index: MasterRulesIndex,
  input: MasterRulesSearchQuery
): MasterRulesSearchOutput => {
  const kb = input.kb ?? null;
  const classes = input.cls ?? null;
  const raw = searchWords(input.query);
  const words = [...new Set(raw.filter((word) => !STOPWORDS.has(word)))];
  const searchIndex = searchIndexFor(index);
  // A query with no searchable word at all (punctuation, symbols) matches nothing; a query of only
  // stop words still lists the filtered rows.
  const nothingToSearch = raw.length === 0;
  const ranked = searchIndex.rows
    .filter(
      (entry) =>
        !nothingToSearch &&
        (kb === null || entry.row.kbs.includes(kb)) &&
        (classes === null || classes.includes(entry.row.cls))
    )
    .map((entry) => ({
      row: entry.row,
      score: words.length === 0 ? 0 : scoreRow(searchIndex, entry, words),
    }))
    .filter((entry) => words.length === 0 || entry.score > 0)
    .sort(compareMatches);
  return {
    note: MASTER_RULES_NOTE,
    query: input.query,
    kb,
    kbKnown:
      kb === null
        ? null
        : Object.hasOwn(index.kbTiers, kb) ||
          index.rows.some((row) => row.kbs.includes(kb)),
    cls: classes,
    total: ranked.length,
    matches: ranked
      .slice(0, input.limit)
      .map((entry) => toMatch(index, entry.row, entry.score, kb)),
  };
};

const search = api.masterRules.search
  .use(requireOperator)
  .handler(({ input }) => searchMasterRules(MASTER_RULES_INDEX, input));

export const masterRulesRouter = { search };
