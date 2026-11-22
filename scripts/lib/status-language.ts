// What: the scanner of the status language guard (owner rule 2026-11-11, card
// vertex-no-unknown-status). It reads every text a source folder can display and compares the
// vague ones with an allow list. The guards that use it: apps/web/src/status-language.test.ts
// (the app) and packages/api/src/status-language.test.ts (contract and server texts).
//
// A vague placeholder is not a status: "unknown", "N/A", "unavailable", "not available",
// "not known", "not set", "unspecified", a bare dash, "?" or "…". A wire value that holds such a
// word counts too: `unknown`, `source_unavailable`, `outcome-unknown`, `SERVICE_UNAVAILABLE`.
//
// The scanner parses each source file and reads each JSX text, string literal and template literal
// from the syntax tree. So wrapped JSX text, text next to an {expression}, attribute strings and
// the values of an enum all count. Positions that are never displayed as written do not: types,
// operands of a comparison, `case` labels, the first argument of the string methods in
// PATTERN_METHODS, data-* attributes and module paths.
// Not scanned: tests (`*.test.*`, `*.spec.*`, `test/`), test support (`*.test-support.ts`),
// `*.d.ts`, fixtures, generated and built code (`generated/`, `dist/`, `node_modules/`), lab pages.
// Limits: a text built by concatenation or split over several JSX children is read piece by piece.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseSync } from "vite";

export type StatusLanguageEntry = Readonly<{
  file: string;
  text: string;
  count: number;
  reason: string;
  open?: boolean;
}>;

// The reason a regenerated list gives a new text. The guard fails until a person replaces it.
export const MISSING_REASON = "REASON REQUIRED";

const SKIPPED_DIRECTORIES = [
  "node_modules",
  "dist",
  "fixtures",
  "generated",
  "lab",
  "test",
];
// Test support files (`*.test-support.ts`) hold test doubles; no reader sees their texts.
const SKIPPED_FILE = /\.(test|spec|test-support)\.|\.d\.ts$|fixture/;
// A vague word stands alone or is one part of a wire value: `source_unavailable`, `outcome-unknown`.
// So the boundary is "no letter or digit", not `\b` (which takes `_` as part of the word). A word
// inside a camelCase name (`unknownCount`) is not read.
const VAGUE_WORD =
  /(?<![a-z0-9])(unknown|n\/a|unavailable|not[ _-]available|not[ _-]known|not[ _-]set|unspecified|undetermined|tbd)(?![a-z0-9])/i;
const VAGUE_MARK = /^(—|–|-|\?|…|\.\.\.)$/;
const ENTITIES = [
  ["&hellip;", "…"],
  ["&mdash;", "—"],
  ["&ndash;", "–"],
] as const;
// An expression inside a template literal.
// biome-ignore lint/suspicious/noTemplateCurlyInString: the mark that stands for an expression.
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
  ENTITIES.reduce(
    (result, [entity, mark]) => result.replaceAll(entity, mark),
    text
  )
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
    // ESTree CallExpression: `arguments` is always an array.
    const [first] = node["arguments"] as readonly unknown[];
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

/** The vague texts of one source, in source order. `file` names the source in a parse error. */
export const vagueTexts = (source: string, file: string): string[] => {
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0)
    throw new Error(
      `${file}: ${parsed.errors.map((error) => error.message).join("; ")}`
    );
  const found: string[] = [];
  collectTexts(parsed.program, found);
  return found.filter((text) => VAGUE_MARK.test(text) || VAGUE_WORD.test(text));
};

const sourceFiles = (directory: string, listFile: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return SKIPPED_DIRECTORIES.includes(entry.name)
        ? []
        : sourceFiles(path, listFile);
    return /\.tsx?$/.test(entry.name) &&
      !SKIPPED_FILE.test(entry.name) &&
      entry.name !== listFile
      ? [path]
      : [];
  });

/** The key of one text of one file in the counts of a scan. */
export const statusTextKey = (file: string, text: string): string =>
  `${file}\u0000${text}`;

// The file and the text of a key. A file path has no NUL, so the first NUL is the separator.
const keyParts = (id: string): { file: string; text: string } => {
  const at = id.indexOf("\u0000");
  return { file: id.slice(0, at), text: id.slice(at + 1) };
};

/**
 * Counts each vague text of each source file under `root`. `listFile` is the file name of the
 * allow list: it quotes the texts, so it is not scanned.
 */
export const scanStatusTexts = (
  root: string,
  listFile: string
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const path of sourceFiles(root, listFile)) {
    const file = relative(root, path).replaceAll("\\", "/");
    for (const text of vagueTexts(readFileSync(path, "utf8"), file)) {
      const id = statusTextKey(file, text);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
};

/** The two ways the list and the source can disagree. Both must be empty. */
export const compareWithList = (
  counts: ReadonlyMap<string, number>,
  entries: readonly StatusLanguageEntry[]
): { added: string[]; stale: string[] } => {
  const allowed = new Map(
    entries.map((entry) => [statusTextKey(entry.file, entry.text), entry.count])
  );
  const describeKey = (id: string): string => {
    const { file, text } = keyParts(id);
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

/** The entries that have no usable reason, as `file: "text"`. Must be empty. */
export const entriesWithoutReason = (
  entries: readonly StatusLanguageEntry[]
): string[] =>
  entries
    .filter(
      (entry) =>
        entry.reason.trim().length < 12 ||
        entry.reason === MISSING_REASON ||
        entry.count < 1
    )
    .map((entry) => `${entry.file}: ${JSON.stringify(entry.text)}`);

/**
 * Writes the list file again from a scan. Existing reasons are kept; a new text, or a higher count
 * of a listed text, gets MISSING_REASON. The header of the file (comment, imports and the
 * declaration up to `readonly StatusLanguageEntry[] = `) stays; the array is replaced.
 */
export const regenerateList = (
  counts: ReadonlyMap<string, number>,
  entries: readonly StatusLanguageEntry[],
  listPath: string
): void => {
  const known = new Map(
    entries.map(
      (entry) => [statusTextKey(entry.file, entry.text), entry] as const
    )
  );
  const next = [...counts]
    .map(([id, count]) => {
      const old = known.get(id);
      // A higher count is a new occurrence: its reason is not inherited.
      const inherited = old !== undefined && count <= old.count;
      return {
        ...keyParts(id),
        count,
        reason: inherited ? old.reason : MISSING_REASON,
        ...(inherited && old.open === true ? { open: true } : {}),
      };
    })
    // A fixed locale: the order of the list does not depend on the machine.
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file, "en") || a.text.localeCompare(b.text, "en")
    );
  const marker = "readonly StatusLanguageEntry[] = ";
  const current = readFileSync(listPath, "utf8");
  const header = current.slice(0, current.indexOf(marker) + marker.length);
  writeFileSync(listPath, `${header}${JSON.stringify(next, null, 2)};\n`);
};

/**
 * The check both guards run: scans `root`, writes the list again first when `update` is set (the
 * guards pass UPDATE_STATUS_LANGUAGE=1), and reports every way the list and the source disagree.
 * `open` is the number of known ambiguous entries; a guard pins it so that it only goes down.
 */
export const checkStatusLanguage = (
  root: string,
  listFile: string,
  entries: readonly StatusLanguageEntry[],
  update: boolean
): {
  added: string[];
  stale: string[];
  withoutReason: string[];
  open: number;
} => {
  const counts = scanStatusTexts(root, listFile);
  if (update) regenerateList(counts, entries, join(root, listFile));
  return {
    ...compareWithList(counts, entries),
    open: entries.filter((entry) => entry.open === true).length,
    withoutReason: entriesWithoutReason(entries),
  };
};
