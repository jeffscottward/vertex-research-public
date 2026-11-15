import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseSync } from "vite";
import { describe, expect, it } from "vitest";
import {
  STATUS_LANGUAGE_ALLOWLIST,
  type StatusLanguageEntry,
} from "./status-language-allowlist.ts";

// Status language guard (owner rule 2026-11-11, card vertex-no-unknown-status).
//
// Every status the app shows is a definite state with its reason, since when, and what happens
// next. A vague placeholder is not a status: "unknown", "N/A", "unavailable", "not available",
// "not known", "not set", "unspecified", a bare dash, "?" or "…".
//
// This test parses every source file in apps/web/src (tests, fixtures and lab pages excluded) and
// reads each JSX text, string literal and template literal from the syntax tree. So wrapped JSX
// text, text next to an {expression} and attribute strings all count. Positions that are never
// displayed as written do not: types, operands of a comparison, `case` labels, arguments of string
// methods, data-* attributes and module paths.
// A vague text must have an entry in status-language-allowlist.ts.
// - New text: do not add an entry by reflex. Name the state: the cause, since when, the last known
//   value, the next step ("Gateway disconnected since 01:13 ET · retrying"). Real uncertainty
//   stays visible, but it is named ("Order outcome not confirmed by IBKR since 14:02 · checking").
// - Entry with `open: true`: a known ambiguous text from the audit. It leaves the list when its
//   replacement merges; the test fails on a stale entry, and MAX_OPEN only goes down.
// - Entry without `open`: checked and kept; the reason says why (an explanation in prose, an error
//   text that names its cause, a mark between two real values).
// Limits: a text built by concatenation or split over several JSX children is read piece by piece.
//
// Regenerate after a deliberate change: run this file with UPDATE_STATUS_LANGUAGE=1, then
// `biome format --write` the list. Existing reasons are kept; a new text, or a higher count of a
// listed text, gets "REASON REQUIRED" and the test fails until the reason is written.

// Open (known ambiguous) entries on 2026-11-13. Lower it with each replacement; never raise it.
const MAX_OPEN = 209;

const ROOT = join(import.meta.dirname);
const LIST_FILE = "status-language-allowlist.ts";
const LIST_PATH = join(ROOT, LIST_FILE);
const SKIPPED_DIRECTORIES = [
  "node_modules",
  "dist",
  "fixtures",
  "generated",
  "lab",
  "test",
];
const SKIPPED_FILE = /\.(test|spec)\.|\.d\.ts$|fixture/;
const VAGUE_WORD =
  /\b(unknown|n\/a|unavailable|not available|not known|not set|unspecified|undetermined|tbd)\b/i;
const VAGUE_MARK = /^(—|–|-|\?|…|\.\.\.)$/;
const ENTITIES: Readonly<Record<string, string>> = {
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};
const MISSING_REASON = "REASON REQUIRED";
// An expression inside a template literal.
const HOLE = "${}";
const COMPARISONS = ["===", "!==", "==", "!="];
// String methods whose first literal argument is a separator or a pattern, not a text. A second
// argument (the replacement) and the arguments of join, padStart and padEnd can be displayed.
const PATTERN_METHODS = [
  "split",
  "replace",
  "replaceAll",
  "startsWith",
  "endsWith",
  "includes",
  "indexOf",
];

type SyntaxNode = Readonly<Record<string, unknown>> & { readonly type: string };

const isNode = (value: unknown): value is SyntaxNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

const nameOf = (value: unknown): string =>
  isNode(value) && typeof value["name"] === "string" ? value["name"] : "";

const collapse = (text: string): string =>
  text
    .replace(/&(mdash|ndash|hellip);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/&#x([0-9a-f]+);/gi, (_entity, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_entity, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/\s+/g, " ")
    .trim();

// The text of one node, or null when the node is not a text.
const nodeText = (node: SyntaxNode): string | null => {
  if (node.type === "JSXText") return collapse(String(node["value"]));
  if (node.type === "Literal" && typeof node["value"] === "string")
    return collapse(node["value"]);
  if (node.type === "TemplateLiteral") {
    // ESTree TemplateLiteral: the parser's node type is not exported, so the shape is stated here.
    const quasis = node["quasis"] as readonly {
      value: { cooked: string | null; raw: string };
    }[];
    return collapse(
      quasis.map((part) => part.value.cooked ?? part.value.raw).join(HOLE)
    );
  }
  return null;
};

// Children of a node that are never displayed as written.
const notDisplayed = (node: SyntaxNode): readonly unknown[] => {
  if (
    node.type === "BinaryExpression" &&
    COMPARISONS.includes(String(node["operator"]))
  )
    return [node["left"], node["right"]];
  if (node.type === "SwitchCase") return [node["test"]];
  // The literal value of a data-* attribute is for tests and styles, not for the reader.
  if (node.type === "JSXAttribute" && nameOf(node["name"]).startsWith("data-"))
    return [node["value"]];
  if (node.type === "CallExpression") {
    const callee = node["callee"];
    const [first] = Array.isArray(node["arguments"]) ? node["arguments"] : [];
    if (nameOf(callee) === "require") return [first];
    if (
      isNode(callee) &&
      callee.type === "MemberExpression" &&
      PATTERN_METHODS.includes(nameOf(callee["property"]))
    )
      return [first];
  }
  return [];
};

const collectTexts = (value: unknown, found: string[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectTexts(item, found);
    return;
  }
  if (!isNode(value)) return;
  // A type is not a text.
  if (value.type === "TSLiteralType") return;
  const text = nodeText(value);
  if (text !== null) found.push(text);
  const skipped = notDisplayed(value);
  const shown = (child: unknown): boolean =>
    !(skipped.includes(child) && isNode(child) && nodeText(child) !== null);
  for (const [name, child] of Object.entries(value)) {
    // `source` is a module path (import, export ... from, import()).
    if (name === "source") continue;
    if (Array.isArray(child)) collectTexts(child.filter(shown), found);
    else if (shown(child)) collectTexts(child, found);
  }
};

const vagueTexts = (source: string, file: string): string[] => {
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0)
    throw new Error(
      `${file}: ${parsed.errors.map((error) => error.message).join("; ")}`
    );
  const found: string[] = [];
  collectTexts(parsed.program, found);
  return found.filter((text) => VAGUE_MARK.test(text) || VAGUE_WORD.test(text));
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return SKIPPED_DIRECTORIES.includes(entry.name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) &&
      !SKIPPED_FILE.test(entry.name) &&
      entry.name !== LIST_FILE
      ? [path]
      : [];
  });

const key = (file: string, text: string): string => `${file}\u0000${text}`;

const scan = (): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const path of sourceFiles(ROOT)) {
    const file = relative(ROOT, path).replaceAll("\\", "/");
    for (const text of vagueTexts(readFileSync(path, "utf8"), file)) {
      const id = key(file, text);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
};

// The two ways the list and the source can disagree. Both must be empty.
const compare = (
  counts: ReadonlyMap<string, number>,
  entries: readonly StatusLanguageEntry[]
): { added: string[]; stale: string[] } => {
  const allowed = new Map(
    entries.map((entry) => [key(entry.file, entry.text), entry.count])
  );
  const describeKey = (id: string): string => {
    const [file, text] = id.split("\u0000");
    return `${file}: ${JSON.stringify(text)}`;
  };
  return {
    added: [...counts]
      .filter(([id, count]) => count > (allowed.get(id) ?? 0))
      .map(
        ([id, count]) =>
          `${describeKey(id)} (found ${count}, allowed ${allowed.get(id) ?? 0})`
      )
      .sort(),
    stale: [...allowed]
      .filter(([id, count]) => (counts.get(id) ?? 0) < count)
      .map(
        ([id, count]) =>
          `${describeKey(id)} (listed ${count}, found ${counts.get(id) ?? 0})`
      )
      .sort(),
  };
};

const regenerate = (counts: ReadonlyMap<string, number>): void => {
  const known = new Map(
    STATUS_LANGUAGE_ALLOWLIST.map(
      (entry) => [key(entry.file, entry.text), entry] as const
    )
  );
  const next = [...counts]
    .map(([id, count]) => {
      const [file = "", text = ""] = id.split("\u0000");
      const old = known.get(id);
      // A higher count is a new occurrence: its reason is not inherited.
      const inherited = old !== undefined && count <= old.count;
      return {
        file,
        text,
        count,
        reason: inherited ? old.reason : MISSING_REASON,
        ...(inherited && old.open === true ? { open: true } : {}),
      };
    })
    .sort(
      (a, b) => a.file.localeCompare(b.file) || a.text.localeCompare(b.text)
    );
  // Keep the header (comment and type) of the list file; replace the array.
  const marker = "readonly StatusLanguageEntry[] = ";
  const current = readFileSync(LIST_PATH, "utf8");
  const header = current.slice(0, current.indexOf(marker) + marker.length);
  writeFileSync(LIST_PATH, `${header}${JSON.stringify(next, null, 2)};\n`);
};

describe("status language guard", () => {
  const counts = scan();
  if (process.env["UPDATE_STATUS_LANGUAGE"] === "1") regenerate(counts);
  const { added, stale } = compare(counts, STATUS_LANGUAGE_ALLOWLIST);

  it("reads displayed texts: JSX text, attribute strings, string and template literals", () => {
    const source = [
      'const a = "Account mode unknown";',
      "const b = 'N/A';",
      "const c = `Feed unavailable (${a}) since ${`${b} — not set`}`;",
      'const escaped = "\\u2014";',
      'const fine = "Gateway disconnected since 01:13 ET · retrying";',
      "export const View = ({ reason }: { reason: string | null }) => (",
      '  <p title="Not available" aria-label={"Unspecified"}>',
      '    Positions unknown: {reason ?? "—"} for now',
      "    <span>",
      "      Status",
      "      unknown",
      "    </span>",
      "    <td>&mdash;</td>",
      "    <td>&#8212;</td>",
      '    <b data-tip={a ? "fine" : "Tip unavailable"}>{a.padEnd(8, "…")}</b>',
      "    {a === b ? <b>…</b> : <i>Live account · read-only</i>}",
      "  </p>",
      ");",
    ].join("\n");
    expect(vagueTexts(source, "view.tsx").sort()).toEqual(
      [
        "Account mode unknown",
        "N/A",
        "Feed unavailable (${}) since ${}",
        "${} — not set",
        "—",
        "Not available",
        "Unspecified",
        "Positions unknown:",
        "—",
        "Status unknown",
        "—",
        "—",
        "Tip unavailable",
        "…",
        "…",
      ].sort()
    );
  });

  it("does not read types, comparisons, case labels, string-method arguments, data attributes, module paths or comments", () => {
    const source = [
      'import type { A } from "./unknown-module.ts";',
      'export { b } from "./unavailable.ts";',
      'const lazy = () => import("./unknown-lazy.ts");',
      'type State = "unknown" | "live";',
      "const typed: unknown = 1 as unknown as Array<unknown>;",
      "// a comment with unknown is ignored",
      "const unknown_state = 1;",
      'const parts = "a-b".split("-");',
      "export const kind = (state: State): number => {",
      '  if (state === "unknown" || "n/a" !== state) return 0;',
      "  switch (state) {",
      '    case "unknown":',
      "      return 1;",
      "    default:",
      "      return 2;",
      "  }",
      "};",
    ].join("\n");
    expect(vagueTexts(source, "model.ts")).toEqual([]);
    expect(vagueTexts('<p data-state="unknown">Live</p>;', "view.tsx")).toEqual(
      []
    );
    // A displayed text next to a skipped position is still read: the result of a comparison, a
    // replacement, a join separator.
    expect(
      vagueTexts(
        [
          'export const label = (s: string) => (s === "unknown" ? "Unknown" : s);',
          'export const shown = (s: string) => (s.includes("unknown") ? "N/A" : s);',
          'export const filled = (s: string) => s.replace("null", "Not available");',
          'export const joined = (parts: string[]) => parts.join(" — ") + parts.join("—");',
        ].join("\n"),
        "label.ts"
      )
    ).toEqual(["Unknown", "N/A", "Not available", "—", "—"]);
  });

  it("names the file of a source that does not parse", () => {
    expect(() => vagueTexts("const = ;", "broken.ts")).toThrow(/^broken\.ts: /);
  });

  it("compares the source with the list: new text, raised count, stale entry", () => {
    const entry = (
      file: string,
      text: string,
      count: number
    ): StatusLanguageEntry => ({
      file,
      text,
      count,
      reason: "a reason for the test",
    });
    const found = new Map([
      [key("a.tsx", "Unknown"), 2],
      [key("a.tsx", "—"), 1],
      [key("b.tsx", "N/A"), 1],
    ]);
    expect(
      compare(found, [
        entry("a.tsx", "Unknown", 2),
        entry("a.tsx", "—", 1),
        entry("b.tsx", "N/A", 1),
      ])
    ).toEqual({ added: [], stale: [] });
    expect(
      compare(found, [
        entry("a.tsx", "Unknown", 1),
        entry("a.tsx", "—", 3),
        entry("c.tsx", "N/A", 1),
      ])
    ).toEqual({
      added: [
        'a.tsx: "Unknown" (found 2, allowed 1)',
        'b.tsx: "N/A" (found 1, allowed 0)',
      ],
      stale: [
        'a.tsx: "—" (listed 3, found 1)',
        'c.tsx: "N/A" (listed 1, found 0)',
      ],
    });
  });

  it("has a reason for every allowed text", () => {
    const withoutReason = STATUS_LANGUAGE_ALLOWLIST.filter(
      (entry) =>
        entry.reason.trim().length < 12 ||
        entry.reason === MISSING_REASON ||
        entry.count < 1
    ).map((entry) => `${entry.file}: ${JSON.stringify(entry.text)}`);
    expect(withoutReason).toEqual([]);
  });

  it("allows no new vague status text without an entry and a reason", () => {
    // A failure here means: name the state (cause, since when, next step) instead of the vague
    // word, or add an entry with its reason to status-language-allowlist.ts.
    expect(added).toEqual([]);
  });

  it("has no stale entry: a replaced text leaves the list", () => {
    expect(stale).toEqual([]);
  });

  it("lets the number of known ambiguous texts only go down", () => {
    const open = STATUS_LANGUAGE_ALLOWLIST.filter(
      (entry) => entry.open === true
    ).length;
    // Fewer open entries: lower MAX_OPEN to the new number in the same change.
    expect(open).toBe(MAX_OPEN);
  });
});
