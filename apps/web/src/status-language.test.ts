import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS_LANGUAGE_ALLOWLIST } from "./status-language-allowlist.ts";

// Status language guard (owner rule 2026-11-11, card vertex-no-unknown-status).
//
// Every status the app shows is a definite state with its reason, since when, and what happens
// next. A vague placeholder is not a status: "unknown", "N/A", "unavailable", "not available", a
// bare dash, "?" or "…".
//
// This test reads every string literal and JSX text in apps/web/src (tests, fixtures and lab pages
// excluded). A vague text must have an entry in status-language-allowlist.ts with a reason.
// - New text: do not add an entry by reflex. Name the state: the cause, since when, the last known
//   value, the next step ("Gateway disconnected since 01:13 ET · retrying"). Real uncertainty
//   stays visible, but it is named ("Order outcome not confirmed by IBKR since 14:02 · checking").
// - Entry with `"open": true`: a known ambiguous text from the audit. It leaves the list when its
//   replacement merges; the test fails on a stale entry, so the list only shrinks.
// - Entry without `open`: checked and kept; the reason says why (a separator between two real
//   values, a state value that is never displayed, an error text that names its cause).
//
// Regenerate after a deliberate change: UPDATE_STATUS_LANGUAGE=1 pnpm exec vitest run ... this
// file. It keeps the reasons of existing entries and marks new ones "REASON REQUIRED": write it.

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
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*).*$/gm;
// A complete string literal, template literal, or JSX text between two tags.
const LITERAL =
  /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|>([^<>{}\n]+)</g;
const VAGUE_WORD =
  /\b(unknown|n\/a|unavailable|not available|undetermined|tbd)\b/i;
const VAGUE_MARK = /^\s*(—|–|-|\?|…|\.\.\.)\s*$/;
const MISSING_REASON = "REASON REQUIRED";

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

const vagueTexts = (source: string): string[] => {
  const found: string[] = [];
  for (const match of source.replace(COMMENT_LINE, "").matchAll(LITERAL)) {
    const raw = match[1] ?? match[0].slice(1, -1);
    if (VAGUE_MARK.test(raw) || VAGUE_WORD.test(raw)) found.push(raw.trim());
  }
  return found;
};

const key = (file: string, text: string): string => `${file}\u0000${text}`;

const scan = (): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const path of sourceFiles(ROOT)) {
    const file = relative(ROOT, path).replaceAll("\\", "/");
    for (const text of vagueTexts(readFileSync(path, "utf8"))) {
      const id = key(file, text);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
};

const entries = STATUS_LANGUAGE_ALLOWLIST;

const regenerate = (counts: Map<string, number>): void => {
  const known = new Map(
    entries.map((entry) => [key(entry.file, entry.text), entry] as const)
  );
  const next = [...counts]
    .map(([id, count]) => {
      const [file = "", text = ""] = id.split("\u0000");
      const old = known.get(id);
      return {
        file,
        text,
        count,
        reason: old?.reason ?? MISSING_REASON,
        ...(old?.open === true ? { open: true } : {}),
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

  it("finds vague texts in string literals, template literals and JSX text", () => {
    expect(
      vagueTexts(
        [
          'const a = "Account mode unknown";',
          "const b = 'N/A';",
          "const c = `Feed unavailable (${code})`;",
          "<td>—</td>",
          "<p>Not available</p>",
          "// a comment with unknown is ignored",
          'const fine = "Gateway disconnected since 01:13 ET · retrying";',
          'const separator = "Live account · read-only";',
        ].join("\n")
      )
    ).toEqual([
      "Account mode unknown",
      "N/A",
      "Feed unavailable (${code})",
      "—",
      "Not available",
    ]);
  });

  it("has a reason for every allowed text", () => {
    const withoutReason = entries
      .filter(
        (entry) =>
          entry.reason.trim().length < 12 || entry.reason === MISSING_REASON
      )
      .map((entry) => `${entry.file}: ${JSON.stringify(entry.text)}`);
    expect(withoutReason).toEqual([]);
  });

  it("allows no new vague status text without an entry and a reason", () => {
    const allowed = new Map(
      entries.map((entry) => [key(entry.file, entry.text), entry.count])
    );
    const added = [...counts]
      .filter(([id, count]) => count > (allowed.get(id) ?? 0))
      .map(([id, count]) => {
        const [file, text] = id.split("\u0000");
        return `${file}: ${JSON.stringify(text)} (${count}, allowed ${allowed.get(id) ?? 0})`;
      });
    // A failure here means: name the state (cause, since when, next step) instead of the vague
    // word, or add an entry with its reason to status-language-allowlist.ts.
    expect(added).toEqual([]);
  });

  it("has no stale entry: a replaced text leaves the list", () => {
    const stale = entries
      .filter(
        (entry) => (counts.get(key(entry.file, entry.text)) ?? 0) < entry.count
      )
      .map(
        (entry) =>
          `${entry.file}: ${JSON.stringify(entry.text)} (listed ${entry.count}, found ${counts.get(key(entry.file, entry.text)) ?? 0})`
      );
    expect(stale).toEqual([]);
  });
});
