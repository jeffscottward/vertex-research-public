import { describe, expect, it } from "vitest";

import {
  countSources,
  describeSpans,
  MERGED_SOURCE,
  manifestSourceCounts,
  sourceSpans,
} from "./fetch-sources.ts";

const merged = {
  errors: {},
  rows: {
    ibkr: { first: "2001-01-02", last: "2026-11-06", rows: 6500 },
    yahoo: { first: "1993-01-29", last: "2000-12-29", rows: 2000 },
  },
};

describe("fetch source labels", () => {
  it("reads the per-source spans of a merge summary", () => {
    expect(describeSpans(sourceSpans(merged))).toBe(
      "ibkr 2001-01-02..2026-11-06, yahoo 1993-01-29..2000-12-29"
    );
  });

  it("falls back for absent, malformed or empty records", () => {
    for (const summary of [
      undefined,
      null,
      "x",
      { rows: {} },
      { rows: { a: 1 } },
    ]) {
      expect(sourceSpans(summary)).toBeUndefined();
    }
    expect(describeSpans(undefined)).toBe(MERGED_SOURCE);
    expect(describeSpans(undefined, "Yahoo")).toBe("Yahoo");
  });

  it("counts files per source", () => {
    const yahooOnly = { rows: { yahoo: { first: "a", last: "b" } } };
    expect(countSources([merged, yahooOnly, undefined])).toBe(
      "ibkr 1 file, yahoo 2 files"
    );
    expect(countSources([undefined])).toBeUndefined();
  });

  it("counts the sources of a fetch manifest", () => {
    const manifest = JSON.stringify({
      files: {
        "daily/SPY.csv": { rows: 3, sources: merged },
        "hourly/SPY.csv": { rows: 2 },
      },
    });
    expect(manifestSourceCounts(manifest)).toBe("ibkr 1 file, yahoo 1 file");
    expect(manifestSourceCounts("{}")).toBeUndefined();
    expect(manifestSourceCounts("not json")).toBeUndefined();
  });
});
