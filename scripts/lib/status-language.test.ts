import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  checkStatusLanguage,
  compareWithList,
  entriesWithoutReason,
  MISSING_REASON,
  regenerateList,
  type StatusLanguageEntry,
  scanStatusTexts,
  statusTextKey,
  vagueTexts,
} from "./status-language.ts";

const LIST_FILE = "status-language-allowlist.ts";
const LIST_HEADER = [
  "// The header of the list stays.",
  'import type { StatusLanguageEntry } from "./status-language.ts";',
  "",
  "export const STATUS_LANGUAGE_ALLOWLIST: readonly StatusLanguageEntry[] = ",
].join("\n");

const entry = (
  file: string,
  text: string,
  count: number,
  more: Partial<StatusLanguageEntry> = {}
): StatusLanguageEntry => ({
  count,
  file,
  reason: "a reason for the test",
  text,
  ...more,
});

const roots: string[] = [];

// A source folder in a temporary directory, with the list file of a guard.
const sourceFolder = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), "status-language-"));
  roots.push(root);
  for (const [file, source] of Object.entries({
    [LIST_FILE]: `${LIST_HEADER}[];\n`,
    ...files,
  })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return root;
};

// The array of the list file after a regeneration.
const writtenList = (root: string): unknown => {
  const written = readFileSync(join(root, LIST_FILE), "utf8");
  expect(written.startsWith(LIST_HEADER)).toBe(true);
  return JSON.parse(written.slice(LIST_HEADER.length).replace(/;\n$/, ""));
};

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

describe("status language scanner", () => {
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
      "    <td>&#x2014;</td>",
      "    <td>&ndash;</td>",
      "    <td>&hellip;</td>",
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
        "—",
        "–",
        "…",
        "Tip unavailable",
        "…",
        "…",
      ].sort()
    );
  });

  it("reads the values of an enum and of a wire field", () => {
    const source = [
      'export const STATES = ["live", "unknown"] as const;',
      'export const read = () => ({ status: "unavailable", reason: "no_bars" });',
    ].join("\n");
    expect(vagueTexts(source, "contract.ts")).toEqual([
      "unknown",
      "unavailable",
    ]);
  });

  it("reads a vague word that is one part of a wire value, in every spelling", () => {
    const values = [
      "source_unavailable",
      "outcome-unknown",
      "SERVICE_UNAVAILABLE",
      "not_available",
      "not-set",
      "result_not_known",
      "orpc.STORAGE.N/A",
    ];
    const named = ["not_classified", "unknownCount", "tbdList", "unsettled"];
    expect(
      vagueTexts(
        `export const VALUES = ${JSON.stringify([...values, ...named])};`,
        "wire.ts"
      )
    ).toEqual(values);
  });

  it("reads the raw text of a template part that has no cooked text", () => {
    // An invalid escape in a tagged template: the parser gives no cooked text.
    expect(
      vagueTexts("export const text = String.raw`\\unknown state`;", "raw.ts")
    ).toEqual(["\\unknown state"]);
  });

  it("does not read types, comparisons, case labels, string-method arguments, data attributes, module paths or comments", () => {
    const source = [
      'import type { A } from "./unknown-module.ts";',
      'export { b } from "./unavailable.ts";',
      'const lazy = () => import("./unknown-lazy.ts");',
      'const old = require("./unknown-old.cjs");',
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

  it("counts the texts of the source files of a folder, without tests, test support, fixtures, built or generated code and the list", () => {
    const vague = 'export const text = "Feed unavailable";\n';
    const root = sourceFolder({
      "contracts/flow.ts":
        'export const SIDES = ["bid", "unknown"] as const;\nexport const NOTE = "unknown";\n',
      "dist/out.ts": vague,
      "fixtures/sample.ts": vague,
      "generated/client.ts": vague,
      "lab/page.tsx": vague,
      "node_modules/pkg/index.ts": vague,
      "notes.md": "Feed unavailable",
      "server/flow.test.ts": vague,
      "server/flow.test-support.ts": vague,
      "server/flow.ts": vague,
      "server/flow-fixture.ts": vague,
      "server/types.d.ts": vague,
      "test/helper.ts": vague,
      "view.spec.tsx": vague,
      [LIST_FILE]: `${LIST_HEADER}[{ text: "Feed unavailable" }];\n`,
    });
    expect([...scanStatusTexts(root, LIST_FILE)].sort()).toEqual([
      [statusTextKey("contracts/flow.ts", "unknown"), 2],
      [statusTextKey("server/flow.ts", "Feed unavailable"), 1],
    ]);
  });

  it("compares the source with the list: new text, raised count, stale entry", () => {
    const found = new Map([
      [statusTextKey("a.tsx", "Unknown"), 2],
      [statusTextKey("a.tsx", "—"), 1],
      [statusTextKey("b.tsx", "N/A"), 1],
    ]);
    expect(
      compareWithList(found, [
        entry("a.tsx", "Unknown", 2),
        entry("a.tsx", "—", 1),
        entry("b.tsx", "N/A", 1),
      ])
    ).toEqual({ added: [], stale: [] });
    expect(
      compareWithList(found, [
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

  it("names every entry without a usable reason", () => {
    expect(
      entriesWithoutReason([
        entry("a.tsx", "Unknown", 1),
        entry("b.tsx", "N/A", 1, { reason: "too short" }),
        entry("c.tsx", "—", 1, { reason: MISSING_REASON }),
        entry("d.tsx", "?", 0),
      ])
    ).toEqual(['b.tsx: "N/A"', 'c.tsx: "—"', 'd.tsx: "?"']);
  });

  it("writes the list again: keeps the header and known reasons, asks a reason for a new or raised text", () => {
    const root = sourceFolder({});
    regenerateList(
      new Map([
        [statusTextKey("c.ts", "—"), 1],
        [statusTextKey("b.ts", "unknown"), 1],
        [statusTextKey("a.ts", "Unknown"), 3],
        [statusTextKey("a.ts", "N/A"), 1],
      ]),
      [
        entry("a.ts", "N/A", 2, { open: true }),
        entry("a.ts", "Unknown", 2, { open: true }),
        entry("c.ts", "—", 1),
        entry("gone.ts", "unknown", 1),
      ],
      join(root, LIST_FILE)
    );
    // The keys of an entry are written in the order of the list files.
    expect(readFileSync(join(root, LIST_FILE), "utf8")).toContain(
      [
        "  {",
        '    "file": "a.ts",',
        '    "text": "N/A",',
        '    "count": 1,',
        '    "reason": "a reason for the test",',
        '    "open": true',
        "  },",
      ].join("\n")
    );
    // Sorted by file, then text. An entry of a text that is gone is not written.
    expect(writtenList(root)).toEqual([
      // A lower count keeps the reason and the open mark.
      {
        count: 1,
        file: "a.ts",
        open: true,
        reason: "a reason for the test",
        text: "N/A",
      },
      // A higher count is a new occurrence: no inherited reason, no open mark.
      { count: 3, file: "a.ts", reason: MISSING_REASON, text: "Unknown" },
      { count: 1, file: "b.ts", reason: MISSING_REASON, text: "unknown" },
      { count: 1, file: "c.ts", reason: "a reason for the test", text: "—" },
    ]);
  });

  it("runs the check of a guard, and writes the list first when asked", () => {
    const root = sourceFolder({
      "server/feed.ts": 'export const text = "Feed unavailable";\n',
    });
    const listed = [
      entry("server/feed.ts", "Feed unavailable", 1, { open: true }),
      entry("server/gone.ts", "N/A", 1, { reason: "short" }),
    ];
    expect(checkStatusLanguage(root, LIST_FILE, [], false)).toEqual({
      added: ['server/feed.ts: "Feed unavailable" (found 1, allowed 0)'],
      open: 0,
      stale: [],
      withoutReason: [],
    });
    expect(writtenList(root)).toEqual([]);
    expect(checkStatusLanguage(root, LIST_FILE, listed, true)).toEqual({
      added: [],
      open: 1,
      stale: ['server/gone.ts: "N/A" (listed 1, found 0)'],
      withoutReason: ['server/gone.ts: "N/A"'],
    });
    expect(writtenList(root)).toEqual([
      {
        count: 1,
        file: "server/feed.ts",
        open: true,
        reason: "a reason for the test",
        text: "Feed unavailable",
      },
    ]);
  });
});
