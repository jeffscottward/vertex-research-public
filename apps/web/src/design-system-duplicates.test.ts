import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Audit phase 3 ("one design system"): a vx-* class that duplicates a
// @darkfactory/ui primitive is removed and must not come back. Add a class
// here when its last use moves to the shared primitive.
const RETIRED_CLASSES = [
  "vx-button",
  "vx-button-secondary",
  "vx-read-notice",
  "vx-read-failure",
  "vx-notice-title",
  "vx-caption",
  "vx-ex-table",
  "vx-ex-table-wrap",
  "vx-ex-table-scroll",
  "vx-ex-numeric",
  "vx-ex-catalog",
  "vx-ex-check",
  "vx-ex-inbox",
  "vx-ex-inbox-item",
  "vx-ex-prose",
  "vx-ex-rows",
  "vx-ex-rule-list",
  "vx-chart-annotations",
  "vx-chart-axis",
  "vx-chart-axis-label",
  "vx-chart-comparison",
  "vx-chart-controls",
  "vx-chart-exact",
  "vx-chart-facts",
  "vx-chart-figure",
  "vx-chart-flow",
  "vx-chart-grid",
  "vx-chart-indicator",
  "vx-chart-legend",
  "vx-chart-page-actions",
  "vx-chart-pagination",
  "vx-chart-profile",
  "vx-chart-record-source",
  "vx-chart-renderer-host",
  "vx-chart-segment",
  "vx-chart-segment-buy",
  "vx-chart-segment-sell",
  "vx-chart-segment-unknown",
  "vx-chart-source",
  "vx-chart-status",
  "vx-chart-svg",
  "vx-chart-swatch",
  "vx-chart-swatch-buy",
  "vx-chart-swatch-sell",
  "vx-chart-swatch-unknown",
  "vx-chart-table",
  "vx-chart-table-block",
  "vx-chart-table-scroll",
  "vx-chart-workbench",
  "vx-ex-stack",
  "vx-ex-lead",
  "vx-ex-scope-label",
  "vx-ex-status",
  "vx-chart-note",
  "vx-ex-collection",
  "vx-ex-record-list",
  "vx-ex-split",
  "vx-ex-form",
  "vx-ex-choice",
  "vx-ex-toolbar",
  "vx-ex-filters",
  "vx-ex-pagination",
  "vx-ex-facts",
  "vx-ex-scope",
  "vx-chart-panel",
  "vx-chart-canvas",
  "vx-chart-tanstack",
] as const;
const SOURCE_ROOT = join(import.meta.dirname);

const webSources = (): { file: string; source: string }[] =>
  readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(?:tsx?|css)$/u.test(entry.name) &&
        !entry.name.includes(".test.")
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .map((file) => ({ file, source: readFileSync(file, "utf8") }));

describe("design-system duplicates", () => {
  it("uses the shared Button instead of the retired vx-button classes", () => {
    const pattern = new RegExp(
      `\\b(?:${RETIRED_CLASSES.join("|")})(?![\\w-])`,
      "u"
    );
    const offenders = webSources()
      .filter(({ source }) => pattern.test(source))
      .map(({ file }) => relative(SOURCE_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("aligns TableRow cells through child selectors, because cells set align-middle", () => {
    const pattern = /<TableRow\s[^>]*className="[^"]*(?<![:\w-])align-top/u;
    const offenders = webSources()
      .filter(({ source }) => pattern.test(source))
      .map(({ file }) => relative(SOURCE_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("lets body row and row-group headers size and wrap like cells, because TableHead sets h-10 and nowrap", () => {
    // Matches one level of nested braces in attributes; a deeper block holding ">" cuts the tag short.
    const tableHead = /<TableHead\b(?:[^>{]|\{[^}]*\})*>/gu;
    const rowScope = /\bscope=(?:"|'|\{["'])row(?:group)?["']\}?/u;
    const autoHeight = /(?<![\w:-])h-auto(?![\w-])/u;
    const wraps = /(?<![\w:-])whitespace-normal(?![\w-])/u;
    const offenders = webSources().flatMap(({ file, source }) =>
      [...source.matchAll(tableHead)]
        .filter(
          ([tag]) =>
            rowScope.test(tag) && !(autoHeight.test(tag) && wraps.test(tag))
        )
        .map(
          ({ index }) =>
            `${relative(SOURCE_ROOT, file)}:${source.slice(0, index).split("\n").length}`
        )
    );
    expect(offenders).toEqual([]);
  });
});
